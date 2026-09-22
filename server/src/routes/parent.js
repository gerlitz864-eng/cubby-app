import { h, need, HttpError } from '../lib/ctx.js';
import { notifyRoles } from '../lib/notifications.js';

// The parent portal. A parent sees only their own child's sign-in and sign-out (and the daily report, if the center turns that on).
export default function register(r, ctx) {
  const { asUser, asSystem } = ctx;

  r.get('/parent/children', need('portal.sign_in_out'), h(async (req) => asSystem((q) => q(
    `SELECT ch.id, ch.first_name FROM child_guardians cg JOIN children ch ON ch.id = cg.child_id WHERE cg.guardian_id = $1 AND cg.can_view_portal ORDER BY ch.first_name`, [req.user.guardianId]))));

  r.get('/parent/sign-in-out', need('portal.sign_in_out'), h(async (req) => asUser(req.user, (q) => q(
    'SELECT * FROM v_parent_sign_in_out ORDER BY service_date DESC, checked_in_at DESC LIMIT 60'))));

  r.get('/parent/daily-report', need('portal.sign_in_out'), h(async (req) => {
    if (!req.user.perms.has('portal.daily_report')) return { enabled: false, lines: [] };
    return asUser(req.user, async (q) => ({ enabled: true, lines: await q(
      `SELECT child_id, report_date, teacher_note, occurred_at, category, title, detail, amount_eaten FROM v_parent_daily_report_secure ORDER BY report_date DESC, occurred_at`) }));
  }));

  // "I'll bring it tomorrow" and similar replies to a supply notice.
  r.post('/parent/supply-response', need('portal.sign_in_out'), h(async (req) => {
    const { flagId, response } = req.body || {};
    if (!['bringing_today', 'bringing_tomorrow', 'please_supply', 'already_sent', 'question'].includes(response)) throw new HttpError(400, 'Choose a reply');
    return asSystem(async (q) => {
      const f = (await q(`SELECT f.id, f.child_id, ch.first_name FROM supply_flags f JOIN children ch ON ch.id = f.child_id
                           JOIN child_guardians cg ON cg.child_id = f.child_id AND cg.guardian_id = $2 WHERE f.id = $1 AND f.status IN ('open','acknowledged')`, [flagId, req.user.guardianId]))[0];
      if (!f) throw new HttpError(404, 'That notice is not available');
      await q(`UPDATE supply_flags SET parent_response = $2::supply_response, parent_responded_at = now(), parent_response_by = $3 WHERE id = $1`, [f.id, response, req.user.guardianId]);
      await q(`INSERT INTO supply_flag_events (flag_id, event, actor_guardian_id, detail) VALUES ($1,'parent_responded',$2,$3)`, [f.id, req.user.guardianId, response]);
      await notifyRoles(q, req.user.centerId, ['front_office'], 'supply_reply', `${f.first_name}'s family replied`, response.replace(/_/g, ' '), { table: 'supply_flags', id: f.id });
      return { ok: true };
    });
  }));
}
