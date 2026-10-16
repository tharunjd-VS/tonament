'use strict';

// Postgres access. In production (Vercel) this connects to DATABASE_URL —
// e.g. Neon. Locally and in tests, with no DATABASE_URL, it runs an embedded
// Postgres (PGlite) so nothing needs installing.
//
// Both backends expose the same small interface:
//   query(sql, params) -> rows
//   tx(async (query) => ...) -> runs fn inside BEGIN/COMMIT
//   close()

const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tournaments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  venue       TEXT,
  sport       TEXT NOT NULL,
  format      TEXT NOT NULL,
  config      JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'setup',
  admin_key   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS entries (
  id            SERIAL PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  seed          INTEGER NOT NULL,
  group_no      INTEGER
);
CREATE TABLE IF NOT EXISTS matches (
  id            SERIAL PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,                     -- 'league' | 'knockout'
  group_no      INTEGER,
  round         INTEGER NOT NULL,
  slot          INTEGER NOT NULL DEFAULT 0,
  a_id          INTEGER REFERENCES entries(id),
  b_id          INTEGER REFERENCES entries(id),
  status        TEXT NOT NULL DEFAULT 'scheduled',  -- scheduled | live | done | bye
  rallies       TEXT NOT NULL DEFAULT '',
  first_server  TEXT NOT NULL DEFAULT 'a',
  winner_id     INTEGER,
  court         TEXT,
  updated_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS entries_t ON entries(tournament_id);
CREATE INDEX IF NOT EXISTS matches_t ON matches(tournament_id, stage, round, slot);

CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,            -- stored lower-case
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                    -- sha256 of the cookie token
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Tournament team, keyed by email so people can be added before they sign up.
CREATE TABLE IF NOT EXISTS members (
  id            SERIAL PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL,                     -- owner | organiser | umpire
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, email)
);
CREATE INDEX IF NOT EXISTS members_email ON members(email);

-- Scoring-only share link, alongside the organiser link (admin_key).
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS scorer_key TEXT;
UPDATE tournaments SET scorer_key = replace(gen_random_uuid()::text, '-', '') WHERE scorer_key IS NULL;
`;

async function migrate(db) {
  try {
    await db.exec(SCHEMA);
  } catch (err) {
    // Two cold starts racing to create the same table; the other one won.
    if (!['23505', '42P07', '42701'].includes(err.code)) throw err;
  }
}

async function connectPostgres(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10_000 });
  const db = {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(async (sql, params) => (await client.query(sql, params)).rows);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  await migrate(db);
  return db;
}

async function connectEmbedded(dataDir) {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  const db = {
    query: async (sql, params) => (await pg.query(sql, params)).rows,
    exec: (sql) => pg.exec(sql),
    tx: (fn) => pg.transaction((t) => fn(async (sql, params) => (await t.query(sql, params)).rows)),
    close: () => pg.close(),
  };
  await migrate(db);
  return db;
}

// url: a postgres:// connection string, ':memory:' for a throwaway embedded
// database, or empty for an embedded database stored on disk.
function createDb(url = process.env.DATABASE_URL || process.env.POSTGRES_URL) {
  if (url && url !== ':memory:') return connectPostgres(url);
  if (process.env.VERCEL) {
    throw new Error('DATABASE_URL is not set. Add a Postgres database (e.g. Neon) to the Vercel project.');
  }
  if (url === ':memory:') return connectEmbedded(null);
  return connectEmbedded(process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pglite'));
}

module.exports = { createDb };
