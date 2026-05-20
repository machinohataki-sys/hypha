'use strict';
// Smoke for app/lib/track/url-pinger.js — offline only.

const path = require('node:path');
const { pingUrl, extractTitle, extractOgImage } = require(path.join(__dirname, '..', 'lib', 'track', 'url-pinger.js'));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`PASS ${name}`); pass++; }
  else { console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

(async () => {
  // UP1: extractTitle on `<title>Test</title>` returns "Test"
  const t1 = extractTitle('<html><head><title>Test</title></head></html>');
  check('UP1 extractTitle basic', t1 === 'Test', `got ${JSON.stringify(t1)}`);

  // UP2: extractTitle on missing title returns null
  const t2 = extractTitle('<html><head></head><body>no title here</body></html>');
  check('UP2 extractTitle missing → null', t2 === null, `got ${JSON.stringify(t2)}`);

  // UP3: extractOgImage on og:image meta returns URL
  const body3 = '<html><head><meta property="og:image" content="https://example.com/img.png"></head></html>';
  const og = extractOgImage(body3);
  check('UP3 extractOgImage property-first', og === 'https://example.com/img.png', `got ${JSON.stringify(og)}`);

  // UP3b: also reversed attribute order (content-first)
  const body3b = '<html><head><meta content="https://example.com/r.png" property="og:image"></head></html>';
  const ogB = extractOgImage(body3b);
  check('UP3b extractOgImage content-first', ogB === 'https://example.com/r.png', `got ${JSON.stringify(ogB)}`);

  // UP4: pingUrl rejects invalid protocol with error='BAD_PROTOCOL'
  const r4 = await pingUrl('ftp://example.com/file.txt');
  check('UP4 pingUrl ftp:// → BAD_PROTOCOL',
    r4 && r4.error === 'BAD_PROTOCOL' && r4.status_code === null,
    `got ${JSON.stringify(r4)}`);

  // Bonus: bad URL string → BAD_URL or BAD_URL_PARSE (defense in depth, doesn't count toward 4/4)
  const r5 = await pingUrl('x');
  check('UP5 pingUrl short string → BAD_URL', r5 && r5.error === 'BAD_URL', `got ${JSON.stringify(r5)}`);

  console.log(`\n${pass}/${pass + fail} PASS`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
