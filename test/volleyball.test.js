'use strict';

// Volleyball, beach volleyball, throwball and sepak takraw: sets, a shorter
// deciding set, and team entries.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const vb = require('../server/sports/volleyball');
const beach = require('../server/sports/beach-volleyball');
const tb = require('../server/sports/throwball');
const st = require('../server/sports/sepak-takraw');
const catalog = require('../public/sports/events');

const r = (side, n) => side.repeat(n);
const sets = (...winners) => winners.map((w) => r(w, 25)).join('');

test('volleyball: sets to 25, win by 2, deciding 5th set to 15, first serve alternates', () => {
  let s = vb.compute(r('ab', 24) + 'a');
  assert.equal(s.unit, 'Set');
  assert.equal(s.games[0].winner, null); // 25-24 is not enough
  assert.equal(s.gamePoint.a, true);
  s = vb.compute(r('ab', 24) + 'aa');
  assert.deepEqual(s.games[0], { a: 26, b: 24, winner: 'a' });
  assert.equal(s.server, 'b'); // b served second in set 1, so serves first in set 2

  s = vb.compute(sets('a', 'b', 'a', 'b') + r('a', 14));
  assert.equal(s.games.length, 5);
  assert.deepEqual([s.gamePoint.a, s.matchPoint.a], [true, true]); // 14-0 in a set to 15
  s = vb.compute(sets('a', 'b', 'a', 'b') + r('a', 15));
  assert.equal(s.winner, 'a');
  assert.equal(vb.summary(s), '25-0, 0-25, 25-0, 0-25, 15-0');
  assert.equal(vb.compute(sets('b', 'b', 'b')).winner, 'b');
  assert.equal(vb.compute(r('a', 50), { bestOf: 3 }).winner, 'a');

  // Settings: the deciding set is dropped when it isn't shorter.
  assert.deepEqual(vb.normalizeConfig({}), { bestOf: 5, points: 25, decider: 15 });
  assert.deepEqual(vb.normalizeConfig({ points: 15, decider: 15 }), { bestOf: 5, points: 15, decider: 0 });
  assert.deepEqual(vb.normalizeConfig({ bestOf: 4, points: 30, decider: 7 }), { bestOf: 5, points: 25, decider: 15 });
});

test('beach volleyball, throwball and sepak takraw', () => {
  assert.equal(beach.compute(r('a', 7)).note, 'switch sides');
  assert.equal(beach.compute(r('a', 6)).note, null);
  assert.equal(beach.compute(r('a', 21) + r('b', 21) + r('a', 5)).note, 'switch sides'); // every 5 in the deciding set
  assert.equal(beach.compute(r('a', 21) + r('b', 21) + r('a', 7)).note, null);
  assert.equal(beach.compute(r('a', 42)).winner, 'a');

  assert.deepEqual(tb.normalizeConfig({}), { bestOf: 3, points: 25, decider: 0 });
  assert.equal(tb.compute(r('a', 50)).winner, 'a');
  assert.equal(tb.compute(r('a', 30), { points: 15 }).winner, 'a');

  let s = st.compute(r('a', 21) + r('b', 21) + r('a', 14));
  assert.equal(s.winner, null);
  s = st.compute(r('a', 21) + r('b', 21) + r('a', 15));
  assert.equal(s.winner, 'a');
});

test('event types per sport', () => {
  assert.deepEqual(catalog.presetsFor('volleyball').map((p) => p.key), ['MT', 'WT', 'XT', 'OT']);
  assert.deepEqual(catalog.presetsFor('beach-volleyball').map((p) => p.key), ['MD', 'WD', 'XD', 'OD']);
  assert.ok(!catalog.presetsFor('badminton').some((p) => p.discipline === 'team'));
  assert.equal(catalog.eventName({ discipline: 'team', gender: 'mixed', age: 'U19', level: 'Open' }), 'Mixed Team · U19');
  assert.equal(catalog.normalize({}, {}, 'volleyball').discipline, 'team'); // the default event
  assert.throws(() => catalog.normalize({ discipline: 'singles' }, {}, 'volleyball'), /team events only/);
  assert.throws(() => catalog.normalize({ discipline: 'team' }, {}, 'badminton'), /no team events/);
  assert.throws(() => catalog.normalize({ discipline: 'singles', gender: 'mixed' }, {}, 'volleyball'), /team events only/);
});

test('team entries: a team name, the captain\'s contact and optional players', async () => {
  const db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  try {
    const svc = createApp(db).service;
    const ORG = { user: { id: 1, email: 'org@vb.test', name: 'Org', isAdmin: false } };
    const { id } = await svc.createTournament(ORG, {
      name: 'Spike Cup', sport: 'volleyball', visibility: 'public', format: 'knockout',
      events: [{ discipline: 'team', gender: 'men' }, { discipline: 'team', gender: 'mixed', age: 'U19' }],
    });
    let t = await svc.getTournament(id, ORG);
    assert.deepEqual(t.events.map((e) => e.name), ['Men\'s Team', 'Mixed Team · U19']);
    assert.deepEqual(t.events[0].config.scoring, { bestOf: 5, points: 25, decider: 15 });
    await assert.rejects(svc.addEvents(id, ORG, { events: [{ discipline: 'doubles', gender: 'men' }] }), /team events only/);
    await assert.rejects(svc.createTournament(ORG, { name: 'Bad', sport: 'volleyball', events: [{ discipline: 'singles' }] }), /team events only/);
    // No events given: one open team event.
    const plain = await svc.getTournament((await svc.createTournament(ORG, { name: 'Plain VB', sport: 'volleyball' })).id, ORG);
    assert.equal(plain.events[0].name, 'Open Team');

    const ev = t.events[0].id;
    await svc.register(id, { event: ev, name: 'Chennai Spikers', contact: 'cap@spikers.test', players: 'Arun\nBala, Chitra\n\n' });
    await svc.register(id, { event: ev, name: 'City Smashers', contact: '9876543210' });
    await assert.rejects(svc.register(id, { event: ev, name: 'X', partner: 'Y', contact: 'x@y.test' }), /team event/);
    await assert.rejects(svc.register(id, { event: ev, name: 'Big', contact: 'big@y.test', players: Array.from({ length: 31 }, (_, i) => `P${i}`) }), /up to 30/);
    await assert.rejects(svc.register(id, { event: ev, contact: 'nameless@y.test' }), /Team name/);

    t = await svc.getTournament(id, ORG);
    const spikers = t.events[0].entries.find((e) => e.name === 'Chennai Spikers');
    assert.deepEqual(spikers.players, ['Arun', 'Bala', 'Chitra']);
    assert.equal(t.events[0].entries.find((e) => e.name === 'City Smashers').players, null);
    const pub = await svc.getTournament(id);
    assert.equal(pub.events[0].entries[0].players, undefined); // organisers only

    t = await svc.start(id, ORG, { event: ev });
    const [m] = t.events[0].matches;
    let after;
    for (let i = 0; i < 75; i++) after = await svc.rally(id, ORG, m.id, 'a');
    assert.equal(after.status, 'done');
    assert.equal(after.summary, '25-0, 25-0, 25-0');
  } finally {
    await db.close();
  }
});
