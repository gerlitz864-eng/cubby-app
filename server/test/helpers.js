process.env.NODE_ENV = 'test';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { seedDemo } from '../src/db/seed.js';
import { createApp } from '../src/app.js';

export async function boot() {
  const config = { jwtSecret: 't', pinPepper: 'pepper', notifyProvider: 'console', faceProvider: 'mock', seedDemo: true, uploadDir: '/tmp/cubby-uploads', twilio: {} };
  // Set TEST_PG_ADMIN_URL to run the whole suite against a real PostgreSQL server (one fresh database per test file).
  let db;
  if (process.env.TEST_PG_ADMIN_URL) {
    const pg = (await import('pg')).default;
    const admin = new pg.Client({ connectionString: process.env.TEST_PG_ADMIN_URL }); await admin.connect();
    const name = 'cubby_test_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    await admin.query(`CREATE DATABASE ${name}`); await admin.end();
    const u = new URL(process.env.TEST_PG_ADMIN_URL); u.pathname = '/' + name;
    db = await createDb({ databaseUrl: u.toString() });
  } else db = await createDb();
  await migrate(db);
  const seed = await seedDemo(db, config);
  const app = createApp(db, config);
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const tokens = {};
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  const login = async (who) => {
    if (tokens[who]) return tokens[who];
    const r = who === 'parent'
      ? await call('POST', '/auth/parent-login', { email: 'parent@willowcreek.test', pin: '123456' })
      : await call('POST', '/auth/login', { email: `${who}@willowcreek.test`, password: 'demo1234' });
    if (r.status !== 200) throw new Error(`login ${who} failed: ${JSON.stringify(r.body)}`);
    return (tokens[who] = r.body.token);
  };
  const as = (who) => ({
    get: async (p) => call('GET', p, null, { Authorization: 'Bearer ' + await login(who) }),
    post: async (p, b) => call('POST', p, b || {}, { Authorization: 'Bearer ' + await login(who) }),
    patch: async (p, b) => call('PATCH', p, b || {}, { Authorization: 'Bearer ' + await login(who) }),
    put: async (p, b) => call('PUT', p, b || {}, { Authorization: 'Bearer ' + await login(who) })
  });
  const kiosk = (token = 'demo-kiosk-token') => ({
    get: (p) => call('GET', p, null, { 'x-device-token': token }),
    post: (p, b) => call('POST', p, b || {}, { 'x-device-token': token })
  });
  // Runs one statement as a database role and reports the error code (or 'ok'). Each check gets its own transaction.
  const tryAs = async (role, userId, sql) => {
    try {
      await db.tx(async (q) => { await q(`SET LOCAL ROLE ${role}`); await q(`SELECT set_config('app.user_id', $1, true)`, [userId]); await q(sql); });
      return 'ok';
    } catch (e) { return e.code || e.message; }
  };
  const close = async () => { server.close(); await db.close(); };
  return { db, app, seed, call, as, kiosk, close, config, tryAs, port: server.address().port };
}
