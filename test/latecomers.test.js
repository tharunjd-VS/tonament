'use strict';

// Latecomers: the options under the late-arrival policy are fair (even
// groups, or time to catch up), deterministic, identity-blind and respect
// what the organiser published; the service enforces the same policy.

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupOptions, byeOptions, noShowOptions, policyOf, describe } = require('../server/latecomers');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');

const G = (no, active, played, total) => ({ no, name: `Group ${'ABCD'[no]}`, active, played, total, pool: null });

test('policy: defaults, cleaning, and in plain words', () => {
  assert.deepEqual(policyOf(null), { lateUntil: 'groups', groupChoice: 'even', graceMinutes: 15 });
  assert.deepEqual(policyOf({ lateUntil: 'nope', groupChoice: 'progress', graceMinutes: 500 }), { lateUntil: 'groups', groupChoice: 'progress', graceMinutes: 15 });
  assert.match(describe({ lateUntil: 'half' })[0], /until it is half played/);
  assert.match(describe({ graceMinutes: 20 })[1], /more than 20 minutes late/);
});

test('even groups: the smallest group, then the least played; effects and notes', () => {
  const r = groupOptions({ groups: [G(0, 4, 2, 6), G(1, 3, 3, 3), G(2, 3, 1, 3)], policy: {}, matchMinutes: 20, courts: 2 });
  assert.equal(r.allowed, true);
  assert.deepEqual(r.options.map((o) => [o.label, o.recommended || false]), [['Group C', true], ['Group B', false], ['Group A', false]]);
  const best = r.options[0];
  assert.deepEqual([best.matchesAdded, best.extraMinutes, best.sizeAfter], [3, 30, 4]);
  assert.match(best.why, /even/);
  assert.deepEqual(r.options[2].notes, ['makes Group A 2 bigger than the smallest group']);
  // The same situation, the same answer — whatever order the groups come in.
  const again = groupOptions({ groups: [G(2, 3, 1, 3), G(0, 4, 2, 6), G(1, 3, 3, 3)], policy: {}, matchMinutes: 20, courts: 2 });
  assert.deepEqual(again.options.map((o) => o.group), r.options.map((o) => o.group));
});

test('time to catch up; half-played groups closed; never after the draw; byes; no-shows', () => {
  const groups = [G(0, 3, 2, 3), G(1, 4, 1, 6)];
  assert.equal(groupOptions({ groups, policy: { groupChoice: 'progress' } }).options[0].group, 1);
  const half = groupOptions({ groups, policy: { lateUntil: 'half' } });
  assert.deepEqual(half.options.map((o) => [o.group, o.allowed]), [[1, true], [0, false]]);
  assert.match(half.options[1].why, /less than half played/);
  const full = groupOptions({ groups: [G(0, 3, 3, 3)], policy: { lateUntil: 'half' } });
  assert.equal(full.allowed, false);
  assert.equal(groupOptions({ groups, policy: { lateUntil: 'never' } }).allowed, false);
  assert.equal(byeOptions({ byes: 0, policy: {} }).allowed, false);
  assert.equal(byeOptions({ byes: 1, policy: {} }).options[0].action, 'bye');
  const early = noShowOptions({ minutesLate: 6, policy: { graceMinutes: 15 } });
  assert.deepEqual(early.options.map((o) => [o.action, o.allowed, o.recommended]), [['wait', true, true], ['walkover', false, false]]);
  const late = noShowOptions({ minutesLate: 16, policy: { graceMinutes: 15 } });
  assert.deepEqual(late.options.map((o) => [o.action, o.allowed, o.recommended]), [['wait', true, false], ['walkover', true, true]]);
});

test('the service follows the published policy, and offers the options', async () => {
  const db = await createDb(process.env.TEST_DATABASE_URL || ':memory:');
  try {
    const svc = createApp(db).service;
    const [u] = await db.query(`INSERT INTO users (email, name, password_hash) VALUES ('late@lc.test', 'Late Org', 'x') RETURNING id, email, name`);
    const org = { user: { ...u, isAdmin: false } };
    const { id } = await svc.createTournament(org, { name: 'Late Cup', format: 'league_knockout', groups: 2, qualifiers: 1, events: [{ discipline: 'singles', gender: 'open' }] });
    await svc.updateSettings(id, org, { lateEntry: true, latePolicy: { lateUntil: 'half', groupChoice: 'even', graceMinutes: 10 } });
    await svc.addEntries(id, org, ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'B4']);
    await svc.start(id, org);
    let t = await svc.getTournament(id, org);
    assert.deepEqual(t.config.latePolicy, { lateUntil: 'half', groupChoice: 'even', graceMinutes: 10 });
    // The 3-player group is recommended; options carry effects.
    const o = await svc.lateOptions(id, org, { kind: 'late' });
    assert.equal(o.allowed, true);
    const best = o.options.find((x) => x.recommended);
    assert.equal(best.sizeAfter, 4);
    assert.match(o.says[0], /until it is half played/);
    // Play out the whole of the recommended group: now it's past halfway, and closed.
    for (;;) {
      t = await svc.getTournament(id, org);
      const m = t.matches.find((x) => x.status === 'scheduled' && x.group === best.group && x.a && x.b);
      if (!m) break;
      await svc.setResult(id, org, m.id, [{ a: 21, b: 10 }, { a: 21, b: 12 }], 0);
    }
    const after = await svc.lateOptions(id, org, { kind: 'late' });
    assert.equal(after.options.find((x) => x.group === best.group).allowed, false);
    await assert.rejects(svc.lateEntry(id, org, { name: 'Late Larry', group: best.group }), /less than half played/);
    // Without a pick, they go where the policy says.
    await svc.lateEntry(id, org, { name: 'Late Lily' });
    t = await svc.getTournament(id, org);
    const lily = t.entries.find((e) => e.name === 'Late Lily');
    assert.notEqual(lily.group, best.group);
    // Never after the draw.
    await svc.updateSettings(id, org, { latePolicy: { lateUntil: 'never' } });
    await assert.rejects(svc.lateEntry(id, org, { name: 'Too Late' }), /no one joins after the draw/);
  } finally { await db.close(); }
});
