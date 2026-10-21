// Volleyball scoring, shared by the server (require) and the browser
// (window.TonamentSports['volleyball']). Needs rally.js.
// Rally scoring: sets to 25, win by 2, best of 5; the deciding set to 15.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./rally')) : factory(root.TonamentRally);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (R) => R.setSport({
  id: 'volleyball',
  name: 'Volleyball',
  bestOf: [3, 5],
  points: [15, 21, 25],
  deciders: [15],
  defaults: { bestOf: 5, points: 25, decider: 15 },
}));
