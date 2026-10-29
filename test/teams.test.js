'use strict';

// Team rosters (a captain and players linked by email, so results go on
// their profiles) and entry fees marked per player, for teams and pairs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const { playerFor, enterAs } = require('./players');

let db;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  svc = createApp(db).service;
});
test.after(() => db.close());
const enter = (...args) => enterAs(svc)(...args);
const ORG = { user: { id: 1, email: 'teams@club.test', name: 'Org', isAdmin: false } };

async function teamEvent(name, extra = {}) {
  const { id } = await svc.createTournament(ORG, { name, sport: 'football', format: 'knockout', visibility: 'public', events: [{ discipline: 'team', gender: 'open' }], ...extra });
  return id;
}

test('a captain enters a team, then the captain (or the organiser) links the players', async () => {
  const id = await teamEvent('Sunday Cup');
  await enter(id, { name: 'Velachery FC', contact: 'cap@team.test', players: 'Arun\nBala\nCharan' });
  const captain = playerFor({ contact: 'cap@team.test' });
  let t = await svc.getTournament(id, ORG);
  const team = t.entries.find((e) => e.name === 'Velachery FC');
  // The captain (their account name; the test account is named after the team) heads the roster, then the players listed.
  assert.deepEqual(team.people.map((p) => [p.name, Boolean(p.captain)]), [['Velachery FC', true], ['Arun', false], ['Bala', false], ['Charan', false]]);
  // The captain sees emails in the roster editor; a stranger can't.
  let r = await svc.getRoster(id, captain, team.id);
  assert.equal(r.players[0].email, 'cap@team.test');
  await assert.rejects(svc.getRoster(id, playerFor({ contact: 'other@x.test' }), team.id), /captain/);
  await svc.setRoster(id, captain, team.id, { players: [
    { name: 'Senthil', email: 'cap@team.test', captain: true },
    { name: 'Arun', email: 'arun@team.test' },
    { name: 'Bala' },
    { name: 'Charan', email: 'charan@team.test' },
    { name: 'Dev' },
  ] });
  r = await svc.getRoster(id, ORG, team.id);
  assert.deepEqual(r.players.map((p) => p.name), ['Senthil', 'Arun', 'Bala', 'Charan', 'Dev']);
  await assert.rejects(svc.setRoster(id, captain, team.id, { players: [{ name: 'A', captain: true }, { name: 'B', captain: true }] }), /one captain/);
  await assert.rejects(svc.setRoster(id, captain, team.id, { players: [{ name: 'A' }, { name: 'a' }] }), /twice/);
  // The organiser can use the same list from the Players tab.
  t = await svc.setEntryPlayers(id, ORG, team.id, { players: [...r.players, { name: 'Ezhil', email: 'ezhil@team.test' }] });
  assert.equal(t.entries.find((e) => e.id === team.id).people.length, 6);
  // Results go to every linked player when the event finishes.
  await svc.addEntries(id, ORG, ['Adyar United']);
  t = await svc.start(id, ORG);
  const final = t.matches.find((m) => m.round === 1);
  await svc.setResult(id, ORG, final.id, [{ a: 2, b: 1 }]);
  const results = await db.query('SELECT email FROM event_results WHERE entry_id = $1 ORDER BY email', [team.id]);
  assert.deepEqual(results.map((x) => x.email), ['arun@team.test', 'cap@team.test', 'charan@team.test', 'ezhil@team.test']);
});

test('fees per player: mark each player; the team is paid when everyone is settled', async () => {
  const id = await teamEvent('Paid Cup');
  const ev = (await svc.getTournament(id, ORG)).eventId;
  await svc.updateEvent(id, ORG, ev, { fee: 200000 }); // ₹2,000 a team
  await enter(id, { name: 'Kings XI', contact: 'kcap@team.test', players: 'P1\nP2\nP3' });
  let t = await svc.getTournament(id, ORG);
  let team = t.entries.find((e) => e.name === 'Kings XI');
  assert.equal(team.feeStatus, 'due');
  assert.equal(team.people.length, 4);
  for (const slot of [0, 1, 2]) t = await svc.setMemberFee(id, ORG, team.id, slot, 'paid');
  team = t.entries.find((e) => e.id === team.id);
  assert.equal(team.feeStatus, 'due');
  assert.deepEqual(team.people.map((p) => p.feeStatus), ['paid', 'paid', 'paid', null]);
  t = await svc.setMemberFee(id, ORG, team.id, 3, 'waived');
  team = t.entries.find((e) => e.id === team.id);
  assert.deepEqual([team.feeStatus, team.feeAmount, team.confirmed], ['received', 150000, true]); // 3 x ₹500
  // Unmark one: due again.
  t = await svc.setMemberFee(id, ORG, team.id, 1, null);
  assert.equal(t.entries.find((e) => e.id === team.id).feeStatus, 'due');
  // Marking the whole team paid settles every player.
  t = await svc.setEntryFee(id, ORG, team.id, 'cash');
  assert.ok(t.entries.find((e) => e.id === team.id).people.every((p) => p.feeStatus));
  // Players only see that the team is paid, not who paid.
  const pub = await svc.getTournament(id, null);
  assert.equal(pub.entries.find((e) => e.id === team.id).people[1].feeStatus, undefined);
  await assert.rejects(svc.setMemberFee(id, playerFor({ contact: 'kcap@team.test' }), team.id, 0, 'paid'), /permission|organis|can't|cannot|Only/i);
});

test('a team fee per player, and pairs split the fee', async () => {
  const id = await teamEvent('Per Player Cup');
  const ev = (await svc.getTournament(id, ORG)).eventId;
  await svc.updateEvent(id, ORG, ev, { fee: 20000, feePer: 'player' }); // ₹200 a player
  await enter(id, { name: 'Strikers', contact: 'scap@team.test', players: 'A\nB\nC\nD' });
  let t = await svc.getTournament(id, ORG);
  assert.equal(t.entries.find((e) => e.name === 'Strikers').feeAmount, 100000); // 5 players
  // A sixth player: the team owes ₹1,200.
  const strikers = t.entries.find((e) => e.name === 'Strikers');
  const roster = await svc.getRoster(id, ORG, strikers.id);
  t = await svc.setRoster(id, ORG, strikers.id, { players: [...roster.players, { name: 'E' }] });
  assert.equal(t.entries.find((e) => e.id === strikers.id).feeAmount, 120000);
  assert.equal(t.config.feePer, 'player');

  // Badminton doubles added by name: each partner can be marked.
  const { id: d } = await svc.createTournament(ORG, { name: 'Pairs Night', sport: 'badminton', events: [{ discipline: 'doubles', gender: 'men' }] });
  const dev = (await svc.getTournament(d, ORG)).eventId;
  await svc.updateEvent(d, ORG, dev, { fee: 60000 });
  await assert.rejects(svc.updateEvent(d, ORG, dev, { feePer: 'player' }), /team events/);
  await svc.addEntries(d, ORG, ['Asha / Ben']);
  t = await svc.getTournament(d, ORG);
  const pair = t.entries[0];
  t = await svc.setMemberFee(d, ORG, pair.id, 0, 'paid');
  assert.deepEqual(t.entries[0].people.map((p) => [p.name, p.feeStatus]), [['Asha', 'paid'], ['Ben', null]]);
  t = await svc.setMemberFee(d, ORG, pair.id, 1, 'paid');
  assert.deepEqual([t.entries[0].feeStatus, t.entries[0].feeAmount], ['received', 60000]);
});
