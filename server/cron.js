'use strict';

// Scheduled jobs: Vercel Cron calls /api/cron/<job> (see vercel.json) with
// "Authorization: Bearer <CRON_SECRET>"; a site admin can run one by hand.
// Every job is safe to run twice, and each run is recorded in cron_runs.
//   hourly     settle what's due: challenge results confirmed after a day,
//              unanswered challenges and ladder forfeits, club challenges
//              expired, goal badges for goals that ended
//   weekly     the admins' summary email (Mondays): this week against last
//   reminders  the day before: tournaments, races, meets, group sessions
//              and club runs tomorrow (daily, 6 pm India time)

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

  // The day before: everyone in something tomorrow (India time) is reminded,
  // once each (the dedupe). Tournaments (players, and a note for the
  // organisers), races and meets (entrants), group sessions (those who said
  // they're in) and club runs (those going).
  async function reminders() {
    const [{ day }] = await db.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date + 1, 'YYYY-MM-DD') AS day`);
    const tomorrow = `((%s) AT TIME ZONE 'Asia/Kolkata')::date = $1::date`;
    const on = (col) => tomorrow.replace('%s', col);
    const clock = (hhmm) => {
      if (!hhmm) return null;
      const [h, m] = String(hhmm).split(':').map(Number);
      return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
    };
    const timeOf = (at) => new Date(at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).replace(/:00(?= )/, '').toLowerCase();
    const out = { day, tournaments: 0, races: 0, meets: 0, groups: 0, clubRuns: 0 };
    const tell = async (key, users, n) => {
      const sent = await svc.notify.send(db.query, { users, kind: 'reminder', dedupe: `reminder:${n.dedupe}:${day}`, title: n.title, body: n.body, url: n.url });
      out[key] += sent.length;
    };

    // Tournaments: players (accounts on their entries, still in), and the organisers.
    for (const t of await db.query(
      `SELECT id, name, venue, city, start_time FROM tournaments WHERE starts_on = $1 AND status <> 'completed' AND club_challenge_id IS NULL AND season_id IS NULL`, [day],
    )) {
      const players = await db.query(
        `SELECT DISTINCT u.id FROM entries e LEFT JOIN entry_players p ON p.entry_id = e.id
         JOIN users u ON u.id = e.user_id OR lower(u.email) = lower(p.email)
         WHERE e.tournament_id = $1 AND NOT e.withdrawn AND e.confirmed IS NOT FALSE AND e.paired_into IS NULL`, [t.id]);
      const team = await db.query(`SELECT DISTINCT u.id FROM members m JOIN users u ON lower(u.email) = lower(m.email) WHERE m.tournament_id = $1 AND m.role IN ('owner', 'organiser')`, [t.id]);
      const where = [clock(t.start_time), t.venue || t.city].filter(Boolean).join(' at ');
      const crew = new Set(team.map((r) => r.id));
      await tell('tournaments', players.map((r) => r.id).filter((x) => !crew.has(x)), { dedupe: `t:${t.id}`, title: `Tomorrow: ${t.name}`, body: where ? `${where}. Good luck!` : 'Good luck!', url: `/t/${t.id}` });
      const [{ entries }] = await db.query(`SELECT COUNT(*)::int AS entries FROM entries WHERE tournament_id = $1 AND NOT withdrawn AND paired_into IS NULL`, [t.id]);
      await tell('tournaments', [...crew], { dedupe: `t:${t.id}:org`, title: `Tomorrow: ${t.name}`, body: `${entries} entr${entries === 1 ? 'y' : 'ies'}${where ? ` · ${where}` : ''}. Check-in, the draw and courts are on the tournament page.`, url: `/t/${t.id}` });
    }
    // Races and meets: whoever's entered.
    for (const r of await db.query(`SELECT id, name, place, starts_at FROM races WHERE ${on('starts_at')} AND status <> 'done'`, [day])) {
      const users = (await db.query('SELECT DISTINCT user_id AS id FROM race_entries WHERE race_id = $1 AND user_id IS NOT NULL', [r.id])).map((x) => x.id);
      await tell('races', users, { dedupe: `race:${r.id}`, title: `Tomorrow: ${r.name}`, body: `${timeOf(r.starts_at)} at ${r.place}. Your bib number is on the race page.`, url: `/race/${r.id}` });
    }
    for (const m of await db.query(`SELECT id, name, place, starts_at FROM meets WHERE ${on('starts_at')} AND status <> 'done'`, [day])) {
      const users = (await db.query('SELECT DISTINCT user_id AS id FROM meet_entries WHERE meet_id = $1 AND user_id IS NOT NULL', [m.id])).map((x) => x.id);
      await tell('meets', users, { dedupe: `meet:${m.id}`, title: `Tomorrow: ${m.name}`, body: `${timeOf(m.starts_at)} at ${m.place}. Heats and lanes are on the meet page.`, url: `/meet/${m.id}` });
    }
    // Group sessions: those who said they're in.
    for (const g of await db.query(
      `SELECT s.id, s.starts_at, g.name, g.slug, g.venue FROM group_sessions s JOIN groups g ON g.id = s.group_id WHERE ${on('s.starts_at')}`, [day],
    )) {
      const users = (await db.query(`SELECT user_id AS id FROM session_players WHERE session_id = $1 AND status = 'in'`, [g.id])).map((x) => x.id);
      await tell('groups', users, { dedupe: `session:${g.id}`, title: `Tomorrow: ${g.name}`, body: `${timeOf(g.starts_at)}${g.venue ? ` at ${g.venue}` : ''}. You said you're in.`, url: `/g/${g.slug}` });
    }
    // Club runs: those going tomorrow.
    for (const c of await db.query(
      `SELECT r.id, r.name, r.at_time, r.place, o.name AS club FROM club_runs r JOIN orgs o ON o.id = r.org_id WHERE r.active AND r.weekday = EXTRACT(DOW FROM $1::date)`, [day],
    )) {
      const users = (await db.query('SELECT user_id AS id FROM club_run_people WHERE club_run_id = $1 AND on_date = $2::date AND going', [c.id, day])).map((x) => x.id);
      await tell('clubRuns', users, { dedupe: `clubrun:${c.id}`, title: `Tomorrow: ${c.club} · ${c.name}`, body: `${clock(c.at_time)} at ${c.place}. See you there!`, url: `/club-run/${c.id}` });
    }
    return out;
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
