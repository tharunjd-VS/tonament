'use strict';

// Groups (daily play) and sign-in links: sessions from the schedule, RSVP
// and waitlist, check-in, fair next-game suggestions, live scoring by the
// players, confirmation by the losing side, ratings and the leaderboard.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const L = require('../server/group-logic');

test('schedule: next sessions in the group\'s time zone', () => {
  // Wed 22 Oct 2026, 20:00 IST = 14:30 UTC. Mon–Sat at 06:00 IST.
  const now = new Date('2026-10-22T14:30:00Z');
  const s = L.upcomingStarts({ days: [1, 2, 3, 4, 5, 6], time: '06:00', timeZone: 'Asia/Kolkata' }, now, { count: 2, hours: 3 });
  assert.deepEqual(s.map((d) => d.toISOString()), ['2026-10-23T00:30:00.000Z', '2026-10-24T00:30:00.000Z']);
  // During a session it's still the current one; Sunday is skipped.
  const during = L.upcomingStarts({ days: [6, 1], time: '06:00', timeZone: 'Asia/Kolkata' }, new Date('2026-10-24T02:00:00Z'), { count: 2, hours: 3 });
  assert.deepEqual(during.map((d) => d.toISOString()), ['2026-10-24T00:30:00.000Z', '2026-10-26T00:30:00.000Z']);
  assert.deepEqual(L.upcomingStarts({ days: [] }, now), []);
});

test('suggestions: fewest games first, balanced teams, no repeat partners, swap', () => {
  const p = (id, rating, games = 0, waitingSince = id, partners = []) => ({ id, rating, games, waitingSince, partners: new Set(partners) });
  // Strong 1 & 2, weak 3 & 4: balanced is 1+4 v 2+3 (or 1+3 v 2+4).
  let s = L.suggest([p(1, 1400), p(2, 1350), p(3, 900), p(4, 950), p(5, 1000, 2)]);
  const sum = (ids, all) => ids.reduce((t, id) => t + all.find((x) => x.id === id).rating, 0);
  const all = [p(1, 1400), p(2, 1350), p(3, 900), p(4, 950)];
  assert.ok(Math.abs(sum(s.a, all) - sum(s.b, all)) <= 100, JSON.stringify(s));
  assert.ok(![...s.a, ...s.b].includes(5)); // played more already
  // Today's partners aren't repeated when ratings are equal.
  s = L.suggest([p(1, 1000, 0, 1, [2]), p(2, 1000, 0, 2, [1]), p(3, 1000), p(4, 1000)]);
  assert.ok(!(s.a.includes(1) && s.a.includes(2)) && !(s.b.includes(1) && s.b.includes(2)));
  // "Someone else" swaps in the next person waiting.
  const five = [p(1, 1000), p(2, 1000), p(3, 1000), p(4, 1000), p(5, 1000)];
  assert.ok([...L.suggest(five, { skip: 1 }).a, ...L.suggest(five, { skip: 1 }).b].includes(5));
  assert.equal(L.suggest([p(1, 1000), p(2, 1000), p(3, 1000)]), null);
  assert.deepEqual(L.suggest([p(1, 1000), p(2, 1000), p(3, 1000)], { singles: true }), { a: [1], b: [2] });
  // Over a morning of 10 players and 2 courts, everyone plays about the same.
  const games = new Map();
  for (let round = 0; round < 15; round++) {
    const free = Array.from({ length: 10 }, (_, i) => p(i + 1, 1000 + i * 30, games.get(i + 1) || 0, round * 100 + i));
    const g = L.suggest(free);
    for (const id of [...g.a, ...g.b]) games.set(id, (games.get(id) || 0) + 1);
  }
  const counts = [...games.values()];
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, counts.join());
});

test('ratings: upsets move more, new players move faster', () => {
  const even = L.rate([{ id: 1, rating: 1000, games: 20 }, { id: 2, rating: 1000, games: 20 }], [{ id: 3, rating: 1000, games: 20 }, { id: 4, rating: 1000, games: 20 }], 'a');
  assert.deepEqual(even, { 1: 10, 2: 10, 3: -10, 4: -10 });
  const upset = L.rate([{ id: 1, rating: 900, games: 20 }], [{ id: 2, rating: 1200, games: 20 }], 'a');
  assert.ok(upset[1] > 15 && upset[2] < -15);
  const fresh = L.rate([{ id: 1, rating: 1000, games: 0 }], [{ id: 2, rating: 1000, games: 0 }], 'a');
  assert.equal(fresh[1], 16);
  assert.ok(L.rate([{ id: 1, rating: 1000, games: 20 }], [{ id: 2, rating: 1000, games: 20 }], 'a', 15)[1] > 10); // big margin
});

let db;
let svc;
let server;
let base;
let mails = [];
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  process.env.APP_URL = 'https://tonament.example';
  const app = createApp(db, { mailer: { enabled: true, async send(m) { mails.push(m); return {}; } } });
  svc = app.service;
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close?.();
  delete process.env.APP_URL;
});

let n = 0;
async function user(name, { admin = false } = {}) {
  n += 1;
  const email = `${name.toLowerCase().replace(/\W+/g, '.')}.${n}@group.test`;
  const [row] = await db.query('INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id', [email, name, 'x']);
  return { user: { id: row.id, email, name, isAdmin: admin } };
}

// Today's session at "now": a schedule for every day, starting an hour ago.
function nowSchedule() {
  const t = new Date(Date.now() - 3600000);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
  return { days: [0, 1, 2, 3, 4, 5, 6], time: parts, timeZone: 'Asia/Kolkata', hours: 3 };
}

test('groups: create, invite link, requests, roles, privacy', async () => {
  const asha = await user('Asha');
  const ravi = await user('Ravi');
  const stranger = await user('Stranger');
  await assert.rejects(svc.groups.createGroup(null, { name: 'X', sport: 'badminton' }), /Sign in/);
  await assert.rejects(svc.groups.createGroup(asha, { name: 'X', sport: 'chess' }), /sport/);
  const { slug } = await svc.groups.createGroup(asha, { name: 'Morning Smashers', sport: 'badminton', city: 'Chennai', venue: 'SDAT', courts: 2, ...nowSchedule() });
  assert.equal(slug, 'morning-smashers');
  const { slug: slug2 } = await svc.groups.createGroup(ravi, { name: 'Morning Smashers', sport: 'badminton' });
  assert.equal(slug2, 'morning-smashers-2');
  let g = await svc.groups.view(slug, asha);
  assert.equal(g.admin, true);
  assert.ok(g.invite && g.session);
  // Outsiders see only the basics.
  const outside = await svc.groups.view(slug, stranger);
  assert.equal(outside.member, false);
  assert.equal(outside.invite, undefined);
  assert.equal(outside.session, undefined);
  // Wrong token = a request; the admin approves. The right token joins instantly.
  assert.deepEqual(await svc.groups.join(slug, stranger, { token: 'nope' }), { joined: false });
  assert.equal((await svc.groups.view(slug, stranger)).role, 'requested');
  await assert.rejects(svc.groups.rsvp(slug, stranger, g.session.id, 'in'), /Join the group/);
  g = await svc.groups.view(slug, asha);
  assert.equal(g.requests.length, 1);
  await svc.groups.setMember(slug, asha, stranger.user.id, 'approve');
  assert.deepEqual(await svc.groups.join(slug, ravi, { token: g.invite }), { joined: true });
  await assert.rejects(svc.groups.setMember(slug, ravi, stranger.user.id, 'remove'), /admins/);
  await assert.rejects(svc.groups.setMember(slug, asha, asha.user.id, 'member'), /at least one admin/);
  await assert.rejects(svc.groups.leave(slug, asha), /someone else an admin/);
  await svc.groups.setMember(slug, asha, ravi.user.id, 'admin');
  await svc.groups.leave(slug, asha);
  assert.equal((await svc.groups.view(slug, ravi)).members, 2);
  const mine = await svc.groups.myGroups(ravi);
  assert.deepEqual(mine.map((x) => [x.slug, x.role]).sort(), [['morning-smashers', 'admin'], ['morning-smashers-2', 'admin']]);
  // A new invite link stops the old one working.
  await svc.groups.updateGroup(slug, ravi, { newInvite: true });
  const late = await user('Late');
  assert.deepEqual(await svc.groups.join(slug, late, { token: g.invite }), { joined: false });
});

test('a morning: RSVP and waitlist, check-in, suggestion, live scoring, confirm, ratings', async () => {
  const admin = await user('Admin');
  const { slug } = await svc.groups.createGroup(admin, { name: 'Velachery Doubles', sport: 'badminton', courts: 2, maxPlayers: 5, scoring: { bestOf: 1, points: 11 }, ...nowSchedule() });
  const { invite } = await svc.groups.view(slug, admin);
  const ps = [];
  for (const name of ['Bala', 'Chitra', 'Dev', 'Esha', 'Farid']) {
    const p = await user(name);
    await svc.groups.join(slug, p, { token: invite });
    ps.push(p);
  }
  let g = await svc.groups.view(slug, admin);
  const sid = g.session.id;
  // RSVP: 5 places, the 6th waits; someone drops out and the waitlist moves up.
  await svc.groups.rsvp(slug, admin, sid, 'in');
  for (const p of ps) await svc.groups.rsvp(slug, p, sid, 'in');
  g = await svc.groups.view(slug, admin);
  assert.equal(g.session.players.filter((x) => x.status === 'in').length, 5);
  assert.equal(g.session.players.find((x) => x.id === ps[4].user.id).status, 'waitlist');
  await svc.groups.rsvp(slug, ps[0], sid, 'out');
  g = await svc.groups.view(slug, admin);
  assert.equal(g.session.players.find((x) => x.id === ps[4].user.id).status, 'in');
  // Back in: waitlisted now.
  await svc.groups.rsvp(slug, ps[0], sid, 'in');
  // Not checked in: can't start games, no suggestion yet.
  assert.equal(g.session.suggestion, null);
  await assert.rejects(svc.groups.startGame(slug, ps[1], sid, { court: 1, a: [1, 2], b: [3, 4] }), /Check in/);
  for (const p of [ps[1], ps[2], ps[3], ps[4]]) await svc.groups.checkIn(slug, p, sid, true);
  await svc.groups.checkIn(slug, admin, sid, true, ps[0].user.id); // admin checks someone in
  g = await svc.groups.view(slug, ps[1]);
  const sug = g.session.suggestion;
  assert.equal(sug.a.length + sug.b.length, 4);
  // Start the suggestion on court 1.
  const { id: gid } = await svc.groups.startGame(slug, ps[1], sid, { court: 1, a: sug.a.map((x) => x.id), b: sug.b.map((x) => x.id) });
  await assert.rejects(svc.groups.startGame(slug, ps[1], sid, { court: 1, a: [1], b: [2] }), /busy|Pick/);
  g = await svc.groups.view(slug, ps[1]);
  assert.equal(g.session.courts[0].gameId, gid);
  assert.equal(g.session.suggestion, null); // only one free player left
  const players = [...sug.a, ...sug.b].map((x) => x.id);
  const playerActor = [admin, ...ps].find((p) => p.user.id === sug.a[0].id);
  const outsider = [admin, ...ps].find((p) => !players.includes(p.user.id) && p !== admin);
  // Only the players (or an admin) score; `at` stops double counting.
  await assert.rejects(svc.groups.rally(slug, outsider, gid, 'a', 0), /players in this game/);
  let x = await svc.groups.rally(slug, playerActor, gid, 'a', 0);
  assert.equal(x.rallies, 1);
  await assert.rejects(svc.groups.rally(slug, playerActor, gid, 'a', 0), /same time/);
  x = await svc.groups.undo(slug, playerActor, gid, 1);
  assert.equal(x.rallies, 0);
  for (let i = 0; i < 11; i++) x = await svc.groups.rally(slug, playerActor, gid, 'a', i);
  assert.equal(x.status, 'done');
  assert.equal(x.winner, 'a');
  assert.equal(x.summary, '11-0');
  // The winners can't confirm their own win; the losers can.
  await assert.rejects(svc.groups.confirm(slug, playerActor, gid), /other side/);
  const loser = [admin, ...ps].find((p) => p.user.id === sug.b[0].id);
  x = await svc.groups.confirm(slug, loser, gid);
  assert.equal(x.status, 'confirmed');
  assert.ok(x.deltas[sug.a[0].id] > 0 && x.deltas[sug.b[0].id] < 0);
  g = await svc.groups.view(slug, admin);
  const top = g.leaderboard[0];
  assert.ok(sug.a.some((p) => p.id === top.id));
  assert.equal(top.rank, 1);
  assert.equal(top.week.wins, 1);
  assert.equal(top.provisional, true);
  // The court is free again and the next suggestion includes the player who sat out.
  const waiting = g.session.waiting.find((w) => w.games === 0);
  assert.ok(g.session.suggestion.a.concat(g.session.suggestion.b).some((p) => p.id === waiting.id));

  // Quick result + dispute + admin void (rating reversed).
  const s2 = g.session.suggestion;
  const { id: gid2 } = await svc.groups.startGame(slug, admin, sid, { court: 2, a: s2.a.map((p) => p.id), b: s2.b.map((p) => p.id) });
  const scorer = [admin, ...ps].find((p) => p.user.id === s2.a[0].id);
  await assert.rejects(svc.groups.setResult(slug, scorer, gid2, { a: 11, b: 11 }), /Enter both/);
  x = await svc.groups.setResult(slug, scorer, gid2, { a: 9, b: 11 });
  assert.deepEqual([x.status, x.winner, x.summary], ['done', 'b', '9–11']);
  const loser2 = [admin, ...ps].find((p) => p.user.id === s2.a[1].id);
  x = await svc.groups.dispute(slug, loser2, gid2);
  assert.equal(x.status, 'disputed');
  await assert.rejects(svc.groups.confirm(slug, loser2, gid2), /admin settles/);
  const before = (await svc.groups.view(slug, admin)).leaderboard.map((r) => [r.id, r.rating, r.games]);
  x = await svc.groups.confirm(slug, admin, gid2);
  assert.equal(x.status, 'confirmed');
  x = await svc.groups.voidGame(slug, admin, gid2);
  assert.equal(x.status, 'void');
  const after = (await svc.groups.view(slug, admin)).leaderboard.map((r) => [r.id, r.rating, r.games]);
  assert.deepEqual(after.sort(), before.sort());

  // Unconfirmed results confirm themselves after 10 minutes.
  g = await svc.groups.view(slug, admin);
  const s3 = g.session.suggestion;
  const { id: gid3 } = await svc.groups.startGame(slug, admin, sid, { court: 2, a: s3.a.map((p) => p.id), b: s3.b.map((p) => p.id) });
  await svc.groups.setResult(slug, admin, gid3, { a: 11, b: 7 });
  await db.query(`UPDATE group_games SET ended_at = now() - interval '11 minutes' WHERE id = $1`, [gid3]);
  assert.equal((await svc.groups.getGame(slug, admin, gid3)).status, 'confirmed');
  // Leaving: not while on court.
  const { id: gid4 } = await svc.groups.startGame(slug, admin, sid, { court: 1, a: [s3.a[0].id, s3.a[1].id], b: [s3.b[0].id, s3.b[1].id] });
  await assert.rejects(svc.groups.checkIn(slug, [admin, ...ps].find((p) => p.user.id === s3.a[0].id), sid, false), /Finish the game/);
  assert.ok(gid4);
});

test('HTTP: group routes need sign-in; sign in with an emailed link', async () => {
  const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie && { cookie }) }, body: JSON.stringify(body) });
  assert.equal((await post('/api/groups', { name: 'X', sport: 'badminton' })).status, 401);
  // Ask for a link: the email has the link and the same check code.
  mails = [];
  let r = await post('/api/auth/link', { email: 'New.Player@Group.Test', next: '/groups' });
  const { code } = await r.json();
  assert.match(code, /^\d{4}$/);
  assert.equal(mails.length, 1);
  assert.ok(mails[0].subject.includes(code));
  const token = mails[0].text.match(/token=([\w-]+)/)[1];
  assert.equal((await post('/api/auth/link', { email: 'new.player@group.test' })).status, 429); // one a minute
  // A new email: name first, then the account is made and signed in for 180 days.
  r = await post('/api/auth/link/use', { token });
  assert.deepEqual(await r.json(), { needsName: true, email: 'new.player@group.test' });
  r = await post('/api/auth/link/use', { token, name: 'New Player' });
  const body = await r.json();
  assert.equal(body.user.name, 'New Player');
  assert.equal(body.next, '/groups');
  const cookie = r.headers.get('set-cookie');
  assert.match(cookie, /Max-Age=15552000/);
  // Works again until it expires (mail scanners open links before people tap them), up to 5 times.
  r = await post('/api/auth/link/use', { token });
  assert.equal((await r.json()).user.name, 'New Player');
  for (let i = 0; i < 3; i++) await post('/api/auth/link/use', { token });
  assert.equal((await post('/api/auth/link/use', { token })).status, 400);
  await db.query(`UPDATE sign_in_links SET uses = 0, expires_at = now() - interval '1 minute'`);
  assert.match((await (await post('/api/auth/link/use', { token })).json()).error, /expired/);
  r = await post('/api/groups', { name: 'Link Group', sport: 'pickleball' }, cookie.split(';')[0]);
  assert.equal(r.status, 200);
  // An existing account signs straight in; no password was ever set for link accounts.
  mails = [];
  await db.query(`UPDATE sign_in_links SET created_at = now() - interval '2 minutes'`);
  await post('/api/auth/link', { email: 'new.player@group.test' });
  const t2 = mails[0].text.match(/token=([\w-]+)/)[1];
  r = await post('/api/auth/link/use', { token: t2 });
  assert.equal((await r.json()).user.name, 'New Player');
  assert.equal((await post('/api/auth/login', { email: 'new.player@group.test', password: 'link' })).status, 401);
  // The tab that asked signs in once the link is opened elsewhere (the mail app's browser) — once.
  mails = [];
  await db.query(`UPDATE sign_in_links SET created_at = now() - interval '2 minutes'`);
  r = await post('/api/auth/link', { email: 'new.player@group.test', next: '/g/abc' });
  const { poll } = await r.json();
  assert.ok(poll);
  assert.deepEqual(await (await post('/api/auth/link/poll', { poll })).json(), { waiting: true });
  assert.deepEqual(await (await post('/api/auth/link/poll', { poll: 'guess' })).json(), { waiting: true });
  const t3 = mails[0].text.match(/token=([\w-]+)/)[1];
  await post('/api/auth/link/use', { token: t3 });
  r = await post('/api/auth/link/poll', { poll });
  const polled = await r.json();
  assert.deepEqual([polled.user.name, polled.next], ['New Player', '/g/abc']);
  assert.match(r.headers.get('set-cookie'), /Max-Age=15552000/);
  assert.deepEqual(await (await post('/api/auth/link/poll', { poll })).json(), { waiting: true });
  // Unknown emails still "send" (no account enumeration); bad emails don't.
  assert.equal((await post('/api/auth/link', { email: 'nope' })).status, 400);
});

test('Vercel: the app\'s own pages are served by the function (cleanUrls breaks rewrites to /index.html)', async () => {
  const cfg = require('../vercel.json');
  const toFile = cfg.rewrites.filter((r) => r.destination.endsWith('.html'));
  assert.deepEqual(toFile, [], 'with cleanUrls on, rewrite app pages to /api/index?__path=app instead');
  for (const src of ['/g/:path*', '/groups', '/groups/:path*', '/me/profile', '/@:slug/edit']) {
    assert.ok(cfg.rewrites.some((r) => r.source === src && r.destination === '/api/index?__path=app'), src);
  }
  const r = await fetch(`${base}/api/index?__path=app&path=some-group&join=abc`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.ok((await r.text()).includes('/app.js'));
});

test('speed: few database round trips per group page, poll and point', async () => {
  const counted = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  let n = 0;
  const q0 = counted.query;
  counted.query = (...a) => { n += 1; return q0(...a); };
  const tx0 = counted.tx;
  counted.tx = (fn) => tx0((q) => fn((...a) => { n += 1; return q(...a); }));
  const s = createApp(counted, { mailer: { enabled: false, async send() { return {}; } } }).service;
  const mk = async (name) => {
    const [r] = await q0(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [`${name}@speed.test`, name]);
    return { user: { id: r.id, email: `${name}@speed.test`, name, isAdmin: false } };
  };
  const a = await mk('a');
  const { slug } = await s.groups.createGroup(a, { name: 'Speed', sport: 'badminton', courts: 3, ...nowSchedule() });
  const { invite, session } = await s.groups.view(slug, a);
  const ps = [a];
  for (let i = 0; i < 9; i++) { const p = await mk(`p${i}`); await s.groups.join(slug, p, { token: invite }); ps.push(p); }
  for (const p of ps) await s.groups.checkIn(slug, p, session.id, true);
  const sug = (await s.groups.view(slug, a)).session.suggestion;
  const { id } = await s.groups.startGame(slug, a, session.id, { court: 1, a: sug.a.map((p) => p.id), b: sug.b.map((p) => p.id) });
  n = 0; await s.groups.view(slug, a); assert.ok(n <= 8, `group page: ${n}`);
  n = 0; await s.groups.getGame(slug, a, id); assert.ok(n <= 3, `game poll: ${n}`);
  n = 0; await s.groups.rally(slug, a, id, 'a', 0); assert.ok(n <= 4, `point: ${n}`);
  await counted.close?.();
});

test('profiles show group play: the player sees each group, others only totals', async () => {
  const me = await user('Profile Player');
  const other = await user('Profile Other');
  const { slug } = await svc.groups.createGroup(me, { name: 'Secret Smashers', sport: 'badminton', courts: 1, scoring: { bestOf: 1, points: 11 }, ...nowSchedule() });
  const { invite, session } = await svc.groups.view(slug, me);
  const ps = [me, other];
  for (const n of ['Q1', 'Q2']) { const p = await user(n); ps.push(p); }
  for (const p of ps.slice(1)) await svc.groups.join(slug, p, { token: invite });
  for (const p of ps) await svc.groups.checkIn(slug, p, session.id, true);
  const sug = (await svc.groups.view(slug, me)).session.suggestion;
  const { id } = await svc.groups.startGame(slug, me, session.id, { court: 1, a: sug.a.map((p) => p.id), b: sug.b.map((p) => p.id) });
  await svc.groups.setResult(slug, me, id, { a: 11, b: 6 });
  await svc.groups.confirm(slug, me, id);
  const mine = await svc.players.myProfile(me);
  assert.equal(mine.groups[0].name, 'Secret Smashers');
  assert.equal(mine.groups[0].games, 1);
  assert.equal(mine.records[0].groupGames, 1);
  const handle = mine.handle;
  const own = await svc.players.profile(handle, me);
  assert.equal(own.groupPlay[0].name, 'Secret Smashers');
  const theirs = await svc.players.profile(handle, other);
  assert.equal(theirs.groupPlay[0].games, 1);
  assert.equal(theirs.groupPlay[0].name, undefined); // groups are private
  const pageRes = await fetch(`${base}/p/${handle}`);
  const html = await pageRes.text();
  assert.ok(html.includes('Group play') && !html.includes('Secret Smashers'));
  assert.match(pageRes.headers.get('cache-control'), /s-maxage=60\b/);
});

test('a carrom group game: a whole board in one tap, and undo takes it off', async () => {
  const admin = await user('Carrom Admin');
  const { slug } = await svc.groups.createGroup(admin, { name: 'Office Carrom Club', sport: 'carrom', courts: 1, singles: true, ...nowSchedule() });
  const { invite } = await svc.groups.view(slug, admin);
  const joy = await user('Joy');
  await svc.groups.join(slug, joy, { token: invite });
  let g = await svc.groups.view(slug, admin);
  const sid = g.session.id;
  for (const p of [admin, joy]) { await svc.groups.rsvp(slug, p, sid, 'in'); await svc.groups.checkIn(slug, p, sid, true); }
  const { id } = await svc.groups.startGame(slug, admin, sid, { court: 1, a: [admin.user.id], b: [joy.user.id] });
  await assert.rejects(svc.groups.startGame(slug, admin, sid, { court: 1, a: [admin.user.id], b: [joy.user.id] }), /Board 1 is busy/);
  await assert.rejects(svc.groups.startGame(slug, admin, sid, { court: 3, a: [admin.user.id], b: [joy.user.id] }), /Board: 1 to 1/);
  await assert.rejects(svc.groups.rally(slug, admin, id, 'a', undefined, { points: 13 }), /1 to 12/);
  let x = await svc.groups.rally(slug, admin, id, 'a', 0, { points: 12 });
  x = await svc.groups.rally(slug, joy, id, 'b', 1, { points: 9 });
  assert.deepEqual([x.score.games[0].a, x.score.games[0].b, x.rallies], [12, 9, 2]);
  x = await svc.groups.undo(slug, admin, id, 2);
  assert.equal(x.score.games[0].b, 0);
  await svc.groups.rally(slug, admin, id, 'a', 1, { points: 12 });
  x = await svc.groups.rally(slug, admin, id, 'a', 2, { points: 3 });
  assert.deepEqual([x.status, x.summary], ['done', '27-0']);
});

test('end time sets the session length, past midnight too', async () => {
  const a = await user('Night Owl');
  const { slug } = await svc.groups.createGroup(a, { name: 'Late Shuttlers', sport: 'badminton', days: [1, 2, 3, 4, 5], time: '20:00', endTime: '00:30' });
  let g = await svc.groups.view(slug, a);
  assert.deepEqual([g.settings.endTime, g.settings.hours], ['00:30', 4.5]);
  g = await svc.groups.updateGroup(slug, a, { time: '06:00', endTime: '09:00' });
  assert.deepEqual([g.settings.time, g.settings.endTime, g.settings.hours], ['06:00', '09:00', 3]);
  // Moving the start keeps the end; the length follows.
  g = await svc.groups.updateGroup(slug, a, { time: '07:00' });
  assert.deepEqual([g.settings.endTime, g.settings.hours], ['09:00', 2]);
  await assert.rejects(svc.groups.updateGroup(slug, a, { endTime: '07:10' }), /30 minutes to 12 hours/);
  await assert.rejects(svc.groups.updateGroup(slug, a, { endTime: '9am' }), /HH:MM/);
  // Older groups (no end time): start + their length.
  const { slug: old } = await svc.groups.createGroup(a, { name: 'Old Timers', sport: 'badminton', time: '06:00', hours: 2 });
  assert.equal((await svc.groups.view(old, a)).settings.endTime, '08:00');
});

test('coming at: RSVP with a time, change it, arrivals by the half hour, check-in clears it', async () => {
  const admin = await user('Venue Manager');
  const sched = nowSchedule(); // started an hour ago, 3 hours long
  const { slug } = await svc.groups.createGroup(admin, { name: 'Arena Evenings', sport: 'badminton', courts: 2, ...sched });
  const { invite, session } = await svc.groups.view(slug, admin);
  const [hh, mm] = sched.time.split(':').map(Number);
  const at = (mins) => { const t = (hh * 60 + mm + mins) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const ps = [];
  for (const name of ['Bala', 'Chitra', 'Dev']) { const p = await user(name); await svc.groups.join(slug, p, { token: invite }); ps.push(p); }
  await svc.groups.rsvp(slug, admin, session.id, 'in');
  await svc.groups.rsvp(slug, ps[0], session.id, 'in', { eta: at(90) });
  await svc.groups.rsvp(slug, ps[1], session.id, 'in', { eta: at(30) });
  await assert.rejects(svc.groups.rsvp(slug, ps[2], session.id, null, { eta: at(30) }), /in first/);
  await svc.groups.rsvp(slug, ps[2], session.id, 'in');
  await assert.rejects(svc.groups.rsvp(slug, ps[2], session.id, null, { eta: at(180) }), /Pick a time between/);
  await svc.groups.rsvp(slug, ps[2], session.id, null, { eta: at(60) });
  let s = (await svc.groups.view(slug, ps[2])).session;
  assert.equal(s.me.eta, at(60));
  assert.deepEqual(s.players.map((p) => [p.name, p.eta]), [['Venue Manager', null], ['Chitra', at(30)], ['Dev', at(60)], ['Bala', at(90)]]);
  assert.deepEqual(s.arrivals.map((x) => [x.time, x.count]), [[at(0), 1], [at(30), 2], [at(60), 3], [at(90), 4]]);
  // Saying "in" again keeps the time; checking in clears it from the list; "out" clears it.
  await svc.groups.rsvp(slug, ps[0], session.id, 'in');
  await svc.groups.checkIn(slug, ps[1], session.id, true);
  s = (await svc.groups.view(slug, admin)).session;
  assert.deepEqual(s.players.map((p) => [p.name, p.eta]), [['Chitra', null], ['Venue Manager', null], ['Dev', at(60)], ['Bala', at(90)]]);
  await svc.groups.rsvp(slug, ps[0], session.id, 'out');
  await svc.groups.rsvp(slug, ps[0], session.id, 'in');
  assert.equal((await svc.groups.view(slug, ps[0])).session.me.eta, null);
});

test('venues and academies host groups: "Play here" on their page, attendance for admins', async () => {
  const mgr = await user('Arena Owner');
  const other = await user('Someone Else');
  const [o] = await db.query(`INSERT INTO orgs (slug, name, kind, city, address, paid_until) VALUES ('smash-arena', 'Smash Arena', 'venue', 'Chennai', '12 Court Road', now() + interval '300 days') RETURNING id`);
  await db.query(`INSERT INTO org_members (org_id, email, role) VALUES ($1, $2, 'owner')`, [o.id, mgr.user.email]);
  await assert.rejects(svc.groups.createGroup(other, { name: 'Pirates', sport: 'badminton', host: 'smash-arena' }), /that page's team/);
  const sched = nowSchedule();
  const { slug } = await svc.groups.createGroup(mgr, { name: 'Arena Mornings', sport: 'badminton', host: 'smash-arena', maxPlayers: 12, ...sched });
  let g = await svc.groups.view(slug, mgr);
  assert.deepEqual([g.host.slug, g.host.name, g.host.kindName, g.host.address, g.host.public], ['smash-arena', 'Smash Arena', 'Venue', '12 Court Road, Chennai', true]);
  assert.deepEqual((await svc.groups.hostOptions(slug, mgr)).map((x) => x.slug), ['smash-arena']);
  // Unhosting and hosting again from settings.
  g = await svc.groups.updateGroup(slug, mgr, { host: null });
  assert.equal(g.host, null);
  g = await svc.groups.updateGroup(slug, mgr, { host: 'smash-arena' });
  assert.equal(g.host.slug, 'smash-arena');

  // People RSVP; the venue's page lists the group with how many are going.
  const ps = [];
  for (const name of ['Asha', 'Bala', 'Chitra']) { const p = await user(name); await svc.groups.join(slug, p, { token: g.invite }); ps.push(p); }
  for (const p of ps) await svc.groups.rsvp(slug, p, g.session.id, 'in');
  const list = await svc.groups.forOrgPage('smash-arena');
  assert.deepEqual(list.map((x) => [x.slug, x.going, x.spots]), [[slug, 3, 9]]);
  const html = await (await fetch(`${base}/@smash-arena`)).text();
  assert.match(html, /Play here/);
  assert.match(html, /Arena Mornings/);
  assert.match(html, /3 going · 9 spots left/);

  // Attendance: this session plus two earlier ones.
  await svc.groups.checkIn(slug, ps[0], g.session.id, true);
  await svc.groups.checkIn(slug, ps[1], g.session.id, true);
  const gid = (await db.query('SELECT id FROM groups WHERE slug = $1', [slug]))[0].id;
  for (const daysAgo of [1, 2]) {
    const [s] = await db.query(`INSERT INTO group_sessions (group_id, starts_at) VALUES ($1, now() - ($2 || ' days')::interval) RETURNING id`, [gid, daysAgo]);
    await db.query(`INSERT INTO session_players (session_id, user_id, status, checked_in_at) VALUES ($1, $2, 'in', now())`, [s.id, ps[0].user.id]);
    if (daysAgo === 1) await db.query(`INSERT INTO session_players (session_id, user_id, status) VALUES ($1, $2, 'in')`, [s.id, ps[2].user.id]);
  }
  await assert.rejects(svc.groups.attendance(slug, ps[0]), /admins/);
  const a = await svc.groups.attendance(slug, mgr);
  assert.equal(a.sessions.length, 3);
  assert.deepEqual(a.sessions.map((x) => [x.came, x.said]), [[2, 3], [1, 2], [1, 1]]);
  assert.deepEqual(a.players.map((p) => [p.name, p.came]), [['Asha', 3], ['Bala', 1], ['Chitra', 0]]);
  assert.equal(a.players[2].marks[a.sessions[1].id], 'in');
});

test('a venue\'s daily slots by level: levels, anyone can join, listed by time', async () => {
  const mgr = await user('Court Owner');
  const [o] = await db.query(`INSERT INTO orgs (slug, name, kind, paid_until) VALUES ('rally-hub', 'Rally Hub', 'venue', now() + interval '300 days') RETURNING id`);
  await db.query(`INSERT INTO org_members (org_id, email, role) VALUES ($1, $2, 'owner')`, [o.id, mgr.user.email]);
  const inter = await svc.groups.createGroup(mgr, { name: 'Evening Intermediates', sport: 'badminton', host: 'rally-hub', time: '19:00', endTime: '21:00', levels: ['Intermediate'] });
  const beg = await svc.groups.createGroup(mgr, { name: 'Evening Beginners', sport: 'badminton', host: 'rally-hub', time: '18:00', endTime: '19:00', levels: ['Beginner', 'Intermediate', 'Beginner'] });
  await assert.rejects(svc.groups.createGroup(mgr, { name: 'Pros', sport: 'badminton', levels: ['Pro'] }), /Level: one of Beginner, Beginner\+, Intermediate, Advanced/);
  // Hosted groups are open by default: anyone joins with one tap, no invite link.
  const g = await svc.groups.view(beg.slug, mgr);
  assert.deepEqual([g.settings.levels, g.settings.open], [['Beginner', 'Intermediate'], true]);
  const walkIn = await user('Walk In');
  assert.deepEqual(await svc.groups.join(beg.slug, walkIn, {}), { joined: true });
  // A closed group still asks.
  await svc.groups.updateGroup(inter.slug, mgr, { open: false, levels: [] });
  assert.deepEqual(await svc.groups.join(inter.slug, walkIn, {}), { joined: false });
  assert.deepEqual((await svc.groups.view(inter.slug, mgr)).settings.levels, []);
  // The page lists the slots in time order, each with its level.
  assert.deepEqual((await svc.groups.forOrgPage('rally-hub')).map((x) => x.name), ['Evening Beginners', 'Evening Intermediates']);
  const html = await (await fetch(`${base}/@rally-hub`)).text();
  assert.match(html, /Beginner &amp; Intermediate/);
  assert.match(html, /All levels/);
  assert.ok(html.indexOf('Evening Beginners') < html.indexOf('Evening Intermediates'));
});

test('scores at the end: a final score after live points, and results for games played without the app', async () => {
  const admin = await user('Result Admin');
  const { slug } = await svc.groups.createGroup(admin, { name: 'Weekend Doubles', sport: 'badminton', courts: 2, singles: true, ...nowSchedule() });
  const { invite, session } = await svc.groups.view(slug, admin);
  const ps = [];
  for (const name of ['Asha', 'Bala', 'Chitra', 'Dev']) { const p = await user(name); await svc.groups.join(slug, p, { token: invite }); ps.push(p); }
  const outsider = await user('Outsider');
  const id = (p) => p.user.id;
  // A game played without the app, added by one of its players.
  await assert.rejects(svc.groups.addResult(slug, outsider, session.id, { a: [id(ps[0])], b: [id(ps[1])], score: { a: 21, b: 10 } }), /Join the group/);
  await assert.rejects(svc.groups.addResult(slug, ps[2], session.id, { a: [id(ps[0])], b: [id(ps[1])], score: { a: 21, b: 10 } }), /Only the players/);
  await assert.rejects(svc.groups.addResult(slug, ps[0], session.id, { a: [id(ps[0]), id(ps[1])], b: [id(ps[2])], score: { a: 21, b: 10 } }), /2 or 4/);
  await assert.rejects(svc.groups.addResult(slug, ps[0], session.id, { a: [id(ps[0])], b: [id(outsider)], score: { a: 21, b: 10 } }), /in the group/);
  await assert.rejects(svc.groups.addResult(slug, ps[0], session.id, { a: [id(ps[0])], b: [id(ps[1])], score: { a: 21, b: 21 } }), /Enter both scores/);
  const { id: gid } = await svc.groups.addResult(slug, ps[0], session.id, { a: [id(ps[0]), id(ps[2])], b: [id(ps[1]), id(ps[3])], score: { a: 21, b: 18 } });
  let x = await svc.groups.getGame(slug, ps[1], gid);
  assert.deepEqual([x.status, x.court, x.summary, x.can.confirm], ['done', 0, '21–18', true]);
  x = await svc.groups.confirm(slug, ps[1], gid);
  assert.equal(x.status, 'confirmed');
  const board = (await svc.groups.view(slug, admin)).leaderboard;
  assert.ok(board.find((r) => r.id === id(ps[0])).rating > 1000);
  // An admin can add one for others.
  const { id: g2 } = await svc.groups.addResult(slug, admin, session.id, { a: [id(ps[2])], b: [id(ps[3])], score: { a: 15, b: 21 } });
  assert.equal((await svc.groups.getGame(slug, admin, g2)).winner, 'b');
  // A live game: some points, then the final score replaces them.
  for (const p of [ps[0], ps[1]]) await svc.groups.checkIn(slug, p, session.id, true);
  const { id: live } = await svc.groups.startGame(slug, admin, session.id, { court: 1, a: [id(ps[0])], b: [id(ps[1])] });
  await svc.groups.rally(slug, ps[0], live, 'a', 0);
  await svc.groups.rally(slug, ps[0], live, 'a', 1);
  x = await svc.groups.setResult(slug, ps[0], live, { a: 21, b: 12 });
  assert.deepEqual([x.status, x.summary, x.rallies], ['done', '21–12', 0]);
});

test('group links preview with context: joining, or coming to play today', async () => {
  const mgr = await user('Preview Owner');
  const [o] = await db.query(`INSERT INTO orgs (slug, name, kind, paid_until) VALUES ('court-house', 'Court House', 'venue', now() + interval '300 days') RETURNING id`);
  await db.query(`INSERT INTO org_members (org_id, email, role) VALUES ($1, $2, 'owner')`, [o.id, mgr.user.email]);
  const { slug } = await svc.groups.createGroup(mgr, { name: 'Evening Beginners', sport: 'badminton', host: 'court-house', levels: ['Beginner'], maxPlayers: 12, city: 'Chennai', ...nowSchedule() });
  const g = await svc.groups.view(slug, mgr);
  const p = await user('Secret Name');
  await svc.groups.join(slug, p, {});
  await svc.groups.rsvp(slug, p, g.session.id, 'in');
  const head = (html) => html.slice(0, html.indexOf('</head>'));
  // Join link.
  let r = await fetch(`${base}/g/${slug}?join=${g.invite}`);
  assert.equal(r.status, 200);
  let html = await r.text();
  assert.match(head(html), /<meta property="og:title" content="Join Evening Beginners at Court House">/);
  assert.match(head(html), /og:description" content="Badminton · Beginner · Every day .* · Chennai\. Tap to join, then say you&#39;re in\."/);
  assert.match(head(html), /og:image" content="[^"]+\/brand\/og-group-join\.png"/);
  assert.ok(html.includes('/app.js'), 'the app still loads');
  // Session link: today's count.
  html = await (await fetch(`${base}/g/${slug}?join=${g.invite}&s=${g.session.id}`)).text();
  assert.match(head(html), /og:title" content="(Today|On now) .* · 1 going, 11 spots left"/);
  assert.match(head(html), /og-group-today\.png/);
  assert.ok(!html.includes('Secret Name'), 'no member names in the preview');
  // A session from another group falls back to the join preview; an unknown group is a 404.
  html = await (await fetch(`${base}/api/group/${slug}?s=999999`)).text();
  assert.match(head(html), /Join Evening Beginners/);
  r = await fetch(`${base}/g/no-such-group`);
  assert.equal(r.status, 404);
  assert.match(head(await r.text()), /og\.png/);
});

test('a group keeps its own time zone (sessions start at local time there)', async () => {
  const a = await user('Sydney Admin');
  const { slug } = await svc.groups.createGroup(a, { name: 'Harbour Smashers', sport: 'badminton', days: [0, 1, 2, 3, 4, 5, 6], time: '19:00', endTime: '21:00', timeZone: 'Australia/Sydney' });
  const g = await svc.groups.view(slug, a);
  assert.equal(g.settings.timeZone, 'Australia/Sydney');
  const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(g.session.startsAt));
  assert.equal(local, '19:00');
  await assert.rejects(svc.groups.updateGroup(slug, a, { timeZone: 'Mars/Olympus' }), /Unknown time zone/);
  // Without one, India.
  const { slug: s2 } = await svc.groups.createGroup(a, { name: 'Default Zone', sport: 'badminton' });
  assert.equal((await svc.groups.view(s2, a)).settings.timeZone, 'Asia/Kolkata');
});

test('claim your spot: guests added by name play and rank, then claim it with their games and rating', async () => {
  const admin = await user('Claim Admin');
  const { slug } = await svc.groups.createGroup(admin, { name: 'Night Owls', sport: 'badminton', courts: 2, singles: true, ...nowSchedule() });
  let g = await svc.groups.view(slug, admin);
  // Pasted from WhatsApp: numbering, bullets and phone numbers go; repeats and existing members are skipped.
  assert.deepEqual(svc.groups.namesFrom('1. Rahul Menon\n- Priya S\n~ Arjun K +91 98400 12345\n\n+91 99999 88888\nrahul menon'), ['Rahul Menon', 'Priya S', 'Arjun K']);
  const member = await user('Joined Already');
  await svc.groups.join(slug, member, { token: g.invite });
  await assert.rejects(svc.groups.addGuests(slug, member, { names: 'X' }), /admins/);
  await assert.rejects(svc.groups.addGuests(slug, admin, { names: '\n 123 \n' }), /at least one name/);
  const r = await svc.groups.addGuests(slug, admin, { names: '1. Rahul Menon\n2. Priya S\n3. Arjun K\nJoined Already' });
  assert.deepEqual([r.added, r.skipped], [3, 1]);
  g = r.group;
  const guest = (name) => g.leaderboard.find((x) => x.name === name);
  assert.ok(guest('Rahul Menon').guest && !guest('Joined Already').guest);
  assert.equal(g.members, 5);
  // Guests can't sign in, and don't show in the site admin's user list.
  const [row] = await db.query('SELECT email FROM users WHERE id = $1', [guest('Rahul Menon').id]);
  const auth = require('../server/auth').createAuth(db, {});
  await assert.rejects(auth.login({ headers: {} }, { email: row.email, password: 'guest' }), /disabled|incorrect/);
  assert.ok(!(await auth.listUsers({ user: { ...admin.user, isAdmin: true } }, { q: 'Rahul' })).users.length);
  await assert.rejects(svc.groups.setMember(slug, admin, guest('Priya S').id, 'admin'), /claim their spot/);
  // The admin checks guests in; they play, and the result moves their rating.
  const rahul = guest('Rahul Menon').id;
  const priya = guest('Priya S').id;
  for (const id of [rahul, priya]) await svc.groups.checkIn(slug, admin, g.session.id, true, id);
  const { id: gid } = await svc.groups.startGame(slug, admin, g.session.id, { court: 1, a: [rahul], b: [priya] });
  await svc.groups.setResult(slug, admin, gid, { a: 21, b: 15 });
  await svc.groups.confirm(slug, admin, gid);
  g = await svc.groups.view(slug, admin);
  assert.equal(guest('Rahul Menon').rank, 1);
  // Someone with the invite link sees the spots waiting (and how they're doing); without it, nothing.
  const newbie = await user('Rahul M');
  let outside = await svc.groups.view(slug, newbie, { join: g.invite });
  assert.deepEqual(outside.guests.map((x) => [x.name, x.rank, x.wins]), [['Rahul Menon', 1, 1], ['Priya S', 2, 0], ['Arjun K', null, 0]]);
  assert.deepEqual((await svc.groups.view(slug, newbie)).guests, []);
  // The claim link's preview names them and their standing (only with the right token).
  const head = async (url) => { const html = await (await fetch(url)).text(); return html.slice(0, html.indexOf('</head>')); };
  assert.match(await head(`${base}/g/${slug}?join=${g.invite}&claim=${rahul}`), /og:title" content="Rahul Menon, your spot in Night Owls is waiting".*#1 on the leaderboard · 1 win in 1 game/s);
  assert.doesNotMatch(await head(`${base}/g/${slug}?join=wrong&claim=${rahul}`), /Rahul/);
  // Claiming: needs the invite (or membership), and takes over the games, rating and RSVPs.
  const stranger = await user('Stranger');
  await assert.rejects(svc.groups.claim(slug, stranger, rahul, { token: 'wrong' }), /invite link/);
  const before = guest('Rahul Menon');
  g = await svc.groups.claim(slug, newbie, rahul, { token: g.invite });
  const me = g.leaderboard.find((x) => x.id === newbie.user.id);
  assert.deepEqual([me.name, me.rating, me.games, me.wins, me.guest, me.rank], ['Rahul M', before.rating, 1, 1, false, 1]);
  assert.ok(!g.leaderboard.some((x) => x.id === rahul));
  const x = await svc.groups.getGame(slug, newbie, gid);
  assert.equal(x.a[0].id, newbie.user.id);
  assert.ok(x.deltas[newbie.user.id] > 0 && !(rahul in x.deltas));
  assert.equal(g.session.players.find((p) => p.id === newbie.user.id).checkedIn, true);
  assert.equal((await db.query('SELECT 1 FROM users WHERE id = $1', [rahul])).length, 0);
  // A member with games of their own can't take a second spot.
  await assert.rejects(svc.groups.claim(slug, newbie, priya, {}), /already have games/);
  // Voiding the game afterwards undoes it for the account that claimed it.
  await svc.groups.voidGame(slug, admin, gid);
  g = await svc.groups.view(slug, admin);
  assert.deepEqual([g.leaderboard.find((y) => y.id === newbie.user.id).rating, guest('Priya S').rating], [1000, 1000]);
  await assert.rejects(svc.groups.claim(slug, stranger, rahul, { token: g.invite }), /already been claimed/);
  // A member who hasn't played yet can.
  g = await svc.groups.claim(slug, member, priya, {});
  assert.equal(g.leaderboard.filter((y) => y.guest).length, 1);
  // Removing an unclaimed guest who never played deletes them.
  const arjun = guest('Arjun K').id;
  await svc.groups.setMember(slug, admin, arjun, 'remove');
  assert.equal((await db.query('SELECT 1 FROM users WHERE id = $1', [arjun])).length, 0);
});

test('admins mark anyone present (or not), whether or not they said they\'re in', async () => {
  const admin = await user('Here Admin');
  const { slug } = await svc.groups.createGroup(admin, { name: 'Walk-in Club', sport: 'badminton', courts: 1, ...nowSchedule() });
  let g = await svc.groups.view(slug, admin);
  const regular = await user('Never RSVPs');
  const other = await user('Another Member');
  for (const p of [regular, other]) await svc.groups.join(slug, p, { token: g.invite });
  const sid = g.session.id;
  const here = async (p) => (await svc.groups.view(slug, admin)).session.players.find((x) => x.id === p.user.id);
  assert.equal(await here(regular), undefined); // no RSVP
  await svc.groups.checkIn(slug, admin, sid, true, regular.user.id);
  assert.ok((await here(regular)).checkedIn);
  assert.equal((await here(regular)).status, 'in');
  // Marked by mistake: back to not here.
  await svc.groups.checkIn(slug, admin, sid, false, regular.user.id);
  assert.ok(!(await here(regular)).checkedIn);
  // Only admins can do it for someone else.
  await assert.rejects(svc.groups.checkIn(slug, other, sid, true, regular.user.id), /Only group admins/);
});
