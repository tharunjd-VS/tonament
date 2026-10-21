'use strict';

// League matches of exactly 2 games, where 1-1 is a draw; group tables then
// rank on league points (win 2, draw 1, loss 0).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const f = require('../server/formats');
const league = require('../public/sports/league');
const sport = (id) => require(`../public/sports/${id}`);

// One game won w-l (w wins), alternating points until the end.
const game = (winner, w, l) => {
  const loser = winner === 'a' ? 'b' : 'a';
  return (winner + loser).repeat(l) + winner.repeat(w - l);
};
const draws = { draws: true };

test('2-game matches: 1-1 is a draw, 2-0 a win, every sport', () => {
  const cases = [
    ['badminton', {}, 21], ['table-tennis', {}, 11], ['squash', {}, 11], ['pickleball', { scoring: 'rally' }, 11],
    ['volleyball', {}, 25], ['beach-volleyball', {}, 21], ['throwball', {}, 25], ['sepak-takraw', {}, 21],
  ];
  for (const [id, cfg, pts] of cases) {
    const s = sport(id);
    const d = league.score(s, game('a', pts, pts - 3) + game('b', pts, pts - 3), cfg, 'a', draws);
    assert.deepEqual([d.draw, d.winner, d.games.length, s.summary(d)], [true, null, 2, `${pts}-${pts - 3}, ${pts - 3}-${pts}`], id);
    assert.ok(league.finished(d), id);
    const w = league.score(s, game('b', pts, 5) + game('b', pts, 5), cfg, 'a', draws);
    assert.deepEqual([w.winner, Boolean(w.draw)], ['b', false], id);
    // Without draws the same 1-1 goes on to a third game.
    const on = league.score(s, game('a', pts, pts - 3) + game('b', pts, pts - 3), { ...cfg, bestOf: 3 }, 'a');
    assert.equal(on.winner, null, id);
    assert.equal(league.finished(on), false, id);
  }
  // Tennis and padel: 2 sets.
  for (const id of ['tennis', 'padel']) {
    const set = (w) => Array.from({ length: 6 }, () => w.repeat(4)).join('');
    const d = league.score(sport(id), set('a') + set('b'), {}, 'a', draws);
    assert.deepEqual([d.draw, sport(id).summary(d)], [true, '6-0, 0-6'], id);
  }
});

test('game 2: the leader is on match point, the trailer on game point', () => {
  const badminton = sport('badminton');
  const lead = league.score(badminton, game('a', 21, 15) + 'a'.repeat(20) + 'b'.repeat(10), {}, 'a', draws); // 20-10 in game 2
  assert.deepEqual([lead.matchPoint.a, lead.gamePoint.a], [true, true]);
  const trail = league.score(badminton, game('a', 21, 15) + 'b'.repeat(20) + 'a'.repeat(10), {}, 'a', draws); // 10-20
  assert.deepEqual([trail.gamePoint.b, trail.matchPoint.b], [true, false]);
  // Game 1 is never a match point.
  const first = league.score(badminton, 'a'.repeat(20), {}, 'a', draws);
  assert.deepEqual([first.gamePoint.a, first.matchPoint.a], [true, false]);
});

const res = (a, b, winner, gamesA, gamesB, pointsA, pointsB) => ({ a, b, winner, draw: winner === null, gamesA, gamesB, pointsA, pointsB });

test('standings: league points, a drawn head-to-head falls through', () => {
  // 1: W D = 3 points, 2: W D = 3 points, 3: L L = 0.
  let table = f.standings([1, 2, 3], [
    res(1, 3, 1, 2, 0, 42, 20),
    res(1, 2, null, 1, 1, 30, 30),
    res(2, 3, 2, 2, 0, 42, 0),
  ]);
  assert.deepEqual(table.map((r) => [r.id, r.won, r.drawn, r.lost, r.leaguePoints]), [[2, 1, 1, 0, 3], [1, 1, 1, 0, 3], [3, 0, 0, 2, 0]]);
  // 1 and 2 drew each other, so game difference (equal), then point difference: 2 is +42, 1 is +22.

  table = f.standings([1, 2, 3, 4], [
    res(1, 2, null, 1, 1, 40, 40),
    res(1, 3, 1, 2, 0, 42, 30),
    res(2, 3, 3, 0, 2, 30, 42),
    res(1, 4, 1, 2, 0, 42, 10),
    res(2, 4, 2, 2, 0, 42, 10),
    res(3, 4, null, 1, 1, 40, 40),
  ]);
  // 1: W W D = 5; 2: W L D = 3; 3: W L D = 3; 4: L L D = 1. 2 and 3: 3 beat 2 head-to-head.
  assert.deepEqual(table.map((r) => [r.id, r.leaguePoints]), [[1, 5], [3, 3], [2, 3], [4, 1]]);

  // Without draws, points are 2 x wins: the order is the same as before.
  table = f.standings([1, 2], [res(1, 2, 2, 0, 2, 0, 42)]);
  assert.deepEqual(table.map((r) => [r.id, r.won, r.leaguePoints]), [[2, 1, 2], [1, 0, 0]]);
});

test('a 2-game league: draws finish the match, tables count them, the knockout is best of 3', async () => {
  const db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  try {
    const svc = createApp(db).service;
    const ORG = { user: { id: 1, email: 'org@draws.test', name: 'Org', isAdmin: false } };
    const { id } = await svc.createTournament(ORG, {
      name: 'Draw League', sport: 'badminton', format: 'league_knockout', groupSize: 4, qualifiers: 2,
      leagueDraws: true, events: [{ discipline: 'singles', gender: 'open' }],
    });
    let t = await svc.getTournament(id, ORG);
    assert.equal(t.events[0].config.leagueDraws, true);
    await svc.addEntries(id, ORG, ['Asha', 'Ben', 'Chitra', 'Dev']);
    t = await svc.start(id, ORG);
    await assert.rejects(svc.updateSettings(id, ORG, { event: t.events[0].id, leagueDraws: false }), /locked/);

    const play = async (m, rallies) => {
      let after;
      for (const side of rallies) after = await svc.rally(id, ORG, m.id, side);
      return after;
    };
    const matches = t.events[0].matches.filter((m) => m.stage === 'league');
    const byNames = (x, y) => matches.find((m) => [m.a.name, m.b.name].sort().join() === [x, y].sort().join());
    // Asha and Ben draw.
    const ab = byNames('Asha', 'Ben');
    const drawn = await play(ab, game('a', 21, 18) + game('b', 21, 18));
    assert.deepEqual([drawn.status, drawn.winner, drawn.draw, drawn.summary], ['done', null, true, '21-18, 18-21']);
    await assert.rejects(svc.rally(id, ORG, ab.id, 'a'), /already finished/);
    // Undo reopens it.
    const undone = await svc.undo(id, ORG, ab.id);
    assert.deepEqual([undone.status, undone.draw], ['live', false]);
    await svc.rally(id, ORG, ab.id, 'b');

    // Everyone else: the earlier-listed name wins 2-0.
    const order = ['Asha', 'Ben', 'Chitra', 'Dev'];
    for (const m of matches.filter((x) => x.id !== ab.id)) {
      const first = order.indexOf(m.a.name) < order.indexOf(m.b.name) ? 'a' : 'b';
      const done = await play(m, game(first, 21, 10) + game(first, 21, 10));
      assert.equal(done.status, 'done');
    }
    t = await svc.getTournament(id, ORG);
    const table = t.events[0].groups[0].standings;
    assert.deepEqual(table.map((r) => [r.name, r.won, r.drawn, r.lost, r.leaguePoints]), [
      ['Asha', 2, 1, 0, 5], ['Ben', 2, 1, 0, 5], ['Chitra', 1, 0, 2, 2], ['Dev', 0, 0, 3, 0],
    ]);

    // The knockout keeps best of 3: 1-1 goes on to a third game.
    t = await svc.startKnockout(id, ORG);
    const ko = t.events[0].matches.find((m) => m.stage === 'knockout' && m.a && m.b);
    const after = await play(ko, game('a', 21, 18) + game('b', 21, 18));
    assert.deepEqual([after.status, Boolean(after.draw)], ['live', false]);
  } finally {
    await db.close();
  }
});
