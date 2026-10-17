// Event categories (Men's Singles, Mixed Doubles · U19, …), shared by the
// server (require) and the browser (<script>, as window.TonamentEvents) so
// names and validation match everywhere.

(function (root, factory) {
  const events = factory();
  if (typeof module === 'object' && module.exports) module.exports = events;
  else root.TonamentEvents = events;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // 'any' is the catch-all used by tournaments made before events existed:
  // singles or pairs, partner optional.
  const DISCIPLINES = ['singles', 'doubles', 'any'];
  const GENDERS = ['men', 'women', 'mixed', 'open'];
  const LEVELS = ['Open', 'Beginner', 'Intermediate', 'Advanced'];
  const AGES = ['Open', 'U11', 'U13', 'U15', 'U17', 'U19', '35+', '45+', '55+'];

  // The quick-add choices on the create form.
  const PRESETS = [
    { key: 'MS', discipline: 'singles', gender: 'men', label: 'Men\'s Singles' },
    { key: 'WS', discipline: 'singles', gender: 'women', label: 'Women\'s Singles' },
    { key: 'MD', discipline: 'doubles', gender: 'men', label: 'Men\'s Doubles' },
    { key: 'WD', discipline: 'doubles', gender: 'women', label: 'Women\'s Doubles' },
    { key: 'XD', discipline: 'doubles', gender: 'mixed', label: 'Mixed Doubles' },
    { key: 'OS', discipline: 'singles', gender: 'open', label: 'Open Singles' },
    { key: 'OD', discipline: 'doubles', gender: 'open', label: 'Open Doubles' },
  ];

  const GENDER_WORD = { men: 'Men\'s', women: 'Women\'s', mixed: 'Mixed', open: 'Open' };
  const DISCIPLINE_WORD = { singles: 'Singles', doubles: 'Doubles' };
  const SHORT_LEVEL = { Beginner: 'Beg', Intermediate: 'Int', Advanced: 'Adv' };

  const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

  // Checks and tidies { discipline, gender, age, level, name }. Throws an
  // Error with a readable message when something is wrong.
  function normalize(input = {}, prev = {}) {
    const pick = (k, fallback) => (input[k] === undefined ? prev[k] ?? fallback : input[k]);
    const discipline = pick('discipline', 'any');
    const gender = pick('gender', 'open');
    if (!DISCIPLINES.includes(discipline)) throw new Error('Choose singles or doubles');
    if (!GENDERS.includes(gender)) throw new Error('Choose men, women, mixed or open');
    if (gender === 'mixed' && discipline !== 'doubles') throw new Error('Mixed events are doubles only');
    const text = (k, label) => {
      const v = clean(pick(k, 'Open')) || 'Open';
      if (v.length > 30) throw new Error(`${label} must be at most 30 characters`);
      const standard = (k === 'age' ? AGES : LEVELS).find((x) => x.toLowerCase() === v.toLowerCase());
      return standard || v;
    };
    const name = input.name === undefined ? prev.name ?? null : clean(input.name) || null;
    if (name && name.length > 60) throw new Error('Event name must be at most 60 characters');
    return { discipline, gender, age: text('age', 'Age group'), level: text('level', 'Level'), name };
  }

  function baseName(e) {
    if (e.discipline === 'any') return e.gender === 'open' ? 'Open' : GENDER_WORD[e.gender];
    return `${GENDER_WORD[e.gender]} ${DISCIPLINE_WORD[e.discipline]}`;
  }

  // "Men's Doubles · U19 · Intermediate"; "Open Singles" when all Open.
  function eventName(e) {
    if (e.name) return e.name;
    return [baseName(e), e.age !== 'Open' ? e.age : null, e.level !== 'Open' ? e.level : null].filter(Boolean).join(' · ');
  }

  // "XD U19 Int" for compact chips.
  function shortName(e) {
    const preset = PRESETS.find((p) => p.discipline === e.discipline && p.gender === e.gender);
    const base = preset ? preset.key : e.name ? e.name.slice(0, 12) : 'Open';
    const level = e.level !== 'Open' ? SHORT_LEVEL[e.level] || e.level.slice(0, 6) : null;
    return [base, e.age !== 'Open' ? e.age : null, level].filter(Boolean).join(' ');
  }

  return { DISCIPLINES, GENDERS, LEVELS, AGES, PRESETS, normalize, eventName, shortName };
});
