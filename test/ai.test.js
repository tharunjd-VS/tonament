'use strict';

// AI setup with a stand-in for Claude: a draft writes nothing but its log
// row, flags bad and duplicate events, is rate-limited, and is off without a
// key; a reviewed draft becomes a tournament with fees, notes and links;
// form links only from Google Forms; importing a form's responses previews
// first, then adds entries within the event cap, the plan limit and
// existing names, without messaging anyone.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../server/db');
const { createApp } = require('../server/app');
const { formText, costPaise } = require('../server/ai');

const DRAFT = {
  name: 'Chennai Smash Open 2026', sport: 'badminton', startsOn: '2026-12-12', endsOn: null, startTime: '07:30', endTime: null,
  venue: 'Anna Nagar Indoor Stadium', address: null, city: 'Chennai', region: 'Tamil Nadu', country: 'India', entriesCloseAt: '2026-12-10T21:00', format: 'knockout',
  events: [
    { discipline: 'singles', gender: 'men', age: null, level: null, name: null, feeRupees: 500, feePer: 'entry' },
    { discipline: 'doubles', gender: 'men', age: null, level: null, name: null, feeRupees: 800, feePer: 'entry' },
    { discipline: 'singles', gender: 'men', age: 'U15', level: null, name: null, feeRupees: 300, feePer: 'entry' },
    { discipline: 'singles', gender: 'mixed', age: null, level: null, name: null, feeRupees: null, feePer: null },
    { discipline: 'singles', gender: 'men', age: null, level: null, name: null, feeRupees: 500, feePer: 'entry' },
  ],
  prizes: 'Winner ₹5,000, runner-up ₹3,000', contacts: [{ name: 'Kavya', phone: '98450 12345' }],
  links: { instagram: 'instagram.com/chennaismash', whatsapp: null, website: null, entryForm: 'https://forms.gle/abc' },
  otherDetails: 'Yonex Mavis 350 shuttles.', unsure: [{ field: 'endsOn', reason: 'Only one date on the poster' }],
};
const MAPPING = {
  columns: [
    { header: 'Timestamp', field: 'timestamp', event: null }, { header: 'Name', field: 'name', event: null },
    { header: 'Partner', field: 'partner', event: null }, { header: 'Phone', field: 'phone', event: null },
    { header: 'Events', field: 'category', event: null }, { header: 'Paid', field: 'paid', event: null },
  ],
  categoryValues: [
    { value: 'MS', event: { discipline: 'singles', gender: 'men', age: 'Open', level: 'Open' } },
    { value: 'MD', event: { discipline: 'doubles', gender: 'men', age: 'Open', level: 'Open' } },
    { value: 'WS', event: { discipline: 'singles', gender: 'women', age: 'Open', level: 'Open' } },
  ],
  separator: ',', paidValues: ['Yes'], notes: [],
};
const CSV = `Timestamp,Name,Partner,Phone,Events,Paid
10/1/2026 9:00:00,Arjun Mehta,Rohan Iyer,9845012345,"MS, MD",Yes
10/1/2026 9:05:00,Rohan Iyer,Arjun Mehta,9900011122,MD,No
10/1/2026 9:10:00,Meera K,,9741234567,WS,No
10/1/2026 9:20:00,Already In,,9741234500,MS,No
`;

// A stand-in for the Anthropic client: answers by the system prompt.
function stub() {
  const calls = [];
  return {
    calls,
    beta: { messages: { async create(req) {
      calls.push(req);
      const mapping = /map the columns/.test(req.system);
      return { model: req.model, stop_reason: 'end_turn', usage: { input_tokens: 2000, output_tokens: 800 }, content: [{ type: 'text', text: JSON.stringify(mapping ? MAPPING : DRAFT) }] };
    } } },
  };
}

let db;
async function serve(opts) {
  const app = createApp(db, { mailer: { enabled: true, sent: [], async send(m) { this.sent.push(m); } }, ...opts });
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, cookie) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json().catch(() => null), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const signup = async (name) => (await call('POST', '/api/auth/signup', { name, email: `${name.toLowerCase().replace(/\W/g, '')}.${Date.now()}@ai.test`, password: 'password123' })).cookie;
  return { app, call, signup, close: () => new Promise((r) => server.close(r)) };
}
test.before(async () => { db = await createDb(process.env.TEST_DATABASE_URL || ':memory:'); });
test.after(async () => { await db.close(); });

test('off without a key: nothing offered, the route says so', async () => {
  const s = await serve({ aiEnv: {} });
  try {
    const me = await s.signup('No Key');
    assert.equal((await s.call('GET', '/api/auth/me', null, me)).data.aiEnabled, false);
    const r = await s.call('POST', '/api/ai/tournament-draft', { text: 'Badminton open, 12 Dec' }, me);
    assert.equal(r.status, 503);
  } finally { await s.close(); }
});

test('a draft from text: Claude asked once with the schema, nothing saved, problems listed, then created as reviewed', async () => {
  const client = stub();
  const s = await serve({ aiClient: client });
  try {
    const me = await s.signup('Draft Organiser');
    assert.equal((await s.call('POST', '/api/ai/tournament-draft', { text: 'Smash Open' })).status, 401);
    const before = (await db.query('SELECT COUNT(*)::int AS n FROM tournaments'))[0].n;
    const r = await s.call('POST', '/api/ai/tournament-draft', { text: 'CHENNAI SMASH OPEN — 12 Dec, Anna Nagar Indoor. MS ₹500, MD ₹800, U15 BS ₹300. Contact Kavya 98450 12345' }, me);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.draft.name, 'Chennai Smash Open 2026');
    // Mixed singles isn't a thing; Men's Singles is listed twice.
    assert.deepEqual(r.data.problems.map((p) => p.field), ['events.3', 'events.4']);
    assert.match(r.data.problems[1].message, /listed twice/);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM tournaments'))[0].n, before, 'nothing saved');
    const req = client.calls[0];
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(req.fallbacks, 'default');
    assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(req.output_config.effort, 'medium');
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.ok(req.output_config.format.schema.properties.sport.anyOf[0].enum.includes('badminton'));
    assert.match(req.system, /Copy facts; never invent them/);
    const [log] = await db.query(`SELECT kind, model, tokens_in, tokens_out, cost_paise, ok FROM ai_calls ORDER BY id DESC LIMIT 1`);
    assert.deepEqual(log, { kind: 'draft', model: 'claude-opus-5-5', tokens_in: 2000, tokens_out: 800, cost_paise: costPaise('claude-opus-5-5', { input_tokens: 2000, output_tokens: 800 }), ok: true });
    assert.equal(log.cost_paise, 204); // $0.024 → ₹2.04

    // The organiser fixes the two events, then creates it.
    const reviewed = { ...r.data.draft, events: r.data.draft.events.slice(0, 3) };
    const made = await s.call('POST', '/api/tournaments/from-draft', reviewed, me);
    assert.equal(made.status, 200, JSON.stringify(made.data));
    const [t] = await db.query('SELECT name, sport, venue, city, region, starts_on, start_time, notes, links, config, format FROM tournaments WHERE id = $1', [made.data.id]);
    assert.equal(t.name, 'Chennai Smash Open 2026');
    assert.equal(t.region, 'Tamil Nadu');
    assert.equal(t.start_time, '07:30');
    assert.match(t.notes, /^Prizes: Winner ₹5,000, runner-up ₹3,000\n\nContact: Kavya 98450 12345\n\nYonex Mavis 350 shuttles\.$/);
    assert.equal(t.links.instagram, 'https://instagram.com/chennaismash');
    assert.equal(t.config.entriesCloseAt, '2026-12-10T15:30:00.000Z');
    const evs = await db.query('SELECT name, age, format, config FROM events WHERE tournament_id = $1 ORDER BY position', [made.data.id]);
    assert.deepEqual(evs.map((e) => [e.age, e.format, e.config.fee]), [['Open', 'knockout', 50000], ['Open', 'knockout', 80000], ['U15', 'knockout', 30000]]);
  } finally { await s.close(); }
});

test('drafts are limited: 10 a person a day', async () => {
  const s = await serve({ aiClient: stub() });
  try {
    const me = await s.signup('Busy Organiser');
    const [{ id }] = await db.query('SELECT id FROM users ORDER BY id DESC LIMIT 1');
    await db.query(`INSERT INTO ai_calls (user_id, kind, model) SELECT $1, 'draft', 'x' FROM generate_series(1, 10)`, [id]);
    const r = await s.call('POST', '/api/ai/tournament-draft', { text: 'Smash' }, me);
    assert.equal(r.status, 429);
  } finally { await s.close(); }
});

test('form links: Google Forms only, redirects only to Google Forms, questions read from the page', async () => {
  const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
  const page = `<html><script>var FB_PUBLIC_LOAD_DATA_ = [null,["Entries for the open",[[1,"Your name",null,0,[[11,null,1]]],[2,"Category",null,4,[[12,[["Men's Singles"],["Women's Doubles"]],1]]]],null,null,null,null,null,null,"Smash Open 2026"],"/forms","Smash Open 2026"];</script></html>`;
  const fetches = [];
  const fake = async (url) => {
    fetches.push(url);
    if (url.startsWith('https://forms.gle/')) return { status: 302, ok: false, headers: { get: () => 'https://docs.google.com/forms/d/e/x/viewform' } };
    return { status: 200, ok: true, headers: { get: () => null }, text: async () => page };
  };
  const text = await formText('https://forms.gle/abc', fake, fail);
  assert.match(text, /Form title: Smash Open 2026/);
  assert.match(text, /Question: Category — options: Men's Singles \| Women's Doubles/);
  await assert.rejects(formText('https://evil.example/forms/x', fake, fail), /Google Form/);
  await assert.rejects(formText('https://docs.google.com/document/d/x', fake, fail), /Google Form/);
  const bounce = async () => ({ status: 302, ok: false, headers: { get: () => 'https://evil.example/' } });
  await assert.rejects(formText('https://forms.gle/abc', bounce, fail), /doesn't open a Google Form/);
});

test('importing responses: preview first (mapping saved), then entries within the limits, nobody messaged', async () => {
  const client = stub();
  const s = await serve({ aiClient: client });
  try {
    const me = await s.signup('Import Organiser');
    const { data: { id } } = await s.call('POST', '/api/tournaments', { name: 'Import Cup', sport: 'badminton', events: [{ discipline: 'singles', gender: 'men' }, { discipline: 'doubles', gender: 'men' }] }, me);
    const t0 = (await s.call('GET', `/api/tournaments/${id}?me=1`, null, me)).data;
    const ms = t0.events[0].id;
    await db.query('UPDATE events SET config = config || \'{"fee": 50000}\'::jsonb WHERE id = $1', [ms]);
    await s.call('POST', `/api/tournaments/${id}/entries`, { names: ['Already In'], event: ms }, me);

    const p = await s.call('POST', `/api/tournaments/${id}/import/preview`, { csv: CSV }, me);
    assert.equal(p.status, 200, JSON.stringify(p.data));
    assert.equal(p.data.mappedBy, 'ai');
    assert.equal(client.calls[0].output_config.effort, 'low');
    // Only masked samples reach Claude.
    assert.doesNotMatch(client.calls[0].messages[0].content[0].text, /9845012345/);
    assert.deepEqual(p.data.totals.map((x) => [x.event, x.entries]).sort(), [["Men's Doubles", 1], ["Men's Singles", 2], ["Women's Singles", 1]]);
    assert.deepEqual(p.data.missing.map((m) => m.name), ["Women's Singles"]);
    assert.equal(p.data.merged.length, 1);
    // Again: the saved mapping, no second call.
    const again = await s.call('POST', `/api/tournaments/${id}/import/preview`, { csv: CSV }, me);
    assert.equal(again.data.mappedBy, 'saved');
    assert.equal(client.calls.length, 1);

    const ws = p.data.missing[0];
    const r = await s.call('POST', `/api/tournaments/${id}/import`, { entries: p.data.entries, create: [{ key: ws.key, spec: ws.spec }], mapping: p.data.mapping }, me);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.imported, { added: 3, skipped: ["Already In (Men's Singles: already entered)"], unconfirmed: 0, events: 1 });
    const rows = await db.query(`SELECT e.name, e.phone, e.fee_status, e.fee_amount, e.solo FROM entries e WHERE e.tournament_id = $1 AND e.source = 'import' ORDER BY e.name`, [id]);
    assert.deepEqual(rows.map((x) => [x.name, x.phone, x.fee_status, x.fee_amount]), [
      ['Arjun Mehta', '+919845012345', 'received', 50000], // paid, and Men's Singles has a fee
      ['Meera K', '+919741234567', null, null],
      ['Rohan Iyer / Arjun Mehta', '+919900011122', null, null], // the pair, merged from both responses
    ]);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM events WHERE tournament_id = $1`, [id]))[0].n, 3, "Women's Singles was created");
    // Nobody was messaged about it.
    assert.equal((await db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE created_at > now() - interval '1 minute' AND url LIKE $1`, [`%${id}%`]))[0].n, 0);
    // Only those who run it.
    const other = await s.signup('Import Stranger');
    assert.equal((await s.call('POST', `/api/tournaments/${id}/import/preview`, { csv: CSV }, other)).status, 403);
    // A published sheet link must be a Google Sheets CSV link.
    assert.equal((await s.call('POST', `/api/tournaments/${id}/import/preview`, { sheetUrl: 'https://evil.example/x.csv' }, me)).status, 400);
  } finally { await s.close(); }
});
