// V0.5 E0 D3.1 — HITL labeling CLI for golden-set items (feature-set version)
//
// REWRITTEN 2026-05-10 after MEOW HALT-2 (label-cli was rating wrong artifact).
//
// New flow:
//   For each item, iterate each candidate_response.
//   Show: instance + candidate_response + features list (claim + alt_phrasings).
//   Rater marks: which feature ids THIS candidate response hits (comma-separated).
//   Auto-compute verdict: features_hit.length >= k_threshold → 'pass' else 'fail'.
//
// Storage shape (rater_a or rater_b):
//   { name, ts, ratings: { c1: {features_hit: [...], verdict: 'pass'|'fail', justification}, c2: ..., c3: ... } }
//
// κ becomes per-candidate per-feature binary agreement (golden-loader handles).

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const VAULT_ROOT = process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', 'vault');
const VALID_RATERS = new Set(['a', 'b']);

function _printHelp() {
  console.log(`
HITL labeling CLI — V0.5 D3.1 feature-set version.

Usage:
  node app/scripts/label-cli.js <topic> --rater=<a|b> [--limit=<n>] [--item=<id>]
  node app/scripts/label-cli.js --help

Behavior (D3.1):
  - For each item with unrated candidate_responses, iterate each candidate.
  - Show: instance + candidate text + features list.
  - Prompt: "features hit (comma-sep f1,f2,f3 or 'none')? " + "justification (optional)? "
  - Verdict auto-computed from features_hit.length >= k_threshold.
  - Writes rater_a.ratings[<candidate_id>] or rater_b.ratings[<candidate_id>].
  - Skip individual candidate by entering 'skip'.
  - Idempotent: re-running skips already-rated (item, candidate) pairs.

Lifecycle:
  - Items start as lifecycle='draft'. Day 6+ ratify command transitions to 'ratified'.

IRR-before-F1 rule:
  - After labeling session: node app/scripts/compute-kappa.js <topic>
  - F1 harness refuses to run on κ < 0.7.
`);
}

function _parseArgs(argv) {
  const args = { topic: null, rater: null, limit: null, item: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--rater=')) args.rater = a.slice('--rater='.length);
    else if (a.startsWith('--limit=')) args.limit = Number(a.slice('--limit='.length));
    else if (a.startsWith('--item=')) args.item = a.slice('--item='.length);
    else if (!args.topic && !a.startsWith('--')) args.topic = a;
  }
  return args;
}

function _listItems(topic, itemFilter) {
  const dir = path.join(VAULT_ROOT, '.evaluator', 'golden', topic);
  if (!fs.existsSync(dir)) {
    console.error(`[label-cli] golden directory missing: ${dir}`);
    return null;
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const items = [];
  for (const f of files) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (itemFilter && obj.id !== itemFilter) continue;
      items.push({ fullPath: path.join(dir, f), obj });
    } catch (err) {
      console.warn(`[label-cli] skip malformed ${f}: ${err.message}`);
    }
  }
  return items;
}

function _validFeatureIds(item) {
  return new Set((item.answer_features || []).map(f => f.id));
}

function _parseFeaturesHit(input, validIds) {
  const trimmed = (input || '').trim().toLowerCase();
  if (!trimmed || trimmed === 'none') return [];
  if (trimmed === 'skip') return null;
  const parts = trimmed.split(/[,\s]+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (validIds.has(p)) out.push(p);
    else console.warn(`[label-cli] WARN: unknown feature id "${p}" — ignored`);
  }
  return out;
}

async function _promptOne(rl, q) {
  return new Promise(resolve => rl.question(q, ans => resolve(ans)));
}

function _ensureRaterShape(item, raterField) {
  if (!item[raterField]) item[raterField] = { name: null, ts: null, ratings: {} };
  if (!item[raterField].ratings) item[raterField].ratings = {};
  return item[raterField];
}

async function main() {
  const args = _parseArgs(process.argv);
  if (args.help) { _printHelp(); return; }
  if (!args.topic) { console.error('[label-cli] topic required.'); process.exit(2); }
  if (!args.rater || !VALID_RATERS.has(args.rater)) {
    console.error('[label-cli] --rater=a or --rater=b required.');
    process.exit(2);
  }

  const items = _listItems(args.topic, args.item);
  if (!items) process.exit(2);
  if (items.length === 0) { console.error('[label-cli] no items found'); process.exit(2); }

  const raterField = `rater_${args.rater}`;
  const limit = args.limit || Infinity;

  // Build (item, candidate) pairs needing rating
  const pairs = [];
  for (const { fullPath, obj } of items) {
    const cands = obj.candidate_responses || [];
    const rater = obj[raterField];
    const ratings = rater && rater.ratings ? rater.ratings : {};
    for (const c of cands) {
      if (ratings[c.id] && Array.isArray(ratings[c.id].features_hit)) continue;
      pairs.push({ fullPath, obj, candidate: c });
      if (pairs.length >= limit) break;
    }
    if (pairs.length >= limit) break;
  }

  if (pairs.length === 0) {
    console.log(`[label-cli] all (item, candidate) pairs already rated by rater_${args.rater}.`);
    return;
  }

  console.log(`[label-cli] topic=${args.topic} rater=${args.rater}`);
  console.log(`[label-cli] ${pairs.length} (item, candidate) pair(s) to rate`);
  console.log('[label-cli] entries: comma-separated feature ids (e.g. f1,f3) or "none" or "skip"\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const defaultName = args.rater === 'a' ? 'founder' : 'rater_b';
  const raterName = ((await _promptOne(rl, `rater name (default ${defaultName}): `)).trim() || defaultName);

  let labeledCount = 0;
  for (const { fullPath, obj, candidate } of pairs) {
    console.log('---');
    console.log(`item: ${obj.id} (k_threshold=${obj.k_threshold})`);
    if (obj.source_anchor) console.log(`source: ${obj.source_anchor}`);
    console.log(`instance: ${obj.instance}`);
    console.log(`features:`);
    for (const f of obj.answer_features) {
      const alts = (f.alt_phrasings || []).slice(0, 3).join(' / ');
      console.log(`  ${f.id}: ${f.claim}${alts ? ' [' + alts + ']' : ''}`);
    }
    console.log(`candidate ${candidate.id}: ${candidate.text}`);

    const validIds = _validFeatureIds(obj);
    const raw = await _promptOne(rl, `features hit: `);
    const featuresHit = _parseFeaturesHit(raw, validIds);
    if (featuresHit === null) { console.log('[label-cli] skipped\n'); continue; }
    const justification = (await _promptOne(rl, `justification (optional): `)).trim();
    const verdict = featuresHit.length >= obj.k_threshold ? 'pass' : 'fail';

    const rater = _ensureRaterShape(obj, raterField);
    rater.name = raterName;
    rater.ts = new Date().toISOString();
    rater.ratings[candidate.id] = { features_hit: featuresHit, verdict, justification };

    // agreement = both raters present + same verdict on every candidate
    if (obj.rater_a && obj.rater_b) {
      const ratingsA = (obj.rater_a.ratings) || {};
      const ratingsB = (obj.rater_b.ratings) || {};
      const cIds = (obj.candidate_responses || []).map(c => c.id);
      const both = cIds.every(cid => ratingsA[cid] && ratingsB[cid]);
      if (both) {
        obj.agreement = cIds.every(cid => ratingsA[cid].verdict === ratingsB[cid].verdict);
      }
    }

    fs.writeFileSync(fullPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
    labeledCount++;
    console.log(`[label-cli] saved rater_${args.rater}.ratings.${candidate.id} = {features_hit: [${featuresHit.join(',')}], verdict: ${verdict}}\n`);
  }

  rl.close();
  console.log(`[label-cli] done. labeled ${labeledCount} pair(s).`);
  console.log(`[label-cli] next: node app/scripts/compute-kappa.js ${args.topic}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[label-cli] error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, _parseFeaturesHit };
