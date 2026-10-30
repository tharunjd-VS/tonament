'use strict';

// Club runs: an admin sets a weekly run, members say they're in for the next
// date, an admin marks who ran (once it's started, for a week), runners log
// it with one tap onto the club's feed, and the regulars add up.

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
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@clubruns.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
const IST = 5.5 * 3600000;
// The India weekday of yesterday: a run that day at 06:00 has happened.
const yesterday = new Date(Date.now() + IST - 86400000);
const lastDate = yesterday.toISOString().slice(0, 10);

test('a weekly club run: in, marked, logged, on the feed, regulars', async () => {
  const admin = await person('Run Captain');
  const kavya = await person('Kavya Runner');
  const outsider = await person('Out Runner');
  await svc.clubs.create(admin.actor, { name: 'Marina Runners', slug: 'marina-runners', sports: [] });
  await kavya.call('POST', '/api/clubs/marina-runners/join', {});
  const make = { weekday: yesterday.getUTCDay(), time: '06:00', place: 'Lighthouse gate', distance: '5 / 10 km', name: 'Sunrise run' };
  assert.equal((await kavya.call('POST', '/api/clubs/marina-runners/club-runs', make)).status, 403);
  assert.equal((await admin.call('POST', '/api/clubs/marina-runners/club-runs', { ...make, time: '6am' })).status, 400);
  let r = await admin.call('POST', '/api/clubs/marina-runners/club-runs', make);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let c = r.data;
  assert.equal(c.last.date, lastDate);
  assert.ok(c.next.date > lastDate);
  assert.ok((await kavya.call('GET', '/api/notifications')).data.items.some((x) => x.title === '🏃 Marina Runners: Sunrise run'));
  // In for the next one (members only).
  assert.equal((await outsider.call('POST', `/api/club-runs/${c.id}/rsvp`, { going: true })).status, 403);
  c = (await kavya.call('POST', `/api/club-runs/${c.id}/rsvp`, { going: true })).data;
  assert.deepEqual(c.next.going.map((p) => p.name), ['Kavya Runner']);
  const list = (await outsider.call('GET', '/api/clubs/marina-runners/club-runs')).data;
  assert.deepEqual([list.items.length, list.items[0].going], [1, 1]);
  // Can't mark a date that hasn't happened; can mark yesterday.
  assert.equal((await admin.call('POST', `/api/club-runs/${c.id}/mark`, { date: c.next.date, ran: [kavya.id] })).status, 409);
  assert.equal((await kavya.call('POST', `/api/club-runs/${c.id}/mark`, { date: lastDate, ran: [kavya.id] })).status, 403);
  assert.equal((await admin.call('POST', `/api/club-runs/${c.id}/mark`, { date: lastDate, ran: [outsider.id] })).status, 400);
  c = (await admin.call('POST', `/api/club-runs/${c.id}/mark`, { date: lastDate, ran: [admin.id, kavya.id] })).data;
  assert.deepEqual(c.last.ran.map((p) => [p.name, p.logged]), [['Kavya Runner', false], ['Run Captain', false]]);
  assert.ok((await kavya.call('GET', '/api/notifications')).data.items.some((x) => x.title === '🏃 You ran with Marina Runners'));
  // Log it: the club's name and place, on its feed; once.
  assert.equal((await outsider.call('POST', `/api/club-runs/${c.id}/log`, { date: lastDate, km: 5, time: '30:00' })).status, 403);
  r = await kavya.call('POST', `/api/club-runs/${c.id}/log`, { date: lastDate, km: 10, time: '58:00' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.title, r.data.place], ['Marina Runners · Sunrise run', 'Lighthouse gate']);
  assert.equal((await kavya.call('POST', `/api/club-runs/${c.id}/log`, { date: lastDate, km: 10, time: '58:00' })).status, 409);
  const orgId = (await db.query(`SELECT id FROM orgs WHERE slug = 'marina-runners'`))[0].id;
  const feed = (await svc.social.clubFeed(orgId, kavya.actor)).items;
  assert.equal(feed.find((x) => x.verb === 'club_run').data.ran, 2);
  assert.equal(feed.find((x) => x.verb === 'run').data.club, 'Marina Runners');
  // Not shown to outsiders: the "2 ran" post is for the club.
  assert.equal((await svc.social.clubFeed(orgId, outsider.actor)).items.filter((x) => x.verb === 'club_run').length, 0);
  c = (await admin.call('GET', `/api/club-runs/${c.id}`)).data;
  assert.equal(c.last.ran.find((p) => p.name === 'Kavya Runner').logged, true);
  assert.deepEqual(c.regulars.map((p) => p.runs), [1, 1]);
  // Unmark all: off the feed. Stop it.
  await admin.call('POST', `/api/club-runs/${c.id}/mark`, { date: lastDate, ran: [] });
  assert.equal((await svc.social.clubFeed(orgId, kavya.actor)).items.filter((x) => x.verb === 'club_run').length, 0);
  await admin.call('POST', `/api/club-runs/${c.id}/stop`);
  assert.equal((await outsider.call('GET', '/api/clubs/marina-runners/club-runs')).data.items.length, 0);
});
