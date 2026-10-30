'use strict';

// Motorsport championships (karting and the like). An organiser (or a club's
// admins) sets up a championship with rounds; drivers join with a number
// (and a team), or the organiser adds them. Each round: qualifying times set
// the grid; the race is entered as finishing positions with laps, best lap
// and DNF/DNS/DSQ; finishing the round classifies it, gives points by
// position (25-18-15-12-10-8-6-4-2-1) plus one for the fastest lap inside the
// points, and posts the podium. Standings add up drivers and teams; closing
// the championship crowns the champions.

// Lap times to the thousandth: "48.312", "1:02.450".
function lapTime(value) {
  const parts = String(value ?? '').trim().split(':');
  if (!parts.length || parts.length > 2 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.length === 2 && n[1] >= 60) return null;
  const s = n.reduce((sum, x) => sum * 60 + x, 0);
  return s > 0 && s < 3600 ? Math.round(s * 1000) / 1000 : null;
}
function showLap(value) {
  if (value == null) return null;
  const x = Number(value);
  const m = Math.floor(x / 60);
  const s = (x - m * 60).toFixed(3);
  return m ? `${m}:${s.padStart(6, '0')}` : s;
}

function createChamps({ db, fail, text, social, notify }) {
  const needUser = (actor) => { if (!actor?.user) fail(401, 'Sign in first'); return actor.user; };

  async function load(q, id, { lock = false } = {}) {
    const [c] = await q(`SELECT * FROM champs WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [Number(id) || 0]);
    if (!c) fail(404, 'Championship not found');
    return c;
  }
  async function canManage(q, c, actor) {
    if (!actor?.user) return false;
    if (actor.user.isAdmin || c.created_by === actor.user.id) return true;
    if (!c.org_id) return false;
    const [x] = await q(`SELECT 1 FROM club_members WHERE org_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'`, [c.org_id, actor.user.id]);
    return Boolean(x);
  }
  async function manage(q, id, actor) {
    const c = await load(q, id, { lock: true });
    if (!(await canManage(q, c, actor))) fail(actor?.user ? 403 : 401, 'Only the championship\'s organisers can do that');
    return c;
  }
  async function roundOf(q, c, roundId) {
    const [r] = await q('SELECT * FROM champ_rounds WHERE id = $1 AND champ_id = $2', [Number(roundId) || 0, c.id]);
    if (!r) fail(404, 'Round not found');
    return r;
  }

  // ---------- setting up

  // rounds: [{ name, place, startsAt }]
  function readRounds(list) {
    const rounds = (Array.isArray(list) ? list : []).map((r, i) => {
      const at = r.startsAt ? new Date(r.startsAt) : null;
      if (at && Number.isNaN(at.getTime())) fail(400, `Round ${i + 1}: pick a date`);
      return { name: text(r.name || `Round ${i + 1}`, 'Round', { max: 60 }), place: text(r.place, 'Track', { max: 80, optional: true }) || null, at };
    });
    if (rounds.length > 30) fail(400, 'Up to 30 rounds');
    return rounds;
  }
  async function create(actor, input = {}) {
    const me = needUser(actor);
    const name = text(input.name, 'Championship name', { max: 80 });
    const series = text(input.series, 'Class', { max: 60, optional: true }) || null;
    const rounds = readRounds(input.rounds);
    if (!rounds.length) fail(400, 'Add at least one round');
    let orgId = null;
    if (input.club) {
      const [o] = await db.query('SELECT id FROM orgs WHERE slug = $1', [String(input.club).toLowerCase()]);
      if (!o) fail(404, 'Club not found');
      const [x] = await db.query(`SELECT 1 FROM club_members WHERE org_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'`, [o.id, me.id]);
      if (!x && !me.isAdmin) fail(403, 'Only the club\'s admins can run a championship for it');
      orgId = o.id;
    }
    const id = await db.tx(async (q) => {
      const [c] = await q('INSERT INTO champs (name, series, org_id, visibility, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id', [name, series, orgId, input.visibility === 'link' ? 'link' : 'public', me.id]);
      for (const [i, r] of rounds.entries()) await q('INSERT INTO champ_rounds (champ_id, name, place, starts_at, position) VALUES ($1, $2, $3, $4, $5)', [c.id, r.name, r.place, r.at && r.at.toISOString(), i]);
      return c.id;
    });
    return get(id, actor);
  }
  async function addRound(id, actor, input = {}) {
    await db.tx(async (q) => {
      const c = await manage(q, id, actor);
      if (c.status === 'done') fail(409, 'The championship is over');
      const [r] = readRounds([input]);
      const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM champ_rounds WHERE champ_id = $1', [c.id]);
      if (n >= 30) fail(409, 'Up to 30 rounds');
      await q('INSERT INTO champ_rounds (champ_id, name, place, starts_at, position) VALUES ($1, $2, $3, $4, $5)', [c.id, input.name ? r.name : `Round ${n + 1}`, r.place, r.at && r.at.toISOString(), n]);
    });
    return get(id, actor);
  }

  // ---------- drivers

  async function addDriver(q, c, { name, number, team, userId = null }) {
    const n = number == null || number === '' ? null : Number(number);
    let num = n;
    if (num == null) {
      const used = new Set((await q('SELECT number FROM champ_drivers WHERE champ_id = $1', [c.id])).map((r) => r.number));
      num = 2;
      while (used.has(num)) num += 1;
    }
    if (!(Number.isInteger(num) && num >= 0 && num <= 999)) fail(400, 'Number: 0 to 999');
    const [taken] = await q('SELECT name FROM champ_drivers WHERE champ_id = $1 AND number = $2', [c.id, num]);
    if (taken) fail(409, `#${num} is taken by ${taken.name}`);
    if (userId) {
      const [dup] = await q('SELECT 1 FROM champ_drivers WHERE champ_id = $1 AND user_id = $2', [c.id, userId]);
      if (dup) fail(409, 'You\'re already in');
    }
    const [{ n: count }] = await q('SELECT COUNT(*)::int AS n FROM champ_drivers WHERE champ_id = $1', [c.id]);
    if (count >= 80) fail(409, 'Up to 80 drivers');
    await q('INSERT INTO champ_drivers (champ_id, user_id, name, number, team) VALUES ($1, $2, $3, $4, $5)', [c.id, userId, name, num, team || null]);
  }
  async function join(id, actor, { number, team } = {}) {
    const me = needUser(actor);
    await db.tx(async (q) => {
      const c = await load(q, id, { lock: true });
      if (c.status === 'done') fail(409, 'The championship is over');
      await addDriver(q, c, { name: me.name, number, team: text(team, 'Team', { max: 60, optional: true }), userId: me.id });
    });
    return get(id, actor);
  }
  // The organiser adds drivers: one per line, "Number, Name, Team, email".
  async function addDrivers(id, actor, { drivers } = {}) {
    await db.tx(async (q) => {
      const c = await manage(q, id, actor);
      const lines = String(drivers || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (!lines.length) fail(400, 'One driver per line: Number, Name, Team');
      for (const line of lines) {
        const [num, rawName, team, email] = line.split(',').map((x) => x.trim());
        const [u] = email ? await q('SELECT id FROM users WHERE lower(email) = lower($1)', [email]) : [];
        await addDriver(q, c, { name: text(rawName, 'Name', { max: 60 }), number: num, team: team ? team.slice(0, 60) : null, userId: u ? u.id : null });
      }
    });
    return get(id, actor);
  }

  // ---------- a round

  // Qualifying: { times: [{ driver, time }] } — best laps.
  async function qualifying(id, actor, roundId, { times } = {}) {
    await db.tx(async (q) => {
      const c = await manage(q, id, actor);
      const r = await roundOf(q, c, roundId);
      if (r.stage !== 'qualifying') fail(409, 'Qualifying is over for this round');
      for (const t of Array.isArray(times) ? times : []) {
        const [d] = await q('SELECT id, name FROM champ_drivers WHERE id = $1 AND champ_id = $2', [Number(t.driver) || 0, c.id]);
        if (!d) fail(400, 'That driver isn\'t in this championship');
        const v = t.time == null || t.time === '' ? null : lapTime(t.time);
        if (t.time && v == null) fail(400, `${d.name}: a lap time like 48.312 or 1:02.45`);
        await q(
          `INSERT INTO champ_results (round_id, driver_id, quali_s) VALUES ($1, $2, $3)
           ON CONFLICT (round_id, driver_id) DO UPDATE SET quali_s = EXCLUDED.quali_s`,
          [r.id, d.id, v],
        );
      }
    });
    return get(id, actor);
  }
  // The grid: fastest first; no time, at the back (by number).
  async function setGrid(id, actor, roundId) {
    await db.tx(async (q) => {
      const c = await manage(q, id, actor);
      const r = await roundOf(q, c, roundId);
      if (r.stage !== 'qualifying') fail(409, 'The grid is set');
      const drivers = await q('SELECT d.id, d.number, x.quali_s FROM champ_drivers d LEFT JOIN champ_results x ON x.driver_id = d.id AND x.round_id = $2 WHERE d.champ_id = $1', [c.id, r.id]);
      if (drivers.length < 2) fail(400, 'Add at least 2 drivers');
      drivers.sort((a, b) => (a.quali_s == null) - (b.quali_s == null) || Number(a.quali_s) - Number(b.quali_s) || a.number - b.number);
      for (const [i, d] of drivers.entries()) {
        await q(
          `INSERT INTO champ_results (round_id, driver_id, grid) VALUES ($1, $2, $3)
           ON CONFLICT (round_id, driver_id) DO UPDATE SET grid = EXCLUDED.grid`,
          [r.id, d.id, i + 1],
        );
      }
      await q(`UPDATE champ_rounds SET stage = 'race' WHERE id = $1`, [r.id]);
    });
    return get(id, actor);
  }
  // The race: { results: [{ driver, finish, laps, bestLap, status }] }.
  async function race(id, actor, roundId, { results } = {}) {
    await db.tx(async (q) => {
      const c = await manage(q, id, actor);
      const r = await roundOf(q, c, roundId);
      if (r.stage !== 'race') fail(409, r.stage === 'done' ? 'This round is finished — reopen it to make changes' : 'Set the grid first');
      for (const x of Array.isArray(results) ? results : []) {
        const [d] = await q('SELECT d.id, d.name FROM champ_drivers d JOIN champ_results cr ON cr.driver_id = d.id AND cr.round_id = $2 WHERE d.id = $1', [Number(x.driver) || 0, r.id]);
        if (!d) fail(400, 'That driver isn\'t on the grid');
        const status = ['dnf', 'dns', 'dsq'].includes(x.status) ? x.status : 'ok';
        const finish = x.finish === '' || x.finish == null ? null : Number(x.finish);
        if (finish != null && !(Number.isInteger(finish) && finish >= 1 && finish <= 80)) fail(400, `${d.name}: a finishing position`);
        const laps = x.laps === '' || x.laps == null ? null : Number(x.laps);
        if (laps != null && !(Number.isInteger(laps) && laps >= 0 && laps <= 999)) fail(400, `${d.name}: laps`);
        const best = x.bestLap ? lapTime(x.bestLap) : null;
        if (x.bestLap && best == null) fail(400, `${d.name}: a lap time like 48.312`);
        await q('UPDATE champ_results SET finish = $1, laps = $2, best_lap_s = $3, status = $4 WHERE round_id = $5 AND driver_id = $6', [finish, laps, best, status, r.id, d.id]);
      }
    });
    return get(id, actor);
  }

  // Classify: finishers by position (then most laps); DNFs after them by laps;
  // DNS and DSQ unclassified. Points by position; the fastest lap in the points.
  async function finishRound(id, actor, roundId) {
    await db.tx(async (q) => {
      const c = await manage(q, id, actor);
      const r = await roundOf(q, c, roundId);
      if (r.stage !== 'race') fail(409, 'Set the grid and enter the race first');
      const rows = await q('SELECT x.*, d.name, d.user_id, d.team, d.number FROM champ_results x JOIN champ_drivers d ON d.id = x.driver_id WHERE x.round_id = $1', [r.id]);
      const ok = rows.filter((x) => x.status === 'ok' && x.finish != null);
      if (!ok.length) fail(400, 'Enter the finishing positions first');
      const seen = new Set();
      for (const x of ok) {
        if (seen.has(x.finish)) fail(400, `Two drivers finished P${x.finish}`);
        seen.add(x.finish);
      }
      ok.sort((a, b) => a.finish - b.finish);
      const dnf = rows.filter((x) => x.status === 'dnf').sort((a, b) => (b.laps || 0) - (a.laps || 0) || a.grid - b.grid);
      const classified = [...ok, ...dnf];
      const pts = c.points || [];
      const scoring = ok.slice(0, pts.length);
      const fastest = [...scoring].filter((x) => x.best_lap_s != null).sort((a, b) => Number(a.best_lap_s) - Number(b.best_lap_s))[0];
      await q('UPDATE champ_results SET position = NULL, points = 0, fastest = false WHERE round_id = $1', [r.id]);
      for (const [i, x] of classified.entries()) {
        const p = x.status === 'ok' ? (pts[i] || 0) + (fastest && fastest.driver_id === x.driver_id ? c.fastest_lap : 0) : 0;
        await q('UPDATE champ_results SET position = $1, points = $2, fastest = $3 WHERE round_id = $4 AND driver_id = $5', [i + 1, p, Boolean(fastest && fastest.driver_id === x.driver_id), r.id, x.driver_id]);
      }
      await q(`UPDATE champ_rounds SET stage = 'done' WHERE id = $1`, [r.id]);
      // The podium in the feed; every linked driver told.
      const table = await standings(q, c);
      for (const [i, x] of ok.slice(0, 3).entries()) {
        if (!x.user_id) continue;
        const [u] = await q('SELECT profile_public FROM users WHERE id = $1', [x.user_id]);
        const lead = table.drivers.findIndex((d) => d.id === x.driver_id) + 1;
        await social.record(q, {
          dedupe: `champ:${r.id}:${x.driver_id}`, actor: x.user_id, org: c.org_id, sport: 'motorsport', verb: 'motor', object: ['champ', c.id],
          data: { champ: c.id, name: c.name, round: r.name, place: i + 1, of: classified.length, grid: x.grid, number: x.number, team: x.team, fastest: Boolean(fastest && fastest.driver_id === x.driver_id), standing: lead },
          visibility: c.visibility === 'public' && u.profile_public ? 'public' : 'followers',
        });
      }
      const users = rows.map((x) => x.user_id).filter(Boolean);
      await notify.send(q, { users, kind: 'race', dedupe: `champ:${r.id}:done`, title: `🏁 ${c.name}: ${r.name} results`, body: `${ok[0].name} won. See the standings.`, url: `/champ/${c.id}?round=${r.id}` });
    });
    return get(id, actor);
  }
  async function reopenRound(id, actor, roundId) {
    await db.tx(async (q) => {
      const c = await manage(q, id, actor);
      const r = await roundOf(q, c, roundId);
      if (r.stage !== 'done') fail(409, 'It isn\'t finished');
      if (c.status === 'done') fail(409, 'The championship is over');
      await q('UPDATE champ_results SET position = NULL, points = 0, fastest = false WHERE round_id = $1', [r.id]);
      await q(`UPDATE champ_rounds SET stage = 'race' WHERE id = $1`, [r.id]);
      await q('DELETE FROM activity WHERE dedupe LIKE $1', [`champ:${r.id}:%`]);
    });
    return get(id, actor);
  }

  // Close the championship: the champions (driver and team) in the feed.
  async function close(id, actor) {
    await db.tx(async (q) => {
      const c = await manage(q, id, actor);
      if (c.status === 'done') fail(409, 'Already closed');
      const t = await standings(q, c);
      if (!t.drivers.length || !t.drivers[0].points) fail(400, 'Finish a round first');
      await q(`UPDATE champs SET status = 'done' WHERE id = $1`, [c.id]);
      const champ = t.drivers[0];
      const [d] = await q('SELECT user_id FROM champ_drivers WHERE id = $1', [champ.id]);
      await social.record(q, {
        dedupe: `champ:${c.id}:champion`, actor: d.user_id || c.created_by, people: d.user_id ? [d.user_id] : [], org: c.org_id, sport: 'motorsport', verb: 'motor_champ', object: ['champ', c.id],
        data: { champ: c.id, name: c.name, driver: champ.name, number: champ.number, points: champ.points, wins: champ.wins, team: t.teams[0] ? t.teams[0].team : null, teamPoints: t.teams[0] ? t.teams[0].points : null },
        visibility: c.visibility === 'public' ? 'public' : 'followers',
      });
      const users = (await q('SELECT user_id FROM champ_drivers WHERE champ_id = $1 AND user_id IS NOT NULL', [c.id])).map((x) => x.user_id);
      await notify.send(q, { users, kind: 'race', dedupe: `champ:${c.id}:closed`, title: `🏆 ${champ.name} is the ${c.name} champion`, body: 'See the final standings.', url: `/champ/${c.id}` });
    });
    return get(id, actor);
  }

  // ---------- standings

  async function standings(q, c) {
    const drivers = await q('SELECT * FROM champ_drivers WHERE champ_id = $1', [c.id]);
    const rows = await q(
      `SELECT x.* FROM champ_results x JOIN champ_rounds r ON r.id = x.round_id WHERE r.champ_id = $1 AND r.stage = 'done'`,
      [c.id],
    );
    const table = drivers.map((d) => {
      const mine = rows.filter((x) => x.driver_id === d.id);
      return {
        id: d.id, name: d.name, number: d.number, team: d.team, userId: d.user_id,
        points: mine.reduce((s, x) => s + x.points, 0),
        wins: mine.filter((x) => x.position === 1 && x.status === 'ok').length,
        podiums: mine.filter((x) => x.position <= 3 && x.status === 'ok').length,
        best: Math.min(...mine.filter((x) => x.position).map((x) => x.position), 999),
      };
    }).sort((a, b) => b.points - a.points || b.wins - a.wins || b.podiums - a.podiums || a.best - b.best || a.number - b.number);
    const teams = new Map();
    for (const d of table.filter((x) => x.team)) {
      const t = teams.get(d.team) || { team: d.team, points: 0, wins: 0 };
      t.points += d.points;
      t.wins += d.wins;
      teams.set(d.team, t);
    }
    return { drivers: table, teams: [...teams.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || a.team.localeCompare(b.team)) };
  }

  // ---------- reading

  async function get(id, actor) {
    const q = db.query;
    const c = await load(q, id);
    const can = await canManage(q, c, actor);
    const me = actor?.user?.id;
    const rounds = await q('SELECT * FROM champ_rounds WHERE champ_id = $1 ORDER BY position, id', [c.id]);
    const results = await q(
      `SELECT x.*, d.name, d.number, d.team, d.user_id, u.handle, u.profile_public FROM champ_results x JOIN champ_drivers d ON d.id = x.driver_id
       LEFT JOIN users u ON u.id = d.user_id WHERE x.round_id = ANY($1::int[])`,
      [rounds.map((r) => r.id)],
    );
    const drivers = await q('SELECT d.*, u.handle, u.profile_public FROM champ_drivers d LEFT JOIN users u ON u.id = d.user_id WHERE d.champ_id = $1 ORDER BY d.number', [c.id]);
    const t = await standings(q, c);
    const [club] = c.org_id ? await q('SELECT name, slug FROM orgs WHERE id = $1', [c.org_id]) : [];
    const handleOf = (x) => (x.profile_public ? x.handle : null);
    return {
      id: c.id, name: c.name, series: c.series, status: c.status, points: c.points, fastestLap: c.fastest_lap, club: club || null,
      drivers: drivers.map((d) => ({ id: d.id, name: d.name, number: d.number, team: d.team, handle: handleOf(d), me: d.user_id === me })),
      standings: t.drivers.map(({ userId, best, ...d }) => ({ ...d, me: userId === me })),
      teams: t.teams,
      rounds: rounds.map((r) => {
        const mine = results.filter((x) => x.round_id === r.id);
        const row = (x) => ({
          driver: x.driver_id, name: x.name, number: x.number, team: x.team, handle: handleOf(x), me: x.user_id === me,
          quali: showLap(x.quali_s), grid: x.grid, finish: x.finish, laps: x.laps, bestLap: showLap(x.best_lap_s), status: x.status,
          position: x.position, points: x.points, fastest: x.fastest,
        });
        const winner = mine.find((x) => x.position === 1 && x.status === 'ok');
        return {
          id: r.id, name: r.name, place: r.place, startsAt: r.starts_at, stage: r.stage,
          qualifying: mine.filter((x) => x.quali_s != null).sort((a, b) => Number(a.quali_s) - Number(b.quali_s)).map(row),
          grid: mine.filter((x) => x.grid != null).sort((a, b) => a.grid - b.grid).map(row),
          results: r.stage === 'done' ? [...mine.filter((x) => x.position).sort((a, b) => a.position - b.position), ...mine.filter((x) => !x.position && x.grid)].map(row) : [],
          winner: winner ? winner.name : null,
        };
      }),
      can: { manage: can, join: Boolean(me) && c.status !== 'done' && !drivers.some((d) => d.user_id === me) },
    };
  }

  async function list(actor) {
    const me = actor?.user?.id || 0;
    const rows = await db.query(
      `SELECT c.*, (SELECT COUNT(*)::int FROM champ_drivers d WHERE d.champ_id = c.id) AS drivers,
              (SELECT COUNT(*)::int FROM champ_rounds r WHERE r.champ_id = c.id) AS rounds,
              (SELECT COUNT(*)::int FROM champ_rounds r WHERE r.champ_id = c.id AND r.stage = 'done') AS done,
              EXISTS (SELECT 1 FROM champ_drivers d WHERE d.champ_id = c.id AND d.user_id = $1) AS mine
       FROM champs c WHERE c.visibility = 'public' OR c.created_by = $1 OR EXISTS (SELECT 1 FROM champ_drivers d WHERE d.champ_id = c.id AND d.user_id = $1)
       ORDER BY c.status = 'done', c.created_at DESC LIMIT 100`,
      [me],
    );
    return rows.map((c) => ({ id: c.id, name: c.name, series: c.series, status: c.status, drivers: c.drivers, rounds: c.rounds, done: c.done, mine: c.mine }));
  }

  async function card(id) {
    const [c] = await db.query('SELECT * FROM champs WHERE id = $1', [Number(id) || 0]);
    if (!c) return null;
    const t = await standings(db.query, c);
    const [{ n, done }] = await db.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE stage = 'done')::int AS done FROM champ_rounds WHERE champ_id = $1`, [c.id]);
    return {
      eyebrow: [c.series || 'Motorsport', c.status === 'done' ? 'Final standings' : `After round ${done} of ${n}`].join(' · '),
      title: c.name,
      subtitle: c.status === 'done' && t.drivers[0] ? `${t.drivers[0].name} is the champion` : `${t.drivers.length} drivers`,
      lines: t.drivers.slice(0, 5).map((d) => ({ name: `#${d.number} ${d.name}`, value: `${d.points} pts` })),
    };
  }

  return { create, addRound, join, addDrivers, qualifying, setGrid, race, finishRound, reopenRound, close, get, list, card };
}

module.exports = { createChamps, lapTime, showLap };
