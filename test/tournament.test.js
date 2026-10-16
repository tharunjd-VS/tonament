'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');

function setup() {
  const app = createApp(openDb(':memory:'));
  return { app, svc: app.service };
}

// Plays a match to completion with `side` winning every rally.
function play(svc, id, key, matchId, side = 'a') {
  let m;
  do m = svc.rally(id, key, matchId, side);
  while (m.status !== 'done');
  return m;
}

const names = (n) => Array.from({ length: n }, (_, i) => `Player ${i + 1}`);

test('league + knockout: full tournament from draw to champion', () => {
  const { svc } = setup();
  const { id, adminKey: key } = svc.createTournament({
    name: 'Club Open',
    format: 'league_knockout',
    groups: 2,
    qualifiers: 2,
  });
  svc.addEntries(id, key, names(6));
  let t = svc.start(id, key);
  assert.equal(t.status, 'league');
  assert.equal(t.groups.length, 2);
  assert.deepEqual(t.groups.map((g) => g.standings.length), [3, 3]);
  const league = t.matches.filter((m) => m.stage === 'league');
  assert.equal(league.length, 6); // 3 per group of 3

  assert.throws(() => svc.startKnockout(id, key), /still to be played/);

  // The lower-numbered (higher seeded) player wins every league match.
  for (const m of league) {
    const better = Number(m.a.name.split(' ')[1]) < Number(m.b.name.split(' ')[1]) ? 'a' : 'b';
    play(svc, id, key, m.id, better);
  }
  t = svc.getTournament(id, key);
  assert.equal(t.status, 'league');
  // Snake draw: A = 1, 4, 5 ; B = 2, 3, 6
  assert.deepEqual(t.groups[0].standings.map((r) => r.name), ['Player 1', 'Player 4', 'Player 5']);
  assert.deepEqual(t.groups[1].standings.map((r) => r.name), ['Player 2', 'Player 3', 'Player 6']);

  t = svc.startKnockout(id, key);
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
  assert.throws(() => svc.undo(id, key, league[0].id), /locked/);

  play(svc, id, key, semis[0].id, 'b'); // Player 3 upsets Player 1
  play(svc, id, key, semis[1].id, 'a');
  t = svc.getTournament(id, key);
  const final = t.matches.find((m) => m.roundName === 'Final');
  assert.deepEqual([final.a.name, final.b.name], ['Player 3', 'Player 2']);

  play(svc, id, key, final.id, 'b');
  t = svc.getTournament(id, key);
  assert.equal(t.status, 'completed');
  assert.equal(t.champion.name, 'Player 2');

  // Undoing the final's last point reopens the tournament.
  svc.undo(id, key, final.id);
  t = svc.getTournament(id, key);
  assert.equal(t.status, 'knockout');
  assert.equal(t.champion, null);
});

test('knockout only with byes', () => {
  const { svc } = setup();
  const { id, adminKey: key } = svc.createTournament({ name: 'Cup', format: 'knockout' });
  svc.addEntries(id, key, names(5));
  const t = svc.start(id, key);
  const ko = t.matches;
  assert.equal(ko.length, 7); // 8-draw: 4 + 2 + 1
  assert.equal(ko.filter((m) => m.status === 'bye').length, 3);
  const playable = ko.filter((m) => m.status === 'scheduled' && m.a && m.b);
  // Player 4 v Player 5 in R1; Player 2 v Player 3 already set in the semis via byes
  assert.deepEqual(playable.map((m) => `${m.roundName}: ${m.a.name} v ${m.b.name}`), [
    'Quarter-finals: Player 4 v Player 5',
    'Semi-finals: Player 2 v Player 3',
  ]);
  const semi = ko.find((m) => m.roundName === 'Semi-finals' && m.slot === 0);
  assert.equal(semi.a.name, 'Player 1');
  assert.equal(semi.b, null);
});

test('undo of a knockout win is blocked once the next match starts', () => {
  const { svc } = setup();
  const { id, adminKey: key } = svc.createTournament({ name: 'Cup', format: 'knockout' });
  svc.addEntries(id, key, names(4));
  const t = svc.start(id, key);
  const [s1, s2] = t.matches.filter((m) => m.round === 1);
  play(svc, id, key, s1.id);
  play(svc, id, key, s2.id);
  const final = svc.getTournament(id, key).matches.find((m) => m.round === 2);
  svc.rally(id, key, final.id, 'a');
  assert.throws(() => svc.undo(id, key, s1.id), /next-round match has already started/);
  svc.undo(id, key, final.id);
  const reopened = svc.undo(id, key, s1.id);
  assert.equal(reopened.status, 'live');
  const after = svc.getTournament(id, key).matches.find((m) => m.round === 2);
  assert.equal(after.a, null);
});

test('league only completes when all matches are played', () => {
  const { svc } = setup();
  const { id, adminKey: key } = svc.createTournament({
    name: 'Ladder',
    format: 'league',
    groups: 1,
    scoring: { bestOf: 1, points: 11, cap: 15 },
  });
  svc.addEntries(id, key, names(4));
  let t = svc.start(id, key);
  for (const m of t.matches) play(svc, id, key, m.id, 'a');
  t = svc.getTournament(id, key);
  assert.equal(t.status, 'completed');
  assert.equal(t.champion.name, t.groups[0].standings[0].name);
});

test('validation and permissions', () => {
  const { svc } = setup();
  assert.throws(() => svc.createTournament({ name: '  ' }), /required/);
  const { id, adminKey: key } = svc.createTournament({ name: 'X', groups: 2, qualifiers: 3 });
  assert.throws(() => svc.addEntries(id, 'wrong', ['A']), /organiser/);
  svc.addEntries(id, key, ['A', 'B', 'C']);
  assert.throws(() => svc.addEntries(id, key, ['a']), /already entered/);
  assert.throws(() => svc.start(id, key), /at least 4 entries/);
  svc.addEntries(id, key, ['D']);
  assert.throws(() => svc.start(id, key), /at most 2 can qualify/);
  svc.updateSettings(id, key, { qualifiers: 1 });
  const t = svc.start(id, key);
  assert.equal(t.status, 'league');
  assert.throws(() => svc.addEntries(id, key, ['E']), /locked/);
  assert.equal(svc.getTournament(id).isAdmin, false);
  assert.equal(svc.getTournament(id, key).isAdmin, true);
});

test('reorder entries sets the seeding', () => {
  const { svc } = setup();
  const { id, adminKey: key } = svc.createTournament({ name: 'X' });
  let t = svc.addEntries(id, key, ['A', 'B', 'C']);
  const ids = t.entries.map((e) => e.id).reverse();
  t = svc.reorderEntries(id, key, ids);
  assert.deepEqual(t.entries.map((e) => e.name), ['C', 'B', 'A']);
  assert.throws(() => svc.reorderEntries(id, key, ids.slice(1)), /every entry/);
});

test('HTTP API: auth, scoring and live stream', async () => {
  const { app } = setup();
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, key) => {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers['X-Admin-Key'] = key;
    const res = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
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

    // Open the live stream and check a rally is pushed to it.
    const ac = new AbortController();
    const stream = await fetch(`${base}/api/tournaments/${id}/stream`, { signal: ac.signal });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body.getReader();
    const got = (async () => {
      let buf = '';
      for (;;) {
        const { value } = await reader.read();
        buf += Buffer.from(value).toString();
        const line = buf.split('\n').find((l) => l.startsWith('data: '));
        if (line) return JSON.parse(line.slice(6));
      }
    })();
    const scored = await call('POST', `/api/tournaments/${id}/matches/${match.id}/rally`, { side: 'b' }, key);
    assert.equal(scored.status, 200);
    assert.deepEqual([scored.data.score.games[0].a, scored.data.score.games[0].b], [0, 1]);
    const event = await got;
    assert.equal(event.type, 'match');
    assert.equal(event.match.id, match.id);
    ac.abort();

    assert.equal((await call('POST', `/api/tournaments/${id}/matches/${match.id}/rally`, { side: 'x' }, key)).status, 400);
    assert.equal((await call('GET', '/api/tournaments/nope')).status, 404);
    assert.equal((await call('GET', '/api/tournaments')).data.length, 1);
    const page = await fetch(`${base}/t/whatever`);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
    assert.equal((await call('DELETE', `/api/tournaments/${id}`, undefined, key)).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
