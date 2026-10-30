'use strict';

// The day-before reminders: everyone in something tomorrow (India time) is
// told once: tournament players and organisers, race and meet entrants,
// group players who said they're in, and club runners going. Nothing for
// things the day after, withdrawn entries, or people who said they're out.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const { createCron } = require('../server/cron');

let db;
let svc;
let cron;
const mail = [];
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  svc = createApp(db, { mailer: { enabled: true, async send(m) { mail.push(m); return { sent: true }; } } }).service;
  cron = createCron({ db, svc, fail: (s, m) => { throw new Error(m); }, env: { CRON_SECRET: 'r' } });
});
test.after(async () => { await db.close(); });

const run = () => cron.run('reminders', { headers: { authorization: 'Bearer r' } }, null);
let n = 0;
async function user(name) {
  n += 1;
  const [u] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'x') RETURNING id, email, name`, [`${name.toLowerCase().replace(/\W/g, '')}${n}@remind.test`, name]);
  return { ...u, actor: { user: { ...u, isAdmin: false } } };
}
// Tomorrow and the day after, in India, as dates and as 7 am timestamps.
const ist = (days) => new Date(Date.now() + 5.5 * 3600000 + days * 86400000).toISOString().slice(0, 10);
const at7 = (day) => new Date(`${day}T07:00:00+05:30`).toISOString();
const inbox = (id) => db.query(`SELECT title, body, url FROM notifications WHERE user_id = $1 AND kind = 'reminder' ORDER BY id`, [id]);

test('reminders the day before, once each', async () => {
  const tomorrow = ist(1);
  const later = ist(2);
  const org = await user('Remind Organiser');
  const asha = await user('Asha Player');
  const ravi = await user('Ravi Withdrew');
  const runner = await user('Meena Runner');
  const lazy = await user('Lazy Out');

  // A tournament tomorrow, and one the day after.
  const { id } = await svc.createTournament(org.actor, { name: 'Chennai Smash', venue: 'Anna Nagar Indoor', startsOn: tomorrow, startTime: '07:30', events: [{ discipline: 'singles', gender: 'open' }] });
  await svc.addEntries(id, org.actor, ['Asha Player', 'Ravi Withdrew', 'Walk In']);
  const t = await svc.getTournament(id, org.actor);
  await svc.setEntryPlayers(id, org.actor, t.entries[0].id, { players: [{ name: 'Asha Player', email: asha.email }] });
  await svc.setEntryPlayers(id, org.actor, t.entries[1].id, { players: [{ name: 'Ravi Withdrew', email: ravi.email }] });
  await db.query('UPDATE entries SET withdrawn = true WHERE id = $1', [t.entries[1].id]);
  const { id: id2 } = await svc.createTournament(org.actor, { name: 'Next Week Cup', startsOn: later, events: [{ discipline: 'singles', gender: 'open' }] });
  await svc.addEntries(id2, org.actor, ['Asha Player']);

  // A race tomorrow with Meena entered.
  const [race] = await db.query(`INSERT INTO races (name, starts_at, place, created_by) VALUES ('Marina 10K', $1, 'Marina Beach', $2) RETURNING id`, [at7(tomorrow), org.id]);
  const [rev] = await db.query(`INSERT INTO race_events (race_id, name, distance_m) VALUES ($1, '10K', 10000) RETURNING id`, [race.id]);
  await db.query(`INSERT INTO race_entries (race_id, event_id, user_id, name, bib) VALUES ($1, $2, $3, 'Meena Runner', 101)`, [race.id, rev.id, runner.id]);

  // A group session tomorrow: Asha's in, Lazy's out.
  const [g] = await db.query(`INSERT INTO groups (slug, name, sport, venue, invite_token, settings) VALUES ('dawn-smashers', 'Dawn Smashers', 'badminton', 'YMCA', 'tok', '{}') RETURNING id`);
  const [sess] = await db.query('INSERT INTO group_sessions (group_id, starts_at) VALUES ($1, $2) RETURNING id', [g.id, at7(tomorrow)]);
  await db.query(`INSERT INTO session_players (session_id, user_id, status) VALUES ($1, $2, 'in'), ($1, $3, 'out')`, [sess.id, asha.id, lazy.id]);

  // A club run on tomorrow's weekday: Meena's going.
  const [o] = await db.query(`INSERT INTO orgs (slug, name, kind) VALUES ('marina-runners', 'Marina Runners', 'club') RETURNING id`);
  const [cr] = await db.query(`INSERT INTO club_runs (org_id, name, weekday, at_time, place) VALUES ($1, 'Sunday long run', EXTRACT(DOW FROM $2::date), '05:30', 'Lighthouse') RETURNING id`, [o.id, tomorrow]);
  await db.query('INSERT INTO club_run_people (club_run_id, on_date, user_id, going) VALUES ($1, $2, $3, true)', [cr.id, tomorrow, runner.id]);

  const r = await run();
  assert.equal(r.day, tomorrow);
  assert.deepEqual([r.tournaments, r.races, r.meets, r.groups, r.clubRuns], [2, 1, 0, 1, 1]);
  assert.deepEqual(await inbox(asha.id), [
    { title: 'Tomorrow: Chennai Smash', body: '7:30 am at Anna Nagar Indoor. Good luck!', url: `/t/${id}` },
    { title: 'Tomorrow: Dawn Smashers', body: '7 am at YMCA. You said you\'re in.', url: '/g/dawn-smashers' },
  ]);
  assert.deepEqual((await inbox(org.id)).map((x) => x.body), ['2 entries · 7:30 am at Anna Nagar Indoor. Check-in, the draw and courts are on the tournament page.']);
  assert.deepEqual((await inbox(runner.id)).map((x) => x.title), ['Tomorrow: Marina 10K', 'Tomorrow: Marina Runners · Sunday long run']);
  assert.equal((await inbox(runner.id))[1].body, '5:30 am at Lighthouse. See you there!');
  assert.deepEqual(await inbox(ravi.id), [], 'withdrawn: not reminded');
  assert.deepEqual(await inbox(lazy.id), [], 'said out: not reminded');
  // Emailed too (reminders are on for email by default).
  assert.ok(mail.some((m) => m.to === asha.email && m.subject === 'Tomorrow: Chennai Smash'));

  // Running again the same day tells nobody twice.
  const again = await run();
  assert.deepEqual([again.tournaments, again.races, again.groups, again.clubRuns], [0, 0, 0, 0]);
});
