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

-- Entry fees paid to the organiser directly (UPI or cash), confirmed by them:
-- the tournament's payment details { upi, payee, note, holdHours }, and per
-- entry the player's UPI reference, when they said they paid, and how long an
-- unpaid entry's place is held.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS payment JSONB;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS pay_ref TEXT;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS pay_sent_at TIMESTAMPTZ;
ALTER TABLE entries ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ;

-- v21: the admin dashboard. Admins can also be made in the app (besides
-- ADMIN_EMAILS), accounts can be disabled, plan payments refunded, and every
-- admin change is logged.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refund_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_amount INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS admin_log (
  id          SERIAL PRIMARY KEY,
  admin_email TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT,
  detail      JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- v22: academy & venue pages (tonament.com/@slug), a yearly paid page. Their
-- tournaments link to them; site-wide settings the admin can change.
CREATE TABLE IF NOT EXISTS orgs (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'academy',   -- academy | venue | club
  sports      TEXT[] NOT NULL DEFAULT '{}',
  about       TEXT,
  address     TEXT,
  city        TEXT,
  region      TEXT,
  postcode    TEXT,
  country     TEXT,
  phone       TEXT,
  whatsapp    TEXT,
  email       TEXT,
  website     TEXT,
  instagram   TEXT,
  courts      TEXT,
  timings     TEXT,
  coaching    JSONB,                             -- [{ title, who, when, fee }]
  accent      TEXT,
  paid_until  TIMESTAMPTZ,                       -- public while paid (plus a grace period)
  branding_override BOOLEAN,                     -- null: follow the site setting
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS org_members (
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,                     -- owner | editor
  PRIMARY KEY (org_id, email)
);
CREATE TABLE IF NOT EXISTS org_media (
  id          TEXT PRIMARY KEY,
  org_id      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                     -- logo | cover | photo
  mime        TEXT NOT NULL,
  bytes       BYTEA NOT NULL,
  caption     TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS org_media_o ON org_media(org_id, kind, position);
CREATE TABLE IF NOT EXISTS site_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS org_id INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS org_id INTEGER;

-- v23: player profiles (tonament.com/p/<handle>), the people behind each
-- entry (matched to accounts by email, like members), ranking results and DUPR.
ALTER TABLE users ADD COLUMN IF NOT EXISTS handle TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sports TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_public BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dupr_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dupr_singles NUMERIC(4,3);
ALTER TABLE users ADD COLUMN IF NOT EXISTS dupr_doubles NUMERIC(4,3);
ALTER TABLE users ADD COLUMN IF NOT EXISTS dupr_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dupr_synced_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS user_media (
  id          TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime        TEXT NOT NULL,
  bytes       BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Slot 0 is the player who entered (or the first named), slot 1 their partner.
CREATE TABLE IF NOT EXISTS entry_players (
  entry_id    INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  slot        INTEGER NOT NULL,
  name        TEXT NOT NULL,
  email       TEXT,
  dupr_id     TEXT,
  PRIMARY KEY (entry_id, slot)
);
CREATE INDEX IF NOT EXISTS entry_players_email ON entry_players(email);
INSERT INTO entry_players (entry_id, slot, name, email)
  SELECT e.id, 0, split_part(e.name, ' / ', 1), u.email FROM entries e JOIN users u ON u.id = e.user_id
  ON CONFLICT DO NOTHING;
INSERT INTO entry_players (entry_id, slot, name, email)
  SELECT s.paired_into, ROW_NUMBER() OVER (PARTITION BY s.paired_into ORDER BY s.id) - 1, s.name, u.email
  FROM entries s JOIN users u ON u.id = s.user_id WHERE s.paired_into IS NOT NULL
  ON CONFLICT DO NOTHING;
-- One row per player per finished event (rewritten if a result changes).
CREATE TABLE IF NOT EXISTS event_results (
  event_id      INTEGER NOT NULL,
  email         TEXT NOT NULL,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  entry_id      INTEGER NOT NULL,
  sport         TEXT NOT NULL,
  category      TEXT,                          -- ms, xd-u19, … (null: not ranked)
  finish        TEXT NOT NULL,                 -- W F SF QF R16 R32 G
  points        INTEGER NOT NULL DEFAULT 0,
  entries       INTEGER NOT NULL,
  won           INTEGER NOT NULL DEFAULT 0,
  lost          INTEGER NOT NULL DEFAULT 0,
  matches       JSONB,                         -- [{ round, opponent, won, draw, score }]
  finished_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, email)
);
CREATE INDEX IF NOT EXISTS event_results_rank ON event_results(sport, category, finished_at);
CREATE INDEX IF NOT EXISTS event_results_email ON event_results(email);
-- v24: sign in with an emailed link (no password needed); the phone stays signed in.
CREATE TABLE IF NOT EXISTS sign_in_links (
  id          TEXT PRIMARY KEY,                  -- sha256 of the emailed token
  email       TEXT NOT NULL,
  next        TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sign_in_links_email ON sign_in_links(email, created_at);
-- v26: links work a few times (mail scanners open them first), and the tab
-- that asked signs in when the link is opened elsewhere (poll_hash).
ALTER TABLE sign_in_links ADD COLUMN IF NOT EXISTS uses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sign_in_links ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE sign_in_links ADD COLUMN IF NOT EXISTS poll_hash TEXT;
ALTER TABLE sign_in_links ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS sign_in_links_poll ON sign_in_links(poll_hash);
-- Groups: people who play together every day. A schedule makes sessions;
-- members RSVP and check in; games are suggested, scored live by players and
-- confirmed by the losing side; confirmed games move each member's rating.
CREATE TABLE IF NOT EXISTS groups (
  id           SERIAL PRIMARY KEY,
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  sport        TEXT NOT NULL,
  city         TEXT,
  venue        TEXT,
  about        TEXT,
  invite_token TEXT NOT NULL,
  settings     JSONB NOT NULL,             -- { days, time, timeZone, courts, maxPlayers, hours, scoring, singles }
  created_by   INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',  -- admin | member
  status     TEXT NOT NULL DEFAULT 'active',  -- active | requested
  rating     INTEGER NOT NULL DEFAULT 1000,
  games      INTEGER NOT NULL DEFAULT 0,
  wins       INTEGER NOT NULL DEFAULT 0,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id);
CREATE TABLE IF NOT EXISTS group_sessions (
  id         SERIAL PRIMARY KEY,
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  starts_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (group_id, starts_at)
);
CREATE TABLE IF NOT EXISTS session_players (
  session_id    INTEGER NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL,              -- in | waitlist | out
  rsvp_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  checked_in_at TIMESTAMPTZ,
  PRIMARY KEY (session_id, user_id)
);
CREATE TABLE IF NOT EXISTS group_games (
  id           SERIAL PRIMARY KEY,
  group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  session_id   INTEGER REFERENCES group_sessions(id) ON DELETE SET NULL,
  court        INTEGER NOT NULL,
  a1 INTEGER NOT NULL, a2 INTEGER, b1 INTEGER NOT NULL, b2 INTEGER,
  rallies      TEXT NOT NULL DEFAULT '',
  first_server TEXT NOT NULL DEFAULT 'a',
  status       TEXT NOT NULL DEFAULT 'live',   -- live | done | confirmed | disputed | void
  winner       TEXT,                           -- a | b
  final        JSONB,                          -- { a, b } when entered as a final score
  deltas       JSONB,                          -- rating changes, by user id
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  confirmed_by INTEGER
);
CREATE INDEX IF NOT EXISTS group_games_session ON group_games(session_id, status);
CREATE INDEX IF NOT EXISTS group_games_group ON group_games(group_id, ended_at);
-- v25: when a player expects to arrive ('HH:MM'); a group hosted by a venue or academy page.
ALTER TABLE session_players ADD COLUMN IF NOT EXISTS eta TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES orgs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS groups_org ON groups(org_id);
-- v27: guest players a group admin adds by name; they can't sign in until
-- someone claims the spot (their games and rating move to that account).
ALTER TABLE users ADD COLUMN IF NOT EXISTS guest BOOLEAN NOT NULL DEFAULT false;
-- v28: an entry's level (Beginner, Beginner+, …) for Open events split into level pools.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS level TEXT;
-- v29: on the day. away_since: checked in but not at the court ("not here
-- yet"; their matches wait). retired: the side that retired mid-match.
ALTER TABLE entries ADD COLUMN IF NOT EXISTS away_since TIMESTAMPTZ;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS retired TEXT;
-- v30: team rosters (a captain, players linked by email) and payments per
-- player: paid | waived (null: not yet).
ALTER TABLE entry_players ADD COLUMN IF NOT EXISTS captain BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE entry_players ADD COLUMN IF NOT EXISTS fee_status TEXT;
CREATE TABLE IF NOT EXISTS dupr_submissions (
  match_id    INTEGER PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed
  dupr_match  TEXT,
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- v31: referrals. Each organiser has a code for their invite link; a friend
-- who signs up with it gets their first tournament on the Club plan, and the
-- inviter earns a free upgrade once the friend runs one (plan_credits).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ref_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_ref_code ON users(ref_code);
ALTER TABLE sign_in_links ADD COLUMN IF NOT EXISTS ref TEXT;
CREATE TABLE IF NOT EXISTS plan_credits (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tier          TEXT NOT NULL,                   -- club | open
  reason        TEXT NOT NULL,                   -- welcome | referral | milestone
  friend_id     INTEGER,                         -- who earned it (the referred friend)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at       TIMESTAMPTZ,
  tournament_id TEXT,
  UNIQUE (user_id, reason, friend_id)
);
CREATE INDEX IF NOT EXISTS plan_credits_user ON plan_credits(user_id, used_at);
-- v32: one phone scores a match at a time. The device that's scoring it (an
-- id the app keeps on the phone), who that is, and when it last scored.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS scorer_device TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS scorer_name TEXT;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS scorer_seen_at TIMESTAMPTZ;
-- v33: the rules a match was played under ({ scoring, leagueDraws }), kept when
-- the organiser changes the event's match length mid-event (null: the event's).
ALTER TABLE matches ADD COLUMN IF NOT EXISTS rules JSONB;
-- v34: clubs and the social layer. Any page (orgs) is a club anyone can make
-- for free: kinds club | team | academy | venue | company | school | coaching.
-- club_members are its players (by account); org_members stay the page team.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS invite_token TEXT;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS open BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS created_by INTEGER;
CREATE TABLE IF NOT EXISTS club_members (
  org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'player',     -- admin | captain | coach | player
  status     TEXT NOT NULL DEFAULT 'active',     -- active | requested
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS club_members_user ON club_members(user_id, status);
ALTER TABLE entries ADD COLUMN IF NOT EXISTS org_id INTEGER;
-- Following people, clubs, tournaments and groups (target_id as text).
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                     -- user | club | tournament | group
  target_id   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, kind, target_id)
);
CREATE INDEX IF NOT EXISTS follows_target ON follows(kind, target_id);
-- What happened: one row per feed item. people: everyone it's about (for
-- "people I follow" and their profiles); dedupe: one row per fact.
CREATE TABLE IF NOT EXISTS activity (
  id          SERIAL PRIMARY KEY,
  dedupe      TEXT UNIQUE,
  actor_id    INTEGER,
  people      INTEGER[] NOT NULL DEFAULT '{}',
  org_id      INTEGER,
  sport       TEXT,
  verb        TEXT NOT NULL,                     -- finish | game | joined | club | …
  object_kind TEXT,
  object_id   TEXT,
  data        JSONB NOT NULL DEFAULT '{}',
  visibility  TEXT NOT NULL DEFAULT 'public',    -- public | followers | club
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_created ON activity(created_at DESC);
CREATE INDEX IF NOT EXISTS activity_org ON activity(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_object ON activity(object_kind, object_id);
CREATE TABLE IF NOT EXISTS reactions (
  activity_id INTEGER NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments (
  id          SERIAL PRIMARY KEY,
  activity_id INTEGER NOT NULL REFERENCES activity(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_activity ON comments(activity_id, created_at);
CREATE TABLE IF NOT EXISTS blocks (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS reports (
  id          SERIAL PRIMARY KEY,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,                     -- comment | activity | user | club
  target_id   TEXT NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
-- Under 18: kept out of public feeds (birth year, optional, on the profile).
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_year INTEGER;
-- Every existing page's team are its first club admins.
INSERT INTO club_members (org_id, user_id, role)
  SELECT m.org_id, u.id, 'admin' FROM org_members m JOIN users u ON u.email = m.email
  ON CONFLICT DO NOTHING;
-- The feed starts with past podiums (winners and finalists).
INSERT INTO activity (dedupe, actor_id, people, sport, verb, object_kind, object_id, data, visibility, created_at)
  SELECT 'finish:' || r.event_id || ':' || u.id, u.id, ARRAY[u.id], r.sport, 'finish', 'event', r.event_id::text,
    jsonb_build_object('finish', r.finish, 'tournamentId', t.id, 'tournament', t.name, 'event', e.name, 'entries', r.entries),
    'public', r.finished_at
  FROM event_results r JOIN users u ON u.email = r.email JOIN tournaments t ON t.id = r.tournament_id JOIN events e ON e.id = r.event_id
  WHERE r.finish IN ('W', 'F') AND t.visibility = 'public' AND u.profile_public
  ON CONFLICT (dedupe) DO NOTHING;
-- v35: notifications. One row per thing to tell someone (the 🔔 inbox), sent
-- on as a push to their phones (push_subscriptions) and, for the important
-- ones, by email; notify_prefs turns each off; notify_token unsubscribes.
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dedupe     TEXT,
  kind       TEXT NOT NULL,                       -- comment | kudos | follow | club_request | club_joined | confirm_game | …
  actor_id   INTEGER,
  title      TEXT NOT NULL,
  body       TEXT,
  url        TEXT,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe)
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_prefs JSONB NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_token TEXT;
-- v36: challenges. One player (or pair) challenges another to a game; it's
-- scored like a group game (live, or the final score) and the losing side
-- confirms it. ratings: one Tonament rating per player per sport, from every
-- confirmed game (challenges and group games).
CREATE TABLE IF NOT EXISTS challenges (
  id           SERIAL PRIMARY KEY,
  sport        TEXT NOT NULL,
  scoring      JSONB NOT NULL DEFAULT '{}',
  a1           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the challenger's side
  a2           INTEGER REFERENCES users(id) ON DELETE CASCADE,
  b1           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the challenged side
  b2           INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_by   INTEGER NOT NULL,
  org_id       INTEGER,                                                 -- from a club's page
  parent_id    INTEGER,                                                 -- "challenge back"
  status       TEXT NOT NULL DEFAULT 'sent',  -- sent | accepted | declined | cancelled | live | done | confirmed | disputed
  message      TEXT,
  place        TEXT,
  play_at      TIMESTAMPTZ,
  rallies      TEXT NOT NULL DEFAULT '',
  first_server TEXT NOT NULL DEFAULT 'a',
  final        JSONB,
  winner       TEXT,
  ended_at     TIMESTAMPTZ,
  confirmed_by INTEGER,
  deltas       JSONB,
  responded_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS challenges_a ON challenges(a1, created_at DESC);
CREATE INDEX IF NOT EXISTS challenges_b ON challenges(b1, created_at DESC);
CREATE TABLE IF NOT EXISTS ratings (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport      TEXT NOT NULL,
  rating     INTEGER NOT NULL DEFAULT 1000,
  games      INTEGER NOT NULL DEFAULT 0,
  wins       INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, sport)
);
CREATE INDEX IF NOT EXISTS ratings_sport ON ratings(sport, rating DESC);
-- A group game's change to the Tonament rating (to undo it if the game's voided).
ALTER TABLE group_games ADD COLUMN IF NOT EXISTS rating_deltas JSONB;
-- v37: club ladders. Members join at the bottom and challenge up to "reach"
-- places above; a challenger who wins takes the place (everyone between moves
-- down one). A ladder challenge left unanswered for a week is a forfeit.
CREATE TABLE IF NOT EXISTS ladders (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  sport      TEXT NOT NULL,
  name       TEXT NOT NULL,
  reach      INTEGER NOT NULL DEFAULT 3,
  scoring    JSONB NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'active',      -- active | closed
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ladders_org ON ladders(org_id);
CREATE TABLE IF NOT EXISTS ladder_rungs (
  ladder_id      INTEGER NOT NULL REFERENCES ladders(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  joined_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_change_at TIMESTAMPTZ,
  PRIMARY KEY (ladder_id, user_id)
);
CREATE INDEX IF NOT EXISTS ladder_rungs_position ON ladder_rungs(ladder_id, position);
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS ladder_id INTEGER;
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS ladder_at JSONB;   -- { a, b }: their places when it was sent
-- v38: goals. "30 games this month": personal (each person who joins chases
-- the target), a club's total, or club v club. Progress counts confirmed group
-- games, challenges and tournament matches between starts_at and ends_at.
CREATE TABLE IF NOT EXISTS goals (
  id          SERIAL PRIMARY KEY,
  scope       TEXT NOT NULL,                      -- personal | club | versus
  title       TEXT NOT NULL,
  metric      TEXT NOT NULL,                      -- games | wins
  sport       TEXT,                               -- null: any sport
  target      INTEGER,                            -- per person (personal), the total (club); optional for versus
  org_id      INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  rival_id    INTEGER REFERENCES orgs(id) ON DELETE CASCADE,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ NOT NULL,
  created_by  INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS goals_org ON goals(org_id);
CREATE TABLE IF NOT EXISTS goal_members (
  goal_id   INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id    INTEGER,                              -- their side, in club v club
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (goal_id, user_id)
);
CREATE INDEX IF NOT EXISTS goal_members_user ON goal_members(user_id);
-- v39: team ties in racket sports (public/sports/tie.js). A tie is a match
-- between two team entries, played as several rubbers. Each captain's
-- line-up (roster slots per rubber) stays sealed until both are in; then the
-- rubbers are made and scored like matches. The tie's rallies are the
-- rubbers' winners in the order they finished.
CREATE TABLE IF NOT EXISTS lineups (
  match_id     INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  side         TEXT NOT NULL,                     -- a | b
  slots        JSONB NOT NULL,                    -- [[slot], [slot, slot], …] per rubber
  submitted_by INTEGER,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, side)
);
CREATE TABLE IF NOT EXISTS rubbers (
  id           SERIAL PRIMARY KEY,
  match_id     INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  label        TEXT NOT NULL,                     -- S1, D, MS, XD, …
  kind         TEXT NOT NULL,                     -- singles | doubles
  a_slots      INTEGER[] NOT NULL,
  b_slots      INTEGER[] NOT NULL,
  rallies      TEXT NOT NULL DEFAULT '',
  first_server TEXT NOT NULL DEFAULT 'a',
  final        JSONB,
  winner       TEXT,
  status       TEXT NOT NULL DEFAULT 'live',      -- live | done
  finished_at  TIMESTAMPTZ,
  UNIQUE (match_id, position)
);
-- v40: club v club. One club challenges another to a one-off team match: a
-- tie (racket sports) or a friendly (team sports). Accepting it makes a small
-- link-only tournament (two club entries, one match) that's scored as usual;
-- when it's finished the result goes on both clubs' records and feeds.
CREATE TABLE IF NOT EXISTS club_challenges (
  id            SERIAL PRIMARY KEY,
  from_org      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  to_org        INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  sport         TEXT NOT NULL,
  tie           JSONB,                            -- the tie format; null for a friendly
  play_at       TIMESTAMPTZ,
  place         TEXT,
  message       TEXT,
  status        TEXT NOT NULL DEFAULT 'sent',     -- sent | accepted | declined | cancelled | expired | played
  tournament_id TEXT,
  winner_org    INTEGER,                          -- null when played: a draw
  score         TEXT,                             -- the winner's side first, e.g. 2-1
  created_by    INTEGER NOT NULL,
  responded_by  INTEGER,
  responded_at  TIMESTAMPTZ,
  played_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_challenges_from ON club_challenges(from_org, created_at DESC);
CREATE INDEX IF NOT EXISTS club_challenges_to ON club_challenges(to_org, created_at DESC);
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS club_challenge_id INTEGER;
-- v41: club seasons. A league between clubs, run by a host club: clubs enter
-- by link before it starts, each picks its team from its members, and every
-- club plays every other once (a tie in racket sports, a match in team
-- sports). It's a link-only league tournament with the clubs as entries.
CREATE TABLE IF NOT EXISTS seasons (
  id            SERIAL PRIMARY KEY,
  host_org      INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sport         TEXT NOT NULL,
  tie           JSONB,                            -- the tie format; null in team sports
  status        TEXT NOT NULL DEFAULT 'open',     -- open | on | done
  tournament_id TEXT NOT NULL,
  champion_org  INTEGER,
  created_by    INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seasons_host ON seasons(host_org);
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS season_id INTEGER;
-- v42: runs. Anyone logs a run (distance, time, when); it goes to the feed
-- (public or followers) unless private, counts in km/runs goals, and makes
-- best efforts at the standard distances.
CREATE TABLE IF NOT EXISTS runs (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  distance_m  INTEGER NOT NULL,
  duration_s  INTEGER NOT NULL,
  ran_at      TIMESTAMPTZ NOT NULL,
  title       TEXT,
  place       TEXT,
  visibility  TEXT NOT NULL DEFAULT 'public',   -- public | followers | private
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_user ON runs(user_id, ran_at DESC);
-- v43: club runs. A club's weekly run (day, time, meeting point); members say
-- they're coming to a date, an admin marks who ran, and runners log it with
-- one tap (runs.club_run_id / on_date link a logged run to that date).
CREATE TABLE IF NOT EXISTS club_runs (
  id         SERIAL PRIMARY KEY,
  org_id     INTEGER NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  weekday    INTEGER NOT NULL,                  -- 0 Sunday … 6 Saturday
  at_time    TEXT NOT NULL,                     -- HH:MM, India time
  place      TEXT NOT NULL,
  distance   TEXT,                              -- e.g. 5 / 10 km
  active     BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_runs_org ON club_runs(org_id);
CREATE TABLE IF NOT EXISTS club_run_people (
  club_run_id INTEGER NOT NULL REFERENCES club_runs(id) ON DELETE CASCADE,
  on_date     DATE NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  going       BOOLEAN NOT NULL DEFAULT false,
  attended    BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (club_run_id, on_date, user_id)
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS club_run_id INTEGER;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS on_date DATE;
-- v44: races. An organiser (or a club) sets up a race with distances;
-- runners enter and get bibs; the organiser enters finish times by bib;
-- publishing ranks them (overall, gender, age group), turns each finisher's
-- time into a run and posts it to the feed.
CREATE TABLE IF NOT EXISTS races (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  org_id       INTEGER REFERENCES orgs(id) ON DELETE SET NULL,
  starts_at    TIMESTAMPTZ NOT NULL,
  place        TEXT NOT NULL,
  city         TEXT,
  visibility   TEXT NOT NULL DEFAULT 'public',   -- public | link
  status       TEXT NOT NULL DEFAULT 'open',     -- open | closed | done
  created_by   INTEGER NOT NULL,
  published_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS race_events (
  id         SERIAL PRIMARY KEY,
  race_id    INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  distance_m INTEGER NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS race_entries (
  id         SERIAL PRIMARY KEY,
  race_id    INTEGER NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  event_id   INTEGER NOT NULL REFERENCES race_events(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  gender     TEXT NOT NULL DEFAULT 'x',          -- m | f | x
  birth_year INTEGER,
  bib        INTEGER NOT NULL,
  finish_s   INTEGER,
  status     TEXT NOT NULL DEFAULT 'entered',    -- entered | finished | dnf
  run_id     INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (race_id, bib)
);
CREATE INDEX IF NOT EXISTS race_entries_user ON race_entries(user_id);
-- v45: track meets (athletics, swimming, track cycling). Events are measured
-- (a time, a distance or a height). Timed events with more entries than
-- lanes run heats, and the best marks make the final; places score team
-- points for each athlete's team.
CREATE TABLE IF NOT EXISTS meets (
  id          SERIAL PRIMARY KEY,
  sport       TEXT NOT NULL,                     -- athletics | swimming | cycling
  name        TEXT NOT NULL,
  org_id      INTEGER REFERENCES orgs(id) ON DELETE SET NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  place       TEXT NOT NULL,
  city        TEXT,
  lanes       INTEGER NOT NULL DEFAULT 8,
  points      JSONB NOT NULL DEFAULT '[8,6,5,4,3,2,1]',
  visibility  TEXT NOT NULL DEFAULT 'public',
  status      TEXT NOT NULL DEFAULT 'open',      -- open | on | done
  created_by  INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS meet_events (
  id        SERIAL PRIMARY KEY,
  meet_id   INTEGER NOT NULL REFERENCES meets(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,                       -- 100m, Long jump, …
  kind      TEXT NOT NULL,                       -- time | distance | height
  gender    TEXT NOT NULL DEFAULT 'x',           -- m | f | x
  position  INTEGER NOT NULL DEFAULT 0,
  stage     TEXT NOT NULL DEFAULT 'entries'      -- entries | heats | final | done
);
CREATE TABLE IF NOT EXISTS meet_entries (
  id         SERIAL PRIMARY KEY,
  meet_id    INTEGER NOT NULL REFERENCES meets(id) ON DELETE CASCADE,
  event_id   INTEGER NOT NULL REFERENCES meet_events(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  team       TEXT,
  heat       INTEGER,
  heat_lane  INTEGER,
  heat_mark  NUMERIC,
  in_final   BOOLEAN NOT NULL DEFAULT false,
  lane       INTEGER,
  mark       NUMERIC,
  status     TEXT NOT NULL DEFAULT 'ok',         -- ok | dns | dnf | dq
  place      INTEGER,
  pb         BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meet_entries_event ON meet_entries(event_id);
CREATE INDEX IF NOT EXISTS meet_entries_user ON meet_entries(user_id);
-- v46: motorsport championships (karting and the like). Drivers (a number,
-- a team) race rounds: qualifying times set the grid, the race is entered as
-- finishing positions (laps, best lap, DNF/DSQ), points per position plus the
-- fastest lap, and the drivers' and teams' standings add up.
CREATE TABLE IF NOT EXISTS champs (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  series      TEXT,                              -- the class: Rotax Senior, Rental karts, …
  org_id      INTEGER REFERENCES orgs(id) ON DELETE SET NULL,
  points      JSONB NOT NULL DEFAULT '[25,18,15,12,10,8,6,4,2,1]',
  fastest_lap INTEGER NOT NULL DEFAULT 1,
  visibility  TEXT NOT NULL DEFAULT 'public',
  status      TEXT NOT NULL DEFAULT 'on',        -- on | done
  created_by  INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS champ_drivers (
  id        SERIAL PRIMARY KEY,
  champ_id  INTEGER NOT NULL REFERENCES champs(id) ON DELETE CASCADE,
  user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name      TEXT NOT NULL,
  number    INTEGER NOT NULL,
  team      TEXT,
  UNIQUE (champ_id, number)
);
CREATE TABLE IF NOT EXISTS champ_rounds (
  id        SERIAL PRIMARY KEY,
  champ_id  INTEGER NOT NULL REFERENCES champs(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  place     TEXT,
  starts_at TIMESTAMPTZ,
  position  INTEGER NOT NULL DEFAULT 0,
  stage     TEXT NOT NULL DEFAULT 'qualifying'   -- qualifying | race | done
);
CREATE TABLE IF NOT EXISTS champ_results (
  round_id   INTEGER NOT NULL REFERENCES champ_rounds(id) ON DELETE CASCADE,
  driver_id  INTEGER NOT NULL REFERENCES champ_drivers(id) ON DELETE CASCADE,
  quali_s    NUMERIC,
  grid       INTEGER,
  finish     INTEGER,                            -- the finishing position entered
  laps       INTEGER,
  best_lap_s NUMERIC,
  status     TEXT NOT NULL DEFAULT 'ok',         -- ok | dnf | dns | dsq
  position   INTEGER,                            -- classified position (after DNF/DSQ)
  points     INTEGER NOT NULL DEFAULT 0,
  fastest    BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (round_id, driver_id)
);
-- v47: the club a player represents (shown on race results, the default
-- when entering meets), and a race entry's club.
ALTER TABLE users ADD COLUMN IF NOT EXISTS rep_org_id INTEGER;
ALTER TABLE race_entries ADD COLUMN IF NOT EXISTS team TEXT;
-- v48: when each rally was scored (milliseconds, beside the rallies string;
-- see server/rally-times.js), for video, highlights and stats later.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS rally_times JSONB;
ALTER TABLE rubbers ADD COLUMN IF NOT EXISTS rally_times JSONB;
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS rally_times JSONB;
ALTER TABLE group_games ADD COLUMN IF NOT EXISTS rally_times JSONB;
-- v49: messaging (email now; WhatsApp and SMS once switched on, see
-- server/messaging.js), phone sign-in codes, scheduled jobs, and where
-- people and tournaments come from (users.source: the first touch).
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS source JSONB;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS source JSONB;
ALTER TABLE sign_in_links ADD COLUMN IF NOT EXISTS source JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_verified ON users (phone) WHERE phone_verified_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS otp_codes (
  id          SERIAL PRIMARY KEY,
  target      TEXT NOT NULL,                   -- a phone (E.164)
  purpose     TEXT NOT NULL,                   -- login | reset | verify
  code_hash   TEXT NOT NULL,
  ip          TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_codes_target ON otp_codes (target, created_at);
CREATE TABLE IF NOT EXISTS message_log (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER,
  channel     TEXT NOT NULL,                   -- email | whatsapp | sms
  template    TEXT NOT NULL,
  provider    TEXT,
  recipient   TEXT,
  provider_id TEXT,
  status      TEXT NOT NULL,                   -- sent | failed | skipped
  error       TEXT,
  cost_paise  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_log_day ON message_log (channel, created_at);
CREATE TABLE IF NOT EXISTS cron_runs (
  id          SERIAL PRIMARY KEY,
  job         TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  ok          BOOLEAN,
  detail      JSONB
);
CREATE INDEX IF NOT EXISTS cron_runs_job ON cron_runs (job, started_at);
-- v50: templates: a tournament's events and settings, saved to start new
-- ones from (no dates, entries or results).
CREATE TABLE IF NOT EXISTS tournament_templates (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sport       TEXT NOT NULL,
  setup       JSONB NOT NULL,
  from_tournament TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tournament_templates_user ON tournament_templates (user_id, created_at);
`;

// Bump when SCHEMA changes. Each cold start does one cheap check instead of
// re-running every CREATE/ALTER statement.
const SCHEMA_VERSION = 50;

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
