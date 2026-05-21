'use strict';

// HYPHA · lesson-count — extracted from app/main.js (2026-05-17 阶 2 difficulty scaling)
//
// Why a separate module: main.js is the Electron entry; requiring it
// stand-alone for tests boots `electron.app` and other native deps. Lifting
// these two pure functions lets the smoke test (app/scripts/
// _dev_verify_difficulty_scaling.js) require them directly without touching
// the renderer or IPC layer.
//
// 2026-05-17 difficulty scaling — per user feedback "越难实现所设计与规划
// 应当越长, 搜集的资料就要越多". A诺奖 / PhD-tier goal (difficulty 0.95)
// should produce ~2.1× the lessons a moderate-difficulty goal does; a entry-
// level "看懂 X" (difficulty 0.35) sits below the unscaled baseline. Source of
// the 0-1 score: goal-guardian.js `_estimateDifficulty` keyword heuristic or
// the LLM `classifyAll` result (diff.score). Either way it lands here as a
// number.
//
// difficultyMult formula: 0.7 + difficulty * 1.5  → range [0.7, 2.2]
//   difficulty 0.95 (诺奖)   → 2.125
//   difficulty 0.65 (产品)   → 1.675
//   difficulty 0.35 (入门)   → 1.225
//   difficulty 0.05 (扫一眼) → 0.775
// Default difficulty = 0.6 (unknown / neutral) → multi 1.6. We preserve the
// existing Growth 999999 / Exam 200 caps so the scale-up does not blow past
// the physical 200×1.5h ceiling for Exam mode.

const HOURS_PER_LESSON = 1.5;
const FLOOR_LESSON_COUNT = 25;
const GROWTH_CAP = 999999;
const EXAM_CAP = 200;
const DEFAULT_DIFFICULTY = 0.6;

function _capForLearningMode(learningMode) {
  return String(learningMode || '').toLowerCase() === 'growth' ? GROWTH_CAP : EXAM_CAP;
}

function _difficultyMult(difficulty) {
  let d = Number(difficulty);
  if (!Number.isFinite(d)) d = DEFAULT_DIFFICULTY;
  if (d < 0) d = 0;
  if (d > 1) d = 1;
  // 0.7 + d × 1.5 → 0.7 @ d=0, 2.2 @ d=1.
  return 0.7 + d * 1.5;
}

function perLinkLessonCount(durationWeeks, dailyHours, tier, role, learningMode, difficulty) {
  const w = Number(durationWeeks) || 1;
  const hd = Number(dailyHours) || 2;
  const mult = tier === 'gentle' ? 0.6 : tier === 'heroic' ? 1.6 : 1.0;
  const r = String(role || 'core').toLowerCase();
  const roleMult = r === 'prerequisite' ? 1.0
    : r === 'ultimate' ? 2.5
    : 1.5; // core (or unknown)
  const diffMult = _difficultyMult(difficulty);
  const raw = Math.round(w * 7 * hd / HOURS_PER_LESSON * mult * roleMult * diffMult);
  return Math.max(FLOOR_LESSON_COUNT, Math.min(_capForLearningMode(learningMode), raw));
}

function resolveLessonsForLink(link, dailyHours, tier, learningMode, difficulty) {
  const role = String(link.role || 'core').toLowerCase();
  const tierMult = tier === 'gentle' ? 0.6 : tier === 'heroic' ? 1.6 : 1.0;
  const diffMult = _difficultyMult(difficulty);
  // Bands scale with difficulty too — a noble-prize-level prerequisite link
  // earns a wider band than a beginner-level prerequisite link.
  const bands = {
    prerequisite: { min: Math.round(25 * tierMult * diffMult), max: Math.round(50 * tierMult * diffMult) },
    core:         { min: Math.round(50 * tierMult * diffMult), max: Math.round(100 * tierMult * diffMult) },
    ultimate:     { min: Math.round(80 * tierMult * diffMult), max: Math.round(150 * tierMult * diffMult) },
  };
  const band = bands[role] || bands.core;
  const cap = _capForLearningMode(learningMode);
  const fromLLM = Number(link.lessons_count);
  if (Number.isFinite(fromLLM) && fromLLM >= 20) {
    // Trust but clamp into the difficulty-scaled band.
    return Math.max(band.min, Math.min(cap, Math.round(fromLLM)));
  }
  // Fallback: derive from duration + role + difficulty.
  return Math.max(
    band.min,
    Math.min(cap, perLinkLessonCount(link.duration_weeks, dailyHours, tier, role, learningMode, difficulty))
  );
}

module.exports = {
  perLinkLessonCount,
  resolveLessonsForLink,
  _capForLearningMode,
  _difficultyMult,
  DEFAULT_DIFFICULTY,
};
