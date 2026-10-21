'use strict';

// Pickleball, table tennis and squash rules (shared with the browser).

const test = require('node:test');
const assert = require('node:assert/strict');
const pb = require('../server/sports/pickleball');
const tt = require('../server/sports/table-tennis');
const sq = require('../server/sports/squash');

const r = (side, n) => side.repeat(n);
const DOUBLES = { doubles: true };

test('pickleball doubles, side-out: 0-0-2 start, two servers, no points for the receivers', () => {
  let s = pb.compute('', DOUBLES);
  assert.deepEqual([s.server, s.call, s.serveCourt], ['a', '0-0-2', 'right']);
  assert.deepEqual(s.tap, { a: '+1', b: 'Side out' }); // what the umpire's buttons say
  s = pb.compute('a', DOUBLES); // the server's side wins: a point, same server, other court
  assert.deepEqual([s.games[0].a, s.call, s.serveCourt], [1, '1-0-2', 'left']);
  s = pb.compute('ab', DOUBLES); // the first server of the game had no partner turn: side-out
  assert.deepEqual([s.server, s.call, s.games[0].b], ['b', '0-1-1', 0]);
  s = pb.compute('abb', DOUBLES);
  assert.deepEqual([s.server, s.call], ['b', '1-1-1']);
  assert.deepEqual(s.tap, { a: '2nd server', b: '+1' });
  s = pb.compute('abba', DOUBLES); // server 1 loses: partner serves
  assert.deepEqual([s.server, s.call, s.games[0].a], ['b', '1-1-2', 1]);
  s = pb.compute('abbaa', DOUBLES); // server 2 loses: side-out to a's server 1
  assert.deepEqual([s.server, s.call], ['a', '1-1-1']);
  assert.deepEqual(s.gamePoint, { a: false, b: false });
});

test('pickleball: games to 11 win by 2, best of 3, receivers serve first next game', () => {
  let s = pb.compute(r('a', 10), DOUBLES);
  assert.deepEqual([s.gamePoint.a, s.gamePoint.b], [true, false]); // only the serving side can win the game
  s = pb.compute(r('a', 11), DOUBLES);
  assert.deepEqual(s.games[0], { a: 11, b: 0, winner: 'a' });
  assert.deepEqual([s.server, s.call], ['b', '0-0-2']); // b received first in game 1
  s = pb.compute(r('a', 11) + r('b', 11), DOUBLES);
  assert.deepEqual(s.gamesWon, { a: 1, b: 1 });
  assert.equal(s.server, 'a');
  assert.equal(s.matchPoint.a, false);
  s = pb.compute(r('a', 11) + r('b', 11) + r('a', 11), DOUBLES);
  assert.equal(s.winner, 'a');
  assert.equal(pb.summary(s), '11-0, 0-11, 11-0');

  // Win by two: 10-10 with rally scoring, then 12-10.
  const rally = { scoring: 'rally', bestOf: 1 };
  s = pb.compute(r('ab', 10) + 'a', rally);
  assert.equal(s.winner, null);
  s = pb.compute(r('ab', 10) + 'aa', rally);
  assert.equal(s.winner, 'a');
});

test('pickleball singles side-out and rally scoring', () => {
  let s = pb.compute('');
  assert.equal(s.call, '0-0'); // no server number in singles
  s = pb.compute('b'); // side-out straight away
  assert.deepEqual([s.server, s.games[0].b, s.call], ['b', 0, '0-0']);
  s = pb.compute('bb');
  assert.deepEqual([s.games[0].b, s.call], [1, '1-0']);

  s = pb.compute('b', { scoring: 'rally', doubles: true }); // every rally scores
  assert.deepEqual([s.games[0].b, s.server, s.call, s.tap], [1, 'b', '1-0', null]);
  assert.deepEqual(s.gamePoint, { a: false, b: false });
  s = pb.compute(r('a', 10), { scoring: 'rally' });
  assert.equal(s.gamePoint.a, true);
});

test('pickleball settings are tidied', () => {
  assert.deepEqual(pb.normalizeConfig({}), { scoring: 'sideout', bestOf: 3, points: 11 });
  assert.deepEqual(pb.normalizeConfig({ scoring: 'rally', bestOf: '1', points: '21', doubles: true }), { scoring: 'rally', bestOf: 1, points: 21, doubles: true });
  assert.deepEqual(pb.normalizeConfig({ scoring: 'x', bestOf: 4, points: 99 }), { scoring: 'sideout', bestOf: 3, points: 11 });
  assert.equal(pb.compute(r('a', 15), { points: 15, bestOf: 1 }).winner, 'a');
});

test('table tennis: serve every 2 points, every point at deuce, best of 5', () => {
  const servers = [...Array(6).keys()].map((n) => tt.compute(r('a', n)).server).join('');
  assert.equal(servers, 'aabbaa');
  assert.equal(tt.compute('').note, 'serve 1 of 2');
  const deuce = r('ab', 10);
  assert.deepEqual([tt.compute(deuce).server, tt.compute(deuce + 'a').server, tt.compute(deuce + 'ab').server], ['a', 'b', 'a']);
  assert.equal(tt.compute(deuce).note, '1 serve each at deuce');
  assert.equal(tt.compute(deuce + 'a').winner, null);
  let s = tt.compute(r('a', 11));
  assert.equal(s.server, 'b'); // b received first in game 1
  s = tt.compute(r('a', 33));
  assert.equal(s.winner, 'a');
  assert.deepEqual(s.gamesWon, { a: 3, b: 0 });
  assert.equal(tt.compute(r('a', 22), { bestOf: 3 }).winner, 'a');
  assert.deepEqual(tt.normalizeConfig({ bestOf: 4, points: 15 }), { bestOf: 5, points: 11 });
});

test('squash: point-a-rally to 11, the rally winner serves, best of 5', () => {
  assert.equal(sq.compute('ab').server, 'b');
  assert.equal(sq.compute('ab').games[0].b, 1);
  const s = sq.compute(r('b', 11));
  assert.deepEqual([s.games[0].winner, s.server], ['b', 'b']); // the game's winner serves first
  assert.equal(sq.compute(r('ab', 10) + 'a').winner, null);
  assert.equal(sq.compute(r('b', 33)).winner, 'b');
  assert.equal(sq.compute(r('b', 22), { bestOf: 3 }).winner, 'b');
});

test('a pickleball doubles tournament is scored side-out on the server', async () => {
  const { createDb } = require('../server/db');
  const { createApp } = require('../server/app');
  const db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  try {
    const svc = createApp(db).service;
    const ORG = { user: { id: 1, email: 'org@pickle.test', name: 'Org', isAdmin: false } };
    const { id } = await svc.createTournament(ORG, {
      name: 'Dink Open', sport: 'pickleball', format: 'knockout', scoring: { bestOf: 1, points: 11 },
      events: [{ discipline: 'doubles', gender: 'mixed' }, { discipline: 'singles', gender: 'open' }],
    });
    let t = await svc.getTournament(id, ORG);
    assert.equal(t.sport.id, 'pickleball');
    assert.deepEqual(t.events[0].config.scoring, { scoring: 'sideout', bestOf: 1, points: 11 });
    const [xd, os] = t.events;
    await svc.addEntries(id, ORG, ['Asha / Ben', 'Cy / Dev'], { event: xd.id });
    t = await svc.start(id, ORG, { event: xd.id });
    const [m] = t.events[0].matches;
    assert.equal(m.score.call, '0-0-2');
    await svc.rally(id, ORG, m.id, 'b'); // side-out: no point
    let after = await svc.rally(id, ORG, m.id, 'b');
    assert.deepEqual([after.score.games[0].b, after.score.call], [1, '1-0-1']);
    for (let i = 0; i < 10; i++) after = await svc.rally(id, ORG, m.id, 'b');
    assert.equal(after.status, 'done');
    assert.equal(after.summary, '0-11');

    // The singles event has no server number; organisers can switch to rally scoring.
    t = await svc.updateEvent(id, ORG, os.id, { scoring: { scoring: 'rally', bestOf: 3, points: 15 } });
    assert.deepEqual(t.events[1].config.scoring, { scoring: 'rally', bestOf: 3, points: 15 });
  } finally {
    await db.close();
  }
});
