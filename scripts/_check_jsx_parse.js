// JSX parse check using @babel/parser. Returns 0 on success, 1 on parse error.
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const target = process.argv[2];
if (!target) { console.error('usage: node _check_jsx_parse.js <path>'); process.exit(2); }
const src = fs.readFileSync(target, 'utf8');
try {
  parser.parse(src, {
    sourceType: 'script',
    plugins: ['jsx'],
    errorRecovery: false,
  });
  console.log('PARSE OK', target);
} catch (e) {
  console.error('PARSE FAIL', target);
  console.error(e.message);
  process.exit(1);
}
