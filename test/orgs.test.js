'use strict';

// Academy / venue pages (tonament.com/@slug): page addresses, who can edit,
// the yearly payment and its grace period, linked tournaments, the public
// page and sitemap, admin controls, and the site-wide branding switch.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

const KEY_ID = 'rzp_test_ORG';
const KEY_SECRET = 'org_key_secret';
const ENV = { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: 'whsec', APP_URL: 'https://tonament.example', ADMIN_EMAILS: 'root@org.test' };
const sign = (data) => crypto.createHmac('sha256', KEY_SECRET).update(data).digest('hex');

function fakeRazorpay() {
  const orders = new Map();
  const payments = new Map();
  let n = 0;
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
    if (m) return json(200, { id: `rfnd_${++n}` });
    return json(404, {});
  };
  const pay = (orderId) => {
    const o = orders.get(orderId);
    const id = `pay_${++n}`;
    payments.set(id, { id, order_id: orderId, amount: o.amount, currency: o.currency, status: 'captured' });
    return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: sign(`${orderId}|${id}`) };
  };
  return { fetchImpl, pay };
}

let db;
let rp;
let server;
let base;
const saved = {};
test.before(async () => {
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  rp = fakeRazorpay();
  const app = createApp(db, { mailer: { enabled: false, async send() { return {}; } }, fetchImpl: rp.fetchImpl });
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function browser(name, email) {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body),
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
const anon = async (path) => { const res = await fetch(base + path, { redirect: 'manual' }); return { status: res.status, html: await res.text(), headers: res.headers }; };
// No public page (a draft, lapsed or unpublished): the club lives in the app.
const inApp = (r, slug) => r.status === 302 && r.headers.get('location') === `/club/${slug}`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const pngN = (n) => Buffer.concat([png, Buffer.from(`x${n}`)]).toString('base64'); // distinct images

async function payFor(owner, slug) {
  const order = (await owner.call('POST', `/api/orgs/${slug}/checkout`, {})).data;
  const r = await owner.call('POST', '/api/billing/razorpay/verify', rp.pay(order.orderId));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return order;
}

test('page addresses: suggested from the name, checked, reserved words refused', async () => {
  const owner = await browser('Owner One', 'owner1@org.test');
  let r = await owner.call('GET', `/api/orgs/slug?name=${encodeURIComponent('Smash Point Academy!')}`);
  assert.deepEqual([r.data.slug, r.data.available], ['smash-point-academy', true]);
  r = await owner.call('POST', '/api/orgs', { name: 'Smash Point Academy', kind: 'academy', city: 'Chennai', sports: ['badminton', 'curling'] });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.slug, r.data.live, r.data.can.own, r.data.sports.map((x) => x.id)], ['smash-point-academy', false, true, ['badminton']]);
  assert.equal((await owner.call('POST', '/api/orgs', { name: 'Smash Point Academy' })).status, 409);
  for (const bad of ['badminton', 'admin', 'mine', 'ab']) {
    r = await owner.call('POST', '/api/orgs', { name: 'X', slug: bad });
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await owner.call('GET', '/api/orgs/slug?name=badminton')).data.available, false);
  const stranger = await fetch(`${base}/api/orgs/slug?name=x`);
  assert.equal(stranger.status, 200);
});

test('drafts are private; team can edit, owner pays; a paid page is public with its tournaments', async () => {
  const owner = await browser('Kavya', 'kavya@org.test');
  const editor = await browser('Coach Ravi', 'ravi@org.test');
  const stranger = await browser('Stranger', 'stranger@org.test');
  const { data: o } = await owner.call('POST', '/api/orgs', { name: 'Anna Nagar Shuttlers', slug: 'shuttlers', city: 'Chennai', sports: ['badminton'] });
  assert.equal(o.slug, 'shuttlers');

  // Draft: no public page (the club is in the app), the page is visible to the team (also as a preview).
  assert.ok(inApp(await anon('/@shuttlers'), 'shuttlers'));
  assert.equal((await stranger.call('GET', '/api/orgs/shuttlers')).status, 404);
  assert.equal((await owner.call('GET', '/api/orgs/shuttlers')).status, 200);

  // Edit: owner and editor; not a stranger. Only the owner pays and manages the team.
  let r = await owner.call('PATCH', '/api/orgs/shuttlers', {
    about: 'Six wooden courts in Anna Nagar.\nCoaching for all ages.', phone: '+91 98765 43210', whatsapp: '98765 43210', website: 'shuttlers.example.com',
    instagram: '@anna.shuttlers', courts: '6 wooden courts', timings: 'Mon–Sun 5am–10pm', address: '12 2nd Avenue', postcode: '600040',
    coaching: [{ title: 'Kids batch', who: 'Ages 7–14', when: 'Weekdays 5–6pm', fee: '₹2,500/month' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.contact.website, r.data.contact.instagram, r.data.coaching.length], ['https://shuttlers.example.com/', 'anna.shuttlers', 1]);
  assert.equal((await owner.call('PATCH', '/api/orgs/shuttlers', { website: 'javascript:alert(1)' })).status, 400);
  assert.equal((await stranger.call('PATCH', '/api/orgs/shuttlers', { about: 'hacked' })).status, 403);
  assert.equal((await owner.call('POST', '/api/orgs/shuttlers/members', { email: 'ravi@org.test' })).status, 200);
  assert.equal((await editor.call('PATCH', '/api/orgs/shuttlers', { timings: 'Daily 5am–11pm' })).data.timings, 'Daily 5am–11pm');
  assert.equal((await editor.call('POST', '/api/orgs/shuttlers/members', { email: 'x@org.test' })).status, 403);
  assert.equal((await editor.call('POST', '/api/orgs/shuttlers/checkout', {})).status, 403);
  assert.deepEqual((await owner.call('GET', '/api/orgs/mine')).data.map((x) => x.slug), ['shuttlers']);
  assert.deepEqual((await editor.call('GET', '/api/orgs/mine')).data.map((x) => [x.slug, x.role]), [['shuttlers', 'editor']]);

  // Photos: logo and cover replace, photos up to the limit; images are served.
  r = await owner.call('POST', '/api/orgs/shuttlers/media', { kind: 'logo', data: pngN(1) });
  r = await owner.call('POST', '/api/orgs/shuttlers/media', { kind: 'logo', data: pngN(2) });
  assert.ok(r.data.logo);
  r = await owner.call('POST', '/api/orgs/shuttlers/media', { kind: 'photo', data: pngN(3), caption: 'Court 1' });
  assert.equal(r.data.photos.length, 1);
  const img = await fetch(base + r.data.logo);
  assert.deepEqual([img.status, img.headers.get('content-type')], [200, 'image/png']);
  assert.equal((await owner.call('POST', '/api/orgs/shuttlers/media', { kind: 'photo', data: Buffer.from('nope').toString('base64') })).status, 400);

  // Tournaments: linked by someone who manages both.
  const pub = (await owner.call('POST', '/api/tournaments', { name: 'Shuttlers Open', visibility: 'public', startsOn: '2031-02-01', events: [{ discipline: 'singles', gender: 'men' }] })).data.id;
  const priv = (await owner.call('POST', '/api/tournaments', { name: 'Shuttlers Members Night', visibility: 'private', events: [{ discipline: 'singles', gender: 'men' }] })).data.id;
  const theirs = (await stranger.call('POST', '/api/tournaments', { name: 'Not Theirs', visibility: 'public', events: [{ discipline: 'singles', gender: 'men' }] })).data.id;
  assert.equal((await owner.call('POST', `/api/tournaments/${pub}/org`, { org: 'shuttlers' })).status, 200);
  assert.equal((await owner.call('POST', `/api/tournaments/${priv}/org`, { org: 'shuttlers' })).status, 200);
  assert.equal((await stranger.call('POST', `/api/tournaments/${theirs}/org`, { org: 'shuttlers' })).status, 403);
  assert.equal((await owner.call('POST', `/api/tournaments/${theirs}/org`, { org: 'shuttlers' })).status, 403);
  assert.equal((await owner.call('GET', `/api/tournaments/${pub}?me=1`)).data.org.slug, 'shuttlers');
  assert.equal((await owner.call('GET', `/api/tournaments/${pub}`)).data.org, null); // not public yet

  // Pay: public for a year; the page, its data and the sitemap.
  await payFor(owner, 'shuttlers');
  r = await owner.call('GET', '/api/orgs/shuttlers');
  assert.equal(r.data.live, true);
  const until = Date.parse(r.data.paidUntil);
  assert.ok(Math.abs(until - (Date.now() + 365 * 86400000)) < 2 * 86400000);
  const page = await anon('/@shuttlers');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('cache-control'), /s-maxage=600/);
  assert.match(page.html, /<h1>Anna Nagar Shuttlers<\/h1>/);
  assert.match(page.html, /<title>Anna Nagar Shuttlers — Academy in Chennai \| Tonament<\/title>/);
  assert.ok(page.html.includes(`/t/${pub}`));
  assert.ok(!page.html.includes(`/t/${priv}`)); // private tournaments never show
  assert.ok(page.html.includes('https://wa.me/9876543210'));
  assert.ok(page.html.includes('Kids batch'));
  const blocks = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const place = blocks.find((b) => b['@type'] === 'SportsActivityLocation');
  assert.deepEqual([place.name, place.address.addressLocality, place.telephone], ['Anna Nagar Shuttlers', 'Chennai', '+919876543210']);
  assert.equal((await anon('/api/org/shuttlers')).status, 200); // the Vercel route
  assert.ok((await anon('/sitemap.xml')).html.includes('/@shuttlers</loc>'));
  assert.equal((await owner.call('GET', `/api/tournaments/${pub}`)).data.org.slug, 'shuttlers');

  // Renewing early adds a year to the end.
  await payFor(owner, 'shuttlers');
  const renewed = Date.parse((await owner.call('GET', '/api/orgs/shuttlers')).data.paidUntil);
  assert.ok(Math.abs(renewed - until - 365 * 86400000) < 2 * 86400000);

  // Lapsed: public during the grace period, then gone; the team still sees it; tournaments carry on.
  await db.query(`UPDATE orgs SET paid_until = now() - interval '3 days' WHERE slug = 'shuttlers'`);
  assert.equal((await anon('/@shuttlers')).status, 200);
  await db.query(`UPDATE orgs SET paid_until = now() - interval '20 days' WHERE slug = 'shuttlers'`);
  assert.ok(inApp(await anon('/@shuttlers'), 'shuttlers'));
  assert.ok(!(await anon('/sitemap.xml')).html.includes('/@shuttlers'));
  assert.equal((await owner.call('GET', '/api/orgs/shuttlers')).data.live, false);
  const preview = await owner.call('GET', '/@shuttlers?preview=1');
  assert.equal(preview.status, 200);
  assert.match(preview.data, /noindex/);
  assert.ok(inApp(await anon('/@shuttlers?preview=1'), 'shuttlers')); // not the team: the club in the app
  assert.equal((await anon(`/t/${pub}`)).status, 200);
});

test('branding switch: off by default, site-wide on, per-academy overrides, lapsed pages lose it; admin controls', async () => {
  const root = await browser('Root', 'root@org.test');
  const owner = await browser('Brand Owner', 'brand.owner@org.test');
  const plain = await browser('Plain', 'plain@org.test');
  await owner.call('POST', '/api/orgs', { name: 'Brand Club', slug: 'brand-club', kind: 'club', city: 'Pune' });
  await payFor(owner, 'brand-club');
  const tid = (await owner.call('POST', '/api/tournaments', { name: 'Brand Cup', visibility: 'public', events: [{ discipline: 'singles', gender: 'men' }] })).data.id;
  await owner.call('POST', `/api/tournaments/${tid}/org`, { org: 'brand-club' });
  const label = async () => (await owner.call('GET', `/api/tournaments/${tid}?me=1`)).data.whiteLabel;
  const logo = async () => (await owner.call('POST', `/api/tournaments/${tid}/media`, { kind: 'logo', data: pngN(Date.now()) })).status;

  assert.equal(await label(), false);
  assert.equal(await logo(), 402); // branding needs Open — the switch is off

  assert.equal((await plain.call('GET', '/api/admin/settings')).status, 403);
  assert.equal((await plain.call('PATCH', '/api/admin/settings', { orgIncludesBranding: true })).status, 403);
  let r = await root.call('PATCH', '/api/admin/settings', { orgIncludesBranding: true });
  assert.equal(r.data.orgIncludesBranding, true);
  assert.equal(await label(), true);
  assert.equal(await logo(), 200);
  assert.equal((await fetch(`${base}/api/billing/config`).then((x) => x.json())).orgIncludesBranding, true);
  assert.equal((await root.call('PATCH', '/api/admin/settings', { nope: 1 })).status, 400);

  // Per-academy: off for this one, then back to the site setting; on for one while the site is off.
  const org = (await root.call('GET', '/api/admin/orgs?q=brand')).data.orgs[0];
  await root.call('PATCH', `/api/admin/orgs/${org.id}`, { brandingOverride: false });
  assert.equal(await label(), false);
  await root.call('PATCH', `/api/admin/orgs/${org.id}`, { brandingOverride: null });
  assert.equal(await label(), true);
  await root.call('PATCH', '/api/admin/settings', { orgIncludesBranding: false });
  await root.call('PATCH', `/api/admin/orgs/${org.id}`, { brandingOverride: true });
  assert.equal(await label(), true);
  r = (await root.call('GET', '/api/admin/orgs?q=brand')).data;
  assert.deepEqual([r.siteBranding, r.orgs[0].brandingOverride, r.orgs[0].brandingIncluded], [false, true, true]);

  // A lapsed page loses it, even with the override.
  await db.query(`UPDATE orgs SET paid_until = now() - interval '1 day' WHERE slug = 'brand-club'`);
  assert.equal(await label(), false);

  // Admin: extend, unpublish, refund a year, delete; all logged.
  await root.call('PATCH', `/api/admin/orgs/${org.id}`, { extendDays: 30 });
  assert.equal((await anon('/@brand-club')).status, 200);
  await root.call('PATCH', `/api/admin/orgs/${org.id}`, { unpublish: true });
  assert.ok(inApp(await anon('/@brand-club'), 'brand-club'));
  const pay = (await root.call('GET', '/api/admin/payments?kind=org&q=Brand Club')).data.payments[0];
  assert.equal(pay.kind, 'org');
  r = await root.call('POST', `/api/admin/payments/${pay.id}/refund`, { downgrade: true });
  assert.deepEqual([r.status, r.data.status], [200, 'refunded']);
  assert.match((await root.call('GET', '/api/admin/payments.csv?kind=org')).data, /Academy page \(1 year\)/);
  assert.equal((await root.call('DELETE', `/api/admin/orgs/${org.id}`)).status, 200);
  assert.equal((await owner.call('GET', `/api/tournaments/${tid}?me=1`)).data.org, null);
  const log = (await root.call('GET', '/api/admin/stats')).data.log.map((x) => x.action);
  for (const a of ['setting.change', 'org.branding', 'org.extend', 'org.unpublish', 'payment.refund', 'org.delete']) assert.ok(log.includes(a), a);
});
