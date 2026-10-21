// Pickleball scoring, shared by the server (require) and the browser
// (window.TonamentSports.pickleball). Needs rally.js.
//
// Side-out scoring (the default): only the serving side scores. In doubles
// both partners serve before a side-out, except the very first serving team
// (the "0-0-2" start), and the score is called serving-receiving-server
// ("4-2-1"). Rally scoring: every rally scores. Games to 11, win by 2.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./rally')) : factory(root.TonamentRally);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (R) => {
  'use strict';

  const DEFAULTS = Object.freeze({ scoring: 'sideout', bestOf: 3, points: 11 });

  function normalizeConfig(cfg = {}) {
    cfg = cfg || {};
    return {
      scoring: cfg.scoring === 'rally' ? 'rally' : 'sideout',
      bestOf: R.oneOf(cfg.bestOf, [1, 3, 5], DEFAULTS.bestOf),
      points: R.int(cfg.points, 5, 30, DEFAULTS.points),
      // Set by the server from the event: two players a side.
      ...(cfg.doubles ? { doubles: true } : {}),
    };
  }

  const firstServerNo = (c) => (c.doubles && c.scoring === 'sideout' ? 2 : 1);

  const rules = {
    init: (first, c) => ({ server: first, serverNo: firstServerNo(c), gameFirst: first }),
    rally(st, winner, game, c) {
      if (c.scoring === 'rally' || winner === st.server) {
        st.server = winner;
        return winner;
      }
      if (c.doubles && st.serverNo === 1) st.serverNo = 2; // partner serves next
      else {
        st.server = winner; // side-out
        st.serverNo = 1;
      }
      return null;
    },
    // The side that received first in the last game serves first in the next.
    nextGame(st, game, c) {
      st.gameFirst = R.other(st.gameFirst);
      st.server = st.gameFirst;
      st.serverNo = firstServerNo(c);
    },
    canScore: (st, side, c) => c.scoring === 'rally' || side === st.server,
    extra(st, game, c) {
      const mine = game[st.server];
      const call = [mine, game[R.other(st.server)], c.doubles && c.scoring === 'sideout' ? st.serverNo : null].filter((x) => x !== null).join('-');
      // What tapping each side does (shown on the umpire's buttons).
      const tap = c.scoring === 'rally' ? null
        : { [st.server]: '+1', [R.other(st.server)]: c.doubles && st.serverNo === 1 ? '2nd server' : 'Side out' };
      return { serveCourt: mine % 2 === 0 ? 'right' : 'left', note: `call ${call}`, call, serverNo: c.doubles ? st.serverNo : null, tap };
    },
  };

  return {
    id: 'pickleball',
    name: 'Pickleball',
    defaults: DEFAULTS,
    fields: [
      {
        key: 'scoring',
        label: 'Scoring',
        type: 'select',
        options: [
          { value: 'sideout', label: 'Side-out (only the server scores)' },
          { value: 'rally', label: 'Rally (every rally scores)' },
        ],
      },
      R.bestOfField([1, 3, 5]),
      { key: 'points', label: 'Points to win a game', type: 'number', min: 5, max: 30, hint: 'Usually 11 (15 or 21 for single games). Win by 2.' },
    ],
    normalizeConfig,
    compute: (rallies = '', cfg, firstServer = 'a') => R.play(rallies, normalizeConfig(cfg), firstServer, rules),
    summary: R.summary,
  };
});
