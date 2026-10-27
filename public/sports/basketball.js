// Basketball: four quarters (or two halves); 1, 2 and 3-point baskets.
// Never a draw: level at the end means overtime, again until someone
// leads. Shared by the server (require) and the browser
// (window.TonamentSports.basketball). Needs timed.js.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./timed')) : factory(root.TonamentTimed);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (T) => {
  'use strict';

  return T.timedSport({
    id: 'basketball',
    name: 'Basketball',
    unit: 'Point',
    values: [1, 2, 3],
    periods: [4, 2],
    ties: ['overtime'],
    draws: false,
    leaguePoints: { win: 2, draw: 0 },
    firstLabel: 'Tip-off',
  });
});
