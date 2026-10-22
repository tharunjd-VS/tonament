'use strict';

// DUPR (pickleball ratings). Today: players type their DUPR ID and ratings
// (shown as self-reported), organisers seed by rating, set rating limits and
// download results for their DUPR club's match upload. The API client below
// stays off until DUPR issues partner keys (DUPR_CLIENT_ID / DUPR_CLIENT_SECRET).

const MIN_RATING = 2;
const MAX_RATING = 8;

// "4DGE5W" style IDs: letters and digits.
function checkId(value, fail) {
  const id = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9]{4,12}$/.test(id)) fail(400, 'DUPR ID: 4–12 letters and numbers, as shown in the DUPR app');
  return id;
}
// A rating like 3.512 (or empty).
function checkRating(value, fail) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < MIN_RATING || n > MAX_RATING) fail(400, `DUPR ratings are between ${MIN_RATING}.000 and ${MAX_RATING}.000`);
  return Math.round(n * 1000) / 1000;
}

// An entry's rating for seeding and limits: singles rating, or a pair's
// two doubles ratings added up (null when any is missing).
function entryRating(people, discipline) {
  const key = discipline === 'singles' ? 'duprSingles' : 'duprDoubles';
  const ratings = people.map((p) => (p[key] == null ? null : Number(p[key])));
  if (!ratings.length || ratings.some((r) => r == null)) return null;
  return Math.round(ratings.reduce((a, b) => a + b, 0) * 1000) / 1000;
}

// ---------- results for the DUPR club match upload (CSV)
// One row per match. The columns follow DUPR's club match-upload template;
// keep them in this one list so they're easy to match to the current template.
const CSV_COLUMNS = [
  ['matchType', (m) => (m.doubles ? 'D' : 'S')],
  ['scoreType', () => 'SIDEOUT'],
  ['event', (m) => m.event],
  ['date', (m) => m.date],
  ['playerA1', (m) => m.a[0]?.name],
  ['playerA1DuprId', (m) => m.a[0]?.duprId],
  ['playerA2', (m) => m.a[1]?.name],
  ['playerA2DuprId', (m) => m.a[1]?.duprId],
  ['playerB1', (m) => m.b[0]?.name],
  ['playerB1DuprId', (m) => m.b[0]?.duprId],
  ['playerB2', (m) => m.b[1]?.name],
  ['playerB2DuprId', (m) => m.b[1]?.duprId],
  ...[1, 2, 3, 4, 5].flatMap((g) => [
    [`teamAGame${g}`, (m) => m.games[g - 1]?.[0]],
    [`teamBGame${g}`, (m) => m.games[g - 1]?.[1]],
  ]),
  ['missingDuprIds', (m) => (m.missing ? 'yes' : '')],
];
const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};
// matches: [{ doubles, event, date, a: [{ name, duprId }], b: [...], games: [[11, 7], …] }]
function csv(matches) {
  const lines = [CSV_COLUMNS.map(([k]) => k).join(',')];
  for (const m of matches) {
    const missing = [...m.a, ...m.b].some((p) => !p.duprId);
    lines.push(CSV_COLUMNS.map(([, f]) => csvCell(f({ ...m, missing }))).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// ---------- the partner API (off until keys are set)

const config = (env = process.env) => ({
  clientId: env.DUPR_CLIENT_ID || '',
  clientSecret: env.DUPR_CLIENT_SECRET || '',
  base: (env.DUPR_API_BASE || 'https://api.dupr.gg').replace(/\/+$/, ''),
});
const enabled = (env = process.env) => Boolean(config(env).clientId && config(env).clientSecret);

// A minimal client. The paths are placeholders to confirm against the
// partner documentation DUPR shares when they approve Tonament.
function createClient({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const cfg = config(env);
  let token = null;
  let expires = 0;
  async function auth() {
    if (token && Date.now() < expires) return token;
    const res = await fetchImpl(`${cfg.base}/auth/v1.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: cfg.clientId, clientSecret: cfg.clientSecret }),
    });
    if (!res.ok) throw new Error(`DUPR auth failed (${res.status})`);
    const data = await res.json();
    token = data.token || data.accessToken;
    expires = Date.now() + 50 * 60 * 1000;
    return token;
  }
  async function call(method, path, body) {
    if (!enabled(env)) throw new Error('DUPR isn\'t connected');
    const res = await fetchImpl(`${cfg.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await auth()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `DUPR request failed (${res.status})`);
    return data;
  }
  return {
    // { id, singles, doubles } for a DUPR ID.
    async player(duprId) {
      const data = await call('GET', `/player/v1.0/${encodeURIComponent(duprId)}`);
      const r = data.result || data;
      return { id: duprId, name: r.fullName || r.name || null, singles: r.ratings?.singles ?? null, doubles: r.ratings?.doubles ?? null };
    },
    // Sends one finished match; returns DUPR's match id.
    async submitMatch(match) {
      const data = await call('POST', '/match/v1.0/create', match);
      return String((data.result && data.result.id) || data.id || '');
    },
  };
}

module.exports = { MIN_RATING, MAX_RATING, CSV_COLUMNS, checkId, checkRating, entryRating, csv, config, enabled, createClient };
