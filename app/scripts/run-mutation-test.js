// V0.5 E0 Path A -- substrate validation via mutation testing.
//
// Prior auto-judge harness (run-eval-exec-channel.js) reported F1=1.0 because
// author-declared expected_pass was matched to verifier output at seed time
// (tautological). This harness measures REAL substrate signal:
//
//   For each item with verification_channel='code', take candidate.c1 (the
//   CORRECT candidate) and generate two arrays of variants:
//
//     - perturbations: semantic-preserving (expected_pass=true)
//     - mutations:     semantic-breaking   (expected_pass=false)
//
//   Run each variant through exec-cell.runCell with the item's timeout,
//   compute predicted_pass = (exit_code===0 AND stdout_hash===expected_hash),
//   tally TP/FP/FN/TN against transformation-implied ground truth.
//
//   FP > 0 = verifier let a real bug through (substrate too lenient).
//   FN > 0 = verifier rejected a semantic equivalent (substrate too strict).
//
// CLI: node app/scripts/run-mutation-test.js [topic]
// topic default = 'llm-systems'. Writes summary JSON to
//   vault/.evaluator/runs/d20-mutation-test.json
//
// Created 2026-05-11 on v0.5-substrate (V0.5 E0 Path A).

'use strict';

const fs = require('fs');
const path = require('path');
const golden = require('../lib/evaluator/golden-loader');
const execCell = require('../lib/evaluator/verification-channels/exec-cell');
const mutators = require('../lib/evaluator/mutators');

const F1_TARGET = 0.75;

function _vaultRoot() {
  return process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', 'vault');
}

function _runsDir() {
  const dir = path.join(_vaultRoot(), '.evaluator', 'runs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runMutationTest(topic) {
  const ledger = golden.loadTopic(topic);
  const items = (ledger.items || []).filter(it => it.verification_channel === 'code');

  if (items.length === 0) {
    return {
      type: 'mutation_test',
      topic,
      timestamp: new Date().toISOString(),
      n_c1: 0,
      n_perturbations: 0,
      n_mutations: 0,
      tp: 0, fp: 0, fn: 0, tn: 0,
      precision: null,
      recall: null,
      f1: null,
      per_test: [],
      per_transformation: {},
      interpretation: {
        fp_means: 'verifier missed a real bug -- substrate too lenient',
        fn_means: 'verifier rejected a semantic equivalent -- substrate too strict (hash-fragile)',
        f1_low_signal: 'substrate not ready; tighten or loosen verifier per FP/FN pattern',
        f1_high_signal: 'substrate is robust and strict -- E0 substrate thesis validated',
        narrative: `no code-channel items found in topic ${topic}`,
      },
    };
  }

  let tp = 0, fp = 0, fn = 0, tn = 0;
  let nPerturbations = 0, nMutations = 0;
  const perTest = [];
  const perTransformation = {}; // name -> {kind, expected_pass, total, matched}
  const skipped = []; // c1 codes that produced zero transforms

  let nC1 = 0;

  for (const item of items) {
    const cands = item.candidate_responses || [];
    const c1 = cands.find(c => c.id === 'c1');
    if (!c1 || typeof c1.code !== 'string') {
      skipped.push({ item_id: item.id, reason: 'no c1 with .code string' });
      continue;
    }
    const timeout = (item.exec_cell && item.exec_cell.timeout_ms) || 5000;
    const expectedHash = item.exec_cell && item.exec_cell.expected_stdout_hash;
    if (!expectedHash) {
      skipped.push({ item_id: item.id, reason: 'missing exec_cell.expected_stdout_hash' });
      continue;
    }

    nC1++;

    const perts = mutators.perturbations(c1.code);
    const muts = mutators.mutations(c1.code);

    if (perts.length === 0 && muts.length === 0) {
      skipped.push({ item_id: item.id, reason: 'no perturbations or mutations applicable' });
      continue;
    }

    const allVariants = perts.concat(muts);
    nPerturbations += perts.length;
    nMutations += muts.length;

    for (const v of allVariants) {
      let r;
      try {
        r = await execCell.runCell(v.mutated_code, { timeoutMs: timeout });
      } catch (err) {
        // exec-cell.runCell returns a resolved Promise even on spawn error,
        // so this branch should be unreachable; log honestly if reached.
        console.error(`[run-mutation-test] spawn error item=${item.id} name=${v.name}: ${err.message}`);
        r = {
          pass: false,
          stdout_hash: null,
          runtime_ms: 0,
          stderr_excerpt: `spawn error: ${err.message}`,
          exit_code: null,
        };
      }
      const predicted_pass = (r.exit_code === 0) && (r.stdout_hash === expectedHash);
      const expected_pass = v.expected_pass;
      const match = predicted_pass === expected_pass;

      if (expected_pass && predicted_pass) tp++;
      else if (!expected_pass && predicted_pass) fp++;
      else if (expected_pass && !predicted_pass) fn++;
      else tn++;

      // per-transformation aggregate
      const slot = perTransformation[v.name] || { kind: v.kind, expected_pass, total: 0, matched: 0, items: [] };
      slot.total++;
      if (match) slot.matched++;
      slot.items.push(item.id);
      perTransformation[v.name] = slot;

      perTest.push({
        item_id: item.id,
        kind: v.kind,
        name: v.name,
        expected_pass,
        predicted_pass,
        match,
        runtime_ms: r.runtime_ms,
        actual_hash: r.stdout_hash,
        expected_hash: expectedHash,
        exit_code: r.exit_code != null ? r.exit_code : null,
        stderr_excerpt: (r.stderr_excerpt || '').slice(0, 200),
      });
    }
  }

  const precision = (tp + fp) > 0 ? tp / (tp + fp) : null;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : null;
  const f1 = (precision != null && recall != null && (precision + recall) > 0)
    ? 2 * precision * recall / (precision + recall)
    : null;

  // Roll up per-transformation summary as kind-grouped lines (for banner).
  const byKind = { perturbation: [], mutation: [] };
  for (const [name, slot] of Object.entries(perTransformation)) {
    byKind[slot.kind].push({ name, total: slot.total, matched: slot.matched });
  }
  for (const k of Object.keys(byKind)) {
    byKind[k].sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    type: 'mutation_test',
    topic,
    timestamp: new Date().toISOString(),
    n_c1: nC1,
    n_perturbations: nPerturbations,
    n_mutations: nMutations,
    tp, fp, fn, tn,
    precision,
    recall,
    f1,
    f1_target: F1_TARGET,
    f1_pass: f1 != null && f1 >= F1_TARGET,
    per_transformation: perTransformation,
    per_transformation_by_kind: byKind,
    skipped,
    per_test: perTest,
    interpretation: {
      fp_means: 'verifier missed a real bug -- substrate too lenient',
      fn_means: 'verifier rejected a semantic equivalent -- substrate too strict (hash-fragile)',
      f1_low_signal: 'substrate not ready; tighten or loosen verifier per FP/FN pattern',
      f1_high_signal: 'substrate is robust and strict -- E0 substrate thesis validated',
    },
  };
}

function _printBanner(result) {
  const f1Str = result.f1 == null ? 'null' : result.f1.toFixed(4);
  const pStr = result.precision == null ? 'null' : result.precision.toFixed(4);
  const rStr = result.recall == null ? 'null' : result.recall.toFixed(4);
  console.log(`[run-mutation-test] SUBSTRATE_F1_MUTATION_TEST topic=${result.topic} c1_count=${result.n_c1}`);
  console.log(`[run-mutation-test] perturbations_total=${result.n_perturbations} mutations_total=${result.n_mutations}`);
  console.log(`[run-mutation-test] TP=${result.tp} (perturbation passed -- robust)`);
  console.log(`[run-mutation-test] FP=${result.fp} (mutation passed -- verifier missed bug)`);
  console.log(`[run-mutation-test] FN=${result.fn} (perturbation rejected -- verifier too strict)`);
  console.log(`[run-mutation-test] TN=${result.tn} (mutation rejected -- verifier caught bug)`);
  console.log(`[run-mutation-test] precision=${pStr} recall=${rStr} F1=${f1Str} (target ${result.f1_target}, pass=${result.f1_pass})`);
  if (result.per_transformation_by_kind) {
    if (result.per_transformation_by_kind.perturbation.length > 0) {
      console.log(`[run-mutation-test] perturbations breakdown (preserved/total):`);
      for (const r of result.per_transformation_by_kind.perturbation) {
        console.log(`  ${r.name}: ${r.matched}/${r.total}`);
      }
    }
    if (result.per_transformation_by_kind.mutation.length > 0) {
      console.log(`[run-mutation-test] mutations breakdown (rejected/total):`);
      for (const r of result.per_transformation_by_kind.mutation) {
        console.log(`  ${r.name}: ${r.matched}/${r.total}`);
      }
    }
  }
  if (result.skipped && result.skipped.length > 0) {
    console.log(`[run-mutation-test] skipped ${result.skipped.length} item(s):`);
    for (const s of result.skipped) console.log(`  -`, JSON.stringify(s));
  }
}

async function main(argv) {
  argv = argv || process.argv;
  const topic = argv[2] || 'llm-systems';
  const outPath = path.join(_runsDir(), 'd20-mutation-test.json');

  const result = await runMutationTest(topic);
  _printBanner(result);

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`[run-mutation-test] wrote ${outPath}`);
}

if (require.main === module) {
  main().catch(err => { console.error('[run-mutation-test] fatal:', err); process.exit(2); });
}

module.exports = {
  runMutationTest,
  F1_TARGET,
};
