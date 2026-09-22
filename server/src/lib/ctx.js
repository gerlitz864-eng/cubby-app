import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

// Which database role each application role runs as. The database enforces what each may touch.
export const DB_ROLE = {
  owner: 'cubby_office', director: 'cubby_office', front_office: 'cubby_office', billing: 'cubby_office', cook: 'cubby_office',
  teacher: 'cubby_teacher', parent: 'cubby_parent'
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// PINs are key-hashed here (HMAC with a secret kept outside the database) before the database salts and hashes them again.
export const pinProof = (pin, pepper) => crypto.createHmac('sha256', pepper).update(String(pin)).digest('hex');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function makeCtx(db, config) {
  const ctx = { db, config };

  // Full access: for the server's own work (jobs, kiosk devices, notifications). Never used to answer a user's read.
  ctx.asSystem = (fn) => db.tx(fn);

  // Acts as a signed-in user: switches to their database role and tells the database who they are.
  // From here, row-level security and table grants decide what the queries can see and change.
  ctx.asUser = (user, fn) => db.tx(async (q) => {
    const role = DB_ROLE[user.role];
    if (!role) throw new HttpError(403, 'Unknown role');
    await q(`SET LOCAL ROLE ${role}`);
    await q(`SELECT set_config('app.user_id', $1, true)`, [user.id]);
    return fn(q);
  });

  // The kiosk's only door into the database.
  ctx.asKiosk = (fn) => db.tx(async (q) => {
    await q('SET LOCAL ROLE cubby_kiosk');
    return fn(q);
  });

  ctx.sign = (user) => jwt.sign({ uid: user.id }, config.jwtSecret, { expiresIn: '12h' });
  return ctx;
}

export function authMiddleware(ctx) {
  return async (req, _res, next) => {
    try {
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : null;
      if (!token) throw new HttpError(401, 'Sign in required');
      let payload;
      try { payload = jwt.verify(token, ctx.config.jwtSecret); } catch { throw new HttpError(401, 'Your session has expired. Please sign in again.'); }
      const u = (await ctx.asSystem((q) => q(
        `SELECT id, center_id, role, staff_id, guardian_id, email, is_active FROM users WHERE id = $1`, [payload.uid])))[0];
      if (!u || !u.is_active) throw new HttpError(401, 'This account is not active');
      const perms = await ctx.asSystem((q) => q(
        `SELECT permission_code, scope FROM role_permissions WHERE center_id = $1 AND role = $2`, [u.center_id, u.role]));
      req.user = {
        id: u.id, centerId: u.center_id, role: u.role, staffId: u.staff_id, guardianId: u.guardian_id, email: u.email,
        perms: new Map(perms.map((p) => [p.permission_code, p.scope]))
      };
      next();
    } catch (e) { next(e); }
  };
}

// Route guard: the user must hold at least one of these permissions.
export const need = (...codes) => (req, _res, next) =>
  codes.some((c) => req.user?.perms.has(c)) ? next()
    : next(new HttpError(403, `You do not have permission for this (${codes.join(' or ')})`));

export const can = (req, code) => req.user.perms.has(code);

// Wraps a handler: return a value to send it as JSON; throw to send an error.
export const h = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).then((out) => { if (out !== undefined && !res.headersSent) res.json(out); }).catch(next);

// Turns database errors into clear messages for the screen.
export function errorMiddleware(err, _req, res, _next) {
  let status = err.status || 500;
  let message = err.message || 'Something went wrong';
  switch (err.code) {
    case '42501': status = 403; message = 'You do not have access to that.'; break;
    case '23505': status = 409; message = 'That already exists.'; break;
    case '23503': status = 400; message = 'A related record is missing.'; break;
    case '23514': status = 400; message = `That value is not allowed (${err.constraint || 'check failed'}).`; break;
    case '23502': status = 400; message = `A required value is missing (${err.column || 'field'}).`; break;
    case '22P02': case '22007': case '22008': status = 400; message = 'One of the values is not in the right format.'; break;
    case 'P0001': case '23P01': status = 400; break; // rules raised by the database (transitions, separation of duties, exclusions)
    default: break;
  }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
}

export const today = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
