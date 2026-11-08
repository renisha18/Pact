// In-memory Postgres (PGlite) that stands in for src/db.js in tests, so route
// SQL runs against the real schema without touching Neon.
import { readFile } from 'node:fs/promises';
import { PGlite, types } from '@electric-sql/pglite';

export async function createTestDb() {
  const pg = new PGlite({
    parsers: {
      [types.DATE]: (v) => v,
      [types.INT8]: (v) => Number(v),
    },
  });
  await pg.exec(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'));

  const wrap = (q) => async (text, params) => {
    const r = await q.query(text, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };

  return {
    __pg: pg,
    pool: {},
    query: wrap(pg),
    withTransaction: (fn) => pg.transaction((tx) => fn({ query: wrap(tx) })),
  };
}
