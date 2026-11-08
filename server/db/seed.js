import { pool } from '../src/db.js';

try {
  // Seed data goes here once tables exist.
  console.log('Seed complete (nothing to seed yet)');
} finally {
  await pool.end();
}
