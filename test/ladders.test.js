'use strict';

// Club ladders: admins start one, members join at the bottom, challenge up to
// `reach` places above; a challenger who wins takes the place (everyone in
// between moves down one), a defender who wins stays; a week unanswered is a
// forfeit; leaving closes the gap; the feed, the displaced player's
// notification and the share card.

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
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@ladder.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
const order = (l) => l.rungs.map((r) => r.name);

test('ladders: join, reach, the leapfrog, holding a place, forfeits, leaving, feed and card', async () => {
  const admin = await person('Ladder Admin');
  const [p1, p2, p3, p4, p5] = await Promise.all(['P One', 'P Two', 'P Three', 'P Four', 'P Five'].map(person));
  const outsider = await person('Out Sider');
  await svc.clubs.create(admin.actor, { name: 'Ladder Club', slug: 'ladder-club', sports: ['badminton'] });
  for (const p of [p1, p2, p3, p4, p5]) await p.call('POST', '/api/clubs/ladder-club/join', {});
  // Only admins start one.
  assert.equal((await p1.call('POST', '/api/clubs/ladder-club/ladders', { sport: 'badminton' })).status, 403);
  let r = await admin.call('POST', '/api/clubs/ladder-club/ladders', { sport: 'badminton', reach: 2, bestOf: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [l] = r.data.ladders;
  assert.deepEqual([l.name, l.reach, l.sport.name], ['Ladder Club Badminton ladder', 2, 'Badminton']);
  // Join in order; outsiders can't.
  for (const p of [p1, p2, p3, p4, p5]) r = await p.call('POST', `/api/ladders/${l.id}/join`);
  assert.deepEqual(order(r.data.ladders[0]), ['P One', 'P Two', 'P Three', 'P Four', 'P Five']);
  assert.equal((await outsider.call('POST', `/api/ladders/${l.id}/join`)).status, 403);
  // #5 can reach #3 and #4, not #2 or below.
  const view = (await p5.call('GET', '/api/clubs/ladder-club/ladders')).data.ladders[0];
  assert.deepEqual(view.rungs.filter((x) => x.canChallenge).map((x) => x.position), [3, 4]);
  assert.equal((await p5.call('POST', `/api/ladders/${l.id}/challenge`, { to: p2.id })).status, 409);
  // #5 challenges #3; one open ladder challenge at a time; no declining it.
  r = await p5.call('POST', `/api/ladders/${l.id}/challenge`, { to: p3.id, place: 'Court 1' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = r.data;
  assert.deepEqual([c.ladder.a, c.ladder.b, c.message], [5, 3, 'Ladder: #5 v #3']);
  assert.equal((await p5.call('POST', `/api/ladders/${l.id}/challenge`, { to: p4.id })).status, 409);
  assert.equal((await p3.call('POST', `/api/challenges/${c.id}/respond`, { accept: false })).status, 409);
  await p3.call('POST', `/api/challenges/${c.id}/respond`, { accept: true });
  await p5.call('POST', `/api/challenges/${c.id}/result`, { a: 21, b: 15 });
  await p3.call('POST', `/api/challenges/${c.id}/confirm`);
  // Leapfrog: #5 to #3; #3 and #4 down one.
  r = await p1.call('GET', '/api/clubs/ladder-club/ladders');
  assert.deepEqual(order(r.data.ladders[0]), ['P One', 'P Two', 'P Five', 'P Three', 'P Four']);
  assert.equal(r.data.ladders[0].rungs[2].climbed, true);
  const [note] = (await p3.call('GET', '/api/notifications')).data.items;
  assert.equal(note.title, 'P Five took your #3 spot on the Ladder Club Badminton ladder');
  const [item] = (await svc.social.clubFeed((await db.query(`SELECT id FROM orgs WHERE slug = 'ladder-club'`))[0].id, p1.actor)).items.filter((x) => x.verb === 'ladder');
  assert.deepEqual([item.data.from, item.data.to, item.data.beat, item.data.score], [5, 3, 'P Three', '21–15']);
  assert.equal((await fetch(`${base}/img/a/${item.id}.png`)).status, 200);
  assert.equal((await fetch(`${base}/img/ladder/${l.id}.png`)).status, 200);
  // A defender who wins keeps their place: #4 (P Three) challenges #2 (P Two) and loses.
  r = await p3.call('POST', `/api/ladders/${l.id}/challenge`, { to: p2.id });
  await p2.call('POST', `/api/challenges/${r.data.id}/respond`, { accept: true });
  await p2.call('POST', `/api/challenges/${r.data.id}/result`, { a: 10, b: 21 });
  await p3.call('POST', `/api/challenges/${r.data.id}/confirm`);
  assert.deepEqual(order((await p1.call('GET', '/api/clubs/ladder-club/ladders')).data.ladders[0]), ['P One', 'P Two', 'P Five', 'P Three', 'P Four']);
  // A week unanswered: the challenger takes the place. #5 (P Four) challenges #3 (P Five).
  r = await p4.call('POST', `/api/ladders/${l.id}/challenge`, { to: p5.id });
  await db.query(`UPDATE challenges SET created_at = now() - interval '8 days' WHERE id = $1`, [r.data.id]);
  r = await p1.call('GET', '/api/clubs/ladder-club/ladders');
  assert.deepEqual(order(r.data.ladders[0]), ['P One', 'P Two', 'P Four', 'P Five', 'P Three']);
  // Leaving closes the gap.
  r = await p2.call('POST', `/api/ladders/${l.id}/leave`);
  assert.deepEqual(r.data.ladders[0].rungs.map((x) => [x.position, x.name]), [[1, 'P One'], [2, 'P Four'], [3, 'P Five'], [4, 'P Three']]);
});
