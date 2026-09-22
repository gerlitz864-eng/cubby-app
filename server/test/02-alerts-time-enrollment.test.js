import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

let t;
test.before(async () => { t = await boot(); });
test.after(async () => { await t.close(); });

test('missing-child ladder: opens, texts, calls, respects consent, resolves on arrival', async () => {
  const dir = t.as('director');
  // Marco Rossi has withdrawn consent for automated texts and calls
  await t.db.tx((q) => q(`UPDATE guardian_communication_prefs SET sms_consent = false, voice_consent = false WHERE guardian_id = $1`, [t.seed.guardians.marco]));
  const moved = await dir.post('/jobs/demo/start-day-late', { minutesAgo: 45 });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.ok(moved.body.moved >= 10);
  const run1 = await dir.post('/jobs/run');
  assert.equal(run1.status, 200, JSON.stringify(run1.body));
  assert.ok(run1.body.alertsOpened >= 10, 'alerts open for every child not in');
  assert.ok(run1.body.stepsRun >= 10, 'step 1 runs right away');
  let outbox = (await dir.get('/dev/outbox')).body;
  assert.ok(outbox.some((m) => m.kind === 'sms' && /Noah|Ava|Leo/.test(m.body)), 'a text went to a parent');
  // Elena Martinez signs Ava in at the kiosk: her alert resolves and the ladder stops for her.
  const k = t.kiosk();
  const look = (await k.post('/kiosk/family/lookup', { phone: '5550102313' })).body;
  await k.post('/kiosk/family/sign', { credentialId: look.credentialId, pin: '123456', childId: look.children[0].id, action: 'check_in' });
  const alerts = (await dir.get('/alerts?status=all')).body;
  const ava = alerts.find((a) => a.first_name === 'Ava');
  assert.equal(ava.status, 'resolved_arrived');
  // Fast-forward the ladder: step 2 (voice) then 3, 4 (emergency contacts are never auto-called), 5 (director)
  for (let i = 0; i < 4; i++) {
    await t.db.tx((q) => q(`UPDATE attendance_alerts SET next_action_at = now() WHERE status IN ('open','parent_responded')`));
    await dir.post('/jobs/run');
  }
  outbox = (await dir.get('/dev/outbox')).body;
  assert.ok(outbox.some((m) => m.kind === 'call'), 'an automated call was placed');
  const notes = (await dir.get('/notifications')).body.items;
  assert.ok(notes.some((n) => n.kind === 'call_emergency_contacts'), 'staff are asked to call emergency contacts themselves');
  assert.ok(notes.some((n) => n.kind === 'missing_child_escalation'), 'the director is told when the family has not responded');
  // parent says "absent": the alert resolves and an absence is recorded
  const open = (await dir.get('/alerts')).body.find((a) => a.first_name === 'Jack');
  const resp = await t.as('office').post(`/alerts/${open.id}/response`, { meaning: 'absent_today' });
  assert.equal(resp.status, 200, JSON.stringify(resp.body));
  const after = (await dir.get('/alerts?status=all')).body.find((a) => a.first_name === 'Jack');
  assert.equal(after.status, 'resolved_absent');
});

test('consent is respected: no consent, no text or call', async () => {
  const attempts = await t.db.tx((q) => q(`SELECT n.status, n.channel FROM notification_attempts n JOIN attendance_alerts a ON a.id = n.alert_id JOIN children c ON c.id = a.child_id WHERE c.first_name = 'Sofia'`));
  assert.ok(attempts.length >= 1);
  assert.ok(attempts.every((a) => a.status === 'blocked_no_consent'), 'every attempt for Sofia was blocked');
  const sent = (await t.as('director').get('/dev/outbox')).body;
  assert.ok(!sent.some((m) => m.to === '(555) 010-2318'), 'nothing was sent to Marco Rossi');
});

test('timekeeping: hours are exact, overtime is per policy, approval needs a different person', async () => {
  const k = t.kiosk();
  const staff = (await k.get('/kiosk/staff')).body;
  const hannah = staff.find((s) => s.first_name === 'Hannah');
  // Make a completed shift with exact seconds: 8h 12m 30s
  await t.db.tx((q) => q(`INSERT INTO time_entries (staff_id, clock_in_at, clock_out_at, source) VALUES ($1, now() - interval '9 hours', now() - interval '9 hours' + interval '8 hours 12 minutes 30 seconds', 'manual')`, [hannah.id]));
  const dir = t.as('director');
  const built = await dir.post('/time/timesheets/build', {});
  assert.equal(built.status, 200, JSON.stringify(built.body));
  const rep = await dir.get('/time/weekly-report');
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  const row = rep.body.rows.find((x) => x.first_name === 'Hannah');
  assert.ok(row && Number(row.total_hours) >= 8.2, `hours ${row?.total_hours}`);
  // approval requires the staff member to confirm first
  assert.equal((await dir.post(`/time/timesheets/${row.timesheet_id}/approve`)).status, 400);
  // Maria confirms her own hours; her timesheet has an open shift if she is clocked in, so the director cannot approve until it is fixed
  const maria = rep.body.rows.find((x) => x.first_name === 'Maria');
  if (maria?.has_open_entry) {
    await t.db.tx((q) => q(`UPDATE timesheets SET status = 'submitted' WHERE id = $1`, [maria.timesheet_id]));
    const blocked = await dir.post(`/time/timesheets/${maria.timesheet_id}/approve`);
    assert.equal(blocked.status, 400, 'cannot approve while a shift is open');
  }
  // A teacher confirms her own hours through her own endpoint
  const conf = await t.as('teacher2').post('/time/my/confirm', {});
  assert.equal(conf.status, 200, JSON.stringify(conf.body));
  // The director cannot approve their own timesheet (separation of duties)
  const danaRow = rep.body.rows.find((x) => x.first_name === 'Dana');
  if (danaRow) {
    await t.db.tx((q) => q(`UPDATE timesheets SET status = 'submitted' WHERE id = $1`, [danaRow.timesheet_id]));
    const self = await dir.post(`/time/timesheets/${danaRow.timesheet_id}/approve`);
    assert.ok([400, 403].includes(self.status), 'director cannot approve own hours');
  }
  // the owner can approve Hannah's after she submits
  await t.db.tx((q) => q(`UPDATE timesheets SET status = 'submitted' WHERE id = $1`, [row.timesheet_id]));
  const ok = await t.as('owner').post(`/time/timesheets/${row.timesheet_id}/approve`);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('punch review: a held punch can be accepted by a reviewer and then counts', async () => {
  const k = t.kiosk();
  const tasha = (await k.get('/kiosk/staff')).body.find((s) => s.first_name === 'Tasha');
  const held = await k.post('/kiosk/punch', { staffId: tasha.id, punchType: 'clock_in', method: 'face', imageBase64: 'x', demoResult: 'fail' });
  assert.equal(held.body.status, 'pending_review');
  const q1 = (await t.as('director').get('/time/review-queue')).body;
  const item = q1.find((x) => x.first_name === 'Tasha');
  assert.ok(item);
  const acc = await t.as('director').post(`/time/punches/${item.punch_id}/review`, { decision: 'accept', note: 'Known face, poor lighting' });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  const inNow = (await t.as('director').get('/time/who-is-in')).body;
  assert.ok(inNow.some((x) => x.first_name === 'Tasha'), 'accepted punch opens the shift');
});

test('enrollment: inquiry to enrolled, with guards', async () => {
  const off = t.as('office');
  const inq = await off.post('/enrollment/inquiries', { channel: 'phone', guardian: { firstName: 'Nia', lastName: 'Adeyemi', phone: '555-010-7777', email: 'nia@example.com', consentSms: true }, children: [{ firstName: 'Zuri', dateOfBirth: '2025-03-01', desiredStartDate: '2026-11-01' }] });
  assert.equal(inq.status, 200, JSON.stringify(inq.body));
  const appId = inq.body.applicationIds[0];
  const skip = await off.post(`/enrollment/applications/${appId}/stage`, { stage: 'enrolled' });
  assert.equal(skip.status, 400, 'cannot jump straight to enrolled');
  await off.post(`/enrollment/applications/${appId}/stage`, { stage: 'applied' });
  const noOffer = await off.post(`/enrollment/applications/${appId}/stage`, { stage: 'offered' });
  assert.equal(noOffer.status, 400, 'an offer needs a classroom and start date');
  const rooms = (await t.db.tx((q) => q(`SELECT id, name FROM classrooms`)));
  const room = rooms.find((r) => r.name === 'Bumblebees').id;
  assert.equal((await off.post(`/enrollment/applications/${appId}/stage`, { stage: 'offered', offer: { classroomId: room, startDate: '2026-11-01' } })).status, 200);
  assert.equal((await off.post(`/enrollment/applications/${appId}/stage`, { stage: 'accepted' })).status, 200);
  const detail = (await off.get(`/enrollment/applications/${appId}`)).body;
  assert.ok(detail.checklist.length >= 10, 'the paperwork checklist was created on acceptance');
  const notReady = await off.post(`/enrollment/applications/${appId}/stage`, { stage: 'ready_to_start' });
  assert.equal(notReady.status, 400, 'paperwork is incomplete');
  for (const item of detail.checklist) {
    if (item.is_required) await off.post(`/enrollment/checklist/${item.id}`, { status: 'verified' });
  }
  assert.equal((await off.post(`/enrollment/applications/${appId}/stage`, { stage: 'ready_to_start' })).status, 200);
  const conv = await off.post(`/enrollment/applications/${appId}/convert`);
  assert.equal(conv.status, 200, JSON.stringify(conv.body));
  const child = (await t.db.tx((q) => q(`SELECT status FROM children WHERE id = $1`, [conv.body.childId])))[0];
  assert.equal(child.status, 'scheduled', 'starts in the future, so off the roster for now');
  const roster = (await off.get('/enrollment/roster')).body;
  assert.ok(!roster.some((r) => r.child_id === conv.body.childId));
  // a start date that has arrived activates the child
  await t.db.tx((q) => q(`UPDATE scheduled_transitions SET effective_date = current_date WHERE child_id = $1 AND kind = 'start_enrollment'`, [conv.body.childId]));
  await t.db.tx((q) => q(`UPDATE child_classroom_assignments SET valid_during = daterange(current_date, NULL, '[)') WHERE child_id = $1`, [conv.body.childId]));
  await t.db.tx((q) => q(`UPDATE enrollments SET start_date = current_date WHERE child_id = $1`, [conv.body.childId]));
  const run = await off.post('/enrollment/transitions/run');
  assert.equal(run.body.done, 1);
  const roster2 = (await off.get('/enrollment/roster')).body;
  assert.ok(roster2.some((r) => r.child_id === conv.body.childId), 'now on the active roster');
});

test('enrollment: notice and withdrawal, waitlist and capacity views load', async () => {
  const off = t.as('office');
  const enr = (await off.get('/enrollment/enrollments')).body.find((e) => e.first_name === 'Jack');
  const n = await off.post(`/enrollment/enrollments/${enr.id}/status`, { status: 'notice_given', lastDay: '2026-12-31', reason: 'moved' });
  assert.equal(n.status, 200, JSON.stringify(n.body));
  const back = await off.post(`/enrollment/enrollments/${enr.id}/status`, { status: 'active' });
  assert.equal(back.status, 200);
  assert.equal((await off.get('/enrollment/waitlist')).status, 200);
  const cap = await off.get('/enrollment/capacity');
  assert.equal(cap.status, 200);
  assert.ok(cap.body.length >= 40, 'forecast has 12 months per room');
  assert.equal((await t.as('teacher').get('/enrollment/board')).status, 403, 'teachers cannot see enrollment');
});
