'use strict';

// Every schema sent to Claude uses only what structured outputs accept:
// nullable fields as anyOf (no type arrays), every object closed and with
// all its properties required.

const test = require('node:test');
const assert = require('node:assert/strict');
const { draftSchema, MAPPING_SCHEMA } = require('../server/ai');
const { SCHEMA: ASSIST } = require('../server/assistant');

function walk(node, path, problems) {
  if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${path}[${i}]`, problems)); return; }
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.type)) problems.push(`${path}: type array`);
  if (node.type === 'object') {
    if (node.additionalProperties !== false) problems.push(`${path}: additionalProperties must be false`);
    const keys = Object.keys(node.properties || {});
    const missing = keys.filter((k) => !(node.required || []).includes(k));
    if (missing.length) problems.push(`${path}: not required: ${missing.join(', ')}`);
  }
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf']) if (k in node) problems.push(`${path}: ${k} isn't supported`);
  for (const [k, v] of Object.entries(node)) if (typeof v === 'object') walk(v, `${path}.${k}`, problems);
}

test('the AI schemas only use supported JSON Schema', () => {
  for (const [name, schema] of [['draft', draftSchema()], ['mapping', MAPPING_SCHEMA], ['assistant', ASSIST]]) {
    const problems = [];
    walk(schema, name, problems);
    assert.deepEqual(problems, [], problems.join('\n'));
  }
});
