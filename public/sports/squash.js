// Squash scoring (PAR, point-a-rally), shared by the server (require) and
// the browser (window.TonamentSports.squash). Needs rally.js.
// Every rally scores and its winner serves; games to 11, win by 2. The
// winner of a game serves first in the next.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./rally')) : factory(root.TonamentRally);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (R) => {
  'use strict';

  const DEFAULTS = Object.freeze({ bestOf: 5, points: 11 });

  function normalizeConfig(cfg = {}) {
    cfg = cfg || {};
    return { bestOf: R.oneOf(cfg.bestOf, [1, 3, 5], DEFAULTS.bestOf), points: R.oneOf(cfg.points, [11, 15], DEFAULTS.points) };
  }

  const rules = {
    init: (first) => ({ server: first }),
    rally(st, winner) {
      st.server = winner;
      return winner;
    },
    nextGame() {}, // the game's winner won the last rally, so already serves
  };

  return {
    id: 'squash',
    name: 'Squash',
    defaults: DEFAULTS,
    fields: [
      R.bestOfField([1, 3, 5]),
      { key: 'points', label: 'Points to win a game', type: 'select', options: [{ value: 11, label: '11 (standard)' }, { value: 15, label: '15' }] },
    ],
    normalizeConfig,
    compute: (rallies = '', cfg, firstServer = 'a') => R.play(rallies, normalizeConfig(cfg), firstServer, rules),
    summary: R.summary,
  };
});
