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

function _readGoldenItems(topic) {
  const dir = path.join(_vaultRoot(), '.evaluator', 'golden', topic);
  if (!fs.existsSync(dir)) {
    return { items: [], dir, missing: true };
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
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
      items.push(obj);
    } catch (err) {
      skipped.push({ file: f, reason: `parse error: ${err.message}` });
    }
  }
  return { items, dir, skipped };
}

function _computeKappa(items) {
  // Filter to items with both raters' verdicts
  const both = items.filter(it =>
    it.rater_a && it.rater_b &&
    VALID_VERDICTS.has(it.rater_a.verdict) &&
    VALID_VERDICTS.has(it.rater_b.verdict)
  );

  if (both.length < 2) {
    return {
      kappa: null,
      reason: 'insufficient double-coded items (need >= 2)',
      n: both.length,
    };
  }

  const n = both.length;
  let agree = 0;
  for (const it of both) {
    if (it.rater_a.verdict === it.rater_b.verdict) agree++;
  }
  const P_o = agree / n;

  // Marginal frequencies per rater
  const marginalA = {};
  const marginalB = {};
  for (const v of VALID_VERDICTS) {
    marginalA[v] = 0;
    marginalB[v] = 0;
  }
  for (const it of both) {
    marginalA[it.rater_a.verdict]++;
    marginalB[it.rater_b.verdict]++;
  }

  let P_e = 0;
  for (const v of VALID_VERDICTS) {
    P_e += (marginalA[v] / n) * (marginalB[v] / n);
  }

  if (P_e >= 1.0) {
    return {
      kappa: null,
      reason: 'P_e degenerate (single-verdict marginal)',
      n,
      P_o,
      P_e,
    };
  }

  const kappa = (P_o - P_e) / (1 - P_e);

  return {
    kappa,
    n,
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
