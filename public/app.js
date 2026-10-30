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
    // Names from a free fixture tool (/tools, "Run this live"), waiting in the add-players box.
    // (Kept until they're added, so it survives signing up on the way.)
    draft: (() => { try { return sessionStorage.getItem('tonament:tool-names') || ''; } catch (e) { return ''; } })(),
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

  // This phone's own id: one phone scores a match at a time (the server's "claim").
  const DEVICE = (() => {
    try {
      let d = localStorage.getItem('tonament:device');
      if (!d) { d = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('tonament:device', d); }
      return d;
    } catch { return `tab${Math.random().toString(36).slice(2, 14)}`; }
  })();

  async function api(method, path, body, tid) {
    const headers = { 'X-Device': DEVICE };
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
  // undo: a function that reverses what was just done; the toast offers it for a few seconds.
  function toast(msg, error = false, undo = null) {
    toastEl.textContent = msg;
    toastEl.className = `${error ? 'show error' : 'show'}${undo ? ' has-undo' : ''}`;
    if (undo) {
      toastEl.append(h('button', {
        type: 'button', class: 'toast-undo',
        onclick: () => { toastEl.className = ''; act(undo, 'Undone'); },
      }, 'Undo'));
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = ''; }, undo ? 6000 : 3500);
  }

  async function act(fn, success, undo = null) {
    try {
      await fn();
      if (success) toast(success, false, undo);
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
  // The picture fits the moment: the poster before it starts, the
  // champions once it's over, the tournament card while it's on.
  function shareTournament(t) {
    const kind = t.status === 'setup' ? 'poster' : t.status === 'completed' ? 'results' : 't';
    const text = t.status === 'setup' ? `${t.name} — entries are open:` : t.status === 'completed' ? `${t.name} — the results:` : `${t.name} — live scores:`;
    shareSheet({ title: t.name, text, url: shareUrl(t), image: t.visibility === 'private' ? null : `/img/${kind}/${t.id}.png` });
  }
  // A finished match, and a finished event's podium.
  const shareMatch = (t, m) => shareSheet({
    title: `${nameOf(m.a)} v ${nameOf(m.b)}`, text: `${m.winner ? `${nameOf(m.winner === m.a.id ? m.a : m.b)} won` : 'A draw'} — ${m.summary} · ${t.name}`,
    url: `${location.origin}/t/${t.id}/m/${m.id}`, image: t.visibility === 'private' ? null : `/img/m/${m.id}.png`,
  });
  const shareEvent = (t, ev) => shareSheet({ title: `${ev.name} results`, text: `${t.name} · ${ev.name} — the results:`, url: shareUrl(t), image: t.visibility === 'private' ? null : `/img/w/${ev.id}.png` });

  // Organisers, once it's all over: share the results, and invite the next organiser.
  const WRAP_KEY = 'tonament:wrapped';
  function finishedCard(tt) {
    if (tt.status !== 'completed' || !tt.can.manage) return null;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem(WRAP_KEY) || '[]'); } catch { /* none */ }
    if (seen.includes(tt.id)) return null;
    const hide = () => { try { localStorage.setItem(WRAP_KEY, JSON.stringify([...seen, tt.id].slice(-50))); } catch { /* this visit */ } render(); };
    if (S.referrals === undefined && S.me) { S.referrals = null; api('GET', '/me/referrals').then((r) => { S.referrals = r; render(); }).catch(() => { S.referrals = { enabled: false }; }); }
    const r = S.referrals;
    const invite = r && r.enabled && r.code ? `${location.origin}/?ref=${r.code}` : `${location.origin}/`;
    const done = tt.events.filter((e) => e.status === 'completed');
    return h('div', { class: 'card wrap-card' },
      h('button', { class: 'icon-btn wrap-close', type: 'button', 'aria-label': 'Hide', title: 'Hide', onclick: hide }, '×'),
      h('h2', {}, '🏆 That\'s a wrap'),
      h('p', {}, tt.visibility === 'private'
        ? 'Every match is done. Publish the tournament to share the results with a picture for WhatsApp and Instagram.'
        : 'Every match is done. Share the results while everyone\'s still talking about it — the picture is made for WhatsApp and Instagram.'),
      h('div', { class: 'actions' },
        tt.visibility !== 'private' ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => shareTournament(tt) }, 'Share the results') : null,
        tt.visibility !== 'private' && done.length > 1 ? h('button', { class: 'btn', type: 'button', onclick: () => actionSheet('Share one event', done.map((e) => ({ label: e.name, hint: 'Its podium', onClick: () => shareEvent(tt, e) }))) }, 'One event') : null,
        h('a', { class: 'btn', href: runAgainHref(tt) }, 'Run it again')),
      h('p', { class: 'muted small wrap-invite' }, 'Know someone else who runs tournaments? ',
        r && r.enabled ? 'Your link gives them their first one free — and you a free upgrade when they run it. ' : '',
        h('button', { class: 'link-btn', type: 'button', onclick: () => shareText(`I ran ${tt.name} on Tonament — entries, draws and live scores on everyone's phone. Try it for your next tournament: ${invite}`) }, 'Send them Tonament')));
  }
  // One way to share anything: WhatsApp, an image for an Instagram story, the
  // link, or the phone's own share menu. image: the share card (/img/…png).
  function shareSheet({ title, text, url, image = null }) {
    const story = async () => {
      try {
        const blob = await (await fetch(`${image}?size=story`)).blob();
        const file = new File([blob], 'tonament.png', { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title });
          return;
        }
        const a = h('a', { href: URL.createObjectURL(blob), download: 'tonament.png' });
        document.body.append(a);
        a.click();
        a.remove();
        toast('Image saved — add it to your story');
      } catch (e) {
        if (e.name !== 'AbortError') toast('Couldn\'t make the image — try again', true);
      }
    };
    // ?src= tells us which way a shared link came in (see firstTouch).
    const via = (src) => { try { const u = new URL(url, location.origin); u.searchParams.set('src', src); return u.toString(); } catch { return url; } };
    actionSheet(title, [
      { label: 'WhatsApp', hint: 'Send it to a chat or your group', onClick: () => window.open(`https://wa.me/?text=${encodeURIComponent(`${text}\n${via('wa')}`)}`, '_blank', 'noopener') },
      image ? { label: 'Instagram story', hint: 'A picture sized for stories', onClick: story } : null,
      { label: 'Copy link', onClick: () => copy(via('copy'), 'Link copied') },
      navigator.share ? { label: 'More…', hint: 'Other apps', onClick: () => navigator.share({ title, text, url: via('share') }).catch(() => {}) } : null,
    ]);
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

  // The ⋯ menu on a row: one bottom sheet with everything you can do to it.
  // items: [{ label, hint?, onClick, danger? }] (falsy items are skipped).
  function actionSheet(title, items) {
    const list = items.filter(Boolean);
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); if (opener && opener.isConnected) opener.focus(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const opener = document.activeElement;
    const box = h('div', { class: 'sheet-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e) => { if (e.target === box) close(); } },
      h('div', { class: 'sheet action-sheet' },
        h('h2', {}, title),
        h('div', { class: 'sheet-actions' }, list.map((it) => h('button', {
          type: 'button', class: `sheet-action${it.danger ? ' danger' : ''}${it.current ? ' current' : ''}`, 'aria-current': it.current ? 'true' : null,
          onclick: () => { close(); if (!it.current) it.onClick(); },
        }, h('span', {}, it.dot ? h('span', { class: `dot ${it.dot}`, 'aria-hidden': 'true' }) : null, it.label, it.current ? ' ✓' : null), it.hint ? h('small', { class: 'muted' }, it.hint) : null))),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancel')));
    document.body.append(box);
    document.addEventListener('keydown', onKey);
    box.querySelector('button').focus();
  }
  // The ⋯ button that opens it (nothing when there's nothing to do).
  function moreButton(title, items) {
    if (!items.filter(Boolean).length) return null;
    return h('button', {
      type: 'button', class: 'icon-btn more-btn', 'aria-haspopup': 'dialog', 'aria-label': `More for ${title}`, title: 'More',
      onclick: () => actionSheet(title, items),
    }, '⋯');
  }

  // Plain text with line breaks; web links become links (never raw HTML).
  function richText(text) {
    return text.split('\n').map((line) => h('p', {}, line.split(/(https?:\/\/[^\s]+)/g).map((part, i) => (i % 2
      ? h('a', { href: part, target: '_blank', rel: 'noopener nofollow' }, part)
      : part))));
  }

  const hasExtras = (t) => Boolean(t.notes || perkLabels(t).length || t.events.some((e) => (e.prizes || []).length));
  const hasPage = (t) => Boolean(t.about || t.photos.length || Object.values(t.pageLinks || {}).some(Boolean) || hasExtras(t) || (t.config && t.config.latePolicy));

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
    const late = t.config && t.config.latePolicy ? h('div', { class: 'card' }, h('h2', {}, 'If you\'re late'), lateWords(latePolicy(t)).map((x) => h('p', { class: 'small' }, x))) : null;
    return [
      late,
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
  // Spectators also get a quiet "run your own" line, carrying the organiser's invite.
  function brandFooter(t) {
    return [
      !t.can.manage && !t.whiteLabel && !t.official
        ? h('p', { class: 'run-your-own muted small' }, 'Organising a tournament? ', h('a', { href: refHref('/signup?next=%2Fnew', t.refCode) }, 'Run it on Tonament — free'))
        : null,
      t.sponsors && t.sponsors.length
        ? h('section', { class: 'sponsors', 'aria-label': 'Sponsors' },
          h('p', { class: 'eyebrow' }, 'Supported by'),
          h('div', { class: 'sponsor-logos' }, t.sponsors.map((sp) => h('img', { src: sp.url, alt: sp.caption || 'Sponsor', loading: 'lazy' }))))
        : null,
      t.branding
        ? h('a', { class: 'powered', href: refHref('/', t.refCode), 'aria-label': 'Powered by Tonament' },
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
          : { name: 'tournament', id, tab: parts[2] || null, eventId: Number(params.get('e')) || null, section: params.get('s') || null };
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
        // /new?from=t:<id> (run it again) or ?from=tpl:<id> (a template).
        const from = /^(t|tpl):[a-z0-9-]{1,80}$/.test(params.get('from') || '') ? params.get('from') : '';
        if (!S.newDraft || from !== (S.newDraft.from || '')) S.newDraft = null;
        S.route = { name: 'new', from, title: (params.get('name') || '').slice(0, 80) };
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
      } else if (parts[0] === 'templates') {
        if (!S.me) {
          navigate('/signin?next=/templates', { replace: true });
          return;
        }
        S.route = { name: 'templates' };
        S.templates = null;
        render();
        S.templates = (await api('GET', '/me/templates').catch(() => ({ templates: [] }))).templates;
        if (S.route.name === 'templates') render();
        return;
      } else if (parts[0] === 'invite') {
        if (!S.me) {
          navigate('/signin?next=/invite', { replace: true });
          return;
        }
        S.route = { name: 'invite' };
        S.referrals = null;
        render();
        S.referrals = await api('GET', '/me/referrals').catch((e) => ({ enabled: false, error: e.message }));
        if (S.route.name === 'invite') render();
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
        // claim: a guest's spot from a personal link ("Rahul, your spot is waiting"):
        // asked about first, so the link doesn't join on its own.
        const claim = Number(params.get('claim')) || null;
        S.route = { name: 'group', slug, tab: params.get('tab') || 'today', join, claim, skip: 0 };
        if (!S.group || S.group.slug !== slug) S.group = null;
        if (join && S.me && !claim) {
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
      } else if ((parts[0] === 'academy' || parts[0] === 'clubs') && parts[1] === 'new') {
        if (!S.me) {
          navigate('/signin?next=/clubs/new', { replace: true });
          return;
        }
        S.route = { name: 'orgNew' };
      } else if (parts[0] === 'notifications') {
        if (!S.me) {
          navigate('/signin?next=/notifications', { replace: true });
          return;
        }
        S.route = { name: 'notifications' };
        S.inbox = null;
        render();
        [S.inbox, S.notifySettings, S.phone] = await Promise.all([
          api('GET', '/notifications').catch(() => ({ items: [] })),
          api('GET', '/notifications/settings').catch(() => null),
          api('GET', '/me/phone').catch(() => null),
        ]);
        render();
        // Seen: the count goes, the dots stay until the next visit.
        if (S.inbox.items.some((n) => !n.read)) api('POST', '/notifications/read', {}).then(() => refreshBell(true)).catch(() => {});
        return;
      } else if (parts[0] === 'goals') {
        if (/^\d+$/.test(parts[1] || '')) {
          S.route = { name: 'goal', id: Number(parts[1]) };
          if (!S.goal || S.goal.id !== S.route.id) S.goal = null;
          render();
          S.goal = await api('GET', `/goals/${S.route.id}`).catch((e) => { S.error = e.message; return null; });
        } else if (!S.me) {
          navigate(`/signin?next=${encodeURIComponent(location.pathname)}`, { replace: true });
          return;
        } else if (parts[1] === 'new') {
          S.route = { name: 'goalNew' };
          S.goalDraft = null;
          render();
          S.goalClubs = await api('GET', '/clubs/mine').catch(() => []);
        } else {
          S.route = { name: 'goals' };
          S.goals = null;
          render();
          S.goals = await api('GET', '/goals').catch(() => ({ active: [], past: [] }));
        }
      } else if (parts[0] === 'champ' && /^\d+$/.test(parts[1] || '')) {
        S.route = { name: 'champ', id: Number(parts[1]), round: Number(params.get('round')) || null };
        if (!S.champ || S.champ.id !== S.route.id) S.champ = null;
        render();
        await loadChamp();
        return;
      } else if (parts[0] === 'champs') {
        if (parts[1] === 'new') {
          if (!S.me) { navigate(`/signin?next=${encodeURIComponent(location.pathname)}`, { replace: true }); return; }
          S.route = { name: 'champNew' };
          render();
          S.goalClubs = await api('GET', '/clubs/mine').catch(() => []);
        } else {
          S.route = { name: 'champs' };
          S.champs = null;
          render();
          S.champs = await api('GET', '/champs').catch(() => []);
        }
      } else if (parts[0] === 'meet' && /^\d+$/.test(parts[1] || '')) {
        S.route = { name: 'meet', id: Number(parts[1]), event: Number(params.get('event')) || null };
        if (!S.meet || S.meet.id !== S.route.id) S.meet = null;
        render();
        await loadMeet();
        return;
      } else if (parts[0] === 'meets') {
        if (parts[1] === 'new') {
          if (!S.me) { navigate(`/signin?next=${encodeURIComponent(location.pathname)}`, { replace: true }); return; }
          S.route = { name: 'meetNew' };
          render();
          [S.meetCatalogue, S.goalClubs] = await Promise.all([api('GET', '/meets/catalogue'), api('GET', '/clubs/mine').catch(() => [])]);
        } else {
          S.route = { name: 'meets' };
          S.meets = null;
          render();
          S.meets = await api('GET', '/meets').catch(() => ({ upcoming: [], past: [] }));
        }
      } else if (parts[0] === 'race' && /^\d+$/.test(parts[1] || '')) {
        S.route = { name: 'race', id: Number(parts[1]) };
        if (!S.race || S.race.id !== S.route.id) { S.race = null; S.raceTab = null; S.raceLast = null; S.raceAdd = null; }
        render();
        await loadRace();
        return;
      } else if (parts[0] === 'races') {
        if (parts[1] === 'new') {
          if (!S.me) { navigate(`/signin?next=${encodeURIComponent(location.pathname)}`, { replace: true }); return; }
          S.route = { name: 'raceNew' };
          render();
          S.goalClubs = await api('GET', '/clubs/mine').catch(() => []);
        } else {
          S.route = { name: 'races' };
          S.races = null;
          render();
          S.races = await api('GET', '/races').catch(() => ({ upcoming: [], past: [] }));
        }
      } else if (parts[0] === 'runs') {
        if (!S.me) {
          navigate(`/signin?next=${encodeURIComponent(location.pathname)}`, { replace: true });
          return;
        }
        S.route = { name: 'runs' };
        render();
        S.runs = await api('GET', '/runs').catch(() => null);
      } else if (parts[0] === 'challenges') {
        if (!S.me) {
          navigate(`/signin?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
          return;
        }
        if (parts[1] === 'new') {
          S.route = { name: 'challengeNew' };
          S.chDraft = null;
          S.chPeople = null;
          render();
          S.chPeople = await api('GET', `/challenges/people${params.get('to') ? `?with=${encodeURIComponent(params.get('to'))}` : ''}`).catch(() => []);
        } else {
          S.route = { name: 'challenges' };
          S.challenges = null;
          render();
          S.challenges = await api('GET', '/challenges').catch(() => ({ incoming: [], outgoing: [], toPlay: [], toConfirm: [], played: [] }));
        }
      } else if (parts[0] === 'club-run' && /^\d+$/.test(parts[1] || '')) {
        S.route = { name: 'clubRun', id: Number(parts[1]) };
        if (!S.clubRun || S.clubRun.id !== S.route.id) S.clubRun = null;
        S.clubRunMark = null;
        render();
        await loadClubRun();
        return;
      } else if (parts[0] === 'season' && /^\d+$/.test(parts[1] || '')) {
        S.route = { name: 'season', id: Number(parts[1]) };
        if (!S.season || S.season.id !== S.route.id) S.season = null;
        S.seasonPick = null;
        render();
        await loadSeason();
        return;
      } else if (parts[0] === 'cc' && /^\d+$/.test(parts[1] || '')) {
        S.route = { name: 'clubChallenge', id: Number(parts[1]) };
        if (!S.cc || S.cc.id !== S.route.id) S.cc = null;
        S.ccPick = null;
        render();
        await loadClubChallenge();
        return;
      } else if (parts[0] === 'c' && /^\d+$/.test(parts[1] || '')) {
        S.route = { name: 'challenge', id: Number(parts[1]) };
        if (!S.challenge || S.challenge.id !== S.route.id) S.challenge = null;
        render();
        await loadChallenge();
        return;
      } else if (parts[0] === 'clubs' && parts[1] === 'rankings') {
        S.route = { name: 'clubRankings', city: params.get('city') || '', kind: params.get('kind') || '' };
        S.clubRankings = null;
        render();
        S.clubRankings = await api('GET', `/club-rankings?city=${encodeURIComponent(S.route.city)}&kind=${encodeURIComponent(S.route.kind)}`).catch(() => ({ items: [], cities: [] }));
      } else if (parts[0] === 'clubs') {
        S.route = { name: 'clubs' };
        render();
        [S.clubsMine, S.clubsFound] = await Promise.all([
          S.me ? api('GET', '/clubs/mine').catch(() => []) : [],
          api('GET', '/clubs').catch(() => []),
        ]);
      } else if (parts[0] === 'a' && /^\d+$/.test(parts[1] || '')) {
        S.route = { name: 'item', id: Number(parts[1]) };
        S.item = null;
        render();
        S.item = await api('GET', `/activity/${S.route.id}`).catch((e) => ({ error: e.message }));
      } else if (parts[0] === 'club' && parts[1]) {
        const slug = parts[1].toLowerCase();
        S.route = { name: 'club', slug, tab: params.get('tab') || 'feed', join: params.get('join') };
        if (!S.club || S.club.slug !== slug) { S.club = null; S.clubFeed = null; }
        render();
        await loadClub();
        return;
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
      } else if (['play', 'you'].includes(parts[0]) && !parts[1]) {
        if (!S.me) {
          navigate(`/signin?next=/${parts[0]}`, { replace: true });
          return;
        }
        S.route = { name: parts[0] };
        render();
        if (parts[0] === 'play') {
          const [groups, challenges, goals, runs] = await Promise.all([
            api('GET', '/me/groups').catch(() => []),
            api('GET', '/challenges').catch(() => null),
            api('GET', '/goals').catch(() => null),
            api('GET', '/runs').catch(() => null),
          ]);
          S.hubPlay = { groups, challenges, goals, runs };
        }
      } else if (parts[0] === 'compete' && !parts[1]) {
        const tab = ['races', 'meets', 'racing'].includes(params.get('tab')) ? params.get('tab') : 'tournaments';
        S.route = { name: 'compete', tab };
        if (tab === 'tournaments') {
          S.filters = readFilters(params);
          render();
          [S.list, S.mine, S.myEntries, S.places] = await Promise.all([
            api('GET', `/tournaments?${filterQuery(S.filters, true)}`).catch(() => []),
            S.me ? api('GET', '/me/tournaments').catch(() => []) : null,
            S.me ? api('GET', '/me/entries').catch(() => []) : null,
            api('GET', '/tournaments/places').catch(() => []),
          ]);
        } else if (tab === 'races') { S.races = null; render(); S.races = await api('GET', '/races').catch(() => ({ upcoming: [], past: [] })); }
        else if (tab === 'meets') { S.meets = null; render(); S.meets = await api('GET', '/meets').catch(() => ({ upcoming: [], past: [] })); }
        else { S.champs = null; render(); S.champs = await api('GET', '/champs').catch(() => []); }
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
        if (S.me) api('GET', '/feed').then((f) => { S.feed = f; if (S.route.name === 'home') render(); }, () => { S.feed = { items: [] }; });
        // What the signed-in home needs to know: are you new, what's next, what's near.
        if (S.me) {
          Promise.all([
            api('GET', '/me/groups').catch(() => []), api('GET', '/clubs/mine').catch(() => []), api('GET', '/runs').catch(() => null),
            api('GET', '/goals').catch(() => null), api('GET', '/me/profile').catch(() => null), api('GET', '/races').catch(() => null),
            api('GET', '/meets').catch(() => null), api('GET', '/clubs').catch(() => []), api('GET', '/challenges').catch(() => null),
          ]).then(([groups, clubs, runs, goals, profile, races, meets, clubsFound, challenges]) => {
            S.homeData = { groups, clubs, runs, goals, profile, races, meets, clubsFound, challenges };
            if (S.route.name === 'home') render();
          });
        }
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
    else if (S.route.name === 'clubs') view = viewClubs();
    else if (S.route.name === 'club') view = viewClub();
    else if (S.route.name === 'item') view = viewItem();
    else if (S.route.name === 'notifications') view = viewNotifications();
    else if (S.route.name === 'challenges') view = viewChallenges();
    else if (S.route.name === 'goals') view = viewGoals();
    else if (S.route.name === 'runs') view = viewRuns();
    else if (S.route.name === 'races') view = viewRaces();
    else if (S.route.name === 'raceNew') view = viewRaceNew();
    else if (S.route.name === 'race') view = viewRace();
    else if (S.route.name === 'meets') view = viewMeets();
    else if (S.route.name === 'meetNew') view = viewMeetNew();
    else if (S.route.name === 'meet') view = viewMeet();
    else if (S.route.name === 'champs') view = viewChamps();
    else if (S.route.name === 'champNew') view = viewChampNew();
    else if (S.route.name === 'champ') view = viewChamp();
    else if (S.route.name === 'clubRankings') view = viewClubRankings();
    else if (S.route.name === 'goalNew') view = viewGoalNew();
    else if (S.route.name === 'goal') view = viewGoal();
    else if (S.route.name === 'challengeNew') view = viewChallengeNew();
    else if (S.route.name === 'challenge') view = viewChallenge();
    else if (S.route.name === 'clubChallenge') view = viewClubChallenge();
    else if (S.route.name === 'season') view = viewSeason();
    else if (S.route.name === 'clubRun') view = viewClubRun();
    else if (S.route.name === 'profile') view = viewProfile();
    else if (S.route.name === 'groups') view = viewGroups();
    else if (S.route.name === 'groupNew') view = viewGroupNew();
    else if (S.route.name === 'group') view = viewGroup();
    else if (S.route.name === 'groupGame') view = viewGroupGame();
    else if (S.route.name === 'org') view = viewOrgEdit();
    else if (S.route.name === 'tournament') view = S.t ? viewTournament() : loading();
    else if (S.route.name === 'match') view = S.t ? viewMatch() : loading();
    else if (S.route.name === 'display') view = S.t ? viewDisplay() : loading();
    else if (S.route.name === 'invite') view = viewInvite();
    else if (S.route.name === 'templates') view = viewTemplates();
    else if (S.route.name === 'play') view = viewPlay();
    else if (S.route.name === 'compete') view = viewCompete();
    else if (S.route.name === 'you') view = viewYou();
    else view = viewHome();
    // An invite from a friend: on the home page, sign-up and the New tournament flow.
    if (!S.error && ['home', 'signin', 'signup', 'new'].includes(S.route.name)) view = [inviteBanner(), view];
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
    renderHubs();
    renderSidebar();
    refreshBell();
  }

  const markDirty = (e) => {
    const form = e.target.closest && e.target.closest('form');
    if (!form) return;
    if (form.closest('details[data-panel]')) {
      form.setAttribute('data-dirty', '');
      return;
    }
    // Other forms count as unsent while anything typed (or picked) is still in them.
    const typed = [...form.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea')]
      .some((el) => el.value !== el.defaultValue && el.value.trim())
      || [...form.querySelectorAll('select')].some((sel) => [...sel.options].some((o) => o.selected !== o.defaultSelected));
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
  // ---------- hub pages
  const hubTile = (emoji, title, desc, stat, href) => h('a', { class: 'card hub-tile', href },
    h('span', { class: 'hub-emoji', 'aria-hidden': 'true' }, emoji),
    h('strong', {}, title), h('small', { class: 'muted' }, desc), stat ? h('span', { class: 'hub-stat' }, stat) : null);

  function viewPlay() {
    document.title = 'Play · Tonament';
    const P = S.hubPlay;
    const ch = P && P.challenges;
    const goals = P && P.goals ? P.goals.active : [];
    const needs = ch ? [...ch.incoming.map((x) => [x, 'Answer']), ...ch.toPlay.map((x) => [x, 'Play']), ...(ch.toConfirm || []).map((x) => [x, 'Confirm'])] : [];
    const needsCard = needs.length ? railCard('Needs you',
      h('ul', { class: 'rail-list' }, needs.slice(0, 6).map(([x, what]) => h('li', {}, h('span', { 'aria-hidden': 'true' }, '⚔️'),
        h('a', { href: `/c/${x.id}` }, `${sideNames(x.a)} v ${sideNames(x.b)}`), h('small', { class: 'muted' }, `${x.sport.name} · ${what}`))))) : null;
    const goalsCard = goals.length ? railCard('Your goals', h('div', { class: 'card-list' }, goals.slice(0, 3).map(goalCard)), h('a', { class: 'btn btn-small btn-ghost', href: '/goals' }, 'All')) : null;
    return withRail([
      h('h1', {}, 'Play'),
      h('p', { class: 'muted' }, 'Keep playing between events — with your regulars, your friends and your club. Every game counts towards your rating, goals and profile.'),
      h('div', { class: 'hub-grid' },
        hubTile('👥', 'Groups', 'Weekly games with your regulars: who\'s in, courts, results', P ? `${P.groups.length} group${P.groups.length === 1 ? '' : 's'}` : null, '/groups'),
        hubTile('⚔️', 'Challenges', 'Take on a friend; the loser confirms and ratings move', ch ? `${ch.incoming.length} to answer · ${ch.toPlay.length} to play` : null, '/challenges'),
        hubTile('🎯', 'Goals', '30 games this month, 100 km — alone, with friends or your club', P && P.goals ? `${goals.length} on` : null, '/goals'),
        hubTile('🏃', 'Runs', 'Log runs, beat your bests, top the week with friends', P && P.runs ? `${P.runs.week.km} km this week` : null, '/runs')),
      P && P.groups.length ? h('section', { class: 'section' }, h('h2', {}, 'Your groups'),
        h('ul', { class: 'card cc-list' }, P.groups.slice(0, 6).map((g) => h('li', {}, h('a', { href: `/g/${g.slug}` }, h('strong', {}, g.name)), h('span', { class: 'muted small' }, ` · ${g.sportName}${g.city ? ` · ${g.city}` : ''} · ${g.members} members`))))) : null,
      P == null ? loading() : null,
    ], [needsCard, goalsCard]);
  }

  function viewCompete() {
    document.title = 'Compete · Tonament';
    const tab = S.route.tab;
    const tabs = [['tournaments', 'Tournaments'], ['races', 'Races'], ['meets', 'Meets'], ['racing', 'Racing']];
    const go = (t) => navigate(t === 'tournaments' ? '/compete' : `/compete?tab=${t}`);
    const body = {
      tournaments: () => [
        findSection(),
        S.me && S.mine && !S.mine.length ? h('div', { class: 'card hub-cta' }, h('strong', {}, 'Run your own tournament'), h('p', { class: 'muted small' }, 'Entries and UPI fees, groups and knockouts, an order of play and live scores. Free for up to 16 entries.'), h('a', { class: 'btn btn-primary', href: '/new' }, 'Create a tournament')) : null,
      ],
      races: () => viewRaces(true),
      meets: () => viewMeets(true),
      racing: () => viewChamps(true),
    }[tab]();
    const tpls = S.me ? myTemplates() : [];
    const mineRail = tab === 'tournaments' && S.me ? [
      S.myEntries && S.myEntries.length ? railCard('My entries', h('div', { class: 'card-list' }, S.myEntries.map(myEntryCard)), null, 'my-entries') : null,
      S.mine && S.mine.length ? railCard('Tournaments I run', h('div', { class: 'card-list' }, S.mine.map((t) => tournamentCard(t, ROLE_NAMES[t.role]))),
        h('span', { class: 'actions' }, h('a', { class: 'btn btn-small btn-primary', href: '/new' }, '+ Tournament')), 'i-run') : null,
      tpls.length ? railCard('Your templates', h('ul', { class: 'rail-list template-list' }, tpls.slice(0, 3).map((x) => h('li', {},
        h('span', {}, h('strong', {}, x.name), h('small', { class: 'muted' }, x.events.join(' · '))),
        h('a', { class: 'btn btn-small', href: `/new?from=tpl:${x.id}` }, 'Use it')))),
      h('a', { class: 'btn btn-small btn-ghost', href: '/templates' }, tpls.length > 3 ? `All ${tpls.length}` : 'Manage'), 'my-templates') : null,
    ] : null;
    // Phones: the rail comes after the search, so a row of links up top jumps to it.
    const jumps = mineRail ? [
      S.myEntries && S.myEntries.length ? ['#my-entries', `My entries (${S.myEntries.length})`] : null,
      S.mine && S.mine.length ? ['#i-run', `I run (${S.mine.length})`] : null,
      tpls.length ? ['#my-templates', `Templates (${tpls.length})`] : null,
    ].filter(Boolean) : [];
    return withRail([
      h('h1', {}, 'Compete'),
      h('p', { class: 'muted' }, 'Find an event and enter, follow it live, or run your own — tournaments, races, track and pool meets, and racing.'),
      h('div', { class: 'seg hub-seg', role: 'group', 'aria-label': 'Kind of event' }, tabs.map(([id, label]) => h('button', { 'aria-pressed': String(tab === id), onclick: () => go(id) }, label))),
      jumps.length ? h('nav', { class: 'mine-jump', 'aria-label': 'Yours' }, jumps.map(([href, label]) => h('a', { class: 'btn btn-small btn-ghost', href, onclick: (e) => { e.preventDefault(); document.querySelector(href)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, label))) : null,
      body,
    ], mineRail);
  }

  // The account's links: the avatar menu and the You page share them.
  function accountItems() {
    const me = S.me;
    return [
      [
        { href: '/me/profile', label: 'Your profile', hint: 'Results, ratings, the club you represent' },
        { href: '/notifications', label: 'Notifications', hint: 'What\'s new, and how you\'re told' },
      ],
      [
        ...(S.myOrgs || []).map((o) => ({ href: `/@${o.slug}/edit`, label: o.name, hint: o.live ? 'Your public page' : 'Your page (draft)' })),
        S.billing && S.billing.enabled ? { href: '/invite', label: 'Invite organisers 🎁', hint: 'Their first tournament free; a free upgrade for you' } : null,
        me.isAdmin ? { href: '/admin', label: 'Admin', hint: 'Site administration' } : null,
      ].filter(Boolean),
      [
        canInstall() ? { label: 'Install the app', hint: 'On your home screen, works offline', onClick: () => installApp() } : null,
        { label: 'Sign out', onClick: signOut },
      ].filter(Boolean),
    ].filter((g) => g.length);
  }
  function viewYou() {
    document.title = 'You · Tonament';
    const me = S.me;
    const row = (it) => h(it.href ? 'a' : 'button', { class: 'you-row', ...(it.href ? { href: it.href } : { type: 'button', onclick: it.onClick }) }, h('span', {}, it.label), it.hint ? h('small', { class: 'muted' }, it.hint) : null);
    const groups = accountItems();
    return [
      h('div', { class: 'card you-head' },
        h('span', { class: 'avatar big', 'aria-hidden': 'true' }, initialsOf(me.name)),
        h('div', {}, h('h1', {}, me.name), h('p', { class: 'muted small' }, me.email))),
      groups.slice(0, -1).map((g) => h('div', { class: 'card you-list' }, g.map(row))),
      h('div', { class: 'card you-list' }, h('div', { class: 'you-row' }, h('span', {}, 'Theme'), themeSwitch()), groups[groups.length - 1].map(row)),
      h('p', { class: 'muted small center' }, h('a', { href: '/features' }, 'Features'), ' · ', h('a', { href: '/faq' }, 'Help'), ' · ', h('a', { href: '/contact' }, 'Contact')),
    ];
  }

  function viewHome() {
    document.title = 'Tonament — Run tournaments, races and leagues with live scores. Play more with your club.';
    return S.me ? homeSignedIn() : landing();
  }

  // Signed in: brand-new people get a way in ("Get going"); everyone else
  // their feed, with what's next, goals and what's on near them alongside.
  const CHECK_KEY = 'tonament:checklist-hidden';
  function homeChecklist(D) {
    const p = D.profile || {};
    const items = [
      [Boolean(p.city && (p.sportIds || []).length), 'Add your city and sports', 'So we can show what\'s near you', '/me/profile'],
      [D.clubs.some((c) => c.status === 'active'), 'Join or start a club', 'Club v club, seasons, runs — and a feed', '/clubs'],
      [Boolean((D.runs && D.runs.recent.length) || D.groups.length || (D.challenges && D.challenges.played && D.challenges.played.length)), 'Play a game or log a run', 'A challenge, a group game or a run', '/play'],
      [Boolean((S.myEntries || []).length || (S.mine || []).length), 'Enter or run an event', 'Tournaments, races, meets, racing', '/compete'],
      [Boolean(D.goals && D.goals.active.length), 'Set a goal', '30 games, 100 km — alone or with friends', '/goals/new'],
    ];
    const done = items.filter((x) => x[0]).length;
    let hidden = false;
    try { hidden = localStorage.getItem(CHECK_KEY) === '1'; } catch { /* fine */ }
    if (done === items.length || hidden) return null;
    return railCard(`Getting started · ${done} of ${items.length}`,
      [h('span', { class: 'progress start-progress' }, h('span', { style: `width:${(done / items.length) * 100}%` })),
        h('ul', { class: 'start-list' }, items.map(([ok, label, hint, href]) => h('li', { class: ok ? 'done' : '' },
          h('span', { class: 'tick', 'aria-hidden': 'true' }, ok ? '✓' : ''),
          ok ? h('span', {}, label) : h('a', { href }, h('strong', {}, label), h('small', { class: 'muted' }, hint))))),
        h('button', { class: 'link-btn small', onclick: () => { try { localStorage.setItem(CHECK_KEY, '1'); } catch { /* fine */ } render(); } }, 'Hide this')]);
  }
  // Upcoming public events, near you first (by your profile's city).
  function nearYou(D) {
    const city = ((D.profile && D.profile.city) || '').toLowerCase();
    const list = [
      ...(S.list || []).map((t) => ({ kind: '🏆', name: t.name, when: t.startsOn, city: t.city, href: `/t/${t.id}` })),
      ...((D.races && D.races.upcoming) || []).map((r) => ({ kind: '🏃', name: r.name, when: r.startsAt, city: r.city, href: `/race/${r.id}` })),
      ...((D.meets && D.meets.upcoming) || []).map((m) => ({ kind: '🏅', name: m.name, when: m.startsAt, city: m.city, href: `/meet/${m.id}` })),
    ];
    const near = city ? list.filter((x) => (x.city || '').toLowerCase() === city) : [];
    const shown = (near.length ? near : list).sort((a, b) => String(a.when || '9').localeCompare(String(b.when || '9'))).slice(0, 5);
    return railCard(near.length ? `Near you · ${D.profile.city}` : 'Coming up',
      shown.length ? h('ul', { class: 'rail-list' }, shown.map((x) => h('li', {}, h('span', { 'aria-hidden': 'true' }, x.kind), h('a', { href: x.href }, x.name), h('small', { class: 'muted' }, [x.when ? fmtDates(String(x.when).slice(0, 10)) : null, x.city].filter(Boolean).join(' · ')))))
        : h('p', { class: 'muted small' }, 'Nothing listed yet — be the first to put one on.'),
      h('a', { class: 'btn btn-small btn-ghost', href: '/compete' }, 'All'));
  }
  function homeSignedIn() {
    const D = S.homeData;
    if (!D) return [installBanner(), loading()];
    const first = S.me.name.split(' ')[0];
    const isNew = !D.clubs.length && !D.groups.length && !(D.runs && D.runs.recent.length) && !(S.myEntries || []).length && !(S.mine || []).length
      && !(D.challenges && [...D.challenges.incoming, ...D.challenges.outgoing, ...D.challenges.toPlay, ...D.challenges.played].length);
    const goalsRail = D.goals && D.goals.active.length ? railCard('Your goals', h('div', { class: 'card-list' }, D.goals.active.slice(0, 2).map(goalCard)), h('a', { class: 'btn btn-small btn-ghost', href: '/goals' }, 'All')) : null;
    const upNext = (S.myEntries || []).length ? railCard('Up next', h('ul', { class: 'rail-list' }, S.myEntries.slice(0, 4).map((t) => h('li', {}, h('span', { 'aria-hidden': 'true' }, '🎟️'), h('a', { href: `/t/${t.id}` }, t.name), h('small', { class: 'muted' }, [t.entry.eventName, t.startsOn ? fmtDates(String(t.startsOn).slice(0, 10)) : null].filter(Boolean).join(' · '))))), h('a', { class: 'btn btn-small btn-ghost', href: '/compete' }, 'All')) : null;
    const rail = [homeChecklist(D), upNext, goalsRail, nearYou(D)];
    if (isNew) {
      const intent = (emoji, title, desc, actions) => h('div', { class: 'card intent-card' },
        h('span', { class: 'hub-emoji', 'aria-hidden': 'true' }, emoji), h('h3', {}, title), h('p', { class: 'muted small' }, desc),
        h('div', { class: 'actions' }, actions.map(([label, href, primary]) => (typeof href === 'function'
          ? h('button', { type: 'button', class: `btn btn-small${primary ? ' btn-primary' : ''}`, onclick: href }, label)
          : h('a', { class: `btn btn-small${primary ? ' btn-primary' : ''}`, href }, label)))));
      const clubs = (D.clubsFound || []).slice(0, 4);
      return [
        installBanner(),
        withRail([
          h('section', { class: 'hero welcome-hero' },
            h('p', { class: 'eyebrow' }, 'Welcome to Tonament'),
            h('h1', {}, `Hi ${first} — what would you like to do?`),
            h('p', { class: 'lead' }, 'Pick a way in. You can do all of it, any time, from the + New button.')),
          h('div', { class: 'intent-grid' },
            intent('🏆', 'Run an event', 'A tournament, a race, a track or pool meet, or a racing championship — entries, fees and live scores.', [['Tournament', '/new', true], ['Race', '/races/new'], ['More…', createSheet]]),
            intent('🏸', 'Play regularly', 'Weekly games with your regulars, and challenges to friends. Your rating moves with every game.', [['Start a group', '/groups/new', true], ['Challenge a friend', '/challenges/new']]),
            intent('🏠', 'Join or start a club', 'Members, a feed, club v club, seasons and club runs — all free.', [['Find a club', '/clubs', true], ['Start one', '/clubs/new']]),
            intent('🏃', 'Run & race', 'Log your runs, beat your 5K and 10K bests, and enter races and meets.', [['Log a run', '/runs', true], ['Find a race', '/compete?tab=races']])),
          clubs.length ? h('section', { class: 'section' }, h('div', { class: 'card-head' }, h('h2', {}, 'Clubs to join'), h('a', { class: 'btn btn-small btn-ghost', href: '/clubs' }, 'All clubs')),
            h('div', { class: 'card-list' }, clubs.map((c) => h('a', { class: 'card club-card', href: `/club/${c.slug}` },
              h('span', { class: 'club-icon' }, icon(KIND_ICON[c.kind] || 'club')),
              h('span', { class: 'club-card-text' }, h('strong', {}, c.name), h('small', { class: 'muted' }, [c.kindName, c.city, `${c.members} member${c.members === 1 ? '' : 's'}`].filter(Boolean).join(' · '))))))) : null,
        ], rail),
      ];
    }
    const quick = [['⏱️', 'Log a run', '/runs'], ['⚔️', 'Challenge someone', '/challenges/new'], ['🔎', 'Find an event', '/compete'], ['🏠', 'Your clubs', '/clubs']];
    return [
      installBanner(),
      withRail([
        h('div', { class: 'home-hello' }, h('h1', {}, `Hi, ${first}`)),
        h('div', { class: 'quick-row' }, quick.map(([e, label, href]) => h('a', { class: 'quick-chip', href }, h('span', { 'aria-hidden': 'true' }, e), label))),
        homeFeed(),
      ], rail),
    ];
  }

  // Signed out: what Tonament is for, who it's for, the problems it solves.
  function landing() {
    const go = S.me ? '/new' : '/signup';
    const find = (e) => { e.preventDefault(); document.getElementById('all-tournaments')?.scrollIntoView({ behavior: 'smooth' }); };
    const roles = [
      ['🏆', 'Organisers', 'Run the event, not the paperwork', ['Tournaments in 18 sports: groups, leagues, knockouts, team ties', 'Races, track and pool meets, and racing championships', 'Online entries, UPI fees, an order of play, live scores on any phone'], '/features'],
      ['🏸', 'Players', 'Play more, and keep a record of it', ['Weekly games with your regulars, and challenges to friends', 'A rating that moves with every game, and ladders to climb', 'Every result, title and best on your profile'], '/signup'],
      ['🏠', 'Clubs & academies', 'Give your club something to play for', ['Members, a club feed and a leaderboard — free', 'Club v club ties, seasons against other clubs, club runs', 'Honours, and a place in the club rankings'], '/clubs'],
      ['🏃', 'Runners & athletes', 'From your weekly run to race day', ['Log runs, beat your 5K and 10K bests, top the week with friends', 'Enter races and meets, and get your bib', 'Results by age group, medals and personal bests'], '/races'],
    ];
    const problems = [
      ['A paper draw that\'s out of date by 10 am', 'Groups, brackets and the order of play update themselves — and you can still change anything, like on paper.'],
      ['"What\'s the score?" in five WhatsApp groups', 'Every point live on everyone\'s phone, and on the venue TV.'],
      ['Chasing entry fees and who\'s paid', 'Entries online, fees by UPI or cash, and a list of who\'s paid.'],
      ['"Who\'s coming on Sunday?"', 'Groups and club runs where people say they\'re in, and the courts or start are set.'],
      ['Games that leave no trace', 'Results, ratings, bests and titles on your profile — shareable as a card.'],
      ['Clubs with nothing to play for between tournaments', 'Club v club, seasons, ladders, goals and the club rankings.'],
    ];
    const steps = [
      ['1', 'Start it', 'A tournament, a race, a group or a club — in a couple of minutes, free.'],
      ['2', 'Share the link', 'Players enter, join and pay from their phones. No app to install.'],
      ['3', 'Play it live', 'Score on any phone; results go to everyone\'s profile, feed and club.'],
    ];
    return [
      installBanner(),
      h('section', { class: 'hero landing-hero' },
        h('div', { class: 'landing-copy' },
          h('p', { class: 'eyebrow' }, 'One platform. Every sport. ', h('b', {}, 'Every tournament.')),
          h('h1', {}, 'Organise it. Play it. ', h('span', { class: 'hl' }, 'Follow it live.')),
          h('p', { class: 'lead' }, 'Tonament runs tournaments, leagues, races and meets with live scores — and keeps players and clubs playing in between, with weekly games, challenges, club v club and runs. Free to start, on any phone.'),
          h('div', { class: 'actions' },
            h('a', { class: 'btn btn-primary btn-lg', href: go }, S.me ? 'Create a tournament' : 'Get started — it\'s free'),
            h('a', { class: 'btn btn-lg btn-ghost', href: '#all-tournaments', onclick: find }, 'Find an event')),
          h('p', { class: 'muted small' }, `${liveSports().length || 18} sports · tournaments, races, meets and racing · used by clubs, academies and venues`)),
        h('div', { class: 'landing-visuals' },
          h('div', { class: 'landing-visual back' }, h('img', { src: '/guide/pools-dark.jpg', alt: 'Groups by level with live standings', width: 390, loading: 'eager' })),
          h('div', { class: 'landing-visual' }, h('img', { src: '/guide/umpire-dark.jpg', alt: 'Scoring a badminton match point by point on a phone', width: 390, loading: 'eager' })))),
      h('section', { class: 'section' },
        h('h2', { class: 'landing-h2' }, 'What you can do'),
        h('div', { class: 'role-grid' }, roles.map(([e, who, promise, list, href]) => h('div', { class: 'card role-card' },
          h('span', { class: 'hub-emoji', 'aria-hidden': 'true' }, e),
          h('h3', {}, who), h('p', { class: 'role-promise' }, promise),
          h('ul', {}, list.map((x) => h('li', {}, x))),
          h('a', { class: 'link-arrow', href }, 'See how →'))))),
      h('section', { class: 'section' },
        h('h2', { class: 'landing-h2' }, 'The problems it solves'),
        h('div', { class: 'problem-grid' }, problems.map(([before, after]) => h('div', { class: 'card problem' },
          h('p', { class: 'problem-before' }, before), h('p', { class: 'problem-after' }, after))))),
      h('section', { class: 'section' },
        h('h2', { class: 'landing-h2' }, 'How it works'),
        h('ol', { class: 'how-steps' }, steps.map(([n, t, d]) => h('li', { class: 'card how-step' }, h('span', { class: 'how-n', 'aria-hidden': 'true' }, n), h('strong', {}, t), h('small', { class: 'muted' }, d))))),
      findSection(),
      sportsSection(),
      h('section', { class: 'card landing-cta' },
        h('h2', {}, 'Your next event starts here'),
        h('p', { class: 'muted' }, 'Free for up to 16 entries. Clubs, groups, challenges and runs are always free.'),
        h('div', { class: 'actions', style: 'justify-content:center' }, h('a', { class: 'btn btn-primary btn-lg', href: go }, 'Get started — it\'s free'), h('a', { class: 'btn btn-lg btn-ghost', href: '/features' }, 'All features'))),
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
    const base = S.route.name === 'compete' ? '/compete' : '/';
    history.replaceState(null, '', qs ? `${base}?${qs}` : base);
    try { localStorage.setItem(FILTERS_KEY, JSON.stringify(S.filters)); } catch { /* fine */ }
    const list = await api('GET', `/tournaments?${filterQuery(S.filters, true)}`).catch(() => null);
    if (seq !== searchSeq || !['home', 'compete'].includes(S.route.name)) return;
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
    const rules = window.TonamentSports[sport.id];
    if (rules && rules.timed) {
      // Football, basketball, …: the sport's own rules decide draws and league points.
      const lp = rules.leaguePoints;
      return h('fieldset', { class: 'scoring-set' }, h('legend', {}, `${sport.name} rules`),
        sport.fields.length ? h('div', { class: 'scoring-grid' }, sport.fields.map((f) => groupField(f.label, choiceGroup({ name: `scoring.${f.key}`, value: scoring[f.key], options: f.options, label: f.label }), null, f.hint))) : null,
        h('p', { class: 'hint', style: 'margin:0' }, rules.draws
          ? `League matches can be drawn: win ${lp.win} points, draw ${lp.draw}. Group tables rank on points, then ${rules.compute('', {}).unit === 'Goal' ? 'goal' : 'point'} difference.`
          : `No draws: a level game goes to overtime. Group tables rank on wins (${lp.win} points each), then point difference.`));
    }
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

  // Event details for everyone: the format and the scoring, read-only. Organisers
  // edit them in Event settings until the event starts; after that they're
  // locked (every match is played to the same rules), but still shown here.
  function eventDetailsCard(t) {
    const sport = S.sports.find((x) => x.id === t.sport.id);
    if (!sport) return null;
    const rules = window.TonamentSports && window.TonamentSports[sport.id];
    const sc = { ...sport.defaults, ...(t.config.scoring || {}) };
    const unit = sportUnit(sport.id).toLowerCase();
    const rows = [];
    const add = (label, value) => { if (value) rows.push([label, value]); };
    // Format.
    const league = t.format === 'league' || t.format === 'league_knockout';
    const groups = t.groups && t.groups.length;
    add('Format', [t.formatName,
      league ? (groups ? `${groups} group${groups === 1 ? '' : 's'}` : t.config.groupSize ? `groups of about ${t.config.groupSize}` : null) : null,
      t.format === 'league_knockout' && t.config.qualifiers ? `top ${t.config.qualifiers} from each group into the knockout` : null,
    ].filter(Boolean).join(' · '));
    if (poolsOn(t)) add('Split by level', t.config.pools === 'two' ? 'Lower and upper levels play apart and meet in the final' : 'Each level plays its own groups; the level winners meet in the semis');
    // Scoring, in the sport's own words (the same options the organiser chose from).
    const value = (f) => {
      const v = sc[f.key];
      if (f.type === 'select') return (f.options.find((o) => String(o.value) === String(v)) || {}).label || null;
      return v == null || v === '' ? null : String(v);
    };
    for (const f of sport.fields || []) if (!(f.key === 'tie' && t.format === 'league')) add(f.label, value(f)); // no knockout, no tie-break
    if (league && !(rules && rules.timed)) {
      add('League matches', t.config.leagueDraws ? `2 ${unit}s — 1 each is a draw (win 2, draw 1, loss 0)` : 'Always a winner');
    } else if (league && rules && rules.timed && rules.leaguePoints) {
      add('League points', rules.draws ? `Win ${rules.leaguePoints.win}, draw ${rules.leaguePoints.draw}` : `Win ${rules.leaguePoints.win} (no draws)`);
    }
    if (t.config.partners === 'drawn') add('Partners', 'Drawn at random on the day');
    // Entries.
    const count = t.entries.filter((e) => e.confirmed !== false && !e.withdrawn).length;
    add('Entries', `${count}${t.config.maxEntries ? ` of ${t.config.maxEntries} places` : ''}`);
    if (t.event.fee) add('Entry fee', `${money(t.event.fee)}${t.config.feePer === 'player' ? ' per player' : ''}`);
    const locked = t.status !== 'setup';
    const changed = t.config.scoringChanged;
    const canChange = locked && t.can.manage && t.status !== 'completed' && !t.official;
    return h('div', { class: 'card event-details' },
      h('h2', {}, 'Event details'),
      h('dl', { class: 'details-list' }, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      changed ? h('p', { class: 'muted small', style: 'margin:8px 0 0' }, `Scoring changed during the event (${fmtWhen(changed.at)}). Matches finished before then keep their result.`) : null,
      canChange && S.changeScoringFor !== t.eventId
        ? h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { class: 'btn btn-small', type: 'button', onclick: () => { S.changeScoringFor = t.eventId; render(); } }, 'Change match length or points'))
        : null,
      canChange && S.changeScoringFor === t.eventId ? changeScoringForm(t, sport) : null);
  }

  // Mid-event: the wrong match length was chosen. Shows what will happen, then applies it.
  function changeScoringForm(t, sport) {
    const form = h('form', {
      class: 'form change-scoring',
      onsubmit: async (e) => {
        e.preventDefault();
        const { scoring, leagueDraws } = readFormat(form, sport);
        const body = withEv(t, { scoring, leagueDraws });
        try {
          const r = await api('POST', `${tPath(t)}/scoring/preview`, body, t.id);
          const lines = [
            r.finished ? `${r.finished} finished match${r.finished === 1 ? '' : 'es'} keep${r.finished === 1 ? 's' : ''} its result.` : null,
            r.endsNow.length ? `${r.endsNow.length} in progress ${r.endsNow.length === 1 ? 'is' : 'are'} already decided by the new rules and end${r.endsNow.length === 1 ? 's' : ''} now: ${r.endsNow.join(', ')}.` : null,
            r.inProgress ? `${r.inProgress} in progress carr${r.inProgress === 1 ? 'ies' : 'y'} on under the new rules.` : null,
            r.toCome ? `${r.toCome} still to play will use the new rules.` : null,
          ].filter(Boolean);
          if (!confirm(`Change the scoring for ${t.event.name || 'this event'}?\n\n${lines.join('\n')}`)) return;
          act(async () => {
            S.t = await api('POST', `${tPath(t)}/scoring`, body, t.id);
            S.changeScoringFor = null;
          }, 'Scoring changed');
        } catch (err) {
          toast(err.message, true);
        }
      },
    },
    h('p', { class: 'muted small', style: 'margin:0 0 8px' }, 'Chose the wrong match length? Finished matches keep their result; everything else follows the new rules from now. You\'ll see what changes before anything is saved.'),
    scoringFields(sport, { ...sport.defaults, ...(t.config.scoring || {}) }, t.config.leagueDraws),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Review the change'),
      h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { S.changeScoringFor = null; render(); } }, 'Cancel')));
    return form;
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
  // Next year's edition: "Diwali Open 2025" → "Diwali Open 2026".
  const nextEdition = (name) => {
    const year = new Date().getFullYear();
    const m = String(name).match(/\b(20\d\d)\b/);
    if (!m) return name;
    return name.replace(m[1], String(Math.max(Number(m[1]) + 1, year)));
  };
  // A template's name for this year's tournament.
  const withYear = (name) => (/\b20\d\d\b/.test(name) ? nextEdition(name) : `${name} ${new Date().getFullYear()}`);
  // Everything on one screen: start blank, from a template or from a
  // tournament you ran; name, date, events and format; create.
  function viewNew() {
    document.title = 'New tournament · Tonament';
    const live = liveSports();
    if (!live.length) return loading();
    const d = (S.newDraft ||= { from: S.route.from || '', sport: live[0].id, types: null, custom: false, events: null, format: 'league_knockout', name: S.route.title || '', startsOn: '', startTime: '', only: null, sourceEvents: null });
    myTemplates();
    if (S.mine === undefined) { S.mine = null; api('GET', '/me/tournaments').then((l) => { S.mine = l; render(); }, () => { S.mine = []; }); }
    const templates = S.newTemplates || [];
    const past = (S.mine || []).filter((t) => ['owner', 'organiser'].includes(t.role)).slice(0, 8);
    // The source: '' (blank), 'tpl:<id>' or 't:<id>'.
    const [kind, ref] = d.from ? d.from.split(/:(.*)/s) : ['', ''];
    const tpl = kind === 'tpl' ? templates.find((x) => String(x.id) === ref) : null;
    const pastT = kind === 't' ? past.find((x) => x.id === ref) || (S.newSource && S.newSource.id === ref ? S.newSource : null) : null;
    if (kind === 't' && (!S.newSource || S.newSource.id !== ref)) {
      S.newSource = { id: ref, loading: true };
      api('GET', `/tournaments/${encodeURIComponent(ref)}?me=1`).then((t) => { S.newSource = { id: t.id, name: t.name, sport: t.sport.id, events: t.events.map((e) => e.name) }; render(); })
        .catch(() => { S.newSource = { id: ref, error: true }; render(); });
    }
    const source = tpl ? { name: tpl.name, sport: tpl.sport, events: tpl.events } : kind === 't' && S.newSource && S.newSource.id === ref && !S.newSource.loading ? S.newSource : null;
    // Arriving with a source (a template's "Use it"): its name to start with.
    if (source && !d.name && !d.nameTouched) d.name = tpl ? withYear(tpl.name) : nextEdition(source.name);
    const sport = live.find((x) => x.id === (source ? source.sport : d.sport)) || live[0];
    const presets = CAT.presetsFor(sport.id);
    if (!d.types || !d.types.length) d.types = [typeOf(presets[0])];
    const chosen = () => (d.custom ? d.events || [] : d.types.map((type) => ({ ...fromType(type), age: 'Open', level: 'Open' })));
    const pick = (value) => {
      Object.assign(d, { from: value, only: null });
      if (value.startsWith('t:')) {
        const t = past.find((x) => `t:${x.id}` === value);
        if (t && !d.nameTouched) d.name = nextEdition(t.name);
      } else if (value.startsWith('tpl:')) {
        const x = templates.find((y) => `tpl:${y.id}` === value);
        if (x && !d.nameTouched) d.name = withYear(x.name);
      }
      render();
    };

    const starts = templates.length || past.length
      ? field('Start from', h('select', { value: d.from, onchange: (e) => pick(e.target.value) },
        h('option', { value: '' }, 'A blank tournament'),
        templates.length ? h('optgroup', { label: 'Your templates' }, templates.map((x) => h('option', { value: `tpl:${x.id}` }, `${x.name} · ${x.events.length} event${x.events.length === 1 ? '' : 's'}`))) : null,
        past.length ? h('optgroup', { label: 'A tournament you ran (same events and settings)' }, past.map((x) => h('option', { value: `t:${x.id}` }, x.name))) : null,
        kind === 't' && !past.some((x) => x.id === ref) ? h('option', { value: d.from }, pastT && pastT.name ? pastT.name : 'That tournament') : null), null,
      d.from ? 'Its events, format, scoring, fees, prizes and venue — no players or results.' : null)
      : null;

    let builder = null;
    let what;
    if (d.from) {
      if (!source) what = S.newSource && S.newSource.error ? h('p', { class: 'muted small' }, 'Couldn\'t open that tournament.') : loading();
      else {
        const on = d.only || source.events;
        const group = choiceGroup({
          name: 'only', label: 'Events', multiple: true, value: on,
          options: source.events.map((x) => ({ value: x, label: x })),
          onchange: () => { d.only = [...group.querySelectorAll('input:checked')].map((x) => x.value); },
        });
        what = h('div', { class: 'field' }, h('span', { class: 'label' }, `${sport.name} events`), group);
      }
    } else {
      const quick = choiceGroup({
        name: 'types', label: 'Events', value: d.types, multiple: true, tiles: true,
        options: presets.map((p) => ({ value: typeOf(p), label: p.label, icon: typeIcon(typeOf(p)) })),
        onchange: () => { d.types = [...quick.querySelectorAll('input:checked')].map((x) => x.value); },
      });
      if (d.custom) builder = eventBuilder(d.events || chosen(), sport.id);
      what = [
        field('Sport', h('select', {
          name: 'sport', value: sport.id,
          onchange: (e) => { Object.assign(d, { sport: e.target.value, types: null, custom: false, events: null }); render(); },
        }, live.map((x) => h('option', { value: x.id }, x.name)))),
        h('div', { class: 'field' }, h('span', { class: 'label' }, `${sport.name} events`),
          d.custom ? builder : [quick,
            h('button', { type: 'button', class: 'link-btn', onclick: () => { d.events = chosen(); d.custom = true; render(); } }, 'Age groups, levels or more events…')]),
        groupField('Format', choiceGroup({
          name: 'format', label: 'Format', value: d.format,
          options: FORMATS.map(([value, label]) => ({ value, label })),
          onchange: (e) => { d.format = e.target.value; },
        }), null, 'For every event; change any of them later.'),
      ];
    }

    // From a poster or form (AI): the draft to review takes over the page.
    if (d.draft) return draftReview(d, live);
    const year = new Date().getFullYear();
    const form = h('form', {
      class: 'card new-flow form quick-new',
      onsubmit: async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        if (builder) {
          const { events, error } = builder.readList();
          if (error) { toast(error, true); return; }
          d.events = events;
        }
        btn.disabled = true;
        const common = { name: d.name, startsOn: d.startsOn, startTime: d.startTime };
        const body = d.from
          ? { ...common, from: kind === 'tpl' ? { template: Number(ref) } : { tournament: ref }, ...(d.only && { only: d.only }) }
          : { ...common, sport: sport.id, country: REGIONS.defaultCountry, format: d.format, groupSize: 4, qualifiers: 2, scoring: sport.defaults, events: chosen() };
        try {
          const { id, gift } = await api('POST', '/tournaments', body);
          S.newDraft = null;
          S.newSource = null;
          if (gift) S.gift = null;
          toast(gift ? `Created on the ${gift.plan} plan (up to ${gift.entries} entries) — a gift from ${gift.from} 🎁` : 'Tournament created — finish setting it up below');
          navigate(`/t/${id}`);
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      },
    },
    h('h1', {}, 'New tournament'),
    starts,
    field('Tournament name', h('input', { name: 'name', required: true, maxlength: 80, value: d.name, placeholder: `e.g. ${sport.name} Open ${year}`, autocomplete: 'off', oninput: (e) => { d.name = e.target.value; d.nameTouched = true; } })),
    h('div', { class: 'grid-2' },
      field('Date', h('input', { type: 'date', name: 'startsOn', value: d.startsOn, oninput: (e) => { d.startsOn = e.target.value; } }), null, 'Helps players find it. You can change it later.'),
      field('Start time (optional)', h('input', { type: 'time', name: 'startTime', value: d.startTime, oninput: (e) => { d.startTime = e.target.value; } }))),
    what,
    h('p', { class: 'muted small' }, d.from ? 'It starts private, with no players — publish it when you\'re ready.' : 'Venue, entry fees, prizes and courts are on your tournament page, whenever you\'re ready.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit', disabled: Boolean(d.from && !source) }, 'Create tournament')));
    return S.aiEnabled && !d.from ? [aiStartCard(d), form] : form;
  }

  // ---------- AI credits (server/credits.js): a flat fee per tournament, as credits
  const loadCredits = async (tid = null) => {
    const key = tid || '';
    try { S.aiCredits = { ...(S.aiCredits || {}), [key]: await api('GET', `/ai/credits${tid ? `?t=${encodeURIComponent(tid)}` : ''}`) }; } catch { /* AI off or signed out */ }
    render();
  };
  const creditsFor = (tid = null) => {
    const key = tid || '';
    const c = (S.aiCredits || {})[key];
    if (c === undefined) { S.aiCredits = { ...(S.aiCredits || {}), [key]: null }; loadCredits(tid); }
    return c || null;
  };
  // Buys an AI pack in Razorpay Checkout, then refreshes the balance.
  async function buyAi(pack, tid = null) {
    try {
      const order = await api('POST', '/ai/checkout', { pack, ...(tid && { tournament: tid }) });
      const result = await payEntry(order);
      if (result === 'paid') { toast('Payment received — AI credits added ✓'); await loadCredits(tid); if (tid) await loadCredits(null); }
      else if (result === 'cancelled') toast('Payment cancelled — you haven\'t been charged');
    } catch (e) { toast(e.message, true); }
  }
  // Out of credits (a 402 with code ai_credits), or "Get more": the packs, with what they do.
  function aiPacksSheet(tid = null, why = null) {
    const c = creditsFor(tid);
    const price = (k) => (c ? money(c.prices[k]) : '');
    const items = tid
      ? [
        { label: `AI setup + on the day · ${price('both')}`, hint: 'Poster and form setup, the Google Form import, and the on-the-day assistant', onClick: () => buyAi('both', tid) },
        { label: `AI on the day · ${price('manage')}`, hint: 'Late entries, check-ins and no-shows handled with you, for this tournament', onClick: () => buyAi('manage', tid) },
        { label: `AI setup · ${price('create')}`, hint: 'Poster and form setup and the Google Form import', onClick: () => buyAi('create', tid) },
        { label: `Top-up · ${price('topup')}`, hint: '100 more on-the-day credits', onClick: () => buyAi('topup', tid) },
      ]
      : [{ label: `AI setup · ${price('create')}`, hint: 'Set up tournaments from posters, forms and messages', onClick: () => buyAi('create') }];
    actionSheet(why || 'Get AI help', items);
  }
  // A one-line balance with a "Get more" link (nothing while payments are off).
  function creditsLine(tid = null, scope = 'create') {
    const c = creditsFor(tid);
    if (!c || !c.enforced) return null;
    const b = c.balance[scope];
    const text = scope === 'create' && c.freeFirst ? 'Your first AI setup is free' : b.total ? `${b.total} AI ${scope === 'create' ? 'setup' : 'on-the-day'} credit${b.total === 1 ? '' : 's'} left` : `No AI ${scope === 'create' ? 'setup' : 'on-the-day'} credits left`;
    return h('p', { class: `muted small credits-line${b.low ? ' low' : ''}` }, text, ' · ', h('button', { class: 'link-btn', type: 'button', onclick: () => aiPacksSheet(tid) }, b.total || (scope === 'create' && c.freeFirst) ? 'Get more' : 'Get AI credits'));
  }
  const outOfCredits = (e, tid = null) => {
    if (e.code !== 'ai_credits') return false;
    loadCredits(tid);
    aiPacksSheet(tid, e.message);
    return true;
  };

  // ---------- AI setup: start from a poster, a Google Form or the announcement's text
  function aiStartCard(d) {
    const read = async (body) => {
      d.reading = true;
      render();
      try {
        const r = await api('POST', '/ai/tournament-draft', body);
        d.draft = { ...r.draft, events: (r.draft.events || []).map((e) => ({ ...e })) };
        d.problems = r.problems || [];
        window.scrollTo(0, 0);
        loadCredits(null);
      } catch (e) {
        if (!outOfCredits(e)) toast(e.message, true);
      }
      d.reading = false;
      render();
    };
    const pick = async (file) => {
      if (!file) return;
      try {
        if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
          if (file.size > 3 * 1024 * 1024) throw new Error('That PDF is over 3 MB — take a photo of the poster instead');
          const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(new Error('That file couldn\'t be read')); r.readAsDataURL(file); });
          await read({ pdf: data });
        } else await read({ image: await prepareImage(file, 'photo') });
      } catch (e) {
        toast(e.message, true);
      }
    };
    if (d.reading) {
      return h('div', { class: 'card ai-start reading' }, h('h2', {}, 'Reading it…'),
        h('p', { class: 'muted' }, 'Pulling out the name, dates, venue, events and fees. This takes about half a minute.'),
        h('div', { class: 'progress' }, h('span', { class: 'indeterminate' })));
    }
    const link = h('input', { type: 'url', name: 'formUrl', placeholder: 'https://forms.gle/…', 'aria-label': 'Google Form link', inputmode: 'url' });
    const text = h('textarea', { name: 'announcement', rows: 3, maxlength: 5000, placeholder: 'Or paste the WhatsApp message or announcement', 'aria-label': 'Announcement text' });
    return h('div', { class: 'card ai-start' },
      h('h2', {}, 'Start from your poster or Google Form'),
      h('p', { class: 'muted small' }, 'We\'ll fill in the tournament for you to check — nothing is saved until you press Create.'),
      creditsLine(null, 'create'),
      h('label', { class: 'btn btn-primary ai-file' }, icon('camera'), h('span', {}, 'Take or upload the poster'),
        h('input', { type: 'file', accept: 'image/*,application/pdf', hidden: true, onchange: (e) => pick(e.target.files[0]) })),
      h('form', { class: 'ai-row', onsubmit: (e) => { e.preventDefault(); if (link.value.trim()) read({ formUrl: link.value.trim() }); } },
        link, h('button', { class: 'btn', type: 'submit' }, 'Read the form')),
      h('form', { class: 'ai-row stack', onsubmit: (e) => { e.preventDefault(); if (text.value.trim()) read({ text: text.value }); } },
        text, h('button', { class: 'btn', type: 'submit' }, 'Read the text')),
      h('p', { class: 'muted small ai-or' }, 'Or fill it in yourself below.'));
  }

  // The draft, to check and change before it's created. Guesses are marked.
  const EV_DISCIPLINES = [['singles', 'Singles'], ['doubles', 'Doubles'], ['team', 'Team'], ['any', 'Singles or pairs']];
  const EV_GENDERS = [['men', 'Men'], ['women', 'Women'], ['mixed', 'Mixed'], ['open', 'Open']];
  function draftReview(d, live) {
    const x = d.draft;
    const unsure = (key) => (x.unsure || []).find((u) => u.field === key || u.field.startsWith(`${key}.`) || u.field.startsWith(`${key}[`));
    const check = (key) => { const u = unsure(key); return u ? h('span', { class: 'check-this', title: u.reason }, 'Check this', h('small', {}, ` — ${u.reason}`)) : null; };
    const problem = (i) => (d.problems || []).find((p) => p.field === `events.${i}`);
    const input = (key, attrs = {}) => h('input', { value: x[key] ?? '', oninput: (e) => { x[key] = e.target.value || null; }, ...attrs });
    const labelled = (label, key, control) => h('label', { class: `field${unsure(key) ? ' unsure' : ''}` }, h('span', { class: 'label' }, label, check(key)), control);
    const sportOk = live.some((s) => s.id === x.sport);
    const eventRow = (e, i) => h('div', { class: `ev-draft${problem(i) ? ' bad' : ''}${unsure(`events.${i}`) || unsure(`events[${i}]`) ? ' unsure' : ''}` },
      h('select', { 'aria-label': 'Type', value: e.discipline, onchange: (ev) => { e.discipline = ev.target.value; } }, EV_DISCIPLINES.map(([v, l]) => h('option', { value: v }, l))),
      h('select', { 'aria-label': 'For', value: e.gender, onchange: (ev) => { e.gender = ev.target.value; } }, EV_GENDERS.map(([v, l]) => h('option', { value: v }, l))),
      h('input', { 'aria-label': 'Age group', placeholder: 'Open', value: e.age || '', oninput: (ev) => { e.age = ev.target.value || null; } }),
      h('input', { 'aria-label': 'Level', placeholder: 'Open', value: e.level || '', oninput: (ev) => { e.level = ev.target.value || null; } }),
      h('input', { 'aria-label': 'Entry fee in rupees', type: 'number', min: 0, step: 1, placeholder: '₹ fee', value: e.feeRupees ?? '', oninput: (ev) => { e.feeRupees = ev.target.value === '' ? null : Number(ev.target.value); } }),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove this event', onclick: () => { x.events.splice(i, 1); d.problems = (d.problems || []).filter((p) => !p.field.startsWith('events.')); render(); } }, '✕'),
      problem(i) ? h('small', { class: 'ev-problem' }, problem(i).message) : null);
    const details = [x.prizes ? `Prizes: ${x.prizes}` : null, (x.contacts || []).length ? `Contact: ${x.contacts.map((c) => [c.name, c.phone].filter(Boolean).join(' ')).join(', ')}` : null, x.otherDetails].filter(Boolean).join('\n\n');
    const form = h('form', {
      class: 'card new-flow form quick-new draft-review',
      onsubmit: async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const { id } = await api('POST', '/tournaments/from-draft', { ...x, prizes: null, contacts: [], otherDetails: form.details.value });
          S.newDraft = null;
          toast('Tournament created from your poster — check the details below');
          navigate(`/t/${id}`);
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      },
    },
    h('div', { class: 'new-head' }, h('button', { type: 'button', class: 'back-link', onclick: () => { d.draft = null; d.problems = null; render(); } }, '← Start again'), h('span')),
    h('h1', {}, 'Check your tournament'),
    h('p', { class: 'muted small' }, 'Filled in from what you gave us. Anything marked "Check this" was a guess. Nothing is saved until you press Create.'),
    (d.problems || []).filter((p) => !p.field.startsWith('events.')).map((p) => h('p', { class: 'banner info small' }, p.message)),
    labelled('Tournament name', 'name', input('name', { name: 'name', required: true, maxlength: 80 })),
    labelled('Sport', 'sport', h('select', { name: 'sport', required: true, value: sportOk ? x.sport : '', onchange: (e) => { x.sport = e.target.value; } },
      h('option', { value: '' }, 'Pick the sport'), live.map((sp) => h('option', { value: sp.id }, sp.name)))),
    h('div', { class: 'grid-2' },
      labelled('Date', 'startsOn', input('startsOn', { type: 'date' })),
      labelled('Start time', 'startTime', input('startTime', { type: 'time' }))),
    h('div', { class: 'grid-2' },
      labelled('Venue', 'venue', input('venue', { maxlength: 80 })),
      labelled('City', 'city', input('city', { maxlength: 60 }))),
    labelled('Entries close', 'entriesCloseAt', input('entriesCloseAt', { type: 'datetime-local' })),
    groupField('Format', choiceGroup({ name: 'format', label: 'Format', value: x.format || 'league_knockout', options: FORMATS.map(([value, label]) => ({ value, label })), onchange: (e) => { x.format = e.target.value; } })),
    h('div', { class: `field${unsure('events') ? ' unsure' : ''}` }, h('span', { class: 'label' }, `Events (${x.events.length})`, check('events')),
      h('div', { class: 'ev-drafts' }, x.events.map(eventRow)),
      h('button', { class: 'link-btn', type: 'button', onclick: () => { x.events.push({ discipline: 'singles', gender: 'open', age: null, level: null, name: null, feeRupees: null, feePer: 'entry' }); render(); } }, '+ Add an event')),
    labelled('Other details (prizes, contacts, rules)', 'otherDetails', h('textarea', { name: 'details', rows: 4, maxlength: 2000 }, details)),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Create tournament')));
    return form;
  }

  // ---------- tournament page
  // Short names with icons: on phones they're a bar at the bottom of the screen.
  function tabsFor(t) {
    if (t.status === 'setup') return [{ id: 'entries', label: 'Entries', icon: 'tab-entries' }];
    return [
      { id: 'live', label: 'Live', icon: 'tab-live' },
      // Groups and the knockout bracket together.
      { id: 'draw', label: t.format === 'league' ? 'Groups' : t.format === 'knockout' ? 'Bracket' : 'Draw', icon: 'tab-draw' },
      { id: 'entries', label: 'Players', icon: 'tab-players' },
    ];
  }

  function tabsWithTeam(t) {
    const tabs = tabsFor(t);
    if (t.courts) tabs.push({ id: 'courts', label: CAT.courtWords(t.sport.id), icon: 'tab-courts' });
    if (hasPage(t)) tabs.push({ id: 'about', label: 'About', icon: 'tab-about' });
    // Every setting lives on one Setup tab (events, format, details & fees, prizes, page, team).
    if (t.can.manage) tabs.push({ id: 'setup', label: 'Setup', icon: 'tab-setup' });
    return tabs;
  }
  // Old addresses: /groups and /bracket are the two views of Draw.
  const DRAW_VIEWS = { groups: 'groups', bracket: 'knockout' };

  // The event you're looking at, and a button to switch (only with more than one).
  function eventPicker(t, current) {
    if (!multiEvent(t)) return null;
    const href = (ev) => `/t/${t.id}/${S.route.tab && !['events', 'team', 'courts', 'about'].includes(S.route.tab) ? S.route.tab : 'entries'}?e=${ev.id}${S.route.tab === 'setup' && S.route.section ? `&s=${S.route.section}` : ''}`;
    const count = (ev) => `${ev.entries.length} ${ev.discipline === 'team' ? (ev.entries.length === 1 ? 'team' : 'teams') : ev.entries.length === 1 ? 'entry' : 'entries'}`;
    const ev = current;
    return h('div', { class: 'event-picker' },
      h('button', {
        type: 'button', class: 'event-switch', 'aria-haspopup': 'dialog', 'aria-label': `Event: ${ev.name}. Switch event`,
        onclick: () => actionSheet('Switch event', t.events.map((x) => ({
          label: x.name, hint: `${STATUS[x.status]} · ${count(x)}`, current: x.id === ev.id, dot: x.status,
          onClick: () => navigate(href(x)),
        }))),
      },
      h('span', { class: `dot ${ev.status}`, 'aria-hidden': 'true' }),
      h('strong', { class: 'event-switch-name' }, ev.name),
      h('span', { class: 'event-switch-more' }, `${t.events.length} events ▾`)),
      h('p', { class: 'muted small event-line' }, [ev.formatName, count(ev), ev.fee ? `${money(ev.fee)} entry` : null, prizeMoney(ev) ? `🏆 ${rupees(prizeMoney(ev))} in prizes` : null, ev.status !== 'setup' ? STATUS[ev.status] : null].filter(Boolean).join(' · ')));
  }

  function viewTournament() {
    const tt = S.t;
    const ev = currentEvent(tt);
    const t = withEvent(tt, ev);
    document.title = `${tt.name} · Tonament`;
    const tabs = tabsWithTeam(t);
    // Old addresses (/team, /events) open the matching part of Setup.
    if ((S.route.tab === 'team' || S.route.tab === 'events') && t.can.manage) { S.route.section = S.route.tab; S.route.tab = 'setup'; }
    if (DRAW_VIEWS[S.route.tab]) { S.drawView = DRAW_VIEWS[S.route.tab]; S.route.tab = 'draw'; }
    const active = tabs.some((x) => x.id === S.route.tab) ? S.route.tab : tabs[0].id;
    const panels = { entries: panelEntries, live: panelLive, draw: panelDraw, setup: panelSetup, about: panelAbout, courts: () => panelCourts(tt) };
    const perEvent = active === 'setup' ? SETUP_PER_EVENT.includes(setupSection(t)) : !['about', 'courts'].includes(active);
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
          tt.visibility !== 'private' ? h('button', { class: 'btn btn-small btn-ghost t-share', onclick: () => shareTournament(tt) }, 'Share') : null,
          allEntries(tt).length ? h('button', { class: 'icon-btn t-search', type: 'button', 'aria-label': 'Find a player or match', title: 'Find a player or match', onclick: () => searchSheet(tt) }, icon('search')) : null),
        h('p', { class: 'muted small' },
          [fmtSchedule(tt), placeLine(tt.venue, tt.location.city), tt.sport.name, multiEvent(tt) ? `${tt.events.length} events` : t.formatName, statusLine]
            .filter(Boolean).join(' · '), '  ', connDot())),
      roleBar(t),
      finishedCard(tt),
      previousCard(tt),
      tt.visibility === 'private' && !(t.can.own && S.me && t.role && !t.can.claim) ? visibilityBanner(t) : null,
      perEvent ? eventPicker(tt, ev) : null,
      h('nav', { class: `tabs t-tabs${tabs.length > 1 ? ' bar' : ''}`, 'aria-label': 'Tournament' }, tabs.map((x) => h('a', {
        href: tabHref(t, x.id), class: x.id === active ? 'active' : '', 'aria-current': x.id === active ? 'page' : null,
      }, icon(x.icon), h('span', {}, x.label)))),
      h('section', {}, panels[active](t)),
      brandFooter(tt),
    ];
  }

  // Find a player in any event, with their matches (live, next, played).
  function searchSheet(tt) {
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const order = { live: 0, scheduled: 1, done: 2 };
    const results = h('div', { class: 'search-results' });
    const show = (q) => {
      q = q.trim().toLowerCase();
      const hits = q ? tt.events.flatMap((ev) => ev.entries.filter((e) => e.name.toLowerCase().includes(q)).map((e) => ({ ev, e }))).slice(0, 12) : [];
      results.replaceChildren(...(!q ? [h('p', { class: 'muted small' }, 'Type a name to see their matches.')]
        : !hits.length ? [h('p', { class: 'muted small' }, 'No one by that name.')]
          : hits.map(({ ev, e }) => {
            const ms = ev.matches.filter((m) => m.status !== 'bye' && [m.a && m.a.id, m.b && m.b.id].includes(e.id))
              .sort((x, y) => order[x.status] - order[y.status] || byOrder(x, y)).slice(0, 5);
            return h('section', { class: 'search-hit' },
              h('a', { class: 'search-name', href: `/t/${tt.id}/entries${multiEvent(tt) ? `?e=${ev.id}` : ''}`, onclick: close },
                h('strong', {}, e.name), h('small', { class: 'muted' }, [multiEvent(tt) ? ev.name : null, e.group != null && ev.format !== 'knockout' ? `Group ${String.fromCharCode(65 + e.group)}` : null, e.withdrawn ? 'Withdrew' : null].filter(Boolean).join(' · '))),
              ms.length ? h('ul', {}, ms.map((m) => h('li', {}, h('a', { href: `/t/${tt.id}/m/${m.id}`, onclick: close },
                h('span', {}, vsName(m), h('small', { class: 'muted' }, matchLabel(m))), statusTag(m))))) : null);
          })));
    };
    const input = h('input', { type: 'search', class: 'search-q', placeholder: 'Player or team name', 'aria-label': 'Find a player or match', oninput: (e) => show(e.target.value) });
    const box = h('div', { class: 'sheet-backdrop top', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Find a player', onclick: (e) => { if (e.target === box) close(); } },
      h('div', { class: 'sheet search-sheet' },
        h('div', { class: 'search-bar' }, icon('search'), input, h('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: close }, 'Close')),
        results));
    show('');
    document.body.append(box);
    document.addEventListener('keydown', onKey);
    input.focus();
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

  // Opens a settings panel (on the Setup tab) and scrolls to it (or to one of its sections).
  const PANEL_SECTION = { settings: 'details', 'add-events': 'events', page: 'page' };
  function openPanel(t, name, section) {
    S.openPanels.add(`${t.id}:${name}`);
    const where = PANEL_SECTION[name];
    if (where && (S.route.tab !== 'setup' || setupSection(t) !== where)) {
      navigate(`/t/${t.id}/setup?s=${where}${multiEvent(t) && t.eventId ? `&e=${t.eventId}` : ''}`);
      setTimeout(() => openPanel(t, name, section), 50);
      return;
    }
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
        h('h2', {}, done === required.length ? 'Ready to go ✓' : S.checklistAll ? 'Get your tournament ready' : 'Next step'),
        h('button', { class: 'btn btn-small btn-ghost', onclick: hide }, 'Hide')),
      h('p', { class: 'muted small checklist-count' }, `${done} of ${required.length} done`,
        h('span', { class: 'progress' }, h('span', { style: `width:${(done / required.length) * 100}%` }))),
      // Just the next thing to do (the rest on request), so the players stay in view.
      h('ul', {}, (S.checklistAll ? items : [items.find((x) => !x.done && !x.optional) || items.find((x) => !x.done)].filter(Boolean)).map((x) => h('li', { class: `check-row${x.done ? ' done' : ''}${x.optional ? ' optional' : ''}` },
        h('span', { class: 'tick', 'aria-label': x.done ? 'Done' : 'To do' }, x.done ? '✓' : ''),
        h('div', { class: 'check-text' },
          h('strong', {}, x.label, x.optional ? h('small', {}, ' (optional)') : null),
          h('span', { class: 'muted small' }, x.state)),
        x.publish
          ? h('span', { class: 'actions' },
            h('button', { class: 'btn btn-small btn-primary', onclick: () => setVisibility(t, 'public') }, 'Publish'),
            h('button', { class: 'btn btn-small btn-ghost', onclick: () => setVisibility(t, 'link') }, 'Link only'))
          : x.action ? h('button', { class: `btn btn-small${x.done ? ' btn-ghost' : ''}`, onclick: x.action[1] }, x.action[0]) : null))),
      h('button', { class: 'link-btn small checklist-more', type: 'button', onclick: () => { S.checklistAll = !S.checklistAll; render(); } },
        S.checklistAll ? 'Show just the next step' : `See all ${items.length} steps`));
  }

  // ---------- level pools (an Open event split by level)
  // The pools meet in the final (2 pools) or the semis (one per level).
  const playerLevels = (t) => CAT.entryLevels(t.sport.id);
  const poolsAllowed = (t) => !CAT.isTeamSport(t.sport.id) && t.event.discipline !== 'team' && (!t.event.level || t.event.level === 'Open');
  const poolsOn = (t) => poolsAllowed(t) && t.format === 'league_knockout' && Boolean(t.config.pools);
  // 'Beginner+' -> 'B+', 'Intermediate' -> 'I', '3.5' -> '3.5'.
  const levelShort = (l) => (/^[A-Z]/.test(l) ? l.replace(/[a-z\s]+/g, '') : l);
  // The pools in bracket order (the organiser's order, else lowest first).
  function poolList(t) {
    let pools;
    if (t.config.groupPools && t.config.groupPools.length) {
      pools = [...new Map(t.config.groupPools.map((p) => [p.key, p])).values()];
    } else {
      const levels = playerLevels(t);
      const defs = t.config.pools === 'two'
        ? [{ key: 'lower', levels: levels.slice(0, Math.max(1, Math.floor(levels.length / 2))) }, { key: 'upper', levels: levels.slice(Math.max(1, Math.floor(levels.length / 2))) }]
        : levels.map((l) => ({ key: l, levels: [l] }));
      pools = defs.map((d) => ({ key: d.key, label: d.levels.join(' & '), n: t.entries.filter((e) => d.levels.includes(e.level)).length })).filter((d) => d.n);
    }
    const order = t.config.poolOrder || [];
    const rank = (k) => { const i = order.indexOf(k); return i < 0 ? 100 : i; };
    // nat: the natural order (lowest level first), the base for swapping pairings.
    return pools.map((p, i) => ({ p: { ...p, nat: i }, i })).sort((x, y) => rank(x.p.key) - rank(y.p.key) || x.i - y.i).map((x) => x.p);
  }
  // "Semis: Beginner v Beginner+ · Intermediate v Advanced" (who meets whom first).
  function poolMeetings(pools) {
    if (pools.length < 2) return null;
    if (pools.length === 2) return `${pools[0].label} v ${pools[1].label} in the final`;
    const pairs = [];
    for (let i = 0; i < 4 && i < pools.length; i += 2) pairs.push(pools[i + 1] ? `${pools[i].label} v ${pools[i + 1].label}` : `${pools[i].label} straight to the final`);
    return pools.length <= 4 ? `Semis: ${pairs.join(' · ')}` : `${pools.length} pools — neighbours meet first`;
  }
  // The other semi pairings: 4 pools have 3; with 3, who goes straight through rotates.
  function nextPoolOrder(pools) {
    const k = pools.map((p) => p.key);
    const [a, b, c, d] = [...pools].sort((x, y) => x.nat - y.nat).map((p) => p.key);
    // Same pairings in either half count as the same option.
    const same = (o) => [o.slice(0, 2), o.slice(2)].map((x) => [...x].sort().join()).sort().join('|');
    const options = k.length === 4 ? [[a, b, c, d], [a, c, b, d], [a, d, b, c]] : k.length === 3 ? [[a, b, c], [a, c, b], [b, c, a]] : null;
    if (!options) return null;
    const at = options.findIndex((o) => (k.length === 4 ? same(o) === same(k) : o.join() === k.join()));
    return options[(at + 1) % options.length];
  }
  function levelPoolsCard(t) {
    if (!t.can.manage || !poolsAllowed(t) || !['setup', 'league'].includes(t.status)) return null;
    if (t.status === 'league' && !poolsOn(t)) return null;
    const mode = poolsOn(t) ? t.config.pools : '';
    const save = (body, msg) => act(async () => { S.t = await api('PATCH', `${tPath(t)}/events/${t.eventId}`, body, t.id); }, msg);
    const levels = playerLevels(t);
    const counts = levels.map((l) => [l, t.entries.filter((e) => e.level === l).length]).filter(([, n]) => n);
    const none = t.entries.filter((e) => !e.level).length;
    const pools = mode ? poolList(t) : [];
    const swap = mode && t.status !== 'knockout' ? nextPoolOrder(pools) : null;
    return h('div', { class: 'card pools-card' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Split by level'), mode ? pill('org', mode === 'two' ? '2 pools' : 'By level') : null),
      t.status === 'setup' ? [
        h('p', { class: 'muted small', style: 'margin-top:0' }, 'Open event with mixed levels? Each level plays its own league groups, and the pools only meet at the end — like you would do it on paper.'),
        choiceGroup({
          name: 'pools', label: 'Split by level', value: mode,
          options: [
            { value: '', label: 'Off', hint: 'One draw for everyone' },
            { value: 'two', label: '2 pools', hint: `${levels.slice(0, Math.max(1, Math.floor(levels.length / 2))).join(', ')} | the rest — meet in the final` },
            { value: 'levels', label: 'By level', hint: 'One pool per level — winners meet in the semis' },
          ],
          onchange: (e) => save({ pools: e.target.value || null, ...(e.target.value && t.format !== 'league_knockout' && { format: 'league_knockout' }) }, e.target.value ? 'Level pools on — set each player\'s level below' : 'Level pools off'),
        }),
      ] : null,
      mode ? h('p', { class: 'pool-counts small' },
        counts.map(([l, n]) => h('span', {}, h('b', {}, levelShort(l)), ` ${l} ${n}`)),
        none ? h('span', { class: 'none' }, `No level ${none}`) : null) : null,
      mode && pools.length > 1 ? h('div', { class: 'pool-meet' },
        h('span', {}, poolMeetings(pools)),
        swap ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => save({ poolOrder: swap }, 'Pairings swapped') }, 'Swap pairings') : null) : null,
      mode && t.status === 'setup' && none ? h('p', { class: 'hint', style: 'margin:6px 0 0' }, 'Tap a level next to each player in the list. Everyone needs one before you start.') : null,
      mode && t.status === 'league' ? h('p', { class: 'hint', style: 'margin:6px 0 0' }, 'Wrong level? Move them on the Draw tab until their group starts playing.') : null);
  }
  // One-tap level buttons on an entry (organisers, before the draw).
  function levelChips(t, e) {
    const set = (level) => act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/level`, { level }, t.id); });
    return h('span', { class: 'level-chips', role: 'group', 'aria-label': `${e.name}'s level` }, playerLevels(t).map((l) => h('button', {
      type: 'button', class: 'level-chip', title: l, 'aria-pressed': String(e.level === l), onclick: () => set(e.level === l ? null : l),
    }, levelShort(l))));
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
      !setup && e.awaySince && e.inDraw && !e.withdrawn ? pill('live', `Not here yet${awayFor(e.awaySince)}`) : null,
      e.level && !(editable && poolsOn(t)) ? h('span', { class: 'event-tag level-tag' }, e.level) : null,
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
        ? h('p', { class: 'muted small', style: 'margin:0 0 8px' }, `Entry fee ${money(t.event.fee)}${t.config.feePer === 'player' ? ' per player' : ''} · ${money(t.event.feeTotal || 0)} collected `,
          !t.official && t.status !== 'completed' ? h('button', { class: 'link-btn small', onclick: () => openPanel(t, 'settings', 'Entry fees') }, 'Change') : null)
        : t.can.manage && !t.official && t.status !== 'completed'
          ? h('p', { class: 'muted small', style: 'margin:0 0 8px' }, 'Free to enter · ', h('button', { class: 'link-btn small', onclick: () => openPanel(t, 'settings', 'Entry fees') }, 'Set an entry fee'))
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
            e.players && !(e.people && e.people.length) ? h('small', { class: 'contact' }, `Players: ${e.players.join(', ')}`) : null,
            e.members && t.can.manage && e.members.some((m) => m.contact)
              ? h('small', { class: 'contact' }, e.members.map((m) => `${m.name}: ${m.contact}`).join(' · '))
              : null,
            h('span', { class: 'entry-tags' }, tags(e), groupLabel(e.group), e.rating != null ? pill('', `DUPR ${e.rating.toFixed(2)}`) : null),
            editable && poolsOn(t) ? levelChips(t, e) : null,
            entryPeople(t, e),
            running && t.can.manage && !e.inDraw && !e.withdrawn && e.confirmed && !e.solo
            && (t.status === 'league' || t.format === 'knockout')
            ? arrivedPicker(t, e) : null,
            running && (t.can.score || t.can.manage) && e.inDraw && !e.withdrawn && e.awaySince
            ? h('span', { class: 'play-actions' }, h('button', { class: 'btn btn-small', onclick: () => setAway(t, e, false) }, 'Here ✓'))
            : null,
            editable && !e.confirmed && !['pending', 'due', 'sent'].includes(e.feeStatus)
              ? h('button', { class: 'btn btn-small btn-primary confirm-btn', onclick: () => confirmEntry(t, e) }, 'Confirm place')
              : null,
            t.event.fee && t.can.manage && !e.members ? feeActions(t, e) : null,
            memberFees(t, e)),
          moreButton(e.name, entryActions(t, e, i, { editable, running })))))
        : empty(editable ? `No entries yet. Add ${t.event.discipline === 'team' ? 'teams' : 'players or pairs'} above.` : 'No entries yet.'),
      editable && t.entries.length
        ? h('p', { class: 'hint', style: 'margin:8px 0 0' },
          'On the day, tick players as they arrive — once anyone is ticked, only ticked players go into the draw. List order is the seeding (1 = top seed).')
        : null);

    if (!t.can.manage) {
      return [
        venueCard(t),
        prizesCard(t, [t.event]),
        eventDetailsCard(t),
        setup && t.entriesOpen ? publicEntryCard(t) : null,
        myTeamCard(t),
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
    // Organisers: just the players and what to do with them. Settings are on the Setup tab.
    if (!setup) return [nudgesCard(t), assistantCard(t), paymentsToCheck(t), upgradeCard(t), teamEditCard(t), running ? lateEntryCard(t) : null, list, setupLink(t)];
    return [setupChecklist(t), nudgesCard(t), assistantCard(t), paymentsToCheck(t), upgradeCard(t), addEntriesForm(t, usingCheckIn), importCard(t), soloCard(t), teamEditCard(t), list, startCard(t), setupLink(t)];
  }

  // ---------- Google Form responses → entries: the CSV (or the published
  // sheet's link), the columns (mapped by Claude, saved, or by hand), a
  // preview with totals, merged duplicates and problems, then the import.
  const IMPORT_FIELDS = [['name', 'Name'], ['partner', 'Partner'], ['phone', 'Phone'], ['email', 'Email'], ['category', 'Events chosen'], ['category_flag', 'One event (yes/no)'],
    ['team', 'Team name'], ['paid', 'Paid?'], ['payment_ref', 'Payment ref / UTR'], ['level', 'Level'], ['gender', 'Gender'], ['age', 'Age'], ['club', 'Club'], ['timestamp', 'Timestamp'], ['ignore', 'Ignore']];
  const specOf = (ev) => ({ discipline: ev.discipline, gender: ev.gender, age: ev.age || 'Open', level: ev.level || 'Open' });
  function importCard(t) {
    const I = (S.imp && S.imp.t === t.id) ? S.imp : (S.imp = { t: t.id, open: false });
    const evById = new Map(t.events.map((e) => [e.id, e]));
    const preview = async (body) => {
      I.busy = true;
      render();
      try {
        const r = await api('POST', `${tPath(t)}/import/preview`, body, t.id);
        Object.assign(I, { r, source: body.csv ? { csv: body.csv } : { sheetUrl: body.sheetUrl }, skip: new Set(), create: new Set(r.missing.map((m) => m.key)) });
        if (r.mappedBy === 'ai') loadCredits(t.id);
      } catch (e) { if (!outOfCredits(e, t.id)) toast(e.message, true); }
      I.busy = false;
      render();
    };
    const head = h('summary', {}, h('strong', {}, 'Import from Google Form'), h('small', { class: 'muted' }, ' · the responses you\'ve already collected'));
    if (!I.r) {
      const link = h('input', { type: 'url', placeholder: 'https://docs.google.com/spreadsheets/…/pub?output=csv', 'aria-label': 'Published sheet link' });
      return h('details', { class: 'card import-card', open: I.open, ontoggle: (e) => { I.open = e.target.open; } }, head,
        h('p', { class: 'muted small' }, 'In your form: Responses › Link to Sheets. In the sheet: File › Download › CSV, and choose the file here. Or use File › Share › Publish to web (as CSV) and paste the link.'),
        I.busy ? [h('p', {}, 'Reading the responses…'), h('div', { class: 'progress' }, h('span', { class: 'indeterminate' }))] : [
          h('label', { class: 'btn btn-primary' }, 'Choose the CSV file', h('input', {
            type: 'file', accept: '.csv,text/csv', hidden: true,
            onchange: async (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 3 * 1024 * 1024) { toast('That file is over 3 MB', true); return; } preview({ csv: await f.text() }); },
          })),
          h('form', { class: 'ai-row', onsubmit: (e) => { e.preventDefault(); if (link.value.trim()) preview({ sheetUrl: link.value.trim() }); } }, link, h('button', { class: 'btn', type: 'submit' }, 'Read the sheet'))],
        h('p', { class: 'muted small' }, 'Nothing is added until you check the preview. Players aren\'t messaged.'),
        S.aiEnabled ? creditsLine(t.id, 'create') : null);
    }
    const r = I.r;
    const m = r.mapping;
    const by = { ai: 'Columns matched by Claude — check them', saved: 'Columns matched as last time', you: 'Your column choices', guess: 'Columns matched by their names — check them' }[r.mappedBy];
    const remap = () => preview({ ...I.source, mapping: m });
    const evOptions = (value, extra = []) => [h('option', { value: '' }, 'Not an event'), ...extra, ...t.events.map((e) => h('option', { value: String(e.id), selected: value === String(e.id) }, e.name))];
    const specKey = (sp) => (sp ? t.events.find((e) => e.discipline === sp.discipline && e.gender === sp.gender && (e.age || 'Open').toLowerCase() === String(sp.age || 'Open').toLowerCase() && (e.level || 'Open').toLowerCase() === String(sp.level || 'Open').toLowerCase()) : null);
    const columns = h('div', { class: 'import-cols' }, m.columns.map((c) => h('div', { class: 'import-col' },
      h('span', { class: 'import-head', title: c.header }, c.header),
      h('select', { 'aria-label': `What's in "${c.header}"`, value: c.field, onchange: (e) => { c.field = e.target.value; if (c.field !== 'category_flag') c.event = null; remap(); } }, IMPORT_FIELDS.map(([v, l]) => h('option', { value: v }, l))),
      c.field === 'category_flag' ? h('select', { 'aria-label': `Event for "${c.header}"`, onchange: (e) => { const ev = evById.get(Number(e.target.value)); c.event = ev ? specOf(ev) : null; remap(); } },
        evOptions(specKey(c.event) ? String(specKey(c.event).id) : '')) : null)));
    const valueOf = (a) => m.categoryValues.find((v) => v.value.toLowerCase() === a.toLowerCase());
    const answers = r.answers.length ? h('div', { class: 'import-cols' }, r.answers.map((a) => {
      const v = valueOf(a);
      const known = v && v.event ? specKey(v.event) : null;
      const isNew = v && v.event && !known;
      return h('div', { class: 'import-col' }, h('span', { class: 'import-head' }, `"${a}"`),
        h('select', { 'aria-label': `Event for "${a}"`, onchange: (e) => {
          const ev = evById.get(Number(e.target.value));
          const next = e.target.value === '__new' ? v.event : ev ? specOf(ev) : null;
          m.categoryValues = [...m.categoryValues.filter((x) => x.value.toLowerCase() !== a.toLowerCase()), { value: a, event: next }];
          remap();
        } }, evOptions(known ? String(known.id) : isNew ? '__new' : '', isNew ? [h('option', { value: '__new', selected: true }, `New event: ${r.missing.find((x) => x.spec && x.spec.discipline === v.event.discipline)?.name || 'as read'}`)] : [])));
    })) : null;
    const chosen = r.entries.filter((e) => !I.skip.has(e.key) && (e.eventId || I.create.has(e.missingKey)));
    const doImport = () => act(async () => {
      const res = await api('POST', `${tPath(t)}/import`, { entries: chosen, create: r.missing.filter((x) => I.create.has(x.key)).map((x) => ({ key: x.key, spec: x.spec })), mapping: m }, t.id);
      const { imported, ...view } = res;
      S.t = view;
      S.imp = null;
      toast(`${imported.added} entr${imported.added === 1 ? 'y' : 'ies'} imported${imported.events ? `, ${imported.events} event${imported.events === 1 ? '' : 's'} added` : ''}${imported.unconfirmed ? ` (${imported.unconfirmed} unconfirmed: over your plan's limit)` : ''}${imported.skipped.length ? `. Skipped: ${imported.skipped.join(', ')}` : ''}`);
    });
    return h('div', { class: 'card import-card' },
      h('div', { class: 'card-head' }, h('h2', {}, `Import ${r.responses} response${r.responses === 1 ? '' : 's'}`), h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick: () => { S.imp = null; render(); } }, 'Cancel')),
      I.busy ? h('div', { class: 'progress' }, h('span', { class: 'indeterminate' })) : null,
      h('details', { class: 'fold', open: r.mappedBy === 'guess' }, h('summary', {}, h('span', {}, h('strong', {}, 'Columns'), h('span', { class: 'muted' }, ` · ${by}`))), columns,
        answers ? [h('h3', {}, 'Answers → events'), answers] : null, (m.notes || []).map((n) => h('p', { class: 'muted small' }, n))),
      h('h3', {}, 'What will be added'),
      h('ul', { class: 'plain-list import-totals' }, r.totals.map((x) => {
        const miss = x.missingKey ? r.missing.find((y) => y.key === x.missingKey) : null;
        return h('li', {},
          miss ? h('label', { class: 'check-field' }, h('input', { type: 'checkbox', checked: I.create.has(miss.key), onchange: (e) => { if (e.target.checked) I.create.add(miss.key); else I.create.delete(miss.key); render(); } }),
            h('span', {}, h('strong', {}, x.event), h('small', {}, ' · a new event — tick to add it'))) : h('strong', {}, x.event),
          h('span', { class: 'muted small' }, ` ${x.entries} entr${x.entries === 1 ? 'y' : 'ies'}${x.solo ? ` · ${x.solo} need a partner` : ''}${x.unpaid ? ` · ${x.unpaid} unpaid` : ''}`));
      })),
      r.merged.length ? h('p', { class: 'muted small' }, `Merged ${r.merged.length} duplicate${r.merged.length === 1 ? '' : 's'} (the same people twice): ${r.merged.map((x) => `${x.name} (rows ${x.dropped} and ${x.kept})`).join(', ')}.`) : null,
      r.problems.length ? h('div', { class: 'banner info small' }, h('strong', {}, `${r.problems.length} to check`), h('ul', {}, r.problems.slice(0, 20).map((p) => h('li', {}, `Row ${p.row}: ${p.message}`)))) : null,
      h('details', { class: 'fold' }, h('summary', {}, h('span', {}, h('strong', {}, 'Entries'), h('span', { class: 'muted' }, ` · untick any to leave out`))),
        h('ul', { class: 'plain-list import-rows' }, r.entries.map((e) => h('li', {}, h('label', { class: 'check-field' },
          h('input', { type: 'checkbox', checked: !I.skip.has(e.key), onchange: (ev) => { if (ev.target.checked) I.skip.delete(e.key); else I.skip.add(e.key); render(); } }),
          h('span', {}, h('strong', {}, e.name), h('small', {}, [e.eventName, e.solo ? 'needs a partner' : null, e.paid ? 'paid' : null, e.phone].filter(Boolean).join(' · ')))))))),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', disabled: !chosen.length || I.busy, onclick: doImport }, `Import ${chosen.length} entr${chosen.length === 1 ? 'y' : 'ies'}`)));
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
        const level = (new FormData(e.target).get('level')) || null;
        act(async () => {
          S.t = await api('POST', `${tPath(t)}/entries`, withEv(t, { names, walkIn, level }), t.id);
          S.draft = '';
          try { sessionStorage.removeItem('tonament:tool-names'); } catch (e2) { /* fine */ }
        }, `Added ${names.length} ${names.length === 1 ? 'entry' : 'entries'}`);
      },
    },
    h('h2', {}, walkIn ? 'Add walk-ins' : t.event.discipline === 'team' ? 'Add teams' : 'Add players or pairs'),
    walkIn ? h('p', { class: 'muted small' }, 'Walk-ins are checked in automatically.') : null,
    ta,
    poolsOn(t) ? groupField('Level', choiceGroup({ name: 'level', label: 'Level', value: S.addLevel || '', options: [{ value: '', label: 'Not set' }, ...playerLevels(t).map((l) => ({ value: l, label: l }))], onchange: (ev) => { S.addLevel = ev.target.value; } }), null, 'For everyone in this batch — add each level in turn.') : null,
    h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add')));
  }

  // "Enter this tournament" for players (no account needed).
  // A captain's own team: who's on it (results go on each linked player's profile).
  function myTeamCard(t) {
    if (t.event.discipline !== 'team' || !S.me || t.can.manage) return null;
    const mine = (t.myEntries || []).find((e) => e.eventId === t.eventId && !e.withdrawn && e.feeStatus !== 'pending');
    if (!mine) return null;
    const e = t.entries.find((x) => x.id === mine.id);
    if (!e) return null;
    const editing = S.linking === e.id;
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', {}, `Your team · ${e.name}`),
        !editing && t.status !== 'completed' ? h('button', { class: 'btn btn-small', onclick: () => { S.linking = e.id; render(); } }, 'Edit team') : null),
      editing ? rosterEditor(t, e)
        : [h('p', { class: 'small', style: 'margin:0' }, (e.people || []).map((p) => `${p.name}${p.captain ? ' (C)' : ''}`).join(' · ') || 'No players listed yet.'),
          h('p', { class: 'hint', style: 'margin:6px 0 0' }, 'Add each player\'s email and the team\'s results go on their Tonament profile.')]);
  }

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
    const per = t.event.discipline === 'doubles' ? ' per pair' : team ? (t.config.feePer === 'player' ? ' per player' : ' per team') : '';
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
    poolsOn(t) ? field('Your level', h('select', { name: 'level' }, h('option', { value: '' }, 'Choose…'), playerLevels(t).map((l) => h('option', { value: l }, l))), null,
      'The organiser groups players by level, so you play people at your standard.') : null,
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

  // ---------- latecomers (server/latecomers.js): the published policy, and the fair options
  const LATE_DEFAULT = { lateUntil: 'groups', groupChoice: 'even', graceMinutes: 15, replaceNoShow: true };
  const latePolicy = (t) => ({ ...LATE_DEFAULT, ...((t.config && t.config.latePolicy) || {}) });
  function lateWords(p) {
    const join = { groups: 'Late entries and players who miss the draw can join during the group stage', half: 'Late entries and players who miss the draw can join a group until it is half played', never: 'No one can join after the draw is made' }[p.lateUntil];
    const where = p.lateUntil === 'never' ? '' : p.groupChoice === 'even' ? ' — into the group with the fewest players, so groups stay even' : ' — into the group that has played the fewest matches, so there\'s time to catch up';
    return [`${join}${where}.`, `A player more than ${p.graceMinutes} minutes late for a called match can be given a walkover.`,
      ...(p.replaceNoShow ? ['If someone doesn\'t turn up, a walk-in can take their place before their first match.'] : [])];
  }
  // Fetches the options and shows them; pick(option) applies the chosen one.
  async function lateOptionsSheet(t, title, query, pick) {
    let r;
    try { r = await api('GET', `${tPath(t)}/late-options?${new URLSearchParams(query)}`, undefined, t.id); } catch (e) { toast(e.message, true); return; }
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const effects = (o) => [
      o.matchesAdded ? `+${o.matchesAdded} match${o.matchesAdded === 1 ? '' : 'es'}` : null,
      o.extraMinutes ? `about ${o.extraMinutes} min more play` : null,
      o.sizeAfter ? `group of ${o.sizeAfter}` : null,
      o.total ? `${o.played} of ${o.total} played` : null,
    ].filter(Boolean).join(' · ');
    const box = h('div', { class: 'sheet-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e) => { if (e.target === box) close(); } },
      h('div', { class: 'sheet action-sheet late-sheet' },
        h('h2', {}, title),
        r.options.length ? h('div', { class: 'sheet-actions' }, r.options.map((o) => h('button', {
          type: 'button', class: `sheet-action late-option${o.recommended ? ' recommended' : ''}`, disabled: !o.allowed,
          onclick: () => { close(); pick(o); },
        },
        h('span', {}, o.label, o.recommended ? [' ', pill('org', 'Recommended')] : null),
        effects(o) ? h('small', { class: 'muted' }, effects(o)) : null,
        o.why ? h('small', { class: o.allowed ? 'muted' : 'muted strike-why' }, o.why) : null,
        (o.notes || []).length ? h('small', { class: 'muted' }, `Note: ${o.notes.join('; ')}`) : null))) : null,
        !r.allowed && r.rule ? h('p', { class: 'banner info small' }, r.rule) : null,
        h('details', { class: 'fold' }, h('summary', {}, h('span', {}, h('strong', {}, 'Your late-arrival policy'))), r.says.map((x) => h('p', { class: 'muted small' }, x)),
          h('p', { class: 'muted small' }, 'Options are worked out from group sizes, matches played and time only — never who the players are. Change the policy in Setup › Late arrivals.')),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancel')));
    document.body.append(box);
    document.addEventListener('keydown', onKey);
  }

  // Has this entry started or finished a match (byes don't count)?
  const hasPlayed = (t, eid) => t.matches.some((m) => (m.a?.id === eid || m.b?.id === eid) && m.status !== 'bye' && (m.status === 'done' || m.rallies));
  // A walk-in takes a no-show's place (before the no-show has played).
  const replaceNoShow = (t, e) => {
    const name = prompt(`Who plays instead of ${e.name}? They take ${e.name}'s place and matches.`);
    if (!name || !name.trim()) return;
    act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/replace`, { name: name.trim() }, t.id); S.nudges = null; }, `${name.trim()} plays instead of ${e.name}`);
  };

  // "Needs a decision": what the late-arrival policy says is due now (no AI).
  function nudgesCard(t) {
    if (!t.can.manage || t.status === 'completed') return null;
    const n = S.nudges && S.nudges.t === t.id ? S.nudges : null;
    if (!n || Date.now() - n.at > 30000) {
      if (!n || !n.loading) {
        S.nudges = { t: t.id, at: Date.now(), loading: true, items: n ? n.items : [] };
        api('GET', `${tPath(t)}/nudges`, undefined, t.id).then((r) => { S.nudges = { t: t.id, at: Date.now(), items: r.items }; render(); }).catch(() => { S.nudges = { t: t.id, at: Date.now(), items: [] }; });
      }
    }
    const items = (n && n.items) || [];
    const notes = S.aiEnabled ? [] : umpireNotes(t); // with AI on, they're in the assistant card
    if (!items.length && !notes.length) return null;
    const done = () => { S.nudges = null; };
    const run = (x, a) => {
      if (a.action === 'walkover') act(async () => { S.t = await api('POST', `${tPath(t)}/matches/${a.matchId}/walkover`, { winner: a.winner }, t.id); done(); }, a.label);
      else if (a.action === 'replace') replaceNoShow(t, { id: x.entryId, name: x.name });
      else if (a.action === 'wait') { S.nudges.items = S.nudges.items.filter((y) => y !== x); S.nudges.at = Date.now() + 5 * 60000; render(); }
      else if (a.action === 'pair') act(async () => { S.t = await api('POST', `${tPath(t)}/pairs`, { a: a.a, b: a.b }, t.id); done(); }, 'Paired');
      else if (a.action === 'players') navigate(`/t/${t.id}/entries`);
    };
    return h('div', { class: 'card nudges' },
      h('h2', {}, 'Needs a decision'),
      h('ul', { class: 'plain-list' }, notes.map((x) => h('li', { class: 'nudge' },
        h('strong', {}, `“${x.text}”`), h('small', { class: 'muted' }, `From ${x.by}`),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick: () => closeNote(t, x) }, 'Done')))),
      items.map((x) => h('li', { class: 'nudge' },
        h('strong', {}, x.text), x.why ? h('small', { class: 'muted' }, x.why) : null,
        h('div', { class: 'actions' }, x.actions.map((a, i) => h('button', { class: `btn btn-small${i === 0 && a.action !== 'wait' ? ' btn-primary' : a.action === 'wait' ? ' btn-ghost' : ''}`, type: 'button', onclick: () => run(x, a) }, a.label)))))));
  }

  // Notes from umpires, for the organisers (refreshed every 30 seconds).
  function umpireNotes(t) {
    const n = S.assistNotes;
    if (!n || n.t !== t.id || (Date.now() - n.at > 30000 && !n.loading)) {
      S.assistNotes = { t: t.id, at: Date.now(), loading: true, items: (n && n.t === t.id && n.items) || [] };
      api('GET', `${tPath(t)}/notes`, undefined, t.id).then((r) => { S.assistNotes = { t: t.id, at: Date.now(), items: r.items }; render(); }).catch(() => { S.assistNotes = { t: t.id, at: Date.now(), items: [] }; });
    }
    return S.assistNotes.items;
  }
  const closeNote = (t, x) => { api('POST', `${tPath(t)}/notes/${x.id}/done`, {}, t.id).catch(() => {}); S.assistNotes.items = S.assistNotes.items.filter((y) => y !== x); render(); };

  // Umpires: a quick note to the organisers ("Court 2: Sanjay isn't here").
  function umpireNoteCard(t) {
    if (!t.can.score || t.can.manage || t.status === 'setup' || t.status === 'completed') return null;
    const input = h('input', { name: 'note', maxlength: 300, placeholder: 'e.g. Court 2: Sanjay isn\'t here', 'aria-label': 'Note for the organisers', autocomplete: 'off' });
    return h('form', { class: 'card umpire-note', onsubmit: (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      act(async () => { await api('POST', `${tPath(t)}/notes`, { text: input.value.trim() }, t.id); input.value = ''; }, 'Sent to the organisers');
    } },
    h('h2', {}, 'Tell the organiser'),
    h('div', { class: 'team-form' }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send')));
  }

  // The on-the-day assistant (server/assistant.js): the organiser says what's
  // happening; suggestions come back to tick and approve. Nothing changes
  // until Apply, and where latecomers go follows the late-arrival policy.
  // Undoes the last Apply. From the toast's Undo (quiet), a partial undo
  // throws, so the toast shows what couldn't be undone.
  async function undoLast(t, quiet = false) {
    const last = S.assistLast;
    if (!last) return;
    let message = 'Undone ✓';
    let error = false;
    try {
      const r = await api('POST', `${tPath(t)}/assistant/undo`, { batch: last.batch }, t.id);
      S.t = r.tournament;
      S.assistLast = null;
      S.nudges = null;
      const bad = r.results.filter((x) => !x.ok);
      if (bad.length) { message = `Undone, except: ${bad.map((x) => x.result).join('; ')}`; error = true; }
    } catch (e) { message = e.message; error = true; }
    if (quiet) { if (error) throw new Error(message); return; }
    toast(message, error);
    render();
  }
  function assistantCard(t) {
    if (!S.aiEnabled || !t.can.manage || t.status === 'completed') return null;
    const d = (S.assist && S.assist.t === t.id) ? S.assist : (S.assist = { t: t.id, text: '', busy: false, result: null, off: new Set() });
    const ask = async (body) => {
      d.busy = true;
      render();
      try {
        d.result = await api('POST', `${tPath(t)}/assistant`, body, t.id);
        d.off = new Set(d.result.proposals.filter((x) => !x.allowed).map((x) => x.key));
        loadCredits(t.id);
      } catch (e) {
        if (!outOfCredits(e, t.id)) toast(e.message, true);
      }
      d.busy = false;
      render();
    };
    const photo = async (file) => {
      if (!file) return;
      try { await ask({ text: d.text, image: await prepareImage(file, 'photo') }); } catch (e) { toast(e.message, true); }
    };
    const apply = async () => {
      const chosen = d.result.proposals.filter((x) => x.allowed && !d.off.has(x.key));
      if (!chosen.length) return;
      d.busy = true;
      render();
      try {
        const r = await api('POST', `${tPath(t)}/assistant/apply`, { version: d.result.version, request: d.result.request, proposals: chosen }, t.id);
        S.t = r.tournament;
        const bad = r.results.filter((x) => !x.ok);
        S.assistLast = r.batch ? { t: t.id, batch: r.batch, until: Date.now() + r.undoMinutes * 60000 } : null;
        toast(bad.length ? `${r.results.length - bad.length} done · ${bad.length} couldn't be: ${bad.map((x) => x.result).join('; ')}` : `Done ✓ ${r.results.map((x) => x.result).join(' · ')}`, bad.length > 0, r.batch ? () => undoLast(t, true) : null);
        S.assist = null;
        S.nudges = null;
      } catch (e) {
        toast(e.message, true);
        if (e.code === 'stale') d.result = null;
        d.busy = false;
      }
      render();
    };
    const last = S.assistLast && S.assistLast.t === t.id && Date.now() < S.assistLast.until ? S.assistLast : null;
    const notes = umpireNotes(t);
    const head = [h('h2', {}, 'Tell the assistant'), creditsLine(t.id, 'manage'),
      notes.length && !d.result ? h('div', { class: 'umpire-notes' }, h('strong', { class: 'small' }, `From umpires (${notes.length})`),
        h('ul', { class: 'plain-list' }, notes.map((x) => h('li', {}, h('span', {}, `“${x.text}”`, h('small', { class: 'muted' }, ` — ${x.by}`)),
          h('span', { class: 'actions' },
            h('button', { class: 'btn btn-small', type: 'button', onclick: () => { d.text = [d.text, x.text].filter(Boolean).join('\n'); closeNote(t, x); } }, 'Ask the assistant'),
            h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick: () => closeNote(t, x) }, 'Done')))))) : null,
      last && !d.result ? h('p', { class: 'muted small' }, 'Last change applied · ', h('button', { class: 'link-btn', type: 'button', onclick: () => undoLast(t) }, 'Undo')) : null];
    if (d.busy) {
      return h('div', { class: 'card assistant reading' }, ...head, h('p', { class: 'muted small' }, d.result ? 'Making the changes…' : 'Working out what to do…'),
        h('div', { class: 'progress' }, h('span', { class: 'indeterminate' })));
    }
    if (d.result) {
      const r = d.result;
      const ticked = r.proposals.filter((x) => x.allowed && !d.off.has(x.key)).length;
      return h('div', { class: 'card assistant' }, ...head,
        r.summary ? h('p', { class: 'small' }, r.summary) : null,
        r.questions.length ? h('div', { class: 'banner info small assistant-questions' }, r.questions.map((q) => h('p', {}, q))) : null,
        r.proposals.length ? h('ul', { class: 'plain-list proposals' }, r.proposals.map((x) => h('li', { class: `proposal${x.allowed ? '' : ' blocked'}` },
          h('label', { class: 'check-field' },
            h('input', { type: 'checkbox', checked: x.allowed && !d.off.has(x.key), disabled: !x.allowed, onchange: (e) => { if (e.target.checked) d.off.delete(x.key); else d.off.add(x.key); render(); } }),
            h('span', {}, h('strong', {}, x.label || x.name || 'Not possible'),
              x.effect ? h('small', { class: 'muted' }, x.effect) : null,
              x.why ? h('small', { class: 'muted' }, x.allowed ? x.why : `Can't: ${x.why}`) : null,
              x.quote ? h('small', { class: 'muted quote' }, `“${x.quote}”`) : null))))) : h('p', { class: 'muted small' }, 'Nothing to change.'),
        h('p', { class: 'muted small' }, 'Where latecomers go and when a walkover is due follow your late-arrival policy — not the AI.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-primary', type: 'button', disabled: !ticked, onclick: apply }, ticked ? `Apply ${ticked}` : 'Apply'),
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { d.result = null; render(); } }, 'Discard')));
    }
    const text = h('textarea', { rows: 2, maxlength: 2000, placeholder: 'e.g. Ravi and Kiran are here. New pair Asha / Eva for women\'s doubles, paid cash. Sanjay is running late.', 'aria-label': 'What\'s happening', oninput: (e) => { d.text = e.target.value; } }, d.text);
    return h('div', { class: 'card assistant' }, ...head,
      h('p', { class: 'muted small' }, 'Arrivals, walk-ins, late players, payments — say it like you\'d tell a helper, or snap the sign-up sheet. You approve every change.'),
      h('form', { class: 'ai-row stack', onsubmit: (e) => { e.preventDefault(); if (d.text.trim()) ask({ text: d.text }); } },
        text,
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-primary', type: 'submit' }, 'Suggest'),
          h('label', { class: 'btn ai-file' }, icon('camera'), h('span', {}, 'Photo'),
            h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: (e) => photo(e.target.files[0]) })))));
  }

  // Setup › Late arrivals: the policy, in plain words, shown to players.
  function latePolicyCard(t) {
    const p = latePolicy(t);
    const d = (S.lateDraft && S.lateDraft.t === t.id) ? S.lateDraft : (S.lateDraft = { t: t.id, ...p });
    const save = () => act(async () => { S.t = await api('PATCH', tPath(t), { latePolicy: { lateUntil: d.lateUntil, groupChoice: d.groupChoice, graceMinutes: Number(d.graceMinutes), replaceNoShow: Boolean(d.replaceNoShow) } }, t.id); S.lateDraft = null; }, 'Late-arrival policy saved');
    return h('div', { class: 'card' },
      h('h2', {}, 'Late arrivals'),
      h('p', { class: 'muted small' }, 'Decide now, before the day — it\'s shown to players on the tournament page, and the options you\'re offered on the day follow it.'),
      groupField('Who can join after the draw', choiceGroup({ name: 'lateUntil', label: 'Who can join after the draw', value: d.lateUntil, options: [
        { value: 'groups', label: 'During the group stage' }, { value: 'half', label: 'Until a group is half played' }, { value: 'never', label: 'No one' },
      ], onchange: (e) => { d.lateUntil = e.target.value; render(); } })),
      d.lateUntil !== 'never' ? groupField('Which group', choiceGroup({ name: 'groupChoice', label: 'Which group', value: d.groupChoice, options: [
        { value: 'even', label: 'Keep groups even' }, { value: 'progress', label: 'Most time to catch up' },
      ], onchange: (e) => { d.groupChoice = e.target.value; render(); } })) : null,
      field('Walkover after (minutes late)', h('input', { type: 'number', min: 5, max: 60, value: d.graceMinutes, oninput: (e) => { d.graceMinutes = e.target.value; } })),
      h('label', { class: 'check-field switch-field' },
        h('input', { type: 'checkbox', role: 'switch', checked: d.replaceNoShow, onchange: (e) => { d.replaceNoShow = e.target.checked; render(); } }),
        h('span', {}, h('strong', {}, 'A walk-in can take a no-show\'s place'), h('small', {}, 'Before the no-show has played: same group and matches, the walk-in\'s name.'))),
      h('div', { class: 'banner info small late-words' }, lateWords({ ...d, graceMinutes: Number(d.graceMinutes) || 15 }).map((x) => h('p', {}, x))),
      !t.config.lateEntry ? h('p', { class: 'hint' }, 'Late entries (new players after the draw) are also switched on or off on the Players tab once it starts; players who entered but missed the draw follow this policy.') : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: save }, 'Save')));
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
      ? poolsOn(t) ? 'Pick their group (or their level, for that pool\'s smallest group). They get catch-up matches against everyone in it.'
        : 'They join the smallest group (or the one you pick) and get catch-up matches against everyone in it.'
      : knockoutOnly ? 'They take a first-round bye and play the seed who had it.' : null;
    const input = h('input', { name: 'name', required: true, maxlength: 60, placeholder: 'Player or pair name', autocomplete: 'off' });
    const lv = groupsStage && poolsOn(t) ? h('select', { name: 'level', 'aria-label': 'Level' },
      h('option', { value: '' }, 'Level'), playerLevels(t).map((l) => h('option', { value: l }, l))) : null;
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, 'Late entries'),
        h('button', { class: 'btn btn-small btn-ghost', onclick: () => setLate(false) }, 'Switch off')),
      how
        ? h('form', {
          class: 'team-form',
          onsubmit: (e) => {
            e.preventDefault();
            const name = input.value.trim();
            if (!name) return;
            const level = lv && lv.value ? { level: lv.value } : {};
            // The fair options under the policy; the organiser picks one.
            lateOptionsSheet(t, `Where should ${name} go?`, { kind: 'late', event: t.eventId, ...level }, (o) => act(async () => {
              S.t = await api('POST', `${tPath(t)}/late-entry`, withEv(t, { name, ...level, ...(o.action === 'group' && { group: o.group }) }), t.id);
              input.value = '';
            }, `${name} added${o.label ? ` — ${o.label}` : ''}`));
          },
        }, input, lv, h('button', { class: 'btn btn-primary', type: 'submit' }, 'See options'))
        : null,
      h('p', { class: 'muted small', style: 'margin:8px 0 0' },
        how || 'The knockout has started — late entries could only join during the group stage.'),
      how ? h('p', { class: 'hint', style: 'margin:6px 0 0' }, 'Entered already but missed the draw? Tap Arrived next to their name in the list below.') : null);
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
  // Not here yet / back: their matches wait in the order of play meanwhile.
  function setAway(t, e, away) {
    const set = (on) => async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/away`, { away: on }, t.id); };
    act(set(away), away ? `${e.name}: not here yet — their matches wait` : `${e.name} is here ✓`, set(!away));
  }
  // A substitute partner (or a corrected name) after the draw.
  function renameEntry(t, e) {
    const name = prompt(`New name for ${e.name}. Results stay with the ${t.event.discipline === 'doubles' ? 'pair' : 'entry'} — use this when a partner is replaced.`, e.name);
    if (!name || name.trim() === e.name) return;
    act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/rename`, { name: name.trim() }, t.id); }, `Now ${name.trim()}`);
  }
  // Entered, but missed the draw: into a group with catch-up matches (or a bye).
  function arrivedPicker(t, e) {
    // The fair options under the late-arrival policy, then the organiser's pick.
    return h('button', { class: 'btn btn-small btn-primary', onclick: () => lateOptionsSheet(t, `${e.name} has arrived`, { kind: 'arrive', entry: e.id }, (o) => act(async () => {
      S.t = await api('POST', `${tPath(t)}/entries/${e.id}/arrive`, o.action === 'group' ? { group: o.group } : {}, t.id);
    }, t.status === 'league' ? `${e.name} is in ${o.label} — catch-up matches are in the order of play` : `${e.name} added to the draw`)) }, 'Arrived');
  }
  function withdrawEntry(t, e) {
    if (!confirm(`Withdraw ${e.name}? Their remaining matches become walkovers. This can't be undone.`)) return;
    act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/withdraw`, {}, t.id); }, `${e.name} withdrawn`);
  }

  // undoable: offer Undo (back to the order before).
  function saveOrder(t, ids, msg, undoable) {
    const put = (list) => api('PUT', `${tPath(t)}/entries/order`, withEv(t, { ids: [...list, ...(t.solos || []).map((e) => e.id)] }), t.id); // solo players keep their places after the pairs
    const before = t.entries.map((e) => e.id);
    act(async () => { S.t = await put(ids); }, msg, undoable ? async () => { S.t = await put(before); } : null);
  }
  function move(t, i, dir) {
    const ids = t.entries.map((e) => e.id);
    const name = t.entries[i].name;
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    saveOrder(t, ids, `${name} is now seed ${i + dir + 1}`, true);
  }
  function shuffle(t) {
    const ids = t.entries.map((e) => e.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    saveOrder(t, ids, 'Order shuffled', true);
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
  // Everything else you can do to an entry, behind its ⋯ button.
  function entryActions(t, e, i, { editable, running }) {
    const team = t.event.discipline === 'team';
    const people = e.people || [];
    const linkable = t.can.manage && (team || (e.source !== 'drawn' && !e.solo));
    const playing = running && e.inDraw && !e.withdrawn;
    return [
      playing && (t.can.score || t.can.manage) && !e.awaySince
        ? { label: 'Not here', hint: 'Checked in but not at the court — their matches wait', onClick: () => setAway(t, e, true) } : null,
      linkable && S.linking !== e.id ? {
        label: team ? (people.length ? 'Edit team' : 'Add players') : people.some((p) => p.email) ? 'Edit players' : 'Link players',
        hint: team ? null : 'Their Tonament accounts, so results reach their profiles',
        onClick: () => {
          S.linking = e.id;
          render();
          if (team) setTimeout(() => { const c = document.querySelector('.roster-card'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
        },
      } : null,
      editable && i > 0 ? { label: 'Move up', hint: `Seed ${i}`, onClick: () => move(t, i, -1) } : null,
      editable && i < t.entries.length - 1 ? { label: 'Move down', hint: `Seed ${i + 2}`, onClick: () => move(t, i, 1) } : null,
      editable && e.source === 'drawn' ? { label: 'Split pair', hint: 'Both look for a partner again', onClick: () => splitPair(t, e) } : null,
      playing && t.can.manage ? { label: 'Rename', hint: 'A substitute partner, or a corrected name', onClick: () => renameEntry(t, e) } : null,
      playing && t.can.manage ? { label: 'Withdraw', hint: 'Remaining matches become walkovers', danger: true, onClick: () => withdrawEntry(t, e) } : null,
      editable ? { label: 'Remove', danger: true, onClick: () => removeEntry(t, e) } : null,
    ];
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
      if (['received', 'cash', 'waived'].includes(e.feeStatus) && t.status !== 'completed') {
        return h('span', { class: 'fee-actions' }, h('button', { class: 'btn btn-small btn-ghost', onclick: () => confirm(`Mark ${e.name} as unpaid?`) && set(null, `${e.name}: marked unpaid`) }, 'Undo'));
      }
      if (![null, undefined, 'due', 'sent'].includes(e.feeStatus) || t.status === 'completed') return null;
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
        saveForm(form, async () => {
          S.t = await api('PATCH', tPath(t), { ...readTournament(form), courts: readCourts(form, t.sport.id), payment: readPayment(form) }, t.id);
          // Each event's fee (from the Entry fees section), when changed.
          for (const ev of t.events) {
            const input = form.querySelector(`[name="fee-${ev.id}"]`);
            if (!input || input.disabled) continue;
            const fee = Math.round(Number(input.value || 0) * 100);
            const perSel = form.querySelector(`[name="feePer-${ev.id}"]`);
            const feePer = perSel ? perSel.value : undefined;
            if (fee === (ev.fee || 0) && (!perSel || feePer === ((ev.config && ev.config.feePer) || 'entry'))) continue;
            S.t = await api('PATCH', `${tPath(t)}/events/${ev.id}`, { fee, ...(perSel && { feePer }) }, t.id);
          }
        }, 'Tournament settings saved');
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
    const per = (ev) => (ev.discipline === 'doubles' ? 'per pair' : ev.discipline === 'team' ? (ev.config && ev.config.feePer === 'player' ? 'per player' : 'per team') : 'per player');
    return h('fieldset', { class: 'details-set' }, h('legend', {}, 'Entry fees'),
      h('p', { class: 'hint', style: 'margin:0' }, 'Set a fee for each event (leave empty for free). Players pay you directly — by UPI or cash — and you confirm each payment on the Players tab. Tonament never handles the money.'),
      h('div', { class: 'fee-rows' }, t.events.map((ev) => h('div', { class: 'fee-row' },
        h('label', { for: `fee-${ev.id}` }, h('strong', {}, ev.name), h('small', { class: 'muted' }, ` ₹ ${per(ev)}`)),
        h('input', { id: `fee-${ev.id}`, name: `fee-${ev.id}`, type: 'number', min: 0, max: 50000, step: 1, value: ev.fee ? ev.fee / 100 : '', placeholder: 'Free', disabled: ev.status === 'completed', inputmode: 'numeric' }),
        ev.discipline === 'team' ? h('select', { name: `feePer-${ev.id}`, 'aria-label': `${ev.name}: charge`, disabled: ev.status === 'completed' },
          h('option', { value: 'entry', selected: !(ev.config && ev.config.feePer === 'player') }, 'Per team'),
          h('option', { value: 'player', selected: Boolean(ev.config && ev.config.feePer === 'player') }, 'Per player')) : null))),
      t.events.some((ev) => ev.status !== 'setup' && ev.status !== 'completed') ? h('p', { class: 'hint', style: 'margin:0' }, 'Changing a fee during the event: anyone who hasn\'t paid yet owes the new amount; payments already made stay as they are.') : null,
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
    return h('fieldset', { class: 'details-set' }, h('legend', {}, CAT.courtWords(t.sport.id)),
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
          if (fd.get('feePer')) extra.feePer = fd.get('feePer');
          if (t.sport.id === 'pickleball') Object.assign(extra, { dupr: fd.get('dupr') || 'off', duprMin: fd.get('duprMin') || null, duprMax: fd.get('duprMax') || null });
          if (fd.get('tieFormat')) extra.tie = { format: fd.get('tieFormat'), playAll: Boolean(form.tiePlayAll && form.tiePlayAll.checked) };
          S.t = await api('PATCH', `${tPath(t)}/events/${t.eventId}`, { ...readCategory(form), ...readFormat(form, sport), ...fee, ...partners, ...extra }, t.id);
        }, 'Event settings saved');
      },
    },
    // Type, age group and level are set when the event is made: folded, so the format is in view.
    h('details', { class: 'fold', open: Boolean(S.eventFoldOpen), ontoggle: (e) => { S.eventFoldOpen = e.target.open; } },
      h('summary', {}, h('span', {}, h('strong', {}, 'Event'), h('span', { class: 'muted' }, ` · ${t.event.name}`)), h('span', { class: 'fold-change' }, 'Change')),
      categoryFields(t.event, t.sport.id)),
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
      field(`Entry fee (₹)${t.event.discipline === 'doubles' ? ' per pair' : t.event.discipline === 'team' ? (t.config.feePer === 'player' ? ' per player' : ' per team') : ''}`, h('input', {
        type: 'number', name: 'fee', min: 0, max: 50000, step: 1, value: t.event.fee ? t.event.fee / 100 : '', placeholder: 'Free',
      }), null, t.official
        ? 'Players pay online when they enter (Organised by Tonament).'
        : t.payment && t.payment.upi
          ? `Players pay you directly (UPI ${t.payment.upi}) and you confirm each payment.`
          : 'Players pay you directly and you confirm each payment. Add your UPI ID under Setup › Dates, venue & fees.'),
      t.event.discipline === 'team' && !t.official
        ? groupField('Charge', choiceGroup({ name: 'feePer', label: 'Charge', value: t.config.feePer || 'entry', options: [{ value: 'entry', label: 'Per team' }, { value: 'player', label: 'Per player' }] }), null,
          'Per player: each team pays the fee for every player on its list. Either way, you can mark who has paid, player by player.')
        : null),
    t.event.discipline === 'team' && CAT.hasTies(t.sport.id) && window.TonamentTie ? h('fieldset', { class: 'details-set' }, h('legend', {}, 'Team ties'),
      groupField('Each tie is', choiceGroup({
        name: 'tieFormat', label: 'Each tie is', value: (t.config.tie && t.config.tie.format) || '2s1d',
        options: Object.entries(TonamentTie.FORMATS).map(([value, f]) => ({ value, label: f.name, hint: f.hint })),
      })),
      h('label', { class: 'check-field' }, h('input', { type: 'checkbox', name: 'tiePlayAll', checked: Boolean(t.config.tie && t.config.tie.playAll) }),
        h('span', {}, h('strong', {}, 'Play every match'), h('small', {}, 'Off: a tie ends once a team has won most of its matches. On: all are played, and the table counts every one.')))) : null,
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
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
      t.events.some((e) => e.id !== t.eventId && e.status === 'setup')
        ? h('button', { class: 'btn', type: 'button', onclick: () => copySettingsSheet(t) }, 'Copy to other events…') : null));
    syncFormat(form);
    return panel(t, `event-${t.eventId}`, multiEvent(t) ? `Event settings · ${t.event.name}` : `Event settings · ${t.formatName}`, form);
  }

  // This event's (saved) settings onto other events: format, scoring,
  // limits, fee and prizes. Events of the same kind are ticked to start with.
  function copySettingsSheet(t) {
    const others = t.events.filter((e) => e.id !== t.eventId && e.status === 'setup');
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const boxes = others.map((e) => h('label', { class: 'check-field' },
      h('input', { type: 'checkbox', value: String(e.id), checked: e.discipline === t.event.discipline }),
      h('span', {}, h('strong', {}, e.name), h('small', {}, [e.formatName, e.fee ? `${money(e.fee)} entry` : null].filter(Boolean).join(' · ')))));
    const copy = () => {
      const to = boxes.map((b) => b.querySelector('input')).filter((x) => x.checked).map((x) => Number(x.value));
      if (!to.length) { toast('Tick at least one event', true); return; }
      close();
      act(async () => {
        const r = await api('POST', `${tPath(t)}/events/${t.eventId}/copy`, { to }, t.id);
        const { skipped, ...view } = r;
        S.t = view;
        const names = others.filter((e) => to.includes(e.id)).map((e) => e.name);
        toast(`Copied to ${names.length > 2 ? `${names.length} events` : names.join(' and ')}${skipped.length ? ` (left as they were: ${skipped.join(', ')})` : ''}`);
      });
    };
    const box = h('div', { class: 'sheet-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Copy settings', onclick: (e) => { if (e.target === box) close(); } },
      h('div', { class: 'sheet action-sheet copy-sheet' },
        h('h2', {}, `Copy ${t.event.name}'s settings`),
        h('p', { class: 'muted small' }, 'Format, groups and qualifiers, scoring, entry limits, the entry fee and prizes — as last saved. Each event can still be changed after.'),
        h('div', { class: 'copy-list' }, boxes),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: copy }, 'Copy'), h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancel'))));
    document.body.append(box);
    document.addEventListener('keydown', onKey);
    box.querySelector('input').focus();
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
  // ----- Setup tab: every setting in one place, one section at a time.
  const SETUP_SECTIONS = [
    ['format', 'Format & scoring'],
    ['details', 'Dates, venue & fees'],
    ['prizes', 'Prizes'],
    ['events', 'Events'],
    ['page', 'Public page'],
    ['late', 'Late arrivals'],
    ['team', 'Team & links'],
  ];
  const SETUP_PER_EVENT = ['format', 'prizes'];
  const setupSection = (t) => (SETUP_SECTIONS.some(([k]) => k === S.route.section) ? S.route.section : 'format');
  function panelSetup(t) {
    const section = setupSection(t);
    const href = (k) => `/t/${t.id}/setup?s=${k}${multiEvent(t) && t.eventId && SETUP_PER_EVENT.includes(k) ? `&e=${t.eventId}` : ''}`;
    // The section's panels open straight away (no extra tap on a collapsed card).
    const open = (...names) => names.forEach((n) => S.openPanels.add(`${t.id}:${n}`));
    let body;
    if (section === 'format') {
      open(`event-${t.eventId}`);
      body = [t.status === 'setup' ? eventSettingsCard(t) : eventDetailsCard(t), levelPoolsCard(t), rankedCard(t)];
    } else if (section === 'details') {
      open('settings');
      body = [tournamentSettingsCard(t)];
    } else if (section === 'prizes') {
      open(`prizes-${t.eventId}`);
      body = [prizeSettingsCard(t)];
    } else if (section === 'events') {
      body = panelEvents(t);
    } else if (section === 'late') {
      body = [latePolicyCard(t)];
    } else if (section === 'page') {
      open('page');
      body = [pageCard(t)];
    } else {
      body = panelTeam(t);
    }
    return [
      h('nav', { class: 'setup-nav', 'aria-label': 'Setup' }, SETUP_SECTIONS.map(([k, label]) => h('a', {
        href: href(k), class: k === section ? 'active' : '', 'aria-current': k === section ? 'page' : null,
      }, label))),
      body,
    ];
  }
  // At the foot of the Players tab: where the settings went.
  function setupLink(t) {
    return h('p', { class: 'muted small center setup-link' }, 'Format, fees, prizes, venue and team are on the ', h('a', { href: `/t/${t.id}/setup${multiEvent(t) && t.eventId ? `?e=${t.eventId}` : ''}` }, 'Setup tab'), '.');
  }

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
        const like = addForm.querySelector('select[name=like]');
        saveForm(addForm, async () => { S.t = await api('POST', `${tPath(t)}/events`, { events, ...(like && { like: Number(like.value) }) }, t.id); },
          `${events.length} event${events.length > 1 ? 's' : ''} added`);
      },
    },
    eventBuilder([{ discipline: 'singles', gender: 'men', age: 'Open', level: 'Open' }], t.sport.id),
    t.events.length > 1
      ? field('Same settings as', h('select', { name: 'like' }, t.events.map((e) => h('option', { value: String(e.id) }, e.name))), null, 'Format, scoring and fee come from this event; change them in each event\'s settings.')
      : h('p', { class: 'hint', style: 'margin:0' }, 'New events copy the format and scoring of the first event; change them in each event\'s settings.'),
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
      reuseCard(t),
      aiCreditsCard(t),
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

  const displayLinkInline = (t) => h('a', { href: `/t/${t.id}/display`, target: '_blank', rel: 'noopener' }, '📺 Venue display');

  function panelLive(t) {
    const ms = t.matches.filter((m) => m.status !== 'bye');
    const live = ms.filter((m) => m.status === 'live').sort(byOrder);
    // Late entries' catch-up matches go first so they can catch up.
    const upcoming = ms.filter((m) => m.status === 'scheduled' && m.a && m.b)
      .sort((x, y) => Number(y.catchUp) - Number(x.catchUp) || byOrder(x, y)).slice(0, 8);
    const results = ms.filter((m) => m.status === 'done')
      .sort((x, y) => (y.updatedAt || '').localeCompare(x.updatedAt || '') || y.id - x.id).slice(0, 12);
    return [
      championBanner(t),
      t.can.manage ? nextStepCard(t) : stageBanner(t),
      nudgesCard(t),
      umpireNoteCard(t),
      t.status !== 'setup' ? assistantCard(t) : null,
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
    const pinTo = (m, top) => async () => { S.t = await api('POST', `${tPath(t)}/matches/${m.id}/queue`, { top }, t.id); };
    const pin = (m, top) => act(pinTo(m, top), top ? 'Moved to the front' : 'Back in the usual order', pinTo(m, !top));
    const offCourt = (m) => act(async () => { mergeMatch(await api('PATCH', `${tPath(t)}/matches/${m.id}`, { status: 'scheduled' }, t.id)); }, 'Taken off court',
      m.court ? async () => { S.t = await api('POST', `${tPath(t)}/matches/${m.id}/call`, { court: m.court }, t.id); } : null);
    const evOf = (m) => t.events.find((e) => e.matches.some((x) => x.id === m.id));
    // Entries in this queued match marked not here yet.
    const awayIn = (x) => (x.event.entries || []).filter((e) => e.awaySince && [x.match.a && x.match.a.id, x.match.b && x.match.b.id].includes(e.id));

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
          m.rallies ? pill('live', 'Playing') : pill('waiting', 'Called'),
          manage && !m.rallies ? moreButton(`${court.name}: ${vsName(m)}`, [
            ...['a', 'b'].map((sd) => m[sd] ? { label: `${nameOf(m[sd])} isn't here`, hint: 'The next ready match goes on instead; theirs waits', onClick: () => setAway(t, m[sd], true) } : null),
            { label: 'Take off court', hint: 'Back into the order of play', onClick: () => offCourt(m) },
          ]) : null),
        h('a', { class: 'court-match', href: `/t/${t.id}/m/${m.id}` },
          evName(ev) ? h('small', { class: 'muted' }, ev.name) : null,
          h('span', {}, vsName(m)),
          h('small', { class: 'muted' }, m.rallies ? m.summary || 'In progress' : `Called at ${clock(Date.parse(m.calledAt || Date.now()))}`)));
    };

    const queue = plan.queue.filter((x) => mine(x.match));
    return h('div', { class: 'court-results' },
      h('div', { class: 'court-grid' }, plan.courts.map(courtCard)),
      c.auto && manage ? h('p', { class: 'hint' }, 'Auto-call is on: when a match ends, the next match goes to that court.') : null,
      manage ? h('p', { class: 'hint' }, 'Player not at the court? Tap ⋯ on the court — the next ready match goes on instead, and theirs waits until they\'re back.') : null,
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
              ? h('span', { class: `oop-actions${awayIn(x).length ? ' wide' : ''}` },
                awayIn(x).map((e) => h('button', { class: 'btn btn-small', onclick: () => setAway(t, e, false) }, `${e.name} is here ✓`)),
                x.match.queuePos != null ? pill('done', 'Pinned') : null,
                moreButton(vsName(x.match), [
                  x.match.queuePos == null
                    ? { label: 'Play next', hint: 'Goes on the next free court', onClick: () => pin(x.match, true) }
                    : { label: 'Unpin', hint: 'Back in the usual order', onClick: () => pin(x.match, false) },
                  ...(t.can.manage ? awayIn(x).map((e) => {
                    const other = x.match.a && x.match.a.id === e.id ? x.match.b : x.match.a;
                    const walkover = () => act(async () => { S.t = await api('POST', `${tPath(t)}/matches/${x.match.id}/walkover`, { winner: other.id === x.match.a.id ? 'a' : 'b' }, t.id); }, `Walkover to ${other.name}`);
                    return {
                      label: `${e.name} is late — what now?`, hint: 'Wait, or a walkover, by your policy',
                      onClick: () => lateOptionsSheet(t, `${e.name} hasn't come`, { kind: 'noshow', match: x.match.id, entry: e.id }, (o) => {
                        if (o.action === 'walkover') walkover();
                      }),
                    };
                  }) : []),
                  ...(t.can.manage && latePolicy(t).replaceNoShow ? awayIn(x).filter((e) => !hasPlayed(t, e.id)).map((e) => ({
                    label: `Someone else plays instead of ${e.name}`, hint: 'A walk-in takes their place and matches', onClick: () => replaceNoShow(t, e),
                  })) : []),
                ]))
              : null)))
          : h('p', { class: 'muted' }, find ? 'No matches for that name.' : 'Nothing waiting to be played.'),
        plan.queue.length ? h('p', { class: 'hint', style: 'margin:8px 0 0' }, `Times are estimates, based on ${c.minutes}-minute matches.`) : null));
  }
  const vsName = (m) => `${nameOf(m.a)} v ${nameOf(m.b)}`;
  // "Hal, Ivy (Court 1); Cy (Court 2)"
  function waitingText(list) {
    const byCourt = new Map();
    for (const w of list.filter((x) => !x.away)) byCourt.set(w.court || '', [...(byCourt.get(w.court || '') || []), w.name]);
    const away = list.filter((x) => x.away);
    return [
      ...[...byCourt].map(([court, names]) => `${names.join(', ')}${court ? ` (${court})` : ''}`),
      ...(away.length ? [`${away.map((w) => w.name).join(', ')} (not here yet${awayFor(away[0].since)})`] : []),
    ].join('; ');
  }
  // ", 12 min" since they were marked not here.
  const awayFor = (since) => { const m = Math.floor((Date.now() - Date.parse(since)) / 60000); return since && m >= 1 ? `, ${m} min` : ''; };

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
        const evSport = window.TonamentSports[t.sport.id];
        const timedEv = Boolean(evSport && evSport.timed);
        const draws = timedEv ? evSport.draws : Boolean(ev.config && ev.config.leagueDraws);
        const showPts = draws || timedEv;
        const cols = ['#', 'Name', 'P', 'W', ...(draws ? ['D'] : []), 'L', ...(showPts ? ['Pts'] : [])];
        for (const g of ev.groups) {
          panels.push([`${named ? `${ev.name} · ` : ''}${g.name}`, h('table', { class: 'dc-table' },
            h('thead', {}, h('tr', {}, cols.map((c, i) => h('th', { class: i === 1 ? '' : 'num' }, c)))),
            h('tbody', {}, g.standings.map((r) => h('tr', {}, h('td', { class: 'num' }, r.rank), h('td', {}, r.name), h('td', { class: 'num' }, r.played), h('td', { class: 'num' }, r.won),
              draws ? h('td', { class: 'num' }, r.drawn) : null, h('td', { class: 'num' }, r.lost), showPts ? h('td', { class: 'num' }, h('strong', {}, r.leaguePoints)) : null))))]);
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
            h('h2', {}, plan ? CAT.courtWords(t.sport.id) : CAT.courtWord(t.sport.id) === 'Court' ? 'On court now' : 'Playing now'),
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

  // Organisers: the one thing to do now, as the day goes on — call the next
  // match, draw the knockout, move on to the next event — with the progress.
  function nextStepCard(t) {
    const ms = t.matches.filter((m) => m.status !== 'bye');
    const done = ms.filter((m) => m.status === 'done').length;
    const stage = t.status === 'league' ? 'League stage' : t.status === 'knockout' ? 'Knockout' : null;
    const others = t.events.filter((e) => e.id !== t.eventId && e.status !== 'completed');
    const otherEvent = others.find((e) => e.status === 'setup' && e.entries.length >= 2) || others[0];
    const goTo = (e) => h('a', { class: 'btn btn-small', href: `/t/${t.id}/${e.status === 'setup' ? 'entries' : 'live'}?e=${e.id}` }, e.status === 'setup' ? `Set up ${e.name}` : `Go to ${e.name}`);
    let title;
    let text = null;
    let action = null;
    const leagueDone = t.status === 'league' && t.format === 'league_knockout' && ms.filter((m) => m.stage === 'league').every((m) => m.status === 'done');
    if (t.status === 'completed') {
      if (!otherEvent) return null;
      title = `${t.event.name} is finished`;
      text = otherEvent.status === 'setup' ? `${otherEvent.name} hasn't started yet.` : `${otherEvent.name} is still playing.`;
      action = goTo(otherEvent);
    } else if (leagueDone) {
      title = 'Draw the knockout bracket';
      text = [`Every group match is played. The top ${t.config.qualifiers} from each group go through.`,
        poolsOn(t) && poolList(t).length > 1 ? ` Level pools: ${poolMeetings(poolList(t))}.` : ''].join('');
      action = h('button', {
        class: 'btn btn-primary',
        onclick: () => act(async () => {
          S.t = await api('POST', `${tPath(t)}/knockout`, withEv(t), t.id);
          S.drawView = 'knockout';
          navigate(tabHref(t, 'draw'));
        }, 'Knockout bracket drawn'),
      }, 'Draw knockout bracket');
    } else if (t.courts) {
      const plan = TonamentSchedule.orderOfPlay({ events: t.events, courts: t.courts.names, minutes: t.courts.minutes, now: Date.now() });
      const free = plan.courts.find((c) => !c.match && c.next);
      if (free) {
        title = `${free.name} is free`;
        text = `Next up: ${vsName(free.next.match)}${multiEvent(t) ? ` (${free.next.event.name})` : ''}.`;
        action = h('button', {
          class: 'btn btn-primary',
          onclick: () => act(async () => { S.t = await api('POST', `${tPath(t)}/matches/${free.next.match.id}/call`, { court: free.name }, t.id); }, `${vsName(free.next.match)} called to ${free.name}`),
        }, `Call to ${free.name}`);
      } else {
        const busy = plan.courts.filter((c) => c.match).length;
        title = busy ? `${busy} of ${plan.courts.length} ${CAT.courtWord(t.sport.id).toLowerCase()}${plan.courts.length === 1 ? '' : 's'} in use` : 'Nothing ready to call';
        text = plan.queue.length ? `Next up: ${vsName(plan.queue[0].match)}${plan.queue[0].waitingFor.length ? ` — waiting for ${waitingText(plan.queue[0].waitingFor)}` : ''}.` : 'Waiting for matches to finish.';
        action = h('a', { class: 'btn btn-small', href: `/t/${t.id}/courts` }, `Open ${CAT.courtWords(t.sport.id)}`);
      }
    } else {
      const live = ms.filter((m) => m.status === 'live');
      // Not a match waiting for someone marked late (Not here).
      const away = new Set(t.entries.filter((e) => e.awaySince).map((e) => e.id));
      const next = ms.filter((m) => m.status === 'scheduled' && m.a && m.b && !away.has(m.a.id) && !away.has(m.b.id)).sort((x, y) => Number(y.catchUp) - Number(x.catchUp) || byOrder(x, y))[0];
      title = next ? `Next match: ${vsName(next)}` : live.length ? `${live.length} match${live.length === 1 ? '' : 'es'} on now` : 'Waiting for the next round';
      text = next ? [matchLabel(next), live.length ? `${live.length} on now` : null].filter(Boolean).join(' · ') : null;
      action = next ? h('a', { class: 'btn btn-primary', href: `/t/${t.id}/m/${next.id}` }, 'Score it') : null;
    }
    const canRedraw = (t.status === 'league' || (t.status === 'knockout' && t.format === 'knockout')) && !ms.some((m) => m.rallies > 0 || m.walkover);
    return h('div', { class: 'card next-step' },
      h('p', { class: 'eyebrow' }, 'Next step'),
      h('h2', {}, title),
      text ? h('p', { class: 'muted small' }, text) : null,
      action ? h('div', { class: 'actions' }, action, t.status !== 'completed' && otherEvent && otherEvent.status === 'setup' ? goTo(otherEvent) : null) : null,
      stage ? h('p', { class: 'muted small next-progress' }, `${stage} · ${done} of ${ms.length} played`,
        h('span', { class: 'progress' }, h('span', { style: `width:${ms.length ? (done / ms.length) * 100 : 0}%` }))) : null,
      h('p', { class: 'next-links small' },
        displayLinkInline(t),
        canRedraw ? h('button', {
          class: 'link-btn small', type: 'button',
          onclick: () => {
            if (!confirm('Redo the draw? All fixtures are removed and you go back to the entry list to add players and start again.')) return;
            act(async () => { S.t = await api('POST', `${tPath(t)}/redraw`, withEv(t), t.id); navigate(tabHref(t, 'entries')); }, 'Draw undone — add players and start again');
          },
        }, 'More players arrived? Redraw') : null));
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
          `Top ${t.config.qualifiers} from each group go through to the knockout.`,
          poolsOn(t) && poolList(t).length > 1 ? h('span', { class: 'small', style: 'display:block;margin-top:4px' }, `Level pools: ${poolMeetings(poolList(t))}.`) : null),
        t.can.manage
          ? h('button', {
            class: 'btn btn-primary',
            onclick: () => act(async () => {
              S.t = await api('POST', `${tPath(t)}/knockout`, withEv(t), t.id);
              S.drawView = 'knockout';
              navigate(tabHref(t, 'draw'));
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
  // Organisers: groups left too small (or much smaller than the rest) after
  // no-shows and withdrawals.
  function lopsidedGroups(t) {
    if (!t.can.manage || t.status !== 'league' || t.groups.length < 2) return null;
    const size = (g) => g.standings.filter((r) => !r.withdrawn).length;
    const big = Math.max(...t.groups.map(size));
    const bad = t.groups.filter((g) => size(g) < 2 || big - size(g) >= 2);
    if (!bad.length) return null;
    return h('div', { class: 'banner warn' }, h('span', {},
      h('strong', {}, bad.map((g) => `${g.name} has ${size(g)} player${size(g) === 1 ? '' : 's'}`).join(' · ')),
      `, after no-shows or withdrawals. Move someone in with "Move…" (until a group starts), or add a latecomer to ${bad.length === 1 ? 'it' : 'them'}.`));
  }

  function panelGroups(t) {
    if (!t.groups.length) return empty('Groups appear once the tournament starts.');
    const warn = lopsidedGroups(t);
    if (warn) return [warn, panelGroupsBody(t)];
    return panelGroupsBody(t);
  }
  function panelGroupsBody(t) {
    const q = t.format === 'league_knockout' ? t.config.qualifiers : 1;
    const signed = (n) => (n > 0 ? `+${n}` : String(n));
    const sport = window.TonamentSports[t.sport.id];
    if (sport && sport.timed) return timedGroups(t, sport, q, signed);
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
        // Organisers: move a player while neither group has started.
        const canMove = t.can.manage && t.status === 'league' && !g.started;
        const others = t.groups.filter((x) => x.no !== g.no && !x.started);
        const moveTo = (r) => canMove && others.length && !r.withdrawn ? h('select', {
          class: 'move-select', 'aria-label': `Move ${r.name}`,
          onchange: (ev) => {
            const to = Number(ev.target.value);
            act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${r.id}/move`, { group: to }, t.id); }, `${r.name} moved to ${t.groups[to].name}`);
          },
        }, h('option', { value: '' }, 'Move…'), others.map((x) => h('option', { value: x.no }, `${x.name}${x.pool ? ` · ${x.pool}` : ''}`))) : null;
        return h('div', { class: 'card' },
          h('h2', {}, g.name, g.pool ? h('span', { class: 'event-tag level-tag pool-tag' }, g.pool) : null),
          h('div', { class: 'table-wrap' }, h('table', {},
            h('thead', {}, h('tr', {}, cols.map((c, i) => h('th', { class: i === 1 ? '' : 'num', title: titles[c] || null }, c)))),
            h('tbody', {}, g.standings.map((r) => h('tr', { class: qualifying(g, q).has(r.id) ? 'q' : r.withdrawn ? 'out' : '' },
              h('td', { class: 'num' }, r.rank),
              h('td', { class: 'name' }, r.name, r.withdrawn ? [' ', pill('withdrawn', 'Withdrew')] : null, moveTo(r)),
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

  // Football, hockey, basketball, …: a league table — played, won, drawn,
  // lost, goals (points) for and against, difference, league points.
  function timedGroups(t, sport, q, signed) {
    const lp = sport.leaguePoints || { win: 2, draw: 1 };
    const draws = sport.draws;
    const u = sport.compute('', {}).unit === 'Goal' ? 'G' : 'P';
    const what = u === 'G' ? 'goal' : 'point';
    const cols = ['#', 'Team', 'P', 'W', ...(draws ? ['D'] : []), 'L', `${u}F`, `${u}A`, `${u}D`, 'Pts'];
    const titles = { D: 'Drawn', [`${u}F`]: `${what[0].toUpperCase()}${what.slice(1)}s for`, [`${u}A`]: `${what[0].toUpperCase()}${what.slice(1)}s against`, [`${u}D`]: `${what[0].toUpperCase()}${what.slice(1)} difference`, Pts: `League points: win ${lp.win}${draws ? `, draw ${lp.draw}` : ''}` };
    const ranking = `Ranking: league points (win ${lp.win}${draws ? `, draw ${lp.draw}` : ''}, loss 0), then head-to-head, ${what} difference.`;
    return [
      h('p', { class: 'muted small' }, t.format === 'league_knockout' ? `Top ${q} in each group qualify for the knockout (highlighted). ${ranking}` : ranking),
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
              h('td', { class: 'num' }, r.pointsFor),
              h('td', { class: 'num' }, r.pointsAgainst),
              h('td', { class: 'num' }, signed(r.pointsFor - r.pointsAgainst)),
              h('td', { class: 'num' }, h('strong', {}, r.leaguePoints))))))),
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
  // Groups and the knockout bracket; League + Knockout switches between them.
  function panelDraw(t) {
    // A finished event: its podium as a picture to share.
    const podium = t.status === 'completed' && t.visibility !== 'private'
      ? h('div', { class: 'actions event-share' }, h('button', { class: 'btn btn-small', type: 'button', onclick: () => shareEvent(t, t.event) }, `Share the ${multiEvent(t) ? `${t.event.name} ` : ''}results`))
      : null;
    return podium ? [podium, drawBody(t)] : drawBody(t);
  }
  function drawBody(t) {
    if (t.format === 'league') return panelGroups(t);
    if (t.format === 'knockout') return panelBracket(t);
    const view = S.drawView || (t.matches.some((m) => m.stage === 'knockout') ? 'knockout' : 'groups');
    return [
      h('div', { class: 'seg draw-seg', role: 'group', 'aria-label': 'Show' }, [['groups', 'Groups'], ['knockout', 'Knockout']].map(([v, label]) => h('button', {
        type: 'button', class: v === view ? 'active' : '', 'aria-pressed': String(v === view),
        onclick: () => { S.drawView = v; render(); },
      }, label))),
      view === 'knockout' ? panelBracket(t) : panelGroups(t),
    ];
  }

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
  // Another phone is scoring this match right now: follow it, or take over on purpose.
  const scoredElsewhere = (m) => Boolean(m.scorer && m.scorer.device !== DEVICE);
  function takeOverCard(t, m) {
    return h('div', { class: 'card takeover-card' },
      h('p', {}, h('strong', {}, `${m.scorer.name} is scoring this match`), ' on another phone. The score here updates live.'),
      h('p', { class: 'muted small' }, 'Only one phone scores a match at a time, so points are never counted twice. Taking over moves scoring to this phone — the other one stops.'),
      h('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: () => confirm(`Score this match on this phone instead? ${m.scorer.name}'s phone will stop scoring it.`) && act(async () => {
          mergeMatch(await api('POST', `${tPath(t)}/matches/${m.id}/takeover`, {}, t.id));
          render();
        }, 'You\'re scoring this match now'),
      }, 'Take over scoring'));
  }

  function canScore(t, m) {
    return t.can.score && m.a && m.b && (m.status === 'scheduled' || m.status === 'live') && stageOpen(t, m);
  }

  // The tournament as seen from a match's own event (its scoring rules).
  // ---------- team ties (racket sports): line-ups, then each match of the tie
  const tiePath = (t, mid) => `${tPath(t)}/matches/${mid}/tie`;
  async function loadTie(t, mid) {
    try {
      S.tie = { mid, ...(await api('GET', tiePath(t, mid), undefined, t.id)) };
    } catch (e) {
      S.tie = { mid, error: e.message };
    }
    render();
  }
  setInterval(() => {
    if (S.route.name === 'match' && S.tie && S.tie.mid === S.route.mid && S.tie.status !== 'done' && !document.hidden && !isEditing() && !tieSending && S.t) {
      loadTie(forMatch(S.route.mid) || S.t, S.route.mid);
    }
  }, 5000);
  // Taps go one at a time, each on top of the last.
  const tieQueue = [];
  let tieSending = false;
  function tieTap(t, mid, n, extra) {
    tieQueue.push({ n, extra: { ...extra, t: Date.now() } });
    render();
    if (tieSending) return;
    tieSending = true;
    (async () => {
      while (tieQueue.length) {
        const { n: k, extra: x } = tieQueue[0];
        const r = S.tie.rubbers[k];
        try {
          S.tie = { mid, ...(await api('POST', `${tiePath(t, mid)}/rubbers/${k}/rally`, { ...x, at: r.rallies }, t.id)) };
          tieQueue.shift();
        } catch (e) {
          tieQueue.length = 0;
          if (e.code === 'stale') await loadTie(t, mid); else toast(e.message, true);
        }
        render();
      }
      tieSending = false;
    })();
  }

  function viewTie(t, m) {
    const x = S.tie;
    if (!x || x.mid !== m.id) {
      if (!x || x.mid !== m.id) { S.tie = { mid: m.id, loading: true }; loadTie(t, m.id); }
      return loading();
    }
    if (x.loading) return loading();
    if (x.error) return errorView(x.error);
    const names = { a: nameOf(m.a), b: nameOf(m.b) };
    const post = (path, body, msg) => act(async () => { S.tie = { mid: m.id, ...(await api('POST', `${tiePath(t, m.id)}/${path}`, body, t.id)) }; }, msg);
    const lineupForm = (side) => {
      const s = x.sides[side];
      const selects = x.format.rubbers.map((f, i) => h('div', { class: 'lineup-row' },
        h('strong', {}, f.label),
        Array.from({ length: f.kind === 'doubles' ? 2 : 1 }, (_, k) => h('select', { 'data-r': i, 'data-k': k, required: true, 'aria-label': `${f.label} player ${k + 1}` },
          h('option', { value: '' }, 'Pick a player'),
          s.roster.map((p) => h('option', { value: p.slot, selected: s.slots && s.slots[i] && s.slots[i][k] === p.slot }, p.name))))));
      const form = h('form', {
        class: 'lineup-form',
        onsubmit: (e) => {
          e.preventDefault();
          const slots = x.format.rubbers.map((f, i) => [...form.querySelectorAll(`select[data-r="${i}"]`)].map((el) => Number(el.value)));
          act(async () => { S.tie = { mid: m.id, ...(await api('PUT', `${tiePath(t, m.id)}/lineup`, { side, slots }, t.id)) }; form.removeAttribute('data-dirty'); },
            'Line-up in — it stays sealed until both teams are in');
        },
      }, selects, h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, s.lineup ? 'Change line-up' : 'Send line-up')));
      return form;
    };
    const sideCard = (side) => {
      const s = x.sides[side];
      return h('div', { class: 'card lineup-card' },
        h('div', { class: 'card-head' }, h('h3', {}, names[side]), s.lineup ? pill('done', 'Line-up in ✓') : pill('waiting', 'Waiting for the line-up')),
        s.canSet && s.roster && s.roster.length ? lineupForm(side)
          : s.canSet ? h('p', { class: 'muted small' }, 'Add the team\'s players first (Players tab › the team › Edit team).')
            : s.lineup && !s.slots ? h('p', { class: 'muted small' }, 'Sealed until both teams are in.') : null);
    };
    const rubbersMade = x.rubbers.some((r) => r.status !== 'waiting');
    const open = S.tieRubber;
    const rubberRow = (r) => {
      const scorable = x.can.score && r.status === 'live';
      return h('li', { class: `rubber${r.winner ? ` won-${r.winner}` : ''}` },
        h('span', { class: 'seed' }, r.label),
        h('span', { class: 'name' },
          r.a ? h('span', {}, h('span', { class: r.winner === 'a' ? 'won' : '' }, r.a.join(' & ')), h('span', { class: 'muted' }, ' v '), h('span', { class: r.winner === 'b' ? 'won' : '' }, r.b.join(' & '))) : h('span', { class: 'muted' }, r.kind === 'doubles' ? 'Doubles' : 'Singles'),
          r.summary ? h('small', { class: 'contact' }, r.summary) : null),
        r.status === 'done' ? pill('done', `${names[r.winner]} ✓`) : r.status === 'unplayed' ? pill('', 'Not needed') : r.status === 'live' && r.rallies ? pill('live', 'Playing') : null,
        scorable ? h('button', { class: 'btn btn-small', onclick: () => { S.tieRubber = open === r.position ? null : r.position; render(); } }, open === r.position ? 'Close' : 'Score') : null);
    };
    const rubberScorer = (r) => {
      const mm = { a: { id: 'a', name: r.a.join(' & ') }, b: { id: 'b', name: r.b.join(' & ') }, status: 'live', winner: r.winner, summary: r.summary, score: r.score };
      const atEnd = Boolean((S.gameMode || {})[`r${m.id}-${r.position}`]);
      const tap = (extra) => tieTap(t, m.id, r.position, extra);
      const sport = (S.sports || []).find((s) => s.id === t.sport.id);
      const n = (sport && sport.defaults && sport.defaults.bestOf) || 3;
      const games = Array.from({ length: (t.config.scoring && t.config.scoring.bestOf) || n }, (_, i) => [h('input', { type: 'number', min: 0, max: 99, inputmode: 'numeric', 'aria-label': `Game ${i + 1} ${mm.a.name}`, 'data-g': i, 'data-s': 'a' }), h('input', { type: 'number', min: 0, max: 99, inputmode: 'numeric', 'aria-label': `Game ${i + 1} ${mm.b.name}`, 'data-g': i, 'data-s': 'b' })]);
      const final = h('form', {
        class: 'tie-final',
        onsubmit: (e) => {
          e.preventDefault();
          const list = games.map(([a, b]) => ({ a: a.value, b: b.value })).filter((g) => g.a !== '' && g.b !== '').map((g) => ({ a: Number(g.a), b: Number(g.b) }));
          post(`rubbers/${r.position}/result`, { games: list }, `${r.label} saved`);
        },
      }, h('div', { class: 'tie-games' }, h('span', {}, ''), h('strong', {}, mm.a.name), h('strong', {}, mm.b.name),
        games.map(([a, b], i) => [h('span', { class: 'muted small' }, `Game ${i + 1}`), a, b])),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save score')));
      return h('div', { class: 'card tie-scorer' },
        h('h3', {}, `${r.label}: ${mm.a.name} v ${mm.b.name}`),
        r.score && r.rallies ? scoreboard(mm) : null,
        h('div', { class: 'seg score-mode', role: 'group', 'aria-label': 'How to score' },
          [[false, 'Score live'], [true, 'Final score']].map(([v, l]) => h('button', { 'aria-pressed': String(atEnd === v), onclick: () => { S.gameMode = { ...(S.gameMode || {}), [`r${m.id}-${r.position}`]: v }; render(); } }, l))),
        atEnd ? final : h('div', { class: 'scorer' },
          r.score && r.score.taps && r.score.taps.max > 1 ? pointPad(`r${m.id}-${r.position}`, r.score, { a: mm.a.name, b: mm.b.name }, tap)
            : h('div', { class: 'score-btns' }, ['a', 'b'].map((s) => h('button', { class: `score-btn side-${s}`, onclick: () => tap({ side: s }) }, h('span', { class: 'sbtn-plus' }, '+1'), h('span', { class: 'sbtn-name' }, mm[s].name)))),
          h('div', { class: 'sync', role: 'status' }, tieQueue.length ? 'Saving…' : 'All points saved'),
          h('div', { class: 'scorer-tools' }, h('button', { class: 'btn', disabled: (!r.rallies && !r.final) || tieQueue.length > 0, onclick: () => post(`rubbers/${r.position}/undo`, { at: r.rallies }) }, '↶ Undo'))));
    };
    const done = x.rubbers.filter((r) => r.status === 'done');
    const wins = { a: done.filter((r) => r.winner === 'a').length, b: done.filter((r) => r.winner === 'b').length };
    return [
      h('div', { class: 'card tie-head' },
        h('p', { class: 'eyebrow' }, `Team tie · ${x.format.name}${x.format.playAll ? ' · all matches played' : ''}`),
        h('div', { class: 'tie-score' },
          h('span', { class: x.winner === 'a' ? 'won' : '' }, names.a), h('strong', {}, `${wins.a} – ${wins.b}`), h('span', { class: x.winner === 'b' ? 'won' : '' }, names.b)),
        x.status === 'done' ? h('p', { class: 'small', style: 'margin:6px 0 0' }, `🏆 ${names[x.winner]} win the tie`) : null),
      rubbersMade ? null : h('div', { class: 'lineups' }, sideCard('a'), sideCard('b')),
      h('div', { class: 'card' }, h('h2', {}, 'Matches'),
        h('ol', { class: 'entries rubbers' }, x.rubbers.map(rubberRow)),
        rubbersMade ? null : h('p', { class: 'hint' }, 'Each captain picks who plays which match. Line-ups stay sealed until both are in; then the matches can be scored.')),
      open != null && x.rubbers[open] && x.rubbers[open].status === 'live' ? rubberScorer(x.rubbers[open]) : null,
    ];
  }

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
    const backTab = m.stage === 'knockout' ? 'draw' : 'live';
    // A team tie: line-ups, then each of its matches.
    if (t.config && t.config.tie && t.event.discipline === 'team') {
      return [h('a', { class: 'back', href: tabHref(t, backTab) }, `← ${t.name}${multiEvent(t) ? ` · ${t.event.name}` : ''}`),
        h('div', { class: 'match-head' }, h('span', {}, matchLabel(m)), h('span', { class: 'actions' }, connDot(), statusTag(m))),
        m.a && m.b ? viewTie(t, m) : h('p', { class: 'muted' }, 'Both teams aren\'t known yet.')];
    }
    return [
      h('a', { class: 'back', href: tabHref(t, backTab) }, `← ${t.name}${multiEvent(t) ? ` · ${t.event.name}` : ''}`),
      h('div', { class: 'match-head' },
        h('span', {}, matchLabel(m)),
        h('span', { class: 'actions' }, connDot(), statusTag(m))),
      scoreboard(m),
      canScore(t, m) && scoredElsewhere(m) ? takeOverCard(t, m) : canScore(t, m) ? scorer(t, m) : null,
      // The winning point may still be on its way: scorers see when it's saved.
      !canScore(t, m) && t.can.score && m.rallies ? syncLine(m) : null,
      t.can.score && m.status === 'done' && m.rallies
        ? h('div', { class: 'actions center', style: 'margin-bottom:16px' },
          h('button', { class: 'btn btn-ghost', onclick: () => undo(t, m) }, '↶ Undo last point (reopens the match)'))
        : null,
      gamesTable(m),
      m.status === 'done' && m.a && m.b && t.visibility !== 'private'
        ? h('div', { class: 'actions center', style: 'margin:16px 0' }, h('button', { class: 'btn', type: 'button', onclick: () => shareMatch(t, m) }, 'Share the result'))
        : null,
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
      m.score.taps && m.score.taps.values
        ? periodPad(m.score, { a: m.a.name, b: m.b.name }, (extra) => rally(t, m, extra.side, extra))
        : m.score.taps && m.score.taps.max > 1
          ? pointPad(m.id, m.score, { a: m.a.name, b: m.b.name }, (extra) => rally(t, m, extra.side, extra))
          : h('div', { class: 'score-btns' }, btn('a'), btn('b')),
      syncLine(m),
      h('div', { class: 'scorer-tools' },
        h('button', { class: 'btn', disabled: fresh, onclick: () => undo(t, m) }, '↶ Undo'),
        !fresh ? retireButtons(t, m) : null,
        h('form', {
          class: 'inline-form',
          onsubmit: (e) => { e.preventDefault(); patchMatch(t, m, { court: courtInput.value }, `${CAT.courtWord(t.sport.id)} saved`); courtInput.blur(); },
        }, h('span', { class: 'label' }, CAT.courtWord(t.sport.id)), courtInput, h('button', { class: 'btn btn-small', type: 'submit' }, 'Save'))),
      h('p', { class: 'hint center', style: 'margin:0' }, `${m.score.hint || 'Tap the side that won the rally.'} ${m.score.taps && m.score.taps.max > 1 && !m.score.taps.values
        ? 'Keyboard: A / L to pick the player, 1–9 to score, Z to undo.'
        : 'Keyboard: A / ← and L / → to score, Z to undo.'}`));
  }

  // Injury, or someone has to leave: they retire, the other side wins and
  // the points played stay on the scoresheet.
  function retireButtons(t, m) {
    if (S.retiring !== m.id) return h('button', { class: 'btn btn-ghost', onclick: () => { S.retiring = m.id; render(); } }, 'Retired…');
    const go = (sd) => {
      if (!confirm(`${m[sd].name} retired? ${m[sd === 'a' ? 'b' : 'a'].name} win${m[sd === 'a' ? 'b' : 'a'].name.includes('/') ? '' : 's'} the match.`)) return;
      act(async () => { mergeMatch(await api('POST', `${tPath(t)}/matches/${m.id}/retire`, { side: sd }, t.id)); S.retiring = null; }, 'Match ended — retired');
    };
    return h('span', { class: 'retire-pick' },
      ['a', 'b'].map((sd) => h('button', { class: 'btn btn-small btn-ghost danger', onclick: () => go(sd) }, `${m[sd].name} retired`)),
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => { S.retiring = null; render(); } }, 'Cancel'));
  }

  // The result at the end: each game's (set's, frame's) score, checked with
  // the sport's rules here first, then saved as if it had been scored live.
  function resultForm(t, m) {
    const sport = window.TonamentSports[t.sport.id];
    const sc0 = m.score;
    // Football, basketball, …: the final score, and the penalties (shoot-out,
    // tie-break raids) when a knockout match ends level.
    const timedTie = sc0.timed && !sc0.drawsAllowed && sc0.tieName;
    const labels = sc0.timed ? ['Final score', ...(timedTie ? [`${sc0.tieName} (if level)`] : [])] : null;
    const rows = labels ? labels.length : sc0.single ? 1 : Math.min(sport.normalizeConfig((m.rules && m.rules.scoring) || t.config.scoring).bestOf || 3, 11);
    const unit = sc0.timed ? 'Score' : sc0.single ? 'Result' : sc0.unit || 'Game';
    const need = sc0.single ? 1 : Math.ceil(rows / 2);
    const msg = h('p', { class: 'hint result-msg', role: 'status' }, sc0.timed
      ? `The score at the end${sc0.drawsAllowed ? ' — a level score is a draw' : ', including any extra time or overtime'}.`
      : sc0.single ? (sc0.note || '') : `Fill in each ${unit.toLowerCase()} played — best of ${rows}.`);
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
      h('tbody', {}, inputs.map(([a, b], i) => h('tr', {}, h('th', { scope: 'row' }, labels ? labels[i] : sc0.single ? (sc0.unit ? `${sc0.unit}s` : 'Score') : `${unit} ${i + 1}`), h('td', {}, a), h('td', {}, b))))),
    msg,
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save result')));
    return form;
  }

  // Football, hockey, kabaddi, basketball: each team's buttons (a goal, or
  // +1 / +2 / +3), and the end of the half or quarter when the whistle goes.
  function periodPad(score, names, onTap) {
    const T = score.taps;
    const end = h('button', {
      class: 'btn btn-lg end-period', type: 'button', disabled: !T.end || null,
      onclick: () => confirm(`${T.endLabel}?${T.endConfirm ? `\n${T.endConfirm}` : ''}`) && onTap({ end: true }),
    }, T.endLabel);
    if (T.values.length === 1) {
      const word = (score.tap && score.tap.a) || score.unit;
      return h('div', { class: 'point-pad' },
        h('div', { class: 'score-btns' }, ['a', 'b'].map((s) => h('button', {
          class: `score-btn side-${s}`, type: 'button', onclick: () => onTap({ side: s }), 'aria-label': `${word} to ${names[s]}`,
        }, h('span', { class: 'sbtn-plus sbtn-word' }, word), h('span', { class: 'sbtn-name' }, names[s])))),
        end);
    }
    return h('div', { class: 'point-pad' },
      h('div', { class: 'value-cols' }, ['a', 'b'].map((s) => h('div', { class: `value-col side-${s}` },
        h('div', { class: 'value-team' }, names[s]),
        h('div', { class: 'value-btns' }, T.values.map((n) => h('button', {
          class: `score-btn value-btn side-${s}`, type: 'button', onclick: () => onTap(n === 1 ? { side: s } : { side: s, points: n }), 'aria-label': `${n} to ${names[s]}`,
        }, `+${n}`)))))),
      end);
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
    // A match played under earlier rules (the match length changed mid-event) keeps them.
    const base = (m.rules && m.rules.scoring) || t.config.scoring;
    const scoring = t.event && t.event.discipline === 'doubles' ? { ...base, doubles: true } : base;
    const draws = sport.timed ? sport.draws : Boolean(m.rules ? m.rules.leagueDraws : t.config.leagueDraws);
    return (log) => TonamentLeague.score(sport, log, scoring, m.firstServer, { draws: m.stage === 'league' && draws });
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
    enqueue(t, m.id, { type: 'rally', side, ...extra, ch: tap.ch, t: Date.now() });
    const after = withPending(t, confirmedMatch(m.id) || m);
    if (after.status === 'done') toast(after.draw ? `🤝 Match drawn ${after.summary}` : `🏸 ${after[after.score.winner].name} wins ${after.summary}`);
  }
  // What a queued tap sends: the side, plus points / foul / end when set.
  // t: when the tap happened (queued taps keep their own time; see server/rally-times.js).
  const tapBody = (op, at) => ({ side: op.side, points: op.points, foul: op.foul, end: op.end, at, t: op.t });

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
    const pad = m.score.taps && m.score.taps.max > 1 && !m.score.taps.values;
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
  // A free upgrade from inviting friends: one tap, no payment.
  function creditButtons(t) {
    const list = t.credits || [];
    if (!list.length) return null;
    const best = list.reduce((a, c) => (c.tier === 'open' || !a ? c : a), null);
    return h('button', {
      class: 'btn btn-primary', type: 'button',
      onclick: () => confirm(`Use your free ${best.tierName} upgrade on ${t.name}?`) && act(async () => {
        const r = await api('POST', `${tPath(t)}/credit`, { creditId: best.id }, t.id);
        S.t = r.tournament;
      }, `${t.name} is now on the ${best.tierName} plan ✓`),
    }, `Use a free ${best.tierName} upgrade${list.length > 1 ? ` (you have ${list.length})` : ''}`);
  }

  function upgradeButtons(t, small) {
    return (t.upgrades || []).map((u, i) => h('button', {
      // A free upgrade on offer leads; paying is then the second choice.
      class: `btn ${i === 0 && !(t.credits && t.credits.length) ? 'btn-primary' : 'btn-ghost'}${small ? '' : ' btn-lg'}`,
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
      t.credits && t.credits.length ? h('div', { class: 'actions' }, creditButtons(t)) : null,
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
    // A private tournament's owner: one line to publish it (instead of a role bar and a banner).
    if (t.visibility === 'private' && t.can.own && S.me) {
      return h('div', { class: 'admin-bar private-bar' },
        h('span', {}, '🔒 ', h('strong', {}, 'Private'), h('span', { class: 'muted' }, ' — only your team can see it')),
        h('span', { class: 'actions' },
          h('button', { class: 'btn btn-small btn-primary', onclick: () => setVisibility(t, 'public') }, 'Publish'),
          moreButton('Who can see this', [
            { label: 'Link only', hint: 'Anyone with the link can open it; not listed on Tonament', onClick: () => setVisibility(t, 'link') },
            { label: 'Copy link', hint: 'Only your team can open it until you publish', onClick: () => copy(shareUrl(t), 'Link copied — only your team can open it until you publish') },
          ])));
    }
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
        h('p', { class: 'hint' }, 'Tip for the day: ask umpires to add Tonament to their home screen (Chrome: ⋮ → Install app; iPhone Safari: Share → Add to Home Screen). It opens full screen, straight to scoring.'),
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
    const find = h('form', {
      class: 'top-search', role: 'search',
      onsubmit: (e) => { e.preventDefault(); const q = e.target.q.value.trim(); navigate(`/compete${q ? `?q=${encodeURIComponent(q)}` : ''}`); },
    }, h('input', { name: 'q', type: 'search', placeholder: 'Find tournaments, races, meets…', 'aria-label': 'Find events' }));
    nav.replaceChildren(...(S.me
      ? [
        find,
        h('button', { class: 'btn btn-small btn-primary nav-new', type: 'button', 'aria-haspopup': 'dialog', onclick: createSheet }, '+ New'),
        h('a', { class: 'bell', href: '/notifications', 'aria-label': 'Notifications', title: 'Notifications' }, '🔔', h('span', { class: 'bell-count', hidden: true })),
        accountMenu(),
      ]
      : [
        h('a', { class: 'nav-link', href: '/signin' }, 'Sign in'),
        h('a', { class: 'btn btn-small btn-primary', href: '/signup' }, 'Sign up'),
      ]).filter(Boolean));
  }

  // The avatar's menu: your profile and pages, settings, sign out.
  function accountMenu() {
    const me = S.me;
    const item = (it) => (it.href
      ? h('a', { href: it.href, onclick: closeMenu }, it.label)
      : h('button', { type: 'button', onclick: (e) => { closeMenu(e); it.onClick(); } }, it.label));
    const groups = accountItems();
    return h('details', { class: 'menu' },
      h('summary', { class: 'avatar', title: me.name, 'aria-label': 'Account menu', 'data-hub': 'you' }, initialsOf(me.name)),
      h('div', { class: 'menu-panel' },
        h('div', { class: 'menu-head' }, h('strong', {}, me.name), h('div', { class: 'muted small' }, me.email)),
        groups.slice(0, -1).map((g) => [g.map(item), h('hr')]),
        h('div', { class: 'menu-theme' }, 'Theme', themeSwitch()),
        groups[groups.length - 1].map(item)));
  }
  function closeMenu(e) {
    e.target.closest('details')?.removeAttribute('open');
  }
  // Escape or a click elsewhere closes it.
  document.addEventListener('click', (e) => { for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.removeAttribute('open'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') for (const d of document.querySelectorAll('details.menu[open]')) d.removeAttribute('open'); });

  // ---------- the five hubs: Home · Play · Compete · Clubs · You
  const HUBS = [['home', 'Home', 'hub-home', '/'], ['play', 'Play', 'hub-play', '/play'], ['compete', 'Compete', 'hub-compete', '/compete'], ['clubs', 'Clubs', 'hub-clubs', '/clubs'], ['you', 'You', 'hub-you', '/you']];
  const HUB_OF = {
    home: 'home', item: 'home',
    play: 'play', groups: 'play', groupNew: 'play', group: 'play', groupGame: 'play', challenges: 'play', challengeNew: 'play', challenge: 'play', goals: 'play', goalNew: 'play', goal: 'play', runs: 'play',
    compete: 'compete', new: 'compete', tournament: 'compete', match: 'compete', races: 'compete', raceNew: 'compete', race: 'compete', meets: 'compete', meetNew: 'compete', meet: 'compete', champs: 'compete', champNew: 'compete', champ: 'compete',
    clubs: 'clubs', club: 'clubs', orgNew: 'clubs', clubChallenge: 'clubs', season: 'clubs', clubRun: 'clubs', clubRankings: 'clubs',
    you: 'you', profile: 'you', notifications: 'you', admin: 'you', invite: 'you', org: 'you', templates: 'you',
  };
  const NO_HUBS = ['display', 'signin', 'signup', 'forgot', 'reset', 'link'];
  let hubBar = null;
  function renderHubs() {
    const show = Boolean(S.me) && !NO_HUBS.includes(S.route.name);
    if (show && !hubBar) {
      hubBar = h('nav', { class: 'hubbar', 'aria-label': 'Main' }, HUBS.map(([id, label, ic, href]) => h('a', { href, 'data-hub': id }, icon(ic), h('span', {}, label))));
      document.body.append(hubBar);
    }
    if (hubBar) hubBar.hidden = !show;
    document.body.classList.toggle('has-hubbar', show);
    const current = HUB_OF[S.route.name] || null;
    for (const a of document.querySelectorAll('[data-hub]')) {
      const on = a.dataset.hub === current;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
  }

  // ---------- the desktop shell: a sidebar with every part of every hub
  // The sidebar item a page belongs to.
  function sideKey() {
    const r = S.route;
    const by = {
      groups: 'groups', groupNew: 'groups', group: 'groups', groupGame: 'groups',
      challenges: 'challenges', challengeNew: 'challenges', challenge: 'challenges',
      goals: 'goals', goalNew: 'goals', goal: 'goals', runs: 'runs',
      new: 'tournaments', tournament: 'tournaments', match: 'tournaments',
      races: 'races', raceNew: 'races', race: 'races', meets: 'meets', meetNew: 'meets', meet: 'meets', champs: 'racing', champNew: 'racing', champ: 'racing',
      clubRankings: 'rankings', orgNew: 'newclub',
    };
    if (r.name === 'compete') return r.tab;
    if (r.name === 'club') return `club:${r.slug}`;
    return by[r.name] || r.name;
  }
  let sidebar = null;
  let sidebarFor = '';
  const ensureMyClubs = () => {
    if (!S.me || S.myClubsFor === S.me.id) return;
    S.myClubsFor = S.me.id;
    api('GET', '/clubs/mine').then((list) => { S.myClubs = list.filter((c) => c.status === 'active'); sidebarFor = ''; render(); }, () => {});
  };
  function renderSidebar() {
    const show = Boolean(S.me) && !NO_HUBS.includes(S.route.name);
    document.body.classList.toggle('has-sidebar', show);
    if (!show) { if (sidebar) sidebar.hidden = true; return; }
    ensureMyClubs();
    const key = `${S.me.id}:${(S.myClubs || []).map((c) => c.slug).join(',')}`;
    if (!sidebar || sidebarFor !== key) {
      sidebarFor = key;
      const item = (k, label, href) => h('a', { class: 'side-item', href, 'data-side': k }, label);
      const head = (id) => { const [, label, ic, href] = HUBS.find((x) => x[0] === id); return h('a', { class: 'side-hub', href, 'data-hub': id, 'data-side': id }, icon(ic), h('span', {}, label)); };
      const next = h('aside', { class: 'sidebar', 'aria-label': 'Sections' },
        h('a', { href: '/', class: 'side-brand', 'aria-label': 'Tonament home' }, h('img', { src: '/brand/logo-white.svg', alt: 'Tonament', width: 160, height: 22 })),
        h('nav', {},
          head('home'),
          head('play'), item('groups', 'Groups', '/groups'), item('challenges', 'Challenges', '/challenges'), item('goals', 'Goals', '/goals'), item('runs', 'Runs', '/runs'),
          head('compete'), item('tournaments', 'Tournaments', '/compete'), item('races', 'Races', '/compete?tab=races'), item('meets', 'Meets', '/compete?tab=meets'), item('racing', 'Racing', '/compete?tab=racing'),
          head('clubs'), (S.myClubs || []).slice(0, 8).map((c) => item(`club:${c.slug}`, c.name, `/club/${c.slug}`)),
          item('rankings', 'Club rankings', '/clubs/rankings'), item('newclub', '+ Start a club', '/clubs/new')),
        h('div', { class: 'side-foot' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: createSheet }, '+ Start something')));
      if (sidebar) sidebar.replaceWith(next); else document.body.append(next);
      sidebar = next;
    }
    sidebar.hidden = false;
    const k = sideKey();
    for (const a of sidebar.querySelectorAll('[data-side]')) a.classList.toggle('current', a.dataset.side === k);
  }
  // A page with a column on the side (wide screens; below the page on narrow ones).
  const withRail = (main, rail) => h('div', { class: 'with-rail' }, h('div', { class: 'rail-main' }, main), rail && [rail].flat(Infinity).filter(Boolean).length ? h('aside', { class: 'rail' }, rail) : null);
  const railCard = (title, body, link, id) => h('section', { class: 'card rail-card', ...(id && { id }) }, h('div', { class: 'card-head' }, h('h2', {}, title), link || null), body);

  // + New: everything you can start, grouped.
  function createSheet() {
    const groups = [
      ['Run an event', [
        ['🏆', 'Tournament', 'Racket and team sports: groups, knockouts, live scores', '/new'],
        ...(S.me && myTemplates().length ? [['📋', 'From a template', `${myTemplates().length} saved setup${myTemplates().length === 1 ? '' : 's'} — pick one and a date`, '/templates']] : []),
        ['🏃', 'Race', 'Distances, bibs and results by age group', '/races/new'],
        ['🏅', 'Meet', 'Athletics, swimming, track cycling', '/meets/new'],
        ['🏁', 'Championship', 'Karting and club racing', '/champs/new'],
      ]],
      ['Play', [
        ['👥', 'Group', 'Weekly games with your regulars', '/groups/new'],
        ['⚔️', 'Challenge', 'Take on a friend', '/challenges/new'],
        ['🎯', 'Goal', '30 games, 100 km — with friends or your club', '/goals/new'],
        ['⏱️', 'Log a run', 'Distance and time', '/runs'],
      ]],
      ['Club', [
        ['🏠', 'Club', 'Free: members, a feed, club v club and seasons', '/clubs/new'],
      ]],
    ];
    const opener = document.activeElement;
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); if (opener && opener.isConnected) opener.focus(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const box = h('div', { class: 'sheet-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Start something', onclick: (e) => { if (e.target === box) close(); } },
      h('div', { class: 'sheet create-sheet' },
        h('h2', {}, 'Start something'),
        groups.map(([title, items]) => h('section', {}, h('h3', {}, title),
          h('div', { class: 'create-grid' }, items.map(([emoji, label, hint, href]) => h('a', { class: 'create-tile', href, onclick: () => close() },
            h('span', { class: 'create-emoji', 'aria-hidden': 'true' }, emoji), h('span', {}, h('strong', {}, label), h('small', { class: 'muted' }, hint))))))),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: close }, 'Cancel')));
    document.body.append(box);
    document.addEventListener('keydown', onKey);
    box.querySelector('a').focus();
  }

  // The 🔔's count: on each page change and every minute while the app is open.
  let unreadAt = 0;
  async function refreshBell(force = false) {
    if (!S.me || (!force && Date.now() - unreadAt < 20000)) return;
    unreadAt = Date.now();
    const r = await api('GET', '/notifications/unread').catch(() => null);
    const badge = document.querySelector('.bell-count');
    if (!r || !badge) return;
    badge.textContent = r.unread > 9 ? '9+' : String(r.unread);
    badge.hidden = !r.unread;
    badge.closest('.bell')?.setAttribute('aria-label', r.unread ? `Notifications (${r.unread} new)` : 'Notifications');
  }
  setInterval(() => { if (!document.hidden) refreshBell(true); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBell(); });

  // ---------- invites (referrals): organisers invite organisers.
  // A ?ref=code link is remembered for 60 days and sent with the sign-up; the
  // friend's first tournament is on the Club plan, and the inviter earns a free
  // upgrade once the friend runs one (server/referrals.js).
  const REF_KEY = 'tonament:ref';
  const REF_CODE = /^[a-z0-9]{4,24}$/;
  function savedRef() {
    try {
      const r = JSON.parse(localStorage.getItem(REF_KEY) || 'null');
      return r && REF_CODE.test(r.code) && Date.now() - r.at < 60 * 86400000 ? r.code : null;
    } catch { return null; }
  }
  const clearRef = () => { try { localStorage.removeItem(REF_KEY); } catch { /* fine */ } };
  // Links that bring new organisers in carry the code of whoever shared the page.
  const refHref = (path, code) => (code && S.billing && S.billing.enabled ? `${path}${path.includes('?') ? '&' : '?'}ref=${code}` : path);
  (() => {
    const code = new URLSearchParams(location.search).get('ref');
    if (code && REF_CODE.test(code)) try { localStorage.setItem(REF_KEY, JSON.stringify({ code, at: Date.now() })); } catch { /* this visit only */ }
  })();
  // Where this browser first came from (kept 60 days, sent with sign-up):
  // utm_ tags, ?src= on shared links, the referring site and the first page.
  const TOUCH_KEY = 'tonament:touch';
  function firstTouch() {
    try {
      const t = JSON.parse(localStorage.getItem(TOUCH_KEY) || 'null');
      return t && Date.now() - Date.parse(t.at) < 60 * 86400000 ? t : null;
    } catch { return null; }
  }
  (() => {
    const p = new URLSearchParams(location.search);
    const ref = document.referrer && !document.referrer.startsWith(location.origin) ? document.referrer : '';
    const tagged = ['utm_source', 'utm_medium', 'utm_campaign', 'src'].some((k) => p.get(k));
    // A tagged visit replaces an untagged first touch; otherwise the first one stays.
    if (firstTouch() && !(tagged && !firstTouch().tagged)) return;
    const touch = { at: new Date().toISOString(), landing: location.pathname.slice(0, 120), tagged };
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) if (p.get(k)) touch[k] = p.get(k).slice(0, 80);
    if (p.get('src')) touch.s = p.get('src').slice(0, 20);
    if (ref) touch.referrer = ref.slice(0, 200);
    try { localStorage.setItem(TOUCH_KEY, JSON.stringify(touch)); } catch { /* this visit only */ }
  })();
  async function loadInviter() {
    const code = savedRef();
    if (!code || S.me || S.invitedBy !== undefined) return;
    S.invitedBy = null;
    const r = await api('GET', `/referrals/${code}`).catch(() => null);
    S.invitedBy = r && r.name ? r.name : null;
    render();
  }
  // "Kavya invited you": before signing up, and the gift waiting for the first tournament after.
  function inviteBanner() {
    if (!S.billing || !S.billing.enabled) return null;
    const gift = S.me && S.gift;
    if (!gift && (S.me || !S.invitedBy)) return null;
    const from = gift ? gift.from : S.invitedBy;
    return h('div', { class: 'card invite-banner' },
      h('span', { class: 'invite-gift', 'aria-hidden': 'true' }, '🎁'),
      h('span', {}, h('strong', {}, `${from} invited you to Tonament`),
        h('small', { class: 'muted' }, gift ? ` Your first tournament is free up to ${gift.entries} entries (Club plan) — it's applied when you create it.` : ' Your first tournament is free up to 64 entries (Club plan) — sign up to claim it.')),
      !S.me ? h('a', { class: 'btn btn-primary btn-small', href: '/signup?next=%2Fnew' }, 'Claim it') : S.route.name !== 'new' ? h('a', { class: 'btn btn-primary btn-small', href: '/new' }, 'Create it') : null);
  }
  async function refreshMe() {
    const me = await api('GET', '/auth/me').catch(() => null);
    if (me) { S.me = me.user; S.gift = me.gift || null; }
  }

  // /invite: your link, how it works, friends and credits.
  // This tournament's AI credits, and getting more.
  function aiCreditsCard(t) {
    if (!S.aiEnabled || !t.can.manage) return null;
    const c = creditsFor(t.id);
    if (!c || !c.enforced) return null;
    const row = (label, b) => h('li', {}, h('strong', {}, label), ' ', h('span', { class: `muted${b.low ? ' low' : ''}` }, b.granted ? `${b.total} of ${b.granted} left` : 'none yet'));
    return h('div', { class: 'card' },
      h('h2', {}, 'AI help'),
      h('ul', { class: 'plain-list' }, row('Setup', c.balance.create), row('On the day', c.balance.manage)),
      h('p', { class: 'muted small' }, 'Setup credits read posters, forms and Google Form responses. On-the-day credits are for the assistant that handles late entries, check-ins and no-shows with you. Everything still works without them.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => aiPacksSheet(t.id) }, 'Get AI credits')));
  }

  // ---------- templates and new editions
  // The signed-in user's templates (loaded once; [] until then).
  function myTemplates() {
    if (S.newTemplates === undefined) { S.newTemplates = null; api('GET', '/me/templates').then((r) => { S.newTemplates = r.templates; render(); }).catch(() => { S.newTemplates = []; }); }
    return S.newTemplates || [];
  }
  const saveAsTemplate = (t) => {
    const name = prompt('Name the template (you\'ll pick a date each time you use it):', t.name.replace(/\s*\b20\d\d\b\s*/g, ' ').trim());
    if (name === null) return;
    act(async () => { await api('POST', `${tPath(t)}/template`, { name: name.trim() || t.name.replace(/\s*\b20\d\d\b\s*/g, ' ').trim() }, t.id); S.newTemplates = undefined; }, 'Saved — find it under Compete › Your templates, or when you create a tournament');
  };
  const runAgainHref = (t) => `/new?from=t:${encodeURIComponent(t.id)}&name=${encodeURIComponent(nextEdition(t.name))}`;
  // On the Setup › Events section: reuse this tournament.
  function reuseCard(t) {
    if (!t.can.manage) return null;
    return h('div', { class: 'card' },
      h('h2', {}, 'Use this setup again'),
      h('p', { class: 'muted small' }, 'Its events, format, scoring, fees, prizes and venue — without the players, dates or results.'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: runAgainHref(t) }, 'Run it again'),
        h('button', { class: 'btn', type: 'button', onclick: () => saveAsTemplate(t) }, 'Save as a template')));
  }
  // A new edition, before it starts: tell last time's players it's back.
  const INVITED_KEY = 'tonament:invited';
  function previousCard(tt) {
    if (!tt.previous || !tt.can.manage || tt.status !== 'setup') return null;
    let done = [];
    try { done = JSON.parse(localStorage.getItem(INVITED_KEY) || '[]'); } catch { /* none */ }
    if (done.includes(tt.id)) return null;
    const mark = () => { try { localStorage.setItem(INVITED_KEY, JSON.stringify([...done, tt.id].slice(-50))); } catch { /* this visit */ } };
    const ready = tt.visibility !== 'private' && tt.entriesOpen;
    const invite = () => act(async () => {
      const r = await api('POST', `${tPath(tt)}/invite-previous`, {}, tt.id);
      mark();
      toast(r.invited ? `Told ${r.invited} player${r.invited === 1 ? '' : 's'} from last time ✓` : 'Everyone from last time has already been told (or entered)');
    });
    return h('div', { class: 'card wrap-card' },
      h('button', { class: 'icon-btn wrap-close', type: 'button', 'aria-label': 'Hide', title: 'Hide', onclick: () => { mark(); render(); } }, '×'),
      h('h2', {}, '📣 Tell last time\'s players'),
      h('p', {}, ready
        ? 'Everyone with a Tonament account who played last time gets a notification (and an email) that it\'s back, with a link to enter.'
        : 'Once it\'s published with entries open, everyone with a Tonament account who played last time can get a notification (and an email) with a link to enter.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'button', disabled: !ready, onclick: invite }, 'Tell them it\'s back')));
  }

  function viewTemplates() {
    document.title = 'Tournament templates · Tonament';
    const list = S.templates;
    if (!list) return loading();
    const rename = (x) => {
      const name = prompt('New name:', x.name);
      if (!name || !name.trim()) return;
      act(async () => { const r = await api('PATCH', `/templates/${x.id}`, { name: name.trim() }); Object.assign(x, r); S.newTemplates = undefined; }, 'Renamed');
    };
    const remove = (x) => {
      if (!confirm(`Delete the template "${x.name}"? Tournaments made from it stay as they are.`)) return;
      act(async () => { S.templates = (await api('DELETE', `/templates/${x.id}`)).templates; S.newTemplates = undefined; }, 'Template deleted');
    };
    return [
      h('a', { class: 'back-link', href: '/compete' }, '← Compete'),
      h('h1', {}, 'Tournament templates'),
      h('p', { class: 'muted' }, 'A template is a tournament\'s events, format, scoring, fees, prizes and venue. Start a new tournament from one and pick the date.'),
      list.length
        ? h('div', { class: 'card-list' }, list.map((x) => h('div', { class: 'card template-card' },
          h('div', { class: 'card-head' },
            h('span', {}, h('strong', {}, x.name), h('small', { class: 'muted', style: 'display:block' }, [x.sportName, x.venue, x.city].filter(Boolean).join(' · '))),
            moreButton(x.name, [{ label: 'Rename', onClick: () => rename(x) }, { label: 'Delete', danger: true, onClick: () => remove(x) }])),
          h('p', { class: 'small' }, x.events.join(' · ')),
          h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary btn-small', href: `/new?from=tpl:${x.id}` }, 'Use it')))))
        : h('div', { class: 'card' }, h('p', {}, 'No templates yet.'), h('p', { class: 'muted small' }, 'Open a tournament you run, go to Setup › Events, and tap "Save as a template".')),
    ];
  }

  function viewInvite() {
    document.title = 'Invite organisers · Tonament';
    const r = S.referrals;
    if (!r) return loading();
    if (!r.enabled) return h('div', { class: 'card' }, h('h1', {}, 'Invite organisers'), h('p', { class: 'muted' }, 'Every tournament is free right now — share Tonament with anyone: tonament.com'));
    const url = `${location.origin}/?ref=${r.code}`;
    const share = () => shareText(`I run my tournaments on Tonament — entries, draws and live scores on everyone's phone. Sign up with my link and your first tournament is free up to 64 entries: ${url}`);
    const unused = r.credits.filter((c) => !c.usedAt && c.reason !== 'welcome');
    return [
      h('div', { class: 'card invite-hero' },
        h('p', { class: 'eyebrow' }, 'Invite organisers · ', h('b', {}, 'You both get a free upgrade')),
        h('h1', {}, 'Share Tonament, get free upgrades'),
        h('ol', { class: 'invite-steps' },
          h('li', {}, h('strong', {}, 'Share your link'), ' with clubs, academies and anyone who runs tournaments. (The "Run your own" links on your tournament pages carry it too.)'),
          h('li', {}, h('strong', {}, 'Your friend'), ' gets their first tournament free up to 64 entries — the Club plan, worth ', money(S.billing.tiers ? S.billing.tiers[0].price : 49900), '.'),
          h('li', {}, h('strong', {}, 'You get a free Club upgrade'), ` when they run it (${r.qualifyEntries}+ entries) — and an Open upgrade for every 3rd friend. Got an academy or venue page? It gets a month more too.`)),
        h('div', { class: 'invite-link' }, h('code', {}, url)),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-primary', type: 'button', onclick: share }, 'Share on WhatsApp'),
          h('button', { class: 'btn', type: 'button', onclick: () => copy(url, 'Invite link copied') }, 'Copy link'))),
      h('div', { class: 'card' },
        h('h2', {}, 'Your invites'),
        h('p', {}, h('strong', {}, `${r.friends.length} friend${r.friends.length === 1 ? '' : 's'} joined`), ` · ${r.qualified} ran a tournament`,
          h('br'), h('small', { class: 'muted' }, `${r.toMilestone} more for an Open upgrade (150 entries).`)),
        h('div', { class: 'invite-meter', 'aria-hidden': 'true' }, [0, 1, 2].map((i) => h('span', { class: i < (r.qualified % 3) ? 'on' : '' }))),
        r.friends.length ? h('ul', { class: 'org-t-list' }, r.friends.map((f) => h('li', {}, h('span', {}, f.name), f.qualified ? pill('done', 'Ran a tournament ✓') : pill('waiting', 'Joined')))) : h('p', { class: 'muted small' }, 'Nobody yet — share your link to get started.')),
      h('div', { class: 'card' },
        h('h2', {}, 'Your free upgrades'),
        unused.length
          ? [h('ul', { class: 'org-t-list' }, unused.map((c) => h('li', {}, h('span', {}, h('strong', {}, `${c.tierName} upgrade`), h('small', { class: 'muted' }, c.reason === 'milestone' ? ' · for 3 friends' : ' · for a friend')), pill('done', 'Ready')))),
            h('p', { class: 'hint' }, 'Use one from any of your tournaments: Players tab → "Use a free upgrade" when you need more entries.')]
          : h('p', { class: 'muted small' }, 'None yet. You\'ll get one when a friend you invited runs their first tournament.'),
        r.credits.some((c) => c.usedAt && c.reason !== 'welcome')
          ? h('p', { class: 'muted small' }, 'Used: ', r.credits.filter((c) => c.usedAt && c.reason !== 'welcome').map((c) => `${c.tierName} for ${c.tournament ? c.tournament.name : 'a tournament'}`).join(' · '))
          : null),
    ];
  }

  // ---------- installing the app (Add to Home screen): no app store needed.
  // Android and desktop Chrome hand us an install prompt to keep for later;
  // iPhones never do, so they get the Share → Add to Home Screen steps.
  let installPrompt = null;
  const INSTALL_KEY = 'tonament:install-dismissed';
  const installed = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const canInstall = () => !installed() && Boolean(installPrompt || isIOS);
  const installDismissed = () => { try { return Date.now() - Number(localStorage.getItem(INSTALL_KEY) || 0) < 30 * 86400000; } catch { return false; } };
  const refreshInstall = () => { navFor = null; renderNav(); render(); };
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; refreshInstall(); });
  window.addEventListener('appinstalled', () => { installPrompt = null; refreshInstall(); toast('Tonament is on your home screen ✓'); });

  async function installApp() {
    if (!installPrompt) return iosInstallSheet();
    const p = installPrompt;
    installPrompt = null;
    p.prompt();
    try { await p.userChoice; } catch { /* closed */ }
    refreshInstall();
  }

  function iosInstallSheet() {
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const shareIcon = h('span', { class: 'share-glyph', 'aria-label': 'Share' });
    shareIcon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5v10h14V11h-1"/></g></svg>';
    const box = h('div', { class: 'sheet-backdrop', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add Tonament to your home screen', onclick: (e) => { if (e.target === box) close(); } },
      h('div', { class: 'sheet' },
        h('img', { src: '/brand/icon-192.png', alt: '', width: 56, height: 56, class: 'sheet-icon' }),
        h('h2', {}, 'Add Tonament to your home screen'),
        h('ol', { class: 'sheet-steps' },
          h('li', {}, 'Tap ', shareIcon, h('strong', {}, ' Share'), ' in Safari\'s toolbar (at the bottom, or the top on an iPad).'),
          h('li', {}, 'Scroll down and tap ', h('strong', {}, 'Add to Home Screen'), '.'),
          h('li', {}, 'Tap ', h('strong', {}, 'Add'), '. Tonament opens full screen, like an app.')),
        h('button', { class: 'btn btn-primary', type: 'button', onclick: close }, 'Got it')));
    document.body.append(box);
    document.addEventListener('keydown', onKey);
    box.querySelector('button').focus();
  }

  // A one-line offer on phones (home page, your groups), until it's dismissed.
  function installBanner() {
    if (!canInstall() || installDismissed() || !window.matchMedia('(pointer: coarse)').matches) return null;
    const dismiss = () => { try { localStorage.setItem(INSTALL_KEY, String(Date.now())); } catch { /* this visit only */ } render(); };
    return h('div', { class: 'card install-banner' },
      h('img', { src: '/brand/icon-192.png', alt: '', width: 40, height: 40 }),
      h('span', { class: 'install-text' }, h('strong', {}, 'Get the Tonament app'), h('small', { class: 'muted' }, 'Add it to your home screen — opens full screen, no app store.')),
      h('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: installApp }, installPrompt ? 'Install' : 'How'),
      h('button', { class: 'btn btn-ghost btn-small install-close', type: 'button', 'aria-label': 'Not now', onclick: dismiss }, '✕'));
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
    // A code to a confirmed mobile (once WhatsApp or SMS is switched on).
    if (!signup && S.phoneEnabled && S.route.phone) return phoneSignIn(next);
    // Email me a link: no password, and this phone stays signed in.
    if (S.emailEnabled && !S.route.password) return linkCard(signup, next);
    const btn = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, signup ? 'Create account' : 'Sign in');
    const form = h('form', {
      class: 'card form auth-card',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        try {
          const body = { ...Object.fromEntries(new FormData(form)), ...(signup && savedRef() && { ref: savedRef() }), ...(signup && { source: firstTouch() }) };
          const { user } = await api('POST', signup ? '/auth/signup' : '/auth/login', body);
          S.me = user;
          if (signup) { clearRef(); await refreshMe(); }
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
      h('button', { type: 'button', class: 'link-btn', onclick: () => { S.route.password = false; render(); } }, 'Email me a sign-in link instead')) : null,
    !signup && S.phoneEnabled ? h('p', { class: 'center small', style: 'margin:0' },
      h('button', { type: 'button', class: 'link-btn', onclick: () => { S.route.phone = true; render(); } }, 'Get a code on my mobile instead')) : null);
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
        const { code, poll } = await api('POST', '/auth/link', { email: address, next, ...(savedRef() && { ref: savedRef() }), source: firstTouch() });
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
    !signup && S.phoneEnabled ? h('p', { class: 'center small', style: 'margin:0' },
      h('button', { type: 'button', class: 'link-btn', onclick: () => { S.route.phone = true; render(); } }, 'Get a code on my mobile instead')) : null,
    h('p', { class: 'center small muted', style: 'margin:0' }, 'New here? The same link creates your free account.'));
    return form;
  }

  // Signing in with a code sent by WhatsApp or SMS to a number confirmed on the account.
  function phoneSignIn(next) {
    const d = S.route.otp || (S.route.otp = { phone: '', code: '', sent: null });
    const go = (fn) => async (e) => { e.preventDefault(); try { await fn(); } catch (err) { toast(err.message, true); } render(); };
    const back = h('p', { class: 'center small', style: 'margin:0' },
      h('button', { type: 'button', class: 'link-btn', onclick: () => { S.route.phone = false; render(); } }, 'Use my email instead'));
    if (!d.sent) {
      return h('form', { class: 'card form auth-card', onsubmit: go(async () => { d.sent = await api('POST', '/auth/otp/request', { phone: d.phone, purpose: 'login' }); }) },
        h('h1', {}, 'Sign in'),
        h('p', { class: 'muted' }, 'We\'ll send a code to the mobile number on your account.'),
        field('Mobile number', h('input', { name: 'phone', type: 'tel', required: true, autocomplete: 'tel', placeholder: '98765 43210', value: d.phone, oninput: (e) => { d.phone = e.target.value; } })),
        h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Send me a code'),
        back);
    }
    return h('form', {
      class: 'card form auth-card',
      onsubmit: go(async () => {
        const { user } = await api('POST', '/auth/otp/verify', { phone: d.phone, code: d.code, purpose: 'login' });
        S.me = user;
        S.t = null;
        await refreshMe();
        toast(`Signed in as ${user.name}`);
        navigate(next, { replace: true });
      }),
    },
    h('h1', {}, 'Enter your code'),
    h('p', { class: 'muted' }, `If ${d.sent.to} is on a Tonament account, a code is on its way. It's good for ${d.sent.minutes} minutes.`),
    field('Code', h('input', { name: 'code', required: true, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, value: d.code, oninput: (e) => { d.code = e.target.value; } })),
    h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Sign in'),
    h('p', { class: 'center small', style: 'margin:0' }, h('button', { type: 'button', class: 'link-btn', onclick: () => { d.sent = null; d.code = ''; render(); } }, 'Use another number')),
    back);
  }

  // Opening the emailed link: signs in, or asks a new player's name first.
  async function useLink(name) {
    const r = S.route;
    try {
      const res = await api('POST', '/auth/link/use', { token: r.token, ...(name && { name }), ...(savedRef() && { ref: savedRef() }), source: firstTouch() });
      if (res.needsName) {
        Object.assign(r, { state: 'name', email: res.email });
        render();
        return;
      }
      S.me = res.user;
      S.t = null;
      navFor = null;
      clearRef();
      await refreshMe();
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
  // In the group's time zone (a phone set to another zone still sees the venue's times, like the header).
  const fmtTime = (iso, timeZone) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...(timeZone && { timeZone }) });
  // "Today, 6:00 – 9:00 am"
  function fmtSessionDay(iso, endIso, timeZone) {
    const d = new Date(iso);
    const ymd = (x) => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone && { timeZone }) }).format(x);
    const diff = Math.round((Date.parse(ymd(d)) - Date.parse(ymd(new Date()))) / 86400000);
    const on = endIso && Date.parse(iso) <= Date.now() && Date.now() < Date.parse(endIso); // began before midnight, still going
    const label = diff === 0 || on ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', ...(timeZone && { timeZone }) });
    return `${label}, ${fmtTime(iso, timeZone)}${endIso ? ` – ${fmtTime(endIso, timeZone)}` : ''}`;
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
    return `${run} · ${time} · ${s.courts} ${(s.courts === 1 ? CAT.courtWord(sport) : CAT.courtWords(sport)).toLowerCase()}`;
  }
  const teamName = (team) => team.map((p) => p.name).join(' & ');
  // ['Beginner', 'Intermediate'] -> "Beginner & Intermediate"; none -> "All levels".
  const levelText = (levels) => (levels && levels.length ? levels.length === 1 ? levels[0] : `${levels.slice(0, -1).join(', ')} & ${levels[levels.length - 1]}` : 'All levels');
  const groupLevels = (sportId) => CAT.levelsFor(sportId).filter((l) => l !== 'Open');
  const groupUrl = (g, withInvite) => `${location.origin}/g/${g.slug}${withInvite && g.invite ? `?join=${g.invite}` : ''}`;

  async function loadGroup(skip = 0) {
    const slug = S.route.slug;
    try {
      const qs = [skip && `skip=${skip}`, S.route.join && `join=${encodeURIComponent(S.route.join)}`].filter(Boolean).join('&');
      const g = await api('GET', `${gPath(slug)}${qs ? `?${qs}` : ''}`);
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
  const groupAct = (fn, msg, undo) => act(async () => { await fn(); await loadGroup(S.route.skip || 0); }, msg,
    undo ? async () => { await undo(); await loadGroup(S.route.skip || 0); } : null);

  // Your groups.
  function viewGroups() {
    document.title = 'Your groups · Tonament';
    const list = S.groupsList;
    return [
      installBanner(),
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
    groupField(CAT.courtWords(sport.id), choiceGroup({ name: 'courts', label: CAT.courtWords(sport.id), value: fs ? fs.courts : 2, options: [1, 2, 3, 4, 5, 6].map((n) => ({ value: n, label: String(n) })) })),
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
  const GROUP_TABS = [['today', 'Today', 'tab-live'], ['leaderboard', 'Leaderboard', 'tab-board'], ['members', 'Members', 'tab-players']];
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
    const claimCard = groupClaimCard(g);
    if (!g.member) {
      const next = `/g/${g.slug}${S.route.join ? `?join=${encodeURIComponent(S.route.join)}` : ''}`;
      if (claimCard) return [head, claimCard];
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
        ]), g.role === 'requested' ? null : groupFindName(g, g.guests || [])];
    }
    const tabs = [...GROUP_TABS, ...(g.admin ? [['attendance', 'Attendance', 'tab-calendar'], ['settings', 'Settings', 'tab-setup']] : [])];
    const tab = tabs.some(([id]) => id === S.route.tab) ? S.route.tab : 'today';
    const body = { today: groupToday, leaderboard: groupLeaderboard, members: groupMembers, attendance: groupAttendance, settings: groupSettings }[tab](g);
    return [head, claimCard,
      // On phones, a bar at the bottom of the screen (like a tournament's tabs).
      h('nav', { class: 'tabs t-tabs bar', 'aria-label': 'Group' }, tabs.map(([id, label, ic]) => h('a', {
        href: `/g/${g.slug}${id === 'today' ? '' : `?tab=${id}`}`, class: id === tab ? 'active' : '', 'aria-current': id === tab ? 'page' : null,
      }, icon(ic), h('span', {}, label, id === 'members' && g.requests.length ? h('span', { class: 'tab-count' }, g.requests.length) : null)))),
      h('section', {}, body),
      g.admin ? null : h('p', { class: 'run-your-own muted small' }, 'Play in a group or run a club? ', h('a', { href: refHref('/signup?next=%2Fgroups%2Fnew', g.refCode) }, 'Start your own on Tonament — free'))];
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
        h('h2', {}, fmtSessionDay(s.startsAt, s.endsAt, g.settings.timeZone)),
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
      `${fmtSessionDay(s.startsAt, s.endsAt, g.settings.timeZone)} · ${going} going${max ? (going < max ? `, ${max - going} spot${max - going === 1 ? '' : 's'} left` : ', full (waitlist open)') : ''}`,
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
    const out = [groupFindNameForMember(g)];
    if (!s.today) {
      out.push(rsvpCard(g, s));
      return out;
    }
    const me = s.me;
    const here = me && me.checkedIn;
    const post = (on, user) => () => api('POST', `${gPath(g.slug)}/sessions/${s.id}/checkin`, { here: on, ...(user && { user }) });
    // Admins marking others get Undo (a mis-tap in a long list).
    const checkIn = (on, user) => groupAct(post(on, user), on ? (user ? 'Checked in' : 'You\'re checked in') : 'See you next time', user ? post(!on, user) : null);
    const step = g.admin ? groupNextStep(g, s) : null;
    if (step) out.push(step.card);
    // Before it starts: RSVP as usual (people decide half an hour before).
    if (!s.started) out.push(rsvpCard(g, s));
    // 1. Me: check in.
    out.push(h('div', { class: `card checkin-card${here ? ' on' : ''}` },
      h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, fmtSessionDay(s.startsAt, s.endsAt, g.settings.timeZone)), h('p', { class: 'muted small' }, `${s.players.filter((p) => p.checkedIn).length} here · ${s.players.filter((p) => p.status === 'in').length} in`)),
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
    if (sug && !(step && step.startsGame)) {
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
    // Or pick the players yourself (what actually happens at the court doesn't always match the suggestion).
    if (free.length && (here || g.admin)) out.push(pickPlayersCard(g, s, free));
    // 4. Waiting + admin check-ins.
    if (s.waiting.length) {
      out.push(h('div', { class: 'card' }, h('h3', { style: 'margin:0 0 6px' }, `Waiting (${s.waiting.length})`),
        h('p', { class: 'rsvp-names' }, s.waiting.map((p) => h('span', { class: 'name-chip here' }, p.name, h('small', {}, ` ${p.games}`))))));
    }
    if (g.admin) out.push(whosHereCard(g, s, checkIn));
    // 5. Results.
    if (s.results.length) {
      out.push(h('div', { class: 'card results-card' }, h('h2', {}, 'Results today'),
        h('ul', { class: 'result-list' }, s.results.map((x) => gameResultRow(g, x)))));
    }
    if (s.started) out.push(addResultCard(g, s));
    if (g.nextSession) out.push(rsvpCard(g, g.nextSession, true));
    return out;
  }

  // Group admins: the one thing to do now on a session day — mark who's
  // here, start the next game on a free court, sort out a disputed result —
  // with the day so far. { card, startsGame } or null.
  function groupNextStep(g, s) {
    const word = CAT.courtWord(g.sport.id);
    const here = s.players.filter((p) => p.checkedIn);
    const saidIn = s.players.filter((p) => p.status === 'in' && !p.checkedIn);
    const free = s.courts.filter((c) => !c.gameId);
    const sug = s.suggestion;
    const disputed = s.results.filter((x) => x.status === 'disputed');
    const reveal = (sel, flag) => () => {
      S[flag] = true;
      render();
      setTimeout(() => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
    };
    let title;
    let text = null;
    let actions = [];
    let startsGame = false;
    if (!s.started) {
      const going = s.players.filter((p) => p.status === 'in').length;
      const max = g.settings.maxPlayers;
      title = `${going} in${max ? ` of ${max}` : ''} so far`;
      text = max && going >= max ? 'Full — anyone else goes on the waitlist.' : 'Share it in your WhatsApp group so people say they\'re in.';
      actions = [h('button', { class: 'btn btn-primary', onclick: () => shareSession(g, s) }, 'Share on WhatsApp')];
    } else if (disputed.length) {
      title = `${disputed.length} result${disputed.length === 1 ? ' is' : 's are'} disputed`;
      text = 'Keep it or void it — until then it doesn\'t count.';
      actions = [h('button', { class: 'btn btn-primary', onclick: reveal('.results-card', 'resultsOpen') }, 'Review')];
    } else if (sug && free.length) {
      startsGame = true;
      title = `${word} ${free[0].no} is free`;
      text = `Up next: ${sug.a.map((p) => p.name).join(' & ')} v ${sug.b.map((p) => p.name).join(' & ')}`;
      actions = [
        h('button', {
          class: 'btn btn-primary',
          onclick: () => act(async () => {
            const { id } = await api('POST', `${gPath(g.slug)}/sessions/${s.id}/games`, { court: free[0].no, a: sug.a.map((p) => p.id), b: sug.b.map((p) => p.id) });
            S.route.skip = 0;
            navigate(`/g/${g.slug}/game/${id}`);
          }),
        }, `Start on ${word} ${free[0].no}`),
        sug.more ? h('button', { class: 'btn', onclick: () => { S.route.skip = (S.route.skip || 0) + 1; loadGroup(S.route.skip); } }, 'Someone else') : null,
        h('button', { class: 'btn btn-ghost', onclick: reveal('.pick-card', 'pickOpen') }, 'Pick players'),
      ];
    } else if (saidIn.length) {
      title = `${saidIn.length} said they're in but haven't checked in`;
      text = here.length < 4 ? `${here.length} here — 4 for a game.` : null;
      actions = [h('button', { class: 'btn btn-primary', onclick: reveal('.whos-here', 'whosHereOpen') }, 'Mark who\'s here')];
    } else if (!free.length) {
      title = `All ${s.courts.length} ${word.toLowerCase()}${s.courts.length === 1 ? '' : 's'} are playing`;
      text = s.waiting.length ? `${s.waiting.length} waiting — they're next when one frees up.` : null;
    } else {
      title = here.length < 4 ? 'Waiting for players' : 'Everyone free is on court';
      text = here.length < 4 ? `${here.length} here — 4 for a game. Mark anyone who's arrived.` : null;
      if (here.length < 4) actions = [h('button', { class: 'btn btn-primary', onclick: reveal('.whos-here', 'whosHereOpen') }, 'Mark who\'s here')];
    }
    const card = h('div', { class: 'card next-step' },
      h('p', { class: 'eyebrow' }, 'Next step'),
      h('h2', {}, title),
      text ? h('p', { class: 'muted small' }, text) : null,
      actions.filter(Boolean).length ? h('div', { class: 'actions' }, actions) : null,
      s.started ? h('p', { class: 'muted small next-progress' }, `${here.length} here · ${s.live.length} on ${word.toLowerCase()} · ${s.results.length} result${s.results.length === 1 ? '' : 's'} today`) : null);
    return { card, startsGame };
  }

  // A game with the players you choose: 2 v 2, or 1 v 1 (leave the partners
  // empty). Free checked-in players first; admins can also pick anyone in the
  // group, who is checked in as the game starts.
  function pickPlayersCard(g, s, free) {
    const word = CAT.courtWord(g.sport.id);
    const ready = s.waiting;
    const onCourt = new Set(s.live.flatMap((x) => [...x.a, ...x.b].map((p) => p.id)));
    const others = g.admin ? g.leaderboard.filter((r) => !ready.some((p) => p.id === r.id) && !onCourt.has(r.id)) : [];
    const draft = S.pickDraft && S.pickDraft.session === s.id ? S.pickDraft : { session: s.id };
    const options = (optional, chosen) => [
      h('option', { value: '', selected: !chosen }, optional ? 'No partner (singles)' : 'Pick a player'),
      ready.length ? h('optgroup', { label: 'Here and free' }, ready.map((p) => h('option', { value: p.id, selected: String(p.id) === chosen }, p.name))) : null,
      others.length ? h('optgroup', { label: 'Not checked in' }, others.map((p) => h('option', { value: p.id, selected: String(p.id) === chosen }, p.name))) : null,
    ];
    const pick = (name, optional) => h('select', { name, 'aria-label': name, required: !optional }, options(optional, draft[name] || ''));
    const keep = (e) => {
      if (!e.target.name) return;
      S.pickDraft = { ...draft, [e.target.name]: e.target.value };
      Object.assign(draft, S.pickDraft);
      form.setAttribute('data-dirty', '');
    };
    const form = h('form', {
      class: 'add-result pick-players',
      onchange: keep,
      onsubmit: (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const team = (k) => [fd.get(`${k}1`), fd.get(`${k}2`)].filter(Boolean).map(Number);
        const a = team('a');
        const b = team('b');
        if (a.length !== b.length) { toast('Both sides need the same number of players — 1 each, or 2 each', true); return; }
        act(async () => {
          const { id } = await api('POST', `${gPath(g.slug)}/sessions/${s.id}/games`, { court: Number(fd.get('court')), a, b });
          form.removeAttribute('data-dirty');
          S.pickDraft = null;
          S.pickOpen = false;
          S.route.skip = 0;
          navigate(`/g/${g.slug}/game/${id}`);
        });
      },
    },
    h('div', { class: 'add-result-sides' },
      h('fieldset', {}, h('legend', {}, 'Side 1'), pick('a1', false), pick('a2', true)),
      h('fieldset', {}, h('legend', {}, 'Side 2'), pick('b1', false), pick('b2', true))),
    h('div', { class: 'actions' },
      h('select', { name: 'court', 'aria-label': word }, free.map((c) => h('option', { value: c.no, selected: String(c.no) === (draft.court || '') }, `${word} ${c.no}`))),
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Start game')),
    g.admin && others.length ? h('p', { class: 'muted small', style: 'margin:8px 0 0' }, 'Anyone not checked in yet is checked in when the game starts.') : null);
    return h('details', { class: 'card pick-card', open: Boolean(S.pickOpen), ontoggle: (e) => { S.pickOpen = e.target.open; } },
      h('summary', {}, h('strong', {}, 'Pick players yourself'), h('small', { class: 'muted' }, ' · not the suggested game? choose who plays')),
      form);
  }

  // Admins mark anyone present (or not): everyone in the group, not just
  // those who said they're in — regulars who just turn up, players added by name.
  function whosHereCard(g, s, checkIn) {
    const inSession = new Map(s.players.map((p) => [p.id, p]));
    const people = g.leaderboard.map((r) => ({ id: r.id, name: r.name, guest: r.guest, ...(inSession.get(r.id) || {}) }));
    const here = people.filter((p) => p.checkedIn);
    const said = people.filter((p) => !p.checkedIn && p.status === 'in');
    const rest = people.filter((p) => !p.checkedIn && p.status !== 'in');
    const row = (p, on) => h('li', { 'data-name': p.name.toLowerCase() }, h('span', {}, p.name, p.guest ? h('small', { class: 'muted' }, ' · added by name') : null),
      on ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => checkIn(false, p.id) }, 'Not here')
        : h('button', { class: 'btn btn-small btn-primary', onclick: () => checkIn(true, p.id) }, 'Here'));
    const section = (title, list, on) => (list.length
      ? h('section', { class: 'whos-here-part' }, h('h3', {}, `${title} (${list.length})`), h('ul', { class: 'org-t-list' }, list.map((p) => row(p, on))))
      : null);
    // Filtering in place keeps the keyboard up (a redraw would close it).
    const filter = (box) => {
      const q = (S.whosHereFind || '').trim().toLowerCase();
      box.querySelectorAll('li[data-name]').forEach((li) => { li.hidden = Boolean(q) && !li.dataset.name.includes(q); });
      box.querySelectorAll('.whos-here-part').forEach((sec) => { sec.hidden = !sec.querySelector('li:not([hidden])'); });
    };
    const open = S.whosHereOpen ?? here.length < 4;
    const card = h('details', { class: 'card whos-here', open, ontoggle: (e) => { S.whosHereOpen = e.target.open; } },
      h('summary', {}, h('strong', {}, 'Who\'s here'), h('small', { class: 'muted' }, ` · ${here.length} checked in — mark anyone present`)),
      people.length > 8 ? h('input', { type: 'search', class: 'whos-here-find', placeholder: 'Find a name', 'aria-label': 'Find a name', value: S.whosHereFind || '', oninput: (e) => { S.whosHereFind = e.target.value; filter(card); } }) : null,
      section('Said they\'re in', said, false),
      section('Everyone else', rest, false),
      section('Here', here, true));
    filter(card);
    return card;
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
    // What's been picked and typed so far survives live redraws (S.addResultDraft, by field name).
    const draft = S.addResultDraft && S.addResultDraft.session === s.id ? S.addResultDraft : { session: s.id };
    const pick = (name, optional, value = '') => {
      const chosen = draft[name] ?? value;
      return h('select', { name, 'aria-label': name, required: !optional }, options(optional).map((o) => {
        if (o && o.tagName === 'OPTGROUP') for (const x of o.children) x.defaultSelected = x.selected = x.value === chosen;
        return o;
      }));
    };
    const score = (name, label) => h('input', { name, type: 'number', min: 0, max: 99, required: true, inputmode: 'numeric', placeholder: 'Score', 'aria-label': label, value: draft[name] ?? '' });
    const keep = (e) => {
      if (!e.target.name) return;
      S.addResultDraft = { ...draft, [e.target.name]: e.target.value };
      Object.assign(draft, S.addResultDraft);
      form.setAttribute('data-dirty', ''); // picking players holds back live redraws
    };
    const form = h('form', {
      class: 'add-result',
      onchange: keep,
      oninput: keep,
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
          S.addResultDraft = null;
          await loadGroup(S.route.skip || 0);
        }, 'Result added — the other side confirms it');
      },
    },
    h('div', { class: 'add-result-sides' },
      h('fieldset', {}, h('legend', {}, 'Side 1'), pick('a1', false, me), pick('a2', true), score('sa', 'Side 1 score')),
      h('fieldset', {}, h('legend', {}, 'Side 2'), pick('b1', false), pick('b2', true), score('sb', 'Side 2 score'))),
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
        status,
        x.can ? moreButton(`${teamName(x.a)} v ${teamName(x.b)}`, [
          x.can.dispute && x.status === 'done' ? { label: 'Something\'s wrong', hint: 'Flag it for a group admin', onClick: () => confirm('Flag this result for a group admin?') && post('dispute', 'Flagged for an admin') } : null,
          x.status === 'disputed' && x.can.void ? { label: 'Void game', hint: 'It won\'t count for ratings', danger: true, onClick: () => confirm('Void this game? It won\'t count for ratings.') && post('void', 'Game voided') } : null,
        ]) : null),
      x.can && x.can.confirm ? h('div', { class: 'actions', style: 'margin:6px 0 0' },
        h('button', { class: 'btn btn-small btn-primary', onclick: () => post('confirm', 'Result confirmed') }, x.status === 'disputed' ? 'Keep this result' : `Confirm ${x.summary}`)) : null);
  }

  // ---------- claim your spot

  const groupClaimUrl = (g, r) => `${groupUrl(g, true)}${g.invite ? '&' : '?'}claim=${r.id}`;
  const standingText = (r) => (r.rank ? `#${r.rank} on the leaderboard · ${r.wins} win${r.wins === 1 ? '' : 's'} in ${r.games} game${r.games === 1 ? '' : 's'}` : 'Your name is already on the list');
  const pickClaim = (id) => {
    S.route.claim = id;
    const qs = new URLSearchParams(location.search);
    if (id) qs.set('claim', id); else qs.delete('claim');
    history.replaceState(null, '', `${location.pathname}${qs.toString() ? `?${qs}` : ''}`);
    render();
    window.scrollTo(0, 0);
  };
  // The spot from a claim link (or a name picked): "Is this you?"
  function groupClaimCard(g) {
    if (!S.route.claim) return null;
    const list = g.member ? g.leaderboard.filter((r) => r.guest) : g.guests || [];
    const r = list.find((x) => x.id === S.route.claim);
    if (!r) {
      if (g.member || (g.guests || []).length || !S.route.join) {
        return h('div', { class: 'card claim-card' }, h('h2', {}, 'This spot has been claimed'),
          h('p', { class: 'muted' }, 'Someone has already claimed it. If that was a mistake, ask a group admin.'),
          h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => pickClaim(null) }, 'OK')));
      }
      return null;
    }
    const first = r.name.split(' ')[0];
    const here = `/g/${g.slug}?${S.route.join ? `join=${encodeURIComponent(S.route.join)}&` : ''}claim=${r.id}`;
    const take = () => act(async () => {
      await api('POST', `${gPath(g.slug)}/claim/${r.id}`, { token: S.route.join || undefined });
      S.route.join = null;
      pickClaim(null);
      history.replaceState(null, '', `/g/${g.slug}`);
      await loadGroup();
    }, `Welcome, ${first}! Your games and rating are yours now`);
    return h('div', { class: 'card claim-card' },
      h('p', { class: 'eyebrow' }, 'Your spot is waiting'),
      h('h2', {}, r.name),
      h('p', { class: 'claim-standing' }, standingText(r)),
      h('p', { class: 'muted' }, `${g.name} already has you on the list. Claim it to say you're in, score your games and climb the leaderboard — everything so far comes with you.`),
      !S.me
        ? h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary btn-lg', href: `/signin?next=${encodeURIComponent(here)}` }, `I'm ${first} — claim it`),
          h('button', { class: 'btn btn-ghost', onclick: () => pickClaim(null) }, 'Not me'))
        : h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', onclick: take }, `I'm ${first} — claim it`),
          h('button', { class: 'btn btn-ghost', onclick: () => pickClaim(null) }, 'Not me')),
      !S.me ? h('p', { class: 'muted small' }, 'Sign in with your email — no password needed.') : null);
  }
  // "Already on the list? Find your name." For someone joining, or a member
  // who's new here while names are still unclaimed.
  function groupFindName(g, guests, { dismiss } = {}) {
    if (!guests.length) return null;
    const ranked = guests.filter((r) => r.rank).sort((a, b) => a.rank - b.rank);
    const rest = guests.filter((r) => !r.rank).sort((a, b) => a.name.localeCompare(b.name));
    return h('div', { class: 'card find-name' },
      h('h2', {}, 'Already on the list? Find your name'),
      h('p', { class: 'muted small' }, `${guests.length} player${guests.length === 1 ? ' is' : 's are'} waiting to claim their spot${ranked.length ? ` — ${ranked.length} already on the leaderboard` : ''}.`),
      h('div', { class: 'name-picks' }, [...ranked, ...rest].map((r) => h('button', { class: 'name-pick', onclick: () => pickClaim(r.id) },
        r.rank ? h('span', { class: 'name-pick-rank' }, `#${r.rank}`) : null, r.name))),
      dismiss ? h('p', { class: 'center', style: 'margin:10px 0 0' }, h('button', { class: 'link-btn small', onclick: dismiss }, 'I\'m new here')) : null);
  }
  const findNameKey = (g) => `tonament:new-here:${g.slug}`;
  // A member with no games yet, while spots are unclaimed (once, until "I'm new here").
  function groupFindNameForMember(g) {
    const me = S.me && g.leaderboard.find((r) => r.id === S.me.id);
    if (!me || me.games || me.guest || g.admin) return null; // admins added the names
    try { if (localStorage.getItem(findNameKey(g))) return null; } catch { /* storage unavailable */ }
    return groupFindName(g, g.leaderboard.filter((r) => r.guest), {
      dismiss: () => { try { localStorage.setItem(findNameKey(g), '1'); } catch { /* fine */ } render(); },
    });
  }
  // Admins: add players by name, pasted from the WhatsApp group.
  function groupGuestsCard(g) {
    const form = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        const names = form.querySelector('textarea').value;
        act(async () => {
          const r = await api('POST', `${gPath(g.slug)}/guests`, { names });
          S.group = r.group;
          form.reset();
          toast(r.added ? `${r.added} added${r.skipped ? ` (${r.skipped} already in the group)` : ''} — now share the claim link` : 'They\'re all in the group already');
        });
      },
    },
    h('textarea', { name: 'names', rows: 4, required: true, placeholder: 'Rahul Menon\nPriya S\nArjun K\n…', 'aria-label': 'Names, one per line' }),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add players')));
    return h('details', { class: 'card' }, h('summary', {}, 'Add players by name'),
      h('p', { class: 'muted small' }, 'Paste the names from your WhatsApp group, one per line. They can be checked in, play and climb the leaderboard straight away — and each gets a link to claim their spot (their games and rating come with them).'),
      form);
  }
  function shareText(text) {
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }
  // One person's link: their name and standing, to send them directly.
  const shareClaim = (g, r) => shareText([
    `${r.name.split(' ')[0]}, you're on ${g.name}${r.rank ? ` — #${r.rank} on the leaderboard with ${r.wins} win${r.wins === 1 ? '' : 's'}` : ''} ${sportEmoji(g.sport.id)}`,
    `Claim your spot (your games and rating come with you): ${groupClaimUrl(g, r)}`,
  ].join('\n'));
  // For the whole WhatsApp group: everyone finds their own name.
  const shareFindName = (g, guests) => {
    const ranked = guests.filter((r) => r.rank).sort((a, b) => a.rank - b.rank);
    return shareText([
      `${g.name} is on Tonament ${sportEmoji(g.sport.id)} ${guests.length} of you are already on the list${ranked.length ? ` — ${ranked.slice(0, 3).map((r) => `#${r.rank} ${r.name.split(' ')[0]}`).join(', ')}${ranked.length > 3 ? '…' : ''}` : ''}.`,
      `Find your name and claim your spot: ${groupUrl(g, true)}`,
    ].join('\n'));
  };
  const sportEmoji = (id) => ({ badminton: '🏸', tennis: '🎾', 'table-tennis': '🏓', pickleball: '🏓', padel: '🎾', squash: '🎾', volleyball: '🏐', 'beach-volleyball': '🏐', throwball: '🏐', football: '⚽', futsal: '⚽', hockey: '🏑', basketball: '🏀', snooker: '🎱', pool: '🎱' }[id] || '🏆');

  function groupLeaderboard(g) {
    const rows = g.leaderboard.filter((r) => r.games);
    const fresh = g.leaderboard.filter((r) => !r.games);
    const pairs = g.pairsBoard || [];
    const singles = g.singlesBoard || [];
    const meId = S.me && S.me.id;
    const tabs = [['players', 'Players'], ...(pairs.length ? [['pairs', 'Doubles pairs']] : []), ...(singles.length ? [['singles', 'Singles']] : [])];
    const tab = tabs.some(([k]) => k === S.boardTab) ? S.boardTab : 'players';
    const record = (r) => `${r.wins}–${r.games - r.wins} · ${r.winPct}% wins`;
    const pts = (r) => h('span', { class: 'rank-pts' }, h('strong', {}, r.rating), h('small', {}, r.provisional ? 'new' : 'rating'));
    // Settled ratings come first (the server orders them); "new" ones follow, marked as such.
    const ranks = (list) => list.map((_, i) => i + 1);
    let body;
    if (tab === 'pairs') {
      const no = ranks(pairs);
      body = [
        h('ol', { class: 'rank-list' }, pairs.map((r, i) => h('li', { class: `rank-row${r.ids.includes(meId) ? ' me' : ''}` },
          h('span', { class: 'rank-no' }, no[i]),
          h('span', { class: 'rank-name' }, h('strong', {}, r.names.join(' & ')), h('small', { class: 'muted' }, `${record(r)} · ${r.games} game${r.games === 1 ? '' : 's'} together`)),
          pts(r)))),
        h('p', { class: 'hint', style: 'margin:8px 0 0' }, 'Each pair has its own rating, from the doubles games they\'ve played together: beating stronger pairs counts for more than lots of easy wins. "new" = fewer than 5 games together.'),
      ];
    } else if (tab === 'singles') {
      const no = ranks(singles);
      body = [
        h('ol', { class: 'rank-list' }, singles.map((r, i) => h('li', { class: `rank-row${r.id === meId ? ' me' : ''}` },
          h('span', { class: 'rank-no' }, no[i]),
          h('span', { class: 'rank-name' }, r.handle ? h('a', { href: `/p/${r.handle}` }, r.name) : h('strong', {}, r.name), h('small', { class: 'muted' }, record(r))),
          pts(r)))),
        h('p', { class: 'hint', style: 'margin:8px 0 0' }, 'A singles rating from 1 v 1 games only. "new" = fewer than 5 singles games.'),
      ];
    } else {
      body = [
        rows.length ? h('ol', { class: 'rank-list' }, rows.map((r) => h('li', { class: `rank-row${r.id === meId ? ' me' : ''}` },
          h('span', { class: 'rank-no' }, r.rank),
          h('span', { class: 'rank-name' }, r.handle ? h('a', { href: `/p/${r.handle}` }, r.name) : h('strong', {}, r.name),
            h('small', { class: 'muted' }, `${record(r)}${r.week.games ? ` · this week ${r.week.wins}–${r.week.games - r.week.wins}` : ''}${r.guest ? ' · not claimed yet' : ''}`)),
          pts(r))))
          : empty('No confirmed games yet. Ratings start at 1000 and move after every confirmed game.'),
        h('p', { class: 'hint', style: 'margin:8px 0 0' }, 'Ratings move after every confirmed game, singles and doubles: beat stronger players to climb faster. "new" = fewer than 5 games.'),
      ];
    }
    return [
      h('div', { class: 'card' },
        h('h2', {}, 'Leaderboard'),
        tabs.length > 1 ? h('div', { class: 'board-tabs', role: 'tablist', 'aria-label': 'Leaderboard' }, tabs.map(([k, label]) => h('button', {
          type: 'button', role: 'tab', 'aria-selected': String(k === tab), class: k === tab ? 'on' : '',
          onclick: () => { S.boardTab = k; render(); },
        }, label))) : null,
        body),
      tab === 'players' && fresh.length ? h('p', { class: 'muted small' }, `Yet to play: ${fresh.map((r) => r.name).join(', ')}`) : null,
    ];
  }

  function groupMembers(g) {
    const link = groupUrl(g, true);
    const guests = g.leaderboard.filter((r) => r.guest);
    const shareInvite = () => (guests.length ? shareFindName(g, guests)
      : shareText(`Join ${g.name} on Tonament — RSVP, fair games and live scores:\n${link}`));
    const setMember = (id, action, msg, undoAction) => groupAct(() => api('POST', `${gPath(g.slug)}/members/${id}`, { action }), msg,
      undoAction ? () => api('POST', `${gPath(g.slug)}/members/${id}`, { action: undoAction }) : null);
    return [
      h('div', { class: 'card' },
        h('h2', {}, 'Invite players'),
        h('p', { class: 'muted small' }, guests.length
          ? `Anyone with this link joins straight away — and the ${guests.length} not claimed yet can find their name and claim their spot.`
          : 'Anyone with this link joins straight away. Share it in your WhatsApp group.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-primary', onclick: shareInvite }, 'Share invite link'),
          h('button', { class: 'btn', onclick: () => copy(link, 'Invite link copied') }, 'Copy link'))),
      g.admin ? groupGuestsCard(g) : null,
      g.requests.length ? h('div', { class: 'card' }, h('h2', {}, `Asking to join (${g.requests.length})`),
        h('ul', { class: 'org-t-list' }, g.requests.map((r) => h('li', {},
          h('span', {}, h('strong', {}, r.name), h('small', { class: 'muted' }, ` ${r.email}`)),
          h('span', { class: 'actions', style: 'margin:0' },
            h('button', { class: 'btn btn-small btn-primary', onclick: () => setMember(r.id, 'approve', `${r.name} joined`) }, 'Let in'),
            h('button', { class: 'btn btn-small btn-ghost', onclick: () => setMember(r.id, 'decline', 'Declined') }, 'Decline')))))) : null,
      h('div', { class: 'card' }, h('h2', {}, `Members (${g.members - guests.length})`),
        h('ul', { class: 'org-t-list' }, g.leaderboard.filter((r) => !r.guest).map((r) => h('li', {},
          h('span', {}, r.handle ? h('a', { href: `/p/${r.handle}` }, r.name) : r.name, r.role === 'admin' ? [' ', pill('org', 'Admin')] : null),
          g.admin && r.id !== (S.me && S.me.id) ? moreButton(r.name, [
            r.role === 'admin'
              ? { label: 'Remove admin', hint: 'Stays in the group', onClick: () => setMember(r.id, 'member', `${r.name} is no longer an admin`, 'admin') }
              : { label: 'Make admin', hint: 'Can check people in, start games and change settings', onClick: () => setMember(r.id, 'admin', `${r.name} is now an admin`, 'member') },
            { label: 'Remove from the group', danger: true, onClick: () => confirm(`Remove ${r.name} from the group?`) && setMember(r.id, 'remove', 'Removed') },
          ]) : null)))),
      guests.length ? h('div', { class: 'card' }, h('h2', {}, `Waiting to claim their spot (${guests.length})`),
        h('p', { class: 'muted small' }, g.admin
          ? 'They play and rank like everyone else. Send each their link — it shows their name and where they stand — or share the invite link and they\'ll find their name.'
          : 'On the leaderboard, not on Tonament yet. Know them? Nudge them to claim their spot.'),
        g.admin ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => shareFindName(g, guests) }, 'Share "find your name"')) : null,
        h('ul', { class: 'org-t-list' }, [...guests].sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9) || a.name.localeCompare(b.name)).map((r) => h('li', {},
          h('span', {}, r.name, r.rank ? h('small', { class: 'muted' }, ` #${r.rank}`) : null),
          g.admin ? h('span', { class: 'actions', style: 'margin:0' },
            h('button', { class: 'btn btn-small', onclick: () => shareClaim(g, r) }, 'Send link'),
            moreButton(r.name, [
              { label: 'Copy their link', hint: 'Shows their name and where they stand', onClick: () => copy(groupClaimUrl(g, r), `${r.name}'s claim link copied`) },
              { label: 'Remove from the group', danger: true, onClick: () => confirm(`Remove ${r.name} from the group?`) && setMember(r.id, 'remove', 'Removed') },
            ])) : null)))) : null,
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
    const day = (iso) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: g.settings.timeZone || undefined });
    const last = a.sessions[0];
    const came = a.players.filter((p) => p.marks[last.id] === 'here').map((p) => p.name);
    const copyText = `${g.name} · ${day(last.startsAt)}, ${fmtTime(last.startsAt, g.settings.timeZone)}${a.settings.endTime ? ` – ${fmtClock(a.settings.endTime)}` : ''}: ${came.length} came${came.length ? ` (${came.join(', ')})` : ''}`;
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
      field(CAT.courtWords(g.sport.id), h('input', { name: 'courts', type: 'number', min: 1, max: 12, required: true, value: s.courts })),
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
      op = { ...op, ch: tap.ch, t: Date.now() };
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
        x.score && x.score.taps && x.score.taps.values
          ? periodPad(x.score, { a: teamName(x.a), b: teamName(x.b) }, (extra) => groupTap(g, x, { type: 'rally', ...extra }))
          : x.score && x.score.taps && x.score.taps.max > 1
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
        x.status === 'done' ? h('p', { class: 'muted small' }, `${teamName(x[x.winner === 'a' ? 'b' : 'a'])} confirm the result. It confirms itself at ${fmtTime(x.confirmBy, g.settings && g.settings.timeZone)}.`) : null,
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
    // Teams keep their own name; their players are listed separately.
    if (e.players || people.length > 2 || !people.some((p) => p.handle)) return h('span', { class: 'entry-name' }, e.name);
    return h('span', { class: 'entry-name' }, people.map((p, i) => [i ? ' / ' : null,
      p.handle ? h('a', { class: 'player-link', href: `/p/${p.handle}` }, p.name) : p.name]));
  }

  // Organisers: which players are linked to accounts, and a form to link them.
  // ---------- team rosters and payments per player

  // A team's roster: names, emails (to link them to Tonament) and the
  // captain. Organisers, and the team's captain, edit it here.
  function rosterEditor(t, e, { onDone } = {}) {
    S.rosters = S.rosters || {};
    const r = S.rosters[e.id];
    if (!r) {
      S.rosters[e.id] = 'loading';
      api('GET', `${tPath(t)}/entries/${e.id}/roster`, undefined, t.id)
        .then((x) => { S.rosters[e.id] = x.players.length ? x.players : [{ name: '', email: '', captain: true }]; render(); })
        .catch((err) => { S.rosters[e.id] = null; toast(err.message, true); });
      return loading();
    }
    if (r === 'loading') return loading();
    const list = h('div', { class: 'roster-rows' });
    const row = (p = {}) => h('div', { class: 'roster-row' },
      h('input', { 'data-k': 'name', maxlength: 40, value: p.name || '', placeholder: 'Name', 'aria-label': 'Player name' }),
      h('input', { 'data-k': 'email', type: 'email', maxlength: 120, value: p.email || '', placeholder: 'Email (optional)', 'aria-label': 'Email' }),
      h('label', { class: 'roster-cap', title: 'Captain' }, h('input', { type: 'radio', name: `cap-${e.id}`, checked: Boolean(p.captain) }), h('span', {}, 'Captain')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Remove player', onclick: (ev) => ev.target.closest('.roster-row').remove() }, '✕'));
    for (const p of r) list.append(row(p));
    const close = () => { delete S.rosters[e.id]; S.linking = null; if (onDone) onDone(); render(); };
    const form = h('form', {
      class: 'link-form roster-form',
      onsubmit: (ev) => {
        ev.preventDefault();
        const players = [...list.querySelectorAll('.roster-row')].map((x) => ({
          name: x.querySelector('[data-k=name]').value.trim(), email: x.querySelector('[data-k=email]').value.trim(), captain: x.querySelector('input[type=radio]').checked,
        })).filter((x) => x.name);
        act(async () => { S.t = await api('PUT', `${tPath(t)}/entries/${e.id}/roster`, { players }, t.id); close(); }, 'Team saved');
      },
    },
    list,
    h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => { list.append(row()); list.lastChild.querySelector('input').focus(); } }, '+ Add player'),
    h('p', { class: 'hint', style: 'margin:0' }, 'With an email, the team\'s results go on that player\'s Tonament profile (they get them when they sign up with it).'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-small btn-primary', type: 'submit' }, 'Save team'),
      h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick: close }, 'Cancel')));
    return form;
  }
  // Organisers: the team being edited, full width above the list.
  function teamEditCard(t) {
    if (!t.can.manage || t.event.discipline !== 'team') return null;
    const e = t.entries.find((x) => x.id === S.linking);
    if (!e) return null;
    return h('div', { class: 'card roster-card' }, h('h2', {}, `Team · ${e.name}`), rosterEditor(t, e));
  }
  function teamPeople(t, e) {
    const people = e.people || [];
    if (S.linking === e.id) return h('small', { class: 'contact' }, 'Editing above ↑');
    return [
      people.length ? h('small', { class: 'contact' }, people.map((p) => `${p.name}${p.captain ? ' (C)' : ''}${p.linked ? ' ✓' : p.email ? ' (invited)' : ''}`).join(' · ')) : null,
    ];
  }
  // Organisers: who in a pair or team has paid ("3 of 4 paid").
  function memberFees(t, e) {
    if (!t.can.manage || !t.event.fee || t.event.feeOnline || e.members || e.solo || t.event.discipline === 'singles') return null;
    const people = e.people && e.people.length > 1 ? e.people
      : t.event.discipline === 'doubles' ? e.name.split('/').map((name) => ({ name: name.trim(), feeStatus: null })) : [];
    if (people.length < 2) return null;
    const open = S.memberFees === e.id;
    const settled = people.filter((p) => p.feeStatus).length;
    const each = t.config.feePer === 'player' ? t.event.fee : Math.ceil(t.event.fee / people.length);
    const set = (slot, status, msg) => act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/members/${slot}/fee`, { status }, t.id); }, msg);
    return h('div', { class: 'member-fees' },
      h('button', { class: 'link-btn small', onclick: () => { S.memberFees = open ? null : e.id; render(); } },
        `${settled ? `${settled} of ${people.length} paid` : 'Payments by player'} ${open ? '▴' : '▾'}`),
      open ? h('ul', {}, people.map((p, slot) => h('li', {},
        h('span', {}, p.name, h('small', { class: 'muted' }, ` ${money(each)}`)),
        p.feeStatus
          ? h('span', { class: 'fee-actions' }, pill(p.feeStatus === 'paid' ? 'done' : '', p.feeStatus === 'paid' ? 'Paid' : 'Waived'),
            h('button', { class: 'btn btn-small btn-ghost', onclick: () => set(slot, null, `${p.name}: unmarked`) }, 'Undo'))
          : h('span', { class: 'fee-actions' },
            h('button', { class: 'btn btn-small', onclick: () => set(slot, 'paid', `${p.name} paid`) }, 'Paid'),
            h('button', { class: 'btn btn-small btn-ghost', onclick: () => set(slot, 'waived', `${p.name}: waived`) }, 'Waive'))))) : null);
  }

  function entryPeople(t, e) {
    if (t.event.discipline === 'team') return t.can.manage ? teamPeople(t, e) : null;
    if (!t.can.manage || e.source === 'drawn' || e.solo) return null;
    const people = e.people || [];
    const open = S.linking === e.id;
    const status = people.length
      ? h('small', { class: 'contact' }, people.map((p) => `${p.name}: ${p.linked ? '✓ on Tonament' : p.email ? `invited (${p.email})` : 'not linked'}`).join(' · '))
      : null;
    if (!open) {
      return status;
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
        save(details, { name: fd.get('name'), handle: fd.get('handle'), city: fd.get('city'), region: fd.get('region'), sports: fd.getAll('sports'), bio: fd.get('bio'), ...((p.clubs || []).length && { represents: fd.get('represents') || null }) }, 'Profile saved');
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
    (p.clubs || []).length ? field('I represent', h('select', { name: 'represents' }, h('option', { value: '' }, 'No club'), p.clubs.map((c) => h('option', { value: c.slug, selected: p.represents && p.represents.slug === c.slug }, c.name))), null, 'The club next to your name in race results and meets. Your wins count for it.') : null,
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

  // ---------- clubs: free to make and join; members, a feed, a leaderboard
  const clubPath = (slug) => `/clubs/${encodeURIComponent(slug)}`;
  const clubUrl = (c) => `${location.origin}/club/${c.slug}${c.invite ? `?join=${encodeURIComponent(c.invite)}` : ''}`;
  const KIND_ICON = { club: 'club', team: 'team', academy: 'academy', venue: 'venue', company: 'company', school: 'school', coaching: 'coaching' };

  async function loadClub() {
    const { slug, join } = S.route;
    S.clubLadders = null; // positions move: fetch them fresh
    S.clubGoalsList = null;
    S.clubVersus = null;
    S.clubSeasons = null;
    S.clubRuns = null;
    S.clubHonours = null;
    try {
      S.club = await api('GET', `${clubPath(slug)}${join ? `?join=${encodeURIComponent(join)}` : ''}`);
      S.error = null;
    } catch (e) {
      S.error = e.message;
      S.errorCode = e.code;
    }
    render();
    if (S.club) {
      S.clubFeed = await api('GET', `${clubPath(slug)}/feed`).catch(() => ({ items: [] }));
      if (S.route.name === 'club') render();
    }
  }
  // Joining, roles and the like change the club and its feed.
  const clubAct = (fn, msg) => act(async () => {
    S.club = await fn();
    S.clubFeed = await api('GET', `${clubPath(S.club.slug)}/feed`).catch(() => S.clubFeed);
  }, msg);

  // Clubs: yours, and ones to join.
  function viewClubs() {
    document.title = 'Clubs · Tonament';
    const card = (c) => h('a', { class: 'card club-card', href: `/club/${c.slug}` },
      h('span', { class: 'club-icon' }, icon(KIND_ICON[c.kind] || 'club')),
      h('span', { class: 'club-card-text' }, h('strong', {}, c.name),
        h('small', { class: 'muted' }, [c.kindName, c.city, `${c.members} member${c.members === 1 ? '' : 's'}`, c.status === 'requested' ? 'request sent' : null].filter(Boolean).join(' · '))));
    const mine = S.clubsMine || [];
    const others = (S.clubsFound || []).filter((c) => !mine.some((m) => m.slug === c.slug));
    const main = [
      h('div', { class: 'card-head page-head' }, h('h1', {}, 'Clubs'), h('a', { class: 'btn btn-primary', href: S.me ? '/clubs/new' : '/signin?next=/clubs/new' }, 'Start a club')),
      h('p', { class: 'muted' }, 'Your club, team, academy, company or school on Tonament — free. Members share results, climb the club leaderboard and take on other clubs.'),
      h('p', {}, h('a', { class: 'btn btn-small', href: '/clubs/rankings' }, '🏆 Club rankings')),
      S.me ? h('section', { class: 'section' }, h('h2', {}, 'Your clubs'),
        S.clubsMine == null ? loading() : mine.length ? h('div', { class: 'card-list' }, mine.map(card)) : empty('You\'re not in a club yet — join one below, or start your own.')) : null,
      h('section', { class: 'section' }, h('h2', {}, 'Clubs on Tonament'),
        S.clubsFound == null ? loading() : others.length ? h('div', { class: 'card-list' }, others.map(card)) : empty('No clubs yet — start the first one.')),
    ];
    if (S.railRankings === undefined) { S.railRankings = null; api('GET', '/club-rankings').then((r) => { S.railRankings = r.items; render(); }, () => { S.railRankings = []; }); }
    const top = S.railRankings || [];
    return withRail(main, [
      top.length ? railCard('Club rankings', h('ol', { class: 'rail-list ranked' }, top.slice(0, 5).map((r) => h('li', {}, h('span', { class: 'muted' }, r.place), h('a', { href: `/club/${r.slug}?tab=ladder` }, r.name), h('small', { class: 'muted' }, `${r.points} pts`)))), h('a', { class: 'btn btn-small btn-ghost', href: '/clubs/rankings' }, 'All')) : null,
      railCard('Start a club', [h('p', { class: 'muted small' }, 'Free: members, a feed and a leaderboard — then take on other clubs, run seasons and weekly club runs.'), h('a', { class: 'btn btn-primary btn-small', href: S.me ? '/clubs/new' : '/signin?next=/clubs/new' }, 'Start a club')]),
    ]);
  }

  function viewClub() {
    const c = S.club;
    if (!c || c.slug !== S.route.slug) return loading();
    document.title = `${c.name} · Tonament`;
    const me = c.me;
    const member = me && me.status === 'active';
    const join = () => clubAct(async () => {
      const r = await api('POST', `${clubPath(c.slug)}/join`, { invite: S.route.join });
      if (S.route.join) { history.replaceState(null, '', `/club/${c.slug}`); S.route.join = null; }
      return r;
    }, c.open || c.inviteOk ? `Welcome to ${c.name}!` : 'Request sent to the club\'s admins');
    const follow = () => act(async () => { c.follow = await api('POST', '/follow', { kind: 'club', id: c.id, on: !c.follow.following }); });
    const invite = () => shareSheet({ title: `Invite to ${c.name}`, text: `Join ${c.name} on Tonament — results, the club leaderboard and challenges:`, url: clubUrl(c), image: `/img/club/${c.slug}.png` });
    const tabs = [['feed', 'Feed', 'tab-live'], ['members', 'Members', 'tab-players'], ['leaderboard', 'Leaderboard', 'tab-board'], ['ladder', 'Compete', 'tab-draw'],
      ...(c.can.admin ? [['page', 'Page', 'tab-setup']] : [])];
    const tab = tabs.some(([id]) => id === S.route.tab) ? S.route.tab : 'feed';
    const head = h('header', { class: 'club-head' },
      c.logo ? h('img', { class: 'club-logo', src: c.logo, alt: '' }) : h('span', { class: 'club-icon big' }, icon(KIND_ICON[c.kind] || 'club')),
      h('div', { class: 'club-head-text' },
        h('h1', {}, c.name),
        h('p', { class: 'muted small' }, [c.kindName, c.city, `${c.members} member${c.members === 1 ? '' : 's'}`, c.follow.followers ? `${c.follow.followers} follower${c.follow.followers === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')),
        c.sports.length ? h('p', { class: 'club-sports' }, c.sports.map((x) => h('span', { class: 'event-tag' }, x.name))) : null,
        h('div', { class: 'actions' },
          !S.me ? h('a', { class: 'btn btn-primary', href: `/signin?next=${encodeURIComponent(`/club/${c.slug}${S.route.join ? `?join=${S.route.join}` : ''}`)}` }, 'Sign in to join')
            : member ? [pill('done', me.role === 'player' ? 'Member ✓' : `${me.role[0].toUpperCase()}${me.role.slice(1)} ✓`), h('button', { class: 'btn btn-primary btn-small', onclick: invite }, 'Invite players')]
              : me && me.status === 'requested' ? pill('waiting', 'Request sent')
                : h('button', { class: 'btn btn-primary', onclick: join }, c.open || c.inviteOk ? 'Join the club' : 'Ask to join'),
          S.me && !member ? h('button', { class: `btn btn-small${c.follow.following ? '' : ' btn-ghost'}`, 'aria-pressed': String(c.follow.following), onclick: follow }, c.follow.following ? 'Following ✓' : 'Follow') : null,
          moreButton(c.name, [
            { label: 'Share the club', hint: member ? 'With your invite link' : 'A link to this page', onClick: () => shareSheet({ title: c.name, text: `${c.name} on Tonament`, url: member ? clubUrl(c) : `${location.origin}/club/${c.slug}`, image: `/img/club/${c.slug}.png` }) },
            c.pagePublic ? { label: 'Public page', hint: `tonament.com/@${c.slug}`, onClick: () => { location.href = `/@${c.slug}`; } } : null,
            member ? { label: 'Leave the club', danger: true, onClick: () => confirm(`Leave ${c.name}?`) && act(async () => { await api('POST', `${clubPath(c.slug)}/leave`, {}); await loadClub(); }, `You left ${c.name}`) } : null,
            S.me && !member ? { label: 'Report this club', onClick: () => report('club', c.id) } : null,
          ]))));
    const body = {
      feed: () => [clubRunsCard(c), clubGoals(c), feedList(S.clubFeed, member ? 'Nothing here yet. Results, titles and new members show up here.' : 'Nothing public here yet.')],
      members: () => clubMembers(c),
      leaderboard: () => clubLeaderboard(c),
      ladder: () => [clubHonours(c), clubVersus(c), clubSeasons(c), clubLadders(c)],
      page: () => clubPageCard(c),
    }[tab]();
    return [head,
      h('nav', { class: 'tabs t-tabs bar', 'aria-label': 'Club' }, tabs.map(([id, label, ic]) => h('a', {
        href: `/club/${c.slug}${id === 'feed' ? '' : `?tab=${id}`}`, class: id === tab ? 'active' : '', 'aria-current': id === tab ? 'page' : null,
      }, icon(ic), h('span', {}, label, id === 'members' && c.requests.length ? h('span', { class: 'tab-count' }, c.requests.length) : null)))),
      h('section', {}, body)];
  }

  function clubMembers(c) {
    const set = (id, body, msg) => clubAct(() => api('POST', `${clubPath(c.slug)}/members/${id}`, body), msg);
    const roles = [['player', 'Player'], ['captain', 'Captain'], ['coach', 'Coach'], ['admin', 'Admin']];
    return [
      c.requests.length ? h('div', { class: 'card' }, h('h2', {}, `Asking to join (${c.requests.length})`),
        h('ul', { class: 'org-t-list' }, c.requests.map((p) => h('li', {}, h('strong', {}, p.name),
          h('span', { class: 'actions', style: 'margin:0' },
            h('button', { class: 'btn btn-small btn-primary', onclick: () => set(p.id, { action: 'approve' }, `${p.name} joined`) }, 'Let in'),
            h('button', { class: 'btn btn-small btn-ghost', onclick: () => set(p.id, { action: 'decline' }, 'Declined') }, 'Decline')))))) : null,
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, `Members (${c.members})`),
        c.invite ? h('button', { class: 'btn btn-small', onclick: () => shareText(`Join ${c.name} on Tonament:\n${clubUrl(c)}`) }, 'Invite') : null),
      h('ul', { class: 'org-t-list' }, c.roster.map((p) => h('li', {},
        h('span', {}, p.handle ? h('a', { href: `/p/${p.handle}` }, p.name) : p.name, p.role !== 'player' ? [' ', pill('org', p.roleName)] : null),
        p.id !== (S.me && S.me.id) && S.me ? moreButton(p.name, [
          { label: 'Challenge', hint: 'To a game', onClick: () => navigate(`/challenges/new?to=${p.id}&club=${c.id}`) },
          ...(c.can.admin ? [
          ...roles.filter(([r]) => r !== p.role).map(([r, label]) => ({ label: `Make ${label.toLowerCase()}`, onClick: () => set(p.id, { action: 'role', role: r }, `${p.name} is now ${label.toLowerCase()}`) })),
          { label: 'Remove from the club', danger: true, onClick: () => confirm(`Remove ${p.name} from ${c.name}?`) && set(p.id, { action: 'remove' }, 'Removed') },
          ] : []),
        ]) : null)))),
      c.can.admin ? h('div', { class: 'card' }, h('h2', {}, 'Joining'),
        h('label', { class: 'check-field' },
          h('input', { type: 'checkbox', checked: c.open, onchange: (e) => clubAct(() => api('PATCH', clubPath(c.slug), { open: e.target.checked }), e.target.checked ? 'Anyone can join' : 'New members need your OK') }),
          h('span', {}, h('strong', {}, 'Anyone can join'), h('small', {}, 'Off: people ask, and an admin lets them in. The invite link always works.'))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-small', onclick: () => copy(clubUrl(c), 'Invite link copied') }, 'Copy invite link'),
          h('button', { class: 'btn btn-small btn-ghost', onclick: () => confirm('Make a new invite link? The old one stops working.') && clubAct(() => api('PATCH', clubPath(c.slug), { newInvite: true }), 'New invite link made') }, 'New link'))) : null,
    ];
  }

  // The club's goals on now, above its feed (and, for admins, a way to set one).
  function clubGoals(c) {
    const G = S.clubGoalsList;
    if (!G || G.slug !== c.slug) {
      S.clubGoalsList = { slug: c.slug, list: null };
      api('GET', `${clubPath(c.slug)}/goals`).then((list) => { S.clubGoalsList = { slug: c.slug, list }; render(); }, () => { S.clubGoalsList = { slug: c.slug, list: [] }; });
      return null;
    }
    const list = (G.list || []).filter((g) => !g.ended || g.scope === 'versus');
    if (!list.length && !c.can.admin) return null;
    return h('div', { class: 'club-goals' }, list.map(goalCard),
      c.can.admin ? h('p', {}, h('a', { class: 'btn btn-small', href: `/goals/new?club=${c.slug}` }, '🎯 Set a club goal')) : null);
  }

  // The club's ladders: ranked members, who you can challenge, open challenges.
  function clubLadders(c) {
    const L = S.clubLadders;
    if (!L || L.slug !== c.slug) {
      S.clubLadders = { slug: c.slug, loading: true };
      api('GET', `${clubPath(c.slug)}/ladders`).then((r) => { S.clubLadders = { slug: c.slug, ...r }; render(); }, () => { S.clubLadders = { slug: c.slug, ladders: [] }; render(); });
      return loading();
    }
    if (L.loading) return loading();
    const setL = (r) => { S.clubLadders = { slug: c.slug, ...r }; };
    const start = () => {
      const options = challengeable().filter((x) => !c.sports.length || c.sports.some((y) => y.id === x.id));
      const pick = h('select', { 'aria-label': 'Sport' }, (options.length ? options : challengeable()).map((x) => h('option', { value: x.id }, x.name)));
      const reach = h('select', { 'aria-label': 'Reach' }, [1, 2, 3, 4, 5].map((v) => h('option', { value: v, selected: v === 3 }, `${v} place${v === 1 ? '' : 's'} up`)));
      S.ladderForm = h('form', {
        class: 'card form',
        onsubmit: (e) => { e.preventDefault(); act(async () => { setL(await api('POST', `${clubPath(c.slug)}/ladders`, { sport: pick.value, reach: Number(reach.value) })); S.ladderForm = null; }, 'Ladder started — members can join'); },
      }, h('h2', {}, 'Start a ladder'), field('Sport', pick), field('Members can challenge', reach, null, 'How far up the ladder you can challenge. Win, and you take their place.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Start'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { S.ladderForm = null; render(); } }, 'Cancel')));
      render();
    };
    const challengeOn = (l, r) => {
      const place = prompt(`Challenge ${r.name} (#${r.position})? Where will you play? (optional)`, '');
      if (place === null) return;
      act(async () => { const x = await api('POST', `/ladders/${l.id}/challenge`, { to: r.id, place }); S.challenge = x; navigate(`/c/${x.id}`); }, `Challenge sent to ${r.name} 🔥`);
    };
    const one = (l) => h('div', { class: 'card ladder' },
      h('div', { class: 'card-head' }, h('h2', {}, l.name),
        moreButton(l.name, [
          { label: 'Share the ladder', onClick: () => shareSheet({ title: l.name, text: `${l.name} on Tonament — climb it:`, url: `${location.origin}/club/${c.slug}?tab=ladder`, image: `/img/ladder/${l.id}.png` }) },
          l.me ? { label: 'Leave the ladder', danger: true, onClick: () => confirm('Leave the ladder? Everyone below you moves up.') && act(async () => { setL(await api('POST', `/ladders/${l.id}/leave`)); }, 'You left the ladder') } : null,
        ])),
      h('p', { class: 'muted small', style: 'margin-top:0' }, `${l.sport.name} · challenge up to ${l.reach} place${l.reach === 1 ? '' : 's'} above you. Win and take their place; a challenge unanswered for a week goes to the challenger.`),
      l.rungs.length ? h('ol', { class: 'entries ladder-rungs' }, l.rungs.map((r) => h('li', { class: r.position === l.me ? 'me' : '' },
        h('span', { class: 'seed' }, r.position),
        h('span', { class: 'name' }, r.handle ? h('a', { href: `/p/${r.handle}` }, r.name) : r.name, r.climbed ? [' ', pill('done', '↑ climbed')] : null,
          r.rating ? h('small', { class: 'contact' }, `Rating ${r.rating}`) : null),
        r.canChallenge ? h('button', { class: 'btn btn-small btn-primary', onclick: () => challengeOn(l, r) }, 'Challenge') : null))) : empty('Nobody on it yet — be the first.'),
      !l.me && L.member ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => act(async () => { setL(await api('POST', `/ladders/${l.id}/join`)); }, 'You\'re on the ladder — challenge your way up') }, 'Join the ladder')) : null,
      l.busy ? h('p', { class: 'muted small' }, 'You have a ladder challenge open — finish it to challenge again.') : null,
      l.open.length ? h('div', { class: 'ladder-open' }, h('h3', {}, 'Challenges on now'),
        h('ul', { class: 'org-t-list' }, l.open.map((x) => h('li', {}, h('a', { href: `/c/${x.id}` }, `#${x.a ? x.a.position : '?'} ${x.a ? x.a.name : ''} v #${x.b ? x.b.position : '?'} ${x.b ? x.b.name : ''}`), pill((CH_STATUS[x.status] || [''])[0], (CH_STATUS[x.status] || ['', x.status])[1]))))) : null);
    return [
      L.ladders.map(one),
      !L.ladders.length ? h('div', { class: 'card' }, h('h2', {}, 'Club ladder'),
        h('p', { class: 'muted' }, 'A ladder ranks the club: challenge anyone a few places above you, win and take their place. Every climb goes on the feed.'),
        L.admin ? null : h('p', { class: 'muted small' }, 'A club admin can start one.')) : null,
      L.admin ? (S.ladderForm || h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: start }, L.ladders.length ? 'Start another ladder' : 'Start a ladder'))) : null,
      !L.member && S.me ? h('p', { class: 'muted small' }, 'Join the club to get on its ladder.') : null,
    ];
  }

  // ---------- club v club: a tie (racket sports) or a friendly (team sports)
  const CC_STATUS = { sent: ['waiting', 'Waiting for an answer'], accepted: ['org', 'On'], played: ['done', 'Played'], declined: ['', 'Declined'], cancelled: ['', 'Called off'], expired: ['', 'Expired'] };
  const ccKind = (x) => (x.kind === 'tie' ? 'tie' : 'friendly');

  // The club's record against other clubs, its challenges, and (for admins) a new one.
  function clubVersus(c) {
    const V = S.clubVersus;
    if (!V || V.slug !== c.slug) {
      S.clubVersus = { slug: c.slug, loading: true };
      api('GET', `${clubPath(c.slug)}/club-challenges`).then((r) => { S.clubVersus = { slug: c.slug, ...r }; render(); }, () => { S.clubVersus = { slug: c.slug, items: [], record: { played: 0 }, sports: [] }; render(); });
      return loading();
    }
    if (V.loading) return loading();
    const rec = V.record;
    const row = (x) => h('li', {},
      h('a', { href: `/cc/${x.id}` }, h('strong', {}, `${x.incoming ? '← ' : ''}v ${x.rival.name}`)),
      h('span', { class: 'muted small' }, ` · ${x.sport.name} ${ccKind(x)}${x.playAt ? ` · ${fmtWhen(x.playAt)}` : ''}`),
      x.status === 'played' ? h('span', { class: `pill ${x.won ? 'org' : ''}` }, `${x.won ? 'Won' : x.won === false ? 'Lost' : 'Drew'} ${x.score}`)
        : x.status === 'sent' && x.incoming && V.admin ? pill('org', 'Answer')
          : pill(...(CC_STATUS[x.status] || ['', x.status])));
    const sportsFor = V.sports.length ? V.sports
      : (S.sports || []).filter((x) => x.status === 'live' && (CAT.isTeamSport(x.id) || CAT.hasTies(x.id))).map((x) => ({ id: x.id, name: x.name, kind: CAT.isTeamSport(x.id) ? 'friendly' : 'tie' }));
    const form = () => {
      const d = (S.ccDraft ||= { sport: (sportsFor[0] || {}).id || '', format: '2s1d' });
      const kind = (sportsFor.find((x) => x.id === d.sport) || {}).kind;
      if (S.clubsFound == null) { S.clubsFound = []; api('GET', '/clubs').then((r) => { S.clubsFound = r; render(); }, () => {}); }
      const f = h('form', {
        class: 'card form',
        onsubmit: (e) => {
          e.preventDefault();
          const fd = new FormData(f);
          const when = fd.get('when');
          act(async () => {
            const x = await api('POST', `${clubPath(c.slug)}/club-challenges`, {
              to: fd.get('to'), sport: d.sport, ...(kind === 'tie' && { tie: { format: d.format } }),
              playAt: when ? new Date(when).toISOString() : null, place: fd.get('place') || null, message: fd.get('message') || null,
            });
            S.ccForm = false; S.ccDraft = null; S.clubVersus = null; S.cc = x;
            navigate(`/cc/${x.id}`);
          }, 'Challenge sent — their admins have been told ⚔️');
        },
      },
      h('h2', {}, 'Challenge another club'),
      field('Their club', h('input', { name: 'to', required: true, list: 'cc-clubs', placeholder: 'Club address, e.g. velachery-smashers', autocomplete: 'off', value: d.to || '', oninput: (e) => { d.to = e.target.value; } }), null, 'The address from their club link: tonament.com/club/…'),
      h('datalist', { id: 'cc-clubs' }, (S.clubsFound || []).filter((o) => o.slug !== c.slug).map((o) => h('option', { value: o.slug }, o.name))),
      sportsFor.length ? groupField('Sport', choiceGroup({ name: 'ccSport', label: 'Sport', value: d.sport, options: sportsFor.map((x) => ({ value: x.id, label: x.name, hint: x.kind === 'tie' ? 'Team tie' : 'Friendly' })), onchange: (e) => { d.sport = e.target.value; render(); } }))
        : h('p', { class: 'muted' }, 'Add a racket or team sport to the club first.'),
      kind === 'tie' ? groupField('The tie', choiceGroup({ name: 'ccFormat', label: 'The tie', value: d.format, options: Object.entries(TonamentTie.FORMATS).map(([value, x]) => ({ value, label: x.name, hint: x.hint })), onchange: (e) => { d.format = e.target.value; render(); } }), null, 'Each club picks who plays which match. Line-ups stay sealed until both are in.') : null,
      field('When', h('input', { name: 'when', type: 'datetime-local', value: d.when || '', oninput: (e) => { d.when = e.target.value; } }), null, 'Optional — agree it in the message if you like'),
      field('Where', h('input', { name: 'place', maxlength: 80, placeholder: 'Your courts, theirs, or neutral', value: d.place || '', oninput: (e) => { d.place = e.target.value; } })),
      field('Message', h('textarea', { name: 'message', maxlength: 280, rows: 2, placeholder: 'Fancy a match? Loser buys the chai.', value: d.message || '', oninput: (e) => { d.message = e.target.value; } })),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit', disabled: !d.sport }, 'Send the challenge'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { S.ccForm = false; render(); } }, 'Cancel')));
      return f;
    };
    return h('section', { class: 'section club-versus' },
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Club v club'),
          rec.played ? h('span', { class: 'cc-record' }, h('strong', {}, `${rec.won}–${rec.lost}${rec.drawn ? `–${rec.drawn}` : ''}`), h('small', { class: 'muted' }, rec.drawn ? ' won–lost–drawn' : ' won–lost')) : null),
        V.items.length ? h('ul', { class: 'cc-list' }, V.items.map(row))
          : h('p', { class: 'muted' }, 'Take on another club: a team tie in racket sports, or a friendly in team sports. Results go on both clubs\' records and feeds.'),
        V.admin && !S.ccForm ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => { S.ccForm = true; render(); } }, '⚔️ Challenge a club')) : null),
      V.admin && S.ccForm ? form() : null);
  }

  // ---------- motorsport championships: drivers, rounds, grids, standings
  function viewChamps(embedded = false) {
    if (!embedded) document.title = 'Racing · Tonament';
    const L = S.champs;
    const card = (c) => h('a', { class: 'card goal-card', href: `/champ/${c.id}` },
      h('p', { class: 'eyebrow' }, [c.series || 'Motorsport', c.status === 'done' ? 'Finished' : `Round ${c.done} of ${c.rounds} done`].join(' · ')),
      h('strong', { class: 'goal-title' }, c.name),
      h('small', { class: 'muted' }, `${c.drivers} drivers${c.mine ? ' · you\'re in ✓' : ''}`));
    return [
      h('div', { class: `card-head${embedded ? '' : ' page-head'}` }, embedded ? null : h('h1', {}, 'Racing'), S.me ? h('a', { class: 'btn btn-primary', href: '/champs/new' }, 'Set up a championship') : null),
      h('p', { class: 'muted' }, 'Karting and club racing: qualifying, the grid, results, the fastest lap and the championship standings.'),
      L == null ? loading() : L.length ? h('div', { class: 'card-list' }, L.map(card)) : empty('No championships yet — set one up.'),
    ];
  }

  function viewChampNew() {
    document.title = 'New championship · Tonament';
    const d = (S.champDraft ||= { name: '', series: '', rounds: 'Round 1, ECR Speedway\nRound 2, ECR Speedway\nRound 3, Kari Motor Speedway', club: '' });
    const clubs = (S.goalClubs || []).filter((c) => c.role === 'admin' && c.status === 'active');
    return h('form', {
      class: 'card form new-flow',
      onsubmit: (e) => {
        e.preventDefault();
        const rounds = d.rounds.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [name, place] = l.split(',').map((x) => x.trim()); return { name, place: place || null }; });
        act(async () => { const c = await api('POST', '/champs', { name: d.name, series: d.series || null, rounds, club: d.club || null }); S.champDraft = null; navigate(`/champ/${c.id}`); }, 'Championship set up — add drivers');
      },
    },
    h('h1', {}, 'Set up a championship'),
    field('Name', h('input', { required: true, maxlength: 80, placeholder: 'Chennai Karting Cup', value: d.name, oninput: (e) => { d.name = e.target.value; } })),
    field('Class', h('input', { maxlength: 60, placeholder: 'Rotax Senior', value: d.series, oninput: (e) => { d.series = e.target.value; } })),
    field('Rounds', h('textarea', { rows: 4, required: true, value: d.rounds, oninput: (e) => { d.rounds = e.target.value; } }), null, 'One per line: Name, Track. You can add more later.'),
    clubs.length ? field('Run by', h('select', { onchange: (e) => { d.club = e.target.value; } }, h('option', { value: '' }, 'Just me'), clubs.map((c) => h('option', { value: c.slug, selected: c.slug === d.club }, c.name)))) : null,
    h('p', { class: 'muted small' }, 'Points: 25-18-15-12-10-8-6-4-2-1, plus 1 for the fastest lap in the top 10.'),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Set it up')));
  }

  async function loadChamp() {
    try {
      S.champ = await api('GET', `/champs/${S.route.id}`);
      S.error = null;
    } catch (e) {
      S.error = e.message;
    }
    render();
  }

  function viewChamp() {
    const x = S.champ;
    if (!x || x.id !== S.route.id) return loading();
    document.title = `${x.name} · Racing`;
    const manage = x.can.manage;
    const share = () => shareSheet({ title: x.name, text: x.standings[0] && x.standings[0].points ? `${x.name}: #${x.standings[0].number} ${x.standings[0].name} leads with ${x.standings[0].points} points` : `${x.name} on Tonament`, url: `${location.origin}/champ/${x.id}`, image: `/img/champ/${x.id}.png` });
    const rd = x.rounds.find((r) => r.id === S.route.round);
    const open = (r) => { S.route = { ...S.route, round: r ? r.id : null }; history.replaceState(null, '', `/champ/${x.id}${r ? `?round=${r.id}` : ''}`); render(); window.scrollTo(0, 0); };
    const driverName = (d) => [h('span', { class: 'kart-no' }, d.number), ' ', d.handle ? h('a', { href: `/@${d.handle}` }, d.name) : d.name, d.team ? h('small', { class: 'muted' }, ` · ${d.team}`) : null];
    const head = h('div', { class: 'card challenge-head' },
      h('p', { class: 'eyebrow' }, [x.series || 'Motorsport', `${x.rounds.filter((r) => r.stage === 'done').length} of ${x.rounds.length} rounds`].join(' · ')),
      h('h1', {}, x.name),
      x.club ? h('p', { class: 'muted small' }, x.club.name) : null,
      h('div', { class: 'actions' }, pill(...(x.status === 'done' ? ['done', 'Finished'] : ['org', 'On'])), h('button', { class: 'btn btn-small', onclick: share }, 'Share')));
    if (!rd) {
      const tab = S.champTab || 'drivers';
      return [
        h('p', {}, h('a', { class: 'back-link', href: '/champs' }, '← Racing')), head,
        x.status === 'done' && x.standings[0] ? h('div', { class: 'card cc-result' }, h('p', { class: 'eyebrow' }, 'Champion'),
          h('div', { class: 'cc-score' }, h('strong', {}, ['🏆 ', ...driverName(x.standings[0])]), h('span', { class: 'cc-big' }, `${x.standings[0].points} pts`))) : null,
        h('div', { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', {}, 'Standings'),
            x.teams.length ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Standings' }, [['drivers', 'Drivers'], ['teams', 'Teams']].map(([v, l]) => h('button', { 'aria-pressed': String(tab === v), onclick: () => { S.champTab = v; render(); } }, l))) : null),
          tab === 'teams' && x.teams.length
            ? h('table', { class: 'season-table' }, h('tbody', {}, x.teams.map((t, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, t.team), h('td', { class: 'num' }, `${t.wins} wins`), h('td', { class: 'num' }, h('strong', {}, t.points))))))
            : x.standings.length ? h('table', { class: 'season-table' }, h('thead', {}, h('tr', {}, ['#', 'Driver', 'Wins', 'Pts'].map((c, i) => h('th', { class: i > 1 ? 'num' : '' }, c)))),
              h('tbody', {}, x.standings.map((d, i) => h('tr', { class: d.me ? 'me' : '' }, h('td', {}, i + 1), h('td', {}, driverName(d)), h('td', { class: 'num' }, d.wins), h('td', { class: 'num' }, h('strong', {}, d.points))))))
              : h('p', { class: 'muted' }, 'No drivers yet.')),
        h('div', { class: 'card' }, h('h2', {}, 'Rounds'),
          h('ul', { class: 'cc-list' }, x.rounds.map((r) => h('li', {},
            h('a', { href: `/champ/${x.id}?round=${r.id}`, onclick: (e) => { e.preventDefault(); open(r); } }, h('strong', {}, r.name)),
            h('span', { class: 'muted small' }, `${r.place ? ` · ${r.place}` : ''}${r.winner ? ` · 🏁 ${r.winner}` : ''}`),
            pill(...({ qualifying: ['waiting', 'Qualifying'], race: ['org', 'Race'], done: ['done', 'Done'] }[r.stage]))))),
          manage && x.status !== 'done' ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-small btn-ghost', onclick: () => act(async () => { S.champ = await api('POST', `/champs/${x.id}/rounds`, {}); }, 'Round added') }, '+ Add a round')) : null),
        x.can.join ? (() => {
          const d = (S.champJoin ||= { number: '', team: '' });
          return h('form', { class: 'card form', onsubmit: (e) => { e.preventDefault(); act(async () => { S.champ = await api('POST', `/champs/${x.id}/join`, { number: d.number ? Number(d.number) : null, team: d.team || null }); S.champJoin = null; }, 'You\'re on the entry list 🏎️'); } },
            h('h2', {}, 'Race in it'),
            h('div', { class: 'run-row' }, field('Your number', h('input', { type: 'number', min: 0, max: 999, inputmode: 'numeric', placeholder: 'Any', value: d.number, oninput: (e) => { d.number = e.target.value; } })),
              field('Team', h('input', { maxlength: 60, placeholder: 'Optional', value: d.team, oninput: (e) => { d.team = e.target.value; } }))),
            h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Join')));
        })() : null,
        manage && x.status !== 'done' ? (() => {
          const area = h('textarea', { rows: 3, placeholder: 'One per line: Number, Name, Team (, email)\n7, Arjun R, Speed Demons' });
          return h('div', { class: 'card' }, h('h2', {}, 'Add drivers'), area,
            h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => act(async () => { S.champ = await api('POST', `/champs/${x.id}/drivers`, { drivers: area.value }); }, 'Drivers added') }, 'Add'),
              h('button', { class: 'btn btn-ghost', onclick: () => confirm('Close the championship? The leader is crowned champion.') && act(async () => { S.champ = await api('POST', `/champs/${x.id}/close`); }, 'Champion crowned 🏆') }, 'Close the championship')));
        })() : null,
      ];
    }
    const path = `/champs/${x.id}/rounds/${rd.id}`;
    const post = (what, body, msg) => act(async () => { S.champ = await api('POST', `${path}/${what}`, body || {}); }, msg);
    // Qualifying: a lap time per driver.
    const quali = () => {
      const byDriver = new Map(rd.qualifying.map((q) => [q.driver, q.quali]));
      const f = h('form', { onsubmit: (e) => { e.preventDefault(); post('qualifying', { times: [...f.querySelectorAll('input[data-driver]')].map((el) => ({ driver: Number(el.dataset.driver), time: el.value || null })) }, 'Times saved'); } },
        h('table', { class: 'race-results' }, h('tbody', {}, x.drivers.map((d) => h('tr', {}, h('td', {}, driverName(d)),
          h('td', { class: 'num' }, h('input', { class: 'meet-mark', 'data-driver': d.id, inputmode: 'decimal', placeholder: '48.312', value: byDriver.get(d.id) || '', 'aria-label': `${d.name} best lap` })))))),
        h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save times'), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => post('grid', {}, 'Grid set — lights out!') }, 'Set the grid')));
      return h('div', { class: 'card' }, h('h2', {}, 'Qualifying'), h('p', { class: 'muted small' }, 'Best lap for each driver. No time: back of the grid.'), f);
    };
    const raceSheet = () => {
      const f = h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          const results = rd.grid.map((g) => {
            const v = (k) => f.querySelector(`[data-driver="${g.driver}"][data-k="${k}"]`).value;
            return { driver: g.driver, finish: v('finish') ? Number(v('finish')) : null, laps: v('laps') ? Number(v('laps')) : null, bestLap: v('best') || null, status: v('status') };
          });
          post('race', { results }, 'Race saved');
        },
      },
      h('div', { class: 'table-wrap' }, h('table', { class: 'race-results kart-sheet' },
        h('thead', {}, h('tr', {}, ['Driver', 'Pos', 'Laps', 'Best', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, rd.grid.map((g) => h('tr', {},
          h('td', {}, h('small', { class: 'muted' }, `P${g.grid} `), h('span', { class: 'kart-no' }, g.number), ' ', g.name),
          h('td', {}, h('input', { 'data-driver': g.driver, 'data-k': 'finish', type: 'number', min: 1, inputmode: 'numeric', value: g.finish ?? '', 'aria-label': `${g.name} position`, class: 'kart-pos' })),
          h('td', {}, h('input', { 'data-driver': g.driver, 'data-k': 'laps', type: 'number', min: 0, inputmode: 'numeric', value: g.laps ?? '', 'aria-label': `${g.name} laps`, class: 'kart-pos' })),
          h('td', {}, h('input', { 'data-driver': g.driver, 'data-k': 'best', inputmode: 'decimal', placeholder: '48.1', value: g.bestLap || '', 'aria-label': `${g.name} best lap`, class: 'meet-mark' })),
          h('td', {}, h('select', { 'data-driver': g.driver, 'data-k': 'status', 'aria-label': `${g.name} status`, class: 'meet-status' }, ['ok', 'dnf', 'dns', 'dsq'].map((v) => h('option', { value: v, selected: g.status === v }, v === 'ok' ? '—' : v.toUpperCase()))))))))),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'submit' }, 'Save'), h('button', { class: 'btn btn-primary', type: 'button', onclick: () => confirm('Finish the round? Points are given and the podium is posted.') && post('finish', {}, 'Chequered flag 🏁') }, 'Finish the round')));
      return h('div', { class: 'card' }, h('h2', {}, 'Race'), h('p', { class: 'muted small' }, 'Finishing position, laps and best lap for each driver; DNF drivers are classified by laps.'), f);
    };
    return [
      h('p', {}, h('a', { class: 'back-link', href: `/champ/${x.id}`, onclick: (e) => { e.preventDefault(); open(null); } }, `← ${x.name}`)),
      h('div', { class: 'card challenge-head' }, h('p', { class: 'eyebrow' }, [x.series || 'Motorsport', rd.place].filter(Boolean).join(' · ')), h('h1', {}, rd.name),
        h('div', { class: 'actions' }, pill(...({ qualifying: ['waiting', 'Qualifying'], race: ['org', 'Race'], done: ['done', 'Results'] }[rd.stage])))),
      rd.stage === 'done' ? h('div', { class: 'card' }, h('h2', {}, 'Results'),
        h('table', { class: 'race-results' }, h('thead', {}, h('tr', {}, ['Pos', 'Driver', 'Grid', 'Best lap', 'Pts'].map((c, i) => h('th', { class: i > 1 ? 'num' : '' }, c)))),
          h('tbody', {}, rd.results.map((r) => h('tr', { class: r.me ? 'me' : '' },
            h('td', {}, r.position ? (MEDAL[r.position] && r.status === 'ok' ? MEDAL[r.position] : r.status === 'dnf' ? 'DNF' : r.position) : r.status.toUpperCase()),
            h('td', {}, driverName(r)), h('td', { class: 'num' }, r.grid ? `P${r.grid}` : '—'),
            h('td', { class: 'num' }, r.bestLap || '—', r.fastest ? h('span', { class: 'pill org', style: 'margin-left:4px' }, 'FL') : null),
            h('td', { class: 'num' }, h('strong', {}, r.points)))))),
        manage && x.status !== 'done' ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost btn-small', onclick: () => confirm('Reopen the round? Its points come off until you finish it again.') && post('reopen', {}, 'Reopened') }, 'Reopen to fix it')) : null) : null,
      rd.stage === 'race' && manage ? raceSheet() : null,
      rd.stage !== 'qualifying' && !(rd.stage === 'race' && manage) && rd.stage !== 'done' ? h('div', { class: 'card' }, h('h2', {}, 'Grid'), h('ol', { class: 'entries' }, rd.grid.map((g) => h('li', {}, driverName(g), g.quali ? h('small', { class: 'muted' }, ` · ${g.quali}`) : null)))) : null,
      rd.stage === 'qualifying' && manage ? quali() : null,
      rd.qualifying.length && rd.stage !== 'qualifying' ? h('details', { class: 'card race-runners' }, h('summary', {}, 'Qualifying times'),
        h('ol', { class: 'entries' }, rd.qualifying.map((q) => h('li', {}, driverName(q), h('small', { class: 'muted' }, ` · ${q.quali}`))))) : null,
      rd.stage === 'qualifying' && !manage ? h('p', { class: 'muted' }, 'Qualifying hasn\'t finished yet.') : null,
    ];
  }

  // ---------- track meets: events, heats, finals, results, team points
  const STAGE = { entries: ['waiting', 'Entries'], heats: ['org', 'Heats'], final: ['org', 'Final'], done: ['done', 'Results'] };
  const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

  function viewMeets(embedded = false) {
    if (!embedded) document.title = 'Meets · Tonament';
    const L = S.meets;
    const card = (m) => h('a', { class: 'card goal-card', href: `/meet/${m.id}` },
      h('p', { class: 'eyebrow' }, [m.sport, raceWhen(m.startsAt), m.city].filter(Boolean).join(' · ')),
      h('strong', { class: 'goal-title' }, m.name),
      h('small', { class: 'muted' }, `${m.events} events · ${m.entries} entries${m.mine ? ' · you\'re in ✓' : ''}${m.status === 'done' ? ' · results' : m.status === 'on' ? ' · on now' : ''}`));
    return [
      h('div', { class: `card-head${embedded ? '' : ' page-head'}` }, embedded ? null : h('h1', {}, 'Meets'), S.me ? h('a', { class: 'btn btn-primary', href: '/meets/new' }, 'Set up a meet') : null),
      h('p', { class: 'muted' }, 'Athletics, swimming and track cycling: heats, finals, personal bests and team points.'),
      L == null ? loading() : [
        L.upcoming.length ? h('section', { class: 'section' }, h('h2', {}, 'Coming up and on'), h('div', { class: 'card-list' }, L.upcoming.map(card))) : empty('No meets yet — set one up.'),
        L.past.length ? h('section', { class: 'section' }, h('h2', {}, 'Results'), h('div', { class: 'card-list' }, L.past.map(card))) : null,
      ],
    ];
  }

  function viewMeetNew() {
    document.title = 'New meet · Tonament';
    const cat = S.meetCatalogue;
    if (!cat) return loading();
    const d = (S.meetDraft ||= { sport: 'athletics', name: '', when: '', place: '', city: '', lanes: 8, picked: ['100m', '200m', 'Long jump'], genders: ['m', 'f'], club: '' });
    const sport = cat.find((x) => x.id === d.sport);
    const clubs = (S.goalClubs || []).filter((c) => c.role === 'admin' && c.status === 'active');
    const form = h('form', {
      class: 'card form new-flow',
      onsubmit: (e) => {
        e.preventDefault();
        const events = d.picked.flatMap((name) => d.genders.map((gender) => ({ name, gender })));
        act(async () => {
          const m = await api('POST', '/meets', { sport: d.sport, name: d.name, startsAt: new Date(`${d.when}:00+05:30`).toISOString(), place: d.place, city: d.city || null, lanes: Number(d.lanes), events, club: d.club || null });
          S.meetDraft = null;
          navigate(`/meet/${m.id}`);
        }, 'Meet set up — add athletes to each event');
      },
    },
    h('h1', {}, 'Set up a meet'),
    groupField('Sport', choiceGroup({ name: 'meetSport', label: 'Sport', value: d.sport, options: cat.map((x) => ({ value: x.id, label: x.name })), onchange: (e) => { d.sport = e.target.value; d.picked = []; render(); } })),
    field('Name', h('input', { required: true, maxlength: 80, placeholder: 'Chennai Open', value: d.name, oninput: (e) => { d.name = e.target.value; } })),
    field('Start (India time)', h('input', { type: 'datetime-local', required: true, value: d.when, oninput: (e) => { d.when = e.target.value; } })),
    field('Venue', h('input', { required: true, maxlength: 80, placeholder: 'Nehru Stadium', value: d.place, oninput: (e) => { d.place = e.target.value; } })),
    field('City', h('input', { maxlength: 60, placeholder: 'Chennai', value: d.city, oninput: (e) => { d.city = e.target.value; } })),
    groupField('Events', choiceGroup({ name: 'meetEvents', label: 'Events', multiple: true, value: d.picked, options: sport.events.map((x) => ({ value: x.name, label: x.name })), onchange: (e) => { const v = e.target.value; d.picked = e.target.checked ? [...d.picked, v] : d.picked.filter((y) => y !== v); } })),
    groupField('For', choiceGroup({ name: 'meetGenders', label: 'For', multiple: true, value: d.genders, options: [{ value: 'm', label: 'Men' }, { value: 'f', label: 'Women' }, { value: 'x', label: 'Open' }], onchange: (e) => { const v = e.target.value; d.genders = e.target.checked ? [...d.genders, v] : d.genders.filter((y) => y !== v); } }), null, 'Each event is held for each of these.'),
    groupField(d.sport === 'swimming' ? 'Lanes in the pool' : 'Lanes', choiceGroup({ name: 'meetLanes', label: 'Lanes', value: d.lanes, options: [4, 5, 6, 8, 10].map((n) => ({ value: n, label: String(n) })), onchange: (e) => { d.lanes = Number(e.target.value); } }), null, 'Timed events with more entries than lanes run heats; the best heat marks make the final.'),
    clubs.length ? field('Put on by', h('select', { onchange: (e) => { d.club = e.target.value; } }, h('option', { value: '' }, 'Just me'), clubs.map((c) => h('option', { value: c.slug, selected: c.slug === d.club }, c.name)))) : null,
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Set it up')));
    return form;
  }

  async function loadMeet() {
    try {
      S.meet = await api('GET', `/meets/${S.route.id}`);
      S.error = null;
    } catch (e) {
      S.error = e.message;
    }
    render();
  }
  setInterval(() => {
    if (S.route.name === 'meet' && S.meet && S.meet.status === 'on' && !document.hidden && !isEditing() && !(S.meet.can && S.meet.can.manage)) loadMeet();
  }, 10000);

  function viewMeet() {
    const x = S.meet;
    if (!x || x.id !== S.route.id) return loading();
    document.title = `${x.name} · ${x.sport.name}`;
    const share = () => shareSheet({ title: x.name, text: x.teams.length ? `${x.name} — ${x.teams[0].team} lead with ${x.teams[0].points} points:` : `${x.name}, ${raceWhen(x.startsAt)}:`, url: `${location.origin}/meet/${x.id}`, image: `/img/meet/${x.id}.png` });
    const ev = x.events.find((e) => e.id === S.route.event);
    const evPath = (e) => `/meets/${x.id}/events/${e.id}`;
    const open = (e) => { S.route = { ...S.route, event: e ? e.id : null }; history.replaceState(null, '', `/meet/${x.id}${e ? `?event=${e.id}` : ''}`); render(); window.scrollTo(0, 0); };
    const head = h('div', { class: 'card challenge-head' },
      h('p', { class: 'eyebrow' }, [x.sport.name, raceWhen(x.startsAt)].join(' · ')),
      h('h1', {}, x.name),
      h('p', { class: 'muted small' }, [[x.place, x.city].filter(Boolean).join(', '), x.club ? x.club.name : null, `${x.lanes} lanes`].filter(Boolean).join(' · ')),
      h('div', { class: 'actions' }, pill(...({ open: ['waiting', 'Entries open'], on: ['org', 'On now'], done: ['done', 'Finished'] }[x.status])), h('button', { class: 'btn btn-small', onclick: share }, 'Share')));
    const teams = () => (x.teams.length ? h('div', { class: 'card' }, h('h2', {}, x.status === 'done' ? 'Team points — final' : 'Team points'),
      h('table', { class: 'season-table' }, h('thead', {}, h('tr', {}, ['#', 'Team', '🥇', '🥈', '🥉', 'Pts'].map((c, i) => h('th', { class: i > 1 ? 'num' : '' }, c)))),
        h('tbody', {}, x.teams.map((t, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, t.team), h('td', { class: 'num' }, t.gold), h('td', { class: 'num' }, t.silver), h('td', { class: 'num' }, t.bronze), h('td', { class: 'num' }, h('strong', {}, t.points)))))),
      h('p', { class: 'muted small' }, `Points for places 1–${x.points.length}: ${x.points.join('-')}.`)) : null);
    if (!ev) {
      return [
        h('p', {}, h('a', { class: 'back-link', href: '/meets' }, '← Meets')), head, teams(),
        h('div', { class: 'card' }, h('h2', {}, 'Events'),
          h('ul', { class: 'cc-list' }, x.events.map((e) => h('li', {},
            h('a', { href: `/meet/${x.id}?event=${e.id}`, onclick: (evt) => { evt.preventDefault(); open(e); } }, h('strong', {}, `${e.genderName === 'Open' ? '' : `${e.genderName}'s `}${e.name}`)),
            h('span', { class: 'muted small' }, ` · ${e.entries} in${e.mine ? ' · you ✓' : ''}${e.results[0] ? ` · ${MEDAL[1]} ${e.results[0].name} ${e.results[0].mark}` : ''}`),
            pill(...STAGE[e.stage]))))),
      ];
    }
    const manage = x.can.manage;
    const post = (what, body, msg) => act(async () => { S.meet = await api('POST', `${evPath(ev)}/${what}`, body || {}); }, msg);
    const markLabel = ev.kind === 'time' ? 'Time' : 'Metres';
    // A start list (a heat, or the final) with marks: inputs for the organisers.
    const sheet = (title, list, round) => {
      const editing = manage && ((round === 'heats' && ev.stage === 'heats') || (round === 'final' && ev.stage === 'final'));
      const rows = list.map((a) => {
        const lane = round === 'heats' ? a.heatLane : a.lane;
        const mark = round === 'heats' ? a.heatMark : a.mark;
        const inp = editing ? h('input', { class: 'meet-mark', 'data-entry': a.id, inputmode: 'decimal', placeholder: ev.kind === 'time' ? '10.85' : '6.45', value: (mark || '').replace(' m', ''), 'aria-label': `${a.name} ${markLabel}` }) : null;
        const st = editing ? h('select', { class: 'meet-status', 'data-entry': a.id, 'aria-label': `${a.name} status` }, ['ok', 'dns', 'dnf', 'dq'].map((v) => h('option', { value: v, selected: a.status === v }, v === 'ok' ? '—' : v.toUpperCase()))) : null;
        return h('tr', { class: a.me ? 'me' : '' },
          h('td', { class: 'num' }, lane || ''),
          h('td', {}, a.handle ? h('a', { href: `/@${a.handle}` }, a.name) : a.name, a.team ? h('small', { class: 'muted' }, ` · ${a.team}`) : null),
          h('td', { class: 'num' }, editing ? [inp, st] : a.status !== 'ok' ? a.status.toUpperCase() : mark || '—'));
      });
      const f = h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          const results = [...f.querySelectorAll('.meet-mark')].map((el) => ({ entry: Number(el.dataset.entry), mark: el.value || null, status: f.querySelector(`.meet-status[data-entry="${el.dataset.entry}"]`).value }));
          post('marks', { results }, 'Marks saved');
        },
      },
      h('table', { class: 'race-results meet-sheet' }, h('thead', {}, h('tr', {}, h('th', { class: 'num' }, ev.kind === 'time' ? 'Lane' : 'Order'), h('th', {}, 'Athlete'), h('th', { class: 'num' }, markLabel))), h('tbody', {}, rows)),
      editing ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save marks')) : null);
      return h('div', { class: 'card' }, h('h3', {}, title), f);
    };
    const enterBox = () => {
      if (!x.can.enter || ev.stage !== 'entries' || ev.mine) return null;
      const d = (S.meetEnter ||= { club: (x.myClubs.find((c) => c.rep) || {}).slug || '' });
      return h('div', { class: 'card' }, h('h2', {}, 'Enter this event'),
        x.myClubs.length ? field('For', h('select', { onchange: (e) => { d.club = e.target.value; } }, h('option', { value: '' }, 'No team'), x.myClubs.map((c) => h('option', { value: c.slug, selected: c.slug === d.club }, c.name)))) : null,
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => act(async () => { S.meet = await api('POST', `/meets/${x.id}/enter`, { event: ev.id, club: d.club || null }); }, 'You\'re in') }, 'Enter')));
    };
    const addBox = () => {
      if (!manage || ev.stage !== 'entries') return null;
      const area = h('textarea', { rows: 4, placeholder: 'One per line: Name, Team (, email to link their account)\nRavi K, Anna Nagar AC\nBala M, Velachery TC' });
      return h('div', { class: 'card' }, h('h2', {}, 'Add athletes'),
        area,
        h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => act(async () => { S.meet = await api('POST', `/meets/${x.id}/athletes`, { event: ev.id, athletes: area.value }); }, 'Added') }, 'Add'),
          h('button', { class: 'btn btn-primary', disabled: !ev.entries, onclick: () => post('start', {}, ev.kind === 'time' && ev.entries > x.lanes ? 'Heats drawn' : 'Start list out') }, ev.kind === 'time' && ev.entries > x.lanes ? `Draw ${Math.ceil(ev.entries / x.lanes)} heats` : 'Start the event')));
    };
    const finalists = ev.athletes.filter((a) => a.inFinal).sort((a, b) => a.lane - b.lane);
    return [
      h('p', {}, h('a', { class: 'back-link', href: `/meet/${x.id}`, onclick: (e) => { e.preventDefault(); open(null); } }, `← ${x.name}`)),
      h('div', { class: 'card challenge-head' },
        h('p', { class: 'eyebrow' }, [x.sport.name, ev.kind === 'time' ? 'Timed' : ev.kind === 'height' ? 'Height' : 'Distance'].join(' · ')),
        h('h1', {}, `${ev.genderName === 'Open' ? '' : `${ev.genderName}'s `}${ev.name}`),
        h('div', { class: 'actions' }, pill(...STAGE[ev.stage]), h('span', { class: 'muted small' }, `${ev.entries} athletes`))),
      ev.stage === 'done' ? h('div', { class: 'card' }, h('h2', {}, 'Results'),
        h('table', { class: 'race-results' }, h('tbody', {}, ev.results.map((a) => h('tr', { class: a.me ? 'me' : '' },
          h('td', {}, MEDAL[a.place] || a.place),
          h('td', {}, a.handle ? h('a', { href: `/@${a.handle}` }, a.name) : a.name, a.team ? h('small', { class: 'muted' }, ` · ${a.team}`) : null, a.pb ? h('span', { class: 'pill org', style: 'margin-left:6px' }, 'PB') : null),
          h('td', { class: 'num' }, h('strong', {}, a.mark)))))),
        manage ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost btn-small', onclick: () => confirm('Reopen this event to fix a mark? Its places and points come off until you finish it again.') && post('reopen', {}, 'Reopened') }, 'Reopen to fix a mark')) : null) : null,
      ev.stage === 'final' ? [sheet(ev.kind === 'time' ? 'Final' : 'Start list', finalists, 'final'),
        manage ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', onclick: () => confirm('Finish the event? Places and team points are given, and athletes are told.') && post('finish', {}, 'Results are in 🏁') }, 'Finish the event')) : null] : null,
      ev.heats.length ? [
        ev.stage === 'heats' && manage ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => confirm(`Make the final? The ${x.lanes} best heat marks go through.`) && post('final', {}, 'Final drawn') }, 'Make the final')) : null,
        ev.heats.map((n) => sheet(`Heat ${n}`, ev.athletes.filter((a) => a.heat === n).sort((a, b) => a.heatLane - b.heatLane), 'heats')),
      ] : null,
      ev.stage === 'entries' ? [enterBox(), addBox(),
        h('div', { class: 'card' }, h('h2', {}, 'Entered'), ev.athletes.length ? h('ul', { class: 'cc-list' }, ev.athletes.map((a) => h('li', {}, h('span', {}, a.name), a.team ? h('small', { class: 'muted' }, ` · ${a.team}`) : null,
          manage || a.me ? h('button', { class: 'link-btn small', style: 'margin-left:auto', onclick: () => act(async () => { S.meet = await api('DELETE', `/meets/${x.id}/entries/${a.id}`); }) }, 'Remove') : null))) : h('p', { class: 'muted' }, 'No one yet.'))] : null,
    ];
  }

  // ---------- races: distances, bibs, times by bib, results
  const raceWhen = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

  function viewRaces(embedded = false) {
    if (!embedded) document.title = 'Races · Tonament';
    const L = S.races;
    const card = (r) => h('a', { class: 'card goal-card', href: `/race/${r.id}` },
      h('p', { class: 'eyebrow' }, [raceWhen(r.startsAt), r.city].filter(Boolean).join(' · ')),
      h('strong', { class: 'goal-title' }, r.name),
      h('small', { class: 'muted' }, `${r.distances} · ${r.entries} in${r.mine ? ' · you\'re in ✓' : ''}${r.organiser ? ' · yours' : ''}${r.status === 'done' ? ' · results out' : ''}`));
    return [
      h('div', { class: `card-head${embedded ? '' : ' page-head'}` }, embedded ? null : h('h1', {}, 'Races'), S.me ? h('a', { class: 'btn btn-primary', href: '/races/new' }, 'Set up a race') : null),
      h('p', { class: 'muted' }, 'Enter, get your bib, and see where you finished — overall, by gender and by age group. Your time goes straight onto your runs.'),
      L == null ? loading() : [
        L.upcoming.length ? h('section', { class: 'section' }, h('h2', {}, 'Coming up'), h('div', { class: 'card-list' }, L.upcoming.map(card))) : empty('No races coming up yet — set one up.'),
        L.past.length ? h('section', { class: 'section' }, h('h2', {}, 'Results'), h('div', { class: 'card-list' }, L.past.map(card))) : null,
      ],
    ];
  }

  function viewRaceNew() {
    document.title = 'New race · Tonament';
    const d = (S.raceDraft ||= { name: '', when: '', place: '', city: '', distances: ['5k', '10k'], custom: '', club: '' });
    const clubs = (S.goalClubs || []).filter((c) => c.role === 'admin' && c.status === 'active');
    const form = h('form', {
      class: 'card form new-flow',
      onsubmit: (e) => {
        e.preventDefault();
        const distances = [...d.distances, ...(d.custom ? d.custom.split(/[,\s]+/).filter(Boolean).map(Number) : [])];
        act(async () => {
          const r = await api('POST', '/races', { name: d.name, startsAt: new Date(`${d.when}:00+05:30`).toISOString(), place: d.place, city: d.city || null, distances, club: d.club || null });
          S.raceDraft = null;
          navigate(`/race/${r.id}`);
        }, 'Race set up — share it so runners enter');
      },
    },
    h('h1', {}, 'Set up a race'),
    field('Name', h('input', { required: true, maxlength: 80, placeholder: 'Chennai Night Run', value: d.name, oninput: (e) => { d.name = e.target.value; } })),
    field('Start (India time)', h('input', { type: 'datetime-local', required: true, value: d.when, oninput: (e) => { d.when = e.target.value; } })),
    field('Start line', h('input', { required: true, maxlength: 80, placeholder: 'Island Grounds', value: d.place, oninput: (e) => { d.place = e.target.value; } })),
    field('City', h('input', { maxlength: 60, placeholder: 'Chennai', value: d.city, oninput: (e) => { d.city = e.target.value; } })),
    groupField('Distances', choiceGroup({ name: 'raceDist', label: 'Distances', multiple: true, value: d.distances, options: [['5k', '5K'], ['10k', '10K'], ['half', 'Half marathon'], ['full', 'Marathon']].map(([value, label]) => ({ value, label })),
      onchange: (e) => { const v = e.target.value; d.distances = e.target.checked ? [...d.distances, v] : d.distances.filter((x) => x !== v); } })),
    field('Other distances (km)', h('input', { maxlength: 40, placeholder: 'e.g. 3, 15', value: d.custom, oninput: (e) => { d.custom = e.target.value; } })),
    clubs.length ? field('Put on by', h('select', { onchange: (e) => { d.club = e.target.value; } }, h('option', { value: '' }, 'Just me'), clubs.map((c) => h('option', { value: c.slug, selected: c.slug === d.club }, c.name))), null, 'Its admins can run the race with you, and it goes on the club\'s feed.') : null,
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Set it up')));
    return form;
  }

  async function loadRace() {
    try {
      S.race = await api('GET', `/races/${S.route.id}`);
      S.error = null;
    } catch (e) {
      S.error = e.message;
    }
    render();
  }

  function viewRace() {
    const x = S.race;
    if (!x || x.id !== S.route.id) return loading();
    document.title = `${x.name} · Race`;
    const post = (what, body, msg) => act(async () => { S.race = await api('POST', `/races/${x.id}/${what}`, body || {}); }, msg);
    const share = () => shareSheet({ title: x.name, text: x.status === 'done' ? `${x.name} — results:` : `${x.name}, ${raceWhen(x.startsAt)} — enter on Tonament:`, url: `${location.origin}/race/${x.id}`, image: `/img/race/${x.id}.png` });
    const tab = S.raceTab && x.events.some((e) => e.id === S.raceTab.ev) ? S.raceTab : { ev: (x.events.find((e) => e.finishers.length) || x.events[0]).id, filter: 'all' };
    const ev = x.events.find((e) => e.id === tab.ev);
    const enterForm = () => {
      const d = (S.raceEnter ||= { event: x.events[0].id, gender: '', birthYear: '' });
      return h('form', {
        class: 'card form',
        onsubmit: (e) => { e.preventDefault(); post('enter', { event: Number(d.event), gender: d.gender || 'x', birthYear: d.birthYear ? Number(d.birthYear) : null }, 'You\'re in — here\'s your bib 🏃'); S.raceEnter = null; },
      },
      h('h2', {}, 'Enter'),
      groupField('Distance', choiceGroup({ name: 'raceEv', label: 'Distance', value: d.event, options: x.events.map((e) => ({ value: e.id, label: e.name })), onchange: (e) => { d.event = Number(e.target.value); } })),
      groupField('Category', choiceGroup({ name: 'raceG', label: 'Category', value: d.gender, options: [{ value: 'f', label: 'Women' }, { value: 'm', label: 'Men' }, { value: 'x', label: 'Open' }], onchange: (e) => { d.gender = e.target.value; } })),
      field('Year of birth', h('input', { type: 'number', min: 1920, max: new Date().getFullYear() - 5, inputmode: 'numeric', placeholder: '1990', value: d.birthYear, oninput: (e) => { d.birthYear = e.target.value; } }), null, 'For your age group'),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Enter the race')));
    };
    // The organisers' timing desk: bib and time, Enter, next.
    const desk = () => {
      const bib = h('input', { type: 'number', min: 1, required: true, inputmode: 'numeric', placeholder: 'Bib', 'aria-label': 'Bib', class: 'race-bib-in' });
      const time = h('input', { required: true, placeholder: '41:12', inputmode: 'numeric', 'aria-label': 'Finish time' });
      const f = h('form', {
        class: 'race-desk',
        onsubmit: (e) => {
          e.preventDefault();
          act(async () => {
            const r = await api('POST', `/races/${x.id}/result`, { bib: Number(bib.value), time: time.value });
            S.race = r.race; S.raceLast = r.saved;
            setTimeout(() => { const el = document.querySelector('.race-bib-in'); if (el) el.focus(); }, 0);
          });
        },
      }, bib, time, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'));
      const add = S.raceAdd;
      return h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Timing'), h('span', { class: 'muted small' }, `${x.events.reduce((n, e) => n + e.finishers.length, 0)} of ${x.entries} in`)),
        f,
        S.raceLast ? h('p', { class: 'small' }, `✓ #${S.raceLast.bib} ${S.raceLast.name} — ${S.raceLast.dnf ? 'DNF' : S.raceLast.time || 'cleared'}`) : h('p', { class: 'muted small' }, 'Type the bib and the time as each runner finishes; Enter saves it.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-small', onclick: () => { S.raceAdd = add ? null : { name: '', event: x.events[0].id, gender: 'x', birthYear: '' }; render(); } }, add ? 'Close' : '+ Add a runner'),
          h('button', { class: 'btn btn-small btn-ghost', onclick: () => { const b = prompt('Bib that didn\'t finish (DNF)?'); if (b) act(async () => { const r = await api('POST', `/races/${x.id}/result`, { bib: Number(b), dnf: true }); S.race = r.race; S.raceLast = r.saved; }); } }, 'Mark a DNF'),
          x.status === 'open' ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => post('status', { status: 'closed' }, 'Entries closed') }, 'Close entries') : x.status === 'closed' ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => post('status', { status: 'open' }, 'Entries open') }, 'Reopen entries') : null),
        add ? h('form', {
          class: 'form', style: 'margin-top:12px',
          onsubmit: (e) => { e.preventDefault(); post('runners', { ...add, event: Number(add.event), birthYear: add.birthYear ? Number(add.birthYear) : null }, `${add.name} added`); S.raceAdd = { ...add, name: '', birthYear: '' }; },
        },
        field('Name', h('input', { required: true, maxlength: 60, value: add.name, oninput: (e) => { add.name = e.target.value; } })),
        field('Club', h('input', { maxlength: 60, placeholder: 'Optional', value: add.team || '', oninput: (e) => { add.team = e.target.value; } })),
        groupField('Distance', choiceGroup({ name: 'raceAddEv', label: 'Distance', value: add.event, options: x.events.map((e) => ({ value: e.id, label: e.name })), onchange: (e) => { add.event = Number(e.target.value); } })),
        groupField('Category', choiceGroup({ name: 'raceAddG', label: 'Category', value: add.gender, options: [{ value: 'f', label: 'Women' }, { value: 'm', label: 'Men' }, { value: 'x', label: 'Open' }], onchange: (e) => { add.gender = e.target.value; } })),
        field('Year of birth', h('input', { type: 'number', inputmode: 'numeric', value: add.birthYear, oninput: (e) => { add.birthYear = e.target.value; } })),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add — next bib'))) : null,
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => confirm(x.status === 'done' ? 'Publish again with the latest times?' : 'Publish the results? Runners are told, and their times go on their runs.') && post('publish', {}, 'Results are out 🏁') }, x.status === 'done' ? 'Results are out ✓' : 'Publish results')),
        x.runners.length ? h('details', { class: 'race-runners' }, h('summary', {}, `All runners (${x.runners.length})`),
          h('table', {}, h('tbody', {}, x.runners.map((r) => h('tr', {}, h('td', { class: 'num' }, `#${r.bib}`), h('td', {}, r.name), h('td', { class: 'muted' }, r.event), h('td', { class: 'num' }, r.status === 'dnf' ? 'DNF' : r.time || '—')))))) : null);
    };
    const filtered = ev ? ev.finishers.filter((f) => tab.filter === 'all' || (tab.filter === 'm' || tab.filter === 'f' ? f.gender === tab.filter : f.ageGroup === tab.filter)) : [];
    const groups = ev ? [...new Set(ev.finishers.map((f) => f.ageGroup).filter(Boolean))].sort((a, b) => x.ageGroups.indexOf(a) - x.ageGroups.indexOf(b)) : [];
    const setTab = (t) => { S.raceTab = { ...tab, ...t }; render(); };
    const r = x.me && x.me.result;
    return [
      h('p', {}, h('a', { class: 'back-link', href: '/races' }, '← Races')),
      h('div', { class: 'card challenge-head' },
        h('p', { class: 'eyebrow' }, ['Race', x.events.map((e) => e.name).join(' · ')].join(' · ')),
        h('h1', {}, x.name),
        h('p', { class: 'muted small' }, [raceWhen(x.startsAt), [x.place, x.city].filter(Boolean).join(', '), x.club ? x.club.name : null].filter(Boolean).join(' · ')),
        h('div', { class: 'actions' }, pill(...({ open: ['org', `${x.entries} in · entries open`], closed: ['waiting', `${x.entries} in · entries closed`], done: ['done', 'Results out'] }[x.status])), h('button', { class: 'btn btn-small', onclick: share }, 'Share'))),
      // Organisers: the timing desk first.
      x.can.manage ? desk() : null,
      r ? h('div', { class: 'card cc-result' },
        h('p', { class: 'eyebrow' }, `Your ${r.event}`),
        h('div', { class: 'cc-score' }, h('strong', {}, `${ordinal(r.place)} of ${r.of}`), h('span', { class: 'cc-big' }, r.time)),
        h('p', { class: 'muted small' }, [`${r.pace} /km`, r.genderName !== 'Open' ? `${ordinal(r.genderPlace)} of the ${r.genderName.toLowerCase()}` : null, r.groupPlace ? `${ordinal(r.groupPlace)} in ${r.ageGroup}` : null].filter(Boolean).join(' · ')),
        r.post ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => shareSheet({ title: x.name, text: `${r.time} at ${x.name} (${r.event}) — ${ordinal(r.place)} of ${r.of} 🏁`, url: `${location.origin}/a/${r.post.id}`, image: r.post.public ? `/img/a/${r.post.id}.png` : null }) }, 'Share my result')) : null)
        : x.me ? h('div', { class: 'card race-bib' }, h('p', { class: 'eyebrow' }, `You're in · ${x.me.event}`), h('div', { class: 'race-bib-no' }, `#${x.me.bib}`), h('p', { class: 'muted small' }, 'Your bib number. See you at the start.'),
          x.can.withdraw ? h('button', { class: 'link-btn small', onclick: () => confirm('Withdraw from the race?') && post('withdraw', {}, 'You\'re out') }, 'Withdraw') : null)
          : x.can.enter ? enterForm() : !S.me && x.status === 'open' ? h('div', { class: 'card' }, h('a', { class: 'btn btn-primary', href: `/signin?next=${encodeURIComponent(`/race/${x.id}`)}` }, 'Sign in to enter')) : null,
      x.events.some((e) => e.finishers.length) ? h('div', { class: 'card' },
        h('h2', {}, x.status === 'done' ? 'Results' : 'Results (only organisers see these until they\'re out)'),
        x.events.length > 1 ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Distance' }, x.events.map((e) => h('button', { 'aria-pressed': String(e.id === tab.ev), onclick: () => setTab({ ev: e.id, filter: 'all' }) }, e.name))) : null,
        h('div', { class: 'race-filters' }, [['all', 'All'], ['f', 'Women'], ['m', 'Men'], ...groups.map((g) => [g, g])].map(([v, l]) => h('button', { class: `btn btn-small${tab.filter === v ? ' btn-primary' : ' btn-ghost'}`, 'aria-pressed': String(tab.filter === v), onclick: () => setTab({ filter: v }) }, l))),
        h('div', { class: 'table-wrap' }, h('table', { class: 'race-results' },
          h('thead', {}, h('tr', {}, ['#', 'Runner', 'Time', 'Pace'].map((c, i) => h('th', { class: i > 1 ? 'num' : '' }, c)))),
          h('tbody', {}, filtered.map((f) => h('tr', { class: S.me && x.me && x.me.bib === f.bib ? 'me' : '' },
            h('td', {}, tab.filter === 'all' ? f.place : tab.filter === 'm' || tab.filter === 'f' ? f.genderPlace : f.groupPlace),
            h('td', {}, f.handle ? h('a', { href: `/@${f.handle}` }, f.name) : f.name, h('small', { class: 'muted' }, ` · #${f.bib}${f.team ? ` · ${f.team}` : ''}${f.ageGroup ? ` · ${f.ageGroup}` : ''}`)),
            h('td', { class: 'num' }, h('strong', {}, f.time)), h('td', { class: 'num muted' }, f.pace)))))),
        ev && ev.dnf.length ? h('p', { class: 'muted small' }, `Did not finish: ${ev.dnf.map((d) => d.name).join(', ')}`) : null) : null,
    ];
  }

  // ---------- club honours and the club rankings
  const HONOUR_ICON = { versus: '⚔️', season: '🏆', meet: '🏅', racing: '🏁', goal: '🎯', member: '⭐' };
  function clubHonours(c) {
    const H = S.clubHonours;
    if (!H || H.slug !== c.slug) {
      S.clubHonours = { slug: c.slug, loading: true };
      api('GET', `${clubPath(c.slug)}/honours`).then((r) => { S.clubHonours = { slug: c.slug, ...r }; render(); }, () => { S.clubHonours = { slug: c.slug, trophies: [], members: [], points: 0 }; render(); });
      return loading();
    }
    if (H.loading) return loading();
    const row = (x) => h('li', {}, h('span', { 'aria-hidden': 'true' }, HONOUR_ICON[x.kind] || '⭐'), ' ', h('a', { href: x.url }, x.title), h('small', { class: 'muted' }, ` · ${x.detail || ''}`), h('small', { class: 'muted', style: 'margin-left:auto' }, `+${x.points}`));
    const share = () => shareSheet({ title: `${c.name}'s honours`, text: H.rank ? `${c.name}: #${H.rank.place} in the club rankings with ${H.points} points this year 🏆` : `${c.name} on Tonament`, url: `${location.origin}/club/${c.slug}?tab=ladder`, image: `/img/club/${c.slug}.png` });
    return h('div', { class: 'card club-honours' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Honours'), H.rank ? h('a', { class: 'pill org', href: '/clubs/rankings' }, `#${H.rank.place} of ${H.rank.of}`) : null),
      h('div', { class: 'run-stats' },
        h('div', { class: 'run-stat' }, h('small', { class: 'muted' }, 'Points this year'), h('strong', {}, H.points)),
        h('div', { class: 'run-stat' }, h('small', { class: 'muted' }, 'Trophies'), h('strong', {}, H.trophies.length)),
        h('div', { class: 'run-stat' }, h('small', { class: 'muted' }, 'Members\' wins'), h('strong', {}, H.members.length))),
      H.trophies.length ? h('ul', { class: 'cc-list honours-list' }, H.trophies.slice(0, 8).map(row)) : null,
      H.members.length ? h('details', { class: 'race-runners' }, h('summary', {}, `Members' wins (${H.members.length})`), h('ul', { class: 'cc-list honours-list' }, H.members.map(row))) : null,
      !H.trophies.length && !H.members.length ? h('p', { class: 'muted' }, 'Nothing yet. Beat another club, win a season or a meet\'s team title — and members\' titles, podiums and medals count too.') : null,
      h('div', { class: 'actions' }, h('a', { class: 'btn btn-small', href: '/clubs/rankings' }, 'Club rankings'), H.points ? h('button', { class: 'btn btn-small btn-ghost', onclick: share }, 'Share') : null));
  }

  function viewClubRankings() {
    document.title = 'Club rankings · Tonament';
    const L = S.clubRankings;
    const go = (city, kind) => navigate(`/clubs/rankings${city || kind ? `?${new URLSearchParams({ ...(city && { city }), ...(kind && { kind }) })}` : ''}`);
    return [
      h('p', {}, h('a', { class: 'back-link', href: '/clubs' }, '← Clubs')),
      h('h1', {}, 'Club rankings'),
      h('p', { class: 'muted' }, 'Clubs, academies and venues by what they and their members won in the last 12 months — club v club, seasons, team titles, and members\' titles, podiums and medals.'),
      L == null ? loading() : [
        h('div', { class: 'race-filters' },
          [['', 'All'], ['club', 'Clubs'], ['academy', 'Academies'], ['venue', 'Venues'], ['team', 'Teams']].map(([v, l]) => h('button', { class: `btn btn-small${S.route.kind === v ? ' btn-primary' : ' btn-ghost'}`, 'aria-pressed': String(S.route.kind === v), onclick: () => go(S.route.city, v) }, l)),
          L.cities.length ? h('select', { 'aria-label': 'City', onchange: (e) => go(e.target.value, S.route.kind) }, h('option', { value: '' }, 'Every city'), L.cities.map((c) => h('option', { value: c, selected: c === S.route.city }, c))) : null),
        L.items.length ? h('div', { class: 'card' }, h('table', { class: 'season-table' },
          h('thead', {}, h('tr', {}, ['#', 'Club', 'Trophies', 'Pts'].map((c, i) => h('th', { class: i > 1 ? 'num' : '' }, c)))),
          h('tbody', {}, L.items.map((r) => h('tr', {}, h('td', {}, r.place),
            h('td', {}, h('a', { href: `/club/${r.slug}?tab=ladder` }, r.name), h('small', { class: 'muted' }, ` · ${[r.kindName, r.city].filter(Boolean).join(' · ')}`)),
            h('td', { class: 'num' }, r.trophies), h('td', { class: 'num' }, h('strong', {}, r.points)))))))
          : empty('No clubs here yet — win something!'),
        h('details', { class: 'card race-runners' }, h('summary', {}, 'How points work'),
          h('p', { class: 'small' }, 'The club\'s own: club v club win 3 (draw 1) · season title 10 · team title at a meet or a racing championship 8 · club v club goal won 3.'),
          h('p', { class: 'small' }, 'Its members\' (while they\'re in the club): tournament title 2, final 1 · race podium 2/1/1 · meet medal 2/1/1 · racing round win 2.')),
      ],
    ];
  }

  // ---------- club runs: a club's weekly run, who's in, who ran
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const runWhen = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }); // club run times are set in India time

  function clubRunsCard(c) {
    const L = S.clubRuns;
    if (!L || L.slug !== c.slug) {
      S.clubRuns = { slug: c.slug, loading: true };
      api('GET', `${clubPath(c.slug)}/club-runs`).then((r) => { S.clubRuns = { slug: c.slug, ...r }; render(); }, () => { S.clubRuns = { slug: c.slug, items: [] }; render(); });
      return null;
    }
    if (L.loading || (!L.items.length && !L.admin)) return null;
    const member = c.me && c.me.status === 'active';
    const form = () => {
      const d = (S.clubRunDraft ||= { weekday: 0, time: '06:00', place: '', distance: '', name: '' });
      return h('form', {
        class: 'card form',
        onsubmit: (e) => {
          e.preventDefault();
          act(async () => {
            const x = await api('POST', `${clubPath(c.slug)}/club-runs`, { ...d, weekday: Number(d.weekday), name: d.name || null, distance: d.distance || null });
            S.clubRunForm = false; S.clubRunDraft = null; S.clubRuns = null; S.clubRun = x;
            navigate(`/club-run/${x.id}`);
          }, 'Weekly run set — members have been told');
        },
      },
      h('h2', {}, 'A weekly club run'),
      groupField('Day', choiceGroup({ name: 'crDay', label: 'Day', value: d.weekday, options: WEEKDAYS.map((w, i) => ({ value: i, label: w.slice(0, 3) })), onchange: (e) => { d.weekday = Number(e.target.value); } })),
      field('Time', h('input', { type: 'time', required: true, value: d.time, oninput: (e) => { d.time = e.target.value; } })),
      field('Meeting point', h('input', { required: true, maxlength: 80, placeholder: 'Lighthouse gate, Marina Beach', value: d.place, oninput: (e) => { d.place = e.target.value; } })),
      field('Distance', h('input', { maxlength: 40, placeholder: '5 / 10 km', value: d.distance, oninput: (e) => { d.distance = e.target.value; } })),
      field('Name', h('input', { maxlength: 60, placeholder: 'Sunrise run', value: d.name, oninput: (e) => { d.name = e.target.value; } })),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Set it up'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { S.clubRunForm = false; render(); } }, 'Cancel')));
    };
    const rsvp = (x) => act(async () => { await api('POST', `/club-runs/${x.id}/rsvp`, { going: !x.me }); S.clubRuns = null; }, x.me ? 'You\'re out this time' : 'You\'re in 🏃');
    return [
      L.items.length || L.admin ? h('div', { class: 'card club-runs' },
        h('div', { class: 'card-head' }, h('h2', {}, 'Club runs'), L.admin && !S.clubRunForm ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => { S.clubRunForm = true; render(); } }, '+ Weekly run') : null),
        L.items.length ? h('ul', { class: 'cc-list' }, L.items.map((x) => h('li', {},
          h('a', { href: `/club-run/${x.id}` }, h('strong', {}, x.name)),
          h('span', { class: 'muted small' }, ` · ${runWhen(x.startsAt)} · ${x.place}${x.going ? ` · ${x.going} in` : ''}`),
          member ? h('button', { class: `btn btn-small${x.me ? '' : ' btn-primary'}`, style: 'margin-left:auto', 'aria-pressed': String(x.me), onclick: () => rsvp(x) }, x.me ? 'In ✓' : 'I\'m in') : null)))
          : h('p', { class: 'muted' }, 'Set a weekly run: members say they\'re in, you mark who ran, and everyone\'s run goes on the club feed.')) : null,
      L.admin && S.clubRunForm ? form() : null,
    ];
  }

  async function loadClubRun() {
    try {
      S.clubRun = await api('GET', `/club-runs/${S.route.id}`);
      S.error = null;
    } catch (e) {
      S.error = e.message;
    }
    render();
  }

  function viewClubRun() {
    const x = S.clubRun;
    if (!x || x.id !== S.route.id) return loading();
    document.title = `${x.name} · ${x.club.name}`;
    const post = (what, body, msg) => act(async () => { S.clubRun = await api('POST', `/club-runs/${x.id}/${what}`, body || {}); }, msg);
    const names = (list) => list.map((p, i) => [i ? ', ' : '', p.handle ? h('a', { href: `/@${p.handle}` }, p.name) : p.name]);
    const share = () => shareSheet({ title: `${x.club.name}: ${x.name}`, text: `Run with ${x.club.name} — every ${x.day} at ${x.time}, ${x.place}. Join us:`, url: `${location.origin}/club-run/${x.id}`, image: `/img/club/${x.club.slug}.png` });
    // The date to log and mark: the one on now, or the last one.
    const md = x.markDate;
    const dated = [x.next, x.last].find((d) => d && d.date === md);
    const canLog = dated && dated.me && (dated.me.going || dated.me.attended) && !dated.me.logged;
    const logForm = () => {
      const d = (S.clubRunLog ||= { km: '', time: '' });
      return h('form', {
        class: 'run-row',
        onsubmit: (e) => { e.preventDefault(); act(async () => { const r = await api('POST', `/club-runs/${x.id}/log`, { date: md, km: Number(d.km), time: d.time }); S.clubRunLog = null; S.lastRun = r; await loadClubRun(); }, 'Logged — it\'s on the club feed 🏃'); },
      },
      field('Distance (km)', h('input', { type: 'number', step: '0.01', min: '0.1', required: true, inputmode: 'decimal', placeholder: '5', value: d.km, oninput: (e) => { d.km = e.target.value; } })),
      field('Time', h('input', { required: true, placeholder: '28:30', inputmode: 'numeric', value: d.time, oninput: (e) => { d.time = e.target.value; } })),
      h('div', { class: 'actions', style: 'grid-column:1/-1' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Log my run')));
    };
    const marking = S.clubRunMark && S.clubRunMark.id === x.id;
    const markCard = () => {
      const chosen = S.clubRunMark.ids;
      const toggle = (id) => { const i = chosen.indexOf(id); if (i >= 0) chosen.splice(i, 1); else chosen.push(id); render(); };
      return h('div', { class: 'card' }, h('h2', {}, `Who ran · ${fmtDates(md)}`),
        h('ul', { class: 'cc-pick' }, x.members.map((p) => h('li', {}, h('label', { class: 'check-field' }, h('input', { type: 'checkbox', checked: chosen.includes(p.id), onchange: () => toggle(p.id) }), h('span', {}, p.name))))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-primary', onclick: () => act(async () => { S.clubRun = await api('POST', `/club-runs/${x.id}/mark`, { date: md, ran: chosen }); S.clubRunMark = null; }, `${chosen.length} marked — it's on the club feed`) }, `Save (${chosen.length})`),
          h('button', { class: 'btn btn-ghost', onclick: () => { S.clubRunMark = null; render(); } }, 'Cancel')));
    };
    return [
      h('p', {}, h('a', { class: 'back-link', href: `/club/${x.club.slug}` }, `← ${x.club.name}`)),
      h('div', { class: 'card challenge-head' },
        h('p', { class: 'eyebrow' }, ['Club run', `Every ${x.day}`, x.distance].filter(Boolean).join(' · ')),
        h('h1', {}, x.name),
        h('p', { class: 'muted small' }, `${x.time} · ${x.place}`),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-small', onclick: share }, 'Invite runners'),
          x.can.stop ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => confirm('Stop this weekly run?') && act(async () => { await api('POST', `/club-runs/${x.id}/stop`); navigate(`/club/${x.club.slug}`); }, 'Stopped') }, 'Stop it') : null)),
      x.next ? h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, x.next.started ? 'On now' : `Next: ${runWhen(x.next.startsAt)}`),
          x.can.rsvp ? h('button', { class: `btn${x.next.me && x.next.me.going ? '' : ' btn-primary'}`, onclick: () => post('rsvp', { going: !(x.next.me && x.next.me.going) }, x.next.me && x.next.me.going ? 'You\'re out this time' : 'You\'re in 🏃') }, x.next.me && x.next.me.going ? 'In ✓' : 'I\'m in') : null),
        x.next.going.length ? h('p', {}, h('strong', {}, `${x.next.going.length} in: `), names(x.next.going)) : h('p', { class: 'muted' }, 'Nobody\'s said yet — be the first.'),
        !x.can.rsvp && S.me ? h('p', { class: 'muted small' }, h('a', { href: `/club/${x.club.slug}` }, `Join ${x.club.name}`), ' to say you\'re in.') : null) : null,
      md ? h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', {}, `Ran · ${fmtDates(md)}`), x.can.mark && !marking ? h('button', { class: 'btn btn-small', onclick: () => { S.clubRunMark = { id: x.id, ids: (dated ? dated.ran.length ? dated.ran : dated.going : []).map((p) => p.id) }; render(); } }, 'Mark who ran') : null),
        dated && dated.ran.length ? h('p', {}, names(dated.ran.map((p) => ({ ...p, name: `${p.name}${p.logged ? ' ✓' : ''}` })))) : h('p', { class: 'muted small' }, x.can.mark ? 'Mark who ran — they\'re asked to log it, and the club feed says so.' : 'Not marked yet.'),
        canLog ? [h('h3', {}, 'Log your run'), logForm()] : null) : null,
      marking ? markCard() : null,
      x.regulars.length ? h('div', { class: 'card' }, h('h2', {}, 'Regulars'), h('p', { class: 'muted small' }, 'Most runs with the club in the last 90 days.'),
        h('ol', { class: 'entries run-board' }, x.regulars.map((p) => h('li', {}, p.handle ? h('a', { href: `/@${p.handle}` }, p.name) : h('span', {}, p.name), h('strong', {}, `${p.runs}`))))) : null,
    ];
  }

  // ---------- club seasons: a league between clubs
  const SEASON_STATUS = { open: ['waiting', 'Clubs entering'], on: ['org', 'On'], done: ['done', 'Finished'] };
  // Sports a club can play against clubs: ties in racket sports, matches in team sports.
  const clubSportsFor = (c) => {
    const listed = (c.sports || []).filter((x) => CAT.isTeamSport(x.id) || CAT.hasTies(x.id));
    const all = listed.length ? listed : (S.sports || []).filter((x) => x.status === 'live' && (CAT.isTeamSport(x.id) || CAT.hasTies(x.id)));
    return all.map((x) => ({ id: x.id, name: x.name, kind: CAT.isTeamSport(x.id) ? 'friendly' : 'tie' }));
  };

  function clubSeasons(c) {
    const L = S.clubSeasons;
    if (!L || L.slug !== c.slug) {
      S.clubSeasons = { slug: c.slug, loading: true };
      api('GET', `${clubPath(c.slug)}/seasons`).then((r) => { S.clubSeasons = { slug: c.slug, ...r }; render(); }, () => { S.clubSeasons = { slug: c.slug, items: [] }; render(); });
      return loading();
    }
    if (L.loading) return loading();
    const options = clubSportsFor(c);
    const form = () => {
      const d = (S.seasonDraft ||= { sport: (options[0] || {}).id || '', format: '2s1d', name: '' });
      const kind = (options.find((x) => x.id === d.sport) || {}).kind;
      return h('form', {
        class: 'card form',
        onsubmit: (e) => {
          e.preventDefault();
          act(async () => {
            const x = await api('POST', `${clubPath(c.slug)}/seasons`, { name: d.name || null, sport: d.sport, ...(kind === 'tie' && { tie: { format: d.format } }) });
            S.seasonForm = false; S.seasonDraft = null; S.clubSeasons = null; S.season = x;
            navigate(`/season/${x.id}`);
          }, 'Season set up — share the link with the clubs you want in');
        },
      },
      h('h2', {}, 'Start a season'),
      h('p', { class: 'muted small' }, 'A league between clubs: they enter with the link, pick their teams, and every club plays every other once. You start it when everyone\'s in.'),
      field('Name', h('input', { maxlength: 60, placeholder: `${c.name} League`, value: d.name, oninput: (e) => { d.name = e.target.value; } })),
      options.length ? groupField('Sport', choiceGroup({ name: 'seasonSport', label: 'Sport', value: d.sport, options: options.map((x) => ({ value: x.id, label: x.name, hint: x.kind === 'tie' ? 'Team ties' : 'Matches' })), onchange: (e) => { d.sport = e.target.value; render(); } }))
        : h('p', { class: 'muted' }, 'Add a racket or team sport to the club first.'),
      kind === 'tie' ? groupField('Each fixture is', choiceGroup({ name: 'seasonFormat', label: 'Each fixture is', value: d.format, options: Object.entries(TonamentTie.FORMATS).map(([value, x]) => ({ value, label: x.name, hint: x.hint })), onchange: (e) => { d.format = e.target.value; render(); } })) : null,
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit', disabled: !d.sport }, 'Set it up'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { S.seasonForm = false; render(); } }, 'Cancel')));
    };
    const row = (x) => h('li', {},
      h('a', { href: `/season/${x.id}` }, h('strong', {}, x.name)),
      h('span', { class: 'muted small' }, ` · ${x.sport.name} · ${x.clubs} clubs`),
      x.champion ? pill('org', '🏆 Champions') : x.place ? pill(x.status === 'done' ? 'done' : 'org', `${x.status === 'done' ? 'Finished' : 'Now'} #${x.place}`) : pill(...SEASON_STATUS[x.status]));
    return h('section', { class: 'section club-versus' },
      h('div', { class: 'card' },
        h('h2', {}, 'Seasons'),
        L.items.length ? h('ul', { class: 'cc-list' }, L.items.map(row))
          : h('p', { class: 'muted' }, 'Run a league with other clubs: a table, fixtures every week, and champions at the end.'),
        L.admin && !S.seasonForm ? h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { S.seasonForm = true; render(); } }, '🏁 Start a season')) : null),
      L.admin && S.seasonForm ? form() : null);
  }

  async function loadSeason() {
    try {
      S.season = await api('GET', `/seasons/${S.route.id}`);
      S.error = null;
    } catch (e) {
      S.error = e.message;
    }
    render();
  }
  setInterval(() => {
    if (S.route.name === 'season' && S.season && S.season.status === 'on' && !document.hidden && !isEditing() && !S.seasonPick) loadSeason();
  }, 10000);

  function viewSeason() {
    const x = S.season;
    if (!x || x.id !== S.route.id) return loading();
    document.title = `${x.name} · Club season`;
    const post = (what, body, msg) => act(async () => { S.season = await api('POST', `/seasons/${x.id}/${what}`, body || {}); }, msg);
    const share = () => shareSheet({
      title: x.name,
      text: x.status === 'open' ? `${x.name} — a ${x.sport.name.toLowerCase()} league between clubs. Enter your club:` : x.champion ? `🏆 ${x.champion.name} won ${x.name}. The final table:` : `${x.name} — the table so far:`,
      url: `${location.origin}/season/${x.id}`, image: `/img/season/${x.id}.png`,
    });
    const [cls, label] = SEASON_STATUS[x.status];
    const rounds = [...new Set(x.fixtures.map((f) => f.round))].sort((a, b) => a - b);
    const matchUrl = (f) => `/t/${x.tournamentId}/m/${f.id}`;
    const fixture = (f) => h('li', { class: 'season-fixture' },
      h('a', { href: matchUrl(f) },
        h('span', { class: f.winner === 'a' ? 'won' : '' }, f.a), h('span', { class: 'season-score' }, f.status === 'done' || f.status === 'live' ? f.summary || '–' : 'v'), h('span', { class: f.winner === 'b' ? 'won' : '' }, f.b)),
      f.status === 'live' ? pill('live', 'Live') : null);
    const team = (cl) => {
      const picking = S.seasonPick && S.seasonPick.slug === cl.slug;
      if (picking) {
        const chosen = S.seasonPick.ids;
        const locked = x.status !== 'open' ? cl.members.filter((m) => m.picked).map((m) => m.id) : [];
        const toggle = (id) => { if (locked.includes(id)) return; const i = chosen.indexOf(id); if (i >= 0) chosen.splice(i, 1); else chosen.push(id); render(); };
        return h('div', { class: 'card cc-team' },
          h('h3', {}, `Pick ${cl.name}'s team`),
          h('p', { class: 'muted small' }, `At least ${x.need}. The first one you tick is the captain.${x.status !== 'open' ? ' The season\'s on: you can add players, not take anyone off.' : ''}`),
          h('ul', { class: 'cc-pick' }, cl.members.map((p) => h('li', {}, h('label', { class: 'check-field' },
            h('input', { type: 'checkbox', checked: chosen.includes(p.id), disabled: locked.includes(p.id), onchange: () => toggle(p.id) }),
            h('span', {}, p.name), chosen[0] === p.id ? h('small', { class: 'muted' }, ' · captain') : null)))),
          h('div', { class: 'actions' },
            h('button', { class: 'btn btn-primary', disabled: chosen.length < x.need, onclick: () => act(async () => { S.season = await api('POST', `/seasons/${x.id}/team`, { club: cl.slug, members: chosen }); S.seasonPick = null; }, 'Team saved') }, `Save the team (${chosen.length})`),
            h('button', { class: 'btn btn-ghost', onclick: () => { S.seasonPick = null; render(); } }, 'Cancel')));
      }
      // Keep the team's order (it's the line-up's list): picked first, as saved.
      const start = () => { const ids = cl.team.map((p) => (cl.members.find((m) => m.name === p.name) || {}).id).filter(Boolean); S.seasonPick = { slug: cl.slug, ids }; render(); };
      return h('div', { class: 'card cc-team' },
        h('div', { class: 'card-head' }, h('h3', {}, h('a', { href: `/club/${cl.slug}` }, cl.name), cl.host ? h('small', { class: 'muted' }, ' · host') : null),
          cl.team.length >= x.need ? pill('done', `${cl.team.length} players`) : pill('waiting', 'No team yet')),
        cl.team.length ? h('p', { class: 'small' }, cl.team.map((p, i) => [i ? ', ' : '', p.handle ? h('a', { href: `/@${p.handle}` }, p.name) : p.name, p.captain ? ' (c)' : ''])) : null,
        h('div', { class: 'actions' },
          cl.members ? h('button', { class: cl.team.length ? 'btn btn-small' : 'btn btn-primary btn-small', onclick: start }, cl.team.length ? (x.status === 'open' ? 'Change the team' : 'Add players') : 'Pick your team') : null,
          x.status === 'open' && !cl.host && (cl.admin || x.can.remove) ? h('button', { class: 'btn btn-ghost btn-small', onclick: () => confirm(`Take ${cl.name} out of the season?`) && post('leave', { club: cl.slug }, `${cl.name} is out`) }, cl.admin ? 'Leave' : 'Remove') : null));
    };
    return [
      h('p', {}, h('a', { class: 'back-link', href: `/club/${x.host.slug}?tab=ladder` }, `← ${x.host.name}`)),
      h('div', { class: 'card challenge-head' },
        h('p', { class: 'eyebrow' }, ['Club season', x.sport.name, x.tie ? x.tie.name : null].filter(Boolean).join(' · ')),
        h('h1', {}, x.name),
        h('p', { class: 'muted small' }, `Hosted by ${x.host.name} · ${x.clubs.length} club${x.clubs.length === 1 ? '' : 's'}${rounds.length ? ` · ${rounds.length} rounds` : ''}`),
        h('div', { class: 'actions' }, pill(cls, label), h('button', { class: 'btn btn-small', onclick: share }, x.status === 'open' ? 'Invite clubs' : 'Share'))),
      x.champion ? h('div', { class: 'card cc-result' }, h('p', { class: 'eyebrow' }, 'Champions'),
        h('div', { class: 'cc-score' }, h('strong', {}, `🏆 ${x.champion.name}`), h('span', { class: 'cc-big' }, `${x.table[0].points} pts`)),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: share }, 'Share the final table'))) : null,
      x.status === 'open' ? h('div', { class: 'card' },
        h('h2', {}, 'Clubs are entering'),
        h('p', { class: 'muted small' }, `Share the link with clubs you want in (up to 12). Each picks a team of at least ${x.need} from its members. Every club plays every other once.`),
        x.can.enter.length ? h('div', { class: 'actions' }, x.can.enter.map((o) => h('button', { class: 'btn btn-primary', onclick: () => post('enter', { club: o.slug }, `${o.name} is in — now pick your team`) }, `Enter ${o.name}`))) : null,
        x.can.start ? h('div', { class: 'actions' },
          h('button', { class: 'btn btn-primary', disabled: x.clubs.length < 3, onclick: () => confirm(`Start ${x.name}? The fixtures are drawn and no more clubs can enter.`) && post('start', {}, 'The season is on — fixtures are out 🏁') }, 'Start the season'),
          h('button', { class: 'btn', onclick: share }, 'Invite clubs'),
          x.clubs.length < 3 ? h('small', { class: 'muted' }, 'At least 3 clubs') : null) : null) : null,
      x.table.length ? h('div', { class: 'card' }, h('h2', {}, x.status === 'done' ? 'Final table' : 'Table'),
        h('table', { class: 'standings season-table' },
          h('thead', {}, h('tr', {}, ['#', 'Club', 'P', 'W', 'L', 'Pts'].map((c, i) => h('th', { class: i > 1 ? 'num' : '' }, c)))),
          h('tbody', {}, x.table.map((r, i) => h('tr', {},
            h('td', {}, i + 1), h('td', {}, h('a', { href: `/club/${r.slug}` }, r.name)), h('td', { class: 'num' }, r.played), h('td', { class: 'num' }, r.won), h('td', { class: 'num' }, r.lost), h('td', { class: 'num' }, h('strong', {}, r.points))))))) : null,
      rounds.length ? h('div', { class: 'card' }, h('h2', {}, 'Fixtures'),
        rounds.map((rd) => [h('h3', { class: 'season-round' }, `Round ${rd}`), h('ul', { class: 'season-fixtures' }, x.fixtures.filter((f) => f.round === rd).map(fixture))]),
        h('p', { class: 'muted small' }, x.kind === 'tie' ? 'Open a fixture to set your line-up (sealed until both are in) and score each match.' : 'Open a fixture to score it.')) : null,
      h('h2', { class: 'section-title' }, 'Teams'),
      h('div', { class: 'cc-teams' }, x.clubs.map(team)),
    ];
  }

  async function loadClubChallenge() {
    try {
      S.cc = await api('GET', `/club-challenges/${S.route.id}`);
      S.error = null;
    } catch (e) {
      S.error = e.message;
    }
    render();
  }
  // While it's on, the score follows along.
  setInterval(() => {
    if (S.route.name === 'clubChallenge' && S.cc && ['sent', 'accepted'].includes(S.cc.status) && !document.hidden && !isEditing()) loadClubChallenge();
  }, 8000);

  function viewClubChallenge() {
    const x = S.cc;
    if (!x || x.id !== S.route.id) return loading();
    const A = x.a.club;
    const B = x.b.club;
    document.title = `${A.name} v ${B.name} · Club v club`;
    const post = (what, body, msg) => act(async () => { S.cc = await api('POST', `/club-challenges/${x.id}/${what}`, body || {}); }, msg);
    const [cls, label] = CC_STATUS[x.status] || ['', x.status];
    const share = () => shareSheet({
      title: `${A.name} v ${B.name}`,
      text: x.result ? (x.result.winner ? `${x.result.winner === 'a' ? A.name : B.name} beat ${x.result.winner === 'a' ? B.name : A.name} ${x.result.score} — club v club ${x.sport.name.toLowerCase()} on Tonament` : `${A.name} v ${B.name}: ${x.result.score}`)
        : `${A.name} v ${B.name} — a club v club ${x.sport.name.toLowerCase()} ${ccKind(x)} on Tonament`,
      url: `${location.origin}/cc/${x.id}`, image: `/img/cc/${x.id}.png`,
    });
    const team = (side) => {
      const s = x[side];
      const picking = S.ccPick && S.ccPick.side === side;
      if (picking) {
        const chosen = S.ccPick.ids;
        const toggle = (id) => { const i = chosen.indexOf(id); if (i >= 0) chosen.splice(i, 1); else chosen.push(id); render(); };
        return h('div', { class: 'card cc-team' },
          h('h3', {}, `Pick ${s.club.name}'s team`),
          h('p', { class: 'muted small' }, `At least ${x.need}. The first one you tick is the captain${x.kind === 'tie' ? ' — they set the line-up' : ''}.`),
          h('ul', { class: 'cc-pick' }, s.members.map((p) => h('li', {}, h('label', { class: 'check-field' },
            h('input', { type: 'checkbox', checked: chosen.includes(p.id), onchange: () => toggle(p.id) }),
            h('span', {}, p.name), chosen[0] === p.id ? h('small', { class: 'muted' }, ' · captain') : null)))),
          h('div', { class: 'actions' },
            h('button', { class: 'btn btn-primary', disabled: chosen.length < x.need, onclick: () => act(async () => { S.cc = await api('POST', `/club-challenges/${x.id}/team`, { side, members: chosen }); S.ccPick = null; }, 'Team saved') }, `Save the team (${chosen.length})`),
            h('button', { class: 'btn btn-ghost', onclick: () => { S.ccPick = null; render(); } }, 'Cancel')));
      }
      return h('div', { class: 'card cc-team' },
        h('h3', {}, h('a', { href: `/club/${s.club.slug}` }, s.club.name)),
        s.team.length ? h('ol', { class: 'cc-roster' }, s.team.map((p) => h('li', {}, p.handle ? h('a', { href: `/@${p.handle}` }, p.name) : p.name, p.captain ? h('small', { class: 'muted' }, ' · captain') : null)))
          : h('p', { class: 'muted small' }, x.status === 'accepted' ? 'Team not picked yet.' : '—'),
        x.can.pick && s.members ? h('div', { class: 'actions' }, h('button', { class: s.team.length ? 'btn btn-small' : 'btn btn-primary', onclick: () => { S.ccPick = { side, ids: s.team.length ? s.members.filter((m) => s.team.some((p) => p.name === m.name)).map((m) => m.id) : [] }; render(); } }, s.team.length ? 'Change the team' : 'Pick your team')) : null);
    };
    const winnerName = x.result && x.result.winner ? x[x.result.winner].club.name : null;
    const matchUrl = x.match ? `/t/${x.tournamentId}/m/${x.match.id}` : null;
    return [
      h('p', {}, h('a', { class: 'back-link', href: `/club/${(x.a.admin || !x.b.admin ? A : B).slug}?tab=ladder` }, '← Compete')),
      h('div', { class: 'card challenge-head cc-head' },
        h('p', { class: 'eyebrow' }, ['Club v club', x.sport.name, x.tie ? x.tie.name : 'Friendly'].join(' · ')),
        h('h1', {}, h('a', { href: `/club/${A.slug}` }, A.name), h('span', { class: 'muted' }, ' v '), h('a', { href: `/club/${B.slug}` }, B.name)),
        h('p', { class: 'muted small' }, [x.playAt ? fmtWhen(x.playAt) : null, x.place].filter(Boolean).join(' · ') || null),
        x.message ? h('p', { class: 'challenge-message' }, `“${x.message}”`) : null,
        h('div', { class: 'actions' }, pill(cls, label), h('button', { class: 'btn btn-small', onclick: share }, 'Share'))),
      x.result ? h('div', { class: 'card cc-result' },
        h('p', { class: 'eyebrow' }, 'Final'),
        h('div', { class: 'cc-score' }, h('strong', {}, winnerName ? `${winnerName} won` : 'A draw'), h('span', { class: 'cc-big' }, x.result.score)),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: share }, 'Share the result'), matchUrl ? h('a', { class: 'btn', href: matchUrl }, 'See the matches') : null)) : null,
      x.status === 'sent' ? h('div', { class: 'card' },
        x.can.respond ? [h('h2', {}, `${A.name} challenges you`), h('p', { class: 'muted small' }, `A ${x.sport.name.toLowerCase()} ${ccKind(x)}${x.tie ? ` — ${x.tie.name}` : ''}. Accept, then pick your team.`),
          h('div', { class: 'actions' },
            h('button', { class: 'btn btn-primary btn-lg', onclick: () => post('respond', { accept: true }, 'Challenge accepted ⚔️ — pick your team') }, 'Accept'),
            h('button', { class: 'btn btn-lg', onclick: () => post('respond', { accept: false }, 'Declined') }, 'Not this time'))]
          : h('p', { style: 'margin:0' }, `Waiting for ${B.name}'s admins to answer.`)) : null,
      x.status === 'accepted' && x.match ? h('div', { class: 'card cc-match' },
        h('div', { class: 'card-head' }, x.match.status === 'live' ? pill('live', 'Live') : h('h2', {}, 'The match'), x.match.summary && x.match.status !== 'scheduled' ? h('span', { class: 'cc-big' }, x.match.summary) : null),
        h('p', { class: 'muted small' }, x.kind === 'tie'
          ? 'Once both teams are picked, each captain sets their line-up on the match page — sealed until both are in. Then score each match there.'
          : 'Score it live or enter the final score on the match page.'),
        h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary', href: matchUrl }, x.kind === 'tie' ? 'Open the tie →' : 'Open the match →'))) : null,
      ['accepted', 'played'].includes(x.status) ? h('div', { class: 'cc-teams' }, team('a'), team('b')) : null,
      x.can.cancel ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', onclick: () => confirm('Call off this challenge?') && post('cancel', {}, 'Called off') }, 'Call it off')) : null,
    ];
  }

  function clubLeaderboard(c) {
    if (!c.leaderboard.length) return empty('No members yet.');
    return h('div', { class: 'card' },
      h('p', { class: 'muted small', style: 'margin-top:0' }, 'Members by titles, then finals, then ranking points this year.'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['#', 'Player', '🏆', 'Finals', 'Pts', 'W–L'].map((x, i) => h('th', { class: i === 1 ? '' : 'num' }, x)))),
        h('tbody', {}, c.leaderboard.map((r) => h('tr', {},
          h('td', { class: 'num' }, r.rank),
          h('td', { class: 'name' }, r.handle ? h('a', { href: `/p/${r.handle}` }, r.name) : r.name),
          h('td', { class: 'num' }, r.titles), h('td', { class: 'num' }, r.finals), h('td', { class: 'num' }, r.points), h('td', { class: 'num' }, `${r.won}–${r.lost}`)))))));
  }

  // Admins: the paid public page (search, photos, coaching, contact).
  function clubPageCard(c) {
    return h('div', { class: 'card' },
      h('h2', {}, c.pagePublic ? 'Your public page' : 'Get a public page'),
      h('p', { class: 'muted' }, c.pagePublic
        ? `tonament.com/@${c.slug} is live: found on Google, with your photos, coaching, contact buttons and tournaments.`
        : `The club is free. A public page at tonament.com/@${c.slug} adds what new players look for: found on Google, photos, coaching and timings, WhatsApp and call buttons, and your tournaments — ${orgPrice()} a year.`),
      h('div', { class: 'actions' },
        h('a', { class: 'btn btn-primary', href: `/@${c.slug}/edit` }, c.pagePublic ? 'Edit the page' : 'Set up the page'),
        c.pagePublic ? h('a', { class: 'btn', href: `/@${c.slug}` }, 'View it') : null));
  }

  // ---------- challenges: one player (or pair) v another, and the Tonament rating
  const sideNames = (list) => list.map((p) => p.name).join(' & ');
  const withRating = (list) => list.map((p) => `${p.name}${p.rating != null ? ` (${p.rating})` : ''}`).join(' & ');
  const CH_STATUS = {
    sent: ['waiting', 'Waiting for a reply'], accepted: ['org', 'To play'], live: ['live', 'Playing'], done: ['waiting', 'To confirm'],
    confirmed: ['done', 'Confirmed'], disputed: ['withdrawn', 'Disputed'], declined: ['', 'Declined'], expired: ['', 'Expired'], cancelled: ['', 'Cancelled'],
  };
  const challengeable = () => (S.sports || []).filter((x) => x.status === 'live' && x.family !== 'timed' && !CAT.isTeamSport(x.id));

  function challengeRow(x) {
    const [cls, label] = x.can.respond ? ['org', 'Your move'] : CH_STATUS[x.status] || ['', x.status];
    const mine = x.me === 'b' ? [x.b, x.a] : [x.a, x.b];
    return h('a', { class: 'card challenge-card', href: `/c/${x.id}` },
      h('span', { class: 'challenge-card-text' },
        h('strong', {}, `${x.me ? 'You' : sideNames(mine[0])} v ${sideNames(mine[1])}`),
        h('small', { class: 'muted' }, [x.sport.name, x.format, x.summary, x.place].filter(Boolean).join(' · '))),
      pill(cls, label));
  }

  function viewChallenges() {
    document.title = 'Challenges · Tonament';
    const c = S.challenges;
    const section = (title, list, note) => (list && list.length ? h('section', { class: 'section' }, h('h2', {}, `${title} (${list.length})`),
      note ? h('p', { class: 'muted small' }, note) : null, h('div', { class: 'card-list' }, list.map(challengeRow))) : null);
    return [
      h('div', { class: 'card-head page-head' }, h('h1', {}, 'Challenges'), h('a', { class: 'btn btn-primary', href: '/challenges/new' }, 'New challenge')),
      h('p', { class: 'muted' }, 'Challenge a friend, a club-mate or a rival to a game. Every confirmed game moves your Tonament rating and goes on both your feeds.'),
      c == null ? loading() : [
        section('For you', c.incoming, 'Accept or decline.'),
        section('To play', c.toPlay, 'Score it live when you play, or enter the result after.'),
        section('To confirm', c.toConfirm),
        section('Waiting for a reply', c.outgoing),
        section('Played', c.played),
        !c.incoming.length && !c.toPlay.length && !c.toConfirm.length && !c.outgoing.length && !c.played.length
          ? empty('No challenges yet. Tap New challenge, or Challenge on a player\'s profile.') : null,
      ],
    ];
  }

  function viewChallengeNew() {
    document.title = 'New challenge · Tonament';
    const params = new URLSearchParams(location.search);
    const d = (S.chDraft ||= { to: params.get('to') || '', sport: params.get('sport') || '', back: params.get('back') || '', club: params.get('club') || '', pair: false, bestOf: '' });
    const people = S.chPeople;
    if (!people) return loading();
    const options = challengeable();
    if (!d.sport && options.length) d.sport = (options.find((x) => x.id === 'badminton') || options[0]).id;
    const sport = options.find((x) => x.id === d.sport);
    const bestOf = sport && (sport.fields || []).find((f) => f.key === 'bestOf');
    const pick = (name, label, value, exclude = []) => h('select', { name, required: true, 'aria-label': label, onchange: (e) => { d[name] = e.target.value; } },
      h('option', { value: '' }, label), people.filter((p) => !exclude.includes(String(p.id))).map((p) => h('option', { value: p.id, selected: String(p.id) === String(value) }, p.name)));
    const form = h('form', {
      class: 'card form new-flow',
      onsubmit: (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = {
          sport: d.sport, to: Number(fd.get('to')), bestOf: fd.get('bestOf') ? Number(fd.get('bestOf')) : undefined,
          place: fd.get('place'), message: fd.get('message'), playAt: fd.get('playAt') || null, back: d.back || null, club: d.club || null,
          ...(d.pair && { partner: Number(fd.get('partner')), opponentPartner: Number(fd.get('opponentPartner')) }),
        };
        act(async () => {
          const x = await api('POST', '/challenges', body);
          S.chDraft = null;
          S.challenge = x;
          navigate(`/c/${x.id}`);
        }, 'Challenge sent 🔥');
      },
    },
    h('h1', {}, d.back ? 'Challenge back' : 'New challenge'),
    people.length ? null : h('p', { class: 'muted small' }, 'Follow players or join a club to challenge them from here — or use Challenge on anyone\'s profile.'),
    groupField('Sport', choiceGroup({ name: 'sport', label: 'Sport', value: d.sport, options: options.map((x) => ({ value: x.id, label: x.name, icon: x.id })), onchange: (e) => { d.sport = e.target.value; render(); } })),
    groupField('Who plays', choiceGroup({ name: 'pairs', label: 'Who plays', value: d.pair ? 'pairs' : 'one', options: [{ value: 'one', label: 'One v one' }, { value: 'pairs', label: 'Pairs' }], onchange: (e) => { d.pair = e.target.value === 'pairs'; render(); } })),
    field('Challenge', pick('to', 'Pick a player', d.to)),
    d.pair ? h('div', { class: 'grid-2' }, field('Your partner', pick('partner', 'Your partner', d.partner, [String(d.to)])), field('Their partner', pick('opponentPartner', 'Their partner', d.opponentPartner, [String(d.to), String(d.partner || '')]))) : null,
    bestOf ? groupField(bestOf.label || 'Match length', choiceGroup({ name: 'bestOf', label: 'Match length', value: d.bestOf || String(sport.defaults.bestOf), options: bestOf.options.map((o) => ({ value: String(o.value), label: o.label })), onchange: (e) => { d.bestOf = e.target.value; } })) : null,
    h('div', { class: 'grid-2' },
      field('When (optional)', h('input', { type: 'datetime-local', name: 'playAt' })),
      field('Where (optional)', h('input', { name: 'place', maxlength: 80, placeholder: 'e.g. Smashpoint, court 2' }))),
    field('Message (optional)', h('input', { name: 'message', maxlength: 200, placeholder: d.back ? 'Rematch? 😤' : 'Fancy a game this week?' })),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit', disabled: !people.length }, 'Send challenge')));
    return form;
  }

  // Taps go one at a time, each on top of the last (fast tapping never
  // trips over itself); the screen shows how many are still being saved.
  const chQueue = [];
  let chSending = false;
  function challengeTap(id, extra) {
    chQueue.push({ ...extra, t: Date.now() });
    render();
    if (!chSending) sendChallengeTaps(id);
  }
  async function sendChallengeTaps(id) {
    chSending = true;
    while (chQueue.length) {
      const extra = chQueue[0];
      try {
        S.challenge = await api('POST', `/challenges/${id}/rally`, { ...extra, at: S.challenge.rallies });
        chQueue.shift();
      } catch (e) {
        chQueue.length = 0; // the game moved on (or ended): show where it is
        if (e.code === 'stale') await loadChallenge(); else toast(e.message, true);
      }
      render();
    }
    chSending = false;
  }

  async function loadChallenge() {
    try {
      S.challenge = await api('GET', `/challenges/${S.route.id}`);
      S.error = null;
    } catch (e) {
      S.error = e.message;
    }
    render();
  }
  // While it's waiting or being played, everyone's screen follows along.
  setInterval(() => {
    if (S.route.name === 'challenge' && S.challenge && ['sent', 'accepted', 'live', 'done'].includes(S.challenge.status) && !document.hidden && !isEditing() && !chSending) loadChallenge();
  }, 5000);

  function viewChallenge() {
    const x = S.challenge;
    if (!x || x.id !== S.route.id) return loading();
    document.title = `${sideNames(x.a)} v ${sideNames(x.b)} · Challenge`;
    const post = (what, body, msg) => act(async () => { S.challenge = await api('POST', `/challenges/${x.id}/${what}`, body || {}); }, msg);
    const m = { a: { id: 'a', name: sideNames(x.a) }, b: { id: 'b', name: sideNames(x.b) }, status: x.status === 'live' || x.status === 'accepted' ? 'live' : 'done', winner: x.winner, summary: x.summary, score: x.score };
    const tapNow = (extra) => challengeTap(x.id, extra);
    const playing = x.can.score && !x.final;
    S.gameMode = S.gameMode || {};
    const atEnd = Boolean(S.gameMode[`c${x.id}`]);
    const opponent = x.me === 'a' ? x.b : x.a;
    const back = () => navigate(`/challenges/new?to=${opponent[0].id}&sport=${x.sport.id}&back=${x.id}`);
    const finalForm = () => {
      const fa = h('input', { type: 'number', min: 0, max: 99, required: true, 'aria-label': m.a.name, inputmode: 'numeric' });
      const fb = h('input', { type: 'number', min: 0, max: 99, required: true, 'aria-label': m.b.name, inputmode: 'numeric' });
      return h('div', { class: 'card' }, h('p', { class: 'muted small', style: 'margin-top:0' }, 'Played it already? Enter how it ended — the other side confirms it.'),
        h('form', { class: 'final-form', onsubmit: (e) => { e.preventDefault(); post('result', { a: Number(fa.value), b: Number(fb.value) }, 'Score saved — the other side confirms it'); } },
          h('label', {}, h('span', {}, m.a.name), fa), h('label', {}, h('span', {}, m.b.name), fb), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save score')));
    };
    const [cls, label] = CH_STATUS[x.status] || ['', x.status];
    return [
      h('p', {}, h('a', { class: 'back-link', href: '/challenges' }, '← Challenges')),
      h('div', { class: 'card challenge-head' },
        h('p', { class: 'eyebrow' }, x.ladder ? `Ladder · #${x.ladder.a} v #${x.ladder.b} · ${x.sport.name}` : `${x.parent ? 'Rematch' : 'Challenge'} · ${x.sport.name} · ${x.format}`),
        h('h1', {}, withRating(x.a), h('span', { class: 'muted' }, ' v '), withRating(x.b)),
        h('p', { class: 'muted small' }, [x.playAt ? fmtWhen(x.playAt) : null, x.place].filter(Boolean).join(' · ') || null),
        x.message ? h('p', { class: 'challenge-message' }, `“${x.message}”`) : null,
        pill(cls, label)),
      x.status === 'sent' ? h('div', { class: 'card' },
        x.can.respond ? [h('h2', {}, 'You\'re challenged'), h('div', { class: 'actions' },
          h('button', { class: 'btn btn-primary btn-lg', onclick: () => post('respond', { accept: true }, 'Challenge accepted 🔥') }, 'Accept'),
          x.can.decline ? h('button', { class: 'btn btn-lg', onclick: () => post('respond', { accept: false }, 'Declined') }, 'Not this time') : null),
          x.ladder ? h('p', { class: 'muted small' }, `A ladder challenge: play it within a week, or ${sideNames(x.a)} takes your place.`) : null]
          : [h('p', { style: 'margin:0' }, `Waiting for ${sideNames(x.b)} to answer.`), x.can.cancel ? h('div', { class: 'actions' }, h('button', { class: 'btn btn-ghost', onclick: () => confirm('Cancel this challenge?') && post('cancel', {}, 'Cancelled') }, 'Cancel it')) : null]) : null,
      x.score && x.rallies ? scoreboard(m) : x.final ? h('div', { class: 'card final-score' }, h('strong', {}, `${m.a.name} ${x.final.a} – ${x.final.b} ${m.b.name}`)) : null,
      playing ? h('div', { class: 'seg score-mode', role: 'group', 'aria-label': 'How to score' },
        [[false, 'Score live'], [true, 'Final score']].map(([v, l]) => h('button', { 'aria-pressed': String(atEnd === v), onclick: () => { S.gameMode[`c${x.id}`] = v; render(); } }, l))) : null,
      playing && atEnd ? finalForm() : null,
      playing && !atEnd ? h('div', { class: 'scorer' },
        x.score && x.score.taps && x.score.taps.values ? periodPad(x.score, { a: m.a.name, b: m.b.name }, tapNow)
          : x.score && x.score.taps && x.score.taps.max > 1 ? pointPad(`c${x.id}`, x.score, { a: m.a.name, b: m.b.name }, tapNow)
            : h('div', { class: 'score-btns' }, ['a', 'b'].map((s) => h('button', { class: `score-btn side-${s}`, onclick: () => tapNow({ side: s }) },
              h('span', { class: 'sbtn-plus' }, '+1'), h('span', { class: 'sbtn-name' }, m[s].name)))),
        h('div', { class: 'sync', role: 'status' }, chQueue.length ? 'Saving…' : 'All points saved'),
        h('div', { class: 'scorer-tools' }, h('button', { class: 'btn', disabled: !x.rallies || chQueue.length > 0, onclick: () => post('undo', { at: x.rallies }) }, '↶ Undo')),
        h('p', { class: 'hint center', style: 'margin:0' }, `${(x.score && x.score.hint) || 'Tap the side that won the rally.'} Both sides see the score live.`)) : null,
      ['done', 'disputed', 'confirmed'].includes(x.status) ? h('div', { class: 'card' },
        h('h2', {}, x.status === 'confirmed' ? `${sideNames(x[x.winner])} won ✓` : x.status === 'disputed' ? 'Disputed — it doesn\'t count unless the losing side keeps it' : `${sideNames(x[x.winner])} won ${x.summary}`),
        x.status === 'done' ? h('p', { class: 'muted small' }, `${sideNames(x[x.winner === 'a' ? 'b' : 'a'])} ${x[x.winner === 'a' ? 'b' : 'a'].length > 1 ? 'confirm' : 'confirms'} the result. It confirms itself ${fmtWhen(x.confirmBy)}.`) : null,
        x.deltas ? h('p', { class: 'small' }, 'Tonament rating: ', [...x.a, ...x.b].map((p) => `${p.name} ${x.deltas[p.id] >= 0 ? '+' : ''}${x.deltas[p.id]}`).join(' · ')) : null,
        h('div', { class: 'actions' },
          x.can.confirm ? h('button', { class: 'btn btn-primary', onclick: () => post('confirm', {}, 'Result confirmed') }, x.status === 'disputed' ? 'Keep this result' : `Confirm ${x.summary}`) : null,
          x.can.dispute ? h('button', { class: 'btn btn-ghost', onclick: () => confirm('Say this result is wrong? It won\'t count.') && post('dispute', {}, 'Marked as disputed') }, 'Something\'s wrong') : null,
          x.can.back ? h('button', { class: x.me && x.me !== x.winner ? 'btn btn-primary' : 'btn', onclick: back }, x.me && x.me !== x.winner ? 'Challenge back 😤' : 'Play again') : null)) : null,
      ['declined', 'expired', 'cancelled'].includes(x.status) && x.can.back ? h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: back }, 'Challenge again')) : null,
      x.score && x.rallies ? gamesTable(m) : null,
    ];
  }

  // ---------- goals: personal, a club's total, or club v club
  const goalLeft = (g) => (g.ended ? 'Finished' : `${g.daysLeft} day${g.daysLeft === 1 ? '' : 's'} left`);
  const goalWhat = (g) => `${g.metric}${g.sport ? ` · ${g.sport.name}` : ''}`;
  // A goal as a card: progress bar (or the two clubs' totals), and a link.
  function goalCard(g) {
    const pct = (v, t) => `width:${Math.min(100, t ? (v / t) * 100 : 0)}%`;
    return h('a', { class: 'card goal-card', href: `/goals/${g.id}` },
      h('p', { class: 'eyebrow' }, [g.scope === 'versus' ? 'Club v club' : g.scope === 'club' ? 'Club goal' : 'Goal', goalWhat(g), goalLeft(g)].join(' · ')),
      h('strong', { class: 'goal-title' }, g.title),
      g.scope === 'versus'
        ? h('div', { class: 'goal-versus' }, [g.club, g.rival].map((o) => h('span', { class: 'goal-side' }, h('span', {}, o.name), h('strong', {}, o.total))))
        : [h('span', { class: 'progress' }, h('span', { style: g.scope === 'club' ? pct(g.total, g.target) : pct(g.me ? g.me.value : 0, g.target) })),
          h('small', { class: 'muted' }, g.scope === 'club' ? `${g.total} of ${g.target} together` : g.me ? `You: ${g.me.value} of ${g.target}` : `${g.people} chasing it`)]);
  }

  // ---------- runs: log one, totals, best efforts, this week with the people you follow
  function viewRuns() {
    document.title = 'Runs · Tonament';
    const R = S.runs;
    const d = (S.runDraft ||= { km: '', time: '', date: localToday(), title: '', place: '', visibility: 'public' });
    const reload = async () => { S.runs = await api('GET', '/runs'); };
    const form = h('form', {
      class: 'card form run-form',
      onsubmit: (e) => {
        e.preventDefault();
        const today = d.date === localToday();
        act(async () => {
          const r = await api('POST', '/runs', {
            km: Number(d.km), time: d.time, title: d.title || null, place: d.place || null, visibility: d.visibility,
            ranAt: today ? new Date().toISOString() : new Date(`${d.date}T07:00:00`).toISOString(),
          });
          S.runDraft = null;
          await reload();
          S.lastRun = r;
        }, 'Run logged 🏃');
      },
    },
    h('h2', {}, 'Log a run'),
    h('div', { class: 'run-row' },
      field('Distance (km)', h('input', { type: 'number', step: '0.01', min: '0.1', max: '300', required: true, inputmode: 'decimal', placeholder: '5', value: d.km, oninput: (e) => { d.km = e.target.value; } })),
      field('Time', h('input', { required: true, placeholder: '28:30', pattern: '\\d{1,2}(:\\d{2}){1,2}|\\d+', inputmode: 'numeric', value: d.time, oninput: (e) => { d.time = e.target.value; } }), null, 'mm:ss or h:mm:ss')),
    field('Day', h('input', { type: 'date', max: localToday(), value: d.date, oninput: (e) => { d.date = e.target.value; } })),
    field('Name', h('input', { maxlength: 80, placeholder: 'Sunday long run', value: d.title, oninput: (e) => { d.title = e.target.value; } })),
    field('Where', h('input', { maxlength: 80, placeholder: 'Marina Beach', value: d.place, oninput: (e) => { d.place = e.target.value; } })),
    groupField('Who sees it', choiceGroup({ name: 'runVis', label: 'Who sees it', value: d.visibility, options: [{ value: 'public', label: 'Everyone' }, { value: 'followers', label: 'Followers' }, { value: 'private', label: 'Only me' }], onchange: (e) => { d.visibility = e.target.value; } })),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Log it')));
    const last = S.lastRun;
    const shareRun = (r) => shareSheet({ title: 'My run', text: `${r.km} km in ${r.time} (${r.pace} /km)${r.pbs && r.pbs.length ? ` — a new best ${r.pbs.join(' and ')}! 🏃` : ' 🏃'}`, url: r.post ? `${location.origin}/a/${r.post.id}` : `${location.origin}/runs`, image: r.post && r.post.public ? `/img/a/${r.post.id}.png` : null });
    const stat = (label, t) => h('div', { class: 'run-stat' }, h('small', { class: 'muted' }, label), h('strong', {}, `${t.km} km`), h('small', { class: 'muted' }, `${t.runs} run${t.runs === 1 ? '' : 's'}`));
    return [
      h('div', { class: 'card-head page-head' }, h('h1', {}, 'Runs'), h('a', { class: 'btn', href: '/goals/new' }, 'Set a km goal')),
      last ? h('div', { class: 'card cc-result' },
        h('p', { class: 'eyebrow' }, last.pbs.length ? `New best · ${last.pbs.join(', ')}` : 'Logged'),
        h('div', { class: 'cc-score' }, h('strong', {}, `${last.time} · ${last.pace} /km`), h('span', { class: 'cc-big' }, `${last.km} km`)),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', onclick: () => shareRun(last) }, 'Share it'), h('button', { class: 'btn btn-ghost', onclick: () => { S.lastRun = null; render(); } }, 'Log another'))) : form,
      R == null ? loading() : [
        h('div', { class: 'run-stats' }, stat('This week', R.week), stat('This month', R.month), stat('This year', R.year)),
        h('div', { class: 'card' }, h('h2', {}, 'This week'),
          R.board.length > 1 ? h('ol', { class: 'entries run-board' }, R.board.map((b) => h('li', { class: b.me ? 'me' : '' },
            b.handle ? h('a', { href: `/@${b.handle}` }, b.name) : h('span', {}, b.name), h('strong', {}, `${b.km} km`))))
            : h('p', { class: 'muted' }, 'Follow friends who run and you\'ll see who\'s run the most this week — you against them.')),
        R.bests.length ? h('div', { class: 'card' }, h('h2', {}, 'Best efforts'),
          h('div', { class: 'run-bests' }, R.bests.map((b) => h('div', { class: 'run-stat' }, h('small', { class: 'muted' }, b.name), h('strong', {}, b.time), h('small', { class: 'muted' }, `${b.pace} /km`)))),
          h('p', { class: 'muted small' }, 'Your fastest pace over a run at least that long.')) : null,
        R.recent.length ? h('div', { class: 'card' }, h('h2', {}, 'Your runs'),
          h('ul', { class: 'cc-list' }, R.recent.map((r) => h('li', {},
            h('strong', {}, `${r.km} km`), h('span', { class: 'muted small' }, ` · ${r.time} · ${r.pace} /km · ${fmtDates(new Date(r.ranAt).toISOString().slice(0, 10))}${r.title ? ` · ${r.title}` : ''}`),
            r.visibility !== 'public' ? h('small', { class: 'muted' }, r.visibility === 'private' ? ' 🔒' : ' 👥') : null,
            h('button', { class: 'link-btn small', style: 'margin-left:auto', onclick: () => confirm('Delete this run?') && act(async () => { await api('DELETE', `/runs/${r.id}`); await reload(); }, 'Run deleted') }, 'Delete'))))) : null,
      ],
    ];
  }

  function viewGoals() {
    document.title = 'Goals · Tonament';
    const G = S.goals;
    return [
      h('div', { class: 'card-head page-head' }, h('h1', {}, 'Goals'), h('a', { class: 'btn btn-primary', href: '/goals/new' }, 'New goal')),
      h('p', { class: 'muted' }, '“30 games this month”, a club target, or your club against another. Every confirmed game counts — groups, challenges and tournaments.'),
      G == null ? loading() : [
        G.active.length ? h('section', { class: 'section' }, h('h2', {}, 'On now'), h('div', { class: 'card-list' }, G.active.map(goalCard))) : empty('No goals yet — set one, and invite friends to chase it with you.'),
        G.past.length ? h('section', { class: 'section' }, h('h2', {}, 'Finished'), h('div', { class: 'card-list' }, G.past.map(goalCard))) : null,
      ],
    ];
  }

  function viewGoalNew() {
    document.title = 'New goal · Tonament';
    const d = (S.goalDraft ||= { scope: 'personal', metric: 'games', sport: '', period: 'month', target: 30, club: new URLSearchParams(location.search).get('club') || '' });
    const mine = (S.goalClubs || []).filter((c) => c.role === 'admin' && c.status === 'active');
    const now = new Date();
    const periods = {
      week: [now, new Date(now.getFullYear(), now.getMonth(), now.getDate() + (7 - now.getDay()) % 7 + 1)],
      month: [now, new Date(now.getFullYear(), now.getMonth() + 1, 1)],
      days30: [now, new Date(Date.now() + 30 * 86400000)],
    };
    const form = h('form', {
      class: 'card form new-flow',
      onsubmit: (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const [startsAt, endsAt] = periods[d.period];
        act(async () => {
          const g = await api('POST', '/goals', {
            scope: d.scope, metric: d.metric, sport: d.sport || null, target: fd.get('target') ? Number(fd.get('target')) : null,
            club: fd.get('club') || null, rival: fd.get('rival') || null, title: fd.get('title') || null, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
          });
          S.goalDraft = null;
          navigate(`/goals/${g.id}`);
        }, 'Goal set — share it so others join in');
      },
    },
    h('h1', {}, 'New goal'),
    groupField('Who', choiceGroup({ name: 'scope', label: 'Who', value: d.scope, options: [
      { value: 'personal', label: 'Me (and friends)', hint: 'Everyone who joins chases the target' },
      { value: 'club', label: 'Our club', hint: 'Members add up to one total', disabled: !mine.length },
      { value: 'versus', label: 'Club v club', hint: 'Whose members play more', disabled: !mine.length },
    ], onchange: (e) => { d.scope = e.target.value; render(); } }), null, mine.length ? null : 'Club goals are set by a club\'s admins.'),
    d.scope !== 'personal' ? field('Club', h('select', { name: 'club', required: true }, mine.map((c) => h('option', { value: c.slug, selected: c.slug === d.club }, c.name)))) : null,
    d.scope === 'versus' ? field('Against', h('input', { name: 'rival', required: true, placeholder: 'Their club address, e.g. velachery-smashers', pattern: '[a-z0-9-]{3,30}' }), null, 'The part after tonament.com/club/ on their club page.') : null,
    groupField('Count', choiceGroup({ name: 'metric', label: 'Count', value: d.metric, options: [{ value: 'games', label: 'Games played' }, { value: 'wins', label: 'Games won' }, { value: 'km', label: 'Km run' }, { value: 'runs', label: 'Runs' }], onchange: (e) => { d.metric = e.target.value; render(); } })),
    ['km', 'runs'].includes(d.metric) ? null : field('Sport', h('select', { name: 'sport', onchange: (e) => { d.sport = e.target.value; } }, h('option', { value: '' }, 'Any sport'), (S.sports || []).filter((x) => x.status === 'live').map((x) => h('option', { value: x.id, selected: x.id === d.sport }, x.name)))),
    d.scope !== 'versus' ? field('Target', h('input', { name: 'target', type: 'number', min: 1, max: 100000, required: true, value: d.target, inputmode: 'numeric' }), null, d.scope === 'club' ? 'For the whole club, together.' : 'For each person.') : null,
    groupField('When', choiceGroup({ name: 'period', label: 'When', value: d.period, options: [{ value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }, { value: 'days30', label: 'Next 30 days' }], onchange: (e) => { d.period = e.target.value; } })),
    field('Name (optional)', h('input', { name: 'title', maxlength: 80, placeholder: 'e.g. November grind' })),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Set the goal')));
    return form;
  }

  function viewGoal() {
    const g = S.goal;
    if (!g || g.id !== S.route.id) return loading();
    document.title = `${g.title} · Goal`;
    const share = () => shareSheet({ title: g.title, text: g.scope === 'versus' ? `${g.title} — ${g.club.name} ${g.club.total}, ${g.rival.name} ${g.rival.total}. Every game counts:` : `${g.title} — join me:`, url: `${location.origin}/goals/${g.id}`, image: `/img/goal/${g.id}.png` });
    const post = (what, msg) => act(async () => { S.goal = await api('POST', `/goals/${g.id}/${what}`); }, msg);
    const max = Math.max(1, ...g.board.map((p) => p.value), g.target || 0);
    return [
      h('p', {}, h('a', { class: 'back-link', href: '/goals' }, '← Goals')),
      h('div', { class: 'card goal-head' },
        h('p', { class: 'eyebrow' }, [g.scope === 'versus' ? 'Club v club' : g.scope === 'club' ? `${g.club.name} goal` : 'Goal', goalWhat(g), goalLeft(g)].join(' · ')),
        h('h1', {}, g.title),
        g.scope === 'versus' ? h('div', { class: 'goal-versus big' }, [g.club, g.rival].map((o) => h('a', { class: 'goal-side', href: `/club/${o.slug}` }, h('span', {}, o.name), h('strong', {}, o.total))))
          : g.scope === 'club' ? [h('p', { class: 'goal-big' }, `${g.total}`, h('small', {}, ` / ${g.target} ${g.metric}`)), h('span', { class: 'progress' }, h('span', { style: `width:${Math.min(100, (g.total / g.target) * 100)}%` }))]
            : g.me ? [h('p', { class: 'goal-big' }, `${g.me.value}`, h('small', {}, ` / ${g.target} ${g.metric}`)), h('span', { class: 'progress' }, h('span', { style: `width:${Math.min(100, (g.me.value / g.target) * 100)}%` }))] : null,
        h('div', { class: 'actions' },
          g.can.join ? h('button', { class: 'btn btn-primary', onclick: () => post('join', 'You\'re in — every game counts') }, 'Join the goal') : null,
          !S.me && g.scope === 'personal' && !g.ended ? h('a', { class: 'btn btn-primary', href: `/signup?next=${encodeURIComponent(`/goals/${g.id}`)}` }, 'Join free') : null,
          h('button', { class: 'btn', onclick: share }, 'Share'),
          g.can.leave ? h('button', { class: 'btn btn-ghost', onclick: () => confirm('Leave this goal?') && post('leave', 'You left the goal') }, 'Leave') : null)),
      h('div', { class: 'card' }, h('h2', {}, g.scope === 'personal' ? `Chasing it (${g.people})` : 'Who\'s counting'),
        g.board.length ? h('ol', { class: 'entries goal-board' }, g.board.map((p, i) => h('li', { class: S.me && p.id === S.me.id ? 'me' : '' },
          h('span', { class: 'seed' }, i + 1),
          h('span', { class: 'name' }, p.handle ? h('a', { href: `/p/${p.handle}` }, p.name) : p.name,
            g.scope === 'versus' ? h('small', { class: 'contact' }, p.side === g.club.id ? g.club.name : g.rival.name) : null,
            h('span', { class: 'progress' }, h('span', { style: `width:${(p.value / max) * 100}%` }))),
          h('strong', { class: 'goal-value' }, g.scope === 'personal' && g.target && p.value >= g.target ? `${p.value} 🏅` : p.value)))) : empty('Nobody yet.'),
        h('p', { class: 'hint' }, ['km', 'runs'].includes(g.metric) ? 'Counts runs logged on Tonament since the goal started.' : 'Counts confirmed group games, challenges and tournament matches played since the goal started.')),
    ];
  }

  // ---------- notifications
  function viewNotifications() {
    document.title = 'Notifications · Tonament';
    const list = S.inbox;
    const open = (n) => { if (n.url) navigate(n.url); };
    return [
      h('div', { class: 'card-head page-head' }, h('h1', {}, 'Notifications')),
      list == null ? loading() : list.items.length
        ? h('ul', { class: 'card feed inbox' }, list.items.map((n) => h('li', { class: `feed-item${n.read ? '' : ' unread'}` },
          h('span', { class: 'feed-avatar', 'aria-hidden': 'true' }, n.actor ? n.actor.name.slice(0, 1) : '🔔'),
          h('button', { class: 'inbox-open', type: 'button', onclick: () => open(n) },
            h('span', { class: 'feed-text' }, n.title),
            n.body ? h('small', { class: 'muted' }, n.body) : null,
            h('small', { class: 'muted' }, ago(n.at))))))
        : empty('Nothing yet. Comments, kudos, new followers and results to confirm show up here.'),
      notifySettingsCard(),
      phoneCard(),
    ];
  }

  // Your mobile number, for WhatsApp messages and signing in with a code.
  // Hidden until WhatsApp or SMS is switched on for the site.
  function phoneCard() {
    const P = S.phone;
    if (!P || !P.available) return null;
    const refresh = async () => { [S.phone, S.notifySettings] = await Promise.all([api('GET', '/me/phone'), api('GET', '/notifications/settings')]); };
    if (P.phone) {
      return h('div', { class: 'card' }, h('h2', {}, 'Your mobile'),
        h('p', {}, h('strong', {}, P.phone), h('small', { class: 'muted' }, ' · confirmed')),
        P.channels.whatsapp ? h('label', { class: 'check-field' },
          h('input', { type: 'checkbox', checked: P.whatsapp, onchange: (e) => act(async () => { await api('PATCH', '/me/phone', { whatsapp: e.target.checked }); await refresh(); }, e.target.checked ? 'WhatsApp messages on' : 'WhatsApp messages off') }),
          h('span', {}, 'Send me messages on WhatsApp (pick which ones above)')) : null,
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-small btn-ghost', onclick: () => act(async () => { await api('PATCH', '/me/phone', { remove: true }); await refresh(); }, 'Number removed') }, 'Remove number')));
    }
    const draft = S.phoneDraft || (S.phoneDraft = { phone: '', code: '', whatsapp: true, sent: null });
    const send = () => act(async () => { draft.sent = await api('POST', '/auth/otp/request', { phone: draft.phone, purpose: 'verify' }); }, null);
    const verify = () => act(async () => {
      await api('POST', '/auth/otp/verify', { phone: draft.phone, code: draft.code, purpose: 'verify', whatsapp: P.channels.whatsapp && draft.whatsapp });
      S.phoneDraft = null;
      await refresh();
    }, 'Number confirmed ✓');
    return h('div', { class: 'card' }, h('h2', {}, 'Your mobile'),
      h('p', { class: 'muted small' }, 'Add your number to sign in with a code and, if you like, get messages on WhatsApp.'),
      draft.sent
        ? h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); verify(); } },
          h('label', {}, `The 6-digit code we sent to ${draft.sent.to}`,
            h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, value: draft.code, oninput: (e) => { draft.code = e.target.value; } })),
          P.channels.whatsapp ? h('label', { class: 'check-field' }, h('input', { type: 'checkbox', checked: draft.whatsapp, onchange: (e) => { draft.whatsapp = e.target.checked; } }), h('span', {}, 'Also send me messages on WhatsApp')) : null,
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Confirm'),
            h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { draft.sent = null; render(); } }, 'Change number')))
        : h('form', { class: 'form', onsubmit: (e) => { e.preventDefault(); send(); } },
          h('label', {}, 'Mobile number', h('input', { name: 'phone', type: 'tel', autocomplete: 'tel', placeholder: '98765 43210', value: draft.phone, oninput: (e) => { draft.phone = e.target.value; } })),
          h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send a code'))));
  }

  // Push on this phone, and which notifications come by push or email.
  function notifySettingsCard() {
    const st = S.notifySettings;
    if (!st) return null;
    const set = (kind, channel, on) => act(async () => { S.notifySettings = await api('PATCH', '/notifications/settings', { kind, channel, on }); });
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const pushOn = async () => {
      try {
        if ((await Notification.requestPermission()) !== 'granted') { toast('Notifications are blocked for Tonament in your browser settings', true); return; }
        const reg = await navigator.serviceWorker.ready;
        const key = Uint8Array.from(atob(st.push.publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (st.push.publicKey.length % 4)) % 4)), (c) => c.charCodeAt(0));
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        S.notifySettings = await api('POST', '/notifications/push', sub.toJSON());
        S.pushHere = true;
        toast('Notifications on for this phone ✓');
      } catch (e) {
        toast(e.message || 'Couldn\'t turn notifications on', true);
      }
      render();
    };
    const pushOff = async () => {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { await api('DELETE', '/notifications/push', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
      S.pushHere = false;
      S.notifySettings = await api('GET', '/notifications/settings');
      render();
    };
    if (supported && st.push.available && S.pushHere === undefined) {
      S.pushHere = null;
      navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((sub) => { S.pushHere = Boolean(sub); render(); }).catch(() => { S.pushHere = false; });
    }
    return h('div', { class: 'card' },
      h('h2', {}, 'Settings'),
      st.push.available && supported
        ? h('div', { class: 'card-head' }, h('span', {}, h('strong', {}, 'On this phone'), h('small', { class: 'muted', style: 'display:block' }, S.pushHere ? 'Notifications are on' : 'Get a notification when something happens')),
          S.pushHere ? h('button', { class: 'btn btn-small btn-ghost', onclick: pushOff }, 'Turn off') : h('button', { class: 'btn btn-small btn-primary', onclick: pushOn, disabled: S.pushHere === null }, 'Turn on'))
        : h('p', { class: 'muted small' }, st.push.available ? 'This browser can\'t show notifications. Add Tonament to your home screen to get them.' : 'You\'ll see everything here; phone notifications are coming soon.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'notify-prefs' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), st.push.available ? h('th', { class: 'num' }, 'Phone') : null, st.email ? h('th', { class: 'num' }, 'Email') : null, st.whatsapp ? h('th', { class: 'num' }, 'WhatsApp') : null)),
        h('tbody', {}, st.kinds.map((k) => h('tr', {},
          h('td', {}, k.label),
          st.push.available ? h('td', { class: 'num' }, h('input', { type: 'checkbox', checked: k.push, 'aria-label': `${k.label} on your phone`, onchange: (e) => set(k.kind, 'push', e.target.checked) })) : null,
          st.email ? h('td', { class: 'num' }, h('input', { type: 'checkbox', checked: k.email, 'aria-label': `${k.label} by email`, onchange: (e) => set(k.kind, 'email', e.target.checked) })) : null,
          st.whatsapp ? h('td', { class: 'num' }, h('input', { type: 'checkbox', checked: k.whatsapp, disabled: !st.whatsapp.optedIn, 'aria-label': `${k.label} on WhatsApp`, onchange: (e) => set(k.kind, 'whatsapp', e.target.checked) })) : null)))),
      st.whatsapp && !st.whatsapp.optedIn ? h('p', { class: 'muted small' }, 'To get messages on WhatsApp, confirm your mobile below and turn WhatsApp on.') : null));
  }

  // ---------- the feed
  const ago = (iso) => {
    const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 1440) return `${Math.floor(m / 60)} h ago`;
    const d = Math.floor(m / 1440);
    return d < 7 ? `${d} d ago` : new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
  };
  const personLink = (p) => (p ? (p.handle ? h('a', { href: `/p/${p.handle}` }, p.name) : h('strong', {}, p.name)) : 'Someone');
  const report = (kind, id) => {
    const reason = prompt('What\'s wrong? (optional)');
    if (reason === null) return;
    act(async () => { await api('POST', '/report', { kind, id, reason }); }, 'Thanks — we\'ll take a look');
  };

  function feedSentence(x) {
    const d = x.data || {};
    const who = personLink(x.people[0]);
    const amIn = S.me && x.people.some((p) => p.id === S.me.id);
    if (x.verb === 'finish') {
      return [d.finish === 'W' ? '🏆 ' : '🥈 ', who, d.finish === 'W' ? ' won ' : ' reached the final of ', h('strong', {}, d.event), ' at ', h('a', { href: `/t/${d.tournamentId}` }, d.tournament)];
    }
    if (x.verb === 'game') {
      const won = d.winner === 'a' ? d.a : d.b;
      const lost = d.winner === 'a' ? d.b : d.a;
      // The group's name only for people in the game (groups aren't public).
      return [h('strong', {}, won.join(' & ')), ' beat ', lost.join(' & '), ' ', h('span', { class: 'feed-score' }, d.score),
        amIn && d.slug ? [' · ', h('a', { href: `/g/${d.slug}` }, d.group)] : null];
    }
    if (x.verb === 'challenge') {
      const won = d.winner === 'a' ? d.a : d.b;
      const lost = d.winner === 'a' ? d.b : d.a;
      return ['⚔️ ', h('strong', {}, won.join(' & ')), ' beat ', lost.join(' & '), ' ', h('span', { class: 'feed-score' }, d.score), ` in a ${d.back ? 'rematch' : 'challenge'}`];
    }
    if (x.verb === 'goal') {
      if (d.rival) return ['🏆 ', h('a', { href: `/club/${d.slug}` }, d.club), ` beat ${d.rival} `, h('span', { class: 'feed-score' }, `${d.value}–${d.against}`), ' in ', h('a', { href: `/goals/${d.goal}` }, d.title)];
      if (d.club) return ['🏅 ', h('a', { href: `/club/${d.slug}` }, d.club), ' reached ', h('a', { href: `/goals/${d.goal}` }, d.title), ` — ${d.value} ${d.metric} together`];
      return ['🏅 ', who, ' reached ', h('a', { href: `/goals/${d.goal}` }, d.title)];
    }
    if (x.verb === 'goal_set') {
      return ['🎯 ', who, d.rival ? ` set ${d.club} v ${d.rival}: ` : ` set a goal for ${d.club}: `, h('a', { href: `/goals/${d.goal}` }, d.title), ' — every game counts'];
    }
    if (x.verb === 'ladder') {
      return ['🪜 ', who, ` climbed to #${d.to} on the `, h('a', { href: `/club/${d.slug}?tab=ladder` }, d.ladder), d.forfeit ? ` — ${d.beat} didn't answer in time` : [` — beat ${d.beat} `, h('span', { class: 'feed-score' }, d.score)]];
    }
    if (x.verb === 'club_v_club') {
      const club = (name, slug) => h('a', { href: `/club/${slug}` }, name);
      const winSlug = d.winner === d.from ? d.fromSlug : d.toSlug;
      const loseSlug = d.winner === d.from ? d.toSlug : d.fromSlug;
      return d.winner
        ? ['🏆 ', club(d.winner, winSlug), ' beat ', club(d.loser, loseSlug), ' ', h('a', { class: 'feed-score', href: `/cc/${d.id}` }, d.score), ` in a club v club ${d.kind === 'tie' ? 'tie' : 'friendly'}`]
        : ['🤝 ', club(d.from, d.fromSlug), ' and ', club(d.to, d.toSlug), ' drew ', h('a', { class: 'feed-score', href: `/cc/${d.id}` }, d.score)];
    }
    if (x.verb === 'motor') {
      return [d.place <= 3 ? `${MEDAL[d.place]} ` : '🏁 ', who, ` (#${d.number}) ${d.place === 1 ? 'won' : `finished P${d.place} in`} ${d.round} of `, h('a', { href: `/champ/${d.champ}` }, d.name), ` from P${d.grid}`, d.fastest ? ' · fastest lap ⏱️' : '', d.standing === 1 ? ' — leads the championship' : ''];
    }
    if (x.verb === 'motor_champ') {
      return ['🏆 ', h('strong', {}, `#${d.number} ${d.driver}`), ' is the ', h('a', { href: `/champ/${d.champ}` }, d.name), ` champion — ${d.points} points, ${d.wins} win${d.wins === 1 ? '' : 's'}`, d.team ? ` · ${d.team} take the teams' title` : ''];
    }
    if (x.verb === 'meet') {
      return [d.place <= 3 ? `${MEDAL[d.place]} ` : '🏁 ', who, ` ${d.place === 1 ? 'won' : `came ${ordinal(d.place)} in`} the ${d.event} at `, h('a', { href: `/meet/${d.meet}` }, d.name), ' — ', h('span', { class: 'feed-score' }, d.mark), d.pb ? ' · Personal best 🎉' : ''];
    }
    if (x.verb === 'meet_won') {
      return ['🏆 ', h('strong', {}, d.team), ' won ', h('a', { href: `/meet/${d.meet}` }, d.name), ` — ${d.points} points, ${d.gold} gold`];
    }
    if (x.verb === 'race') {
      return ['🏁 ', who, ` finished the ${d.event} at `, h('a', { href: `/race/${d.race}` }, d.name), ' in ', h('span', { class: 'feed-score' }, d.time), ` — ${ordinal(d.place)} of ${d.of}`, d.groupPlace === 1 ? ` · 1st in ${d.ageGroup} 🥇` : ''];
    }
    if (x.verb === 'race_new') {
      return ['🏁 ', who, ' put on ', h('a', { href: `/race/${d.race}` }, d.name), ` — ${d.distances.join(', ')}, ${raceWhen(d.at)}. Enter now.`];
    }
    if (x.verb === 'club_run') {
      const others = x.people.length - 1;
      return ['🏃 ', who, others > 0 ? ` and ${others} other${others === 1 ? '' : 's'}` : '', ' ran with ', h('a', { href: `/club/${d.slug}` }, d.club), ' · ', h('a', { href: `/club-run/${d.clubRun}` }, d.name)];
    }
    if (x.verb === 'run') {
      return ['🏃 ', who, ` ran ${d.km} km in ${d.time} at `, h('span', { class: 'feed-score' }, `${d.pace} /km`), d.club ? [' with ', h('a', { href: `/club-run/${d.clubRun}` }, d.club)] : d.title ? ` · ${d.title}` : '', d.place && !d.title && !d.club ? ` · ${d.place}` : '',
        d.pbs && d.pbs.length ? [' · ', h('strong', {}, `New best ${d.pbs.join(', ')} 🎉`)] : ''];
    }
    if (x.verb === 'season_match') {
      const club = (name, slug) => h('a', { href: `/club/${slug}` }, name);
      const season = h('a', { href: `/season/${d.id}` }, d.season);
      return d.winner
        ? ['🏁 ', club(d.winner, d.winnerSlug), ' beat ', club(d.loser, d.loserSlug), ' ', h('span', { class: 'feed-score' }, d.score), ' in ', season, ` · round ${d.round}`]
        : ['🏁 ', club(d.a, d.aSlug), ' and ', club(d.b, d.bSlug), ' drew ', h('span', { class: 'feed-score' }, d.score), ' in ', season];
    }
    if (x.verb === 'season_won') {
      return ['🏆 ', h('a', { href: `/club/${d.slug}` }, d.champion), ' won ', h('a', { href: `/season/${d.id}` }, d.season), ` — ${d.won} wins from ${d.played}, ${d.points} pts`];
    }
    if (x.verb === 'season_on') {
      return ['🏁 ', h('a', { href: `/season/${d.id}` }, d.season), ` is on — ${d.clubs} clubs, ${d.rounds} rounds. Fixtures are out.`];
    }
    if (x.verb === 'club_challenge') {
      return ['⚔️ ', h('a', { href: `/club/${d.fromSlug}` }, d.from), ' v ', h('a', { href: `/club/${d.toSlug}` }, d.to), ` is on — a ${d.kind === 'tie' ? 'team tie' : 'friendly'}`, d.playAt ? `, ${fmtWhen(d.playAt)}` : '', '. ', h('a', { href: `/cc/${d.id}` }, 'See the teams')];
    }
    if (x.verb === 'joined') return [who, ' joined ', h('a', { href: `/club/${d.slug}` }, d.club)];
    if (x.verb === 'club') return [who, ' started ', h('a', { href: `/club/${d.slug}` }, d.club), d.city ? ` in ${d.city}` : ''];
    return [who, ` ${x.verb}`];
  }

  // A feed item as plain text (for a WhatsApp message).
  const feedText = (x) => { const el = h('span', {}, feedSentence(x)); return el.textContent.replace(/\s+/g, ' ').trim(); };

  function feedItem(x) {
    const open = S.openComments === x.id;
    const kudo = () => act(async () => { Object.assign(x, await api('POST', `/activity/${x.id}/kudos`, { on: !x.kudoed })); });
    const toggle = async () => {
      S.openComments = open ? null : x.id;
      render();
      if (!open) { S.comments = { ...(S.comments || {}), [x.id]: await api('GET', `/activity/${x.id}/comments`).catch(() => []) }; render(); }
    };
    const list = (S.comments || {})[x.id];
    const p = x.people[0];
    return h('li', { class: 'feed-item' },
      p && p.photo ? h('img', { class: 'feed-avatar', src: p.photo, alt: '' }) : h('span', { class: 'feed-avatar', 'aria-hidden': 'true' }, (p ? p.name : '?').slice(0, 1)),
      h('div', { class: 'feed-body' },
        h('p', { class: 'feed-text' }, feedSentence(x)),
        h('p', { class: 'feed-meta muted small' }, ago(x.at),
          S.me ? [
            h('button', { class: `link-btn small${x.kudoed ? ' on' : ''}`, 'aria-pressed': String(x.kudoed), onclick: kudo }, `👏 ${x.kudos || ''}`.trim()),
            h('button', { class: 'link-btn small', 'aria-expanded': String(open), onclick: toggle }, `💬 ${x.comments || ''}`.trim()),
            moreButton('This post', [
              { label: 'Share', onClick: () => shareSheet({ title: 'Share', text: feedText(x), url: `${location.origin}/a/${x.id}`, image: x.public ? `/img/a/${x.id}.png` : null }) },
              { label: 'Report', onClick: () => report('activity', x.id) },
            ]),
          ] : (x.kudos ? ` · 👏 ${x.kudos}` : '')),
        x.verb === 'challenge' && S.me && x.data.winners && !x.data.winners.includes(S.me.id) && x.people.some((p) => p.id === S.me.id)
          ? h('p', { class: 'feed-cta' }, h('a', { class: 'btn btn-small', href: `/c/${x.data.challenge}` }, 'Challenge back 😤')) : null,
        open ? h('div', { class: 'feed-comments' },
          list == null ? loading() : h('ul', {}, list.map((c) => h('li', {}, h('strong', {}, c.by.name), ' ', c.body,
            c.mine ? h('button', { class: 'link-btn small', onclick: () => act(async () => { await api('DELETE', `/comments/${c.id}`); S.comments[x.id] = list.filter((y) => y.id !== c.id); x.comments -= 1; }) }, 'Delete') : null))),
          h('form', {
            class: 'feed-comment-form',
            onsubmit: (e) => {
              e.preventDefault();
              const box = e.target.body;
              act(async () => { S.comments[x.id] = await api('POST', `/activity/${x.id}/comments`, { body: box.value }); x.comments = S.comments[x.id].length; box.value = ''; });
            },
          }, h('input', { name: 'body', maxlength: 500, required: true, placeholder: 'Say well played…', 'aria-label': 'Comment' }), h('button', { class: 'btn btn-small', type: 'submit' }, 'Send'))) : null));
  }

  function feedList(feed, emptyText) {
    if (!feed) return loading();
    if (!feed.items.length) return empty(emptyText);
    return h('ul', { class: 'card feed' }, feed.items.map(feedItem));
  }

  // One shared item (/a/<id>), and a way in for people new to Tonament.
  function viewItem() {
    document.title = 'Tonament';
    const x = S.item;
    if (!x) return loading();
    if (x.error) return errorView('This post isn\'t available — it may be private, or it was removed.');
    return [
      h('ul', { class: 'card feed' }, feedItem(x)),
      S.me ? h('p', { class: 'center' }, h('a', { class: 'btn', href: '/' }, 'Your feed'))
        : h('div', { class: 'card center' }, h('h2', {}, 'Play, compete, share'),
          h('p', { class: 'muted' }, 'Tournaments, clubs and live scores for every sport — and a feed of your friends\' results.'),
          h('div', { class: 'actions', style: 'justify-content:center' }, h('a', { class: 'btn btn-primary btn-lg', href: '/signup' }, 'Join free'))),
    ];
  }

  // Home, signed in: the latest from people and clubs you follow.
  function homeFeed() {
    const f = S.feed;
    if (!f) return null;
    const shown = S.feedAll ? f.items : f.items.slice(0, 4);
    return h('section', { class: 'section' },
      h('div', { class: 'card-head' }, h('h2', {}, 'Your feed'), h('a', { class: 'btn btn-small btn-ghost', href: '/clubs' }, 'Clubs')),
      f.items.length ? [h('ul', { class: 'card feed' }, shown.map(feedItem)),
        f.items.length > shown.length ? h('button', { class: 'link-btn small', onclick: () => { S.feedAll = true; render(); } }, 'See more') : null]
        : h('div', { class: 'card' }, h('p', { class: 'muted', style: 'margin:0' }, 'Join a club and follow players to see their titles, games and news here.'),
          h('div', { class: 'actions' }, h('a', { class: 'btn btn-primary btn-small', href: '/clubs' }, 'Find a club'), h('a', { class: 'btn btn-small', href: '/rankings' }, 'Find players'))));
  }

  // ---------- academy, venue and club pages (tonament.com/@slug)
  const ORG_KINDS = [
    { value: 'club', label: 'Club', icon: 'club', hint: 'Members who play together' },
    { value: 'team', label: 'Team', icon: 'team', hint: 'A squad that competes' },
    { value: 'academy', label: 'Academy', icon: 'academy', hint: 'Coaching and training' },
    { value: 'venue', label: 'Venue', icon: 'venue', hint: 'Courts to book and play' },
    { value: 'company', label: 'Company', icon: 'company', hint: 'Colleagues who play' },
    { value: 'school', label: 'School / college', icon: 'school', hint: 'Students and staff' },
    { value: 'coaching', label: 'Coaching squad', icon: 'coaching', hint: 'A coach and their players' },
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
    document.title = 'Start a club · Tonament';
    const d = (S.orgDraft ||= { step: 1, kind: null, name: '', slug: '', slugEdited: false, city: '', address: '', sports: [], check: null });
    const go = (step) => { d.step = step; render(); window.scrollTo(0, 0); };
    const head = h('div', { class: 'new-head' },
      d.step > 1 ? h('button', { type: 'button', class: 'back-link', onclick: () => go(d.step - 1) }, '← Back') : h('span'),
      h('span', { class: 'new-progress', 'aria-label': `Step ${d.step} of 3` }, `Step ${d.step} of 3`,
        h('span', { class: 'dots', 'aria-hidden': 'true' }, [1, 2, 3].map((n) => h('span', { class: n <= d.step ? 'on' : '' })))));

    if (d.step === 1) {
      return h('div', { class: 'card new-flow' }, head,
        h('h1', {}, 'Start a club'),
        h('p', { class: 'muted' }, `Free. Members join with your invite link, share their results and titles, climb the club leaderboard — and take on other clubs. Want a public page on Google with photos, coaching and contact buttons? Add it any time (${orgPrice()} a year).`),
        h('h2', {}, 'What kind?'),
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
      field('Club address', h('div', { class: 'slug-input' }, h('span', { class: 'muted' }, 'tonament.com/@'), slugInput), null, null),
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
    const create = h('button', { type: 'button', class: 'btn btn-primary btn-lg', disabled: !d.sports.length }, 'Start the club');
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
        const c = await api('POST', '/clubs', { kind: d.kind, name: d.name, slug: d.slug, city: d.city, address: d.address, country: REGIONS.defaultCountry, sports: d.sports });
        S.orgDraft = null;
        S.club = c;
        S.clubFeed = null;
        S.myOrgsFor = null;
        toast(`${c.name} is on Tonament — invite your players`);
        navigate(`/club/${c.slug}?tab=members`);
      } catch (err) {
        toast(err.message, true);
        create.disabled = false;
        if (err.status === 409 || /address/i.test(err.message)) go(2);
      }
    };
    return h('div', { class: 'card new-flow' }, head,
      h('h2', {}, 'Which sports?'),
      h('p', { class: 'muted small' }, `Tap all that ${d.name || 'you'} ${d.kind === 'venue' ? 'has courts for' : 'plays'}.`),
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
        h('h2', {}, 'Club page'),
        h('p', { class: 'muted small' }, `Run a club, team, academy or venue? Start a club on Tonament (free), and add a public page at tonament.com/@yourname with all your tournaments, contact buttons, coaching and photos — ${orgPrice()} a year.`),
        h('div', { class: 'actions' }, h('a', { class: 'btn btn-small', href: '/clubs/new' }, 'Start a club')));
    }
    const link = (slug) => act(async () => {
      const r = await api('POST', `${tPath(t)}/org`, { org: slug || null }, t.id);
      await load(t.id);
      toast(r.org ? `Shown on ${r.org.name}'s page` : 'Removed from the club page');
    });
    const options = [{ value: '', label: 'None' }, ...mine.map((x) => ({ value: x.slug, label: x.name }))];
    if (t.org && !mine.some((x) => x.slug === t.org.slug)) options.push({ value: t.org.slug, label: t.org.name, disabled: true });
    return h('div', { class: 'card' },
      h('h2', {}, 'Club page'),
      h('p', { class: 'muted small' }, 'Show this tournament on your club\'s page (when it\'s public).'),
      choiceGroup({ name: 'org', label: 'Club page', value: t.org ? t.org.slug : '', options, onchange: (e) => link(e.target.value) }),
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
        [A.stats, S.interest, A.funnel, A.cron] = await Promise.all([
          api('GET', '/admin/stats'), api('GET', '/sports/interest').catch(() => null),
          api('GET', `/admin/funnel?days=${A.funnelDays || 30}`).catch(() => null), api('GET', '/admin/cron').catch(() => null),
        ]);
        A.aiCredits = await api('GET', '/admin/ai-credits').catch(() => null);
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

  // The funnel: organisers who joined in the window and how far they got,
  // where sign-ups came from, what was done, and what messages cost.
  const SOURCE_CLASS = { referral: 'Invite links', shared: 'Shared links', campaign: 'Campaigns (utm)', social: 'Social apps', search: 'Search', web: 'Other sites', direct: 'Direct', unknown: 'Not recorded' };
  function adminFunnel() {
    const A = adminState();
    const f = A.funnel;
    if (!f) return null;
    const pick = (d) => { A.funnelDays = d; api('GET', `/admin/funnel?days=${d}`).then((r) => { A.funnel = r; render(); }).catch((e) => toast(e.message, true)); };
    const top = Math.max(1, f.stages[0].n);
    const a = f.activity;
    const jobs = A.cron ? A.cron.jobs : [];
    const when = (at) => (at ? new Date(at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'never');
    return h('section', { class: 'funnel' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Funnel'),
        choiceGroup({ name: 'funnel-days', label: 'Window', value: String(f.days), options: [7, 30, 90].map((d) => ({ value: String(d), label: `${d} days` })), onchange: (e) => pick(Number(e.target.value)) })),
      h('div', { class: 'chart-grid' },
        h('div', { class: 'card' }, h('h3', {}, 'Organisers who joined'),
          h('ul', { class: 'hbars funnel-stages' }, f.stages.map((x, i) => h('li', {},
            h('span', { class: 'hbar-label' }, x.label),
            h('span', { class: 'hbar-track' }, h('span', { class: 'hbar', style: `width:${(x.n / top) * 100}%` })),
            h('span', { class: 'num' }, x.n, i ? h('small', { class: 'muted' }, ` ${Math.round((x.n / top) * 100)}%`) : null)))),
          h('p', { class: 'muted small' }, 'People who signed up in the window, and how far they have got since (% of those who signed up).')),
        breakdown('Sign-ups by source', f.sources.map((r) => ({ key: r.class, n: r.n })), (k) => SOURCE_CLASS[k] || k),
        breakdown('Tournaments by organiser\'s source', f.tournamentSources.map((r) => ({ key: r.label, n: r.n })))),
      h('div', { class: 'stat-tiles' },
        [['Sign-ups', a.signups], ['Tournaments', a.tournaments], ['Players entered', a.players], ['Clubs', a.clubs], ['Club joins', a.members],
          ['Groups', a.groups], ['Group games', a.games], ['Challenges', a.challenges], ['Runs', a.runs], ['Races', a.races], ['Meets', a.meets]]
          .map(([label, n]) => h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, label), h('strong', {}, n)))),
      h('div', { class: 'chart-grid' },
        h('div', { class: 'card' }, h('h3', {}, 'Messages'),
          h('ul', { class: 'plain-list' }, ['email', 'whatsapp', 'sms'].map((c) => {
            const m = f.messages.find((x) => x.channel === c);
            const label = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' }[c];
            return h('li', {}, h('strong', {}, label), ' ',
              f.channels[c] ? h('span', { class: 'muted' }, m ? `${m.sent} sent${m.failed ? ` · ${m.failed} failed` : ''}${m.cost ? ` · ${money(m.cost)}` : ''}` : 'none sent') : pill('setup', 'Off'));
          }),
          f.ai ? h('li', {}, h('strong', {}, 'AI setup'), ' ', f.ai.enabled
            ? h('span', { class: 'muted' }, `${f.ai.drafts} draft${f.ai.drafts === 1 ? '' : 's'} · ${f.ai.mappings} import${f.ai.mappings === 1 ? '' : 's'}${f.ai.failed ? ` · ${f.ai.failed} failed` : ''} · ${money(f.ai.cost)} · ${f.ai.model}`)
            : pill('setup', 'Off')) : null)),
        A.aiCredits ? adminAiCredits(A) : null,
        h('div', { class: 'card' }, h('h3', {}, 'Scheduled jobs'),
          A.cron && !A.cron.secret ? h('p', { class: 'muted small' }, 'Set CRON_SECRET in the Vercel project so these run on their own.') : null,
          h('ul', { class: 'plain-list' }, jobs.map((j) => h('li', {}, h('span', {}, h('strong', {}, j.job), ' ',
            h('span', { class: 'muted' }, `last run ${when(j.at)}`), j.at ? [' ', j.ok ? pill('done', 'OK') : pill('failed', 'Failed')] : null),
            h('button', { class: 'btn btn-small btn-ghost', onclick: () => act(async () => { await api('POST', `/cron/${j.job}`, { force: true }); A.cron = await api('GET', '/admin/cron'); }, `${j.job} ran`) }, 'Run now')))))));
  }

  // AI credits: sold and used, revenue against Claude's cost, the busiest, alerts, pause.
  function adminAiCredits(A) {
    const x = A.aiCredits;
    const pause = (row, on) => act(async () => { await api('POST', `/admin/tournaments/${encodeURIComponent(row.id)}/ai-pause`, { paused: on }); A.aiCredits = await api('GET', '/admin/ai-credits'); }, on ? 'AI paused for that tournament' : 'AI back on');
    const alerted = new Set(x.alerts.map((a) => a.id));
    return h('div', { class: 'card' }, h('h3', {}, 'AI credits · 30 days'),
      !x.enforced ? h('p', { class: 'muted small' }, 'Not charged: payments aren\'t set up, so AI help is free.') : null,
      h('ul', { class: 'plain-list' },
        h('li', {}, h('strong', {}, 'Sold'), ' ', h('span', { class: 'muted' }, `${x.packs} pack${x.packs === 1 ? '' : 's'} · ${x.bought} credits · ${money(x.revenue)}`)),
        h('li', {}, h('strong', {}, 'Given'), ' ', h('span', { class: 'muted' }, `${x.given} credit${x.given === 1 ? '' : 's'} (free first setups, referrals, Championship)`)),
        h('li', {}, h('strong', {}, 'Used'), ' ', h('span', { class: 'muted' }, `${x.spent} credit${x.spent === 1 ? '' : 's'}${x.refunded ? ` · ${x.refunded} given back for failed calls` : ''}`)),
        h('li', {}, h('strong', {}, 'Claude\'s cost'), ' ', h('span', { class: 'muted' }, `${money(x.cost)}${x.revenue ? ` · ${Math.round(((x.revenue - x.cost) / x.revenue) * 100)}% margin` : ''}`))),
      x.alerts.length ? h('p', { class: 'banner info small' }, `${x.alerts.length} tournament${x.alerts.length === 1 ? ' is' : 's are'} using a lot of AI this hour — check below.`) : null,
      x.busy.length ? [h('h3', {}, 'Using the most'), h('ul', { class: 'plain-list' }, x.busy.map((r) => h('li', {},
        h('a', { href: `/t/${r.id}` }, r.name), ' ', h('span', { class: 'muted small' }, `${r.spent} credits · ${money(r.cost)}`),
        alerted.has(r.id) ? [' ', pill('failed', 'Busy')] : null, r.paused ? [' ', pill('setup', 'Paused')] : null,
        h('button', { class: 'btn btn-small btn-ghost', type: 'button', onclick: () => pause(r, !r.paused) }, r.paused ? 'Resume' : 'Pause'))))] : null);
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
    'tournament.ai': (x) => `gave AI credits (${({ both: 'Both', manage: 'On the day', create: 'Setup', topup: 'Top-up' })[x.detail.pack] || x.detail.pack}) · ${x.detail.name}`,
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
      adminFunnel(),
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
      const grantAi = () => actionSheet(`AI credits for ${t.name}`, [
        { label: 'Both (setup + on the day)', hint: '20 setup and 150 on-the-day credits', onClick: () => act(() => api('POST', `/admin/tournaments/${encodeURIComponent(t.id)}/ai-grant`, { pack: 'both' }), 'Given: AI setup + on the day') },
        { label: 'On the day', hint: '150 on-the-day credits', onClick: () => act(() => api('POST', `/admin/tournaments/${encodeURIComponent(t.id)}/ai-grant`, { pack: 'manage' }), 'Given: AI on the day') },
        { label: 'Setup', hint: '20 setup credits', onClick: () => act(() => api('POST', `/admin/tournaments/${encodeURIComponent(t.id)}/ai-grant`, { pack: 'create' }), 'Given: AI setup') },
      ]);
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
          S.aiEnabled ? h('button', { class: 'btn btn-small', onclick: () => grantAi() }, 'Give AI credits') : null,
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
  // Is AI working? The key (set or not, never shown), the model, the last
  // day's calls, and a free test call.
  function adminAiStatus(A) {
    if (A.ai === undefined) { A.ai = null; api('GET', '/admin/ai').then((r) => { A.ai = r; render(); }).catch(() => { A.ai = false; render(); }); }
    const x = A.ai;
    const test = async (btn) => {
      btn.disabled = true;
      btn.textContent = 'Testing…';
      try {
        const r = await api('POST', '/admin/ai-test', {});
        toast(r.ok ? `AI works ✓ ${r.model} answered in ${r.seconds}s` : 'AI answered, but not as expected', !r.ok);
      } catch (e) { toast(`AI test failed: ${e.message}`, true); }
      A.ai = undefined;
      render();
    };
    const secs = (ms) => `${Math.round(ms / 100) / 10}s`;
    return [h('h2', {}, 'AI'),
      !x ? (x === false ? h('p', { class: 'muted small' }, 'Couldn\'t load AI status.') : loading())
        : [h('ul', { class: 'plain-list' },
          h('li', {}, h('strong', {}, 'Key'), ' ', h('span', { class: 'muted' }, x.enabled ? `set · model ${x.model}` : 'not set — add ANTHROPIC_API_KEY to the environment and redeploy')),
          h('li', {}, h('strong', {}, 'Last 24 hours'), ' ', h('span', { class: 'muted' }, x.day.calls
            ? `${x.day.calls} call${x.day.calls === 1 ? '' : 's'} · ${x.day.failed} failed · ${secs(x.day.avgMs)} average, ${secs(x.day.maxMs)} slowest · ${money(x.day.cost)}`
            : 'no calls')),
          h('li', {}, h('strong', {}, '30 days'), ' ', h('span', { class: 'muted' }, `${x.drafts} setups · ${x.mappings} form imports · ${x.assists} assistant messages · ${money(x.cost)}`))),
        x.enabled ? h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: (e) => test(e.currentTarget) }, 'Test AI')) : null,
        h('p', { class: 'hint' }, 'The test is a tiny call (no credits used). To try the assistant on a tournament, give it AI credits from the Tournaments tab.')]];
  }

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
      adminAiStatus(A),
      h('h2', {}, 'AI prices'),
      (() => {
        const p = { create: 9900, manage: 19900, both: 24900, topup: 9900, ...(A.settings.aiPrices || {}) };
        const form = h('form', { class: 'form grid-2', onsubmit: (e) => {
          e.preventDefault();
          const v = Object.fromEntries(['create', 'manage', 'both', 'topup'].map((k) => [k, Math.round(Number(form[k].value) * 100)]));
          act(async () => { A.settings = await api('PATCH', '/admin/settings', { aiPrices: v }); }, 'AI prices saved');
        } },
        [['create', 'AI setup'], ['manage', 'AI on the day'], ['both', 'Both'], ['topup', 'Top-up (100 credits)']].map(([k, label]) => field(`${label} (₹)`, h('input', { name: k, type: 'number', min: 1, step: 1, value: p[k] / 100 }))),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save prices')));
        return form;
      })(),
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
  const APP_PATH = /^\/(?:$|play$|compete$|you$|t\/|new$|invite$|templates$|signin$|signup$|forgot$|reset$|link$|admin$|groups(?:\/new)?$|g\/|academy\/new$|clubs(?:\/new|\/rankings)?$|club\/|a\/\d+$|notifications$|challenges(?:\/new)?$|c\/\d+$|cc\/\d+$|season\/\d+$|goals(?:\/new|\/\d+)?$|runs$|races(?:\/new)?$|race\/\d+$|meets(?:\/new)?$|meet\/\d+$|champs(?:\/new)?$|champ\/\d+$|club-run\/\d+$|me\/profile$|@[a-z0-9-]+\/edit$)/;
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

  // ---------- staying up to date
  // An app opened from the home screen usually just resumes the copy still in
  // memory, so a new release wouldn't show until a manual refresh. Whenever the
  // app comes back on screen (and every 15 minutes while it's open) it checks
  // the live release; if it's newer it reloads at once — unless something is
  // being typed or points are still being sent, when it offers a Reload bar.
  let loadedVersion = null;
  const liveVersion = () => fetch('/api/version', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((x) => x && x.version).catch(() => null);
  const unsent = () => isEditing() || [...queues.values(), ...gQueues.values()].some((q) => q.length);
  function updateBar() {
    if (document.querySelector('.update-bar')) return;
    document.body.append(h('div', { class: 'update-bar', role: 'status' },
      h('span', {}, 'A new version of Tonament is ready.'),
      h('button', { class: 'btn btn-small btn-primary', type: 'button', onclick: () => (unsent() && !confirm('Something isn\'t saved yet. Reload anyway?') ? null : location.reload()) }, 'Reload')));
  }
  async function checkForUpdate() {
    const v = await liveVersion();
    if (!v) return;
    if (!loadedVersion) { loadedVersion = v; return; }
    if (v === loadedVersion) return;
    if (!unsent() && !document.hidden) location.reload();
    else updateBar();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    checkForUpdate();
    navigator.serviceWorker?.getRegistration().then((reg) => reg && reg.update()).catch(() => {});
  });
  window.addEventListener('pageshow', (e) => { if (e.persisted) checkForUpdate(); }); // back from the browser's page cache
  setInterval(() => { if (!document.hidden) checkForUpdate(); }, 15 * 60000);
  checkForUpdate(); // remembers the release this page loaded

  // ---------- boot
  // The service worker lets the installed app open with no connection (public/sw.js).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { /* fine without it */ }));
  }
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
    S.gift = me.gift || null;
    S.emailEnabled = Boolean(me.emailEnabled);
    S.phoneEnabled = Boolean(me.phoneEnabled);
    S.aiEnabled = Boolean(me.aiEnabled);
    route();
    loadInviter();
  });
})();
