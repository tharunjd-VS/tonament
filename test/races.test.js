'use strict';

// Races: setting one up (distances), entering (bibs), the organiser's
// walk-ins and times by bib, results by distance, gender and age group,
// publishing (runs, feed posts, notifications; kept up to date), the cards.

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
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@races.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
test('a race: entries and bibs, times, results by gender and age group, published to runs and feeds', async () => {
  const org = await person('Race Director');
  const asha = await person('Asha Fast');
  const ben = await person('Ben Steady');
  const outsider = await person('Some One');
  const at = new Date(Date.now() + 3 * 86400000).toISOString();
  assert.equal((await org.call('POST', '/api/races', { name: 'Chennai 10K', startsAt: at, place: 'Island Grounds', distances: [] })).status, 400);
  let r = await org.call('POST', '/api/races', { name: 'Chennai Night Run', startsAt: at, place: 'Island Grounds', city: 'Chennai', distances: ['10k', '5k'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let race = r.data;
  assert.deepEqual(race.events.map((e) => e.name), ['5K', '10K']);
  const [five, ten] = race.events;
  // Entering: bibs in order; once.
  race = (await asha.call('POST', `/api/races/${race.id}/enter`, { event: ten.id, gender: 'f', birthYear: 1992 })).data;
  assert.deepEqual([race.me.bib, race.me.event], [1, '10K']);
  assert.equal((await asha.call('POST', `/api/races/${race.id}/enter`, { event: ten.id })).status, 409);
  await ben.call('POST', `/api/races/${race.id}/enter`, { event: ten.id, gender: 'm', birthYear: 1975 });
  assert.equal((await outsider.call('POST', `/api/races/${race.id}/runners`, { name: 'Walk In', event: ten.id })).status, 403);
  for (const [name, g, y] of [['Kiran M', 'm', 1990], ['Lata P', 'f', 1970], ['Mo Five', 'm', 2001]]) {
    race = (await org.call('POST', `/api/races/${race.id}/runners`, { name, gender: g, birthYear: y, event: name === 'Mo Five' ? five.id : ten.id })).data;
  }
  assert.deepEqual(race.runners.map((x) => [x.bib, x.name]), [[1, 'Asha Fast'], [2, 'Ben Steady'], [3, 'Kiran M'], [4, 'Lata P'], [5, 'Mo Five']]);
  assert.equal(race.runners.length, 5);
  assert.equal((await asha.call('GET', `/api/races/${race.id}`)).data.runners, null, 'only organisers see the list');
  // Times by bib.
  assert.equal((await org.call('POST', `/api/races/${race.id}/result`, { bib: 99, time: '40:00' })).status, 404);
  assert.equal((await org.call('POST', `/api/races/${race.id}/result`, { bib: 1, time: '15:00' })).status, 400, 'world record');
  assert.equal((await asha.call('POST', `/api/races/${race.id}/result`, { bib: 1, time: '45:00' })).status, 403);
  for (const [bib, time] of [[1, '44:10'], [2, '41:30'], [3, '39:59'], [4, '52:00'], [5, '22:05']]) {
    r = await org.call('POST', `/api/races/${race.id}/result`, { bib, time });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.deepEqual(r.data.saved, { bib: 5, name: 'Mo Five', time: '22:05', dnf: false });
  // Not out yet: runners don't see results; the organiser does.
  assert.equal((await asha.call('GET', `/api/races/${race.id}`)).data.events[1].finishers.length, 0);
  race = (await org.call('GET', `/api/races/${race.id}`)).data;
  const tenK = race.events[1];
  // Ages on race day (this year): Kiran and Asha 30s, Ben and Lata 50s.
  const age = (y) => new Date(race.startsAt).getUTCFullYear() - y;
  assert.ok(age(1990) >= 30 && age(1992) <= 39 && age(1975) >= 50 && age(1970) <= 59, 'the test years still fit their groups');
  assert.deepEqual(tenK.finishers.map((f) => [f.name, f.place, f.genderPlace, f.ageGroup, f.groupPlace]), [
    ['Kiran M', 1, 1, '30–39', 1], ['Ben Steady', 2, 2, '50–59', 1], ['Asha Fast', 3, 1, '30–39', 1], ['Lata P', 4, 2, '50–59', 1],
  ]);
  assert.equal(tenK.finishers[0].pace, '4:00');
  // Publish: Asha and Ben (linked) get runs and posts; everyone in it is told.
  assert.equal((await asha.call('POST', `/api/races/${race.id}/publish`)).status, 403);
  race = (await org.call('POST', `/api/races/${race.id}/publish`)).data;
  assert.equal(race.status, 'done');
  const mine = (await asha.call('GET', `/api/races/${race.id}`)).data.me;
  assert.deepEqual([mine.result.place, mine.result.genderPlace, mine.result.time], [3, 1, '44:10']);
  const runs = (await asha.call('GET', '/api/runs')).data;
  assert.equal(runs.recent[0].title, 'Chennai Night Run · 10K');
  assert.deepEqual(runs.bests.map((b) => b.name), ['5K', '10K']);
  const feed = (await svc.social.userFeed(asha.id, outsider.actor)).items.filter((x) => x.verb === 'race');
  assert.equal(feed.length, 1);
  const card = await svc.cards.activity(feed[0].id);
  assert.deepEqual([card.title, card.big, card.subtitle], ['Asha Fast', '44:10', '3rd of 4 · 1st of the women · 1st in 30–39']);
  assert.ok((await ben.call('GET', '/api/notifications')).data.items.some((x) => x.title === '🏁 Chennai Night Run: results are out'));
  // A correction after publishing: Asha's time changes, her run follows; a DNF takes Ben's run away.
  await org.call('POST', `/api/races/${race.id}/result`, { bib: 1, time: '43:50' });
  assert.equal((await asha.call('GET', '/api/runs')).data.recent[0].time, '43:50');
  await org.call('POST', `/api/races/${race.id}/result`, { bib: 2, dnf: true });
  assert.equal((await ben.call('GET', '/api/runs')).data.recent.length, 0);
  assert.equal((await svc.social.userFeed(ben.id, outsider.actor)).items.filter((x) => x.verb === 'race').length, 0);
  // Lists, cards, pages.
  const list = (await outsider.call('GET', '/api/races')).data;
  assert.ok(list.past.some((x) => x.id === race.id));
  assert.equal((await fetch(`${base}/img/race/${race.id}.png`)).status, 200);
  assert.equal((await fetch(`${base}/race/${race.id}`)).status, 200);
});
