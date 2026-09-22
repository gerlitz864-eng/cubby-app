import { h, need, HttpError } from '../lib/ctx.js';
import { notifyRoles, notifyUser } from '../lib/notifications.js';

// Classroom supply requests: teachers request, the office approves, orders are tracked from ordered to received.
export default function register(r, ctx) {
  const { asUser, asSystem } = ctx;

  const notifyRequester = async (q, centerId, staffId, kind, title, body, lineId) => {
    const u = (await q('SELECT id FROM users WHERE staff_id = $1 AND is_active', [staffId]))[0];
    if (u) await notifyUser(q, centerId, u.id, kind, title, body, { table: 'supply_request_lines', id: lineId });
  };

  r.get('/orders/catalog', need('orders.request', 'orders.review'), h(async (req) => {
    const items = await asUser(req.user, (q) => q(
      `SELECT ci.id, ci.name, ci.description, ci.unit_label, ci.est_unit_cents, ci.track_stock, ci.is_food, cc.name AS category
         FROM catalog_items ci LEFT JOIN catalog_categories cc ON cc.id = ci.category_id WHERE ci.is_active ORDER BY cc.name, ci.name`));
    const stock = await asSystem((q) => q('SELECT catalog_item_id, on_hand FROM stockroom_stock WHERE center_id = $1', [req.user.centerId]));
    return items.map((i) => ({ ...i, on_hand: i.track_stock ? (stock.find((s) => s.catalog_item_id === i.id)?.on_hand ?? 0) : null }));
  }));

  // Take something that is already on the stockroom shelf instead of ordering it.
  r.post('/orders/stockroom/take', need('orders.request', 'orders.review'), h(async (req) => {
    const { catalogItemId, quantity = 1, classroomId } = req.body || {};
    return asSystem(async (q) => {
      const s = (await q('SELECT on_hand FROM stockroom_stock WHERE center_id = $1 AND catalog_item_id = $2', [req.user.centerId, catalogItemId]))[0];
      if (!s || s.on_hand < quantity) throw new HttpError(400, 'Not enough on the shelf');
      await q(`INSERT INTO stockroom_movements (center_id, catalog_item_id, delta, reason, classroom_id, recorded_by) VALUES ($1,$2,$3,'taken_by_classroom',$4,$5)`,
        [req.user.centerId, catalogItemId, -quantity, classroomId || null, req.user.id]);
      return { ok: true, onHand: s.on_hand - quantity };
    });
  }));

  // Submit a request: catalog items and/or custom items. Custom food goes on hold for the kitchen and director.
  r.post('/orders/requests', need('orders.request'), h(async (req) => {
    const b = req.body || {};
    if (!b.classroomId || !Array.isArray(b.lines) || !b.lines.length) throw new HttpError(400, 'Choose a room and at least one item');
    if (!req.user.staffId) throw new HttpError(400, 'Only staff can request supplies');
    const result = await asUser(req.user, async (q) => {
      const rq = (await q(`INSERT INTO supply_requests (center_id, classroom_id, requested_by, priority, needed_by, note, status, submitted_at)
                           VALUES ($1,$2,$3,$4::request_priority,$5,$6,'submitted', now()) RETURNING id`,
        [req.user.centerId, b.classroomId, req.user.staffId, b.priority || 'normal', b.neededBy || null, b.note || null]))[0];
      const ids = [];
      for (const l of b.lines) {
        if (!l.catalogItemId && !l.customName) throw new HttpError(400, 'Each line needs an item or a custom name');
        if (!(Number(l.quantity) > 0)) throw new HttpError(400, 'Quantity must be at least 1');
        const line = (await q(`INSERT INTO supply_request_lines (request_id, catalog_item_id, custom_name, custom_description, custom_url, is_food, quantity, unit_label, estimated_unit_cents, reason)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, is_food`,
          [rq.id, l.catalogItemId || null, l.customName || null, l.customDescription || null, l.customUrl || null, !!l.isFood, Number(l.quantity), l.unitLabel || null,
            l.estimatedUnitCents != null && l.estimatedUnitCents !== '' ? Math.round(Number(l.estimatedUnitCents)) : null, l.reason || null]))[0];
        if (line.is_food) {
          await q(`UPDATE supply_request_lines SET status = 'on_hold', decision_note = 'Food must be added to the approved product list first, so the kitchen has its ingredients and paperwork.' WHERE id = $1`, [line.id]);
        }
        ids.push({ id: line.id, food: line.is_food });
      }
      return { requestId: rq.id, lines: ids };
    });
    await asSystem(async (q) => {
      await notifyRoles(q, req.user.centerId, ['front_office'], 'supply_request', 'New classroom supply request', `${b.lines.length} item(s) are waiting for review.`, { table: 'supply_requests', id: result.requestId });
      if (result.lines.some((l) => l.food)) await notifyRoles(q, req.user.centerId, ['cook', 'director'], 'food_request', 'A teacher requested a food item', 'It is on hold until the product is entered and approved in the vendor product list.');
    });
    return result;
  }));

  r.get('/orders/mine', need('orders.request'), h(async (req) => asUser(req.user, (q) => q('SELECT * FROM v_teacher_my_requests ORDER BY submitted_at DESC'))));

  r.post('/orders/lines/:id/cancel', need('orders.request'), h(async (req) => asUser(req.user, async (q) => {
    const row = (await q(`UPDATE supply_request_lines SET status = 'cancelled' WHERE id = $1 AND status IN ('pending','on_hold') RETURNING id`, [req.params.id]))[0];
    if (!row) throw new HttpError(400, 'Only a waiting request can be cancelled');
    return { ok: true };
  })));

  r.post('/orders/lines/:id/confirm', need('orders.request'), h(async (req) => asUser(req.user, async (q) => {
    const row = (await q(`UPDATE supply_request_lines SET classroom_confirmed_at = now(), classroom_confirmed_by = $2 WHERE id = $1 AND status = 'received' RETURNING id`, [req.params.id, req.user.staffId]))[0];
    if (!row) throw new HttpError(400, 'That item has not been received yet');
    return { ok: true };
  })));

  // ---------- office ----------
  r.get('/orders/queue', need('orders.review'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT * FROM v_office_approval_queue ORDER BY (priority = 'urgent') DESC, submitted_at`))));

  r.post('/orders/lines/:id/decide', need('orders.review'), h(async (req) => {
    const { decision, note, approvedQuantity } = req.body || {};
    if (!['approved', 'denied', 'on_hold'].includes(decision)) throw new HttpError(400, 'Choose approve, deny, or hold');
    if (decision !== 'approved' && !note) throw new HttpError(400, 'Please give the teacher a reason');
    const info = await asUser(req.user, async (q) => {
      const l = (await q(`UPDATE supply_request_lines SET status = $2::request_line_status, decision_note = $3, approved_quantity = $4, reviewed_by = $5, reviewed_at = now()
                           WHERE id = $1 RETURNING id, request_id, coalesce(custom_name, (SELECT name FROM catalog_items WHERE id = catalog_item_id)) AS item`,
        [req.params.id, decision, note || null, approvedQuantity ?? null, req.user.id]))[0];
      if (!l) throw new HttpError(404, 'Line not found');
      const rq = (await q('SELECT requested_by FROM supply_requests WHERE id = $1', [l.request_id]))[0];
      return { ...l, requestedBy: rq.requested_by };
    });
    await asSystem((q) => notifyRequester(q, req.user.centerId, info.requestedBy, 'order_' + decision,
      decision === 'approved' ? `${info.item} approved` : decision === 'denied' ? `${info.item} was denied` : `${info.item}: we have a question`, note || 'Your request was approved.', info.id));
    return { ok: true };
  }));

  r.post('/orders/lines/:id/comment', need('orders.review', 'orders.request'), h(async (req) => asSystem(async (q) => {
    await q(`INSERT INTO request_line_events (line_id, event, actor_user_id, note) VALUES ($1,'comment',$2,$3)`, [req.params.id, req.user.id, req.body?.note || '']);
    return { ok: true };
  })));

  // ---------- purchase orders (shared by classroom requests and the master purchasing list) ----------
  r.get('/pos', need('purchasing.view', 'orders.review'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT po.*, v.name AS vendor, (SELECT count(*)::int FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS lines,
            (SELECT coalesce(sum(l.quantity::bigint * coalesce(l.unit_cost_cents, 0)), 0)::bigint FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS subtotal_cents
       FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id ORDER BY po.ordered_at DESC NULLS FIRST, po.po_number DESC LIMIT 100`))));

  r.post('/pos', need('purchasing.view', 'orders.review'), h(async (req) => {
    const { vendorId, lineIds = [], needIds = [], expectedDelivery } = req.body || {};
    if (!vendorId || (!lineIds.length && !needIds.length)) throw new HttpError(400, 'Choose a vendor and at least one item');
    return asUser(req.user, async (q) => {
      const n = (await q(`SELECT count(*)::int AS n FROM purchase_orders WHERE center_id = $1`, [req.user.centerId]))[0].n + 1;
      const po = (await q(`INSERT INTO purchase_orders (center_id, vendor_id, po_number, created_by, expected_delivery) VALUES ($1,$2,$3,$4,$5) RETURNING id, po_number`,
        [req.user.centerId, vendorId, `PO-${new Date().toISOString().slice(2, 4)}${new Date().toISOString().slice(5, 7)}-${String(n).padStart(4, '0')}`, req.user.id, expectedDelivery || null]))[0];
      for (const id of lineIds) {
        const l = (await q(`SELECT l.id, l.catalog_item_id, coalesce(l.approved_quantity, l.quantity) AS qty, l.estimated_unit_cents, coalesce(l.custom_name, ci.name) AS name
                              FROM supply_request_lines l LEFT JOIN catalog_items ci ON ci.id = l.catalog_item_id WHERE l.id = $1 AND l.status = 'approved'`, [id]))[0];
        if (!l) throw new HttpError(400, 'A chosen request line is not approved');
        await q(`INSERT INTO purchase_order_lines (purchase_order_id, request_line_id, catalog_item_id, description, quantity, unit_cost_cents) VALUES ($1,$2,$3,$4,$5,$6)`,
          [po.id, l.id, l.catalog_item_id, l.name, l.qty, l.estimated_unit_cents]);
      }
      for (const id of needIds) {
        const nd = (await q(`SELECT n.id, n.catalog_item_id, n.request_line_id, n.quantity, n.estimated_unit_cents, coalesce(n.custom_name, ci.name) AS name
                               FROM purchase_needs n LEFT JOIN catalog_items ci ON ci.id = n.catalog_item_id WHERE n.id = $1 AND n.status = 'approved'`, [id]))[0];
        if (!nd) throw new HttpError(400, 'A chosen purchasing item is not approved');
        await q(`INSERT INTO purchase_order_lines (purchase_order_id, need_id, request_line_id, catalog_item_id, description, quantity, unit_cost_cents) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [po.id, nd.id, nd.request_line_id, nd.catalog_item_id, nd.name, nd.quantity, nd.estimated_unit_cents]);
      }
      return po;
    });
  }));

  // Move a purchase order forward. One change updates every classroom request line and master-list item on it.
  r.post('/pos/:id/status', need('purchasing.view', 'orders.review'), h(async (req) => {
    const { status, carrier, trackingNumber, expectedDelivery } = req.body || {};
    if (!['ordered', 'shipped', 'delivered', 'cancelled'].includes(status)) throw new HttpError(400, 'Choose ordered, shipped, delivered, or cancelled');
    const info = await asUser(req.user, async (q) => {
      await q(`UPDATE purchase_orders SET status = $2::po_status, carrier = coalesce($3, carrier), tracking_number = coalesce($4, tracking_number),
                      expected_delivery = coalesce($5::date, expected_delivery), ordered_by = CASE WHEN $2 = 'ordered' THEN $6::uuid ELSE ordered_by END,
                      ordered_at = CASE WHEN $2 = 'ordered' THEN now() ELSE ordered_at END WHERE id = $1`,
        [req.params.id, status, carrier || null, trackingNumber || null, expectedDelivery || null, req.user.id]);
      return q(`SELECT l.id AS line_id, l.status, coalesce(l.custom_name, ci.name) AS item, r.requested_by
                  FROM purchase_order_lines pl JOIN supply_request_lines l ON l.id = pl.request_line_id JOIN supply_requests r ON r.id = l.request_id
                  LEFT JOIN catalog_items ci ON ci.id = l.catalog_item_id WHERE pl.purchase_order_id = $1`, [req.params.id]);
    });
    await asSystem(async (q) => {
      for (const l of info) await notifyRequester(q, req.user.centerId, l.requested_by, 'order_' + status, `${l.item}: ${status === 'delivered' ? 'arrived at the office. Please pick it up.' : status}`, carrier ? `${carrier} ${trackingNumber || ''}` : '', l.line_id);
    });
    return { ok: true };
  }));

}
