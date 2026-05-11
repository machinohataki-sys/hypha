// V0.5 E0 D4 — F1 harness for D3.1 feature-set schema
//
// REWRITTEN 2026-05-10 from earlier D4 attempt that assumed item-level rater.verdict.
// D3.1 schema stores rater.ratings[candidate_id]. F1 harness now iterates per
// (item, candidate_response) pair, runs sealed-rubric.verifyFeatures, scores
// against truth.
//
// Two truth sources:
//   'ground' — uses candidate_responses[i].features_hit_truth (author-rated).
//              Bypasses kappa gate. Marked DEVELOPMENT MODE in output.
//   'rater'  — uses rater majority (or single rater) per candidate. Requires
//              kappa >= 0.7 (golden-loader.loadTopic).kappa.

'use strict';

const path = require('path');
const fs = require('fs');
const golden = require('./golden-loader');
const sealed = require('./verification-channels/sealed-rubric');
const execCell = require('./verification-channels/exec-cell');

const KAPPA_GATE = 0.7;
const F1_TARGET = 0.75;

function _vaultRoot() {
  return process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', '..', 'vault');
}

function _readItems(topic) {
  // D5 fix: delegate to golden-loader so sidecar merging + sidecar filename
  // exclusion are unified (loader.loadTopic now returns items[]). Avoids the
  // bug where f1-harness read .rater-{a,b}.json sidecar files as items and
  // then could not find ratings on them.
  const ledger = golden.loadTopic(topic);
  return ledger.items || [];
}

function _truthFromGround(item, candidate) {
  const truth = candidate.features_hit_truth;
  if (!Array.isArray(truth)) return null;
  return { features_hit: truth, pass: truth.length >= (item.k_threshold || 1) };
}

function _truthFromRaterMajority(item, candidate) {
  const a = item.rater_a && item.rater_a.ratings && item.rater_a.ratings[candidate.id];
  const b = item.rater_b && item.rater_b.ratings && item.rater_b.ratings[candidate.id];
  if (!a && !b) return null;
  if (a && !b) return { features_hit: a.features_hit, pass: a.verdict === 'pass', single_rater: true };
  if (!a && b) return { features_hit: b.features_hit, pass: b.verdict === 'pass', single_rater: true };
  // Both present: union of agreed features (intersection); pass if both agree
  const aSet = new Set(a.features_hit || []);
  const bSet = new Set(b.features_hit || []);
  const intersection = [...aSet].filter(x => bSet.has(x));
  const passAgree = (a.verdict === 'pass') && (b.verdict === 'pass');
  const failAgree = (a.verdict === 'fail') && (b.verdict === 'fail');
  if (passAgree || failAgree) {
    return { features_hit: intersection, pass: passAgree, single_rater: false };
  }
  return { features_hit: intersection, pass: null, single_rater: false, disagree: true };
}

// V0.5 E0 PIVOT (2026-05-11): exec-channel inner runner. Mirrors logic in
// app/scripts/run-eval-exec-channel.js but exposed here so f1-harness can
// dispatch by verification_channel without spawning a separate process.
// Ground truth = candidate.expected_pass. No rater, no kappa, no truth_source.
async function _runExecChannelInner(items) {
  let tp = 0, fp = 0, fn_ = 0, tn = 0;
  const perCandidate = [];
  let nEvaluated = 0;
  let nSkipped = 0;

  for (const item of items) {
    const expectedHash = item.exec_cell && item.exec_cell.expected_stdout_hash;
    const timeout = (item.exec_cell && item.exec_cell.timeout_ms) || 5000;
    if (!expectedHash) { nSkipped += (item.candidate_responses || []).length; continue; }
    for (const cand of (item.candidate_responses || [])) {
      if (typeof cand.code !== 'string' || typeof cand.expected_pass !== 'boolean') {
        nSkipped++;
        continue;
      }
      const r = await execCell.runCell(cand.code, { timeoutMs: timeout });
      const predPass = (r.exit_code === 0) && (r.stdout_hash === expectedHash);
      const expPass = cand.expected_pass;

      if (expPass && predPass) tp++;
      else if (!expPass && predPass) fp++;
      else if (expPass && !predPass) fn_++;
      else tn++;

      nEvaluated++;
      perCandidate.push({
        item_id: item.id,
        candidate_id: cand.id,
        predicted_pass: predPass,
        expected_pass: expPass,
        match: predPass === expPass,
        runtime_ms: r.runtime_ms,
        actual_hash: r.stdout_hash,
        expected_hash: expectedHash,
        exit_code: r.exit_code,
      });
    }
  }
  return { tp, fp, fn_, tn, perCandidate, nEvaluated, nSkipped };
}

async function runHarness(topic, opts) {
  opts = opts || {};
  const truthSource = opts.truth_source || 'rater';

  // V0.5 E0 PIVOT: dispatch by verification_channel. Code-channel items skip the
  // rater/kappa path entirely — ground truth is author-declared candidate.expected_pass,
  // verifier is exec-cell hash match. No truth_source applies.
  const allItems = _readItems(topic);
  const codeItems = allItems.filter(it => it.verification_channel === 'code');
  const proseItems = allItems.filter(it => it.verification_channel !== 'code');

  // Pure-code-channel topic: bypass sealed-rubric truth-source entirely.
  if (codeItems.length > 0 && proseItems.length === 0) {
    if (codeItems.length === 0) {
      return { topic, gate_passed: true, n_items: 0, f1: null, reason: 'no items' };
    }
    const ex = await _runExecChannelInner(codeItems);
    const precision = (ex.tp + ex.fp) > 0 ? ex.tp / (ex.tp + ex.fp) : null;
    const recall = (ex.tp + ex.fn_) > 0 ? ex.tp / (ex.tp + ex.fn_) : null;
    const f1 = (precision != null && recall != null && (precision + recall) > 0)
      ? 2 * precision * recall / (precision + recall)
      : null;
    return {
      topic,
      gate_passed: true,
      truth_source: 'exec_channel_auto_judge',
      development_mode: false,
      channel: 'EXEC_CHANNEL_AUTO_JUDGE',
      rationale: 'non-LLM verifier; ground truth = author-declared candidate.expected_pass; binary code-runs hash match',
      n_items: codeItems.length,
      n_evaluated: ex.nEvaluated,
      n_skipped: ex.nSkipped,
      n_tp: ex.tp,
      n_fp: ex.fp,
      n_fn: ex.fn_,
      n_tn: ex.tn,
      precision,
      recall,
      f1,
      f1_target: F1_TARGET,
      f1_pass: f1 != null && f1 >= F1_TARGET,
      per_candidate: ex.perCandidate,
    };
  }

  if (!['ground', 'rater'].includes(truthSource)) {
    return { topic, error: `unknown truth_source "${truthSource}"; expected 'ground' or 'rater'` };
  }

  // IRR gate (rater mode only) — applies only to prose channel.
  if (truthSource === 'rater') {
    const ledger = golden.loadTopic(topic);
    if (ledger.kappa == null || ledger.kappa < KAPPA_GATE) {
      return {
        topic,
        gate_passed: false,
        gate_reason: ledger.kappa == null
          ? `kappa null: ${ledger.kappa_reason || ledger.reason || 'unknown'}`
          : `kappa ${ledger.kappa.toFixed(4)} < gate ${KAPPA_GATE}`,
        kappa_at_run: ledger.kappa,
        truth_source: 'rater',
        development_mode: false,
        n_items: ledger.n_items,
        f1: null,
      };
    }
  }

  // Mixed topics: run sealed-rubric on prose items, exec-cell on code items, fold both into one tally.
  const items = proseItems;
  if (items.length === 0 && codeItems.length === 0) {
    return { topic, gate_passed: true, n_items: 0, f1: null, reason: 'no items' };
  }

  let tp = 0, fp = 0, fn_ = 0, tn = 0;
  const perCandidate = [];
  let nEvaluated = 0;
  let nSkipped = 0;
  let nDisagree = 0;

  // Fold code-channel results in first (if any) — they need no truth-source.
  if (codeItems.length > 0) {
    const ex = await _runExecChannelInner(codeItems);
    tp += ex.tp; fp += ex.fp; fn_ += ex.fn_; tn += ex.tn;
    nEvaluated += ex.nEvaluated; nSkipped += ex.nSkipped;
    for (const row of ex.perCandidate) perCandidate.push({ ...row, channel: 'code' });
  }

  for (const item of items) {
    const cands = item.candidate_responses || [];
    for (const cand of cands) {
      const truth = (truthSource === 'ground')
        ? _truthFromGround(item, cand)
        : _truthFromRaterMajority(item, cand);
      if (!truth || truth.pass == null) {
        nSkipped++;
        if (truth && truth.disagree) nDisagree++;
        continue;
      }
      const verified = sealed.verifyFeatures(cand.text, item);
      const truthPass = truth.pass;
      const predPass = verified.predicted_pass;

      if (truthPass && predPass) tp++;
      else if (!truthPass && predPass) fp++;
      else if (truthPass && !predPass) fn_++;
      else tn++;

      nEvaluated++;
      perCandidate.push({
        item_id: item.id,
        candidate_id: cand.id,
        truth_features: truth.features_hit,
        predicted_features: verified.features_hit,
        truth_pass: truthPass,
        predicted_pass: predPass,
        match: truthPass === predPass,
        channel: 'prose',
      });
    }
  }

  const precision = (tp + fp) > 0 ? tp / (tp + fp) : null;
  const recall = (tp + fn_) > 0 ? tp / (tp + fn_) : null;
  const f1 = (precision != null && recall != null && (precision + recall) > 0)
    ? 2 * precision * recall / (precision + recall)
    : null;

  const result = {
    topic,
    gate_passed: true,
    truth_source: truthSource,
    development_mode: truthSource === 'ground',
    n_items: items.length + codeItems.length,
    n_items_prose: items.length,
    n_items_code: codeItems.length,
    n_evaluated: nEvaluated,
    n_skipped: nSkipped,
    n_disagree: nDisagree,
    n_tp: tp,
    n_fp: fp,
    n_fn: fn_,
    n_tn: tn,
    precision,
    recall,
    f1,
    f1_target: F1_TARGET,
    f1_pass: f1 != null && f1 >= F1_TARGET,
    per_candidate: perCandidate,
  };

  if (truthSource === 'rater') {
    const ledger = golden.loadTopic(topic);
    result.kappa_at_run = ledger.kappa;
  }

  return result;
}

module.exports = {
  runHarness,
  KAPPA_GATE,
  F1_TARGET,
};
