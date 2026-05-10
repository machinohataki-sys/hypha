'use strict';

/**
 * HYPHA · v0.1 G3 acceptance gate runner — Production Evidence binary check
 * incl. ≥30% non-LLM-direct (paste detection).
 *
 * Reads scripts/g3-production-fixture.json (5 cases), runs computeLocalBaseline
 * directly with each case's recentAssistantMessages, compares actual vs
 * expected for both `passed` (= shape_match locally) and `paste_detected`.
 *
 * Pass criteria: 5/5 cases match. Any mismatch → tune PASTE_SIMILARITY_THRESHOLD
 * in app/lib/scoring.js (currently 0.70) and re-run.
 *
 * Usage:
 *   node scripts/g3-production-baseline.cjs
 *
 * No LLM calls — pure local computation, runs in ~50ms.
 */

const path = require('path');
const fs = require('fs');
const { computeLocalBaseline } = require(path.resolve(__dirname, '..', 'app', 'lib', 'scoring.js'));

const FIXTURE_PATH = path.resolve(__dirname, 'g3-production-fixture.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

const cases = fixture.cases;
let pass = 0;
let fail = 0;
const failures = [];

console.log('G3 Production Evidence + Paste Detection — runner');
console.log('-'.repeat(60));

for (const c of cases) {
  const baseline = computeLocalBaseline(
    c.plan.micro_proof,
    c.response,
    'production',
    c.recentAssistantMessages || [],
  );
  const actualPassed = baseline.shape_match;
  const actualPasteDetected = baseline.paste_detected === true;
  const passedOk = actualPassed === c.expected_passed;
  const pasteOk = actualPasteDetected === c.expected_paste_detected;
  const ok = passedOk && pasteOk;

  if (ok) pass++; else fail++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(36)}` +
    ` passed=${actualPassed}/${c.expected_passed}` +
    ` paste=${actualPasteDetected}/${c.expected_paste_detected}` +
    ` sim=${baseline.paste_max_similarity}`
  );
  if (!ok) {
    failures.push({
      name: c.name,
      expected: { passed: c.expected_passed, paste_detected: c.expected_paste_detected },
      actual: { passed: actualPassed, paste_detected: actualPasteDetected, max_similarity: baseline.paste_max_similarity },
    });
  }
}

console.log('-'.repeat(60));
console.log(`Result: ${pass}/${cases.length} pass`);

if (fail > 0) {
  console.log('\nFailures:');
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log('G3 GATE: PASS ✓');
