'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const sports = require('./sports');
const { createService } = require('./service');
const { createAuth } = require('./auth');
const { HttpError } = require('./errors');
const pages = require('./pages');
const rankings = require('./rankings');
const catalog = require('../public/sports/events');
const { SPORTS: SPORT_PAGES } = require('./sport-pages');
const { createMailer } = require('./email');
const { billingConfig, publicBillingConfig } = require('./billing');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// The app's pages other than tournaments (served the app page; see vercel.json).
const APP_ROUTES = /^\/(?:new|signin|signup|forgot|reset|link|admin|academy\/new|me\/profile|groups|groups\/new|g\/[a-z0-9-]{3,40}(?:\/game\/\d+)?|@[a-z0-9-]{3,30}\/edit)\/?$/;
const MAX_BODY = 100 * 1024;
const MAX_MEDIA_BODY = 3 * 1024 * 1024; // image uploads (resized in the browser first)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

// cdnSeconds > 0 lets a CDN (Vercel's edge) share the response between
// viewers for that long. Live viewers poll, so this is what keeps hundreds of
// spectators from each hitting the database.
function send(res, status, data, cdnSeconds = 0, cookies = []) {
  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  // Browsers always revalidate (so a reload shows a new tournament straight
  // away); only the CDN may serve a slightly stale copy while it refreshes.
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cdnSeconds ? `public, max-age=0, s-maxage=${cdnSeconds}` : 'no-store',
    ...(cdnSeconds && { 'Vercel-CDN-Cache-Control': `max-age=${cdnSeconds}, stale-while-revalidate=${cdnSeconds * 2}` }),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

// Raw request body as text: needed to check webhook signatures byte-for-byte.
function readRaw(req) {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody.toString('utf8'));
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => reject(new HttpError(400, 'Request body unavailable')), 10_000);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        clearTimeout(timer);
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function readJson(req, limit = MAX_BODY) {
  // Vercel's Node runtime parses the body itself and exposes it as req.body.
  if ('body' in req) {
    let body;
    try {
      body = req.body;
    } catch {
      return Promise.reject(new HttpError(400, 'Body must be a JSON object'));
    }
    if (body == null || body === '') return Promise.resolve({});
    if (typeof body !== 'object' || Array.isArray(body) || Buffer.isBuffer(body)) {
      return Promise.reject(new HttpError(400, 'Body must be a JSON object'));
    }
    return Promise.resolve(body);
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        resolve(data);
      } catch {
        reject(new HttpError(400, 'Body must be a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

// On Vercel every /api/* request is rewritten to the single function at
// /api/index with the original path in ?__path= (see vercel.json).
function apiPath(url) {
  const forwarded = url.searchParams.get('__path');
  if (forwarded != null && (url.pathname === '/api' || url.pathname === '/api/index')) {
    return `/api/${forwarded.replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/api';
  }
  return url.pathname;
}

// Cookie-authenticated writes must come from our own pages: reject requests
// whose Origin is another site (SameSite=Lax cookies already block most).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host);
  } catch {
    return false;
  }
}

// Base URL for links in emails. Never taken from a request header in
// production, so a forged Host header can't redirect reset links elsewhere.
function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL) return null;
  return `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
}

// ---------- fallback for /t/<id> if the app page (index.html) can't be read:
// a small page with the tournament's name, summary and image for link
// previews, which sends people on to the app.
const SITE = 'https://tonament.com';
const GENERIC = {
  title: 'Tonament — One platform. Every sport. Every tournament.',
  description: 'Run league and knockout tournaments and score every match live.',
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function sharePage({ base, path: appPath, preview }) {
  const p = preview || GENERIC;
  const url = preview ? `${base}/t/${preview.id}` : `${base}/`;
  const image = preview && preview.image ? preview.image : { path: '/brand/og.png', width: 1200, height: 630 };
  const target = `/#${appPath}`;
  const meta = (attr, name, content) => `<meta ${attr}="${name}" content="${escapeHtml(content)}">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(preview ? `${p.title} · Tonament` : p.title)}</title>
${meta('name', 'description', p.description)}
<link rel="canonical" href="${escapeHtml(url)}">
${meta('property', 'og:type', 'website')}
${meta('property', 'og:site_name', 'Tonament')}
${meta('property', 'og:title', p.title)}
${meta('property', 'og:description', p.description)}
${meta('property', 'og:url', url)}
${meta('property', 'og:image', base + image.path)}
${image.width ? `${meta('property', 'og:image:width', image.width)}\n${meta('property', 'og:image:height', image.height)}\n` : ''}${meta('name', 'twitter:card', 'summary_large_image')}
${meta('name', 'twitter:title', p.title)}
${meta('name', 'twitter:description', p.description)}
${meta('name', 'twitter:image', base + image.path)}
<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">
<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')});</script>
</head>
<body style="font-family:system-ui,sans-serif;padding:24px">
<p><a href="${escapeHtml(target)}">${escapeHtml(preview ? `Open ${p.title} on Tonament` : 'Open Tonament')}</a></p>
</body>
</html>
`;
}

function createApp(db, { mailer = createMailer(), fetchImpl } = {}) {
  const svc = createService(db, { mailer, fetchImpl });
  const auth = createAuth(db, { mailer });

  const T = '/api/tournaments/([a-z0-9-]+)';
  const ev = (c) => c.body.event ?? (c.query.get('event') || undefined);
  const N = '(\\d+)';
  const O = '/api/orgs/([a-z0-9-]{3,30})';
  const G = '/api/groups/([a-z0-9-]{3,40})';
  // [method, path, handler, cdnSeconds]. Handlers get ctx = { body, query,
  // actor: { user, key }, req, setCookie }. A route with cdnSeconds > 0 is
  // public: it ignores who is asking so the CDN can share it.
  const routes = [
    ['GET', '/api/sports', () => sports.list(), 300],
    ['GET', '/api/sports/interest', (c) => svc.sportInterest(c.actor)],
    ['POST', '/api/sports/([a-z-]+)/interest', (c, id) => svc.setSportInterest(c.actor, id, c.body.want)],
    ['GET', '/api/tournaments', (c) => svc.listTournaments(Object.fromEntries(c.query)), 5],
    ['GET', '/api/tournaments/places', () => svc.tournamentPlaces(), 60],
    ['POST', '/api/tournaments', (c) => svc.createTournament(c.actor, c.body)],
    // Spectators poll the public copy; anyone signed in or holding a link asks
    // for their own copy with ?me=1, which is never cached.
    ['GET', T, (c, id) => svc.getTournament(id, c.query.has('me') ? c.actor : null), (c) => (c.query.has('me') ? 0 : 1)],
    ['PATCH', T, (c, id) => svc.updateSettings(id, c.actor, c.body)],
    ['DELETE', T, (c, id) => svc.deleteTournament(id, c.actor)],
    ['POST', `${T}/claim`, (c, id) => svc.claim(id, c.actor)],
    ['GET', `${T}/members`, (c, id) => svc.listMembers(id, c.actor)],
    ['POST', `${T}/members`, (c, id) => svc.addMember(id, c.actor, c.body, { baseUrl: baseUrl(c.req) })],
    ['DELETE', `${T}/members/${N}`, (c, id, mid) => svc.removeMember(id, c.actor, mid)],
    // Event-scoped calls take `event` (body or ?event=); it can be left out
    // when the tournament has a single event.
    ['POST', `${T}/events`, (c, id) => svc.addEvents(id, c.actor, c.body)],
    ['PUT', `${T}/events/order`, (c, id) => svc.reorderEvents(id, c.actor, c.body.ids)],
    ['PATCH', `${T}/events/${N}`, (c, id, eid) => svc.updateEvent(id, c.actor, eid, c.body)],
    ['DELETE', `${T}/events/${N}`, (c, id, eid) => svc.deleteEvent(id, c.actor, eid)],
    ['POST', `${T}/entries`, (c, id) => svc.addEntries(id, c.actor, c.body.names, { walkIn: c.body.walkIn, event: ev(c) })],
    ['POST', `${T}/visibility`, (c, id) => svc.setVisibility(id, c.actor, c.body.visibility)],
    ['POST', `${T}/register`, (c, id) => svc.register(id, c.actor, { ...c.body, event: ev(c) }, { baseUrl: baseUrl(c.req) })],
    ['POST', `${T}/entries/${N}/confirm`, (c, id, eid) => svc.confirmEntry(id, c.actor, eid)],
    ['POST', `${T}/media`, (c, id) => svc.uploadMedia(id, c.actor, c.body)],
    ['PATCH', `${T}/media/([0-9a-f]{32})`, (c, id, mid) => svc.updateMedia(id, c.actor, mid, c.body)],
    ['DELETE', `${T}/media/([0-9a-f]{32})`, (c, id, mid) => svc.deleteMedia(id, c.actor, mid)],
    ['POST', `${T}/pairs`, (c, id) => svc.pairSolos(id, c.actor, c.body.a, c.body.b)],
    ['POST', `${T}/pairs/draw`, (c, id) => svc.drawPairs(id, c.actor, { event: ev(c), balance: c.body.balance })],
    ['DELETE', `${T}/pairs/${N}`, (c, id, eid) => svc.unpair(id, c.actor, eid)],
    ['POST', `${T}/entries/${N}/fee`, (c, id, eid) => svc.setEntryFee(id, c.actor, eid, c.body.status ?? null, { baseUrl: baseUrl(c.req) })],
    ['POST', `${T}/entries/${N}/paid`, (c, id, eid) => svc.markFeeSent(id, c.actor, eid, c.body.ref)],
    ['POST', `${T}/entries/${N}/check-in`, (c, id, eid) => svc.checkIn(id, c.actor, eid, c.body.here !== false)],
    ['POST', `${T}/check-in-all`, (c, id) => svc.checkInAll(id, c.actor, c.body.here !== false, { event: ev(c) })],
    ['POST', `${T}/entries/${N}/leave`, (c, id, eid) => svc.leave(id, c.actor, eid)],
    ['POST', `${T}/entries/${N}/withdraw`, (c, id, eid) => svc.withdraw(id, c.actor, eid)],
    ['POST', `${T}/late-entry`, (c, id) => svc.lateEntry(id, c.actor, { ...c.body, event: ev(c) })],
    ['POST', `${T}/redraw`, (c, id) => svc.redraw(id, c.actor, { event: ev(c) })],
    ['PUT', `${T}/entries/order`, (c, id) => svc.reorderEntries(id, c.actor, c.body.ids, { event: ev(c) })],
    ['DELETE', `${T}/entries/${N}`, (c, id, eid) => svc.removeEntry(id, c.actor, eid)],
    ['POST', `${T}/start`, (c, id) => svc.start(id, c.actor, { skipUnconfirmed: Boolean(c.body.skipUnconfirmed), event: ev(c) })],
    ['POST', `${T}/knockout`, (c, id) => svc.startKnockout(id, c.actor, { event: ev(c) })],
    ['PATCH', `${T}/matches/${N}`, (c, id, mid) => svc.updateMatch(id, c.actor, mid, c.body)],
    ['POST', `${T}/matches/${N}/call`, (c, id, mid) => svc.callMatch(id, c.actor, mid, c.body.court)],
    ['POST', `${T}/matches/${N}/queue`, (c, id, mid) => svc.queueMatch(id, c.actor, mid, c.body.top !== false)],
    ['POST', `${T}/matches/${N}/rally`, (c, id, mid) => svc.rally(id, c.actor, mid, c.body.side, c.body.at, { points: c.body.points, foul: c.body.foul, end: c.body.end })],
    ['POST', `${T}/matches/${N}/undo`, (c, id, mid) => svc.undo(id, c.actor, mid, c.body.at)],

    ['GET', '/api/auth/me', (c) => ({ user: c.actor.user, emailEnabled: mailer.enabled })],
    ['POST', '/api/auth/forgot', async (c) => {
      const url = baseUrl(c.req);
      if (!url) throw new HttpError(503, 'Set APP_URL in the project settings to enable password reset');
      await auth.forgotPassword(c.body, url);
      return { ok: true };
    }],
    ['POST', '/api/auth/link', async (c) => {
      const url = baseUrl(c.req);
      if (!url) throw new HttpError(503, 'Set APP_URL in the project settings to enable sign-in links');
      if (!mailer.enabled) throw new HttpError(503, 'Email isn\'t set up on this site — use your password');
      return auth.requestLink(c.body, url);
    }],
    ['POST', '/api/auth/link/use', async (c) => {
      const r = await auth.useLink(c.req, c.body);
      if (r.needsName) return r;
      await svc.players.ensureHandle(db.query, r.user).catch((err) => console.error('Handle failed:', err.message));
      c.setCookie(r.cookie);
      return { user: r.user, next: r.next };
    }],
    ['POST', '/api/auth/reset', async (c) => {
      const { user, cookie } = await auth.resetPassword(c.req, c.body);
      c.setCookie(cookie);
      return { user };
    }],
    ['POST', '/api/auth/signup', async (c) => {
      const { user, cookie } = await auth.signup(c.req, c.body);
      await svc.players.ensureHandle(db.query, user).catch((err) => console.error('Handle failed:', err.message));
      c.setCookie(cookie);
      return { user };
    }],
    ['POST', '/api/auth/login', async (c) => {
      const { user, cookie } = await auth.login(c.req, c.body);
      c.setCookie(cookie);
      return { user };
    }],
    ['POST', '/api/auth/logout', async (c) => {
      c.setCookie(await auth.logout(c.req));
      return { ok: true };
    }],
    ['GET', '/api/me/tournaments', (c) => svc.myTournaments(c.actor)],
    ['GET', '/api/me/entries', (c) => svc.myEntries(c.actor)],
    // Groups: daily play
    ['POST', '/api/groups', (c) => svc.groups.createGroup(c.actor, c.body)],
    ['GET', '/api/me/groups', (c) => svc.groups.myGroups(c.actor)],
    ['GET', G, (c, slug) => svc.groups.view(slug, c.actor, { skip: Number(c.query.get('skip')) || 0 })],
    ['PATCH', G, (c, slug) => svc.groups.updateGroup(slug, c.actor, c.body)],
    ['POST', `${G}/join`, (c, slug) => svc.groups.join(slug, c.actor, c.body)],
    ['POST', `${G}/leave`, (c, slug) => svc.groups.leave(slug, c.actor)],
    ['POST', `${G}/members/${N}`, (c, slug, uid) => svc.groups.setMember(slug, c.actor, uid, c.body.action)],
    ['POST', `${G}/sessions/${N}/rsvp`, (c, slug, sid) => svc.groups.rsvp(slug, c.actor, sid, c.body.status)],
    ['POST', `${G}/sessions/${N}/checkin`, (c, slug, sid) => svc.groups.checkIn(slug, c.actor, sid, c.body.here !== false, c.body.user || null)],
    ['POST', `${G}/sessions/${N}/games`, (c, slug, sid) => svc.groups.startGame(slug, c.actor, sid, c.body)],
    ['GET', `${G}/games/${N}`, (c, slug, gid) => svc.groups.getGame(slug, c.actor, gid)],
    ['POST', `${G}/games/${N}/rally`, (c, slug, gid) => svc.groups.rally(slug, c.actor, gid, c.body.side, c.body.at, { points: c.body.points, foul: c.body.foul, end: c.body.end })],
    ['POST', `${G}/games/${N}/undo`, (c, slug, gid) => svc.groups.undo(slug, c.actor, gid, c.body.at)],
    ['POST', `${G}/games/${N}/result`, (c, slug, gid) => svc.groups.setResult(slug, c.actor, gid, c.body)],
    ['POST', `${G}/games/${N}/confirm`, (c, slug, gid) => svc.groups.confirm(slug, c.actor, gid)],
    ['POST', `${G}/games/${N}/dispute`, (c, slug, gid) => svc.groups.dispute(slug, c.actor, gid)],
    ['POST', `${G}/games/${N}/void`, (c, slug, gid) => svc.groups.voidGame(slug, c.actor, gid)],
    // Player profiles
    ['GET', '/api/me/profile', (c) => svc.players.myProfile(c.actor)],
    ['PATCH', '/api/me/profile', (c) => svc.players.updateProfile(c.actor, c.body)],
    ['POST', '/api/me/profile/media', (c) => svc.players.uploadPhoto(c.actor, c.body)],
    ['DELETE', '/api/me/profile/media', (c) => svc.players.deletePhoto(c.actor)],
    ['POST', `/api/me/entries/${N}/not-me`, (c, id) => svc.players.notMe(c.actor, id)],
    ['POST', '/api/me/dupr', (c) => svc.connectDupr(c.actor, c.body)],
    ['DELETE', '/api/me/dupr', (c) => svc.disconnectDupr(c.actor)],
    ['GET', '/api/admin/dupr', (c) => svc.adminDupr(c.actor)],
    ['POST', `/api/admin/dupr/${N}/retry`, (c, id) => svc.adminDuprRetry(c.actor, id)],
    ['GET', '/api/admin/users', (c) => auth.listUsers(c.actor, Object.fromEntries(c.query))],
    ['GET', `/api/admin/users/${N}`, (c, id) => svc.adminUserDetail(c.actor, id)],
    ['POST', `/api/admin/users/${N}/admin`, (c, id) => auth.setAdmin(c.actor, id, c.body.on)],
    ['POST', `/api/admin/users/${N}/disable`, (c, id) => auth.setDisabled(c.actor, id, c.body.on)],
    ['POST', `/api/admin/users/${N}/reset`, (c, id) => auth.adminResetLink(c.actor, id, baseUrl(c.req) || SITE)],
    ['DELETE', `/api/admin/users/${N}`, (c, id) => auth.deleteUser(c.actor, id)],
    ['GET', '/api/admin/stats', (c) => svc.adminStats(c.actor)],
    ['GET', '/api/admin/tournaments', (c) => svc.adminTournaments(c.actor, Object.fromEntries(c.query))],
    ['POST', `/api/admin/payments/${N}/refund`, (c, id) => svc.refundPayment(c.actor, id, c.body)],

    // Payments (Razorpay). The webhook is handled separately (raw body).
    ['GET', '/api/billing/config', async () => ({ ...publicBillingConfig(billingConfig()), orgIncludesBranding: Boolean(await svc.settings.get('orgIncludesBranding')) })],
    // Academy / venue pages
    ['POST', '/api/orgs', (c) => svc.orgs.createOrg(c.actor, c.body)],
    ['GET', '/api/orgs/mine', (c) => svc.orgs.mine(c.actor)],
    ['GET', '/api/orgs/slug', (c) => svc.orgs.slugStatus(c.query.get('name') || '')],
    ['GET', `${O}`, (c, slug) => svc.orgs.getOrg(slug, c.actor)],
    ['PATCH', `${O}`, (c, slug) => svc.orgs.updateOrg(slug, c.actor, c.body)],
    ['POST', `${O}/media`, (c, slug) => svc.orgs.uploadMedia(slug, c.actor, c.body)],
    ['DELETE', `${O}/media/([0-9a-f]{32})`, (c, slug, mid) => svc.orgs.deleteMedia(slug, c.actor, mid)],
    ['POST', `${O}/members`, (c, slug) => svc.orgs.addMember(slug, c.actor, c.body)],
    ['DELETE', `${O}/members/([^/]+)`, (c, slug, email) => svc.orgs.removeMember(slug, c.actor, decodeURIComponent(email))],
    ['POST', `${O}/checkout`, (c, slug) => svc.orgs.checkout(slug, c.actor)],
    ['PUT', `${T}/entries/${N}/players`, (c, id, eid) => svc.setEntryPlayers(id, c.actor, eid, c.body)],
    ['POST', `${T}/seed-dupr`, (c, id) => svc.seedByDupr(id, c.actor, { event: ev(c) })],
    ['GET', `${T}/dupr.csv`, async (c, id) => {
      const r = await svc.duprCsv(id, c.actor, { event: ev(c) });
      return { download: { type: 'text/csv; charset=utf-8', name: r.filename, body: r.csv } };
    }],
    ['POST', `${T}/org`, (c, id) => svc.orgs.linkTournament(id, c.actor, c.body.org || null)],
    ['GET', '/api/admin/orgs', (c) => svc.orgs.adminOrgs(c.actor, Object.fromEntries(c.query))],
    ['PATCH', `/api/admin/orgs/${N}`, (c, id) => svc.orgs.adminUpdate(c.actor, id, c.body)],
    ['DELETE', `/api/admin/orgs/${N}`, (c, id) => svc.orgs.adminDelete(c.actor, id)],
    ['GET', '/api/admin/settings', (c) => svc.adminSettings(c.actor)],
    ['PATCH', '/api/admin/settings', (c) => svc.setAdminSettings(c.actor, c.body)],
    ['POST', `${T}/checkout`, (c, id) => svc.checkout(id, c.actor, c.body)],
    ['POST', '/api/billing/razorpay/verify', (c) => svc.verifyPayment(c.body, { baseUrl: baseUrl(c.req) })],
    ['GET', '/api/admin/payments', (c) => svc.adminPayments(c.actor, Object.fromEntries(c.query))],
    ['GET', '/api/admin/payments\\.csv', async (c) => ({
      download: { type: 'text/csv; charset=utf-8', name: `tonament-payments-${new Date().toISOString().slice(0, 10)}.csv`, body: await svc.paymentsCsv(c.actor, Object.fromEntries(c.query)) },
    })],
    ['POST', `/api/admin/tournaments/([a-z0-9-]+)/plan`, (c, id) => svc.adminSetPlan(id, c.actor, c.body.plan)],
    ['POST', `/api/admin/tournaments/([a-z0-9-]+)/official`, (c, id) => svc.setOfficial(id, c.actor, c.body.official)],
  ].map(([method, pattern, handler, cache = 0]) => ({ method, re: new RegExp(`^${pattern}$`), handler, cache }));

  // The app page, which tournament pages are built on (read once).
  let shellPromise;
  const readShell = () => {
    shellPromise ??= fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8').catch((err) => {
      shellPromise = undefined;
      throw err;
    });
    return shellPromise;
  };

  // /t/<id>[/<tab> | /m/<match>]: the app page with the tournament's details
  // rendered in, for search engines, link previews and a fast first view.
  async function tournamentPage(req, res, id, rest, search) {
    const page = await svc.tournamentPage(id);
    const base = baseUrl(req) || SITE;
    let html;
    try {
      html = pages.tournamentHtml(await readShell(), { base, id, page: page && page.t ? page : null, match: rest.startsWith('/m/') });
    } catch (err) {
      console.error('index.html unavailable for /t/ pages:', err.message);
      html = sharePage({ base, path: `/t/${id}${rest}${search}`, preview: page && page.t ? page.preview : null });
    }
    const visible = Boolean(page && page.t);
    res.writeHead(page ? 200 : 404, {
      'Content-Type': 'text/html; charset=utf-8',
      // Briefly cached at the CDN (the app fetches live data itself); private ones never.
      'Cache-Control': visible ? 'public, max-age=0, s-maxage=60' : 'no-store',
      ...(visible && { 'Vercel-CDN-Cache-Control': 'max-age=60, stale-while-revalidate=600' }),
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  }

  // Live sports in catalogue order, with what their landing pages need.
  const livePages = () => sports.list().filter((x) => x.status === 'live' && SPORT_PAGES[x.id]).map((x) => ({
    id: x.id,
    name: x.name,
    presets: catalog.presetsFor(x.id).map((p) => p.label),
    courtWord: catalog.courtWord(x.id),
    blurb: SPORT_PAGES[x.id].rules[0],
  }));

  // /<sport> (on Vercel, rewritten to /api/sport/<sport>) and /sports.
  async function sportPage(req, res, slug) {
    const base = baseUrl(req) || SITE;
    const all = livePages();
    const sport = slug && all.find((x) => x.id === slug);
    if (slug && !sport) return false;
    const html = sport
      ? pages.sportHtml({
        base,
        sport,
        content: SPORT_PAGES[sport.id],
        tournaments: (await svc.listTournaments({ sport: sport.id, when: 'upcoming' })).slice(0, 8),
        others: all.filter((x) => x.id !== sport.id),
      })
      : pages.sportsHubHtml({ base, sports: all });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // The tournament list changes: briefly cached at the CDN.
      'Cache-Control': 'public, max-age=0, s-maxage=600',
      'Vercel-CDN-Cache-Control': 'max-age=600, stale-while-revalidate=86400',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : html);
    return true;
  }

  // /@slug (on Vercel, rewritten to /api/org/<slug>): an academy's public page,
  // cached at the CDN. ?preview=1 lets its team see a draft or lapsed page.
  async function orgPage(req, res, slug, preview) {
    const base = baseUrl(req) || SITE;
    let o = await svc.orgs.page(slug);
    let cacheable = true;
    if (!o && preview) {
      const user = await auth.userFromRequest(req);
      const view = user ? await svc.orgs.getOrg(slug, { user }).catch(() => null) : null;
      if (view && view.can.edit) {
        o = view;
        cacheable = false;
      }
    }
    if (!o) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : await fs.readFile(path.join(PUBLIC_DIR, '404.html')));
    }
    let html = pages.orgHtml({ base, o });
    if (!cacheable) html = html.replace('<meta name="theme-color"', '<meta name="robots" content="noindex">\n  <meta name="theme-color"');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': cacheable ? 'public, max-age=0, s-maxage=600' : 'no-store',
      ...(cacheable && { 'Vercel-CDN-Cache-Control': 'max-age=600, stale-while-revalidate=86400' }),
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }

  const htmlHeaders = (cacheable, seconds = 600) => ({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': cacheable ? `public, max-age=0, s-maxage=${seconds}` : 'no-store',
    ...(cacheable && { 'Vercel-CDN-Cache-Control': `max-age=${seconds}, stale-while-revalidate=86400` }),
    'X-Content-Type-Options': 'nosniff',
  });
  async function notFound(req, res) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : await fs.readFile(path.join(PUBLIC_DIR, '404.html')));
  }

  // /p/<handle> (on Vercel, /api/player/<handle>): a player's public profile.
  // ?me=1 is the player's own (uncached) view, which also works while private.
  async function playerPage(req, res, handle, me) {
    const base = baseUrl(req) || SITE;
    const user = me ? await auth.userFromRequest(req) : null;
    const p = await svc.players.profile(handle, user ? { user } : null);
    if (!p) return notFound(req, res);
    const cacheable = !p.own;
    let html = pages.playerHtml({ base, p });
    if (!p.public) html = html.replace('<meta name="theme-color"', '<meta name="robots" content="noindex">\n  <meta name="theme-color"');
    res.writeHead(200, htmlHeaders(cacheable, 60)); // edits show within a minute
    return res.end(req.method === 'HEAD' ? undefined : html);
  }

  // /rankings, /rankings/<sport>, /rankings/<sport>/<category>?state=&city=&page=
  async function rankingsPage(req, res, sportId, category, params) {
    const base = baseUrl(req) || SITE;
    let html;
    if (!sportId) {
      html = pages.rankingsHubHtml({ base, sports: await svc.players.sportCounts() });
    } else {
      const sport = sports.get(sportId);
      if (!sport) return notFound(req, res);
      if (!category) {
        html = pages.rankingsSportHtml({ base, sport, categories: await svc.players.overview(sport.id) });
      } else {
        const name = rankings.categoryName(category, catalog.agesFor(sport.id));
        if (!name) return notFound(req, res);
        const scope = { region: (params.get('state') || '').slice(0, 60), city: (params.get('city') || '').slice(0, 60) };
        const pageSize = 50;
        const offset = (Math.max(1, Math.min(200, Number(params.get('page')) || 1)) - 1) * pageSize;
        const [table, places] = await Promise.all([svc.players.table(sport.id, category, { ...scope, offset }), svc.players.places(sport.id, category)]);
        html = pages.rankingsTableHtml({ base, sport, category, name, table, places, scope, offset, pageSize });
      }
    }
    res.writeHead(200, htmlHeaders(true));
    return res.end(req.method === 'HEAD' ? undefined : html);
  }

  async function sitemapXml(req, res) {
    const base = baseUrl(req) || SITE;
    const fixed = ['/', '/features', '/sports', ...livePages().map((x) => `/${x.id}`), '/how-it-works', '/faq', '/pricing', '/contact', '/terms', '/privacy', '/refunds', '/delivery'].map((p) => ({ path: p }));
    const xml = pages.sitemap(base, [...fixed, ...await svc.orgs.sitemapOrgs(), ...await svc.players.sitemapPlayers(), ...await svc.sitemapTournaments()]);
    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=3600',
      'Vercel-CDN-Cache-Control': 'max-age=3600, stale-while-revalidate=86400',
    });
    res.end(req.method === 'HEAD' ? undefined : xml);
  }

  async function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, { error: 'Bad path' });
    }
    if (rel === '/') rel = '/index.html';
    let file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'Not found' });
    let data;
    let status = 200;
    try {
      data = await fs.readFile(file);
    } catch {
      if (path.extname(rel)) return send(res, 404, { error: 'Not found' });
      try {
        file = `${file.replace(/[\\/]+$/, '')}.html`; // clean URLs: /pricing -> pricing.html (as Vercel's cleanUrls)
        data = await fs.readFile(file);
      } catch {
        // The app's own pages get the app; anything else is a real 404 (as on Vercel).
        const appPage = APP_ROUTES.test(rel);
        file = path.join(PUBLIC_DIR, appPage ? 'index.html' : '404.html');
        status = appPage ? 200 : 404;
        data = await fs.readFile(file);
      }
    }
    res.writeHead(status, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function handle(req, res) {
    // Server-Timing shows up in the browser's DevTools (Network → Timing),
    // which helps tell server time apart from network time.
    const started = performance.now();
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      res.setHeader('Server-Timing', `app;dur=${(performance.now() - started).toFixed(1)}`);
      return writeHead.apply(this, args);
    };
    const url = new URL(req.url, 'http://localhost');
    const pathname = apiPath(url);
    try {
      if (pathname === '/api/billing/razorpay/webhook' && req.method === 'POST') {
        // Signature covers the exact bytes Razorpay sent, so read them raw.
        const raw = await readRaw(req);
        const result = await svc.razorpayWebhook(raw, req.headers['x-razorpay-signature'], { baseUrl: baseUrl(req) });
        return send(res, 200, result);
      }
      // Images: binary responses, cached for good (the id is a content hash).
      const media = pathname.match(/^\/api\/media\/([0-9a-f]{32})$/);
      if (media && (req.method === 'GET' || req.method === 'HEAD')) {
        const file = await svc.getMedia(media[1], () => auth.userFromRequest(req).then((user) => ({ user, key: req.headers['x-admin-key'] || null })));
        res.writeHead(200, {
          'Content-Type': file.mime,
          'Content-Length': file.bytes.length,
          'Cache-Control': file.public ? 'public, max-age=31536000, immutable' : 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
        });
        return res.end(req.method === 'HEAD' ? undefined : file.bytes);
      }
      const read = req.method === 'GET' || req.method === 'HEAD';
      // Tournament pages (on Vercel, /t/* is rewritten to /api/share/*).
      const shared = pathname.match(/^\/(?:t|api\/share)\/([a-z0-9-]{1,100})((?:\/[a-z]+(?:\/\d+)?)?)\/?$/);
      if (shared && read) {
        return await tournamentPage(req, res, shared[1], shared[2], url.search.replace(/[?&]__path=[^&]*/, '').replace(/^&/, '?'));
      }
      if ((pathname === '/sitemap.xml' || pathname === '/api/sitemap') && read) return await sitemapXml(req, res);
      // The app's own pages (/groups, /g/…, /signin, …). On Vercel they're
      // rewritten here (/api/index?__path=app): with cleanUrls on, a rewrite
      // straight to /index.html finds no file and 404s.
      if (pathname === '/api/app' && read) {
        const html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
        // The CDN keeps it (every deploy clears the CDN), so links open without waiting for the function.
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=0, must-revalidate',
          'Vercel-CDN-Cache-Control': 'max-age=86400, stale-while-revalidate=604800',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(req.method === 'HEAD' ? undefined : html);
      }
      // Academy / venue pages: /@slug (on Vercel, /api/org/<slug>).
      const orgPath = pathname.match(/^\/(?:@|api\/org\/)([a-z0-9-]{3,30})\/?$/);
      if (orgPath && read) return await orgPage(req, res, orgPath[1], url.searchParams.has('preview'));
      // Player profiles and rankings.
      const playerPath = pathname.match(/^\/(?:p|api\/player)\/([a-z0-9-]{3,40})\/?$/);
      if (playerPath && read) return await playerPage(req, res, playerPath[1], url.searchParams.has('me'));
      const rankPath = pathname.match(/^\/(?:api\/)?rankings(?:\/([a-z-]{1,40}))?(?:\/([a-z0-9-]{2,20}))?\/?$/);
      if (rankPath && read) return await rankingsPage(req, res, rankPath[1] || null, rankPath[2] || null, url.searchParams);
      // Sport landing pages: /badminton, /pickleball, … and the /sports hub.
      const sportPath = pathname.match(/^\/(?:api\/sport(?:\/([a-z-]{1,40}))?|sports|([a-z-]{1,40}))\/?$/);
      if (sportPath && read && (sportPath[1] || sportPath[2] || /sport/.test(pathname)) && await sportPage(req, res, sportPath[1] || sportPath[2] || null)) return;
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        let pathMatched = false;
        for (const route of routes) {
          const m = pathname.match(route.re);
          if (!m) continue;
          pathMatched = true;
          if (route.method !== req.method) continue;
          const write = req.method !== 'GET' && req.method !== 'HEAD';
          if (write && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
          const cookies = [];
          const ctx = {
            req,
            query: url.searchParams,
            body: write ? await readJson(req, /\/media$/.test(pathname) ? MAX_MEDIA_BODY : MAX_BODY) : {},
            setCookie: (cookie) => cookies.push(cookie),
          };
          const cache = typeof route.cache === 'function' ? route.cache(ctx) : route.cache;
          // Public (cacheable) responses never depend on who is asking.
          ctx.actor = cache
            ? { user: null, key: null }
            : { user: await auth.userFromRequest(req), key: req.headers['x-admin-key'] || null };
          const result = await route.handler(ctx, ...m.slice(1));
          // A file download (e.g. the payments CSV) instead of JSON.
          if (result && result.download) {
            res.writeHead(200, {
              'Content-Type': result.download.type,
              'Content-Disposition': `attachment; filename="${result.download.name}"`,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            });
            return res.end(req.method === 'HEAD' ? undefined : result.download.body);
          }
          const created = req.method === 'POST' && pathname === '/api/tournaments';
          return send(res, created ? 201 : 200, result, cache, cookies);
        }
        return pathMatched ? send(res, 405, { error: 'Method not allowed' }) : send(res, 404, { error: 'Not found' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return await serveStatic(req, res, pathname);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message, ...(err.code && { code: err.code }) });
      console.error(err);
      return send(res, 500, { error: 'Something went wrong' });
    }
  }

  return { handle, service: svc };
}

module.exports = { createApp };
