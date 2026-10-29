'use strict';

// Notifications: who's told what (never the person who did it, nor anyone
// blocked), the inbox and its count, email for join requests with a working
// "turn these off" link, results to confirm, and push settings.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

const fakeMailer = () => ({ enabled: true, sent: [], async send(m) { this.sent.push(m); return { sent: true }; } });
let db;
let svc;
let mailer;
let server;
let base;
test.before(async () => {
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
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

let n = 0;
async function person(name) {
  n += 1;
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@notify.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  const inbox = async () => (await call('GET', '/api/notifications')).data.items;
  return { ...user, call, inbox, actor: { user: { ...user, isAdmin: false } } };
}

test('follows, kudos and comments tell the people concerned; blocking stops it', async () => {
  const meera = await person('Meera Notify');
  const fan = await person('Fan Notify');
  const troll = await person('Troll Notify');
  await fan.call('POST', '/api/follow', { kind: 'user', id: meera.id });
  await fan.call('POST', '/api/follow', { kind: 'user', id: meera.id, on: false });
  await fan.call('POST', '/api/follow', { kind: 'user', id: meera.id }); // follow again: still one notification
  let items = await meera.inbox();
  assert.deepEqual(items.map((x) => [x.kind, x.title]), [['follow', 'Fan Notify is following you']]);
  assert.deepEqual((await meera.call('GET', '/api/notifications/unread')).data, { unread: 1 });
  // Meera's club post: kudos and a comment from the fan.
  const club = await svc.clubs.create(meera.actor, { name: 'Notify Club', slug: 'notify-club', sports: ['badminton'] });
  const [post] = (await svc.social.clubFeed(club.id, meera.actor)).items;
  await fan.call('POST', `/api/activity/${post.id}/kudos`, { on: true });
  await fan.call('POST', `/api/activity/${post.id}/comments`, { body: 'Count me in!' });
  // Meera's own kudos on her post tells nobody.
  await meera.call('POST', `/api/activity/${post.id}/kudos`, { on: true });
  items = await meera.inbox();
  assert.deepEqual(items.map((x) => x.kind), ['comment', 'kudos', 'follow']);
  assert.equal(items[0].body, 'Count me in!');
  assert.equal(items[0].url, `/a/${post.id}`);
  assert.match(items[1].title, /Fan Notify gave you kudos/);
  // Blocked: Meera blocks the troll, who then can't see her post to comment on it.
  await meera.call('POST', '/api/block', { user: troll.id });
  const r = await troll.call('POST', `/api/activity/${post.id}/comments`, { body: 'boo' });
  assert.equal(r.status, 404, 'a blocked person can\'t see the post to comment');
  assert.equal((await meera.inbox()).length, 3);
  // Read: the count goes.
  assert.deepEqual((await meera.call('POST', '/api/notifications/read', {})).data, { unread: 0 });
});

test('join requests reach the club\'s admins (also by email, with a link to turn them off); approval tells the player', async () => {
  const admin = await person('Club Admin');
  const asker = await person('Asker One');
  const asker2 = await person('Asker Two');
  await svc.clubs.create(admin.actor, { name: 'Closed Club', slug: 'closed-club', open: false, sports: ['badminton'] });
  const before = mailer.sent.length;
  await asker.call('POST', '/api/clubs/closed-club/join', {});
  const [req] = await admin.inbox();
  assert.equal(req.title, 'Asker One wants to join Closed Club');
  assert.equal(req.url, '/club/closed-club?tab=members');
  const mail = mailer.sent[before];
  assert.equal(mail.to, admin.email);
  assert.equal(mail.subject, 'Asker One wants to join Closed Club');
  const off = mail.text.match(/(\/api\/notifications\/unsubscribe\?t=[\w-]+&k=club_request)/)[1];
  const page = await fetch(base + off);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Requests to join your clubs/);
  await asker2.call('POST', '/api/clubs/closed-club/join', {});
  assert.equal(mailer.sent.length, before + 1, 'no more emails once turned off');
  assert.equal((await admin.inbox()).length, 2, 'still in the inbox');
  const st = (await admin.call('GET', '/api/notifications/settings')).data;
  assert.deepEqual(st.kinds.find((k) => k.kind === 'club_request'), { kind: 'club_request', label: 'Requests to join your clubs', push: true, email: false });
  // Approved.
  await admin.call('POST', `/api/clubs/closed-club/members/${asker.id}`, { action: 'approve' });
  assert.deepEqual((await asker.inbox()).map((x) => [x.kind, x.title]), [['club_joined', 'You\'re in Closed Club']]);
});

test('a finished group game asks the losing side to confirm it', async () => {
  const winner = await person('Winner Player');
  const loser = await person('Loser Player');
  const t0 = new Date(Date.now() - 3600000);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t0);
  const { slug } = await svc.groups.createGroup(winner.actor, { name: 'Notify Smashers', sport: 'badminton', courts: 1, days: [0, 1, 2, 3, 4, 5, 6], time, hours: 3, timeZone: 'Asia/Kolkata', singles: true });
  const g = await svc.groups.view(slug, winner.actor);
  await svc.groups.join(slug, loser.actor, { token: g.invite });
  const game = await svc.groups.addResult(slug, winner.actor, g.session.id, { a: [winner.id], b: [loser.id], score: { a: 21, b: 18 } });
  const [x] = await loser.inbox();
  assert.equal(x.kind, 'confirm_game');
  assert.equal(x.title, 'Winner Player won 21–18 — confirm the result');
  assert.equal(x.url, `/g/${slug}/game/${game.id}`);
  assert.equal((await winner.inbox()).filter((y) => y.kind === 'confirm_game').length, 0);
});

test('push: only with VAPID keys; subscriptions are checked', async () => {
  const p = await person('Push Person');
  let st = (await p.call('GET', '/api/notifications/settings')).data;
  assert.equal(st.push.available, false);
  process.env.VAPID_PUBLIC_KEY = 'BExamplePublicKey';
  process.env.VAPID_PRIVATE_KEY = 'example-private';
  st = (await p.call('GET', '/api/notifications/settings')).data;
  assert.deepEqual([st.push.available, st.push.publicKey, st.push.devices], [true, 'BExamplePublicKey', 0]);
  assert.equal((await p.call('POST', '/api/notifications/push', { endpoint: 'http://not-https.example/x', keys: { p256dh: 'a', auth: 'b' } })).status, 400);
  const sub = { endpoint: 'https://push.example.com/send/abc', keys: { p256dh: 'BPublic', auth: 'secret' } };
  st = (await p.call('POST', '/api/notifications/push', sub)).data;
  assert.equal(st.push.devices, 1);
  st = (await p.call('DELETE', '/api/notifications/push', { endpoint: sub.endpoint })).data;
  assert.equal(st.push.devices, 0);
  // Turning push off for a kind.
  st = (await p.call('PATCH', '/api/notifications/settings', { kind: 'kudos', channel: 'push', on: false })).data;
  assert.equal(st.kinds.find((k) => k.kind === 'kudos').push, false);
});

test('push: a notification goes to each of the person\'s phones; a phone that\'s gone is dropped', async () => {
  const webpush = require('web-push');
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  const real = webpush.sendNotification;
  const pushed = [];
  webpush.sendNotification = async (sub, payload) => {
    pushed.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
    if (sub.endpoint.endsWith('/gone')) { const err = new Error('Gone'); err.statusCode = 410; throw err; }
    return { statusCode: 201 };
  };
  try {
    const star = await person('Star Player');
    const fan = await person('Push Fan');
    for (const end of ['phone', 'gone']) await star.call('POST', '/api/notifications/push', { endpoint: `https://push.example.com/${end}`, keys: { p256dh: 'BPublic', auth: 'secret' } });
    await fan.call('POST', '/api/follow', { kind: 'user', id: star.id });
    assert.deepEqual(pushed.map((x) => [x.endpoint, x.title]).sort(), [
      ['https://push.example.com/gone', 'Push Fan is following you'], ['https://push.example.com/phone', 'Push Fan is following you'],
    ]);
    assert.match(pushed[0].url, /^\/p\//);
    assert.equal((await star.call('GET', '/api/notifications/settings')).data.push.devices, 1, 'the gone phone is dropped');
    // Push off for follows: in the inbox, not on the phone.
    await star.call('PATCH', '/api/notifications/settings', { kind: 'follow', channel: 'push', on: false });
    const other = await person('Second Fan');
    await other.call('POST', '/api/follow', { kind: 'user', id: star.id });
    assert.equal(pushed.length, 2);
    assert.equal((await star.inbox()).length, 2);
  } finally {
    webpush.sendNotification = real;
  }
});
