'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../server/formats');

function pairsOf(rounds) {
  return rounds.flat().map(([a, b]) => [a, b].sort().join('-'));
}

test('round robin: everyone plays everyone once, nobody twice in a round', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const rounds = f.roundRobin(ids);
    const pairs = pairsOf(rounds);
    assert.equal(pairs.length, (n * (n - 1)) / 2, `n=${n}`);
    assert.equal(new Set(pairs).size, pairs.length, `n=${n} duplicates`);
    for (const round of rounds) {
      const players = round.flat();
      assert.equal(new Set(players).size, players.length, `n=${n} double-booked`);
    }
  }
  assert.deepEqual(f.roundRobin([1]), []);
});

test('snake draw spreads seeds', () => {
  assert.deepEqual(f.snakeGroups([1, 2, 3, 4, 5, 6, 7, 8], 2), [[1, 4, 5, 8], [2, 3, 6, 7]]);
  assert.deepEqual(f.snakeGroups([1, 2, 3, 4, 5, 6, 7], 3), [[1, 6, 7], [2, 5], [3, 4]]);
});

test('seed order', () => {
  assert.deepEqual(f.seedOrder(2), [1, 2]);
  assert.deepEqual(f.seedOrder(8), [1, 8, 4, 5, 2, 7, 3, 6]);
});

test('knockout slots: byes go to top seeds', () => {
  const seeded = [1, 2, 3, 4, 5].map((id) => ({ id, group: null, tier: 0 }));
  const slots = f.knockoutSlots(seeded);
  assert.equal(slots.length, 8);
  // pairs: (1,bye) (4,5) (2,bye) (3,bye)
  assert.deepEqual(slots, [1, null, 4, 5, 2, null, 3, null]);
});

test('knockout slots avoid same-group first-round matches', () => {
  for (const groups of [2, 3, 4]) {
    const seeded = [];
    for (let tier = 0; tier < 2; tier++) for (let g = 0; g < groups; g++) seeded.push({ id: `${g}-${tier}`, group: g, tier });
    const slots = f.knockoutSlots(seeded);
    for (let i = 0; i < slots.length; i += 2) {
      if (slots[i] && slots[i + 1]) assert.notEqual(slots[i][0], slots[i + 1][0], `groups=${groups} ${slots}`);
    }
    assert.equal(slots.filter(Boolean).length, seeded.length);
  }
});

test('round names', () => {
  assert.equal(f.roundName(3, 3), 'Final');
  assert.equal(f.roundName(2, 3), 'Semi-finals');
  assert.equal(f.roundName(1, 3), 'Quarter-finals');
  assert.equal(f.roundName(1, 4), 'Round of 16');
});

const res = (a, b, winner, gamesA, gamesB, pointsA, pointsB) => ({ a, b, winner, gamesA, gamesB, pointsA, pointsB });

test('standings: two-way tie broken by head-to-head', () => {
  // 1 beats 2, 2 beats 3, 3 beats 1 -> three-way tie on wins; then 4 loses to all.
  // Two-way case: 1 and 2 both 2 wins, 2 beat 1.
  const results = [
    res(1, 2, 2, 0, 2, 10, 42),
    res(1, 3, 1, 2, 0, 42, 0),
    res(1, 4, 1, 2, 0, 42, 0),
    res(2, 3, 3, 0, 2, 0, 42),
    res(2, 4, 2, 2, 0, 42, 0),
    res(3, 4, 4, 0, 2, 0, 42),
  ];
  // wins: 1 -> 2, 2 -> 2, 3 -> 1, 4 -> 1
  const table = f.standings([1, 2, 3, 4], results);
  assert.equal(table[0].id, 2); // h2h winner despite worse point difference
  assert.equal(table[1].id, 1);
  // 3 vs 4 tied on 1 win: 4 beat 3 head-to-head
  assert.equal(table[2].id, 4);
  assert.equal(table[3].id, 3);
});

test('standings: three-way tie uses game then point difference', () => {
  const results = [
    res(1, 2, 1, 2, 0, 42, 20),
    res(2, 3, 2, 2, 1, 50, 40),
    res(3, 1, 3, 2, 1, 55, 50),
  ];
  const table = f.standings([1, 2, 3], results);
  // game diff: 1 -> (2+1)-(0+2)=+1, 2 -> (0+2)-(2+1)=-1, 3 -> (1+2)-(2+1)=0
  assert.deepEqual(table.map((r) => r.id), [1, 3, 2]);
  assert.equal(table[0].played, 2);
});

test('standings with no results keep seed order', () => {
  assert.deepEqual(f.standings([5, 3, 9], []).map((r) => r.id), [5, 3, 9]);
});
