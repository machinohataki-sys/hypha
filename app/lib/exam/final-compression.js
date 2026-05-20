// app/lib/exam/final-compression.js
// α18 · HYPHA Exam System — Final Compression Mode v0
//
// 蓝图 §30 Exam System "Final Compression" 子模块。
// 考前 ≤ 7 天进入压缩模式:砍掉低频考点,仅保留 Must + High-Yield top-50%。
//
// 与既有 app/lib/exam-system/final-compression.js 并存,不替换。本模块用 {ok, ...}
// envelope + slug-scoped persist + 纯函数 compress,服务 α18 简洁触发栏 UI。
// 旧模块继续给 W7.2 dashboard 提供 5-task daily plan。

'use strict';

const path = require('node:path');

// ────────────────────────────────────────────────────────────────────────────
// 错误码 enum — 调用方按 code 分支,不靠 message 字符串比对
// ────────────────────────────────────────────────────────────────────────────
const ERR = Object.freeze({
  MISSING_SLUG:   'MISSING_SLUG',
  INVALID_SLUG:   'INVALID_SLUG',
  ALREADY_FINAL:  'ALREADY_FINAL',
  MISSING_SCOPE:  'MISSING_SCOPE',
  INVALID_SHAPE:  'INVALID_SHAPE',
  IO_FAILURE:     'IO_FAILURE',
});

// ────────────────────────────────────────────────────────────────────────────
// vault 懒加载 — 与既有 exam-system 模块一致
// ────────────────────────────────────────────────────────────────────────────
let _vault = null;
function _getVault() {
  if (_vault) return _vault;
  try { _vault = require('../vault'); } catch (_) { _vault = null; }
  return _vault;
}

function _validateSlug(slug) {
  if (typeof slug !== 'string' || !slug.trim()) {
    return { ok: false, error: ERR.MISSING_SLUG };
  }
  if (slug.includes('..') || path.isAbsolute(slug)) {
    return { ok: false, error: ERR.INVALID_SLUG };
  }
  return { ok: true };
}

// 状态文件相对路径 — α18 用独立文件名,不冲突 W7.2 final-state.json
function _stateRel(slug) {
  return `${slug}/.final-compression.json`;
}

// ────────────────────────────────────────────────────────────────────────────
// API
// ────────────────────────────────────────────────────────────────────────────

/**
 * 进入 Final Compression 模式。写状态文件,若已 active 拒绝。
 *
 * @param {{ slug:string, daysRemaining?:number, examType?:string }} p
 * @returns {Promise<{ok:boolean, state?:object, error?:string}>}
 */
async function enterFinalMode({ slug, daysRemaining = 7, examType = '' } = {}) {
  const sv = _validateSlug(slug);
  if (!sv.ok) return sv;
  const v = _getVault();
  if (!v) return { ok: false, error: ERR.IO_FAILURE };
  // 检查是否已 active
  const current = v.readJSON(_stateRel(slug), null);
  if (current && current.active === true) {
    return { ok: false, error: ERR.ALREADY_FINAL };
  }
  const state = {
    active:        true,
    enteredAt:     new Date().toISOString(),
    daysRemaining: Number.isFinite(Number(daysRemaining)) ? Number(daysRemaining) : 7,
    examType:      typeof examType === 'string' ? examType : '',
  };
  try {
    v.writeJSON(_stateRel(slug), state);
  } catch (_e) {
    return { ok: false, error: ERR.IO_FAILURE };
  }

  // 2026-05-16 consolidation — bridge α18 toggle to W7.2 final-state.json so
  // the existing finalTasks(slug) reader (5 buckets: review_high_freq,
  // review_errors, compress_essay_templates, time_limited_practice,
  // light_mock) returns non-empty for the dashboard. Without this bridge, the
  // dashboard toggle activates but the task list stays blank. Best-effort:
  // if W7.2 isn't available we still return ok — α18 state is authoritative.
  try {
    const w72 = require('../exam-system/final-compression');
    if (w72 && typeof w72.enterFinalCompression === 'function') {
      w72.enterFinalCompression(slug);
    }
  } catch (_) { /* W7.2 bridge optional */ }

  return { ok: true, state };
}

/**
 * 退出 Final Compression 模式。保历史 metadata,只把 active 置 false。
 *
 * @param {{ slug:string }} p
 * @returns {Promise<{ok:boolean, state?:object, error?:string}>}
 */
async function exitFinalMode({ slug } = {}) {
  const sv = _validateSlug(slug);
  if (!sv.ok) return sv;
  const v = _getVault();
  if (!v) return { ok: false, error: ERR.IO_FAILURE };
  const current = v.readJSON(_stateRel(slug), null) || {};
  const state = {
    ...current,
    active:    false,
    exitedAt:  new Date().toISOString(),
  };
  try {
    v.writeJSON(_stateRel(slug), state);
  } catch (_e) {
    return { ok: false, error: ERR.IO_FAILURE };
  }
  return { ok: true, state };
}

/**
 * 读 Final Compression 当前状态。文件不存在 → active:false。
 *
 * @param {{ slug:string }} p
 * @returns {Promise<{ok:boolean, state:object, error?:string}>}
 */
async function getFinalState({ slug } = {}) {
  const sv = _validateSlug(slug);
  if (!sv.ok) return sv;
  const v = _getVault();
  if (!v) return { ok: true, state: { active: false } };
  const got = v.readJSON(_stateRel(slug), null);
  if (!got || typeof got !== 'object') {
    return { ok: true, state: { active: false } };
  }
  return { ok: true, state: got };
}

/**
 * 压缩 scope — 纯函数,不 IO 不 LLM。
 *
 * 输入:scope-engine 输出 shape `{must, high_yield, recognition, out_of_scope}`。
 * 输出:
 *   - must:           全保留
 *   - high_yield_top: 取 high_yield 前 50%(若长度 < 4,全保)
 *   - dropped:        recognition + out_of_scope 全部 + high_yield 后 50%
 *
 * @param {{ slug:string, fullScope:object }} p
 * @returns {Promise<{ok:boolean, compressed?:object, error?:string}>}
 */
async function compressScope({ slug, fullScope } = {}) {
  const sv = _validateSlug(slug);
  if (!sv.ok) return sv;
  if (!fullScope) return { ok: false, error: ERR.MISSING_SCOPE };
  if (typeof fullScope !== 'object' || Array.isArray(fullScope)) {
    return { ok: false, error: ERR.INVALID_SHAPE };
  }
  // shape 校验 — 必须 4 个数组键之一存在(全空也接受,但形必须对)
  const expectedKeys = ['must', 'high_yield', 'recognition', 'out_of_scope'];
  const hasAtLeastOne = expectedKeys.some((k) => Array.isArray(fullScope[k]));
  if (!hasAtLeastOne) return { ok: false, error: ERR.INVALID_SHAPE };

  const must         = Array.isArray(fullScope.must)         ? fullScope.must.slice()         : [];
  const highYield    = Array.isArray(fullScope.high_yield)   ? fullScope.high_yield.slice()   : [];
  const recognition  = Array.isArray(fullScope.recognition)  ? fullScope.recognition.slice() : [];
  const outOfScope   = Array.isArray(fullScope.out_of_scope) ? fullScope.out_of_scope.slice(): [];

  // high_yield 切半 — 长度 < 4 全保;≥ 4 取前 ceil(len/2)
  let highYieldTop, highYieldDropped;
  if (highYield.length < 4) {
    highYieldTop     = highYield.slice();
    highYieldDropped = [];
  } else {
    const cut = Math.ceil(highYield.length / 2);
    highYieldTop     = highYield.slice(0, cut);
    highYieldDropped = highYield.slice(cut);
  }

  const compressed = {
    must,
    high_yield_top: highYieldTop,
    dropped: [
      ...recognition,
      ...outOfScope,
      ...highYieldDropped,
    ],
  };
  return { ok: true, compressed };
}

module.exports = {
  ERR,
  enterFinalMode,
  exitFinalMode,
  getFinalState,
  compressScope,
};
