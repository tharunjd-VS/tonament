// Hockey (field hockey): four quarters (or two halves); goals. League
// matches can be drawn (3 points for a win, 1 for a draw); a level knockout
// match goes to a shoot-out. Shared by the server (require) and the browser
// (window.TonamentSports.hockey). Needs timed.js.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./timed')) : factory(root.TonamentTimed);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (T) => {
  'use strict';

  return T.timedSport({
    id: 'hockey',
    name: 'Hockey',
    unit: 'Goal',
    values: [1],
    periods: [4, 2],
    ties: ['shootout'],
    draws: true,
    leaguePoints: { win: 3, draw: 1 },
    firstLabel: 'Pushback',
  });
});
