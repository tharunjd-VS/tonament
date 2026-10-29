'use strict';

// The stylesheet: every rule has a selector. (A dropped selector leaves its
// declarations in front of the next rule, and the browser silently ignores both.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('every rule in styles.css has a selector', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = []; // 'rule' (declarations inside) or 'at' (@media, @supports: rules inside)
  let prelude = '';
  let line = 1;
  for (const ch of css) {
    if (ch === '\n') line += 1;
    const inRule = blocks[blocks.length - 1] === 'rule';
    if (ch === '{') {
      assert.ok(inRule || !prelude.includes(';'), `rule before line ${line} has no selector: ${prelude.trim().slice(0, 80)}`);
      blocks.push(prelude.trim().startsWith('@') ? 'at' : 'rule');
      prelude = '';
    } else if (ch === '}') {
      assert.ok(blocks.pop(), `extra } at line ${line}`);
      prelude = '';
    } else if (ch === ';' && (inRule || prelude.trim().startsWith('@'))) {
      prelude = ''; // a declaration, or @import / @charset
    } else {
      prelude += ch;
    }
  }
  assert.equal(blocks.length, 0, 'unclosed {');
});
