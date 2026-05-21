// Balance-checker for JSX-ish source. Strings/comments are skipped; this
// is not a full JSX parser, just a sanity check that braces/parens/brackets
// pair up. Run: node scripts/_check_jsx_balance.js <path>
const fs = require('fs');
const path = process.argv[2];
if (!path) { console.error('usage: node _check_jsx_balance.js <path>'); process.exit(2); }
const s = fs.readFileSync(path, 'utf8');
let braces = 0, parens = 0, brackets = 0;
let inS = false, inD = false, inT = false, inLineC = false, inBlockC = false;
let line = 1;
const stack = [];
for (let i = 0; i < s.length; i++) {
  const c = s[i], n = s[i + 1];
  if (c === '\n') line++;
  if (inLineC) { if (c === '\n') inLineC = false; continue; }
  if (inBlockC) { if (c === '*' && n === '/') { inBlockC = false; i++; } continue; }
  if (inS) {
    if (c === '\\') { i++; continue; }
    if (c === "'") inS = false;
    continue;
  }
  if (inD) {
    if (c === '\\') { i++; continue; }
    if (c === '"') inD = false;
    continue;
  }
  if (inT) {
    if (c === '\\') { i++; continue; }
    if (c === '`') inT = false;
    continue;
  }
  if (c === '/' && n === '/') { inLineC = true; continue; }
  if (c === '/' && n === '*') { inBlockC = true; continue; }
  if (c === "'") { inS = true; continue; }
  if (c === '"') { inD = true; continue; }
  if (c === '`') { inT = true; continue; }
  if (c === '{') { braces++; stack.push({ ch: '{', line }); }
  else if (c === '}') { braces--; stack.pop(); }
  else if (c === '(') { parens++; stack.push({ ch: '(', line }); }
  else if (c === ')') { parens--; stack.pop(); }
  else if (c === '[') { brackets++; stack.push({ ch: '[', line }); }
  else if (c === ']') { brackets--; stack.pop(); }
}
console.log(JSON.stringify({ braces, parens, brackets, length: s.length, lines: line }));
if (braces !== 0 || parens !== 0 || brackets !== 0) {
  console.error('UNBALANCED');
  if (stack.length) console.error('top of stack:', stack.slice(-5));
  process.exit(1);
}
console.log('OK');
