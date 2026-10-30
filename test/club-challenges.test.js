'use strict';

// Club v club: an admin challenges another club to a tie (racket sports) or a
// friendly (team sports); the other club's admins answer; accepting makes a
// link-only tournament with the two clubs; each club picks its team from its
// members; the finished match goes on both clubs' records and feeds.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

let db;
let svc;
let server;
let base;
test.before(async () => {
  db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  const app = createApp(db);
  svc = app.service;
  server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
});

let n = 0;
async function person(name) {
  n += 1;
  const res = await fetch(`${base}/api/auth/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ name, email: `${name.toLowerCase().replace(/\W/g, '')}${n}@cc.test`, password: 'password123' }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const { user } = await res.json();
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, Cookie: cookie }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
  return { ...user, call, actor: { user: { ...user, isAdmin: false } } };
}
// A club with an admin and `extra` members.
async function club(name, slug, sportsList, extra) {
  const admin = await person(`${name} Admin`);
  await svc.clubs.create(admin.actor, { name, slug, sports: sportsList });
  const members = [];
  for (let i = 0; i < extra; i++) {
    const p = await person(`${name} P${i}`);
    await p.call('POST', `/api/clubs/${slug}/join`, {});
    members.push(p);
  }
  return { admin, members, slug };
}
const win = [{ a: 21, b: 10 }, { a: 21, b: 12 }];
const lose = [{ a: 10, b: 21 }, { a: 12, b: 21 }];

test('a badminton tie between two clubs: challenge, accept, teams, line-ups, result on both records and feeds', async () => {
  const smash = await club('Smashpoint', 'smashpoint', ['badminton'], 3);
  const vel = await club('Velachery Smashers', 'velachery-smashers', ['badminton'], 3);
  const outsider = await person('Out Sider');
  // Only admins send; only the rival's admins answer.
  assert.equal((await smash.members[0].call('POST', '/api/clubs/smashpoint/club-challenges', { to: 'velachery-smashers', sport: 'badminton' })).status, 403);
  assert.equal((await smash.admin.call('POST', '/api/clubs/smashpoint/club-challenges', { to: 'smashpoint', sport: 'badminton' })).status, 400);
  assert.equal((await smash.admin.call('POST', '/api/clubs/smashpoint/club-challenges', { to: 'velachery-smashers', sport: 'chess' })).status, 400);
  let r = await smash.admin.call('POST', '/api/clubs/smashpoint/club-challenges', {
    to: 'https://tonament.com/club/velachery-smashers', sport: 'badminton', tie: { format: '2s1d' }, place: 'Smashpoint Arena', playAt: new Date(Date.now() + 86400000).toISOString(), message: 'Bring your best',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const cc = r.data;
  assert.deepEqual([cc.kind, cc.status, cc.tie.name, cc.need, cc.can.cancel, cc.can.respond], ['tie', 'sent', '2 singles + 1 doubles', 2, true, false]);
  const note = (await vel.admin.call('GET', '/api/notifications')).data.items.find((x) => x.kind === 'club_challenge');
  assert.equal(note.title, '⚔️ Smashpoint challenges Velachery Smashers');
  assert.equal((await vel.members[0].call('POST', `/api/club-challenges/${cc.id}/respond`, { accept: true })).status, 403);
  assert.equal((await smash.admin.call('POST', `/api/club-challenges/${cc.id}/respond`, { accept: true })).status, 403);
  assert.equal((await fetch(`${base}/img/cc/${cc.id}.png`)).status, 200);
  // Accept: a link-only tournament, the two clubs, one tie.
  r = await vel.admin.call('POST', `/api/club-challenges/${cc.id}/respond`, { accept: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  let v = r.data;
  assert.equal(v.status, 'accepted');
  assert.ok(v.match && v.match.id);
  assert.equal((await smash.admin.call('POST', `/api/club-challenges/${cc.id}/respond`, { accept: true })).status, 403);
  const t = await svc.getTournament(v.tournamentId, smash.admin.actor);
  assert.deepEqual([t.visibility, t.entries.map((e) => e.name), t.matches.length], ['link', ['Smashpoint', 'Velachery Smashers'], 1]);
  const listed = await svc.listTournaments({});
  assert.ok(!(listed.items || listed).some((x) => x.id === v.tournamentId), 'never listed');
  assert.ok((await smash.admin.call('GET', '/api/notifications')).data.items.some((x) => x.title === '✅ Velachery Smashers accepted your challenge'));
  // Teams: members only, enough for the format.
  const ids = (c) => [c.admin.id, ...c.members.map((m) => m.id)];
  assert.equal((await smash.admin.call('POST', `/api/club-challenges/${cc.id}/team`, { members: [smash.admin.id] })).status, 400, 'at least 2');
  assert.equal((await smash.admin.call('POST', `/api/club-challenges/${cc.id}/team`, { members: [smash.admin.id, outsider.id] })).status, 400, 'members only');
  assert.equal((await vel.members[0].call('POST', `/api/club-challenges/${cc.id}/team`, { members: ids(vel) })).status, 403);
  v = (await smash.admin.call('POST', `/api/club-challenges/${cc.id}/team`, { members: ids(smash).slice(0, 3) })).data;
  assert.equal(v.a.team.length, 3);
  assert.ok(v.a.members.length >= 4);
  v = (await vel.admin.call('POST', `/api/club-challenges/${cc.id}/team`, { members: ids(vel).slice(0, 3) })).data;
  assert.deepEqual(v.b.team.map((p) => p.captain), [true, false, false]);
  assert.equal(v.b.members.length, 4, 'my own club\'s members only');
  assert.equal(v.a.members, null);
  // Line-ups by each club's admin (the captains), then the tie.
  const tid = v.tournamentId;
  const mid = v.match.id;
  const tv = (await smash.admin.call('GET', `/api/tournaments/${tid}/matches/${mid}/tie`)).data;
  const sideOf = tv.sides.a.canSet ? 'a' : 'b';
  await smash.admin.call('PUT', `/api/tournaments/${tid}/matches/${mid}/tie/lineup`, { side: sideOf, slots: [[0], [1], [0, 2]] });
  r = await vel.admin.call('PUT', `/api/tournaments/${tid}/matches/${mid}/tie/lineup`, { side: sideOf === 'a' ? 'b' : 'a', slots: [[0], [1], [1, 2]] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await smash.admin.call('POST', `/api/club-challenges/${cc.id}/team`, { members: ids(smash).slice(0, 2) })).status, 409, 'locked once line-ups are in');
  // Smashpoint wins S1 and D, loses S2: 2–1.
  const games = (smashWins) => ((sideOf === 'a') === smashWins ? win : lose);
  const rubber = (k, g) => vel.admin.call('POST', `/api/tournaments/${tid}/matches/${mid}/tie/rubbers/${k}/result`, { games: g });
  await rubber(0, games(true));
  await rubber(1, games(false));
  r = await rubber(2, games(true));
  assert.equal(r.data.status, 'done');
  v = (await outsider.call('GET', `/api/club-challenges/${cc.id}`)).data;
  assert.deepEqual([v.status, v.result], ['played', { winner: 'a', score: '2–1' }]);
  // Records and feeds.
  const rec = (slug) => smash.admin.call('GET', `/api/clubs/${slug}/club-challenges`).then((x) => x.data);
  assert.deepEqual((await rec('smashpoint')).record, { won: 1, lost: 0, drawn: 0, played: 1 });
  assert.deepEqual((await rec('velachery-smashers')).record, { won: 0, lost: 1, drawn: 0, played: 1 });
  assert.equal((await rec('velachery-smashers')).items[0].won, false);
  const orgId = async (slug) => (await db.query('SELECT id FROM orgs WHERE slug = $1', [slug]))[0].id;
  for (const slug of ['smashpoint', 'velachery-smashers']) {
    const items = (await svc.social.clubFeed(await orgId(slug), outsider.actor)).items.filter((x) => x.verb === 'club_v_club');
    assert.equal(items.length, 1, slug);
    assert.equal((await svc.social.clubFeed(await orgId(slug), outsider.actor)).items.filter((x) => x.verb === 'finish').length, 0, 'no podium posts');
    assert.equal(items[0].data.score, '2–1');
    assert.equal(items[0].people.length, 3);
    assert.equal((await fetch(`${base}/img/a/${items[0].id}.png`)).status, 200);
  }
  const card = await svc.cards.activity((await svc.social.clubFeed(await orgId('smashpoint'), null)).items.find((x) => x.verb === 'club_v_club').id);
  assert.deepEqual([card.title, card.subtitle, card.big], ['Smashpoint', 'beat Velachery Smashers in a badminton tie', '2–1']);
  assert.ok((await smash.members[0].call('GET', '/api/notifications')).data.items.some((x) => x.title === '🏆 Smashpoint beat Velachery Smashers 2–1'));
  assert.equal((await fetch(`${base}/cc/${cc.id}`)).status, 200);
});

test('a football friendly (a draw), declining, cancelling, and expiry', async () => {
  const a = await club('Anna Nagar FC', 'anna-nagar-fc', ['football'], 1);
  const b = await club('Besant FC', 'besant-fc', ['football'], 1);
  // Declined.
  let cc = (await a.admin.call('POST', '/api/clubs/anna-nagar-fc/club-challenges', { to: 'besant-fc', sport: 'football' })).data;
  assert.deepEqual([cc.kind, cc.tie], ['friendly', null]);
  let v = (await b.admin.call('POST', `/api/club-challenges/${cc.id}/respond`, { accept: false })).data;
  assert.equal(v.status, 'declined');
  assert.ok((await a.admin.call('GET', '/api/notifications')).data.items.some((x) => x.title === 'Besant FC declined your challenge'));
  // Cancelled by the challenger.
  cc = (await a.admin.call('POST', '/api/clubs/anna-nagar-fc/club-challenges', { to: 'besant-fc', sport: 'football' })).data;
  assert.equal((await b.admin.call('POST', `/api/club-challenges/${cc.id}/cancel`)).status, 403);
  assert.equal((await a.admin.call('POST', `/api/club-challenges/${cc.id}/cancel`)).data.status, 'cancelled');
  // Expired after two weeks.
  cc = (await a.admin.call('POST', '/api/clubs/anna-nagar-fc/club-challenges', { to: 'besant-fc', sport: 'football' })).data;
  await db.query(`UPDATE club_challenges SET created_at = now() - interval '15 days' WHERE id = $1`, [cc.id]);
  assert.equal((await b.admin.call('POST', `/api/club-challenges/${cc.id}/respond`, { accept: true })).status, 409);
  // A friendly, played and drawn 1–1.
  cc = (await b.admin.call('POST', '/api/clubs/besant-fc/club-challenges', { to: 'anna-nagar-fc', sport: 'football' })).data;
  v = (await a.admin.call('POST', `/api/club-challenges/${cc.id}/respond`, { accept: true })).data;
  await b.admin.call('POST', `/api/club-challenges/${cc.id}/team`, { members: [b.admin.id, b.members[0].id] });
  await a.admin.call('POST', `/api/club-challenges/${cc.id}/team`, { members: [a.admin.id] });
  const r = await a.admin.call('POST', `/api/tournaments/${v.tournamentId}/matches/${v.match.id}/result`, { games: [{ a: 1, b: 1 }] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  v = (await a.admin.call('GET', `/api/club-challenges/${cc.id}`)).data;
  assert.deepEqual([v.status, v.result], ['played', { winner: null, score: '1–1' }]);
  assert.deepEqual((await a.admin.call('GET', '/api/clubs/besant-fc/club-challenges')).data.record, { won: 0, lost: 0, drawn: 1, played: 1 });
  // Undone: back to accepted, off the feed.
  await a.admin.call('POST', `/api/tournaments/${v.tournamentId}/matches/${v.match.id}/undo`, {});
  v = (await a.admin.call('GET', `/api/club-challenges/${cc.id}`)).data;
  assert.equal(v.status, 'accepted');
});
