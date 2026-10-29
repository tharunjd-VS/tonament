'use strict';

// Clubs and the social layer: free clubs people join (open, by invite, or by
// approval), follows, the feed and who sees what, kudos and comments, blocks,
// and under-18s kept out of strangers' feeds.

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
// A signed-in browser: call(method, path, body) -> { status, data }.
async function person(name) {
  n += 1;
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@clubs.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
const verbs = (feed) => feed.items.map((x) => x.verb);

test('a free club: the maker is admin; open, invite and approval joining; roles; the last admin stays', async () => {
  const kavya = await person('Kavya Raman');
  const arun = await person('Arun Kumar');
  const bala = await person('Bala Murali');
  let r = await kavya.call('POST', '/api/clubs', { name: 'Smashpoint Juniors', slug: 'smashpoint-juniors', kind: 'team', city: 'Chennai', sports: ['badminton'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.kindName, 'Team');
  assert.equal(r.data.me.role, 'admin');
  assert.ok(r.data.invite);
  const invite = r.data.invite;
  // Open by default: Arun joins straight away.
  r = await arun.call('POST', '/api/clubs/smashpoint-juniors/join', {});
  assert.equal(r.data.joined, 'active');
  assert.equal(r.data.members, 2);
  assert.equal(r.data.invite, invite); // members can share the invite
  // Closed: Bala asks, the admin lets him in; with the invite link he'd be straight in.
  await kavya.call('PATCH', '/api/clubs/smashpoint-juniors', { open: false });
  r = await bala.call('POST', '/api/clubs/smashpoint-juniors/join', {});
  assert.equal(r.data.joined, 'requested');
  assert.equal(r.data.invite, null);
  assert.equal((await arun.call('POST', `/api/clubs/smashpoint-juniors/members/${bala.id}`, { action: 'approve' })).status, 403);
  r = await kavya.call('GET', '/api/clubs/smashpoint-juniors');
  assert.deepEqual(r.data.requests.map((p) => p.name), ['Bala Murali']);
  await kavya.call('POST', `/api/clubs/smashpoint-juniors/members/${bala.id}`, { action: 'approve' });
  const carl = await person('Carl Dsouza');
  r = await carl.call('POST', '/api/clubs/smashpoint-juniors/join', { invite });
  assert.equal(r.data.joined, 'active');
  // Roles; the last admin can't step down or leave while others are in.
  await kavya.call('POST', `/api/clubs/smashpoint-juniors/members/${arun.id}`, { action: 'role', role: 'captain' });
  r = await kavya.call('POST', `/api/clubs/smashpoint-juniors/members/${kavya.id}`, { action: 'role', role: 'player' });
  assert.equal(r.status, 409);
  assert.equal((await kavya.call('POST', '/api/clubs/smashpoint-juniors/leave')).status, 409);
  r = await kavya.call('GET', '/api/clubs/smashpoint-juniors');
  assert.deepEqual(r.data.roster.map((p) => [p.name, p.role]), [['Kavya Raman', 'admin'], ['Arun Kumar', 'captain'], ['Bala Murali', 'player'], ['Carl Dsouza', 'player']]);
  // Mine, discover, and "plays for" on the profile; /@slug without a paid page opens the club in the app.
  assert.deepEqual((await arun.call('GET', '/api/clubs/mine')).data.map((c) => c.slug), ['smashpoint-juniors']);
  assert.ok((await arun.call('GET', '/api/clubs?city=Chennai&sport=badminton')).data.some((c) => c.slug === 'smashpoint-juniors'));
  const [{ handle }] = await db.query('SELECT handle FROM users WHERE id = $1', [arun.id]);
  if (handle) assert.deepEqual((await svc.players.profile(handle)).clubs.map((c) => c.name), ['Smashpoint Juniors']);
  const page = await fetch(`${base}/@smashpoint-juniors`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/club/smashpoint-juniors');
  // The club's feed: it was made, and people joined.
  const feed = (await carl.call('GET', '/api/clubs/smashpoint-juniors/feed')).data;
  assert.deepEqual(verbs(feed).sort(), ['club', 'joined', 'joined', 'joined']);
});

test('follows and the feed: podiums are public, games go to followers, private tournaments stay private', async () => {
  const meera = await person('Meera Krishnan');
  const rohan = await person('Rohan Iyer');
  const fan = await person('Fan Follower');
  const stranger = await person('Some Stranger');
  // A public singles event Meera wins.
  const add = async (visibility, name) => {
    const { id } = await svc.createTournament(meera.actor, { name, format: 'knockout', visibility, events: [{ discipline: 'singles', gender: 'open' }] });
    await svc.addEntries(id, meera.actor, ['Meera Krishnan', 'Rohan Iyer', 'P3', 'P4']);
    const t = await svc.getTournament(id, meera.actor);
    const [mk, ri] = t.entries;
    await svc.setEntryPlayers(id, meera.actor, mk.id, { players: [{ name: 'Meera Krishnan', email: meera.email }] });
    await svc.setEntryPlayers(id, meera.actor, ri.id, { players: [{ name: 'Rohan Iyer', email: rohan.email }] });
    await svc.start(id, meera.actor);
    for (;;) {
      const x = await svc.getTournament(id, meera.actor);
      const m = x.matches.find((y) => y.status === 'scheduled' && y.a && y.b);
      if (!m) break;
      const side = m.a.name === 'Meera Krishnan' || (m.b.name !== 'Meera Krishnan' && m.a.name === 'Rohan Iyer') ? 'a' : 'b';
      await svc.setResult(id, meera.actor, m.id, side === 'a' ? [{ a: 21, b: 10 }, { a: 21, b: 12 }] : [{ a: 10, b: 21 }, { a: 12, b: 21 }], m.rallies || 0);
    }
    return id;
  };
  await add('public', 'City Open');
  await add('private', 'Secret Cup');
  // The fan follows Meera; the stranger follows no one.
  assert.equal((await fan.call('POST', '/api/follow', { kind: 'user', id: meera.id })).data.following, true);
  assert.equal((await fan.call('GET', `/api/follow?kind=user&id=${meera.id}`)).data.followers, 1);
  let feed = (await fan.call('GET', '/api/feed')).data;
  const finishes = feed.items.filter((x) => x.verb === 'finish');
  assert.deepEqual(finishes.map((x) => [x.data.tournament, x.data.finish, x.people[0].name]), [['City Open', 'W', 'Meera Krishnan']]);
  assert.equal((await stranger.call('GET', '/api/feed')).data.items.length, 0);
  // Meera's profile feed shows her title to anyone (public), not the secret cup.
  feed = (await stranger.call('GET', `/api/feed/user/${meera.id}`)).data;
  assert.deepEqual(feed.items.map((x) => x.data.tournament), ['City Open']);
  // Kudos and comments; only the writer or the people it's about delete a comment.
  const item = finishes[0];
  let r = await fan.call('POST', `/api/activity/${item.id}/kudos`, { on: true });
  assert.deepEqual(r.data, { kudos: 1, kudoed: true });
  r = await fan.call('POST', `/api/activity/${item.id}/comments`, { body: 'Well played! 🏸' });
  assert.equal(r.data[0].body, 'Well played! 🏸');
  const cid = r.data[0].id;
  assert.equal((await stranger.call('DELETE', `/api/comments/${cid}`)).status, 404);
  assert.equal((await meera.call('DELETE', `/api/comments/${cid}`)).status, 200);
  // Blocking: the fan blocks Meera and stops seeing her; the follow is dropped.
  await fan.call('POST', '/api/block', { user: meera.id });
  assert.equal((await fan.call('GET', '/api/feed')).data.items.filter((x) => x.verb === 'finish').length, 0);
  assert.equal((await fan.call('GET', `/api/follow?kind=user&id=${meera.id}`)).data.following, false);
});

test('group games: in followers\' feeds once confirmed, gone when voided; under-18s hidden from strangers', async () => {
  const admin = await person('Group Admin');
  const kid = await person('Young Player');
  const fan = await person('Kid Fan');
  await db.query('UPDATE users SET birth_year = $1 WHERE id = $2', [new Date().getFullYear() - 14, kid.id]);
  const t0 = new Date(Date.now() - 3600000);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t0);
  const { slug } = await svc.groups.createGroup(admin.actor, { name: 'Evening Smashers', sport: 'badminton', courts: 1, days: [0, 1, 2, 3, 4, 5, 6], time, hours: 3, timeZone: 'Asia/Kolkata', singles: true });
  const g = await svc.groups.view(slug, admin.actor);
  await svc.groups.join(slug, kid.actor, { token: g.invite });
  const game = await svc.groups.addResult(slug, admin.actor, g.session.id, { a: [admin.id], b: [kid.id], score: { a: 21, b: 15 } });
  await svc.groups.confirm(slug, admin.actor, game.id);
  // A game with an under-18 in it isn't shown to someone who doesn't know them,
  // even when they follow the other player.
  await fan.call('POST', '/api/follow', { kind: 'user', id: admin.id });
  let items = (await fan.call('GET', '/api/feed')).data.items.filter((x) => x.verb === 'game');
  assert.equal(items.length, 0, 'a game with an under-18 player is hidden from someone who doesn\'t follow them');
  await db.query('UPDATE users SET birth_year = NULL WHERE id = $1', [kid.id]);
  items = (await fan.call('GET', '/api/feed')).data.items.filter((x) => x.verb === 'game');
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].data.a, items[0].data.b, items[0].data.score], [['Group Admin'], ['Young Player'], '21–15']);
  // Voided: gone.
  await svc.groups.voidGame(slug, admin.actor, game.id);
  items = (await fan.call('GET', '/api/feed')).data.items.filter((x) => x.verb === 'game');
  assert.equal(items.length, 0);
});
