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

async function runHarness(topic, opts) {
  opts = opts || {};
  const truthSource = opts.truth_source || 'rater';

  if (!['ground', 'rater'].includes(truthSource)) {
    return { topic, error: `unknown truth_source "${truthSource}"; expected 'ground' or 'rater'` };
  }

  // IRR gate (rater mode only)
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

  const items = _readItems(topic);
  if (items.length === 0) {
    return { topic, gate_passed: true, n_items: 0, f1: null, reason: 'no items' };
  }

  let tp = 0, fp = 0, fn_ = 0, tn = 0;
  const perCandidate = [];
  let nEvaluated = 0;
  let nSkipped = 0;
  let nDisagree = 0;

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
    n_items: items.length,
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
