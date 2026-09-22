import { config } from '../config.js';
import { createDb } from './index.js';
import { migrate } from './migrate.js';
import { seedDemo } from './seed.js';

const db = await createDb({ databaseUrl: config.databaseUrl, dataDir: config.dataDir });
await migrate(db, undefined, console.log);
const has = (await db.tx((q) => q('SELECT count(*)::int AS n FROM centers')))[0].n;
if (has) console.log('Data already present. Delete the data folder to start fresh.');
else { await seedDemo(db, config); console.log('Demo data loaded.'); }
await db.close();
