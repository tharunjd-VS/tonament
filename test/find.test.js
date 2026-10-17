'use strict';

// Venue, location and dates, and finding public tournaments with filters.

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

const ORG = { user: { id: 1, email: 'org@find.test', name: 'Org', isAdmin: false } };
const TODAY = '2030-06-10';
const names = (list) => list.map((t) => t.name);

async function make(input) {
  const { id } = await svc.createTournament(ORG, { visibility: 'public', format: 'knockout', ...input });
  return id;
}

test('venue details: validation and normalising', async () => {
  const id = await make({
    name: 'Detail Cup', venue: 'City Sports Hall', address: '19th Cross Street, Kottivakkam',
    city: '  chennai ', region: 'tamil nadu', postcode: '600041', country: 'india',
    startsOn: '2030-07-01', endsOn: '2030-07-02',
  });
  const t = await svc.getTournament(id);
  assert.equal(t.venue, 'City Sports Hall');
  assert.deepEqual(t.location, { address: '19th Cross Street, Kottivakkam', city: 'Chennai', region: 'Tamil Nadu', postcode: '600041', country: 'India' });
  assert.equal(t.startsOn, '2030-07-01');
  assert.equal(t.endsOn, '2030-07-02');

  const bad = (input, re) => assert.rejects(make({ name: 'Bad', ...input }), (e) => e.status === 400 && re.test(e.message));
  await bad({ country: 'India', region: 'Texas' }, /Choose a state in India/);
  await bad({ startsOn: '2030-02-30' }, /Start date: enter a valid date/);
  await bad({ startsOn: '2030-07-02', endsOn: '2030-07-01' }, /on or after the start date/);
  await bad({ endsOn: '2030-07-01' }, /Add a start date first/);
  await bad({ address: 'x'.repeat(121) }, /Address must be at most 120/);

  // "Other" countries take any state; cities are title-cased.
  const other = await svc.getTournament(await make({ name: 'Doha Open', country: 'qatar', region: 'Al Rayyan', city: 'new  doha city' }));
  assert.deepEqual([other.location.country, other.location.region, other.location.city], ['Qatar', 'Al Rayyan', 'New Doha City']);
  // A one-day event keeps just the start date.
  assert.equal((await svc.getTournament(await make({ name: 'One Day', startsOn: '2030-07-05', endsOn: '2030-07-05' }))).endsOn, null);
});

test('venue and dates stay editable after the start; other settings do not', async () => {
  const id = await make({ name: 'Moved Cup', city: 'Chennai', country: 'India', region: 'Tamil Nadu' });
  await svc.addEntries(id, ORG, ['A', 'B']);
  await svc.start(id, ORG);
  const t = await svc.updateSettings(id, ORG, { name: 'Moved Cup 2030', venue: 'New Hall', city: 'coimbatore', startsOn: '2030-08-01' });
  assert.equal(t.name, 'Moved Cup 2030'); // the tournament's name and venue stay editable
  assert.equal(t.venue, 'New Hall');
  assert.equal(t.location.city, 'Coimbatore');
  assert.equal(t.location.region, 'Tamil Nadu'); // untouched fields are kept
  assert.equal(t.startsOn, '2030-08-01');
  await assert.rejects(svc.updateSettings(id, ORG, { format: 'league' }), /locked/);
});

test('search: only public tournaments, every filter, sensible order', async () => {
  const base = { country: 'Malaysia', region: 'Penang' };
  await make({ ...base, name: 'Penang Later', city: 'George Town', startsOn: '2030-06-25' });
  await make({ ...base, name: 'Penang Soon', city: 'George Town', startsOn: '2030-06-12', endsOn: '2030-06-13' });
  await make({ ...base, name: 'Penang Undated', city: 'Butterworth' });
  await make({ ...base, name: 'Penang Past', city: 'George Town', startsOn: '2030-05-01' });
  await make({ ...base, name: 'Penang Link', city: 'George Town', startsOn: '2030-06-12', visibility: 'link' });
  await make({ ...base, name: 'Penang Private', city: 'George Town', startsOn: '2030-06-12', visibility: 'private' });
  await make({ ...base, name: 'Penang Closed', city: 'George Town', startsOn: '2030-06-20', selfEntry: false });
  const running = await make({ ...base, name: 'Penang Running', city: 'George Town', startsOn: '2030-06-10' });
  await svc.addEntries(running, ORG, ['A', 'B']);
  await svc.start(running, ORG);
  await make({ country: 'Malaysia', region: 'Selangor', city: 'Shah Alam', name: 'Selangor Cup', startsOn: '2030-06-15' });

  const find = (f) => svc.listTournaments({ today: TODAY, country: 'malaysia', ...f }).then(names);

  // Default: upcoming and live, soonest first, undated last; never private/link-only.
  assert.deepEqual(await find({ region: 'Penang' }), ['Penang Running', 'Penang Soon', 'Penang Closed', 'Penang Later', 'Penang Undated']);
  assert.deepEqual(await find({ city: 'GEORGE TOWN', when: 'week' }), ['Penang Running', 'Penang Soon']);
  assert.deepEqual(await find({ region: 'Penang', when: 'month' }), ['Penang Running', 'Penang Soon', 'Penang Closed', 'Penang Later']);
  assert.deepEqual(await find({ region: 'Penang', when: 'past' }), ['Penang Past']);
  assert.deepEqual(await find({ region: 'Penang', open: '1' }), ['Penang Soon', 'Penang Later', 'Penang Undated']);
  assert.deepEqual(await find({ q: 'selangor' }), ['Selangor Cup']);
  assert.deepEqual(await find({ q: '%' }), []); // wildcards are literal
  assert.deepEqual(await find({ sport: 'badminton', region: 'Selangor' }), ['Selangor Cup']);
  assert.equal((await find({ region: 'Penang', when: 'any' })).length, 6);

  const card = (await svc.listTournaments({ today: TODAY, q: 'Penang Soon' }))[0];
  assert.deepEqual(
    [card.city, card.region, card.country, card.startsOn, card.endsOn, card.entriesOpen],
    ['George Town', 'Penang', 'Malaysia', '2030-06-12', '2030-06-13', true],
  );

  const places = await svc.tournamentPlaces();
  const penang = places.filter((p) => p.region === 'Penang').map((p) => p.city);
  assert.deepEqual(penang, ['Butterworth', 'George Town']); // distinct, public only
});

test('HTTP: search filters come from the query string and are cacheable', async () => {
  await make({ name: 'Http Find', country: 'Singapore', city: 'Singapore', startsOn: '2030-06-20' });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/tournaments?country=Singapore&when=any&today=${TODAY}`);
    assert.match(res.headers.get('cache-control'), /s-maxage=5/);
    assert.deepEqual(names(await res.json()), ['Http Find']);
    const places = await fetch(`${base}/api/tournaments/places`);
    assert.equal(places.status, 200);
    assert.ok((await places.json()).some((p) => p.country === 'Singapore' && p.region === null));
  } finally {
    await new Promise((r) => server.close(r));
  }
});
