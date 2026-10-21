// Tennis scoring, shared by the server (require) and the browser
// (window.TonamentSports.tennis). Needs tennis-core.js.
// Best of 3 sets of 6 games, advantage at deuce, tie-break at 6-6.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./tennis-core')) : factory(root.TonamentTennis);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (T) => T.racketSport({
  id: 'tennis',
  name: 'Tennis',
  defaults: { bestOf: 3, games: 6, scoring: 'ad', finalSet: 'set' },
}));
