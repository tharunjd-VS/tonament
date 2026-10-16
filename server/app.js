'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const sports = require('./sports');
const { createService } = require('./service');
const { createAuth } = require('./auth');
const { HttpError } = require('./errors');
const { createMailer } = require('./email');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 100 * 1024;
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
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cdnSeconds
      ? `public, max-age=0, s-maxage=${cdnSeconds}, stale-while-revalidate=${cdnSeconds * 2}`
      : 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
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
      if (size > MAX_BODY) {
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

function createApp(db, { mailer = createMailer() } = {}) {
  const svc = createService(db, { mailer });
  const auth = createAuth(db, { mailer });

  const T = '/api/tournaments/([a-z0-9-]+)';
  const N = '(\\d+)';
  // [method, path, handler, cdnSeconds]. Handlers get ctx = { body, query,
  // actor: { user, key }, req, setCookie }. A route with cdnSeconds > 0 is
  // public: it ignores who is asking so the CDN can share it.
  const routes = [
    ['GET', '/api/sports', () => sports.list(), 300],
    ['GET', '/api/tournaments', () => svc.listTournaments(), 5],
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
    ['POST', `${T}/entries`, (c, id) => svc.addEntries(id, c.actor, c.body.names)],
    ['PUT', `${T}/entries/order`, (c, id) => svc.reorderEntries(id, c.actor, c.body.ids)],
    ['DELETE', `${T}/entries/${N}`, (c, id, eid) => svc.removeEntry(id, c.actor, eid)],
    ['POST', `${T}/start`, (c, id) => svc.start(id, c.actor)],
    ['POST', `${T}/knockout`, (c, id) => svc.startKnockout(id, c.actor)],
    ['PATCH', `${T}/matches/${N}`, (c, id, mid) => svc.updateMatch(id, c.actor, mid, c.body)],
    ['POST', `${T}/matches/${N}/rally`, (c, id, mid) => svc.rally(id, c.actor, mid, c.body.side)],
    ['POST', `${T}/matches/${N}/undo`, (c, id, mid) => svc.undo(id, c.actor, mid)],

    ['GET', '/api/auth/me', (c) => ({ user: c.actor.user, emailEnabled: mailer.enabled })],
    ['POST', '/api/auth/forgot', async (c) => {
      const url = baseUrl(c.req);
      if (!url) throw new HttpError(503, 'Set APP_URL in the project settings to enable password reset');
      await auth.forgotPassword(c.body, url);
      return { ok: true };
    }],
    ['POST', '/api/auth/reset', async (c) => {
      const { user, cookie } = await auth.resetPassword(c.req, c.body);
      c.setCookie(cookie);
      return { user };
    }],
    ['POST', '/api/auth/signup', async (c) => {
      const { user, cookie } = await auth.signup(c.req, c.body);
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
    ['GET', '/api/admin/users', (c) => auth.listUsers(c.actor)],
  ].map(([method, pattern, handler, cache = 0]) => ({ method, re: new RegExp(`^${pattern}$`), handler, cache }));

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
    try {
      data = await fs.readFile(file);
    } catch {
      if (path.extname(rel)) return send(res, 404, { error: 'Not found' });
      file = path.join(PUBLIC_DIR, 'index.html'); // SPA fallback
      data = await fs.readFile(file);
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = apiPath(url);
    try {
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
            body: write ? await readJson(req) : {},
            setCookie: (cookie) => cookies.push(cookie),
          };
          const cache = typeof route.cache === 'function' ? route.cache(ctx) : route.cache;
          // Public (cacheable) responses never depend on who is asking.
          ctx.actor = cache
            ? { user: null, key: null }
            : { user: await auth.userFromRequest(req), key: req.headers['x-admin-key'] || null };
          const result = await route.handler(ctx, ...m.slice(1));
          const created = req.method === 'POST' && pathname === '/api/tournaments';
          return send(res, created ? 201 : 200, result, cache, cookies);
        }
        return pathMatched ? send(res, 405, { error: 'Method not allowed' }) : send(res, 404, { error: 'Not found' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
      return await serveStatic(req, res, pathname);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Something went wrong' });
    }
  }

  return { handle, service: svc };
}

module.exports = { createApp };
