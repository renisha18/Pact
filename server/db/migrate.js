import { readFile, readdir } from 'node:fs/promises';
import { pool } from '../src/db.js';

// schema.sql creates tables on a fresh DB; db/migrations/*.sql (idempotent, run in
// name order) bring existing DBs up to date.
const migrationsDir = new URL('./migrations/', import.meta.url);
try {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await pool.query(await readFile(new URL(f, migrationsDir), 'utf8'));
    console.log(`Applied ${f}`);
  }
  console.log('Migration complete');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
