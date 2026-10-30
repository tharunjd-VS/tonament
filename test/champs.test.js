'use strict';

// Motorsport championships: drivers (numbers, teams), qualifying to the
// grid, race results classified (DNF by laps, DNS/DSQ out), points with the
// fastest lap, driver and team standings, podium posts, reopening a round,
// and closing the championship with its champion.

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
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@champs.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
const { lapTime, showLap } = require('../server/champs');

test('lap times', () => {
  assert.equal(lapTime('48.312'), 48.312);
  assert.equal(lapTime('1:02.450'), 62.45);
  assert.equal(lapTime('1:75'), null);
  assert.equal(showLap(62.45), '1:02.450');
});

test('a karting championship: grid, race, points, standings, champions', async () => {
  const org = await person('Track Marshal');
  const arjun = await person('Arjun Racer');
  const outsider = await person('Grandstand Fan');
  assert.equal((await org.call('POST', '/api/champs', { name: 'Chennai Karting', rounds: [] })).status, 400);
  let r = await org.call('POST', '/api/champs', { name: 'Chennai Karting Cup', series: 'Rotax Senior', rounds: [{ name: 'Round 1', place: 'ECR Speedway' }, { name: 'Round 2', place: 'Kari Motor Speedway' }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let c = r.data;
  // Drivers: Arjun joins with #7; the rest from a list; numbers can't clash.
  c = (await arjun.call('POST', `/api/champs/${c.id}/join`, { number: 7, team: 'Speed Demons' })).data;
  assert.equal((await outsider.call('POST', `/api/champs/${c.id}/join`, { number: 7 })).status, 409);
  assert.equal((await arjun.call('POST', `/api/champs/${c.id}/drivers`, { drivers: '1, X' })).status, 403);
  c = (await org.call('POST', `/api/champs/${c.id}/drivers`, { drivers: '11, Bhavna R, Speed Demons\n22, Chirag T, Apex Racing\n33, Dinesh K, Apex Racing\n44, Esha M' })).data;
  assert.deepEqual(c.drivers.map((d) => d.number), [7, 11, 22, 33, 44]);
  const id = (name) => c.drivers.find((d) => d.name === name).id;
  const [r1, r2] = c.rounds;
  // Qualifying: Chirag on pole; Esha sets no time (back of the grid).
  assert.equal((await org.call('POST', `/api/champs/${c.id}/rounds/${r1.id}/qualifying`, { times: [{ driver: id('Chirag T'), time: 'fast' }] })).status, 400);
  await org.call('POST', `/api/champs/${c.id}/rounds/${r1.id}/qualifying`, { times: [['Arjun Racer', '48.402'], ['Bhavna R', '48.519'], ['Chirag T', '48.311'], ['Dinesh K', '49.020']].map(([n, t]) => ({ driver: id(n), time: t })) });
  c = (await org.call('POST', `/api/champs/${c.id}/rounds/${r1.id}/grid`)).data;
  assert.deepEqual(c.rounds[0].grid.map((x) => [x.grid, x.name]), [[1, 'Chirag T'], [2, 'Arjun Racer'], [3, 'Bhavna R'], [4, 'Dinesh K'], [5, 'Esha M']]);
  // The race: Arjun wins with the fastest lap; Dinesh DNF after 10 laps; Esha DSQ.
  const res = [
    ['Arjun Racer', 1, 15, '48.100', 'ok'], ['Chirag T', 2, 15, '48.250', 'ok'], ['Bhavna R', 3, 15, '48.600', 'ok'],
    ['Dinesh K', null, 10, '49.100', 'dnf'], ['Esha M', 4, 15, '48.050', 'dsq'],
  ].map(([n, finish, laps, bestLap, status]) => ({ driver: id(n), finish, laps, bestLap, status }));
  await org.call('POST', `/api/champs/${c.id}/rounds/${r1.id}/race`, { results: res });
  c = (await org.call('POST', `/api/champs/${c.id}/rounds/${r1.id}/finish`)).data;
  assert.deepEqual(c.rounds[0].results.map((x) => [x.position, x.name, x.points, x.fastest]), [
    [1, 'Arjun Racer', 26, true], [2, 'Chirag T', 18, false], [3, 'Bhavna R', 15, false], [4, 'Dinesh K', 0, false], [null, 'Esha M', 0, false],
  ]);
  assert.deepEqual(c.standings.slice(0, 3).map((d) => [d.name, d.points, d.wins]), [['Arjun Racer', 26, 1], ['Chirag T', 18, 0], ['Bhavna R', 15, 0]]);
  assert.deepEqual(c.teams.map((t) => [t.team, t.points]), [['Speed Demons', 41], ['Apex Racing', 18]]);
  // Arjun's podium post and card.
  const post = (await svc.social.userFeed(arjun.id, outsider.actor)).items.find((x) => x.verb === 'motor');
  assert.deepEqual([post.data.place, post.data.grid, post.data.fastest, post.data.standing], [1, 2, true, 1]);
  const card = await svc.cards.activity(post.id);
  assert.deepEqual([card.title, card.big, card.subtitle], ['#7 Arjun Racer', 'P1', 'Won from P2 on the grid · fastest lap']);
  // Two drivers can't share a finishing position.
  await org.call('POST', `/api/champs/${c.id}/rounds/${r2.id}/grid`);
  await org.call('POST', `/api/champs/${c.id}/rounds/${r2.id}/race`, { results: [{ driver: id('Chirag T'), finish: 1 }, { driver: id('Bhavna R'), finish: 1 }] });
  assert.equal((await org.call('POST', `/api/champs/${c.id}/rounds/${r2.id}/finish`)).status, 400);
  await org.call('POST', `/api/champs/${c.id}/rounds/${r2.id}/race`, { results: [['Chirag T', 1], ['Bhavna R', 2], ['Arjun Racer', 3], ['Dinesh K', 4], ['Esha M', 5]].map(([n, f]) => ({ driver: id(n), finish: f, laps: 15 })) });
  c = (await org.call('POST', `/api/champs/${c.id}/rounds/${r2.id}/finish`)).data;
  assert.deepEqual(c.standings.slice(0, 3).map((d) => [d.name, d.points]), [['Chirag T', 43], ['Arjun Racer', 41], ['Bhavna R', 33]]);
  // Reopen round 2 (its points come off), then finish again.
  c = (await org.call('POST', `/api/champs/${c.id}/rounds/${r2.id}/reopen`)).data;
  assert.equal(c.standings[0].name, 'Arjun Racer');
  c = (await org.call('POST', `/api/champs/${c.id}/rounds/${r2.id}/finish`)).data;
  // Close: Chirag is champion.
  assert.equal((await arjun.call('POST', `/api/champs/${c.id}/close`)).status, 403);
  c = (await org.call('POST', `/api/champs/${c.id}/close`)).data;
  assert.equal(c.status, 'done');
  const [champ] = await db.query(`SELECT data FROM activity WHERE verb = 'motor_champ' AND object_id = $1`, [String(c.id)]);
  assert.deepEqual([champ.data.driver, champ.data.team], ['Chirag T', 'Speed Demons']);
  assert.ok((await arjun.call('GET', '/api/notifications')).data.items.some((x) => x.title === '🏆 Chirag T is the Chennai Karting Cup champion'));
  assert.ok((await outsider.call('GET', '/api/champs')).data.some((x) => x.id === c.id));
  assert.equal((await fetch(`${base}/img/champ/${c.id}.png`)).status, 200);
  assert.equal((await fetch(`${base}/champ/${c.id}`)).status, 200);
});
