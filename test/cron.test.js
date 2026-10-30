'use strict';

// Scheduled jobs and the admin funnel: the secret (or a site admin) is
// needed; hourly settles what's due; weekly emails the admins once a week;
// every run is recorded. The funnel counts a seeded set of organisers.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

const ENV = { CRON_SECRET: 'cron-test-secret', ADMIN_EMAILS: 'boss@cron.test' };
const saved = {};
const fakeMailer = () => ({ enabled: true, sent: [], async send(m) { this.sent.push(m); return { sent: true }; } });
let db;
let mailer;
let server;
let base;
test.before(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  mailer = fakeMailer();
  server = http.createServer(createApp(db, { mailer }).handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const call = async (method, path, { body, cookie, auth } = {}) => {
  const r = await fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie && { Cookie: cookie }), ...(auth && { Authorization: auth }) },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
};
const signup = async (name, email, source) => (await call('POST', '/api/auth/signup', { body: { name, email, password: 'password123', source } })).cookie;

test('cron: the secret or a site admin; nobody else', async () => {
  assert.equal((await call('GET', '/api/cron/hourly')).status, 401);
  assert.equal((await call('GET', '/api/cron/hourly', { auth: 'Bearer wrong' })).status, 401);
  assert.equal((await call('GET', '/api/cron/nope', { auth: `Bearer ${ENV.CRON_SECRET}` })).status, 404);
  const player = await signup('Just Player', 'player@cron.test');
  assert.equal((await call('GET', '/api/cron/hourly', { cookie: player })).status, 401);
  const r = await call('GET', '/api/cron/hourly', { auth: `Bearer ${ENV.CRON_SECRET}` });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const boss = await signup('The Boss', 'boss@cron.test');
  assert.equal((await call('POST', '/api/cron/reminders', { cookie: boss, body: {} })).status, 200);
  const st = await call('GET', '/api/admin/cron', { cookie: boss });
  assert.equal(st.data.secret, true);
  assert.deepEqual(st.data.jobs.map((j) => [j.job, j.ok]), [['hourly', true], ['weekly', undefined], ['reminders', true]]);
});

test('cron hourly: unanswered challenges expire; running again changes nothing', async () => {
  const [a] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('ca@cron.test', 'Ca', 'x') RETURNING id`);
  const [b] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('cb@cron.test', 'Cb', 'x') RETURNING id`);
  const [old] = await db.query(`INSERT INTO challenges (sport, a1, b1, created_by, created_at) VALUES ('badminton', $1, $2, $1, now() - interval '15 days') RETURNING id`, [a.id, b.id]);
  const [fresh] = await db.query(`INSERT INTO challenges (sport, a1, b1, created_by) VALUES ('badminton', $1, $2, $1) RETURNING id`, [a.id, b.id]);
  const r = await call('GET', '/api/cron/hourly', { auth: `Bearer ${ENV.CRON_SECRET}` });
  assert.equal(r.data.challenges, 1);
  const rows = await db.query('SELECT id, status FROM challenges WHERE id = ANY($1::int[]) ORDER BY id', [[old.id, fresh.id]]);
  assert.deepEqual(rows.map((x) => x.status), ['expired', 'sent']);
  assert.equal((await call('GET', '/api/cron/hourly', { auth: `Bearer ${ENV.CRON_SECRET}` })).data.challenges, 0);
  const [{ n }] = await db.query(`SELECT COUNT(*)::int AS n FROM cron_runs WHERE job = 'hourly' AND ok`);
  assert.ok(n >= 3);
});

test('cron weekly: the admins get this week against last, once a week', async () => {
  const before = mailer.sent.length;
  const r = await call('GET', '/api/cron/weekly', { auth: `Bearer ${ENV.CRON_SECRET}` });
  assert.equal(r.status, 200);
  assert.equal(r.data.sent, 1);
  const mail = mailer.sent[before];
  assert.equal(mail.to, 'boss@cron.test');
  assert.match(mail.subject, /^Tonament this week: Sign-ups \d+ \(\d+\)/);
  assert.match(mail.text, /Tournaments created: \d+ \(\d+\)/);
  assert.match(mail.html, /This week/);
  // Again the same week: skipped (an admin can force it).
  assert.equal((await call('GET', '/api/cron/weekly', { auth: `Bearer ${ENV.CRON_SECRET}` })).data.skipped, 'already sent this week');
  assert.equal(mailer.sent.length, before + 1);
  const [log] = await db.query(`SELECT template, channel, status FROM message_log WHERE recipient = 'boss@cron.test' ORDER BY id DESC LIMIT 1`);
  assert.deepEqual(log, { template: 'admin.weekly', channel: 'email', status: 'sent' });
});

test('funnel: organisers by how far they got, sign-ups by source; site admins only', async () => {
  const boss = (await call('POST', '/api/auth/login', { body: { email: 'boss@cron.test', password: 'password123' } })).cookie;
  const repeat = await signup('Repeat Org', 'repeat@cron.test', { utm_source: 'whatsapp' });
  const once = await signup('Once Org', 'once@cron.test', { referrer: 'https://www.google.com/' });
  await signup('Never Org', 'never@cron.test', { s: 'wa' });
  const t1 = (await call('POST', '/api/tournaments', { cookie: repeat, body: { name: 'Repeat One', sport: 'badminton' } })).data.id;
  await call('POST', '/api/tournaments', { cookie: repeat, body: { name: 'Repeat Two', sport: 'badminton' } });
  await call('POST', '/api/tournaments', { cookie: once, body: { name: 'Once Only', sport: 'badminton' } });
  await db.query(`UPDATE tournaments SET status = 'completed' WHERE id = $1`, [t1]);
  await db.query(`INSERT INTO payments (tournament_id, user_email, amount, currency, status, kind, paid_at) VALUES ($1, 'repeat@cron.test', 49900, 'INR', 'paid', 'plan', now())`, [t1]);

  assert.equal((await call('GET', '/api/admin/funnel', { cookie: repeat })).status, 403);
  const f = (await call('GET', '/api/admin/funnel?days=7', { cookie: boss })).data;
  assert.equal(f.days, 7);
  const stage = Object.fromEntries(f.stages.map((x) => [x.key, x.n]));
  // Everyone who joined in this file: player, boss, two challengers, the three organisers.
  assert.deepEqual(stage, { signed: 7, created: 2, started: 1, finished: 1, repeat: 1, paid: 1 });
  const cls = Object.fromEntries(f.sources.map((x) => [x.class, x.n]));
  assert.equal(cls.social, 1);
  assert.equal(cls.search, 1);
  assert.equal(cls.shared, 1);
  assert.equal(cls.direct, 2);
  assert.equal(cls.unknown, 2, 'no first touch recorded');
  assert.deepEqual(f.tournamentSources.map((x) => [x.label, x.n]), [['whatsapp', 2], ['google.com', 1]]);
  assert.equal(f.activity.tournaments, 3);
  assert.ok(f.messages.some((m) => m.channel === 'email' && m.sent >= 1));
  assert.deepEqual(f.channels, { email: true, whatsapp: false, sms: false });
});
