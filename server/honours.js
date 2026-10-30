'use strict';

// Club honours and the club rankings: everything a club (and its members)
// has won, from every kind of competition on Tonament, and points for it over
// the last 12 months so clubs, academies and venues can be ranked:
//   the club's own    club v club win 3 (draw 1) · season title 10
//                     · team title at a meet or a racing championship 8
//                     · a club v club goal won 3
//   its members'      tournament title 2, final 1 · race podium 2/1/1
//                     · meet medal 2/1/1 · racing round win 2
// Members count while they're in the club (their current club).

const sports = require('./sports');

const DAYS = 365;
const POINTS = {
  versus: { won: 3, drew: 1 }, season: [10], teamTitle: 8, goal: 3,
  title: 2, final: 1, podium: [2, 1, 1], medal: [2, 1, 1], round: 2,
};
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

function createHonours({ db, fail }) {
  // Every honour for the clubs given (or all clubs): [{ org, kind, title, detail, at, url, points }].
  async function collect(q, orgIds = null, { days = null } = {}) {
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : '1970-01-01';
    const only = orgIds ? 'AND o.id = ANY($2::int[])' : '';
    const params = orgIds ? [since, orgIds] : [since];
    const out = [];
    const add = (org, kind, title, detail, at, url, points) => out.push({ org, kind, title, detail, at, url, points });

    // Club v club: wins (and draws).
    for (const r of await q(
      `SELECT c.id, c.sport, c.score, c.winner_org, c.played_at, o.id AS org, f.name AS f, t.name AS t, c.from_org, c.to_org
       FROM club_challenges c JOIN orgs f ON f.id = c.from_org JOIN orgs t ON t.id = c.to_org JOIN orgs o ON o.id IN (c.from_org, c.to_org)
       WHERE c.status = 'played' AND c.played_at >= $1 ${only}`,
      params,
    )) {
      const rival = r.org === r.from_org ? r.t : r.f;
      const sport = (sports.get(r.sport) || {}).name || r.sport;
      if (r.winner_org === r.org) add(r.org, 'versus', `Beat ${rival}`, `${sport} · ${r.score}`, r.played_at, `/cc/${r.id}`, POINTS.versus.won);
      else if (r.winner_org == null) add(r.org, 'versus', `Drew with ${rival}`, `${sport} · ${r.score}`, r.played_at, `/cc/${r.id}`, POINTS.versus.drew);
    }
    // Season titles.
    for (const r of await q(
      `SELECT s.id, s.name, s.sport, s.champion_org, a.created_at AS at, o.id AS org
       FROM seasons s JOIN activity a ON a.dedupe = 'season:' || s.id || ':won:' || s.champion_org JOIN orgs o ON o.id = s.champion_org
       WHERE s.status = 'done' AND a.created_at >= $1 ${only}`,
      params,
    )) add(r.org, 'season', `Won ${r.name}`, `${(sports.get(r.sport) || {}).name || r.sport} season`, r.at, `/season/${r.id}`, POINTS.season[0]);
    // Team titles at meets and racing championships: teams named after a club
    // (only when exactly one club has that name, so the title can't go astray).
    for (const r of await q(
      `SELECT a.verb, a.data, a.created_at AS at, o.id AS org FROM activity a JOIN orgs o ON lower(o.name) = lower(a.data->>'team')
       WHERE a.verb IN ('meet_won', 'motor_champ') AND a.created_at >= $1 ${only}
         AND (SELECT COUNT(*) FROM orgs x WHERE lower(x.name) = lower(a.data->>'team')) = 1`,
      params,
    )) {
      const d = r.data;
      add(r.org, r.verb === 'meet_won' ? 'meet' : 'racing', `Team champions · ${d.name}`, r.verb === 'meet_won' ? `${d.points} pts, ${d.gold} gold` : `${d.teamPoints} pts`, r.at, r.verb === 'meet_won' ? `/meet/${d.meet}` : `/champ/${d.champ}`, POINTS.teamTitle);
    }
    // Club v club goals won.
    for (const r of await q(
      `SELECT a.data, a.created_at AS at, a.org_id AS org FROM activity a JOIN orgs o ON o.id = a.org_id
       WHERE a.verb = 'goal' AND a.data ? 'rival' AND a.created_at >= $1 ${only}`,
      params,
    )) add(r.org, 'goal', `Beat ${r.data.rival}`, r.data.title, r.at, `/goals/${r.data.goal}`, POINTS.goal);

    // Members' wins: by the members' current clubs.
    const members = `JOIN club_members m ON m.user_id = u.id AND m.status = 'active' JOIN orgs o ON o.id = m.org_id`;
    for (const r of await q(
      `SELECT r.finish, r.finished_at AS at, r.tournament_id, t.name AS tournament, ev.name AS event, u.name, o.id AS org
       FROM event_results r JOIN users u ON lower(u.email) = lower(r.email) ${members}
       JOIN tournaments t ON t.id = r.tournament_id JOIN events ev ON ev.id = r.event_id
       WHERE r.finish IN ('W', 'F') AND t.club_challenge_id IS NULL AND t.season_id IS NULL AND r.finished_at >= $1 ${only}`,
      params,
    )) {
      add(r.org, 'member', `${r.name} ${r.finish === 'W' ? 'won' : 'reached the final of'} ${r.event || 'an event'}`, r.tournament, r.at, `/t/${r.tournament_id}`, r.finish === 'W' ? POINTS.title : POINTS.final);
    }
    for (const r of await q(
      `SELECT a.verb, a.data, a.created_at AS at, u.name, o.id AS org FROM activity a JOIN users u ON u.id = a.actor_id ${members}
       WHERE ((a.verb IN ('race', 'meet') AND (a.data->>'place')::int <= 3) OR (a.verb = 'motor' AND (a.data->>'place')::int = 1)) AND a.created_at >= $1 ${only}`,
      params,
    )) {
      const d = r.data;
      const p = Number(d.place);
      if (r.verb === 'race') add(r.org, 'member', `${r.name} ${ordinal(p)} in the ${d.event}`, `${d.name} · ${d.time}`, r.at, `/race/${d.race}`, POINTS.podium[p - 1]);
      if (r.verb === 'meet') add(r.org, 'member', `${r.name} ${['', 'gold', 'silver', 'bronze'][p]} in the ${d.event}`, `${d.name} · ${d.mark}`, r.at, `/meet/${d.meet}`, POINTS.medal[p - 1]);
      if (r.verb === 'motor') add(r.org, 'member', `${r.name} won ${d.round}`, d.name, r.at, `/champ/${d.champ}`, POINTS.round);
    }
    return out.sort((a, b) => new Date(b.at) - new Date(a.at));
  }

  // A club's honours: its trophies (all time), its members' recent wins, and
  // its points and place in the rankings this year.
  async function forClub(slug) {
    const q = db.query;
    const [o] = await q('SELECT * FROM orgs WHERE slug = $1', [String(slug || '').toLowerCase()]);
    if (!o) fail(404, 'Club not found');
    const all = await collect(q, [o.id]);
    const year = all.filter((x) => new Date(x.at) > Date.now() - DAYS * 86400000);
    const table = await ranked();
    const place = table.findIndex((r) => r.id === o.id);
    const strip = ({ org, ...x }) => x;
    return {
      points: year.reduce((s, x) => s + x.points, 0),
      rank: place >= 0 ? { place: place + 1, of: table.length } : null,
      trophies: all.filter((x) => x.kind !== 'member').slice(0, 30).map(strip),
      members: all.filter((x) => x.kind === 'member').slice(0, 20).map(strip),
      counts: {
        versus: all.filter((x) => x.kind === 'versus' && x.points === POINTS.versus.won).length,
        titles: all.filter((x) => ['season', 'meet', 'racing'].includes(x.kind)).length,
        members: all.filter((x) => x.kind === 'member').length,
      },
    };
  }

  // The rankings: every club with points in the last 12 months.
  async function ranked() {
    const q = db.query;
    const list = await collect(q, null, { days: DAYS });
    const by = new Map();
    for (const x of list) {
      const t = by.get(x.org) || { id: x.org, points: 0, trophies: 0, members: 0 };
      t.points += x.points;
      if (x.kind === 'member') t.members += 1; else t.trophies += 1;
      by.set(x.org, t);
    }
    if (!by.size) return [];
    const orgs = await q('SELECT id, slug, name, kind, city, sports FROM orgs WHERE id = ANY($1::int[])', [[...by.keys()]]);
    const { KIND_NAMES } = require('./orgs');
    return orgs.map((o) => ({ ...by.get(o.id), slug: o.slug, name: o.name, kind: o.kind, kindName: KIND_NAMES[o.kind] || 'Club', city: o.city, sports: o.sports || [] }))
      .sort((a, b) => b.points - a.points || b.trophies - a.trophies || a.name.localeCompare(b.name));
  }
  async function rankings(filters = {}) {
    const all = await ranked();
    const city = String(filters.city || '').trim().toLowerCase();
    const kind = String(filters.kind || '');
    const sport = String(filters.sport || '');
    const rows = all.filter((r) => (!city || (r.city || '').toLowerCase() === city) && (!kind || r.kind === kind) && (!sport || r.sports.includes(sport)));
    return {
      items: rows.slice(0, 100).map((r, i) => ({ place: i + 1, slug: r.slug, name: r.name, kindName: r.kindName, city: r.city, points: r.points, trophies: r.trophies, members: r.members })),
      cities: [...new Set(all.map((r) => r.city).filter(Boolean))].sort(),
      points: POINTS,
    };
  }

  return { forClub, rankings, collect, POINTS };
}

module.exports = { createHonours };
