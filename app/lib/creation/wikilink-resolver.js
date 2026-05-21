'use strict';

// HYPHA · wikilink resolver — 4-evidence ranker
//
// Per Scout S81 (MSR-MEL multi-source evidence, arXiv 2604.20283 — 89.7% on
// LongMemEval-KU): when a wikilink resolves to multiple candidates, rank by
// four cheap evidence channels rather than vector-embed first turn:
//
//   1. lexical    — exact / prefix / substring match against link text
//   2. frequency  — how often the candidate label appears in the corpus index
//   3. neighborhood — Jaccard overlap of candidate tags vs link-context tags
//   4. semantic   — edit-distance scorer (vector layer deferred to v0.13+)
//                   // intentional-placeholder: vector embedding (BGE-M3) is
//                   the v0.13+ semantic channel; edit-distance is a deliberate
//                   v1 substrate so the 4-evidence stack ships without the
//                   embedding dependency. Replace `_semanticScore` when BGE
//                   lands — interface contract identical.
//
// Lifecycle filter (optional) — when candidates carry `lifecycle` field, the
// resolver filters to ratified-or-active by default. Pass {lifecycleFilter:
// 'all'} to disable. Falls open when no candidate has the field (backward
// compat with B1 ledgers that pre-date Pack lifecycle).
//
// API:
//   resolveWikilink(linkText, candidates, options) -> {
//     match:    best candidate | null,
//     ranked:   array of {candidate, score, evidence:{lexical, frequency, neighborhood, semantic}},
//     filteredOut: array  (candidates dropped by lifecycle filter)
//   }
//
// candidate shape (only `id` + `label` are required):
//   {
//     id:          string,         REQUIRED
//     label:       string,         REQUIRED — display name to match against
//     aliases:     string[]?,
//     tags:        string[]?,      neighborhood evidence channel
//     frequency:   number?,        precomputed corpus count, 0 by default
//     lifecycle:   string?,        'ratified' | 'active' | 'draft' | 'deprecated' | 'invalidated'
//   }
//
// options:
//   contextTags:     string[]      tags from the linking surface (lesson, note, ledger)
//   lifecycleFilter: 'default'|'all'  (default: keep ratified|active|draft, drop deprecated|invalidated)
//   weights:         {lexical, frequency, neighborhood, semantic}  defaults below

const DEFAULT_WEIGHTS = Object.freeze({
  lexical:      0.45,
  frequency:    0.15,
  neighborhood: 0.25,
  semantic:     0.15,
});

const KEEP_LIFECYCLES = new Set(['ratified', 'active', 'draft']);
const DROP_LIFECYCLES = new Set(['deprecated', 'invalidated']);

function _norm(s) {
  return typeof s === 'string' ? s.trim().toLowerCase() : '';
}

// Lexical: 1.0 exact, 0.8 alias-exact, 0.6 prefix, 0.4 substring, 0.0 else.
function _lexicalScore(linkText, candidate) {
  const lt = _norm(linkText);
  const lab = _norm(candidate.label);
  if (!lt || !lab) return 0;
  if (lt === lab) return 1.0;
  if (Array.isArray(candidate.aliases)) {
    for (const a of candidate.aliases) {
      if (_norm(a) === lt) return 0.8;
    }
  }
  if (lab.startsWith(lt) || lt.startsWith(lab)) return 0.6;
  if (lab.includes(lt) || lt.includes(lab)) return 0.4;
  return 0;
}

// Frequency: log-normalised against the max across candidates (computed once
// in the outer fn). Capped so frequency cannot dominate a clearly-better
// lexical hit.
function _frequencyScore(candidate, maxFreq) {
  const f = Number.isFinite(candidate.frequency) ? Math.max(0, candidate.frequency) : 0;
  if (!maxFreq || maxFreq <= 0) return 0;
  return Math.log1p(f) / Math.log1p(maxFreq);
}

// Neighborhood: Jaccard overlap of candidate.tags vs context tags. Both empty
// -> 0 (no signal). Either empty -> 0.
function _neighborhoodScore(candidate, contextTags) {
  if (!Array.isArray(candidate.tags) || !candidate.tags.length) return 0;
  if (!Array.isArray(contextTags) || !contextTags.length) return 0;
  const a = new Set(candidate.tags.map(_norm).filter(Boolean));
  const b = new Set(contextTags.map(_norm).filter(Boolean));
  if (!a.size || !b.size) return 0;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  const unionSize = a.size + b.size - intersect;
  return unionSize === 0 ? 0 : intersect / unionSize;
}

// Semantic substrate: 1 - levenshtein(linkText, label) / max(len). Vector
// layer (BGE-M3 / sentence-transformers) lands v0.13+ per Hypha roadmap.
// intentional-placeholder: this edit-distance scorer is the v1 semantic
// channel by design — see module header. Not a TODO.
function _editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const al = a.length, bl = b.length;
  const dp = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) dp[j] = j;
  for (let i = 1; i <= al; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[bl];
}

function _semanticScore(linkText, candidate) {
  const lt = _norm(linkText);
  const lab = _norm(candidate.label);
  if (!lt || !lab) return 0;
  const dist = _editDistance(lt, lab);
  const maxLen = Math.max(lt.length, lab.length);
  if (maxLen === 0) return 0;
  return Math.max(0, 1 - dist / maxLen);
}

function _passesLifecycle(candidate, mode) {
  if (mode === 'all') return true;
  const lc = typeof candidate.lifecycle === 'string' ? candidate.lifecycle.trim().toLowerCase() : '';
  if (!lc) return true;
  if (DROP_LIFECYCLES.has(lc)) return false;
  return KEEP_LIFECYCLES.has(lc) || true;
}

function resolveWikilink(linkText, candidates, options = {}) {
  const out = { match: null, ranked: [], filteredOut: [] };
  if (typeof linkText !== 'string' || !linkText.trim()) return out;
  if (!Array.isArray(candidates) || !candidates.length) return out;
  const lifecycleMode = options.lifecycleFilter === 'all' ? 'all' : 'default';
  const contextTags = Array.isArray(options.contextTags) ? options.contextTags : [];
  const weights = Object.assign({}, DEFAULT_WEIGHTS, options.weights || {});

  const kept = [];
  for (const c of candidates) {
    if (!c || typeof c.id !== 'string' || typeof c.label !== 'string') continue;
    if (!_passesLifecycle(c, lifecycleMode)) {
      out.filteredOut.push(c);
      continue;
    }
    kept.push(c);
  }
  if (!kept.length) return out;

  let maxFreq = 0;
  for (const c of kept) {
    const f = Number.isFinite(c.frequency) ? c.frequency : 0;
    if (f > maxFreq) maxFreq = f;
  }

  const ranked = kept.map(c => {
    const lexical      = _lexicalScore(linkText, c);
    const frequency    = _frequencyScore(c, maxFreq);
    const neighborhood = _neighborhoodScore(c, contextTags);
    const semantic     = _semanticScore(linkText, c);
    const score =
      weights.lexical      * lexical +
      weights.frequency    * frequency +
      weights.neighborhood * neighborhood +
      weights.semantic     * semantic;
    return {
      candidate: c,
      score,
      evidence: { lexical, frequency, neighborhood, semantic },
    };
  });
  ranked.sort((a, b) => b.score - a.score);
  out.ranked = ranked;
  out.match = ranked[0].score > 0 ? ranked[0].candidate : null;
  return out;
}

module.exports = {
  resolveWikilink,
  DEFAULT_WEIGHTS,
  _editDistance,
};
