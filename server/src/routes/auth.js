import bcrypt from 'bcryptjs';
import { h, HttpError, pinProof } from '../lib/ctx.js';

export default function register(r, ctx) {
  const { asSystem, config } = ctx;

  // Staff and office sign in with email and password.
  r.post('/auth/login', h(async (req) => {
    const { email, password } = req.body || {};
    const u = (await asSystem((q) => q(
      `SELECT id, center_id, role, password_hash, is_active FROM users WHERE lower(email) = lower($1)`, [String(email || '')])))[0];
    if (!u || !u.is_active || !u.password_hash || !(await bcrypt.compare(String(password || ''), u.password_hash)))
      throw new HttpError(401, 'Incorrect email or password');
    if (u.role === 'parent') throw new HttpError(403, 'Parents sign in with their PIN');
    await asSystem((q) => q('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]));
    return { token: ctx.sign(u) };
  }));

  // Parents sign in with their email and PIN. Wrong PINs are counted and the PIN locks after too many.
  r.post('/auth/parent-login', h(async (req) => {
    const { email, pin } = req.body || {};
    const generic = new HttpError(401, 'Incorrect email or PIN');
    const row = (await asSystem((q) => q(
      `SELECT u.id, u.center_id, u.role, u.is_active, f.id AS cred_id, f.locked_until
         FROM users u
         JOIN family_access_credentials f ON f.guardian_id = u.guardian_id AND f.purpose = 'portal' AND f.is_active
        WHERE lower(u.email) = lower($1) AND u.role = 'parent'`, [String(email || '')])))[0];
    if (!row || !row.is_active) throw generic;
    if (row.locked_until && new Date(row.locked_until) > new Date()) throw new HttpError(423, 'This PIN is locked. Please see the front desk.');
    const ok = (await asSystem((q) => q(
      `SELECT (pin_hash = crypt($2, pin_hash)) AS ok FROM family_access_credentials WHERE id = $1`,
      [row.cred_id, pinProof(pin || '', config.pinPepper)])))[0].ok;
    if (!ok) {
      await asSystem(async (q) => {
        const pol = (await q('SELECT max_failed_attempts, lockout_minutes FROM access_policies WHERE center_id = $1', [row.center_id]))[0] || { max_failed_attempts: 5, lockout_minutes: 15 };
        const upd = (await q(
          `UPDATE family_access_credentials SET failed_attempts = failed_attempts + 1, last_failed_at = now(),
                  locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3::int) ELSE locked_until END
            WHERE id = $1 RETURNING failed_attempts, locked_until`, [row.cred_id, pol.max_failed_attempts, pol.lockout_minutes]))[0];
        if (upd.locked_until) {
          await q(`INSERT INTO in_app_notifications (center_id, for_role, kind, title, body, source_table, source_id)
                   SELECT $1, r, 'pin_locked', 'A parent portal PIN was locked', 'A portal PIN was locked after repeated wrong attempts.', 'family_access_credentials', $2
                     FROM unnest(ARRAY['director','front_office']::user_role[]) r`, [row.center_id, row.cred_id]);
        }
      });
      throw generic;
    }
    await asSystem((q) => q('UPDATE family_access_credentials SET failed_attempts = 0, locked_until = NULL, last_used_at = now() WHERE id = $1', [row.cred_id]));
    return { token: ctx.sign(row) };
  }));
}

export function meRoute(r, ctx) {
  r.get('/me', h(async (req) => {
    const u = req.user;
    const info = (await ctx.asSystem((q) => q(
      `SELECT c.name AS center_name, c.timezone, coalesce(s.first_name || ' ' || s.last_name, g.first_name || ' ' || g.last_name, us.email) AS name,
              s.default_classroom_id
         FROM users us
         JOIN centers c ON c.id = us.center_id
         LEFT JOIN staff s ON s.id = us.staff_id
         LEFT JOIN guardians g ON g.id = us.guardian_id
        WHERE us.id = $1`, [u.id])))[0];
    return {
      id: u.id, email: u.email, role: u.role, name: info.name, staffId: u.staffId, guardianId: u.guardianId,
      center: { name: info.center_name, timezone: info.timezone },
      permissions: [...u.perms.entries()].map(([code, scope]) => ({ code, scope }))
    };
  }));
}
