'use strict';

const crypto = require('node:crypto');
const sports = require('./sports');
const formats = require('./formats');
const regions = require('../public/regions');
const catalog = require('../public/sports/events');
const schedule = require('../public/schedule');
const league = require('../public/sports/league');
const { fromScores } = require('../public/sports/result');
const pages = require('./pages');
const { HttpError } = require('./errors');
const { normalizeEmail, validEmail } = require('./auth');
const { createOrgs, createSettings } = require('./orgs');
const { createPlayers } = require('./players');
const { createGroups } = require('./groups');
const { createReferrals } = require('./referrals');
const { createSocial } = require('./social');
const { createClubs } = require('./clubs');
const { createCards } = require('./cards');
const { createNotify } = require('./notify');
const { createChallenges } = require('./challenges');
const { createLadders } = require('./ladders');
const { createGoals } = require('./goals');
const { createTies } = require('./ties');
const TIE = require('../public/sports/tie');
const dupr = require('./dupr');
const { inviteEmail, receiptEmail, orgReceiptEmail, entryReceiptEmail, waitingEmail, feeReceivedEmail, feeMissingEmail } = require('./email');
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
const EVENT_KEYS = ['tie', 'format', 'groups', 'groupSize', 'qualifiers', 'scoring', 'maxEntries', 'lateEntry', 'fee', 'partners', 'balancePairs', 'prizes', 'leagueDraws', 'discipline', 'gender', 'age', 'level', 'ranked', 'dupr', 'duprMin', 'duprMax', 'pools', 'poolOrder', 'feePer'];
// Event settings that can still change once the event has started.
const LIVE_EVENT_KEYS = ['lateEntry', 'prizes', 'ranked', 'poolOrder', 'fee', 'feePer'];
const MAX_PRIZE = 10000000; // ₹1 crore

// Prizes for one event: [{ place, cash (whole rupees), reward }].
function prizesOf(list) {
  if (!Array.isArray(list)) fail(400, 'prizes must be a list');
  if (list.length > 10) fail(400, 'Up to 10 prizes per event');
  return list.map((p) => {
    const place = text(p && p.place, 'Prize place', { max: 40 });
    const cash = p.cash === undefined || p.cash === null || p.cash === '' ? null : Number(p.cash);
    if (cash !== null && (!Number.isInteger(cash) || cash < 0 || cash > MAX_PRIZE)) fail(400, 'Prize money must be a whole number of rupees');
    const reward = text(p.reward, 'Reward', { max: 80, optional: true });
    if (!cash && !reward) fail(400, `Add prize money or a reward for ${catalog.placeLabel(place)}`);
    return { place, cash: cash || null, reward };
  });
}
// Tournament page images. Free tournaments get a cover and a few photos;
// paid ones also get their logo, colours and sponsors, and more photos.
// 'preview' is the cover cropped to 1200×630 for link previews (made by the browser).
// 'qr' is the organiser's UPI QR code, for players paying entry fees.
const MEDIA_KINDS = ['logo', 'cover', 'photo', 'sponsor', 'preview', 'qr'];
const MAX_PREVIEW_BYTES = 600 * 1024; // WhatsApp skips bigger preview images
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const PHOTO_LIMITS = { free: 3, paid: 30 };
const SPONSOR_LIMIT = 8;
const mediaUrl = (id) => `/api/media/${id}`;
// The real type, from the file's first bytes (never trust a name or a header).
function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
const HEX_COLOUR = /^#[0-9a-f]{6}$/i;
function linkOf(value, label, host) {
  if (!value) return null;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    fail(400, `${label}: enter a full link starting with https://`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail(400, `${label}: enter a full link starting with https://`);
  if (host && url.hostname !== host && !url.hostname.endsWith(`.${host}`)) fail(400, `${label}: use a ${host} link`);
  return url.toString().slice(0, 300);
}

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
// "08:00": a time of day at the venue (not converted between time zones).
function clockTime(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(400, `${label}: enter a time like 08:30`);
  return value;
}
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Venue, location and dates (all optional). Fields not sent keep their value.
const DETAIL_KEYS = ['venue', 'address', 'city', 'region', 'postcode', 'country', 'startsOn', 'endsOn', 'startTime', 'endTime'];
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
    start_time: input.startTime === undefined ? prev.start_time ?? null : clockTime(input.startTime, 'Start time'),
    end_time: input.endTime === undefined ? prev.end_time ?? null : clockTime(input.endTime, 'Finish time'),
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
  if ((d.start_time || d.end_time) && !d.starts_on) fail(400, 'Add a date for the start time');
  // Over several days the times are the daily hours: either way, finish after the start.
  if (d.start_time && d.end_time && d.end_time <= d.start_time) fail(400, 'The finish time must be after the start time');
  return d;
}
const DETAIL_COLUMNS = ['venue', 'address', 'city', 'region', 'postcode', 'country', 'starts_on', 'ends_on', 'start_time', 'end_time'];
const saveDetails = (q, t, d) =>
  q(`UPDATE tournaments SET ${DETAIL_COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${DETAIL_COLUMNS.length + 1}`, [
    ...DETAIL_COLUMNS.map((c) => d[c]), t.id,
  ]);

// Total prize money (whole rupees) across a tournament's events.
const PRIZE_TOTAL_SQL = `(SELECT COALESCE(SUM((p->>'cash')::int), 0)::int FROM events ev,
  jsonb_array_elements(COALESCE(ev.config->'prizes', '[]'::jsonb)) p WHERE ev.tournament_id = t.id)`;

// Self-entry is open on the tournament and at least one event hasn't started.
const ENTRIES_OPEN_SQL = `COALESCE((t.config->>'selfEntry')::boolean, true)
  AND (t.config->>'entriesCloseAt' IS NULL OR (t.config->>'entriesCloseAt')::timestamptz > now())
  AND EXISTS (SELECT 1 FROM events ev WHERE ev.tournament_id = t.id AND ev.status = 'setup')`;

// Tournament list cards (home page search and "My tournaments").
const CARD_COLUMNS = `t.id, t.name, t.venue, t.sport, t.format, t.status, t.visibility, t.created_at AS "createdAt",
  t.city, t.region, t.country, t.starts_on AS "startsOn", t.ends_on AS "endsOn", t.start_time AS "startTime",
  (${ENTRIES_OPEN_SQL}) AS "entriesOpen",
  (SELECT COUNT(*)::int FROM entries e WHERE e.tournament_id = t.id AND e.paired_into IS NULL) AS entries,
  (SELECT m.id FROM media m WHERE m.tournament_id = t.id AND m.kind = 'cover' LIMIT 1) AS "coverId",
  ${PRIZE_TOTAL_SQL} AS "prizeTotal",
  COALESCE(t.perks->'items' ?| array['lunch', 'dinner'], false) AS meals,
  (SELECT COALESCE(json_agg(json_build_object('discipline', ev.discipline, 'gender', ev.gender, 'age', ev.age, 'level', ev.level, 'name', ev.name)
     ORDER BY ev.position, ev.id), '[]') FROM events ev WHERE ev.tournament_id = t.id) AS events`;
// Cards list their events by short name ("MS U19", "XD").
const cardOf = ({ coverId, ...r }) => ({
  ...r,
  formatName: FORMATS[r.format],
  events: (r.events || []).map((e) => catalog.shortName(e)),
  cover: coverId ? mediaUrl(coverId) : null,
});
const WHEN = ['upcoming', 'week', 'month', 'past', 'any'];

const groupName = (no) => `Group ${String.fromCharCode(65 + no)}`;
const nextSlotColumn = (m) => (m.slot % 2 ? 'b_id' : 'a_id');

// Every write runs in a transaction that first locks the tournament row, so
// concurrent requests for one tournament (two umpires, retries, several
// serverless instances) are applied one at a time.
function createService(db, { mailer, fetchImpl } = {}) {
  // Site-wide settings the admin changes, and academy / venue pages (set up at the end).
  const settings = createSettings(db);
  let orgs;
  let profiles;
  let social;
  let goalsRef = null;
  let referrals;

  // ---------- queries (q is db.query or a transaction's query)

  async function load(q, id, { lock = false } = {}) {
    const [row] = await q(`SELECT * FROM tournaments WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [String(id)]);
    if (!row) fail(404, 'Tournament not found');
    return { ...row, sportDef: sports.get(row.sport) };
  }

  const ENTRY_COLUMNS = 'id, event_id, name, seed, group_no, checked_in, in_draw, withdrawn, source, contact, confirmed, fee_status, fee_amount, created_at, solo, solo_side, paired_into, players, user_id, phone, pay_ref, pay_sent_at, hold_until, level, away_since';

  // Entries and matches of one event (`ev` is an event context, see eventFor).
  // Solo players already paired up play as their pair entry, so they're left out.
  const entriesOf = (q, ev) =>
    q(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE event_id = $1 AND paired_into IS NULL ORDER BY seed, id`, [ev.eventId]);

  const insertEntry = (q, t, { name, seed, group = null, source = 'organiser', checkedIn = false, contact = null, confirmed = true, feeStatus = null, feeAmount = null, solo = false, side = null, players = null, userId = null, phone = null, holdUntil = null, level = null }) =>
    q(
      `INSERT INTO entries (tournament_id, event_id, name, seed, group_no, source, checked_in, contact, confirmed, fee_status, fee_amount, solo, solo_side, players, user_id, phone, hold_until, level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18) RETURNING id`,
      [t.id, t.eventId, name, seed, group, source, checkedIn, contact, confirmed, feeStatus, feeAmount, solo, side, players && JSON.stringify(players), userId, phone, holdUntil, level],
    );

  // A team's players (optional): one name per line, or a list.
  function playersOf(value) {
    const list = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n|,/) : [])
      .map((x) => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ') : '')).filter(Boolean);
    if (list.length > 30) fail(400, 'List up to 30 players');
    if (list.some((x) => x.length > 40)) fail(400, 'Player names must be at most 40 characters');
    return list.length ? list : null;
  }

  // ---------- entry fees (tournaments organised by Tonament only)
  // A paid self-entry is saved as 'pending' and holds its place for
  // PENDING_MINUTES while the player pays; abandoned ones are cleared.
  const PENDING_MINUTES = 30;
  const DEFAULT_HOLD_HOURS = 48;
  const MAX_FEE = 5000000; // paise (₹50,000)
  // An event's entry fee. Tournaments organised by Tonament take it online
  // (Razorpay); everyone else's players pay the organiser directly (UPI or
  // cash) and the organiser confirms it: 'due' -> 'sent' (the player says
  // they've paid) -> 'received' (or 'cash' / 'waived').
  const feeOf = (ev) => (ev.config.fee > 0 ? ev.config.fee : 0);
  const PAY_ONLINE = (ev) => Boolean(ev.official);
  const DIRECT_PAID = ['received', 'cash', 'waived'];
  // An unpaid direct-fee entry holds its place until hold_until (null: until the draw).
  const HOLDS_PLACE = `(confirmed OR (fee_status = 'pending' AND created_at > now() - interval '${PENDING_MINUTES} minutes')
    OR (fee_status IN ('due', 'sent') AND (hold_until IS NULL OR hold_until > now())))`;
  const TAKES_PLACE = `paired_into IS NULL AND ${HOLDS_PLACE}`; // a pair counts once, not its two solos
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
    // A team event in a racket sport is played as ties of singles and doubles.
    const base = t.sportDef;
    const tie = row.discipline === 'team' && catalog.hasTies(base.id);
    if (tie) config.tie = TIE.normalize(config.tie || {});
    return { ...t, eventId: row.id, event: row, format: row.format, status: row.status, config, sportDef: tie ? TIE.tieSport(base, config.tie) : base };
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
    // Results and ranking points exist while an event is finished.
    if (status === 'completed') await recordResults(q, t);
    else {
      await profiles.clearEvent(q, t.eventId);
      await social.forget(q, 'event', t.eventId);
    }
  }

  // Writes each linked player's finish, points and matches for a finished event.
  async function recordResults(q, t) {
    const entries = await entriesOf(q, t);
    const rows = await q(`SELECT * FROM matches WHERE event_id = $1 ORDER BY ${MATCH_ORDER}`, [t.eventId]);
    const names = new Map(entries.map((e) => [e.id, e.name]));
    const scored = rows.map((row) => ({ row, score: scoreOf(t, row) }));
    const standings = groupStandings(t, entries, scored, names).map((g) => g.standings.map((r) => r.id));
    const summaries = new Map(scored.map(({ row, score }) => [row.id, row.walkover ? 'Walkover' : t.sportDef.summary(score)]));
    await profiles.recordEvent(q, { t, entries, matches: rows, standings, summaries, names });
    await podiumActivity(q, t);
  }
  // Winners and finalists in their followers' feeds (public tournaments; link-only
  // ones to followers; private ones not at all).
  async function podiumActivity(q, t) {
    await social.forget(q, 'event', t.eventId);
    const [row] = await q('SELECT visibility, name FROM tournaments WHERE id = $1', [t.id]);
    if (!row || row.visibility === 'private') return;
    const podium = await q(
      `SELECT u.id, u.profile_public, r.finish, r.entries, e.org_id FROM event_results r JOIN users u ON u.email = r.email
       JOIN entries e ON e.id = r.entry_id WHERE r.event_id = $1 AND r.finish IN ('W', 'F')`,
      [t.eventId],
    );
    for (const p of podium) {
      await social.record(q, {
        dedupe: `finish:${t.eventId}:${p.id}`, actor: p.id, org: p.org_id || null, sport: t.sportDef.id, verb: 'finish', object: ['event', t.eventId],
        data: { finish: p.finish, tournamentId: t.id, tournament: row.name, event: t.event.name, entries: p.entries },
        visibility: row.visibility === 'public' && p.profile_public ? 'public' : 'followers',
      });
    }
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

  function eventFields(input, prev, sport) {
    try {
      return catalog.normalize(input, prev, sport);
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
      // League matches are exactly 2 games, and 1-1 is a draw (knockout matches keep their best-of).
      leagueDraws: input.leagueDraws !== undefined ? Boolean(input.leagueDraws) : prev.leagueDraws ?? false,
    };
  }

  // A maximum above the free limit needs the Event Pass.
  function checkMaxEntries(config, plan) {
    if (!config.maxEntries || config.maxEntries <= planLimit(plan)) return;
    upgradeError(plan, config.maxEntries, ` in total, so a maximum of ${config.maxEntries} isn't possible yet`);
  }

  const groupsFor = (t, n) => (t.config.groupSize ? formats.groupCount(n, t.config.groupSize) : t.config.groups);

  const confirmedCount = async (q, t) =>
    (await q('SELECT COUNT(*)::int AS n FROM entries WHERE tournament_id = $1 AND confirmed AND paired_into IS NULL', [t.id]))[0].n;

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
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM entries WHERE event_id = $1 AND ${TAKES_PLACE}`, [ev.eventId]);
    if (n >= eventCap(ev)) return false;
    const [{ total }] = await q(`SELECT COUNT(*)::int AS total FROM entries WHERE tournament_id = $1 AND ${TAKES_PLACE}`, [ev.id]);
    return total < planLimit(ev.plan);
  }

  // Confirms waiting self-entries in sign-up order wherever there's room
  // (after an upgrade or a higher maximum). Returns how many were confirmed.
  async function confirmWaiting(q, t) {
    const events = new Map((await eventsOf(q, t.id)).filter((e) => e.status === 'setup').map((e) => [e.id, eventContext(t, e)]));
    const counts = new Map(
      (await q('SELECT event_id, COUNT(*)::int AS n FROM entries WHERE tournament_id = $1 AND confirmed AND paired_into IS NULL GROUP BY event_id', [t.id]))
        .map((r) => [r.event_id, r.n]),
    );
    let total = await confirmedCount(q, t);
    const limit = planLimit(t.plan);
    const waiting = await q(
      // Never entries still paying, or owing the organiser their fee.
      `SELECT id, event_id FROM entries WHERE tournament_id = $1 AND NOT confirmed AND (fee_status IS NULL OR fee_status NOT IN ('pending', 'due', 'sent')) ORDER BY id`,
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

  // Doubles events tell the rules module so (pickleball's side-out has two servers a side).
  // A match's rules: the event's, or (m.rules) the ones it was played under
  // before the organiser changed the match length mid-event.
  const scoringOf = (t, m) => {
    const scoring = (m && m.rules && m.rules.scoring) || t.config.scoring;
    return t.event && t.event.discipline === 'doubles' ? { ...scoring, doubles: true } : scoring;
  };
  // League matches can be drawn: timed sports by their own rules (football yes, basketball no),
  // others when the organiser chose 2-game league matches.
  const leagueDrawsOf = (t, m) => (t.sportDef.timed ? t.sportDef.draws : Boolean(m && m.rules ? m.rules.leagueDraws : t.config.leagueDraws));
  const drawsIn = (t, m) => m.stage === 'league' && leagueDrawsOf(t, m);
  const scoreOf = (t, m, rallies = m.rallies) => league.score(t.sportDef, rallies, scoringOf(t, m), m.first_server, { draws: drawsIn(t, m) });

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
      draw: m.status === 'done' && Boolean(score.draw),
      walkover: m.walkover,
      retired: m.retired || null,
      catchUp: m.catch_up,
      queuePos: m.queue_pos,
      calledAt: m.called_at,
      score,
      summary: m.walkover ? 'Walkover' : m.retired ? `${t.sportDef.summary(score) || '0–0'} ret.` : t.sportDef.summary(score),
      updatedAt: m.updated_at,
      // Played under earlier rules (the match length changed mid-event): the phone scores it with these.
      rules: m.rules || null,
      // Who's scoring it right now (one phone at a time), while it's being scored.
      scorer: m.status !== 'done' && m.status !== 'bye' && m.scorer_device && m.scorer_seen_at && Date.now() - Date.parse(m.scorer_seen_at) < CLAIM_MS
        ? { name: m.scorer_name, device: m.scorer_device } : null,
    };
  }

  // A walkover (or a retirement) counts as a win/loss but adds nothing to
  // games or points.
  function resultOf(m, score) {
    const w = m.walkover || Boolean(m.retired);
    return {
      a: m.a_id,
      b: m.b_id,
      winner: m.winner_id,
      draw: !w && Boolean(score.draw),
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
      const pool = (t.config.groupPools || [])[g] || null;
      return {
        no: g,
        name: groupName(g),
        pool: pool && pool.label,
        // Organisers can move players in or out until the group's first match starts.
        started: scored.some(({ row }) => row.stage === 'league' && row.group_no === g && (row.rallies || row.walkover || row.status === 'done')),
        standings: formats.standings(members, results, t.sportDef.leaguePoints).map((r) => ({
          ...r,
          name: names.get(r.id),
          withdrawn: entries.some((e) => e.id === r.id && e.withdrawn),
        })),
      };
    });
  }

  // One event's draw, results and entries.
  // The people behind an entry: names, public profile links, DUPR (pickleball)
  // and, for organisers, the emails they're linked by.
  function peopleView(t, list = [], access) {
    const pickleball = t.sportDef.id === 'pickleball';
    return list.map((p) => ({
      name: p.name,
      handle: p.userId && p.public ? p.handle : null,
      ...(pickleball && {
        dupr: p.duprId || p.entryDupr || p.duprDoubles || p.duprSingles
          ? { id: p.duprId || p.entryDupr || null, singles: p.duprSingles == null ? null : Number(p.duprSingles), doubles: p.duprDoubles == null ? null : Number(p.duprDoubles), verified: Boolean(p.duprVerified) }
          : null,
      }),
      ...(p.captain && { captain: true }),
      ...(access.can.manage && { email: p.email, linked: Boolean(p.userId), feeStatus: p.feeStatus || null }),
    }));
  }

  function eventView(t, allRows, rows, access, people = new Map()) {
    // Entries still paying are only shown to organisers; paired solo players
    // appear as members of their pair.
    const visible = access.can.manage ? allRows : allRows.filter((e) => e.fee_status !== 'pending');
    const entries = visible.filter((e) => e.paired_into == null);
    const membersOf = (pairId) => visible.filter((e) => e.paired_into === pairId);
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
      feeOnline: feeOf(t) > 0 && PAY_ONLINE(t),
      prizes: t.config.prizes || [],
      ...(access.can.manage && feeOf(t) && {
        feeTotal: visible.filter((e) => ['paid', 'cash', 'received'].includes(e.fee_status)).reduce((sum, e) => sum + (e.fee_amount || 0), 0),
      }),
      entries: entries.map((e) => ({
        id: e.id,
        name: e.name,
        seed: e.seed,
        group: e.group_no,
        level: e.level || null,
        awaySince: e.away_since || null,
        checkedIn: e.checked_in,
        inDraw: e.in_draw,
        withdrawn: e.withdrawn,
        source: e.source,
        confirmed: e.confirmed,
        solo: e.solo,
        side: e.solo_side,
        people: peopleView(t, people.get(e.id), access),
        ...(t.sportDef.id === 'pickleball' && { rating: dupr.entryRating(peopleView(t, people.get(e.id), access).map((p) => ({ duprSingles: p.dupr?.singles, duprDoubles: p.dupr?.doubles })), t.event.discipline) }),
        ...(e.source === 'drawn' && {
          members: membersOf(e.id).sort((x, y) => e.name.indexOf(x.name) - e.name.indexOf(y.name)).map((m) => ({
            id: m.id,
            name: m.name,
            side: m.solo_side,
            ...(access.can.manage && { contact: m.contact, feeStatus: m.fee_status, feeAmount: m.fee_amount }),
          })),
        }),
        ...(access.can.manage && {
          contact: e.contact, phone: e.phone, feeStatus: e.fee_status, feeAmount: e.fee_amount, players: e.players || null,
          payRef: e.pay_ref, paySentAt: e.pay_sent_at, holdUntil: e.hold_until,
        }), // organisers only
      })),
      groups,
      matches,
      champion: champion && { id: champion.id, name: champion.name },
    };
  }

  // The owner's invite code (made the first time the owner opens their tournament).
  async function ownerRefCode(q, t, actor) {
    const [owner] = await q(`SELECT u.id, u.name, u.ref_code FROM members m JOIN users u ON u.email = m.email WHERE m.tournament_id = $1 AND m.role = 'owner' LIMIT 1`, [t.id]);
    if (!owner) return null;
    if (owner.ref_code) return owner.ref_code;
    return actor?.user?.id === owner.id && billingConfig().enabled ? referrals.codeFor(q, owner) : null;
  }

  async function view(q, t, actor) {
    const { org } = await withOrgBranding(q, t);
    const events = await eventsOf(q, t.id); // first: it may attach stray entries to a new event
    const media = await q('SELECT id, kind, caption, position FROM media WHERE tournament_id = $1 ORDER BY kind, position, created_at', [t.id]);
    const [entries, rows, access, people] = await Promise.all([
      q(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE tournament_id = $1 ORDER BY seed, id`, [t.id]),
      q(`SELECT * FROM matches WHERE tournament_id = $1 ORDER BY ${MATCH_ORDER}`, [t.id]),
      accessFields(q, t, actor),
      profiles.peopleOf(q, t.id),
    ]);
    const evs = events.map((row) => eventView(
      eventContext(t, row),
      entries.filter((e) => e.event_id === row.id),
      rows.filter((m) => m.event_id === row.id),
      access,
      people,
    ));
    const first = evs[0];
    return {
      id: t.id,
      name: t.name,
      venue: t.venue,
      location: { address: t.address, city: t.city, region: t.region, postcode: t.postcode, country: t.country },
      startsOn: t.starts_on,
      endsOn: t.ends_on,
      startTime: t.start_time,
      endTime: t.end_time,
      status: t.status,
      createdAt: t.created_at,
      sport: { id: t.sportDef.id, name: t.sportDef.name },
      courts: courtsOf(t),
      visibility: t.visibility,
      official: t.official,
      // The academy / venue that runs it (its page link only while the page is public).
      org: org && (org.public || access.can.manage) ? org : null,
      ...pageContent(t, media, access),
      plan: t.plan,
      // The owner's invite code: "Run your own tournament" links carry it.
      refCode: await ownerRefCode(q, t, actor),
      ...(access.can.manage && {
        planName: planName(t.plan),
        limits: { entries: Number.isFinite(planLimit(t.plan)) ? planLimit(t.plan) : null },
        upgrades: await upgradesFor(q, t),
        credits: await referrals.creditsFor(q, actor.user, t.plan),
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
    // The viewer's own entries (players enter with their account).
    const mine = actor.user
      ? await q(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE tournament_id = $1 AND user_id = $2 ORDER BY id`, [t.id, actor.user.id])
      : [];
    return {
      role,
      can,
      myEntries: mine.map((e) => ({
        id: e.id,
        eventId: e.event_id,
        name: e.name,
        confirmed: e.confirmed,
        feeStatus: e.fee_status,
        feeAmount: e.fee_amount,
        payRef: e.pay_ref,
        holdUntil: e.hold_until,
        solo: e.solo,
        paired: e.paired_into != null,
        inDraw: e.in_draw,
        withdrawn: e.withdrawn,
      })),
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

  // One phone scores a match at a time. The first device to score it holds it
  // while points keep coming (CLAIM_MS); another device is turned away until
  // someone there taps Take over. Requests without a device id (older app
  // versions) aren't held to it.
  const CLAIM_MS = 3 * 60 * 1000;
  const claimHeld = (m, device) => Boolean(m.scorer_device && m.scorer_device !== device && m.scorer_seen_at && Date.now() - Date.parse(m.scorer_seen_at) < CLAIM_MS);
  async function claimMatch(q, m, actor, { take = false } = {}) {
    if (!actor.device) return;
    if (claimHeld(m, actor.device) && !take) {
      fail(409, `${m.scorer_name || 'Another phone'} is scoring this match on another phone — tap Take over to score it here`, 'claimed');
    }
    const name = actor.user ? actor.user.name : 'A scorer-link phone';
    await q('UPDATE matches SET scorer_device = $1, scorer_name = $2, scorer_seen_at = now() WHERE id = $3', [actor.device, name, m.id]);
  }
  async function takeOverScoring(id, actor, mid) {
    if (!actor.device) fail(400, 'Update the app to take over scoring');
    return db.tx(async (q) => {
      const { t: tournament } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, tournament, mid);
      if (m.status === 'done' || m.status === 'bye') fail(409, 'This match is already finished');
      await claimMatch(q, m, actor, { take: true });
      return viewOfRow(q, await eventFor(q, tournament, m.event_id), (await q('SELECT * FROM matches WHERE id = $1', [m.id]))[0]);
    });
  }

  // Scoring requests carry the rally count the device saw (`at`), so a retry
  // or a second device can never apply a point to a different score.
  function checkAt(m, at) {
    if (at === undefined || at === null) return;
    if (!Number.isInteger(at) || at !== m.rallies.length) {
      fail(409, 'The score was changed on another device — showing the latest score', 'stale');
    }
  }

  // ---------- tournament page: about, links, images, branding

  // Any paid plan gets the bigger photo gallery; organiser branding and
  // sponsors come with Open and above (and the original Event Pass).
  const BRANDING_PLANS = ['open', 'championship', 'pass'];
  const paidPlan = (t) => !billingConfig().enabled || t.plan !== 'free' || Boolean(t.official);
  // t.orgBranding: the tournament's academy page includes branding (see withOrgBranding).
  const brandingAllowed = (t) => !billingConfig().enabled || BRANDING_PLANS.includes(t.plan) || Boolean(t.official) || Boolean(t.orgBranding);
  async function withOrgBranding(q, t) {
    const link = await orgs.forTournament(q, t.org_id);
    t.orgBranding = link.branding;
    return link;
  }
  const BRANDING_UPSELL = 'Your logo, colours and sponsors come with the Open plan or above';

  // What the public page shows (and, for organisers, everything uploaded).
  function pageContent(t, media, access) {
    const paid = brandingAllowed(t);
    const of = (kind) => media.filter((m) => m.kind === kind);
    const photoLimit = paidPlan(t) ? PHOTO_LIMITS.paid : PHOTO_LIMITS.free;
    const logo = of('logo')[0];
    const cover = of('cover')[0];
    const qr = of('qr')[0];
    const photo = (m, i) => ({ id: m.id, url: mediaUrl(m.id), caption: m.caption, ...(access.can.manage && { hidden: i >= photoLimit }) });
    const branding = t.branding || {};
    return {
      about: t.about,
      // How players pay the organiser (when an event has an entry fee).
      payment: { ...(t.payment || {}), holdHours: (t.payment && t.payment.holdHours) ?? DEFAULT_HOLD_HOURS, qr: qr ? mediaUrl(qr.id) : null, qrId: qr ? qr.id : null },
      perks: t.perks || { items: [], other: [] },
      notes: t.notes,
      pageLinks: t.links || {}, // website / Instagram / WhatsApp (not the share links)
      cover: cover ? mediaUrl(cover.id) : null,
      photos: (access.can.manage ? of('photo') : of('photo').slice(0, photoLimit)).map(photo),
      // Organiser branding and sponsors come with a paid plan; kept but hidden otherwise.
      branding: paid && (branding.orgName || branding.accent || logo)
        ? { orgName: branding.orgName || null, accent: branding.accent || null, logo: logo ? mediaUrl(logo.id) : null }
        : null,
      sponsors: paid ? of('sponsor').map((m) => ({ id: m.id, url: mediaUrl(m.id), caption: m.caption })) : [],
      // Open and above: the organiser leads on the venue display, Tonament is a small "Powered by"
      // (Tonament's own tournaments keep the full Tonament look).
      whiteLabel: (BRANDING_PLANS.includes(t.plan) || Boolean(t.orgBranding)) && !t.official,
      ...(access.can.manage && {
        brandingAllowed: paid,
        brandingPlan: 'open',
        brandingSettings: { orgName: branding.orgName || '', accent: branding.accent || '', logo: logo ? mediaUrl(logo.id) : null, logoId: logo?.id ?? null },
        coverId: cover?.id ?? null,
        allSponsors: of('sponsor').map((m) => ({ id: m.id, url: mediaUrl(m.id), caption: m.caption })),
        mediaLimits: { photos: photoLimit, sponsors: paid ? SPONSOR_LIMIT : 0 },
      }),
    };
  }

  async function uploadMedia(id, actor, input = {}) {
    const kind = input.kind;
    if (!MEDIA_KINDS.includes(kind)) fail(400, 'kind must be logo, cover, photo or sponsor');
    const raw = typeof input.data === 'string' ? input.data.replace(/^data:[^,]*,/, '') : '';
    const bytes = Buffer.from(raw, 'base64');
    if (!bytes.length) fail(400, 'Choose an image to upload');
    if (bytes.length > MAX_IMAGE_BYTES) fail(413, 'That image is too large — try a smaller one');
    const mime = imageType(bytes);
    if (!mime) fail(400, 'Upload a JPEG, PNG or WebP image');
    if (kind === 'preview' && (mime === 'image/webp' || bytes.length > MAX_PREVIEW_BYTES)) fail(400, 'The preview image must be a JPEG or PNG under 600 KB');
    const caption = text(input.caption, 'Caption', { max: 120, optional: true });
    return mutate(id, actor, async (q, t) => {
      const paid = paidPlan(t);
      await withOrgBranding(q, t);
      if ((kind === 'logo' || kind === 'sponsor') && !brandingAllowed(t)) fail(402, BRANDING_UPSELL, 'upgrade');
      const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM media WHERE tournament_id = $1 AND kind = $2', [t.id, kind]);
      if (kind === 'photo' && n >= (paid ? PHOTO_LIMITS.paid : PHOTO_LIMITS.free)) {
        fail(402, paid ? `You can add up to ${PHOTO_LIMITS.paid} photos` : `The free plan includes ${PHOTO_LIMITS.free} photos — a paid plan allows up to ${PHOTO_LIMITS.paid}`, paid ? undefined : 'upgrade');
      }
      if (kind === 'sponsor' && n >= SPONSOR_LIMIT) fail(409, `You can add up to ${SPONSOR_LIMIT} sponsor logos`);
      // One logo, cover and preview: a new upload replaces the old one (a new cover, its preview too).
      if (['logo', 'cover', 'preview', 'qr'].includes(kind)) await q('DELETE FROM media WHERE tournament_id = $1 AND kind = $2', [t.id, kind]);
      if (kind === 'cover') await q(`DELETE FROM media WHERE tournament_id = $1 AND kind = 'preview'`, [t.id]);
      const mediaId = crypto.createHash('sha256').update(`${t.id}:${kind}:`).update(bytes).digest('hex').slice(0, 32);
      const [{ next }] = await q('SELECT COALESCE(MAX(position), -1)::int + 1 AS next FROM media WHERE tournament_id = $1 AND kind = $2', [t.id, kind]);
      await q(
        `INSERT INTO media (id, tournament_id, kind, mime, bytes, caption, position) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [mediaId, t.id, kind, mime, bytes, caption, next],
      );
    });
  }

  // Caption, or move one place up/down in its list.
  async function updateMedia(id, actor, mediaId, input = {}) {
    return mutate(id, actor, async (q, t) => {
      const [m] = await q('SELECT * FROM media WHERE id = $1 AND tournament_id = $2', [mediaId, t.id]);
      if (!m) fail(404, 'Image not found');
      if (input.caption !== undefined) {
        await q('UPDATE media SET caption = $1 WHERE id = $2', [text(input.caption, 'Caption', { max: 120, optional: true }), m.id]);
      }
      if (input.move === -1 || input.move === 1) {
        const list = await q('SELECT id FROM media WHERE tournament_id = $1 AND kind = $2 ORDER BY position, created_at', [t.id, m.kind]);
        const i = list.findIndex((x) => x.id === m.id);
        const j = i + input.move;
        if (j >= 0 && j < list.length) {
          [list[i], list[j]] = [list[j], list[i]];
          for (const [pos, x] of list.entries()) await q('UPDATE media SET position = $1 WHERE id = $2', [pos, x.id]);
        }
      }
    });
  }

  // Organisers delete their images; site admins can delete any (moderation).
  async function deleteMedia(id, actor, mediaId) {
    return mutate(id, actor, async (q, t) => { // site admins count as organisers everywhere
      const rows = await q('DELETE FROM media WHERE id = $1 AND tournament_id = $2 RETURNING kind', [mediaId, t.id]);
      if (!rows.length) fail(404, 'Image not found');
      if (rows[0].kind === 'cover') await q(`DELETE FROM media WHERE tournament_id = $1 AND kind = 'preview'`, [t.id]);
    });
  }

  // An image for /api/media/:id. Private tournaments' images are for the team only.
  async function getMedia(mediaId, actorOf) {
    const [m] = await db.query(
      `SELECT m.mime, m.bytes, t.id AS tid, t.visibility, t.admin_key, t.scorer_key
       FROM media m JOIN tournaments t ON t.id = m.tournament_id WHERE m.id = $1`,
      [mediaId],
    );
    if (!m) return (await orgs.getMedia(mediaId)) || (await profiles.getMedia(mediaId)) || fail(404, 'Not found'); // an academy page's or a player's image
    if (m.visibility === 'private') {
      const access = await accessOf(db.query, { id: m.tid, admin_key: m.admin_key, scorer_key: m.scorer_key }, await actorOf());
      if (!access.score) fail(404, 'Not found');
    }
    return { mime: m.mime, bytes: Buffer.from(m.bytes), public: m.visibility !== 'private' };
  }

  // ---------- tournament pages, link previews (WhatsApp, Instagram, …), sitemap

  // A tournament page's data: the public view and its preview (name, one-line
  // summary, image). { private: true } for private ones; null if unknown.
  async function tournamentPage(id) {
    let t;
    try {
      t = await getTournament(id);
    } catch (err) {
      if (err.status === 404) return err.code === 'private' ? { private: true } : null;
      throw err;
    }
    const [preview] = await db.query(`SELECT id FROM media WHERE tournament_id = $1 AND kind = 'preview' LIMIT 1`, [t.id]);
    return {
      t,
      preview: {
        id: t.id,
        title: t.name,
        description: pages.summary(t),
        // The 1200×630 preview, else the cover itself.
        image: preview ? { path: mediaUrl(preview.id), width: 1200, height: 630 } : t.cover ? { path: t.cover } : null,
      },
    };
  }

  async function sharePreview(id) {
    const page = await tournamentPage(id);
    return page && page.t ? page.preview : null;
  }

  // Public tournaments for the sitemap, most recently active first.
  async function sitemapTournaments() {
    const rows = await db.query(
      `SELECT t.id, GREATEST(t.created_at, (SELECT MAX(m.updated_at) FROM matches m WHERE m.tournament_id = t.id)) AS lastmod
       FROM tournaments t WHERE t.visibility = 'public' ORDER BY lastmod DESC LIMIT 45000`,
    );
    return rows.map((r) => ({ path: `/t/${r.id}`, lastmod: new Date(r.lastmod).toISOString().slice(0, 10) }));
  }

  // Cities worth a page of their own (/<sport>/<city>): at least 2 public
  // tournaments in the last year (or coming up), or a public venue/academy page.
  // [{ sport, city, tournaments, orgs }], busiest first.
  async function cityPlaces() {
    const rows = await db.query(
      `SELECT t.sport, min(t.city) AS city, COUNT(*)::int AS n FROM tournaments t
       WHERE t.visibility = 'public' AND COALESCE(t.city, '') <> ''
         AND COALESCE(t.ends_on, t.starts_on, to_char(t.created_at, 'YYYY-MM-DD')) > to_char(now() - interval '365 days', 'YYYY-MM-DD')
       GROUP BY t.sport, lower(t.city)`,
    );
    const key = (sport, city) => `${sport}|${city.toLowerCase()}`;
    const out = new Map();
    for (const r of rows) out.set(key(r.sport, r.city), { sport: r.sport, city: r.city, tournaments: r.n, orgs: 0 });
    for (const r of await orgs.cityCounts()) {
      const k = key(r.sport, r.city);
      out.set(k, { ...(out.get(k) || { sport: r.sport, city: r.city, tournaments: 0 }), orgs: r.n });
    }
    return [...out.values()].filter((x) => sports.get(x.sport) && (x.tournaments >= 2 || x.orgs >= 1))
      .sort((a, b) => b.tournaments + b.orgs - (a.tournaments + a.orgs) || a.city.localeCompare(b.city));
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
    if (['1', 'true'].includes(f('prizes'))) where.push(`${PRIZE_TOTAL_SQL} > 0`);
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
      : 't.starts_on ASC NULLS LAST, t.start_time ASC NULLS LAST, t.created_at DESC';
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
      if (actor.user?.isAdmin) await adminLog(q, actor, 'tournament.visibility', t.id, { name: t.name, from: t.visibility, to: visibility });
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
    const events = list.map((e) => ({ ...eventFields({ ...e }, undefined, sport.id), format: FORMATS[e.format] ? e.format : format }));
    const listed = new Set();
    for (const e of events) {
      const label = catalog.eventName(e);
      if (listed.has(label.toLowerCase())) fail(409, `${label} is listed twice`);
      listed.add(label.toLowerCase());
    }
    const id = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;
    const adminKey = crypto.randomBytes(18).toString('base64url');
    const scorerKey = crypto.randomBytes(18).toString('base64url');
    let gift = null;
    await db.tx(async (q) => {
      await q(
        `INSERT INTO tournaments (id, name, sport, format, config, admin_key, scorer_key, visibility)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [id, name, sport.id, format, JSON.stringify(config), adminKey, scorerKey, visibility],
      );
      await saveDetails(q, { id }, details);
      for (const [i, e] of events.entries()) await insertEvent(q, id, i, e, eventConfigOf(config));
      await q(`INSERT INTO members (tournament_id, email, role) VALUES ($1, $2, 'owner')`, [id, actor.user.email]);
      // Invited by a friend? Their first tournament starts on the Club plan.
      gift = await referrals.useWelcome(q, actor.user, id);
    });
    return { id, ...(gift && { gift }) };
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
      if (input.about !== undefined) {
        const about = typeof input.about === 'string' ? input.about.trim().replace(/\r\n/g, '\n') : '';
        if (about.length > 2000) fail(400, 'About must be at most 2,000 characters');
        await q('UPDATE tournaments SET about = $1 WHERE id = $2', [about || null, t.id]);
      }
      if (input.payment !== undefined) {
        await q('UPDATE tournaments SET payment = $1::jsonb WHERE id = $2', [JSON.stringify(paymentSettings(input.payment)), t.id]);
      }
      if (input.courts !== undefined) {
        await q('UPDATE tournaments SET courts = $1::jsonb WHERE id = $2', [JSON.stringify(courtSettings(input.courts, t)), t.id]);
      }
      if (input.perks !== undefined) {
        const p = input.perks || {};
        const items = Array.isArray(p.items) ? [...new Set(p.items)] : [];
        const unknown = items.find((k) => !catalog.PERKS[k]);
        if (unknown) fail(400, `Unknown item: ${unknown}`);
        const other = (Array.isArray(p.other) ? p.other : []).map((x) => (typeof x === 'string' ? x.trim().replace(/\s+/g, ' ') : '')).filter(Boolean);
        if (other.length > 5) fail(400, 'Add up to 5 other items');
        if (other.some((x) => x.length > 40)) fail(400, 'Other items must be at most 40 characters each');
        await q('UPDATE tournaments SET perks = $1::jsonb WHERE id = $2', [JSON.stringify({ items, other }), t.id]);
      }
      if (input.notes !== undefined) {
        const notes = typeof input.notes === 'string' ? input.notes.trim().replace(/\r\n/g, '\n') : '';
        if (notes.length > 2000) fail(400, 'Other details must be at most 2,000 characters');
        await q('UPDATE tournaments SET notes = $1 WHERE id = $2', [notes || null, t.id]);
      }
      if (input.pageLinks !== undefined) {
        const l = input.pageLinks || {};
        const links = {
          website: linkOf(l.website, 'Website'),
          instagram: linkOf(l.instagram, 'Instagram', 'instagram.com'),
          whatsapp: linkOf(l.whatsapp, 'WhatsApp group', 'chat.whatsapp.com'),
        };
        await q('UPDATE tournaments SET links = $1::jsonb WHERE id = $2', [JSON.stringify(links), t.id]);
      }
      if (input.branding !== undefined) {
        const b = input.branding || {};
        const orgName = text(b.orgName, 'Organiser name', { max: 60, optional: true });
        const accent = b.accent ? String(b.accent).trim() : null;
        if (accent && !HEX_COLOUR.test(accent)) fail(400, 'Brand colour must be a hex colour like #F97316');
        await withOrgBranding(q, t);
        if ((orgName || accent) && !brandingAllowed(t)) fail(402, BRANDING_UPSELL, 'upgrade');
        await q('UPDATE tournaments SET branding = $1::jsonb WHERE id = $2', [JSON.stringify({ orgName, accent: accent && accent.toUpperCase() }), t.id]);
      }
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

  // The wrong match length (or points) chosen, found out once it's being
  // played: change it safely. Finished matches keep the rules they were played
  // under (matches.rules), a match in progress follows the new rules from now
  // (one they already decide ends now), and the rest are played to them.
  async function planScoringChange(q, t, input) {
    if (t.status === 'setup') fail(409, 'The event hasn\'t started — change it in Event settings');
    if (t.status === 'completed') fail(409, 'The event has finished');
    const next = buildConfig({ scoring: input.scoring, ...(input.leagueDraws !== undefined && { leagueDraws: input.leagueDraws }) }, t.sportDef, t.config);
    const old = { scoring: t.config.scoring, leagueDraws: Boolean(t.config.leagueDraws) };
    const same = (x, y) => { const k = (o) => JSON.stringify(Object.keys(o).sort().map((key) => [key, o[key]])); return k(x) === k(y); };
    if (same(next.scoring, t.sportDef.normalizeConfig(old.scoring)) && Boolean(next.leagueDraws) === old.leagueDraws) fail(400, 'That\'s how it is already');
    const after = { ...t, config: { ...t.config, scoring: next.scoring, leagueDraws: Boolean(next.leagueDraws) } };
    const rows = await q('SELECT * FROM matches WHERE event_id = $1 ORDER BY stage, round, slot', [t.eventId]);
    const names = new Map((await q('SELECT id, name FROM entries WHERE event_id = $1', [t.eventId])).map((e) => [e.id, e.name]));
    const report = { finished: 0, endsNow: [], inProgress: 0, toCome: 0 };
    const ends = [];
    for (const m of rows) {
      if (m.status === 'bye') continue;
      if (m.status === 'done') { report.finished += 1; continue; }
      if (!m.rallies) { report.toCome += 1; continue; }
      // The first point at which the new rules decide it, if they do.
      let at = 0;
      for (let k = 1; k <= m.rallies.length; k++) {
        if (league.finished(scoreOf(after, { ...m, rules: null }, m.rallies.slice(0, k)))) { at = k; break; }
      }
      if (at) {
        ends.push({ m, at });
        report.endsNow.push(`${names.get(m.a_id) || '?'} v ${names.get(m.b_id) || '?'}`);
      } else report.inProgress += 1;
    }
    return { after, old, report, ends };
  }
  async function previewScoringChange(id, actor, input = {}) {
    return db.tx(async (q) => {
      const { t: tournament } = await lockWith(q, id, actor, 'manage');
      return (await planScoringChange(q, await eventFor(q, tournament, input.event), input)).report;
    });
  }
  async function changeScoring(id, actor, input = {}) {
    return mutate(id, actor, async (q, tournament) => {
      const t = await eventFor(q, tournament, input.event);
      const { after, old, ends } = await planScoringChange(q, t, input);
      await q(`UPDATE matches SET rules = $1::jsonb WHERE event_id = $2 AND status = 'done' AND rules IS NULL`, [JSON.stringify(old), t.eventId]);
      after.config.scoringChanged = { at: new Date().toISOString(), from: old.scoring };
      await saveEventConfig(q, after);
      for (const { m, at } of ends) await saveRallies(q, tournament, after, m, m.rallies.slice(0, at));
    });
  }

  // Format, scoring, caps and the category of one event. Only the late-entry
  // switch can change once the event has started.
  async function applyEventSettings(q, ev, input) {
    const keys = Object.keys(input).filter((k) => input[k] !== undefined && (EVENT_KEYS.includes(k) || k === 'name' || k === 'fee'));
    if (ev.status !== 'setup' && keys.some((k) => !LIVE_EVENT_KEYS.includes(k))) {
      fail(409, 'Settings are locked once the tournament has started');
    }
    // Fees can change on the day (spot entries pay then), except for events
    // paid online, and not once the event is over.
    const feeChange = input.fee !== undefined || input.feePer !== undefined;
    if (feeChange && ev.status !== 'setup' && (PAY_ONLINE(ev) || ev.status === 'completed')) {
      fail(409, PAY_ONLINE(ev) ? 'Online entry fees are fixed once the event starts' : 'The event has finished');
    }
    if (input.format !== undefined && !FORMATS[input.format]) fail(400, 'Unknown format');
    // Ties: which matches make up a tie, and whether all are played.
    if (input.tie !== undefined) {
      if ((input.discipline ?? ev.event.discipline) !== 'team' || !catalog.hasTies(ev.sportDef.id)) fail(400, 'Tie formats are for team events in racket sports');
      try { input.tie = TIE.normalize(input.tie); } catch (err) { fail(400, err.message); }
    }
    const format = input.format ?? ev.format;
    const config = buildConfig(input, ev.sportDef, ev.config);
    if (input.tie !== undefined) config.tie = input.tie;
    if (input.maxEntries !== undefined) checkMaxEntries(config, ev.plan);
    if (input.partners !== undefined) {
      if (!['own', 'drawn'].includes(input.partners)) fail(400, 'partners must be "own" or "drawn"');
      config.partners = input.partners;
    }
    if (input.balancePairs !== undefined) config.balancePairs = Boolean(input.balancePairs);
    // Team events can charge per player (₹200 a player) instead of per team.
    if (input.feePer !== undefined) {
      if (!['entry', 'player'].includes(input.feePer)) fail(400, 'feePer must be "entry" or "player"');
      if (input.feePer === 'player' && (input.discipline ?? ev.event.discipline) !== 'team') fail(400, 'A fee per player is for team events');
      if (input.feePer === 'player' && PAY_ONLINE(ev)) fail(400, 'Online fees are per team');
      config.feePer = input.feePer;
    }
    // Level pools: an Open event split by level, the pools meeting in the
    // final (two) or the semis (one per level, for 4 levels).
    if (input.pools !== undefined) {
      const pools = input.pools || null;
      if (pools && !['two', 'levels'].includes(pools)) fail(400, 'pools must be "two" or "levels"');
      if (pools && catalog.isTeamSport(ev.sportDef.id)) fail(400, 'Level pools are for singles and doubles events');
      if (pools && format !== 'league_knockout') fail(400, 'Level pools need the League + Knockout format');
      config.pools = pools;
      config.poolOrder = null;
    }
    if (input.poolOrder !== undefined) {
      if (['knockout', 'completed'].includes(ev.status)) fail(409, 'The knockout has started — the pairings are set');
      const order = input.poolOrder;
      if (order !== null && (!Array.isArray(order) || order.length > 12 || !order.every((k) => typeof k === 'string' && k.length <= 40))) fail(400, 'poolOrder must be a list of pools');
      config.poolOrder = order;
    }
    if (format !== 'league_knockout') config.pools = null;
    if (input.ranked !== undefined) config.ranked = Boolean(input.ranked);
    if (input.dupr !== undefined || input.duprMin !== undefined || input.duprMax !== undefined) {
      if (ev.sportDef.id !== 'pickleball') fail(400, 'DUPR settings are for pickleball events');
      if (input.dupr !== undefined) {
        if (!['off', 'ask', 'required'].includes(input.dupr)) fail(400, 'dupr must be off, ask or required');
        config.dupr = input.dupr;
      }
      if (input.duprMin !== undefined) config.duprMin = dupr.checkRating(input.duprMin, fail);
      if (input.duprMax !== undefined) config.duprMax = dupr.checkRating(input.duprMax, fail);
      if (config.duprMin != null && config.duprMax != null && config.duprMin > config.duprMax) fail(400, 'The lowest DUPR rating must be below the highest');
    }
    if (input.prizes !== undefined) config.prizes = prizesOf(input.prizes);
    if (input.fee !== undefined) {
      const fee = int(input.fee === '' || input.fee === null ? 0 : input.fee, 0, MAX_FEE, 0, 'Entry fee (in paise)');
      config.fee = fee;
    }
    const f = eventFields(input, ev.event, ev.sport);
    await q(
      `UPDATE events SET format = $1, config = $2::jsonb, discipline = $3, gender = $4, age = $5, level = $6, name = $7 WHERE id = $8`,
      [format, JSON.stringify(eventConfigOf(config)), f.discipline, f.gender, f.age, f.level, f.name, ev.eventId],
    );
    await syncTournament(q, ev.id);
    // A new fee applies to everyone who hasn't paid yet (paid, waived or
    // "sent" entries keep what they paid or were asked for).
    if (feeChange && !PAY_ONLINE(ev)) {
      const next = { ...ev, config };
      const unpaid = await q(`SELECT e.id, e.solo, (SELECT COUNT(*)::int FROM entry_players p WHERE p.entry_id = e.id) AS n FROM entries e
        WHERE e.event_id = $1 AND (e.fee_status IS NULL OR e.fee_status = 'due') AND e.paired_into IS NULL`, [ev.eventId]);
      for (const e of unpaid) {
        const owed = !feeOf(next) ? 0 : e.solo ? Math.ceil(feeOf(next) / 2) // a solo player pays half the pair fee
          : e.n && next.config.feePer === 'player' ? entryFeeFor(next, e.n) : feeOf(next);
        await q('UPDATE entries SET fee_amount = $1, fee_status = CASE WHEN $1::int = 0 THEN NULL ELSE fee_status END WHERE id = $2', [owed, e.id]);
      }
    }
    if (input.ranked !== undefined && ev.status === 'completed') await recordResults(q, { ...ev, config }); // points on or off
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
        const f = eventFields(raw || {}, undefined, t.sport);
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
        const f = eventFields(input, ev.event, ev.sport);
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
      if (actor.user?.isAdmin) await adminLog(q, actor, 'tournament.delete', t.id, { name: t.name });
      return { ok: true };
    });
  }

  // ---------- entries

  function requireSetup(t) {
    if (t.status !== 'setup') fail(409, 'Entries are locked once the tournament has started');
  }

  // A player's level ('Beginner', …) from the sport's list; '' or null clears it.
  function levelIn(t, value) {
    if (!given(value)) return null;
    const levels = catalog.entryLevels(t.sportDef.id);
    const hit = levels.find((l) => l.toLowerCase() === String(value).trim().toLowerCase());
    if (!hit) fail(400, `Level: one of ${levels.join(', ')}`);
    return hit;
  }
  const poolsOn = (t) => t.format === 'league_knockout' && Boolean(t.config.pools);

  async function addEntries(id, actor, names, { walkIn = false, level = null, event } = {}) {
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
      const lv = levelIn(t, level);
      for (const n of clean) {
        await insertEntry(q, t, { name: n, seed: ++seed, source: walkIn ? 'walk-in' : 'organiser', checkedIn: Boolean(walkIn), level: lv });
      }
    });
  }

  // An optional phone number for the organisers.
  function phoneOf(value) {
    if (!given(value)) return null;
    const phone = String(value).replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 7 || phone.length > 20) fail(400, 'Enter a valid phone number');
    return phone;
  }

  const multiEventLabel = (t) => eventLabel(t);

  // Pickleball events can ask for (or require) DUPR IDs and limit ratings.
  // Returns the DUPR IDs to keep with the entry.
  async function duprCheck(q, t, actor, input, { partnerMail }) {
    if (t.sportDef.id !== 'pickleball') return { own: null, partner: null };
    const mode = t.config.dupr || 'off';
    const [me] = await q('SELECT dupr_id, dupr_singles, dupr_doubles FROM users WHERE id = $1', [actor.user.id]);
    const own = given(input.duprId) ? dupr.checkId(input.duprId, fail) : me?.dupr_id || null;
    const [mate] = partnerMail ? await q('SELECT dupr_id, dupr_singles, dupr_doubles FROM users WHERE email = $1', [partnerMail]) : [];
    const partner = given(input.partnerDuprId) ? dupr.checkId(input.partnerDuprId, fail) : mate?.dupr_id || null;
    const doubles = t.event.discipline === 'doubles' && !input.solo && t.config.partners !== 'drawn';
    if (mode === 'required') {
      if (!own) fail(400, `${eventLabel(t)} needs your DUPR ID`, 'dupr');
      if (doubles && !partner) fail(400, `${eventLabel(t)} needs your partner's DUPR ID too`, 'dupr');
    }
    if (mode !== 'off' && own && own !== me?.dupr_id && !me?.dupr_id) await q('UPDATE users SET dupr_id = $1 WHERE id = $2', [own, actor.user.id]);
    const { duprMin: lo, duprMax: hi } = t.config;
    if (lo != null || hi != null) {
      const key = t.event.discipline === 'singles' ? 'dupr_singles' : 'dupr_doubles';
      const word = t.event.discipline === 'singles' ? 'singles' : 'doubles';
      const range = lo != null && hi != null ? `${lo.toFixed(2)}–${hi.toFixed(2)}` : lo != null ? `${lo.toFixed(2)} and above` : `up to ${hi.toFixed(2)}`;
      const check = (row, who) => {
        const r = row && row[key] != null ? Number(row[key]) : null;
        if (r == null) fail(400, `${eventLabel(t)} is for DUPR ${range} — add ${who === 'you' ? 'your' : 'your partner\'s'} ${word} rating to ${who === 'you' ? 'your' : 'their'} Tonament profile first`, 'dupr');
        if ((lo != null && r < lo) || (hi != null && r > hi)) fail(400, `${eventLabel(t)} is for DUPR ${range} — ${who === 'you' ? 'your' : 'your partner\'s'} ${word} rating is ${r.toFixed(2)}`, 'dupr');
      };
      check(me, 'you');
      if (doubles && mate) check(mate, 'partner');
    }
    return { own, partner };
  }

  // Public self-entry ("Enter this tournament"): players sign in first, and
  // the entry belongs to their account (one per event); the account email is
  // the contact. Closes at the deadline or when the draw is made. Past the
  // tournament's capacity the entry is saved unconfirmed, and the owner is
  // emailed (once) that players are waiting.
  async function register(id, actor, input = {}, { baseUrl } = {}) {
    if (given(input.website)) return { ok: true }; // honeypot: bots fill every field
    if (!actor || !actor.user) fail(401, 'Sign in to enter');
    const userId = actor.user.id;
    const contact = normalizeEmail(actor.user.email);
    const phone = phoneOf(input.phone);
    const result = await db.tx(async (q) => {
      const row = await load(q, id, { lock: true });
      await requireVisible(q, row, null);
      const t = await eventFor(q, row, input.event);
      const team = t.event.discipline === 'team';
      const player = text(given(input.name) || team ? input.name : actor.user.name, team ? 'Team name' : 'Your name', { max: 40 });
      const partner = text(input.partner, 'Partner name', { max: 40, optional: true });
      if (team && partner) fail(400, `${eventLabel(t)} is a team event — enter your team's name`);
      const partnerMail = given(input.partnerEmail) ? normalizeEmail(input.partnerEmail) : null;
      if (partnerMail && !validEmail(partnerMail)) fail(400, 'Partner\'s email: enter a valid email address');
      if (partnerMail && partnerMail === contact) fail(400, 'Partner\'s email: that\'s your own email');
      const players = team ? playersOf(input.players) : null;
      // "Your level" in an Open event (optional), so organisers can split by level.
      const selfLevel = team ? null : levelIn(t, input.level);
      const doubles = t.event.discipline === 'doubles';
      const drawn = doubles && t.config.partners === 'drawn';
      const solo = doubles && (drawn || Boolean(input.solo));
      if (input.solo && !doubles) fail(400, `${eventLabel(t)} isn't a doubles event`);
      if (drawn && partner) fail(400, `Partners are drawn for ${eventLabel(t)} — enter on your own`);
      const side = solo && t.event.gender === 'mixed' ? input.side : null;
      if (solo && t.event.gender === 'mixed' && !['man', 'woman'].includes(side)) fail(400, 'Mixed doubles: say whether you\'re playing as a man or a woman');
      // A solo player pays half the pair fee.
      const fee = solo ? Math.ceil(feeOf(t) / 2) : feeOf(t);
      const online = fee > 0 && PAY_ONLINE(t);
      if (online) {
        if (!billingConfig().enabled) fail(503, 'Online payment isn\'t available right now — contact the organiser');
        await clearExpiredPending(q, t);
        // Starting again replaces your own unfinished payment.
        await q(`DELETE FROM entries WHERE event_id = $1 AND user_id = $2 AND fee_status = 'pending'`, [t.eventId, userId]);
      }
      // Doubles need a partner; singles ignore one.
      if (doubles && !solo && !partner) fail(400, `${eventLabel(t)} is a doubles event — add your partner's name, or ask us to find you one`);
      const name = partner && !solo && t.event.discipline !== 'singles' ? `${player} / ${partner}` : player;
      if (t.status !== 'setup') fail(409, 'Entries are closed — the draw has been made');
      const duprIds = await duprCheck(q, t, actor, input, { partnerMail: partner && !solo ? partnerMail : null });
      // A team's roster starts with its captain (who enters it) and the players listed.
      const captainName = actor.user.name;
      const people = team ? [
        { name: captainName, email: contact, captain: true },
        ...(players || []).filter((n) => n.toLowerCase() !== String(captainName).toLowerCase()).map((name) => ({ name })),
      ] : [
        { name: player, email: contact, duprId: duprIds.own },
        ...(partner && !solo && doubles ? [{ name: partner, email: partnerMail, duprId: duprIds.partner }] : []),
      ];
      const linkPeople = async (rowsOrId) => profiles.setPeople(q, Array.isArray(rowsOrId) ? rowsOrId[0].id : rowsOrId, people);
      if (!t.config.selfEntry) fail(409, 'This tournament doesn\'t take entries online — contact the organiser');
      if (!entriesOpen(t)) fail(409, 'Entries are closed');
      const existing = await entriesOf(q, t);
      if (existing.length >= MAX_ENTRIES) fail(409, 'This event is full');
      // One entry per account (paired solo players aren't in entriesOf but still count),
      // and older entries made with the same email before accounts were needed.
      const [used] = await q('SELECT 1 FROM entries WHERE event_id = $1 AND (user_id = $2 OR (user_id IS NULL AND contact = $3))', [t.eventId, userId, contact]);
      if (used) fail(409, 'You\'ve already entered this event');
      if (existing.some((e) => e.name.toLowerCase() === name.toLowerCase())) fail(409, `"${name}" is already entered`);
      const seed = existing.reduce((max, e) => Math.max(max, e.seed), 0) + 1;
      const room = await hasRoom(q, t);
      if (online) {
        // Paid events never take a payment for a place that isn't there.
        if (!room) fail(409, `${eventLabel(t)} is full`);
        const [{ id: entryId }] = await insertEntry(q, t, { name, seed, source: 'self', contact, confirmed: false, feeStatus: 'pending', feeAmount: fee, solo, side, players, userId, phone, level: selfLevel });
        await linkPeople(entryId);
        const [pay] = await q(
          `INSERT INTO payments (tournament_id, tournament_name, user_email, amount, currency, kind, entry_id, event_id, event_name, player)
           VALUES ($1, $2, $3, $4, $5, 'entry', $6, $7, $8, $9) RETURNING id`,
          [t.id, t.name, contact, fee, billingConfig().currency, entryId, t.eventId, eventLabel(t), name],
        );
        return { t, name, entryId, paymentId: pay.id, fee, player, contact, solo, partnerMail: people[1]?.email };
      }
      if (fee) {
        // Paid to the organiser: the place is held for a while (if there is
        // one) and confirmed when the organiser has the money.
        const holdUntil = room ? holdTime(t) : new Date(); // no room: straight to the waitlist
        const due = team ? entryFeeFor(t, people.length) : fee; // per player for some team events
        await linkPeople(await insertEntry(q, t, { name, seed, source: 'self', contact, confirmed: false, feeStatus: 'due', feeAmount: due, solo, side, players, userId, phone, holdUntil, level: selfLevel }));
        return { t, name, confirmed: false, owners: [], eventId: t.eventId, solo, due, holding: room, partnerMail: people[1]?.email, player };
      }
      const confirmed = room;
      await linkPeople(await insertEntry(q, t, { name, seed, source: 'self', contact, confirmed, solo, side, players, userId, phone, level: selfLevel }));
      let owners = [];
      if (!confirmed && !t.waiting_notified) {
        await q('UPDATE tournaments SET waiting_notified = true WHERE id = $1', [t.id]);
        owners = (await q(`SELECT email FROM members WHERE tournament_id = $1 AND role = 'owner'`, [t.id])).map((r) => r.email);
      }
      return { t, name, confirmed, owners, eventId: t.eventId, solo, partnerMail: people[1]?.email, player };
    });
    if (result.partnerMail && mailer?.enabled && baseUrl) {
      await profiles.notifyPartner({ email: result.partnerMail, player: result.player, tournament: result.t.name, event: multiEventLabel(result.t), tournamentId: result.t.id, baseUrl });
    }
    if (result.paymentId) return startEntryPayment(result);
    const { t, name: entered, confirmed, owners, eventId } = result;
    if (owners.length && mailer?.enabled && baseUrl) {
      try {
        for (const to of owners) {
          await mailer.send({ to, ...waitingEmail({ tournament: t.name, player: entered, url: `${baseUrl}/t/${t.id}/entries` }) });
        }
      } catch (err) {
        console.error('Waiting-entries email failed:', err.message);
      }
    }
    return { ok: true, name: entered, confirmed, event: eventId, ...(result.solo && { solo: true }), ...(result.due && { due: result.due, holding: result.holding }) };
  }

  // ---------- pairing solo doubles players

  const shuffle = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // Turns two solo players into one pair entry (the solos stay, linked to it).
  async function makePair(q, t, a, b) {
    if (t.event.gender === 'mixed' && a.solo_side === b.solo_side) fail(409, 'Mixed doubles pairs need a man and a woman');
    const [{ id }] = await insertEntry(q, t, {
      name: `${a.name} / ${b.name}`,
      seed: Math.min(a.seed, b.seed),
      source: 'drawn',
      checkedIn: a.checked_in && b.checked_in,
    });
    await q('UPDATE entries SET paired_into = $1 WHERE id = ANY($2::int[])', [id, [a.id, b.id]]);
    await profiles.copyToPair(q, id, [a.id, b.id]);
    return id;
  }

  // Solo players ready to pair: confirmed, not paying, not paired yet.
  const pairable = async (q, t) => (await entriesOf(q, t)).filter((e) => e.solo && e.confirmed && e.fee_status !== 'pending');

  // Pairs every waiting solo player: at random, or balanced (best seed with
  // worst). Mixed doubles pairs men with women. Returns how many are left over.
  async function drawPairsIn(q, t, balance) {
    const pool = await pairable(q, t);
    const bySeed = (list) => [...list].sort((x, y) => x.seed - y.seed || x.id - y.id);
    const pairs = [];
    if (t.event.gender === 'mixed') {
      let men = pool.filter((e) => e.solo_side === 'man');
      let women = pool.filter((e) => e.solo_side === 'woman');
      if (balance) {
        men = bySeed(men);
        women = bySeed(women).reverse();
      } else {
        men = shuffle(men);
        women = shuffle(women);
      }
      for (let i = 0; i < Math.min(men.length, women.length); i++) pairs.push([men[i], women[i]]);
    } else {
      const list = balance ? bySeed(pool) : shuffle(pool);
      if (balance) for (let i = 0; i < Math.floor(list.length / 2); i++) pairs.push([list[i], list[list.length - 1 - i]]);
      else for (let i = 0; i + 1 < list.length; i += 2) pairs.push([list[i], list[i + 1]]);
    }
    for (const [a, b] of pairs) await makePair(q, t, a, b);
    return pool.length - pairs.length * 2;
  }

  async function pairSolos(id, actor, aId, bId) {
    return mutateEntry(id, actor, aId, async (q, t) => {
      requireSetup(t);
      const pool = await pairable(q, t);
      const a = pool.find((e) => e.id === Number(aId));
      const b = pool.find((e) => e.id === Number(bId));
      if (!a || !b || a.id === b.id) fail(409, 'Choose two different players who are looking for a partner');
      await makePair(q, t, a, b);
    });
  }

  async function drawPairs(id, actor, { event, balance = false } = {}) {
    return mutateEvent(id, actor, event, async (q, t) => {
      requireSetup(t);
      if (t.event.discipline !== 'doubles') fail(409, 'Only doubles events have partners to draw');
      await drawPairsIn(q, t, Boolean(balance));
    });
  }

  async function unpair(id, actor, pairId) {
    return mutateEntry(id, actor, pairId, async (q, t) => {
      requireSetup(t);
      const [e] = await q('SELECT source FROM entries WHERE id = $1', [Number(pairId)]);
      if (e.source !== 'drawn') fail(409, 'Only drawn pairs can be split');
      await q('UPDATE entries SET paired_into = NULL WHERE paired_into = $1', [Number(pairId)]);
      await q('DELETE FROM entries WHERE id = $1', [Number(pairId)]);
    });
  }

  // Creates the Razorpay order for a paid self-entry. The entry stays
  // pending until verifyPayment (or the webhook) confirms the payment.
  async function startEntryPayment({ t, name, entryId, paymentId, fee, player, contact, solo }) {
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
        description: `Entry fee${solo ? ' (half of the pair fee)' : ''} — ${eventLabel(t)}, ${t.name}`.slice(0, 250),
        prefill: { name: player, email: contact },
      },
    };
  }

  // When an unpaid entry stops holding its place: the tournament's hold time
  // (24 or 48 hours, or until entries close), or null (held until the draw).
  function holdTime(t) {
    const hours = (t.payment && t.payment.holdHours) ?? DEFAULT_HOLD_HOURS;
    if (hours) return new Date(Date.now() + hours * 3600000);
    return t.config.entriesCloseAt ? new Date(t.config.entriesCloseAt) : null;
  }

  // The player says they've paid the organiser (optionally with the UPI reference).
  async function markFeeSent(id, actor, entryId, ref) {
    if (!actor.user) fail(401, 'Sign in to do that');
    const payRef = given(ref) ? String(ref).replace(/\s+/g, '') : null;
    if (payRef && !/^\d{12}$/.test(payRef)) fail(400, 'The UPI reference is the 12-digit number in your payment details');
    return db.tx(async (q) => {
      const row = await load(q, id, { lock: true });
      const [e] = await q('SELECT * FROM entries WHERE id = $1 AND tournament_id = $2', [Number(entryId) || 0, row.id]);
      if (!e || e.user_id !== actor.user.id) fail(404, 'Entry not found');
      if (e.fee_status !== 'due' && e.fee_status !== 'sent') fail(409, 'There\'s nothing to pay for this entry');
      // A place held when they paid stays held until the organiser checks.
      const holding = e.hold_until === null || e.hold_until > new Date();
      await q(`UPDATE entries SET fee_status = 'sent', pay_ref = COALESCE($1, pay_ref), pay_sent_at = now(), hold_until = $2 WHERE id = $3`, [
        payRef, holding ? null : e.hold_until, e.id,
      ]);
      return view(q, await load(q, id), actor);
    });
  }

  // Organisers record entry fees. Paid to them directly: 'received' (by UPI),
  // 'cash' or 'waived' confirm the place; 'missing' asks the player to check
  // (back to 'due', with a fresh hold). Tonament's own (online) events: 'cash',
  // 'waived', or null to undo.
  async function setEntryFee(id, actor, entryId, status, { baseUrl } = {}) {
    let mail = null;
    const result = await mutateEntry(id, actor, entryId, async (q, t) => {
      if (!feeOf(t)) fail(409, 'This event has no entry fee');
      if (!PAY_ONLINE(t)) {
        if (!['received', 'cash', 'waived', 'missing', null].includes(status ?? null)) fail(400, 'status must be "received", "cash", "waived" or "missing"');
        if (t.status === 'completed') fail(409, 'The event has finished');
        const [e] = await q('SELECT * FROM entries WHERE id = $1', [Number(entryId)]);
        // On the day (after the draw): just record the payment — places are already settled.
        if (t.status !== 'setup') {
          if (status === 'missing') fail(409, 'The draw has been made — mark it paid, or leave it unpaid');
          const owed = e.fee_amount || entryFeeFor(t, (await q('SELECT COUNT(*)::int AS n FROM entry_players WHERE entry_id = $1', [e.id]))[0].n);
          await q('UPDATE entries SET fee_status = $1, fee_amount = $2 WHERE id = $3', [status ?? null, status === 'waived' ? null : owed, e.id]);
          if (status) await q('UPDATE entry_players SET fee_status = $1 WHERE entry_id = $2 AND fee_status IS NULL', [status === 'waived' ? 'waived' : 'paid', e.id]);
          else await q('UPDATE entry_players SET fee_status = NULL WHERE entry_id = $1', [e.id]);
          return;
        }
        if (status === null) {
          // Undo a mark made by mistake: back to unpaid.
          if (!DIRECT_PAID.includes(e.fee_status)) fail(409, 'This entry isn\'t marked paid');
          await q(`UPDATE entries SET fee_status = $1, fee_amount = $2 WHERE id = $3`, [e.source === 'self' ? 'due' : null, e.fee_amount, e.id]);
          await q('UPDATE entry_players SET fee_status = NULL WHERE entry_id = $1', [e.id]);
          return;
        }
        if (DIRECT_PAID.includes(e.fee_status) && e.confirmed) fail(409, 'This entry is already paid and confirmed');
        if (status === 'missing') {
          if (e.fee_status !== 'sent') fail(409, 'The player hasn\'t said they paid yet');
          await q(`UPDATE entries SET fee_status = 'due', hold_until = $1 WHERE id = $2`, [holdTime(t), e.id]);
          mail = { kind: 'missing', to: e.user_id ? e.contact : null, t };
          return;
        }
        const holding = ['due', 'sent'].includes(e.fee_status) && (e.hold_until === null || e.hold_until > new Date());
        if (!holding && !(await hasRoom(q, t))) fail(409, `${eventLabel(t)} is full — raise its maximum or remove someone first`);
        await checkEntryLimit(q, t, 1);
        await q('UPDATE entries SET fee_status = $1, fee_amount = $2, confirmed = true, hold_until = NULL WHERE id = $3', [
          status, status === 'waived' ? null : e.fee_amount || entryFeeFor(t, (await q('SELECT COUNT(*)::int AS n FROM entry_players WHERE entry_id = $1', [e.id]))[0].n), e.id,
        ]);
        // Paid for the whole pair or team: every player is settled.
        await q('UPDATE entry_players SET fee_status = $1 WHERE entry_id = $2 AND fee_status IS NULL', [status === 'waived' ? 'waived' : 'paid', e.id]);
        mail = { kind: 'received', to: e.user_id ? e.contact : null, t, player: e.name };
        return;
      }
      if (![null, 'cash', 'waived'].includes(status ?? null)) fail(400, 'status must be "cash", "waived" or null');
      const [e] = await q('SELECT fee_status FROM entries WHERE id = $1', [Number(entryId)]);
      if (e.fee_status === 'paid') fail(409, 'Paid online — refunds are made in the Razorpay dashboard');
      if (e.fee_status === 'pending') fail(409, 'This player is paying online right now');
      await q('UPDATE entries SET fee_status = $1, fee_amount = $2 WHERE id = $3', [
        status ?? null, status === 'cash' ? feeOf(t) : null, Number(entryId),
      ]);
    });
    if (mail && mail.to && mailer?.enabled && baseUrl) {
      const event = (await eventsOf(db.query, mail.t.id)).length > 1 ? eventLabel(mail.t) : null;
      const url = `${baseUrl}/t/${mail.t.id}/entries${event ? `?e=${mail.t.eventId}` : ''}`;
      try {
        await mailer.send({
          to: mail.to,
          ...(mail.kind === 'received'
            ? feeReceivedEmail({ tournament: mail.t.name, event, player: mail.player, url })
            : feeMissingEmail({ tournament: mail.t.name, event, url })),
        });
      } catch (err) {
        console.error('Entry fee email failed:', err.message);
      }
    }
    return result;
  }

  // Site admins mark tournaments that Tonament itself runs; only those take entry fees online.
  async function setOfficial(id, actor, official) {
    requireSiteAdmin(actor);
    return mutate(id, actor, async (q, t) => {
      await q('UPDATE tournaments SET official = $1 WHERE id = $2', [Boolean(official), t.id]);
      await adminLog(q, actor, official ? 'tournament.official' : 'tournament.unofficial', t.id, { name: t.name });
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
      if (e.fee_status === 'due' || e.fee_status === 'sent') fail(409, 'Record their entry fee first: received, paid in cash, or waived');
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
      const [e] = await q('SELECT source, paired_into FROM entries WHERE id = $1', [Number(entryId) || 0]);
      if (e?.paired_into) fail(409, 'This player is in a drawn pair — split the pair first');
      await deleteEntry(q, t, entryId);
    });
  }

  async function deleteEntry(q, t, entryId) {
    const [e] = await q('SELECT source FROM entries WHERE id = $1', [Number(entryId) || 0]);
    if (e?.source === 'drawn') {
      // Removing a drawn pair splits it; both players go back to looking.
      await q('UPDATE entries SET paired_into = NULL WHERE paired_into = $1', [Number(entryId)]);
    }
    const deleted = await q('DELETE FROM entries WHERE id = $1 AND tournament_id = $2 RETURNING id', [Number(entryId) || 0, t.id]);
    if (!deleted.length) fail(404, 'Entry not found');
  }

  // A player withdraws their own entry, before the draw.
  async function leave(id, actor, entryId) {
    if (!actor.user) fail(401, 'Sign in to do that');
    return db.tx(async (q) => {
      const row = await load(q, id, { lock: true });
      const [e] = await q('SELECT * FROM entries WHERE id = $1 AND tournament_id = $2', [Number(entryId) || 0, row.id]);
      if (!e || e.user_id !== actor.user.id) fail(404, 'Entry not found');
      const t = await eventFor(q, row, e.event_id);
      if (t.status !== 'setup') fail(409, 'The draw has been made — ask the organiser to withdraw you');
      if (e.fee_status === 'paid' || e.fee_status === 'received' || e.fee_status === 'cash') fail(409, 'Contact the organiser to withdraw — refunds are handled by them');
      if (e.paired_into) {
        const [pair] = await q('SELECT name FROM entries WHERE id = $1', [e.paired_into]);
        const partner = pair ? pair.name.split(' / ').find((n) => n !== e.name) : null;
        fail(409, `You've been paired${partner ? ` with ${partner}` : ''} — ask the organiser to change it`);
      }
      await deleteEntry(q, t, e.id);
      return view(q, await load(q, id), actor);
    });
  }

  // The signed-in player's entries across tournaments, newest first.
  async function myEntries(actor) {
    if (!actor.user) fail(401, 'Sign in to see your entries');
    const rows = await db.query(
      `SELECT ${CARD_COLUMNS}, e.id AS "entryId", e.name AS "entryName", e.confirmed, e.fee_status AS "feeStatus", e.solo,
         e.paired_into IS NOT NULL AS paired, e.withdrawn, e.created_at AS "enteredAt",
         ev.id AS "eventId", ev.status AS "eventStatus", ev.discipline, ev.gender, ev.age, ev.level, ev.name AS "eventCustomName",
         (SELECT COUNT(*)::int FROM events x WHERE x.tournament_id = t.id) AS "eventCount"
       FROM entries e JOIN tournaments t ON t.id = e.tournament_id JOIN events ev ON ev.id = e.event_id
       WHERE e.user_id = $1 OR e.id IN (SELECT entry_id FROM entry_players WHERE email = $2) ORDER BY e.created_at DESC LIMIT 100`,
      [actor.user.id, actor.user.email],
    );
    return rows.map(({ entryId, entryName, confirmed, feeStatus, solo, paired, withdrawn, enteredAt, eventId, eventStatus, discipline, gender, age, level, eventCustomName, eventCount, ...card }) => ({
      ...cardOf(card),
      entry: {
        id: entryId,
        name: entryName,
        eventId,
        eventName: eventCount > 1 ? catalog.eventName({ discipline, gender, age, level, name: eventCustomName }) : null,
        enteredAt,
        // entered | waiting | payment | looking (for a partner) | playing | withdrawn
        status: withdrawn ? 'withdrawn'
          : feeStatus === 'pending' ? 'payment'
            : feeStatus === 'due' ? 'due'
              : feeStatus === 'sent' ? 'sent'
            : eventStatus !== 'setup' ? 'playing'
              : solo && !paired ? 'looking'
                : confirmed ? 'entered' : 'waiting',
      },
    }));
  }

  // Organisers link an entry's players to accounts by email (walk-ins,
  // imported lists). A drawn pair is linked through its two players.
  async function setEntryPlayers(id, actor, entryId, input = {}) {
    return mutate(id, actor, async (q, row) => {
      const [e] = await q('SELECT * FROM entries WHERE id = $1 AND tournament_id = $2', [Number(entryId) || 0, row.id]);
      if (!e) fail(404, 'Entry not found');
      const t = await eventFor(q, row, e.event_id);
      if (t.event.discipline === 'team') return saveRoster(q, t, e, input.players);
      if (e.source === 'drawn') fail(409, 'Link the two players of a drawn pair one at a time');
      const doubles = t.event.discipline === 'doubles' && !e.solo;
      const names = doubles ? e.name.split(' / ') : [e.name];
      const people = profiles.readPeople(input.players, { names, max: doubles ? 2 : 1 });
      await profiles.setPeople(q, e.id, people);
      if (e.paired_into) {
        const solos = (await q('SELECT id FROM entries WHERE paired_into = $1 ORDER BY id', [e.paired_into])).map((r) => r.id);
        await profiles.copyToPair(q, e.paired_into, solos);
      }
      if (t.status === 'completed') await recordResults(q, t);
    });
  }

  // ---------- team rosters

  const MAX_ROSTER = 30;
  // A team's players: names, emails (linking them to their accounts, so
  // results go on their profiles) and the captain. Payment marks stay with
  // each player.
  async function saveRoster(q, t, e, players) {
    const people = profiles.readPeople(players, { names: [], max: MAX_ROSTER, team: true });
    await profiles.setPeople(q, e.id, people);
    await q('UPDATE entries SET players = $1::jsonb WHERE id = $2', [JSON.stringify(people.map((p) => p.name)), e.id]);
    // Charged per player: what the team owes follows its list (until it's paid).
    if (t.config.feePer === 'player' && feeOf(t) && !DIRECT_PAID.includes(e.fee_status) && e.fee_status !== 'paid') {
      await q('UPDATE entries SET fee_amount = $1 WHERE id = $2', [entryFeeFor(t, people.length), e.id]);
    }
    await settleFromMembers(q, t, e.id);
    if (t.status === 'completed') await recordResults(q, t);
  }
  // The organisers, or the team's captain (who entered it), can see and edit it.
  async function rosterAccess(q, tournament, actor, entryId) {
    const [e] = await q('SELECT * FROM entries WHERE id = $1 AND tournament_id = $2', [Number(entryId) || 0, tournament.id]);
    if (!e) fail(404, 'Entry not found');
    const access = await accessOf(q, tournament, actor || {});
    const captain = Boolean(actor?.user && e.user_id === actor.user.id);
    if (!access.manage && !captain) fail(actor?.user ? 403 : 401, 'Only the organisers or the team\'s captain can do this');
    const t = await eventFor(q, tournament, e.event_id);
    if (t.event.discipline !== 'team') fail(400, `${eventLabel(t)} isn't a team event`);
    return { t, e, access, captain };
  }
  // The roster with emails, for its editor (organisers, or the captain).
  async function getRoster(id, actor, entryId) {
    return db.tx(async (q) => {
      const tournament = await load(q, id);
      const { e } = await rosterAccess(q, tournament, actor, entryId);
      const rows = await q('SELECT slot, name, email, captain, fee_status FROM entry_players WHERE entry_id = $1 ORDER BY slot', [e.id]);
      // Older team entries only have a list of names.
      const players = rows.length ? rows.map((r) => ({ name: r.name, email: r.email, captain: r.captain, feeStatus: r.fee_status }))
        : (e.players || []).map((name) => ({ name, email: null, captain: false, feeStatus: null }));
      return { entry: { id: e.id, name: e.name }, players };
    });
  }
  async function setRoster(id, actor, entryId, input = {}) {
    let notify = [];
    const out = await db.tx(async (q) => {
      const tournament = await load(q, id, { lock: true });
      const { t, e } = await rosterAccess(q, tournament, actor, entryId);
      if (t.status === 'completed' && !(await accessOf(q, tournament, actor || {})).manage) fail(409, 'The event has finished — ask the organiser');
      const before = new Set((await q('SELECT email FROM entry_players WHERE entry_id = $1 AND email IS NOT NULL', [e.id])).map((r) => r.email));
      await saveRoster(q, t, e, input.players);
      notify = (await q('SELECT name, email FROM entry_players WHERE entry_id = $1 AND email IS NOT NULL', [e.id])).filter((r) => !before.has(r.email) && r.email !== actor?.user?.email);
      return { t, team: e.name, view: await view(q, await load(q, id), actor) };
    });
    // Newly added players hear about it (best effort), like a doubles partner.
    if (mailer?.enabled && input.baseUrl) {
      for (const p of notify) {
        await profiles.notifyPartner({ email: p.email, player: out.team, tournament: out.t.name, event: multiEventLabel(out.t), tournamentId: out.t.id, baseUrl: input.baseUrl });
      }
    }
    return out.view;
  }

  // ---------- payments per player (pairs and teams)

  // What one player owes: the fee per player (team events can charge per
  // player), else their share of the pair's or team's fee.
  const perPlayer = (t, n) => (t.config.feePer === 'player' ? feeOf(t) : Math.ceil(feeOf(t) / Math.max(1, n)));
  // A team's fee when it's charged per player.
  const entryFeeFor = (t, players) => (t.config.feePer === 'player' ? feeOf(t) * Math.max(1, players) : feeOf(t));
  // When everyone has paid (or been let off), the entry is paid; when someone
  // is unmarked again, it's due.
  async function settleFromMembers(q, t, entryId) {
    if (!feeOf(t) || PAY_ONLINE(t)) return;
    const rows = await q('SELECT fee_status FROM entry_players WHERE entry_id = $1', [entryId]);
    if (!rows.length || !rows.some((r) => r.fee_status)) return;
    const [e] = await q('SELECT * FROM entries WHERE id = $1', [entryId]);
    const done = rows.every((r) => r.fee_status);
    const paid = rows.filter((r) => r.fee_status === 'paid').length;
    if (done && !DIRECT_PAID.includes(e.fee_status)) {
      if (!e.confirmed && t.status === 'setup') {
        const holding = ['due', 'sent'].includes(e.fee_status) && (e.hold_until === null || e.hold_until > new Date());
        if (!holding && !(await hasRoom(q, t))) fail(409, `${eventLabel(t)} is full — raise its maximum or remove someone first`);
        await checkEntryLimit(q, t, 1);
      }
      await q('UPDATE entries SET fee_status = $1, fee_amount = $2, confirmed = true, hold_until = NULL WHERE id = $3',
        [paid ? 'received' : 'waived', paid ? paid * perPlayer(t, rows.length) : null, entryId]);
    } else if (!done && DIRECT_PAID.includes(e.fee_status)) {
      await q(`UPDATE entries SET fee_status = 'due', fee_amount = $1 WHERE id = $2`, [entryFeeFor(t, rows.length), entryId]);
    }
  }
  // Organisers: one player of a pair or team has paid (or is let off).
  async function setMemberFee(id, actor, entryId, slot, status) {
    if (![null, 'paid', 'waived'].includes(status ?? null)) fail(400, 'status must be "paid", "waived" or null');
    return mutateEntry(id, actor, entryId, async (q, t) => {
      if (!feeOf(t)) fail(409, 'This event has no entry fee');
      if (PAY_ONLINE(t)) fail(409, 'Fees for this event are paid online');
      const [e] = await q('SELECT * FROM entries WHERE id = $1', [Number(entryId)]);
      let rows = await q('SELECT slot FROM entry_players WHERE entry_id = $1 ORDER BY slot', [e.id]);
      // A pair added by name: its two players, so each can be marked.
      if (!rows.length && t.event.discipline !== 'singles') {
        const names = t.event.discipline === 'team' ? e.players || [] : e.name.split('/').map((x) => x.trim()).filter(Boolean);
        if (names.length > 1) await profiles.setPeople(q, e.id, names.map((name) => ({ name })));
        rows = await q('SELECT slot FROM entry_players WHERE entry_id = $1 ORDER BY slot', [e.id]);
      }
      if (rows.length < 2) fail(409, 'Mark the payment for the whole entry');
      if (!rows.some((r) => r.slot === Number(slot))) fail(404, 'Player not found');
      await q('UPDATE entry_players SET fee_status = $1 WHERE entry_id = $2 AND slot = $3', [status ?? null, e.id, Number(slot)]);
      await settleFromMembers(q, t, e.id);
    });
  }

  // Pickleball: seed by DUPR rating (singles, or a pair's doubles ratings added up).
  async function seedByDupr(id, actor, { event } = {}) {
    return mutateEvent(id, actor, event, async (q, t) => {
      requireSetup(t);
      if (t.sportDef.id !== 'pickleball') fail(400, 'Seeding by DUPR is for pickleball events');
      const entries = await entriesOf(q, t);
      const people = await profiles.peopleOf(q, t.id);
      const rated = entries.map((e) => ({ e, r: dupr.entryRating(people.get(e.id) || [], t.event.discipline) }));
      rated.sort((x, y) => (y.r ?? -1) - (x.r ?? -1) || x.e.seed - y.e.seed);
      for (const [i, { e }] of rated.entries()) await q('UPDATE entries SET seed = $1 WHERE id = $2', [i + 1, e.id]);
    });
  }

  // Pickleball: finished matches as a CSV for the DUPR club match upload.
  async function duprCsv(id, actor, { event } = {}) {
    const row = await load(db.query, id);
    const access = await accessOf(db.query, row, actor);
    if (!access.manage) fail(403, 'Only organisers can download results');
    const t = await eventFor(db.query, row, event);
    if (t.sportDef.id !== 'pickleball') fail(400, 'DUPR results are for pickleball events');
    const people = await profiles.peopleOf(db.query, t.id);
    const entries = await entriesOf(db.query, t);
    const names = new Map(entries.map((e) => [e.id, e.name]));
    const rows = await db.query(`SELECT * FROM matches WHERE event_id = $1 AND status = 'done' AND NOT walkover AND a_id IS NOT NULL AND b_id IS NOT NULL ORDER BY ${MATCH_ORDER}`, [t.eventId]);
    const side = (entryId) => {
      const list = people.get(entryId) || [];
      if (list.length) return list.map((p) => ({ name: p.name, duprId: p.duprId || p.entryDupr || '' }));
      return (names.get(entryId) || '').split(' / ').map((name) => ({ name, duprId: '' }));
    };
    const date = (m) => (m.updated_at ? new Date(m.updated_at) : new Date()).toISOString().slice(0, 10);
    const matches = rows.map((m) => {
      const score = scoreOf(t, m);
      return {
        doubles: t.event.discipline === 'doubles',
        event: `${t.name} — ${eventLabel(t)}`,
        date: date(m),
        a: side(m.a_id),
        b: side(m.b_id),
        games: (score.games || []).filter((g) => g.a || g.b).map((g) => [g.a, g.b]),
      };
    });
    const missing = matches.filter((m) => [...m.a, ...m.b].some((p) => !p.duprId)).length;
    return { csv: dupr.csv(matches), filename: `${t.name}-${eventLabel(t)}-dupr.csv`.replace(/[^\w.-]+/g, '-'), missing, matches: matches.length };
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

  // slots: first-round places (ids, null = bye), when already worked out
  // (level pools). A part of the bracket with nobody in it (an empty pool
  // section) is "dead": its matches are byes with no winner, and whoever
  // meets it goes straight through.
  async function createBracket(q, t, seeded, slots = formats.knockoutSlots(seeded)) {
    const rounds = Math.log2(slots.length);
    t.config = { ...t.config, knockoutRounds: rounds };
    await saveEventConfig(q, t);
    const byes = [];
    let dead = [];
    for (let s = 0; s < slots.length >> 1; s++) dead.push(slots[2 * s] == null && slots[2 * s + 1] == null);
    for (let r = 1; r <= rounds; r++) {
      if (r > 1) dead = Array.from({ length: slots.length >> r }, (_, s) => dead[2 * s] && dead[2 * s + 1]);
      for (let s = 0; s < slots.length >> r; s++) {
        if (r > 1) {
          await insertMatch(q, t, 'knockout', null, r, s, null, null, dead[s] ? 'bye' : 'scheduled');
          continue;
        }
        const a = slots[2 * s];
        const b = slots[2 * s + 1];
        if (a == null || b == null) {
          await insertMatch(q, t, 'knockout', null, 1, s, a, b, 'bye', a ?? b);
          if (a != null || b != null) byes.push({ round: 1, slot: s, winner: a ?? b });
        } else {
          await insertMatch(q, t, 'knockout', null, 1, s, a, b);
        }
      }
    }
    for (const bye of byes) await advance(q, t, bye, bye.winner);
  }
  // A dead part of the bracket: a bye that nobody came out of.
  const deadMatch = (m) => Boolean(m) && m.status === 'bye' && m.winner_id == null;

  async function advance(q, t, m, winnerId) {
    const next = await koMatch(q, t, m.round + 1, m.slot >> 1);
    const [row] = await q(`UPDATE matches SET ${nextSlotColumn(m)} = $1 WHERE id = $2 RETURNING *`, [winnerId, next.id]);
    // Facing an empty part of the bracket: straight through.
    const other = await koMatch(q, t, m.round, m.slot ^ 1);
    if (deadMatch(other) && row.status === 'scheduled') {
      await q(`UPDATE matches SET status = 'bye', winner_id = $1 WHERE id = $2`, [winnerId, row.id]);
      if (row.round === t.config.knockoutRounds) await setStatus(q, t, 'completed');
      else await advance(q, t, row, winnerId);
      return;
    }
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

  // The level pools for these entries, in bracket order (the organiser's
  // poolOrder first, then lowest level first). Every entry needs a level.
  function poolsOf(t, entries) {
    const levels = catalog.entryLevels(t.sportDef.id);
    const { pools, missing } = formats.poolsFor(entries.map((e) => ({ id: e.id, level: e.level })), t.config.pools, levels);
    if (missing.length) {
      const names = entries.filter((e) => missing.includes(e.id)).map((e) => e.name);
      fail(400, `Set a level for ${names.length === 1 ? names[0] : `${names.length} entries (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`} — or switch level pools off`, 'levels');
    }
    if (pools.length < 2) fail(400, `Everyone is in one level pool (${pools[0] ? pools[0].label : 'none'}) — check the levels, or switch level pools off`, 'levels');
    return orderPools(pools, t.config.poolOrder);
  }
  const orderPools = (pools, order) => {
    const rank = (k) => { const i = (order || []).indexOf(k); return i < 0 ? 100 : i; };
    return pools.map((p, i) => ({ p, i })).sort((x, y) => rank(x.p.key) - rank(y.p.key) || x.i - y.i).map((x) => x.p);
  };

  // Starting is when a tournament is clearly real: an invited organiser's
  // first one earns their inviter a reward (referrals.js).
  async function start(id, actor, opts = {}) {
    const result = await startEvent(id, actor, opts);
    await referrals.qualify(db.query, id).catch((err) => console.error('Referral:', err.message));
    return result;
  }

  async function startEvent(id, actor, { skipUnconfirmed = false, event } = {}) {
    return mutateEvent(id, actor, event, async (q, t) => {
      if (t.status !== 'setup') fail(409, 'The tournament has already started');
      // Unconfirmed self-entries are never drawn; the organiser has to decide
      // about them first so nobody is left out by accident.
      // Drawn-partner events pair everyone up now.
      if (t.config.partners === 'drawn') await drawPairsIn(q, t, Boolean(t.config.balancePairs));
      const everyone = await entriesOf(q, t);
      const waiting = everyone.filter((e) => !e.confirmed && e.fee_status !== 'pending').length;
      if (waiting && !skipUnconfirmed) {
        fail(409, `${waiting} ${waiting === 1 ? 'entry is' : 'entries are'} still unconfirmed — confirm or remove them first`, 'unconfirmed');
      }
      const alone = everyone.filter((e) => e.solo && e.confirmed).length;
      if (alone && !skipUnconfirmed) {
        fail(409, `${alone} ${alone === 1 ? 'player still needs' : 'players still need'} a partner — pair or remove them first`, 'solo');
      }
      // If anyone has been checked in, only checked-in entries are drawn.
      const all = everyone.filter((e) => e.confirmed && !e.solo);
      const usingCheckIn = all.some((e) => e.checked_in);
      const entries = usingCheckIn ? all.filter((e) => e.checked_in) : all;
      await q('UPDATE entries SET in_draw = confirmed AND NOT solo AND (checked_in OR NOT $2), withdrawn = false WHERE event_id = $1', [t.eventId, usingCheckIn]);
      if (t.format === 'knockout') {
        if (entries.length < 2) fail(400, 'Add at least 2 entries to start');
        await createBracket(q, t, entries.map((e) => ({ id: e.id, group: null, tier: 0 })));
        await setStatus(q, t, 'knockout');
        return;
      }
      if (entries.length < 2) fail(400, usingCheckIn ? 'Check in at least 2 entries to start' : 'Add at least 2 entries to start');
      const { qualifiers } = t.config;
      let draw;
      let groupPools = null;
      if (poolsOn(t)) {
        // Level pools: each pool (Beginner, …) is drawn into its own groups.
        const pools = poolsOf(t, entries);
        draw = [];
        groupPools = [];
        for (const p of pools) {
          if (p.ids.length < 2) fail(400, `${p.label} has only 1 entry — a pool needs at least 2. Change their level, or switch level pools off`, 'levels');
          const n = t.config.groupSize ? formats.groupCount(p.ids.length, t.config.groupSize) : 1;
          const smallest = Math.floor(p.ids.length / n);
          if (qualifiers > smallest) fail(400, `${p.label}: the smallest group has ${smallest} entries, so at most ${smallest} can qualify from each group`);
          for (const ids of formats.snakeGroups(p.ids, n)) { draw.push(ids); groupPools.push({ key: p.key, label: p.label }); }
        }
      } else {
        const groups = groupsFor(t, entries.length);
        if (entries.length < groups * 2) {
          fail(400, `${groups} group${groups > 1 ? 's need' : ' needs'} at least ${groups * 2} entries (you have ${entries.length})`);
        }
        if (t.format === 'league_knockout') {
          const smallest = Math.floor(entries.length / groups);
          if (qualifiers > smallest) fail(400, `The smallest group has ${smallest} entries, so at most ${smallest} can qualify from each group`);
          if (groups * qualifiers < 2) fail(400, 'At least 2 entries must qualify for the knockout');
        }
        draw = formats.snakeGroups(entries.map((e) => e.id), groups);
      }
      t.config = { ...t.config, groups: draw.length, groupPools };
      await saveEventConfig(q, t);
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
      const seedOf = (list) => {
        const out = [];
        for (let tier = 0; tier < t.config.qualifiers; tier++) {
          for (const g of list) {
            const row = g.standings.filter((r) => !r.withdrawn)[tier]; // withdrawn players don't qualify
            if (row) out.push({ id: row.id, group: g.no, tier });
          }
        }
        return out;
      };
      const seeded = seedOf(groups);
      if (seeded.length < 2) fail(409, 'Not enough players left to make a knockout');
      const gp = t.config.groupPools;
      if (gp && gp.length === groups.length) {
        // Level pools: each pool plays off in its own part of the bracket.
        const keys = orderPools([...new Map(gp.map((p) => [p.key, p])).values()], t.config.poolOrder).map((p) => p.key);
        const sections = keys.map((k) => seedOf(groups.filter((g) => gp[g.no].key === k)));
        await createBracket(q, t, null, formats.pooledSlots(sections));
      } else {
        await createBracket(q, t, seeded);
      }
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

  // An entry's level (before the draw, or while their group hasn't started).
  // With level pools on during the league, a new level moves them to that
  // pool (its smallest group that hasn't started).
  async function setEntryLevel(id, actor, entryId, input = {}) {
    return mutateEntry(id, actor, entryId, async (q, t) => {
      const level = levelIn(t, input.level);
      const [e] = await q('SELECT * FROM entries WHERE id = $1', [Number(entryId)]);
      if (t.status === 'setup' || !poolsOn(t) || t.status !== 'league' || e.group_no == null) {
        if (t.status !== 'setup' && t.status !== 'league') fail(409, 'The knockout has started — levels are set');
        await q('UPDATE entries SET level = $1 WHERE id = $2', [level, e.id]);
        return;
      }
      const gp = t.config.groupPools || [];
      const fits = (g) => gp[g] && level && gp[g].label.split(' & ').includes(level);
      if (fits(e.group_no) || !level) { await q('UPDATE entries SET level = $1 WHERE id = $2', [level, e.id]); return; }
      const started = await startedGroups(q, t);
      const sizes = await q(`SELECT group_no, COUNT(*)::int AS n FROM entries WHERE event_id = $1 AND group_no IS NOT NULL AND in_draw GROUP BY group_no`, [t.eventId]);
      const target = gp.map((_, g) => g).filter((g) => fits(g) && !started.has(g))
        .sort((x, y) => ((sizes.find((r) => r.group_no === x) || {}).n || 0) - ((sizes.find((r) => r.group_no === y) || {}).n || 0) || x - y)[0];
      if (target === undefined) fail(409, `Every ${level} group has started — withdraw them and add them as a spot entry instead`);
      await moveInto(q, t, e, target, started);
      await q('UPDATE entries SET level = $1 WHERE id = $2', [level, e.id]);
    });
  }

  // Groups whose league has started (a point, a walkover or a result).
  async function startedGroups(q, t) {
    const rows = await q(
      `SELECT DISTINCT group_no FROM matches WHERE event_id = $1 AND stage = 'league' AND (rallies <> '' OR walkover OR status = 'done')`, [t.eventId]);
    return new Set(rows.map((r) => r.group_no));
  }
  // Moves an entry to another group and redoes both groups' fixtures.
  async function moveInto(q, t, e, target, started) {
    const from = e.group_no;
    if (from === target) return;
    for (const g of [from, target]) {
      if (started.has(g)) fail(409, `${groupName(g)} has started — add them to it as a spot entry instead`);
    }
    await q('UPDATE entries SET group_no = $1 WHERE id = $2', [target, e.id]);
    for (const g of [from, target]) {
      await q(`DELETE FROM matches WHERE event_id = $1 AND stage = 'league' AND group_no = $2`, [t.eventId, g]);
      const ids = (await q('SELECT id FROM entries WHERE event_id = $1 AND group_no = $2 AND in_draw ORDER BY seed, id', [t.eventId, g])).map((r) => r.id);
      for (const [r, pairs] of formats.roundRobin(ids).entries()) {
        for (const [slot, [a, b]] of pairs.entries()) await insertMatch(q, t, 'league', g, r + 1, slot, a, b);
      }
    }
  }
  // Organisers: move a player to another group during the league, while
  // neither group has started ("he's really Intermediate").
  async function moveEntry(id, actor, entryId, input = {}) {
    return mutateEntry(id, actor, entryId, async (q, t) => {
      if (t.status !== 'league') fail(409, 'Players can be moved between groups during the league stage');
      const target = Number(input.group);
      if (!Number.isInteger(target) || target < 0 || target >= t.config.groups) fail(400, 'Pick one of the groups');
      const [e] = await q('SELECT * FROM entries WHERE id = $1', [Number(entryId)]);
      if (e.group_no == null || !e.in_draw) fail(409, 'They aren\'t in a group');
      if (e.withdrawn) fail(409, 'They have withdrawn');
      const started = await startedGroups(q, t);
      for (const g of [e.group_no, target]) if (started.has(g)) fail(409, `${groupName(g)} has started — add them to it as a spot entry instead`);
      const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM entries WHERE event_id = $1 AND group_no = $2 AND in_draw', [t.eventId, e.group_no]);
      if (n <= 2 && e.group_no !== target) fail(409, `${groupName(e.group_no)} would be left with 1 player`);
      await moveInto(q, t, e, target, started);
      // A single-level pool sets their level (moved into Intermediate = Intermediate).
      const pool = (t.config.groupPools || [])[target];
      if (pool && !pool.label.includes(' & ')) await q('UPDATE entries SET level = $1 WHERE id = $2', [pool.label, e.id]);
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
      if (all.some((e) => e.name.toLowerCase() === name.toLowerCase())) fail(400, `"${name}" is already entered — if they entered earlier, tap Arrived next to their name`);
      await checkEntryLimit(q, t, 1);
      const seed = all.reduce((max, e) => Math.max(max, e.seed), 0) + 1;
      await placeLate(q, t, all, input, async (group, level) => {
        const [{ id: newId }] = await insertEntry(q, t, { name, seed, group, source: 'walk-in', checkedIn: true, level: levelIn(t, input.level) || level });
        return newId;
      });
    });
  }

  // Someone who entered but wasn't here for the draw ("Didn't show") arrives:
  // they join like a late entry, keeping their entry (fee, contact, level).
  async function arrive(id, actor, entryId, input = {}) {
    return mutateEntry(id, actor, entryId, async (q, t) => {
      if (t.status === 'setup') fail(409, 'The draw hasn\'t been made yet — just tick them in the list');
      if (t.status === 'completed') fail(409, 'The tournament has finished');
      const [e] = await q('SELECT * FROM entries WHERE id = $1', [Number(entryId)]);
      if (e.in_draw) fail(409, `${e.name} is already in the draw`);
      if (!e.confirmed || e.solo) fail(409, `${e.name} isn't a confirmed entry`);
      if (e.withdrawn) fail(409, `${e.name} has withdrawn`);
      const all = await entriesOf(q, t);
      await placeLate(q, t, all, { group: input.group, level: input.level || e.level }, async (group, level) => {
        await q('UPDATE entries SET in_draw = true, checked_in = true, group_no = $2, level = COALESCE(level, $3), away_since = NULL WHERE id = $1', [e.id, group, level]);
        return e.id;
      });
    });
  }

  // Puts a latecomer into the event: in the league, a group (the one picked,
  // else their level's pool, else the smallest) with catch-up matches against
  // everyone in it; in a knockout-only event, a first-round bye.
  // place(group, level) saves the entry there and returns its id.
  async function placeLate(q, t, all, input, place) {
    const wanted = given(input.group) ? Number(input.group) : null;
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
      const level = levelIn(t, input.level);
      const gp = t.config.groupPools || [];
      let choice;
      if (wanted !== null) {
        // The organiser's pick (a spot entry put where they belong).
        choice = groups.find((x) => x.g === wanted);
        if (!choice) fail(400, 'Pick one of the groups');
      } else if (level && gp.length) {
        // Their level's pool: its smallest group.
        choice = groups.find((x) => (gp[x.g] || {}).label && gp[x.g].label.split(' & ').includes(level));
        if (!choice) fail(400, `There's no ${level} pool — pick a group for them`);
      } else {
        choice = groups[0];
      }
      const { g, members } = choice;
      const ownLevel = level || (gp[g] && !gp[g].label.includes(' & ') ? gp[g].label : null);
      const newId = await place(g, ownLevel);
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

    if (t.format !== 'knockout') fail(409, 'The knockout has started — latecomers can only join during the group stage');
    const byes = await q(
      `SELECT * FROM matches WHERE event_id = $1 AND stage = 'knockout' AND round = 1 AND status = 'bye' ORDER BY slot`,
      [t.eventId],
    );
    for (const bye of byes) {
      const next = await koMatch(q, t, 2, bye.slot >> 1);
      if (!next || next.rallies || next.status !== 'scheduled') continue;
      const newId = await place(null, null);
      await q(`UPDATE matches SET ${nextSlotColumn(bye)} = NULL WHERE id = $1`, [next.id]); // undo the bye's advance
      const side = bye.a_id == null ? 'a_id' : 'b_id';
      await q(
        `UPDATE matches SET ${side} = $1, status = 'scheduled', winner_id = NULL, catch_up = true, updated_at = now() WHERE id = $2`,
        [newId, bye.id],
      );
      return;
    }
    fail(409, 'The bracket is full — no bye is left for them');
  }

  // "Not here yet": checked in, but not at the court. Their matches wait (the
  // order of play and auto-call skip them) until they're back. A match
  // called to a court with no point played goes back to the queue, and the
  // court takes the next one.
  async function setAway(id, actor, entryId, away = true) {
    return db.tx(async (q) => {
      const { t: tournament } = await lockWith(q, id, actor, 'score');
      const t = await eventOfEntry(q, tournament, entryId);
      const [e] = await q('SELECT * FROM entries WHERE id = $1', [Number(entryId)]);
      if (t.status === 'setup' || t.status === 'completed') fail(409, 'This is for during the event');
      if (!e.in_draw || e.withdrawn) fail(409, `${e.name} isn't playing now`);
      await q(`UPDATE entries SET away_since = ${away ? 'COALESCE(away_since, now())' : 'NULL'} WHERE id = $1`, [e.id]);
      if (away) {
        const called = await q(`SELECT * FROM matches WHERE event_id = $1 AND status = 'live' AND rallies = '' AND (a_id = $2 OR b_id = $2)`, [t.eventId, e.id]);
        for (const m of called) {
          await q(`UPDATE matches SET status = 'scheduled', court = NULL, called_at = NULL, updated_at = now() WHERE id = $1`, [m.id]);
          await autoCall(q, tournament, m.court);
        }
      }
      return view(q, await load(q, id), actor);
    });
  }

  // One match given to the side that's there (the other never came).
  async function giveWalkover(id, actor, mid, winner) {
    if (winner !== 'a' && winner !== 'b') fail(400, 'winner must be "a" or "b"');
    return db.tx(async (q) => {
      const { t: tournament } = await lockWith(q, id, actor, 'manage');
      const m = await matchOf(q, tournament, mid);
      const t = await eventFor(q, tournament, m.event_id);
      if (!['scheduled', 'live'].includes(m.status)) fail(409, 'This match is already finished');
      if (m.rallies) fail(409, 'This match has started — if a player can\'t go on, mark them as retired');
      if (m.a_id == null || m.b_id == null) fail(409, 'Both players are not known yet');
      requireStageOpen(t, m);
      await q('UPDATE matches SET court = NULL WHERE id = $1', [m.id]);
      await finishWalkover(q, t, m, winner === 'a' ? m.a_id : m.b_id);
      if (m.stage === 'league' && t.format === 'league' && (await pendingLeague(q, t)) === 0) await setStatus(q, t, 'completed');
      await autoCall(q, tournament, m.court);
      return view(q, await load(q, id), actor);
    });
  }

  // A player retires mid-match (injury, has to leave): the other side wins.
  // The points played stay on the scoresheet; tables count it like a walkover.
  async function retire(id, actor, mid, side) {
    if (side !== 'a' && side !== 'b') fail(400, 'side must be "a" or "b"');
    return db.tx(async (q) => {
      const { t: tournament } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, tournament, mid);
      const t = await eventFor(q, tournament, m.event_id);
      if (m.status === 'done' || m.status === 'bye') fail(409, 'This match is already finished');
      if (m.a_id == null || m.b_id == null) fail(409, 'Both players are not known yet');
      requireStageOpen(t, m);
      if (!m.rallies) fail(409, 'No point has been played — give a walkover instead');
      const winnerId = side === 'a' ? m.b_id : m.a_id;
      const [row] = await q(`UPDATE matches SET status = 'done', winner_id = $1, retired = $2, updated_at = now() WHERE id = $3 RETURNING *`, [winnerId, side, m.id]);
      if (m.stage === 'knockout') {
        if (m.round === t.config.knockoutRounds) await setStatus(q, t, 'completed');
        else await advance(q, t, m, winnerId);
      } else if (t.format === 'league' && (await pendingLeague(q, t)) === 0) {
        await setStatus(q, t, 'completed');
      }
      await autoCall(q, tournament, m.court);
      return viewOfRow(q, t, row);
    });
  }

  // A new name for an entry after the draw (a substitute partner). Results
  // stay with the entry; linked players whose name is gone are unlinked, so
  // nobody is credited for a match they didn't play.
  async function renameEntry(id, actor, entryId, input = {}) {
    const name = text(input.name, 'Name', { max: 60 });
    return mutateEntry(id, actor, entryId, async (q, t) => {
      if (t.status === 'completed') fail(409, 'The tournament has finished');
      const [e] = await q('SELECT * FROM entries WHERE id = $1', [Number(entryId)]);
      const all = await entriesOf(q, t);
      if (all.some((x) => x.id !== e.id && x.name.toLowerCase() === name.toLowerCase())) fail(400, `"${name}" is already entered`);
      await q('UPDATE entries SET name = $1 WHERE id = $2', [name, e.id]);
      const now = name.split('/').map((p) => p.trim().toLowerCase());
      await q(`DELETE FROM entry_players WHERE entry_id = $1 AND NOT (lower(name) = ANY($2::text[]))`, [e.id, now]);
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

  // A finished pickleball match goes to DUPR (when connected) after it's saved.
  // extra: { points, foul, end } for sports that score more than 1 a tap.
  async function rally(id, actor, mid, side, at, extra = {}) {
    const m = await rallyIn(id, actor, mid, side, at, extra);
    if (m.status === 'done' && dupr.enabled()) await sendToDupr(m.id).catch((err) => console.error('DUPR:', err.message));
    return m;
  }

  // ---------- DUPR partner API (only when DUPR_CLIENT_ID/SECRET are set)
  const duprClient = dupr.createClient({ fetchImpl });

  // Sends one finished match when every player is verified with DUPR and the
  // admin has switched sending on. Returns the submission, or null if skipped.
  async function sendToDupr(matchId) {
    if (!dupr.enabled() || !(await settings.get('duprSubmit'))) return null;
    const [m] = await db.query('SELECT * FROM matches WHERE id = $1', [Number(matchId) || 0]);
    if (!m || m.status !== 'done' || m.walkover || m.a_id == null || m.b_id == null) return null;
    const row = await load(db.query, m.tournament_id);
    const t = await eventFor(db.query, row, m.event_id);
    if (t.sportDef.id !== 'pickleball') return null;
    const people = await profiles.peopleOf(db.query, t.id);
    const side = (entryId) => people.get(entryId) || [];
    const all = [...side(m.a_id), ...side(m.b_id)];
    const size = t.event.discipline === 'doubles' ? 4 : 2;
    if (all.length !== size || !all.every((p) => p.duprVerified && p.duprId)) return null;
    const [done] = await db.query(`SELECT status FROM dupr_submissions WHERE match_id = $1`, [m.id]);
    if (done && done.status === 'sent') return done;
    await db.query(`INSERT INTO dupr_submissions (match_id) VALUES ($1) ON CONFLICT (match_id) DO UPDATE SET status = 'queued', updated_at = now()`, [m.id]);
    const score = scoreOf(t, m);
    const team = (list) => ({ player1: list[0].duprId, ...(list[1] && { player2: list[1].duprId }) });
    try {
      const duprMatch = await duprClient.submitMatch({
        identifier: `tonament-${m.id}`,
        event: `${row.name} — ${eventLabel(t)}`,
        format: size === 4 ? 'DOUBLES' : 'SINGLES',
        matchDate: (m.updated_at ? new Date(m.updated_at) : new Date()).toISOString().slice(0, 10),
        location: [row.venue, row.city].filter(Boolean).join(', ') || undefined,
        teamA: team(side(m.a_id)),
        teamB: team(side(m.b_id)),
        games: (score.games || []).filter((g) => g.a || g.b).map((g) => ({ teamA: g.a, teamB: g.b })),
      });
      const [r] = await db.query(`UPDATE dupr_submissions SET status = 'sent', dupr_match = $2, error = NULL, attempts = attempts + 1, updated_at = now() WHERE match_id = $1 RETURNING *`, [m.id, duprMatch]);
      return r;
    } catch (err) {
      const [r] = await db.query(`UPDATE dupr_submissions SET status = 'failed', error = $2, attempts = attempts + 1, updated_at = now() WHERE match_id = $1 RETURNING *`, [m.id, String(err.message).slice(0, 300)]);
      return r;
    }
  }

  // Connect DUPR: checks the ID with DUPR and takes the real ratings.
  async function connectDupr(actor, input = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    if (!dupr.enabled()) fail(503, 'DUPR isn\'t connected to Tonament yet');
    const id = dupr.checkId(input.duprId, fail);
    let p;
    try {
      p = await duprClient.player(id);
    } catch (err) {
      fail(502, `DUPR didn't recognise that ID (${err.message})`);
    }
    await db.query(
      'UPDATE users SET dupr_id = $1, dupr_singles = $2, dupr_doubles = $3, dupr_verified = true, dupr_synced_at = now() WHERE id = $4',
      [id, p.singles == null ? null : dupr.checkRating(p.singles, fail), p.doubles == null ? null : dupr.checkRating(p.doubles, fail), actor.user.id],
    );
    return profiles.myProfile(actor);
  }
  async function disconnectDupr(actor) {
    if (!actor?.user) fail(401, 'Sign in first');
    await db.query('UPDATE users SET dupr_verified = false, dupr_synced_at = NULL WHERE id = $1', [actor.user.id]);
    return profiles.myProfile(actor);
  }

  async function adminDupr(actor) {
    requireSiteAdmin(actor);
    const rows = await db.query(
      `SELECT d.match_id AS "matchId", d.status, d.dupr_match AS "duprMatch", d.error, d.attempts, d.updated_at AS "updatedAt", t.id AS "tournamentId", t.name AS "tournamentName"
       FROM dupr_submissions d JOIN matches m ON m.id = d.match_id JOIN tournaments t ON t.id = m.tournament_id ORDER BY d.updated_at DESC LIMIT 100`,
    );
    return { enabled: dupr.enabled(), submissions: rows };
  }
  async function adminDuprRetry(actor, matchId) {
    requireSiteAdmin(actor);
    const r = await sendToDupr(matchId);
    if (!r) fail(409, 'This match can\'t be sent: DUPR is off, or a player isn\'t verified with DUPR');
    return r;
  }

  async function rallyIn(id, actor, mid, side, at, extra = {}) {
    if (!extra.end && side !== 'a' && side !== 'b') fail(400, 'side must be "a" or "b"');
    return db.tx(async (q) => {
      const { t: tournament } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, tournament, mid);
      const t = await eventFor(q, tournament, m.event_id);
      if (t.sportDef.tie) fail(409, 'A tie is scored match by match — open the tie');
      if (m.status === 'done' || m.status === 'bye') fail(409, 'This match is already finished');
      if (m.a_id == null || m.b_id == null) fail(409, 'Both players are not known yet');
      requireStageOpen(t, m);
      await claimMatch(q, m, actor);
      checkAt(m, at);

      const tap = sports.tapFor(scoreOf(t, m), { ...extra, side });
      if (tap.error) fail(400, tap.error);
      return saveRallies(q, tournament, t, m, m.rallies + tap.ch);
    });
  }

  // A match's points, saved; when that finishes it, the bracket moves on,
  // the event may complete and the court calls its next match.
  async function saveRallies(q, tournament, t, m, rallies) {
    const score = scoreOf(t, m, rallies);
    const winnerId = score.winner ? (score.winner === 'a' ? m.a_id : m.b_id) : null;
    const over = league.finished(score); // won, or drawn in a 2-game league match
    const [row] = await q(
      `UPDATE matches SET rallies = $1, status = $2, winner_id = $3, updated_at = now() WHERE id = $4 RETURNING *`,
      [rallies, over ? 'done' : 'live', winnerId, m.id],
    );
    if (over) {
      if (m.stage === 'knockout') {
        if (m.round === t.config.knockoutRounds) await setStatus(q, t, 'completed');
        else await advance(q, t, m, winnerId);
      } else if (t.format === 'league' && (await pendingLeague(q, t)) === 0) {
        await setStatus(q, t, 'completed');
      }
      await autoCall(q, tournament, m.court);
    }
    return viewOfRow(q, t, row);
  }

  // The score entered at the end ([{ a, b }] per game / set / frame) instead
  // of point by point. It replaces any live points and must finish the match.
  async function resultIn(id, actor, mid, games, at) {
    return db.tx(async (q) => {
      const { t: tournament } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, tournament, mid);
      const t = await eventFor(q, tournament, m.event_id);
      if (t.sportDef.tie) fail(409, 'A tie is scored match by match — open the tie');
      if (m.status === 'done' || m.status === 'bye') fail(409, 'This match is already finished — undo the last point to change it');
      if (m.a_id == null || m.b_id == null) fail(409, 'Both players are not known yet');
      requireStageOpen(t, m);
      await claimMatch(q, m, actor);
      checkAt(m, at);
      const built = fromScores((log) => scoreOf(t, m, log), games);
      if (built.error) fail(400, built.error);
      if (!league.finished(built.score)) fail(400, `That doesn't finish the match — enter every ${(built.score.unit || 'game').toLowerCase()} played`);
      return saveRallies(q, tournament, t, m, built.rallies);
    });
  }
  async function setResult(id, actor, mid, games, at) {
    const m = await resultIn(id, actor, mid, games, at);
    if (m.status === 'done' && dupr.enabled()) await sendToDupr(m.id).catch((err) => console.error('DUPR:', err.message));
    return m;
  }

  // Removes the last rally. Undoing the winning point reopens the match, as
  // long as nothing downstream has started yet.
  async function undo(id, actor, mid, at) {
    return db.tx(async (q) => {
      const { t: tournament } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, tournament, mid);
      const t = await eventFor(q, tournament, m.event_id);
      if (t.sportDef.tie) fail(409, 'A tie is undone match by match — open the tie');
      if (m.walkover) fail(409, 'Walkovers can\'t be undone');
      if (m.status === 'bye' || (!m.rallies && !m.retired)) fail(409, 'Nothing to undo');
      await claimMatch(q, m, actor);
      checkAt(m, at);
      if (m.status === 'done' && m.stage === 'league') {
        if (t.status === 'knockout' || (t.status === 'completed' && t.format === 'league_knockout')) {
          fail(409, 'League results are locked because the knockout has started');
        }
        if (t.status === 'completed') await setStatus(q, t, 'league');
      } else if (m.status === 'done') {
        if (m.round < t.config.knockoutRounds) {
          let from = m;
          let next = await koMatch(q, t, m.round + 1, m.slot >> 1);
          // Through any byes it went straight on through (an empty bracket section).
          while (next.status === 'bye' && next.winner_id != null && next.round < t.config.knockoutRounds) {
            const after = await koMatch(q, t, next.round + 1, next.slot >> 1);
            if (after.rallies || after.status === 'done') fail(409, 'A later-round match has already started');
            await q(`UPDATE matches SET ${nextSlotColumn(from)} = NULL, status = 'scheduled', winner_id = NULL WHERE id = $1`, [next.id]);
            from = next;
            next = after;
          }
          if (next.rallies || next.status === 'done') fail(409, 'The next-round match has already started');
          await q(`UPDATE matches SET ${nextSlotColumn(from)} = NULL, status = 'scheduled', winner_id = NULL, court = NULL, called_at = NULL WHERE id = $1`, [next.id]);
        }
        if (t.status === 'completed') await setStatus(q, t, 'knockout');
      }
      if (m.status === 'done' && m.court) {
        // The court is in use again: a match called there since goes back in the queue.
        await q(
          `UPDATE matches SET status = 'scheduled', court = NULL, called_at = NULL
           WHERE tournament_id = $1 AND court = $2 AND status = 'live' AND rallies = '' AND id <> $3`,
          [t.id, m.court, m.id],
        );
      }
      // Undoing a retirement reopens the match with its points; otherwise the last point goes.
      const [row] = await q(
        `UPDATE matches SET rallies = $1, status = 'live', winner_id = NULL, retired = NULL, updated_at = now() WHERE id = $2 RETURNING *`,
        [m.retired ? m.rallies : m.rallies.slice(0, -1), m.id],
      );
      return viewOfRow(q, t, row);
    });
  }

  // ---------- courts and the order of play

  // How players pay the organiser: { upi, payee, note, holdHours }.
  function paymentSettings(input) {
    const p = input || {};
    const upi = text(p.upi, 'UPI ID', { max: 100, optional: true });
    if (upi && !/^[\w.\-]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/.test(upi)) fail(400, 'Enter a UPI ID like name@okhdfcbank');
    const holdHours = p.holdHours === undefined ? DEFAULT_HOLD_HOURS : Number(p.holdHours);
    if (![0, 24, 48].includes(holdHours)) fail(400, 'Hold places for 24 or 48 hours, or until entries close');
    return {
      upi: upi ? upi.toLowerCase() : null,
      payee: text(p.payee, 'Name to pay', { max: 60, optional: true }),
      note: text(p.note, 'Payment note', { max: 200, optional: true }),
      holdHours,
    };
  }

  // { names, minutes, auto } or null when no courts are set up.
  function courtsOf(t) {
    const c = t.courts;
    if (!c || !c.names || !c.names.length) return null;
    return { names: c.names, minutes: c.minutes || schedule.defaultMinutes(t.sport), auto: Boolean(c.auto) };
  }

  function courtSettings(input, t) {
    if (!input) return null;
    const names = (Array.isArray(input.names) ? input.names : []).map((n) => (typeof n === 'string' ? n.trim().replace(/\s+/g, ' ') : ''));
    if (names.some((n) => !n)) fail(400, 'Give every court a name');
    if (names.length > schedule.MAX_COURTS) fail(400, `Up to ${schedule.MAX_COURTS} courts`);
    if (names.some((n) => n.length > 20)) fail(400, 'Court names must be at most 20 characters');
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) fail(400, 'Court names must be different');
    if (!names.length) return null;
    const minutes = input.minutes === undefined || input.minutes === '' || input.minutes === null
      ? schedule.defaultMinutes(t.sport)
      : int(input.minutes, 5, 240, null, 'Typical match length (minutes)');
    return { names, minutes, auto: Boolean(input.auto) };
  }

  // Puts a match on a free court ("Call to court").
  async function callMatch(id, actor, mid, court) {
    return db.tx(async (q) => {
      const { t: tournament } = await lockWith(q, id, actor, 'score');
      const courts = courtsOf(tournament);
      if (!courts || !courts.names.includes(court)) fail(400, 'Choose one of the tournament\'s courts');
      const m = await matchOf(q, tournament, mid);
      const t = await eventFor(q, tournament, m.event_id);
      if (m.status !== 'scheduled') fail(409, m.status === 'live' ? 'This match is already on court' : 'This match is finished');
      if (m.a_id == null || m.b_id == null) fail(409, 'Both players are not known yet');
      requireStageOpen(t, m);
      const [taken] = await q(`SELECT 1 FROM matches WHERE tournament_id = $1 AND court = $2 AND status = 'live'`, [tournament.id, court]);
      if (taken) fail(409, `${court} is in use`);
      await q(`UPDATE matches SET court = $1, status = 'live', called_at = now(), queue_pos = NULL, updated_at = now() WHERE id = $2`, [court, m.id]);
      return view(q, tournament, actor);
    });
  }

  // "Play next": pins a match to the front of the queue (top = false unpins it).
  async function queueMatch(id, actor, mid, top = true) {
    return db.tx(async (q) => {
      const { t: tournament } = await lockWith(q, id, actor, 'score');
      const m = await matchOf(q, tournament, mid);
      if (m.status !== 'scheduled') fail(409, 'Only matches waiting to be played can be moved');
      const [{ min }] = await q('SELECT MIN(queue_pos) AS min FROM matches WHERE tournament_id = $1', [tournament.id]);
      await q('UPDATE matches SET queue_pos = $1 WHERE id = $2', [top ? (min ?? 0) - 1 : null, m.id]);
      return view(q, tournament, actor);
    });
  }

  // When a match ends on a court and auto-call is on, the next match goes there.
  async function autoCall(q, tournament, court) {
    const courts = courtsOf(tournament);
    if (!courts || !courts.auto || !court || !courts.names.includes(court)) return;
    const v = await view(q, tournament, null);
    const plan = schedule.orderOfPlay({ events: v.events, courts: courts.names, minutes: courts.minutes });
    const free = plan.courts.find((c) => c.name === court);
    if (free.match || !plan.next) return;
    await q(
      `UPDATE matches SET court = $1, status = 'live', called_at = now(), queue_pos = NULL, updated_at = now() WHERE id = $2 AND status = 'scheduled'`,
      [court, plan.next.match.id],
    );
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
      // Taking a match off court clears its court; putting it on court records when.
      await q(
        `UPDATE matches SET court = $1, first_server = $2, status = $3, updated_at = now(),
           called_at = CASE WHEN $3 = 'live' THEN COALESCE(called_at, now()) END WHERE id = $4`,
        [status === 'scheduled' && input.status === 'scheduled' ? null : court, firstServer, status, m.id],
      );
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
      } else if (p.kind === 'org') {
        await orgs.applyPayment(q, paid);
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
    if (payment.kind === 'org') {
      const [o] = await db.query('SELECT slug, name, paid_until FROM orgs WHERE id = $1', [payment.org_id]);
      if (!o) return;
      try {
        await mailer.send({
          to: payment.user_email,
          ...orgReceiptEmail({ business: cfg.business, org: o.name, until: o.paid_until, amount: payment.amount, currency: payment.currency, paymentId: payment.payment_id, paidAt: payment.paid_at, url: `${baseUrl}/@${o.slug}` }),
        });
      } catch (err) {
        console.error('Receipt email failed:', err.message);
      }
      return;
    }
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
            url: `${baseUrl}/t/${payment.tournament_id}/entries?e=${payment.event_id}`,
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
          url: `${baseUrl}/t/${payment.tournament_id}`,
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
      await adminLog(q, actor, 'tournament.plan', t.id, { name: t.name, from: t.plan, to: plan });
    });
  }

  // Every change made through the admin dashboard is recorded.
  const adminLog = (q, actor, action, target, detail) => q(
    'INSERT INTO admin_log (admin_email, action, target, detail) VALUES ($1, $2, $3, $4::jsonb)',
    [actor.user.email, action, target == null ? null : String(target), JSON.stringify(detail || {})],
  );
  const likeTerm = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // Money taken, net of refunds (payments.amount is in paise).
  const NET = `COALESCE(SUM(amount - COALESCE(refunded_amount, 0)) FILTER (WHERE status IN ('paid', 'refunded')), 0)::int`;

  // The dashboard's numbers: totals, last 7 and 30 days, and a 30-day series.
  async function adminStats(actor) {
    requireSiteAdmin(actor);
    const span = (col) => `COUNT(*)::int AS total, (COUNT(*) FILTER (WHERE ${col} > now() - interval '7 days'))::int AS d7,
      (COUNT(*) FILTER (WHERE ${col} > now() - interval '30 days'))::int AS d30`;
    const [[users], [tournaments], [entries], [matches], [revenue]] = await Promise.all([
      db.query(`SELECT ${span('created_at')} FROM users`),
      db.query(`SELECT ${span('created_at')} FROM tournaments`),
      db.query(`SELECT ${span('created_at')} FROM entries`),
      db.query(`SELECT (COUNT(*) FILTER (WHERE status = 'done'))::int AS done, COALESCE(SUM(length(rallies)), 0)::int AS points FROM matches`),
      db.query(`SELECT ${NET} AS total,
        COALESCE(SUM(amount - COALESCE(refunded_amount, 0)) FILTER (WHERE status IN ('paid', 'refunded') AND paid_at >= date_trunc('month', now())), 0)::int AS month,
        COALESCE(SUM(amount - COALESCE(refunded_amount, 0)) FILTER (WHERE status IN ('paid', 'refunded') AND kind = 'plan'), 0)::int AS plans,
        COALESCE(SUM(amount - COALESCE(refunded_amount, 0)) FILTER (WHERE status IN ('paid', 'refunded') AND kind = 'entry'), 0)::int AS entries,
        COALESCE(SUM(refunded_amount), 0)::int AS refunded FROM payments`),
    ]);
    const by = (col) => db.query(`SELECT ${col} AS key, COUNT(*)::int AS n FROM tournaments GROUP BY ${col} ORDER BY n DESC, key`);
    const [bySport, byPlan, byStatus, byVisibility, days, log] = await Promise.all([
      by('sport'), by('plan'), by('status'), by('visibility'),
      db.query(`SELECT to_char(d, 'YYYY-MM-DD') AS day,
          (SELECT COUNT(*)::int FROM users u WHERE u.created_at::date = d) AS signups,
          (SELECT COUNT(*)::int FROM tournaments t WHERE t.created_at::date = d) AS tournaments,
          (SELECT COALESCE(SUM(p.amount - COALESCE(p.refunded_amount, 0)), 0)::int FROM payments p WHERE p.status IN ('paid', 'refunded') AND p.paid_at::date = d) AS revenue
        FROM generate_series(current_date - 29, current_date, interval '1 day') AS d ORDER BY d`),
      db.query(`SELECT admin_email AS "admin", action, target, detail, created_at AS "at" FROM admin_log ORDER BY id DESC LIMIT 20`),
    ]);
    return { users, tournaments, entries, matches, revenue, bySport, byPlan, byStatus, byVisibility, days, log, currency: billingConfig().currency };
  }

  // Every tournament, private ones too, 50 at a time.
  async function adminTournaments(actor, filters = {}) {
    requireSiteAdmin(actor);
    const f = (k) => (typeof filters[k] === 'string' ? filters[k].trim().slice(0, 80) : '');
    const where = ['true'];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };
    if (f('q')) add(`(t.name ILIKE ? OR t.id ILIKE ? OR COALESCE(t.city, '') ILIKE ? OR EXISTS (SELECT 1 FROM members m WHERE m.tournament_id = t.id AND m.role = 'owner' AND m.email ILIKE ?))`, likeTerm(f('q')));
    if (f('sport')) add('t.sport = ?', f('sport'));
    if (f('plan')) add('t.plan = ?', f('plan'));
    if (f('visibility')) add('t.visibility = ?', f('visibility'));
    if (f('status')) add('t.status = ?', f('status'));
    params.push(Math.max(0, Number(filters.offset) || 0));
    const rows = await db.query(
      `SELECT t.id, t.name, t.sport, t.plan, t.official, t.visibility, t.status, t.city, t.created_at AS "createdAt", t.starts_on AS "startsOn",
              (SELECT m.email FROM members m WHERE m.tournament_id = t.id AND m.role = 'owner' LIMIT 1) AS owner,
              (SELECT COUNT(*)::int FROM entries e WHERE e.tournament_id = t.id AND e.paired_into IS NULL) AS entries,
              (SELECT COUNT(*)::int FROM events ev WHERE ev.tournament_id = t.id) AS events,
              COUNT(*) OVER ()::int AS total
       FROM tournaments t WHERE ${where.join(' AND ')}
       ORDER BY t.created_at DESC, t.id LIMIT 50 OFFSET $${params.length}`,
      params,
    );
    return {
      tournaments: rows.map(({ total, startsOn, ...r }) => ({ ...r, startsOn: startsOn instanceof Date ? startsOn.toISOString().slice(0, 10) : startsOn, sportName: sports.get(r.sport)?.name || r.sport, planName: PLAN_NAMES[r.plan] || r.plan })),
      total: rows[0]?.total ?? 0,
      plans: Object.entries(PLAN_NAMES).map(([id, name]) => ({ id, name })),
    };
  }

  // One person: their tournaments (with their role), entries and payments.
  async function adminUserDetail(actor, id) {
    requireSiteAdmin(actor);
    const [u] = await db.query('SELECT id, email FROM users WHERE id = $1', [Number(id) || 0]);
    if (!u) fail(404, 'User not found');
    const [tournaments, entries, payments] = await Promise.all([
      db.query(`SELECT t.id, t.name, t.sport, t.status, t.plan, t.visibility, m.role FROM members m JOIN tournaments t ON t.id = m.tournament_id
                WHERE m.email = $1 ORDER BY t.created_at DESC LIMIT 100`, [u.email]),
      db.query(`SELECT e.id, e.name, e.fee_status AS "feeStatus", e.confirmed, e.withdrawn, t.id AS "tournamentId", t.name AS "tournamentName", ev.name AS "eventName"
                FROM entries e JOIN tournaments t ON t.id = e.tournament_id LEFT JOIN events ev ON ev.id = e.event_id
                WHERE e.user_id = $1 ORDER BY e.created_at DESC LIMIT 100`, [u.id]),
      db.query(`SELECT id, tournament_id AS "tournamentId", tournament_name AS "tournamentName", amount, refunded_amount AS "refundedAmount", status, kind, tier, paid_at AS "paidAt", created_at AS "createdAt"
                FROM payments WHERE user_email = $1 ORDER BY created_at DESC LIMIT 100`, [u.email]),
    ]);
    return { tournaments, entries, payments };
  }

  function paymentFilters(filters = {}) {
    const f = (k) => (typeof filters[k] === 'string' ? filters[k].trim().slice(0, 80) : '');
    const where = ['true'];
    const params = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };
    if (['paid', 'created', 'failed', 'refunded'].includes(f('status'))) add('p.status = ?', f('status'));
    if (f('status') === 'partial') where.push(`p.status = 'paid' AND COALESCE(p.refunded_amount, 0) > 0`);
    if (['plan', 'entry', 'org'].includes(f('kind'))) add('p.kind = ?', f('kind'));
    if (f('q')) add(`(p.tournament_name ILIKE ? OR COALESCE(p.user_email, '') ILIKE ? OR COALESCE(p.payment_id, '') ILIKE ? OR COALESCE(p.player, '') ILIKE ?)`, likeTerm(f('q')));
    if (ISO_DATE.test(f('from'))) add('p.created_at >= ?::date', f('from'));
    if (ISO_DATE.test(f('to'))) add(`p.created_at < (?::date + interval '1 day')`, f('to'));
    return { where: where.join(' AND '), params };
  }

  async function adminPayments(actor, filters = {}) {
    requireSiteAdmin(actor);
    const { where, params } = paymentFilters(filters);
    const rows = await db.query(
      `SELECT p.id, p.tournament_id AS "tournamentId", p.tournament_name AS "tournamentName", p.user_email AS "email",
              p.order_id AS "orderId", p.payment_id AS "paymentId", p.amount, p.currency, p.status,
              p.created_at AS "createdAt", p.paid_at AS "paidAt", p.tier, p.kind, p.event_name AS "eventName", p.player, t.plan,
              p.refund_id AS "refundId", COALESCE(p.refunded_amount, 0) AS "refundedAmount", p.refunded_at AS "refundedAt"
       FROM payments p LEFT JOIN tournaments t ON t.id = p.tournament_id
       WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT 1000`,
      params,
    );
    const [{ total, count }] = await db.query(
      `SELECT COALESCE(SUM(p.amount - COALESCE(p.refunded_amount, 0)) FILTER (WHERE p.status IN ('paid', 'refunded')), 0)::int AS total,
              (COUNT(*) FILTER (WHERE p.status IN ('paid', 'refunded')))::int AS count FROM payments p WHERE ${where}`,
      params,
    );
    return { payments: rows, revenue: { total, count, currency: billingConfig().currency } };
  }

  // The same list as a spreadsheet. Cells that start like a formula are
  // prefixed, so opening the file can't run anything.
  async function paymentsCsv(actor, filters = {}) {
    const { payments } = await adminPayments(actor, filters);
    const cell = (v) => {
      let s = v == null ? '' : v instanceof Date ? v.toISOString() : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const rupees = (paise) => (paise / 100).toFixed(2);
    const head = ['Date', 'Tournament', 'Tournament ID', 'Paid by', 'For', 'Event', 'Player', 'Amount', 'Refunded', 'Status', 'Payment ID', 'Order ID', 'Refund ID'];
    const lines = payments.map((p) => [p.paidAt || p.createdAt, p.tournamentName, p.tournamentId, p.email, p.kind === 'entry' ? 'Entry fee' : p.kind === 'org' ? 'Academy page (1 year)' : PLAN_NAMES[p.tier || 'pass'] || p.tier,
      p.eventName, p.player, rupees(p.amount), rupees(p.refundedAmount), p.status, p.paymentId, p.orderId, p.refundId].map(cell).join(','));
    return [head.map(cell).join(','), ...lines].join('\r\n') + '\r\n';
  }

  // Refund (all or part of) a paid payment through Razorpay. A refunded plan
  // payment can also move the tournament back to the plan it had before; a
  // fully refunded entry fee frees the place.
  const PLAN_RANK = { free: 0, club: 1, open: 2, championship: 3, pass: 4 };
  async function refundPayment(actor, paymentId, input = {}) {
    requireSiteAdmin(actor);
    const cfg = billingConfig();
    if (!cfg.enabled) fail(503, 'Razorpay isn\'t set up, so refunds can\'t be made from here');
    return db.tx(async (q) => {
      const [p] = await q('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [Number(paymentId) || 0]);
      if (!p) fail(404, 'Payment not found');
      if (p.status !== 'paid' || !p.payment_id) fail(409, 'Only completed payments can be refunded');
      const left = p.amount - (p.refunded_amount || 0);
      const amount = input.amount == null || input.amount === '' ? left : Math.round(Number(input.amount));
      if (!Number.isInteger(amount) || amount <= 0) fail(400, 'Enter an amount to refund');
      if (amount > left) fail(400, `At most ${left / 100} can be refunded`);
      let refund;
      try {
        refund = await razorpay(cfg).refund(p.payment_id, amount);
      } catch (err) {
        fail(502, `Razorpay didn't make the refund: ${err.message.replace(/^Razorpay \d+: /, '')}`);
      }
      const refunded = (p.refunded_amount || 0) + amount;
      const full = refunded >= p.amount;
      await q(`UPDATE payments SET refund_id = $1, refunded_amount = $2, refunded_at = now(), status = $3 WHERE id = $4`,
        [refund.id || null, refunded, full ? 'refunded' : 'paid', p.id]);
      let plan = null;
      if (p.kind === 'plan' && input.downgrade && p.tournament_id) {
        // Back to the best plan still paid for, or Free.
        const others = await q(`SELECT tier FROM payments WHERE tournament_id = $1 AND kind = 'plan' AND status = 'paid' AND id <> $2`, [p.tournament_id, p.id]);
        plan = others.map((x) => x.tier || 'pass').sort((a, b) => (PLAN_RANK[b] || 0) - (PLAN_RANK[a] || 0))[0] || 'free';
        await q('UPDATE tournaments SET plan = $1, plan_updated_at = now() WHERE id = $2', [plan, p.tournament_id]);
      }
      if (p.kind === 'org' && input.downgrade && p.org_id) {
        await orgs.takeBackYear(q, p.org_id);
        plan = 'org';
      }
      if (p.kind === 'entry' && full && p.entry_id) {
        await q(`UPDATE entries SET fee_status = 'refunded', confirmed = false WHERE id = $1`, [p.entry_id]);
      }
      await adminLog(q, actor, 'payment.refund', p.id, { tournament: p.tournament_name, amount, full, plan, refundId: refund.id || null });
      return { ok: true, refunded, status: full ? 'refunded' : 'paid', plan };
    });
  }

  // An academy's tournaments for its page: public ones (and private ones for its team).
  async function orgCards(q, orgId, { includePrivate = false } = {}) {
    const rows = await q(
      `SELECT ${CARD_COLUMNS} FROM tournaments t WHERE t.org_id = $1 ${includePrivate ? '' : `AND t.visibility = 'public'`}
       ORDER BY t.starts_on DESC NULLS LAST, t.created_at DESC LIMIT 60`,
      [orgId],
    );
    return rows.map(cardOf);
  }

  // Site settings the admin dashboard changes (logged).
  async function adminSettings(actor) {
    requireSiteAdmin(actor);
    return settings.all();
  }
  async function setAdminSettings(actor, input = {}) {
    requireSiteAdmin(actor);
    for (const key of Object.keys(input)) {
      if (!(key in settings.DEFAULTS)) fail(400, `Unknown setting: ${key}`);
      const from = await settings.get(key);
      const to = typeof settings.DEFAULTS[key] === 'boolean' ? Boolean(input[key]) : input[key];
      await settings.set(key, to, actor.user.email);
      await adminLog(db.query, actor, 'setting.change', key, { from, to });
    }
    return settings.all();
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
        ? `${baseUrl}/signin?next=${encodeURIComponent(next)}&email=${encodeURIComponent(email)}`
        : `${baseUrl}/signup?next=${encodeURIComponent(next)}&email=${encodeURIComponent(email)}`;
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

  profiles = createPlayers({ db, fail, text, imageType, maxImageBytes: MAX_IMAGE_BYTES, mediaUrl, mailer: mailer?.enabled ? mailer : null, baseUrl: process.env.BASE_URL || '' });

  orgs = createOrgs({
    db, fail, text, imageType, maxImageBytes: MAX_IMAGE_BYTES, mediaUrl, billingConfig, razorpay, adminLog, requireSiteAdmin, settings, orgCards,
    tournamentAccess: (q, id, actor) => lockWith(q, id, actor, 'manage'),
  });

  const notify = createNotify({ db, fail, mailer: mailer?.enabled ? mailer : null, baseUrl: (process.env.APP_URL || 'https://tonament.com').replace(/\/+$/, '') });
  social = createSocial({ db, fail, text, mediaUrl, notify });
  const challenges = createChallenges({ db, fail, text, social, notify });
  const groups = createGroups({ db, fail, text, orgs, social, notify, ratings: challenges });
  const clubs = createClubs({ db, fail, orgs, social, mediaUrl, notify });
  const ladders = createLadders({ db, fail, text, social, notify, challenges });
  const goals = createGoals({ db, fail, text, social, notify });
  const ties = createTies({ db, fail, load, accessOf, matchOf, eventFor, saveRallies, requireStageOpen });
  goalsRef = goals;
  // (the goal card asks the goals module for a goal when it's drawn)
  const cards = createCards({ db, goalsView: (id) => goalsRef.get(id, null) });

  referrals = createReferrals({ db, fail, mailer: mailer?.enabled ? mailer : null, baseUrl: (process.env.APP_URL || 'https://tonament.com').replace(/\/+$/, ''), confirmWaiting });

  // A free upgrade from a referral credit: one of your tournaments moves up a plan.
  async function useCredit(id, actor, creditId) {
    if (!actor.user) fail(401, 'Sign in first');
    return db.tx(async (q) => {
      const { t } = await lockWith(q, id, actor, 'manage');
      const done = await referrals.useCredit(q, actor.user, t, creditId);
      return { ...done, tournament: await view(q, await load(q, id), actor) };
    });
  }

  return {
    orgs,
    groups,
    clubs,
    social,
    cards,
    notify,
    challenges,
    ladders,
    goals,
    ties,
    referrals,
    useCredit,
    takeOverScoring,
    previewScoringChange,
    changeScoring,
    players: profiles,
    connectDupr,
    disconnectDupr,
    adminDupr,
    adminDuprRetry,
    sendToDupr,
    setEntryPlayers,
    seedByDupr,
    duprCsv,
    settings,
    adminSettings,
    setAdminSettings,
    checkout,
    verifyPayment,
    razorpayWebhook,
    adminSetPlan,
    setOfficial,
    setEntryFee,
    adminPayments,
    adminStats,
    adminTournaments,
    adminUserDetail,
    paymentsCsv,
    refundPayment,
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
    uploadMedia,
    updateMedia,
    deleteMedia,
    getMedia,
    pairSolos,
    drawPairs,
    unpair,
    updateEvent,
    callMatch,
    markFeeSent,
    leave,
    myEntries,
    sharePreview,
    tournamentPage,
    sitemapTournaments,
    cityPlaces,
    queueMatch,
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
    getRoster,
    setRoster,
    setMemberFee,
    arrive,
    setAway,
    giveWalkover,
    retire,
    renameEntry,
    setEntryLevel,
    moveEntry,
    withdraw,
    removeEntry,
    reorderEntries,
    start,
    startKnockout,
    rally,
    setResult,
    undo,
    updateMatch,
  };
}

module.exports = { createService, HttpError };
