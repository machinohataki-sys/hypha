// app/lib/exam-system/scope-engine.js
// W7.2 Exam System — Scope Engine (4-tier).
//
// Per BLUEPRINT §13.1: Exam learning ≠ learn more, but stable recall within
// scope. 4 tiers: must_master / high_yield / recognition / out_of_scope.
//
// Pure-functional + JSON persistence layer. No LLM. Classification falls back
// to keyword index (deterministic) — T4_JUDGE-backed semantic classifier is
// deferred to v2.2 (see specs/exam-model-alpha.md "Future work").
//
// 关系坐标:
//   exam-cadence.js   → reads tier completion % to decide mode escalation
//   user-bank.js      → tagItem() writes tier onto each question
//   error-diagnosis   → independent (errors are per-question, not per-tier)
//   final-compression → reads must_master + high_yield as "review pool"

'use strict';

const path = require('node:path');

// =====================================================================
// CONFIG
// =====================================================================

const TIERS = Object.freeze({
  MUST_MASTER:   'must_master',     // 必须掌握 — 考试必考点
  HIGH_YIELD:    'high_yield',      // 高收益拓展 — 投产比高
  RECOGNITION:   'recognition',     // 只需认识 — 见到不慌
  OUT_OF_SCOPE:  'out_of_scope',    // 暂不学习 — 直接跳过
});

const TIER_ORDER = Object.freeze([
  TIERS.MUST_MASTER,
  TIERS.HIGH_YIELD,
  TIERS.RECOGNITION,
  TIERS.OUT_OF_SCOPE,
]);

// 蓝图 §13.1 原文 seed — 考研英语. 真 seed, 不 mock.
const KAOYAN_ENGLISH_SCOPE = Object.freeze({
  exam: 'kaoyan_english',
  display: '考研英语',
  must_master: Object.freeze([
    '核心词汇 5500',
    '高频真题词 1800',
    '熟词僻义 300',
    '高频词组 600',
    '阅读题型 7 类',
    '长难句 5 种',
    '作文模板 12 类',
  ]),
  high_yield: Object.freeze([
    '熟词僻义高级 500',
    '阅读细节定位',
    '翻译技巧 8 法',
    '写作主题词汇 300',
  ]),
  recognition: Object.freeze([
    '冷门词汇 (4000+ 之外)',
    'GRE 阅读',
  ]),
  out_of_scope: Object.freeze([
    '口语',
    '听力 (考研无)',
    '雅思类阅读',
  ]),
});

// 2026-05-13 — 常见考试 4-tier seeds. 蓝图 §13 把 exam 当一类 model, 不专指
// 考研英语。这些 seed 是 minimum-viable 起点, 用户可在 UI 编辑 (deferred v0.2,
// 当前 UI 显示 read-only)。未匹配的 examType 走空 4-tier + display=用户输入。
const IELTS_SCOPE = Object.freeze({
  exam: 'ielts',
  display: '雅思',
  must_master: Object.freeze([
    '学术词汇 8000',
    '阅读题型 14 类',
    '听力 Section 1-4',
    '写作 Task 1 框架',
    '写作 Task 2 框架',
    '口语 Part 1-3',
    '长难句精读',
  ]),
  high_yield: Object.freeze([
    '同义替换库 1500',
    '写作高分句型',
    '听力填空陷阱',
    '口语高频话题 50',
  ]),
  recognition: Object.freeze([
    'BBC 原文阅读',
    '经济学人短文',
  ]),
  out_of_scope: Object.freeze([
    'GRE 词汇',
    '考研真题词',
    '古文阅读',
  ]),
});

const TOEFL_SCOPE = Object.freeze({
  exam: 'toefl',
  display: '托福',
  must_master: Object.freeze([
    'TOEFL 学术词汇 4000',
    '听力学科 5 类',
    '阅读题型 10 类',
    '写作 综合 + 独立',
    '口语 Task 1-4',
  ]),
  high_yield: Object.freeze([
    '笔记技巧',
    '综合写作模板',
    '口语万能模板',
  ]),
  recognition: Object.freeze([
    'GRE 词汇',
  ]),
  out_of_scope: Object.freeze([
    '雅思口语',
    '考研真题词',
  ]),
});

const GMAT_SCOPE = Object.freeze({
  exam: 'gmat',
  display: 'GMAT',
  must_master: Object.freeze([
    'Quant 数学 5 类',
    'SC 句子改错 12 大点',
    'RC 阅读 4 类',
    'CR 逻辑 9 题型',
  ]),
  high_yield: Object.freeze([
    'GMAT 词汇高级',
    'SC 长难句辨析',
    'DS 数据充分性',
  ]),
  recognition: Object.freeze([
    'AWA 写作 Issue',
    'IR 综合推理',
  ]),
  out_of_scope: Object.freeze([
    '雅思口语',
    '托福口语',
  ]),
});

const GRE_SCOPE = Object.freeze({
  exam: 'gre',
  display: 'GRE',
  must_master: Object.freeze([
    '核心词汇 8000',
    '填空 6 题型',
    '阅读 4 类',
    '数学 Q170',
  ]),
  high_yield: Object.freeze([
    '同义辨析',
    '长难句精读',
    '数学陷阱题',
  ]),
  recognition: Object.freeze([
    '写作 Issue / Argument',
  ]),
  out_of_scope: Object.freeze([
    '雅思口语',
    '听力',
  ]),
});

const JLPT_N1_SCOPE = Object.freeze({
  exam: 'jlpt_n1',
  display: '日语 N1',
  must_master: Object.freeze([
    'N1 文法 100',
    'N1 词汇 10000',
    '长文读解 5 类',
    '听力 N1',
    '汉字读音',
  ]),
  high_yield: Object.freeze([
    '同义敬语',
    '商务日语',
  ]),
  recognition: Object.freeze([
    '古文',
    '关西方言',
  ]),
  out_of_scope: Object.freeze([
    '口语会话',
  ]),
});

const KAOYAN_POLITICS_SCOPE = Object.freeze({
  exam: 'kaoyan_politics',
  display: '考研政治',
  must_master: Object.freeze([
    '马原',
    '毛中特',
    '史纲',
    '思修法基',
    '当代时政',
  ]),
  high_yield: Object.freeze([
    '高频考点 200',
    '主观题模板',
  ]),
  recognition: Object.freeze([
    '选做题',
    '边缘考点',
  ]),
  out_of_scope: Object.freeze([
    '雅思',
    'GRE',
  ]),
});

const KAOYAN_MATH_SCOPE = Object.freeze({
  exam: 'kaoyan_math',
  display: '考研数学',
  must_master: Object.freeze([
    '高数',
    '线性代数',
    '概率统计',
    '真题 1990-当前',
  ]),
  high_yield: Object.freeze([
    '高频证明题',
    '大题模板',
  ]),
  recognition: Object.freeze([
    '数学竞赛',
    '数学分析',
  ]),
  out_of_scope: Object.freeze([
    '雅思',
    'GRE',
  ]),
});

const BAR_SCOPE = Object.freeze({
  exam: 'bar',
  display: '法考 · 司法考试',
  must_master: Object.freeze([
    '民法',
    '刑法',
    '行政法',
    '民诉',
    '刑诉',
    '商经',
    '三国法',
    '理论法',
  ]),
  high_yield: Object.freeze([
    '历年真题',
    '司法解释',
  ]),
  recognition: Object.freeze([
    '边缘案例',
  ]),
  out_of_scope: Object.freeze([
    '雅思',
    '考研',
  ]),
});

// Exam-type alias map → seed key. Multi-language entry points all converge.
const _EXAM_ALIASES = Object.freeze({
  // 考研英语 (default)
  '考研英语': KAOYAN_ENGLISH_SCOPE,
  'kaoyan english': KAOYAN_ENGLISH_SCOPE,
  'kaoyan_english': KAOYAN_ENGLISH_SCOPE,
  // 雅思
  '雅思': IELTS_SCOPE,
  'ielts': IELTS_SCOPE,
  // 托福
  '托福': TOEFL_SCOPE,
  'toefl': TOEFL_SCOPE,
  // GMAT
  'gmat': GMAT_SCOPE,
  // GRE
  'gre': GRE_SCOPE,
  // 日语 N1
  '日语 n1': JLPT_N1_SCOPE,
  '日语n1': JLPT_N1_SCOPE,
  'n1': JLPT_N1_SCOPE,
  'jlpt n1': JLPT_N1_SCOPE,
  'jlpt_n1': JLPT_N1_SCOPE,
  // 考研政治 / 考研数学
  '考研政治': KAOYAN_POLITICS_SCOPE,
  '考研数学': KAOYAN_MATH_SCOPE,
  // 法考
  '法考': BAR_SCOPE,
  '司法': BAR_SCOPE,
  '司法考试': BAR_SCOPE,
  '法律职业资格': BAR_SCOPE,
});

// _resolveSeed — pick a seed by exam-type string. Tolerant: lowercase + trim.
// Returns null if no match (caller renders empty 4-tier + user-supplied display).
function _resolveSeed(examType) {
  if (!examType || typeof examType !== 'string') return null;
  const key = examType.trim().toLowerCase();
  if (!key) return null;
  return _EXAM_ALIASES[key] || null;
}

function _emptyScope(display) {
  return Object.freeze({
    exam: 'custom',
    display: display || '自定考试',
    must_master: Object.freeze([]),
    high_yield: Object.freeze([]),
    recognition: Object.freeze([]),
    out_of_scope: Object.freeze([]),
    _uncondigured: true,
  });
}

// 关键词倒排 — classifyTopic 的 deterministic fallback. 词条按 tier 分桶,
// match 时取最先命中的 tier (按 TIER_ORDER 优先级). 这里只覆盖考研英语,
// v2.2 接 T4_JUDGE 后即可跨场景泛化.
const _KEYWORD_INDEX = (() => {
  const idx = {
    [TIERS.MUST_MASTER]: [
      '核心词汇', '高频真题词', '熟词僻义', '高频词组',
      '长难句', '阅读题型', '作文模板', '5500', '1800',
    ],
    [TIERS.HIGH_YIELD]: [
      '细节定位', '翻译技巧', '写作主题词汇', '熟词僻义高级',
    ],
    [TIERS.RECOGNITION]: [
      '冷门词汇', 'gre 阅读', '辨析',
    ],
    [TIERS.OUT_OF_SCOPE]: [
      '口语', '听力', '雅思', 'toefl 口语',
    ],
  };
  // Lowercase 一次, 后续 match 也 lowercase.
  for (const t of Object.keys(idx)) idx[t] = idx[t].map((s) => String(s).toLowerCase());
  return Object.freeze(idx);
})();

// =====================================================================
// PERSISTENCE — vault/<slug>/exam/scope.json
// =====================================================================

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

function _scopeRel(slug) { return `${slug}/exam/scope.json`; }

/**
 * Read scope for a curriculum. Resolution order:
 *   1. Saved `vault/<slug>/exam/scope.json` (user-curated)
 *   2. Seed matching `examType` arg (雅思 / GMAT / 日语 N1 / 法考 / ...)
 *   3. Empty 4-tier scope with display = examType (custom exam, no seed)
 *   4. Final fallback: 考研英语 seed (legacy default, when examType is empty)
 *
 * 2026-05-13 — examType arg added. Renderer (screen-exam-dashboard) passes user-
 * input exam-name from the "这门考试是" input bar. Backend resolves the seed
 * by alias; unknown exam types render with empty tiers + _uncondigured flag so
 * UI can hint "为 [name] 配置 4-tier · 自己填".
 *
 * @param {string} slug
 * @param {string} [examType]
 * @returns {object}
 */
function getScope(slug, examType) {
  _validateSlug(slug);
  const v = _getVault();
  if (v && typeof v.readJSON === 'function') {
    const got = v.readJSON(_scopeRel(slug), null);
    if (got && typeof got === 'object' && Array.isArray(got.must_master)) return got;
  }
  // examType provided → try seed alias; unknown → empty + display=examType.
  if (examType && typeof examType === 'string' && examType.trim()) {
    const seed = _resolveSeed(examType);
    if (seed) return _cloneScope(seed);
    return _cloneScope(_emptyScope(examType.trim()));
  }
  // Legacy default — no examType, no saved file: 考研英语 seed for back-compat.
  return _cloneScope(KAOYAN_ENGLISH_SCOPE);
}

/**
 * Replace scope for a slug. customScope MUST contain 4 tier arrays (validated).
 * @param {string} slug
 * @param {object} customScope
 * @returns {object}  — scope as persisted
 */
function setScope(slug, customScope) {
  _validateSlug(slug);
  if (!customScope || typeof customScope !== 'object') {
    throw new Error('customScope required');
  }
  const next = _cloneScope(customScope);
  for (const t of TIER_ORDER) {
    if (!Array.isArray(next[t])) next[t] = [];
  }
  next.updated_at = new Date().toISOString();
  const v = _getVault();
  if (v && typeof v.writeJSON === 'function') {
    v.writeJSON(_scopeRel(slug), next);
  }
  return next;
}

/**
 * Classify a topic string into one tier. Deterministic keyword match.
 * Returns OUT_OF_SCOPE on no-match — caller can override (e.g. promote to
 * recognition) based on context.
 *
 * @param {string} topicText
 * @param {object} [scope]   — optional override; defaults to KAOYAN seed
 * @returns {'must_master'|'high_yield'|'recognition'|'out_of_scope'}
 */
function classifyTopic(topicText, scope) {
  if (typeof topicText !== 'string' || !topicText.trim()) return TIERS.OUT_OF_SCOPE;
  const q = topicText.toLowerCase();
  // 1. Exact membership against scope arrays (user-curated wins).
  const sc = scope || KAOYAN_ENGLISH_SCOPE;
  for (const tier of TIER_ORDER) {
    const list = Array.isArray(sc[tier]) ? sc[tier] : [];
    for (const entry of list) {
      if (typeof entry === 'string' && q.includes(entry.toLowerCase())) return tier;
    }
  }
  // 2. Keyword index (deterministic backstop).
  for (const tier of TIER_ORDER) {
    const kws = _KEYWORD_INDEX[tier] || [];
    for (const kw of kws) {
      if (q.includes(kw)) return tier;
    }
  }
  return TIERS.OUT_OF_SCOPE;
}

/**
 * Compute per-tier completion percentage given a list of completed topic
 * strings. Surfaces "what does the user actually own?" — used by the
 * dashboard and by exam-cadence.computeExamCadence().
 *
 * @param {string} slug
 * @param {string[]} completedTopics
 * @returns {{ must_master: number, high_yield: number, recognition: number, out_of_scope: number, total: object }}
 */
function tierProgress(slug, completedTopics) {
  const scope = getScope(slug);
  const completed = new Set(
    (Array.isArray(completedTopics) ? completedTopics : [])
      .map((s) => typeof s === 'string' ? s.trim() : '')
      .filter(Boolean),
  );
  const out = {};
  for (const tier of TIER_ORDER) {
    const list = Array.isArray(scope[tier]) ? scope[tier] : [];
    const hit = list.filter((entry) => completed.has(entry)).length;
    out[tier] = list.length > 0 ? hit / list.length : 0;
  }
  out.total = {
    completed_count: completed.size,
    total_scope_items: TIER_ORDER.reduce((n, t) => n + (Array.isArray(scope[t]) ? scope[t].length : 0), 0),
  };
  return out;
}

function _cloneScope(scope) {
  return {
    exam: scope.exam || 'kaoyan_english',
    display: scope.display || '考研英语',
    must_master: Array.isArray(scope.must_master) ? scope.must_master.slice() : [],
    high_yield: Array.isArray(scope.high_yield) ? scope.high_yield.slice() : [],
    recognition: Array.isArray(scope.recognition) ? scope.recognition.slice() : [],
    out_of_scope: Array.isArray(scope.out_of_scope) ? scope.out_of_scope.slice() : [],
    ...(scope._uncondigured ? { _uncondigured: true } : {}),
  };
}

// =====================================================================
// v2-push-b2: Adaptive Scope Shrinking
// =====================================================================
//
// Hypothesis (蓝图 §13.1 extension): when a learner fails N consecutive
// questions inside a tier, the in-flight scope is over-budget for the
// learner's current mastery. Auto-shrink: drop the failing tier's frontier,
// retreat to the prerequisite tier (one rung shallower in TIER_ORDER).
//
// must_master fails → already at floor; surface "rebuild prerequisites"
// signal but do not shrink below must_master.
// high_yield  fails → shrink to must_master only.
// recognition fails → shrink to high_yield + must_master.
// out_of_scope fails → effectively never (already excluded); idempotent.
//
// Persistence: vault/<slug>/exam/tier-attempts.json
// Schema: { tiers: { <tier>: { recent: [bool, ...max 16] } }, updated_at }

const _ATTEMPTS_REL = (slug) => `${slug}/exam/tier-attempts.json`;
const _SHRINK_THRESHOLD = 3;
const _ATTEMPT_HISTORY_MAX = 16;

function _readAttempts(slug) {
  const v = _getVault();
  if (!v || typeof v.readJSON !== 'function') return { tiers: {} };
  const got = v.readJSON(_ATTEMPTS_REL(slug), null);
  if (got && typeof got === 'object' && got.tiers && typeof got.tiers === 'object') return got;
  return { tiers: {} };
}

function _writeAttempts(slug, state) {
  const v = _getVault();
  if (!v || typeof v.writeJSON !== 'function') return;
  v.writeJSON(_ATTEMPTS_REL(slug), { ...state, updated_at: new Date().toISOString() });
}

/**
 * Record one attempt against a tier. isFail = true → learner missed.
 * Returns the updated tier history (most recent last).
 *
 * @param {string} slug
 * @param {string} tier  — one of TIER_ORDER
 * @param {boolean} isFail
 * @returns {{ tier: string, recent: boolean[], consecutive_fails: number }}
 */
function recordTierAttempt(slug, tier, isFail) {
  _validateSlug(slug);
  if (!TIER_ORDER.includes(tier)) throw new Error(`invalid tier: ${tier}`);
  const state = _readAttempts(slug);
  const bucket = state.tiers[tier] || { recent: [] };
  const next = bucket.recent.slice();
  next.push(Boolean(isFail));
  while (next.length > _ATTEMPT_HISTORY_MAX) next.shift();
  state.tiers[tier] = { recent: next };
  _writeAttempts(slug, state);
  let consecutive = 0;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] === true) consecutive++; else break;
  }
  return { tier, recent: next, consecutive_fails: consecutive };
}

/**
 * Inspect whether scope should shrink. Returns a directive object the caller
 * applies (UI banner / auto-shrink toggle / nothing). Caller decides whether
 * to mutate the active scope — this function only reports.
 *
 * @param {string} slug
 * @returns {{ shrink: boolean, tier?: string, retreat_to?: string[], consecutive_fails?: number, reason?: string }}
 */
function shouldShrinkScope(slug) {
  _validateSlug(slug);
  const state = _readAttempts(slug);
  // Check from frontier (out_of_scope) inward — shrink the outermost failing tier first.
  for (const tier of [TIERS.RECOGNITION, TIERS.HIGH_YIELD, TIERS.MUST_MASTER]) {
    const bucket = state.tiers && state.tiers[tier];
    if (!bucket || !Array.isArray(bucket.recent)) continue;
    let consecutive = 0;
    for (let i = bucket.recent.length - 1; i >= 0; i--) {
      if (bucket.recent[i] === true) consecutive++; else break;
    }
    if (consecutive >= _SHRINK_THRESHOLD) {
      const idx = TIER_ORDER.indexOf(tier);
      const retreat = idx > 0 ? TIER_ORDER.slice(0, idx) : [TIERS.MUST_MASTER];
      return {
        shrink: true,
        tier,
        retreat_to: retreat,
        consecutive_fails: consecutive,
        reason: tier === TIERS.MUST_MASTER
          ? `must_master 连续失败 ${consecutive} 次 — 已在底层, 建议重建 prerequisite`
          : `${tier} 连续失败 ${consecutive} 次, 退到 ${retreat.join(' + ')}`,
      };
    }
  }
  return { shrink: false };
}

/**
 * Apply a shrink directive to the saved scope. Items in failing tier and
 * above are moved to recognition (preserved, not lost). Returns the new scope.
 *
 * @param {string} slug
 * @param {object} [directive] — output of shouldShrinkScope; if omitted, recomputed
 */
function applyScopeShrink(slug, directive) {
  _validateSlug(slug);
  const d = directive || shouldShrinkScope(slug);
  if (!d || !d.shrink) return { shrunk: false, scope: getScope(slug) };
  const scope = getScope(slug);
  const failingTier = d.tier;
  const failingIdx = TIER_ORDER.indexOf(failingTier);
  // For each tier from failingTier through recognition, demote one level.
  const next = _cloneScope(scope);
  if (failingTier !== TIERS.MUST_MASTER) {
    const drained = Array.isArray(next[failingTier]) ? next[failingTier].slice() : [];
    next[failingTier] = [];
    // Demote: push into the tier below (one rung shallower).
    const belowTier = TIER_ORDER[failingIdx - 1];
    if (belowTier && Array.isArray(next[belowTier])) {
      // De-dup as we merge.
      const seen = new Set(next[belowTier]);
      for (const item of drained) if (!seen.has(item)) next[belowTier].push(item);
    }
  }
  next.shrunk_at = new Date().toISOString();
  next.shrunk_from = failingTier;
  setScope(slug, next);
  return { shrunk: true, scope: next, directive: d };
}

/**
 * Reset attempt history for a tier (e.g. after user passes a re-test).
 */
function resetTierAttempts(slug, tier) {
  _validateSlug(slug);
  if (!TIER_ORDER.includes(tier)) throw new Error(`invalid tier: ${tier}`);
  const state = _readAttempts(slug);
  state.tiers[tier] = { recent: [] };
  _writeAttempts(slug, state);
  return { ok: true, tier };
}

module.exports = {
  // Constants
  TIERS,
  TIER_ORDER,
  KAOYAN_ENGLISH_SCOPE,
  // API
  getScope,
  setScope,
  classifyTopic,
  tierProgress,
  // v2-push-b2: adaptive shrink
  recordTierAttempt,
  shouldShrinkScope,
  applyScopeShrink,
  resetTierAttempts,
};
