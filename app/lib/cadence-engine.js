// app/lib/cadence-engine.js
// W2.1 Lesson Cadence Engine — pure functional decision layer.
//
// Per BLUEPRINT.md §3.3 (Deadline-Aware Cadence) + §8.1 (Lesson Cadence Engine)
// + ROADMAP.md v0.5. This module decides the *rhythm* of teaching (deep /
// balanced / compress / final), NOT the total lesson count (deriveLessonTarget)
// or per-lesson KP density (lessonSplit). It is layered ON TOP of those two
// without touching them.
//
// 关系坐标 — read before editing:
//   deriveLessonTarget(agent.js:4764) → 决定课程总数 (天数 / 强度 / 自定义).
//   lessonSplit(agent.js:2788)        → 决定每课 KP 数 (Miller 上限).
//   computeCadence(here)              → 决定 *节奏类型* (深 / 紧 / 平 / 终).
//                                       不重叠. cadence_mode 可作 KP 系数微调.
//   anti-illusion-gate(W1.3)          → 触发 micro-task (advisory).
//   computeCadence(W2.1)              → 决定是否升级为 Review Day (hard-block 时机).
//
// 所有 export 函数纯 (no I/O, no LLM 调用, no mutation). 输入 invalid → 返
// { cadence_mode: 'invalid', ... }, 不抛. 配合 cadence-state.js (持久化层) +
// app/main.js cadence:* IPC handler + UI CadenceCard 组件.
//
// Unit tests scaffolded at __tests__/cadence-engine.test.js (≥12 test.todo).
// intentional-placeholder: test bodies deferred to W2.1 calibration pass —
// engine logic is fully implemented here; tests come after wire-up bake-in.

'use strict';

// =====================================================================
// CONFIG — cadence decision rules.
// 用 const 表锁规则 → easy to test + edit + audit. 改阈值在此一处.
// =====================================================================

const CADENCE_MODES = Object.freeze({
  DEEP:        'deep',         // 时间充足 → 慢学 + 打地基 + 允许探索
  BALANCED:    'balanced',     // 时间中等 → 理解 + 练习平衡
  COMPRESS:    'compress',     // 时间紧迫 → 高频 + 错题 + 模拟 + 压缩
  FINAL:       'final',        // 最后 1 天 → 停止扩张, 只做 Final Compression
  INVALID:     'invalid',
});

const NEXT_LESSON_TYPES = Object.freeze({
  NEW:                 'new',
  REVIEW:              'review',
  INTEGRATION:         'integration',
  FINAL_COMPRESSION:   'final_compression',
});

const GOAL_TYPES = Object.freeze({
  EXAM:    'Exam',
  GROWTH:  'Growth',
  HYBRID:  'Hybrid',
});

// Exam goal time-based mode bands. days_remaining → cadence_mode.
// 蓝图 §3.3 原文阈值: ≤1 final, ≤7 compress, ≤30 balanced, >30 deep.
const EXAM_DAY_BANDS = Object.freeze([
  { max_days: 1,  mode: CADENCE_MODES.FINAL    },
  { max_days: 7,  mode: CADENCE_MODES.COMPRESS },
  { max_days: 30, mode: CADENCE_MODES.BALANCED },
  // > 30 → DEEP (fall-through default)
]);

// Hybrid ratio table (per 蓝图 §3.2). 控制 new vs review 的比例.
// 同表 read-only by Wave 2.2 Assignment Cadence (作业级别决策共享 ratio 源).
const HYBRID_RATIOS = Object.freeze({
  [CADENCE_MODES.DEEP]:     { new: 80, review: 20 },
  [CADENCE_MODES.BALANCED]: { new: 60, review: 40 },
  [CADENCE_MODES.COMPRESS]: { new: 30, review: 50, drill: 20 },
  [CADENCE_MODES.FINAL]:    { new:  0, review: 30, drill: 70 },
});

// Growth-mode 自适应阈值. 没有 deadline → 看分数 + 困惑度.
const GROWTH_THRESHOLDS = Object.freeze({
  CONFUSION_HIGH:  0.6,   // ≥ 0.6 → 降速到 DEEP
  CONFUSION_LOW:   0.2,   // ≤ 0.2 → 可加速到 BALANCED
  SCORE_LOW:       50,    // < 50  → 强制 DEEP + rest
  SCORE_HIGH:      80,    // ≥ 80  → 允许 BALANCED
});

// Review Day / Integration Day / Rest 触发阈值.
const TRIGGER_THRESHOLDS = Object.freeze({
  REVIEW_NODES_DUE_MIN:        3,   // 待复习节点 ≥ 3 → 触发 Review Day
  LESSONS_SINCE_REVIEW_MAX:    7,   // 距上次 Review > 7 课 → 触发 Review Day
  MILESTONE_CHECKPOINTS:       [0.25, 0.5, 0.75],  // 跨阈值触发 Integration Day
  CONSECUTIVE_LESSONS_NO_REST: 4,   // 连续 ≥ 4 课无 rest + 低分 → 建议休息
});

// KP-density mode multiplier — cadence_mode 可乘 lessonSplit 输出微调.
// 由 agent.js 在 lessonSplit/resolveLessonShape 之后, body gen 之前可选应用.
const KP_DENSITY_COEFFICIENTS = Object.freeze({
  [CADENCE_MODES.DEEP]:     1.00,   // 不减
  [CADENCE_MODES.BALANCED]: 1.00,   // 不减
  [CADENCE_MODES.COMPRESS]: 0.80,   // 减 20% (压缩模式 — 减 KP 提注意密度)
  [CADENCE_MODES.FINAL]:    0.60,   // 减 40% (终压模式 — 只留高频考点)
});

// =====================================================================
// HELPERS
// =====================================================================

/**
 * 把任意值转 finite number, 不合法返 fallback.
 * @param {*} v
 * @param {number|null} fb
 */
function _num(v, fb = null) {
  if (v === null || v === undefined || v === '') return fb;
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

/**
 * Clamp number to [min, max].
 */
function _clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

/**
 * 验输入. 任一致命项 invalid → 返 error string.
 */
function _validate(input) {
  const errors = [];
  const allowedGoals = new Set(Object.values(GOAL_TYPES));
  if (!input || typeof input !== 'object') {
    return ['input must be object'];
  }
  if (!allowedGoals.has(input.goalType)) {
    errors.push(`goalType must be one of Exam|Growth|Hybrid (got ${input.goalType})`);
  }
  const score = _num(input.learningScore);
  if (score == null || score < 0 || score > 100) {
    errors.push('learningScore must be 0..100');
  }
  const confusion = _num(input.confusionLevel);
  if (confusion == null || confusion < 0 || confusion > 1) {
    errors.push('confusionLevel must be 0..1');
  }
  const milestone = _num(input.milestoneProgress);
  if (milestone == null || milestone < 0 || milestone > 1) {
    errors.push('milestoneProgress must be 0..1');
  }
  const reviewDue = _num(input.reviewNodesDue);
  if (reviewDue == null || reviewDue < 0) {
    errors.push('reviewNodesDue must be ≥ 0');
  }
  // daysRemaining: Exam 必填 ≥0; Growth 可 null
  if (input.goalType === GOAL_TYPES.EXAM) {
    const days = _num(input.daysRemaining);
    if (days == null || days < 0) {
      errors.push('daysRemaining required for Exam goalType (≥ 0)');
    }
  }
  return errors;
}

// =====================================================================
// PUBLIC: computeCadence — 主纯函数.
// =====================================================================

/**
 * 计算节奏决策. 7 输入 → cadence decision object.
 *
 * @param {object} input
 * @param {'Exam'|'Growth'|'Hybrid'} input.goalType
 * @param {number} [input.dayIdx]              当前天数 (since curriculum start)
 * @param {number} [input.lessonIdx]           当前课序号 (0-based)
 * @param {number} input.learningScore         最近 3 课均分 0..100
 * @param {number} input.confusionLevel        困惑度 0..1
 * @param {number} input.milestoneProgress     里程碑进度 0..1
 * @param {number} input.reviewNodesDue        待复习节点数
 * @param {number|null} [input.daysRemaining]  距 deadline 天数 (Growth 无 deadline 可 null)
 * @param {number} [input.totalLessons]        总课数 (telemetry only)
 * @returns {{
 *   cadence_mode: 'deep'|'balanced'|'compress'|'final'|'invalid',
 *   next_lesson_type: 'new'|'review'|'integration'|'final_compression',
 *   rest_required: boolean,
 *   rationale: string,
 *   ratios?: { new: number, review: number, drill?: number },
 *   kp_coefficient?: number,
 * }}
 */
// W8.3 Adaptive UX — lazy-loaded intensity modifier; never crash if absent.
let _uxCadenceMod = null;
function _uxCadence() {
  if (_uxCadenceMod === null) {
    try { _uxCadenceMod = require('./adaptive-ux/render-modifier'); }
    catch (_) { _uxCadenceMod = false; }
  }
  return _uxCadenceMod;
}

function computeCadence(input) {
  const errors = _validate(input);
  if (errors.length > 0) {
    return {
      cadence_mode: CADENCE_MODES.INVALID,
      next_lesson_type: NEXT_LESSON_TYPES.NEW,
      rest_required: false,
      rationale: `invalid input: ${errors.join('; ')}`,
    };
  }
  const goalType = input.goalType;
  const score = _num(input.learningScore);
  const confusion = _num(input.confusionLevel);
  const milestone = _clamp(_num(input.milestoneProgress, 0), 0, 1);
  const reviewDue = _num(input.reviewNodesDue, 0);
  // Clamp daysRemaining ≥ 0 (negative = past deadline → still final).
  const daysRaw = _num(input.daysRemaining);
  const days = daysRaw != null ? Math.max(0, daysRaw) : null;

  // --- 1. cadence_mode ----------------------------------------------------
  let mode;
  let rationale;
  if (goalType === GOAL_TYPES.EXAM) {
    // 时间-based 决策. 由窄到宽 band 扫描, 第一个命中即赢.
    let band = null;
    for (const b of EXAM_DAY_BANDS) {
      if (days <= b.max_days) { band = b; break; }
    }
    mode = band ? band.mode : CADENCE_MODES.DEEP;
    rationale = `Exam · 剩 ${days} 天 → ${mode}`;
  } else if (goalType === GOAL_TYPES.GROWTH) {
    // 自适应. score 优先 (低分压根本上不来), 再 confusion.
    if (score < GROWTH_THRESHOLDS.SCORE_LOW) {
      mode = CADENCE_MODES.DEEP;
      rationale = `Growth · 分数 ${score} 偏低 → 降速深学`;
    } else if (confusion >= GROWTH_THRESHOLDS.CONFUSION_HIGH) {
      mode = CADENCE_MODES.DEEP;
      rationale = `Growth · 困惑 ${confusion.toFixed(2)} 偏高 → 降速深学`;
    } else if (score >= GROWTH_THRESHOLDS.SCORE_HIGH &&
               confusion <= GROWTH_THRESHOLDS.CONFUSION_LOW) {
      mode = CADENCE_MODES.BALANCED;
      rationale = `Growth · 分数 ${score} 高 + 困惑 ${confusion.toFixed(2)} 低 → 平衡推进`;
    } else {
      // 中间区: 默认 BALANCED, 但若总数充足倾向 DEEP.
      mode = CADENCE_MODES.BALANCED;
      rationale = `Growth · 中间区 → 平衡`;
    }
  } else { // Hybrid
    // Hybrid = Exam-band 兜底 + Growth 自适应 floor. 取较深 (慢) 的那个.
    let examBand = null;
    if (days != null) {
      for (const b of EXAM_DAY_BANDS) {
        if (days <= b.max_days) { examBand = b; break; }
      }
    }
    const examMode = examBand ? examBand.mode : CADENCE_MODES.DEEP;
    // Growth 自适应 floor (低分 / 高困惑 强制 DEEP).
    const growthFloor = (score < GROWTH_THRESHOLDS.SCORE_LOW ||
                         confusion >= GROWTH_THRESHOLDS.CONFUSION_HIGH)
      ? CADENCE_MODES.DEEP : null;
    // 深的胜 (用户认知状态 trump 时间压力).
    const modeRank = { deep: 0, balanced: 1, compress: 2, final: 3 };
    if (growthFloor && modeRank[growthFloor] < modeRank[examMode]) {
      mode = growthFloor;
      rationale = `Hybrid · 认知状态 (分数 ${score}, 困惑 ${confusion.toFixed(2)}) 强制 deep · 覆盖时间-${examMode}`;
    } else {
      mode = examMode;
      rationale = `Hybrid · 时间 ${days ?? '∞'} 天 → ${examMode}`;
    }
  }

  // --- 2. next_lesson_type -----------------------------------------------
  // 优先级: final → review (节点积压) → integration (里程碑) → new.
  let nextType;
  if (mode === CADENCE_MODES.FINAL) {
    nextType = NEXT_LESSON_TYPES.FINAL_COMPRESSION;
  } else if (reviewDue >= TRIGGER_THRESHOLDS.REVIEW_NODES_DUE_MIN) {
    nextType = NEXT_LESSON_TYPES.REVIEW;
  } else {
    // Integration 触发: milestone 跨过 0.25/0.5/0.75 阈值 (调用方比对 prev).
    // 此处只 surface "本课接近 milestone checkpoint" hint; 真触发由
    // shouldTriggerIntegrationDay() 配合 cadence-state 的 milestoneCrossed[].
    nextType = NEXT_LESSON_TYPES.NEW;
  }

  // --- 3. rest_required --------------------------------------------------
  // 简易: 低分 + 高困惑 = 必须休. 连续无 rest 计数由 cadence-state 给.
  const restRequired =
    (score < GROWTH_THRESHOLDS.SCORE_LOW) ||
    (mode !== CADENCE_MODES.FINAL && confusion >= 0.7);

  // --- 4. ratios + kp_coefficient (Hybrid 适用) ---------------------------
  const ratios = HYBRID_RATIOS[mode] || HYBRID_RATIOS[CADENCE_MODES.BALANCED];
  const kpCoeff = KP_DENSITY_COEFFICIENTS[mode] != null
    ? KP_DENSITY_COEFFICIENTS[mode] : 1.0;

  const result = {
    cadence_mode: mode,
    next_lesson_type: nextType,
    rest_required: restRequired,
    rationale,
    ratios: { ...ratios },
    kp_coefficient: kpCoeff,
    milestone_progress: milestone,
    days_remaining: days,
  };
  // W8.3 adaptive UX — caller may pass input.cadenceIntensity to scale days.
  const mod = _uxCadence();
  if (mod && input && input.cadenceIntensity) {
    return mod.applyCadenceIntensity(result, input.cadenceIntensity);
  }
  return result;
}

// =====================================================================
// PUBLIC: decideNextLessonType — 给定 cadence state, 输出下一课类型.
// 输入是已 computeCadence 后的 decision object + 可选 prior cadence state.
// =====================================================================

/**
 * @param {object} cadenceState — { cadence_mode, reviewNodesDue?, milestoneProgress?, ... }
 *                                可直接传 computeCadence 输出, 也可叠加持久状态.
 * @returns {'new'|'review'|'integration'|'final_compression'}
 */
function decideNextLessonType(cadenceState) {
  if (!cadenceState || typeof cadenceState !== 'object') return NEXT_LESSON_TYPES.NEW;
  if (cadenceState.cadence_mode === CADENCE_MODES.FINAL) return NEXT_LESSON_TYPES.FINAL_COMPRESSION;
  if (shouldTriggerReviewDay(cadenceState)) return NEXT_LESSON_TYPES.REVIEW;
  if (shouldTriggerIntegrationDay(cadenceState)) return NEXT_LESSON_TYPES.INTEGRATION;
  return NEXT_LESSON_TYPES.NEW;
}

// =====================================================================
// PUBLIC: shouldTriggerReviewDay — 是否插 Review Day.
// 规则: reviewNodesDue ≥ 3 OR (lessonIdx - lastReviewIdx) > 7.
// =====================================================================

/**
 * @param {object} cadenceState
 * @param {number} [cadenceState.reviewNodesDue]
 * @param {number} [cadenceState.lessonIdx]
 * @param {number} [cadenceState.lastReviewIdx]   — 上次 review-triggered 的课序号
 * @returns {boolean}
 */
function shouldTriggerReviewDay(cadenceState) {
  if (!cadenceState || typeof cadenceState !== 'object') return false;
  const due = _num(cadenceState.reviewNodesDue, 0);
  if (due >= TRIGGER_THRESHOLDS.REVIEW_NODES_DUE_MIN) return true;
  const lessonIdx = _num(cadenceState.lessonIdx);
  const lastReview = _num(cadenceState.lastReviewIdx);
  if (lessonIdx != null && lastReview != null) {
    return (lessonIdx - lastReview) > TRIGGER_THRESHOLDS.LESSONS_SINCE_REVIEW_MAX;
  }
  // 从未 review 过 + lessonIdx > 7 → 触发首个 review.
  if (lessonIdx != null && lastReview == null) {
    return lessonIdx > TRIGGER_THRESHOLDS.LESSONS_SINCE_REVIEW_MAX;
  }
  return false;
}

// =====================================================================
// PUBLIC: shouldTriggerIntegrationDay — 是否插 Integration Day.
// 规则: milestoneProgress 跨过 0.25/0.5/0.75 阈值 (跟 cadence-state.milestoneCrossed[] 比对).
// =====================================================================

/**
 * @param {object} cadenceState
 * @param {number} cadenceState.milestoneProgress  — 当前 0..1
 * @param {number[]} [cadenceState.milestoneCrossed] — 已触发过的阈值列表 e.g. [0.25]
 * @returns {boolean}
 */
function shouldTriggerIntegrationDay(cadenceState) {
  if (!cadenceState || typeof cadenceState !== 'object') return false;
  const progress = _num(cadenceState.milestoneProgress);
  if (progress == null) return false;
  const crossed = Array.isArray(cadenceState.milestoneCrossed)
    ? cadenceState.milestoneCrossed : [];
  for (const cp of TRIGGER_THRESHOLDS.MILESTONE_CHECKPOINTS) {
    if (progress >= cp && !crossed.includes(cp)) return true;
  }
  return false;
}

// =====================================================================
// PUBLIC: shouldRest — 是否建议休息.
// 规则: 连续 ≥ 4 课无 rest + learningScore < 50.
// =====================================================================

/**
 * @param {object} cadenceState
 * @param {number} cadenceState.learningScore
 * @param {number} [cadenceState.lessonsSinceLastRest]
 * @returns {boolean}
 */
function shouldRest(cadenceState) {
  if (!cadenceState || typeof cadenceState !== 'object') return false;
  const score = _num(cadenceState.learningScore);
  const since = _num(cadenceState.lessonsSinceLastRest, 0);
  if (score == null) return false;
  return since >= TRIGGER_THRESHOLDS.CONSECUTIVE_LESSONS_NO_REST &&
         score < GROWTH_THRESHOLDS.SCORE_LOW;
}

// =====================================================================
// PUBLIC: nextMilestoneToCross — 给定当前 progress + crossed, 返下一个待跨阈值
// (辅助调用方更新 cadence-state.milestoneCrossed[]).
// =====================================================================

/**
 * @param {number} progress
 * @param {number[]} crossed
 * @returns {number|null}
 */
function nextMilestoneToCross(progress, crossed) {
  const p = _num(progress);
  if (p == null) return null;
  const seen = new Set(Array.isArray(crossed) ? crossed : []);
  for (const cp of TRIGGER_THRESHOLDS.MILESTONE_CHECKPOINTS) {
    if (p >= cp && !seen.has(cp)) return cp;
  }
  return null;
}

module.exports = {
  // 主入口
  computeCadence,
  decideNextLessonType,
  shouldTriggerReviewDay,
  shouldTriggerIntegrationDay,
  shouldRest,
  nextMilestoneToCross,
  // 常量 (UI / Wave 2.2 read-only 使用)
  CADENCE_MODES,
  NEXT_LESSON_TYPES,
  GOAL_TYPES,
  EXAM_DAY_BANDS,
  HYBRID_RATIOS,
  GROWTH_THRESHOLDS,
  TRIGGER_THRESHOLDS,
  KP_DENSITY_COEFFICIENTS,
};
