// Frame sports (snooker, pool): a match is best of N frames and the umpire
// taps who won each frame. Shared by the server (require) and the browser
// (window.TonamentFrames).

(function (root, factory) {
  const frames = factory();
  if (typeof module === 'object' && module.exports) module.exports = frames;
  else root.TonamentFrames = frames;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // spec: { id, name, unit: 'Frame' | 'Rack', bestOf: [..], labels: { [bestOf]: 'Race to 3' }, defaults, extra: [fields], hint }
  function frameSport(spec) {
    const D = Object.freeze(spec.defaults);
    const unit = spec.unit || 'Frame';
    const normalizeConfig = (cfg = {}) => {
      cfg = cfg || {};
      const n = Number(cfg.bestOf);
      const out = { bestOf: spec.bestOf.includes(n) ? n : D.bestOf };
      for (const f of spec.extra || []) out[f.key] = f.options.some((o) => o.value === cfg[f.key]) ? cfg[f.key] : D[f.key];
      return out;
    };

    // The whole match is one "game" whose score is frames won, so the
    // scoreboard shows frames as the big number.
    function compute(rallies = '', cfg) {
      const c = normalizeConfig(cfg);
      const need = Math.ceil(c.bestOf / 2);
      const won = { a: 0, b: 0 };
      let winner = null;
      for (const side of rallies || '') {
        if (winner) break;
        if (side !== 'a' && side !== 'b') continue;
        won[side] += 1;
        if (won[side] >= need) winner = side;
      }
      return {
        games: [{ a: won.a, b: won.b, winner }],
        gamesWon: { a: winner === 'a' ? 1 : 0, b: winner === 'b' ? 1 : 0 },
        winner,
        server: null,
        unit,
        single: true, // no separate games column: the score is frames
        tap: { a: unit, b: unit },
        hint: spec.hint || `Tap who won each ${unit.toLowerCase()}.`,
        firstLabel: 'Breaks first',
        serveCourt: null,
        note: winner ? null : `First to ${need} ${unit.toLowerCase()}${need === 1 ? '' : 's'}`,
        gamePoint: { a: false, b: false },
        matchPoint: { a: false, b: false },
        totals: { a: won.a, b: won.b },
      };
    }

    const summary = (score) => {
      const g = score.games[0];
      return g.a + g.b > 0 ? `${g.a}-${g.b}` : '';
    };

    return {
      id: spec.id,
      name: spec.name,
      defaults: D,
      fields: [
        { key: 'bestOf', label: 'Match length', type: 'select', options: spec.bestOf.map((n) => ({ value: n, label: (spec.labels && spec.labels[n]) || (n === 1 ? 'Single frame' : `Best of ${n} frames`) })) },
        ...(spec.extra || []),
      ],
      normalizeConfig,
      compute,
      summary,
    };
  }

  return { frameSport };
});
