'use strict';

// Screenshots for the How it works page (public/guide/*.jpg), in the dark
// and light themes. Seeds a demo tournament in an in-memory database, runs
// the app, and drives it with Playwright at phone width. Re-run after UI
// changes:
//
//   NODE_PATH=$(npm root -g) node scripts/guide-shots.js
//
// (Playwright isn't a dependency: use a global install or `npx playwright`.)

const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

const OUT = path.join(__dirname, '..', 'public', 'guide');
const W = 390;
const H = 760;

// A game to 21 that `winner` wins with the loser on `lp` points: a
// shuffled, repeatable rally string.
function game(winner, lp, seed) {
  const loser = winner === 'a' ? 'b' : 'a';
  const points = [...Array(20).fill(winner), ...Array(lp).fill(loser)];
  let s = seed;
  for (let i = points.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [points[i], points[j]] = [points[j], points[i]];
  }
  return points.join('') + winner;
}

async function main() {
  const db = await createDb(':memory:');
  const app = createApp(db);
  const svc = app.service;
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  // Accounts: the organiser and a player, signed up over HTTP for real sessions.
  const signup = async (name, email) => {
    const res = await fetch(`${base}/api/auth/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password: 'password123' }),
    });
    const { user } = await res.json();
    return { cookie: res.headers.get('set-cookie').split(';')[0], actor: { user: { ...user, isAdmin: false } } };
  };
  const org = await signup('Kavya Raman', 'kavya@smashclub.in');
  const player = await signup('Meera Krishnan', 'meera@example.com');
  const ORG = org.actor;

  // ----- the demo tournament
  const { id } = await svc.createTournament(ORG, {
    name: 'Chennai Smash Open 2026', visibility: 'public', format: 'league_knockout', groupSize: 4, qualifiers: 2,
    venue: 'Anna Nagar Indoor Arena', address: '12 Lake View Road, Anna Nagar', city: 'Chennai', region: 'Tamil Nadu',
    postcode: '600040', country: 'India', startsOn: '2026-12-12', endsOn: '2026-12-13', startTime: '08:00', endTime: '19:00',
    events: [
      { discipline: 'singles', gender: 'men' },
      { discipline: 'doubles', gender: 'mixed', format: 'knockout' },
      { discipline: 'singles', gender: 'women' },
      { discipline: 'doubles', gender: 'women' },
    ],
  });
  await db.query(`UPDATE tournaments SET plan = 'open' WHERE id = $1`, [id]);
  let t = await svc.getTournament(id, ORG);
  const [ms, xd, ws, wd] = t.events.map((e) => e.id);
  await svc.updateEvent(id, ORG, ms, { prizes: [{ place: 'winner', cash: 10000, reward: 'Trophy' }, { place: 'runner_up', cash: 5000 }, { place: 'semis', reward: 'Medals' }] });
  await svc.updateEvent(id, ORG, xd, { prizes: [{ place: 'winner', cash: 6000, reward: 'Trophy' }, { place: 'runner_up', cash: 3000 }] });
  await svc.updateEvent(id, ORG, ws, { prizes: [{ place: 'winner', cash: 6000, reward: 'Trophy' }], maxEntries: 8 });
  await svc.updateSettings(id, ORG, {
    about: 'Our annual open for club players across Chennai. Two days of singles and mixed doubles, with a knockout final on Sunday evening.',
    perks: { items: ['shuttles', 'water', 'lunch', 'tshirt'], other: ['Physio on site'] },
    notes: 'Report 30 minutes before your first match. Non-marking shoes only. Yonex Mavis 350 shuttles for all rounds.',
    courts: { names: ['Court 1', 'Court 2', 'Court 3', 'Court 4'], minutes: 25 },
  });

  await svc.addEntries(id, ORG, ['Arjun Mehta', 'Rohan Iyer', 'Karthik Raman', 'Vikram Shah', 'Aditya Rao', 'Siddharth Nair', 'Rahul Menon', 'Pranav Desai'], { event: ms });
  await svc.addEntries(id, ORG, ['Arjun Mehta / Divya Iyer', 'Rohan Iyer / Sneha Pillai', 'Vikram Shah / Ananya Bose', 'Aditya Rao / Priya Nair', 'Rahul Menon / Kavitha S', 'Nikhil Joshi / Aarti Kulkarni'], { event: xd });
  await svc.addEntries(id, ORG, ['Divya Iyer / Sneha Pillai', 'Ananya Bose / Priya Nair', 'Lakshmi Venkat / Aarti Kulkarni'], { event: wd });
  await svc.addEntries(id, ORG, ['Divya Iyer', 'Sneha Pillai', 'Ananya Bose', 'Priya Nair', 'Aarti Kulkarni', 'Lakshmi Venkat'], { event: ws });
  // Women's Singles stays open: a few checked in, one self-entry waiting for a place.
  t = await svc.getTournament(id, ORG);
  for (const e of t.events[2].entries.slice(0, 3)) await svc.checkIn(id, ORG, e.id, true);
  await svc.register(id, { user: { id: 9001, email: 'nisha@example.com', name: 'Nisha Thomas' } }, { event: ws, phone: '98400 12345' });
  await svc.updateEvent(id, ORG, ws, { maxEntries: 7 });
  await svc.register(id, { user: { id: 9002, email: 'ritu@example.com', name: 'Ritu Sharma' } }, { event: ws });

  // Men's Singles: groups, some results, matches on court.
  t = await svc.start(id, ORG, { event: ms });
  const msMatches = () => svc.getTournament(id, ORG).then((x) => x.events[0].matches.filter((m) => m.status !== 'bye'));
  const scores = [[17, 15], [12, 19], [19, 16], [14, 18]];
  let seed = 7;
  for (const [i, m] of (await msMatches()).filter((x) => x.round === 1).entries()) {
    const w = i % 2 ? 'b' : 'a';
    const [l1, l2] = scores[i % scores.length];
    for (const side of game(w, l1, seed++) + game(w, l2, seed++)) await svc.rally(id, ORG, m.id, side);
  }
  const next = (await msMatches()).filter((m) => m.status === 'scheduled');
  await svc.callMatch(id, ORG, next[0].id, 'Court 1');
  await svc.callMatch(id, ORG, next[1].id, 'Court 2');
  await svc.callMatch(id, ORG, next[2].id, 'Court 3');
  for (const side of game('a', 18, 21) + 'abbabaababbaabababbab') await svc.rally(id, ORG, next[0].id, side); // game 2 under way
  for (const side of 'aabababbbaab') await svc.rally(id, ORG, next[1].id, side);
  const liveId = next[0].id;

  // Mixed Doubles: a knockout with the first round played.
  await svc.start(id, ORG, { event: xd });
  const xdMatches = (await svc.getTournament(id, ORG)).events[1].matches.filter((m) => m.status === 'scheduled' && m.a && m.b);
  for (const [i, m] of xdMatches.entries()) {
    for (const side of game(i ? 'b' : 'a', 16 + i, seed++) + game(i ? 'b' : 'a', 13 + i, seed++)) await svc.rally(id, ORG, m.id, side);
  }

  // ----- screenshots
  const shots = [];
  for (const theme of ['dark', 'light']) {
    const context = async (cookie) => {
      const c = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
      await c.addInitScript((th) => { try { localStorage.setItem('tonament:theme', th); } catch (e) { /* fine */ } }, theme);
      if (cookie) {
        const [name, value] = cookie.split('=');
        await c.addCookies([{ name, value, url: base }]);
      }
      return c.newPage();
    };
    const snap = async (page, name, { top, scrollTo, height } = {}) => {
      await page.setViewportSize({ width: W, height: height || H });
      if (scrollTo) await page.locator(scrollTo).first().evaluate((el, off) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - off), top ?? 70);
      await page.waitForTimeout(400);
      const file = path.join(OUT, `${name}-${theme}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 80 });
      shots.push(file);
    };

    const o = await context(org.cookie);
    // 1. Create
    await o.goto(`${base}/new`); await o.waitForSelector('.new-flow');
    await o.evaluate(() => { window.scrollTo(0, 0); });
    await o.click('label.choice:has-text("Badminton")');
    await o.waitForSelector('text=Which badminton events?');
    await o.click('label.choice:has-text("Women\'s Singles")');
    await o.click('label.choice:has-text("Mixed Doubles")');
    await snap(o, 'create');
    // 3. Organiser's Players tab (Women's Singles, still open)
    await o.goto(`${base}/t/${id}/entries?e=${ws}`); await o.waitForSelector('.entries');
    await snap(o, 'entries', { scrollTo: '.card:has(h2:text-matches("^Entries"))', top: 70 });
    // 5. Courts
    await o.goto(`${base}/t/${id}/courts`); await o.waitForSelector('.court-card');
    await snap(o, 'courts', { scrollTo: '.court-grid', top: 70 });
    // 6. Umpire
    await o.goto(`${base}/t/${id}/m/${liveId}`); await o.waitForSelector('.score-btn');
    await snap(o, 'umpire', { scrollTo: '.scoreboard', top: 60 });
    // 4. Groups and bracket
    await o.goto(`${base}/t/${id}/groups?e=${ms}`); await o.waitForSelector('.groups-grid');
    await snap(o, 'groups', { scrollTo: '.groups-grid', top: 70 });
    await o.goto(`${base}/t/${id}/bracket?e=${xd}`); await o.waitForSelector('.bracket, .rounds, .b-round');
    await snap(o, 'bracket', { scrollTo: '.event-title', top: 70, height: 600 });
    await o.context().close();

    // 2. Public page and 6. live, as a visitor
    const v = await context(null);
    await v.goto(`${base}/t/${id}/entries?e=${ws}`); await v.waitForSelector('.entry-card');
    await snap(v, 'public', { scrollTo: '.t-header', top: 64 });
    await v.goto(`${base}/t/${id}/live?e=${ms}`); await v.waitForSelector('.match-card');
    await snap(v, 'live', { scrollTo: '.event-title', top: 70 });
    await v.context().close();

    // Player: the entry form, prefilled
    const p = await context(player.cookie);
    await p.goto(`${base}/t/${id}/entries?e=${wd}`); await p.waitForSelector('.entry-card input[name=name]');
    await p.fill('.entry-card input[name=partner]', 'Kavitha Suresh');
    await snap(p, 'enter', { scrollTo: '.entry-card', top: 90 });
    await p.context().close();

    // Link preview, as a chat app shows it
    const preview = await svc.sharePreview(id);
    const chat = await context(null);
    await chat.goto(`${base}/`);
    await chat.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
      body { margin: 0; font-family: system-ui, sans-serif; background: ${theme === 'dark' ? '#0B141A' : '#EFE7DD'}; height: 100vh; display: flex; align-items: flex-end; }
      .bubble { margin: 0 12px 40px auto; max-width: 300px; background: ${theme === 'dark' ? '#005C4B' : '#D9FDD3'}; color: ${theme === 'dark' ? '#E9EDEF' : '#111B21'}; border-radius: 10px; padding: 4px; box-shadow: 0 1px 1px rgba(0,0,0,.2); }
      .card { background: ${theme === 'dark' ? '#025144' : '#C7EFC0'}; border-radius: 8px; overflow: hidden; }
      .card img { width: 100%; display: block; aspect-ratio: 1200 / 630; object-fit: cover; }
      .meta { padding: 6px 8px; } .t { font-weight: 600; font-size: 14px; } .d { font-size: 12.5px; opacity: .8; margin-top: 2px; } .u { font-size: 12px; opacity: .6; margin-top: 4px; }
      .msg { padding: 6px 6px 2px; font-size: 14.5px; } .msg a { color: ${theme === 'dark' ? '#53BDEB' : '#027EB5'}; } .time { text-align: right; font-size: 11px; opacity: .6; padding: 0 6px 2px; }
    </style></head><body><div class="bubble"><div class="card"><img src="${base}/brand/og.png"><div class="meta"><div class="t">${preview.title}</div><div class="d">${preview.description}</div><div class="u">tonament.com</div></div></div>
      <div class="msg">Entries are open — see you there! <a>https://tonament.com/t/${id}</a></div><div class="time">10:42</div></div></body></html>`);
    await chat.waitForTimeout(500);
    await snap(chat, 'share', { height: 540 });
    await chat.context().close();
  }

  await browser.close();
  await new Promise((r) => server.close(r));
  await db.close();
  console.log(shots.map((f) => path.relative(process.cwd(), f)).join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
