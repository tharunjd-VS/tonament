// Throwball scoring, shared by the server (require) and the browser
// (window.TonamentSports['throwball']). Needs rally.js.
// Rally scoring: sets to 25, win by 2, best of 3 (some leagues play to 15).

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./rally')) : factory(root.TonamentRally);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (R) => R.setSport({
  id: 'throwball',
  name: 'Throwball',
  bestOf: [1, 3, 5],
  points: [15, 21, 25],
  deciders: [15],
  defaults: { bestOf: 3, points: 25, decider: 0 },
}));
