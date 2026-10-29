'use strict';

// Clubs: any page (orgs) as a club people belong to — a club, team, academy,
// venue, company, school or coaching squad. Free to make and join; members
// have a feed, a leaderboard and (later) challenges. The paid yearly page
// (orgs.js) is the public, searchable /@slug on top.
//
// club_members are the players (by account); org_members stay the page team,
// who are club admins too.

const crypto = require('node:crypto');
const sports = require('./sports');

const ROLES = ['admin', 'captain', 'coach', 'player'];
const ROLE_NAMES = { admin: 'Admin', captain: 'Captain', coach: 'Coach', player: 'Player' };

function createClubs({ db, fail, orgs, social, mediaUrl }) {
  const needUser = (actor) => { if (!actor?.user) fail(401, 'Sign in first'); return actor.user; };
  const token = () => crypto.randomBytes(9).toString('base64url');

  async function load(q, slug, { lock = false } = {}) {
    const [o] = await q(`SELECT * FROM orgs WHERE slug = $1${lock ? ' FOR UPDATE' : ''}`, [String(slug || '').toLowerCase()]);
    if (!o) fail(404, 'Club not found');
    return o;
  }
  async function membership(q, o, actor) {
    if (!actor?.user) return null;
    const [m] = await q('SELECT role, status FROM club_members WHERE org_id = $1 AND user_id = $2', [o.id, actor.user.id]);
    return m || null;
  }
  // Club admins: admin members, the page team, and site admins.
  async function isAdmin(q, o, actor) {
    if (!actor?.user) return false;
    if (actor.user.isAdmin) return true;
    const m = await membership(q, o, actor);
    if (m && m.status === 'active' && m.role === 'admin') return true;
    const [editor] = await q('SELECT 1 FROM org_members WHERE org_id = $1 AND email = $2', [o.id, actor.user.email]);
    return Boolean(editor);
  }
  async function needAdmin(q, o, actor) {
    if (!(await isAdmin(q, o, actor))) fail(actor?.user ? 403 : 401, 'Only the club\'s admins can do this');
  }

  // ---------- views

  async function roster(q, o) {
    const rows = await q(
      `SELECT u.id, u.name, u.handle, u.photo_id, m.role, m.status, m.joined_at FROM club_members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 ORDER BY (m.role = 'admin') DESC, (m.role IN ('captain', 'coach')) DESC, u.name`,
      [o.id],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, handle: r.handle, photo: r.photo_id ? mediaUrl(r.photo_id) : null, role: r.role, roleName: ROLE_NAMES[r.role], status: r.status, joinedAt: r.joined_at }));
  }

  // Members ranked: titles, then finals, then ranking points this year, then group wins.
  async function leaderboard(q, o) {
    const rows = await q(
      `SELECT u.id, u.name, u.handle, u.photo_id,
              COUNT(*) FILTER (WHERE r.finish = 'W')::int AS titles,
              COUNT(*) FILTER (WHERE r.finish = 'F')::int AS finals,
              COALESCE(SUM(r.points) FILTER (WHERE r.finished_at > now() - interval '364 days'), 0)::int AS points,
              COALESCE(SUM(r.won), 0)::int AS won, COALESCE(SUM(r.lost), 0)::int AS lost,
              (SELECT COALESCE(SUM(gm.wins), 0)::int FROM group_members gm WHERE gm.user_id = u.id) AS group_wins
       FROM club_members m JOIN users u ON u.id = m.user_id LEFT JOIN event_results r ON r.email = u.email
       WHERE m.org_id = $1 AND m.status = 'active'
       GROUP BY u.id ORDER BY titles DESC, finals DESC, points DESC, group_wins DESC, u.name LIMIT 100`,
      [o.id],
    );
    return rows.map((r, i) => ({ rank: i + 1, id: r.id, name: r.name, handle: r.handle, photo: r.photo_id ? mediaUrl(r.photo_id) : null, titles: r.titles, finals: r.finals, points: r.points, won: r.won + r.group_wins, lost: r.lost }));
  }

  // The club as the app shows it, to anyone (the paid page is the public, indexed one).
  async function clubView(slug, actor, { invite = null } = {}) {
    const q = db.query;
    const o = await load(q, slug);
    const media = await orgs.mediaFor(o);
    const me = await membership(q, o, actor);
    const admin = await isAdmin(q, o, actor);
    const people = await roster(q, o);
    const active = people.filter((p) => p.status === 'active');
    const follow = await social.followState(q, actor, 'club', o.id);
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      kind: o.kind,
      kindName: orgs.KIND_NAMES[o.kind] || 'Club',
      city: o.city,
      sports: (o.sports || []).filter((id) => sports.get(id)).map((id) => ({ id, name: sports.get(id).name })),
      about: o.about,
      logo: media.logo,
      cover: media.cover,
      open: o.open,
      pagePublic: orgs.isPublic(o),
      members: active.length,
      roster: active,
      requests: admin ? people.filter((p) => p.status === 'requested') : [],
      me: me ? { role: me.role, status: me.status } : null,
      follow,
      invite: admin || (me && me.status === 'active') ? o.invite_token : null,
      inviteOk: Boolean(invite && o.invite_token && invite === o.invite_token),
      leaderboard: await leaderboard(q, o),
      can: { admin, editPage: admin },
    };
  }

  // A new club (free): the page, its maker as admin, and a line in the feed.
  async function create(actor, input = {}) {
    needUser(actor);
    const made = await orgs.createOrg(actor, { kind: 'club', ...input });
    const [o] = await db.query('SELECT * FROM orgs WHERE slug = $1', [made.slug]);
    if (input.open === false) await db.query('UPDATE orgs SET open = false WHERE id = $1', [o.id]);
    await social.record(db.query, {
      dedupe: `club:${o.id}`, actor: actor.user.id, org: o.id, verb: 'club', object: ['club', o.id],
      data: { club: o.name, slug: o.slug, kind: o.kind, city: o.city },
    });
    return clubView(o.slug, actor);
  }

  // ---------- joining

  async function join(slug, actor, input = {}) {
    const me = needUser(actor);
    const joined = await db.tx(async (q) => {
      const o = await load(q, slug, { lock: true });
      const [m] = await q('SELECT status FROM club_members WHERE org_id = $1 AND user_id = $2', [o.id, me.id]);
      if (m && m.status === 'active') return { o, status: 'active', already: true };
      const invited = Boolean(input.invite && o.invite_token && input.invite === o.invite_token);
      const status = o.open || invited ? 'active' : 'requested';
      await q(
        `INSERT INTO club_members (org_id, user_id, status) VALUES ($1, $2, $3)
         ON CONFLICT (org_id, user_id) DO UPDATE SET status = EXCLUDED.status, joined_at = now()`,
        [o.id, me.id, status],
      );
      if (status === 'active') await joinedActivity(q, o, me.id);
      return { o, status };
    });
    return { ...(await clubView(slug, actor)), joined: joined.status, already: Boolean(joined.already) };
  }
  const joinedActivity = (q, o, userId) => social.record(q, {
    dedupe: `joined:${o.id}:${userId}`, actor: userId, org: o.id, verb: 'joined', object: ['club', o.id],
    data: { club: o.name, slug: o.slug, kind: o.kind },
  });

  async function leave(slug, actor) {
    const me = needUser(actor);
    return db.tx(async (q) => {
      const o = await load(q, slug, { lock: true });
      const admins = await q(`SELECT user_id FROM club_members WHERE org_id = $1 AND role = 'admin' AND status = 'active'`, [o.id]);
      if (admins.length === 1 && admins[0].user_id === me.id) {
        const [others] = await q(`SELECT 1 FROM club_members WHERE org_id = $1 AND user_id <> $2 AND status = 'active' LIMIT 1`, [o.id, me.id]);
        if (others) fail(409, 'Make someone else an admin before you leave');
      }
      await q('DELETE FROM club_members WHERE org_id = $1 AND user_id = $2', [o.id, me.id]);
      await q('DELETE FROM activity WHERE dedupe = $1', [`joined:${o.id}:${me.id}`]);
      return { left: true };
    });
  }

  // Admins: let in or decline, change a role, remove.
  async function setMember(slug, actor, userId, input = {}) {
    await db.tx(async (q) => {
      const o = await load(q, slug, { lock: true });
      await needAdmin(q, o, actor);
      const id = Number(userId) || 0;
      const [m] = await q('SELECT * FROM club_members WHERE org_id = $1 AND user_id = $2', [o.id, id]);
      if (!m) fail(404, 'Not a member');
      const action = input.action;
      if (action === 'approve') {
        await q(`UPDATE club_members SET status = 'active', joined_at = now() WHERE org_id = $1 AND user_id = $2`, [o.id, id]);
        await joinedActivity(q, o, id);
      } else if (action === 'decline' || action === 'remove') {
        if (m.role === 'admin' && action === 'remove') {
          const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM club_members WHERE org_id = $1 AND role = 'admin' AND status = 'active'`, [o.id]);
          if (n <= 1) fail(409, 'A club needs at least one admin');
        }
        await q('DELETE FROM club_members WHERE org_id = $1 AND user_id = $2', [o.id, id]);
        await q('DELETE FROM activity WHERE dedupe = $1', [`joined:${o.id}:${id}`]);
      } else if (action === 'role') {
        if (!ROLES.includes(input.role)) fail(400, 'Pick a role');
        if (m.role === 'admin' && input.role !== 'admin') {
          const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM club_members WHERE org_id = $1 AND role = 'admin' AND status = 'active'`, [o.id]);
          if (n <= 1) fail(409, 'A club needs at least one admin');
        }
        await q('UPDATE club_members SET role = $1 WHERE org_id = $2 AND user_id = $3', [input.role, o.id, id]);
      } else {
        fail(400, 'Unknown action');
      }
    });
    return clubView(slug, actor);
  }

  // Admins: open or by approval; a new invite link (the old one stops working).
  async function settings(slug, actor, input = {}) {
    await db.tx(async (q) => {
      const o = await load(q, slug, { lock: true });
      await needAdmin(q, o, actor);
      if (input.open !== undefined) await q('UPDATE orgs SET open = $1 WHERE id = $2', [Boolean(input.open), o.id]);
      if (input.newInvite) await q('UPDATE orgs SET invite_token = $1 WHERE id = $2', [token(), o.id]);
    });
    return clubView(slug, actor);
  }

  // ---------- lists

  // The clubs I'm in (or asked to join), and pages I edit.
  async function mine(actor) {
    if (!actor?.user) return [];
    const rows = await db.query(
      `SELECT o.slug, o.name, o.kind, o.city, m.role, m.status,
              (SELECT COUNT(*)::int FROM club_members x WHERE x.org_id = o.id AND x.status = 'active') AS members
       FROM club_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY o.name`,
      [actor.user.id],
    );
    return rows.map((r) => ({ slug: r.slug, name: r.name, kind: r.kind, kindName: orgs.KIND_NAMES[r.kind] || 'Club', city: r.city, role: r.role, status: r.status, members: r.members }));
  }
  // Clubs to discover: by city and sport, biggest first.
  async function discover({ city = '', sport = '', q: term = '' } = {}) {
    const like = `%${String(term).trim().slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await db.query(
      `SELECT o.slug, o.name, o.kind, o.city, o.sports,
              (SELECT COUNT(*)::int FROM club_members x WHERE x.org_id = o.id AND x.status = 'active') AS members
       FROM orgs o
       WHERE ($1 = '' OR lower(o.city) = lower($1)) AND ($2 = '' OR $2 = ANY(o.sports)) AND ($3 = '%%' OR o.name ILIKE $3)
       ORDER BY members DESC, o.name LIMIT 40`,
      [String(city).slice(0, 60), String(sport).slice(0, 30), like],
    );
    return rows.map((r) => ({ slug: r.slug, name: r.name, kind: r.kind, kindName: orgs.KIND_NAMES[r.kind] || 'Club', city: r.city, members: r.members }));
  }
  // "Plays for": a player's clubs (their profile).
  async function clubsOf(q, userId) {
    const rows = await q(
      `SELECT o.slug, o.name, o.kind, m.role FROM club_members m JOIN orgs o ON o.id = m.org_id
       WHERE m.user_id = $1 AND m.status = 'active' ORDER BY m.joined_at`,
      [userId],
    );
    return rows.map((r) => ({ slug: r.slug, name: r.name, kindName: orgs.KIND_NAMES[r.kind] || 'Club', role: r.role }));
  }

  async function feed(slug, actor, opts) {
    const o = await load(db.query, slug);
    return social.clubFeed(o.id, actor, opts);
  }

  const exists = async (slug) => Boolean((await db.query('SELECT 1 FROM orgs WHERE slug = $1', [String(slug || '').toLowerCase()]))[0]);

  return { ROLES, exists, create, clubView, join, leave, setMember, settings, mine, discover, clubsOf, feed, token };
}

module.exports = { createClubs };
