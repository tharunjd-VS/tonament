'use strict';

// Club ladders: a standing ranking built from challenges. Members join at the
// bottom and challenge anyone up to `reach` places above them (one open
// ladder challenge each; at most two waiting on any one player). The
// challenge is an ordinary one (accept, score, confirm, ratings); when the
// challenger wins they take the defender's place and everyone in between
// moves down one. Unanswered for a week, the place goes to the challenger.

const sports = require('./sports');

const MAX_AGAINST = 2;

function createLadders({ db, fail, text, social, notify, challenges }) {
  const needUser = (actor) => { if (!actor?.user) fail(401, 'Sign in first'); return actor.user; };

  async function clubOf(q, slug) {
    const [o] = await q('SELECT * FROM orgs WHERE slug = $1', [String(slug || '').toLowerCase()]);
    if (!o) fail(404, 'Club not found');
    return o;
  }
  async function memberOf(q, orgId, userId) {
    const [m] = await q(`SELECT role FROM club_members WHERE org_id = $1 AND user_id = $2 AND status = 'active'`, [orgId, userId]);
    return m || null;
  }
  async function isAdmin(q, o, actor) {
    if (!actor?.user) return false;
    if (actor.user.isAdmin) return true;
    const m = await memberOf(q, o.id, actor.user.id);
    if (m && m.role === 'admin') return true;
    const [editor] = await q('SELECT 1 FROM org_members WHERE org_id = $1 AND email = $2', [o.id, actor.user.email]);
    return Boolean(editor);
  }
  async function load(q, id, { lock = false } = {}) {
    const [l] = await q(`SELECT * FROM ladders WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [Number(id) || 0]);
    if (!l) fail(404, 'Ladder not found');
    return l;
  }

  // ---------- setting one up

  async function create(slug, actor, input = {}) {
    const o = await clubOf(db.query, slug);
    if (!(await isAdmin(db.query, o, actor))) fail(actor?.user ? 403 : 401, 'Only the club\'s admins can start a ladder');
    const sport = String(input.sport || '');
    if (!challenges.challengeable(sport)) fail(400, 'Pick a sport played one against one');
    const s = sports.get(sport);
    const reach = Math.min(Math.max(Number(input.reach) || 3, 1), 10);
    const scoring = s.normalizeConfig(input.bestOf ? { bestOf: Number(input.bestOf) } : {});
    const name = text(input.name, 'Name', { max: 60, optional: true }) || `${o.name} ${s.name} ladder`;
    const [{ n }] = await db.query(`SELECT COUNT(*)::int AS n FROM ladders WHERE org_id = $1 AND status = 'active'`, [o.id]);
    if (n >= 6) fail(409, 'A club can run up to 6 ladders at once');
    await db.query('INSERT INTO ladders (org_id, sport, name, reach, scoring, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [o.id, sport, name, reach, JSON.stringify(scoring), actor.user.id]);
    return forClub(slug, actor);
  }

  // ---------- reading

  // The club's ladders, ranked, with what the viewer can do on each.
  async function forClub(slug, actor) {
    const q = db.query;
    const o = await clubOf(q, slug);
    const me = actor?.user?.id || null;
    const member = me ? Boolean(await memberOf(q, o.id, me)) : false;
    const admin = await isAdmin(q, o, actor);
    const ladders = await q(`SELECT * FROM ladders WHERE org_id = $1 AND status = 'active' ORDER BY created_at`, [o.id]);
    if (!ladders.length) return { ladders: [], member, admin };
    // Settle what's due (forfeits after a week, results confirmed after a day).
    const due = await q(`SELECT id FROM challenges WHERE ladder_id = ANY($1::int[]) AND status IN ('sent', 'done')`, [ladders.map((l) => l.id)]);
    for (const { id } of due) await db.tx(async (t) => challenges.settle(t, await challenges.load(t, id, { lock: true })));
    const rungs = await q(
      `SELECT r.*, u.name, u.handle, rt.rating FROM ladder_rungs r JOIN users u ON u.id = r.user_id
       LEFT JOIN ladders l ON l.id = r.ladder_id LEFT JOIN ratings rt ON rt.user_id = r.user_id AND rt.sport = l.sport
       WHERE r.ladder_id = ANY($1::int[]) ORDER BY r.ladder_id, r.position`,
      [ladders.map((l) => l.id)],
    );
    const open = await q(
      `SELECT id, ladder_id, a1, b1, status FROM challenges WHERE ladder_id = ANY($1::int[]) AND status IN ('sent', 'accepted', 'live', 'done', 'disputed')`,
      [ladders.map((l) => l.id)],
    );
    return {
      member,
      admin,
      ladders: ladders.map((l) => {
        const list = rungs.filter((r) => r.ladder_id === l.id);
        const mine = list.find((r) => r.user_id === me);
        const openHere = open.filter((c) => c.ladder_id === l.id);
        const busy = mine && openHere.some((c) => c.a1 === me);
        const against = (id) => openHere.filter((c) => c.b1 === id && c.status === 'sent').length;
        return {
          id: l.id,
          name: l.name,
          sport: { id: l.sport, name: (sports.get(l.sport) || {}).name || l.sport },
          reach: l.reach,
          scoring: l.scoring,
          me: mine ? mine.position : null,
          rungs: list.map((r) => ({
            position: r.position, id: r.user_id, name: r.name, handle: r.handle, rating: r.rating,
            climbed: Boolean(r.last_change_at && Date.parse(r.last_change_at) > Date.now() - 7 * 86400000),
            canChallenge: Boolean(mine && !busy && r.position < mine.position && r.position >= mine.position - l.reach && against(r.user_id) < MAX_AGAINST
              && !openHere.some((c) => [c.a1, c.b1].includes(r.user_id) && [c.a1, c.b1].includes(me))),
          })),
          open: openHere.map((c) => ({ id: c.id, a: list.find((r) => r.user_id === c.a1), b: list.find((r) => r.user_id === c.b1), status: c.status }))
            .map((c) => ({ id: c.id, status: c.status, a: c.a && { name: c.a.name, position: c.a.position }, b: c.b && { name: c.b.name, position: c.b.position } })),
          busy: Boolean(busy),
        };
      }),
    };
  }

  // ---------- joining and leaving

  async function join(id, actor) {
    const me = needUser(actor);
    const l = await load(db.query, id);
    await db.tx(async (q) => {
      await q('SELECT id FROM ladders WHERE id = $1 FOR UPDATE', [l.id]);
      if (!(await memberOf(q, l.org_id, me.id))) fail(403, 'Join the club first');
      const [already] = await q('SELECT 1 FROM ladder_rungs WHERE ladder_id = $1 AND user_id = $2', [l.id, me.id]);
      if (already) return;
      const [{ bottom }] = await q('SELECT COALESCE(MAX(position), 0)::int AS bottom FROM ladder_rungs WHERE ladder_id = $1', [l.id]);
      await q('INSERT INTO ladder_rungs (ladder_id, user_id, position) VALUES ($1, $2, $3)', [l.id, me.id, bottom + 1]);
    });
    return forClub(await slugOf(l), actor);
  }
  async function leave(id, actor) {
    const me = needUser(actor);
    const l = await load(db.query, id);
    await db.tx(async (q) => {
      await q('SELECT id FROM ladders WHERE id = $1 FOR UPDATE', [l.id]);
      const [r] = await q('DELETE FROM ladder_rungs WHERE ladder_id = $1 AND user_id = $2 RETURNING position', [l.id, me.id]);
      if (r) await q('UPDATE ladder_rungs SET position = position - 1 WHERE ladder_id = $1 AND position > $2', [l.id, r.position]);
      // Their open ladder challenges go too.
      await q(`UPDATE challenges SET status = 'cancelled' WHERE ladder_id = $1 AND status IN ('sent', 'accepted') AND $2 IN (a1, b1)`, [l.id, me.id]);
    });
    return forClub(await slugOf(l), actor);
  }
  const slugOf = async (l) => (await db.query('SELECT slug FROM orgs WHERE id = $1', [l.org_id]))[0].slug;

  // ---------- challenging

  async function challenge(id, actor, input = {}) {
    const me = needUser(actor);
    const l = await load(db.query, id);
    const view = (await forClub(await slugOf(l), actor)).ladders.find((x) => x.id === l.id);
    if (!view || view.me == null) fail(403, 'Join the ladder first');
    if (view.busy) fail(409, 'Finish your open ladder challenge first');
    const target = view.rungs.find((r) => r.id === Number(input.to));
    if (!target) fail(404, 'They\'re not on this ladder');
    if (!target.canChallenge) {
      fail(409, target.position >= view.me ? 'Challenge someone above you'
        : target.position < view.me - l.reach ? `You can challenge up to ${l.reach} place${l.reach === 1 ? '' : 's'} above you`
          : 'They already have challenges waiting — try someone else');
    }
    return challenges.create(actor, {
      sport: l.sport, to: target.id, scoring: l.scoring, ladder: l.id, club: l.org_id, ladderAt: { a: view.me, b: target.position },
      place: input.place, playAt: input.playAt, message: input.message || `Ladder: #${view.me} v #${target.position}`,
    });
  }

  // ---------- moving

  // The challenger takes the defender's place; everyone from there down to
  // the challenger's old place moves down one.
  async function moved(q, x, { forfeit = false } = {}) {
    if (!forfeit && x.winner !== 'a') return; // the defender held their place
    const [l] = await q('SELECT * FROM ladders WHERE id = $1 FOR UPDATE', [x.ladder_id]);
    if (!l) return;
    const at = async (id) => (await q('SELECT position FROM ladder_rungs WHERE ladder_id = $1 AND user_id = $2', [l.id, id]))[0];
    const a = await at(x.a1);
    const b = await at(x.b1);
    if (!a || !b || a.position <= b.position) return; // already above (another result got there first)
    await q('UPDATE ladder_rungs SET position = position + 1 WHERE ladder_id = $1 AND position >= $2 AND position < $3', [l.id, b.position, a.position]);
    await q('UPDATE ladder_rungs SET position = $1, last_change_at = now() WHERE ladder_id = $2 AND user_id = $3', [b.position, l.id, x.a1]);
    const [o] = await q('SELECT name, slug FROM orgs WHERE id = $1', [l.org_id]);
    const people = await q('SELECT id, name, profile_public FROM users WHERE id = ANY($1::int[])', [[x.a1, x.b1]]);
    const name = new Map(people.map((p) => [p.id, p.name]));
    const score = forfeit ? null : x.final ? `${x.final.a}–${x.final.b}` : sports.get(x.sport).summary(sports.get(x.sport).compute(x.rallies, sports.get(x.sport).normalizeConfig(x.scoring), x.first_server));
    await social.record(q, {
      dedupe: `ladder:${x.id}`, actor: x.a1, people: [x.a1, x.b1], org: l.org_id, sport: l.sport, verb: 'ladder', object: ['ladder', l.id],
      data: { ladder: l.name, ladderId: l.id, club: o.name, slug: o.slug, from: a.position, to: b.position, beat: name.get(x.b1), score, forfeit, challenge: x.id },
      visibility: people.every((p) => p.profile_public) ? 'public' : 'club',
    });
    await notify.send(q, {
      users: [x.b1], kind: 'ladder', actor: x.a1, dedupe: `ladder:${x.id}`,
      title: `${name.get(x.a1)} took your #${b.position} spot on the ${l.name}`,
      body: forfeit ? 'Their challenge went unanswered for a week.' : `They won ${score}. Win it back: challenge them.`, url: `/club/${o.slug}?tab=ladder`,
    });
  }
  challenges.hooks.confirmed = (q, x) => moved(q, x);
  challenges.hooks.forfeit = (q, x) => moved(q, x, { forfeit: true });

  return { create, forClub, join, leave, challenge, moved };
}

module.exports = { createLadders };
