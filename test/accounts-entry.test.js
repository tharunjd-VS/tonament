'use strict';

// Players sign in to enter: the entry belongs to their account (one per
// event), they see their entries, and can withdraw before the draw.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

let db;
let app;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  app = createApp(db);
  svc = app.service;
});
test.after(() => db.close());

const ORG = { user: { id: 1, email: 'org@acct.test', name: 'Org', isAdmin: false } };
const ASHA = { user: { id: 501, email: 'asha@acct.test', name: 'Asha Rao', isAdmin: false } };
const BEN = { user: { id: 502, email: 'ben@acct.test', name: 'Ben Lee', isAdmin: false } };

async function cup(extra = {}) {
  const { id } = await svc.createTournament(ORG, {
    name: 'Account Cup', visibility: 'public', format: 'knockout',
    events: [{ discipline: 'singles', gender: 'open' }, { discipline: 'doubles', gender: 'open' }],
    ...extra,
  });
  const t = await svc.getTournament(id, ORG);
  return { id, singles: t.events[0].id, doubles: t.events[1].id };
}

test('entering needs an account; the account name and email are used', async () => {
  const { id, singles, doubles } = await cup();
  await assert.rejects(svc.register(id, {}, { event: singles }), (e) => e.status === 401 && /Sign in to enter/.test(e.message));
  await assert.rejects(svc.register(id, null, { event: singles }), (e) => e.status === 401);

  assert.deepEqual(await svc.register(id, ASHA, { event: singles, phone: '+91 98765 43210' }), { ok: true, name: 'Asha Rao', confirmed: true, event: singles });
  assert.equal((await svc.register(id, ASHA, { event: doubles, name: 'Asha', partner: 'Ravi' })).name, 'Asha / Ravi'); // another event, own nickname
  await assert.rejects(svc.register(id, ASHA, { event: singles, name: 'Asha Again' }), /already entered this event/);
  await assert.rejects(svc.register(id, BEN, { event: singles, phone: '12' }), /valid phone number/);
  await svc.register(id, BEN, { event: singles });

  const t = await svc.getTournament(id, ORG);
  const asha = t.events[0].entries.find((e) => e.name === 'Asha Rao');
  assert.deepEqual([asha.contact, asha.phone], ['asha@acct.test', '+919876543210']); // organisers only
  assert.equal((await svc.getTournament(id)).events[0].entries[0].contact, undefined);
});

test('players see their own entries, here and across tournaments', async () => {
  const { id, singles, doubles } = await cup({ name: 'Mine Cup' });
  await svc.register(id, ASHA, { event: singles });
  await svc.register(id, ASHA, { event: doubles, solo: true });
  await svc.register(id, BEN, { event: singles });

  const mine = (await svc.getTournament(id, ASHA)).myEntries;
  assert.deepEqual(mine.map((e) => [e.eventId, e.name, e.solo, e.paired]), [[singles, 'Asha Rao', false, false], [doubles, 'Asha Rao', true, false]]);
  assert.equal((await svc.getTournament(id)).myEntries, undefined); // never in the public (cached) copy

  const list = (await svc.myEntries(ASHA)).filter((x) => x.id === id);
  assert.deepEqual(list.map((x) => [x.name, x.entry.eventName, x.entry.status]),
    [['Mine Cup', 'Open Doubles', 'looking'], ['Mine Cup', 'Open Singles', 'entered']]);
  await assert.rejects(svc.myEntries({}), (e) => e.status === 401);

  await svc.start(id, ORG, { event: singles });
  assert.equal((await svc.myEntries(ASHA)).find((x) => x.id === id && x.entry.eventId === singles).entry.status, 'playing');
});

test('players withdraw their own entry before the draw', async () => {
  const { id, singles, doubles } = await cup({ name: 'Leave Cup' });
  await svc.register(id, ASHA, { event: singles });
  await svc.register(id, BEN, { event: singles });
  let t = await svc.getTournament(id, ASHA);
  const mine = t.myEntries[0];
  const bens = t.events[0].entries.find((e) => e.name === 'Ben Lee');

  await assert.rejects(svc.leave(id, ASHA, bens.id), (e) => e.status === 404); // not yours
  await assert.rejects(svc.leave(id, {}, mine.id), (e) => e.status === 401);
  t = await svc.leave(id, ASHA, mine.id);
  assert.deepEqual(t.myEntries, []);
  assert.deepEqual(t.events[0].entries.map((e) => e.name), ['Ben Lee']);
  await svc.register(id, ASHA, { event: singles }); // and can enter again

  // Paired solo players ask the organiser.
  await svc.register(id, ASHA, { event: doubles, solo: true });
  await svc.register(id, BEN, { event: doubles, solo: true });
  const solos = (await svc.getTournament(id, ORG)).events[1].entries.filter((e) => e.solo);
  await svc.pairSolos(id, ORG, solos[0].id, solos[1].id);
  const solo = (await svc.getTournament(id, ASHA)).myEntries.find((e) => e.eventId === doubles);
  await assert.rejects(svc.leave(id, ASHA, solo.id), /paired with Ben Lee/);

  // After the draw, only the organiser can withdraw them.
  const entry = (await svc.getTournament(id, BEN)).myEntries.find((e) => e.eventId === singles);
  await svc.start(id, ORG, { event: singles });
  await assert.rejects(svc.leave(id, BEN, entry.id), /draw has been made/);
});

test('HTTP: /register needs a signed-in player; /api/me/entries', async () => {
  const { id, singles } = await cup({ name: 'Http Cup' });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, cookie) => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body),
  });
  try {
    assert.equal((await call('POST', `/api/tournaments/${id}/register?event=${singles}`, { name: 'Anon' })).status, 401);
    const signup = await call('POST', '/api/auth/signup', { name: 'Cy Das', email: 'cy@acct.test', password: 'password123' });
    const cookie = signup.headers.get('set-cookie').split(';')[0];
    const res = await call('POST', `/api/tournaments/${id}/register?event=${singles}`, {}, cookie);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).name, 'Cy Das');
    const mine = await (await call('GET', '/api/me/entries', undefined, cookie)).json();
    assert.deepEqual(mine.map((x) => [x.name, x.entry.name, x.entry.status]), [['Http Cup', 'Cy Das', 'entered']]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
