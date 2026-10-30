'use strict';

// Google Form responses → entries, with no AI: the CSV parser, masking for
// what the AI sees, phones, categories, partners, payments and duplicates.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, table } = require('../server/csv');
const { mask, sampleFor, applyMapping, totals, phoneOf, titleCase } = require('../server/importer');

test('CSV: quotes, commas and newlines in quotes, doubled quotes, CRLF, BOM, blank lines', () => {
  const rows = parseCsv('﻿Name,Note\r\n"Rao, K","said ""hi""\nthen left"\r\n\r\nAsha,ok\n\n');
  assert.deepEqual(rows, [['Name', 'Note'], ['Rao, K', 'said "hi"\nthen left'], [''], ['Asha', 'ok']]);
  const t = table('A,,C\n1,2\n,,\n4,5,6\n');
  assert.deepEqual(t.headers, ['A', 'Column 2', 'C']);
  assert.deepEqual(t.rows, [['1', '2', ''], ['4', '5', '6']]);
});

test('masking: emails and phone numbers never reach the AI', () => {
  assert.equal(mask('Call 98450 12345 or +91 99000-11122, mail a.b@gmail.com'), 'Call 99999 99999 or +99 99999-99999, mail someone@example.com');
  assert.equal(mask('U-15 Boys Singles'), 'U-15 Boys Singles');
  const s = sampleFor(table('Name,Phone,Category\nA,9845012345,"MS, MD"\nB,9900011122,MS\nC,9741234567,WS\n'));
  assert.deepEqual(s.samples[0], ['A', '9999999999', 'MS, MD']);
  assert.deepEqual(s.repeating.Category, ['MS, MD', 'MS', 'MD', 'WS']);
  assert.equal(s.repeating.Phone, undefined);
});

test('phones: Indian mobiles to +91, anything else kept and flagged; names title-cased', () => {
  assert.deepEqual(phoneOf('98450 12345'), { phone: '+919845012345', odd: false });
  assert.deepEqual(phoneOf('+91 99000 11122'), { phone: '+919900011122', odd: false });
  assert.deepEqual(phoneOf('09741234567'), { phone: '+919741234567', odd: false });
  assert.deepEqual(phoneOf('12345'), { phone: '12345', odd: true });
  assert.deepEqual(phoneOf(''), { phone: null, odd: false });
  assert.equal(titleCase('  arjun   MEHTA '), 'Arjun Mehta');
  assert.equal(titleCase("k. s. o'brien-rao"), "K. S. O'Brien-Rao");
});

// A form export: a multi-select category column, a partner column, paid,
// a timestamp; both partners of one pair filled it in; an NA partner; an
// unknown category; an odd phone; a row with nothing ticked.
const CSV = `Timestamp,Full name,Partner's name,Mobile,Email,Gender,Categories,Paid?,UTR
10/1/2026 9:00:00,arjun mehta,Rohan Iyer,98450 12345,arjun@x.com,Male,"Men's Singles, Men's Doubles",Yes,UTR111
10/1/2026 9:05:00,Rohan Iyer,Arjun Mehta,+91 99000 11122,,Male,Men's Doubles,No,
10/1/2026 9:10:00,Meera K,NA,09741234567,meera@x.com,Female,"Mixed Doubles, Women's Singles",Yes,UTR222
10/1/2026 9:20:00,Divya R,,12345,divya@x.com,Female,"Women's Singles, Throwball",No,
10/1/2026 9:30:00,Karthik R,,9876543210,,Male,,No,
10/2/2026 8:00:00,ARJUN MEHTA,,98450 12345,,Male,Men's Singles,No,
`;
const MS = { discipline: 'singles', gender: 'men', age: 'Open', level: 'Open' };
const MD = { discipline: 'doubles', gender: 'men', age: 'Open', level: 'Open' };
const WS = { discipline: 'singles', gender: 'women', age: 'Open', level: 'Open' };
const XD = { discipline: 'doubles', gender: 'mixed', age: 'Open', level: 'Open' };
const MAPPING = {
  columns: [
    { header: 'Timestamp', field: 'timestamp', event: null },
    { header: 'Full name', field: 'name', event: null },
    { header: "Partner's name", field: 'partner', event: null },
    { header: 'Mobile', field: 'phone', event: null },
    { header: 'Email', field: 'email', event: null },
    { header: 'Gender', field: 'gender', event: null },
    { header: 'Categories', field: 'category', event: null },
    { header: 'Paid?', field: 'paid', event: null },
    { header: 'UTR', field: 'payment_ref', event: null },
  ],
  categoryValues: [
    { value: "Men's Singles", event: MS }, { value: "Men's Doubles", event: MD },
    { value: "Women's Singles", event: WS }, { value: 'Mixed Doubles', event: XD },
  ],
  separator: ',',
  paidValues: ['Yes'],
  notes: [],
};
const EVENTS = [
  { id: 1, name: "Men's Singles", ...MS }, { id: 2, name: "Men's Doubles", ...MD }, { id: 3, name: "Women's Singles", ...WS },
];

test('a form export becomes entries: categories, partners, solos, payments, duplicates merged, problems flagged', () => {
  const r = applyMapping(table(CSV), MAPPING, EVENTS, 'badminton');
  const show = r.entries.map((e) => [e.eventName, e.name, e.solo, e.paid, e.phone, e.payRef]);
  assert.deepEqual(show, [
    ["Men's Doubles", 'Rohan Iyer / Arjun Mehta', false, true, '+919900011122', 'UTR111'],
    ['Mixed Doubles', 'Meera K', true, true, '+919741234567', 'UTR222'],
    ["Women's Singles", 'Meera K', false, true, '+919741234567', 'UTR222'],
    ["Women's Singles", 'Divya R', false, false, '12345', null],
    ["Men's Singles", 'Arjun Mehta', false, true, '+919845012345', 'UTR111'],
  ]);
  // Mixed doubles solo knows which side; the pair was merged, paid from the first response.
  assert.equal(r.entries[1].side, 'woman');
  assert.deepEqual(r.merged.map((m) => [m.event, m.kept, m.dropped]), [["Men's Doubles", 3, 2], ["Men's Singles", 7, 2]]);
  assert.deepEqual(r.problems.map((p) => [p.row, p.message]), [
    [5, 'Unknown category "Throwball"'],
    [5, 'Divya R: phone "12345" doesn\'t look like an Indian mobile — kept as written'],
    [6, 'Karthik R: no event chosen'],
  ]);
  // Mixed Doubles isn't in the tournament yet: offered to create.
  assert.deepEqual(r.missing.map((m) => [m.name, m.count]), [['Mixed Doubles', 1]]);
  assert.deepEqual(totals(r.entries).map((x) => [x.event, x.entries, x.solo, x.unpaid]), [
    ["Men's Doubles", 1, 0, 0], ['Mixed Doubles', 1, 1, 0], ["Women's Singles", 2, 0, 1], ["Men's Singles", 1, 0, 0],
  ]);
});

test('flag columns, team events and partners written in the name column', () => {
  const csv = 'Name,MS?,MD?,Team name\nAsha Rao / Eva K,No,Yes,\nRavi,Yes,no,\nCaptain Cool,-,,Smashers\n';
  const mapping = {
    columns: [
      { header: 'Name', field: 'name', event: null },
      { header: 'MS?', field: 'category_flag', event: MS },
      { header: 'MD?', field: 'category_flag', event: MD },
      { header: 'Team name', field: 'team', event: null },
    ],
    categoryValues: [], separator: ',', paidValues: [], notes: [],
  };
  const r = applyMapping(table(csv), mapping, EVENTS, 'badminton');
  assert.deepEqual(r.entries.map((e) => [e.eventName, e.name]), [["Men's Doubles", 'Asha Rao / Eva K'], ["Men's Singles", 'Ravi']]);
  assert.deepEqual(r.problems.map((p) => p.message), ['Captain Cool: no event chosen']);
});
