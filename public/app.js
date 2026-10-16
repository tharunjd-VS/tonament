'use strict';

(() => {
  const app = document.getElementById('app');
  const toastEl = document.getElementById('toast');

  const S = {
    route: { name: 'home' },
    sports: [],
    list: null,
    t: null,
    error: null,
    connected: false,
    seq: 0, // bumped on every change we make, so stale poll results are dropped
    pending: false,
    draft: '',
    pendingRender: false,
  };

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
    // Public reads are shared through the CDN cache; organiser reads use a
    // distinct URL so they never receive (or populate) the public copy.
    if (key && method === 'GET') path += `${path.includes('?') ? '&' : '?'}admin=1`;
    const res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
      if (!S.t || S.t.id !== id || key) {
        S.t = null;
        render();
        await load(id);
        if (S.t) schedulePoll();
        if (key && S.t && !S.t.isAdmin) {
          keys.remove(id);
          toast('That organiser link is not valid', true);
        }
      }
    } else {
      clearTimeout(pollTimer);
      S.t = null;
      if (parts[0] === 'new') {
        S.route = { name: 'new' };
      } else {
        S.route = { name: 'home' };
        S.list = null;
        render();
        S.list = await api('GET', '/tournaments').catch((e) => { S.error = e.message; return []; });
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
      if (S.t && S.t.id === id && S.seq === seq && !S.pending) {
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
    else if (S.route.name === 'tournament') view = S.t ? viewTournament() : loading();
    else if (S.route.name === 'match') view = S.t ? viewMatch() : loading();
    else view = viewHome();
    app.replaceChildren(...[view].flat(Infinity).filter(Boolean));
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
    document.title = 'Tonament — tournaments, scored live';
    return [
      h('section', { class: 'hero' },
        h('h1', {}, 'Run your tournament. ', h('span', { class: 'accent' }, 'Score it live.')),
        h('p', { class: 'lead' }, 'Draw groups, play a round-robin league, send the best into a knockout bracket — and let everyone follow every point as it happens.'),
        h('ul', { class: 'features' },
          ['🏸 Badminton', 'League + Knockout', 'Live point-by-point scoring', 'Auto standings & bracket'].map((x) => h('li', {}, x))),
        h('a', { class: 'btn btn-primary btn-lg', href: '#/new' }, 'Create a tournament')),
      h('section', { class: 'section' },
        h('h2', {}, 'Tournaments'),
        S.list == null ? loading()
          : S.list.length === 0 ? empty('No tournaments yet — create the first one.')
            : h('div', { class: 'card-list' }, S.list.map(tournamentCard))),
    ];
  }

  function tournamentCard(t) {
    const sport = S.sports.find((s) => s.id === t.sport);
    return h('a', { class: 'card t-card', href: `#/t/${t.id}` },
      h('div', { class: 'card-head' },
        h('h3', {}, t.name),
        h('span', {}, keys.get(t.id) ? pill('org', 'Organiser') : null, ' ', pill(t.status, STATUS[t.status]))),
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
        field('Number of groups', h('input', { type: 'number', name: 'groups', min: 1, max: 16, value: v.groups, required: true }), 'groups-field'),
        field('Qualify from each group', h('input', { type: 'number', name: 'qualifiers', min: 1, max: 8, value: v.qualifiers, required: true }), 'qualifiers-field')),
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
      groups: Number(fd.get('groups')),
      qualifiers: Number(fd.get('qualifiers')),
      scoring,
    };
  }

  function viewNew() {
    document.title = 'New tournament · Tonament';
    const sport = S.sports[0];
    if (!sport) return loading();
    const form = h('form', {
      class: 'card form',
      onsubmit: async (e) => {
        e.preventDefault();
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          const body = { sport: form.sport.value, ...readSettings(form, sport) };
          const { id, adminKey } = await api('POST', '/tournaments', body);
          keys.set(id, adminKey);
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
      field('Sport', h('select', { name: 'sport' }, S.sports.map((s) => h('option', { value: s.id }, s.name)))),
      field('Venue (optional)', h('input', { name: 'venue', maxlength: 80, placeholder: 'e.g. City Sports Hall' }))),
    settingsFields(sport, { format: 'league_knockout', groups: 2, qualifiers: 2, scoring: sport.defaults }),
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

  function viewTournament() {
    const t = S.t;
    document.title = `${t.name} · Tonament`;
    const tabs = tabsFor(t);
    const active = tabs.some((x) => x.id === S.route.tab) ? S.route.tab : tabs[0].id;
    const panels = { entries: panelEntries, live: panelLive, groups: panelGroups, bracket: panelBracket };
    return [
      h('header', { class: 't-header' },
        h('div', { class: 't-title' }, h('h1', {}, t.name), pill(t.status, STATUS[t.status])),
        h('p', { class: 'muted small' },
          [t.sport.name, t.formatName, t.venue].filter(Boolean).join(' · '), '  ', connDot())),
      t.isAdmin ? h('div', { class: 'admin-bar' },
        h('span', {}, '🔑 You are the organiser of this tournament'),
        h('span', { class: 'actions' },
          h('button', { class: 'btn btn-small', onclick: () => copy(`${location.origin}/#/t/${t.id}?key=${encodeURIComponent(keys.get(t.id))}`, 'Organiser link copied — share only with your umpires/co-organisers') }, 'Copy organiser link'),
          h('button', { class: 'btn btn-small btn-ghost', onclick: () => copy(`${location.origin}/#/t/${t.id}`, 'Public link copied') }, 'Copy public link'))) : null,
      h('nav', { class: 'tabs' }, tabs.map((x) => h('a', { href: `#/t/${t.id}/${x.id}`, class: x.id === active ? 'active' : '' }, x.label))),
      h('section', {}, panels[active](t)),
    ];
  }

  // ----- entries tab
  function panelEntries(t) {
    const editable = t.isAdmin && t.status === 'setup';
    const groupLabel = (g) => (g == null || t.format === 'knockout' ? null : h('span', { class: 'pill' }, `Group ${String.fromCharCode(65 + g)}`));
    const list = h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, `Entries (${t.entries.length})`),
        editable && t.entries.length > 1 ? h('button', { class: 'btn btn-small btn-ghost', onclick: () => shuffle(t) }, '🔀 Random draw') : null),
      t.entries.length
        ? h('ol', { class: 'entries' }, t.entries.map((e, i) => h('li', {},
          h('span', { class: 'seed' }, i + 1),
          h('span', { class: 'name' }, e.name),
          groupLabel(e.group),
          editable ? h('span', { class: 'row-actions' },
            h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': `Move ${e.name} up`, disabled: i === 0, onclick: () => move(t, i, -1) }, '↑'),
            h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': `Move ${e.name} down`, disabled: i === t.entries.length - 1, onclick: () => move(t, i, 1) }, '↓'),
            h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${e.name}`, onclick: () => removeEntry(t, e) }, '✕')) : null)))
        : empty(editable ? 'No entries yet. Add players or pairs above.' : 'No entries yet.'),
      editable && t.entries.length > 1
        ? h('p', { class: 'hint', style: 'margin:8px 0 0' }, 'List order is the seeding (1 = top seed). Seeds are spread across groups with a snake draw.')
        : null);

    if (!editable) {
      return [
        t.status === 'setup' ? h('div', { class: 'banner info' }, 'The organiser is still adding players. The draw will appear here once the tournament starts.') : null,
        list,
      ];
    }
    return [addEntriesForm(t), list, startCard(t), settingsCard(t), dangerZone(t)];
  }

  function addEntriesForm(t) {
    const ta = h('textarea', {
      name: 'names', rows: 4,
      placeholder: 'One player or pair per line, e.g.\nAsha Rao\nLee / Chan',
      oninput: (e) => { S.draft = e.target.value; },
    });
    ta.value = S.draft;
    return h('form', {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        const names = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
        if (!names.length) return;
        act(async () => {
          S.t = await api('POST', `${tPath(t)}/entries`, { names }, t.id);
          S.draft = '';
        }, `Added ${names.length} ${names.length === 1 ? 'entry' : 'entries'}`);
      },
    },
    h('h2', {}, 'Add players or pairs'), ta,
    h('div', { class: 'actions', style: 'margin-top:10px' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add')));
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

  function planText(t) {
    const n = t.entries.length;
    const { groups: g, qualifiers: q } = t.config;
    if (t.format === 'knockout') {
      if (n < 2) return 'Add at least 2 entries.';
      const size = pow2(n);
      const byes = size - n;
      return `${n} entries → ${size}-draw knockout, ${Math.log2(size)} rounds${byes ? `, ${byes} bye${byes > 1 ? 's' : ''} for top seeds` : ''}.`;
    }
    if (n < g * 2) return `Add at least ${g * 2} entries for ${g} group${g > 1 ? 's' : ''}.`;
    const small = Math.floor(n / g);
    const big = Math.ceil(n / g);
    const bigCount = n % g;
    const matches = bigCount * (big * (big - 1)) / 2 + (g - bigCount) * (small * (small - 1)) / 2;
    const sizes = small === big ? `of ${small}` : `of ${small}–${big}`;
    let s = `${n} entries → ${g} group${g > 1 ? 's' : ''} ${sizes}, ${matches} league matches.`;
    if (t.format === 'league_knockout') s += ` Top ${q} of each group → ${g * q}-player knockout.`;
    return s;
  }

  function startCard(t) {
    return h('div', { class: 'card' },
      h('h2', {}, 'Ready to start?'),
      h('p', { class: 'plan' }, planText(t)),
      h('p', { class: 'muted small' }, 'Starting makes the draw and fixtures. Entries and settings are locked after that.'),
      h('button', {
        class: 'btn btn-primary btn-lg',
        onclick: () => {
          if (!confirm('Start the tournament now? Entries and settings will be locked.')) return;
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
    return h('div', { class: 'actions', style: 'justify-content:flex-end' },
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
    const upcoming = ms.filter((m) => m.status === 'scheduled' && m.a && m.b).sort(byOrder).slice(0, 8);
    const results = ms.filter((m) => m.status === 'done')
      .sort((x, y) => (y.updatedAt || '').localeCompare(x.updatedAt || '') || y.id - x.id).slice(0, 12);
    return [
      championBanner(t),
      stageBanner(t),
      matchSection(t, 'On court now', live, 'No matches in progress.', true),
      upcoming.length || t.status !== 'completed' ? matchSection(t, 'Up next', upcoming, 'Nothing scheduled right now.') : null,
      matchSection(t, 'Latest results', results, 'No results yet.'),
    ];
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
        t.isAdmin
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
    return [m.stage === 'league' ? `${m.groupName} · ${m.roundName}` : m.roundName, m.court ? `Court ${m.court}` : null].filter(Boolean).join(' · ');
  }

  function statusTag(m) {
    if (m.status === 'live') return pill('live', 'Live');
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
            h('tbody', {}, g.standings.map((r) => h('tr', { class: r.rank <= q ? 'q' : '' },
              h('td', { class: 'num' }, r.rank),
              h('td', { class: 'name' }, r.name),
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
      const score = m.status === 'bye' || m.status === 'scheduled' ? '' : visibleGames(m).map((g) => g[s]).join(' ');
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
    return t.isAdmin && m.a && m.b && (m.status === 'scheduled' || m.status === 'live') && stageOpen(t, m);
  }

  function viewMatch() {
    const t = S.t;
    const m = t.matches.find((x) => x.id === S.route.mid);
    if (!m) return errorView('Match not found.');
    document.title = `${nameOf(m.a)} v ${nameOf(m.b)} · ${t.name}`;
    const backTab = m.stage === 'knockout' ? 'bracket' : 'live';
    return [
      h('a', { class: 'back', href: `#/t/${t.id}/${backTab}` }, `← ${t.name}`),
      h('div', { class: 'match-head' },
        h('span', {}, matchLabel(m)),
        h('span', { class: 'actions' }, connDot(), statusTag(m))),
      scoreboard(m),
      canScore(t, m) ? scorer(t, m) : null,
      t.isAdmin && m.status === 'done' && m.rallies
        ? h('div', { class: 'actions center', style: 'margin-bottom:16px' },
          h('button', { class: 'btn btn-ghost', onclick: () => undo(t, m) }, '↶ Undo last point (reopens the match)'))
        : null,
      gamesTable(m),
      !t.isAdmin && m.status !== 'done' ? h('p', { class: 'muted center small' }, 'This scoreboard updates live — no need to refresh.') : null,
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

  async function rally(t, m, side) {
    if (S.pending) return;
    S.pending = true;
    if (navigator.vibrate) navigator.vibrate(12);
    try {
      const updated = await api('POST', `${tPath(t)}/matches/${m.id}/rally`, { side }, t.id);
      mergeMatch(updated);
      if (updated.status === 'done') {
        toast(`🏸 ${updated[side].name} wins ${updated.summary}`);
        refresh(); // standings / bracket changed
      }
    } catch (e) {
      toast(e.message, true);
    } finally {
      S.pending = false;
      render();
    }
  }

  async function undo(t, m) {
    if (S.pending) return;
    if (m.status === 'done' && !confirm('Undo the winning point and reopen this match?')) return;
    S.pending = true;
    try {
      mergeMatch(await api('POST', `${tPath(t)}/matches/${m.id}/undo`, {}, t.id));
      if (m.status === 'done') refresh(); // reopened: standings / bracket changed
    } catch (e) {
      toast(e.message, true);
    } finally {
      S.pending = false;
      render();
    }
  }

  function patchMatch(t, m, body, msg) {
    act(async () => { mergeMatch(await api('PATCH', `${tPath(t)}/matches/${m.id}`, body, t.id)); }, msg);
  }

  // Keyboard scoring for umpires on a laptop.
  document.addEventListener('keydown', (e) => {
    if (S.route.name !== 'match' || !S.t || !S.t.isAdmin || isEditing() || e.metaKey || e.ctrlKey || e.altKey) return;
    const m = S.t.matches.find((x) => x.id === S.route.mid);
    if (!m) return;
    const k = e.key.toLowerCase();
    if ((k === 'a' || k === 'arrowleft') && canScore(S.t, m)) rally(S.t, m, 'a');
    else if ((k === 'l' || k === 'arrowright') && canScore(S.t, m)) rally(S.t, m, 'b');
    else if ((k === 'z' || k === 'backspace') && m.rallies && (canScore(S.t, m) || m.status === 'done')) undo(S.t, m);
    else return;
    e.preventDefault();
  });

  // ---------- boot
  window.addEventListener('hashchange', route);
  api('GET', '/sports')
    .then((list) => { S.sports = list; })
    .catch(() => { S.sports = []; })
    .finally(route);
})();
