import { readFile } from 'node:fs/promises';
import { pool } from '../src/db.js';

const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
try {
  await pool.query(sql);
  console.log('Migration complete');
} catch (err) {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
