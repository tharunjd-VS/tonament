// Pool (8-ball, 9-ball, 10-ball): a race to N racks; the umpire taps who won
// each rack. Shared by the server (require) and the browser
// (window.TonamentSports.pool). Needs frames.js.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./frames')) : factory(root.TonamentFrames);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (F) => {
  'use strict';

  return F.frameSport({
    id: 'pool',
    name: 'Pool',
    unit: 'Rack',
    // Race to N = best of 2N − 1.
    bestOf: [1, 3, 5, 7, 9, 11, 13],
    labels: { 1: 'Single rack', 3: 'Race to 2', 5: 'Race to 3', 7: 'Race to 4', 9: 'Race to 5', 11: 'Race to 6', 13: 'Race to 7' },
    defaults: { bestOf: 5, game: '8-ball' },
    extra: [{ key: 'game', label: 'Game', type: 'select', options: [{ value: '8-ball', label: '8-ball' }, { value: '9-ball', label: '9-ball' }, { value: '10-ball', label: '10-ball' }] }],
  });
});
