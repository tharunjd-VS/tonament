'use strict';

// The on-the-day assistant: Claude's reading becomes proposals checked
// against the tournament (nothing changes yet); placement comes from the
// late-arrival policy, not Claude; approval applies them through the
// app's own actions, refuses stale proposals, and logs each one. Claude
// sees names and statuses, never contact details.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

let reply = null;
let lastReq = null;
const client = { beta: { messages: { async create(req) {
  lastReq = req;
  return { model: req.model, stop_reason: 'end_turn', usage: { input_tokens: 500, output_tokens: 80 }, content: [{ type: 'text', text: JSON.stringify(reply) }] };
} } } };
const act = (type, x = {}) => ({ type, entryId: null, eventId: null, name: null, paidHow: null, matchId: null, quote: '', ...x });

let db;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  svc = createApp(db, { aiClient: client, mailer: { enabled: false, async send() {} } }).service;
});
test.after(() => db.close());

test('before the draw: check-ins, a new entry and a payment, proposed then approved', async () => {
  const [u] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('asst@a.test', 'Asst Org', 'x') RETURNING id, email, name`);
  const org = { user: { ...u, isAdmin: false } };
  const { id } = await svc.createTournament(org, { name: 'Assist Cup', format: 'league_knockout', groups: 2, qualifiers: 1, events: [{ discipline: 'singles', gender: 'open' }] });
  await svc.addEntries(id, org, ['Ravi', 'Kiran', 'Asha', 'Meena']);
  let t = await svc.getTournament(id, org);
  const by = (name) => t.entries.find((e) => e.name === name);
  reply = {
    summary: 'Ravi and Kiran are here; Priya is new.',
    questions: ['Which Meena — there are two?'],
    actions: [act('check_in', { entryId: by('Ravi').id, quote: 'Ravi' }), act('arrived', { entryId: by('Kiran').id }), act('add_entry', { eventId: t.eventId, name: 'Priya' }),
      act('add_entry', { eventId: t.eventId, name: 'asha' }), act('check_in', { entryId: 99999 })],
  };
  const p = await svc.assistant.propose(id, org, { text: 'Ravi and Kiran are here, new girl Priya wants to play' });
  // Claude sees names and statuses only.
  const sent = lastReq.messages[0].content.map((c) => c.text || '').join('');
  assert.match(sent, /Entry \d+: Ravi \(not checked in\)/);
  assert.doesNotMatch(sent, /@|phone/i);
  assert.match(lastReq.system, /Never decide which group/);
  assert.deepEqual(p.proposals.map((x) => [x.type, x.allowed]), [['check_in', true], ['check_in', true], ['add_entry', true], ['add_entry', false], ['check_in', false]]);
  assert.match(p.proposals[3].why, /already entered/);
  assert.deepEqual(p.questions, ['Which Meena — there are two?']);
  // Nothing has changed yet.
  t = await svc.getTournament(id, org);
  assert.equal(by('Ravi').checkedIn, false);
  const r = await svc.assistant.apply(id, org, { version: p.version, request: p.request, proposals: p.proposals.slice(0, 3) });
  assert.deepEqual(r.results.map((x) => x.ok), [true, true, true]);
  t = r.tournament;
  assert.equal(by('Ravi').checkedIn, true);
  assert.equal(by('Kiran').checkedIn, true);
  assert.ok(by('Priya'));
  // The old proposals are stale now.
  await assert.rejects(svc.assistant.apply(id, org, { version: p.version, proposals: p.proposals.slice(0, 1) }), (e) => e.status === 409 && e.code === 'stale');
  const log = await svc.assistant.log(id, org);
  assert.equal(log.items.length, 3);
  assert.ok(log.items.every((x) => x.ok && x.by === 'Asst Org'));
  // Only organisers.
  const [v] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('viewer@a.test', 'Viewer', 'x') RETURNING id, email, name`);
  await assert.rejects(svc.assistant.propose(id, { user: { ...v, isAdmin: false } }, { text: 'x' }), (e) => [403, 404].includes(e.status));
});

test('after the draw: an arrival goes where the policy says; late; walkover only past the grace time', async () => {
  const [u] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('asst2@a.test', 'Asst Two', 'x') RETURNING id, email, name`);
  const org = { user: { ...u, isAdmin: false } };
  const { id } = await svc.createTournament(org, { name: 'Assist Day', format: 'league_knockout', groups: 2, qualifiers: 1, events: [{ discipline: 'singles', gender: 'open' }] });
  await svc.updateSettings(id, org, { lateEntry: true, latePolicy: { lateUntil: 'groups', groupChoice: 'even', graceMinutes: 10 } });
  await svc.addEntries(id, org, ['A1', 'A2', 'A3', 'A4', 'B1', 'B2', 'B3', 'Absent']);
  let t = await svc.getTournament(id, org);
  for (const e of t.entries.filter((x) => x.name !== 'Absent')) await svc.checkIn(id, org, e.id, true);
  await svc.start(id, org);
  t = await svc.getTournament(id, org);
  const by = (name) => t.entries.find((e) => e.name === name);
  const m = t.matches.find((x) => x.status === 'scheduled' && x.a && x.b);
  reply = { summary: '', questions: [], actions: [act('arrived', { entryId: by('Absent').id }), act('add_entry', { eventId: t.eventId, name: 'Walk In' }), act('not_here', { entryId: m.a.id }), act('walkover', { matchId: m.id, entryId: m.a.id })] };
  let p = await svc.assistant.propose(id, org, { text: 'Absent made it; Walk In wants to play; first player is missing' });
  const [arr, walk, late, wo] = p.proposals;
  assert.equal(arr.allowed, true);
  assert.match(arr.effect, /Group/);
  assert.match(arr.why, /even/);
  assert.equal(walk.allowed, true);
  assert.equal(late.allowed, true);
  assert.equal(wo.allowed, false, 'not late yet');
  const r = await svc.assistant.apply(id, org, { version: p.version, proposals: [arr, late] });
  assert.deepEqual(r.results.map((x) => x.ok), [true, true]);
  t = r.tournament;
  assert.equal(by('Absent').inDraw, true);
  assert.ok(by(m.a.name).awaySince);
  // 11 minutes later, the walkover is due under the policy.
  await db.query(`UPDATE entries SET away_since = now() - interval '11 minutes' WHERE id = $1`, [m.a.id]);
  reply = { summary: '', questions: [], actions: [act('walkover', { matchId: m.id, entryId: m.a.id })] };
  p = await svc.assistant.propose(id, org, { text: 'still not here' });
  assert.equal(p.proposals[0].allowed, true);
  assert.match(p.proposals[0].label, new RegExp(`Walkover to ${m.b.name}`));
  await svc.assistant.apply(id, org, { version: p.version, proposals: p.proposals });
  t = await svc.getTournament(id, org);
  const done = t.matches.find((x) => x.id === m.id);
  assert.deepEqual([done.status, done.walkover, done.winner], ['done', true, m.b.id]);
});

test('credits: Manage credits per message (3 for a photo); none left is a 402', async () => {
  const ENV = { RAZORPAY_KEY_ID: 'rzp_test_AS', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' };
  Object.assign(process.env, ENV);
  try {
    const [u] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('asst3@a.test', 'Asst Three', 'x') RETURNING id, email, name`);
    const org = { user: { ...u, isAdmin: false } };
    const { id } = await svc.createTournament(org, { name: 'Paid Assist', format: 'league_knockout', groups: 1, qualifiers: 1, events: [{ discipline: 'singles', gender: 'open' }] });
    reply = { summary: '', questions: [], actions: [] };
    await assert.rejects(svc.assistant.propose(id, org, { text: 'hi' }), (e) => e.status === 402 && e.code === 'ai_credits');
    await svc.credits.grantPack(db.query, { pack: 'manage', tournament: id, reason: 'test', ref: `t:${id}` });
    await svc.assistant.propose(id, org, { text: 'hi' });
    await svc.assistant.propose(id, org, { image: 'data:image/jpeg;base64,AAAA' });
    const b = await svc.credits.balance(db.query, { user: u.id, tournament: id });
    assert.equal(b.manage.tournament, 150 - 1 - 3);
  } finally { for (const k of Object.keys(ENV)) delete process.env[k]; }
});

test('undo: within the window, last first; a late placement only until a catch-up match is played', async () => {
  const [u] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('undo@a.test', 'Undo Org', 'x') RETURNING id, email, name`);
  const org = { user: { ...u, isAdmin: false } };
  const { id } = await svc.createTournament(org, { name: 'Undo Cup', format: 'league_knockout', groups: 2, qualifiers: 1, events: [{ discipline: 'singles', gender: 'open' }] });
  await svc.updateSettings(id, org, { lateEntry: true });
  await svc.addEntries(id, org, ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'Missed']);
  let t = await svc.getTournament(id, org);
  for (const e of t.entries.filter((x) => x.name !== 'Missed')) await svc.checkIn(id, org, e.id, true);
  await svc.start(id, org);
  t = await svc.getTournament(id, org);
  const by = (name) => t.entries.find((e) => e.name === name);
  const late = t.entries.find((e) => e.name === 'A1');
  reply = { summary: '', questions: [], actions: [act('arrived', { entryId: by('Missed').id }), act('add_entry', { eventId: t.eventId, name: 'Newbie' }), act('not_here', { entryId: late.id })] };
  let p = await svc.assistant.propose(id, org, { text: 'x' });
  let r = await svc.assistant.apply(id, org, { version: p.version, proposals: p.proposals });
  assert.ok(r.batch);
  const matchesBefore = r.tournament.matches.length;
  const u1 = await svc.assistant.undo(id, org, { batch: r.batch });
  assert.deepEqual(u1.results.map((x) => x.ok), [true, true, true]);
  t = u1.tournament;
  assert.equal(by('Missed').inDraw, false);
  assert.equal(t.entries.some((e) => e.name === 'Newbie'), false);
  assert.equal(by('A1').awaySince, null);
  assert.ok(t.matches.length < matchesBefore, 'the catch-up matches went');
  await assert.rejects(svc.assistant.undo(id, org, { batch: r.batch }), (e) => e.status === 404);
  // Again; this time a catch-up match is played before the undo.
  reply = { summary: '', questions: [], actions: [act('arrived', { entryId: by('Missed').id })] };
  p = await svc.assistant.propose(id, org, { text: 'x' });
  r = await svc.assistant.apply(id, org, { version: p.version, proposals: p.proposals });
  const cu = r.tournament.matches.find((m) => m.catchUp && m.status === 'scheduled');
  await svc.setResult(id, org, cu.id, [{ a: 21, b: 10 }, { a: 21, b: 12 }], 0);
  const u2 = await svc.assistant.undo(id, org, { batch: r.batch });
  assert.equal(u2.results[0].ok, false);
  assert.match(u2.results[0].result, /catch-up match/);
  // Too late: past the window.
  reply = { summary: '', questions: [], actions: [act('not_here', { entryId: by('B1').id })] };
  p = await svc.assistant.propose(id, org, { text: 'x' });
  r = await svc.assistant.apply(id, org, { version: p.version, proposals: p.proposals });
  await db.query(`UPDATE ai_actions SET created_at = now() - interval '11 minutes' WHERE batch = $1`, [r.batch]);
  await assert.rejects(svc.assistant.undo(id, org, { batch: r.batch }), /10 minutes/);
});

test('pairing two solos before the draw; a walk-in takes a no-show\'s place (policy permitting), and undo puts them back', async () => {
  const [u] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('pair@a.test', 'Pair Org', 'x') RETURNING id, email, name`);
  const org = { user: { ...u, isAdmin: false } };
  const { id } = await svc.createTournament(org, { name: 'Pair Cup', visibility: 'public', format: 'knockout', events: [{ discipline: 'doubles', gender: 'open' }] });
  const ASHA = { user: { id: 7001, email: 'asha@pair.test', name: 'Asha Pair', isAdmin: false } };
  const EVA = { user: { id: 7002, email: 'eva@pair.test', name: 'Eva Pair', isAdmin: false } };
  let t = await svc.getTournament(id, org);
  await svc.register(id, ASHA, { event: t.eventId, solo: true });
  await svc.register(id, EVA, { event: t.eventId, solo: true });
  await svc.addEntries(id, org, ['Ravi / Kiran', 'Sam / Tom', 'Raj / Dev']);
  t = await svc.getTournament(id, org);
  const solos = t.entries.filter((e) => e.solo);
  // The nudge offers the pairing; so can the assistant.
  const n = await svc.nudges(id, org);
  assert.equal(n.items[0].kind, 'solos');
  reply = { summary: '', questions: [], actions: [act('pair_solos', { entryId: solos[0].id, partnerId: solos[1].id })] };
  let p = await svc.assistant.propose(id, org, { text: 'pair Asha and Eva' });
  assert.equal(p.proposals[0].allowed, true);
  let r = await svc.assistant.apply(id, org, { version: p.version, proposals: p.proposals });
  assert.ok(r.tournament.entries.some((e) => e.name === 'Asha Pair / Eva Pair'));
  await svc.assistant.undo(id, org, { batch: r.batch });
  t = await svc.getTournament(id, org);
  assert.equal(t.entries.filter((e) => e.solo).length, 2);
  // After the draw: Sam / Tom don't turn up; Leo / Max play instead.
  for (const e of t.entries.filter((x) => x.solo)) await svc.removeEntry(id, org, e.id);
  for (const e of t.entries.filter((x) => !x.solo)) await svc.checkIn(id, org, e.id, true);
  await svc.start(id, org);
  t = await svc.getTournament(id, org);
  const sam = t.entries.find((e) => e.name === 'Sam / Tom');
  reply = { summary: '', questions: [], actions: [act('replace', { entryId: sam.id, name: 'Leo / Max' })] };
  p = await svc.assistant.propose(id, org, { text: 'Sam and Tom are not coming, Leo and Max will play' });
  assert.equal(p.proposals[0].allowed, true);
  r = await svc.assistant.apply(id, org, { version: p.version, proposals: p.proposals });
  const leo = r.tournament.entries.find((e) => e.id === sam.id);
  assert.deepEqual([leo.name, leo.source], ['Leo / Max', 'walk-in']);
  await svc.assistant.undo(id, org, { batch: r.batch });
  t = await svc.getTournament(id, org);
  assert.equal(t.entries.find((e) => e.id === sam.id).name, 'Sam / Tom');
  // Policy off: no.
  await svc.updateSettings(id, org, { latePolicy: { replaceNoShow: false } });
  await assert.rejects(svc.replaceEntry(id, org, sam.id, { name: 'Leo / Max' }), /policy/);
  assert.equal((await svc.getTournament(id, org)).config.latePolicy.graceMinutes, 15, 'a partial policy change keeps the rest');
});

test('umpires leave notes for the organisers; nudges for players late past the grace time', async () => {
  const [u] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('note@a.test', 'Note Org', 'x') RETURNING id, email, name`);
  const [ump] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('ump@a.test', 'Umpire Uma', 'x') RETURNING id, email, name`);
  const org = { user: { ...u, isAdmin: false } };
  const umpire = { user: { ...ump, isAdmin: false } };
  const { id } = await svc.createTournament(org, { name: 'Note Cup', format: 'league', events: [{ discipline: 'singles', gender: 'open' }] });
  await svc.addMember(id, org, { email: 'ump@a.test', role: 'umpire' });
  await svc.addEntries(id, org, ['P1', 'P2', 'P3']);
  let t = await svc.getTournament(id, org);
  for (const e of t.entries) await svc.checkIn(id, org, e.id, true);
  await svc.start(id, org);
  await svc.addNote(id, umpire, { text: 'Court 1: P1 is not here' });
  const [{ n }] = await db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'umpire_note'`, [u.id]);
  assert.equal(n, 1);
  const list = await svc.notes(id, org);
  assert.deepEqual(list.items.map((x) => [x.by, x.text]), [['Umpire Uma', 'Court 1: P1 is not here']]);
  await assert.rejects(svc.notes(id, umpire), (e) => e.status === 403);
  await svc.closeNote(id, org, list.items[0].id);
  assert.equal((await svc.notes(id, org)).items.length, 0);
  // P1 marked late 20 minutes ago: a walkover (or a stand-in) is suggested.
  t = await svc.getTournament(id, org);
  const p1 = t.entries.find((e) => e.name === 'P1');
  await svc.setAway(id, org, p1.id, true);
  assert.equal((await svc.nudges(id, org)).items.length, 0, 'not yet');
  await db.query(`UPDATE entries SET away_since = now() - interval '20 minutes' WHERE id = $1`, [p1.id]);
  const items = (await svc.nudges(id, org)).items;
  assert.equal(items[0].kind, 'late');
  assert.match(items[0].text, /P1 is 20 minutes late/);
  assert.deepEqual(items[0].actions.map((x) => x.action), ['walkover', 'replace', 'wait']);
});
