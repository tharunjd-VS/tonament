'use strict';

// Referrals: an organiser's invite link gives a friend their first tournament
// on the Club plan; when the friend runs one (started with 10+ entries), the
// inviter earns a free upgrade credit (and an Open one for every 3rd friend).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

const ENV = { RAZORPAY_KEY_ID: 'rzp_test_ref', RAZORPAY_KEY_SECRET: 'secret_ref' };
const fakeMailer = () => ({ enabled: true, sent: [], async send(m) { this.sent.push(m); return { sent: true }; } });

let db;
let svc;
let mailer;
let server;
let base;
test.before(async () => {
  Object.assign(process.env, ENV);
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  mailer = fakeMailer();
  const app = createApp(db, { mailer });
  svc = app.service;
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
  for (const k of Object.keys(ENV)) delete process.env[k];
});

let n = 0;
async function signup(name, ref) {
  n += 1;
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@ref.test`, password: 'password123', ...(ref && { ref }) }),
  });
  const { user } = await res.json();
  return { user: { ...user, isAdmin: false } };
}
async function runTournament(actor, name, entries = 10) {
  const { id, gift } = await svc.createTournament(actor, { name, format: 'knockout', events: [{ discipline: 'singles', gender: 'open' }] });
  await svc.addEntries(id, actor, Array.from({ length: entries }, (_, i) => `${name} P${i + 1}`));
  await svc.start(id, actor);
  return { id, gift };
}
const credits = async (actor) => (await svc.referrals.summary(actor)).credits;

test('codes, the invite banner and who can be invited', async () => {
  const kavya = await signup('Kavya Raman');
  const s = await svc.referrals.summary(kavya);
  assert.match(s.code, /^kavya\d{2,3}$/);
  assert.equal((await svc.referrals.summary(kavya)).code, s.code); // stable
  assert.equal(s.url.endsWith(`/?ref=${s.code}`), true);
  assert.deepEqual(await (await fetch(`${base}/api/referrals/${s.code}`)).json(), { name: 'Kavya' }); // first name only
  assert.deepEqual(await (await fetch(`${base}/api/referrals/nobody123`)).json(), { name: null });
  // Unknown codes do nothing; nobody can invite themselves.
  const stranger = await signup('Stranger', 'nobody123');
  assert.equal((await db.query('SELECT referred_by FROM users WHERE id = $1', [stranger.user.id]))[0].referred_by, null);
  await svc.referrals.attach(db.query, kavya.user, s.code);
  assert.equal((await db.query('SELECT referred_by FROM users WHERE id = $1', [kavya.user.id]))[0].referred_by, null);
});

test('the friend: first tournament on the Club plan, the second on Free', async () => {
  const kavya = await signup('Kavya Two');
  const { code } = await svc.referrals.summary(kavya);
  const arun = await signup('Arun Kumar', code);
  const me = await (await fetch(`${base}/api/auth/me`)).json(); // (signed out here) no gift
  assert.equal(me.gift, null);
  assert.deepEqual(await svc.referrals.welcomeFor(arun.user), { from: 'Kavya', plan: 'Club', entries: 64 });
  const first = await svc.createTournament(arun, { name: 'Arun Open', visibility: 'public' });
  assert.deepEqual(first.gift, { from: 'Kavya', plan: 'Club', entries: 64 });
  assert.equal((await svc.getTournament(first.id, arun)).plan, 'club');
  const second = await svc.createTournament(arun, { name: 'Arun Two' });
  assert.equal(second.gift, undefined);
  assert.equal((await svc.getTournament(second.id, arun)).plan, 'free');
  assert.equal(await svc.referrals.welcomeFor(arun.user), null);
  // Public pages carry the owner's code on their "run your own" links.
  assert.match((await svc.getTournament(first.id, null)).refCode, /^arun\d+$/);
});

test('the inviter: a credit when the friend runs a tournament, an Open one for every 3rd, once each', async () => {
  const kavya = await signup('Kavya Three');
  const { code } = await svc.referrals.summary(kavya);
  // Kavya's academy page gets a month more per friend.
  const [org] = await db.query(`INSERT INTO orgs (slug, name, paid_until) VALUES ('kavya-academy', 'Kavya Academy', now() + interval '10 days') RETURNING id, paid_until`);
  await db.query(`INSERT INTO org_members (org_id, email, role) VALUES ($1, $2, 'owner')`, [org.id, kavya.user.email]);
  const friends = [];
  for (const name of ['Bala', 'Charan', 'Dinesh']) friends.push(await signup(`${name} Org`, code));
  // 9 entries isn't real use yet.
  await runTournament(friends[0], 'Small One', 9);
  assert.equal((await credits(kavya)).length, 0);
  const sentBefore = mailer.sent.length;
  await runTournament(friends[0], 'Bala Cup', 12);
  let c = await credits(kavya);
  assert.deepEqual(c.map((x) => [x.tier, x.reason]), [['club', 'referral']]);
  assert.match(mailer.sent[sentBefore].subject, /Bala ran their first tournament — you've earned a free upgrade/);
  const [after] = await db.query('SELECT paid_until FROM orgs WHERE id = $1', [org.id]);
  assert.ok(Date.parse(after.paid_until) - Date.parse(org.paid_until) > 29 * 86400000);
  // The same friend again: nothing more.
  await runTournament(friends[0], 'Bala Cup 2', 12);
  assert.equal((await credits(kavya)).length, 1);
  // Friends 2 and 3: the 3rd brings an Open credit too.
  await runTournament(friends[1], 'Charan Cup', 10);
  await runTournament(friends[2], 'Dinesh Cup', 10);
  c = await credits(kavya);
  assert.deepEqual(c.map((x) => x.tier).sort(), ['club', 'club', 'club', 'open']);
  const s = await svc.referrals.summary(kavya);
  assert.deepEqual([s.friends.length, s.qualified, s.toMilestone], [3, 3, 3]);
});

test('using a credit: moves a tournament up a plan, only once', async () => {
  const kavya = await signup('Kavya Four');
  const { code } = await svc.referrals.summary(kavya);
  const friend = await signup('Esha Org', code);
  await runTournament(friend, 'Esha Cup', 10);
  const [credit] = await credits(kavya);
  // Kavya's own tournament, full on Free with players waiting.
  const { id } = await svc.createTournament(kavya, { name: 'Kavya Big Open', format: 'knockout' });
  await svc.addEntries(id, kavya, Array.from({ length: 16 }, (_, i) => `K${i + 1}`)); // full on Free
  await assert.rejects(svc.addEntries(id, kavya, ['K17']), /Upgrade to Club/);
  let t = await svc.getTournament(id, kavya);
  assert.deepEqual(t.credits.map((x) => x.id), [credit.id]);
  // Not someone else's credit.
  await assert.rejects(svc.useCredit(id, friend, credit.id), /permission|organis|not|Only/i);
  const r = await svc.useCredit(id, kavya, credit.id);
  assert.equal(r.plan, 'club');
  t = await svc.getTournament(id, kavya);
  assert.equal(t.plan, 'club');
  await svc.addEntries(id, kavya, ['K17', 'K18']); // room now
  assert.deepEqual(t.credits, []);
  await assert.rejects(svc.useCredit(id, kavya, credit.id), /already been used/);
});

test('with payments off, there are no gifts or credits', async () => {
  const saved = { ...process.env };
  for (const k of Object.keys(ENV)) delete process.env[k];
  try {
    const kavya = await signup('Kavya Five');
    const code = (await svc.referrals.summary(kavya)).code;
    const friend = await signup('Farah Org', code);
    assert.equal(await svc.referrals.welcomeFor(friend.user), null);
    const { gift } = await svc.createTournament(friend, { name: 'Farah Cup' });
    assert.equal(gift, undefined);
    assert.equal((await svc.referrals.summary(kavya)).enabled, false);
  } finally {
    Object.assign(process.env, { RAZORPAY_KEY_ID: saved.RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET: saved.RAZORPAY_KEY_SECRET });
  }
});

test('signing up with an emailed link keeps the invite (even on another device)', async () => {
  const kavya = await signup('Kavya Six');
  const { code } = await svc.referrals.summary(kavya);
  const post = (path, body) => fetch(`${base}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
  const asked = await post('/auth/link', { email: 'gita.link@ref.test', next: '/new', ref: code });
  assert.equal(asked.status, 200, await asked.text());
  const mail = mailer.sent.find((m) => m.to === 'gita.link@ref.test');
  const token = decodeURIComponent((mail.text || mail.html).match(/token=([A-Za-z0-9_-]+)/)[1]);
  // Opened in the mail app's browser: no ref there, it comes from the link.
  const used = await (await post('/auth/link/use', { token, name: 'Gita Rao' })).json();
  assert.equal(used.user.name, 'Gita Rao');
  assert.deepEqual(await svc.referrals.welcomeFor(used.user), { from: 'Kavya', plan: 'Club', entries: 64 });
});
