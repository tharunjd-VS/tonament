'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const vercelHandler = require('../api/index');

// One database for the whole file (embedded Postgres, or a real server via
// TEST_DATABASE_URL); each test makes its own tournaments.
let db;
let app;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  app = createApp(db);
  svc = app.service;
});
test.after(() => db.close());

// Plays a match to completion with `side` winning every rally.
async function play(id, key, matchId, side = 'a') {
  let m;
  do m = await svc.rally(id, key, matchId, side);
  while (m.status !== 'done');
  return m;
}

const names = (n) => Array.from({ length: n }, (_, i) => `Player ${i + 1}`);

test('league + knockout: full tournament from draw to champion', async () => {
  const { id, adminKey: key } = await svc.createTournament({
    name: 'Club Open',
    format: 'league_knockout',
    groups: 2,
    qualifiers: 2,
  });
  await svc.addEntries(id, key, names(6));
  let t = await svc.start(id, key);
  assert.equal(t.status, 'league');
  assert.equal(t.groups.length, 2);
  assert.deepEqual(t.groups.map((g) => g.standings.length), [3, 3]);
  const league = t.matches.filter((m) => m.stage === 'league');
  assert.equal(league.length, 6); // 3 per group of 3

  await assert.rejects(svc.startKnockout(id, key), /still to be played/);

  // The lower-numbered (higher seeded) player wins every league match.
  for (const m of league) {
    const better = Number(m.a.name.split(' ')[1]) < Number(m.b.name.split(' ')[1]) ? 'a' : 'b';
    await play(id, key, m.id, better);
  }
  t = await svc.getTournament(id, key);
  assert.equal(t.status, 'league');
  // Snake draw: A = 1, 4, 5 ; B = 2, 3, 6
  assert.deepEqual(t.groups[0].standings.map((r) => r.name), ['Player 1', 'Player 4', 'Player 5']);
  assert.deepEqual(t.groups[1].standings.map((r) => r.name), ['Player 2', 'Player 3', 'Player 6']);

  t = await svc.startKnockout(id, key);
  assert.equal(t.status, 'knockout');
  const ko = t.matches.filter((m) => m.stage === 'knockout');
  assert.equal(ko.length, 3);
  const semis = ko.filter((m) => m.roundName === 'Semi-finals');
  // A1 v B2, B1 v A2
  assert.deepEqual(
    semis.map((m) => [m.a.name, m.b.name]),
    [['Player 1', 'Player 3'], ['Player 2', 'Player 4']],
  );

  // League results are now locked.
  await assert.rejects(svc.undo(id, key, league[0].id), /locked/);

  await play(id, key, semis[0].id, 'b'); // Player 3 upsets Player 1
  await play(id, key, semis[1].id, 'a');
  t = await svc.getTournament(id, key);
  const final = t.matches.find((m) => m.roundName === 'Final');
  assert.deepEqual([final.a.name, final.b.name], ['Player 3', 'Player 2']);

  await play(id, key, final.id, 'b');
  t = await svc.getTournament(id, key);
  assert.equal(t.status, 'completed');
  assert.equal(t.champion.name, 'Player 2');

  // Undoing the final's last point reopens the tournament.
  await svc.undo(id, key, final.id);
  t = await svc.getTournament(id, key);
  assert.equal(t.status, 'knockout');
  assert.equal(t.champion, null);
});

test('knockout only with byes', async () => {
  const { id, adminKey: key } = await svc.createTournament({ name: 'Cup', format: 'knockout' });
  await svc.addEntries(id, key, names(5));
  const t = await svc.start(id, key);
  const ko = t.matches;
  assert.equal(ko.length, 7); // 8-draw: 4 + 2 + 1
  assert.equal(ko.filter((m) => m.status === 'bye').length, 3);
  const playable = ko.filter((m) => m.status === 'scheduled' && m.a && m.b);
  assert.deepEqual(playable.map((m) => `${m.roundName}: ${m.a.name} v ${m.b.name}`), [
    'Quarter-finals: Player 4 v Player 5',
    'Semi-finals: Player 2 v Player 3',
  ]);
  const semi = ko.find((m) => m.roundName === 'Semi-finals' && m.slot === 0);
  assert.equal(semi.a.name, 'Player 1');
  assert.equal(semi.b, null);
});

test('undo of a knockout win is blocked once the next match starts', async () => {
  const { id, adminKey: key } = await svc.createTournament({ name: 'Cup', format: 'knockout' });
  await svc.addEntries(id, key, names(4));
  const t = await svc.start(id, key);
  const [s1, s2] = t.matches.filter((m) => m.round === 1);
  await play(id, key, s1.id);
  await play(id, key, s2.id);
  const final = (await svc.getTournament(id, key)).matches.find((m) => m.round === 2);
  await svc.rally(id, key, final.id, 'a');
  await assert.rejects(svc.undo(id, key, s1.id), /next-round match has already started/);
  await svc.undo(id, key, final.id);
  const reopened = await svc.undo(id, key, s1.id);
  assert.equal(reopened.status, 'live');
  const after = (await svc.getTournament(id, key)).matches.find((m) => m.round === 2);
  assert.equal(after.a, null);
});

test('league only completes when all matches are played', async () => {
  const { id, adminKey: key } = await svc.createTournament({
    name: 'Ladder',
    format: 'league',
    groups: 1,
    scoring: { bestOf: 1, points: 11, cap: 15 },
  });
  await svc.addEntries(id, key, names(4));
  let t = await svc.start(id, key);
  for (const m of t.matches) await play(id, key, m.id, 'a');
  t = await svc.getTournament(id, key);
  assert.equal(t.status, 'completed');
  assert.equal(t.champion.name, t.groups[0].standings[0].name);
});

test('simultaneous rallies on one match are all counted', async () => {
  const { id, adminKey: key } = await svc.createTournament({ name: 'Race', format: 'knockout' });
  await svc.addEntries(id, key, ['A', 'B']);
  const [m] = (await svc.start(id, key)).matches;
  await Promise.all(Array.from({ length: 10 }, (_, i) => svc.rally(id, key, m.id, i % 2 ? 'b' : 'a')));
  const after = (await svc.getTournament(id)).matches[0];
  assert.equal(after.rallies, 10);
  assert.deepEqual([after.score.games[0].a, after.score.games[0].b], [5, 5]);
});

test('validation and permissions', async () => {
  await assert.rejects(svc.createTournament({ name: '  ' }), /required/);
  const { id, adminKey: key } = await svc.createTournament({ name: 'X', groups: 2, qualifiers: 3 });
  await assert.rejects(svc.addEntries(id, 'wrong', ['A']), /organiser/);
  await svc.addEntries(id, key, ['A', 'B', 'C']);
  await assert.rejects(svc.addEntries(id, key, ['a']), /already entered/);
  await assert.rejects(svc.start(id, key), /at least 4 entries/);
  await svc.addEntries(id, key, ['D']);
  await assert.rejects(svc.start(id, key), /at most 2 can qualify/);
  await svc.updateSettings(id, key, { qualifiers: 1 });
  const t = await svc.start(id, key);
  assert.equal(t.status, 'league');
  await assert.rejects(svc.addEntries(id, key, ['E']), /locked/);
  assert.equal((await svc.getTournament(id)).isAdmin, false);
  assert.equal((await svc.getTournament(id, key)).isAdmin, true);
});

test('reorder entries sets the seeding', async () => {
  const { id, adminKey: key } = await svc.createTournament({ name: 'X' });
  let t = await svc.addEntries(id, key, ['A', 'B', 'C']);
  const ids = t.entries.map((e) => e.id).reverse();
  t = await svc.reorderEntries(id, key, ids);
  assert.deepEqual(t.entries.map((e) => e.name), ['C', 'B', 'A']);
  await assert.rejects(svc.reorderEntries(id, key, ids.slice(1)), /every entry/);
});

test('HTTP API: auth, scoring and CDN caching', async () => {
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, key) => {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['X-Admin-Key'] = key;
    const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
    return { status: res.status, cache: res.headers.get('cache-control'), data: await res.json() };
  };
  try {
    const created = await call('POST', '/api/tournaments', { name: 'Live Test', format: 'knockout' });
    assert.equal(created.status, 201);
    const { id, adminKey: key } = created.data;
    assert.match(id, /^live-test-[0-9a-f]{6}$/);

    assert.equal((await call('POST', `/api/tournaments/${id}/entries`, { names: ['A', 'B'] })).status, 403);
    await call('POST', `/api/tournaments/${id}/entries`, { names: ['A', 'B'] }, key);
    const started = await call('POST', `/api/tournaments/${id}/start`, {}, key);
    const match = started.data.matches[0];

    const scored = await call('POST', `/api/tournaments/${id}/matches/${match.id}/rally`, { side: 'b' }, key);
    assert.equal(scored.status, 200);
    assert.equal(scored.cache, 'no-store');
    assert.deepEqual([scored.data.score.games[0].a, scored.data.score.games[0].b], [0, 1]);

    // Spectators get a CDN-cacheable copy; the organiser's copy is never cached.
    const pub = await call('GET', `/api/tournaments/${id}`);
    assert.match(pub.cache, /s-maxage=1/);
    assert.equal(pub.data.isAdmin, false);
    assert.equal(pub.data.matches[0].rallies, 1);
    const own = await call('GET', `/api/tournaments/${id}?admin=1`, undefined, key);
    assert.equal(own.cache, 'no-store');
    assert.equal(own.data.isAdmin, true);

    assert.equal((await call('POST', `/api/tournaments/${id}/matches/${match.id}/rally`, { side: 'x' }, key)).status, 400);
    assert.equal((await call('GET', '/api/tournaments/nope')).status, 404);
    const page = await fetch(`${base}/t/whatever`);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
    assert.equal((await call('DELETE', `/api/tournaments/${id}`, undefined, key)).status, 200);
    assert.equal((await call('GET', `/api/tournaments/${id}`)).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('Vercel entry: rewritten path and pre-parsed body', async () => {
  process.env.DATABASE_URL = ':memory:';
  // Minimal stand-ins for Vercel's request/response objects.
  const invoke = (method, url, body) =>
    new Promise((resolve) => {
      const req = { method, url, headers: { 'content-type': 'application/json' }, body };
      const res = {
        statusCode: 200,
        headers: {},
        writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
        setHeader(k, v) { this.headers[k] = v; },
        end(data) { resolve({ status: this.statusCode, data: JSON.parse(data) }); },
      };
      vercelHandler(req, res);
    });
  try {
    const created = await invoke('POST', '/api/index?__path=tournaments', { name: 'On Vercel' });
    assert.equal(created.status, 201);
    const got = await invoke('GET', `/api/index?__path=tournaments/${created.data.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.data.name, 'On Vercel');
  } finally {
    delete process.env.DATABASE_URL;
  }
});
