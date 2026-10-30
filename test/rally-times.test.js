'use strict';

// Rally times: when each rally was scored, kept beside the rallies string —
// added with each tap (the phone's time, clamped), dropped on undo, gone when
// a score is entered at the end, and absent (null) on old matches.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const { nextTimes } = require('../server/rally-times');

let db;
let svc;
let server;
let base;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  const app = createApp(db);
  svc = app.service;
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
});

let n = 0;
async function person(name) {
  n += 1;
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@times.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
test('the rules: tap times, clamped; undo; replaced scores; old matches', () => {
  const now = 1_000_000_000;
  assert.deepEqual(nextTimes('', [], 'a', now - 1000, now), [now - 1000]);
  assert.deepEqual(nextTimes('a', [now - 1000], 'ab', now + 60_000, now), [now - 1000, now], 'a phone clock far ahead: the server\'s time');
  assert.deepEqual(nextTimes('ab', [5, 9], 'abb', 7, now), [5, 9, now], 'before the last rally: too far back to believe, so now');
  assert.deepEqual(nextTimes('ab', [now - 20, now - 10], 'abb', now - 15, now), [now - 20, now - 10, now - 10], 'never before the last rally');
  assert.deepEqual(nextTimes('ab', [1, 2], 'a', undefined, now), [1]);
  assert.deepEqual(nextTimes('ab', [1, 2], 'ba', undefined, now), null, 'replaced: no times');
  assert.deepEqual(nextTimes('ab', [1, 2], '', undefined, now), []);
  assert.deepEqual(nextTimes('ab', null, 'abb', now, now), [null, null, now], 'an old match: unknown, then known');
  assert.deepEqual(nextTimes('a', [1], 'a3', now, now), [1, now], 'a tap that adds several marks shares its time');
  assert.equal(nextTimes('', [], 'aab', false, now), null, 'a score entered at the end');
});

test('a tournament match keeps a time per rally; undo, retries and final scores', async () => {
  const org = await person('Times Organiser');
  const { id } = await svc.createTournament(org.actor, { name: 'Times Cup', format: 'knockout', events: [{ discipline: 'singles', gender: 'open' }] });
  await svc.addEntries(id, org.actor, ['Ann', 'Ben']);
  await svc.start(id, org.actor);
  let t = await svc.getTournament(id, org.actor);
  const m = t.matches.find((x) => x.a && x.b);
  const path = `/api/tournaments/${id}/matches/${m.id}`;
  const times = async () => (await db.query('SELECT rally_times FROM matches WHERE id = $1', [m.id]))[0].rally_times;
  const t0 = Date.now() - 30_000;
  for (let i = 0; i < 3; i++) assert.equal((await org.call('POST', `${path}/rally`, { side: 'a', at: i, t: t0 + i * 5000 })).status, 200);
  assert.deepEqual(await times(), [t0, t0 + 5000, t0 + 10_000]);
  // A retry of the same tap (same at) is refused, not doubled.
  assert.equal((await org.call('POST', `${path}/rally`, { side: 'a', at: 2, t: t0 + 10_000 })).status, 409);
  assert.equal((await times()).length, 3);
  // A tap with no time gets the server's; a time in the future is clamped.
  await org.call('POST', `${path}/rally`, { side: 'b', at: 3 });
  await org.call('POST', `${path}/rally`, { side: 'b', at: 4, t: Date.now() + 3_600_000 });
  let list = await times();
  assert.equal(list.length, 5);
  assert.ok(list[4] <= Date.now() && list[3] >= t0 + 10_000);
  // Undo drops the last.
  await org.call('POST', `${path}/undo`, { at: 5 });
  assert.equal((await times()).length, 4);
  // A score entered at the end replaces the points: no times.
  await org.call('POST', `${path}/undo`, { at: 4 });
  await org.call('POST', `${path}/undo`, { at: 3 });
  await org.call('POST', `${path}/undo`, { at: 2 });
  await org.call('POST', `${path}/undo`, { at: 1 });
  r = await org.call('POST', `${path}/result`, { games: [{ a: 21, b: 10 }, { a: 21, b: 12 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(await times(), null);
  // An old match (no times) still scores.
  await db.query('UPDATE matches SET rally_times = NULL WHERE id = $1', [m.id]);
  t = await svc.getTournament(id, org.actor);
  assert.equal(t.matches.find((x) => x.id === m.id).status, 'done');
});
let r;

test('challenges and tie rubbers keep times too', async () => {
  const a = await person('Chal A');
  const b = await person('Chal B');
  const c = (await a.call('POST', '/api/challenges', { to: b.id, sport: 'badminton' })).data;
  await b.call('POST', `/api/challenges/${c.id}/respond`, { accept: true });
  const t0 = Date.now() - 10_000;
  await a.call('POST', `/api/challenges/${c.id}/rally`, { side: 'a', at: 0, t: t0 });
  await a.call('POST', `/api/challenges/${c.id}/rally`, { side: 'b', at: 1, t: t0 + 4000 });
  assert.deepEqual((await db.query('SELECT rally_times FROM challenges WHERE id = $1', [c.id]))[0].rally_times, [t0, t0 + 4000]);
  await a.call('POST', `/api/challenges/${c.id}/undo`, { at: 2 });
  assert.deepEqual((await db.query('SELECT rally_times FROM challenges WHERE id = $1', [c.id]))[0].rally_times, [t0]);
  // A tie: a rubber's rallies, and the tie's own "rallies" (rubber winners) get times as rubbers finish.
  const org = await person('Tie Times');
  const { id } = await svc.createTournament(org.actor, { name: 'Tie Times Cup', format: 'knockout', events: [{ discipline: 'team', gender: 'open' }] });
  let t = await svc.getTournament(id, org.actor);
  await svc.updateEvent(id, org.actor, t.events[0].id, { tie: { format: '2s1d' } });
  await svc.addEntries(id, org.actor, ['Reds', 'Blues'], { event: t.events[0].id });
  t = await svc.getTournament(id, org.actor);
  for (const e of t.entries) await svc.setEntryPlayers(id, org.actor, e.id, { players: [{ name: `${e.name} 1` }, { name: `${e.name} 2` }, { name: `${e.name} 3` }] });
  await svc.start(id, org.actor);
  t = await svc.getTournament(id, org.actor);
  const m = t.matches.find((x) => x.a && x.b);
  const tp = `/api/tournaments/${id}/matches/${m.id}/tie`;
  await org.call('PUT', `${tp}/lineup`, { side: 'a', slots: [[0], [1], [0, 2]] });
  await org.call('PUT', `${tp}/lineup`, { side: 'b', slots: [[0], [1], [0, 2]] });
  await org.call('POST', `${tp}/rubbers/0/rally`, { side: 'a', at: 0, t: t0 });
  assert.deepEqual((await db.query('SELECT rally_times FROM rubbers WHERE match_id = $1 AND position = 0', [m.id]))[0].rally_times, [t0]);
  await org.call('POST', `${tp}/rubbers/1/result`, { games: [{ a: 21, b: 5 }, { a: 21, b: 5 }] });
  const [tie] = await db.query('SELECT rallies, rally_times FROM matches WHERE id = $1', [m.id]);
  assert.equal(tie.rallies, 'a');
  assert.equal(tie.rally_times.length, 1, 'the tie: when each rubber was won');
});
