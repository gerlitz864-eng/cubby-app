import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';

let t;
test.before(async () => { t = await boot(); });
test.after(async () => { await t.close(); });

test('vendor products keep exact ingredient lists, versions, allergens, and certificates', async () => {
  const cook = t.as('cook');
  const meta = (await cook.get('/meta/food')).body;
  assert.ok(meta.vendors.length >= 2);
  const list = (await cook.get('/products')).body;
  const nuggets = list.find((p) => p.name.startsWith('Whole grain chicken'));
  assert.match(nuggets.ingredient_statement, /Chicken breast, whole wheat flour/);
  assert.deepEqual(nuggets.allergens.sort(), ['soy', 'wheat']);
  assert.equal(nuggets.valid_certificates, 3, 'GFSI, allergen control, and CN label all cover it');
  // reformulation adds a version and keeps the old one
  const detail0 = (await cook.get(`/products/${nuggets.id}`)).body;
  assert.equal(detail0.versions.length, 1);
  const v2 = await cook.post(`/products/${nuggets.id}/versions`, { ingredientStatement: 'Chicken breast, whole wheat flour, soybean oil, salt, yeast, sesame seeds.', allergens: [{ code: 'wheat' }, { code: 'soy' }, { code: 'sesame' }], crediting: { component: 'meat_alt', quantity: 2, unit: 'oz_eq', basis: 'cn_label' } });
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  const detail = (await cook.get(`/products/${nuggets.id}`)).body;
  assert.equal(detail.versions.length, 2);
  assert.equal(detail.versions.find((v) => v.version_no === 1).effective_to !== null, true, 'the old version is closed, not deleted');
  assert.ok(detail.ingredients.filter((i) => i.product_version_id === v2.body.versionId).length === 6, 'six parsed ingredients');
  // a new product from scratch
  const vendorId = meta.vendors[0].id;
  const created = await cook.post('/products', { name: 'Peanut butter cups', vendorId, ingredientStatement: 'Milk chocolate (sugar, cocoa butter, milk), peanuts, salt.', allergens: [{ code: 'peanut' }, { code: 'milk' }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal((await t.as('teacher').get('/products')).status, 403, 'teachers cannot see the product database');
});

test('certificates: upload, verify, and expiry shows in the summary', async () => {
  const cook = t.as('cook');
  const vendors = (await cook.get('/meta/food')).body;
  const png = Buffer.from('demo certificate').toString('base64');
  const c = await cook.post('/certificates', { title: 'Organic certificate (demo)', certType: 'organic', vendorId: vendors.vendors[0].id, expiresOn: '2027-01-01', filename: 'organic.pdf', base64: png });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await cook.post(`/certificates/${c.body.id}/verify`, {})).body.status, 'verified');
  const all = (await cook.get('/certificates')).body;
  assert.ok(all.find((x) => x.id === c.body.id));
  const summary = (await cook.get('/compliance/summary')).body;
  assert.ok(summary.expiring.length >= 2, 'the expiring CN label and the expired inspection are flagged');
});

test('recipes scale exactly and allergens roll up from products', async () => {
  const cook = t.as('cook');
  const recipes = (await cook.get('/recipes')).body;
  const rc = recipes.find((x) => x.name === 'Chicken and rice bowl');
  assert.deepEqual(rc.allergens.sort(), ['sesame', 'soy', 'wheat'], 'the earlier reformulation (sesame added) flows through to the recipe');
  const base = (await cook.get(`/recipes/${rc.id}`)).body;
  const nug = base.lines.find((l) => l.item.includes('nuggets'));
  assert.equal(Number(nug.quantity), 75, 'base batch: 75 pieces for 25 portions');
  const scaled = (await cook.get(`/recipes/${rc.id}?portions=40`)).body;
  assert.equal(Number(scaled.lines.find((l) => l.item.includes('nuggets')).quantity), 120, '40 portions: 120 pieces');
  assert.equal(Number(scaled.lines.find((l) => l.item.includes('Brown rice')).quantity), 20);
  const portions = (await cook.get('/portions')).body;
  const n3 = portions.find((p) => p.food.includes('nuggets') && p.age_group_id === 4);
  assert.equal(n3.piece_count, 3, 'children 3 to 5 get three pieces');
});

test('admin: users, PIN rules, permissions matrix, biometric consent, devices', async () => {
  const dir = t.as('director');
  assert.equal((await t.as('office').get('/admin/users')).status, 403);
  const users = (await dir.get('/admin/users')).body;
  assert.ok(users.length >= 7);
  assert.equal((await dir.post('/admin/users', { email: 'sub@willowcreek.test', role: 'teacher', password: 'short' })).status, 400);
  assert.equal((await dir.post('/admin/users', { email: 'sub@willowcreek.test', role: 'teacher', password: 'a-good-password' })).status, 200);
  const pins = (await dir.get('/admin/pins')).body;
  const guardianId = pins[0].guardian_id;
  assert.equal((await dir.post('/admin/pins', { guardianId, purpose: 'kiosk', pin: '111111' })).status, 400, 'no repeated digits');
  assert.equal((await dir.post('/admin/pins', { guardianId, purpose: 'kiosk', pin: '123456' })).status, 400, 'no simple sequences');
  assert.equal((await dir.post('/admin/pins', { guardianId, purpose: 'kiosk', pin: '482915' })).status, 200);
  // permissions matrix: the owner's are fixed, others can be changed
  assert.equal((await dir.put('/admin/permissions', { role: 'owner', code: 'meals.view', scope: null })).status, 400);
  assert.equal((await dir.put('/admin/permissions', { role: 'teacher', code: 'meals.view', scope: 'own_classroom' })).status, 200);
  // face verification: needs consent first, then enroll, then withdraw deletes
  const staff = (await dir.get('/admin/staff')).body;
  const kevin = staff.find((s) => s.first_name === 'Kevin');
  assert.equal((await dir.post(`/admin/staff/${kevin.id}/biometric/enroll`, { imageBase64: 'x' })).status, 400, 'no consent, no template');
  assert.equal((await dir.post(`/admin/staff/${kevin.id}/biometric/consent`, { status: 'granted' })).status, 200);
  assert.equal((await dir.post(`/admin/staff/${kevin.id}/biometric/enroll`, { imageBase64: 'x' })).status, 200);
  assert.equal((await t.kiosk().get('/kiosk/staff')).body.find((s) => s.first_name === 'Kevin').face_enabled, true);
  assert.equal((await dir.post(`/admin/staff/${kevin.id}/biometric/consent`, { status: 'withdrawn' })).status, 200);
  assert.equal((await t.kiosk().get('/kiosk/staff')).body.find((s) => s.first_name === 'Kevin').face_enabled, false, 'withdrawing consent switches face off at once');
  await dir.post('/jobs/run');
  const after = (await dir.get('/admin/staff')).body.find((s) => s.first_name === 'Kevin');
  assert.equal(after.has_template, false, 'the deletion job removed the template');
  // devices: token shown once, works, and the hash is not readable
  const dev = await dir.post('/admin/devices', { name: 'Back door kiosk' });
  assert.equal(dev.status, 200);
  assert.equal((await t.kiosk(dev.body.token).get('/kiosk/info')).status, 200);
  const list = (await dir.get('/admin/devices')).body;
  assert.ok(!('token_hash' in list[0]));
  const audit = await t.as('owner').get('/admin/audit');
  assert.equal(audit.status, 200);
  const settings = await dir.get('/admin/settings');
  assert.equal(settings.body.punctuality_policies.child_grace_minutes, 10);
  assert.equal((await dir.put('/admin/settings', { table: 'punctuality_policies', values: { child_grace_minutes: 15 } })).status, 200);
});
