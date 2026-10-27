'use strict';

// Sport-independent tournament format logic: group draws, round-robin
// fixtures, standings and knockout brackets.

// Snake draw so seeds are spread evenly: A B C D D C B A A B ...
function snakeGroups(ids, groupCount) {
  const groups = Array.from({ length: groupCount }, () => []);
  ids.forEach((id, i) => {
    const row = Math.floor(i / groupCount);
    const col = i % groupCount;
    groups[row % 2 ? groupCount - 1 - col : col].push(id);
  });
  return groups;
}

// Circle method. Returns rounds, each a list of [a, b] pairs.
function roundRobin(ids) {
  if (ids.length < 2) return [];
  const list = [...ids];
  if (list.length % 2) list.push(null);
  const n = list.length;
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a != null && b != null) pairs.push(r % 2 && i === 0 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    list.splice(1, 0, list.pop()); // rotate everyone except the first
  }
  return rounds;
}

// Number of groups for n entries at "about `size` per group": the nearest
// whole number of groups, never so many that a group has fewer than 2.
// Snake seeding then keeps group sizes within one of each other.
function groupCount(n, size) {
  if (n < 2) return 1;
  return Math.min(Math.max(1, Math.round(n / size)), Math.floor(n / 2));
}

function bracketSize(n) {
  let size = 2;
  while (size < n) size *= 2;
  return size;
}

// Standard seeding positions, e.g. 8 -> [1, 8, 4, 5, 2, 7, 3, 6].
function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

// seeded: [{ id, group, tier }] best first. Returns first-round slots
// (ids or null for a bye). Byes go to the top seeds, and two entries from the
// same group are kept apart in round one by swapping equal-tier opponents.
function knockoutSlots(seeded) {
  const size = bracketSize(seeded.length);
  const slots = seedOrder(size).map((s) => seeded[s - 1] || null);
  const clash = (x, y) => x && y && x.group != null && x.group === y.group;
  for (let i = 0; i < slots.length; i += 2) {
    if (!clash(slots[i], slots[i + 1])) continue;
    for (let j = 0; j < slots.length; j += 2) {
      const cand = slots[j + 1];
      if (j === i || !cand || cand.tier !== slots[i + 1].tier) continue;
      if (!clash(slots[i], cand) && !clash(slots[j], slots[i + 1])) {
        [slots[i + 1], slots[j + 1]] = [cand, slots[i + 1]];
        break;
      }
    }
  }
  return slots.map((s) => (s ? s.id : null));
}

function roundName(round, totalRounds) {
  const fromEnd = totalRounds - round;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semi-finals';
  if (fromEnd === 2) return 'Quarter-finals';
  return `Round of ${2 ** (fromEnd + 1)}`;
}

// League points: a win is 2, a draw 1 (2-game league matches), a loss 0.
// With no draws this ranks exactly as matches won. A sport can set its own
// (football: win 3, draw 1).
const WIN_POINTS = 2;
const DRAW_POINTS = 1;

// results: [{ a, b, winner, draw, gamesA, gamesB, pointsA, pointsB }]
// Ranking (BWF style): league points; two-way tie -> head-to-head (unless
// they drew); otherwise game difference, then point difference.
function standings(memberIds, results, points = {}) {
  const win = points.win ?? WIN_POINTS;
  const drawn = points.draw ?? DRAW_POINTS;
  const order = new Map(memberIds.map((id, i) => [id, i]));
  const rows = new Map(
    memberIds.map((id) => [
      id,
      { id, played: 0, won: 0, drawn: 0, lost: 0, leaguePoints: 0, gamesFor: 0, gamesAgainst: 0, pointsFor: 0, pointsAgainst: 0 },
    ]),
  );
  for (const r of results) {
    const a = rows.get(r.a);
    const b = rows.get(r.b);
    if (!a || !b) continue;
    a.played++;
    b.played++;
    if (r.draw) { a.drawn++; b.drawn++; } else if (r.winner === r.a) { a.won++; b.lost++; } else { b.won++; a.lost++; }
    a.gamesFor += r.gamesA; a.gamesAgainst += r.gamesB;
    b.gamesFor += r.gamesB; b.gamesAgainst += r.gamesA;
    a.pointsFor += r.pointsA; a.pointsAgainst += r.pointsB;
    b.pointsFor += r.pointsB; b.pointsAgainst += r.pointsA;
  }

  for (const row of rows.values()) row.leaguePoints = row.won * win + row.drawn * drawn;

  const byStats = (x, y) =>
    y.gamesFor - y.gamesAgainst - (x.gamesFor - x.gamesAgainst) ||
    y.pointsFor - y.pointsAgainst - (x.pointsFor - x.pointsAgainst) ||
    order.get(x.id) - order.get(y.id);

  const breakTie = (tied) => {
    if (tied.length === 2) {
      const [x, y] = tied;
      const h2h = results.find((r) => (r.a === x.id && r.b === y.id) || (r.a === y.id && r.b === x.id));
      if (h2h && !h2h.draw) return h2h.winner === x.id ? [x, y] : [y, x];
    }
    return tied.sort(byStats);
  };

  const list = [...rows.values()].sort((x, y) => y.leaguePoints - x.leaguePoints);
  const ranked = [];
  for (let i = 0; i < list.length; ) {
    let j = i + 1;
    while (j < list.length && list[j].leaguePoints === list[i].leaguePoints) j++;
    ranked.push(...breakTie(list.slice(i, j)));
    i = j;
  }
  return ranked.map((r, i) => ({ rank: i + 1, ...r }));
}

module.exports = { WIN_POINTS, DRAW_POINTS, groupCount, snakeGroups, roundRobin, bracketSize, seedOrder, knockoutSlots, roundName, standings };
