'use strict';

// Club runs: a club's weekly run — a day, a time (India time) and a meeting
// point. Members say they're coming to the next one; after it starts an
// admin marks who ran (for a week afterwards); everyone who ran can log it
// with one tap, and it shows on the club's feed. The club's feed also gets
// "12 ran with the club", and the run's page shows its regulars.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const IST = 5.5 * 3600000;
const MARK_DAYS = 7;
const REGULAR_DAYS = 90;

// The instant a run on an India date ("2026-11-01") at "06:00" starts.
const startOf = (date, time) => {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - IST);
};
const isoDay = (t) => new Date(t + IST).toISOString().slice(0, 10);

// The next date (still on, or up to 3 hours after the start) and the last one that's started.
function datesOf(c, now = Date.now()) {
  const today = isoDay(now);
  const base = Date.parse(`${today}T00:00:00Z`);
  const on = (k) => new Date(base + k * 86400000).toISOString().slice(0, 10);
  let next = null;
  for (let k = -1; k <= 7 && !next; k++) {
    const d = on(k);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() === c.weekday && startOf(d, c.at_time).getTime() + 3 * 3600000 > now) next = d;
  }
  let last = null;
  for (let k = 0; k >= -7 && !last; k--) {
    const d = on(k);
    if (new Date(`${d}T00:00:00Z`).getUTCDay() === c.weekday && startOf(d, c.at_time).getTime() <= now) last = d;
  }
  return { next, last };
}

function createClubRuns({ db, fail, text, social, notify, runs }) {
  async function clubOf(q, slug) {
    const [o] = await q('SELECT * FROM orgs WHERE slug = $1', [String(slug || '').toLowerCase()]);
    if (!o) fail(404, 'Club not found');
    return o;
  }
  async function role(q, orgId, actor) {
    if (!actor?.user) return null;
    const [m] = await q(`SELECT role FROM club_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`, [orgId, actor.user.id]);
    if (actor.user.isAdmin) return 'admin';
    if (m && m.role === 'admin') return 'admin';
    const [editor] = await q('SELECT 1 FROM org_members WHERE org_id = $1 AND email = $2', [orgId, actor.user.email]);
    return editor ? 'admin' : m ? 'member' : null;
  }
  async function load(q, id) {
    const [c] = await q('SELECT c.*, o.name AS club, o.slug FROM club_runs c JOIN orgs o ON o.id = c.org_id WHERE c.id = $1', [Number(id) || 0]);
    if (!c) fail(404, 'Club run not found');
    return c;
  }
  // A date this run can be marked for: on its weekday, started, within a week.
  function checkPast(c, date) {
    const d = String(date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || new Date(`${d}T00:00:00Z`).getUTCDay() !== c.weekday) fail(400, 'Pick a date this run was on');
    const t = startOf(d, c.at_time).getTime();
    if (t > Date.now()) fail(409, 'It hasn\'t started yet');
    if (t < Date.now() - MARK_DAYS * 86400000) fail(409, `Runs can be marked for a week afterwards`);
    return d;
  }

  // ---------- setting one up

  async function create(slug, actor, input = {}) {
    const q = db.query;
    const o = await clubOf(q, slug);
    if ((await role(q, o.id, actor)) !== 'admin') fail(actor?.user ? 403 : 401, 'Only the club\'s admins can set up a club run');
    const weekday = Number(input.weekday);
    if (!(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) fail(400, 'Pick a day');
    const time = String(input.time || '');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail(400, 'Time: like 06:00');
    const place = text(input.place, 'Meeting point', { max: 80 });
    const distance = text(input.distance, 'Distance', { max: 40, optional: true }) || null;
    const name = text(input.name, 'Name', { max: 60, optional: true }) || `${DAYS[weekday]} run`;
    const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM club_runs WHERE org_id = $1 AND active', [o.id]);
    if (n >= 7) fail(409, 'A club can have up to 7 weekly runs');
    const [c] = await q(
      'INSERT INTO club_runs (org_id, name, weekday, at_time, place, distance, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [o.id, name, weekday, time, place, distance, actor.user.id],
    );
    const members = (await q(`SELECT user_id FROM club_members WHERE org_id = $1 AND status = 'active'`, [o.id])).map((r) => r.user_id);
    await notify.send(q, {
      users: members, kind: 'club_run', actor: actor.user.id, dedupe: `clubrun:${c.id}`,
      title: `🏃 ${o.name}: ${name}`, body: `Every ${DAYS[weekday]} at ${time} · ${place}. Say you're in.`, url: `/club-run/${c.id}`,
    });
    return get(c.id, actor);
  }
  async function stop(id, actor) {
    const c = await load(db.query, id);
    if ((await role(db.query, c.org_id, actor)) !== 'admin') fail(actor?.user ? 403 : 401, 'Only the club\'s admins can stop it');
    await db.query('UPDATE club_runs SET active = false WHERE id = $1', [c.id]);
    return { ok: true };
  }

  // ---------- reading

  async function people(q, c, date) {
    if (!date) return [];
    return q(
      `SELECT u.id, u.name, u.handle, p.going, p.attended,
              EXISTS (SELECT 1 FROM runs r WHERE r.user_id = u.id AND r.club_run_id = $1 AND r.on_date = $2) AS logged
       FROM club_run_people p JOIN users u ON u.id = p.user_id WHERE p.club_run_id = $1 AND p.on_date = $2 AND (p.going OR p.attended)
       ORDER BY lower(u.name)`,
      [c.id, date],
    );
  }
  const summary = (c) => ({
    id: c.id, name: c.name, weekday: c.weekday, day: DAYS[c.weekday], time: c.at_time, place: c.place, distance: c.distance,
    club: { name: c.club, slug: c.slug },
  });

  async function get(id, actor) {
    const q = db.query;
    const c = await load(q, id);
    const r = await role(q, c.org_id, actor);
    const me = actor?.user?.id;
    const { next, last } = datesOf(c);
    const [nextPeople, lastPeople] = await Promise.all([people(q, c, next), people(q, c, last !== next ? last : null)]);
    const regulars = await q(
      `SELECT u.id, u.name, u.handle, COUNT(*)::int AS n FROM club_run_people p JOIN users u ON u.id = p.user_id
       WHERE p.club_run_id = $1 AND p.attended AND p.on_date > (now() - interval '${REGULAR_DAYS} days')::date
       GROUP BY u.id ORDER BY n DESC, lower(u.name) LIMIT 10`,
      [c.id],
    );
    // Members to mark (admins only).
    const members = r === 'admin' ? await q(
      `SELECT u.id, u.name FROM club_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.status = 'active' ORDER BY lower(u.name)`,
      [c.org_id],
    ) : null;
    const dateView = (date, list) => date && {
      date,
      startsAt: startOf(date, c.at_time).toISOString(),
      started: startOf(date, c.at_time).getTime() <= Date.now(),
      going: list.filter((p) => p.going).map(({ id: pid, name, handle }) => ({ id: pid, name, handle })),
      ran: list.filter((p) => p.attended).map(({ id: pid, name, handle, logged }) => ({ id: pid, name, handle, logged })),
      me: me ? (list.find((p) => p.id === me) || null) : null,
    };
    // The date to mark and log: the one that's on now, else the last one.
    const markable = next && startOf(next, c.at_time).getTime() <= Date.now() ? next : last;
    return {
      ...summary(c),
      active: c.active,
      next: dateView(next, nextPeople),
      last: last && last !== next ? dateView(last, lastPeople) : null,
      markDate: markable,
      regulars: regulars.map((x) => ({ id: x.id, name: x.name, handle: x.handle, runs: x.n })),
      members,
      can: { rsvp: r !== null && c.active, mark: r === 'admin' && Boolean(markable), stop: r === 'admin' && c.active },
    };
  }

  // A club's weekly runs, with the next date and who's coming.
  async function forClub(slug, actor) {
    const q = db.query;
    const o = await clubOf(q, slug);
    const rows = await q('SELECT c.*, o.name AS club, o.slug FROM club_runs c JOIN orgs o ON o.id = c.org_id WHERE c.org_id = $1 AND c.active ORDER BY c.weekday, c.at_time', [o.id]);
    const me = actor?.user?.id;
    const out = [];
    for (const c of rows) {
      const { next } = datesOf(c);
      const list = await people(q, c, next);
      out.push({ ...summary(c), next, startsAt: startOf(next, c.at_time).toISOString(), going: list.filter((p) => p.going).length, me: Boolean(me && list.some((p) => p.id === me && p.going)) });
    }
    return { admin: (await role(q, o.id, actor)) === 'admin', items: out.sort((a, b) => a.startsAt.localeCompare(b.startsAt)) };
  }

  // ---------- coming, and who ran

  async function rsvp(id, actor, { going = true } = {}) {
    const q = db.query;
    const c = await load(q, id);
    if (!c.active) fail(409, 'This run has stopped');
    if (!(await role(q, c.org_id, actor))) fail(actor?.user ? 403 : 401, 'Join the club first');
    const { next } = datesOf(c);
    await q(
      `INSERT INTO club_run_people (club_run_id, on_date, user_id, going) VALUES ($1, $2, $3, $4)
       ON CONFLICT (club_run_id, on_date, user_id) DO UPDATE SET going = EXCLUDED.going`,
      [c.id, next, actor.user.id, Boolean(going)],
    );
    return get(id, actor);
  }

  // Who ran on a date (admins): the full list; then the club's feed says so.
  async function mark(id, actor, { date, ran } = {}) {
    const c = await load(db.query, id);
    if ((await role(db.query, c.org_id, actor)) !== 'admin') fail(actor?.user ? 403 : 401, 'Only the club\'s admins mark who ran');
    const d = checkPast(c, date);
    const ids = [...new Set((Array.isArray(ran) ? ran : []).map(Number).filter(Number.isInteger))];
    await db.tx(async (q) => {
      const ok = ids.length ? (await q(`SELECT user_id FROM club_members WHERE org_id = $1 AND status = 'active' AND user_id = ANY($2::int[])`, [c.org_id, ids])).map((r) => r.user_id) : [];
      if (ok.length !== ids.length) fail(400, 'Mark club members only');
      await q('UPDATE club_run_people SET attended = false WHERE club_run_id = $1 AND on_date = $2', [c.id, d]);
      for (const uid of ids) {
        await q(
          `INSERT INTO club_run_people (club_run_id, on_date, user_id, attended) VALUES ($1, $2, $3, true)
           ON CONFLICT (club_run_id, on_date, user_id) DO UPDATE SET attended = true`,
          [c.id, d, uid],
        );
      }
      const key = `clubrun:${c.id}:${d}`;
      if (!ids.length) {
        await q('DELETE FROM activity WHERE dedupe = $1', [key]);
        return;
      }
      await social.record(q, {
        dedupe: key, actor: null, people: ids, org: c.org_id, sport: 'running', verb: 'club_run', object: ['club_run', c.id], at: startOf(d, c.at_time).toISOString(),
        data: { clubRun: c.id, name: c.name, club: c.club, slug: c.slug, date: d, place: c.place, ran: ids.length },
        visibility: 'club',
      });
      await notify.send(q, {
        users: ids, kind: 'club_run', dedupe: `clubran:${c.id}:${d}`, title: `🏃 You ran with ${c.club}`, body: 'Log your distance and time — it goes on the club\'s feed.', url: `/club-run/${c.id}`,
      });
    });
    return get(id, actor);
  }

  // A runner logs this club run (marked as having run, or said they're coming to it).
  async function log(id, actor, input = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    const c = await load(db.query, id);
    const d = checkPast(c, input.date);
    const [p] = await db.query('SELECT going, attended FROM club_run_people WHERE club_run_id = $1 AND on_date = $2 AND user_id = $3', [c.id, d, actor.user.id]);
    if (!p || !(p.going || p.attended)) fail(403, 'Say you\'re in (or ask an admin to mark you) to log this run');
    // Coming and logging it counts as having run.
    if (!p.attended) await db.query('UPDATE club_run_people SET attended = true WHERE club_run_id = $1 AND on_date = $2 AND user_id = $3', [c.id, d, actor.user.id]);
    return runs.log(actor, { ...input, title: input.title || `${c.club} · ${c.name}`, place: input.place || c.place, ranAt: startOf(d, c.at_time).toISOString() }, { id: c.id, date: d });
  }

  return { create, stop, get, forClub, rsvp, mark, log, DAYS, datesOf, startOf };
}

module.exports = { createClubRuns, datesOf, startOf };
