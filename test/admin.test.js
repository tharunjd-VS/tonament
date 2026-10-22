'use strict';

// The site admin dashboard: who is an admin, disabling and deleting accounts,
// reset links, every tournament (private too), plan switches, stats, the
// payments list and CSV, and refunds through (a fake) Razorpay.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

const KEY_ID = 'rzp_test_ADMIN';
const KEY_SECRET = 'admin_key_secret';
const ENV = { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: 'whsec', APP_URL: 'https://tonament.example', ADMIN_EMAILS: 'env.admin@t.test' };
const sign = (data) => crypto.createHmac('sha256', KEY_SECRET).update(data).digest('hex');

// A fake Razorpay: orders, payments and refunds.
function fakeRazorpay() {
  const orders = new Map();
  const payments = new Map();
  let n = 0;
  let failRefunds = false;
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.razorpay.com/v1', '');
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (init.method === 'POST' && path === '/orders') {
      const order = { id: `order_${++n}`, ...JSON.parse(init.body) };
      orders.set(order.id, order);
      return json(200, order);
    }
    let m = path.match(/^\/payments\/([^/]+)$/);
    if (m) return json(200, payments.get(m[1]));
    m = path.match(/^\/payments\/([^/]+)\/refund$/);
    if (m && init.method === 'POST') {
      if (failRefunds) return json(400, { error: { description: 'The payment has been fully refunded already' } });
      return json(200, { id: `rfnd_${++n}`, payment_id: m[1], amount: JSON.parse(init.body).amount });
    }
    return json(404, {});
  };
  const pay = (orderId) => {
    const o = orders.get(orderId);
    const id = `pay_${++n}`;
    payments.set(id, { id, order_id: orderId, amount: o.amount, currency: o.currency, status: 'captured' });
    return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: sign(`${orderId}|${id}`) };
  };
  return { fetchImpl, pay, setFailRefunds: (on) => { failRefunds = on; } };
}

let db;
let svc;
let rp;
let server;
let base;
const saved = {};
test.before(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  rp = fakeRazorpay();
  const app = createApp(db, { mailer: { enabled: false, async send() { return { sent: false }; } }, fetchImpl: rp.fetchImpl });
  svc = app.service;
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// A browser: signs up, keeps its cookie, calls the API.
async function browser(name, email) {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  const r = await call('POST', '/api/auth/signup', { name, email, password: 'password123' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { call, user: r.data.user };
}

test('admin routes are for site admins only', async () => {
  const player = await browser('Plain Player', 'plain@t.test');
  for (const [m, p] of [['GET', '/api/admin/stats'], ['GET', '/api/admin/tournaments'], ['GET', '/api/admin/users'], ['GET', '/api/admin/payments'],
    ['GET', '/api/admin/payments.csv'], ['POST', '/api/admin/users/1/admin'], ['POST', '/api/admin/users/1/disable'], ['POST', '/api/admin/users/1/reset'],
    ['DELETE', '/api/admin/users/1'], ['POST', '/api/admin/payments/1/refund'], ['GET', '/api/admin/users/1']]) {
    const r = await player.call(m, p, m === 'GET' ? undefined : {});
    assert.equal(r.status, 403, `${m} ${p}`);
  }
});

test('admins: from ADMIN_EMAILS or made in the app; disable, reset, delete', async () => {
  const boss = await browser('Env Admin', 'env.admin@t.test');
  assert.equal(boss.user.isAdmin, true);
  const helper = await browser('Helper', 'helper@t.test');
  assert.equal(helper.user.isAdmin, false);

  // Grant and remove admin.
  let r = await boss.call('POST', `/api/admin/users/${helper.user.id}/admin`, { on: true });
  assert.equal(r.data.isAdmin, true);
  assert.equal((await helper.call('GET', '/api/auth/me')).data.user.isAdmin, true);
  assert.equal((await helper.call('GET', '/api/admin/stats')).status, 200);
  r = await helper.call('POST', `/api/admin/users/${boss.user.id}/admin`, { on: false });
  assert.equal(r.status, 409); // ADMIN_EMAILS admins are removed in the settings
  r = await helper.call('POST', `/api/admin/users/${helper.user.id}/admin`, { on: false });
  assert.equal(r.status, 409); // not yourself
  await boss.call('POST', `/api/admin/users/${helper.user.id}/admin`, { on: false });
  assert.equal((await helper.call('GET', '/api/admin/stats')).status, 403);

  // Disable: signed out now, can't sign in; enable again.
  const victim = await browser('Victim', 'victim@t.test');
  assert.equal((await boss.call('POST', `/api/admin/users/${boss.user.id}/disable`, { on: true })).status, 409);
  r = await boss.call('POST', `/api/admin/users/${victim.user.id}/disable`, { on: true });
  assert.equal(r.data.disabled, true);
  assert.equal((await victim.call('GET', '/api/auth/me')).data.user, null);
  r = await victim.call('POST', '/api/auth/login', { email: 'victim@t.test', password: 'password123' });
  assert.equal(r.status, 403);
  assert.match(r.data.error, /disabled/);
  await boss.call('POST', `/api/admin/users/${victim.user.id}/disable`, { on: false });
  assert.equal((await victim.call('POST', '/api/auth/login', { email: 'victim@t.test', password: 'password123' })).status, 200);

  // A reset link that works.
  r = await boss.call('POST', `/api/admin/users/${victim.user.id}/reset`, {});
  const token = r.data.url.match(/token=([\w-]+)/)[1];
  assert.equal((await victim.call('POST', '/api/auth/reset', { token, password: 'newpassword1' })).status, 200);
  assert.equal((await victim.call('POST', '/api/auth/login', { email: 'victim@t.test', password: 'newpassword1' })).status, 200);

  // Search, detail.
  r = await boss.call('GET', '/api/admin/users?q=victim');
  assert.deepEqual(r.data.users.map((u) => u.email), ['victim@t.test']);
  const envRow = (await boss.call('GET', '/api/admin/users?q=env.admin')).data.users[0];
  assert.deepEqual([envRow.isAdmin, envRow.envAdmin], [true, true]);

  // Delete: not while they own a tournament.
  const owner = await browser('Owner', 'owner.del@t.test');
  const { data: { id } } = await owner.call('POST', '/api/tournaments', { name: 'Owned Cup', events: [{ discipline: 'singles', gender: 'men' }] });
  r = await boss.call('DELETE', `/api/admin/users/${owner.user.id}`);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /owns 1 tournament/);
  r = await boss.call('GET', `/api/admin/users/${owner.user.id}`);
  assert.deepEqual(r.data.tournaments.map((t) => [t.id, t.role]), [[id, 'owner']]);
  assert.equal((await boss.call('DELETE', `/api/tournaments/${id}`)).status, 200); // admins can delete any tournament
  assert.equal((await boss.call('DELETE', `/api/admin/users/${owner.user.id}`)).status, 200);
  assert.equal((await owner.call('GET', '/api/auth/me')).data.user, null);

  const log = (await boss.call('GET', '/api/admin/stats')).data.log.map((x) => x.action);
  for (const a of ['user.admin', 'user.unadmin', 'user.disable', 'user.enable', 'user.reset', 'tournament.delete', 'user.delete']) assert.ok(log.includes(a), a);
});

test('every tournament (private too), filters, plan switch, stats', async () => {
  const boss = await browser('Boss Two', 'boss2@t.test');
  await db.query('UPDATE users SET is_admin = true WHERE email = $1', ['boss2@t.test']);
  const org = await browser('Organiser', 'org.list@t.test');
  const mk = async (name, visibility, sport = 'badminton') => (await org.call('POST', '/api/tournaments', { name, visibility, sport, events: [{ discipline: 'singles', gender: 'men' }] })).data.id;
  const priv = await mk('Zeta Private Night', 'private');
  await mk('Zeta Public Open', 'public', 'pickleball');
  await mk('Zeta Link Cup', 'link');

  let r = await boss.call('GET', '/api/admin/tournaments?q=Zeta');
  assert.equal(r.data.total, 3);
  assert.ok(r.data.tournaments.some((t) => t.id === priv && t.owner === 'org.list@t.test'));
  r = await boss.call('GET', '/api/admin/tournaments?q=Zeta&visibility=private');
  assert.deepEqual(r.data.tournaments.map((t) => t.id), [priv]);
  r = await boss.call('GET', '/api/admin/tournaments?q=Zeta&sport=pickleball');
  assert.deepEqual(r.data.tournaments.map((t) => t.name), ['Zeta Public Open']);
  r = await boss.call('GET', '/api/admin/tournaments?q=Zeta&offset=2');
  assert.equal(r.data.tournaments.length, 1);
  r = await boss.call('GET', '/api/admin/tournaments?q=org.list');
  assert.equal(r.data.total, 3); // by owner email

  // Switch a plan on, and off again.
  r = await boss.call('POST', `/api/admin/tournaments/${priv}/plan`, { plan: 'open' });
  assert.equal(r.data.plan, 'open');
  assert.equal((await boss.call('GET', `/api/admin/tournaments?q=${priv}&plan=open`)).data.total, 1);
  await boss.call('POST', `/api/admin/tournaments/${priv}/plan`, { plan: 'free' });

  const stats = (await boss.call('GET', '/api/admin/stats')).data;
  assert.ok(stats.users.total >= 2 && stats.tournaments.total >= 3);
  assert.equal(stats.days.length, 30);
  assert.ok(stats.bySport.some((x) => x.key === 'pickleball'));
  assert.equal(stats.log[0].action, 'tournament.plan');
  assert.deepEqual(stats.log[0].detail, { name: 'Zeta Private Night', from: 'open', to: 'free' });
});

test('payments: list, CSV, refunds (full with downgrade, partial, too much, Razorpay failure)', async () => {
  const boss = await browser('Pay Boss', 'payboss@t.test');
  await db.query('UPDATE users SET is_admin = true WHERE email = $1', ['payboss@t.test']);
  const ORG = { user: { id: 99, email: 'payer@t.test', name: 'Payer', isAdmin: false } };
  const { id } = await svc.createTournament(ORG, { name: '=Formula "Cup"', events: [{ discipline: 'singles', gender: 'men' }] });
  const buy = async (tier) => {
    const order = await svc.checkout(id, ORG, { tier });
    await svc.verifyPayment(rp.pay(order.orderId), { baseUrl: 'https://tonament.example' });
  };
  await buy('club');
  await buy('open'); // pays the difference
  let t = await svc.getTournament(id, ORG);
  assert.equal(t.plan, 'open');

  let r = await boss.call('GET', '/api/admin/payments?kind=plan&q=Formula');
  assert.equal(r.data.payments.length, 2);
  const [openPay, clubPay] = r.data.payments; // newest first
  assert.equal(r.data.revenue.total, openPay.amount + clubPay.amount);

  // CSV: a header, rows, and formula-looking names made safe.
  r = await boss.call('GET', '/api/admin/payments.csv?q=Formula');
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="tonament-payments-/);
  const lines = r.data.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^"Date","Tournament",/);
  assert.ok(lines[1].includes(`"'=Formula ""Cup"""`));

  // Too much, then a partial refund, then the rest with a downgrade.
  r = await boss.call('POST', `/api/admin/payments/${openPay.id}/refund`, { amount: openPay.amount + 1 });
  assert.equal(r.status, 400);
  r = await boss.call('POST', `/api/admin/payments/${openPay.id}/refund`, { amount: 1000 });
  assert.deepEqual([r.data.status, r.data.refunded], ['paid', 1000]);
  rp.setFailRefunds(true);
  r = await boss.call('POST', `/api/admin/payments/${openPay.id}/refund`, {});
  assert.equal(r.status, 502);
  assert.match(r.data.error, /fully refunded already/);
  rp.setFailRefunds(false);
  r = await boss.call('POST', `/api/admin/payments/${openPay.id}/refund`, { downgrade: true });
  assert.deepEqual([r.data.status, r.data.refunded, r.data.plan], ['refunded', openPay.amount, 'club']); // back to the plan still paid for
  t = await svc.getTournament(id, ORG);
  assert.equal(t.plan, 'club');
  assert.equal((await boss.call('POST', `/api/admin/payments/${openPay.id}/refund`, {})).status, 409); // nothing left

  r = await boss.call('GET', '/api/admin/payments?status=refunded&q=Formula');
  assert.deepEqual(r.data.payments.map((p) => p.id), [openPay.id]);
  const stats = (await boss.call('GET', '/api/admin/stats')).data;
  assert.ok(stats.revenue.refunded >= openPay.amount);
});

test('venue display: organiser-led (white label) on Open, Championship and Event Pass, not Free, Club or Tonament\'s own', async () => {
  const ADMIN = { user: { id: 1, email: 'env.admin@t.test', name: 'Env Admin', isAdmin: true } };
  const ORG = { user: { id: 98, email: 'brand@t.test', name: 'Brand', isAdmin: false } };
  const { id } = await svc.createTournament(ORG, { name: 'Brand Cup', events: [{ discipline: 'singles', gender: 'men' }] });
  const label = async () => (await svc.getTournament(id, ORG)).whiteLabel;
  assert.equal(await label(), false);
  for (const [plan, want] of [['club', false], ['open', true], ['championship', true], ['pass', true], ['free', false]]) {
    await svc.adminSetPlan(id, ADMIN, plan);
    assert.equal(await label(), want, plan);
  }
  await svc.adminSetPlan(id, ADMIN, 'open');
  await svc.setOfficial(id, ADMIN, true);
  assert.equal(await label(), false); // Tonament's own tournaments keep the Tonament look
});
