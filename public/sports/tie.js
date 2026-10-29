// Team ties for racket sports: two teams play a set of matches ("rubbers" —
// singles and doubles) and the team that wins more of them wins the tie.
// Shared by the server (require) and the browser (window.TonamentTie).
//
// A tie is scored like any match: its "rallies" are the rubbers' winners in
// the order they finished ("aab" = side a won two, b one), so the draw,
// standings, knockout and order of play work on ties unchanged. Each rubber
// is scored with the sport's own rules (server/service.js, rubbers table).

(function (root, factory) {
  const tie = factory();
  if (typeof module === 'object' && module.exports) module.exports = tie;
  else root.TonamentTie = tie;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const S = (label) => ({ label, kind: 'singles' });
  const D = (label) => ({ label, kind: 'doubles' });

  // The common formats; "custom" takes any odd list of singles and doubles.
  const FORMATS = {
    '2s1d': { name: '2 singles + 1 doubles', hint: 'Best of 3 — club and corporate ties', rubbers: [S('S1'), S('S2'), D('D')] },
    '3s2d': { name: '3 singles + 2 doubles', hint: 'Best of 5 — Thomas & Uber Cup style', rubbers: [S('S1'), D('D1'), S('S2'), D('D2'), S('S3')] },
    sudirman: { name: 'Mixed team: MS, WS, MD, WD, XD', hint: 'Best of 5 — Sudirman Cup style', rubbers: [S('MS'), S('WS'), D('MD'), D('WD'), D('XD')] },
    '4s1d': { name: '4 singles + 1 doubles', hint: 'Best of 5 — Davis Cup / Corbillon style', rubbers: [S('S1'), S('S2'), D('D'), S('S3'), S('S4')] },
    '5s': { name: '5 singles', hint: 'Best of 5 — Swaythling style', rubbers: [S('S1'), S('S2'), S('S3'), S('S4'), S('S5')] },
    '3d': { name: '3 doubles', hint: 'Best of 3 — pickleball and padel leagues', rubbers: [D('D1'), D('D2'), D('D3')] },
    '1s2d': { name: '1 singles + 2 doubles', hint: 'Best of 3', rubbers: [D('D1'), S('S'), D('D2')] },
  };

  // { format, rubbers?, playAll } -> the rubbers, checked (an odd number, 1–9).
  function rubbersOf(tie = {}) {
    if (tie.format && tie.format !== 'custom' && FORMATS[tie.format]) return FORMATS[tie.format].rubbers;
    const kinds = Array.isArray(tie.rubbers) ? tie.rubbers : [];
    let s = 0;
    let d = 0;
    return kinds.map((k) => (k === 'doubles' || (k && k.kind === 'doubles') ? D(`D${++d}`) : S(`S${++s}`)));
  }
  function normalize(tie = {}) {
    const format = tie.format === 'custom' || FORMATS[tie.format] ? tie.format : '2s1d';
    const rubbers = rubbersOf({ ...tie, format });
    if (format === 'custom' && (rubbers.length < 1 || rubbers.length > 9 || rubbers.length % 2 === 0)) {
      throw new Error('A tie needs an odd number of matches (1 to 9), so it can\'t end level');
    }
    return { format, ...(format === 'custom' && { rubbers: rubbers.map((r) => r.kind) }), playAll: Boolean(tie.playAll) };
  }
  const formatName = (tie = {}) => (FORMATS[tie.format] ? FORMATS[tie.format].name : `${rubbersOf(tie).length} matches`);

  // The tie's score from its rubbers' winners ("aba").
  function compute(rallies, tie) {
    const rubbers = rubbersOf(tie);
    const n = rubbers.length;
    const need = Math.floor(n / 2) + 1;
    const won = { a: 0, b: 0 };
    for (const ch of String(rallies || '')) if (ch === 'a' || ch === 'b') won[ch] += 1;
    // Stop when it's decided, or (playAll) when every match is played.
    let winner = null;
    if (tie.playAll) {
      if (won.a + won.b >= n) winner = won.a > won.b ? 'a' : 'b';
    } else if (won.a >= need) winner = 'a';
    else if (won.b >= need) winner = 'b';
    return {
      games: [{ a: won.a, b: won.b, winner }],
      gamesWon: { a: won.a, b: won.b },
      totals: { a: won.a, b: won.b },
      winner,
      single: true,
      unit: 'Match',
      tie: { rubbers: n, need, played: won.a + won.b },
      server: null,
      taps: { max: 0 },
    };
  }

  // A tie "sport" for an event: the base sport's name and rules for each
  // rubber, the tie's score from rubbers.
  function tieSport(base, tie) {
    const t = normalize(tie);
    return {
      ...base,
      tieOf: base,
      tie: t,
      defaults: base.defaults,
      fields: base.fields,
      normalizeConfig: base.normalizeConfig,
      compute: (rallies) => compute(rallies, t),
      summary: (score) => (score ? `${score.gamesWon.a}–${score.gamesWon.b}` : ''),
      // Ties are won outright, never drawn.
      timed: false,
      draws: false,
      leaguePoints: undefined,
    };
  }

  return { FORMATS, rubbersOf, normalize, formatName, compute, tieSport };
});
