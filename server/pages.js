'use strict';

// Server-rendered HTML for search engines, link previews and a fast first
// view: tournament pages (/t/<id>) and the sitemap. The app takes over the
// page once it loads (see the "prerender" check in public/app.js).

const catalog = require('../public/sports/events');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// JSON inside <script>: never let a value close the tag.
const jsonScript = (data) => JSON.stringify(data).replace(/</g, '\\u003c');

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Sat 2 – Sun 3 Nov 2030" (spelled out here: server locales differ).
function dateRange(from, to) {
  const parts = (iso) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return { wd: WD[d.getUTCDay()], day: d.getUTCDate(), mon: MON[d.getUTCMonth()], year: d.getUTCFullYear() };
  };
  const a = parts(from);
  const full = (p) => `${p.wd} ${p.day} ${p.mon} ${p.year}`;
  if (!to) return full(a);
  const b = parts(to);
  if (a.year === b.year && a.mon === b.mon) return `${a.wd} ${a.day} – ${full(b)}`;
  if (a.year === b.year) return `${a.wd} ${a.day} ${a.mon} – ${full(b)}`;
  return `${full(a)} – ${full(b)}`;
}

const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
const prizeTotal = (t) => t.events.reduce((sum, e) => sum + (e.prizes || []).reduce((s, p) => s + (p.cash || 0), 0), 0);

// One line for previews and the meta description.
function summary(t) {
  const names = t.events.map((e) => e.name);
  const events = names.length > 1 || names[0] !== 'Open'
    ? `${t.sport.name}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` +${names.length - 4} more` : ''}`
    : t.sport.name;
  const prize = prizeTotal(t);
  const status = t.entriesOpen ? 'Entries open' : t.status === 'completed' ? 'Results' : t.status === 'setup' ? null : 'Live scores';
  return [
    t.startsOn ? dateRange(t.startsOn, t.endsOn) : null,
    [t.venue, t.location.city].filter(Boolean).join(', '),
    events,
    prize ? `🏆 ${rupees(prize)} in prizes` : null,
    status,
  ].filter(Boolean).join(' · ');
}

// schema.org SportsEvent, for Google's event results. Google needs a start
// date and a place, so there's none without them.
function eventData(t, base, image) {
  const L = t.location;
  if (!t.startsOn || !(t.venue || L.city)) return null;
  const open = t.events.filter((e) => e.entriesOpen);
  const fees = open.map((e) => e.fee || 0);
  const organizer = t.official ? 'Tonament' : t.branding && t.branding.orgName;
  return {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: t.name,
    url: `${base}/t/${t.id}`,
    description: summary(t),
    sport: t.sport.name,
    startDate: t.startsOn,
    endDate: t.endsOn || t.startsOn,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    location: {
      '@type': 'Place',
      name: t.venue || L.city,
      address: {
        '@type': 'PostalAddress',
        ...(L.address && { streetAddress: L.address }),
        ...(L.city && { addressLocality: L.city }),
        ...(L.region && { addressRegion: L.region }),
        ...(L.postcode && { postalCode: L.postcode }),
        ...(L.country && { addressCountry: L.country }),
      },
    },
    ...(image && { image: [image] }),
    ...(organizer && { organizer: { '@type': 'Organization', name: organizer, ...(t.official && { url: base }) } }),
    ...(open.length && {
      offers: {
        '@type': 'Offer',
        price: Math.min(...fees) / 100,
        priceCurrency: 'INR',
        availability: 'https://schema.org/InStock',
        url: `${base}/t/${t.id}`,
      },
    }),
  };
}

// What the page shows before the app loads (and to crawlers that don't run it).
function tournamentBody(t) {
  const L = t.location;
  const lines = [L.address, [L.city, [L.region, L.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', '), L.country].filter(Boolean);
  const card = (title, inner) => (inner ? `<section class="card"><h2>${esc(title)}</h2>${inner}</section>` : '');
  const list = (items) => (items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul>` : '');
  const para = (text) => text.split('\n').filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');

  const events = list(t.events.map((e) => {
    const entries = e.entries.length;
    const bits = [e.formatName, `${entries} ${entries === 1 ? 'entry' : 'entries'}`, e.entriesOpen ? 'entries open' : null, e.champion ? `champion: ${e.champion.name}` : null];
    return `<strong>${esc(e.name)}</strong> — ${esc(bits.filter(Boolean).join(' · '))}`;
  }));
  const prizes = t.events.filter((e) => (e.prizes || []).length).map((e) => `${t.events.length > 1 ? `<h3>${esc(e.name)}</h3>` : ''}${list(e.prizes.map((p) => {
    const what = [p.cash ? rupees(p.cash) : null, p.reward].filter(Boolean).join(' + ');
    return `${esc(catalog.placeLabel(p.place))}: ${esc(what)}`;
  }))}`).join('');
  const perks = [...((t.perks && t.perks.items) || []).map((k) => catalog.perkLabel(k, t.sport.id)).filter(Boolean), ...((t.perks && t.perks.other) || [])];
  const results = t.events.flatMap((e) => e.matches.filter((m) => m.status === 'done' && m.a && m.b).map((m) => ({ m, e })))
    .sort((x, y) => String(y.m.updatedAt || '').localeCompare(String(x.m.updatedAt || '')))
    .slice(0, 12)
    .map(({ m, e }) => {
      const winner = m.winner === m.a.id ? m.a : m.b;
      const loser = winner === m.a ? m.b : m.a;
      return `${t.events.length > 1 ? `${esc(e.name)}: ` : ''}<strong>${esc(winner.name)}</strong> beat ${esc(loser.name)} ${esc(m.summary || '')}`;
    });

  return `<div class="prerender">
<header class="t-header"><h1>${esc(t.name)}</h1><p class="muted small">${esc([t.sport.name, `${t.events.length} event${t.events.length === 1 ? '' : 's'}`, t.entriesOpen ? 'Entries open' : null].filter(Boolean).join(' · '))}</p></header>
${card('When and where', [t.startsOn ? `<p><strong>${esc(dateRange(t.startsOn, t.endsOn))}</strong></p>` : '', t.venue || lines.length ? `<p>${[t.venue ? `<strong>${esc(t.venue)}</strong>` : '', ...lines.map(esc)].filter(Boolean).join('<br>')}</p>` : ''].join(''))}
${card('Events', events)}
${card('Prizes', prizes)}
${card('What\'s included', list(perks.map(esc)) + (t.notes ? `<h3>Other details</h3>${para(t.notes)}` : ''))}
${card('About', t.about ? para(t.about) : '')}
${card('Results', list(results))}
</div>`;
}

// The app page with this tournament's head and content filled in.
// page: { t, preview } for a tournament anyone with the link can see; null
// for a private or unknown one (generic, never indexed).
function tournamentHtml(shell, { base, id, page, match = false }) {
  const t = page && page.t;
  const indexable = t && t.visibility === 'public' && !match;
  const canonical = `${base}/t/${id}`;
  const image = page && page.preview.image;
  const imageUrl = image ? base + image.path : `${base}/brand/og.png`;
  const meta = (attr, name, content) => `<meta ${attr}="${name}" content="${esc(content)}">`;
  let head;
  if (t) {
    const title = `${t.name} — ${t.sport.name} tournament${t.location.city ? ` in ${t.location.city}` : ''} · Tonament`;
    const description = summary(t);
    const ld = indexable ? eventData(t, base, image ? imageUrl : null) : null;
    head = [
      `<title>${esc(title)}</title>`,
      meta('name', 'description', description),
      indexable ? `<link rel="canonical" href="${esc(canonical)}">` : meta('name', 'robots', 'noindex'),
      meta('property', 'og:type', 'website'),
      meta('property', 'og:site_name', 'Tonament'),
      meta('property', 'og:title', t.name),
      meta('property', 'og:description', description),
      meta('property', 'og:url', canonical),
      meta('property', 'og:image', imageUrl),
      ...(!image || image.width ? [meta('property', 'og:image:width', 1200), meta('property', 'og:image:height', 630)] : []),
      meta('name', 'twitter:card', 'summary_large_image'),
      meta('name', 'twitter:title', t.name),
      meta('name', 'twitter:description', description),
      meta('name', 'twitter:image', imageUrl),
      ld ? `<script type="application/ld+json">${jsonScript(ld)}</script>` : '',
    ].filter(Boolean).join('\n  ');
  } else {
    head = [
      '<title>Tonament — One platform. Every sport. Every tournament.</title>',
      meta('name', 'robots', 'noindex'),
      meta('property', 'og:title', 'Tonament — One platform. Every sport. Every tournament.'),
      meta('property', 'og:image', `${base}/brand/og.png`),
    ].join('\n  ');
  }
  return shell
    .replace(/<!-- head:start[\s\S]*?<!-- head:end -->/, head)
    .replace(/<!-- main:start[\s\S]*?<!-- main:end -->/, t ? tournamentBody(t) : '');
}

// pages: [{ path, lastmod }]
function sitemap(base, pages) {
  const url = (p) => `<url><loc>${esc(base + p.path)}</loc>${p.lastmod ? `<lastmod>${esc(p.lastmod)}</lastmod>` : ''}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(url).join('\n')}
</urlset>
`;
}

module.exports = { dateRange, summary, eventData, tournamentHtml, sitemap, esc };
