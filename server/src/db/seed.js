import bcrypt from 'bcryptjs';
import { pinProof, sha256 } from '../lib/ctx.js';

// Demo data for a fictional center. Every name, number, and value here is made up.
// Reference values marked DEMO (meal pattern amounts, reimbursement rates) are placeholders, NOT official figures:
// replace them with the current USDA / New Jersey values before any real use.
export async function seedDemo(db, { pinPepper }) {
  return db.tx(async (q) => {
    const ins = async (table, obj) => {
      const keys = Object.keys(obj);
      const r = await q(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING *`, keys.map((k) => obj[k]));
      return r[0]?.id;
    };
    const one = async (sql, p = []) => (await q(sql, p))[0];

    // ---------- reference data ----------
    for (const [code, label] of [['milk', 'Milk'], ['egg', 'Egg'], ['peanut', 'Peanut'], ['tree_nut', 'Tree nut'], ['soy', 'Soy'], ['wheat', 'Wheat'], ['fish', 'Fish'], ['shellfish', 'Shellfish'], ['sesame', 'Sesame']])
      await q('INSERT INTO allergens (code, label) VALUES ($1,$2) ON CONFLICT DO NOTHING', [code, label]);
    for (const [code, label] of [['milk', 'Fluid milk'], ['vegetable', 'Vegetable'], ['fruit', 'Fruit'], ['grain', 'Grains'], ['meat_alt', 'Meat or meat alternate'], ['breast_milk_formula', 'Breast milk or formula'], ['infant_cereal', 'Infant cereal']])
      await q('INSERT INTO food_components (code, label) VALUES ($1,$2) ON CONFLICT DO NOTHING', [code, label]);
    for (const [id, code, label, min, max] of [[1, 'infant_0_5', 'Infants 0 to 5 months', 0, 5], [2, 'infant_6_11', 'Infants 6 to 11 months', 6, 11], [3, 'age_1_2', 'Children 1 to 2 years', 12, 35], [4, 'age_3_5', 'Children 3 to 5 years', 36, 71], [5, 'age_6_12', 'Children 6 to 12 years', 72, 155]])
      await q('INSERT INTO cacfp_age_groups (id, code, label, min_months, max_months) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [id, code, label, min, max]);

    // ---------- center ----------
    const center = await ins('centers', { name: 'Willow Creek Early Learning', license_number: 'NJ-DEMO-0001', city: 'Trenton', postal_code: '08608', phone: '(555) 010-0000', timezone: 'America/New_York' });
    const C = center;
    await q('UPDATE centers SET licensed_capacity = 64 WHERE id = $1', [C]);
    await q('SELECT seed_access_defaults($1)', [C]);
    await q('SELECT seed_default_supply_items($1)', [C]);
    await q('SELECT seed_default_enrollment_checklist($1)', [C]);
    await q('INSERT INTO time_policies (center_id) VALUES ($1)', [C]);
    await ins('food_program_sites', { center_id: C, agreement_number: 'DEMO-0000', institution_type: 'nonprofit', meal_types_offered: '{breakfast,lunch,pm_snack}' });

    // ---------- classrooms ----------
    const room = {};
    for (const [key, name, color, mn, mx, ratio, cap] of [
      ['ladybugs', 'Ladybugs', '#D6493C', 0, 17, 4, 8], ['bumblebees', 'Bumblebees', '#E0A210', 18, 35, 6, 12],
      ['tadpoles', 'Tadpoles', '#3A9A60', 36, 47, 10, 20], ['butterflies', 'Butterflies', '#7B5CC8', 48, 71, 12, 24]])
      room[key] = await ins('classrooms', { center_id: C, name, color_hex: color, min_age_months: mn, max_age_months: mx, ratio_children_per_staff: ratio, max_group_size: cap });

    // ---------- staff, users, punch credentials ----------
    const staff = {};
    const mkStaff = async (key, first, last, title, roomKey, extra = {}) => {
      staff[key] = await ins('staff', { center_id: C, first_name: first, last_name: last, job_title: title, default_classroom_id: roomKey ? room[roomKey] : null, hired_on: '2023-01-09', email: `${key}@willowcreek.test`, ...extra });
      if (roomKey) await ins('staff_classroom_assignments', { staff_id: staff[key], classroom_id: room[roomKey] });
    };
    await mkStaff('dana', 'Dana', 'Whitfield', 'Director', null, { overtime_eligible: false });
    await mkStaff('olivia', 'Olivia', 'Reed', 'Front office', null);
    await mkStaff('maria', 'Maria', 'Santos', 'Lead teacher', 'ladybugs');
    await mkStaff('kevin', 'Kevin', 'Osei', 'Assistant teacher', 'ladybugs');
    await mkStaff('tasha', 'Tasha', 'Green', 'Lead teacher', 'bumblebees');
    await mkStaff('luis', 'Luis', 'Ortega', 'Assistant teacher', 'bumblebees');
    await mkStaff('hannah', 'Hannah', 'Lee', 'Lead teacher', 'tadpoles');
    await mkStaff('jordan', 'Jordan', 'Blake', 'Lead teacher', 'butterflies');
    await mkStaff('sam', 'Sam', 'Petrov', 'Floater', null);
    await mkStaff('carlos', 'Carlos', 'Vega', 'Cook', null);

    const pw = await bcrypt.hash('demo1234', 8);
    const user = {};
    const mkUser = async (key, email, role, staffKey, guardianId = null) => {
      user[key] = await ins('users', { center_id: C, email, role, staff_id: staffKey ? staff[staffKey] : null, guardian_id: guardianId, password_hash: pw });
    };
    await mkUser('owner', 'owner@willowcreek.test', 'owner', null);
    await mkUser('director', 'director@willowcreek.test', 'director', 'dana');
    await mkUser('office', 'office@willowcreek.test', 'front_office', 'olivia');
    await mkUser('teacher', 'teacher@willowcreek.test', 'teacher', 'maria');
    await mkUser('teacher2', 'teacher2@willowcreek.test', 'teacher', 'tasha');
    await mkUser('cook', 'cook@willowcreek.test', 'cook', 'carlos');

    const staffPin = await bcrypt.hash(pinProof('2468', pinPepper), 8);
    for (const k of Object.keys(staff)) await ins('staff_punch_credentials', { staff_id: staff[k], kind: 'pin', credential_hash: staffPin });

    // certifications
    const certType = {};
    for (const [code, label, months] of [['cpr_first_aid', 'CPR and first aid', 24], ['background_check', 'Background check', 60], ['mandated_reporter', 'Mandated reporter', 24], ['health_screen', 'Health screening', 12]])
      certType[code] = await ins('certification_types', { center_id: C, code, label, valid_months: months });
    const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const certPlan = { maria: [22, 600, 400, 90], kevin: [480, 40, 300, -6], tasha: [260, 700, 220, 150], luis: [330, 800, 120, 240], hannah: [410, 650, 500, 280], jordan: [520, 1200, 610, 120], dana: [310, 900, 140, 200], sam: [365, 500, 180, 100] };
    for (const [k, d] of Object.entries(certPlan))
      ['cpr_first_aid', 'background_check', 'mandated_reporter', 'health_screen'].forEach(async () => {});
    for (const [k, d] of Object.entries(certPlan)) {
      const codes = ['cpr_first_aid', 'background_check', 'mandated_reporter', 'health_screen'];
      for (let i = 0; i < 4; i++) await ins('staff_certifications', { staff_id: staff[k], cert_type_id: certType[codes[i]], expires_on: inDays(d[i]) });
    }

    // biometric consent (demo): two teachers have consented to face verification
    const policyV = await ins('biometric_policy_versions', { center_id: C, version: 1, effective_on: '2026-01-01', summary: 'Face verification is optional. A PIN is always available. Templates are deleted within 30 days of leaving or withdrawing consent.' });
    for (const k of ['maria', 'tasha']) {
      const cid = await ins('biometric_consents', { staff_id: staff[k], policy_version_id: policyV, status: 'granted', method: 'signed_form', recorded_by: user.director });
      await ins('staff_biometric_templates', { staff_id: staff[k], consent_id: cid, vendor: 'mock', template_ref: 'mock:demo-' + k, algorithm_version: 'demo-0' });
    }

    // kiosk device
    await ins('time_devices', { center_id: C, name: 'Front entrance kiosk', location_note: 'By the office', token_hash: sha256('demo-kiosk-token') });
    await ins('time_devices', { center_id: C, name: 'Ladybugs tablet', classroom_id: room.ladybugs, token_hash: sha256('demo-ladybugs-token') });

    // today's staff schedule
    const tz = 'America/New_York';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const dow = (new Date(today + 'T12:00:00').getDay() + 6) % 7 + 1; // 1 = Monday
    await q('UPDATE centers SET days_open = $2 WHERE id = $1', [C, `{1,2,3,4,5,6,7}`]);
    for (const [k, start, end, rk] of [['dana', '07:00', '16:00', null], ['olivia', '07:30', '16:30', null], ['maria', '06:30', '15:00', 'ladybugs'], ['kevin', '08:00', '16:30', 'ladybugs'], ['tasha', '06:30', '15:00', 'bumblebees'], ['luis', '08:00', '16:30', 'bumblebees'], ['hannah', '07:00', '15:30', 'tadpoles'], ['jordan', '07:00', '15:30', 'butterflies'], ['carlos', '06:30', '14:30', null]])
      await ins('staff_shifts', { staff_id: staff[k], classroom_id: rk ? room[rk] : null, work_date: today, starts_at: start, ends_at: end });

    // ---------- families and children ----------
    const g = {}; const child = {};
    const mkGuardian = async (key, first, last, phone, extra = {}) => {
      g[key] = await ins('guardians', { center_id: C, first_name: first, last_name: last, email: `${key}@example.com`, phone_mobile: phone, ...extra });
      await q('INSERT INTO guardian_communication_prefs (guardian_id, voice_consent, sms_consent, consent_captured_at, consent_source) VALUES ($1,true,true,now(),$2)', [g[key], 'enrollment form (demo)']);
    };
    const families = [
      ['bennett', 'Bennett', [['rachel', 'Rachel', 'Mother', '(555) 010-2311'], ['tom', 'Tom', 'Father', '(555) 010-2312']]],
      ['martinez', 'Martinez', [['elena', 'Elena', 'Mother', '(555) 010-2313']]],
      ['chen', 'Chen', [['wei', 'Wei', 'Father', '(555) 010-2314']]],
      ['johnson', 'Johnson', [['danielle', 'Danielle', 'Mother', '(555) 010-2315']]],
      ['okafor', 'Okafor', [['chidi', 'Chidi', 'Father', '(555) 010-2316'], ['ngozi', 'Ngozi', 'Mother', '(555) 010-2317']]],
      ['rossi', 'Rossi', [['marco', 'Marco', 'Father', '(555) 010-2318']]],
      ['nguyen', 'Nguyen', [['linh', 'Linh', 'Mother', '(555) 010-2319']]],
      ['sato', 'Sato', [['kenji', 'Kenji', 'Father', '(555) 010-2320']]],
      ['campbell', 'Campbell', [['jasmine', 'Jasmine', 'Mother', '(555) 010-2321']]]
    ];
    const account = {}; const famGuardians = {};
    for (const [fk, last, gs] of families) {
      account[fk] = await ins('billing_accounts', { center_id: C, family_name: last });
      famGuardians[fk] = [];
      for (const [gk, first, rel, phone] of gs) {
        await mkGuardian(gk, first, last, phone);
        famGuardians[fk].push([gk, rel]);
      }
    }
    // Parent portal login for Rachel Bennett
    await mkUser('parent', 'rachel@example.com', 'parent', null, g.rachel);
    await q('UPDATE users SET email = $1 WHERE id = $2', ['parent@willowcreek.test', user.parent]);

    const ageMonths = (m) => { const d = new Date(); d.setMonth(d.getMonth() - m); d.setDate(Math.max(1, d.getDate() - 3)); return d.toISOString().slice(0, 10); };
    const kids = [
      ['noah', 'Noah', 'bennett', 'ladybugs', 9], ['ruby', 'Ruby', 'bennett', 'tadpoles', 40], ['ava', 'Ava', 'martinez', 'ladybugs', 13],
      ['leo', 'Leo', 'chen', 'ladybugs', 15], ['mia', 'Mia', 'johnson', 'bumblebees', 22], ['grace', 'Grace', 'johnson', 'butterflies', 54],
      ['eli', 'Eli', 'okafor', 'bumblebees', 26], ['amara', 'Amara', 'okafor', 'tadpoles', 44], ['sofia', 'Sofia', 'rossi', 'bumblebees', 30],
      ['jack', 'Jack', 'nguyen', 'bumblebees', 20], ['hana', 'Hana', 'sato', 'tadpoles', 42], ['isla', 'Isla', 'campbell', 'butterflies', 58]
    ];
    const lastOf = Object.fromEntries(families.map((f) => [f[0], f[1]]));
    const start = inDays(-180);
    for (const [k, first, fk, rk, m] of kids) {
      child[k] = await ins('children', { center_id: C, billing_account_id: account[fk], first_name: first, last_name: lastOf[fk], date_of_birth: ageMonths(m), status: 'active', enrolled_on: start });
      await ins('enrollments', { center_id: C, child_id: child[k], status: 'active', start_date: start });
      await ins('child_classroom_assignments', { child_id: child[k], classroom_id: room[rk], valid_during: `[${start},)` });
      await ins('child_schedules', { child_id: child[k], days_of_week: '{1,2,3,4,5,6,7}', valid_during: `[${start},)` });
      famGuardians[fk].forEach(async () => {});
      let first_ = true;
      for (const [gk, rel] of famGuardians[fk]) {
        await q('INSERT INTO child_guardians (child_id, guardian_id, relationship, is_primary, is_billing_responsible) VALUES ($1,$2,$3,$4,$4)', [child[k], g[gk], rel, first_]);
        first_ = false;
      }
      const cat = ['free', 'reduced', 'paid'][kids.findIndex((x) => x[0] === k) % 3];
      await ins('eligibility_determinations', { child_id: child[k], category: cat, method: 'income_application', effective_on: inDays(-90), expires_on: inDays(270) });
    }
    // authorized pick-up people and emergency contacts (with PINs for the kiosk)
    const grandma = await ins('contacts', { center_id: C, first_name: 'Carol', last_name: 'Bennett', phone: '(555) 010-2390' });
    for (const k of ['noah', 'ruby']) {
      await q(`INSERT INTO child_contacts (child_id, contact_id, role, relationship, photo_id_on_file) VALUES ($1,$2,'authorized_pickup','Grandmother',true)`, [child[k], grandma]);
      await q(`INSERT INTO child_contacts (child_id, contact_id, role, relationship) VALUES ($1,$2,'emergency','Grandmother')`, [child[k], grandma]);
    }
    // PINs: everyone's kiosk and portal PIN is 123456 in the demo
    for (const gk of Object.keys(g))
      for (const purpose of ['kiosk', 'portal'])
        await q('SELECT set_family_pin($1,$2,NULL,$3,$4,NULL)', [C, g[gk], purpose, pinProof('123456', pinPepper)]);
    for (const purpose of ['kiosk'])
      await q('SELECT set_family_pin($1,NULL,$2,$3,$4,NULL)', [C, grandma, purpose, pinProof('654321', pinPepper)]);
    await q('UPDATE family_access_credentials SET must_change = false');

    // health alerts
    const alert = (k, kind, name, sev, plan, allergen = null) => ins('child_alerts', { child_id: child[k], kind, name, severity: sev, care_plan: plan, allergen_code: allergen });
    await alert('ava', 'allergy', 'Dairy', 'mild', 'Use the soy formula from her labeled bin.', 'milk');
    await alert('eli', 'allergy', 'Peanuts', 'severe', 'Epinephrine auto-injector is in the Bumblebees cubby. Give it for breathing trouble, then call 911 and a parent.', 'peanut');
    await alert('hana', 'allergy', 'Tree nuts', 'severe', 'Epinephrine auto-injector is in the front office.', 'tree_nut');
    await alert('isla', 'medical', 'Asthma', 'moderate', 'Inhaler is in the first-aid bag. Two puffs when she wheezes, then call a parent.');

    // personal supply profiles
    const itemType = {};
    for (const r of await q('SELECT id, code FROM supply_item_types WHERE center_id = $1', [C])) itemType[r.code] = r.id;
    const profile = async (k, codes, details = {}) => { for (const c of codes) await ins('child_supply_profiles', { child_id: child[k], item_type_id: itemType[c], details: details[c] || null }); };
    await profile('noah', ['diapers', 'wipes', 'bottles', 'formula', 'baby_food'], { diapers: 'size 3', formula: 'sensitive' });
    await profile('ava', ['diapers', 'wipes', 'formula', 'blanket'], { diapers: 'size 4', formula: 'soy' });
    await profile('leo', ['diapers', 'wipes', 'blanket']);
    await profile('mia', ['diapers', 'wipes', 'blanket']);
    await profile('jack', ['diapers', 'wipes', 'blanket']);

    // ---------- alerting policy ----------
    const tpl = {};
    for (const [code, channel, body] of [
      ['missing_sms', 'sms', 'Willow Creek: we have not seen {child_first_name} yet today. Please reply 1 if they are on the way, 2 if they are staying home.'],
      ['missing_voice', 'voice', 'This is Willow Creek Early Learning. We have not seen {child_first_name} yet today. Press 1 if they are on their way, 2 if they are staying home today, or 3 to speak with us now.'],
      ['missing_director', 'in_app', '{child_first_name} has not arrived and the family has not responded. Please follow up.']])
      tpl[code] = await ins('message_templates', { center_id: C, code, channel: channel === 'in_app' ? 'in_app' : channel, body });
    const pol = await ins('alert_policies', { center_id: C, name: 'Default missing-child policy', grace_minutes: 30 });
    for (const [n, wait, ch, target, t] of [[1, 0, 'sms', 'primary_guardian', 'missing_sms'], [2, 10, 'voice', 'primary_guardian', 'missing_voice'], [3, 10, 'voice', 'other_guardians', 'missing_voice'], [4, 10, 'voice', 'emergency_contacts', 'missing_voice'], [5, 5, 'in_app', 'director', 'missing_director']])
      await ins('alert_policy_steps', { policy_id: pol, step_no: n, wait_minutes: wait, channel: ch, target, template_id: tpl[t] });
    await q('INSERT INTO punctuality_policies (center_id) VALUES ($1) ON CONFLICT DO NOTHING', [C]);

    // ---------- food program: vendors, products, certificates ----------
    const vendor = {};
    for (const [k, name, kind] of [['granite', 'Granite State Foods', 'food'], ['fresh', 'Fresh Fields Produce', 'food'], ['bright', 'BrightStart Classroom Supply', 'classroom_supplies'], ['clean', 'CleanCo Janitorial', 'cleaning']])
      vendor[k] = await ins('vendors', { center_id: C, name, vendor_kind: kind, account_number: 'ACCT-' + k.toUpperCase(), approved_on: '2025-06-01' });

    const ingr = {};
    for (const [name, allergens] of [['whole wheat flour', ['wheat']], ['chicken breast', []], ['soybean oil', ['soy']], ['salt', []], ['brown rice', []], ['whole milk', ['milk']], ['green beans', []], ['apples', []], ['yeast', []], ['water', []]]) {
      ingr[name] = await ins('ingredients', { name });
      for (const a of allergens) await q('INSERT INTO ingredient_allergens (ingredient_id, allergen_code) VALUES ($1,$2)', [ingr[name], a]);
    }
    const product = {}; const pversion = {};
    const mkProduct = async (k, vk, sku, name, brand, statement, contains, nutrition, credit, ingredients, allergens) => {
      product[k] = await ins('products', { center_id: C, vendor_id: vendor[vk], vendor_sku: sku, name, brand, manufacturer: brand, status: 'approved' });
      pversion[k] = await ins('product_versions', { product_id: product[k], version_no: 1, effective_from: '2026-01-01', ingredient_statement: statement, allergen_statement: contains, serving_size_desc: nutrition.serving, calories: nutrition.cal, sodium_mg: nutrition.sodium, total_sugars_g: nutrition.sugar, whole_grain_rich: nutrition.wgr ?? null, verified_by: user.director, verified_at: new Date().toISOString() });
      await q('UPDATE products SET current_version_id = $1 WHERE id = $2', [pversion[k], product[k]]);
      let pos = 1;
      for (const name of ingredients) await ins('product_ingredients', { product_version_id: pversion[k], position: pos++, name_as_printed: name, ingredient_id: ingr[name.toLowerCase()] || null });
      for (const [a, decl] of allergens) await q('INSERT INTO product_allergens (product_version_id, allergen_code, declaration) VALUES ($1,$2,$3)', [pversion[k], a, decl]);
      if (credit) await ins('product_crediting', { product_version_id: pversion[k], component_code: credit[0], credited_quantity: credit[1], credited_unit: credit[2], per_serving_desc: credit[3], basis: credit[4] });
    };
    await mkProduct('nuggets', 'granite', 'GS-1001', 'Whole grain chicken nuggets', 'Granite State', 'Chicken breast, whole wheat flour, soybean oil, salt, yeast.', 'Contains: wheat, soy.', { serving: '4 pieces (84 g)', cal: 190, sodium: 340, sugar: 1, wgr: true }, ['meat_alt', 2, 'oz_eq', '4 pieces', 'cn_label'], ['Chicken breast', 'Whole wheat flour', 'Soybean oil', 'Salt', 'Yeast'], [['wheat', 'contains'], ['soy', 'contains']]);
    await mkProduct('rice', 'granite', 'GS-1002', 'Brown rice, parboiled', 'Granite State', 'Brown rice.', 'Contains: none.', { serving: '1/2 cup cooked', cal: 110, sodium: 0, sugar: 0, wgr: true }, ['grain', 1, 'oz_eq', '1/2 cup cooked', 'usda_food_buying_guide'], ['Brown rice'], []);
    await mkProduct('milk', 'fresh', 'FF-2001', 'Whole milk, 8 oz cartons', 'Fresh Fields Dairy', 'Whole milk, vitamin D3.', 'Contains: milk.', { serving: '8 fl oz', cal: 150, sodium: 105, sugar: 12 }, ['milk', 8, 'fl_oz', '1 carton', 'manufacturer_spec'], ['Whole milk'], [['milk', 'contains']]);
    await mkProduct('beans', 'fresh', 'FF-2002', 'Green beans, frozen cut', 'Fresh Fields', 'Green beans.', 'Contains: none.', { serving: '1/2 cup', cal: 20, sodium: 0, sugar: 2 }, ['vegetable', 0.5, 'cup', '1/2 cup', 'usda_food_buying_guide'], ['Green beans'], []);
    await mkProduct('apples', 'fresh', 'FF-2003', 'Apples, fresh', 'Fresh Fields', 'Apples.', 'Contains: none.', { serving: '1 medium', cal: 95, sodium: 2, sugar: 19 }, ['fruit', 0.5, 'cup', '1/2 cup slices', 'usda_food_buying_guide'], ['Apples'], []);

    const doc = async (title, type, title2) => ins('documents', { center_id: C, doc_type: type, title, storage_key: `demo/${title2}.pdf`, uploaded_by: user.director });
    const certs = [
      ['GFSI audit (SQF), Granite State plant', 'gfsi_audit', 'granite', 200, 'SQF-DEMO-77'],
      ['Child Nutrition label, chicken nuggets', 'cn_label', 'granite', 20, 'CN-DEMO-3390'],
      ['Allergen control statement, Granite State', 'allergen_control', 'granite', 320, null],
      ['Food safety inspection, Fresh Fields', 'food_safety_inspection', 'fresh', -10, 'FSI-DEMO-12']
    ];
    for (const [title, type, vk, days, number] of certs) {
      const d = await doc(title, 'vendor_certificate', title.replace(/\W+/g, '-').toLowerCase());
      const certId = await ins('vendor_certificates', { center_id: C, vendor_id: vendor[vk], cert_type: type, title, certificate_number: number, issuing_body: 'Demo Auditor', issued_on: inDays(days - 365), expires_on: inDays(days), document_id: d, status: days < 0 ? 'expired' : 'verified', verified_by: user.director, verified_at: new Date().toISOString() });
      if (vk === 'granite') for (const pk of type === 'cn_label' ? ['nuggets'] : ['nuggets', 'rice'])
        await q('INSERT INTO certificate_products (certificate_id, product_id) VALUES ($1,$2)', [certId, product[pk]]);
    }

    // food items, recipe, portion standards, meal patterns (DEMO amounts)
    const food = {};
    for (const [k, name, comp, pk] of [['nuggets', 'Whole grain chicken nuggets', 'meat_alt', 'nuggets'], ['rice', 'Brown rice', 'grain', 'rice'], ['beans', 'Green beans', 'vegetable', 'beans'], ['apples', 'Apple slices', 'fruit', 'apples'], ['milk', 'Whole milk', 'milk', 'milk']])
      food[k] = await ins('food_items', { center_id: C, name, primary_component: comp, product_id: product[pk] });
    const recipe = await ins('recipes', { center_id: C, name: 'Chicken and rice bowl', category: 'Lunch entree', created_by: user.cook });
    const rv = await ins('recipe_versions', { recipe_id: recipe, version_no: 1, effective_from: '2026-01-01', yield_quantity: 50, yield_unit: 'piece', portions_yielded: 25, portion_size_desc: '3 nuggets and 1/2 cup rice', instructions: 'Bake nuggets at 400F for 12 minutes. Steam rice. Serve together.', approved_by: user.director, approved_at: new Date().toISOString() });
    await q('UPDATE recipes SET current_version_id = $1 WHERE id = $2', [rv, recipe]);
    await ins('recipe_lines', { recipe_version_id: rv, line_no: 1, product_id: product.nuggets, quantity: 75, unit: 'piece', prep_note: 'Frozen' });
    await ins('recipe_lines', { recipe_version_id: rv, line_no: 2, product_id: product.rice, quantity: 12.5, unit: 'cup', prep_note: 'Cooked' });
    await ins('recipe_lines', { recipe_version_id: rv, line_no: 3, ingredient_id: ingr.water, quantity: 8, unit: 'cup', prep_note: 'For steaming' });
    await ins('recipe_credits', { recipe_version_id: rv, component_code: 'meat_alt', credited_quantity: 1.5, credited_unit: 'oz_eq', basis: 'cn_label' });

    const portion = async (fk, age, qty, unit, pieces, comp, cq, cu, min) => ins('portion_standards', { center_id: C, food_item_id: food[fk], age_group_id: age, meal_type: 'lunch', serving_quantity: qty, serving_unit: unit, piece_count: pieces, serving_tool: pieces ? 'count pieces' : 'measuring cup', credited_component: comp, credited_quantity: cq, credited_unit: cu, min_quantity_to_credit: min, effective_from: '2026-01-01', approved_by: user.director });
    for (const age of [3, 4]) {
      await portion('nuggets', age, age === 3 ? 2 : 3, 'piece', age === 3 ? 2 : 3, 'meat_alt', age === 3 ? 1 : 1.5, 'oz_eq', age === 3 ? 2 : 3);
      await portion('rice', age, age === 3 ? 0.25 : 0.25, 'cup', null, 'grain', 0.5, 'oz_eq', 0.25);
      await portion('beans', age, age === 3 ? 0.125 : 0.25, 'cup', null, 'vegetable', age === 3 ? 0.125 : 0.25, 'cup', age === 3 ? 0.125 : 0.25);
      await portion('apples', age, age === 3 ? 0.125 : 0.25, 'cup', null, 'fruit', age === 3 ? 0.125 : 0.25, 'cup', age === 3 ? 0.125 : 0.25);
      await portion('milk', age, age === 3 ? 4 : 6, 'fl_oz', null, 'milk', age === 3 ? 4 : 6, 'fl_oz', age === 3 ? 4 : 6);
    }
    // DEMO pattern amounts only. Replace with the current USDA meal pattern chart.
    for (const [age, comp, min, unit] of [[3, 'milk', 4, 'fl oz'], [3, 'meat_alt', 1, 'oz eq'], [3, 'vegetable', 0.125, 'cup'], [3, 'fruit', 0.125, 'cup'], [3, 'grain', 0.5, 'oz eq'],
      [4, 'milk', 6, 'fl oz'], [4, 'meat_alt', 1.5, 'oz eq'], [4, 'vegetable', 0.25, 'cup'], [4, 'fruit', 0.25, 'cup'], [4, 'grain', 0.5, 'oz eq']])
      await ins('meal_patterns', { meal_type: 'lunch', age_group_id: age, component_code: comp, min_quantity: min, unit, effective_from: '2026-01-01', notes: 'DEMO VALUES ONLY: replace with the current USDA meal pattern' });
    // DEMO reimbursement rates only.
    const fy = new Date().getMonth() >= 6 ? new Date().getFullYear() + 1 : new Date().getFullYear();
    for (const [mt, f, r, p] of [['lunch', 4.0, 3.5, 0.5], ['breakfast', 2.0, 1.75, 0.35], ['pm_snack', 1.1, 0.55, 0.1]])
      for (const [cat, rate] of [['free', f], ['reduced', r], ['paid', p]])
        await ins('reimbursement_rates', { fiscal_year: fy, meal_type: mt, category: cat, rate_dollars: rate, effective_from: inDays(-200) });

    // menu for today
    const monday = new Date(); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const menu = await ins('menus', { center_id: C, name: 'This week (demo)', week_start: monday.toISOString().slice(0, 10), published_at: new Date().toISOString() });
    const mm = await ins('menu_meals', { menu_id: menu, service_date: today, meal_type: 'lunch' });
    for (const [fk, comp] of [['nuggets', 'meat_alt'], ['rice', 'grain'], ['beans', 'vegetable'], ['apples', 'fruit'], ['milk', 'milk']])
      await ins('menu_meal_items', { menu_meal_id: mm, food_item_id: food[fk], component_code: comp });

    // ---------- classroom catalog and purchasing ----------
    const cat = {};
    for (const n of ['Art supplies', 'Cleaning supplies', 'Paper goods', 'Classroom materials']) cat[n] = await ins('catalog_categories', { center_id: C, name: n });
    const item = {};
    for (const [k, name, c, vk, unit, cents, stock] of [
      ['paint', 'Washable paint, 8 colors', 'Art supplies', 'bright', 'set', 1499, true], ['paper', 'Construction paper, 500 sheets', 'Art supplies', 'bright', 'pack', 1199, true],
      ['glue', 'Non-toxic glue sticks, 12', 'Art supplies', 'bright', 'pack', 699, true], ['blocks', 'Wooden building blocks, 100', 'Classroom materials', 'bright', 'set', 3999, false],
      ['towels', 'Paper towels, 12 rolls', 'Paper goods', 'clean', 'case', 2499, true], ['wipes', 'Disinfecting wipes, 6 tubs', 'Cleaning supplies', 'clean', 'pack', 2199, true],
      ['soap', 'Hand soap refill, 1 gal', 'Cleaning supplies', 'clean', 'each', 1299, true], ['tissue', 'Facial tissue, 24 boxes', 'Paper goods', 'clean', 'case', 3299, true]])
      item[k] = await ins('catalog_items', { center_id: C, category_id: cat[c], name, vendor_id: vendor[vk], unit_label: unit, est_unit_cents: cents, track_stock: stock });
    for (const [k, n, lvl] of [['paper', 8, 4], ['glue', 3, 6], ['towels', 2, 3], ['soap', 5, 2]])
      await q('INSERT INTO stockroom_movements (center_id, catalog_item_id, delta, reason) VALUES ($1,$2,$3,$4)', [C, item[k], n, 'received']);
    await q('UPDATE stockroom_stock SET reorder_level = 4, reorder_quantity = 12 WHERE catalog_item_id = $1', [item.glue]);
    await q('INSERT INTO purchasing_policies (center_id, auto_approve_under_cents, owner_also_over_cents) VALUES ($1, 0, 50000)', [C]);
    await ins('purchase_needs', { center_id: C, catalog_item_id: item.towels, category_id: cat['Paper goods'], quantity: 4, unit_label: 'case', estimated_unit_cents: 2499, priority: 'normal', reason: 'Monthly restock', source: 'office', entered_by: user.office });
    await ins('purchase_needs', { center_id: C, custom_name: 'Floor cleaner concentrate, 2 gal', category_id: cat['Cleaning supplies'], quantity: 2, unit_label: 'each', estimated_unit_cents: 3200, priority: 'soon', reason: 'Kitchen and bathrooms', source: 'office', entered_by: user.office, preferred_vendor_id: vendor.clean });

    // ---------- enrollment pipeline ----------
    await ins('waitlist_priority_rules', { center_id: C, code: 'current_sibling', label: 'Sibling of a current child', points: 10 });
    const leads = [
      ['Priya Nair', 'phone', 'Zoe', '2026-04-02', 'inquiry', null], ['Ben Foster', 'web_form', 'Owen', ageMonths(20), 'tour_scheduled', null],
      ['Amy Lopez', 'referral', 'Mateo', ageMonths(30), 'toured', null], ['Sara Kim', 'web_form', 'Lily', ageMonths(11), 'applied', null],
      ['Dev Patel', 'phone', 'Arjun', ageMonths(5), 'waitlisted', null], ['Jill Ward', 'walk_in', 'Nora', ageMonths(37), 'waitlisted', null]
    ];
    for (const [parent, channel, cn, dob, stage] of leads) {
      const inq = await ins('inquiries', { center_id: C, channel, assigned_to: user.office, notes: 'Demo lead' });
      const [f, l] = parent.split(' ');
      await ins('prospect_guardians', { inquiry_id: inq, first_name: f, last_name: l, phone: '(555) 010-9' + Math.floor(100 + Math.random() * 899), email: `${f.toLowerCase()}@example.com`, is_primary: true, consent_calls: true, consent_sms: true, consent_captured_at: new Date().toISOString(), consent_source: 'web form (demo)' });
      const appId = await ins('enrollment_applications', { center_id: C, inquiry_id: inq, child_first_name: cn, child_last_name: l, date_of_birth: dob, desired_start_date: inDays(45), stage: 'inquiry', assigned_to: user.office });
      if (stage !== 'inquiry') {
        const path = { tour_scheduled: ['tour_scheduled'], toured: ['tour_scheduled', 'toured'], applied: ['applied'], waitlisted: ['waitlisted'] }[stage];
        for (const s of path) await q('UPDATE enrollment_applications SET stage = $1 WHERE id = $2', [s, appId]);
      }
      if (stage === 'tour_scheduled') await ins('tours', { inquiry_id: inq, scheduled_at: new Date(Date.now() + 2 * 864e5).toISOString(), conducted_by: user.director });
    }

    // ---------- a few staff punches so hours reports have data ----------
    // (earlier days this week; today is left for the live demo)
    for (let back = 1; back <= 3; back++) {
      const day = new Date(); day.setDate(day.getDate() - back);
      if ([0, 6].includes(day.getDay())) continue;
      for (const k of ['maria', 'tasha', 'hannah', 'jordan']) {
        const inAt = new Date(day); inAt.setHours(11, 30 + (k === 'tasha' ? 12 : 0), 0, 0);   // UTC hours; roughly 6:30 to 7:00 local
        const outAt = new Date(day); outAt.setHours(20, 0, 0, 0);
        await q('INSERT INTO time_entries (staff_id, classroom_id, clock_in_at, clock_out_at, source) VALUES ($1,$2,$3,$4,$5)', [staff[k], null, inAt.toISOString(), outAt.toISOString(), 'manual']);
      }
    }

    return { center: C, room, staff, user, child, guardians: g, vendor, product, food };
  });
}
