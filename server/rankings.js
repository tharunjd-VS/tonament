'use strict';

// Ranking points: how far a player got in an event, times the size of the
// draw. A player's ranking in a category is their best results in the last
// 52 weeks. Change the numbers here only.

const FINISH_POINTS = { W: 100, F: 70, SF: 45, QF: 25, R16: 15, R32: 8, G: 8 };
const FINISH_NAMES = { W: 'Winner', F: 'Runner-up', SF: 'Semi-final', QF: 'Quarter-final', R16: 'Last 16', R32: 'Last 32', G: 'Group stage' };
const BEST_OF = 6;           // results that count
const WINDOW_DAYS = 364;     // 52 weeks
const MIN_ENTRIES = 4;       // smaller events don't count

// Bigger draws are worth more.
function sizeFactor(n) {
  if (n >= 32) return 2;
  if (n >= 16) return 1.5;
  if (n >= 8) return 1;
  return 0.5;
}
const pointsFor = (finish, entries) => (entries < MIN_ENTRIES ? 0 : Math.round((FINISH_POINTS[finish] || 0) * sizeFactor(entries)));

// Ranked categories: men's / women's / mixed / open singles and doubles, by
// age group. Team and "any" events aren't ranked; levels don't split them.
const CATEGORY_KEYS = { 'singles-men': 'ms', 'singles-women': 'ws', 'singles-open': 'os', 'doubles-men': 'md', 'doubles-women': 'wd', 'doubles-mixed': 'xd', 'doubles-open': 'od' };
const CATEGORY_NAMES = { ms: 'Men\'s Singles', ws: 'Women\'s Singles', os: 'Open Singles', md: 'Men\'s Doubles', wd: 'Women\'s Doubles', xd: 'Mixed Doubles', od: 'Open Doubles' };
const ageSlug = (age) => String(age || 'Open').toLowerCase().replace('+', 'plus').replace(/[^a-z0-9]+/g, '');
function categoryOf(ev) {
  const base = CATEGORY_KEYS[`${ev.discipline}-${ev.gender}`];
  if (!base) return null;
  return !ev.age || ev.age === 'Open' ? base : `${base}-${ageSlug(ev.age)}`;
}
// 'xd-u19' -> "Mixed Doubles U19"; null for an unknown slug.
function categoryName(slug, ages = []) {
  const [base, age] = String(slug || '').split('-');
  if (!CATEGORY_NAMES[base]) return null;
  if (!age) return CATEGORY_NAMES[base];
  const label = ages.find((a) => ageSlug(a) === age);
  return label ? `${CATEGORY_NAMES[base]} ${label}` : null;
}

// Where each entry finished. entries: [{ id }]; matches: rows with stage,
// round, group_no, a_id, b_id, winner_id, status; standings: one list of
// entry ids per group, best first (league formats). knockoutRounds: the final's round.
function finishes({ format, entries, matches, standings = [], knockoutRounds = 0 }) {
  const out = new Map();
  const ko = matches.filter((m) => m.stage === 'knockout' && m.status !== 'bye');
  if (format !== 'league' && ko.length) {
    const reached = new Map();
    for (const m of matches.filter((x) => x.stage === 'knockout')) {
      for (const id of [m.a_id, m.b_id]) if (id != null) reached.set(id, Math.max(reached.get(id) || 0, m.round));
    }
    const final = ko.find((m) => m.round === knockoutRounds);
    for (const e of entries) {
      if (!reached.has(e.id)) { out.set(e.id, 'G'); continue; }
      if (final && final.winner_id === e.id) { out.set(e.id, 'W'); continue; }
      const fromEnd = knockoutRounds - reached.get(e.id); // 0: lost the final
      out.set(e.id, ['F', 'SF', 'QF', 'R16'][fromEnd] || 'R32');
    }
    return out;
  }
  // League only: one group is a table (1st wins); with several, group
  // winners count as semi-finalists and runners-up as quarter-finalists.
  const single = standings.length === 1;
  standings.forEach((ids) => ids.forEach((id, i) => {
    out.set(id, single ? (['W', 'F', 'SF', 'SF', 'QF', 'QF', 'QF', 'QF'][i] || 'G') : (['SF', 'QF'][i] || 'G'));
  }));
  for (const e of entries) if (!out.has(e.id)) out.set(e.id, 'G');
  return out;
}

// Matches won and lost by each entry (walkovers and byes don't count).
function records(matches) {
  const out = new Map();
  const add = (id, k) => { if (id == null) return; const r = out.get(id) || { won: 0, lost: 0 }; r[k] += 1; out.set(id, r); };
  for (const m of matches) {
    if (m.status !== 'done' || m.walkover || m.a_id == null || m.b_id == null || m.winner_id == null) continue;
    add(m.winner_id, 'won');
    add(m.winner_id === m.a_id ? m.b_id : m.a_id, 'lost');
  }
  return out;
}

module.exports = {
  FINISH_POINTS, FINISH_NAMES, BEST_OF, WINDOW_DAYS, MIN_ENTRIES, CATEGORY_NAMES,
  sizeFactor, pointsFor, categoryOf, categoryName, ageSlug, finishes, records,
};
