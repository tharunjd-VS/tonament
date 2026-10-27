// Order of play across every event of a tournament: which match goes on
// court next, who is still busy on another court, and roughly when each
// match should start. Shared by the server (require; auto-calling the next
// match) and the browser (<script>, as window.TonamentSchedule) so both put
// the same match next.

(function (root, factory) {
  const schedule = factory();
  if (typeof module === 'object' && module.exports) module.exports = schedule;
  else root.TonamentSchedule = schedule;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Typical match length in minutes, used for estimated start times.
  const MINUTES = {
    badminton: 25, pickleball: 20, 'table-tennis': 20, squash: 30, tennis: 75, padel: 75,
    volleyball: 60, 'beach-volleyball': 45, throwball: 45, 'sepak-takraw': 40,
    snooker: 45, pool: 30, carrom: 40,
  };
  const defaultMinutes = (sport) => MINUTES[sport] || 30;
  const MAX_COURTS = 40;
  const MINUTE = 60000;

  // The people in an entry: "Asha / Ben" is two, so a player in singles and
  // doubles is never called to two courts at once (matched by name).
  const people = (entry) => (entry ? entry.name.split('/').map((p) => p.trim()).filter(Boolean) : []);
  const key = (name) => name.toLowerCase().replace(/\s+/g, ' ');

  // A match can be played once both sides are known and its stage is open.
  const playable = (ev, m) => m.status === 'scheduled' && m.a && m.b
    && (m.stage === 'league' ? ev.status === 'league' : ev.status === 'knockout');

  // events: [{ id, name, status, matches: [{ id, stage, round, group, slot,
  //   status, a, b, court, queuePos, calledAt, catchUp }] }] in event order.
  // Returns { courts: [{ name, match, freeAt, next }], queue: [{ match, event,
  //   startsAt, waitingFor: [{ name, court }] }], next }.
  function orderOfPlay({ events, courts = [], minutes = 30, now = Date.now() }) {
    const length = minutes * MINUTE;
    const all = events.flatMap((ev, evIndex) => ev.matches.map((m) => ({ m, ev, evIndex })));

    // On court now: busy until called + a typical match (or a few more minutes if it's running long).
    const busy = new Map(); // person key -> { name, court, until }
    const onCourt = new Map(); // court name -> { match, event, until }
    for (const x of all.filter((y) => y.m.status === 'live')) {
      const started = x.m.calledAt ? Date.parse(x.m.calledAt) : now;
      const until = Math.max(started + length, now + 5 * MINUTE);
      if (x.m.court && !onCourt.has(x.m.court)) onCourt.set(x.m.court, { match: x.m, event: x.ev, until });
      for (const p of [...people(x.m.a), ...people(x.m.b)]) busy.set(key(p), { name: p, court: x.m.court, until });
    }

    // Pinned matches first ("Play next"), then catch-up matches, then round
    // by round across the events, so every event moves along together.
    const pin = (m) => (m.queuePos == null ? Infinity : m.queuePos);
    const ready = all.filter((x) => playable(x.ev, x.m)).sort((x, y) => pin(x.m) - pin(y.m)
      || Number(Boolean(y.m.catchUp)) - Number(Boolean(x.m.catchUp))
      || (x.m.stage === 'knockout') - (y.m.stage === 'knockout')
      || x.m.round - y.m.round
      || x.evIndex - y.evIndex
      || (x.m.group ?? 0) - (y.m.group ?? 0)
      || x.m.slot - y.m.slot
      || x.m.id - y.m.id);

    // Estimated starts: each match takes the earliest free court once its players are free.
    const courtFree = courts.map((name) => (onCourt.has(name) ? onCourt.get(name).until : now));
    const personFree = new Map([...busy].map(([k, v]) => [k, v.until]));
    const queue = ready.map((x) => {
      const names = [...people(x.m.a), ...people(x.m.b)];
      let startsAt = null;
      if (courts.length) {
        const c = courtFree.indexOf(Math.min(...courtFree));
        startsAt = Math.max(courtFree[c], ...names.map((p) => personFree.get(key(p)) || now));
        courtFree[c] = startsAt + length;
        for (const p of names) personFree.set(key(p), startsAt + length);
      }
      const waitingFor = names.filter((p) => busy.has(key(p))).map((p) => ({ name: p, court: busy.get(key(p)).court }));
      return { match: x.m, event: x.ev, startsAt, waitingFor };
    });

    // Each free court gets its own suggestion: the next match whose players
    // are all free and not already suggested for another court.
    const suggested = new Set();
    const pick = () => {
      const x = queue.find((y) => !y.waitingFor.length && ![...people(y.match.a), ...people(y.match.b)].some((p) => suggested.has(key(p))));
      if (x) for (const p of [...people(x.match.a), ...people(x.match.b)]) suggested.add(key(p));
      return x || null;
    };
    return {
      courts: courts.map((name) => {
        const here = onCourt.get(name);
        if (here) return { name, match: here.match, event: here.event, freeAt: here.until, next: null };
        return { name, match: null, event: null, freeAt: null, next: pick() };
      }),
      queue,
      // The match to call to the next free court: the first whose players are all free.
      next: queue.find((x) => !x.waitingFor.length) || null,
    };
  }

  return { MAX_COURTS, defaultMinutes, people, orderOfPlay };
});
