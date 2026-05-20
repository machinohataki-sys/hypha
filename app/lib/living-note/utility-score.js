'use strict';

// HYPHA · W5.3 Living Note — Utility Score (BLUEPRINT §10.2).
//
// 8-factor weighted score 0-100. Drives:
//   - crystallization gate (≥ 80 + Useful + cited ≥ 3 → Crystallized)
//   - dead-note detector  (< 20 + Dormant > 90d + 0 edges → archive candidate)
//   - reactivation ranker (high utility wins ties when relevance equal)
//
// Per Wave 5.3 spec:
//   helped_lesson_count            × 10
//   helped_decision_count          × 15
//   produced_action_count          × 12
//   cited_count                    ×  5
//   sparked_count                  ×  8
//   reduced_understanding_cost     × 10  (boolean)
//   influenced_product             × 15  (boolean)
//   outdated_penalty               × -30 (boolean)
//
// Cap [0, 100]. Negative pre-clamp result clamps to 0.
//
// Pure function. No fs. Caller passes noteData (typically aggregated from
// event-log.js + frontmatter parse).

const FACTOR_WEIGHTS = Object.freeze({
  helped_lesson_count:        10,
  helped_decision_count:      15,
  produced_action_count:      12,
  cited_count:                 5,
  sparked_count:               8,
  reduced_understanding_cost: 10,
  influenced_product:         15,
  outdated_penalty:           -30,
});

const COUNT_FACTORS = Object.freeze([
  'helped_lesson_count',
  'helped_decision_count',
  'produced_action_count',
  'cited_count',
  'sparked_count',
]);

const BOOL_FACTORS = Object.freeze([
  'reduced_understanding_cost',
  'influenced_product',
  'outdated_penalty',
]);

function _toCount(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

function _toBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Compute the 8-factor utility score.
 *
 * @param {object} noteData — bag of factor values (missing keys default safe)
 * @returns {{ score: number, factors: Record<string, number> }}
 *          factors contains the per-factor contribution (already weighted),
 *          score is the clamped [0, 100] sum.
 */
function computeUtilityScore(noteData) {
  const data = noteData && typeof noteData === 'object' ? noteData : {};
  const factors = {};
  let raw = 0;

  for (const k of COUNT_FACTORS) {
    const n = _toCount(data[k]);
    const contrib = n * FACTOR_WEIGHTS[k];
    factors[k] = contrib;
    raw += contrib;
  }
  for (const k of BOOL_FACTORS) {
    const b = _toBool(data[k]);
    const contrib = b ? FACTOR_WEIGHTS[k] : 0;
    factors[k] = contrib;
    raw += contrib;
  }

  let score = raw;
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return { score, factors };
}

/**
 * Rank a list of notes by utility, descending. Stable on ties (insertion
 * order preserved). Returns top-k.
 *
 * @param {Array<{path:string, data:object}>} notes
 * @param {number} k  default 20
 * @returns {Array<{path:string, score:number, factors:object, data:object}>}
 */
function rankNotesByUtility(notes, k = 20) {
  if (!Array.isArray(notes) || notes.length === 0) return [];
  const limit = Number.isFinite(k) && k > 0 ? Math.floor(k) : 20;
  const scored = notes.map((n, idx) => {
    const { score, factors } = computeUtilityScore(n && n.data);
    return {
      path: (n && n.path) || null,
      data: (n && n.data) || {},
      score,
      factors,
      _idx: idx,
    };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a._idx - b._idx;
  });
  return scored.slice(0, limit).map(({ _idx, ...keep }) => keep);
}

module.exports = {
  FACTOR_WEIGHTS,
  COUNT_FACTORS,
  BOOL_FACTORS,
  computeUtilityScore,
  rankNotesByUtility,
};
