'use strict';

// Challenges: one player (or pair) challenges another to a game. They
// accept or decline; the game is scored like a group game — live, or just
// the final score — and the losing side confirms it (it confirms itself a
// day later). A confirmed game moves both sides' Tonament rating and goes
// to the feed, with a share card and "Challenge back".
//
// ratings: one Tonament rating per player per sport, from every confirmed
// game anywhere (challenges here, group games via rate()).

const sports = require('./sports');
const EVENTS = require('../public/sports/events');
const L = require('./group-logic');

const AUTO_CONFIRM_HOURS = 24;
const EXPIRE_DAYS = 14;
const MAX_OPEN = 10;
const OPEN = ['sent', 'accepted', 'live'];

function createChallenges({ db, fail, text, social, notify }) {
  const needUser = (actor) => { if (!actor?.user) fail(401, 'Sign in to challenge someone'); return actor.user; };
  const sportOf = (x) => sports.get(x.sport);
  const doubles = (x) => Boolean(x.a2);
  const scoreOf = (x, rallies = x.rallies) => sportOf(x).compute(rallies, { ...sportOf(x).normalizeConfig(x.scoring), ...(doubles(x) && { doubles: true }) }, x.first_server);
  const sideOf = (x, id) => ([x.a1, x.a2].includes(id) ? 'a' : [x.b1, x.b2].includes(id) ? 'b' : null);
  const ids = (x) => [x.a1, x.a2, x.b1, x.b2].filter(Boolean);

  // Sports you can challenge someone in: live ones played as singles or doubles.
  const challengeable = (id) => {
    const s = sports.get(id);
    return Boolean(s) && !s.timed && !EVENTS.isTeamSport(id);
  };

  // ---------- ratings

  // The Tonament rating after a confirmed game (any kind). sides: { a: [ids], b: [ids] }.
  async function rate(q, sport, sides, winner, margin) {
    const all = [...sides.a, ...sides.b];
    const rows = await q('SELECT user_id AS id, rating, games FROM ratings WHERE sport = $1 AND user_id = ANY($2::int[])', [sport, all]);
    const by = new Map(rows.map((r) => [r.id, r]));
    const team = (list) => list.map((id) => by.get(id) || { id, rating: L.START, games: 0 });
    const deltas = L.rate(team(sides.a), team(sides.b), winner, margin);
    for (const [id, d] of Object.entries(deltas)) {
      const won = sides[winner].includes(Number(id));
      await q(
        `INSERT INTO ratings (user_id, sport, rating, games, wins) VALUES ($1, $2, $3, 1, $4)
         ON CONFLICT (user_id, sport) DO UPDATE SET rating = ratings.rating + $5, games = ratings.games + 1, wins = ratings.wins + $4, updated_at = now()`,
        [Number(id), sport, L.START + d, won ? 1 : 0, d],
      );
    }
    return deltas;
  }
  async function unrate(q, sport, deltas, sides, winner) {
    for (const [id, d] of Object.entries(deltas || {})) {
      const won = sides[winner].includes(Number(id));
      await q('UPDATE ratings SET rating = rating - $3, games = GREATEST(games - 1, 0), wins = GREATEST(wins - $4, 0) WHERE user_id = $1 AND sport = $2', [Number(id), sport, d, won ? 1 : 0]);
    }
  }
  // [{ sport, name, rating, games, wins }] for a profile.
  async function ratingsOf(userId) {
    const rows = await db.query('SELECT sport, rating, games, wins FROM ratings WHERE user_id = $1 AND games > 0 ORDER BY games DESC', [userId]);
    return rows.map((r) => ({ ...r, name: (sports.get(r.sport) || {}).name || r.sport, provisional: r.games < L.PROVISIONAL }));
  }

  // ---------- reading

  async function load(q, id, { lock = false } = {}) {
    const [x] = await q(`SELECT * FROM challenges WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [Number(id) || 0]);
    if (!x) fail(404, 'Challenge not found');
    return x;
  }
  // Unanswered for two weeks: expired. Unconfirmed for a day: confirmed.
  async function settle(q, x) {
    if (x.status === 'sent' && Date.parse(x.created_at) < Date.now() - EXPIRE_DAYS * 86400000) {
      await q(`UPDATE challenges SET status = 'expired' WHERE id = $1`, [x.id]);
      return { ...x, status: 'expired' };
    }
    if (x.status === 'done' && Date.parse(x.ended_at) < Date.now() - AUTO_CONFIRM_HOURS * 3600000) return confirmIn(q, x, null);
    return x;
  }

  function viewOf(x, actor, people, ratings) {
    const me = actor?.user?.id;
    const side = me ? sideOf(x, me) : null;
    const person = (id) => (id ? { id, name: people.get(id)?.name || 'Player', handle: people.get(id)?.handle || null, rating: ratings.get(id) ?? null } : null);
    const sc = x.final || !x.rallies ? null : scoreOf(x);
    const s = sportOf(x);
    const live = ['accepted', 'live'].includes(x.status);
    const loser = x.winner ? (x.winner === 'a' ? 'b' : 'a') : null;
    return {
      id: x.id,
      sport: { id: x.sport, name: s ? s.name : x.sport },
      scoring: x.scoring,
      format: s && s.summary ? formatName(x) : '',
      a: [person(x.a1), person(x.a2)].filter(Boolean),
      b: [person(x.b1), person(x.b2)].filter(Boolean),
      status: x.status,
      message: x.message,
      place: x.place,
      playAt: x.play_at,
      createdAt: x.created_at,
      final: x.final,
      winner: x.winner,
      rallies: x.rallies.length,
      score: sc || (live ? scoreOf(x, '') : null),
      summary: x.final ? `${x.final.a}–${x.final.b}` : sc ? s.summary(sc) : null,
      deltas: x.deltas,
      parent: x.parent_id,
      confirmBy: x.status === 'done' && x.ended_at ? new Date(Date.parse(x.ended_at) + AUTO_CONFIRM_HOURS * 3600000).toISOString() : null,
      me: side,
      can: {
        respond: x.status === 'sent' && [x.b1, x.b2].includes(me),
        cancel: OPEN.includes(x.status) && x.status !== 'live' && x.created_by === me,
        score: live && Boolean(side),
        confirm: ['done', 'disputed'].includes(x.status) && side === loser,
        dispute: x.status === 'done' && Boolean(side),
        back: ['confirmed', 'declined', 'expired'].includes(x.status) && Boolean(side),
      },
    };
  }
  const formatName = (x) => {
    const n = (x.scoring && x.scoring.bestOf) || sportOf(x).defaults.bestOf;
    return n > 1 ? `Best of ${n}` : 'One game';
  };
  async function views(q, rows, actor) {
    const all = [...new Set(rows.flatMap(ids))];
    const people = new Map((await q('SELECT id, name, handle FROM users WHERE id = ANY($1::int[])', [all])).map((u) => [u.id, u]));
    const rated = await q('SELECT user_id, sport, rating FROM ratings WHERE user_id = ANY($1::int[])', [all]);
    return rows.map((x) => viewOf(x, actor, people, new Map(rated.filter((r) => r.sport === x.sport).map((r) => [r.user_id, r.rating]))));
  }

  async function get(id, actor) {
    const x = await db.tx(async (q) => settle(q, await load(q, id, { lock: true })));
    return (await views(db.query, [x], actor))[0];
  }
  // Mine: to answer, waiting on them, to play, and played.
  async function mine(actor) {
    const me = needUser(actor);
    let rows = await db.query(
      `SELECT * FROM challenges WHERE $1 IN (a1, a2, b1, b2) ORDER BY id DESC LIMIT 60`,
      [me.id],
    );
    rows = await db.tx(async (q) => {
      const out = [];
      for (const x of rows) out.push(['sent', 'done'].includes(x.status) ? await settle(q, await load(q, x.id, { lock: true })) : x);
      return out;
    });
    const list = await views(db.query, rows, actor);
    return {
      incoming: list.filter((x) => x.status === 'sent' && x.me === 'b'),
      outgoing: list.filter((x) => x.status === 'sent' && x.me === 'a'),
      toPlay: list.filter((x) => ['accepted', 'live'].includes(x.status)),
      toConfirm: list.filter((x) => ['done', 'disputed'].includes(x.status)),
      played: list.filter((x) => ['confirmed', 'declined', 'expired', 'cancelled'].includes(x.status)).slice(0, 20),
    };
  }
  // Who I can challenge quickly: people I follow and my club-mates.
  // withId: someone else to include (the player whose profile you came from).
  async function people(actor, { withId = null } = {}) {
    const me = needUser(actor);
    const rows = await db.query(
      `SELECT u.id, u.name, u.handle FROM users u WHERE u.id <> $1 AND u.disabled_at IS NULL AND NOT u.guest AND (
         u.id::text IN (SELECT target_id FROM follows WHERE follower_id = $1 AND kind = 'user')
         OR u.id IN (SELECT m2.user_id FROM club_members m1 JOIN club_members m2 ON m2.org_id = m1.org_id
                     WHERE m1.user_id = $1 AND m1.status = 'active' AND m2.status = 'active'))
       AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = $1 UNION SELECT user_id FROM blocks WHERE blocked_id = $1)
       ORDER BY u.name LIMIT 300`,
      [me.id],
    );
    const extra = Number(withId) || 0;
    if (extra && extra !== me.id && !rows.some((r) => r.id === extra)) {
      const [u] = await db.query(
        `SELECT id, name, handle FROM users WHERE id = $1 AND disabled_at IS NULL AND NOT guest
         AND id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = $2 UNION SELECT user_id FROM blocks WHERE blocked_id = $2)`,
        [extra, me.id],
      );
      if (u) rows.unshift(u);
    }
    return rows;
  }

  // ---------- making one

  async function create(actor, input = {}) {
    const me = needUser(actor);
    const sport = String(input.sport || '');
    if (!challengeable(sport)) fail(400, 'Pick a sport you play one against one or in pairs');
    const s = sports.get(sport);
    const toId = Number(input.to) || 0;
    const pair = input.partner != null || input.opponentPartner != null;
    const side = [me.id, pair ? Number(input.partner) || 0 : null];
    const other = [toId, pair ? Number(input.opponentPartner) || 0 : null];
    const all = [...side, ...other].filter((v) => v !== null);
    if (all.some((v) => !v) || new Set(all).size !== all.length) fail(400, pair ? 'Pick four different players' : 'Pick who to challenge');
    if (toId === me.id) fail(400, 'You can\'t challenge yourself');
    const users = await db.query('SELECT id, name FROM users WHERE id = ANY($1::int[]) AND disabled_at IS NULL AND NOT guest', [all]);
    if (users.length !== all.length) fail(404, 'Player not found');
    const blocked = await db.query('SELECT 1 FROM blocks WHERE (user_id = ANY($1::int[]) AND blocked_id = ANY($1::int[])) LIMIT 1', [all]);
    if (blocked.length) fail(403, 'You can\'t challenge this player');
    const [{ n }] = await db.query(`SELECT COUNT(*)::int AS n FROM challenges WHERE created_by = $1 AND status = 'sent'`, [me.id]);
    if (n >= MAX_OPEN) fail(429, `You have ${n} challenges waiting for an answer — wait for some replies first`);
    const scoring = s.normalizeConfig({ ...(input.bestOf ? { bestOf: Number(input.bestOf) } : {}), ...(input.scoring || {}) });
    const place = text(input.place, 'Where', { max: 80, optional: true });
    const message = text(input.message, 'Message', { max: 200, optional: true });
    const playAt = input.playAt && !Number.isNaN(Date.parse(input.playAt)) ? new Date(input.playAt).toISOString() : null;
    const [x] = await db.query(
      `INSERT INTO challenges (sport, scoring, a1, a2, b1, b2, created_by, org_id, parent_id, message, place, play_at)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [sport, JSON.stringify(scoring), side[0], side[1], other[0], other[1], me.id, Number(input.club) || null, Number(input.back) || null, message, place, playAt],
    );
    const name = new Map(users.map((u) => [u.id, u.name]));
    await notify.send(db.query, {
      users: other.filter(Boolean), kind: 'challenge', actor: me.id, dedupe: `challenge:${x.id}`,
      title: `${pair ? `${name.get(side[0])} & ${name.get(side[1])} challenge you` : `${me.name} challenges you`} to ${s.name}`,
      body: [formatName(x), place, message].filter(Boolean).join(' · ') || 'Accept or decline in the app.',
      url: `/c/${x.id}`,
    });
    return get(x.id, actor);
  }

  async function respond(id, actor, { accept }) {
    const me = needUser(actor);
    await db.tx(async (q) => {
      const x = await settle(q, await load(q, id, { lock: true }));
      if (x.status !== 'sent') fail(409, x.status === 'expired' ? 'This challenge expired' : 'Already answered');
      if (![x.b1, x.b2].includes(me.id)) fail(403, 'Only the challenged side can answer');
      await q('UPDATE challenges SET status = $1, responded_at = now() WHERE id = $2', [accept ? 'accepted' : 'declined', x.id]);
      await notify.send(q, {
        users: [x.a1, x.a2].filter(Boolean), kind: 'challenge_reply', actor: me.id, dedupe: `reply:${x.id}`,
        title: accept ? `${me.name} accepted your challenge 🔥` : `${me.name} can't play this time`,
        body: accept ? 'Play it, then score it live or enter the result.' : null, url: `/c/${x.id}`,
      });
    });
    return get(id, actor);
  }

  async function cancel(id, actor) {
    const me = needUser(actor);
    await db.tx(async (q) => {
      const x = await load(q, id, { lock: true });
      if (x.created_by !== me.id || !['sent', 'accepted'].includes(x.status)) fail(409, 'This challenge can\'t be cancelled now');
      await q(`UPDATE challenges SET status = 'cancelled' WHERE id = $1`, [x.id]);
    });
    return get(id, actor);
  }

  // ---------- playing

  async function playing(q, id, actor) {
    const me = needUser(actor);
    const x = await load(q, id, { lock: true });
    if (!sideOf(x, me.id)) fail(403, 'Only the players can score this game');
    if (!['accepted', 'live'].includes(x.status)) fail(409, x.status === 'sent' ? 'Waiting for them to accept' : 'This game is over');
    return x;
  }
  async function rally(id, actor, { side, at, ...extra } = {}) {
    await db.tx(async (q) => {
      const x = await playing(q, id, actor);
      if (x.final) fail(409, 'This game was entered as a final score');
      if (at !== undefined && Number(at) !== x.rallies.length) fail(409, 'Someone else scored at the same time — the score has been refreshed', 'stale');
      const tap = sports.tapFor(scoreOf(x), { ...extra, side });
      if (tap.error) fail(400, tap.error);
      const rallies = x.rallies + tap.ch;
      const sc = scoreOf(x, rallies);
      await q('UPDATE challenges SET rallies = $1, status = $2, winner = $3, ended_at = $4 WHERE id = $5',
        [rallies, sc.winner ? 'done' : 'live', sc.winner || null, sc.winner ? new Date().toISOString() : null, x.id]);
      if (sc.winner) await askToConfirm(q, { ...x, rallies, winner: sc.winner }, actor.user.id);
    });
    return get(id, actor);
  }
  async function undo(id, actor, { at } = {}) {
    const me = needUser(actor);
    await db.tx(async (q) => {
      const x = await load(q, id, { lock: true });
      if (!sideOf(x, me.id)) fail(403, 'Only the players can score this game');
      if (!['live', 'done'].includes(x.status) || !x.rallies || x.final) fail(409, 'Nothing to undo');
      if (at !== undefined && Number(at) !== x.rallies.length) fail(409, 'Someone else scored at the same time — the score has been refreshed', 'stale');
      await q(`UPDATE challenges SET rallies = $1, status = 'live', winner = NULL, ended_at = NULL WHERE id = $2`, [x.rallies.slice(0, -1), x.id]);
    });
    return get(id, actor);
  }
  async function result(id, actor, input = {}) {
    await db.tx(async (q) => {
      const x = await playing(q, id, actor);
      const a = Number(input.a);
      const b = Number(input.b);
      if (![a, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 99) || a === b) fail(400, 'Enter both scores, like 21 and 17');
      const winner = a > b ? 'a' : 'b';
      await q(`UPDATE challenges SET final = $1::jsonb, rallies = '', status = 'done', winner = $2, ended_at = now() WHERE id = $3`, [JSON.stringify({ a, b }), winner, x.id]);
      await askToConfirm(q, { ...x, final: { a, b }, winner }, actor.user.id);
    });
    return get(id, actor);
  }

  async function askToConfirm(q, x, actorId) {
    const names = await q('SELECT name FROM users WHERE id = ANY($1::int[])', [(x.winner === 'a' ? [x.a1, x.a2] : [x.b1, x.b2]).filter(Boolean)]);
    const score = x.final ? `${x.final.a}–${x.final.b}` : sportOf(x).summary(scoreOf(x));
    await notify.send(q, {
      users: (x.winner === 'a' ? [x.b1, x.b2] : [x.a1, x.a2]).filter(Boolean), kind: 'confirm_game', actor: actorId, dedupe: `confirm-c:${x.id}`,
      title: `${names.map((u) => u.name).join(' & ')} won the challenge ${score} — confirm it`,
      body: `It confirms itself in ${AUTO_CONFIRM_HOURS} hours if you don't.`, url: `/c/${x.id}`,
    });
  }

  // The losing side confirms (or it confirms itself a day later): ratings,
  // the feed, and a nudge to the loser to challenge back.
  async function confirmIn(q, x, byId) {
    const sides = { a: [x.a1, x.a2].filter(Boolean), b: [x.b1, x.b2].filter(Boolean) };
    const margin = x.final ? Math.abs(x.final.a - x.final.b) : (() => { const sc = scoreOf(x); return Math.abs(sc.totals.a - sc.totals.b); })();
    const deltas = await rate(q, x.sport, sides, x.winner, margin);
    const [row] = await q(`UPDATE challenges SET status = 'confirmed', confirmed_by = $1, deltas = $2::jsonb WHERE id = $3 RETURNING *`, [byId, JSON.stringify(deltas), x.id]);
    const people = await q('SELECT id, name, profile_public FROM users WHERE id = ANY($1::int[])', [ids(x)]);
    const name = new Map(people.map((p) => [p.id, p.name]));
    const score = x.final ? `${x.final.a}–${x.final.b}` : sportOf(x).summary(scoreOf(x));
    await social.record(q, {
      dedupe: `challenge:${x.id}`, people: ids(x), sport: x.sport, verb: 'challenge', object: ['challenge', x.id], org: x.org_id,
      data: { a: sides.a.map((id) => name.get(id)), b: sides.b.map((id) => name.get(id)), winner: x.winner, winners: sides[x.winner], score, back: Boolean(x.parent_id), challenge: x.id },
      visibility: people.every((p) => p.profile_public) ? 'public' : 'followers',
    });
    return row;
  }
  async function confirm(id, actor) {
    const me = needUser(actor);
    await db.tx(async (q) => {
      const x = await load(q, id, { lock: true });
      if (!['done', 'disputed'].includes(x.status)) fail(409, x.status === 'confirmed' ? 'Already confirmed' : 'The game isn\'t finished');
      if (sideOf(x, me.id) !== (x.winner === 'a' ? 'b' : 'a')) fail(403, 'The other side confirms the result');
      await confirmIn(q, x, me.id);
    });
    return get(id, actor);
  }
  async function dispute(id, actor) {
    const me = needUser(actor);
    await db.tx(async (q) => {
      const x = await load(q, id, { lock: true });
      if (x.status !== 'done' || !sideOf(x, me.id)) fail(409, 'Only a finished, unconfirmed game can be disputed');
      // Disputed: doesn't count until the losing side keeps it, or it's played again.
      await q(`UPDATE challenges SET status = 'disputed' WHERE id = $1`, [x.id]);
    });
    return get(id, actor);
  }

  return { create, respond, cancel, rally, undo, result, confirm, dispute, get, mine, people, rate, unrate, ratingsOf, challengeable };
}

module.exports = { createChallenges };
