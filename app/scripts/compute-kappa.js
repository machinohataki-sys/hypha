// V0.5 E0 — Cohen's kappa CLI for golden-set topics
//
// Wraps app/lib/evaluator/golden-loader.loadTopic and prints IRR statistics.
// IRR-before-F1 rule: F1 harness (Day 4-5) refuses to run on topic with kappa < 0.7.
//
// Run:
//   node app/scripts/compute-kappa.js philosophy
//   node app/scripts/compute-kappa.js --all
//
// Exit codes:
//   0 — kappa >= 0.7 (passes IRR gate)
//   1 — kappa < 0.7 OR null OR insufficient data
//   2 — usage / argument error
//
// Created 2026-05-10 on v0.5-substrate.

'use strict';

const golden = require('../lib/evaluator/golden-loader');

const KAPPA_GATE = 0.7;

function _formatTopic(r) {
  console.log(`topic: ${r.topic}`);
  console.log(`  n_items: ${r.n_items}`);
  console.log(`  n_double_coded: ${r.n_double_coded || 0}`);
  console.log(`  n_single_coded: ${r.n_single_coded || 0}`);
  console.log(`  n_ratified: ${r.n_ratified || 0}`);
  if (r.kappa == null) {
    console.log(`  kappa: null (${r.kappa_reason || r.reason || 'unknown'})`);
  } else {
    console.log(`  kappa: ${r.kappa.toFixed(4)} (${r.kappa_interpretation})`);
    console.log(`  P_o: ${(r.kappa_P_o || 0).toFixed(4)}`);
    console.log(`  P_e: ${(r.kappa_P_e || 0).toFixed(4)}`);
    console.log(`  agreement: ${r.kappa_n_agreement} / ${r.kappa_n}`);
  }
  if (r.skipped && r.skipped.length) {
    console.log(`  skipped: ${r.skipped.length} malformed file(s)`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage:
  node app/scripts/compute-kappa.js <topic>     # one topic
  node app/scripts/compute-kappa.js --all       # every topic under vault/.evaluator/golden/

IRR gate: kappa >= ${KAPPA_GATE} required for F1 harness to run on the topic.
Exit 0 if kappa >= ${KAPPA_GATE}; exit 1 otherwise.
`);
    process.exit(2);
  }

  if (argv[0] === '--all') {
    const result = golden.loadAllTopics();
    if (result.reason) {
      console.error(`[compute-kappa] ${result.reason}`);
      process.exit(1);
    }
    let allPass = result.topics.length > 0;
    for (const t of result.topics) {
      _formatTopic(t);
      if (t.kappa == null || t.kappa < KAPPA_GATE) allPass = false;
      console.log('');
    }
    process.exit(allPass ? 0 : 1);
  }

  const topic = argv[0];
  const r = golden.loadTopic(topic);
  _formatTopic(r);
  if (r.kappa == null) {
    console.log(`\n[compute-kappa] FAIL: kappa is null. ${r.kappa_reason || r.reason || ''}`);
    process.exit(1);
  }
  if (r.kappa < KAPPA_GATE) {
    console.log(`\n[compute-kappa] FAIL: kappa ${r.kappa.toFixed(4)} < gate ${KAPPA_GATE}.`);
    process.exit(1);
  }
  console.log(`\n[compute-kappa] PASS: kappa ${r.kappa.toFixed(4)} >= gate ${KAPPA_GATE}.`);
  process.exit(0);
}

if (require.main === module) main();

module.exports = { KAPPA_GATE };
