'use strict';

// Groups: people who play together every day. The group's schedule makes
// sessions; members RSVP (one tap from a WhatsApp link) and check in at the
// venue; the next game is suggested fairly; any player in the game scores it
// live and the losing side confirms; confirmed games move ratings.

const crypto = require('node:crypto');
const sports = require('./sports');
const L = require('./group-logic');
const { courtWord, levelsFor } = require('../public/sports/events');

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const AUTO_CONFIRM_MINUTES = 10;
const MAX_COURTS = 12;

// orgs: the venue / academy pages module (a group can be hosted by one).
function createGroups({ db, fail, text, orgs }) {
  // ---------- helpers

  const slugOf = (value) => String(value || '').trim().toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  const sportOf = (g) => sports.get(g.sport);
  const scoringOf = (g) => sportOf(g).normalizeConfig((g.settings || {}).scoring);
  const needUser = (actor) => { if (!actor?.user) fail(401, 'Sign in first'); return actor.user; };

  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const minutesOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const hhmmOf = (mins) => { const m = ((mins % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  // Minutes from the start to `hhmm`, wrapping past midnight (20:00 -> 00:30 is 270).
  const minutesAfter = (start, hhmm) => (((minutesOf(hhmm) - minutesOf(start)) % 1440) + 1440) % 1440;
  // The finish time: set, or worked out from the session length (older groups).
  const endTimeOf = (st) => st.endTime || hhmmOf(minutesOf(st.time || '06:00') + Math.round((st.hours || 3) * 60));

  function readSettings(input = {}, prev = {}, sport) {
    const s = { days: [1, 2, 3, 4, 5, 6], time: '06:00', timeZone: 'Asia/Kolkata', courts: 2, maxPlayers: null, hours: 3, singles: false, ...prev };
    if (input.days !== undefined) {
      if (!Array.isArray(input.days)) fail(400, 'days must be a list');
      s.days = [...new Set(input.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    }
    if (input.time !== undefined) {
      if (!TIME_RE.test(String(input.time))) fail(400, 'Time: use HH:MM, like 06:00');
      s.time = String(input.time);
    }
    // The venue's time zone (the create form sends the organiser's): sessions start at local time there.
    if (input.timeZone !== undefined && input.timeZone !== null && input.timeZone !== '') {
      try {
        s.timeZone = new Intl.DateTimeFormat('en-US', { timeZone: String(input.timeZone) }).resolvedOptions().timeZone;
      } catch {
        fail(400, 'Unknown time zone');
      }
    }
    // The finish time sets the session length (and moves with the start time).
    if (input.endTime !== undefined && input.endTime !== null && input.endTime !== '') {
      if (!TIME_RE.test(String(input.endTime))) fail(400, 'End time: use HH:MM, like 09:00');
      s.endTime = String(input.endTime);
    }
    if (s.endTime) {
      const mins = minutesAfter(s.time, s.endTime);
      if (mins < 30 || mins > 12 * 60) fail(400, 'Sessions run from 30 minutes to 12 hours — check the start and end times');
      s.hours = mins / 60;
    }
    if (input.courts !== undefined) {
      const n = Number(input.courts);
      if (!Number.isInteger(n) || n < 1 || n > MAX_COURTS) fail(400, `Courts: 1 to ${MAX_COURTS}`);
      s.courts = n;
    }
    if (input.maxPlayers !== undefined) {
      const n = input.maxPlayers === null || input.maxPlayers === '' ? null : Number(input.maxPlayers);
      if (n !== null && (!Number.isInteger(n) || n < 2 || n > 200)) fail(400, 'Max players: 2 to 200, or leave it empty');
      s.maxPlayers = n;
    }
    if (input.hours !== undefined && !s.endTime) {
      const n = Number(input.hours);
      if (!Number.isFinite(n) || n < 1 || n > 12) fail(400, 'Session length: 1 to 12 hours');
      s.hours = n;
    }
    if (input.singles !== undefined) s.singles = Boolean(input.singles);
    // Skill levels the slot is for (none: all levels), e.g. a venue's
    // "Beginners 6–7 pm" and "Intermediate 7–9 pm" groups.
    if (input.levels !== undefined) {
      if (!Array.isArray(input.levels)) fail(400, 'levels must be a list');
      const allowed = levelsFor(sport.id).filter((l) => l !== 'Open');
      const bad = input.levels.find((l) => !allowed.includes(l));
      if (bad) fail(400, `Level: one of ${allowed.join(', ')}`);
      s.levels = allowed.filter((l) => input.levels.includes(l));
    }
    // Open: anyone who finds it (say, on the venue's page) joins straight away.
    if (input.open !== undefined) s.open = Boolean(input.open);
    if (input.scoring !== undefined) s.scoring = sport.normalizeConfig(input.scoring);
    if (!s.scoring) s.scoring = sport.normalizeConfig({ ...sport.defaults, bestOf: 1 });
    return s;
  }

  // The group and the viewer's membership, in one round trip.
  async function load(q, slug, { lock = false, actor = null } = {}) {
    const uid = actor?.user?.id || 0;
    const [row] = await q(
      `SELECT g.*, m.role AS m_role, m.status AS m_status, m.rating AS m_rating, m.games AS m_games, m.user_id AS m_user,
              o.slug AS o_slug, o.name AS o_name, o.kind AS o_kind, o.paid_until AS o_paid, o.address AS o_address, o.city AS o_city
       FROM groups g LEFT JOIN group_members m ON m.group_id = g.id AND m.user_id = $2 LEFT JOIN orgs o ON o.id = g.org_id
       WHERE g.slug = $1${lock ? ' FOR UPDATE OF g' : ''}`,
      [String(slug || '').toLowerCase(), uid],
    );
    if (!row) fail(404, 'Group not found');
    const { m_role: role, m_status: status, m_rating: rating, m_games: games, m_user: user, o_slug: oSlug, o_name: oName, o_kind: oKind, o_paid: oPaid, o_address: oAddress, o_city: oCity, ...g } = row;
    // The venue or academy hosting it (its page link only while the page is public).
    g.host = oSlug ? {
      slug: oSlug, name: oName, kind: oKind, kindName: (orgs?.KIND_NAMES || {})[oKind] || 'Venue',
      // The city only when the address doesn't already end with it.
      address: [oAddress, oCity && !(oAddress || '').toLowerCase().includes(oCity.toLowerCase()) ? oCity : null].filter(Boolean).join(', ') || null,
      public: Boolean(oPaid && Date.parse(oPaid) + (orgs?.GRACE_DAYS || 14) * 86400000 > Date.now()),
    } : null;
    g.member = user ? { group_id: g.id, user_id: user, role, status, rating, games } : null;
    g.memberFor = uid;
    return g;
  }
  async function memberOf(q, g, actor) {
    if (!actor?.user) return null;
    if (g.memberFor === actor.user.id) return g.member;
    const [m] = await q('SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2', [g.id, actor.user.id]);
    return m || null;
  }
  const isAdmin = (m, actor) => Boolean(actor?.user?.isAdmin || (m && m.status === 'active' && m.role === 'admin'));
  async function needMember(q, g, actor) {
    needUser(actor);
    const m = await memberOf(q, g, actor);
    if (actor.user.isAdmin && !m) return { role: 'admin', status: 'active', site: true };
    if (!m || m.status !== 'active') fail(403, 'Join the group first');
    return m;
  }
  async function needAdmin(q, g, actor) {
    const m = await needMember(q, g, actor);
    if (!isAdmin(m, actor)) fail(403, 'Only group admins can do this');
    return m;
  }

  // ---------- groups

  // The venue / academy pages this person manages (to host groups).
  async function hostsFor(q, actor) {
    if (!actor?.user) return [];
    return q(`SELECT o.id, o.slug, o.name, o.kind FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.email = $1 ORDER BY o.name`, [actor.user.email]);
  }
  // input.host: a page's slug ('' or null: no host). Only that page's team can pick it.
  async function readHost(q, actor, host) {
    if (host === null || host === '') return null;
    const slug = String(host).toLowerCase();
    if (actor.user.isAdmin) {
      const [o] = await q('SELECT id FROM orgs WHERE slug = $1', [slug]);
      if (!o) fail(404, 'Page not found');
      return o.id;
    }
    const o = (await hostsFor(q, actor)).find((x) => x.slug === slug);
    if (!o) fail(403, 'Only that page\'s team can host a group there');
    return o.id;
  }
  async function hostOptions(slug, actor) {
    return db.tx(async (q) => {
      const g = await load(q, slug, { actor });
      await needAdmin(q, g, actor);
      return (await hostsFor(q, actor)).map((o) => ({ slug: o.slug, name: o.name, kindName: (orgs?.KIND_NAMES || {})[o.kind] || 'Venue' }));
    });
  }

  async function createGroup(actor, input = {}) {
    const user = needUser(actor);
    const name = text(input.name, 'Group name', { max: 60 });
    const sport = sports.get(input.sport);
    if (!sport) fail(400, 'Choose a sport');
    const settings = readSettings({ ...(input.host && input.open === undefined && { open: true }), ...input }, {}, sport);
    return db.tx(async (q) => {
      let slug = slugOf(input.slug || name);
      if (slug.length < 3) slug = `group-${crypto.randomBytes(3).toString('hex')}`;
      for (let i = 2; (await q('SELECT 1 FROM groups WHERE slug = $1', [slug])).length; i++) slug = `${slugOf(name).slice(0, 34)}-${i}`;
      const orgId = input.host ? await readHost(q, actor, input.host) : null;
      const [g] = await q(
        `INSERT INTO groups (slug, name, sport, city, venue, about, invite_token, settings, created_by, org_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) RETURNING *`,
        [slug, name, sport.id, text(input.city, 'City', { max: 60, optional: true }), text(input.venue, 'Venue', { max: 120, optional: true }),
          text(input.about, 'About', { max: 500, optional: true }), crypto.randomBytes(9).toString('base64url'), JSON.stringify(settings), user.id, orgId],
      );
      await q(`INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')`, [g.id, user.id]);
      return { slug: g.slug };
    });
  }

  async function updateGroup(slug, actor, input = {}) {
    await db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      await needAdmin(q, g, actor);
      const set = { settings: JSON.stringify(readSettings(input, g.settings, sportOf(g))) };
      if (input.name !== undefined) set.name = text(input.name, 'Group name', { max: 60 });
      for (const [k, label, max] of [['city', 'City', 60], ['venue', 'Venue', 120], ['about', 'About', 500]]) {
        if (input[k] !== undefined) set[k] = text(input[k], label, { max, optional: true });
      }
      if (input.host !== undefined) set.org_id = await readHost(q, actor, input.host);
      if (input.newInvite) set.invite_token = crypto.randomBytes(9).toString('base64url');
      const keys = Object.keys(set);
      await q(`UPDATE groups SET ${keys.map((k, i) => `${k} = $${i + 1}${k === 'settings' ? '::jsonb' : ''}`).join(', ')} WHERE id = $${keys.length + 1}`, [...keys.map((k) => set[k]), g.id]);
    });
    return view(slug, actor);
  }

  async function myGroups(actor) {
    if (!actor?.user) return [];
    const rows = await db.query(
      `SELECT g.slug, g.name, g.sport, g.city, m.role, m.status, m.rating, m.games,
              (SELECT COUNT(*)::int FROM group_members x WHERE x.group_id = g.id AND x.status = 'active') AS members
       FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = $1 ORDER BY g.name`,
      [actor.user.id],
    );
    return rows.map((r) => ({ ...r, sportName: sports.get(r.sport)?.name || r.sport }));
  }

  // ---------- members

  // Joining with the invite link is instant; without it, it's a request.
  async function join(slug, actor, { token } = {}) {
    const user = needUser(actor);
    return db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      const m = await memberOf(q, g, actor);
      if (m && m.status === 'active') return { joined: true, already: true };
      const ok = Boolean(g.settings.open) || (typeof token === 'string' && token.length > 0 && token === g.invite_token);
      if (m) {
        if (ok) await q(`UPDATE group_members SET status = 'active', joined_at = now() WHERE group_id = $1 AND user_id = $2`, [g.id, user.id]);
      } else {
        await q('INSERT INTO group_members (group_id, user_id, status) VALUES ($1, $2, $3)', [g.id, user.id, ok ? 'active' : 'requested']);
      }
      return { joined: ok };
    });
  }

  // Admins: approve / decline a request, make or unmake admins, remove.
  async function setMember(slug, actor, userId, action) {
    await db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      await needAdmin(q, g, actor);
      const uid = Number(userId) || 0;
      const [m] = await q('SELECT * FROM group_members WHERE group_id = $1 AND user_id = $2', [g.id, uid]);
      if (!m) fail(404, 'Member not found');
      if (action === 'approve') await q(`UPDATE group_members SET status = 'active', joined_at = now() WHERE group_id = $1 AND user_id = $2`, [g.id, uid]);
      else if (action === 'admin' || action === 'member') {
        if (action === 'admin' && (await q('SELECT 1 FROM users WHERE id = $1 AND guest', [uid])).length) fail(409, 'They need to claim their spot before they can be an admin');
        if (action === 'member' && m.role === 'admin') {
          const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = $1 AND role = 'admin' AND status = 'active'`, [g.id]);
          if (n <= 1) fail(409, 'A group needs at least one admin');
        }
        await q('UPDATE group_members SET role = $3 WHERE group_id = $1 AND user_id = $2', [g.id, uid, action]);
      } else if (action === 'decline' || action === 'remove') {
        if (m.role === 'admin' && m.status === 'active') {
          const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = $1 AND role = 'admin' AND status = 'active'`, [g.id]);
          if (n <= 1) fail(409, 'A group needs at least one admin');
        }
        await q('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [g.id, uid]);
        // A guest nobody claimed: gone for good unless they're in a game.
        await q(`DELETE FROM users u WHERE u.id = $1 AND u.guest AND NOT EXISTS (SELECT 1 FROM group_games x WHERE $1 IN (x.a1, x.a2, x.b1, x.b2))`, [uid]);
      } else fail(400, 'Unknown action');
    });
    return view(slug, actor);
  }

  async function leave(slug, actor) {
    const user = needUser(actor);
    return db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      const m = await memberOf(q, g, actor);
      if (!m) return { left: true };
      if (m.role === 'admin') {
        const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = $1 AND role = 'admin' AND status = 'active'`, [g.id]);
        if (n <= 1) fail(409, 'Make someone else an admin before you leave');
      }
      await q('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [g.id, user.id]);
      return { left: true };
    });
  }

  // ---------- guests ("claim your spot")

  // Admins paste the names from their WhatsApp group; each becomes a guest
  // player who can be checked in, put on courts and ranked straight away.
  // A guest is a users row that can't sign in (no email of its own) until
  // someone claims the spot (see claim).
  const MAX_GUESTS = 200;
  // "1. Rahul", "- Priya", "~ Arjun K", "+91 98400 12345" (numbers are dropped).
  function namesFrom(input) {
    const lines = Array.isArray(input) ? input : String(input || '').split(/[\n,;]+/);
    const out = [];
    for (const raw of lines) {
      const name = String(raw).replace(/^\s*(?:\d+[.)]|[-*•~])\s*/, '').replace(/\+?\d[\d\s-]{6,}\d/g, '').replace(/\s+/g, ' ').trim();
      if (!name || !/\p{L}/u.test(name)) continue;
      if (name.length > 60) fail(400, `"${name.slice(0, 20)}…" is too long for a name (up to 60 characters)`);
      if (!out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
    }
    return out;
  }
  async function addGuests(slug, actor, input = {}) {
    const names = namesFrom(input.names);
    if (!names.length) fail(400, 'Add at least one name');
    const added = await db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      await needAdmin(q, g, actor);
      const existing = await q(`SELECT lower(u.name) AS name FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = $1`, [g.id]);
      const taken = new Set(existing.map((r) => r.name));
      const fresh = names.filter((n) => !taken.has(n.toLowerCase()));
      const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = $1 AND u.guest`, [g.id]);
      if (n + fresh.length > MAX_GUESTS) fail(400, `Up to ${MAX_GUESTS} unclaimed players in a group`);
      for (const name of fresh) {
        const [u] = await q(
          `INSERT INTO users (email, name, password_hash, guest, disabled_at) VALUES ($1, $2, 'guest', true, now()) RETURNING id`,
          [`guest-${crypto.randomBytes(9).toString('hex')}@guest.invalid`, name],
        );
        await q('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [g.id, u.id]);
      }
      return fresh.length;
    });
    return { added, skipped: names.length - added, group: await view(slug, actor) };
  }

  // "That's me": a signed-in player takes over a guest's spot — their games,
  // rating and RSVPs. Anyone who could join (the invite link, an open group,
  // or already a member) can claim; the admins see who did.
  async function claim(slug, actor, guestId, { token } = {}) {
    const user = needUser(actor);
    await db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      const m = await memberOf(q, g, actor);
      const allowed = (m && m.status === 'active') || g.settings.open || (typeof token === 'string' && token.length > 0 && token === g.invite_token);
      if (!allowed) fail(403, 'Use the invite link from the group to claim your spot');
      const gid = Number(guestId) || 0;
      const [guest] = await q(
        `SELECT m.* FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = $1 AND m.user_id = $2 AND u.guest`, [g.id, gid]);
      if (!guest) fail(404, 'That spot has already been claimed');
      if (m && m.games > 0) fail(409, 'You already have games in this group — ask an admin to sort it out');
      // My own (empty) membership gives way to the guest's, keeping admin if I was one.
      if (m) await q('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [g.id, user.id]);
      await q(`UPDATE group_members SET user_id = $3, status = 'active', role = $4 WHERE group_id = $1 AND user_id = $2`,
        [g.id, gid, user.id, m && m.role === 'admin' ? 'admin' : guest.role]);
      // RSVPs: where I'd already said something for a session, mine stands.
      await q(`DELETE FROM session_players p WHERE p.user_id = $1 AND EXISTS (SELECT 1 FROM session_players x WHERE x.session_id = p.session_id AND x.user_id = $2)`, [gid, user.id]);
      await q('UPDATE session_players SET user_id = $2 WHERE user_id = $1', [gid, user.id]);
      for (const col of ['a1', 'a2', 'b1', 'b2', 'confirmed_by']) await q(`UPDATE group_games SET ${col} = $2 WHERE group_id = $3 AND ${col} = $1`, [gid, user.id, g.id]);
      // Rating changes are kept by user id.
      const rated = await q(`SELECT id, deltas FROM group_games WHERE group_id = $1 AND deltas ? $2`, [g.id, String(gid)]);
      for (const x of rated) {
        const { [gid]: d, ...rest } = x.deltas;
        await q('UPDATE group_games SET deltas = $1::jsonb WHERE id = $2', [JSON.stringify({ ...rest, [user.id]: d }), x.id]);
      }
      await q('DELETE FROM users WHERE id = $1 AND guest', [gid]);
    });
    return view(slug, actor);
  }

  // ---------- sessions

  // The schedule's next sessions exist (made on demand); returns the current
  // one (started up to `hours` ago, or the next) and the one after.
  async function sessionsOf(q, g, now = new Date()) {
    const starts = L.upcomingStarts(g.settings, now, { count: 2, hours: g.settings.hours || 3 }).map((d) => d.toISOString());
    if (!starts.length) return [];
    const find = () => q('SELECT * FROM group_sessions WHERE group_id = $1 AND starts_at = ANY($2::timestamptz[]) ORDER BY starts_at', [g.id, starts]);
    const rows = await find();
    if (rows.length === starts.length) return rows;
    for (const at of starts) await q('INSERT INTO group_sessions (group_id, starts_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [g.id, at]);
    return find();
  }
  async function sessionOf(q, g, sessionId) {
    const [s] = await q('SELECT * FROM group_sessions WHERE id = $1 AND group_id = $2', [Number(sessionId) || 0, g.id]);
    if (!s) fail(404, 'Session not found');
    return s;
  }

  // I'm in / can't make it. With a player limit, extra RSVPs wait; when
  // someone drops out the first on the waitlist moves up.
  // eta: when they expect to arrive ('HH:MM' within the session, or null for
  // "from the start"). Sent alone, it just updates the time for someone in.
  async function rsvp(slug, actor, sessionId, status, { eta } = {}) {
    if (status !== undefined && status !== null && !['in', 'out'].includes(status)) fail(400, 'status must be in or out');
    if (!status && eta === undefined) fail(400, 'status must be in or out');
    await db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      await needMember(q, g, actor);
      const s = await sessionOf(q, g, sessionId);
      const max = g.settings.maxPlayers;
      const [cur] = await q('SELECT * FROM session_players WHERE session_id = $1 AND user_id = $2', [s.id, actor.user.id]);
      let time = null;
      if (eta !== undefined && eta !== null && eta !== '') {
        if (!TIME_RE.test(String(eta))) fail(400, 'Coming at: use HH:MM, like 07:30');
        if (minutesAfter(g.settings.time, String(eta)) >= Math.round((g.settings.hours || 3) * 60)) fail(400, `Pick a time between ${g.settings.time} and ${endTimeOf(g.settings)}`);
        time = minutesAfter(g.settings.time, String(eta)) === 0 ? null : String(eta);
      }
      if (!status) {
        if (!cur || cur.status === 'out') fail(409, 'Say you\'re in first');
        await q('UPDATE session_players SET eta = $3 WHERE session_id = $1 AND user_id = $2', [s.id, actor.user.id, time]);
        return;
      }
      let next = status;
      if (status === 'in' && max && (!cur || cur.status !== 'in')) {
        const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM session_players WHERE session_id = $1 AND status = 'in'`, [s.id]);
        if (n >= max) next = 'waitlist';
      }
      await q(
        `INSERT INTO session_players (session_id, user_id, status, eta) VALUES ($1, $2, $3, $4)
         ON CONFLICT (session_id, user_id) DO UPDATE SET status = EXCLUDED.status, rsvp_at = CASE WHEN session_players.status = EXCLUDED.status THEN session_players.rsvp_at ELSE now() END,
           checked_in_at = CASE WHEN EXCLUDED.status = 'out' THEN NULL ELSE session_players.checked_in_at END,
           eta = CASE WHEN EXCLUDED.status = 'out' THEN NULL WHEN $5 THEN EXCLUDED.eta ELSE session_players.eta END`,
        [s.id, actor.user.id, next, status === 'out' ? null : time, eta !== undefined],
      );
      if (status === 'out' && cur && cur.status === 'in' && max) {
        await q(`UPDATE session_players SET status = 'in' WHERE session_id = $1 AND user_id =
                 (SELECT user_id FROM session_players WHERE session_id = $1 AND status = 'waitlist' ORDER BY rsvp_at LIMIT 1)`, [s.id]);
      }
    });
    return view(slug, actor);
  }

  // I'm here (or leaving). Checking in also counts as an RSVP.
  async function checkIn(slug, actor, sessionId, here = true, userId = null) {
    await db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      const m = await needMember(q, g, actor);
      const s = await sessionOf(q, g, sessionId);
      const uid = userId && Number(userId) !== actor.user.id ? Number(userId) : actor.user.id;
      if (uid !== actor.user.id) {
        if (!isAdmin(m, actor)) fail(403, 'Only group admins can check in someone else');
        const [other] = await q(`SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`, [g.id, uid]);
        if (!other) fail(404, 'Member not found');
      }
      if (!here) {
        const [busy] = await q(`SELECT 1 FROM group_games WHERE session_id = $1 AND status = 'live' AND $2 IN (a1, a2, b1, b2)`, [s.id, uid]);
        if (busy) fail(409, 'Finish the game you\'re in first');
      }
      await q(
        `INSERT INTO session_players (session_id, user_id, status, checked_in_at) VALUES ($1, $2, 'in', $3)
         ON CONFLICT (session_id, user_id) DO UPDATE SET checked_in_at = EXCLUDED.checked_in_at,
           status = CASE WHEN EXCLUDED.checked_in_at IS NOT NULL THEN 'in' ELSE session_players.status END`,
        [s.id, uid, here ? new Date().toISOString() : null],
      );
    });
    return view(slug, actor);
  }

  // ---------- games

  async function playersInfo(q, g, ids) {
    const rows = await q(
      `SELECT u.id, u.name, u.handle, COALESCE(m.rating, ${L.START}) AS rating, COALESCE(m.games, 0) AS games
       FROM users u LEFT JOIN group_members m ON m.user_id = u.id AND m.group_id = $1 WHERE u.id = ANY($2::int[])`,
      [g.id, ids.filter(Boolean)],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  // Who's free to play, with what the suggestion needs to be fair.
  // players: the session's session_players rows; games: its games (not void).
  function freeFrom(players, games, info) {
    const here = players.filter((p) => p.status === 'in' && p.checked_in_at);
    const busy = new Set(games.filter((x) => x.status === 'live').flatMap((x) => [x.a1, x.a2, x.b1, x.b2]));
    return here.filter((h) => !busy.has(h.user_id)).map((h) => {
      const mine = games.filter((x) => [x.a1, x.a2, x.b1, x.b2].includes(h.user_id));
      const last = mine.filter((x) => x.ended_at).map((x) => Date.parse(x.ended_at)).sort((a, b) => b - a)[0];
      const partners = new Set(mine.map((x) => ([x.a1, x.a2].includes(h.user_id) ? [x.a1, x.a2] : [x.b1, x.b2]).find((id) => id && id !== h.user_id)).filter(Boolean));
      const p = info.get(h.user_id) || { rating: L.START, games: 0 };
      return { id: h.user_id, name: p.name || h.name, rating: p.rating ?? L.START, games: mine.length, waitingSince: last || Date.parse(h.checked_in_at), partners };
    });
  }
  async function freePlayers(q, g, s) {
    const [players, games] = await Promise.all([
      q('SELECT * FROM session_players WHERE session_id = $1', [s.id]),
      q(`SELECT * FROM group_games WHERE session_id = $1 AND status <> 'void' ORDER BY started_at`, [s.id]),
    ]);
    return freeFrom(players, games, await playersInfo(q, g, players.map((p) => p.user_id)));
  }

  // Starts a game on a free court. Players: { a: [ids], b: [ids] } (2 or 4).
  async function startGame(slug, actor, sessionId, input = {}) {
    return db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      const m = await needMember(q, g, actor);
      const s = await sessionOf(q, g, sessionId);
      const [me] = await q('SELECT checked_in_at FROM session_players WHERE session_id = $1 AND user_id = $2', [s.id, actor.user.id]);
      if (!isAdmin(m, actor) && !(me && me.checked_in_at)) fail(403, 'Check in first');
      const court = Number(input.court);
      const word = courtWord(g.sport); // Court, Table or Board
      if (!Number.isInteger(court) || court < 1 || court > g.settings.courts) fail(400, `${word}: 1 to ${g.settings.courts}`);
      const [taken] = await q(`SELECT 1 FROM group_games WHERE session_id = $1 AND court = $2 AND status = 'live'`, [s.id, court]);
      if (taken) fail(409, `${word} ${court} is busy`);
      const a = (input.a || []).map(Number);
      const b = (input.b || []).map(Number);
      const all = [...a, ...b];
      // Singles or doubles, whatever the group usually plays (its setting only steers suggestions).
      const ok = (a.length === 2 && b.length === 2) || (a.length === 1 && b.length === 1);
      if (!ok || new Set(all).size !== all.length) fail(400, 'Pick 2 or 4 different players');
      let free = new Set((await freePlayers(q, g, s)).map((p) => p.id));
      // An admin's picks can include people who turned up without checking in: they're checked in now.
      if (isAdmin(m, actor) && all.some((id) => !free.has(id))) {
        const members = await q(`SELECT user_id FROM group_members WHERE group_id = $1 AND status = 'active' AND user_id = ANY($2::int[])`, [g.id, all]);
        if (members.length !== all.length) fail(400, 'Everyone in the game has to be in the group');
        const busy = await q(`SELECT a1, a2, b1, b2 FROM group_games WHERE session_id = $1 AND status = 'live'`, [s.id]);
        const playing = new Set(busy.flatMap((x) => [x.a1, x.a2, x.b1, x.b2]));
        for (const id of all.filter((x) => !free.has(x) && !playing.has(x))) {
          await q(
            `INSERT INTO session_players (session_id, user_id, status, checked_in_at) VALUES ($1, $2, 'in', now())
             ON CONFLICT (session_id, user_id) DO UPDATE SET status = 'in', checked_in_at = COALESCE(session_players.checked_in_at, now())`,
            [s.id, id],
          );
        }
        free = new Set((await freePlayers(q, g, s)).map((p) => p.id));
      }
      const notFree = all.filter((id) => !free.has(id));
      if (notFree.length) fail(409, 'Someone picked isn\'t checked in or is already on a court');
      const [row] = await q(
        `INSERT INTO group_games (group_id, session_id, court, a1, a2, b1, b2, first_server) VALUES ($1, $2, $3, $4, $5, $6, $7, 'a') RETURNING id`,
        [g.id, s.id, court, a[0], a[1] || null, b[0], b[1] || null],
      );
      return { id: row.id };
    });
  }

  async function gameOf(q, g, gameId, { lock = false } = {}) {
    const [x] = await q(`SELECT * FROM group_games WHERE id = $1 AND group_id = $2${lock ? ' FOR UPDATE' : ''}`, [Number(gameId) || 0, g.id]);
    if (!x) fail(404, 'Game not found');
    return x;
  }
  const sideOf = (x, uid) => ([x.a1, x.a2].includes(uid) ? 'a' : [x.b1, x.b2].includes(uid) ? 'b' : null);
  const scoreOf = (g, x, rallies = x.rallies) => {
    const doubles = Boolean(x.a2);
    return sportOf(g).compute(rallies, { ...scoringOf(g), ...(doubles && { doubles: true }) }, x.first_server);
  };
  function canScore(m, actor, x) {
    return isAdmin(m, actor) || Boolean(sideOf(x, actor.user.id));
  }

  // A point to side a or b. `at` is how many rallies the scorer had seen, so
  // two phones scoring the same game can't double-count.
  // extra: { points, foul, end } for sports that score more than 1 a tap.
  async function rally(slug, actor, gameId, side, at, extra = {}) {
    if (!extra.end && side !== 'a' && side !== 'b') fail(400, 'side must be a or b');
    return db.tx(async (q) => {
      const g = await load(q, slug, { actor });
      const m = await needMember(q, g, actor);
      const x = await gameOf(q, g, gameId, { lock: true });
      if (!canScore(m, actor, x)) fail(403, 'Only the players in this game can score it');
      if (x.status !== 'live') fail(409, 'This game is over');
      if (x.final) fail(409, 'This game was entered as a final score');
      if (at !== undefined && Number(at) !== x.rallies.length) fail(409, 'Someone else scored at the same time — the score has been refreshed', 'stale');
      const tap = sports.tapFor(scoreOf(g, x, x.rallies), { ...extra, side });
      if (tap.error) fail(400, tap.error);
      const rallies = x.rallies + tap.ch;
      const sc = scoreOf(g, x, rallies);
      const [row] = await q(
        `UPDATE group_games SET rallies = $1, status = $2, winner = $3, ended_at = $4 WHERE id = $5 RETURNING *`,
        [rallies, sc.winner ? 'done' : 'live', sc.winner || null, sc.winner ? new Date().toISOString() : null, x.id],
      );
      return gameView(q, g, row, m, actor);
    });
  }

  async function undo(slug, actor, gameId, at) {
    return db.tx(async (q) => {
      const g = await load(q, slug, { actor });
      const m = await needMember(q, g, actor);
      const x = await gameOf(q, g, gameId, { lock: true });
      if (!canScore(m, actor, x)) fail(403, 'Only the players in this game can score it');
      if (!['live', 'done'].includes(x.status) || !x.rallies) fail(409, 'Nothing to undo');
      if (at !== undefined && Number(at) !== x.rallies.length) fail(409, 'Someone else scored at the same time — the score has been refreshed', 'stale');
      const [row] = await q(`UPDATE group_games SET rallies = $1, status = 'live', winner = NULL, ended_at = NULL WHERE id = $2 RETURNING *`, [x.rallies.slice(0, -1), x.id]);
      return gameView(q, g, row, m, actor);
    });
  }

  // Quick result: "21–17" instead of point by point.
  async function setResult(slug, actor, gameId, input = {}) {
    return db.tx(async (q) => {
      const g = await load(q, slug, { actor });
      const m = await needMember(q, g, actor);
      const x = await gameOf(q, g, gameId, { lock: true });
      if (!canScore(m, actor, x)) fail(403, 'Only the players in this game can enter the score');
      if (!['live', 'done'].includes(x.status)) fail(409, 'This game is already confirmed');
      const a = Number(input.a);
      const b = Number(input.b);
      if (![a, b].every((n) => Number.isInteger(n) && n >= 0 && n <= 99) || a === b) fail(400, 'Enter both scores, like 21 and 17');
      await q(`UPDATE group_games SET final = $1::jsonb, rallies = '', status = 'done', winner = $2, ended_at = now() WHERE id = $3`,
        [JSON.stringify({ a, b }), a > b ? 'a' : 'b', x.id]);
      return gameView(q, g, await gameOf(q, g, x.id), m, actor);
    });
  }

  // A game played without the app: the players and the final score, added
  // afterwards by one of them (or an admin). It waits for the other side to
  // confirm, like any other result. No court (0).
  async function addResult(slug, actor, sessionId, input = {}) {
    return db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      const m = await needMember(q, g, actor);
      const s = await sessionOf(q, g, sessionId);
      const a = (input.a || []).map(Number);
      const b = (input.b || []).map(Number);
      const all = [...a, ...b];
      if (!(a.length === b.length && [1, 2].includes(a.length)) || new Set(all).size !== all.length) fail(400, 'Pick 2 or 4 different players');
      const members = await q(`SELECT user_id FROM group_members WHERE group_id = $1 AND status = 'active' AND user_id = ANY($2::int[])`, [g.id, all]);
      if (members.length !== all.length) fail(400, 'Everyone in the game has to be in the group');
      if (!isAdmin(m, actor) && !all.includes(actor.user.id)) fail(403, 'Only the players in the game (or an admin) can add its result');
      const sa = Number(input.score?.a);
      const sb = Number(input.score?.b);
      if (![sa, sb].every((n) => Number.isInteger(n) && n >= 0 && n <= 99) || sa === sb) fail(400, 'Enter both scores, like 21 and 17');
      const [row] = await q(
        `INSERT INTO group_games (group_id, session_id, court, a1, a2, b1, b2, status, winner, final, ended_at)
         VALUES ($1, $2, 0, $3, $4, $5, $6, 'done', $7, $8::jsonb, now()) RETURNING id`,
        [g.id, s.id, a[0], a[1] || null, b[0], b[1] || null, sa > sb ? 'a' : 'b', JSON.stringify({ a: sa, b: sb })],
      );
      return { id: row.id };
    });
  }

  // Ratings move when a game is confirmed (and move back if it's voided).
  async function applyRating(q, g, x) {
    const ids = [x.a1, x.a2, x.b1, x.b2].filter(Boolean);
    const rows = await q('SELECT user_id AS id, rating, games FROM group_members WHERE group_id = $1 AND user_id = ANY($2::int[])', [g.id, ids]);
    const by = new Map(rows.map((r) => [r.id, r]));
    const team = (list) => list.filter(Boolean).map((id) => by.get(id) || { id, rating: L.START, games: 0 });
    const margin = x.final ? Math.abs(x.final.a - x.final.b) : (() => { const sc = scoreOf(g, x); return Math.abs(sc.totals.a - sc.totals.b); })();
    const deltas = L.rate(team([x.a1, x.a2]), team([x.b1, x.b2]), x.winner, margin);
    for (const [id, d] of Object.entries(deltas)) {
      const won = (x.winner === 'a' ? [x.a1, x.a2] : [x.b1, x.b2]).includes(Number(id));
      await q('UPDATE group_members SET rating = rating + $3, games = games + 1, wins = wins + $4 WHERE group_id = $1 AND user_id = $2', [g.id, Number(id), d, won ? 1 : 0]);
    }
    await q('UPDATE group_games SET deltas = $1::jsonb WHERE id = $2', [JSON.stringify(deltas), x.id]);
  }
  async function reverseRating(q, g, x) {
    for (const [id, d] of Object.entries(x.deltas || {})) {
      const won = (x.winner === 'a' ? [x.a1, x.a2] : [x.b1, x.b2]).includes(Number(id));
      await q('UPDATE group_members SET rating = rating - $3, games = GREATEST(games - 1, 0), wins = GREATEST(wins - $4, 0) WHERE group_id = $1 AND user_id = $2', [g.id, Number(id), d, won ? 1 : 0]);
    }
  }

  // The losing side (or an admin) confirms; games left unconfirmed for a
  // while confirm themselves (see autoConfirm).
  async function confirm(slug, actor, gameId) {
    return db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      const m = await needMember(q, g, actor);
      const x = await gameOf(q, g, gameId, { lock: true });
      if (!['done', 'disputed'].includes(x.status)) fail(409, x.status === 'confirmed' ? 'Already confirmed' : 'The game isn\'t finished');
      const loser = x.winner === 'a' ? 'b' : 'a';
      if (!isAdmin(m, actor) && sideOf(x, actor.user.id) !== loser) fail(403, 'The other side confirms the result');
      if (x.status === 'disputed' && !isAdmin(m, actor)) fail(403, 'A group admin settles disputed games');
      await q(`UPDATE group_games SET status = 'confirmed', confirmed_by = $1 WHERE id = $2`, [actor.user.id, x.id]);
      await applyRating(q, g, x);
      return gameView(q, g, await gameOf(q, g, x.id), m, actor);
    });
  }
  async function dispute(slug, actor, gameId) {
    return db.tx(async (q) => {
      const g = await load(q, slug, { actor });
      const m = await needMember(q, g, actor);
      const x = await gameOf(q, g, gameId, { lock: true });
      if (x.status !== 'done') fail(409, 'Only a finished, unconfirmed game can be disputed');
      if (!sideOf(x, actor.user.id) && !isAdmin(m, actor)) fail(403, 'Only the players in this game can dispute it');
      await q(`UPDATE group_games SET status = 'disputed' WHERE id = $1`, [x.id]);
      return gameView(q, g, await gameOf(q, g, x.id), m, actor);
    });
  }
  // Admins: void a game (its rating changes are undone) or reopen a disputed one.
  async function voidGame(slug, actor, gameId) {
    return db.tx(async (q) => {
      const g = await load(q, slug, { lock: true, actor });
      const m = await needAdmin(q, g, actor);
      const x = await gameOf(q, g, gameId, { lock: true });
      if (x.status === 'void') return gameView(q, g, x, m, actor);
      if (x.status === 'confirmed') await reverseRating(q, g, x);
      await q(`UPDATE group_games SET status = 'void', deltas = NULL WHERE id = $1`, [x.id]);
      return gameView(q, g, await gameOf(q, g, x.id), m, actor);
    });
  }
  async function autoConfirm(q, g) {
    const [any] = await q(`SELECT 1 FROM group_games WHERE group_id = $1 AND status = 'done' AND ended_at < now() - interval '${AUTO_CONFIRM_MINUTES} minutes' LIMIT 1`, [g.id]);
    if (!any) return;
    const due = await q(
      `SELECT * FROM group_games WHERE group_id = $1 AND status = 'done' AND ended_at < now() - interval '${AUTO_CONFIRM_MINUTES} minutes' FOR UPDATE`,
      [g.id],
    );
    for (const x of due) {
      await q(`UPDATE group_games SET status = 'confirmed' WHERE id = $1`, [x.id]);
      await applyRating(q, g, x);
    }
  }

  // ---------- views (built in memory from a few batched queries)

  function gameViewOf(g, x, m, actor, info) {
    const person = (id) => (id ? { id, name: info.get(id)?.name || 'Player', handle: info.get(id)?.handle || null } : null);
    const sc = x.final ? null : scoreOf(g, x);
    const me = actor?.user ? sideOf(x, actor.user.id) : null;
    const loser = x.winner ? (x.winner === 'a' ? 'b' : 'a') : null;
    return {
      id: x.id,
      court: x.court,
      status: x.status,
      a: [person(x.a1), person(x.a2)].filter(Boolean),
      b: [person(x.b1), person(x.b2)].filter(Boolean),
      winner: x.winner,
      final: x.final,
      rallies: x.rallies.length,
      log: x.rallies,
      firstServer: x.first_server,
      score: sc,
      summary: x.final ? `${x.final.a}–${x.final.b}` : sportOf(g).summary(sc),
      deltas: x.deltas,
      startedAt: x.started_at,
      endedAt: x.ended_at,
      confirmBy: x.status === 'done' && x.ended_at ? new Date(Date.parse(x.ended_at) + AUTO_CONFIRM_MINUTES * 60000).toISOString() : null,
      can: actor?.user ? {
        score: x.status === 'live' && (isAdmin(m, actor) || Boolean(me)),
        confirm: (x.status === 'done' && (me === loser || isAdmin(m, actor))) || (x.status === 'disputed' && isAdmin(m, actor)),
        dispute: x.status === 'done' && Boolean(me || isAdmin(m, actor)),
        void: isAdmin(m, actor) && x.status !== 'void',
      } : {},
    };
  }
  async function gameView(q, g, x, m, actor) {
    return gameViewOf(g, x, m, actor, await playersInfo(q, g, [x.a1, x.a2, x.b1, x.b2]));
  }

  const etaRank = (st, p) => (p.eta ? minutesAfter(st.time, p.eta) : 0);
  // Players in (not waitlisted) by each half hour of the session: who's here
  // or coming by then. Only the times when the count changes.
  function arrivalsOf(st, players) {
    const going = players.filter((p) => p.status === 'in');
    if (!going.some((p) => p.eta && !p.checked_in_at)) return [];
    const out = [];
    for (let m = 0; m < Math.round((st.hours || 3) * 60); m += 30) {
      const n = going.filter((p) => p.checked_in_at || etaRank(st, p) <= m).length;
      if (!out.length || out[out.length - 1].count !== n) out.push({ time: hhmmOf(minutesOf(st.time) + m), count: n });
    }
    return out;
  }

  // players: this session's session_players rows (with name, handle);
  // games: its games, newest first; info: members by user id.
  function sessionViewOf(g, s, players, games, info, m, actor, { skip = 0 } = {}) {
    const live = games.filter((x) => x.status === 'live');
    const count = (uid) => games.filter((x) => [x.a1, x.a2, x.b1, x.b2].includes(uid)).length;
    const onCourt = new Set(live.flatMap((x) => [x.a1, x.a2, x.b1, x.b2]));
    const startMs = Date.parse(s.starts_at);
    const now = Date.now();
    const free = freeFrom(players, games, info);
    const pick = L.suggest(free, { singles: g.settings.singles, skip });
    const names = new Map(players.map((p) => [p.user_id, p.name]));
    const name = (id) => ({ id, name: info.get(id)?.name || names.get(id) || 'Player' });
    const mine = players.find((p) => p.user_id === actor?.user?.id);
    const ordered = [...players].sort((a, b) => Date.parse(a.rsvp_at) - Date.parse(b.rsvp_at));
    return {
      id: s.id,
      startsAt: s.starts_at,
      endsAt: new Date(startMs + (g.settings.hours || 3) * 3600000).toISOString(),
      // How many are here or expected by each half hour ("6:00 — 4 · 6:30 — 7").
      arrivals: arrivalsOf(g.settings, players),
      today: now >= startMs - 3 * 3600000,
      started: now >= startMs,
      me: mine ? { status: mine.status, checkedIn: Boolean(mine.checked_in_at), eta: mine.eta || null } : null,
      // Here first, then by when they're coming (from the start before later times).
      players: ordered.filter((p) => p.status !== 'out')
        .sort((a, b) => Number(Boolean(b.checked_in_at)) - Number(Boolean(a.checked_in_at)) || etaRank(g.settings, a) - etaRank(g.settings, b))
        .map((p) => ({
          id: p.user_id, name: p.name, handle: p.handle, status: p.status, checkedIn: Boolean(p.checked_in_at), eta: p.checked_in_at ? null : p.eta || null,
        onCourt: onCourt.has(p.user_id), games: count(p.user_id), rating: info.get(p.user_id)?.rating ?? L.START,
      })),
      out: ordered.filter((p) => p.status === 'out').map((p) => ({ id: p.user_id, name: p.name })),
      courts: Array.from({ length: g.settings.courts }, (_, i) => i + 1).map((no) => {
        const x = live.find((y) => y.court === no);
        return { no, gameId: x ? x.id : null };
      }),
      live: live.map((x) => gameViewOf(g, x, m, actor, info)),
      suggestion: pick ? { a: pick.a.map(name), b: pick.b.map(name), more: free.length > (pick.a.length + pick.b.length) } : null,
      waiting: free.map((p) => ({ ...name(p.id), games: p.games })),
      results: games.filter((x) => x.status !== 'live').slice(0, 30).map((x) => gameViewOf(g, x, m, actor, info)),
    };
  }

  // The singles and doubles-pair leaderboards (group-logic formatTables), with names.
  function boardsOf(confirmed, info) {
    const t = L.formatTables(confirmed.map((x) => ({ ...x, margin: x.final ? Math.abs(x.final.a - x.final.b) : 0 })));
    const who = (id) => info.get(id);
    const row = (r) => ({ rating: r.rating, games: r.games, wins: r.wins, winPct: Math.round((r.wins / r.games) * 100), provisional: r.games < L.PROVISIONAL });
    return {
      singles: t.singles.filter((r) => who(r.id)).map((r) => ({ id: r.id, name: who(r.id).name, handle: who(r.id).handle, ...row(r) })),
      pairs: t.pairs.filter((r) => r.ids.every(who)).map((r) => ({ ids: r.ids, names: r.ids.map((id) => who(id).name), ...row(r) })),
    };
  }

  function leaderboardOf(members, week) {
    const w = new Map();
    for (const x of week) {
      for (const [side, ids] of [['a', [x.a1, x.a2]], ['b', [x.b1, x.b2]]]) {
        for (const id of ids.filter(Boolean)) {
          const r = w.get(id) || { games: 0, wins: 0 };
          r.games += 1;
          if (x.winner === side) r.wins += 1;
          w.set(id, r);
        }
      }
    }
    const rows = members.filter((r) => r.status === 'active')
      .sort((a, b) => Number(b.games > 0) - Number(a.games > 0) || b.rating - a.rating || a.name.localeCompare(b.name));
    let rank = 0;
    return rows.map((r) => ({
      id: r.id, name: r.name, handle: r.handle, rating: r.rating, games: r.games, wins: r.wins, role: r.role, guest: Boolean(r.guest),
      rank: r.games ? ++rank : null,
      provisional: r.games < L.PROVISIONAL,
      winPct: r.games ? Math.round((r.wins / r.games) * 100) : null,
      week: w.get(r.id) || { games: 0, wins: 0 },
    }));
  }

  // Admins: who came to the last few sessions (✓ checked in, 'in' said yes
  // but didn't check in). For academies it's the batch register.
  async function attendance(slug, actor, { sessions: count = 8 } = {}) {
    return db.tx(async (q) => {
      const g = await load(q, slug, { actor });
      await needAdmin(q, g, actor);
      const sessions = await q(
        `SELECT s.id, s.starts_at FROM group_sessions s WHERE s.group_id = $1 AND s.starts_at <= now()
           AND EXISTS (SELECT 1 FROM session_players p WHERE p.session_id = s.id AND p.status <> 'out')
         ORDER BY s.starts_at DESC LIMIT $2`,
        [g.id, Math.min(Math.max(Number(count) || 8, 1), 30)],
      );
      const ids = sessions.map((x) => x.id);
      const rows = ids.length ? await q(
        `SELECT p.session_id, p.user_id, p.status, p.checked_in_at, u.name FROM session_players p JOIN users u ON u.id = p.user_id
         WHERE p.session_id = ANY($1::int[]) AND p.status <> 'out'`, [ids]) : [];
      const people = new Map();
      for (const r of rows) {
        const p = people.get(r.user_id) || { id: r.user_id, name: r.name, marks: {}, came: 0 };
        p.marks[r.session_id] = r.checked_in_at ? 'here' : r.status === 'in' ? 'in' : 'waitlist';
        if (r.checked_in_at) p.came += 1;
        people.set(r.user_id, p);
      }
      return {
        settings: { ...g.settings, endTime: endTimeOf(g.settings) },
        sessions: sessions.map((x) => ({
          id: x.id, startsAt: x.starts_at,
          came: rows.filter((r) => r.session_id === x.id && r.checked_in_at).length,
          said: rows.filter((r) => r.session_id === x.id && r.status === 'in').length,
        })),
        players: [...people.values()].sort((a, b) => b.came - a.came || a.name.localeCompare(b.name)),
      };
    });
  }

  // For a venue / academy page: its groups, with the next session and how
  // many are going. Read-only (sessions not made yet just show the time).
  async function forOrgPage(orgSlug) {
    const gs = await db.query(
      `SELECT g.* FROM groups g JOIN orgs o ON o.id = g.org_id WHERE o.slug = $1 ORDER BY g.name`, [String(orgSlug || '').toLowerCase()]);
    if (!gs.length) return [];
    const nexts = gs.map((g) => L.upcomingStarts(g.settings, new Date(), { count: 1, hours: g.settings.hours || 3 })[0] || null);
    const counts = await db.query(
      `SELECT s.group_id, s.starts_at, COUNT(p.user_id) FILTER (WHERE p.status = 'in')::int AS going
       FROM group_sessions s LEFT JOIN session_players p ON p.session_id = s.id
       WHERE s.group_id = ANY($1::int[]) AND s.starts_at = ANY($2::timestamptz[]) GROUP BY s.group_id, s.starts_at`,
      [gs.map((g) => g.id), nexts.filter(Boolean).map((d) => d.toISOString())],
    );
    return gs.map((g, i) => {
      const next = nexts[i];
      const c = next && counts.find((x) => x.group_id === g.id && Date.parse(x.starts_at) === next.getTime());
      const going = c ? c.going : 0;
      return {
        slug: g.slug, name: g.name, sport: { id: g.sport, name: sportOf(g).name },
        settings: { ...g.settings, endTime: endTimeOf(g.settings) },
        next: next ? next.toISOString() : null,
        going,
        spots: g.settings.maxPlayers ? Math.max(0, g.settings.maxPlayers - going) : null,
      };
    }).sort((a, b) => a.settings.time.localeCompare(b.settings.time) || a.name.localeCompare(b.name));
  }

  // For link previews (WhatsApp): what anyone with the link can see, plus,
  // for a shared session, how many are going. Read-only; null if no group.
  // claim + join: a personal "claim your spot" link (the guest's name and
  // standing, only with the right invite token).
  async function shareInfo(slug, sessionId, { claim: guestId = null, join = null } = {}) {
    const g = await db.tx((q) => load(q, slug).catch(() => null));
    if (!g) return null;
    let guest = null;
    if (guestId && typeof join === 'string' && join === g.invite_token) {
      const rows = await db.query(`SELECT m.user_id AS id, m.role, m.status, m.rating, m.games, m.wins, u.name, u.guest
         FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = $1 AND m.status = 'active'`, [g.id]);
      const r = leaderboardOf(rows, []).find((x) => x.guest && x.id === Number(guestId));
      if (r) guest = { name: r.name, rank: r.rank, games: r.games, wins: r.wins };
    }
    let session = null;
    if (sessionId) {
      const [s] = await db.query(
        `SELECT s.starts_at, COUNT(p.user_id) FILTER (WHERE p.status = 'in')::int AS going
         FROM group_sessions s LEFT JOIN session_players p ON p.session_id = s.id
         WHERE s.id = $1 AND s.group_id = $2 GROUP BY s.id`, [Number(sessionId) || 0, g.id]);
      if (s) {
        const max = g.settings.maxPlayers;
        session = { startsAt: s.starts_at, going: s.going, spots: max ? Math.max(0, max - s.going) : null };
      }
    }
    return {
      slug: g.slug, name: g.name, sport: { id: g.sport, name: sportOf(g).name }, venue: g.venue, city: g.city,
      host: g.host ? { name: g.host.name } : null,
      settings: { ...g.settings, endTime: endTimeOf(g.settings) },
      session,
      guest,
    };
  }

  // The whole group page: details for anyone with the link; sessions, games,
  // members and the leaderboard for members. About 7 round trips.
  // join: the invite token from the link, which also shows the spots waiting
  // to be claimed to someone who isn't in yet.
  async function view(slug, actor, { skip = 0, join = null } = {}) {
    return db.tx(async (q) => {
      const g = await load(q, slug, { actor });
      const m = g.member;
      const member = Boolean(actor?.user?.isAdmin || (m && m.status === 'active'));
      const base = {
        slug: g.slug,
        name: g.name,
        sport: { id: g.sport, name: sportOf(g).name },
        city: g.city,
        venue: g.venue,
        about: g.about,
        host: g.host,
        settings: { ...g.settings, endTime: endTimeOf(g.settings) },
        role: m ? (m.status === 'requested' ? 'requested' : m.role) : actor?.user?.isAdmin ? 'admin' : null,
        member,
      };
      if (!member) {
        const rows = await q(`SELECT m.user_id AS id, m.role, m.status, m.rating, m.games, m.wins, u.name, u.guest
           FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = $1 AND m.status = 'active'`, [g.id]);
        const invited = Boolean(g.settings.open) || (typeof join === 'string' && join.length > 0 && join === g.invite_token);
        return {
          ...base,
          members: rows.length,
          // Unclaimed spots, with how they're doing ("#4 · 6 wins") — only with the invite.
          guests: invited ? leaderboardOf(rows, []).filter((r) => r.guest).map((r) => ({ id: r.id, name: r.name, rank: r.rank, games: r.games, wins: r.wins })) : [],
        };
      }
      await autoConfirm(q, g);
      const sessions = await sessionsOf(q, g);
      const ids = sessions.map((x) => x.id);
      const [players, games, members, confirmed] = await Promise.all([
        q('SELECT sp.*, u.name, u.handle FROM session_players sp JOIN users u ON u.id = sp.user_id WHERE sp.session_id = ANY($1::int[])', [ids]),
        q(`SELECT * FROM group_games WHERE session_id = ANY($1::int[]) AND status <> 'void' ORDER BY started_at DESC`, [ids]),
        q(`SELECT m.user_id AS id, m.role, m.status, m.rating, m.games, m.wins, m.joined_at, u.name, u.handle, u.email, u.guest
           FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = $1`, [g.id]),
        q(`SELECT a1, a2, b1, b2, winner, final, ended_at FROM group_games WHERE group_id = $1 AND status = 'confirmed' ORDER BY ended_at, id`, [g.id]),
      ]);
      const info = new Map(members.map((r) => [r.id, r]));
      const week = confirmed.filter((x) => Date.parse(x.ended_at) > Date.now() - 7 * 86400000);
      const boards = boardsOf(confirmed, info);
      const one = (s, opts) => sessionViewOf(g, s, players.filter((p) => p.session_id === s.id), games.filter((x) => x.session_id === s.id), info, m, actor, opts);
      const admin = isAdmin(m, actor);
      return {
        ...base,
        members: members.filter((r) => r.status === 'active').length,
        admin,
        invite: g.invite_token,
        session: sessions[0] ? one(sessions[0], { skip }) : null,
        nextSession: sessions[1] ? one(sessions[1]) : null,
        leaderboard: leaderboardOf(members, week),
        singlesBoard: boards.singles,
        pairsBoard: boards.pairs,
        requests: admin ? members.filter((r) => r.status === 'requested').sort((a, b) => Date.parse(a.joined_at) - Date.parse(b.joined_at))
          .map((r) => ({ id: r.id, name: r.name, email: r.email, requestedAt: r.joined_at })) : [],
      };
    });
  }

  async function getGame(slug, actor, gameId) {
    return db.tx(async (q) => {
      const g = await load(q, slug, { actor });
      const m = await needMember(q, g, actor);
      let x = await gameOf(q, g, gameId);
      if (x.status === 'done' && Date.parse(x.ended_at) < Date.now() - AUTO_CONFIRM_MINUTES * 60000) {
        await autoConfirm(q, g);
        x = await gameOf(q, g, gameId);
      }
      return gameView(q, g, x, m, actor);
    });
  }

  return {
    slugOf, createGroup, updateGroup, myGroups, join, setMember, leave, addGuests, claim, namesFrom, view, rsvp, checkIn, hostOptions, attendance, forOrgPage, shareInfo,
    startGame, getGame, rally, undo, setResult, addResult, confirm, dispute, voidGame,
  };
}

module.exports = { createGroups };
