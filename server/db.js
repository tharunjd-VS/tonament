'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tournaments (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  venue       TEXT,
  sport       TEXT NOT NULL,
  format      TEXT NOT NULL,
  config      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'setup',
  admin_key   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  seed          INTEGER NOT NULL,
  group_no      INTEGER
);
CREATE TABLE IF NOT EXISTS matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,              -- 'league' | 'knockout'
  group_no      INTEGER,
  round         INTEGER NOT NULL,
  slot          INTEGER NOT NULL DEFAULT 0,
  a_id          INTEGER REFERENCES entries(id),
  b_id          INTEGER REFERENCES entries(id),
  status        TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | live | done | bye
  rallies       TEXT NOT NULL DEFAULT '',
  first_server  TEXT NOT NULL DEFAULT 'a',
  winner_id     INTEGER,
  court         TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS entries_t ON entries(tournament_id);
CREATE INDEX IF NOT EXISTS matches_t ON matches(tournament_id, stage, round, slot);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction };
