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

test('snooker: best of N frames, one tap per frame, ends at the frames needed', () => {
  let s = snooker.compute('', { bestOf: 5 });
  assert.deepEqual([s.games[0].a, s.games[0].b, s.winner, s.note, s.single, s.unit], [0, 0, null, 'First to 3 frames', true, 'Frame']);
  s = snooker.compute('abab', { bestOf: 5 });
  assert.deepEqual([s.games[0].a, s.games[0].b, s.winner], [2, 2, null]);
  s = snooker.compute('ababa' + 'bbbb', { bestOf: 5 }); // taps after the end are ignored
  assert.deepEqual([s.winner, snooker.summary(s), s.gamesWon], ['a', '3-2', { a: 1, b: 0 }]);
  assert.equal(snooker.normalizeConfig({ bestOf: 4 }).bestOf, 3); // even lengths aren't allowed
  assert.equal(snooker.compute('b', { bestOf: 1 }).winner, 'b');
  assert.deepEqual(snooker.compute('a', {}).tap, { a: 'Frame', b: 'Frame' });
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
    for (let guard = 0; guard < 10 && t.status !== 'completed'; guard++) {
      const m = t.matches.find((x) => x.a && x.b && x.status !== 'done' && x.status !== 'bye');
      await svc.rally(id, ORG, m.id, 'a');
      await svc.rally(id, ORG, m.id, 'b');
      t = await svc.rally(id, ORG, m.id, 'a').then(() => svc.getTournament(id, ORG));
    }
    assert.equal(t.status, 'completed');
    assert.equal(t.champion.name, 'Ravi');
    const final = t.matches.find((x) => x.round === t.config.knockoutRounds);
    assert.equal(final.summary, '2-1');

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
