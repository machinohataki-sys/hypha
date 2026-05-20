#!/usr/bin/env node
'use strict';
// HYPHA · _dev_verify_fidelity_scorer — smoke for spec-validator + fidelity-scorer
// + native-docx / native-html ok:false paths + file-converter auto-rerun.
//
// Validates:
//   1-4   spec-validator: valid pass, HTML tag fail, inline style fail, raw XML fail
//   5-6   countHeadings + countBlocks
//   7-10  scoreFidelity: empty / healthy / ocr-garbage / raw-stash penalty
//   11-12 tier function
//   13    native-docx ok:false on missing file
//   14    native-html ok:false on missing file
//   15-16 file-converter auto-rerun preserves best, attempts records score

const fs = require('fs');
const os = require('os');
const path = require('path');

const tests = [];
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else      { failed++; tests.push(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? '\n    ' + extra : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-fidelity-smoke-'));

(async () => {

const { validateSpec, countHeadings, countBlocks } = require('../lib/converters/spec-validator');
const { scoreFidelity, tier } = require('../lib/converters/fidelity-scorer');

// ── Test 1-4: validateSpec ─────────────────────────────────────────────
{
  const goodMd = `# Heading\n\nA paragraph.\n\n- list item\n- another\n\n\`\`\`python\nprint('hi')\n\`\`\`\n`;
  const r = validateSpec(goodMd);
  check('1. validateSpec — clean MD valid:true', r.valid === true, JSON.stringify(r.violations));
}

{
  const badHtml = `# Title\n\n<div class="ad">spam</div>\n\nParagraph.\n`;
  const r = validateSpec(badHtml);
  check('2. validateSpec — <div> tag → invalid', r.valid === false && r.violations.some(v => v.rule === 'no-html-passthrough'));
}

{
  const badStyle = `# Title\n\n<p style="color:red">text</p>\n`;
  const r = validateSpec(badStyle);
  check('3. validateSpec — inline style → invalid',
    r.valid === false && r.violations.some(v => v.rule === 'no-inline-style'));
}

{
  const badXml = `<?xml version="1.0"?>\n# Title\n`;
  const r = validateSpec(badXml);
  check('4. validateSpec — raw XML preamble → invalid',
    r.valid === false && r.violations.some(v => v.rule === 'no-raw-xml'));
}

// ── Test 5-6: countHeadings + countBlocks ──────────────────────────────
{
  const md = `# h1\n## h2\n## h2b\n### h3\n\nplain\n`;
  const h = countHeadings(md);
  check('5. countHeadings — 4 total, h1=1 h2=2 h3=1',
    h.total === 4 && h.byLevel.h1 === 1 && h.byLevel.h2 === 2 && h.byLevel.h3 === 1,
    JSON.stringify(h));
}

{
  const md = `\`\`\`js\nx\n\`\`\`\n\n- a\n- b\n\n| h1 | h2 |\n|----|----|\n| a  | b  |\n\n![alt](pic.png)\n\n> quote\n\nref[^1]\n[^1]: footnote\n`;
  const b = countBlocks(md);
  check('6. countBlocks — code=1 lists=2 tables=1 images=1 quotes=1 footnotes>=2',
    b.codeBlocks === 1 && b.lists === 2 && b.tables === 1 && b.imageRefs === 1 && b.blockquotes === 1 && b.footnotes >= 2,
    JSON.stringify(b));
}

// ── Test 7-10: scoreFidelity ───────────────────────────────────────────
{
  const r = scoreFidelity({ mdText: '', ext: 'pdf' });
  check('7. scoreFidelity — empty → score 0', r.score === 0);
}

{
  // Healthy DOCX-like content
  const md = [
    '# Chapter 1',
    '',
    'This is the opening paragraph of a sample document. It has multiple sentences. This should be enough text.',
    '',
    '## Section 1.1',
    '',
    'Another paragraph with some content. Long enough to count properly.',
    '',
    '- Item one',
    '- Item two',
    '- Item three',
    '',
    'Closing paragraph here.',
    '',
    '## Section 1.2',
    '',
    'Yet more text in the body of the section.',
    '',
    '```python',
    'def hello():',
    '    print("world")',
    '```',
  ].join('\n');
  const r = scoreFidelity({ mdText: md, ext: 'docx', parsed_level: 'native' });
  check('8. scoreFidelity — healthy DOCX → score >= 0.6',
    r.score >= 0.6, `actual=${r.score} breakdown=${JSON.stringify(r.breakdown)}`);
  check('8b. scoreFidelity — tier "mid" or "high"',
    r.tier === 'mid' || r.tier === 'high', `actual=${r.tier}`);
}

{
  // OCR garbage — few unique chars + no structure
  const md = 'aaaaaa aaa aa aaaa a aa aaa aaaa aaa aa\n'.repeat(50);
  const r = scoreFidelity({ mdText: md, ext: 'pdf', parsed_level: 'ocr' });
  check('9. scoreFidelity — OCR-garbage → score < 0.5',
    r.score < 0.5, `actual=${r.score}`);
}

{
  // Raw-stash stub
  const stub = `# mystery.bin\n\n> 未解析原文件\n> 大小: 0.01 MB\n`;
  const r = scoreFidelity({ mdText: stub, ext: 'bin', parsed_level: 'raw-stash' });
  check('10. scoreFidelity — raw-stash → score < 0.3 (heavy penalty)',
    r.score < 0.3, `actual=${r.score}`);
}

// ── Test 11-12: tier ──────────────────────────────────────────────────
{
  check('11. tier — 0.9 → high', tier(0.9) === 'high');
  check('11b. tier — 0.65 → mid', tier(0.65) === 'mid');
  check('11c. tier — 0.3 → low', tier(0.3) === 'low');
}

{
  check('12. tier — boundary 0.80 → high', tier(0.80) === 'high');
  check('12b. tier — boundary 0.50 → mid', tier(0.50) === 'mid');
}

// ── Test 13: native-docx missing file ─────────────────────────────────
{
  const { convertDocxNative } = require('../lib/converters/native-docx');
  const r = await convertDocxNative('/no/such/file.docx');
  check('13. native-docx — missing file ok:false', r.ok === false);
}

// ── Test 14: native-html missing file ─────────────────────────────────
{
  const { convertHtmlNative } = require('../lib/converters/native-html');
  const r = await convertHtmlNative('/no/such/file.html');
  check('14. native-html — missing file ok:false', r.ok === false);
}

// ── Test 15-16: file-converter auto-rerun + attempts records score ────
{
  const { convertFile } = require('../lib/file-converter');
  const f = path.join(TMP, 'hello.txt');
  fs.writeFileSync(f, 'hello\nworld\n');
  const r = await convertFile(f);
  check('15. file-converter — .txt resolves ok:true',
    r.ok === true, JSON.stringify({level: r.level, score: r.fidelity_score}));
  check('15b. file-converter — fidelity field present',
    r.fidelity && typeof r.fidelity.score === 'number');
  check('15c. file-converter — attempts records fidelity_score on ok levels',
    r.attempts.some(a => a.ok === true && typeof a.fidelity_score === 'number'));
}

{
  const { convertFile } = require('../lib/file-converter');
  const f = path.join(TMP, 'unknown.nokia');
  fs.writeFileSync(f, 'blob');
  const r = await convertFile(f);
  check('16. file-converter — unknown ext → raw-stash with fidelity',
    r.ok === true && r.level === 'raw-stash' && typeof r.fidelity.score === 'number');
}

// ── Cleanup ─────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

// ── Report ──────────────────────────────────────────────────────────────
console.log('\n=== HYPHA · Fidelity Scorer + Spec Validator smoke ===\n');
for (const line of tests) console.log(line);
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} PASS\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);

})();
