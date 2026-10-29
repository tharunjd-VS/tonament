'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const vercelHandler = require('../api/index');

// One database for the whole file (embedded Postgres, or a real server via
// TEST_DATABASE_URL); each test makes its own tournaments.
let db;
let app;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  app = createApp(db);
  svc = app.service;
});
test.after(() => db.close());

// Plays a match to completion with `side` winning every rally.
async function play(id, key, matchId, side = 'a') {
  let m;
  do m = await svc.rally(id, key, matchId, side);
  while (m.status !== 'done');
  return m;
}

// Tournament owner used by most tests (membership is keyed by email).
const OWNER = { user: { id: 1, email: 'owner@example.com', name: 'Owner', isAdmin: false } };

const names = (n) => Array.from({ length: n }, (_, i) => `Player ${i + 1}`);

test('quick create: name, sport, date and events only; the rest are defaults', async () => {
  const { id } = await svc.createTournament(OWNER, {
    name: 'Quick Open', sport: 'pickleball', startsOn: '2030-11-02',
    events: [{ discipline: 'singles', gender: 'men', age: 'Open', level: 'Open' }, { discipline: 'doubles', gender: 'mixed', age: 'Open', level: 'Open' }],
  });
  const t = await svc.getTournament(id, OWNER);
  assert.deepEqual(t.events.map((e) => e.name), ["Men's Singles", 'Mixed Doubles']);
  assert.equal(t.startsOn, '2030-11-02');
  assert.equal(t.venue, null);
  assert.equal(t.visibility, 'private');
  const [ev] = t.events;
  assert.equal(ev.format, 'league_knockout');
  assert.equal(ev.config.selfEntry, true);
  assert.equal(ev.config.leagueDraws, false);
  assert.deepEqual(ev.config.scoring, require('../server/sports/pickleball').defaults);
});

test('league + knockout: full tournament from draw to champion', async () => {
  const key = OWNER;
  const { id } = await svc.createTournament(OWNER, {
    visibility: 'public', name: 'Club Open',
    format: 'league_knockout',
    groups: 2,
    qualifiers: 2,
  });
  await svc.addEntries(id, key, names(6));
  let t = await svc.start(id, key);
  assert.equal(t.status, 'league');
  assert.equal(t.groups.length, 2);
  assert.deepEqual(t.groups.map((g) => g.standings.length), [3, 3]);
  const league = t.matches.filter((m) => m.stage === 'league');
  assert.equal(league.length, 6); // 3 per group of 3

  await assert.rejects(svc.startKnockout(id, key), /still to be played/);

  // The lower-numbered (higher seeded) player wins every league match.
  for (const m of league) {
    const better = Number(m.a.name.split(' ')[1]) < Number(m.b.name.split(' ')[1]) ? 'a' : 'b';
    await play(id, key, m.id, better);
  }
  t = await svc.getTournament(id, key);
  assert.equal(t.status, 'league');
  // Snake draw: A = 1, 4, 5 ; B = 2, 3, 6
  assert.deepEqual(t.groups[0].standings.map((r) => r.name), ['Player 1', 'Player 4', 'Player 5']);
  assert.deepEqual(t.groups[1].standings.map((r) => r.name), ['Player 2', 'Player 3', 'Player 6']);

  t = await svc.startKnockout(id, key);
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
  await assert.rejects(svc.undo(id, key, league[0].id), /locked/);

  await play(id, key, semis[0].id, 'b'); // Player 3 upsets Player 1
  await play(id, key, semis[1].id, 'a');
  t = await svc.getTournament(id, key);
  const final = t.matches.find((m) => m.roundName === 'Final');
  assert.deepEqual([final.a.name, final.b.name], ['Player 3', 'Player 2']);

  await play(id, key, final.id, 'b');
  t = await svc.getTournament(id, key);
  assert.equal(t.status, 'completed');
  assert.equal(t.champion.name, 'Player 2');

  // Undoing the final's last point reopens the tournament.
  await svc.undo(id, key, final.id);
  t = await svc.getTournament(id, key);
  assert.equal(t.status, 'knockout');
  assert.equal(t.champion, null);
});

test('knockout only with byes', async () => {
  const key = OWNER;
  const { id } = await svc.createTournament(OWNER, { visibility: 'public', name: 'Cup', format: 'knockout' });
  await svc.addEntries(id, key, names(5));
  const t = await svc.start(id, key);
  const ko = t.matches;
  assert.equal(ko.length, 7); // 8-draw: 4 + 2 + 1
  assert.equal(ko.filter((m) => m.status === 'bye').length, 3);
  const playable = ko.filter((m) => m.status === 'scheduled' && m.a && m.b);
  assert.deepEqual(playable.map((m) => `${m.roundName}: ${m.a.name} v ${m.b.name}`), [
    'Quarter-finals: Player 4 v Player 5',
    'Semi-finals: Player 2 v Player 3',
  ]);
  const semi = ko.find((m) => m.roundName === 'Semi-finals' && m.slot === 0);
  assert.equal(semi.a.name, 'Player 1');
  assert.equal(semi.b, null);
});

test('undo of a knockout win is blocked once the next match starts', async () => {
  const key = OWNER;
  const { id } = await svc.createTournament(OWNER, { visibility: 'public', name: 'Cup', format: 'knockout' });
  await svc.addEntries(id, key, names(4));
  const t = await svc.start(id, key);
  const [s1, s2] = t.matches.filter((m) => m.round === 1);
  await play(id, key, s1.id);
  await play(id, key, s2.id);
  const final = (await svc.getTournament(id, key)).matches.find((m) => m.round === 2);
  await svc.rally(id, key, final.id, 'a');
  await assert.rejects(svc.undo(id, key, s1.id), /next-round match has already started/);
  await svc.undo(id, key, final.id);
  const reopened = await svc.undo(id, key, s1.id);
  assert.equal(reopened.status, 'live');
  const after = (await svc.getTournament(id, key)).matches.find((m) => m.round === 2);
  assert.equal(after.a, null);
});

test('league only completes when all matches are played', async () => {
  const key = OWNER;
  const { id } = await svc.createTournament(OWNER, {
    visibility: 'public', name: 'Ladder',
    format: 'league',
    groups: 1,
    scoring: { bestOf: 1, points: 11, cap: 15 },
  });
  await svc.addEntries(id, key, names(4));
  let t = await svc.start(id, key);
  for (const m of t.matches) await play(id, key, m.id, 'a');
  t = await svc.getTournament(id, key);
  assert.equal(t.status, 'completed');
  assert.equal(t.champion.name, t.groups[0].standings[0].name);
});

test('simultaneous rallies on one match are all counted', async () => {
  const key = OWNER;
  const { id } = await svc.createTournament(OWNER, { visibility: 'public', name: 'Race', format: 'knockout' });
  await svc.addEntries(id, key, ['A', 'B']);
  const [m] = (await svc.start(id, key)).matches;
  await Promise.all(Array.from({ length: 10 }, (_, i) => svc.rally(id, key, m.id, i % 2 ? 'b' : 'a')));
  const after = (await svc.getTournament(id)).matches[0];
  assert.equal(after.rallies, 10);
  assert.deepEqual([after.score.games[0].a, after.score.games[0].b], [5, 5]);
});

test('validation and permissions', async () => {
  await assert.rejects(svc.createTournament(OWNER, { visibility: 'public', name: '  ' }), /required/);
  await assert.rejects(svc.createTournament({}, { name: 'X' }), /Sign in/);
  const key = OWNER;
  const { id } = await svc.createTournament(OWNER, { visibility: 'public', name: 'X', groups: 2, qualifiers: 3 });
  await assert.rejects(svc.addEntries(id, { key: 'wrong' }, ['A']), /organiser/);
  await svc.addEntries(id, key, ['A', 'B', 'C']);
  await assert.rejects(svc.addEntries(id, key, ['a']), /already entered/);
  await assert.rejects(svc.start(id, key), /at least 4 entries/);
  await svc.addEntries(id, key, ['D']);
  await assert.rejects(svc.start(id, key), /at most 2 can qualify/);
  await svc.updateSettings(id, key, { qualifiers: 1 });
  const t = await svc.start(id, key);
  assert.equal(t.status, 'league');
  await assert.rejects(svc.addEntries(id, key, ['E']), /locked/);
  assert.equal((await svc.getTournament(id)).can.manage, false);
  assert.equal((await svc.getTournament(id, key)).can.manage, true);
});

test('reorder entries sets the seeding', async () => {
  const key = OWNER;
  const { id } = await svc.createTournament(OWNER, { visibility: 'public', name: 'X' });
  let t = await svc.addEntries(id, key, ['A', 'B', 'C']);
  const ids = t.entries.map((e) => e.id).reverse();
  t = await svc.reorderEntries(id, key, ids);
  assert.deepEqual(t.entries.map((e) => e.name), ['C', 'B', 'A']);
  await assert.rejects(svc.reorderEntries(id, key, ids.slice(1)), /every entry/);
});

test('roles: owner, organiser, umpire, share links and site admin', async () => {
  const org = { user: { email: 'org@example.com', isAdmin: false } };
  const ump = { user: { email: 'ump@example.com', isAdmin: false } };
  const stranger = { user: { email: 'nobody@example.com', isAdmin: false } };
  const admin = { user: { email: 'boss@example.com', isAdmin: true } };
  const { id } = await svc.createTournament(OWNER, { visibility: 'public', name: 'Roles', format: 'knockout' });

  let t = await svc.getTournament(id, OWNER);
  assert.equal(t.role, 'owner');
  assert.deepEqual(t.can, { score: true, manage: true, delete: true, own: true, claim: false });
  const { organiser: orgLink, scorer: scorerLink } = t.links;

  // Team members are added by email, before or after they sign up.
  await svc.addMember(id, OWNER, { email: 'ORG@example.com ', role: 'organiser' });
  const { members: team } = await svc.addMember(id, OWNER, { email: 'ump@example.com', role: 'umpire' });
  assert.deepEqual(team.map((m) => [m.email, m.role]), [
    ['owner@example.com', 'owner'], ['org@example.com', 'organiser'], ['ump@example.com', 'umpire'],
  ]);
  await assert.rejects(svc.addMember(id, OWNER, { email: 'owner@example.com', role: 'umpire' }), /owner/);
  await assert.rejects(svc.addMember(id, ump, { email: 'x@example.com', role: 'umpire' }), /organisers/);

  // Organiser can manage but not delete; umpire can only score.
  await svc.addEntries(id, org, ['A', 'B']);
  await assert.rejects(svc.addEntries(id, ump, ['C']), /organisers/);
  await assert.rejects(svc.addEntries(id, stranger, ['C']), /organisers/);
  await assert.rejects(svc.addEntries(id, {}, ['C']), /Sign in/);
  t = await svc.start(id, org);
  const match = t.matches[0];
  assert.equal((await svc.rally(id, ump, match.id, 'a')).rallies, 1);
  await assert.rejects(svc.rally(id, stranger, match.id, 'a'), /team/);
  t = await svc.getTournament(id, ump);
  assert.equal(t.role, 'umpire');
  assert.equal(t.links, null); // umpires don't see share links
  await assert.rejects(svc.deleteTournament(id, org), /owner/);

  // Share links still work without an account.
  assert.equal((await svc.rally(id, { key: scorerLink }, match.id, 'b')).rallies, 2);
  await assert.rejects(svc.startKnockout(id, { key: scorerLink }), /organisers/);
  assert.equal((await svc.getTournament(id, { key: orgLink })).can.manage, true);
  assert.equal((await svc.getTournament(id, { key: orgLink })).can.delete, false); // has an owner

  // Public view reveals no links or roles.
  t = await svc.getTournament(id, null);
  assert.equal(t.links, undefined);
  assert.equal(t.can.score, false);

  // Removing a member takes their access away; the owner cannot be removed.
  const umpRow = (await svc.listMembers(id, OWNER)).find((m) => m.email === 'ump@example.com');
  await svc.removeMember(id, org, umpRow.id);
  await assert.rejects(svc.rally(id, ump, match.id, 'a'), /team/);
  const ownerRow = (await svc.listMembers(id, OWNER)).find((m) => m.role === 'owner');
  await assert.rejects(svc.removeMember(id, org, ownerRow.id), /owner cannot be removed/);

  // Site admin can do anything.
  assert.equal((await svc.getTournament(id, admin)).role, 'admin');
  await svc.deleteTournament(id, admin);
  await assert.rejects(svc.getTournament(id), /not found/);
});

test('ownerless tournaments can be claimed with the organiser link', async () => {
  const { id } = await svc.createTournament(OWNER, { visibility: 'public', name: 'Legacy' });
  const { organiser: link } = (await svc.getTournament(id, OWNER)).links;
  await db.query(`DELETE FROM members WHERE tournament_id = $1`, [id]); // as if created before accounts
  const me = { user: { email: 'new-owner@example.com', isAdmin: false } };

  assert.equal((await svc.getTournament(id, { key: link })).can.delete, true); // link holder may delete when ownerless
  await assert.rejects(svc.claim(id, me), /cannot be claimed/); // needs the link
  const t = await svc.getTournament(id, { ...me, key: link });
  assert.equal(t.can.claim, true);
  const claimed = await svc.claim(id, { ...me, key: link });
  assert.equal(claimed.role, 'owner');
  assert.equal((await svc.getTournament(id, me)).role, 'owner');
  assert.deepEqual((await svc.myTournaments(me)).map((x) => [x.id, x.role]), [[id, 'owner']]);
});

// ---------- HTTP

async function withServer(fn, handler = app.handle) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // Tiny client with its own cookie jar.
  const client = () => {
    let cookie = '';
    return async (method, path, body, headers = {}) => {
      const h = { 'Content-Type': 'application/json', ...headers };
      if (cookie) h.Cookie = cookie;
      const res = await fetch(base + path, { method, headers: h, body: body && JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, cache: res.headers.get('cache-control'), setCookie: set, data: await res.json() };
    };
  };
  try {
    await fn({ base, client });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('HTTP: sign up, sign in, sessions and lockout', async () => {
  await withServer(async ({ client }) => {
    const alice = client();
    assert.equal((await alice('POST', '/api/auth/signup', { name: 'Alice', email: 'bad', password: 'longenough' })).status, 400);
    assert.equal((await alice('POST', '/api/auth/signup', { name: 'Alice', email: 'a@x.dev', password: 'short' })).status, 400);
    const signed = await alice('POST', '/api/auth/signup', { name: ' Alice ', email: 'Alice@X.dev', password: 'correct horse' });
    assert.equal(signed.status, 200);
    assert.deepEqual(signed.data.user, { id: signed.data.user.id, email: 'alice@x.dev', name: 'Alice', isAdmin: false });
    assert.match(signed.setCookie, /^tn_session=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=15552000$/);
    assert.equal((await alice('GET', '/api/auth/me')).data.user.email, 'alice@x.dev');
    assert.equal((await alice('POST', '/api/auth/signup', { name: 'A2', email: 'alice@x.dev', password: 'whatever12' })).status, 409);

    await alice('POST', '/api/auth/logout');
    assert.equal((await alice('GET', '/api/auth/me')).data.user, null);
    assert.equal((await alice('POST', '/api/auth/login', { email: 'alice@x.dev', password: 'wrong pass' })).status, 401);
    assert.equal((await alice('POST', '/api/auth/login', { email: 'ghost@x.dev', password: 'whatever12' })).status, 401);
    const back = await alice('POST', '/api/auth/login', { email: 'ALICE@x.dev', password: 'correct horse' });
    assert.equal(back.status, 200);
    assert.equal((await alice('GET', '/api/auth/me')).data.user.name, 'Alice');

    // 10 wrong passwords lock the account for a while, even for the right one.
    const mallory = client();
    for (let i = 0; i < 10; i++) await mallory('POST', '/api/auth/login', { email: 'alice@x.dev', password: `guess-${i}` });
    const locked = await mallory('POST', '/api/auth/login', { email: 'alice@x.dev', password: 'correct horse' });
    assert.equal(locked.status, 429);
  });
});

test('HTTP: roles, invites before signup, caching and cross-site protection', async () => {
  process.env.ADMIN_EMAILS = 'root@x.dev';
  try {
    await withServer(async ({ base, client }) => {
      const owner = client();
      const anon = client();
      assert.equal((await anon('POST', '/api/tournaments', { name: 'Nope' })).status, 401);
      await owner('POST', '/api/auth/signup', { name: 'Olu', email: 'olu@x.dev', password: 'password123' });
      const created = await owner('POST', '/api/tournaments', { visibility: 'public', name: 'Live Test', format: 'knockout' });
      assert.equal(created.status, 201);
      const { id } = created.data;
      assert.match(id, /^live-test-[0-9a-f]{6}$/);

      // Invite an umpire who has no account yet; access arrives when they sign up.
      await owner('POST', `/api/tournaments/${id}/members`, { email: 'uma@x.dev', role: 'umpire' });
      await owner('POST', `/api/tournaments/${id}/entries`, { names: ['A', 'B'] });
      const started = await owner('POST', `/api/tournaments/${id}/start`);
      const match = started.data.matches[0];
      const uma = client();
      assert.equal((await uma('POST', `/api/tournaments/${id}/matches/${match.id}/rally`, { side: 'a' })).status, 401);
      await uma('POST', '/api/auth/signup', { name: 'Uma', email: 'uma@x.dev', password: 'password123' });
      const scored = await uma('POST', `/api/tournaments/${id}/matches/${match.id}/rally`, { side: 'b' });
      assert.equal(scored.status, 200);
      assert.equal(scored.cache, 'no-store');
      assert.equal((await uma('POST', `/api/tournaments/${id}/start`)).status, 403);
      assert.deepEqual((await uma('GET', '/api/me/tournaments')).data.map((x) => x.role), ['umpire']);

      // Public copy is cacheable and anonymous even with a session cookie;
      // ?me=1 is personal and never cached.
      const pub = await owner('GET', `/api/tournaments/${id}`);
      assert.match(pub.cache, /s-maxage=1/);
      assert.equal(pub.data.role, null);
      assert.equal(pub.data.links, undefined);
      assert.equal(pub.data.matches[0].rallies, 1);
      const mine = await owner('GET', `/api/tournaments/${id}?me=1`);
      assert.equal(mine.cache, 'no-store');
      assert.equal(mine.data.role, 'owner');
      assert.ok(mine.data.links.scorer);

      // Scorer link works with no account at all.
      const viaLink = await anon('POST', `/api/tournaments/${id}/matches/${match.id}/rally`, { side: 'a' }, { 'X-Admin-Key': mine.data.links.scorer });
      assert.equal(viaLink.status, 200);

      // Requests from other websites are refused.
      const evil = await owner('POST', `/api/tournaments/${id}/matches/${match.id}/rally`, { side: 'a' }, { Origin: 'https://evil.example' });
      assert.equal(evil.status, 403);

      // Site admin (from ADMIN_EMAILS) sees all users.
      assert.equal((await owner('GET', '/api/admin/users')).status, 403);
      const root = client();
      await root('POST', '/api/auth/signup', { name: 'Root', email: 'root@x.dev', password: 'password123' });
      const users = await root('GET', '/api/admin/users');
      assert.equal(users.status, 200);
      const olu = users.data.users.find((u) => u.email === 'olu@x.dev');
      assert.equal(olu.owned, 1);
      assert.equal(olu.password_hash, undefined);

      assert.equal((await anon('GET', '/api/tournaments/nope')).status, 404);
      const page = await fetch(`${base}/t/whatever`);
      assert.match(page.headers.get('content-type'), /text\/html/);
      assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
      assert.equal((await uma('DELETE', `/api/tournaments/${id}`)).status, 403);
      assert.equal((await owner('DELETE', `/api/tournaments/${id}`)).status, 200);
    });
  } finally {
    delete process.env.ADMIN_EMAILS;
  }
});

test('passwords are stored as scrypt hashes', async () => {
  const { hashPassword, verifyPassword } = require('../server/auth');
  const stored = await hashPassword('s3cret-pass');
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!stored.includes('s3cret-pass'));
  assert.equal(await verifyPassword('s3cret-pass', stored), true);
  assert.equal(await verifyPassword('s3cret-pasS', stored), false);
});

test('Vercel entry: rewritten path, pre-parsed body and cookies', async () => {
  process.env.DATABASE_URL = ':memory:';
  const invoke = (method, url, body, cookie) =>
    new Promise((resolve) => {
      const req = { method, url, headers: { 'content-type': 'application/json', ...(cookie && { cookie }) }, body };
      const res = {
        statusCode: 200,
        headers: {},
        writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
        end(data) { resolve({ status: this.statusCode, headers: this.headers, data: JSON.parse(data) }); },
      };
      vercelHandler(req, res);
    });
  try {
    const signed = await invoke('POST', '/api/index?__path=auth/signup', { name: 'V', email: 'v@x.dev', password: 'password123' });
    assert.equal(signed.status, 200);
    const cookie = signed.headers['set-cookie'][0].split(';')[0];
    const created = await invoke('POST', '/api/index?__path=tournaments', { name: 'On Vercel' }, cookie);
    assert.equal(created.status, 201);
    const got = await invoke('GET', `/api/index?__path=tournaments/${created.data.id}&me=1`, undefined, cookie);
    assert.equal(got.status, 200);
    assert.equal(got.data.name, 'On Vercel');
    assert.equal(got.data.role, 'owner');
  } finally {
    delete process.env.DATABASE_URL;
  }
});

// ---------- email

function fakeMailer() {
  return { enabled: true, sent: [], async send(m) { this.sent.push(m); return { sent: true }; } };
}

test('password reset by email', async () => {
  const mailer = fakeMailer();
  const mailApp = createApp(db, { mailer });
  process.env.APP_URL = 'https://tonament.example/';
  try {
    await withServer(async ({ client }) => {
      const me = client();
      const otherDevice = client();
      await me('POST', '/api/auth/signup', { name: 'Rita', email: 'rita@x.dev', password: 'old-password' });
      await otherDevice('POST', '/api/auth/login', { email: 'rita@x.dev', password: 'old-password' });
      assert.equal((await me('GET', '/api/auth/me')).data.emailEnabled, true);

      // Unknown emails get the same answer and no email.
      const anon = client();
      assert.deepEqual((await anon('POST', '/api/auth/forgot', { email: 'nobody@x.dev' })).data, { ok: true });
      assert.equal(mailer.sent.length, 0);

      // Links point at APP_URL even if the Host header is forged.
      assert.equal((await anon('POST', '/api/auth/forgot', { email: 'RITA@x.dev' }, { 'X-Forwarded-Host': 'evil.example' })).status, 200);
      assert.equal(mailer.sent.length, 1);
      const mail = mailer.sent[0];
      assert.equal(mail.to, 'rita@x.dev');
      assert.match(mail.subject, /Reset your Tonament password/);
      const [link, token] = mail.text.match(/https:\/\/tonament\.example\/#\/reset\?token=([\w-]+)/);
      assert.ok(mail.html.includes(link));
      assert.ok(mail.html.includes('src="https://tonament.example/brand/email-logo.png"')); // logo from the same site as the link

      // At most one email a minute.
      await anon('POST', '/api/auth/forgot', { email: 'rita@x.dev' });
      assert.equal(mailer.sent.length, 1);

      assert.equal((await anon('POST', '/api/auth/reset', { token, password: 'short' })).status, 400);
      assert.equal((await anon('POST', '/api/auth/reset', { token: 'forged', password: 'new-password' })).status, 400);
      const reset = await anon('POST', '/api/auth/reset', { token, password: 'new-password' });
      assert.equal(reset.status, 200);
      assert.equal(reset.data.user.email, 'rita@x.dev');
      assert.equal((await anon('GET', '/api/auth/me')).data.user.email, 'rita@x.dev'); // signed in

      // Other sessions are signed out; the link works only once; old password is gone.
      assert.equal((await otherDevice('GET', '/api/auth/me')).data.user, null);
      assert.equal((await me('GET', '/api/auth/me')).data.user, null);
      assert.equal((await anon('POST', '/api/auth/reset', { token, password: 'another-pass' })).status, 400);
      assert.equal((await client()('POST', '/api/auth/login', { email: 'rita@x.dev', password: 'old-password' })).status, 401);
      assert.equal((await client()('POST', '/api/auth/login', { email: 'rita@x.dev', password: 'new-password' })).status, 200);

      // Expired links are rejected.
      await db.query(`DELETE FROM password_resets`);
      await anon('POST', '/api/auth/forgot', { email: 'rita@x.dev' });
      const [, token2] = mailer.sent[1].text.match(/token=([\w-]+)/);
      await db.query(`UPDATE password_resets SET expires_at = now() - interval '1 second'`);
      assert.equal((await anon('POST', '/api/auth/reset', { token: token2, password: 'new-password-2' })).status, 400);
    }, mailApp.handle);
  } finally {
    delete process.env.APP_URL;
  }
});

test('team invites are emailed', async () => {
  const mailer = fakeMailer();
  const mailApp = createApp(db, { mailer });
  process.env.APP_URL = 'https://tonament.example';
  try {
    await withServer(async ({ client }) => {
      const owner = client();
      await owner('POST', '/api/auth/signup', { name: 'Omar <Owner>', email: 'omar@x.dev', password: 'password123' });
      await client()('POST', '/api/auth/signup', { name: 'Has Account', email: 'has@x.dev', password: 'password123' });
      const { id } = (await owner('POST', '/api/tournaments', { visibility: 'public', name: 'Invite Cup' })).data;

      const added = await owner('POST', `/api/tournaments/${id}/members`, { email: 'new@x.dev', role: 'umpire' });
      assert.equal(added.data.emailed, true);
      assert.equal(added.data.members.length, 2);
      let mail = mailer.sent.at(-1);
      assert.equal(mail.to, 'new@x.dev');
      assert.equal(mail.subject, "You've been added to Invite Cup as umpire");
      assert.match(mail.text, /\.example\/signup\?next=%2Ft%2Finvite-cup-\w+&email=new%40x\.dev/);
      assert.ok(mail.html.includes('Omar &lt;Owner&gt;')); // names are escaped

      await owner('POST', `/api/tournaments/${id}/members`, { email: 'has@x.dev', role: 'organiser' });
      mail = mailer.sent.at(-1);
      assert.match(mail.text, /\.example\/signin\?next=/);
      assert.match(mail.html, /Open the tournament/);

      // Same role again: no email. Role change: email. Adding yourself: no email.
      const count = mailer.sent.length;
      assert.equal((await owner('POST', `/api/tournaments/${id}/members`, { email: 'new@x.dev', role: 'umpire' })).data.emailed, false);
      assert.equal(mailer.sent.length, count);
      await owner('POST', `/api/tournaments/${id}/members`, { email: 'new@x.dev', role: 'organiser' });
      assert.equal(mailer.sent.length, count + 1);
    }, mailApp.handle);
  } finally {
    delete process.env.APP_URL;
  }
});

test('Resend request format, and no-op without an API key', async () => {
  const { createMailer } = require('../server/email');
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  const mailer = createMailer({ apiKey: 're_test', from: 'Tonament <noreply@tonament.com>', fetchImpl });
  assert.equal(mailer.enabled, true);
  await mailer.send({ to: 'a@x.dev', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test');
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'Tonament <noreply@tonament.com>', to: ['a@x.dev'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });

  const failing = createMailer({ apiKey: 're_test', fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'domain not verified' }) });
  await assert.rejects(failing.send({ to: 'a@x.dev', subject: 'x', html: 'x', text: 'x' }), /403: domain not verified/);

  const off = createMailer({ apiKey: '', logOnly: false });
  assert.equal(off.enabled, false);
  const log = console.log;
  console.log = () => {};
  try {
    assert.deepEqual(await off.send({ to: 'a@x.dev', subject: 'x', html: 'x', text: 'x' }), { sent: false });
  } finally {
    console.log = log;
  }
});

test('scoring with the expected rally count rejects stale or repeated requests', async () => {
  const { id } = await svc.createTournament(OWNER, { visibility: 'public', name: 'Stale', format: 'knockout' });
  await svc.addEntries(id, OWNER, ['A', 'B']);
  const [m] = (await svc.start(id, OWNER)).matches;
  let r = await svc.rally(id, OWNER, m.id, 'a', 0);
  assert.equal(r.log, 'a');
  // A retry of the same request (still saying at=0) is refused, not double-counted.
  await assert.rejects(svc.rally(id, OWNER, m.id, 'a', 0), (err) => err.status === 409 && err.code === 'stale');
  r = await svc.rally(id, OWNER, m.id, 'b', 1);
  assert.equal(r.log, 'ab');
  await assert.rejects(svc.undo(id, OWNER, m.id, 1), /changed on another device/);
  r = await svc.undo(id, OWNER, m.id, 2);
  assert.equal(r.log, 'a');
  assert.deepEqual([r.a.name, r.b.name], ['A', 'B']);
  // Without `at` (older clients) it still works.
  assert.equal((await svc.rally(id, OWNER, m.id, 'b')).log, 'ab');
});

test('one phone scores a match at a time: the other is turned away until it takes over', async () => {
  const { id } = await svc.createTournament(OWNER, { visibility: 'public', name: 'One Phone', format: 'knockout' });
  await svc.addEntries(id, OWNER, ['A', 'B']);
  const [m] = (await svc.start(id, OWNER)).matches;
  const phone1 = { ...OWNER, device: 'phone-one-1234' };
  const phone2 = { ...OWNER, device: 'phone-two-5678' };
  const umpireLink = { user: null, key: (await db.query('SELECT scorer_key FROM tournaments WHERE id = $1', [id]))[0].scorer_key, device: 'borrowed-phone-99' };
  let r = await svc.rally(id, phone1, m.id, 'a', 0);
  assert.deepEqual(r.scorer, { name: 'Owner', device: 'phone-one-1234' });
  // Phone 2 can't add a point, undo, or enter a result while phone 1 is scoring.
  await assert.rejects(svc.rally(id, phone2, m.id, 'b', 1), (err) => err.status === 409 && err.code === 'claimed' && /Owner is scoring this match/.test(err.message));
  await assert.rejects(svc.undo(id, phone2, m.id, 1), (err) => err.code === 'claimed');
  await assert.rejects(svc.setResult(id, umpireLink, m.id, [{ a: 21, b: 10 }], 1), (err) => err.code === 'claimed');
  r = await svc.rally(id, phone1, m.id, 'b', 1); // phone 1 carries on
  assert.equal(r.log, 'ab');
  // The scorer-link phone takes over: now phone 1 is turned away.
  r = await svc.takeOverScoring(id, umpireLink, m.id);
  assert.deepEqual(r.scorer, { name: 'A scorer-link phone', device: 'borrowed-phone-99' });
  await assert.rejects(svc.rally(id, phone1, m.id, 'a', 2), (err) => err.code === 'claimed');
  r = await svc.rally(id, umpireLink, m.id, 'a', 2);
  assert.equal(r.log, 'aba');
  // A phone that's gone quiet for 3 minutes lets go on its own.
  await db.query(`UPDATE matches SET scorer_seen_at = now() - interval '4 minutes' WHERE id = $1`, [m.id]);
  r = await svc.rally(id, phone2, m.id, 'b', 3);
  assert.equal(r.scorer.device, 'phone-two-5678');
  // An older app (no device id) is never blocked.
  assert.equal((await svc.rally(id, OWNER, m.id, 'a', 4)).log, 'ababa');
});

test('changing the match length mid-event: finished matches keep their result; decided ones end now', async () => {
  const { id } = await svc.createTournament(OWNER, { visibility: 'public', name: 'Wrong Length', format: 'knockout', scoring: { bestOf: 3, points: 21, cap: 30 } });
  await svc.addEntries(id, OWNER, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  let t = await svc.start(id, OWNER);
  const [m1, m2, m3, m4] = t.matches.filter((m) => m.round === 1).sort((x, y) => x.slot - y.slot);
  // A game to 21 that `w` wins 21-10: alternate points to 10-10, then `w` runs away with it.
  const game = (w) => `${(w === 'a' ? 'ab' : 'ba').repeat(10)}${w.repeat(11)}`;
  const play = async (m, log) => { let at = 0; for (const ch of log) await svc.rally(id, OWNER, m.id, ch, at++); };
  // m1 finished over 3 games (a lost game 1): best of 3 says A won.
  await play(m1, game('b') + game('a') + game('a'));
  // m2: game 1 won by b, game 2 under way. m3: half a game. m4 (and the later rounds): not started.
  await play(m2, game('b') + 'aaab');
  await play(m3, 'ababab');
  t = await svc.getTournament(id, OWNER);
  const before = t.matches.find((x) => x.id === m1.id);
  assert.equal(before.winner, before.a.id);
  // Preview first: nothing changes yet.
  const r = await svc.previewScoringChange(id, OWNER, { scoring: { bestOf: 1, points: 21, cap: 30 } });
  assert.deepEqual([r.finished, r.endsNow.length, r.inProgress, r.toCome], [1, 1, 1, 4]); // m4, 2 semis, the final
  await assert.rejects(svc.previewScoringChange(id, OWNER, { scoring: { bestOf: 3, points: 21, cap: 30 } }), /how it is already/);
  t = await svc.changeScoring(id, OWNER, { scoring: { bestOf: 1, points: 21, cap: 30 } });
  const get = (m) => t.matches.find((x) => x.id === m.id);
  // m1 keeps its 3-game result (under its own rules).
  assert.equal(get(m1).winner, before.a.id);
  assert.equal(get(m1).score.games.length, 3);
  assert.deepEqual(get(m1).rules.scoring.bestOf, 3);
  // m2 was decided by game 1: it ends now, B wins, and the extra points of game 2 are dropped.
  assert.equal(get(m2).status, 'done');
  assert.equal(get(m2).winner, get(m2).b.id);
  assert.equal(get(m2).score.games.length, 1);
  // m3 carries on to a single game; m4 will be one game.
  assert.equal(get(m3).status, 'live');
  assert.equal(get(m3).rules, null);
  assert.ok(t.config.scoringChanged && t.config.scoring.bestOf === 1);
  // Only the organiser can; umpires can't.
  const umpire = { user: null, key: (await db.query('SELECT scorer_key FROM tournaments WHERE id = $1', [id]))[0].scorer_key };
  await assert.rejects(svc.changeScoring(id, umpire, { scoring: { bestOf: 3, points: 21, cap: 30 } }), /organis|permission|Only/i);
});

// ---------- sport catalogue & requests

test('sport catalogue lists playable and upcoming sports', async () => {
  const sports = require('../server/sports');
  const list = sports.list();
  const badminton = list.find((s) => s.id === 'badminton');
  assert.equal(badminton.status, 'live');
  assert.ok(badminton.fields.length > 0);
  assert.deepEqual(list.filter((s) => s.status === 'live').map((s) => s.id), ['badminton', 'pickleball', 'table-tennis', 'squash', 'volleyball', 'beach-volleyball', 'throwball', 'sepak-takraw', 'football', 'futsal', 'hockey', 'kabaddi', 'basketball', 'tennis', 'padel', 'snooker', 'pool', 'carrom']);
  const later = list.find((s) => s.id === 'cricket');
  assert.equal(later.status, 'later');
  assert.equal(later.fields, undefined);
  assert.equal(sports.get('cricket'), null); // no rules yet
  await assert.rejects(svc.createTournament(OWNER, { visibility: 'public', name: 'CC Open', sport: 'cricket' }), /Cricket isn't available yet/);
  await assert.rejects(svc.createTournament(OWNER, { visibility: 'public', name: 'X', sport: 'quidditch' }), /Unknown sport/);
});

test('HTTP: request a sport (one vote per person, toggleable)', async () => {
  await withServer(async ({ client }) => {
    const anon = client();
    assert.equal((await anon('POST', '/api/sports/cricket/interest', {})).status, 401);
    const ana = client();
    const bo = client();
    await ana('POST', '/api/auth/signup', { name: 'Ana', email: 'ana.vote@x.dev', password: 'password123' });
    await bo('POST', '/api/auth/signup', { name: 'Bo', email: 'bo.vote@x.dev', password: 'password123' });
    const before = (await anon('GET', '/api/sports/interest')).data.counts.cricket || 0;

    let r = await ana('POST', '/api/sports/cricket/interest', {});
    assert.equal(r.status, 200);
    assert.equal(r.data.counts.cricket, before + 1);
    assert.deepEqual(r.data.mine, ['cricket']);
    r = await ana('POST', '/api/sports/cricket/interest', {}); // repeat: still one vote
    assert.equal(r.data.counts.cricket, before + 1);
    r = await bo('POST', '/api/sports/cricket/interest', { want: true });
    assert.equal(r.data.counts.cricket, before + 2);
    r = await ana('POST', '/api/sports/cricket/interest', { want: false }); // withdraw
    assert.equal(r.data.counts.cricket, before + 1);
    assert.deepEqual(r.data.mine, []);

    assert.deepEqual((await bo('GET', '/api/sports/interest')).data.mine, ['cricket']);
    assert.equal((await anon('GET', '/api/sports/interest')).data.mine.length, 0);
    assert.equal((await ana('POST', '/api/sports/badminton/interest', {})).status, 400); // already live
    assert.equal((await ana('POST', '/api/sports/quidditch/interest', {})).status, 404);
    assert.equal((await ana('POST', '/api/sports/cricket/interest', {}, { Origin: 'https://evil.example' })).status, 403);
  });
});
