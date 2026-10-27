'use strict';

// Scores entered at the end: turned into the points a live scorer would
// have tapped, for every sport, and saved like a live match.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const sports = require('../server/sports');
const { fromScores } = require('../public/sports/result');

const enter = (id, cfg, games) => {
  const sport = sports.get(id);
  const r = fromScores((log) => sport.compute(log, cfg, 'a'), games);
  return r.error ? { error: r.error } : { summary: sport.summary(r.score), winner: r.score.winner, rallies: r.rallies };
};

test('every sport: the entered score is exactly what the rules give back', () => {
  const cases = [
    ['badminton', {}, [[21, 17], [18, 21], [23, 21]], '21-17, 18-21, 23-21'],
    ['badminton', {}, [[30, 29], [21, 5]], '30-29, 21-5'],
    ['pickleball', {}, [[11, 9], [8, 11], [11, 4]], '11-9, 8-11, 11-4'], // side-out: only the server scores
    ['squash', {}, [[11, 9], [11, 4], [12, 10]], '11-9, 11-4, 12-10'],
    ['table-tennis', {}, [[11, 9], [11, 4], [11, 3]], '11-9, 11-4, 11-3'],
    ['volleyball', {}, [[25, 23], [23, 25], [25, 20], [20, 25], [15, 13]], '25-23, 23-25, 25-20, 20-25, 15-13'],
    ['sepak-takraw', {}, [[21, 15], [21, 19]], '21-15, 21-19'],
    ['padel', {}, [[6, 2], [6, 3]], '6-2, 6-3'],
    ['snooker', { scoring: 'frames', bestOf: 5 }, [[3, 1]], '3-1'],
    ['snooker', { bestOf: 3 }, [[72, 40], [15, 88], [64, 12]], '2-1 (72-40, 15-88, 64-12)'],
    ['pool', { bestOf: 9 }, [[5, 3]], '5-3'],
    ['carrom', { bestOf: 3 }, [[25, 12], [20, 25], [25, 0]], '25-12, 20-25, 25-0'],
  ];
  for (const [id, cfg, games, summary] of cases) {
    const r = enter(id, cfg, games.map(([a, b]) => ({ a, b })));
    assert.equal(r.error, undefined, `${id}: ${r.error}`);
    assert.equal(r.summary, summary, id);
    assert.equal(r.winner, 'a', id);
  }
  // Tennis: sets, with tie-breaks played out.
  const t = enter('tennis', {}, [{ a: 6, b: 4 }, { a: 6, b: 7 }, { a: 7, b: 6 }]);
  assert.equal(t.winner, 'a');
  assert.match(t.summary, /^6-4, 6-7\(\d+\), 7-6\(\d+\)$/);
});

test('impossible scores are refused with a reason', () => {
  assert.match(enter('badminton', {}, [{ a: 21, b: 20 }]).error, /21-20 isn't a finished game .* game 1/);
  assert.match(enter('badminton', {}, [{ a: 25, b: 10 }]).error, /isn't a finished game/);
  assert.match(enter('badminton', {}, [{ a: 21, b: 21 }]).error, /someone has to win/);
  assert.match(enter('badminton', {}, [{ a: 21, b: 'x' }]).error, /Enter both scores for game 1/);
  assert.match(enter('badminton', {}, [{ a: 21, b: 5 }, { a: 21, b: 5 }, { a: 21, b: 5 }]).error, /already won before game 3/);
  assert.match(enter('tennis', {}, [{ a: 6, b: 5 }]).error, /isn't a finished set/);
  assert.match(enter('snooker', { scoring: 'frames', bestOf: 5 }, [{ a: 2, b: 1 }]).error, /doesn't finish the match \(first to 3 frames\)/);
  assert.match(enter('badminton', {}, []).error, /Enter the score/);
});

test('tournaments: enter results instead of scoring live', async () => {
  const db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  try {
    const svc = createApp(db).service;
    const ORG = { user: { id: 1, email: 'org@result.test', name: 'Org', isAdmin: false } };
    const { id } = await svc.createTournament(ORG, { name: 'Results Cup', sport: 'badminton', format: 'knockout', events: [{ discipline: 'singles', gender: 'open' }] });
    await svc.addEntries(id, ORG, ['Asha', 'Bala', 'Chitra', 'Dev']);
    let t = await svc.start(id, ORG);
    const semis = t.matches.filter((m) => m.round === 1 && m.a && m.b);
    // Some live points first: the result replaces them.
    await svc.rally(id, ORG, semis[0].id, 'b');
    await svc.rally(id, ORG, semis[0].id, 'b');
    await assert.rejects(svc.setResult(id, ORG, semis[0].id, [{ a: 21, b: 17 }], 0), /changed on another device/);
    await assert.rejects(svc.setResult(id, ORG, semis[0].id, [{ a: 21, b: 17 }]), /doesn't finish the match/);
    await assert.rejects(svc.setResult(id, ORG, semis[0].id, [{ a: 21, b: 20 }, { a: 21, b: 3 }]), /21-20 isn't a finished game/);
    let m = await svc.setResult(id, ORG, semis[0].id, [{ a: 21, b: 17 }, { a: 18, b: 21 }, { a: 21, b: 15 }], 2);
    assert.deepEqual([m.status, m.summary], ['done', '21-17, 18-21, 21-15']);
    await assert.rejects(svc.setResult(id, ORG, semis[0].id, [{ a: 21, b: 1 }, { a: 21, b: 1 }]), /already finished/);
    await svc.setResult(id, ORG, semis[1].id, [{ a: 15, b: 21 }, { a: 10, b: 21 }]);
    t = await svc.getTournament(id, ORG);
    const final = t.matches.find((x) => x.round === t.config.knockoutRounds);
    assert.deepEqual([final.a.name, final.b.name], [semis[0].a.name, semis[1].b.name]);
    // Undo still works point by point on an entered result.
    await svc.undo(id, ORG, semis[1].id);
    t = await svc.getTournament(id, ORG);
    assert.equal(t.matches.find((x) => x.id === semis[1].id).status, 'live');
    m = await svc.rally(id, ORG, semis[1].id, 'b');
    assert.equal(m.status, 'done');
    await svc.setResult(id, ORG, final.id, [{ a: 21, b: 19 }, { a: 22, b: 20 }]);
    t = await svc.getTournament(id, ORG);
    assert.equal(t.status, 'completed');
    assert.equal(t.champion.name, semis[0].a.name);
  } finally {
    await db.close?.();
  }
});
