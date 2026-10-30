'use strict';

// AI setup, with Claude: a tournament draft from a poster (photo or PDF), a
// Google Form link or pasted text; and the column mapping for importing a
// Google Form's responses (server/importer.js does the rows, without AI).
// Off without ANTHROPIC_API_KEY (the app works as before). AI_MODEL picks
// another model. Every call is logged in ai_calls with its cost; drafts are
// limited per person and site-wide per day, so the credit can't be drained.

const catalog = require('../public/sports/events');
const sports = require('./sports');
const { FIELDS } = require('./importer');

const MODEL = 'claude-opus-5-5';
// Dollars per million tokens (input, output), by model family.
const PRICES = [[/opus/, 4, 20], [/sonnet/, 2, 10], [/haiku/, 0.1, 0.5]];
const USD_INR = 85;
const LIMITS = { user: 10, site: 200 };
const TEXT_MAX = 5000;
const FORM_HOSTS = ['docs.google.com', 'forms.gle'];

// ---------- the schemas (structured outputs: every field present, nullable where unknown)

const str = { type: ['string', 'null'] };
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const EVENT_SPEC = obj({
  discipline: { type: 'string', enum: ['singles', 'doubles', 'team', 'any'] },
  gender: { type: 'string', enum: ['men', 'women', 'mixed', 'open'] },
  age: { type: 'string' },
  level: { type: 'string' },
});
const liveSports = () => sports.list().filter((s) => s.status === 'live').map((s) => s.id);
const draftSchema = () => obj({
  name: { type: 'string' },
  sport: nullable({ type: 'string', enum: liveSports() }),
  startsOn: str, endsOn: str, startTime: str, endTime: str,
  venue: str, address: str, city: str, region: str, country: str,
  entriesCloseAt: str,
  format: nullable({ type: 'string', enum: ['league_knockout', 'league', 'knockout'] }),
  events: {
    type: 'array',
    items: obj({
      discipline: { type: 'string', enum: ['singles', 'doubles', 'team', 'any'] },
      gender: { type: 'string', enum: ['men', 'women', 'mixed', 'open'] },
      age: str, level: str, name: str,
      feeRupees: { type: ['number', 'null'] },
      feePer: nullable({ type: 'string', enum: ['entry', 'player'] }),
    }),
  },
  prizes: str,
  contacts: { type: 'array', items: obj({ name: str, phone: str }) },
  links: obj({ instagram: str, whatsapp: str, website: str, entryForm: str }),
  otherDetails: str,
  unsure: { type: 'array', items: obj({ field: { type: 'string' }, reason: { type: 'string' } }) },
});
const MAPPING_SCHEMA = obj({
  columns: { type: 'array', items: obj({ header: { type: 'string' }, field: { type: 'string', enum: FIELDS }, event: nullable(EVENT_SPEC) }) },
  categoryValues: { type: 'array', items: obj({ value: { type: 'string' }, event: nullable(EVENT_SPEC) }) },
  separator: { type: 'string' },
  paidValues: { type: 'array', items: { type: 'string' } },
  notes: { type: 'array', items: { type: 'string' } },
});

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const DRAFT_SYSTEM = () => `You read tournament announcements (posters, WhatsApp messages, Google Form questions) from India and turn them into a tournament setup. Copy facts; never invent them. Leave a field null when the source doesn't say it. Today is ${today()}. Dates without a year are the next such date from today. One event per category. MS/WS/MD/WD/XD are Men's Singles, Women's Singles, Men's Doubles, Women's Doubles and Mixed Doubles. "U-15 Boys Singles" is singles, men, age U15. "Open" means no age or level limit. "Corporate" and "inter-apartment" describe the tournament, not an event. Fees are rupees as a number; "₹500 per head" for doubles means feePer "player". Country is India unless stated. Spell states in full. List every guess in "unsure".`;
const MAPPING_SYSTEM = `You map the columns of a Google Form's responses (exported as a sheet) to a tournament's entries. You see the headers, a few rows with emails and phone numbers masked, and every distinct answer of the columns whose answers repeat. For each header pick one field: timestamp, name (the player, or the captain), partner (a doubles partner's name), phone, email, gender, age, level, category (the events chosen, one or several in a cell), category_flag (one column per event, answered yes/no; give that column's event), team (a team's name), club, paid, payment_ref (UTR or transaction id) or ignore. In categoryValues list every distinct answer of the category columns (each part of a multi-select answer on its own) with its event, or null when it isn't an event. An event is discipline (singles, doubles, team, any), gender (men, women, mixed, open), age ("Open", or e.g. "U15") and level ("Open", or e.g. "Beginner"); use the tournament's own events when an answer means one of them. MS/WS/MD/WD/XD are Men's Singles, Women's Singles, Men's Doubles, Women's Doubles and Mixed Doubles; "U-15 Boys Singles" is singles, men, age U15. The separator is what divides several answers in one cell (Google Forms uses ", "). paidValues are the answers that mean the entry fee was paid. Put anything the organiser should check in notes.`;

function costPaise(model, usage) {
  const [, inp, outp] = PRICES.find(([re]) => re.test(model)) || PRICES[0];
  const usd = ((usage?.input_tokens || 0) * inp + (usage?.output_tokens || 0) * outp) / 1e6;
  return Math.round(usd * USD_INR * 100);
}

// ---------- a Google Form's questions, from its public page

async function formText(url, fetchImpl, fail) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { fail(400, 'Paste the link to a Google Form'); }
  const allowed = (x) => x.protocol === 'https:' && (FORM_HOSTS.includes(x.hostname)) && (x.hostname !== 'docs.google.com' || x.pathname.startsWith('/forms/'));
  if (!allowed(u)) fail(400, 'Paste the link to a Google Form (docs.google.com/forms or forms.gle)');
  let res;
  for (let hops = 0; hops < 5; hops += 1) {
    res = await fetchImpl(u.toString(), { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Tonament)' } });
    if (res.status < 300 || res.status >= 400) break;
    const next = new URL(res.headers.get('location') || '', u);
    if (!allowed(next)) fail(400, 'That link doesn\'t open a Google Form');
    u = next;
  }
  if (!res || !res.ok) fail(400, 'Couldn\'t open that form — is it shared with anyone who has the link?');
  const html = await res.text();
  const m = html.match(/FB_PUBLIC_LOAD_DATA_\s*=\s*(\[[\s\S]*?\]);\s*<\/script>/);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      const form = data[1] || [];
      const lines = [`Form title: ${data[3] || form[8] || ''}`, form[0] ? `Description: ${form[0]}` : ''];
      for (const item of form[1] || []) {
        const [, title, help, , answers] = item;
        const options = (answers && answers[0] && answers[0][1] ? answers[0][1].map((o) => o[0]).filter(Boolean) : []);
        lines.push(`Question: ${title || ''}${help ? ` (${help})` : ''}${options.length ? ` — options: ${options.join(' | ')}` : ''}`);
      }
      return lines.filter(Boolean).join('\n').slice(0, 20000);
    } catch { /* the visible text below */ }
  }
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, 20000);
}

// ---------- the client

function createAi({ db, fail, env = process.env, client = null, fetchImpl = globalThis.fetch, getCredits = () => null }) {
  // Credits (credits.js): spent before a call, given back if it fails.
  async function paid(spendArgs, run) {
    const credits = getCredits();
    const ids = credits ? await credits.spend(db.query, spendArgs) : [];
    try {
      return await run();
    } catch (err) {
      if (credits && ids.length) await credits.refund(db.query, ids).catch((e) => console.error('AI refund:', e.message));
      throw err;
    }
  }
  const enabled = () => Boolean(client || env.ANTHROPIC_API_KEY);
  let sdk = client;
  const getClient = () => {
    if (!sdk) {
      const Anthropic = require('@anthropic-ai/sdk');
      sdk = new (Anthropic.default || Anthropic)();
    }
    return sdk;
  };
  const model = () => env.AI_MODEL || MODEL;

  async function log(row) {
    await db.query(
      'INSERT INTO ai_calls (user_id, tournament_id, kind, model, tokens_in, tokens_out, cost_paise, ok) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [row.user ?? null, row.tournament ?? null, row.kind, row.model, row.tokensIn || 0, row.tokensOut || 0, row.cost || 0, row.ok],
    ).catch((err) => console.error('ai_calls:', err.message));
  }

  // One structured call: the parsed JSON, or a friendly error.
  async function call({ kind, user, tournament = null, system, content, schema, effort }) {
    if (!enabled()) fail(503, 'AI setup isn\'t switched on for this site');
    const m = model();
    const fallback = /opus|sonnet/.test(m);
    const Anthropic = require('@anthropic-ai/sdk');
    const A = Anthropic.default || Anthropic;
    let res;
    try {
      res = await getClient().beta.messages.create({
        model: m,
        max_tokens: 16000,
        ...(fallback && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
        output_config: { effort, format: { type: 'json_schema', schema } },
        system,
        messages: [{ role: 'user', content }],
      });
    } catch (err) {
      await log({ user, tournament, kind, model: m, ok: false });
      console.error(`AI ${kind}:`, err.message);
      if (err instanceof A.AuthenticationError) fail(503, 'AI setup isn\'t available right now — fill it in yourself');
      if (err instanceof A.RateLimitError) fail(429, 'AI setup is busy — try again in a minute');
      if (err instanceof A.BadRequestError) fail(400, 'Couldn\'t read that — try a clearer photo, or fill it in yourself');
      fail(502, 'AI setup didn\'t answer — try again, or fill it in yourself');
    }
    const used = res.model || m;
    await log({ user, tournament, kind, model: used, tokensIn: res.usage?.input_tokens, tokensOut: res.usage?.output_tokens, cost: costPaise(used, res.usage), ok: res.stop_reason === 'end_turn' });
    if (res.stop_reason !== 'end_turn') fail(422, 'Couldn\'t read that — fill it in by hand');
    const text = (res.content || []).find((b) => b.type === 'text');
    try {
      return JSON.parse(text.text);
    } catch {
      fail(422, 'Couldn\'t read that — fill it in by hand');
    }
  }

  async function checkLimits(userId, kind) {
    const [r] = await db.query(
      `SELECT COUNT(*) FILTER (WHERE user_id = $1)::int AS mine, COUNT(*)::int AS site FROM ai_calls WHERE kind = $2 AND created_at > now() - interval '1 day'`,
      [userId, kind],
    );
    if (r.mine >= LIMITS.user) fail(429, `That's ${LIMITS.user} today — fill this one in yourself, or try again tomorrow`);
    if (r.site >= LIMITS.site) fail(429, 'AI setup is resting for today — fill it in yourself');
  }

  // A tournament draft: { draft, problems }. Writes nothing but the log.
  async function tournamentDraft(actor, input = {}) {
    if (!actor?.user) fail(401, 'Sign in first');
    await checkLimits(actor.user.id, 'draft');
    const content = [];
    if (input.image) {
      const m = String(input.image).match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) fail(400, 'Send the poster as a JPEG, PNG or WebP image');
      content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      content.push({ type: 'text', text: 'This is the tournament\'s poster.' });
    } else if (input.pdf) {
      const m = String(input.pdf).match(/^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/);
      if (!m) fail(400, 'Send the poster as a PDF');
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: m[1] } });
      content.push({ type: 'text', text: 'This is the tournament\'s poster.' });
    } else if (input.formUrl) {
      content.push({ type: 'text', text: `This is the tournament's Google Form (its entry form):\n\n${await formText(input.formUrl, fetchImpl, fail)}` });
    } else if (typeof input.text === 'string' && input.text.trim()) {
      if (input.text.length > TEXT_MAX) fail(400, `Paste up to ${TEXT_MAX.toLocaleString('en-IN')} characters`);
      content.push({ type: 'text', text: `This is the tournament's announcement:\n\n${input.text.trim()}` });
    } else fail(400, 'Add a poster, a form link or the announcement\'s text');
    const cost = input.image ? 'draftImage' : input.pdf ? 'draftPdf' : input.formUrl ? 'draftForm' : 'draftText';
    const { COSTS } = require('./credits');
    const draft = await paid({ user: actor.user.id, scope: 'create', cost: COSTS[cost], note: 'draft' },
      () => call({ kind: 'draft', user: actor.user.id, system: DRAFT_SYSTEM(), content, schema: draftSchema(), effort: 'medium' }));
    return { draft, problems: checkDraft(draft) };
  }

  // The mapping for a form's responses, from headers and masked samples.
  async function columnMapping(actor, { tournament, sport, events, sample }) {
    await checkLimits(actor.user.id, 'mapping');
    const text = [
      `Sport: ${sport}`,
      `The tournament's events: ${events.map((e) => `${e.name} (${e.discipline}, ${e.gender}, age ${e.age}, level ${e.level})`).join('; ') || 'none yet'}`,
      `Headers: ${JSON.stringify(sample.headers)}`,
      `Sample rows (masked): ${JSON.stringify(sample.samples)}`,
      `Repeating answers by column: ${JSON.stringify(sample.repeating)}`,
    ].join('\n\n');
    const { COSTS } = require('./credits');
    return paid({ user: actor.user.id, tournament, scope: 'create', cost: COSTS.mapping, note: 'mapping' },
      () => call({ kind: 'mapping', user: actor.user.id, tournament, system: MAPPING_SYSTEM, content: [{ type: 'text', text }], schema: MAPPING_SCHEMA, effort: 'low' }));
  }

  // Totals for the admin overview.
  async function usage(days = 30) {
    const [r] = await db.query(
      `SELECT COUNT(*)::int AS calls, COUNT(*) FILTER (WHERE kind = 'draft')::int AS drafts, COUNT(*) FILTER (WHERE kind = 'mapping')::int AS mappings,
              COUNT(*) FILTER (WHERE NOT ok)::int AS failed, COALESCE(SUM(cost_paise), 0)::int AS cost
       FROM ai_calls WHERE created_at > now() - make_interval(days => $1)`, [days],
    );
    return { ...r, enabled: enabled(), model: model() };
  }

  return { enabled, tournamentDraft, columnMapping, usage, model };
}

// Each event checked as Tonament would make it; problems listed, never failing the draft.
function checkDraft(draft) {
  const problems = [];
  const sport = draft.sport || null;
  if (!draft.sport) problems.push({ field: 'sport', message: 'Which sport? It wasn\'t clear — pick it.' });
  const seen = new Set();
  (draft.events || []).forEach((e, i) => {
    try {
      const n = catalog.normalize({ discipline: e.discipline, gender: e.gender, age: e.age || 'Open', level: e.level || 'Open', name: e.name || undefined }, {}, sport);
      const label = catalog.eventName(n).toLowerCase();
      if (seen.has(label)) problems.push({ field: `events.${i}`, message: `${catalog.eventName(n)} is listed twice` });
      seen.add(label);
    } catch (err) {
      problems.push({ field: `events.${i}`, message: err.message });
    }
  });
  if (!(draft.events || []).length) problems.push({ field: 'events', message: 'No events found — add them.' });
  return problems;
}

module.exports = { createAi, checkDraft, formText, costPaise, DRAFT_SYSTEM, MAPPING_SYSTEM, draftSchema, MAPPING_SCHEMA };
