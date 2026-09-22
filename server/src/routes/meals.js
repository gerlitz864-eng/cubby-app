import { h, need, HttpError } from '../lib/ctx.js';
import { centerInfo } from '../lib/notifications.js';
import { ensureMealServices, buildDailyReports } from '../jobs/index.js';

const norm = (u) => String(u || '').toLowerCase().replace(/[\s_]/g, '');

// Decide whether one child's meal counts for the state claim. Reimbursement depends on the meal SERVED meeting the pattern
// (right components, at least the required amounts) for a child who was present. How much the child ate does not change it.
export async function evaluateClaim(q, { centerId, service, childId, ageGroupId, date }) {
  const patterns = await q(`SELECT component_code, min_quantity, unit FROM meal_patterns
                             WHERE meal_type = $1::meal_type AND age_group_id = $2 AND effective_from <= $3::date AND (effective_to IS NULL OR effective_to >= $3::date)`, [service.meal_type, ageGroupId, date]);
  if (!patterns.length) return { claimable: false, reason: 'No meal pattern on file for this meal and age group' };
  const items = await q(`SELECT msi.component_code, msi.portion_quantity, msi.portion_unit, ps.credited_component, ps.credited_quantity, ps.credited_unit::text AS credited_unit
                           FROM meal_service_items msi LEFT JOIN portion_standards ps ON ps.id = msi.portion_standard_id
                          WHERE msi.meal_service_id = $1 AND msi.age_group_id = $2`, [service.id, ageGroupId]);
  const missing = [];
  for (const p of patterns) {
    let have = 0;
    for (const it of items) {
      if (it.credited_component === p.component_code && it.credited_quantity != null && norm(it.credited_unit) === norm(p.unit)) have += Number(it.credited_quantity);
      else if (it.component_code === p.component_code && norm(it.portion_unit) === norm(p.unit)) have += Number(it.portion_quantity);
    }
    if (have + 1e-9 < Number(p.min_quantity)) missing.push(`${p.component_code.replace('_', ' ')} (need ${p.min_quantity} ${p.unit}, served ${have})`);
  }
  if (missing.length) return { claimable: false, reason: 'Missing or short: ' + missing.join(', ') };
  const today = await q(`SELECT ms.meal_type FROM child_meal_records r JOIN meal_services ms ON ms.id = r.meal_service_id
                          WHERE r.child_id = $1 AND ms.service_date = $2::date AND r.is_claimable AND r.meal_service_id <> $3`, [childId, date, service.id]);
  const meals = today.filter((x) => ['breakfast', 'lunch', 'supper'].includes(x.meal_type)).length + (['breakfast', 'lunch', 'supper'].includes(service.meal_type) ? 1 : 0);
  const total = today.length + 1;
  if (meals > 2 || total > 3) return { claimable: false, reason: 'Over the daily limit (two meals and one snack, or one meal and two snacks)' };
  return { claimable: true, reason: null };
}

export default function register(r, ctx) {
  const { asUser, asSystem } = ctx;

  r.post('/meals/services/ensure', need('meals.claims', 'food_products.manage'), h(async (req) => asSystem(async (q) => {
    const c = await centerInfo(q, req.user.centerId);
    return { created: await ensureMealServices(q, c, req.body?.mealType || 'lunch') };
  })));

  // The meal screen: today's meals, who is here to be fed, the portion for each age group, allergy warnings, and what is logged so far.
  r.get('/meals/room', need('meals.view'), h(async (req) => {
    const scope = req.user.perms.get('meals.view');
    const c = await asSystem((q) => centerInfo(q, req.user.centerId));
    const rooms = await asSystem((q) => q('SELECT id, name FROM classrooms WHERE center_id = $1', [req.user.centerId]));
    const base = await asUser(req.user, async (q) => {
      const services = await q(`SELECT id, meal_type, status, classroom_id FROM meal_services WHERE service_date = $1::date ORDER BY meal_type, classroom_id`, [c.today]);
      const items = scope === 'own_classroom'
        ? await q('SELECT meal_service_id, item_id, food, component_code, age_group_id, portion_quantity, portion_unit FROM v_teacher_meal_service_items')
        : await q(`SELECT msi.meal_service_id, msi.id AS item_id, fi.name AS food, msi.component_code, msi.age_group_id, msi.portion_quantity, msi.portion_unit, msi.pieces_served
                     FROM meal_service_items msi JOIN food_items fi ON fi.id = msi.food_item_id JOIN meal_services ms ON ms.id = msi.meal_service_id WHERE ms.service_date = $1::date`, [c.today]);
      const roster = scope === 'own_classroom'
        ? await q('SELECT child_id, first_name, last_name, classroom_id, checked_in_at, alerts FROM v_teacher_meal_roster ORDER BY first_name')
        : await q(`SELECT ch.id AS child_id, ch.first_name, ch.last_name, ar.classroom_id, ar.checked_in_at,
                          (SELECT coalesce(jsonb_agg(jsonb_build_object('name', ca.name, 'kind', ca.kind, 'severity', ca.severity, 'plan', ca.care_plan)), '[]'::jsonb) FROM child_alerts ca WHERE ca.child_id = ch.id AND ca.is_active) AS alerts
                     FROM attendance_records ar JOIN children ch ON ch.id = ar.child_id
                    WHERE ar.service_date = $1::date AND ar.status = 'present' AND ar.checked_out_at IS NULL ORDER BY ch.first_name`, [c.today]);
      const records = await q(`SELECT r.id, r.meal_service_id, r.child_id, r.status, r.overall_amount_eaten, r.is_claimable, r.non_claim_reason, r.ate_at,
                                      (SELECT coalesce(json_agg(json_build_object('itemId', i.meal_service_item_id, 'amount', i.amount_eaten)), '[]'::json) FROM child_meal_items i WHERE i.child_meal_record_id = r.id) AS items
                                 FROM child_meal_records r JOIN meal_services ms ON ms.id = r.meal_service_id WHERE ms.service_date = $1::date`, [c.today]);
      return { services, items, roster, records };
    });
    // Safety information about the (already access-limited) children and foods is looked up by the server.
    const extra = await asSystem(async (q) => {
      const kidIds = base.roster.map((x) => x.child_id);
      const ageGroups = kidIds.length ? await q(`SELECT id AS child_id, cacfp_age_group_on(id, $2::date) AS age_group_id FROM children WHERE id = ANY($1::uuid[])`, [kidIds, c.today]) : [];
      const allergies = kidIds.length ? await q(`SELECT child_id, allergen_code FROM child_alerts WHERE child_id = ANY($1::uuid[]) AND is_active AND allergen_code IS NOT NULL`, [kidIds]) : [];
      const svcIds = base.services.map((s) => s.id);
      const foodAllergens = svcIds.length ? await q(`
        SELECT msi.id AS item_id, coalesce(array_agg(DISTINCT a.code) FILTER (WHERE a.code IS NOT NULL), '{}') AS allergens
          FROM meal_service_items msi JOIN food_items fi ON fi.id = msi.food_item_id
          LEFT JOIN LATERAL (
            SELECT pa.allergen_code AS code FROM products p JOIN v_product_allergens pa ON pa.product_version_id = p.current_version_id AND pa.source IN ('contains','ingredient','may_contain') WHERE p.id = fi.product_id
            UNION SELECT ra.allergen_code FROM recipes rc JOIN v_recipe_allergens ra ON ra.recipe_version_id = rc.current_version_id WHERE rc.id = fi.recipe_id) a ON true
         WHERE msi.meal_service_id = ANY($1::uuid[]) GROUP BY msi.id`, [svcIds]) : [];
      return { ageGroups, allergies, foodAllergens };
    });
    return {
      date: c.today,
      services: base.services.map((s) => {
        const sItems = base.items.filter((i) => i.meal_service_id === s.id).map((i) => ({ ...i, allergens: extra.foodAllergens.find((f) => f.item_id === i.item_id)?.allergens || [] }));
        const children = base.roster.filter((k) => k.classroom_id === s.classroom_id).map((k) => {
          const ag = extra.ageGroups.find((a) => a.child_id === k.child_id)?.age_group_id;
          const mine = extra.allergies.filter((a) => a.child_id === k.child_id).map((a) => a.allergen_code);
          return {
            childId: k.child_id, firstName: k.first_name, lastName: k.last_name, alerts: k.alerts, ageGroupId: ag,
            items: sItems.filter((i) => i.age_group_id === ag),
            conflicts: sItems.filter((i) => i.age_group_id === ag && i.allergens.some((a) => mine.includes(a))).map((i) => i.food),
            record: base.records.find((rc) => rc.child_id === k.child_id && rc.meal_service_id === s.id) || null
          };
        });
        return { id: s.id, mealType: s.meal_type, status: s.status, classroomId: s.classroom_id, classroom: rooms.find((x) => x.id === s.classroom_id)?.name, children };
      })
    };
  }));

  // Record what one child ate: when, which foods, how much. The server checks the meal against the state pattern.
  r.post('/meals/record', need('meals.record'), h(async (req) => {
    const b = req.body || {};
    if (!['served', 'declined', 'not_present'].includes(b.status || 'served')) throw new HttpError(400, 'Choose served, declined, or not present');
    const status = b.status || 'served';
    const c = await asSystem((q) => centerInfo(q, req.user.centerId));
    const svc = (await asSystem((q) => q('SELECT id, meal_type, status, classroom_id FROM meal_services WHERE id = $1', [b.mealServiceId])))[0];
    if (!svc) throw new HttpError(404, 'That meal is not set up yet');
    if (svc.status === 'finalized') throw new HttpError(400, 'This meal was finalized. Ask the director to reopen it.');
    const ctxInfo = await asSystem(async (q) => {
      const att = (await q(`SELECT id FROM attendance_records WHERE child_id = $1 AND service_date = $2::date AND status = 'present' AND checked_in_at IS NOT NULL`, [b.childId, c.today]))[0];
      const ag = (await q('SELECT cacfp_age_group_on($1, $2::date) AS g, eligibility_on($1, $2::date) AS elig', [b.childId, c.today]))[0];
      const ate = b.ateAt && /^\d{1,2}:\d{2}$/.test(b.ateAt)
        ? (await q(`SELECT (($1::date + $2::time) AT TIME ZONE $3)::timestamptz AS t`, [c.today, b.ateAt, c.timezone]))[0].t : (b.ateAt ? new Date(b.ateAt) : new Date());
      return { att, ageGroupId: ag.g, elig: ag.elig, ate };
    });
    if (!ctxInfo.att && status !== 'not_present') throw new HttpError(400, 'That child is not signed in.');
    if (!ctxInfo.ageGroupId) throw new HttpError(400, 'No age group covers this child. Check their birth date.');

    let claim = { claimable: false, reason: 'Not served' };
    if (status === 'served') {
      claim = await asSystem((q) => evaluateClaim(q, { centerId: req.user.centerId, service: svc, childId: b.childId, ageGroupId: ctxInfo.ageGroupId, date: c.today }));
      if (!ctxInfo.elig) claim = { claimable: false, reason: 'No meal program eligibility form on file' };
    } else claim.reason = status === 'declined' ? 'Child declined the meal' : 'Child was not present';

    const recId = await asUser(req.user, async (q) => (await q(
      `INSERT INTO child_meal_records (id, meal_service_id, child_id, attendance_record_id, age_group_id, eligibility_category, status, overall_amount_eaten, is_claimable, non_claim_reason, recorded_by, ate_at, notes)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5::eligibility_category,$6::child_meal_status,$7::amount_eaten,$8,$9,$10,$11,$12)
       ON CONFLICT (meal_service_id, child_id) DO UPDATE SET status = EXCLUDED.status, overall_amount_eaten = EXCLUDED.overall_amount_eaten, is_claimable = EXCLUDED.is_claimable,
              non_claim_reason = EXCLUDED.non_claim_reason, ate_at = EXCLUDED.ate_at, recorded_by = EXCLUDED.recorded_by, notes = EXCLUDED.notes, age_group_id = EXCLUDED.age_group_id
       RETURNING id`,
      [b.mealServiceId, b.childId, ctxInfo.att?.id || null, ctxInfo.ageGroupId, ctxInfo.elig || 'paid', status, b.overallAmount || (status === 'served' ? 'all' : 'none'),
        claim.claimable, claim.reason, req.user.id, ctxInfo.ate, b.notes || null]))[0].id);

    const warnings = await asSystem(async (q) => {
      await q('DELETE FROM child_meal_items WHERE child_meal_record_id = $1', [recId]);
      const warn = [];
      const mine = (await q('SELECT allergen_code FROM child_alerts WHERE child_id = $1 AND is_active AND allergen_code IS NOT NULL', [b.childId])).map((x) => x.allergen_code);
      for (const it of b.items || []) {
        const msi = (await q(`SELECT msi.id, msi.food_item_id, msi.component_code, fi.name, fi.product_id, fi.recipe_id FROM meal_service_items msi JOIN food_items fi ON fi.id = msi.food_item_id WHERE msi.id = $1 AND msi.meal_service_id = $2`, [it.itemId, b.mealServiceId]))[0];
        if (!msi) continue;
        await q(`INSERT INTO child_meal_items (child_meal_record_id, meal_service_item_id, food_item_id, component_code, amount_eaten) VALUES ($1,$2,$3,$4,$5::amount_eaten)`, [recId, msi.id, msi.food_item_id, msi.component_code, it.amount || 'all']);
        if (it.amount !== 'none' && mine.length) {
          const al = await q(`SELECT DISTINCT a.code FROM (SELECT pa.allergen_code AS code FROM products p JOIN v_product_allergens pa ON pa.product_version_id = p.current_version_id WHERE p.id = $1
                              UNION SELECT ra.allergen_code FROM recipes rc JOIN v_recipe_allergens ra ON ra.recipe_version_id = rc.current_version_id WHERE rc.id = $2) a`, [msi.product_id, msi.recipe_id]);
          if (al.some((x) => mine.includes(x.code))) warn.push(`${msi.name} contains an allergen for this child`);
        }
      }
      return warn;
    });
    return { id: recId, claimable: claim.claimable, reason: claim.reason, warnings };
  }));

  r.post('/meals/infant-feeding', need('meals.record'), h(async (req) => {
    const b = req.body || {};
    return asUser(req.user, async (q) => (await q(
      `INSERT INTO infant_feedings (id, center_id, child_id, fed_at, feeding_type, amount_oz, food_item_id, supplied_by, fed_by_staff, notes)
       VALUES (gen_random_uuid(),$1,$2,coalesce($3::timestamptz, now()),$4::feeding_type,$5,$6,$7::supplied_by,$8,$9) RETURNING id`,
      [req.user.centerId, b.childId, b.fedAt || null, b.feedingType || 'formula', b.amountOz || null, b.foodItemId || null, b.suppliedBy || 'parent', req.user.staffId, b.notes || null]))[0]);
  }));

  r.post('/meals/food-event', need('meals.record'), h(async (req) => {
    const b = req.body || {};
    if (!b.description) throw new HttpError(400, 'Say what the child had');
    return asUser(req.user, async (q) => (await q(
      `INSERT INTO child_food_events (id, center_id, child_id, ate_at, description, amount_eaten, supplied_by, recorded_by, notes)
       VALUES (gen_random_uuid(),$1,$2,coalesce($3::timestamptz, now()),$4,$5::amount_eaten,$6::supplied_by,$7,$8) RETURNING id`,
      [req.user.centerId, b.childId, b.ateAt || null, b.description, b.amount || 'all', b.suppliedBy || 'center', req.user.staffId, b.notes || null]))[0]);
  }));

  // Finalize a meal: every child who was here has a record.
  r.post('/meals/services/:id/finalize', need('meals.record'), h(async (req) => {
    const c = await asSystem((q) => centerInfo(q, req.user.centerId));
    const missing = await asSystem((q) => q(
      `SELECT ch.first_name FROM attendance_records ar JOIN children ch ON ch.id = ar.child_id JOIN meal_services ms ON ms.id = $1
        WHERE ar.classroom_id = ms.classroom_id AND ar.service_date = $2::date AND ar.status = 'present'
          AND NOT EXISTS (SELECT 1 FROM child_meal_records r WHERE r.meal_service_id = ms.id AND r.child_id = ar.child_id)`, [req.params.id, c.today]));
    if (missing.length) throw new HttpError(400, 'Still to record: ' + missing.map((m) => m.first_name).join(', '));
    return asUser(req.user, async (q) => {
      const row = (await q(`UPDATE meal_services SET status = 'finalized', finalized_at = now(), finalized_by = $2, served_at = coalesce(served_at, now()) WHERE id = $1 AND status = 'open' RETURNING id`, [req.params.id, req.user.id]))[0];
      if (!row) throw new HttpError(400, 'Already finalized');
      return { ok: true };
    });
  }));

  r.post('/meals/services/:id/reopen', need('meals.claims'), h(async (req) => asSystem(async (q) => {
    if (!req.body?.reason) throw new HttpError(400, 'A reason is required to reopen a finalized meal');
    await q(`INSERT INTO audit_log (center_id, user_id, action, table_name, record_id, reason) VALUES ($1,$2,'reopen','meal_services',$3,$4)`, [req.user.centerId, req.user.id, req.params.id, req.body.reason]);
    await q(`UPDATE meal_services SET status = 'open', finalized_at = NULL, finalized_by = NULL WHERE id = $1`, [req.params.id]);
    return { ok: true };
  })));

  // State food program: counts by meal and category for a month, an estimate using the rates on file, and what needs attention.
  r.get('/meals/claims', need('meals.claims'), h(async (req) => asUser(req.user, async (q) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : (await q(`SELECT to_char(current_date, 'YYYY-MM') AS m`))[0].m;
    const start = month + '-01';
    const fy = (await q(`SELECT CASE WHEN extract(month FROM $1::date) >= 7 THEN extract(year FROM $1::date)::int + 1 ELSE extract(year FROM $1::date)::int END AS fy`, [start]))[0].fy;
    const counts = await q(`SELECT ms.meal_type, r.eligibility_category AS category, count(*) FILTER (WHERE r.is_claimable)::int AS claimable, count(*)::int AS records
                              FROM child_meal_records r JOIN meal_services ms ON ms.id = r.meal_service_id
                             WHERE ms.service_date >= $1::date AND ms.service_date < ($1::date + interval '1 month') GROUP BY 1,2 ORDER BY 1,2`, [start]);
    const rates = await q('SELECT meal_type, category, rate_dollars FROM reimbursement_rates WHERE fiscal_year = $1', [fy]);
    const lines = counts.map((x) => {
      const rate = Number(rates.find((y) => y.meal_type === x.meal_type && y.category === x.category)?.rate_dollars || 0);
      return { ...x, rate, amount: Math.round(x.claimable * rate * 100) / 100 };
    });
    const issues = await q(`SELECT coalesce(r.non_claim_reason, 'Unknown') AS reason, count(*)::int AS n FROM child_meal_records r JOIN meal_services ms ON ms.id = r.meal_service_id
                             WHERE ms.service_date >= $1::date AND ms.service_date < ($1::date + interval '1 month') AND NOT r.is_claimable AND r.status = 'served' GROUP BY 1 ORDER BY 2 DESC`, [start]);
    const days = await q(`SELECT ms.service_date, count(*) FILTER (WHERE r.is_claimable)::int AS claimable, count(*)::int AS records, bool_and(ms.status = 'finalized') AS all_finalized
                            FROM child_meal_records r JOIN meal_services ms ON ms.id = r.meal_service_id WHERE ms.service_date >= $1::date AND ms.service_date < ($1::date + interval '1 month') GROUP BY 1 ORDER BY 1`, [start]);
    const enrolled = await q(`SELECT eligibility_on(ch.id, current_date) AS category, count(*)::int AS n FROM children ch WHERE ch.status = 'active' GROUP BY 1`);
    const total = lines.reduce((a, x) => a + x.amount, 0);
    return { month, fiscalYear: fy, lines, total: Math.round(total * 100) / 100, issues, days, enrolled, note: 'Rates and meal pattern amounts in this demo are placeholders. Replace them with current official values.' };
  })));

  // ---------- daily parent report ----------
  r.get('/reports/daily/readiness', need('daily_report.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT rd.child_id, ch.first_name, ch.last_name, rd.meals_while_present, rd.meals_logged, rd.meals_missing, rd.report_status, rd.ready_at
       FROM v_daily_report_readiness rd JOIN children ch ON ch.id = rd.child_id WHERE rd.service_date = current_date ORDER BY ch.first_name`))));

  r.post('/reports/daily/build', need('daily_report.publish'), h(async (req) => asSystem(async (q) => ({ built: await buildDailyReports(q, await centerInfo(q, req.user.centerId)) }))));

  r.post('/reports/daily/publish', need('daily_report.publish'), h(async (req) => asUser(req.user, async (q) => {
    const rows = await q(`SELECT id FROM daily_reports WHERE report_date = current_date AND status = 'draft'`);
    for (const x of rows) { await q('UPDATE daily_reports SET ready_at = now() WHERE id = $1', [x.id]); await q('SELECT publish_daily_report($1,$2)', [x.id, req.user.id]); }
    return { published: rows.length };
  })));

  r.get('/reports/daily/preview/:childId', need('daily_report.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT l.occurred_at, l.category, l.title, l.detail, l.amount_eaten FROM daily_reports dr JOIN daily_report_lines l ON l.report_id = dr.id AND l.version = dr.version
      WHERE dr.child_id = $1 AND dr.report_date = current_date ORDER BY l.occurred_at`, [req.params.childId]))));
}
