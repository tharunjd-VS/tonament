'use strict';

// Track meets: athletics, swimming and track cycling. An organiser (or a
// club's admins) sets up a meet with events — each measured by a time (lower
// wins), a distance or a height (higher wins). Athletes are entered with
// their team (or enter themselves). A timed event with more entries than
// lanes runs heats first: the best heat marks make the final, seeded into the
// middle lanes. Finishing an event places everyone, scores team points
// (8-6-5-4-3-2-1 by default), marks personal bests, and posts each linked
// athlete's result to the feed.

const SPORTS = {
  athletics: {
    name: 'Athletics',
    events: [['100m', 'time'], ['200m', 'time'], ['400m', 'time'], ['800m', 'time'], ['1500m', 'time'], ['5000m', 'time'], ['4x100m relay', 'time'],
      ['Long jump', 'distance'], ['Triple jump', 'distance'], ['High jump', 'height'], ['Shot put', 'distance'], ['Discus', 'distance'], ['Javelin', 'distance']],
  },
  swimming: {
    name: 'Swimming',
    events: [['50m freestyle', 'time'], ['100m freestyle', 'time'], ['200m freestyle', 'time'], ['50m backstroke', 'time'], ['50m breaststroke', 'time'], ['50m butterfly', 'time'], ['200m IM', 'time'], ['4x50m freestyle relay', 'time']],
  },
  cycling: {
    name: 'Track cycling',
    events: [['Flying 200m', 'time'], ['1km time trial', 'time'], ['500m time trial', 'time'], ['Individual pursuit', 'time'], ['Scratch race', 'time']],
  },
};
const KINDS = ['time', 'distance', 'height'];
const GENDERS = { m: 'Men', f: 'Women', x: 'Open' };
// Final lanes, best seed first: the middle of the track (8 lanes: 4 5 3 6 2 7 1 8).
const LANE_ORDER = (lanes) => {
  const mid = Math.max(1, Math.floor(lanes / 2));
  const out = [mid];
  for (let k = 1; out.length < lanes; k++) {
    if (mid + k <= lanes) out.push(mid + k);
    if (mid - k >= 1 && out.length < lanes) out.push(mid - k);
  }
  return out;
};

// "10.85", "1:52.30", "1:02:03.5" -> seconds; "6.45" (metres) as it is.
function readMark(kind, value) {
  const v = String(value ?? '').trim();
  if (kind === 'time') {
    const parts = v.split(':');
    if (!parts.length || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
    const n = parts.map(Number);
    if (n.slice(1).some((x) => x >= 60)) return null;
    const s = n.reduce((sum, x) => sum * 60 + x, 0);
    return s > 0 && s < 86400 ? Math.round(s * 100) / 100 : null;
  }
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const m = Number(v);
  return m > 0 && m < 200 ? Math.round(m * 100) / 100 : null;
}
function showMark(kind, value) {
  if (value == null) return null;
  const x = Number(value);
  if (kind !== 'time') return `${x.toFixed(2)} m`;
  const m = Math.floor(x / 60);
  const s = (x - m * 60).toFixed(2).padStart(5, '0');
  return m ? `${m}:${s}` : (x).toFixed(2);
}
const better = (kind) => (a, b) => (kind === 'time' ? a - b : b - a);
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

function createMeets({ db, fail, text, social, notify }) {
  const needUser = (actor) => { if (!actor?.user) fail(401, 'Sign in first'); return actor.user; };

  async function load(q, id, { lock = false } = {}) {
    const [m] = await q(`SELECT * FROM meets WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [Number(id) || 0]);
    if (!m) fail(404, 'Meet not found');
    return m;
  }
  async function canManage(q, m, actor) {
    if (!actor?.user) return false;
    if (actor.user.isAdmin || m.created_by === actor.user.id) return true;
    if (!m.org_id) return false;
    const [x] = await q(`SELECT 1 FROM club_members WHERE org_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'`, [m.org_id, actor.user.id]);
    return Boolean(x);
  }
  async function manage(q, id, actor) {
    const m = await load(q, id, { lock: true });
    if (!(await canManage(q, m, actor))) fail(actor?.user ? 403 : 401, 'Only the meet\'s organisers can do that');
    return m;
  }
  async function eventOf(q, m, eventId) {
    const [e] = await q('SELECT * FROM meet_events WHERE id = $1 AND meet_id = $2', [Number(eventId) || 0, m.id]);
    if (!e) fail(404, 'Event not found');
    return e;
  }

  // ---------- setting one up

  // events: [{ name, kind, gender }] (names from the sport's list, or your own).
  async function create(actor, input = {}) {
    const me = needUser(actor);
    const sport = SPORTS[input.sport] ? input.sport : null;
    if (!sport) fail(400, 'Pick athletics, swimming or track cycling');
    const name = text(input.name, 'Meet name', { max: 80 });
    const place = text(input.place, 'Venue', { max: 80 });
    const city = text(input.city, 'City', { max: 60, optional: true }) || null;
    const at = new Date(input.startsAt);
    if (Number.isNaN(at.getTime())) fail(400, 'When: pick a date and time');
    const lanes = Math.min(Math.max(Number(input.lanes) || 8, 4), 10);
    const events = (Array.isArray(input.events) ? input.events : []).map((e) => {
      const known = SPORTS[sport].events.find(([n]) => n === e.name);
      const kind = known ? known[1] : KINDS.includes(e.kind) ? e.kind : null;
      if (!kind) fail(400, `${e.name || 'An event'}: is it timed, a distance or a height?`);
      return { name: text(e.name, 'Event', { max: 40 }), kind, gender: GENDERS[e.gender] ? e.gender : 'x' };
    });
    if (!events.length) fail(400, 'Pick at least one event');
    if (events.length > 60) fail(400, 'Up to 60 events');
    let orgId = null;
    if (input.club) {
      const [o] = await db.query('SELECT id FROM orgs WHERE slug = $1', [String(input.club).toLowerCase()]);
      if (!o) fail(404, 'Club not found');
      const [x] = await db.query(`SELECT 1 FROM club_members WHERE org_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'`, [o.id, me.id]);
      if (!x && !me.isAdmin) fail(403, 'Only the club\'s admins can put on a meet for it');
      orgId = o.id;
    }
    const id = await db.tx(async (q) => {
      const [m] = await q(
        'INSERT INTO meets (sport, name, org_id, starts_at, place, city, lanes, visibility, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
        [sport, name, orgId, at.toISOString(), place, city, lanes, input.visibility === 'link' ? 'link' : 'public', me.id],
      );
      for (const [i, e] of events.entries()) await q('INSERT INTO meet_events (meet_id, name, kind, gender, position) VALUES ($1, $2, $3, $4, $5)', [m.id, e.name, e.kind, e.gender, i]);
      return m.id;
    });
    return get(id, actor);
  }

  // ---------- entries

  async function addEntry(q, m, e, { name, team, userId = null }) {
    if (e.stage !== 'entries') fail(409, `${e.name}: entries are closed`);
    const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM meet_entries WHERE event_id = $1', [e.id]);
    if (n >= 64) fail(409, 'Up to 64 per event');
    if (userId) {
      const [dup] = await q('SELECT 1 FROM meet_entries WHERE event_id = $1 AND user_id = $2', [e.id, userId]);
      if (dup) fail(409, 'Already entered');
    }
    await q('INSERT INTO meet_entries (meet_id, event_id, user_id, name, team) VALUES ($1, $2, $3, $4, $5)', [m.id, e.id, userId, name, team || null]);
  }
  // The organiser enters athletes: one per line, "Name, Team" (an email links an account).
  async function addAthletes(id, actor, { event, athletes } = {}) {
    await db.tx(async (q) => {
      const m = await manage(q, id, actor);
      const e = await eventOf(q, m, event);
      const lines = (Array.isArray(athletes) ? athletes : String(athletes || '').split(/\r?\n/)).map((l) => String(l).trim()).filter(Boolean);
      if (!lines.length) fail(400, 'One athlete per line: Name, Team');
      for (const line of lines) {
        const [rawName, team, email] = line.split(',').map((x) => x.trim());
        const name = text(rawName, 'Name', { max: 60 });
        const [u] = email ? await q('SELECT id FROM users WHERE lower(email) = lower($1)', [email]) : [];
        await addEntry(q, m, e, { name, team: team ? team.slice(0, 60) : null, userId: u ? u.id : null });
      }
    });
    return get(id, actor);
  }
  // An athlete enters themselves (for one of their clubs, or none).
  async function enter(id, actor, { event, club } = {}) {
    const me = needUser(actor);
    await db.tx(async (q) => {
      const m = await load(q, id, { lock: true });
      if (m.status === 'done') fail(409, 'The meet is over');
      const e = await eventOf(q, m, event);
      let team = null;
      if (club) {
        const [o] = await q(`SELECT o.name FROM orgs o JOIN club_members c ON c.org_id = o.id WHERE o.slug = $1 AND c.user_id = $2 AND c.status = 'active'`, [String(club), me.id]);
        if (!o) fail(403, 'Enter for a club you\'re in');
        team = o.name;
      }
      await addEntry(q, m, e, { name: me.name, team, userId: me.id });
    });
    return get(id, actor);
  }
  async function removeEntry(id, actor, entryId) {
    await db.tx(async (q) => {
      const m = await load(q, id, { lock: true });
      const [x] = await q('SELECT e.*, ev.stage FROM meet_entries e JOIN meet_events ev ON ev.id = e.event_id WHERE e.id = $1 AND e.meet_id = $2', [Number(entryId) || 0, m.id]);
      if (!x) fail(404, 'Entry not found');
      if (!(await canManage(q, m, actor)) && x.user_id !== actor?.user?.id) fail(403, 'Only the organisers (or the athlete) can take an entry out');
      if (x.stage !== 'entries') fail(409, 'The event has started');
      await q('DELETE FROM meet_entries WHERE id = $1', [x.id]);
    });
    return get(id, actor);
  }

  // ---------- running an event

  // Start it: heats (timed, more entries than lanes) or straight to the final.
  async function start(id, actor, eventId) {
    await db.tx(async (q) => {
      const m = await manage(q, id, actor);
      const e = await eventOf(q, m, eventId);
      if (e.stage !== 'entries') fail(409, 'Already started');
      const list = await q('SELECT id FROM meet_entries WHERE event_id = $1 ORDER BY random()', [e.id]);
      if (list.length < 1) fail(400, 'No one\'s entered');
      if (e.kind === 'time' && list.length > m.lanes) {
        const heats = Math.ceil(list.length / m.lanes);
        for (const [i, x] of list.entries()) await q('UPDATE meet_entries SET heat = $1, heat_lane = $2 WHERE id = $3', [(i % heats) + 1, Math.floor(i / heats) + 1, x.id]);
        await q(`UPDATE meet_events SET stage = 'heats' WHERE id = $1`, [e.id]);
      } else {
        // Field events have no lanes: the order is the start list.
        for (const [i, x] of list.entries()) await q('UPDATE meet_entries SET in_final = true, lane = $1 WHERE id = $2', [i + 1, x.id]);
        await q(`UPDATE meet_events SET stage = 'final' WHERE id = $1`, [e.id]);
      }
      if (m.status === 'open') await q(`UPDATE meets SET status = 'on' WHERE id = $1`, [m.id]);
    });
    return get(id, actor);
  }

  // Marks for the current round: [{ entry, mark, status }] (status dns/dnf/dq).
  async function marks(id, actor, eventId, { results } = {}) {
    await db.tx(async (q) => {
      const m = await manage(q, id, actor);
      const e = await eventOf(q, m, eventId);
      if (!['heats', 'final'].includes(e.stage)) fail(409, e.stage === 'done' ? 'This event is finished — reopen it to change marks' : 'Start the event first');
      for (const r of Array.isArray(results) ? results : []) {
        const [x] = await q('SELECT * FROM meet_entries WHERE id = $1 AND event_id = $2', [Number(r.entry) || 0, e.id]);
        if (!x) fail(400, 'That athlete isn\'t in this event');
        const status = ['dns', 'dnf', 'dq'].includes(r.status) ? r.status : 'ok';
        let v = null;
        if (status === 'ok' && r.mark != null && r.mark !== '') {
          v = readMark(e.kind, r.mark);
          if (v == null) fail(400, `${x.name}: ${e.kind === 'time' ? 'a time like 10.85 or 1:52.30' : 'metres, like 6.45'}`);
        }
        if (e.stage === 'heats') await q('UPDATE meet_entries SET heat_mark = $1, status = $2 WHERE id = $3', [v, status, x.id]);
        else await q('UPDATE meet_entries SET mark = $1, status = $2 WHERE id = $3', [v, status, x.id]);
      }
    });
    return get(id, actor);
  }

  // After the heats: the best marks make the final, best in the middle lanes.
  async function makeFinal(id, actor, eventId) {
    await db.tx(async (q) => {
      const m = await manage(q, id, actor);
      const e = await eventOf(q, m, eventId);
      if (e.stage !== 'heats') fail(409, 'There are no heats to finish');
      const ranked = (await q(`SELECT * FROM meet_entries WHERE event_id = $1 AND heat_mark IS NOT NULL AND status = 'ok'`, [e.id]))
        .sort((a, b) => better(e.kind)(Number(a.heat_mark), Number(b.heat_mark)));
      if (!ranked.length) fail(400, 'Enter the heat times first');
      const lanes = LANE_ORDER(m.lanes);
      for (const [i, x] of ranked.slice(0, m.lanes).entries()) await q('UPDATE meet_entries SET in_final = true, lane = $1 WHERE id = $2', [lanes[i], x.id]);
      await q(`UPDATE meet_entries SET status = 'ok' WHERE event_id = $1 AND in_final`, [e.id]);
      await q(`UPDATE meet_events SET stage = 'final' WHERE id = $1`, [e.id]);
    });
    return get(id, actor);
  }

  // Finish the event: places, PBs, team points, feed posts.
  async function finish(id, actor, eventId) {
    await db.tx(async (q) => {
      const m = await manage(q, id, actor);
      const e = await eventOf(q, m, eventId);
      if (e.stage !== 'final') fail(409, 'Run the final first');
      const finalists = await q('SELECT * FROM meet_entries WHERE event_id = $1 AND in_final', [e.id]);
      const ranked = finalists.filter((x) => x.mark != null && x.status === 'ok').sort((a, b) => better(e.kind)(Number(a.mark), Number(b.mark)) || a.name.localeCompare(b.name));
      if (!ranked.length) fail(400, 'Enter the final marks first');
      // Ties share a place.
      let place = 0;
      for (const [i, x] of ranked.entries()) {
        if (!i || Number(x.mark) !== Number(ranked[i - 1].mark)) place = i + 1;
        // A personal best: better than any earlier mark in an event of this name and kind.
        let pb = false;
        if (x.user_id) {
          const prev = await q(
            `SELECT COALESCE(x.mark, x.heat_mark) AS v FROM meet_entries x JOIN meet_events ev ON ev.id = x.event_id JOIN meets mt ON mt.id = ev.meet_id
             WHERE x.user_id = $1 AND ev.name = $2 AND ev.kind = $3 AND mt.sport = $4 AND x.id <> $5 AND COALESCE(x.mark, x.heat_mark) IS NOT NULL`,
            [x.user_id, e.name, e.kind, m.sport, x.id],
          );
          // Their own heat counts as an earlier mark.
          if (x.heat_mark != null) prev.push({ v: x.heat_mark });
          pb = prev.length > 0 && prev.every((p) => better(e.kind)(Number(x.mark), Number(p.v)) < 0);
        }
        await q('UPDATE meet_entries SET place = $1, pb = $2 WHERE id = $3', [place, pb, x.id]);
      }
      await q(`UPDATE meet_events SET stage = 'done' WHERE id = $1`, [e.id]);
      // Linked athletes: a feed post each.
      const ev = `${GENDERS[e.gender] === 'Open' ? '' : `${GENDERS[e.gender]}'s `}${e.name}`;
      for (const x of await q('SELECT x.*, u.profile_public FROM meet_entries x JOIN users u ON u.id = x.user_id WHERE x.event_id = $1 AND x.place IS NOT NULL', [e.id])) {
        await social.record(q, {
          dedupe: `meet:${e.id}:${x.id}`, actor: x.user_id, org: m.org_id, sport: m.sport, verb: 'meet', object: ['meet', m.id],
          data: { meet: m.id, name: m.name, sport: SPORTS[m.sport].name, event: ev, mark: showMark(e.kind, x.mark), place: x.place, of: ranked.length, pb: x.pb, team: x.team },
          visibility: m.visibility === 'public' && x.profile_public ? 'public' : 'followers',
        });
      }
      const users = (await q('SELECT user_id FROM meet_entries WHERE event_id = $1 AND user_id IS NOT NULL', [e.id])).map((r) => r.user_id);
      await notify.send(q, { users, kind: 'race', dedupe: `meet:${e.id}:done`, title: `🏁 ${m.name}: ${ev} results`, body: 'See your place and mark.', url: `/meet/${m.id}?event=${e.id}` });
      // Every event done: the meet's over, and the top team gets the post.
      const [{ left }] = await q(`SELECT COUNT(*)::int AS left FROM meet_events WHERE meet_id = $1 AND stage <> 'done'`, [m.id]);
      if (!left) {
        await q(`UPDATE meets SET status = 'done' WHERE id = $1`, [m.id]);
        const [top] = await teamTable(q, m);
        if (top) {
          await social.record(q, {
            dedupe: `meet:${m.id}:champions`, actor: m.created_by, org: m.org_id, sport: m.sport, verb: 'meet_won', object: ['meet', m.id],
            data: { meet: m.id, name: m.name, team: top.team, points: top.points, gold: top.gold }, visibility: m.visibility === 'public' ? 'public' : 'followers',
          });
        }
      }
    });
    return get(id, actor);
  }

  // Reopen a finished event (to fix a mark): its places, points and posts go.
  async function reopen(id, actor, eventId) {
    await db.tx(async (q) => {
      const m = await manage(q, id, actor);
      const e = await eventOf(q, m, eventId);
      if (e.stage !== 'done') fail(409, 'It isn\'t finished');
      await q('UPDATE meet_entries SET place = NULL, pb = false WHERE event_id = $1', [e.id]);
      await q(`UPDATE meet_events SET stage = 'final' WHERE id = $1`, [e.id]);
      await q(`DELETE FROM activity WHERE dedupe LIKE $1 OR dedupe = $2`, [`meet:${e.id}:%`, `meet:${m.id}:champions`]);
      if (m.status === 'done') await q(`UPDATE meets SET status = 'on' WHERE id = $1`, [m.id]);
    });
    return get(id, actor);
  }

  // ---------- team points

  async function teamTable(q, m) {
    const rows = await q(
      `SELECT x.team, x.place FROM meet_entries x JOIN meet_events e ON e.id = x.event_id WHERE x.meet_id = $1 AND e.stage = 'done' AND x.place IS NOT NULL AND x.team IS NOT NULL`,
      [m.id],
    );
    const pts = m.points || [];
    const by = new Map();
    for (const r of rows) {
      const t = by.get(r.team) || { team: r.team, points: 0, gold: 0, silver: 0, bronze: 0 };
      t.points += pts[r.place - 1] || 0;
      if (r.place === 1) t.gold += 1;
      if (r.place === 2) t.silver += 1;
      if (r.place === 3) t.bronze += 1;
      by.set(r.team, t);
    }
    return [...by.values()].sort((a, b) => b.points - a.points || b.gold - a.gold || b.silver - a.silver || a.team.localeCompare(b.team));
  }

  // ---------- reading

  async function get(id, actor) {
    const q = db.query;
    const m = await load(q, id);
    const can = await canManage(q, m, actor);
    const me = actor?.user?.id;
    const events = await q('SELECT * FROM meet_events WHERE meet_id = $1 ORDER BY position', [m.id]);
    const entries = await q(
      'SELECT x.*, u.handle, u.profile_public FROM meet_entries x LEFT JOIN users u ON u.id = x.user_id WHERE x.meet_id = $1 ORDER BY x.heat NULLS LAST, x.heat_lane, x.lane, x.created_at',
      [m.id],
    );
    const [club] = m.org_id ? await q('SELECT name, slug FROM orgs WHERE id = $1', [m.org_id]) : [];
    const myClubs = me ? await q(`SELECT o.name, o.slug FROM club_members c JOIN orgs o ON o.id = c.org_id WHERE c.user_id = $1 AND c.status = 'active' ORDER BY o.name`, [me]) : [];
    const person = (x, kind) => ({
      id: x.id, name: x.name, team: x.team, handle: x.profile_public ? x.handle : null, me: x.user_id === me,
      heat: x.heat, heatLane: x.heat_lane, heatMark: showMark(kind, x.heat_mark), lane: x.lane, mark: showMark(kind, x.mark),
      status: x.status, place: x.place, pb: x.pb, inFinal: x.in_final,
    });
    return {
      id: m.id, sport: { id: m.sport, name: SPORTS[m.sport].name }, name: m.name, startsAt: m.starts_at, place: m.place, city: m.city,
      lanes: m.lanes, points: m.points, status: m.status, club: club || null,
      events: events.map((e) => {
        const list = entries.filter((x) => x.event_id === e.id).map((x) => person(x, e.kind));
        return {
          id: e.id, name: e.name, kind: e.kind, gender: e.gender, genderName: GENDERS[e.gender], stage: e.stage,
          entries: list.length,
          athletes: list,
          heats: e.stage === 'entries' ? [] : [...new Set(list.filter((x) => x.heat).map((x) => x.heat))].sort((a, b) => a - b),
          results: e.stage === 'done' ? list.filter((x) => x.place).sort((a, b) => a.place - b.place || a.name.localeCompare(b.name)) : [],
          mine: list.some((x) => x.me),
        };
      }),
      teams: await teamTable(q, m),
      can: { manage: can, enter: Boolean(me) && m.status !== 'done' },
      myClubs,
    };
  }

  async function list(actor) {
    const me = actor?.user?.id || 0;
    const rows = await db.query(
      `SELECT m.*, (SELECT COUNT(*)::int FROM meet_entries x WHERE x.meet_id = m.id) AS n, (SELECT COUNT(*)::int FROM meet_events e WHERE e.meet_id = m.id) AS events,
              EXISTS (SELECT 1 FROM meet_entries x WHERE x.meet_id = m.id AND x.user_id = $1) AS mine
       FROM meets m WHERE (m.visibility = 'public' AND m.starts_at > now() - interval '60 days') OR m.created_by = $1
          OR EXISTS (SELECT 1 FROM meet_entries x WHERE x.meet_id = m.id AND x.user_id = $1)
       ORDER BY m.starts_at LIMIT 100`,
      [me],
    );
    const card = (m) => ({ id: m.id, name: m.name, sport: SPORTS[m.sport].name, startsAt: m.starts_at, place: m.place, city: m.city, status: m.status, entries: m.n, events: m.events, mine: m.mine });
    return { upcoming: rows.filter((m) => m.status !== 'done').map(card), past: rows.filter((m) => m.status === 'done').reverse().map(card) };
  }

  // The meet's card: the team table (or what's on).
  async function card(id) {
    const [m] = await db.query('SELECT * FROM meets WHERE id = $1', [Number(id) || 0]);
    if (!m) return null;
    const teams = await teamTable(db.query, m);
    const when = new Date(m.starts_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    if (teams.length) return { eyebrow: `${SPORTS[m.sport].name} · ${when} · ${m.status === 'done' ? 'Final points' : 'Points so far'}`, title: m.name, subtitle: m.place, lines: teams.slice(0, 5).map((t) => ({ name: t.team, value: `${t.points} pts` })) };
    const [{ n }] = await db.query('SELECT COUNT(*)::int AS n FROM meet_events WHERE meet_id = $1', [m.id]);
    return { eyebrow: `${SPORTS[m.sport].name} · ${when}`, title: m.name, subtitle: [m.place, m.city].filter(Boolean).join(', '), big: String(n), bigLabel: n === 1 ? 'event' : 'events' };
  }

  const catalogue = () => Object.entries(SPORTS).map(([id, s]) => ({ id, name: s.name, events: s.events.map(([name, kind]) => ({ name, kind })) }));

  return { create, addAthletes, enter, removeEntry, start, marks, makeFinal, finish, reopen, get, list, card, catalogue, ordinal };
}

module.exports = { createMeets, readMark, showMark, LANE_ORDER };
