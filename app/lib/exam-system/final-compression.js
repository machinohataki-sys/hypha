// app/lib/exam-system/final-compression.js
// W7.2 Exam System — Final Compression (蓝图 §13.4).
//
// Deadline ≤ 7 天进入 final mode. 蓝图原文:
//   - 停止开新模块
//   - 复习高频点
//   - 回顾错题
//   - 压缩作文模板
//   - 限时训练
//   - 轻量模拟
//   - 保持状态
//
// 5 task type (mapping 上面 7 项 → 5 type, 第 1 项已经在 exam-cadence
// mode='final' 中表达 = "停学新", 第 7 项 "保持状态" = side-effect of 整套):
//   1. review_high_freq         — 复习高频点
//   2. review_errors            — 回顾错题
//   3. compress_essay_templates — 压缩作文模板
//   4. time_limited_practice    — 限时训练
//   5. light_mock               — 轻量模拟

'use strict';

const path = require('node:path');
const examCadence = require('./exam-cadence');
const scopeEngine = require('./scope-engine');
const errorDiagnosis = require('./error-diagnosis');

let _vault = null;
function _getVault() {
  if (_vault) return _vault;
  try { _vault = require('../vault'); } catch (_) { _vault = null; }
  return _vault;
}

function _validateSlug(slug) {
  if (typeof slug !== 'string' || !slug.trim()) throw new Error('slug required');
  if (slug.includes('..') || path.isAbsolute(slug)) throw new Error(`invalid slug: ${slug}`);
}

function _finalStateRel(slug) { return `${slug}/exam/final-state.json`; }

const TASK_TYPES = Object.freeze({
  REVIEW_HIGH_FREQ:        'review_high_freq',
  REVIEW_ERRORS:           'review_errors',
  COMPRESS_ESSAY:          'compress_essay_templates',
  TIME_LIMITED_PRACTICE:   'time_limited_practice',
  LIGHT_MOCK:              'light_mock',
});

const TASK_DISPLAY = Object.freeze({
  [TASK_TYPES.REVIEW_HIGH_FREQ]:      '复习高频点',
  [TASK_TYPES.REVIEW_ERRORS]:         '回顾错题',
  [TASK_TYPES.COMPRESS_ESSAY]:        '压缩作文模板',
  [TASK_TYPES.TIME_LIMITED_PRACTICE]: '限时训练',
  [TASK_TYPES.LIGHT_MOCK]:            '轻量模拟',
});

// 7 天 daily plan 推荐 (D-7 → D-1). 每天主任务 type. 调用方可按用户实情
// 调整 — 此 module 只给 "default scaffolding".
const DEFAULT_FINAL_PLAN = Object.freeze([
  // D-7
  Object.freeze({ day_offset: -7, primary: TASK_TYPES.REVIEW_HIGH_FREQ,    secondary: TASK_TYPES.REVIEW_ERRORS }),
  // D-6
  Object.freeze({ day_offset: -6, primary: TASK_TYPES.LIGHT_MOCK,          secondary: TASK_TYPES.REVIEW_ERRORS }),
  // D-5
  Object.freeze({ day_offset: -5, primary: TASK_TYPES.REVIEW_HIGH_FREQ,    secondary: TASK_TYPES.COMPRESS_ESSAY }),
  // D-4
  Object.freeze({ day_offset: -4, primary: TASK_TYPES.TIME_LIMITED_PRACTICE, secondary: TASK_TYPES.REVIEW_ERRORS }),
  // D-3
  Object.freeze({ day_offset: -3, primary: TASK_TYPES.LIGHT_MOCK,          secondary: TASK_TYPES.COMPRESS_ESSAY }),
  // D-2
  Object.freeze({ day_offset: -2, primary: TASK_TYPES.REVIEW_ERRORS,       secondary: TASK_TYPES.COMPRESS_ESSAY }),
  // D-1
  Object.freeze({ day_offset: -1, primary: TASK_TYPES.REVIEW_HIGH_FREQ,    secondary: null }),
]);

/**
 * Transition into final mode. Writes vault/<slug>/exam/final-state.json
 * + appends an event row signal.
 *
 * @param {string} slug
 * @returns {{ ok: boolean, entered_at: string, mode: string }}
 */
function enterFinalCompression(slug) {
  _validateSlug(slug);
  const state = {
    mode: examCadence.EXAM_MODES.FINAL,
    entered_at: new Date().toISOString(),
    stop_new_topics: true,
    version: 1,
  };
  const v = _getVault();
  if (v && typeof v.writeJSON === 'function') {
    v.writeJSON(_finalStateRel(slug), state);
  }
  if (v && typeof v.appendJSONL === 'function') {
    v.appendJSONL(`${slug}/events.jsonl`, {
      ts: state.entered_at,
      type: 'exam_final_entered',
      slug,
    });
  }
  return { ok: true, entered_at: state.entered_at, mode: state.mode };
}

/**
 * List final tasks with concrete items pulled from scope + error log.
 * Returns 5 buckets; empty bucket = no items (caller skips).
 *
 * @param {string} slug
 * @returns {{ type: string, display: string, items: any[] }[]}
 */
function finalTasks(slug) {
  _validateSlug(slug);
  const scope = scopeEngine.getScope(slug);
  const errorLog = errorDiagnosis.getErrorLog(slug, 50);

  // 1. Review high-freq = must_master items.
  const highFreqItems = Array.isArray(scope.must_master) ? scope.must_master.slice() : [];

  // 2. Review errors = top 20 from error log (most recent + high severity).
  const errorItems = errorLog
    .filter((r) => r && r.error_id)
    .slice(0, 20)
    .map((r) => ({
      error_id: r.error_id,
      cause: r.error_class,
      severity: r.severity,
      question_ref: r.question_ref,
      remediation_path: r.remediation_path,
    }));

  // 3. Compress essay templates — pull from must_master containing "作文模板".
  const essayItems = (scope.must_master || [])
    .filter((s) => typeof s === 'string' && /作文|模板|essay|template/i.test(s));

  // 4. Time-limited practice = recommend top 3 题型 from must_master 题型条目.
  const tlpItems = (scope.must_master || [])
    .filter((s) => typeof s === 'string' && (/阅读|题型|长难句/.test(s)))
    .slice(0, 3)
    .map((s) => ({ topic: s, time_limit_min: 20 }));

  // 5. Light mock = 1 full mock + scoring rubric.
  // intentional-placeholder: actual mock paper items pulled from Licensed Bank
  // (题源 layer 1) — v2.1 仅 User-owned Bank, real mock paper integration
  // deferred to v2.2 when Licensed Bank ships. UI surfaces this scaffolding
  // row + tells user to pick a mock paper from their imported bank manually.
  const mockItems = [{ name: '近年真题 · 限 90min', time_limit_min: 90, scaffold: true }];

  return [
    { type: TASK_TYPES.REVIEW_HIGH_FREQ,      display: TASK_DISPLAY[TASK_TYPES.REVIEW_HIGH_FREQ],      items: highFreqItems },
    { type: TASK_TYPES.REVIEW_ERRORS,         display: TASK_DISPLAY[TASK_TYPES.REVIEW_ERRORS],         items: errorItems },
    { type: TASK_TYPES.COMPRESS_ESSAY,        display: TASK_DISPLAY[TASK_TYPES.COMPRESS_ESSAY],        items: essayItems },
    { type: TASK_TYPES.TIME_LIMITED_PRACTICE, display: TASK_DISPLAY[TASK_TYPES.TIME_LIMITED_PRACTICE], items: tlpItems },
    { type: TASK_TYPES.LIGHT_MOCK,            display: TASK_DISPLAY[TASK_TYPES.LIGHT_MOCK],            items: mockItems },
  ];
}

/**
 * Build the daily plan for the final 7 days.
 * Only meaningful when daysRemaining ≤ 7.
 *
 * @param {string} slug
 * @param {number} daysRemaining
 * @returns {{ valid: boolean, plan?: object[], message?: string }}
 */
function dailyFinalPlan(slug, daysRemaining) {
  _validateSlug(slug);
  const d = Number(daysRemaining);
  if (!Number.isFinite(d) || d < 0) {
    return { valid: false, message: 'invalid daysRemaining' };
  }
  if (d > 7) {
    return { valid: false, message: '尚未进入 final compression 模式 (>7 天)' };
  }
  const allTasks = finalTasks(slug);
  const byType = {};
  for (const bucket of allTasks) byType[bucket.type] = bucket;
  // 把 DEFAULT_FINAL_PLAN slice 出"剩 d 天"那段, e.g. d=5 → 取 day_offset
  // [-5..-1] (5 行).
  const sliced = DEFAULT_FINAL_PLAN.filter((row) => row.day_offset >= -d);
  const plan = sliced.map((row) => ({
    day_offset: row.day_offset,
    days_until_exam: -row.day_offset,
    primary: row.primary ? {
      type: row.primary,
      display: TASK_DISPLAY[row.primary],
      items: (byType[row.primary] && byType[row.primary].items) || [],
    } : null,
    secondary: row.secondary ? {
      type: row.secondary,
      display: TASK_DISPLAY[row.secondary],
      items: (byType[row.secondary] && byType[row.secondary].items) || [],
    } : null,
  }));
  return { valid: true, plan };
}

/**
 * Read final-state (or null if not entered).
 */
function getFinalState(slug) {
  _validateSlug(slug);
  const v = _getVault();
  if (!v || typeof v.readJSON !== 'function') return null;
  return v.readJSON(_finalStateRel(slug), null);
}

module.exports = {
  // Constants
  TASK_TYPES,
  TASK_DISPLAY,
  DEFAULT_FINAL_PLAN,
  // API
  enterFinalCompression,
  finalTasks,
  dailyFinalPlan,
  getFinalState,
};
