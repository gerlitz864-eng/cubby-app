import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { config } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seedDemo } from './db/seed.js';
import { createApp } from './app.js';
import { startScheduler } from './jobs/index.js';

if (config.production && (config.jwtSecret.startsWith('dev-only') || config.pinPepper.startsWith('dev-only'))) {
  console.error('Refusing to start in production with the default JWT_SECRET or PIN_PEPPER. Set both to long random values.');
  process.exit(1);
}

const db = await createDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
console.log(`Database: ${db.kind === 'pg' ? 'PostgreSQL' : 'embedded PostgreSQL (data in ' + config.dataDir + ')'}`);
await migrate(db, undefined, (m) => console.log('  ' + m));
const centers = (await db.tx((q) => q('SELECT count(*)::int AS n FROM centers')))[0].n;
if (!centers && config.seedDemo) { await seedDemo(db, config); console.log('Loaded demo data (fictional center, children, and staff).'); }

const app = createApp(db, config);
const dist = path.resolve(process.cwd(), '../web/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
app.listen(config.port, () => {
  console.log(`Cubby API on http://localhost:${config.port}` + (fs.existsSync(dist) ? ' (serving the web app too)' : ''));
});
if (config.runJobs) startScheduler(app.ctx, config.jobIntervalMs);
