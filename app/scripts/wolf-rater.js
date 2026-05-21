// V0.5 E0 D7-D8 — Wolf-as-rater-b synthetic LLM rater (BASELINE only)
//
// Purpose:
//   Provide a fallback rater_b sidecar so D10 evaluation pipeline can run
//   end-to-end without waiting on a second human rater. NOT a substitute
//   for human IRR. The κ produced from rater_a (author truth) versus
//   rater_b (Wolf model) is a CALIBRATION number, not Cohen's κ as
//   classically interpreted (which assumes two independent humans).
//
// Banner:
//   WOLF_RATER_BASELINE — calibration to author truth, NOT human IRR.
//
// Run:
//   node app/scripts/wolf-rater.js philosophy [--rater=b] [--limit=N]
//
// Inputs:
//   vault/.evaluator/golden/<topic>/*.json  (excluding *.rater-*.json)
//
// Output:
//   vault/.evaluator/golden/<topic>/<id>.rater-b.json
//   shape: { rater_id, name, ts, ratings: { c1: {features_hit, verdict, justification}, ... },
//            wolf_baseline: true, model: "<providerId>:<model>", cost_estimate_yuan: <num> }
//
// Cost cap:
//   ¥0.50/topic. Aborts before next call if cumulative est cost > cap.
//   Estimate: ~¥0.005/call (GLM-4.5-Air; Phase D T4_JUDGE).
//
// Cancellation:
//   Honors global._hyphaCancelCheck if present (Hypha standard); always
//   respects SIGINT (ctrl-c) by exiting after current candidate.
//
// Created 2026-05-10 D7-D8 by Machino-C. NOT touched by Machino-A/B (file-disjoint).

'use strict';

const fs = require('fs');
const path = require('path');
const llm = require('../lib/llm');

const VAULT_ROOT = process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', 'vault');
const COST_CAP_YUAN = 0.50;
const COST_PER_CALL_YUAN = 0.005; // GLM-4.5-Air rough estimate; refined per provider response if available
const RATER_NAME = 'wolf';
const BANNER = '============================================================\n' +
               '  WOLF_RATER_BASELINE — calibration to author truth,\n' +
               '  NOT human inter-rater reliability. Use --truth-source=rater\n' +
               '  numbers as ADVISORY pipeline-sanity checks only.\n' +
               '============================================================';

function _parseArgs(argv) {
  const args = { topic: null, rater: 'b', limit: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--rater=')) args.rater = a.slice('--rater='.length);
    else if (a.startsWith('--limit=')) args.limit = Number(a.slice('--limit='.length));
    else if (!args.topic && !a.startsWith('--')) args.topic = a;
  }
  return args;
}

function _printHelp() {
  console.log(`
Wolf-as-rater-b synthetic LLM rater (V0.5 D7-D8)

Usage:
  node app/scripts/wolf-rater.js <topic> [--rater=b] [--limit=N]

Behavior:
  - Reads vault/.evaluator/golden/<topic>/*.json (excludes sidecars).
  - For every (item, candidate_response) pair without an existing rater_b
    entry in the rater-b sidecar, calls T4_JUDGE LLM to rate.
  - Writes vault/.evaluator/golden/<topic>/<id>.rater-b.json (atomic-rename).
  - Cost cap: ¥${COST_CAP_YUAN}/topic. Aborts before next call when exceeded.

Banner: WOLF_RATER_BASELINE (calibration, not human IRR).
`);
}

function _listGoldenItems(topic) {
  const dir = path.join(VAULT_ROOT, '.evaluator', 'golden', topic);
  if (!fs.existsSync(dir)) {
    console.error(`[wolf-rater] golden directory missing: ${dir}`);
    return null;
  }
  const files = fs.readdirSync(dir).filter(f =>
    f.endsWith('.json') && !f.startsWith('_') && !f.includes('.rater-')
  );
  const items = [];
  for (const f of files) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      items.push({ obj, dir });
    } catch (err) {
      console.warn(`[wolf-rater] skip malformed ${f}: ${err.message}`);
    }
  }
  return { items, dir };
}

function _readSidecar(dir, itemId, raterId) {
  const p = path.join(dir, `${itemId}.rater-${raterId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (err) {
    console.warn(`[wolf-rater] sidecar ${itemId}.rater-${raterId} parse error: ${err.message}; starting fresh`);
    return null;
  }
}

function _writeSidecar(dir, itemId, raterId, sidecar) {
  const p = path.join(dir, `${itemId}.rater-${raterId}.json`);
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function _buildPrompt(item, candidate) {
  const featuresList = (item.answer_features || []).map(f => {
    const alts = (f.alt_phrasings || []).slice(0, 7).join(' / ');
    return `  ${f.id}: ${f.claim}${alts ? ` [variants: ${alts}]` : ''}`;
  }).join('\n');
  const validIds = (item.answer_features || []).map(f => f.id).join(', ');
  return [
    'You are a strict rubric grader. Given an instance, a list of features the answer should hit, and a candidate response, identify which features the candidate hits.',
    '',
    `Instance: ${item.instance}`,
    '',
    'Features (each must be substantively present, not just keyword-matched):',
    featuresList,
    '',
    `Candidate (${candidate.id}): ${candidate.text}`,
    '',
    `Respond with ONLY a JSON object: {"features_hit": [<subset of: ${validIds}>], "justification": "<one short line>"}.`,
    'No prose outside the JSON. No code fences.',
  ].join('\n');
}

function _validateFeaturesHit(raw, validIds) {
  if (!Array.isArray(raw)) return [];
  const valid = new Set(validIds);
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (typeof r !== 'string') continue;
    const id = r.trim().toLowerCase();
    if (valid.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

function _verdict(featuresHit, kThreshold) {
  return featuresHit.length >= kThreshold ? 'pass' : 'fail';
}

function _shouldCancel() {
  if (typeof global._hyphaCancelCheck === 'function') {
    try { return Boolean(global._hyphaCancelCheck()); } catch (_e) { return false; }
  }
  return false;
}

async function _rateOne(item, candidate) {
  const prompt = _buildPrompt(item, candidate);
  const dispatch = await llm.executeChat('T4_JUDGE', {
    messages: [{ role: 'user', content: prompt }],
    json: true,
    maxTokens: 300,
    temperature: 0,
  });
  const validIds = (item.answer_features || []).map(f => f.id);
  const parsed = dispatch.result || {};
  const featuresHit = _validateFeaturesHit(parsed.features_hit, validIds);
  const justification = typeof parsed.justification === 'string'
    ? parsed.justification.trim().slice(0, 280)
    : '';
  return {
    features_hit: featuresHit,
    justification,
    model_tag: `${dispatch.providerId}:${dispatch.model}`,
  };
}

async function main() {
  const args = _parseArgs(process.argv);
  if (args.help) { _printHelp(); return; }
  if (!args.topic) { console.error('[wolf-rater] topic required'); process.exit(2); }
  if (args.rater !== 'b') {
    console.error('[wolf-rater] --rater=b is the only supported value (rater_a reserved for human/author).');
    process.exit(2);
  }

  console.log(BANNER);
  console.log(`[wolf-rater] topic=${args.topic} rater=${args.rater}`);

  const listed = _listGoldenItems(args.topic);
  if (!listed) process.exit(2);
  const { items, dir } = listed;
  if (items.length === 0) {
    console.error('[wolf-rater] no items found');
    process.exit(2);
  }

  const limit = args.limit || Infinity;

  // Build pairs and load existing sidecars per item
  const sidecarByItem = new Map();
  const pairs = [];
  for (const { obj } of items) {
    const sidecar = _readSidecar(dir, obj.id, args.rater) || {
      rater_id: args.rater,
      name: RATER_NAME,
      ts: null,
      ratings: {},
      wolf_baseline: true,
      model: null,
      cost_estimate_yuan: 0,
    };
    sidecarByItem.set(obj.id, sidecar);
    const cands = obj.candidate_responses || [];
    const ratings = sidecar.ratings || {};
    for (const c of cands) {
      if (ratings[c.id] && Array.isArray(ratings[c.id].features_hit)) continue;
      pairs.push({ item: obj, candidate: c });
      if (pairs.length >= limit) break;
    }
    if (pairs.length >= limit) break;
  }

  if (pairs.length === 0) {
    console.log('[wolf-rater] all (item, candidate) pairs already rated by rater_b. Nothing to do.');
    return;
  }

  const projectedCost = pairs.length * COST_PER_CALL_YUAN;
  console.log(`[wolf-rater] ${pairs.length} pair(s) to rate; projected ¥${projectedCost.toFixed(3)} (cap ¥${COST_CAP_YUAN.toFixed(2)})`);
  if (projectedCost > COST_CAP_YUAN) {
    console.log(`[wolf-rater] WARN: projected cost exceeds cap; will stop mid-run.`);
  }

  let interrupted = false;
  process.once('SIGINT', () => { interrupted = true; console.log('\n[wolf-rater] SIGINT received; finishing current candidate then exiting.'); });

  let cumulativeCost = 0;
  let labeledCount = 0;
  let failedCount = 0;
  const seenModels = new Set();

  for (const { item, candidate } of pairs) {
    if (interrupted || _shouldCancel()) {
      console.log('[wolf-rater] cancellation requested; stopping.');
      break;
    }
    if (cumulativeCost + COST_PER_CALL_YUAN > COST_CAP_YUAN) {
      console.log(`[wolf-rater] cost cap ¥${COST_CAP_YUAN.toFixed(2)} reached (cumulative ¥${cumulativeCost.toFixed(3)}); stopping.`);
      break;
    }
    let rating;
    try {
      rating = await _rateOne(item, candidate);
    } catch (err) {
      failedCount++;
      console.warn(`[wolf-rater] FAIL ${item.id}::${candidate.id}: ${err.message}`);
      continue;
    }
    cumulativeCost += COST_PER_CALL_YUAN;
    seenModels.add(rating.model_tag);

    const sidecar = sidecarByItem.get(item.id);
    sidecar.rater_id = args.rater;
    sidecar.name = RATER_NAME;
    sidecar.ts = new Date().toISOString();
    sidecar.wolf_baseline = true;
    sidecar.model = rating.model_tag;
    sidecar.cost_estimate_yuan = (sidecar.cost_estimate_yuan || 0) + COST_PER_CALL_YUAN;
    sidecar.ratings = sidecar.ratings || {};
    sidecar.ratings[candidate.id] = {
      features_hit: rating.features_hit,
      verdict: _verdict(rating.features_hit, item.k_threshold),
      justification: rating.justification,
      ts: new Date().toISOString(),
    };
    _writeSidecar(dir, item.id, args.rater, sidecar);
    labeledCount++;
    console.log(`[wolf-rater] ${item.id}::${candidate.id} hit=[${rating.features_hit.join(',')}] verdict=${sidecar.ratings[candidate.id].verdict} model=${rating.model_tag}`);
  }

  console.log('---');
  console.log(`[wolf-rater] labeled ${labeledCount}, failed ${failedCount}, models=${[...seenModels].join('|') || 'none'}`);
  console.log(`[wolf-rater] cumulative est cost: ¥${cumulativeCost.toFixed(3)} of ¥${COST_CAP_YUAN.toFixed(2)} cap`);
  console.log(`[wolf-rater] sidecar dir: ${dir}`);
  console.log('[wolf-rater] reminder: WOLF_RATER_BASELINE — calibration to author truth, not human IRR.');
  if (failedCount > 0) process.exit(1);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[wolf-rater] error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, _buildPrompt, _validateFeaturesHit, _verdict };
