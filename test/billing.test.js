'use strict';

// Event Pass payments through Razorpay: free-entry limit, order creation,
// signature checks, webhooks, receipts and admin controls. Razorpay itself is
// replaced by a fake `fetch`; signatures are real HMACs with test secrets.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const billing = require('../server/billing');

const KEY_ID = 'rzp_test_KEY123';
const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

// Minimal fake Razorpay API.
function fakeRazorpay() {
  const orders = new Map();
  const payments = new Map();
  let n = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const path = url.replace('https://api.razorpay.com/v1', '');
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (init.headers.Authorization !== `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`) {
      return json(401, { error: { description: 'Authentication failed' } });
    }
    if (init.method === 'POST' && path === '/orders') {
      const body = JSON.parse(init.body);
      const order = { id: `order_${++n}`, ...body, status: 'created' };
      orders.set(order.id, order);
      return json(200, order);
    }
    let m = path.match(/^\/payments\/([^/]+)$/);
    if (m && init.method === 'GET') return payments.has(m[1]) ? json(200, payments.get(m[1])) : json(404, { error: { description: 'not found' } });
    m = path.match(/^\/payments\/([^/]+)\/capture$/);
    if (m && init.method === 'POST') {
      const p = payments.get(m[1]);
      p.status = 'captured';
      return json(200, p);
    }
    return json(404, { error: { description: 'unknown endpoint' } });
  };
  // Simulates the customer paying in Checkout.
  const pay = (orderId, { status = 'captured', amount } = {}) => {
    const order = orders.get(orderId);
    const id = `pay_${++n}`;
    payments.set(id, { id, order_id: orderId, amount: amount ?? order.amount, currency: order.currency, status });
    return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: sign(KEY_SECRET, `${orderId}|${id}`) };
  };
  return { fetchImpl, pay, calls, orders, payments };
}

function fakeMailer() {
  return { enabled: true, sent: [], async send(m) { this.sent.push(m); return { sent: true }; } };
}

let db;
let rp;
let mailer;
let app;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  rp = fakeRazorpay();
  mailer = fakeMailer();
  app = createApp(db, { mailer, fetchImpl: rp.fetchImpl });
  svc = app.service;
});
test.after(() => db.close());

const BILLING_ENV = {
  RAZORPAY_KEY_ID: KEY_ID,
  RAZORPAY_KEY_SECRET: KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  APP_URL: 'https://tonament.example',
  BUSINESS_NAME: 'Tonament Sports',
  BUSINESS_EMAIL: 'hello@tonament.example',
};
function withBilling(on) {
  for (const [k, v] of Object.entries(BILLING_ENV)) {
    if (on) process.env[k] = v;
    else delete process.env[k];
  }
}

const ORG = { user: { id: 7, email: 'org@club.test', name: 'Club Organiser', isAdmin: false } };
const ADMIN = { user: { id: 1, email: 'boss@tonament.test', name: 'Boss', isAdmin: true } };
const names = (n, p = 'P') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);

test('signature helpers', () => {
  assert.equal(billing.verifyPaymentSignature({ orderId: 'order_1', paymentId: 'pay_1', signature: sign('s', 'order_1|pay_1') }, 's'), true);
  assert.equal(billing.verifyPaymentSignature({ orderId: 'order_1', paymentId: 'pay_2', signature: sign('s', 'order_1|pay_1') }, 's'), false);
  assert.equal(billing.verifyPaymentSignature({ orderId: 'order_1', paymentId: 'pay_1', signature: 'nope' }, 's'), false);
  assert.equal(billing.verifyWebhookSignature('{"a":1}', sign('w', '{"a":1}'), 'w'), true);
  assert.equal(billing.verifyWebhookSignature('{"a":1} ', sign('w', '{"a":1}'), 'w'), false);
  const pub = billing.publicBillingConfig(billing.billingConfig({ RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 'secret' }));
  assert.equal(pub.enabled, true);
  assert.equal(JSON.stringify(pub).includes('secret'), false); // never exposed
  assert.equal(billing.billingConfig({}).enabled, false);
});

test('billing off: no entry limit', async () => {
  withBilling(false);
  const { id } = await svc.createTournament(ORG, { name: 'Unlimited Free', format: 'knockout' });
  const t = await svc.addEntries(id, ORG, names(20));
  assert.equal(t.entries.length, 20);
  assert.equal(t.limits.entries, null);
  await assert.rejects(svc.checkout(id, ORG), /aren't set up/);
});

test('billing on: 16 free entries, then organisers are asked to upgrade and players see "full"', async () => {
  withBilling(true);
  try {
    const { id } = await svc.createTournament(ORG, { name: 'Limited Open', format: 'knockout' });
    let t = await svc.addEntries(id, ORG, names(15));
    assert.equal(t.limits.entries, 16);
    assert.equal(t.plan, 'free');
    await assert.rejects(svc.addEntries(id, ORG, ['A', 'B']), (e) => e.status === 402 && e.code === 'upgrade' && /1 left/.test(e.message));
    t = await svc.addEntries(id, ORG, ['Sixteenth']);
    assert.equal(t.entries.length, 16);
    await assert.rejects(svc.addEntries(id, ORG, ['Seventeenth'], { walkIn: true }), (e) => e.code === 'upgrade');
    await assert.rejects(svc.register(id, { name: 'Self', contact: 'self@x.dev' }), (e) => e.code === 'full' && /contact the organiser/.test(e.message));
  } finally {
    withBilling(false);
  }
});

test('checkout -> verify activates the Pass, sends a receipt, and is idempotent', async () => {
  withBilling(true);
  try {
    const { id } = await svc.createTournament(ORG, { name: 'Paid Cup', format: 'knockout' });
    await svc.addEntries(id, ORG, names(16));
    await assert.rejects(svc.checkout(id, { user: { email: 'stranger@x.dev', isAdmin: false } }), /organisers/);

    const order = await svc.checkout(id, ORG);
    assert.equal(order.keyId, KEY_ID);
    assert.equal(order.amount, 49900);
    assert.equal(order.currency, 'INR');
    assert.equal(order.description, 'Event Pass — Paid Cup');
    assert.deepEqual(order.prefill, { name: 'Club Organiser', email: 'org@club.test' });
    const sent = JSON.parse(rp.calls.at(-1).init.body);
    assert.equal(sent.amount, 49900); // amount is set by the server
    assert.equal(sent.notes.tournament_id, id);

    // Tampered signature / unknown order are refused.
    const good = rp.pay(order.orderId);
    await assert.rejects(svc.verifyPayment({ ...good, razorpay_signature: sign('wrong', 'x') }), /couldn't verify/);
    await assert.rejects(svc.verifyPayment({ ...good, razorpay_order_id: 'order_nope' }), /not found/);

    const res = await svc.verifyPayment(good, { baseUrl: 'https://tonament.example' });
    assert.deepEqual(res, { ok: true, tournamentId: id, plan: 'pass' });
    let t = await svc.getTournament(id, ORG);
    assert.equal(t.plan, 'pass');
    assert.equal(t.limits.entries, null);
    t = await svc.addEntries(id, ORG, names(10, 'More'));
    assert.equal(t.entries.length, 26);

    const receipt = mailer.sent.find((m) => m.subject === 'Payment received — Event Pass for Paid Cup');
    assert.ok(receipt);
    assert.equal(receipt.to, 'org@club.test');
    assert.match(receipt.text, /₹499\.00/);
    assert.match(receipt.text, new RegExp(good.razorpay_payment_id));
    assert.match(receipt.text, /Tonament Sports/);

    // Replaying the verification changes nothing and sends no second receipt.
    const before = mailer.sent.length;
    await svc.verifyPayment(good, { baseUrl: 'https://tonament.example' });
    assert.equal(mailer.sent.length, before);
    await assert.rejects(svc.checkout(id, ORG), /already has the Event Pass/);
  } finally {
    withBilling(false);
  }
});

test('verify refuses a payment whose amount does not match, and captures authorized payments', async () => {
  withBilling(true);
  try {
    const { id } = await svc.createTournament(ORG, { name: 'Cheap Trick', format: 'knockout' });
    const order = await svc.checkout(id, ORG);
    const forged = rp.pay(order.orderId, { amount: 100 }); // validly signed, but only ₹1 paid
    await assert.rejects(svc.verifyPayment(forged), /don't match/);
    assert.equal((await svc.getTournament(id)).plan, 'free');

    const { id: id2 } = await svc.createTournament(ORG, { name: 'Auth Only', format: 'knockout' });
    const order2 = await svc.checkout(id2, ORG);
    const authorized = rp.pay(order2.orderId, { status: 'authorized' });
    await svc.verifyPayment(authorized);
    assert.equal(rp.payments.get(authorized.razorpay_payment_id).status, 'captured');
    assert.equal((await svc.getTournament(id2)).plan, 'pass');
  } finally {
    withBilling(false);
  }
});

test('HTTP: webhook (raw-body signature), config endpoint and admin controls', async () => {
  withBilling(true);
  process.env.ADMIN_EMAILS = 'root@tonament.test';
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body, headers = {}) => {
      const h = { 'Content-Type': 'application/json', ...headers };
      if (cookie) h.Cookie = cookie;
      const res = await fetch(base + path, { method, headers: h, body: typeof body === 'string' ? body : body && JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json().catch(() => null) };
    };
  };
  try {
    const anon = client();
    const cfg = (await anon('GET', '/api/billing/config')).data;
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.keyId, KEY_ID);
    assert.equal(cfg.price, 49900);
    assert.equal(cfg.freeLimit, 16);
    assert.equal(cfg.business.name, 'Tonament Sports');
    assert.equal(JSON.stringify(cfg).includes(KEY_SECRET), false);

    const org = client();
    await org('POST', '/api/auth/signup', { name: 'Hook Org', email: 'hook.org@x.dev', password: 'password123' });
    const { id } = (await org('POST', '/api/tournaments', { name: 'Webhook Cup', format: 'knockout' })).data;
    const order = (await org('POST', `/api/tournaments/${id}/checkout`)).data;
    assert.match(order.orderId, /^order_/);

    // Customer pays but closes the tab: only the webhook arrives.
    const paid = rp.pay(order.orderId);
    const event = JSON.stringify({
      event: 'payment.captured',
      payload: { payment: { entity: { id: paid.razorpay_payment_id, order_id: order.orderId, amount: 49900, currency: 'INR', status: 'captured' } } },
    });
    assert.equal((await anon('POST', '/api/billing/razorpay/webhook', event, { 'X-Razorpay-Signature': sign(WEBHOOK_SECRET, `${event} `) })).status, 400);
    const ok = await anon('POST', '/api/billing/razorpay/webhook', event, { 'X-Razorpay-Signature': sign(WEBHOOK_SECRET, event) });
    assert.equal(ok.status, 200);
    assert.equal((await org('GET', `/api/tournaments/${id}?me=1`)).data.plan, 'pass');
    // Replays are harmless; unknown orders are ignored.
    assert.equal((await anon('POST', '/api/billing/razorpay/webhook', event, { 'X-Razorpay-Signature': sign(WEBHOOK_SECRET, event) })).status, 200);
    const other = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_x', order_id: 'order_elsewhere', amount: 1, currency: 'INR' } } } });
    assert.deepEqual((await anon('POST', '/api/billing/razorpay/webhook', other, { 'X-Razorpay-Signature': sign(WEBHOOK_SECRET, other) })).data, { ok: true, ignored: true });

    // Admin: payments list + manual switch; non-admins refused.
    assert.equal((await org('GET', '/api/admin/payments')).status, 403);
    assert.equal((await org('POST', `/api/admin/tournaments/${id}/plan`, { plan: 'free' })).status, 403);
    const root = client();
    await root('POST', '/api/auth/signup', { name: 'Root', email: 'root@tonament.test', password: 'password123' });
    const list = (await root('GET', '/api/admin/payments')).data;
    const row = list.payments.find((p) => p.orderId === order.orderId);
    assert.equal(row.status, 'paid');
    assert.equal(row.tournamentName, 'Webhook Cup');
    assert.ok(list.revenue.total >= 49900);
    const revoked = await root('POST', `/api/admin/tournaments/${id}/plan`, { plan: 'free' });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.plan, 'free');

    // Clean URLs for the policy pages fall back to the app when missing.
    const page = await fetch(`${base}/pricing`);
    assert.equal(page.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
    delete process.env.ADMIN_EMAILS;
    withBilling(false);
  }
});
