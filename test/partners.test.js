'use strict';

// Doubles without a partner: solo entries, pairing by hand or at random
// (optionally balanced), and drawn-partner events.

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

const ORG = { user: { id: 1, email: 'org@partners.test', name: 'Org', isAdmin: false } };
let n = 0;
const solo = (id, event, name, extra = {}) => svc.register(id, { name, contact: `${name.toLowerCase().replace(/\W/g, '')}${++n}@x.dev`, event, solo: true, ...extra });

async function doublesCup(events, config = {}) {
  const { id } = await svc.createTournament(ORG, { name: 'Doubles Day', visibility: 'public', format: 'knockout', events });
  const t = await svc.getTournament(id, ORG);
  for (const e of t.events) if (Object.keys(config).length) await svc.updateEvent(id, ORG, e.id, config);
  return { id, events: t.events.map((e) => e.id) };
}
const event = async (id, eid) => (await svc.getTournament(id, ORG)).events.find((e) => e.id === eid);

test('solo entries: doubles only; mixed needs a side; drawn events take no partner names', async () => {
  const { id, events: [md, ms] } = await doublesCup([{ discipline: 'doubles', gender: 'men' }, { discipline: 'singles', gender: 'men' }]);
  assert.equal((await solo(id, md, 'Arun')).solo, true);
  await assert.rejects(solo(id, ms, 'Bala'), /isn't a doubles event/);
  await assert.rejects(svc.register(id, { name: 'Chetan', contact: 'c@x.dev', event: md }), /add your partner's name, or ask us/);

  const mixed = await doublesCup([{ discipline: 'doubles', gender: 'mixed' }]);
  await assert.rejects(solo(mixed.id, mixed.events[0], 'Dev'), /man or a woman/);
  assert.equal((await solo(mixed.id, mixed.events[0], 'Dev', { side: 'man' })).solo, true);

  const drawn = await doublesCup([{ discipline: 'doubles', gender: 'open' }], { partners: 'drawn' });
  await assert.rejects(svc.register(drawn.id, { name: 'E', partner: 'F', contact: 'e@x.dev', event: drawn.events[0] }), /drawn/);
  // In a drawn event everyone is solo, even without ticking it.
  const r = await svc.register(drawn.id, { name: 'Gita', contact: 'g@x.dev', event: drawn.events[0] });
  assert.equal(r.solo, true);
});

test('pairing by hand and splitting pairs; mixed needs a man and a woman', async () => {
  const { id, events: [xd] } = await doublesCup([{ discipline: 'doubles', gender: 'mixed' }]);
  await svc.addEntries(id, ORG, ['Fixed / Pair'], { event: xd });
  await solo(id, xd, 'Ravi', { side: 'man' });
  await solo(id, xd, 'Mohan', { side: 'man' });
  await solo(id, xd, 'Asha', { side: 'woman' });
  let ev = await event(id, xd);
  const byName = (name) => ev.entries.find((e) => e.name === name);
  await assert.rejects(svc.pairSolos(id, ORG, byName('Ravi').id, byName('Mohan').id), /a man and a woman/);
  await svc.pairSolos(id, ORG, byName('Ravi').id, byName('Asha').id);
  ev = await event(id, xd);
  assert.deepEqual(ev.entries.map((e) => e.name), ['Fixed / Pair', 'Ravi / Asha', 'Mohan']);
  const pair = ev.entries.find((e) => e.name === 'Ravi / Asha');
  assert.deepEqual(pair.members.map((m) => [m.name, m.side]), [['Ravi', 'man'], ['Asha', 'woman']]);
  await assert.rejects(svc.removeEntry(id, ORG, pair.members[0].id), /split the pair first/);

  await svc.unpair(id, ORG, pair.id);
  ev = await event(id, xd);
  assert.deepEqual(ev.entries.map((e) => e.name).sort(), ['Asha', 'Fixed / Pair', 'Mohan', 'Ravi']);
  await assert.rejects(svc.unpair(id, ORG, ev.entries.find((e) => e.name === 'Fixed / Pair').id), /Only drawn pairs/);
});

test('drawing pairs: random, balanced by seeding, and mixed men with women', async () => {
  const { id, events: [od] } = await doublesCup([{ discipline: 'doubles', gender: 'open' }]);
  for (const name of ['S1', 'S2', 'S3', 'S4', 'S5']) await solo(id, od, name);
  let t = await svc.drawPairs(id, ORG, { event: od, balance: true });
  let ev = t.events[0];
  assert.deepEqual(ev.entries.filter((e) => !e.solo).map((e) => e.name).sort(), ['S1 / S5', 'S2 / S4']);
  assert.deepEqual(ev.entries.filter((e) => e.solo).map((e) => e.name), ['S3']); // the odd one waits

  const random = await doublesCup([{ discipline: 'doubles', gender: 'open' }]);
  for (const name of ['R1', 'R2', 'R3', 'R4']) await solo(random.id, random.events[0], name);
  t = await svc.drawPairs(random.id, ORG, { event: random.events[0] });
  const pairs = t.events[0].entries.filter((e) => e.source === 'drawn');
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.flatMap((p) => p.members.map((m) => m.name)).sort(), ['R1', 'R2', 'R3', 'R4']);

  const mixed = await doublesCup([{ discipline: 'doubles', gender: 'mixed' }]);
  const xd = mixed.events[0];
  await solo(mixed.id, xd, 'M1', { side: 'man' });
  await solo(mixed.id, xd, 'W1', { side: 'woman' });
  await solo(mixed.id, xd, 'M2', { side: 'man' });
  await solo(mixed.id, xd, 'W2', { side: 'woman' });
  await solo(mixed.id, xd, 'M3', { side: 'man' });
  t = await svc.drawPairs(mixed.id, ORG, { event: xd, balance: true });
  ev = t.events[0];
  // Seeds in entry order: M1 1, W1 2, M2 3, W2 4, M3 5 — best man with weakest woman.
  assert.deepEqual(ev.entries.filter((e) => e.source === 'drawn').map((e) => e.name).sort(), ['M1 / W2', 'M2 / W1']);
  assert.deepEqual(ev.entries.filter((e) => e.solo).map((e) => e.name), ['M3']);
});

test('starting: drawn events pair automatically; leftover solos need a decision', async () => {
  const drawn = await doublesCup([{ discipline: 'doubles', gender: 'open' }], { partners: 'drawn', balancePairs: true });
  const [od] = drawn.events;
  for (const name of ['A', 'B', 'C', 'D']) await svc.register(drawn.id, { name, contact: `${name}@drawn.dev`, event: od });
  let t = await svc.start(drawn.id, ORG, { event: od });
  let ev = t.events[0];
  assert.equal(ev.status, 'knockout');
  assert.deepEqual(ev.entries.filter((e) => e.inDraw).map((e) => e.name).sort(), ['A / D', 'B / C']);
  assert.equal(ev.matches.filter((m) => m.round === 1).length, 1);

  const odd = await doublesCup([{ discipline: 'doubles', gender: 'open' }], { partners: 'drawn' });
  for (const name of ['P', 'Q', 'R']) await svc.register(odd.id, { name, contact: `${name}@odd.dev`, event: odd.events[0] });
  await svc.addEntries(odd.id, ORG, ['X / Y'], { event: odd.events[0] });
  await assert.rejects(svc.start(odd.id, ORG, { event: odd.events[0] }), (e) => e.code === 'solo' && /1 player still needs a partner/.test(e.message));
  t = await svc.start(odd.id, ORG, { event: odd.events[0], skipUnconfirmed: true });
  ev = t.events[0];
  assert.equal(ev.entries.filter((e) => e.inDraw).length, 2); // one drawn pair + X / Y
  assert.equal(ev.entries.find((e) => e.solo).inDraw, false);

  // "Own partner" events: unpaired solos block the start too.
  const own = await doublesCup([{ discipline: 'doubles', gender: 'men' }]);
  await svc.addEntries(own.id, ORG, ['A / B', 'C / D'], { event: own.events[0] });
  await solo(own.id, own.events[0], 'Lonely');
  await assert.rejects(svc.start(own.id, ORG, { event: own.events[0] }), (e) => e.code === 'solo');
});

test('solo players still count once each until paired; a pair counts once', async () => {
  const { id, events: [od] } = await doublesCup([{ discipline: 'doubles', gender: 'open' }], { maxEntries: 3 });
  await solo(id, od, 'One');
  await solo(id, od, 'Two');
  assert.equal((await event(id, od)).placesLeft, 1);
  await svc.drawPairs(id, ORG, { event: od });
  assert.equal((await event(id, od)).placesLeft, 2);
});
