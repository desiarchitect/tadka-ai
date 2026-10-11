import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../src/shared/config.js';
import { createDb } from '../src/shared/db.js';

const { db, pool } = createDb(loadConfig().DATABASE_URL);
await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
console.log('migrations applied');
await pool.end();
