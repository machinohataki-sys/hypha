'use strict';

// HYPHA · Pillar 1 — Goal Router (2026-05-17)
// ────────────────────────────────────────────────────────────────────────────
//
// Decides whether an onboarding goal should produce a single curriculum
// (the existing `curriculum:create` flow) or a multi-curriculum chain plan
// (the existing `chain:create` flow). Until now the renderer always called
// `curriculum:create` regardless of ambition, so a goal like "成为诺贝尔文学奖
// 得主" (difficulty ≈ 0.95, multi-year horizon) collapsed into a single 30-
// lesson course — not actionable.
//
// Rule of record (locked by user 2026-05-17):
//   difficulty ≥ 0.7  AND  conservative_years ≥ 3  →  flow = 'chain'
//   otherwise                                       →  flow = 'single'
//
// `expected-years-estimator` is a sibling Pillar 2 module that may not exist
// yet — `routeGoal` requires it defensively and falls back to a pure-
// difficulty heuristic when it is absent or throws. This keeps the router
// useful before Pillar 2 lands.
//
// Logic lives here (not in main.js IPC handler) so it is unit-testable from
// Node without spinning up Electron — see app/scripts/_dev_verify_route_goal.js.

const path = require('path');

const DIFFICULTY_CHAIN_THRESHOLD = 0.7;
const YEARS_CHAIN_THRESHOLD = 3;

// Pure-difficulty fallback used when expected-years-estimator is unavailable.
// Maps difficulty score → conservative years using the same anchor points as
// the user spec: 0.95→20y / 0.85→10y / 0.65→3y / 0.35→1y / 0.05→0.3y.
function _fallbackYearsFromDifficulty(difficulty) {
  const d = Number(difficulty);
  if (!Number.isFinite(d)) return 1;
  if (d >= 0.9) return 20;
  if (d >= 0.8) return 10;
  if (d >= 0.6) return 3;
  if (d >= 0.3) return 1;
  return 0.3;
}

// Locate the goal-guardian module from a few likely paths so this file works
// regardless of how it is required (lib/creation/* vs lib/* vs scripts/*).
function _loadGoalGuardian() {
  // Same-directory require is the canonical case.
  try {
    return require('./goal-guardian');
  } catch (_) { /* fall through */ }
  try {
    return require(path.join(__dirname, 'goal-guardian'));
  } catch (_) { /* fall through */ }
  throw new Error('goal-guardian module not found — route-goal cannot estimate difficulty');
}

function _loadEstimator() {
  // Same-directory require first; absorb every failure mode (missing file,
  // missing function, throw at require-time) so the router stays useful
  // before Pillar 2 ships.
  try {
    const mod = require('./expected-years-estimator');
    if (mod && typeof mod.estimate === 'function') return mod;
  } catch (_) { /* not built yet — graceful fallback below */ }
  return null;
}

// Main entry point. Pure function w.r.t. inputs except for the dynamic
// require of the optional estimator module.
//
// args: { goalContract, archetype }
//   goalContract.north_star_goal — string, drives difficulty estimation.
//   archetype                    — optional, forwarded to estimator if present.
//
// returns: { flow, reason, difficulty, conservative_years, evidence,
//            estimator_used, error? }
async function routeGoal({ goalContract = {}, archetype = null } = {}) {
  let difficulty = 0.6;
  try {
    const gg = _loadGoalGuardian();
    if (gg && typeof gg._estimateDifficulty === 'function') {
      difficulty = Number(gg._estimateDifficulty(goalContract.north_star_goal || '')) || 0.6;
    }
  } catch (err) {
    // If even goal-guardian fails to load we must still answer — single-flow
    // is the safe fallback (existing behavior).
    return {
      flow: 'single',
      reason: 'router-error fallback to single',
      difficulty: 0.6,
      conservative_years: 1,
      evidence: [],
      estimator_used: false,
      error: String((err && err.message) || err),
    };
  }

  let conservative_years = _fallbackYearsFromDifficulty(difficulty);
  let evidence = [];
  let estimator_used = false;

  const estimator = _loadEstimator();
  if (estimator) {
    try {
      const r = await estimator.estimate({ goalContract, archetype });
      if (r && Number.isFinite(Number(r.conservative_years))) {
        conservative_years = Number(r.conservative_years);
      }
      if (Array.isArray(r && r.evidence)) evidence = r.evidence;
      estimator_used = true;
    } catch (_) {
      // Estimator built but threw — keep heuristic value; do not poison.
    }
  }

  const route =
    difficulty >= DIFFICULTY_CHAIN_THRESHOLD && conservative_years >= YEARS_CHAIN_THRESHOLD
      ? 'chain'
      : 'single';

  const reason =
    route === 'chain'
      ? `难度 ${difficulty.toFixed(2)} · 预计 ${conservative_years}年, 分阶段规划`
      : `单门课 ${conservative_years}年内可见效`;

  return { flow: route, reason, difficulty, conservative_years, evidence, estimator_used };
}

module.exports = {
  routeGoal,
  _fallbackYearsFromDifficulty,
  DIFFICULTY_CHAIN_THRESHOLD,
  YEARS_CHAIN_THRESHOLD,
};
