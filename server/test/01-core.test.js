import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

let t;
test.before(async () => { t = await boot(); });
test.after(async () => { await t.close(); });

test('health and login', async () => {
  assert.equal((await t.call('GET', '/health')).body.ok, true);
  assert.equal((await t.call('POST', '/auth/login', { email: 'office@willowcreek.test', password: 'wrong' })).status, 401);
  const me = await t.as('office').get('/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'front_office');
  assert.ok(me.body.permissions.length > 10);
});

test('teacher sees only their own room; office sees everyone', async () => {
  const teacher = await t.as('teacher').get('/attendance/today');
  assert.equal(teacher.status, 200);
  assert.ok(teacher.body.length > 0);
  assert.ok(teacher.body.every((c) => c.classroom === 'Ladybugs'), 'teacher should only see Ladybugs');
  const office = await t.as('office').get('/attendance/today');
  assert.ok(office.body.length >= 12);
  assert.ok(new Set(office.body.map((c) => c.classroom)).size >= 4);
});

test('teacher cannot reach billing, staff, or enrollment data directly', async () => {
  for (const table of ['billing_accounts', 'staff', 'enrollment_applications', 'time_entries', 'purchase_needs', 'invoices', 'children', 'guardians'])
    assert.equal(await t.tryAs('cubby_teacher', t.seed.user.teacher, `SELECT * FROM ${table}`), '42501', `${table} should be denied to teachers`);
  // ... but can use the doors built for them
  assert.equal(await t.tryAs('cubby_teacher', t.seed.user.teacher, 'SELECT * FROM v_teacher_arrivals'), 'ok');
  assert.equal(await t.tryAs('cubby_teacher', t.seed.user.teacher, 'SELECT * FROM v_teacher_meal_roster'), 'ok');
});

test('office check-in, then check-out with a verified pick-up person', async () => {
  const o = t.as('office');
  const noah = t.seed.child.noah;
  const ci = await o.post('/attendance/check-in', { childId: noah });
  assert.equal(ci.status, 200, JSON.stringify(ci.body));
  const people = await o.get(`/attendance/pickup-people/${noah}`);
  assert.ok(people.body.some((p) => p.kind === 'contact'), 'grandmother is an authorized contact');
  const bad = await o.post('/attendance/check-out', { childId: noah, personKind: 'guardian', personId: t.seed.guardians.chidi, photoIdChecked: true });
  assert.equal(bad.status, 403, 'someone not on the list is refused');
  const noId = await o.post('/attendance/check-out', { childId: noah, personKind: 'guardian', personId: t.seed.guardians.rachel, photoIdChecked: false });
  assert.equal(noId.status, 400);
  const good = await o.post('/attendance/check-out', { childId: noah, personKind: 'guardian', personId: t.seed.guardians.rachel, photoIdChecked: true });
  assert.equal(good.status, 200, JSON.stringify(good.body));
});

test('parent sees only their own children sign-in/out (and nothing else)', async () => {
  const parentId = (await t.db.tx((q2) => q2(`SELECT id FROM users WHERE email='parent@willowcreek.test'`)))[0].id;
  const rows = await t.db.tx(async (q) => {
    await q('SET LOCAL ROLE cubby_parent');
    await q(`SELECT set_config('app.user_id', $1, true)`, [parentId]);
    return q('SELECT child_first_name FROM v_parent_sign_in_out');
  });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => ['Noah', 'Ruby'].includes(r.child_first_name)), "only Rachel Bennett's own children");
  for (const table of ['children', 'attendance_records', 'child_meal_records', 'staff', 'supply_flags'])
    assert.equal(await t.tryAs('cubby_parent', parentId, `SELECT * FROM ${table}`), '42501', `${table} should be denied to parents`);
  assert.equal((await t.as('parent').get('/attendance/today')).status, 403);
});

test('kiosk: staff PIN punch, face punch, and held punch', async () => {
  const k = t.kiosk();
  const list = await k.get('/kiosk/staff');
  assert.equal(list.status, 200);
  const maria = list.body.find((s) => s.first_name === 'Maria');
  assert.equal(maria.face_enabled, true);
  assert.equal((await k.post('/kiosk/punch', { staffId: maria.id, punchType: 'clock_in', method: 'pin', pin: '0000' })).status, 401);
  const inn = await k.post('/kiosk/punch', { staffId: maria.id, punchType: 'clock_in', method: 'face', imageBase64: 'x'.repeat(2000) });
  assert.equal(inn.status, 200, JSON.stringify(inn.body));
  assert.equal(inn.body.status, 'accepted');
  const spoof = await k.post('/kiosk/punch', { staffId: maria.id, punchType: 'break_start', method: 'face', imageBase64: 'x', demoResult: 'spoof' });
  assert.equal(spoof.body.status, 'pending_review', 'a failed liveness check is held, not dropped');
  const noFace = list.body.find((s) => s.first_name === 'Kevin');
  assert.equal((await k.post('/kiosk/punch', { staffId: noFace.id, punchType: 'clock_in', method: 'face', imageBase64: 'x' })).status, 400, 'face requires consent and a template');
  const pinIn = await k.post('/kiosk/punch', { staffId: noFace.id, punchType: 'clock_in', method: 'pin', pin: '2468' });
  assert.equal(pinIn.body.status, 'accepted');
  assert.equal((await t.call('POST', '/kiosk/punch', {}, { 'x-device-token': 'nope' })).status, 401);
});

test('kiosk: parent PIN sign-in and sign-out, lockout, and restrictions', async () => {
  const k = t.kiosk();
  const look = await k.post('/kiosk/family/lookup', { phone: '555-010-2313' }); // Elena Martinez
  assert.equal(look.status, 200);
  assert.deepEqual(look.body.children.map((c) => c.first_name), ['Ava']);
  const ava = look.body.children[0].id;
  const wrong = await k.post('/kiosk/family/sign', { credentialId: look.body.credentialId, pin: '000000', childId: ava, action: 'check_in' });
  assert.equal(wrong.status, 403);
  const ok = await k.post('/kiosk/family/sign', { credentialId: look.body.credentialId, pin: '123456', childId: ava, action: 'check_in' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // someone else's child is refused
  const noah = t.seed.child.noah;
  const other = await k.post('/kiosk/family/sign', { credentialId: look.body.credentialId, pin: '123456', childId: noah, action: 'check_in' });
  assert.equal(other.status, 403);
  // lockout after five wrong PINs
  const chen = (await k.post('/kiosk/family/lookup', { phone: '5550102314' })).body;
  let last;
  for (let i = 0; i < 5; i++) last = await k.post('/kiosk/family/sign', { credentialId: chen.credentialId, pin: '111111', childId: chen.children[0].id, action: 'check_in' });
  assert.equal(last.status, 423);
  const stillLocked = await k.post('/kiosk/family/sign', { credentialId: chen.credentialId, pin: '123456', childId: chen.children[0].id, action: 'check_in' });
  assert.equal(stillLocked.status, 423, 'the right PIN is refused while locked');
  const notes = await t.as('director').get('/notifications');
  assert.ok(notes.body.items.some((n) => n.kind === 'pin_locked'), 'the director is told');
  // release restriction blocks sign-out
  await t.db.tx((q) => q(`INSERT INTO release_restrictions (center_id, child_id, guardian_id, note) VALUES ($1,$2,$3,'court order (demo)')`, [t.seed.center, ava, t.seed.guardians.elena]));
  const out = await k.post('/kiosk/family/sign', { credentialId: look.body.credentialId, pin: '123456', childId: ava, action: 'check_out' });
  assert.equal(out.status, 403);
});
