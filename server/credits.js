'use strict';

// AI credits: what the AI help costs, kept as a ledger (ai_credits). A pack
// is a flat fee per tournament: Create (setting it up with AI), Manage (the
// on-the-day assistant) or Both; a top-up adds Manage credits. Each AI call
// spends credits by its size, and a call that fails gives them back. Create
// credits bought before a tournament exists (on /new) sit on the organiser's
// account; spending takes the tournament's credits first, then the account's.
// Free: each account's first AI setup; a friend invited with your link gets
// their first Create; you get a Manage when they run a tournament; the
// Championship plan includes Both. When payments aren't set up (no
// Razorpay), nothing is charged and nothing is counted against anyone.

const PACKS = {
  create: { name: 'AI setup', credits: { create: 20 } },
  manage: { name: 'AI on the day', credits: { manage: 150 } },
  both: { name: 'AI setup + on the day', credits: { create: 20, manage: 150 } },
  topup: { name: 'AI top-up', credits: { manage: 100 } },
};
// Prices in paise; site admins can change them (site_settings.aiPrices).
const PRICES = { create: 9900, manage: 19900, both: 24900, topup: 9900 };
// Credits per call, by what it reads.
const COSTS = { draftText: 1, draftForm: 2, draftImage: 2, draftPdf: 2, mapping: 1, assist: 1, assistPhoto: 3 };
const FREE_FIRST = 5; // the first AI setup (a poster, and a retry or two)
const LOW = 0.2; // warn below 20% of what was granted
const BURST = { perMinute: 10, alertPerHour: 40 };

function createCredits({ db, fail, settings, billingEnabled }) {
  const enforced = () => Boolean(billingEnabled());
  async function prices(q = db.query) {
    const custom = (await settings.get('aiPrices', q)) || {};
    return Object.fromEntries(Object.keys(PRICES).map((k) => [k, Number.isInteger(custom[k]) && custom[k] >= 100 ? custom[k] : PRICES[k]]));
  }

  async function grant(q, { user = null, tournament = null, scope, credits, reason, ref = null, note = null }) {
    if (!credits) return null;
    const [row] = await q(
      `INSERT INTO ai_credits (user_id, tournament_id, scope, delta, reason, ref, note) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING RETURNING id`,
      [user, tournament, scope, credits, reason, ref, note],
    );
    return row || null;
  }
  async function grantPack(q, { pack, user = null, tournament = null, reason, ref = null }) {
    const p = PACKS[pack];
    if (!p) throw new Error(`Unknown AI pack ${pack}`);
    const out = [];
    for (const [scope, n] of Object.entries(p.credits)) out.push(await grant(q, { user, tournament, scope, credits: n, reason, ref: ref && `${ref}:${scope}`, note: p.name }));
    return out.some(Boolean);
  }

  // { create: { tournament, account, total }, manage: {…}, granted: {…} }.
  async function balance(q, { user = null, tournament = null }) {
    const rows = await q(
      `SELECT scope, (tournament_id IS NOT NULL) AS on_t, SUM(delta)::int AS left, SUM(GREATEST(delta, 0))::int AS granted
       FROM ai_credits WHERE (tournament_id = $2 AND $2::text IS NOT NULL) OR (user_id = $1 AND tournament_id IS NULL)
       GROUP BY scope, on_t`,
      [user, tournament],
    );
    const out = {};
    for (const scope of ['create', 'manage']) {
      const t = rows.find((r) => r.scope === scope && r.on_t) || { left: 0, granted: 0 };
      const a = rows.find((r) => r.scope === scope && !r.on_t) || { left: 0, granted: 0 };
      const total = t.left + a.left;
      const granted = t.granted + a.granted;
      out[scope] = { tournament: t.left, account: a.left, total, granted, low: granted > 0 && total <= Math.ceil(granted * LOW) };
    }
    return out;
  }

  // Spends `cost` credits of `scope` (the tournament's first, then the
  // account's) for one AI call; returns what to refund if the call fails.
  // A 402 (code ai_credits) when there aren't enough.
  async function spend(q, { user, tournament = null, scope, cost, note = null }) {
    if (!enforced()) return [];
    if (tournament) {
      const [t] = await q('SELECT ai_paused FROM tournaments WHERE id = $1', [tournament]);
      if (t && t.ai_paused) fail(423, 'AI help is paused for this tournament — contact us');
      const [{ n }] = await q(`SELECT COUNT(*)::int AS n FROM ai_credits WHERE tournament_id = $1 AND delta < 0 AND created_at > now() - interval '1 minute'`, [tournament]);
      if (n >= BURST.perMinute) fail(429, 'That\'s a lot at once — wait a moment and try again');
    }
    // The first AI setup is free (once per account).
    if (scope === 'create') await grant(q, { user, scope: 'create', credits: FREE_FIRST, reason: 'free', ref: `free:${user}` });
    const b = await balance(q, { user, tournament });
    if (b[scope].total < cost) fail(402, scope === 'create' ? 'Your AI setup credits have run out' : 'This tournament\'s AI credits have run out', 'ai_credits');
    const fromT = tournament ? Math.min(cost, Math.max(0, b[scope].tournament)) : 0;
    const rows = [];
    if (fromT) rows.push(await q(`INSERT INTO ai_credits (user_id, tournament_id, scope, delta, reason, note) VALUES ($1, $2, $3, $4, 'spend', $5) RETURNING id`, [user, tournament, scope, -fromT, note]));
    if (cost - fromT) rows.push(await q(`INSERT INTO ai_credits (user_id, tournament_id, scope, delta, reason, note) VALUES ($1, NULL, $2, $3, 'spend', $4) RETURNING id`, [user, scope, -(cost - fromT), note]));
    return rows.map((r) => r[0].id);
  }
  // A failed call gives its credits back.
  async function refund(q, ids) {
    for (const id of ids || []) {
      await q(
        `INSERT INTO ai_credits (user_id, tournament_id, scope, delta, reason, ref)
         SELECT user_id, tournament_id, scope, -delta, 'refund', 'spend:' || id FROM ai_credits WHERE id = $1 AND delta < 0
         ON CONFLICT DO NOTHING`, [id],
      );
    }
  }

  // ---------- what organisers see

  async function summary(actor, tournament = null) {
    if (!actor?.user) fail(401, 'Sign in first');
    const b = await balance(db.query, { user: actor.user.id, tournament });
    const [free] = await db.query(`SELECT 1 FROM ai_credits WHERE user_id = $1 AND reason = 'free'`, [actor.user.id]);
    return { enforced: enforced(), balance: b, freeFirst: !free, prices: await prices(), packs: Object.fromEntries(Object.entries(PACKS).map(([k, p]) => [k, { name: p.name, credits: p.credits }])), costs: COSTS };
  }

  // ---------- site admins: sold, used, cost, the busiest, pause

  async function adminUsage({ days = 30 } = {}) {
    const since = `now() - make_interval(days => ${Number(days) || 30})`;
    const [[sold], [money], busy, burst] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(delta) FILTER (WHERE delta > 0 AND reason = 'purchase'), 0)::int AS bought,
                       COALESCE(SUM(delta) FILTER (WHERE delta > 0 AND reason <> 'purchase' AND reason <> 'refund'), 0)::int AS given,
                       COALESCE(-SUM(delta) FILTER (WHERE reason = 'spend'), 0)::int AS spent,
                       COALESCE(SUM(delta) FILTER (WHERE reason = 'refund'), 0)::int AS refunded
                FROM ai_credits WHERE created_at > ${since}`),
      db.query(`SELECT COALESCE(SUM(amount - COALESCE(refunded_amount, 0)) FILTER (WHERE status IN ('paid', 'refunded')), 0)::int AS revenue,
                       COUNT(*) FILTER (WHERE status = 'paid')::int AS packs
                FROM payments WHERE kind = 'ai' AND paid_at > ${since}`),
      db.query(`SELECT c.tournament_id AS id, t.name, t.ai_paused AS paused, -SUM(c.delta)::int AS spent,
                       (SELECT COALESCE(SUM(a.cost_paise), 0)::int FROM ai_calls a WHERE a.tournament_id = c.tournament_id AND a.created_at > ${since}) AS cost
                FROM ai_credits c JOIN tournaments t ON t.id = c.tournament_id
                WHERE c.reason = 'spend' AND c.created_at > ${since} GROUP BY c.tournament_id, t.name, t.ai_paused ORDER BY spent DESC LIMIT 10`),
      db.query(`SELECT tournament_id AS id, -SUM(delta)::int AS spent FROM ai_credits WHERE reason = 'spend' AND tournament_id IS NOT NULL
                AND created_at > now() - interval '1 hour' GROUP BY tournament_id HAVING -SUM(delta) >= ${BURST.alertPerHour}`),
    ]);
    const [{ cost }] = await db.query(`SELECT COALESCE(SUM(cost_paise), 0)::int AS cost FROM ai_calls WHERE created_at > ${since}`);
    return { ...sold, ...money, cost, busy, alerts: burst, prices: await prices(), enforced: enforced() };
  }
  async function setPaused(id, paused) {
    const rows = await db.query('UPDATE tournaments SET ai_paused = $2 WHERE id = $1 RETURNING id', [String(id), Boolean(paused)]);
    if (!rows.length) fail(404, 'Tournament not found');
    return { paused: Boolean(paused) };
  }

  return { PACKS, COSTS, prices, grant, grantPack, balance, spend, refund, summary, adminUsage, setPaused, enforced };
}

module.exports = { createCredits, PACKS, PRICES, COSTS, FREE_FIRST };
