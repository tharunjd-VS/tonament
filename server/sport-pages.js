'use strict';

// Copy for the sport landing pages (/badminton, /pickleball, …). Each sport
// gets its own words so no two pages read alike: what the scoring screen
// knows, the usual formats, and the questions organisers actually ask.
// Every live sport needs an entry (a test checks).

const SPORTS = {
  badminton: {
    title: 'Badminton Tournament App — Entries, Draws & Live Scoring',
    description: 'Run your badminton tournament on Tonament: online entries, singles and doubles draws, court scheduling and rally-by-rally live scores. Free for up to 16 entries.',
    lead: 'From the club night to the district open: take entries online, make the groups and the knockout in one tap, call matches to courts and score every rally live on the umpire\'s phone.',
    rules: [
      'Rally scoring to 21, setting to 30 (or your own points and cap)',
      'Best of 3 games, best of 5, or a single game for big draws',
      'The server and service court called for the umpire, game and match point flagged',
      'League matches of exactly 2 games, with draws, if your league plays that way',
    ],
    formats: 'Groups of four feeding a knockout is the club favourite: everyone gets three matches and the top two go through. Use a straight knockout for a big open, or a league for a ladder night.',
    faqs: [
      ['Does Tonament know badminton scoring?', 'Yes. Umpires tap the side that won each rally; Tonament keeps the score to 21 (or your setting), handles setting to 30, calls who serves from which court, and flags game and match point.'],
      ['Can I run singles, doubles and mixed in one tournament?', 'Yes. Add Men\'s and Women\'s Singles, Doubles, Mixed Doubles and age groups like U15 or 35+ — each event gets its own entries and draw.'],
      ['Our league plays 2 games a match. Can it have draws?', 'Yes. Choose "2 games — draws allowed" for league matches: 1-1 is a draw, and the group table ranks on points (win 2, draw 1, loss 0). The knockout stays best of 3.'],
      ['How do players without a partner enter doubles?', 'They tick "find me a partner" and you pair them before the draw — or choose drawn partners for everyone for a social doubles night.'],
    ],
  },
  pickleball: {
    title: 'Pickleball Tournament App — Side-out Scoring, Draws & Live Scores',
    description: 'Run a pickleball tournament with side-out or rally scoring, the three-number score call, skill-level divisions, online entries and live scores. Free for up to 16 entries.',
    lead: 'Pickleball scoring trips up new umpires. Tonament does it for them: side-out or rally scoring, the right server and the score call on screen — while you run the draws and courts.',
    rules: [
      'Side-out scoring (only the serving team scores) or rally scoring',
      'The three-number call in doubles — "0-0-2" to start — shown on every point',
      'Games to 11, win by 2 (15 or 21 for single games), best of 3 or 5',
      'Skill divisions such as 3.0, 3.5, 4.0 and 4.5+, plus age groups like 50+ and 60+',
    ],
    formats: 'Round-robin pools into a medal bracket suit most pickleball events; for a quick social, run a single pool where every pair plays every other.',
    faqs: [
      ['Does it support side-out scoring?', 'Yes — side-out is the default, with rally scoring as an option per event. In doubles the score call (serving team, receiving team, server number) is shown on every point.'],
      ['Can I make divisions by skill rating?', 'Yes. Events can have levels like 3.0, 3.5, 4.0 and 4.5, and age groups like 50+ — Men\'s Doubles 4.0 and Mixed Doubles 50+ can run side by side.'],
      ['How do players enter?', 'Share your tournament link. Players sign in, pick their division, add their partner (or ask to be paired) and, if there\'s a fee, pay you directly by UPI.'],
    ],
  },
  'table-tennis': {
    title: 'Table Tennis Tournament App — Draws, Tables & Live Scoring',
    description: 'Run a table tennis tournament: online entries, groups and knockouts, table scheduling and ITTF scoring with service changes every 2 points. Free for up to 16 entries.',
    lead: 'Run every table at once: groups and knockouts drawn in a tap, matches called to free tables, and scores to 11 kept on the umpire\'s phone with the service changes worked out.',
    rules: [
      'Games to 11, win by 2 — or 21 for old-style events',
      'Service changes every 2 points, and every point from 10-10',
      'Best of 5 or 7 for the main draw, best of 3 to speed up groups',
      'Players in two events are never called to two tables at once',
    ],
    formats: 'Groups of three or four with the top two into a knockout is the standard; for juniors, a straight league per age group keeps everyone playing.',
    faqs: [
      ['Does it handle table tennis service rules?', 'Yes. The scoring screen shows who serves, changing every 2 points and every point at deuce, and swaps the first server each game.'],
      ['Can I schedule by table?', 'Yes. Add your tables and Tonament keeps one order of play across every event — call the next match to a free table in one tap, or let it call matches automatically.'],
      ['Can I run age-group events like U13 and U15?', 'Yes. Add as many events as you need — each with its own entries, draw and results.'],
    ],
  },
  squash: {
    title: 'Squash Tournament App — Draws, Courts & PAR Scoring',
    description: 'Run a squash tournament with point-a-rally scoring to 11, best of 5, online entries, draws, court scheduling and live scores. Free for up to 16 entries.',
    lead: 'Squash events run on few courts and tight timings. Tonament keeps the order of play moving, scores every rally live and posts results the moment a match ends.',
    rules: [
      'Point-a-rally (PAR) scoring to 11, win by 2 — or 15',
      'Best of 5 games, or best of 3 to fit more matches in',
      'The rally winner serves; the game winner serves first in the next',
      'An order of play across your courts, with estimated start times',
    ],
    formats: 'Box leagues and groups into a knockout both work; with two or three courts, groups keep everyone playing while estimated times tell players when to warm up.',
    faqs: [
      ['Does it use PAR scoring?', 'Yes — point-a-rally to 11, win by 2, with 15 as an option. Choose best of 3 or best of 5.'],
      ['We only have three courts. Will the schedule work?', 'Yes. Tonament calls matches to free courts in order, shows each player roughly when they\'re on, and never calls someone who\'s still playing.'],
      ['Can players see their results?', 'Yes. Every point appears live on the tournament page, and group tables and the bracket update themselves.'],
    ],
  },
  tennis: {
    title: 'Tennis Tournament App — Draws, Tie-breaks & Live Scoring',
    description: 'Run a tennis tournament with 15-30-40 scoring, deuce or golden point, tie-breaks and match tie-breaks, online entries, draws and live scores. Free for up to 16 entries.',
    lead: 'Club championships, junior events or a weekend doubles open: Tonament scores tennis properly — deuce, advantage, tie-breaks — while you manage entries, draws and courts.',
    rules: [
      '15-30-40 with advantage, or golden point at deuce',
      'Sets to 6 with a tie-break at 6-6 — or short sets to 4, or an 8-game pro set',
      'Best of 3 sets, with a match tie-break to 10 instead of the final set if you like',
      'Break point, set point and change of ends flagged for the umpire',
    ],
    formats: 'A seeded knockout is the classic; for club events with limited time, try groups into a knockout with short sets or a pro set.',
    faqs: [
      ['Does it handle tie-breaks?', 'Yes — a tie-break at 6-6 (or 4-4, 8-8), with the right server order, and an optional match tie-break to 10 in place of the final set.'],
      ['Can I use no-ad scoring?', 'Yes. Choose golden point at deuce: the next point wins the game.'],
      ['Can I run a pro set or short sets?', 'Yes — 8-game pro sets and 4-game short sets are built in, which helps fit a big draw into one day.'],
    ],
  },
  padel: {
    title: 'Padel Tournament App — Doubles Draws, Golden Point & Live Scoring',
    description: 'Run a padel tournament: doubles entries, golden point or advantage, tie-breaks, groups and knockouts, court scheduling and live scores. Free for up to 16 entries.',
    lead: 'Padel is doubles, fast and social. Take pair entries in minutes, draw groups into a knockout, and keep score with golden point and tie-breaks built in.',
    rules: [
      'Doubles events only — Men\'s, Women\'s, Mixed and Open',
      'Advantage or golden point at deuce',
      'Sets to 6 with a tie-break, short sets or a pro set, and an optional super tie-break',
      'Players without a partner can ask to be paired',
    ],
    formats: 'Groups of four pairs into a knockout keeps a padel day lively; for a social, draw the partners for everyone.',
    faqs: [
      ['Is padel doubles only on Tonament?', 'Yes — padel events are for pairs. Players add their partner when they enter, or ask to be paired.'],
      ['Can I use golden point?', 'Yes. Choose golden point at deuce, and optionally a super tie-break to 10 instead of the final set.'],
      ['Can partners be drawn at random?', 'Yes. Choose "partners are drawn" for a social event — everyone enters alone and pairs are drawn at the start, balanced by seeding if you like.'],
    ],
  },
  volleyball: {
    title: 'Volleyball Tournament App — Team Entries, Pools & Live Scoring',
    description: 'Run a volleyball tournament: team entries with rosters, pools into playoffs, sets to 25 with a deciding set to 15, court scheduling and live scores. Free for up to 16 teams.',
    lead: 'From school championships to corporate leagues: teams enter online with their roster, pools and playoffs are drawn in a tap, and every rally is scored live.',
    rules: [
      'Sets to 25 (or 21, 15), win by 2',
      'Best of 3 or best of 5, with the deciding set to 15',
      'Team entries with an optional player roster',
      'Serve and side-out tracked on every rally',
    ],
    formats: 'Pools of four teams into semi-finals and a final is the usual shape; a single round-robin league works well for corporate and inter-school events.',
    faqs: [
      ['Can teams enter with their players?', 'Yes. A team enters with its name and, optionally, a list of players that only the organisers see.'],
      ['Does it handle the deciding set to 15?', 'Yes. Sets to 25, win by 2, and a deciding set to 15 — or the same length as the others if you prefer.'],
      ['Can I run men\'s, women\'s and mixed together?', 'Yes. Each is its own event with its own pools and playoffs, all on one tournament page.'],
    ],
  },
  'beach-volleyball': {
    title: 'Beach Volleyball Tournament App — Pairs, Pools & Live Scoring',
    description: 'Run a beach volleyball tournament: pair entries, sets to 21 with a deciding set to 15, side switches called, pools into playoffs and live scores. Free for up to 16 pairs.',
    lead: 'Pairs on the sand, every rally counted. Tonament calls the side switches, keeps the score and posts results while you run the pools.',
    rules: [
      'Pairs (doubles) events — Men\'s, Women\'s, Mixed and Open',
      'Sets to 21, best of 3, deciding set to 15',
      'Side switches called every 7 points (every 5 in the deciding set)',
      'Pools into a knockout, or a straight knockout for big fields',
    ],
    formats: 'Pools of three or four pairs feeding a knockout suits a one-day beach event; use single sets to 21 when you\'re short on time or courts.',
    faqs: [
      ['Does it call the side switches?', 'Yes — every 7 points in sets to 21 and every 5 in the deciding set, shown to the umpire as it happens.'],
      ['Can we play single sets?', 'Yes. Choose a single set (to 21 or 15) or best of 3 per event.'],
      ['Do players need the app?', 'No app to install — everything runs in the browser, for organisers, umpires, players and spectators.'],
    ],
  },
  throwball: {
    title: 'Throwball Tournament App — Team Entries, Leagues & Live Scoring',
    description: 'Run a throwball tournament: team entries, sets to 25, leagues and knockouts for schools, colleges and corporate events, with live scores. Free for up to 16 teams.',
    lead: 'Throwball is played at schools, colleges and offices across India. Tonament takes team entries, draws the league and knockout, and puts every point on everyone\'s phone.',
    rules: [
      'Sets to 25 (or 21, 15), win by 2',
      'Best of 3 or 5, with an optional deciding set to 15',
      'Team entries with an optional player roster',
      'Men\'s, Women\'s and Mixed events side by side',
    ],
    formats: 'A league for every team, then the top two in each group into semi-finals, is the common shape for inter-school and inter-college meets.',
    faqs: [
      ['Is throwball scoring supported?', 'Yes — sets to 25 (or 21, 15), win by 2, best of 3 or 5, with every point scored live by the umpire.'],
      ['Can I run an inter-college or corporate event?', 'Yes. Teams enter online (or you add them), and each event gets its own groups, fixtures and knockout.'],
      ['Can teams list their players?', 'Yes — an optional roster per team, visible only to the organisers.'],
    ],
  },
  'sepak-takraw': {
    title: 'Sepak Takraw Tournament App — Regu Entries, Sets & Live Scoring',
    description: 'Run a sepak takraw tournament: team (regu) entries, sets to 21 with a deciding set to 15, groups and knockouts, and live scores. Free for up to 16 teams.',
    lead: 'Run your sepak takraw event the easy way: regus enter online, groups and knockouts are drawn for you, and every point is scored live.',
    rules: [
      'Sets to 21 (or 15), win by 2',
      'Best of 3 with the deciding set to 15, or a single set',
      'Team (regu) entries with an optional roster',
      'Groups into a knockout, a league, or a straight knockout',
    ],
    formats: 'Groups of three or four regus into semi-finals keeps a one-day event on time; use single sets for qualifying rounds if courts are short.',
    faqs: [
      ['Does it support the deciding set to 15?', 'Yes — sets to 21, best of 3, with the third set to 15. You can also play single sets.'],
      ['Can I add teams myself?', 'Yes. Paste your list of regus, or let teams enter through the tournament link.'],
      ['Do spectators see live scores?', 'Yes — on their phones, and on a TV at the venue with the venue display.'],
    ],
  },
};

module.exports = { SPORTS };
