'use strict';

// Prizes per event, what an entry includes, and other details for players.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

let db;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  svc = createApp(db).service;
});
test.after(() => db.close());

const ORG = { user: { id: 1, email: 'org@prizes.test', name: 'Org', isAdmin: false } };
const TODAY = '2030-06-10';

async function make(name, extra = {}) {
  const { id } = await svc.createTournament(ORG, {
    name, visibility: 'public', format: 'knockout', country: 'Sri Lanka', startsOn: '2030-06-20',
    events: [{ discipline: 'singles', gender: 'men' }, { discipline: 'doubles', gender: 'open', age: 'U15' }],
    ...extra,
  });
  return { id, events: (await svc.getTournament(id, ORG)).events };
}

test('prizes are saved per event and stay editable after the start', async () => {
  const { id, events: [ms, u15] } = await make('Prize Cup');
  let t = await svc.updateEvent(id, ORG, ms.id, {
    prizes: [
      { place: 'winner', cash: 5000, reward: '  Trophy ' },
      { place: 'runner_up', cash: '2500' },
      { place: 'semis', reward: 'Medals' },
      { place: 'Best young player', cash: 0, reward: 'Racket' },
    ],
  });
  assert.deepEqual(t.events[0].prizes, [
    { place: 'winner', cash: 5000, reward: 'Trophy' },
    { place: 'runner_up', cash: 2500, reward: null },
    { place: 'semis', cash: null, reward: 'Medals' },
    { place: 'Best young player', cash: null, reward: 'Racket' },
  ]);
  assert.deepEqual(t.events[1].prizes, []);

  const bad = (prizes, re) => assert.rejects(svc.updateEvent(id, ORG, u15.id, { prizes }), (e) => e.status === 400 && re.test(e.message));
  await bad([{ place: 'winner' }], /prize money or a reward for Winner/);
  await bad([{ place: 'winner', cash: 1.5 }], /whole number/);
  await bad([{ place: 'winner', cash: -1 }], /whole number/);
  await bad([{ place: 'winner', cash: 10000001 }], /whole number/);
  await bad([{ place: 'winner', reward: 'x'.repeat(81) }], /Reward must be at most 80/);
  await bad([{ place: 'x'.repeat(41), cash: 1 }], /at most 40/);
  await bad([{ cash: 100 }], /Prize place/);
  await bad(Array.from({ length: 11 }, () => ({ place: 'winner', cash: 1 })), /Up to 10/);
  await bad('lots', /must be a list/);

  await svc.addEntries(id, ORG, ['A', 'B'], { event: ms.id });
  await svc.start(id, ORG, { event: ms.id });
  t = await svc.updateEvent(id, ORG, ms.id, { prizes: [{ place: 'winner', cash: 6000, reward: 'Trophy' }] });
  assert.equal(t.events[0].prizes[0].cash, 6000);
  t = await svc.updateEvent(id, ORG, ms.id, { prizes: [] }); // can be cleared
  assert.deepEqual(t.events[0].prizes, []);
  await assert.rejects(svc.updateEvent(id, ORG, ms.id, { prizes: [], maxEntries: 8 }), /locked/);
});

test('what\'s included and other details', async () => {
  const { id } = await make('Perk Cup');
  assert.deepEqual((await svc.getTournament(id)).perks, { items: [], other: [] });
  let t = await svc.updateSettings(id, ORG, {
    perks: { items: ['water', 'lunch', 'water'], other: [' Free  physio ', '', 'Photo booth'] },
    notes: 'Report by 8 am.\r\nNon-marking shoes only.',
  });
  assert.deepEqual(t.perks, { items: ['water', 'lunch'], other: ['Free physio', 'Photo booth'] });
  assert.equal(t.notes, 'Report by 8 am.\nNon-marking shoes only.');

  const bad = (input, re) => assert.rejects(svc.updateSettings(id, ORG, input), (e) => e.status === 400 && re.test(e.message));
  await bad({ perks: { items: ['caviar'] } }, /Unknown item: caviar/);
  await bad({ perks: { items: [], other: ['a', 'b', 'c', 'd', 'e', 'f'] } }, /up to 5/);
  await bad({ perks: { items: [], other: ['x'.repeat(41)] } }, /at most 40/);
  await bad({ notes: 'x'.repeat(2001) }, /at most 2,000/);

  // Also editable once play has started; an empty box clears it.
  const [ms] = t.events;
  await svc.addEntries(id, ORG, ['A', 'B'], { event: ms.id });
  await svc.start(id, ORG, { event: ms.id });
  t = await svc.updateSettings(id, ORG, { notes: '   ', perks: { items: ['dinner'] } });
  assert.equal(t.notes, null);
  assert.deepEqual(t.perks, { items: ['dinner'], other: [] });
});

test('search cards show prize totals and meals; the prize filter', async () => {
  const a = await make('Rich Open');
  await svc.updateEvent(a.id, ORG, a.events[0].id, { prizes: [{ place: 'winner', cash: 5000 }, { place: 'runner_up', cash: 1000, reward: 'Trophy' }] });
  await svc.updateEvent(a.id, ORG, a.events[1].id, { prizes: [{ place: 'winner', cash: 1000 }] });
  await svc.updateSettings(a.id, ORG, { perks: { items: ['lunch'] } });
  const b = await make('Trophy Only');
  await svc.updateEvent(b.id, ORG, b.events[0].id, { prizes: [{ place: 'winner', reward: 'Trophy' }] });
  await svc.updateSettings(b.id, ORG, { perks: { items: ['water', 'snacks'] } });
  await make('Plain Cup');

  const find = (f = {}) => svc.listTournaments({ today: TODAY, country: 'Sri Lanka', ...f });
  const cards = Object.fromEntries((await find()).map((c) => [c.name, c]));
  assert.deepEqual([cards['Rich Open'].prizeTotal, cards['Rich Open'].meals], [7000, true]);
  assert.deepEqual([cards['Trophy Only'].prizeTotal, cards['Trophy Only'].meals], [0, false]);
  assert.deepEqual([cards['Plain Cup'].prizeTotal, cards['Plain Cup'].meals], [0, false]);
  assert.deepEqual((await find({ prizes: '1' })).map((c) => c.name), ['Rich Open']);
});
