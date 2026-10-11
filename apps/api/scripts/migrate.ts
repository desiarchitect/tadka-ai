import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../src/shared/config.js';
import { createDb } from '../src/shared/db.js';
import { fileURLToPath } from 'node:url';

const { db, pool } = createDb(loadConfig().DATABASE_URL);
await migrate(db, { migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)) });
console.log('migrations applied');
await pool.end();
