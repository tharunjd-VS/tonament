'use strict';

// Track meets: events measured by time, distance or height; heats when a
// timed event has more entries than lanes, the best marks to a final in the
// middle lanes; places (ties share), personal bests, team points, feed posts,
// reopening to fix a mark, and the meet's team champions.

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
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@meets.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
const { readMark, showMark, LANE_ORDER } = require('../server/meets');

test('marks and lanes', () => {
  assert.equal(readMark('time', '10.85'), 10.85);
  assert.equal(readMark('time', '1:52.30'), 112.3);
  assert.equal(readMark('time', '1:75.00'), null);
  assert.equal(readMark('distance', '6.45'), 6.45);
  assert.equal(readMark('distance', 'far'), null);
  assert.equal(showMark('time', 112.3), '1:52.30');
  assert.equal(showMark('height', 1.9), '1.90 m');
  assert.deepEqual(LANE_ORDER(8), [4, 5, 3, 6, 2, 7, 1, 8]);
});

test('an athletics meet: heats to a final, a field event, places, PBs, team points, champions', async () => {
  const org = await person('Meet Director');
  const ravi = await person('Ravi Sprinter');
  const outsider = await person('Watching Fan');
  await svc.clubs.create(org.actor, { name: 'Anna Nagar AC', slug: 'anna-nagar-ac', sports: [] });
  await ravi.call('POST', '/api/clubs/anna-nagar-ac/join', {});
  const at = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await org.call('POST', '/api/meets', { sport: 'chess', name: 'X', place: 'Y', startsAt: at, events: [{ name: '100m' }] })).status, 400);
  let r = await org.call('POST', '/api/meets', {
    sport: 'athletics', name: 'Chennai Open', place: 'Nehru Stadium', city: 'Chennai', startsAt: at, lanes: 4,
    events: [{ name: '100m', gender: 'm' }, { name: 'Long jump', gender: 'f' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let meet = r.data;
  const [hundred, lj] = meet.events;
  assert.deepEqual([hundred.kind, lj.kind, hundred.genderName], ['time', 'distance', 'Men']);
  // Entries: Ravi himself (for his club), the rest by the organiser.
  assert.equal((await ravi.call('POST', `/api/meets/${meet.id}/enter`, { event: hundred.id, club: 'other-club' })).status, 403);
  meet = (await ravi.call('POST', `/api/meets/${meet.id}/enter`, { event: hundred.id, club: 'anna-nagar-ac' })).data;
  assert.equal(meet.events[0].athletes[0].team, 'Anna Nagar AC');
  assert.equal((await ravi.call('POST', `/api/meets/${meet.id}/athletes`, { event: hundred.id, athletes: 'Sneaky, X' })).status, 403);
  meet = (await org.call('POST', `/api/meets/${meet.id}/athletes`, { event: hundred.id, athletes: 'Ajay K, Anna Nagar AC\nBala M, Velachery TC\nCharan P, Velachery TC\nDev R, Tambaram AC\nEshan T, Tambaram AC' })).data;
  meet = (await org.call('POST', `/api/meets/${meet.id}/athletes`, { event: lj.id, athletes: ['Fathima, Velachery TC', 'Geetha, Anna Nagar AC', 'Hema, Tambaram AC'] })).data;
  assert.equal(meet.events[0].entries, 6);
  // 6 entries, 4 lanes: two heats.
  meet = (await org.call('POST', `/api/meets/${meet.id}/events/${hundred.id}/start`)).data;
  let ev = meet.events[0];
  assert.deepEqual([ev.stage, ev.heats], ['heats', [1, 2]]);
  assert.equal(meet.status, 'on');
  const times = { 'Ravi Sprinter': '10.91', 'Ajay K': '11.40', 'Bala M': '10.85', 'Charan P': '11.02', 'Dev R': '11.75', 'Eshan T': '12.10' };
  const id = (list, name) => list.find((x) => x.name === name).id;
  assert.equal((await org.call('POST', `/api/meets/${meet.id}/events/${hundred.id}/marks`, { results: [{ entry: id(ev.athletes, 'Dev R'), mark: 'quick' }] })).status, 400);
  meet = (await org.call('POST', `/api/meets/${meet.id}/events/${hundred.id}/marks`, {
    results: Object.entries(times).map(([n, t]) => ({ entry: id(ev.athletes, n), mark: n === 'Eshan T' ? null : t, status: n === 'Eshan T' ? 'dns' : 'ok' })),
  })).data;
  // The final: the best 4, fastest in lane 2 (4 lanes: 2 3 1 4).
  meet = (await org.call('POST', `/api/meets/${meet.id}/events/${hundred.id}/final`)).data;
  ev = meet.events[0];
  const finalists = ev.athletes.filter((x) => x.inFinal).sort((a, b) => a.lane - b.lane);
  assert.deepEqual(finalists.map((x) => [x.lane, x.name]), [[1, 'Charan P'], [2, 'Bala M'], [3, 'Ravi Sprinter'], [4, 'Ajay K']]);
  await org.call('POST', `/api/meets/${meet.id}/events/${hundred.id}/marks`, {
    results: [['Bala M', '10.80'], ['Ravi Sprinter', '10.79'], ['Charan P', '11.00'], ['Ajay K', '11.00']].map(([n, t]) => ({ entry: id(ev.athletes, n), mark: t })),
  });
  meet = (await org.call('POST', `/api/meets/${meet.id}/events/${hundred.id}/finish`)).data;
  ev = meet.events[0];
  assert.deepEqual(ev.results.map((x) => [x.place, x.name, x.mark, x.pb]), [[1, 'Ravi Sprinter', '10.79', true], [2, 'Bala M', '10.80', false], [3, 'Ajay K', '11.00', false], [3, 'Charan P', '11.00', false]]);
  // Points 8-6-5-4-…: a tie for third both score 5.
  assert.deepEqual(meet.teams.map((t) => [t.team, t.points, t.gold]), [['Anna Nagar AC', 13, 1], ['Velachery TC', 11, 0]]);
  // Ravi's post.
  const post = (await svc.social.userFeed(ravi.id, outsider.actor)).items.find((x) => x.verb === 'meet');
  assert.deepEqual([post.data.mark, post.data.place, post.data.pb], ['10.79', 1, true]);
  const card = await svc.cards.activity(post.id);
  assert.deepEqual([card.big, card.bigLabel], ['10.79', 'Gold']);
  // The long jump: straight to a final, higher is better.
  meet = (await org.call('POST', `/api/meets/${meet.id}/events/${lj.id}/start`)).data;
  ev = meet.events[1];
  assert.equal(ev.stage, 'final');
  await org.call('POST', `/api/meets/${meet.id}/events/${lj.id}/marks`, { results: [['Fathima', '5.40'], ['Geetha', '5.92'], ['Hema', '5.10']].map(([n, m]) => ({ entry: id(ev.athletes, n), mark: m })) });
  meet = (await org.call('POST', `/api/meets/${meet.id}/events/${lj.id}/finish`)).data;
  assert.deepEqual(meet.events[1].results.map((x) => [x.name, x.mark]), [['Geetha', '5.92 m'], ['Fathima', '5.40 m'], ['Hema', '5.10 m']]);
  assert.equal(meet.status, 'done');
  assert.deepEqual(meet.teams.map((t) => [t.team, t.points]), [['Anna Nagar AC', 21], ['Velachery TC', 17], ['Tambaram AC', 5]]);
  const champs = async () => db.query(`SELECT data FROM activity WHERE verb = 'meet_won' AND object_id = $1`, [String(meet.id)]);
  assert.equal((await champs())[0].data.team, 'Anna Nagar AC');
  // Reopen to fix a mark: the meet's back on, posts go.
  meet = (await org.call('POST', `/api/meets/${meet.id}/events/${lj.id}/reopen`)).data;
  assert.deepEqual([meet.status, meet.events[1].stage], ['on', 'final']);
  assert.equal((await champs()).length, 0);
  // Lists, cards, pages.
  assert.ok((await outsider.call('GET', '/api/meets')).data.upcoming.some((x) => x.id === meet.id));
  assert.equal((await fetch(`${base}/img/meet/${meet.id}.png`)).status, 200);
  assert.equal((await fetch(`${base}/meet/${meet.id}`)).status, 200);
});
