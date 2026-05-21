// V0.5 E0 PIVOT — auto-judge harness for exec-cell verification channel.
//
// EXEC_CHANNEL_AUTO_JUDGE — non-LLM verifier; ground truth = author-declared
// candidate.expected_pass; binary code-runs hash match.
//
// For each (item, candidate) pair where item.verification_channel === 'code':
//   1. Run candidate.code via exec-cell.runCell with item.exec_cell.timeout_ms.
//   2. Compute predicted_pass = (exit_code === 0) AND (stdout_hash === item.exec_cell.expected_stdout_hash).
//   3. Compare to author-declared candidate.expected_pass.
//   4. Tally TP / FP / FN / TN (positive = pass).
//
// Computes Precision / Recall / F1 over all candidates. There is NO rater. There
// is NO kappa. The harness is the verifier; the verifier IS the substrate.
//
// CLI:
//   node app/scripts/run-eval-exec-channel.js [topic]
//
// topic defaults to 'llm-systems'. Writes summary JSON to
//   vault/.evaluator/runs/d20-pivot-exec-channel.json
// containing { topic, n_items, n_candidates, precision, recall, f1,
//   per_candidate: [{item_id, candidate_id, predicted_pass, expected_pass,
//                    match, runtime_ms, actual_hash, expected_hash, stderr_excerpt}] }.
//
// Created 2026-05-11 on v0.5-substrate.

'use strict';

const fs = require('fs');
const path = require('path');
const golden = require('../lib/evaluator/golden-loader');
const execCell = require('../lib/evaluator/verification-channels/exec-cell');

const F1_TARGET = 0.75;

function _vaultRoot() {
  return process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', 'vault');
}

function _runsDir() {
  const dir = path.join(_vaultRoot(), '.evaluator', 'runs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runExecChannel(topic) {
  const ledger = golden.loadTopic(topic);
  const items = (ledger.items || []).filter(it => it.verification_channel === 'code');

  if (items.length === 0) {
    return {
      topic,
      gate_passed: true,
      reason: `no exec-channel items in topic ${topic} (loader saw ${ledger.n_items || 0} items, none with verification_channel='code')`,
      n_items: 0,
      n_candidates: 0,
      precision: null,
      recall: null,
      f1: null,
      per_candidate: [],
    };
  }

  let tp = 0, fp = 0, fn_ = 0, tn = 0;
  const perCandidate = [];
  const skipped = [];

  for (const item of items) {
    const cands = item.candidate_responses || [];
    const timeout = (item.exec_cell && item.exec_cell.timeout_ms) || 5000;
    const expectedHash = item.exec_cell && item.exec_cell.expected_stdout_hash;
    if (!expectedHash) {
      skipped.push({ item_id: item.id, reason: 'missing exec_cell.expected_stdout_hash' });
      continue;
    }

    for (const cand of cands) {
      if (typeof cand.code !== 'string' || typeof cand.expected_pass !== 'boolean') {
        skipped.push({ item_id: item.id, candidate_id: cand.id, reason: 'missing code or expected_pass' });
        continue;
      }
      const r = await execCell.runCell(cand.code, { timeoutMs: timeout });
      const predicted_pass = (r.exit_code === 0) && (r.stdout_hash === expectedHash);
      const expected_pass = cand.expected_pass;

      if (expected_pass && predicted_pass) tp++;
      else if (!expected_pass && predicted_pass) fp++;
      else if (expected_pass && !predicted_pass) fn_++;
      else tn++;

      perCandidate.push({
        item_id: item.id,
        candidate_id: cand.id,
        predicted_pass,
        expected_pass,
        match: predicted_pass === expected_pass,
        runtime_ms: r.runtime_ms,
        actual_hash: r.stdout_hash,
        expected_hash: expectedHash,
        exit_code: r.exit_code,
        stderr_excerpt: (r.stderr_excerpt || '').slice(0, 200),
      });
    }
  }

  const precision = (tp + fp) > 0 ? tp / (tp + fp) : null;
  const recall = (tp + fn_) > 0 ? tp / (tp + fn_) : null;
  const f1 = (precision != null && recall != null && (precision + recall) > 0)
    ? 2 * precision * recall / (precision + recall)
    : null;

  return {
    topic,
    channel: 'EXEC_CHANNEL_AUTO_JUDGE',
    rationale: 'non-LLM verifier; ground truth = author-declared candidate.expected_pass; binary code-runs hash match',
    timestamp: new Date().toISOString(),
    n_items: items.length,
    n_candidates: perCandidate.length,
    n_tp: tp,
    n_fp: fp,
    n_fn: fn_,
    n_tn: tn,
    precision,
    recall,
    f1,
    f1_target: F1_TARGET,
    f1_pass: f1 != null && f1 >= F1_TARGET,
    skipped,
    per_candidate: perCandidate,
  };
}

function _printBanner(result) {
  const f1Str = result.f1 == null ? 'null' : result.f1.toFixed(4);
  const pStr = result.precision == null ? 'null' : result.precision.toFixed(4);
  const rStr = result.recall == null ? 'null' : result.recall.toFixed(4);
  console.log(`[run-eval-exec-channel] EXEC_CHANNEL_AUTO_JUDGE topic=${result.topic} n_items=${result.n_items} n_candidates=${result.n_candidates}`);
  console.log(`[run-eval-exec-channel] TP=${result.n_tp} FP=${result.n_fp} FN=${result.n_fn} TN=${result.n_tn}`);
  console.log(`[run-eval-exec-channel] precision=${pStr} recall=${rStr} F1=${f1Str} (target ${result.f1_target}, pass=${result.f1_pass})`);
  if (result.skipped && result.skipped.length > 0) {
    console.log(`[run-eval-exec-channel] skipped ${result.skipped.length} candidate(s):`);
    for (const s of result.skipped) console.log(`  -`, JSON.stringify(s));
  }
}

async function main(argv) {
  argv = argv || process.argv;
  const topic = argv[2] || 'llm-systems';
  const outPath = path.join(_runsDir(), 'd20-pivot-exec-channel.json');

  const result = await runExecChannel(topic);
  _printBanner(result);

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`[run-eval-exec-channel] wrote ${outPath}`);
}

if (require.main === module) {
  main().catch(err => { console.error('[run-eval-exec-channel] fatal:', err); process.exit(2); });
}

module.exports = {
  runExecChannel,
  F1_TARGET,
};
