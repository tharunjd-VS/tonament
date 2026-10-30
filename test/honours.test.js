'use strict';

// Club honours and rankings: a club's trophies (club v club wins, team
// titles) and its members' wins (titles, podiums, medals) add up to points;
// clubs are ranked (by city and kind too). Representing a club: set on the
// profile, it goes on race entries and leads the clubs offered at meets.

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
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@honours.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
// A club with an admin and `extra` members.
async function club(name, slug, sportsList, extra) {
  const admin = await person(`${name} Admin`);
  await svc.clubs.create(admin.actor, { name, slug, sports: sportsList });
  const members = [];
  for (let i = 0; i < extra; i++) {
    const p = await person(`${name} P${i}`);
    await p.call('POST', `/api/clubs/${slug}/join`, {});
    members.push(p);
  }
  return { admin, members, slug };
}
test('honours, rankings and representing a club', async () => {
  const a = await club('Adyar Aces', 'adyar-aces', ['football'], 1);
  const b = await club('Besant Blues', 'besant-blues', ['football'], 1);
  await db.query(`UPDATE orgs SET city = 'Chennai' WHERE slug IN ('adyar-aces', 'besant-blues')`);
  const runner = a.members[0];
  // Club v club: Adyar beat Besant 2–1.
  const cc = (await a.admin.call('POST', '/api/clubs/adyar-aces/club-challenges', { to: 'besant-blues', sport: 'football' })).data;
  const v = (await b.admin.call('POST', `/api/club-challenges/${cc.id}/respond`, { accept: true })).data;
  await a.admin.call('POST', `/api/club-challenges/${cc.id}/team`, { members: [a.admin.id] });
  await b.admin.call('POST', `/api/club-challenges/${cc.id}/team`, { members: [b.admin.id] });
  await a.admin.call('POST', `/api/tournaments/${v.tournamentId}/matches/${v.match.id}/result`, { games: [{ a: 2, b: 1 }] });
  // Representing: only a club you're in.
  assert.equal((await runner.call('PATCH', '/api/me/profile', { represents: 'besant-blues' })).status, 400);
  const prof = (await runner.call('PATCH', '/api/me/profile', { represents: 'adyar-aces' })).data;
  assert.deepEqual(prof.represents, { slug: 'adyar-aces', name: 'Adyar Aces' });
  // A race: the runner (for Adyar) wins.
  const org = await person('Race Org');
  const race = (await org.call('POST', '/api/races', { name: 'Beach 5K', startsAt: new Date(Date.now() + 86400000).toISOString(), place: 'Elliot\'s Beach', distances: ['5k'] })).data;
  await runner.call('POST', `/api/races/${race.id}/enter`, { event: race.events[0].id, gender: 'f' });
  await org.call('POST', `/api/races/${race.id}/runners`, { name: 'Other Runner', event: race.events[0].id, team: 'Besant Blues' });
  await org.call('POST', `/api/races/${race.id}/result`, { bib: 1, time: '20:00' });
  await org.call('POST', `/api/races/${race.id}/result`, { bib: 2, time: '21:00' });
  const done = (await org.call('POST', `/api/races/${race.id}/publish`)).data;
  assert.deepEqual(done.events[0].finishers.map((f) => f.team), ['Adyar Aces', 'Besant Blues']);
  // A meet: Besant win the team title (named after the club).
  const meet = (await org.call('POST', '/api/meets', { sport: 'swimming', name: 'City Splash', place: 'Velachery Pool', startsAt: new Date(Date.now() + 86400000).toISOString(), events: [{ name: '50m freestyle', gender: 'x' }] })).data;
  const ev = meet.events[0];
  await org.call('POST', `/api/meets/${meet.id}/athletes`, { event: ev.id, athletes: 'Swim One, Besant Blues\nSwim Two, Adyar Aces' });
  let m = (await org.call('POST', `/api/meets/${meet.id}/events/${ev.id}/start`)).data;
  const ath = m.events[0].athletes;
  await org.call('POST', `/api/meets/${meet.id}/events/${ev.id}/marks`, { results: [{ entry: ath.find((x) => x.name === 'Swim One').id, mark: '30.10' }, { entry: ath.find((x) => x.name === 'Swim Two').id, mark: '31.00' }] });
  m = (await org.call('POST', `/api/meets/${meet.id}/events/${ev.id}/finish`)).data;
  assert.equal(m.status, 'done');
  // Honours.
  const ha = (await a.admin.call('GET', '/api/clubs/adyar-aces/honours')).data;
  assert.deepEqual(ha.trophies.map((x) => x.title), ['Beat Besant Blues']);
  assert.deepEqual(ha.members.map((x) => x.title), [`${runner.name} 1st in the 5K`]);
  assert.equal(ha.points, 3 + 2);
  const hb = (await a.admin.call('GET', '/api/clubs/besant-blues/honours')).data;
  assert.deepEqual(hb.trophies.map((x) => [x.title, x.points]), [['Team champions · City Splash', 8]]);
  assert.deepEqual([hb.points, hb.rank], [8, { place: 1, of: 2 }]);
  // Rankings, and filters.
  let r = (await a.admin.call('GET', '/api/club-rankings')).data;
  assert.deepEqual(r.items.map((x) => [x.place, x.name, x.points]), [[1, 'Besant Blues', 8], [2, 'Adyar Aces', 5]]);
  assert.ok(r.cities.includes('Chennai'));
  r = (await a.admin.call('GET', '/api/club-rankings?city=Mumbai')).data;
  assert.equal(r.items.length, 0);
  // Meets offer my club first.
  const meet2 = (await org.call('POST', '/api/meets', { sport: 'athletics', name: 'Track Day', place: 'Stadium', startsAt: new Date(Date.now() + 86400000).toISOString(), events: [{ name: '100m', gender: 'f' }] })).data;
  const seen = (await runner.call('GET', `/api/meets/${meet2.id}`)).data;
  assert.deepEqual(seen.myClubs.map((c) => [c.slug, c.rep]), [['adyar-aces', true]]);
});
