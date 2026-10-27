// Scores entered at the end ("21-17, 18-21, 21-15"): turned into the taps a
// live scorer would have made, so a match entered this way is the same as
// one scored live (standings, brackets, undo, the venue display). Works for
// every sport through its own compute(): side-out serving, win by 2, caps,
// tennis games and tie-breaks, snooker frames are all its rules, not ours.
// Shared by the server (require) and the browser (window.TonamentResult). Needs rally.js.

(function (root, factory) {
  const result = typeof module === 'object' && module.exports ? factory(require('./rally')) : factory(root.TonamentRally);
  if (typeof module === 'object' && module.exports) module.exports = result;
  else root.TonamentResult = result;
})(typeof self !== 'undefined' ? self : this, (R) => {
  'use strict';

  const other = (side) => (side === 'a' ? 'b' : 'a');

  // compute(log) -> score (the sport's, with the match's settings).
  // games: [{ a, b }] — what each game (set, frame) ended. -> { rallies, score } | { error }
  function fromScores(compute, games) {
    if (!Array.isArray(games) || !games.length) return { error: 'Enter the score of each game' };
    let log = '';
    let sc = compute(log);
    if (sc.timed) return fromTimed(compute, games);
    // Frames-only sports keep the whole match as one "game" of frames won.
    const first = sc.note; // "First to 3 frames"
    const unit = sc.single ? 'result' : (sc.unit || 'Game').toLowerCase();
    for (let i = 0; i < games.length; i++) {
      const t = { a: Number(games[i] && games[i].a), b: Number(games[i] && games[i].b) };
      const label = sc.single ? 'the match' : `${unit} ${i + 1}`;
      if (![t.a, t.b].every((n) => Number.isInteger(n) && n >= 0 && n <= 999)) return { error: `Enter both scores for ${label}` };
      if (t.a === t.b) return { error: `${t.a}-${t.b} can't finish ${label}: someone has to win it` };
      if (sc.winner) return { error: `The match was already won before ${label}` };
      if (sc.games.length - 1 !== i) return { error: `${label} doesn't follow on from the one before` };
      const win = t.a > t.b ? 'a' : 'b';
      const lose = other(win);
      const over = (s) => Boolean(s.games[i].winner || s.games.length > i + 1 || s.winner);
      // One "unit" for a side: a point (or a bigger tap: a snooker ball, a
      // carrom board), or in tennis a game, which takes several points.
      const award = (side, need) => {
        const max = (sc.taps && sc.taps.max) || 1;
        if (max > 1) return log + R.tapCode(side, Math.min(need, max));
        const before = sc.games[i][side];
        let next = log;
        for (let k = 0; k < 40; k++) {
          next += side;
          const s = compute(next);
          if (s.games[i][side] !== before || over(s)) return next;
        }
        return null;
      };
      for (let guard = 0; guard < 4000 && !over(sc); guard++) {
        const g = sc.games[i];
        const needL = t[lose] - g[lose];
        const needW = t[win] - g[win];
        if (needL <= 0 && needW <= 0) {
          if (sc.taps && sc.taps.end) { log += 'x'; sc = compute(log); continue; } // snooker: end the frame
          break;
        }
        // The loser's points first, as long as they don't end the game
        // (23-21 goes 20-20, 21-20, 21-21 … 23-21); then the winner's.
        let next = null;
        if (needL > 0) {
          const cand = award(lose, needL);
          if (cand && !over(compute(cand))) next = cand;
        }
        if (!next && needW > 0) next = award(win, needW);
        if (!next) break;
        log = next;
        sc = compute(log);
      }
      const g = sc.games[i];
      if (g.a !== t.a || g.b !== t.b || !g.winner) {
        return { error: sc.single
          ? `${t.a}-${t.b} doesn't finish the match${first ? ` (${first.toLowerCase()})` : ''}`
          : `${t.a}-${t.b} isn't a finished ${unit} under this match's rules — check ${label}` };
      }
    }
    return { rallies: log, score: sc };
  }

  // Football, basketball, …: games[0] is the final score (with any extra
  // time or overtime), games[1] the penalties / shoot-out when it ended level
  // and someone had to win. The periods are ended one by one, as a scorer would.
  function fromTimed(compute, games) {
    const num = (v) => Number(v);
    const ok = (g) => g && [num(g.a), num(g.b)].every((n) => Number.isInteger(n) && n >= 0 && n <= 999);
    if (!ok(games[0])) return { error: 'Enter both teams\' scores' };
    const add = (log, side, n, max) => {
      let out = log;
      for (let left = n; left > 0; left -= Math.min(left, max)) out += R.tapCode(side, Math.min(left, max));
      return out;
    };
    let sc = compute('');
    const max = sc.taps.max;
    let log = add(add('', 'a', num(games[0].a), max), 'b', num(games[0].b), max);
    sc = compute(log);
    for (let i = 0; i < 12 && sc.taps.end && sc.phase !== 'shootout'; i++) { log += 'x'; sc = compute(log); }
    if (sc.phase === 'shootout') {
      const tie = sc.tieName || 'Penalties';
      if (!ok(games[1])) return { error: `Level at full time — enter the ${tie.toLowerCase()} too` };
      if (num(games[1].a) === num(games[1].b)) return { error: `${tie} can't end level` };
      log = add(add(log, 'a', num(games[1].a), 1), 'b', num(games[1].b), 1) + 'x';
      sc = compute(log);
    } else if (games[1] && ok(games[1]) && num(games[1].a) + num(games[1].b) > 0) {
      return { error: sc.draw ? 'A drawn league match has no penalties' : 'Penalties only when it\'s level at full time' };
    }
    if (sc.phase === 'overtime') return { error: 'It can\'t end level — add the overtime points to the final score' };
    if (sc.phase !== 'over') return { error: 'That doesn\'t finish the match' };
    return { rallies: log, score: sc };
  }

  return { fromScores };
});
