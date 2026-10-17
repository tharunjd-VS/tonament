'use strict';

// Events (categories) inside a tournament: Men's Singles, Mixed Doubles · U19, …

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const catalog = require('../public/sports/events');

let db;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  svc = createApp(db).service;
});
test.after(() => db.close());

const ORG = { user: { id: 1, email: 'org@events.test', name: 'Org', isAdmin: false } };
const OTHER = { user: { id: 2, email: 'someone@events.test', name: 'Someone', isAdmin: false } };
const names = (n, p = 'P') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
const byName = (t, name) => t.events.find((e) => e.name === name);

async function diwali() {
  const { id } = await svc.createTournament(ORG, {
    name: 'Diwali Open',
    visibility: 'public',
    format: 'knockout',
    events: [
      { discipline: 'singles', gender: 'men', age: 'U19', level: 'Intermediate' },
      { discipline: 'singles', gender: 'women' },
      { discipline: 'doubles', gender: 'mixed', age: 'u19' },
    ],
  });
  return id;
}

test('catalogue: names, short names and validation', () => {
  assert.equal(catalog.eventName({ discipline: 'doubles', gender: 'men', age: 'U19', level: 'Intermediate' }), 'Men\'s Doubles · U19 · Intermediate');
  assert.equal(catalog.eventName({ discipline: 'singles', gender: 'open', age: 'Open', level: 'Open' }), 'Open Singles');
  assert.equal(catalog.eventName({ discipline: 'any', gender: 'open', age: 'Open', level: 'Open' }), 'Open');
  assert.equal(catalog.eventName({ discipline: 'singles', gender: 'men', age: 'Open', level: 'Open', name: 'Club Ladder' }), 'Club Ladder');
  assert.equal(catalog.shortName({ discipline: 'doubles', gender: 'mixed', age: 'U19', level: 'Advanced' }), 'XD U19 Adv');
  assert.throws(() => catalog.normalize({ discipline: 'singles', gender: 'mixed' }), /doubles only/);
  assert.throws(() => catalog.normalize({ discipline: 'triples' }), /singles or doubles/);
  assert.deepEqual(catalog.normalize({ discipline: 'doubles', gender: 'men', age: 'u15', level: 'over 40 social' }), {
    discipline: 'doubles', gender: 'men', age: 'U15', level: 'over 40 social', name: null,
  });
});

test('a tournament with several events: names, defaults and independent entries', async () => {
  const id = await diwali();
  const t = await svc.getTournament(id, ORG);
  assert.deepEqual(t.events.map((e) => e.name), ['Men\'s Singles · U19 · Intermediate', 'Women\'s Singles', 'Mixed Doubles · U19']);
  assert.deepEqual(t.events.map((e) => e.shortName), ['MS U19 Int', 'WS', 'XD U19']);
  assert.ok(t.events.every((e) => e.format === 'knockout' && e.status === 'setup'));
  await assert.rejects(svc.createTournament(ORG, { name: 'Bad', events: [{ discipline: 'singles', gender: 'mixed' }] }), /doubles only/);

  // With several events the event must be named.
  await assert.rejects(svc.addEntries(id, ORG, ['A']), (e) => e.status === 400 && e.code === 'event');
  const [ms, ws, xd] = t.events;
  await svc.addEntries(id, ORG, ['Arun', 'Bala', 'Chetan'], { event: ms.id });
  await svc.addEntries(id, ORG, ['Arun / Divya'], { event: xd.id });
  await svc.addEntries(id, ORG, ['Arun'], { event: ws.id }); // same name in another event is fine
  await assert.rejects(svc.addEntries(id, ORG, ['Bala'], { event: ms.id }), /already entered/);
  const after = await svc.getTournament(id, ORG);
  assert.deepEqual(after.events.map((e) => e.entries.length), [3, 1, 1]);
});

test('each event starts on its own; the tournament status follows', async () => {
  const id = await diwali();
  const { events: [ms, ws, xd] } = await svc.getTournament(id, ORG);
  await svc.addEntries(id, ORG, names(4), { event: ms.id });
  await svc.addEntries(id, ORG, names(2, 'W'), { event: ws.id });
  let t = await svc.start(id, ORG, { event: ms.id });
  assert.equal(t.status, 'live');
  assert.deepEqual(t.events.map((e) => e.status), ['knockout', 'setup', 'setup']);
  assert.equal(byName(t, 'Men\'s Singles · U19 · Intermediate').matches.length, 3);
  assert.equal(byName(t, 'Women\'s Singles').matches.length, 0);
  assert.equal(t.entriesOpen, true); // other events still take entries

  // Scoring a match in one event finishes only that event.
  const wsT = await svc.start(id, ORG, { event: ws.id });
  const final = byName(wsT, 'Women\'s Singles').matches[0];
  let m;
  do m = await svc.rally(id, ORG, final.id, 'a');
  while (m.status !== 'done');
  t = await svc.getTournament(id, ORG);
  assert.equal(byName(t, 'Women\'s Singles').status, 'completed');
  assert.equal(byName(t, 'Women\'s Singles').champion.name, 'W1');
  assert.equal(t.status, 'live');

  // Started events are locked; setup ones are still editable and deletable.
  await assert.rejects(svc.updateEvent(id, ORG, ms.id, { format: 'league' }), /locked/);
  await assert.rejects(svc.deleteEvent(id, ORG, ms.id), /has started/);
  t = await svc.updateEvent(id, ORG, xd.id, { level: 'Advanced', format: 'league', lateEntry: true });
  const changed = t.events.find((e) => e.id === xd.id);
  assert.deepEqual([changed.name, changed.format, changed.config.lateEntry], ['Mixed Doubles · U19 · Advanced', 'league', true]);
  t = await svc.deleteEvent(id, ORG, xd.id);
  assert.equal(t.events.length, 2);
});

test('managing events: add, rename, reorder, delete and permissions', async () => {
  const { id } = await svc.createTournament(ORG, { name: 'Club Night', format: 'knockout' });
  let t = await svc.getTournament(id, ORG);
  assert.equal(t.events.length, 1);
  assert.equal(t.events[0].name, 'Open'); // the catch-all event
  await assert.rejects(svc.deleteEvent(id, ORG, t.events[0].id), /at least one event/);

  t = await svc.addEvents(id, ORG, { events: [{ discipline: 'doubles', gender: 'men' }, { discipline: 'doubles', gender: 'women' }] });
  assert.deepEqual(t.events.map((e) => e.name), ['Open', 'Men\'s Doubles', 'Women\'s Doubles']);
  assert.ok(t.events.every((e) => e.format === 'knockout')); // copied from the first event
  await assert.rejects(svc.addEvents(id, ORG, { discipline: 'doubles', gender: 'men' }), /already exists/);
  await assert.rejects(svc.addEvents(id, OTHER, { discipline: 'singles', gender: 'men' }), (e) => e.status === 403);
  await assert.rejects(svc.updateEvent(id, ORG, t.events[1].id, { gender: 'women' }), /already exists/);

  t = await svc.updateEvent(id, ORG, t.events[0].id, { name: 'Club Ladder' });
  assert.equal(t.events[0].name, 'Club Ladder');
  t = await svc.reorderEvents(id, ORG, [t.events[2].id, t.events[0].id, t.events[1].id]);
  assert.deepEqual(t.events.map((e) => e.name), ['Women\'s Doubles', 'Club Ladder', 'Men\'s Doubles']);
  await assert.rejects(svc.reorderEvents(id, ORG, [t.events[0].id]), /every event/);
});

test('self-entry picks an event; doubles need a partner; one entry per contact per event', async () => {
  const id = await diwali();
  const { events: [ms, ws, xd] } = await svc.getTournament(id);
  await assert.rejects(svc.register(id, { name: 'Asha', contact: 'asha@x.dev' }), (e) => e.code === 'event');
  await assert.rejects(svc.register(id, { name: 'Asha', contact: 'asha@x.dev', event: xd.id }), /doubles event — add your partner/);
  assert.equal((await svc.register(id, { name: 'Asha', partner: 'Ravi', contact: 'asha@x.dev', event: xd.id })).name, 'Asha / Ravi');
  // Singles ignore a partner; the same contact can enter another event.
  assert.equal((await svc.register(id, { name: 'Asha', partner: 'Ravi', contact: 'asha@x.dev', event: ws.id })).name, 'Asha');
  await assert.rejects(svc.register(id, { name: 'Asha R', contact: 'asha@x.dev', event: ws.id }), /already been used to enter this event/);
  await svc.addEntries(id, ORG, ['Bea'], { event: ws.id });
  await svc.start(id, ORG, { event: ws.id });
  await assert.rejects(svc.register(id, { name: 'Late', contact: 'late@x.dev', event: ws.id }), /draw has been made/);
  assert.equal((await svc.register(id, { name: 'Late', contact: 'late@x.dev', event: ms.id })).confirmed, true);
});

test('tournaments made before events get one event holding their draw', async () => {
  await db.query(
    `INSERT INTO tournaments (id, name, sport, format, config, admin_key, scorer_key, status)
     VALUES ('legacy-ev', 'Legacy', 'badminton', 'knockout', '{"scoring":{"bestOf":3,"points":21,"cap":30},"selfEntry":true}'::jsonb, 'k1', 'k2', 'setup')`,
  );
  await db.query(`INSERT INTO entries (tournament_id, name, seed) VALUES ('legacy-ev', 'Old A', 1), ('legacy-ev', 'Old B', 2)`);
  await db.query('UPDATE schema_meta SET version = 11');
  await migrate(db);
  const t = await svc.getTournament('legacy-ev', ORG);
  assert.equal(t.events.length, 1);
  assert.deepEqual(t.events[0].entries.map((e) => e.name), ['Old A', 'Old B']);
  assert.deepEqual(t.entries.map((e) => e.name), ['Old A', 'Old B']); // top-level copy for single-event pages
  const started = await svc.start('legacy-ev', { user: { email: 'x@x', isAdmin: true } });
  assert.equal(started.status, 'knockout');
});

test('search filters by event type, age group and level; cards list events', async () => {
  const mk = (name, events) => svc.createTournament(ORG, { name, visibility: 'public', events }).then((r) => r.id);
  await mk('Junior Mixed', [{ discipline: 'doubles', gender: 'mixed', age: 'U19' }, { discipline: 'singles', gender: 'women', age: 'U15' }]);
  await mk('Vets Doubles', [{ discipline: 'doubles', gender: 'men', age: '45+', level: 'Advanced' }]);
  const find = (f) => svc.listTournaments({ when: 'any', ...f }).then((list) => list.map((t) => t.name).filter((n) => ['Junior Mixed', 'Vets Doubles'].includes(n)).sort());
  assert.deepEqual(await find({ event: 'XD' }), ['Junior Mixed']);
  assert.deepEqual(await find({ event: 'XD', age: 'u19' }), ['Junior Mixed']);
  assert.deepEqual(await find({ event: 'XD', age: 'U15' }), []); // U15 is a different event
  assert.deepEqual(await find({ age: 'U15' }), ['Junior Mixed']);
  assert.deepEqual(await find({ level: 'advanced' }), ['Vets Doubles']);
  assert.deepEqual(await find({ event: 'MD', age: '45+' }), ['Vets Doubles']);
  const card = (await svc.listTournaments({ when: 'any', q: 'Junior Mixed' }))[0];
  assert.deepEqual(card.events, ['XD U19', 'WS U15']);
});
