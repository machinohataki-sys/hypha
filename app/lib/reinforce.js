// ptor/app/corpus/reinforce.js
//
// AGENT-REINFORCED RANKING — Build #2 of the 2026-04-27 PTOR corpus pivot.
//
// Reads the event-log (Build #1), folds events into per-note strength via the
// same Ebbinghaus math memory-recall.js uses. The single critical extension:
// reinforcement count combines HUMAN events (Federdruck verdicts) and AGENT
// events (MCP cite calls) into ONE compound counter — atom A3 says agents
// read 100× more than humans, so giving them comparable weight makes corpus
// quality compound at agent-frequency, not human-frequency. That's the moat.
//
// Strength formula (matches memory-recall.js for cross-system consistency):
//   strength = importance × exp(−eff_λ × days_since_last_event)
//                         × (1 + reinforcement_count × 0.2)
//   eff_λ    = base_λ × (1 − importance × 0.8)
//   base_λ   = ln(2) / half_life_days
//
// reinforcement_count formula (NEW — this is the Leo pivot):
//   reinforcement_count = human_recall + agent_cite + verdict_weighted(verdicts)
//   verdict_weighted: held(3)=1.0, shaky(2)=0.7, smooth(1)=0.4
//                     (held = "I struggled — needed reinforcement," counts most)
//
// The product caps strength impact in search.js at ±40% (sim × (0.6 + 0.4×s))
// so cosine still dominates ranking; reinforcement tiebreaks.
//
// Cache: .beiking/corpus-strength.json with 5min TTL. Search calls happen
// frequently (per keystroke / per agent query); replaying the full event-log
// each time would be wasteful at scale.

'use strict';

const fs   = require('node:fs');
const fsp  = require('node:fs/promises');
const path = require('node:path');

const eventLog = require('./event-log');

const CACHE_REL = path.join('.beiking', 'corpus-strength.json');
const CACHE_TTL_MS = 5 * 60 * 1000;            // 5 minutes
const MS_PER_DAY = 86400000;

// ─── Tunable constants (match memory-recall.js where applicable) ──────────
const DEFAULT_IMPORTANCE = 0.7;                // hand-curated note baseline
const HALF_LIFE_DAYS = 90;                     // vault notes are durable knowledge
const DECAY_BLUNT = 0.8;                       // (1 - importance × 0.8) modulator

// Per-event reinforcement weights (the schlep — hand-tuned, not learned)
const W_HUMAN_RECALL  = 1.0;                   // explicit search hit click
const W_AGENT_CITE    = 1.0;                   // MCP corpus_query result usage
const W_VERDICT_HELD  = 1.0;                   // Federdruck "held" — full credit
const W_VERDICT_SHAKY = 0.7;                   // "shaky" — partial credit
const W_VERDICT_SMOOTH = 0.4;                  // "smooth" — easiest, smallest boost

// ─── Cache I/O ────────────────────────────────────────────────────────────

function cachePath(vaultRoot) {
  return path.join(vaultRoot, CACHE_REL);
}

function ensureCacheDir(vaultRoot) {
  fs.mkdirSync(path.dirname(cachePath(vaultRoot)), { recursive: true });
}

function loadCache(vaultRoot) {
  try {
    const raw = fs.readFileSync(cachePath(vaultRoot), 'utf8');
    const data = JSON.parse(raw);
    if (Date.now() - (data._builtAt || 0) > CACHE_TTL_MS) return null;
    return data;
  } catch { return null; }
}

function saveCache(vaultRoot, data) {
  ensureCacheDir(vaultRoot);
  fs.writeFileSync(cachePath(vaultRoot), JSON.stringify({
    _builtAt: Date.now(),
    _ttlMs: CACHE_TTL_MS,
    ...data,
  }), 'utf8');
}

// ─── Strength math ────────────────────────────────────────────────────────

function reinforcementCount(agg) {
  // Per-event class weights summed to a single counter that the Ebbinghaus
  // boost factor consumes. event-log.fold maintains per-class verdict
  // counters (held/shaky/smooth), so each cast contributes its OWN class
  // weight — not a flat last-weight × count approximation. This matches
  // user feedback `feedback_agent_deduction_lessons` (extract pattern, not
  // last instance).
  const humanRecall = (agg.recall_count || 0) * W_HUMAN_RECALL;
  const agentCite   = (agg.cite_count   || 0) * W_AGENT_CITE;
  const v = agg.verdicts || { held: 0, shaky: 0, smooth: 0 };
  const verdictBoost = v.held   * W_VERDICT_HELD
                     + v.shaky  * W_VERDICT_SHAKY
                     + v.smooth * W_VERDICT_SMOOTH;
  return humanRecall + agentCite + verdictBoost;
}

function daysSinceMs(iso, fallbackMs) {
  const ms = iso ? Date.parse(iso) : fallbackMs;
  return Math.max(0, (Date.now() - ms) / MS_PER_DAY);
}

function strengthFromAgg(agg, importance, fallbackMs) {
  const baseLambda = Math.LN2 / HALF_LIFE_DAYS;
  const effLambda  = baseLambda * (1 - importance * DECAY_BLUNT);
  const days       = daysSinceMs(agg && agg.last_event_ts, fallbackMs);
  const decay      = Math.exp(-effLambda * days);
  const reinforce  = 1 + reinforcementCount(agg) * 0.2;
  return importance * decay * reinforce;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Compute strength for ONE vault file. Bypasses cache — single-file callers
 * are rare; bulkStrength is the hot path.
 *
 * @param {string} vaultRoot
 * @param {string} fileRel
 * @param {object} [opts]
 * @param {number} [opts.importance=DEFAULT_IMPORTANCE]
 * @param {number} [opts.fallbackMs] — file mtime if no events (no fake aging)
 * @returns {Promise<number>}
 */
async function strengthFor(vaultRoot, fileRel, opts = {}) {
  const importance = opts.importance != null ? opts.importance : DEFAULT_IMPORTANCE;
  const agg = await eventLog.aggregate(vaultRoot, fileRel);
  let fallback = opts.fallbackMs;
  if (fallback == null) {
    try { fallback = fs.statSync(path.join(vaultRoot, fileRel)).mtimeMs; }
    catch { fallback = Date.now(); }
  }
  return strengthFromAgg(agg, importance, fallback);
}

/**
 * Compute strength for ALL files in the event log. Reads cache if fresh,
 * else replays the log once and writes a fresh cache. Returns a plain
 * object { fileRel: number } for simple JSON-serialization.
 *
 * @param {string} vaultRoot
 * @param {object} [opts]
 * @param {boolean} [opts.refresh] — bypass cache
 * @returns {Promise<{[fileRel: string]: number}>}
 */
async function bulkStrength(vaultRoot, opts = {}) {
  if (!opts.refresh) {
    const cached = loadCache(vaultRoot);
    if (cached && cached.strength) return cached.strength;
  }

  const aggMap = await eventLog.aggregate(vaultRoot);
  const strength = {};
  const importance = DEFAULT_IMPORTANCE;
  for (const [fileRel, agg] of aggMap) {
    let fallback;
    try { fallback = fs.statSync(path.join(vaultRoot, fileRel)).mtimeMs; }
    catch { fallback = Date.now(); }
    strength[fileRel] = strengthFromAgg(agg, importance, fallback);
  }

  saveCache(vaultRoot, { strength, file_count: Object.keys(strength).length });
  return strength;
}

/**
 * Convenience: rerank an array of hits in-place, returning a new sorted array.
 * Each hit needs at least { noteRelPath, score }. Score is multiplied by
 * (0.6 + 0.4 × strength) so the dense signal stays dominant.
 *
 * @param {string} vaultRoot
 * @param {Array<{noteRelPath: string, score: number}>} hits
 * @returns {Promise<Array>}
 */
async function rerankByStrength(vaultRoot, hits) {
  if (!Array.isArray(hits) || hits.length === 0) return hits;
  const strengths = await bulkStrength(vaultRoot);
  const reranked = hits.map(h => {
    const s = strengths[h.noteRelPath] != null ? strengths[h.noteRelPath] : DEFAULT_IMPORTANCE;
    const reinforced = h.score * (0.6 + 0.4 * s);
    return { ...h, baseScore: h.score, strength: Math.round(s * 1000) / 1000, score: Math.round(reinforced * 10000) / 10000 };
  });
  reranked.sort((a, b) => b.score - a.score);
  return reranked;
}

/** Force the next bulkStrength call to re-read the log. */
function invalidateCache(vaultRoot) {
  try { fs.unlinkSync(cachePath(vaultRoot)); } catch {}
}

module.exports = {
  strengthFor,
  bulkStrength,
  rerankByStrength,
  invalidateCache,
  // exported for tests
  _reinforcementCount: reinforcementCount,
  _strengthFromAgg: strengthFromAgg,
  HALF_LIFE_DAYS,
  DEFAULT_IMPORTANCE,
};
