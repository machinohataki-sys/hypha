// V0.5 E0 D4 — F1 harness CLI for D3.1 schema
//
// Run:
//   node app/scripts/run-f1.js <topic>                        # rater mode (production)
//   node app/scripts/run-f1.js <topic> --truth-source=ground  # author-truth (DEVELOPMENT mode)
//   node app/scripts/run-f1.js --help

'use strict';

const harness = require('../lib/evaluator/f1-harness');

function _parseArgs(argv) {
  const args = { topic: null, truth_source: 'rater', help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--truth-source=')) args.truth_source = a.slice('--truth-source='.length);
    else if (!args.topic && !a.startsWith('--')) args.topic = a;
  }
  return args;
}

async function main() {
  const args = _parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage:
  node app/scripts/run-f1.js <topic>                        # rater mode (default)
  node app/scripts/run-f1.js <topic> --truth-source=ground  # DEVELOPMENT mode (author truth)

Truth sources:
  rater   — uses rater_a/rater_b majority. Requires kappa >= ${harness.KAPPA_GATE} on topic. Production.
  ground  — uses candidate_responses[i].features_hit_truth (author-rated). Bypasses kappa.
            DEVELOPMENT MODE marker emitted; not a production F1 number.

Exit codes:
  0 — F1 >= ${harness.F1_TARGET} (E1 target) AND mode-appropriate gate passed
  1 — F1 < ${harness.F1_TARGET} OR gate failed OR no evaluable
  2 — usage error
`);
    process.exit(2);
  }
  if (!args.topic) { console.error('[run-f1] topic required'); process.exit(2); }
  if (!['ground', 'rater'].includes(args.truth_source)) {
    console.error(`[run-f1] --truth-source=ground or rater required (got "${args.truth_source}")`);
    process.exit(2);
  }

  if (args.truth_source === 'ground') {
    console.log('============================================================');
    console.log('  DEVELOPMENT MODE — synthetic ground truth, NOT production');
    console.log('  F1 reported here is against author-rated candidate truth,');
    console.log('  not human-rater majority. Use --truth-source=rater for');
    console.log('  production F1 once kappa >= ' + harness.KAPPA_GATE + ' is reached.');
    console.log('============================================================\n');
  }

  const result = await harness.runHarness(args.topic, { truth_source: args.truth_source });

  if (result.error) {
    console.error(`[run-f1] error: ${result.error}`);
    process.exit(1);
  }

  console.log(`topic: ${result.topic}`);
  console.log(`  truth_source: ${result.truth_source}${result.development_mode ? ' [DEV]' : ''}`);
  console.log(`  gate_passed: ${result.gate_passed}`);
  if (!result.gate_passed) {
    console.log(`  gate_reason: ${result.gate_reason}`);
    console.log(`\n[run-f1] FAIL: gate. Run app/scripts/label-cli.js first.`);
    process.exit(1);
  }
  if (result.kappa_at_run != null) {
    console.log(`  kappa_at_run: ${result.kappa_at_run.toFixed(4)}`);
  }
  console.log(`  n_items: ${result.n_items}`);
  console.log(`  n_evaluated: ${result.n_evaluated}`);
  if (result.n_skipped) console.log(`  n_skipped: ${result.n_skipped} (${result.n_disagree || 0} due to rater disagreement)`);
  if (result.n_evaluated === 0) {
    console.log(`\n[run-f1] FAIL: no evaluable candidate-responses.`);
    process.exit(1);
  }
  console.log(`  tp: ${result.n_tp}, fp: ${result.n_fp}, fn: ${result.n_fn}, tn: ${result.n_tn}`);
  console.log(`  precision: ${result.precision != null ? result.precision.toFixed(4) : 'null'}`);
  console.log(`  recall: ${result.recall != null ? result.recall.toFixed(4) : 'null'}`);
  console.log(`  f1: ${result.f1 != null ? result.f1.toFixed(4) : 'null'} (target ${harness.F1_TARGET})`);
  if (!result.f1_pass) {
    console.log(`\n[run-f1] FAIL: F1 below target.`);
    process.exit(1);
  }
  console.log(`\n[run-f1] PASS: F1 ${result.f1.toFixed(4)} >= ${harness.F1_TARGET}.${result.development_mode ? ' (DEV mode)' : ''}`);
  process.exit(0);
}

if (require.main === module) {
  main().catch(err => { console.error(`[run-f1] error: ${err.message}`); process.exit(1); });
}

module.exports = { main };
