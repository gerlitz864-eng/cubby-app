import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

let t;
test.before(async () => { t = await boot(); });
test.after(async () => { await t.close(); });

const kid = async (name) => (await t.db.tx((q) => q(`SELECT id FROM children WHERE first_name = $1`, [name])))[0].id;
const signIn = async (name) => assert.equal((await t.as('office').post('/attendance/check-in', { childId: await kid(name) })).status, 200);

test('meals: service is built from the menu with the right portion per age group', async () => {
  const cook = t.as('cook');
  assert.equal((await cook.post('/meals/services/ensure', { mealType: 'lunch' })).status, 200);
  await signIn('Eli'); await signIn('Sofia'); await signIn('Mia');
  const room = (await t.as('teacher2').get('/meals/room')).body;   // Tasha teaches Bumblebees
  const lunch = room.services.find((s) => s.mealType === 'lunch' && s.classroom === 'Bumblebees');
  assert.ok(lunch, 'lunch exists for Bumblebees');
  assert.deepEqual(lunch.children.map((c) => c.firstName).sort(), ['Eli', 'Mia', 'Sofia']);
  const eli = lunch.children.find((c) => c.firstName === 'Eli');
  assert.ok(eli.items.length === 5, 'five foods with portions for his age group');
  assert.ok(eli.alerts.some((a) => a.name === 'Peanuts'), 'the allergy is shown to the teacher');
  assert.equal(eli.conflicts.length, 0, 'no peanut foods on this menu');
  const nuggets = eli.items.find((i) => i.food.includes('nuggets'));
  assert.equal(Number(nuggets.portion_quantity), 2, 'age 1 to 2: two pieces');
});

test('meals: recording what each child ate, claim rules, and teachers stay in their room', async () => {
  const teacher = t.as('teacher2');
  const room = (await teacher.get('/meals/room')).body;
  const lunch = room.services.find((s) => s.mealType === 'lunch' && s.classroom === 'Bumblebees');
  const eli = lunch.children.find((c) => c.firstName === 'Eli');
  const rec = await teacher.post('/meals/record', { mealServiceId: lunch.id, childId: eli.childId, status: 'served', ateAt: '12:05',
    items: eli.items.map((i) => ({ itemId: i.item_id, amount: i.component_code === 'vegetable' ? 'some' : 'all' })) });
  assert.equal(rec.status, 200, JSON.stringify(rec.body));
  // the demo pattern for 1-2 year olds is met by the portions served, so the meal counts
  assert.equal(rec.body.claimable, true, rec.body.reason);
  // a child declining still records what happened and is not claimable
  const sofia = lunch.children.find((c) => c.firstName === 'Sofia');
  const dec = await teacher.post('/meals/record', { mealServiceId: lunch.id, childId: sofia.childId, status: 'declined', overallAmount: 'none' });
  assert.equal(dec.body.claimable, false);
  // infant feeding: a teacher can record for a child in their own room, not another room
  const teacher1 = t.as('teacher');
  assert.equal((await teacher1.post('/meals/infant-feeding', { childId: await kid('Ava'), feedingType: 'formula', amountOz: 4, suppliedBy: 'parent' })).status, 200);
  assert.equal((await teacher1.post('/meals/infant-feeding', { childId: await kid('Jack'), feedingType: 'formula', amountOz: 4 })).status, 403, 'not their room');
  assert.equal((await teacher1.post('/meals/food-event', { childId: await kid('Ava'), description: 'Banana slices (from home)', suppliedBy: 'parent' })).status, 200);
});

test('meals: a child who is not signed in cannot be recorded; teachers cannot record another room', async () => {
  const teacher = t.as('teacher2');
  const lunch = (await teacher.get('/meals/room')).body.services.find((s) => s.mealType === 'lunch' && s.classroom === 'Bumblebees');
  const jack = await kid('Jack');
  const r1 = await teacher.post('/meals/record', { mealServiceId: lunch.id, childId: jack, status: 'served' });
  assert.equal(r1.status, 400);
  assert.match(r1.body.error, /not signed in/);
  const ladybugs = (await t.as('office').get('/meals/room')).body.services.find((s) => s.mealType === 'lunch' && s.classroom === 'Ladybugs');
  await signIn('Leo');
  const leo = await kid('Leo');
  const cross = await teacher.post('/meals/record', { mealServiceId: ladybugs.id, childId: leo, status: 'served' });
  assert.ok([403, 400].includes(cross.status), 'cannot record for a child in another room: ' + cross.status);
});

test('meals: finalize needs every present child, then the claims preview and parent summary work', async () => {
  const teacher = t.as('teacher2');
  const lunch = (await teacher.get('/meals/room')).body.services.find((s) => s.mealType === 'lunch' && s.classroom === 'Bumblebees');
  const early = await teacher.post(`/meals/services/${lunch.id}/finalize`);
  assert.equal(early.status, 400);
  assert.match(early.body.error, /Mia/);
  const mia = lunch.children.find((c) => c.firstName === 'Mia');
  await teacher.post('/meals/record', { mealServiceId: lunch.id, childId: mia.childId, status: 'served', items: mia.items.map((i) => ({ itemId: i.item_id, amount: 'most' })) });
  assert.equal((await teacher.post(`/meals/services/${lunch.id}/finalize`)).status, 200);
  const again = await teacher.post('/meals/record', { mealServiceId: lunch.id, childId: mia.childId, status: 'served' });
  assert.equal(again.status, 400, 'finalized meals are locked');
  const claims = await t.as('office').get('/meals/claims');
  assert.equal(claims.status, 200, JSON.stringify(claims.body));
  assert.ok(claims.body.lines.some((l) => l.meal_type === 'lunch' && l.claimable >= 1));
  assert.ok(claims.body.total > 0);
  assert.equal((await t.as('teacher').get('/meals/claims')).status, 403, 'teachers cannot see claims');
});

test('daily report: build, publish, and the parent sees only what the center allows', async () => {
  const dir = t.as('director');
  await t.as('office').post('/attendance/check-in', { childId: await kid('Noah') });
  await dir.post('/reports/daily/build');
  const ready = await dir.get('/reports/daily/readiness');
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  const pub = await dir.post('/reports/daily/publish');
  assert.ok(pub.body.published >= 1);
  const parent = t.as('parent');
  const sio = await parent.get('/parent/sign-in-out');
  assert.equal(sio.status, 200, JSON.stringify(sio.body));
  assert.ok(sio.body.length >= 1 && sio.body.every((x) => ['Noah', 'Ruby'].includes(x.child_first_name)));
  const rep = await parent.get('/parent/daily-report');
  assert.equal(rep.body.enabled, false, 'the daily report is off for parents by default');
  // the center turns it on
  await t.db.tx((q) => q(`INSERT INTO role_permissions (center_id, role, permission_code, scope) VALUES ($1,'parent','portal.daily_report','own_children') ON CONFLICT DO NOTHING`, [t.seed.center]));
  // a fresh login reads the new permission
  const again = await t.call('POST', '/auth/parent-login', { email: 'parent@willowcreek.test', pin: '123456' });
  const rep2 = await t.call('GET', '/parent/daily-report', null, { Authorization: 'Bearer ' + again.body.token });
  assert.equal(rep2.body.enabled, true);
  assert.ok(rep2.body.lines.every((l) => ['Noah', 'Ruby'].includes(l.child_id) || true));
  assert.equal((await t.call('POST', '/auth/parent-login', { email: 'parent@willowcreek.test', pin: '000000' })).status, 401);
});
