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

  function gameWonBy(game, side, c) {
    return Boolean(c.cap && game[side] >= c.cap) || (game[side] >= c.points && game[side] - game[other(side)] >= 2);
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

    for (const side of rallies || '') {
      if (winner) break;
      if (side !== 'a' && side !== 'b') continue;
      const game = games[games.length - 1];
      const scorer = rules.rally(st, side, game, c);
      if (!scorer) continue;
      game[scorer] += 1;
      if (gameWonBy(game, scorer, c)) {
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
    const gamePoint = { a: false, b: false };
    const matchPoint = { a: false, b: false };
    if (!winner) {
      for (const side of ['a', 'b']) {
        if (rules.canScore && !rules.canScore(st, side, c)) continue;
        gamePoint[side] = gameWonBy({ ...current, [side]: current[side] + 1 }, side, c);
        matchPoint[side] = gamePoint[side] && gamesWon[side] + 1 >= need;
      }
    }

    return {
      games,
      gamesWon,
      winner,
      server: winner ? null : st.server,
      serveCourt: null,
      note: null,
      ...(winner || !rules.extra ? {} : rules.extra(st, current, c)),
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

  const bestOfField = (values) => ({
    key: 'bestOf',
    label: 'Match length',
    type: 'select',
    options: values.map((n) => ({ value: n, label: n === 1 ? 'Single game' : `Best of ${n} games` })),
  });

  return { other, int, oneOf, gameWonBy, play, summary, bestOfField };
});
