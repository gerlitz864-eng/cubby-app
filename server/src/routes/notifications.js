import { h } from '../lib/ctx.js';

export default function register(r, ctx) {
  const mine = (u) => ({
    where: `(n.user_id = $1 OR n.for_role = $2::user_role OR n.guardian_id = $3)`,
    params: [u.id, u.role, u.guardianId]
  });

  // The bell: notices for this person, plus notices sent to everyone with their role.
  r.get('/notifications', h(async (req) => {
    const m = mine(req.user);
    return ctx.asSystem(async (q) => {
      const items = await q(`SELECT n.id, n.kind, n.title, n.body, n.created_at, n.read_at, n.source_table, n.source_id, n.for_role IS NOT NULL AS broadcast
                               FROM in_app_notifications n WHERE ${m.where} AND n.center_id = $4
                              ORDER BY n.created_at DESC LIMIT 60`, [...m.params, req.user.centerId]);
      const unread = items.filter((i) => !i.read_at).length;
      return { items, unread };
    });
  }));

  r.post('/notifications/read', h(async (req) => {
    return ctx.asSystem(async (q) => {
      await q(`UPDATE in_app_notifications SET read_at = now() WHERE read_at IS NULL AND (user_id = $1 OR guardian_id = $2 OR for_role = $3::user_role) AND center_id = $4`,
        [req.user.id, req.user.guardianId, req.user.role, req.user.centerId]);
      return { ok: true };
    });
  }));
}
