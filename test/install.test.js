'use strict';

// Installing the web app on a phone: the manifest (icons, shortcuts,
// screenshots), the service worker (never caches live data) and the tags
// every page needs for Add to Home Screen.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const sw = require('../public/sw');

const PUBLIC = path.join(__dirname, '..', 'public');
let db;
let server;
let base;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  server = http.createServer(createApp(db).handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
});

test('the manifest: icons, shortcuts and screenshots that exist', async () => {
  const m = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, '/');
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  const files = [...m.icons, ...m.screenshots, ...m.shortcuts.flatMap((s) => s.icons)].map((i) => i.src);
  for (const src of files) assert.ok(fs.existsSync(path.join(PUBLIC, src)), src);
  for (const s of m.shortcuts) assert.equal((await fetch(base + s.url)).status, 200, s.url);
  const res = await fetch(`${base}/manifest.webmanifest`);
  assert.match(res.headers.get('content-type'), /manifest\+json/);
});

test('the service worker: live data always comes from the network', async () => {
  const at = (p, extra = {}) => sw.strategy(new URL(p, base), { method: 'GET', mode: 'cors', ...extra }, base);
  assert.equal(at('/api/tournaments/abc'), 'skip');
  assert.equal(at('/api/matches/1/rally', { method: 'POST' }), 'skip');
  assert.equal(at('/t/abc', { mode: 'navigate' }), 'page');
  assert.equal(at('/app.js'), 'fresh');
  assert.equal(at('/fonts/Outfit-Variable.woff2'), 'cached');
  assert.equal(sw.strategy(new URL('https://cdn.example.com/x.js'), { method: 'GET', mode: 'cors' }, base), 'skip');
  // Everything it pre-caches is served.
  for (const p of sw.SHELL) assert.equal((await fetch(base + p)).status, 200, p);
  const res = await fetch(`${base}/sw.js`);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  // Every sport script the app loads is in the shell.
  const scripts = [...fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').matchAll(/<script src="([^"]+)"/g)].map((x) => x[1]);
  for (const s of scripts) assert.ok(sw.SHELL.includes(s), `${s} missing from the shell`);
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.ok(vercel.headers.some((h) => h.source === '/sw.js' && h.headers.some((x) => x.key === 'Cache-Control' && x.value === 'no-cache')));
});

test('every page can be added to the home screen', async () => {
  const pages = [...fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')).map((f) => `/${f}`), '/blog', '/tools', '/badminton', '/rankings'];
  for (const p of pages) {
    const html = p.endsWith('.html') ? fs.readFileSync(path.join(PUBLIC, p), 'utf8') : await (await fetch(base + p)).text();
    if (p === '/offline.html') continue; // only ever shown by the service worker
    assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/, p);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="Tonament">/, p);
    assert.match(html, /<link rel="apple-touch-icon"/, p);
  }
});
