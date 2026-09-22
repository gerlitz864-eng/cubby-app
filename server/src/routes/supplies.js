import { h, need, HttpError } from '../lib/ctx.js';
import { centerInfo, notifyGuardian, notifyRoles, guardiansOf } from '../lib/notifications.js';

// A child's personal items (diapers, formula, and so on): teacher taps, family and office are told.
export default function register(r, ctx) {
  const { asUser, asSystem } = ctx;

  // Children in the teacher's room (everyone, for office) with the items each family supplies and any open flag.
  r.get('/supplies/room', need('supplies.flag', 'supplies.review'), h(async (req) => {
    const scope = req.user.perms.get('supplies.flag');
    return asUser(req.user, async (q) => {
      const kids = scope === 'own_classroom'
        ? await q('SELECT child_id, first_name, last_name FROM v_teacher_arrivals ORDER BY first_name')
        : await q(`SELECT ch.id AS child_id, ch.first_name, ch.last_name FROM children ch WHERE ch.status = 'active' ORDER BY ch.first_name`);
      const out = [];
      for (const k of kids) {
        const items = await q(`
          SELECT t.id AS item_type_id, t.code, t.label, t.category, t.default_urgency AS urgency, p.details,
                 f.id AS flag_id, f.level, f.status, f.parent_response
            FROM child_supply_profiles p
            JOIN supply_item_types t ON t.id = p.item_type_id AND t.is_active
            LEFT JOIN supply_flags f ON f.child_id = p.child_id AND f.item_type_id = t.id AND f.status IN ('open','acknowledged')
           WHERE p.child_id = $1 AND p.parent_supplies AND supply_item_allowed(p.child_id, t.id)
           ORDER BY t.sort_order`, [k.child_id]);
        if (items.length) out.push({ ...k, items });
      }
      return out;
    });
  }));

  // One tap = low. A second tap on the same item = out. Both land on the same flag, so nobody is notified twice.
  r.post('/supplies/flag', need('supplies.flag'), h(async (req) => {
    const { childId, itemTypeId, level = 'low', note } = req.body || {};
    if (!['low', 'out'].includes(level)) throw new HttpError(400, 'Choose low or out');
    const flag = await asUser(req.user, async (q) => {
      const t = (await q('SELECT default_urgency, label FROM supply_item_types WHERE id = $1', [itemTypeId]))[0];
      if (!t) throw new HttpError(404, 'Unknown item');
      const kid = req.user.perms.get('supplies.flag') === 'own_classroom'
        ? (await q('SELECT child_id, first_name, classroom_id, attendance_status FROM v_teacher_arrivals WHERE child_id = $1', [childId]))[0]
        : (await q(`SELECT ch.id AS child_id, ch.first_name, NULL::uuid AS classroom_id, NULL AS attendance_status FROM children ch WHERE ch.id = $1`, [childId]))[0];
      if (!kid) throw new HttpError(403, 'That child is not in your room');
      const urgent = t.default_urgency === 'urgent';
      const row = (await q(`
        INSERT INTO supply_flags (id, center_id, child_id, classroom_id, item_type_id, level, urgency, flagged_by, note, needed_by, ack_due_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::supply_level, $6::supply_urgency, $7, $8, current_date + 1,
                CASE WHEN $6 = 'urgent' AND $5 = 'out' THEN now() + interval '10 minutes' END)
        ON CONFLICT (child_id, item_type_id) WHERE status IN ('open','acknowledged')
        DO UPDATE SET level = CASE WHEN EXCLUDED.level = 'out' THEN 'out'::supply_level ELSE supply_flags.level END,
                      note = coalesce(EXCLUDED.note, supply_flags.note),
                      ack_due_at = CASE WHEN supply_flags.urgency = 'urgent' AND EXCLUDED.level = 'out' THEN coalesce(supply_flags.ack_due_at, now() + interval '10 minutes') ELSE supply_flags.ack_due_at END
        RETURNING id, level, urgency, (xmax = 0) AS created`,
        [req.user.centerId, childId, kid.classroom_id, itemTypeId, level, t.default_urgency, req.user.staffId, note || null]))[0];
      return { ...row, label: t.label, first_name: kid.first_name, urgent };
    });
    // Tell the family and the office (the teacher's own database access cannot write notices, so this runs as the server).
    await asSystem(async (q) => {
      await q(`INSERT INTO supply_flag_events (flag_id, event, actor_user_id, detail) VALUES ($1, $2::supply_event_type, $3, $4)`,
        [flag.id, flag.created ? 'flagged' : 'level_raised', req.user.id, `${flag.label}: ${flag.level}`]);
      const word = flag.level === 'out' ? 'has run out of' : 'is running low on';
      const msg = `${flag.first_name} ${word} ${flag.label.toLowerCase()} at school. Please send more when you can.`;
      for (const g of await guardiansOf(q, childId, { supply: true })) {
        await notifyGuardian(q, req.user.centerId, g.id, 'supply_flag', `${flag.first_name} needs ${flag.label.toLowerCase()}`, msg, { table: 'supply_flags', id: flag.id });
        if (g.is_primary && g.sms_consent && !g.opted_out_at && g.phone_mobile && (flag.urgent || flag.level === 'out'))
          await ctx.notifier.sendSms(g.phone_mobile, `Willow Creek: ${msg}`, { flagId: flag.id });
      }
      await notifyRoles(q, req.user.centerId, ['front_office'], 'supply_flag', `${flag.first_name}: ${flag.label} ${flag.level}`,
        `${flag.urgent && flag.level === 'out' ? 'URGENT. ' : ''}${msg}`, { table: 'supply_flags', id: flag.id });
    });
    return { id: flag.id, level: flag.level, created: flag.created };
  }));

  // A mistaken tap can be undone for two minutes.
  r.post('/supplies/flags/:id/undo', need('supplies.flag'), h(async (req) => asUser(req.user, async (q) => {
    const row = (await q(`UPDATE supply_flags SET status = 'cancelled', resolved_at = now() WHERE id = $1 AND flagged_by = $2 AND flagged_at > now() - interval '2 minutes' AND status = 'open' RETURNING id`,
      [req.params.id, req.user.staffId]))[0];
    if (!row) throw new HttpError(400, 'Only your own flag from the last two minutes can be undone');
    return { ok: true };
  })));

  r.get('/supplies/queue', need('supplies.review'), h(async (req) => asUser(req.user, (q) => q(
    `SELECT * FROM v_office_supply_queue ORDER BY (urgency = 'urgent') DESC, (level = 'out') DESC, flagged_at`))));

  r.post('/supplies/flags/:id/ack', need('supplies.review'), h(async (req) => asUser(req.user, async (q) => {
    const row = (await q(`UPDATE supply_flags SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND status = 'open' RETURNING id`, [req.params.id, req.user.id]))[0];
    if (!row) throw new HttpError(400, 'Already acknowledged or closed');
    await q(`INSERT INTO supply_flag_events (flag_id, event, actor_user_id) VALUES ($1,'acknowledged',$2)`, [row.id, req.user.id]);
    return { ok: true };
  })));

  r.post('/supplies/flags/:id/resolve', need('supplies.review'), h(async (req) => {
    const resolution = req.body?.resolution || 'parent_delivered';
    const info = await asUser(req.user, async (q) => {
      const f = (await q(`UPDATE supply_flags SET status = 'resolved', resolution = $2::supply_resolution, resolved_at = now(), resolved_by = $3 WHERE id = $1 AND status IN ('open','acknowledged') RETURNING id, child_id, item_type_id`,
        [req.params.id, resolution, req.user.id]))[0];
      if (!f) throw new HttpError(400, 'Already closed');
      await q(`INSERT INTO supply_flag_events (flag_id, event, actor_user_id, detail) VALUES ($1,'resolved',$2,$3)`, [f.id, req.user.id, resolution]);
      if (resolution === 'center_supplied')
        await q(`INSERT INTO stock_movements (center_id, item_type_id, delta, reason, flag_id, child_id, recorded_by) VALUES ($1,$2,-1,'given_to_child',$3,$4,$5)`, [req.user.centerId, f.item_type_id, f.id, f.child_id, req.user.id]);
      return f;
    });
    await asSystem(async (q) => {
      const c = (await q('SELECT first_name FROM children WHERE id = $1', [info.child_id]))[0];
      for (const g of await guardiansOf(q, info.child_id, { supply: true }))
        await notifyGuardian(q, req.user.centerId, g.id, 'supply_resolved', 'Thank you', resolution === 'center_supplied' ? `We supplied ${c.first_name}'s item from our stock.` : `${c.first_name}'s item was received. Thank you!`);
    });
    return { ok: true };
  }));
}
