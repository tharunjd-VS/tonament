'use strict';

// Shared links (/t/<id>): link previews show the tournament's name, a
// one-line summary and its image; private tournaments stay generic.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

let db;
let app;
let svc;
let server;
let base;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  app = createApp(db);
  svc = app.service;
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
});

const ORG = { user: { id: 1, email: 'org@share.test', name: 'Org', isAdmin: false } };
const jpeg = (n) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`img-${n}`)]).toString('base64');
const meta = (html, name) => {
  const m = html.match(new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)">`));
  return m && m[1];
};

test('a public tournament link previews its name, details and image', async () => {
  const { id } = await svc.createTournament(ORG, {
    name: 'Diwali "Smash" <Open>', visibility: 'public', venue: 'City Sports Hall', city: 'Chennai', country: 'India', region: 'Tamil Nadu',
    startsOn: '2030-11-02', endsOn: '2030-11-03',
    events: [{ discipline: 'singles', gender: 'men' }, { discipline: 'doubles', gender: 'mixed' }],
  });
  const t = await svc.getTournament(id, ORG);
  await svc.updateEvent(id, ORG, t.events[0].id, { prizes: [{ place: 'winner', cash: 5000 }] });

  let res = await fetch(`${base}/t/${id}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('cache-control'), /s-maxage=300/);
  let html = await res.text();
  assert.equal(meta(html, 'og:title'), 'Diwali &quot;Smash&quot; &lt;Open&gt;'); // escaped
  assert.equal(meta(html, 'og:description'),
    'Sat 2 – Sun 3 Nov 2030 · City Sports Hall, Chennai · Badminton: Men&#39;s Singles, Mixed Doubles · 🏆 ₹5,000 in prizes · Entries open');
  assert.equal(meta(html, 'og:url'), `${base}/t/${id}`);
  assert.equal(meta(html, 'og:image'), `${base}/brand/og.png`); // no cover yet
  assert.match(html, new RegExp(`location.replace\\("/#/t/${id}"\\)`)); // people go on to the app
  assert.ok(!html.includes('<Open>'));

  // The cover, then its 1200×630 preview copy, become the image.
  await svc.uploadMedia(id, ORG, { kind: 'cover', data: jpeg('cover') });
  html = await (await fetch(`${base}/t/${id}`)).text();
  const cover = (await svc.getTournament(id)).cover;
  assert.equal(meta(html, 'og:image'), base + cover);
  assert.equal(meta(html, 'og:image:width'), null);
  await svc.uploadMedia(id, ORG, { kind: 'preview', data: jpeg('preview') });
  html = await (await fetch(`${base}/t/${id}`)).text();
  assert.notEqual(meta(html, 'og:image'), base + cover);
  assert.equal(meta(html, 'og:image:width'), '1200');
  assert.equal((await svc.getTournament(id, ORG)).photos.length, 0); // the preview isn't a photo

  // A new cover drops the old preview; removing the cover removes it too.
  await svc.uploadMedia(id, ORG, { kind: 'cover', data: jpeg('cover2') });
  html = await (await fetch(`${base}/t/${id}`)).text();
  assert.equal(meta(html, 'og:image:width'), null);
  await assert.rejects(svc.uploadMedia(id, ORG, { kind: 'preview', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(700 * 1024)]).toString('base64') }), /under 600 KB/);

  // Tabs and the event pick carry through (also via Vercel's /api/share rewrite).
  html = await (await fetch(`${base}/t/${id}/courts?e=5`)).text();
  assert.match(html, new RegExp(`location.replace\\("/#/t/${id}/courts\\?e=5"\\)`));
  html = await (await fetch(`${base}/api/index?__path=share/${id}/live&e=7`)).text();
  assert.match(html, new RegExp(`location.replace\\("/#/t/${id}/live\\?e=7"\\)`));
});

test('private and unknown tournaments get the generic card', async () => {
  const { id } = await svc.createTournament(ORG, { name: 'Secret Cup' });
  let res = await fetch(`${base}/t/${id}`);
  let html = await res.text();
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.ok(!html.includes('Secret Cup'));
  assert.equal(meta(html, 'og:title'), 'Tonament — One platform. Every sport. Every tournament.');
  assert.match(html, new RegExp(`location.replace\\("/#/t/${id}"\\)`)); // the team can still open it
  res = await fetch(`${base}/t/no-such-cup`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('Open Tonament'));
});
