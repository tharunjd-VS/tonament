'use strict';

// Club seasons: a host club sets up a league, other clubs enter by link and
// pick teams from their members, the host starts it (a round robin), results
// go on both clubs' feeds as they come in, and the champions on everyone's.

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
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@season.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
// A club with an admin and `extra` members.
async function club(name, slug, sportsList, extra) {
  const admin = await person(`${name} Admin`);
  await svc.clubs.create(admin.actor, { name, slug, sports: sportsList });
  const members = [];
  for (let i = 0; i < extra; i++) {
    const p = await person(`${name} P${i}`);
    await p.call('POST', `/api/clubs/${slug}/join`, {});
    members.push(p);
  }
  return { admin, members, slug };
}
const win = [{ a: 21, b: 10 }, { a: 21, b: 12 }];
const lose = [{ a: 10, b: 21 }, { a: 12, b: 21 }];
const orgId = async (slug) => (await db.query('SELECT id FROM orgs WHERE slug = $1', [slug]))[0].id;

test('a badminton season between three clubs: enter, teams, start, fixtures, table, champions', async () => {
  const host = await club('Adyar Shuttlers', 'adyar-shuttlers', ['badminton'], 2);
  const b = await club('Besant Birdies', 'besant-birdies', ['badminton'], 2);
  const c = await club('Chetpet Smash', 'chetpet-smash', ['badminton'], 2);
  assert.equal((await host.members[0].call('POST', '/api/clubs/adyar-shuttlers/seasons', { sport: 'badminton' })).status, 403);
  let r = await host.admin.call('POST', '/api/clubs/adyar-shuttlers/seasons', { sport: 'badminton', tie: { format: '1s2d' }, name: 'Chennai Club League' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let s = r.data;
  assert.deepEqual([s.status, s.clubs.map((x) => x.name), s.need, s.can.start], ['open', ['Adyar Shuttlers'], 4, true]);
  assert.equal((await fetch(`${base}/img/season/${s.id}.png`)).status, 200);
  // Enter: admins of other clubs; not twice; the host is told.
  assert.equal((await b.members[0].call('POST', `/api/seasons/${s.id}/enter`, { club: 'besant-birdies' })).status, 403);
  s = (await b.admin.call('POST', `/api/seasons/${s.id}/enter`, { club: 'besant-birdies' })).data;
  assert.equal((await b.admin.call('POST', `/api/seasons/${s.id}/enter`, { club: 'besant-birdies' })).status, 409);
  assert.ok((await host.admin.call('GET', '/api/notifications')).data.items.some((x) => x.title === 'Besant Birdies entered Chennai Club League'));
  // Too few clubs; teams not picked.
  assert.equal((await host.admin.call('POST', `/api/seasons/${s.id}/start`)).status, 400);
  await c.admin.call('POST', `/api/seasons/${s.id}/enter`, { club: 'chetpet-smash' });
  assert.match((await host.admin.call('POST', `/api/seasons/${s.id}/start`)).data.error, /hasn't picked a team/);
  assert.equal((await b.admin.call('POST', `/api/seasons/${s.id}/start`)).status, 403);
  const ids = (x) => [x.admin.id, ...x.members.map((m) => m.id)];
  for (const [x, slug] of [[host, 'adyar-shuttlers'], [b, 'besant-birdies'], [c, 'chetpet-smash']]) {
    r = await x.admin.call('POST', `/api/seasons/${s.id}/team`, { club: slug, members: ids(x) });
    assert.equal(r.status, 400, '1 singles + 2 doubles needs 4 players');
  }
  // A fourth member each.
  for (const [x, slug] of [[host, 'adyar-shuttlers'], [b, 'besant-birdies'], [c, 'chetpet-smash']]) {
    const p = await person(`${slug} Extra`);
    await p.call('POST', `/api/clubs/${slug}/join`, {});
    x.members.push(p);
    r = await x.admin.call('POST', `/api/seasons/${s.id}/team`, { club: slug, members: ids(x) });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  r = await host.admin.call('POST', `/api/seasons/${s.id}/start`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  s = r.data;
  assert.deepEqual([s.status, s.fixtures.length, s.table.length], ['on', 3, 3]);
  assert.equal((await c.admin.call('POST', `/api/seasons/${s.id}/enter`, { club: 'chetpet-smash' })).status, 409);
  // Teams after the start: add, not remove.
  assert.equal((await b.admin.call('POST', `/api/seasons/${s.id}/team`, { club: 'besant-birdies', members: ids(b).reverse() })).status, 409);
  // Play every fixture: Adyar win both, Besant beat Chetpet.
  const name = { 'Adyar Shuttlers': host, 'Besant Birdies': b, 'Chetpet Smash': c };
  const rank = ['Adyar Shuttlers', 'Besant Birdies', 'Chetpet Smash'];
  for (const f of s.fixtures) {
    const tp = `/api/tournaments/${s.tournamentId}/matches/${f.id}/tie`;
    const ca = name[f.a];
    const cb = name[f.b];
    assert.equal((await ca.admin.call('PUT', `${tp}/lineup`, { side: 'a', slots: [[0, 1], [0], [2, 3]] })).status, 200);
    assert.equal((await cb.admin.call('PUT', `${tp}/lineup`, { side: 'b', slots: [[0, 1], [0], [2, 3]] })).status, 200);
    const aWins = rank.indexOf(f.a) < rank.indexOf(f.b);
    // An admin of a club in the season scores (umpire).
    for (const k of [0, 1]) {
      r = await cb.admin.call('POST', `${tp}/rubbers/${k}/result`, { games: aWins ? win : lose });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
  }
  s = (await c.members[0].call('GET', `/api/seasons/${s.id}`)).data;
  assert.equal(s.status, 'done');
  assert.deepEqual(s.table.map((x) => [x.name, x.won, x.points]), [['Adyar Shuttlers', 2, 4], ['Besant Birdies', 1, 2], ['Chetpet Smash', 0, 0]]);
  assert.deepEqual(s.champion, { name: 'Adyar Shuttlers', slug: 'adyar-shuttlers' });
  // Feeds: each club has its two results and the champions.
  const feed = async (slug) => (await svc.social.clubFeed(await orgId(slug), null)).items;
  const cf = await feed('chetpet-smash');
  assert.equal(cf.filter((x) => x.verb === 'season_match').length, 2);
  assert.equal(cf.filter((x) => x.verb === 'finish').length, 0, 'no podium posts');
  const won = cf.find((x) => x.verb === 'season_won');
  assert.equal(won.data.champion, 'Adyar Shuttlers');
  const card = await svc.cards.activity(won.id);
  assert.deepEqual([card.title, card.subtitle], ['Adyar Shuttlers', 'won Chennai Club League']);
  assert.ok((await b.members[0].call('GET', '/api/notifications')).data.items.some((x) => x.title === '🏆 Adyar Shuttlers won Chennai Club League'));
  const mine = (await host.admin.call('GET', '/api/clubs/besant-birdies/seasons')).data;
  assert.deepEqual(mine.items.map((x) => [x.name, x.place, x.status]), [['Chennai Club League', 2, 'done']]);
  assert.equal((await fetch(`${base}/img/season/${s.id}.png`)).status, 200);
  assert.equal((await fetch(`${base}/season/${s.id}`)).status, 200);
});

test('a football season: clubs leave before the start, results reopen on undo', async () => {
  const x = await club('Xavier FC', 'xavier-fc', ['football'], 0);
  const y = await club('Yelagiri FC', 'yelagiri-fc', ['football'], 0);
  const z = await club('Zion FC', 'zion-fc', ['football'], 0);
  let s = (await x.admin.call('POST', '/api/clubs/xavier-fc/seasons', { sport: 'football' })).data;
  assert.deepEqual([s.kind, s.tie, s.name], ['friendly', null, 'Xavier FC Football League']);
  await y.admin.call('POST', `/api/seasons/${s.id}/enter`, { club: 'yelagiri-fc' });
  await z.admin.call('POST', `/api/seasons/${s.id}/enter`, { club: 'zion-fc' });
  s = (await z.admin.call('POST', `/api/seasons/${s.id}/leave`, { club: 'zion-fc' })).data;
  assert.equal(s.clubs.length, 2);
  await z.admin.call('POST', `/api/seasons/${s.id}/enter`, { club: 'zion-fc' });
  for (const [c, slug] of [[x, 'xavier-fc'], [y, 'yelagiri-fc'], [z, 'zion-fc']]) await c.admin.call('POST', `/api/seasons/${s.id}/team`, { club: slug, members: [c.admin.id] });
  s = (await x.admin.call('POST', `/api/seasons/${s.id}/start`)).data;
  const [f] = s.fixtures;
  let r = await x.admin.call('POST', `/api/tournaments/${s.tournamentId}/matches/${f.id}/result`, { games: [{ a: 2, b: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const posts = async () => (await db.query(`SELECT org_id FROM activity WHERE verb = 'season_match' AND object_id = $1`, [String(s.id)])).length;
  assert.equal(await posts(), 2, 'on both clubs\' feeds');
  await x.admin.call('POST', `/api/tournaments/${s.tournamentId}/matches/${f.id}/undo`, {});
  assert.equal(await posts(), 0, 'off the feeds when undone');
});
