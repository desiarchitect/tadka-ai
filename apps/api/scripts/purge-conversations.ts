// Deletes conversations with no message for RETENTION_DAYS (30), with their turns and
// messages. Saved memories are kept until the customer deletes them. Run it on a schedule.
import { ConversationsService, RETENTION_DAYS } from '../src/memory/service.js';
import { loadConfig } from '../src/shared/config.js';
import { createDb } from '../src/shared/db.js';

const { db, pool } = createDb(loadConfig().DATABASE_URL);
const n = await new ConversationsService(db).purgeExpired();
console.log(`purged ${n} conversation(s) with no message in the last ${RETENTION_DAYS} days`);
await pool.end();
