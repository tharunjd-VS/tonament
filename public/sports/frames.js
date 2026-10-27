// Frame sports (snooker, pool): a match is best of N frames. In "frames
// only" mode the umpire taps who won each frame; snooker can also be scored
// ball by ball (spec.points), where each tap is a pot (1-7), a foul (4-7 to
// the other player) or "end frame". Shared by the server (require) and the
// browser (window.TonamentFrames). Needs rally.js.

(function (root, factory) {
  const frames = typeof module === 'object' && module.exports ? factory(require('./rally')) : factory(root.TonamentRally);
  if (typeof module === 'object' && module.exports) module.exports = frames;
  else root.TonamentFrames = frames;
})(typeof self !== 'undefined' ? self : this, (R) => {
  'use strict';

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // spec: { id, name, unit: 'Frame' | 'Rack', bestOf: [..], labels: { [bestOf]: 'Race to 3' }, defaults, extra: [fields], hint, points }
  // spec.points: offer ball-by-ball scoring (cfg.scoring = 'points' | 'frames').
  function frameSport(spec) {
    const D = Object.freeze(spec.points ? { scoring: 'points', ...spec.defaults } : spec.defaults);
    const unit = spec.unit || 'Frame';
    const extra = [
      ...(spec.points ? [{ key: 'scoring', label: 'Scoring', type: 'select', options: [{ value: 'points', label: 'Points, ball by ball' }, { value: 'frames', label: 'Frames only' }] }] : []),
      ...(spec.extra || []),
    ];
    const normalizeConfig = (cfg = {}) => {
      cfg = cfg || {};
      const n = Number(cfg.bestOf);
      const out = { bestOf: spec.bestOf.includes(n) ? n : D.bestOf };
      for (const f of extra) out[f.key] = f.options.some((o) => o.value === cfg[f.key]) ? cfg[f.key] : D[f.key];
      return out;
    };

    // Frames only: the whole match is one "game" whose score is frames won,
    // so the scoreboard shows frames as the big number.
    function framesOnly(rallies, c) {
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
        note: winner ? null : `First to ${plural(need, unit.toLowerCase())}`,
        gamePoint: { a: false, b: false },
        matchPoint: { a: false, b: false },
        totals: { a: won.a, b: won.b },
      };
    }

    // Ball by ball: points add up within a frame; "end frame" gives it to
    // whoever leads (a level frame goes on to the re-spotted black).
    function byPoints(rallies, c) {
      const need = Math.ceil(c.bestOf / 2);
      const games = [{ a: 0, b: 0, winner: null }];
      const gamesWon = { a: 0, b: 0 };
      let winner = null;
      let brk = { side: null, n: 0 };
      for (const ch of rallies || '') {
        if (winner) break;
        const tap = R.readTap(ch);
        if (!tap) continue;
        const frame = games[games.length - 1];
        if (tap.end) {
          if (frame.a === frame.b) continue;
          frame.winner = frame.a > frame.b ? 'a' : 'b';
          gamesWon[frame.winner] += 1;
          brk = { side: null, n: 0 };
          if (gamesWon[frame.winner] >= need) winner = frame.winner;
          else games.push({ a: 0, b: 0, winner: null });
          continue;
        }
        frame[tap.side] += tap.n;
        // A foul ends the break; the next pot starts a new one.
        brk = tap.foul ? { side: null, n: 0 } : brk.side === tap.side ? { side: tap.side, n: brk.n + tap.n } : { side: tap.side, n: tap.n };
      }
      const frame = games[games.length - 1];
      const notes = winner ? [] : [`${unit} ${games.length}`, brk.n ? `Break ${brk.n}` : null, `First to ${plural(need, unit.toLowerCase())}`];
      return {
        games,
        gamesWon,
        winner,
        server: null,
        unit,
        hint: 'Tap the ball potted, or the foul points, for the player who scores them. End the frame when it\'s decided.',
        firstLabel: 'Breaks first',
        serveCourt: null,
        note: notes.filter(Boolean).join(' · ') || null,
        brk: winner ? null : brk,
        // What the scorer can tap: pots worth 1-7, fouls, and ending the frame.
        taps: { max: 7, fouls: true, end: !winner && frame.a !== frame.b },
        gamePoint: { a: false, b: false },
        matchPoint: { a: false, b: false },
        totals: { a: games.reduce((s, g) => s + g.a, 0), b: games.reduce((s, g) => s + g.b, 0) },
      };
    }

    const compute = (rallies = '', cfg) => {
      const c = normalizeConfig(cfg);
      return c.scoring === 'points' ? byPoints(rallies, c) : framesOnly(rallies, c);
    };

    const summary = (score) => {
      if (score.single) {
        const g = score.games[0];
        return g.a + g.b > 0 ? `${g.a}-${g.b}` : '';
      }
      const played = score.games.filter((g) => g.a + g.b > 0);
      if (!played.length) return '';
      return `${score.gamesWon.a}-${score.gamesWon.b} (${played.map((g) => `${g.a}-${g.b}`).join(', ')})`;
    };

    return {
      id: spec.id,
      name: spec.name,
      defaults: D,
      fields: [
        { key: 'bestOf', label: 'Match length', type: 'select', options: spec.bestOf.map((n) => ({ value: n, label: (spec.labels && spec.labels[n]) || (n === 1 ? 'Single frame' : `Best of ${n} frames`) })) },
        ...extra,
      ],
      normalizeConfig,
      compute,
      summary,
    };
  }

  return { frameSport };
});
