'use strict';

// Tournament page content: about/links, cover and photos (free), organiser
// branding and sponsors (paid), and serving images.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// Distinct tiny "JPEGs": the right magic bytes plus a marker.
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`photo-${n}`)]).toString('base64');

let db;
let app;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  app = createApp(db);
  svc = app.service;
  Object.assign(process.env, { RAZORPAY_KEY_ID: 'rzp_test_M', RAZORPAY_KEY_SECRET: 'm_secret' }); // billing on: limits apply
});
test.after(() => {
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
  return db.close();
});

const ORG = { user: { id: 1, email: 'org@media.test', name: 'Org', isAdmin: false } };
const OTHER = { user: { id: 2, email: 'other@media.test', name: 'Other', isAdmin: false } };
const ADMIN = { user: { id: 3, email: 'admin@media.test', name: 'Admin', isAdmin: true } };
const cup = async (name, extra = {}) => (await svc.createTournament(ORG, { name, visibility: 'public', ...extra })).id;

test('free: about, links, a cover and three photos; branding and sponsors need a paid plan', async () => {
  const id = await cup('Free Cup');
  let t = await svc.updateSettings(id, ORG, {
    about: 'Our annual club open.\nAll welcome!',
    pageLinks: { website: 'https://club.example/', instagram: 'https://instagram.com/ourclub', whatsapp: 'https://chat.whatsapp.com/AbC123' },
  });
  assert.equal(t.about, 'Our annual club open.\nAll welcome!');
  assert.equal(t.pageLinks.instagram, 'https://instagram.com/ourclub');
  await assert.rejects(svc.updateSettings(id, ORG, { pageLinks: { website: 'javascript:alert(1)' } }), /full link/);
  await assert.rejects(svc.updateSettings(id, ORG, { pageLinks: { whatsapp: 'https://evil.example/x' } }), /chat\.whatsapp\.com/);
  await assert.rejects(svc.updateSettings(id, ORG, { about: 'x'.repeat(2001) }), /2,000/);

  t = await svc.uploadMedia(id, ORG, { kind: 'cover', data: jpeg('cover') });
  assert.match(t.cover, /^\/api\/media\/[0-9a-f]{32}$/);
  for (const n of [1, 2, 3]) t = await svc.uploadMedia(id, ORG, { kind: 'photo', data: jpeg(n), caption: `Final ${n}` });
  assert.deepEqual(t.photos.map((p) => p.caption), ['Final 1', 'Final 2', 'Final 3']);
  await assert.rejects(svc.uploadMedia(id, ORG, { kind: 'photo', data: jpeg(4) }), (e) => e.status === 402 && e.code === 'upgrade');
  await assert.rejects(svc.uploadMedia(id, ORG, { kind: 'logo', data: PNG }), (e) => e.status === 402);
  await assert.rejects(svc.uploadMedia(id, ORG, { kind: 'sponsor', data: PNG }), (e) => e.status === 402);
  await assert.rejects(svc.updateSettings(id, ORG, { branding: { orgName: 'Smash Club', accent: '#F97316' } }), (e) => e.status === 402);
  assert.equal(t.branding, null);

  // A new cover replaces the old; photos can be reordered, captioned and removed.
  const first = t.photos[0].id;
  t = await svc.uploadMedia(id, ORG, { kind: 'cover', data: jpeg('cover2') });
  assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM media WHERE tournament_id = $1 AND kind = 'cover'`, [id]))[0].n, 1);
  t = await svc.updateMedia(id, ORG, first, { move: 1 });
  assert.deepEqual(t.photos.map((p) => p.caption), ['Final 2', 'Final 1', 'Final 3']);
  t = await svc.updateMedia(id, ORG, first, { caption: 'The winners' });
  t = await svc.deleteMedia(id, ORG, t.photos[2].id);
  assert.deepEqual(t.photos.map((p) => p.caption), ['Final 2', 'The winners']);
});

test('uploads are checked: real image types only, size limit, organisers only', async () => {
  const id = await cup('Checks Cup');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
  await assert.rejects(svc.uploadMedia(id, ORG, { kind: 'photo', data: svg }), /JPEG, PNG or WebP/);
  await assert.rejects(svc.uploadMedia(id, ORG, { kind: 'photo', data: Buffer.from('hello').toString('base64') }), /JPEG, PNG or WebP/);
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2 * 1024 * 1024)]).toString('base64');
  await assert.rejects(svc.uploadMedia(id, ORG, { kind: 'photo', data: huge }), (e) => e.status === 413);
  await assert.rejects(svc.uploadMedia(id, ORG, { kind: 'banner', data: PNG }), /kind must be/);
  await assert.rejects(svc.uploadMedia(id, OTHER, { kind: 'photo', data: jpeg('x') }), (e) => e.status === 403);
  // Same image twice is stored once.
  await svc.uploadMedia(id, ORG, { kind: 'photo', data: jpeg('dup') });
  const t = await svc.uploadMedia(id, ORG, { kind: 'photo', data: jpeg('dup') });
  assert.equal(t.photos.length, 1);
  // Site admins can remove anything (moderation).
  assert.equal((await svc.deleteMedia(id, ADMIN, t.photos[0].id)).photos.length, 0);
});

test('Club: 30 photos but no branding; Open and above: logo, colours and sponsors', async () => {
  const id = await cup('Club Cup');
  await svc.adminSetPlan(id, ADMIN, 'club');
  for (const n of [1, 2, 3, 4]) await svc.uploadMedia(id, ORG, { kind: 'photo', data: jpeg(`club${n}`) });
  assert.equal((await svc.getTournament(id)).photos.length, 4);
  await assert.rejects(svc.uploadMedia(id, ORG, { kind: 'logo', data: PNG }), (e) => e.status === 402 && /Open plan or above/.test(e.message));
  await assert.rejects(svc.uploadMedia(id, ORG, { kind: 'sponsor', data: PNG }), (e) => e.status === 402);
  await assert.rejects(svc.updateSettings(id, ORG, { branding: { orgName: 'Club' } }), (e) => e.status === 402);
  const mine = await svc.getTournament(id, ORG);
  assert.equal(mine.brandingAllowed, false);
  // Set by an admin without a payment, so the full price is still due.
  assert.deepEqual(mine.upgrades.map((u) => [u.id, u.amount]), [['open', 99900], ['championship', 199900]]);
  await svc.adminSetPlan(id, ADMIN, 'pass'); // the original Event Pass includes branding
  assert.ok((await svc.uploadMedia(id, ORG, { kind: 'logo', data: PNG })).branding.logo);
});

test('paid: logo, colours, sponsors and more photos; a downgrade hides them but keeps them', async () => {
  const id = await cup('Branded Cup');
  await svc.adminSetPlan(id, ADMIN, 'open');
  let t = await svc.updateSettings(id, ORG, { branding: { orgName: 'Smash Club', accent: '#f97316' } });
  await assert.rejects(svc.updateSettings(id, ORG, { branding: { accent: 'orange' } }), /hex colour/);
  t = await svc.uploadMedia(id, ORG, { kind: 'logo', data: PNG });
  for (const n of [1, 2]) t = await svc.uploadMedia(id, ORG, { kind: 'sponsor', data: jpeg(`sponsor${n}`) });
  for (const n of [1, 2, 3, 4, 5]) t = await svc.uploadMedia(id, ORG, { kind: 'photo', data: jpeg(`p${n}`) });
  let pub = await svc.getTournament(id);
  assert.deepEqual([pub.branding.orgName, pub.branding.accent], ['Smash Club', '#F97316']);
  assert.match(pub.branding.logo, /^\/api\/media\//);
  assert.equal(pub.sponsors.length, 2);
  assert.equal(pub.photos.length, 5);

  await svc.adminSetPlan(id, ADMIN, 'free');
  pub = await svc.getTournament(id);
  assert.deepEqual([pub.branding, pub.sponsors.length, pub.photos.length], [null, 0, 3]);
  const mine = await svc.getTournament(id, ORG); // organisers still see everything, marked hidden
  assert.equal(mine.photos.filter((p) => p.hidden).length, 2);
  assert.equal(mine.brandingSettings.orgName, 'Smash Club');

  // Official (Tonament-run) tournaments get branding too.
  await svc.setOfficial(id, ADMIN, true);
  assert.equal((await svc.getTournament(id)).branding.orgName, 'Smash Club');
});

test('HTTP: images are served with their type and cached; private ones only to the team', async () => {
  const id = await cup('Served Cup');
  const t = await svc.uploadMedia(id, ORG, { kind: 'cover', data: PNG });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let res = await fetch(base + t.cover);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control'), /immutable/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(PNG, 'base64'));
    assert.equal((await fetch(`${base}/api/media/${'0'.repeat(32)}`)).status, 404);

    await svc.setVisibility(id, ORG, 'private');
    res = await fetch(base + t.cover);
    assert.equal(res.status, 404);
    // Cards show the cover.
    await svc.setVisibility(id, ORG, 'public');
    const card = (await svc.listTournaments({ q: 'Served Cup', when: 'any' }))[0];
    assert.equal(card.cover, t.cover);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
