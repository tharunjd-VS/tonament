'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const sports = require('./sports');
const { createService, HttpError } = require('./service');

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

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJson(req) {
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

function createApp(db) {
  const svc = createService(db);
  const streams = new Map(); // tournamentId -> Set<res>

  svc.events.on('change', (id, payload) => {
    const clients = streams.get(id);
    if (!clients) return;
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(msg);
  });

  const T = '/api/tournaments/([a-z0-9-]+)';
  const N = '(\\d+)';
  const routes = [
    ['GET', '/api/sports', () => sports.list()],
    ['GET', '/api/tournaments', () => svc.listTournaments()],
    ['POST', '/api/tournaments', (c) => svc.createTournament(c.body)],
    ['GET', T, (c, id) => svc.getTournament(id, c.key)],
    ['PATCH', T, (c, id) => svc.updateSettings(id, c.key, c.body)],
    ['DELETE', T, (c, id) => svc.deleteTournament(id, c.key)],
    ['POST', `${T}/entries`, (c, id) => svc.addEntries(id, c.key, c.body.names)],
    ['PUT', `${T}/entries/order`, (c, id) => svc.reorderEntries(id, c.key, c.body.ids)],
    ['DELETE', `${T}/entries/${N}`, (c, id, eid) => svc.removeEntry(id, c.key, eid)],
    ['POST', `${T}/start`, (c, id) => svc.start(id, c.key)],
    ['POST', `${T}/knockout`, (c, id) => svc.startKnockout(id, c.key)],
    ['PATCH', `${T}/matches/${N}`, (c, id, mid) => svc.updateMatch(id, c.key, mid, c.body)],
    ['POST', `${T}/matches/${N}/rally`, (c, id, mid) => svc.rally(id, c.key, mid, c.body.side)],
    ['POST', `${T}/matches/${N}/undo`, (c, id, mid) => svc.undo(id, c.key, mid)],
  ].map(([method, pattern, handler]) => ({ method, re: new RegExp(`^${pattern}$`), handler }));

  function openStream(req, res, id) {
    if (!svc.exists(id)) return send(res, 404, { error: 'Tournament not found' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
    });
    res.write('retry: 3000\n\n');
    if (!streams.has(id)) streams.set(id, new Set());
    streams.get(id).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      const clients = streams.get(id);
      clients?.delete(res);
      if (clients && !clients.size) streams.delete(id);
    });
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
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname.startsWith('/api/')) {
        const sse = pathname.match(/^\/api\/tournaments\/([a-z0-9-]+)\/stream$/);
        if (sse && req.method === 'GET') return openStream(req, res, sse[1]);
        let pathMatched = false;
        for (const route of routes) {
          const m = pathname.match(route.re);
          if (!m) continue;
          pathMatched = true;
          if (route.method !== req.method) continue;
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
          const key = req.headers['x-admin-key'];
          const result = route.handler({ body, key }, ...m.slice(1));
          const created = req.method === 'POST' && pathname === '/api/tournaments';
          return send(res, created ? 201 : 200, result);
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
