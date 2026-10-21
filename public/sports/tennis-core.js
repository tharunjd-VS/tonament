// Tennis-style scoring (tennis, padel), shared by the server (require) and
// the browser (window.TonamentTennis). Points 15-30-40 with advantage or a
// golden (deciding) point, sets of 6 games with a tie-break at 6-6, and an
// optional 10-point match tie-break instead of the final set.
//
// Like every sport, a match is stored as the string of rally winners
// ("abba…") and the score is derived by replaying it.

(function (root, factory) {
  const core = factory();
  if (typeof module === 'object' && module.exports) module.exports = core;
  else root.TonamentTennis = core;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const other = (side) => (side === 'a' ? 'b' : 'a');
  const oneOf = (value, list, fallback) => (list.includes(value) ? value : list.includes(Number(value)) ? Number(value) : fallback);
  const CALL = ['0', '15', '30', '40'];

  // Replays the points. Returns the full state (used for the score and for
  // looking one point ahead to find set and match points).
  function run(rallies, c, firstServer) {
    const need = Math.ceil(c.bestOf / 2);
    const sets = [];
    const setsWon = { a: 0, b: 0 };
    let set;
    let server = firstServer === 'b' ? 'b' : 'a';
    let points = { a: 0, b: 0 }; // in the current game or tie-break
    let tiebreak = null; // { first, target } while a tie-break is on
    let winner = null;
    let lastSetTotal = 0; // games in the previous set (for changing ends)
    // Games won by each side over the match (standings).
    const gamesBy = { a: 0, b: 0 };

    function newSet() {
      const final = sets.length + 1 === c.bestOf && c.bestOf > 1;
      set = { a: 0, b: 0, winner: null };
      sets.push(set);
      points = { a: 0, b: 0 };
      if (final && c.finalSet === 'super') {
        set.super = true;
        tiebreak = { first: server, target: 10 };
      }
    }
    newSet();

    function winSet(w) {
      set.winner = w;
      setsWon[w] += 1;
      lastSetTotal = set.a + set.b;
      if (setsWon[w] >= need) winner = w;
      else newSet();
    }

    for (const w of rallies || '') {
      if (winner) break;
      if (w !== 'a' && w !== 'b') continue;
      points[w] += 1;
      const o = other(w);
      if (tiebreak) {
        if (points[w] >= tiebreak.target && points[w] - points[o] >= 2) {
          set.tb = { ...points };
          if (set.super) {
            set[w] = 1;
          } else {
            set[w] += 1;
          }
          gamesBy[w] += 1;
          server = other(tiebreak.first); // the tie-break's first receiver serves next
          tiebreak = null;
          winSet(w);
        }
        continue;
      }
      const won = c.scoring === 'golden' ? points[w] >= 4 && points[o] <= 3 : points[w] >= 4 && points[w] - points[o] >= 2;
      if (!won) continue;
      set[w] += 1;
      gamesBy[w] += 1;
      server = other(server);
      points = { a: 0, b: 0 };
      if (set[w] >= c.games && set[w] - set[o] >= 2) winSet(w);
      else if (set.a === c.games && set.b === c.games) tiebreak = { first: server, target: 7 };
    }

    // Who serves now: in a tie-break, the first server serves once, then
    // the serve changes every 2 points.
    let now = server;
    if (tiebreak) {
      const n = points.a + points.b;
      now = Math.floor((n + 1) / 2) % 2 === 0 ? tiebreak.first : other(tiebreak.first);
    }
    return { sets, setsWon, winner, server: now, points, tiebreak, lastSetTotal, gamesBy };
  }

  function compute(rallies = '', cfg, firstServer = 'a', normalizeConfig) {
    const c = normalizeConfig(cfg);
    const s = run(rallies, c, firstServer);
    const gamePoint = { a: false, b: false };
    const matchPoint = { a: false, b: false };
    let note = null;
    let display = null;
    if (!s.winner) {
      // One point ahead: does it win the set, or the match?
      for (const side of ['a', 'b']) {
        const next = run(rallies + side, c, firstServer);
        matchPoint[side] = Boolean(next.winner);
        gamePoint[side] = next.setsWon[side] > s.setsWon[side];
      }
      const { a, b } = s.points;
      const notes = [];
      if (s.tiebreak) {
        display = { a: String(a), b: String(b) };
        notes.push(s.tiebreak.target === 10 ? 'match tie-break' : 'tie-break');
        if (a + b > 0 && (a + b) % 6 === 0) notes.push('change ends');
      } else {
        if (a >= 3 && b >= 3) {
          if (c.scoring === 'golden' && a === 3 && b === 3) {
            display = { a: '40', b: '40' };
            notes.push('golden point');
          } else if (a === b) {
            display = { a: '40', b: '40' };
            notes.push('deuce');
          } else {
            display = a > b ? { a: 'AD', b: '40' } : { a: '40', b: 'AD' };
          }
        } else {
          display = { a: CALL[a], b: CALL[b] };
        }
        // The receiver wins the game on the next point.
        const recv = other(s.server);
        const next = run(rallies + recv, c, firstServer);
        const brk = next.gamesBy[recv] > s.gamesBy[recv];
        if (brk && !gamePoint[recv]) notes.push('break point');
        const setGames = s.sets[s.sets.length - 1];
        if (a + b === 0 && ((setGames.a + setGames.b) % 2 === 1 || (setGames.a + setGames.b === 0 && s.lastSetTotal % 2 === 1))) {
          notes.push('change ends');
        }
      }
      note = notes.join(' · ') || null;
    }
    return {
      games: s.sets,
      gamesWon: s.setsWon,
      winner: s.winner,
      unit: 'Set',
      server: s.winner ? null : s.server,
      // The serve goes to the right (deuce) court when the points so far are even.
      serveCourt: s.winner ? null : (s.points.a + s.points.b) % 2 === 0 ? 'right' : 'left',
      points: display, // the call for each side: "15", "40", "AD", or tie-break points
      setGames: s.winner ? null : { a: s.sets[s.sets.length - 1].a, b: s.sets[s.sets.length - 1].b },
      tap: { a: 'Point', b: 'Point' }, // the umpire's buttons ("+1" reads oddly at 15-30-40)
      note,
      gamePoint,
      matchPoint,
      // Standings break ties on games won.
      totals: { ...s.gamesBy },
    };
  }

  // "6-4, 6-7(5), [10-8]": tie-break losers' points in brackets.
  function summary(score) {
    return score.games
      .filter((g) => g.a + g.b > 0 || g.tb)
      .map((g) => {
        if (g.super) return `[${g.tb.a}-${g.tb.b}]`;
        if (g.tb) return `${g.a}-${g.b}(${Math.min(g.tb.a, g.tb.b)})`;
        return `${g.a}-${g.b}`;
      })
      .join(', ');
  }

  // spec: { id, name, defaults }
  function racketSport(spec) {
    const D = Object.freeze(spec.defaults);
    const normalizeConfig = (cfg = {}) => {
      cfg = cfg || {};
      const bestOf = oneOf(cfg.bestOf, [1, 3, 5], D.bestOf);
      return {
        bestOf,
        games: oneOf(cfg.games, [4, 6, 8], D.games),
        scoring: cfg.scoring === 'golden' || cfg.scoring === 'ad' ? cfg.scoring : D.scoring,
        finalSet: bestOf > 1 && (cfg.finalSet ?? D.finalSet) === 'super' ? 'super' : 'set',
      };
    };
    return {
      id: spec.id,
      name: spec.name,
      defaults: D,
      fields: [
        {
          key: 'bestOf',
          label: 'Match length',
          type: 'select',
          options: [{ value: 1, label: 'One set' }, { value: 3, label: 'Best of 3 sets' }, { value: 5, label: 'Best of 5 sets' }],
        },
        {
          key: 'games',
          label: 'Games per set',
          type: 'select',
          options: [{ value: 6, label: '6 (standard)' }, { value: 4, label: '4 (short sets)' }, { value: 8, label: '8 (pro set)' }],
          hint: 'Tie-break at 6-6 (4-4, 8-8).',
        },
        {
          key: 'scoring',
          label: 'At deuce',
          type: 'select',
          options: [{ value: 'ad', label: 'Advantage' }, { value: 'golden', label: 'Golden point (next point wins)' }],
        },
        {
          key: 'finalSet',
          label: 'Final set',
          type: 'select',
          options: [{ value: 'set', label: 'Full set' }, { value: 'super', label: 'Match tie-break to 10' }],
        },
      ],
      normalizeConfig,
      compute: (rallies = '', cfg, firstServer = 'a') => compute(rallies, cfg, firstServer, normalizeConfig),
      summary,
    };
  }

  return { racketSport, summary };
});
