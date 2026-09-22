import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.resolve(here, '../../../db/migrations');

// Runs every .sql file in db/migrations once, in name order.
// ALTER TYPE ... ADD VALUE cannot be used in the same transaction that adds it,
// so those statements are run on their own first.
export async function migrate(db, dir = migrationsDir, log = () => {}) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await db.tx((q) => q('SELECT name FROM schema_migrations'))).map((r) => r.name));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    let sql = fs.readFileSync(path.join(dir, f), 'utf8');
    const adds = sql.match(/^ALTER TYPE [^;]*ADD VALUE[^;]*;/gm) || [];
    for (const a of adds) { await db.exec(a); sql = sql.replace(a, ''); }
    await db.exec(sql);
    await db.tx((q) => q('INSERT INTO schema_migrations (name) VALUES ($1)', [f]));
    log(`applied ${f}`);
  }
}
