'use strict';

// When each rally (point, goal, frame…) was scored, kept beside a match's
// rallies string: rally_times[i] is the time of rallies[i], in milliseconds.
// Video, highlights and stats line up with these later. Matches from before
// times were kept, and scores entered at the end, have none (null).

const AHEAD_MS = 5000; // a phone's clock a little ahead is fine
const OLD_MS = 12 * 3600000; // an offline tap older than this isn't believable

// The times after a change from `before` to `after` (rallies strings).
// tapAt: when the tap happened on the scorer's phone (the server's clock if
// absent); REPLACED when the whole score was entered at the end (no times).
const REPLACED = false;
function nextTimes(before, times, after, tapAt, now = Date.now()) {
  if (tapAt === REPLACED) return after ? null : [];
  const known = Array.isArray(times) && times.length === before.length ? times : null;
  if (after === before) return known;
  if (after.startsWith(before)) {
    // Points added: the tap's time, never before the last point or in the future.
    const base = known || Array(before.length).fill(null);
    let t = Number(tapAt);
    if (!Number.isFinite(t) || t > now + AHEAD_MS || t < now - OLD_MS) t = now;
    t = Math.min(t, now);
    const last = base.reduce((max, x) => (x != null && x > max ? x : max), 0);
    t = Math.max(t, last);
    return [...base, ...Array(after.length - before.length).fill(t)];
  }
  // Undone, or cut back (a scoring change): the times that are left.
  if (before.startsWith(after)) return known ? known.slice(0, after.length) : (after ? null : []);
  // Replaced (a score entered at the end): no times.
  return after ? null : [];
}

const json = (times) => (times == null ? null : JSON.stringify(times));

module.exports = { nextTimes, json, REPLACED };
