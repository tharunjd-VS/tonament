'use strict';

// Google Form responses → entries. The AI only maps the columns (from the
// headers and a few masked rows); every row is turned into entries here,
// with no AI: categories ticked, names, phones, partners, payments, and
// duplicates merged (both partners often fill the form in).
//
// A mapping: {
//   columns: [{ header, field, event }]   field: timestamp | name | partner | phone | email | gender | age |
//                                          level | category | category_flag | team | club | paid | payment_ref | ignore
//                                          event (category_flag only): { discipline, gender, age, level }
//   categoryValues: [{ value, event }]     an answer in a category column → an event (null: not an event)
//   separator                              between several answers in one cell (multi-select), default ","
//   paidValues: []                         answers that mean "paid"
//   notes: []
// }

const catalog = require('../public/sports/events');
const { normalizePhone } = require('./messaging');

const FIELDS = ['timestamp', 'name', 'partner', 'phone', 'email', 'gender', 'age', 'level', 'category', 'category_flag', 'team', 'club', 'paid', 'payment_ref', 'ignore'];
const NO = /^(no|n|false|0|-|–|na|n\/a|none|nil|not applicable)$/i;
const NO_PARTNER = /^(|-|na|n\/a|none|nil|tbd|tba|need( a)? partner|looking( for( a)? partner)?|find( me)?( a)? partner|not yet|no partner|\?)$/i;
const EMAIL = /[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/g;
const PHONEISH = /\+?\d[\d\s\-()]{6,}\d/g;

// ---------- what the AI sees: headers, a few masked rows, the repeating answers

const mask = (v) => String(v || '').replace(EMAIL, 'someone@example.com').replace(PHONEISH, (m) => m.replace(/\d/g, '9'));
function sampleFor({ headers, rows }, { max = 8 } = {}) {
  const samples = rows.slice(0, max).map((r) => r.map(mask));
  // Columns whose answers repeat (categories, yes/no, paid): every distinct answer.
  const repeating = {};
  headers.forEach((h, i) => {
    const values = rows.map((r) => r[i]).filter(Boolean);
    // Multi-select answers ("MS, MD") repeat by their parts.
    const parts = values.flatMap((v) => v.split(/[,;]/).map((x) => x.trim()).filter(Boolean));
    const distinct = [...new Set(values.flatMap((v) => (/[,;]/.test(v) ? [v, ...v.split(/[,;]/).map((x) => x.trim()).filter(Boolean)] : [v])))];
    const repeats = new Set(values).size < values.length || new Set(parts).size < parts.length;
    if (distinct.length && distinct.length <= 40 && repeats && distinct.every((x) => x.length <= 80)) repeating[h] = distinct.map(mask);
  });
  return { headers, samples, repeating };
}

// ---------- the rows, by the mapping

const titleCase = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
const sideOf = (g) => (/^(m|male|man|men|boy|boys|gents?)$/i.test(String(g || '').trim()) ? 'man' : /^(f|female|woman|women|girl|girls|ladies|lady)$/i.test(String(g || '').trim()) ? 'woman' : null);
const specKey = (e) => [e.discipline, e.gender, (e.age || 'Open').toLowerCase(), (e.level || 'Open').toLowerCase()].join('|');

function phoneOf(raw) {
  const v = String(raw || '').trim();
  if (!v) return { phone: null, odd: false };
  const p = normalizePhone(v);
  return p && p.startsWith('+91') ? { phone: p, odd: false } : { phone: v, odd: true };
}

// events: the tournament's [{ id, name, discipline, gender, age, level }].
// Returns { entries, merged, problems, missing } — entries carry the event's
// id, or a key into `missing` (events the tournament doesn't have yet).
function applyMapping({ headers, rows }, mapping, events, sport) {
  const cols = (mapping.columns || []).map((c) => ({ ...c, i: headers.indexOf(c.header) })).filter((c) => c.i >= 0 && FIELDS.includes(c.field));
  const one = (field) => cols.find((c) => c.field === field);
  const sep = mapping.separator || ',';
  const paidSet = new Set((mapping.paidValues || []).map((x) => String(x).trim().toLowerCase()));
  const valueTo = new Map((mapping.categoryValues || []).map((v) => [String(v.value).trim().toLowerCase(), v.event || null]));
  const byKey = new Map(events.map((e) => [specKey(e), e]));
  const missing = new Map();
  const problems = [];
  const resolve = (spec) => {
    let e;
    try { e = catalog.normalize(spec || {}, {}, sport); } catch (err) { return { error: err.message }; }
    const found = byKey.get(specKey(e));
    if (found) return { event: found };
    const key = specKey(e);
    if (!missing.has(key)) missing.set(key, { key, name: catalog.eventName(e), spec: e, count: 0 });
    return { missing: missing.get(key) };
  };

  const out = [];
  rows.forEach((r, idx) => {
    const row = idx + 2; // the sheet's row number (1 is the headers)
    const get = (field) => { const c = one(field); return c ? r[c.i] : ''; };
    const name = titleCase(get('name'));
    const team = get('team').trim();
    // Which events: answers in category columns, and ticked category flags.
    const specs = [];
    for (const c of cols.filter((x) => x.field === 'category')) {
      const cell = r[c.i];
      if (!cell) continue;
      const parts = sep === ',' ? cell.split(/[,;]/) : cell.split(sep);
      for (const part of parts.map((x) => x.trim()).filter(Boolean)) {
        if (!valueTo.has(part.toLowerCase())) { problems.push({ row, message: `Unknown category "${part}"` }); continue; }
        const ev = valueTo.get(part.toLowerCase());
        if (ev) specs.push(ev);
      }
    }
    for (const c of cols.filter((x) => x.field === 'category_flag' && x.event)) {
      const v = (r[c.i] || '').trim();
      if (v && !NO.test(v)) specs.push(c.event);
    }
    if (!name && !team) { problems.push({ row, message: 'No name' }); return; }
    if (!specs.length) { problems.push({ row, message: `${name || team}: no event chosen` }); return; }
    const { phone, odd } = phoneOf(get('phone'));
    if (odd) problems.push({ row, message: `${name || team}: phone "${phone}" doesn't look like an Indian mobile — kept as written` });
    const email = (get('email').match(EMAIL) || [])[0]?.toLowerCase() || null;
    const paidCell = get('paid').trim();
    const paid = Boolean(paidCell) && (paidSet.size ? paidSet.has(paidCell.toLowerCase()) : !NO.test(paidCell));
    const payRef = get('payment_ref').trim() || null;
    const level = get('level').trim() || null;
    const at = Date.parse(get('timestamp')) || null;
    for (const spec of specs) {
      const m = resolve(spec);
      if (m.error) { problems.push({ row, message: `${name || team}: ${m.error}` }); continue; }
      const ev = m.event || m.missing.spec;
      const e = { row, at, eventId: m.event ? m.event.id : null, missingKey: m.missing ? m.missing.key : null, eventName: m.event ? m.event.name : m.missing.name, phone, email, level, paid, payRef, solo: false, side: null };
      if (ev.discipline === 'team') {
        e.name = titleCase(team || name);
        e.players = name && team ? [name] : [];
      } else if (ev.discipline === 'doubles') {
        let [first, second] = [name, get('partner')];
        if (!one('partner') && /\s(?:\/|&|and)\s|\//i.test(name)) [first, second] = name.split(/\s*(?:\/|&|\band\b)\s*/i);
        const partner = String(second || '').trim();
        if (NO_PARTNER.test(partner)) {
          Object.assign(e, { name: titleCase(first), players: [titleCase(first)], solo: true, side: ev.gender === 'mixed' ? sideOf(get('gender')) : null });
        } else {
          Object.assign(e, { name: `${titleCase(first)} / ${titleCase(partner)}`, players: [titleCase(first), titleCase(partner)] });
        }
      } else {
        Object.assign(e, { name, players: [name] });
      }
      if (m.missing) m.missing.count += 1;
      out.push(e);
    }
  });

  // Duplicates in one event: the same people (either order), or the same
  // phone on non-solo entries. Keep the latest; paid if either says paid;
  // blanks filled from the older one.
  const merged = [];
  const keep = new Map();
  const later = (a, b) => (a.at && b.at ? a.at >= b.at : a.row >= b.row);
  for (const e of out) {
    const ev = e.eventId ?? e.missingKey;
    const keys = [`${ev}|people|${[...e.players].map((x) => x.toLowerCase()).sort().join('+')}`];
    if (e.phone && !e.solo) keys.push(`${ev}|phone|${e.phone}`);
    const prev = keys.map((k) => keep.get(k)).find(Boolean);
    if (!prev) { keys.forEach((k) => keep.set(k, e)); continue; }
    const [newer, older] = later(e, prev) ? [e, prev] : [prev, e];
    newer.paid = newer.paid || older.paid;
    for (const k of ['phone', 'email', 'level', 'payRef']) newer[k] = newer[k] || older[k];
    older.dropped = true;
    merged.push({ kept: newer.row, dropped: older.row, name: newer.name, event: newer.eventName });
    keys.forEach((k) => keep.set(k, newer));
    for (const k of [...keep.keys()]) if (keep.get(k) === older) keep.set(k, newer);
  }
  const entries = out.filter((e) => !e.dropped);
  for (const m of missing.values()) m.count = entries.filter((e) => e.missingKey === m.key).length;
  return { entries, merged, problems, missing: [...missing.values()] };
}

// Totals per event, for the preview.
function totals(entries) {
  const by = new Map();
  for (const e of entries) {
    const k = e.eventId ?? e.missingKey;
    const t = by.get(k) || { event: e.eventName, eventId: e.eventId, missingKey: e.missingKey, entries: 0, solo: 0, unpaid: 0 };
    t.entries += 1;
    if (e.solo) t.solo += 1;
    if (!e.paid) t.unpaid += 1;
    by.set(k, t);
  }
  return [...by.values()];
}

module.exports = { FIELDS, mask, sampleFor, applyMapping, totals, titleCase, phoneOf, specKey };
