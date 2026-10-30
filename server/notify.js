'use strict';

// Notifications: the 🔔 inbox, pushes to people's phones, and email for the
// ones that need an answer. Each kind can be turned off per channel
// (users.notify_prefs). Push needs VAPID keys in the environment:
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (and VAPID_SUBJECT, a mailto: link);
// without them there's no push, and everything else still works. Email (and
// WhatsApp, once it's switched on) go through server/messaging.js.

const crypto = require('node:crypto');

// in-app is always on; push on unless turned off; email only where marked;
// WhatsApp only when someone turns it on (and has opted in to WhatsApp).
const KINDS = {
  comment: { label: 'Comments on your posts', email: false },
  kudos: { label: 'Kudos', email: false },
  follow: { label: 'New followers', email: false },
  club_request: { label: 'Requests to join your clubs', email: true },
  club_joined: { label: 'A club letting you in', email: false },
  confirm_game: { label: 'Results to confirm', email: false },
  challenge: { label: 'Challenges for you', email: true },
  challenge_reply: { label: 'Replies to your challenges', email: false },
  ladder: { label: 'Ladder moves', email: false },
  goal: { label: 'Goals reached', email: false },
  club_challenge: { label: 'Challenges to your club', email: true },
  club_result: { label: 'Club v club results', email: false },
  season: { label: 'Club seasons', email: false },
  club_run: { label: 'Club runs', email: false },
  race: { label: 'Race results', email: true },
  edition: { label: 'Tournaments you played, back again', email: true },
};
const PAGE = 40;
const DELIVERY_MS = 4000;

function createNotify({ db, fail, messaging = null, baseUrl = 'https://tonament.com' }) {
  const keys = () => (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
    ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY, subject: process.env.VAPID_SUBJECT || 'mailto:support@tonament.com' }
    : null);
  const needUser = (actor) => { if (!actor?.user) fail(401, 'Sign in first'); return actor.user; };
  const wants = (prefs, kind, channel) => {
    const p = (prefs || {})[kind] || {};
    if (channel === 'email') return p.email ?? KINDS[kind].email;
    if (channel === 'whatsapp') return p.whatsapp === true;
    return p[channel] !== false;
  };

  // ---------- sending

  // Tell each of `users` (ids) something; never the actor, nor anyone who's
  // blocked them (either way). dedupe: once per person per fact.
  async function send(q, { users, kind, actor = null, title, body = null, url = '/', dedupe = null }) {
    if (!KINDS[kind]) throw new Error(`Unknown notification kind ${kind}`);
    const ids = [...new Set(users.filter((id) => Number.isInteger(id) && id !== actor))];
    if (!ids.length) return [];
    const blocked = actor ? new Set((await q(
      'SELECT blocked_id AS id FROM blocks WHERE user_id = $1 UNION SELECT user_id FROM blocks WHERE blocked_id = $1', [actor],
    )).map((r) => r.id)) : new Set();
    const to = ids.filter((id) => !blocked.has(id));
    const sent = [];
    for (const id of to) {
      const [row] = await q(
        `INSERT INTO notifications (user_id, dedupe, kind, actor_id, title, body, url) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, dedupe) DO NOTHING RETURNING id`,
        [id, dedupe, kind, actor, title, body, url],
      );
      if (row) sent.push(id);
    }
    if (sent.length) await deliver(q, sent, { kind, title, body, url });
    return sent;
  }

  // Push and email, briefly (a slow push service never holds things up).
  async function deliver(q, ids, n) {
    const people = await q('SELECT id, email, phone, phone_verified_at, whatsapp_opt_in_at, notify_prefs, notify_token FROM users WHERE id = ANY($1::int[]) AND disabled_at IS NULL', [ids]);
    const jobs = [];
    const k = keys();
    if (k) {
      const pushTo = people.filter((p) => wants(p.notify_prefs, n.kind, 'push')).map((p) => p.id);
      const subs = pushTo.length ? await q('SELECT * FROM push_subscriptions WHERE user_id = ANY($1::int[])', [pushTo]) : [];
      if (subs.length) {
        const webpush = require('web-push');
        webpush.setVapidDetails(k.subject, k.publicKey, k.privateKey);
        const payload = JSON.stringify({ title: n.title, body: n.body || '', url: n.url });
        for (const s of subs) {
          jobs.push(webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600 })
            .catch(async (err) => {
              // Gone: the phone unsubscribed or the app was removed.
              if (err.statusCode === 404 || err.statusCode === 410) await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => {});
            }));
        }
      }
    }
    const email = messaging?.enabled('email');
    const whatsapp = messaging?.enabled('whatsapp');
    if (email || whatsapp) {
      const url = n.url.startsWith('http') ? n.url : baseUrl + n.url;
      for (const p of people) {
        const channels = [email && wants(p.notify_prefs, n.kind, 'email') && 'email', whatsapp && wants(p.notify_prefs, n.kind, 'whatsapp') && 'whatsapp'].filter(Boolean);
        if (!channels.length) continue;
        const token = p.notify_token || await tokenFor(q, p.id);
        const unsubscribeUrl = `${baseUrl}/api/notifications/unsubscribe?t=${token}&k=${n.kind}`;
        jobs.push(messaging.send(q, { user: p, template: 'notice', channels, data: { title: n.title, body: n.body, url, unsubscribeUrl } }));
      }
    }
    if (!jobs.length) return;
    await Promise.race([Promise.allSettled(jobs), new Promise((r) => { setTimeout(r, DELIVERY_MS).unref?.(); })]);
  }
  async function tokenFor(q, userId) {
    const token = crypto.randomBytes(18).toString('base64url');
    const [row] = await q('UPDATE users SET notify_token = COALESCE(notify_token, $1) WHERE id = $2 RETURNING notify_token', [token, userId]);
    return row.notify_token;
  }

  // ---------- the inbox

  async function list(actor, { before = null } = {}) {
    const me = needUser(actor);
    const rows = await db.query(
      `SELECT n.*, u.name AS actor_name, u.photo_id FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = $1 AND ($2::int IS NULL OR n.id < $2) ORDER BY n.id DESC LIMIT ${PAGE}`,
      [me.id, before ? Number(before) : null],
    );
    return {
      items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, url: r.url, at: r.created_at, read: Boolean(r.read_at), actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null })),
      next: rows.length === PAGE ? rows[rows.length - 1].id : null,
    };
  }
  async function unread(actor) {
    if (!actor?.user) return { unread: 0 };
    const [{ n }] = await db.query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [actor.user.id]);
    return { unread: n };
  }
  async function markRead(actor, { ids = null } = {}) {
    const me = needUser(actor);
    if (Array.isArray(ids)) await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::int[]) AND read_at IS NULL', [me.id, ids.map(Number).filter(Boolean)]);
    else await db.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [me.id]);
    return unread(actor);
  }

  // ---------- settings

  async function settings(actor) {
    const me = needUser(actor);
    const [u] = await db.query('SELECT notify_prefs, phone_verified_at, whatsapp_opt_in_at FROM users WHERE id = $1', [me.id]);
    const [{ n }] = await db.query('SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [me.id]);
    return {
      push: { available: Boolean(keys()), publicKey: keys()?.publicKey || null, devices: n },
      email: Boolean(messaging?.enabled('email')),
      // WhatsApp: shown once it's switched on; it needs a confirmed number and an opt-in.
      whatsapp: messaging?.enabled('whatsapp') ? { phone: Boolean(u.phone_verified_at), optedIn: Boolean(u.whatsapp_opt_in_at) } : null,
      kinds: Object.entries(KINDS).map(([kind, k]) => ({
        kind, label: k.label, push: wants(u.notify_prefs, kind, 'push'), email: wants(u.notify_prefs, kind, 'email'),
        ...(messaging?.enabled('whatsapp') && { whatsapp: wants(u.notify_prefs, kind, 'whatsapp') }),
      })),
    };
  }
  async function setPref(actor, { kind, channel, on }) {
    const me = needUser(actor);
    if (!KINDS[kind] || !['push', 'email', 'whatsapp'].includes(channel)) fail(400, 'Unknown setting');
    if (channel === 'whatsapp' && !messaging?.enabled('whatsapp')) fail(400, 'WhatsApp isn\'t available yet');
    await db.query(
      `UPDATE users SET notify_prefs = jsonb_set(notify_prefs, $2::text[], $3::jsonb, true) WHERE id = $1`,
      [me.id, `{${kind}}`, JSON.stringify({ ...(await prefOf(me.id, kind)), [channel]: Boolean(on) })],
    );
    return settings(actor);
  }
  async function prefOf(userId, kind) {
    const [u] = await db.query('SELECT notify_prefs FROM users WHERE id = $1', [userId]);
    return (u.notify_prefs || {})[kind] || {};
  }

  // This phone: push on (the browser's subscription) or off.
  async function subscribe(actor, sub = {}) {
    const me = needUser(actor);
    const endpoint = String(sub.endpoint || '');
    const k = sub.keys || {};
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !k.p256dh || !k.auth) fail(400, 'That push subscription isn\'t valid');
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [me.id, endpoint, String(k.p256dh).slice(0, 200), String(k.auth).slice(0, 100)],
    );
    return settings(actor);
  }
  async function unsubscribe(actor, { endpoint }) {
    const me = needUser(actor);
    await db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [me.id, String(endpoint || '')]);
    return settings(actor);
  }

  // The link in an email: that kind (or all) of email off, no sign-in needed.
  async function unsubscribeEmail(token, kind) {
    const [u] = await db.query('SELECT id, notify_prefs FROM users WHERE notify_token = $1', [String(token || '')]);
    if (!u) return false;
    const prefs = { ...(u.notify_prefs || {}) };
    for (const k of KINDS[kind] ? [kind] : Object.keys(KINDS)) prefs[k] = { ...(prefs[k] || {}), email: false };
    await db.query('UPDATE users SET notify_prefs = $1::jsonb WHERE id = $2', [JSON.stringify(prefs), u.id]);
    return KINDS[kind] ? KINDS[kind].label : 'All';
  }

  return { KINDS, send, list, unread, markRead, settings, setPref, subscribe, unsubscribe, unsubscribeEmail };
}

module.exports = { createNotify };
