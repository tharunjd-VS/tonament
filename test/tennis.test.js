'use strict';

// Tennis and padel: 15-30-40, deuce or golden point, sets, tie-breaks.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const tennis = require('../server/sports/tennis');
const padel = require('../server/sports/padel');
const catalog = require('../public/sports/events');

const r = (side, n) => side.repeat(n);
const game = (w) => r(w, 4);
// Games alternating a, b until 6-6.
const toSixAll = () => Array.from({ length: 6 }, () => game('a') + game('b')).join('');

test('points: 15-30-40, deuce and advantage, the server alternates games', () => {
  let s = tennis.compute('');
  assert.deepEqual([s.points, s.setGames, s.server, s.serveCourt], [{ a: '0', b: '0' }, { a: 0, b: 0 }, 'a', 'right']);
  s = tennis.compute('aab');
  assert.deepEqual([s.points, s.serveCourt], [{ a: '30', b: '15' }, 'left']);
  s = tennis.compute('aaabbb');
  assert.deepEqual([s.points, s.note], [{ a: '40', b: '40' }, 'deuce']);
  s = tennis.compute('aaabbbb');
  assert.deepEqual([s.points, s.note], [{ a: '40', b: 'AD' }, 'break point']);
  s = tennis.compute('aaabbbbaa'); // back to deuce, then advantage a
  assert.deepEqual(s.points, { a: 'AD', b: '40' });
  s = tennis.compute('aaabbbbaaa');
  assert.deepEqual([s.setGames, s.server, s.points, s.note], [{ a: 1, b: 0 }, 'b', { a: '0', b: '0' }, 'change ends']);
});

test('golden point: the next point at 40-40 wins the game', () => {
  let s = tennis.compute('aaabbb', { scoring: 'golden' });
  assert.equal(s.note, 'golden point · break point');
  s = tennis.compute('aaabbbb', { scoring: 'golden' });
  assert.deepEqual(s.setGames, { a: 0, b: 1 });
});

test('sets: 6 games win by 2, tie-break at 6-6 with its own serve order', () => {
  assert.equal(tennis.compute(r('a', 24)).games[0].winner, 'a');
  let s = tennis.compute(r('a', 20) + r('b', 20)); // 5-5
  assert.equal(s.games[0].winner, null);
  s = tennis.compute(r('a', 20) + r('b', 20) + r('a', 8)); // 7-5
  assert.deepEqual(s.games[0], { a: 7, b: 5, winner: 'a' });

  const tb = toSixAll();
  s = tennis.compute(tb);
  assert.deepEqual([s.points, s.note, s.server], [{ a: '0', b: '0' }, 'tie-break', 'a']);
  assert.deepEqual(['a', 'ab', 'abb', 'abba'].map((x) => tennis.compute(tb + x).server), ['b', 'b', 'a', 'a']);
  assert.equal(tennis.compute(tb + 'abbaab').note, 'tie-break · change ends');
  s = tennis.compute(tb + r('ab', 6) + 'a'); // 7-6 in the tie-break: not yet
  assert.equal(s.games[0].winner, null);
  assert.equal(s.gamePoint.a, true); // set point
  s = tennis.compute(tb + r('ab', 6) + 'aa');
  assert.deepEqual([s.games[0].a, s.games[0].b, s.games[0].tb], [7, 6, { a: 8, b: 6 }]);
  assert.equal(s.server, 'b'); // the tie-break's first receiver serves the next set
  assert.equal(tennis.summary(s), '7-6(6)');
});

test('match: best of 3, set and match points, match tie-break, standings totals', () => {
  let s = tennis.compute(r('a', 24) + r('a', 23));
  assert.deepEqual([s.gamePoint.a, s.matchPoint.a, s.matchPoint.b], [true, true, false]);
  s = tennis.compute(r('a', 48));
  assert.deepEqual([s.winner, tennis.summary(s), s.totals], ['a', '6-0, 6-0', { a: 12, b: 0 }]);
  assert.equal(s.server, null);

  const cfg = { finalSet: 'super' };
  s = tennis.compute(r('a', 24) + r('b', 24), cfg);
  assert.deepEqual([s.games.length, s.note, s.points], [3, 'match tie-break', { a: '0', b: '0' }]);
  s = tennis.compute(r('a', 24) + r('b', 24) + r('ab', 9) + 'a', cfg); // 10-9: win by 2
  assert.equal(s.winner, null);
  s = tennis.compute(r('a', 24) + r('b', 24) + r('ab', 9) + 'aa', cfg);
  assert.deepEqual([s.winner, tennis.summary(s)], ['a', '6-0, 0-6, [11-9]']);

  assert.equal(tennis.compute(r('a', 16), { bestOf: 1, games: 4 }).winner, 'a'); // short set
  assert.deepEqual(tennis.normalizeConfig({ bestOf: 1, finalSet: 'super' }), { bestOf: 1, games: 6, scoring: 'ad', finalSet: 'set' });
  assert.deepEqual(tennis.normalizeConfig({ bestOf: '5', games: '8', scoring: 'x' }), { bestOf: 5, games: 8, scoring: 'ad', finalSet: 'set' });
});

test('padel is pairs only and scored like tennis', async () => {
  assert.deepEqual(catalog.presetsFor('padel').map((p) => p.key), ['MD', 'WD', 'XD', 'OD']);
  assert.equal(padel.compute(r('a', 48)).winner, 'a');

  const db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  try {
    const svc = createApp(db).service;
    const ORG = { user: { id: 1, email: 'org@padel.test', name: 'Org', isAdmin: false } };
    const { id } = await svc.createTournament(ORG, {
      name: 'Padel Night', sport: 'padel', format: 'league', scoring: { bestOf: 1, scoring: 'golden' },
      events: [{ discipline: 'doubles', gender: 'mixed' }],
    });
    await assert.rejects(svc.createTournament(ORG, { name: 'Bad', sport: 'padel', events: [{ discipline: 'singles' }] }), /doubles events only/);
    await svc.addEntries(id, ORG, ['A / B', 'C / D']);
    let t = await svc.start(id, ORG);
    const [m] = t.events[0].matches;
    let after;
    for (let i = 0; i < 24; i++) after = await svc.rally(id, ORG, m.id, 'b');
    assert.equal(after.summary, '0-6');
    t = await svc.getTournament(id, ORG);
    const [first] = t.events[0].groups[0].standings;
    assert.deepEqual([first.name, first.won, first.gamesFor, first.pointsFor], ['C / D', 1, 1, 6]); // sets, then games
  } finally {
    await db.close();
  }
});
