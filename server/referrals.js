'use strict';

// Referrals: organisers invite organisers, and both get a free plan upgrade.
// - Every account can have a code (users.ref_code) for its invite link, which
//   also rides along on the "Run your own tournament" links of the pages they
//   share (tournament pages, the venue display, group pages).
// - A friend who signs up through it gets their first tournament on the Club
//   plan (a "welcome" credit, used up when they create it).
// - Once the friend runs a tournament for real (started with 10+ confirmed
//   entries), the inviter earns a Club upgrade credit, an Open one on every
//   3rd friend, and a month more on their academy / venue page.
// Credits move one of their tournaments up a plan, with no payment.

const crypto = require('node:crypto');
const { TIERS, billingConfig } = require('./billing');

const QUALIFY_ENTRIES = 10; // confirmed entries in the friend's tournament
const MILESTONE = 3; // every 3rd friend earns an Open credit too
const YEARLY_CAP = 10; // referral credits a year
const rank = (plan) => (plan === 'pass' ? 99 : plan === 'free' || !plan ? 0 : TIERS.findIndex((x) => x.id === plan) + 1);
const tierName = (id) => (TIERS.find((x) => x.id === id) || {}).name || id;
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'A friend';

function createReferrals({ db, fail, mailer = null, baseUrl = '', confirmWaiting, orgGraceDays = 14 }) {
  const enabled = () => billingConfig().enabled;

  // ---------- codes

  const CODE = /^[a-z0-9]{4,24}$/;
  async function codeFor(q, user) {
    const [row] = await q('SELECT ref_code, name FROM users WHERE id = $1', [user.id]);
    if (row && row.ref_code) return row.ref_code;
    const base = (firstName(row ? row.name : user.name).toLowerCase().normalize('NFKD').replace(/[^a-z]/g, '') || 'friend').slice(0, 12);
    for (let i = 0; i < 8; i++) {
      const code = `${base}${crypto.randomInt(10, 1000)}`;
      const [set] = await q('UPDATE users SET ref_code = $1 WHERE id = $2 AND ref_code IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE ref_code = $1) RETURNING ref_code', [code, user.id]);
      if (set) return set.ref_code;
      const [again] = await q('SELECT ref_code FROM users WHERE id = $1', [user.id]);
      if (again && again.ref_code) return again.ref_code;
    }
    fail(500, 'Couldn\'t make an invite code — try again');
  }

  // The invite banner: who's inviting (first name only).
  async function lookup(code) {
    if (!enabled() || !CODE.test(String(code || ''))) return null;
    const [row] = await db.query('SELECT name FROM users WHERE ref_code = $1 AND disabled_at IS NULL AND NOT guest', [String(code)]);
    return row ? { name: firstName(row.name) } : null;
  }

  // ---------- the friend

  // A new account that came through an invite link. Same transaction as the signup.
  async function attach(q, user, code) {
    if (!enabled() || !code || !CODE.test(String(code))) return;
    const [inviter] = await q('SELECT id, email FROM users WHERE ref_code = $1 AND disabled_at IS NULL', [String(code)]);
    if (!inviter || inviter.id === user.id || inviter.email === user.email) return;
    const [me] = await q('UPDATE users SET referred_by = $1, referred_at = now() WHERE id = $2 AND referred_by IS NULL RETURNING id', [inviter.id, user.id]);
    if (!me) return;
    await q(`INSERT INTO plan_credits (user_id, tier, reason, friend_id) VALUES ($1, 'club', 'welcome', $2) ON CONFLICT DO NOTHING`, [user.id, inviter.id]);
  }

  // Their first tournament starts on the Club plan. Returns who it's from, or null.
  async function useWelcome(q, user, tournamentId) {
    if (!enabled()) return null;
    const [credit] = await q(
      `SELECT c.id, u.name FROM plan_credits c LEFT JOIN users u ON u.id = c.friend_id
       WHERE c.user_id = $1 AND c.reason = 'welcome' AND c.used_at IS NULL FOR UPDATE OF c`,
      [user.id],
    );
    if (!credit) return null;
    await q('UPDATE plan_credits SET used_at = now(), tournament_id = $1 WHERE id = $2', [tournamentId, credit.id]);
    await q(`UPDATE tournaments SET plan = 'club', plan_updated_at = now() WHERE id = $1 AND plan = 'free'`, [tournamentId]);
    return { from: firstName(credit.name), plan: 'Club', entries: TIERS[0].limit };
  }

  // The gift waiting for their first tournament (for the banner), or null.
  async function welcomeFor(user) {
    if (!enabled() || !user) return null;
    const [c] = await db.query(
      `SELECT u.name FROM plan_credits c LEFT JOIN users u ON u.id = c.friend_id WHERE c.user_id = $1 AND c.reason = 'welcome' AND c.used_at IS NULL`,
      [user.id],
    );
    return c ? { from: firstName(c.name), plan: 'Club', entries: TIERS[0].limit } : null;
  }

  // ---------- the inviter

  // When a tournament starts: if its owner was invited and this is real use
  // (10+ confirmed entries), the inviter earns their reward, once per friend.
  async function qualify(q, tournamentId) {
    if (!enabled()) return null;
    const [owner] = await q(
      `SELECT u.id, u.name, u.referred_by FROM members m JOIN users u ON u.email = m.email
       WHERE m.tournament_id = $1 AND m.role = 'owner' LIMIT 1`,
      [tournamentId],
    );
    if (!owner || !owner.referred_by) return null;
    const [{ n }] = await q('SELECT COUNT(*)::int AS n FROM entries WHERE tournament_id = $1 AND confirmed AND NOT withdrawn AND NOT solo AND paired_into IS NULL', [tournamentId]);
    if (n < QUALIFY_ENTRIES) return null;
    const [inviter] = await q('SELECT id, name, email FROM users WHERE id = $1 AND disabled_at IS NULL', [owner.referred_by]);
    if (!inviter) return null;
    const [{ year }] = await q(`SELECT COUNT(*)::int AS year FROM plan_credits WHERE user_id = $1 AND reason = 'referral' AND created_at > now() - interval '365 days'`, [inviter.id]);
    if (year >= YEARLY_CAP) return null;
    const [earned] = await q(
      `INSERT INTO plan_credits (user_id, tier, reason, friend_id) VALUES ($1, 'club', 'referral', $2) ON CONFLICT DO NOTHING RETURNING id`,
      [inviter.id, owner.id],
    );
    if (!earned) return null; // already rewarded for this friend
    const [{ friends }] = await q(`SELECT COUNT(*)::int AS friends FROM plan_credits WHERE user_id = $1 AND reason = 'referral'`, [inviter.id]);
    let milestone = false;
    if (friends % MILESTONE === 0) {
      const [m] = await q(`INSERT INTO plan_credits (user_id, tier, reason, friend_id) VALUES ($1, 'open', 'milestone', $2) ON CONFLICT DO NOTHING RETURNING id`, [inviter.id, owner.id]);
      milestone = Boolean(m);
    }
    // A month more on an academy / venue page they own (while it's live).
    const pages = await q(
      `UPDATE orgs SET paid_until = paid_until + interval '30 days'
       WHERE paid_until > now() - interval '${orgGraceDays} days'
         AND id IN (SELECT org_id FROM org_members WHERE email = $1 AND role = 'owner') RETURNING name`,
      [inviter.email],
    );
    const reward = { inviter, friend: owner.name, milestone, pages: pages.map((p) => p.name) };
    if (mailer && mailer.enabled) {
      const { referralEarnedEmail } = require('./email');
      mailer.send({ to: inviter.email, ...referralEarnedEmail({ name: firstName(inviter.name), friend: firstName(owner.name), milestone, pages: reward.pages, url: `${baseUrl}/invite` }) })
        .catch((err) => console.error('Referral email:', err.message));
    }
    return reward;
  }

  // The Invite page: the link, friends and credits.
  async function summary(actor) {
    if (!actor.user) fail(401, 'Sign in to invite organisers');
    const code = await codeFor(db.query, actor.user);
    const [friends, credits] = await Promise.all([
      db.query(
        `SELECT u.id, u.name, u.referred_at, EXISTS (SELECT 1 FROM plan_credits c WHERE c.user_id = $1 AND c.reason = 'referral' AND c.friend_id = u.id) AS qualified
         FROM users u WHERE u.referred_by = $1 ORDER BY u.referred_at DESC LIMIT 100`,
        [actor.user.id],
      ),
      db.query(
        `SELECT c.id, c.tier, c.reason, c.created_at, c.used_at, c.tournament_id, t.name AS tournament
         FROM plan_credits c LEFT JOIN tournaments t ON t.id = c.tournament_id WHERE c.user_id = $1 ORDER BY c.created_at DESC`,
        [actor.user.id],
      ),
    ]);
    const qualified = friends.filter((f) => f.qualified).length;
    return {
      enabled: enabled(),
      code,
      url: `${baseUrl}/?ref=${code}`,
      friends: friends.map((f) => ({ name: firstName(f.name), joinedAt: f.referred_at, qualified: f.qualified })),
      qualified,
      toMilestone: MILESTONE - (qualified % MILESTONE),
      qualifyEntries: QUALIFY_ENTRIES,
      credits: credits.map((c) => ({ id: c.id, tier: c.tier, tierName: tierName(c.tier), reason: c.reason, createdAt: c.created_at, usedAt: c.used_at, tournament: c.tournament_id ? { id: c.tournament_id, name: c.tournament } : null })),
    };
  }

  // Unused credits that would move this plan up ([{ id, tier, tierName }]).
  async function creditsFor(q, user, plan) {
    if (!enabled() || !user) return [];
    const rows = await q(`SELECT id, tier FROM plan_credits WHERE user_id = $1 AND used_at IS NULL AND reason <> 'welcome' ORDER BY created_at`, [user.id]);
    return rows.filter((c) => rank(c.tier) > rank(plan)).map((c) => ({ id: c.id, tier: c.tier, tierName: tierName(c.tier) }));
  }

  // Moves a tournament the user manages up to the credit's plan. t: the locked tournament row.
  async function useCredit(q, user, t, creditId) {
    if (!enabled()) fail(409, 'Plans aren\'t limited right now');
    const [c] = await q('SELECT * FROM plan_credits WHERE id = $1 AND user_id = $2 FOR UPDATE', [Number(creditId) || 0, user.id]);
    if (!c || c.reason === 'welcome') fail(404, 'Credit not found');
    if (c.used_at) fail(409, 'This credit has already been used');
    if (rank(c.tier) <= rank(t.plan)) fail(409, `This tournament is already on the ${tierName(t.plan) || t.plan} plan or bigger`);
    await q('UPDATE plan_credits SET used_at = now(), tournament_id = $1 WHERE id = $2', [t.id, c.id]);
    await q('UPDATE tournaments SET plan = $1, plan_updated_at = now() WHERE id = $2', [c.tier, t.id]);
    const [fresh] = await q('SELECT * FROM tournaments WHERE id = $1', [t.id]);
    await confirmWaiting(q, fresh);
    return { plan: c.tier, planName: tierName(c.tier) };
  }

  return { codeFor, lookup, attach, welcomeFor, useWelcome, qualify, summary, creditsFor, useCredit, QUALIFY_ENTRIES, MILESTONE, YEARLY_CAP };
}

module.exports = { createReferrals };
