// Sepak takraw scoring, shared by the server (require) and the browser
// (window.TonamentSports['sepak-takraw']). Needs rally.js.
// Rally scoring: sets to 21, win by 2, best of 3; the deciding set to 15.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./rally')) : factory(root.TonamentRally);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (R) => R.setSport({
  id: 'sepak-takraw',
  name: 'Sepak takraw',
  bestOf: [1, 3],
  points: [15, 21],
  deciders: [15],
  defaults: { bestOf: 3, points: 21, decider: 15 },
}));
