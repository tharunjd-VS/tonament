'use strict';

// Entry fees paid to the organiser directly (UPI or cash): players say when
// they've paid; the organiser confirms. Unpaid entries hold a place for a while.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

let db;
let svc;
const mailer = { enabled: true, sent: [], async send(m) { this.sent.push(m); return { sent: true }; } };
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  svc = createApp(db, { mailer }).service;
});
test.after(() => db.close());

const ORG = { user: { id: 1, email: 'org@upi.test', name: 'Kavya Raman', isAdmin: false } };
let n = 100;
const player = (name) => ({ user: { id: ++n, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@upi.test`, name, isAdmin: false } });
const base = { baseUrl: 'https://tonament.example' };

async function cup({ max, holdHours } = {}) {
  const { id } = await svc.createTournament(ORG, {
    name: 'UPI Cup', visibility: 'public', format: 'knockout',
    events: [{ discipline: 'singles', gender: 'open' }, { discipline: 'doubles', gender: 'open' }],
  });
  const t = await svc.getTournament(id, ORG);
  const [singles, doubles] = t.events.map((e) => e.id);
  await svc.updateEvent(id, ORG, singles, { fee: 50000, ...(max && { maxEntries: max }) });
  await svc.updateEvent(id, ORG, doubles, { fee: 80000 });
  await svc.updateSettings(id, ORG, { payment: { upi: 'Kavya@OKHDFCBANK', payee: 'Kavya Raman', note: 'Cash at the desk too', ...(holdHours !== undefined && { holdHours }) } });
  return { id, singles, doubles };
}
const entryOf = async (id, actor, eventId) => (await svc.getTournament(id, actor)).myEntries.find((e) => e.eventId === eventId);
const orgEntry = async (id, eventId, name) => (await svc.getTournament(id, ORG)).events.find((e) => e.id === eventId).entries.find((e) => e.name === name);

test('payment settings', async () => {
  const { id } = await cup();
  const t = await svc.getTournament(id);
  assert.deepEqual(t.payment, { upi: 'kavya@okhdfcbank', payee: 'Kavya Raman', note: 'Cash at the desk too', holdHours: 48, qr: null, qrId: null });
  assert.deepEqual([t.events[0].fee, t.events[0].feeOnline], [50000, false]);
  const bad = (payment, re) => assert.rejects(svc.updateSettings(id, ORG, { payment }), (e) => e.status === 400 && re.test(e.message));
  await bad({ upi: 'not a upi' }, /UPI ID like/);
  await bad({ upi: 'ab@okaxis', holdHours: 12 }, /24 or 48 hours/);
  // The QR code is an image like any other, replaced on upload.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await svc.uploadMedia(id, ORG, { kind: 'qr', data: png });
  assert.match((await svc.getTournament(id)).payment.qr, /^\/api\/media\//);
});

test('entering: the fee is due and the place is held; full events go to the waitlist', async () => {
  const { id, singles, doubles } = await cup({ max: 2 });
  const asha = player('Asha');
  const res = await svc.register(id, asha, { event: singles }, base);
  assert.deepEqual([res.confirmed, res.due, res.holding], [false, 50000, true]);
  let mine = await entryOf(id, asha, singles);
  assert.deepEqual([mine.feeStatus, mine.feeAmount, mine.confirmed], ['due', 50000, false]);
  const hours = (Date.parse(mine.holdUntil) - Date.now()) / 3600000;
  assert.ok(hours > 47.9 && hours <= 48);
  // Solo doubles players pay half.
  assert.equal((await svc.register(id, asha, { event: doubles, solo: true })).due, 40000);

  await svc.register(id, player('Ben'), { event: singles });
  const cy = player('Cy');
  const full = await svc.register(id, cy, { event: singles });
  assert.equal(full.holding, false); // two places, both held
  mine = await entryOf(id, cy, singles);
  assert.ok(Date.parse(mine.holdUntil) <= Date.now());

  // When Asha's hold runs out, her place frees up and Cy can be confirmed.
  await db.query(`UPDATE entries SET hold_until = now() - interval '1 minute' WHERE contact = $1`, [asha.user.email]);
  const t = await svc.setEntryFee(id, ORG, (await orgEntry(id, singles, 'Cy')).id, 'cash');
  assert.equal(t.events[0].entries.find((e) => e.name === 'Cy').confirmed, true);
  await assert.rejects(svc.setEntryFee(id, ORG, (await orgEntry(id, singles, 'Asha')).id, 'received'), /full/);
});

test('the player says they paid; the organiser confirms (or not)', async () => {
  const { id, singles } = await cup();
  const asha = player('Asha');
  await svc.register(id, asha, { event: singles });
  const { id: eid } = await entryOf(id, asha, singles);
  await assert.rejects(svc.markFeeSent(id, player('Someone'), eid), (e) => e.status === 404);
  await assert.rejects(svc.markFeeSent(id, asha, eid, '1234'), /12-digit/);
  let t = await svc.markFeeSent(id, asha, eid, '4012 3456 7890');
  assert.deepEqual([t.myEntries[0].feeStatus, t.myEntries[0].payRef, t.myEntries[0].holdUntil], ['sent', '401234567890', null]);
  // Organisers see the reference; the place stays held until they decide.
  const seen = await orgEntry(id, singles, 'Asha');
  assert.deepEqual([seen.feeStatus, seen.payRef, Boolean(seen.paySentAt)], ['sent', '401234567890', true]);
  await assert.rejects(svc.confirmEntry(id, ORG, eid), /Record their entry fee first/);

  // Not received: back to due, and the player is emailed.
  mailer.sent.length = 0;
  t = await svc.setEntryFee(id, ORG, eid, 'missing', base);
  assert.equal(t.events[0].entries.find((e) => e.name === 'Asha').feeStatus, 'due');
  assert.equal(mailer.sent[0].to, asha.user.email);
  assert.match(mailer.sent[0].subject, /check your payment/);
  await assert.rejects(svc.setEntryFee(id, ORG, eid, 'missing', base), /hasn't said they paid/);

  // Paid again, then received: confirmed and emailed.
  await svc.markFeeSent(id, asha, eid);
  mailer.sent.length = 0;
  t = await svc.setEntryFee(id, ORG, eid, 'received', base);
  const e = t.events[0].entries.find((x) => x.name === 'Asha');
  assert.deepEqual([e.feeStatus, e.confirmed, e.feeAmount], ['received', true, 50000]);
  assert.match(mailer.sent[0].subject, /You're in/);
  assert.equal(t.events[0].feeTotal, 50000);
  await assert.rejects(svc.setEntryFee(id, ORG, eid, 'waived'), /already paid/);
  await assert.rejects(svc.leave(id, asha, eid), /Contact the organiser/);
  await assert.rejects(svc.markFeeSent(id, asha, eid), /nothing to pay/);
});

test('cash, waived, withdrawing while unpaid, and the hold until entries close', async () => {
  const { id, singles } = await cup({ holdHours: 0 });
  const ben = player('Ben');
  const cy = player('Cy');
  await svc.register(id, ben, { event: singles });
  await svc.register(id, cy, { event: singles });
  assert.equal((await entryOf(id, ben, singles)).holdUntil, null); // held until the draw (no closing time)
  let t = await svc.setEntryFee(id, ORG, (await orgEntry(id, singles, 'Ben')).id, 'cash');
  assert.deepEqual(['feeStatus', 'confirmed'].map((k) => t.events[0].entries.find((e) => e.name === 'Ben')[k]), ['cash', true]);
  t = await svc.setEntryFee(id, ORG, (await orgEntry(id, singles, 'Cy')).id, 'waived');
  assert.deepEqual(['feeStatus', 'feeAmount'].map((k) => t.events[0].entries.find((e) => e.name === 'Cy')[k]), ['waived', null]);

  const dee = player('Dee');
  await svc.register(id, dee, { event: singles });
  t = await svc.leave(id, dee, (await entryOf(id, dee, singles)).id); // unpaid: can withdraw
  assert.equal(t.events[0].entries.some((e) => e.name === 'Dee'), false);

  // My entries shows where each stands.
  const eve = player('Eve');
  await svc.register(id, eve, { event: singles });
  assert.equal((await svc.myEntries(eve)).find((x) => x.id === id).entry.status, 'due');
  await svc.markFeeSent(id, eve, (await entryOf(id, eve, singles)).id);
  assert.equal((await svc.myEntries(eve)).find((x) => x.id === id).entry.status, 'sent');
});

test('unpaid entries are never confirmed automatically, and stay out of the draw', async () => {
  const { id, singles } = await cup();
  await svc.register(id, player('Ann'), { event: singles });
  await svc.addEntries(id, ORG, ['Bo', 'Cal'], { event: singles });
  await svc.updateEvent(id, ORG, singles, { maxEntries: 10 }); // a higher maximum confirms waiting entries — not unpaid ones
  assert.equal((await orgEntry(id, singles, 'Ann')).confirmed, false);
  const t = await svc.start(id, ORG, { event: singles, skipUnconfirmed: true });
  assert.deepEqual(t.events[0].entries.filter((e) => e.inDraw).map((e) => e.name).sort(), ['Bo', 'Cal']);
});
