'use strict';

// Academy, venue and club pages (tonament.com/@slug): a yearly paid page with
// the organisation's profile, contact, courts and coaching, photos and the
// tournaments it runs. Members (owner + editors, by email) edit it; it's
// public while paid for, plus a short grace period.

const crypto = require('node:crypto');
const sports = require('./sports');
const { normalizeEmail, validEmail } = require('./auth');

const KINDS = ['academy', 'venue', 'club'];
const KIND_NAMES = { academy: 'Academy', venue: 'Venue', club: 'Club' };
const GRACE_DAYS = 14;
const PHOTO_LIMIT = 24;
const COACHING_LIMIT = 10;
const ORG_MEDIA = ['logo', 'cover', 'photo'];
// Slugs that would clash with pages, app routes or look official.
const RESERVED = new Set(['admin', 'api', 't', 'new', 'signin', 'signup', 'forgot', 'reset', 'sports', 'features', 'pricing', 'faq',
  'how-it-works', 'contact', 'terms', 'privacy', 'refunds', 'delivery', 'tonament', 'support', 'help', 'www', 'app', 'edit', 'settings',
  'official', 'team', 'about', 'blog', 'login', 'logout', 'mine', 'slug']);

function createOrgs({ db, fail, text, imageType, maxImageBytes, mediaUrl, billingConfig, razorpay, adminLog, requireSiteAdmin, settings, orgCards, tournamentAccess }) {
  // ---------- helpers

  const slugOf = (value) => String(value || '').trim().toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
  function checkSlug(slug) {
    if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(slug)) return 'Use 3–30 letters, numbers or dashes';
    if (RESERVED.has(slug) || sports.get(slug) || sports.info(slug)) return 'That name is reserved — try another';
    return null;
  }
  const isLive = (o) => Boolean(o.paid_until && Date.parse(o.paid_until) > Date.now());
  const isPublic = (o) => Boolean(o.paid_until && Date.parse(o.paid_until) + GRACE_DAYS * 86400000 > Date.now());
  // Tournament branding (logo, sponsors, the organiser-led display) comes with
  // the page when the admin turns it on, site-wide or for this academy.
  async function includesBranding(q, o) {
    if (!o || !isLive(o)) return false;
    if (o.branding_override != null) return o.branding_override;
    return Boolean(await settings.get('orgIncludesBranding', q));
  }

  async function load(q, slug, { lock = false } = {}) {
    const [o] = await q(`SELECT * FROM orgs WHERE slug = $1${lock ? ' FOR UPDATE' : ''}`, [String(slug || '').toLowerCase()]);
    if (!o) fail(404, 'Page not found');
    return o;
  }
  async function roleOf(q, o, actor) {
    if (actor?.user?.isAdmin) return 'admin';
    if (!actor?.user) return null;
    const [m] = await q('SELECT role FROM org_members WHERE org_id = $1 AND email = $2', [o.id, actor.user.email]);
    return m ? m.role : null;
  }
  const RANK = { editor: 1, owner: 2, admin: 3 };
  async function needRole(q, o, actor, need) {
    const role = await roleOf(q, o, actor);
    if ((RANK[role] || 0) < RANK[need]) fail(actor?.user ? 403 : 401, need === 'owner' ? 'Only the page owner can do this' : 'Only this page\'s team can do this');
    return role;
  }

  // A tidy link: https:// added; only http(s).
  function url(value, label) {
    const s = text(value, label, { max: 200, optional: true });
    if (!s) return null;
    const u = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    try {
      const parsed = new URL(u);
      if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname.includes('.')) throw new Error();
      return parsed.toString();
    } catch {
      return fail(400, `${label}: enter a web address`);
    }
  }
  // "@smashpoint", "instagram.com/smashpoint" or a full URL -> the handle.
  function instagram(value) {
    const s = text(value, 'Instagram', { max: 120, optional: true });
    if (!s) return null;
    const handle = s.replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '');
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) fail(400, 'Instagram: enter your handle, like @smashpoint');
    return handle;
  }
  function phone(value, label) {
    const s = text(value, label, { max: 20, optional: true });
    if (!s) return null;
    const digits = s.replace(/[^\d+]/g, '');
    if (digits.replace(/\D/g, '').length < 8) fail(400, `${label}: enter a phone number`);
    return digits;
  }

  // ---------- views

  async function mediaOf(q, o) {
    const rows = await q('SELECT id, kind, caption FROM org_media WHERE org_id = $1 ORDER BY kind, position, created_at', [o.id]);
    const one = (kind) => rows.find((m) => m.kind === kind);
    return {
      logo: one('logo') ? mediaUrl(one('logo').id) : null,
      logoId: one('logo') ? one('logo').id : null,
      cover: one('cover') ? mediaUrl(one('cover').id) : null,
      coverId: one('cover') ? one('cover').id : null,
      photos: rows.filter((m) => m.kind === 'photo').map((m) => ({ id: m.id, url: mediaUrl(m.id), caption: m.caption })),
    };
  }

  function fields(o) {
    return {
      id: o.id,
      slug: o.slug,
      name: o.name,
      kind: o.kind,
      kindName: KIND_NAMES[o.kind] || 'Academy',
      sports: (o.sports || []).filter((id) => sports.get(id)).map((id) => ({ id, name: sports.get(id).name })),
      about: o.about,
      location: { address: o.address, city: o.city, region: o.region, postcode: o.postcode, country: o.country },
      contact: { phone: o.phone, whatsapp: o.whatsapp, email: o.email, website: o.website, instagram: o.instagram },
      courts: o.courts,
      timings: o.timings,
      coaching: o.coaching || [],
      accent: o.accent,
    };
  }

  // The page as the app shows it (and its editor): everything for members.
  async function view(q, o, actor) {
    const role = await roleOf(q, o, actor);
    const member = Boolean(role);
    if (!member && !isPublic(o)) fail(404, 'Page not found');
    const media = await mediaOf(q, o);
    const branded = await includesBranding(q, o);
    const out = {
      ...fields(o),
      ...media,
      live: isLive(o),
      public: isPublic(o),
      paidUntil: o.paid_until,
      graceUntil: o.paid_until ? new Date(Date.parse(o.paid_until) + GRACE_DAYS * 86400000).toISOString() : null,
      brandingIncluded: branded,
      price: billingConfig().orgPrice,
      tournaments: await orgCards(q, o.id, { includePrivate: member }),
      can: { edit: member, own: RANK[role] >= RANK.owner },
      role,
    };
    if (member) {
      out.members = await q('SELECT email, role FROM org_members WHERE org_id = $1 ORDER BY role DESC, email', [o.id]);
      out.photoLimit = PHOTO_LIMIT;
    }
    return out;
  }

  // ---------- organisers

  async function createOrg(actor, input = {}) {
    if (!actor?.user) fail(401, 'Sign in to create a page');
    const name = text(input.name, 'Name', { max: 80 });
    const kind = KINDS.includes(input.kind) ? input.kind : 'academy';
    const slug = slugOf(input.slug || name);
    const bad = checkSlug(slug);
    if (bad) fail(400, `Page address: ${bad}`);
    const city = text(input.city, 'City', { max: 60, optional: true });
    const address = text(input.address, 'Address', { max: 160, optional: true });
    const country = text(input.country, 'Country', { max: 60, optional: true });
    const wanted = Array.isArray(input.sports) ? input.sports.filter((id) => sports.get(id)).slice(0, 10) : [];
    return db.tx(async (q) => {
      const [taken] = await q('SELECT 1 FROM orgs WHERE slug = $1', [slug]);
      if (taken) fail(409, `tonament.com/@${slug} is taken — try another`);
      const [o] = await q(
        'INSERT INTO orgs (slug, name, kind, city, address, country, sports) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
        [slug, name, kind, city, address, country, wanted],
      );
      await q(`INSERT INTO org_members (org_id, email, role) VALUES ($1, $2, 'owner')`, [o.id, actor.user.email]);
      return view(q, o, actor);
    });
  }

  // Is a page address free? (as the organiser types)
  async function slugStatus(value) {
    const slug = slugOf(value);
    const bad = checkSlug(slug);
    if (bad) return { slug, available: false, reason: bad };
    const [taken] = await db.query('SELECT 1 FROM orgs WHERE slug = $1', [slug]);
    return { slug, available: !taken, reason: taken ? 'Taken — try another' : null };
  }

  const getOrg = async (slug, actor) => view(db.query, await load(db.query, slug), actor);

  async function mine(actor) {
    if (!actor?.user) return [];
    const rows = await db.query(
      `SELECT o.*, m.role FROM org_members m JOIN orgs o ON o.id = m.org_id WHERE m.email = $1 ORDER BY o.name`,
      [actor.user.email],
    );
    return rows.map((o) => ({ slug: o.slug, name: o.name, kind: o.kind, role: o.role, live: isLive(o), paidUntil: o.paid_until }));
  }

  async function updateOrg(slug, actor, input = {}) {
    return db.tx(async (q) => {
      const o = await load(q, slug, { lock: true });
      await needRole(q, o, actor, 'editor');
      const set = {};
      const has = (k) => input[k] !== undefined;
      if (has('name')) set.name = text(input.name, 'Name', { max: 80 });
      if (has('kind')) set.kind = KINDS.includes(input.kind) ? input.kind : o.kind;
      if (has('about')) {
        const about = typeof input.about === 'string' ? input.about.trim().replace(/\r\n/g, '\n') : '';
        if (about.length > 3000) fail(400, 'About must be at most 3,000 characters');
        set.about = about || null;
      }
      for (const [k, label, max] of [['address', 'Address', 160], ['city', 'City', 60], ['region', 'State', 60], ['postcode', 'PIN code', 12], ['country', 'Country', 60]]) {
        if (has(k)) set[k] = text(input[k], label, { max, optional: true });
      }
      if (has('courts')) set.courts = text(input.courts, 'Courts', { max: 300, optional: true });
      if (has('timings')) set.timings = text(input.timings, 'Timings', { max: 300, optional: true });
      if (has('phone')) set.phone = phone(input.phone, 'Phone');
      if (has('whatsapp')) set.whatsapp = phone(input.whatsapp, 'WhatsApp');
      if (has('email')) {
        const email = normalizeEmail(input.email);
        if (email && !validEmail(email)) fail(400, 'Enter a valid email address');
        set.email = email || null;
      }
      if (has('website')) set.website = url(input.website, 'Website');
      if (has('instagram')) set.instagram = instagram(input.instagram);
      if (has('accent')) {
        const accent = input.accent ? String(input.accent).trim().toUpperCase() : null;
        if (accent && !/^#[0-9A-F]{6}$/.test(accent)) fail(400, 'Brand colour must be a hex colour like #F97316');
        set.accent = accent;
      }
      if (has('sports')) {
        if (!Array.isArray(input.sports)) fail(400, 'sports must be a list');
        set.sports = [...new Set(input.sports.filter((id) => sports.get(id)))];
      }
      if (has('coaching')) {
        if (!Array.isArray(input.coaching)) fail(400, 'coaching must be a list');
        if (input.coaching.length > COACHING_LIMIT) fail(400, `Up to ${COACHING_LIMIT} coaching programmes`);
        set.coaching = JSON.stringify(input.coaching.map((c = {}) => ({
          title: text(c.title, 'Programme name', { max: 80 }),
          who: text(c.who, 'Who it\'s for', { max: 120, optional: true }),
          when: text(c.when, 'When', { max: 120, optional: true }),
          fee: text(c.fee, 'Fee', { max: 60, optional: true }),
        })));
      }
      const keys = Object.keys(set);
      if (keys.length) {
        const cols = keys.map((k, i) => `${k} = $${i + 1}${k === 'coaching' ? '::jsonb' : ''}`).join(', ');
        await q(`UPDATE orgs SET ${cols} WHERE id = $${keys.length + 1}`, [...keys.map((k) => set[k]), o.id]);
      }
      return view(q, { ...o, ...set, coaching: set.coaching ? JSON.parse(set.coaching) : o.coaching }, actor);
    });
  }

  async function uploadMedia(slug, actor, input = {}) {
    const kind = input.kind;
    if (!ORG_MEDIA.includes(kind)) fail(400, 'kind must be logo, cover or photo');
    const raw = typeof input.data === 'string' ? input.data.replace(/^data:[^,]*,/, '') : '';
    const bytes = Buffer.from(raw, 'base64');
    if (!bytes.length) fail(400, 'Choose an image to upload');
    if (bytes.length > maxImageBytes) fail(413, 'That image is too large — try a smaller one');
    const mime = imageType(bytes);
    if (!mime) fail(400, 'Upload a JPEG, PNG or WebP image');
    const caption = text(input.caption, 'Caption', { max: 120, optional: true });
    return db.tx(async (q) => {
      const o = await load(q, slug, { lock: true });
      await needRole(q, o, actor, 'editor');
      if (kind !== 'photo') await q('DELETE FROM org_media WHERE org_id = $1 AND kind = $2', [o.id, kind]); // one logo, one cover
      const [{ n, last }] = await q('SELECT COUNT(*)::int AS n, COALESCE(MAX(position), 0)::int AS last FROM org_media WHERE org_id = $1 AND kind = $2', [o.id, kind]);
      if (kind === 'photo' && n >= PHOTO_LIMIT) fail(400, `You can add up to ${PHOTO_LIMIT} photos`);
      const id = crypto.createHash('sha256').update(`org:${o.id}:${kind}:`).update(bytes).digest('hex').slice(0, 32);
      await q(
        `INSERT INTO org_media (id, org_id, kind, mime, bytes, caption, position) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET caption = EXCLUDED.caption`,
        [id, o.id, kind, mime, bytes, caption, last + 1],
      );
      return view(q, o, actor);
    });
  }

  async function deleteMedia(slug, actor, mediaId) {
    return db.tx(async (q) => {
      const o = await load(q, slug, { lock: true });
      await needRole(q, o, actor, 'editor');
      await q('DELETE FROM org_media WHERE id = $1 AND org_id = $2', [String(mediaId), o.id]);
      return view(q, o, actor);
    });
  }

  // Images are public (they're on public pages); nothing else is stored in them.
  async function getMedia(mediaId) {
    const [m] = await db.query('SELECT mime, bytes FROM org_media WHERE id = $1', [String(mediaId)]);
    return m ? { mime: m.mime, bytes: Buffer.from(m.bytes), public: true } : null;
  }

  async function addMember(slug, actor, input = {}) {
    const email = normalizeEmail(input.email);
    if (!validEmail(email)) fail(400, 'Enter a valid email address');
    return db.tx(async (q) => {
      const o = await load(q, slug, { lock: true });
      await needRole(q, o, actor, 'owner');
      const [existing] = await q('SELECT role FROM org_members WHERE org_id = $1 AND email = $2', [o.id, email]);
      if (existing?.role === 'owner') fail(409, 'That person is the owner');
      await q(`INSERT INTO org_members (org_id, email, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING`, [o.id, email]);
      return view(q, o, actor);
    });
  }

  async function removeMember(slug, actor, email) {
    return db.tx(async (q) => {
      const o = await load(q, slug, { lock: true });
      await needRole(q, o, actor, 'owner');
      await q(`DELETE FROM org_members WHERE org_id = $1 AND email = $2 AND role <> 'owner'`, [o.id, normalizeEmail(email)]);
      return view(q, o, actor);
    });
  }

  // ---------- the yearly payment (one Razorpay order per year)

  async function checkout(slug, actor) {
    const cfg = billingConfig();
    if (!cfg.enabled) fail(503, 'Payments aren\'t set up yet');
    const { o, paymentId } = await db.tx(async (q) => {
      const o = await load(q, slug, { lock: true });
      await needRole(q, o, actor, 'owner');
      const [row] = await q(
        `INSERT INTO payments (org_id, tournament_name, user_email, amount, currency, kind, tier)
         VALUES ($1, $2, $3, $4, $5, 'org', 'org') RETURNING id`,
        [o.id, o.name, actor.user.email, cfg.orgPrice, cfg.currency],
      );
      return { o, paymentId: row.id };
    });
    let order;
    try {
      order = await razorpay(cfg).createOrder({
        amount: cfg.orgPrice, currency: cfg.currency, receipt: `tn_${paymentId}`,
        notes: { org: o.slug, name: o.name.slice(0, 200), plan: 'org-year', email: actor.user.email },
      });
    } catch (err) {
      console.error('Razorpay order failed:', err.message);
      await db.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
      fail(502, 'Couldn\'t start the payment — please try again in a moment');
    }
    await db.query('UPDATE payments SET order_id = $1 WHERE id = $2', [order.id, paymentId]);
    return {
      orderId: order.id, keyId: cfg.keyId, amount: cfg.orgPrice, currency: cfg.currency,
      name: cfg.business.name || 'Tonament', description: `${KIND_NAMES[o.kind] || 'Academy'} page — 1 year — ${o.name}`,
      prefill: { name: actor.user.name || '', email: actor.user.email },
    };
  }

  // A paid year starts now, or when the current year ends (renewing early).
  async function applyPayment(q, p) {
    if (!p.org_id) return;
    await q(`UPDATE orgs SET paid_until = GREATEST(now(), COALESCE(paid_until, now())) + interval '1 year' WHERE id = $1`, [p.org_id]);
  }
  // A refunded year can be taken back.
  async function takeBackYear(q, orgId) {
    await q(`UPDATE orgs SET paid_until = paid_until - interval '1 year' WHERE id = $1 AND paid_until IS NOT NULL`, [orgId]);
  }

  // ---------- tournaments on the page

  async function linkTournament(tournamentId, actor, slug) {
    return db.tx(async (q) => {
      await tournamentAccess(q, tournamentId, actor); // manage rights on the tournament
      if (!slug) {
        await q('UPDATE tournaments SET org_id = NULL WHERE id = $1', [tournamentId]);
        return { org: null };
      }
      const o = await load(q, slug);
      await needRole(q, o, actor, 'editor');
      await q('UPDATE tournaments SET org_id = $1 WHERE id = $2', [o.id, tournamentId]);
      return { org: { slug: o.slug, name: o.name } };
    });
  }

  // For a tournament's view: its academy, and whether the academy's page brings branding.
  async function forTournament(q, orgId) {
    if (!orgId) return { org: null, branding: false };
    const [o] = await q('SELECT * FROM orgs WHERE id = $1', [orgId]);
    if (!o) return { org: null, branding: false };
    return { org: { slug: o.slug, name: o.name, kindName: KIND_NAMES[o.kind] || 'Academy', public: isPublic(o) }, branding: await includesBranding(q, o) };
  }

  // The public page's data (null when there's no public page).
  async function page(slug) {
    const [o] = await db.query('SELECT * FROM orgs WHERE slug = $1', [String(slug || '').toLowerCase()]);
    if (!o || !isPublic(o)) return null;
    return { ...fields(o), ...(await mediaOf(db.query, o)), tournaments: await orgCards(db.query, o.id, { includePrivate: false }) };
  }

  async function sitemapOrgs() {
    const rows = await db.query(`SELECT slug, paid_until FROM orgs WHERE paid_until > now() - interval '${GRACE_DAYS} days' ORDER BY slug`);
    return rows.map((r) => ({ path: `/@${r.slug}`, lastmod: new Date().toISOString().slice(0, 10) }));
  }

  // ---------- site admin

  async function adminOrgs(actor, { q: term = '' } = {}) {
    requireSiteAdmin(actor);
    const like = `%${String(term).trim().slice(0, 80).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await db.query(
      `SELECT o.*, (SELECT m.email FROM org_members m WHERE m.org_id = o.id AND m.role = 'owner' LIMIT 1) AS owner,
              (SELECT COUNT(*)::int FROM tournaments t WHERE t.org_id = o.id) AS tournaments
       FROM orgs o WHERE ($1 = '%%' OR o.name ILIKE $1 OR o.slug ILIKE $1 OR COALESCE(o.city, '') ILIKE $1)
       ORDER BY o.created_at DESC LIMIT 200`,
      [like],
    );
    const site = Boolean(await settings.get('orgIncludesBranding'));
    return {
      orgs: rows.map((o) => ({
        id: o.id, slug: o.slug, name: o.name, kindName: KIND_NAMES[o.kind], city: o.city, owner: o.owner, tournaments: o.tournaments,
        paidUntil: o.paid_until, live: isLive(o), public: isPublic(o), createdAt: o.created_at,
        brandingOverride: o.branding_override, brandingIncluded: isLive(o) && (o.branding_override ?? site),
      })),
      siteBranding: site,
    };
  }

  // { brandingOverride: true | false | null, extendDays: n, unpublish: true }
  async function adminUpdate(actor, id, input = {}) {
    requireSiteAdmin(actor);
    return db.tx(async (q) => {
      const [o] = await q('SELECT * FROM orgs WHERE id = $1 FOR UPDATE', [Number(id) || 0]);
      if (!o) fail(404, 'Page not found');
      if (input.brandingOverride !== undefined) {
        const v = input.brandingOverride === null ? null : Boolean(input.brandingOverride);
        await q('UPDATE orgs SET branding_override = $1 WHERE id = $2', [v, o.id]);
        await adminLog(q, actor, 'org.branding', o.slug, { name: o.name, from: o.branding_override, to: v });
      }
      if (input.extendDays !== undefined) {
        const days = Number(input.extendDays);
        if (!Number.isInteger(days) || days < -3650 || days > 3650 || !days) fail(400, 'extendDays must be a whole number of days');
        await q(`UPDATE orgs SET paid_until = GREATEST(now(), COALESCE(paid_until, now())) + ($1 || ' days')::interval WHERE id = $2`, [String(days), o.id]);
        await adminLog(q, actor, 'org.extend', o.slug, { name: o.name, days });
      }
      if (input.unpublish) {
        await q(`UPDATE orgs SET paid_until = now() - interval '${GRACE_DAYS + 1} days' WHERE id = $1`, [o.id]);
        await adminLog(q, actor, 'org.unpublish', o.slug, { name: o.name });
      }
      return { ok: true };
    });
  }

  async function adminDelete(actor, id) {
    requireSiteAdmin(actor);
    return db.tx(async (q) => {
      const [o] = await q('SELECT * FROM orgs WHERE id = $1', [Number(id) || 0]);
      if (!o) fail(404, 'Page not found');
      await q('UPDATE tournaments SET org_id = NULL WHERE org_id = $1', [o.id]);
      await q('DELETE FROM orgs WHERE id = $1', [o.id]);
      await adminLog(q, actor, 'org.delete', o.slug, { name: o.name });
      return { ok: true };
    });
  }

  return {
    GRACE_DAYS, KIND_NAMES, slugOf, createOrg, slugStatus, getOrg, mine, updateOrg, uploadMedia, deleteMedia, getMedia, addMember, removeMember,
    checkout, applyPayment, takeBackYear, linkTournament, forTournament, page, sitemapOrgs, adminOrgs, adminUpdate, adminDelete,
  };
}

// Site-wide settings the admin can change, cached for a minute per instance.
function createSettings(db) {
  const DEFAULTS = { orgIncludesBranding: false, duprSubmit: false };
  let cache = null;
  let at = 0;
  // q: a transaction's query, when called inside one.
  async function all(q = db.query) {
    if (cache && Date.now() - at < 60000) return cache;
    const rows = await q('SELECT key, value FROM site_settings');
    cache = { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
    at = Date.now();
    return cache;
  }
  return {
    DEFAULTS,
    all,
    get: async (key, q) => (await all(q))[key],
    async set(key, value, email) {
      await db.query(
        `INSERT INTO site_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), email],
      );
      cache = null;
    },
  };
}

module.exports = { createOrgs, createSettings, GRACE_DAYS };
