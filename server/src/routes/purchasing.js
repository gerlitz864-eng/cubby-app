import { h, need, HttpError } from '../lib/ctx.js';
import { pick } from '../lib/resource.js';
import { notifyRoles, notifyUser } from '../lib/notifications.js';

// The office's master purchasing list: everything the facility needs to buy, reviewed and approved by the director.
export default function register(r, ctx) {
  const { asUser, asSystem } = ctx;
  const NEED_COLS = ['catalog_item_id', 'custom_name', 'custom_description', 'vendor_url', 'category_id', 'quantity', 'unit_label', 'estimated_unit_cents', 'preferred_vendor_id', 'needed_by', 'priority', 'reason'];

  r.get('/purchasing/list', need('purchasing.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT * FROM v_master_purchase_list ORDER BY (priority = 'urgent') DESC, entered_at DESC`))));

  r.get('/purchasing/all', need('purchasing.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT n.id, coalesce(ci.name, n.custom_name) AS item, n.status, n.source, n.quantity, n.estimated_unit_cents, n.decision_note, n.entered_at
       FROM purchase_needs n LEFT JOIN catalog_items ci ON ci.id = n.catalog_item_id ORDER BY n.entered_at DESC LIMIT 200`))));

  r.get('/purchasing/meta', need('purchasing.view'), h(async (req) => asUser(req.user, async (q) => ({
    categories: await q('SELECT id, name FROM catalog_categories ORDER BY name'),
    vendors: await q(`SELECT id, name, vendor_kind FROM vendors WHERE is_active ORDER BY name`),
    catalog: await q('SELECT id, name, est_unit_cents, unit_label, category_id, vendor_id FROM catalog_items WHERE is_active ORDER BY name')
  }))));

  r.post('/purchasing/needs', need('purchasing.view'), h(async (req) => {
    const data = pick(req.body, NEED_COLS);
    if (!data.catalog_item_id && !data.custom_name) throw new HttpError(400, 'Choose an item or type a name');
    data.center_id = req.user.centerId; data.entered_by = req.user.id; data.source = 'office';
    const keys = Object.keys(data);
    return asUser(req.user, async (q) => (await q(`INSERT INTO purchase_needs (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id, status`, keys.map((k) => data[k])))[0]);
  }));

  // Send items for review. Under the auto-approve limit they are approved at once; otherwise the director must approve.
  r.post('/purchasing/submit', need('purchasing.view'), h(async (req) => {
    const { needIds = [], title } = req.body || {};
    if (!needIds.length) throw new HttpError(400, 'Choose at least one item');
    const out = await asUser(req.user, async (q) => {
      const batch = (await q(`INSERT INTO purchasing_batches (center_id, title, status, created_by, submitted_at) VALUES ($1,$2,'submitted',$3, now()) RETURNING id`,
        [req.user.centerId, title || `Purchasing review ${new Date().toLocaleDateString()}`, req.user.id]))[0];
      const results = [];
      for (const id of needIds) {
        await q('UPDATE purchase_needs SET batch_id = $2 WHERE id = $1', [id, batch.id]);
        results.push({ id, status: (await q('SELECT submit_need_for_approval($1) AS s', [id]))[0].s });
      }
      return { batchId: batch.id, results };
    });
    await asSystem((q) => notifyRoles(q, req.user.centerId, ['director'], 'purchasing_review', 'Purchasing items need your review', `${needIds.length} item(s) were submitted for approval.`));
    return out;
  }));

  r.get('/purchasing/review', need('purchasing.approve'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT * FROM v_director_review_queue ORDER BY hours_waiting DESC`))));

  // Approve, deny, or hold. The person who entered an item cannot approve it, and two-approval items need two different people.
  r.post('/purchasing/needs/:id/decide', need('purchasing.approve'), h(async (req) => {
    const { decision, note } = req.body || {};
    if (!['approved', 'denied', 'hold'].includes(decision)) throw new HttpError(400, 'Choose approve, deny, or hold');
    if (decision !== 'approved' && !note) throw new HttpError(400, 'Please give a reason');
    const info = await asUser(req.user, async (q) => {
      if (decision === 'hold') {
        await q(`UPDATE purchase_needs SET status = 'on_hold', decision_note = $2 WHERE id = $1 AND status = 'pending_approval'`, [req.params.id, note]);
      } else {
        const pending = await q(`SELECT id, required_role FROM need_approvals WHERE need_id = $1 AND decision IS NULL`, [req.params.id]);
        const mine = pending.find((p) => p.required_role === req.user.role) || (req.user.role === 'owner' ? pending[0] : null);
        if (!mine) throw new HttpError(400, 'Nothing is waiting for your approval on this item');
        await q(`UPDATE need_approvals SET decision = $2::approval_decision, decided_by = $3, note = $4 WHERE id = $1`, [mine.id, decision, req.user.id, note || null]);
      }
      return (await q('SELECT status, entered_by, coalesce(custom_name, (SELECT name FROM catalog_items WHERE id = catalog_item_id)) AS item FROM purchase_needs WHERE id = $1', [req.params.id]))[0];
    });
    await asSystem((q) => notifyUser(q, req.user.centerId, info.entered_by, 'purchase_' + info.status, `${info.item}: ${info.status.replace('_', ' ')}`, note || '', { table: 'purchase_needs', id: req.params.id }));
    return { status: info.status };
  }));

  r.post('/purchasing/adopt/:lineId', need('purchasing.view'), h(async (req) => asUser(req.user, async (q) => (
    { needId: (await q('SELECT adopt_request_line($1,$2) AS id', [req.params.lineId, req.user.id]))[0].id }))));

  r.get('/purchasing/to-order', need('purchasing.view'), h(async (req) => asUser(req.user, async (q) => {
    const vendors = await q('SELECT * FROM v_needs_to_order_by_vendor ORDER BY vendor');
    const items = await q(`SELECT n.id, coalesce(ci.name, n.custom_name) AS item, n.quantity, n.estimated_unit_cents, coalesce(n.preferred_vendor_id, ci.vendor_id) AS vendor_id
                             FROM purchase_needs n LEFT JOIN catalog_items ci ON ci.id = n.catalog_item_id
                            WHERE n.status = 'approved' AND NOT EXISTS (SELECT 1 FROM purchase_order_lines pl WHERE pl.need_id = n.id) ORDER BY 2`);
    const lines = await q(`SELECT l.id, coalesce(l.custom_name, ci.name) AS item, coalesce(l.approved_quantity, l.quantity) AS quantity, l.estimated_unit_cents, ci.vendor_id
                             FROM supply_request_lines l LEFT JOIN catalog_items ci ON ci.id = l.catalog_item_id
                            WHERE l.status = 'approved' AND NOT EXISTS (SELECT 1 FROM purchase_order_lines pl WHERE pl.request_line_id = l.id)`);
    return { vendors, items, classroomLines: lines };
  })));

  r.get('/purchasing/pipeline', need('purchasing.view'), h(async (req) => asUser(req.user, (q) => q('SELECT * FROM v_purchasing_pipeline ORDER BY days_late DESC, item'))));
  r.get('/purchasing/budgets', need('purchasing.view'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT b.*, cc.name AS category FROM v_purchasing_budget_status b JOIN catalog_categories cc ON cc.id = b.category_id ORDER BY cc.name`))));
}
