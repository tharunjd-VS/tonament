'use strict';

// Club v club: one club challenges another to a one-off team match — a tie
// in racket sports (singles and doubles matches, public/sports/tie.js) or a
// friendly in team sports. The other club's admins accept or decline;
// accepting makes a small link-only tournament (two club entries, one
// match), so line-ups, scoring and live updates work as in any tournament.
// Each club's admins pick their team from the club's members. When the match
// is finished (service.js tells us) the result goes on both clubs' records
// and feeds, with a share card.

const sports = require('./sports');
const EVENTS = require('../public/sports/events');
const TIE = require('../public/sports/tie');

const EXPIRE_DAYS = 14;
const MAX_OPEN = 3; // between the same two clubs
const MAX_TEAM = 30;

// match: { create, roster, info } from service.js — the tournament side.
function createClubChallenges({ db, fail, text, social, notify, match }) {
  const sportName = (id) => (sports.get(id) || {}).name || id;
  // Racket sports play a tie; team sports a friendly.
  const kindOf = (sport) => (EVENTS.isTeamSport(sport) ? 'friendly' : EVENTS.hasTies(sport) ? 'tie' : null);
  // The fewest players a tie needs: one singles and one doubles each at most.
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
  async function load(q, id, { lock = false } = {}) {
    const [x] = await q(`SELECT * FROM club_challenges WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [Number(id) || 0]);
    if (!x) fail(404, 'Challenge not found');
    return x;
  }
  // Unanswered for two weeks: expired.
  const expire = (q) => q(`UPDATE club_challenges SET status = 'expired' WHERE status = 'sent' AND created_at < now() - interval '${EXPIRE_DAYS} days'`);

  // ---------- sending one

  async function create(slug, actor, input = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    const me = actor.user;
    const o = await clubOf(db.query, slug);
    if (!(await isAdmin(db.query, o.id, actor))) fail(403, 'Only the club\'s admins can challenge another club');
    const rival = await clubOf(db.query, String(input.to || '').trim().replace(/^.*\/club\//, '').replace(/[/?#].*$/, ''));
    if (rival.id === o.id) fail(400, 'Pick another club');
    const sport = String(input.sport || '');
    const kind = sports.get(sport) ? kindOf(sport) : null;
    if (!kind) fail(400, 'Pick a racket sport (for a tie) or a team sport (for a friendly)');
    let tie = null;
    if (kind === 'tie') {
      try { tie = TIE.normalize(input.tie || {}); } catch (err) { fail(400, err.message); }
    }
    const message = text(input.message, 'Message', { max: 280, optional: true }) || null;
    const place = text(input.place, 'Where', { max: 80, optional: true }) || null;
    const playAt = input.playAt ? new Date(input.playAt) : null;
    if (playAt && Number.isNaN(playAt.getTime())) fail(400, 'When: pick a date and time');
    const id = await db.tx(async (q) => {
      await expire(q);
      const [{ n }] = await q(
        `SELECT COUNT(*)::int AS n FROM club_challenges WHERE status IN ('sent', 'accepted')
         AND ((from_org = $1 AND to_org = $2) OR (from_org = $2 AND to_org = $1))`,
        [o.id, rival.id],
      );
      if (n >= MAX_OPEN) fail(409, `There are already ${MAX_OPEN} open challenges between these clubs`);
      const [row] = await q(
        `INSERT INTO club_challenges (from_org, to_org, sport, tie, play_at, place, message, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) RETURNING id`,
        [o.id, rival.id, sport, tie && JSON.stringify(tie), playAt, place, message, me.id],
      );
      await notify.send(q, {
        users: await adminIds(q, rival.id), kind: 'club_challenge', actor: me.id, dedupe: `cc:${row.id}`,
        title: `⚔️ ${o.name} challenges ${rival.name}`,
        body: `A ${sportName(sport).toLowerCase()} ${kind}${playAt ? ` on ${playAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}` : ''}. Accept or decline.`,
        url: `/cc/${row.id}`,
      });
      return row.id;
    });
    return view(id, actor);
  }

  // ---------- answering it

  async function respond(id, actor, { accept } = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    const me = actor.user;
    const x = await load(db.query, id);
    if (!(await isAdmin(db.query, x.to_org, actor))) fail(403, 'Only the challenged club\'s admins can answer');
    // Claim it first, so two admins can't both accept.
    const claimed = await db.tx(async (q) => {
      await expire(q);
      const row = await load(q, id, { lock: true });
      if (row.status !== 'sent') fail(409, row.status === 'expired' ? 'This challenge has expired' : 'This challenge has already been answered');
      await q(`UPDATE club_challenges SET status = $1, responded_by = $2, responded_at = now() WHERE id = $3`, [accept ? 'accepted' : 'declined', me.id, row.id]);
      return row;
    });
    const [from, to] = await Promise.all([db.query('SELECT * FROM orgs WHERE id = $1', [x.from_org]), db.query('SELECT * FROM orgs WHERE id = $1', [x.to_org])]).then((r) => r.map((y) => y[0]));
    if (accept) {
      try {
        const admins = await db.query('SELECT email FROM users WHERE id = ANY($1::int[])', [[...await adminIds(db.query, from.id), ...await adminIds(db.query, to.id)]]);
        const tid = await match.create({
          actor,
          challengeId: x.id,
          name: `${from.name} v ${to.name}`,
          sport: x.sport,
          tie: claimed.tie,
          playAt: x.play_at,
          place: x.place,
          sides: [{ name: from.name, orgId: from.id, userId: x.created_by }, { name: to.name === from.name ? `${to.name} (2)` : to.name, orgId: to.id, userId: me.id }],
          organisers: admins.map((a) => a.email),
        });
        await db.query('UPDATE club_challenges SET tournament_id = $1 WHERE id = $2', [tid, x.id]);
      } catch (err) {
        await db.query(`UPDATE club_challenges SET status = 'sent', responded_by = NULL, responded_at = NULL WHERE id = $1`, [x.id]);
        throw err;
      }
    }
    await db.tx(async (q) => {
      await notify.send(q, {
        users: await adminIds(q, from.id), kind: 'challenge_reply', actor: me.id, dedupe: `ccreply:${x.id}`,
        title: accept ? `✅ ${to.name} accepted your challenge` : `${to.name} declined your challenge`,
        body: accept ? 'Pick your team — then the captains set their line-ups.' : null,
        url: `/cc/${x.id}`,
      });
      if (accept) {
        // On both clubs' feeds: it's on.
        for (const org of [from, to]) {
          await social.record(q, {
            dedupe: `cc:${x.id}:${org.id}:on`, actor: org.id === from.id ? x.created_by : me.id, org: org.id, sport: x.sport, verb: 'club_challenge',
            object: ['club_challenge', x.id], data: { id: x.id, from: from.name, to: to.name, fromSlug: from.slug, toSlug: to.slug, kind: kindOf(x.sport), playAt: x.play_at, place: x.place }, visibility: 'club',
          });
        }
      }
    });
    return view(id, actor);
  }

  async function cancel(id, actor) {
    const x = await load(db.query, id);
    if (!(await isAdmin(db.query, x.from_org, actor))) fail(actor?.user ? 403 : 401, 'Only the challenging club\'s admins can call it off');
    await db.tx(async (q) => {
      const row = await load(q, id, { lock: true });
      if (!['sent', 'accepted'].includes(row.status)) fail(409, 'It\'s too late to call this off');
      if (row.tournament_id) {
        const info = await match.info(q, row.tournament_id);
        if (info && info.started) fail(409, 'The match has started — it can\'t be called off now');
      }
      await q(`UPDATE club_challenges SET status = 'cancelled' WHERE id = $1`, [row.id]);
      await social.forget(q, 'club_challenge', row.id);
      if (row.status === 'accepted') {
        const [from] = await q('SELECT name FROM orgs WHERE id = $1', [row.from_org]);
        await notify.send(q, { users: await adminIds(q, row.to_org), kind: 'challenge_reply', actor: actor.user.id, dedupe: `cccancel:${row.id}`, title: `${from.name} called off the match`, url: `/cc/${row.id}` });
      }
    });
    return view(id, actor);
  }

  // ---------- the teams

  // A club's admins pick their team from the club's members (the first one
  // picked is the captain). It can change until a line-up is in (or, in a
  // friendly, until the match starts).
  async function setTeam(id, actor, { side, members } = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    const x = await load(db.query, id);
    if (x.status !== 'accepted' || !x.tournament_id) fail(409, 'Teams are picked once the challenge is accepted');
    const sides = { a: x.from_org, b: x.to_org };
    const mine = [];
    for (const s of ['a', 'b']) if (await isAdmin(db.query, sides[s], actor)) mine.push(s);
    const s = side || (mine.length === 1 ? mine[0] : null);
    if (!mine.includes(s)) fail(403, 'Only the club\'s admins pick its team');
    const ids = [...new Set((Array.isArray(members) ? members : []).map(Number).filter(Number.isInteger))];
    const need = needFor(x.tie);
    if (ids.length < need) fail(400, `Pick at least ${need} player${need === 1 ? '' : 's'}`);
    if (ids.length > MAX_TEAM) fail(400, `Pick at most ${MAX_TEAM} players`);
    const rows = await db.query(
      `SELECT u.id, u.name, u.email FROM club_members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 AND m.status = 'active' AND u.id = ANY($2::int[])`,
      [sides[s], ids],
    );
    if (rows.length !== ids.length) fail(400, 'Pick players from the club\'s members');
    const by = new Map(rows.map((r) => [r.id, r]));
    await match.roster(x.tournament_id, s, ids.map((uid, i) => ({ name: by.get(uid).name, email: by.get(uid).email, captain: i === 0 })));
    return view(id, actor);
  }

  // ---------- reading

  const orgView = (o) => o && { id: o.id, slug: o.slug, name: o.name };

  async function view(id, actor) {
    const q = db.query;
    await expire(q);
    const x = await load(q, id);
    const [from, to] = await Promise.all([q('SELECT * FROM orgs WHERE id = $1', [x.from_org]), q('SELECT * FROM orgs WHERE id = $1', [x.to_org])]).then((r) => r.map((y) => y[0]));
    const admin = { a: await isAdmin(q, x.from_org, actor), b: await isAdmin(q, x.to_org, actor) };
    const info = x.tournament_id ? await match.info(q, x.tournament_id) : null;
    const team = (s) => (info ? info.teams[s] : []);
    // The members an admin can pick from.
    const pool = async (orgId) => q(
      `SELECT u.id, u.name, u.handle FROM club_members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 AND m.status = 'active' ORDER BY lower(u.name)`,
      [orgId],
    );
    const canPick = x.status === 'accepted' && info && !info.locked;
    return {
      id: x.id,
      sport: { id: x.sport, name: sportName(x.sport) },
      kind: kindOf(x.sport),
      tie: x.tie ? { ...x.tie, name: TIE.formatName(x.tie), need: needFor(x.tie) } : null,
      need: needFor(x.tie),
      status: x.status,
      playAt: x.play_at,
      place: x.place,
      message: x.message,
      createdAt: x.created_at,
      a: { club: orgView(from), team: team('a'), admin: admin.a, members: admin.a && canPick ? await pool(x.from_org) : null },
      b: { club: orgView(to), team: team('b'), admin: admin.b, members: admin.b && canPick ? await pool(x.to_org) : null },
      tournamentId: x.tournament_id,
      match: info ? { id: info.matchId, status: info.status, summary: info.summary } : null,
      result: x.status === 'played' ? { winner: x.winner_org === from.id ? 'a' : x.winner_org === to.id ? 'b' : null, score: x.score } : null,
      can: {
        respond: x.status === 'sent' && admin.b,
        cancel: ['sent', 'accepted'].includes(x.status) && admin.a && !(info && info.started),
        pick: Boolean(canPick && (admin.a || admin.b)),
      },
    };
  }

  // A club's challenges (newest first) and its club v club record.
  async function forClub(slug, actor) {
    const q = db.query;
    await expire(q);
    const o = await clubOf(q, slug);
    const admin = await isAdmin(q, o.id, actor);
    const rows = await q(
      `SELECT c.*, f.name AS from_name, f.slug AS from_slug, t.name AS to_name, t.slug AS to_slug
       FROM club_challenges c JOIN orgs f ON f.id = c.from_org JOIN orgs t ON t.id = c.to_org
       WHERE (c.from_org = $1 OR c.to_org = $1) AND (c.status IN ('sent', 'accepted', 'played') OR c.created_at > now() - interval '7 days')
       ORDER BY c.status = 'played', COALESCE(c.played_at, c.created_at) DESC LIMIT 30`,
      [o.id],
    );
    const played = rows.filter((r) => r.status === 'played');
    const [rec] = await q(
      `SELECT COUNT(*) FILTER (WHERE winner_org = $1)::int AS won,
              COUNT(*) FILTER (WHERE winner_org IS NOT NULL AND winner_org <> $1)::int AS lost,
              COUNT(*) FILTER (WHERE winner_org IS NULL)::int AS drawn
       FROM club_challenges WHERE status = 'played' AND (from_org = $1 OR to_org = $1)`,
      [o.id],
    );
    return {
      admin,
      record: { ...rec, played: rec.won + rec.lost + rec.drawn },
      sports: (o.sports || []).filter((s) => sports.get(s) && kindOf(s)).map((s) => ({ id: s, name: sportName(s), kind: kindOf(s) })),
      items: rows.map((r) => {
        const home = r.from_org === o.id;
        return {
          id: r.id,
          sport: { id: r.sport, name: sportName(r.sport) },
          kind: kindOf(r.sport),
          status: r.status,
          incoming: !home,
          rival: { slug: home ? r.to_slug : r.from_slug, name: home ? r.to_name : r.from_name },
          playAt: r.play_at,
          score: r.score,
          won: r.status === 'played' ? (r.winner_org == null ? null : r.winner_org === o.id) : undefined,
        };
      }),
      played: played.length,
    };
  }

  // ---------- the result (from service.js, inside its transaction)

  // The match is finished: winner (side a = the challenger, b = the other club, or null for a draw) and its score from side a.
  async function finished(q, id, { winner, a, b, players }) {
    const x = await load(q, id, { lock: true });
    if (!['accepted', 'played'].includes(x.status)) return;
    const winnerOrg = winner === 'a' ? x.from_org : winner === 'b' ? x.to_org : null;
    const score = winner === 'b' ? `${b}–${a}` : `${a}–${b}`;
    await q(`UPDATE club_challenges SET status = 'played', winner_org = $1, score = $2, played_at = now() WHERE id = $3`, [winnerOrg, score, x.id]);
    const [from] = await q('SELECT id, name, slug FROM orgs WHERE id = $1', [x.from_org]);
    const [to] = await q('SELECT id, name, slug FROM orgs WHERE id = $1', [x.to_org]);
    const won = winner === 'b' ? to : from;
    const lost = winner === 'b' ? from : to;
    const data = { id: x.id, from: from.name, to: to.name, fromSlug: from.slug, toSlug: to.slug, winner: winnerOrg ? won.name : null, loser: winnerOrg ? lost.name : null, score, kind: kindOf(x.sport) };
    for (const org of [from, to]) {
      const mine = org.id === x.from_org ? players.a : players.b;
      await social.record(q, {
        dedupe: `cc:${x.id}:${org.id}:result`, actor: null, people: mine, org: org.id, sport: x.sport, verb: 'club_v_club',
        object: ['club_challenge', x.id], data: { ...data, club: org.name, won: winnerOrg ? winnerOrg === org.id : null }, visibility: 'public',
      });
    }
    const title = winnerOrg ? `🏆 ${won.name} beat ${lost.name} ${score}` : `${from.name} and ${to.name} drew ${score}`;
    await notify.send(q, { users: [...players.a, ...players.b, ...await adminIds(q, from.id), ...await adminIds(q, to.id)], kind: 'club_result', dedupe: `ccresult:${x.id}`, title, body: `Club v club · ${sportName(x.sport)}. Share the result.`, url: `/cc/${x.id}` });
  }
  // A result undone: back to accepted, off the feeds.
  async function reopened(q, id) {
    await q(`UPDATE club_challenges SET status = 'accepted', winner_org = NULL, score = NULL, played_at = NULL WHERE id = $1 AND status = 'played'`, [id]);
    await q(`DELETE FROM activity WHERE object_kind = 'club_challenge' AND object_id = $1 AND verb = 'club_v_club'`, [String(id)]);
  }

  // For the share card.
  async function card(id) {
    const [x] = await db.query(
      `SELECT c.*, f.name AS from_name, t.name AS to_name FROM club_challenges c JOIN orgs f ON f.id = c.from_org JOIN orgs t ON t.id = c.to_org WHERE c.id = $1`,
      [Number(id) || 0],
    );
    if (!x || ['declined', 'cancelled', 'expired'].includes(x.status)) return null;
    const eyebrow = `Club v club · ${sportName(x.sport)}${x.tie ? ` · ${TIE.formatName(x.tie)}` : ''}`;
    if (x.status === 'played') {
      if (x.winner_org == null) return { eyebrow, title: `${x.from_name} v ${x.to_name}`, subtitle: 'A draw', big: x.score, bigLabel: 'Final' };
      const fromWon = x.winner_org === x.from_org;
      return { eyebrow, title: fromWon ? x.from_name : x.to_name, subtitle: `beat ${fromWon ? x.to_name : x.from_name}`, big: x.score, bigLabel: 'Final' };
    }
    const when = x.play_at ? new Date(x.play_at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : null;
    return { eyebrow, title: `${x.from_name} v ${x.to_name}`, subtitle: [when, x.place].filter(Boolean).join(' · ') || (x.status === 'sent' ? 'The challenge is out' : 'It\'s on'), big: 'VS', bigLabel: x.status === 'sent' ? 'Challenge sent' : 'Match on' };
  }

  return { create, respond, cancel, setTeam, view, forClub, finished, reopened, card, kindOf };
}

module.exports = { createClubChallenges };
