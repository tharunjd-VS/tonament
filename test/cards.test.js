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

test('tournament cards: a match result, an event podium, all the champions, the poster; none while private', async () => {
  const org = await user('Card Organiser');
  const make = async (visibility, name) => {
    const { id } = await svc.createTournament(org.actor, { name, format: 'knockout', visibility, venue: 'Anna Nagar Indoor', city: 'Chennai', startsOn: '2026-12-12', events: [{ discipline: 'singles', gender: 'men' }, { discipline: 'singles', gender: 'women' }] });
    const t0 = await svc.getTournament(id, org.actor);
    for (const [i, ev] of t0.events.entries()) {
      await svc.addEntries(id, org.actor, i ? ['Meera K', 'Divya R', 'Anu S', 'Lakshmi P'] : ['Arjun Mehta', 'Rohan Iyer', 'Karthik R', 'Vikram S'], { event: ev.id });
    }
    return { id, events: t0.events.map((e) => e.id) };
  };
  const pub = await make('public', 'Chennai Smash Open');
  const secret = await make('private', 'Secret Smash');
  // The poster: before it starts, while entries are open.
  assert.deepEqual(await png(`/img/poster/${pub.id}.png`), [1200, 630]);
  assert.deepEqual(await png(`/img/poster/${pub.id}.png?size=story`), [1080, 1920]);
  const poster = await svc.posterCard(pub.id);
  assert.match(poster.eyebrow, /^Entries open · Badminton · Chennai/);
  assert.match(poster.subtitle, /12 Dec 2026 · Anna Nagar Indoor · 2 events/);
  assert.equal(poster.big, 'Free');
  assert.equal(await png(`/img/results/${pub.id}.png`), 404, 'no results before it finishes');

  for (const t of [pub, secret]) {
    for (const ev of t.events) {
      await svc.start(t.id, org.actor, { event: ev });
      for (;;) {
        const x = await svc.getTournament(t.id, org.actor);
        const m = x.events.find((e) => e.id === ev).matches.find((y) => y.status === 'scheduled' && y.a && y.b);
        if (!m) break;
        await svc.setResult(t.id, org.actor, m.id, [{ a: 21, b: 15 }, { a: 21, b: 18 }], m.rallies || 0);
      }
    }
  }
  const done = await svc.getTournament(pub.id, org.actor);
  const final = done.events[0].matches.find((m) => m.stage === 'knockout' && m.round === Math.max(...done.events[0].matches.map((x) => x.round)));
  const mc = await svc.matchCard(final.id);
  assert.equal(mc.eyebrow, "Final · Men's Singles");
  assert.equal(mc.title, final.a.name);
  assert.equal(mc.subtitle, `beat ${final.b.name} · Chennai Smash Open`);
  assert.equal(mc.big, '21–15, 21–18');
  assert.equal(mc.bigLabel, 'Champion');
  assert.deepEqual(await png(`/img/m/${final.id}.png`), [1200, 630]);
  const ec = await svc.eventCard(pub.events[1]);
  assert.equal(ec.title, "Women's Singles");
  assert.deepEqual(ec.lines.map((l) => l.value), ['Champion', 'Runner-up', 'Semi-final', 'Semi-final']);
  assert.deepEqual(await png(`/img/w/${pub.events[1]}.png?size=story`), [1080, 1920]);
  const rc = await svc.resultsCard(pub.id);
  assert.equal(rc.title, 'Chennai Smash Open');
  assert.deepEqual(rc.lines.map((l) => l.value), ["Men's Singles", "Women's Singles"]);
  assert.equal(rc.lines[0].name, final.a.name);
  assert.deepEqual(await png(`/img/results/${pub.id}.png`), [1200, 630]);
  assert.match((await svc.posterCard(pub.id)).eyebrow, /^Results/);
  // Private: nothing at all.
  const sDone = await svc.getTournament(secret.id, org.actor);
  for (const path of [`/img/poster/${secret.id}.png`, `/img/results/${secret.id}.png`, `/img/w/${secret.events[0]}.png`, `/img/m/${sDone.events[0].matches[0].id}.png`]) assert.equal(await png(path), 404, path);
});
