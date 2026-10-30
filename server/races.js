'use strict';

// Races: an organiser (or a club's admins) sets up a race with one or more
// distances. Runners enter (or the organiser adds them) and get the next bib.
// On the day the organiser types finish times by bib. Results rank each
// distance overall, by gender and by age group. Publishing them turns every
// linked finisher's time into a run (so it counts in their bests, totals and
// goals) and posts their finish to the feed, with a share card.

const { clock } = require('./runs');

const GENDERS = { m: 'Men', f: 'Women', x: 'Open' };
const AGE_GROUPS = [[0, 19, 'Under 20'], [20, 29, '20–29'], [30, 39, '30–39'], [40, 49, '40–49'], [50, 59, '50–59'], [60, 200, '60+']];
const PRESETS = { '5k': ['5K', 5000], '10k': ['10K', 10000], half: ['Half marathon', 21097], full: ['Marathon', 42195] };
const MAX_ENTRIES = 5000;

function createRaces({ db, fail, text, social, notify }) {
  const needUser = (actor) => { if (!actor?.user) fail(401, 'Sign in first'); return actor.user; };
  const ageGroup = (birthYear, at) => {
    if (!birthYear) return null;
    const age = new Date(at).getUTCFullYear() - birthYear;
    return (AGE_GROUPS.find(([lo, hi]) => age >= lo && age <= hi) || [])[2] || null;
  };

  async function load(q, id, { lock = false } = {}) {
    const [r] = await q(`SELECT * FROM races WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [Number(id) || 0]);
    if (!r) fail(404, 'Race not found');
    return r;
  }
  // The organiser who set it up, its club's admins, or a site admin.
  async function canManage(q, r, actor) {
    if (!actor?.user) return false;
    if (actor.user.isAdmin || r.created_by === actor.user.id) return true;
    if (!r.org_id) return false;
    const [m] = await q(`SELECT 1 FROM club_members WHERE org_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'`, [r.org_id, actor.user.id]);
    return Boolean(m);
  }
  async function manage(q, id, actor, opts) {
    const r = await load(q, id, opts);
    if (!(await canManage(q, r, actor))) fail(actor?.user ? 403 : 401, 'Only the race\'s organisers can do that');
    return r;
  }

  // ---------- setting one up

  // distances: preset keys ('5k', '10k', 'half', 'full') or numbers of km.
  function readEvents(list) {
    const out = (Array.isArray(list) ? list : []).map((d) => {
      if (PRESETS[d]) return { name: PRESETS[d][0], m: PRESETS[d][1] };
      const k = Number(d);
      if (!(k >= 0.5 && k <= 250)) fail(400, 'Distances: between 0.5 and 250 km');
      return { name: `${Math.round(k * 100) / 100}K`, m: Math.round(k * 1000) };
    });
    if (!out.length) fail(400, 'Pick at least one distance');
    if (out.length > 6) fail(400, 'Up to 6 distances');
    if (new Set(out.map((e) => e.m)).size !== out.length) fail(400, 'Each distance once');
    return out.sort((a, b) => a.m - b.m);
  }

  async function create(actor, input = {}) {
    const me = needUser(actor);
    const name = text(input.name, 'Race name', { max: 80 });
    const place = text(input.place, 'Start', { max: 80 });
    const city = text(input.city, 'City', { max: 60, optional: true }) || null;
    const at = new Date(input.startsAt);
    if (Number.isNaN(at.getTime())) fail(400, 'When: pick a date and time');
    if (at < Date.now() - 86400000) fail(400, 'That date has passed');
    const events = readEvents(input.distances);
    let orgId = null;
    if (input.club) {
      const [o] = await db.query('SELECT id FROM orgs WHERE slug = $1', [String(input.club).toLowerCase()]);
      if (!o) fail(404, 'Club not found');
      const [m] = await db.query(`SELECT 1 FROM club_members WHERE org_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'`, [o.id, me.id]);
      if (!m && !me.isAdmin) fail(403, 'Only the club\'s admins can put on a race for it');
      orgId = o.id;
    }
    const visibility = input.visibility === 'link' ? 'link' : 'public';
    const id = await db.tx(async (q) => {
      const [r] = await q(
        'INSERT INTO races (name, org_id, starts_at, place, city, visibility, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [name, orgId, at.toISOString(), place, city, visibility, me.id],
      );
      for (const [i, e] of events.entries()) await q('INSERT INTO race_events (race_id, name, distance_m, position) VALUES ($1, $2, $3, $4)', [r.id, e.name, e.m, i]);
      if (orgId && visibility === 'public') {
        await social.record(q, {
          dedupe: `race:${r.id}:new`, actor: me.id, org: orgId, sport: 'running', verb: 'race_new', object: ['race', r.id],
          data: { race: r.id, name, at: at.toISOString(), place, distances: events.map((e) => e.name) },
        });
      }
      return r.id;
    });
    return get(id, actor);
  }

  async function setStatus(id, actor, { status } = {}) {
    if (!['open', 'closed'].includes(status)) fail(400, 'status: open or closed');
    await db.tx(async (q) => {
      const r = await manage(q, id, actor, { lock: true });
      if (r.status === 'done') fail(409, 'The results are out');
      await q('UPDATE races SET status = $1 WHERE id = $2', [status, r.id]);
    });
    return get(id, actor);
  }

  // ---------- entries

  async function addEntry(q, r, { eventId, userId = null, name, gender, birthYear }) {
    const [ev] = await q('SELECT id FROM race_events WHERE id = $1 AND race_id = $2', [Number(eventId) || 0, r.id]);
    if (!ev) fail(400, 'Pick a distance');
    const g = GENDERS[gender] ? gender : 'x';
    const by = birthYear ? Number(birthYear) : null;
    if (by != null && !(by >= 1920 && by <= new Date().getFullYear() - 5)) fail(400, 'Year of birth: like 1990');
    const [{ n, top }] = await q('SELECT COUNT(*)::int AS n, COALESCE(MAX(bib), 0)::int AS top FROM race_entries WHERE race_id = $1', [r.id]);
    if (n >= MAX_ENTRIES) fail(409, 'The race is full');
    const [e] = await q(
      'INSERT INTO race_entries (race_id, event_id, user_id, name, gender, birth_year, bib) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
      [r.id, ev.id, userId, name, g, by, top + 1],
    );
    return e;
  }

  // A runner enters themselves.
  async function enter(id, actor, input = {}) {
    const me = needUser(actor);
    await db.tx(async (q) => {
      const r = await load(q, id, { lock: true });
      if (r.status !== 'open') fail(409, 'Entries are closed');
      const [already] = await q('SELECT 1 FROM race_entries WHERE race_id = $1 AND user_id = $2', [r.id, me.id]);
      if (already) fail(409, 'You\'re already in');
      // The club they represent (if they're still in it).
      const [rep] = await q(`SELECT o.name FROM users u JOIN orgs o ON o.id = u.rep_org_id JOIN club_members m ON m.org_id = o.id AND m.user_id = u.id AND m.status = 'active' WHERE u.id = $1`, [me.id]);
      const e = await addEntry(q, r, { eventId: input.event, userId: me.id, name: me.name, gender: input.gender, birthYear: input.birthYear });
      if (rep) await q('UPDATE race_entries SET team = $1 WHERE id = $2', [rep.name, e.id]);
      if (input.birthYear) await q('UPDATE users SET birth_year = COALESCE(birth_year, $1) WHERE id = $2', [Number(input.birthYear), me.id]);
    });
    return get(id, actor);
  }
  async function withdraw(id, actor) {
    const me = needUser(actor);
    await db.tx(async (q) => {
      const r = await load(q, id, { lock: true });
      if (r.status === 'done') fail(409, 'The results are out');
      await q(`DELETE FROM race_entries WHERE race_id = $1 AND user_id = $2 AND finish_s IS NULL`, [r.id, me.id]);
    });
    return get(id, actor);
  }
  // The organiser adds a runner (on the day, or from a list).
  async function addRunner(id, actor, input = {}) {
    await db.tx(async (q) => {
      const r = await manage(q, id, actor, { lock: true });
      if (r.status === 'done') fail(409, 'The results are out');
      const name = text(input.name, 'Name', { max: 60 });
      const e = await addEntry(q, r, { eventId: input.event, name, gender: input.gender, birthYear: input.birthYear });
      const team = text(input.team, 'Club', { max: 60, optional: true });
      if (team) await q('UPDATE race_entries SET team = $1 WHERE id = $2', [team, e.id]);
    });
    return get(id, actor);
  }

  // ---------- times

  // A finish time by bib ("41:12", "1:52:30"), or dnf; time: null clears it.
  async function result(id, actor, { bib, time, dnf = false } = {}) {
    let saved;
    await db.tx(async (q) => {
      const r = await manage(q, id, actor, { lock: true });
      const [e] = await q('SELECT e.*, ev.distance_m FROM race_entries e JOIN race_events ev ON ev.id = e.event_id WHERE e.race_id = $1 AND e.bib = $2', [r.id, Number(bib) || 0]);
      if (!e) fail(404, `No runner with bib ${bib}`);
      let s = null;
      if (time != null && time !== '' && !dnf) {
        const parts = String(time).trim().split(':').map(Number);
        if (parts.length < 2 || parts.length > 3 || parts.some((x) => !Number.isFinite(x) || x < 0) || parts.slice(1).some((x) => x >= 60)) fail(400, 'Time: like 41:12 or 1:52:30');
        s = parts.reduce((sum, x) => sum * 60 + x, 0);
        if (s / (e.distance_m / 1000) < 150) fail(400, 'That\'s faster than a world record — check the bib and time');
      }
      await q('UPDATE race_entries SET finish_s = $1, status = $2 WHERE id = $3', [s, dnf ? 'dnf' : s ? 'finished' : 'entered', e.id]);
      saved = { bib: e.bib, name: e.name, time: s ? clock(s) : null, dnf: Boolean(dnf) };
      // Published already: keep it up to date.
      if (r.status === 'done') await publishIn(q, r);
    });
    return { saved, race: await get(id, actor) };
  }

  // ---------- results

  async function resultsOf(q, r) {
    const events = await q('SELECT * FROM race_events WHERE race_id = $1 ORDER BY position', [r.id]);
    const entries = await q(
      `SELECT e.*, u.handle, u.profile_public, u.birth_year AS ub FROM race_entries e LEFT JOIN users u ON u.id = e.user_id WHERE e.race_id = $1 ORDER BY e.bib`,
      [r.id],
    );
    return events.map((ev) => {
      const mine = entries.filter((e) => e.event_id === ev.id);
      const done = mine.filter((e) => e.status === 'finished').sort((a, b) => a.finish_s - b.finish_s || a.bib - b.bib);
      const counter = new Map();
      const place = (key) => { const k = (counter.get(key) || 0) + 1; counter.set(key, k); return k; };
      const finishers = done.map((e, i) => {
        const group = ageGroup(e.birth_year, r.starts_at);
        return {
          id: e.id, bib: e.bib, name: e.name, team: e.team, handle: e.profile_public ? e.handle : null, userId: e.user_id,
          gender: e.gender, genderName: GENDERS[e.gender], ageGroup: group,
          time: clock(e.finish_s), seconds: e.finish_s, pace: clock(e.finish_s / (ev.distance_m / 1000)),
          place: i + 1, genderPlace: place(`g:${e.gender}`), groupPlace: group ? place(`a:${e.gender}:${group}`) : null,
        };
      });
      return {
        id: ev.id, name: ev.name, km: ev.distance_m / 1000, entries: mine.length,
        finishers,
        dnf: mine.filter((e) => e.status === 'dnf').map((e) => ({ bib: e.bib, name: e.name })),
        waiting: mine.filter((e) => e.status === 'entered').length,
      };
    });
  }

  // Publish: each linked finisher gets a run and a feed post (re-done if
  // times change afterwards); everyone in it is told.
  async function publishIn(q, r) {
    const events = await resultsOf(q, r);
    const linked = new Set();
    for (const ev of events) {
      for (const f of ev.finishers.filter((x) => x.userId)) {
        linked.add(f.userId);
        const [e] = await q('SELECT run_id FROM race_entries WHERE id = $1', [f.id]);
        let runId = e.run_id;
        if (runId) await q('UPDATE runs SET distance_m = $1, duration_s = $2, ran_at = $3 WHERE id = $4', [Math.round(ev.km * 1000), f.seconds, r.starts_at, runId]);
        else {
          const [run] = await q(
            `INSERT INTO runs (user_id, distance_m, duration_s, ran_at, title, place, visibility) VALUES ($1, $2, $3, $4, $5, $6, 'public') RETURNING id`,
            [f.userId, Math.round(ev.km * 1000), f.seconds, r.starts_at, `${r.name} · ${ev.name}`, r.place],
          );
          runId = run.id;
          await q('UPDATE race_entries SET run_id = $1 WHERE id = $2', [runId, f.id]);
        }
        const [u] = await q('SELECT profile_public FROM users WHERE id = $1', [f.userId]);
        await social.record(q, {
          dedupe: `race:${r.id}:${f.id}`, actor: f.userId, org: r.org_id, sport: 'running', verb: 'race', object: ['race', r.id], at: new Date(r.starts_at).toISOString(),
          data: {
            race: r.id, name: r.name, event: ev.name, km: ev.km, time: f.time, pace: f.pace, place: f.place, of: ev.finishers.length,
            genderPlace: f.genderPlace, genderName: f.genderName, ageGroup: f.ageGroup, groupPlace: f.groupPlace,
          },
          visibility: r.visibility === 'public' && u.profile_public ? 'public' : 'followers',
        });
      }
    }
    // Runs and posts for times that were taken away.
    const gone = await q(`SELECT id, run_id FROM race_entries WHERE race_id = $1 AND status <> 'finished' AND run_id IS NOT NULL`, [r.id]);
    for (const g of gone) {
      await q('DELETE FROM runs WHERE id = $1', [g.run_id]);
      await q('UPDATE race_entries SET run_id = NULL WHERE id = $1', [g.id]);
      await q('DELETE FROM activity WHERE dedupe = $1', [`race:${r.id}:${g.id}`]);
    }
    return linked;
  }
  async function publish(id, actor) {
    await db.tx(async (q) => {
      const r = await manage(q, id, actor, { lock: true });
      const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM race_entries WHERE race_id = $1 AND status = 'finished'`, [r.id]);
      if (!n) fail(400, 'Enter some finish times first');
      await q(`UPDATE races SET status = 'done', published_at = COALESCE(published_at, now()) WHERE id = $1`, [r.id]);
      const linked = await publishIn(q, { ...r, status: 'done' });
      const everyone = (await q('SELECT DISTINCT user_id FROM race_entries WHERE race_id = $1 AND user_id IS NOT NULL', [r.id])).map((x) => x.user_id);
      await notify.send(q, { users: [...new Set([...everyone, ...linked])], kind: 'race', dedupe: `race:${r.id}:results`, title: `🏁 ${r.name}: results are out`, body: 'See where you finished, and share your time.', url: `/race/${r.id}` });
    });
    return get(id, actor);
  }

  // ---------- reading

  async function get(id, actor) {
    const q = db.query;
    const r = await load(q, id);
    const manageOk = await canManage(q, r, actor);
    const events = await resultsOf(q, r);
    const me = actor?.user?.id;
    const [mine] = me ? await q('SELECT e.*, ev.name AS event FROM race_entries e JOIN race_events ev ON ev.id = e.event_id WHERE e.race_id = $1 AND e.user_id = $2', [r.id, me]) : [];
    const [club] = r.org_id ? await q('SELECT name, slug FROM orgs WHERE id = $1', [r.org_id]) : [];
    const myResult = mine && events.flatMap((ev) => ev.finishers.map((f) => ({ ...f, event: ev.name, of: ev.finishers.length }))).find((f) => f.id === mine.id);
    const [post] = myResult ? await q('SELECT id, visibility FROM activity WHERE dedupe = $1', [`race:${r.id}:${mine.id}`]) : [];
    const published = r.status === 'done';
    return {
      id: r.id, name: r.name, startsAt: r.starts_at, place: r.place, city: r.city, visibility: r.visibility, status: r.status,
      club: club || null,
      events: events.map((ev) => ({
        id: ev.id, name: ev.name, km: ev.km, entries: ev.entries,
        // Results for everyone once they're out; the organisers see them as they come in.
        finishers: published || manageOk ? ev.finishers.map(({ userId, seconds, ...f }) => f) : [],
        dnf: published || manageOk ? ev.dnf : [],
        waiting: ev.waiting,
      })),
      entries: events.reduce((n, ev) => n + ev.entries, 0),
      me: mine ? {
        bib: mine.bib, event: mine.event, eventId: mine.event_id, status: mine.status,
        result: published && myResult ? { ...myResult, post: post ? { id: post.id, public: post.visibility === 'public' } : null } : null,
      } : null,
      // The organisers' list: bib, name, distance, time.
      runners: manageOk ? (await q(
        'SELECT e.bib, e.name, e.gender, e.birth_year, e.status, e.finish_s, ev.name AS event FROM race_entries e JOIN race_events ev ON ev.id = e.event_id WHERE e.race_id = $1 ORDER BY e.bib',
        [r.id],
      )).map((x) => ({ bib: x.bib, name: x.name, event: x.event, gender: x.gender, status: x.status, time: x.finish_s ? clock(x.finish_s) : null })) : null,
      can: { manage: manageOk, enter: r.status === 'open' && !mine && Boolean(me), withdraw: Boolean(mine) && !mine.finish_s && r.status !== 'done', publish: manageOk },
      ageGroups: AGE_GROUPS.map((g) => g[2]),
    };
  }

  // Upcoming public races, the ones I'm in or run, and recent results.
  async function list(actor) {
    const q = db.query;
    const me = actor?.user?.id || 0;
    const rows = await q(
      `SELECT r.*, (SELECT COUNT(*)::int FROM race_entries e WHERE e.race_id = r.id) AS n,
              EXISTS (SELECT 1 FROM race_entries e WHERE e.race_id = r.id AND e.user_id = $1) AS mine,
              (r.created_by = $1) AS organiser,
              (SELECT string_agg(name, ' · ' ORDER BY position) FROM race_events WHERE race_id = r.id) AS distances
       FROM races r
       WHERE (r.visibility = 'public' AND r.starts_at > now() - interval '60 days')
          OR r.created_by = $1 OR EXISTS (SELECT 1 FROM race_entries e WHERE e.race_id = r.id AND e.user_id = $1)
       ORDER BY r.starts_at LIMIT 100`,
      [me],
    );
    const card = (r) => ({ id: r.id, name: r.name, startsAt: r.starts_at, place: r.place, city: r.city, status: r.status, entries: r.n, distances: r.distances, mine: r.mine, organiser: r.organiser });
    const now = Date.now();
    return {
      upcoming: rows.filter((r) => new Date(r.starts_at).getTime() > now - 12 * 3600000 && r.status !== 'done').map(card),
      past: rows.filter((r) => !(new Date(r.starts_at).getTime() > now - 12 * 3600000 && r.status !== 'done')).reverse().map(card),
    };
  }

  // The share card: the race, or its winners.
  async function card(id) {
    const [r] = await db.query(`SELECT * FROM races WHERE id = $1`, [Number(id) || 0]);
    if (!r) return null;
    const events = await resultsOf(db.query, r);
    const when = new Date(r.starts_at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    if (r.status === 'done') {
      const ev = events.find((e) => e.finishers.length) || events[0];
      return { eyebrow: `Results · ${ev.name} · ${when}`, title: r.name, subtitle: `${ev.finishers.length} finishers · ${r.place}`, lines: ev.finishers.slice(0, 3).map((f) => ({ name: f.name, value: f.time })) };
    }
    const n = events.reduce((s, e) => s + e.entries, 0);
    return { eyebrow: `Race · ${when}`, title: r.name, subtitle: `${events.map((e) => e.name).join(' · ')} · ${[r.place, r.city].filter(Boolean).join(', ')}`, big: String(n), bigLabel: n === 1 ? 'runner in' : 'runners in' };
  }

  return { create, setStatus, enter, withdraw, addRunner, result, publish, get, list, card, GENDERS };
}

module.exports = { createRaces };
