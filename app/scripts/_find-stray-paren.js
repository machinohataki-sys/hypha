'use strict';
const fs = require('node:fs');
const src = fs.readFileSync(process.argv[2], 'utf8');
const stack = [];
let inLine = false, inBlock = false, inStr = null;
let line = 1, col = 0;
for (let i = 0; i < src.length; i += 1) {
  const ch = src[i];
  const nx = src[i + 1];
  if (ch === '\n') { line += 1; col = 0; } else { col += 1; }
  if (inLine) { if (ch === '\n') inLine = false; continue; }
  if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; i += 1; col += 1; } continue; }
  if (inStr) {
    if (ch === '\\') { i += 1; col += 1; continue; }
    if (ch === inStr) inStr = null;
    continue;
  }
  if (ch === '/' && nx === '/') { inLine = true; i += 1; col += 1; continue; }
  if (ch === '/' && nx === '*') { inBlock = true; i += 1; col += 1; continue; }
  if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
  if (ch === '(') stack.push({ line, col });
  else if (ch === ')') {
    if (stack.length === 0) { console.log('extra ) at', line + ':' + col); }
    else stack.pop();
  }
}
if (stack.length > 0) {
  console.log('unclosed ( at:');
  for (const e of stack) console.log(' ', e.line + ':' + e.col);
} else {
  console.log('balanced');
}
