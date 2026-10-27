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
  // A labelled group of choices (a <label> can't wrap several radios).
  const groupField = (label, control, cls, hint) =>
    h('div', { class: `field ${cls || ''}`, role: 'group', 'aria-label': label }, h('span', { class: 'label' }, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
  // A line icon from /icons.svg, drawn in the text colour.
  function icon(name) {
    const el = h('span', { class: 'icon', 'aria-hidden': 'true' });
    el.innerHTML = `<svg viewBox="0 0 24 24" focusable="false"><use href="/icons.svg#${name}"></use></svg>`;
    return el;
  }
  // Tappable choices instead of a dropdown: radios (or checkboxes) styled as
  // pills, or as icon tiles, so FormData and form[name].value read them like a
  // select. options: [{ value, label, icon?, hint?, disabled? }]
  function choiceGroup({ name, options, value, onchange, tiles = false, multiple = false, label }) {
    const on = (o) => (multiple ? (value || []).map(String).includes(String(o.value)) : String(o.value) === String(value ?? ''));
    return h('div', { class: `choice-group${tiles ? ' tiles' : ''}`, role: multiple ? 'group' : 'radiogroup', 'aria-label': label || null },
      options.map((o) => h('label', { class: `choice${o.disabled ? ' disabled' : ''}` },
        h('input', { type: multiple ? 'checkbox' : 'radio', name, value: String(o.value), checked: on(o), disabled: o.disabled, onchange }),
        o.icon ? icon(o.icon) : null,
        h('span', { class: 'choice-label' }, o.label),
        o.hint ? h('small', {}, o.hint) : null)));
  }
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
      } else if (parts[0] === 'link') {
        S.route = { name: 'link', token: params.get('token') || (S.route.name === 'link' ? S.route.token : ''), code: params.get('code') || '', state: 'opening' };
        history.replaceState(null, '', '/link'); // keep the token out of history
        render();
        await useLink();
        return;
      } else if (parts[0] === 'groups') {
        if (!S.me) {
          navigate(`/signin?next=${encodeURIComponent(location.pathname)}`, { replace: true });
          return;
        }
        if (parts[1] === 'new') {
          S.route = { name: 'groupNew', host: params.get('host') || null, copy: params.get('copy') || null };
          S.groupDraft = null;
          const copyOf = S.route.copy;
          if (copyOf && !(S.group && S.group.slug === copyOf)) {
            api('GET', gPath(copyOf)).then((g) => { S.group = g; S.groupDraft = null; render(); }).catch(() => {});
          }
          ensureMyOrgs();
        } else {
          S.route = { name: 'groups' };
          S.groupsList = null;
          render();
          S.groupsList = await api('GET', '/me/groups').catch(() => []);
        }
      } else if (parts[0] === 'g' && parts[1]) {
        const slug = parts[1].toLowerCase();
        const join = params.get('join');
        if (parts[2] === 'game' && parts[3]) {
          S.route = { name: 'groupGame', slug, gid: Number(parts[3]) };
          if (!S.groupGame || S.groupGame.id !== S.route.gid) S.groupGame = null;
          render();
          await loadGroupGame();
          return;
        }
        S.route = { name: 'group', slug, tab: params.get('tab') || 'today', join, skip: 0 };
        if (!S.group || S.group.slug !== slug) S.group = null;
        if (join && S.me) {
          try {
            const r = await api('POST', `${gPath(slug)}/join`, { token: join });
            if (!r.already) toast(r.joined ? 'Welcome to the group! Tap "I\'m in" for the next session.' : 'Request sent to the group admins');
          } catch (e) { toast(e.message, true); }
          history.replaceState(null, '', `/g/${slug}`);
          S.route.join = null;
        }
        render();
        await loadGroup();
        return;
      } else if (parts[0] === 'me' && parts[1] === 'profile') {
        if (!S.me) {
          navigate('/signin?next=/me/profile', { replace: true });
          return;
        }
        S.route = { name: 'profile' };
        S.profile = null;
        render();
        await loadProfile();
      } else if (parts[0] === 'academy' && parts[1] === 'new') {
        if (!S.me) {
          navigate('/signin?next=/academy/new', { replace: true });
          return;
        }
        S.route = { name: 'orgNew' };
      } else if (/^@[a-z0-9-]{3,30}$/.test(parts[0] || '') && parts[1] === 'edit') {
        const slug = parts[0].slice(1);
        if (!S.me) {
          navigate(`/signin?next=/@${slug}/edit`, { replace: true });
          return;
        }
        S.route = { name: 'org', slug };
        if (!S.org || S.org.slug !== slug) {
          S.org = null;
          render();
          try {
            S.org = await api('GET', orgPath(slug));
          } catch (e) {
            S.error = e.message;
            S.errorCode = e.code;
          }
        }
      } else if (parts[0] === 'admin') {
        const tab = ADMIN_TABS.some(([id]) => id === params.get('tab')) ? params.get('tab') : 'overview';
        S.route = { name: 'admin', tab };
        render();
        await adminLoad(tab);
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
    if (['new', 'tournament', 'orgNew', 'org', 'profile', 'groupNew'].includes(S.route.name)) ensurePlaces(); // city suggestions
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
  // Open/closed sections (<details>) stay as the person left them when the
  // page redraws with live data — the group page refreshes every few seconds.
  // Keyed by page and summary text (numbers ignored: "Check in for others (3)").
  // Settings panels (data-panel) keep their own state.
  const detailsOpen = new Map();
  const detailsKey = (d) => `${location.pathname}|${d.dataset.key || (d.querySelector(':scope > summary')?.textContent || '').replace(/\d+/g, '#').trim()}`;
  app.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.tagName === 'DETAILS' && !d.hasAttribute('data-panel') && !keepingDetails) detailsOpen.set(detailsKey(d), d.open);
  }, true);
  let keepingDetails = false;
  function keepDetails() {
    keepingDetails = true;
    for (const d of app.querySelectorAll('details:not([data-panel])')) {
      const want = detailsOpen.get(detailsKey(d));
      if (want !== undefined && d.open !== want) d.open = want;
    }
    // toggle events fire after this; don't record our own restoring.
    setTimeout(() => { keepingDetails = false; }, 0);
    keepTabs();
  }

  // Tab rows wider than the phone scroll sideways: keep where they were
  // scrolled through redraws (else the selected tab), and fade the edge
  // that has more tabs past it.
  const tabsScroll = new Map();
  function keepTabs() {
    app.querySelectorAll('.tabs').forEach((row, i) => {
      const key = `${location.pathname}|${i}`;
      const fade = () => {
        row.classList.toggle('more-right', row.scrollLeft + row.clientWidth < row.scrollWidth - 2);
        row.classList.toggle('more-left', row.scrollLeft > 2);
      };
      if (tabsScroll.has(key)) row.scrollLeft = tabsScroll.get(key);
      else {
        const active = row.querySelector('.active');
        if (active && active.offsetLeft + active.offsetWidth > row.clientWidth) row.scrollLeft = active.offsetLeft - 24;
      }
      fade();
      row.addEventListener('scroll', () => { tabsScroll.set(key, row.scrollLeft); fade(); }, { passive: true });
    });
  }

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
    else if (S.route.name === 'link') view = viewLink();
    else if (S.route.name === 'admin') view = viewAdmin();
    else if (S.route.name === 'orgNew') view = viewOrgNew();
    else if (S.route.name === 'profile') view = viewProfile();
    else if (S.route.name === 'groups') view = viewGroups();
    else if (S.route.name === 'groupNew') view = viewGroupNew();
    else if (S.route.name === 'group') view = viewGroup();
    else if (S.route.name === 'groupGame') view = viewGroupGame();
    else if (S.route.name === 'org') view = viewOrgEdit();
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
    keepDetails();
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
  // ---------- home hero: a slider through what Tonament does best.
  // All slides sit in one grid cell (so the hero never changes height) and
  // only the active one shows. It moves on every 7 s, pauses on hover or
  // focus, stops for good once someone picks a slide, and never moves for
  // people who'd rather not see motion. Swipe on phones.
  const HERO_MS = 7000;
  let heroTimer = null;
  const heroReduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function heroShow(root) {
    root.querySelectorAll('.hero-slide').forEach((el, k) => {
      const on = k === S.heroSlide;
      el.classList.toggle('active', on);
      el.setAttribute('aria-hidden', String(!on));
      el.inert = !on;
    });
    root.querySelectorAll('.hero-dots button').forEach((b, k) => b.setAttribute('aria-current', String(k === S.heroSlide)));
  }
  function heroGo(i, byHand = false) {
    const root = app.querySelector('.hero-slider');
    if (!root) return;
    const n = root.querySelectorAll('.hero-slide').length;
    S.heroSlide = ((i % n) + n) % n;
    if (byHand) S.heroStopped = true;
    heroShow(root);
  }
  function heroTick() {
    clearTimeout(heroTimer);
    heroTimer = setTimeout(() => {
      const root = app.querySelector('.hero-slider');
      if (root && !S.heroStopped && !document.hidden && !heroReduced() && !root.matches(':hover, :focus-within')) heroGo((S.heroSlide || 0) + 1);
      heroTick();
    }, HERO_MS);
  }

  function heroSlider(explore) {
    if (S.heroSlide == null) S.heroSlide = 0;
    if (!heroTimer) heroTick();
    const join = (path) => (S.me ? path : `/signup?next=${encodeURIComponent(path)}`);
    const shot = (src, alt, cls = 'phone') => h('div', { class: `hero-visual ${cls}` }, h('img', { src, alt, loading: 'lazy', width: cls === 'tv' ? 640 : 390 }));
    const sportCount = liveSports().length || 13;
    const slides = [
      {
        label: 'Tournaments',
        eyebrow: ['One platform.', 'Every sport.', h('b', {}, 'Every tournament.')],
        title: ['Run your tournament. ', 'Score it live.'],
        lead: 'Entries and UPI fees, groups, a league, a knockout bracket and an order of play across your courts — and everyone follows every point on their phone.',
        chips: ['League + Knockout', 'Live point-by-point scoring', 'Auto standings & bracket'],
        actions: [
          h('a', { class: 'btn btn-primary btn-lg', href: S.me ? '/new' : '/signup' }, S.me ? 'Create tournament' : 'Get started — it\'s free'),
          h('a', { class: 'btn btn-lg btn-ghost', href: '/', onclick: explore }, 'Explore tournaments'),
        ],
        visual: shot('/guide/umpire-dark.jpg', 'An umpire scoring a badminton match point by point'),
      },
      {
        label: 'Groups',
        eyebrow: ['Groups', h('b', {}, 'Your daily games')],
        title: ['Your daily games, ', 'sorted.'],
        lead: 'One link in the group chat. Tap "I\'m in" and say when you\'re coming, get fair teams at the court, score live or add it at the end — and a leaderboard settles who\'s best.',
        chips: ['I\'m in + coming at', 'Fair games', 'No score arguments', 'Group leaderboard'],
        actions: [
          h('a', { class: 'btn btn-primary btn-lg', href: join('/groups/new') }, 'Start a group'),
          h('a', { class: 'btn btn-lg btn-ghost', href: '/features#groups' }, 'How groups work'),
        ],
        visual: shot('/guide/group-rsvp-dark.jpg', 'A group session: I\'m in, coming at 7:30 pm, and who else is coming', 'card'),
      },
      {
        label: 'Venue display',
        eyebrow: ['On the day', h('b', {}, 'The big screen')],
        title: ['Your venue, ', 'on the big screen.'],
        lead: 'Courts, live scores, who\'s up next and the standings on any TV or projector — just open a link. No app, no cables, no whiteboard.',
        chips: ['Live courts', 'Up next', 'Standings', 'Your logo and sponsors'],
        actions: [
          h('a', { class: 'btn btn-primary btn-lg', href: S.me ? '/new' : '/signup' }, S.me ? 'Create tournament' : 'Get started — it\'s free'),
          h('a', { class: 'btn btn-lg btn-ghost', href: '/features' }, 'All features'),
        ],
        visual: shot('/guide/display.jpg', 'The venue display: courts with live scores, up next and standings', 'tv'),
      },
      {
        label: 'Every sport',
        eyebrow: [`${sportCount} sports`, h('b', {}, 'Each with its own rules')],
        title: ['Every sport. ', 'Its own rules.'],
        lead: 'Badminton rally scoring, pickleball side-out, tennis tie-breaks, snooker ball by ball, carrom a board at a time — score live, or just enter the result at the end.',
        chips: ['Scored live or at the end', 'Serve and side called for you', 'Singles, doubles and teams'],
        actions: [
          h('a', { class: 'btn btn-primary btn-lg', href: '/sports' }, 'See all sports'),
          h('a', { class: 'btn btn-lg btn-ghost', href: '/rankings' }, 'Player rankings'),
        ],
        visual: h('div', { class: 'hero-visual sports' }, liveSports().map((s) => h('a', { href: `/${s.id}`, title: s.name }, icon(s.id), h('span', {}, s.name)))),
      },
      {
        label: 'Venues & academies',
        eyebrow: ['Venues & academies', h('b', {}, 'Fill your courts')],
        title: ['Daily slots, ', 'by level.'],
        lead: 'Post your slots — Beginners at 6, Intermediates at 7. Players find them on your page and join in one tap, and you see who actually turned up. For academies, it\'s your batch register.',
        chips: ['Your own page', 'Beginner · Intermediate · Advanced', 'Attendance'],
        actions: [
          h('a', { class: 'btn btn-primary btn-lg', href: join('/academy/new') }, 'Create your venue page'),
          h('a', { class: 'btn btn-lg btn-ghost', href: '/pricing' }, 'Pricing'),
        ],
        visual: shot('/guide/venue-slots-dark.jpg', 'A venue page listing daily slots by level with how many are going'),
      },
    ];
    const n = slides.length;
    let x0 = null;
    const root = h('section', {
      class: 'hero hero-slider',
      'aria-roledescription': 'carousel',
      'aria-label': 'What Tonament does',
      onpointerdown: (e) => { x0 = e.pointerType === 'mouse' ? null : e.clientX; },
      onpointerup: (e) => {
        if (x0 == null) return;
        const dx = e.clientX - x0;
        x0 = null;
        if (Math.abs(dx) > 50) heroGo(S.heroSlide + (dx < 0 ? 1 : -1), true);
      },
      onkeydown: (e) => {
        if (e.target.closest('.hero-dots') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          e.preventDefault();
          heroGo(S.heroSlide + (e.key === 'ArrowRight' ? 1 : -1), true);
          root.querySelector('.hero-dots [aria-current="true"]')?.focus();
        }
      },
    },
    h('div', { class: 'hero-track' }, slides.map((s, k) => h('div', {
      class: `hero-slide${k === S.heroSlide ? ' active' : ''}`,
      role: 'group', 'aria-roledescription': 'slide', 'aria-label': `${k + 1} of ${n}: ${s.label}`,
      'aria-hidden': String(k !== S.heroSlide), inert: k === S.heroSlide ? null : true,
    },
    h('div', { class: 'hero-text' },
      h('p', { class: 'eyebrow' }, s.eyebrow.map((x, i) => [i ? h('br') : null, x])),
      // Only the first slide's headline is the page's h1.
      h(k ? 'h2' : 'h1', { class: 'hero-title' }, s.title[0], h('span', { class: 'accent' }, s.title[1])),
      h('p', { class: 'lead' }, s.lead),
      h('ul', { class: 'features' }, s.chips.map((x) => h('li', {}, x))),
      h('div', { class: 'actions' }, s.actions)),
    s.visual))),
    h('div', { class: 'hero-nav' },
      h('button', { class: 'hero-arrow', type: 'button', 'aria-label': 'Previous', onclick: () => heroGo(S.heroSlide - 1, true) }, '‹'),
      h('div', { class: 'hero-dots', role: 'group', 'aria-label': 'Choose a slide' }, slides.map((s, k) => h('button', {
        type: 'button', 'aria-label': s.label, 'aria-current': String(k === S.heroSlide), onclick: () => heroGo(k, true),
      }, h('span', { class: 'hero-dot-label' }, s.label)))),
      h('button', { class: 'hero-arrow', type: 'button', 'aria-label': 'Next', onclick: () => heroGo(S.heroSlide + 1, true) }, '›')));
    return root;
  }

  function viewHome() {
    document.title = 'Tonament — One platform. Every sport. Every tournament.';
    const explore = (e) => {
      e.preventDefault();
      document.getElementById('all-tournaments')?.scrollIntoView({ behavior: 'smooth' });
    };
    return [
      heroSlider(explore),
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
        choiceGroup({
          name: 'format', label: 'Format', value: v.format, tiles: true,
          options: FORMATS.map(([value, label, desc]) => ({ value, label, icon: value, hint: desc })),
          onchange: (e) => syncFormat(e.target.form),
        })),
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
      scoringFields(sport, v.scoring, v.leagueDraws),
    ];
  }

  // The sport's own scoring settings (from its rules module).
  // League matches can instead be exactly 2 games, where 1-1 is a draw.
  function scoringFields(sport, scoring, leagueDraws = false) {
    const unit = sportUnit(sport.id).toLowerCase();
    return h('fieldset', { class: 'scoring-set' }, h('legend', {}, `${sport.name} scoring`),
      h('div', { class: 'scoring-grid' }, sport.fields.map((f) => (f.type === 'select'
        ? groupField(f.label, choiceGroup({ name: `scoring.${f.key}`, value: scoring[f.key], options: f.options, label: f.label }), null, f.hint)
        : field(f.label, h('input', { type: 'number', name: `scoring.${f.key}`, min: f.min, max: f.max, value: scoring[f.key], required: true }), null, f.hint)))),
      groupField('League matches', choiceGroup({
        name: 'leagueDraws',
        value: leagueDraws ? '1' : '',
        label: 'League matches',
        options: [{ value: '', label: 'Always a winner' }, { value: '1', label: `2 ${unit}s — draws allowed` }],
      }), 'league-field',
      `With draws, ${unit} 1 each is a draw. Group tables then rank on points: win 2, draw 1, loss 0. Knockout matches keep the length above.`));
  }

  // A select of standard values with "Custom…" revealing a text box.
  function choiceField(label, name, options, value) {
    const custom = value && !options.includes(value);
    const box = h('input', { name: `${name}Custom`, maxlength: 30, value: custom ? value : '', placeholder: `Custom ${label.toLowerCase()}`, 'aria-label': `Custom ${label.toLowerCase()}`, hidden: !custom });
    const pills = choiceGroup({
      name: `${name}Choice`,
      label,
      value: custom ? '__custom' : value || options[0],
      options: [...options.map((o) => ({ value: o, label: o })), { value: '__custom', label: 'Custom…' }],
      onchange: (e) => { box.hidden = e.target.value !== '__custom'; if (!box.hidden) box.focus(); },
    });
    return groupField(label, h('div', { class: 'stack' }, pills, box));
  }
  const readChoice = (fd, name) => (fd.get(`${name}Choice`) === '__custom' ? (fd.get(`${name}Custom`) || '').trim() || 'Open' : fd.get(`${name}Choice`));

  // What an event is: type, age group, level, optional name.
  function categoryFields(v, sport) {
    const type = v.discipline === 'any' ? 'any' : `${v.gender}-${v.discipline}`;
    const types = eventTypes(sport);
    return h('fieldset', { class: 'details-set' }, h('legend', {}, 'Event'),
      h('div', { class: 'grid-2' },
        groupField('Type', choiceGroup({ name: 'type', value: type, label: 'Type', options: types.map(([value, label]) => ({ value, label, icon: typeIcon(value) })) })),
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

  // The icon for an event type ("men-singles", "mixed-doubles", "any", …).
  const typeIcon = (type) => {
    if (type === 'any') return 'doubles';
    const [gender, discipline] = type.split('-');
    return discipline === 'doubles' && gender === 'mixed' ? 'mixed' : discipline;
  };
  // Radio names for controls that appear once per row (several rows in one form).
  let pickId = 0;

  // Standard values plus "Custom…", read with .read(); not tied to form field names.
  function pickControl(label, options, value, onchange) {
    const custom = value && !options.includes(value);
    const box = h('input', {
      class: 'pick-custom', maxlength: 30, value: custom ? value : '', placeholder: `Custom ${label.toLowerCase()}`,
      'aria-label': `Custom ${label.toLowerCase()}`, hidden: !custom, oninput: onchange,
    });
    const pills = choiceGroup({
      name: `pick-${++pickId}`,
      label,
      value: custom ? '__custom' : value || options[0],
      options: [...options.map((o) => ({ value: o, label: o })), { value: '__custom', label: 'Custom…' }],
      onchange: (e) => {
        box.hidden = e.target.value !== '__custom';
        if (!box.hidden) box.focus();
        onchange();
      },
    });
    const wrap = h('div', { class: 'stack' }, pills, box);
    wrap.read = () => {
      const v = pills.querySelector('input:checked')?.value || options[0];
      return v === '__custom' ? box.value.trim() || 'Open' : v;
    };
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
      const type = choiceGroup({
        name: `type-${++pickId}`, label: 'Event type', value: typeOf(v), onchange: refresh,
        options: types.map(([value, label]) => ({ value, label, icon: typeIcon(value) })),
      });
      const age = pickControl('Age group', CAT.agesFor(sport), v.age, refresh);
      const level = pickControl('Level', CAT.levelsFor(sport), v.level, refresh);
      row.read = () => ({ ...fromType(type.querySelector('input:checked')?.value || types[0][0]), age: age.read(), level: level.read() });
      row.preview = h('div', { class: 'ev-preview', 'aria-live': 'polite' });
      row.append(
        groupField('Event', type, 'ev-type'),
        groupField('Age group', age, 'ev-age'),
        groupField('Level', level, 'ev-level'),
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
    const league = form.querySelector('.league-field');
    if (league) league.hidden = fmt === 'knockout';
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
      leagueDraws: fd.get('leagueDraws') === '1',
    };
  }

  // New tournament in three quick steps: sport, events, name and date.
  // Everything else starts from sensible defaults and is set up afterwards
  // from the checklist on the tournament page. The draft lives in S so a
  // redraw never loses it.
  function viewNew() {
    document.title = 'New tournament · Tonament';
    const live = liveSports();
    if (!live.length) return loading();
    const d = (S.newDraft ||= { step: 1, sport: null, types: null, custom: false, events: null, name: '', startsOn: '', startTime: '' });
    const sport = live.find((x) => x.id === d.sport);
    if (!sport) d.step = 1;
    const go = (step) => { d.step = step; render(); window.scrollTo(0, 0); };
    const presets = sport ? CAT.presetsFor(sport.id) : [];
    if (sport && !d.types) d.types = [typeOf(presets[0])];
    const chosen = () => (d.custom ? d.events || [] : d.types.map((type) => ({ ...fromType(type), age: 'Open', level: 'Open' })));

    const head = h('div', { class: 'new-head' },
      d.step > 1 ? h('button', { type: 'button', class: 'back-link', onclick: () => go(d.step - 1) }, '← Back') : h('span'),
      h('span', { class: 'new-progress', 'aria-label': `Step ${d.step} of 3` }, `Step ${d.step} of 3`,
        h('span', { class: 'dots', 'aria-hidden': 'true' }, [1, 2, 3].map((n) => h('span', { class: n <= d.step ? 'on' : '' })))));

    // 1. Sport: tapping a tile moves on.
    if (d.step === 1) {
      const soon = S.sports.filter((x) => x.status !== 'live');
      return h('div', { class: 'card new-flow' }, head,
        h('h1', {}, 'New tournament'),
        h('h2', {}, 'Which sport?'),
        choiceGroup({
          name: 'sport', label: 'Sport', value: d.sport, tiles: true,
          options: live.map((x) => ({ value: x.id, label: x.name, icon: x.id })),
          onchange: (e) => {
            if (d.sport !== e.target.value) Object.assign(d, { sport: e.target.value, types: null, custom: false, events: null });
            go(2);
          },
        }),
        soon.length ? h('p', { class: 'muted small' }, `Coming soon: ${soon.map((x) => x.name).join(', ')}. `, h('a', { href: '/' }, 'Request yours')) : null);
    }

    // 2. Events: this sport's own list, several at once.
    if (d.step === 2) {
      const next = h('button', { type: 'button', class: 'btn btn-primary btn-lg', disabled: !chosen().length }, 'Next');
      let builder = null;
      const readBuilder = () => {
        const { events, error } = builder.readList();
        if (error) { toast(error, true); return false; }
        d.events = events;
        return true;
      };
      next.onclick = () => { if (!d.custom || readBuilder()) go(3); };
      const quick = choiceGroup({
        name: 'types', label: 'Events', value: d.types, multiple: true, tiles: true,
        options: presets.map((p) => ({ value: typeOf(p), label: p.label, icon: typeIcon(typeOf(p)) })),
        onchange: () => {
          d.types = [...quick.querySelectorAll('input:checked')].map((x) => x.value);
          next.disabled = !d.types.length;
        },
      });
      if (d.custom) builder = eventBuilder(d.events || chosen(), sport.id);
      return h('div', { class: 'card new-flow' }, head,
        h('h2', {}, `Which ${sport.name.toLowerCase()} events?`),
        d.custom
          ? [h('p', { class: 'muted small' }, 'Each event gets its own entries and draw.'), builder]
          : [h('p', { class: 'muted small' }, 'Tap all that apply. Each gets its own entries and draw.'), quick,
            h('button', {
              type: 'button', class: 'link-btn',
              onclick: () => { d.events = chosen(); d.custom = true; render(); },
            }, 'Age groups, levels or more events…')],
        h('div', { class: 'actions' }, next));
    }

    // 3. Name and date, then create.
    const year = new Date().getFullYear();
    const form = h('form', {
      class: 'card new-flow form',
      onsubmit: async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        const fd = new FormData(form);
        Object.assign(d, { name: fd.get('name'), startsOn: fd.get('startsOn') || '', startTime: fd.get('startTime') || '' });
        try {
          const { id } = await api('POST', '/tournaments', {
            sport: sport.id,
            name: d.name,
            startsOn: d.startsOn,
            startTime: d.startTime,
            country: REGIONS.defaultCountry,
            format: 'league_knockout',
            groupSize: 4,
            qualifiers: 2,
            scoring: sport.defaults,
            events: chosen(),
          });
          S.newDraft = null;
          toast('Tournament created — finish setting it up below');
          navigate(`/t/${id}`);
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      },
    }, head,
    h('h2', {}, 'Name and date'),
    h('p', { class: 'muted small' }, `${sport.name} · ${chosen().map((x) => CAT.eventName(x)).join(', ')}`),
    field('Tournament name', h('input', { name: 'name', required: true, maxlength: 80, value: d.name, placeholder: `e.g. ${sport.name} Open ${year}`, autocomplete: 'off', oninput: (e) => { d.name = e.target.value; } })),
    h('div', { class: 'grid-2' },
      field('Date', h('input', { type: 'date', name: 'startsOn', value: d.startsOn, oninput: (e) => { d.startsOn = e.target.value; } }), null, 'Helps players find it. You can change it later.'),
      field('Start time (optional)', h('input', { type: 'time', name: 'startTime', value: d.startTime, oninput: (e) => { d.startTime = e.target.value; } }))),
    h('p', { class: 'muted small' }, 'Venue, format, entry fees, prizes and courts come next — on your tournament page, whenever you\'re ready.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Create tournament')));
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
    if (t.courts) tabs.push({ id: 'courts', label: `${CAT.courtWord(t.sport.id)}s` });
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
          tt.org && tt.org.public ? h('a', { class: 't-byline', href: `/@${tt.org.slug}` }, `by ${tt.org.name}`) : null,
          tt.visibility !== 'private' ? h('button', { class: 'btn btn-small btn-ghost t-share', onclick: () => shareTournament(tt) }, 'Share') : null),
        h('p', { class: 'muted small' },
          [fmtSchedule(tt), placeLine(tt.venue, tt.location.city), tt.sport.name, multiEvent(tt) ? `${tt.events.length} events` : t.formatName, statusLine]
            .filter(Boolean).join(' · '), '  ', connDot())),
      roleBar(t),
      tt.visibility === 'private' && !(active === 'entries' && checklistOn(t)) ? visibilityBanner(t) : null,
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

  // ----- setup checklist: what's left before the tournament is ready.
  const checklistKey = (t) => `tonament:checklist-hidden:${t.id}`;
  function checklistOn(t) {
    if (!t.can.manage || t.tournamentStatus !== 'setup') return false;
    try { return localStorage.getItem(checklistKey(t)) !== '1'; } catch { return true; }
  }

  // Opens a settings panel on this tab and scrolls to it (or to one of its sections).
  function openPanel(t, name, section) {
    S.openPanels.add(`${t.id}:${name}`);
    render();
    const box = document.querySelector(`[data-panel="${name}"]`);
    if (!box) return;
    const legend = section && [...box.querySelectorAll('legend')].find((l) => l.textContent === section);
    (legend || box).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setupChecklist(t) {
    if (!checklistOn(t)) return null;
    const sport = S.sports.find((x) => x.id === t.sport.id);
    const entries = allEntries(t).length;
    const teams = t.events.every((e) => e.discipline === 'team');
    const length = sport && sport.fields[0] && sport.fields[0].options
      ? (sport.fields[0].options.find((o) => String(o.value) === String(t.config.scoring[sport.fields[0].key])) || {}).label
      : null;
    const court = CAT.courtWord(t.sport.id);
    const focusAdd = () => {
      const box = document.querySelector('textarea[name=names]');
      if (box) { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); box.focus({ preventScroll: true }); }
    };
    const items = [
      { label: 'Events', done: true, state: t.events.map((e) => e.name).join(', '), action: ['Edit', () => navigate(tabHref(t, 'events'))] },
      { label: 'Date & time', done: Boolean(t.startsOn), state: fmtSchedule(t) || 'Not set', action: [t.startsOn ? 'Edit' : 'Set up', () => openPanel(t, 'settings', 'When')] },
      { label: 'Venue', done: Boolean(t.venue || t.location.city), state: placeLine(t.venue, t.location.city) || 'Not set', action: [t.venue ? 'Edit' : 'Set up', () => openPanel(t, 'settings', 'Venue')] },
      { label: teams ? 'Teams' : 'Players', done: entries >= 2, state: entries ? `${entries} ${teams ? (entries === 1 ? 'team' : 'teams') : entries === 1 ? 'entry' : 'entries'} so far` : 'None yet — add them, or share the link so they enter themselves', action: ['Add', focusAdd] },
      { label: 'Format & scoring', done: true, state: [t.formatName, length].filter(Boolean).join(' · '), action: ['Change', () => openPanel(t, `event-${t.eventId}`)] },
      { label: 'Entry fee & UPI', optional: true, done: t.events.some((e) => e.fee) || Boolean(t.payment && t.payment.upi), state: t.events.some((e) => e.fee) ? t.events.filter((e) => e.fee).map((e) => `${e.name} ${money(e.fee)}`).join(', ') : 'Free to enter', action: ['Set up', () => openPanel(t, 'settings', 'Entry fees')] },
      { label: 'Prizes', optional: true, done: t.events.some((e) => (e.prizes || []).length), state: t.events.some((e) => (e.prizes || []).length) ? 'Added' : 'None yet', action: ['Set up', () => openPanel(t, `prizes-${t.eventId}`)] },
      { label: `${court}s`, optional: true, done: Boolean(t.courts), state: t.courts ? `${t.courts.names.length} ${court.toLowerCase()}${t.courts.names.length === 1 ? '' : 's'}` : `For an order of play on the day`, action: ['Set up', () => openPanel(t, 'settings', `${court}s`)] },
      { label: 'Publish', done: t.visibility !== 'private', state: t.visibility === 'public' ? 'Public — listed on Tonament' : t.visibility === 'link' ? 'Anyone with the link' : 'Private — only your team can see it', publish: t.visibility === 'private' && t.can.own },
    ];
    const required = items.filter((x) => !x.optional);
    const done = required.filter((x) => x.done).length;
    const hide = () => {
      try { localStorage.setItem(checklistKey(t), '1'); } catch { /* private mode: hides until reload */ }
      render();
    };
    return h('div', { class: 'card checklist' },
      h('div', { class: 'card-head' },
        h('h2', {}, done === required.length ? 'Ready to go ✓' : 'Get your tournament ready'),
        h('button', { class: 'btn btn-small btn-ghost', onclick: hide }, 'Hide')),
      h('p', { class: 'muted small checklist-count' }, `${done} of ${required.length} done`,
        h('span', { class: 'progress' }, h('span', { style: `width:${(done / required.length) * 100}%` }))),
      h('ul', {}, items.map((x) => h('li', { class: `check-row${x.done ? ' done' : ''}${x.optional ? ' optional' : ''}` },
        h('span', { class: 'tick', 'aria-label': x.done ? 'Done' : 'To do' }, x.done ? '✓' : ''),
        h('div', { class: 'check-text' },
          h('strong', {}, x.label, x.optional ? h('small', {}, ' (optional)') : null),
          h('span', { class: 'muted small' }, x.state)),
        x.publish
          ? h('span', { class: 'actions' },
            h('button', { class: 'btn btn-small btn-primary', onclick: () => setVisibility(t, 'public') }, 'Publish'),
            h('button', { class: 'btn btn-small btn-ghost', onclick: () => setVisibility(t, 'link') }, 'Link only'))
          : x.action ? h('button', { class: `btn btn-small${x.done ? ' btn-ghost' : ''}`, onclick: x.action[1] }, x.action[0]) : null))));
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
          t.entries.length > 1 ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => shuffle(t) }, '🔀 Random draw') : null,
          duprTools(t)) : !setup ? duprTools(t) : null),
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
            entryName(e),
            e.contact || e.phone ? h('small', { class: 'contact' }, [e.contact, e.phone].filter(Boolean).join(' · ')) : null,
            e.players ? h('small', { class: 'contact' }, `Players: ${e.players.join(', ')}`) : null,
            e.members && t.can.manage && e.members.some((m) => m.contact)
              ? h('small', { class: 'contact' }, e.members.map((m) => `${m.name}: ${m.contact}`).join(' · '))
              : null,
            h('span', { class: 'entry-tags' }, tags(e), groupLabel(e.group), e.rating != null ? pill('', `DUPR ${e.rating.toFixed(2)}`) : null),
            entryPeople(t, e),
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
    if (!setup) return [paymentsToCheck(t), upgradeCard(t), running ? lateEntryCard(t) : null, venueCard(t), prizesCard(t, [t.event]), list, rankedCard(t), prizeSettingsCard(t), tournamentSettingsCard(t)];
    return [setupChecklist(t), paymentsToCheck(t), upgradeCard(t), venueCard(t), prizesCard(t, [t.event]), addEntriesForm(t, usingCheckIn), soloCard(t), list, startCard(t), eventSettingsCard(t), prizeSettingsCard(t), tournamentSettingsCard(t)];
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
      ? field('Partner\'s email (optional)', h('input', { name: 'partnerEmail', type: 'email', maxlength: 120, autocomplete: 'off' }), 'partner-email-field',
        'Their results and ranking points go on their Tonament profile too. We\'ll let them know.')
      : null,
    duprEntryFields(t, drawn),
    t.event.discipline === 'doubles' && !drawn
      ? h('label', { class: 'check-field' },
        h('input', { type: 'checkbox', name: 'solo', onchange: (e) => syncSolo(e.target.form, e.target.checked) }),
        h('span', {}, h('strong', {}, 'I don\'t have a partner — find me one'),
          h('small', {}, `The organiser pairs you with another player looking for a partner.${fee ? ` You pay half the pair fee (${money(Math.ceil(fee / 2))}).` : ''}`)))
      : null,
    drawn ? h('p', { class: 'hint', style: 'margin:0' }, `Partners are drawn when the event starts — enter on your own.${fee ? ` You pay half the pair fee (${money(Math.ceil(fee / 2))}).` : ''}`) : null,
    t.event.gender === 'mixed' && t.event.discipline === 'doubles'
      ? Object.assign(groupField('I\'m playing as', choiceGroup({ name: 'side', label: 'I\'m playing as', value: 'man', options: [{ value: 'man', label: 'Man' }, { value: 'woman', label: 'Woman' }] }), 'side-field'), { hidden: !drawn })
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

  // Pickleball events that ask for DUPR IDs: yours (from your profile) and your partner's.
  function duprEntryFields(t, drawn) {
    const mode = t.config.dupr || 'off';
    if (t.sport.id !== 'pickleball' || mode === 'off') return null;
    if (!S.profile && !S.profileLoading) {
      S.profileLoading = true;
      api('GET', '/me/profile').then((p) => { S.profile = p; render(); }, () => {}).finally(() => { S.profileLoading = false; });
    }
    const mine = S.profile && S.profile.dupr ? S.profile.dupr.id : '';
    const required = mode === 'required';
    const { duprMin: lo, duprMax: hi } = t.config;
    const range = lo != null || hi != null ? ` This event is for DUPR ${lo != null && hi != null ? `${lo.toFixed(2)}–${hi.toFixed(2)}` : lo != null ? `${lo.toFixed(2)}+` : `up to ${hi.toFixed(2)}`} (${t.event.discipline === 'singles' ? 'singles' : 'doubles'} rating from your profile).` : '';
    const pair = t.event.discipline === 'doubles' && !drawn;
    return h('div', { class: 'grid-2' },
      field(`Your DUPR ID${required ? '' : ' (optional)'}`, h('input', { name: 'duprId', maxlength: 12, value: mine || '', required: required || null, autocomplete: 'off', style: 'text-transform:uppercase' }), null,
        h('span', {}, `Saved to your profile.${range} `, h('a', { href: '/me/profile', target: '_blank', rel: 'noopener' }, 'Your ratings'))),
      pair ? field(`Partner's DUPR ID${required ? '' : ' (optional)'}`, h('input', { name: 'partnerDuprId', maxlength: 12, autocomplete: 'off', style: 'text-transform:uppercase' }), 'partner-dupr-field',
        required ? 'Not needed if their Tonament profile has it.' : null) : null);
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
    if (e.feeStatus === 'refunded') return pill('withdrawn', 'Refunded');
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
        t.venue || L.address || L.city
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
        saveForm(form, async () => { S.t = await api('PATCH', tPath(t), { ...readTournament(form), courts: readCourts(form, t.sport.id), payment: readPayment(form) }, t.id); }, 'Tournament settings saved');
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
      groupField('Hold a place while unpaid', choiceGroup({
        name: 'holdHours', label: 'Hold a place while unpaid', value: String(p.holdHours ?? 48),
        options: [{ value: '24', label: '24 hours' }, { value: '48', label: '48 hours' }, { value: '0', label: 'Until entries close' }],
      }), null,
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
  const defaultCourtName = (i, sport) => `${CAT.courtWord(sport)} ${i + 1}`;
  function courtFields(t) {
    const c = t.courts;
    const names = c ? c.names : [];
    const custom = names.some((n, i) => n !== defaultCourtName(i, t.sport.id));
    return h('fieldset', { class: 'details-set' }, h('legend', {}, `${CAT.courtWord(t.sport.id)}s`),
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

  function readCourts(form, sport) {
    const fd = new FormData(form);
    const named = (fd.get('courtNames') || '').split(',').map((x) => x.trim()).filter(Boolean);
    const count = Number(fd.get('courtCount')) || 0;
    const names = named.length ? named : Array.from({ length: count }, (_, i) => defaultCourtName(i, sport));
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
          const fd = new FormData(form);
          const extra = form.ranked ? { ranked: form.ranked.checked } : {};
          if (t.sport.id === 'pickleball') Object.assign(extra, { dupr: fd.get('dupr') || 'off', duprMin: fd.get('duprMin') || null, duprMax: fd.get('duprMax') || null });
          S.t = await api('PATCH', `${tPath(t)}/events/${t.eventId}`, { ...readCategory(form), ...readFormat(form, sport), ...fee, ...partners, ...extra }, t.id);
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
    t.sport.id === 'pickleball' ? h('fieldset', { class: 'details-set' }, h('legend', {}, 'DUPR'),
      groupField('DUPR ID on entry', choiceGroup({ name: 'dupr', label: 'DUPR ID on entry', value: t.config.dupr || 'off', options: [{ value: 'off', label: 'Off' }, { value: 'ask', label: 'Ask' }, { value: 'required', label: 'Required' }] })),
      h('div', { class: 'grid-2' },
        field('Lowest rating (optional)', h('input', { name: 'duprMin', type: 'number', step: '0.01', min: 2, max: 8, value: t.config.duprMin ?? '', placeholder: 'e.g. 3.0' })),
        field('Highest rating (optional)', h('input', { name: 'duprMax', type: 'number', step: '0.01', min: 2, max: 8, value: t.config.duprMax ?? '', placeholder: 'e.g. 3.49' }))),
      h('p', { class: 'hint', style: 'margin:0' }, 'For level events: players outside the range can\'t enter. Ratings come from players\' Tonament profiles (self-reported until verified with DUPR).')) : null,
    t.event.discipline !== 'team' && t.event.discipline !== 'any' ? h('label', { class: 'check-field' },
      h('input', { type: 'checkbox', name: 'ranked', checked: t.config.ranked !== false }),
      h('span', {}, h('strong', {}, 'Counts for rankings'), h('small', {}, 'Players collect ranking points (public tournaments, 4+ entries). Untick for fun or social events.'))) : null,
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
    h('span', { class: 'muted small' }, ' Show courts, scores and what\'s next on a TV or projector. ',
      t.official ? null : t.whiteLabel ? 'Your logo and sponsors lead, with a small "Powered by Tonament".' : 'Your own logo and sponsors on the display come with the Open plan.'));

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
      return h('div', { class: `dc-side${m.winner && m[s] && m.winner === m[s].id ? ' won' : ''}${sc.single ? ' single' : ''}` },
        h('span', { class: 'dc-serve' }, live && sc.server === s ? h('span', { class: 'serve' }) : null),
        h('span', { class: 'dc-name' }, h('span', {}, nameOf(m[s])), flag ? h('span', { class: 'flag' }, flag) : null),
        live && !sc.single ? h('span', { class: 'dc-games' }, sc.gamesWon[s]) : null,
        live && sc.setGames ? h('span', { class: 'dc-games' }, sc.setGames[s]) : null,
        h('span', { class: 'dc-points' }, live ? (sc.points ? sc.points[s] : cur[s]) : ''));
    };
    const courtCard = (name, m, ev, next) => h('div', { class: `dc-court${m ? (m.rallies ? ' live' : ' called') : ' free'}` },
      h('div', { class: 'dc-court-head' },
        h('span', { class: 'dc-court-name' }, name),
        m ? h('span', { class: 'dc-court-meta' }, [evLabel(ev), m.rallies ? (m.score.single ? m.score.note : `${m.score.unit || 'Game'} ${m.score.games.length}`) : 'Starting'].filter(Boolean).join(' · ')) : h('span', { class: 'dc-court-meta' }, 'Free')),
      m ? [side(m, 'a'), side(m, 'b')]
        : h('div', { class: 'dc-free' }, next ? ['Next: ', h('strong', {}, vsName(next.match))] : 'Nothing waiting'));
    // Courts: the tournament's own, or every match on court now.
    const courts = plan
      ? plan.courts.map((c) => courtCard(c.name, c.match, c.event, c.next))
      : all.filter(({ m }) => m.status === 'live').map(({ m, ev }, i) => courtCard(m.court ? (/^\d/.test(m.court) ? `${CAT.courtWord(t.sport.id)} ${m.court}` : m.court) : `Match ${i + 1}`, m, ev));

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
        if (m.draw) return h('li', {}, h('span', {}, h('strong', {}, m.a.name), ' drew with ', h('strong', {}, m.b.name), evLabel(ev) ? h('small', {}, ev.name) : null), h('span', { class: 'dc-score' }, m.summary));
        const w = m.winner === m.a.id ? m.a : m.b;
        const l = w === m.a ? m.b : m.a;
        // The winner's score first: "21-15, 21-18".
        const score = w === m.a ? m.summary : m.summary.replace(/(\d+)-(\d+)/g, '$2-$1');
        return h('li', {}, h('span', {}, h('strong', {}, w.name), ' beat ', l.name, evLabel(ev) ? h('small', {}, ev.name) : null), h('span', { class: 'dc-score' }, score));
      }))]);
    }
    for (const ev of t.events) {
      if (ev.status === 'league' || (ev.status !== 'setup' && ev.groups.length && ev.status !== 'knockout')) {
        // With draws: drawn and league points columns too.
        const draws = Boolean(ev.config && ev.config.leagueDraws);
        const cols = ['#', 'Name', 'P', 'W', ...(draws ? ['D'] : []), 'L', ...(draws ? ['Pts'] : [])];
        for (const g of ev.groups) {
          panels.push([`${named ? `${ev.name} · ` : ''}${g.name}`, h('table', { class: 'dc-table' },
            h('thead', {}, h('tr', {}, cols.map((c, i) => h('th', { class: i === 1 ? '' : 'num' }, c)))),
            h('tbody', {}, g.standings.map((r) => h('tr', {}, h('td', { class: 'num' }, r.rank), h('td', {}, r.name), h('td', { class: 'num' }, r.played), h('td', { class: 'num' }, r.won),
              draws ? h('td', { class: 'num' }, r.drawn) : null, h('td', { class: 'num' }, r.lost), draws ? h('td', { class: 'num' }, h('strong', {}, r.leaguePoints)) : null))))]);
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
    // And one for Tonament itself: everyone in the hall is a possible organiser
    // (not on plans where the organiser's own branding leads).
    if (!t.whiteLabel) panels.push(['Run your own tournament', h('div', { class: 'dc-promo' },
      h('img', { src: '/brand/logo-white.svg', alt: 'Tonament', width: 190, height: 26 }),
      h('p', {}, 'Entries, draws, courts and live scores like these — on everyone\'s phone.'),
      h('p', { class: 'dc-url' }, 'tonament.com'),
      h('p', { class: 'dc-promo-small' }, `Free for up to 16 entries · ${liveSports().length || 10} sports`))]);
    const panel = panels[(S.displayPanel || 0) % panels.length];

    const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
    // Open and above: the organiser's logo (or name) where Tonament's would be.
    const white = Boolean(t.whiteLabel);
    const orgMark = (cls) => (b && b.logo ? h('img', { class: `${cls} dc-org-logo`, src: b.logo, alt: b.orgName || '' })
      : b && b.orgName ? h('span', { class: `${cls} dc-org-name` }, b.orgName) : null);
    const lead = white ? orgMark('dc-brand') : h('img', { class: 'dc-brand', src: '/brand/logo-white.svg', alt: 'Tonament', width: 190, height: 26 });
    return h('div', { class: `display${white ? ' white-label' : ''}` },
      h('header', { class: 'dc-head' },
        lead,
        h('div', { class: 'dc-title' }, h('h1', {}, t.name),
          h('p', {}, [!white || !lead || (b && b.logo) ? b && b.orgName : null, fmtSchedule(t), placeLine(t.venue, t.location.city)].filter(Boolean).join(' · '))),
        !white && b && b.logo ? h('img', { class: 'dc-logo', src: b.logo, alt: b.orgName || '' }) : null,
        h('div', { class: 'dc-clock' },
          h('strong', {}, new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })),
          h('span', { class: `conn ${S.connected ? 'on' : ''}` }, S.connected ? 'Live' : 'Reconnecting…')),
        h('button', { class: 'btn btn-small btn-ghost dc-fs', onclick: fullscreen, title: 'Full screen (F11)' }, '⛶')),
      !started
        ? h('div', { class: 'dc-wait' }, white ? orgMark('dc-wait-org') : h('img', { src: '/brand/logo-stacked-white.svg', alt: 'Tonament' }), h('h2', {}, 'Starting soon'), h('p', {}, fmtSchedule(t) || 'Play starts once the draw is made.'))
        : h('div', { class: 'dc-body' },
          h('section', { class: 'dc-courts' },
            h('h2', {}, plan ? `${CAT.courtWord(t.sport.id)}s` : CAT.courtWord(t.sport.id) === 'Court' ? 'On court now' : 'Playing now'),
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
      white
        ? h('footer', { class: 'dc-foot dc-foot-white' },
          t.sponsors && t.sponsors.length
            ? h('div', { class: 'dc-sponsors' }, t.sponsors.map((sp) => h('img', { src: sp.url, alt: sp.caption || 'Sponsor' })))
            : h('span'),
          h('p', { class: 'dc-powered' }, 'Powered by', h('img', { src: '/brand/logo-white.svg', alt: 'Tonament', width: 95, height: 13 })))
        : h('footer', { class: 'dc-foot' },
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
      m.court ? (/^\d/.test(m.court) ? `${CAT.courtWord(S.t && S.t.sport && S.t.sport.id)} ${m.court}` : m.court) : null, // "3" -> "Court 3"; "Court 3" or "Centre" as is
    ].filter(Boolean).join(' · ');
  }

  function statusTag(m) {
    if (m.status === 'live') return pill('live', 'Live');
    if (m.walkover) return pill('done', 'Walkover');
    if (m.status === 'done') return pill('done', m.draw ? 'Draw' : 'Final');
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
    const draws = Boolean(t.config.leagueDraws);
    const diffLabel = tennisLike(t) ? 'Gms' : draws ? '±' : 'Pts';
    const cols = ['#', t.event.discipline === 'team' ? 'Team' : 'Player', 'P', 'W', ...(draws ? ['D'] : []), 'L', unitOf(t) === 'Set' ? 'Sets' : 'Games', diffLabel, ...(draws ? ['Pts'] : [])];
    const titles = { [diffLabel]: tennisLike(t) ? 'Game difference' : 'Point difference', ...(draws ? { D: 'Drawn', Pts: 'League points: win 2, draw 1' } : {}) };
    const ranking = draws
      ? 'Ranking: league points (win 2, draw 1, loss 0), then head-to-head, game difference, point difference.'
      : 'Ranking: matches won, then head-to-head, game difference, point difference.';
    return [
      t.format === 'league_knockout' ? h('p', { class: 'muted small' }, `Top ${q} in each group qualify for the knockout (highlighted). ${ranking}`)
        : draws ? h('p', { class: 'muted small' }, `League matches are 2 ${unitOf(t).toLowerCase()}s; 1 each is a draw. ${ranking}`) : null,
      h('div', { class: 'groups-grid' }, t.groups.map((g) => {
        const fixtures = t.matches.filter((m) => m.stage === 'league' && m.group === g.no).sort(byOrder);
        return h('div', { class: 'card' },
          h('h2', {}, g.name),
          h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, cols.map((c, i) => h('th', { class: i === 1 ? '' : 'num', title: titles[c] || null }, c)))),
            h('tbody', {}, g.standings.map((r) => h('tr', { class: qualifying(g, q).has(r.id) ? 'q' : r.withdrawn ? 'out' : '' },
              h('td', { class: 'num' }, r.rank),
              h('td', { class: 'name' }, r.name, r.withdrawn ? [' ', pill('withdrawn', 'Withdrew')] : null),
              h('td', { class: 'num' }, r.played),
              h('td', { class: 'num' }, r.won),
              draws ? h('td', { class: 'num' }, r.drawn) : null,
              h('td', { class: 'num' }, r.lost),
              h('td', { class: 'num' }, `${r.gamesFor}–${r.gamesAgainst}`),
              h('td', { class: 'num' }, signed(r.pointsFor - r.pointsAgainst)),
              draws ? h('td', { class: 'num' }, h('strong', {}, r.leaguePoints)) : null))))),
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
      // The winning point may still be on its way: scorers see when it's saved.
      !canScore(t, m) && t.can.score && m.rallies ? syncLine(m) : null,
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
      return h('div', { class: `sb-row side-${s}${won ? ' won' : ''}${sc.setGames ? ' has-set' : ''}${sc.single ? ' single' : ''}` },
        h('div', { class: 'sb-serve' }, live && sc.server === s ? h('span', { class: 'serve', title: 'Serving' }) : null),
        h('div', { class: 'sb-name' }, nameOf(p), flag ? h('span', { class: 'flag' }, flag) : null, won ? h('span', { class: 'flag' }, 'Winner') : null),
        sc.single ? null : h('div', { class: 'sb-games', title: `${sc.unit || 'Game'}s won` }, sc.gamesWon[s]),
        sc.setGames ? h('div', { class: 'sb-games sb-set', title: 'Games in this set' }, sc.setGames[s]) : null,
        h('div', { class: 'sb-points' }, m.status === 'done' || m.status === 'bye' ? '' : sc.points ? sc.points[s] : cur[s]));
    };
    return h('div', { class: 'scoreboard' }, row('a'), row('b'),
      live && sc.server
        ? h('div', { class: 'sb-foot' }, `${sc.unit || 'Game'} ${sc.games.length} · ${nameOf(m[sc.server])} to serve${sc.serveCourt ? ` from the ${sc.serveCourt} court` : ''}${sc.note ? ` · ${sc.note}` : ''}`)
        : live && sc.note ? h('div', { class: 'sb-foot' }, sc.note)
          : m.status === 'done' ? h('div', { class: 'sb-foot' }, m.draw ? `Match drawn · ${m.summary}` : m.summary) : null);
  }

  // Whether the umpire's points have reached the server.
  function syncLine(m) {
    return h('div', { class: `sync ${S.offline && m.pending ? 'offline' : m.pending ? 'saving' : 'saved'}`, role: 'status' },
      S.offline && m.pending
        ? `No connection — ${m.pending} point${m.pending === 1 ? '' : 's'} waiting, will send automatically`
        : m.pending ? 'Saving…' : 'All points saved');
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

    const courtInput = h('input', { name: 'court', maxlength: 20, placeholder: 'e.g. 3', value: m.court || '', 'aria-label': CAT.courtWord(t.sport.id) });
    // Score live, or type the result in at the end (remembered per tournament, for catching up).
    const modeKey = `tonament.resultMode.${t.id}`;
    if (!S.resultMode) S.resultMode = {};
    if (S.resultMode[t.id] === undefined) { try { S.resultMode[t.id] = sessionStorage.getItem(modeKey) === '1'; } catch { S.resultMode[t.id] = false; } }
    const atEnd = Boolean(S.resultMode[t.id]);
    const modeSwitch = h('div', { class: 'seg score-mode', role: 'group', 'aria-label': 'How to score' },
      [[false, 'Score live'], [true, 'Enter result']].map(([v, label]) => h('button', {
        'aria-pressed': String(atEnd === v),
        onclick: () => { S.resultMode[t.id] = v; try { sessionStorage.setItem(modeKey, v ? '1' : '0'); } catch { /* private mode */ } render(); },
      }, label)));
    if (atEnd) return h('div', { class: 'scorer' }, modeSwitch, resultForm(t, m));
    return h('div', { class: 'scorer' },
      modeSwitch,
      fresh ? h('div', { class: 'card', style: 'margin:0' },
        h('div', { class: 'scorer-tools' },
          h('span', {}, h('span', { class: 'label' }, `${m.score.firstLabel || 'First serve'}: `),
            h('span', { class: 'seg' }, ['a', 'b'].map((s) => h('button', {
              'aria-pressed': String(m.firstServer === s),
              onclick: () => patchMatch(t, m, { firstServer: s }),
            }, m[s].name)))),
          m.status === 'scheduled'
            ? h('button', { class: 'btn btn-small', onclick: () => patchMatch(t, m, { status: 'live' }, 'Match marked as on court') }, 'Mark on court')
            : null)) : null,
      m.score.taps && m.score.taps.max > 1
        ? pointPad(m.id, m.score, { a: m.a.name, b: m.b.name }, (extra) => rally(t, m, extra.side, extra))
        : h('div', { class: 'score-btns' }, btn('a'), btn('b')),
      syncLine(m),
      h('div', { class: 'scorer-tools' },
        h('button', { class: 'btn', disabled: fresh, onclick: () => undo(t, m) }, '↶ Undo'),
        h('form', {
          class: 'inline-form',
          onsubmit: (e) => { e.preventDefault(); patchMatch(t, m, { court: courtInput.value }, `${CAT.courtWord(t.sport.id)} saved`); courtInput.blur(); },
        }, h('span', { class: 'label' }, CAT.courtWord(t.sport.id)), courtInput, h('button', { class: 'btn btn-small', type: 'submit' }, 'Save'))),
      h('p', { class: 'hint center', style: 'margin:0' }, `${m.score.hint || 'Tap the side that won the rally.'} ${m.score.taps && m.score.taps.max > 1
        ? 'Keyboard: A / L to pick the player, 1–9 to score, Z to undo.'
        : 'Keyboard: A / ← and L / → to score, Z to undo.'}`));
  }

  // The result at the end: each game's (set's, frame's) score, checked with
  // the sport's rules here first, then saved as if it had been scored live.
  function resultForm(t, m) {
    const sport = window.TonamentSports[t.sport.id];
    const sc0 = m.score;
    const rows = sc0.single ? 1 : Math.min(sport.normalizeConfig(t.config.scoring).bestOf || 3, 11);
    const unit = sc0.single ? 'Result' : sc0.unit || 'Game';
    const need = sc0.single ? 1 : Math.ceil(rows / 2);
    const msg = h('p', { class: 'hint result-msg', role: 'status' }, sc0.single ? (sc0.note || '') : `Fill in each ${unit.toLowerCase()} played — best of ${rows}.`);
    const inputs = Array.from({ length: rows }, (_, i) => ['a', 'b'].map((s) => h('input', {
      type: 'number', min: 0, max: 999, inputmode: 'numeric', name: `${s}${i}`, 'aria-label': `${m[s].name}, ${unit.toLowerCase()} ${i + 1}`,
    })));
    const read = () => {
      const games = [];
      for (const [a, b] of inputs) {
        if (a.value === '' && b.value === '') continue;
        games.push({ a: Number(a.value), b: Number(b.value) });
      }
      return games;
    };
    const check = () => {
      const games = read();
      if (!games.length) return { error: `Enter the score of each ${unit.toLowerCase()}` };
      const r = TonamentResult.fromScores(matchCompute(t, m), games);
      if (r.error) return r;
      if (!TonamentLeague.finished(r.score)) return { error: `That doesn't finish the match — enter every ${unit.toLowerCase()} played` };
      return r;
    };
    const form = h('form', {
      class: 'card form result-form',
      // Say what's wrong once enough is filled in; say who won once it adds up.
      oninput: () => {
        const r = check();
        if (!r.error) msg.textContent = `${sport.summary(r.score)} — ${r.score.winner ? `${m[r.score.winner].name} wins` : 'a draw'}`;
        else if (read().length >= need) msg.textContent = r.error;
      },
      onsubmit: async (e) => {
        e.preventDefault();
        const r = check();
        if (r.error) { toast(r.error, true); return; }
        if (m.rallies && !confirm(`This replaces the ${m.rallies} point${m.rallies === 1 ? '' : 's'} scored live. Save ${sport.summary(r.score)}?`)) return;
        await act(async () => {
          const updated = await api('POST', `${tPath(t)}/matches/${m.id}/result`, { games: read(), at: m.rallies }, t.id);
          form.removeAttribute('data-dirty');
          mergeMatch(updated);
          render(true);
          refresh();
        }, 'Result saved ✓');
      },
    },
    h('table', { class: 'result-table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, m.a.name), h('th', {}, m.b.name))),
      h('tbody', {}, inputs.map(([a, b], i) => h('tr', {}, h('th', { scope: 'row' }, sc0.single ? (sc0.unit ? `${sc0.unit}s` : 'Score') : `${unit} ${i + 1}`), h('td', {}, a), h('td', {}, b))))),
    msg,
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save result')));
    return form;
  }

  // Snooker (ball by ball) and carrom: pick the player, then tap what they
  // scored in one go — a ball's value, a foul, or a whole board's points.
  const BALLS = [[1, 'red', 'Red'], [2, 'yellow', 'Yellow'], [3, 'green', 'Green'], [4, 'brown', 'Brown'], [5, 'blue', 'Blue'], [6, 'pink', 'Pink'], [7, 'black', 'Black']];
  S.atTable = S.atTable || {}; // match or game id -> the side picked on the point pad
  function pointPad(key, score, names, onTap) {
    const T = score.taps;
    const snooker = T.fouls;
    // Snooker keeps the player at the table between pots; carrom asks who won each board.
    const sel = S.atTable[key] || (snooker ? 'a' : null);
    const pick = (s) => { S.atTable[key] = s; render(); };
    const other = (s) => (s === 'a' ? 'b' : 'a');
    const pickBtn = (s) => h('button', {
      class: `score-btn pick-btn side-${s}`, 'aria-pressed': String(sel === s), onclick: () => pick(s),
    }, h('span', { class: 'sbtn-name' }, names[s]), h('span', { class: 'pick-label' }, snooker ? (sel === s ? 'At the table' : 'Tap to switch') : (sel === s ? 'Won the board' : 'Won the board?')));
    const score1 = (extra, next) => { if (next !== undefined) S.atTable[key] = next; onTap(extra); };
    return h('div', { class: 'point-pad' },
      h('div', { class: 'score-btns pick-btns' }, pickBtn('a'), pickBtn('b')),
      snooker
        ? [
          h('div', { class: 'ball-row', role: 'group', 'aria-label': `Potted by ${names[sel]}` }, BALLS.map(([n, id, label]) => h('button', {
            class: `ball ball-${id}`, onclick: () => score1({ side: sel, points: n }), 'aria-label': `${label}, ${n} to ${names[sel]}`, title: label,
          }, n))),
          h('div', { class: 'foul-row' },
            h('span', { class: 'label' }, `Foul by ${names[sel]}:`),
            [4, 5, 6, 7].map((n) => h('button', { class: 'btn btn-small', onclick: () => score1({ side: other(sel), points: n, foul: true }, other(sel)), 'aria-label': `Foul by ${names[sel]}: ${n} to ${names[other(sel)]}` }, `+${n}`)),
            h('button', { class: 'btn btn-small btn-primary end-frame', disabled: !T.end, onclick: () => {
              const g = score.games[score.games.length - 1];
              const w = g.a > g.b ? 'a' : 'b';
              if (confirm(`End ${score.unit.toLowerCase()} ${score.games.length}: ${names[w]} wins ${Math.max(g.a, g.b)}–${Math.min(g.a, g.b)}?`)) onTap({ end: true });
            } }, `End ${score.unit.toLowerCase()}`)),
        ]
        : h('div', { class: 'pts-row', role: 'group', 'aria-label': sel ? `Points to ${names[sel]}` : 'Pick who won the board first' },
          Array.from({ length: T.max }, (_, i) => i + 1).map((n) => h('button', {
            class: 'btn pts', disabled: !sel, onclick: () => score1({ side: sel, points: n }, null),
          }, `+${n}`))));
  }

  function gamesTable(m) {
    const games = m.score.games.filter((g) => g.a + g.b > 0);
    if (!games.length || m.score.single) return null; // frames: the scoreboard already says it all
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
  function sportUnit(id) {
    const sport = window.TonamentSports && window.TonamentSports[id];
    return (sport && sport.compute('', {}).unit) || 'Game';
  }
  const unitOf = (t) => sportUnit(t.sport.id);

  // A match's score from its taps, under its event's rules (as the server works it out).
  function matchCompute(t, m) {
    const sport = window.TonamentSports[t.sport.id];
    const scoring = t.event && t.event.discipline === 'doubles' ? { ...t.config.scoring, doubles: true } : t.config.scoring;
    return (log) => TonamentLeague.score(sport, log, scoring, m.firstServer, { draws: m.stage === 'league' && Boolean(t.config.leagueDraws) });
  }

  // The match as the umpire should see it: confirmed state plus queued taps.
  function withPending(t, m) {
    const ops = pendingOps(m.id);
    const sport = window.TonamentSports && window.TonamentSports[t.sport.id];
    if (!ops.length || !sport) return m;
    let log = m.log;
    for (const op of ops) log = op.type === 'rally' ? log + op.ch : log.slice(0, -1);
    const score = matchCompute(t, m)(log);
    return {
      ...m,
      log,
      rallies: log.length,
      score,
      summary: sport.summary(score),
      status: TonamentLeague.finished(score) ? 'done' : 'live',
      winner: score.winner ? m[score.winner].id : null,
      draw: Boolean(score.draw),
      pending: ops.length,
    };
  }

  function enqueue(t, mid, op) {
    queues.set(mid, [...pendingOps(mid), op]);
    render();
    sendQueue(t, mid);
  }

  // extra: { points, foul, end } for sports that score more than 1 a tap.
  function rally(t, m, side, extra = {}) {
    const shown = withPending(t, confirmedMatch(m.id) || m);
    if (shown.status === 'done') return;
    const tap = TonamentRally.tapFor(shown.score, { ...extra, side });
    if (tap.error) return toast(tap.error, true);
    if (navigator.vibrate) navigator.vibrate(12);
    enqueue(t, m.id, { type: 'rally', side, ...extra, ch: tap.ch });
    const after = withPending(t, confirmedMatch(m.id) || m);
    if (after.status === 'done') toast(after.draw ? `🤝 Match drawn ${after.summary}` : `🏸 ${after[after.score.winner].name} wins ${after.summary}`);
  }
  // What a queued tap sends: the side, plus points / foul / end when set.
  const tapBody = (op, at) => ({ side: op.side, points: op.points, foul: op.foul, end: op.end, at });

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
        const expected = op.type === 'rally' ? base.log + op.ch : base.log.slice(0, -1);
        try {
          const updated = await api('POST', `${tPath(t)}/matches/${mid}/${op.type}`, op.type === 'rally' ? tapBody(op, at) : { at }, t.id);
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
    const pad = m.score.taps && m.score.taps.max > 1;
    if (pad && (k === 'a' || k === 'l') && canScore(t, m)) { S.atTable[m.id] = k === 'a' ? 'a' : 'b'; render(); }
    else if (pad && /^[1-9]$/.test(k) && canScore(t, m)) {
      const side = S.atTable[m.id] || (m.score.taps.fouls ? 'a' : null);
      if (side) { rally(t, m, side, { points: Number(k) }); if (!m.score.taps.fouls) S.atTable[m.id] = null; }
    } else if ((k === 'a' || k === 'arrowleft') && canScore(t, m)) rally(t, m, 'a');
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
    for (const el of form.querySelectorAll('.partner-email-field, .partner-dupr-field')) el.hidden = solo;
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
    const roleSelect = choiceGroup({
      name: 'role', label: 'Role', value: 'umpire',
      options: [{ value: 'umpire', label: 'Umpire', hint: 'Can score matches' }, { value: 'organiser', label: 'Organiser', hint: 'Can manage everything' }],
    });
    const setMembers = (members) => { S.members = { tid: t.id, list: members }; };
    const linkRow = (label, hint, url, msg) => h('div', { class: 'link-row' },
      h('div', {}, h('strong', {}, label), h('div', { class: 'hint' }, hint)),
      h('button', { class: 'btn btn-small', onclick: () => copy(url, msg) }, 'Copy link'));

    return [
      visibilityCard(t),
      orgLinkCard(t),
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
              const { members, emailed } = await api('POST', `${tPath(t)}/members`, { email, role: roleSelect.querySelector('input:checked').value }, t.id);
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
    ensureMyOrgs();
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
            h('a', { href: '/me/profile', onclick: closeMenu }, 'Your profile'),
            h('a', { href: '/groups', onclick: closeMenu }, 'Your groups'),
            h('a', { href: '/', onclick: closeMenu }, 'My tournaments'),
            (S.myOrgs || []).map((o) => h('a', { href: `/@${o.slug}/edit`, onclick: closeMenu }, o.name, h('small', { class: 'muted' }, ` · ${o.live ? 'your page' : 'draft'}`))),
            S.myOrgs && !S.myOrgs.length ? h('a', { href: '/academy/new', onclick: closeMenu }, 'Create an academy page') : null,
            S.me.isAdmin ? h('a', { href: '/admin', onclick: closeMenu }, 'Admin') : null,
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
    // Email me a link: no password, and this phone stays signed in.
    if (S.emailEnabled && !S.route.password) return linkCard(signup, next);
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
      h('a', { href: `/${signup ? 'signin' : 'signup'}?next=${encodeURIComponent(next)}` }, signup ? 'Sign in' : 'Create an account')),
    S.emailEnabled ? h('p', { class: 'center small', style: 'margin:0' },
      h('button', { type: 'button', class: 'link-btn', onclick: () => { S.route.password = false; render(); } }, 'Email me a sign-in link instead')) : null);
    return form;
  }

  // While "check your email" is up, this tab asks whether the link has been
  // opened — on this phone in the mail app's own browser, or anywhere — and
  // signs itself in when it has. Checks again as soon as the tab is back.
  let linkPoll = null;
  function waitForLink(poll) {
    if (!poll) return;
    clearTimeout(linkPoll && linkPoll.timer);
    const until = Date.now() + 40 * 60000;
    const me = { poll };
    linkPoll = me;
    const check = async () => {
      if (linkPoll !== me) return;
      if (S.me || !['signin', 'signup'].includes(S.route.name) || !S.route.sent || Date.now() > until) { linkPoll = null; return; }
      if (!document.hidden) {
        try {
          const r = await api('POST', '/auth/link/poll', { poll });
          if (r.user && linkPoll === me) {
            linkPoll = null;
            S.me = r.user;
            navFor = null;
            toast(`Signed in as ${r.user.name}`);
            navigate(safeNext(r.next), { replace: true });
            return;
          }
        } catch { /* offline: try again */ }
      }
      me.timer = setTimeout(check, 2500);
    };
    me.check = check;
    me.timer = setTimeout(check, 2500);
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && linkPoll && linkPoll.check) { clearTimeout(linkPoll.timer); linkPoll.check(); }
  });

  // "Email me a link": one field, then "check your email" with the check code.
  function linkCard(signup, next) {
    const sent = S.route.sent;
    const email = h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email', inputmode: 'email', value: (sent && sent.email) || S.route.email || null });
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Email me a sign-in link');
    const send = async (address) => {
      btn.disabled = true;
      try {
        const { code, poll } = await api('POST', '/auth/link', { email: address, next });
        S.route.sent = { email: address, code };
        render();
        waitForLink(poll);
      } catch (err) {
        toast(err.message, true);
        btn.disabled = false;
      }
    };
    const usePassword = h('p', { class: 'center small', style: 'margin:0' },
      h('button', { type: 'button', class: 'link-btn', onclick: () => { S.route.password = true; S.route.sent = null; render(); } }, signup ? 'Sign up with a password instead' : 'Use my password instead'));
    if (sent) {
      return h('div', { class: 'card form auth-card link-sent' },
        h('h1', {}, 'Check your email'),
        h('p', {}, 'We sent a sign-in link to ', h('strong', {}, sent.email), '. Tap it and you\'re in — no password needed. If it opens in your email app, come back here: this page signs you in too.'),
        h('p', { class: 'check-code' }, h('span', { class: 'muted small' }, 'Check code'), h('strong', {}, sent.code)),
        h('p', { class: 'muted small' }, 'The email shows the same code. Not there? Check spam, or wait a minute and send it again.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', type: 'button', onclick: () => send(sent.email) }, 'Send again'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { S.route.sent = null; render(); } }, 'Use another email')),
        usePassword);
    }
    const form = h('form', {
      class: 'card form auth-card',
      onsubmit: (e) => { e.preventDefault(); send(email.value.trim()); },
    },
    h('h1', {}, signup ? 'Join Tonament' : 'Sign in'),
    h('p', { class: 'muted' }, 'Enter your email and we\'ll send you a link. No password to remember — and this phone stays signed in.'),
    field('Email', email),
    btn,
    usePassword,
    h('p', { class: 'center small muted', style: 'margin:0' }, 'New here? The same link creates your free account.'));
    return form;
  }

  // Opening the emailed link: signs in, or asks a new player's name first.
  async function useLink(name) {
    const r = S.route;
    try {
      const res = await api('POST', '/auth/link/use', { token: r.token, ...(name && { name }) });
      if (res.needsName) {
        Object.assign(r, { state: 'name', email: res.email });
        render();
        return;
      }
      S.me = res.user;
      S.t = null;
      navFor = null;
      toast(`Signed in as ${res.user.name}`);
      navigate(safeNext(res.next), { replace: true });
    } catch (err) {
      Object.assign(r, { state: 'error', message: err.message });
      render();
    }
  }

  function viewLink() {
    document.title = 'Signing in · Tonament';
    const r = S.route;
    if (r.state === 'opening') return h('div', { class: 'card auth-card' }, h('h1', {}, 'Signing you in…'), loading());
    if (r.state === 'error') {
      return h('div', { class: 'card form auth-card' }, h('h1', {}, 'That link didn\'t work'), h('p', { class: 'muted' }, r.message),
        h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: '/signin' }, 'Get a new link')));
    }
    const name = h('input', { name: 'name', required: true, maxlength: 60, autocomplete: 'name', placeholder: 'e.g. Asha Rao' });
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Continue');
    return h('form', {
      class: 'card form auth-card',
      onsubmit: (e) => { e.preventDefault(); btn.disabled = true; useLink(name.value.trim()); },
    },
    h('h1', {}, 'Welcome to Tonament'),
    h('p', { class: 'muted' }, 'Creating your account for ', h('strong', {}, r.email), '. What should we call you?'),
    field('Your name', name, null, 'As it appears on entry lists, scores and rankings.'),
    btn);
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

  // ---------- groups: daily play (tonament.com/g/<slug>)
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const gPath = (slug) => `/groups/${encodeURIComponent(slug)}`;
  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // "Today, 6:00 – 9:00 am"
  function fmtSessionDay(iso, endIso) {
    const d = new Date(iso);
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(new Date())) / 86400000);
    const label = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    return `${label}, ${fmtTime(iso)}${endIso ? ` – ${fmtTime(endIso)}` : ''}`;
  }
  // Half-hour arrival times for a session: [{ value: '06:30', label: '6:30 am' }, …] (after the start, before the end).
  function etaOptions(st) {
    const [hh, mm] = String(st.time || '06:00').split(':').map(Number);
    const out = [];
    for (let m = 30; m < Math.round((st.hours || 3) * 60); m += 30) {
      const t = (hh * 60 + mm + m) % 1440;
      const value = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      out.push({ value, label: fmtClock(value) });
    }
    return out;
  }
  function scheduleText(s, sport) {
    const days = [...(s.days || [])].sort();
    const run = days.length === 7 ? 'Every day'
      : days.join() === '1,2,3,4,5,6' ? 'Mon–Sat'
        : days.join() === '1,2,3,4,5' ? 'Mon–Fri'
          : days.map((d) => DAYS[d]).join(', ');
    const time = `${fmtClock(s.time || '06:00')}${s.endTime ? ` – ${fmtClock(s.endTime)}` : ''}`;
    return `${run} · ${time} · ${s.courts} ${CAT.courtWord(sport).toLowerCase()}${s.courts === 1 ? '' : 's'}`;
  }
  const teamName = (team) => team.map((p) => p.name).join(' & ');
  // ['Beginner', 'Intermediate'] -> "Beginner & Intermediate"; none -> "All levels".
  const levelText = (levels) => (levels && levels.length ? levels.length === 1 ? levels[0] : `${levels.slice(0, -1).join(', ')} & ${levels[levels.length - 1]}` : 'All levels');
  const groupLevels = (sportId) => CAT.levelsFor(sportId).filter((l) => l !== 'Open');
  const groupUrl = (g, withInvite) => `${location.origin}/g/${g.slug}${withInvite && g.invite ? `?join=${g.invite}` : ''}`;

  async function loadGroup(skip = 0) {
    const slug = S.route.slug;
    try {
      const g = await api('GET', `${gPath(slug)}${skip ? `?skip=${skip}` : ''}`);
      if (S.route.slug === slug) { S.group = g; S.error = null; }
    } catch (e) {
      S.error = e.message;
    }
    render(true);
    scheduleGroupPoll();
  }
  let groupTimer;
  function scheduleGroupPoll() {
    clearTimeout(groupTimer);
    if (!['group', 'groupGame'].includes(S.route.name)) return;
    const busy = S.route.name === 'groupGame' ? 2500 : S.group && S.group.session && S.group.session.today ? 4000 : 30000;
    groupTimer = setTimeout(() => {
      if (document.hidden) { scheduleGroupPoll(); return; }
      if (S.route.name === 'groupGame') { if (!gSending && !(gQueues.get(S.route.gid) || []).length) loadGroupGame(); else scheduleGroupPoll(); }
      else if (S.route.name === 'group') loadGroup(S.route.skip || 0);
    }, busy);
  }
  const groupAct = (fn, msg) => act(async () => { await fn(); await loadGroup(S.route.skip || 0); }, msg);

  // Your groups.
  function viewGroups() {
    document.title = 'Your groups · Tonament';
    const list = S.groupsList;
    return [
      h('div', { class: 'card-head page-head' }, h('h1', {}, 'Your groups'), h('a', { class: 'btn btn-primary', href: '/groups/new' }, 'Create a group')),
      list == null ? loading()
        : list.length ? h('div', { class: 'card-list' }, list.map((g) => h('a', { class: 'card group-card', href: `/g/${g.slug}` },
          icon(g.sport),
          h('span', { class: 'group-card-main' }, h('strong', {}, g.name),
            h('small', { class: 'muted' }, [g.sportName, g.city, `${g.members} member${g.members === 1 ? '' : 's'}`].filter(Boolean).join(' · '))),
          g.status === 'requested' ? pill('waiting', 'Requested')
            : g.games ? h('span', { class: 'group-card-rating' }, h('strong', {}, g.rating), h('small', {}, 'rating')) : null)))
          : h('div', { class: 'card empty-state' },
            h('h2', {}, 'Play together, every day'),
            h('p', { class: 'muted' }, 'A group is the people you play with regularly. RSVP with one tap from WhatsApp, get fair games at the venue, score live with no arguments, and see who\'s really on top.'),
            h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: '/groups/new' }, 'Create a group'))),
    ];
  }

  // Create a group: one short form.
  function viewGroupNew() {
    document.title = 'Create a group · Tonament';
    const live = liveSports();
    if (!live.length) return loading();
    // "Copy for another slot": start from an existing group's details.
    const from = S.route.copy && S.group && S.group.slug === S.route.copy ? S.group : null;
    const d = (S.groupDraft ||= from ? { sport: from.sport.id } : { sport: live[0].id });
    const sport = live.find((x) => x.id === d.sport) || live[0];
    const fs = from ? from.settings : null;
    const host = from ? (from.host && from.host.slug) : S.route.host;
    const pointsField = sport.fields.find((f) => f.key === 'points');
    const pointOptions = pointsField ? [...new Set([11, 15, 21, sport.defaults.points].filter((n) => n >= (pointsField.min || 1) && n <= (pointsField.max || 99)))].sort((a, b) => a - b) : null;
    const form = h('form', {
      class: 'card form new-flow',
      onsubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const days = fd.getAll('days').map(Number);
        if (!days.length) { toast('Pick at least one day', true); return; }
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const { slug } = await api('POST', '/groups', {
            name: fd.get('name'), sport: sport.id, city: fd.get('city'), venue: fd.get('venue'),
            days, time: fd.get('time'), endTime: fd.get('endTime'), courts: Number(fd.get('courts')),
            levels: fd.getAll('levels'), open: fd.get('open') === 'on', maxPlayers: fd.get('maxPlayers') || null,
            ...(fd.get('host') && { host: fd.get('host') }),
            scoring: { ...sport.defaults, bestOf: 1, ...(pointOptions && { points: Number(fd.get('points')) }) },
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata',
          });
          S.groupDraft = null;
          toast('Group created — now invite your players');
          navigate(`/g/${slug}?tab=members`);
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      },
    },
    h('h1', {}, from ? 'Another slot' : 'Create a group'),
    h('p', { class: 'muted' }, from ? `A copy of ${from.name}: change the name, time and level.` : 'For the people you play with regularly — or a venue\'s daily slot for a level. You can change all of this later.'),
    field('Group name', h('input', { name: 'name', required: true, maxlength: 60, value: from ? `${from.name} (copy)` : '', placeholder: host ? 'e.g. Evening Intermediates' : 'e.g. Velachery Morning Smashers', autocomplete: 'off' })),
    groupField('Sport', choiceGroup({
      name: 'sport', label: 'Sport', value: sport.id, tiles: true,
      options: live.map((x) => ({ value: x.id, label: x.name, icon: x.id })),
      onchange: (e) => { d.sport = e.target.value; render(); },
    })),
    groupField('Days', choiceGroup({ name: 'days', label: 'Days', multiple: true, value: fs ? fs.days : [1, 2, 3, 4, 5, 6], options: [1, 2, 3, 4, 5, 6, 0].map((n) => ({ value: n, label: DAYS[n] })) })),
    h('div', { class: 'grid-2' },
      field('Start time', h('input', { name: 'time', type: 'time', required: true, value: fs ? fs.endTime || fs.time : '06:00' })),
      field('End time', h('input', { name: 'endTime', type: 'time', required: true, value: fs ? '' : '09:00' }), null, from ? 'This slot starts when the last one ends.' : null)),
    levelField(sport.id, fs ? fs.levels : []),
    groupField(`${CAT.courtWord(sport.id)}s`, choiceGroup({ name: 'courts', label: `${CAT.courtWord(sport.id)}s`, value: fs ? fs.courts : 2, options: [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) })) })),
    field('Max players (optional)', h('input', { name: 'maxPlayers', type: 'number', min: 2, max: 200, value: fs && fs.maxPlayers ? fs.maxPlayers : '', placeholder: 'No limit' }), null, 'Extra RSVPs go on a waitlist.'),
    hostField(host),
    openField(fs ? fs.open : Boolean(host)),
    pointOptions ? groupField('Games to', choiceGroup({ name: 'points', label: 'Games to', value: sport.defaults.points, options: pointOptions.map((n) => ({ value: n, label: String(n) })) }), null, 'One game per match, so courts turn over quickly.') : null,
    h('div', { class: 'grid-2' },
      field('Venue', h('input', { name: 'venue', maxlength: 120, value: from ? from.venue || '' : '', placeholder: 'e.g. SDAT Indoor Stadium' })),
      field('City', h('input', { name: 'city', maxlength: 60, list: 'group-cities', value: from ? from.city || '' : '' }))),
    h('datalist', { id: 'group-cities' }, cityOptions(REGIONS.defaultCountry).map((c) => h('option', { value: c }))),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Create group')));
    return form;
  }

  // The group page.
  const GROUP_TABS = [['today', 'Today'], ['leaderboard', 'Leaderboard'], ['members', 'Members']];
  function viewGroup() {
    const g = S.group;
    if (!g || g.slug !== S.route.slug) return loading();
    document.title = `${g.name} · Tonament`;
    const head = h('header', { class: 'group-head' },
      h('div', { class: 'group-head-icon' }, icon(g.sport.id)),
      h('div', {}, h('h1', {}, g.name),
        h('p', { class: 'muted small' }, (() => {
          const where = g.venue || (g.host && g.host.address);
          // The host's address often ends with the city already.
          const city = g.city && !(where && where.toLowerCase().includes(g.city.toLowerCase())) ? g.city : null;
          return [g.sport.name, where, city].filter(Boolean).join(' · ');
        })()),
        h('p', { class: 'group-level' }, h('span', { class: 'event-tag level-tag' }, levelText(g.settings.levels))),
        h('p', { class: 'muted small' }, `${scheduleText(g.settings, g.sport.id)} · ${g.members} member${g.members === 1 ? '' : 's'}`),
        g.host ? h('p', { class: 'host-chip' }, `Hosted by `, g.host.public ? h('a', { href: `/@${g.host.slug}` }, g.host.name) : h('strong', {}, g.host.name)) : null));
    if (!g.member) {
      const next = `/g/${g.slug}${S.route.join ? `?join=${encodeURIComponent(S.route.join)}` : ''}`;
      return [head, h('div', { class: 'card entry-card' },
        !S.me ? [
          h('h2', {}, `Join ${g.name}`),
          h('p', { class: 'muted' }, 'Sign in to RSVP, play and see the leaderboard. It takes a few seconds — no password needed.'),
          h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary btn-lg', href: `/signin?next=${encodeURIComponent(next)}` }, 'Sign in to join')),
        ] : g.role === 'requested' ? [
          h('h2', {}, 'Request sent'),
          h('p', { class: 'muted' }, 'A group admin will let you in. This page updates when they do.'),
        ] : [
          h('h2', {}, `Join ${g.name}`),
          g.settings.open
            ? h('p', { class: 'muted' }, `${levelText(g.settings.levels)} · ${scheduleText(g.settings, g.sport.id)}. Join, then say you're in for the days you're coming.`)
            : h('p', { class: 'muted' }, 'Ask to join — a group admin will let you in. (With the invite link from the group, you join straight away.)'),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', onclick: () => act(async () => { const r = await api('POST', `${gPath(g.slug)}/join`, {}); await loadGroup(); return r; }, g.settings.open ? 'You\'re in the group ✓' : 'Request sent') }, g.settings.open ? 'Join' : 'Ask to join')),
        ])];
    }
    const tabs = [...GROUP_TABS, ...(g.admin ? [['attendance', 'Attendance'], ['settings', 'Settings']] : [])];
    const tab = tabs.some(([id]) => id === S.route.tab) ? S.route.tab : 'today';
    const body = { today: groupToday, leaderboard: groupLeaderboard, members: groupMembers, attendance: groupAttendance, settings: groupSettings }[tab](g);
    return [head,
      h('nav', { class: 'tabs' }, tabs.map(([id, label]) => h('a', { href: `/g/${g.slug}${id === 'today' ? '' : `?tab=${id}`}`, class: id === tab ? 'active' : '' }, label, id === 'members' && g.requests.length ? h('span', { class: 'tab-count' }, g.requests.length) : null))),
      h('section', {}, body)];
  }

  // The RSVP card for a session (today's, or the next one).
  function rsvpCard(g, s, small) {
    const me = s.me;
    const going = s.players.filter((p) => p.status === 'in');
    const waiting = s.players.filter((p) => p.status === 'waitlist');
    const set = (status) => groupAct(() => api('POST', `${gPath(g.slug)}/sessions/${s.id}/rsvp`, { status }), status === 'in' ? 'You\'re in ✓' : 'Got it — see you next time');
    const share = () => shareSession(g, s);
    return h('div', { class: `card rsvp-card${small ? ' small' : ''}` },
      h('div', { class: 'card-head' },
        h('h2', {}, fmtSessionDay(s.startsAt, s.endsAt)),
        h('button', { class: 'btn btn-small btn-ghost', onclick: share }, 'Share on WhatsApp')),
      h('div', { class: 'rsvp-buttons' },
        h('button', { class: `btn btn-lg${me && me.status !== 'out' ? ' btn-primary' : ''}`, 'aria-pressed': String(Boolean(me && me.status !== 'out')), onclick: () => set('in') },
          me && me.status === 'waitlist' ? 'On the waitlist' : me && me.status === 'in' ? 'I\'m in ✓' : 'I\'m in'),
        h('button', { class: `btn btn-lg${me && me.status === 'out' ? ' btn-dark' : ''}`, 'aria-pressed': String(Boolean(me && me.status === 'out')), onclick: () => set('out') }, 'Can\'t make it')),
      me && me.status !== 'out' && !me.checkedIn ? etaPicker(g, s) : null,
      h('p', { class: 'muted small rsvp-count' }, `${going.length} in${g.settings.maxPlayers ? ` of ${g.settings.maxPlayers}` : ''}${waiting.length ? ` · ${waiting.length} waiting` : ''}${s.out.length ? ` · ${s.out.length} can't make it` : ''}`),
      arrivalsLine(s),
      going.length ? h('p', { class: 'rsvp-names' }, going.map(nameChip)) : null,
      waiting.length ? h('p', { class: 'rsvp-names muted small' }, 'Waitlist: ', waiting.map((p) => p.name).join(', ')) : null);
  }

  // "Coming at" for someone who's in: from the start, or a half hour later on.
  function etaPicker(g, s) {
    const me = s.me;
    const sel = h('select', {
      'aria-label': 'Coming at',
      onchange: (e) => groupAct(() => api('POST', `${gPath(g.slug)}/sessions/${s.id}/rsvp`, { eta: e.target.value || null }), e.target.value ? `See you at ${fmtClock(e.target.value)}` : 'See you at the start'),
    }, h('option', { value: '', selected: !me.eta }, 'From the start'),
    etaOptions(g.settings).map((o) => h('option', { value: o.value, selected: me.eta === o.value }, o.label)));
    return h('label', { class: 'eta-field' }, h('span', {}, 'Coming at'), sel);
  }
  // "By 6:00 — 4 · 6:30 — 7 · 7:00 — 10": who's here or coming by each time.
  const arrivalsLine = (s) => (s.arrivals && s.arrivals.length
    ? h('p', { class: 'arrivals small' }, s.arrivals.map((a, i) => [i ? ' · ' : 'By ', h('strong', {}, fmtClock(a.time)), ` ${a.count}`]))
    : null);
  const nameChip = (p) => h('span', { class: `name-chip${p.checkedIn ? ' here' : ''}` }, p.name, p.eta ? h('small', {}, ` ${fmtClock(p.eta)}`) : null);
  // The session for the WhatsApp group: when, how many are going, spots left.
  function shareSession(g, s) {
    const going = s.players.filter((p) => p.status === 'in').length;
    const max = g.settings.maxPlayers;
    const where = g.host ? g.host.name : g.venue;
    const text = [
      `${g.sport.name} · ${g.name}${where && where !== g.name ? ` at ${where}` : ''}${g.settings.levels && g.settings.levels.length ? ` · ${levelText(g.settings.levels)}` : ''}`,
      `${fmtSessionDay(s.startsAt, s.endsAt)} · ${going} going${max ? (going < max ? `, ${max - going} spot${max - going === 1 ? '' : 's'} left` : ', full (waitlist open)') : ''}`,
      // ?s= gives the link a "come and play" preview with today's count.
      `Say you're in (and when you're coming): ${groupUrl(g, true)}${g.invite ? '&' : '?'}s=${s.id}`,
    ].join('\n');
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }

  function groupToday(g) {
    const s = g.session;
    if (!s) {
      return h('div', { class: 'card' }, h('h2', {}, 'No sessions scheduled'),
        h('p', { class: 'muted' }, g.admin ? 'Pick the days you play in Settings.' : 'An admin hasn\'t set the days yet.'));
    }
    const out = [];
    if (!s.today) {
      out.push(rsvpCard(g, s));
      return out;
    }
    const me = s.me;
    const here = me && me.checkedIn;
    const checkIn = (on, user) => groupAct(() => api('POST', `${gPath(g.slug)}/sessions/${s.id}/checkin`, { here: on, ...(user && { user }) }), on ? (user ? 'Checked in' : 'You\'re checked in') : 'See you next time');
    // Before it starts: RSVP as usual (people decide half an hour before).
    if (!s.started) out.push(rsvpCard(g, s));
    // 1. Me: check in.
    out.push(h('div', { class: `card checkin-card${here ? ' on' : ''}` },
      h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, fmtSessionDay(s.startsAt, s.endsAt)), h('p', { class: 'muted small' }, `${s.players.filter((p) => p.checkedIn).length} here · ${s.players.filter((p) => p.status === 'in').length} in`)),
        here ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => checkIn(false) }, 'Leaving')
          : h('button', { class: 'btn btn-primary btn-lg', onclick: () => checkIn(true) }, 'I\'m here')),
      here ? h('p', { class: 'small', style: 'margin:0' }, '✓ You\'re checked in — you\'ll be picked for games fairly.') : null,
      s.started && !here && me && me.status === 'in' ? etaPicker(g, s) : null,
      s.started ? arrivalsLine(s) : null,
      s.started && s.players.some((p) => p.status === 'in' && !p.checkedIn && p.eta) ? h('p', { class: 'rsvp-names small' }, 'On the way: ', s.players.filter((p) => p.status === 'in' && !p.checkedIn).map(nameChip)) : null));
    // 2. Courts.
    const free = s.courts.filter((c) => !c.gameId);
    const sug = s.suggestion;
    const start = (court) => act(async () => {
      const { id } = await api('POST', `${gPath(g.slug)}/sessions/${s.id}/games`, { court, a: sug.a.map((p) => p.id), b: sug.b.map((p) => p.id) });
      S.route.skip = 0;
      navigate(`/g/${g.slug}/game/${id}`);
    });
    out.push(h('div', { class: 'court-grid' }, s.courts.map((c) => {
      const x = c.gameId && s.live.find((y) => y.id === c.gameId);
      if (!x) return h('div', { class: 'card court-card free' }, h('span', { class: 'court-no' }, `${CAT.courtWord(g.sport.id)} ${c.no}`), h('span', { class: 'muted' }, 'Free'));
      const cur = x.score && x.score.games[x.score.games.length - 1];
      return h('a', { class: 'card court-card', href: `/g/${g.slug}/game/${x.id}` },
        h('span', { class: 'court-no' }, `${CAT.courtWord(g.sport.id)} ${c.no}`, h('span', { class: 'live-dot' }, ' LIVE')),
        h('span', { class: 'court-team' }, teamName(x.a), h('strong', {}, cur ? cur.a : '–')),
        h('span', { class: 'court-team' }, teamName(x.b), h('strong', {}, cur ? cur.b : '–')));
    })));
    // 3. Up next.
    if (sug) {
      out.push(h('div', { class: 'card upnext-card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Up next'),
          sug.more ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => { S.route.skip = (S.route.skip || 0) + 1; loadGroup(S.route.skip); } }, 'Someone else') : null),
        h('div', { class: 'upnext-teams' },
          h('span', { class: 'team' }, sug.a.map((p) => p.name).join(' & ')),
          h('span', { class: 'vs' }, 'v'),
          h('span', { class: 'team' }, sug.b.map((p) => p.name).join(' & '))),
        free.length && (here || g.admin)
          ? h('div', { class: 'actions' }, free.slice(0, 3).map((c, i) => h('button', { class: `btn${i ? '' : ' btn-primary'}`, onclick: () => start(c.no) }, `Start on ${CAT.courtWord(g.sport.id)} ${c.no}`)))
          : h('p', { class: 'muted small', style: 'margin:0' }, !free.length ? 'All courts are busy — they\'re next when one frees up.' : 'Check in to start games.')));
    } else if (here) {
      out.push(h('p', { class: 'muted small center' }, s.players.filter((p) => p.checkedIn).length < 4 ? 'Waiting for more players to check in (4 for a game).' : 'Everyone free is on court.'));
    }
    // 4. Waiting + admin check-ins.
    if (s.waiting.length) {
      out.push(h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 6px' }, `Waiting (${s.waiting.length})`),
        h('p', { class: 'rsvp-names' }, s.waiting.map((p) => h('span', { class: 'name-chip here' }, p.name, h('small', {}, ` ${p.games}`))))));
    }
    if (g.admin) {
      const notHere = s.players.filter((p) => p.status === 'in' && !p.checkedIn);
      if (notHere.length) {
        out.push(h('details', { class: 'card' }, h('summary', {}, `Check in for others (${notHere.length})`),
          h('ul', { class: 'org-t-list' }, notHere.map((p) => h('li', {}, h('span', {}, p.name), h('button', { class: 'btn btn-small', onclick: () => checkIn(true, p.id) }, 'Here'))))));
      }
    }
    // 5. Results.
    if (s.results.length) {
      out.push(h('div', { class: 'card' }, h('h2', {}, 'Results today'),
        h('ul', { class: 'result-list' }, s.results.map((x) => gameResultRow(g, x)))));
    }
    if (s.started) out.push(addResultCard(g, s));
    if (g.nextSession) out.push(rsvpCard(g, g.nextSession, true));
    return out;
  }

  // A game played without the app: who played and how it ended. The other
  // side confirms it, like any result.
  function addResultCard(g, s) {
    const inSession = s.players.filter((p) => p.status === 'in');
    const others = g.leaderboard.filter((r) => !inSession.some((p) => p.id === r.id));
    const options = (optional) => [
      h('option', { value: '' }, optional ? 'No partner (singles)' : 'Pick a player'),
      inSession.length ? h('optgroup', { label: 'Playing today' }, inSession.map((p) => h('option', { value: p.id }, p.name))) : null,
      others.length ? h('optgroup', { label: 'Everyone else' }, others.map((p) => h('option', { value: p.id }, p.name))) : null,
    ];
    const me = S.me && g.leaderboard.some((r) => r.id === S.me.id) ? String(S.me.id) : '';
    const pick = (name, optional, value = '') => h('select', { name, 'aria-label': name, required: !optional }, options(optional).map((o) => {
      if (o && o.tagName === 'OPTGROUP') for (const x of o.children) x.selected = x.value === value;
      return o;
    }));
    const form = h('form', {
      class: 'add-result',
      onchange: () => form.setAttribute('data-dirty', ''), // picking players holds back live redraws
      onsubmit: (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const team = (k) => [fd.get(`${k}1`), fd.get(`${k}2`)].filter(Boolean).map(Number);
        const a = team('a');
        const b = team('b');
        if (a.length !== b.length) { toast('Both sides need the same number of players', true); return; }
        act(async () => {
          await api('POST', `${gPath(g.slug)}/sessions/${s.id}/results`, { a, b, score: { a: Number(fd.get('sa')), b: Number(fd.get('sb')) } });
          form.removeAttribute('data-dirty');
          S.addResultOpen = false;
          await loadGroup(S.route.skip || 0);
        }, 'Result added — the other side confirms it');
      },
    },
    h('div', { class: 'add-result-sides' },
      h('fieldset', {}, h('legend', {}, 'Side 1'), pick('a1', false, me), pick('a2', true), h('input', { name: 'sa', type: 'number', min: 0, max: 99, required: true, inputmode: 'numeric', placeholder: 'Score', 'aria-label': 'Side 1 score' })),
      h('fieldset', {}, h('legend', {}, 'Side 2'), pick('b1', false), pick('b2', true), h('input', { name: 'sb', type: 'number', min: 0, max: 99, required: true, inputmode: 'numeric', placeholder: 'Score', 'aria-label': 'Side 2 score' }))),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add result')));
    return h('details', { class: 'card add-result-card', open: Boolean(S.addResultOpen), ontoggle: (e) => { S.addResultOpen = e.target.open; } },
      h('summary', {}, h('strong', {}, 'Add a result'), h('small', { class: 'muted' }, ' · played a game without scoring it here?')),
      form);
  }

  function gameResultRow(g, x) {
    const won = (side) => x.winner === side;
    const status = { done: pill('waiting', 'Waiting for confirmation'), confirmed: pill('done', 'Confirmed'), disputed: pill('withdrawn', 'Disputed') }[x.status];
    const delta = (p) => (x.deltas && x.deltas[p.id] != null ? h('small', { class: x.deltas[p.id] >= 0 ? 'up' : 'down' }, ` ${x.deltas[p.id] >= 0 ? '+' : ''}${x.deltas[p.id]}`) : null);
    const post = (what, msg) => groupAct(() => api('POST', `${gPath(g.slug)}/games/${x.id}/${what}`, {}), msg);
    return h('li', {},
      h('div', { class: 'result-head' },
        h('a', { href: `/g/${g.slug}/game/${x.id}`, class: 'game-line' },
          h('span', { class: won('a') ? 'won' : '' }, x.a.map((p) => [p.name, delta(p)]).reduce((acc, v, i) => (i ? [...acc, ' & ', v] : [v]), [])),
          h('span', { class: 'muted' }, ` ${x.summary} `),
          h('span', { class: won('b') ? 'won' : '' }, x.b.map((p) => [p.name, delta(p)]).reduce((acc, v, i) => (i ? [...acc, ' & ', v] : [v]), []))),
        status),
      x.can && (x.can.confirm || x.can.dispute) ? h('div', { class: 'actions', style: 'margin:6px 0 0' },
        x.can.confirm ? h('button', { class: 'btn btn-small btn-primary', onclick: () => post('confirm', 'Result confirmed') }, x.status === 'disputed' ? 'Keep this result' : `Confirm ${x.summary}`) : null,
        x.can.dispute && x.status === 'done' ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => confirm('Flag this result for a group admin?') && post('dispute', 'Flagged for an admin') }, 'Something\'s wrong') : null,
        x.status === 'disputed' && x.can.void ? h('button', { class: 'btn btn-small btn-ghost danger', onclick: () => confirm('Void this game? It won\'t count for ratings.') && post('void', 'Game voided') }, 'Void game') : null) : null);
  }

  function groupLeaderboard(g) {
    const rows = g.leaderboard.filter((r) => r.games);
    const fresh = g.leaderboard.filter((r) => !r.games);
    return [
      h('div', { class: 'card' },
        h('h2', {}, 'Leaderboard'),
        rows.length ? h('ol', { class: 'rank-list' }, rows.map((r) => h('li', { class: `rank-row${r.id === (S.me && S.me.id) ? ' me' : ''}` },
          h('span', { class: 'rank-no' }, r.rank),
          h('span', { class: 'rank-name' }, r.handle ? h('a', { href: `/p/${r.handle}` }, r.name) : h('strong', {}, r.name),
            h('small', { class: 'muted' }, `${r.wins}–${r.games - r.wins} · ${r.winPct}% wins${r.week.games ? ` · this week ${r.week.wins}–${r.week.games - r.week.wins}` : ''}`)),
          h('span', { class: 'rank-pts' }, h('strong', {}, r.rating), h('small', {}, r.provisional ? 'new' : 'rating')))))
          : empty('No confirmed games yet. Ratings start at 1000 and move after every confirmed game.'),
        h('p', { class: 'hint', style: 'margin:8px 0 0' }, 'Ratings move after every confirmed game: beat stronger players to climb faster. "new" = fewer than 5 games.')),
      fresh.length ? h('p', { class: 'muted small' }, `Yet to play: ${fresh.map((r) => r.name).join(', ')}`) : null,
    ];
  }

  function groupMembers(g) {
    const link = groupUrl(g, true);
    const shareInvite = () => {
      const text = `Join ${g.name} on Tonament — RSVP, fair games and live scores:\n${link}`;
      if (navigator.share) navigator.share({ text }).catch(() => {});
      else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    };
    const setMember = (id, action, msg) => groupAct(() => api('POST', `${gPath(g.slug)}/members/${id}`, { action }), msg);
    return [
      h('div', { class: 'card' },
        h('h2', {}, 'Invite players'),
        h('p', { class: 'muted small' }, 'Anyone with this link joins straight away. Share it in your WhatsApp group.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-primary', onclick: shareInvite }, 'Share invite link'),
          h('button', { class: 'btn', onclick: () => copy(link, 'Invite link copied') }, 'Copy link'))),
      g.requests.length ? h('div', { class: 'card' }, h('h2', {}, `Asking to join (${g.requests.length})`),
        h('ul', { class: 'org-t-list' }, g.requests.map((r) => h('li', {},
          h('span', {}, h('strong', {}, r.name), h('small', { class: 'muted' }, ` ${r.email}`)),
          h('span', { class: 'actions', style: 'margin:0' },
            h('button', { class: 'btn btn-small btn-primary', onclick: () => setMember(r.id, 'approve', `${r.name} joined`) }, 'Let in'),
            h('button', { class: 'btn btn-small btn-ghost', onclick: () => setMember(r.id, 'decline', 'Declined') }, 'Decline')))))) : null,
      h('div', { class: 'card' }, h('h2', {}, `Members (${g.members})`),
        h('ul', { class: 'org-t-list' }, g.leaderboard.map((r) => h('li', {},
          h('span', {}, r.handle ? h('a', { href: `/p/${r.handle}` }, r.name) : r.name, r.role === 'admin' ? [' ', pill('org', 'Admin')] : null),
          g.admin && r.id !== (S.me && S.me.id) ? h('span', { class: 'actions', style: 'margin:0' },
            h('button', { class: 'btn btn-small btn-ghost', onclick: () => setMember(r.id, r.role === 'admin' ? 'member' : 'admin', r.role === 'admin' ? 'No longer an admin' : `${r.name} is now an admin`) }, r.role === 'admin' ? 'Remove admin' : 'Make admin'),
            h('button', { class: 'btn btn-small btn-ghost danger', onclick: () => confirm(`Remove ${r.name} from the group?`) && setMember(r.id, 'remove', 'Removed') }, 'Remove')) : null)))),
      h('p', { class: 'center' }, h('button', {
        class: 'link-btn small',
        onclick: () => confirm(`Leave ${g.name}?`) && act(async () => { await api('POST', `${gPath(g.slug)}/leave`, {}); navigate('/groups'); }, 'You left the group'),
      }, 'Leave this group')),
    ];
  }

  // Which levels the slot is for (none ticked: all levels).
  const levelField = (sportId, value) => groupField('Level', choiceGroup({ name: 'levels', label: 'Level', multiple: true, value: value || [], options: groupLevels(sportId).map((l) => ({ value: l, label: l })) }), null, 'Leave all unticked for all levels.');
  const openField = (on) => h('label', { class: 'check-field' }, h('input', { type: 'checkbox', name: 'open', checked: Boolean(on) }),
    h('span', {}, h('strong', {}, 'Anyone can join'), h('small', {}, 'People who find the group (say, on your venue page) join with one tap — no approval needed.')));

  // Hosted by: one of the venue / academy pages I manage (create form).
  function hostField(preset) {
    const mine = S.myOrgs || [];
    if (!mine.length) return null;
    return field('Hosted by (optional)', h('select', { name: 'host' },
      h('option', { value: '' }, 'No venue or academy page'),
      mine.map((o) => h('option', { value: o.slug, selected: o.slug === preset }, o.name))), null, 'The group shows on that page under "Play here", so new players can find and join it.');
  }
  // Settings: the pages this admin manages, plus the current host.
  function groupHostField(g) {
    const key = g.slug;
    S.groupHosts = S.groupHosts || {};
    if (S.groupHosts[key] === undefined) {
      S.groupHosts[key] = null;
      api('GET', `${gPath(g.slug)}/hosts`).then((list) => { S.groupHosts[key] = list; render(); }).catch(() => { S.groupHosts[key] = []; });
    }
    const list = S.groupHosts[key] || [];
    const options = [...list];
    if (g.host && !options.some((o) => o.slug === g.host.slug)) options.push({ slug: g.host.slug, name: g.host.name });
    if (!options.length) return null;
    return field('Hosted by', h('select', { name: 'host' },
      h('option', { value: '' }, 'No venue or academy page'),
      options.map((o) => h('option', { value: o.slug, selected: g.host && g.host.slug === o.slug }, o.name))), null, 'Shows this group on that page under "Play here".');
  }

  // Admins: who came to the last few sessions. For academies, the batch register.
  function groupAttendance(g) {
    S.groupAttendance = S.groupAttendance || {};
    const a = S.groupAttendance[g.slug];
    if (a === undefined) {
      S.groupAttendance[g.slug] = null;
      api('GET', `${gPath(g.slug)}/attendance`).then((x) => { S.groupAttendance[g.slug] = x; render(); }).catch((e) => { S.groupAttendance[g.slug] = { error: e.message }; render(); });
      return loading();
    }
    if (!a) return loading();
    if (a.error) return h('div', { class: 'card' }, h('p', { class: 'muted' }, a.error));
    if (!a.sessions.length) return h('div', { class: 'card' }, h('h2', {}, 'Attendance'), h('p', { class: 'muted' }, 'Nobody has played yet. After each session you\'ll see who said they\'re in and who checked in.'));
    const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    const last = a.sessions[0];
    const came = a.players.filter((p) => p.marks[last.id] === 'here').map((p) => p.name);
    const copyText = `${g.name} · ${day(last.startsAt)}, ${fmtTime(last.startsAt)}${a.settings.endTime ? ` – ${fmtClock(a.settings.endTime)}` : ''}: ${came.length} came${came.length ? ` (${came.join(', ')})` : ''}`;
    const mark = { here: '✓', in: 'in', waitlist: 'wl' };
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Attendance'),
        h('button', { class: 'btn btn-small', onclick: () => copy(copyText, 'Copied — paste it in WhatsApp') }, 'Copy last session')),
      h('p', { class: 'muted small' }, '✓ checked in · "in" said yes but didn\'t check in · wl on the waitlist'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'attendance-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Player'), a.sessions.map((x) => h('th', { class: 'num' }, day(x.startsAt))), h('th', { class: 'num' }, 'Came'))),
        h('tbody', {},
          a.players.map((p) => h('tr', {}, h('td', {}, p.name), a.sessions.map((x) => h('td', { class: `num${p.marks[x.id] === 'here' ? ' here' : ''}` }, mark[p.marks[x.id]] || '')), h('td', { class: 'num' }, h('strong', {}, p.came)))),
          h('tr', { class: 'totals' }, h('td', {}, 'Came / said in'), a.sessions.map((x) => h('td', { class: 'num' }, `${x.came}/${x.said}`)), h('td', {}, ''))))));
  }

  function groupSettings(g) {
    const s = g.settings;
    const sport = S.sports.find((x) => x.id === g.sport.id);
    const pointsField = sport && sport.fields.find((f) => f.key === 'points');
    const form = h('form', {
      class: 'card form',
      onsubmit: (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const days = fd.getAll('days').map(Number);
        saveForm(form, async () => {
          await api('PATCH', gPath(g.slug), {
            name: fd.get('name'), venue: fd.get('venue'), city: fd.get('city'), days, time: fd.get('time'), endTime: fd.get('endTime'),
            ...(fd.has('host') && { host: fd.get('host') || null }),
            levels: fd.getAll('levels'), open: fd.get('open') === 'on',
            courts: Number(fd.get('courts')), maxPlayers: fd.get('maxPlayers') || null, singles: fd.get('singles') === 'on',
            ...(pointsField && { scoring: { ...s.scoring, points: Number(fd.get('points')) } }),
          });
          await loadGroup();
        }, 'Settings saved');
      },
    },
    h('h2', {}, 'Settings'),
    field('Group name', h('input', { name: 'name', required: true, maxlength: 60, value: g.name })),
    groupField('Days', choiceGroup({ name: 'days', label: 'Days', multiple: true, value: s.days, options: [1, 2, 3, 4, 5, 6, 0].map((n) => ({ value: n, label: DAYS[n] })) })),
    h('div', { class: 'grid-2' },
      field('Start time', h('input', { name: 'time', type: 'time', required: true, value: s.time })),
      field('End time', h('input', { name: 'endTime', type: 'time', required: true, value: s.endTime || '' }))),
    h('div', { class: 'grid-2' },
      field(`${CAT.courtWord(g.sport.id)}s`, h('input', { name: 'courts', type: 'number', min: 1, max: 12, required: true, value: s.courts })),
      pointsField ? field('Games to', h('input', { name: 'points', type: 'number', min: pointsField.min || 5, max: pointsField.max || 50, value: s.scoring.points })) : null),
    h('div', { class: 'grid-2' },
      field('Max players (optional)', h('input', { name: 'maxPlayers', type: 'number', min: 2, max: 200, value: s.maxPlayers ?? '', placeholder: 'No limit' }), null, 'Extra RSVPs go on a waitlist.')),
    levelField(g.sport.id, s.levels),
    openField(s.open),
    h('label', { class: 'check-field' }, h('input', { type: 'checkbox', name: 'singles', checked: Boolean(s.singles) }),
      h('span', {}, h('strong', {}, 'Allow singles'), h('small', {}, 'When only 2 or 3 players are free, suggest a singles game.'))),
    h('div', { class: 'grid-2' },
      field('Venue', h('input', { name: 'venue', maxlength: 120, value: g.venue || '' })),
      field('City', h('input', { name: 'city', maxlength: 60, value: g.city || '' }))),
    groupHostField(g),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')));
    return [form,
      h('div', { class: 'card' }, h('h2', {}, 'Another slot'),
        h('p', { class: 'muted small' }, 'Run several slots a day (say, beginners then intermediates)? Each slot is its own group, so its RSVPs, games and rankings stay with that level.'),
        h('div', { class: 'actions' }, h('a', { class: 'btn', href: `/groups/new?copy=${encodeURIComponent(g.slug)}` }, 'Copy for another slot'))),
      h('div', { class: 'card' }, h('h2', {}, 'Invite link'),
        h('p', { class: 'muted small' }, 'Made a new link? The old one stops working (people already in the group stay).'),
        h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => confirm('Make a new invite link? The old one stops working.') && groupAct(() => api('PATCH', gPath(g.slug), { newInvite: true }), 'New invite link made') }, 'New invite link')))];
  }

  // ---------- a group game: score it live (players), or follow it
  const gQueues = new Map(); // game id -> [{ type: 'rally', side, ch, points?, foul?, end? } | { type: 'undo' }]
  let gSending = false;
  async function loadGroupGame() {
    const { slug, gid } = S.route;
    try {
      const [x, g] = await Promise.all([api('GET', `${gPath(slug)}/games/${gid}`), S.group && S.group.slug === slug ? S.group : api('GET', gPath(slug))]);
      if (S.route.gid === gid) { S.groupGame = x; S.group = g; S.error = null; }
    } catch (e) {
      S.error = e.message;
    }
    render(true);
    scheduleGroupPoll();
  }
  // The game with points still being sent, worked out locally (same rules as the server).
  function groupGameNow(g, x) {
    const ops = gQueues.get(x.id) || [];
    const sport = window.TonamentSports && window.TonamentSports[g.sport.id];
    if (!ops.length || !sport || x.final) return x;
    let log = x.log;
    for (const op of ops) log = op.type === 'rally' ? log + op.ch : log.slice(0, -1);
    const score = sport.compute(log, { ...g.settings.scoring, ...(x.a.length > 1 && { doubles: true }) }, x.firstServer);
    return { ...x, log, rallies: log.length, score, summary: sport.summary(score), status: score.winner ? 'done' : 'live', winner: score.winner || null, pending: ops.length };
  }
  function groupTap(g, x, op) {
    if (op.type === 'rally') {
      const tap = TonamentRally.tapFor(groupGameNow(g, x).score || {}, op);
      if (tap.error) return toast(tap.error, true);
      op = { ...op, ch: tap.ch };
    }
    gQueues.set(x.id, [...(gQueues.get(x.id) || []), op]);
    render();
    sendGroupQueue(g.slug, x.id);
  }
  async function sendGroupQueue(slug, gid) {
    if (gSending) return;
    gSending = true;
    try {
      while ((gQueues.get(gid) || []).length) {
        const op = gQueues.get(gid)[0];
        const at = S.groupGame.log.length;
        try {
          S.groupGame = await api('POST', `${gPath(slug)}/games/${gid}/${op.type}`, op.type === 'rally' ? tapBody(op, at) : { at });
          gQueues.set(gid, gQueues.get(gid).slice(1));
          S.offline = false;
        } catch (e) {
          if (e.network) { S.offline = true; render(); await new Promise((r) => setTimeout(r, 2000)); continue; }
          gQueues.set(gid, []);
          toast(e.message, true);
          await loadGroupGame();
        }
        render();
      }
    } finally {
      gSending = false;
    }
  }

  function viewGroupGame() {
    const g = S.group;
    const raw = S.groupGame;
    if (!g || !raw || raw.id !== S.route.gid) return loading();
    const x = groupGameNow(g, raw);
    document.title = `${teamName(x.a)} v ${teamName(x.b)} · ${g.name}`;
    const m = {
      a: { id: 'a', name: teamName(x.a) }, b: { id: 'b', name: teamName(x.b) },
      status: x.status === 'live' ? 'live' : 'done', winner: x.winner, summary: x.summary, score: x.score,
    };
    const finalForm = () => {
      const fa = h('input', { type: 'number', min: 0, max: 99, required: true, 'aria-label': teamName(x.a), inputmode: 'numeric' });
      const fb = h('input', { type: 'number', min: 0, max: 99, required: true, 'aria-label': teamName(x.b), inputmode: 'numeric' });
      return h('div', { class: 'card' },
        h('p', { class: 'muted small', style: 'margin-top:0' }, x.rallies ? `This replaces the ${x.rallies} point${x.rallies === 1 ? '' : 's'} scored live.` : 'Played it already? Enter how it ended.'),
        h('form', {
          class: 'final-form',
          onsubmit: (e) => { e.preventDefault(); act(async () => { S.groupGame = await api('POST', `${gPath(g.slug)}/games/${x.id}/result`, { a: Number(fa.value), b: Number(fb.value) }); }, 'Score saved — the other side confirms it'); },
        }, h('label', {}, h('span', {}, teamName(x.a)), fa), h('label', {}, h('span', {}, teamName(x.b)), fb), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save score')));
    };
    // Score live, or just the final score (remembered per game).
    S.gameMode = S.gameMode || {};
    const atEnd = Boolean(S.gameMode[x.id]);
    const modeSwitch = h('div', { class: 'seg score-mode', role: 'group', 'aria-label': 'How to score' },
      [[false, 'Score live'], [true, 'Final score']].map(([v, label]) => h('button', {
        'aria-pressed': String(atEnd === v), onclick: () => { S.gameMode[x.id] = v; render(); },
      }, label)));
    const tap = (s) => (x.score && x.score.tap && x.score.tap[s]) || '+1';
    const post = (what, msg) => act(async () => { S.groupGame = await api('POST', `${gPath(g.slug)}/games/${x.id}/${what}`, {}); }, msg);
    return [
      h('p', {}, h('a', { class: 'back-link', href: `/g/${g.slug}` }, `← ${g.name}`), x.court ? h('span', { class: 'muted small' }, ` · ${CAT.courtWord(g.sport.id)} ${x.court}`) : null),
      x.score ? scoreboard(m) : h('div', { class: 'card final-score' }, h('strong', {}, `${teamName(x.a)} ${x.final.a} – ${x.final.b} ${teamName(x.b)}`)),
      x.can.score && x.status === 'live' && !x.final ? modeSwitch : null,
      x.can.score && x.status === 'live' && !x.final && atEnd ? finalForm() : null,
      x.can.score && x.status === 'live' && !x.final && !atEnd ? h('div', { class: 'scorer' },
        x.score && x.score.taps && x.score.taps.max > 1
          ? pointPad(`g${x.id}`, x.score, { a: teamName(x.a), b: teamName(x.b) }, (extra) => groupTap(g, x, { type: 'rally', ...extra }))
          : h('div', { class: 'score-btns' }, ['a', 'b'].map((s) => h('button', { class: `score-btn side-${s}`, onclick: () => groupTap(g, x, { type: 'rally', side: s }) },
            h('span', { class: `sbtn-plus${tap(s) === '+1' ? '' : ' sbtn-word'}` }, tap(s)), h('span', { class: 'sbtn-name' }, teamName(x[s]))))),
        h('div', { class: `sync ${S.offline && x.pending ? 'offline' : x.pending ? 'saving' : 'saved'}`, role: 'status' },
          S.offline && x.pending ? `No connection — ${x.pending} point${x.pending === 1 ? '' : 's'} waiting` : x.pending ? 'Saving…' : 'All points saved'),
        h('div', { class: 'scorer-tools' }, h('button', { class: 'btn', disabled: !x.rallies, onclick: () => groupTap(g, x, { type: 'undo' }) }, '↶ Undo')),
        h('p', { class: 'hint center', style: 'margin:0' }, `${(x.score && x.score.hint) || 'Tap the side that won the rally.'} Everyone in the game sees the score live.`)) : null,
      x.status === 'live' && !x.can.score ? h('p', { class: 'muted small center' }, 'Live — the players are scoring this game.') : null,
      x.status !== 'live' ? h('div', { class: 'card' },
        h('h2', {}, x.status === 'confirmed' ? 'Confirmed ✓' : x.status === 'disputed' ? 'Disputed — an admin will check it' : x.status === 'void' ? 'Voided' : 'Game over'),
        x.status === 'done' ? h('p', { class: 'muted small' }, `${teamName(x[x.winner === 'a' ? 'b' : 'a'])} confirm the result. It confirms itself at ${fmtTime(x.confirmBy)}.`) : null,
        x.deltas ? h('p', { class: 'small' }, [...x.a, ...x.b].map((p) => `${p.name} ${x.deltas[p.id] >= 0 ? '+' : ''}${x.deltas[p.id]}`).join(' · ')) : null,
        h('div', { class: 'actions' },
          x.can.confirm ? h('button', { class: 'btn btn-primary', onclick: () => post('confirm', 'Result confirmed') }, x.status === 'disputed' ? 'Keep this result' : `Confirm ${x.summary}`) : null,
          x.can.dispute ? h('button', { class: 'btn btn-ghost', onclick: () => confirm('Flag this result for a group admin?') && post('dispute', 'Flagged for an admin') }, 'Something\'s wrong') : null,
          x.status !== 'live' && x.can.void && x.status !== 'confirmed' ? h('button', { class: 'btn btn-ghost danger', onclick: () => confirm('Void this game?') && post('void', 'Game voided') }, 'Void') : null,
          h('a', { class: 'btn', href: `/g/${g.slug}` }, 'Back to the group'))) : null,
      x.score ? gamesTable(m) : null,
    ];
  }

  // ---------- player profiles (tonament.com/p/<handle>)
  const FINISH_NAMES = { W: 'Winner', F: 'Runner-up', SF: 'Semi-final', QF: 'Quarter-final', R16: 'Last 16', R32: 'Last 32', G: 'Group stage' };
  const profileUrl = (handle) => `${location.origin}/p/${handle}`;
  const initialsOf = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  // An entry's name, with each player linked to their public profile.
  function entryName(e) {
    const people = e.people || [];
    if (!people.some((p) => p.handle)) return h('span', { class: 'entry-name' }, e.name);
    return h('span', { class: 'entry-name' }, people.map((p, i) => [i ? ' / ' : null,
      p.handle ? h('a', { class: 'player-link', href: `/p/${p.handle}` }, p.name) : p.name]));
  }

  // Organisers: which players are linked to accounts, and a form to link them.
  function entryPeople(t, e) {
    if (!t.can.manage || t.event.discipline === 'team' || e.source === 'drawn' || e.solo) return null;
    const people = e.people || [];
    const open = S.linking === e.id;
    const status = people.length
      ? h('small', { class: 'contact' }, people.map((p) => `${p.name}: ${p.linked ? '✓ on Tonament' : p.email ? `invited (${p.email})` : 'not linked'}`).join(' · '))
      : null;
    if (!open) {
      return [status, h('span', { class: 'fee-actions' }, h('button', { class: 'btn btn-small btn-ghost', onclick: () => { S.linking = e.id; render(); } }, people.some((p) => p.email) ? 'Edit players' : 'Link players'))];
    }
    const doubles = t.event.discipline === 'doubles';
    const names = doubles ? e.name.split(' / ') : [e.name];
    const rows = names.map((name, i) => h('div', { class: 'grid-2' },
      field(names.length > 1 ? `Player ${i + 1}` : 'Player', h('input', { 'data-k': 'name', maxlength: 40, value: (people[i] && people[i].name) || name })),
      field('Email', h('input', { 'data-k': 'email', type: 'email', maxlength: 120, value: (people[i] && people[i].email) || '', placeholder: 'Their Tonament email' }))));
    const form = h('form', {
      class: 'link-form',
      onsubmit: (ev) => {
        ev.preventDefault();
        const players = [...form.querySelectorAll('.grid-2')].map((row) => Object.fromEntries([...row.querySelectorAll('[data-k]')].map((x) => [x.dataset.k, x.value.trim()])));
        act(async () => { S.t = await api('PUT', `${tPath(t)}/entries/${e.id}/players`, { players }, t.id); S.linking = null; }, 'Players linked');
      },
    }, rows,
    h('p', { class: 'hint', style: 'margin:0' }, 'Their results and ranking points go on their Tonament profile. People without an account get them when they sign up with this email.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-small btn-primary', type: 'submit' }, 'Save'),
      h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick: () => { S.linking = null; render(); } }, 'Cancel')));
    return form;
  }

  // Organisers: whether a finished (or running) event counts for rankings.
  function rankedCard(t) {
    if (!t.can.manage || t.status === 'setup' || t.event.discipline === 'team' || t.event.discipline === 'any') return null;
    return h('div', { class: 'card' },
      h('label', { class: 'check-field', style: 'margin:0' },
        h('input', { type: 'checkbox', checked: t.config.ranked !== false, onchange: (e) => act(async () => { S.t = await api('PATCH', `${tPath(t)}/events/${t.eventId}`, { ranked: e.target.checked }, t.id); }, e.target.checked ? 'Counts for rankings' : 'Doesn\'t count for rankings') }),
        h('span', {}, h('strong', {}, 'Counts for rankings'), h('small', {}, 'Players\' ranking points from this event (public tournaments with 4+ entries). Untick for fun or social events — results still show on their profiles.'))));
  }

  // Pickleball organisers: seed by DUPR before the draw; download results for DUPR after.
  function duprTools(t) {
    if (t.sport.id !== 'pickleball' || !t.can.manage) return null;
    if (t.status === 'setup' && t.entries.length > 1) {
      return h('button', { class: 'btn btn-small btn-ghost', onclick: () => act(async () => { S.t = await api('POST', `${tPath(t)}/seed-dupr`, withEv(t, {}), t.id); }, 'Seeded by DUPR rating') }, 'Seed by DUPR');
    }
    if (t.matches.some((m) => m.status === 'done')) {
      return h('a', { class: 'btn btn-small btn-ghost', href: `/api${tPath(t)}/dupr.csv?event=${t.eventId}`, download: '' }, 'Download for DUPR');
    }
    return null;
  }

  async function loadProfile() {
    try {
      S.profile = await api('GET', '/me/profile');
    } catch (e) {
      S.error = e.message;
    }
    render();
  }

  function viewProfile() {
    document.title = 'Your profile · Tonament';
    const p = S.profile;
    if (!p) return loading();
    const key = { id: 'profile' };
    const save = (form, body, msg) => saveForm(form, async () => { S.profile = await api('PATCH', '/me/profile', body); }, msg);
    const url = profileUrl(p.handle);

    const details = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        const fd = new FormData(details);
        save(details, { name: fd.get('name'), handle: fd.get('handle'), city: fd.get('city'), region: fd.get('region'), sports: fd.getAll('sports'), bio: fd.get('bio') }, 'Profile saved');
      },
    },
    field('Name', h('input', { name: 'name', required: true, maxlength: 60, value: p.name, autocomplete: 'name' }), null, 'As it appears on entry lists and rankings.'),
    field('Profile address', h('div', { class: 'slug-input' }, h('span', { class: 'muted' }, 'tonament.com/p/'), h('input', { name: 'handle', required: true, maxlength: 30, value: p.handle, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Profile address' }))),
    h('div', { class: 'grid-2' },
      field('City', h('input', { name: 'city', maxlength: 60, value: p.city || '', list: 'profile-cities' }), null, 'For your city ranking.'),
      field('State', h('input', { name: 'region', maxlength: 60, value: p.region || '', list: 'profile-states' }))),
    h('datalist', { id: 'profile-cities' }, cityOptions(REGIONS.defaultCountry).map((c) => h('option', { value: c }))),
    h('datalist', { id: 'profile-states' }, (REGIONS.regionsFor(REGIONS.defaultCountry) || []).map((c) => h('option', { value: c }))),
    groupField('Sports you play', choiceGroup({ name: 'sports', label: 'Sports', value: p.sportIds, multiple: true, options: S.sports.map((x) => ({ value: x.id, label: x.name, icon: x.id })) })),
    field('About you', h('textarea', { name: 'bio', rows: 3, maxlength: 600, value: p.bio || '', placeholder: 'Club, coach, favourite event, achievements…' })),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')));

    const upload = (files) => {
      const file = files[0];
      if (!file) return;
      S.uploading = 1;
      render();
      (async () => {
        try {
          const data = await prepareImage(file, 'logo');
          S.profile = await api('POST', '/me/profile/media', { data });
          toast('Photo updated ✓');
        } catch (e) {
          toast(e.message, true);
        } finally {
          S.uploading = 0;
          render();
        }
      })();
    };
    const photo = h('div', { class: 'form' },
      h('div', { class: 'brand-row' },
        p.photo ? h('img', { class: 'logo-preview round', src: p.photo, alt: 'Your photo' }) : h('span', { class: 'logo-preview round initials' }, initialsOf(p.name)),
        h('div', { class: 'actions' },
          h('label', { class: 'btn btn-small' }, p.photo ? 'Replace photo' : 'Upload photo',
            h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => { upload(e.target.files); e.target.value = ''; } })),
          p.photo ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => act(async () => { S.profile = await api('DELETE', '/me/profile/media'); }, 'Photo removed') }, 'Remove') : null)),
      S.uploading ? h('p', { class: 'hint uploading', role: 'status' }, 'Uploading…') : null);

    const D = p.dupr || {};
    const duprForm = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        const fd = new FormData(duprForm);
        const body = { duprId: fd.get('duprId') || '' };
        if (!D.verified) Object.assign(body, { duprDoubles: fd.get('duprDoubles') || '', duprSingles: fd.get('duprSingles') || '' });
        save(duprForm, body, 'DUPR saved');
      },
    },
    h('p', { class: 'hint', style: 'margin:0' }, 'For pickleball. Organisers can seed by DUPR and set rating limits for events.'),
    field('DUPR ID', h('input', { name: 'duprId', maxlength: 12, value: D.id || '', placeholder: 'e.g. 4DGE5W', autocomplete: 'off', style: 'text-transform:uppercase' }), null, 'In the DUPR app, under your name.'),
    h('div', { class: 'grid-2' },
      field('Doubles rating', h('input', { name: 'duprDoubles', type: 'number', step: '0.001', min: 2, max: 8, value: D.doubles ?? '', disabled: D.verified || null, placeholder: 'e.g. 3.512' })),
      field('Singles rating', h('input', { name: 'duprSingles', type: 'number', step: '0.001', min: 2, max: 8, value: D.singles ?? '', disabled: D.verified || null }))),
    D.verified
      ? h('p', { class: 'hint org-perk' }, '✓ Verified with DUPR — ratings update from DUPR. ', h('button', { type: 'button', class: 'link-btn', onclick: () => act(async () => { S.profile = await api('DELETE', '/me/dupr'); }, 'Disconnected from DUPR') }, 'Disconnect'))
      : h('p', { class: 'hint', style: 'margin:0' }, 'Ratings you type are shown as "self-reported".'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
      p.duprConnect && !D.verified ? h('button', {
        type: 'button', class: 'btn',
        onclick: () => act(async () => { S.profile = await api('POST', '/me/dupr', { duprId: duprForm.duprId.value }); }, 'Connected to DUPR ✓'),
      }, 'Connect with DUPR') : null));

    const notMe = (entryId) => confirm('Take yourself off this entry? Its results and points leave your profile.')
      && act(async () => { S.profile = await api('POST', `/me/entries/${entryId}/not-me`, {}); }, 'Removed from your profile');

    return [
      h('div', { class: 'org-edit-head' },
        p.photo ? h('img', { class: 'org-edit-logo round', src: p.photo, alt: '' }) : h('span', { class: 'org-edit-logo round initials' }, initialsOf(p.name)),
        h('div', { class: 'org-edit-title' },
          h('h1', {}, p.name),
          h('p', { class: 'muted small' }, [`tonament.com/p/${p.handle}`, [p.city, p.region].filter(Boolean).join(', ')].filter(Boolean).join(' · '))),
        h('div', { class: 'actions' },
          h('a', { class: 'btn btn-small', href: `/p/${p.handle}?me=1`, target: '_blank', rel: 'noopener' }, 'View page'),
          p.public ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => (navigator.share ? navigator.share({ title: p.name, url }).catch(() => {}) : copy(url, 'Link copied')) }, 'Share') : null)),
      h('div', { class: `card org-status ${p.public ? 'live' : 'draft'}` },
        h('label', { class: 'check-field switch-field', style: 'margin:0' },
          h('input', { type: 'checkbox', role: 'switch', checked: p.public, onchange: (e) => act(async () => { S.profile = await api('PATCH', '/me/profile', { public: e.target.checked }); }, e.target.checked ? 'Your profile is public' : 'Your profile is private') }),
          h('span', {}, h('strong', {}, p.public ? 'Public profile' : 'Private profile'),
            h('small', {}, p.public
              ? 'Anyone can see your results and rankings. Your email and phone are never shown.'
              : 'Only you can see it, and you\'re left out of rankings. Your name still shows in draws you play in.')))),
      p.rankings.length ? h('div', { class: 'card' }, h('h2', {}, 'Your rankings'),
        h('ul', { class: 'org-t-list' }, p.rankings.map((r) => h('li', {},
          h('a', { href: `/rankings/${r.sport}/${r.category}` }, `#${r.rank} ${r.name}`),
          h('span', { class: 'muted small' }, [r.sportName, `${r.points} pts`, r.results > 6 ? `best 6 of ${r.results} results` : `${r.results} result${r.results === 1 ? '' : 's'}`, r.cityRank && r.city ? `#${r.cityRank} in ${r.city}` : null].filter(Boolean).join(' · ')))))) : null,
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Your groups'), h('a', { class: 'btn btn-small btn-ghost', href: '/groups/new' }, 'Create a group')),
        (p.groups || []).length
          ? h('ul', { class: 'org-t-list' }, p.groups.map((x) => h('li', {},
            h('a', { href: `/g/${x.slug}` }, x.name),
            h('span', { class: 'muted small' }, x.games
              ? [x.sportName, `rating ${x.rating}`, x.rank ? `#${x.rank} of ${x.ranked}` : null, `${x.wins}–${x.games - x.wins}`].filter(Boolean).join(' · ')
              : `${x.sportName} · no games yet`))))
          : h('p', { class: 'muted small', style: 'margin:0' }, 'Play with the same people regularly? A group handles RSVPs, fair games and live scores — and gives everyone a rating.')),
      p.entries.length ? h('div', { class: 'card' }, h('h2', {}, 'Your entries'),
        h('ul', { class: 'org-t-list' }, p.entries.map((x) => h('li', {},
          h('a', { href: `/t/${x.tournamentId}` }, x.tournament),
          h('span', { class: 'muted small' }, [x.event, x.startsOn ? fmtDates(x.startsOn) : null, x.mine ? null : 'entered by your partner'].filter(Boolean).join(' · ')),
          x.mine ? null : h('button', { class: 'btn btn-small btn-ghost', onclick: () => notMe(x.entryId) }, 'Not me'))))) : null,
      panel(key, 'details', 'Profile · name, city, sports', details),
      panel(key, 'photo', p.photo ? 'Photo' : 'Photo · add one', photo),
      panel(key, 'dupr', `DUPR${D.doubles != null ? ` · ${Number(D.doubles).toFixed(3)}` : D.id ? ` · ${D.id}` : ''}`, duprForm),
      h('div', { class: 'card' }, h('h2', {}, `Results (${p.results.length})`),
        p.results.length
          ? h('ol', { class: 'result-list' }, p.results.map((r) => h('li', {},
            h('div', { class: 'result-head' }, h('span', { class: `finish finish-${r.finish.toLowerCase()}` }, FINISH_NAMES[r.finish] || r.finish), h('a', { href: `/t/${r.tournamentId}` }, r.tournament)),
            h('p', { class: 'muted small' }, [r.event, r.city, `${r.won}–${r.lost}`, r.points ? `${r.points} ranking pts` : 'no ranking points'].filter(Boolean).join(' · ')),
            r.mine === false ? h('button', { class: 'link-btn small', onclick: () => notMe(r.entryId) }, 'Not me') : null)))
          : empty('Your results appear here when events you play in finish.')),
    ];
  }

  // ---------- academy, venue and club pages (tonament.com/@slug)
  const ORG_KINDS = [
    { value: 'academy', label: 'Academy', icon: 'academy', hint: 'Coaching and training' },
    { value: 'venue', label: 'Venue', icon: 'venue', hint: 'Courts to book and play' },
    { value: 'club', label: 'Club', icon: 'club', hint: 'Members who play together' },
  ];
  const orgPrice = () => money((S.billing && S.billing.orgPrice) || 299900);
  const fmtDate = (iso) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  const orgPath = (slug) => `/orgs/${encodeURIComponent(slug)}`;

  // The pages I belong to (for the account menu and the tournament picker).
  async function loadMyOrgs() {
    if (!S.me) { S.myOrgs = []; return; }
    const who = S.me.id;
    S.myOrgsFor = who;
    const list = await api('GET', '/orgs/mine').catch(() => []);
    if (!S.me || S.me.id !== who) return;
    S.myOrgs = list;
    navFor = null; // the menu shows "Your academy"
    render();
  }
  const ensureMyOrgs = () => { if (S.me && S.myOrgsFor !== S.me.id) loadMyOrgs(); };

  // Create: kind -> name and address -> sports, then the editor opens.
  function viewOrgNew() {
    document.title = 'Create your academy page · Tonament';
    const d = (S.orgDraft ||= { step: 1, kind: null, name: '', slug: '', slugEdited: false, city: '', address: '', sports: [], check: null });
    const go = (step) => { d.step = step; render(); window.scrollTo(0, 0); };
    const head = h('div', { class: 'new-head' },
      d.step > 1 ? h('button', { type: 'button', class: 'back-link', onclick: () => go(d.step - 1) }, '← Back') : h('span'),
      h('span', { class: 'new-progress', 'aria-label': `Step ${d.step} of 3` }, `Step ${d.step} of 3`,
        h('span', { class: 'dots', 'aria-hidden': 'true' }, [1, 2, 3].map((n) => h('span', { class: n <= d.step ? 'on' : '' })))));

    if (d.step === 1) {
      return h('div', { class: 'card new-flow' }, head,
        h('h1', {}, 'Your page on Tonament'),
        h('p', { class: 'muted' }, `A page of your own at tonament.com/@yourname: your profile, contact buttons, courts and coaching, photos and every tournament you run. ${orgPrice()} a year — build it free, pay when you publish.`),
        h('h2', {}, 'What are you?'),
        choiceGroup({
          name: 'kind', label: 'Kind', value: d.kind, tiles: true, options: ORG_KINDS,
          onchange: (e) => { d.kind = e.target.value; go(2); },
        }));
    }

    if (d.step === 2) {
      const kindName = ORG_KINDS.find((k) => k.value === d.kind).label.toLowerCase();
      const status = h('small', { class: 'hint slug-status', 'aria-live': 'polite' });
      const slugInput = h('input', { name: 'slug', required: true, maxlength: 30, value: d.slug, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Page address' });
      const next = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Next');
      let timer;
      const check = () => {
        clearTimeout(timer);
        const value = slugInput.value.trim();
        if (!value) { status.textContent = ''; return; }
        timer = setTimeout(async () => {
          const r = await api('GET', `/orgs/slug?name=${encodeURIComponent(value)}`).catch(() => null);
          if (!r || slugInput.value.trim() !== value) return;
          d.check = r;
          if (r.slug !== value && !d.slugEdited) slugInput.value = r.slug;
          status.textContent = r.available ? `✓ tonament.com/@${r.slug} is free` : `tonament.com/@${r.slug}: ${r.reason}`;
          status.className = `hint slug-status ${r.available ? 'ok' : 'bad'}`;
        }, 250);
      };
      const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '');
      const form = h('form', {
        class: 'card new-flow form',
        onsubmit: (e) => {
          e.preventDefault();
          const fd = new FormData(form);
          Object.assign(d, { name: fd.get('name').trim(), slug: slugify(fd.get('slug')), city: fd.get('city').trim(), address: fd.get('address').trim() });
          if (d.check && d.check.slug === d.slug && !d.check.available) { toast(`tonament.com/@${d.slug}: ${d.check.reason}`, true); return; }
          go(3);
        },
      }, head,
      h('h2', {}, `About your ${kindName}`),
      field('Name', h('input', {
        name: 'name', required: true, maxlength: 80, value: d.name, autocomplete: 'off', placeholder: d.kind === 'venue' ? 'e.g. Smashpoint Sports Arena' : 'e.g. Smashpoint Badminton Academy',
        oninput: (e) => { d.name = e.target.value; if (!d.slugEdited) { slugInput.value = slugify(e.target.value); d.slug = slugInput.value; check(); } },
      })),
      field('Page address', h('div', { class: 'slug-input' }, h('span', { class: 'muted' }, 'tonament.com/@'), slugInput), null, null),
      status,
      h('div', { class: 'grid-2' },
        field('City', h('input', { name: 'city', required: true, maxlength: 60, value: d.city, list: 'org-cities', autocomplete: 'address-level2' })),
        field('Area or street (optional)', h('input', { name: 'address', maxlength: 160, value: d.address, autocomplete: 'street-address' }))),
      h('datalist', { id: 'org-cities' }, cityOptions(REGIONS.defaultCountry).map((c) => h('option', { value: c }))),
      h('div', { class: 'actions' }, next));
      slugInput.addEventListener('input', () => { d.slugEdited = true; d.slug = slugInput.value; check(); });
      if (d.slug) check();
      return form;
    }

    const live = liveSports();
    const create = h('button', { type: 'button', class: 'btn btn-primary btn-lg', disabled: !d.sports.length }, 'Create my page');
    const picks = choiceGroup({
      name: 'sports', label: 'Sports', value: d.sports, multiple: true, tiles: true,
      options: S.sports.map((x) => ({ value: x.id, label: x.name, icon: x.id })),
      onchange: () => {
        d.sports = [...picks.querySelectorAll('input:checked')].map((x) => x.value);
        create.disabled = !d.sports.length;
      },
    });
    create.onclick = async () => {
      create.disabled = true;
      try {
        const o = await api('POST', '/orgs', { kind: d.kind, name: d.name, slug: d.slug, city: d.city, address: d.address, country: REGIONS.defaultCountry, sports: d.sports });
        S.orgDraft = null;
        S.org = o;
        S.myOrgsFor = null;
        toast('Page created — add your details, then publish');
        navigate(`/@${o.slug}/edit`);
      } catch (err) {
        toast(err.message, true);
        create.disabled = false;
        if (err.status === 409 || /address/i.test(err.message)) go(2);
      }
    };
    return h('div', { class: 'card new-flow' }, head,
      h('h2', {}, 'Which sports?'),
      h('p', { class: 'muted small' }, `Tap all that ${d.name || 'you'} ${d.kind === 'venue' ? 'has courts for' : 'offers'}.`),
      picks,
      live.length < S.sports.length ? h('p', { class: 'muted small' }, 'Tournaments run for the sports marked live; the rest can still be on your page.') : null,
      h('div', { class: 'actions' }, create));
  }

  // The editor: status and payment, then a panel per part of the page.
  function viewOrgEdit() {
    const o = S.org;
    if (!o) return loading();
    document.title = `${o.name} · Edit page · Tonament`;
    if (!o.can.edit) return errorView('Only this page\'s team can edit it.');
    const key = { id: `org-${o.slug}` }; // panels remember which are open
    const pageUrl = `${location.origin}/@${o.slug}`;
    const save = (form, body, msg) => saveForm(form, async () => { S.org = await api('PATCH', orgPath(o.slug), body); }, msg);

    // Status: draft, live, in its grace period or hidden.
    const now = Date.now();
    const paidUntil = o.paidUntil ? Date.parse(o.paidUntil) : null;
    const state = !paidUntil ? 'draft' : o.live ? 'live' : o.public ? 'grace' : 'lapsed';
    const pay = async () => {
      if (S.paying) return;
      S.paying = true;
      render();
      try {
        const order = await api('POST', `${orgPath(o.slug)}/checkout`, {});
        const result = await payEntry(order);
        if (result === 'paid') {
          S.org = await api('GET', orgPath(o.slug));
          S.myOrgsFor = null;
          toast(state === 'draft' ? 'Paid — your page is live ✓' : 'Paid — renewed for another year ✓');
        } else if (result === 'failed') toast('The payment didn\'t go through — nothing was charged', true);
      } catch (e) {
        toast(e.message, true);
      } finally {
        S.paying = false;
        render();
      }
    };
    const payBtn = (label) => (o.can.own
      ? h('button', { class: 'btn btn-primary', disabled: S.paying || null, onclick: pay }, S.paying ? 'Opening payment…' : label)
      : h('p', { class: 'muted small' }, 'Only the page owner can pay.'));
    const soon = paidUntil && paidUntil - now < 30 * 86400000;
    const status = h('div', { class: `card org-status ${state}` },
      state === 'draft' ? [
        h('h2', {}, 'Draft · only your team can see it'),
        h('p', { class: 'muted small' }, `Publish to put it on tonament.com/@${o.slug}, in search results and on Google. ${orgPrice()} for a year.`),
        h('div', { class: 'actions' }, payBtn(`Publish for ${orgPrice()}/year`)),
      ] : state === 'live' ? [
        h('h2', {}, `Live · until ${fmtDate(o.paidUntil)}`),
        h('p', { class: 'muted small' }, soon ? 'Renew now: the new year starts when this one ends.' : 'Renewing early adds a year to the end.'),
        h('div', { class: 'actions' }, soon ? payBtn(`Renew for ${orgPrice()}`) : (o.can.own ? h('button', { class: 'btn btn-small', disabled: S.paying || null, onclick: pay }, `Renew early · ${orgPrice()}`) : null)),
      ] : state === 'grace' ? [
        h('h2', {}, `Expired on ${fmtDate(o.paidUntil)}`),
        h('p', { class: 'muted small' }, `Still public until ${fmtDate(o.graceUntil)}. Renew to keep it up.`),
        h('div', { class: 'actions' }, payBtn(`Renew for ${orgPrice()}`)),
      ] : [
        h('h2', {}, 'Hidden · the year has ended'),
        h('p', { class: 'muted small' }, `It expired on ${fmtDate(o.paidUntil)}. Your details and photos are kept — renew to publish it again.`),
        h('div', { class: 'actions' }, payBtn(`Renew for ${orgPrice()}`)),
      ],
      o.brandingIncluded ? h('p', { class: 'hint org-perk' }, '✓ Includes your branding on every tournament linked to this page: logo, sponsors and your name on the venue display.') : null);

    // Profile: name, kind, sports, about.
    const profile = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        const fd = new FormData(profile);
        save(profile, { name: fd.get('name'), kind: fd.get('kind'), sports: fd.getAll('sports'), about: fd.get('about') }, 'Profile saved');
      },
    },
    field('Name', h('input', { name: 'name', required: true, maxlength: 80, value: o.name })),
    groupField('Kind', choiceGroup({ name: 'kind', label: 'Kind', value: o.kind, options: ORG_KINDS.map((k) => ({ value: k.value, label: k.label, icon: k.icon })) })),
    groupField('Sports', choiceGroup({ name: 'sports', label: 'Sports', value: o.sports.map((x) => x.id), multiple: true, options: S.sports.map((x) => ({ value: x.id, label: x.name, icon: x.id })) })),
    field('About', h('textarea', { name: 'about', rows: 6, maxlength: 3000, value: o.about || '', placeholder: 'Who you are, since when, your coaches, achievements, what makes you different…' }), null, 'Links become clickable. Up to 3,000 characters.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')));

    // Contact and location: the buttons on the page.
    const L = o.location;
    const C = o.contact;
    const contact = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        const fd = new FormData(contact);
        const body = Object.fromEntries(['phone', 'whatsapp', 'email', 'website', 'instagram', 'address', 'city', 'region', 'postcode'].map((k) => [k, fd.get(k) || '']));
        save(contact, body, 'Contact details saved');
      },
    },
    h('div', { class: 'grid-2' },
      field('Phone', h('input', { name: 'phone', type: 'tel', maxlength: 20, value: C.phone || '', autocomplete: 'tel' }), null, 'Shown as a Call button.'),
      field('WhatsApp', h('input', { name: 'whatsapp', type: 'tel', maxlength: 20, value: C.whatsapp || '', placeholder: '+91…' }), null, 'Players can message you in one tap.')),
    h('div', { class: 'grid-2' },
      field('Email', h('input', { name: 'email', type: 'email', maxlength: 120, value: C.email || '' })),
      field('Website', h('input', { name: 'website', maxlength: 200, value: C.website || '', placeholder: 'yoursite.com' }))),
    field('Instagram', h('input', { name: 'instagram', maxlength: 120, value: C.instagram ? `@${C.instagram}` : '', placeholder: '@yourhandle' })),
    field('Address', h('input', { name: 'address', maxlength: 160, value: L.address || '', autocomplete: 'street-address' }), null, 'Used for the Directions button (Google Maps).'),
    h('div', { class: 'grid-2' },
      field('City', h('input', { name: 'city', maxlength: 60, value: L.city || '', list: 'org-cities' })),
      field('State', h('input', { name: 'region', maxlength: 60, value: L.region || '' }))),
    field('PIN code', h('input', { name: 'postcode', maxlength: 12, value: L.postcode || '', inputmode: 'numeric' }), 'narrow'),
    h('datalist', { id: 'org-cities' }, cityOptions(REGIONS.defaultCountry).map((c) => h('option', { value: c }))),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')));

    const courts = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        const fd = new FormData(courts);
        save(courts, { courts: fd.get('courts'), timings: fd.get('timings') }, 'Courts and timings saved');
      },
    },
    field('Courts', h('textarea', { name: 'courts', rows: 2, maxlength: 300, value: o.courts || '', placeholder: 'e.g. 6 wooden courts with mats, 2 synthetic. Shuttles provided.' })),
    field('Timings', h('textarea', { name: 'timings', rows: 2, maxlength: 300, value: o.timings || '', placeholder: 'e.g. Mon–Sat 5–10 am and 4–10 pm, Sun 6 am–12 pm' })),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')));

    // Coaching programmes: a short list of cards.
    const coachRow = (c = {}) => h('li', { class: 'coach-row' },
      h('div', { class: 'grid-2' },
        field('Programme', h('input', { 'data-k': 'title', maxlength: 80, value: c.title || '', placeholder: 'e.g. Beginners batch' })),
        field('Who it\'s for', h('input', { 'data-k': 'who', maxlength: 120, value: c.who || '', placeholder: 'e.g. Ages 6–12' }))),
      h('div', { class: 'grid-2' },
        field('When', h('input', { 'data-k': 'when', maxlength: 120, value: c.when || '', placeholder: 'e.g. Mon, Wed, Fri 5–6 pm' })),
        field('Fee', h('input', { 'data-k': 'fee', maxlength: 60, value: c.fee || '', placeholder: 'e.g. ₹3,000/month' }))),
      h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: (e) => { const f = e.target.form; e.target.closest('li').remove(); f.setAttribute('data-dirty', ''); syncAdd(f); } }, 'Remove'));
    const coachList = h('ol', { class: 'coach-list' }, (o.coaching.length ? o.coaching : [{}]).map(coachRow));
    const addBtn = h('button', { type: 'button', class: 'btn btn-small' }, '+ Add a programme');
    const syncAdd = () => { addBtn.disabled = coachList.children.length >= 10; };
    addBtn.onclick = () => { coachList.append(coachRow()); syncAdd(); coachList.lastChild.querySelector('input').focus(); };
    syncAdd();
    const coaching = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        const list = [...coachList.children].map((li) => Object.fromEntries([...li.querySelectorAll('[data-k]')].map((x) => [x.dataset.k, x.value.trim()])))
          .filter((c) => c.title || c.who || c.when || c.fee);
        if (list.some((c) => !c.title)) { toast('Give each programme a name', true); return; }
        save(coaching, { coaching: list }, 'Coaching saved');
      },
    }, coachList, h('div', { class: 'actions' }, addBtn, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save')));

    // Logo, cover and photos upload as soon as they're chosen.
    const upload = (kind, files) => {
      const list = [...files];
      if (!list.length) return;
      S.uploading = (S.uploading || 0) + list.length;
      render();
      (async () => {
        for (const file of list) {
          try {
            const data = await prepareImage(file, kind);
            S.org = await api('POST', `${orgPath(o.slug)}/media`, { kind, data });
            toast(kind === 'photo' ? 'Photo added ✓' : kind === 'cover' ? 'Cover updated ✓' : 'Logo updated ✓');
          } catch (e) {
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
    const removeMedia = (id, msg) => act(async () => { S.org = await api('DELETE', `${orgPath(o.slug)}/media/${id}`); }, msg);
    const limit = o.photoLimit || 24;
    const photos = h('div', { class: 'form' },
      h('fieldset', { class: 'details-set' }, h('legend', {}, 'Logo'),
        h('div', { class: 'brand-row' },
          o.logo ? h('img', { class: 'logo-preview', src: o.logo, alt: 'Logo' }) : h('span', { class: 'logo-preview empty' }, 'Logo'),
          h('div', { class: 'actions' },
            fileButton(o.logo ? 'Replace logo' : 'Upload logo', 'logo'),
            o.logo ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => removeMedia(o.logoId, 'Logo removed') }, 'Remove') : null))),
      h('fieldset', { class: 'details-set' }, h('legend', {}, 'Cover photo'),
        o.cover ? h('img', { class: 'cover-preview', src: o.cover, alt: 'Cover' }) : h('p', { class: 'hint', style: 'margin:0' }, 'A wide photo of your courts or players — across the top of the page.'),
        h('div', { class: 'actions' },
          fileButton(o.cover ? 'Replace cover' : 'Upload cover', 'cover'),
          o.cover ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => removeMedia(o.coverId, 'Cover removed') }, 'Remove') : null)),
      h('fieldset', { class: 'details-set' }, h('legend', {}, `Gallery (${o.photos.length} of ${limit})`),
        o.photos.length
          ? h('ul', { class: 'org-photo-grid' }, o.photos.map((p) => h('li', {},
            h('img', { src: p.url, alt: p.caption || '' }),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Delete photo', onclick: () => confirm('Delete this photo?') && removeMedia(p.id, 'Photo deleted') }, '✕'))))
          : h('p', { class: 'hint', style: 'margin:0' }, 'Courts, coaching sessions, tournaments, trophies.'),
        h('div', { class: 'actions' }, fileButton('Add photos', 'photo', true, o.photos.length >= limit))),
      S.uploading ? h('p', { class: 'hint uploading', role: 'status' }, `Uploading ${S.uploading} image${S.uploading > 1 ? 's' : ''}…`) : null);

    // Team: the owner adds editors by email.
    const emailInput = h('input', { name: 'email', type: 'email', required: true, placeholder: 'name@example.com', autocomplete: 'off', 'aria-label': 'Email' });
    const team = h('div', { class: 'form' },
      h('ul', { class: 'members' }, (o.members || []).map((m) => h('li', {},
        h('div', { class: 'name' }, m.email),
        pill(m.role === 'owner' ? 'org' : '', m.role === 'owner' ? 'Owner' : 'Editor'),
        o.can.own && m.role !== 'owner' ? h('button', {
          class: 'icon-btn', 'aria-label': `Remove ${m.email}`,
          onclick: () => confirm(`Remove ${m.email}?`) && act(async () => { S.org = await api('DELETE', `${orgPath(o.slug)}/members/${encodeURIComponent(m.email)}`); }, 'Removed'),
        }, '✕') : null))),
      o.can.own ? h('form', {
        class: 'team-form',
        onsubmit: (e) => {
          e.preventDefault();
          const email = emailInput.value;
          act(async () => { S.org = await api('POST', `${orgPath(o.slug)}/members`, { email }); }, `${email} can now edit this page`);
        },
      }, emailInput, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add editor')) : null,
      h('p', { class: 'hint', style: 'margin:0' }, 'Editors can change the page and link their tournaments to it. Only the owner pays and manages the team.'));

    // Tournaments: linked ones, and a quick way to link more.
    if (S.mine === undefined || S.mineFor !== S.me.id) {
      S.mineFor = S.me.id;
      S.mine = null;
      api('GET', '/me/tournaments').then((l) => { S.mine = l; render(); }, () => { S.mine = []; render(); });
    }
    const linked = new Set(o.tournaments.map((t) => t.id));
    const unlinked = (S.mine || []).filter((t) => !linked.has(t.id) && ['owner', 'organiser'].includes(t.role));
    const link = (id, slug, msg) => act(async () => { await api('POST', `/tournaments/${encodeURIComponent(id)}/org`, { org: slug }, id); S.org = await api('GET', orgPath(o.slug)); }, msg);
    const picker = h('select', { class: 'grow', 'aria-label': 'Tournament to add' }, h('option', { value: '' }, 'Choose a tournament…'), unlinked.map((t) => h('option', { value: t.id }, t.name)));
    const tournaments = h('div', { class: 'card' },
      h('h2', {}, `Tournaments (${o.tournaments.length})`),
      h('p', { class: 'muted small' }, 'Public tournaments linked here show on your page: upcoming ones first, then live and past results.'),
      o.tournaments.length ? h('ul', { class: 'org-t-list' }, o.tournaments.map((t) => h('li', {},
        h('a', { href: `/t/${t.id}` }, t.name),
        h('span', { class: 'muted small' }, [fmtSchedule(t), t.visibility === 'public' ? null : 'not public — hidden on the page'].filter(Boolean).join(' · ')),
        h('button', { class: 'btn btn-small btn-ghost', onclick: () => link(t.id, null, `${t.name} removed from the page`) }, 'Remove')))) : null,
      unlinked.length ? h('div', { class: 'search-row' }, picker,
        h('button', { class: 'btn btn-primary', onclick: () => picker.value && link(picker.value, o.slug, 'Added to your page') }, 'Add')) : null,
      h('p', { class: 'hint', style: 'margin:0' }, unlinked.length ? 'Or link one from its Team tab.' : h('span', {}, 'New tournaments can be linked from their Team tab. ', h('a', { href: '/new' }, 'Create a tournament'))));

    return [
      h('div', { class: 'org-edit-head' },
        o.logo ? h('img', { class: 'org-edit-logo', src: o.logo, alt: '' }) : null,
        h('div', { class: 'org-edit-title' },
          h('h1', {}, o.name),
          h('p', { class: 'muted small' }, [`tonament.com/@${o.slug}`, o.kindName, o.location.city].filter(Boolean).join(' · '))),
        h('div', { class: 'actions' },
          h('a', { class: 'btn btn-small', href: o.public ? `/@${o.slug}` : `/@${o.slug}?preview=1`, target: '_blank', rel: 'noopener' }, o.public ? 'View page' : 'Preview'),
          o.public ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => copy(pageUrl, 'Link copied') }, 'Copy link') : null)),
      status,
      panel(key, 'profile', 'Profile · name, sports, about', profile),
      panel(key, 'photos', `Logo and photos · ${[o.logo ? 'logo' : null, o.cover ? 'cover' : null, `${o.photos.length} photo${o.photos.length === 1 ? '' : 's'}`].filter(Boolean).join(', ')}`, photos),
      panel(key, 'contact', 'Contact and location · WhatsApp, call, directions', contact),
      panel(key, 'courts', 'Courts and timings', courts),
      panel(key, 'coaching', `Coaching programmes${o.coaching.length ? ` · ${o.coaching.length}` : ''}`, coaching),
      tournaments,
      h('div', { class: 'card' },
        h('h2', {}, 'Groups that play here'),
        h('p', { class: 'muted small' }, 'Run your regular games as groups: players RSVP from WhatsApp with the time they\'re coming, check in, and get fair games. They show on your page under "Play here" so new players can join. For academies, a group per batch doubles as the attendance register.'),
        h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: `/groups/new?host=${encodeURIComponent(o.slug)}` }, 'Start a group here'))),
      panel(key, 'team', `Team · ${(o.members || []).length} ${(o.members || []).length === 1 ? 'person' : 'people'}`, team),
    ];
  }

  // On a tournament's Team tab: show it on one of my academy pages.
  function orgLinkCard(t) {
    if (!t.can.manage) return null;
    ensureMyOrgs();
    const mine = S.myOrgs || [];
    if (!mine.length && !t.org) {
      return h('div', { class: 'card' },
        h('h2', {}, 'Academy page'),
        h('p', { class: 'muted small' }, `Run an academy, venue or club? Get a page of your own at tonament.com/@yourname with all your tournaments, contact buttons, coaching and photos — ${orgPrice()} a year.`),
        h('div', { class: 'actions' }, h('a', { class: 'btn btn-small', href: '/academy/new' }, 'Create your page')));
    }
    const link = (slug) => act(async () => {
      const r = await api('POST', `${tPath(t)}/org`, { org: slug || null }, t.id);
      await load(t.id);
      toast(r.org ? `Shown on ${r.org.name}'s page` : 'Removed from the academy page');
    });
    const options = [{ value: '', label: 'None' }, ...mine.map((x) => ({ value: x.slug, label: x.name }))];
    if (t.org && !mine.some((x) => x.slug === t.org.slug)) options.push({ value: t.org.slug, label: t.org.name, disabled: true });
    return h('div', { class: 'card' },
      h('h2', {}, 'Academy page'),
      h('p', { class: 'muted small' }, 'Show this tournament on your academy, venue or club page (when it\'s public).'),
      choiceGroup({ name: 'org', label: 'Academy page', value: t.org ? t.org.slug : '', options, onchange: (e) => link(e.target.value) }),
      t.org ? h('p', { class: 'hint' }, h('a', { href: `/@${t.org.slug}`, target: '_blank', rel: 'noopener' }, `tonament.com/@${t.org.slug}`)) : null);
  }

  const PLAN_LABELS = { pass: 'Event Pass', club: 'Club', open: 'Open', championship: 'Championship' };

  // ---------- site admin dashboard (/admin?tab=…)
  const ADMIN_TABS = [['overview', 'Overview'], ['tournaments', 'Tournaments'], ['users', 'Users'], ['payments', 'Payments'], ['orgs', 'Academies'], ['settings', 'Settings']];
  const adminState = () => (S.admin ||= {
    tournaments: { filters: {}, list: null, total: 0 },
    users: { q: '', list: null, total: 0, open: null, detail: null, reset: null },
    payments: { filters: {}, list: null, revenue: null, refund: null },
    orgs: { q: '', list: null, siteBranding: false },
    settings: null,
  });
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

  // Fetches what a tab shows (more = the next page of a list).
  async function adminLoad(tab, { more = false } = {}) {
    const A = adminState();
    try {
      if (tab === 'overview') {
        [A.stats, S.interest] = await Promise.all([api('GET', '/admin/stats'), api('GET', '/sports/interest').catch(() => null)]);
      } else if (tab === 'tournaments') {
        const T = A.tournaments;
        const r = await api('GET', `/admin/tournaments?${qs({ ...T.filters, offset: more ? T.list.length : 0 })}`);
        T.list = more ? [...T.list, ...r.tournaments] : r.tournaments;
        T.total = r.total;
        T.plans = r.plans;
      } else if (tab === 'users') {
        const U = A.users;
        const r = await api('GET', `/admin/users?${qs({ q: U.q, offset: more ? U.list.length : 0 })}`);
        U.list = more ? [...U.list, ...r.users] : r.users;
        U.total = r.total;
      } else if (tab === 'payments') {
        const P = A.payments;
        const r = await api('GET', `/admin/payments?${qs(P.filters)}`);
        P.list = r.payments;
        P.revenue = r.revenue;
      } else if (tab === 'orgs') {
        const r = await api('GET', `/admin/orgs?${qs({ q: A.orgs.q })}`);
        A.orgs.list = r.orgs;
        A.orgs.siteBranding = r.siteBranding;
      } else if (tab === 'settings') {
        [A.settings, A.dupr] = await Promise.all([api('GET', '/admin/settings'), api('GET', '/admin/dupr').catch(() => null)]);
      }
    } catch (e) {
      toast(e.message, true);
    }
    render();
  }

  function viewAdmin() {
    document.title = 'Admin · Tonament';
    if (!S.me || !S.me.isAdmin) return errorView('Site admins only.');
    const tab = S.route.tab || 'overview';
    const views = { overview: adminOverview, tournaments: adminTournaments, users: adminUsers, payments: adminPayments, orgs: adminOrgs, settings: adminSettingsTab };
    return [
      h('h1', {}, 'Admin'),
      h('nav', { class: 'tabs' }, ADMIN_TABS.map(([id, label]) => h('a', { href: `/admin?tab=${id}`, class: id === tab ? 'active' : '' }, label))),
      h('section', { class: 'admin' }, views[tab]()),
    ];
  }

  // ----- overview: numbers, 30-day bars, breakdowns, recent admin actions
  const fmtDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });

  // One series over 30 days as thin bars. Hover (or focus) a bar for its value;
  // the same numbers are in a table underneath.
  function dayBars(title, days, key, fmt = String) {
    const values = days.map((d) => d[key]);
    const max = Math.max(1, ...values);
    const total = values.reduce((a, b) => a + b, 0);
    const W = 300; const H = 90; const gap = 2; const bw = (W - gap * (days.length - 1)) / days.length;
    const tip = h('span', { class: 'chart-tip', 'aria-live': 'polite' }, `${fmt(total)} in 30 days`);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'bars');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${title}: ${fmt(total)} in the last 30 days`);
    days.forEach((d, i) => {
      const v = d[key];
      const bh = v ? Math.max(3, (v / max) * (H - 4)) : 0;
      const x = i * (bw + gap);
      const hit = document.createElementNS(svg.namespaceURI, 'rect'); // a hit area taller than the bar
      Object.entries({ x, y: 0, width: bw + gap, height: H, class: 'bar-hit', tabindex: 0 }).forEach(([k, val]) => hit.setAttribute(k, val));
      const show = () => { tip.textContent = `${fmtDay(d.day)}: ${fmt(v)}`; };
      hit.addEventListener('mouseenter', show);
      hit.addEventListener('focus', show);
      hit.addEventListener('mouseleave', () => { tip.textContent = `${fmt(total)} in 30 days`; });
      svg.append(hit);
      if (bh) {
        const r = Math.min(2, bw / 2, bh); // rounded data end, square at the baseline
        const bar = document.createElementNS(svg.namespaceURI, 'path');
        bar.setAttribute('d', `M${x},${H} V${H - bh + r} Q${x},${H - bh} ${x + r},${H - bh} H${x + bw - r} Q${x + bw},${H - bh} ${x + bw},${H - bh + r} V${H} Z`);
        bar.setAttribute('class', 'bar');
        svg.append(bar);
      }
    });
    return h('div', { class: 'card chart-card' },
      h('div', { class: 'card-head' }, h('h3', {}, title), tip),
      svg,
      h('div', { class: 'chart-axis' }, h('span', {}, fmtDay(days[0].day)), h('span', {}, 'Today')),
      h('details', { class: 'chart-table' }, h('summary', {}, 'Table'),
        h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, days.slice().reverse().map((d) => h('tr', {}, h('td', {}, fmtDay(d.day)), h('td', { class: 'num' }, fmt(d[key])))))))));
  }

  // A count per category as bars of one colour (biggest first), labelled.
  function breakdown(title, rows, label = (k) => k) {
    const max = Math.max(1, ...rows.map((r) => r.n));
    return h('div', { class: 'card' }, h('h3', {}, title),
      rows.length ? h('ul', { class: 'hbars' }, rows.map((r) => h('li', {},
        h('span', { class: 'hbar-label' }, label(r.key)),
        h('span', { class: 'hbar-track' }, h('span', { class: 'hbar', style: `width:${(r.n / max) * 100}%` })),
        h('span', { class: 'num' }, r.n)))) : empty('Nothing yet.'));
  }

  const ACTION_TEXT = {
    'tournament.plan': (x) => `plan ${PLAN_LABELS[x.detail.from] || 'Free'} → ${PLAN_LABELS[x.detail.to] || 'Free'} · ${x.detail.name}`,
    'tournament.official': (x) => `marked official · ${x.detail.name}`,
    'tournament.unofficial': (x) => `no longer official · ${x.detail.name}`,
    'tournament.visibility': (x) => `${x.detail.to} · ${x.detail.name}`,
    'tournament.delete': (x) => `deleted ${x.detail.name}`,
    'user.admin': (x) => `made ${x.target} an admin`,
    'user.unadmin': (x) => `removed admin from ${x.target}`,
    'user.disable': (x) => `disabled ${x.target}`,
    'user.enable': (x) => `enabled ${x.target}`,
    'user.reset': (x) => `reset link for ${x.target}`,
    'user.delete': (x) => `deleted account ${x.target}`,
    'payment.refund': (x) => `refunded ${money(x.detail.amount)} · ${x.detail.tournament}${x.detail.plan === 'org' ? ' (year taken back)' : x.detail.plan ? ` (now ${PLAN_LABELS[x.detail.plan] || 'Free'})` : ''}`,
    'org.branding': (x) => `academy branding ${x.detail.to == null ? 'follows the site' : x.detail.to ? 'included' : 'not included'} · ${x.detail.name}`,
    'org.extend': (x) => `added ${x.detail.days} days · ${x.detail.name}`,
    'org.unpublish': (x) => `unpublished academy page · ${x.detail.name}`,
    'org.delete': (x) => `deleted academy page ${x.detail.name}`,
    'setting.change': (x) => `${({ orgIncludesBranding: 'academy pages include branding', duprSubmit: 'send results to DUPR' })[x.target] || x.target}: ${x.detail.to ? 'on' : 'off'}`,
  };

  function adminOverview() {
    const st = adminState().stats;
    if (!st) return loading();
    const tile = (label, value, sub) => h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, label), h('strong', {}, value), sub ? h('small', {}, sub) : null);
    const sportName = (id) => (S.sports.find((x) => x.id === id) || {}).name || id;
    const counts = (S.interest && S.interest.counts) || {};
    const requested = S.sports.filter((x) => x.status !== 'live').map((x) => ({ key: x.name, n: counts[x.id] || 0 })).filter((x) => x.n).sort((a, b) => b.n - a.n);
    return [
      h('div', { class: 'stat-tiles' },
        tile('Users', st.users.total, `+${st.users.d30} in 30 days`),
        tile('Tournaments', st.tournaments.total, `+${st.tournaments.d30} in 30 days`),
        tile('Entries', st.entries.total, `+${st.entries.d30} in 30 days`),
        tile('Matches finished', st.matches.done, `${st.matches.points.toLocaleString()} points scored`),
        tile('Revenue this month', money(st.revenue.month), `${money(st.revenue.total)} all time`),
        tile('Refunded', money(st.revenue.refunded), `Plans ${money(st.revenue.plans)} · entry fees ${money(st.revenue.entries)}`)),
      h('div', { class: 'chart-grid' },
        dayBars('Sign-ups', st.days, 'signups'),
        dayBars('Tournaments created', st.days, 'tournaments'),
        dayBars('Revenue', st.days, 'revenue', money)),
      h('div', { class: 'chart-grid' },
        breakdown('Tournaments by sport', st.bySport, sportName),
        breakdown('By plan', st.byPlan, (k) => PLAN_LABELS[k] || 'Free'),
        breakdown('By status', st.byStatus, (k) => STATUS[k] || k),
        breakdown('By visibility', st.byVisibility, (k) => ({ private: 'Private', link: 'Link only', public: 'Public' })[k] || k),
        breakdown('Most requested sports', requested)),
      h('div', { class: 'card' }, h('h3', {}, 'Recent admin actions'),
        st.log.length ? h('ul', { class: 'admin-log' }, st.log.map((x) => h('li', {},
          h('span', { class: 'muted small' }, new Date(x.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })),
          h('span', {}, h('strong', {}, x.admin.split('@')[0]), ' ', (ACTION_TEXT[x.action] || (() => `${x.action} ${x.target || ''}`))(x))))) : empty('No admin actions yet.')),
    ];
  }

  // ----- every tournament
  function adminTournaments() {
    const T = adminState().tournaments;
    const set = (k, v) => { T.filters = { ...T.filters, [k]: v }; adminLoad('tournaments'); };
    const search = h('input', { type: 'search', name: 'q', value: T.filters.q || '', placeholder: 'Name, ID, city or owner email', 'aria-label': 'Search tournaments' });
    const pills = (name, label, options) => groupField(label, choiceGroup({ name: `f-${name}`, label, value: T.filters[name] || '', options: [{ value: '', label: 'All' }, ...options], onchange: (e) => set(name, e.target.value) }));
    const filters = h('form', { class: 'card admin-filters', onsubmit: (e) => { e.preventDefault(); set('q', search.value.trim()); } },
      h('div', { class: 'search-row' }, search,
        h('select', { 'aria-label': 'Sport', value: T.filters.sport || '', onchange: (e) => set('sport', e.target.value) },
          h('option', { value: '' }, 'All sports'), liveSports().map((x) => h('option', { value: x.id }, x.name))),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Search')),
      pills('plan', 'Plan', (T.plans || []).map((p) => ({ value: p.id, label: p.name }))),
      pills('visibility', 'Visibility', [{ value: 'private', label: 'Private' }, { value: 'link', label: 'Link only' }, { value: 'public', label: 'Public' }]),
      pills('status', 'Status', Object.entries(STATUS).filter(([k]) => k !== 'live').map(([value, label]) => ({ value, label }))));
    if (!T.list) return [filters, loading()];

    const row = (t) => {
      const changePlan = (plan) => act(async () => {
        await api('POST', `/admin/tournaments/${encodeURIComponent(t.id)}/plan`, { plan });
        t.plan = plan;
      }, `${t.name}: plan set to ${PLAN_LABELS[plan] || 'Free'}`);
      const official = (on) => act(async () => { await api('POST', `/admin/tournaments/${encodeURIComponent(t.id)}/official`, { official: on }); t.official = on; }, on ? 'Marked as organised by Tonament' : 'No longer organised by Tonament');
      const visibility = (v) => act(async () => { await api('POST', `/tournaments/${encodeURIComponent(t.id)}/visibility`, { visibility: v }); t.visibility = v; }, v === 'private' ? 'Unpublished' : 'Published');
      const remove = () => {
        const typed = prompt(`Delete "${t.name}" and everything in it? This can't be undone.\n\nType the tournament name to confirm:`);
        if (typed == null) return;
        if (typed.trim() !== t.name) { toast('The name didn\'t match — nothing was deleted', true); return; }
        act(async () => { await api('DELETE', `/tournaments/${encodeURIComponent(t.id)}`); T.list = T.list.filter((x) => x.id !== t.id); T.total -= 1; }, `${t.name} deleted`);
      };
      return h('li', { class: 'card admin-row' },
        h('div', { class: 'admin-row-head' },
          h('div', {},
            h('a', { href: `/t/${t.id}`, class: 'admin-name' }, t.name),
            h('div', { class: 'muted small' }, [t.sportName, t.owner || 'No owner', `${t.entries} ${t.entries === 1 ? 'entry' : 'entries'}`, t.city, `created ${new Date(t.createdAt).toLocaleDateString()}`].filter(Boolean).join(' · '))),
          h('span', { class: 'admin-pills' }, visibilityPill(t.visibility), ' ', pill(t.status, STATUS[t.status] || t.status), t.official ? [' ', pill('org', 'Tonament')] : null)),
        groupField('Plan', choiceGroup({
          name: `plan-${t.id}`, label: `Plan for ${t.name}`, value: t.plan,
          options: (T.plans || []).map((p) => ({ value: p.id, label: p.name })),
          onchange: (e) => changePlan(e.target.value),
        })),
        h('div', { class: 'actions admin-actions' },
          h('label', { class: 'check-field' }, h('input', { type: 'checkbox', checked: t.official, onchange: (e) => official(e.target.checked) }), h('span', {}, 'Organised by Tonament')),
          t.visibility === 'private'
            ? h('button', { class: 'btn btn-small', onclick: () => visibility('public') }, 'Publish')
            : h('button', { class: 'btn btn-small', onclick: () => visibility('private') }, 'Unpublish'),
          h('button', { class: 'btn btn-small btn-ghost danger', onclick: remove }, 'Delete')));
    };
    return [filters,
      h('p', { class: 'muted small' }, `${T.total} tournament${T.total === 1 ? '' : 's'}`),
      T.list.length ? h('ul', { class: 'admin-list' }, T.list.map(row)) : empty('No tournaments match.'),
      T.list.length < T.total ? h('div', { class: 'actions center' }, h('button', { class: 'btn', onclick: () => adminLoad('tournaments', { more: true }) }, 'Load more')) : null];
  }

  // ----- every user
  function adminUsers() {
    const U = adminState().users;
    const search = h('input', { type: 'search', value: U.q, placeholder: 'Name or email', 'aria-label': 'Search users' });
    const filters = h('form', { class: 'card admin-filters', onsubmit: (e) => { e.preventDefault(); U.q = search.value.trim(); adminLoad('users'); } },
      h('div', { class: 'search-row' }, search, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Search')));
    if (!U.list) return [filters, loading()];

    const update = (u, data) => Object.assign(u, data);
    const row = (u) => {
      const me = S.me && S.me.id === u.id;
      const open = U.open === u.id;
      const toggle = async () => {
        U.open = open ? null : u.id;
        U.detail = null;
        U.reset = null;
        render();
        if (!open) { try { U.detail = await api('GET', `/admin/users/${u.id}`); } catch (e) { toast(e.message, true); } render(); }
      };
      const setAdmin = (on) => act(async () => update(u, await api('POST', `/admin/users/${u.id}/admin`, { on })), on ? `${u.email} is now an admin` : `${u.email} is no longer an admin`);
      const setDisabled = (on) => {
        if (on && !confirm(`Disable ${u.email}? They're signed out everywhere and can't sign in until you enable them.`)) return;
        act(async () => update(u, await api('POST', `/admin/users/${u.id}/disable`, { on })), on ? `${u.email} disabled` : `${u.email} enabled`);
      };
      const reset = () => act(async () => { U.reset = { id: u.id, ...(await api('POST', `/admin/users/${u.id}/reset`, {})) }; });
      const remove = () => {
        if (!confirm(`Delete the account ${u.email}? This can't be undone.`)) return;
        act(async () => { await api('DELETE', `/admin/users/${u.id}`); U.list = U.list.filter((x) => x.id !== u.id); U.total -= 1; }, `${u.email} deleted`);
      };
      const D = open && U.detail;
      return h('li', { class: 'card admin-row' },
        h('div', { class: 'admin-row-head' },
          h('div', {},
            h('button', { class: 'link-btn admin-name', onclick: toggle, 'aria-expanded': String(open) }, u.name),
            h('div', { class: 'muted small' }, [u.email, `joined ${new Date(u.createdAt).toLocaleDateString()}`, `owns ${u.owned}`, `helps on ${u.helping}`, `${u.entries} ${u.entries === 1 ? 'entry' : 'entries'}`].join(' · '))),
          h('span', { class: 'admin-pills' }, u.isAdmin ? pill('org', u.envAdmin ? 'Admin (settings)' : 'Admin') : null, ' ', u.disabled ? pill('withdrawn', 'Disabled') : null)),
        h('div', { class: 'actions admin-actions' },
          u.envAdmin ? null : u.isAdmin
            ? h('button', { class: 'btn btn-small', disabled: me, onclick: () => setAdmin(false) }, 'Remove admin')
            : h('button', { class: 'btn btn-small', onclick: () => setAdmin(true) }, 'Make admin'),
          u.disabled
            ? h('button', { class: 'btn btn-small', onclick: () => setDisabled(false) }, 'Enable')
            : h('button', { class: 'btn btn-small', disabled: me, onclick: () => setDisabled(true) }, 'Disable'),
          h('button', { class: 'btn btn-small', onclick: reset }, 'Reset link'),
          h('button', { class: 'btn btn-small btn-ghost danger', disabled: me, onclick: remove }, 'Delete')),
        U.reset && U.reset.id === u.id
          ? h('div', { class: 'banner info reset-link' },
            h('span', {}, U.reset.emailed ? 'Emailed to them. ' : 'Email isn\'t set up — send them this link. ', 'It works once, for an hour.'),
            h('button', { class: 'btn btn-small', onclick: () => copy(U.reset.url, 'Reset link copied') }, 'Copy link'))
          : null,
        open ? (D ? h('div', { class: 'admin-detail' },
          h('h4', {}, `Tournaments (${D.tournaments.length})`),
          D.tournaments.length ? h('ul', {}, D.tournaments.map((t) => h('li', {}, h('a', { href: `/t/${t.id}` }, t.name), ` · ${t.role} · ${PLAN_LABELS[t.plan] || 'Free'} · ${STATUS[t.status] || t.status}`))) : h('p', { class: 'muted small' }, 'None.'),
          h('h4', {}, `Entries (${D.entries.length})`),
          D.entries.length ? h('ul', {}, D.entries.map((e) => h('li', {}, h('a', { href: `/t/${e.tournamentId}` }, e.tournamentName), ` · ${e.eventName || ''} · ${e.name}${e.withdrawn ? ' · withdrawn' : e.confirmed ? '' : ' · not confirmed'}`))) : h('p', { class: 'muted small' }, 'None.'),
          h('h4', {}, `Payments (${D.payments.length})`),
          D.payments.length ? h('ul', {}, D.payments.map((p) => h('li', {}, `${new Date(p.paidAt || p.createdAt).toLocaleDateString()} · ${money(p.amount)} · ${p.status}${p.refundedAmount ? ` (refunded ${money(p.refundedAmount)})` : ''} · ${p.tournamentName}`))) : h('p', { class: 'muted small' }, 'None.'))
          : loading()) : null);
    };
    return [filters,
      h('p', { class: 'muted small' }, `${U.total} user${U.total === 1 ? '' : 's'}`),
      U.list.length ? h('ul', { class: 'admin-list' }, U.list.map(row)) : empty('No users match.'),
      U.list.length < U.total ? h('div', { class: 'actions center' }, h('button', { class: 'btn', onclick: () => adminLoad('users', { more: true }) }, 'Load more')) : null];
  }

  // ----- payments and refunds
  function adminPayments() {
    const P = adminState().payments;
    const set = (k, v) => { P.filters = { ...P.filters, [k]: v }; adminLoad('payments'); };
    const search = h('input', { type: 'search', value: P.filters.q || '', placeholder: 'Tournament, email, player or payment ID', 'aria-label': 'Search payments' });
    const date = (k, label) => field(label, h('input', { type: 'date', value: P.filters[k] || '', onchange: (e) => set(k, e.target.value) }));
    const filters = h('form', { class: 'card admin-filters', onsubmit: (e) => { e.preventDefault(); set('q', search.value.trim()); } },
      h('div', { class: 'search-row' }, search, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Search')),
      groupField('Status', choiceGroup({ name: 'f-pstatus', label: 'Status', value: P.filters.status || '',
        options: [{ value: '', label: 'All' }, { value: 'paid', label: 'Paid' }, { value: 'partial', label: 'Part refunded' }, { value: 'refunded', label: 'Refunded' }, { value: 'created', label: 'Started' }, { value: 'failed', label: 'Failed' }],
        onchange: (e) => set('status', e.target.value) })),
      groupField('For', choiceGroup({ name: 'f-kind', label: 'For', value: P.filters.kind || '',
        options: [{ value: '', label: 'All' }, { value: 'plan', label: 'Plans' }, { value: 'entry', label: 'Entry fees' }, { value: 'org', label: 'Academy pages' }], onchange: (e) => set('kind', e.target.value) })),
      h('div', { class: 'grid-2' }, date('from', 'From'), date('to', 'To')));
    if (!P.list) return [filters, loading()];

    const statusPill = (p) => (p.status === 'paid' && p.refundedAmount ? pill('waiting', 'Part refunded')
      : pill(p.status === 'paid' ? 'done' : p.status === 'refunded' ? '' : p.status === 'failed' ? 'withdrawn' : '', ({ created: 'Started', paid: 'Paid', refunded: 'Refunded', failed: 'Failed' })[p.status] || p.status));
    const R = P.refund;
    const refundCard = R ? (() => {
      const p = P.list.find((x) => x.id === R.id);
      const left = p.amount - p.refundedAmount;
      const amount = h('input', { type: 'number', min: 1, max: left / 100, step: '0.01', value: (left / 100).toFixed(2), required: true, 'aria-label': 'Amount to refund (₹)' });
      const down = h('input', { type: 'checkbox', checked: true });
      return h('form', {
        class: 'card refund-card',
        onsubmit: (e) => {
          e.preventDefault();
          const paise = Math.round(Number(amount.value) * 100);
          act(async () => {
            const r = await api('POST', `/admin/payments/${p.id}/refund`, { amount: paise, downgrade: ['plan', 'org'].includes(p.kind) && down.checked });
            P.refund = null;
            await adminLoad('payments');
            if (r.plan && r.plan !== 'org') toast(`Refunded ${money(paise)} — ${p.tournamentName} is now on ${PLAN_LABELS[r.plan] || 'Free'}`);
          }, `Refunded ${money(paise)}`);
        },
      },
      h('h3', {}, `Refund ${p.tournamentName}`),
      h('p', { class: 'muted small' }, `${money(p.amount)} paid by ${p.email || 'unknown'}${p.refundedAmount ? `, ${money(p.refundedAmount)} already refunded` : ''}. The money goes back through Razorpay to how they paid.`),
      field('Amount to refund (₹)', amount, null, `Up to ${money(left)}.`),
      p.kind === 'org' ? h('label', { class: 'check-field' }, down, h('span', {}, h('strong', {}, 'Also take the year away'), h('small', {}, 'Their page loses a year of paid time (and goes down if that was all of it).'))) : null,
      p.kind === 'plan' ? h('label', { class: 'check-field' }, down, h('span', {}, h('strong', {}, 'Also take the plan away'), h('small', {}, 'The tournament goes back to the plan it still has paid for, or Free.'))) : null,
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Refund'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { P.refund = null; render(); } }, 'Cancel')));
    })() : null;

    return [filters,
      h('div', { class: 'card-head admin-sum' },
        h('span', {}, h('strong', {}, money(P.revenue.total)), ` from ${P.revenue.count} payment${P.revenue.count === 1 ? '' : 's'}${P.list.length >= 1000 ? ' (first 1,000 shown)' : ''}`),
        h('a', { class: 'btn btn-small', href: `/api/admin/payments.csv?${qs(P.filters)}`, download: '' }, 'Export CSV')),
      refundCard,
      P.list.length ? h('div', { class: 'card' }, h('div', { class: 'table-wrap' }, h('table', { class: 'admin-pay' },
        h('thead', {}, h('tr', {}, ['Date', 'Tournament', 'Paid by', 'For', 'Amount', 'Refunded', 'Status', 'Payment ID', ''].map((c, i) => h('th', { class: i === 4 || i === 5 ? 'num' : '' }, c)))),
        h('tbody', {}, P.list.map((p) => h('tr', {},
          h('td', {}, new Date(p.paidAt || p.createdAt).toLocaleDateString()),
          h('td', { class: 'name' }, p.tournamentId ? h('a', { href: `/t/${p.tournamentId}` }, p.tournamentName) : p.tournamentName),
          h('td', {}, p.email || '—'),
          h('td', {}, p.kind === 'entry' ? `Entry · ${p.eventName || ''}${p.player ? ` (${p.player})` : ''}` : p.kind === 'org' ? 'Academy page · 1 year' : PLAN_LABELS[p.tier || 'pass'] || p.tier),
          h('td', { class: 'num' }, money(p.amount)),
          h('td', { class: 'num' }, p.refundedAmount ? money(p.refundedAmount) : '—'),
          h('td', {}, statusPill(p)),
          h('td', { class: 'small' }, p.paymentId || '—'),
          h('td', {}, p.status === 'paid' && p.paymentId && p.refundedAmount < p.amount
            ? h('button', { class: 'btn btn-small', onclick: () => { P.refund = { id: p.id }; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, 'Refund')
            : null))))))) : empty('No payments match.')];
  }

  // ----- academy pages: branding, extend, unpublish, delete
  function adminOrgs() {
    const O = adminState().orgs;
    const search = h('input', { type: 'search', value: O.q, placeholder: 'Name, address or city', 'aria-label': 'Search academy pages' });
    const filters = h('form', { class: 'card admin-filters', onsubmit: (e) => { e.preventDefault(); O.q = search.value.trim(); adminLoad('orgs'); } },
      h('div', { class: 'search-row' }, search, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Search')));
    if (!O.list) return [filters, loading()];
    const update = (o, body, msg) => act(async () => { await api('PATCH', `/admin/orgs/${o.id}`, body); await adminLoad('orgs'); }, msg);
    const row = (o) => {
      const state = !o.paidUntil ? pill('waiting', 'Draft') : o.live ? pill('done', `Live until ${fmtDate(o.paidUntil)}`) : o.public ? pill('waiting', `Expired ${fmtDate(o.paidUntil)} · grace`) : pill('withdrawn', `Hidden since ${fmtDate(o.paidUntil)}`);
      const extend = () => {
        const days = prompt(`Give ${o.name} extra days (e.g. 30, or 365 for a year). Counts from today or from the end of their paid time, whichever is later.`, '30');
        if (days == null) return;
        if (!/^-?\d+$/.test(days.trim()) || !Number(days)) { toast('Enter a number of days', true); return; }
        update(o, { extendDays: Number(days) }, `${o.name}: ${Number(days)} days added`);
      };
      const remove = () => {
        const typed = prompt(`Delete the page for "${o.name}"? Its tournaments are kept. This can't be undone.\n\nType the name to confirm:`);
        if (typed == null) return;
        if (typed.trim() !== o.name) { toast('The name didn\'t match — nothing was deleted', true); return; }
        act(async () => { await api('DELETE', `/admin/orgs/${o.id}`); O.list = O.list.filter((x) => x.id !== o.id); }, `${o.name} deleted`);
      };
      return h('li', { class: 'card admin-row' },
        h('div', { class: 'admin-row-head' },
          h('div', {},
            h('a', { href: o.public ? `/@${o.slug}` : `/@${o.slug}/edit`, class: 'admin-name' }, o.name),
            h('div', { class: 'muted small' }, [`@${o.slug}`, o.kindName, o.city, o.owner || 'No owner', `${o.tournaments} tournament${o.tournaments === 1 ? '' : 's'}`, `created ${new Date(o.createdAt).toLocaleDateString()}`].filter(Boolean).join(' · '))),
          h('span', { class: 'admin-pills' }, state)),
        groupField('Tournament branding', choiceGroup({
          name: `branding-${o.id}`, label: `Tournament branding for ${o.name}`, value: o.brandingOverride == null ? 'site' : String(o.brandingOverride),
          options: [
            { value: 'site', label: `Site default (${O.siteBranding ? 'included' : 'not included'})` },
            { value: 'true', label: 'Included' },
            { value: 'false', label: 'Not included' },
          ],
          onchange: (e) => update(o, { brandingOverride: e.target.value === 'site' ? null : e.target.value === 'true' }, `${o.name}: branding ${e.target.value === 'site' ? 'follows the site setting' : e.target.value === 'true' ? 'included' : 'not included'}`),
        }), null, o.brandingIncluded ? 'Their linked tournaments get logo, sponsors and the organiser-led display now.' : o.live ? null : 'Only applies while the page is paid for.'),
        h('div', { class: 'actions admin-actions' },
          h('button', { class: 'btn btn-small', onclick: extend }, 'Add days'),
          o.public ? h('button', { class: 'btn btn-small', onclick: () => confirm(`Take ${o.name}'s page down now? They can renew to publish it again.`) && update(o, { unpublish: true }, `${o.name} unpublished`) }, 'Unpublish') : null,
          h('button', { class: 'btn btn-small btn-ghost danger', onclick: remove }, 'Delete')));
    };
    return [filters,
      h('p', { class: 'muted small' }, `${O.list.length} page${O.list.length === 1 ? '' : 's'}${O.list.length >= 200 ? ' (first 200)' : ''}`),
      O.list.length ? h('ul', { class: 'admin-list' }, O.list.map(row)) : empty('No academy pages yet.')];
  }

  // ----- site settings
  function adminSettingsTab() {
    const A = adminState();
    if (!A.settings) return loading();
    const toggle = (key, on, msg) => act(async () => { A.settings = await api('PATCH', '/admin/settings', { [key]: on }); }, msg);
    return h('div', { class: 'card settings-card' },
      h('h2', {}, 'Academy pages'),
      h('label', { class: 'check-field switch-field' },
        h('input', { type: 'checkbox', role: 'switch', checked: A.settings.orgIncludesBranding, onchange: (e) => toggle('orgIncludesBranding', e.target.checked, e.target.checked ? 'Academy pages now include tournament branding' : 'Academy pages no longer include tournament branding') }),
        h('span', {},
          h('strong', {}, 'Academy page includes branding on all their tournaments'),
          h('small', {}, A.settings.orgIncludesBranding
            ? 'On: every tournament linked to a paid academy page gets the logo, sponsors and organiser-led venue display, without buying Open. Entry limits still follow the tournament\'s plan.'
            : 'Off: tournaments need their own Open or Championship plan for branding, even when linked to an academy page.'))),
      h('p', { class: 'hint' }, 'You can override this for a single academy on the Academies tab. Changes show within a minute and are recorded in the admin log.'),
      h('h2', {}, 'DUPR'),
      A.dupr && A.dupr.enabled ? [
        h('label', { class: 'check-field switch-field' },
          h('input', { type: 'checkbox', role: 'switch', checked: A.settings.duprSubmit, onchange: (e) => toggle('duprSubmit', e.target.checked, e.target.checked ? 'Results now go to DUPR' : 'Results no longer go to DUPR') }),
          h('span', {}, h('strong', {}, 'Send results to DUPR'), h('small', {}, 'Finished pickleball matches go to DUPR when every player is verified with DUPR.'))),
        A.dupr.submissions.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'admin-pay' },
          h('thead', {}, h('tr', {}, ['When', 'Tournament', 'Match', 'Status', ''].map((c) => h('th', {}, c)))),
          h('tbody', {}, A.dupr.submissions.map((x) => h('tr', {},
            h('td', {}, new Date(x.updatedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })),
            h('td', { class: 'name' }, h('a', { href: `/t/${x.tournamentId}` }, x.tournamentName)),
            h('td', {}, `#${x.matchId}`),
            h('td', {}, x.status === 'sent' ? pill('done', 'Sent') : x.status === 'failed' ? pill('withdrawn', `Failed${x.error ? ` · ${x.error}` : ''}`) : pill('waiting', 'Queued')),
            h('td', {}, x.status !== 'sent' ? h('button', { class: 'btn btn-small', onclick: () => act(async () => { await api('POST', `/admin/dupr/${x.matchId}/retry`, {}); await adminLoad('settings'); }, 'Sent to DUPR') }, 'Retry') : null)))))) : h('p', { class: 'muted small' }, 'Nothing sent yet.'),
      ] : h('p', { class: 'muted small' }, 'Not connected. Players add their DUPR ID and ratings themselves (shown as self-reported), and organisers download results for their DUPR club. Automatic sending switches on here once DUPR gives Tonament partner keys (DUPR_CLIENT_ID and DUPR_CLIENT_SECRET in Vercel).'));
  }

  // ---------- navigation: real URLs (/t/<id>/courts), no page reloads
  // The app's own pages; anything else (/pricing, /terms, …) is a normal link.
  const APP_PATH = /^\/(?:$|t\/|new$|signin$|signup$|forgot$|reset$|link$|admin$|groups(?:\/new)?$|g\/|academy\/new$|me\/profile$|@[a-z0-9-]+\/edit$)/;
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
