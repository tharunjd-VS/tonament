// Table tennis scoring (ITTF), shared by the server (require) and the browser
// (window.TonamentSports['table-tennis']). Needs rally.js.
// Games to 11, win by 2; the serve changes every 2 points, and every point
// from 10-10. The side that received first serves first in the next game.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./rally')) : factory(root.TonamentRally);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (R) => {
  'use strict';

  const DEFAULTS = Object.freeze({ bestOf: 5, points: 11 });

  function normalizeConfig(cfg = {}) {
    cfg = cfg || {};
    return { bestOf: R.oneOf(cfg.bestOf, [1, 3, 5, 7], DEFAULTS.bestOf), points: R.oneOf(cfg.points, [11, 21], DEFAULTS.points) };
  }

  // Serves change every 2 points (every 5 when games are to 21), and every point at deuce.
  const per = (c) => (c.points === 21 ? 5 : 2);
  const deuce = (game, c) => game.a >= c.points - 1 && game.b >= c.points - 1;
  function serverFor(st, game, c) {
    const n = game.a + game.b;
    const turn = deuce(game, c) ? (c.points - 1) * 2 / per(c) + (n - (c.points - 1) * 2) : Math.floor(n / per(c));
    return turn % 2 === 0 ? st.gameFirst : R.other(st.gameFirst);
  }

  const rules = {
    init: (first) => ({ server: first, gameFirst: first }),
    rally(st, winner, game, c) {
      game[winner] += 1; // look ahead to place the next serve
      st.server = serverFor(st, game, c);
      game[winner] -= 1;
      return winner;
    },
    nextGame(st) {
      st.gameFirst = R.other(st.gameFirst);
      st.server = st.gameFirst;
    },
    extra(st, game, c) {
      if (deuce(game, c)) return { note: '1 serve each at deuce' };
      return { note: `serve ${((game.a + game.b) % per(c)) + 1} of ${per(c)}` };
    },
  };

  return {
    id: 'table-tennis',
    name: 'Table tennis',
    defaults: DEFAULTS,
    fields: [
      R.bestOfField([1, 3, 5, 7]),
      { key: 'points', label: 'Points to win a game', type: 'select', options: [{ value: 11, label: '11 (standard)' }, { value: 21, label: '21 (old style)' }] },
    ],
    normalizeConfig,
    compute: (rallies = '', cfg, firstServer = 'a') => R.play(rallies, normalizeConfig(cfg), firstServer, rules),
    summary: R.summary,
  };
});
