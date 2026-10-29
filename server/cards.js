'use strict';

// Share cards: PNG images for link previews (1200×630) and Instagram stories
// (1080×1920), drawn as SVG in the brand (Deep Navy, Electric Lime, Outfit)
// and rasterised with resvg. One per thing worth sharing: a title or final, a
// confirmed game, a club, a player, a tournament. Only what's public: the
// URLs are open, so private tournaments, private profiles and under-18s get
// no card (404). Served at /img/<kind>/<id>.png and cached at the CDN.

const fs = require('node:fs');
const path = require('node:path');
const sports = require('./sports');

// The brand's colours (docs/BRAND.md); images can't use the CSS variables.
const NAVY = '#0B1220';
const LIME = '#A3E635';
const MIST = '#E5E7EB';
const SLATE = '#475569';
const MUTED = '#94A3B8';

const SIZES = { og: [1200, 630], story: [1080, 1920] };
const FONTS = ['Regular', 'SemiBold', 'ExtraBold'].map((w) => path.join(__dirname, 'fonts', `Outfit-${w}.ttf`));
const MINOR_AGE = 18;

const LOGO = fs.readFileSync(path.join(__dirname, '..', 'public', 'brand', 'logo-white.svg'), 'utf8')
  .replace(/<title>.*?<\/title>/, '').replace(/ role="img"| aria-label="[^"]*"/g, '');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Roughly how wide a line of Outfit ExtraBold is (capitals and figures are wider).
const textWidth = (text, size) => [...String(text)].reduce((w, c) => w + size * (/[A-Z]/.test(c) ? 0.74 : /[0-9]/.test(c) ? 0.6 : /[–—-]/.test(c) ? 0.55 : 0.52), 0);
// Outfit is about half an em wide per letter on average: enough to wrap lines.
function wrap(text, maxWidth, size, maxLines) {
  const per = Math.max(1, Math.floor(maxWidth / (size * 0.54)));
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length <= per) line = next;
    else {
      if (line) lines.push(line);
      line = w.length > per ? `${w.slice(0, per - 1)}…` : w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, per - 1).replace(/\s+\S*$/, '')}…`;
    return kept;
  }
  return lines;
}

// A card: { eyebrow, title, subtitle, big, bigLabel } on navy with the brand's
// lime slashes, in either size. Fixed zones: the logo at the top, the words
// below it (smaller when long), the big number at the bottom, the tagline last.
function svgFor(card, size = 'og') {
  const [W, H] = SIZES[size] || SIZES.og;
  const story = size === 'story';
  const pad = story ? 90 : 72;
  const width = W - pad * 2 - (story ? 60 : 200);
  const long = (card.title || '').length;
  const titleSize = story ? (long > 22 ? 84 : 104) : long > 30 ? 52 : long > 20 ? 60 : 72;
  const titleLines = wrap(card.title, width, titleSize, story ? 4 : 2);
  const subSize = story ? 44 : 30;
  const subLines = wrap(card.subtitle, width, subSize, story ? 3 : 1);
  const out = [];
  let y = story ? 470 : 168;
  if (card.eyebrow) {
    out.push(`<text x="${pad}" y="${y}" font-size="${story ? 34 : 24}" font-weight="600" letter-spacing="${story ? 7 : 5}" fill="${LIME}">${esc(card.eyebrow.toUpperCase())}</text>`);
    y += story ? 120 : 72;
  }
  for (const l of titleLines) {
    out.push(`<text x="${pad}" y="${y}" font-size="${titleSize}" font-weight="800" fill="${MIST}">${esc(l)}</text>`);
    y += titleSize * 1.08;
  }
  y += story ? 24 : 4;
  for (const l of subLines) {
    out.push(`<text x="${pad}" y="${y}" font-size="${subSize}" font-weight="400" fill="${MUTED}">${esc(l)}</text>`);
    y += subSize * 1.3;
  }
  if (card.big) {
    // Bottom zone: the number, with its label beside it (og) or below it (story).
    const bigSize = story ? 190 : 92;
    const base = story ? H - 470 : H - 104;
    out.push(`<text x="${pad}" y="${base}" font-size="${bigSize}" font-weight="800" fill="${LIME}">${esc(card.big)}</text>`);
    if (card.bigLabel) {
      out.push(story
        ? `<text x="${pad}" y="${base + 76}" font-size="40" font-weight="600" fill="${MIST}">${esc(card.bigLabel)}</text>`
        : `<text x="${pad + textWidth(card.big, bigSize) + 28}" y="${base}" font-size="28" font-weight="600" fill="${MIST}">${esc(card.bigLabel)}</text>`);
    }
  }
  // Lime slashes at about 25°, as in the brand imagery.
  const slashes = story
    ? `<polygon points="${W - 170},${H} ${W - 60},${H} ${W},${H - 130} ${W},${H - 370}" fill="${LIME}"/><polygon points="${W - 260},${H} ${W - 225},${H} ${W},${H - 480} ${W},${H - 555}" fill="${SLATE}" opacity="0.5"/>`
    : `<polygon points="${W - 250},${H} ${W - 160},${H} ${W},${H - 340} ${W},${H - 540}" fill="${LIME}"/><polygon points="${W - 340},${H} ${W - 305},${H} ${W},${H - 630} ${W},${H - 705}" fill="${SLATE}" opacity="0.5"/>`;
  const logoH = story ? 56 : 40;
  const tag = story
    ? `<text x="${pad}" y="${H - 200}" font-size="34" font-weight="600" fill="${MIST}">tonament.com</text>
  <text x="${pad}" y="${H - 140}" font-size="26" font-weight="600" letter-spacing="5" fill="${MUTED}">ONE PLATFORM. EVERY SPORT.</text>
  <text x="${pad}" y="${H - 100}" font-size="26" font-weight="600" letter-spacing="5" fill="${LIME}">EVERY TOURNAMENT.</text>`
    : `<text x="${pad}" y="${H - 44}" font-size="16" font-weight="600" letter-spacing="3" fill="${MUTED}">TONAMENT.COM · ONE PLATFORM. EVERY SPORT. <tspan fill="${LIME}">EVERY TOURNAMENT.</tspan></text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${NAVY}"/>
  ${slashes}
  <svg x="${pad}" y="${story ? 140 : 60}" height="${logoH}" width="${(logoH * 582) / 72}" viewBox="0 0 582 72">${LOGO.replace(/^<svg[^>]*>|<\/svg>\s*$/g, '')}</svg>
  ${out.join('\n  ')}
  ${tag}
</svg>`;
}

function render(card, size = 'og') {
  const { Resvg } = require('@resvg/resvg-js');
  const r = new Resvg(svgFor(card, size), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Outfit' } });
  return r.render().asPng();
}

function createCards({ db }) {
  const minorYear = () => new Date().getFullYear() - MINOR_AGE;
  const sportName = (id) => (sports.get(id) || sports.info(id) || {}).name || '';
  const FINISH = { W: 'Champion', F: 'Finalist' };

  // A feed item (public ones only).
  async function activity(id) {
    const [a] = await db.query(`SELECT * FROM activity WHERE id = $1 AND visibility = 'public'`, [Number(id) || 0]);
    if (!a) return null;
    const people = await db.query('SELECT id, name, birth_year FROM users WHERE id = ANY($1::int[])', [a.people]);
    if (people.some((p) => p.birth_year && p.birth_year > minorYear())) return null;
    const who = people.find((p) => p.id === a.actor_id) || people[0];
    const d = a.data || {};
    if (a.verb === 'finish') {
      return { eyebrow: `${FINISH[d.finish] || 'Podium'} · ${sportName(a.sport)}`, title: who ? who.name : 'Champion', subtitle: `${d.event} · ${d.tournament}`, big: d.finish === 'W' ? 'WINNER' : 'FINAL', bigLabel: d.entries ? `${d.entries} entries` : null };
    }
    if (a.verb === 'game') {
      const won = d.winner === 'a' ? d.a : d.b;
      const lost = d.winner === 'a' ? d.b : d.a;
      return { eyebrow: `Game won · ${sportName(a.sport)}`, title: (won || []).join(' & '), subtitle: `beat ${(lost || []).join(' & ')}`, big: d.score };
    }
    if (a.verb === 'challenge') {
      const won = d.winner === 'a' ? d.a : d.b;
      const lost = d.winner === 'a' ? d.b : d.a;
      return { eyebrow: `${d.back ? 'Rematch' : 'Challenge'} won · ${sportName(a.sport)}`, title: (won || []).join(' & '), subtitle: `beat ${(lost || []).join(' & ')}`, big: d.score, bigLabel: 'Your move?' };
    }
    if (a.verb === 'joined' || a.verb === 'club') {
      return { eyebrow: a.verb === 'club' ? 'New club' : 'Joined the club', title: d.club, subtitle: `${who ? who.name : 'Someone'} ${a.verb === 'club' ? 'started it' : 'is in'} — join them on Tonament` };
    }
    return null;
  }

  async function club(slug) {
    const [o] = await db.query(
      `SELECT o.*, (SELECT COUNT(*)::int FROM club_members m WHERE m.org_id = o.id AND m.status = 'active') AS members FROM orgs o WHERE o.slug = $1`,
      [String(slug || '').toLowerCase()],
    );
    if (!o) return null;
    const { KIND_NAMES } = require('./orgs');
    return {
      eyebrow: [KIND_NAMES[o.kind] || 'Club', o.city].filter(Boolean).join(' · '),
      title: o.name,
      subtitle: (o.sports || []).map(sportName).filter(Boolean).join(' · ') || 'On Tonament',
      big: String(o.members), bigLabel: `member${o.members === 1 ? '' : 's'} · join the club`,
    };
  }

  async function player(handle) {
    const [u] = await db.query('SELECT * FROM users WHERE handle = $1 AND disabled_at IS NULL', [String(handle || '').toLowerCase()]);
    if (!u || !u.profile_public || (u.birth_year && u.birth_year > minorYear())) return null;
    const [r] = await db.query(
      `SELECT COUNT(*) FILTER (WHERE finish = 'W')::int AS titles, COALESCE(SUM(won), 0)::int AS won, COALESCE(SUM(lost), 0)::int AS lost
       FROM event_results WHERE email = $1`,
      [u.email],
    );
    const clubs = await db.query(`SELECT o.name FROM club_members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 AND m.status = 'active' ORDER BY m.joined_at LIMIT 2`, [u.id]);
    return {
      eyebrow: [(u.sports || []).map(sportName).filter(Boolean).slice(0, 2).join(' · '), u.city].filter(Boolean).join(' · ') || 'Player',
      title: u.name,
      subtitle: clubs.length ? `Plays for ${clubs.map((c) => c.name).join(', ')}` : 'On Tonament',
      big: r.titles ? `${r.titles} title${r.titles === 1 ? '' : 's'}` : r.won + r.lost ? `${r.won}–${r.lost}` : null,
      bigLabel: r.titles ? `${r.won}–${r.lost} in tournaments` : r.won + r.lost ? 'won–lost in tournaments' : null,
    };
  }

  async function tournament(id) {
    const [t] = await db.query(`SELECT * FROM tournaments WHERE id = $1 AND visibility <> 'private'`, [String(id || '')]);
    if (!t) return null;
    const [{ n, events }] = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM entries WHERE tournament_id = $1 AND NOT withdrawn) AS n, (SELECT COUNT(*)::int FROM events WHERE tournament_id = $1) AS events`,
      [t.id],
    );
    const when = t.starts_on ? new Date(`${String(t.starts_on).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null;
    return {
      eyebrow: [sportName(t.sport), t.city].filter(Boolean).join(' · '),
      title: t.name,
      subtitle: [when, t.venue].filter(Boolean).join(' · ') || 'Live scores on Tonament',
      big: n ? String(n) : null,
      bigLabel: n ? `entries${events > 1 ? ` · ${events} events` : ''}` : null,
    };
  }

  const KINDS = { a: activity, club, p: player, t: tournament };
  // The PNG for /img/<kind>/<id>.png, or null.
  async function image(kind, id, size) {
    const make = KINDS[kind];
    const card = make ? await make(id) : null;
    return card ? render(card, size === 'story' ? 'story' : 'og') : null;
  }

  return { image, activity, club, player, tournament };
}

module.exports = { createCards, svgFor, render, SIZES };
