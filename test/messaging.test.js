'use strict';

// Messaging: email through the mailer; WhatsApp and SMS off until switched
// on, then only with an opt-in (or for codes), under a daily cap, logged,
// and never breaking the caller. Phone codes: 503 while off; then sent,
// hashed, expiring, five tries and rate-limited. Sign-up sources.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const { createMessaging, normalizePhone, maskPhone } = require('../server/messaging');
const { cleanSource } = require('../server/sources');

const fakeMailer = () => ({ enabled: true, sent: [], async send(m) { this.sent.push(m); return { sent: true }; } });
const fakeAdapter = (name, { failing = false } = {}) => ({
  name, enabled: true, sent: [],
  async send(m) { if (failing) throw new Error(`${name} is down`); this.sent.push(m); return { id: `${name}-${this.sent.length}` }; },
});

let db;
test.before(async () => { db = await createDb(process.env.TEST_DATABASE_URL || ':memory:'); });
test.after(async () => { await db.close(); });

let n = 0;
async function user(extra = {}) {
  n += 1;
  const [u] = await db.query(
    `INSERT INTO users (email, name, password_hash, phone, phone_verified_at, whatsapp_opt_in_at) VALUES ($1, $2, 'x', $3, $4, $5) RETURNING *`,
    [`m${n}@msg.test`, `Msg ${n}`, extra.phone || null, extra.phone ? new Date() : null, extra.optIn ? new Date() : null],
  );
  return u;
}

test('phone numbers: Indian numbers by default, E.164 kept, junk refused', () => {
  assert.equal(normalizePhone('98765 43210'), '+919876543210');
  assert.equal(normalizePhone('098765-43210'), '+919876543210');
  assert.equal(normalizePhone('919876543210'), '+919876543210');
  assert.equal(normalizePhone('+44 7700 900123'), '+447700900123');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(''), null);
  assert.match(maskPhone('+919876543210'), /3210$/);
  assert.doesNotMatch(maskPhone('+919876543210'), /98765/);
});

test('WhatsApp and SMS are off without settings; email goes through the mailer and is logged', async () => {
  const mailer = fakeMailer();
  const m = createMessaging({ db, mailer, env: {} });
  assert.deepEqual(m.channels(), { email: true, whatsapp: false, sms: false });
  assert.equal(m.phoneEnabled(), false);
  const u = await user({ phone: '+919800000001', optIn: true });
  const out = await m.send(db.query, { user: u.id, template: 'notice', channels: ['email', 'whatsapp', 'sms'], data: { title: 'Hello', body: 'There', url: 'https://tonament.com/x' } });
  assert.deepEqual(out.map((x) => [x.channel, x.status]), [['email', 'sent'], ['whatsapp', 'skipped'], ['sms', 'skipped']]);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0].to, u.email);
  assert.equal(mailer.sent[0].subject, 'Hello');
  const log = await db.query('SELECT channel, template, status, provider FROM message_log WHERE user_id = $1', [u.id]);
  assert.deepEqual(log, [{ channel: 'email', template: 'notice', status: 'sent', provider: 'resend' }]);
  // Configured providers switch themselves on.
  const on = createMessaging({ db, mailer, env: { WHATSAPP_PROVIDER: 'meta', WHATSAPP_TOKEN: 't', WHATSAPP_PHONE_ID: '1', SMS_PROVIDER: 'twilio', SMS_KEY: 'a:b', SMS_SENDER: '+1' } });
  assert.deepEqual(on.channels(), { email: true, whatsapp: true, sms: true });
});

test('WhatsApp only with an opt-in (codes aside); SMS only for SMS templates; the daily cap; failures never throw', async () => {
  const whatsapp = fakeAdapter('wa');
  const sms = fakeAdapter('sms');
  const m = createMessaging({ db, env: { MESSAGING_DAILY_CAP: '3' }, adapters: { whatsapp, sms } });
  const out = await m.send(db.query, { user: await user({ phone: '+919800000002' }), template: 'notice', channels: ['whatsapp', 'sms'], data: { title: 'T', url: 'u' } });
  assert.deepEqual(out.map((x) => x.error), ['not opted in', 'not an SMS template']);
  const fan = await user({ phone: '+919800000003', optIn: true });
  const ok = await m.send(db.query, { user: fan.id, template: 'notice', channels: ['whatsapp'], data: { title: 'T', url: 'u' } });
  assert.equal(ok[0].status, 'sent');
  assert.equal(whatsapp.sent[0].to, '+919800000003');
  // A code goes to the number asked for, no opt-in needed; first: stop once one works.
  const code = await m.send(db.query, { to: { phone: '+919800000004' }, template: 'otp.login', channels: ['whatsapp', 'sms'], first: true, data: { code: '123456', minutes: 10 } });
  assert.deepEqual(code.map((x) => [x.channel, x.status]), [['whatsapp', 'sent']]);
  // The cap (3 a day per channel): two sent, one more, then no more.
  await m.send(db.query, { to: { phone: '+919800000005' }, template: 'otp.login', channels: ['whatsapp'], data: { code: '1', minutes: 10 } });
  const capped = await m.send(db.query, { to: { phone: '+919800000006' }, template: 'otp.login', channels: ['whatsapp', 'sms'], data: { code: '1', minutes: 10 } });
  assert.deepEqual(capped.map((x) => [x.channel, x.status, x.error || null]), [['whatsapp', 'skipped', 'daily cap'], ['sms', 'sent', null]]);
  // A provider that's down: logged, reported, not thrown.
  const broken = createMessaging({ db, env: {}, adapters: { sms: fakeAdapter('down', { failing: true }) } });
  const failed = await broken.send(db.query, { to: { phone: '+919800000007' }, template: 'otp.reset', channels: ['sms'], data: { code: '1', minutes: 10 } });
  assert.deepEqual(failed.map((x) => [x.status, x.error]), [['failed', 'down is down']]);
  const [row] = await db.query(`SELECT status, error FROM message_log WHERE recipient = '+919800000007'`);
  assert.deepEqual(row, { status: 'failed', error: 'down is down' });
  await assert.rejects(m.send(db.query, { template: 'nope' }), /Unknown message template/);
});

test('notifications: email as before, WhatsApp per kind once it is on (and opted in)', async () => {
  const mailer = fakeMailer();
  const whatsapp = fakeAdapter('wa');
  const app = createApp(db, { mailer, messaging: createMessaging({ db, mailer, env: {}, adapters: { whatsapp } }) });
  const svc = app.service;
  const u = await user({ phone: '+919800000010', optIn: true });
  const actor = { user: { id: u.id, email: u.email, name: u.name } };
  let s = await svc.notify.settings(actor);
  assert.deepEqual(s.whatsapp, { phone: true, optedIn: true });
  assert.equal(s.kinds.find((k) => k.kind === 'challenge').whatsapp, false);
  await svc.notify.send(db.query, { users: [u.id], kind: 'challenge', title: 'Asha challenged you', url: '/challenges' });
  assert.equal(mailer.sent.length, 1, 'challenges are emailed by default');
  assert.equal(whatsapp.sent.length, 0, 'WhatsApp is off until turned on');
  assert.match(mailer.sent[0].text, /api\/notifications\/unsubscribe\?t=/);
  s = await svc.notify.setPref(actor, { kind: 'challenge', channel: 'whatsapp', on: true });
  assert.equal(s.kinds.find((k) => k.kind === 'challenge').whatsapp, true);
  await svc.notify.send(db.query, { users: [u.id], kind: 'challenge', title: 'Ravi challenged you', url: '/challenges', dedupe: 'x2' });
  assert.equal(whatsapp.sent.length, 1);
  assert.deepEqual(whatsapp.sent[0].template.whatsapp.params(whatsapp.sent[0].data), ['Ravi challenged you', '', 'https://tonament.com/challenges']);
  // With WhatsApp off, no WhatsApp setting, nor a way to turn it on.
  const plain = createApp(db, { mailer }).service;
  assert.equal((await plain.notify.settings(actor)).whatsapp, null);
  assert.equal((await plain.notify.settings(actor)).kinds[0].whatsapp, undefined);
  await assert.rejects(plain.notify.setPref(actor, { kind: 'challenge', channel: 'whatsapp', on: true }), /isn't available/);
});

// ---------- phone codes, over HTTP

async function serve(app) {
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, cookie, ip = '10.0.0.1') => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, 'X-Forwarded-For': ip, ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test('phone codes: off (503) until a channel is on', async () => {
  const s = await serve(createApp(db, { mailer: fakeMailer() }));
  try {
    const r = await s.call('POST', '/api/auth/otp/request', { phone: '9876543210' });
    assert.equal(r.status, 503);
    assert.match(r.data.error, /isn't available yet/);
    assert.equal((await s.call('GET', '/api/auth/me')).data.phoneEnabled, false);
  } finally { await s.close(); }
});

test('phone codes: confirm a number, sign in with it, reset a password; hashed, 5 tries, rate-limited', async () => {
  const sms = fakeAdapter('sms');
  const mailer = fakeMailer();
  const s = await serve(createApp(db, { mailer, messaging: createMessaging({ db, mailer, env: {}, adapters: { sms } }) }));
  const lastCode = () => sms.sent.at(-1).data.code;
  try {
    assert.equal((await s.call('GET', '/api/auth/me')).data.phoneEnabled, true);
    const up = await s.call('POST', '/api/auth/signup', { name: 'Phone Person', email: 'phone.person@msg.test', password: 'password123' });
    const me = up.cookie;
    // Confirming a number needs an account.
    assert.equal((await s.call('POST', '/api/auth/otp/request', { phone: '9811111111', purpose: 'verify' })).status, 401);
    let r = await s.call('POST', '/api/auth/otp/request', { phone: '98111 11111', purpose: 'verify' }, me);
    assert.equal(r.status, 200);
    assert.equal(r.data.by, 'sms');
    assert.match(r.data.to, /1111$/);
    assert.equal(sms.sent.at(-1).to, '+919811111111');
    assert.match(lastCode(), /^\d{6}$/);
    const [stored] = await db.query(`SELECT code_hash FROM otp_codes WHERE target = '+919811111111'`);
    assert.notEqual(stored.code_hash, lastCode(), 'only a hash is kept');
    const wrong = lastCode() === '000000' ? '111111' : '000000';
    assert.equal((await s.call('POST', '/api/auth/otp/verify', { phone: '9811111111', code: wrong, purpose: 'verify' }, me)).status, 400);
    r = await s.call('POST', '/api/auth/otp/verify', { phone: '9811111111', code: lastCode(), purpose: 'verify', whatsapp: true }, me);
    assert.equal(r.status, 200);
    assert.deepEqual((await s.call('GET', '/api/me/phone', null, me)).data, { available: true, channels: { email: true, whatsapp: false, sms: true }, phone: r.data.phone, whatsapp: true });
    // A used code doesn't work twice.
    assert.equal((await s.call('POST', '/api/auth/otp/verify', { phone: '9811111111', code: lastCode(), purpose: 'verify' }, me)).status, 400);

    // Sign in with the number.
    const sentBefore = sms.sent.length;
    r = await s.call('POST', '/api/auth/otp/request', { phone: '9811111111', purpose: 'login' }, null, '10.0.0.2');
    assert.equal(r.status, 200);
    assert.equal(sms.sent.length, sentBefore + 1);
    r = await s.call('POST', '/api/auth/otp/verify', { phone: '9811111111', code: lastCode(), purpose: 'login' });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.email, 'phone.person@msg.test');
    assert.match(r.cookie, /^tn_session=/);

    // An unknown number: the same answer, but nothing is sent.
    const quiet = sms.sent.length;
    r = await s.call('POST', '/api/auth/otp/request', { phone: '9822222222', purpose: 'login' }, null, '10.0.0.3');
    assert.equal(r.status, 200);
    assert.equal(sms.sent.length, quiet);

    // Reset: the code gives a reset token that sets a new password.
    r = await s.call('POST', '/api/auth/otp/request', { phone: '9811111111', purpose: 'reset' }, null, '10.0.0.4');
    assert.equal(r.status, 200);
    const resetCode = lastCode();
    assert.equal((await s.call('POST', '/api/auth/otp/request', { phone: '9811111111', purpose: 'login' }, null, '10.0.0.4')).status, 429, 'three codes per number per 10 minutes');
    r = await s.call('POST', '/api/auth/otp/verify', { phone: '9811111111', code: resetCode, purpose: 'reset' });
    assert.ok(r.data.resetToken);
    r = await s.call('POST', '/api/auth/reset', { token: r.data.resetToken, password: 'newpassword1' });
    assert.equal(r.status, 200);
    assert.equal((await s.call('POST', '/api/auth/login', { email: 'phone.person@msg.test', password: 'newpassword1' })).status, 200);

    // Five wrong tries and the code is spent.
    await db.query(`UPDATE otp_codes SET created_at = now() - interval '11 minutes' WHERE target = '+919811111111'`);
    await s.call('POST', '/api/auth/otp/request', { phone: '9811111111', purpose: 'login' }, null, '10.0.0.5');
    const good = lastCode();
    const bad = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) assert.equal((await s.call('POST', '/api/auth/otp/verify', { phone: '9811111111', code: bad, purpose: 'login' })).status, 400);
    assert.equal((await s.call('POST', '/api/auth/otp/verify', { phone: '9811111111', code: good, purpose: 'login' })).status, 400);

    // Expired codes don't work.
    await db.query(`UPDATE otp_codes SET created_at = now() - interval '11 minutes' WHERE target = '+919811111111'`);
    await s.call('POST', '/api/auth/otp/request', { phone: '9811111111', purpose: 'login' }, null, '10.0.0.6');
    await db.query(`UPDATE otp_codes SET expires_at = now() - interval '1 second' WHERE target = '+919811111111'`);
    assert.equal((await s.call('POST', '/api/auth/otp/verify', { phone: '9811111111', code: lastCode(), purpose: 'login' })).status, 400);

    // Ten an hour from one address.
    for (let i = 0; i < 10; i += 1) await s.call('POST', '/api/auth/otp/request', { phone: `98333333${String(i).padStart(2, '0')}`, purpose: 'login' }, null, '10.0.0.9');
    assert.equal((await s.call('POST', '/api/auth/otp/request', { phone: '9844444444', purpose: 'login' }, null, '10.0.0.9')).status, 429);

    // Another account can't take a confirmed number.
    const other = (await s.call('POST', '/api/auth/signup', { name: 'Other', email: 'other.phone@msg.test', password: 'password123' })).cookie;
    assert.equal((await s.call('POST', '/api/auth/otp/request', { phone: '9811111111', purpose: 'verify' }, other, '10.0.1.1')).status, 409);
  } finally { await s.close(); }
});

// ---------- where people come from

test('sources: classed from the first touch', () => {
  assert.equal(cleanSource({ s: 'wa', utm_source: 'x' }, 'abcd1234').class, 'referral');
  assert.deepEqual(cleanSource({ s: 'WA', landing: '/t/abc', referrer: 'https://www.tonament.com/x' }), { s: 'wa', landing: '/t/abc', class: 'shared' });
  assert.equal(cleanSource({ utm_source: 'whatsapp' }).class, 'social');
  assert.equal(cleanSource({ utm_source: 'poster', utm_medium: 'qr', utm_campaign: 'Chennai Open' }).class, 'campaign');
  assert.equal(cleanSource({ referrer: 'https://www.google.co.in/' }).class, 'search');
  assert.equal(cleanSource({ referrer: 'https://l.instagram.com/?u=1' }).class, 'social');
  assert.equal(cleanSource({ referrer: 'https://blog.example.org/post' }).class, 'web');
  assert.equal(cleanSource(null).class, 'direct');
  assert.equal(cleanSource({ evil: 'x', utm_source: 'a'.repeat(500) }).source.length, 60);
  assert.equal(cleanSource({ landing: 'https://evil.example' }).landing, undefined);
});

test('sources: set at sign-up (password or link), and copied to the tournaments people create', async () => {
  const mailer = fakeMailer();
  const s = await serve(createApp(db, { mailer }));
  try {
    const a = await s.call('POST', '/api/auth/signup', { name: 'Utm Person', email: 'utm.person@msg.test', password: 'password123', source: { utm_source: 'whatsapp', landing: '/' } });
    const [u] = await db.query(`SELECT source FROM users WHERE email = 'utm.person@msg.test'`);
    assert.equal(u.source.class, 'social');
    assert.equal(u.source.source, 'whatsapp');
    const t = await s.call('POST', '/api/tournaments', { name: 'Source Cup', sport: 'badminton' }, a.cookie);
    assert.equal(t.status, 201, JSON.stringify(t.data));
    const [row] = await db.query('SELECT source FROM tournaments WHERE id = $1', [t.data.id]);
    assert.equal(row.source.class, 'social');

    // By an emailed link: the source travels with the link.
    const r = await s.call('POST', '/api/auth/link', { email: 'link.person@msg.test', source: { referrer: 'https://www.google.com/' } });
    assert.equal(r.status, 200);
    const token = mailer.sent.at(-1).text.match(/token=([\w-]+)/)[1];
    const used = await s.call('POST', '/api/auth/link/use', { token, name: 'Link Person' });
    assert.equal(used.status, 200);
    const [l] = await db.query(`SELECT source FROM users WHERE email = 'link.person@msg.test'`);
    assert.equal(l.source.class, 'search');
    assert.equal(l.source.referrer, 'google.com');
  } finally { await s.close(); }
});
