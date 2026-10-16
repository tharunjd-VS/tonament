'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bad = require('../server/sports/badminton');

const r = (side, n) => side.repeat(n);

test('a straight game ends at 21 and starts the next game', () => {
  const s = bad.compute(r('a', 21));
  assert.deepEqual(s.games[0], { a: 21, b: 0, winner: 'a' });
  assert.equal(s.games.length, 2);
  assert.deepEqual(s.gamesWon, { a: 1, b: 0 });
  assert.equal(s.winner, null);
});

test('deuce: must win by two', () => {
  const at2020 = r('ab', 20);
  let s = bad.compute(at2020 + 'a');
  assert.deepEqual([s.games[0].a, s.games[0].b], [21, 20]);
  assert.equal(s.games[0].winner, null);
  assert.equal(s.gamePoint.a, true);
  s = bad.compute(at2020 + 'aa');
  assert.equal(s.games[0].winner, 'a');
});

test('point cap: 30 wins at 29-29', () => {
  const s = bad.compute(r('ab', 29) + 'b');
  assert.deepEqual(s.games[0], { a: 29, b: 30, winner: 'b' });
});

test('both sides are on game point at 29-29', () => {
  const s = bad.compute(r('ab', 29));
  assert.deepEqual(s.gamePoint, { a: true, b: true });
});

test('best of 3 match winner, and extra rallies are ignored', () => {
  const s = bad.compute(r('a', 21) + r('b', 21) + r('a', 21) + 'bbb');
  assert.equal(s.winner, 'a');
  assert.deepEqual(s.gamesWon, { a: 2, b: 1 });
  assert.equal(s.games.length, 3);
  assert.equal(s.server, null);
  assert.equal(bad.summary(s), '21-0, 0-21, 21-0');
});

test('match point only when the game would win the match', () => {
  let s = bad.compute(r('a', 20));
  assert.equal(s.gamePoint.a, true);
  assert.equal(s.matchPoint.a, false);
  s = bad.compute(r('a', 21) + r('a', 20));
  assert.equal(s.matchPoint.a, true);
});

test('server and service court follow the rally winner', () => {
  let s = bad.compute('', {}, 'b');
  assert.equal(s.server, 'b');
  assert.equal(s.serveCourt, 'right');
  s = bad.compute('a', {}, 'b');
  assert.equal(s.server, 'a');
  assert.equal(s.serveCourt, 'left'); // a has 1 point -> odd -> left
  // winner of a game serves first in the next
  s = bad.compute(r('b', 21));
  assert.equal(s.server, 'b');
  assert.equal(s.serveCourt, 'right');
});

test('custom format: single game to 15 with no deuce', () => {
  const cfg = { bestOf: 1, points: 15, cap: 15 };
  const s = bad.compute(r('ab', 14) + 'b', cfg);
  assert.equal(s.winner, 'b');
  assert.deepEqual(s.games, [{ a: 14, b: 15, winner: 'b' }]);
});

test('config is normalised', () => {
  assert.deepEqual(bad.normalizeConfig({}), { bestOf: 3, points: 21, cap: 30 });
  assert.deepEqual(bad.normalizeConfig({ bestOf: 2, points: 15 }), { bestOf: 3, points: 15, cap: 24 });
  assert.deepEqual(bad.normalizeConfig({ points: 11, cap: 5 }), { bestOf: 3, points: 11, cap: 20 });
});
