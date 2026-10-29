'use strict';

// The rules behind group play, kept pure so they're easy to test: who plays
// next, how teams are balanced, how ratings move, and when sessions start.

// ---------- who plays next

// players: [{ id, rating, games, waitingSince (ms), partners: Set of ids partnered today }]
// Picks the next game from the players who are free: fewest games today
// first, then whoever has waited longest. Teams are split so the ratings are
// as even as possible, avoiding today's partners. Returns { a: [ids], b: [ids] }
// or null when there aren't enough players.
function suggest(players, { singles = false, skip = 0 } = {}) {
  const queue = [...players].sort((x, y) => x.games - y.games || x.waitingSince - y.waitingSince || x.id - y.id);
  const size = queue.length >= 4 ? 4 : singles && queue.length >= 2 ? 2 : 0;
  if (!size) return null;
  // "Someone else": the last pick is swapped for the next person waiting.
  const spare = queue.length - size;
  const last = size - 1 + (spare ? skip % (spare + 1) : 0);
  const picked = [...queue.slice(0, size - 1), queue[last]];
  if (size === 2) return { a: [picked[0].id], b: [picked[1].id] };
  const [p, q, r, s] = picked;
  const splits = [[[p, q], [r, s]], [[p, r], [q, s]], [[p, s], [q, r]]];
  const cost = ([a, b]) => {
    const gap = Math.abs(a[0].rating + a[1].rating - b[0].rating - b[1].rating);
    const repeat = (t) => (t[0].partners && t[0].partners.has(t[1].id) ? 150 : 0);
    return gap + repeat(a) + repeat(b);
  };
  const [a, b] = splits.reduce((best, sp) => (cost(sp) < cost(best) ? sp : best));
  return { a: a.map((x) => x.id), b: b.map((x) => x.id) };
}

// ---------- ratings (Elo for singles and doubles)

const START = 1000;
const PROVISIONAL = 5; // games before a rating is "settled"

// a, b: [{ id, rating, games }]; winner: 'a' | 'b'; margin: points difference.
// Each player gets their team's change. New players move faster.
function rate(a, b, winner, margin = 0) {
  const avg = (team) => team.reduce((sum, p) => sum + p.rating, 0) / team.length;
  const expectedA = 1 / (1 + 10 ** ((avg(b) - avg(a)) / 400));
  const scoreA = winner === 'a' ? 1 : 0;
  const boost = 1 + Math.min(Math.max(margin, 0), 15) / 30; // up to +50% for a big win
  const deltas = {};
  for (const [team, sign] of [[a, 1], [b, -1]]) {
    for (const p of team) {
      const k = p.games < 10 ? 32 : 20;
      deltas[p.id] = Math.round(sign * k * boost * (scoreA - expectedA));
    }
  }
  return deltas;
}

// Leaderboards by format, replayed from confirmed games in the order they
// ended: a singles rating per player (1 v 1 only), and a rating per doubles
// pair (the pair as one side, partners in either order). Same formula as the
// overall rating, so beating stronger pairs counts for more than many easy wins.
// games: [{ a1, a2, b1, b2, winner, margin }] oldest first.
function formatTables(games) {
  const singles = new Map();
  const pairs = new Map();
  const get = (map, key, extra) => {
    if (!map.has(key)) map.set(key, { ...extra, rating: START, games: 0, wins: 0 });
    return map.get(key);
  };
  for (const x of games) {
    if (x.winner !== 'a' && x.winner !== 'b') continue;
    const doubles = x.a2 != null && x.b2 != null;
    let a;
    let b;
    if (doubles) {
      const key = (p, q) => [p, q].sort((m, n) => m - n).join('-');
      a = get(pairs, key(x.a1, x.a2), { ids: [x.a1, x.a2].sort((m, n) => m - n) });
      b = get(pairs, key(x.b1, x.b2), { ids: [x.b1, x.b2].sort((m, n) => m - n) });
    } else if (x.a2 == null && x.b2 == null) {
      a = get(singles, x.a1, { id: x.a1 });
      b = get(singles, x.b1, { id: x.b1 });
    } else continue;
    const d = rate([{ id: 'a', rating: a.rating, games: a.games }], [{ id: 'b', rating: b.rating, games: b.games }], x.winner, x.margin || 0);
    a.rating += d.a;
    b.rating += d.b;
    a.games += 1;
    b.games += 1;
    (x.winner === 'a' ? a : b).wins += 1;
  }
  const order = (list) => list.sort((p, q) => Number(q.games >= PROVISIONAL) - Number(p.games >= PROVISIONAL) || q.rating - p.rating || q.wins - p.wins);
  return { singles: order([...singles.values()]), pairs: order([...pairs.values()]) };
}

// ---------- schedule

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Minutes the time zone is ahead of UTC at that instant (e.g. 330 for India).
function tzOffset(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

// The local date (YYYY-MM-DD) and weekday of an instant in a time zone.
function localDay(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return { iso: `${parts.year}-${parts.month}-${parts.day}`, weekday: DAY_NAMES.indexOf(parts.weekday) };
}

// When the next sessions start, from a weekly schedule { days: [0-6], time: 'HH:MM', timeZone }.
// Sessions stay "current" for `hours` after they start.
function upcomingStarts({ days = [], time = '06:00', timeZone = 'Asia/Kolkata' }, now = new Date(), { count = 2, hours = 4 } = {}) {
  if (!days.length) return [];
  const [hh, mm] = time.split(':').map(Number);
  const out = [];
  for (let d = -1; d < 15 && out.length < count; d++) {
    const day = localDay(new Date(now.getTime() + d * 86400000), timeZone);
    if (!days.includes(day.weekday)) continue;
    const [y, m, dd] = day.iso.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, dd, hh, mm);
    const start = new Date(guess - tzOffset(new Date(guess), timeZone) * 60000);
    if (start.getTime() + hours * 3600000 <= now.getTime()) continue;
    if (!out.some((x) => x.getTime() === start.getTime())) out.push(start);
  }
  return out;
}

module.exports = { suggest, rate, formatTables, START, PROVISIONAL, DAY_NAMES, tzOffset, localDay, upcomingStarts };
