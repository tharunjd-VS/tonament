'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const sports = require('./sports');
const formats = require('./formats');
const { transaction } = require('./db');

const FORMATS = {
  league_knockout: 'League + Knockout',
  league: 'League',
  knockout: 'Knockout',
};
const MAX_ENTRIES = 128;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

function text(value, label, { max = 80, optional = false } = {}) {
  const s = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!s) {
    if (optional) return null;
    fail(400, `${label} is required`);
  }
  if (s.length > max) fail(400, `${label} must be at most ${max} characters`);
  return s;
}

function int(value, min, max, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
}

function slugify(name) {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');
  return slug || 'tournament';
}

const groupName = (no) => `Group ${String.fromCharCode(65 + no)}`;

function createService(db) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const emit = (tournamentId, payload) => events.emit('change', tournamentId, payload);

  const q = {
    list: db.prepare(`
      SELECT t.id, t.name, t.venue, t.sport, t.format, t.status, t.created_at AS createdAt,
             (SELECT COUNT(*) FROM entries e WHERE e.tournament_id = t.id) AS entries
      FROM tournaments t ORDER BY t.created_at DESC, t.rowid DESC LIMIT 100`),
    tournament: db.prepare('SELECT * FROM tournaments WHERE id = ?'),
    insertTournament: db.prepare(
      'INSERT INTO tournaments (id, name, venue, sport, format, config, admin_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    updateTournament: db.prepare('UPDATE tournaments SET name = ?, venue = ?, format = ?, config = ? WHERE id = ?'),
    setConfig: db.prepare('UPDATE tournaments SET config = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE tournaments SET status = ? WHERE id = ?'),
    deleteTournament: db.prepare('DELETE FROM tournaments WHERE id = ?'),
    entries: db.prepare('SELECT id, name, seed, group_no FROM entries WHERE tournament_id = ? ORDER BY seed, id'),
    insertEntry: db.prepare('INSERT INTO entries (tournament_id, name, seed) VALUES (?, ?, ?)'),
    deleteEntry: db.prepare('DELETE FROM entries WHERE id = ? AND tournament_id = ?'),
    setSeed: db.prepare('UPDATE entries SET seed = ? WHERE id = ? AND tournament_id = ?'),
    setGroup: db.prepare('UPDATE entries SET group_no = ? WHERE id = ?'),
    matches: db.prepare(
      `SELECT * FROM matches WHERE tournament_id = ? ORDER BY stage = 'knockout', round, group_no, slot, id`,
    ),
    match: db.prepare('SELECT * FROM matches WHERE id = ? AND tournament_id = ?'),
    koMatch: db.prepare(`SELECT * FROM matches WHERE tournament_id = ? AND stage = 'knockout' AND round = ? AND slot = ?`),
    byes: db.prepare(`SELECT * FROM matches WHERE tournament_id = ? AND stage = 'knockout' AND status = 'bye'`),
    pendingLeague: db.prepare(
      `SELECT COUNT(*) AS n FROM matches WHERE tournament_id = ? AND stage = 'league' AND status != 'done'`,
    ),
    insertMatch: db.prepare(
      `INSERT INTO matches (tournament_id, stage, group_no, round, slot, a_id, b_id, status, winner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    saveScore: db.prepare(
      `UPDATE matches SET rallies = ?, status = ?, winner_id = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
    saveMeta: db.prepare(
      `UPDATE matches SET court = ?, first_server = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
    ),
  };

  // ---------- loading & auth

  function load(id) {
    const row = q.tournament.get(String(id));
    if (!row) fail(404, 'Tournament not found');
    return { ...row, config: JSON.parse(row.config), sportDef: sports.get(row.sport) };
  }

  function isAdmin(t, key) {
    if (typeof key !== 'string' || !key) return false;
    const a = Buffer.from(key);
    const b = Buffer.from(t.admin_key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function admin(id, key) {
    const t = load(id);
    if (!isAdmin(t, key)) fail(403, 'Only the organiser can do that');
    return t;
  }

  function loadMatch(t, mid) {
    const m = q.match.get(Number(mid), t.id);
    if (!m) fail(404, 'Match not found');
    return m;
  }

  const setStatus = (t, status) => {
    q.setStatus.run(status, t.id);
    t.status = status;
  };

  function buildConfig(input, sport, prev = {}) {
    return {
      ...prev,
      groups: int(input.groups, 1, 16, prev.groups ?? 2, 'Number of groups'),
      qualifiers: int(input.qualifiers, 1, 8, prev.qualifiers ?? 2, 'Qualifiers per group'),
      scoring: sport.normalizeConfig(input.scoring ?? prev.scoring),
    };
  }

  // ---------- views

  function matchView(t, m, score, names) {
    const side = (id) => (id == null ? null : { id, name: names.get(id) ?? 'Unknown' });
    return {
      id: m.id,
      stage: m.stage,
      group: m.group_no,
      groupName: m.group_no == null ? null : groupName(m.group_no),
      round: m.round,
      slot: m.slot,
      roundName: m.stage === 'knockout' ? formats.roundName(m.round, t.config.knockoutRounds) : `Round ${m.round}`,
      a: side(m.a_id),
      b: side(m.b_id),
      status: m.status,
      court: m.court,
      firstServer: m.first_server,
      rallies: m.rallies.length,
      winner: m.winner_id,
      score,
      summary: t.sportDef.summary(score),
      updatedAt: m.updated_at,
    };
  }

  const namesOf = (t) => new Map(q.entries.all(t.id).map((e) => [e.id, e.name]));
  const scoreOf = (t, m) => t.sportDef.compute(m.rallies, t.config.scoring, m.first_server);

  function resultOf(m, score) {
    return {
      a: m.a_id,
      b: m.b_id,
      winner: m.winner_id,
      gamesA: score.gamesWon.a,
      gamesB: score.gamesWon.b,
      pointsA: score.totals.a,
      pointsB: score.totals.b,
    };
  }

  function groupStandings(t, entries, scored, names) {
    if (t.format === 'knockout' || t.status === 'setup') return [];
    return Array.from({ length: t.config.groups }, (_, g) => {
      const members = entries.filter((e) => e.group_no === g).map((e) => e.id);
      const results = scored
        .filter(({ row }) => row.stage === 'league' && row.group_no === g && row.status === 'done')
        .map(({ row, score }) => resultOf(row, score));
      return {
        no: g,
        name: groupName(g),
        standings: formats.standings(members, results).map((r) => ({ ...r, name: names.get(r.id) })),
      };
    });
  }

  function view(t, key) {
    const entries = q.entries.all(t.id);
    const names = new Map(entries.map((e) => [e.id, e.name]));
    const scored = q.matches.all(t.id).map((row) => ({ row, score: scoreOf(t, row) }));
    const groups = groupStandings(t, entries, scored, names);
    const matches = scored.map(({ row, score }) => matchView(t, row, score, names));

    let champion = null;
    if (t.status === 'completed') {
      const final = matches.find((m) => m.stage === 'knockout' && m.round === t.config.knockoutRounds);
      if (final) champion = final.winner && { id: final.winner, name: names.get(final.winner) };
      else if (groups.length === 1) champion = groups[0].standings[0];
    }

    const { admin_key: _k, sportDef, config, created_at: createdAt, ...rest } = t;
    return {
      ...rest,
      createdAt,
      sport: { id: sportDef.id, name: sportDef.name },
      formatName: FORMATS[t.format],
      config,
      isAdmin: isAdmin(t, key),
      entries: entries.map((e) => ({ id: e.id, name: e.name, seed: e.seed, group: e.group_no })),
      groups,
      matches,
      champion: champion && { id: champion.id, name: champion.name },
    };
  }

  function publishMatch(t, matchId, structural) {
    const row = q.match.get(matchId, t.id);
    const match = matchView(t, row, scoreOf(t, row), namesOf(t));
    emit(t.id, { type: 'match', match });
    if (structural) emit(t.id, { type: 'tournament' });
    return match;
  }

  // ---------- tournaments

  function listTournaments() {
    return q.list.all().map((r) => ({ ...r, formatName: FORMATS[r.format] }));
  }

  function getTournament(id, key) {
    return view(load(id), key);
  }

  function createTournament(input = {}) {
    const name = text(input.name, 'Tournament name');
    const venue = text(input.venue, 'Venue', { optional: true });
    const sport = sports.get(input.sport || 'badminton');
    if (!sport) fail(400, 'Unknown sport');
    const format = FORMATS[input.format] ? input.format : 'league_knockout';
    const config = buildConfig(input, sport);
    const id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
    const adminKey = crypto.randomBytes(18).toString('base64url');
    q.insertTournament.run(id, name, venue, sport.id, format, JSON.stringify(config), adminKey);
    return { id, adminKey };
  }

  function updateSettings(id, key, input = {}) {
    const t = admin(id, key);
    if (t.status !== 'setup') fail(409, 'Settings are locked once the tournament has started');
    const name = input.name === undefined ? t.name : text(input.name, 'Tournament name');
    const venue = input.venue === undefined ? t.venue : text(input.venue, 'Venue', { optional: true });
    const format = input.format === undefined ? t.format : FORMATS[input.format] ? input.format : fail(400, 'Unknown format');
    const config = buildConfig(input, t.sportDef, t.config);
    q.updateTournament.run(name, venue, format, JSON.stringify(config), t.id);
    emit(t.id, { type: 'tournament' });
    return getTournament(id, key);
  }

  function deleteTournament(id, key) {
    const t = admin(id, key);
    q.deleteTournament.run(t.id);
    emit(t.id, { type: 'deleted' });
    return { ok: true };
  }

  // ---------- entries

  function requireSetup(t) {
    if (t.status !== 'setup') fail(409, 'Entries are locked once the tournament has started');
  }

  function addEntries(id, key, names) {
    const t = admin(id, key);
    requireSetup(t);
    if (!Array.isArray(names)) fail(400, 'names must be a list');
    const clean = names.map((n) => (typeof n === 'string' ? n.trim().replace(/\s+/g, ' ') : '')).filter(Boolean);
    if (!clean.length) fail(400, 'Enter at least one name');
    const existing = q.entries.all(t.id);
    if (existing.length + clean.length > MAX_ENTRIES) fail(400, `A tournament can have at most ${MAX_ENTRIES} entries`);
    const seen = new Set(existing.map((e) => e.name.toLowerCase()));
    for (const n of clean) {
      if (n.length > 60) fail(400, `"${n.slice(0, 20)}…" is too long (max 60 characters)`);
      if (seen.has(n.toLowerCase())) fail(400, `"${n}" is already entered`);
      seen.add(n.toLowerCase());
    }
    let seed = existing.reduce((max, e) => Math.max(max, e.seed), 0);
    transaction(db, () => clean.forEach((n) => q.insertEntry.run(t.id, n, ++seed)));
    emit(t.id, { type: 'tournament' });
    return getTournament(id, key);
  }

  function removeEntry(id, key, entryId) {
    const t = admin(id, key);
    requireSetup(t);
    if (!q.deleteEntry.run(Number(entryId), t.id).changes) fail(404, 'Entry not found');
    emit(t.id, { type: 'tournament' });
    return getTournament(id, key);
  }

  function reorderEntries(id, key, ids) {
    const t = admin(id, key);
    requireSetup(t);
    const current = q.entries.all(t.id).map((e) => e.id);
    const wanted = Array.isArray(ids) ? ids.map(Number) : [];
    if (wanted.length !== current.length || new Set(wanted).size !== wanted.length || !wanted.every((x) => current.includes(x))) {
      fail(400, 'ids must list every entry exactly once');
    }
    transaction(db, () => wanted.forEach((eid, i) => q.setSeed.run(i + 1, eid, t.id)));
    emit(t.id, { type: 'tournament' });
    return getTournament(id, key);
  }

  // ---------- stages

  function createBracket(t, seeded) {
    const slots = formats.knockoutSlots(seeded);
    const rounds = Math.log2(slots.length);
    t.config.knockoutRounds = rounds;
    q.setConfig.run(JSON.stringify(t.config), t.id);
    for (let r = 1; r <= rounds; r++) {
      for (let s = 0; s < slots.length >> r; s++) {
        if (r === 1) {
          const a = slots[2 * s];
          const b = slots[2 * s + 1];
          const bye = a == null || b == null;
          q.insertMatch.run(t.id, 'knockout', null, 1, s, a, b, bye ? 'bye' : 'scheduled', bye ? (a ?? b) : null);
        } else {
          q.insertMatch.run(t.id, 'knockout', null, r, s, null, null, 'scheduled', null);
        }
      }
    }
    for (const m of q.byes.all(t.id)) advance(t, m, m.winner_id);
  }

  function advance(t, m, winnerId) {
    const next = q.koMatch.get(t.id, m.round + 1, m.slot >> 1);
    db.prepare(`UPDATE matches SET ${m.slot % 2 ? 'b_id' : 'a_id'} = ? WHERE id = ?`).run(winnerId, next.id);
  }

  function start(id, key) {
    const t = admin(id, key);
    if (t.status !== 'setup') fail(409, 'The tournament has already started');
    const entries = q.entries.all(t.id);
    transaction(db, () => {
      if (t.format === 'knockout') {
        if (entries.length < 2) fail(400, 'Add at least 2 entries to start');
        createBracket(t, entries.map((e) => ({ id: e.id, group: null, tier: 0 })));
        setStatus(t, 'knockout');
        return;
      }
      const { groups, qualifiers } = t.config;
      if (entries.length < groups * 2) {
        fail(400, `${groups} group${groups > 1 ? 's need' : ' needs'} at least ${groups * 2} entries (you have ${entries.length})`);
      }
      if (t.format === 'league_knockout') {
        const smallest = Math.floor(entries.length / groups);
        if (qualifiers > smallest) fail(400, `The smallest group has ${smallest} entries, so at most ${smallest} can qualify from each group`);
        if (groups * qualifiers < 2) fail(400, 'At least 2 entries must qualify for the knockout');
      }
      formats.snakeGroups(entries.map((e) => e.id), groups).forEach((ids, g) => {
        ids.forEach((eid) => q.setGroup.run(g, eid));
        formats.roundRobin(ids).forEach((pairs, r) =>
          pairs.forEach(([a, b], slot) => q.insertMatch.run(t.id, 'league', g, r + 1, slot, a, b, 'scheduled', null)),
        );
      });
      setStatus(t, 'league');
    });
    emit(t.id, { type: 'tournament' });
    return getTournament(id, key);
  }

  function startKnockout(id, key) {
    const t = admin(id, key);
    if (t.format !== 'league_knockout' || t.status !== 'league') fail(409, 'The knockout stage cannot be started now');
    const pending = q.pendingLeague.get(t.id).n;
    if (pending) fail(409, `${pending} league match${pending > 1 ? 'es are' : ' is'} still to be played`);
    const { groups } = view(t);
    const seeded = [];
    for (let tier = 0; tier < t.config.qualifiers; tier++) {
      for (const g of groups) {
        const row = g.standings[tier];
        if (row) seeded.push({ id: row.id, group: g.no, tier });
      }
    }
    transaction(db, () => {
      createBracket(t, seeded);
      setStatus(t, 'knockout');
    });
    emit(t.id, { type: 'tournament' });
    return getTournament(id, key);
  }

  // ---------- scoring

  function requireStageOpen(t, m) {
    const open = m.stage === 'league' ? t.status === 'league' : t.status === 'knockout';
    if (!open) fail(409, `This ${m.stage} match cannot be played right now`);
  }

  function rally(id, key, mid, side) {
    if (side !== 'a' && side !== 'b') fail(400, 'side must be "a" or "b"');
    const t = admin(id, key);
    const m = loadMatch(t, mid);
    if (m.status === 'done' || m.status === 'bye') fail(409, 'This match is already finished');
    if (m.a_id == null || m.b_id == null) fail(409, 'Both players are not known yet');
    requireStageOpen(t, m);

    const rallies = m.rallies + side;
    const score = t.sportDef.compute(rallies, t.config.scoring, m.first_server);
    const winnerId = score.winner ? (score.winner === 'a' ? m.a_id : m.b_id) : null;
    transaction(db, () => {
      q.saveScore.run(rallies, winnerId ? 'done' : 'live', winnerId, m.id);
      if (!winnerId) return;
      if (m.stage === 'knockout') {
        if (m.round === t.config.knockoutRounds) setStatus(t, 'completed');
        else advance(t, m, winnerId);
      } else if (t.format === 'league' && q.pendingLeague.get(t.id).n === 0) {
        setStatus(t, 'completed');
      }
    });
    return publishMatch(t, m.id, Boolean(winnerId));
  }

  // Removes the last rally. Undoing the winning point reopens the match, as
  // long as nothing downstream has started yet.
  function undo(id, key, mid) {
    const t = admin(id, key);
    const m = loadMatch(t, mid);
    if (m.status === 'bye' || !m.rallies) fail(409, 'Nothing to undo');
    const wasDone = m.status === 'done';
    transaction(db, () => {
      if (wasDone && m.stage === 'league') {
        if (t.status === 'knockout' || (t.status === 'completed' && t.format === 'league_knockout')) {
          fail(409, 'League results are locked because the knockout has started');
        }
        if (t.status === 'completed') setStatus(t, 'league');
      } else if (wasDone) {
        if (m.round < t.config.knockoutRounds) {
          const next = q.koMatch.get(t.id, m.round + 1, m.slot >> 1);
          if (next.rallies || next.status === 'done') fail(409, 'The next-round match has already started');
          db.prepare(`UPDATE matches SET ${m.slot % 2 ? 'b_id' : 'a_id'} = NULL, status = 'scheduled' WHERE id = ?`).run(next.id);
        }
        if (t.status === 'completed') setStatus(t, 'knockout');
      }
      q.saveScore.run(m.rallies.slice(0, -1), 'live', null, m.id);
    });
    return publishMatch(t, m.id, wasDone);
  }

  // Court, first server, and marking a match as on court before the first rally.
  function updateMatch(id, key, mid, input = {}) {
    const t = admin(id, key);
    const m = loadMatch(t, mid);
    if (m.status === 'bye') fail(409, 'Byes cannot be edited');
    const court = input.court === undefined ? m.court : text(input.court, 'Court', { max: 20, optional: true });
    let firstServer = m.first_server;
    if (input.firstServer !== undefined) {
      if (input.firstServer !== 'a' && input.firstServer !== 'b') fail(400, 'firstServer must be "a" or "b"');
      if (m.rallies) fail(409, 'The first server can only be changed before the first rally');
      firstServer = input.firstServer;
    }
    let status = m.status;
    if (input.status === 'live' && m.status === 'scheduled') {
      if (m.a_id == null || m.b_id == null) fail(409, 'Both players are not known yet');
      requireStageOpen(t, m);
      status = 'live';
    } else if (input.status === 'scheduled' && m.status === 'live' && !m.rallies) {
      status = 'scheduled';
    }
    q.saveMeta.run(court, firstServer, status, m.id);
    return publishMatch(t, m.id, false);
  }

  function exists(id) {
    return Boolean(q.tournament.get(String(id)));
  }

  return {
    events,
    exists,
    listTournaments,
    getTournament,
    createTournament,
    updateSettings,
    deleteTournament,
    addEntries,
    removeEntry,
    reorderEntries,
    start,
    startKnockout,
    rally,
    undo,
    updateMatch,
  };
}

module.exports = { createService, HttpError };
