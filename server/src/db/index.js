// One small interface over two engines:
//   - real PostgreSQL through `pg` when DATABASE_URL is set
//   - an embedded PostgreSQL (PGlite) otherwise, so the app runs with nothing installed
// Both return rows as plain objects. tx(fn) gives fn a query function q(sql, params) inside a transaction.

// 64-bit integers can arrive as BigInt; make them serialize as numbers.
BigInt.prototype.toJSON = function () { return Number(this); };

// Several reporting views use the database's own "today". Setting the database time zone to the center's keeps
// that consistent (one center per database is the recommended deployment).
export async function createDb({ databaseUrl, dataDir, timezone = process.env.DB_TIMEZONE || 'America/New_York' } = {}) {
  if (databaseUrl) {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(20, (v) => Number(v));     // int8 -> number
    pg.types.setTypeParser(1700, (v) => Number(v));   // numeric -> number
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c timezone=${timezone}` });
    return {
      kind: 'pg',
      exec: async (sql) => { await pool.query(sql); },
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn(async (sql, params = []) => (await c.query(sql, params)).rows);
          await c.query('COMMIT');
          return out;
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
      close: () => pool.end()
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  if (dataDir) (await import('node:fs')).mkdirSync(dataDir, { recursive: true });
  const opts = { extensions: { btree_gist, pgcrypto } };
  const db = dataDir ? new PGlite(dataDir, opts) : new PGlite(opts);
  await db.waitReady;
  await db.exec(`SET TIME ZONE '${timezone}'`);
  const fix = (rows) => rows.map((r) => {
    for (const k in r) if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
    return r;
  });
  return {
    kind: 'pglite',
    exec: (sql) => db.exec(sql),
    tx: (fn) => db.transaction((t) => fn(async (sql, params = []) => fix((await t.query(sql, params)).rows))),
    close: () => db.close()
  };
}
