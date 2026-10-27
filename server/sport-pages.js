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
  snooker: {
    title: 'Snooker Tournament App — Draws, Tables & Live Frame Scores',
    description: 'Run a snooker tournament: online entries, groups and knockouts, table scheduling and frame-by-frame live scores, best of 3 to best of 11. Free for up to 16 entries.',
    lead: 'Club nights, café leagues and ranking events: take entries online, draw the groups and the knockout, call matches to free tables and post every frame live.',
    rules: [
      'Best of 1, 3, 5, 7, 9 or 11 frames — shorter in the groups, longer for the final',
      'Score ball by ball — tap the ball potted, fouls go to the opponent, the break is shown — or just who won each frame',
      'Singles and doubles, plus age groups and handicap levels as separate events',
      'An order of play across your tables, with estimated start times',
    ],
    formats: 'Groups of four into a knockout suit a weekend event; for a club, a league where everyone plays everyone over a few nights builds a proper table.',
    faqs: [
      ['Do markers need to enter every break?', 'Only if you want to. Score ball by ball (red 1 to black 7, fouls and the current break shown), or switch to "frames only" and tap who won each frame — quick enough for a busy club night. The match ends when someone reaches the frames needed.'],
      ['Can I make the final longer than the group matches?', 'Yes. Each event has its own match length, so groups can be best of 3 and the knockout best of 5 or 7 when run as separate events.'],
      ['We have six tables. Will it schedule them?', 'Yes. Add your tables and Tonament keeps one order of play — call the next match to a free table in one tap, or let it call matches automatically.'],
    ],
  },
  pool: {
    title: 'Pool Tournament App — 8-ball & 9-ball Draws, Race-to Scoring',
    description: 'Run an 8-ball, 9-ball or 10-ball pool tournament: online entries, groups and knockouts, race-to scoring rack by rack and live scores on every phone. Free for up to 16 entries.',
    lead: 'Pool halls and cafés run events every week. Tonament takes the entries, makes the draw, calls matches to tables and shows every rack live — so the bar TV can show the scores.',
    rules: [
      'Race to 2, 3, 4, 5, 6 or 7 — or a single rack for a quick shoot-out',
      '8-ball, 9-ball or 10-ball, set per event',
      'The ref (or a player) taps who won each rack',
      'A venue display for a TV: every table\'s live score and who\'s up next',
    ],
    formats: 'A straight knockout with races to 3 keeps a busy night moving; groups into a knockout guarantee every player several matches.',
    faqs: [
      ['Can players score their own matches?', 'Yes. Give players a scorer link or add them as umpires — they tap who won each rack and everyone sees the score live.'],
      ['Can I run 8-ball and 9-ball on the same night?', 'Yes. Add each as its own event, with its own race length and draw.'],
      ['Can the hall show scores on a TV?', 'Yes. Open the venue display on any TV or laptop: live scores from every table and what\'s up next.'],
    ],
  },
  football: {
    title: 'Football Tournament App — Fixtures, League Tables & Live Scores',
    description: 'Run a football tournament or league: team entries, groups and knockouts, fixtures across your pitches, live goals, league tables with goal difference, and penalties. Free for up to 16 teams.',
    lead: 'From five-a-side nights to inter-school cups: teams enter online, the groups and fixtures are drawn in a tap, and every goal reaches every phone the moment it goes in.',
    rules: [
      'Two halves; the scorer taps each goal and ends each half when the whistle goes',
      'League tables: 3 points for a win, 1 for a draw, then goal difference and head-to-head',
      'Level in a knockout: straight to penalties, or extra time and then penalties',
      'Team entries with an optional squad list, and fixtures across your pitches',
    ],
    formats: 'Groups of four into semi-finals and a final is the classic cup; a round-robin league suits a season of Sunday games. Players in two teams are never scheduled on two pitches at once.',
    faqs: [
      ['How are league tables ranked?', 'Points first — 3 for a win, 1 for a draw — then head-to-head when two teams are level, then goal difference. The table updates the moment a result is in.'],
      ['What happens if a knockout match is level?', 'You choose per event: straight to penalties, or extra time and then penalties. The scorer taps each penalty scored and ends the shoot-out when it\'s decided; the result reads "1-1 (4-3 pens)".'],
      ['Does it run a match clock?', 'No — the referee keeps time. The scorer just ends each half when the whistle goes, so it works for any match length, from 7-minute five-a-side to full 90 minutes.'],
      ['Can we just enter the final score?', 'Yes. Tap "Enter result" and type the score (and penalties if it was level) — the table and bracket update the same as with live scoring.'],
    ],
  },
  futsal: {
    title: 'Futsal Tournament App — Fixtures, Tables & Live Scores',
    description: 'Run a futsal tournament: team entries, groups into knockouts, fixtures across your courts, live goals, league tables with goal difference and penalties. Free for up to 16 teams.',
    lead: 'Fast games, lots of goals, many teams through one evening: take entries online, draw the groups and fixtures, and let everyone follow every goal live.',
    rules: [
      'Two halves; the scorer taps each goal and ends each half on the whistle',
      'League tables: 3 points for a win, 1 for a draw, then goal difference',
      'Level in a knockout: penalties, or extra time and then penalties',
      'An order of play across your courts with estimated kick-off times',
    ],
    formats: 'Short games suit groups of four or five teams playing each other in one evening, with the top two into semi-finals.',
    faqs: [
      ['How long are the matches?', 'As long as you like — the referee keeps time and the scorer ends each half. For scheduling, Tonament assumes about 50 minutes a match; change it in Courts.'],
      ['Can it run several courts at once?', 'Yes. Add your courts and call the next match to a free court in one tap, or let Tonament call them automatically.'],
      ['What about a level knockout match?', 'Penalties — or extra time first if you choose. The result shows the shoot-out, like "2-2 (3-2 pens)".'],
    ],
  },
  hockey: {
    title: 'Hockey Tournament App — Fixtures, Tables & Live Scores',
    description: 'Run a field hockey tournament: team entries, pools into knockouts, four quarters or two halves, live goals, league tables and shoot-outs. Free for up to 16 teams.',
    lead: 'School, club and corporate hockey: teams enter online, pools and fixtures are drawn in a tap, and every goal is live on every phone and the big screen.',
    rules: [
      'Four quarters (or two halves); the scorer taps each goal and ends each period',
      'League tables: 3 points for a win, 1 for a draw, then goal difference',
      'Level in a knockout: a shoot-out decides it',
      'Team entries with an optional squad, fixtures across your pitches',
    ],
    formats: 'Pools of four into semi-finals is the common shape for a weekend; a league suits a season of fixtures.',
    faqs: [
      ['Quarters or halves?', 'Either — choose per event. The scorer ends each quarter (or half) when the hooter goes.'],
      ['How is a level knockout match decided?', 'By a shoot-out: the scorer taps each one scored and ends the shoot-out when it\'s decided. The result reads like "2-2 (3-2 shoot-out)".'],
      ['Can spectators follow the scores?', 'Yes. Every goal reaches every phone in seconds, and the venue display shows all pitches on a TV.'],
    ],
  },
  kabaddi: {
    title: 'Kabaddi Tournament App — Team Entries, Pools & Live Scores',
    description: 'Run a kabaddi tournament: team entries, pools into knockouts, live raid and tackle points, league tables and tie-break raids. Free for up to 16 teams.',
    lead: 'From village and school championships to corporate leagues: teams enter online, the pools and fixtures are drawn in a tap, and every raid point is live for everyone watching.',
    rules: [
      'Two halves; the scorer adds raid, tackle, bonus and all-out points (+1 to +5 a tap)',
      'League tables: 2 points for a win, 1 for a tie, then point difference',
      'Level in a knockout: tie-break raids decide it',
      'Team entries with an optional squad list',
    ],
    formats: 'Pools of three or four teams into semi-finals keeps a one-day event moving; a league works for inter-college and corporate seasons.',
    faqs: [
      ['How are points entered?', 'One tap per scoring moment: +1 for a touch or tackle, +2 for an all-out, up to +5 for a super raid. Undo takes off the last tap.'],
      ['What if the match is tied in a knockout?', 'Tie-break raids: the scorer taps each tie-break point and ends it when one team leads. The result reads like "30-30 (6-4 tie-break)".'],
      ['Can we run men\'s and women\'s together?', 'Yes. Each is its own event with its own pools, fixtures and bracket on one tournament page.'],
    ],
  },
  basketball: {
    title: 'Basketball Tournament App — Fixtures, Standings & Live Scores',
    description: 'Run a basketball tournament: team entries, pools into playoffs, four quarters or two halves, 1, 2 and 3-point scoring live, overtime and standings. Free for up to 16 teams.',
    lead: 'From 3x3 street events to inter-school leagues: teams enter online, pools and playoffs are drawn in a tap, and every basket is live on every phone.',
    rules: [
      'Four quarters (or two halves); tap +1, +2 or +3 for each score',
      'Never a draw: level at the end means overtime, again until someone leads',
      'Standings: 2 points a win, then head-to-head and point difference',
      'Team entries with an optional roster, games across your courts',
    ],
    formats: 'Pools of four into semi-finals and a final fits a weekend; a round-robin league suits school and corporate seasons.',
    faqs: [
      ['How is the score entered?', 'One tap per basket: +1 for a free throw, +2 or +3 for field goals. The scorer ends each quarter when the buzzer goes.'],
      ['What happens if it\'s tied at the end?', 'Overtime — and another if it\'s still tied, until one team leads at the end of an overtime. The result shows "(OT)".'],
      ['Does it work for 3x3?', 'Yes — choose two halves, or simply end the game when it\'s over; or enter the final score straight away.'],
    ],
  },
  carrom: {
    title: 'Carrom Tournament App — Draws, Boards & Live Scoring',
    description: 'Run a carrom tournament: singles and doubles, online entries, groups and knockouts, board scheduling and live scores to 25 or 29 points. Free for up to 16 entries.',
    lead: 'From apartment and office championships to district events: take entries online, draw the groups, call matches to free boards and score every board live.',
    rules: [
      'Games to 25 points (or 29), best of 1 or 3',
      'After each board the umpire adds the winner\'s points — the opponent\'s coins left, plus 3 for the queen',
      'Singles and doubles, with age groups and levels as separate events',
      'An order of play across your boards, with estimated start times',
    ],
    formats: 'Groups of four into a knockout are the favourite for office and apartment events: everyone plays three matches before the knockout.',
    faqs: [
      ['How is a carrom game scored?', 'After each board, the umpire taps who won it and its points in one go — the opponent\'s coins left on the board, plus 3 for the queen. First to 25 (or 29) wins the game.'],
      ['Can I run singles and doubles together?', 'Yes. Add both as events; each gets its own entries and draw, and a player in both is never called to two boards at once.'],
      ['Do players need the app?', 'No. Everything runs in the browser — players enter from your link, and umpires score on their phones.'],
    ],
  },
};

module.exports = { SPORTS };
