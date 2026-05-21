// V0.5 D4 R7 — committed κ smoke fixture (per MEOW R2 finding)
//
// Reproduces the κ=0.78 trace claimed in vault/.dev-log/2026-05-10-d3-fix.md.
// Loads philosophy-001.rater-a.json + philosophy-001.rater-b.json synthetic
// sidecars (committed alongside this script as test fixtures, NOT real labels).
//
// Run: node app/scripts/test-kappa-smoke.js
// Exit 0 if κ in expected range; 1 otherwise.

'use strict';

const path = require('path');
const golden = require('../lib/evaluator/golden-loader');

const EXPECTED_KAPPA_MIN = 0.65;
const EXPECTED_KAPPA_MAX = 0.85;
const EXPECTED_INTERPRETATION = 'substantial';

function main() {
  // Override vault root to use test sidecars colocated with this script's
  // expected target. The fixture lives at vault/.evaluator/golden/philosophy/
  // for philosophy-001 only.
  const result = golden.loadTopic('philosophy');

  console.log('topic: philosophy');
  console.log('  n_items:', result.n_items);
  console.log('  n_double_coded:', result.n_double_coded);
  console.log('  n_ratified:', result.n_ratified);
  console.log('  kappa:', result.kappa);
  console.log('  kappa_n:', result.kappa_n);
  console.log('  kappa_n_agreement:', result.kappa_n_agreement);
  console.log('  kappa_n_disagreement:', result.kappa_n_disagreement);
  console.log('  P_o:', result.kappa_P_o);
  console.log('  P_e:', result.kappa_P_e);
  console.log('  interpretation:', result.kappa_interpretation);

  if (result.kappa == null) {
    console.error(`\n[test-kappa-smoke] FAIL: kappa is null. Reason: ${result.kappa_reason || result.reason}`);
    console.error('Verify philosophy-001.rater-a.json and philosophy-001.rater-b.json sidecars exist.');
    process.exit(1);
  }

  if (result.kappa < EXPECTED_KAPPA_MIN || result.kappa > EXPECTED_KAPPA_MAX) {
    console.error(`\n[test-kappa-smoke] FAIL: kappa ${result.kappa.toFixed(4)} outside expected [${EXPECTED_KAPPA_MIN}, ${EXPECTED_KAPPA_MAX}].`);
    process.exit(1);
  }

  if (result.kappa_interpretation !== EXPECTED_INTERPRETATION) {
    console.error(`\n[test-kappa-smoke] FAIL: interpretation "${result.kappa_interpretation}" != expected "${EXPECTED_INTERPRETATION}".`);
    process.exit(1);
  }

  console.log(`\n[test-kappa-smoke] PASS: κ ${result.kappa.toFixed(4)} in expected range [${EXPECTED_KAPPA_MIN}, ${EXPECTED_KAPPA_MAX}], interpretation "${EXPECTED_INTERPRETATION}".`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { main, EXPECTED_KAPPA_MIN, EXPECTED_KAPPA_MAX };
