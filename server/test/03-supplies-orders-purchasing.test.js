import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

let t;
test.before(async () => { t = await boot(); });
test.after(async () => { await t.close(); });

const kidByName = async (name) => (await t.db.tx((q) => q(`SELECT id FROM children WHERE first_name = $1`, [name])))[0].id;

test('supply quick-tap: age rule, one flag per item, family and office are told', async () => {
  const teacher = t.as('teacher');
  const room = await teacher.get('/supplies/room');
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const ava = room.body.find((c) => c.first_name === 'Ava');
  assert.ok(ava.items.some((i) => i.code === 'blanket'), 'a 13-month-old can have a blanket item');
  // a blanket for a baby under 12 months is hidden and refused
  const noahId = await kidByName('Noah');
  await t.db.tx((q) => q(`INSERT INTO child_supply_profiles (child_id, item_type_id) SELECT $1, id FROM supply_item_types WHERE code = 'blanket'`, [noahId]));
  const room2 = (await teacher.get('/supplies/room')).body;
  assert.ok(!room2.find((c) => c.first_name === 'Noah').items.some((i) => i.code === 'blanket'), 'hidden for a 9-month-old');
  const blanketType = (await t.db.tx((q) => q(`SELECT id FROM supply_item_types WHERE code = 'blanket'`)))[0].id;
  const refused = await teacher.post('/supplies/flag', { childId: noahId, itemTypeId: blanketType });
  assert.equal(refused.status, 400, 'the database refuses a blanket flag for an infant');

  const diapers = ava.items.find((i) => i.code === 'diapers');
  const f1 = await teacher.post('/supplies/flag', { childId: ava.child_id, itemTypeId: diapers.item_type_id, level: 'low' });
  assert.equal(f1.status, 200, JSON.stringify(f1.body));
  assert.equal(f1.body.created, true);
  const f2 = await teacher.post('/supplies/flag', { childId: ava.child_id, itemTypeId: diapers.item_type_id, level: 'out' });
  assert.equal(f2.body.id, f1.body.id, 'a second tap raises the same flag');
  assert.equal(f2.body.level, 'out');
  const flagsForAva = await t.db.tx((q) => q(`SELECT count(*)::int AS n FROM supply_flags WHERE child_id = $1 AND status IN ('open','acknowledged')`, [ava.child_id]));
  assert.equal(flagsForAva[0].n, 1);
  const queue = (await t.as('office').get('/supplies/queue')).body;
  const item = queue.find((x) => x.first_name === 'Ava');
  assert.ok(item && item.level === 'out' && item.urgency === 'urgent');
  const outbox = (await t.as('director').get('/dev/outbox')).body;
  assert.ok(outbox.some((m) => m.kind === 'sms' && /Ava/.test(m.body)), 'the parent got a text');
  assert.ok((await t.as('office').get('/notifications')).body.items.some((n) => n.kind === 'supply_flag'), 'the office was notified');
  assert.equal((await t.as('office').post(`/supplies/flags/${f1.body.id}/ack`)).status, 200);
  assert.equal((await t.as('office').post(`/supplies/flags/${f1.body.id}/resolve`, { resolution: 'parent_delivered' })).status, 200);
  // undo window
  const f3 = await teacher.post('/supplies/flag', { childId: ava.child_id, itemTypeId: diapers.item_type_id });
  assert.equal((await teacher.post(`/supplies/flags/${f3.body.id}/undo`)).status, 200);
  // teachers cannot flag children outside their room
  const jack = await kidByName('Jack');
  const jackType = (await t.db.tx((q) => q(`SELECT item_type_id AS id FROM child_supply_profiles WHERE child_id = $1 LIMIT 1`, [jack])))[0].id;
  assert.equal((await teacher.post('/supplies/flag', { childId: jack, itemTypeId: jackType })).status, 403);
});

test('classroom ordering: request, custom item, decisions, purchase order, tracking to the teacher', async () => {
  const teacher = t.as('teacher'); const office = t.as('office');
  const cat = (await teacher.get('/orders/catalog')).body;
  const paint = cat.find((c) => c.name.startsWith('Washable paint'));
  assert.equal(cat.find((c) => c.name.startsWith('Wooden')).on_hand, null, 'items that are not stocked show no count');
  assert.equal(paint.on_hand, 0, 'stocked but none on the shelf');
  const paper = cat.find((c) => c.name.startsWith('Construction paper'));
  assert.equal(paper.on_hand, 8, 'stockroom count is shown');
  const room = (await t.db.tx((q) => q(`SELECT id FROM classrooms WHERE name = 'Ladybugs'`)))[0].id;
  const req = await teacher.post('/orders/requests', { classroomId: room, priority: 'soon', lines: [
    { catalogItemId: paint.id, quantity: 2 },
    { customName: 'Sensory bin scoops', quantity: 4, estimatedUnitCents: 350, reason: 'Sensory play' },
    { customName: 'Yogurt tubes', quantity: 10, isFood: true }] });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const mine = (await teacher.get('/orders/mine')).body;
  assert.equal(mine.length, 3);
  assert.equal(mine.find((m) => m.item === 'Yogurt tubes').status, 'on_hold', 'food is held for the kitchen');
  const queue = (await office.get('/orders/queue')).body;
  assert.ok(queue.some((q) => q.item === 'Sensory bin scoops' && q.is_custom));
  const scoops = mine.find((m) => m.item === 'Sensory bin scoops');
  const paintLine = mine.find((m) => m.item.startsWith('Washable paint'));
  assert.equal((await office.post(`/orders/lines/${scoops.line_id}/decide`, { decision: 'denied' })).status, 400, 'a denial needs a reason');
  assert.equal((await office.post(`/orders/lines/${scoops.line_id}/decide`, { decision: 'denied', note: 'We already have some in the closet' })).status, 200);
  assert.equal((await office.post(`/orders/lines/${paintLine.line_id}/decide`, { decision: 'approved' })).status, 200);
  const vendorId = (await t.db.tx((q) => q(`SELECT id FROM vendors WHERE name LIKE 'BrightStart%'`)))[0].id;
  const po = await office.post('/pos', { vendorId, lineIds: [paintLine.line_id] });
  assert.equal(po.status, 200, JSON.stringify(po.body));
  for (const status of ['ordered', 'shipped', 'delivered']) {
    const r = await office.post(`/pos/${po.body.id}/status`, { status, carrier: 'UPS', trackingNumber: '1Z999' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const st = (await teacher.get('/orders/mine')).body.find((m) => m.line_id === paintLine.line_id).status;
    assert.equal(st, status === 'delivered' ? 'received' : status, 'the teacher sees each step');
  }
  assert.equal((await teacher.post(`/orders/lines/${paintLine.line_id}/confirm`)).status, 200);
  const denied = (await teacher.get('/orders/mine')).body.find((m) => m.line_id === scoops.line_id);
  assert.equal(denied.status, 'denied');
  assert.match(denied.decision_note, /closet/);
  assert.ok((await teacher.get('/notifications')).body.items.some((n) => n.kind === 'order_denied'), 'the teacher is told about the denial');
  // stockroom: take from the shelf
  assert.equal((await teacher.post('/orders/stockroom/take', { catalogItemId: paper.id, quantity: 3, classroomId: room })).body.onHand, 5);
  // teachers cannot approve
  assert.equal((await teacher.get('/orders/queue')).status, 403);
});

test('purchasing master list: director approval, no self-approval, two approvals over the limit', async () => {
  const office = t.as('office'); const dir = t.as('director'); const owner = t.as('owner');
  const meta = (await office.get('/purchasing/meta')).body;
  const towels = meta.catalog.find((c) => c.name.startsWith('Paper towels'));
  const n1 = await office.post('/purchasing/needs', { catalog_item_id: towels.id, quantity: 4, estimated_unit_cents: 2499, category_id: towels.category_id, priority: 'normal' });
  assert.equal(n1.status, 200, JSON.stringify(n1.body));
  const submitted = await office.post('/purchasing/submit', { needIds: [n1.body.id] });
  assert.equal(submitted.body.results[0].status, 'pending_approval');
  assert.equal((await office.post(`/purchasing/needs/${n1.body.id}/decide`, { decision: 'approved' })).status, 403, 'the office cannot approve purchases');
  const review = (await dir.get('/purchasing/review')).body;
  assert.ok(review.some((x) => x.need_id === n1.body.id));
  assert.equal((await dir.post(`/purchasing/needs/${n1.body.id}/decide`, { decision: 'denied' })).status, 400, 'a denial needs a reason');
  const ok = await dir.post(`/purchasing/needs/${n1.body.id}/decide`, { decision: 'approved' });
  assert.equal(ok.body.status, 'approved');
  // the director cannot approve what the director entered
  const n2 = await dir.post('/purchasing/needs', { custom_name: 'Playground mulch', quantity: 2, estimated_unit_cents: 4000 });
  await dir.post('/purchasing/submit', { needIds: [n2.body.id] });
  const self = await dir.post(`/purchasing/needs/${n2.body.id}/decide`, { decision: 'approved' });
  assert.equal(self.status, 400, 'no self-approval');
  assert.match(self.body.error, /entered/);
  // over the owner limit: needs the director and the owner, two different people
  const big = await office.post('/purchasing/needs', { catalog_item_id: towels.id, quantity: 30, estimated_unit_cents: 2499, category_id: towels.category_id });
  await office.post('/purchasing/submit', { needIds: [big.body.id] });
  const first = await dir.post(`/purchasing/needs/${big.body.id}/decide`, { decision: 'approved' });
  assert.equal(first.body.status, 'pending_approval', 'still waiting for the owner');
  const second = await owner.post(`/purchasing/needs/${big.body.id}/decide`, { decision: 'approved' });
  assert.equal(second.body.status, 'approved');
  // buy it: purchase order moves the item through ordered, shipped, received
  const toOrder = (await office.get('/purchasing/to-order')).body;
  assert.ok(toOrder.items.length >= 2);
  const vendorId = toOrder.items.find((i) => i.id === n1.body.id).vendor_id;
  const po = await office.post('/pos', { vendorId, needIds: [n1.body.id] });
  assert.equal(po.status, 200, JSON.stringify(po.body));
  for (const status of ['ordered', 'shipped', 'delivered']) assert.equal((await office.post(`/pos/${po.body.id}/status`, { status })).status, 200);
  const all = (await office.get('/purchasing/all')).body.find((x) => x.id === n1.body.id);
  assert.equal(all.status, 'received');
  assert.equal((await t.as('teacher').get('/purchasing/list')).status, 403);
});
