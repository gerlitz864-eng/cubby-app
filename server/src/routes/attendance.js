import { h, need, HttpError } from '../lib/ctx.js';
import { centerInfo, notifyGuardian, notifyRoles, guardiansOf } from '../lib/notifications.js';

export default function register(r, ctx) {
  const { asUser, asSystem } = ctx;

  // Today's board. Office roles see every child on the roster; teachers see only their own room, through the teacher view.
  r.get('/attendance/today', need('attendance.view'), h(async (req) => {
    const scope = req.user.perms.get('attendance.view');
    const names = await asSystem((q) => q('SELECT id, name FROM classrooms WHERE center_id = $1', [req.user.centerId]));
    const rows = await asUser(req.user, async (q) => {
      if (scope === 'own_classroom') {
        return q('SELECT * FROM v_teacher_arrivals ORDER BY last_name, first_name');
      }
      const c = await centerInfo(q, req.user.centerId);
      return q(`
        SELECT r.child_id, r.first_name, r.last_name, r.classroom_id, cl.name AS classroom, cl.color_hex,
               ar.status AS attendance_status, ar.checked_in_at, ar.checked_out_at, ar.checked_in_method, ar.checked_out_method,
               ea.expected_arrival, dp.status AS arrival_status, dp.minutes_late,
               (SELECT count(*)::int FROM child_alerts ca WHERE ca.child_id = r.child_id AND ca.is_active) AS alerts,
               (SELECT string_agg(ca.name, ', ') FROM child_alerts ca WHERE ca.child_id = r.child_id AND ca.is_active) AS alert_names,
               (SELECT a.status FROM attendance_alerts a WHERE a.child_id = r.child_id AND a.service_date = $2 LIMIT 1) AS alert_status
          FROM roster_on($1, $2) r
          JOIN classrooms cl ON cl.id = r.classroom_id
          LEFT JOIN attendance_records ar ON ar.child_id = r.child_id AND ar.service_date = $2
          LEFT JOIN expected_attendance ea ON ea.child_id = r.child_id AND ea.service_date = $2
          LEFT JOIN daily_punctuality dp ON dp.child_id = r.child_id AND dp.service_date = $2
         ORDER BY cl.name, r.last_name, r.first_name`, [req.user.centerId, c.today]);
    });
    return rows.map((x) => ({ ...x, classroom: x.classroom || names.find((n) => n.id === x.classroom_id)?.name }));
  }));

  // Live ratios: children in the building against staff clocked in, room by room.
  r.get('/attendance/ratios', need('attendance.view'), h(async (req) => {
    if (req.user.perms.get('attendance.view') !== 'all') throw new HttpError(403, 'Not allowed');
    return asUser(req.user, async (q) => {
      const c = await centerInfo(q, req.user.centerId);
      const rooms = await q(`
        SELECT cl.id, cl.name, cl.color_hex, cl.ratio_children_per_staff AS ratio,
               (SELECT count(*)::int FROM attendance_records ar WHERE ar.classroom_id = cl.id AND ar.service_date = $1 AND ar.status = 'present' AND ar.checked_out_at IS NULL) AS children_in,
               (SELECT count(*)::int FROM time_entries te WHERE te.classroom_id = cl.id AND te.clock_out_at IS NULL) AS staff_in
          FROM classrooms cl WHERE cl.center_id = $2 AND cl.is_active ORDER BY cl.name`, [c.today, req.user.centerId]);
      return rooms.map((x) => ({ ...x, capacity: x.staff_in * x.ratio,
        state: x.children_in === 0 ? 'idle' : x.children_in > x.staff_in * x.ratio ? 'over' : x.children_in === x.staff_in * x.ratio ? 'limit' : 'ok' }));
    });
  }));

  r.post('/attendance/check-in', need('attendance.record'), h(async (req) => {
    const { childId } = req.body;
    const out = await asUser(req.user, async (q) => {
      const c = await centerInfo(q, req.user.centerId);
      const room = (await q('SELECT classroom_id FROM roster_on($1, $2) WHERE child_id = $3', [req.user.centerId, c.today, childId]))[0];
      if (!room) throw new HttpError(400, 'That child is not on the active roster today.');
      const rec = (await q(
        `INSERT INTO attendance_records (center_id, child_id, classroom_id, service_date, status, checked_in_at, recorded_by, checked_in_method)
         VALUES ($1,$2,$3,$4,'present', now(), $5, 'staff')
         ON CONFLICT (child_id, service_date) DO UPDATE SET status = 'present', checked_in_at = coalesce(attendance_records.checked_in_at, now()),
                checked_in_method = coalesce(attendance_records.checked_in_method, 'staff'), absence_reason = NULL
         RETURNING id, checked_in_at`, [req.user.centerId, childId, room.classroom_id, c.today, req.user.id]))[0];
      const ratio = (await q(`SELECT (SELECT count(*)::int FROM attendance_records WHERE classroom_id = $1 AND service_date = $2 AND status = 'present' AND checked_out_at IS NULL) AS kids,
                                     (SELECT count(*)::int FROM time_entries WHERE classroom_id = $1 AND clock_out_at IS NULL) AS staff,
                                     (SELECT ratio_children_per_staff FROM classrooms WHERE id = $1) AS lim`, [room.classroom_id, c.today]))[0];
      return { rec, room, date: c.today, ratio };
    });
    await afterArrival(ctx, req.user.centerId, childId, out.date, out.rec.id, out.ratio, out.room.classroom_id);
    return { ok: true, checkedInAt: out.rec.checked_in_at, overRatio: out.ratio.kids > out.ratio.staff * out.ratio.lim };
  }));

  r.post('/attendance/check-out', need('attendance.checkout'), h(async (req) => {
    const { childId, personKind, personId, photoIdChecked } = req.body;
    if (!photoIdChecked) throw new HttpError(400, 'Confirm you checked photo ID.');
    if (!['guardian', 'contact'].includes(personKind)) throw new HttpError(400, 'Choose who is picking up.');
    return asUser(req.user, async (q) => {
      const c = await centerInfo(q, req.user.centerId);
      const restricted = (await q(
        `SELECT 1 FROM release_restrictions rr WHERE rr.child_id = $1 AND rr.is_active AND rr.effective_from <= current_date
            AND (rr.effective_to IS NULL OR rr.effective_to >= current_date)
            AND ((rr.guardian_id = $2 AND $3 = 'guardian') OR (rr.contact_id = $2 AND $3 = 'contact'))`, [childId, personId, personKind]))[0];
      if (restricted) throw new HttpError(403, 'This person cannot be given this child. Call the director now.');
      const allowed = personKind === 'guardian'
        ? (await q('SELECT 1 FROM child_guardians WHERE child_id = $1 AND guardian_id = $2 AND can_pick_up', [childId, personId]))[0]
        : (await q(`SELECT 1 FROM child_contacts WHERE child_id = $1 AND contact_id = $2 AND role = 'authorized_pickup'`, [childId, personId]))[0];
      if (!allowed) throw new HttpError(403, 'That person is not on the authorized pick-up list.');
      const rows = await q(
        `UPDATE attendance_records SET checked_out_at = now(), photo_id_checked = true, checked_out_method = 'staff',
                picked_up_by_guardian = CASE WHEN $3 = 'guardian' THEN $4::uuid END, picked_up_by_contact = CASE WHEN $3 = 'contact' THEN $4::uuid END
          WHERE child_id = $1 AND service_date = $2 AND checked_in_at IS NOT NULL AND checked_out_at IS NULL RETURNING id, checked_out_at`,
        [childId, c.today, personKind, personId]);
      if (!rows[0]) throw new HttpError(400, 'That child is not signed in.');
      return { ok: true, checkedOutAt: rows[0].checked_out_at };
    }).then(async (res) => { await afterDeparture(ctx, req.user.centerId, childId); return res; });
  }));

  r.post('/attendance/absent', need('attendance.record'), h(async (req) => {
    const { childId, reason, note } = req.body;
    return asUser(req.user, async (q) => {
      const c = await centerInfo(q, req.user.centerId);
      const room = (await q('SELECT classroom_id FROM roster_on($1, $2) WHERE child_id = $3', [req.user.centerId, c.today, childId]))[0];
      if (!room) throw new HttpError(400, 'That child is not on the active roster today.');
      await q(`INSERT INTO attendance_records (center_id, child_id, classroom_id, service_date, status, absence_reason, notes, recorded_by)
               VALUES ($1,$2,$3,$4,'absent',$5,$6,$7)
               ON CONFLICT (child_id, service_date) DO UPDATE SET status = 'absent', absence_reason = EXCLUDED.absence_reason, notes = EXCLUDED.notes`,
        [req.user.centerId, childId, room.classroom_id, c.today, reason || 'Other', note || null, req.user.id]);
      await q(`UPDATE attendance_alerts SET status = 'resolved_absent', resolved_at = now(), resolution_note = 'Marked absent by staff'
                WHERE child_id = $1 AND service_date = $2 AND status IN ('open','parent_responded')`, [childId, c.today]);
      await q(`UPDATE expected_attendance SET status = 'excused' WHERE child_id = $1 AND service_date = $2 AND status = 'expected'`, [childId, c.today]);
      return { ok: true };
    });
  }));

  // Who is allowed to pick a child up (for the check-out picker). Office only.
  r.get('/attendance/pickup-people/:childId', need('attendance.checkout'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT 'guardian' AS kind, g.id, g.first_name || ' ' || g.last_name AS name, cg.relationship FROM child_guardians cg JOIN guardians g ON g.id = cg.guardian_id WHERE cg.child_id = $1 AND cg.can_pick_up
     UNION ALL
     SELECT 'contact', c.id, c.first_name || ' ' || c.last_name, cc.relationship FROM child_contacts cc JOIN contacts c ON c.id = cc.contact_id WHERE cc.child_id = $1 AND cc.role = 'authorized_pickup'`, [req.params.childId]))));

  r.get('/attendance/absences/today', need('attendance.record'), h(async (req) => asUser(req.user, async (q) => {
    const c = await centerInfo(q, req.user.centerId);
    return q(`SELECT ar.child_id, ch.first_name, ch.last_name, ar.absence_reason, ar.notes FROM attendance_records ar JOIN children ch ON ch.id = ar.child_id WHERE ar.service_date = $1 AND ar.status = 'absent'`, [c.today]);
  })));
}

// After a child arrives: close any missing-child alert and tell the family.
export async function afterArrival(ctx, centerId, childId, date, attendanceId, ratio, classroomId) {
  await ctx.asSystem(async (q) => {
    await q(`UPDATE attendance_alerts SET status = 'resolved_arrived', resolved_at = now(), attendance_record_id = $3, next_action_at = NULL
              WHERE child_id = $1 AND service_date = $2 AND status IN ('open','parent_responded')`, [childId, date, attendanceId]);
    await q(`UPDATE expected_attendance SET status = 'arrived' WHERE child_id = $1 AND service_date = $2 AND status = 'expected'`, [childId, date]);
    const child = (await q('SELECT first_name FROM children WHERE id = $1', [childId]))[0];
    for (const g of await guardiansOf(q, childId))
      await notifyGuardian(q, centerId, g.id, 'child_signed_in', `${child.first_name} signed in`, `${child.first_name} was signed in at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`, { table: 'attendance_records', id: attendanceId });
    if (ratio && ratio.kids > ratio.staff * ratio.lim)
      await notifyRoles(q, centerId, ['director', 'front_office'], 'over_ratio', 'A classroom is over ratio',
        'A classroom now has more children than staff allow. Add a staff member or move a child.', { table: 'classrooms', id: classroomId });
  });
}

export async function afterDeparture(ctx, centerId, childId) {
  await ctx.asSystem(async (q) => {
    const child = (await q('SELECT first_name FROM children WHERE id = $1', [childId]))[0];
    for (const g of await guardiansOf(q, childId))
      await notifyGuardian(q, centerId, g.id, 'child_signed_out', `${child.first_name} signed out`, `${child.first_name} was signed out at ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`);
  });
}
