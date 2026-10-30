'use strict';

// AI credits: the first AI setup is free (once); calls spend credits (the
// tournament's first, then the account's) and failed calls give them back;
// none left is a 402 with a code the app recognises; packs bought through
// Razorpay are granted once; the Championship plan includes Both; invited
// friends and their inviters get credits; site admins see usage and can
// pause a tournament. With payments off, nothing is charged.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

const KEY_ID = 'rzp_test_AI';
const KEY_SECRET = 'ai_key_secret';
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
function fakeRazorpay() {
  const orders = new Map();
  const payments = new Map();
  let n = 0;
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.razorpay.com/v1', '');
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (init.method === 'POST' && path === '/orders') {
      const order = { id: `order_${++n}`, ...JSON.parse(init.body), status: 'created' };
      orders.set(order.id, order);
      return json(200, order);
    }
    const m = path.match(/^\/payments\/([^/]+)$/);
    if (m) return json(200, payments.get(m[1]));
    return json(404, {});
  };
  const pay = (orderId) => {
    const o = orders.get(orderId);
    const id = `pay_${++n}`;
    payments.set(id, { id, order_id: orderId, amount: o.amount, currency: o.currency, status: 'captured' });
    return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: sign(KEY_SECRET, `${orderId}|${id}`) };
  };
  return { fetchImpl, pay };
}
const ENV = { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: 'w' };
const billing = (on) => { for (const [k, v] of Object.entries(ENV)) { if (on) process.env[k] = v; else delete process.env[k]; } };

// Claude stand-in: a minimal draft; `failNext` makes the next call fail.
let failNext = false;
const client = { beta: { messages: { async create(req) {
  if (failNext) { failNext = false; throw new Error('boom'); }
  const mapping = /map the columns/.test(req.system);
  const out = /Reply with ok/.test(req.system) ? { ok: true } : mapping ? { columns: [], categoryValues: [], separator: ',', paidValues: [], notes: [] }
    : { name: 'Cup', sport: 'badminton', events: [{ discipline: 'singles', gender: 'men', age: null, level: null, name: null, feeRupees: null, feePer: null }], unsure: [], contacts: [], links: { instagram: null, whatsapp: null, website: null, entryForm: null } };
  return { model: req.model, stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: JSON.stringify(out) }] };
} } } };

let db;
let svc;
let rp;
let ai;
test.before(async () => {
  billing(true);
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  rp = fakeRazorpay();
  const app = createApp(db, { fetchImpl: rp.fetchImpl, aiClient: client, mailer: { enabled: false, async send() {} } });
  svc = app.service;
  ai = svc.ai;
});
test.after(async () => { billing(false); await db.close(); });

let n = 0;
async function user(name) {
  n += 1;
  const [u] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'x') RETURNING id, email, name`, [`${name.toLowerCase().replace(/\W/g, '')}${n}@credits.test`, name]);
  return { ...u, actor: { user: { ...u, isAdmin: false } } };
}
const balance = async (u, t = null) => (await svc.credits.summary(u.actor, t)).balance;
const buy = async (u, pack, tournament) => {
  const order = await svc.aiCheckout(u.actor, { pack, tournament });
  return svc.verifyPayment(rp.pay(order.orderId));
};

test('the first AI setup is free, once; then a 402 until a pack is bought', async () => {
  const kavya = await user('Kavya Credits');
  let s = await svc.credits.summary(kavya.actor);
  assert.equal(s.freeFirst, true);
  assert.deepEqual(s.prices, { create: 9900, manage: 19900, both: 24900, topup: 9900 });
  await ai.tournamentDraft(kavya.actor, { text: 'Cup on Sunday' }); // 1 credit of the free 5
  assert.equal((await balance(kavya)).create.total, 4);
  s = await svc.credits.summary(kavya.actor);
  assert.equal(s.freeFirst, false);
  await ai.tournamentDraft(kavya.actor, { image: 'data:image/jpeg;base64,AAAA' }); // 2
  await ai.tournamentDraft(kavya.actor, { image: 'data:image/jpeg;base64,AAAA' }); // 2 → 0 left
  await assert.rejects(ai.tournamentDraft(kavya.actor, { text: 'again' }), (e) => e.status === 402 && e.code === 'ai_credits');
  // A failed call gives its credit back.
  const r = await buy(kavya, 'create');
  assert.deepEqual(r, { ok: true, tournamentId: null, kind: 'ai', pack: 'create' });
  assert.equal((await balance(kavya)).create.account, 20);
  failNext = true;
  await assert.rejects(ai.tournamentDraft(kavya.actor, { text: 'x' }));
  assert.equal((await balance(kavya)).create.account, 20, 'refunded');
  // The free grant isn't given twice.
  const [{ free }] = await db.query(`SELECT COUNT(*)::int AS free FROM ai_credits WHERE user_id = $1 AND reason = 'free'`, [kavya.id]);
  assert.equal(free, 1);
});

test('tournament packs: Both on a tournament, spent before the account; paid once; the Championship plan includes Both', async () => {
  const ravi = await user('Ravi Credits');
  const { id } = await svc.createTournament(ravi.actor, { name: 'Credit Cup', sport: 'badminton', events: [{ discipline: 'singles', gender: 'men' }] });
  const order = await svc.aiCheckout(ravi.actor, { pack: 'both', tournament: id });
  assert.equal(order.amount, 24900);
  const proof = rp.pay(order.orderId);
  await svc.verifyPayment(proof);
  await svc.verifyPayment(proof); // the same payment twice: granted once
  let b = await balance(ravi, id);
  assert.deepEqual([b.create.tournament, b.manage.tournament], [20, 150]);
  // A column mapping spends the tournament's Create first.
  await ai.columnMapping(ravi.actor, { tournament: id, sport: 'badminton', events: [], sample: { headers: ['Name'], samples: [], repeating: {} } });
  b = await balance(ravi, id);
  assert.equal(b.create.tournament, 19);
  assert.equal(b.create.account, 5, 'the free credits weren\'t touched — the tournament paid');
  // Someone else's tournament: no.
  const other = await user('Other Credits');
  await assert.rejects(svc.aiCheckout(other.actor, { pack: 'manage', tournament: id }), /403|organis|can't/i);
  await assert.rejects(svc.aiCheckout(ravi.actor, { pack: 'manage' }), /Pick the tournament/);
  // The Championship plan includes Both, once.
  const admin = { user: { id: 999, email: 'boss@credits.test', name: 'Boss', isAdmin: true } };
  const { id: big } = await svc.createTournament(ravi.actor, { name: 'Big Cup', sport: 'badminton', events: [{ discipline: 'singles', gender: 'men' }] });
  await svc.adminSetPlan(big, admin, 'championship');
  await svc.adminSetPlan(big, admin, 'open');
  await svc.adminSetPlan(big, admin, 'championship');
  b = await balance(ravi, big);
  assert.deepEqual([b.create.tournament, b.manage.tournament], [20, 150]);
});

test('admins: usage, alerts, prices and the pause switch; payments off charges nothing', async () => {
  const usage = await svc.credits.adminUsage({ days: 30 });
  assert.ok(usage.bought >= 20 + 170);
  assert.ok(usage.spent >= 6);
  assert.ok(usage.revenue >= 9900 + 24900);
  assert.ok(usage.busy.length >= 1);
  const admin = { user: { id: 999, email: 'boss@credits.test', name: 'Boss', isAdmin: true } };
  await svc.setAdminSettings(admin, { aiPrices: { manage: 14900 } });
  assert.equal((await svc.credits.prices()).manage, 14900);
  // Paused: a 423 for that tournament.
  const sam = await user('Sam Credits');
  const { id } = await svc.createTournament(sam.actor, { name: 'Paused Cup', sport: 'badminton', events: [{ discipline: 'singles', gender: 'men' }] });
  await svc.credits.setPaused(id, true);
  await assert.rejects(ai.columnMapping(sam.actor, { tournament: id, sport: 'badminton', events: [], sample: { headers: ['A'], samples: [], repeating: {} } }), (e) => e.status === 423);
  await svc.credits.setPaused(id, false);
  // Without Razorpay set up, AI isn't charged at all.
  billing(false);
  try {
    const free = await user('Free Credits');
    for (let i = 0; i < 8; i += 1) await ai.tournamentDraft(free.actor, { text: 'x' });
    const [{ rows }] = await db.query('SELECT COUNT(*)::int AS rows FROM ai_credits WHERE user_id = $1', [free.id]);
    assert.equal(rows, 0);
  } finally { billing(true); }
});

test('referrals: the invited friend gets a Create; the inviter a Manage when the friend runs a tournament', async () => {
  const inviter = await user('Inviter Credits');
  const code = await svc.referrals.codeFor(db.query, inviter);
  const http = require('node:http');
  const app = createApp(db, { fetchImpl: rp.fetchImpl, aiClient: client, mailer: { enabled: false, async send() {} } });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'Friend Credits', email: 'friend@credits.test', password: 'password123', ref: code }) });
    const { user: friend } = await res.json();
    const b = await svc.credits.balance(db.query, { user: friend.id });
    assert.equal(b.create.account, 20);
    // The friend runs a tournament with 10 entries: the inviter earns a Manage.
    const actor = { user: { ...friend, isAdmin: false } };
    const { id } = await svc.createTournament(actor, { name: 'Friend Cup', sport: 'badminton', format: 'knockout', events: [{ discipline: 'singles', gender: 'men' }] });
    await svc.addEntries(id, actor, Array.from({ length: 10 }, (_, i) => `P${i + 1}`));
    await svc.start(id, actor);
    const ib = await svc.credits.balance(db.query, { user: inviter.id });
    assert.equal(ib.manage.account, 150);
  } finally { await new Promise((r) => server.close(r)); }
});

test('admins: give a tournament AI credits (counted as given), and test the key for free', async () => {
  const admin = { user: { id: 999, email: 'boss@credits.test', name: 'Boss', isAdmin: true } };
  const org = await user('Grant Credits');
  const { id } = await svc.createTournament(org.actor, { name: 'Given Cup', sport: 'badminton', events: [{ discipline: 'singles', gender: 'men' }] });
  await assert.rejects(svc.adminGrantAi(id, org.actor, 'both'), (e) => e.status === 403);
  await assert.rejects(svc.adminGrantAi(id, admin, 'gold'), /pack must be/);
  const before = await svc.credits.adminUsage({ days: 30 });
  let b = await svc.adminGrantAi(id, admin, 'both');
  assert.deepEqual([b.create.tournament, b.manage.tournament], [20, 150]);
  b = await svc.adminGrantAi(id, admin, 'manage'); // again: a second grant, not the same one
  assert.equal(b.manage.tournament, 300);
  const after = await svc.credits.adminUsage({ days: 30 });
  assert.equal(after.given - before.given, 320);
  assert.equal(after.revenue, before.revenue);
  const r = await ai.test(admin);
  assert.equal(r.ok, true);
  const [row] = await db.query(`SELECT kind, ms FROM ai_calls WHERE kind = 'test' ORDER BY id DESC LIMIT 1`);
  assert.ok(row && row.ms >= 0);
  const u = await ai.usage(30);
  assert.ok(u.day.calls >= 1);
});
