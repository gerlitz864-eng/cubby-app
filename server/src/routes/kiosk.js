import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { h, HttpError, pinProof, sha256 } from '../lib/ctx.js';
import { centerInfo, notifyRoles } from '../lib/notifications.js';
import { afterArrival, afterDeparture } from './attendance.js';

// Kiosk tablets sign in with a device token, not a person's login.
// They can (1) punch staff in and out, and (2) let parents and pick-up people sign children in and out with a PIN.
export default function register(r, ctx) {
  const { asSystem, asKiosk, config, face } = ctx;
  const staffLock = new Map(); // staffId -> { fails, until }

  const device = async (req, _res, next) => {
    try {
      const token = req.headers['x-device-token'];
      if (!token) throw new HttpError(401, 'This device is not registered');
      const d = (await asSystem((q) => q('SELECT id, center_id, classroom_id, name FROM time_devices WHERE token_hash = $1 AND is_active', [sha256(token)])))[0];
      if (!d) throw new HttpError(401, 'This device is not registered');
      await asSystem((q) => q('UPDATE time_devices SET last_seen_at = now() WHERE id = $1', [d.id]));
      req.device = { id: d.id, centerId: d.center_id, classroomId: d.classroom_id, name: d.name };
      next();
    } catch (e) { next(e); }
  };

  r.get('/kiosk/info', device, h(async (req) => asSystem(async (q) => {
    const c = await centerInfo(q, req.device.centerId);
    const rooms = await q('SELECT id, name FROM classrooms WHERE center_id = $1 AND is_active ORDER BY name', [req.device.centerId]);
    return { device: req.device.name, center: c.name, timezone: c.timezone, faceProvider: face.name, deviceClassroomId: req.device.classroomId, classrooms: rooms };
  })));

  // Names to choose from. Nothing else about a person is shown.
  r.get('/kiosk/staff', device, h(async (req) => asSystem((q) => q(
    `SELECT s.id, s.first_name, s.last_name,
            EXISTS (SELECT 1 FROM staff_biometric_templates t WHERE t.staff_id = s.id AND t.deleted_at IS NULL AND t.deletion_requested_at IS NULL) AS face_enabled,
            (SELECT te.clock_in_at FROM time_entries te WHERE te.staff_id = s.id AND te.clock_out_at IS NULL) AS clocked_in_at,
            s.default_classroom_id
       FROM staff s WHERE s.center_id = $1 AND s.terminated_on IS NULL ORDER BY s.first_name`, [req.device.centerId]))));

  // A punch. Face is checked one-to-one against the person chosen. A failed or unconfirmed match is kept for review, never dropped.
  r.post('/kiosk/punch', device, h(async (req) => {
    const b = req.body || {};
    const types = ['clock_in', 'clock_out', 'break_start', 'break_end', 'room_change'];
    if (!types.includes(b.punchType)) throw new HttpError(400, 'Choose what you are doing');
    const st = (await asSystem((q) => q('SELECT id, first_name, default_classroom_id FROM staff WHERE id = $1 AND center_id = $2 AND terminated_on IS NULL', [b.staffId, req.device.centerId])))[0];
    if (!st) throw new HttpError(404, 'Staff member not found');

    let method, verification = null, score = null, liveness = null;
    if (b.method === 'face') {
      const tmpl = (await asSystem((q) => q(`SELECT template_ref FROM staff_biometric_templates WHERE staff_id = $1 AND deleted_at IS NULL AND deletion_requested_at IS NULL`, [st.id])))[0];
      if (!tmpl) throw new HttpError(400, 'Face verification is not set up for this person. Please use your PIN.');
      const v = await face.verify({ staffId: st.id, templateRef: tmpl.template_ref, imageBase64: b.imageBase64, demoResult: b.demoResult });
      method = 'face'; verification = v.result; score = v.score; liveness = v.liveness;
    } else if (b.method === 'pin') {
      const lock = staffLock.get(st.id);
      if (lock && lock.until > Date.now()) throw new HttpError(423, 'Too many wrong PINs. Please wait a few minutes or see the director.');
      const cred = (await asSystem((q) => q(`SELECT credential_hash FROM staff_punch_credentials WHERE staff_id = $1 AND kind = 'pin' AND is_active`, [st.id])))[0];
      const ok = cred && await bcrypt.compare(pinProof(b.pin || '', config.pinPepper), cred.credential_hash);
      if (!ok) {
        const f = (staffLock.get(st.id)?.fails || 0) + 1;
        staffLock.set(st.id, { fails: f, until: f >= 5 ? Date.now() + 5 * 60000 : 0 });
        throw new HttpError(401, f >= 5 ? 'Too many wrong PINs. Locked for 5 minutes.' : 'Incorrect PIN');
      }
      staffLock.delete(st.id);
      method = 'pin';
    } else throw new HttpError(400, 'Choose face or PIN');

    const classroom = b.punchType === 'clock_in' || b.punchType === 'room_change'
      ? (b.classroomId || req.device.classroomId || st.default_classroom_id || null) : null;
    if (b.punchType === 'room_change' && !classroom) throw new HttpError(400, 'Choose a room');

    const id = b.clientId && /^[0-9a-f-]{36}$/i.test(b.clientId) ? b.clientId : crypto.randomUUID();
    return asSystem(async (q) => {
      const dup = (await q('SELECT id FROM punch_events WHERE id = $1', [id]))[0];
      const row = dup ? (await q('SELECT * FROM punch_events WHERE id = $1', [id]))[0] : (await q(
        `INSERT INTO punch_events (id, center_id, staff_id, device_id, punch_type, device_reported_at, method, verification_result, match_score, liveness_passed, attempts, classroom_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [id, req.device.centerId, st.id, req.device.id, b.punchType, b.deviceReportedAt || null, method, verification, score, liveness, Number(b.attempts) || 1, classroom]))[0];
      if (row.status === 'pending_review')
        await notifyRoles(q, req.device.centerId, ['director'], 'punch_review', 'A punch needs review', `${st.first_name}'s punch was held: ${row.flag_reason}.`, { table: 'punch_events', id: row.id });
      const hours = (await q(
        `SELECT coalesce(sum(extract(epoch FROM coalesce(clock_out_at, now()) - clock_in_at)) FILTER (WHERE clock_in_at >= now() - interval '1 day'), 0)::int AS today_seconds,
                coalesce(sum(extract(epoch FROM coalesce(clock_out_at, now()) - clock_in_at)) FILTER (WHERE clock_in_at >= now() - interval '7 days'), 0)::int AS week_seconds
           FROM time_entries WHERE staff_id = $1`, [st.id]))[0];
      return { status: row.status, flag: row.flag_reason, punchType: row.punch_type, at: row.occurred_at, name: st.first_name, ...hours };
    });
  }));

  // Parents and pick-up people: find your family by phone number. Shows only your own children.
  r.post('/kiosk/family/lookup', device, h(async (req) => {
    const digits = String(req.body?.phone || '').replace(/\D/g, '');
    if (digits.length < 7) throw new HttpError(400, 'Enter your phone number');
    return asSystem(async (q) => {
      const c = await centerInfo(q, req.device.centerId);
      const person = (await q(
        `SELECT 'guardian' AS kind, g.id, g.first_name, f.id AS credential_id FROM guardians g
           JOIN family_access_credentials f ON f.guardian_id = g.id AND f.purpose = 'kiosk' AND f.is_active
          WHERE g.center_id = $1 AND regexp_replace(coalesce(g.phone_mobile, ''), '\\D', '', 'g') = $2
         UNION ALL
         SELECT 'contact', ct.id, ct.first_name, f.id FROM contacts ct
           JOIN family_access_credentials f ON f.contact_id = ct.id AND f.purpose = 'kiosk' AND f.is_active
          WHERE ct.center_id = $1 AND regexp_replace(coalesce(ct.phone, ''), '\\D', '', 'g') = $2 LIMIT 1`, [req.device.centerId, digits]))[0];
      if (!person) throw new HttpError(404, 'We could not find that number. Please see the front desk.');
      const kids = person.kind === 'guardian'
        ? await q(`SELECT ch.id, ch.first_name FROM child_guardians cg JOIN children ch ON ch.id = cg.child_id WHERE cg.guardian_id = $1 AND ch.status = 'active'`, [person.id])
        : await q(`SELECT ch.id, ch.first_name FROM child_contacts cc JOIN children ch ON ch.id = cc.child_id WHERE cc.contact_id = $1 AND cc.role = 'authorized_pickup' AND ch.status = 'active'`, [person.id]);
      const out = [];
      for (const k of kids) {
        const a = (await q('SELECT status, checked_in_at, checked_out_at FROM attendance_records WHERE child_id = $1 AND service_date = $2', [k.id, c.today]))[0];
        out.push({ ...k, state: !a ? 'not_in' : a.checked_out_at ? 'out' : a.checked_in_at ? 'in' : 'not_in' });
      }
      return { credentialId: person.credential_id, firstName: person.first_name, children: out };
    });
  }));

  // The PIN check and the sign-in or sign-out happen inside one database function. The kiosk can run nothing else.
  r.post('/kiosk/family/sign', device, h(async (req) => {
    const { credentialId, pin, childId, action } = req.body || {};
    const res = (await asKiosk((q) => q('SELECT * FROM kiosk_child_sign($1,$2,$3,$4,$5)', [req.device.id, credentialId, pinProof(pin || '', config.pinPepper), childId, action])))[0];
    if (!res?.result_ok) {
      const locked = res?.result_reason === 'locked';
      throw new HttpError(locked ? 423 : 403, locked ? 'This PIN is locked. Please see the front desk.' : 'Please see the front desk.');
    }
    const c = await asSystem((q) => centerInfo(q, req.device.centerId));
    if (action === 'check_in') {
      const rec = (await asSystem((q) => q('SELECT id, classroom_id FROM attendance_records WHERE child_id = $1 AND service_date = $2', [childId, c.today])))[0];
      await afterArrival(ctx, req.device.centerId, childId, c.today, rec?.id, null, rec?.classroom_id);
    } else await afterDeparture(ctx, req.device.centerId, childId);
    return { ok: true };
  }));
}
