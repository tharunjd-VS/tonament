'use strict';

(() => {
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');

  const S = {
    route: { name: 'home' },
    me: null, // signed-in user
    emailEnabled: false, // can the server send email (password reset, invites)?
    mine: null, // tournaments I'm on the team of
    members: null, // team list for the open tournament (managers only)
    interest: null, // { counts: { sportId: n }, mine: [sportId] } for "Request this sport"
    sports: [],
    list: null,
    t: null,
    error: null,
    connected: false,
    seq: 0, // bumped on every change we make, so stale poll results are dropped
    offline: false, // scoring requests are waiting for the connection to come back
    draft: '',
    pendingRender: false,
  };

  const ROLE_NAMES = { admin: 'Site admin', owner: 'Owner', organiser: 'Organiser', umpire: 'Umpire' };
  const STATUS = { setup: 'Setting up', league: 'League stage', knockout: 'Knockout stage', completed: 'Completed' };

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
      toast(e.message, true);
    }
    render();
  }

  function copy(text, message) {
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast(message), () => window.prompt('Copy this link:', text));
    else window.prompt('Copy this link:', text);
  }

  const tPath = (t) => `/tournaments/${encodeURIComponent(t.id)}`;
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
  const enteredKey = (id) => `tonament:entered:${id}`;
  const nameOf = (p) => (p ? p.name : 'TBD');
  const pow2 = (n) => { let s = 2; while (s < n) s *= 2; return s; };
  const field = (label, control, cls, hint) =>
    h('label', { class: `field ${cls || ''}` }, h('span', { class: 'label' }, label), control, hint ? h('small', { class: 'hint' }, hint) : null);
  const empty = (text) => h('div', { class: 'empty' }, text);
  const loading = () => h('div', { class: 'loading' }, 'Loading…');
  const pill = (cls, label) => h('span', { class: `pill ${cls}` }, label);
  const connDot = () => h('span', { class: `conn ${S.connected ? 'on' : ''}` }, S.connected ? 'Live' : 'Connecting…');

  function isEditing() {
    const a = document.activeElement;
    return Boolean(a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'radio');
  }

  // ---------- routing
  async function route() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [pathPart, qs] = raw.split('?');
    const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
    const params = new URLSearchParams(qs || '');
    const prev = S.route;
    S.error = null;

    if (parts[0] === 't' && parts[1]) {
      const id = parts[1];
      const key = params.get('key');
      if (key) {
        keys.set(id, key);
        history.replaceState(null, '', `#/${parts.map(encodeURIComponent).join('/')}`);
      }
      S.route = parts[2] === 'm' ? { name: 'match', id, mid: Number(parts[3]) } : { name: 'tournament', id, tab: parts[2] || null };
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
          location.replace('#/signin?next=/new');
          return;
        }
        S.route = { name: 'new' };
      } else if (parts[0] === 'signin' || parts[0] === 'signup') {
        S.route = { name: parts[0], next: params.get('next') || '/', email: params.get('email') || '' };
      } else if (parts[0] === 'forgot') {
        S.route = { name: 'forgot', email: params.get('email') || '', sent: false };
      } else if (parts[0] === 'reset') {
        S.route = { name: 'reset', token: params.get('token') || '' };
        history.replaceState(null, '', '#/reset'); // keep the token out of history
      } else if (parts[0] === 'admin') {
        S.route = { name: 'admin', users: null };
        render();
        [S.route.users, S.interest] = await Promise.all([
          api('GET', '/admin/users').catch((e) => { S.error = e.message; return []; }),
          api('GET', '/sports/interest').catch(() => null),
        ]);
      } else {
        S.route = { name: 'home' };
        S.list = null;
        render();
        [S.list, S.mine, S.interest] = await Promise.all([
          api('GET', '/tournaments').catch((e) => { S.error = e.message; return []; }),
          S.me ? api('GET', '/me/tournaments').catch(() => []) : null,
          api('GET', '/sports/interest').catch(() => null),
        ]);
      }
    }
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
    }
  }

  function mergeMatch(m) {
    if (!S.t) return;
    const i = S.t.matches.findIndex((x) => x.id === m.id);
    if (i >= 0) S.t.matches[i] = m;
  }

  // ---------- live updates (polling)
  // Every viewer re-fetches the tournament: every 2s while a match is live,
  // otherwise every 5s, and slowly when the tab is in the background. Public
  // responses are cached by the CDN for 1s, so spectators share one fetch.
  let pollTimer;
  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    if (!S.t) return;
    const live = S.t.matches.some((m) => m.status === 'live');
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
      if (/not found/i.test(e.message)) {
        toast('This tournament was deleted');
        location.hash = '#/';
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
  function render(soft = false) {
    if (soft && isEditing()) {
      S.pendingRender = true;
      return;
    }
    S.pendingRender = false;
    let view;
    if (S.error) view = errorView(S.error);
    else if (S.route.name === 'new') view = viewNew();
    else if (S.route.name === 'signin' || S.route.name === 'signup') view = viewAuth();
    else if (S.route.name === 'forgot') view = viewForgot();
    else if (S.route.name === 'reset') view = viewReset();
    else if (S.route.name === 'admin') view = viewAdmin();
    else if (S.route.name === 'tournament') view = S.t ? viewTournament() : loading();
    else if (S.route.name === 'match') view = S.t ? viewMatch() : loading();
    else view = viewHome();
    app.replaceChildren(...[view].flat(Infinity).filter(Boolean));
    renderNav();
  }

  app.addEventListener('focusout', () => setTimeout(() => {
    if (S.pendingRender && !isEditing()) render();
  }, 0));

  function errorView(message) {
    document.title = 'Tonament';
    return h('div', { class: 'card center' },
      h('h2', {}, 'Something went wrong'),
      h('p', { class: 'muted' }, message),
      h('a', { class: 'btn', href: '#/' }, 'Back to home'));
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
            ? h('a', { class: 'btn btn-primary btn-lg', href: '#/new' }, 'Create tournament')
            : h('a', { class: 'btn btn-primary btn-lg', href: '#/signup' }, 'Get started — it\'s free'),
          h('a', { class: 'btn btn-lg btn-ghost', href: '#/', onclick: explore }, 'Explore tournaments'))),
      sportsSection(),
      S.me ? h('section', { class: 'section' },
        h('h2', {}, 'My tournaments'),
        S.mine == null ? loading()
          : S.mine.length === 0 ? empty('Tournaments you create, or are added to as an organiser or umpire, show up here.')
            : h('div', { class: 'card-list' }, S.mine.map((t) => tournamentCard(t, ROLE_NAMES[t.role])))) : null,
      h('section', { class: 'section', id: 'all-tournaments' },
        h('h2', {}, S.me ? 'All tournaments' : 'Tournaments'),
        S.list == null ? loading()
          : S.list.length === 0 ? empty('No tournaments yet — create the first one.')
            : h('div', { class: 'card-list' }, S.list.map((t) => tournamentCard(t)))),
    ];
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
          : [h('a', { href: '#/signin?next=/' }, 'Sign in'), ' to request a sport. The most requested sports get built first.']));
  }

  async function requestSport(s, want) {
    if (!S.me) {
      location.hash = '#/signin?next=/';
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
    return h('a', { class: 'card t-card', href: `#/t/${t.id}` },
      h('div', { class: 'card-head' },
        h('h3', {}, t.name),
        h('span', {}, roleName ? pill('org', roleName) : null, ' ', pill(t.status, STATUS[t.status]))),
      h('div', { class: 'muted small' }, [sport ? sport.name : t.sport, t.formatName, `${t.entries} entries`, t.venue].filter(Boolean).join(' · ')));
  }

  // ---------- create / settings
  const FORMATS = [
    ['league_knockout', 'League + Knockout', 'Groups play round-robin; the top finishers go into a knockout bracket.'],
    ['league', 'League only', 'Everyone in a group plays each other; the table decides the winner.'],
    ['knockout', 'Knockout only', 'Single elimination, seeded in entry order. Byes go to top seeds.'],
  ];

  function settingsFields(sport, v) {
    return [
      h('fieldset', { class: 'formats' }, h('legend', {}, 'Format'),
        FORMATS.map(([value, label, desc]) => h('label', { class: 'format-option' },
          h('input', { type: 'radio', name: 'format', value, checked: v.format === value, onchange: (e) => syncFormat(e.target.form) }),
          h('span', {}, h('strong', {}, label), h('small', {}, desc))))),
      h('div', { class: 'grid-2' },
        field('Players per group (about)', h('input', { type: 'number', name: 'groupSize', min: 2, max: 16, value: v.groupSize ?? 4, required: true }), 'groups-field',
          'Groups are made from the final head-count when you start.'),
        field('Qualify from each group', h('input', { type: 'number', name: 'qualifiers', min: 1, max: 8, value: v.qualifiers, required: true }), 'qualifiers-field')),
      h('fieldset', { class: 'entry-settings' }, h('legend', {}, 'Entries'),
        h('label', { class: 'check-field' },
          h('input', { type: 'checkbox', name: 'selfEntry', checked: v.selfEntry !== false }),
          h('span', {}, h('strong', {}, 'Players can enter themselves'), h('small', {}, 'Adds an "Enter this tournament" form to the public page. You can still add people yourself.'))),
        field('Entries close (optional)', h('input', { type: 'datetime-local', name: 'entriesCloseAt', value: toLocalInput(v.entriesCloseAt) }), null,
          'Leave empty to keep entries open until you start the tournament.'),
        h('label', { class: 'check-field' },
          h('input', { type: 'checkbox', name: 'lateEntry', checked: Boolean(v.lateEntry) }),
          h('span', {}, h('strong', {}, 'Allow late entries after the start'), h('small', {}, 'Latecomers join the smallest group with catch-up matches, or take a bye in a knockout. You can change this during the event.')))),
      h('fieldset', {}, h('legend', {}, `${sport.name} scoring`),
        h('div', { class: 'grid-3' }, sport.fields.map((f) => field(f.label,
          f.type === 'select'
            ? h('select', { name: `scoring.${f.key}`, value: v.scoring[f.key] }, f.options.map((o) => h('option', { value: o.value }, o.label)))
            : h('input', { type: 'number', name: `scoring.${f.key}`, min: f.min, max: f.max, value: v.scoring[f.key], required: true }),
          null, f.hint)))),
    ];
  }

  function syncFormat(form) {
    const fmt = form.querySelector('input[name=format]:checked')?.value;
    form.querySelector('.groups-field').hidden = fmt === 'knockout';
    form.querySelector('.qualifiers-field').hidden = fmt !== 'league_knockout';
  }

  function readSettings(form, sport) {
    const fd = new FormData(form);
    const scoring = {};
    for (const f of sport.fields) scoring[f.key] = Number(fd.get(`scoring.${f.key}`));
    return {
      name: fd.get('name'),
      venue: fd.get('venue'),
      format: fd.get('format'),
      groupSize: Number(fd.get('groupSize')),
      qualifiers: Number(fd.get('qualifiers')),
      selfEntry: fd.get('selfEntry') === 'on',
      entriesCloseAt: fd.get('entriesCloseAt') ? new Date(fd.get('entriesCloseAt')).toISOString() : '',
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
          const body = { sport: form.sport.value, ...readSettings(form, sport) };
          const { id } = await api('POST', '/tournaments', body);
          toast('Tournament created — now add your players');
          location.hash = `#/t/${id}`;
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      },
    },
    h('h1', {}, 'New tournament'),
    field('Tournament name', h('input', { name: 'name', required: true, maxlength: 80, placeholder: 'e.g. Club Championship 2026', autocomplete: 'off' })),
    h('div', { class: 'grid-2' },
      field('Sport', h('select', { name: 'sport' }, S.sports.map((s) => h('option', {
        value: s.id,
        disabled: s.status !== 'live',
      }, s.status === 'live' ? s.name : `${s.name} (coming soon)`))), null,
      h('span', {}, 'More sports are on the way — ', h('a', { href: '#/' }, 'request yours on the home page'), '.')),
      field('Venue (optional)', h('input', { name: 'venue', maxlength: 80, placeholder: 'e.g. City Sports Hall' }))),
    settingsFields(sport, { format: 'league_knockout', groupSize: 4, qualifiers: 2, selfEntry: true, entriesCloseAt: null, lateEntry: false, scoring: sport.defaults }),
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
    if (t.can.manage) tabs.push({ id: 'team', label: 'Team' });
    return tabs;
  }

  function viewTournament() {
    const t = S.t;
    document.title = `${t.name} · Tonament`;
    const tabs = tabsWithTeam(t);
    const active = tabs.some((x) => x.id === S.route.tab) ? S.route.tab : tabs[0].id;
    const panels = { entries: panelEntries, live: panelLive, groups: panelGroups, bracket: panelBracket, team: panelTeam };
    return [
      h('header', { class: 't-header' },
        h('div', { class: 't-title' }, h('h1', {}, t.name), pill(t.status, STATUS[t.status])),
        h('p', { class: 'muted small' },
          [t.sport.name, t.formatName, t.venue, entryStatusLine(t)].filter(Boolean).join(' · '), '  ', connDot())),
      roleBar(t),
      h('nav', { class: 'tabs' }, tabs.map((x) => h('a', { href: `#/t/${t.id}/${x.id}`, class: x.id === active ? 'active' : '' }, x.label))),
      h('section', {}, panels[active](t)),
    ];
  }

  // ----- entries tab
  function entryStatusLine(t) {
    if (t.status !== 'setup') return null;
    if (t.entriesOpen) {
      return t.config.entriesCloseAt ? `Entries open · close ${fmtWhen(t.config.entriesCloseAt)}` : 'Entries open';
    }
    return t.config.selfEntry ? 'Entries closed' : null;
  }

  function panelEntries(t) {
    const setup = t.status === 'setup';
    const editable = t.can.manage && setup;
    const running = t.status === 'league' || t.status === 'knockout';
    const usingCheckIn = setup && t.entries.some((e) => e.checkedIn);
    const hereCount = t.entries.filter((e) => e.checkedIn).length;
    const groupLabel = (g) => (g == null || t.format === 'knockout' ? null : h('span', { class: 'pill' }, `Group ${String.fromCharCode(65 + g)}`));
    const tags = (e) => [
      e.source === 'self' ? pill('', 'Self-entered') : e.source === 'walk-in' ? pill('', 'Walk-in') : null,
      !setup && e.withdrawn ? pill('withdrawn', 'Withdrew') : null,
      !setup && !e.inDraw ? pill('', 'Didn\'t show') : null,
    ];

    const list = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, editable && usingCheckIn ? `Entries · ${hereCount} of ${t.entries.length} here` : `Entries (${t.entries.length})`),
        editable && t.entries.length ? h('span', { class: 'actions' },
          h('button', { class: 'btn btn-small btn-ghost', onclick: () => checkInAll(t, !usingCheckIn) }, usingCheckIn ? 'Clear check-in' : 'Check in all'),
          t.entries.length > 1 ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => shuffle(t) }, '🔀 Random draw') : null) : null),
      t.entries.length
        ? h('ol', { class: 'entries' }, t.entries.map((e, i) => h('li', { class: `${!setup && (e.withdrawn || !e.inDraw) ? 'out' : ''}${usingCheckIn && !e.checkedIn ? ' not-here' : ''}` },
          editable
            ? h('button', {
              class: `check${e.checkedIn ? ' on' : ''}`,
              'aria-pressed': String(e.checkedIn),
              'aria-label': `${e.name} ${e.checkedIn ? 'is checked in' : 'is not checked in'}`,
              title: e.checkedIn ? 'Checked in — tap to undo' : 'Tap when they arrive',
              onclick: () => checkIn(t, e, !e.checkedIn),
            }, e.checkedIn ? '✓' : '')
            : null,
          h('span', { class: 'seed' }, i + 1),
          h('span', { class: 'name' },
            h('span', { class: 'entry-name' }, e.name),
            e.contact ? h('small', { class: 'contact' }, e.contact) : null,
            h('span', { class: 'entry-tags' }, tags(e), groupLabel(e.group))),
          editable ? h('span', { class: 'row-actions' },
            h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': `Move ${e.name} up`, disabled: i === 0, onclick: () => move(t, i, -1) }, '↑'),
            h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': `Move ${e.name} down`, disabled: i === t.entries.length - 1, onclick: () => move(t, i, 1) }, '↓'),
            h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${e.name}`, onclick: () => removeEntry(t, e) }, '✕')) : null,
          t.can.manage && running && e.inDraw && !e.withdrawn
            ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => withdrawEntry(t, e) }, 'Withdraw')
            : null)))
        : empty(editable ? 'No entries yet. Add players or pairs above.' : 'No entries yet.'),
      editable && t.entries.length
        ? h('p', { class: 'hint', style: 'margin:8px 0 0' },
          'On the day, tick players as they arrive — once anyone is ticked, only ticked players go into the draw. List order is the seeding (1 = top seed).')
        : null);

    if (!t.can.manage) {
      return [
        setup && t.entriesOpen ? publicEntryCard(t) : null,
        setup && !t.entriesOpen
          ? h('div', { class: 'banner info' }, t.config.selfEntry ? 'Entries are closed. The draw will appear here once the tournament starts.' : 'The organiser is still adding players. The draw will appear here once the tournament starts.')
          : null,
        list,
      ];
    }
    if (!setup) return [running ? lateEntryCard(t) : null, list];
    return [addEntriesForm(t, usingCheckIn), list, startCard(t), settingsCard(t)];
  }

  function addEntriesForm(t, walkIn) {
    const ta = h('textarea', {
      name: 'names', rows: walkIn ? 2 : 4,
      placeholder: 'One player or pair per line, e.g.\nAsha Rao\nLee / Chan',
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
          S.t = await api('POST', `${tPath(t)}/entries`, { names, walkIn }, t.id);
          S.draft = '';
        }, `Added ${names.length} ${names.length === 1 ? 'entry' : 'entries'}`);
      },
    },
    h('h2', {}, walkIn ? 'Add walk-ins' : 'Add players or pairs'),
    walkIn ? h('p', { class: 'muted small' }, 'Walk-ins are checked in automatically.') : null,
    ta,
    h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add')));
  }

  // "Enter this tournament" for players (no account needed).
  function publicEntryCard(t) {
    let entered = null;
    try { entered = localStorage.getItem(enteredKey(t.id)); } catch { /* storage unavailable */ }
    const closes = t.config.entriesCloseAt ? `Entries close ${fmtWhen(t.config.entriesCloseAt)}.` : 'Entries close when the draw is made.';
    if (entered) {
      return h('div', { class: 'card entry-card' },
        h('h2', {}, 'You\'re entered ✓'),
        h('p', {}, h('strong', {}, entered), ' is on the entry list. See you on the day!'),
        h('p', { class: 'muted small', style: 'margin:0' }, `Something wrong? Contact the organiser. ${closes}`));
    }
    const form = h('form', {
      class: 'card form entry-card',
      onsubmit: async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const body = Object.fromEntries(new FormData(form));
          const res = await api('POST', `${tPath(t)}/register`, body);
          try { localStorage.setItem(enteredKey(t.id), res.name || body.name); } catch { /* fine */ }
          toast('You\'re entered — see you there!');
          refresh();
          render();
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      },
    },
    h('div', {},
      h('h2', {}, 'Enter this tournament'),
      h('p', { class: 'muted small', style: 'margin:0' }, closes)),
    h('div', { class: 'grid-2' },
      field('Your name', h('input', { name: 'name', required: true, maxlength: 40, autocomplete: 'name' })),
      field('Partner (doubles only)', h('input', { name: 'partner', maxlength: 40, autocomplete: 'off' }))),
    field('Phone or email', h('input', { name: 'contact', required: true, maxlength: 120, autocomplete: 'email' }), null,
      'Only the organisers see this, in case they need to reach you.'),
    // honeypot: hidden from people, filled in by bots
    h('label', { class: 'hp', 'aria-hidden': 'true' }, 'Website', h('input', { name: 'website', tabindex: '-1', autocomplete: 'off' })),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, 'Enter')));
    return form;
  }

  function lateEntryCard(t) {
    const setLate = (on) => act(async () => { S.t = await api('PATCH', tPath(t), { lateEntry: on }, t.id); }, on ? 'Late entries allowed' : 'Late entries switched off');
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
            act(async () => { S.t = await api('POST', `${tPath(t)}/late-entry`, { name }, t.id); }, `${name} added`);
          },
        }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add late entry'))
        : null,
      h('p', { class: 'muted small', style: 'margin:8px 0 0' },
        how || 'The knockout has started — late entries could only join during the group stage.'));
  }

  function checkIn(t, e, here) {
    act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/check-in`, { here }, t.id); });
  }
  function checkInAll(t, here) {
    act(async () => { S.t = await api('POST', `${tPath(t)}/check-in-all`, { here }, t.id); }, here ? 'Everyone checked in' : 'Check-in cleared');
  }
  function withdrawEntry(t, e) {
    if (!confirm(`Withdraw ${e.name}? Their remaining matches become walkovers. This can't be undone.`)) return;
    act(async () => { S.t = await api('POST', `${tPath(t)}/entries/${e.id}/withdraw`, {}, t.id); }, `${e.name} withdrawn`);
  }

  function saveOrder(t, ids, msg) {
    act(async () => { S.t = await api('PUT', `${tPath(t)}/entries/order`, { ids }, t.id); }, msg);
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
  function removeEntry(t, e) {
    act(async () => { S.t = await api('DELETE', `${tPath(t)}/entries/${e.id}`, undefined, t.id); }, `Removed ${e.name}`);
  }

  function planText(t, n) {
    const { qualifiers: q } = t.config;
    if (t.format === 'knockout') {
      if (n < 2) return 'Needs at least 2 entries.';
      const size = pow2(n);
      const byes = size - n;
      return `${n} entries → ${size}-draw knockout, ${Math.log2(size)} rounds${byes ? `, ${byes} bye${byes > 1 ? 's' : ''} for top seeds` : ''}.`;
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
    const here = t.entries.filter((e) => e.checkedIn).length;
    const usingCheckIn = here > 0;
    const n = usingCheckIn ? here : t.entries.length;
    const absent = t.entries.length - here;
    return h('div', { class: 'card' },
      h('h2', {}, 'Ready to start?'),
      usingCheckIn ? h('p', { class: 'muted small' }, `${here} checked in${absent ? ` · ${absent} not here (left out of the draw)` : ''}`) : null,
      h('p', { class: 'plan' }, planText(t, n)),
      h('p', { class: 'muted small' }, 'Starting makes the draw and fixtures. You can redo the draw until the first point is played.'),
      h('button', {
        class: 'btn btn-primary btn-lg',
        onclick: () => {
          const msg = usingCheckIn && absent
            ? `Start with the ${here} checked-in entries? ${absent} not checked in will be left out.`
            : 'Start the tournament now?';
          if (!confirm(msg)) return;
          act(async () => { S.t = await api('POST', `${tPath(t)}/start`, {}, t.id); location.hash = `#/t/${t.id}/live`; }, 'Tournament started — good luck!');
        },
      }, 'Start tournament'));
  }

  function settingsCard(t) {
    const sport = S.sports.find((s) => s.id === t.sport.id);
    if (!sport) return null;
    const form = h('form', {
      class: 'form',
      onsubmit: (e) => {
        e.preventDefault();
        act(async () => { S.t = await api('PATCH', tPath(t), readSettings(form, sport), t.id); }, 'Settings saved');
      },
    },
    h('div', { class: 'grid-2' },
      field('Tournament name', h('input', { name: 'name', required: true, maxlength: 80, value: t.name })),
      field('Venue', h('input', { name: 'venue', maxlength: 80, value: t.venue || '' }))),
    settingsFields(sport, { format: t.format, ...t.config }),
    h('div', { class: 'actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save settings')));
    syncFormat(form);
    return h('details', { class: 'card' }, h('summary', {}, `Settings · ${t.formatName}`), form);
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
            location.hash = '#/';
          }, 'Tournament deleted');
        },
      }, 'Delete tournament'));
  }

  // ----- live tab
  const stageOrder = (m) => (m.stage === 'knockout' ? 1 : 0);
  const byOrder = (x, y) => stageOrder(x) - stageOrder(y) || x.round - y.round || (x.group ?? 0) - (y.group ?? 0) || x.slot - y.slot;

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
      stageBanner(t),
      redrawCard(t),
      matchSection(t, 'On court now', live, 'No matches in progress.', true),
      upcoming.length || t.status !== 'completed' ? matchSection(t, 'Up next', upcoming, 'Nothing scheduled right now.') : null,
      matchSection(t, 'Latest results', results, 'No results yet.'),
    ];
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
          act(async () => { S.t = await api('POST', `${tPath(t)}/redraw`, {}, t.id); location.hash = `#/t/${t.id}/entries`; }, 'Draw undone — add players and start again');
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
              S.t = await api('POST', `${tPath(t)}/knockout`, {}, t.id);
              location.hash = `#/t/${t.id}/bracket`;
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
      m.court ? `Court ${m.court}` : null,
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
    return h('a', { class: `match-card ${m.status}`, href: `#/t/${t.id}/m/${m.id}` },
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
            h('thead', {}, h('tr', {}, ['#', 'Player', 'P', 'W', 'L', 'Games', 'Pts'].map((c, i) => h('th', { class: i === 1 ? '' : 'num', title: c === 'Pts' ? 'Point difference' : null }, c)))),
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
    return h('a', { ...attrs, href: `#/t/${t.id}/m/${m.id}` }, line('a'), line('b'), m.status === 'live' ? h('span', { class: 'b-live' }, 'LIVE') : null);
  }

  // ---------- match page (scoreboard + umpire controls)
  function stageOpen(t, m) {
    return m.stage === 'league' ? t.status === 'league' : t.status === 'knockout';
  }
  function canScore(t, m) {
    return t.can.score && m.a && m.b && (m.status === 'scheduled' || m.status === 'live') && stageOpen(t, m);
  }

  function viewMatch() {
    const t = S.t;
    const confirmed = t.matches.find((x) => x.id === S.route.mid);
    if (!confirmed) return errorView('Match not found.');
    const m = withPending(t, confirmed);
    if (pendingOps(m.id).length && !sending.has(m.id)) sendQueue(t, m.id); // resume after navigating away
    document.title = `${nameOf(m.a)} v ${nameOf(m.b)} · ${t.name}`;
    const backTab = m.stage === 'knockout' ? 'bracket' : 'live';
    return [
      h('a', { class: 'back', href: `#/t/${t.id}/${backTab}` }, `← ${t.name}`),
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
      const flag = live ? (sc.matchPoint[s] ? 'Match point' : sc.gamePoint[s] ? 'Game point' : null) : null;
      return h('div', { class: `sb-row side-${s}${won ? ' won' : ''}` },
        h('div', { class: 'sb-serve' }, live && sc.server === s ? h('span', { class: 'serve', title: 'Serving' }) : null),
        h('div', { class: 'sb-name' }, nameOf(p), flag ? h('span', { class: 'flag' }, flag) : null, won ? h('span', { class: 'flag' }, 'Winner') : null),
        h('div', { class: 'sb-games', title: 'Games won' }, sc.gamesWon[s]),
        h('div', { class: 'sb-points' }, m.status === 'done' || m.status === 'bye' ? '' : cur[s]));
    };
    return h('div', { class: 'scoreboard' }, row('a'), row('b'),
      live && sc.server
        ? h('div', { class: 'sb-foot' }, `Game ${sc.games.length} · ${nameOf(m[sc.server])} to serve from the ${sc.serveCourt} court`)
        : m.status === 'done' ? h('div', { class: 'sb-foot' }, m.summary) : null);
  }

  function scorer(t, m) {
    const fresh = m.rallies === 0;
    const btn = (s) => h('button', {
      class: `score-btn side-${s}`,
      onclick: () => rally(t, m, s),
      'aria-label': `Point to ${m[s].name}`,
    }, h('span', { class: 'sbtn-plus' }, '+1'), h('span', { class: 'sbtn-name' }, m[s].name));

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
      h('thead', {}, h('tr', {}, h('th', {}, ''), games.map((_, i) => h('th', { class: 'num' }, `Game ${i + 1}`)))),
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
  const confirmedMatch = (mid) => S.t && S.t.matches.find((x) => x.id === mid);

  // The match as the umpire should see it: confirmed state plus queued taps.
  function withPending(t, m) {
    const ops = pendingOps(m.id);
    const sport = window.TonamentSports && window.TonamentSports[t.sport.id];
    if (!ops.length || !sport) return m;
    let log = m.log;
    for (const op of ops) log = op.type === 'rally' ? log + op.side : log.slice(0, -1);
    const score = sport.compute(log, t.config.scoring, m.firstServer);
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
    const confirmed = S.t.matches.find((x) => x.id === S.route.mid);
    if (!confirmed) return;
    const m = withPending(S.t, confirmed);
    const k = e.key.toLowerCase();
    if ((k === 'a' || k === 'arrowleft') && canScore(S.t, m)) rally(S.t, m, 'a');
    else if ((k === 'l' || k === 'arrowright') && canScore(S.t, m)) rally(S.t, m, 'b');
    else if ((k === 'z' || k === 'backspace') && m.rallies && (canScore(S.t, m) || m.status === 'done')) undo(S.t, m);
    else return;
    e.preventDefault();
  });


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
        !S.me ? h('span', { class: 'muted' }, ' (via a share link — ', h('a', { href: `#/signin?next=${encodeURIComponent(`/t/${t.id}`)}` }, 'sign in'), ' to keep it in your account)') : null),
      h('button', { class: 'btn btn-small btn-ghost', onclick: () => copy(`${location.origin}/#/t/${t.id}`, 'Public link copied') }, 'Copy public link'));
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
        linkRow('Public link', 'Anyone can follow live scores.', `${location.origin}/#/t/${t.id}`, 'Public link copied')) : null,
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
        h('a', { class: 'btn btn-small btn-primary', href: '#/new' }, 'New tournament'),
        h('details', { class: 'menu' },
          h('summary', { class: 'avatar', title: S.me.email, 'aria-label': 'Account menu' }, initials(S.me.name)),
          h('div', { class: 'menu-panel' },
            h('div', { class: 'menu-head' }, h('strong', {}, S.me.name), h('div', { class: 'muted small' }, S.me.email)),
            h('a', { href: '#/', onclick: closeMenu }, 'My tournaments'),
            S.me.isAdmin ? h('a', { href: '#/admin', onclick: closeMenu }, 'Admin · users') : null,
            h('button', { onclick: signOut }, 'Sign out'),
            h('div', { class: 'menu-theme' }, 'Theme', themeSwitch()))),
      ]
      : [
        h('a', { class: 'nav-link', href: '#/signin' }, 'Sign in'),
        h('a', { class: 'btn btn-small btn-primary', href: '#/signup' }, 'Sign up'),
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
    if (location.hash === '#/' || location.hash === '') route();
    else location.hash = '#/';
  }

  const safeNext = (next) => (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') ? next : '/');

  function viewAuth() {
    const signup = S.route.name === 'signup';
    document.title = `${signup ? 'Sign up' : 'Sign in'} · Tonament`;
    const next = safeNext(S.route.next);
    if (S.me) {
      setTimeout(() => { location.hash = `#${next}`; });
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
          location.hash = `#${next}`;
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
        href: '#/forgot',
        onclick: (e) => {
          e.preventDefault();
          const email = form.querySelector('input[name=email]').value;
          location.hash = `#/forgot${email ? `?email=${encodeURIComponent(email)}` : ''}`;
        },
      }, 'Forgot password?')),
    btn,
    h('p', { class: 'center small', style: 'margin:0' },
      signup ? 'Already have an account? ' : 'New to Tonament? ',
      h('a', { href: `#/${signup ? 'signin' : 'signup'}?next=${encodeURIComponent(next)}` }, signup ? 'Sign in' : 'Create an account')));
    return form;
  }

  function viewForgot() {
    document.title = 'Reset password · Tonament';
    if (!S.emailEnabled) {
      return h('div', { class: 'card auth-card' },
        h('h1', {}, 'Forgot your password?'),
        h('p', { class: 'muted' }, 'Password reset by email isn\'t set up on this site yet. Please contact the site admin.'),
        h('a', { class: 'btn', href: '#/signin' }, 'Back to sign in'));
    }
    if (S.route.sent) {
      return h('div', { class: 'card auth-card' },
        h('h1', {}, 'Check your email'),
        h('p', {}, 'If an account exists for ', h('strong', {}, S.route.email), ', we\'ve sent a link to reset its password. It works once and expires in 1 hour.'),
        h('p', { class: 'muted small' }, 'Nothing there? Check your spam folder, or try again in a minute.'),
        h('a', { class: 'btn', href: '#/signin' }, 'Back to sign in'));
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
    h('p', { class: 'center small', style: 'margin:0' }, h('a', { href: '#/signin' }, 'Back to sign in')));
  }

  function viewReset() {
    document.title = 'Choose a new password · Tonament';
    if (!S.route.token) {
      return h('div', { class: 'card auth-card' },
        h('h1', {}, 'Link not valid'),
        h('p', { class: 'muted' }, 'This reset link is incomplete. Open the link from your email again, or request a new one.'),
        h('a', { class: 'btn', href: '#/forgot' }, 'Request a new link'));
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
          location.hash = '#/';
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

  function viewAdmin() {
    document.title = 'Admin · Tonament';
    if (!S.me || !S.me.isAdmin) return errorView('Site admins only.');
    const users = S.route.users;
    const counts = (S.interest && S.interest.counts) || {};
    const requested = S.sports.filter((s) => s.status !== 'live').map((s) => ({ ...s, n: counts[s.id] || 0 })).sort((a, b) => b.n - a.n);
    return [h('div', { class: 'card' },
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

  // ---------- boot
  window.addEventListener('hashchange', route);
  Promise.all([
    api('GET', '/sports').catch(() => []),
    api('GET', '/auth/me').catch(() => ({ user: null })),
  ]).then(([list, me]) => {
    S.sports = list;
    S.me = me.user;
    S.emailEnabled = Boolean(me.emailEnabled);
    route();
  });
})();
