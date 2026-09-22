import { h, need, HttpError } from '../lib/ctx.js';
import { centerInfo, notifyRoles } from '../lib/notifications.js';
import { buildTimesheets } from '../jobs/index.js';

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const mondayOf = async (q, dateStr) => iso((await q(`SELECT ($1::date - (extract(isodow FROM $1::date)::int - 1))::date AS d`, [dateStr]))[0].d);

export default function register(r, ctx) {
  const { asUser, asSystem } = ctx;

  r.get('/time/who-is-in', need('time.view_all'), h(async (req) => asUser(req.user, (q) => q('SELECT * FROM v_who_is_clocked_in ORDER BY first_name'))));

  // Punches that need a person to look at them (failed face check, out of sequence, device clock off).
  r.get('/time/review-queue', need('time.view_all'), h(async (req) => asUser(req.user, (q) => q('SELECT * FROM v_punch_review_queue ORDER BY hours_waiting DESC'))));

  r.post('/time/punches/:id/review', need('time.approve'), h(async (req) => {
    const { decision, note } = req.body || {};
    if (!['accept', 'reject'].includes(decision)) throw new HttpError(400, 'Choose accept or reject');
    return asUser(req.user, async (q) => {
      const rows = await q(`UPDATE punch_events SET status = $2::punch_status, reviewed_by = $3, reviewed_at = now(), review_note = $4
                             WHERE id = $1 AND status = 'pending_review' RETURNING id, status`, [req.params.id, decision === 'accept' ? 'accepted' : 'rejected', req.user.id, note || null]);
      if (!rows[0]) throw new HttpError(404, 'That punch is not waiting for review');
      return rows[0];
    });
  }));

  // Build (or rebuild) everyone's timesheet for a week. Weeks default to the current one.
  r.post('/time/timesheets/build', need('time.approve'), h(async (req) => asSystem(async (q) => {
    const c = await centerInfo(q, req.user.centerId);
    const ws = await mondayOf(q, req.body?.weekStart || c.today);
    const ids = await buildTimesheets(q, req.user.centerId, ws);
    return { weekStart: ws, built: ids.length };
  })));

  // The weekly hours report: exact hours for each person, plus what is still unresolved.
  r.get('/time/weekly-report', need('time.view_all'), h(async (req) => {
    const c = await asSystem((q) => centerInfo(q, req.user.centerId));
    return asUser(req.user, async (q) => {
      const ws = await mondayOf(q, req.query.weekStart || c.today);
      const rows = await q(`SELECT w.*, t.id AS timesheet_id, t.total_seconds FROM v_weekly_hours_report w JOIN timesheets t ON t.staff_id = w.staff_id AND t.week_start = w.week_start
                             WHERE w.week_start = $1::date ORDER BY w.last_name, w.first_name`, [ws]);
      const days = await q(`SELECT * FROM v_daily_hours WHERE week_start = $1::date ORDER BY work_date`, [ws]);
      const totals = rows.reduce((a, x) => ({ total: a.total + Number(x.total_hours), overtime: a.overtime + Number(x.overtime_hours) }), { total: 0, overtime: 0 });
      return { weekStart: ws, weekEnd: iso(new Date(new Date(ws + 'T12:00:00').getTime() + 6 * 864e5)), rows, days, totals };
    });
  }));

  r.post('/time/timesheets/:id/approve', need('time.approve'), h(async (req) => asUser(req.user, async (q) => {
    const ts = (await q('SELECT id, status FROM timesheets WHERE id = $1', [req.params.id]))[0];
    if (!ts) throw new HttpError(404, 'Timesheet not found');
    if (ts.status === 'open') throw new HttpError(400, 'The staff member has not confirmed their hours yet.');
    const rows = await q(`UPDATE timesheets SET status = 'approved', approved_by = $2 WHERE id = $1 RETURNING id, status`, [req.params.id, req.user.id]);
    return rows[0];
  })));

  r.post('/time/timesheets/:id/lock', need('time.approve'), h(async (req) => asUser(req.user, async (q) => (await q(`UPDATE timesheets SET status = 'locked' WHERE id = $1 RETURNING id, status`, [req.params.id]))[0])));
  r.post('/time/timesheets/:id/reopen', need('time.approve'), h(async (req) => asUser(req.user, async (q) => {
    const row = (await q(`UPDATE timesheets SET status = 'submitted' WHERE id = $1 AND status = 'approved' RETURNING id, status`, [req.params.id]))[0];
    if (!row) throw new HttpError(400, 'Only an approved timesheet can be reopened');
    await q(`UPDATE timesheets SET status = 'open' WHERE id = $1`, [req.params.id]);
    return { id: row.id, status: 'open' };
  })));

  // A staff member's own hours: this week, day by day, and the button to confirm them.
  r.get('/time/my', need('time.punch'), h(async (req) => {
    if (!req.user.staffId) return { rows: [], days: [] };
    return asSystem(async (q) => {
      const c = await centerInfo(q, req.user.centerId);
      const ws = await mondayOf(q, req.query.weekStart || c.today);
      await q('SELECT build_timesheet($1, $2::date)', [req.user.staffId, ws]).catch(() => {});
      const sheet = (await q(`SELECT id, status, total_seconds, regular_seconds, overtime_seconds, has_open_entry, has_pending_punches FROM timesheets WHERE staff_id = $1 AND week_start = $2::date`, [req.user.staffId, ws]))[0] || null;
      const days = sheet ? await q(`SELECT work_date, entries, first_in, last_out, worked_seconds FROM timesheet_days WHERE timesheet_id = $1 ORDER BY work_date`, [sheet.id]) : [];
      return { weekStart: ws, sheet, days };
    });
  }));

  r.post('/time/my/confirm', need('time.punch'), h(async (req) => asSystem(async (q) => {
    const c = await centerInfo(q, req.user.centerId);
    const ws = await mondayOf(q, req.body?.weekStart || c.today);
    const id = (await q('SELECT build_timesheet($1, $2::date) AS id', [req.user.staffId, ws]))[0].id;
    const row = (await q(`UPDATE timesheets SET status = 'submitted' WHERE id = $1 AND status = 'open' RETURNING id, status`, [id]))[0];
    return row || { id, status: 'already confirmed' };
  })));

  // Corrections: a missed or wrong punch is fixed with a request that someone else approves. The original punches stay as recorded.
  r.get('/time/corrections', need('time.view_all'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT tc.*, s.first_name, s.last_name FROM time_corrections tc JOIN staff s ON s.id = tc.staff_id ORDER BY tc.requested_at DESC LIMIT 100`))));
  r.post('/time/corrections', need('time.view_all', 'time.punch'), h(async (req) => {
    const b = req.body || {};
    const staffId = req.user.perms.get('time.view_all') ? b.staffId : req.user.staffId;
    if (!staffId || !b.requestedClockIn || !b.reason) throw new HttpError(400, 'Who, the time, and a reason are required');
    return asSystem(async (q) => {
      const row = (await q(`INSERT INTO time_corrections (center_id, staff_id, target_time_entry_id, classroom_id, requested_clock_in, requested_clock_out, reason, requested_by)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [req.user.centerId, staffId, b.targetTimeEntryId || null, b.classroomId || null, b.requestedClockIn, b.requestedClockOut || null, b.reason, req.user.id]))[0];
      await notifyRoles(q, req.user.centerId, ['director'], 'time_correction', 'A time correction needs review', b.reason, { table: 'time_corrections', id: row.id });
      return row;
    });
  }));
  r.post('/time/corrections/:id/approve', need('time.approve'), h(async (req) => asUser(req.user, async (q) => {
    const id = (await q('SELECT apply_time_correction($1,$2) AS id', [req.params.id, req.user.id]))[0].id;
    return { ok: true, timeEntryId: id };
  })));
  r.post('/time/corrections/:id/deny', need('time.approve'), h(async (req) => asUser(req.user, async (q) => {
    if (!req.body?.note) throw new HttpError(400, 'Give a reason for denying');
    await q(`UPDATE time_corrections SET status = 'denied', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1 AND status = 'pending'`, [req.params.id, req.user.id, req.body.note]);
    return { ok: true };
  })));

  r.get('/time/punctuality', need('punctuality.view'), h(async (req) => asUser(req.user, async (q) => {
    const today = await q('SELECT * FROM v_arrivals_today ORDER BY subject_type, person');
    const summary = await q(`SELECT s.*, coalesce(ch.first_name || ' ' || ch.last_name, st.first_name || ' ' || st.last_name) AS person
                               FROM v_punctuality_summary s LEFT JOIN children ch ON ch.id = s.child_id LEFT JOIN staff st ON st.id = s.staff_id
                              WHERE s.late_days + s.no_show_days > 0 ORDER BY s.late_days + s.no_show_days DESC LIMIT 30`);
    return { today, summary };
  })));

  r.get('/time/exceptions', need('time.view_all'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT te.*, s.first_name, s.last_name FROM time_exceptions te JOIN staff s ON s.id = te.staff_id WHERE te.status = 'open' ORDER BY te.detected_at DESC LIMIT 50`))));
}
