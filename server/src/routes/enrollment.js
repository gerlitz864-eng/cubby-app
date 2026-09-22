import { h, need, HttpError } from '../lib/ctx.js';
import { centerInfo, notifyRoles } from '../lib/notifications.js';
import { pick } from '../lib/resource.js';

export default function register(r, ctx) {
  const { asUser, asSystem } = ctx;
  const STAGES = ['inquiry', 'tour_scheduled', 'toured', 'applied', 'waitlisted', 'offered', 'accepted', 'ready_to_start', 'enrolled'];

  // ---------- future track: the pipeline ----------
  r.get('/enrollment/board', need('enrollment.view'), h(async (req) => asUser(req.user, async (q) => {
    const apps = await q(`
      SELECT ap.id, ap.child_first_name, ap.child_last_name, ap.date_of_birth, ap.expected_due_date, ap.desired_start_date, ap.stage, ap.stage_changed_at,
             ap.offered_classroom_id, ap.offered_start_date, ap.offer_expires_at, ap.waitlist_joined_at, ap.converted_child_id, ap.inquiry_id,
             i.channel, pg.first_name || ' ' || pg.last_name AS contact, pg.phone, pg.email,
             (SELECT count(*)::int FROM application_checklist c JOIN checklist_item_types t ON t.id = c.item_type_id WHERE c.application_id = ap.id AND t.is_required) AS checklist_total,
             (SELECT count(*)::int FROM application_checklist c JOIN checklist_item_types t ON t.id = c.item_type_id WHERE c.application_id = ap.id AND t.is_required AND c.status IN ('verified','waived')) AS checklist_done
        FROM enrollment_applications ap
        JOIN inquiries i ON i.id = ap.inquiry_id
        LEFT JOIN prospect_guardians pg ON pg.inquiry_id = i.id AND pg.is_primary
       WHERE ap.stage NOT IN ('enrolled','family_declined','center_declined','lost_contact','offer_expired') OR ap.stage_changed_at > now() - interval '30 days'
       ORDER BY ap.stage_changed_at DESC`);
    return { stages: STAGES, applications: apps };
  })));

  // A new inquiry: one family, one or more children, and their contact preferences.
  r.post('/enrollment/inquiries', need('enrollment.manage'), h(async (req) => {
    const b = req.body || {};
    if (!b.guardian?.firstName || !b.guardian?.lastName || !b.children?.length) throw new HttpError(400, 'A parent name and at least one child are required');
    return asUser(req.user, async (q) => {
      const inq = (await q(`INSERT INTO inquiries (center_id, channel, source_detail, notes, assigned_to, created_by) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
        [req.user.centerId, b.channel || 'phone', b.sourceDetail || null, b.notes || null, req.user.id]))[0].id;
      const consent = !!(b.guardian.consentCalls || b.guardian.consentSms);
      await q(`INSERT INTO prospect_guardians (inquiry_id, first_name, last_name, phone, email, is_primary, consent_calls, consent_sms, consent_captured_at, consent_source)
               VALUES ($1,$2,$3,$4,$5,true,$6,$7, CASE WHEN $8 THEN now() END, CASE WHEN $8 THEN $9 END)`,
        [inq, b.guardian.firstName, b.guardian.lastName, b.guardian.phone || null, b.guardian.email || null, !!b.guardian.consentCalls, !!b.guardian.consentSms, consent, b.consentSource || 'recorded by staff']);
      const ids = [];
      for (const ch of b.children) {
        if (!ch.firstName || (!ch.dateOfBirth && !ch.dueDate)) throw new HttpError(400, 'Each child needs a first name and a birth date or due date');
        ids.push((await q(`INSERT INTO enrollment_applications (center_id, inquiry_id, child_first_name, child_last_name, date_of_birth, expected_due_date, desired_start_date, assigned_to)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [req.user.centerId, inq, ch.firstName, ch.lastName || b.guardian.lastName, ch.dateOfBirth || null, ch.dueDate || null, ch.desiredStartDate || null, req.user.id]))[0].id);
      }
      await q(`INSERT INTO office_tasks (center_id, title, related_table, related_id, assigned_to, due_at, created_by_system) VALUES ($1,$2,'inquiries',$3,$4, now() + interval '1 day', true)`,
        [req.user.centerId, `Reply to the ${b.guardian.lastName} family`, inq, req.user.id]);
      return { inquiryId: inq, applicationIds: ids };
    });
  }));

  // Move an application to a new stage. The database refuses moves that are not allowed.
  r.post('/enrollment/applications/:id/stage', need('enrollment.manage'), h(async (req) => {
    const { stage, offer, reason } = req.body || {};
    return asUser(req.user, async (q) => {
      if (stage === 'offered') {
        if (!offer?.classroomId || !offer?.startDate) throw new HttpError(400, 'An offer needs a classroom and a start date');
        const days = (await q('SELECT offer_hold_days FROM centers WHERE id = $1', [req.user.centerId]))[0].offer_hold_days;
        await q(`UPDATE enrollment_applications SET offered_classroom_id = $2, offered_start_date = $3, offer_expires_at = now() + make_interval(days => $4::int) WHERE id = $1`,
          [req.params.id, offer.classroomId, offer.startDate, days]);
      }
      if (reason) await q('UPDATE enrollment_applications SET decline_reason = $2 WHERE id = $1', [req.params.id, reason]);
      const row = (await q('UPDATE enrollment_applications SET stage = $2::pipeline_stage WHERE id = $1 RETURNING id, stage', [req.params.id, stage]))[0];
      if (!row) throw new HttpError(404, 'Application not found');
      return row;
    });
  }));

  r.get('/enrollment/applications/:id', need('enrollment.view'), h(async (req) => asUser(req.user, async (q) => {
    const ap = (await q(`SELECT ap.*, i.channel, i.notes AS inquiry_notes FROM enrollment_applications ap JOIN inquiries i ON i.id = ap.inquiry_id WHERE ap.id = $1`, [req.params.id]))[0];
    if (!ap) throw new HttpError(404, 'Not found');
    const guardians = await q('SELECT id, first_name, last_name, phone, email, is_primary, consent_calls, consent_sms FROM prospect_guardians WHERE inquiry_id = $1', [ap.inquiry_id]);
    const checklist = await q(`SELECT c.id, t.label, t.is_required, c.status, c.due_date, c.waived_reason FROM application_checklist c JOIN checklist_item_types t ON t.id = c.item_type_id WHERE c.application_id = $1 ORDER BY t.sort_order`, [ap.id]);
    const events = await q('SELECT event, from_stage, to_stage, note, occurred_at FROM application_events WHERE application_id = $1 ORDER BY occurred_at DESC LIMIT 30', [ap.id]);
    const tours = await q('SELECT id, scheduled_at, status, notes FROM tours WHERE inquiry_id = $1 ORDER BY scheduled_at', [ap.inquiry_id]);
    return { application: ap, guardians, checklist, events, tours };
  })));

  r.post('/enrollment/checklist/:id', need('enrollment.manage'), h(async (req) => {
    const { status, waivedReason } = req.body || {};
    return asUser(req.user, async (q) => (await q(
      `UPDATE application_checklist SET status = $2::checklist_status, waived_reason = $3, received_at = CASE WHEN $2 IN ('received','verified') THEN coalesce(received_at, now()) END,
              verified_by = CASE WHEN $2 = 'verified' THEN $4::uuid END, verified_at = CASE WHEN $2 = 'verified' THEN now() END WHERE id = $1 RETURNING id, status`,
      [req.params.id, status, waivedReason || null, req.user.id]))[0]);
  }));

  r.post('/enrollment/applications/:id/tour', need('enrollment.manage'), h(async (req) => asUser(req.user, async (q) => {
    const ap = (await q('SELECT inquiry_id FROM enrollment_applications WHERE id = $1', [req.params.id]))[0];
    const tour = (await q(`INSERT INTO tours (inquiry_id, scheduled_at, conducted_by) VALUES ($1,$2,$3) RETURNING id`, [ap.inquiry_id, req.body.scheduledAt, req.user.id]))[0];
    await q(`UPDATE enrollment_applications SET stage = 'tour_scheduled' WHERE id = $1 AND stage = 'inquiry'`, [req.params.id]);
    return tour;
  })));

  // Turn a ready application into an enrolled child (scheduled to start on the offered date).
  r.post('/enrollment/applications/:id/convert', need('enrollment.manage'), h(async (req) => asUser(req.user, async (q) => {
    const childId = (await q('SELECT convert_application($1,$2) AS id', [req.params.id, req.user.id]))[0].id;
    const c = await centerInfo(q, req.user.centerId);
    const done = (await q('SELECT execute_scheduled_transitions($1,$2::date) AS n', [req.user.centerId, c.today]))[0].n;
    return { childId, startedToday: done > 0 };
  })));

  r.get('/enrollment/waitlist', need('enrollment.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT w.*, cl.name AS classroom FROM v_waitlist w LEFT JOIN classrooms cl ON cl.id = w.projected_classroom_id ORDER BY cl.name NULLS LAST, w.position`))));

  r.get('/enrollment/capacity', need('enrollment.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT classroom, classroom_id, month_start, capacity, enrolled, pending_offers, open_spots FROM v_classroom_capacity_forecast ORDER BY classroom, month_start`))));

  r.get('/enrollment/offer-candidates', need('enrollment.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT o.*, cl.name AS classroom FROM v_offer_candidates o JOIN classrooms cl ON cl.id = o.classroom_id ORDER BY o.month_start, o.position`))));

  // ---------- current track: the active roster ----------
  r.get('/enrollment/roster', need('enrollment.view', 'attendance.view'), h(async (req) => asUser(req.user, async (q) => {
    const c = await centerInfo(q, req.user.centerId);
    return q(`SELECT r.child_id, r.first_name, r.last_name, r.date_of_birth, r.classroom_id, cl.name AS classroom, r.enrollment_status, r.last_day
                FROM roster_on($1, $2::date) r JOIN classrooms cl ON cl.id = r.classroom_id ORDER BY cl.name, r.last_name`, [req.user.centerId, c.today]);
  })));

  r.get('/enrollment/enrollments', need('enrollment.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT e.id, e.child_id, ch.first_name, ch.last_name, e.status, e.start_date, e.scheduled_end_date, e.end_date, e.notice_given_on, e.planned_return_on
       FROM enrollments e JOIN children ch ON ch.id = e.child_id WHERE e.status <> 'cancelled' ORDER BY e.status, ch.last_name`))));

  // Leave, notice, and withdrawal.
  r.post('/enrollment/enrollments/:id/status', need('enrollment.manage'), h(async (req) => {
    const { status, lastDay, returnOn, reason, note } = req.body || {};
    return asUser(req.user, async (q) => {
      const cur = (await q('SELECT child_id FROM enrollments WHERE id = $1', [req.params.id]))[0];
      if (!cur) throw new HttpError(404, 'Not found');
      const c = await centerInfo(q, req.user.centerId);
      if (status === 'notice_given') {
        if (!lastDay) throw new HttpError(400, 'Enter the last day');
        await q(`UPDATE enrollments SET status = 'notice_given', notice_given_on = $2::date, scheduled_end_date = $3::date, withdrawal_reason = $4::withdrawal_reason, withdrawal_note = $5 WHERE id = $1`,
          [req.params.id, c.today, lastDay, reason || 'other', note || null]);
        await q(`INSERT INTO scheduled_transitions (center_id, child_id, kind, effective_date, status, created_by, reason) VALUES ($1,$2,'end_enrollment',$3::date,'planned',$4,'Notice given')`,
          [req.user.centerId, cur.child_id, lastDay, req.user.id]);
      } else if (status === 'on_leave') {
        await q(`UPDATE enrollments SET status = 'on_leave', planned_return_on = $2::date WHERE id = $1`, [req.params.id, returnOn || null]);
        if (returnOn) await q(`INSERT INTO scheduled_transitions (center_id, child_id, kind, effective_date, status, created_by, reason) VALUES ($1,$2,'return_from_leave',$3::date,'planned',$4,'Planned return')`,
          [req.user.centerId, cur.child_id, returnOn, req.user.id]);
      } else if (status === 'active') {
        await q(`UPDATE enrollments SET status = 'active', scheduled_end_date = NULL, notice_given_on = NULL WHERE id = $1`, [req.params.id]);
        await q(`UPDATE scheduled_transitions SET status = 'cancelled' WHERE child_id = $1 AND kind IN ('end_enrollment','return_from_leave') AND status = 'planned'`, [cur.child_id]);
      } else if (status === 'withdrawn') {
        await q(`UPDATE enrollments SET status = 'withdrawn', end_date = $2::date, withdrawal_reason = $3::withdrawal_reason, withdrawal_note = $4 WHERE id = $1`, [req.params.id, lastDay || c.today, reason || 'other', note || null]);
        await q(`UPDATE child_classroom_assignments SET valid_during = daterange(lower(valid_during), $2::date, '[)') WHERE child_id = $1 AND upper_inf(valid_during) AND lower(valid_during) < $2::date`, [cur.child_id, lastDay || c.today]);
      } else throw new HttpError(400, 'Choose leave, notice, active, or withdrawn');
      return { ok: true };
    });
  }));

  r.get('/enrollment/age-ups', need('enrollment.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT a.*, f.name AS from_classroom, t.name AS to_classroom FROM v_upcoming_age_transitions a
       JOIN classrooms f ON f.id = a.from_classroom_id JOIN classrooms t ON t.id = a.to_classroom_id ORDER BY a.last_name`))));
  r.post('/enrollment/age-ups/confirm', need('enrollment.manage'), h(async (req) => asUser(req.user, async (q) => {
    const { childId, toClassroomId, moveDate } = req.body || {};
    await q(`INSERT INTO scheduled_transitions (center_id, child_id, kind, effective_date, to_classroom_id, status, created_by, confirmed_by, confirmed_at, reason)
             VALUES ($1,$2,'classroom_change',$3::date,$4,'planned',$5,$5, now(), 'Aging into the next room')`, [req.user.centerId, childId, moveDate, toClassroomId, req.user.id]);
    return { ok: true };
  })));
  r.post('/enrollment/transitions/run', need('enrollment.manage'), h(async (req) => asUser(req.user, async (q) => {
    const c = await centerInfo(q, req.user.centerId);
    return { done: (await q('SELECT execute_scheduled_transitions($1,$2::date) AS n', [req.user.centerId, c.today]))[0].n };
  })));

  r.get('/enrollment/tasks', need('enrollment.view'), h(async (req) => asUser(req.user, (q) => q(`SELECT * FROM office_tasks WHERE status = 'open' ORDER BY due_at LIMIT 50`))));
}
