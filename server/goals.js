'use strict';

// Goals: "30 games this month". Three kinds:
// - personal: each person who joins chases the target (friends join by link);
// - club: the club's members add up to one total;
// - versus: two clubs' members add up, and the higher total wins.
// Progress is counted live from confirmed group games, confirmed challenges
// and finished tournament matches between starts_at and ends_at (games, or
// wins), or from logged runs (km, or runs). Reaching a target is a badge: in the feed, with a notification.

const sports = require('./sports');

const METRICS = { games: 'games', wins: 'wins', km: 'km', runs: 'runs' };
const RUNNING = ['km', 'runs']; // counted from logged runs (runs.js), not games
// A timestamp from the database (a Date or a string) in milliseconds, exactly.
const ms = (t) => new Date(t).getTime();
const MAX_DAYS = 92;

function createGoals({ db, fail, text, social, notify, runCounts = null }) {
  const needUser = (actor) => { if (!actor?.user) fail(401, 'Sign in first'); return actor.user; };

  // ---------- counting

  // Map userId -> { games, wins } in [from, to), for one sport or all.
  async function counts(q, userIds, from, to, sport) {
    if (!userIds.length) return new Map();
    const rows = await q(
      `WITH played AS (
         SELECT p.uid, (p.uid = ANY(CASE WHEN gg.winner = 'a' THEN ARRAY[gg.a1, gg.a2] ELSE ARRAY[gg.b1, gg.b2] END)) AS won, gg.ended_at AS at, g.sport
         FROM group_games gg JOIN groups g ON g.id = gg.group_id, unnest(ARRAY[gg.a1, gg.a2, gg.b1, gg.b2]) AS p(uid)
         WHERE gg.status = 'confirmed' AND p.uid IS NOT NULL
         UNION ALL
         SELECT p.uid, (p.uid = ANY(CASE WHEN c.winner = 'a' THEN ARRAY[c.a1, c.a2] ELSE ARRAY[c.b1, c.b2] END)), c.ended_at, c.sport
         FROM challenges c, unnest(ARRAY[c.a1, c.a2, c.b1, c.b2]) AS p(uid)
         WHERE c.status = 'confirmed' AND p.uid IS NOT NULL
         UNION ALL
         SELECT u.id, (m.winner_id = ep.entry_id), m.updated_at, t.sport
         FROM matches m JOIN tournaments t ON t.id = m.tournament_id
         JOIN entry_players ep ON ep.entry_id IN (m.a_id, m.b_id) JOIN users u ON u.email = ep.email
         WHERE m.status = 'done' AND NOT COALESCE(m.walkover, false) AND m.a_id IS NOT NULL AND m.b_id IS NOT NULL
       )
       SELECT uid, COUNT(*)::int AS games, COUNT(*) FILTER (WHERE won)::int AS wins FROM played
       WHERE uid = ANY($1::int[]) AND at >= $2 AND at < $3 AND ($4::text IS NULL OR sport = $4)
       GROUP BY uid`,
      [userIds, from, to, sport || null],
    );
    return new Map(rows.map((r) => [r.uid, r]));
  }

  // ---------- making one

  async function isClubAdmin(q, orgId, actor) {
    if (actor.user.isAdmin) return true;
    const [m] = await q(`SELECT 1 FROM club_members WHERE org_id = $1 AND user_id = $2 AND status = 'active' AND role = 'admin'`, [orgId, actor.user.id]);
    if (m) return true;
    const [e] = await q('SELECT 1 FROM org_members WHERE org_id = $1 AND email = $2', [orgId, actor.user.email]);
    return Boolean(e);
  }
  const clubBySlug = async (q, slug) => {
    const [o] = await q('SELECT id, name, slug FROM orgs WHERE slug = $1', [String(slug || '').toLowerCase()]);
    if (!o) fail(404, 'Club not found');
    return o;
  };

  async function create(actor, input = {}) {
    const me = needUser(actor);
    const scope = ['personal', 'club', 'versus'].includes(input.scope) ? input.scope : 'personal';
    const metric = METRICS[input.metric] ? input.metric : 'games';
    const sport = input.sport && !RUNNING.includes(metric) ? String(input.sport) : null;
    if (sport && !sports.get(sport)) fail(400, 'Pick a sport, or any sport');
    const starts = new Date(input.startsAt || Date.now());
    const ends = new Date(input.endsAt || Date.now() + 30 * 86400000);
    if (Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) fail(400, 'The goal needs an end after its start');
    if ((ends - starts) / 86400000 > MAX_DAYS) fail(400, `Goals run for up to ${MAX_DAYS} days`);
    if (ends < Date.now()) fail(400, 'That goal is already over');
    const target = input.target == null || input.target === '' ? null : Math.round(Number(input.target));
    if (scope !== 'versus' && !(target >= 1 && target <= 100000)) fail(400, 'Set a target, like 30');
    let org = null;
    let rival = null;
    if (scope !== 'personal') {
      org = await clubBySlug(db.query, input.club);
      if (!(await isClubAdmin(db.query, org.id, actor))) fail(403, 'Only the club\'s admins can set a club goal');
      if (scope === 'versus') {
        rival = await clubBySlug(db.query, input.rival);
        if (rival.id === org.id) fail(400, 'Pick another club to take on');
      }
    }
    const what = metric === 'km' ? 'km run' : metric === 'runs' ? 'runs' : `${metric === 'wins' ? 'wins' : 'games'}${sport ? ` of ${sports.get(sport).name.toLowerCase()}` : ''}`;
    const title = text(input.title, 'Name', { max: 80, optional: true })
      || (scope === 'versus' ? `${org.name} v ${rival.name}: most ${what}` : `${target} ${what}`);
    const [g] = await db.query(
      `INSERT INTO goals (scope, title, metric, sport, target, org_id, rival_id, starts_at, ends_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [scope, title, metric, sport, target, org && org.id, rival && rival.id, starts.toISOString(), ends.toISOString(), me.id],
    );
    // The maker's in (on their club's side); club goals count every member anyway.
    if (scope === 'personal') await db.query('INSERT INTO goal_members (goal_id, user_id) VALUES ($1, $2)', [g.id, me.id]);
    if (org) {
      await social.record(db.query, {
        dedupe: `goal-new:${g.id}`, actor: me.id, org: org.id, sport, verb: 'goal_set', object: ['goal', g.id],
        data: { goal: g.id, title, scope, club: org.name, slug: org.slug, rival: rival && rival.name },
      });
    }
    return get(g.id, actor);
  }

  // ---------- reading

  async function load(q, id) {
    const [g] = await q('SELECT * FROM goals WHERE id = $1', [Number(id) || 0]);
    if (!g) fail(404, 'Goal not found');
    return g;
  }
  // Who counts: personal — those who joined; club — the club's members;
  // versus — both clubs' members, on their club's side.
  async function people(q, g) {
    if (g.scope === 'personal') {
      return q('SELECT u.id, u.name, u.handle, NULL::int AS side FROM goal_members m JOIN users u ON u.id = m.user_id WHERE m.goal_id = $1', [g.id]);
    }
    return q(
      `SELECT DISTINCT ON (u.id) u.id, u.name, u.handle, m.org_id AS side FROM club_members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = ANY($1::int[]) AND m.status = 'active' ORDER BY u.id, (m.org_id = $2) DESC`,
      [[g.org_id, g.rival_id].filter(Boolean), g.org_id],
    );
  }

  async function get(id, actor) {
    const q = db.query;
    const g = await load(q, id);
    const list = await people(q, g);
    const end = new Date(Math.min(ms(g.ends_at), Date.now() + 60000));
    const running = RUNNING.includes(g.metric);
    const c = running && runCounts ? await runCounts(q, list.map((p) => p.id), g.starts_at, end.toISOString())
      : await counts(q, list.map((p) => p.id), g.starts_at, end.toISOString(), g.sport);
    const value = (p) => (c.get(p.id) || { games: 0, wins: 0, km: 0, runs: 0 })[g.metric];
    const board = list.map((p) => ({ id: p.id, name: p.name, handle: p.handle, side: p.side, value: value(p) }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    const clubs = (await q('SELECT id, name, slug FROM orgs WHERE id = ANY($1::int[])', [[g.org_id, g.rival_id].filter(Boolean)]))
      .map((o) => ({ ...o, total: board.filter((p) => p.side === o.id).reduce((sum, p) => sum + p.value, 0) }));
    const me = actor?.user?.id;
    const ended = ms(g.ends_at) <= Date.now();
    const view = {
      id: g.id, scope: g.scope, title: g.title, metric: g.metric, target: g.target,
      sport: g.sport ? { id: g.sport, name: sports.get(g.sport).name } : null,
      startsAt: g.starts_at, endsAt: g.ends_at, ended,
      daysLeft: ended ? 0 : Math.ceil((ms(g.ends_at) - Date.now()) / 86400000),
      board: board.slice(0, 100),
      people: board.length,
      club: clubs.find((o) => o.id === g.org_id) || null,
      rival: clubs.find((o) => o.id === g.rival_id) || null,
      total: g.scope === 'personal' ? null : board.reduce((sum, p) => sum + p.value, 0),
      me: me ? board.find((p) => p.id === me) || null : null,
      can: {
        join: Boolean(me) && g.scope === 'personal' && !ended && !board.some((p) => p.id === me),
        leave: Boolean(me) && g.scope === 'personal' && board.some((p) => p.id === me) && g.created_by !== me,
      },
    };
    await badges(g, view);
    return view;
  }

  // Badges, once each: a person who reaches a personal target; a club that
  // reaches its total; the winning club when a versus goal ends.
  async function badges(g, v) {
    const q = db.query;
    const base = { sport: g.sport, verb: 'goal', object: ['goal', g.id] };
    const data = { goal: g.id, title: g.title, metric: g.metric, target: g.target };
    if (g.scope === 'personal' && g.target) {
      for (const p of v.board.filter((x) => x.value >= g.target)) {
        const [done] = await q('SELECT 1 FROM activity WHERE dedupe = $1', [`goal:${g.id}:${p.id}`]);
        if (done) continue;
        await social.record(q, { ...base, dedupe: `goal:${g.id}:${p.id}`, actor: p.id, data: { ...data, value: p.value } });
        await notify.send(q, { users: [p.id], kind: 'goal', dedupe: `goal:${g.id}`, title: `🏅 Goal reached: ${g.title}`, body: `${p.value} ${g.metric} — nicely done.`, url: `/goals/${g.id}` });
      }
    } else if (g.scope === 'club' && g.target && v.total >= g.target) {
      const [done] = await q('SELECT 1 FROM activity WHERE dedupe = $1', [`goal:${g.id}:club`]);
      if (!done) {
        await social.record(q, { ...base, dedupe: `goal:${g.id}:club`, org: g.org_id, data: { ...data, value: v.total, club: v.club.name, slug: v.club.slug } });
        await notify.send(q, { users: v.board.filter((p) => p.value > 0).map((p) => p.id), kind: 'goal', dedupe: `goal:${g.id}`, title: `🏅 ${v.club.name} reached ${g.title}`, body: `Together: ${v.total} ${g.metric}.`, url: `/goals/${g.id}` });
      }
    } else if (g.scope === 'versus' && v.ended && v.club && v.rival && v.club.total !== v.rival.total) {
      const [won, lost] = v.club.total > v.rival.total ? [v.club, v.rival] : [v.rival, v.club];
      const [done] = await q('SELECT 1 FROM activity WHERE dedupe = $1', [`goal:${g.id}:versus`]);
      if (!done) {
        await social.record(q, { ...base, dedupe: `goal:${g.id}:versus`, org: won.id, data: { ...data, club: won.name, slug: won.slug, rival: lost.name, value: won.total, against: lost.total } });
        await notify.send(q, { users: v.board.filter((p) => p.side === won.id && p.value > 0).map((p) => p.id), kind: 'goal', dedupe: `goal:${g.id}`, title: `🏆 ${won.name} beat ${lost.name}`, body: `${won.total} to ${lost.total} ${g.metric}.`, url: `/goals/${g.id}` });
      }
    }
  }

  // Mine: goals I'm in (personal, or through my clubs), newest first.
  async function mine(actor) {
    const me = needUser(actor);
    const rows = await db.query(
      `SELECT DISTINCT g.id, g.ends_at FROM goals g
       LEFT JOIN goal_members gm ON gm.goal_id = g.id AND gm.user_id = $1
       LEFT JOIN club_members cm ON cm.user_id = $1 AND cm.status = 'active' AND cm.org_id IN (g.org_id, g.rival_id)
       WHERE gm.user_id IS NOT NULL OR cm.user_id IS NOT NULL
       ORDER BY g.ends_at DESC LIMIT 30`,
      [me.id],
    );
    const list = [];
    for (const r of rows) list.push(await get(r.id, actor));
    return { active: list.filter((g) => !g.ended), past: list.filter((g) => g.ended) };
  }
  // A club's goals (its page).
  async function forClub(slug, actor) {
    const o = await clubBySlug(db.query, slug);
    const rows = await db.query(`SELECT id FROM goals WHERE (org_id = $1 OR rival_id = $1) AND ends_at > now() - interval '14 days' ORDER BY ends_at`, [o.id]);
    const list = [];
    for (const r of rows) list.push(await get(r.id, actor));
    return list;
  }

  async function join(id, actor) {
    const me = needUser(actor);
    const g = await load(db.query, id);
    if (g.scope !== 'personal') fail(409, 'Club goals count every member — join the club');
    if (ms(g.ends_at) <= Date.now()) fail(409, 'This goal is over');
    await db.query('INSERT INTO goal_members (goal_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [g.id, me.id]);
    return get(g.id, actor);
  }
  async function leave(id, actor) {
    const me = needUser(actor);
    await db.query('DELETE FROM goal_members WHERE goal_id = $1 AND user_id = $2', [Number(id) || 0, me.id]);
    return get(id, actor);
  }

  return { create, get, mine, forClub, join, leave, counts };
}

module.exports = { createGoals };
