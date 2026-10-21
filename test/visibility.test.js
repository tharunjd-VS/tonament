'use strict';

// Who can see a tournament: private (team only), link only (anyone with the
// link, not listed) and public (also listed on the home page).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const { enterAs } = require('./players');

let db;
let app;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  app = createApp(db);
  svc = app.service;
});
test.after(() => db.close());
const enter = (...args) => enterAs(svc)(...args); // a player entering with their account

const OWNER = { user: { id: 1, email: 'owner@vis.test', name: 'Owner', isAdmin: false } };
const ORGANISER = { user: { id: 2, email: 'org@vis.test', name: 'Org', isAdmin: false } };
const UMPIRE = { user: { id: 3, email: 'ump@vis.test', name: 'Ump', isAdmin: false } };
const ADMIN = { user: { id: 4, email: 'admin@vis.test', name: 'Admin', isAdmin: true } };
const STRANGER = { user: { id: 5, email: 'someone@vis.test', name: 'Someone', isAdmin: false } };
const isPrivate = (e) => e.status === 404 && e.code === 'private';
const listed = async (id) => (await svc.listTournaments()).some((t) => t.id === id);

test('new tournaments are private: team only, not listed, no sign-ups', async () => {
  const { id } = await svc.createTournament(OWNER, { name: 'Secret Cup' });
  await svc.addMember(id, OWNER, { email: ORGANISER.user.email, role: 'organiser' });
  await svc.addMember(id, OWNER, { email: UMPIRE.user.email, role: 'umpire' });
  const own = await svc.getTournament(id, OWNER);
  assert.equal(own.visibility, 'private');
  assert.equal(own.can.own, true);

  assert.equal(await listed(id), false);
  await assert.rejects(svc.getTournament(id), isPrivate);
  await assert.rejects(svc.getTournament(id, STRANGER), isPrivate);
  await assert.rejects(svc.getTournament(id, { key: 'wrong' }), isPrivate);
  for (const who of [ORGANISER, UMPIRE, ADMIN, { key: own.links.organiser }, { key: own.links.scorer }]) {
    assert.equal((await svc.getTournament(id, who)).name, 'Secret Cup');
  }
  await assert.rejects(enter(id, { name: 'Asha', contact: 'asha@x.dev' }), isPrivate);
  assert.deepEqual((await svc.myTournaments(OWNER)).map((t) => [t.id, t.visibility]), [[id, 'private']]);
});

test('link only and public', async () => {
  const { id } = await svc.createTournament(OWNER, { name: 'Club Cup' });
  let t = await svc.setVisibility(id, OWNER, 'link');
  assert.equal(t.visibility, 'link');
  assert.equal(await listed(id), false);
  assert.equal((await svc.getTournament(id)).visibility, 'link');
  assert.equal((await enter(id, { name: 'Ben', contact: 'ben@x.dev' })).ok, true);

  t = await svc.setVisibility(id, OWNER, 'public');
  assert.equal(await listed(id), true);
  assert.equal((await enter(id, { name: 'Cy', contact: 'cy@x.dev' })).ok, true);
});

test('only the owner (or a site admin) can change visibility, at any stage', async () => {
  const { id } = await svc.createTournament(OWNER, { name: 'Owned Cup', format: 'knockout' });
  await svc.addMember(id, OWNER, { email: ORGANISER.user.email, role: 'organiser' });
  const { links } = await svc.getTournament(id, OWNER);
  await assert.rejects(svc.setVisibility(id, ORGANISER, 'public'), (e) => e.status === 403 && /Only the owner/.test(e.message));
  await assert.rejects(svc.setVisibility(id, { key: links.organiser }, 'public'), (e) => e.status === 403);
  await assert.rejects(svc.setVisibility(id, {}, 'public'), (e) => e.status === 401);
  await assert.rejects(svc.setVisibility(id, OWNER, 'hidden'), (e) => e.status === 400);
  await assert.rejects(svc.createTournament(OWNER, { name: 'Bad', visibility: 'hidden' }), (e) => e.status === 400);
  assert.equal((await svc.setVisibility(id, ADMIN, 'public')).visibility, 'public');

  // Still changeable after the start (e.g. hide a finished event).
  await svc.addEntries(id, OWNER, ['A', 'B']);
  await svc.start(id, OWNER);
  assert.equal((await svc.setVisibility(id, OWNER, 'private')).visibility, 'private');
  await assert.rejects(svc.getTournament(id), isPrivate);
});

test('tournaments created before visibility existed stay public', async () => {
  await db.query(
    `INSERT INTO tournaments (id, name, sport, format, config, admin_key, scorer_key)
     VALUES ('legacy-vis', 'Legacy', 'badminton', 'knockout', '{"scoring":{}}'::jsonb, 'k1', 'k2')`,
  );
  const [row] = await db.query(`SELECT visibility FROM tournaments WHERE id = 'legacy-vis'`);
  assert.equal(row.visibility, 'public');
  assert.equal(await listed('legacy-vis'), true);
});

test('HTTP: private tournaments are never cached and need a team member', async () => {
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Http Owner', email: 'http-owner@vis.test', password: 'password123' }),
    });
    const cookie = signup.headers.get('set-cookie').split(';')[0];
    const call = (method, path, body, headers = {}) =>
      fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    const { id } = await (await call('POST', '/api/tournaments', { name: 'Http Secret' }, { Cookie: cookie })).json();

    const anon = await call('GET', `/api/tournaments/${id}`);
    assert.equal(anon.status, 404);
    assert.equal(anon.headers.get('cache-control'), 'no-store');
    assert.equal((await anon.json()).code, 'private');
    assert.equal((await call('GET', `/api/tournaments/${id}?me=1`, undefined, { Cookie: cookie })).status, 200);

    const pub = await call('POST', `/api/tournaments/${id}/visibility`, { visibility: 'public' }, { Cookie: cookie });
    assert.equal(pub.status, 200);
    const open = await call('GET', `/api/tournaments/${id}`);
    assert.equal(open.status, 200);
    assert.match(open.headers.get('cache-control'), /s-maxage/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
