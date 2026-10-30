'use strict';

// Player profiles (tonament.com/p/<handle>), the people behind entries and
// ranking results. People are matched to accounts by email, like team
// members, so a partner entered by email collects their results as soon as
// they sign up with it.

const crypto = require('node:crypto');
const sports = require('./sports');
const catalog = require('../public/sports/events');
const R = require('./rankings');
const dupr = require('./dupr');
const { normalizeEmail, validEmail } = require('./auth');

const RESERVED = new Set(['me', 'new', 'edit', 'admin', 'api', 'rankings', 'tonament', 'support', 'help', 'official']);
const PAGE_SIZE = 50;

function createPlayers({ db, fail, text, imageType, maxImageBytes, mediaUrl, mailer, baseUrl = '' }) {
  // ---------- handles

  const slugOf = (value) => String(value || '').trim().toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
  function checkHandle(h) {
    if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(h)) return 'Use 3–30 letters, numbers or dashes';
    if (RESERVED.has(h)) return 'That name is reserved — try another';
    return null;
  }
  // Every account gets a handle the first time it's needed: "asha-rao", "asha-rao-2", …
  async function ensureHandle(q, user) {
    if (user.handle) return user.handle;
    let base = slugOf(user.name);
    if (base.length < 3 || checkHandle(base)) base = `player-${user.id}`;
    for (let i = 1; i < 50; i++) {
      const handle = i === 1 ? base : `${base.slice(0, 27)}-${i}`;
      const [row] = await q('UPDATE users SET handle = $1 WHERE id = $2 AND handle IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE handle = $1) RETURNING handle', [handle, user.id]);
      if (row) return row.handle;
      const [again] = await q('SELECT handle FROM users WHERE id = $1', [user.id]);
      if (again?.handle) return again.handle;
    }
    const fallback = `player-${user.id}-${crypto.randomBytes(2).toString('hex')}`;
    await q('UPDATE users SET handle = $1 WHERE id = $2', [fallback, user.id]);
    return fallback;
  }

  // ---------- the people behind entries

  // [{ name, email }] for an entry's slots; empty emails clear the link.
  // A player's payment mark (and captaincy) stays with them when the list is
  // edited, matched by email or name.
  async function setPeople(q, entryId, people) {
    const before = await q('SELECT name, email, fee_status FROM entry_players WHERE entry_id = $1', [entryId]);
    const kept = (p) => before.find((b) => (p.email && b.email === p.email) || b.name.toLowerCase() === String(p.name).toLowerCase());
    await q('DELETE FROM entry_players WHERE entry_id = $1', [entryId]);
    for (const [slot, p] of people.entries()) {
      if (!p || !p.name) continue;
      await q('INSERT INTO entry_players (entry_id, slot, name, email, dupr_id, captain, fee_status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [entryId, slot, p.name, p.email || null, p.duprId || null, Boolean(p.captain), p.feeStatus !== undefined ? p.feeStatus : kept(p)?.fee_status || null]);
    }
  }
  // A drawn pair is made of its two solo players.
  async function copyToPair(q, pairId, soloIds) {
    const rows = await q('SELECT entry_id, name, email, dupr_id FROM entry_players WHERE entry_id = ANY($1::int[]) AND slot = 0', [soloIds]);
    const order = new Map(soloIds.map((id, i) => [id, i]));
    rows.sort((a, b) => order.get(a.entry_id) - order.get(b.entry_id));
    await setPeople(q, pairId, rows.map((r) => ({ name: r.name, email: r.email, duprId: r.dupr_id })));
  }
  // Everyone behind a tournament's entries, with their public profile (if any).
  async function peopleOf(q, tournamentId) {
    const rows = await q(
      `SELECT ep.entry_id, ep.slot, ep.name, ep.email, ep.dupr_id AS "entryDupr", ep.captain, ep.fee_status AS "feeStatus", u.id AS "userId", u.handle, u.profile_public AS "public",
              u.dupr_id AS "duprId", u.dupr_singles AS "duprSingles", u.dupr_doubles AS "duprDoubles", u.dupr_verified AS "duprVerified"
       FROM entry_players ep JOIN entries e ON e.id = ep.entry_id LEFT JOIN users u ON u.email = ep.email AND u.disabled_at IS NULL
       WHERE e.tournament_id = $1 ORDER BY ep.entry_id, ep.slot`,
      [tournamentId],
    );
    const out = new Map();
    for (const r of rows) {
      if (!out.has(r.entry_id)) out.set(r.entry_id, []);
      out.get(r.entry_id).push(r);
    }
    return out;
  }
  // Organisers link an entry's players to accounts (by email).
  // team: a roster (names required, one captain, no repeats).
  function readPeople(input, { names, max, team = false }) {
    if (!Array.isArray(input)) fail(400, 'players must be a list');
    if (input.length > max) fail(400, `Up to ${max} players`);
    const people = input.map((p = {}, i) => {
      const email = p.email ? normalizeEmail(p.email) : null;
      if (email && !validEmail(email)) fail(400, `Player ${i + 1}: enter a valid email address`);
      const name = text(p.name || names[i], 'Player name', { max: 40 });
      return { name, email, duprId: p.duprId ? dupr.checkId(p.duprId, fail) : null, ...(team && { captain: Boolean(p.captain) }) };
    });
    if (team) {
      if (!people.length) fail(400, 'Add at least one player');
      if (people.filter((p) => p.captain).length > 1) fail(400, 'Pick one captain');
      const seen = new Set();
      for (const p of people) {
        for (const k of [p.name.toLowerCase(), p.email].filter(Boolean)) {
          if (seen.has(k)) fail(400, `${p.name} is on the list twice`);
          seen.add(k);
        }
      }
    }
    return people;
  }

  // Tells a partner they were entered (best effort).
  async function notifyPartner({ email, player, tournament, event, tournamentId }) {
    if (!mailer || !email) return;
    const [user] = await db.query('SELECT 1 FROM users WHERE email = $1', [email]);
    const url = user ? `${baseUrl}/t/${tournamentId}` : `${baseUrl}/signup?email=${encodeURIComponent(email)}&next=${encodeURIComponent('/me/profile')}`;
    const { partnerEmail } = require('./email');
    try {
      await mailer.send({ to: email, ...partnerEmail({ player, tournament, event, url, hasAccount: Boolean(user) }) });
    } catch (err) {
      console.error('Partner email failed:', err.message);
    }
  }

  // ---------- results (written when an event finishes)

  // entries: the event's entries (not paired solos); standings: entry ids per
  // group, best first; summaries: match id -> score text.
  async function recordEvent(q, { t, entries, matches, standings, summaries, names }) {
    await clearEvent(q, t.eventId);
    const people = await q('SELECT entry_id, email FROM entry_players WHERE entry_id = ANY($1::int[]) AND email IS NOT NULL', [entries.map((e) => e.id)]);
    if (!people.length) return;
    const counted = entries.filter((e) => !e.withdrawn && e.confirmed !== false);
    const n = counted.length;
    const finish = R.finishes({ format: t.format, entries: counted, matches, standings, knockoutRounds: t.config.knockoutRounds });
    const rec = R.records(matches);
    const category = R.categoryOf(t.event);
    const ranked = Boolean(category) && t.config.ranked !== false && n >= R.MIN_ENTRIES;
    const played = (id) => matches
      .filter((m) => (m.a_id === id || m.b_id === id) && m.status === 'done' && m.a_id != null && m.b_id != null)
      .map((m) => ({
        round: m.stage === 'knockout' ? (m.round === t.config.knockoutRounds ? 'Final' : m.round === t.config.knockoutRounds - 1 ? 'Semi-final' : `Round ${m.round}`) : 'Group',
        opponent: names.get(m.a_id === id ? m.b_id : m.a_id) || 'Unknown',
        won: m.winner_id === id,
        draw: m.winner_id == null,
        score: summaries.get(m.id) || '',
      }));
    for (const p of people) {
      const f = finish.get(p.entry_id);
      if (!f) continue;
      const r = rec.get(p.entry_id) || { won: 0, lost: 0 };
      await q(
        `INSERT INTO event_results (event_id, email, tournament_id, entry_id, sport, category, finish, points, entries, won, lost, matches)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) ON CONFLICT (event_id, email) DO NOTHING`,
        [t.eventId, p.email, t.id, p.entry_id, t.sportDef.id, category, f, ranked ? R.pointsFor(f, n) : 0, n, r.won, r.lost, JSON.stringify(played(p.entry_id))],
      );
    }
    // Everyone with a result gets a profile address.
    const users = await q('SELECT id, name, handle FROM users WHERE email = ANY($1::text[]) AND handle IS NULL', [people.map((p) => p.email)]);
    for (const u of users) await ensureHandle(q, u);
  }
  const clearEvent = (q, eventId) => q('DELETE FROM event_results WHERE event_id = $1', [eventId]);

  // ---------- rankings

  const SCOPE_SQL = (params, { region, city }) => {
    const where = [];
    if (region) { params.push(region); where.push(`lower(p.region) = lower($${params.length})`); }
    if (city) { params.push(city); where.push(`lower(p.city) = lower($${params.length})`); }
    return where.length ? `WHERE ${where.join(' AND ')}` : '';
  };
  // A category's table: everyone's best results in the last 52 weeks.
  async function table(sport, category, { region = '', city = '', offset = 0, limit = PAGE_SIZE, email = null } = {}, q = db.query) {
    const params = [sport, category, R.BEST_OF];
    const scope = SCOPE_SQL(params, { region, city });
    params.push(Math.min(limit, 200), Math.max(0, Number(offset) || 0));
    const rows = await q(
      `WITH r AS (
         SELECT er.email, er.points, COUNT(*) OVER (PARTITION BY er.email) AS results,
                ROW_NUMBER() OVER (PARTITION BY er.email ORDER BY er.points DESC, er.finished_at DESC) AS n
         FROM event_results er JOIN tournaments t ON t.id = er.tournament_id
         WHERE er.sport = $1 AND er.category = $2 AND er.points > 0 AND t.visibility = 'public'
           AND er.finished_at > now() - interval '${R.WINDOW_DAYS} days'
       ), p AS (
         SELECT u.id, u.handle, u.name, u.photo_id, u.email,
                COALESCE(u.city, (SELECT t.city FROM event_results x JOIN tournaments t ON t.id = x.tournament_id WHERE x.email = u.email ORDER BY x.finished_at DESC LIMIT 1)) AS city,
                COALESCE(u.region, (SELECT t.region FROM event_results x JOIN tournaments t ON t.id = x.tournament_id WHERE x.email = u.email ORDER BY x.finished_at DESC LIMIT 1)) AS region,
                SUM(r.points)::int AS points, MAX(r.results)::int AS results
         FROM r JOIN users u ON u.email = r.email AND u.profile_public AND u.disabled_at IS NULL
         WHERE r.n <= $3 GROUP BY u.id
       ), ranked AS (
         SELECT p.*, RANK() OVER (ORDER BY p.points DESC)::int AS rank, COUNT(*) OVER ()::int AS total FROM p ${scope}
       )
       SELECT * FROM ranked ${email ? `WHERE email = $${params.length + 1}` : ''} ORDER BY rank, name LIMIT $${params.length - 1} OFFSET $${params.length}`,
      email ? [...params, email] : params,
    );
    return {
      total: rows[0] ? rows[0].total : 0,
      players: rows.map((r) => ({ rank: r.rank, handle: r.handle, name: r.name, city: r.city, region: r.region, points: r.points, results: r.results, photo: r.photo_id ? mediaUrl(r.photo_id) : null })),
    };
  }
  // The categories a sport has rankings in, with their top players.
  async function overview(sport, top = 5) {
    const cats = await db.query(
      `SELECT er.category, COUNT(DISTINCT er.email)::int AS n FROM event_results er JOIN tournaments t ON t.id = er.tournament_id
       JOIN users u ON u.email = er.email AND u.profile_public AND u.disabled_at IS NULL
       WHERE er.sport = $1 AND er.points > 0 AND t.visibility = 'public' AND er.finished_at > now() - interval '${R.WINDOW_DAYS} days'
       GROUP BY er.category ORDER BY n DESC`,
      [sport],
    );
    const ages = catalog.agesFor(sport);
    const out = [];
    for (const c of cats) {
      const name = R.categoryName(c.category, ages);
      if (!name) continue;
      out.push({ slug: c.category, name, players: c.n, top: (await table(sport, c.category, { limit: top })).players });
    }
    return out;
  }
  // Sports with rankings and how many players are ranked in each.
  async function sportCounts() {
    const rows = await db.query(
      `SELECT er.sport, COUNT(DISTINCT er.email)::int AS n FROM event_results er JOIN tournaments t ON t.id = er.tournament_id
       JOIN users u ON u.email = er.email AND u.profile_public AND u.disabled_at IS NULL
       WHERE er.points > 0 AND t.visibility = 'public' AND er.finished_at > now() - interval '${R.WINDOW_DAYS} days' GROUP BY er.sport`,
    );
    return rows.filter((r) => sports.get(r.sport)).map((r) => ({ id: r.sport, name: sports.get(r.sport).name, players: r.n })).sort((a, b) => b.players - a.players);
  }

  // States and cities with ranked players (for the filters).
  async function places(sport, category) {
    const all = await table(sport, category, { limit: 200 });
    const regions = [...new Set(all.players.map((p) => p.region).filter(Boolean))].sort();
    const cities = [...new Set(all.players.map((p) => p.city).filter(Boolean))].sort();
    return { regions, cities };
  }
  // Where a player stands in each category they've played (India and their city).
  async function positions(user) {
    const cats = await db.query(
      `SELECT DISTINCT er.sport, er.category FROM event_results er JOIN tournaments t ON t.id = er.tournament_id
       WHERE er.email = $1 AND er.points > 0 AND t.visibility = 'public' AND er.finished_at > now() - interval '${R.WINDOW_DAYS} days'`,
      [user.email],
    );
    const out = [];
    for (const c of cats) {
      const name = R.categoryName(c.category, catalog.agesFor(c.sport));
      if (!name) continue;
      const india = (await table(c.sport, c.category, { email: user.email, limit: 1 })).players[0];
      if (!india) continue;
      const local = india.city ? (await table(c.sport, c.category, { city: india.city, email: user.email, limit: 1 })).players[0] : null;
      out.push({ sport: c.sport, sportName: sports.get(c.sport)?.name || c.sport, category: c.category, name, rank: india.rank, points: india.points, results: india.results, city: india.city, cityRank: local ? local.rank : null });
    }
    return out.sort((a, b) => a.rank - b.rank);
  }

  // ---------- profiles

  async function resultsOf(email, { all = false, userId = null } = {}) {
    const rows = await db.query(
      `SELECT er.*, en.user_id AS "entrant", t.name AS "tournamentName", t.city, t.starts_on AS "startsOn", t.visibility, ev.discipline, ev.gender, ev.age, ev.level, ev.name AS "eventName", t.sport AS "sportId"
       FROM event_results er JOIN tournaments t ON t.id = er.tournament_id JOIN events ev ON ev.id = er.event_id
       LEFT JOIN entries en ON en.id = er.entry_id
       WHERE er.email = $1 ${all ? `AND t.visibility <> 'private'` : `AND t.visibility = 'public'`}
       ORDER BY er.finished_at DESC LIMIT 100`,
      [email],
    );
    return rows.map((r) => ({
      eventId: r.event_id,
      ...(userId && { entryId: r.entry_id, mine: r.entrant === userId }),
      tournamentId: r.tournament_id,
      tournament: r.tournamentName,
      city: r.city,
      date: r.startsOn || r.finished_at,
      sport: r.sport,
      event: catalog.eventName({ discipline: r.discipline, gender: r.gender, age: r.age, level: r.level, name: r.eventName }),
      finish: r.finish,
      finishName: R.FINISH_NAMES[r.finish],
      points: r.points,
      entries: r.entries,
      won: r.won,
      lost: r.lost,
      matches: r.matches || [],
    }));
  }
  function profileFields(u) {
    return {
      handle: u.handle,
      name: u.name,
      city: u.city,
      region: u.region,
      bio: u.bio,
      sports: (u.sports || []).filter((id) => sports.get(id)).map((id) => ({ id, name: sports.get(id).name })),
      photo: u.photo_id ? mediaUrl(u.photo_id) : null,
      dupr: u.dupr_id || u.dupr_doubles || u.dupr_singles
        ? { id: u.dupr_id, singles: u.dupr_singles == null ? null : Number(u.dupr_singles), doubles: u.dupr_doubles == null ? null : Number(u.dupr_doubles), verified: u.dupr_verified }
        : null,
    };
  }
  // A player's group play: rating, record and place in each group they're in.
  async function groupPlayOf(userId) {
    const rows = await db.query(
      `SELECT g.slug, g.name, g.sport, m.rating, m.games, m.wins,
              (SELECT COUNT(*)::int + 1 FROM group_members x WHERE x.group_id = g.id AND x.status = 'active' AND x.games > 0 AND x.rating > m.rating) AS rank,
              (SELECT COUNT(*)::int FROM group_members x WHERE x.group_id = g.id AND x.status = 'active' AND x.games > 0) AS ranked
       FROM group_members m JOIN groups g ON g.id = m.group_id
       WHERE m.user_id = $1 AND m.status = 'active' ORDER BY m.games DESC, g.name`,
      [userId],
    );
    return rows.map((r) => ({ ...r, sportName: sports.get(r.sport)?.name || r.sport, rank: r.games ? r.rank : null }));
  }
  // For other people: totals per sport, without naming the (private) groups.
  function groupPlayPublic(groups) {
    const bySport = new Map();
    for (const g of groups.filter((x) => x.games)) {
      const s = bySport.get(g.sport) || { sport: g.sport, sportName: g.sportName, games: 0, wins: 0, rating: 0, top: false };
      s.games += g.games;
      s.wins += g.wins;
      s.rating = Math.max(s.rating, g.rating);
      s.top = s.top || (g.rank === 1 && g.ranked > 1);
      bySport.set(g.sport, s);
    }
    return [...bySport.values()];
  }

  function summarise(results, groups = []) {
    const bySport = new Map();
    for (const r of results) {
      const s = bySport.get(r.sport) || { sport: r.sport, sportName: sports.get(r.sport)?.name || r.sport, won: 0, lost: 0, titles: 0, finals: 0, events: 0 };
      s.won += r.won; s.lost += r.lost; s.events += 1;
      if (r.finish === 'W') s.titles += 1;
      if (r.finish === 'F') s.finals += 1;
      bySport.set(r.sport, s);
    }
    // Confirmed group games count in the win–loss record too.
    for (const g of groups.filter((x) => x.games)) {
      const s = bySport.get(g.sport) || { sport: g.sport, sportName: g.sportName, won: 0, lost: 0, titles: 0, finals: 0, events: 0 };
      s.won += g.wins;
      s.lost += g.games - g.wins;
      s.groupGames = (s.groupGames || 0) + g.games;
      bySport.set(g.sport, s);
    }
    return [...bySport.values()];
  }

  // The public profile (null if there isn't one, or it's private and not yours).
  async function profile(handle, viewer = null) {
    const [u] = await db.query('SELECT * FROM users WHERE handle = $1 AND disabled_at IS NULL', [String(handle || '').toLowerCase()]);
    if (!u) return null;
    const own = viewer?.user?.id === u.id;
    if (!u.profile_public && !own) return null;
    const results = await resultsOf(u.email);
    const groups = await groupPlayOf(u.id);
    return {
      ...profileFields(u), id: u.id, public: u.profile_public, own, results, records: summarise(results, groups), rankings: await positions(u),
      groupPlay: own ? groups : groupPlayPublic(groups),
      clubs: await clubsOf(u.id),
      ratings: (await db.query('SELECT sport, rating, games FROM ratings WHERE user_id = $1 AND games > 0 ORDER BY games DESC', [u.id]))
        .map((r) => ({ ...r, name: (require('./sports').get(r.sport) || {}).name || r.sport })),
    };
  }

  // "Plays for": the clubs a player belongs to.
  async function clubsOf(userId) {
    const { KIND_NAMES } = require('./orgs');
    const rows = await db.query(
      `SELECT o.slug, o.name, o.kind, m.role FROM club_members m JOIN orgs o ON o.id = m.org_id
       WHERE m.user_id = $1 AND m.status = 'active' ORDER BY m.joined_at`,
      [userId],
    );
    return rows.map((r) => ({ slug: r.slug, name: r.name, kindName: KIND_NAMES[r.kind] || 'Club', role: r.role }));
  }

  // The signed-in player's own profile, for the editor.
  async function myProfile(actor) {
    if (!actor?.user) fail(401, 'Sign in to see your profile');
    const [u] = await db.query('SELECT * FROM users WHERE id = $1', [actor.user.id]);
    u.handle = await ensureHandle(db.query, u);
    const results = await resultsOf(u.email, { all: true, userId: u.id });
    const groups = await groupPlayOf(u.id);
    const upcoming = await db.query(
      `SELECT DISTINCT ON (e.id) e.id AS "entryId", t.id, t.name, t.starts_on AS "startsOn", ev.discipline, ev.gender, ev.age, ev.level, ev.name AS "eventName", e.user_id = $2 AS mine
       FROM entry_players ep JOIN entries e ON e.id = ep.entry_id JOIN tournaments t ON t.id = e.tournament_id JOIN events ev ON ev.id = e.event_id
       WHERE ep.email = $1 AND ev.status <> 'completed' AND NOT e.withdrawn ORDER BY e.id DESC LIMIT 20`,
      [u.email, u.id],
    );
    const [rep] = u.rep_org_id ? await db.query('SELECT slug, name FROM orgs WHERE id = $1', [u.rep_org_id]) : [];
    return {
      ...profileFields(u),
      public: u.profile_public,
      represents: rep || null,
      clubs: await clubsOf(u.id),
      sportIds: u.sports || [],
      duprConnect: dupr.enabled(),
      results,
      records: summarise(results, groups),
      rankings: await positions(u),
      groups,
      entries: upcoming.map((x) => ({ entryId: x.entryId, tournamentId: x.id, tournament: x.name, startsOn: x.startsOn, mine: x.mine, event: catalog.eventName({ discipline: x.discipline, gender: x.gender, age: x.age, level: x.level, name: x.eventName }) })),
    };
  }

  async function updateProfile(actor, input = {}) {
    if (!actor?.user) fail(401, 'Sign in to edit your profile');
    const [u] = await db.query('SELECT * FROM users WHERE id = $1', [actor.user.id]);
    const set = {};
    const has = (k) => input[k] !== undefined;
    if (has('name')) set.name = text(input.name, 'Name', { max: 60 });
    if (has('handle')) {
      const h = slugOf(input.handle);
      const bad = checkHandle(h);
      if (bad) fail(400, `Profile address: ${bad}`);
      const [taken] = await db.query('SELECT 1 FROM users WHERE handle = $1 AND id <> $2', [h, u.id]);
      if (taken) fail(409, `tonament.com/p/${h} is taken — try another`);
      set.handle = h;
    }
    if (has('city')) set.city = text(input.city, 'City', { max: 60, optional: true });
    if (has('region')) set.region = text(input.region, 'State', { max: 60, optional: true });
    if (has('bio')) {
      const bio = typeof input.bio === 'string' ? input.bio.trim().replace(/\r\n/g, '\n') : '';
      if (bio.length > 600) fail(400, 'About you must be at most 600 characters');
      set.bio = bio || null;
    }
    if (has('sports')) {
      if (!Array.isArray(input.sports)) fail(400, 'sports must be a list');
      set.sports = [...new Set(input.sports.filter((id) => sports.get(id)))];
    }
    if (has('public')) set.profile_public = Boolean(input.public);
    // The club I represent: one I'm an active member of (or none).
    if (has('represents')) {
      if (!input.represents) set.rep_org_id = null;
      else {
        const [o] = await db.query(`SELECT o.id FROM orgs o JOIN club_members m ON m.org_id = o.id WHERE o.slug = $1 AND m.user_id = $2 AND m.status = 'active'`, [String(input.represents), u.id]);
        if (!o) fail(400, 'Represent a club you\'re a member of');
        set.rep_org_id = o.id;
      }
    }
    if (has('duprId')) {
      set.dupr_id = input.duprId ? dupr.checkId(input.duprId, fail) : null;
      if (set.dupr_id !== u.dupr_id) set.dupr_verified = false;
    }
    for (const [k, col] of [['duprSingles', 'dupr_singles'], ['duprDoubles', 'dupr_doubles']]) {
      if (!has(k)) continue;
      if (u.dupr_verified && set.dupr_verified !== false) fail(409, 'Your DUPR ratings come from DUPR — disconnect to type them yourself');
      set[col] = dupr.checkRating(input[k], fail);
    }
    const keys = Object.keys(set);
    if (keys.length) {
      await db.query(`UPDATE users SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`, [...keys.map((k) => set[k]), u.id]);
    }
    return myProfile(actor);
  }

  async function uploadPhoto(actor, input = {}) {
    if (!actor?.user) fail(401, 'Sign in to edit your profile');
    const raw = typeof input.data === 'string' ? input.data.replace(/^data:[^,]*,/, '') : '';
    const bytes = Buffer.from(raw, 'base64');
    if (!bytes.length) fail(400, 'Choose an image to upload');
    if (bytes.length > maxImageBytes) fail(413, 'That image is too large — try a smaller one');
    const mime = imageType(bytes);
    if (!mime) fail(400, 'Upload a JPEG, PNG or WebP image');
    const id = crypto.createHash('sha256').update(`user:${actor.user.id}:`).update(bytes).digest('hex').slice(0, 32);
    await db.tx(async (q) => {
      await q('DELETE FROM user_media WHERE user_id = $1', [actor.user.id]);
      await q('INSERT INTO user_media (id, user_id, mime, bytes) VALUES ($1, $2, $3, $4)', [id, actor.user.id, mime, bytes]);
      await q('UPDATE users SET photo_id = $1 WHERE id = $2', [id, actor.user.id]);
    });
    return myProfile(actor);
  }
  async function deletePhoto(actor) {
    if (!actor?.user) fail(401, 'Sign in to edit your profile');
    await db.tx(async (q) => {
      await q('DELETE FROM user_media WHERE user_id = $1', [actor.user.id]);
      await q('UPDATE users SET photo_id = NULL WHERE id = $1', [actor.user.id]);
    });
    return myProfile(actor);
  }
  async function getMedia(mediaId) {
    const [m] = await db.query('SELECT m.mime, m.bytes FROM user_media m JOIN users u ON u.id = m.user_id WHERE m.id = $1 AND u.profile_public', [String(mediaId)]);
    return m ? { mime: m.mime, bytes: Buffer.from(m.bytes), public: true } : null;
  }

  // "That's not me": a player takes their email off an entry.
  async function notMe(actor, entryId) {
    if (!actor?.user) fail(401, 'Sign in first');
    await db.tx(async (q) => {
      const [e] = await q('SELECT user_id FROM entries WHERE id = $1', [Number(entryId) || 0]);
      if (e && e.user_id === actor.user.id) fail(409, 'You entered this yourself — withdraw from the tournament page instead');
      await q('UPDATE entry_players SET email = NULL WHERE entry_id = $1 AND email = $2', [Number(entryId) || 0, actor.user.email]);
      await q('DELETE FROM event_results WHERE entry_id = $1 AND email = $2', [Number(entryId) || 0, actor.user.email]);
    });
    return myProfile(actor);
  }

  async function sitemapPlayers() {
    const rows = await db.query(
      `SELECT DISTINCT u.handle FROM users u JOIN event_results er ON er.email = u.email JOIN tournaments t ON t.id = er.tournament_id
       WHERE u.profile_public AND u.handle IS NOT NULL AND u.disabled_at IS NULL AND t.visibility = 'public' ORDER BY u.handle LIMIT 5000`,
    );
    const cats = await db.query(
      `SELECT DISTINCT er.sport, er.category FROM event_results er JOIN tournaments t ON t.id = er.tournament_id
       WHERE er.points > 0 AND t.visibility = 'public' AND er.finished_at > now() - interval '${R.WINDOW_DAYS} days'`,
    );
    const today = new Date().toISOString().slice(0, 10);
    const sportIds = [...new Set(cats.map((c) => c.sport))];
    return [
      ...(sportIds.length ? [{ path: '/rankings', lastmod: today }] : []),
      ...sportIds.map((s) => ({ path: `/rankings/${s}`, lastmod: today })),
      ...cats.filter((c) => c.category).map((c) => ({ path: `/rankings/${c.sport}/${c.category}`, lastmod: today })),
      ...rows.map((r) => ({ path: `/p/${r.handle}`, lastmod: today })),
    ];
  }

  return {
    slugOf, checkHandle, ensureHandle, setPeople, copyToPair, peopleOf, readPeople, notifyPartner, recordEvent, clearEvent,
    table, overview, places, sportCounts, positions, profile, myProfile, updateProfile, uploadPhoto, deletePhoto, getMedia, notMe, sitemapPlayers,
  };
}

module.exports = { createPlayers };
