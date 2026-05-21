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

// TTY-gated ANSI helpers. When stdout is piped (e.g. `... | head`), strip codes
// so logs stay grep-able and machine-parseable. Manuscript register => no emoji.
const _IS_TTY = !!process.stdout.isTTY;
const _ANSI = {
  reset: _IS_TTY ? '\x1b[0m' : '',
  dim: _IS_TTY ? '\x1b[2m' : '',
  italic: _IS_TTY ? '\x1b[3m' : '',
  brass: _IS_TTY ? '\x1b[33m' : '',    // brass = warm yellow, used for pass + progress accents
  oxblood: _IS_TTY ? '\x1b[31m' : '',  // oxblood = dark red, used for fail
  cream: _IS_TTY ? '\x1b[38;5;230m' : '', // pale parchment, used for feature definitions
};

function _wrap(code, text) {
  if (!_IS_TTY) return text;
  return `${code}${text}${_ANSI.reset}`;
}

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
  const files = fs.readdirSync(dir).filter(f =>
    f.endsWith('.json') && !f.startsWith('_') && !f.includes('.rater-')
  );
  const items = [];
  for (const f of files) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (itemFilter && obj.id !== itemFilter) continue;
      items.push({ fullPath: path.join(dir, f), obj, dir });
    } catch (err) {
      console.warn(`[label-cli] skip malformed ${f}: ${err.message}`);
    }
  }
  return items;
}

// V0.5 E0 Phase 3 — bilingual sidecar reader. Returns parsed <id>.zh.json
// or null when the sidecar is absent / malformed. Founder cannot rate English
// items unaided; when a zh sidecar exists we render Chinese under each
// English line in a dim register so the rater can verify meaning before
// scoring features_hit.
function _readZhSidecar(dir, itemId) {
  const p = path.join(dir, `${itemId}.zh.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.warn(`[label-cli] zh sidecar ${itemId}.zh.json parse error: ${err.message}; rendering English-only`);
    return null;
  }
}

// D4 R1 fix: rater work lives in sidecar files <id>.rater-<a|b>.json,
// not on the main item JSON. Eliminates the race condition where parallel
// rater_a + rater_b runs on the same item file overwrite each other.
function _readSidecar(dir, itemId, raterId) {
  const p = path.join(dir, `${itemId}.rater-${raterId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (err) {
    console.warn(`[label-cli] sidecar ${itemId}.rater-${raterId} parse error: ${err.message}; starting fresh`);
    return null;
  }
}

function _writeSidecar(dir, itemId, raterId, sidecar) {
  const p = path.join(dir, `${itemId}.rater-${raterId}.json`);
  // Atomic-rename write: write tempfile then rename, reduces risk of partial-write
  // visible to a concurrent reader. Does not solve read-modify-write between
  // the same rater on the same item (single-rater self-race), but the only
  // explicit concurrency case (rater_a + rater_b parallel) is now disjoint
  // because they target different files.
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
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

// Render the instance line bilingually when a zh sidecar is present. The
// English instance is printed by the caller (existing `instance: ...` line);
// this helper prints ONLY the zh follow-up line in italic-dim register. When
// no sidecar, nothing prints (caller's English-only render is unchanged).
function _renderInstanceZh(zhSidecar) {
  if (!zhSidecar || typeof zhSidecar.instance_zh !== 'string' || !zhSidecar.instance_zh) return;
  // italic + dim composed; on non-TTY both wraps become no-ops and the
  // line stays plain. Prefix "[zh]    :" aligns column with "instance:".
  console.log(_wrap(_ANSI.italic, _wrap(_ANSI.dim, `[zh]    : ${zhSidecar.instance_zh}`)));
}

// Render prompt_text_zh under the English prompt_text line for llm-systems
// items that include exec_cell prompts. Same italic-dim register as instance.
function _renderPromptTextZh(zhSidecar) {
  if (!zhSidecar || typeof zhSidecar.prompt_text_zh !== 'string' || !zhSidecar.prompt_text_zh) return;
  console.log(_wrap(_ANSI.italic, _wrap(_ANSI.dim, `[zh]    : ${zhSidecar.prompt_text_zh}`)));
}

// Render the answer_features definitions for a single item. Called ONCE per
// item (not per candidate within the item), right before the first candidate
// rating prompt. Format per spec:
//   [<feature_id>] <statement>
//                  <statement_zh>           ← if zh sidecar present
//      alt: <phrasing 1>
//           <alt_phrasings_zh[0]>           ← if zh sidecar present
//      alt: <phrasing 2>
//           <alt_phrasings_zh[1]>           ← if zh sidecar present
// Uses cream/dim ANSI when TTY, plain otherwise. Falls back gracefully if
// answer_features is missing or malformed. zh lines align under the English
// content (after the `[fid] ` or `alt: ` prefix) for visual register.
function _renderFeatureDefinitions(item, zhSidecar) {
  const features = Array.isArray(item.answer_features) ? item.answer_features : [];
  if (features.length === 0) {
    console.warn(`[label-cli] WARN: item ${item.id} has no answer_features to display`);
    return;
  }
  // Index zh features by id for safe lookup (resilient to ordering drift).
  const zhFeaturesById = new Map();
  if (zhSidecar && Array.isArray(zhSidecar.features_zh)) {
    for (const fz of zhSidecar.features_zh) {
      if (fz && fz.id) zhFeaturesById.set(fz.id, fz);
    }
  }
  console.log(_wrap(_ANSI.dim, '— answer features —'));
  for (const f of features) {
    const fid = f.id || '?';
    // Spec uses <statement>; the JSON schema field is `claim`. Same thing.
    const statement = (f.claim || f.statement || '').toString();
    console.log(_wrap(_ANSI.cream, `  [${fid}] ${statement}`));
    const zhF = zhFeaturesById.get(fid);
    if (zhF && typeof zhF.statement_zh === 'string' && zhF.statement_zh) {
      // Align zh under English statement (4 spaces past `  [fid] ` prefix).
      console.log(_wrap(_ANSI.dim, `       ${zhF.statement_zh}`));
    }
    const alts = Array.isArray(f.alt_phrasings) ? f.alt_phrasings.slice(0, 2) : [];
    const altsZh = zhF && Array.isArray(zhF.alt_phrasings_zh) ? zhF.alt_phrasings_zh.slice(0, 2) : [];
    for (let i = 0; i < alts.length; i++) {
      console.log(_wrap(_ANSI.dim, `     alt: ${alts[i]}`));
      if (altsZh[i]) {
        // Align under "alt: " (4 spaces + "     " preserves visual nest).
        console.log(_wrap(_ANSI.dim, `          ${altsZh[i]}`));
      }
    }
  }
  console.log(''); // blank line breather before candidate text
}

// Render a verdict confirmation line in brass (pass) or oxblood (fail).
// Italic register line is short + neutral (no emoji, no exclamation).
function _renderVerdictConfirmation(verdict) {
  if (verdict === 'pass') {
    console.log(`${_wrap(_ANSI.brass, 'PASS')} ${_wrap(_ANSI.italic, '— features met threshold')}`);
  } else if (verdict === 'fail') {
    console.log(`${_wrap(_ANSI.oxblood, 'FAIL')} ${_wrap(_ANSI.italic, '— features fell below threshold')}`);
  }
}

// Compute progress tallies for the top bar at item entry.
//
// rated = items where this rater has scored ALL candidates (sidecar.ratings
//   contains every candidate.id with a features_hit array).
// skipped = items the rater has touched but not finished (sidecar exists, has
//   at least one rating, but not all candidates rated) PLUS items with no
//   sidecar AT ALL but earlier in iteration order than the current item
//   (i.e. the rater advanced past them without rating). To stay precise and
//   resume-safe, we treat "skipped" as "partially-rated items only" — fully
//   untouched items count as future work, not skipped. This is the
//   conservative read of the spec; reviewable + non-misleading.
function _computeProgressTally(items, raterId) {
  let rated = 0;
  let skipped = 0;
  for (const entry of items) {
    const { obj, dir } = entry;
    const sidecar = _readSidecar(dir, obj.id, raterId);
    const candidates = Array.isArray(obj.candidate_responses) ? obj.candidate_responses : [];
    if (candidates.length === 0) continue;
    const ratings = (sidecar && sidecar.ratings) || {};
    const ratedCount = candidates.filter(c =>
      ratings[c.id] && Array.isArray(ratings[c.id].features_hit)
    ).length;
    if (ratedCount === candidates.length) rated += 1;
    else if (ratedCount > 0) skipped += 1;
    // ratedCount === 0 + no sidecar => not yet started, not "skipped"
  }
  return { rated, skipped };
}

// Render the per-item progress bar at item entry:
//   [<topic>] item <N>/<total> · rated by you: <X> · skipped: <Y>
// Brass accents on N/total in TTY mode for subtle hierarchy.
function _renderProgressBar(topic, currentIdx, total, tally) {
  const idxFragment = _wrap(_ANSI.brass, `${currentIdx}/${total}`);
  console.log(
    `[${topic}] item ${idxFragment} · rated by you: ${tally.rated} · skipped: ${tally.skipped}`
  );
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

  const limit = args.limit || Infinity;

  // Build (item, candidate) pairs needing rating. D4 R1: read from sidecar
  // <id>.rater-<a|b>.json instead of main JSON's rater_a/rater_b field.
  const pairs = [];
  const sidecarByItem = new Map();
  // Track 1-based item index within items[] for the per-item progress bar.
  const itemIndexById = new Map();
  items.forEach((entry, idx) => itemIndexById.set(entry.obj.id, idx + 1));
  for (const { fullPath, obj, dir } of items) {
    const sidecar = _readSidecar(dir, obj.id, args.rater) || { rater_id: args.rater, name: null, ts: null, ratings: {} };
    sidecarByItem.set(obj.id, { sidecar, dir, fullPath });
    const cands = obj.candidate_responses || [];
    const ratings = (sidecar.ratings) || {};
    for (const c of cands) {
      if (ratings[c.id] && Array.isArray(ratings[c.id].features_hit)) continue;
      pairs.push({ fullPath, obj, candidate: c, dir });
      if (pairs.length >= limit) break;
    }
    if (pairs.length >= limit) break;
  }

  // Snapshot tally BEFORE the labeling loop. We render the per-item progress
  // bar at item entry using this snapshot; tally only refreshes between items
  // so the count reflects committed-on-disk state, not mid-item updates.
  const initialTally = _computeProgressTally(items, args.rater);

  if (pairs.length === 0) {
    // Even on full-completion runs, print a session-level summary so the rater
    // sees what state they resumed into. This is the save-and-resume happy path.
    console.log(`[${args.topic}] all ${items.length} item(s) rated by rater_${args.rater} · rated: ${initialTally.rated} · skipped: ${initialTally.skipped}`);
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
  let lastItemId = null; // tracks item transitions so per-item header prints ONCE per item
  // Cache zh sidecars per item so we don't re-read across multiple candidates.
  const zhSidecarByItem = new Map();
  for (const { obj, candidate, dir } of pairs) {
    // Lazy-load + cache zh sidecar for this item (one fs hit per item, not per candidate).
    let zhSidecar = zhSidecarByItem.get(obj.id);
    if (zhSidecar === undefined) {
      zhSidecar = _readZhSidecar(dir, obj.id);
      zhSidecarByItem.set(obj.id, zhSidecar);
    }
    const isNewItem = obj.id !== lastItemId;
    if (isNewItem) {
      const idx = itemIndexById.get(obj.id) || 0;
      console.log('---');
      // Top progress bar — at start of each item.
      _renderProgressBar(args.topic, idx, items.length, initialTally);
      console.log(`item: ${obj.id} (k_threshold=${obj.k_threshold})`);
      if (obj.source_anchor) console.log(`source: ${obj.source_anchor}`);
      console.log(`instance: ${obj.instance}`);
      // V0.5 E0 Phase 3 — bilingual: zh under instance when sidecar present.
      _renderInstanceZh(zhSidecar);
      if (typeof obj.prompt_text === 'string' && obj.prompt_text) {
        console.log(`prompt : ${obj.prompt_text}`);
        _renderPromptTextZh(zhSidecar);
      }
      // Feature definitions block — ONCE per item, replaces the old inline list.
      _renderFeatureDefinitions(obj, zhSidecar);
      lastItemId = obj.id;
    } else {
      console.log(''); // soft separator between candidates within the same item
    }
    console.log(`candidate ${candidate.id}: ${candidate.text}`);
    // V0.5 E0 Phase 3 — bilingual: zh under candidate text when sidecar present.
    if (zhSidecar && Array.isArray(zhSidecar.candidates_zh)) {
      const cz = zhSidecar.candidates_zh.find((c) => c && c.id === candidate.id);
      if (cz && typeof cz.text_zh === 'string' && cz.text_zh) {
        // Align "[zh]: " under "candidate <id>: " visually.
        console.log(_wrap(_ANSI.italic, _wrap(_ANSI.dim, `              [zh]: ${cz.text_zh}`)));
      }
    }

    const validIds = _validFeatureIds(obj);
    const raw = await _promptOne(rl, `features hit (e.g. f1,f2 or none or skip): `);
    const featuresHit = _parseFeaturesHit(raw, validIds);
    if (featuresHit === null) { console.log('[label-cli] skipped\n'); continue; }
    const justification = (await _promptOne(rl, `justification (optional): `)).trim();
    const verdict = featuresHit.length >= obj.k_threshold ? 'pass' : 'fail';

    // Verdict color confirmation — brass for pass, oxblood for fail.
    // TTY-gated; piped output stays ANSI-free.
    _renderVerdictConfirmation(verdict);

    // D4 R1 fix: write to sidecar instead of main JSON. rater_a + rater_b
    // touch DIFFERENT files; race eliminated structurally.
    const entry = sidecarByItem.get(obj.id);
    const sidecar = entry.sidecar;
    sidecar.rater_id = args.rater;
    sidecar.name = raterName;
    sidecar.ts = new Date().toISOString();
    sidecar.ratings = sidecar.ratings || {};
    sidecar.ratings[candidate.id] = {
      features_hit: featuresHit,
      verdict,
      justification,
      ts: new Date().toISOString(),
    };
    try {
      _writeSidecar(dir, obj.id, args.rater, sidecar);
    } catch (err) {
      console.warn(`[label-cli] WARN: sidecar write failed for ${obj.id}.rater-${args.rater}: ${err.message}`);
      continue;
    }
    labeledCount++;
    console.log(`[label-cli] saved <${obj.id}>.rater-${args.rater}.json :: ${candidate.id} = {features_hit: [${featuresHit.join(',')}], verdict: ${verdict}}\n`);
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
