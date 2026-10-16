// Badminton scoring rules, shared by the server (require) and the browser
// (<script>, as window.TonamentSports.badminton) so the umpire's screen can
// show each point instantly with exactly the rules the server applies.

// Badminton scoring (BWF rally-point system).
// A match is stored as a string of rally winners ("abba..."), and the score is
// always derived by replaying it. That makes undo trivial and keeps the stored
// data impossible to get out of sync.

(function (root, factory) {
  const sport = factory();
  if (typeof module === 'object' && module.exports) module.exports = sport;
  else (root.TonamentSports = root.TonamentSports || {})[sport.id] = sport;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const DEFAULTS = Object.freeze({ bestOf: 3, points: 21, cap: 30 });

  function int(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  }

  function normalizeConfig(cfg = {}) {
    cfg = cfg || {};
    const bestOf = [1, 3, 5].includes(Number(cfg.bestOf)) ? Number(cfg.bestOf) : DEFAULTS.bestOf;
    const points = int(cfg.points, 5, 50, DEFAULTS.points);
    const defaultCap = points === DEFAULTS.points ? DEFAULTS.cap : points + 9;
    const cap = int(cfg.cap, points, 99, Math.max(points, defaultCap));
    return { bestOf, points, cap };
  }

  const other = (side) => (side === 'a' ? 'b' : 'a');

  function gameWonBy(game, side, c) {
    return game[side] >= c.cap || (game[side] >= c.points && game[side] - game[other(side)] >= 2);
  }

  function compute(rallies = '', cfg, firstServer = 'a') {
    const c = normalizeConfig(cfg);
    const need = Math.ceil(c.bestOf / 2);
    const games = [{ a: 0, b: 0, winner: null }];
    const gamesWon = { a: 0, b: 0 };
    let server = firstServer === 'b' ? 'b' : 'a';
    let winner = null;

    for (const side of rallies) {
      if (winner) break;
      if (side !== 'a' && side !== 'b') continue;
      const game = games[games.length - 1];
      game[side] += 1;
      server = side; // the rally winner serves next (and starts the next game)
      if (gameWonBy(game, side, c)) {
        game.winner = side;
        gamesWon[side] += 1;
        if (gamesWon[side] >= need) winner = side;
        else games.push({ a: 0, b: 0, winner: null });
      }
    }

    const current = games[games.length - 1];
    const gamePoint = { a: false, b: false };
    const matchPoint = { a: false, b: false };
    if (!winner) {
      for (const side of ['a', 'b']) {
        gamePoint[side] = gameWonBy({ ...current, [side]: current[side] + 1 }, side, c);
        matchPoint[side] = gamePoint[side] && gamesWon[side] + 1 >= need;
      }
    }

    return {
      games,
      gamesWon,
      winner,
      server: winner ? null : server,
      // Server serves from the right service court when their own score is even.
      serveCourt: winner ? null : current[server] % 2 === 0 ? 'right' : 'left',
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

  return {
    id: 'badminton',
    name: 'Badminton',
    defaults: DEFAULTS,
    fields: [
      {
        key: 'bestOf',
        label: 'Match length',
        type: 'select',
        options: [
          { value: 1, label: 'Single game' },
          { value: 3, label: 'Best of 3 games' },
          { value: 5, label: 'Best of 5 games' },
        ],
      },
      { key: 'points', label: 'Points to win a game', type: 'number', min: 5, max: 50 },
      {
        key: 'cap',
        label: 'Point cap',
        type: 'number',
        min: 5,
        max: 99,
        hint: 'At deuce the first to this score wins. Same as points = no deuce.',
      },
    ],
    normalizeConfig,
    compute,
    summary,
  };
});
