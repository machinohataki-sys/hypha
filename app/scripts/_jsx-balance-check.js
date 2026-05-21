// Throwaway JSX brace/paren balance checker. Strips comments and string
// literals, then counts `{`,`}`,`(`,`)`. Used by Machino (W3.2 ship) to
// validate screen-product-blueprint.jsx + app.jsx route insertion without a
// transpiler dependency.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2];
if (!file) { console.error('usage: node _jsx-balance-check.js <file>'); process.exit(2); }
const src = fs.readFileSync(file, 'utf8');

let o = 0, c = 0, p = 0, q = 0;
let inLine = false, inBlock = false, inStr = null, prev = '';
for (let i = 0; i < src.length; i += 1) {
  const ch = src[i];
  const nx = src[i + 1];
  if (inLine) { if (ch === '\n') inLine = false; prev = ch; continue; }
  if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; i += 1; } prev = ch; continue; }
  if (inStr) {
    if (ch === '\\') { i += 1; prev = ch; continue; }
    if (ch === inStr) inStr = null;
    prev = ch;
    continue;
  }
  if (ch === '/' && nx === '/') { inLine = true; i += 1; prev = ch; continue; }
  if (ch === '/' && nx === '*') { inBlock = true; i += 1; prev = ch; continue; }
  if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; prev = ch; continue; }
  if (ch === '{') o += 1;
  else if (ch === '}') c += 1;
  else if (ch === '(') p += 1;
  else if (ch === ')') q += 1;
  prev = ch;
}
console.log(path.basename(file), 'open{=', o, 'close}=', c, 'open(=', p, 'close)=', q,
  '| braceΔ=', o - c, 'parenΔ=', p - q);
process.exit(o === c && p === q ? 0 : 1);
