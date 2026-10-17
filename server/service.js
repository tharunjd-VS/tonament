'use strict';

const crypto = require('node:crypto');
const sports = require('./sports');
const formats = require('./formats');
const regions = require('../public/regions');
const catalog = require('../public/sports/events');
const { HttpError } = require('./errors');
const { normalizeEmail, validEmail } = require('./auth');
const { inviteEmail, receiptEmail, entryReceiptEmail, waitingEmail } = require('./email');
const { TIERS, PLAN_NAMES, billingConfig, createRazorpay, verifyPaymentSignature, verifyWebhookSignature } = require('./billing');

const FORMATS = {
  league_knockout: 'League + Knockout',
  league: 'League',
  knockout: 'Knockout',
};
const MAX_ENTRIES = 128;
const VISIBILITY = ['private', 'link', 'public'];
// Settings that belong to the tournament as a whole; everything else in a
// config (format details, scoring, caps) belongs to each event.
const TOURNAMENT_KEYS = ['selfEntry', 'entriesCloseAt'];
const EVENT_KEYS = ['format', 'groups', 'groupSize', 'qualifiers', 'scoring', 'maxEntries', 'lateEntry', 'fee', 'discipline', 'gender', 'age', 'level'];
const eventConfigOf = (config) => Object.fromEntries(Object.entries(config).filter(([k]) => !TOURNAMENT_KEYS.includes(k)));

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

// "new  delhi" -> "New Delhi", so the same city always groups together.
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isoDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const ok = typeof value === 'string' && ISO_DATE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
  if (!ok) fail(400, `${label}: enter a valid date`);
  return value;
}
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Venue, location and dates (all optional). Fields not sent keep their value.
const DETAIL_KEYS = ['venue', 'address', 'city', 'region', 'postcode', 'country', 'startsOn', 'endsOn'];
function detailsOf(input, prev = {}) {
  const pick = (key, col, label, max) => (input[key] === undefined ? prev[col] ?? null : text(input[key], label, { max, optional: true }));
  const d = {
    venue: pick('venue', 'venue', 'Venue', 80),
    address: pick('address', 'address', 'Address', 120),
    city: pick('city', 'city', 'City', 60),
    region: pick('region', 'region', 'State', 60),
    postcode: pick('postcode', 'postcode', 'Postcode', 20),
    country: pick('country', 'country', 'Country', 60),
    starts_on: input.startsOn === undefined ? prev.starts_on ?? null : isoDate(input.startsOn, 'Start date'),
    ends_on: input.endsOn === undefined ? prev.ends_on ?? null : isoDate(input.endsOn, 'End date'),
  };
  if (d.city) d.city = titleCase(d.city);
  if (d.country) {
    const listed = regions.countries.find((c) => c.toLowerCase() === d.country.toLowerCase());
    d.country = listed || titleCase(d.country);
    const states = regions.regionsFor(d.country);
    if (states && d.region) {
      const match = states.find((r) => r.toLowerCase() === d.region.toLowerCase());
      if (!match) fail(400, `Choose a state in ${d.country}`);
      d.region = match;
    }
  }
  if (d.ends_on && !d.starts_on) fail(400, 'Add a start date first');
  if (d.ends_on && d.ends_on < d.starts_on) fail(400, 'The end date must be on or after the start date');
  if (d.ends_on === d.starts_on) d.ends_on = null; // a one-day event
  return d;
}
const DETAIL_COLUMNS = ['venue', 'address', 'city', 'region', 'postcode', 'country', 'starts_on', 'ends_on'];
const saveDetails = (q, t, d) =>
  q(`UPDATE tournaments SET ${DETAIL_COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${DETAIL_COLUMNS.length + 1}`, [
    ...DETAIL_COLUMNS.map((c) => d[c]), t.id,
  ]);

// Self-entry is open on the tournament and at least one event hasn't started.
const ENTRIES_OPEN_SQL = `COALESCE((t.config->>'selfEntry')::boolean, true)
  AND (t.config->>'entriesCloseAt' IS NULL OR (t.config->>'entriesCloseAt')::timestamptz > now())
  AND EXISTS (SELECT 1 FROM events ev WHERE ev.tournament_id = t.id AND ev.status = 'setup')`;

// Tournament list cards (home page search and "My tournaments").
const CARD_COLUMNS = `t.id, t.name, t.venue, t.sport, t.format, t.status, t.visibility, t.created_at AS "createdAt",
  t.city, t.region, t.country, t.starts_on AS "startsOn", t.ends_on AS "endsOn",
  (${ENTRIES_OPEN_SQL}) AS "entriesOpen",
  (SELECT COUNT(*)::int FROM entries e WHERE e.tournament_id = t.id) AS entries,
  (SELECT COALESCE(json_agg(json_build_object('discipline', ev.discipline, 'gender', ev.gender, 'age', ev.age, 'level', ev.level, 'name', ev.name)
     ORDER BY ev.position, ev.id), '[]') FROM events ev WHERE ev.tournament_id = t.id) AS events`;
// Cards list their events by short name ("MS U19", "XD").
const cardOf = (r) => ({ ...r, formatName: FORMATS[r.format], events: (r.events || []).map((e) => catalog.shortName(e)) });
const WHEN = ['upcoming', 'week', 'month', 'past', 'any'];

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

  const ENTRY_COLUMNS = 'id, event_id, name, seed, group_no, checked_in, in_draw, withdrawn, source, contact, confirmed, fee_status, fee_amount, created_at';

  // Entries and matches of one event (`ev` is an event context, see eventFor).
  const entriesOf = (q, ev) =>
    q(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE event_id = $1 ORDER BY seed, id`, [ev.eventId]);

  const insertEntry = (q, t, { name, seed, group = null, source = 'organiser', checkedIn = false, contact = null, confirmed = true, feeStatus = null, feeAmount = null }) =>
    q(
      `INSERT INTO entries (tournament_id, event_id, name, seed, group_no, source, checked_in, contact, confirmed, fee_status, fee_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [t.id, t.eventId, name, seed, group, source, checkedIn, contact, confirmed, feeStatus, feeAmount],
    );

  // ---------- entry fees (tournaments organised by Tonament only)
  // A paid self-entry is saved as 'pending' and holds its place for
  // PENDING_MINUTES while the player pays; abandoned ones are cleared.
  const PENDING_MINUTES = 30;
  const MAX_FEE = 5000000; // paise (₹50,000)
  const feeOf = (ev) => (ev.official && ev.config.fee > 0 ? ev.config.fee : 0);
  const HOLDS_PLACE = `(confirmed OR (fee_status = 'pending' AND created_at > now() - interval '${PENDING_MINUTES} minutes'))`;
  const clearExpiredPending = (q, ev) =>
    q(`DELETE FROM entries WHERE event_id = $1 AND fee_status = 'pending' AND NOT ${HOLDS_PLACE}`, [ev.eventId]);

  const MATCH_ORDER = `stage = 'knockout', round, group_no, slot, id`;
  const matchesOf = (q, ev) => q(`SELECT * FROM matches WHERE event_id = $1 ORDER BY ${MATCH_ORDER}`, [ev.eventId]);

  // ---------- events
  // An event context is the tournament row plus one event's format, status
  // and config (the tournament-wide self-entry settings merged in), so the
  // draw and scoring code works on "t" just as it did with one draw.

  // A tournament always has at least one event; one made without (e.g. by an
  // older deployment while this one rolled out) gets its catch-all event here.
  async function eventsOf(q, tid) {
    const rows = await q('SELECT * FROM events WHERE tournament_id = $1 ORDER BY position, id', [tid]);
    if (rows.length) return rows;
    await q(
      `INSERT INTO events (tournament_id, format, config, status)
       SELECT id, format, config, status FROM tournaments WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM events WHERE tournament_id = $1)`,
      [tid],
    );
    const created = await q('SELECT * FROM events WHERE tournament_id = $1 ORDER BY position, id', [tid]);
    if (created.length) {
      await q('UPDATE entries SET event_id = $1 WHERE tournament_id = $2 AND event_id IS NULL', [created[0].id, tid]);
      await q('UPDATE matches SET event_id = $1 WHERE tournament_id = $2 AND event_id IS NULL', [created[0].id, tid]);
    }
    return created;
  }

  function eventContext(t, row) {
    const config = { ...row.config };
    for (const k of TOURNAMENT_KEYS) config[k] = t.config[k] ?? (k === 'selfEntry' ? true : null);
    return { ...t, eventId: row.id, event: row, format: row.format, status: row.status, config };
  }

  // The event to act on: the one asked for, or the only one.
  async function eventFor(q, t, eventId) {
    const rows = await eventsOf(q, t.id);
    let row;
    if (given(eventId)) {
      row = rows.find((r) => r.id === Number(eventId));
      if (!row) fail(404, 'Event not found');
    } else if (rows.length === 1) {
      row = rows[0];
    } else {
      fail(400, 'Choose an event', 'event');
    }
    return eventContext(t, row);
  }

  async function eventOfEntry(q, t, entryId) {
    const [r] = await q('SELECT event_id FROM entries WHERE id = $1 AND tournament_id = $2', [Number(entryId) || 0, t.id]);
    if (!r) fail(404, 'Entry not found');
    return eventFor(q, t, r.event_id);
  }

  const eventLabel = (ev) => catalog.eventName(ev.event);

  async function saveEventConfig(q, ev) {
    await q('UPDATE events SET config = $1::jsonb WHERE id = $2', [JSON.stringify(eventConfigOf(ev.config)), ev.eventId]);
  }

  // The tournament's status and format summarise its events: with one event
  // they are that event's; with several, "live" once any has started.
  async function syncTournament(q, tid) {
    const rows = await eventsOf(q, tid);
    if (!rows.length) return;
    let status = rows[0].status;
    if (rows.length > 1) {
      if (rows.every((r) => r.status === 'setup')) status = 'setup';
      else if (rows.every((r) => r.status === 'completed')) status = 'completed';
      else status = 'live';
    }
    await q('UPDATE tournaments SET status = $1, format = $2 WHERE id = $3', [status, rows[0].format, tid]);
  }

  async function matchOf(q, t, mid) { // any event of the tournament
    const [m] = await q('SELECT * FROM matches WHERE id = $1 AND tournament_id = $2', [Number(mid) || 0, t.id]);
    if (!m) fail(404, 'Match not found');
    return m;
  }

  async function koMatch(q, t, round, slot) {
    const [m] = await q(
      `SELECT * FROM matches WHERE event_id = $1 AND stage = 'knockout' AND round = $2 AND slot = $3`,
      [t.eventId, round, slot],
    );
    return m;
  }

  async function pendingLeague(q, t) {
    const [{ n }] = await q(
      `SELECT COUNT(*)::int AS n FROM matches WHERE event_id = $1 AND stage = 'league' AND status <> 'done'`,
      [t.eventId],
    );
    return n;
  }

  const insertMatch = (q, t, stage, group, round, slot, a, b, status = 'scheduled', winner = null, extra = {}) =>
    q(
      `INSERT INTO matches (tournament_id, event_id, stage, group_no, round, slot, a_id, b_id, status, winner_id, walkover, catch_up)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [t.id, t.eventId, stage, group, round, slot, a, b, status, winner, Boolean(extra.walkover), Boolean(extra.catchUp)],
    );

  async function setStatus(q, t, status) {
    await q('UPDATE events SET status = $1 WHERE id = $2', [status, t.eventId]);
    t.status = status;
    await syncTournament(q, t.id);
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

  // The same, for one event (or the event an entry belongs to).
  const mutateEvent = (id, actor, eventId, fn) => mutate(id, actor, async (q, t) => fn(q, await eventFor(q, t, eventId)));
  const mutateEntry = (id, actor, entryId, fn) => mutate(id, actor, async (q, t) => fn(q, await eventOfEntry(q, t, entryId)));

  function eventFields(input, prev) {
    try {
      return catalog.normalize(input, prev);
    } catch (err) {
      return fail(400, err.message);
    }
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
    if (!config.maxEntries || config.maxEntries <= planLimit(plan)) return;
    upgradeError(plan, config.maxEntries, ` in total, so a maximum of ${config.maxEntries} isn't possible yet`);
  }

  const groupsFor = (t, n) => (t.config.groupSize ? formats.groupCount(n, t.config.groupSize) : t.config.groups);

  const confirmedCount = async (q, t) =>
    (await q('SELECT COUNT(*)::int AS n FROM entries WHERE tournament_id = $1 AND confirmed', [t.id]))[0].n;

  // Free plan: up to cfg.freeLimit confirmed entries per tournament (only once
  // Razorpay is configured). Organisers adding players get an upgrade prompt;
  // self-entries over the limit are saved unconfirmed instead (see register).
  async function checkEntryLimit(q, t, adding) {
    const limit = planLimit(t.plan);
    if (!Number.isFinite(limit)) return;
    const n = await confirmedCount(q, t);
    if (n + adding <= limit) return;
    const left = Math.max(0, limit - n);
    upgradeError(t.plan, n + adding, ` per tournament${left ? ` (${left} left)` : ''}`);
  }

  // Confirmed entries the tournament's plan allows, across all its events.
  function planLimit(plan) {
    const cfg = billingConfig();
    if (!cfg.enabled || plan === 'pass') return Infinity;
    return TIERS.find((x) => x.id === plan)?.limit ?? cfg.freeLimit;
  }
  // The smallest paid plan that allows n entries (null if none does).
  const tierFor = (n) => TIERS.find((x) => x.limit >= n) || null;
  const planName = (plan) => PLAN_NAMES[plan] || 'Free';

  // Why more entries need an upgrade, naming the plan that fits.
  function upgradeError(plan, needed, what) {
    const limit = planLimit(plan);
    const tier = tierFor(needed);
    const now = plan === 'free' || !plan ? `The free plan allows up to ${limit} entries` : `The ${planName(plan)} plan allows up to ${limit} entries`;
    fail(402, tier
      ? `${now}${what}. Upgrade to ${tier.name} (up to ${tier.limit} entries) to add more.`
      : `${now}${what}. For more than ${TIERS[TIERS.length - 1].limit} entries, contact us.`, 'upgrade');
  }

  // An event's own cap: the organiser's maximum, or the hard cap.
  const eventCap = (ev) => Math.min(MAX_ENTRIES, ev.config.maxEntries || MAX_ENTRIES);

  // Can one more self-entry be confirmed in this event right now?
  // Places held by entries still paying count as taken.
  async function hasRoom(q, ev) {
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM entries WHERE event_id = $1 AND ${HOLDS_PLACE}`, [ev.eventId]);
    if (n >= eventCap(ev)) return false;
    const [{ total }] = await q(`SELECT COUNT(*)::int AS total FROM entries WHERE tournament_id = $1 AND ${HOLDS_PLACE}`, [ev.id]);
    return total < planLimit(ev.plan);
  }

  // Confirms waiting self-entries in sign-up order wherever there's room
  // (after an upgrade or a higher maximum). Returns how many were confirmed.
  async function confirmWaiting(q, t) {
    const events = new Map((await eventsOf(q, t.id)).filter((e) => e.status === 'setup').map((e) => [e.id, eventContext(t, e)]));
    const counts = new Map(
      (await q('SELECT event_id, COUNT(*)::int AS n FROM entries WHERE tournament_id = $1 AND confirmed GROUP BY event_id', [t.id]))
        .map((r) => [r.event_id, r.n]),
    );
    let total = await confirmedCount(q, t);
    const limit = planLimit(t.plan);
    const waiting = await q(
      `SELECT id, event_id FROM entries WHERE tournament_id = $1 AND NOT confirmed AND fee_status IS DISTINCT FROM 'pending' ORDER BY id`,
      [t.id],
    );
    let confirmed = 0;
    for (const w of waiting) {
      if (total >= limit) break;
      const ev = events.get(w.event_id);
      if (!ev || (counts.get(w.event_id) || 0) >= eventCap(ev)) continue;
      await q('UPDATE entries SET confirmed = true WHERE id = $1', [w.id]);
      counts.set(w.event_id, (counts.get(w.event_id) || 0) + 1);
      total++;
      confirmed++;
    }
    return confirmed;
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

  // One event's draw, results and entries.
  function eventView(t, allRows, rows, access) {
    // Entries still paying are only shown to organisers.
    const entries = access.can.manage ? allRows : allRows.filter((e) => e.fee_status !== 'pending');
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

    const confirmed = entries.filter((e) => e.confirmed).length;
    const ev = t.event;
    return {
      id: t.eventId,
      name: catalog.eventName(ev),
      shortName: catalog.shortName(ev),
      discipline: ev.discipline,
      gender: ev.gender,
      age: ev.age,
      level: ev.level,
      customName: ev.name,
      status: t.status,
      format: t.format,
      formatName: FORMATS[t.format],
      config: t.config,
      entriesOpen: entriesOpen(t),
      // Only the organiser's own maximum is shown publicly, never the plan limit.
      placesLeft: t.config.maxEntries ? Math.max(0, t.config.maxEntries - confirmed) : null,
      fee: feeOf(t),
      ...(access.can.manage && feeOf(t) && {
        feeTotal: entries.filter((e) => e.fee_status === 'paid' || e.fee_status === 'cash').reduce((sum, e) => sum + (e.fee_amount || 0), 0),
      }),
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
        ...(access.can.manage && { contact: e.contact, feeStatus: e.fee_status, feeAmount: e.fee_amount }), // organisers only
      })),
      groups,
      matches,
      champion: champion && { id: champion.id, name: champion.name },
    };
  }

  async function view(q, t, actor) {
    const events = await eventsOf(q, t.id); // first: it may attach stray entries to a new event
    const [entries, rows, access] = await Promise.all([
      q(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE tournament_id = $1 ORDER BY seed, id`, [t.id]),
      q(`SELECT * FROM matches WHERE tournament_id = $1 ORDER BY ${MATCH_ORDER}`, [t.id]),
      accessFields(q, t, actor),
    ]);
    const evs = events.map((row) => eventView(
      eventContext(t, row),
      entries.filter((e) => e.event_id === row.id),
      rows.filter((m) => m.event_id === row.id),
      access,
    ));
    const first = evs[0];
    return {
      id: t.id,
      name: t.name,
      venue: t.venue,
      location: { address: t.address, city: t.city, region: t.region, postcode: t.postcode, country: t.country },
      startsOn: t.starts_on,
      endsOn: t.ends_on,
      status: t.status,
      createdAt: t.created_at,
      sport: { id: t.sportDef.id, name: t.sportDef.name },
      visibility: t.visibility,
      official: t.official,
      plan: t.plan,
      ...(access.can.manage && {
        planName: planName(t.plan),
        limits: { entries: Number.isFinite(planLimit(t.plan)) ? planLimit(t.plan) : null },
        upgrades: await upgradesFor(q, t),
      }),
      ...access,
      events: evs,
      // The first event's draw at the top level too: single-event pages and
      // older clients read these directly.
      eventId: first.id,
      format: first.format,
      formatName: first.formatName,
      config: first.config,
      entriesOpen: evs.some((x) => x.entriesOpen),
      placesLeft: first.placesLeft,
      entries: first.entries,
      groups: first.groups,
      matches: first.matches,
      champion: first.champion,
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

  // Find public tournaments. Filters (all optional): country, region, city,
  // sport, q (name or venue), open (entries open), when (upcoming | week |
  // month | past | any) relative to `today` (the viewer's local date).
  async function listTournaments(filters = {}) {
    const f = (k) => (typeof filters[k] === 'string' ? filters[k].trim().slice(0, 80) : '');
    const where = [`t.visibility = 'public'`];
    const params = [];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f('country')) add('lower(t.country) = lower(?)', f('country'));
    if (f('region')) add('lower(t.region) = lower(?)', f('region'));
    if (f('city')) add('lower(t.city) = lower(?)', f('city'));
    if (f('sport')) add('t.sport = ?', f('sport'));
    if (f('q')) add(`(t.name ILIKE ? OR COALESCE(t.venue, '') ILIKE $${params.length + 1})`, `%${f('q').replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    if (['1', 'true'].includes(f('open'))) where.push(ENTRIES_OPEN_SQL);
    // Event filters (type, age group, level) must all match the same event.
    const preset = catalog.PRESETS.find((p) => p.key === f('event'));
    const evWhere = [];
    const evAdd = (sql, value) => {
      params.push(value);
      evWhere.push(sql.replace('?', `$${params.length}`));
    };
    if (preset) {
      evAdd('ev.discipline = ?', preset.discipline);
      evAdd('ev.gender = ?', preset.gender);
    }
    if (f('age')) evAdd('lower(ev.age) = lower(?)', f('age'));
    if (f('level')) evAdd('lower(ev.level) = lower(?)', f('level'));
    if (evWhere.length) where.push(`EXISTS (SELECT 1 FROM events ev WHERE ev.tournament_id = t.id AND ${evWhere.join(' AND ')})`);
    const today = ISO_DATE.test(f('today')) ? f('today') : new Date().toISOString().slice(0, 10);
    const when = WHEN.includes(f('when')) ? f('when') : 'upcoming';
    const last = 'COALESCE(t.ends_on, t.starts_on)';
    if (when === 'upcoming') add(`t.status <> 'completed' AND (${last} IS NULL OR ${last} >= ?)`, today);
    if (when === 'week' || when === 'month') {
      add(`${last} >= ?`, today);
      add('t.starts_on <= ?', addDays(today, when === 'week' ? 6 : 30));
    }
    if (when === 'past') add(`(t.status = 'completed' OR ${last} < ?)`, today);
    const order = when === 'past'
      ? `${last} DESC NULLS LAST, t.created_at DESC`
      : 't.starts_on ASC NULLS LAST, t.created_at DESC';
    const rows = await db.query(
      `SELECT ${CARD_COLUMNS} FROM tournaments t WHERE ${where.join(' AND ')} ORDER BY ${order}, t.id LIMIT 50`,
      params,
    );
    return rows.map(cardOf);
  }

  // Places that have public tournaments, for the search filters.
  async function tournamentPlaces() {
    return db.query(
      `SELECT DISTINCT country, region, city FROM tournaments
       WHERE visibility = 'public' AND country IS NOT NULL ORDER BY country, region, city`,
    );
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
      `SELECT ${CARD_COLUMNS}, m.role
       FROM members m JOIN tournaments t ON t.id = m.tournament_id
       WHERE m.email = $1 ORDER BY t.created_at DESC`,
      [actor.user.email],
    );
    return rows.map(cardOf);
  }

  async function createTournament(actor, input = {}) {
    if (!actor.user) fail(401, 'Sign in to create a tournament');
    const name = text(input.name, 'Tournament name');
    const details = detailsOf(input);
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
    // Events to create (the quick-add on the create form); one catch-all event by default.
    const list = Array.isArray(input.events) && input.events.length ? input.events : [{}];
    if (list.length > 30) fail(400, 'A tournament can have at most 30 events');
    const events = list.map((e) => ({ ...eventFields({ ...e }), format: FORMATS[e.format] ? e.format : format }));
    const id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
    const adminKey = crypto.randomBytes(18).toString('base64url');
    const scorerKey = crypto.randomBytes(18).toString('base64url');
    await db.tx(async (q) => {
      await q(
        `INSERT INTO tournaments (id, name, sport, format, config, admin_key, scorer_key, visibility)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [id, name, sport.id, format, JSON.stringify(config), adminKey, scorerKey, visibility],
      );
      await saveDetails(q, { id }, details);
      for (const [i, e] of events.entries()) await insertEvent(q, id, i, e, eventConfigOf(config));
      await q(`INSERT INTO members (tournament_id, email, role) VALUES ($1, $2, 'owner')`, [id, actor.user.email]);
    });
    return { id };
  }

  const insertEvent = (q, tid, position, e, config) =>
    q(
      `INSERT INTO events (tournament_id, position, discipline, gender, age, level, name, format, config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) RETURNING id`,
      [tid, position, e.discipline, e.gender, e.age, e.level, e.name, e.format, JSON.stringify(config)],
    );

  // Tournament-wide settings: name, venue/dates, self-entry and its deadline
  // (always editable). Event settings sent here (format, scoring, …) go to
  // the only event, or to `input.event`, so single-event pages work as before.
  async function updateSettings(id, actor, input = {}) {
    return mutate(id, actor, async (q, t) => {
      const details = detailsOf(input, t);
      const name = input.name === undefined ? t.name : text(input.name, 'Tournament name');
      const config = { ...t.config };
      if (input.selfEntry !== undefined) config.selfEntry = Boolean(input.selfEntry);
      if (input.entriesCloseAt !== undefined) config.entriesCloseAt = closeTime(input.entriesCloseAt);
      await q('UPDATE tournaments SET name = $1, config = $2::jsonb WHERE id = $3', [name, JSON.stringify(config), t.id]);
      t.config = config;
      await saveDetails(q, t, details);
      if (EVENT_KEYS.some((k) => input[k] !== undefined)) {
        const { name: _tournamentName, ...eventInput } = input;
        await applyEventSettings(q, await eventFor(q, t, input.event), eventInput);
      }
    });
  }

  // Format, scoring, caps and the category of one event. Only the late-entry
  // switch can change once the event has started.
  async function applyEventSettings(q, ev, input) {
    const keys = Object.keys(input).filter((k) => input[k] !== undefined && (EVENT_KEYS.includes(k) || k === 'name' || k === 'fee'));
    if (ev.status !== 'setup' && keys.some((k) => k !== 'lateEntry')) {
      fail(409, 'Settings are locked once the tournament has started');
    }
    if (input.format !== undefined && !FORMATS[input.format]) fail(400, 'Unknown format');
    const format = input.format ?? ev.format;
    const config = buildConfig(input, ev.sportDef, ev.config);
    if (input.maxEntries !== undefined) checkMaxEntries(config, ev.plan);
    if (input.fee !== undefined) {
      const fee = int(input.fee === '' || input.fee === null ? 0 : input.fee, 0, MAX_FEE, 0, 'Entry fee (in paise)');
      if (fee && !ev.official) fail(403, 'Entry fees are only available for tournaments organised by Tonament');
      config.fee = fee;
    }
    const f = eventFields(input, ev.event);
    await q(
      `UPDATE events SET format = $1, config = $2::jsonb, discipline = $3, gender = $4, age = $5, level = $6, name = $7 WHERE id = $8`,
      [format, JSON.stringify(eventConfigOf(config)), f.discipline, f.gender, f.age, f.level, f.name, ev.eventId],
    );
    await syncTournament(q, ev.id);
    // A higher (or no) maximum makes room for players who were waiting.
    if (input.maxEntries !== undefined) await confirmWaiting(q, ev);
  }

  // ---------- managing events

  async function addEvents(id, actor, input = {}) {
    const list = Array.isArray(input.events) ? input.events : [input];
    if (!list.length) fail(400, 'Add at least one event');
    return mutate(id, actor, async (q, t) => {
      const existing = await eventsOf(q, t.id);
      if (existing.length + list.length > 30) fail(400, 'A tournament can have at most 30 events');
      // New events start with the first event's format and scoring.
      const base = existing[0] ? eventContext(t, existing[0]) : null;
      const names = new Set(existing.map((e) => catalog.eventName(e).toLowerCase()));
      let position = existing.reduce((max, e) => Math.max(max, e.position), -1);
      for (const raw of list) {
        const f = eventFields(raw || {});
        const label = catalog.eventName(f);
        if (names.has(label.toLowerCase())) fail(409, `${label} already exists`);
        names.add(label.toLowerCase());
        const format = FORMATS[raw.format] ? raw.format : base?.format ?? 'league_knockout';
        const config = eventConfigOf(buildConfig(raw, t.sportDef, base ? { ...base.config, knockoutRounds: undefined, maxEntries: null } : {}));
        delete config.knockoutRounds;
        await insertEvent(q, t.id, ++position, { ...f, format }, config);
      }
      await syncTournament(q, t.id);
    });
  }

  async function updateEvent(id, actor, eventId, input = {}) {
    return mutateEvent(id, actor, eventId, async (q, ev) => {
      if (input.discipline !== undefined || input.gender !== undefined || input.age !== undefined || input.level !== undefined || input.name !== undefined) {
        const f = eventFields(input, ev.event);
        const others = (await eventsOf(q, ev.id)).filter((e) => e.id !== ev.eventId);
        if (others.some((e) => catalog.eventName(e).toLowerCase() === catalog.eventName(f).toLowerCase())) {
          fail(409, `${catalog.eventName(f)} already exists`);
        }
      }
      await applyEventSettings(q, ev, input);
    });
  }

  async function deleteEvent(id, actor, eventId) {
    return mutateEvent(id, actor, eventId, async (q, ev) => {
      if (ev.status !== 'setup') fail(409, 'This event has started and can\'t be deleted');
      const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM events WHERE tournament_id = $1', [ev.id]);
      if (n <= 1) fail(409, 'A tournament needs at least one event');
      await q('DELETE FROM matches WHERE event_id = $1', [ev.eventId]);
      await q('DELETE FROM entries WHERE event_id = $1', [ev.eventId]);
      await q('DELETE FROM events WHERE id = $1', [ev.eventId]);
      await syncTournament(q, ev.id);
    });
  }

  async function reorderEvents(id, actor, ids) {
    return mutate(id, actor, async (q, t) => {
      const current = (await eventsOf(q, t.id)).map((e) => e.id);
      const wanted = Array.isArray(ids) ? ids.map(Number) : [];
      if (wanted.length !== current.length || new Set(wanted).size !== wanted.length || !wanted.every((x) => current.includes(x))) {
        fail(400, 'ids must list every event exactly once');
      }
      for (const [i, eid] of wanted.entries()) await q('UPDATE events SET position = $1 WHERE id = $2', [i, eid]);
      await syncTournament(q, t.id);
    });
  }

  async function deleteTournament(id, actor) {
    return db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, 'delete');
      await q('DELETE FROM members WHERE tournament_id = $1', [t.id]);
      await q('DELETE FROM matches WHERE tournament_id = $1', [t.id]);
      await q('DELETE FROM entries WHERE tournament_id = $1', [t.id]);
      await q('DELETE FROM events WHERE tournament_id = $1', [t.id]);
      await q('DELETE FROM tournaments WHERE id = $1', [t.id]);
      return { ok: true };
    });
  }

  // ---------- entries

  function requireSetup(t) {
    if (t.status !== 'setup') fail(409, 'Entries are locked once the tournament has started');
  }

  async function addEntries(id, actor, names, { walkIn = false, event } = {}) {
    if (!Array.isArray(names)) fail(400, 'names must be a list');
    const clean = names.map((n) => (typeof n === 'string' ? n.trim().replace(/\s+/g, ' ') : '')).filter(Boolean);
    if (!clean.length) fail(400, 'Enter at least one name');
    return mutateEvent(id, actor, event, async (q, t) => {
      requireSetup(t);
      const existing = await entriesOf(q, t);
      if (existing.length + clean.length > MAX_ENTRIES) fail(400, `An event can have at most ${MAX_ENTRIES} entries`);
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
    const contact = contactOf(input.contact);
    const result = await db.tx(async (q) => {
      const row = await load(q, id, { lock: true });
      await requireVisible(q, row, null);
      const t = await eventFor(q, row, input.event);
      const fee = feeOf(t);
      if (fee) {
        if (!billingConfig().enabled) fail(503, 'Online payment isn\'t available right now — contact the organiser');
        if (!contact.includes('@')) fail(400, 'Enter your email address — your receipt is sent there');
        await clearExpiredPending(q, t);
        // Starting again replaces your own unfinished payment.
        await q(`DELETE FROM entries WHERE event_id = $1 AND contact = $2 AND fee_status = 'pending'`, [t.eventId, contact]);
      }
      // Doubles need a partner; singles ignore one.
      if (t.event.discipline === 'doubles' && !partner) fail(400, `${eventLabel(t)} is a doubles event — add your partner's name`);
      const name = partner && t.event.discipline !== 'singles' ? `${player} / ${partner}` : player;
      if (t.status !== 'setup') fail(409, 'Entries are closed — the draw has been made');
      if (!t.config.selfEntry) fail(409, 'This tournament doesn\'t take entries online — contact the organiser');
      if (!entriesOpen(t)) fail(409, 'Entries are closed');
      const existing = await entriesOf(q, t);
      if (existing.length >= MAX_ENTRIES) fail(409, 'This event is full');
      if (existing.some((e) => e.contact === contact)) fail(409, 'This phone number or email has already been used to enter this event');
      if (existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) fail(409, `"${name}" is already entered`);
      const seed = existing.reduce((max, e) => Math.max(max, e.seed), 0) + 1;
      const room = await hasRoom(q, t);
      if (fee) {
        // Paid events never take a payment for a place that isn't there.
        if (!room) fail(409, `${eventLabel(t)} is full`);
        const [{ id: entryId }] = await insertEntry(q, t, { name, seed, source: 'self', contact, confirmed: false, feeStatus: 'pending', feeAmount: fee });
        const [pay] = await q(
          `INSERT INTO payments (tournament_id, tournament_name, user_email, amount, currency, kind, entry_id, event_id, event_name, player)
           VALUES ($1, $2, $3, $4, $5, 'entry', $6, $7, $8, $9) RETURNING id`,
          [t.id, t.name, contact, fee, billingConfig().currency, entryId, t.eventId, eventLabel(t), name],
        );
        return { t, name, entryId, paymentId: pay.id, fee, player, contact };
      }
      const confirmed = room;
      await insertEntry(q, t, { name, seed, source: 'self', contact, confirmed });
      let owners = [];
      if (!confirmed && !t.waiting_notified) {
        await q('UPDATE tournaments SET waiting_notified = true WHERE id = $1', [t.id]);
        owners = (await q(`SELECT email FROM members WHERE tournament_id = $1 AND role = 'owner'`, [t.id])).map((r) => r.email);
      }
      return { t, name, confirmed, owners, eventId: t.eventId };
    });
    if (result.paymentId) return startEntryPayment(result);
    const { t, name: entered, confirmed, owners, eventId } = result;
    if (owners.length && mailer?.enabled && baseUrl) {
      try {
        for (const to of owners) {
          await mailer.send({ to, ...waitingEmail({ tournament: t.name, player: entered, url: `${baseUrl}/#/t/${t.id}/entries` }) });
        }
      } catch (err) {
        console.error('Waiting-entries email failed:', err.message);
      }
    }
    return { ok: true, name: entered, confirmed, event: eventId };
  }

  // Creates the Razorpay order for a paid self-entry. The entry stays
  // pending until verifyPayment (or the webhook) confirms the payment.
  async function startEntryPayment({ t, name, entryId, paymentId, fee, player, contact }) {
    const cfg = billingConfig();
    let order;
    try {
      order = await razorpay(cfg).createOrder({
        amount: fee,
        currency: cfg.currency,
        receipt: `tn_${paymentId}`,
        notes: { tournament_id: t.id, event: eventLabel(t).slice(0, 200), entry_id: String(entryId), email: contact },
      });
    } catch (err) {
      console.error('Razorpay order failed:', err.message);
      await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
      await db.query(`DELETE FROM entries WHERE id = $1 AND fee_status = 'pending'`, [entryId]);
      fail(502, 'Couldn\'t start the payment — please try again in a moment');
    }
    await db.query('UPDATE payments SET order_id = $1 WHERE id = $2', [order.id, paymentId]);
    return {
      ok: true,
      name,
      confirmed: false,
      pending: true,
      event: t.eventId,
      payment: {
        orderId: order.id,
        keyId: cfg.keyId,
        amount: fee,
        currency: cfg.currency,
        name: cfg.business.name || 'Tonament',
        description: `Entry fee — ${eventLabel(t)}, ${t.name}`.slice(0, 250),
        prefill: { name: player, email: contact },
      },
    };
  }

  // Organisers record fees taken in person (cash/UPI) or waive them.
  async function setEntryFee(id, actor, entryId, status) {
    if (![null, 'cash', 'waived'].includes(status ?? null)) fail(400, 'status must be "cash", "waived" or null');
    return mutateEntry(id, actor, entryId, async (q, t) => {
      if (!feeOf(t)) fail(409, 'This event has no entry fee');
      const [e] = await q('SELECT fee_status FROM entries WHERE id = $1', [Number(entryId)]);
      if (e.fee_status === 'paid') fail(409, 'Paid online — refunds are made in the Razorpay dashboard');
      if (e.fee_status === 'pending') fail(409, 'This player is paying online right now');
      await q('UPDATE entries SET fee_status = $1, fee_amount = $2 WHERE id = $3', [
        status ?? null, status === 'cash' ? feeOf(t) : null, Number(entryId),
      ]);
    });
  }

  // Site admins mark tournaments that Tonament itself runs; only those can charge entry fees.
  async function setOfficial(id, actor, official) {
    requireSiteAdmin(actor);
    return mutate(id, actor, async (q, t) => {
      await q('UPDATE tournaments SET official = $1 WHERE id = $2', [Boolean(official), t.id]);
    });
  }

  // The organiser lets a waiting self-entry in (within their plan's limit).
  async function confirmEntry(id, actor, entryId) {
    return mutateEntry(id, actor, entryId, async (q, t) => {
      requireSetup(t);
      const [e] = await q('SELECT confirmed, fee_status FROM entries WHERE id = $1 AND tournament_id = $2', [Number(entryId) || 0, t.id]);
      if (!e) fail(404, 'Entry not found');
      if (e.confirmed) return;
      if (e.fee_status === 'pending') fail(409, 'This player is still paying their entry fee');
      await checkEntryLimit(q, t, 1);
      await q('UPDATE entries SET confirmed = true WHERE id = $1', [Number(entryId)]);
    });
  }

  async function checkIn(id, actor, entryId, here = true) {
    return mutateEntry(id, actor, entryId, async (q, t) => {
      requireSetup(t);
      const rows = await q('UPDATE entries SET checked_in = $1 WHERE id = $2 AND tournament_id = $3 RETURNING id', [
        Boolean(here), Number(entryId) || 0, t.id,
      ]);
      if (!rows.length) fail(404, 'Entry not found');
    });
  }

  async function checkInAll(id, actor, here = true, { event } = {}) {
    return mutateEvent(id, actor, event, async (q, t) => {
      requireSetup(t);
      await q('UPDATE entries SET checked_in = $1 WHERE event_id = $2', [Boolean(here), t.eventId]);
    });
  }

  async function removeEntry(id, actor, entryId) {
    return mutateEntry(id, actor, entryId, async (q, t) => {
      requireSetup(t);
      const deleted = await q('DELETE FROM entries WHERE id = $1 AND tournament_id = $2 RETURNING id', [Number(entryId) || 0, t.id]);
      if (!deleted.length) fail(404, 'Entry not found');
    });
  }

  async function reorderEntries(id, actor, ids, { event } = {}) {
    return mutateEvent(id, actor, event, async (q, t) => {
      requireSetup(t);
      const current = (await entriesOf(q, t)).map((e) => e.id);
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
    await saveEventConfig(q, t);
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

  async function start(id, actor, { skipUnconfirmed = false, event } = {}) {
    return mutateEvent(id, actor, event, async (q, t) => {
      if (t.status !== 'setup') fail(409, 'The tournament has already started');
      // Unconfirmed self-entries are never drawn; the organiser has to decide
      // about them first so nobody is left out by accident.
      const everyone = await entriesOf(q, t);
      const waiting = everyone.filter((e) => !e.confirmed && e.fee_status !== 'pending').length;
      if (waiting && !skipUnconfirmed) {
        fail(409, `${waiting} ${waiting === 1 ? 'entry is' : 'entries are'} still unconfirmed — confirm or remove them first`, 'unconfirmed');
      }
      // If anyone has been checked in, only checked-in entries are drawn.
      const all = everyone.filter((e) => e.confirmed);
      const usingCheckIn = all.some((e) => e.checked_in);
      const entries = usingCheckIn ? all.filter((e) => e.checked_in) : all;
      await q('UPDATE entries SET in_draw = confirmed AND (checked_in OR NOT $2), withdrawn = false WHERE event_id = $1', [t.eventId, usingCheckIn]);
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
      await saveEventConfig(q, t);
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

  async function startKnockout(id, actor, { event } = {}) {
    return mutateEvent(id, actor, event, async (q, t) => {
      if (t.format !== 'league_knockout' || t.status !== 'league') fail(409, 'The knockout stage cannot be started now');
      const pending = await pendingLeague(q, t);
      if (pending) fail(409, `${pending} league match${pending > 1 ? 'es are' : ' is'} still to be played`);
      const { groups } = eventView(t, await entriesOf(q, t), await matchesOf(q, t), { can: {} });
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
  async function redraw(id, actor, { event } = {}) {
    return mutateEvent(id, actor, event, async (q, t) => {
      if (t.status === 'setup') fail(409, 'The draw hasn\'t been made yet');
      if (t.status === 'completed' || (t.format === 'league_knockout' && t.status === 'knockout')) {
        fail(409, 'The draw can only be redone before the first point is played');
      }
      const [{ n }] = await q(
        `SELECT COUNT(*)::int AS n FROM matches WHERE event_id = $1 AND (rallies <> '' OR walkover)`,
        [t.eventId],
      );
      if (n) fail(409, 'Play has started — the draw can only be redone before the first point');
      await q('DELETE FROM matches WHERE event_id = $1', [t.eventId]);
      await q('UPDATE entries SET group_no = NULL, in_draw = true WHERE event_id = $1', [t.eventId]);
      const { knockoutRounds: _r, ...config } = t.config;
      t.config = config;
      await saveEventConfig(q, t);
      await setStatus(q, t, 'setup');
    });
  }

  // Add a player after the start (only if the organiser allows late entries).
  // Groups: joins the smallest group with catch-up matches against everyone in
  // it. Knockout: takes a first-round bye slot.
  async function lateEntry(id, actor, input = {}) {
    const name = text(input.name, 'Name', { max: 60 });
    return mutateEvent(id, actor, input.event, async (q, t) => {
      if (t.status === 'setup') fail(409, 'The draw hasn\'t been made yet — just add them to the entries');
      if (t.status === 'completed') fail(409, 'The tournament has finished');
      if (!t.config.lateEntry) fail(409, 'Late entries are switched off for this tournament', 'late_off');
      const all = await entriesOf(q, t);
      if (all.length >= MAX_ENTRIES) fail(409, `An event can have at most ${MAX_ENTRIES} entries`);
      if (all.some((e) => e.name.toLowerCase() === name.toLowerCase())) fail(400, `"${name}" is already entered`);
      await checkEntryLimit(q, t, 1);
      const seed = all.reduce((max, e) => Math.max(max, e.seed), 0) + 1;

      if (t.status === 'league') {
        const done = new Map(
          (await q(
            `SELECT group_no, COUNT(*)::int AS n FROM matches WHERE event_id = $1 AND stage = 'league' AND status = 'done' GROUP BY group_no`,
            [t.eventId],
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
          `SELECT COALESCE(MAX(round), 0)::int AS last FROM matches WHERE event_id = $1 AND stage = 'league' AND group_no = $2`,
          [t.eventId, g],
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
        `SELECT * FROM matches WHERE event_id = $1 AND stage = 'knockout' AND round = 1 AND status = 'bye' ORDER BY slot`,
        [t.eventId],
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
    return mutateEntry(id, actor, entryId, async (q, t) => {
      if (t.status === 'setup') fail(409, 'The draw hasn\'t been made — just remove the entry');
      if (t.status === 'completed') fail(409, 'The tournament has finished');
      const [e] = await q('SELECT * FROM entries WHERE id = $1 AND tournament_id = $2', [Number(entryId) || 0, t.id]);
      if (!e) fail(404, 'Entry not found');
      if (e.withdrawn) fail(409, `${e.name} has already withdrawn`);
      if (!e.in_draw) fail(409, `${e.name} isn't in the draw`);
      await q('UPDATE entries SET withdrawn = true WHERE id = $1', [e.id]);
      const open = await q(
        `SELECT * FROM matches WHERE event_id = $1 AND status IN ('scheduled', 'live') AND (a_id = $2 OR b_id = $2)
         ORDER BY stage = 'knockout', round, slot`,
        [t.eventId, e.id],
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
      const { t: tournament } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, tournament, mid);
      const t = await eventFor(q, tournament, m.event_id);
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
      const { t: tournament } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, tournament, mid);
      const t = await eventFor(q, tournament, m.event_id);
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
      const { t: tournament } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, tournament, mid);
      const t = await eventFor(q, tournament, m.event_id);
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

  const paidSoFar = async (q, tid) =>
    (await q(`SELECT COALESCE(SUM(amount), 0)::int AS n FROM payments WHERE tournament_id = $1 AND status = 'paid'`, [tid]))[0].n;

  // Plans this tournament can move up to, and what each would cost now.
  async function upgradesFor(q, t) {
    if (!billingConfig().enabled || t.plan === 'pass') return [];
    const paid = await paidSoFar(q, t.id);
    const current = planLimit(t.plan);
    return TIERS.filter((x) => x.limit > current).map((x) => ({ ...x, amount: Math.max(0, x.price - paid) }));
  }

  // Step 1: create a Razorpay order for a plan (the next one up by default).
  // Upgrading from a paid plan charges only the difference.
  async function checkout(id, actor, input = {}) {
    const cfg = billingConfig();
    if (!cfg.enabled) fail(503, 'Payments aren\'t set up yet');
    const { t, paymentId, tier, amount } = await db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, 'manage');
      if (t.plan === 'pass') fail(409, 'This tournament already has the Event Pass (unlimited entries)');
      const options = await upgradesFor(q, t);
      if (!options.length) fail(409, `This tournament is already on the ${planName(t.plan)} plan, the largest one`);
      const tier = input.tier ? options.find((x) => x.id === input.tier) : options[0];
      if (!tier) fail(400, TIERS.some((x) => x.id === input.tier) ? 'You can only move up to a bigger plan' : 'Unknown plan');
      if (tier.amount < 100) fail(409, 'Contact us to change this tournament\'s plan');
      const [row] = await q(
        `INSERT INTO payments (tournament_id, tournament_name, user_email, amount, currency, tier)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [t.id, t.name, actor.user?.email ?? null, tier.amount, cfg.currency, tier.id],
      );
      return { t, paymentId: row.id, tier, amount: tier.amount };
    });
    let order;
    try {
      order = await razorpay(cfg).createOrder({
        amount,
        currency: cfg.currency,
        receipt: `tn_${paymentId}`,
        notes: { tournament_id: t.id, tournament: t.name.slice(0, 200), plan: tier.id, email: actor.user?.email ?? '' },
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
      amount,
      currency: cfg.currency,
      tier: tier.id,
      name: cfg.business.name || 'Tonament',
      description: `${tier.name} plan — ${t.name}`,
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
      if (p.kind === 'entry') {
        await settleEntryFee(q, paid);
      } else if (p.tournament_id) {
        // Payments made before tiers existed bought the unlimited Event Pass.
        await q(`UPDATE tournaments SET plan = $1, plan_updated_at = now() WHERE id = $2`, [p.tier || 'pass', p.tournament_id]);
        const [t] = await q('SELECT * FROM tournaments WHERE id = $1 FOR UPDATE', [p.tournament_id]);
        if (t) await confirmWaiting(q, t);
      }
      return { payment: paid, activated: true };
    });
  }

  // A paid entry fee confirms the entry. If the pending entry was already
  // cleared (the player took very long to pay), it's added back.
  async function settleEntryFee(q, p) {
    const [ev] = await q('SELECT status FROM events WHERE id = $1', [p.event_id]);
    const open = ev?.status === 'setup';
    let [e] = p.entry_id ? await q('SELECT id FROM entries WHERE id = $1', [p.entry_id]) : [];
    if (!e && ev && p.tournament_id) {
      [e] = await q(`SELECT id FROM entries WHERE event_id = $1 AND contact = $2`, [p.event_id, p.user_email]);
      if (!e) {
        const [{ seed }] = await q('SELECT COALESCE(MAX(seed), 0)::int + 1 AS seed FROM entries WHERE event_id = $1', [p.event_id]);
        [e] = await q(
          `INSERT INTO entries (tournament_id, event_id, name, seed, source, contact, confirmed)
           VALUES ($1, $2, $3, $4, 'self', $5, false) RETURNING id`,
          [p.tournament_id, p.event_id, p.player, seed, p.user_email],
        );
      }
      await q('UPDATE payments SET entry_id = $1 WHERE id = $2', [e.id, p.id]);
    }
    // Paid after the draw was made: kept unconfirmed so it shows up for a refund.
    if (e) await q(`UPDATE entries SET fee_status = 'paid', fee_amount = $1, confirmed = $2 WHERE id = $3`, [p.amount, open, e.id]);
  }

  async function sendReceipt(payment, baseUrl) {
    if (!payment?.user_email || !mailer?.enabled || !baseUrl) return;
    const cfg = billingConfig();
    if (payment.kind === 'entry') {
      try {
        await mailer.send({
          to: payment.user_email,
          ...entryReceiptEmail({
            business: cfg.business,
            tournament: payment.tournament_name,
            event: payment.event_name,
            player: payment.player,
            amount: payment.amount,
            currency: payment.currency,
            paymentId: payment.payment_id,
            paidAt: payment.paid_at,
            url: `${baseUrl}/#/t/${payment.tournament_id}/entries?e=${payment.event_id}`,
          }),
        });
      } catch (err) {
        console.error('Entry receipt email failed:', err.message);
      }
      return;
    }
    try {
      await mailer.send({
        to: payment.user_email,
        ...receiptEmail({
          business: cfg.business,
          tournament: payment.tournament_name,
          plan: planName(payment.tier || 'pass'),
          limit: TIERS.find((x) => x.id === payment.tier)?.limit ?? null,
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
    if (row.kind === 'entry') return { ok: true, tournamentId: row.tournament_id, kind: 'entry', event: row.event_id };
    return { ok: true, tournamentId: row.tournament_id, plan: row.tier || 'pass' };
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
    if (!PLAN_NAMES[plan]) fail(400, `plan must be one of: ${Object.keys(PLAN_NAMES).join(', ')}`);
    return mutate(id, actor, async (q, t) => {
      await q('UPDATE tournaments SET plan = $1, plan_updated_at = now() WHERE id = $2', [plan, t.id]);
      await confirmWaiting(q, { ...t, plan });
    });
  }

  async function adminPayments(actor) {
    requireSiteAdmin(actor);
    const rows = await db.query(
      `SELECT p.id, p.tournament_id AS "tournamentId", p.tournament_name AS "tournamentName", p.user_email AS "email",
              p.order_id AS "orderId", p.payment_id AS "paymentId", p.amount, p.currency, p.status,
              p.created_at AS "createdAt", p.paid_at AS "paidAt", p.tier, p.kind, p.event_name AS "eventName", p.player, t.plan
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
    setOfficial,
    setEntryFee,
    adminPayments,
    sportInterest,
    setSportInterest,
    myTournaments,
    listMembers,
    addMember,
    removeMember,
    claim,
    listTournaments,
    tournamentPlaces,
    getTournament,
    setVisibility,
    addEvents,
    updateEvent,
    deleteEvent,
    reorderEvents,
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
