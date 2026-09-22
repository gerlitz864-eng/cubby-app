import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { h, need, HttpError, pinProof, sha256 } from '../lib/ctx.js';

// Users, roles, PINs, kiosk devices, face verification consent, and settings. Owner and director only.
export default function register(r, ctx) {
  const { asUser, asSystem, config, face } = ctx;
  const ROLES = ['owner', 'director', 'front_office', 'billing', 'cook', 'teacher', 'parent'];

  r.get('/admin/users', need('users.manage'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT u.id, u.email, u.role, u.is_active, u.last_login_at, s.first_name || ' ' || s.last_name AS staff_name FROM users u LEFT JOIN staff s ON s.id = u.staff_id ORDER BY u.role, u.email`))));

  r.post('/admin/users', need('users.manage'), h(async (req) => {
    const { email, role, password, staffId, guardianId } = req.body || {};
    if (!email || !ROLES.includes(role) || (role !== 'parent' && String(password || '').length < 8)) throw new HttpError(400, 'An email, a role, and a password of at least 8 characters are required');
    const hash = password ? await bcrypt.hash(password, 10) : null;
    return asSystem(async (q) => (await q(`INSERT INTO users (center_id, email, role, staff_id, guardian_id, password_hash) VALUES ($1,$2,$3::user_role,$4,$5,$6) RETURNING id`,
      [req.user.centerId, email, role, staffId || null, guardianId || null, hash]))[0]);
  }));

  r.patch('/admin/users/:id', need('users.manage'), h(async (req) => asSystem(async (q) => {
    const { isActive, role, password } = req.body || {};
    if (req.params.id === req.user.id && isActive === false) throw new HttpError(400, 'You cannot deactivate your own account');
    if (isActive !== undefined) await q('UPDATE users SET is_active = $2 WHERE id = $1 AND center_id = $3', [req.params.id, !!isActive, req.user.centerId]);
    if (role && ROLES.includes(role)) await q('UPDATE users SET role = $2::user_role WHERE id = $1 AND center_id = $3', [req.params.id, role, req.user.centerId]);
    if (password) { if (password.length < 8) throw new HttpError(400, 'Use at least 8 characters'); await q('UPDATE users SET password_hash = $2 WHERE id = $1 AND center_id = $3', [req.params.id, await bcrypt.hash(password, 10), req.user.centerId]); }
    return { ok: true };
  })));

  // ---------- permission matrix ----------
  r.get('/admin/permissions', need('users.manage'), h(async (req) => asUser(req.user, async (q) => ({
    permissions: await q('SELECT code, area, description FROM permissions ORDER BY area, code'),
    grants: await q('SELECT role, permission_code, scope FROM role_permissions WHERE center_id = $1', [req.user.centerId]),
    roles: ROLES
  }))));

  r.put('/admin/permissions', need('users.manage'), h(async (req) => {
    const { role, code, scope } = req.body || {};
    if (!ROLES.includes(role)) throw new HttpError(400, 'Unknown role');
    if (role === 'owner') throw new HttpError(400, 'The owner keeps every permission');
    return asUser(req.user, async (q) => {
      if (!scope) await q('DELETE FROM role_permissions WHERE center_id = $1 AND role = $2::user_role AND permission_code = $3', [req.user.centerId, role, code]);
      else await q(`INSERT INTO role_permissions (center_id, role, permission_code, scope) VALUES ($1,$2::user_role,$3,$4::permission_scope) ON CONFLICT (center_id, role, permission_code) DO UPDATE SET scope = EXCLUDED.scope`,
        [req.user.centerId, role, code, scope]);
      return { ok: true };
    });
  }));

  // ---------- PINs for parents and pick-up people ----------
  r.get('/admin/pins', need('users.manage', 'attendance.checkout'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT g.id AS guardian_id, g.first_name || ' ' || g.last_name AS person, 'guardian' AS kind, g.phone_mobile AS phone,
            (SELECT json_agg(json_build_object('purpose', f.purpose, 'id', f.id, 'locked', f.locked_until > now(), 'failed', f.failed_attempts, 'lastUsed', f.last_used_at)) FROM family_access_credentials f WHERE f.guardian_id = g.id AND f.is_active) AS pins
       FROM guardians g ORDER BY g.last_name, g.first_name`))));

  r.post('/admin/pins', need('users.manage'), h(async (req) => {
    const { guardianId, contactId, purpose, pin } = req.body || {};
    if (!['kiosk', 'portal'].includes(purpose)) throw new HttpError(400, 'Choose kiosk or portal');
    if (!/^\d{6}$/.test(String(pin || ''))) throw new HttpError(400, 'A PIN is 6 digits');
    if (/^(\d)\1{5}$/.test(pin) || '0123456789012345'.includes(pin) || '9876543210987654'.includes(pin)) throw new HttpError(400, 'Choose a PIN that is not a repeat or a simple sequence');
    return asUser(req.user, async (q) => ({ id: (await q('SELECT set_family_pin($1,$2,$3,$4,$5,$6) AS id', [req.user.centerId, guardianId || null, contactId || null, purpose, pinProof(pin, config.pinPepper), req.user.id]))[0].id }));
  }));

  r.post('/admin/pins/:id/unlock', need('users.manage', 'attendance.checkout'), h(async (req) => asUser(req.user, async (q) => { await q('SELECT unlock_family_pin($1,$2)', [req.params.id, req.user.id]); return { ok: true }; })));

  // ---------- staff: face verification consent and enrollment ----------
  r.get('/admin/staff', need('staff.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT s.id, s.first_name, s.last_name, s.job_title, s.overtime_eligible, s.terminated_on,
            (SELECT c.status FROM biometric_consents c WHERE c.staff_id = s.id ORDER BY c.recorded_at DESC LIMIT 1) AS consent,
            EXISTS (SELECT 1 FROM staff_biometric_templates t WHERE t.staff_id = s.id AND t.deleted_at IS NULL) AS has_template,
            EXISTS (SELECT 1 FROM staff_punch_credentials p WHERE p.staff_id = s.id AND p.is_active AND p.kind = 'pin') AS has_pin
       FROM staff s ORDER BY s.last_name`))));

  r.post('/admin/staff/:id/pin', need('users.manage'), h(async (req) => {
    if (!/^\d{4,8}$/.test(String(req.body?.pin || ''))) throw new HttpError(400, 'A PIN is 4 to 8 digits');
    const hash = await bcrypt.hash(pinProof(req.body.pin, config.pinPepper), 10);
    return asSystem(async (q) => {
      await q(`UPDATE staff_punch_credentials SET is_active = false, rotated_at = now() WHERE staff_id = $1 AND kind = 'pin' AND is_active`, [req.params.id]);
      await q(`INSERT INTO staff_punch_credentials (staff_id, kind, credential_hash) VALUES ($1,'pin',$2)`, [req.params.id, hash]);
      return { ok: true };
    });
  }));

  // Consent comes first. A face template cannot be created without it (the database enforces this).
  r.post('/admin/staff/:id/biometric/consent', need('users.manage'), h(async (req) => {
    const status = req.body?.status === 'withdrawn' ? 'withdrawn' : 'granted';
    return asUser(req.user, async (q) => {
      let pv = (await q('SELECT id FROM biometric_policy_versions WHERE center_id = $1 ORDER BY version DESC LIMIT 1', [req.user.centerId]))[0];
      if (!pv) pv = (await q(`INSERT INTO biometric_policy_versions (center_id, version, effective_on, summary) VALUES ($1,1,current_date,'Face verification is optional. A PIN is always available.') RETURNING id`, [req.user.centerId]))[0];
      await q(`INSERT INTO biometric_consents (staff_id, policy_version_id, status, method, recorded_by, note) VALUES ($1,$2,$3::consent_status,$4,$5,$6)`,
        [req.params.id, pv.id, status, req.body?.method || 'signed_form', req.user.id, req.body?.note || null]);
      return { ok: true, status };
    });
  }));

  r.post('/admin/staff/:id/biometric/enroll', need('users.manage'), h(async (req) => {
    const consent = (await asSystem((q) => q(`SELECT id, status FROM biometric_consents WHERE staff_id = $1 ORDER BY recorded_at DESC LIMIT 1`, [req.params.id])))[0];
    if (!consent || consent.status !== 'granted') throw new HttpError(400, 'Record the staff member\'s written consent first.');
    const t = await face.enroll({ staffId: req.params.id, imageBase64: req.body?.imageBase64 });
    // Template records are written by the server only. No database role for people can read or write them.
    return asSystem(async (q) => {
      await q(`UPDATE staff_biometric_templates SET deleted_at = now(), deletion_reason = 're-enrolled' WHERE staff_id = $1 AND deleted_at IS NULL`, [req.params.id]);
      await q(`INSERT INTO staff_biometric_templates (staff_id, consent_id, vendor, template_ref, algorithm_version, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, consent.id, t.vendor, t.templateRef, t.algorithmVersion, req.user.id]);
      return { ok: true, provider: face.name };
    });
  }));

  // ---------- kiosk devices ----------
  r.get('/admin/devices', need('users.manage'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT d.id, d.name, d.location_note, d.is_active, d.last_seen_at, c.name AS classroom FROM time_devices d LEFT JOIN classrooms c ON c.id = d.classroom_id ORDER BY d.name`))));

  // The token is shown once. Only its hash is stored.
  r.post('/admin/devices', need('users.manage'), h(async (req) => {
    if (!req.body?.name) throw new HttpError(400, 'Name the device');
    const token = crypto.randomBytes(24).toString('hex');
    return asSystem(async (q) => ({
      id: (await q(`INSERT INTO time_devices (center_id, name, location_note, classroom_id, token_hash, registered_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.user.centerId, req.body.name, req.body.locationNote || null, req.body.classroomId || null, sha256(token), req.user.id]))[0].id, token
    }));
  }));

  // ---------- settings ----------
  const SETTINGS = {
    punctuality_policies: ['child_grace_minutes', 'staff_grace_minutes', 'staff_late_alert_after_minutes'],
    time_policies: ['overtime_after_seconds', 'breaks_are_unpaid', 'rounding_seconds', 'max_face_attempts', 'store_failure_images', 'week_starts_on'],
    access_policies: ['pin_length', 'max_failed_attempts', 'lockout_minutes'],
    alert_policies: ['grace_minutes'],
    centers: ['program_start_time', 'closing_time', 'late_fee_cents', 'offer_hold_days', 'licensed_capacity']
  };
  r.get('/admin/settings', need('settings.manage'), h(async (req) => asUser(req.user, async (q) => {
    const out = {};
    for (const [table, cols] of Object.entries(SETTINGS)) {
      const key = table === 'centers' ? 'id' : table === 'alert_policies' ? 'center_id' : 'center_id';
      const row = (await q(`SELECT ${cols.join(',')} FROM ${table} WHERE ${key} = $1 LIMIT 1`, [req.user.centerId]))[0];
      out[table] = row || {};
    }
    return out;
  })));
  r.put('/admin/settings', need('settings.manage'), h(async (req) => {
    const { table, values } = req.body || {};
    const cols = SETTINGS[table];
    if (!cols) throw new HttpError(400, 'Unknown setting group');
    const keys = Object.keys(values || {}).filter((k) => cols.includes(k));
    if (!keys.length) throw new HttpError(400, 'Nothing to change');
    const key = table === 'centers' ? 'id' : 'center_id';
    return asUser(req.user, async (q) => {
      await q(`UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE ${key} = $1`, [req.user.centerId, ...keys.map((k) => values[k])]);
      return { ok: true };
    });
  }));

  r.get('/admin/audit', need('audit.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT a.occurred_at, a.action, a.table_name, a.reason, u.email AS by FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.occurred_at DESC LIMIT 100`))));

  // Who is allowed in, for the sign-in screens.
  r.get('/admin/meta', need('users.manage', 'attendance.record', 'enrollment.view', 'orders.request', 'meals.view', 'supplies.flag', 'time.punch'), h(async (req) => asSystem(async (q) => ({
    classrooms: await q('SELECT id, name, color_hex, ratio_children_per_staff AS ratio FROM classrooms WHERE center_id = $1 AND is_active ORDER BY name', [req.user.centerId]),
    staff: req.user.perms.has('users.manage') || req.user.perms.has('time.view_all') ? await q('SELECT id, first_name, last_name FROM staff WHERE center_id = $1 AND terminated_on IS NULL ORDER BY first_name', [req.user.centerId]) : []
  }))));
}
