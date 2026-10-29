'use strict';

// Share cards: PNGs in both sizes for public things, nothing for private ones
// (private tournaments and profiles, followers-only items, under-18s), and
// link previews on club and feed-item links.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const { svgFor } = require('../server/cards');

let db;
let svc;
let server;
let base;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  const app = createApp(db);
  svc = app.service;
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
});

// [width, height] from a PNG's header, or null.
async function png(path) {
  const r = await fetch(base + path);
  if (r.status !== 200) return r.status;
  assert.equal(r.headers.get('content-type'), 'image/png');
  const b = Buffer.from(await r.arrayBuffer());
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}
const meta = (html, prop) => (html.match(new RegExp(`<meta (?:property|name)="${prop}" content="([^"]*)"`)) || [])[1] || null;

async function user(name, extra = {}) {
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}@cards.test`, password: 'password123' }),
  });
  const { user: u } = await res.json();
  if (Object.keys(extra).length) await db.query(`UPDATE users SET ${Object.keys(extra).map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [u.id, ...Object.values(extra)]);
  return { ...u, actor: { user: { ...u, isAdmin: false } } };
}

test('the card layout keeps long names on the card', () => {
  const svg = svgFor({ eyebrow: 'Champion · Badminton', title: 'A very long player name that goes on and on and on for ever', subtitle: 'x'.repeat(200), big: 'WINNER' });
  assert.match(svg, /…/); // cut, with an ellipsis
  assert.ok(!svg.includes('x'.repeat(100)));
});

test('cards for public things, in both sizes; none for private ones', async () => {
  const kavya = await user('Kavya Cards');
  const club = await svc.clubs.create(kavya.actor, { name: 'Card Club', slug: 'card-club', kind: 'team', city: 'Chennai', sports: ['badminton'] });
  assert.deepEqual(await png('/img/club/card-club.png'), [1200, 630]);
  assert.deepEqual(await png('/img/club/card-club.png?size=story'), [1080, 1920]);
  assert.equal(await png('/img/club/no-such-club.png'), 404);
  // The club's link: a preview with its card.
  const page = await (await fetch(`${base}/club/card-club`)).text();
  assert.equal(meta(page, 'og:title'), 'Join Card Club on Tonament');
  assert.equal(meta(page, 'og:image'), `${base}/img/club/card-club.png`);
  assert.equal(meta(page, 'robots'), 'noindex');
  assert.ok(page.includes('/app.js'), 'the app still loads');

  // Profiles: public yes; private and under-18 no.
  const [{ handle }] = await db.query('SELECT handle FROM users WHERE id = $1', [kavya.id]);
  assert.deepEqual(await png(`/img/p/${handle}.png`), [1200, 630]);
  await db.query('UPDATE users SET profile_public = false WHERE id = $1', [kavya.id]);
  assert.equal(await png(`/img/p/${handle}.png`), 404);
  await db.query('UPDATE users SET profile_public = true, birth_year = $2 WHERE id = $1', [kavya.id, new Date().getFullYear() - 15]);
  assert.equal(await png(`/img/p/${handle}.png`), 404);
  await db.query('UPDATE users SET birth_year = NULL WHERE id = $1', [kavya.id]);

  // Tournaments: link-only and public yes, private no.
  const pub = await svc.createTournament(kavya.actor, { name: 'Card Open', visibility: 'link' });
  const priv = await svc.createTournament(kavya.actor, { name: 'Secret Cup', visibility: 'private' });
  assert.deepEqual(await png(`/img/t/${pub.id}.png`), [1200, 630]);
  assert.equal(await png(`/img/t/${priv.id}.png`), 404);

  // Feed items: public ones (the club's "started"), not followers-only.
  const [made] = await db.query(`SELECT id FROM activity WHERE verb = 'club' AND org_id = $1`, [club.id]);
  assert.deepEqual(await png(`/img/a/${made.id}.png`), [1200, 630]);
  const item = await (await fetch(`${base}/a/${made.id}`)).text();
  assert.equal(meta(item, 'og:image'), `${base}/img/a/${made.id}.png`);
  await db.query(`UPDATE activity SET visibility = 'followers' WHERE id = $1`, [made.id]);
  assert.equal(await png(`/img/a/${made.id}.png`), 404);
  assert.equal(meta(await (await fetch(`${base}/a/${made.id}`)).text(), 'og:image'), `${base}/brand/og.png`);
});
