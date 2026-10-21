// Beach volleyball scoring, shared by the server (require) and the browser
// (window.TonamentSports['beach-volleyball']). Needs rally.js.
// Pairs; sets to 21, win by 2, best of 3; the deciding set to 15. Teams switch
// sides every 7 points (every 5 in the deciding set).

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./rally')) : factory(root.TonamentRally);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (R) => R.setSport({
  id: 'beach-volleyball',
  name: 'Beach volleyball',
  bestOf: [1, 3],
  points: [15, 21],
  deciders: [15],
  defaults: { bestOf: 3, points: 21, decider: 15 },
  switchEvery: [7, 5],
}));
