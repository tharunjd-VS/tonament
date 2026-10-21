// Padel scoring, shared by the server (require) and the browser
// (window.TonamentSports.padel). Needs tennis-core.js.
// Pairs; scored like tennis: best of 3 sets of 6 games, tie-break at 6-6.
// Many clubs play a golden point at deuce — an option in the settings.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./tennis-core')) : factory(root.TonamentTennis);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (T) => T.racketSport({
  id: 'padel',
  name: 'Padel',
  defaults: { bestOf: 3, games: 6, scoring: 'ad', finalSet: 'set' },
}));
