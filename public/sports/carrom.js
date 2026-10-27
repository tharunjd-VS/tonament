// Carrom: games to 25 (or 29) points, best of 1 or 3. After each board, the
// umpire taps the points its winner scores (the opponent's coins left on the
// board, plus 3 for the queen) in one tap. No win-by-2: first to the target wins.
// Shared by the server (require) and the browser (window.TonamentSports.carrom). Needs rally.js.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./rally')) : factory(root.TonamentRally);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (R) => {
  'use strict';

  const DEFAULTS = Object.freeze({ bestOf: 3, points: 25 });

  function normalizeConfig(cfg = {}) {
    cfg = cfg || {};
    return { bestOf: R.oneOf(cfg.bestOf, [1, 3], DEFAULTS.bestOf), points: R.oneOf(cfg.points, [25, 29], DEFAULTS.points) };
  }

  const rules = {
    init: () => ({ server: null }),
    rally: (st, winner) => winner,
    nextGame() {},
  };

  function compute(rallies = '', cfg, firstServer = 'a') {
    const c = normalizeConfig(cfg);
    // A cap equal to the target: reaching it wins, with no margin needed.
    const score = R.play(rallies, { ...c, cap: c.points }, firstServer, rules);
    return { ...score, server: null, hint: 'After each board, tap the points its winner scores: the opponent\'s coins left, +3 for the queen.', firstLabel: 'Breaks first', taps: { max: R.MAX_TAP, fouls: false, end: false } };
  }

  return {
    id: 'carrom',
    name: 'Carrom',
    defaults: DEFAULTS,
    fields: [
      R.bestOfField([1, 3]),
      { key: 'points', label: 'Points to win a game', type: 'select', options: [{ value: 25, label: '25 (standard)' }, { value: 29, label: '29' }] },
    ],
    normalizeConfig,
    compute,
    summary: R.summary,
  };
});
