'use strict';

(() => {
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');

  const S = {
    route: { name: 'home' },
    me: null, // signed-in user
    emailEnabled: false, // can the server send email (password reset, invites)?
    billing: { enabled: false }, // Razorpay settings from /api/billing/config
    upgradeFor: null, // tournament id that just hit the free entry limit
    paying: false,
    mine: null, // tournaments I'm on the team of
    members: null, // team list for the open tournament (managers only)
    interest: null, // { counts: { sportId: n }, mine: [sportId] } for "Request this sport"
    sports: [],
    list: null, // home page search results
    filters: {}, // home page search filters (also kept in the URL)
    places: null, // { country, region, city } that have public tournaments
    t: null,
    error: null,
    connected: false,
    seq: 0, // bumped on every change we make, so stale poll results are dropped
    offline: false, // scoring requests are waiting for the connection to come back
    draft: '',
    pendingRender: false,
    pendingCheckIns: new Map(), // entry id -> here, shown at once while the server saves it
    checkAllBusy: false,
    removing: new Set(), // entry ids being removed
    shake: null, // entry id whose check-in just failed
    openPanels: new Set(), // "tournamentId:panel" for Settings / Venue & date panels left open
  };

  const ROLE_NAMES = { admin: 'Site admin', owner: 'Owner', organiser: 'Organiser', umpire: 'Umpire' };
  const STATUS = { setup: 'Setting up', league: 'League stage', knockout: 'Knockout stage', completed: 'Completed', live: 'In progress' };

  // ---------- organiser keys (kept per tournament in this browser)
  const memKeys = {};
  const keys = {
    get(id) {
      try { return localStorage.getItem(`tonament:key:${id}`) || memKeys[id] || null; } catch { return memKeys[id] || null; }
    },
    set(id, key) {
      memKeys[id] = key;
      try { localStorage.setItem(`tonament:key:${id}`, key); } catch { /* storage unavailable */ }
    },
    remove(id) {
      delete memKeys[id];
      try { localStorage.removeItem(`tonament:key:${id}`); } catch { /* storage unavailable */ }
    },
  };

  // ---------- helpers
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const c of children.flat(Infinity)) {
      if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = true;
      else el.setAttribute(k, v === true ? '' : v);
    }
    return el;
  }

  async function api(method, path, body, tid) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const key = tid ? keys.get(tid) : null;
    if (key) headers['X-Admin-Key'] = key;
    if (method !== 'GET') S.seq++;
    // Public tournament reads are shared through the CDN cache. Signed-in users
    // and link holders ask for their own copy (?me=1), which is never cached.
    if (method === 'GET' && (key || S.me) && /^\/tournaments\/[^/?]+$/.test(path)) path += '?me=1';
    let res;
    try {
      res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw Object.assign(new Error('No connection'), { network: true });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw Object.assign(new Error(data.error || `Request failed (${res.status})`), {
        status: res.status,
        code: data.code,
        network: res.status === 502 || res.status === 503 || res.status === 504,
      });
    }
    return data;
  }

  let toastTimer;
  function toast(msg, error = false) {
    toastEl.textContent = msg;
    toastEl.className = error ? 'show error' : 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = ''; }, 3500);
  }

  async function act(fn, success) {
    try {
      await fn();
      if (success) toast(success);
    } catch (e) {
      if (e.code === 'upgrade' && S.t) S.upgradeFor = S.t.id; // show the upgrade card
      toast(e.message, true);
    }
    render();
  }

  function copy(text, message) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast(message), () => window.prompt('Copy this link:', text));
    else window.prompt('Copy this link:', text);
  }

  const tPath = (t) => `/tournaments/${encodeURIComponent(t.id)}`;
  // The link to share: /t/<id> shows the tournament's name, details and
  // image in WhatsApp and other link previews.
  const shareUrl = (t) => `${location.origin}/t/${t.id}`;
  const whatsappUrl = (t) => `https://wa.me/?text=${encodeURIComponent(`${t.name} — ${shareUrl(t)}`)}`;
  // The phone's share sheet where there is one; otherwise copy the link.
  function shareTournament(t) {
    if (navigator.share) {
      navigator.share({ title: t.name, url: shareUrl(t) }).catch(() => { /* closed */ });
    } else {
      copy(shareUrl(t), 'Link copied');
    }
  }
  const pad2 = (n) => String(n).padStart(2, '0');
  // ISO time -> value for <input type="datetime-local"> in the viewer's timezone
  const toLocalInput = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  };
  const fmtWhen = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  // Same rule as server/formats.js groupCount: about `size` per group, never a group of one.
  const groupCount = (n, size) => (n < 2 ? 1 : Math.min(Math.max(1, Math.round(n / size)), Math.floor(n / 2)));
  const nameOf = (p) => (p ? p.name : 'TBD');
  const pow2 = (n) => { let s = 2; while (s < n) s *= 2; return s; };
  const field = (label, control, cls, hint) =>
    h('label', { class: `field ${cls || ''}` }, h('span', { class: 'label' }, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
  const empty = (text) => h('div', { class: 'empty' }, text);
  const loading = () => h('div', { class: 'loading' }, 'Loading…');
  const pill = (cls, label) => h('span', { class: `pill ${cls}` }, label);
  const connDot = () => h('span', { class: `conn ${S.connected ? 'on' : ''}` }, S.connected ? 'Live' : 'Connecting…');

  // ---------- venue, location and dates
  const REGIONS = window.TonamentRegions;
  const OTHER_COUNTRY = 'Other';
  const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  function fmtDates(start, end) {
    if (!start) return null;
    const fmt = (iso) => {
      const d = new Date(`${iso}T00:00:00`);
      const year = d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {};
      return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...year });
    };
    return end ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
  }
  // "08:30" as the viewer writes times (8:30 am / 08:30), not converted between time zones.
  const fmtClock = (hm) => new Date(`1970-01-01T${hm}:00Z`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  // Dates plus the start (and finish) time: "Sat, 2 Nov · 8:00 am – 6:00 pm".
  function fmtSchedule(t) {
    const dates = fmtDates(t.startsOn, t.endsOn);
    if (!dates) return null;
    const time = t.startTime && t.endTime ? `${fmtClock(t.startTime)} – ${fmtClock(t.endTime)}`
      : t.startTime ? fmtClock(t.startTime) : t.endTime ? `until ${fmtClock(t.endTime)}` : null;
    return [dates, time].filter(Boolean).join(' · ');
  }
  const placeLine = (venue, city) => [venue, city].filter(Boolean).join(', ') || null;
  const detailValues = (t) => ({ venue: t.venue, ...t.location, startsOn: t.startsOn, endsOn: t.endsOn, startTime: t.startTime, endTime: t.endTime });

  // ---------- organiser branding (paid) and page images
  // A brand colour replaces the lime accent on that tournament's pages. Text
  // on it, and accent-coloured text on the page, are picked or adjusted so
  // they stay readable (4.5:1) in both themes.
  const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const toHex = (rgb) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const mixRgb = (rgb, to, f) => rgb.map((c, i) => c + (to[i] - c) * f);
  function readableOn(rgb, bg, towards) {
    let c = rgb;
    for (let i = 0; i < 12 && contrast(c, bg) < 4.5; i++) c = mixRgb(c, towards, 0.15);
    return toHex(c);
  }
  let brandStyle;
  function applyBranding(b) {
    document.body.classList.toggle('branded', Boolean(b));
    const accent = b && b.accent;
    if (!accent) {
      if (brandStyle) brandStyle.textContent = '';
      return;
    }
    if (!brandStyle) {
      brandStyle = document.createElement('style');
      document.head.append(brandStyle);
    }
    const NAVY = [11, 18, 32];
    const WHITE = [255, 255, 255];
    const rgb = hexRgb(accent);
    const on = contrast(rgb, NAVY) >= contrast(rgb, WHITE) ? '#0B1220' : '#FFFFFF';
    brandStyle.textContent = `
:root { --accent: ${accent}; --on-accent: ${on}; --accent-text: ${readableOn(rgb, NAVY, WHITE)}; --accent-soft: rgba(${rgb.join(',')}, 0.14); --link: ${readableOn(rgb, NAVY, WHITE)}; }
:root[data-theme='light'] { --accent-text: ${readableOn(rgb, WHITE, NAVY)}; --accent-soft: rgba(${rgb.join(',')}, 0.12); }
:root[data-theme='light'] .btn-primary, :root[data-theme='light'] .btn-primary:hover { border-color: var(--accent); }`;
  }

  // Shrinks a picked image in the browser (and drops camera data such as
  // location) before upload: photos to 1600px JPEG, logos to 512px PNG.
  async function prepareImage(file, kind) {
    if (!/^image\/(jpeg|png|webp|heic|heif|gif)$/.test(file.type) && !/\.(jpe?g|png|webp|heic)$/i.test(file.name)) {
      throw new Error('Choose a photo or image file');
    }
    const small = kind === 'logo' || kind === 'sponsor';
    const max = small ? 512 : 1600;
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
      throw new Error('That image couldn\'t be read — try a JPEG or PNG');
    });
    if (kind === 'preview') return cropped(bitmap, 1200, 630);
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, small ? 'image/png' : 'image/jpeg', 0.82));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('That image couldn\'t be read'));
      reader.readAsDataURL(blob);
    });
  }

  // Link-preview image: the picture scaled to fill w×h, centred, as a JPEG.
  function cropped(bitmap, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const scale = Math.max(w / bitmap.width, h / bitmap.height);
    const sw = w / scale;
    const sh = h / scale;
    canvas.getContext('2d').drawImage(bitmap, (bitmap.width - sw) / 2, (bitmap.height - sh) / 2, sw, sh, 0, 0, w, h);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8)).then((blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('That image couldn\'t be read'));
      reader.readAsDataURL(blob);
    }));
  }

  // Full-screen photo viewer: arrows / swipe to move, Esc or tap outside to close.
  function openLightbox(photos, start) {
    let i = start;
    const img = h('img', { alt: '' });
    const caption = h('p', { class: 'lb-caption' });
    const show = () => {
      img.src = photos[i].url;
      img.alt = photos[i].caption || `Photo ${i + 1} of ${photos.length}`;
      caption.textContent = [photos[i].caption, `${i + 1} / ${photos.length}`].filter(Boolean).join(' · ');
    };
    const go = (d) => { i = (i + d + photos.length) % photos.length; show(); };
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'ArrowLeft') go(-1);
    };
    let startX = null;
    const box = h('div', {
      class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photos',
      onclick: (e) => { if (e.target === box) close(); },
      ontouchstart: (e) => { startX = e.touches[0].clientX; },
      ontouchend: (e) => { if (startX != null) { const dx = e.changedTouches[0].clientX - startX; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); } startX = null; },
    },
    h('button', { class: 'lb-close', 'aria-label': 'Close', onclick: close }, '✕'),
    photos.length > 1 ? h('button', { class: 'lb-prev', 'aria-label': 'Previous photo', onclick: () => go(-1) }, '‹') : null,
    h('figure', {}, img, caption),
    photos.length > 1 ? h('button', { class: 'lb-next', 'aria-label': 'Next photo', onclick: () => go(1) }, '›') : null);
    show();
    document.body.append(box);
    document.addEventListener('keydown', onKey);
    box.querySelector('.lb-close').focus();
  }

  // Plain text with line breaks; web links become links (never raw HTML).
  function richText(text) {
    return text.split('\n').map((line) => h('p', {}, line.split(/(https?:\/\/[^\s]+)/g).map((part, i) => (i % 2
      ? h('a', { href: part, target: '_blank', rel: 'noopener nofollow' }, part)
      : part))));
  }

  const hasExtras = (t) => Boolean(t.notes || perkLabels(t).length || t.events.some((e) => (e.prizes || []).length));
  const hasPage = (t) => Boolean(t.about || t.photos.length || Object.values(t.pageLinks || {}).some(Boolean) || hasExtras(t));

  // ----- prizes, what's included and other details (for players)
  const PRIZE_ICON = { winner: '🥇', runner_up: '🥈', semis: '🥉', third: '🥉' };
  const perkLabels = (t) => [...((t.perks && t.perks.items) || []).map((k) => CAT.perkLabel(k, t.sport.id)).filter(Boolean), ...((t.perks && t.perks.other) || [])];
  const prizeMoney = (ev) => (ev.prizes || []).reduce((sum, p) => sum + (p.cash || 0), 0);

  function prizesCard(t, events) {
    const withPrizes = events.filter((ev) => (ev.prizes || []).length);
    const perks = perkLabels(t);
    if (!withPrizes.length && !perks.length && !t.notes) return null;
    const named = events.length > 1;
    return h('div', { class: 'card prizes-card' },
      withPrizes.length
        ? [h('h2', {}, 'Prizes'),
          withPrizes.map((ev) => [
            named ? h('h3', { class: 'prize-event' }, ev.name) : null,
            h('ul', { class: 'prize-list' }, ev.prizes.map((p) => h('li', {},
              h('span', { class: 'prize-icon', 'aria-hidden': 'true' }, PRIZE_ICON[p.place] || '🏅'),
              h('span', { class: 'prize-place' }, CAT.placeLabel(p.place)),
              h('span', { class: 'prize-what' }, [p.cash ? rupees(p.cash) : null, p.reward].filter(Boolean).join(' + ')))))])]
        : null,
      perks.length
        ? [h('h2', {}, 'What\'s included'), h('ul', { class: 'perk-list' }, perks.map((x) => h('li', {}, x)))]
        : null,
      t.notes ? [h('h2', {}, 'Other details'), h('div', { class: 'about-text' }, richText(t.notes))] : null);
  }

  function panelAbout(t) {
    const L = t.pageLinks || {};
    const links = [['website', 'Website'], ['instagram', 'Instagram'], ['whatsapp', 'WhatsApp group']].filter(([k]) => L[k]);
    const photos = t.photos.filter((p) => !p.hidden);
    return [
      t.about || links.length
        ? h('div', { class: 'card about-card' },
          h('h2', {}, 'About'),
          t.about ? h('div', { class: 'about-text' }, richText(t.about)) : null,
          links.length ? h('div', { class: 'actions' }, links.map(([k, label]) => h('a', { class: 'btn btn-small', href: L[k], target: '_blank', rel: 'noopener nofollow' }, label))) : null)
        : null,
      prizesCard(t, t.events),
      photos.length
        ? h('div', { class: 'card' },
          h('h2', {}, 'Photos'),
          h('div', { class: 'gallery' }, photos.map((p, i) => h('button', { class: 'gallery-item', 'aria-label': p.caption || `Photo ${i + 1}`, onclick: () => openLightbox(photos, i) },
            h('img', { src: p.url, alt: p.caption || '', loading: 'lazy' })))))
        : null,
      !hasPage(t) ? empty('Nothing here yet.') : null,
    ];
  }

  // Under the tournament: sponsors (paid) and the "Powered by" credit on branded pages.
  function brandFooter(t) {
    return [
      t.sponsors && t.sponsors.length
        ? h('section', { class: 'sponsors', 'aria-label': 'Sponsors' },
          h('p', { class: 'eyebrow' }, 'Supported by'),
          h('div', { class: 'sponsor-logos' }, t.sponsors.map((sp) => h('img', { src: sp.url, alt: sp.caption || 'Sponsor', loading: 'lazy' }))))
        : null,
      t.branding
        ? h('a', { class: 'powered', href: '/', 'aria-label': 'Powered by Tonament' },
          h('span', {}, 'Powered by'), h('img', { class: 'on-dark', src: '/brand/logo-white.svg', alt: 'TONAMENT', height: 14 }), h('img', { class: 'on-light', src: '/brand/logo.svg', alt: 'TONAMENT', height: 14 }))
        : null,
    ];
  }

  // ---------- events
  // The tournament page shows one event at a time. withEvent() gives the
  // panels a tournament-shaped object for that event (its entries, draw,
  // status and config), so they work the same with one event or many.
  const CAT = window.TonamentEvents;
  const allEntries = (t) => t.events.flatMap((e) => e.entries);
  const allMatches = (t) => t.events.flatMap((e) => e.matches);
  const multiEvent = (t) => t.events.length > 1;
  function withEvent(t, ev) {
    return {
      ...t,
      tournamentStatus: t.status,
      eventId: ev.id,
      event: ev,
      status: ev.status,
      format: ev.format,
      formatName: ev.formatName,
      config: ev.config,
      entriesOpen: ev.entriesOpen,
      placesLeft: ev.placesLeft,
      // Doubles players without a partner are listed apart from the draw.
      entries: ev.entries.filter((e) => !e.solo),
      solos: ev.entries.filter((e) => e.solo),
      groups: ev.groups,
      matches: ev.matches,
      champion: ev.champion,
    };
  }
  const currentEvent = (t) => t.events.find((e) => e.id === S.route.eventId) || t.events[0];
  const eventOfMatch = (t, mid) => t.events.find((e) => e.matches.some((m) => m.id === mid));
  // A tab link that keeps the selected event.
  const tabHref = (t, tab) => `/t/${t.id}/${tab}${t.events && t.events.length > 1 && t.eventId ? `?e=${t.eventId}` : ''}`;
  // Event-scoped request bodies name the event.
  const withEv = (t, body = {}) => ({ ...body, event: t.eventId });
  async function ensurePlaces() {
    if (S.places) return S.places;
    S.places = await api('GET', '/tournaments/places').catch(() => []);
    return S.places;
  }

  function isEditing() {
    const a = document.activeElement;
    if (a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'radio') return true;
    // Unsent input holds back live redraws: an open Settings-style panel with
    // changes, or any other form someone has typed into (e.g. the entry form).
    return Boolean(app.querySelector('details[data-panel][open] form[data-dirty], form[data-dirty]:not(details[data-panel] form)'));
  }

  // ---------- routing
  async function route() {
    const parts = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(location.search);
    const prev = S.route;
    S.error = null;
    S.errorCode = null;

    if (parts[0] === 't' && parts[1]) {
      const id = parts[1];
      const key = params.get('key');
      if (key) {
        keys.set(id, key);
        history.replaceState(null, '', `/${parts.map(encodeURIComponent).join('/')}${params.get('e') ? `?e=${params.get('e')}` : ''}`); // drop the key from the address
      }
      S.route = parts[2] === 'm'
        ? { name: 'match', id, mid: Number(parts[3]) }
        : parts[2] === 'display'
          ? { name: 'display', id }
          : { name: 'tournament', id, tab: parts[2] || null, eventId: Number(params.get('e')) || null };
      if (S.route.tab === 'team') S.members = null; // reload: invitees may have signed up since
      if (!S.t || S.t.id !== id || key) {
        S.t = null;
        render();
        await load(id);
        if (S.t) schedulePoll();
        if (key && S.t && !S.t.can.score) {
          keys.remove(id);
          toast('That organiser link is not valid', true);
        }
      }
    } else {
      clearTimeout(pollTimer);
      S.t = null;
      if (parts[0] === 'new') {
        if (!S.me) {
          navigate('/signin?next=/new', { replace: true });
          return;
        }
        S.route = { name: 'new' };
      } else if (parts[0] === 'signin' || parts[0] === 'signup') {
        S.route = { name: parts[0], next: params.get('next') || '/', email: params.get('email') || '' };
      } else if (parts[0] === 'forgot') {
        S.route = { name: 'forgot', email: params.get('email') || '', sent: false };
      } else if (parts[0] === 'reset') {
        S.route = { name: 'reset', token: params.get('token') || '' };
        history.replaceState(null, '', '/reset'); // keep the token out of history
      } else if (parts[0] === 'admin') {
        S.route = { name: 'admin', users: null };
        render();
        [S.route.users, S.interest, S.route.payments] = await Promise.all([
          api('GET', '/admin/users').catch((e) => { S.error = e.message; return []; }),
          api('GET', '/sports/interest').catch(() => null),
          api('GET', '/admin/payments').catch(() => null),
        ]);
      } else {
        S.route = { name: 'home' };
        S.list = null;
        S.filters = readFilters(params);
        const qs = filterQuery(S.filters);
        if (qs && !params.toString()) history.replaceState(null, '', `/?${qs}`); // remembered search
        render();
        [S.list, S.mine, S.myEntries, S.interest, S.places] = await Promise.all([
          api('GET', `/tournaments?${filterQuery(S.filters, true)}`).catch((e) => { S.error = e.message; return []; }),
          S.me ? api('GET', '/me/tournaments').catch(() => []) : null,
          S.me ? api('GET', '/me/entries').catch(() => []) : null,
          api('GET', '/sports/interest').catch(() => null),
          api('GET', '/tournaments/places').catch(() => []),
        ]);
      }
    }
    if (S.route.name === 'new' || S.route.name === 'tournament') ensurePlaces(); // city suggestions
    render();
    if (prev.name !== S.route.name || prev.mid !== S.route.mid || prev.id !== S.route.id) window.scrollTo(0, 0);
  }

  async function load(id) {
    try {
      S.t = await api('GET', `/tournaments/${encodeURIComponent(id)}`, undefined, id);
      S.error = null;
      S.connected = true;
    } catch (e) {
      S.error = e.message;
      S.errorCode = e.code;
    }
  }

  function mergeMatch(m) {
    if (!S.t) return;
    for (const ev of S.t.events) {
      const i = ev.matches.findIndex((x) => x.id === m.id);
      if (i >= 0) ev.matches[i] = m;
    }
  }

  // ---------- live updates (polling)
  // Every viewer re-fetches the tournament: every 2s while a match is live,
  // otherwise every 5s, and slowly when the tab is in the background. Public
  // responses are cached by the CDN for 1s, so spectators share one fetch.
  let pollTimer;
  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    if (!S.t) return;
    const live = allMatches(S.t).some((m) => m.status === 'live');
    pollTimer = setTimeout(poll, delay ?? (document.hidden ? 30000 : live ? 2000 : 5000));
  }

  async function poll() {
    const id = S.t && S.t.id;
    if (!id) return;
    const seq = S.seq;
    try {
      const data = await api('GET', `/tournaments/${encodeURIComponent(id)}`, undefined, id);
      S.connected = true;
      // Ignore the result if we changed something while it was in flight.
      if (S.t && S.t.id === id && S.seq === seq && !scoringBusy()) {
        S.t = data;
        render(true);
      }
    } catch (e) {
      if (e.code === 'private') { // made private while we were watching
        S.error = e.message;
        S.errorCode = e.code;
        render();
        return;
      }
      if (/not found/i.test(e.message)) {
        toast('This tournament was deleted');
        navigate('/');
        return;
      }
      S.connected = false;
      render(true);
    }
    if (S.t && S.t.id === id) schedulePoll();
  }

  // Fetch now (after our own changes that affect standings or the bracket).
  function refresh() {
    if (S.t) schedulePoll(0);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });

  // ---------- render
  // soft renders (from live updates) wait while the user is typing in a field
  let wasDisplaying = false; // see the venue display below
  function render(soft = false) {
    if (soft && isEditing()) {
      S.pendingRender = true;
      return;
    }
    S.pendingRender = false;
    // A tournament page arrives already rendered by the server: keep that on
    // screen (rather than a spinner) until the live data has loaded.
    if (['tournament', 'match'].includes(S.route.name) && !S.t && !S.error && app.querySelector(':scope > .prerender')) {
      renderNav();
      return;
    }
    // Check-ins still being saved win over whatever the server last sent.
    if (S.t && S.pendingCheckIns.size) {
      for (const e of allEntries(S.t)) if (S.pendingCheckIns.has(e.id)) e.checkedIn = S.pendingCheckIns.get(e.id);
    }
    let view;
    if (S.error) view = errorView(S.error, S.errorCode);
    else if (S.route.name === 'new') view = viewNew();
    else if (S.route.name === 'signin' || S.route.name === 'signup') view = viewAuth();
    else if (S.route.name === 'forgot') view = viewForgot();
    else if (S.route.name === 'reset') view = viewReset();
    else if (S.route.name === 'admin') view = viewAdmin();
    else if (S.route.name === 'tournament') view = S.t ? viewTournament() : loading();
    else if (S.route.name === 'match') view = S.t ? viewMatch() : loading();
    else if (S.route.name === 'display') view = S.t ? viewDisplay() : loading();
    else view = viewHome();
    // The venue display is always dark (easier to read across a hall); leaving it restores the theme.
    const displaying = S.route.name === 'display' && !S.error;
    document.body.classList.toggle('display-mode', displaying);
    if (displaying) document.documentElement.setAttribute('data-theme', 'dark');
    else if (wasDisplaying) applyTheme(themePref());
    wasDisplaying = displaying;
    app.replaceChildren(...[view].flat(Infinity).filter(Boolean));
    applyBranding(['tournament', 'match', 'display'].includes(S.route.name) && S.t && !S.error ? S.t.branding : null);
    renderNav();
  }

  const markDirty = (e) => {
    const form = e.target.closest && e.target.closest('form');
    if (!form) return;
    if (form.closest('details[data-panel]')) {
      form.setAttribute('data-dirty', '');
      return;
    }
    // Other forms count as unsent while anything typed is still in them.
    const typed = [...form.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea')]
      .some((el) => el.value !== el.defaultValue && el.value.trim());
    if (typed) form.setAttribute('data-dirty', '');
    else form.removeAttribute('data-dirty');
  };
  app.addEventListener('input', markDirty);
  app.addEventListener('change', markDirty);

  // A held-back redraw runs once the person leaves the field, but never while
  // a finger or mouse button is down: redrawing between press and release
  // replaces the button under it and the tap is lost (and the form cleared).
  let pressing = false;
  const flushRender = () => {
    if (S.pendingRender && !pressing && !isEditing()) render();
  };
  document.addEventListener('pointerdown', () => { pressing = true; }, true);
  const release = () => setTimeout(() => { pressing = false; flushRender(); }, 100); // after the click it makes
  document.addEventListener('pointerup', release, true);
  document.addEventListener('pointercancel', release, true);
  app.addEventListener('focusout', () => setTimeout(flushRender, 0));

  function errorView(message, code) {
    document.title = 'Tonament';
    if (code === 'private') {
      return h('div', { class: 'card center' },
        h('h2', {}, '🔒 This tournament isn\'t public'),
        h('p', { class: 'muted' }, 'Only the organisers can see it right now. Ask them for access, or check back once it\'s published.'),
        h('div', { class: 'actions', style: 'justify-content:center' },
          S.me ? null : h('a', { class: 'btn btn-primary', href: `/signin?next=${encodeURIComponent(location.pathname + location.search)}` }, 'Sign in'),
          h('a', { class: 'btn', href: '/' }, 'Back to home')));
    }
    return h('div', { class: 'card center' },
      h('h2', {}, 'Something went wrong'),
      h('p', { class: 'muted' }, message),
      h('a', { class: 'btn', href: '/' }, 'Back to home'));
  }

  // ---------- home
  function viewHome() {
    document.title = 'Tonament — One platform. Every sport. Every tournament.';
    const explore = (e) => {
      e.preventDefault();
      document.getElementById('all-tournaments')?.scrollIntoView({ behavior: 'smooth' });
    };
    return [
      h('section', { class: 'hero' },
        h('p', { class: 'eyebrow' }, 'One platform.', h('br'), 'Every sport.', h('br'), h('b', {}, 'Every tournament.')),
        h('h1', {}, 'Run your tournament. ', h('span', { class: 'accent' }, 'Score it live.')),
        h('p', { class: 'lead' }, `${liveSportNames()} today, more sports on the way. Draw groups, play a round-robin league, send the best into a knockout bracket — and let everyone follow every point as it happens.`),
        h('ul', { class: 'features' },
          ['League + Knockout', 'Live point-by-point scoring', 'Auto standings & bracket'].map((x) => h('li', {}, x))),
        h('div', { class: 'actions' },
          S.me
            ? h('a', { class: 'btn btn-primary btn-lg', href: '/new' }, 'Create tournament')
            : h('a', { class: 'btn btn-primary btn-lg', href: '/signup' }, 'Get started — it\'s free'),
          h('a', { class: 'btn btn-lg btn-ghost', href: '/', onclick: explore }, 'Explore tournaments'),
          h('a', { class: 'btn btn-lg btn-ghost', href: '/features' }, 'All features'))),
      S.me && S.myEntries && S.myEntries.length ? h('section', { class: 'section' },
        h('h2', {}, 'My entries'),
        h('div', { class: 'card-list' }, S.myEntries.map(myEntryCard))) : null,
      S.me ? h('section', { class: 'section' },
        h('h2', {}, 'My tournaments'),
        S.mine == null ? loading()
          : S.mine.length === 0 ? empty('Tournaments you create, or are added to as an organiser or umpire, show up here.')
            : h('div', { class: 'card-list' }, S.mine.map((t) => tournamentCard(t, ROLE_NAMES[t.role])))) : null,
      findSection(),
      sportsSection(),
    ];
  }

  // A tournament the player entered, with their entry and where it stands.
  const ENTRY_STATUS = {
    entered: ['done', 'Entered ✓'],
    waiting: ['waiting', 'On the waitlist'],
    payment: ['waiting', 'Payment not finished'],
    due: ['waiting', 'Payment due'],
    sent: ['waiting', 'Payment sent'],
    looking: ['waiting', 'Looking for a partner'],
    playing: ['live', 'In the draw'],
    withdrawn: ['', 'Withdrawn'],
  };
  function myEntryCard(t) {
    const card = tournamentCard(t);
    const [cls, label] = ENTRY_STATUS[t.entry.status] || ENTRY_STATUS.entered;
    card.href = `/t/${t.id}/entries${t.entry.eventName ? `?e=${t.entry.eventId}` : ''}`;
    card.append(h('div', { class: 'my-entry' },
      h('span', {}, h('strong', {}, t.entry.name), t.entry.eventName ? ` · ${t.entry.eventName}` : ''),
      pill(cls, label)));
    return card;
  }

  // ----- find a tournament (home page)
  const FILTER_KEYS = ['q', 'sport', 'event', 'age', 'level', 'country', 'region', 'city', 'when', 'open', 'prizes'];
  const WHEN = [['upcoming', 'Upcoming & live'], ['week', 'Next 7 days'], ['month', 'Next 30 days'], ['past', 'Past'], ['any', 'Any time']];
  const FILTERS_KEY = 'tonament:filters';

  // From the URL when it has filters (a shared search), else this viewer's last search.
  function readFilters(params) {
    const f = {};
    for (const k of FILTER_KEYS) if (params.get(k)) f[k] = params.get(k);
    if (Object.keys(f).length) return f;
    try { return JSON.parse(localStorage.getItem(FILTERS_KEY)) || {}; } catch { return {}; }
  }
  function filterQuery(f, withToday) {
    const p = new URLSearchParams();
    for (const k of FILTER_KEYS) if (f[k]) p.set(k, f[k]);
    if (withToday) p.set('today', localToday());
    return p.toString();
  }
  const activeFilters = (f) => FILTER_KEYS.filter((k) => k !== 'q' && f[k] && !(k === 'when' && f[k] === 'upcoming')).length;

  let searchTimer;
  let searchSeq = 0;
  async function search() {
    const seq = ++searchSeq;
    const qs = filterQuery(S.filters);
    history.replaceState(null, '', qs ? `/?${qs}` : '/');
    try { localStorage.setItem(FILTERS_KEY, JSON.stringify(S.filters)); } catch { /* fine */ }
    const list = await api('GET', `/tournaments?${filterQuery(S.filters, true)}`).catch(() => null);
    if (seq !== searchSeq || S.route.name !== 'home') return;
    S.list = list || [];
    // Only the results change, so typing in the search box keeps its focus.
    const box = document.getElementById('find-results');
    if (box) box.replaceChildren(findResults());
    else render();
  }
  function setFilter(key, value) {
    S.filters = { ...S.filters, [key]: value };
    if (key === 'country') { delete S.filters.region; delete S.filters.city; }
    if (key === 'region') delete S.filters.city;
    for (const k of FILTER_KEYS) if (!S.filters[k]) delete S.filters[k];
    if (key !== 'q') render(); // dependent dropdowns may change
    clearTimeout(searchTimer);
    searchTimer = setTimeout(search, key === 'q' ? 300 : 0);
  }

  function findResults() {
    if (S.list == null) return loading();
    if (!S.list.length) {
      const filtered = activeFilters(S.filters) || S.filters.q;
      return h('div', {},
        empty(filtered ? 'No tournaments match these filters.' : 'No upcoming tournaments yet — create the first one.'),
        filtered ? h('div', { class: 'actions', style: 'justify-content:center' },
          h('button', { class: 'btn btn-ghost btn-small', onclick: () => { S.filters = {}; render(); search(); } }, 'Clear filters')) : null);
    }
    return h('div', { class: 'card-list' }, S.list.map((t) => tournamentCard(t)));
  }

  function findSection() {
    const f = S.filters;
    const places = S.places || [];
    const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort();
    const withValue = (list, v) => (v && !list.includes(v) ? [...list, v] : list);
    const countries = withValue(uniq(places.map((p) => p.country)), f.country);
    const regionsHere = withValue(uniq(places.filter((p) => p.country === f.country).map((p) => p.region)), f.region);
    const cities = withValue(uniq(places.filter((p) => p.country === f.country && (!f.region || p.region === f.region)).map((p) => p.city)), f.city);
    const select = (key, label, options, { anyLabel = 'Any', disabled = false } = {}) => h('label', { class: 'filter' },
      h('span', { class: 'label' }, label),
      h('select', { value: f[key] || '', disabled, onchange: (e) => setFilter(key, e.target.value) },
        anyLabel ? h('option', { value: '' }, anyLabel) : null,
        options.map((o) => (Array.isArray(o) ? h('option', { value: o[0] }, o[1]) : h('option', { value: o }, o)))));
    const n = activeFilters(f);
    const wide = window.matchMedia && window.matchMedia('(min-width: 720px)').matches;
    return h('section', { class: 'section', id: 'all-tournaments' },
      h('h2', {}, 'Find a tournament'),
      h('div', { class: 'find-bar' },
        h('input', {
          type: 'search', class: 'find-q', value: f.q || '', placeholder: 'Search by name or venue', 'aria-label': 'Search tournaments',
          oninput: (e) => setFilter('q', e.target.value.trim()),
        }),
        h('details', { class: 'filters', open: wide || S.filtersOpen || null, ontoggle: (e) => { S.filtersOpen = e.target.open; } },
          h('summary', { class: 'btn btn-ghost btn-small' }, n ? `Filters (${n})` : 'Filters'),
          h('div', { class: 'filter-grid' },
            select('when', 'When', WHEN.map(([v, l]) => [v === 'upcoming' ? '' : v, l]), { anyLabel: null }),
            select('sport', 'Sport', liveSports().map((s) => [s.id, s.name])),
            select('event', 'Event', CAT.presetsFor(f.sport).map((p) => [p.key, p.label])),
            select('age', 'Age group', CAT.agesFor(f.sport)),
            select('level', 'Level', CAT.levelsFor(f.sport)),
            select('country', 'Country', countries),
            select('region', 'State / region', regionsHere, { disabled: !f.country || !regionsHere.length }),
            select('city', 'City', cities, { disabled: !f.country || !cities.length }),
            h('label', { class: 'check-field filter-open' },
              h('input', { type: 'checkbox', checked: f.open === '1', onchange: (e) => setFilter('open', e.target.checked ? '1' : '') }),
              h('span', {}, h('strong', {}, 'Open for entries'))),
            h('label', { class: 'check-field filter-open' },
              h('input', { type: 'checkbox', checked: f.prizes === '1', onchange: (e) => setFilter('prizes', e.target.checked ? '1' : '') }),
              h('span', {}, h('strong', {}, 'Prize money')))))),
      h('div', { id: 'find-results' }, findResults()));
  }

  const liveSports = () => S.sports.filter((s) => s.status === 'live');
  const liveSportNames = () => liveSports().map((s) => s.name).join(', ') || 'Badminton';

  // Playable sports, plus the ones on the way with a "Request this sport" vote.
  function sportsSection() {
    if (!S.sports.length) return null;
    const counts = (S.interest && S.interest.counts) || {};
    const mine = new Set((S.interest && S.interest.mine) || []);
    const upcoming = S.sports.filter((s) => s.status !== 'live');
    return h('section', { class: 'section', id: 'sports' },
      h('div', { class: 'card-head' },
        h('h2', {}, 'Sports'),
        h('span', { class: 'muted small' }, `${liveSportNames()} today · more on the way`)),
      h('div', { class: 'sport-chips' },
        liveSports().map((s) => h('span', { class: 'sport-chip live' }, s.name, h('span', { class: 'chip-tag' }, 'Live'))),
        upcoming.map((s) => {
          const voted = mine.has(s.id);
          const n = counts[s.id] || 0;
          return h('button', {
            type: 'button',
            class: `sport-chip${voted ? ' voted' : ''}`,
            'aria-pressed': String(voted),
            'aria-label': `${s.name}, ${s.status === 'later' ? 'planned' : 'coming soon'}, ${n} request${n === 1 ? '' : 's'}. ${voted ? 'You requested it — tap to withdraw.' : 'Tap to request it.'}`,
            onclick: () => requestSport(s, !voted),
          },
          voted ? '✓ ' : null, s.name,
          h('span', { class: 'chip-tag' }, s.status === 'later' ? 'Later' : 'Soon'),
          n ? h('span', { class: 'chip-count' }, n) : null);
        })),
      h('p', { class: 'hint', style: 'margin:10px 0 0' },
        S.me
          ? 'Tap a sport to request it. The most requested sports get built first.'
          : [h('a', { href: '/signin?next=/' }, 'Sign in'), ' to request a sport. The most requested sports get built first.']));
  }

  async function requestSport(s, want) {
    if (!S.me) {
      navigate('/signin?next=/');
      return;
    }
    try {
      S.interest = await api('POST', `/sports/${s.id}/interest`, { want });
      toast(want ? `Thanks — ${s.name} requested` : `${s.name} request withdrawn`);
    } catch (e) {
      toast(e.message, true);
    }
    render();
  }

  function tournamentCard(t, roleName) {
    const sport = S.sports.find((s) => s.id === t.sport);
    return h('a', { class: `card t-card${t.cover ? ' has-cover' : ''}`, href: `/t/${t.id}` },
      t.cover ? h('img', { class: 't-card-cover', src: t.cover, alt: '', loading: 'lazy' }) : null,
      h('div', { class: 'card-head' },
        h('h3', {}, t.name),
        h('span', {}, visibilityPill(t.visibility), ' ', roleName ? pill('org', roleName) : null, ' ',
          t.entriesOpen ? pill('done', 'Entries open') : pill(t.status, STATUS[t.status]))),
      t.startsOn || t.venue || t.city
        ? h('div', { class: 't-card-when' }, [fmtSchedule(t), placeLine(t.venue, t.city)].filter(Boolean).join(' · '))
        : null,
      // Events by short name ("MS U19 · XD") once a tournament has real categories.
      (t.events || []).length > 1 || ((t.events || [])[0] && t.events[0] !== 'Open')
        ? h('div', { class: 't-card-events' }, t.events.map((e) => h('span', { class: 'event-tag' }, e)))
        : null,
      t.prizeTotal || t.meals
        ? h('div', { class: 't-card-events' },
          t.prizeTotal ? h('span', { class: 'event-tag perk-tag' }, `🏆 ${rupees(t.prizeTotal)} in prizes`) : null,
          t.meals ? h('span', { class: 'event-tag perk-tag' }, 'Meals included') : null)
        : null,
      h('div', { class: 'muted small' }, [sport ? sport.name : t.sport, (t.events || []).length > 1 ? null : t.formatName, `${t.entries} entries`].filter(Boolean).join(' · ')));
  }

  // ---------- create / settings
  const FORMATS = [
    ['league_knockout', 'League + Knockout', 'Groups play round-robin; the top finishers go into a knockout bracket.'],
    ['league', 'League only', 'Everyone in a group plays each other; the table decides the winner.'],
    ['knockout', 'Knockout only', 'Single elimination, seeded in entry order. Byes go to top seeds.'],
  ];

  // State: a list for countries we know, free text otherwise.
  function regionControl(country, value) {
    const list = country === OTHER_COUNTRY ? null : REGIONS.regionsFor(country);
    if (!list) return h('input', { name: 'region', maxlength: 60, value: value || '', placeholder: 'Optional' });
    return h('select', { name: 'region', value: list.includes(value) ? value : '' },
      h('option', { value: '' }, 'Choose…'), list.map((r) => h('option', { value: r }, r)));
  }

  function syncCountry(form) {
    const choice = form.countryChoice.value;
    form.querySelector('.country-other').hidden = choice !== OTHER_COUNTRY;
    form.querySelector('.region-slot').replaceChildren(regionControl(choice, ''));
    const list = form.querySelector('#city-options');
    list.replaceChildren(...cityOptions(choice === OTHER_COUNTRY ? '' : choice));
  }

  const cityOptions = (country) => [...new Set((S.places || []).filter((p) => p.city && (!country || p.country === country)).map((p) => p.city))]
    .map((c) => h('option', { value: c }));

  // When and where (create form, settings, and after the start).
  function detailsFields(v) {
    const listed = !v.country || REGIONS.isListed(v.country);
    const choice = listed ? v.country || REGIONS.defaultCountry : OTHER_COUNTRY;
    return [
      h('fieldset', { class: 'details-set' }, h('legend', {}, 'When'),
        h('div', { class: 'grid-2' },
          field('Start date', h('input', { type: 'date', name: 'startsOn', value: v.startsOn || '' }), null, 'Helps players find your tournament.'),
          field('Start time', h('input', { type: 'time', name: 'startTime', value: v.startTime || '' }), null, 'When play begins, at the venue.')),
        h('div', { class: 'grid-2' },
          field('End date (optional)', h('input', { type: 'date', name: 'endsOn', value: v.endsOn || '' }), null, 'For events over more than one day.'),
          field('Finish time (optional)', h('input', { type: 'time', name: 'endTime', value: v.endTime || '' }), null, 'Roughly; over several days, the daily hours.'))),
      h('fieldset', { class: 'details-set' }, h('legend', {}, 'Venue'),
        field('Venue name', h('input', { name: 'venue', maxlength: 80, value: v.venue || '', placeholder: 'e.g. City Sports Hall' })),
        field('Address', h('input', { name: 'address', maxlength: 120, value: v.address || '', placeholder: 'Street and area', autocomplete: 'off' })),
        h('div', { class: 'grid-2' },
          field('Country', h('div', { class: 'stack' },
            h('select', { name: 'countryChoice', value: choice, onchange: (e) => syncCountry(e.target.form) },
              REGIONS.countries.map((c) => h('option', { value: c }, c)), h('option', { value: OTHER_COUNTRY }, 'Other country…')),
            h('input', { class: 'country-other', name: 'countryOther', maxlength: 60, value: listed ? '' : v.country, placeholder: 'Country', hidden: listed }))),
          field('State / region', h('div', { class: 'region-slot' }, regionControl(choice, v.region)))),
        h('div', { class: 'grid-2' },
          field('City', h('input', { name: 'city', maxlength: 60, value: v.city || '', list: 'city-options', autocomplete: 'off', placeholder: 'e.g. Chennai' })),
          field('Postcode / PIN', h('input', { name: 'postcode', maxlength: 20, value: v.postcode || '', inputmode: 'numeric', autocomplete: 'off' }))),
        h('datalist', { id: 'city-options' }, cityOptions(listed ? choice : ''))),
    ];
  }

  function readDetails(form) {
    const fd = new FormData(form);
    const choice = fd.get('countryChoice');
    return {
      venue: fd.get('venue') || '',
      address: fd.get('address') || '',
      city: fd.get('city') || '',
      region: fd.get('region') || '',
      postcode: fd.get('postcode') || '',
      country: choice === OTHER_COUNTRY ? fd.get('countryOther') || '' : choice,
      startsOn: fd.get('startsOn') || '',
      endsOn: fd.get('endsOn') || '',
      startTime: fd.get('startTime') || '',
      endTime: fd.get('endTime') || '',
    };
  }

  // Self-entry for the whole tournament.
  function entryFields(v) {
    return h('fieldset', { class: 'entry-settings' }, h('legend', {}, 'Entries'),
      h('label', { class: 'check-field' },
        h('input', { type: 'checkbox', name: 'selfEntry', checked: v.selfEntry !== false }),
        h('span', {}, h('strong', {}, 'Players can enter themselves'), h('small', {}, 'Adds an "Enter" form to the public page. You can still add people yourself.'))),
      field('Entries close (optional)', h('input', { type: 'datetime-local', name: 'entriesCloseAt', value: toLocalInput(v.entriesCloseAt) }), null,
        'Leave empty to keep entries open until each event starts.'));
  }

  // Format, entry cap, late entry and scoring (one event, or defaults for new ones).
  function formatFields(sport, v, legend = 'Format') {
    return [
      h('fieldset', { class: 'formats' }, h('legend', {}, legend),
        FORMATS.map(([value, label, desc]) => h('label', { class: 'format-option' },
          h('input', { type: 'radio', name: 'format', value, checked: v.format === value, onchange: (e) => syncFormat(e.target.form) }),
          h('span', {}, h('strong', {}, label), h('small', {}, desc))))),
      h('div', { class: 'grid-2' },
        field('Players per group (about)', h('input', { type: 'number', name: 'groupSize', min: 2, max: 16, value: v.groupSize ?? 4, required: true }), 'groups-field',
          'Groups are made from the final head-count when you start.'),
        field('Qualify from each group', h('input', { type: 'number', name: 'qualifiers', min: 1, max: 8, value: v.qualifiers, required: true }), 'qualifiers-field')),
      h('fieldset', { class: 'entry-settings' }, h('legend', {}, 'Places'),
        field('Maximum entries (optional)', h('input', { type: 'number', name: 'maxEntries', min: 2, max: 128, value: v.maxEntries ?? '', placeholder: 'No limit' }), null,
          'Players see how many places are left. Once it\'s reached, new entries join a waitlist for you to confirm.'),
        h('label', { class: 'check-field' },
          h('input', { type: 'checkbox', name: 'lateEntry', checked: Boolean(v.lateEntry) }),
          h('span', {}, h('strong', {}, 'Allow late entries after the start'), h('small', {}, 'Latecomers join the smallest group with catch-up matches, or take a bye in a knockout. You can change this during play.')))),
      scoringFields(sport, v.scoring),
    ];
  }

  // The sport's own scoring settings (from its rules module).
  function scoringFields(sport, scoring) {
    return h('fieldset', { class: 'scoring-set' }, h('legend', {}, `${sport.name} scoring`),
      h('div', { class: 'grid-3' }, sport.fields.map((f) => field(f.label,
        f.type === 'select'
          ? h('select', { name: `scoring.${f.key}`, value: scoring[f.key] }, f.options.map((o) => h('option', { value: o.value }, o.label)))
          : h('input', { type: 'number', name: `scoring.${f.key}`, min: f.min, max: f.max, value: scoring[f.key], required: true }),
        null, f.hint))));
  }

  // A select of standard values with "Custom…" revealing a text box.
  function choiceField(label, name, options, value) {
    const custom = value && !options.includes(value);
    const select = h('select', {
      name: `${name}Choice`,
      value: custom ? '__custom' : value || options[0],
      onchange: (e) => { box.hidden = e.target.value !== '__custom'; if (!box.hidden) box.focus(); },
    }, options.map((o) => h('option', { value: o }, o)), h('option', { value: '__custom' }, 'Custom…'));
    const box = h('input', { name: `${name}Custom`, maxlength: 30, value: custom ? value : '', placeholder: `Custom ${label.toLowerCase()}`, hidden: !custom });
    return field(label, h('div', { class: 'stack' }, select, box));
  }
  const readChoice = (fd, name) => (fd.get(`${name}Choice`) === '__custom' ? (fd.get(`${name}Custom`) || '').trim() || 'Open' : fd.get(`${name}Choice`));

  // What an event is: type, age group, level, optional name.
  function categoryFields(v, sport) {
    const type = v.discipline === 'any' ? 'any' : `${v.gender}-${v.discipline}`;
    const types = eventTypes(sport);
    return h('fieldset', { class: 'details-set' }, h('legend', {}, 'Event'),
      h('div', { class: 'grid-2' },
        field('Type', h('select', { name: 'type', value: type }, types.map(([value, label]) => h('option', { value }, label)))),
        field('Name (optional)', h('input', { name: 'eventName', maxlength: 60, value: v.customName || '', placeholder: 'Generated from the type' }))),
      h('div', { class: 'grid-2' }, choiceField('Age group', 'age', CAT.agesFor(sport), v.age), choiceField('Level', 'level', CAT.levelsFor(sport), v.level)));
  }

  function readCategory(form) {
    const fd = new FormData(form);
    const type = fd.get('type');
    const [gender, discipline] = type === 'any' ? ['open', 'any'] : type.split('-');
    return { discipline, gender, age: readChoice(fd, 'age'), level: readChoice(fd, 'level'), name: fd.get('eventName') || '' };
  }

  // ----- event list builder (create form and Events tab)
  // One row per event, each with its own type, age group and level.
  // The event types a sport offers (team sports: teams; beach volleyball: pairs).
  const eventTypes = (sport) => [
    ...CAT.presetsFor(sport).map((p) => [`${p.gender}-${p.discipline}`, p.label]),
    ...(CAT.disciplinesFor(sport).includes('any') ? [['any', 'Open (singles or pairs)']] : []),
  ];
  const typeOf = (e) => (e.discipline === 'any' ? 'any' : `${e.gender}-${e.discipline}`);
  const fromType = (type) => {
    if (type === 'any') return { gender: 'open', discipline: 'any' };
    const [gender, discipline] = type.split('-');
    return { gender, discipline };
  };

  // Standard values plus "Custom…", read with .read(); not tied to form field names.
  function pickControl(label, options, value, onchange) {
    const custom = value && !options.includes(value);
    const box = h('input', {
      class: 'pick-custom', maxlength: 30, value: custom ? value : '', placeholder: `Custom ${label.toLowerCase()}`,
      'aria-label': `Custom ${label.toLowerCase()}`, hidden: !custom, oninput: onchange,
    });
    const select = h('select', {
      value: custom ? '__custom' : value || options[0],
      onchange: (e) => {
        box.hidden = e.target.value !== '__custom';
        if (!box.hidden) box.focus();
        onchange();
      },
    }, options.map((o) => h('option', { value: o }, o)), h('option', { value: '__custom' }, 'Custom…'));
    const wrap = h('div', { class: 'stack' }, select, box);
    wrap.read = () => (select.value === '__custom' ? box.value.trim() || 'Open' : select.value);
    return wrap;
  }

  function eventBuilder(initial = [], sport) {
    const types = eventTypes(sport);
    // Rows carried over from another sport switch to this sport's first type.
    const fit = (v) => (types.some(([value]) => value === typeOf(v)) ? v : { ...v, ...fromType(types[0][0]) });
    const list = h('div', { class: 'ev-rows' });
    const note = h('p', { class: 'ev-note', hidden: true });
    const touched = () => list.closest('form')?.setAttribute('data-dirty', ''); // keep live redraws away
    const rows = () => [...list.children];

    function refresh() {
      const seen = new Set();
      for (const r of rows()) {
        const name = CAT.eventName(r.read());
        const dup = seen.has(name.toLowerCase());
        seen.add(name.toLowerCase());
        r.classList.toggle('dup', dup);
        r.preview.textContent = dup ? `${name} — already in the list` : name;
      }
      note.hidden = rows().length > 0;
      note.textContent = 'Add at least one event.';
    }

    function addRow(v) {
      const row = h('div', { class: 'ev-row' });
      v = fit(v);
      const type = h('select', { 'aria-label': 'Event type', value: typeOf(v), onchange: refresh },
        types.map(([value, label]) => h('option', { value }, label)));
      const age = pickControl('Age group', CAT.agesFor(sport), v.age, refresh);
      const level = pickControl('Level', CAT.levelsFor(sport), v.level, refresh);
      row.read = () => ({ ...fromType(type.value), age: age.read(), level: level.read() });
      row.preview = h('div', { class: 'ev-preview', 'aria-live': 'polite' });
      row.append(
        field('Event', type, 'ev-type'),
        field('Age group', age, 'ev-age'),
        field('Level', level, 'ev-level'),
        h('button', { type: 'button', class: 'icon-btn ev-remove', 'aria-label': 'Remove this event', title: 'Remove', onclick: () => { row.remove(); touched(); refresh(); } }, '✕'),
        row.preview);
      list.append(row);
      refresh();
    }

    // "Add several at once": every ticked type × age group × level.
    const ticks = (options, prefix) => h('div', { class: 'quick-grid' }, options.map(([value, label]) => h('label', { class: 'check-field' },
      h('input', { type: 'checkbox', 'data-group': prefix, value }), h('span', {}, label))));
    const several = h('details', { class: 'ev-several' },
      h('summary', {}, 'Add several at once'),
      h('p', { class: 'hint' }, 'Tick event types, age groups and levels — one event is added for every combination.'),
      h('strong', {}, 'Events'), ticks(CAT.presetsFor(sport).map((p) => [`${p.gender}-${p.discipline}`, p.label]), 'type'),
      h('strong', {}, 'Age groups'), ticks(CAT.agesFor(sport).map((a) => [a, a]), 'age'),
      h('strong', {}, 'Levels'), ticks(CAT.levelsFor(sport).map((l) => [l, l]), 'level'),
      h('button', {
        type: 'button',
        class: 'btn btn-small',
        onclick: () => {
          const picked = (g) => [...several.querySelectorAll(`input[data-group=${g}]:checked`)].map((i) => i.value);
          const types = picked('type');
          if (!types.length) { toast('Tick at least one event type', true); return; }
          const ages = picked('age').length ? picked('age') : ['Open'];
          const levels = picked('level').length ? picked('level') : ['Open'];
          const have = new Set(rows().map((r) => CAT.eventName(r.read()).toLowerCase()));
          let added = 0;
          for (const t of types) for (const age of ages) for (const level of levels) {
            const v = { ...fromType(t), age, level };
            if (have.has(CAT.eventName(v).toLowerCase())) continue;
            have.add(CAT.eventName(v).toLowerCase());
            addRow(v);
            added++;
          }
          for (const i of several.querySelectorAll('input:checked')) i.checked = false;
          several.open = false;
          touched();
          toast(added ? `${added} event${added > 1 ? 's' : ''} added to the list` : 'Those events are already in the list');
        },
      }, 'Add these events'));

    const builder = h('fieldset', { class: 'details-set ev-builder' }, h('legend', {}, 'Events'),
      h('p', { class: 'hint', style: 'margin:0' }, 'One line per event — each gets its own entries and draw. Add the same event for different age groups or levels.'),
      list, note,
      h('div', { class: 'actions' },
        h('button', {
          type: 'button',
          class: 'btn btn-small',
          onclick: () => {
            const last = rows().at(-1);
            addRow(last ? last.read() : { discipline: 'singles', gender: 'men', age: 'Open', level: 'Open' });
            touched();
          },
        }, '+ Add event')),
      several);
    // The events to create, or an error message.
    builder.readList = () => {
      const events = rows().map((r) => r.read());
      if (!events.length) return { error: 'Add at least one event' };
      const dup = rows().find((r) => r.classList.contains('dup'));
      if (dup) return { error: `${CAT.eventName(dup.read())} is in the list twice` };
      return { events };
    };
    for (const v of initial) addRow(v);
    refresh();
    return builder;
  }
  const readEventList = (form) => form.querySelector('.ev-builder').readList();

  function syncFormat(form) {
    const fmt = form.querySelector('input[name=format]:checked')?.value;
    form.querySelector('.groups-field').hidden = fmt === 'knockout';
    form.querySelector('.qualifiers-field').hidden = fmt !== 'league_knockout';
  }

  function readTournament(form) {
    const fd = new FormData(form);
    return {
      ...readDetails(form),
      name: fd.get('name'),
      selfEntry: fd.get('selfEntry') === 'on',
      entriesCloseAt: fd.get('entriesCloseAt') ? new Date(fd.get('entriesCloseAt')).toISOString() : '',
    };
  }

  function readFormat(form, sport) {
    const fd = new FormData(form);
    const scoring = {};
    for (const f of sport.fields) {
      const v = fd.get(`scoring.${f.key}`);
      scoring[f.key] = f.type === 'select' && typeof f.options[0].value === 'string' ? v : Number(v);
    }
    return {
      format: fd.get('format'),
      groupSize: Number(fd.get('groupSize')),
      qualifiers: Number(fd.get('qualifiers')),
      maxEntries: fd.get('maxEntries') ? Number(fd.get('maxEntries')) : '',
      lateEntry: fd.get('lateEntry') === 'on',
      scoring,
    };
  }

  function viewNew() {
    document.title = 'New tournament · Tonament';
    const sport = liveSports()[0];
    if (!sport) return loading();
    const form = h('form', {
      class: 'card form',
      onsubmit: async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const { events, error } = readEventList(form);
          if (error) throw new Error(error);
          const chosen = S.sports.find((s) => s.id === form.sport.value);
          const body = { sport: chosen.id, ...readTournament(form), ...readFormat(form, chosen), events };
          const { id } = await api('POST', '/tournaments', body);
          toast('Tournament created — now add your players');
          navigate(`/t/${id}`);
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      },
    },
    h('h1', {}, 'New tournament'),
    field('Tournament name', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'e.g. Club Championship 2026', autocomplete: 'off' })),
    h('div', {},
      field('Sport', h('select', {
        name: 'sport',
        // Each sport has its own scoring settings and category lists.
        onchange: (e) => {
          const next = S.sports.find((s) => s.id === e.target.value);
          const builder = form.querySelector('.ev-builder');
          const { events } = builder.readList();
          builder.replaceWith(eventBuilder(events || [], next.id));
          form.querySelector('.scoring-set').replaceWith(scoringFields(next, next.defaults));
        },
      }, S.sports.map((s) => h('option', {
        value: s.id,
        disabled: s.status !== 'live',
      }, s.status === 'live' ? s.name : `${s.name} (coming soon)`))), null,
      h('span', {}, 'More sports are on the way — ', h('a', { href: '/' }, 'request yours on the home page'), '.'))),
    detailsFields({ country: REGIONS.defaultCountry }),
    eventBuilder([{ discipline: 'singles', gender: 'open', age: 'Open', level: 'Open' }], sport.id),
    entryFields({ selfEntry: true }),
    formatFields(sport, { format: 'league_knockout', groupSize: 4, qualifiers: 2, maxEntries: null, lateEntry: false, scoring: sport.defaults }, 'Format (for every event — change any of them later)'),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Create tournament')));
    syncFormat(form);
    return form;
  }

  // ---------- tournament page
  function tabsFor(t) {
    if (t.status === 'setup') return [{ id: 'entries', label: 'Entries' }];
    const tabs = [{ id: 'live', label: 'Live & results' }];
    if (t.format !== 'knockout') tabs.push({ id: 'groups', label: 'Groups' });
    if (t.format !== 'league') tabs.push({ id: 'bracket', label: 'Knockout' });
    tabs.push({ id: 'entries', label: 'Players' });
    return tabs;
  }

  function tabsWithTeam(t) {
    const tabs = tabsFor(t);
    if (t.courts) tabs.push({ id: 'courts', label: 'Courts' });
    if (hasPage(t)) tabs.push({ id: 'about', label: 'About' });
    if (t.can.manage) tabs.push({ id: 'events', label: 'Events' }, { id: 'team', label: 'Team' });
    return tabs;
  }

  // Chips to switch event; only shown when there's more than one.
  function eventPicker(t, current) {
    if (!multiEvent(t)) return null;
    return h('nav', { class: 'event-picker', 'aria-label': 'Events' },
      t.events.map((ev) => h('a', {
        class: `event-chip${ev.id === current.id ? ' active' : ''}`,
        href: `/t/${t.id}/${S.route.tab && !['events', 'team', 'courts', 'about'].includes(S.route.tab) ? S.route.tab : 'entries'}?e=${ev.id}`,
        'aria-current': ev.id === current.id ? 'true' : null,
      },
      h('span', { class: `dot ${ev.status}`, 'aria-hidden': 'true' }),
      h('span', { class: 'event-chip-name' }, ev.name),
      h('span', { class: 'event-chip-count' }, ev.entries.length))));
  }

  function viewTournament() {
    const tt = S.t;
    const ev = currentEvent(tt);
    const t = withEvent(tt, ev);
    document.title = `${tt.name} · Tonament`;
    const tabs = tabsWithTeam(t);
    const active = tabs.some((x) => x.id === S.route.tab) ? S.route.tab : tabs[0].id;
    const panels = { entries: panelEntries, live: panelLive, groups: panelGroups, bracket: panelBracket, team: panelTeam, events: panelEvents, about: panelAbout, courts: () => panelCourts(tt) };
    const perEvent = !['team', 'events', 'about', 'courts'].includes(active);
    const statusLine = multiEvent(tt) ? (tt.entriesOpen ? 'Entries open' : null) : entryStatusLine(t);
    const b = tt.branding;
    return [
      b ? h('div', { class: 'org-bar' },
        b.logo ? h('img', { src: b.logo, alt: '', class: 'org-logo' }) : null,
        b.orgName ? h('span', { class: 'org-name' }, b.orgName) : null) : null,
      tt.cover ? h('div', { class: 't-hero' }, h('img', { src: tt.cover, alt: '' })) : null,
      h('header', { class: 't-header' },
        h('div', { class: 't-title' }, h('h1', {}, tt.name), pill(tt.status, STATUS[tt.status]), tt.can.score ? visibilityPill(tt.visibility) : null,
          tt.official ? pill('org', 'Organised by Tonament') : null,
          tt.visibility !== 'private' ? h('button', { class: 'btn btn-small btn-ghost t-share', onclick: () => shareTournament(tt) }, 'Share') : null),
        h('p', { class: 'muted small' },
          [fmtSchedule(tt), placeLine(tt.venue, tt.location.city), tt.sport.name, multiEvent(tt) ? `${tt.events.length} events` : t.formatName, statusLine]
            .filter(Boolean).join(' · '), '  ', connDot())),
      roleBar(t),
      tt.visibility === 'private' ? visibilityBanner(t) : null,
      perEvent ? eventPicker(tt, ev) : null,
      h('nav', { class: 'tabs' }, tabs.map((x) => h('a', { href: tabHref(t, x.id), class: x.id === active ? 'active' : '' }, x.label))),
      perEvent && multiEvent(tt)
        ? h('p', { class: 'event-title' }, h('strong', {}, ev.name), ' · ', ev.formatName, ev.fee ? ` · ${money(ev.fee)} entry` : '', prizeMoney(ev) ? ` · 🏆 ${rupees(prizeMoney(ev))} in prizes` : '', ev.status !== 'setup' ? ` · ${STATUS[ev.status]}` : '')
        : null,
      h('section', {}, panels[active](t)),
      brandFooter(tt),
    ];
  }

  // ----- entries tab
  function entryStatusLine(t) {
    if (t.status !== 'setup') return null;
    if (t.entriesOpen) {
      if (t.placesLeft === 0) return 'Full · waitlist open';
      const places = t.placesLeft != null ? ` · ${t.placesLeft} of ${t.config.maxEntries} places left` : '';
      return t.config.entriesCloseAt ? `Entries open${places} · close ${fmtWhen(t.config.entriesCloseAt)}` : `Entries open${places}`;
    }
    return t.config.selfEntry ? 'Entries closed' : null;
  }

  function panelEntries(t) {
    const setup = t.status === 'setup';
    const editable = t.can.manage && setup;
    const running = t.status === 'league' || t.status === 'knockout';
    const usingCheckIn = setup && t.entries.some((e) => e.checkedIn);
    const hereCount = t.entries.filter((e) => e.checkedIn).length;
    const confirmedCount = allEntries(t).filter((e) => e.confirmed).length; // the plan counts every event
    const groupLabel = (g) => (g == null || t.format === 'knockout' ? null : h('span', { class: 'pill' }, `Group ${String.fromCharCode(65 + g)}`));
    const tags = (e) => [
      setup && !e.confirmed && e.feeStatus !== 'pending' ? pill('waiting', t.can.manage ? 'Unconfirmed' : 'Awaiting confirmation') : null,
      t.event.fee && t.can.manage ? (e.members ? e.members.map((m) => feePill(m)) : feePill(e)) : null,
      e.source === 'self' ? pill('', 'Self-entered') : e.source === 'walk-in' ? pill('', 'Walk-in') : e.source === 'drawn' ? pill('', 'Drawn pair') : null,
      !setup && e.withdrawn ? pill('withdrawn', 'Withdrew') : null,
      !setup && !e.inDraw ? pill('', 'Didn\'t show') : null,
    ];

    const list = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, editable && usingCheckIn ? `Entries · ${hereCount} of ${t.entries.length} here` : `Entries (${t.entries.length})`),
        editable && t.entries.length ? h('span', { class: 'actions' },
          h('button', { class: 'btn btn-small btn-ghost', disabled: S.checkAllBusy, onclick: () => checkInAll(t, !usingCheckIn) },
            S.checkAllBusy ? 'Saving…' : usingCheckIn ? 'Clear check-in' : 'Check in all'),
          t.entries.length > 1 ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => shuffle(t) }, '🔀 Random draw') : null) : null),
      t.can.manage && t.event.fee
        ? h('p', { class: 'muted small', style: 'margin:0 0 8px' }, `Entry fee ${money(t.event.fee)} · ${money(t.event.feeTotal || 0)} collected`)
        : null,
      t.can.manage && t.limits && t.limits.entries
        ? h('p', { class: 'muted small entry-meter' },
          `${Math.min(confirmedCount, t.limits.entries)} of ${t.limits.entries} ${t.plan === 'free' ? 'free entries' : `entries (${t.planName} plan)`} used${multiEvent(t) ? ', all events' : ''}`,
          h('span', { class: 'progress' }, h('span', { style: `width:${Math.min(100, (confirmedCount / t.limits.entries) * 100)}%` })))
        : null,
      t.entries.length
        ? h('ol', { class: 'entries' }, t.entries.map((e, i) => h('li', {
          class: [
            !setup && (e.withdrawn || !e.inDraw) ? 'out' : '',
            usingCheckIn && !e.checkedIn ? 'not-here' : '',
            S.removing.has(e.id) ? 'removing' : '',
            S.shake === e.id ? 'shake' : '',
          ].filter(Boolean).join(' '),
        },
          editable
            ? h('button', {
              class: `check${e.checkedIn ? ' on' : ''}${S.pendingCheckIns.has(e.id) ? ' saving' : ''}`,
              'aria-pressed': String(e.checkedIn),
              'aria-busy': S.pendingCheckIns.has(e.id) ? 'true' : null,
              'aria-label': `${e.name} ${e.checkedIn ? 'is checked in' : 'is not checked in'}`,
              title: S.pendingCheckIns.has(e.id) ? 'Saving…' : e.checkedIn ? 'Checked in — tap to undo' : 'Tap when they arrive',
              onclick: () => checkIn(t, e, !e.checkedIn),
            }, e.checkedIn ? '✓' : '')
            : null,
          h('span', { class: 'seed' }, i + 1),
          h('span', { class: 'name' },
            h('span', { class: 'entry-name' }, e.name),
            e.contact || e.phone ? h('small', { class: 'contact' }, [e.contact, e.phone].filter(Boolean).join(' · ')) : null,
            e.players ? h('small', { class: 'contact' }, `Players: ${e.players.join(', ')}`) : null,
            e.members && t.can.manage && e.members.some((m) => m.contact)
              ? h('small', { class: 'contact' }, e.members.map((m) => `${m.name}: ${m.contact}`).join(' · '))
              : null,
            h('span', { class: 'entry-tags' }, tags(e), groupLabel(e.group)),
            editable && !e.confirmed && !['pending', 'due', 'sent'].includes(e.feeStatus)
              ? h('button', { class: 'btn btn-small btn-primary confirm-btn', onclick: () => confirmEntry(t, e) }, 'Confirm place')
              : null,
            t.event.fee && t.can.manage && !e.members ? feeActions(t, e) : null,
            editable && e.source === 'drawn'
              ? h('span', { class: 'fee-actions' }, h('button', { class: 'btn btn-small btn-ghost', onclick: () => splitPair(t, e) }, 'Split pair'))
              : null),
          editable ? h('span', { class: 'row-actions' },
            h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': `Move ${e.name} up`, disabled: i === 0, onclick: () => move(t, i, -1) }, '↑'),
            h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': `Move ${e.name} down`, disabled: i === t.entries.length - 1, onclick: () => move(t, i, 1) }, '↓'),
            h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${e.name}`, onclick: () => removeEntry(t, e) }, '✕')) : null,
          t.can.manage && running && e.inDraw && !e.withdrawn
            ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => withdrawEntry(t, e) }, 'Withdraw')
            : null)))
        : empty(editable ? `No entries yet. Add ${t.event.discipline === 'team' ? 'teams' : 'players or pairs'} above.` : 'No entries yet.'),
      editable && t.entries.length
        ? h('p', { class: 'hint', style: 'margin:8px 0 0' },
          'On the day, tick players as they arrive — once anyone is ticked, only ticked players go into the draw. List order is the seeding (1 = top seed).')
        : null);

    if (!t.can.manage) {
      return [
        venueCard(t),
        prizesCard(t, [t.event]),
        setup && t.entriesOpen ? publicEntryCard(t) : null,
        setup && t.solos.length
          ? h('div', { class: 'card' }, h('h2', {}, `Looking for a partner (${t.solos.length})`),
            h('p', { class: 'muted small', style: 'margin:0' }, t.solos.map((e) => e.name + (e.side ? ` (${e.side})` : '')).join(' · ')))
          : null,
        setup && !t.entriesOpen
          ? h('div', { class: 'banner info' }, t.config.selfEntry ? 'Entries are closed. The draw will appear here once the tournament starts.' : 'The organiser is still adding players. The draw will appear here once the tournament starts.')
          : null,
        list,
      ];
    }
    if (!setup) return [paymentsToCheck(t), upgradeCard(t), running ? lateEntryCard(t) : null, venueCard(t), prizesCard(t, [t.event]), list, prizeSettingsCard(t), tournamentSettingsCard(t)];
    return [paymentsToCheck(t), upgradeCard(t), venueCard(t), prizesCard(t, [t.event]), addEntriesForm(t, usingCheckIn), soloCard(t), list, startCard(t), eventSettingsCard(t), prizeSettingsCard(t), tournamentSettingsCard(t)];
  }

  function addEntriesForm(t, walkIn) {
    const ta = h('textarea', {
      name: 'names', rows: walkIn ? 2 : 4,
      placeholder: t.event.discipline === 'team' ? 'One team per line, e.g.\nChennai Spikers\nCity Smashers'
        : t.event.discipline === 'doubles' ? 'One pair per line, e.g.\nAsha Rao / Lee Chan\nRavi / Meena'
        : t.event.discipline === 'singles' ? 'One player per line, e.g.\nAsha Rao\nLee Chan'
          : 'One player or pair per line, e.g.\nAsha Rao\nLee / Chan',
      oninput: (e) => { S.draft = e.target.value; },
    });
    ta.value = S.draft;
    return h('form', {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        const names = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
        if (!names.length) return;
        act(async () => {
          S.t = await api('POST', `${tPath(t)}/entries`, withEv(t, { names, walkIn }), t.id);
          S.draft = '';
        }, `Added ${names.length} ${names.length === 1 ? 'entry' : 'entries'}`);
      },
    },
    h('h2', {}, walkIn ? 'Add walk-ins' : t.event.discipline === 'team' ? 'Add teams' : 'Add players or pairs'),
    walkIn ? h('p', { class: 'muted small' }, 'Walk-ins are checked in automatically.') : null,
    ta,
    h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add')));
  }

  // "Enter this tournament" for players (no account needed).
  function publicEntryCard(t) {
    const closes = t.config.entriesCloseAt ? `Entries close ${fmtWhen(t.config.entriesCloseAt)}.` : 'Entries close when the draw is made.';
    if (!S.me) {
      // Players enter with their account; sign-in brings them back here.
      const here = encodeURIComponent(`/t/${t.id}/entries${multiEvent(t) ? `?e=${t.eventId}` : ''}`);
      return h('div', { class: 'card entry-card' },
        h('h2', {}, multiEvent(t) ? `Enter ${t.event.name}` : 'Enter this tournament'),
        h('p', { class: 'muted small' }, `Sign in or create a free account to enter — it takes a minute, and you can follow your entries and withdraw if plans change. ${closes}`),
        h('div', { class: 'actions' },
          h('a', { class: 'btn btn-primary', href: `/signin?next=${here}` }, 'Sign in to enter'),
          h('a', { class: 'btn', href: `/signup?next=${here}` }, 'Create an account')));
    }
    // The player's own entry in this event (an unfinished payment doesn't count).
    const mine = (t.myEntries || []).find((e) => e.eventId === t.eventId && !e.withdrawn && e.feeStatus !== 'pending');
    if (mine) {
      const leave = () => {
        if (!confirm(`Withdraw ${mine.name} from ${multiEvent(t) ? t.event.name : t.name}?`)) return;
        act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${mine.id}/leave`, {}, t.id); }, 'Your entry has been withdrawn');
      };
      const canLeave = !mine.paired && !['paid', 'received', 'cash'].includes(mine.feeStatus);
      if (mine.feeStatus === 'due') return payCard(t, mine, leave);
      if (mine.feeStatus === 'sent') {
        return h('div', { class: 'card entry-card' },
          h('h2', {}, 'Payment sent — waiting for the organiser'),
          h('p', {}, h('strong', {}, mine.name), ` — ${(t.payment && t.payment.payee) || 'The organiser'} will check the payment${mine.payRef ? ` (UPI ref ${mine.payRef})` : ''} and confirm your place. This page updates once they do, and we'll email you.`),
          h('p', { class: 'muted small', style: 'margin:0' }, `Your reference is TN${mine.id}. ${closes}`),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-small btn-ghost', onclick: leave }, 'Withdraw my entry')));
      }
      const card = (title, body, foot) => h('div', { class: 'card entry-card' },
        h('h2', {}, title), h('p', {}, body),
        h('p', { class: 'muted small', style: 'margin:0' }, `${foot} ${closes}`),
        canLeave ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-small btn-ghost', onclick: leave }, 'Withdraw my entry')) : null);
      if (mine.paired) {
        // Entered alone and since paired up: their pair lists them as a member.
        const pair = t.entries.find((e) => e.members && e.members.some((m) => m.id === mine.id));
        const partner = pair && pair.members.find((m) => m.id !== mine.id);
        return card(`You're playing with ${partner ? partner.name : 'your partner'} ✓`, [h('strong', {}, pair ? pair.name : mine.name), ' is on the entry list. See you on the day!'], 'Something wrong? Contact the organiser.');
      }
      if (mine.solo && mine.confirmed) {
        return card('You\'re entered — looking for a partner', [h('strong', {}, mine.name), t.config.partners === 'drawn'
          ? ' — partners are drawn when the event starts. Your partner will show here.'
          : ' — the organiser will pair you with another player. Your partner will show here.'], 'Questions? Contact the organiser.');
      }
      if (!mine.confirmed) {
        return card('Entry received', [h('strong', {}, mine.name), ' — the organiser will confirm your place. This page updates once they do.'], 'Questions? Contact the organiser.');
      }
      return card('You\'re entered ✓', [h('strong', {}, mine.name), ' is on the entry list. See you on the day!'], ['paid', 'received', 'cash'].includes(mine.feeStatus) ? 'Paid ✓ — to withdraw, contact the organiser.' : 'Something wrong? Contact the organiser.');
    }
    const full = t.placesLeft === 0;
    const fee = t.event.fee || 0;
    const online = fee > 0 && t.event.feeOnline;
    const drawn = t.event.discipline === 'doubles' && t.config.partners === 'drawn';
    const team = t.event.discipline === 'team';
    const per = t.event.discipline === 'doubles' ? ' per pair' : team ? ' per team' : '';
    const payee = (t.payment && t.payment.payee) || 'the organiser';
    const feeLine = !fee ? ''
      : online ? `Entry fee ${money(fee)}${per}, paid online when you enter. `
        : `Entry fee ${money(fee)}${per}: after entering, pay ${payee} by UPI${full ? ' once a place opens' : ''}. `;
    // Online-paid events have no waitlist: nobody pays for a place that isn't there.
    if (online && full) {
      return h('div', { class: 'card entry-card' },
        h('h2', {}, `${multiEvent(t) ? t.event.name : 'This tournament'} is full`),
        h('p', { class: 'muted small', style: 'margin:0' }, 'All places have been taken. Questions? Contact the organiser.'));
    }
    const form = h('form', {
      class: 'card form entry-card',
      onsubmit: async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const body = Object.fromEntries(new FormData(form));
          const res = await api('POST', `${tPath(t)}/register`, withEv(t, body));
          if (res.payment) {
            const outcome = await payEntry(res.payment);
            if (outcome !== 'paid') {
              toast(outcome === 'cancelled' ? 'Payment cancelled — you haven\'t been charged. Enter again when you\'re ready.' : 'Payment didn\'t go through — please try again', outcome !== 'cancelled');
              btn.disabled = false;
              return;
            }
          }
          toast(res.payment ? 'Payment received — you\'re entered ✓ Your receipt is on its way.'
            : res.due ? `Entry received — now pay ${money(res.due)} to confirm your place`
              : res.confirmed === false ? 'Entry received — the organiser will confirm your place' : 'You\'re entered — see you there!');
          refresh();
          render();
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      },
    },
    h('div', {},
      h('h2', {}, multiEvent(t) ? (full ? `${t.event.name} is full` : `Enter ${t.event.name}`) : full ? 'This tournament is full' : 'Enter this tournament'),
      h('p', { class: 'muted small', style: 'margin:0' }, full
        ? 'Join the waitlist — the organiser will confirm your place if one opens up.'
        : `${feeLine}${t.placesLeft != null ? `${t.placesLeft} of ${t.config.maxEntries} places left. ` : ''}${closes}`)),
    h('div', { class: 'grid-2' },
      field(team ? 'Team name' : 'Your name', h('input', { name: 'name', required: true, maxlength: 40, autocomplete: team ? 'off' : 'name', value: team ? '' : S.me.name })),
      // Doubles events need a partner (or "find me one"); singles and teams
      // have none; catch-all events make it optional; drawn-partner events never ask.
      t.event.discipline === 'singles' || team || drawn ? null
        : t.event.discipline === 'doubles'
          ? field('Partner\'s name', h('input', { name: 'partner', required: true, maxlength: 40, autocomplete: 'off' }), 'partner-field')
          : field('Partner (doubles only)', h('input', { name: 'partner', maxlength: 40, autocomplete: 'off' }))),
    t.event.discipline === 'doubles' && !drawn
      ? h('label', { class: 'check-field' },
        h('input', { type: 'checkbox', name: 'solo', onchange: (e) => syncSolo(e.target.form, e.target.checked) }),
        h('span', {}, h('strong', {}, 'I don\'t have a partner — find me one'),
          h('small', {}, `The organiser pairs you with another player looking for a partner.${fee ? ` You pay half the pair fee (${money(Math.ceil(fee / 2))}).` : ''}`)))
      : null,
    drawn ? h('p', { class: 'hint', style: 'margin:0' }, `Partners are drawn when the event starts — enter on your own.${fee ? ` You pay half the pair fee (${money(Math.ceil(fee / 2))}).` : ''}`) : null,
    t.event.gender === 'mixed' && t.event.discipline === 'doubles'
      ? Object.assign(field('I\'m playing as', h('select', { name: 'side' }, h('option', { value: 'man' }, 'Man'), h('option', { value: 'woman' }, 'Woman')), 'side-field'), { hidden: !drawn })
      : null,
    team
      ? field('Players (optional)', h('textarea', { name: 'players', rows: 3, maxlength: 1300, placeholder: 'One name per line' }), null, 'Only the organisers see this.')
      : null,
    field(team ? 'Captain\'s phone (optional)' : 'Phone (optional)', h('input', { name: 'phone', type: 'tel', maxlength: 20, autocomplete: 'tel' }), null,
      fee ? `Your receipt goes to your account email, ${S.me.email}. Only the organisers see your details.`
        : `The organisers can reach you at ${S.me.email}${team ? ' (the captain)' : ''}, or this number. Only they see your details.`),
    // honeypot: hidden from people, filled in by bots
    h('label', { class: 'hp', 'aria-hidden': 'true' }, 'Website', h('input', { name: 'website', tabindex: '-1', autocomplete: 'off' })),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, full ? 'Join waitlist' : online ? `Pay ${money(fee)} and enter` : 'Enter')),
    online ? h('p', { class: 'hint', style: 'margin:0' }, 'Secure payment by Razorpay — UPI, cards, netbanking or wallets. ', h('a', { href: '/refunds', target: '_blank', rel: 'noopener' }, 'Refund policy')) : null);
    return form;
  }

  // A player's entry with the fee still to pay: how to pay the organiser, then "I've paid".
  function payCard(t, mine, leave) {
    const p = t.payment || {};
    const amount = mine.feeAmount || t.event.fee || 0;
    const ref = `TN${mine.id}`;
    const payee = p.payee || 'the organiser';
    // UPI apps open with the payee, amount and a note that names the entry.
    const upiLink = p.upi
      ? `upi://pay?pa=${encodeURIComponent(p.upi)}${p.payee ? `&pn=${encodeURIComponent(p.payee)}` : ''}&am=${(amount / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(`${ref} ${t.name}`.slice(0, 50))}`
      : null;
    const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const held = heldNow(mine);
    const holdLine = held === null ? 'Your place is held until the draw.'
      : held ? `Your place is held until ${fmtWhen(mine.holdUntil)}.`
        : 'Your place isn\'t held any more — pay now and the organiser can still confirm you if there\'s room.';
    const refInput = h('input', { name: 'ref', inputmode: 'numeric', maxlength: 16, placeholder: '12-digit UPI reference', autocomplete: 'off' });
    const form = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${mine.id}/paid`, { ref: refInput.value }, t.id); }, 'Thanks — the organiser will confirm your payment');
      },
    },
    field('UPI reference (optional)', refInput, null, 'The 12-digit number in your payment details — it helps the organiser find your payment.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'I\'ve paid')));
    return h('div', { class: 'card entry-card pay-card' },
      h('h2', {}, `Pay ${money(amount)} to ${payee}`),
      h('p', {}, h('strong', {}, mine.name), ` is entered — your place is confirmed once ${payee === 'the organiser' ? 'they' : payee} receive${payee === 'the organiser' ? '' : 's'} your payment. ${holdLine}`),
      upiLink && touch ? h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary btn-lg', href: upiLink }, `Pay ${money(amount)} with UPI`)) : null,
      p.qr ? h('img', { class: 'qr-pay', src: p.qr, alt: `UPI QR code for ${payee}` }) : null,
      p.upi
        ? h('div', { class: 'pay-upi' },
          h('span', {}, 'UPI ID ', h('strong', {}, p.upi)),
          h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => copy(p.upi, 'UPI ID copied') }, 'Copy'))
        : null,
      h('p', { class: 'muted small' }, `Add `, h('strong', {}, ref), ' to the payment note so the organiser can match it.', p.note ? ` ${p.note}` : ''),
      !p.upi && !p.qr ? h('p', { class: 'muted small' }, 'The organiser hasn\'t added UPI details — pay them as they\'ve asked (e.g. cash at the desk).') : null,
      form,
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-small btn-ghost', onclick: leave }, 'Withdraw my entry')));
  }

  function lateEntryCard(t) {
    const setLate = (on) => act(async () => { S.t = await api('PATCH', tPath(t), withEv(t, { lateEntry: on }), t.id); }, on ? 'Late entries allowed' : 'Late entries switched off');
    if (!t.config.lateEntry) {
      return h('div', { class: 'card' },
        h('div', { class: 'card-head' },
          h('h2', {}, 'Late entries'),
          h('button', { class: 'btn btn-small', onclick: () => setLate(true) }, 'Allow late entries')),
        h('p', { class: 'muted small', style: 'margin:0' }, 'Off — nobody can be added now that the draw is made.'));
    }
    const groupsStage = t.status === 'league';
    const knockoutOnly = t.format === 'knockout';
    const how = groupsStage
      ? 'They join the smallest group and get catch-up matches against everyone in it.'
      : knockoutOnly ? 'They take a first-round bye and play the seed who had it.' : null;
    const input = h('input', { name: 'name', required: true, maxlength: 60, placeholder: 'Player or pair name', autocomplete: 'off' });
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, 'Late entries'),
        h('button', { class: 'btn btn-small btn-ghost', onclick: () => setLate(false) }, 'Switch off')),
      how
        ? h('form', {
          class: 'team-form',
          onsubmit: (e) => {
            e.preventDefault();
            const name = input.value;
            act(async () => { S.t = await api('POST', `${tPath(t)}/late-entry`, withEv(t, { name }), t.id); }, `${name} added`);
          },
        }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add late entry'))
        : null,
      h('p', { class: 'muted small', style: 'margin:8px 0 0' },
        how || 'The knockout has started — late entries could only join during the group stage.'));
  }

  // Check-in shows straight away; the server catches up in the background.
  async function checkIn(t, e, here) {
    S.pendingCheckIns.set(e.id, here);
    render();
    try {
      const data = await api('POST', `${tPath(t)}/entries/${e.id}/check-in`, { here }, t.id);
      S.pendingCheckIns.delete(e.id);
      if (S.t && S.t.id === data.id) S.t = data;
    } catch (err) {
      S.pendingCheckIns.delete(e.id);
      const row = S.t && allEntries(S.t).find((x) => x.id === e.id);
      if (row) row.checkedIn = !here;
      S.shake = e.id;
      setTimeout(() => { if (S.shake === e.id) S.shake = null; }, 700);
      toast(`Couldn't save check-in for ${e.name} — ${err.message}`, true);
    }
    render();
  }
  async function checkInAll(t, here) {
    const n = t.entries.filter((e) => e.checkedIn).length;
    if (!here && !confirm(`Clear check-in for all ${n} checked-in ${n === 1 ? 'entry' : 'entries'}?`)) return;
    const before = new Map(t.entries.map((e) => [e.id, e.checkedIn]));
    S.checkAllBusy = true;
    for (const e of t.entries) e.checkedIn = here;
    render();
    try {
      S.t = await api('POST', `${tPath(t)}/check-in-all`, withEv(t, { here }), t.id);
      toast(here ? 'Everyone checked in' : 'Check-in cleared');
    } catch (err) {
      for (const e of allEntries(S.t)) if (before.has(e.id)) e.checkedIn = before.get(e.id);
      toast(err.message, true);
    } finally {
      S.checkAllBusy = false;
      render();
    }
  }
  function withdrawEntry(t, e) {
    if (!confirm(`Withdraw ${e.name}? Their remaining matches become walkovers. This can't be undone.`)) return;
    act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/withdraw`, {}, t.id); }, `${e.name} withdrawn`);
  }

  function saveOrder(t, ids, msg) {
    const all = [...ids, ...(t.solos || []).map((e) => e.id)]; // solo players keep their places after the pairs
    act(async () => { S.t = await api('PUT', `${tPath(t)}/entries/order`, withEv(t, { ids: all }), t.id); }, msg);
  }
  function move(t, i, dir) {
    const ids = t.entries.map((e) => e.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    saveOrder(t, ids);
  }
  function shuffle(t) {
    const ids = t.entries.map((e) => e.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    saveOrder(t, ids, 'Order shuffled');
  }
  // ----- doubles players without a partner
  function soloCard(t) {
    if (t.event.discipline !== 'doubles' || !t.solos.length) return null;
    const mixed = t.event.gender === 'mixed';
    const ready = t.solos.filter((e) => e.confirmed && e.feeStatus !== 'pending');
    const draw = (balance) => act(async () => { S.t = await api('POST', `${tPath(t)}/pairs/draw`, withEv(t, { balance }), t.id); },
      balance ? 'Pairs drawn — top seeds with the lowest' : 'Pairs drawn at random');
    const pairWith = (a, bId) => act(async () => { S.t = await api('POST', `${tPath(t)}/pairs`, { a: a.id, b: Number(bId) }, t.id); }, 'Paired');
    return h('div', { class: 'card solo-card' },
      h('h2', {}, `Looking for a partner (${t.solos.length})`),
      h('p', { class: 'muted small' }, t.config.partners === 'drawn'
        ? 'Partners are drawn for this event when you start it — or draw them now to see the pairs first.'
        : 'These players entered without a partner. Pair them yourself, or draw the pairs.'),
      h('ol', { class: 'entries' }, t.solos.map((e) => {
        const others = ready.filter((o) => o.id !== e.id && (!mixed || o.side !== e.side));
        return h('li', {},
          h('span', { class: 'name' },
            h('span', { class: 'entry-name' }, e.name),
            e.contact || e.phone ? h('small', { class: 'contact' }, [e.contact, e.phone].filter(Boolean).join(' · ')) : null,
            h('span', { class: 'entry-tags' },
              e.side ? pill('', e.side === 'man' ? 'Man' : 'Woman') : null,
              !e.confirmed && e.feeStatus !== 'pending' ? pill('waiting', 'Unconfirmed') : null,
              t.event.fee ? feePill(e) : null),
            t.event.fee ? feeActions(t, e) : null),
          e.confirmed && e.feeStatus !== 'pending' && others.length
            ? h('select', { class: 'pair-with', 'aria-label': `Pair ${e.name} with`, onchange: (ev) => ev.target.value && pairWith(e, ev.target.value) },
              h('option', { value: '' }, 'Pair with…'), others.map((o) => h('option', { value: o.id }, o.name)))
            : null,
          h('span', { class: 'row-actions' },
            h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${e.name}`, onclick: () => removeEntry(t, e) }, '✕')));
      })),
      ready.length > 1
        ? h('div', { class: 'actions', style: 'margin-top:10px' },
          h('button', { class: 'btn btn-small btn-primary', onclick: () => draw(false) }, 'Pair randomly'),
          h('button', { class: 'btn btn-small btn-ghost', onclick: () => draw(true) }, 'Pair balanced'))
        : null,
      ready.length > 1 ? h('p', { class: 'hint', style: 'margin:8px 0 0' }, `Balanced pairs the top seed with the lowest, by the order of the entry list${mixed ? ' — always a man with a woman' : ''}.`) : null);
  }
  function splitPair(t, e) {
    act(async () => { S.t = await api('DELETE', `${tPath(t)}/pairs/${e.id}`, undefined, t.id); }, `${e.name} split — both are looking for a partner again`);
  }

  // Entry fees (tournaments organised by Tonament).
  function feePill(e) {
    if (e.feeStatus === 'paid') return pill('done', `Paid ${money(e.feeAmount || 0)}`);
    if (e.feeStatus === 'received') return pill('done', `Paid ${money(e.feeAmount || 0)} ✓`);
    if (e.feeStatus === 'sent') return pill('waiting', 'Payment sent — check');
    if (e.feeStatus === 'due') return pill('waiting', heldNow(e) ? `Payment due · held until ${fmtWhen(e.holdUntil)}` : heldNow(e) === null ? 'Payment due' : 'Payment due · not held');
    if (e.feeStatus === 'cash') return pill('done', 'Paid in person');
    if (e.feeStatus === 'waived') return pill('', 'Fee waived');
    if (e.feeStatus === 'pending') return pill('waiting', 'Paying…');
    return pill('waiting', 'Unpaid');
  }
  // Is an unpaid entry's place still held? (null: held until the draw)
  const heldNow = (e) => (e.holdUntil == null ? null : Date.parse(e.holdUntil) > Date.now());
  function feeActions(t, e) {
    const set = (status, msg) => act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/fee`, { status }, t.id); }, msg);
    if (!t.event.feeOnline) {
      // Paid to the organiser: settle it here (the "Payments to check" list has the same buttons).
      if (e.feeStatus !== 'due' && e.feeStatus !== 'sent') return null;
      return h('span', { class: 'fee-actions' },
        e.feeStatus === 'sent'
          ? h('button', { class: 'btn btn-small btn-primary', onclick: () => set('received', `${e.name}: payment received`) }, 'Received ✓')
          : null,
        h('button', { class: 'btn btn-small btn-ghost', onclick: () => set('cash', `${e.name}: paid in cash`) }, 'Paid in cash'),
        h('button', { class: 'btn btn-small btn-ghost', onclick: () => set('waived', `${e.name}: fee waived`) }, 'Waive'));
    }
    if (e.feeStatus === 'cash' || e.feeStatus === 'waived') {
      return h('span', { class: 'fee-actions' }, h('button', { class: 'btn btn-small btn-ghost', onclick: () => set(null, 'Marked unpaid') }, 'Undo'));
    }
    if (e.feeStatus) return null;
    return h('span', { class: 'fee-actions' },
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => set('cash', `${e.name}: paid in person`) }, 'Paid in person'),
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => set('waived', `${e.name}: fee waived`) }, 'Waive'));
  }

  // Organisers: payments players say they've made, across all events, oldest first.
  function paymentsToCheck(t) {
    if (!t.can.manage) return null;
    const sent = t.events.flatMap((ev) => ev.entries.filter((e) => e.feeStatus === 'sent' && !ev.feeOnline).map((e) => ({ e, ev })))
      .sort((x, y) => String(x.e.paySentAt).localeCompare(String(y.e.paySentAt)));
    if (!sent.length) return null;
    const set = (e, status, msg) => act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/fee`, { status }, t.id); }, msg);
    return h('div', { class: 'card payments-card' },
      h('h2', {}, `Payments to check (${sent.length})`),
      h('p', { class: 'muted small' }, 'These players say they\'ve paid you. Check your UPI app or bank messages (the payment note has their TN number), then confirm.'),
      h('ul', { class: 'pay-list' }, sent.map(({ e, ev }) => h('li', {},
        h('div', { class: 'pay-who' },
          h('strong', {}, e.name),
          h('small', { class: 'muted' }, [multiEvent(t) ? ev.name : null, money(e.feeAmount || 0), `TN${e.id}`, e.payRef ? `UPI ref ${e.payRef}` : 'no reference', e.paySentAt ? `paid ${fmtWhen(e.paySentAt)}` : null].filter(Boolean).join(' · '))),
        h('div', { class: 'fee-actions' },
          h('button', { class: 'btn btn-small btn-primary', onclick: () => set(e, 'received', `${e.name}: payment received — they're in`) }, 'Received ✓'),
          h('button', {
            class: 'btn btn-small btn-ghost',
            onclick: () => confirm(`Tell ${e.name} you haven't received their payment? Their entry goes back to unpaid.`) && set(e, 'missing', `${e.name} has been asked to check their payment`),
          }, 'Not received'),
          h('button', { class: 'btn btn-small btn-ghost', onclick: () => set(e, 'cash', `${e.name}: paid in cash`) }, 'Cash'))))));
  }

  function confirmEntry(t, e) {
    act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/confirm`, {}, t.id); }, `${e.name} confirmed`);
  }
  async function removeEntry(t, e) {
    const self = (e.feeStatus === 'paid' ? `\n\nThey paid ${money(e.feeAmount || 0)} online — refund it in the Razorpay dashboard.` : '')
      + (e.source === 'self' ? '\n\nThey entered themselves online and won\'t be told.' : '');
    if (!confirm(`Remove ${e.name} from the entries? This can't be undone.${self}`)) return;
    S.removing.add(e.id);
    render();
    try {
      S.t = await api('DELETE', `${tPath(t)}/entries/${e.id}`, undefined, t.id);
      toast(`Removed ${e.name}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      S.removing.delete(e.id);
      render();
    }
  }

  function planText(t, n) {
    const { qualifiers: q } = t.config;
    if (t.format === 'knockout') {
      if (n < 2) return 'Needs at least 2 entries.';
      const size = pow2(n);
      const byes = size - n;
      return `${n} entries → ${size}-draw knockout, ${Math.log2(size)} round${size > 2 ? 's' : ''}${byes ? `, ${byes} bye${byes > 1 ? 's' : ''} for top seeds` : ''}.`;
    }
    const g = t.config.groupSize ? groupCount(n, t.config.groupSize) : t.config.groups;
    if (n < 2 || n < g * 2) return `Needs at least ${Math.max(2, g * 2)} entries.`;
    const small = Math.floor(n / g);
    const big = Math.ceil(n / g);
    const bigCount = n % g;
    const matches = bigCount * (big * (big - 1)) / 2 + (g - bigCount) * (small * (small - 1)) / 2;
    const sizes = Array.from({ length: g }, (_, i) => (i < bigCount ? big : small)).join(', ');
    let s = `${n} entries → ${g} group${g > 1 ? 's' : ''} (${sizes}), ${matches} league matches.`;
    if (t.format === 'league_knockout') s += ` Top ${q} of each group → ${g * q}-player knockout.`;
    return s;
  }

  function startCard(t) {
    const pool = t.entries.filter((e) => e.confirmed);
    const waiting = t.entries.length - pool.length;
    const drawnEvent = t.config.partners === 'drawn';
    const alone = drawnEvent ? 0 : t.solos.filter((e) => e.confirmed).length;
    const here = pool.filter((e) => e.checkedIn).length;
    const usingCheckIn = here > 0;
    // Drawn-partner events will add a pair for every two players entered alone.
    const n = (usingCheckIn ? here : pool.length) + (drawnEvent ? Math.floor(t.solos.filter((e) => e.confirmed).length / 2) : 0);
    const absent = pool.length - here;
    const waitingText = `${waiting} unconfirmed ${waiting === 1 ? 'entry' : 'entries'}`;
    return h('div', { class: 'card' },
      h('h2', {}, 'Ready to start?'),
      usingCheckIn ? h('p', { class: 'muted small' }, `${here} checked in${absent ? ` · ${absent} not here (left out of the draw)` : ''}`) : null,
      waiting ? h('p', { class: 'muted small' }, `${waitingText} — confirm or remove them, or they'll be left out of the draw.`) : null,
      alone ? h('p', { class: 'muted small' }, `${alone} ${alone === 1 ? 'player still needs' : 'players still need'} a partner — pair them above, or they'll be left out.`) : null,
      drawnEvent && t.solos.length ? h('p', { class: 'muted small' }, `Partners for the ${t.solos.length} players entered alone will be drawn when you start${t.config.balancePairs ? ' (balanced)' : ''}. If anyone is left over, they sit out.`) : null,
      h('p', { class: 'plan' }, planText(t, n)),
      h('p', { class: 'muted small' }, 'Starting makes the draw and fixtures. You can redo the draw until the first point is played.'),
      h('button', {
        class: 'btn btn-primary btn-lg',
        onclick: () => {
          let msg = usingCheckIn && absent
            ? `Start with the ${here} checked-in entries? ${absent} not checked in will be left out.`
            : 'Start the tournament now?';
          if (waiting) msg += `\n\n${waitingText} will be left out of the draw.`;
          if (alone) msg += `\n\n${alone} without a partner will be left out.`;
          if (!confirm(msg)) return;
          act(async () => { S.t = await api('POST', `${tPath(t)}/start`, withEv(t, { skipUnconfirmed: waiting > 0 || alone > 0 || drawnEvent }), t.id); navigate(tabHref(t, 'live')); }, multiEvent(t) ? `${t.event.name} started — good luck!` : 'Tournament started — good luck!');
        },
      }, 'Start tournament'));
  }

  // Date and venue for players: shown when any of it is set.
  function venueCard(t) {
    const L = t.location;
    const lines = [L.address, [L.city, [L.region, L.postcode].filter(Boolean).join(' ')].filter(Boolean).join(', '), L.country].filter(Boolean);
    const dates = fmtSchedule(t);
    if (!dates && !t.venue && !L.address && !L.city) return null;
    const query = [t.venue, ...lines].join(', ');
    return h('div', { class: 'card venue-card' },
      h('div', { class: 'venue-info' },
        dates ? h('div', { class: 'venue-row' }, h('span', { class: 'venue-icon', 'aria-hidden': 'true' }, '📅'), h('strong', {}, dates)) : null,
        t.venue || lines.length
          ? h('div', { class: 'venue-row' }, h('span', { class: 'venue-icon', 'aria-hidden': 'true' }, '📍'),
            h('div', {}, t.venue ? h('strong', {}, t.venue) : null, lines.map((l) => h('div', { class: 'muted small' }, l))))
          : null),
      t.venue || L.address || L.city
        ? h('a', { class: 'btn btn-small', href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, target: '_blank', rel: 'noopener' }, 'Open in Google Maps')
        : null);
  }

  // A collapsible editing panel that stays open across live-update redraws.
  function panel(t, name, summary, form) {
    const key = `${t.id}:${name}`;
    return h('details', {
      class: 'card',
      'data-panel': name,
      open: S.openPanels.has(key) || null,
      ontoggle: (e) => {
        if (e.target.open) {
          S.openPanels.add(key);
          return;
        }
        S.openPanels.delete(key);
        form.removeAttribute('data-dirty'); // closing discards unsaved edits
        if (S.pendingRender && !isEditing()) render();
      },
    }, h('summary', {}, summary), form);
  }

  // Saves a panel's form. A failed save keeps what was typed (no redraw).
  async function saveForm(form, fn, success) {
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await fn();
      toast(success);
      render();
    } catch (e) {
      if (e.code === 'upgrade' && S.t) S.upgradeFor = S.t.id; // shown once the panel is saved or closed
      toast(e.message, true);
      btn.disabled = false;
    }
  }

  // Name, venue, dates and self-entry: editable at any stage.
  function tournamentSettingsCard(t) {
    if (!t.can.manage) return null;
    const form = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        saveForm(form, async () => { S.t = await api('PATCH', tPath(t), { ...readTournament(form), courts: readCourts(form), payment: readPayment(form) }, t.id); }, 'Tournament settings saved');
      },
    },
    field('Tournament name', h('input', { name: 'name', required: true, maxlength: 80, value: t.name })),
    detailsFields(detailValues(t)),
    entryFields(t.config),
    courtFields(t),
    paymentFields(t),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')));
    return panel(t, 'settings', 'Tournament settings · venue, dates, entries, courts', form);
  }

  // How players pay entry fees to the organiser (UPI or cash, confirmed by hand).
  function paymentFields(t) {
    if (t.official) return null; // Tonament's own tournaments take fees online
    const p = t.payment || {};
    const uploadQr = async (e) => {
      const [file] = e.target.files;
      e.target.value = '';
      if (!file) return;
      try {
        const data = await prepareImage(file, 'logo');
        S.t = await api('POST', `${tPath(t)}/media`, { kind: 'qr', data }, t.id);
        toast('QR code saved ✓');
        render();
      } catch (err) {
        toast(err.message, true);
      }
    };
    return h('fieldset', { class: 'details-set' }, h('legend', {}, 'Entry fees'),
      h('p', { class: 'hint', style: 'margin:0' }, 'For events with an entry fee: players pay you directly — by UPI or cash — and you confirm each payment on the Players tab. Tonament never handles the money.'),
      h('div', { class: 'grid-2' },
        field('Your UPI ID', h('input', { name: 'upi', maxlength: 100, value: p.upi || '', placeholder: 'e.g. kavya@okhdfcbank', autocomplete: 'off', inputmode: 'email' })),
        field('Name to pay', h('input', { name: 'payee', maxlength: 60, value: p.payee || '', placeholder: 'As shown in UPI apps' }))),
      field('Note for players (optional)', h('input', { name: 'payNote', maxlength: 200, value: p.note || '', placeholder: 'e.g. Cash is also fine at the desk' })),
      field('Hold a place while unpaid', h('select', { name: 'holdHours', value: String(p.holdHours ?? 48) },
        h('option', { value: '24' }, '24 hours'), h('option', { value: '48' }, '48 hours'), h('option', { value: '0' }, 'Until entries close')), null,
      'After that, an unpaid entry goes to the waitlist (you can still confirm it if there\'s room).'),
      h('div', { class: 'qr-row' },
        p.qr ? h('img', { class: 'qr-preview', src: p.qr, alt: 'Your UPI QR code' }) : null,
        h('div', {},
          h('label', { class: 'btn btn-small' }, p.qr ? 'Replace QR code' : 'Upload your UPI QR code',
            h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: uploadQr })),
          h('p', { class: 'hint', style: 'margin:6px 0 0' }, 'Players on a computer scan it. Save it from your UPI app (Profile → QR code).'),
          p.qrId ? h('button', {
            type: 'button', class: 'btn btn-small btn-ghost',
            onclick: () => act(async () => { S.t = await api('DELETE', `${tPath(t)}/media/${p.qrId}`, undefined, t.id); }, 'QR code removed'),
          }, 'Remove') : null)));
  }

  function readPayment(form) {
    if (!form.upi) return undefined;
    const fd = new FormData(form);
    return { upi: fd.get('upi') || '', payee: fd.get('payee') || '', note: fd.get('payNote') || '', holdHours: Number(fd.get('holdHours')) };
  }

  // Courts for the order of play (shared by every event).
  const defaultCourtName = (i) => `Court ${i + 1}`;
  function courtFields(t) {
    const c = t.courts;
    const names = c ? c.names : [];
    const custom = names.some((n, i) => n !== defaultCourtName(i));
    return h('fieldset', { class: 'details-set' }, h('legend', {}, 'Courts'),
      h('p', { class: 'hint', style: 'margin:0' }, 'Set your courts to run an order of play: call matches to free courts and show players when they\'re likely on.'),
      h('div', { class: 'grid-2' },
        field('Number of courts', h('input', { type: 'number', name: 'courtCount', min: 0, max: 40, value: names.length || '', placeholder: 'None' })),
        field('Typical match (minutes)', h('input', {
          type: 'number', name: 'courtMinutes', min: 5, max: 240, value: c ? c.minutes : '', placeholder: String(TonamentSchedule.defaultMinutes(t.sport.id)),
        }), null, 'For estimated start times.')),
      field('Court names (optional)', h('input', { name: 'courtNames', maxlength: 400, value: custom ? names.join(', ') : '', placeholder: 'e.g. Centre, Court 2, Court 3' }), null,
        'Separate with commas. Leave blank for Court 1, Court 2, …'),
      h('label', { class: 'check-field' },
        h('input', { type: 'checkbox', name: 'courtAuto', checked: Boolean(c && c.auto) }),
        h('span', {}, h('strong', {}, 'Call the next match automatically'), h('small', {}, 'When a match ends, the next match in the order of play goes to that court.'))));
  }

  function readCourts(form) {
    const fd = new FormData(form);
    const named = (fd.get('courtNames') || '').split(',').map((x) => x.trim()).filter(Boolean);
    const count = Number(fd.get('courtCount')) || 0;
    const names = named.length ? named : Array.from({ length: count }, (_, i) => defaultCourtName(i));
    return names.length ? { names, minutes: fd.get('courtMinutes') || '', auto: fd.get('courtAuto') === 'on' } : null;
  }

  // The selected event's type, format and scoring (until it starts).
  function eventSettingsCard(t) {
    const sport = S.sports.find((s) => s.id === t.sport.id);
    if (!sport || !t.can.manage || t.status !== 'setup') return null;
    const form = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        saveForm(form, async () => {
          const fee = form.fee ? { fee: Math.round(Number(form.fee.value || 0) * 100) } : {};
          const partners = form.querySelector('input[name=partners]')
            ? { partners: form.querySelector('input[name=partners]:checked').value, balancePairs: form.balancePairs.checked }
            : {};
          S.t = await api('PATCH', `${tPath(t)}/events/${t.eventId}`, { ...readCategory(form), ...readFormat(form, sport), ...fee, ...partners }, t.id);
        }, 'Event settings saved');
      },
    },
    categoryFields(t.event, t.sport.id),
    t.event.discipline === 'doubles'
      ? h('fieldset', { class: 'details-set' }, h('legend', {}, 'Partners'),
        h('label', { class: 'check-field' },
          h('input', { type: 'radio', name: 'partners', value: 'own', checked: t.config.partners !== 'drawn' }),
          h('span', {}, h('strong', {}, 'Players bring their own partner'), h('small', {}, 'Anyone without one can ask to be paired; you pair them before the draw.'))),
        h('label', { class: 'check-field' },
          h('input', { type: 'radio', name: 'partners', value: 'drawn', checked: t.config.partners === 'drawn' }),
          h('span', {}, h('strong', {}, 'Partners are drawn for everyone'), h('small', {}, 'Everyone enters alone; pairs are drawn when the event starts (a social "draw doubles").'))),
        h('label', { class: 'check-field' },
          h('input', { type: 'checkbox', name: 'balancePairs', checked: Boolean(t.config.balancePairs) }),
          h('span', {}, h('strong', {}, 'Balance drawn pairs'), h('small', {}, 'Pair the top seeds with the lowest, by the order of the entry list.'))))
      : null,
    h('fieldset', { class: 'details-set' }, h('legend', {}, 'Entry fee'),
      field(`Entry fee (₹)${t.event.discipline === 'doubles' ? ' per pair' : t.event.discipline === 'team' ? ' per team' : ''}`, h('input', {
        type: 'number', name: 'fee', min: 0, max: 50000, step: 1, value: t.event.fee ? t.event.fee / 100 : '', placeholder: 'Free',
      }), null, t.official
        ? 'Players pay online when they enter (Organised by Tonament).'
        : t.payment && t.payment.upi
          ? `Players pay you directly (UPI ${t.payment.upi}) and you confirm each payment.`
          : 'Players pay you directly and you confirm each payment. Add your UPI ID under Tournament settings → Entry fees.')),
    formatFields(sport, { format: t.format, ...t.config }),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')));
    syncFormat(form);
    return panel(t, `event-${t.eventId}`, multiEvent(t) ? `Event settings · ${t.event.name}` : `Event settings · ${t.formatName}`, form);
  }

  // Prize money, trophies and rewards for the selected event; editable at any stage.
  function prizeSettingsCard(t) {
    if (!t.can.manage) return null;
    const list = h('div', { class: 'ev-rows' });
    const touched = () => list.closest('form')?.setAttribute('data-dirty', '');
    const addRow = (p) => {
      const standard = Boolean(CAT.PLACES[p.place]);
      const place = h('select', {
        value: standard ? p.place : 'custom',
        onchange: () => { customField.hidden = place.value !== 'custom'; if (!customField.hidden) custom.focus(); },
      }, Object.entries(CAT.PLACES).map(([v, l]) => h('option', { value: v }, l)), h('option', { value: 'custom' }, 'Custom…'));
      const custom = h('input', { maxlength: 40, value: standard ? '' : p.place, placeholder: 'e.g. Best young player' });
      const customField = field('Prize name', custom, 'prize-custom');
      customField.hidden = standard;
      const cash = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 10000000, step: 1, value: p.cash || '', placeholder: 'None' });
      const reward = h('input', { maxlength: 80, value: p.reward || '', placeholder: 'e.g. Trophy + medals' });
      const row = h('div', { class: 'ev-row prize-row' },
        field('Place', place, 'prize-place'),
        h('button', { type: 'button', class: 'icon-btn ev-remove', 'aria-label': 'Remove this prize', title: 'Remove', onclick: () => { row.remove(); touched(); } }, '✕'),
        customField,
        field('Prize money (₹)', cash, 'prize-cash'),
        field('Trophy or reward', reward, 'prize-reward'));
      row.read = () => ({
        place: place.value === 'custom' ? custom.value.trim() : place.value,
        cash: cash.value === '' ? null : Number(cash.value),
        reward: reward.value.trim() || null,
      });
      list.append(row);
    };
    const saved = t.event.prizes || [];
    for (const p of saved.length ? saved : [{ place: 'winner' }, { place: 'runner_up' }]) addRow(p);

    const form = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        // Rows left blank (no money and no reward) are skipped.
        const prizes = [...list.children].map((r) => r.read()).filter((p) => p.cash || p.reward);
        const unnamed = prizes.find((p) => !p.place);
        if (unnamed) { toast('Give the custom prize a name', true); return; }
        saveForm(form, async () => { S.t = await api('PATCH', `${tPath(t)}/events/${t.eventId}`, { prizes }, t.id); }, 'Prizes saved');
      },
    },
    h('p', { class: 'hint', style: 'margin:0' }, 'Prize money, trophies and rewards — shown to players before they enter. Leave a row blank to skip it.'),
    list,
    h('div', { class: 'actions' },
      h('button', {
        type: 'button',
        class: 'btn btn-small',
        onclick: () => {
          const used = new Set([...list.children].map((r) => r.read().place));
          addRow({ place: Object.keys(CAT.PLACES).find((k) => !used.has(k)) || 'custom' });
          touched();
        },
      }, '+ Add prize'),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save prizes')));
    const total = prizeMoney(t.event);
    const summary = [multiEvent(t) ? `Prizes · ${t.event.name}` : 'Prizes', total ? rupees(total) : saved.length ? `${saved.length} set` : null].filter(Boolean).join(' · ');
    return panel(t, `prizes-${t.eventId}`, summary, form);
  }

  // ----- events tab (organisers): add, reorder, delete
  function panelEvents(t) {
    const move = (i, dir) => {
      const ids = t.events.map((e) => e.id);
      [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
      act(async () => { S.t = await api('PUT', `${tPath(t)}/events/order`, { ids }, t.id); });
    };
    const remove = (ev) => {
      const n = ev.entries.length;
      if (!confirm(`Delete ${ev.name}${n ? ` and its ${n} ${n === 1 ? 'entry' : 'entries'}` : ''}? This can't be undone.`)) return;
      act(async () => { S.t = await api('DELETE', `${tPath(t)}/events/${ev.id}`, undefined, t.id); }, `${ev.name} deleted`);
    };
    const addForm = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        const { events, error } = readEventList(addForm);
        if (error) { toast(error, true); return; }
        saveForm(addForm, async () => { S.t = await api('POST', `${tPath(t)}/events`, { events }, t.id); },
          `${events.length} event${events.length > 1 ? 's' : ''} added`);
      },
    },
    eventBuilder([{ discipline: 'singles', gender: 'men', age: 'Open', level: 'Open' }], t.sport.id),
    h('p', { class: 'hint', style: 'margin:0' }, 'New events copy the format and scoring of the first event; change them in each event\'s settings.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add events')));
    return [
      h('div', { class: 'card' },
        h('h2', {}, `Events (${t.events.length})`),
        h('ol', { class: 'entries events-list' }, t.events.map((ev, i) => h('li', {},
          h('span', { class: 'seed' }, i + 1),
          h('span', { class: 'name' },
            h('a', { class: 'entry-name', href: `/t/${t.id}/entries?e=${ev.id}` }, ev.name),
            h('small', { class: 'contact' }, [ev.formatName, `${ev.entries.length} ${ev.entries.length === 1 ? 'entry' : 'entries'}`, STATUS[ev.status]].join(' · '))),
          h('span', { class: 'row-actions' },
            h('button', { class: 'icon-btn', 'aria-label': `Move ${ev.name} up`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
            h('button', { class: 'icon-btn', 'aria-label': `Move ${ev.name} down`, disabled: i === t.events.length - 1, onclick: () => move(i, 1) }, '↓'),
            h('button', {
              class: 'icon-btn', 'aria-label': `Delete ${ev.name}`, title: ev.status === 'setup' ? 'Delete event' : 'Started events can\'t be deleted',
              disabled: ev.status !== 'setup' || t.events.length === 1, onclick: () => remove(ev),
            }, '✕')))))),
      panel(t, 'add-events', 'Add events', addForm),
    ];
  }

  function dangerZone(t) {
    if (!t.can.delete) return null;
    return h('div', { class: 'card danger' },
      h('h2', {}, 'Delete tournament'),
      h('p', { class: 'muted small' }, 'Removes the tournament, its draw and every result. This cannot be undone.'),
      h('button', {
        class: 'btn btn-small btn-danger',
        onclick: () => {
          if (!confirm(`Delete "${t.name}" permanently? This cannot be undone.`)) return;
          act(async () => {
            await api('DELETE', tPath(t), undefined, t.id);
            keys.remove(t.id);
            navigate('/');
          }, 'Tournament deleted');
        },
      }, 'Delete tournament'));
  }

  // ----- live tab
  const stageOrder = (m) => (m.stage === 'knockout' ? 1 : 0);
  const byOrder = (x, y) => stageOrder(x) - stageOrder(y) || x.round - y.round || (x.group ?? 0) - (y.group ?? 0) || x.slot - y.slot;

  // Organisers: open the big-screen display (in a new tab, for the venue TV).
  const displayLink = (t) => h('p', { class: 'display-link' },
    h('a', { class: 'btn btn-small', href: `/t/${t.id}/display`, target: '_blank', rel: 'noopener' }, '📺 Open venue display'),
    h('span', { class: 'muted small' }, ' Show courts, scores and what\'s next on a TV or projector.'));

  function panelLive(t) {
    const ms = t.matches.filter((m) => m.status !== 'bye');
    const live = ms.filter((m) => m.status === 'live').sort(byOrder);
    // Late entries' catch-up matches go first so they can catch up.
    const upcoming = ms.filter((m) => m.status === 'scheduled' && m.a && m.b)
      .sort((x, y) => Number(y.catchUp) - Number(x.catchUp) || byOrder(x, y)).slice(0, 8);
    const results = ms.filter((m) => m.status === 'done')
      .sort((x, y) => (y.updatedAt || '').localeCompare(x.updatedAt || '') || y.id - x.id).slice(0, 12);
    return [
      t.can.manage ? displayLink(t) : null,
      championBanner(t),
      stageBanner(t),
      redrawCard(t),
      matchSection(t, 'On court now', live, 'No matches in progress.', true),
      upcoming.length || t.status !== 'completed' ? matchSection(t, 'Up next', upcoming, 'Nothing scheduled right now.') : null,
      matchSection(t, 'Latest results', results, 'No results yet.'),
    ];
  }

  // ----- courts tab: what's on each court, and the order of play across events
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  function panelCourts(t) {
    if (!t.events.some((e) => e.status === 'league' || e.status === 'knockout')) {
      return empty('The order of play appears here once an event starts.');
    }
    return [
      t.can.manage ? displayLink(t) : null,
      h('div', { class: 'find-bar' },
        h('input', {
          type: 'search', class: 'find-q', value: S.courtFind || '', placeholder: 'Find your name', 'aria-label': 'Find your matches',
          // Typing redraws just the results, so the box keeps focus.
          oninput: (e) => { S.courtFind = e.target.value; app.querySelector('.court-results').replaceWith(courtResults(t)); },
        })),
      courtResults(t),
    ];
  }

  function courtResults(t) {
    const c = t.courts;
    const plan = TonamentSchedule.orderOfPlay({ events: t.events, courts: c.names, minutes: c.minutes, now: Date.now() });
    const manage = t.can.score;
    const find = (S.courtFind || '').trim().toLowerCase();
    const mine = (m) => !find || [m.a, m.b].some((p) => p && p.name.toLowerCase().includes(find));
    const evName = (ev) => (multiEvent(t) ? ev.name : null);
    const call = (m, court) => act(async () => { S.t = await api('POST', `${tPath(t)}/matches/${m.id}/call`, { court }, t.id); }, `${vsName(m)} called to ${court}`);
    const pin = (m, top) => act(async () => { S.t = await api('POST', `${tPath(t)}/matches/${m.id}/queue`, { top }, t.id); }, top ? 'Moved to the front' : 'Back in the usual order');
    const offCourt = (m) => patchMatch(t, m, { status: 'scheduled' }, 'Taken off court');
    const evOf = (m) => t.events.find((e) => e.matches.some((x) => x.id === m.id));

    const courtCard = (court) => {
      const m = court.match;
      if (!m) {
        const { next } = court;
        return h('div', { class: 'card court-card free' },
          h('div', { class: 'court-head' }, h('strong', {}, court.name), pill('done', 'Free')),
          manage && next
            ? h('button', { class: 'btn btn-primary btn-small court-call', onclick: () => call(next.match, court.name) },
              `Call ${vsName(next.match)}`)
            : h('p', { class: 'muted small', style: 'margin:0' }, plan.queue.length ? 'Waiting for players to finish on another court.' : 'Nothing waiting.'));
      }
      const ev = evOf(m);
      return h('div', { class: `card court-card${mine(m) ? '' : ' dim'}` },
        h('div', { class: 'court-head' }, h('strong', {}, court.name),
          m.rallies ? pill('live', 'Playing') : pill('waiting', 'Called')),
        h('a', { class: 'court-match', href: `/t/${t.id}/m/${m.id}` },
          evName(ev) ? h('small', { class: 'muted' }, ev.name) : null,
          h('span', {}, vsName(m)),
          h('small', { class: 'muted' }, m.rallies ? m.summary || 'In progress' : `Called at ${clock(Date.parse(m.calledAt || Date.now()))}`)),
        manage && !m.rallies ? h('button', { class: 'btn btn-ghost btn-small', onclick: () => offCourt(m) }, 'Take off court') : null);
    };

    const queue = plan.queue.filter((x) => mine(x.match));
    return h('div', { class: 'court-results' },
      h('div', { class: 'court-grid' }, plan.courts.map(courtCard)),
      c.auto && manage ? h('p', { class: 'hint' }, 'Auto-call is on: when a match ends, the next match goes to that court.') : null,
      h('section', { class: 'section' },
        h('h2', {}, `Up next (${plan.queue.length})`),
        queue.length
          ? h('ol', { class: 'entries order-of-play' }, queue.map((x) => h('li', { class: x.waitingFor.length ? 'waiting' : '' },
            h('span', { class: 'seed', title: 'Place in the order of play' }, plan.queue.indexOf(x) + 1),
            h('span', { class: 'name' },
              h('span', { class: 'entry-name' }, vsName(x.match)),
              h('small', { class: 'contact' }, [
                evName(x.event), x.match.roundName,
                x.waitingFor.length ? `Waiting: ${waitingText(x.waitingFor)}` : null,
              ].filter(Boolean).join(' · '))),
            h('span', { class: 'oop-time', title: 'Estimated start' }, x.startsAt <= Date.now() + 60000 && !x.waitingFor.length ? 'Next' : `~${clock(x.startsAt)}`),
            manage
              ? h('span', { class: 'row-actions' },
                x.match.queuePos == null
                  ? h('button', { class: 'icon-btn', title: 'Play next', 'aria-label': `Play ${vsName(x.match)} next`, onclick: () => pin(x.match, true) }, '⤒')
                  : h('button', { class: 'icon-btn', title: 'Back to the usual order', 'aria-label': 'Unpin', onclick: () => pin(x.match, false) }, '↺'))
              : null)))
          : h('p', { class: 'muted' }, find ? 'No matches for that name.' : 'Nothing waiting to be played.'),
        plan.queue.length ? h('p', { class: 'hint', style: 'margin:8px 0 0' }, `Times are estimates, based on ${c.minutes}-minute matches.`) : null));
  }
  const vsName = (m) => `${nameOf(m.a)} v ${nameOf(m.b)}`;
  // "Hal, Ivy (Court 1); Cy (Court 2)"
  function waitingText(list) {
    const byCourt = new Map();
    for (const w of list) byCourt.set(w.court || '', [...(byCourt.get(w.court || '') || []), w.name]);
    return [...byCourt].map(([court, names]) => `${names.join(', ')}${court ? ` (${court})` : ''}`).join('; ');
  }

  // ----- display mode (/t/<id>/display): for a TV or projector at the venue.
  // Read-only and updating itself: every court with its live score, the order
  // of play, and a panel that rotates through results, standings, the current
  // knockout round, prizes and how to follow on a phone.
  const DISPLAY_ROTATE_MS = 15000;
  let displayTimer = null;
  let wakeLock = null;
  function displayTick() {
    if (S.route.name !== 'display') {
      clearInterval(displayTimer);
      displayTimer = null;
      if (wakeLock) wakeLock.release().catch(() => {});
      wakeLock = null;
      return;
    }
    S.displayPanel = (S.displayPanel || 0) + 1;
    render(true);
  }
  // Keep the screen awake while the display is showing.
  async function keepAwake() {
    if (wakeLock || !navigator.wakeLock || document.hidden) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* not allowed here; the screen may sleep */ }
  }
  document.addEventListener('visibilitychange', () => { if (S.route.name === 'display') keepAwake(); });
  // Hide the mouse pointer when it hasn't moved for a while.
  let idleTimer = null;
  document.addEventListener('mousemove', () => {
    document.body.classList.remove('display-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('display-idle'), 3000);
  });

  function viewDisplay() {
    const t = S.t;
    displayTimer ??= setInterval(displayTick, DISPLAY_ROTATE_MS);
    keepAwake();
    document.title = `${t.name} · Display · Tonament`;
    const all = t.events.flatMap((ev) => ev.matches.map((m) => ({ m, ev })));
    const named = multiEvent(t);
    const evLabel = (ev) => (named ? ev.name : null);
    const plan = t.courts ? TonamentSchedule.orderOfPlay({ events: t.events, courts: t.courts.names, minutes: t.courts.minutes, now: Date.now() }) : null;
    const started = t.events.some((e) => e.status === 'league' || e.status === 'knockout');
    const b = t.branding;

    const side = (m, s) => {
      const sc = m.score;
      const cur = sc.games[sc.games.length - 1] || { a: 0, b: 0 };
      const live = m.status === 'live' && m.rallies > 0;
      const flag = live ? (sc.matchPoint[s] ? 'Match point' : sc.gamePoint[s] ? `${sc.unit || 'Game'} point` : null) : null;
      return h('div', { class: `dc-side${m.winner && m[s] && m.winner === m[s].id ? ' won' : ''}` },
        h('span', { class: 'dc-serve' }, live && sc.server === s ? h('span', { class: 'serve' }) : null),
        h('span', { class: 'dc-name' }, h('span', {}, nameOf(m[s])), flag ? h('span', { class: 'flag' }, flag) : null),
        live ? h('span', { class: 'dc-games' }, sc.gamesWon[s]) : null,
        live && sc.setGames ? h('span', { class: 'dc-games' }, sc.setGames[s]) : null,
        h('span', { class: 'dc-points' }, live ? (sc.points ? sc.points[s] : cur[s]) : ''));
    };
    const courtCard = (name, m, ev, next) => h('div', { class: `dc-court${m ? (m.rallies ? ' live' : ' called') : ' free'}` },
      h('div', { class: 'dc-court-head' },
        h('span', { class: 'dc-court-name' }, name),
        m ? h('span', { class: 'dc-court-meta' }, [evLabel(ev), m.rallies ? `${m.score.unit || 'Game'} ${m.score.games.length}` : 'Starting'].filter(Boolean).join(' · ')) : h('span', { class: 'dc-court-meta' }, 'Free')),
      m ? [side(m, 'a'), side(m, 'b')]
        : h('div', { class: 'dc-free' }, next ? ['Next: ', h('strong', {}, vsName(next.match))] : 'Nothing waiting'));
    // Courts: the tournament's own, or every match on court now.
    const courts = plan
      ? plan.courts.map((c) => courtCard(c.name, c.match, c.event, c.next))
      : all.filter(({ m }) => m.status === 'live').map(({ m, ev }, i) => courtCard(m.court ? (/^\d/.test(m.court) ? `Court ${m.court}` : m.court) : `Match ${i + 1}`, m, ev));

    // Up next: the order of play, or the matches ready to play.
    const upNext = plan
      ? plan.queue.slice(0, 8).map((x) => ({
        m: x.match, ev: x.event,
        when: !x.waitingFor.length && x.startsAt <= Date.now() + 60000 ? 'Next' : `~${clock(x.startsAt)}`,
        waiting: x.waitingFor.length ? `Waiting for ${waitingText(x.waitingFor)}` : null,
      }))
      : all.filter(({ m, ev }) => m.status === 'scheduled' && m.a && m.b && (m.stage === 'league' ? ev.status === 'league' : ev.status === 'knockout'))
        .sort((x, y) => x.m.round - y.m.round || x.m.id - y.m.id).slice(0, 8).map((x) => ({ ...x, when: x.m.roundName }));

    // The rotating panel.
    const panels = [];
    const results = all.filter(({ m }) => m.status === 'done' && !m.walkover && m.a && m.b)
      .sort((x, y) => String(y.m.updatedAt || '').localeCompare(String(x.m.updatedAt || ''))).slice(0, 6);
    if (results.length) {
      panels.push(['Latest results', h('ul', { class: 'dc-list' }, results.map(({ m, ev }) => {
        const w = m.winner === m.a.id ? m.a : m.b;
        const l = w === m.a ? m.b : m.a;
        // The winner's score first: "21-15, 21-18".
        const score = w === m.a ? m.summary : m.summary.replace(/(\d+)-(\d+)/g, '$2-$1');
        return h('li', {}, h('span', {}, h('strong', {}, w.name), ' beat ', l.name, evLabel(ev) ? h('small', {}, ev.name) : null), h('span', { class: 'dc-score' }, score));
      }))]);
    }
    for (const ev of t.events) {
      if (ev.status === 'league' || (ev.status !== 'setup' && ev.groups.length && ev.status !== 'knockout')) {
        for (const g of ev.groups) {
          panels.push([`${named ? `${ev.name} · ` : ''}${g.name}`, h('table', { class: 'dc-table' },
            h('thead', {}, h('tr', {}, ['#', 'Name', 'P', 'W', 'L'].map((c, i) => h('th', { class: i === 1 ? '' : 'num' }, c)))),
            h('tbody', {}, g.standings.map((r) => h('tr', {}, h('td', { class: 'num' }, r.rank), h('td', {}, r.name), h('td', { class: 'num' }, r.played), h('td', { class: 'num' }, r.won), h('td', { class: 'num' }, r.lost)))))]);
        }
      }
      const ko = ev.matches.filter((m) => m.stage === 'knockout' && m.status !== 'bye');
      if (ev.status === 'knockout' && ko.length) {
        // The earliest round still being played (or the last one, once all are done).
        const open = ko.filter((m) => m.status !== 'done');
        const round = open.length ? Math.min(...open.map((m) => m.round)) : Math.max(...ko.map((m) => m.round));
        const ms = ko.filter((m) => m.round === round);
        panels.push([`${named ? `${ev.name} · ` : ''}${ms[0].roundName}`, h('ul', { class: 'dc-list' }, ms.map((m) => h('li', {},
          h('span', {}, h('strong', { class: m.winner && m.a && m.winner === m.a.id ? 'won' : '' }, nameOf(m.a)), ' v ', h('strong', { class: m.winner && m.b && m.winner === m.b.id ? 'won' : '' }, nameOf(m.b))),
          h('span', { class: 'dc-score' }, m.status === 'done' ? m.summary : m.status === 'live' ? 'Live' : ''))))]);
      }
      if (ev.status === 'completed' && ev.champion) panels.push([`${named ? `${ev.name} · ` : ''}Champion`, h('p', { class: 'dc-champion' }, '🏆 ', ev.champion.name)]);
    }
    const prized = t.events.filter((ev) => (ev.prizes || []).length);
    if (prized.length) {
      panels.push(['Prizes', h('ul', { class: 'dc-list' }, prized.flatMap((ev) => ev.prizes.slice(0, 3).map((p) => h('li', {},
        h('span', {}, CAT.placeLabel(p.place), named ? h('small', {}, ev.name) : null),
        h('span', { class: 'dc-score' }, [p.cash ? rupees(p.cash) : null, p.reward].filter(Boolean).join(' + '))))))]);
    }
    if (t.visibility !== 'private') {
      panels.push(['Follow on your phone', h('div', { class: 'dc-follow' },
        h('p', {}, 'Live scores, your matches and the order of play:'),
        h('p', { class: 'dc-url' }, `${location.host}/t/${t.id}`))]);
    }
    // And one for Tonament itself: everyone in the hall is a possible organiser.
    panels.push(['Run your own tournament', h('div', { class: 'dc-promo' },
      h('img', { src: '/brand/logo-white.svg', alt: 'Tonament', width: 190, height: 26 }),
      h('p', {}, 'Entries, draws, courts and live scores like these — on everyone\'s phone.'),
      h('p', { class: 'dc-url' }, 'tonament.com'),
      h('p', { class: 'dc-promo-small' }, `Free for up to 16 entries · ${liveSports().length || 10} sports`))]);
    const panel = panels[(S.displayPanel || 0) % panels.length];

    const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
    return h('div', { class: 'display' },
      h('header', { class: 'dc-head' },
        h('img', { class: 'dc-brand', src: '/brand/logo-white.svg', alt: 'Tonament', width: 190, height: 26 }),
        h('div', { class: 'dc-title' }, h('h1', {}, t.name),
          h('p', {}, [b && b.orgName, fmtSchedule(t), placeLine(t.venue, t.location.city)].filter(Boolean).join(' · '))),
        b && b.logo ? h('img', { class: 'dc-logo', src: b.logo, alt: b.orgName || '' }) : null,
        h('div', { class: 'dc-clock' },
          h('strong', {}, new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
          h('span', { class: `conn ${S.connected ? 'on' : ''}` }, S.connected ? 'Live' : 'Reconnecting…')),
        h('button', { class: 'btn btn-small btn-ghost dc-fs', onclick: fullscreen, title: 'Full screen (F11)' }, '⛶')),
      !started
        ? h('div', { class: 'dc-wait' }, h('img', { src: '/brand/logo-stacked-white.svg', alt: 'Tonament' }), h('h2', {}, 'Starting soon'), h('p', {}, fmtSchedule(t) || 'Play starts once the draw is made.'))
        : h('div', { class: 'dc-body' },
          h('section', { class: 'dc-courts' },
            h('h2', {}, plan ? 'Courts' : 'On court now'),
            courts.length ? h('div', { class: 'dc-court-grid' }, courts) : h('p', { class: 'dc-empty' }, 'No matches on court right now.')),
          h('section', { class: 'dc-next' },
            h('h2', {}, 'Up next'),
            upNext.length
              ? h('ol', { class: 'dc-list dc-queue' }, upNext.map(({ m, ev, when, waiting }) => h('li', {},
                h('span', { class: 'dc-match' }, h('strong', {}, vsName(m)), evLabel(ev) || waiting ? h('small', {}, [evLabel(ev), waiting].filter(Boolean).join(' · ')) : null),
                h('span', { class: 'dc-when' }, when))))
              : h('p', { class: 'dc-empty' }, 'Nothing waiting.')),
          h('section', { class: 'dc-panel' }, h('h2', {}, panel[0]), panel[1],
            panels.length > 1 ? h('div', { class: 'dc-dots' }, panels.map((_, i) => h('span', { class: i === (S.displayPanel || 0) % panels.length ? 'on' : '' }))) : null)),
      h('footer', { class: 'dc-foot' },
        h('div', { class: 'dc-foot-brand' },
          h('img', { src: '/brand/mark-white.svg', alt: '', width: 31, height: 22 }),
          h('div', {}, h('strong', {}, 'tonament.com'), h('span', { class: 'eyebrow' }, 'One platform. Every sport. ', h('b', {}, 'Every tournament.')))),
        t.sponsors && t.sponsors.length
          ? h('div', { class: 'dc-sponsors' }, t.sponsors.map((sp) => h('img', { src: sp.url, alt: sp.caption || 'Sponsor' })))
          : null,
        h('div', { class: 'dc-foot-cta' }, h('span', {}, 'Run your own tournament — free'), 'Entries, draws and live scores')));
  }

  // Redo the draw (e.g. more players arrived) until the first point is played.
  function redrawCard(t) {
    if (!t.can.manage) return null;
    const canRedraw = (t.status === 'league' || (t.status === 'knockout' && t.format === 'knockout'))
      && !t.matches.some((m) => m.rallies > 0 || m.walkover);
    if (!canRedraw) return null;
    return h('div', { class: 'banner info' },
      h('span', {}, h('strong', {}, 'More players just arrived? '), 'You can redo the draw until the first point is played.'),
      h('button', {
        class: 'btn btn-small',
        onclick: () => {
          if (!confirm('Redo the draw? All fixtures are removed and you go back to the entry list to add players and start again.')) return;
          act(async () => { S.t = await api('POST', `${tPath(t)}/redraw`, withEv(t), t.id); navigate(tabHref(t, 'entries')); }, 'Draw undone — add players and start again');
        },
      }, 'Redraw'));
  }

  function championBanner(t) {
    if (t.status !== 'completed') return null;
    if (t.champion) return h('div', { class: 'banner champion' }, h('span', {}, '🏆 Champion: ', h('strong', {}, t.champion.name)));
    const winners = t.groups.map((g) => `${g.name}: ${g.standings[0]?.name}`).join(' · ');
    return h('div', { class: 'banner champion' }, h('span', {}, '🏆 Group winners — ', h('strong', {}, winners)));
  }

  function stageBanner(t) {
    if (t.status === 'completed') return null;
    const stage = t.status === 'league' ? 'league' : 'knockout';
    const ms = t.matches.filter((m) => m.stage === stage && m.status !== 'bye');
    const done = ms.filter((m) => m.status === 'done').length;
    if (stage === 'league' && done === ms.length && t.format === 'league_knockout') {
      return h('div', { class: 'banner info' },
        h('div', {}, h('strong', {}, 'League stage complete. '),
          `Top ${t.config.qualifiers} from each group go through to the knockout.`),
        t.can.manage
          ? h('button', {
            class: 'btn btn-primary',
            onclick: () => act(async () => {
              S.t = await api('POST', `${tPath(t)}/knockout`, withEv(t), t.id);
              navigate(tabHref(t, 'bracket'));
            }, 'Knockout bracket drawn'),
          }, 'Draw knockout bracket')
          : h('span', { class: 'muted' }, 'Waiting for the organiser to draw the bracket.'));
    }
    return h('div', { class: 'banner info' },
      h('span', {}, h('strong', {}, stage === 'league' ? 'League stage' : 'Knockout stage'), ` · ${done} of ${ms.length} matches played`),
      h('div', { class: 'progress' }, h('span', { style: `width:${ms.length ? (done / ms.length) * 100 : 0}%` })));
  }

  function matchSection(t, title, matches, emptyText, liveDot) {
    return h('section', { class: 'section' },
      h('h2', {}, title, liveDot && matches.length ? pill('live', `${matches.length}`) : null),
      matches.length ? h('div', { class: 'match-list' }, matches.map((m) => matchCard(t, m))) : h('p', { class: 'muted' }, emptyText));
  }

  function matchLabel(m) {
    return [
      m.stage === 'league' ? `${m.groupName} · ${m.roundName}` : m.roundName,
      m.catchUp && m.status !== 'done' ? 'Catch-up' : null,
      m.court ? (/^\d/.test(m.court) ? `Court ${m.court}` : m.court) : null, // "3" -> "Court 3"; "Court 3" or "Centre" as is
    ].filter(Boolean).join(' · ');
  }

  function statusTag(m) {
    if (m.status === 'live') return pill('live', 'Live');
    if (m.walkover) return pill('done', 'Walkover');
    if (m.status === 'done') return pill('done', 'Final');
    if (m.status === 'bye') return pill('', 'Bye');
    return pill('', m.a && m.b ? 'Upcoming' : 'Waiting');
  }

  function visibleGames(m) {
    const sc = m.score;
    if (m.status === 'scheduled') return [];
    return sc.games.filter((g, i) => g.a + g.b > 0 || (m.status === 'live' && i === sc.games.length - 1));
  }

  function matchCard(t, m) {
    const games = visibleGames(m);
    const side = (s) => {
      const p = m[s];
      const won = m.winner && p && m.winner === p.id;
      return h('div', { class: `mc-side${won ? ' won' : ''}` },
        h('span', { class: 'mc-name' }, m.status === 'live' && m.score.server === s ? h('span', { class: 'serve', title: 'Serving' }) : null, nameOf(p)),
        h('span', { class: 'mc-games' }, games.map((g, i) => {
          const current = m.status === 'live' && i === games.length - 1 && !g.winner;
          return h('span', { class: current ? 'cur' : g.winner === s ? 'gw' : '' }, g[s]);
        })));
    };
    return h('a', { class: `match-card ${m.status}`, href: `/t/${t.id}/m/${m.id}` },
      h('div', { class: 'mc-meta' }, h('span', {}, matchLabel(m)), statusTag(m)),
      side('a'), side('b'));
  }

  // ----- groups tab
  function panelGroups(t) {
    if (!t.groups.length) return empty('Groups appear once the tournament starts.');
    const q = t.format === 'league_knockout' ? t.config.qualifiers : 1;
    const signed = (n) => (n > 0 ? `+${n}` : String(n));
    return [
      t.format === 'league_knockout' ? h('p', { class: 'muted small' }, `Top ${q} in each group qualify for the knockout (highlighted). Ranking: matches won, then head-to-head, game difference, point difference.`) : null,
      h('div', { class: 'groups-grid' }, t.groups.map((g) => {
        const fixtures = t.matches.filter((m) => m.stage === 'league' && m.group === g.no).sort(byOrder);
        return h('div', { class: 'card' },
          h('h2', {}, g.name),
          h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['#', t.event.discipline === 'team' ? 'Team' : 'Player', 'P', 'W', 'L', unitOf(t) === 'Set' ? 'Sets' : 'Games', tennisLike(t) ? 'Gms' : 'Pts'].map((c, i) => h('th', { class: i === 1 ? '' : 'num', title: c === 'Pts' ? 'Point difference' : c === 'Gms' ? 'Game difference' : null }, c)))),
            h('tbody', {}, g.standings.map((r) => h('tr', { class: qualifying(g, q).has(r.id) ? 'q' : r.withdrawn ? 'out' : '' },
              h('td', { class: 'num' }, r.rank),
              h('td', { class: 'name' }, r.name, r.withdrawn ? [' ', pill('withdrawn', 'Withdrew')] : null),
              h('td', { class: 'num' }, r.played),
              h('td', { class: 'num' }, r.won),
              h('td', { class: 'num' }, r.lost),
              h('td', { class: 'num' }, `${r.gamesFor}–${r.gamesAgainst}`),
              h('td', { class: 'num' }, signed(r.pointsFor - r.pointsAgainst))))))),
          h('details', { open: fixtures.some((m) => m.status !== 'done') },
            h('summary', {}, `Fixtures (${fixtures.filter((m) => m.status === 'done').length}/${fixtures.length} played)`),
            h('div', { class: 'match-list', style: 'grid-template-columns:1fr' }, fixtures.map((m) => matchCard(t, m)))));
      })),
    ];
  }

  // Top q of a group, skipping withdrawn players (same rule as the knockout draw).
  function qualifying(g, q) {
    return new Set(g.standings.filter((r) => !r.withdrawn).slice(0, q).map((r) => r.id));
  }

  // ----- knockout tab
  function panelBracket(t) {
    const ko = t.matches.filter((m) => m.stage === 'knockout');
    if (!ko.length) {
      return empty(t.format === 'league_knockout'
        ? `The bracket is drawn when the league stage ends. The top ${t.config.qualifiers} from each group qualify.`
        : 'The bracket appears once the tournament starts.');
    }
    const rounds = [...new Set(ko.map((m) => m.round))].sort((a, b) => a - b);
    return [
      championBanner(t),
      h('div', { class: 'bracket-scroll' }, h('div', { class: 'bracket' }, rounds.map((r) => {
        const ms = ko.filter((m) => m.round === r).sort((x, y) => x.slot - y.slot);
        return h('div', { class: 'round' }, h('h3', {}, ms[0].roundName), h('div', { class: 'round-matches' }, ms.map((m) => bracketMatch(t, m))));
      }))),
    ];
  }

  function bracketMatch(t, m) {
    const line = (s) => {
      const p = m[s];
      const won = Boolean(m.winner && p && m.winner === p.id);
      const label = p ? p.name : m.status === 'bye' ? 'Bye' : 'TBD';
      const score = m.walkover ? (won ? 'w/o' : '')
        : m.status === 'bye' || m.status === 'scheduled' ? '' : visibleGames(m).map((g) => g[s]).join(' ');
      return h('div', { class: `b-line${won ? ' won' : ''}${p ? '' : ' tbd'}` }, h('span', { class: 'b-name' }, label), h('span', { class: 'b-score' }, score));
    };
    const attrs = { class: `b-match ${m.status}` };
    if (m.status === 'bye') return h('div', attrs, line('a'), line('b'));
    return h('a', { ...attrs, href: `/t/${t.id}/m/${m.id}` }, line('a'), line('b'), m.status === 'live' ? h('span', { class: 'b-live' }, 'LIVE') : null);
  }

  // ---------- match page (scoreboard + umpire controls)
  function stageOpen(t, m) {
    return m.stage === 'league' ? t.status === 'league' : t.status === 'knockout';
  }
  function canScore(t, m) {
    return t.can.score && m.a && m.b && (m.status === 'scheduled' || m.status === 'live') && stageOpen(t, m);
  }

  // The tournament as seen from a match's own event (its scoring rules).
  function forMatch(mid) {
    const ev = S.t && eventOfMatch(S.t, mid);
    return ev ? withEvent(S.t, ev) : null;
  }

  function viewMatch() {
    const t = forMatch(S.route.mid);
    const confirmed = t && t.matches.find((x) => x.id === S.route.mid);
    if (!confirmed) return errorView('Match not found.');
    const m = withPending(t, confirmed);
    if (pendingOps(m.id).length && !sending.has(m.id)) sendQueue(t, m.id); // resume after navigating away
    document.title = `${nameOf(m.a)} v ${nameOf(m.b)} · ${t.name}`;
    const backTab = m.stage === 'knockout' ? 'bracket' : 'live';
    return [
      h('a', { class: 'back', href: tabHref(t, backTab) }, `← ${t.name}${multiEvent(t) ? ` · ${t.event.name}` : ''}`),
      h('div', { class: 'match-head' },
        h('span', {}, matchLabel(m)),
        h('span', { class: 'actions' }, connDot(), statusTag(m))),
      scoreboard(m),
      canScore(t, m) ? scorer(t, m) : null,
      t.can.score && m.status === 'done' && m.rallies
        ? h('div', { class: 'actions center', style: 'margin-bottom:16px' },
          h('button', { class: 'btn btn-ghost', onclick: () => undo(t, m) }, '↶ Undo last point (reopens the match)'))
        : null,
      gamesTable(m),
      !t.can.score && m.status !== 'done' ? h('p', { class: 'muted center small' }, 'This scoreboard updates live — no need to refresh.') : null,
    ];
  }

  function scoreboard(m) {
    const sc = m.score;
    const cur = sc.games[sc.games.length - 1];
    const live = m.status === 'live';
    const row = (s) => {
      const p = m[s];
      const won = Boolean(m.winner && p && m.winner === p.id);
      const flag = live ? (sc.matchPoint[s] ? 'Match point' : sc.gamePoint[s] ? `${sc.unit || 'Game'} point` : null) : null;
      // Tennis-style sports also show the games in this set, and calls (15, 30, 40, AD) for points.
      return h('div', { class: `sb-row side-${s}${won ? ' won' : ''}${sc.setGames ? ' has-set' : ''}` },
        h('div', { class: 'sb-serve' }, live && sc.server === s ? h('span', { class: 'serve', title: 'Serving' }) : null),
        h('div', { class: 'sb-name' }, nameOf(p), flag ? h('span', { class: 'flag' }, flag) : null, won ? h('span', { class: 'flag' }, 'Winner') : null),
        h('div', { class: 'sb-games', title: `${sc.unit || 'Game'}s won` }, sc.gamesWon[s]),
        sc.setGames ? h('div', { class: 'sb-games sb-set', title: 'Games in this set' }, sc.setGames[s]) : null,
        h('div', { class: 'sb-points' }, m.status === 'done' || m.status === 'bye' ? '' : sc.points ? sc.points[s] : cur[s]));
    };
    return h('div', { class: 'scoreboard' }, row('a'), row('b'),
      live && sc.server
        ? h('div', { class: 'sb-foot' }, `${sc.unit || 'Game'} ${sc.games.length} · ${nameOf(m[sc.server])} to serve${sc.serveCourt ? ` from the ${sc.serveCourt} court` : ''}${sc.note ? ` · ${sc.note}` : ''}`)
        : m.status === 'done' ? h('div', { class: 'sb-foot' }, m.summary) : null);
  }

  function scorer(t, m) {
    const fresh = m.rallies === 0;
    // Side-out sports: winning the rally while receiving wins the serve, not a point.
    const tap = (s) => (m.score.tap && m.score.tap[s]) || '+1';
    const btn = (s) => h('button', {
      class: `score-btn side-${s}`,
      onclick: () => rally(t, m, s),
      'aria-label': ['+1', 'Point'].includes(tap(s)) ? `Point to ${m[s].name}` : `${m[s].name} won the rally: ${tap(s)}`,
    }, h('span', { class: `sbtn-plus${tap(s) === '+1' ? '' : ' sbtn-word'}` }, tap(s)), h('span', { class: 'sbtn-name' }, m[s].name));

    const courtInput = h('input', { name: 'court', maxlength: 20, placeholder: 'e.g. 3', value: m.court || '', 'aria-label': 'Court' });
    return h('div', { class: 'scorer' },
      fresh ? h('div', { class: 'card', style: 'margin:0' },
        h('div', { class: 'scorer-tools' },
          h('span', {}, h('span', { class: 'label' }, 'First serve: '),
            h('span', { class: 'seg' }, ['a', 'b'].map((s) => h('button', {
              'aria-pressed': String(m.firstServer === s),
              onclick: () => patchMatch(t, m, { firstServer: s }),
            }, m[s].name)))),
          m.status === 'scheduled'
            ? h('button', { class: 'btn btn-small', onclick: () => patchMatch(t, m, { status: 'live' }, 'Match marked as on court') }, 'Mark on court')
            : null)) : null,
      h('div', { class: 'score-btns' }, btn('a'), btn('b')),
      h('div', { class: `sync ${S.offline && m.pending ? 'offline' : m.pending ? 'saving' : 'saved'}`, role: 'status' },
        S.offline && m.pending
          ? `No connection — ${m.pending} point${m.pending === 1 ? '' : 's'} waiting, will send automatically`
          : m.pending ? 'Saving…' : 'All points saved'),
      h('div', { class: 'scorer-tools' },
        h('button', { class: 'btn', disabled: fresh, onclick: () => undo(t, m) }, '↶ Undo'),
        h('form', {
          class: 'inline-form',
          onsubmit: (e) => { e.preventDefault(); patchMatch(t, m, { court: courtInput.value }, 'Court saved'); courtInput.blur(); },
        }, h('span', { class: 'label' }, 'Court'), courtInput, h('button', { class: 'btn btn-small', type: 'submit' }, 'Save'))),
      h('p', { class: 'hint center', style: 'margin:0' }, 'Tap the side that won the rally. Keyboard: A / ← and L / → to score, Z to undo.'));
  }

  function gamesTable(m) {
    const games = m.score.games.filter((g) => g.a + g.b > 0);
    if (!games.length) return null;
    return h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'games-table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), games.map((_, i) => h('th', { class: 'num' }, `${m.score.unit || 'Game'} ${i + 1}`)))),
      h('tbody', {}, ['a', 'b'].map((s) => h('tr', {},
        h('td', { class: 'name' }, nameOf(m[s])),
        games.map((g) => h('td', { class: `num${g.winner === s ? ' won' : ''}` }, g[s]))))))));
  }

  // ---------- scoring queue
  // A tap updates the screen at once — the new score is worked out locally
  // with the same rules file the server uses — and is then sent in the
  // background, one request at a time, in order. Each request names the rally
  // count it applies to, so a retry after a dropped connection can never be
  // counted twice. Points survive flaky venue Wi-Fi: they're retried until
  // the connection is back.
  const queues = new Map(); // matchId -> [{ type: 'rally', side } | { type: 'undo' }]
  const sending = new Set();
  const pendingOps = (mid) => queues.get(mid) || [];
  const scoringBusy = () => sending.size > 0 || [...queues.values()].some((q) => q.length);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const confirmedMatch = (mid) => S.t && allMatches(S.t).find((x) => x.id === mid);

  // Tennis and padel: standings break ties on games, not points.
  const tennisLike = (t) => ['tennis', 'padel'].includes(t.sport.id);

  // "Game" or "Set", from the sport's rules.
  function unitOf(t) {
    const sport = window.TonamentSports && window.TonamentSports[t.sport.id];
    return (sport && sport.compute('', {}).unit) || 'Game';
  }

  // The match as the umpire should see it: confirmed state plus queued taps.
  function withPending(t, m) {
    const ops = pendingOps(m.id);
    const sport = window.TonamentSports && window.TonamentSports[t.sport.id];
    if (!ops.length || !sport) return m;
    let log = m.log;
    for (const op of ops) log = op.type === 'rally' ? log + op.side : log.slice(0, -1);
    const scoring = t.event && t.event.discipline === 'doubles' ? { ...t.config.scoring, doubles: true } : t.config.scoring;
    const score = sport.compute(log, scoring, m.firstServer);
    return {
      ...m,
      log,
      rallies: log.length,
      score,
      summary: sport.summary(score),
      status: score.winner ? 'done' : 'live',
      winner: score.winner ? m[score.winner].id : null,
      pending: ops.length,
    };
  }

  function enqueue(t, mid, op) {
    queues.set(mid, [...pendingOps(mid), op]);
    render();
    sendQueue(t, mid);
  }

  function rally(t, m, side) {
    const shown = withPending(t, confirmedMatch(m.id) || m);
    if (shown.status === 'done') return;
    if (navigator.vibrate) navigator.vibrate(12);
    enqueue(t, m.id, { type: 'rally', side });
    const after = withPending(t, confirmedMatch(m.id) || m);
    if (after.status === 'done') toast(`🏸 ${after[side].name} wins ${after.summary}`);
  }

  function undo(t, m) {
    const shown = withPending(t, confirmedMatch(m.id) || m);
    if (!shown.rallies) return;
    if (shown.status === 'done' && !confirm('Undo the winning point and reopen this match?')) return;
    enqueue(t, m.id, { type: 'undo' });
  }

  async function sendQueue(t, mid) {
    if (sending.has(mid)) return;
    sending.add(mid);
    let delay = 1000;
    try {
      while (pendingOps(mid).length && S.t && S.t.id === t.id) {
        const op = pendingOps(mid)[0];
        const base = confirmedMatch(mid);
        const at = base.rallies;
        const expected = op.type === 'rally' ? base.log + op.side : base.log.slice(0, -1);
        try {
          const updated = await api('POST', `${tPath(t)}/matches/${mid}/${op.type}`, op.type === 'rally' ? { side: op.side, at } : { at }, t.id);
          mergeMatch(updated);
          queues.set(mid, pendingOps(mid).slice(1));
          S.offline = false;
          delay = 1000;
          if (updated.status === 'done' || base.status === 'done') refresh(); // standings / bracket changed
        } catch (e) {
          if (e.network) {
            // Keep the points and try again; the `at` guard makes this safe.
            S.offline = true;
            render(true);
            await sleep(delay);
            delay = Math.min(delay * 2, 15000);
            continue;
          }
          if (e.code === 'stale') {
            // Perhaps an earlier attempt did reach the server before the
            // connection dropped. If so, the point is already saved.
            await load(t.id);
            const fresh = confirmedMatch(mid);
            if (fresh && fresh.log === expected) {
              queues.set(mid, pendingOps(mid).slice(1));
              continue;
            }
          }
          queues.set(mid, []);
          S.offline = false;
          toast(e.message, true);
          refresh();
          break;
        }
        render(true);
      }
    } finally {
      sending.delete(mid);
      render(true);
    }
  }

  // Don't lose points that haven't reached the server yet.
  window.addEventListener('beforeunload', (e) => {
    if (scoringBusy()) e.preventDefault();
  });

  function patchMatch(t, m, body, msg) {
    act(async () => { mergeMatch(await api('PATCH', `${tPath(t)}/matches/${m.id}`, body, t.id)); }, msg);
  }

  // Keyboard scoring for umpires on a laptop.
  document.addEventListener('keydown', (e) => {
    if (S.route.name !== 'match' || !S.t || !S.t.can.score || isEditing() || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = forMatch(S.route.mid);
    const confirmed = t && t.matches.find((x) => x.id === S.route.mid);
    if (!confirmed) return;
    const m = withPending(t, confirmed);
    const k = e.key.toLowerCase();
    if ((k === 'a' || k === 'arrowleft') && canScore(t, m)) rally(t, m, 'a');
    else if ((k === 'l' || k === 'arrowright') && canScore(t, m)) rally(t, m, 'b');
    else if ((k === 'z' || k === 'backspace') && m.rallies && (canScore(t, m) || m.status === 'done')) undo(t, m);
    else return;
    e.preventDefault();
  });


  // ---------- paid plans (Razorpay checkout)
  const money = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const rupees = (n) => `₹${n.toLocaleString('en-IN')}`;

  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://checkout.razorpay.com/v1/checkout.js';
      el.onload = resolve;
      el.onerror = () => reject(new Error('Couldn\'t load the payment window — check your connection and try again'));
      document.head.appendChild(el);
    });
  }

  // "Find me a partner": no partner name; mixed doubles asks man or woman.
  function syncSolo(form, solo) {
    const partner = form.querySelector('.partner-field');
    if (partner) {
      partner.hidden = solo;
      partner.querySelector('input').required = !solo;
    }
    const side = form.querySelector('.side-field');
    if (side) side.hidden = !solo;
  }

  // Pays a self-entry's fee in Razorpay Checkout: 'paid', 'cancelled' or 'failed'.
  async function payEntry(order) {
    await loadRazorpay();
    return new Promise((resolve) => {
      let failed = false;
      const rzp = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: order.name,
        description: order.description,
        image: `${location.origin}/brand/icon-512.png`,
        prefill: order.prefill,
        theme: { color: '#0B1220' },
        handler: async (resp) => {
          try {
            await api('POST', '/billing/razorpay/verify', resp);
            resolve('paid');
          } catch (e) {
            toast(e.message, true);
            resolve('failed');
          }
        },
        modal: { ondismiss: () => resolve(failed ? 'failed' : 'cancelled') },
      });
      rzp.on('payment.failed', () => { failed = true; });
      rzp.open();
    });
  }

  // Buys a plan (or an upgrade: only the difference is charged).
  async function payPass(t, tier) {
    if (S.paying) return;
    S.paying = true;
    render();
    try {
      await loadRazorpay();
      const order = await api('POST', `${tPath(t)}/checkout`, { tier }, t.id);
      await new Promise((resolve) => {
        const rzp = new window.Razorpay({
          key: order.keyId,
          order_id: order.orderId,
          amount: order.amount,
          currency: order.currency,
          name: order.name,
          description: order.description,
          image: `${location.origin}/brand/icon-512.png`,
          prefill: order.prefill,
          theme: { color: '#0B1220' },
          handler: async (resp) => {
            try {
              await api('POST', '/billing/razorpay/verify', resp);
              S.upgradeFor = null;
              await load(t.id);
              const waiting = allEntries(t).filter((e) => !e.confirmed).length;
              const active = `Payment received — ${S.t ? S.t.planName : 'new'} plan active ✓`;
              toast(waiting ? `${active} ${waiting} waiting ${waiting === 1 ? 'entry' : 'entries'} confirmed` : active);
            } catch (e) {
              toast(e.message, true);
            }
            resolve();
          },
          modal: {
            ondismiss: () => {
              toast('Payment cancelled — you haven\'t been charged');
              resolve();
            },
          },
        });
        rzp.on('payment.failed', (r) => toast((r && r.error && r.error.description) || 'Payment failed — please try again', true));
        rzp.open();
      });
    } catch (e) {
      toast(e.message, true);
    } finally {
      S.paying = false;
      render();
    }
  }

  // One button per bigger plan, cheapest first ("Club · up to 64 — ₹499").
  function upgradeButtons(t, small) {
    return (t.upgrades || []).map((u, i) => h('button', {
      class: `btn ${i === 0 ? 'btn-primary' : 'btn-ghost'}${small ? '' : ' btn-lg'}`,
      disabled: S.paying,
      onclick: () => payPass(t, u.id),
    }, S.paying && i === 0 ? 'Opening payment…' : `${u.name} · up to ${u.limit} — ${money(u.amount)}`));
  }

  // Shown to organisers when the tournament is full on its plan (or just hit the limit).
  function upgradeCard(t) {
    if (!S.billing.enabled || !t.can.manage || !t.limits || !t.limits.entries || !(t.upgrades || []).length) return null;
    const full = allEntries(t).filter((e) => e.confirmed).length >= t.limits.entries;
    // Waiting because of the plan limit (not the organiser's own maximum).
    const waiting = full ? allEntries(t).filter((e) => !e.confirmed).length : 0;
    if (!full && S.upgradeFor !== t.id) return null;
    const paidBefore = t.plan !== 'free';
    return h('div', { class: 'card upgrade-card' },
      h('h2', {}, waiting
        ? `${waiting} ${waiting === 1 ? 'player is' : 'players are'} waiting to be confirmed`
        : full ? `This tournament is full on the ${t.planName} plan (${t.limits.entries} entries)` : 'Need more entries?'),
      h('p', {}, waiting
        ? 'Move up a plan to include them — everyone waiting is confirmed automatically.'
        : `Move up a plan for more entries across all events${paidBefore ? '' : ' (Open and above also put your logo, colours and sponsors on the public pages)'} — one-time, for this tournament${paidBefore ? '; you only pay the difference' : ''}.`),
      h('div', { class: 'actions' }, upgradeButtons(t), h('a', { class: 'btn btn-ghost', href: '/pricing', target: '_blank', rel: 'noopener' }, 'Compare plans')),
      h('p', { class: 'hint', style: 'margin:10px 0 0' }, 'Secure payment by Razorpay — UPI, cards, netbanking or wallets. Activated instantly.'));
  }

  // Plan status in the Team tab (+ a manual switch for site admins).
  function planCard(t) {
    const admin = S.me && S.me.isAdmin;
    if (!S.billing.enabled && !admin) return null;
    const plans = [['free', 'Free'], ...(S.billing.tiers || []).map((x) => [x.id, x.name]), ['pass', 'Event Pass (unlimited)']];
    const adminSwitch = admin
      ? h('label', { class: 'admin-plan' }, h('span', { class: 'muted small' }, 'Admin: set plan'),
        h('select', {
          value: t.plan,
          onchange: (e) => {
            const plan = e.target.value;
            const label = plans.find((p) => p[0] === plan)[1];
            if (!confirm(`Set this tournament to the ${label} plan (no payment)?`)) { e.target.value = t.plan; return; }
            act(async () => { S.t = await api('POST', `/admin/tournaments/${encodeURIComponent(t.id)}/plan`, { plan }, t.id); }, `Plan set to ${label}`);
          },
        }, plans.map(([value, label]) => h('option', { value }, label))))
      : null;
    const used = allEntries(t).filter((e) => e.confirmed).length;
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Plan'), pill(t.plan === 'free' ? '' : 'done', t.plan === 'free' ? 'Free' : `${t.planName} ✓`)),
      !S.billing.enabled ? h('p', { class: 'muted small' }, 'Payments aren\'t set up yet, so there\'s no entry limit.')
        : t.limits && t.limits.entries
          ? h('p', { class: 'muted small' }, `${used} of ${t.limits.entries} entries used, across all events.`)
          : h('p', { class: 'muted small' }, 'Unlimited entries for this tournament.'),
      S.billing.enabled && (t.upgrades || []).length ? h('div', { class: 'actions' }, upgradeButtons(t, true)) : null,
      adminSwitch ? h('div', { class: 'actions', style: 'margin-top:10px' }, adminSwitch) : null,
      admin ? h('label', { class: 'check-field', style: 'margin:12px 0 0' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(t.official),
          onchange: (e) => {
            const on = e.target.checked;
            if (!confirm(on ? 'Mark this tournament as organised by Tonament? Its events can then charge entry fees, paid to Tonament.' : 'Remove "Organised by Tonament"? Entry fees will stop being charged.')) { e.target.checked = !on; return; }
            act(async () => { S.t = await api('POST', `/admin/tournaments/${encodeURIComponent(t.id)}/official`, { official: on }, t.id); }, on ? 'Marked as organised by Tonament' : 'No longer organised by Tonament');
          },
        }),
        h('span', {}, h('strong', {}, 'Organised by Tonament'), h('small', {}, 'Admin only. Lets this tournament\'s events charge entry fees, paid to Tonament.'))) : null);
  }

  // ---------- roles & team
  function roleBar(t) {
    if (t.can.claim) {
      return h('div', { class: 'admin-bar' },
        h('span', {}, '🔑 You opened this with its organiser link. Add it to your account to manage it from anywhere.'),
        h('button', {
          class: 'btn btn-small btn-primary',
          onclick: () => act(async () => { S.t = await api('POST', `${tPath(t)}/claim`, {}, t.id); }, 'Tournament added to your account'),
        }, 'Add to my account'));
    }
    if (!t.role) return null;
    const label = {
      admin: 'You are a site admin',
      owner: 'You own this tournament',
      organiser: 'You are an organiser',
      umpire: 'You are an umpire — open any match to score it',
    }[t.role];
    return h('div', { class: 'admin-bar' },
      h('span', {}, `🔑 ${label}`,
        !S.me ? h('span', { class: 'muted' }, ' (via a share link — ', h('a', { href: `/signin?next=${encodeURIComponent(`/t/${t.id}`)}` }, 'sign in'), ' to keep it in your account)') : null),
      h('button', {
        class: 'btn btn-small btn-ghost',
        onclick: () => copy(shareUrl(t), t.visibility === 'private' ? 'Link copied — only your team can open it until you publish' : 'Public link copied'),
      }, 'Copy public link'));
  }

  // The cheapest plan that includes branding, with what it would cost now.
  const brandingOffer = (t) => (t.upgrades || []).find((u) => u.id === (t.brandingPlan || 'open'));

  // ----- page & branding (organisers)
  function pageCard(t) {
    if (!t.can.manage) return null;
    // Unsaved text survives the redraws that uploads cause.
    const draft = S.pageDraft && S.pageDraft.tid === t.id ? S.pageDraft : null;
    const L = draft ? draft.pageLinks : t.pageLinks || {};
    const saved = t.brandingSettings || {};
    const B = draft ? { ...saved, orgName: draft.orgName, accent: draft.accentOn ? draft.accent : '' } : saved;
    const about = draft ? draft.about : t.about || '';
    const perks = draft ? draft.perks : (t.perks && t.perks.items) || [];
    const perksOther = draft ? draft.perksOther : ((t.perks && t.perks.other) || []).join(', ');
    const notes = draft ? draft.notes : t.notes || '';
    const limits = t.mediaLimits || { photos: 3, sponsors: 0 };
    const keepDraft = (f) => {
      const fd = new FormData(f);
      S.pageDraft = {
        tid: t.id,
        about: fd.get('about') || '',
        perks: fd.getAll('perk'),
        perksOther: fd.get('perksOther') || '',
        notes: fd.get('notes') || '',
        pageLinks: { website: fd.get('website') || '', instagram: fd.get('instagram') || '', whatsapp: fd.get('whatsapp') || '' },
        orgName: fd.get('orgName') || '',
        accent: fd.get('accent') || '',
        accentOn: Boolean(fd.get('accentOn')),
      };
    };
    const paid = t.brandingAllowed;
    const upload = (kind, files, caption) => {
      const list = [...files];
      if (!list.length) return;
      S.uploading = (S.uploading || 0) + list.length;
      render();
      (async () => {
        for (const file of list) {
          try {
            const data = await prepareImage(file, kind);
            S.t = await api('POST', `${tPath(t)}/media`, { kind, data, caption }, t.id);
            // A small 1200×630 copy of the cover for link previews (best effort).
            if (kind === 'cover') {
              await prepareImage(file, 'preview').then((preview) => api('POST', `${tPath(t)}/media`, { kind: 'preview', data: preview }, t.id)).catch(() => {});
            }
            toast(kind === 'photo' ? 'Photo added ✓' : kind === 'cover' ? 'Cover updated ✓' : kind === 'logo' ? 'Logo updated ✓' : 'Sponsor added ✓');
          } catch (e) {
            if (e.code === 'upgrade') S.upgradeFor = t.id;
            toast(e.message, true);
          } finally {
            S.uploading -= 1;
            render();
          }
        }
      })();
    };
    const fileButton = (label, kind, multiple, disabled) => h('label', { class: `btn btn-small${disabled ? ' disabled' : ''}` },
      label,
      h('input', { type: 'file', accept: 'image/*', multiple: multiple || null, hidden: true, disabled: disabled || null, onchange: (e) => { upload(kind, e.target.files); e.target.value = ''; } }));
    const mediaAct = (mediaId, body, msg) => act(async () => {
      S.t = await api(body ? 'PATCH' : 'DELETE', `${tPath(t)}/media/${mediaId}`, body, t.id);
    }, msg);
    const swatches = ['#A3E635', '#F97316', '#EF4444', '#EC4899', '#8B5CF6', '#3B82F6', '#06B6D4', '#EAB308'];

    const form = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = {
          about: fd.get('about') || '',
          perks: { items: fd.getAll('perk'), other: (fd.get('perksOther') || '').split(',').map((x) => x.trim()).filter(Boolean) },
          notes: fd.get('notes') || '',
          pageLinks: { website: fd.get('website') || '', instagram: fd.get('instagram') || '', whatsapp: fd.get('whatsapp') || '' },
          ...(paid && { branding: { orgName: fd.get('orgName') || '', accent: fd.get('accentOn') ? fd.get('accent') : '' } }),
        };
        saveForm(form, async () => { S.t = await api('PATCH', tPath(t), body, t.id); S.pageDraft = null; }, 'Page saved');
      },
      oninput: () => keepDraft(form),
      onchange: () => keepDraft(form),
    },
    field('About this tournament', h('textarea', { name: 'about', rows: 4, maxlength: 2000, value: about, placeholder: 'What it is, who can play, contact…' })),
    h('div', { class: 'grid-2' },
      field('Website', h('input', { name: 'website', type: 'url', value: L.website || '', placeholder: 'https://' })),
      field('Instagram', h('input', { name: 'instagram', type: 'url', value: L.instagram || '', placeholder: 'https://instagram.com/…' }))),
    field('WhatsApp group', h('input', { name: 'whatsapp', type: 'url', value: L.whatsapp || '', placeholder: 'https://chat.whatsapp.com/…' })),

    h('fieldset', { class: 'details-set' }, h('legend', {}, 'What\'s included'),
      h('p', { class: 'hint', style: 'margin:0' }, 'What players get with their entry. Prizes are set per event, on the Players tab.'),
      h('div', { class: 'quick-grid perk-grid' }, Object.keys(CAT.PERKS).map((k) => h('label', { class: 'check-field' },
        h('input', { type: 'checkbox', name: 'perk', value: k, checked: perks.includes(k) }), h('span', {}, CAT.perkLabel(k, t.sport.id))))),
      field('Anything else', h('input', { name: 'perksOther', maxlength: 220, value: perksOther, placeholder: 'e.g. Free physio, Photo booth' }), null, 'Separate items with commas (up to 5).')),
    field('Other details', h('textarea', { name: 'notes', rows: 4, maxlength: 2000, value: notes, placeholder: 'Reporting time, dress code, shuttles or balls used, rules, contact person…' }), null, 'Shown to players with the prizes. Links become clickable.'),

    h('fieldset', { class: 'details-set' }, h('legend', {}, 'Cover image'),
      t.cover ? h('img', { class: 'cover-preview', src: t.cover, alt: 'Cover' }) : h('p', { class: 'hint', style: 'margin:0' }, 'A poster or a photo — shown at the top of the page and on search results.'),
      h('div', { class: 'actions' },
        fileButton(t.cover ? 'Replace cover' : 'Upload cover', 'cover'),
        t.cover ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => mediaAct(t.coverId, null, 'Cover removed') }, 'Remove') : null)),

    h('fieldset', { class: 'details-set' }, h('legend', {}, `Photos (${t.photos.length} of ${limits.photos})`),
      t.photos.length
        ? h('ol', { class: 'photo-list' }, t.photos.map((p, i) => h('li', { class: p.hidden ? 'hidden-photo' : '' },
          h('img', { src: p.url, alt: '' }),
          h('input', {
            value: p.caption || '', placeholder: 'Caption (optional)', maxlength: 120, 'aria-label': 'Caption',
            onchange: (e) => mediaAct(p.id, { caption: e.target.value }, 'Caption saved'),
          }),
          p.hidden ? h('small', { class: 'hint' }, 'Hidden on the free plan') : null,
          h('span', { class: 'row-actions' },
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move up', disabled: i === 0, onclick: () => mediaAct(p.id, { move: -1 }) }, '↑'),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move down', disabled: i === t.photos.length - 1, onclick: () => mediaAct(p.id, { move: 1 }) }, '↓'),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Delete photo', onclick: () => confirm('Delete this photo?') && mediaAct(p.id, null, 'Photo deleted') }, '✕')))))
        : h('p', { class: 'hint', style: 'margin:0' }, 'Photos from past editions, the venue or the trophies.'),
      h('div', { class: 'actions' }, fileButton('Add photos', 'photo', true, t.photos.length >= limits.photos)),
      limits.photos < 30 ? h('p', { class: 'hint', style: 'margin:0' }, `Free plan: ${limits.photos} photos. Paid plans: up to 30.`) : null),

    h('fieldset', { class: `details-set${paid ? '' : ' locked'}` }, h('legend', {}, paid ? 'Your branding' : 'Your branding · paid plans'),
      !paid
        ? [h('p', { class: 'hint', style: 'margin:0' }, 'Put your logo, name and colours on the public pages and add sponsor logos — with "Powered by TONAMENT" at the bottom. Included with the Open and Championship plans.'),
          brandingOffer(t) ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary btn-small', onclick: () => payPass(t, brandingOffer(t).id) }, `Get ${brandingOffer(t).name} — ${money(brandingOffer(t).amount)}`)) : null]
        : [
          h('div', { class: 'brand-row' },
            B.logo ? h('img', { class: 'logo-preview', src: B.logo, alt: 'Logo' }) : h('span', { class: 'logo-preview empty' }, 'Logo'),
            h('div', { class: 'actions' },
              fileButton(B.logo ? 'Replace logo' : 'Upload logo', 'logo'),
              B.logo ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => mediaAct(B.logoId, null, 'Logo removed') }, 'Remove') : null)),
          field('Organiser name', h('input', { name: 'orgName', maxlength: 60, value: B.orgName || '', placeholder: 'e.g. Smash Sports Club' })),
          h('label', { class: 'check-field' },
            h('input', { type: 'checkbox', name: 'accentOn', checked: Boolean(B.accent) }),
            h('span', {}, h('strong', {}, 'Use our brand colour'), h('small', {}, 'For buttons, tabs and highlights on your public pages.'))),
          h('div', { class: 'swatches' },
            h('input', { type: 'color', name: 'accent', value: B.accent || '#F97316', 'aria-label': 'Brand colour' }),
            swatches.map((c) => h('button', {
              type: 'button', class: 'swatch', style: `background:${c}`, 'aria-label': `Use ${c}`,
              onclick: (e) => { const f = e.target.form; f.accent.value = c; f.accentOn.checked = true; f.setAttribute('data-dirty', ''); keepDraft(f); },
            }))),
          h('div', { class: 'sponsor-admin' },
            h('strong', {}, `Sponsor logos (${(t.allSponsors || []).length} of ${limits.sponsors})`),
            h('div', { class: 'sponsor-logos' }, (t.allSponsors || []).map((sp) => h('span', { class: 'sponsor-edit' },
              h('img', { src: sp.url, alt: '' }),
              h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove sponsor', onclick: () => mediaAct(sp.id, null, 'Sponsor removed') }, '✕')))),
            fileButton('Add sponsor logo', 'sponsor', true, (t.allSponsors || []).length >= limits.sponsors)),
        ]),
    S.uploading ? h('p', { class: 'hint uploading', role: 'status' }, `Uploading ${S.uploading} image${S.uploading > 1 ? 's' : ''}…`) : null,
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save page')));
    return panel(t, 'page', 'Public page · about, what\'s included, photos, branding', form);
  }

  // ----- visibility (owner controls who can see the tournament)
  const VISIBILITY = [
    ['private', 'Private', 'Only your team can see it. No public sign-ups.'],
    ['link', 'Link only', 'Anyone with the link can view and enter. Not listed on Tonament.'],
    ['public', 'Public', 'Listed on the Tonament home page. Anyone can view and enter.'],
  ];
  function visibilityPill(v) {
    if (v === 'private') return pill('waiting', '🔒 Private');
    if (v === 'link') return pill('waiting', 'Link only');
    return null;
  }
  function setVisibility(t, v) {
    const label = VISIBILITY.find((x) => x[0] === v)[1];
    const findable = t.startsOn && t.location.city;
    act(async () => { S.t = await api('POST', `${tPath(t)}/visibility`, { visibility: v }, t.id); },
      v !== 'public' ? `Visibility: ${label}`
        : findable ? 'Published — your tournament is public'
          : 'Published — add a date and city in Settings so players can find it');
  }
  function visibilityControl(t) {
    const current = VISIBILITY.find((x) => x[0] === t.visibility) || VISIBILITY[0];
    return h('div', { class: 'visibility' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Who can see this tournament' },
        VISIBILITY.map(([v, label]) => h('button', {
          type: 'button',
          'aria-pressed': String(v === t.visibility),
          onclick: () => { if (v !== t.visibility) setVisibility(t, v); },
        }, label))),
      h('p', { class: 'hint', style: 'margin:8px 0 0' }, current[2]));
  }
  // Top of the page while private.
  function visibilityBanner(t) {
    if (!t.can.own) {
      return t.can.score
        ? h('div', { class: 'banner info' }, h('span', {}, '🔒 ', h('strong', {}, 'Private'), ' — only the team can see this. The owner can publish it.'))
        : null;
    }
    return h('div', { class: 'banner info visibility-banner' },
      h('div', {},
        h('div', {}, '🔒 ', h('strong', {}, 'Private'), ' — only your team can see this.'),
        h('div', { class: 'muted small' }, 'Publish when you\'re ready for players and spectators, or share it by link only.')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', onclick: () => setVisibility(t, 'public') }, 'Publish'),
        h('button', { class: 'btn btn-ghost', onclick: () => setVisibility(t, 'link') }, 'Link only')));
  }
  function visibilityCard(t) {
    if (!t.can.own) return null;
    return h('div', { class: 'card' },
      h('h2', {}, 'Who can see this tournament'),
      visibilityControl(t));
  }

  async function loadMembers(t) {
    try {
      S.members = { tid: t.id, list: await api('GET', `${tPath(t)}/members`, undefined, t.id) };
    } catch (e) {
      S.members = { tid: t.id, list: [], error: e.message };
    }
    render();
  }

  function panelTeam(t) {
    if (!S.members || S.members.tid !== t.id) {
      S.members = { tid: t.id, list: null };
      loadMembers(t);
    }
    const list = S.members.list;
    const emailInput = h('input', { name: 'email', type: 'email', required: true, placeholder: 'name@example.com', autocomplete: 'off' });
    const roleSelect = h('select', { name: 'role' },
      h('option', { value: 'umpire' }, 'Umpire — can score matches'),
      h('option', { value: 'organiser' }, 'Organiser — can manage everything'));
    const setMembers = (members) => { S.members = { tid: t.id, list: members }; };
    const linkRow = (label, hint, url, msg) => h('div', { class: 'link-row' },
      h('div', {}, h('strong', {}, label), h('div', { class: 'hint' }, hint)),
      h('button', { class: 'btn btn-small', onclick: () => copy(url, msg) }, 'Copy link'));

    return [
      visibilityCard(t),
      pageCard(t),
      h('div', { class: 'card' },
        h('h2', {}, 'Team'),
        h('p', { class: 'muted small' }, 'Add people by email. If they don\'t have an account yet, they get access as soon as they sign up with that email.',
          S.emailEnabled ? ' We\'ll email them to let them know.' : ' Let them know yourself — invite emails aren\'t set up on this site yet.'),
        list == null ? loading()
          : h('ul', { class: 'members' }, list.map((m) => h('li', {},
            h('div', { class: 'name' },
              h('div', {}, m.name || m.email, ' ', m.joined ? null : h('span', { class: 'pill' }, 'Invited')),
              m.name ? h('div', { class: 'muted small' }, m.email) : h('div', { class: 'muted small' }, 'Not signed up yet')),
            pill(m.role === 'owner' ? 'org' : '', m.roleName),
            m.role === 'owner' ? null : h('button', {
              class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${m.email}`,
              onclick: () => {
                if (!confirm(`Remove ${m.name || m.email} from the team?`)) return;
                act(async () => setMembers(await api('DELETE', `${tPath(t)}/members/${m.id}`, undefined, t.id)), 'Removed');
              },
            }, '✕')))),
        h('form', {
          class: 'team-form',
          onsubmit: (e) => {
            e.preventDefault();
            const email = emailInput.value;
            act(async () => {
              const { members, emailed } = await api('POST', `${tPath(t)}/members`, { email, role: roleSelect.value }, t.id);
              setMembers(members);
              emailInput.value = '';
              toast(emailed ? `${email} added — we've emailed them` : `${email} added`);
            });
          },
        }, emailInput, roleSelect, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add'))),
      t.links ? h('div', { class: 'card' },
        h('h2', {}, 'Share links'),
        h('p', { class: 'muted small' }, 'For people without an account — e.g. a volunteer scoring on a borrowed phone. Anyone with a link gets its access, so share carefully.'),
        linkRow('Scorer link', 'Can score matches only.', `${location.origin}/#/t/${t.id}?key=${encodeURIComponent(t.links.scorer)}`, 'Scorer link copied'),
        linkRow('Organiser link', 'Can manage the whole tournament.', `${location.origin}/#/t/${t.id}?key=${encodeURIComponent(t.links.organiser)}`, 'Organiser link copied — keep it private'),
        linkRow('Public link', 'Anyone can follow live scores. Shows the name, dates and cover image when shared.', shareUrl(t), 'Public link copied'),
        t.visibility !== 'private'
          ? h('div', { class: 'actions' }, h('a', { class: 'btn btn-small', href: whatsappUrl(t), target: '_blank', rel: 'noopener' }, 'Share on WhatsApp'))
          : null) : null,
      planCard(t),
      dangerZone(t),
    ];
  }

  // ---------- theme (Auto follows the device; dark is the brand default)
  const THEMES = [['auto', 'Auto'], ['dark', 'Dark'], ['light', 'Light']];
  const themeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const themePref = () => document.documentElement.getAttribute('data-theme-pref') || 'auto';

  function applyTheme(pref) {
    const light = themeQuery && themeQuery.matches;
    document.documentElement.setAttribute('data-theme', pref === 'auto' ? (light ? 'light' : 'dark') : pref);
    document.documentElement.setAttribute('data-theme-pref', pref);
    for (const b of document.querySelectorAll('.theme-switch button')) {
      b.setAttribute('aria-pressed', String(b.dataset.theme === pref));
    }
  }

  function setTheme(pref) {
    try { localStorage.setItem('tonament:theme', pref); } catch { /* storage unavailable: applies to this visit only */ }
    applyTheme(pref);
  }

  function themeSwitch() {
    return h('div', { class: 'theme-switch', role: 'group', 'aria-label': 'Colour theme' },
      THEMES.map(([value, label]) => h('button', {
        type: 'button', 'data-theme': value, 'aria-pressed': String(themePref() === value),
        onclick: (e) => { e.stopPropagation(); setTheme(value); },
      }, label)));
  }

  if (themeQuery) themeQuery.addEventListener('change', () => { if (themePref() === 'auto') applyTheme('auto'); });
  document.getElementById('theme-switch-footer')?.replaceChildren(themeSwitch());

  // ---------- accounts
  const nav = document.getElementById('nav');
  let navFor;
  function renderNav() {
    const who = S.me ? `${S.me.id}` : '';
    if (!nav || navFor === who) return; // re-rendering would close an open menu
    navFor = who;
    const initials = (name) => name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    nav.replaceChildren(...(S.me
      ? [
        h('a', { class: 'btn btn-small btn-primary', href: '/new' }, 'New tournament'),
        h('details', { class: 'menu' },
          h('summary', { class: 'avatar', title: S.me.email, 'aria-label': 'Account menu' }, initials(S.me.name)),
          h('div', { class: 'menu-panel' },
            h('div', { class: 'menu-head' }, h('strong', {}, S.me.name), h('div', { class: 'muted small' }, S.me.email)),
            h('a', { href: '/', onclick: closeMenu }, 'My tournaments'),
            S.me.isAdmin ? h('a', { href: '/admin', onclick: closeMenu }, 'Admin · users') : null,
            h('button', { onclick: signOut }, 'Sign out'),
            h('div', { class: 'menu-theme' }, 'Theme', themeSwitch()))),
      ]
      : [
        h('a', { class: 'nav-link', href: '/signin' }, 'Sign in'),
        h('a', { class: 'btn btn-small btn-primary', href: '/signup' }, 'Sign up'),
      ]).filter(Boolean));
  }

  function closeMenu(e) {
    e.target.closest('details').removeAttribute('open');
  }

  async function signOut() {
    try { await api('POST', '/auth/logout', {}); } catch { /* signed out locally anyway */ }
    S.me = null;
    S.t = null;
    S.members = null;
    toast('Signed out');
    navigate('/');
  }

  const safeNext = (next) => (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/');

  function viewAuth() {
    const signup = S.route.name === 'signup';
    document.title = `${signup ? 'Sign up' : 'Sign in'} · Tonament`;
    const next = safeNext(S.route.next);
    if (S.me) {
      setTimeout(() => { navigate(next); });
      return loading();
    }
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, signup ? 'Create account' : 'Sign in');
    const form = h('form', {
      class: 'card form auth-card',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          const body = Object.fromEntries(new FormData(form));
          const { user } = await api('POST', signup ? '/auth/signup' : '/auth/login', body);
          S.me = user;
          S.t = null; // reload tournaments with this user's access
          toast(signup ? `Welcome, ${user.name}!` : `Signed in as ${user.name}`);
          navigate(next);
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      },
    },
    h('h1', {}, signup ? 'Create your account' : 'Sign in'),
    h('p', { class: 'muted' }, signup
      ? 'Run your own tournaments, and score matches you\'ve been added to.'
      : 'Welcome back.'),
    signup ? field('Your name', h('input', { name: 'name', required: true, maxlength: 60, autocomplete: 'name' })) : null,
    field('Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email', value: S.route.email || null })),
    field('Password', h('input', {
      name: 'password', type: 'password', required: true, minlength: signup ? 8 : null,
      autocomplete: signup ? 'new-password' : 'current-password',
    }), null, signup ? 'At least 8 characters.' : null),
    signup ? null : h('p', { class: 'small', style: 'margin:-6px 0 0' },
      h('a', {
        href: '/forgot',
        onclick: (e) => {
          e.preventDefault();
          const email = form.querySelector('input[name=email]').value;
          navigate(`/forgot${email ? `?email=${encodeURIComponent(email)}` : ''}`);
        },
      }, 'Forgot password?')),
    btn,
    h('p', { class: 'center small', style: 'margin:0' },
      signup ? 'Already have an account? ' : 'New to Tonament? ',
      h('a', { href: `/${signup ? 'signin' : 'signup'}?next=${encodeURIComponent(next)}` }, signup ? 'Sign in' : 'Create an account')));
    return form;
  }

  function viewForgot() {
    document.title = 'Reset password · Tonament';
    if (!S.emailEnabled) {
      return h('div', { class: 'card auth-card' },
        h('h1', {}, 'Forgot your password?'),
        h('p', { class: 'muted' }, 'Password reset by email isn\'t set up on this site yet. Please contact the site admin.'),
        h('a', { class: 'btn', href: '/signin' }, 'Back to sign in'));
    }
    if (S.route.sent) {
      return h('div', { class: 'card auth-card' },
        h('h1', {}, 'Check your email'),
        h('p', {}, 'If an account exists for ', h('strong', {}, S.route.email), ', we\'ve sent a link to reset its password. It works once and expires in 1 hour.'),
        h('p', { class: 'muted small' }, 'Nothing there? Check your spam folder, or try again in a minute.'),
        h('a', { class: 'btn', href: '/signin' }, 'Back to sign in'));
    }
    const input = h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email', value: S.route.email || null });
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Send reset link');
    return h('form', {
      class: 'card form auth-card',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          await api('POST', '/auth/forgot', { email: input.value });
          S.route.email = input.value;
          S.route.sent = true;
          render();
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      },
    },
    h('h1', {}, 'Forgot your password?'),
    h('p', { class: 'muted' }, 'Enter your email and we\'ll send you a link to choose a new one.'),
    field('Email', input),
    btn,
    h('p', { class: 'center small', style: 'margin:0' }, h('a', { href: '/signin' }, 'Back to sign in')));
  }

  function viewReset() {
    document.title = 'Choose a new password · Tonament';
    if (!S.route.token) {
      return h('div', { class: 'card auth-card' },
        h('h1', {}, 'Link not valid'),
        h('p', { class: 'muted' }, 'This reset link is incomplete. Open the link from your email again, or request a new one.'),
        h('a', { class: 'btn', href: '/forgot' }, 'Request a new link'));
    }
    const pw = h('input', { name: 'password', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
    const confirmPw = h('input', { name: 'confirm', type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Set new password');
    return h('form', {
      class: 'card form auth-card',
      onsubmit: async (e) => {
        e.preventDefault();
        if (pw.value !== confirmPw.value) {
          toast('The passwords don\'t match', true);
          return;
        }
        btn.disabled = true;
        try {
          const { user } = await api('POST', '/auth/reset', { token: S.route.token, password: pw.value });
          S.me = user;
          S.t = null;
          toast('Password changed — you\'re signed in');
          navigate('/');
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      },
    },
    h('h1', {}, 'Choose a new password'),
    h('p', { class: 'muted' }, 'You\'ll be signed out on your other devices.'),
    field('New password', pw, null, 'At least 8 characters.'),
    field('Confirm new password', confirmPw),
    btn);
  }

  const PLAN_LABELS = { pass: 'Event Pass', club: 'Club', open: 'Open', championship: 'Championship' };

  function viewAdmin() {
    document.title = 'Admin · Tonament';
    if (!S.me || !S.me.isAdmin) return errorView('Site admins only.');
    const users = S.route.users;
    const counts = (S.interest && S.interest.counts) || {};
    const requested = S.sports.filter((s) => s.status !== 'live').map((s) => ({ ...s, n: counts[s.id] || 0 })).sort((a, b) => b.n - a.n);
    const pay = S.route.payments;
    const statusPill = (st) => pill(st === 'paid' ? 'done' : st === 'failed' ? 'withdrawn' : '', st === 'created' ? 'Started' : st);
    return [h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, 'Payments'),
        pay ? h('span', { class: 'muted small' }, `${money(pay.revenue.total)} from ${pay.revenue.count} payment${pay.revenue.count === 1 ? '' : 's'}`) : null),
      !pay ? loading()
        : !pay.payments.length ? empty('No payments yet.')
          : h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, ['Date', 'Tournament', 'Paid by', 'For', 'Amount', 'Status', 'Payment ID'].map((c, i) => h('th', { class: i === 4 ? 'num' : '' }, c)))),
            h('tbody', {}, pay.payments.map((p) => h('tr', {},
              h('td', {}, new Date(p.paidAt || p.createdAt).toLocaleDateString()),
              h('td', { class: 'name' }, p.tournamentId ? h('a', { href: `/t/${p.tournamentId}/team` }, p.tournamentName) : p.tournamentName),
              h('td', {}, p.email || '—'),
              h('td', {}, p.kind === 'entry' ? `Entry · ${p.eventName || ''}${p.player ? ` (${p.player})` : ''}` : PLAN_LABELS[p.tier || 'pass'] || p.tier),
              h('td', { class: 'num' }, money(p.amount)),
              h('td', {}, statusPill(p.status)),
              h('td', { class: 'small' }, p.paymentId || '—'))))))),
    h('div', { class: 'card' },
      h('h2', {}, 'Most requested sports'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Sport'), h('th', {}, 'Status'), h('th', { class: 'num' }, 'Requests'))),
        h('tbody', {}, requested.map((s) => h('tr', {},
          h('td', { class: 'name' }, s.name),
          h('td', {}, s.status === 'later' ? 'Later' : 'Soon'),
          h('td', { class: 'num' }, s.n))))))),
    h('div', { class: 'card' },
      h('h1', {}, 'Users'),
      users == null ? loading() : h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Name', 'Email', 'Joined', 'Owns', 'Helps on'].map((c, i) => h('th', { class: i > 2 ? 'num' : '' }, c)))),
        h('tbody', {}, users.map((u) => h('tr', {},
          h('td', { class: 'name' }, u.name, u.isAdmin ? [' ', pill('org', 'Admin')] : null),
          h('td', {}, u.email),
          h('td', {}, new Date(u.createdAt).toLocaleDateString()),
          h('td', { class: 'num' }, u.owned),
          h('td', { class: 'num' }, u.helping)))))),
      users ? h('p', { class: 'muted small', style: 'margin:8px 0 0' }, `${users.length} user${users.length === 1 ? '' : 's'}`) : null)];
  }

  // ---------- navigation: real URLs (/t/<id>/courts), no page reloads
  // The app's own pages; anything else (/pricing, /terms, …) is a normal link.
  const APP_PATH = /^\/(?:$|t\/|new$|signin$|signup$|forgot$|reset$|admin$)/;
  function navigate(url, { replace = false } = {}) {
    const same = url === location.pathname + location.search;
    history[replace || same ? 'replaceState' : 'pushState'](null, '', url);
    route();
  }
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !APP_PATH.test(url.pathname) || url.hash) return;
    e.preventDefault();
    navigate(url.pathname + url.search);
  });
  window.addEventListener('popstate', route);

  // ---------- boot
  // Old links (#/t/<id>, and share-key and password-reset links, which keep
  // their secret in the # part so it never reaches the server) become paths.
  if (location.hash.startsWith('#/')) history.replaceState(null, '', location.hash.slice(1));
  Promise.all([
    api('GET', '/sports').catch(() => []),
    api('GET', '/auth/me').catch(() => ({ user: null })),
    api('GET', '/billing/config').catch(() => ({ enabled: false })),
  ]).then(([list, me, billingCfg]) => {
    S.billing = billingCfg;
    S.sports = list;
    S.me = me.user;
    S.emailEnabled = Boolean(me.emailEnabled);
    route();
  });
})();
