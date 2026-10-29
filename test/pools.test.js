'use strict';

// Level pools: an Open event split by level (Beginner, Beginner+,
// Intermediate, Advanced). Each pool plays its own league groups and its own
// part of the knockout, so the pools meet in the semis (one per level) or the
// final (two pools). Organisers can move players between groups until a group
// starts, and put spot entries into the group they belong in.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const formats = require('../server/formats');

let db;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  svc = createApp(db).service;
});
test.after(() => db.close());

const OWNER = { user: { id: 1, email: 'pools@example.com', name: 'Owner', isAdmin: false } };
const LEVELS = ['Beginner', 'Beginner+', 'Intermediate', 'Advanced'];

test('pooledSlots: pools meet only once each has a winner', () => {
  const sec = (p, n) => Array.from({ length: n }, (_, i) => ({ id: p * 10 + i, group: p, tier: 0 }));
  // 4 pools, one winner each: the semis are 1 v 2 and 3 v 4.
  assert.deepEqual(formats.pooledSlots([sec(1, 1), sec(2, 1), sec(3, 1), sec(4, 1)]), [10, 20, 30, 40]);
  // 2 pools: the final.
  assert.deepEqual(formats.pooledSlots([sec(1, 1), sec(2, 1)]), [10, 20]);
  // Uneven pools: a pool sending 2 plays off in its own quarter; the rest get byes.
  const slots = formats.pooledSlots([sec(1, 2), sec(2, 1), sec(3, 1)]);
  assert.equal(slots.length, 8);
  assert.deepEqual(slots.slice(0, 2).sort(), [10, 11]);
  assert.deepEqual(slots.slice(6), [null, null]); // an empty quarter (3 pools)
  // Pools from levels.
  const entries = [{ id: 1, level: 'Beginner' }, { id: 2, level: 'Beginner+' }, { id: 3, level: 'Advanced' }, { id: 4, level: null }];
  const two = formats.poolsFor(entries, 'two', LEVELS);
  assert.deepEqual(two.pools.map((p) => [p.key, p.ids]), [['lower', [1, 2]], ['upper', [3]]]);
  assert.deepEqual(two.missing, [4]);
  assert.deepEqual(formats.poolsFor(entries, 'levels', LEVELS).pools.map((p) => p.key), ['Beginner', 'Beginner+', 'Advanced']);
});

async function openEvent(name, extra = {}) {
  const { id } = await svc.createTournament(OWNER, { name, sport: 'badminton', format: 'league_knockout', qualifiers: 1, groupSize: 6, scoring: { points: 21, bestOf: 1 }, ...extra });
  return id;
}
async function addLevel(id, level, list, walkIn = false) {
  await svc.addEntries(id, OWNER, list, { level, walkIn });
}
// Every league match: the entry whose name sorts first wins 21-10.
async function playLeague(id) {
  const t = await svc.getTournament(id, OWNER);
  for (const m of t.matches.filter((x) => x.stage === 'league' && x.status !== 'done')) {
    const aFirst = m.a.name < m.b.name;
    await svc.setResult(id, OWNER, m.id, [aFirst ? { a: 21, b: 10 } : { a: 10, b: 21 }]);
  }
}
const levelOf = (t, name) => t.entries.find((e) => e.name === name).level;

test('split by level: pure-level groups, and the four pool winners meet in the semis', async () => {
  const id = await openEvent('Chennai Open (4 pools)');
  await addLevel(id, 'Beginner', ['B1', 'B2', 'B3', 'B4']);
  await addLevel(id, 'Beginner+', ['P1', 'P2', 'P3']);
  await addLevel(id, 'Intermediate', ['I1', 'I2', 'I3', 'I4']);
  await addLevel(id, 'Advanced', ['A1', 'A2', 'A3']);
  await svc.addEntries(id, OWNER, ['No Level']);
  await assert.rejects(svc.updateSettings(id, OWNER, { pools: 'levels', format: 'knockout' }), /League \+ Knockout/);
  await svc.updateSettings(id, OWNER, { pools: 'levels' });
  await assert.rejects(svc.start(id, OWNER), /Set a level for No Level/);
  const t0 = await svc.getTournament(id, OWNER);
  await svc.setEntryLevel(id, OWNER, t0.entries.find((e) => e.name === 'No Level').id, { level: 'beginner+' });
  let t = await svc.start(id, OWNER);
  assert.deepEqual(t.groups.map((g) => g.pool), LEVELS);
  for (const g of t.groups) {
    const levels = new Set(g.standings.map((r) => levelOf(t, r.name)));
    assert.equal(levels.size, 1, `${g.name} mixes levels`);
  }
  await playLeague(id);
  t = await svc.startKnockout(id, OWNER);
  const semis = t.matches.filter((m) => m.stage === 'knockout' && m.round === 1).sort((x, y) => x.slot - y.slot);
  assert.deepEqual(semis.map((m) => [m.a.name, m.b.name]), [['B1', 'No Level'], ['I1', 'A1']]);
});

test('two pools meet in the final; the organiser can swap the semi pairings', async () => {
  const id = await openEvent('Two Pool Open');
  await addLevel(id, 'Beginner', ['B1', 'B2', 'B3']);
  await addLevel(id, 'Beginner+', ['P1', 'P2']);
  await addLevel(id, 'Advanced', ['A1', 'A2', 'A3', 'A4']);
  await svc.updateSettings(id, OWNER, { pools: 'two', qualifiers: 2 });
  let t = await svc.start(id, OWNER);
  assert.deepEqual(t.groups.map((g) => g.pool), ['Beginner & Beginner+', 'Intermediate & Advanced']);
  await playLeague(id);
  t = await svc.startKnockout(id, OWNER);
  // Top 2 from each pool: each pool's semi is inside the pool; the final is lower v upper.
  const semis = t.matches.filter((m) => m.stage === 'knockout' && m.round === 1).sort((x, y) => x.slot - y.slot);
  assert.deepEqual(semis.map((m) => [m.a.name, m.b.name].sort()), [['B1', 'B2'], ['A1', 'A2']]);

  // Swap: a 4-pool event where Beginner meets Advanced in the semis.
  const id2 = await openEvent('Swapped Open');
  for (const l of LEVELS) await addLevel(id2, l, [`${l[0]}${l.endsWith('+') ? 'p' : ''}1`, `${l[0]}${l.endsWith('+') ? 'p' : ''}2`]);
  await svc.updateSettings(id2, OWNER, { pools: 'levels' });
  await svc.start(id2, OWNER);
  await svc.updateSettings(id2, OWNER, { poolOrder: ['Beginner', 'Advanced', 'Beginner+', 'Intermediate'] });
  await playLeague(id2);
  t = await svc.startKnockout(id2, OWNER);
  const s2 = t.matches.filter((m) => m.stage === 'knockout' && m.round === 1).sort((x, y) => x.slot - y.slot);
  assert.deepEqual(s2.map((m) => [m.a.name, m.b.name]), [['B1', 'A1'], ['Bp1', 'I1']]);
  await assert.rejects(svc.updateSettings(id2, OWNER, { poolOrder: null }), /pairings are set/);
});

test('three pools: the lone pool goes straight to the final; undo walks back through the bye', async () => {
  const id = await openEvent('Three Pool Open');
  await addLevel(id, 'Beginner', ['B1', 'B2']);
  await addLevel(id, 'Intermediate', ['I1', 'I2']);
  await addLevel(id, 'Advanced', ['A1', 'A2']);
  await svc.updateSettings(id, OWNER, { pools: 'levels' });
  await svc.start(id, OWNER);
  await playLeague(id);
  let t = await svc.startKnockout(id, OWNER);
  const ko = () => t.matches.filter((m) => m.stage === 'knockout');
  const final = ko().find((m) => m.round === 2);
  assert.equal(final.b.name, 'A1'); // Advanced faced an empty section: straight through
  const semi = ko().find((m) => m.round === 1 && m.slot === 0);
  assert.deepEqual([semi.a.name, semi.b.name], ['B1', 'I1']);
  t = await svc.setResult(id, OWNER, semi.id, [{ a: 21, b: 15 }]).then(() => svc.getTournament(id, OWNER));
  assert.equal(ko().find((m) => m.round === 2).a.name, 'B1');
  // Undo the semi's winning point: B1 comes back out of the final.
  const done = ko().find((m) => m.id === semi.id);
  await svc.undo(id, OWNER, done.id, done.rallies);
  t = await svc.getTournament(id, OWNER);
  assert.equal(ko().find((m) => m.round === 2).a, null);
  // Finish it: the champion.
  await svc.setResult(id, OWNER, semi.id, [{ a: 15, b: 21 }]);
  t = await svc.getTournament(id, OWNER);
  await svc.setResult(id, OWNER, ko().find((m) => m.round === 2).id, [{ a: 21, b: 19 }]);
  t = await svc.getTournament(id, OWNER);
  assert.equal(t.status, 'completed');
  assert.equal(t.champion.name, 'I1');
});

test('hand adjustments: move between groups until they start, level changes, spot entries into a group', async () => {
  const id = await openEvent('Adjust Open', { lateEntry: true });
  await addLevel(id, 'Beginner', ['B1', 'B2', 'B3']);
  await addLevel(id, 'Intermediate', ['I1', 'I2', 'I3']);
  await addLevel(id, 'Advanced', ['A1', 'A2', 'A3']);
  await svc.updateSettings(id, OWNER, { pools: 'levels' });
  let t = await svc.start(id, OWNER);
  const entry = (name) => t.entries.find((e) => e.name === name);
  const group = (name) => entry(name).group;
  // "B3 is really Intermediate": moving them redoes both groups' fixtures and sets their level.
  await svc.moveEntry(id, OWNER, entry('B3').id, { group: group('I1') });
  t = await svc.getTournament(id, OWNER);
  assert.equal(group('B3'), group('I1'));
  assert.equal(entry('B3').level, 'Intermediate');
  const leagueIn = (g) => t.matches.filter((m) => m.stage === 'league' && m.group === g);
  assert.equal(leagueIn(group('I1')).length, 6); // 4 players
  assert.equal(leagueIn(group('B1')).length, 1); // 2 players
  // Changing a level moves them to that pool.
  await svc.setEntryLevel(id, OWNER, entry('A3').id, { level: 'Beginner' });
  t = await svc.getTournament(id, OWNER);
  assert.equal(group('A3'), group('B1'));
  // Once a group has started, nobody moves in or out of it.
  await svc.setResult(id, OWNER, leagueIn(group('A1'))[0].id, [{ a: 21, b: 12 }]);
  await assert.rejects(svc.moveEntry(id, OWNER, entry('A1').id, { group: group('B1') }), /has started/);
  await assert.rejects(svc.moveEntry(id, OWNER, entry('A2').id, { group: group('B1') }), /left with 1|has started/);
  // A spot entry goes into the group picked, with catch-up matches; or by level.
  await svc.lateEntry(id, OWNER, { name: 'Spot Adv', group: group('A1') });
  await svc.lateEntry(id, OWNER, { name: 'Spot Beg', level: 'Beginner' });
  t = await svc.getTournament(id, OWNER);
  assert.equal(group('Spot Adv'), group('A1'));
  assert.equal(entry('Spot Adv').level, 'Advanced');
  assert.equal(group('Spot Beg'), group('B1'));
  assert.equal(t.matches.filter((m) => m.stage === 'league' && (m.a?.name === 'Spot Adv' || m.b?.name === 'Spot Adv')).length, 2);
  await assert.rejects(svc.setEntryLevel(id, OWNER, entry('B1').id, { level: 'Expert' }), /Level: one of/);
});
