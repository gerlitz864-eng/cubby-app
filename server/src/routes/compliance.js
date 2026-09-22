import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { h, need, HttpError } from '../lib/ctx.js';
import { crud, pick } from '../lib/resource.js';

// Vendors, food products (exact ingredient lists), manufacturer certificates, recipes, and portion sizes.
export default function register(r, ctx) {
  const { asUser, asSystem, config } = ctx;
  const FOOD = ['food_products.manage'];

  crud(r, ctx, { path: '/vendors', table: 'vendors', read: ['food_products.manage', 'purchasing.view', 'meals.claims'], write: ['food_products.manage', 'purchasing.view'],
    cols: ['name', 'vendor_kind', 'account_number', 'contact_name', 'phone', 'email', 'address_line1', 'city', 'state', 'postal_code', 'is_active', 'approved_on', 'notes'], orderBy: 'name' });
  crud(r, ctx, { path: '/catalog-items', table: 'catalog_items', read: ['orders.review', 'purchasing.view'], write: ['orders.review', 'purchasing.view'],
    cols: ['category_id', 'name', 'description', 'sku', 'vendor_id', 'vendor_url', 'unit_label', 'est_unit_cents', 'track_stock', 'is_active'], orderBy: 'name' });
  crud(r, ctx, { path: '/food-items', table: 'food_items', read: ['food_products.manage', 'recipes.manage', 'meals.claims'], write: ['recipes.manage', 'food_products.manage'],
    cols: ['name', 'primary_component', 'product_id', 'recipe_id', 'whole_grain_rich', 'is_active'], orderBy: 'name' });

  const dayOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

  // ---------- documents (files live on disk here; use object storage in production) ----------
  async function saveDocument(q, req, { title, docType, filename, base64, expiresOn, productId }) {
    if (!title || !base64) throw new HttpError(400, 'A title and a file are required');
    const buf = Buffer.from(String(base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buf.length > 5 * 1024 * 1024) throw new HttpError(400, 'Files can be up to 5 MB');
    fs.mkdirSync(config.uploadDir, { recursive: true });
    const key = `${req.user.centerId}/${crypto.randomUUID()}${path.extname(filename || '').slice(0, 8)}`;
    fs.mkdirSync(path.dirname(path.join(config.uploadDir, key)), { recursive: true });
    fs.writeFileSync(path.join(config.uploadDir, key), buf);
    return (await q(`INSERT INTO documents (center_id, doc_type, title, storage_key, uploaded_by, expires_on) VALUES ($1,$2::document_type,$3,$4,$5,$6) RETURNING id`,
      [req.user.centerId, docType || 'other', title, key, req.user.id, expiresOn || null]))[0].id;
  }

  r.post('/documents', need(...FOOD, 'children.manage', 'purchasing.view'), h(async (req) => asUser(req.user, async (q) => ({ id: await saveDocument(q, req, req.body || {}) }))));
  r.get('/documents/:id/download', need(...FOOD, 'children.manage', 'purchasing.view', 'meals.claims'), h(async (req, res) => {
    const d = (await asUser(req.user, (q) => q('SELECT title, storage_key FROM documents WHERE id = $1', [req.params.id])))[0];
    if (!d) throw new HttpError(404, 'Not found');
    const file = path.join(config.uploadDir, d.storage_key);
    if (!fs.existsSync(file)) throw new HttpError(404, 'This is a demo record with no file attached');
    res.download(file, d.title);
  }));

  // ---------- products ----------
  r.get('/products', need(...FOOD, 'meals.claims', 'recipes.manage'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT p.id, p.name, p.brand, p.manufacturer, p.vendor_sku, p.status, v.name AS vendor,
            pv.ingredient_statement, pv.allergen_statement, pv.version_no, pv.effective_from,
            (SELECT coalesce(json_agg(DISTINCT pa.allergen_code), '[]') FROM product_allergens pa WHERE pa.product_version_id = p.current_version_id AND pa.declaration = 'contains') AS allergens,
            (SELECT json_build_object('component', pc.component_code, 'quantity', pc.credited_quantity, 'unit', pc.credited_unit, 'per', pc.per_serving_desc, 'basis', pc.basis) FROM product_crediting pc WHERE pc.product_version_id = p.current_version_id LIMIT 1) AS crediting,
            (SELECT count(*)::int FROM certificate_products cp JOIN vendor_certificates vc ON vc.id = cp.certificate_id WHERE cp.product_id = p.id AND vc.status = 'verified' AND (vc.expires_on IS NULL OR vc.expires_on >= current_date)) AS valid_certificates,
            (SELECT count(*)::int FROM certificate_products cp JOIN vendor_certificates vc ON vc.id = cp.certificate_id WHERE cp.product_id = p.id AND (vc.status = 'expired' OR vc.expires_on < current_date)) AS lapsed_certificates
       FROM products p JOIN vendors v ON v.id = p.vendor_id LEFT JOIN product_versions pv ON pv.id = p.current_version_id ORDER BY p.name`))));

  r.get('/products/:id', need(...FOOD, 'meals.claims', 'recipes.manage'), h(async (req) => asUser(req.user, async (q) => {
    const p = (await q('SELECT p.*, v.name AS vendor FROM products p JOIN vendors v ON v.id = p.vendor_id WHERE p.id = $1', [req.params.id]))[0];
    if (!p) throw new HttpError(404, 'Not found');
    const versions = await q('SELECT * FROM product_versions WHERE product_id = $1 ORDER BY version_no DESC', [p.id]);
    const ingredients = await q('SELECT product_version_id, position, name_as_printed FROM product_ingredients WHERE product_version_id = ANY($1::uuid[]) ORDER BY product_version_id, position', [versions.map((v) => v.id)]);
    const allergens = await q('SELECT product_version_id, allergen_code, declaration FROM product_allergens WHERE product_version_id = ANY($1::uuid[])', [versions.map((v) => v.id)]);
    const crediting = await q('SELECT * FROM product_crediting WHERE product_version_id = ANY($1::uuid[])', [versions.map((v) => v.id)]);
    const certificates = await q(`SELECT vc.id, vc.title, vc.cert_type, vc.certificate_number, vc.issuing_body, vc.expires_on, vc.status, vc.document_id FROM certificate_products cp JOIN vendor_certificates vc ON vc.id = cp.certificate_id WHERE cp.product_id = $1 ORDER BY vc.expires_on`, [p.id]);
    const deliveries = await q(`SELECT d.received_at, dl.lot_code, dl.best_by, dl.quantity, dl.unit, dl.temperature_f, dl.accepted FROM delivery_lines dl JOIN deliveries d ON d.id = dl.delivery_id JOIN product_versions pv ON pv.id = dl.product_version_id WHERE pv.product_id = $1 ORDER BY d.received_at DESC LIMIT 20`, [p.id]);
    return { product: p, versions, ingredients, allergens, crediting, certificates, deliveries };
  })));

  // Split an ingredient statement into its ordered parts, keeping "(sub, ingredients)" together.
  const splitIngredients = (text) => {
    const out = []; let depth = 0, cur = '';
    for (const ch of String(text).replace(/\.$/, '')) {
      if (ch === '(') depth++; if (ch === ')') depth = Math.max(0, depth - 1);
      if (ch === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };

  async function addVersion(q, req, productId, b) {
    if (!b.ingredientStatement) throw new HttpError(400, 'Paste the ingredient list exactly as printed on the label');
    const n = (await q('SELECT coalesce(max(version_no), 0) + 1 AS n FROM product_versions WHERE product_id = $1', [productId]))[0].n;
    await q(`UPDATE product_versions SET effective_to = current_date WHERE product_id = $1 AND effective_to IS NULL`, [productId]);
    const pv = (await q(`INSERT INTO product_versions (product_id, version_no, effective_from, ingredient_statement, allergen_statement, serving_size_desc, calories, sodium_mg, total_sugars_g, added_sugars_g, saturated_fat_g, fiber_g, protein_g, whole_grain_rich, label_document_id, verified_by, verified_at)
                          VALUES ($1,$2,current_date,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now()) RETURNING id`,
      [productId, n, b.ingredientStatement, b.allergenStatement || null, b.servingSize || null, b.calories ?? null, b.sodiumMg ?? null, b.sugarsG ?? null, b.addedSugarsG ?? null, b.satFatG ?? null, b.fiberG ?? null, b.proteinG ?? null, b.wholeGrainRich ?? null, b.labelDocumentId || null, req.user.id]))[0].id;
    let pos = 1;
    for (const name of splitIngredients(b.ingredientStatement)) {
      const base = name.replace(/\(.*\)/, '').trim().toLowerCase();
      const ing = (await q('SELECT id FROM ingredients WHERE lower(name) = $1', [base]))[0] || (await q('INSERT INTO ingredients (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id', [base]))[0];
      await q('INSERT INTO product_ingredients (product_version_id, position, name_as_printed, ingredient_id) VALUES ($1,$2,$3,$4)', [pv, pos++, name, ing?.id || null]);
    }
    for (const a of b.allergens || []) await q('INSERT INTO product_allergens (product_version_id, allergen_code, declaration) VALUES ($1,$2,$3::declaration_type) ON CONFLICT DO NOTHING', [pv, a.code, a.declaration || 'contains']);
    if (b.crediting?.component) await q(`INSERT INTO product_crediting (product_version_id, component_code, credited_quantity, credited_unit, per_serving_desc, basis, verified_by, verified_at) VALUES ($1,$2,$3,$4::measure_unit,$5,$6::crediting_basis,$7, now())`,
      [pv, b.crediting.component, b.crediting.quantity, b.crediting.unit, b.crediting.per || null, b.crediting.basis || 'manufacturer_spec', req.user.id]);
    await q('UPDATE products SET current_version_id = $2 WHERE id = $1', [productId, pv]);
    return { versionId: pv, versionNo: n };
  }

  r.post('/products', need(...FOOD), h(async (req) => {
    const b = req.body || {};
    if (!b.name || !b.vendorId) throw new HttpError(400, 'A product name and vendor are required');
    return asUser(req.user, async (q) => {
      const p = (await q(`INSERT INTO products (center_id, vendor_id, vendor_sku, name, brand, manufacturer, gtin, category, pack_size, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'approved') RETURNING id`,
        [req.user.centerId, b.vendorId, b.vendorSku || b.name, b.name, b.brand || null, b.manufacturer || null, b.gtin || null, b.category || null, b.packSize || null]))[0];
      return { id: p.id, ...(await addVersion(q, req, p.id, b)) };
    });
  }));

  // A reformulated product gets a new version. Old versions keep their dates so any past meal can be traced.
  r.post('/products/:id/versions', need(...FOOD), h(async (req) => {
    const res = await asUser(req.user, (q) => addVersion(q, req, req.params.id, req.body || {}));
    const { notifyRoles } = await import('../lib/notifications.js');
    await asSystem((q) => notifyRoles(q, req.user.centerId, ['cook', 'director'], 'product_changed', 'A product was reformulated', 'Review recipes and menus that use it. Allergens may have changed.'));
    return res;
  }));

  // ---------- certificates ----------
  r.get('/certificates', need(...FOOD, 'meals.claims'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT vc.id, vc.title, vc.cert_type, vc.certificate_number, vc.issuing_body, vc.issued_on, vc.expires_on, vc.status, vc.document_id, v.name AS vendor,
            (vc.expires_on - current_date) AS days_left,
            (SELECT coalesce(json_agg(p.name ORDER BY p.name), '[]') FROM certificate_products cp JOIN products p ON p.id = cp.product_id WHERE cp.certificate_id = vc.id) AS products
       FROM vendor_certificates vc LEFT JOIN vendors v ON v.id = vc.vendor_id ORDER BY vc.expires_on NULLS LAST`))));

  r.post('/certificates', need(...FOOD), h(async (req) => {
    const b = req.body || {};
    if (!b.title || !b.certType || !(b.vendorId || b.manufacturerName)) throw new HttpError(400, 'A title, type, and vendor are required');
    return asUser(req.user, async (q) => {
      const docId = b.documentId || await saveDocument(q, req, { title: b.title, docType: 'vendor_certificate', filename: b.filename, base64: b.base64, expiresOn: b.expiresOn });
      const c = (await q(`INSERT INTO vendor_certificates (center_id, vendor_id, manufacturer_name, cert_type, title, certificate_number, issuing_body, issued_on, expires_on, document_id, status)
                          VALUES ($1,$2,$3,$4::certificate_type,$5,$6,$7,$8,$9,$10,'pending') RETURNING id`,
        [req.user.centerId, b.vendorId || null, b.manufacturerName || null, b.certType, b.title, b.certificateNumber || null, b.issuingBody || null, b.issuedOn || null, b.expiresOn || null, docId]))[0];
      for (const pid of b.productIds || []) await q('INSERT INTO certificate_products (certificate_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [c.id, pid]);
      return c;
    });
  }));

  r.post('/certificates/:id/verify', need(...FOOD), h(async (req) => asUser(req.user, async (q) => {
    const decision = req.body?.decision === 'reject' ? 'rejected' : 'verified';
    return (await q(`UPDATE vendor_certificates SET status = $2::verification_status, verified_by = $3, verified_at = now() WHERE id = $1 RETURNING id, status`, [req.params.id, decision, req.user.id]))[0];
  })));

  r.get('/compliance/summary', need(...FOOD, 'meals.claims'), h(async (req) => asUser(req.user, async (q) => ({
    missingDocs: await q('SELECT * FROM v_products_missing_documents ORDER BY name'),
    expiring: await q(`SELECT vc.id, vc.title, vc.expires_on, (vc.expires_on - current_date) AS days_left FROM vendor_certificates vc WHERE vc.expires_on <= current_date + 60 ORDER BY vc.expires_on`)
  }))));

  // ---------- recipes and portions ----------
  r.get('/recipes', need('recipes.manage', 'meals.claims', 'food_products.manage'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT rc.id, rc.name, rc.category, rv.id AS version_id, rv.version_no, rv.portions_yielded, rv.portion_size_desc, rv.yield_quantity, rv.yield_unit,
            (SELECT coalesce(json_agg(DISTINCT ra.allergen_code), '[]') FROM v_recipe_allergens ra WHERE ra.recipe_version_id = rv.id) AS allergens
       FROM recipes rc LEFT JOIN recipe_versions rv ON rv.id = rc.current_version_id WHERE rc.is_active ORDER BY rc.name`))));

  r.get('/recipes/:id', need('recipes.manage', 'meals.claims', 'food_products.manage'), h(async (req) => asUser(req.user, async (q) => {
    const rc = (await q('SELECT rc.*, rv.version_no, rv.portions_yielded, rv.portion_size_desc, rv.instructions, rv.yield_quantity, rv.yield_unit FROM recipes rc JOIN recipe_versions rv ON rv.id = rc.current_version_id WHERE rc.id = $1', [req.params.id]))[0];
    if (!rc) throw new HttpError(404, 'Not found');
    const portions = Number(req.query.portions) > 0 ? Number(req.query.portions) : Number(rc.portions_yielded);
    const lines = await q('SELECT line_no, item, quantity, unit, prep_note FROM scale_recipe($1, $2) ORDER BY line_no', [rc.current_version_id, portions]);
    const credits = await q('SELECT component_code, credited_quantity, credited_unit, basis FROM recipe_credits WHERE recipe_version_id = $1', [rc.current_version_id]);
    const allergens = await q('SELECT DISTINCT allergen_code FROM v_recipe_allergens WHERE recipe_version_id = $1', [rc.current_version_id]);
    return { recipe: rc, portions, lines, credits, allergens: allergens.map((a) => a.allergen_code) };
  })));

  r.post('/recipes', need('recipes.manage'), h(async (req) => {
    const b = req.body || {};
    if (!b.name || !b.portionsYielded || !(b.lines || []).length) throw new HttpError(400, 'A name, how many portions it makes, and ingredient lines are required');
    return asUser(req.user, async (q) => {
      const rc = (await q('INSERT INTO recipes (center_id, name, category, created_by) VALUES ($1,$2,$3,$4) RETURNING id', [req.user.centerId, b.name, b.category || null, req.user.id]))[0];
      const rv = (await q(`INSERT INTO recipe_versions (recipe_id, version_no, effective_from, yield_quantity, yield_unit, portions_yielded, portion_size_desc, instructions, approved_by, approved_at)
                           VALUES ($1,1,current_date,$2,$3::measure_unit,$4,$5,$6,$7, now()) RETURNING id`,
        [rc.id, b.yieldQuantity || b.portionsYielded, b.yieldUnit || 'piece', b.portionsYielded, b.portionSizeDesc || null, b.instructions || null, req.user.id]))[0];
      let n = 1;
      for (const l of b.lines) await q(`INSERT INTO recipe_lines (recipe_version_id, line_no, product_id, ingredient_id, quantity, unit, prep_note) VALUES ($1,$2,$3,$4,$5,$6::measure_unit,$7)`,
        [rv.id, n++, l.productId || null, l.ingredientId || null, l.quantity, l.unit, l.prepNote || null]);
      for (const c of b.credits || []) await q(`INSERT INTO recipe_credits (recipe_version_id, component_code, credited_quantity, credited_unit, basis) VALUES ($1,$2,$3,$4::measure_unit,$5::crediting_basis)`, [rv.id, c.component, c.quantity, c.unit, c.basis || 'calculated']);
      await q('UPDATE recipes SET current_version_id = $2 WHERE id = $1', [rc.id, rv.id]);
      return { id: rc.id };
    });
  }));

  r.get('/ingredients', need('recipes.manage', 'food_products.manage'), h(async (req) => asUser(req.user, (q) => q('SELECT id, name FROM ingredients ORDER BY name'))));

  // Exact portion sizes: pieces or ounces per child, by food and age group.
  r.get('/portions', need('recipes.manage', 'meals.claims', 'food_products.manage'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT ps.id, fi.name AS food, ag.label AS age_group, ps.age_group_id, ps.meal_type, ps.serving_quantity, ps.serving_unit, ps.piece_count, ps.serving_tool,
            ps.credited_component, ps.credited_quantity, ps.credited_unit, ps.min_quantity_to_credit, ps.effective_from
       FROM portion_standards ps JOIN food_items fi ON fi.id = ps.food_item_id JOIN cacfp_age_groups ag ON ag.id = ps.age_group_id
      WHERE ps.effective_to IS NULL ORDER BY fi.name, ps.age_group_id`))));

  r.post('/portions', need('recipes.manage'), h(async (req) => {
    const b = req.body || {};
    return asUser(req.user, async (q) => (await q(
      `INSERT INTO portion_standards (center_id, food_item_id, age_group_id, meal_type, serving_quantity, serving_unit, piece_count, serving_tool, credited_component, credited_quantity, credited_unit, min_quantity_to_credit, effective_from, approved_by)
       VALUES ($1,$2,$3,$4::meal_type,$5,$6::measure_unit,$7,$8,$9,$10,$11::measure_unit,$12,current_date,$13) RETURNING id`,
      [req.user.centerId, b.foodItemId, b.ageGroupId, b.mealType || null, b.servingQuantity, b.servingUnit, b.pieceCount || null, b.servingTool || null, b.creditedComponent, b.creditedQuantity || null, b.creditedUnit || null, b.minQuantityToCredit || null, req.user.id]))[0]);
  }));

  r.get('/meta/food', need('recipes.manage', 'food_products.manage', 'meals.claims'), h(async (req) => asUser(req.user, async (q) => ({
    ageGroups: await q('SELECT id, label FROM cacfp_age_groups ORDER BY id'),
    components: await q('SELECT code, label FROM food_components ORDER BY label'),
    allergens: await q('SELECT code, label FROM allergens ORDER BY label'),
    vendors: await q(`SELECT id, name FROM vendors WHERE vendor_kind = 'food' AND is_active ORDER BY name`),
    products: await q('SELECT id, name FROM products ORDER BY name'),
    foods: await q('SELECT id, name FROM food_items WHERE is_active ORDER BY name')
  }))));

  // Menus: what is served on a day. The meal service for each room is built from this.
  r.get('/menus/day', need('recipes.manage', 'meals.claims', 'food_products.manage'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT mm.id, mm.service_date, mm.meal_type, coalesce(json_agg(json_build_object('food', fi.name, 'component', mi.component_code)) FILTER (WHERE mi.id IS NOT NULL), '[]') AS items
       FROM menu_meals mm LEFT JOIN menu_meal_items mi ON mi.menu_meal_id = mm.id LEFT JOIN food_items fi ON fi.id = mi.food_item_id
      WHERE mm.service_date >= current_date - 1 AND mm.service_date <= current_date + 14 GROUP BY mm.id ORDER BY mm.service_date, mm.meal_type`))));

  r.post('/menus/day', need('recipes.manage'), h(async (req) => {
    const { date, mealType, items = [] } = req.body || {};
    if (!date || !mealType || !items.length) throw new HttpError(400, 'A date, meal, and foods are required');
    return asUser(req.user, async (q) => {
      const monday = (await q(`SELECT ($1::date - (extract(isodow FROM $1::date)::int - 1))::date AS d`, [date]))[0].d;
      const menu = (await q(`INSERT INTO menus (center_id, name, week_start, published_at) VALUES ($1,$2,$3::date, now()) ON CONFLICT (center_id, week_start) DO UPDATE SET published_at = coalesce(menus.published_at, now()) RETURNING id`,
        [req.user.centerId, `Week of ${dayOf(monday)}`, monday]))[0];
      const mm = (await q(`INSERT INTO menu_meals (menu_id, service_date, meal_type) VALUES ($1,$2::date,$3::meal_type) ON CONFLICT (menu_id, service_date, meal_type) DO UPDATE SET meal_type = EXCLUDED.meal_type RETURNING id`, [menu.id, date, mealType]))[0];
      await q('DELETE FROM menu_meal_items WHERE menu_meal_id = $1', [mm.id]);
      for (const it of items) await q('INSERT INTO menu_meal_items (menu_meal_id, food_item_id, component_code) VALUES ($1,$2,$3)', [mm.id, it.foodItemId, it.component]);
      return { id: mm.id };
    });
  }));
}
