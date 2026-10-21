'use strict';

// Courts and the order of play across events: calling matches to courts,
// keeping busy players off a second court, estimated start times, auto-call.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const schedule = require('../public/schedule');

let db;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  svc = createApp(db).service;
});
test.after(() => db.close());

const ORG = { user: { id: 1, email: 'org@courts.test', name: 'Org', isAdmin: false } };
const MIN = 60000;
const vs = (m) => `${m.a.name} v ${m.b.name}`;

test('orderOfPlay: round by round across events, busy players wait, estimated starts', () => {
  const e = (id, name) => ({ id, name });
  const m = (id, a, b, extra = {}) => ({ id, stage: 'league', round: 1, group: 0, slot: id, status: 'scheduled', a: e(id * 10, a), b: e(id * 10 + 1, b), ...extra });
  const now = Date.parse('2030-06-01T09:00:00Z');
  const events = [
    { id: 1, name: 'MS', status: 'league', matches: [
      m(1, 'Asha', 'Ben', { status: 'live', court: 'Court 1', calledAt: '2030-06-01T08:50:00Z' }),
      m(2, 'Cy', 'Dev'),
      m(3, 'Asha', 'Cy', { round: 2 }),
    ] },
    { id: 2, name: 'XD', status: 'league', matches: [
      m(4, 'Asha / Eva', 'Fay / Gus'), // Asha is on Court 1
      m(5, 'Hal / Ivy', 'Jo / Kai', { round: 2 }),
    ] },
    { id: 3, name: 'WS', status: 'setup', matches: [m(6, 'Liz', 'Mo')] }, // not started
  ];
  const plan = schedule.orderOfPlay({ events, courts: ['Court 1', 'Court 2'], minutes: 20, now });
  assert.deepEqual(plan.queue.map((x) => x.match.id), [2, 4, 3, 5]); // round 1 of every event first
  assert.deepEqual(plan.queue[1].waitingFor, [{ name: 'Asha', court: 'Court 1' }]);
  assert.equal(plan.next.match.id, 2);
  assert.deepEqual(plan.courts.map((c) => [c.name, c.match && c.match.id, c.next && c.next.match.id]), [['Court 1', 1, null], ['Court 2', null, 2]]);
  // Two free courts get different matches, never sharing a player.
  const two = schedule.orderOfPlay({ events, courts: ['Court 1', 'Court 2', 'Court 3'], minutes: 20, now });
  assert.deepEqual(two.courts.map((c) => c.next && c.next.match.id), [null, 2, 5]);
  // Court 2 is free now; Court 1 frees at 09:10 (called 08:50 + 20 min). Asha v Cy
  // waits for Asha's mixed match (09:10-09:30) even though Court 2 frees at 09:20.
  const at = (i) => (plan.queue[i].startsAt - now) / MIN;
  assert.deepEqual([at(0), at(1), at(2), at(3)], [0, 10, 30, 30]);

  // "Play next" pins a match to the front.
  events[1].matches[1].queuePos = -1;
  assert.equal(schedule.orderOfPlay({ events, courts: ['Court 1'], now }).queue[0].match.id, 5);
});

async function cup(extra = {}) {
  const { id } = await svc.createTournament(ORG, {
    name: 'Court Cup', format: 'league', scoring: { bestOf: 1, points: 5, cap: 5 },
    events: [{ discipline: 'singles', gender: 'men' }, { discipline: 'doubles', gender: 'mixed' }],
    ...extra,
  });
  let t = await svc.getTournament(id, ORG);
  const [ms, xd] = t.events;
  await svc.addEntries(id, ORG, ['Asha', 'Ben', 'Cy'], { event: ms.id });
  await svc.addEntries(id, ORG, ['Asha / Eva', 'Fay / Gus'], { event: xd.id });
  await svc.start(id, ORG, { event: ms.id });
  t = await svc.start(id, ORG, { event: xd.id });
  return { id, t };
}

test('court settings', async () => {
  const { id } = await cup();
  let t = await svc.updateSettings(id, ORG, { courts: { names: ['Court 1', ' Court  2 '], minutes: 15, auto: true } });
  assert.deepEqual(t.courts, { names: ['Court 1', 'Court 2'], minutes: 15, auto: true });
  t = await svc.updateSettings(id, ORG, { courts: { names: ['A', 'B', 'C'] } });
  assert.deepEqual(t.courts, { names: ['A', 'B', 'C'], minutes: 25, auto: false }); // badminton's typical length
  const bad = (courts, re) => assert.rejects(svc.updateSettings(id, ORG, { courts }), (e) => e.status === 400 && re.test(e.message));
  await bad({ names: ['A', 'a'] }, /different/);
  await bad({ names: ['A', ''] }, /name/);
  await bad({ names: Array.from({ length: 41 }, (_, i) => `C${i}`) }, /Up to 40/);
  await bad({ names: ['A'], minutes: 2 }, /from 5 to 240/);
  t = await svc.updateSettings(id, ORG, { courts: { names: [] } });
  assert.equal(t.courts, null);
});

test('calling matches to courts, "Play next", and taking a match off court', async () => {
  const { id, t: started } = await cup();
  await svc.updateSettings(id, ORG, { courts: { names: ['Court 1', 'Court 2'] } });
  const all = started.events.flatMap((e) => e.matches);
  const ms = all.filter((m) => !m.a.name.includes('/'));
  const xd = all.find((m) => m.a.name.includes('/'));

  let t = await svc.callMatch(id, ORG, ms[0].id, 'Court 1');
  const called = t.events.flatMap((e) => e.matches).find((m) => m.id === ms[0].id);
  assert.deepEqual([called.status, called.court, called.rallies], ['live', 'Court 1', 0]);
  assert.ok(called.calledAt);
  await assert.rejects(svc.callMatch(id, ORG, ms[1].id, 'Court 1'), /Court 1 is in use/);
  await assert.rejects(svc.callMatch(id, ORG, ms[0].id, 'Court 2'), /already on court/);
  await assert.rejects(svc.callMatch(id, ORG, ms[1].id, 'Court 9'), /Choose one of/);

  t = await svc.queueMatch(id, ORG, xd.id);
  assert.equal(t.events[1].matches[0].queuePos, -1);
  t = await svc.queueMatch(id, ORG, xd.id, false);
  assert.equal(t.events[1].matches[0].queuePos, null);

  // Off court before the first point: back in the queue, court cleared.
  const off = await svc.updateMatch(id, ORG, ms[0].id, { status: 'scheduled' });
  assert.deepEqual([off.status, off.court, off.calledAt], ['scheduled', null, null]);
});

test('auto-call: a finished match brings the next free match to its court; undo puts it back', async () => {
  const { id, t: started } = await cup();
  await svc.updateSettings(id, ORG, { courts: { names: ['Court 1', 'Court 2'], auto: true } });
  const all = started.events.flatMap((e) => e.matches);
  // Asha plays in both events: while her singles match is on court, the mixed match waits.
  const first = all.find((m) => m.a.name === 'Asha' || m.b.name === 'Asha');
  await svc.callMatch(id, ORG, first.id, 'Court 1');
  let after;
  for (let i = 0; i < 5; i++) after = await svc.rally(id, ORG, first.id, 'a');
  assert.equal(after.status, 'done');
  const t = await svc.getTournament(id, ORG);
  const onCourt = t.events.flatMap((e) => e.matches).filter((m) => m.status === 'live');
  assert.equal(onCourt.length, 1);
  assert.equal(onCourt[0].court, 'Court 1');
  assert.equal(onCourt[0].rallies, 0);

  // Undoing the winning point reopens the match on Court 1; the called match goes back.
  await svc.undo(id, ORG, first.id);
  const back = (await svc.getTournament(id, ORG)).events.flatMap((e) => e.matches).find((m) => m.id === onCourt[0].id);
  assert.deepEqual([back.status, back.court], ['scheduled', null]);

  // Without auto-call nothing is called.
  await svc.updateSettings(id, ORG, { courts: { names: ['Court 1', 'Court 2'], auto: false } });
  await svc.rally(id, ORG, first.id, 'a');
  const live = (await svc.getTournament(id, ORG)).events.flatMap((e) => e.matches).filter((m) => m.status === 'live');
  assert.deepEqual(live.map(vs), []);
});
