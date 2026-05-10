'use strict';

/**
 * HYPHA · Assignment Function v0 stub — sub-step M
 *
 * v0.1 frozen scope (per BLUEPRINT AMD-10): always returns Level 1 (Micro Proof).
 *
 * v0.5 Cadence System will compute Level 1-5 via formula
 *   Assignment Level = f(D, S, C, M, R, G, T, P)
 * per BLUEPRINT §8.2 where:
 *   D = lesson day index
 *   S = learning score
 *   C = confusion level
 *   M = phase milestone
 *   R = review node
 *   G = goal type (Exam/Growth/Hybrid)
 *   T = deadline pressure
 *   P = product/creation relevance
 *
 * Level meanings (frozen):
 *   1 = Micro Proof (60s eyeball check)
 *   2 = Small Practice (5-15 min)
 *   3 = Applied Task (30-60 min)
 *   4 = Product Spark / Integration Artifact
 *   5 = Public / Commons Output
 *
 * Future-proof: signature already takes 3 args so callers won't break when
 * v0.5 expansion lands. v0.1 ignores them and returns 1 unconditionally.
 *
 * @param {object} goalContract - Goal Contract per §3.1 (8 fields). Unused in v0.1.
 * @param {object} masteryState - Mastery Map state. v0.1 = {}. v0.4+ has dimensions.
 * @param {object} currentPlan - 6-field Plan from generatePlan(). Unused in v0.1.
 * @returns {number} Assignment level (always 1 in v0.1).
 */
function computeAssignmentLevel(goalContract, masteryState, currentPlan) {
  return 1;
}

module.exports = { computeAssignmentLevel };
