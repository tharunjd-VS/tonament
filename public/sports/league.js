// League matches of exactly 2 games (or sets), where 1-1 is a draw. Shared
// by the server (require) and the browser (<script>, as window.TonamentLeague)
// so both agree when a drawn match is over.
//
// Every sport's engine already scores best of 3: a 2-0 is its normal win,
// and game and match points in game 2 are right (the leader's game point
// wins the match; the trailer's draws it). We only stop after game 2.

(function (root, factory) {
  const league = factory();
  if (typeof module === 'object' && module.exports) module.exports = league;
  else root.TonamentLeague = league;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const GAMES = 2;

  // sport: a rules module (compute, …). opts.draws: this match is a 2-game league match.
  function score(sport, rallies, cfg, firstServer, opts = {}) {
    if (!opts.draws) return sport.compute(rallies, cfg, firstServer);
    const s = sport.compute(rallies, { ...(cfg || {}), bestOf: 3 }, firstServer);
    const done = s.games.slice(0, GAMES);
    if (s.winner || done.length < GAMES || !done.every((g) => g.winner)) return s;
    // 1-1 after two games: a draw. The engine has opened an empty game 3;
    // drop it (it adds nothing to the totals).
    return {
      ...s,
      games: done,
      winner: null,
      draw: true,
      server: null,
      serveCourt: null,
      points: null,
      setGames: null,
      note: null,
      gamePoint: { a: false, b: false },
      matchPoint: { a: false, b: false },
    };
  }

  // Is the match over (won or drawn)?
  const finished = (s) => Boolean(s.winner || s.draw);

  return { GAMES, score, finished };
});
