'use strict';

// Challenges: send, accept or decline, score (live or the final score), the
// losing side confirms (or it confirms itself), ratings move, the feed and
// notifications; pairs; who can do what; blocks; and group games moving the
// same Tonament rating.

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
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@ch.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
const rating = async (id, sport = 'badminton') => (await db.query('SELECT rating, games, wins FROM ratings WHERE user_id = $1 AND sport = $2', [id, sport]))[0] || null;

test('one v one: challenge, accept, score live, the loser confirms; ratings, feed and notifications', async () => {
  const arjun = await person('Arjun Mehta');
  const rohan = await person('Rohan Iyer');
  const fan = await person('Arjun Fan');
  await fan.call('POST', '/api/follow', { kind: 'user', id: arjun.id });
  let r = await arjun.call('POST', '/api/challenges', { to: rohan.id, sport: 'badminton', bestOf: 1, place: 'Smashpoint', message: 'This Saturday?' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = r.data;
  assert.deepEqual([c.status, c.format, c.me, c.can.respond, c.can.cancel], ['sent', 'One game', 'a', false, true]);
  // Rohan is told, and answers; only he can.
  const [note] = (await rohan.call('GET', '/api/notifications')).data.items;
  assert.equal(note.title, 'Arjun Mehta challenges you to Badminton');
  assert.equal(note.url, `/c/${c.id}`);
  assert.equal((await fan.call('POST', `/api/challenges/${c.id}/respond`, { accept: true })).status, 403);
  assert.equal((await arjun.call('POST', `/api/challenges/${c.id}/rally`, { side: 'a', at: 0 })).status, 409, 'not before it\'s accepted');
  r = await rohan.call('POST', `/api/challenges/${c.id}/respond`, { accept: true });
  assert.equal(r.data.status, 'accepted');
  assert.match((await arjun.call('GET', '/api/notifications')).data.items[0].title, /Rohan Iyer accepted your challenge/);
  // Scored live: 21–17 to Arjun. Strangers can't score.
  assert.equal((await fan.call('POST', `/api/challenges/${c.id}/rally`, { side: 'a', at: 0 })).status, 403);
  const rallies = `${'b'.repeat(17)}${'a'.repeat(21)}`;
  // Both score; Arjun taps the winning point (the one who taps it isn't asked to confirm).
  for (let i = 0; i < rallies.length; i++) r = await (i % 2 && i < rallies.length - 1 ? rohan : arjun).call('POST', `/api/challenges/${c.id}/rally`, { side: rallies[i], at: i });
  assert.equal(r.data.status, 'done');
  assert.equal(r.data.summary, '21-17'); // the sport's own summary, as in tournaments
  assert.equal(r.data.winner, 'a');
  // Only the loser confirms.
  assert.equal((await arjun.call('POST', `/api/challenges/${c.id}/confirm`)).status, 403);
  assert.match((await rohan.call('GET', '/api/notifications')).data.items[0].title, /Arjun Mehta won the challenge 21-17 — confirm it/);
  r = await rohan.call('POST', `/api/challenges/${c.id}/confirm`);
  assert.equal(r.data.status, 'confirmed');
  assert.ok(r.data.deltas[arjun.id] > 0 && r.data.deltas[rohan.id] < 0);
  assert.deepEqual([(await rating(arjun.id)).wins, (await rating(rohan.id)).games], [1, 1]);
  assert.equal((await rating(arjun.id)).rating, 1000 + r.data.deltas[arjun.id]);
  assert.equal(r.data.can.back, true);
  // In the fan's feed, with a share card; on Arjun's profile as a rating.
  const [item] = (await fan.call('GET', '/api/feed')).data.items.filter((x) => x.verb === 'challenge');
  assert.deepEqual([item.data.a, item.data.b, item.data.score, item.public], [['Arjun Mehta'], ['Rohan Iyer'], '21-17', true]);
  assert.equal((await fetch(`${base}/img/a/${item.id}.png`)).status, 200);
  const [{ handle }] = await db.query('SELECT handle FROM users WHERE id = $1', [arjun.id]);
  assert.deepEqual((await svc.players.profile(handle)).ratings.map((x) => [x.name, x.games]), [['Badminton', 1]]);
  // Lists.
  const mine = (await rohan.call('GET', '/api/challenges')).data;
  assert.deepEqual(mine.played.map((x) => x.id), [c.id]);
});

test('pairs, the final score, a challenge back, declining, disputes, auto-confirm, blocks and limits', async () => {
  const [a1, a2, b1, b2] = await Promise.all(['Pair A1', 'Pair A2', 'Pair B1', 'Pair B2'].map(person));
  let r = await a1.call('POST', '/api/challenges', { to: b1.id, partner: a2.id, opponentPartner: b2.id, sport: 'badminton', bestOf: 3 });
  const c = r.data;
  assert.deepEqual([c.a.length, c.b.length, c.format], [2, 2, 'Best of 3']);
  assert.equal((await b1.call('GET', '/api/notifications')).data.items[0].title, 'Pair A1 & Pair A2 challenge you to Badminton');
  assert.equal((await b2.call('GET', '/api/notifications')).data.items.length, 1);
  await b1.call('POST', `/api/challenges/${c.id}/respond`, { accept: true });
  // The final score instead; B wins. The other B player can't confirm their own win.
  r = await a2.call('POST', `/api/challenges/${c.id}/result`, { a: 15, b: 21 });
  assert.deepEqual([r.data.status, r.data.winner, r.data.summary], ['done', 'b', '15–21']);
  assert.equal((await b2.call('POST', `/api/challenges/${c.id}/confirm`)).status, 403);
  // Disputed: doesn't count; then kept by the losing side.
  await b2.call('POST', `/api/challenges/${c.id}/dispute`);
  assert.equal(await rating(b1.id), null);
  r = await a1.call('POST', `/api/challenges/${c.id}/confirm`);
  assert.equal(r.data.status, 'confirmed');
  assert.equal((await rating(b2.id)).wins, 1);
  // Challenge back: a rematch, which they decline.
  r = await a1.call('POST', '/api/challenges', { to: b1.id, sport: 'badminton', back: c.id });
  assert.equal(r.data.parent, c.id);
  r = await b1.call('POST', `/api/challenges/${r.data.id}/respond`, { accept: false });
  assert.equal(r.data.status, 'declined');
  assert.match((await a1.call('GET', '/api/notifications')).data.items[0].title, /can't play this time/);
  // Unconfirmed for a day: it confirms itself.
  r = await a1.call('POST', '/api/challenges', { to: b2.id, sport: 'pickleball' });
  const late = r.data.id;
  await b2.call('POST', `/api/challenges/${late}/respond`, { accept: true });
  await a1.call('POST', `/api/challenges/${late}/result`, { a: 11, b: 4 });
  await db.query(`UPDATE challenges SET ended_at = now() - interval '25 hours' WHERE id = $1`, [late]);
  assert.equal((await a1.call('GET', `/api/challenges/${late}`)).data.status, 'confirmed');
  assert.equal((await rating(a1.id, 'pickleball')).wins, 1);
  // Not: yourself, the same person twice, a team sport, someone who's blocked you.
  assert.equal((await a1.call('POST', '/api/challenges', { to: a1.id, sport: 'badminton' })).status, 400);
  assert.equal((await a1.call('POST', '/api/challenges', { to: b1.id, partner: b1.id, opponentPartner: b2.id, sport: 'badminton' })).status, 400);
  assert.equal((await a1.call('POST', '/api/challenges', { to: b1.id, sport: 'football' })).status, 400);
  await b1.call('POST', '/api/block', { user: a1.id });
  assert.equal((await a1.call('POST', '/api/challenges', { to: b1.id, sport: 'badminton' })).status, 403);
  // Ten waiting at most.
  for (let i = 0; i < 10; i++) await a2.call('POST', '/api/challenges', { to: b2.id, sport: 'squash' });
  assert.equal((await a2.call('POST', '/api/challenges', { to: b2.id, sport: 'squash' })).status, 429);
  // Expired after two weeks without an answer.
  const [old] = await db.query(`SELECT id FROM challenges WHERE created_by = $1 AND status = 'sent' LIMIT 1`, [a2.id]);
  await db.query(`UPDATE challenges SET created_at = now() - interval '15 days' WHERE id = $1`, [old.id]);
  assert.equal((await a2.call('GET', `/api/challenges/${old.id}`)).data.status, 'expired');
});

test('group games move the same Tonament rating (and a voided one moves it back)', async () => {
  const admin = await person('Group Rater');
  const other = await person('Group Other');
  const t0 = new Date(Date.now() - 3600000);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t0);
  const { slug } = await svc.groups.createGroup(admin.actor, { name: 'Rating Group', sport: 'badminton', courts: 1, days: [0, 1, 2, 3, 4, 5, 6], time, hours: 3, timeZone: 'Asia/Kolkata', singles: true });
  const g = await svc.groups.view(slug, admin.actor);
  await svc.groups.join(slug, other.actor, { token: g.invite });
  const game = await svc.groups.addResult(slug, admin.actor, g.session.id, { a: [admin.id], b: [other.id], score: { a: 21, b: 10 } });
  await svc.groups.confirm(slug, other.actor, game.id);
  const won = await rating(admin.id);
  assert.ok(won.rating > 1000);
  assert.equal(won.games, 1);
  await svc.groups.voidGame(slug, admin.actor, game.id);
  assert.deepEqual(await rating(admin.id), { rating: 1000, games: 0, wins: 0 });
});
