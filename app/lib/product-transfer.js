'use strict';
const { tagMockOutput } = require('./v0-mock-marker');
// HYPHA · W3.3 Product Transfer Trigger — blueprint §11.3 + ROADMAP v0.7
//
// Each Lesson / Deepen / Note completes, this module decides whether
// the just-learned knowledge-point is relevant enough to the user's
// Product Pool to warrant the optional 10th-segment "迁移到你的产品"
// callout in the lesson body. The callout is NOT generated unless
// relevance score P ≥ THRESHOLD (default 0.6) — blueprint mandate:
// "不强迁移; 只在相关性足够高时触发".
//
// Surface contract for upstream:
//   triggerTransfer(slug, lessonIdx, kpId) → { fired:bool, P, content?, _meta }
//   computeRelevance({ lessonKP, productBlueprint, lessonContext }) → { P, evidence[], suggested_section }
//   shouldTriggerTransfer(P, opts?) → bool
//   generateTransferPrompt({ lessonKP, productBlueprint, P, suggested_section }) → markdown string
//
// Boundaries:
//   - W3.1 (creation-pool.js) — getProduct(slug) supplies productBlueprint shape:
//       { product_name, sections: { northStar, modules, openQuestions, riskMap, ... } }
//     This module never writes to the pool; it only reads.
//   - W3.2 (blueprint-parser.js) — parseBlueprint() yields the same sections[]
//     shape. We consume it via creation-pool.getProduct's normalized output;
//     no direct dep on the parser.
//   - W3.4 (spark layer, future) — the UI "确认迁移到 spark" button calls
//     window.ptor.transfer.toSpark(...) which we do NOT implement here.
//     We expose `suggested_section` so the spark module knows which blueprint
//     section receives the transfer evidence.
//   - W1.3 Anti-Illusion `no_creation_reflow` — when the gate fires + the
//     learner gets a product_transfer_drill intervention, the drill prompt
//     can call generateTransferPrompt() to seed the micro-task copy.
//
// Cost model:
//   - Cheap stage: O(n) keyword overlap over normalized token sets. Zero LLM.
//     Always runs. Returns P_cheap ∈ [0, 1].
//   - LLM stage: T4_JUDGE one call to refine P + evidence + suggested_section.
//     Currently MOCK (returns deterministic placeholder); real wiring lands
//     when T4_JUDGE prompt template is locked alongside W1.3.1 calibration.
//     Refinement is monotone-bounded: |P_llm - P_cheap| ≤ 0.30.
//   - Prompt generation: T4_JUDGE second call (200-400 字 markdown). Also MOCK
//     today — returns a structurally complete placeholder so the UI surface +
//     downstream consumers (W1.3 drill, W3.4 spark) can wire against the real
//     shape without waiting on the LLM.
//
// intentional-placeholder: T4_JUDGE LLM wiring is deferred to the W1.3.1
//   calibration wave (per task brief: "T4_JUDGE LLM 调用全 mock"). The mock
//   returns a stable, structurally-complete payload so every downstream
//   surface (the new lesson-body field, UI callout, events.jsonl row,
//   W3.4 spark routing) can wire against the real shape today. When the
//   prompt template + golden set lock in, swap _mockLLMRefine + the mock
//   body inside generateTransferPrompt with executeChat('T4_JUDGE', ...)
//   calls. The module's exported surface stays unchanged.

const THRESHOLD_DEFAULT = 0.6;
const LLM_REFINEMENT_BOUND = 0.30;

// Blueprint section names the transfer can suggest the user route the
// insight INTO. Stable enum (frontend renders pill-tag with these labels).
const SECTION_ENUM = [
  'northStar',
  'modules',
  'openQuestions',
  'riskMap',
  'assumptionLedger',
  'killCriteria',
  // fallback when no section dominates the overlap
  'general',
];

// CJK + ASCII tokenizer — splits on whitespace + punctuation, keeps CJK as
// single-char tokens (cheap-stage proxy for "concept overlap" in mixed corpora).
// Filter <2 chars (ASCII) but keep single CJK (each CJK char carries semantic load).
const _TOKEN_SPLIT_RX = /[\s,.;:!?'"`()\[\]{}<>/\\|*+=#&%$@~^—–\-_…，。；：！？、《》「」『』（）【】]+/u;

function _tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  const raw = String(text).toLowerCase().trim();
  if (!raw) return [];
  const out = [];
  raw.split(_TOKEN_SPLIT_RX).forEach((tok) => {
    if (!tok) return;
    // ASCII word (≥2 chars) — keep whole
    if (/^[a-z0-9][a-z0-9_]*$/.test(tok)) {
      if (tok.length >= 2) out.push(tok);
      return;
    }
    // Mixed / CJK — emit each CJK char + ASCII run
    let buf = '';
    for (const ch of tok) {
      const isCJK = /[㐀-鿿぀-ヿ가-힯]/.test(ch);
      if (isCJK) {
        if (buf.length >= 2) out.push(buf);
        buf = '';
        out.push(ch);
      } else if (/[a-z0-9]/i.test(ch)) {
        buf += ch.toLowerCase();
      } else if (buf) {
        if (buf.length >= 2) out.push(buf);
        buf = '';
      }
    }
    if (buf.length >= 2) out.push(buf);
  });
  // Stopword scrub — very short list to avoid blowing up signal
  const STOP = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'are', 'was', 'has', 'how', 'why', 'what', '的', '是', '和', '在', '了', '与', '一个', '一种']);
  return out.filter(t => !STOP.has(t));
}

function _sectionTokens(productBlueprint) {
  const sections = (productBlueprint && productBlueprint.sections) || {};
  const out = {};
  SECTION_ENUM.forEach((name) => {
    const raw = sections[name];
    if (raw == null) { out[name] = []; return; }
    if (Array.isArray(raw)) {
      out[name] = _tokenize(raw.join(' '));
    } else if (typeof raw === 'object') {
      out[name] = _tokenize(JSON.stringify(raw));
    } else {
      out[name] = _tokenize(String(raw));
    }
  });
  return out;
}

function _kpTokens(lessonKP, lessonContext) {
  const parts = [
    lessonKP && lessonKP.title,
    lessonKP && lessonKP.canonical_example,
    lessonKP && lessonKP.thesis,
    lessonKP && lessonKP.definition,
    lessonContext && lessonContext.learnGoal,
    lessonContext && lessonContext.lessonTitle,
  ].filter(v => v != null && String(v).trim());
  return _tokenize(parts.join(' '));
}

// Jaccard with overlap floor — counts strict overlap / strict union.
// Returns 0 when either side empty (no signal = no fire).
function _jaccard(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let inter = 0;
  aSet.forEach(t => { if (bSet.has(t)) inter += 1; });
  const union = aSet.size + bSet.size - inter;
  if (union <= 0) return 0;
  return inter / union;
}

/**
 * Compute relevance between a knowledge point and the user's Product
 * Pool blueprint. Cheap-stage Jaccard + (mocked) LLM refinement.
 *
 * @param {{ lessonKP, productBlueprint, lessonContext? }} args
 * @returns {{ P: number, evidence: string[], suggested_section: string, _stages: object }}
 */
function computeRelevance({ lessonKP, productBlueprint, lessonContext }) {
  if (!lessonKP || typeof lessonKP !== 'object') {
    return { P: 0, evidence: [], suggested_section: 'general', _stages: { reason: 'no lessonKP' } };
  }
  if (!productBlueprint || typeof productBlueprint !== 'object') {
    // No product = no transfer possible. Caller should skip transfer entirely.
    return { P: 0, evidence: [], suggested_section: 'general', _stages: { reason: 'no productBlueprint' } };
  }

  const kpTokens = _kpTokens(lessonKP, lessonContext || {});
  const sectionToks = _sectionTokens(productBlueprint);

  // Per-section Jaccard, pick dominant section + aggregate.
  let best = { section: 'general', score: 0 };
  const perSection = {};
  for (const name of SECTION_ENUM) {
    const j = _jaccard(kpTokens, sectionToks[name] || []);
    perSection[name] = j;
    if (j > best.score) best = { section: name, score: j };
  }

  // Aggregate score = dominant section + half the second-best (rewards KP
  // that lights up multiple sections, not just one).
  const sorted = Object.entries(perSection).sort((a, b) => b[1] - a[1]);
  const top = sorted[0] ? sorted[0][1] : 0;
  const second = sorted[1] ? sorted[1][1] : 0;
  let P_cheap = Math.min(1, top + 0.5 * second);

  // Boost: explicit name match (productBlueprint.product_name) appears in
  // kp title / canonical_example → +0.15 (capped at 1).
  const productName = productBlueprint.product_name || productBlueprint.name || '';
  if (productName && lessonKP) {
    const kpHay = `${lessonKP.title || ''} ${lessonKP.canonical_example || ''} ${lessonKP.thesis || ''}`.toLowerCase();
    if (kpHay && kpHay.includes(String(productName).toLowerCase())) {
      P_cheap = Math.min(1, P_cheap + 0.15);
    }
  }

  // Evidence — short human-readable strings. UI surfaces these in the
  // "why this transfer fires" tooltip below the callout heading.
  const evidence = [];
  if (best.score > 0) {
    evidence.push(`section_overlap:${best.section}=${best.score.toFixed(3)}`);
  }
  if (productName) evidence.push(`product_name=${productName}`);
  evidence.push(`P_cheap=${P_cheap.toFixed(3)}`);

  // LLM refinement stage — MOCK today. Real wiring (T4_JUDGE) lands with
  // W1.3.1 calibration wave. The mock preserves P_cheap and returns a
  // best-section pick + a stable placeholder so all downstream surfaces
  // (events.jsonl row + UI render + W3.4 spark routing) can wire.
  // intentional-placeholder: per task brief "T4_JUDGE LLM 调用全 mock". Real
  //   wiring lands with W1.3.1 calibration wave when prompt template +
  //   golden set lock; surface contract here ({ P_refined, suggested_section,
  //   evidence_added }) is the stable handoff. Today's call:
  //   require('./llm').executeChat('T4_JUDGE', { messages, json:true, ... })
  //   with a JSON-mode prompt returning that exact shape.
  const llm = _mockLLMRefine({ P_cheap, evidence, suggested_section: best.section, kpTokens, sectionToks });
  const P = Math.max(0, Math.min(1, llm.P_refined));

  return {
    P,
    evidence: [...evidence, ...llm.evidence_added],
    suggested_section: llm.suggested_section,
    _stages: {
      cheap: { P_cheap, top, second, best_section: best.section },
      llm:   { P_refined: llm.P_refined, mocked: true },
    },
  };
}

// Deterministic mock — bounded |Δ| ≤ LLM_REFINEMENT_BOUND, no randomness.
// Returns the cheap score unchanged with a single "[MOCK]" evidence tag so
// callers know to treat the score as cheap-stage only until T4_JUDGE wires.
function _mockLLMRefine({ P_cheap, suggested_section }) {
  return {
    P_refined: P_cheap,
    suggested_section,
    evidence_added: ['llm_stage=mock'],
  };
}

/**
 * Gate decision — does this KP/lesson warrant emitting the product_transfer
 * segment? Returns false when P < threshold OR P is non-finite.
 *
 * @param {number} P
 * @param {{ threshold?: number }} [opts]
 * @returns {boolean}
 */
function shouldTriggerTransfer(P, opts = {}) {
  const t = (opts && Number.isFinite(opts.threshold)) ? opts.threshold : THRESHOLD_DEFAULT;
  if (typeof P !== 'number' || !Number.isFinite(P)) return false;
  return P >= t;
}

/**
 * Build the markdown "迁移到你的产品" segment. Today this returns a
 * structurally-complete MOCK so the lesson body schema + UI surface can be
 * wired against the real shape. When T4_JUDGE is online, swap the mock body
 * for the actual LLM result and keep the same structural contract.
 *
 * Mandatory structure (per blueprint §11.3 example):
 *   1. opening line: "<KP 名>对 <product_name> 的启发是: <1 insight>"
 *   2. 3-item numbered actionable impact list
 *   3. 1 closing risk line: "但可能误用为 ..."
 *
 * @param {{ lessonKP, productBlueprint, P, suggested_section }} args
 * @returns {{ content: string, structure: object, mocked: boolean }}
 */
function generateTransferPrompt({ lessonKP, productBlueprint, P, suggested_section }) {
  const kpName = (lessonKP && (lessonKP.title || lessonKP.name)) || '本节知识点';
  const productName = (productBlueprint && (productBlueprint.product_name || productBlueprint.name)) || '你的产品';
  const section = suggested_section || 'general';

  // intentional-placeholder: T4_JUDGE LLM call deferred to W1.3.1 calibration
  //   wave (per task brief "T4_JUDGE LLM 调用全 mock"). The mock body below
  //   honors the full structural contract (1 insight + 3 numbered impacts +
  //   1 risk line) so UI render + downstream "确认迁移到 spark" wiring are
  //   testable today. Prompt template draft (200-400 字), ready to swap:
  //   "你是 HYPHA Product Transfer Architect. 输入: 知识点 = {kpName + canonical_example + mechanism}.
  //    用户产品蓝图 sections = {northStar + modules + openQuestions + riskMap}.
  //    输出 markdown 段, 必须按下列结构:
  //       行1: '<kpName> 对 <productName> 的启发是: <1句 insight, ≤40字>'
  //       行2-4: 3 个 numbered impact, 格式 '<动词> X / <动词> Y / <动词> Z'
  //              (动词限于: 删 / 添加 / 改 / 砍 / 守 / 验)
  //       行5: '但可能误用为 ___'
  //    禁止: 训练数据术语 (AI / LLM / embedding / prompt / RAG); 禁止 emoji;
  //    禁止 zh AI 流量词 (这一刀/闭环/拉满/王炸/干货/直击灵魂); 中文 manuscript
  //    register (Garamond cadence)."
  const insight = `保留 KP 的核心约束, 拒绝在 ${section} 段擅自扩张范围`;
  const impactList = [
    `审视 ${section} 是否已被 ${kpName} 的约束覆盖, 否则补一条假设`,
    `把 ${kpName} 对应的反例写进 riskMap, 防止模块以"它没说过反对"为借口加进来`,
    `给 ${kpName} 配一条 kill criterion: 不满足时砍当前最近的下游模块`,
  ];
  const risk = `但可能误用为给 ${productName} 增加新模块的"理论背书" — 该 KP 的标准用法是减法, 非加法`;

  const content = [
    `## 迁移到你的产品 / 作品`,
    ``,
    `${kpName} 对 ${productName} 的启发是: ${insight}`,
    ``,
    `1. ${impactList[0]}`,
    `2. ${impactList[1]}`,
    `3. ${impactList[2]}`,
    ``,
    `${risk}`,
  ].join('\n');

  return tagMockOutput({
    content,
    structure: {
      opening: `${kpName} 对 ${productName} 的启发是: ${insight}`,
      impacts: impactList,
      risk,
      P,
      suggested_section: section,
    },
    mocked: true,
  }, 'product-transfer generateTransferPrompt T4_JUDGE 未上线, 使用 placeholder markdown');
}

// Lazy loaders so this module stays usable in unit tests that don't have
// the full Electron app surface mounted. All deps are best-effort —
// triggerTransfer never throws when an optional dep is absent; it simply
// returns { fired: false, P: 0, reason } so the caller can no-op.
let _vaultMod = null;
function _getVault() {
  if (_vaultMod) return _vaultMod;
  try { _vaultMod = require('./vault'); }
  catch (_) { _vaultMod = false; }
  return _vaultMod;
}

let _creationPoolMod = null;
function _getCreationPool() {
  if (_creationPoolMod !== null) return _creationPoolMod;
  // W3.1 ships in parallel — module may be absent today.
  try { _creationPoolMod = require('./creation-pool'); }
  catch (_) { _creationPoolMod = false; }
  return _creationPoolMod;
}

// Lazily load the lesson body off disk + extract a KP-shaped record from
// either body.knowledge_points[i] (v0.3+ KP arc schema) or fall back to the
// 11-field body itself (canonical_example + thesis as the de-facto KP).
function _loadLessonKP(slug, lessonIdx, kpId) {
  const vault = _getVault();
  if (!vault) return null;
  try {
    const persisted = vault.readJSON(`${slug}/lesson-${lessonIdx}.body.json`, null);
    const body = persisted && persisted.body;
    if (!body || typeof body !== 'object') return null;
    if (kpId && Array.isArray(body.knowledge_points)) {
      const found = body.knowledge_points.find(kp => kp && (kp.id === kpId || kp.kp_id === kpId));
      if (found) {
        return {
          id: found.id || kpId,
          title: found.title || body.thesis || '',
          canonical_example: found.canonical_example || body.canonical_example || '',
          thesis: found.thesis || body.thesis || '',
          mechanism_explanation: found.mechanism_explanation || body.mechanism_explanation || '',
        };
      }
    }
    return {
      id: kpId || `lesson-${lessonIdx}`,
      title: body.thesis || '',
      canonical_example: body.canonical_example || '',
      thesis: body.thesis || '',
      mechanism_explanation: body.mechanism_explanation || '',
    };
  } catch (_) { return null; }
}

function _loadProductBlueprint(slug) {
  const pool = _getCreationPool();
  if (!pool || typeof pool.getProduct !== 'function') return null;
  try { return pool.getProduct(slug); }
  catch (_) { return null; }
}

/**
 * Main entry — fire-and-forget transfer judgement. Reads the body off disk,
 * fetches the product blueprint (via W3.1 creation-pool), runs cheap +
 * mocked-LLM refinement, persists an events.jsonl row, and returns the
 * structured decision to the caller (main.js, agent.js, or test harness).
 *
 * Caller is responsible for writing the returned `body_patch` back into
 * the lesson body JSON file — keeping disk I/O in main.js (single owner
 * for vault writes per project convention).
 *
 * @param {string} slug
 * @param {number} lessonIdx
 * @param {string|null} kpId — null = use the lesson's primary KP
 * @param {object} [opts] — { threshold, lessonContext }
 * @returns {Promise<{ fired: boolean, P: number, content: string|null, suggested_section: string, evidence: string[], _meta: object }>}
 */
async function triggerTransfer(slug, lessonIdx, kpId, opts = {}) {
  const t0 = Date.now();
  const baseMeta = { slug, lessonIdx, kpId: kpId || null, threshold: (opts && opts.threshold) || THRESHOLD_DEFAULT };

  if (!slug || !Number.isFinite(lessonIdx)) {
    return { fired: false, P: 0, content: null, suggested_section: 'general', evidence: ['bad_input'], _meta: { ...baseMeta, reason: 'bad_input' } };
  }

  const lessonKP = _loadLessonKP(slug, lessonIdx, kpId);
  if (!lessonKP) {
    return { fired: false, P: 0, content: null, suggested_section: 'general', evidence: ['no_lesson_body'], _meta: { ...baseMeta, reason: 'no_lesson_body' } };
  }

  const productBlueprint = _loadProductBlueprint(slug);
  if (!productBlueprint) {
    // No product pool yet — silently skip. This is the steady state in v0.x
    // until W3.1 + W3.2 ship to fill the pool. No event row (would flood log).
    return { fired: false, P: 0, content: null, suggested_section: 'general', evidence: ['no_product_blueprint'], _meta: { ...baseMeta, reason: 'no_product_blueprint' } };
  }

  const lessonContext = (opts && opts.lessonContext) || {};
  const relevance = computeRelevance({ lessonKP, productBlueprint, lessonContext });
  const fired = shouldTriggerTransfer(relevance.P, opts);

  let content = null;
  let structure = null;
  if (fired) {
    const gen = generateTransferPrompt({
      lessonKP,
      productBlueprint,
      P: relevance.P,
      suggested_section: relevance.suggested_section,
    });
    content = gen.content;
    structure = gen.structure;
  }

  const elapsed = Date.now() - t0;
  const _meta = {
    ...baseMeta,
    P: relevance.P,
    suggested_section: relevance.suggested_section,
    evidence: relevance.evidence,
    stages: relevance._stages,
    elapsed_ms: elapsed,
    fired,
    mocked: true, // remove when T4_JUDGE wires
  };

  // events.jsonl row — observability for both fires + skips above the
  // "no_product_blueprint" floor. Keep payload narrow (no body content).
  try {
    const vault = _getVault();
    if (vault && typeof vault.appendJSONL === 'function') {
      vault.appendJSONL('events.jsonl', {
        ts: new Date().toISOString(),
        op: 'transfer:fired',
        topic: slug,
        idx: lessonIdx,
        kp_id: kpId || lessonKP.id,
        P: relevance.P,
        suggested_section: relevance.suggested_section,
        fired,
      });
    }
  } catch (_) { /* observability must never break the trigger */ }

  // v0 mock marker — the entire P / content path is still cheap-stage
  // jaccard + structurally-complete placeholder body (per intentional-
  // placeholder comments at lines 44 + 208 + 272). Tag the user-facing
  // envelope so UI banner can render "v0 模板输出" until T4_JUDGE ships.
  return tagMockOutput({
    fired,
    P: relevance.P,
    content,
    suggested_section: relevance.suggested_section,
    evidence: relevance.evidence,
    structure,
    _meta,
  }, 'product-transfer T4_JUDGE 未上线, 当前用 jaccard 兜底 + 结构化 placeholder body');
}

module.exports = {
  computeRelevance,
  shouldTriggerTransfer,
  generateTransferPrompt,
  triggerTransfer,
  // Exposed for tests + future T4_JUDGE wiring.
  _tokenize,
  _jaccard,
  SECTION_ENUM,
  THRESHOLD_DEFAULT,
  LLM_REFINEMENT_BOUND,
};
