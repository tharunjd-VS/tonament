'use strict';

const crypto = require('node:crypto');
const sports = require('./sports');
const formats = require('./formats');
const { HttpError } = require('./errors');
const { normalizeEmail, validEmail } = require('./auth');
const { inviteEmail, receiptEmail, waitingEmail } = require('./email');
const { billingConfig, createRazorpay, verifyPaymentSignature, verifyWebhookSignature } = require('./billing');

const FORMATS = {
  league_knockout: 'League + Knockout',
  league: 'League',
  knockout: 'Knockout',
};
const MAX_ENTRIES = 128;
const VISIBILITY = ['private', 'link', 'public'];

const ROLES = { owner: 'Owner', organiser: 'Organiser', umpire: 'Umpire' };
const fail = (status, message, code) => {
  throw new HttpError(status, message, code);
};

function text(value, label, { max = 80, optional = false } = {}) {
  const s = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!s) {
    if (optional) return null;
    fail(400, `${label} is required`);
  }
  if (s.length > max) fail(400, `${label} must be at most ${max} characters`);
  return s;
}

function int(value, min, max, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label} must be a whole number from ${min} to ${max}`);
  return n;
}

function slugify(name) {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');
  return slug || 'tournament';
}

const groupName = (no) => `Group ${String.fromCharCode(65 + no)}`;
const nextSlotColumn = (m) => (m.slot % 2 ? 'b_id' : 'a_id');

// Every write runs in a transaction that first locks the tournament row, so
// concurrent requests for one tournament (two umpires, retries, several
// serverless instances) are applied one at a time.
function createService(db, { mailer, fetchImpl } = {}) {
  // ---------- queries (q is db.query or a transaction's query)

  async function load(q, id, { lock = false } = {}) {
    const [row] = await q(`SELECT * FROM tournaments WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [String(id)]);
    if (!row) fail(404, 'Tournament not found');
    return { ...row, sportDef: sports.get(row.sport) };
  }

  const entriesOf = (q, tid) =>
    q(
      `SELECT id, name, seed, group_no, checked_in, in_draw, withdrawn, source, contact, confirmed
       FROM entries WHERE tournament_id = $1 ORDER BY seed, id`,
      [tid],
    );

  const insertEntry = (q, t, { name, seed, group = null, source = 'organiser', checkedIn = false, contact = null, confirmed = true }) =>
    q(
      `INSERT INTO entries (tournament_id, name, seed, group_no, source, checked_in, contact, confirmed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [t.id, name, seed, group, source, checkedIn, contact, confirmed],
    );

  const matchesOf = (q, tid) =>
    q(`SELECT * FROM matches WHERE tournament_id = $1 ORDER BY stage = 'knockout', round, group_no, slot, id`, [tid]);

  async function matchOf(q, t, mid) {
    const [m] = await q('SELECT * FROM matches WHERE id = $1 AND tournament_id = $2', [Number(mid) || 0, t.id]);
    if (!m) fail(404, 'Match not found');
    return m;
  }

  async function koMatch(q, t, round, slot) {
    const [m] = await q(
      `SELECT * FROM matches WHERE tournament_id = $1 AND stage = 'knockout' AND round = $2 AND slot = $3`,
      [t.id, round, slot],
    );
    return m;
  }

  async function pendingLeague(q, t) {
    const [{ n }] = await q(
      `SELECT COUNT(*)::int AS n FROM matches WHERE tournament_id = $1 AND stage = 'league' AND status <> 'done'`,
      [t.id],
    );
    return n;
  }

  const insertMatch = (q, t, stage, group, round, slot, a, b, status = 'scheduled', winner = null, extra = {}) =>
    q(
      `INSERT INTO matches (tournament_id, stage, group_no, round, slot, a_id, b_id, status, winner_id, walkover, catch_up)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [t.id, stage, group, round, slot, a, b, status, winner, Boolean(extra.walkover), Boolean(extra.catchUp)],
    );

  async function setStatus(q, t, status) {
    await q('UPDATE tournaments SET status = $1 WHERE id = $2', [status, t.id]);
    t.status = status;
  }

  // ---------- access
  // An actor is { user, key }: the signed-in user (or null) and a share-link
  // key (or null). Roles, strongest first: admin (site admin), owner,
  // organiser, umpire. The organiser link acts as organiser and the scorer
  // link as umpire.

  function keyMatches(key, secret) {
    if (typeof key !== 'string' || !key || !secret) return false;
    const a = Buffer.from(key);
    const b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const RANK = { umpire: 1, organiser: 2, owner: 3, admin: 4 };
  const stronger = (a, b) => ((RANK[a] || 0) >= (RANK[b] || 0) ? a : b);

  async function accessOf(q, t, actor = {}) {
    // One round trip: my membership (if signed in) and whether an owner exists.
    const [{ member_role: memberRole, has_owner: owner }] = await q(
      `SELECT (SELECT role FROM members WHERE tournament_id = $1 AND email = $2) AS member_role,
              EXISTS (SELECT 1 FROM members WHERE tournament_id = $1 AND role = 'owner') AS has_owner`,
      [t.id, actor.user?.email ?? ''],
    );
    let role = actor.user?.isAdmin ? 'admin' : memberRole ?? null;
    if (keyMatches(actor.key, t.admin_key)) role = stronger(role, 'organiser');
    else if (keyMatches(actor.key, t.scorer_key)) role = stronger(role, 'umpire');
    return {
      role,
      score: RANK[role] >= RANK.umpire,
      manage: RANK[role] >= RANK.organiser,
      // An ownerless (pre-accounts) tournament can be deleted with its organiser link.
      delete: RANK[role] >= RANK.owner || (!owner && RANK[role] >= RANK.organiser),
      own: RANK[role] >= RANK.owner || (!owner && RANK[role] >= RANK.organiser), // e.g. who can see it
      claim: Boolean(!owner && actor.user && keyMatches(actor.key, t.admin_key)),
    };
  }

  const NEED = {
    score: 'Only the tournament team can score matches',
    manage: 'Only the organisers can do that',
    delete: 'Only the owner can delete this tournament',
    own: 'Only the owner can change who can see this tournament',
  };

  async function lockWith(q, id, actor, need) {
    const t = await load(q, id, { lock: true });
    const access = await accessOf(q, t, actor);
    if (!access[need]) fail(actor.user || actor.key ? 403 : 401, actor.user || actor.key ? NEED[need] : 'Sign in to do that');
    return { t, access };
  }

  // Runs fn with the tournament locked and returns the fresh view.
  function mutate(id, actor, fn, need = 'manage') {
    return db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, need);
      await fn(q, t);
      return view(q, await load(q, id), actor);
    });
  }

  const given = (v) => v !== undefined && v !== null && v !== '';

  function closeTime(value) {
    if (!given(value)) return null;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) fail(400, 'Entries close: enter a valid date and time');
    return new Date(ms).toISOString();
  }

  function buildConfig(input, sport, prev = {}) {
    const isNew = !prev.scoring;
    // Groups are sized "about N players" (worked out at the start from the
    // final head-count), unless a fixed number of groups is given.
    let groupSize = prev.groupSize ?? (isNew ? 4 : null);
    if (given(input.groupSize)) groupSize = int(input.groupSize, 2, 16, 4, 'Players per group');
    else if (given(input.groups)) groupSize = null;
    return {
      ...prev,
      groups: int(input.groups, 1, 16, prev.groups ?? 2, 'Number of groups'),
      groupSize,
      qualifiers: int(input.qualifiers, 1, 8, prev.qualifiers ?? 2, 'Qualifiers per group'),
      scoring: sport.normalizeConfig(input.scoring ?? prev.scoring),
      // Self-entry through the public page: on for new tournaments.
      selfEntry: input.selfEntry !== undefined ? Boolean(input.selfEntry) : prev.selfEntry ?? isNew,
      entriesCloseAt: input.entriesCloseAt !== undefined ? closeTime(input.entriesCloseAt) : prev.entriesCloseAt ?? null,
      lateEntry: input.lateEntry !== undefined ? Boolean(input.lateEntry) : prev.lateEntry ?? false,
      // The organiser's own cap on self-entries (blank = no cap).
      maxEntries: input.maxEntries !== undefined ? int(input.maxEntries, 2, MAX_ENTRIES, null, 'Maximum entries') : prev.maxEntries ?? null,
    };
  }

  // A maximum above the free limit needs the Event Pass.
  function checkMaxEntries(config, plan) {
    const cfg = billingConfig();
    if (!cfg.enabled || plan === 'pass' || !config.maxEntries || config.maxEntries <= cfg.freeLimit) return;
    fail(402, `A maximum of ${config.maxEntries} entries needs the Event Pass (the free plan allows up to ${cfg.freeLimit}).`, 'upgrade');
  }

  const groupsFor = (t, n) => (t.config.groupSize ? formats.groupCount(n, t.config.groupSize) : t.config.groups);

  const confirmedCount = async (q, t) =>
    (await q('SELECT COUNT(*)::int AS n FROM entries WHERE tournament_id = $1 AND confirmed', [t.id]))[0].n;

  // Free plan: up to cfg.freeLimit confirmed entries per tournament (only once
  // Razorpay is configured). Organisers adding players get an upgrade prompt;
  // self-entries over the limit are saved unconfirmed instead (see register).
  async function checkEntryLimit(q, t, adding) {
    const cfg = billingConfig();
    if (!cfg.enabled || t.plan === 'pass') return;
    const n = await confirmedCount(q, t);
    if (n + adding <= cfg.freeLimit) return;
    const left = Math.max(0, cfg.freeLimit - n);
    fail(
      402,
      `The free plan allows up to ${cfg.freeLimit} entries per tournament${left ? ` (${left} left)` : ''}. Get the Event Pass for unlimited entries.`,
      'upgrade',
    );
  }

  // How many confirmed entries self-entry can fill: the organiser's maximum,
  // the free plan's limit and the hard cap, whichever is lowest.
  function capacity(t) {
    const cfg = billingConfig();
    const caps = [MAX_ENTRIES];
    if (t.config.maxEntries) caps.push(t.config.maxEntries);
    if (cfg.enabled && t.plan !== 'pass') caps.push(cfg.freeLimit);
    return Math.min(...caps);
  }

  // Confirms waiting self-entries in sign-up order while there's room (after
  // the Event Pass is bought). Returns how many were confirmed.
  async function confirmWaiting(q, t) {
    if (t.status !== 'setup') return 0;
    const room = capacity(t) - (await confirmedCount(q, t));
    if (room <= 0) return 0;
    const rows = await q(
      `UPDATE entries SET confirmed = true WHERE id IN (
         SELECT id FROM entries WHERE tournament_id = $1 AND NOT confirmed ORDER BY id LIMIT $2
       ) RETURNING id`,
      [t.id, room],
    );
    return rows.length;
  }

  function entriesOpen(t) {
    if (t.status !== 'setup' || !t.config.selfEntry) return false;
    return !t.config.entriesCloseAt || Date.now() < Date.parse(t.config.entriesCloseAt);
  }

  // ---------- views

  const scoreOf = (t, m) => t.sportDef.compute(m.rallies, t.config.scoring, m.first_server);

  function matchView(t, m, score, names) {
    const side = (id) => (id == null ? null : { id, name: names.get(id) ?? 'Unknown' });
    return {
      id: m.id,
      stage: m.stage,
      group: m.group_no,
      groupName: m.group_no == null ? null : groupName(m.group_no),
      round: m.round,
      slot: m.slot,
      roundName: m.stage === 'knockout' ? formats.roundName(m.round, t.config.knockoutRounds) : `Round ${m.round}`,
      a: side(m.a_id),
      b: side(m.b_id),
      status: m.status,
      court: m.court,
      firstServer: m.first_server,
      rallies: m.rallies.length,
      log: m.rallies, // rally winners in order, e.g. "abba" — lets the scorer's screen update instantly
      winner: m.winner_id,
      walkover: m.walkover,
      catchUp: m.catch_up,
      score,
      summary: m.walkover ? 'Walkover' : t.sportDef.summary(score),
      updatedAt: m.updated_at,
    };
  }

  // A walkover counts as a win/loss but adds nothing to games or points.
  function resultOf(m, score) {
    const w = m.walkover;
    return {
      a: m.a_id,
      b: m.b_id,
      winner: m.winner_id,
      gamesA: w ? 0 : score.gamesWon.a,
      gamesB: w ? 0 : score.gamesWon.b,
      pointsA: w ? 0 : score.totals.a,
      pointsB: w ? 0 : score.totals.b,
    };
  }

  function groupStandings(t, entries, scored, names) {
    if (t.format === 'knockout' || t.status === 'setup') return [];
    return Array.from({ length: t.config.groups }, (_, g) => {
      const members = entries.filter((e) => e.group_no === g).map((e) => e.id);
      const results = scored
        .filter(({ row }) => row.stage === 'league' && row.group_no === g && row.status === 'done')
        .map(({ row, score }) => resultOf(row, score));
      return {
        no: g,
        name: groupName(g),
        standings: formats.standings(members, results).map((r) => ({
          ...r,
          name: names.get(r.id),
          withdrawn: entries.some((e) => e.id === r.id && e.withdrawn),
        })),
      };
    });
  }

  async function view(q, t, actor) {
    const [entries, rows] = await Promise.all([entriesOf(q, t.id), matchesOf(q, t.id)]);
    const names = new Map(entries.map((e) => [e.id, e.name]));
    const scored = rows.map((row) => ({ row, score: scoreOf(t, row) }));
    const groups = groupStandings(t, entries, scored, names);
    const matches = scored.map(({ row, score }) => matchView(t, row, score, names));

    let champion = null;
    if (t.status === 'completed') {
      const final = matches.find((m) => m.stage === 'knockout' && m.round === t.config.knockoutRounds);
      if (final) champion = final.winner && { id: final.winner, name: names.get(final.winner) };
      else if (groups.length === 1) champion = groups[0].standings[0];
    }

    const access = await accessFields(q, t, actor);
    const confirmed = entries.filter((e) => e.confirmed).length;
    return {
      id: t.id,
      name: t.name,
      venue: t.venue,
      status: t.status,
      format: t.format,
      formatName: FORMATS[t.format],
      createdAt: t.created_at,
      sport: { id: t.sportDef.id, name: t.sportDef.name },
      config: t.config,
      visibility: t.visibility,
      entriesOpen: entriesOpen(t),
      // Only the organiser's own maximum is shown publicly, never the plan limit.
      placesLeft: t.config.maxEntries ? Math.max(0, t.config.maxEntries - confirmed) : null,
      plan: t.plan,
      ...(access.can.manage && { limits: { entries: billingConfig().enabled && t.plan !== 'pass' ? billingConfig().freeLimit : null } }),
      ...access,
      entries: entries.map((e) => ({
        id: e.id,
        name: e.name,
        seed: e.seed,
        group: e.group_no,
        checkedIn: e.checked_in,
        inDraw: e.in_draw,
        withdrawn: e.withdrawn,
        source: e.source,
        confirmed: e.confirmed,
        ...(access.can.manage && { contact: e.contact }), // contact details: organisers only
      })),
      groups,
      matches,
      champion: champion && { id: champion.id, name: champion.name },
    };
  }

  // Viewer-specific fields. Public (cacheable) views pass no actor.
  async function accessFields(q, t, actor) {
    if (!actor) return { role: null, can: { score: false, manage: false, delete: false, own: false, claim: false } };
    const { role, ...can } = await accessOf(q, t, actor);
    return {
      role,
      can,
      // Share links are only shown to people who could hand them out anyway.
      links: can.manage ? { organiser: t.admin_key, scorer: t.scorer_key } : null,
    };
  }

  async function singleMatchView(q, t, matchId) {
    const [row] = await q('SELECT * FROM matches WHERE id = $1', [matchId]);
    return viewOfRow(q, t, row);
  }

  // View of a match row we already have, looking up just its two names.
  async function viewOfRow(q, t, row) {
    const ids = [row.a_id, row.b_id].filter((x) => x != null);
    const rows = ids.length ? await q('SELECT id, name FROM entries WHERE id = ANY($1::int[])', [ids]) : [];
    return matchView(t, row, scoreOf(t, row), new Map(rows.map((e) => [e.id, e.name])));
  }

  // Scoring requests carry the rally count the device saw (`at`), so a retry
  // or a second device can never apply a point to a different score.
  function checkAt(m, at) {
    if (at === undefined || at === null) return;
    if (!Number.isInteger(at) || at !== m.rallies.length) {
      fail(409, 'The score was changed on another device — showing the latest score', 'stale');
    }
  }

  // ---------- tournaments

  async function listTournaments() {
    const rows = await db.query(`
      SELECT t.id, t.name, t.venue, t.sport, t.format, t.status, t.created_at AS "createdAt",
             (SELECT COUNT(*)::int FROM entries e WHERE e.tournament_id = t.id) AS entries
      FROM tournaments t WHERE t.visibility = 'public' ORDER BY t.created_at DESC, t.id LIMIT 100`);
    return rows.map((r) => ({ ...r, formatName: FORMATS[r.format] }));
  }

  // Private tournaments are visible to the team only. Anonymous (cacheable)
  // reads of one always fail, so the CDN never holds private data.
  async function requireVisible(q, t, actor) {
    if (t.visibility !== 'private') return;
    if (actor && (await accessOf(q, t, actor)).score) return;
    fail(404, 'This tournament isn\'t public. Ask the organiser for access.', 'private');
  }

  async function getTournament(id, actor) {
    const t = await load(db.query, id);
    await requireVisible(db.query, t, actor);
    return view(db.query, t, actor);
  }

  async function setVisibility(id, actor, visibility) {
    if (!VISIBILITY.includes(visibility)) fail(400, 'visibility must be "private", "link" or "public"');
    return mutate(id, actor, async (q, t) => {
      await q('UPDATE tournaments SET visibility = $1 WHERE id = $2', [visibility, t.id]);
    }, 'own');
  }

  async function myTournaments(actor) {
    if (!actor.user) fail(401, 'Sign in to see your tournaments');
    const rows = await db.query(
      `SELECT t.id, t.name, t.venue, t.sport, t.format, t.status, t.visibility, t.created_at AS "createdAt", m.role,
              (SELECT COUNT(*)::int FROM entries e WHERE e.tournament_id = t.id) AS entries
       FROM members m JOIN tournaments t ON t.id = m.tournament_id
       WHERE m.email = $1 ORDER BY t.created_at DESC`,
      [actor.user.email],
    );
    return rows.map((r) => ({ ...r, formatName: FORMATS[r.format] }));
  }

  async function createTournament(actor, input = {}) {
    if (!actor.user) fail(401, 'Sign in to create a tournament');
    const name = text(input.name, 'Tournament name');
    const venue = text(input.venue, 'Venue', { optional: true });
    const sport = sports.get(input.sport || 'badminton');
    if (!sport) {
      const info = sports.info(input.sport);
      fail(400, info ? `${info.name} isn't available yet — vote for it on the home page` : 'Unknown sport');
    }
    const format = FORMATS[input.format] ? input.format : 'league_knockout';
    // New tournaments are private until the owner publishes them.
    const visibility = input.visibility ?? 'private';
    if (!VISIBILITY.includes(visibility)) fail(400, 'visibility must be "private", "link" or "public"');
    const config = buildConfig(input, sport);
    checkMaxEntries(config, 'free');
    const id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
    const adminKey = crypto.randomBytes(18).toString('base64url');
    const scorerKey = crypto.randomBytes(18).toString('base64url');
    await db.tx(async (q) => {
      await q(
        `INSERT INTO tournaments (id, name, venue, sport, format, config, admin_key, scorer_key, visibility)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [id, name, venue, sport.id, format, JSON.stringify(config), adminKey, scorerKey, visibility],
      );
      await q(`INSERT INTO members (tournament_id, email, role) VALUES ($1, $2, 'owner')`, [id, actor.user.email]);
    });
    return { id };
  }

  async function updateSettings(id, actor, input = {}) {
    return mutate(id, actor, async (q, t) => {
      if (t.status !== 'setup') {
        // Once started, only the late-entry switch can change.
        const keys = Object.keys(input).filter((k) => input[k] !== undefined);
        if (!keys.length || keys.some((k) => k !== 'lateEntry')) fail(409, 'Settings are locked once the tournament has started');
        const config = { ...t.config, lateEntry: Boolean(input.lateEntry) };
        await q('UPDATE tournaments SET config = $1::jsonb WHERE id = $2', [JSON.stringify(config), t.id]);
        return;
      }
      const name = input.name === undefined ? t.name : text(input.name, 'Tournament name');
      const venue = input.venue === undefined ? t.venue : text(input.venue, 'Venue', { optional: true });
      if (input.format !== undefined && !FORMATS[input.format]) fail(400, 'Unknown format');
      const format = input.format ?? t.format;
      const config = buildConfig(input, t.sportDef, t.config);
      if (input.maxEntries !== undefined) checkMaxEntries(config, t.plan);
      await q('UPDATE tournaments SET name = $1, venue = $2, format = $3, config = $4::jsonb WHERE id = $5', [
        name, venue, format, JSON.stringify(config), t.id,
      ]);
      // A higher (or no) maximum makes room for players who were waiting.
      if (input.maxEntries !== undefined) await confirmWaiting(q, { ...t, config });
    });
  }

  async function deleteTournament(id, actor) {
    return db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, 'delete');
      await q('DELETE FROM members WHERE tournament_id = $1', [t.id]);
      await q('DELETE FROM matches WHERE tournament_id = $1', [t.id]);
      await q('DELETE FROM entries WHERE tournament_id = $1', [t.id]);
      await q('DELETE FROM tournaments WHERE id = $1', [t.id]);
      return { ok: true };
    });
  }

  // ---------- entries

  function requireSetup(t) {
    if (t.status !== 'setup') fail(409, 'Entries are locked once the tournament has started');
  }

  async function addEntries(id, actor, names, { walkIn = false } = {}) {
    if (!Array.isArray(names)) fail(400, 'names must be a list');
    const clean = names.map((n) => (typeof n === 'string' ? n.trim().replace(/\s+/g, ' ') : '')).filter(Boolean);
    if (!clean.length) fail(400, 'Enter at least one name');
    return mutate(id, actor, async (q, t) => {
      requireSetup(t);
      const existing = await entriesOf(q, t.id);
      if (existing.length + clean.length > MAX_ENTRIES) fail(400, `A tournament can have at most ${MAX_ENTRIES} entries`);
      await checkEntryLimit(q, t, clean.length);
      const seen = new Set(existing.map((e) => e.name.toLowerCase()));
      for (const n of clean) {
        if (n.length > 60) fail(400, `"${n.slice(0, 20)}…" is too long (max 60 characters)`);
        if (seen.has(n.toLowerCase())) fail(400, `"${n}" is already entered`);
        seen.add(n.toLowerCase());
      }
      let seed = existing.reduce((max, e) => Math.max(max, e.seed), 0);
      // Walk-ins added on the day are checked in straight away.
      for (const n of clean) {
        await insertEntry(q, t, { name: n, seed: ++seed, source: walkIn ? 'walk-in' : 'organiser', checkedIn: Boolean(walkIn) });
      }
    });
  }

  function contactOf(value) {
    const s = text(value, 'Phone or email', { max: 120 });
    if (s.includes('@')) {
      const email = normalizeEmail(s);
      if (!validEmail(email)) fail(400, 'Enter a valid phone number or email');
      return email;
    }
    const phone = s.replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 7) fail(400, 'Enter a valid phone number or email');
    return phone;
  }

  // Public self-entry ("Enter this tournament"). No account needed; one entry
  // per phone/email; closes at the deadline or when the draw is made. Past the
  // tournament's capacity the entry is saved unconfirmed, and the owner is
  // emailed (once) that players are waiting.
  async function register(id, input = {}, { baseUrl } = {}) {
    if (given(input.website)) return { ok: true }; // honeypot: bots fill every field
    const player = text(input.name, 'Your name', { max: 40 });
    const partner = text(input.partner, 'Partner name', { max: 40, optional: true });
    const name = partner ? `${player} / ${partner}` : player;
    const contact = contactOf(input.contact);
    const result = await db.tx(async (q) => {
      const t = await load(q, id, { lock: true });
      await requireVisible(q, t, null);
      if (t.status !== 'setup') fail(409, 'Entries are closed — the draw has been made');
      if (!t.config.selfEntry) fail(409, 'This tournament doesn\'t take entries online — contact the organiser');
      if (!entriesOpen(t)) fail(409, 'Entries are closed');
      const existing = await entriesOf(q, t.id);
      if (existing.length >= MAX_ENTRIES) fail(409, 'This tournament is full');
      if (existing.some((e) => e.contact === contact)) fail(409, 'This phone number or email has already been used to enter');
      if (existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) fail(409, `"${name}" is already entered`);
      const seed = existing.reduce((max, e) => Math.max(max, e.seed), 0) + 1;
      const confirmed = existing.filter((e) => e.confirmed).length < capacity(t);
      await insertEntry(q, t, { name, seed, source: 'self', contact, confirmed });
      let owners = [];
      if (!confirmed && !t.waiting_notified) {
        await q('UPDATE tournaments SET waiting_notified = true WHERE id = $1', [t.id]);
        owners = (await q(`SELECT email FROM members WHERE tournament_id = $1 AND role = 'owner'`, [t.id])).map((r) => r.email);
      }
      return { t, name, confirmed, owners };
    });
    const { t, name: entered, confirmed, owners } = result;
    if (owners.length && mailer?.enabled && baseUrl) {
      try {
        for (const to of owners) {
          await mailer.send({ to, ...waitingEmail({ tournament: t.name, player: entered, url: `${baseUrl}/#/t/${t.id}/entries` }) });
        }
      } catch (err) {
        console.error('Waiting-entries email failed:', err.message);
      }
    }
    return { ok: true, name: entered, confirmed };
  }

  // The organiser lets a waiting self-entry in (within their plan's limit).
  async function confirmEntry(id, actor, entryId) {
    return mutate(id, actor, async (q, t) => {
      requireSetup(t);
      const [e] = await q('SELECT confirmed FROM entries WHERE id = $1 AND tournament_id = $2', [Number(entryId) || 0, t.id]);
      if (!e) fail(404, 'Entry not found');
      if (e.confirmed) return;
      await checkEntryLimit(q, t, 1);
      await q('UPDATE entries SET confirmed = true WHERE id = $1', [Number(entryId)]);
    });
  }

  async function checkIn(id, actor, entryId, here = true) {
    return mutate(id, actor, async (q, t) => {
      requireSetup(t);
      const rows = await q('UPDATE entries SET checked_in = $1 WHERE id = $2 AND tournament_id = $3 RETURNING id', [
        Boolean(here), Number(entryId) || 0, t.id,
      ]);
      if (!rows.length) fail(404, 'Entry not found');
    });
  }

  async function checkInAll(id, actor, here = true) {
    return mutate(id, actor, async (q, t) => {
      requireSetup(t);
      await q('UPDATE entries SET checked_in = $1 WHERE tournament_id = $2', [Boolean(here), t.id]);
    });
  }

  async function removeEntry(id, actor, entryId) {
    return mutate(id, actor, async (q, t) => {
      requireSetup(t);
      const deleted = await q('DELETE FROM entries WHERE id = $1 AND tournament_id = $2 RETURNING id', [Number(entryId) || 0, t.id]);
      if (!deleted.length) fail(404, 'Entry not found');
    });
  }

  async function reorderEntries(id, actor, ids) {
    return mutate(id, actor, async (q, t) => {
      requireSetup(t);
      const current = (await entriesOf(q, t.id)).map((e) => e.id);
      const wanted = Array.isArray(ids) ? ids.map(Number) : [];
      if (wanted.length !== current.length || new Set(wanted).size !== wanted.length || !wanted.every((x) => current.includes(x))) {
        fail(400, 'ids must list every entry exactly once');
      }
      for (const [i, eid] of wanted.entries()) {
        await q('UPDATE entries SET seed = $1 WHERE id = $2 AND tournament_id = $3', [i + 1, eid, t.id]);
      }
    });
  }

  // ---------- stages

  async function createBracket(q, t, seeded) {
    const slots = formats.knockoutSlots(seeded);
    const rounds = Math.log2(slots.length);
    t.config = { ...t.config, knockoutRounds: rounds };
    await q('UPDATE tournaments SET config = $1::jsonb WHERE id = $2', [JSON.stringify(t.config), t.id]);
    const byes = [];
    for (let r = 1; r <= rounds; r++) {
      for (let s = 0; s < slots.length >> r; s++) {
        if (r > 1) {
          await insertMatch(q, t, 'knockout', null, r, s, null, null);
          continue;
        }
        const a = slots[2 * s];
        const b = slots[2 * s + 1];
        if (a == null || b == null) {
          await insertMatch(q, t, 'knockout', null, 1, s, a, b, 'bye', a ?? b);
          byes.push({ round: 1, slot: s, winner: a ?? b });
        } else {
          await insertMatch(q, t, 'knockout', null, 1, s, a, b);
        }
      }
    }
    for (const bye of byes) await advance(q, t, bye, bye.winner);
  }

  async function advance(q, t, m, winnerId) {
    const next = await koMatch(q, t, m.round + 1, m.slot >> 1);
    const [row] = await q(`UPDATE matches SET ${nextSlotColumn(m)} = $1 WHERE id = $2 RETURNING *`, [winnerId, next.id]);
    await settleWalkover(q, t, row);
  }

  // Ends a match as a walkover (no play) and moves the winner on.
  async function finishWalkover(q, t, m, winnerId) {
    await q(`UPDATE matches SET status = 'done', walkover = true, winner_id = $1, updated_at = now() WHERE id = $2`, [winnerId, m.id]);
    if (m.stage !== 'knockout') return;
    if (m.round === t.config.knockoutRounds) await setStatus(q, t, 'completed');
    else await advance(q, t, m, winnerId);
  }

  // When both sides of a knockout match are known and one has withdrawn, the
  // other goes through.
  async function settleWalkover(q, t, m) {
    if (m.status !== 'scheduled' && m.status !== 'live') return;
    if (m.a_id == null || m.b_id == null) return;
    const out = await q('SELECT id FROM entries WHERE id = ANY($1::int[]) AND withdrawn', [[m.a_id, m.b_id]]);
    if (!out.length) return;
    const gone = new Set(out.map((r) => r.id));
    await finishWalkover(q, t, m, gone.has(m.a_id) ? m.b_id : m.a_id);
  }

  async function start(id, actor, { skipUnconfirmed = false } = {}) {
    return mutate(id, actor, async (q, t) => {
      if (t.status !== 'setup') fail(409, 'The tournament has already started');
      // Unconfirmed self-entries are never drawn; the organiser has to decide
      // about them first so nobody is left out by accident.
      const everyone = await entriesOf(q, t.id);
      const waiting = everyone.filter((e) => !e.confirmed).length;
      if (waiting && !skipUnconfirmed) {
        fail(409, `${waiting} ${waiting === 1 ? 'entry is' : 'entries are'} still unconfirmed — confirm or remove them first`, 'unconfirmed');
      }
      // If anyone has been checked in, only checked-in entries are drawn.
      const all = everyone.filter((e) => e.confirmed);
      const usingCheckIn = all.some((e) => e.checked_in);
      const entries = usingCheckIn ? all.filter((e) => e.checked_in) : all;
      await q('UPDATE entries SET in_draw = confirmed AND (checked_in OR NOT $2), withdrawn = false WHERE tournament_id = $1', [t.id, usingCheckIn]);
      if (t.format === 'knockout') {
        if (entries.length < 2) fail(400, 'Add at least 2 entries to start');
        await createBracket(q, t, entries.map((e) => ({ id: e.id, group: null, tier: 0 })));
        await setStatus(q, t, 'knockout');
        return;
      }
      if (entries.length < 2) fail(400, usingCheckIn ? 'Check in at least 2 entries to start' : 'Add at least 2 entries to start');
      const groups = groupsFor(t, entries.length);
      const { qualifiers } = t.config;
      t.config = { ...t.config, groups };
      await q('UPDATE tournaments SET config = $1::jsonb WHERE id = $2', [JSON.stringify(t.config), t.id]);
      if (entries.length < groups * 2) {
        fail(400, `${groups} group${groups > 1 ? 's need' : ' needs'} at least ${groups * 2} entries (you have ${entries.length})`);
      }
      if (t.format === 'league_knockout') {
        const smallest = Math.floor(entries.length / groups);
        if (qualifiers > smallest) fail(400, `The smallest group has ${smallest} entries, so at most ${smallest} can qualify from each group`);
        if (groups * qualifiers < 2) fail(400, 'At least 2 entries must qualify for the knockout');
      }
      const draw = formats.snakeGroups(entries.map((e) => e.id), groups);
      for (const [g, ids] of draw.entries()) {
        for (const eid of ids) await q('UPDATE entries SET group_no = $1 WHERE id = $2', [g, eid]);
        for (const [r, pairs] of formats.roundRobin(ids).entries()) {
          for (const [slot, [a, b]] of pairs.entries()) await insertMatch(q, t, 'league', g, r + 1, slot, a, b);
        }
      }
      await setStatus(q, t, 'league');
    });
  }

  async function startKnockout(id, actor) {
    return mutate(id, actor, async (q, t) => {
      if (t.format !== 'league_knockout' || t.status !== 'league') fail(409, 'The knockout stage cannot be started now');
      const pending = await pendingLeague(q, t);
      if (pending) fail(409, `${pending} league match${pending > 1 ? 'es are' : ' is'} still to be played`);
      const { groups } = await view(q, t);
      const seeded = [];
      for (let tier = 0; tier < t.config.qualifiers; tier++) {
        for (const g of groups) {
          const row = g.standings.filter((r) => !r.withdrawn)[tier]; // withdrawn players don't qualify
          if (row) seeded.push({ id: row.id, group: g.no, tier });
        }
      }
      if (seeded.length < 2) fail(409, 'Not enough players left to make a knockout');
      await createBracket(q, t, seeded);
      await setStatus(q, t, 'knockout');
    });
  }

  // Undo the draw (e.g. more players turned up) while no point has been played.
  async function redraw(id, actor) {
    return mutate(id, actor, async (q, t) => {
      if (t.status === 'setup') fail(409, 'The draw hasn\'t been made yet');
      if (t.status === 'completed' || (t.format === 'league_knockout' && t.status === 'knockout')) {
        fail(409, 'The draw can only be redone before the first point is played');
      }
      const [{ n }] = await q(
        `SELECT COUNT(*)::int AS n FROM matches WHERE tournament_id = $1 AND (rallies <> '' OR walkover)`,
        [t.id],
      );
      if (n) fail(409, 'Play has started — the draw can only be redone before the first point');
      await q('DELETE FROM matches WHERE tournament_id = $1', [t.id]);
      await q('UPDATE entries SET group_no = NULL, in_draw = true WHERE tournament_id = $1', [t.id]);
      const { knockoutRounds: _r, ...config } = t.config;
      await q('UPDATE tournaments SET config = $1::jsonb WHERE id = $2', [JSON.stringify(config), t.id]);
      await setStatus(q, t, 'setup');
    });
  }

  // Add a player after the start (only if the organiser allows late entries).
  // Groups: joins the smallest group with catch-up matches against everyone in
  // it. Knockout: takes a first-round bye slot.
  async function lateEntry(id, actor, input = {}) {
    const name = text(input.name, 'Name', { max: 60 });
    return mutate(id, actor, async (q, t) => {
      if (t.status === 'setup') fail(409, 'The draw hasn\'t been made yet — just add them to the entries');
      if (t.status === 'completed') fail(409, 'The tournament has finished');
      if (!t.config.lateEntry) fail(409, 'Late entries are switched off for this tournament', 'late_off');
      const all = await entriesOf(q, t.id);
      if (all.length >= MAX_ENTRIES) fail(409, `A tournament can have at most ${MAX_ENTRIES} entries`);
      if (all.some((e) => e.name.toLowerCase() === name.toLowerCase())) fail(400, `"${name}" is already entered`);
      await checkEntryLimit(q, t, 1);
      const seed = all.reduce((max, e) => Math.max(max, e.seed), 0) + 1;

      if (t.status === 'league') {
        const done = new Map(
          (await q(
            `SELECT group_no, COUNT(*)::int AS n FROM matches WHERE tournament_id = $1 AND stage = 'league' AND status = 'done' GROUP BY group_no`,
            [t.id],
          )).map((r) => [r.group_no, r.n]),
        );
        const groups = Array.from({ length: t.config.groups }, (_, g) => ({
          g,
          members: all.filter((e) => e.group_no === g && e.in_draw),
        }));
        const active = (x) => x.members.filter((e) => !e.withdrawn).length;
        groups.sort((x, y) => active(x) - active(y) || (done.get(x.g) || 0) - (done.get(y.g) || 0) || x.g - y.g);
        const { g, members } = groups[0];
        const [{ id: newId }] = await insertEntry(q, t, { name, seed, group: g, source: 'walk-in', checkedIn: true });
        const [{ last }] = await q(
          `SELECT COALESCE(MAX(round), 0)::int AS last FROM matches WHERE tournament_id = $1 AND stage = 'league' AND group_no = $2`,
          [t.id, g],
        );
        for (const [i, m] of members.entries()) {
          if (m.withdrawn) {
            await insertMatch(q, t, 'league', g, last + i + 1, 0, newId, m.id, 'done', newId, { walkover: true, catchUp: true });
          } else {
            await insertMatch(q, t, 'league', g, last + i + 1, 0, newId, m.id, 'scheduled', null, { catchUp: true });
          }
        }
        return;
      }

      if (t.format !== 'knockout') fail(409, 'The knockout has started — late entries can only join during the group stage');
      const byes = await q(
        `SELECT * FROM matches WHERE tournament_id = $1 AND stage = 'knockout' AND round = 1 AND status = 'bye' ORDER BY slot`,
        [t.id],
      );
      for (const bye of byes) {
        const next = await koMatch(q, t, 2, bye.slot >> 1);
        if (!next || next.rallies || next.status !== 'scheduled') continue;
        const [{ id: newId }] = await insertEntry(q, t, { name, seed, source: 'walk-in', checkedIn: true });
        await q(`UPDATE matches SET ${nextSlotColumn(bye)} = NULL WHERE id = $1`, [next.id]); // undo the bye's advance
        const side = bye.a_id == null ? 'a_id' : 'b_id';
        await q(
          `UPDATE matches SET ${side} = $1, status = 'scheduled', winner_id = NULL, catch_up = true, updated_at = now() WHERE id = $2`,
          [newId, bye.id],
        );
        return;
      }
      fail(409, 'The bracket is full — late entry isn\'t possible');
    });
  }

  // Player pulls out mid-event: their remaining matches become walkovers.
  async function withdraw(id, actor, entryId) {
    return mutate(id, actor, async (q, t) => {
      if (t.status === 'setup') fail(409, 'The draw hasn\'t been made — just remove the entry');
      if (t.status === 'completed') fail(409, 'The tournament has finished');
      const [e] = await q('SELECT * FROM entries WHERE id = $1 AND tournament_id = $2', [Number(entryId) || 0, t.id]);
      if (!e) fail(404, 'Entry not found');
      if (e.withdrawn) fail(409, `${e.name} has already withdrawn`);
      if (!e.in_draw) fail(409, `${e.name} isn't in the draw`);
      await q('UPDATE entries SET withdrawn = true WHERE id = $1', [e.id]);
      const open = await q(
        `SELECT * FROM matches WHERE tournament_id = $1 AND status IN ('scheduled', 'live') AND (a_id = $2 OR b_id = $2)
         ORDER BY stage = 'knockout', round, slot`,
        [t.id, e.id],
      );
      for (const m of open) {
        const other = m.a_id === e.id ? m.b_id : m.a_id;
        if (other != null) await finishWalkover(q, t, m, other); // opponent not known yet: settled when they arrive
      }
      if (t.format === 'league' && t.status === 'league' && (await pendingLeague(q, t)) === 0) await setStatus(q, t, 'completed');
    });
  }

  // ---------- scoring

  function requireStageOpen(t, m) {
    const open = m.stage === 'league' ? t.status === 'league' : t.status === 'knockout';
    if (!open) fail(409, `This ${m.stage} match cannot be played right now`);
  }

  async function rally(id, actor, mid, side, at) {
    if (side !== 'a' && side !== 'b') fail(400, 'side must be "a" or "b"');
    return db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, t, mid);
      if (m.status === 'done' || m.status === 'bye') fail(409, 'This match is already finished');
      if (m.a_id == null || m.b_id == null) fail(409, 'Both players are not known yet');
      requireStageOpen(t, m);
      checkAt(m, at);

      const rallies = m.rallies + side;
      const score = t.sportDef.compute(rallies, t.config.scoring, m.first_server);
      const winnerId = score.winner ? (score.winner === 'a' ? m.a_id : m.b_id) : null;
      const [row] = await q(
        `UPDATE matches SET rallies = $1, status = $2, winner_id = $3, updated_at = now() WHERE id = $4 RETURNING *`,
        [rallies, winnerId ? 'done' : 'live', winnerId, m.id],
      );
      if (winnerId) {
        if (m.stage === 'knockout') {
          if (m.round === t.config.knockoutRounds) await setStatus(q, t, 'completed');
          else await advance(q, t, m, winnerId);
        } else if (t.format === 'league' && (await pendingLeague(q, t)) === 0) {
          await setStatus(q, t, 'completed');
        }
      }
      return viewOfRow(q, t, row);
    });
  }

  // Removes the last rally. Undoing the winning point reopens the match, as
  // long as nothing downstream has started yet.
  async function undo(id, actor, mid, at) {
    return db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, t, mid);
      if (m.walkover) fail(409, 'Walkovers can\'t be undone');
      if (m.status === 'bye' || !m.rallies) fail(409, 'Nothing to undo');
      checkAt(m, at);
      if (m.status === 'done' && m.stage === 'league') {
        if (t.status === 'knockout' || (t.status === 'completed' && t.format === 'league_knockout')) {
          fail(409, 'League results are locked because the knockout has started');
        }
        if (t.status === 'completed') await setStatus(q, t, 'league');
      } else if (m.status === 'done') {
        if (m.round < t.config.knockoutRounds) {
          const next = await koMatch(q, t, m.round + 1, m.slot >> 1);
          if (next.rallies || next.status === 'done') fail(409, 'The next-round match has already started');
          await q(`UPDATE matches SET ${nextSlotColumn(m)} = NULL, status = 'scheduled' WHERE id = $1`, [next.id]);
        }
        if (t.status === 'completed') await setStatus(q, t, 'knockout');
      }
      const [row] = await q(
        `UPDATE matches SET rallies = $1, status = 'live', winner_id = NULL, updated_at = now() WHERE id = $2 RETURNING *`,
        [m.rallies.slice(0, -1), m.id],
      );
      return viewOfRow(q, t, row);
    });
  }

  // Court, first server, and marking a match as on court before the first rally.
  async function updateMatch(id, actor, mid, input = {}) {
    return db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, t, mid);
      if (m.status === 'bye') fail(409, 'Byes cannot be edited');
      const court = input.court === undefined ? m.court : text(input.court, 'Court', { max: 20, optional: true });
      let firstServer = m.first_server;
      if (input.firstServer !== undefined) {
        if (input.firstServer !== 'a' && input.firstServer !== 'b') fail(400, 'firstServer must be "a" or "b"');
        if (m.rallies) fail(409, 'The first server can only be changed before the first rally');
        firstServer = input.firstServer;
      }
      let status = m.status;
      if (input.status === 'live' && m.status === 'scheduled') {
        if (m.a_id == null || m.b_id == null) fail(409, 'Both players are not known yet');
        requireStageOpen(t, m);
        status = 'live';
      } else if (input.status === 'scheduled' && m.status === 'live' && !m.rallies) {
        status = 'scheduled';
      }
      await q(`UPDATE matches SET court = $1, first_server = $2, status = $3, updated_at = now() WHERE id = $4`, [
        court, firstServer, status, m.id,
      ]);
      return singleMatchView(q, t, m.id);
    });
  }

  // ---------- payments (Event Pass via Razorpay)

  const razorpay = (cfg) => createRazorpay({ keyId: cfg.keyId, keySecret: cfg.keySecret, fetchImpl });

  // Step 1: create a Razorpay order for this tournament's Event Pass.
  async function checkout(id, actor) {
    const cfg = billingConfig();
    if (!cfg.enabled) fail(503, 'Payments aren\'t set up yet');
    const { t, paymentId } = await db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, 'manage');
      if (t.plan === 'pass') fail(409, 'This tournament already has the Event Pass');
      const [row] = await q(
        `INSERT INTO payments (tournament_id, tournament_name, user_email, amount, currency)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [t.id, t.name, actor.user?.email ?? null, cfg.price, cfg.currency],
      );
      return { t, paymentId: row.id };
    });
    let order;
    try {
      order = await razorpay(cfg).createOrder({
        amount: cfg.price,
        currency: cfg.currency,
        receipt: `tn_${paymentId}`,
        notes: { tournament_id: t.id, tournament: t.name.slice(0, 200), email: actor.user?.email ?? '' },
      });
    } catch (err) {
      console.error('Razorpay order failed:', err.message);
      await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
      fail(502, 'Couldn\'t start the payment — please try again in a moment');
    }
    await db.query('UPDATE payments SET order_id = $1 WHERE id = $2', [order.id, paymentId]);
    return {
      orderId: order.id,
      keyId: cfg.keyId,
      amount: cfg.price,
      currency: cfg.currency,
      name: cfg.business.name || 'Tonament',
      description: `Event Pass — ${t.name}`,
      prefill: { name: actor.user?.name ?? '', email: actor.user?.email ?? '' },
    };
  }

  // Marks an order paid and activates the Pass, once. Returns the payment row
  // and whether this call did the activation (so the receipt is sent once).
  async function markPaid(orderId, paymentId, rawEvent) {
    return db.tx(async (q) => {
      const [p] = await q('SELECT * FROM payments WHERE order_id = $1 FOR UPDATE', [orderId]);
      if (!p) return { payment: null, activated: false };
      if (p.status === 'paid') return { payment: p, activated: false };
      const [paid] = await q(
        `UPDATE payments SET status = 'paid', payment_id = $1, paid_at = now(), raw_event = $2::jsonb WHERE id = $3 RETURNING *`,
        [paymentId, JSON.stringify(rawEvent ?? null), p.id],
      );
      if (p.tournament_id) {
        await q(`UPDATE tournaments SET plan = 'pass', plan_updated_at = now() WHERE id = $1`, [p.tournament_id]);
        const [t] = await q('SELECT * FROM tournaments WHERE id = $1 FOR UPDATE', [p.tournament_id]);
        if (t) await confirmWaiting(q, t);
      }
      return { payment: paid, activated: true };
    });
  }

  async function sendReceipt(payment, baseUrl) {
    if (!payment?.user_email || !mailer?.enabled || !baseUrl) return;
    const cfg = billingConfig();
    try {
      await mailer.send({
        to: payment.user_email,
        ...receiptEmail({
          business: cfg.business,
          tournament: payment.tournament_name,
          amount: payment.amount,
          currency: payment.currency,
          paymentId: payment.payment_id,
          paidAt: payment.paid_at,
          url: `${baseUrl}/#/t/${payment.tournament_id}`,
        }),
      });
    } catch (err) {
      console.error('Receipt email failed:', err.message);
    }
  }

  // Step 2: the browser reports success; trust it only after checking the
  // signature and the payment itself with Razorpay.
  async function verifyPayment(input = {}, { baseUrl } = {}) {
    const cfg = billingConfig();
    if (!cfg.enabled) fail(503, 'Payments aren\'t set up yet');
    const orderId = typeof input.razorpay_order_id === 'string' ? input.razorpay_order_id : '';
    const paymentId = typeof input.razorpay_payment_id === 'string' ? input.razorpay_payment_id : '';
    const signature = typeof input.razorpay_signature === 'string' ? input.razorpay_signature : '';
    const [row] = await db.query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
    if (!row) fail(404, 'Payment not found');
    if (!verifyPaymentSignature({ orderId, paymentId, signature }, cfg.keySecret)) {
      fail(400, 'We couldn\'t verify this payment. If money was taken, contact us with your payment ID.');
    }
    if (row.status !== 'paid') {
      let p = await razorpay(cfg).fetchPayment(paymentId);
      if (p.order_id !== orderId || p.amount !== row.amount || p.currency !== row.currency) {
        fail(400, 'Payment details don\'t match this order. Contact us with your payment ID.');
      }
      if (p.status === 'authorized') p = await razorpay(cfg).capture(paymentId, row.amount, row.currency);
      if (p.status !== 'captured') fail(402, 'The payment hasn\'t completed yet. If money was taken, it will be confirmed shortly.');
    }
    const { payment, activated } = await markPaid(orderId, paymentId, { source: 'checkout', paymentId });
    if (activated) await sendReceipt(payment, baseUrl);
    return { ok: true, tournamentId: row.tournament_id, plan: 'pass' };
  }

  // Step 3 (backstop): Razorpay webhooks, verified against the raw body.
  async function razorpayWebhook(rawBody, signature, { baseUrl } = {}) {
    const cfg = billingConfig();
    if (!cfg.webhookSecret) fail(503, 'Webhook secret not configured');
    if (!verifyWebhookSignature(rawBody, signature || '', cfg.webhookSecret)) fail(400, 'Invalid signature');
    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      fail(400, 'Invalid JSON');
    }
    const pay = event?.payload?.payment?.entity;
    const order = event?.payload?.order?.entity;
    const orderId = pay?.order_id || order?.id;
    if (!orderId) return { ok: true, ignored: true };
    const [row] = await db.query('SELECT * FROM payments WHERE order_id = $1', [orderId]);
    if (!row) return { ok: true, ignored: true }; // not one of ours
    if (event.event === 'payment.captured' || event.event === 'order.paid') {
      if (pay && (pay.amount !== row.amount || pay.currency !== row.currency)) return { ok: true, ignored: true };
      const { payment, activated } = await markPaid(orderId, pay?.id ?? row.payment_id, event);
      if (activated) await sendReceipt(payment, baseUrl);
    } else if (event.event === 'payment.failed') {
      await db.query(`UPDATE payments SET status = 'failed', raw_event = $1::jsonb WHERE id = $2 AND status = 'created'`, [
        JSON.stringify(event), row.id,
      ]);
    }
    return { ok: true };
  }

  function requireSiteAdmin(actor) {
    if (!actor.user?.isAdmin) fail(actor.user ? 403 : 401, 'Site admins only');
  }

  // Manual switch (refunds, promotions, support).
  async function adminSetPlan(id, actor, plan) {
    requireSiteAdmin(actor);
    if (plan !== 'pass' && plan !== 'free') fail(400, 'plan must be "pass" or "free"');
    return mutate(id, actor, async (q, t) => {
      await q('UPDATE tournaments SET plan = $1, plan_updated_at = now() WHERE id = $2', [plan, t.id]);
      if (plan === 'pass') await confirmWaiting(q, { ...t, plan });
    });
  }

  async function adminPayments(actor) {
    requireSiteAdmin(actor);
    const rows = await db.query(
      `SELECT p.id, p.tournament_id AS "tournamentId", p.tournament_name AS "tournamentName", p.user_email AS "email",
              p.order_id AS "orderId", p.payment_id AS "paymentId", p.amount, p.currency, p.status,
              p.created_at AS "createdAt", p.paid_at AS "paidAt", t.plan
       FROM payments p LEFT JOIN tournaments t ON t.id = p.tournament_id
       ORDER BY p.created_at DESC LIMIT 300`,
    );
    const [{ total, count }] = await db.query(
      `SELECT COALESCE(SUM(amount), 0)::int AS total, COUNT(*)::int AS count FROM payments WHERE status = 'paid'`,
    );
    return { payments: rows, revenue: { total, count, currency: billingConfig().currency } };
  }

  // ---------- sport requests ("Request this sport" votes)

  async function sportInterest(actor = {}) {
    const rows = await db.query('SELECT sport, COUNT(*)::int AS n FROM sport_interest GROUP BY sport');
    const mine = actor.user
      ? (await db.query('SELECT sport FROM sport_interest WHERE user_id = $1', [actor.user.id])).map((r) => r.sport)
      : [];
    return { counts: Object.fromEntries(rows.map((r) => [r.sport, r.n])), mine };
  }

  async function setSportInterest(actor, sportId, want) {
    if (!actor.user) fail(401, 'Sign in to request a sport');
    const info = sports.info(sportId);
    if (!info) fail(404, 'Unknown sport');
    if (info.status === 'live') fail(400, `${info.name} is already available`);
    if (want === false) {
      await db.query('DELETE FROM sport_interest WHERE user_id = $1 AND sport = $2', [actor.user.id, info.id]);
    } else {
      await db.query(
        'INSERT INTO sport_interest (user_id, sport) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [actor.user.id, info.id],
      );
    }
    return sportInterest(actor);
  }

  // ---------- team

  async function membersOf(q, t) {
    const rows = await q(
      `SELECT m.id, m.email, m.role, u.name
       FROM members m LEFT JOIN users u ON u.email = m.email
       WHERE m.tournament_id = $1
       ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'organiser' THEN 1 ELSE 2 END, m.created_at`,
      [t.id],
    );
    return rows.map((r) => ({ ...r, roleName: ROLES[r.role], joined: r.name != null }));
  }

  async function listMembers(id, actor) {
    return db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, 'manage');
      return membersOf(q, t);
    });
  }

  // Adds someone by email, or changes their role. They get access as soon as
  // they sign up (or sign in) with that email, and are told by email when
  // email is set up. Returns { members, emailed }.
  async function addMember(id, actor, input = {}, { baseUrl } = {}) {
    const email = normalizeEmail(input.email);
    if (!validEmail(email)) fail(400, 'Enter a valid email address');
    if (input.role !== 'organiser' && input.role !== 'umpire') fail(400, 'Role must be organiser or umpire');
    const { t, members, changed, hasAccount } = await db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, 'manage');
      const [existing] = await q('SELECT role FROM members WHERE tournament_id = $1 AND email = $2', [t.id, email]);
      if (existing?.role === 'owner') fail(409, 'That person is the owner');
      await q(
        `INSERT INTO members (tournament_id, email, role) VALUES ($1, $2, $3)
         ON CONFLICT (tournament_id, email) DO UPDATE SET role = EXCLUDED.role`,
        [t.id, email, input.role],
      );
      const [account] = await q('SELECT 1 FROM users WHERE email = $1', [email]);
      return { t, members: await membersOf(q, t), changed: existing?.role !== input.role, hasAccount: Boolean(account) };
    });

    let emailed = false;
    if (changed && mailer?.enabled && baseUrl && email !== actor.user?.email) {
      const next = `/t/${t.id}`;
      const url = hasAccount
        ? `${baseUrl}/#/signin?next=${encodeURIComponent(next)}&email=${encodeURIComponent(email)}`
        : `${baseUrl}/#/signup?next=${encodeURIComponent(next)}&email=${encodeURIComponent(email)}`;
      const roleHint = input.role === 'umpire' ? 'you can score matches' : 'you can manage the tournament';
      try {
        await mailer.send({
          to: email,
          ...inviteEmail({ inviter: actor.user?.name, tournament: t.name, roleName: ROLES[input.role], roleHint, url, hasAccount }),
        });
        emailed = true;
      } catch (err) {
        console.error('Invite email failed:', err.message);
      }
    }
    return { members, emailed };
  }

  async function removeMember(id, actor, memberId) {
    return db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, 'manage');
      const [m] = await q('SELECT * FROM members WHERE id = $1 AND tournament_id = $2', [Number(memberId) || 0, t.id]);
      if (!m) fail(404, 'Member not found');
      if (m.role === 'owner') fail(409, 'The owner cannot be removed');
      await q('DELETE FROM members WHERE id = $1', [m.id]);
      return membersOf(q, t);
    });
  }

  // Tournaments created before accounts existed have no owner; whoever holds
  // the organiser link can attach it to their account.
  async function claim(id, actor) {
    return db.tx(async (q) => {
      const t = await load(q, id, { lock: true });
      const access = await accessOf(q, t, actor);
      if (!access.claim) fail(403, 'This tournament cannot be claimed');
      await q(
        `INSERT INTO members (tournament_id, email, role) VALUES ($1, $2, 'owner')
         ON CONFLICT (tournament_id, email) DO UPDATE SET role = 'owner'`,
        [t.id, actor.user.email],
      );
      return view(q, t, actor);
    });
  }

  return {
    checkout,
    verifyPayment,
    razorpayWebhook,
    adminSetPlan,
    adminPayments,
    sportInterest,
    setSportInterest,
    myTournaments,
    listMembers,
    addMember,
    removeMember,
    claim,
    listTournaments,
    getTournament,
    setVisibility,
    createTournament,
    updateSettings,
    deleteTournament,
    addEntries,
    register,
    confirmEntry,
    checkIn,
    checkInAll,
    redraw,
    lateEntry,
    withdraw,
    removeEntry,
    reorderEntries,
    start,
    startKnockout,
    rally,
    undo,
    updateMatch,
  };
}

module.exports = { createService, HttpError };
