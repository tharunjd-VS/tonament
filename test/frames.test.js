'use strict';

// Snooker and pool (best of N frames, one tap per frame) and carrom (games
// to 25 or 29, first to the target wins).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const sports = require('../server/sports');
const snooker = require('../server/sports/snooker');
const pool = require('../server/sports/pool');
const carrom = require('../server/sports/carrom');
const events = require('../public/sports/events');

const R = require('../public/sports/rally');
const { tapFor } = sports;
const FR = { scoring: 'frames' };
// A string of taps from [side, points, foul?] / 'end'.
const taps = (...xs) => xs.map((x) => (x === 'end' ? 'x' : R.tapCode(x[0], x[1], x[2]))).join('');

test('taps: one character per tap, every value both ways', () => {
  const seen = new Set();
  for (const side of ['a', 'b']) {
    for (let n = 1; n <= R.MAX_TAP; n++) {
      const ch = R.tapCode(side, n);
      assert.equal(ch.length, 1);
      assert.deepEqual(R.readTap(ch), { side, n });
      assert.ok(!seen.has(ch), ch); seen.add(ch);
    }
    for (let n = 4; n <= 7; n++) {
      const ch = R.tapCode(side, n, true);
      assert.deepEqual(R.readTap(ch), { side, n, foul: true });
      assert.ok(!seen.has(ch), ch); seen.add(ch);
    }
  }
  assert.equal(R.tapCode('a'), 'a'); // old matches are unchanged
  assert.deepEqual(R.readTap('x'), { end: true });
  assert.equal(R.readTap('?'), null);
});

test('snooker by points: balls add up, fouls go to the opponent, end frame gives it to the leader', () => {
  // A maximum: 15 reds each followed by the black, then the colours.
  const max = [];
  for (let i = 0; i < 15; i++) max.push(['a', 1], ['a', 7]);
  for (let n = 2; n <= 7; n++) max.push(['a', n]);
  let s = snooker.compute(taps(...max), { bestOf: 3 });
  assert.deepEqual([s.games[0].a, s.brk.n, s.note, s.taps], [147, 147, 'Frame 1 · Break 147 · First to 2 frames', { max: 7, fouls: true, end: true }]);
  s = snooker.compute(taps(...max, 'end'), { bestOf: 3 });
  assert.deepEqual([s.gamesWon, s.games.length, s.brk.n, s.note], [{ a: 1, b: 0 }, 2, 0, 'Frame 2 · First to 2 frames']);

  // A foul ends the break and scores for the other player.
  s = snooker.compute(taps(['a', 1], ['a', 5], ['b', 4, true], ['b', 1]), {});
  assert.deepEqual([s.games[0].a, s.games[0].b, s.brk], [6, 5, { side: 'b', n: 1 }]);
  // Level: the frame can't end (re-spotted black), and an 'x' is ignored.
  s = snooker.compute(taps(['a', 4], ['b', 4, true], 'end'), {});
  assert.deepEqual([s.games.length, s.taps.end], [1, false]);
  assert.match(tapFor(s, { end: true }).error, /level/);

  // Best of 3 to a winner, with the summary showing frame scores.
  s = snooker.compute(taps(['a', 7], 'end', ['b', 5], 'end', ['a', 1], ['b', 7, true], ['a', 7], ['a', 2], 'end', ['b', 1]), { bestOf: 3 });
  assert.deepEqual([s.winner, snooker.summary(s), s.taps.end], ['a', '2-1 (7-0, 0-5, 10-7)', false]);
  // Undo is one character: the black comes off in one go.
  const log = taps(['a', 1], ['a', 7]);
  assert.equal(snooker.compute(log.slice(0, -1), {}).games[0].a, 1);
});

test('which taps each sport takes', () => {
  const sn = snooker.compute('', {});
  assert.deepEqual(tapFor(sn, { side: 'a', points: 7 }), { ch: R.tapCode('a', 7) });
  assert.match(tapFor(sn, { side: 'a', points: 8 }).error, /1 to 7/);
  assert.deepEqual(tapFor(sn, { side: 'b', points: 6, foul: true }), { ch: R.tapCode('b', 6, true) });
  assert.match(tapFor(sn, { side: 'b', points: 3, foul: true }).error, /4 to 7/);
  const ca = carrom.compute('', {});
  assert.deepEqual(tapFor(ca, { side: 'b', points: 12 }), { ch: R.tapCode('b', 12) });
  assert.match(tapFor(ca, { side: 'b', points: 5, foul: true }).error, /no fouls/);
  const bad = sports.get('badminton').compute('', {});
  assert.deepEqual(tapFor(bad, { side: 'a' }), { ch: 'a' });
  assert.match(tapFor(bad, { side: 'a', points: 2 }).error, /one point at a time/);
  assert.match(tapFor(bad, { end: true }).error, /level/);
  assert.match(tapFor(snooker.compute('', FR), { side: 'a', points: 2 }).error, /one point/);
});

test('snooker frames only: best of N frames, one tap per frame, ends at the frames needed', () => {
  let s = snooker.compute('', { bestOf: 5, ...FR });
  assert.deepEqual([s.games[0].a, s.games[0].b, s.winner, s.note, s.single, s.unit], [0, 0, null, 'First to 3 frames', true, 'Frame']);
  s = snooker.compute('abab', { bestOf: 5, ...FR });
  assert.deepEqual([s.games[0].a, s.games[0].b, s.winner], [2, 2, null]);
  s = snooker.compute('ababa' + 'bbbb', { bestOf: 5, ...FR }); // taps after the end are ignored
  assert.deepEqual([s.winner, snooker.summary(s), s.gamesWon], ['a', '3-2', { a: 1, b: 0 }]);
  assert.equal(snooker.normalizeConfig({ bestOf: 4 }).bestOf, 3); // even lengths aren't allowed
  assert.equal(snooker.compute('b', { bestOf: 1, ...FR }).winner, 'b');
  assert.deepEqual(snooker.normalizeConfig({}), { bestOf: 3, scoring: 'points' });
  assert.deepEqual(snooker.compute('a', FR).tap, { a: 'Frame', b: 'Frame' });
});

test('pool: race to N racks, with the game type kept', () => {
  assert.deepEqual(pool.normalizeConfig({ bestOf: 9, game: '9-ball' }), { bestOf: 9, game: '9-ball' });
  assert.deepEqual(pool.normalizeConfig({ bestOf: 9, game: 'snooker' }), { bestOf: 9, game: '8-ball' });
  assert.equal(pool.fields[0].options.find((o) => o.value === 9).label, 'Race to 5');
  const s = pool.compute('aaaabbbbba', { bestOf: 9 });
  assert.deepEqual([s.winner, pool.summary(s), s.tap.a, s.hint], ['b', '4-5', 'Rack', 'Tap who won each rack.']);
  assert.equal(pool.compute('', { bestOf: 9 }).note, 'First to 5 racks');
});

test('carrom: first to 25 (or 29) wins the game, no margin needed', () => {
  let s = carrom.compute('a'.repeat(24) + 'b'.repeat(24), {});
  assert.deepEqual([s.games.length, s.gamePoint, s.server], [1, { a: true, b: true }, null]);
  s = carrom.compute('a'.repeat(24) + 'b'.repeat(24) + 'b', {});
  assert.deepEqual(s.games[0], { a: 24, b: 25, winner: 'b' });
  s = carrom.compute('a'.repeat(25) + 'b'.repeat(25) + 'a'.repeat(25), { bestOf: 3 });
  assert.deepEqual([s.winner, carrom.summary(s)], ['a', '25-0, 0-25, 25-0']);
  assert.equal(carrom.compute('a'.repeat(29), { points: 29, bestOf: 1 }).winner, 'a');
  assert.equal(carrom.compute('a'.repeat(25), { points: 29, bestOf: 1 }).winner, null);
  // A whole board in one tap: 12 + 11 + 2 reaches 25.
  s = carrom.compute(taps(['a', 12], ['b', 9], ['a', 11], ['a', 2]), { bestOf: 1 });
  assert.deepEqual([s.winner, carrom.summary(s)], ['a', '25-9']);
  // A board that runs past the target counts in full and doesn't spill into the next game.
  s = carrom.compute(taps(['a', 12], ['a', 12], ['a', 5]), { bestOf: 3 });
  assert.deepEqual([s.games[0], s.games[1]], [{ a: 29, b: 0, winner: 'a' }, { a: 0, b: 0, winner: null }]);
});

test('the catalogue, event types and words for the new sports', () => {
  for (const id of ['snooker', 'pool', 'carrom']) {
    assert.equal(sports.info(id).status, 'live', id);
    assert.ok(sports.get(id), id);
    assert.deepEqual(events.disciplinesFor(id), ['singles', 'doubles'], id);
  }
  assert.equal(events.courtWord('snooker'), 'Table');
  assert.equal(events.courtWord('carrom'), 'Board');
  assert.equal(events.perkLabel('shuttles', 'carrom'), 'Boards, coins and strikers provided');
});

test('a snooker knockout runs to a champion; carrom works in groups', async () => {
  const db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  try {
    const svc = createApp(db).service;
    const ORG = { user: { id: 1, email: 'org@frames.test', name: 'Org', isAdmin: false } };
    const { id } = await svc.createTournament(ORG, { name: 'Cue Club Open', sport: 'snooker', format: 'knockout', scoring: { bestOf: 3 }, events: [{ discipline: 'singles', gender: 'open' }] });
    await assert.rejects(svc.createTournament(ORG, { name: 'X', sport: 'snooker', events: [{ discipline: 'team', gender: 'men' }] }), /team/i);
    await svc.addEntries(id, ORG, ['Ravi', 'Kiran', 'Sam', 'Deepa']);
    let t = await svc.start(id, ORG);
    const first = t.matches.find((x) => x.a && x.b);
    await assert.rejects(svc.rally(id, ORG, first.id, 'a', undefined, { end: true }), /level/);
    await assert.rejects(svc.rally(id, ORG, first.id, 'a', undefined, { points: 9 }), /1 to 7/);
    for (let guard = 0; guard < 10 && t.status !== 'completed'; guard++) {
      const m = t.matches.find((x) => x.a && x.b && x.status !== 'done' && x.status !== 'bye');
      await svc.rally(id, ORG, m.id, 'a', undefined, { points: 7 });
      await svc.rally(id, ORG, m.id, null, undefined, { end: true });
      await svc.rally(id, ORG, m.id, 'a', undefined, { points: 4, foul: true }); // b fouled
      await svc.rally(id, ORG, m.id, 'b', undefined, { points: 6 });
      await svc.rally(id, ORG, m.id, null, 4, { end: true }); // `at` counts taps, not points
      await assert.rejects(svc.rally(id, ORG, m.id, 'a', 4, { points: 7 }), /changed on another device/);
      await svc.rally(id, ORG, m.id, 'a', undefined, { points: 5 });
      t = await svc.rally(id, ORG, m.id, null, undefined, { end: true }).then(() => svc.getTournament(id, ORG));
    }
    assert.equal(t.status, 'completed');
    assert.equal(t.champion.name, 'Ravi');
    const final = t.matches.find((x) => x.round === t.config.knockoutRounds);
    assert.equal(final.summary, '2-1 (7-0, 4-6, 5-0)');
    // Undo takes off a whole tap (the frame end), reopening the final.
    await svc.undo(id, ORG, final.id);
    t = await svc.getTournament(id, ORG);
    assert.equal(t.matches.find((x) => x.id === final.id).status, 'live');

    // Other sports still score one point a tap.
    const bad = await svc.createTournament(ORG, { name: 'Shuttle', sport: 'badminton', format: 'league', events: [{ discipline: 'singles', gender: 'open' }] });
    await svc.addEntries(bad.id, ORG, ['A', 'B']);
    const bt = await svc.start(bad.id, ORG);
    await assert.rejects(svc.rally(bad.id, ORG, bt.matches[0].id, 'a', undefined, { points: 3 }), /one point at a time/);

    // A carrom group: a final score works like any other sport.
    const [u] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('c@frames.test', 'Carrom Admin', 'x') RETURNING id`);
    const admin = { user: { id: u.id, email: 'c@frames.test', name: 'Carrom Admin', isAdmin: false } };
    const { slug } = await svc.groups.createGroup(admin, { name: 'Office Carrom', sport: 'carrom', courts: 2 });
    const g = await svc.groups.view(slug, admin);
    assert.equal(g.sport.name, 'Carrom');
    assert.deepEqual(g.settings.scoring, { bestOf: 1, points: 25 });
  } finally {
    await db.close?.();
  }
});
