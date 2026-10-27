// The game-and-match loop shared by rally sports (pickleball, table tennis,
// squash): games to a target score, win by 2 (optionally capped), best of N.
// Each sport supplies only how the serve moves and whether a rally scores.
// Shared by the server (require) and the browser (window.TonamentRally).

(function (root, factory) {
  const rally = factory();
  if (typeof module === 'object' && module.exports) module.exports = rally;
  else root.TonamentRally = rally;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const other = (side) => (side === 'a' ? 'b' : 'a');

  function int(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  }
  const oneOf = (value, list, fallback) => (list.includes(Number(value)) ? Number(value) : fallback);

  // Taps: one character each, so undo, the stale-score check and the offline
  // queue all work per tap. 'a' / 'b' score 1; sports with bigger taps (a
  // snooker black, a carrom board) use C–M for side a scoring 2–12 and N–X
  // for side b. Snooker also has fouls, 4–7 points to the other player
  // (d–g to side a, h–k to side b), and 'x' to end a frame.
  const MAX_TAP = 12;
  const TAP_BASE = { a: 'C'.charCodeAt(0) - 2, b: 'N'.charCodeAt(0) - 2 };
  const FOUL_BASE = { a: 'd'.charCodeAt(0) - 4, b: 'h'.charCodeAt(0) - 4 };
  function tapCode(side, n = 1, foul = false) {
    if (side !== 'a' && side !== 'b') throw new Error('side must be a or b');
    if (foul) {
      if (!Number.isInteger(n) || n < 4 || n > 7) throw new Error('a foul is worth 4-7');
      return String.fromCharCode(FOUL_BASE[side] + n);
    }
    if (!Number.isInteger(n) || n < 1 || n > MAX_TAP) throw new Error('points must be 1-' + MAX_TAP);
    return n === 1 ? side : String.fromCharCode(TAP_BASE[side] + n);
  }
  // -> { side, n, foul? } | { end: true } | null for anything else
  function readTap(ch) {
    if (ch === 'a' || ch === 'b') return { side: ch, n: 1 };
    if (ch === 'x') return { end: true };
    const code = ch.charCodeAt(0);
    for (const side of ['a', 'b']) {
      const n = code - TAP_BASE[side];
      if (n >= 2 && n <= MAX_TAP) return { side, n };
      const f = code - FOUL_BASE[side];
      if (f >= 4 && f <= 7) return { side, n: f, foul: true };
    }
    return null;
  }

  // The character to add for one tap, checked against what the sport allows
  // right now (score.taps): a plain point to side a or b, a bigger pot or
  // board (points), a snooker foul or "end frame". -> { ch } or { error }.
  function tapFor(score, { side, points, foul, end } = {}) {
    const allowed = score.taps || { max: 1, fouls: false, end: false };
    if (end) return allowed.end ? { ch: 'x' } : { error: 'The frame can\'t end while the scores are level' };
    if (side !== 'a' && side !== 'b') return { error: 'side must be "a" or "b"' };
    const n = points == null ? (foul ? 4 : 1) : Number(points);
    if (foul) {
      if (!allowed.fouls) return { error: 'This sport has no fouls to score' };
      if (!Number.isInteger(n) || n < 4 || n > 7) return { error: 'A foul is worth 4 to 7 points' };
      return { ch: tapCode(side, n, true) };
    }
    if (!Number.isInteger(n) || n < 1 || n > allowed.max) return { error: allowed.max === 1 ? 'Score one point at a time' : `Points must be 1 to ${allowed.max}` };
    return { ch: tapCode(side, n) };
  }

  // c.decider: points for the deciding game (volleyball's 5th set to 15).
  const targetOf = (c, deciding) => (deciding && c.decider ? c.decider : c.points);
  function gameWonBy(game, side, c, deciding = false) {
    return Boolean(c.cap && game[side] >= c.cap) || (game[side] >= targetOf(c, deciding) && game[side] - game[other(side)] >= 2);
  }

  // rules: {
  //   init(firstServer, c) -> serve state ({ server, … }),
  //   rally(st, winner, game, c) -> the side that scores, or null (a side-out),
  //   nextGame(st, finishedGame, c) -> sets who serves first in the next game,
  //   canScore(st, side, c) -> whether side can score on the next rally (default: yes),
  //   extra(st, game, c) -> fields to add to the score while play is on (serveCourt, note, call),
  // }
  function play(rallies, c, firstServer, rules) {
    const need = Math.ceil(c.bestOf / 2);
    const games = [{ a: 0, b: 0, winner: null }];
    const gamesWon = { a: 0, b: 0 };
    const st = rules.init(firstServer === 'b' ? 'b' : 'a', c);
    let winner = null;

    for (const ch of rallies || '') {
      if (winner) break;
      const tap = readTap(ch);
      if (!tap || tap.end) continue;
      const game = games[games.length - 1];
      const scorer = rules.rally(st, tap.side, game, c);
      if (!scorer) continue;
      game[scorer] += tap.n; // a whole board in one tap may run past the target
      if (gameWonBy(game, scorer, c, games.length === c.bestOf)) {
        game.winner = scorer;
        gamesWon[scorer] += 1;
        if (gamesWon[scorer] >= need) winner = scorer;
        else {
          games.push({ a: 0, b: 0, winner: null });
          rules.nextGame(st, game, c);
        }
      }
    }

    const current = games[games.length - 1];
    const deciding = games.length === c.bestOf;
    const gamePoint = { a: false, b: false };
    const matchPoint = { a: false, b: false };
    if (!winner) {
      for (const side of ['a', 'b']) {
        if (rules.canScore && !rules.canScore(st, side, c)) continue;
        gamePoint[side] = gameWonBy({ ...current, [side]: current[side] + 1 }, side, c, deciding);
        matchPoint[side] = gamePoint[side] && gamesWon[side] + 1 >= need;
      }
    }

    return {
      games,
      gamesWon,
      winner,
      server: winner ? null : st.server,
      unit: rules.unit || 'Game',
      serveCourt: null,
      note: null,
      ...(winner || !rules.extra ? {} : rules.extra(st, current, c, deciding)),
      gamePoint,
      matchPoint,
      totals: {
        a: games.reduce((s, g) => s + g.a, 0),
        b: games.reduce((s, g) => s + g.b, 0),
      },
    };
  }

  function summary(score) {
    return score.games
      .filter((g) => g.a + g.b > 0)
      .map((g) => `${g.a}-${g.b}`)
      .join(', ');
  }

  const bestOfField = (values, unit = 'game') => ({
    key: 'bestOf',
    label: 'Match length',
    type: 'select',
    options: values.map((n) => ({ value: n, label: n === 1 ? `Single ${unit}` : `Best of ${n} ${unit}s` })),
  });

  // A set-based sport (volleyball, throwball, …): every rally scores and its
  // winner serves; the first serve alternates each set; the deciding set can
  // be shorter. spec: { id, name, bestOf: [..], points: [..], deciders: [..],
  // defaults, switchEvery: [points per side switch, in the deciding set] }
  function setSport(spec) {
    const D = Object.freeze(spec.defaults);
    const normalizeConfig = (cfg = {}) => {
      cfg = cfg || {};
      const points = oneOf(cfg.points, spec.points, D.points);
      // 0 = the deciding set is played to the same score.
      const decider = cfg.decider === undefined ? D.decider : oneOf(cfg.decider, [0, ...spec.deciders], D.decider);
      return { bestOf: oneOf(cfg.bestOf, spec.bestOf, D.bestOf), points, decider: decider && decider < points ? decider : 0 };
    };
    const rules = {
      unit: 'Set',
      init: (first) => ({ server: first, setFirst: first }),
      rally(st, winner) {
        st.server = winner;
        return winner;
      },
      nextGame(st) {
        st.setFirst = other(st.setFirst);
        st.server = st.setFirst;
      },
      extra(st, game, c, deciding) {
        if (!spec.switchEvery) return {};
        const every = spec.switchEvery[deciding ? 1 : 0];
        const n = game.a + game.b;
        return n > 0 && n % every === 0 ? { note: 'switch sides' } : {};
      },
    };
    return {
      id: spec.id,
      name: spec.name,
      defaults: D,
      fields: [
        bestOfField(spec.bestOf, 'set'),
        { key: 'points', label: 'Points to win a set', type: 'select', options: spec.points.map((p) => ({ value: p, label: String(p) })) },
        {
          key: 'decider',
          label: 'Deciding set to',
          type: 'select',
          options: [{ value: 0, label: 'Same as other sets' }, ...spec.deciders.map((p) => ({ value: p, label: String(p) }))],
          hint: 'Win by 2.',
        },
      ],
      normalizeConfig,
      compute: (rallies = '', cfg, firstServer = 'a') => play(rallies, normalizeConfig(cfg), firstServer, rules),
      summary,
    };
  }

  return { other, int, oneOf, gameWonBy, play, summary, bestOfField, setSport, MAX_TAP, tapCode, readTap, tapFor };
});
