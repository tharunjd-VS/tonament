'use strict';

// Event-day features: self-entry with a deadline, check-in, automatic group
// sizing, redraw, late entry and withdrawals.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const { enterAs } = require('./players');
const formats = require('../server/formats');

let db;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  svc = createApp(db).service;
});
test.after(() => db.close());
const enter = (...args) => enterAs(svc)(...args); // a player entering with their account

const ORG = { user: { id: 1, email: 'org@club.test', name: 'Org', isAdmin: false } };
const names = (n, p = 'P') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);

async function play(id, matchId, side = 'a') {
  let m;
  do m = await svc.rally(id, ORG, matchId, side);
  while (m.status !== 'done');
  return m;
}

test('groupCount: about N per group, never a group of one', () => {
  assert.equal(formats.groupCount(1, 4), 1);
  assert.equal(formats.groupCount(5, 4), 1);
  assert.equal(formats.groupCount(6, 4), 2);
  assert.equal(formats.groupCount(11, 4), 3);
  assert.equal(formats.groupCount(12, 4), 3);
  assert.equal(formats.groupCount(16, 4), 4);
  assert.equal(formats.groupCount(5, 2), 2);
  for (let n = 2; n <= 40; n++) {
    for (let size = 2; size <= 6; size++) {
      const g = formats.groupCount(n, size);
      const groups = formats.snakeGroups(Array.from({ length: n }, (_, i) => i), g);
      assert.ok(groups.every((x) => x.length >= 2), `n=${n} size=${size}`);
      const sizes = groups.map((x) => x.length);
      assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `n=${n} size=${size} uneven`);
    }
  }
});

test('self-entry: open until the deadline or the draw; contact details stay private', async () => {
  const { id } = await svc.createTournament(ORG, { visibility: 'public', name: 'Club Night', format: 'knockout' });
  let t = await svc.getTournament(id);
  assert.equal(t.config.selfEntry, true);
  assert.equal(t.entriesOpen, true);

  assert.deepEqual(await enter(id, { name: 'Asha', contact: '+91 98765 43210' }), { ok: true, name: 'Asha', confirmed: true, event: t.eventId });
  await enter(id, { name: 'Ben', partner: 'Cy', contact: 'Ben@Example.com' });
  await assert.rejects(enter(id, { name: 'Asha Again', contact: '+919876543210' }), /already entered this event/); // same account
  await assert.rejects(enter(id, { name: 'Dee', contact: 'dee@x.dev', phone: '123' }), /valid phone number/);
  // Bots filling the honeypot get a fake success and nothing is stored.
  assert.deepEqual(await enter(id, { name: 'Spam', contact: 'spam@x.dev', website: 'http://spam' }), { ok: true });

  t = await svc.getTournament(id);
  assert.deepEqual(t.entries.map((e) => [e.name, e.source]), [['Asha', 'self'], ['Ben / Cy', 'self']]);
  assert.equal(t.entries[0].contact, undefined); // public view
  t = await svc.getTournament(id, ORG);
  assert.deepEqual(t.entries.map((e) => e.contact), ['919876543210@phone.test', 'ben@example.com']); // the account emails

  // Deadline in the past closes the form; organisers can still add people.
  await svc.updateSettings(id, ORG, { entriesCloseAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal((await svc.getTournament(id)).entriesOpen, false);
  await assert.rejects(enter(id, { name: 'Late', contact: 'late@x.dev' }), /Entries are closed/);
  await svc.addEntries(id, ORG, ['Organiser Added']);
  await svc.updateSettings(id, ORG, { entriesCloseAt: '' }); // clear: open until the draw
  assert.equal((await svc.getTournament(id)).entriesOpen, true);

  await svc.updateSettings(id, ORG, { selfEntry: false });
  await assert.rejects(enter(id, { name: 'X', contact: 'x@x.dev' }), /doesn't take entries online/);
  await svc.updateSettings(id, ORG, { selfEntry: true });

  await svc.start(id, ORG);
  await assert.rejects(enter(id, { name: 'After', contact: 'after@x.dev' }), /draw has been made/);
  await assert.rejects(svc.updateSettings(id, ORG, { groupSize: 3 }), /locked/); // the event's format is locked
});

test('check-in: only checked-in players are drawn, walk-ins are checked in, groups sized at the start', async () => {
  const { id } = await svc.createTournament(ORG, { visibility: 'public', name: 'Saturday Open', groupSize: 4, qualifiers: 2 });
  await svc.addEntries(id, ORG, names(12));
  let t = await svc.getTournament(id, ORG);
  // 9 of 12 turn up, plus 2 walk-ins = 11 -> 3 groups (4, 4, 3)
  for (const e of t.entries.slice(0, 9)) await svc.checkIn(id, ORG, e.id, true);
  t = await svc.addEntries(id, ORG, ['Walk In 1', 'Walk In 2'], { walkIn: true });
  assert.deepEqual(t.entries.filter((e) => e.source === 'walk-in').map((e) => e.checkedIn), [true, true]);

  t = await svc.start(id, ORG);
  assert.equal(t.config.groups, 3);
  assert.deepEqual(t.groups.map((g) => g.standings.length).sort(), [3, 4, 4]);
  const absent = t.entries.filter((e) => !e.inDraw).map((e) => e.name);
  assert.deepEqual(absent, ['P10', 'P11', 'P12']);
  const drawn = new Set(t.matches.flatMap((m) => [m.a?.id, m.b?.id]));
  assert.ok(t.entries.filter((e) => !e.inDraw).every((e) => !drawn.has(e.id)));
  await assert.rejects(svc.checkIn(id, ORG, t.entries[0].id, false), /locked/);
});

test('no check-ins at all: everyone is drawn (unchanged behaviour)', async () => {
  const { id } = await svc.createTournament(ORG, { visibility: 'public', name: 'No Checkin', format: 'knockout' });
  await svc.addEntries(id, ORG, names(5));
  const t = await svc.start(id, ORG);
  assert.ok(t.entries.every((e) => e.inDraw));
  assert.equal(t.matches.length, 7);
});

test('redraw: allowed until the first point, then blocked', async () => {
  const { id } = await svc.createTournament(ORG, { visibility: 'public', name: 'Redraw Cup', groupSize: 4 });
  await svc.addEntries(id, ORG, names(8));
  let t = await svc.start(id, ORG);
  await svc.updateMatch(id, ORG, t.matches[0].id, { status: 'live' }); // on court, no points yet
  t = await svc.redraw(id, ORG);
  assert.equal(t.status, 'setup');
  assert.equal(t.matches.length, 0);
  assert.ok(t.entries.every((e) => e.group == null));
  t = await svc.addEntries(id, ORG, ['Latecomer A', 'Latecomer B']);
  t = await svc.start(id, ORG);
  assert.equal(t.entries.length, 10);
  assert.equal(t.config.groups, formats.groupCount(10, 4));
  await svc.rally(id, ORG, t.matches[0].id, 'a');
  await assert.rejects(svc.redraw(id, ORG), /before the first point/);
});

test('late entry in the group stage: off by default, then joins the smallest group with catch-up matches', async () => {
  const { id } = await svc.createTournament(ORG, { visibility: 'public', name: 'Late League', groupSize: 4, qualifiers: 2 });
  await svc.addEntries(id, ORG, names(11)); // groups of 4, 4, 3
  let t = await svc.start(id, ORG);
  await assert.rejects(svc.lateEntry(id, ORG, { name: 'Zed' }), (e) => e.code === 'late_off');
  await svc.updateSettings(id, ORG, { lateEntry: true }); // switchable after the start
  await assert.rejects(svc.updateSettings(id, ORG, { groupSize: 3 }), /locked/);

  const small = t.groups.find((g) => g.standings.length === 3);
  const before = t.matches.length;
  t = await svc.lateEntry(id, ORG, { name: 'Zed' });
  const zed = t.entries.find((e) => e.name === 'Zed');
  assert.equal(zed.group, small.no);
  assert.equal(zed.source, 'walk-in');
  const catchUp = t.matches.filter((m) => m.catchUp);
  assert.equal(t.matches.length, before + 3);
  assert.equal(catchUp.length, 3);
  assert.ok(catchUp.every((m) => m.a.id === zed.id && m.group === small.no && m.status === 'scheduled'));
  // every pair in the group still meets exactly once
  const g = t.matches.filter((m) => m.stage === 'league' && m.group === small.no).map((m) => [m.a.id, m.b.id].sort().join('-'));
  assert.equal(new Set(g).size, g.length);
  assert.equal(g.length, 6); // 4 players -> 6 matches
  await assert.rejects(svc.lateEntry(id, ORG, { name: 'zed' }), /already entered/);
});

test('late entry in a knockout takes a bye; refused when the bracket is full', async () => {
  const { id } = await svc.createTournament(ORG, { visibility: 'public', name: 'Late Cup', format: 'knockout', lateEntry: true });
  await svc.addEntries(id, ORG, names(6)); // 8-draw, 2 byes (top 2 seeds)
  let t = await svc.start(id, ORG);
  assert.equal(t.matches.filter((m) => m.status === 'bye').length, 2);
  t = await svc.lateEntry(id, ORG, { name: 'Seven' });
  const m = t.matches.find((x) => x.catchUp);
  assert.equal(m.round, 1);
  assert.equal(m.status, 'scheduled');
  assert.deepEqual([m.a.name, m.b.name], ['P1', 'Seven']); // meets the top seed
  const semi = t.matches.find((x) => x.round === 2 && x.slot === 0);
  assert.equal(semi.a, null); // P1 no longer walks through
  t = await svc.lateEntry(id, ORG, { name: 'Eight' });
  await assert.rejects(svc.lateEntry(id, ORG, { name: 'Nine' }), /bracket is full/);
  // the latecomer's match plays normally and feeds the next round
  const r1 = t.matches.find((x) => x.catchUp && x.b.name === 'Eight');
  await play(id, r1.id, 'b');
  t = await svc.getTournament(id, ORG);
  assert.ok(t.matches.some((x) => x.round === 2 && [x.a?.name, x.b?.name].includes('Eight')));
});

test('withdraw: remaining matches become walkovers that count as wins but not games/points', async () => {
  const { id } = await svc.createTournament(ORG, { visibility: 'public', name: 'Withdraw League', format: 'league', groups: 1 });
  await svc.addEntries(id, ORG, ['A', 'B', 'C', 'D']);
  let t = await svc.start(id, ORG);
  const ab = t.matches.find((m) => [m.a.name, m.b.name].sort().join() === 'A,B');
  await play(id, ab.id, ab.a.name === 'A' ? 'a' : 'b'); // A beats B properly
  const d = t.entries.find((e) => e.name === 'D');
  t = await svc.withdraw(id, ORG, d.id);
  const wos = t.matches.filter((m) => m.walkover);
  assert.equal(wos.length, 3);
  assert.ok(wos.every((m) => m.winner !== d.id && m.summary === 'Walkover'));
  const table = t.groups[0].standings;
  const rowA = table.find((r) => r.name === 'A');
  assert.equal(rowA.won, 2); // beat B + walkover vs D
  assert.equal(rowA.gamesFor, 2); // only the real match counts
  assert.equal(rowA.pointsFor, 42);
  assert.equal(table.find((r) => r.name === 'D').withdrawn, true);
  await assert.rejects(svc.undo(id, ORG, wos[0].id), /Walkovers can't be undone/);
  await assert.rejects(svc.withdraw(id, ORG, d.id), /already withdrawn/);
  await assert.rejects(svc.redraw(id, ORG), /before the first point/);
  // finishing the remaining real matches completes the league
  for (const m of t.matches.filter((x) => x.status === 'scheduled')) await play(id, m.id);
  assert.equal((await svc.getTournament(id)).status, 'completed');
});

test('withdraw in a knockout: opponent goes through, now or when they arrive', async () => {
  const { id } = await svc.createTournament(ORG, { visibility: 'public', name: 'Withdraw Cup', format: 'knockout' });
  await svc.addEntries(id, ORG, names(4)); // semis: P1 v P4, P2 v P3
  let t = await svc.start(id, ORG);
  const [s1, s2] = t.matches.filter((m) => m.round === 1);
  await play(id, s1.id, 'a'); // P1 into the final, opponent not decided yet
  const p1 = t.entries.find((e) => e.name === 'P1');
  t = await svc.withdraw(id, ORG, p1.id);
  let final = t.matches.find((m) => m.round === 2);
  assert.equal(final.status, 'scheduled'); // waiting for the other semi
  await play(id, s2.id, 'b'); // P3 wins the other semi -> walks over P1 in the final
  t = await svc.getTournament(id);
  final = t.matches.find((m) => m.round === 2);
  assert.equal(final.walkover, true);
  assert.equal(t.status, 'completed');
  assert.equal(t.champion.name, 'P3');
});

test('withdrawn players are skipped when the knockout is drawn from the groups', async () => {
  const { id } = await svc.createTournament(ORG, { visibility: 'public', name: 'Skip Withdrawn', groups: 2, qualifiers: 1 });
  await svc.addEntries(id, ORG, names(6));
  let t = await svc.start(id, ORG);
  // P1 tops group A, then withdraws before the knockout
  for (const m of t.matches) {
    const p1side = m.a.name === 'P1' ? 'a' : m.b.name === 'P1' ? 'b' : null;
    await play(id, m.id, p1side || 'a');
  }
  t = await svc.getTournament(id, ORG);
  const p1 = t.entries.find((e) => e.name === 'P1');
  assert.equal(t.groups[p1.group].standings[0].name, 'P1');
  await svc.withdraw(id, ORG, p1.id);
  t = await svc.startKnockout(id, ORG);
  const finalists = t.matches.filter((m) => m.stage === 'knockout').flatMap((m) => [m.a?.name, m.b?.name]);
  assert.ok(!finalists.includes('P1'));
});
