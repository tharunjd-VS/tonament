'use strict';

// Latecomers: the fair options for someone who arrives after the draw (a late
// entry, or an entry who missed it), and for a player who hasn't turned up
// to a match, under the tournament's published late-arrival policy.
// Deterministic and identity-blind: it sees group sizes, matches played,
// courts and time — never names, clubs or who anyone is — and ties are
// broken by group order, so the same situation always gets the same answer.
//
// The policy (tournaments.config.latePolicy), set by the organiser and shown
// to players:
//   lateUntil    'groups' — late entries and arrivals join any time in the group stage
//                'half'   — only into groups less than half played
//                'never'  — no one joins after the draw
//   groupChoice  'even'     — the group with the fewest players (then the fewest matches played)
//                'progress' — the group least far along (most time to catch up)
//   graceMinutes how late a player can be for a called match before a walkover is suggested
//   replaceNoShow whether a walk-in can take a no-show's place before their first match

const DEFAULT_POLICY = { lateUntil: 'groups', groupChoice: 'even', graceMinutes: 15, replaceNoShow: true };
const LATE_UNTIL = ['groups', 'half', 'never'];
const GROUP_CHOICE = ['even', 'progress'];

function policyOf(value) {
  const p = value && typeof value === 'object' ? value : {};
  return {
    lateUntil: LATE_UNTIL.includes(p.lateUntil) ? p.lateUntil : DEFAULT_POLICY.lateUntil,
    groupChoice: GROUP_CHOICE.includes(p.groupChoice) ? p.groupChoice : DEFAULT_POLICY.groupChoice,
    graceMinutes: Number.isInteger(p.graceMinutes) && p.graceMinutes >= 5 && p.graceMinutes <= 60 ? p.graceMinutes : DEFAULT_POLICY.graceMinutes,
    replaceNoShow: typeof p.replaceNoShow === 'boolean' ? p.replaceNoShow : DEFAULT_POLICY.replaceNoShow,
  };
}

// The policy in plain words, for the tournament page and the options.
function describe(policy) {
  const p = policyOf(policy);
  const join = {
    groups: 'Late entries and players who miss the draw can join during the group stage',
    half: 'Late entries and players who miss the draw can join a group until it is half played',
    never: 'No one can join after the draw is made',
  }[p.lateUntil];
  const where = p.lateUntil === 'never' ? '' : p.groupChoice === 'even'
    ? ' — into the group with the fewest players, so groups stay even, with catch-up matches against everyone in it'
    : ' — into the group that has played the fewest matches, so there\'s time to catch up';
  return [`${join}${where}.`, `A player more than ${p.graceMinutes} minutes late for a called match can be given a walkover.`,
    ...(p.replaceNoShow ? ['If someone doesn\'t turn up, a walk-in can take their place before their first match.'] : [])];
}

// groups: [{ no, name, active, played, total, pool }] — active players, league
// matches played and in all; level/pool: their level's pool, when the event
// is split by level. Returns { allowed, rule, options[] }, best first.
function groupOptions({ groups, policy, level = null, poolsOn = false, matchMinutes = 20, courts = 1 }) {
  const p = policyOf(policy);
  if (p.lateUntil === 'never') return { allowed: false, rule: 'Your policy: no one joins after the draw.', options: [] };
  let pool = groups;
  if (poolsOn && level) {
    pool = groups.filter((g) => g.pool && g.pool.split(' & ').includes(level));
    if (!pool.length) return { allowed: false, rule: `There's no ${level} pool — pick a group.`, options: [] };
  }
  const minSize = Math.min(...groups.map((g) => g.active));
  const progress = (g) => (g.total ? g.played / g.total : 0);
  const options = pool.map((g) => {
    const matchesAdded = g.active;
    const open = p.lateUntil !== 'half' || progress(g) < 0.5;
    const notes = [];
    if (g.active + 1 > minSize + 1) notes.push(`makes ${g.name} ${g.active + 1 - minSize} bigger than the smallest group`);
    if (progress(g) >= 0.5) notes.push(`${g.name} is ${Math.round(progress(g) * 100)}% played`);
    return {
      action: 'group', group: g.no, label: g.name + (g.pool ? ` · ${g.pool}` : ''),
      matchesAdded, extraMinutes: Math.ceil((matchesAdded * matchMinutes) / Math.max(1, courts)),
      sizeAfter: g.active + 1, played: g.played, total: g.total, allowed: open,
      notes, why: open ? null : 'Your policy: only into groups less than half played.',
    };
  });
  const key = p.groupChoice === 'progress'
    ? (o) => [o.total ? o.played / o.total : 0, o.sizeAfter, o.group]
    : (o) => [o.sizeAfter, o.played, o.group];
  const cmp = (a, b) => { const x = key(a); const y = key(b); for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  options.sort((a, b) => (b.allowed - a.allowed) || cmp(a, b));
  const best = options.find((o) => o.allowed);
  if (best) {
    best.recommended = true;
    best.why = p.groupChoice === 'even' ? 'Keeps the groups as even as possible (your policy).' : 'The group with the most time to catch up (your policy).';
  }
  return { allowed: Boolean(best), rule: best ? null : 'Your policy: only into groups less than half played — every group is past halfway.', options };
}

// A knockout-only event: the first-round byes still open.
function byeOptions({ byes, policy }) {
  const p = policyOf(policy);
  if (p.lateUntil === 'never') return { allowed: false, rule: 'Your policy: no one joins after the draw.', options: [] };
  if (!byes) return { allowed: false, rule: 'The bracket is full — no bye is left for them.', options: [] };
  return { allowed: true, rule: null, options: [{ action: 'bye', label: 'Take a first-round bye', matchesAdded: 1, allowed: true, recommended: true, why: 'They play the seed who had the bye.', notes: [] }] };
}

// A player who hasn't come to a called match: wait, or a walkover past the grace time.
function noShowOptions({ minutesLate, policy }) {
  const p = policyOf(policy);
  const due = minutesLate >= p.graceMinutes;
  return {
    allowed: true,
    rule: `Your policy: a walkover after ${p.graceMinutes} minutes.`,
    options: [
      { action: 'wait', label: due ? 'Wait a little longer' : `Wait (${p.graceMinutes - minutesLate} min of grace left)`, allowed: true, recommended: !due, notes: [], why: due ? null : 'Still within the grace time.' },
      { action: 'walkover', label: 'Give the walkover', allowed: due, recommended: due, notes: [], why: due ? `${minutesLate} minutes late — past the ${p.graceMinutes} minutes your policy allows.` : `Only after ${p.graceMinutes} minutes (your policy).` },
    ],
  };
}

module.exports = { DEFAULT_POLICY, LATE_UNTIL, GROUP_CHOICE, policyOf, describe, groupOptions, byeOptions, noShowOptions };
