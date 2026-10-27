// Timed team sports (football, futsal, hockey, kabaddi, basketball): no
// target score — teams score goals or points through halves or quarters,
// and the scorer ends each period when the whistle goes ('x' tap).
//
// After the last period: the leader wins. Level: a league match is a draw
// (when the sport allows draws); otherwise extra time, overtime or a
// shoot-out decides it, as the sport says. Shared by the server (require)
// and the browser (window.TonamentTimed). Needs rally.js.

(function (root, factory) {
  const timed = typeof module === 'object' && module.exports ? factory(require('./rally')) : factory(root.TonamentRally);
  if (typeof module === 'object' && module.exports) module.exports = timed;
  else root.TonamentTimed = timed;
})(typeof self !== 'undefined' ? self : this, (R) => {
  'use strict';

  const ORD = ['1st', '2nd', '3rd', '4th'];

  // spec: {
  //   id, name,
  //   unit: 'Goal' | 'Point',          what a tap scores
  //   values: [1] | [1, 2, 3] | …,    what one tap can be worth
  //   periods: [2] | [4, 2],          the choices (first is the default)
  //   tie: { key: 'penalties', … } choices for a level knockout match:
  //        penalties | extra (extra time, then penalties) | shootout | raids | overtime
  //   draws: true,                    league matches can be drawn
  //   leaguePoints: { win, draw },
  //   firstLabel, hint,
  // }
  function timedSport(spec) {
    const TIES = {
      penalties: { label: 'Penalties', name: 'Penalties', short: 'pens' },
      extra: { label: 'Extra time, then penalties', name: 'Penalties', short: 'pens', extra: true },
      shootout: { label: 'Shoot-out', name: 'Shoot-out', short: 'shoot-out' },
      raids: { label: 'Tie-break raids (5 each)', name: 'Tie-break raids', short: 'tie-break' },
      overtime: { label: 'Overtime until there\'s a winner', overtime: true },
    };
    const D = Object.freeze({ periods: spec.periods[0], tie: spec.ties[0] });
    const normalizeConfig = (cfg = {}) => {
      cfg = cfg || {};
      return {
        periods: spec.periods.includes(Number(cfg.periods)) ? Number(cfg.periods) : D.periods,
        tie: spec.ties.includes(cfg.tie) ? cfg.tie : D.tie,
      };
    };
    const periodWord = (n) => (n === 2 ? 'half' : 'quarter');
    const unit = spec.unit;
    const lower = unit.toLowerCase();
    const max = Math.max(...spec.values);

    // cfg.draws (from the league rules): this match may end level.
    function compute(rallies = '', cfg) {
      const c = normalizeConfig(cfg);
      const draws = Boolean(cfg && cfg.draws) && spec.draws !== false;
      const tie = TIES[c.tie];
      const goals = { a: 0, b: 0 };
      const shoot = { a: 0, b: 0 };
      // phase: regular | extra | overtime | shootout | over
      let phase = 'regular';
      let period = 0; // periods finished in this phase
      let overtimes = 0;
      let winner = null;
      let draw = false;
      let decidedBy = null; // 'shootout' | 'extra' | 'overtime'
      const fullTime = () => {
        if (goals.a !== goals.b) { winner = goals.a > goals.b ? 'a' : 'b'; phase = 'over'; return; }
        if (draws) { draw = true; phase = 'over'; return; }
        if (tie.overtime) { phase = 'overtime'; period = 0; return; }
        if (tie.extra && phase === 'regular') { phase = 'extra'; period = 0; return; }
        phase = 'shootout';
      };
      for (const ch of rallies || '') {
        if (phase === 'over') break;
        const t = R.readTap(ch);
        if (!t) continue;
        if (t.end) {
          if (phase === 'shootout') {
            if (shoot.a !== shoot.b) { winner = shoot.a > shoot.b ? 'a' : 'b'; decidedBy = 'shootout'; phase = 'over'; }
            continue;
          }
          period += 1;
          if (phase === 'regular' && period >= c.periods) fullTime();
          else if (phase === 'extra' && period >= 2) {
            if (goals.a !== goals.b) { winner = goals.a > goals.b ? 'a' : 'b'; decidedBy = 'extra'; phase = 'over'; } else phase = 'shootout';
          } else if (phase === 'overtime') {
            overtimes += 1;
            if (goals.a !== goals.b) { winner = goals.a > goals.b ? 'a' : 'b'; decidedBy = 'overtime'; phase = 'over'; } else period = 0;
          }
          continue;
        }
        if (t.foul) continue;
        if (phase === 'shootout') shoot[t.side] += t.n;
        else goals[t.side] += t.n;
      }

      // Where the match is, and what the "end" button does now.
      let now = null;
      let endLabel = null;
      if (phase === 'regular') {
        now = `${ORD[period]} ${periodWord(c.periods)}`;
        endLabel = period + 1 >= c.periods ? 'Full time' : `End ${ORD[period]} ${periodWord(c.periods)}`;
      } else if (phase === 'extra') {
        now = `Extra time · ${ORD[period]} half`;
        endLabel = period === 0 ? 'End 1st half of extra time' : 'End extra time';
      } else if (phase === 'overtime') {
        now = `Overtime${overtimes ? ` ${overtimes + 1}` : ''}`;
        endLabel = 'End overtime';
      } else if (phase === 'shootout') {
        now = `${tie.name} ${shoot.a}–${shoot.b}`;
        endLabel = `End ${tie.name.toLowerCase()}`;
      }
      const level = goals.a === goals.b;
      return {
        games: [{ a: goals.a, b: goals.b, winner }],
        // Not "games won": standings go straight to goal (point) difference.
        gamesWon: { a: 0, b: 0 },
        winner,
        draw,
        server: null,
        serveCourt: null,
        unit,
        single: true,
        timed: true,
        drawsAllowed: draws,
        tieName: tie.name || null,
        tieShort: tie.short || null,
        phase,
        shootout: phase === 'shootout' || decidedBy === 'shootout' ? { ...shoot } : null,
        decidedBy,
        tap: spec.values.length === 1 ? { a: phase === 'shootout' ? 'Scored' : unit, b: phase === 'shootout' ? 'Scored' : unit } : null,
        // What the scorer can tap now: a goal (or 1–3 points), and the end of the period.
        taps: phase === 'over' ? { max, values: spec.values, end: false } : {
          max: phase === 'shootout' ? 1 : max,
          values: phase === 'shootout' ? [1] : spec.values,
          end: phase !== 'shootout' || shoot.a !== shoot.b,
          endLabel,
          endConfirm: endLabel === 'Full time' && level && !draws ? `Level at full time: ${tie.overtime ? 'overtime' : tie.extra ? 'extra time' : (tie.name || '').toLowerCase()} next.` : null,
        },
        hint: phase === 'shootout'
          ? `${tie.name}: tap the team each time one scores. End when it's decided.`
          : `Tap the team that scores${spec.values.length > 1 ? ' and how many' : ''}. End each ${periodWord(c.periods)} when the whistle goes.`,
        firstLabel: spec.firstLabel || 'Kick-off',
        note: phase === 'over' ? null : now,
        gamePoint: { a: false, b: false },
        matchPoint: { a: false, b: false },
        totals: { a: goals.a, b: goals.b },
      };
    }

    // "3-2", "2-2 (4-3 pens)", "88-84 (OT)", "1-0 (aet)".
    function summary(score) {
      const g = score.games[0];
      if (!score.winner && !score.draw && g.a + g.b === 0) return '';
      let s = `${g.a}-${g.b}`;
      if (score.decidedBy === 'shootout' && score.shootout) s += ` (${score.shootout.a}-${score.shootout.b} ${score.tieShort || 'pens'})`;
      else if (score.decidedBy === 'overtime') s += ' (OT)';
      else if (score.decidedBy === 'extra') s += ' (aet)';
      return s;
    }

    const fields = [];
    if (spec.periods.length > 1) {
      fields.push({ key: 'periods', label: 'Match', type: 'select', options: spec.periods.map((n) => ({ value: n, label: n === 4 ? '4 quarters' : '2 halves' })) });
    }
    if (spec.ties.length > 1) {
      fields.push({ key: 'tie', label: 'Level in a knockout', type: 'select', options: spec.ties.map((k) => ({ value: k, label: TIES[k].label })) });
    }

    return {
      id: spec.id,
      name: spec.name,
      timed: true,
      draws: spec.draws !== false,
      leaguePoints: spec.leaguePoints,
      defaults: D,
      fields,
      normalizeConfig,
      compute,
      summary,
    };
  }

  return { timedSport };
});
