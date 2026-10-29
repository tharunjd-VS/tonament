'use strict';

// Team ties in racket sports (see public/sports/tie.js): each tie between two
// team entries is played as several matches ("rubbers"). Before it, each
// captain (or an organiser) picks who plays which rubber from the team's
// roster; the two line-ups stay sealed until both are in, then the rubbers
// are made. Each rubber is scored with the sport's own rules; when one ends,
// its winner is added to the tie's score (matches.rallies), and the tie is
// decided, advanced and counted like any match (service.saveRallies).

const sports = require('./sports');
const TIE = require('../public/sports/tie');
const { fromScores } = require('../public/sports/result');

function createTies({ db, fail, load, accessOf, matchOf, eventFor, saveRallies, requireStageOpen }) {
  const baseOf = (t) => t.sportDef.tieOf || sports.get(t.sport);
  const rubberScore = (t, r, rallies = r.rallies) => baseOf(t).compute(rallies, { ...baseOf(t).normalizeConfig(t.config.scoring), ...(r.kind === 'doubles' && { doubles: true }) }, r.first_server);

  // The tournament, the tie and its event, with what the viewer may do.
  async function context(q, id, actor, mid, { lock = false } = {}) {
    const tournament = await load(q, id, { lock });
    const access = await accessOf(q, tournament, actor);
    const m = await matchOf(q, tournament, mid);
    // A private tournament: its team, and the two captains of this tie.
    if (tournament.visibility === 'private' && !access.score && !(await captainOf(q, m, 'a', actor)) && !(await captainOf(q, m, 'b', actor))) fail(404, 'Tournament not found');
    const t = await eventFor(q, tournament, m.event_id);
    if (!t.sportDef.tie) fail(400, 'This match isn\'t a team tie');
    return { tournament, access, m, t };
  }
  async function rosterOf(q, entryId) {
    if (!entryId) return [];
    return q('SELECT slot, name, email, captain FROM entry_players WHERE entry_id = $1 ORDER BY slot', [entryId]);
  }
  // A side's captain: whoever entered the team, or its roster's captain.
  async function captainOf(q, m, side, actor) {
    if (!actor?.user) return false;
    const entryId = side === 'a' ? m.a_id : m.b_id;
    const [e] = await q('SELECT user_id FROM entries WHERE id = $1', [entryId]);
    if (e && e.user_id === actor.user.id) return true;
    const [c] = await q('SELECT 1 FROM entry_players WHERE entry_id = $1 AND captain AND email = $2', [entryId, actor.user.email]);
    return Boolean(c);
  }

  // ---------- the view

  async function view(id, actor, mid) {
    const q = db.query;
    const { access, m, t } = await context(q, id, actor, mid);
    const format = TIE.rubbersOf(t.sportDef.tie);
    const [lineups, rubbers, rosterA, rosterB] = await Promise.all([
      q('SELECT side, slots, submitted_at FROM lineups WHERE match_id = $1', [m.id]),
      q('SELECT * FROM rubbers WHERE match_id = $1 ORDER BY position', [m.id]),
      rosterOf(q, m.a_id), rosterOf(q, m.b_id),
    ]);
    const roster = { a: rosterA, b: rosterB };
    const mine = { a: access.manage || await captainOf(q, m, 'a', actor), b: access.manage || await captainOf(q, m, 'b', actor) };
    const both = lineups.length === 2;
    const names = (side, slots) => (slots || []).map((s) => (roster[side].find((p) => p.slot === s) || {}).name || 'Player');
    const sideView = (side) => {
      const l = lineups.find((x) => x.side === side);
      return {
        lineup: Boolean(l),
        // Sealed: only your own side (or the organisers) until both are in.
        slots: l && (both || mine[side]) ? l.slots : null,
        roster: mine[side] ? roster[side].map((p) => ({ slot: p.slot, name: p.name, captain: p.captain })) : null,
        canSet: mine[side] && !rubbers.length && m.a_id != null && m.b_id != null && m.status !== 'done',
      };
    };
    return {
      id: m.id,
      format: { name: TIE.formatName(t.sportDef.tie), playAll: t.sportDef.tie.playAll, rubbers: format },
      status: m.status,
      winner: m.winner_id ? (m.winner_id === m.a_id ? 'a' : 'b') : null,
      sides: { a: sideView('a'), b: sideView('b') },
      rubbers: format.map((f, i) => {
        const r = rubbers.find((x) => x.position === i);
        if (!r) return { position: i, label: f.label, kind: f.kind, a: null, b: null, status: 'waiting' };
        const score = r.final ? null : rubberScore(t, r);
        return {
          position: i, label: r.label, kind: r.kind, a: names('a', r.a_slots), b: names('b', r.b_slots),
          // Decided before it was finished: not needed.
          status: r.status === 'live' && m.status === 'done' ? 'unplayed' : r.status, winner: r.winner, rallies: r.rallies.length, final: r.final,
          score, summary: r.final ? r.final.map((g) => `${g.a}–${g.b}`).join(', ') : score ? baseOf(t).summary(score) : '',
        };
      }),
      can: { score: access.score && rubbers.length > 0 && m.status !== 'done' },
    };
  }

  // ---------- line-ups

  // slots: for each rubber in order, the roster slots who play it (1 for
  // singles, 2 for doubles). A player plays at most one singles and one doubles.
  async function setLineup(id, actor, mid, { side, slots } = {}) {
    if (side !== 'a' && side !== 'b') fail(400, 'side must be a or b');
    await db.tx(async (q) => {
      const { access, m, t } = await context(q, id, actor, mid, { lock: true });
      if (!(access.manage || await captainOf(q, m, side, actor))) fail(403, 'Only the team\'s captain (or an organiser) sets its line-up');
      if (m.a_id == null || m.b_id == null) fail(409, 'The other team isn\'t known yet');
      const [made] = await q('SELECT 1 FROM rubbers WHERE match_id = $1 LIMIT 1', [m.id]);
      if (made || m.status === 'done') fail(409, 'The line-ups are out — the tie has started');
      const format = TIE.rubbersOf(t.sportDef.tie);
      const roster = new Set((await rosterOf(q, side === 'a' ? m.a_id : m.b_id)).map((p) => p.slot));
      if (!Array.isArray(slots) || slots.length !== format.length) fail(400, `Pick players for all ${format.length} matches`);
      const used = { singles: new Set(), doubles: new Set() };
      const clean = format.map((f, i) => {
        const list = (Array.isArray(slots[i]) ? slots[i] : []).map(Number);
        const need = f.kind === 'doubles' ? 2 : 1;
        if (list.length !== need || new Set(list).size !== need) fail(400, `${f.label}: pick ${need === 2 ? 'two different players' : 'a player'}`);
        for (const s of list) {
          if (!roster.has(s)) fail(400, `${f.label}: that player isn't on the team`);
          if (used[f.kind].has(s)) fail(400, `A player can play one ${f.kind} match in a tie`);
          used[f.kind].add(s);
        }
        return list;
      });
      await q(
        `INSERT INTO lineups (match_id, side, slots, submitted_by) VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (match_id, side) DO UPDATE SET slots = EXCLUDED.slots, submitted_by = EXCLUDED.submitted_by, submitted_at = now()`,
        [m.id, side, JSON.stringify(clean), actor.user ? actor.user.id : null],
      );
      // Both in: reveal, and make the rubbers.
      const lineups = await q('SELECT side, slots FROM lineups WHERE match_id = $1', [m.id]);
      if (lineups.length === 2) {
        const a = lineups.find((x) => x.side === 'a').slots;
        const b = lineups.find((x) => x.side === 'b').slots;
        for (const [i, f] of format.entries()) {
          await q('INSERT INTO rubbers (match_id, position, label, kind, a_slots, b_slots) VALUES ($1, $2, $3, $4, $5::int[], $6::int[])', [m.id, i, f.label, f.kind, a[i], b[i]]);
        }
      }
    });
    return view(id, actor, mid);
  }

  // ---------- scoring a rubber

  async function rubberFor(q, id, actor, mid, n) {
    const { tournament, access, m, t } = await context(q, id, actor, mid, { lock: true });
    if (!access.score) fail(actor?.user ? 403 : 401, 'Only the tournament team can score matches');
    requireStageOpen(t, m);
    const [r] = await q('SELECT * FROM rubbers WHERE match_id = $1 AND position = $2 FOR UPDATE', [m.id, Number(n)]);
    if (!r) fail(404, 'The line-ups aren\'t in yet');
    return { tournament, m, t, r };
  }
  // The tie's score: the rubbers' winners, in the order they finished.
  async function settleTie(q, tournament, t, m) {
    const done = await q(`SELECT winner FROM rubbers WHERE match_id = $1 AND status = 'done' ORDER BY finished_at, position`, [m.id]);
    const rallies = done.map((r) => r.winner).join('');
    if (rallies !== m.rallies) await saveRallies(q, tournament, t, m, rallies);
  }
  async function saveRubber(q, tournament, t, m, r, { rallies = r.rallies, final = null }) {
    const score = final ? null : rubberScore(t, r, rallies);
    const winner = final ? (final.filter((g) => g.a > g.b).length > final.filter((g) => g.b > g.a).length ? 'a' : 'b') : score.winner || null;
    await q(
      `UPDATE rubbers SET rallies = $1, final = $2::jsonb, winner = $3, status = $4, finished_at = $5 WHERE id = $6`,
      [rallies, final ? JSON.stringify(final) : null, winner, winner ? 'done' : 'live', winner ? new Date().toISOString() : null, r.id],
    );
    await settleTie(q, tournament, t, m);
  }

  async function rally(id, actor, mid, n, { side, at, ...extra } = {}) {
    if (!extra.end && side !== 'a' && side !== 'b') fail(400, 'side must be "a" or "b"');
    await db.tx(async (q) => {
      const { tournament, m, t, r } = await rubberFor(q, id, actor, mid, n);
      if (m.status === 'done') fail(409, 'This tie is decided');
      if (r.status === 'done') fail(409, 'This match is finished');
      if (at !== undefined && Number(at) !== r.rallies.length) fail(409, 'Someone else scored at the same time — the score has been refreshed', 'stale');
      const tap = sports.tapFor(rubberScore(t, r), { ...extra, side });
      if (tap.error) fail(400, tap.error);
      await saveRubber(q, tournament, t, m, r, { rallies: r.rallies + tap.ch });
    });
    return view(id, actor, mid);
  }
  async function undo(id, actor, mid, n, { at } = {}) {
    await db.tx(async (q) => {
      const { tournament, m, t, r } = await rubberFor(q, id, actor, mid, n);
      if (m.status === 'done') fail(409, 'This tie is decided — its results are final');
      if (at !== undefined && Number(at) !== r.rallies.length) fail(409, 'Someone else scored at the same time — the score has been refreshed', 'stale');
      if (r.final) {
        await q(`UPDATE rubbers SET final = NULL, winner = NULL, status = 'live', finished_at = NULL WHERE id = $1`, [r.id]);
        await settleTie(q, tournament, t, m);
        return;
      }
      if (!r.rallies) fail(409, 'Nothing to undo');
      await saveRubber(q, tournament, t, m, r, { rallies: r.rallies.slice(0, -1) });
    });
    return view(id, actor, mid);
  }
  // The score at the end ([{ a, b }] per game) instead of point by point.
  async function result(id, actor, mid, n, { games } = {}) {
    await db.tx(async (q) => {
      const { tournament, m, t, r } = await rubberFor(q, id, actor, mid, n);
      if (m.status === 'done') fail(409, 'This tie is decided');
      if (r.status === 'done') fail(409, 'This match is finished — undo it to change the score');
      const built = fromScores((log) => rubberScore(t, r, log), games);
      if (built.error) fail(400, built.error);
      if (!built.score.winner) fail(400, 'That doesn\'t finish the match — enter every game played');
      await saveRubber(q, tournament, t, m, r, { rallies: built.rallies });
    });
    return view(id, actor, mid);
  }

  return { view, setLineup, rally, undo, result };
}

module.exports = { createTies };
