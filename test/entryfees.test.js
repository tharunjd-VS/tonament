'use strict';

// Entry fees for tournaments organised by Tonament: pay-to-enter through
// Razorpay (faked here), with real HMAC signatures.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const { enterAs } = require('./players');

const KEY_ID = 'rzp_test_FEES';
const KEY_SECRET = 'fees_secret';
const WEBHOOK_SECRET = 'fees_hook';
const sign = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

function fakeRazorpay() {
  const orders = new Map();
  const payments = new Map();
  let n = 0;
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.razorpay.com/v1', '');
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (init.method === 'POST' && path === '/orders') {
      const order = { id: `order_f${++n}`, ...JSON.parse(init.body) };
      orders.set(order.id, order);
      return json(200, order);
    }
    const m = path.match(/^\/payments\/([^/]+)$/);
    if (m) return json(200, payments.get(m[1]));
    return json(404, {});
  };
  const pay = (orderId, { amount } = {}) => {
    const o = orders.get(orderId);
    const id = `pay_f${++n}`;
    payments.set(id, { id, order_id: orderId, amount: amount ?? o.amount, currency: o.currency, status: 'captured' });
    return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: sign(KEY_SECRET, `${orderId}|${id}`) };
  };
  return { fetchImpl, pay, orders };
}

let db;
let svc;
let rp;
const mailer = { enabled: true, sent: [], async send(m) { this.sent.push(m); return { sent: true }; } };
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  rp = fakeRazorpay();
  svc = createApp(db, { mailer, fetchImpl: rp.fetchImpl }).service;
  Object.assign(process.env, { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET, BUSINESS_NAME: 'Tonament Sports' });
});
const enter = (...args) => enterAs(svc)(...args); // a player entering with their account
test.after(() => {
  for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'BUSINESS_NAME']) delete process.env[k];
  return db.close();
});

const ADMIN = { user: { id: 1, email: 'boss@tonament.test', name: 'Boss', isAdmin: true } };
const ORG = { user: { id: 2, email: 'org@club.test', name: 'Org', isAdmin: false } };
const base = { baseUrl: 'https://tonament.example' };

async function officialCup(name = 'Tonament Open') {
  const { id } = await svc.createTournament(ADMIN, {
    name, visibility: 'public', format: 'knockout',
    events: [{ discipline: 'singles', gender: 'men' }, { discipline: 'doubles', gender: 'mixed' }],
  });
  await svc.setOfficial(id, ADMIN, true);
  const { events: [ms, xd] } = await svc.getTournament(id, ADMIN);
  await svc.updateEvent(id, ADMIN, ms.id, { fee: 30000 });
  await svc.updateEvent(id, ADMIN, xd.id, { fee: 50000, maxEntries: 2 });
  return { id, ms: ms.id, xd: xd.id };
}

test('only site admins mark tournaments as organised by Tonament; only those take fees online', async () => {
  const { id } = await svc.createTournament(ORG, { name: 'Club Cup', format: 'knockout' });
  const { eventId } = await svc.getTournament(id, ORG);
  // Any tournament can set a fee; it's paid to the organiser directly.
  let after = await svc.updateEvent(id, ORG, eventId, { fee: 30000 });
  assert.deepEqual([after.events[0].fee, after.events[0].feeOnline], [30000, false]);
  await assert.rejects(svc.setOfficial(id, ORG, true), (e) => e.status === 403);
  const t = await svc.setOfficial(id, ADMIN, true);
  assert.equal(t.official, true);
  after = await svc.getTournament(id, ORG);
  assert.deepEqual([after.events[0].fee, after.events[0].feeOnline], [30000, true]);
  await assert.rejects(svc.updateEvent(id, ORG, eventId, { fee: -5 }), /Entry fee/);
});

test('paid self-entry: pending until paid, then confirmed with a receipt; replay does nothing', async () => {
  const { id, ms } = await officialCup();
  const res = await enter(id, { name: 'Asha', contact: 'asha@x.dev', event: ms }, base);
  assert.equal(res.pending, true);
  assert.equal(res.payment.amount, 30000); // set by the server from the event
  assert.equal(res.payment.description, 'Entry fee — Men\'s Singles, Tonament Open');
  assert.equal(rp.orders.get(res.payment.orderId).amount, 30000);

  // Pending entries are hidden from the public and shown to organisers.
  assert.equal((await svc.getTournament(id)).events[0].entries.length, 0);
  let t = await svc.getTournament(id, ADMIN);
  assert.deepEqual(t.events[0].entries.map((e) => [e.name, e.feeStatus, e.confirmed]), [['Asha', 'pending', false]]);

  await assert.rejects(svc.verifyPayment(rp.pay(res.payment.orderId, { amount: 100 })), /don't match/);
  const good = rp.pay(res.payment.orderId);
  assert.deepEqual(await svc.verifyPayment(good, base), { ok: true, tournamentId: id, kind: 'entry', event: ms });
  t = await svc.getTournament(id);
  assert.deepEqual(t.events[0].entries.map((e) => [e.name, e.confirmed]), [['Asha', true]]);
  assert.equal((await svc.getTournament(id, ADMIN)).events[0].feeTotal, 30000);
  const receipt = mailer.sent.find((m) => m.to === 'asha@x.dev');
  assert.equal(receipt.subject, 'You\'re entered — Men\'s Singles, Tonament Open');
  assert.match(receipt.text, /₹300\.00/);
  const sent = mailer.sent.length;
  await svc.verifyPayment(good, base);
  assert.equal(mailer.sent.length, sent);
  // The tournament's plan is untouched by entry fees.
  assert.equal((await svc.getTournament(id, ADMIN)).plan, 'free');
});

test('the webhook confirms a paid entry when the tab was closed', async () => {
  const { id, ms } = await officialCup('Webhook Open');
  const res = await enter(id, { name: 'Ben', contact: 'ben@x.dev', event: ms }, base);
  const paid = rp.pay(res.payment.orderId);
  const body = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paid.razorpay_payment_id, order_id: res.payment.orderId, amount: 30000, currency: 'INR' } } },
  });
  await svc.razorpayWebhook(body, sign(WEBHOOK_SECRET, body), base);
  const e = (await svc.getTournament(id, ADMIN)).events[0].entries[0];
  assert.deepEqual([e.name, e.feeStatus, e.confirmed], ['Ben', 'paid', true]);
});

test('places are held while paying; abandoned payments expire; full paid events refuse first', async () => {
  const { id, xd } = await officialCup('Full Open');
  const a = await enter(id, { name: 'A', partner: 'B', contact: 'a@x.dev', event: xd }, base);
  await enter(id, { name: 'C', partner: 'D', contact: 'c@x.dev', event: xd }, base);
  // Both places are held by players paying, so a third can't start paying.
  await assert.rejects(enter(id, { name: 'E', partner: 'F', contact: 'e@x.dev', event: xd }, base), /is full/);
  // Retrying replaces your own unfinished payment instead of being "already entered".
  const again = await enter(id, { name: 'A', partner: 'B', contact: 'a@x.dev', event: xd }, base);
  assert.notEqual(again.payment.orderId, a.payment.orderId);
  // After 30 minutes an unpaid entry no longer holds its place.
  await db.query(`UPDATE entries SET created_at = now() - interval '31 minutes' WHERE contact = 'c@x.dev'`);
  const e = await enter(id, { name: 'E', partner: 'F', contact: 'e@x.dev', event: xd }, base);
  assert.equal(e.pending, true);
  // A very late payment for a cleared entry puts the player back in.
  await db.query(`DELETE FROM entries WHERE contact = 'a@x.dev'`);
  await svc.verifyPayment(rp.pay(again.payment.orderId), base);
  const names = (await svc.getTournament(id, ADMIN)).events[1].entries.map((x) => [x.name, x.feeStatus]);
  assert.ok(names.some(([n, s]) => n === 'A / B' && s === 'paid'));
});

test('organisers record fees paid in person or waive them; online payments are protected', async () => {
  const { id, ms } = await officialCup('Cash Open');
  let t = await svc.addEntries(id, ADMIN, ['Walk In'], { event: ms });
  const walk = t.events[0].entries[0];
  assert.equal(walk.feeStatus, null);
  t = await svc.setEntryFee(id, ADMIN, walk.id, 'cash');
  assert.deepEqual([t.events[0].entries[0].feeStatus, t.events[0].feeTotal], ['cash', 30000]);
  t = await svc.setEntryFee(id, ADMIN, walk.id, 'waived');
  assert.deepEqual([t.events[0].entries[0].feeStatus, t.events[0].feeTotal], ['waived', 0]);
  await assert.rejects(svc.setEntryFee(id, ADMIN, walk.id, 'free'), /status must be/);
  const res = await enter(id, { name: 'Online', contact: 'on@x.dev', event: ms }, base);
  await svc.verifyPayment(rp.pay(res.payment.orderId), base);
  const online = (await svc.getTournament(id, ADMIN)).events[0].entries.find((e) => e.name === 'Online');
  await assert.rejects(svc.setEntryFee(id, ADMIN, online.id, 'waived'), /Razorpay dashboard/);
});

test('a solo doubles player pays half the pair fee and keeps it after pairing', async () => {
  const { id, xd } = await officialCup('Solo Open');
  await svc.updateEvent(id, ADMIN, xd, { maxEntries: '' });
  const res = await enter(id, { name: 'Ravi', contact: 'ravi@x.dev', event: xd, solo: true, side: 'man' }, base);
  assert.equal(res.payment.amount, 25000); // half of ₹500
  assert.match(res.payment.description, /half of the pair fee/);
  await svc.verifyPayment(rp.pay(res.payment.orderId), base);
  await svc.addEntries(id, ADMIN, ['Meena'], { event: xd }); // organiser adds a partner by hand…
  let t = await svc.getTournament(id, ADMIN);
  const meena = t.events[1].entries.find((e) => e.name === 'Meena');
  await db.query(`UPDATE entries SET solo = true, solo_side = 'woman' WHERE id = $1`, [meena.id]); // …as a solo woman
  t = await svc.drawPairs(id, ADMIN, { event: xd });
  const pair = t.events[1].entries.find((e) => e.source === 'drawn');
  assert.deepEqual(pair.members.map((m) => [m.name, m.feeStatus]), [['Ravi', 'paid'], ['Meena', null]]);
  assert.equal(t.events[1].feeTotal, 25000);
});
