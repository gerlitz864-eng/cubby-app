import { h, need, HttpError } from '../lib/ctx.js';
import { centerInfo, notifyRoles } from '../lib/notifications.js';
import { runAll, generateExpectedAttendance } from '../jobs/index.js';

export default function register(r, ctx) {
  const { asUser, asSystem, config } = ctx;

  r.get('/alerts', need('attendance.record'), h(async (req) => asUser(req.user, async (q) => {
    const active = req.query.status !== 'all';
    return q(`
      SELECT a.id, a.status, a.opened_at, a.current_step, a.next_action_at, a.resolved_at, a.resolution_note, a.service_date,
             ch.id AS child_id, ch.first_name, ch.last_name, ea.expected_arrival,
             (SELECT json_agg(json_build_object('step', n.step_no, 'channel', n.channel, 'status', n.status, 'response', n.response_meaning, 'at', n.queued_at, 'who', g.first_name) ORDER BY n.queued_at)
                FROM notification_attempts n LEFT JOIN guardians g ON g.id = n.guardian_id WHERE n.alert_id = a.id) AS attempts
        FROM attendance_alerts a JOIN children ch ON ch.id = a.child_id LEFT JOIN expected_attendance ea ON ea.id = a.expected_attendance_id
       ${active ? `WHERE a.status IN ('open','parent_responded')` : ''}
       ORDER BY a.opened_at DESC LIMIT 100`);
  })));

  // A parent replied (by keypad on the call, or by text). Staff can record it here too.
  r.post('/alerts/:id/response', need('attendance.record'), h(async (req) => {
    const meaning = req.body?.meaning;
    if (!['arriving_late', 'absent_today', 'call_me'].includes(meaning)) throw new HttpError(400, 'Choose a response');
    return asUser(req.user, async (q) => {
      const a = (await q('SELECT * FROM attendance_alerts WHERE id = $1', [req.params.id]))[0];
      if (!a) throw new HttpError(404, 'Alert not found');
      await q(`UPDATE notification_attempts SET response_meaning = $2::parent_response, response_code = 'recorded by staff' WHERE id = (SELECT id FROM notification_attempts WHERE alert_id = $1 ORDER BY queued_at DESC LIMIT 1)`, [a.id, meaning]);
      if (meaning === 'absent_today') {
        const c = await centerInfo(q, req.user.centerId);
        const room = (await q('SELECT classroom_id FROM roster_on($1,$2) WHERE child_id = $3', [req.user.centerId, c.today, a.child_id]))[0];
        if (room) await q(`INSERT INTO attendance_records (center_id, child_id, classroom_id, service_date, status, absence_reason, recorded_by)
                           VALUES ($1,$2,$3,$4,'absent','Reported by parent',$5) ON CONFLICT (child_id, service_date) DO UPDATE SET status = 'absent', absence_reason = 'Reported by parent'`,
          [req.user.centerId, a.child_id, room.classroom_id, c.today, req.user.id]);
        await q(`UPDATE attendance_alerts SET status = 'resolved_absent', resolved_at = now(), next_action_at = NULL, resolution_note = 'Parent reported an absence' WHERE id = $1`, [a.id]);
      } else if (meaning === 'arriving_late') {
        await q(`UPDATE attendance_alerts SET status = 'parent_responded', next_action_at = now() + interval '30 minutes' WHERE id = $1`, [a.id]);
      } else {
        await q(`UPDATE attendance_alerts SET status = 'parent_responded', next_action_at = NULL WHERE id = $1`, [a.id]);
        await notifyRoles(q, req.user.centerId, ['director', 'front_office'], 'parent_call_me', 'A parent asked for a call', 'Please call the family about the child who has not arrived.', { table: 'attendance_alerts', id: a.id });
      }
      return { ok: true };
    });
  }));

  r.post('/alerts/:id/resolve', need('attendance.record'), h(async (req) => asUser(req.user, async (q) => {
    await q(`UPDATE attendance_alerts SET status = 'resolved_by_staff', resolved_at = now(), resolved_by = $2, next_action_at = NULL, resolution_note = $3 WHERE id = $1 AND status IN ('open','parent_responded')`,
      [req.params.id, req.user.id, req.body?.note || null]);
    return { ok: true };
  })));

  // Demo controls. These exist so the alert flow can be tried at any time of day. Disabled in production.
  r.post('/jobs/run', need('settings.manage'), h(async (req) => runAll(ctx, req.user.centerId)));

  r.post('/jobs/demo/start-day-late', need('settings.manage'), h(async (req) => {
    if (config.production) throw new HttpError(403, 'Demo controls are disabled');
    const minutes = Number(req.body?.minutesAgo || 45);
    return asSystem(async (q) => {
      const c = await centerInfo(q, req.user.centerId);
      await generateExpectedAttendance(q, c);
      const n = await q(`UPDATE expected_attendance ea SET expected_arrival = ((now() AT TIME ZONE $3) - make_interval(mins => $2::int))::time
                          WHERE ea.center_id = $1 AND ea.service_date = $4::date AND ea.status = 'expected'
                            AND NOT EXISTS (SELECT 1 FROM attendance_records ar WHERE ar.child_id = ea.child_id AND ar.service_date = ea.service_date) RETURNING id`, [req.user.centerId, minutes, c.timezone, c.today]);
      await q(`UPDATE attendance_alerts SET next_action_at = now() WHERE center_id = $1 AND status IN ('open','parent_responded') AND next_action_at IS NOT NULL`, [req.user.centerId]);
      return { moved: n.length, note: `Expected arrivals for children not yet in were moved to ${minutes} minutes ago. Run the jobs to open alerts.` };
    });
  }));

  r.get('/dev/outbox', need('settings.manage'), h(async () => ctx.notifier.outbox));
}
