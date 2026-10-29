'use strict';

// Screenshots of a level-split Open event for the home slider, the features
// page and the blog: public/guide/pools-*.jpg (groups by level) and
// onday-*.jpg (courts and the order of play with a pair not here yet), in
// the dark and light themes. Re-run after UI changes:
//
//   NODE_PATH=$(npm root -g) node scripts/hero-shots.js

const http = require('node:http'); const path = require('node:path');
const { chromium } = require('playwright');
const { createDb } = require('../server/db'); const { createApp } = require('../server/app');
const OUT = path.join(__dirname, '..', 'public', 'guide'); const W = 390;
(async () => {
  const db = await createDb(':memory:'); const app = createApp(db); const svc = app.service;
  const server = http.createServer(app.handle); await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Kavya Raman', email: 'kavya@smashclub.in', password: 'password123' }) });
  const { user } = await res.json(); const cookie = res.headers.get('set-cookie').split(';')[0];
  const ORG = { user: { ...user, isAdmin: false } };
  const { id } = await svc.createTournament(ORG, { name: 'Chennai Smash Open', visibility: 'public', sport: 'badminton', format: 'league_knockout', groupSize: 3, qualifiers: 1,
    city: 'Chennai', venue: 'Anna Nagar Indoor Arena', events: [{ discipline: 'doubles', gender: 'men' }], scoring: { points: 21, bestOf: 1 } });
  await db.query(`UPDATE tournaments SET plan = 'open' WHERE id = $1`, [id]);
  const L = { Beginner: ['Arun / Bala', 'Charan / Dinesh', 'Ezhil / Farhan'], 'Beginner+': ['Gokul / Hari', 'Imran / Jagan', 'Karthi / Lokesh'],
    Intermediate: ['Mohan / Naveen', 'Om / Prakash', 'Ravi / Sanjay'], Advanced: ['Tharun / Uday', 'Vijay / Wasim', 'Yusuf / Zubair'] };
  for (const [level, names] of Object.entries(L)) await svc.addEntries(id, ORG, names, { level });
  await svc.updateSettings(id, ORG, { pools: 'levels', courts: { names: ['Court 1', 'Court 2', 'Court 3'], minutes: 20 } });
  let t = await svc.start(id, ORG);
  const league = () => svc.getTournament(id, ORG).then((x) => x.matches.filter((m) => m.stage === 'league' && m.status === 'scheduled'));
  let ms = await league();
  const sc = [[21, 17], [15, 21], [21, 19], [21, 12]];
  for (const [i, m] of ms.filter((_, k) => k % 3 === 0).entries()) { const [a, b] = sc[i % 4]; await svc.setResult(id, ORG, m.id, [{ a, b }]); }
  ms = await league();
  await svc.callMatch(id, ORG, ms[0].id, 'Court 1'); await svc.callMatch(id, ORG, ms[1].id, 'Court 2');
  for (const side of 'aababbabaabbaab') await svc.rally(id, ORG, ms[0].id, side);
  t = await svc.getTournament(id, ORG);
  const away = t.entries.find((e) => e.name === 'Ravi / Sanjay'); await svc.setAway(id, ORG, away.id, true);
  const browser = await chromium.launch();
  for (const theme of ['dark', 'light']) {
    const c = await browser.newContext({ viewport: { width: W, height: 760 }, deviceScaleFactor: 2, colorScheme: theme, locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
    await c.addInitScript((th) => { try { localStorage.setItem('tonament:theme', th); } catch (e) {} }, theme);
    const [n, v] = cookie.split('='); await c.addCookies([{ name: n, value: v, url: base }]);
    const p = await c.newPage();
    const snap = async (name, sel, top = 70) => { await p.locator(sel).first().evaluate((el, off) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - off), top); await p.waitForTimeout(500); await p.screenshot({ path: path.join(OUT, `${name}-${theme}.jpg`), type: 'jpeg', quality: 80 }); };
    await p.goto(`${base}/t/${id}/draw`); await p.waitForSelector('.groups-grid'); await p.evaluate(() => document.querySelectorAll('.groups-grid details').forEach((d) => { d.open = false; })); await snap('pools', '.groups-grid');
    await p.goto(`${base}/t/${id}/courts`); await p.waitForSelector('.court-card'); await snap('onday', '.court-grid');
    
  }
  await browser.close(); server.close(); await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
