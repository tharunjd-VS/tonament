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
  // Works once.
  assert.equal((await post('/api/auth/link/use', { token, name: 'Again' })).status, 400);
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
  // Unknown emails still "send" (no account enumeration); bad emails don't.
  assert.equal((await post('/api/auth/link', { email: 'nope' })).status, 400);
});
