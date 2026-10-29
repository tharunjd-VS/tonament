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
  // singles or pairs, partner optional. 'team' entries are team names.
  const DISCIPLINES = ['singles', 'doubles', 'team', 'any'];
  const GENDERS = ['men', 'women', 'mixed', 'open'];
  const LEVELS = ['Open', 'Beginner', 'Intermediate', 'Advanced'];
  const AGES = ['Open', 'U11', 'U13', 'U15', 'U17', 'U19', '35+', '45+', '55+'];
  // Sports whose players use other levels and age groups (pickleball: skill ratings).
  // disciplines: the event types a sport offers ('any' = the singles-or-pairs catch-all).
  const TEAM = { disciplines: ['team'] };
  const SPORT_LISTS = {
    badminton: { levels: ['Open', 'Beginner', 'Beginner+', 'Intermediate', 'Advanced'] },
    volleyball: TEAM,
    throwball: TEAM,
    'sepak-takraw': TEAM,
    'beach-volleyball': { disciplines: ['doubles'] },
    padel: { disciplines: ['doubles'] },
    snooker: { disciplines: ['singles', 'doubles'] },
    pool: { disciplines: ['singles', 'doubles'] },
    carrom: { disciplines: ['singles', 'doubles'] },
    football: TEAM,
    futsal: TEAM,
    hockey: TEAM,
    kabaddi: TEAM,
    basketball: TEAM,
    pickleball: {
      levels: ['Open', 'Beginner', 'Intermediate', 'Advanced', '3.0', '3.5', '4.0', '4.5', '5.0+'],
      ages: ['Open', 'U19', '35+', '50+', '60+', '65+', '70+'],
    },
  };
  const uniq = (xs) => [...new Set(xs)];
  // The suggestions for a sport; every sport's when none is given (search).
  const levelsFor = (sport) => (sport ? (SPORT_LISTS[sport] || {}).levels || LEVELS : uniq([...LEVELS, ...Object.values(SPORT_LISTS).flatMap((l) => l.levels || [])]));
  const agesFor = (sport) => (sport ? (SPORT_LISTS[sport] || {}).ages || AGES : uniq([...AGES, ...Object.values(SPORT_LISTS).flatMap((l) => l.ages || [])]));
  // Racket sports also have team events, played as ties (singles and doubles
  // matches between two teams; tie.js).
  const disciplinesFor = (sport) => (sport && (SPORT_LISTS[sport] || {}).disciplines) || ['singles', 'doubles', 'team', 'any'];
  // A sport played only by teams (football, volleyball, …).
  const isTeamSport = (sport) => { const d = disciplinesFor(sport); return d.length === 1 && d[0] === 'team'; };
  // Team events here are ties of singles and doubles matches.
  const hasTies = (sport) => Boolean(sport) && disciplinesFor(sport).includes('team') && !isTeamSport(sport);
  // The levels a player can be (lowest first) — an event's levels without 'Open'.
  const entryLevels = (sport) => levelsFor(sport).filter((l) => l !== 'Open');
  // The quick-add choices for a sport; all of them when none is given (search).
  const presetsFor = (sport) => (sport ? PRESETS.filter((p) => disciplinesFor(sport).includes(p.discipline)) : PRESETS);

  // The quick-add choices on the create form.
  const PRESETS = [
    { key: 'MS', discipline: 'singles', gender: 'men', label: 'Men\'s Singles' },
    { key: 'WS', discipline: 'singles', gender: 'women', label: 'Women\'s Singles' },
    { key: 'MD', discipline: 'doubles', gender: 'men', label: 'Men\'s Doubles' },
    { key: 'WD', discipline: 'doubles', gender: 'women', label: 'Women\'s Doubles' },
    { key: 'XD', discipline: 'doubles', gender: 'mixed', label: 'Mixed Doubles' },
    { key: 'OS', discipline: 'singles', gender: 'open', label: 'Open Singles' },
    { key: 'OD', discipline: 'doubles', gender: 'open', label: 'Open Doubles' },
    { key: 'MT', discipline: 'team', gender: 'men', label: 'Men\'s Team' },
    { key: 'WT', discipline: 'team', gender: 'women', label: 'Women\'s Team' },
    { key: 'XT', discipline: 'team', gender: 'mixed', label: 'Mixed Team' },
    { key: 'OT', discipline: 'team', gender: 'open', label: 'Open Team' },
  ];

  // Prize places (custom text is allowed too) and what an entry includes.
  const PLACES = { winner: 'Winner', runner_up: 'Runner-up', semis: 'Semi-finalists', third: 'Third place', fourth: 'Fourth place' };
  const PERKS = {
    shuttles: 'Shuttles provided',
    water: 'Drinking water / water bottle',
    snacks: 'Snacks / refreshments',
    breakfast: 'Breakfast',
    lunch: 'Lunch',
    dinner: 'Dinner',
    tshirt: 'Event T-shirt / jersey',
    medal: 'Medal for every player',
    certificate: 'Participation certificate',
    goodies: 'Kit bag / goodies',
    parking: 'Parking',
    firstaid: 'First aid / physio on site',
  };
  const placeLabel = (place) => PLACES[place] || place;
  const perkLabel = (key, sport) => (key === 'shuttles' && sport && sport !== 'badminton' ? (sport === 'carrom' ? 'Boards, coins and strikers provided' : 'Balls provided') : PERKS[key]);

  const GENDER_WORD = { men: 'Men\'s', women: 'Women\'s', mixed: 'Mixed', open: 'Open' };
  const DISCIPLINE_WORD = { singles: 'Singles', doubles: 'Doubles', team: 'Team' };
  const SHORT_LEVEL = { Beginner: 'Beg', 'Beginner+': 'Beg+', Intermediate: 'Int', Advanced: 'Adv' };

  const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

  // Checks and tidies { discipline, gender, age, level, name }. Throws an
  // Error with a readable message when something is wrong.
  // With a sport, only that sport's event types are allowed.
  function normalize(input = {}, prev = {}, sport) {
    const pick = (k, fallback) => (input[k] === undefined ? prev[k] ?? fallback : input[k]);
    const allowed = disciplinesFor(sport);
    const discipline = pick('discipline', allowed.includes('any') ? 'any' : allowed[0]);
    const gender = pick('gender', 'open');
    if (!DISCIPLINES.includes(discipline)) throw new Error('Choose singles, doubles or team');
    if (sport && !allowed.includes(discipline)) {
      throw new Error(allowed.length === 1 ? `This sport has ${DISCIPLINE_WORD[allowed[0]].toLowerCase()} events only` : 'This sport has no team events');
    }
    if (!GENDERS.includes(gender)) throw new Error('Choose men, women, mixed or open');
    if (gender === 'mixed' && discipline !== 'doubles' && discipline !== 'team') {
      throw new Error(allowed.includes('team') ? 'Mixed events are doubles or teams only' : 'Mixed events are doubles only');
    }
    const text = (k, label) => {
      const v = clean(pick(k, 'Open')) || 'Open';
      if (v.length > 30) throw new Error(`${label} must be at most 30 characters`);
      const standard = (k === 'age' ? agesFor() : levelsFor()).find((x) => x.toLowerCase() === v.toLowerCase());
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

  // What a playing area is called: table tennis is played on tables, football on pitches.
  const courtWord = (sport) => (['table-tennis', 'snooker', 'pool'].includes(sport) ? 'Table' : sport === 'carrom' ? 'Board' : ['football', 'hockey'].includes(sport) ? 'Pitch' : 'Court');

  // "Courts", "Tables", "Boards", "Pitches".
  const courtWords = (sport) => { const w = courtWord(sport); return /(ch|sh|s)$/.test(w) ? `${w}es` : `${w}s`; };

  return { DISCIPLINES, GENDERS, LEVELS, AGES, levelsFor, agesFor, disciplinesFor, isTeamSport, hasTies, entryLevels, presetsFor, PRESETS, PLACES, PERKS, placeLabel, perkLabel, normalize, eventName, shortName, courtWord, courtWords };
});
