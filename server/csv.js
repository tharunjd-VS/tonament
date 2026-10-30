'use strict';

// A small RFC 4180 CSV parser: quoted fields, commas and newlines inside
// quotes, doubled quotes, CRLF or LF, and a leading byte-order mark.
// Returns rows of strings; trailing empty lines are dropped.

function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((x) => x.trim() === '')) rows.pop();
  return rows;
}

// { headers, rows: [[…]] } with every row padded to the header count.
function table(text) {
  const all = parseCsv(text);
  if (!all.length) return { headers: [], rows: [] };
  const headers = all[0].map((h, i) => h.trim() || `Column ${i + 1}`);
  const rows = all.slice(1).filter((r) => r.some((x) => x.trim() !== '')).map((r) => headers.map((_, i) => (r[i] ?? '').trim()));
  return { headers, rows };
}

module.exports = { parseCsv, table };
