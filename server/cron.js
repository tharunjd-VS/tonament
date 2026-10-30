'use strict';

// Scheduled jobs: Vercel Cron calls /api/cron/<job> (see vercel.json) with
// "Authorization: Bearer <CRON_SECRET>"; a site admin can run one by hand.
// Every job is safe to run twice, and each run is recorded in cron_runs.
//   hourly     settle what's due: challenge results confirmed after a day,
//              unanswered challenges and ladder forfeits, club challenges
//              expired, goal badges for goals that ended
//   weekly     the admins' summary email (Mondays): this week against last
//   reminders  (next: the day-before reminders)

const crypto = require('node:crypto');
const { adminWeeklyEmail } = require('./email');

const BATCH = 300;

function createCron({ db, svc, fail, baseUrl = 'https://tonament.com', env = process.env }) {
  // The secret Vercel sends, or a site admin.
  function allowed(req, actor) {
    if (actor?.user?.isAdmin) return true;
    const secret = env.CRON_SECRET;
    const got = String(req?.headers?.authorization || '');
    if (!secret || !got.startsWith('Bearer ')) return false;
    const a = Buffer.from(got.slice(7));
    const b = Buffer.from(secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function hourly() {
    const out = { challenges: 0, clubChallenges: 0, goals: 0 };
    const due = await db.query(`SELECT id FROM challenges WHERE status IN ('sent', 'done') ORDER BY id LIMIT ${BATCH}`);
    for (const { id } of due) {
      const before = (await db.query('SELECT status FROM challenges WHERE id = $1', [id]))[0]?.status;
      const x = await db.tx(async (q) => svc.challenges.settle(q, await svc.challenges.load(q, id, { lock: true })));
      if (x && x.status !== before) out.challenges += 1;
    }
    const expired = await svc.clubChallenges.expire();
    out.clubChallenges = Array.isArray(expired) ? expired.length : 0;
    // Goals that ended in the last few days: reading one awards its badges.
    const goals = await db.query(`SELECT id FROM goals WHERE ends_at <= now() AND ends_at > now() - interval '3 days' ORDER BY id LIMIT ${BATCH}`);
    for (const { id } of goals) {
      await svc.goals.get(id, null).catch((err) => console.error(`Goal ${id}:`, err.message));
      out.goals += 1;
    }
    return out;
  }

  // This week against last week, emailed to every site admin.
  async function weekly({ force = false } = {}) {
    if (!force) {
      const [recent] = await db.query(`SELECT 1 FROM cron_runs WHERE job = 'weekly' AND ok AND (detail->>'sent')::int > 0 AND started_at > now() - interval '6 days'`);
      if (recent) return { skipped: 'already sent this week' };
    }
    const week = (sql) => db.query(`SELECT
        (${sql.replaceAll('$FROM', "now() - interval '7 days'").replaceAll('$TO', 'now()')})::int AS now,
        (${sql.replaceAll('$FROM', "now() - interval '14 days'").replaceAll('$TO', "now() - interval '7 days'")})::int AS before`).then(([r]) => [r.now, r.before]);
    const between = (col) => `${col} > $FROM AND ${col} <= $TO`;
    const own = "club_challenge_id IS NULL AND season_id IS NULL";
    const metrics = [
      ['Sign-ups', `SELECT COUNT(*) FROM users WHERE NOT guest AND ${between('created_at')}`],
      ['Tournaments created', `SELECT COUNT(*) FROM tournaments WHERE ${own} AND ${between('created_at')}`],
      ['New organisers', `SELECT COUNT(*) FROM (SELECT m.email FROM members m JOIN tournaments t ON t.id = m.tournament_id WHERE m.role = 'owner' AND t.${own.replace(' AND ', ' AND t.')} GROUP BY m.email HAVING ${between('MIN(t.created_at)')}) x`],
      ['Entries', `SELECT COUNT(*) FROM entries WHERE ${between('created_at')}`],
      ['Clubs created', `SELECT COUNT(*) FROM orgs WHERE ${between('created_at')}`],
      ['Group games', `SELECT COUNT(*) FROM group_games WHERE ${between('started_at')}`],
      ['Challenges', `SELECT COUNT(*) FROM challenges WHERE ${between('created_at')}`],
      ['Runs logged', `SELECT COUNT(*) FROM runs WHERE ${between('created_at')}`],
      ['Revenue (₹)', `SELECT COALESCE(SUM(amount - COALESCE(refunded_amount, 0)), 0) / 100 FROM payments WHERE status IN ('paid', 'refunded') AND ${between('paid_at')}`],
    ];
    const rows = [];
    for (const [label, sql] of metrics) rows.push([label, ...(await week(sql))]);
    const sources = await db.query(`SELECT COALESCE(source->>'class', 'unknown') AS class, COUNT(*)::int AS n FROM users
      WHERE NOT guest AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY n DESC LIMIT 5`);
    const notes = sources.length ? [`Where sign-ups came from: ${sources.map((r) => `${r.class} ${r.n}`).join(', ')}.`] : [];
    const mail = adminWeeklyEmail({ rows, notes, url: `${baseUrl}/admin` });
    const admins = new Set((env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
    const people = await db.query('SELECT id, email FROM users WHERE (is_admin OR lower(email) = ANY($1::text[])) AND disabled_at IS NULL', [[...admins]]);
    const to = new Map(people.map((p) => [p.email.toLowerCase(), p]));
    for (const email of admins) if (!to.has(email)) to.set(email, null);
    let sent = 0;
    for (const [email, person] of to) {
      const r = await svc.messaging.send(db.query, { user: person || null, to: { email }, template: 'admin.weekly', data: mail, channels: ['email'] });
      if (r.some((x) => x.status === 'sent')) sent += 1;
    }
    return { sent, rows };
  }

  // Sprint 2: the day-before reminders.
  async function reminders() {
    return { sent: 0 };
  }

  const JOBS = { hourly, weekly, reminders };

  async function run(job, req, actor, options = {}) {
    if (!JOBS[job]) fail(404, 'No such job');
    if (!allowed(req, actor)) fail(401, 'Not allowed');
    const [r] = await db.query('INSERT INTO cron_runs (job) VALUES ($1) RETURNING id', [job]);
    try {
      const detail = await JOBS[job](options);
      await svc.messaging.flush();
      await db.query('UPDATE cron_runs SET finished_at = now(), ok = true, detail = $2::jsonb WHERE id = $1', [r.id, JSON.stringify(detail)]);
      return { job, ok: true, ...detail };
    } catch (err) {
      await db.query('UPDATE cron_runs SET finished_at = now(), ok = false, detail = $2::jsonb WHERE id = $1', [r.id, JSON.stringify({ error: err.message })]);
      throw err;
    }
  }

  // The admin's view: each job's last run.
  async function status(actor) {
    if (!actor?.user?.isAdmin) fail(actor?.user ? 403 : 401, 'Site admins only');
    const rows = await db.query(`SELECT DISTINCT ON (job) job, started_at AS "at", finished_at AS "finishedAt", ok, detail FROM cron_runs ORDER BY job, id DESC`);
    return { jobs: Object.keys(JOBS).map((job) => rows.find((r) => r.job === job) || { job, at: null }), secret: Boolean(env.CRON_SECRET) };
  }

  return { run, status, JOBS };
}

module.exports = { createCron };
