'use strict';

// Goals: personal (join by link), a club's total, and club v club. Progress
// counts confirmed group games, challenges and tournament matches in the
// window (games or wins, one sport or any); badges in the feed and the inbox,
// once; who may set club goals; and the share card.

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
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@goals.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
// A confirmed challenge game between a and b (a wins), in `sport`.
async function play(a, b, sport = 'badminton') {
  const c = (await a.call('POST', '/api/challenges', { to: b.id, sport })).data;
  await b.call('POST', `/api/challenges/${c.id}/respond`, { accept: true });
  await a.call('POST', `/api/challenges/${c.id}/result`, { a: 21, b: 10 });
  await b.call('POST', `/api/challenges/${c.id}/confirm`);
}

test('a personal goal: friends join by link; games and wins count from the window; a badge once', async () => {
  const meera = await person('Meera Goal');
  const fan = await person('Fan Goal');
  const rival = await person('Rival Goal');
  await play(meera, rival); // before the goal: doesn't count
  let r = await meera.call('POST', '/api/goals', { scope: 'personal', metric: 'wins', sport: 'badminton', target: 2, startsAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const g = r.data;
  assert.deepEqual([g.title, g.people, g.me.value], ['2 wins of badminton', 1, 0]);
  r = await fan.call('POST', `/api/goals/${g.id}/join`);
  assert.equal(r.data.people, 2);
  await new Promise((res) => { setTimeout(res, 1100); });
  await play(meera, rival);
  await play(rival, fan); // the fan loses: a game, not a win
  await play(meera, rival, 'pickleball'); // another sport: doesn't count
  r = await meera.call('GET', `/api/goals/${g.id}`);
  assert.deepEqual(r.data.board.map((p) => [p.name, p.value]), [['Meera Goal', 1], ['Fan Goal', 0]]);
  await play(meera, rival);
  r = await meera.call('GET', `/api/goals/${g.id}`);
  assert.equal(r.data.me.value, 2);
  // Badge: in the feed and the inbox, once (viewing again adds nothing).
  await meera.call('GET', `/api/goals/${g.id}`);
  const items = (await svc.social.userFeed(meera.id, null)).items.filter((x) => x.verb === 'goal');
  assert.equal(items.length, 1);
  assert.equal(items[0].data.title, '2 wins of badminton');
  const notes = (await meera.call('GET', '/api/notifications')).data.items.filter((x) => x.kind === 'goal');
  assert.deepEqual(notes.map((x) => x.title), ['🏅 Goal reached: 2 wins of badminton']);
  // Mine; the card.
  assert.deepEqual((await fan.call('GET', '/api/goals')).data.active.map((x) => x.id), [g.id]);
  assert.equal((await fetch(`${base}/img/goal/${g.id}.png`)).status, 200);
  // Rules.
  assert.equal((await meera.call('POST', '/api/goals', { scope: 'personal', target: 0 })).status, 400);
  assert.equal((await meera.call('POST', '/api/goals', { scope: 'personal', target: 5, endsAt: new Date(Date.now() + 200 * 86400000).toISOString() })).status, 400);
});

test('club and club v club goals: admins set them, members count; group games and tournament matches count too', async () => {
  const a1 = await person('Alpha Admin');
  const a2 = await person('Alpha Two');
  const b1 = await person('Beta Admin');
  const b2 = await person('Beta Two');
  await svc.clubs.create(a1.actor, { name: 'Alpha Club', slug: 'alpha-club', sports: ['badminton'] });
  await svc.clubs.create(b1.actor, { name: 'Beta Club', slug: 'beta-club', sports: ['badminton'] });
  await a2.call('POST', '/api/clubs/alpha-club/join', {});
  await b2.call('POST', '/api/clubs/beta-club/join', {});
  assert.equal((await a2.call('POST', '/api/goals', { scope: 'club', club: 'alpha-club', target: 3 })).status, 403);
  const club = (await a1.call('POST', '/api/goals', { scope: 'club', club: 'alpha-club', target: 3 })).data;
  const versus = (await a1.call('POST', '/api/goals', { scope: 'versus', club: 'alpha-club', rival: 'beta-club' })).data;
  assert.equal(versus.title, 'Alpha Club v Beta Club: most games');
  // A challenge (Alpha v Beta players), a group game, and a tournament match.
  await play(a2, b2);
  const t0 = new Date(Date.now() - 3600000);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t0);
  const { slug } = await svc.groups.createGroup(a1.actor, { name: 'Alpha Group', sport: 'badminton', courts: 1, days: [0, 1, 2, 3, 4, 5, 6], time, hours: 3, timeZone: 'Asia/Kolkata', singles: true });
  const grp = await svc.groups.view(slug, a1.actor);
  await svc.groups.join(slug, a2.actor, { token: grp.invite });
  const game = await svc.groups.addResult(slug, a1.actor, grp.session.id, { a: [a1.id], b: [a2.id], score: { a: 21, b: 15 } });
  await svc.groups.confirm(slug, a2.actor, game.id);
  const { id } = await svc.createTournament(b1.actor, { name: 'Beta Cup', format: 'knockout', events: [{ discipline: 'singles', gender: 'open' }] });
  await svc.addEntries(id, b1.actor, ['Beta Admin', 'Someone Else']);
  let t = await svc.getTournament(id, b1.actor);
  await svc.setEntryPlayers(id, b1.actor, t.entries[0].id, { players: [{ name: 'Beta Admin', email: b1.email }] });
  await svc.start(id, b1.actor);
  t = await svc.getTournament(id, b1.actor);
  const m = t.matches.find((x) => x.a && x.b);
  await svc.setResult(id, b1.actor, m.id, m.a.name === 'Beta Admin' ? [{ a: 21, b: 5 }, { a: 21, b: 5 }] : [{ a: 5, b: 21 }, { a: 5, b: 21 }], 0);
  // Alpha: a2 played 2 (challenge + group), a1 played 1 → 3 games, goal reached.
  let r = await a2.call('GET', `/api/goals/${club.id}`);
  assert.equal(r.data.total, 3);
  const [badge] = (await svc.social.clubFeed((await db.query(`SELECT id FROM orgs WHERE slug = 'alpha-club'`))[0].id, a1.actor)).items.filter((x) => x.verb === 'goal');
  assert.equal(badge.data.club, 'Alpha Club');
  // Versus: Alpha 3, Beta 2 (b2's challenge, b1's tournament match).
  r = await b2.call('GET', `/api/goals/${versus.id}`);
  assert.deepEqual([r.data.club.total, r.data.rival.total], [3, 2]);
  assert.equal(r.data.can.join, false);
  // It ends: Alpha won, once.
  await new Promise((res) => { setTimeout(res, 50); });
  await db.query(`UPDATE goals SET ends_at = now() WHERE id = $1`, [versus.id]);
  r = await b2.call('GET', `/api/goals/${versus.id}`);
  assert.equal(r.data.ended, true);
  const won = (await a2.call('GET', '/api/notifications')).data.items.find((x) => x.title.startsWith('🏆'));
  assert.equal(won.title, '🏆 Alpha Club beat Beta Club');
  assert.equal((await a2.call('GET', '/api/clubs/alpha-club/goals')).data.length, 2);
  assert.equal((await fetch(`${base}/img/goal/${versus.id}.png`)).status, 200);
});
