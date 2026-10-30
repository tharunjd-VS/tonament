'use strict';

// Email deliverability: a reply-to address, the inbox preview line,
// one-click unsubscribe headers on notifications (not on sign-in emails),
// the POST unsubscribe a mail app sends, and the admin test email.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createMailer, noticeEmail, signInLinkEmail } = require('../server/email');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

test('the mailer sends reply-to and extra headers to Resend', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) }; };
  const mailer = createMailer({ apiKey: 're_test', from: 'Tonament <hello@tonament.com>', replyTo: 'support@tonament.com', fetchImpl });
  assert.deepEqual([mailer.configured, mailer.from, mailer.replyTo], [true, 'Tonament <hello@tonament.com>', 'support@tonament.com']);
  await mailer.send({ to: 'a@b.test', ...noticeEmail({ title: 'Tomorrow: Smash Open', body: 'Court 2 at 7', url: 'https://tonament.com/t/x', unsubscribeUrl: 'https://tonament.com/api/notifications/unsubscribe?t=abc&k=reminder' }) });
  await mailer.send({ to: 'a@b.test', ...signInLinkEmail({ url: 'https://tonament.com/link?x=1', code: 'AB12' }) });
  assert.equal(sent[0].reply_to, 'support@tonament.com');
  assert.deepEqual(sent[0].headers, { 'List-Unsubscribe': '<https://tonament.com/api/notifications/unsubscribe?t=abc&k=reminder>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.equal(sent[1].headers, undefined, 'sign-in emails are transactional: no unsubscribe headers');
  // The inbox preview line (hidden in the email).
  assert.match(sent[1].html, /display:none[^>]*>Tap the button to sign in/);
  assert.match(sent[0].html, /display:none[^>]*>Court 2 at 7/);
  // Without EMAIL_REPLY_TO, no reply_to is sent.
  const plain = createMailer({ apiKey: 're_test', replyTo: null, fetchImpl });
  await plain.send({ to: 'a@b.test', subject: 's', html: 'h', text: 't' });
  assert.equal('reply_to' in sent[2], false);
});

test('one-click unsubscribe by POST; the admin test email', async () => {
  const db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  const mails = [];
  const mailer = { enabled: true, configured: true, from: 'Tonament <hello@tonament.com>', replyTo: null, async send(m) { mails.push(m); return { sent: true }; } };
  const app = createApp(db, { mailer });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const signup = async (name, email) => {
      const res = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name, email, password: 'password123' }) });
      return { cookie: res.headers.get('set-cookie').split(';')[0], user: (await res.json()).user };
    };
    const ann = await signup('Ann Mail', 'ann@mail.test');
    await db.query(`UPDATE users SET notify_token = 'tok-ann' WHERE id = $1`, [ann.user.id]);
    // A mail app's one-click unsubscribe: a POST from elsewhere, no cookies.
    const res = await fetch(`${base}/api/notifications/unsubscribe?t=tok-ann&k=reminder`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://mail.google.com' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(res.status, 200);
    const [{ notify_prefs: prefs }] = await db.query('SELECT notify_prefs FROM users WHERE id = $1', [ann.user.id]);
    assert.equal(prefs.reminder.email, false);
    // The admin test email: admins only.
    const call = (who, m, p, body) => fetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: who.cookie }, body: body && JSON.stringify(body) });
    assert.equal((await call(ann, 'POST', '/api/admin/email-test', { to: 'x@y.test' })).status, 403);
    const boss = await signup('Boss Mail', 'boss@mail.test');
    await db.query('UPDATE users SET is_admin = true WHERE id = $1', [boss.user.id]);
    const info = await (await call(boss, 'GET', '/api/admin/email')).json();
    assert.deepEqual(info, { configured: true, from: 'Tonament <hello@tonament.com>', replyTo: null });
    assert.equal((await call(boss, 'POST', '/api/admin/email-test', { to: 'nope' })).status, 400);
    assert.equal((await call(boss, 'POST', '/api/admin/email-test', { to: 'test-abc@srv1.mail-tester.com' })).status, 200);
    const last = mails[mails.length - 1];
    assert.deepEqual([last.to, last.subject], ['test-abc@srv1.mail-tester.com', 'Tonament test email']);
    // The sign-in screen can say who emails come from.
    assert.equal((await (await fetch(`${base}/api/auth/me`)).json()).emailFrom, 'Tonament <hello@tonament.com>');
  } finally {
    await new Promise((r) => server.close(r));
    await db.close();
  }
});
