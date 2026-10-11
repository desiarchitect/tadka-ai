import { loadConfig } from '../src/shared/config.js';
import { createDb } from '../src/shared/db.js';
import { seed, SEED_PASSWORD } from '../src/shared/seed-data.js';

const { db, pool } = createDb(loadConfig().DATABASE_URL);
await seed(db);
console.log(`seeded: rahul@ / aman@ / owner@ / admin@tadka.test, password ${SEED_PASSWORD} (synthetic)`);
await pool.end();
