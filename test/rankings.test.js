'use strict';

// Player profiles, the people behind entries (partners by email, organiser
// links), results written when an event finishes, ranking tables, and DUPR.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const R = require('../server/rankings');
const dupr = require('../server/dupr');

test('finishes and points: knockout, league, draw size and categories', () => {
  // 8-player knockout: rounds 1 (QF), 2 (SF), 3 (final).
  const ko = (round, slot, a, b, w) => ({ stage: 'knockout', round, slot, a_id: a, b_id: b, winner_id: w, status: 'done' });
  const matches = [
    ko(1, 0, 1, 8, 1), ko(1, 1, 4, 5, 4), ko(1, 2, 3, 6, 3), ko(1, 3, 2, 7, 2),
    ko(2, 0, 1, 4, 1), ko(2, 1, 3, 2, 2), ko(3, 0, 1, 2, 2),
  ];
  const entries = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id }));
  const f = R.finishes({ format: 'knockout', entries, matches, knockoutRounds: 3 });
  assert.deepEqual([1, 2, 3, 4, 5].map((id) => f.get(id)), ['F', 'W', 'SF', 'SF', 'QF']);
  // League + knockout: players knocked out in the groups.
  const lk = R.finishes({ format: 'league_knockout', entries: [...entries, { id: 9 }], matches, knockoutRounds: 3 });
  assert.equal(lk.get(9), 'G');
  // League only, one group: the table decides.
  const lg = R.finishes({ format: 'league', entries: entries.slice(0, 4), matches: [], standings: [[3, 1, 4, 2]] });
  assert.deepEqual([3, 1, 4, 2].map((id) => lg.get(id)), ['W', 'F', 'SF', 'SF']);
  // Several groups: winners are semi-finalists, runners-up quarter-finalists.
  const lg2 = R.finishes({ format: 'league', entries, matches: [], standings: [[1, 2, 3, 4], [5, 6, 7, 8]] });
  assert.deepEqual([1, 2, 3, 5, 6].map((id) => lg2.get(id)), ['SF', 'QF', 'G', 'SF', 'QF']);
  // Points: finish × draw size; tiny events count for nothing.
  assert.deepEqual([R.pointsFor('W', 3), R.pointsFor('W', 4), R.pointsFor('W', 8), R.pointsFor('F', 16), R.pointsFor('SF', 40)], [0, 50, 100, 105, 90]);
  assert.deepEqual([
    R.categoryOf({ discipline: 'doubles', gender: 'mixed', age: 'U19' }),
    R.categoryOf({ discipline: 'singles', gender: 'men', age: 'Open' }),
    R.categoryOf({ discipline: 'singles', gender: 'men', age: '35+' }),
    R.categoryOf({ discipline: 'team', gender: 'men', age: 'Open' }),
    R.categoryOf({ discipline: 'any', gender: 'open', age: 'Open' }),
  ], ['xd-u19', 'ms', 'ms-35plus', null, null]);
  assert.equal(R.categoryName('ms-35plus', ['Open', '35+']), 'Men\'s Singles 35+');
  assert.equal(R.categoryName('zz'), null);
  // Records skip walkovers.
  const rec = R.records([...matches, { ...ko(1, 0, 5, 6, 5), walkover: true }]);
  assert.deepEqual(rec.get(2), { won: 3, lost: 0 });
  assert.deepEqual(rec.get(5), { won: 0, lost: 1 });
});

test('DUPR: IDs, ratings, entry ratings and the CSV', () => {
  const fail = (s, m) => { throw new Error(m); };
  assert.equal(dupr.checkId(' 4dge5w ', fail), '4DGE5W');
  assert.throws(() => dupr.checkId('x!', fail), /DUPR ID/);
  assert.equal(dupr.checkRating('3.5126', fail), 3.513);
  assert.equal(dupr.checkRating('', fail), null);
  assert.throws(() => dupr.checkRating('9', fail), /between/);
  assert.equal(dupr.entryRating([{ duprDoubles: 3.5 }, { duprDoubles: '3.25' }], 'doubles'), 6.75);
  assert.equal(dupr.entryRating([{ duprDoubles: 3.5 }, { duprDoubles: null }], 'doubles'), null);
  assert.equal(dupr.entryRating([{ duprSingles: 4.1 }], 'singles'), 4.1);
  const csv = dupr.csv([{ doubles: true, event: 'Open, "Final"', date: '2026-10-22', a: [{ name: 'A', duprId: 'AAA111' }, { name: '=B', duprId: 'BBB222' }], b: [{ name: 'C', duprId: '' }, { name: 'D', duprId: 'DDD444' }], games: [[11, 7], [9, 11], [11, 4]] }]);
  const [head, row] = csv.trim().split('\n');
  assert.ok(head.startsWith('matchType,scoreType,event,date,playerA1,playerA1DuprId'));
  assert.ok(row.startsWith('D,SIDEOUT,"Open, ""Final""",2026-10-22,A,AAA111,"\'=B",BBB222,C,,D,DDD444,11,7,9,11,11,4,,,,,yes'));
  assert.equal(dupr.enabled({}), false);
  assert.equal(dupr.enabled({ DUPR_CLIENT_ID: 'x', DUPR_CLIENT_SECRET: 'y' }), true);
});

// ---------- with a database

let db;
let app;
let svc;
let server;
let base;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  app = createApp(db, { mailer: { enabled: false, async send() { return {}; } } });
  svc = app.service;
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close?.();
});

let n = 0;
async function user(name, { city = null, region = null } = {}) {
  n += 1;
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${n}@rank.test`;
  const [row] = await db.query('INSERT INTO users (email, name, password_hash, city, region) VALUES ($1, $2, $3, $4, $5) RETURNING id', [email, name, 'x', city, region]);
  return { user: { id: row.id, email, name, isAdmin: false } };
}

// Plays every match until the event finishes: side a wins each match.
async function playOut(id, org, eventId) {
  for (let guard = 0; guard < 50; guard++) {
    const t = await svc.getTournament(id, org);
    const ev = t.events.find((e) => e.id === eventId);
    if (ev.status === 'completed') return t;
    const m = ev.matches.find((x) => x.a && x.b && x.status !== 'done' && x.status !== 'bye');
    if (!m) throw new Error(`stuck in ${ev.status}`);
    for (let i = 0; i < 11; i++) await svc.rally(id, org, m.id, 'a');
  }
  throw new Error('never finished');
}

async function doublesTournament(org, { name, visibility = 'public', sport = 'table-tennis', format = 'knockout', gender = 'men', extra = {} } = {}) {
  const { id } = await svc.createTournament(org, {
    name, sport, format, scoring: sport === 'table-tennis' ? { bestOf: 1, points: 11 } : { bestOf: 1, points: 11, scoring: 'rally' },
    events: [{ discipline: 'doubles', gender }], ...extra,
  });
  await svc.setVisibility(id, org, visibility);
  const t = await svc.getTournament(id, org);
  return { id, eventId: t.events[0].id };
}

test('partners by email, results on both profiles, rankings, private and link-only excluded', async () => {
  const org = await user('Organiser One');
  const players = [];
  for (const [nm, city] of [['Asha Rao', 'Chennai'], ['Bala K', 'Chennai'], ['Chitra S', 'Madurai'], ['Dev P', 'Chennai'], ['Esha M', 'Chennai'], ['Farid A', 'Madurai'], ['Gita R', 'Chennai'], ['Hari V', 'Chennai']]) {
    players.push(await user(nm, { city, region: 'Tamil Nadu' }));
  }
  const { id, eventId } = await doublesTournament(org, { name: 'Chennai Doubles Open' });
  // Pairs: Asha + Bala, Chitra + Dev, Esha + Farid, Gita + (not signed up yet).
  const late = 'late.partner@rank.test';
  const pairs = [[0, 1], [2, 3], [4, 5], [6, null]];
  for (const [a, b] of pairs) {
    await svc.register(id, players[a], { event: eventId, partner: b == null ? 'Late Partner' : players[b].user.name, partnerEmail: b == null ? late : players[b].user.email });
  }
  await assert.rejects(svc.register(id, players[7], { event: eventId, partner: 'Me', partnerEmail: players[7].user.email }), /your own email/);
  // The partner sees the entry under their entries.
  const bala = await svc.myEntries(players[1]);
  assert.equal(bala.length, 1);
  assert.equal(bala[0].entry.name, 'Asha Rao / Bala K');
  // Entries show the people, organisers see their emails.
  let t = await svc.getTournament(id, org);
  const asha = t.events[0].entries.find((e) => e.name.startsWith('Asha'));
  assert.deepEqual(asha.people.map((p) => [p.name, p.email, p.linked]), [['Asha Rao', players[0].user.email, true], ['Bala K', players[1].user.email, true]]);
  const pub = await svc.getTournament(id, null);
  assert.equal(pub.events[0].entries[0].people[0].email, undefined);

  await svc.start(id, org, { event: eventId });
  t = await playOut(id, org, eventId);
  const winner = t.events[0].champion.name;
  assert.equal(winner, 'Asha Rao / Bala K'); // seed 1, side a always wins

  // Both partners have the result; 4 entries × W = 50 points.
  const rows = await db.query('SELECT email, finish, points, won, lost FROM event_results WHERE event_id = $1 ORDER BY points DESC, email', [eventId]);
  assert.equal(rows.length, 8); // Gita's partner has no account yet but the row waits for them
  const of = (p) => rows.find((r) => r.email === p.user.email);
  assert.deepEqual([of(players[0]).finish, of(players[0]).points, of(players[1]).finish, of(players[0]).won], ['W', 50, 'W', 2]);
  assert.equal(rows.find((r) => r.email === late).finish, 'SF');

  // Profiles and rankings.
  const me = await svc.players.myProfile(players[1]);
  assert.equal(me.handle, 'bala-k');
  assert.equal(me.results[0].finish, 'W');
  assert.equal(me.results[0].matches.length, 2);
  assert.ok(me.results[0].matches[0].score);
  const prof = await svc.players.profile('bala-k');
  assert.equal(prof.rankings[0].category, 'md');
  assert.equal(prof.rankings[0].rank, 1);
  assert.equal(prof.records[0].titles, 1);
  let table = await svc.players.table('table-tennis', 'md');
  assert.equal(table.players[0].points, 50);
  assert.equal(table.players.filter((p) => p.points === 50).length, 2);
  assert.ok(table.players.every((p) => p.rank));
  assert.ok(!table.players.some((p) => p.name === 'Late Partner'));
  // By city.
  const madurai = await svc.players.table('table-tennis', 'md', { city: 'Madurai' });
  assert.deepEqual(madurai.players.map((p) => p.name).sort(), ['Chitra S', 'Farid A']);
  assert.equal(madurai.players.find((p) => p.name === 'Chitra S').rank, 1); // runner-up beats a semi-finalist

  // The late partner signs up with that email and has the result straight away.
  const [{ id: lateId }] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ($1, 'Late Partner', 'x') RETURNING id`, [late]);
  const lateProfile = await svc.players.myProfile({ user: { id: lateId, email: late, name: 'Late Partner' } });
  assert.equal(lateProfile.results[0].finish, 'SF');

  // A private profile drops out of the rankings and its page 404s for others.
  await svc.players.updateProfile(players[0], { public: false });
  table = await svc.players.table('table-tennis', 'md');
  assert.ok(!table.players.some((p) => p.name === 'Asha Rao'));
  assert.equal(await svc.players.profile('asha-rao'), null);
  assert.ok(await svc.players.profile('asha-rao', players[0]));
  await svc.players.updateProfile(players[0], { public: true });

  // Undoing the final's last point takes the results away again.
  t = await svc.getTournament(id, org);
  const final = t.events[0].matches.find((m) => m.stage === 'knockout' && m.round === t.events[0].config.knockoutRounds);
  await svc.undo(id, org, final.id);
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM event_results WHERE event_id = $1', [eventId]))[0].n, 0);
  await svc.rally(id, org, final.id, 'a');
  assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM event_results WHERE event_id = $1', [eventId]))[0].n, 8);

  // "Counts for rankings" off: still on profiles, no points.
  await svc.updateSettings(id, org, { event: eventId, ranked: false });
  assert.equal((await db.query('SELECT MAX(points)::int AS p FROM event_results WHERE event_id = $1', [eventId]))[0].p, 0);
  assert.equal((await svc.players.table('table-tennis', 'md')).total, 0);
  await svc.updateSettings(id, org, { event: eventId, ranked: true });
  assert.equal((await svc.players.table('table-tennis', 'md')).players[0].points, 50);

  // Link-only tournaments don't count, and aren't on public profiles.
  await svc.setVisibility(id, org, 'link');
  assert.equal((await svc.players.table('table-tennis', 'md')).total, 0);
  assert.equal((await svc.players.profile('bala-k')).results.length, 0);
  assert.equal((await svc.players.myProfile(players[1])).results.length, 1); // still yours to see
  await svc.setVisibility(id, org, 'public');

  // "That's not me" takes a partner off an entry (not the person who entered).
  const gita = (await svc.players.myProfile(players[6])).results[0];
  await assert.rejects(svc.players.notMe(players[6], (await db.query('SELECT entry_id FROM event_results WHERE event_id = $1 AND email = $2', [gita.eventId, players[6].user.email]))[0].entry_id), /withdraw/);
  const balaEntry = (await db.query('SELECT entry_id FROM event_results WHERE email = $1', [players[1].user.email]))[0].entry_id;
  const after = await svc.players.notMe(players[1], balaEntry);
  assert.equal(after.results.length, 0);
});

test('organisers link players; drawn pairs carry both players; handles', async () => {
  const org = await user('Organiser Two');
  const p1 = await user('Kiran Das');
  const p2 = await user('Kiran Das'); // same name: kiran-das-2
  const { id, eventId } = await doublesTournament(org, { name: 'Walk-in Doubles', gender: 'open' });
  await svc.addEntries(id, org, ['Kiran Das / Lata M', 'Mo / Nia'], { event: eventId });
  let t = await svc.getTournament(id, org);
  const e = t.events[0].entries[0];
  await svc.setEntryPlayers(id, org, e.id, { players: [{ email: p1.user.email }, { name: 'Lata M', email: 'lata@rank.test' }] });
  t = await svc.getTournament(id, org);
  assert.deepEqual(t.events[0].entries[0].people.map((p) => [p.name, p.linked]), [['Kiran Das', true], ['Lata M', false]]);
  await assert.rejects(svc.setEntryPlayers(id, p2, e.id, { players: [] }), /permission|organis|Only/i);
  await assert.rejects(svc.setEntryPlayers(id, org, e.id, { players: [{ email: 'bad' }] }), /valid email/);
  assert.equal((await svc.players.myProfile(p1)).handle, 'kiran-das');
  assert.equal((await svc.players.myProfile(p2)).handle, 'kiran-das-2');
  await assert.rejects(svc.players.updateProfile(p2, { handle: 'kiran-das' }), /taken/);
  await assert.rejects(svc.players.updateProfile(p2, { handle: 'admin' }), /reserved/);
  assert.equal((await svc.players.updateProfile(p2, { handle: 'Kiran D 2', city: 'Pune', sports: ['badminton', 'nope'], bio: 'Hi' })).handle, 'kiran-d-2');

  // Drawn partners: each solo entry is its player; the pair gets both.
  const { id: did, eventId: dev } = await doublesTournament(org, { name: 'Drawn Doubles', gender: 'open' });
  await svc.updateSettings(did, org, { event: dev, partners: 'drawn' });
  const solos = [await user('Ravi'), await user('Sam'), await user('Omar'), await user('Pia')];
  for (const s of solos) await svc.register(did, s, { event: dev });
  await svc.drawPairs(did, org, { event: dev });
  t = await svc.getTournament(did, org);
  const pair = t.events[0].entries.find((x) => x.source === 'drawn');
  assert.equal(pair.people.length, 2);
  assert.ok(pair.people.every((p) => p.linked));
});

test('DUPR in pickleball: required IDs, rating limits, seed by rating, the CSV', async () => {
  const org = await user('Pickle Org');
  const { id, eventId } = await doublesTournament(org, { name: 'Pickle Open', sport: 'pickleball', gender: 'open' });
  await assert.rejects(svc.updateSettings((await doublesTournament(org, { name: 'TT' })).id, org, { dupr: 'required' }), /pickleball/);
  await svc.updateSettings(id, org, { event: eventId, dupr: 'required', duprMin: 3, duprMax: 8 });
  const a = await user('Ann'); const b = await user('Bo'); const c = await user('Cy'); const d = await user('Di');
  await assert.rejects(svc.register(id, a, { event: eventId, partner: 'Bo', partnerEmail: b.user.email }), /needs your DUPR ID/);
  await assert.rejects(svc.register(id, a, { event: eventId, partner: 'Bo', partnerEmail: b.user.email, duprId: 'ANN111' }), /partner's DUPR ID/);
  await assert.rejects(svc.register(id, a, { event: eventId, partner: 'Bo', partnerEmail: b.user.email, duprId: 'ANN111', partnerDuprId: 'BO2222' }), /add your doubles rating/);
  await svc.players.updateProfile(a, { duprDoubles: 2.5 });
  await assert.rejects(svc.register(id, a, { event: eventId, partner: 'Bo', partnerEmail: b.user.email, duprId: 'ANN111', partnerDuprId: 'BO2222' }), /rating is 2.50/);
  await svc.players.updateProfile(a, { duprDoubles: 3.2 });
  await svc.players.updateProfile(b, { duprId: 'BO2222', duprDoubles: 3.4 });
  await svc.register(id, a, { event: eventId, partner: 'Bo', partnerEmail: b.user.email, duprId: 'ANN111' });
  assert.equal((await svc.players.myProfile(a)).dupr.id, 'ANN111'); // saved to the profile
  await svc.players.updateProfile(c, { duprId: 'CY3333', duprDoubles: 4.5 });
  await svc.players.updateProfile(d, { duprId: 'DI4444', duprDoubles: 4.25 });
  await svc.register(id, c, { event: eventId, partner: 'Di', partnerEmail: d.user.email });
  // Organiser adds two more pairs without ratings.
  await svc.addEntries(id, org, ['Ed / Flo', 'Gus / Hal'], { event: eventId });
  let t = await svc.getTournament(id, org);
  assert.equal(t.events[0].entries.find((e) => e.name === 'Cy / Di').rating, 8.75);
  assert.equal(t.events[0].entries.find((e) => e.name === 'Ann / Bo').people[1].dupr.id, 'BO2222');
  t = await svc.seedByDupr(id, org, { event: eventId });
  assert.deepEqual(t.events[0].entries.map((e) => e.name), ['Cy / Di', 'Ann / Bo', 'Ed / Flo', 'Gus / Hal']);
  await assert.rejects(svc.seedByDupr((await doublesTournament(org, { name: 'TT2' })).id, org), /pickleball/);
  // Profile ratings must be in range; verified ratings can't be typed over.
  await assert.rejects(svc.players.updateProfile(a, { duprSingles: 1 }), /between/);

  await svc.start(id, org, { event: eventId });
  await playOut(id, org, eventId);
  const { csv, missing, matches } = await svc.duprCsv(id, org, { event: eventId });
  assert.equal(matches, 3);
  assert.equal(missing, 2); // the two matches with unrated organiser-added pairs
  assert.ok(csv.includes('Cy,CY3333,Di,DI4444'));
  await assert.rejects(svc.duprCsv(id, a, { event: eventId }), /organisers/);
});

test('HTTP: profile and ranking pages, the profile API, the sitemap', async () => {
  const get = (p, init) => fetch(base + p, init);
  let res = await get('/p/chitra-s');
  assert.equal(res.status, 200);
  let html = await res.text();
  assert.ok(html.includes('"@type":"Person"'));
  assert.ok(html.includes('Chennai Doubles Open'));
  assert.equal((await get('/p/nobody-here')).status, 404);
  res = await get('/rankings');
  html = await res.text();
  assert.ok(html.includes('/rankings/table-tennis'));
  html = await (await get('/rankings/table-tennis')).text();
  assert.ok(html.includes('Men&#39;s Doubles'));
  res = await get('/rankings/table-tennis/md?city=Madurai');
  html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes('Chitra S'));
  assert.ok(!html.includes('Bala K'));
  assert.ok(html.includes('"@type":"ItemList"'));
  assert.equal((await get('/rankings/table-tennis/zz')).status, 404);
  assert.equal((await get('/rankings/nosport')).status, 404);
  const map = await (await get('/sitemap.xml')).text();
  assert.ok(map.includes('/p/chitra-s'));
  assert.ok(map.includes('/rankings/table-tennis/md'));
  // The profile API needs a session.
  assert.equal((await get('/api/me/profile')).status, 401);
  const signup = await get('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'Web Player', email: 'web@rank.test', password: 'password123' }) });
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const me = await (await get('/api/me/profile', { headers: { cookie } })).json();
  assert.equal(me.handle, 'web-player');
  res = await get('/api/me/profile', { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ city: 'Kochi', duprId: 'web123' }) });
  assert.equal((await res.json()).dupr.id, 'WEB123');
  // A private profile: 404 for others, visible to its owner with ?me=1.
  await get('/api/me/profile', { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ public: false }) });
  assert.equal((await get('/p/web-player')).status, 404);
  res = await get('/p/web-player?me=1', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok((await res.text()).includes('noindex'));
});

test('DUPR API (once keys exist): connect verifies ratings; finished matches are sent; off by default', async () => {
  const sent = [];
  let failNext = false;
  const fetchImpl = async (url, init = {}) => {
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith('/auth/v1.0/token')) return json(200, { token: 'tok' });
    let m = url.match(/\/player\/v1\.0\/([A-Z0-9]+)$/);
    if (m) return m[1] === 'NOPE00' ? json(404, { message: 'Not found' }) : json(200, { result: { fullName: m[1], ratings: { doubles: 3.75, singles: 3.6 } } });
    if (url.endsWith('/match/v1.0/create')) {
      if (failNext) { failNext = false; return json(500, { message: 'DUPR down' }); }
      sent.push(JSON.parse(init.body));
      return json(200, { result: { id: `dm${sent.length}` } });
    }
    return json(404, {});
  };
  const own = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  const s = createApp(own, { mailer: { enabled: false, async send() { return {}; } }, fetchImpl }).service;
  const mk = async (name) => {
    const email = `${name.toLowerCase()}@dupr.test`;
    const [r] = await own.query('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, name, 'x']);
    return { user: { id: r.id, email, name, isAdmin: false } };
  };
  const admin = { user: { id: 0, email: 'root@dupr.test', name: 'Root', isAdmin: true } };
  const org = await mk('Org');
  const ps = [await mk('Ann'), await mk('Ben'), await mk('Cat'), await mk('Dan')];
  // Without keys: connecting is unavailable and nothing is sent.
  await assert.rejects(s.connectDupr(ps[0], { duprId: 'ANN111' }), /isn't connected/);
  const saved = { id: process.env.DUPR_CLIENT_ID, secret: process.env.DUPR_CLIENT_SECRET };
  process.env.DUPR_CLIENT_ID = 'cid';
  process.env.DUPR_CLIENT_SECRET = 'csecret';
  try {
    await assert.rejects(s.connectDupr(ps[0], { duprId: 'NOPE00' }), /didn't recognise/);
    for (const [i, p] of ps.entries()) await s.connectDupr(p, { duprId: `P${i}AAAA` });
    const prof = await s.players.myProfile(ps[0]);
    assert.deepEqual([prof.dupr.verified, prof.dupr.doubles], [true, 3.75]);
    await assert.rejects(s.players.updateProfile(ps[0], { duprDoubles: 5 }), /come from DUPR/);

    const { id } = await s.createTournament(org, { name: 'Rated Pickle', sport: 'pickleball', format: 'knockout', scoring: { bestOf: 1, points: 11, scoring: 'rally' }, events: [{ discipline: 'singles', gender: 'open' }] });
    await s.setVisibility(id, org, 'public');
    for (const p of ps) await s.register(id, p, {});
    await s.start(id, org);
    let t = await s.getTournament(id, org);
    const first = t.matches.find((x) => x.a && x.b && x.stage === 'knockout');
    for (let i = 0; i < 11; i++) await s.rally(id, org, first.id, 'a');
    assert.equal(sent.length, 0); // the admin hasn't switched sending on
    await s.setAdminSettings(admin, { duprSubmit: true });
    const second = (await s.getTournament(id, org)).matches.find((x) => x.a && x.b && x.stage === 'knockout' && x.status !== 'done');
    failNext = true;
    for (let i = 0; i < 11; i++) await s.rally(id, org, second.id, 'a');
    let q = await s.adminDupr(admin);
    assert.deepEqual(q.submissions.map((x) => [x.matchId, x.status]), [[second.id, 'failed']]);
    assert.equal((await s.adminDuprRetry(admin, second.id)).status, 'sent');
    assert.equal((await s.adminDuprRetry(admin, first.id)).status, 'sent'); // sent late, once switched on
    assert.equal(sent.length, 2);
    assert.equal(sent[0].format, 'SINGLES');
    assert.deepEqual(sent[0].games, [{ teamA: 11, teamB: 0 }]);
    assert.ok(sent[0].teamA.player1.startsWith('P'));
    q = await s.adminDupr(admin);
    assert.ok(q.submissions.every((x) => x.status === 'sent'));
    // An unverified player means the match isn't sent.
    await s.disconnectDupr(ps[0]);
    t = await s.getTournament(id, org);
    const final = t.matches.find((x) => x.a && x.b && x.status !== 'done');
    for (let i = 0; i < 11; i++) await s.rally(id, org, final.id, 'a');
    await assert.rejects(s.adminDuprRetry(admin, final.id), /can't be sent/);
    await assert.rejects(s.adminDupr(ps[1]), /admins/i);
  } finally {
    process.env.DUPR_CLIENT_ID = saved.id ?? '';
    process.env.DUPR_CLIENT_SECRET = saved.secret ?? '';
    if (saved.id === undefined) delete process.env.DUPR_CLIENT_ID;
    if (saved.secret === undefined) delete process.env.DUPR_CLIENT_SECRET;
    await own.close?.();
  }
});
