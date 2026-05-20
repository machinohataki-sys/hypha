// app/lib/cadence-state.js
// W2.1 Lesson Cadence Engine — 持久化层.
//
// 配合 app/lib/cadence-engine.js (纯函数决策) — 此文件负责 read/write
// vault/<slug>/cadence-state.json + append events.jsonl 行. 不包决策逻辑.
//
// Schema (vault/<slug>/cadence-state.json):
//   {
//     lastReviewIdx:        number | null,   // 上次 review-triggered 的 lessonIdx
//     milestoneCrossed:     number[],        // 已跨越的 milestone 阈值 e.g. [0.25, 0.5]
//     restCount:            number,          // 历史 rest 次数
//     lastRestIdx:          number | null,   // 上次 rest 的 lessonIdx
//     lessonsSinceLastRest: number,          // 距上次 rest 的课数
//     cadenceMode:          string | null,   // 最近一次 computeCadence 决策
//     updatedAt:            string,          // ISO timestamp
//     version:              1
//   }
//
// Events (events.jsonl rows, type prefix 'cadence_'):
//   { ts, type: 'cadence_review_triggered',      slug, lessonIdx, reviewNodesDue }
//   { ts, type: 'cadence_integration_triggered', slug, lessonIdx, milestoneCrossed }
//   { ts, type: 'cadence_rest_required',         slug, lessonIdx, learningScore }
//   { ts, type: 'cadence_mode_shift',            slug, lessonIdx, from, to }

'use strict';

const path = require('node:path');
const fs = require('node:fs');

// Lazy require — vault module is the canonical FS layer used elsewhere
// in hypha (e.g. agent.js, main.js). 不直接 path.join + writeFile, 保持
// vault root resolution + atomic write 一致.
let _vault = null;
function _getVault() {
  if (_vault) return _vault;
  try {
    _vault = require('./vault');
  } catch (_) {
    _vault = null;
  }
  return _vault;
}

const SCHEMA_VERSION = 1;

function _defaultState() {
  return {
    lastReviewIdx: null,
    milestoneCrossed: [],
    restCount: 0,
    lastRestIdx: null,
    lessonsSinceLastRest: 0,
    cadenceMode: null,
    updatedAt: new Date().toISOString(),
    version: SCHEMA_VERSION,
  };
}

/**
 * 防御性 slug 检查. 拒绝空 / '..' / 绝对路径.
 */
function _validateSlug(slug) {
  if (typeof slug !== 'string' || !slug.trim()) {
    throw new Error('slug required');
  }
  if (slug.includes('..') || path.isAbsolute(slug)) {
    throw new Error(`invalid slug: ${slug}`);
  }
}

/**
 * 读 cadence-state.json. 不存在 → 返默认 state (不创建文件).
 *
 * @param {string} slug
 * @returns {object}  — state object (always populated, never null)
 */
function loadCadenceState(slug) {
  _validateSlug(slug);
  const v = _getVault();
  const rel = `${slug}/cadence-state.json`;
  if (v && typeof v.readJSON === 'function') {
    const got = v.readJSON(rel, null);
    if (got && typeof got === 'object') {
      // Merge default 进 (forward-compat: 老 state 缺字段时补).
      return { ..._defaultState(), ...got };
    }
    return _defaultState();
  }
  // Fallback: 直接读 (用于 test / 没 vault 注入场景).
  try {
    const full = path.resolve(slug, 'cadence-state.json');
    const txt = fs.readFileSync(full, 'utf8');
    return { ..._defaultState(), ...JSON.parse(txt) };
  } catch (_) {
    return _defaultState();
  }
}

/**
 * 写 cadence-state.json. patch 与现有 state shallow-merge.
 *
 * @param {string} slug
 * @param {object} patch  — partial state, merge into existing
 * @returns {object}      — merged state actually written
 */
function updateCadenceState(slug, patch) {
  _validateSlug(slug);
  const v = _getVault();
  const current = loadCadenceState(slug);
  const next = {
    ...current,
    ...(patch && typeof patch === 'object' ? patch : {}),
    updatedAt: new Date().toISOString(),
    version: SCHEMA_VERSION,
  };
  const rel = `${slug}/cadence-state.json`;
  if (v && typeof v.writeJSON === 'function') {
    v.writeJSON(rel, next);
    return next;
  }
  // Fallback raw write.
  const full = path.resolve(slug, 'cadence-state.json');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * Append 一行 cadence event 到 events.jsonl. 不存在则创建.
 * 容错: 失败 silently no-op (cadence events 非关键路径, 不该 break lesson flow).
 *
 * @param {string} slug
 * @param {object} ev   — must include { type, ... }
 * @returns {boolean}   — true if appended, false on failure
 */
function appendCadenceEvent(slug, ev) {
  try {
    _validateSlug(slug);
    if (!ev || typeof ev !== 'object' || !ev.type) return false;
    const row = {
      ts: new Date().toISOString(),
      slug,
      ...ev,
    };
    const line = JSON.stringify(row) + '\n';
    const v = _getVault();
    if (v && typeof v.appendText === 'function') {
      v.appendText(`${slug}/events.jsonl`, line);
      return true;
    }
    // Fallback: 直接 fs.appendFile.
    const full = path.resolve(slug, 'events.jsonl');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.appendFileSync(full, line, 'utf8');
    return true;
  } catch (_) {
    // Non-fatal — cadence event loss < lesson flow break.
    return false;
  }
}

/**
 * 高层 helper: 推进 cadence — 给定一次 cadence decision, 写状态 + emit 事件.
 * agent.js / main.js 调.
 *
 * @param {string} slug
 * @param {object} decision  — computeCadence(...) 输出
 * @param {object} ctx       — { lessonIdx, learningScore?, reviewNodesDue? }
 * @returns {object}         — { state, eventsEmitted: string[] }
 */
function advanceCadence(slug, decision, ctx = {}) {
  _validateSlug(slug);
  if (!decision || typeof decision !== 'object') {
    throw new Error('decision required');
  }
  const current = loadCadenceState(slug);
  const lessonIdx = Number.isFinite(ctx.lessonIdx) ? ctx.lessonIdx : current.lastRestIdx;
  const eventsEmitted = [];

  // Mode shift detection.
  if (current.cadenceMode && current.cadenceMode !== decision.cadence_mode) {
    appendCadenceEvent(slug, {
      type: 'cadence_mode_shift',
      lessonIdx,
      from: current.cadenceMode,
      to: decision.cadence_mode,
    });
    eventsEmitted.push('cadence_mode_shift');
  }

  // Review-day trigger.
  if (decision.next_lesson_type === 'review') {
    appendCadenceEvent(slug, {
      type: 'cadence_review_triggered',
      lessonIdx,
      reviewNodesDue: ctx.reviewNodesDue ?? null,
    });
    eventsEmitted.push('cadence_review_triggered');
  }

  // Integration-day trigger (when next_lesson_type signals it).
  if (decision.next_lesson_type === 'integration') {
    appendCadenceEvent(slug, {
      type: 'cadence_integration_triggered',
      lessonIdx,
      milestoneProgress: decision.milestone_progress ?? null,
    });
    eventsEmitted.push('cadence_integration_triggered');
  }

  // Rest required.
  if (decision.rest_required) {
    appendCadenceEvent(slug, {
      type: 'cadence_rest_required',
      lessonIdx,
      learningScore: ctx.learningScore ?? null,
    });
    eventsEmitted.push('cadence_rest_required');
  }

  // Persist mode + rest counters.
  const lessonsSinceRest = decision.rest_required
    ? 0
    : (current.lessonsSinceLastRest || 0) + 1;
  const restCount = decision.rest_required
    ? (current.restCount || 0) + 1
    : (current.restCount || 0);
  const lastRestIdx = decision.rest_required ? lessonIdx : current.lastRestIdx;
  const lastReviewIdx = decision.next_lesson_type === 'review'
    ? lessonIdx : current.lastReviewIdx;

  const state = updateCadenceState(slug, {
    cadenceMode: decision.cadence_mode,
    lessonsSinceLastRest: lessonsSinceRest,
    restCount,
    lastRestIdx,
    lastReviewIdx,
  });

  return { state, eventsEmitted };
}

module.exports = {
  loadCadenceState,
  updateCadenceState,
  appendCadenceEvent,
  advanceCadence,
  SCHEMA_VERSION,
};
