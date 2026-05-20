// app/lib/exam-system/exam-cadence.js
// W7.2 Exam System — Deadline-Aware Cadence (exam-stream).
//
// Per BLUEPRINT §13.4 + Wave 7.2 spec. Layered ON TOP of W2.1 cadence-engine:
//   W2.1 cadence-engine  → general lesson rhythm (deep / balanced / compress / final)
//   W7.2 exam-cadence    → exam-stream specific 4-phase plan around scope coverage:
//                            expansion → consolidation → compression → final
//
// 边界:
//   - W2.1 拍课节奏 (节-level: 1 课走多深)
//   - W7.2 拍考期阶段 (考-level: 学新 / 巩固 / 压缩 / 终)
//   - 两者纯函数, 互不调用. 调用方 (main.js) 组合.
//
// Pure: no I/O, no LLM. Returns a decision object — caller persists.

'use strict';

const EXAM_MODES = Object.freeze({
  EXPANSION:      'expansion',      // > 60 天 — 学新, 引 high_yield
  CONSOLIDATION:  'consolidation',  // 30..60 天 — 巩固 must_master 全
  COMPRESSION:    'compression',    // 7..30 天 — 错题 + 真题模拟
  FINAL:          'final',          // ≤ 7 天 — 停学新, Final Compression
  INVALID:        'invalid',
});

const FOCUS = Object.freeze({
  NEW_MUST_MASTER:      'new_must_master',
  NEW_HIGH_YIELD:       'new_high_yield',
  CONSOLIDATE_GAPS:     'consolidate_gaps',
  ERROR_DRILL:          'error_drill',
  TIMED_MOCK:           'timed_mock',
  REVIEW_HIGH_FREQ:     'review_high_freq',
  ESSAY_COMPRESSION:    'essay_compression',
  LIGHT_MOCK:           'light_mock',
});

// 模式带宽 (天数). 由窄到宽扫描, 第一个命中即赢.
const MODE_BANDS = Object.freeze([
  { max_days: 7,            mode: EXAM_MODES.FINAL          },
  { max_days: 30,           mode: EXAM_MODES.COMPRESSION    },
  { max_days: 60,           mode: EXAM_MODES.CONSOLIDATION  },
  { max_days: Infinity,     mode: EXAM_MODES.EXPANSION      },
]);

// 每模式 lesson_split 推荐 (per-day 配比). 调用方乘到 W2.1 ratios 上.
// 字段含义: new = 学新课 / review = 复习 / drill = 错题/真题 / mock = 模拟卷.
const MODE_LESSON_SPLIT = Object.freeze({
  [EXAM_MODES.EXPANSION]:     Object.freeze({ new: 70, review: 20, drill: 10, mock: 0 }),
  [EXAM_MODES.CONSOLIDATION]: Object.freeze({ new: 40, review: 40, drill: 20, mock: 0 }),
  [EXAM_MODES.COMPRESSION]:   Object.freeze({ new: 10, review: 30, drill: 40, mock: 20 }),
  [EXAM_MODES.FINAL]:         Object.freeze({ new:  0, review: 50, drill: 30, mock: 20 }),
});

const MODE_PRIMARY_FOCUS = Object.freeze({
  [EXAM_MODES.EXPANSION]:     FOCUS.NEW_MUST_MASTER,
  [EXAM_MODES.CONSOLIDATION]: FOCUS.CONSOLIDATE_GAPS,
  [EXAM_MODES.COMPRESSION]:   FOCUS.ERROR_DRILL,
  [EXAM_MODES.FINAL]:         FOCUS.REVIEW_HIGH_FREQ,
});

// =====================================================================
// HELPERS
// =====================================================================

function _num(v, fb = null) {
  if (v === null || v === undefined || v === '') return fb;
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function _clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
}

// =====================================================================
// PUBLIC API
// =====================================================================

/**
 * Compute exam-stream cadence.
 *
 * @param {object} input
 * @param {number} input.daysRemaining
 * @param {object} [input.currentScopeProgress]   — { must_master: 0..1, high_yield: 0..1, ... }
 * @param {number} [input.errorAccumulation]      — # unreviewed errors in error-log
 * @returns {{
 *   mode: 'expansion'|'consolidation'|'compression'|'final'|'invalid',
 *   focus: string,
 *   lesson_split: { new:number, review:number, drill:number, mock:number },
 *   rationale: string,
 *   escalations: string[],
 *   days_remaining: number|null,
 * }}
 */
function computeExamCadence(input) {
  if (!input || typeof input !== 'object') {
    return {
      mode: EXAM_MODES.INVALID,
      focus: FOCUS.NEW_MUST_MASTER,
      lesson_split: { new: 0, review: 0, drill: 0, mock: 0 },
      rationale: 'invalid input: not an object',
      escalations: [],
      days_remaining: null,
    };
  }
  const daysRaw = _num(input.daysRemaining);
  if (daysRaw == null) {
    return {
      mode: EXAM_MODES.INVALID,
      focus: FOCUS.NEW_MUST_MASTER,
      lesson_split: { new: 0, review: 0, drill: 0, mock: 0 },
      rationale: 'invalid input: daysRemaining required (≥ 0)',
      escalations: [],
      days_remaining: null,
    };
  }
  const days = Math.max(0, daysRaw);

  // 1. Mode by time band.
  let mode = EXAM_MODES.EXPANSION;
  for (const b of MODE_BANDS) {
    if (days <= b.max_days) { mode = b.mode; break; }
  }

  // 2. Focus + escalations based on scope progress + error accumulation.
  let focus = MODE_PRIMARY_FOCUS[mode];
  const escalations = [];
  const sp = input.currentScopeProgress && typeof input.currentScopeProgress === 'object'
    ? input.currentScopeProgress : {};
  const mustPct = _clamp01(_num(sp.must_master, 0));
  const errAcc = Math.max(0, _num(input.errorAccumulation, 0) || 0);

  // Expansion 但 must_master < 50% → 优先 must_master (不引 high_yield 太早).
  if (mode === EXAM_MODES.EXPANSION && mustPct < 0.5) {
    focus = FOCUS.NEW_MUST_MASTER;
    escalations.push('must_master 覆盖 < 50%, 推迟 high_yield 拓展');
  } else if (mode === EXAM_MODES.EXPANSION && mustPct >= 0.7) {
    focus = FOCUS.NEW_HIGH_YIELD;
    escalations.push('must_master 覆盖 ≥ 70%, 启 high_yield');
  }

  // Consolidation 但错题积压 ≥ 20 → 强制转 ERROR_DRILL.
  if (mode === EXAM_MODES.CONSOLIDATION && errAcc >= 20) {
    focus = FOCUS.ERROR_DRILL;
    escalations.push(`错题积压 ${errAcc} ≥ 20, 优先错题清算`);
  }

  // Compression 但 must_master < 0.85 → 警告 (用户可能 deadline 前赶不完).
  if (mode === EXAM_MODES.COMPRESSION && mustPct < 0.85) {
    escalations.push(`compression 期 must_master 仅 ${(mustPct * 100).toFixed(0)}%, 进度告警`);
  }

  const rationale = `Exam · 剩 ${days} 天 → ${mode} (focus=${focus})`;
  return {
    mode,
    focus,
    lesson_split: { ...MODE_LESSON_SPLIT[mode] },
    rationale,
    escalations,
    days_remaining: days,
  };
}

/**
 * 是否进入 final compression. 给 main.js / UI 一处统一判断, 不在 UI 重复
 * 阈值. 与 computeExamCadence 一致: ≤ 7 天 = final.
 */
function isFinalCompressionMode(daysRemaining) {
  const d = _num(daysRemaining);
  if (d == null) return false;
  return d <= 7;
}

/**
 * 给 W2.2 assignment-cadence 用. Exam mode → recommended assignment Level
 * range. final → L1 (micro proof 复习); compression → L2-L3; consolidation
 * → L2-L3; expansion → L3-L4. 调用方在生成作业时 clamp.
 */
function assignmentLevelRangeForMode(mode) {
  switch (mode) {
    case EXAM_MODES.FINAL:         return { min: 1, max: 1, hint: 'final · micro proof only' };
    case EXAM_MODES.COMPRESSION:   return { min: 2, max: 3, hint: 'compression · small practice + applied task' };
    case EXAM_MODES.CONSOLIDATION: return { min: 2, max: 3, hint: 'consolidation · drilling + applied' };
    case EXAM_MODES.EXPANSION:     return { min: 3, max: 4, hint: 'expansion · applied + product spark' };
    default:                       return { min: 1, max: 3, hint: 'default range' };
  }
}

module.exports = {
  // Constants
  EXAM_MODES,
  FOCUS,
  MODE_BANDS,
  MODE_LESSON_SPLIT,
  MODE_PRIMARY_FOCUS,
  // API
  computeExamCadence,
  isFinalCompressionMode,
  assignmentLevelRangeForMode,
};
