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
  const titleLines = wrap(card.title, width, card.lines && !story ? Math.min(titleSize, 56) : titleSize, story ? 4 : card.lines ? 1 : 2);
  const subSize = story ? 44 : 30;
  const subLines = wrap(card.subtitle, width, subSize, story ? 3 : 1);
  const out = [];
  let y = story ? 470 : 168;
  if (card.eyebrow) {
    out.push(`<text x="${pad}" y="${y}" font-size="${story ? 34 : 24}" font-weight="600" letter-spacing="${story ? 7 : 5}" fill="${LIME}">${esc(card.eyebrow.toUpperCase())}</text>`);
    y += story ? 120 : 72;
  }
  const tSize = card.lines && !story ? Math.min(titleSize, 56) : titleSize;
  for (const l of titleLines) {
    out.push(`<text x="${pad}" y="${y}" font-size="${tSize}" font-weight="800" fill="${MIST}">${esc(l)}</text>`);
    y += tSize * 1.08;
  }
  y += story ? 24 : 4;
  for (const l of subLines) {
    out.push(`<text x="${pad}" y="${y}" font-size="${subSize}" font-weight="400" fill="${MUTED}">${esc(l)}</text>`);
    y += subSize * 1.3;
  }
  if (card.lines && card.lines.length) {
    // A short table: "1  Arjun Mehta  1240", up to five rows.
    const rowH = story ? 104 : 46;
    let ly = story ? y + 60 : y + 8;
    for (const [i, line] of card.lines.slice(0, 5).entries()) {
      const size = story ? 48 : 28;
      out.push(`<text x="${pad}" y="${ly}" font-size="${size}" font-weight="800" fill="${i ? MUTED : LIME}">${i + 1}</text>`,
        `<text x="${pad + size * 1.6}" y="${ly}" font-size="${size}" font-weight="${i ? 600 : 800}" fill="${MIST}">${esc(wrap(line.name, width - size * 5, size, 1)[0] || '')}</text>`,
        line.value != null ? `<text x="${pad + width}" y="${ly}" font-size="${size}" font-weight="600" fill="${MUTED}" text-anchor="end">${esc(line.value)}</text>` : '');
      ly += rowH;
    }
  } else if (card.big) {
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

const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

function createCards({ db, goalsView = null, clubChallengeCard = null, seasonCard = null, raceCard = null }) {
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
    if (a.verb === 'goal') {
      return d.rival
        ? { eyebrow: `Club v club · ${sportName(a.sport) || 'Any sport'}`, title: `${d.club} won`, subtitle: `${d.title}`, big: `${d.value}–${d.against}`, bigLabel: d.metric }
        : { eyebrow: `Goal reached · ${sportName(a.sport) || 'Any sport'}`, title: d.club || (who ? who.name : 'Goal reached'), subtitle: d.title, big: String(d.value), bigLabel: d.metric };
    }
    if (a.verb === 'ladder') {
      return { eyebrow: `${d.ladder} · ${sportName(a.sport)}`, title: who ? who.name : 'A climber', subtitle: d.forfeit ? `took #${d.to} from ${d.beat} by default` : `beat ${d.beat} to climb from #${d.from}`, big: `#${d.to}`, bigLabel: d.score || null };
    }
    if (a.verb === 'club_v_club') {
      const kind = d.kind === 'tie' ? 'tie' : 'match';
      if (!d.winner) return { eyebrow: `Club v club · ${sportName(a.sport)}`, title: `${d.from} v ${d.to}`, subtitle: `A drawn ${kind}`, big: d.score, bigLabel: 'Final' };
      return { eyebrow: `Club v club · ${sportName(a.sport)}`, title: d.winner, subtitle: `beat ${d.loser} in a ${sportName(a.sport).toLowerCase()} ${kind}`, big: d.score, bigLabel: 'Final' };
    }
    if (a.verb === 'race') {
      const places = [d.genderPlace && `${ordinal(d.genderPlace)} ${d.genderName === 'Open' ? '' : `of the ${d.genderName.toLowerCase()}`}`.trim(), d.groupPlace && `${ordinal(d.groupPlace)} in ${d.ageGroup}`].filter(Boolean);
      return { eyebrow: `${d.name} · ${d.event}`, title: who ? who.name : 'A finisher', subtitle: `${ordinal(d.place)} of ${d.of}${places.length ? ` · ${places.join(' · ')}` : ''}`, big: d.time, bigLabel: `${d.pace} /km` };
    }
    if (a.verb === 'run') {
      const when = new Date(a.created_at).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
      return {
        eyebrow: d.pbs && d.pbs.length ? `Run · ${when} · New best ${d.pbs.join(', ')}` : `Run · ${when}`,
        title: who ? who.name : 'A runner', subtitle: [d.title, d.place].filter(Boolean).join(' · ') || `${d.time} · ${d.pace} /km`,
        big: `${d.km} km`, bigLabel: `${d.time} · ${d.pace} /km`,
      };
    }
    if (a.verb === 'season_match') {
      if (!d.winner) return { eyebrow: `${d.season} · Round ${d.round}`, title: `${d.a} v ${d.b}`, subtitle: 'All square', big: d.score, bigLabel: 'Draw' };
      return { eyebrow: `${d.season} · Round ${d.round}`, title: d.winner, subtitle: `beat ${d.loser}`, big: d.score, bigLabel: sportName(a.sport) };
    }
    if (a.verb === 'season_won') {
      return { eyebrow: `Champions · ${sportName(a.sport)}`, title: d.champion, subtitle: `won ${d.season}`, big: `${d.points} pts`, bigLabel: `${d.won} wins from ${d.played}` };
    }
    if (a.verb === 'joined' || a.verb === 'club') {
      return { eyebrow: a.verb === 'club' ? 'New club' : 'Joined the club', title: d.club, subtitle: `${who ? who.name : 'Someone'} ${a.verb === 'club' ? 'started it' : 'is in'} — join them on Tonament` };
    }
    return null;
  }

  // A ladder's top five (members' names: not when a profile is private or under 18).
  async function ladder(id) {
    const [l] = await db.query(`SELECT l.*, o.name AS club FROM ladders l JOIN orgs o ON o.id = l.org_id WHERE l.id = $1 AND l.status = 'active'`, [Number(id) || 0]);
    if (!l) return null;
    const rows = await db.query(
      `SELECT r.position, u.name, u.profile_public, u.birth_year, rt.rating FROM ladder_rungs r JOIN users u ON u.id = r.user_id
       LEFT JOIN ratings rt ON rt.user_id = r.user_id AND rt.sport = $2 WHERE r.ladder_id = $1 ORDER BY r.position LIMIT 5`,
      [l.id, l.sport],
    );
    const shown = (u) => u.profile_public && !(u.birth_year && u.birth_year > minorYear());
    return {
      eyebrow: `Ladder · ${sportName(l.sport)}`, title: l.name, subtitle: rows.length ? `${l.club} · challenge your way up` : 'Join and climb',
      lines: rows.map((r) => ({ name: shown(r) ? r.name : 'A member', value: r.rating ? String(r.rating) : null })),
    };
  }

  // A goal's progress (a club's total, the two clubs, or the people chasing it).
  async function goal(id) {
    const [g] = await db.query('SELECT id FROM goals WHERE id = $1', [Number(id) || 0]);
    if (!g || !goalsView) return null;
    const v = await goalsView(g.id);
    const left = v.ended ? 'Final' : `${v.daysLeft} day${v.daysLeft === 1 ? '' : 's'} left`;
    const eyebrow = `Goal · ${v.sport ? v.sport.name : 'Any sport'} · ${left}`;
    if (v.scope === 'versus') return { eyebrow, title: v.title, subtitle: `${v.metric} by members of each club`, lines: [v.club, v.rival].sort((a, b) => b.total - a.total).map((o) => ({ name: o.name, value: String(o.total) })) };
    if (v.scope === 'club') return { eyebrow, title: v.title, subtitle: v.club.name, big: `${v.total}/${v.target}`, bigLabel: `${v.metric} together` };
    const shown = await db.query(`SELECT id FROM users WHERE id = ANY($1::int[]) AND profile_public AND NOT (birth_year IS NOT NULL AND birth_year > $2)`, [v.board.map((p) => p.id), minorYear()]);
    const ok = new Set(shown.map((u) => u.id));
    return { eyebrow, title: v.title, subtitle: `${v.people} chasing it`, lines: v.board.slice(0, 5).map((p) => ({ name: ok.has(p.id) ? p.name : 'A player', value: `${p.value}/${v.target}` })) };
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

  const cc = async (id) => (clubChallengeCard ? clubChallengeCard(id) : null);
  const season = async (id) => (seasonCard ? seasonCard(id) : null);
  const race = async (id) => (raceCard ? raceCard(id) : null);
  const KINDS = { a: activity, club, p: player, t: tournament, ladder, goal, cc, season, race };
  // The PNG for /img/<kind>/<id>.png, or null.
  async function image(kind, id, size) {
    const make = KINDS[kind];
    const card = make ? await make(id) : null;
    return card ? render(card, size === 'story' ? 'story' : 'og') : null;
  }

  return { image, activity, club, player, tournament };
}

module.exports = { createCards, svgFor, render, SIZES };
