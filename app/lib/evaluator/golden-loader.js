// V0.5 E0 — golden-set loader + IRR Cohen's kappa computer
//
// Loads vault/.evaluator/golden/<topic>/*.json and computes inter-rater reliability.
// IRR-before-F1 rule (constitution): kappa >= 0.7 must precede any F1 number.
//
// Cohen's kappa formula:
//   kappa = (P_o - P_e) / (1 - P_e)
//   where P_o = observed agreement = n_agreement / n_total
//         P_e = expected agreement by chance, computed from marginal verdict frequencies
//
// Created 2026-05-10 on v0.5-substrate.

'use strict';

const fs = require('fs');
const path = require('path');

const VALID_VERDICTS = new Set(['pass', 'fail', 'unclear']);

function _vaultRoot() {
  return process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', '..', 'vault');
}

// D4 (R1 fix per MEOW R2): rater work lives in sidecar files
//   <id>.rater-a.json + <id>.rater-b.json
// alongside the main item JSON. Eliminates the race condition where parallel
// rater_a + rater_b writes to the same main JSON would silently overwrite.
// Loader merges sidecars into item.rater_a / item.rater_b at read time so
// downstream consumers (compute-kappa, f1-harness) see the merged shape.

function _readSidecar(dir, itemId, raterId) {
  const sidecarPath = path.join(dir, `${itemId}.rater-${raterId}.json`);
  if (!fs.existsSync(sidecarPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  } catch (err) {
    console.warn(`[golden-loader] skip malformed sidecar ${itemId}.rater-${raterId}.json: ${err.message}`);
    return null;
  }
}

function _computeAgreementFromSidecars(item, sidecarA, sidecarB) {
  if (!sidecarA || !sidecarB) return null;
  const cands = item.candidate_responses || [];
  const ratingsA = (sidecarA.ratings) || {};
  const ratingsB = (sidecarB.ratings) || {};
  const both = cands.every(c => ratingsA[c.id] && ratingsB[c.id]);
  if (!both) return null;
  return cands.every(c => ratingsA[c.id].verdict === ratingsB[c.id].verdict);
}

function _readGoldenItems(topic) {
  const dir = path.join(_vaultRoot(), '.evaluator', 'golden', topic);
  if (!fs.existsSync(dir)) {
    return { items: [], dir, missing: true };
  }
  const files = fs.readdirSync(dir).filter(f =>
    f.endsWith('.json') && !f.startsWith('_') && !f.includes('.rater-')
  );
  const items = [];
  const skipped = [];
  for (const f of files) {
    const fullPath = path.join(dir, f);
    try {
      const raw = fs.readFileSync(fullPath, 'utf8');
      const obj = JSON.parse(raw);
      if (!obj.id) {
        skipped.push({ file: f, reason: 'missing id' });
        continue;
      }
      // Merge sidecars into item.rater_a / item.rater_b (compatibility with
      // _computeKappa + f1-harness which expect this shape on the item).
      const sidecarA = _readSidecar(dir, obj.id, 'a');
      const sidecarB = _readSidecar(dir, obj.id, 'b');
      if (sidecarA) obj.rater_a = sidecarA;
      if (sidecarB) obj.rater_b = sidecarB;
      obj.agreement = _computeAgreementFromSidecars(obj, sidecarA, sidecarB);
      items.push(obj);
    } catch (err) {
      skipped.push({ file: f, reason: `parse error: ${err.message}` });
    }
  }
  return { items, dir, skipped };
}

function _computeKappa(items) {
  // D3.1 — κ now computed over per-candidate per-feature binary cells.
  // Each (item, candidate, feature) triple yields two binary labels (rater_a hit / rater_b hit).
  // Cohen's κ over the full binary cell set.

  const cells = []; // {a: 0|1, b: 0|1}
  let itemsWithBothRaters = 0;

  for (const item of items) {
    const ra = item.rater_a;
    const rb = item.rater_b;
    if (!ra || !rb || !ra.ratings || !rb.ratings) continue;
    const cands = item.candidate_responses || [];
    const features = item.answer_features || [];
    if (cands.length === 0 || features.length === 0) continue;

    let participated = false;
    for (const cand of cands) {
      const a = ra.ratings[cand.id];
      const b = rb.ratings[cand.id];
      if (!a || !b || !Array.isArray(a.features_hit) || !Array.isArray(b.features_hit)) continue;
      participated = true;
      const aSet = new Set(a.features_hit);
      const bSet = new Set(b.features_hit);
      for (const f of features) {
        cells.push({ a: aSet.has(f.id) ? 1 : 0, b: bSet.has(f.id) ? 1 : 0 });
      }
    }
    if (participated) itemsWithBothRaters++;
  }

  if (cells.length < 4) {
    return {
      kappa: null,
      reason: 'insufficient double-coded cells (need >= 4)',
      n: cells.length,
    };
  }

  const n = cells.length;
  let agree = 0;
  let aPos = 0;
  let bPos = 0;
  for (const c of cells) {
    if (c.a === c.b) agree++;
    if (c.a === 1) aPos++;
    if (c.b === 1) bPos++;
  }
  const P_o = agree / n;

  // Binary marginal: P(a=1)*P(b=1) + P(a=0)*P(b=0)
  const pA1 = aPos / n;
  const pB1 = bPos / n;
  const P_e = pA1 * pB1 + (1 - pA1) * (1 - pB1);

  if (P_e >= 1.0) {
    return {
      kappa: null,
      reason: 'P_e degenerate (single-class marginal)',
      n,
      P_o,
      P_e,
    };
  }

  const kappa = (P_o - P_e) / (1 - P_e);

  return {
    kappa,
    n,
    n_items_double_coded: itemsWithBothRaters,
    n_agreement: agree,
    n_disagreement: n - agree,
    P_o,
    P_e,
    interpretation: _interpretKappa(kappa),
  };
}

function _interpretKappa(k) {
  if (k == null) return 'unknown';
  if (k < 0) return 'worse-than-chance';
  if (k < 0.2) return 'slight';
  if (k < 0.4) return 'fair';
  if (k < 0.6) return 'moderate';
  if (k < 0.8) return 'substantial';
  return 'almost-perfect';
}

function loadTopic(topic) {
  const { items, dir, missing, skipped } = _readGoldenItems(topic);
  if (missing) {
    return {
      topic,
      n_items: 0,
      kappa: null,
      reason: `golden directory missing: ${dir}`,
    };
  }

  const both = items.filter(it => it.rater_a && it.rater_b);
  const partial = items.filter(it => (it.rater_a && !it.rater_b) || (!it.rater_a && it.rater_b));
  const ratifiedSubset = items.filter(it => it.lifecycle === 'ratified');

  const kappaResult = _computeKappa(items);

  return {
    topic,
    dir,
    n_items: items.length,
    n_double_coded: both.length,
    n_single_coded: partial.length,
    n_ratified: ratifiedSubset.length,
    skipped: skipped || [],
    kappa: kappaResult.kappa,
    kappa_n: kappaResult.n,
    kappa_n_agreement: kappaResult.n_agreement,
    kappa_n_disagreement: kappaResult.n_disagreement,
    kappa_P_o: kappaResult.P_o,
    kappa_P_e: kappaResult.P_e,
    kappa_interpretation: kappaResult.interpretation,
    kappa_reason: kappaResult.reason || null,
    items,
  };
}

function loadAllTopics() {
  const baseDir = path.join(_vaultRoot(), '.evaluator', 'golden');
  if (!fs.existsSync(baseDir)) {
    return { topics: [], reason: `golden base directory missing: ${baseDir}` };
  }
  const topicDirs = fs.readdirSync(baseDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
  return {
    topics: topicDirs.map(t => loadTopic(t)),
    base_dir: baseDir,
  };
}

module.exports = {
  loadTopic,
  loadAllTopics,
  _computeKappaInternal: _computeKappa,
  _interpretKappa,
};
