// Kabaddi: two halves; points from raids, tackles, bonuses and all-outs
// (one tap adds 1–5). League matches can be drawn (2 points for a win, 1
// for a tie); a level knockout match goes to tie-break raids. Shared by the
// server (require) and the browser (window.TonamentSports.kabaddi). Needs timed.js.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./timed')) : factory(root.TonamentTimed);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (T) => {
  'use strict';

  return T.timedSport({
    id: 'kabaddi',
    name: 'Kabaddi',
    unit: 'Point',
    values: [1, 2, 3, 4, 5],
    periods: [2],
    ties: ['raids'],
    draws: true,
    leaguePoints: { win: 2, draw: 1 },
    firstLabel: 'First raid',
  });
});
