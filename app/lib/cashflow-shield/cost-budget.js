'use strict';

// HYPHA · W8.4 Cost Budget Engine (BLUEPRINT §17.3 + ROADMAP v2.4)
//
// Per-lesson + per-tier caps on capability classes (T6/T4/T3). T2_LOCAL stays
// unlimited because it runs on the user's machine (no cashflow risk).
// BYOK is unlimited at the platform level because the user supplies their
// own keys — we still log usage for telemetry but do not block.
//
// Files written:
//   vault/<slug>/cost-log.jsonl            (append-only call log)
//   vault/<slug>/cost-budget.json          (per-lesson running counters)
//
// Surface signal — "sells goal-directed progress, not unlimited AI":
//   每节课预算 = T6 / T4 / T3 上限, 不卖无限度模型.

const fs = require('node:fs');
const path = require('node:path');
const vault = require('../vault');

// -- tiers ------------------------------------------------------------------

const TIER_NAMES = Object.freeze(['Pro', 'Founders', 'BYOK']);

// 2026-05-13 — dev-mode budget bypass. Developers running Hypha against
// their own keys (BYOK) or via Hypha-personal.bat (HYPHA_ALLOW_CLI=1) should
// not be metered against the consumer Pro ¥5/day ceiling. Effective tier
// auto-promotes to BYOK (Infinity caps) when any of these signals fire.
function isDevMode() {
  const env = process.env || {};
  return env.HYPHA_DEV === '1'
      || env.HYPHA_ALLOW_CLI === '1'
      || env.NODE_ENV === 'development';
}

/**
 * Per-lesson budget table: tier → capability → integer max calls.
 * Infinity means "no limit" (BYOK + T2_LOCAL).
 */
const LESSON_COST_BUDGET = Object.freeze({
  Pro:      { T6_STRONG: 4,  T4_JUDGE: 8,  T3_MID: 16, T2_LOCAL: Infinity, T1_EMBED: Infinity },
  Founders: { T6_STRONG: 8,  T4_JUDGE: 16, T3_MID: 32, T2_LOCAL: Infinity, T1_EMBED: Infinity },
  BYOK:     { T6_STRONG: Infinity, T4_JUDGE: Infinity, T3_MID: Infinity, T2_LOCAL: Infinity, T1_EMBED: Infinity },
});

// Approximate ¥ per 1k input tokens (read-only, used for `getCostReport`).
// Numbers are deliberately conservative — they overshoot real cost slightly
// so the shield trips *before* surprise charges, not after.
const APPROX_PRICE_PER_1K_CNY = Object.freeze({
  T6_STRONG: 0.025,
  T4_JUDGE:  0.008,
  T3_MID:    0.004,
  T2_LOCAL:  0,
  T1_EMBED:  0,
});

// -- io ---------------------------------------------------------------------

function _slugDir(slug) {
  if (!slug || typeof slug !== 'string') throw new Error('cost.invalid_slug');
  const root = vault.resolveRoot();
  const dir = path.join(root, slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _budgetFile(slug) {
  return path.join(_slugDir(slug), 'cost-budget.json');
}

function _logFile(slug) {
  return path.join(_slugDir(slug), 'cost-log.jsonl');
}

function _readBudget(slug) {
  const f = _budgetFile(slug);
  if (!fs.existsSync(f)) return { lessons: {} };
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (_) { return { lessons: {} }; }
}

function _writeBudget(slug, data) {
  const f = _budgetFile(slug);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

function _resolveTier(tier) {
  if (isDevMode()) return 'BYOK';
  if (!tier) return 'Pro';
  if (!TIER_NAMES.includes(tier)) throw new Error(`cost.invalid_tier:${tier}`);
  return tier;
}

// -- core API ---------------------------------------------------------------

/**
 * Record one LLM call for a (slug, lessonIdx). Appends to cost-log.jsonl
 * and bumps the per-lesson counter in cost-budget.json.
 *
 * @param {string} slug
 * @param {number} lessonIdx
 * @param {string} capability — e.g. 'T6_STRONG'
 * @param {{input?: number, output?: number}|number} [tokens]
 * @returns {{ok: boolean, total_calls?: number, error?: string}}
 */
function recordLLMCall(slug, lessonIdx, capability, tokens) {
  try {
    if (!Number.isFinite(lessonIdx) || lessonIdx < 0) {
      throw new Error('cost.invalid_lesson_idx');
    }
    if (typeof capability !== 'string') throw new Error('cost.invalid_capability');

    const t = (typeof tokens === 'number')
      ? { input: tokens, output: 0 }
      : { input: (tokens && tokens.input) || 0, output: (tokens && tokens.output) || 0 };
    const totalTok = (t.input || 0) + (t.output || 0);
    const cost_cny = ((APPROX_PRICE_PER_1K_CNY[capability] || 0) * totalTok) / 1000;

    const ts = Date.now();
    const logLine = JSON.stringify({
      ts, slug, lessonIdx, capability,
      input_tokens: t.input, output_tokens: t.output,
      cost_cny: Number(cost_cny.toFixed(6)),
    }) + '\n';
    fs.appendFileSync(_logFile(slug), logLine);

    const data = _readBudget(slug);
    const key = String(lessonIdx);
    data.lessons[key] = data.lessons[key] || { counts: {}, cost_cny: 0 };
    data.lessons[key].counts[capability] = (data.lessons[key].counts[capability] || 0) + 1;
    data.lessons[key].cost_cny = Number(((data.lessons[key].cost_cny || 0) + cost_cny).toFixed(6));
    _writeBudget(slug, data);

    return { ok: true, total_calls: data.lessons[key].counts[capability], cost_cny };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Compute remaining budget for a lesson under a tier.
 * @returns {{T6_STRONG: number|Infinity, T4_JUDGE: number|Infinity, T3_MID: number|Infinity, tier: string, lessonIdx: number}}
 */
function getRemainingBudget(slug, lessonIdx, tier = 'Pro') {
  const tierName = _resolveTier(tier);
  const caps = LESSON_COST_BUDGET[tierName];
  const data = _readBudget(slug);
  const counts = (data.lessons[String(lessonIdx)] || {}).counts || {};
  const remain = {};
  for (const cap of Object.keys(caps)) {
    const max = caps[cap];
    if (max === Infinity) { remain[cap] = Infinity; continue; }
    remain[cap] = Math.max(0, max - (counts[cap] || 0));
  }
  return { ...remain, tier: tierName, lessonIdx };
}

/**
 * Pre-call gate. Returns true if firing one more call of `capability`
 * would push us over the per-lesson tier cap.
 */
function wouldExceedBudget(slug, lessonIdx, capability, tier = 'Pro') {
  try {
    const tierName = _resolveTier(tier);
    const cap = LESSON_COST_BUDGET[tierName][capability];
    if (cap === undefined) return false; // unknown capability — defer to caller
    if (cap === Infinity) return false;
    const data = _readBudget(slug);
    const counts = (data.lessons[String(lessonIdx)] || {}).counts || {};
    return (counts[capability] || 0) >= cap;
  } catch (_) {
    return false; // never block on internal error — fail open
  }
}

/**
 * Aggregate cost across all lessons of a slug.
 * `period` ∈ { 'lesson', 'day', 'week', 'month', 'all' } — controls the
 * cutoff used on `cost-log.jsonl` lines.
 */
function getCostReport(slug, period = 'month') {
  const f = _logFile(slug);
  if (!fs.existsSync(f)) {
    return { total_cost_cny: 0, by_capability: {}, by_lesson: {}, period, line_count: 0 };
  }
  const PERIOD_MS = {
    lesson: null,
    day:   24 * 3600_000,
    week:  7 * 24 * 3600_000,
    month: 30 * 24 * 3600_000,
    all:   null,
  };
  const cutoffMs = PERIOD_MS[period];
  const cutoff = (period === 'all' || period === 'lesson') ? 0 : Date.now() - (cutoffMs || 0);

  let total = 0;
  const byCap = {};
  const byLesson = {};
  let lineCount = 0;

  const raw = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  for (const line of raw) {
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    if (!row || !row.ts) continue;
    if (cutoff > 0 && row.ts < cutoff) continue;
    lineCount += 1;
    total += row.cost_cny || 0;
    byCap[row.capability] = Number(((byCap[row.capability] || 0) + (row.cost_cny || 0)).toFixed(6));
    const lk = String(row.lessonIdx);
    byLesson[lk] = Number(((byLesson[lk] || 0) + (row.cost_cny || 0)).toFixed(6));
  }
  return {
    total_cost_cny: Number(total.toFixed(6)),
    by_capability: byCap,
    by_lesson: byLesson,
    period,
    line_count: lineCount,
  };
}

module.exports = {
  TIER_NAMES,
  LESSON_COST_BUDGET,
  APPROX_PRICE_PER_1K_CNY,
  isDevMode,
  recordLLMCall,
  getRemainingBudget,
  wouldExceedBudget,
  getCostReport,
};
