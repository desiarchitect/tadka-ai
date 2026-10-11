// Creates a separate `tadka_test` database and applies migrations once per run.
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createDb } from '../src/shared/db.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://tadka:tadka_local@localhost:5544/tadka_test';

export default async function setup() {
  const admin = new pg.Client({ connectionString: TEST_DB_URL.replace(/\/[^/]+$/, '/postgres') });
  await admin.connect();
  await admin.query('drop database if exists tadka_test with (force)');
  await admin.query('create database tadka_test');
  await admin.end();
  const { db, pool } = createDb(TEST_DB_URL);
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
  await pool.end();
}
