'use strict';

// Templates and new tournaments from old ones: a tournament's events and
// settings saved and reused (never its dates, entries or results); one
// event's settings copied to others; and a new edition telling last time's
// players it's back.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

let db;
let svc;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  svc = createApp(db, { mailer: { enabled: false, async send() {} } }).service;
});
test.after(async () => { await db.close(); });

let n = 0;
async function user(name) {
  n += 1;
  const [u] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'x') RETURNING id, email, name`, [`${name.toLowerCase().replace(/\W/g, '')}${n}@tpl.test`, name]);
  return { ...u, actor: { user: { ...u, isAdmin: false } } };
}
const events = (id) => db.query('SELECT id, name, discipline, gender, format, config, status FROM events WHERE tournament_id = $1 ORDER BY position, id', [id]);
const eventsByName = async (id) => Object.fromEntries((await events(id)).map((e) => [e.name || `${e.gender} ${e.discipline}`, e]));

async function setUp(org) {
  const { id } = await svc.createTournament(org.actor, {
    name: 'Diwali Open 2025', sport: 'badminton', venue: 'Anna Nagar Indoor', city: 'Chennai', startsOn: '2025-11-01', startTime: '08:00',
    events: [{ discipline: 'doubles', gender: 'men' }, { discipline: 'doubles', gender: 'women' }, { discipline: 'singles', gender: 'men' }],
  });
  const [md] = await events(id);
  await svc.updateEvent(id, org.actor, md.id, {
    format: 'knockout', scoring: { points: 15, cap: 21, bestOf: 3 }, fee: 60000, partners: 'drawn', balancePairs: true, maxEntries: 16,
    prizes: [{ place: 'winner', cash: 3000 }, { place: 'runner-up', reward: 'Shuttles' }],
  });
  return { id, md };
}

test('copy one event\'s settings to others: what fits is copied, the rest left and reported', async () => {
  const org = await user('Copy Organiser');
  const { id, md } = await setUp(org);
  const all = await events(id);
  const [, wd, ms] = all;
  const r = await svc.copyEventSettings(id, org.actor, md.id, { to: [wd.id, ms.id] });
  const after = await events(id);
  for (const e of after) {
    assert.equal(e.format, 'knockout', e.discipline);
    assert.equal(e.config.fee, 60000);
    assert.equal(e.config.maxEntries, 16);
    assert.equal(e.config.scoring.points, 15);
    assert.deepEqual(e.config.prizes.map((p) => p.place), ['winner', 'runner-up']);
  }
  assert.equal(after[1].config.partners, 'drawn', 'doubles takes the partners setting');
  assert.equal(after[1].config.balancePairs, true);
  assert.notEqual(after[2].config.partners, 'drawn', 'singles doesn\'t');
  assert.deepEqual(r.skipped, ['drawn partners (Men\'s Singles)']);
  // Not to itself, not to an unknown event, not to one that's started.
  await assert.rejects(svc.copyEventSettings(id, org.actor, md.id, { to: [md.id] }), /Event not found/);
  await assert.rejects(svc.copyEventSettings(id, org.actor, md.id, { to: [] }), /Pick the events/);
  await svc.addEntries(id, org.actor, ['A', 'B', 'C', 'D'], { event: ms.id });
  await svc.start(id, org.actor, { event: ms.id });
  await assert.rejects(svc.copyEventSettings(id, org.actor, md.id, { to: [ms.id] }), /has started/);
  // Only those who manage the tournament.
  const other = await user('Not Organiser');
  await assert.rejects(svc.copyEventSettings(id, other.actor, md.id, { to: [wd.id] }), /403|can't|only|organis/i);
});

test('templates: save, list, rename, delete; a tournament from one has the setup and nothing else', async () => {
  const org = await user('Template Organiser');
  const { id, md } = await setUp(org);
  await svc.addEntries(id, org.actor, ['Pair One', 'Pair Two'], { event: md.id });
  const tpl = await svc.saveTemplate(id, org.actor, { name: 'Diwali Open' });
  assert.equal(tpl.name, 'Diwali Open');
  assert.deepEqual(tpl.events, ["Men's Doubles", "Women's Doubles", "Men's Singles"]);
  assert.equal(tpl.venue, 'Anna Nagar Indoor');
  assert.equal((await svc.myTemplates(org.actor)).templates.length, 1);
  assert.equal((await svc.renameTemplate(tpl.id, org.actor, { name: 'Diwali Classic' })).name, 'Diwali Classic');

  const made = await svc.createTournament(org.actor, { name: 'Diwali Classic 2026', from: { template: tpl.id }, startsOn: '2026-11-08' });
  const [t] = await db.query('SELECT * FROM tournaments WHERE id = $1', [made.id]);
  assert.equal(t.venue, 'Anna Nagar Indoor');
  assert.equal(t.city, 'Chennai');
  assert.equal(t.starts_on, '2026-11-08');
  assert.equal(t.start_time, '08:00', 'the day\'s start time carries over with a new date');
  assert.equal(t.visibility, 'private');
  const evs = await events(made.id);
  assert.deepEqual(evs.map((e) => e.status), ['setup', 'setup', 'setup']);
  assert.equal(evs[0].format, 'knockout');
  assert.equal(evs[0].config.fee, 60000);
  assert.equal(evs[0].config.partners, 'drawn');
  assert.equal(evs[0].config.prizes.length, 2);
  const [{ entries }] = await db.query('SELECT COUNT(*)::int AS entries FROM entries WHERE tournament_id = $1', [made.id]);
  assert.equal(entries, 0);
  const [{ owner }] = await db.query(`SELECT email AS owner FROM members WHERE tournament_id = $1 AND role = 'owner'`, [made.id]);
  assert.equal(owner, org.email);

  // Some of the events only; no date means no times either.
  const some = await svc.createTournament(org.actor, { name: 'Doubles Day', from: { template: tpl.id }, only: ["Men's Doubles", "Women's Doubles"] });
  assert.equal((await events(some.id)).length, 2);
  const [st] = await db.query('SELECT starts_on, start_time FROM tournaments WHERE id = $1', [some.id]);
  assert.deepEqual(st, { starts_on: null, start_time: null });

  // Someone else's template: not found. Deleting it.
  const other = await user('Template Stranger');
  await assert.rejects(svc.createTournament(other.actor, { name: 'Copycat', from: { template: tpl.id } }), /Template not found/);
  await assert.rejects(svc.renameTemplate(tpl.id, other.actor, { name: 'Mine' }), /Template not found/);
  assert.equal((await svc.deleteTemplate(tpl.id, org.actor)).templates.length, 0);
});

test('run it again: a new edition from a finished tournament, and last time\'s players are told once', async () => {
  const org = await user('Edition Organiser');
  const players = [await user('Arjun Edition'), await user('Rohan Edition'), await user('Karthik Edition')];
  const { id: old } = await svc.createTournament(org.actor, { name: 'Monsoon Smash 2025', sport: 'badminton', format: 'knockout', events: [{ discipline: 'singles', gender: 'men' }] });
  await svc.addEntries(old, org.actor, ['Arjun Edition', 'Rohan Edition', 'Karthik Edition', 'Walk In']);
  const t0 = await svc.getTournament(old, org.actor);
  for (const [i, p] of players.entries()) await svc.setEntryPlayers(old, org.actor, t0.entries[i].id, { players: [{ name: p.name, email: p.email }] });
  // Karthik turned these emails off; it still reaches his inbox.
  await db.query(`UPDATE users SET notify_prefs = '{"edition":{"email":false}}' WHERE id = $1`, [players[2].id]);

  const stranger = await user('Edition Stranger');
  await assert.rejects(svc.createTournament(stranger.actor, { name: 'Steal', from: { tournament: old } }), /403|organis|can't/i);
  const { id } = await svc.createTournament(org.actor, { name: 'Monsoon Smash 2026', from: { tournament: old }, startsOn: '2026-07-12' });
  const [t] = await db.query('SELECT config FROM tournaments WHERE id = $1', [id]);
  assert.equal(t.config.previous, old);
  // Private and not open: can't invite yet.
  await assert.rejects(svc.invitePrevious(id, org.actor, {}), /Publish the tournament first/);
  await svc.setVisibility(id, org.actor, 'public');
  const r = await svc.invitePrevious(id, org.actor, {});
  assert.deepEqual(r, { invited: 3, of: 3 });
  const inbox = await db.query(`SELECT user_id, title, url FROM notifications WHERE kind = 'edition' ORDER BY user_id`);
  assert.deepEqual(inbox.map((x) => x.user_id), players.map((p) => p.id));
  assert.equal(inbox[0].title, 'Monsoon Smash 2026 is on — Sun, 12 Jul');
  assert.equal(inbox[0].url, `/t/${id}`);
  // Again: nobody twice.
  assert.equal((await svc.invitePrevious(id, org.actor, {})).invited, 0);
});
