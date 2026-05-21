// app/lib/exam-system/error-diagnosis.js
// W7.2 Exam System — Error Diagnosis (蓝图 §13.3).
//
// 错题不只是记录, 要诊断错因. 8 类 (蓝图原文):
//   词汇 / 长难句 / 定位 / 偷换 / 因果 / 态度 / 推断 / 时间
//
// T4_JUDGE 真调用接 v2.2 (与 quality-harness micro-judges 同 router).
// 此 module 当前为 mock + heuristic — 解析 user_answer / correct_answer 差异
// 形态触发关键词, 返决定. UI 上明显标 'mock'.

'use strict';

const path = require('node:path');

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

function _errLogRel(slug) { return `${slug}/exam/error-log.jsonl`; }

// 蓝图 §13.3 原文 8 类错因.
const ERROR_CAUSES = Object.freeze({
  VOCAB:       'vocab',        // 词汇不认识
  PARSE:       'parse',        // 长难句断错
  LOCATE:      'locate',       // 定位错误
  SWAP:        'swap',         // 偷换概念
  CAUSAL:      'causal',       // 因果关系看反
  TONE:        'tone',         // 态度判断错
  OVER_INFER:  'over-infer',   // 过度推断
  TIMEOUT:     'timeout',      // 时间不够
});

const REPAIR_STRATEGY = Object.freeze({
  [ERROR_CAUSES.VOCAB]:      '加 vocab 复习节点 + 高频真题词 spaced repetition',
  [ERROR_CAUSES.PARSE]:      '插长难句模块 (5 种结构) + 切分练习',
  [ERROR_CAUSES.LOCATE]:     '阅读细节定位训练 + 关键词回扫练习',
  [ERROR_CAUSES.SWAP]:       '同义替换对照表 + 干扰项识别 drill',
  [ERROR_CAUSES.CAUSAL]:     '因果连接词清单 + 逻辑链画图练习',
  [ERROR_CAUSES.TONE]:       '作者态度词标记 + 立场判断 drill',
  [ERROR_CAUSES.OVER_INFER]: '严格"原文 / 推断"两栏对照 drill',
  [ERROR_CAUSES.TIMEOUT]:    '限时训练 + 阅读优先级排序 + 跳题策略',
});

const SEVERITY = Object.freeze({
  LOW:    'low',
  MEDIUM: 'medium',
  HIGH:   'high',
});

// =====================================================================
// HEURISTIC CLASSIFIER — 关键词形态匹配.
// 真 T4_JUDGE 接 router 接 v2.2. 这里 mock + heuristic 仍能给 UI 可用 signal.
// =====================================================================

function _heuristicClassify({ question, userAnswer, correctAnswer, context }) {
  const q = String(question || '').toLowerCase();
  const ctx = String(context || '').toLowerCase();
  const ua = String(userAnswer || '').toLowerCase();
  const ca = String(correctAnswer || '').toLowerCase();

  // 1. timeout — context 显示 timing 信号.
  if (ctx.includes('超时') || ctx.includes('timeout') || ctx.includes('time out') || ctx.includes('未做完')) {
    return { cause: ERROR_CAUSES.TIMEOUT, severity: SEVERITY.HIGH, hint: 'context 标记超时' };
  }
  // 2. tone — question 含"态度"/"attitude"/"opinion".
  if (q.includes('态度') || q.includes('attitude') || q.includes('opinion') || q.includes('view of')) {
    return { cause: ERROR_CAUSES.TONE, severity: SEVERITY.MEDIUM, hint: '态度题型' };
  }
  // 3. causal — question 含"原因"/"because"/"cause"/"due to"/"results in".
  if (q.includes('原因') || q.includes('because') || q.includes('cause') ||
      q.includes('due to') || q.includes('result') || q.includes('lead to')) {
    return { cause: ERROR_CAUSES.CAUSAL, severity: SEVERITY.MEDIUM, hint: '因果题型' };
  }
  // 4. over-infer — question 含"推断"/"infer"/"imply"/"suggest"/"likely".
  if (q.includes('推断') || q.includes('infer') || q.includes('imply') ||
      q.includes('suggest') || q.includes('likely') || q.includes('probably')) {
    return { cause: ERROR_CAUSES.OVER_INFER, severity: SEVERITY.MEDIUM, hint: '推断题型' };
  }
  // 5. locate — question 含"主旨"/"main idea"/"according to"/"paragraph".
  if (q.includes('主旨') || q.includes('main idea') || q.includes('according to') ||
      q.includes('paragraph') || q.includes('the passage')) {
    return { cause: ERROR_CAUSES.LOCATE, severity: SEVERITY.MEDIUM, hint: '定位/主旨题' };
  }
  // 6. swap — userAnswer 与 correctAnswer 同义词 / 替换形态.
  // 简易: 二者公共 token ≥ 2 且 token 排列不同 → swap 候选.
  if (ua && ca) {
    const uaToks = new Set(ua.split(/\s+/).filter(Boolean));
    const caToks = new Set(ca.split(/\s+/).filter(Boolean));
    let common = 0;
    for (const t of uaToks) if (caToks.has(t)) common++;
    if (common >= 2 && uaToks.size !== caToks.size) {
      return { cause: ERROR_CAUSES.SWAP, severity: SEVERITY.MEDIUM, hint: '近义替换形态' };
    }
  }
  // 7. parse — context 含长难句 marker (which/whose/that 多重嵌套) 或字数 ≥ 40.
  if (ctx.includes('长难句') || (ctx.split(/\s+/).filter(Boolean).length >= 40)) {
    return { cause: ERROR_CAUSES.PARSE, severity: SEVERITY.MEDIUM, hint: '长句嫌疑' };
  }
  // 8. vocab — fallback. 大部分错题最终落 vocab.
  return { cause: ERROR_CAUSES.VOCAB, severity: SEVERITY.LOW, hint: '未识形态 fallback → vocab' };
}

/**
 * Diagnose an error. Returns cause + severity + repair_strategy.
 * Sync now (heuristic). v2.2 will be async (T4_JUDGE).
 *
 * @param {object} input
 * @param {string} input.question
 * @param {string} input.userAnswer
 * @param {string} input.correctAnswer
 * @param {string} [input.context]
 * @returns {{ cause: string, severity: string, repair_strategy: string, hint?: string, mock: boolean }}
 */
function diagnoseError(input) {
  if (!input || typeof input !== 'object') {
    return {
      cause: ERROR_CAUSES.VOCAB,
      severity: SEVERITY.LOW,
      repair_strategy: REPAIR_STRATEGY[ERROR_CAUSES.VOCAB],
      hint: 'invalid input',
      mock: true,
    };
  }
  const got = _heuristicClassify(input);
  return {
    cause: got.cause,
    severity: got.severity,
    repair_strategy: REPAIR_STRATEGY[got.cause] || '',
    hint: got.hint,
    mock: true,   // 标记 — UI 显示 "mock T4_JUDGE, real classifier 接 v2.2"
  };
}

// =====================================================================
// PERSISTENCE — error-log.jsonl
// =====================================================================

/**
 * Append an error row. Schema per 蓝图 §13.3:
 *   { error_id, question_ref, user_answer, correct_answer, error_class,
 *     remediation_path, ts }
 *
 * @param {string} slug
 * @param {object} error
 * @returns {{ ok: boolean, error_id: string }}
 */
function appendError(slug, error) {
  _validateSlug(slug);
  if (!error || typeof error !== 'object') throw new Error('error required');
  const errorId = error.error_id || `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const row = {
    error_id: errorId,
    question_ref: error.question_ref || '',
    user_answer: error.user_answer || '',
    correct_answer: error.correct_answer || '',
    error_class: error.error_class || error.cause || ERROR_CAUSES.VOCAB,
    severity: error.severity || SEVERITY.MEDIUM,
    remediation_path: error.remediation_path || '',
    ts: error.ts || new Date().toISOString(),
  };
  const v = _getVault();
  if (v && typeof v.appendJSONL === 'function') {
    v.appendJSONL(_errLogRel(slug), row);
  }
  return { ok: true, error_id: errorId };
}

/**
 * Read full error log (reverse-chrono). Returns at most `limit` rows.
 */
function getErrorLog(slug, limit) {
  _validateSlug(slug);
  const v = _getVault();
  if (!v || typeof v.readJSONL !== 'function') return [];
  const rows = v.readJSONL(_errLogRel(slug));
  if (!Array.isArray(rows)) return [];
  const sorted = rows.slice().sort((a, b) => {
    const ta = a && a.ts ? Date.parse(a.ts) : 0;
    const tb = b && b.ts ? Date.parse(b.ts) : 0;
    return tb - ta;
  });
  const n = Number(limit);
  return Number.isFinite(n) && n > 0 ? sorted.slice(0, n) : sorted;
}

/**
 * Count errors by cause — used by exam-cadence.errorAccumulation gauge +
 * dashboard.
 */
function errorCountsByCause(slug) {
  const log = getErrorLog(slug);
  const out = {};
  for (const c of Object.values(ERROR_CAUSES)) out[c] = 0;
  for (const row of log) {
    const cls = row && row.error_class;
    if (cls && out.hasOwnProperty(cls)) out[cls] += 1;
  }
  out._total = log.length;
  return out;
}

module.exports = {
  // Constants
  ERROR_CAUSES,
  REPAIR_STRATEGY,
  SEVERITY,
  // API
  diagnoseError,
  appendError,
  getErrorLog,
  errorCountsByCause,
};
