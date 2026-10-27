// Snooker: best of N frames; the umpire taps who won each frame. Shared by
// the server (require) and the browser (window.TonamentSports.snooker). Needs frames.js.

(function (root, factory) {
  const sport = typeof module === 'object' && module.exports ? factory(require('./frames')) : factory(root.TonamentFrames);
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, (F) => {
  'use strict';

  return F.frameSport({
    id: 'snooker',
    name: 'Snooker',
    bestOf: [1, 3, 5, 7, 9, 11],
    defaults: { bestOf: 3 },
  });
});
