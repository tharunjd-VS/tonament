// Futsal: two halves; goals. League matches can be drawn (3 points for a
// win, 1 for a draw); a level knockout match goes to penalties, or extra
// time and then penalties. Shared by the server (require) and the browser
// (window.TonamentSports.futsal). Needs timed.js.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./timed')) : factory(root.TonamentTimed);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (T) => {
  'use strict';

  return T.timedSport({
    id: 'futsal',
    name: 'Futsal',
    unit: 'Goal',
    values: [1],
    periods: [2],
    ties: ['penalties', 'extra'],
    draws: true,
    leaguePoints: { win: 3, draw: 1 },
    firstLabel: 'Kick-off',
  });
});
