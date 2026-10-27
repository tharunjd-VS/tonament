'use strict';

// Timed team sports: football, futsal, hockey, kabaddi, basketball. Halves
// or quarters ended by the scorer; draws in leagues (not basketball);
// penalties, extra time, shoot-outs, tie-break raids and overtime; league
// points and goal-difference tables; results entered at the end.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const sports = require('../server/sports');
const events = require('../public/sports/events');
const league = require('../public/sports/league');
const formats = require('../server/formats');
const R = require('../public/sports/rally');
const { fromScores } = require('../public/sports/result');

const football = sports.get('football');
const futsal = sports.get('futsal');
const hockey = sports.get('hockey');
const kabaddi = sports.get('kabaddi');
const basketball = sports.get('basketball');
const pts = (side, n) => R.tapCode(side, n);

test('football: two halves, the scorer ends each; the leader at full time wins', () => {
  let s = football.compute('', {});
  assert.deepEqual([s.note, s.taps.endLabel, s.tap.a, s.single, s.timed], ['1st half', 'End 1st half', 'Goal', true, true]);
  s = football.compute('aab', {});
  assert.deepEqual([s.games[0].a, s.games[0].b, s.winner], [2, 1, null]);
  s = football.compute('aabx', {});
  assert.deepEqual([s.note, s.taps.endLabel], ['2nd half', 'Full time']);
  s = football.compute('aabxbbx', {});
  assert.deepEqual([s.winner, football.summary(s), s.note, s.taps.end], ['b', '2-3', null, false]);
  // Goals after full time don't count.
  assert.equal(football.compute('aabxbbxaaaa', {}).games[0].a, 2);
  // Nothing to do with games won: tables go to goal difference.
  assert.deepEqual(football.compute('aabxbbx', {}).gamesWon, { a: 0, b: 0 });
});

test('football: level at full time — a league draw, or penalties / extra time in a knockout', () => {
  // League (draws allowed through league.score).
  let s = league.score(football, 'abxx', {}, 'a', { draws: true });
  assert.deepEqual([s.draw, s.winner, league.finished(s), football.summary(s)], [true, null, true, '1-1']);
  // Knockout: penalties.
  s = football.compute('abxx', {});
  assert.deepEqual([s.phase, s.note, s.taps.end, s.taps.values], ['shootout', 'Penalties 0–0', false, [1]]);
  assert.equal(s.tap.a, 'Scored');
  s = football.compute('abxx' + 'aab', {});
  assert.deepEqual([s.note, s.taps.end, s.taps.endLabel], ['Penalties 2–1', true, 'End penalties']);
  s = football.compute('abxx' + 'aab' + 'x', {});
  assert.deepEqual([s.winner, football.summary(s), s.decidedBy], ['a', '1-1 (2-1 pens)', 'shootout']);
  // Level penalties can't end ('x' ignored): sudden death goes on.
  assert.equal(football.compute('abxx' + 'ab' + 'x', {}).phase, 'shootout');
  // Extra time first, if chosen.
  s = football.compute('abxx', { tie: 'extra' });
  assert.deepEqual([s.phase, s.note, s.taps.endLabel], ['extra', 'Extra time · 1st half', 'End 1st half of extra time']);
  s = football.compute('abxx' + 'x' + 'a' + 'x', { tie: 'extra' });
  assert.deepEqual([s.winner, football.summary(s)], ['a', '2-1 (aet)']);
  s = football.compute('abxx' + 'xx' + 'baa' + 'x', { tie: 'extra' });
  assert.deepEqual([s.winner, football.summary(s)], ['a', '1-1 (2-1 pens)']);
  // The confirm before full time says what comes next.
  assert.match(football.compute('abx', {}).taps.endConfirm, /penalties next/i);
  assert.equal(football.compute('abx', { draws: true }).taps.endConfirm, null);
  // Settings: only known choices.
  assert.deepEqual(football.normalizeConfig({ tie: 'coin toss', periods: 3 }), { periods: 2, tie: 'penalties' });
  assert.equal(football.fields.find((f) => f.key === 'tie').options.length, 2);
});

test('futsal and hockey: halves or quarters, penalties or a shoot-out', () => {
  let s = futsal.compute('aax' + 'bbx' + 'abbx', {});
  assert.deepEqual([s.winner, futsal.summary(s)], ['b', '2-2 (1-2 pens)']);
  // Hockey: four quarters by default, a shoot-out when level.
  s = hockey.compute('axbx', {});
  assert.deepEqual([s.note, s.taps.endLabel], ['3rd quarter', 'End 3rd quarter']);
  s = hockey.compute('axbxxx' + 'aaab' + 'x', {});
  assert.deepEqual([s.winner, hockey.summary(s)], ['a', '1-1 (3-1 shoot-out)']);
  assert.equal(hockey.compute('', {}).firstLabel, 'Pushback');
  // Two halves if chosen.
  s = hockey.compute('ax' + 'x', { periods: 2 });
  assert.deepEqual([s.winner, s.phase], ['a', 'over']);
});

test('kabaddi: 1–5 points a tap, two halves, tie-break raids', () => {
  let s = kabaddi.compute('', {});
  assert.deepEqual([s.tap, s.taps.values, s.taps.max], [null, [1, 2, 3, 4, 5], 5]);
  s = kabaddi.compute(pts('a', 3) + pts('b', 2) + 'x' + pts('b', 5) + 'a' + 'x', {});
  assert.deepEqual([s.winner, kabaddi.summary(s)], ['b', '4-7']);
  // Level: tie-break raids, one point a tap.
  s = kabaddi.compute(pts('a', 4) + pts('b', 4) + 'xx', {});
  assert.deepEqual([s.phase, s.taps.max, s.tieName], ['shootout', 1, 'Tie-break raids']);
  s = kabaddi.compute(pts('a', 4) + pts('b', 4) + 'xx' + 'aabbb' + 'x', {});
  assert.deepEqual([s.winner, kabaddi.summary(s)], ['b', '4-4 (2-3 tie-break)']);
});

test('basketball: 1, 2 and 3 points; never a draw — overtime until someone leads', () => {
  let s = basketball.compute(pts('a', 3) + pts('b', 2) + 'x', {});
  assert.deepEqual([s.note, s.taps.values, s.firstLabel], ['2nd quarter', [1, 2, 3], 'Tip-off']);
  // Level after four quarters, even in a league: overtime.
  s = league.score(basketball, pts('a', 2) + pts('b', 2) + 'xxxx', {}, 'a', { draws: true });
  assert.deepEqual([s.draw, s.phase, s.note, s.taps.endLabel], [false, 'overtime', 'Overtime', 'End overtime']);
  // Still level after one: a second overtime.
  s = basketball.compute(pts('a', 2) + pts('b', 2) + 'xxxx' + 'ab' + 'x', {});
  assert.deepEqual([s.phase, s.note], ['overtime', 'Overtime 2']);
  s = basketball.compute(pts('a', 2) + pts('b', 2) + 'xxxx' + 'ab' + 'x' + pts('b', 3) + 'x', {});
  assert.deepEqual([s.winner, basketball.summary(s)], ['b', '3-6 (OT)']);
  assert.equal(basketball.draws, false);
  assert.equal(basketball.compute(pts('a', 2) + 'xx', { periods: 2 }).winner, 'a');
});

test('the catalogue, event types, words and league points for the new sports', () => {
  for (const id of ['football', 'futsal', 'hockey', 'kabaddi', 'basketball']) {
    assert.equal(sports.info(id).status, 'live', id);
    assert.equal(sports.info(id).family, 'timed', id);
    assert.deepEqual(events.disciplinesFor(id), ['team'], id);
    assert.equal(sports.get(id).timed, true, id);
  }
  assert.equal(events.courtWord('football'), 'Pitch');
  assert.equal(events.courtWord('hockey'), 'Pitch');
  assert.equal(events.courtWord('futsal'), 'Court');
  assert.equal(events.courtWord('basketball'), 'Court');
  assert.deepEqual([football.leaguePoints, kabaddi.leaguePoints, basketball.leaguePoints], [{ win: 3, draw: 1 }, { win: 2, draw: 1 }, { win: 2, draw: 0 }]);
  assert.throws(() => events.normalize({ discipline: 'singles' }, {}, 'football'), /team events only/);
});

test('league tables: 3 for a win, 1 for a draw, then goal difference', () => {
  const r = (a, b, ga, gb, draw = false) => ({ a, b, winner: draw ? null : ga > gb ? a : b, draw, gamesA: 0, gamesB: 0, pointsA: ga, pointsB: gb });
  // 1 beats 2 3-0, 2 beats 3 1-0, 1 and 3 draw 2-2 → 1: 4 pts, 2: 3, 3: 1.
  let t = formats.standings([1, 2, 3], [r(1, 2, 3, 0), r(2, 3, 1, 0), r(1, 3, 2, 2, true)], football.leaguePoints);
  assert.deepEqual(t.map((x) => [x.id, x.leaguePoints, x.pointsFor - x.pointsAgainst]), [[1, 4, 3], [2, 3, -2], [3, 1, -1]]);
  // Level on points: goal difference decides (no head-to-head between three).
  t = formats.standings([1, 2, 3], [r(1, 2, 1, 0), r(2, 3, 4, 0), r(3, 1, 1, 0)], football.leaguePoints);
  assert.deepEqual(t.map((x) => x.id), [2, 1, 3]);
  // Other sports keep 2 for a win, 1 for a draw.
  t = formats.standings([1, 2], [r(1, 2, 1, 1, true)]);
  assert.deepEqual(t.map((x) => x.leaguePoints), [1, 1]);
});

test('results at the end: final score, and penalties when a knockout match is level', () => {
  const enter = (sport, cfg, games) => {
    const r = fromScores((log) => sport.compute(log, cfg, 'a'), games);
    return r.error ? { error: r.error } : { summary: sport.summary(r.score), winner: r.score.winner, draw: r.score.draw };
  };
  assert.deepEqual(enter(football, {}, [{ a: 2, b: 1 }]), { summary: '2-1', winner: 'a', draw: false });
  assert.deepEqual(enter(football, { draws: true }, [{ a: 1, b: 1 }]), { summary: '1-1', winner: null, draw: true });
  assert.match(enter(football, {}, [{ a: 1, b: 1 }]).error, /enter the penalties too/);
  assert.deepEqual(enter(football, {}, [{ a: 1, b: 1 }, { a: 4, b: 3 }]).summary, '1-1 (4-3 pens)');
  assert.deepEqual(enter(football, { tie: 'extra' }, [{ a: 2, b: 2 }, { a: 5, b: 4 }]).summary, '2-2 (5-4 pens)');
  assert.match(enter(football, { draws: true }, [{ a: 1, b: 1 }, { a: 4, b: 3 }]).error, /drawn league match has no penalties/);
  assert.match(enter(futsal, {}, [{ a: 5, b: 5 }, { a: 3, b: 3 }]).error, /can't end level/);
  assert.deepEqual(enter(basketball, {}, [{ a: 88, b: 84 }]).summary, '88-84');
  assert.match(enter(basketball, {}, [{ a: 80, b: 80 }]).error, /overtime points/);
  assert.deepEqual(enter(kabaddi, {}, [{ a: 30, b: 30 }, { a: 6, b: 4 }]).summary, '30-30 (6-4 tie-break)');
  assert.deepEqual(enter(hockey, {}, [{ a: 0, b: 3 }]).winner, 'b');
  assert.match(enter(football, {}, [{ a: 'x', b: 1 }]).error, /Enter both teams/);
});

test('a football tournament: league with draws and goal difference, then a knockout through penalties', async () => {
  const db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  try {
    const svc = createApp(db).service;
    const ORG = { user: { id: 1, email: 'org@timed.test', name: 'Org', isAdmin: false } };
    const { id } = await svc.createTournament(ORG, { name: 'Sunday Cup', sport: 'football', format: 'league_knockout', groups: 1, qualifiers: 2, events: [{ discipline: 'team', gender: 'open' }] });
    await assert.rejects(svc.createTournament(ORG, { name: 'X', sport: 'football', events: [{ discipline: 'singles', gender: 'men' }] }), /team/i);
    await svc.addEntries(id, ORG, ['Rovers', 'United', 'City']);
    let t = await svc.start(id, ORG);
    const name = (e) => e && e.name;
    const play = async (m, a, b) => {
      const pair = [name(m.a), name(m.b)];
      const [ga, gb] = pair[0] === a[0] ? [a[1], b[1]] : [b[1], a[1]];
      return svc.setResult(id, ORG, m.id, [{ a: ga, b: gb }]);
    };
    const league = t.matches.filter((m) => m.stage === 'league');
    assert.equal(league.length, 3);
    const find = (x, y) => league.find((m) => [name(m.a), name(m.b)].sort().join() === [x, y].sort().join());
    // Rovers 3-0 United, United 1-0 City, Rovers 2-2 City (a draw is a result in the league).
    await play(find('Rovers', 'United'), ['Rovers', 3], ['United', 0]);
    await play(find('United', 'City'), ['United', 1], ['City', 0]);
    const drawn = await play(find('Rovers', 'City'), ['Rovers', 2], ['City', 2]);
    assert.deepEqual([drawn.status, drawn.summary, drawn.draw], ['done', '2-2', true]);
    t = await svc.getTournament(id, ORG);
    const table = t.groups[0].standings.map((r) => [r.name, r.leaguePoints, r.drawn, r.pointsFor, r.pointsAgainst]);
    assert.deepEqual(table, [['Rovers', 4, 1, 5, 2], ['United', 3, 0, 1, 3], ['City', 1, 1, 2, 3]]);
    // The top two play the final — level, so live scoring goes to penalties.
    await svc.startKnockout(id, ORG);
    t = await svc.getTournament(id, ORG);
    const final = t.matches.find((m) => m.stage === 'knockout' && m.a && m.b);
    for (const ch of 'ab') await svc.rally(id, ORG, final.id, ch);
    await svc.rally(id, ORG, final.id, null, undefined, { end: true });
    let m = await svc.rally(id, ORG, final.id, null, undefined, { end: true });
    assert.deepEqual([m.status, m.score.phase], ['live', 'shootout']);
    await assert.rejects(svc.rally(id, ORG, final.id, null, undefined, { end: true }), /level/);
    await assert.rejects(svc.rally(id, ORG, final.id, 'a', undefined, { points: 2 }), /one point at a time/);
    for (const ch of 'aaab') await svc.rally(id, ORG, final.id, ch);
    m = await svc.rally(id, ORG, final.id, null, undefined, { end: true });
    assert.deepEqual([m.status, m.summary], ['done', '1-1 (3-1 pens)']);
    t = await svc.getTournament(id, ORG);
    assert.equal(t.status, 'completed');
    assert.equal(t.champion.name, name(final.a));
  } finally {
    await db.close?.();
  }
});

test('a basketball knockout: points by 1, 2 and 3, and overtime', async () => {
  const db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  try {
    const svc = createApp(db).service;
    const ORG = { user: { id: 1, email: 'org@hoops.test', name: 'Org', isAdmin: false } };
    const { id } = await svc.createTournament(ORG, { name: 'Hoops Night', sport: 'basketball', format: 'knockout', scoring: { periods: 2 }, events: [{ discipline: 'team', gender: 'open' }] });
    await svc.addEntries(id, ORG, ['Bulls', 'Hawks']);
    let t = await svc.start(id, ORG);
    const m0 = t.matches.find((m) => m.a && m.b);
    await svc.rally(id, ORG, m0.id, 'a', undefined, { points: 3 });
    await svc.rally(id, ORG, m0.id, 'b', undefined, { points: 2 });
    await svc.rally(id, ORG, m0.id, 'b');
    await assert.rejects(svc.rally(id, ORG, m0.id, 'a', undefined, { points: 4 }), /1 to 3/);
    await svc.rally(id, ORG, m0.id, null, undefined, { end: true });
    let m = await svc.rally(id, ORG, m0.id, null, undefined, { end: true });
    assert.deepEqual([m.status, m.score.phase, m.score.note], ['live', 'overtime', 'Overtime']);
    await svc.rally(id, ORG, m0.id, 'b', undefined, { points: 2 });
    m = await svc.rally(id, ORG, m0.id, null, undefined, { end: true });
    assert.deepEqual([m.status, m.summary], ['done', '3-5 (OT)']);
    t = await svc.getTournament(id, ORG);
    assert.equal(t.champion.name, m0.b.name);
  } finally {
    await db.close?.();
  }
});
