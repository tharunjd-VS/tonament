'use strict';

// Runs: logging (checks), the feed post (public, followers, private), best
// efforts, totals and the weekly board with people you follow, editing and
// deleting, km and runs goals, and the share card.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

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
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@runs.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

test('logging runs: checks, feed posts, best efforts, totals and the weekly board', async () => {
  const asha = await person('Asha Runner');
  const friend = await person('Friend Runner');
  const stranger = await person('Stranger Runner');
  await friend.call('POST', '/api/follow', { kind: 'user', id: asha.id, on: true });
  await asha.call('POST', '/api/follow', { kind: 'user', id: friend.id, on: true });
  // Checks.
  assert.equal((await asha.call('POST', '/api/runs', { km: 0, time: '30:00' })).status, 400);
  assert.equal((await asha.call('POST', '/api/runs', { km: 10, time: 'soon' })).status, 400);
  assert.equal((await asha.call('POST', '/api/runs', { km: 10, time: '20:00' })).status, 400, 'faster than a world record');
  assert.equal((await asha.call('POST', '/api/runs', { km: 5, time: '30:00', ranAt: new Date(Date.now() + 86400000).toISOString() })).status, 400);
  // A first 10K: a start, not a best.
  let r = await asha.call('POST', '/api/runs', { km: 10.2, time: '55:30', title: 'Marina sunrise', place: 'Marina Beach', ranAt: daysAgo(0) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.km, r.data.time, r.data.pace, r.data.pbs], [10.2, '55:30', '5:26', []]);
  // Faster over 5K and 10K: new bests.
  r = await asha.call('POST', '/api/runs', { km: 10, time: '52:00', ranAt: daysAgo(0) });
  assert.deepEqual(r.data.pbs, ['5K', '10K']);
  // A private one: counts for me, not on the feed or the board.
  await asha.call('POST', '/api/runs', { km: 3, time: '18:00', visibility: 'private' });
  await friend.call('POST', '/api/runs', { km: 25, time: '2:20:00' });
  const mine = (await asha.call('GET', '/api/runs')).data;
  assert.equal(mine.week.km, 23.2);
  assert.equal(mine.week.runs, 3);
  assert.deepEqual(mine.bests.map((b) => [b.name, b.time]), [['5K', '26:00'], ['10K', '52:00']]);
  assert.deepEqual(mine.board.map((b) => [b.name, b.km]), [['Friend Runner', 25], ['Asha Runner', 23.2]]);
  // Feeds: the friend sees both of Asha's runs (not the private one); a stranger sees public ones.
  const runsIn = (feed) => feed.items.filter((x) => x.verb === 'run' && x.people[0].id === asha.id);
  assert.equal(runsIn((await friend.call('GET', '/api/feed')).data).length, 2);
  const seen = runsIn((await svc.social.userFeed(asha.id, stranger.actor)));
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map((x) => x.data.pbs), [['5K', '10K'], []]);
  // The card.
  const card = await svc.cards.activity(seen[0].id);
  assert.deepEqual([card.title, card.big, card.bigLabel], ['Asha Runner', '10 km', '52:00 · 5:12 /km']);
  assert.match(card.eyebrow, /New best 5K, 10K/);
  // Edit (to private: off the feed), delete.
  const id = mine.recent.find((x) => x.title === 'Marina sunrise').id;
  assert.equal((await stranger.call('PATCH', `/api/runs/${id}`, { title: 'Mine now' })).status, 404);
  r = await asha.call('PATCH', `/api/runs/${id}`, { visibility: 'private' });
  assert.equal(r.data.visibility, 'private');
  assert.equal(runsIn((await svc.social.userFeed(asha.id, stranger.actor))).length, 1);
  assert.equal((await asha.call('DELETE', `/api/runs/${id}`)).status, 200);
  assert.equal((await asha.call('GET', '/api/runs')).data.recent.length, 2);
});

test('km and runs goals count logged runs', async () => {
  const a = await person('Goal Runner');
  const b = await person('Club Runner');
  const g = (await a.call('POST', '/api/goals', { scope: 'personal', metric: 'km', target: 50, sport: 'badminton' })).data;
  assert.deepEqual([g.title, g.sport, g.me.value], ['50 km run', null, 0]);
  await a.call('POST', '/api/runs', { km: 21.1, time: '2:05:00' });
  await a.call('POST', '/api/runs', { km: 30, time: '3:00:00' });
  await a.call('POST', '/api/runs', { km: 5, time: '30:00', ranAt: daysAgo(40) }); // before the goal
  const v = (await a.call('GET', `/api/goals/${g.id}`)).data;
  assert.equal(v.me.value, 51);
  const notes = (await a.call('GET', '/api/notifications')).data.items.filter((x) => x.kind === 'goal');
  assert.deepEqual(notes.map((x) => x.title), ['🏅 Goal reached: 50 km run']);
  // A club's runs.
  await svc.clubs.create(a.actor, { name: 'Marina Runners', slug: 'marina-runners', sports: [] });
  await b.call('POST', '/api/clubs/marina-runners/join', {});
  const club = (await a.call('POST', '/api/goals', { scope: 'club', club: 'marina-runners', metric: 'runs', target: 4 })).data;
  await new Promise((res) => { setTimeout(res, 20); });
  await b.call('POST', '/api/runs', { km: 5, time: '28:00' });
  await a.call('POST', '/api/runs', { km: 8, time: '45:00' });
  assert.equal((await b.call('GET', `/api/goals/${club.id}`)).data.total, 2, 'runs since the goal started');
});
