'use strict';

// Club seasons: a league between clubs, run by a host club. The host's admins
// set it up (sport, and the tie format in racket sports) and share the link;
// other clubs' admins enter their club before it starts and pick their team
// from the club's members. Starting it draws a round robin — every club plays
// every other once — in a link-only league tournament (service.js), so
// fixtures, line-ups, scoring and the table work as in any league. Results go
// on both clubs' feeds as they come in; the champions on everyone's.

const sports = require('./sports');
const TIE = require('../public/sports/tie');

const MAX_CLUBS = 12;
const MAX_TEAM = 30;

// league: { create, enter, leave, roster, info, start } from service.js.
function createSeasons({ db, fail, text, social, notify, kindOf, league }) {
  const sportName = (id) => (sports.get(id) || {}).name || id;
  const needFor = (tie) => {
    if (!tie) return 1;
    const r = TIE.rubbersOf(tie);
    return Math.max(r.filter((x) => x.kind === 'singles').length, 2 * r.filter((x) => x.kind === 'doubles').length);
  };

  async function clubOf(q, slug) {
    const [o] = await q('SELECT * FROM orgs WHERE slug = $1', [String(slug || '').toLowerCase().replace(/^@/, '')]);
    if (!o) fail(404, 'Club not found');
    return o;
  }
  async function adminIds(q, orgId) {
    const rows = await q(
      `SELECT user_id AS id FROM club_members WHERE org_id = $1 AND role = 'admin' AND status = 'active'
       UNION SELECT u.id FROM org_members m JOIN users u ON u.email = m.email WHERE m.org_id = $1`,
      [orgId],
    );
    return rows.map((r) => r.id);
  }
  async function isAdmin(q, orgId, actor) {
    if (!actor?.user) return false;
    if (actor.user.isAdmin) return true;
    return (await adminIds(q, orgId)).includes(actor.user.id);
  }
  async function load(q, id) {
    const [s] = await q('SELECT * FROM seasons WHERE id = $1', [Number(id) || 0]);
    if (!s) fail(404, 'Season not found');
    return s;
  }
  const emailsOf = async (q, ids) => (await q('SELECT email FROM users WHERE id = ANY($1::int[])', [ids])).map((r) => r.email);
  const clubsIn = async (q, s) => q(
    'SELECT o.id, o.name, o.slug FROM entries e JOIN orgs o ON o.id = e.org_id WHERE e.tournament_id = $1 ORDER BY e.seed', [s.tournament_id],
  );

  // ---------- setting one up

  async function create(slug, actor, input = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    const o = await clubOf(db.query, slug);
    if (!(await isAdmin(db.query, o.id, actor))) fail(403, 'Only the club\'s admins can start a season');
    const sport = String(input.sport || '');
    const kind = sports.get(sport) ? kindOf(sport) : null;
    if (!kind) fail(400, 'Pick a racket sport (played as team ties) or a team sport');
    let tie = null;
    if (kind === 'tie') {
      try { tie = TIE.normalize(input.tie || {}); } catch (err) { fail(400, err.message); }
    }
    const name = text(input.name, 'Name', { max: 60, optional: true }) || `${o.name} ${sportName(sport)} League`;
    const tid = await league.create({ actor, name, sport, tie });
    const id = await db.tx(async (q) => {
      const [row] = await q(
        'INSERT INTO seasons (host_org, name, sport, tie, tournament_id, created_by) VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id',
        [o.id, name, sport, tie && JSON.stringify(tie), tid, actor.user.id],
      );
      await q('UPDATE tournaments SET season_id = $1 WHERE id = $2', [row.id, tid]);
      // The host is in from the start.
      await league.enter(q, tid, { name: o.name, orgId: o.id, userId: actor.user.id, emails: await emailsOf(q, await adminIds(q, o.id)), role: 'organiser' });
      return row.id;
    });
    return view(id, actor);
  }

  // Another club enters (its admins, before the start).
  async function enter(id, actor, { club } = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    const s = await load(db.query, id);
    const o = await clubOf(db.query, club);
    if (!(await isAdmin(db.query, o.id, actor))) fail(403, 'Only the club\'s admins can enter it');
    if (s.status !== 'open') fail(409, 'This season has started — entries are closed');
    await db.tx(async (q) => {
      const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM entries WHERE tournament_id = $1', [s.tournament_id]);
      if (n >= MAX_CLUBS) fail(409, `A season can have up to ${MAX_CLUBS} clubs`);
      const [already] = await q('SELECT 1 FROM entries WHERE tournament_id = $1 AND org_id = $2', [s.tournament_id, o.id]);
      if (already) fail(409, `${o.name} is already in`);
      await league.enter(q, s.tournament_id, { name: o.name, orgId: o.id, userId: actor.user.id, emails: await emailsOf(q, await adminIds(q, o.id)) });
      await notify.send(q, {
        users: await adminIds(q, s.host_org), kind: 'season', actor: actor.user.id, dedupe: `season:${s.id}:in:${o.id}`,
        title: `${o.name} entered ${s.name}`, body: 'Start the season when everyone\'s in.', url: `/season/${s.id}`,
      });
    });
    return view(id, actor);
  }

  // A club leaves (its admins), or the host takes it out — before the start.
  async function leave(id, actor, { club } = {}) {
    const s = await load(db.query, id);
    const o = await clubOf(db.query, club);
    if (o.id === s.host_org) fail(400, 'The host club runs the season');
    if (!(await isAdmin(db.query, o.id, actor)) && !(await isAdmin(db.query, s.host_org, actor))) fail(actor?.user ? 403 : 401, 'Only the club\'s admins (or the host\'s) can do that');
    if (s.status !== 'open') fail(409, 'The season has started');
    await db.tx((q) => league.leave(q, s.tournament_id, o.id));
    return view(id, actor);
  }

  // A club's team: club members, the first picked is the captain.
  async function setTeam(id, actor, { club, members } = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    const s = await load(db.query, id);
    const o = await clubOf(db.query, club);
    if (!(await isAdmin(db.query, o.id, actor))) fail(403, 'Only the club\'s admins pick its team');
    if (s.status === 'done') fail(409, 'The season is over');
    const ids = [...new Set((Array.isArray(members) ? members : []).map(Number).filter(Number.isInteger))];
    const need = needFor(s.tie);
    if (ids.length < need) fail(400, `Pick at least ${need} player${need === 1 ? '' : 's'}`);
    if (ids.length > MAX_TEAM) fail(400, `Pick at most ${MAX_TEAM} players`);
    const rows = await db.query(
      `SELECT u.id, u.name, u.email FROM club_members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 AND m.status = 'active' AND u.id = ANY($2::int[])`,
      [o.id, ids],
    );
    if (rows.length !== ids.length) fail(400, 'Pick players from the club\'s members');
    const by = new Map(rows.map((r) => [r.id, r]));
    await league.roster(s.tournament_id, o.id, ids.map((uid, i) => ({ name: by.get(uid).name, email: by.get(uid).email, captain: i === 0 })));
    return view(id, actor);
  }

  async function start(id, actor) {
    const s = await load(db.query, id);
    if (!(await isAdmin(db.query, s.host_org, actor))) fail(actor?.user ? 403 : 401, 'Only the host club\'s admins can start the season');
    if (s.status !== 'open') fail(409, 'The season has already started');
    const info = await league.info(db.query, s.tournament_id);
    if (info.entries.length < 3) fail(400, 'A season needs at least 3 clubs — share the link');
    const short = info.entries.find((e) => e.team.length < needFor(s.tie));
    if (short) fail(400, `${short.name} hasn't picked a team yet`);
    await league.start(s.tournament_id, actor);
    await db.tx(async (q) => {
      await q(`UPDATE seasons SET status = 'on' WHERE id = $1`, [s.id]);
      const clubs = await clubsIn(q, s);
      const rounds = Math.max(...(await league.info(q, s.tournament_id)).fixtures.map((f) => f.round), 0);
      for (const o of clubs) {
        await social.record(q, {
          dedupe: `season:${s.id}:on:${o.id}`, actor: actor.user.id, org: o.id, sport: s.sport, verb: 'season_on', object: ['season', s.id],
          data: { id: s.id, season: s.name, clubs: clubs.length, rounds, kind: kindOf(s.sport) }, visibility: 'club',
        });
      }
      const admins = (await Promise.all(clubs.map((o) => adminIds(q, o.id)))).flat();
      await notify.send(q, { users: admins, kind: 'season', actor: actor.user.id, dedupe: `season:${s.id}:on`, title: `🏁 ${s.name} is on`, body: `${clubs.length} clubs, ${rounds} rounds. Set your line-ups for round 1.`, url: `/season/${s.id}` });
    });
    return view(id, actor);
  }

  // ---------- reading

  async function view(id, actor) {
    const q = db.query;
    const s = await load(q, id);
    const info = await league.info(q, s.tournament_id);
    const [host] = await q('SELECT id, name, slug FROM orgs WHERE id = $1', [s.host_org]);
    const orgs = await q('SELECT id, name, slug FROM orgs WHERE id = ANY($1::int[])', [info.entries.map((e) => e.org)]);
    const slugOf = new Map(orgs.map((o) => [o.id, o.slug]));
    // My clubs: the ones I'm an admin of (to enter, or pick a team for).
    const mine = actor?.user ? await q(
      `SELECT o.id, o.name, o.slug FROM club_members m JOIN orgs o ON o.id = m.org_id
       WHERE m.user_id = $1 AND m.role = 'admin' AND m.status = 'active' ORDER BY o.name`,
      [actor.user.id],
    ) : [];
    const inIds = new Set(info.entries.map((e) => e.org));
    const hostAdmin = await isAdmin(q, s.host_org, actor);
    const pool = (orgId) => q(
      `SELECT u.id, u.name FROM club_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 AND m.status = 'active' ORDER BY lower(u.name)`,
      [orgId],
    );
    const clubs = await Promise.all(info.entries.map(async (e) => {
      const admin = mine.some((o) => o.id === e.org) || Boolean(actor?.user?.isAdmin);
      return {
        name: e.name, slug: slugOf.get(e.org), host: e.org === s.host_org,
        team: e.team.map((p) => ({ name: p.name, captain: p.captain, handle: p.handle })),
        admin,
        members: admin && s.status !== 'done' ? (await pool(e.org)).map((m) => ({ ...m, picked: e.team.some((p) => p.name === m.name) })) : null,
      };
    }));
    const champion = s.champion_org ? orgs.find((o) => o.id === s.champion_org) : null;
    return {
      id: s.id,
      name: s.name,
      sport: { id: s.sport, name: sportName(s.sport) },
      kind: kindOf(s.sport),
      tie: s.tie ? { ...s.tie, name: TIE.formatName(s.tie) } : null,
      need: needFor(s.tie),
      status: s.status,
      host: { name: host.name, slug: host.slug },
      tournamentId: s.tournament_id,
      clubs,
      table: info.table.map((r) => ({ name: r.name, slug: slugOf.get(r.org), played: r.played, won: r.won, drawn: r.drawn || 0, lost: r.lost, points: r.leaguePoints, diff: (r.gamesFor ?? 0) - (r.gamesAgainst ?? 0) })),
      fixtures: info.fixtures.map((f) => ({ id: f.id, round: f.round, status: f.status, summary: f.summary, winner: f.winner, a: f.a && f.a.name, b: f.b && f.b.name })),
      champion: champion ? { name: champion.name, slug: champion.slug } : null,
      can: {
        start: hostAdmin && s.status === 'open',
        enter: s.status === 'open' ? mine.filter((o) => !inIds.has(o.id)).map((o) => ({ name: o.name, slug: o.slug })) : [],
        remove: hostAdmin && s.status === 'open',
      },
    };
  }

  // The seasons a club hosts or plays in.
  async function forClub(slug, actor) {
    const q = db.query;
    const o = await clubOf(q, slug);
    const rows = await q(
      `SELECT s.*, (SELECT COUNT(*)::int FROM entries e WHERE e.tournament_id = s.tournament_id) AS clubs
       FROM seasons s WHERE s.host_org = $1 OR EXISTS (SELECT 1 FROM entries e WHERE e.tournament_id = s.tournament_id AND e.org_id = $1)
       ORDER BY s.status = 'done', s.created_at DESC LIMIT 20`,
      [o.id],
    );
    const items = [];
    for (const s of rows) {
      const info = s.status === 'open' ? null : await league.info(q, s.tournament_id);
      const place = info ? info.table.findIndex((r) => r.org === o.id) : -1;
      items.push({
        id: s.id, name: s.name, sport: { id: s.sport, name: sportName(s.sport) }, status: s.status, clubs: s.clubs,
        place: place >= 0 ? place + 1 : null, champion: s.champion_org === o.id,
      });
    }
    return { admin: await isAdmin(q, o.id, actor), items };
  }

  // ---------- results (from service.js, inside its transaction)

  // A fixture finished (score: { a, b, winner }) or reopened (score false).
  async function matchChanged(q, id, m, score) {
    const s = await load(q, id);
    const key = `season:${s.id}:m:${m.id}`;
    if (!score) {
      await q(`DELETE FROM activity WHERE dedupe LIKE $1`, [`${key}:%`]);
      return;
    }
    const [a] = await q('SELECT o.id, o.name, o.slug, e.id AS entry FROM entries e JOIN orgs o ON o.id = e.org_id WHERE e.id = $1', [m.a_id]);
    const [b] = await q('SELECT o.id, o.name, o.slug, e.id AS entry FROM entries e JOIN orgs o ON o.id = e.org_id WHERE e.id = $1', [m.b_id]);
    if (!a || !b) return;
    const won = score.winner === 'b' ? b : a;
    const lost = score.winner === 'b' ? a : b;
    const line = score.winner === 'b' ? `${score.b}–${score.a}` : `${score.a}–${score.b}`;
    const people = async (entry) => (await q('SELECT DISTINCT u.id FROM entry_players p JOIN users u ON u.email = p.email WHERE p.entry_id = $1', [entry])).map((r) => r.id);
    for (const o of [a, b]) {
      await social.record(q, {
        dedupe: `${key}:${o.id}`, actor: null, people: await people(o.entry), org: o.id, sport: s.sport, verb: 'season_match', object: ['season', s.id],
        data: {
          id: s.id, season: s.name, round: m.round, score: line, kind: kindOf(s.sport),
          winner: score.winner ? won.name : null, winnerSlug: won.slug, loser: score.winner ? lost.name : null, loserSlug: lost.slug,
          a: a.name, aSlug: a.slug, b: b.name, bSlug: b.slug,
        },
        visibility: 'public',
      });
    }
  }

  // The league's status changed: 'done' when every fixture's played.
  async function statusChanged(q, id, status) {
    const s = await load(q, id);
    if (status !== 'done') {
      if (s.status === 'done') {
        await q(`UPDATE seasons SET status = 'on', champion_org = NULL WHERE id = $1`, [s.id]);
        await q(`DELETE FROM activity WHERE dedupe LIKE $1`, [`season:${s.id}:won:%`]);
      }
      return;
    }
    const info = await league.info(q, s.tournament_id);
    const top = info.table[0];
    if (!top) return;
    await q(`UPDATE seasons SET status = 'done', champion_org = $1 WHERE id = $2`, [top.org, s.id]);
    const clubs = await clubsIn(q, s);
    const champ = clubs.find((o) => o.id === top.org);
    const data = { id: s.id, season: s.name, champion: champ.name, slug: champ.slug, won: top.won, played: top.played, points: top.leaguePoints, clubs: clubs.length };
    for (const o of clubs) {
      await social.record(q, {
        dedupe: `season:${s.id}:won:${o.id}`, actor: null, org: o.id, sport: s.sport, verb: 'season_won', object: ['season', s.id],
        data: { ...data, mine: o.id === champ.id }, visibility: 'public',
      });
    }
    const players = (await q(
      `SELECT DISTINCT u.id FROM entries e JOIN entry_players p ON p.entry_id = e.id JOIN users u ON u.email = p.email WHERE e.tournament_id = $1`, [s.tournament_id],
    )).map((r) => r.id);
    const admins = (await Promise.all(clubs.map((o) => adminIds(q, o.id)))).flat();
    await notify.send(q, { users: [...players, ...admins], kind: 'season', dedupe: `season:${s.id}:won`, title: `🏆 ${champ.name} won ${s.name}`, body: `${top.won} wins from ${top.played}. Share the final table.`, url: `/season/${s.id}` });
  }

  // For the share card: the table's top five.
  async function card(id) {
    const [s] = await db.query('SELECT * FROM seasons WHERE id = $1', [Number(id) || 0]);
    if (!s) return null;
    const info = await league.info(db.query, s.tournament_id);
    const eyebrow = `Club season · ${sportName(s.sport)}${s.tie ? ` · ${TIE.formatName(s.tie)}` : ''}`;
    if (s.status === 'open') return { eyebrow, title: s.name, subtitle: `${info.entries.length} club${info.entries.length === 1 ? '' : 's'} in — enter yours`, big: String(info.entries.length), bigLabel: 'clubs so far' };
    return {
      eyebrow: `${eyebrow} · ${s.status === 'done' ? 'Final table' : 'Table'}`,
      title: s.name,
      subtitle: s.status === 'done' && info.table[0] ? `${info.table[0].name} are champions` : `${info.fixtures.filter((f) => f.status === 'done').length} of ${info.fixtures.length} fixtures played`,
      lines: info.table.slice(0, 5).map((r) => ({ name: r.name, value: `${r.leaguePoints} pts` })),
    };
  }

  return { create, enter, leave, setTeam, start, view, forClub, matchChanged, statusChanged, card };
}

module.exports = { createSeasons };
