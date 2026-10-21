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

CREATE TABLE IF NOT EXISTS password_resets (
  id          TEXT PRIMARY KEY,                    -- sha256 of the emailed token
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- "Request this sport" votes for sports that aren't playable yet.
CREATE TABLE IF NOT EXISTS sport_interest (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sport)
);

-- Event-day entries: check-in, self-entry, walk-ins, withdrawals.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS checked_in BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS in_draw BOOLEAN NOT NULL DEFAULT true;   -- false = didn't show at the start
ALTER TABLE entries ADD COLUMN IF NOT EXISTS withdrawn BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'organiser'; -- organiser | self | walk-in
ALTER TABLE entries ADD COLUMN IF NOT EXISTS contact TEXT;                              -- self-entry phone/email (organisers only)
-- (one self-entry per contact is enforced per event: see entries_event_contact below)
ALTER TABLE matches ADD COLUMN IF NOT EXISTS walkover BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS catch_up BOOLEAN NOT NULL DEFAULT false;  -- added for a late entry

-- Plans and payments (Event Pass via Razorpay).
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';   -- free | pass
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS plan_updated_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS payments (
  id            SERIAL PRIMARY KEY,
  tournament_id TEXT REFERENCES tournaments(id) ON DELETE SET NULL,
  tournament_name TEXT,
  user_email    TEXT,
  provider      TEXT NOT NULL DEFAULT 'razorpay',
  order_id      TEXT UNIQUE,
  payment_id    TEXT,
  amount        INTEGER NOT NULL,                    -- smallest unit (paise)
  currency      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'created',     -- created | paid | failed
  raw_event     JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS payments_t ON payments(tournament_id);

-- Scoring-only share link, alongside the organiser link (admin_key).
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS scorer_key TEXT;
UPDATE tournaments SET scorer_key = replace(gen_random_uuid()::text, '-', '') WHERE scorer_key IS NULL;

-- Self-entries beyond the free limit (or the organiser's maximum) wait for the
-- organiser to confirm them; they don't go into the draw until then.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS waiting_notified BOOLEAN NOT NULL DEFAULT false;

-- Who can see a tournament: private (team only) | link (anyone with the link) | public (also listed).
-- Existing tournaments stay public; new ones are created private.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';

-- Where and when, so players can find tournaments. Country and state names
-- come from public/regions.js; dates are 'YYYY-MM-DD' text (no time zones).
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS postcode TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS starts_on TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS ends_on TEXT;
CREATE INDEX IF NOT EXISTS tournaments_find ON tournaments (visibility, country, region, city, starts_on);

-- Events (categories) inside a tournament: Men's Singles, Mixed Doubles · U19,
-- … Each has its own format, entries, draw and status. Tournaments made
-- before events existed get one catch-all event holding their draw.
CREATE TABLE IF NOT EXISTS events (
  id            SERIAL PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  discipline    TEXT NOT NULL DEFAULT 'any',     -- singles | doubles | any
  gender        TEXT NOT NULL DEFAULT 'open',    -- men | women | mixed | open
  age           TEXT NOT NULL DEFAULT 'Open',
  level         TEXT NOT NULL DEFAULT 'Open',
  name          TEXT,                            -- optional; otherwise generated
  format        TEXT NOT NULL,
  config        JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'setup',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_t ON events(tournament_id, position);
ALTER TABLE entries ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id) ON DELETE CASCADE;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS event_id INTEGER REFERENCES events(id) ON DELETE CASCADE;
INSERT INTO events (tournament_id, format, config, status)
  SELECT t.id, t.format, t.config, t.status FROM tournaments t
  WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.tournament_id = t.id);
UPDATE entries SET event_id = (SELECT e.id FROM events e WHERE e.tournament_id = entries.tournament_id ORDER BY e.id LIMIT 1)
  WHERE event_id IS NULL;
UPDATE matches SET event_id = (SELECT e.id FROM events e WHERE e.tournament_id = matches.tournament_id ORDER BY e.id LIMIT 1)
  WHERE event_id IS NULL;
CREATE INDEX IF NOT EXISTS entries_event ON entries(event_id, seed);
CREATE INDEX IF NOT EXISTS matches_event ON matches(event_id, stage, round, slot);
-- One self-entry per phone/email per event (players may enter several events).
DROP INDEX IF EXISTS entries_contact;
CREATE UNIQUE INDEX IF NOT EXISTS entries_event_contact ON entries(event_id, contact) WHERE contact IS NOT NULL;

-- Tiered plans: which plan a payment bought (null = the original Event Pass).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS tier TEXT;

-- Entry fees, only for tournaments organised by Tonament itself (official).
-- A paid self-entry is saved as 'pending' until its payment arrives.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS official BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS fee_status TEXT;            -- pending | paid | cash | waived
ALTER TABLE entries ADD COLUMN IF NOT EXISTS fee_amount INTEGER;          -- paise
ALTER TABLE entries ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE payments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'plan';  -- plan | entry
ALTER TABLE payments ADD COLUMN IF NOT EXISTS entry_id INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS event_id INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS event_name TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS player TEXT;

-- Doubles players without a partner enter alone ("solo"); pairing two solos
-- creates a pair entry, and the solos point at it (they keep contacts/fees).
ALTER TABLE entries ADD COLUMN IF NOT EXISTS solo BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS solo_side TEXT;      -- mixed doubles: man | woman
ALTER TABLE entries ADD COLUMN IF NOT EXISTS paired_into INTEGER;

-- Tournament page content: about text, links, organiser branding (paid), and
-- images (cover, photos, logo, sponsors), stored here to keep hosting simple.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS about TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS links JSONB;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS branding JSONB;
CREATE TABLE IF NOT EXISTS media (
  id            TEXT PRIMARY KEY,                -- hash of tournament + kind + bytes
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,                   -- logo | cover | photo | sponsor
  mime          TEXT NOT NULL,
  bytes         BYTEA NOT NULL,
  caption       TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_t ON media(tournament_id, kind, position);

-- What an entry includes (meals, T-shirt, …) and other details for players.
-- Prizes live in each event's config.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS perks JSONB;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS notes TEXT;

-- A team's players (team events; optional, organisers only).
ALTER TABLE entries ADD COLUMN IF NOT EXISTS players JSONB;

-- Courts and the order of play: { names, minutes, auto } on the tournament;
-- a match's place pinned in the queue ("Play next") and when it was called.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS courts JSONB;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS queue_pos INTEGER;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS called_at TIMESTAMPTZ;

-- Start and finish times ("08:00"), the venue's local time.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS start_time TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS end_time TEXT;

-- Self-entries belong to the player's account (organisers' entries have none;
-- no foreign key, like members, which are matched to accounts by email).
ALTER TABLE entries ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS phone TEXT;
CREATE INDEX IF NOT EXISTS entries_user ON entries(user_id);
`;

// Bump when SCHEMA changes. Each cold start does one cheap check instead of
// re-running every CREATE/ALTER statement.
const SCHEMA_VERSION = 19;

async function migrate(db) {
  try {
    const [row] = await db.query('SELECT version FROM schema_meta');
    if (row && row.version >= SCHEMA_VERSION) return;
  } catch {
    /* first run: schema_meta doesn't exist yet */
  }
  try {
    await db.exec(`${SCHEMA}
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
DELETE FROM schema_meta;
INSERT INTO schema_meta (version) VALUES (${SCHEMA_VERSION});`);
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

module.exports = { createDb, migrate };
