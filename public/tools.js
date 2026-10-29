// The free fixture tools on /tools/*: paste names, get groups, fixtures or
// a seeded bracket. The draw logic is public/formats.js (window.TonamentFormats),
// the same code that makes real Tonament draws.
(function () {
  'use strict';
  const F = window.TonamentFormats;
  const root = document.getElementById('tool');
  if (!F || !root) return;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  }
  const lines = (text) => text.split('\n').map((x) => x.trim()).filter(Boolean);
  const uniqueNames = (names) => [...new Set(names)];
  const letter = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
  const shuffle = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const duration = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`);

  function textArea(name, value, label, rows = 8) {
    return h('label', { class: 'field' }, h('span', {}, label),
      h('textarea', { name, rows, spellcheck: 'false', 'aria-label': label }, value));
  }
  function select(name, label, options, value) {
    return h('label', { class: 'field' }, h('span', {}, label),
      h('select', { name }, options.map(([v, text]) => h('option', { value: v, selected: String(v) === String(value) }, text))));
  }
  function number(name, label, value, min, max) {
    return h('label', { class: 'field' }, h('span', {}, label), h('input', { type: 'number', name, value, min, max, inputmode: 'numeric' }));
  }

  // The tournament's add-players box picks these up after sign-up (see app.js, S.draft).
  function runLive(names) {
    try { sessionStorage.setItem('tonament:tool-names', names.join('\n')); } catch (e) { /* fine */ }
    location.href = '/new';
  }

  // One group's round-robin fixtures, round by round.
  function groupBlock(title, names) {
    const rounds = F.roundRobin(names.map((_, i) => i));
    const matches = rounds.reduce((n, r) => n + r.length, 0);
    return h('section', { class: 'tool-group' },
      h('h3', {}, title, h('small', { class: 'muted' }, ` · ${plural(names.length, 'entry', 'entries')} · ${plural(matches, 'match', 'matches')}`)),
      h('ol', { class: 'tool-members' }, names.map((n) => h('li', {}, n))),
      h('table', { class: 'tool-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Round'), h('th', {}, 'Matches'))),
        h('tbody', {}, rounds.map((pairs, r) => {
          const playing = new Set(pairs.flat());
          const bye = names.filter((_, i) => !playing.has(i));
          return h('tr', {}, h('td', {}, r + 1), h('td', {},
            pairs.map(([a, b]) => h('span', { class: 'tool-match' }, `${names[a]} v ${names[b]}`)),
            bye.length ? h('span', { class: 'tool-bye' }, `Bye: ${bye.join(', ')}`) : null));
        }))));
  }

  // A knockout from first-round slots (labels, or null for a bye): byes
  // carry the entry straight into round 2; every real match is numbered.
  function bracketBlock(slots) {
    const total = Math.log2(slots.length);
    let current = slots.map((label) => (label == null ? null : { label }));
    let no = 0;
    const rounds = [];
    for (let r = 1; r <= total; r++) {
      const matches = [];
      const next = [];
      for (let i = 0; i < current.length; i += 2) {
        const a = current[i];
        const b = current[i + 1];
        if (a && b) {
          no += 1;
          matches.push({ no, a: a.label, b: b.label });
          next.push({ label: `Winner of M${no}` });
        } else {
          if (r === 1 && (a || b)) matches.push({ bye: (a || b).label });
          next.push(a || b);
        }
      }
      rounds.push({ name: F.roundName(r, total), matches });
      current = next;
    }
    return h('div', { class: 'tool-bracket' }, rounds.map((round) => h('section', { class: 'tool-round' },
      h('h3', {}, round.name),
      round.matches.map((m) => (m.bye
        ? h('div', { class: 'tool-slot bye' }, h('span', {}, m.bye), h('small', { class: 'muted' }, 'bye'))
        : h('div', { class: 'tool-slot' }, h('small', { class: 'muted' }, `M${m.no}`), h('span', {}, m.a), h('span', {}, m.b)))))));
  }

  function summary(matches, form) {
    const courts = Math.max(1, Number(form.courts.value) || 1);
    const minutes = Math.max(5, Number(form.minutes.value) || 20);
    return h('p', { class: 'tool-summary' },
      h('strong', {}, plural(matches, 'match', 'matches')),
      ` · about ${duration(Math.ceil(matches / courts) * minutes)} on ${plural(courts, 'court')} at ${minutes} minutes a match`);
  }

  const SAMPLE = ['Arun', 'Bala', 'Charan', 'Dinesh', 'Ezhil', 'Farhan', 'Gokul', 'Hari', 'Imran', 'Jagan'];
  const LEVELS = ['Beginner', 'Beginner+', 'Intermediate', 'Advanced'];
  const LEVEL_SAMPLE = [['Arun / Bala', 'Charan / Dinesh', 'Ezhil / Farhan'], ['Gokul / Hari', 'Imran / Jagan', 'Karthi / Lokesh'], ['Mohan / Naveen', 'Om / Prakash', 'Ravi / Sanjay', 'Tarun / Uday'], ['Vijay / Wasim', 'Yusuf / Zubair', 'Anand / Bharath']];

  const TOOLS = {
    'round-robin': {
      fields: () => [
        textArea('names', SAMPLE.join('\n'), 'Players, pairs or teams — one per line, best first'),
        h('div', { class: 'tool-options' },
          select('groups', 'Groups', [['all', 'One group — everyone plays everyone'], [3, 'Groups of about 3'], [4, 'Groups of about 4'], [5, 'Groups of about 5'], [6, 'Groups of about 6']], 4),
          number('courts', 'Courts', 2, 1, 40), number('minutes', 'Minutes a match', 20, 5, 240)),
      ],
      names: (form) => uniqueNames(lines(form.names.value)),
      render(form) {
        const names = this.names(form);
        if (names.length < 2) return [h('p', { class: 'muted' }, 'Add at least 2 names.')];
        const count = form.groups.value === 'all' ? 1 : F.groupCount(names.length, Number(form.groups.value));
        const groups = F.snakeGroups(names, count);
        const matches = groups.reduce((n, g) => n + (g.length * (g.length - 1)) / 2, 0);
        return [summary(matches, form), ...groups.map((g, i) => groupBlock(count === 1 ? 'Everyone plays everyone' : `Group ${letter(i)}`, g))];
      },
    },
    'knockout-bracket': {
      fields: () => [
        textArea('names', SAMPLE.join('\n'), 'Players, pairs or teams — one per line, top seed first'),
        h('div', { class: 'tool-options' }, number('courts', 'Courts', 2, 1, 40), number('minutes', 'Minutes a match', 20, 5, 240)),
      ],
      names: (form) => uniqueNames(lines(form.names.value)),
      render(form) {
        const names = this.names(form);
        if (names.length < 2) return [h('p', { class: 'muted' }, 'Add at least 2 names.')];
        const slots = F.knockoutSlots(names.map((n, i) => ({ id: `${i + 1}. ${n}`, group: null, tier: 0 })));
        const byes = slots.filter((s) => s == null).length;
        return [summary(names.length - 1, form), h('p', { class: 'muted small' }, `A ${slots.length}-draw${byes ? ` with ${plural(byes, 'bye')} for the top seeds` : ''}. Numbers are seeds.`), bracketBlock(slots)];
      },
    },
    'split-by-level': {
      fields: () => [
        h('div', { class: 'tool-levels' }, LEVELS.map((l, i) => textArea(`level${i}`, LEVEL_SAMPLE[i].join('\n'), l, 5))),
        h('div', { class: 'tool-options' },
          select('mode', 'Pools', [['levels', 'One per level — winners meet in the semis'], ['two', 'Two pools — lower v upper, meet in the final']], 'levels'),
          select('size', 'Groups', [[3, 'About 3 per group'], [4, 'About 4 per group'], [5, 'About 5 per group'], [6, 'About 6 per group']], 4),
          select('qualifiers', 'Through from each group', [[1, 'The winner'], [2, 'Top 2']], 1),
          number('courts', 'Courts', 3, 1, 40), number('minutes', 'Minutes a match', 20, 5, 240)),
      ],
      names: (form) => LEVELS.flatMap((_, i) => lines(form[`level${i}`].value)),
      render(form) {
        const entries = [];
        const seen = new Set();
        LEVELS.forEach((level, i) => lines(form[`level${i}`].value).forEach((name) => {
          if (!seen.has(name)) entries.push({ id: name, level });
          seen.add(name);
        }));
        if (entries.length < 2) return [h('p', { class: 'muted' }, 'Add at least 2 names.')];
        const { pools } = F.poolsFor(entries, form.mode.value, LEVELS);
        const size = Number(form.size.value);
        const q = Number(form.qualifiers.value);
        let g = 0;
        let matches = 0;
        const blocks = [];
        const sections = [];
        for (const pool of pools) {
          const groups = F.snakeGroups(pool.ids, F.groupCount(pool.ids.length, size));
          const section = [];
          blocks.push(h('h3', { class: 'tool-pool' }, pool.label));
          for (const members of groups) {
            const name = `Group ${letter(g)}`;
            blocks.push(groupBlock(`${name} · ${pool.label}`, members));
            matches += (members.length * (members.length - 1)) / 2;
            for (let k = 0; k < Math.min(q, members.length); k++) section.push({ id: `${name} ${k ? 'runner-up' : 'winner'}`, group: g, tier: k });
            g += 1;
          }
          sections.push(section.sort((a, b) => a.tier - b.tier));
        }
        const slots = F.pooledSlots(sections);
        matches += slots.filter(Boolean).length - 1;
        const meet = pools.length < 2 ? 'One pool: its knockout decides the champion.'
          : pools.length === 2 ? `${pools[0].label} and ${pools[1].label} meet only in the final.`
            : 'Each pool\'s winner reaches the semis — the levels only meet there.';
        return [summary(matches, form), ...blocks, h('h3', { class: 'tool-pool' }, 'Knockout'), h('p', { class: 'muted small' }, meet), bracketBlock(slots)];
      },
    },
  };

  const tool = TOOLS[root.dataset.tool];
  if (!tool) return;
  const output = h('div', { class: 'tool-output', 'aria-live': 'polite' });
  const form = h('form', { class: 'tool-form', onsubmit: (e) => e.preventDefault(), oninput: () => draw(), onchange: () => draw() },
    tool.fields(),
    h('div', { class: 'actions tool-actions' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => {
        form.querySelectorAll('textarea').forEach((ta) => { ta.value = shuffle(lines(ta.value)).join('\n'); });
        draw();
      } }, 'Shuffle'),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => window.print() }, 'Print'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: () => runLive(tool.names(form)) }, 'Run this live on Tonament')),
    h('p', { class: 'muted small tool-note' }, 'Example names are filled in — replace them with yours. Nothing is saved or sent anywhere until you choose to run it live.'));
  function draw() { output.replaceChildren(...tool.render(form)); }
  root.replaceChildren(form, h('h2', { class: 'tool-print-title' }, document.title.replace(/ \| Tonament$/, '')), output);
  draw();
})();
