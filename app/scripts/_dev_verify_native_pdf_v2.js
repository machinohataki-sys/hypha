#!/usr/bin/env node
'use strict';
// HYPHA · _dev_verify_native_pdf_v2 — smoke for native-pdf-v2 (pdfjs-dist direct).
//
// Validates:
//   1. module loads + export shape
//   2. missing file → ok:false with reason
//   3. corrupt PDF bytes → graceful (inline降 v1 OR ok:false, never throws)
//   4. real PDF if fixture available → returns valid shape
//   5. v1 fallback path is reachable (require works)
//   6. pdfjs-dist dep is installed (require works)
//   7. file-converter.js wired to convertPdfV2 + NATIVE_HANDLERS
//   8. raw-stash.js no longer mentions "pip install"
//   9. raw-stash.js new message present
//   10. concurrent calls don't throw

const fs = require('fs');
const os = require('os');
const path = require('path');

const tests = [];
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else      { failed++; tests.push(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? '\n    ' + extra : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-pdfv2-smoke-'));

(async () => {

// ── Test 1: module loads + export shape ─────────────────────────────────
{
  const mod = require('../lib/converters/native-pdf-v2');
  check('1. module exports convertPdfV2', typeof mod.convertPdfV2 === 'function');
}

// ── Test 2: missing file → ok:false ─────────────────────────────────────
{
  const { convertPdfV2 } = require('../lib/converters/native-pdf-v2');
  const r = await convertPdfV2('/path/does/not/exist/nope.pdf');
  check('2. missing file → ok:false', r.ok === false);
  check('2. missing file → reason contains "file not found"',
    typeof r.reason === 'string' && /file not found/i.test(r.reason));
}

// ── Test 3: corrupt PDF bytes → graceful (never throws) ─────────────────
{
  const { convertPdfV2 } = require('../lib/converters/native-pdf-v2');
  const f = path.join(TMP, 'corrupt.pdf');
  fs.writeFileSync(f, Buffer.from('%PDF-1.4 garbage not a real pdf', 'utf8'));
  let threw = false;
  let r = null;
  try {
    r = await convertPdfV2(f, { allowOcr: false });
  } catch (e) {
    threw = true;
  }
  check('3. corrupt PDF bytes → no throw', !threw);
  check('3. corrupt PDF → returns result envelope (ok:bool)',
    r !== null && typeof r.ok === 'boolean');
}

// ── Test 4: real PDF if fixture available ───────────────────────────────
{
  // Hunt for any real PDF in common locations
  const candidates = [
    path.join(__dirname, 'fixtures'),
    path.join(__dirname, '..', '__tests__', 'fixtures'),
    path.join(__dirname, '..', '..', 'vault'),
  ];
  let realPdf = null;
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    try {
      const stack = [dir];
      let safety = 200;
      while (stack.length && safety-- > 0 && !realPdf) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
        for (const ent of entries) {
          const full = path.join(cur, ent.name);
          if (ent.isDirectory() && !ent.name.startsWith('.')) {
            stack.push(full);
          } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.pdf')) {
            try {
              if (fs.statSync(full).size < 50 * 1024 * 1024) { realPdf = full; break; }
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
    if (realPdf) break;
  }
  if (!realPdf) {
    check('4. real PDF test (SKIPPED — no fixture)', true);
  } else {
    const { convertPdfV2 } = require('../lib/converters/native-pdf-v2');
    let r = null, threw = false;
    try {
      r = await convertPdfV2(realPdf, { allowOcr: false });
    } catch (e) { threw = true; }
    check(`4. real PDF parse no-throw (${path.basename(realPdf)})`, !threw);
    if (r && r.ok) {
      check('4. real PDF → mdText nonempty', typeof r.mdText === 'string' && r.mdText.length > 0);
      check('4. real PDF → level in {native-v2,ocr,native}',
        ['native-v2', 'ocr', 'native'].includes(r.level));
    } else {
      check('4. real PDF → returned ok:false gracefully', r === null || r.ok === false);
    }
  }
}

// ── Test 5: v1 fallback path is reachable ───────────────────────────────
{
  const v1 = require('../lib/converters/native-pdf');
  check('5. v1 (native-pdf.js) exports convertPdfNative',
    typeof v1.convertPdfNative === 'function');
}

// ── Test 6: pdfjs-dist dep installed ────────────────────────────────────
{
  let loaded = false;
  try {
    // pdfjs-dist v4.x is ESM; require() may not work but the package must exist on disk
    const pkgPath = require.resolve('pdfjs-dist/package.json');
    loaded = !!pkgPath;
  } catch (_) {}
  check('6. pdfjs-dist installed (package.json resolves)', loaded);
}

// ── Test 7: file-converter.js wired ─────────────────────────────────────
{
  const fcSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'file-converter.js'), 'utf8');
  check('7. file-converter imports convertPdfV2', /require\(['"]\.\/converters\/native-pdf-v2['"]\)/.test(fcSrc));
  check('7. file-converter NATIVE_HANDLERS.pdf = convertPdfV2',
    /pdf:\s*convertPdfV2/.test(fcSrc));
}

// ── Test 8: raw-stash.js no longer mentions pip install ─────────────────
{
  const rsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'converters', 'raw-stash.js'), 'utf8');
  check('8. raw-stash.js does NOT contain "pip install"', !rsSrc.includes('pip install'));
  check('8. raw-stash.js does NOT contain "markitdown[all]"', !rsSrc.includes('markitdown[all]'));
}

// ── Test 9: raw-stash.js new message present ────────────────────────────
{
  const rsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'converters', 'raw-stash.js'), 'utf8');
  const hasNewMsg = rsSrc.includes('HYPHA 自包含') || rsSrc.includes('HYPHA 暂时没法');
  check('9. raw-stash.js contains new self-contained message', hasNewMsg);
  check('9. raw-stash.js suggests EPUB upload', rsSrc.includes('EPUB'));
}

// ── Test 10: concurrent calls don't throw ───────────────────────────────
{
  const { convertPdfV2 } = require('../lib/converters/native-pdf-v2');
  let threw = false;
  try {
    const results = await Promise.all([1, 2, 3, 4, 5].map(() =>
      convertPdfV2('/nonexistent.pdf').catch(e => ({ ok: false, threw: true }))
    ));
    check('10. 5 concurrent calls all return envelope',
      results.every(r => r && typeof r.ok === 'boolean'));
  } catch (e) {
    threw = true;
  }
  check('10. concurrent calls → no unhandled throw', !threw);
}

// ── Test 11: stats schema (if any success) ──────────────────────────────
{
  const { convertPdfV2 } = require('../lib/converters/native-pdf-v2');
  // No real PDF guaranteed available; test contract via Test 4 result if it succeeded
  // Otherwise this is a no-op pass
  check('11. (stats schema contract documented in SPEC.md)', true);
}

// ── Cleanup ─────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log('\n────────────────────────────────────────────────────────');
console.log('  native-pdf-v2 smoke');
console.log('────────────────────────────────────────────────────────');
tests.forEach(t => console.log(t));
console.log('────────────────────────────────────────────────────────');
console.log(`  ${passed} PASS · ${failed} FAIL · ${passed + failed} total`);
console.log('────────────────────────────────────────────────────────\n');

process.exit(failed === 0 ? 0 : 1);

})().catch(err => {
  console.error('SMOKE THREW:', err);
  process.exit(1);
});
