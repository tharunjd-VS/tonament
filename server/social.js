'use strict';

// The social layer: follows, the activity feed, kudos and comments, blocks
// and reports. Every write path that's worth telling people about calls
// record() (a podium, a confirmed game, joining a club…); feeds read it back
// for the viewer: what's public from people, clubs, tournaments and groups
// they follow, plus their own clubs.
//
// visibility: public (anyone), followers (people who follow someone in it,
// and those in it), club (the club's members).

const FOLLOW_KINDS = ['user', 'club', 'tournament', 'group'];
const PAGE = 30;
const COMMENT_MAX = 500;
const MINOR_AGE = 18;

function createSocial({ db, fail, text, mediaUrl, notify = null }) {
  const needUser = (actor) => { if (!actor?.user) fail(401, 'Sign in first'); return actor.user; };
  const minorYear = () => new Date().getFullYear() - MINOR_AGE;

  // ---------- writing

  // One fact, once (dedupe); recording it again updates what it says.
  async function record(q, { dedupe = null, actor = null, people = [], org = null, sport = null, verb, object = [null, null], data = {}, visibility = 'public', at = null }) {
    const ids = [...new Set([actor, ...people].filter((x) => Number.isInteger(x)))];
    const [row] = await q(
      `INSERT INTO activity (dedupe, actor_id, people, org_id, sport, verb, object_kind, object_id, data, visibility, created_at)
       VALUES ($1, $2, $3::int[], $4, $5, $6, $7, $8, $9::jsonb, $10, COALESCE($11::timestamptz, now()))
       ON CONFLICT (dedupe) DO UPDATE SET people = EXCLUDED.people, data = EXCLUDED.data, visibility = EXCLUDED.visibility
       RETURNING id`,
      [dedupe, actor, ids, org, sport, verb, object[0], object[1] == null ? null : String(object[1]), JSON.stringify(data), visibility, at],
    );
    return row.id;
  }
  // Take back what no longer holds (a result reopened, a game voided).
  const forget = (q, kind, id) => q('DELETE FROM activity WHERE object_kind = $1 AND object_id = $2', [kind, String(id)]);

  // ---------- follows

  async function follow(actor, input = {}) {
    const me = needUser(actor);
    const kind = FOLLOW_KINDS.includes(input.kind) ? input.kind : fail(400, 'Follow what?');
    const id = String(input.id ?? '').slice(0, 64);
    if (!id) fail(400, 'Follow what?');
    if (kind === 'user' && Number(id) === me.id) fail(400, 'That\'s you');
    if (input.on === false) await db.query('DELETE FROM follows WHERE follower_id = $1 AND kind = $2 AND target_id = $3', [me.id, kind, id]);
    else {
      const added = await db.query('INSERT INTO follows (follower_id, kind, target_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1', [me.id, kind, id]);
      if (added.length && kind === 'user' && notify) {
        const [u] = await db.query('SELECT handle FROM users WHERE id = $1', [me.id]);
        await notify.send(db.query, { users: [Number(id)], kind: 'follow', actor: me.id, dedupe: `follow:${me.id}`, title: `${me.name} is following you`, url: u && u.handle ? `/p/${u.handle}` : '/' });
      }
    }
    return followState(db.query, actor, kind, id);
  }
  // { following, followers } for a follow button.
  async function followState(q, actor, kind, id) {
    const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM follows WHERE kind = $1 AND target_id = $2', [kind, String(id)]);
    const [mine] = actor?.user ? await q('SELECT 1 FROM follows WHERE follower_id = $1 AND kind = $2 AND target_id = $3', [actor.user.id, kind, String(id)]) : [];
    return { following: Boolean(mine), followers: n };
  }

  // ---------- reading

  // Who the viewer follows, which clubs they're in, and who's blocked either way.
  async function circle(q, userId) {
    if (!userId) return { users: [], clubs: [], myClubs: [], targets: [], blocked: [] };
    const [follows, clubs, blocks] = await Promise.all([
      q('SELECT kind, target_id FROM follows WHERE follower_id = $1', [userId]),
      q(`SELECT org_id FROM club_members WHERE user_id = $1 AND status = 'active'`, [userId]),
      q('SELECT blocked_id AS id FROM blocks WHERE user_id = $1 UNION SELECT user_id FROM blocks WHERE blocked_id = $1', [userId]),
    ]);
    const myClubs = clubs.map((c) => c.org_id);
    return {
      users: [userId, ...follows.filter((f) => f.kind === 'user').map((f) => Number(f.target_id))],
      clubs: [...new Set([...myClubs, ...follows.filter((f) => f.kind === 'club').map((f) => Number(f.target_id))])],
      myClubs,
      // Followed tournaments and groups match activity about them.
      targets: follows.filter((f) => f.kind === 'tournament' || f.kind === 'group').map((f) => `${f.kind}:${f.target_id}`),
      blocked: blocks.map((b) => b.id),
    };
  }

  // What the viewer may see, as SQL (params from $offset on).
  function visibleSql(c, offset) {
    return {
      sql: `(a.visibility = 'public'
              OR (a.visibility = 'followers' AND a.people && $${offset}::int[])
              OR (a.visibility = 'club' AND a.org_id = ANY($${offset + 1}::int[])))
            AND NOT (a.people && $${offset + 2}::int[])`,
      params: [c.users, c.myClubs, c.blocked],
    };
  }

  // The home feed: people, clubs, tournaments and groups followed, plus your clubs.
  async function feed(actor, { before = null } = {}) {
    const me = needUser(actor);
    const c = await circle(db.query, me.id);
    const v = visibleSql(c, 1);
    const rows = await db.query(
      `SELECT a.* FROM activity a
       WHERE ${v.sql}
         AND (a.people && $1::int[] OR a.org_id = ANY($4::int[])
              OR (a.data->>'tournamentId') IS NOT NULL AND ('tournament:' || (a.data->>'tournamentId')) = ANY($5::text[])
              OR (a.data->>'groupId') IS NOT NULL AND ('group:' || (a.data->>'groupId')) = ANY($5::text[]))
         AND ($6::int IS NULL OR a.id < $6)
       ORDER BY a.id DESC LIMIT ${PAGE}`,
      [...v.params, c.clubs, c.targets, before ? Number(before) : null],
    );
    return page(db.query, rows, me.id, c);
  }
  // A player's activity (their profile).
  async function userFeed(userId, actor, { before = null } = {}) {
    const c = await circle(db.query, actor?.user?.id);
    const v = visibleSql(c, 1);
    const rows = await db.query(
      `SELECT a.* FROM activity a WHERE ${v.sql} AND $4 = ANY(a.people) AND ($5::int IS NULL OR a.id < $5)
       ORDER BY a.id DESC LIMIT ${PAGE}`,
      [...v.params, Number(userId), before ? Number(before) : null],
    );
    return page(db.query, rows, actor?.user?.id, c);
  }
  // A club's activity (its page).
  async function clubFeed(orgId, actor, { before = null } = {}) {
    const c = await circle(db.query, actor?.user?.id);
    const v = visibleSql(c, 1);
    const rows = await db.query(
      `SELECT a.* FROM activity a WHERE ${v.sql} AND a.org_id = $4 AND ($5::int IS NULL OR a.id < $5)
       ORDER BY a.id DESC LIMIT ${PAGE}`,
      [...v.params, Number(orgId), before ? Number(before) : null],
    );
    return page(db.query, rows, actor?.user?.id, c);
  }

  // Items with names, kudos and comment counts; under-18s only to those who
  // share a club with them (or follow them), never to strangers.
  async function page(q, rows, viewerId, c) {
    const ids = [...new Set(rows.flatMap((r) => r.people))];
    const [users, kudos, mine, comments] = rows.length ? await Promise.all([
      q('SELECT id, name, handle, photo_id, birth_year FROM users WHERE id = ANY($1::int[])', [ids]),
      q('SELECT activity_id, COUNT(*)::int AS n FROM reactions WHERE activity_id = ANY($1::int[]) GROUP BY activity_id', [rows.map((r) => r.id)]),
      viewerId ? q('SELECT activity_id FROM reactions WHERE user_id = $1 AND activity_id = ANY($2::int[])', [viewerId, rows.map((r) => r.id)]) : [],
      q('SELECT activity_id, COUNT(*)::int AS n FROM comments WHERE activity_id = ANY($1::int[]) GROUP BY activity_id', [rows.map((r) => r.id)]),
    ]) : [[], [], [], []];
    const byId = new Map(users.map((u) => [u.id, u]));
    const minor = (id) => { const u = byId.get(id); return Boolean(u && u.birth_year && u.birth_year > minorYear()); };
    const known = new Set(c.users);
    const sharedClub = (r) => r.org_id && c.myClubs.includes(r.org_id);
    const count = (list) => new Map(list.map((x) => [x.activity_id, x.n]));
    const k = count(kudos);
    const n = count(comments);
    const liked = new Set(mine.map((x) => x.activity_id));
    const items = rows
      .filter((r) => !r.people.some((id) => minor(id) && !known.has(id) && !sharedClub(r)))
      .map((r) => ({
        id: r.id,
        verb: r.verb,
        sport: r.sport,
        at: r.created_at,
        org: r.org_id,
        object: r.object_kind ? { kind: r.object_kind, id: r.object_id } : null,
        data: r.data,
        people: r.people.map((id) => byId.get(id)).filter(Boolean).map((u) => ({ id: u.id, name: u.name, handle: u.handle, photo: u.photo_id ? mediaUrl(u.photo_id) : null })),
        public: r.visibility === 'public',
        kudos: k.get(r.id) || 0,
        kudoed: liked.has(r.id),
        comments: n.get(r.id) || 0,
      }));
    return { items, next: rows.length === PAGE ? rows[rows.length - 1].id : null };
  }

  // ---------- kudos and comments

  // What a feed item is about, in a few words (for notifications).
  const about = (a) => {
    const d = a.data || {};
    if (a.verb === 'finish') return `${d.finish === 'W' ? 'Winning' : 'The final of'} ${d.event}`;
    if (a.verb === 'game') return `${((d.winner === 'a' ? d.a : d.b) || []).join(' & ')} ${d.score}`;
    if (a.verb === 'joined') return `Joining ${d.club}`;
    if (a.verb === 'club') return d.club;
    return null;
  };

  async function seeable(q, actor, id) {
    const c = await circle(q, actor?.user?.id);
    const v = visibleSql(c, 1);
    const [a] = await q(`SELECT a.* FROM activity a WHERE a.id = $4 AND ${v.sql}`, [...v.params, Number(id) || 0]);
    if (!a) fail(404, 'Not found');
    return a;
  }
  async function kudos(actor, id, on = true) {
    const me = needUser(actor);
    const a = await seeable(db.query, actor, id);
    if (on) {
      const added = await db.query('INSERT INTO reactions (activity_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [a.id, me.id]);
      if (added.length && notify) await notify.send(db.query, { users: a.people, kind: 'kudos', actor: me.id, dedupe: `kudos:${a.id}:${me.id}`, title: `${me.name} gave you kudos 👏`, body: about(a), url: `/a/${a.id}` });
    }
    else await db.query('DELETE FROM reactions WHERE activity_id = $1 AND user_id = $2', [a.id, me.id]);
    const [{ n }] = await db.query('SELECT COUNT(*)::int AS n FROM reactions WHERE activity_id = $1', [a.id]);
    return { kudos: n, kudoed: on };
  }
  async function commentsOf(id, actor) {
    const a = await seeable(db.query, actor, id);
    const c = await circle(db.query, actor?.user?.id);
    const rows = await db.query(
      `SELECT c.id, c.body, c.created_at, c.user_id, u.name, u.handle FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.activity_id = $1 AND NOT (c.user_id = ANY($2::int[])) ORDER BY c.created_at LIMIT 200`,
      [a.id, c.blocked],
    );
    return rows.map((r) => ({ id: r.id, body: r.body, at: r.created_at, by: { id: r.user_id, name: r.name, handle: r.handle }, mine: r.user_id === actor?.user?.id }));
  }
  async function comment(actor, id, input = {}) {
    const me = needUser(actor);
    const a = await seeable(db.query, actor, id);
    const body = text(input.body, 'Comment', { max: COMMENT_MAX });
    const [{ n }] = await db.query(`SELECT COUNT(*)::int AS n FROM comments WHERE user_id = $1 AND created_at > now() - interval '10 minutes'`, [me.id]);
    if (n >= 20) fail(429, 'That\'s a lot of comments — try again in a few minutes');
    const [c] = await db.query('INSERT INTO comments (activity_id, user_id, body) VALUES ($1, $2, $3) RETURNING id', [a.id, me.id, body]);
    if (notify) await notify.send(db.query, { users: a.people, kind: 'comment', actor: me.id, dedupe: `comment:${c.id}`, title: `${me.name} commented on ${about(a) ? `“${about(a)}”` : 'your post'}`, body, url: `/a/${a.id}` });
    return commentsOf(a.id, actor);
  }
  async function deleteComment(actor, commentId) {
    const me = needUser(actor);
    const [c] = await db.query(
      `SELECT c.id, c.user_id, a.people FROM comments c JOIN activity a ON a.id = c.activity_id WHERE c.id = $1`,
      [Number(commentId) || 0],
    );
    // The writer, anyone the item is about, or a site admin.
    if (!c || (c.user_id !== me.id && !c.people.includes(me.id) && !me.isAdmin)) fail(404, 'Not found');
    await db.query('DELETE FROM comments WHERE id = $1', [c.id]);
    return { deleted: true };
  }

  // ---------- safety

  async function block(actor, userId, on = true) {
    const me = needUser(actor);
    const id = Number(userId) || 0;
    if (!id || id === me.id) fail(400, 'Block who?');
    if (on) {
      await db.query('INSERT INTO blocks (user_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me.id, id]);
      await db.query(`DELETE FROM follows WHERE kind = 'user' AND ((follower_id = $1 AND target_id = $3) OR (follower_id = $2 AND target_id = $4))`, [me.id, id, String(id), String(me.id)]);
    } else {
      await db.query('DELETE FROM blocks WHERE user_id = $1 AND blocked_id = $2', [me.id, id]);
    }
    return { blocked: on };
  }
  async function report(actor, input = {}) {
    const me = needUser(actor);
    const kind = ['comment', 'activity', 'user', 'club'].includes(input.kind) ? input.kind : fail(400, 'Report what?');
    const reason = text(input.reason, 'Reason', { max: 300, optional: true });
    await db.query('INSERT INTO reports (reporter_id, kind, target_id, reason) VALUES ($1, $2, $3, $4)', [me.id, kind, String(input.id ?? '').slice(0, 64), reason]);
    return { reported: true };
  }

  const followStatus = (actor, kind, id) => followState(db.query, actor, kind, id);
  // One item (a shared link), for whoever may see it.
  async function item(id, actor) {
    const a = await seeable(db.query, actor, id);
    const c = await circle(db.query, actor?.user?.id);
    const { items } = await page(db.query, [a], actor?.user?.id, c);
    if (!items.length) fail(404, 'Not found');
    return items[0];
  }

  return { record, forget, item, follow, followState, followStatus, feed, userFeed, clubFeed, kudos, commentsOf, comment, deleteComment, block, report, FOLLOW_KINDS };
}

module.exports = { createSocial };
