import { h, need, HttpError } from './ctx.js';

// Small helper for plain create/read/update screens (vendors, products, catalog, and so on).
// Only the listed columns can be written. The database's grants and row-level security still apply on top.
export function crud(router, ctx, { path, table, read, write, cols, orderBy = 'created_at DESC', center = true, filters = [], defaults = {} }) {
  const readPerm = Array.isArray(read) ? read : [read];
  const writePerm = Array.isArray(write) ? write : [write];

  router.get(path, need(...readPerm), h(async (req) => {
    const where = []; const params = [];
    for (const f of filters) if (req.query[f] !== undefined) { params.push(req.query[f]); where.push(`${f} = $${params.length}`); }
    return ctx.asUser(req.user, (q) => q(`SELECT * FROM ${table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy} LIMIT 500`, params));
  }));

  router.get(`${path}/:id`, need(...readPerm), h(async (req) => {
    const rows = await ctx.asUser(req.user, (q) => q(`SELECT * FROM ${table} WHERE id = $1`, [req.params.id]));
    if (!rows[0]) throw new HttpError(404, 'Not found');
    return rows[0];
  }));

  router.post(path, need(...writePerm), h(async (req) => {
    const data = { ...defaults, ...pick(req.body, cols) };
    if (center) data.center_id = req.user.centerId;
    const keys = Object.keys(data);
    if (!keys.length) throw new HttpError(400, 'Nothing to save');
    const rows = await ctx.asUser(req.user, (q) => q(
      `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`,
      keys.map((k) => data[k])));
    return rows[0];
  }));

  router.patch(`${path}/:id`, need(...writePerm), h(async (req) => {
    const data = pick(req.body, cols);
    const keys = Object.keys(data);
    if (!keys.length) throw new HttpError(400, 'Nothing to change');
    const rows = await ctx.asUser(req.user, (q) => q(
      `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((k) => data[k]), req.params.id]));
    if (!rows[0]) throw new HttpError(404, 'Not found');
    return rows[0];
  }));
}

export function pick(obj = {}, cols) {
  const out = {};
  for (const c of cols) if (obj[c] !== undefined) out[c] = obj[c] === '' ? null : obj[c];
  return out;
}
