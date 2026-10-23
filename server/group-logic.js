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

module.exports = { suggest, rate, START, PROVISIONAL, DAY_NAMES, tzOffset, localDay, upcomingStarts };
