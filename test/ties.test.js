'use strict';

// Team ties in racket sports: formats, sealed line-ups (captains or the
// organisers), the rubbers scored with the sport's rules, the tie decided
// when a side has a majority (or after every match, with "play all"), and
// the draw, standings and knockout working on ties unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const TIE = require('../public/sports/tie');

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
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@ties.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
const win = [{ a: 21, b: 10 }, { a: 21, b: 12 }];
const lose = [{ a: 10, b: 21 }, { a: 12, b: 21 }];

test('the tie rules: a majority decides it, or every match with play-all; formats and custom ones', () => {
  assert.deepEqual(TIE.rubbersOf({ format: '2s1d' }).map((r) => r.label), ['S1', 'S2', 'D']);
  assert.deepEqual(TIE.rubbersOf({ format: 'sudirman' }).map((r) => r.kind), ['singles', 'singles', 'doubles', 'doubles', 'doubles']);
  assert.equal(TIE.compute('aa', { format: '2s1d' }).winner, 'a');
  assert.equal(TIE.compute('ab', { format: '2s1d' }).winner, null);
  assert.equal(TIE.compute('aa', { format: '2s1d', playAll: true }).winner, null);
  assert.equal(TIE.compute('aab', { format: '2s1d', playAll: true }).winner, 'a');
  assert.equal(TIE.compute('abba', { format: '3s2d' }).winner, null);
  assert.equal(TIE.compute('abbab', { format: '3s2d' }).winner, 'b');
  assert.deepEqual(TIE.normalize({ format: 'custom', rubbers: ['singles', 'doubles', 'doubles'] }), { format: 'custom', rubbers: ['singles', 'doubles', 'doubles'], playAll: false });
  assert.throws(() => TIE.normalize({ format: 'custom', rubbers: ['singles', 'doubles'] }), /odd number/);
});

test('a badminton team event: sealed line-ups, rubbers, the tie decided and the knockout moving on', async () => {
  const org = await person('Tie Organiser');
  const cap = await person('Team Captain');
  const { id } = await svc.createTournament(org.actor, { name: 'Club Team Cup', format: 'knockout', events: [{ discipline: 'team', gender: 'men' }] });
  let t = await svc.getTournament(id, org.actor);
  assert.equal(t.events[0].name, 'Men\'s Team');
  const ev = t.events[0].id;
  // The tie format, set like any event setting.
  await svc.updateEvent(id, org.actor, ev, { tie: { format: '2s1d' } });
  await svc.addEntries(id, org.actor, ['Smashers', 'Drop Shots', 'Net Kings', 'Rally Club'], { event: ev });
  t = await svc.getTournament(id, org.actor);
  const roster = (team) => ['One', 'Two', 'Three'].map((x, i) => ({ name: `${team} ${x}`, ...(i === 0 && team === 'Smashers' && { email: cap.email, captain: true }) }));
  for (const e of t.entries) await svc.setEntryPlayers(id, org.actor, e.id, { players: roster(e.name) });
  await svc.start(id, org.actor);
  t = await svc.getTournament(id, org.actor);
  const m = t.matches.find((x) => x.round === 1 && x.a && x.b && (x.a.name === 'Smashers' || x.b.name === 'Smashers'));
  const smashers = m.a.name === 'Smashers' ? 'a' : 'b';
  const other = smashers === 'a' ? 'b' : 'a';
  // Ties are scored match by match, not as a whole.
  assert.equal((await org.call('POST', `/api/tournaments/${id}/matches/${m.id}/rally`, { side: 'a', at: 0 })).status, 409);
  let v = (await cap.call('GET', `/api/tournaments/${id}/matches/${m.id}/tie`)).data;
  assert.deepEqual(v.rubbers.map((r) => [r.label, r.status]), [['S1', 'waiting'], ['S2', 'waiting'], ['D', 'waiting']]);
  assert.equal(v.sides[smashers].canSet, true);
  assert.equal(v.sides[other].canSet, false);
  assert.equal(v.sides[other].roster, null, 'the captain doesn\'t see the other team\'s roster');
  // Line-up rules.
  const set = (who, side, slots) => who.call('PUT', `/api/tournaments/${id}/matches/${m.id}/tie/lineup`, { side, slots });
  assert.equal((await set(cap, other, [[0], [1], [0, 1]])).status, 403);
  assert.equal((await set(cap, smashers, [[0], [0], [1, 2]])).status, 400, 'one singles each');
  assert.equal((await set(cap, smashers, [[0], [1], [2]])).status, 400, 'doubles needs two');
  assert.equal((await set(cap, smashers, [[0], [9], [1, 2]])).status, 400, 'from the roster');
  v = (await set(cap, smashers, [[0], [1], [0, 2]])).data;
  assert.equal(v.sides[smashers].lineup, true);
  // Sealed: the organiser sees both; the other side's is hidden from the captain until both are in.
  v = (await set(org, other, [[1], [2], [0, 1]])).data;
  assert.deepEqual(v.rubbers.map((r) => [r.label, r.status]), [['S1', 'live'], ['S2', 'live'], ['D', 'live']]);
  v = (await cap.call('GET', `/api/tournaments/${id}/matches/${m.id}/tie`)).data;
  assert.deepEqual(v.rubbers[0][smashers], ['Smashers One']);
  assert.equal(v.rubbers[2][other].length, 2);
  assert.equal((await set(cap, smashers, [[1], [0], [0, 2]])).status, 409, 'no changes once they\'re out');
  // Score: S1 live point by point, S2 at the end; Smashers win 2–0 and the tie's decided.
  const sideWin = smashers === 'a' ? win : lose;
  const rubber = (k, what, body) => org.call('POST', `/api/tournaments/${id}/matches/${m.id}/tie/rubbers/${k}/${what}`, body);
  const pts = `${smashers.repeat(21)}`;
  for (let i = 0; i < 21; i++) v = (await rubber(0, 'rally', { side: pts[i], at: i })).data;
  assert.equal(v.rubbers[0].status, 'live', 'a best-of-3 game needs two games');
  v = (await rubber(0, 'undo', { at: 21 })).data;
  assert.equal(v.rubbers[0].rallies, 20);
  v = (await rubber(1, 'result', { games: sideWin })).data;
  assert.equal(v.rubbers[1].winner, smashers);
  assert.equal(v.status, 'live');
  // Finish S1 at the end instead (undo the live points first).
  for (let i = 20; i > 0; i--) v = (await rubber(0, 'undo', { at: i })).data;
  v = (await rubber(0, 'result', { games: sideWin })).data;
  assert.deepEqual([v.status, v.winner], ['done', smashers]);
  assert.equal((await rubber(2, 'result', { games: win })).status, 409, 'the tie is decided');
  t = await svc.getTournament(id, org.actor);
  const done = t.matches.find((x) => x.id === m.id);
  assert.equal(done.summary, '2–0');
  const final = t.matches.find((x) => x.round === 2 && (x.a || x.b));
  assert.ok([final.a && final.a.name, final.b && final.b.name].includes('Smashers'), 'the winner goes through');
});

test('play all, in a league: every match counts in the table', async () => {
  const org = await person('League Organiser');
  const { id } = await svc.createTournament(org.actor, { name: 'Team League', format: 'league', sport: 'table-tennis', events: [{ discipline: 'team', gender: 'open' }] });
  let t = await svc.getTournament(id, org.actor);
  const ev = t.events[0].id;
  await svc.updateEvent(id, org.actor, ev, { tie: { format: 'custom', rubbers: ['singles', 'singles', 'doubles'], playAll: true }, groups: 1 });
  await svc.addEntries(id, org.actor, ['Spinners', 'Choppers'], { event: ev });
  t = await svc.getTournament(id, org.actor);
  for (const e of t.entries) await svc.setEntryPlayers(id, org.actor, e.id, { players: [{ name: `${e.name} A` }, { name: `${e.name} B` }] });
  await svc.start(id, org.actor);
  t = await svc.getTournament(id, org.actor);
  const [m] = t.matches;
  const set = (side) => org.call('PUT', `/api/tournaments/${id}/matches/${m.id}/tie/lineup`, { side, slots: [[0], [1], [0, 1]] });
  await set('a');
  await set('b');
  const tt = [{ a: 11, b: 5 }, { a: 11, b: 6 }, { a: 11, b: 7 }];
  const ll = tt.map((g) => ({ a: g.b, b: g.a }));
  const rubber = (k, games) => org.call('POST', `/api/tournaments/${id}/matches/${m.id}/tie/rubbers/${k}/result`, { games });
  let v = (await rubber(0, tt)).data;
  v = (await rubber(1, tt)).data;
  assert.equal(v.status, 'live', 'play all: 2–0 isn\'t the end');
  v = (await rubber(2, ll)).data;
  assert.deepEqual([v.status, v.winner], ['done', 'a']);
  t = await svc.getTournament(id, org.actor);
  assert.equal(t.status, 'completed');
  const [g] = t.groups;
  assert.deepEqual(g.standings.map((r) => [r.name, r.won, r.gamesFor, r.gamesAgainst]), [['Spinners', 1, 2, 1], ['Choppers', 0, 1, 2]]);
});
