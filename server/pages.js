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

// "08:30" -> "8:30 AM"; times are the venue's local time.
function clock(hm) {
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function hours(start, end) {
  if (start && end) return `${clock(start)} – ${clock(end)}`;
  if (start) return clock(start);
  return end ? `until ${clock(end)}` : null;
}
// "Sat 2 Nov 2030 · 8:00 AM – 6:00 PM"
const when = (t) => (t.startsOn ? [dateRange(t.startsOn, t.endsOn), hours(t.startTime, t.endTime)].filter(Boolean).join(' · ') : null);

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
    when(t),
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
    // Local times without an offset: Google reads them in the venue's time zone.
    startDate: t.startTime ? `${t.startsOn}T${t.startTime}` : t.startsOn,
    endDate: t.endTime ? `${t.endsOn || t.startsOn}T${t.endTime}` : t.endsOn || t.startsOn,
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
      if (m.draw) return `${t.events.length > 1 ? `${esc(e.name)}: ` : ''}<strong>${esc(m.a.name)}</strong> drew with <strong>${esc(m.b.name)}</strong> ${esc(m.summary || '')}`;
      const winner = m.winner === m.a.id ? m.a : m.b;
      const loser = winner === m.a ? m.b : m.a;
      return `${t.events.length > 1 ? `${esc(e.name)}: ` : ''}<strong>${esc(winner.name)}</strong> beat ${esc(loser.name)} ${esc(m.summary || '')}`;
    });

  return `<div class="prerender">
<header class="t-header"><h1>${esc(t.name)}</h1><p class="muted small">${esc([t.sport.name, `${t.events.length} event${t.events.length === 1 ? '' : 's'}`, t.entriesOpen ? 'Entries open' : null].filter(Boolean).join(' · '))}</p></header>
${card('When and where', [t.startsOn ? `<p><strong>${esc(when(t))}</strong></p>` : '', t.venue || lines.length ? `<p>${[t.venue ? `<strong>${esc(t.venue)}</strong>` : '', ...lines.map(esc)].filter(Boolean).join('<br>')}</p>` : ''].join(''))}
${card('Events', events)}
${card('Prizes', prizes)}
${card('What\'s included', list(perks.map(esc)) + (t.notes ? `<h3>Other details</h3>${para(t.notes)}` : ''))}
${card('About', t.about ? para(t.about) : '')}
${card('Results', list(results))}
<p><a href="/${esc(t.sport.id)}">More ${esc(t.sport.name.toLowerCase())} tournaments</a></p>
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

// ---------- sport landing pages (/badminton, /pickleball, …) and /sports

const SITE_LINKS = [['/features', 'Features'], ['/sports', 'Sports'], ['/rankings', 'Rankings'], ['/how-it-works', 'How it works'], ['/faq', 'FAQ'], ['/pricing', 'Pricing'],
  ['/contact', 'Contact'], ['/terms', 'Terms'], ['/privacy', 'Privacy'], ['/refunds', 'Refunds'], ['/delivery', 'Delivery']];
const SIGN_UP = '/signup?next=%2Fnew';
const iconSvg = (id, cls = 'icon') => `<span class="${cls}" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><use href="/icons.svg#${esc(id)}"></use></svg></span>`;
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d || null);

// A whole page in the static pages' frame (theme, header, footer, site.js).
function sitePage({ base, path, title, description, ld, body }) {
  const url = base + path;
  const image = `${base}/brand/og-features.png`;
  const meta = (attr, name, content) => `<meta ${attr}="${name}" content="${esc(content)}">`;
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  ${meta('name', 'description', description)}
  <link rel="canonical" href="${esc(url)}">
  ${meta('property', 'og:type', 'website')}
  ${meta('property', 'og:site_name', 'Tonament')}
  ${meta('property', 'og:title', title)}
  ${meta('property', 'og:description', description)}
  ${meta('property', 'og:url', url)}
  ${meta('property', 'og:image', image)}
  ${meta('property', 'og:image:width', 1200)}
  ${meta('property', 'og:image:height', 630)}
  ${meta('name', 'twitter:card', 'summary_large_image')}
  ${meta('name', 'twitter:image', image)}
  <meta name="theme-color" content="#0B1220">
  <script>
    (function () {
      var pref = 'auto';
      try { pref = localStorage.getItem('tonament:theme') || 'auto'; } catch (e) {}
      var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
      document.documentElement.setAttribute('data-theme', pref === 'auto' ? (light ? 'light' : 'dark') : pref);
    })();
  </script>
  <link rel="preload" href="/fonts/Outfit-Variable.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/styles.css">
  <link rel="icon" href="/favicon.ico" sizes="32x32">
  <link rel="icon" href="/brand/favicon.svg" type="image/svg+xml">
  ${(ld || []).map((x) => `<script type="application/ld+json">${jsonScript(x)}</script>`).join('\n  ')}
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <a href="/" class="brand" aria-label="Tonament home"><img src="/brand/logo-white.svg" alt="Tonament" width="190" height="26"></a>
      <nav class="nav"><a class="btn btn-small btn-primary" href="${SIGN_UP}">Sign up free</a></nav>
    </div>
  </header>
  <main class="container guide features-page sport-page">
${body}
  </main>
  <footer class="footer">
    <div class="footer-inner">
      <div class="footer-brand">
        <img src="/brand/mark-white.svg" class="on-dark" alt="" width="31" height="22">
        <img src="/brand/mark.svg" class="on-light" alt="" width="31" height="22">
        <span class="eyebrow">One platform. Every sport. <b>Every tournament.</b></span>
      </div>
      <nav class="footer-links" aria-label="Policies">
        ${SITE_LINKS.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}
      </nav>
    </div>
    <p class="footer-legal">© <span data-year>${new Date().getFullYear()}</span> <span data-biz="name">Tonament</span>. Payments are processed securely by Razorpay.</p>
  </footer>
  <script src="/site.js"></script>
</body>
</html>
`;
}

const crumbs = (base, items) => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([name, path], i) => ({ '@type': 'ListItem', position: i + 1, name, item: base + path })),
});

// One upcoming tournament as a card (cards from service.listTournaments).
function tournamentCardHtml(t) {
  const date = t.startsOn ? dateRange(isoDate(t.startsOn), isoDate(t.endsOn)) : null;
  const place = [t.venue, t.city].filter(Boolean).join(', ');
  const tags = [t.entriesOpen ? '<span class="pill done">Entries open</span>' : '', t.prizeTotal ? `<span class="pill org">🏆 ${esc(rupees(t.prizeTotal))}</span>` : ''].join(' ');
  return `<a class="card t-card" href="/t/${esc(t.id)}">
        <div class="card-head"><h3>${esc(t.name)}</h3><span>${tags}</span></div>
        ${date || place ? `<div class="t-card-when">${esc([date, place].filter(Boolean).join(' · '))}</div>` : ''}
        ${t.events && t.events.length ? `<div class="t-card-events">${t.events.slice(0, 6).map((e) => `<span class="event-tag">${esc(e)}</span>`).join('')}</div>` : ''}
      </a>`;
}

// sport: { id, name, presets: [label], courtWord }, content: server/sport-pages.js entry,
// tournaments: upcoming public cards, others: [{ id, name }].
function sportHtml({ base, sport, content, tournaments, others }) {
  const path = `/${sport.id}`;
  const lower = sport.name.toLowerCase();
  const courts = `${sport.courtWord.toLowerCase()}s`;
  const list = tournaments.length
    ? `<div class="card-list sport-list">${tournaments.map(tournamentCardHtml).join('\n      ')}</div>
    <p><a href="/?sport=${esc(sport.id)}">Search all ${esc(lower)} tournaments</a></p>`
    : `<div class="card empty-list"><p><strong>No ${esc(lower)} tournaments listed yet.</strong> Run the first one — it's free for up to 16 entries.</p>
      <p class="actions"><a class="btn btn-primary" href="${SIGN_UP}">Create a ${esc(lower)} tournament</a></p></div>`;
  const body = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/sports">Sports</a> › <span>${esc(sport.name)}</span></nav>
    <section class="hero">
      <p class="eyebrow">${iconSvg(sport.id, 'icon hero-icon')} ${esc(sport.name)} tournaments</p>
      <h1>Run your ${esc(lower)} tournament. <span class="accent">Score it live.</span></h1>
      <p class="lead">${esc(content.lead)}</p>
      <p class="actions"><a class="btn btn-primary btn-lg" href="${SIGN_UP}">Sign up free</a> <a class="btn btn-lg btn-ghost" href="#tournaments">Find ${esc(lower)} tournaments</a></p>
      <p class="hero-note">Free for up to <span data-free-limit>16</span> entries · no card needed</p>
    </section>

    <section id="tournaments">
      <h2 class="features-title">Upcoming ${esc(lower)} tournaments</h2>
      ${list}
      <p><a href="/rankings/${esc(sport.id)}">${esc(sport.name)} player rankings →</a></p>
    </section>

    <section>
      <h2 class="features-title">Built for ${esc(lower)}</h2>
      <div class="feature-groups">
        <section><h3>Scoring</h3><ul>${content.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></section>
        <section><h3>Events</h3><ul>${sport.presets.map((p) => `<li>${esc(p)}</li>`).join('')}<li>Age groups and levels — U13, 35+, Beginner, Advanced…</li></ul></section>
        <section><h3>Formats</h3><p class="muted">${esc(content.formats)}</p></section>
      </div>
    </section>

    <section>
      <h2 class="features-title">Everything else you need</h2>
      <div class="feature-groups">
        <section><h3>Entries &amp; fees</h3><ul><li><strong>Online entries</strong> from one link, with partner finder and waitlist</li><li><strong>Entry fees by UPI</strong>, paid straight to you and confirmed in one tap</li><li><strong>Check-in</strong> on the day</li></ul></section>
        <section><h3>Draws &amp; ${esc(courts)}</h3><ul><li><strong>Groups and knockouts</strong> made in one tap, seeded</li><li><strong>An order of play</strong> across your ${esc(courts)}, with estimated times</li><li><strong>Nobody double-booked</strong> across events</li></ul></section>
        <section><h3>Live on the day</h3><ul><li><strong>Umpires score</strong> on their own phones</li><li><strong>Live scores</strong> for players and spectators</li><li><strong>Venue display</strong> for the TV in the hall</li></ul></section>
      </div>
      <figure class="tv-shot"><img src="/guide/display.jpg" width="1440" height="810" loading="lazy" alt="The venue display: live scores on every ${esc(sport.courtWord.toLowerCase())}, who's up next and the latest results"></figure>
    </section>

    <section>
      <h2 class="features-title">${esc(sport.name)} tournament questions</h2>
      <div class="faq-list">
        ${content.faqs.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('\n        ')}
      </div>
    </section>

    <section class="hero hero-end">
      <h2>Your next ${esc(lower)} tournament, sorted.</h2>
      <p class="lead">Pick ${esc(lower)}, choose your events, name it — and you're ready for entries.</p>
      <p class="actions"><a class="btn btn-primary btn-lg" href="${SIGN_UP}">Sign up free</a> <a class="btn btn-lg btn-ghost" href="/features">All features</a></p>
    </section>

    <nav class="sport-strip" aria-label="Other sports">${others.map((o) => `<a href="/${esc(o.id)}">${esc(o.name)}</a>`).join('')}</nav>`;
  const ld = [
    { '@context': 'https://schema.org', '@type': 'WebPage', name: content.title, description: content.description, url: base + path },
    crumbs(base, [['Home', '/'], ['Sports', '/sports'], [sport.name, path]]),
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: content.faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    ...(tournaments.length ? [{ '@context': 'https://schema.org', '@type': 'ItemList', name: `Upcoming ${lower} tournaments`, itemListElement: tournaments.map((t, i) => ({ '@type': 'ListItem', position: i + 1, url: `${base}/t/${t.id}`, name: t.name })) }] : []),
  ];
  return sitePage({ base, path, title: `${content.title} | Tonament`, description: content.description, ld, body });
}

// /sports: every sport, each linking to its page.
function sportsHubHtml({ base, sports }) {
  const body = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span>Sports</span></nav>
    <section class="hero">
      <p class="eyebrow">One platform. Every sport. <b>Every tournament.</b></p>
      <h1>Tournaments for <span class="accent">${sports.length} sports.</span></h1>
      <p class="lead">Each with its own scoring rules built in — rally points, side-out, deuce and tie-breaks, sets to 25. Pick yours.</p>
      <p class="actions"><a class="btn btn-primary btn-lg" href="${SIGN_UP}">Sign up free</a></p>
    </section>
    <div class="choice-group tiles sports-hub">
      ${sports.map((x) => `<a class="choice" href="/${esc(x.id)}">${iconSvg(x.id)}<span class="choice-label">${esc(x.name)}</span><small>${esc(x.blurb)}</small></a>`).join('\n      ')}
    </div>`;
  const ld = [
    { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Sports on Tonament', url: `${base}/sports` },
    crumbs(base, [['Home', '/'], ['Sports', '/sports']]),
  ];
  return sitePage({
    base,
    path: '/sports',
    title: 'Tournament software for badminton, pickleball, tennis and more | Tonament',
    description: `Run tournaments for ${sports.map((x) => x.name.toLowerCase()).join(', ')} — online entries, draws, court schedules and live scoring. Free for up to 16 entries.`,
    ld,
    body,
  });
}

// ---------- academy / venue / club pages (/@slug)

// o: orgs.page() (profile, media, tournament cards). Organiser-run content:
// everything is escaped; links are built here, never taken as HTML.
function orgHtml({ base, o }) {
  const path = `/@${o.slug}`;
  const L = o.location;
  const placeText = [L.address, [L.city, [L.region, L.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', '), L.country].filter(Boolean).join(', ');
  const where = [o.kindName, L.city].filter(Boolean).join(' · ');
  const today = new Date().toISOString().slice(0, 10);
  const last = (t) => isoDate(t.endsOn) || isoDate(t.startsOn);
  const live = o.tournaments.filter((t) => t.status === 'league' || t.status === 'knockout');
  const upcoming = o.tournaments.filter((t) => t.status === 'setup' && (!last(t) || last(t) >= today))
    .sort((a, b) => Number(b.entriesOpen) - Number(a.entriesOpen) || String(isoDate(a.startsOn) || '9').localeCompare(String(isoDate(b.startsOn) || '9')));
  const past = o.tournaments.filter((t) => !live.includes(t) && !upcoming.includes(t)).slice(0, 12);
  const list = (title, ts) => (ts.length ? `<section><h2 class="features-title">${esc(title)}</h2><div class="card-list sport-list">${ts.map(tournamentCardHtml).join('')}</div></section>` : '');
  const digits = (n) => String(n || '').replace(/\D/g, '');
  const C = o.contact;
  const maps = placeText || o.name ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([o.name, placeText].filter(Boolean).join(', '))}` : null;
  const buttons = [
    C.whatsapp ? `<a class="btn btn-primary" href="https://wa.me/${digits(C.whatsapp)}" rel="noopener">WhatsApp</a>` : '',
    C.phone ? `<a class="btn btn-ghost" href="tel:${esc(C.phone)}">Call</a>` : '',
    maps && placeText ? `<a class="btn btn-ghost" href="${esc(maps)}" rel="noopener">Directions</a>` : '',
    C.website ? `<a class="btn btn-ghost" href="${esc(C.website)}" rel="noopener nofollow">Website</a>` : '',
    C.instagram ? `<a class="btn btn-ghost" href="https://instagram.com/${esc(C.instagram)}" rel="noopener nofollow">Instagram</a>` : '',
  ].join(' ');
  const para = (t) => String(t || '').split('\n').filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join('');
  const sportsChips = o.sports.length
    ? `<p class="org-sports">${o.sports.map((x) => `<a href="/${esc(x.id)}">${iconSvg(x.id)} ${esc(x.name)}</a>`).join('')}</p>` : '';
  const facts = [
    o.courts ? `<section><h3>Courts</h3><p>${esc(o.courts)}</p></section>` : '',
    o.timings ? `<section><h3>Timings</h3><p>${esc(o.timings)}</p></section>` : '',
    placeText ? `<section><h3>Address</h3><p>${esc(placeText)}</p>${maps ? `<p><a href="${esc(maps)}" rel="noopener">Open in Google Maps</a></p>` : ''}</section>` : '',
  ].filter(Boolean);
  const body = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span>${esc(o.name)}</span></nav>
    <section class="org-hero${o.cover ? ' has-cover' : ''}"${o.cover ? ` style="--cover:url('${esc(o.cover)}')"` : ''}>
      <div class="org-hero-inner">
        ${o.logo ? `<img class="org-hero-logo" src="${esc(o.logo)}" alt="${esc(o.name)} logo" width="96" height="96">` : ''}
        <div>
          <p class="eyebrow">${esc(where)}</p>
          <h1>${esc(o.name)}</h1>
          ${sportsChips}
          ${buttons ? `<p class="actions">${buttons}</p>` : ''}
        </div>
      </div>
    </section>
${list('Live now', live)}
${list(upcoming.some((t) => t.entriesOpen) ? 'Upcoming tournaments — entries open' : 'Upcoming tournaments', upcoming)}
    ${o.about ? `<section><h2 class="features-title">About</h2><div class="org-about">${para(o.about)}</div></section>` : ''}
    ${facts.length ? `<div class="feature-groups org-facts">${facts.join('')}</div>` : ''}
    ${o.coaching.length ? `<section><h2 class="features-title">Coaching</h2><div class="feature-groups">${o.coaching.map((c) => `<section><h3>${esc(c.title)}</h3><ul>${[c.who && `<li><strong>For</strong> ${esc(c.who)}</li>`, c.when && `<li><strong>When</strong> ${esc(c.when)}</li>`, c.fee && `<li><strong>Fee</strong> ${esc(c.fee)}</li>`].filter(Boolean).join('')}</ul></section>`).join('')}</div></section>` : ''}
    ${o.photos.length ? `<section><h2 class="features-title">Photos</h2><div class="org-gallery">${o.photos.map((ph, i) => `<a href="${esc(ph.url)}" data-photo="${i}"><img src="${esc(ph.url)}" alt="${esc(ph.caption || `${o.name} photo ${i + 1}`)}" loading="lazy"></a>`).join('')}</div>
    <dialog class="org-lightbox" aria-label="Photo"><img alt=""><button class="btn btn-small" type="button" aria-label="Close">✕</button></dialog></section>` : ''}
${list('Past tournaments', past)}
    <section class="hero hero-end">
      <h2>Run your tournaments on Tonament</h2>
      <p class="lead">Entries, draws, courts and live scores — the way ${esc(o.name)} does.</p>
      <p class="actions"><a class="btn btn-primary btn-lg" href="${SIGN_UP}">Sign up free</a></p>
    </section>
    <script>
      (function () {
        var box = document.querySelector('.org-lightbox');
        if (!box || !box.showModal) return;
        var img = box.querySelector('img');
        document.querySelectorAll('[data-photo]').forEach(function (a) {
          a.addEventListener('click', function (e) { e.preventDefault(); img.src = a.href; img.alt = a.querySelector('img').alt; box.showModal(); });
        });
        box.addEventListener('click', function () { box.close(); });
      })();
    </script>`;
  const sameAs = [C.website, C.instagram && `https://instagram.com/${C.instagram}`].filter(Boolean);
  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'SportsActivityLocation',
      name: o.name,
      url: base + path,
      ...(o.about && { description: o.about.slice(0, 500) }),
      ...(o.logo && { logo: base + o.logo }),
      ...((o.cover || o.logo) && { image: base + (o.cover || o.logo) }),
      ...(C.phone && { telephone: C.phone }),
      ...(C.email && { email: C.email }),
      ...(sameAs.length && { sameAs }),
      ...((L.address || L.city) && {
        address: {
          '@type': 'PostalAddress',
          ...(L.address && { streetAddress: L.address }),
          ...(L.city && { addressLocality: L.city }),
          ...(L.region && { addressRegion: L.region }),
          ...(L.postcode && { postalCode: L.postcode }),
          ...(L.country && { addressCountry: L.country }),
        },
      }),
      ...(o.timings && { openingHours: o.timings }),
    },
    crumbs(base, [['Home', '/'], [o.name, path]]),
    ...(o.tournaments.length ? [{ '@context': 'https://schema.org', '@type': 'ItemList', name: `${o.name} tournaments`, itemListElement: [...live, ...upcoming, ...past].map((t, i) => ({ '@type': 'ListItem', position: i + 1, url: `${base}/t/${t.id}`, name: t.name })) }] : []),
  ];
  const sportsText = o.sports.map((x) => x.name.toLowerCase()).join(', ');
  const description = o.about
    ? o.about.replace(/\s+/g, ' ').slice(0, 155)
    : `${o.name}${L.city ? `, ${L.city}` : ''}: ${sportsText ? `${sportsText} ` : ''}${o.kindName.toLowerCase()} — courts, coaching and tournaments with live scores.`;
  return sitePage({ base, path, title: `${o.name}${L.city ? ` — ${o.kindName} in ${L.city}` : ''} | Tonament`, description, ld, body });
}

// ---------- players and rankings

const FINISH_SHORT = { W: 'Winner', F: 'Runner-up', SF: 'Semi-final', QF: 'Quarter-final', R16: 'Last 16', R32: 'Last 32', G: 'Group stage' };
const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const avatar = (p, cls = 'player-avatar') => (p.photo
  ? `<img class="${cls}" src="${esc(p.photo)}" alt="" width="96" height="96" loading="lazy">`
  : `<span class="${cls} initials" aria-hidden="true">${esc(initials(p.name))}</span>`);
const shortDate = (d) => {
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '' : `${x.getUTCDate()} ${MON[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};

function playerHtml({ base, p }) {
  const path = `/p/${p.handle}`;
  const where = [p.city, p.region].filter(Boolean).join(', ');
  const titles = p.results.filter((r) => r.finish === 'W');
  const rankings = p.rankings.length
    ? `<section><h2 class="features-title">Rankings</h2><div class="rank-chips">${p.rankings.map((r) => `<a class="rank-chip" href="/rankings/${esc(r.sport)}/${esc(r.category)}">
        <strong>#${r.rank}</strong><span>${esc(r.name)} · ${esc(r.sportName)}</span><small>${r.points} pts${r.cityRank && r.city ? ` · #${r.cityRank} in ${esc(r.city)}` : ''}</small></a>`).join('')}</div></section>` : '';
  const records = p.records.length
    ? `<div class="stat-row">${p.records.map((r) => `<div class="stat"><span class="stat-label">${esc(r.sportName)}</span><strong>${r.won}–${r.lost}</strong><small>${[r.titles ? `${r.titles} title${r.titles === 1 ? '' : 's'}` : '', r.events ? `${r.events} tournament event${r.events === 1 ? '' : 's'}` : '', r.groupGames ? `${r.groupGames} group game${r.groupGames === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</small></div>`).join('')}</div>` : '';
  // Group play: the player sees each group; others see totals per sport (groups are private).
  const played = (p.groupPlay || []).filter((g) => g.games);
  const groupPlay = played.length
    ? `<section><h2 class="features-title">Group play</h2><div class="rank-chips">${played.map((g) => (p.own
      ? `<a class="rank-chip" href="/g/${esc(g.slug)}"><strong>${g.rating}</strong><span>${esc(g.name)} · ${esc(g.sportName)}</span><small>${g.rank ? `#${g.rank} of ${g.ranked} · ` : ''}${g.wins}–${g.games - g.wins} (${Math.round((g.wins / g.games) * 100)}%)</small></a>`
      : `<div class="rank-chip"><strong>${g.rating}</strong><span>${esc(g.sportName)} group rating</span><small>${g.games} games · ${g.wins} wins (${Math.round((g.wins / g.games) * 100)}%)${g.top ? ' · #1 in their group' : ''}</small></div>`)).join('')}</div></section>` : '';
  const missing = !p.photo && !p.city && !p.bio && !p.sports.length;
  const setup = p.own && missing
    ? `<div class="card setup-card"><h2>Finish your profile</h2><p class="muted">Add your city, sports, a photo and a line about you, so players can find you and know who they're playing.</p><p class="actions"><a class="btn btn-primary" href="/me/profile">Edit profile</a></p></div>` : '';
  const dupr = p.dupr ? `<p class="dupr-line"><span class="pill">DUPR</span> ${[p.dupr.doubles != null ? `Doubles <strong>${p.dupr.doubles.toFixed(3)}</strong>` : '', p.dupr.singles != null ? `Singles <strong>${p.dupr.singles.toFixed(3)}</strong>` : '', p.dupr.id ? `ID ${esc(p.dupr.id)}` : ''].filter(Boolean).join(' · ')}${p.dupr.verified ? '' : ' <small class="muted">self-reported</small>'}</p>` : '';
  const results = p.results.length
    ? `<section><h2 class="features-title">Results</h2><ol class="result-list">${p.results.map((r) => `<li>
        <div class="result-head"><span class="finish finish-${esc(r.finish.toLowerCase())}">${esc(FINISH_SHORT[r.finish] || r.finish)}</span>
          <a href="/t/${esc(r.tournamentId)}">${esc(r.tournament)}</a></div>
        <p class="muted small">${[esc(r.event), r.city ? esc(r.city) : '', shortDate(r.date), `${r.won}–${r.lost}`, r.points ? `${r.points} ranking pts` : ''].filter(Boolean).join(' · ')}</p>
        ${r.matches.length ? `<details><summary>Matches</summary><ul class="match-lines">${r.matches.map((m) => `<li><span class="${m.won ? 'won' : m.draw ? 'drew' : 'lost'}">${m.won ? 'W' : m.draw ? 'D' : 'L'}</span> ${esc(m.round)} v ${esc(m.opponent)} <span class="muted">${esc(m.score)}</span></li>`).join('')}</ul></details>` : ''}
      </li>`).join('')}</ol></section>`
    : played.length ? '' : `<section><p class="muted">${p.own ? 'No results yet. Play in a group or enter a tournament — your games and results appear here.' : `${esc(p.name)} hasn't played rated games on Tonament yet.`}</p></section>`;
  const body = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/rankings">Rankings</a> › <span>${esc(p.name)}</span></nav>
    ${p.own && !p.public ? '<p class="banner">Only you can see this page — your profile is private. <a href="/me/profile">Change</a></p>' : ''}
    <section class="player-hero">
      ${avatar(p)}
      <div>
        <h1>${esc(p.name)}</h1>
        <p class="muted">${[where, p.sports.map((x) => x.name).join(', ')].filter(Boolean).map(esc).join(' · ')}</p>
        ${titles.length ? `<p class="player-titles">🏆 ${titles.length} title${titles.length === 1 ? '' : 's'}</p>` : ''}
        ${dupr}
        ${p.own ? '<p class="actions"><a class="btn btn-small" href="/me/profile">Edit profile</a></p>' : ''}
      </div>
    </section>
    ${setup}
    ${p.bio ? `<section class="org-about">${String(p.bio).split('\n').filter(Boolean).map((x) => `<p>${esc(x)}</p>`).join('')}</section>` : ''}
    ${records}
    ${groupPlay}
    ${rankings}
    ${results}
    <section class="hero hero-end">
      <h2>Play tournaments on Tonament</h2>
      <p class="lead">Enter online, follow live scores and collect ranking points.</p>
      <p class="actions"><a class="btn btn-primary btn-lg" href="/signup">Sign up free</a> <a class="btn btn-ghost btn-lg" href="/rankings">See rankings</a></p>
    </section>`;
  const ld = [
    {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: p.name,
      url: base + path,
      ...(p.photo && { image: base + p.photo }),
      ...(p.bio && { description: p.bio.slice(0, 300) }),
      ...(p.city && { homeLocation: { '@type': 'Place', name: [p.city, p.region].filter(Boolean).join(', ') } }),
      ...(p.sports.length && { knowsAbout: p.sports.map((x) => x.name) }),
    },
    crumbs(base, [['Home', '/'], ['Rankings', '/rankings'], [p.name, path]]),
  ];
  const sportsText = p.sports.map((x) => x.name.toLowerCase()).join(', ');
  const description = `${p.name}${p.city ? ` from ${p.city}` : ''}${sportsText ? ` — ${sportsText} player` : ''}: tournament results${p.rankings.length ? ', rankings' : ''} and match scores on Tonament.`;
  return sitePage({ base, path, title: `${p.name}${p.city ? ` — ${p.city}` : ''} | Tonament player`, description, ld, body });
}

const rankRow = (r) => `<li class="rank-row"><span class="rank-no">${r.rank}</span>${avatar(r, 'rank-avatar')}<span class="rank-name"><a href="/p/${esc(r.handle)}">${esc(r.name)}</a><small class="muted">${esc([r.city, r.region].filter(Boolean).join(', '))}</small></span><span class="rank-pts"><strong>${r.points}</strong><small>pts</small></span></li>`;
const rankLd = (base, name, path, players, offset = 0) => ({ '@context': 'https://schema.org', '@type': 'ItemList', name, url: base + path, itemListElement: players.map((r, i) => ({ '@type': 'ListItem', position: offset + i + 1, url: `${base}/p/${r.handle}`, name: r.name })) });
const RULES = (best, weeks) => `<p class="muted small">Ranking points come from public tournaments on Tonament: how far you got, times the size of the draw (Winner 100, Runner-up 70, Semi-final 45, Quarter-final 25 … ×2 for draws of 32+). Your best ${best} results in the last ${weeks} weeks count. Players with private profiles aren't listed.</p>`;

function rankingsHubHtml({ base, sports }) {
  const body = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span>Rankings</span></nav>
    <section class="hero">
      <p class="eyebrow">Play. Win. <b>Climb.</b></p>
      <h1>Player <span class="accent">rankings.</span></h1>
      <p class="lead">From tournaments played on Tonament — by sport, event, state and city.</p>
    </section>
    ${sports.length ? `<div class="choice-group tiles sports-hub">${sports.map((x) => `<a class="choice" href="/rankings/${esc(x.id)}">${iconSvg(x.id)}<span class="choice-label">${esc(x.name)}</span><small>${x.players} ranked player${x.players === 1 ? '' : 's'}</small></a>`).join('')}</div>`
    : '<p class="muted">Rankings appear once public tournaments on Tonament finish.</p>'}
    ${RULES(6, 52)}`;
  return sitePage({ base, path: '/rankings', title: 'Player rankings — badminton, pickleball and more | Tonament', description: 'Player rankings from tournaments on Tonament: badminton, pickleball, table tennis, tennis and more — by event, state and city.', ld: [crumbs(base, [['Home', '/'], ['Rankings', '/rankings']])], body });
}

function rankingsSportHtml({ base, sport, categories }) {
  const path = `/rankings/${sport.id}`;
  const body = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/rankings">Rankings</a> › <span>${esc(sport.name)}</span></nav>
    <section class="rank-head">${iconSvg(sport.id)}<div><h1>${esc(sport.name)} rankings</h1><p class="muted">Top players by event, from ${esc(sport.name.toLowerCase())} tournaments on Tonament.</p></div></section>
    ${categories.length ? `<div class="rank-grid">${categories.map((c) => `<section class="card rank-card"><h2><a href="${path}/${esc(c.slug)}">${esc(c.name)}</a></h2><ol class="rank-list">${c.top.map(rankRow).join('')}</ol><p><a href="${path}/${esc(c.slug)}">All ${c.players} player${c.players === 1 ? '' : 's'} →</a></p></section>`).join('')}</div>`
    : `<p class="muted">No ranked ${esc(sport.name.toLowerCase())} results yet. <a href="/${esc(sport.id)}">Run a tournament</a></p>`}
    ${RULES(6, 52)}`;
  return sitePage({ base, path, title: `${sport.name} rankings — India | Tonament`, description: `${sport.name} player rankings in India from tournaments on Tonament: singles, doubles and mixed, by state and city.`, ld: [crumbs(base, [['Home', '/'], ['Rankings', '/rankings'], [sport.name, path]])], body });
}

function rankingsTableHtml({ base, sport, category, name, table, places, scope, offset, pageSize }) {
  const path = `/rankings/${sport.id}/${category}`;
  const qs = (o) => { const u = new URLSearchParams(Object.entries(o).filter(([, v]) => v)); const x = u.toString(); return x ? `?${x}` : ''; };
  const where = scope.city || scope.region || 'India';
  const chip = (label, o, on) => `<a class="chip${on ? ' on' : ''}" href="${path}${qs(o)}">${esc(label)}</a>`;
  const filters = `<nav class="rank-filters" aria-label="Where">${chip('India', {}, !scope.city && !scope.region)}${places.regions.map((r) => chip(r, { state: r }, scope.region === r && !scope.city)).join('')}${places.cities.map((c) => chip(c, { city: c }, scope.city === c)).join('')}</nav>`;
  const more = offset + table.players.length < table.total;
  const body = `    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/rankings">Rankings</a> › <a href="/rankings/${esc(sport.id)}">${esc(sport.name)}</a> › <span>${esc(name)}</span></nav>
    <section class="rank-head">${iconSvg(sport.id)}<div><h1>${esc(sport.name)} ${esc(name)} — ${esc(where)}</h1><p class="muted">${table.total} ranked player${table.total === 1 ? '' : 's'} · best ${6} results in the last 52 weeks</p></div></section>
    ${filters}
    ${table.players.length ? `<ol class="rank-list rank-table">${table.players.map(rankRow).join('')}</ol>` : '<p class="muted">No ranked players here yet.</p>'}
    <p class="actions">${offset ? `<a class="btn btn-small" href="${path}${qs({ state: scope.region, city: scope.city, page: offset / pageSize > 1 ? offset / pageSize : '' })}">← Previous</a>` : ''}${more ? ` <a class="btn btn-small" href="${path}${qs({ state: scope.region, city: scope.city, page: offset / pageSize + 2 })}">Next →</a>` : ''}</p>
    ${RULES(6, 52)}`;
  const title = `${sport.name} ${name} rankings — ${where} | Tonament`;
  const ld = [rankLd(base, `${sport.name} ${name} rankings — ${where}`, path, table.players, offset), crumbs(base, [['Home', '/'], ['Rankings', '/rankings'], [sport.name, `/rankings/${sport.id}`], [name, path]])];
  return sitePage({ base, path: path + qs({ state: scope.region, city: scope.city }), title, description: `${sport.name} ${name} player rankings in ${where}, from tournaments on Tonament. ${table.players.slice(0, 3).map((r) => `#${r.rank} ${r.name}`).join(', ')}`, ld, body });
}

module.exports = { dateRange, clock, when, summary, eventData, tournamentHtml, sitemap, esc, sportHtml, sportsHubHtml, orgHtml, playerHtml, rankingsHubHtml, rankingsSportHtml, rankingsTableHtml };
