'use strict';

// Runs: anyone logs a run — distance, time, when (and a name, a place). It
// goes to the feed (to everyone, or to followers; private ones nowhere), with
// kudos, comments and a share card; it counts in "km" and "runs" goals; and
// the fastest pace over at least a standard distance is a best effort.

const DISTANCES = [
  { key: '5k', name: '5K', m: 5000 },
  { key: '10k', name: '10K', m: 10000 },
  { key: 'half', name: 'Half marathon', m: 21097 },
  { key: 'full', name: 'Marathon', m: 42195 },
];
const VISIBILITY = ['public', 'followers', 'private'];
const MAX_M = 300000; // 300 km
const MAX_S = 48 * 3600;

// "5:07" (per km) and "52:10" / "1:45:03".
const clock = (s) => {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const km = (m) => Math.round(m / 10) / 100;
const pace = (r) => clock(r.duration_s / (r.distance_m / 1000));

function createRuns({ db, fail, text, social }) {
  const needUser = (actor) => { if (!actor?.user) fail(401, 'Sign in to log a run'); return actor.user; };

  // "52:10", "1:45:03", or minutes ("52") -> seconds.
  function seconds(value) {
    const v = String(value ?? '').trim();
    if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 60);
    const parts = v.split(':').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some((x) => !Number.isFinite(x) || x < 0) || parts.slice(1).some((x) => x >= 60)) {
      fail(400, 'Time: like 52:10 or 1:45:03');
    }
    return parts.reduce((sum, x) => sum * 60 + x, 0);
  }

  function readRun(input) {
    const distance = Math.round(Number(input.km) * 1000);
    if (!(distance >= 100 && distance <= MAX_M)) fail(400, 'Distance: between 0.1 and 300 km');
    const duration = seconds(input.time);
    if (!(duration >= 30 && duration <= MAX_S)) fail(400, 'Time: between 30 seconds and 48 hours');
    if (duration / (distance / 1000) < 150) fail(400, 'That\'s faster than a world record — check the distance and time');
    const at = input.ranAt ? new Date(input.ranAt) : new Date();
    if (Number.isNaN(at.getTime())) fail(400, 'When: pick a date');
    if (at > Date.now() + 3600000) fail(400, 'That run hasn\'t happened yet');
    if (at < Date.now() - 365 * 86400000) fail(400, 'Runs from the last year only');
    const visibility = VISIBILITY.includes(input.visibility) ? input.visibility : 'public';
    return {
      distance, duration, at, visibility,
      title: text(input.title, 'Name', { max: 80, optional: true }) || null,
      place: text(input.place, 'Where', { max: 80, optional: true }) || null,
    };
  }

  // The best effort at each standard distance (fastest pace over a run at least that long).
  async function bests(q, userId) {
    const out = [];
    for (const d of DISTANCES) {
      const [r] = await q(
        `SELECT * FROM runs WHERE user_id = $1 AND distance_m >= $2 ORDER BY duration_s::float / distance_m, ran_at LIMIT 1`,
        [userId, d.m],
      );
      if (r) out.push({ key: d.key, name: d.name, time: clock((r.duration_s / r.distance_m) * d.m), pace: pace(r), run: r.id, at: r.ran_at });
    }
    return out;
  }

  const view = (r, u) => ({
    id: r.id, km: km(r.distance_m), time: clock(r.duration_s), pace: pace(r), ranAt: r.ran_at, title: r.title, place: r.place, visibility: r.visibility,
    ...(u && { by: { id: u.id, name: u.name, handle: u.handle } }),
  });

  // The feed post for a run (re-made when it's edited; none when private).
  async function post(q, r, u, pbs = []) {
    await social.forget(q, 'run', r.id);
    if (r.visibility === 'private') return;
    await social.record(q, {
      dedupe: `run:${r.id}`, actor: u.id, sport: 'running', verb: 'run', object: ['run', r.id], at: new Date(r.ran_at).toISOString(),
      data: { run: r.id, km: km(r.distance_m), time: clock(r.duration_s), pace: pace(r), title: r.title, place: r.place, pbs },
      visibility: r.visibility === 'public' && u.profile_public ? 'public' : 'followers',
    });
  }

  async function log(actor, input = {}) {
    const me = needUser(actor);
    const x = readRun(input);
    return db.tx(async (q) => {
      const before = await bests(q, me.id);
      const [r] = await q(
        'INSERT INTO runs (user_id, distance_m, duration_s, ran_at, title, place, visibility) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [me.id, x.distance, x.duration, x.at.toISOString(), x.title, x.place, x.visibility],
      );
      // New bests this run set (not the first ever at a distance: that's just a start).
      const after = await bests(q, me.id);
      const pbs = after.filter((b) => b.run === r.id && before.some((p) => p.key === b.key)).map((b) => b.name);
      const [u] = await q('SELECT id, name, handle, profile_public FROM users WHERE id = $1', [me.id]);
      await post(q, r, u, pbs);
      const [a] = await q('SELECT id, visibility FROM activity WHERE dedupe = $1', [`run:${r.id}`]);
      return { ...view(r), pbs, post: a ? { id: a.id, public: a.visibility === 'public' } : null };
    });
  }

  async function own(q, id, actor) {
    const me = needUser(actor);
    const [r] = await q('SELECT * FROM runs WHERE id = $1', [Number(id) || 0]);
    if (!r || r.user_id !== me.id) fail(404, 'Run not found');
    return r;
  }
  async function update(id, actor, input = {}) {
    return db.tx(async (q) => {
      const r = await own(q, id, actor);
      const x = readRun({ km: r.distance_m / 1000, time: String(r.duration_s / 60), ranAt: r.ran_at, title: r.title, place: r.place, visibility: r.visibility, ...input });
      const [row] = await q(
        'UPDATE runs SET distance_m = $1, duration_s = $2, ran_at = $3, title = $4, place = $5, visibility = $6 WHERE id = $7 RETURNING *',
        [x.distance, x.duration, x.at.toISOString(), x.title, x.place, x.visibility, r.id],
      );
      const [u] = await q('SELECT id, name, handle, profile_public FROM users WHERE id = $1', [r.user_id]);
      const [old] = await q(`SELECT data FROM activity WHERE dedupe = $1`, [`run:${r.id}`]);
      await post(q, row, u, (old && old.data.pbs) || []);
      return view(row);
    });
  }
  async function remove(id, actor) {
    await db.tx(async (q) => {
      const r = await own(q, id, actor);
      await social.forget(q, 'run', r.id);
      await q('DELETE FROM runs WHERE id = $1', [r.id]);
    });
    return { ok: true };
  }

  // km and runs since a time.
  const totalSince = async (q, userId, since) => {
    const [t] = await q('SELECT COALESCE(SUM(distance_m), 0)::bigint AS m, COUNT(*)::int AS n, COALESCE(SUM(duration_s), 0)::bigint AS s FROM runs WHERE user_id = $1 AND ran_at >= $2', [userId, since]);
    return { km: km(Number(t.m)), runs: t.n, time: clock(Number(t.s)) };
  };
  // Monday 00:00 IST this week, the 1st of the month, 1 January (as instants).
  function periods(now = new Date()) {
    const ist = new Date(now.getTime() + 5.5 * 3600000);
    const day = (y, m, d) => new Date(Date.UTC(y, m, d) - 5.5 * 3600000);
    const [y, m, d] = [ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()];
    return { week: day(y, m, d - ((ist.getUTCDay() + 6) % 7)), month: day(y, m, 1), year: day(y, 0, 1) };
  }

  // My running: totals, bests, recent runs, and this week with the people I follow.
  async function mine(actor) {
    const me = needUser(actor);
    const q = db.query;
    const p = periods();
    const recent = await q('SELECT * FROM runs WHERE user_id = $1 ORDER BY ran_at DESC LIMIT 20', [me.id]);
    const board = await q(
      `SELECT u.id, u.name, u.handle, SUM(r.distance_m)::bigint AS m, COUNT(*)::int AS n FROM runs r JOIN users u ON u.id = r.user_id
       WHERE r.ran_at >= $2 AND (r.user_id = $1 OR (r.visibility <> 'private' AND r.user_id IN (SELECT target_id::int FROM follows WHERE follower_id = $1 AND kind = 'user')))
         AND r.user_id NOT IN (SELECT blocked_id FROM blocks WHERE user_id = $1 UNION SELECT user_id FROM blocks WHERE blocked_id = $1)
       GROUP BY u.id ORDER BY m DESC LIMIT 20`,
      [me.id, p.week],
    );
    return {
      week: await totalSince(q, me.id, p.week),
      month: await totalSince(q, me.id, p.month),
      year: await totalSince(q, me.id, p.year),
      bests: await bests(q, me.id),
      recent: recent.map((r) => view(r)),
      board: board.map((b) => ({ id: b.id, name: b.name, handle: b.handle, km: km(Number(b.m)), runs: b.n, me: b.id === me.id })),
      distances: DISTANCES.map((d) => d.name),
    };
  }

  // A profile's running (public runs only, unless it's mine).
  async function forUser(userId, actor) {
    const q = db.query;
    const p = periods();
    const self = actor?.user?.id === userId;
    const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM runs WHERE user_id = $1${self ? '' : ` AND visibility = 'public'`}`, [userId]);
    if (!n) return null;
    return { year: await totalSince(q, userId, p.year), bests: await bests(q, userId) };
  }

  // Goals: map userId -> { km, runs } in [from, to).
  async function counts(q, userIds, from, to) {
    if (!userIds.length) return new Map();
    const rows = await q(
      `SELECT user_id AS uid, SUM(distance_m)::bigint AS m, COUNT(*)::int AS n FROM runs
       WHERE user_id = ANY($1::int[]) AND ran_at >= $2 AND ran_at < $3 GROUP BY user_id`,
      [userIds, from, to],
    );
    return new Map(rows.map((r) => [r.uid, { km: Math.floor(Number(r.m) / 1000), runs: r.n }]));
  }

  return { log, update, remove, mine, forUser, counts, clock, DISTANCES };
}

module.exports = { createRuns, clock };
