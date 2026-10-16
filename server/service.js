'use strict';

const crypto = require('node:crypto');
const sports = require('./sports');
const formats = require('./formats');

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
const nextSlotColumn = (m) => (m.slot % 2 ? 'b_id' : 'a_id');

// Every write runs in a transaction that first locks the tournament row, so
// concurrent requests for one tournament (two umpires, retries, several
// serverless instances) are applied one at a time.
function createService(db) {
  // ---------- queries (q is db.query or a transaction's query)

  async function load(q, id, { lock = false } = {}) {
    const [row] = await q(`SELECT * FROM tournaments WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [String(id)]);
    if (!row) fail(404, 'Tournament not found');
    return { ...row, sportDef: sports.get(row.sport) };
  }

  const entriesOf = (q, tid) =>
    q('SELECT id, name, seed, group_no FROM entries WHERE tournament_id = $1 ORDER BY seed, id', [tid]);

  const matchesOf = (q, tid) =>
    q(`SELECT * FROM matches WHERE tournament_id = $1 ORDER BY stage = 'knockout', round, group_no, slot, id`, [tid]);

  async function matchOf(q, t, mid) {
    const [m] = await q('SELECT * FROM matches WHERE id = $1 AND tournament_id = $2', [Number(mid) || 0, t.id]);
    if (!m) fail(404, 'Match not found');
    return m;
  }

  async function koMatch(q, t, round, slot) {
    const [m] = await q(
      `SELECT * FROM matches WHERE tournament_id = $1 AND stage = 'knockout' AND round = $2 AND slot = $3`,
      [t.id, round, slot],
    );
    return m;
  }

  async function pendingLeague(q, t) {
    const [{ n }] = await q(
      `SELECT COUNT(*)::int AS n FROM matches WHERE tournament_id = $1 AND stage = 'league' AND status <> 'done'`,
      [t.id],
    );
    return n;
  }

  const insertMatch = (q, t, stage, group, round, slot, a, b, status = 'scheduled', winner = null) =>
    q(
      `INSERT INTO matches (tournament_id, stage, group_no, round, slot, a_id, b_id, status, winner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [t.id, stage, group, round, slot, a, b, status, winner],
    );

  async function setStatus(q, t, status) {
    await q('UPDATE tournaments SET status = $1 WHERE id = $2', [status, t.id]);
    t.status = status;
  }

  // ---------- auth

  function isAdmin(t, key) {
    if (typeof key !== 'string' || !key) return false;
    const a = Buffer.from(key);
    const b = Buffer.from(t.admin_key);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function lockAsAdmin(q, id, key) {
    const t = await load(q, id, { lock: true });
    if (!isAdmin(t, key)) fail(403, 'Only the organiser can do that');
    return t;
  }

  // Runs fn as the organiser inside a transaction and returns the fresh view.
  function mutate(id, key, fn) {
    return db.tx(async (q) => {
      const t = await lockAsAdmin(q, id, key);
      await fn(q, t);
      return view(q, await load(q, id), key);
    });
  }

  function buildConfig(input, sport, prev = {}) {
    return {
      ...prev,
      groups: int(input.groups, 1, 16, prev.groups ?? 2, 'Number of groups'),
      qualifiers: int(input.qualifiers, 1, 8, prev.qualifiers ?? 2, 'Qualifiers per group'),
      scoring: sport.normalizeConfig(input.scoring ?? prev.scoring),
    };
  }

  // ---------- views

  const scoreOf = (t, m) => t.sportDef.compute(m.rallies, t.config.scoring, m.first_server);

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

  async function view(q, t, key) {
    const [entries, rows] = await Promise.all([entriesOf(q, t.id), matchesOf(q, t.id)]);
    const names = new Map(entries.map((e) => [e.id, e.name]));
    const scored = rows.map((row) => ({ row, score: scoreOf(t, row) }));
    const groups = groupStandings(t, entries, scored, names);
    const matches = scored.map(({ row, score }) => matchView(t, row, score, names));

    let champion = null;
    if (t.status === 'completed') {
      const final = matches.find((m) => m.stage === 'knockout' && m.round === t.config.knockoutRounds);
      if (final) champion = final.winner && { id: final.winner, name: names.get(final.winner) };
      else if (groups.length === 1) champion = groups[0].standings[0];
    }

    return {
      id: t.id,
      name: t.name,
      venue: t.venue,
      status: t.status,
      format: t.format,
      formatName: FORMATS[t.format],
      createdAt: t.created_at,
      sport: { id: t.sportDef.id, name: t.sportDef.name },
      config: t.config,
      isAdmin: isAdmin(t, key),
      entries: entries.map((e) => ({ id: e.id, name: e.name, seed: e.seed, group: e.group_no })),
      groups,
      matches,
      champion: champion && { id: champion.id, name: champion.name },
    };
  }

  async function singleMatchView(q, t, matchId) {
    const [row] = await q('SELECT * FROM matches WHERE id = $1', [matchId]);
    const names = new Map((await entriesOf(q, t.id)).map((e) => [e.id, e.name]));
    return matchView(t, row, scoreOf(t, row), names);
  }

  // ---------- tournaments

  async function listTournaments() {
    const rows = await db.query(`
      SELECT t.id, t.name, t.venue, t.sport, t.format, t.status, t.created_at AS "createdAt",
             (SELECT COUNT(*)::int FROM entries e WHERE e.tournament_id = t.id) AS entries
      FROM tournaments t ORDER BY t.created_at DESC, t.id LIMIT 100`);
    return rows.map((r) => ({ ...r, formatName: FORMATS[r.format] }));
  }

  async function getTournament(id, key) {
    return view(db.query, await load(db.query, id), key);
  }

  async function createTournament(input = {}) {
    const name = text(input.name, 'Tournament name');
    const venue = text(input.venue, 'Venue', { optional: true });
    const sport = sports.get(input.sport || 'badminton');
    if (!sport) fail(400, 'Unknown sport');
    const format = FORMATS[input.format] ? input.format : 'league_knockout';
    const config = buildConfig(input, sport);
    const id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
    const adminKey = crypto.randomBytes(18).toString('base64url');
    await db.query(
      'INSERT INTO tournaments (id, name, venue, sport, format, config, admin_key) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)',
      [id, name, venue, sport.id, format, JSON.stringify(config), adminKey],
    );
    return { id, adminKey };
  }

  async function updateSettings(id, key, input = {}) {
    return mutate(id, key, async (q, t) => {
      if (t.status !== 'setup') fail(409, 'Settings are locked once the tournament has started');
      const name = input.name === undefined ? t.name : text(input.name, 'Tournament name');
      const venue = input.venue === undefined ? t.venue : text(input.venue, 'Venue', { optional: true });
      if (input.format !== undefined && !FORMATS[input.format]) fail(400, 'Unknown format');
      const format = input.format ?? t.format;
      const config = buildConfig(input, t.sportDef, t.config);
      await q('UPDATE tournaments SET name = $1, venue = $2, format = $3, config = $4::jsonb WHERE id = $5', [
        name, venue, format, JSON.stringify(config), t.id,
      ]);
    });
  }

  async function deleteTournament(id, key) {
    return db.tx(async (q) => {
      const t = await lockAsAdmin(q, id, key);
      await q('DELETE FROM matches WHERE tournament_id = $1', [t.id]);
      await q('DELETE FROM entries WHERE tournament_id = $1', [t.id]);
      await q('DELETE FROM tournaments WHERE id = $1', [t.id]);
      return { ok: true };
    });
  }

  // ---------- entries

  function requireSetup(t) {
    if (t.status !== 'setup') fail(409, 'Entries are locked once the tournament has started');
  }

  async function addEntries(id, key, names) {
    if (!Array.isArray(names)) fail(400, 'names must be a list');
    const clean = names.map((n) => (typeof n === 'string' ? n.trim().replace(/\s+/g, ' ') : '')).filter(Boolean);
    if (!clean.length) fail(400, 'Enter at least one name');
    return mutate(id, key, async (q, t) => {
      requireSetup(t);
      const existing = await entriesOf(q, t.id);
      if (existing.length + clean.length > MAX_ENTRIES) fail(400, `A tournament can have at most ${MAX_ENTRIES} entries`);
      const seen = new Set(existing.map((e) => e.name.toLowerCase()));
      for (const n of clean) {
        if (n.length > 60) fail(400, `"${n.slice(0, 20)}…" is too long (max 60 characters)`);
        if (seen.has(n.toLowerCase())) fail(400, `"${n}" is already entered`);
        seen.add(n.toLowerCase());
      }
      let seed = existing.reduce((max, e) => Math.max(max, e.seed), 0);
      for (const n of clean) await q('INSERT INTO entries (tournament_id, name, seed) VALUES ($1, $2, $3)', [t.id, n, ++seed]);
    });
  }

  async function removeEntry(id, key, entryId) {
    return mutate(id, key, async (q, t) => {
      requireSetup(t);
      const deleted = await q('DELETE FROM entries WHERE id = $1 AND tournament_id = $2 RETURNING id', [Number(entryId) || 0, t.id]);
      if (!deleted.length) fail(404, 'Entry not found');
    });
  }

  async function reorderEntries(id, key, ids) {
    return mutate(id, key, async (q, t) => {
      requireSetup(t);
      const current = (await entriesOf(q, t.id)).map((e) => e.id);
      const wanted = Array.isArray(ids) ? ids.map(Number) : [];
      if (wanted.length !== current.length || new Set(wanted).size !== wanted.length || !wanted.every((x) => current.includes(x))) {
        fail(400, 'ids must list every entry exactly once');
      }
      for (const [i, eid] of wanted.entries()) {
        await q('UPDATE entries SET seed = $1 WHERE id = $2 AND tournament_id = $3', [i + 1, eid, t.id]);
      }
    });
  }

  // ---------- stages

  async function createBracket(q, t, seeded) {
    const slots = formats.knockoutSlots(seeded);
    const rounds = Math.log2(slots.length);
    t.config = { ...t.config, knockoutRounds: rounds };
    await q('UPDATE tournaments SET config = $1::jsonb WHERE id = $2', [JSON.stringify(t.config), t.id]);
    const byes = [];
    for (let r = 1; r <= rounds; r++) {
      for (let s = 0; s < slots.length >> r; s++) {
        if (r > 1) {
          await insertMatch(q, t, 'knockout', null, r, s, null, null);
          continue;
        }
        const a = slots[2 * s];
        const b = slots[2 * s + 1];
        if (a == null || b == null) {
          await insertMatch(q, t, 'knockout', null, 1, s, a, b, 'bye', a ?? b);
          byes.push({ round: 1, slot: s, winner: a ?? b });
        } else {
          await insertMatch(q, t, 'knockout', null, 1, s, a, b);
        }
      }
    }
    for (const bye of byes) await advance(q, t, bye, bye.winner);
  }

  async function advance(q, t, m, winnerId) {
    const next = await koMatch(q, t, m.round + 1, m.slot >> 1);
    await q(`UPDATE matches SET ${nextSlotColumn(m)} = $1 WHERE id = $2`, [winnerId, next.id]);
  }

  async function start(id, key) {
    return mutate(id, key, async (q, t) => {
      if (t.status !== 'setup') fail(409, 'The tournament has already started');
      const entries = await entriesOf(q, t.id);
      if (t.format === 'knockout') {
        if (entries.length < 2) fail(400, 'Add at least 2 entries to start');
        await createBracket(q, t, entries.map((e) => ({ id: e.id, group: null, tier: 0 })));
        await setStatus(q, t, 'knockout');
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
      const draw = formats.snakeGroups(entries.map((e) => e.id), groups);
      for (const [g, ids] of draw.entries()) {
        for (const eid of ids) await q('UPDATE entries SET group_no = $1 WHERE id = $2', [g, eid]);
        for (const [r, pairs] of formats.roundRobin(ids).entries()) {
          for (const [slot, [a, b]] of pairs.entries()) await insertMatch(q, t, 'league', g, r + 1, slot, a, b);
        }
      }
      await setStatus(q, t, 'league');
    });
  }

  async function startKnockout(id, key) {
    return mutate(id, key, async (q, t) => {
      if (t.format !== 'league_knockout' || t.status !== 'league') fail(409, 'The knockout stage cannot be started now');
      const pending = await pendingLeague(q, t);
      if (pending) fail(409, `${pending} league match${pending > 1 ? 'es are' : ' is'} still to be played`);
      const { groups } = await view(q, t);
      const seeded = [];
      for (let tier = 0; tier < t.config.qualifiers; tier++) {
        for (const g of groups) {
          const row = g.standings[tier];
          if (row) seeded.push({ id: row.id, group: g.no, tier });
        }
      }
      await createBracket(q, t, seeded);
      await setStatus(q, t, 'knockout');
    });
  }

  // ---------- scoring

  function requireStageOpen(t, m) {
    const open = m.stage === 'league' ? t.status === 'league' : t.status === 'knockout';
    if (!open) fail(409, `This ${m.stage} match cannot be played right now`);
  }

  async function rally(id, key, mid, side) {
    if (side !== 'a' && side !== 'b') fail(400, 'side must be "a" or "b"');
    return db.tx(async (q) => {
      const t = await lockAsAdmin(q, id, key);
      const m = await matchOf(q, t, mid);
      if (m.status === 'done' || m.status === 'bye') fail(409, 'This match is already finished');
      if (m.a_id == null || m.b_id == null) fail(409, 'Both players are not known yet');
      requireStageOpen(t, m);

      const rallies = m.rallies + side;
      const score = t.sportDef.compute(rallies, t.config.scoring, m.first_server);
      const winnerId = score.winner ? (score.winner === 'a' ? m.a_id : m.b_id) : null;
      await q(`UPDATE matches SET rallies = $1, status = $2, winner_id = $3, updated_at = now() WHERE id = $4`, [
        rallies, winnerId ? 'done' : 'live', winnerId, m.id,
      ]);
      if (winnerId) {
        if (m.stage === 'knockout') {
          if (m.round === t.config.knockoutRounds) await setStatus(q, t, 'completed');
          else await advance(q, t, m, winnerId);
        } else if (t.format === 'league' && (await pendingLeague(q, t)) === 0) {
          await setStatus(q, t, 'completed');
        }
      }
      return singleMatchView(q, t, m.id);
    });
  }

  // Removes the last rally. Undoing the winning point reopens the match, as
  // long as nothing downstream has started yet.
  async function undo(id, key, mid) {
    return db.tx(async (q) => {
      const t = await lockAsAdmin(q, id, key);
      const m = await matchOf(q, t, mid);
      if (m.status === 'bye' || !m.rallies) fail(409, 'Nothing to undo');
      if (m.status === 'done' && m.stage === 'league') {
        if (t.status === 'knockout' || (t.status === 'completed' && t.format === 'league_knockout')) {
          fail(409, 'League results are locked because the knockout has started');
        }
        if (t.status === 'completed') await setStatus(q, t, 'league');
      } else if (m.status === 'done') {
        if (m.round < t.config.knockoutRounds) {
          const next = await koMatch(q, t, m.round + 1, m.slot >> 1);
          if (next.rallies || next.status === 'done') fail(409, 'The next-round match has already started');
          await q(`UPDATE matches SET ${nextSlotColumn(m)} = NULL, status = 'scheduled' WHERE id = $1`, [next.id]);
        }
        if (t.status === 'completed') await setStatus(q, t, 'knockout');
      }
      await q(`UPDATE matches SET rallies = $1, status = 'live', winner_id = NULL, updated_at = now() WHERE id = $2`, [
        m.rallies.slice(0, -1), m.id,
      ]);
      return singleMatchView(q, t, m.id);
    });
  }

  // Court, first server, and marking a match as on court before the first rally.
  async function updateMatch(id, key, mid, input = {}) {
    return db.tx(async (q) => {
      const t = await lockAsAdmin(q, id, key);
      const m = await matchOf(q, t, mid);
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
      await q(`UPDATE matches SET court = $1, first_server = $2, status = $3, updated_at = now() WHERE id = $4`, [
        court, firstServer, status, m.id,
      ]);
      return singleMatchView(q, t, m.id);
    });
  }

  return {
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
