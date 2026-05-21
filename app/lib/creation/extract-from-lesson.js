'use strict';

// HYPHA · Creation System / Decision + Assumption auto-extractor
//
// Fires at the end of /finish ritual. Reads the just-finished lesson's
// session transcript, asks T4_JUDGE to surface (a) explicit decisions the
// learner made about the artifact they are creating, (b) testable
// assumptions they voiced. Both rows land in the per-curriculum decision
// log + assumption ledger.
//
// Surgical contract:
//   - Non-fatal: any error returns a shape with skipped:'<reason>'.
//   - LLM-side via app/lib/llm executeChat('T4_JUDGE', { json:true }).
//   - Filters out short / vacuous extractions. Quality > quantity.
//   - Writes through decision-log + assumption-ledger (provided by Machino-α).
//
// Schema produced by the LLM:
//   {
//     "decisions":  [{ decision, context, rationale, rejected?, validation? }],
//     "assumptions": [{ claim, evidence? }]
//   }
//
// Persisted rows tag `source: 'auto-extract'` so the UI can show provenance.

const path = require('path');

// Minimum transcript length to bother extracting. Short sessions (= passive
// scan) rarely contain a real decision — running the LLM there is mostly
// noise. 800 chars ≈ a single back-and-forth exchange after greetings.
const MIN_TRANSCRIPT_CHARS = 800;

// Hard caps per session — quality over quantity.
const MAX_DECISIONS = 3;
const MAX_ASSUMPTIONS = 3;
const MAX_SPARKS = 3;

// Min length for a single decision/claim string. Shorter than this and the
// extractor is almost certainly hallucinating padding (e.g. "学到了").
const MIN_STRING_CHARS = 10;

// Tail window of transcript fed to LLM. Lesson transcripts can balloon past
// 30k chars after multi-turn /tutor; the tail preserves the recency where
// decisions usually crystallize (synthesis happens near the end of session).
const TRANSCRIPT_TAIL_CHARS = 8000;

const SYSTEM_PROMPT = [
  '你在为创作者整理学习成果。给你一节课的对话记录，你要找出两类东西：',
  '1. 决策 — 学习过程中，学习者对自己正在创造的东西（产品/作品/论文）做出的判断。包括：决定做某事，决定不做某事，选择 A 而非 B。',
  '2. 假设 — 学习者提出但尚未验证的预测或主张。例如"用户会愿意为 X 付费"，"Y 方法比 Z 高效"。',
  '',
  '不要编造。如果一节课只是被动接受信息，没有真正的决策或假设，返回空数组。',
  '',
  '输出 JSON，不加任何解释：',
  '{',
  '  "decisions": [',
  '    {',
  '      "decision": "具体决定 (≥10 字)",',
  '      "context": "在学到什么时做的决定",',
  '      "rationale": "为什么这样选",',
  '      "rejected": "考虑过但否决的另一个选项 (可空)",',
  '      "validation": "后续怎么验证 (可空)",',
  '      "prediction": {',
  '        "claim": "对未来的具体预测，1-2 句 (≥10 字)",',
  '        "falsifier": "如果什么观察发生，就说明这个决策错了，1 句 (≥10 字)",',
  '        "deadline_iso": "复查或证伪截止的 ISO 日期 YYYY-MM-DD"',
  '      }',
  '    }',
  '  ],',
  '  "assumptions": [',
  '    {',
  '      "claim": "未验证的主张 (≥10 字)",',
  '      "evidence": "目前的支持/反对证据 (可空)",',
  '      "prediction": {',
  '        "claim": "对未来的具体预测，1-2 句 (≥10 字)",',
  '        "falsifier": "如果什么观察发生，就说明这个假设错了，1 句 (≥10 字)",',
  '        "deadline_iso": "复查或证伪截止的 ISO 日期 YYYY-MM-DD"',
  '      }',
  '    }',
  '  ]',
  '}',
  '',
  '规则：',
  '- 决策必须能追溯到学习者的话，不是你自己的判断',
  '- 假设必须可证伪，不能是"努力学习是好的"这种空话',
  '- decisions ≤ 3，assumptions ≤ 3，质量优先于数量',
  '- 如果不确定就跳过，宁缺勿滥',
  '',
  '对每条决策和假设，额外尝试抽取一个 prediction 字段（可选）：',
  '- 决策的 prediction 描述这个决策正确性如何被验证',
  '- 假设的 prediction 描述这个假设证伪的条件',
  '- deadline_iso 从今天起 7-180 天内，格式 YYYY-MM-DD',
  '',
  'prediction 必须可证伪 — 不能写"会有用"这种空话。',
  '如果学习者没说出可证伪的预测，就省略 prediction 字段（不要编）。',
].join('\n');

// Coerce LLM payload into a guarded shape. Defensive against:
//   - top-level wrapped in code fences (rare; executeChat json:true strips)
//   - missing arrays
//   - non-string fields
//   - oversized arrays
//   - undersized strings (filter, don't throw)
function _normalize(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { obj = JSON.parse(stripped); }
    catch (_) { return { decisions: [], assumptions: [] }; }
  }
  if (!obj || typeof obj !== 'object') return { decisions: [], assumptions: [] };
  const decisions = Array.isArray(obj.decisions) ? obj.decisions : [];
  const assumptions = Array.isArray(obj.assumptions) ? obj.assumptions : [];
  return { decisions, assumptions };
}

function _trimField(v, max = 600) {
  if (typeof v !== 'string') return '';
  const t = v.trim();
  if (!t) return '';
  return t.length > max ? t.slice(0, max) : t;
}

// Coerce + sanity-check an LLM-emitted prediction. Strips silently when any
// subfield is missing or under MIN_STRING_CHARS, or when deadline_iso fails
// Date.parse. Mirrors the ledger-side validators but is permissive about
// trailing whitespace / surrounding quotes the LLM sometimes emits.
function _parsePrediction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const claim = _trimField(raw.claim, 400);
  const falsifier = _trimField(raw.falsifier, 400);
  const deadline = _trimField(raw.deadline_iso, 40);
  if (claim.length < MIN_STRING_CHARS) return null;
  if (falsifier.length < MIN_STRING_CHARS) return null;
  if (deadline.length < MIN_STRING_CHARS) return null;
  const parsed = Date.parse(deadline);
  if (!Number.isFinite(parsed)) return null;
  return { claim, falsifier, deadline_iso: deadline };
}

function _filterDecisions(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const decision = _trimField(r.decision, 400);
    if (decision.length < MIN_STRING_CHARS) continue;
    const row = {
      decision,
      context:    _trimField(r.context, 400),
      rationale:  _trimField(r.rationale, 400),
      rejected:   _trimField(r.rejected, 200),
      validation: _trimField(r.validation, 200),
    };
    const prediction = _parsePrediction(r.prediction);
    if (prediction) row.prediction = prediction;
    out.push(row);
    if (out.length >= MAX_DECISIONS) break;
  }
  return out;
}

function _filterAssumptions(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const claim = _trimField(r.claim, 400);
    if (claim.length < MIN_STRING_CHARS) continue;
    const row = {
      claim,
      evidence: _trimField(r.evidence, 400),
      state: 'unvalidated',
    };
    const prediction = _parsePrediction(r.prediction);
    if (prediction) row.prediction = prediction;
    out.push(row);
    if (out.length >= MAX_ASSUMPTIONS) break;
  }
  return out;
}

// transcript can be either:
//   - a string (already formatted)
//   - an array of {role, content} turns (preferred — matches main.js shape)
// We coerce to a string with role tags so the LLM sees turn boundaries.
function _stringifyTranscript(transcript) {
  if (typeof transcript === 'string') return transcript;
  if (!Array.isArray(transcript)) return '';
  const parts = [];
  for (const t of transcript) {
    if (!t || typeof t !== 'object') continue;
    const role = t.role === 'tutor' ? '导师' : (t.role === 'user' ? '学习者' : t.role || '?');
    const content = (typeof t.content === 'string') ? t.content : (typeof t.text === 'string' ? t.text : '');
    if (!content.trim()) continue;
    parts.push(`[${role}] ${content.trim()}`);
  }
  return parts.join('\n\n');
}

/**
 * Extract decisions + assumptions from a lesson transcript and persist them.
 *
 * @param {object} args
 * @param {string} args.slug          — curriculum slug (vault subdir name)
 * @param {number} args.lessonIdx     — 0-based lesson index
 * @param {string|Array} args.transcript — full or tail transcript
 * @param {string} args.lessonTitle   — for prompt anchoring
 * @param {string} args.learnGoal     — for prompt anchoring
 * @param {object} args.settings      — passed through if router needs it (unused for executeChat today)
 * @returns {Promise<{decisions:Array, assumptions:Array, skipped?:string}>}
 */
async function extractDecisionsAndAssumptions({
  slug,
  lessonIdx,
  transcript,
  lessonTitle = '',
  learnGoal = '',
  settings: _settings = {},
} = {}) {
  if (!slug) return { decisions: [], assumptions: [], skipped: 'no-slug' };
  const transcriptStr = _stringifyTranscript(transcript);
  if (transcriptStr.length < MIN_TRANSCRIPT_CHARS) {
    return { decisions: [], assumptions: [], skipped: 'too-short' };
  }

  // Tail-window the transcript. Decisions tend to land near synthesis points
  // late in the session; the head is usually scene-setting + recap.
  const tail = transcriptStr.length > TRANSCRIPT_TAIL_CHARS
    ? transcriptStr.slice(-TRANSCRIPT_TAIL_CHARS)
    : transcriptStr;

  const todayIso = new Date().toISOString().slice(0, 10);
  const userPrompt = [
    `今天的日期: ${todayIso}`,
    `课程标题: ${lessonTitle || '(未提供)'}`,
    `学习目标: ${learnGoal || '(未提供)'}`,
    '',
    `对话记录(裁剪到最近 ${TRANSCRIPT_TAIL_CHARS} 字):`,
    tail,
    '',
    '按上述 schema 输出 JSON。prediction.deadline_iso 从今天起 7-180 天内。',
  ].join('\n');

  let parsed;
  try {
    // Lazy-require so module-load doesn't pull the LLM router on cold paths
    // (test harnesses, lint checks).
    const { executeChat } = require('../llm');
    const dispatched = await executeChat('T4_JUDGE', {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt },
      ],
      json: true,
      maxTokens: 1500,
      temperature: 0.3,
    });
    // executeChat → { result, providerId, model, capability, attempts }
    const result = dispatched && dispatched.result != null ? dispatched.result : dispatched;
    parsed = _normalize(result);
  } catch (err) {
    return {
      decisions: [],
      assumptions: [],
      skipped: 'llm-error',
      error: err && err.message ? err.message : String(err),
    };
  }

  const goodDecisions = _filterDecisions(parsed.decisions);
  const goodAssumptions = _filterAssumptions(parsed.assumptions);

  if (goodDecisions.length === 0 && goodAssumptions.length === 0) {
    return { decisions: [], assumptions: [], skipped: 'no-extracts' };
  }

  // Persist. Both writers are owned by Machino-α; we contract for the
  // `appendDecision(slug, row)` + `appendAssumption(slug, row)` exports.
  let decisionLog = null;
  let assumptionLedger = null;
  try { decisionLog = require('./decision-log'); } catch (_) { /* not yet shipped */ }
  try { assumptionLedger = require('./assumption-ledger'); } catch (_) { /* not yet shipped */ }

  const writtenDecisions = [];
  const writtenAssumptions = [];

  for (const row of goodDecisions) {
    if (!decisionLog || typeof decisionLog.appendDecision !== 'function') break;
    try {
      const persisted = await decisionLog.appendDecision(slug, {
        ...row,
        source: 'auto-extract',
        lesson_idx: lessonIdx,
        lesson_title: lessonTitle || null,
      });
      writtenDecisions.push(persisted || row);
    } catch (err) {
      // Per-row failure is non-fatal; keep going.
      writtenDecisions.push({ ...row, write_error: err && err.message });
    }
  }

  for (const row of goodAssumptions) {
    if (!assumptionLedger || typeof assumptionLedger.appendAssumption !== 'function') break;
    try {
      const persisted = await assumptionLedger.appendAssumption(slug, {
        ...row,
        source: 'auto-extract',
        lesson_idx: lessonIdx,
        lesson_title: lessonTitle || null,
      });
      writtenAssumptions.push(persisted || row);
    } catch (err) {
      writtenAssumptions.push({ ...row, write_error: err && err.message });
    }
  }

  return {
    decisions: writtenDecisions,
    assumptions: writtenAssumptions,
  };
}

// ---------------------------------------------------------------------------
// Spark extraction (third extraction class, alongside decisions + assumptions)
//
// A Spark = a transferable insight from this lesson that directly maps onto
// the product/work/paper the learner is currently building. Distinct from a
// decision (already-made choice) and an assumption (testable claim).
//
// Persisted via product-spark.js (Machino-α2). If that module is not yet on
// disk, the extractor still runs to completion and returns the parsed sparks;
// only the write step is skipped.
// ---------------------------------------------------------------------------

const SPARK_SYSTEM_PROMPT = [
  '你在为创作者整理学习成果。给你一节课的对话记录，你要找出能迁移到学习者正在创造的东西(产品/作品/论文)的灵感。',
  '',
  '灵感节点(Spark) ≠ 决策 / 假设。灵感是: 这节课学到的某个原理/方法/经验，直接给学习者"正在做的东西"提供了一个具体启发，且这个启发可以用一句话说清"做什么改变"。',
  '',
  '例: 学奥卡姆剃刀 → 灵感"我的产品里复杂模块裁剪原则: 每个模块必须证明它能推进至少一个核心目标"。这是一个 spark。',
  '',
  '不要编造。如果一节课没有迁移到具体产品的启发，返回空数组。',
  '',
  '输出 JSON，不加任何解释:',
  '{',
  '  "sparks": [',
  '    {',
  '      "core_transfer": "核心迁移 1 句 (≥10 字)，具体到能 \'where in the product do I apply this\'",',
  '      "affected_modules": ["可能影响的模块名，如\'课程结构\'/\'用户引导\'/\'数据层\'"],',
  '      "possible_actions": ["建议动作，如\'砍掉 X 复杂度\' / \'新增 Y 功能\' / \'改 Z UX\'"],',
  '      "risks": "可能哪里错 (可空)",',
  '      "prediction": {',
  '        "claim": "这个灵感落实后预期的效果，1-2 句 (≥10 字)",',
  '        "falsifier": "如果什么观察发生，就说明这个灵感不值得 Implemented，1 句 (≥10 字)",',
  '        "deadline_iso": "复查或验证截止的 ISO 日期 YYYY-MM-DD"',
  '      }',
  '    }',
  '  ]',
  '}',
  '',
  '规则:',
  '- sparks ≤ 3，质量优先',
  '- 每个 spark 必须能追溯到学习者本节学到的内容，不是泛泛而谈',
  '- 不输出"努力学习是好的"这种空话',
  '- 如果不确定就跳过，宁缺勿滥',
  '',
  '对每条灵感，额外尝试抽取一个 prediction 字段（可选）：',
  '- prediction 描述这个灵感落实后预期的效果 + 多久能验证',
  '- deadline_iso 从今天起 7-180 天内，格式 YYYY-MM-DD',
  '',
  'prediction 必须可证伪 — 不能写"会有用"这种空话。',
  '如果学习者没说出可证伪的预测，就省略 prediction 字段（不要编）。',
].join('\n');

function _buildSparkPrompt({ lessonTitle = '', learnGoal = '', transcript = '', activeProductName = '' } = {}) {
  const transcriptStr = typeof transcript === 'string' ? transcript : _stringifyTranscript(transcript);
  const tail = transcriptStr.length > TRANSCRIPT_TAIL_CHARS
    ? transcriptStr.slice(-TRANSCRIPT_TAIL_CHARS)
    : transcriptStr;
  const todayIso = new Date().toISOString().slice(0, 10);
  const userPrompt = [
    `今天的日期: ${todayIso}`,
    `课程标题: ${lessonTitle || '(未提供)'}`,
    `学习目标: ${learnGoal || '(未提供)'}`,
    `当前在创造的产品/作品: ${activeProductName || '(尚未声明)'}`,
    '',
    `对话记录(裁剪到最近 ${TRANSCRIPT_TAIL_CHARS} 字):`,
    tail,
    '',
    '按上述 schema 输出 JSON。prediction.deadline_iso 从今天起 7-180 天内。',
  ].join('\n');
  return {
    messages: [
      { role: 'system', content: SPARK_SYSTEM_PROMPT },
      { role: 'user',   content: userPrompt },
    ],
  };
}

function _normalizeSparks(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    try { obj = JSON.parse(stripped); }
    catch (_) { return { sparks: [] }; }
  }
  if (!obj || typeof obj !== 'object') return { sparks: [] };
  const sparks = Array.isArray(obj.sparks) ? obj.sparks : [];
  return { sparks };
}

function _coerceStringArray(v, maxLen = 10, perItemMax = 120) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t) continue;
    out.push(t.length > perItemMax ? t.slice(0, perItemMax) : t);
    if (out.length >= maxLen) break;
  }
  return out;
}

function _filterSparks(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const coreTransfer = _trimField(r.core_transfer, 400);
    if (coreTransfer.length < MIN_STRING_CHARS) continue;
    const row = {
      core_transfer: coreTransfer,
      affected_modules: _coerceStringArray(r.affected_modules, 8, 80),
      possible_actions: _coerceStringArray(r.possible_actions, 8, 160),
      risks: _trimField(r.risks, 300),
    };
    const prediction = _parsePrediction(r.prediction);
    if (prediction) row.prediction = prediction;
    out.push(row);
    if (out.length >= MAX_SPARKS) break;
  }
  return out;
}

/**
 * Extract Product Sparks (transferable insights) from a lesson transcript and
 * persist them via product-spark.js. Non-fatal at every step.
 *
 * @param {object} args
 * @param {string} args.slug              — curriculum slug (vault subdir)
 * @param {number} args.lessonIdx         — 0-based lesson index
 * @param {string|Array} args.transcript  — full or tail transcript
 * @param {string} args.lessonTitle       — prompt anchor
 * @param {string} args.learnGoal         — prompt anchor
 * @param {object} args.settings          — pass-through (unused for executeChat today)
 * @param {string} args.activeProductName — current product the user is building; falls back to slug
 * @returns {Promise<{sparks:Array, skipped?:string, error?:string}>}
 */
async function extractSparks({
  slug,
  lessonIdx,
  transcript,
  lessonTitle = '',
  learnGoal = '',
  settings: _settings = {},
  activeProductName = '',
} = {}) {
  if (!slug) return { sparks: [], skipped: 'no-slug' };
  const transcriptStr = _stringifyTranscript(transcript);
  if (transcriptStr.length < MIN_TRANSCRIPT_CHARS) {
    return { sparks: [], skipped: 'too-short' };
  }

  const { messages } = _buildSparkPrompt({
    lessonTitle, learnGoal, transcript: transcriptStr, activeProductName,
  });

  let parsed;
  try {
    const { executeChat } = require('../llm');
    const dispatched = await executeChat('T4_JUDGE', {
      messages,
      json: true,
      maxTokens: 1500,
      temperature: 0.3,
    });
    const result = dispatched && dispatched.result != null ? dispatched.result : dispatched;
    parsed = _normalizeSparks(result);
  } catch (err) {
    return {
      sparks: [],
      skipped: 'llm-error',
      error: err && err.message ? err.message : String(err),
    };
  }

  const goodSparks = _filterSparks(parsed.sparks);
  if (goodSparks.length === 0) {
    return { sparks: [], skipped: 'no-extracts' };
  }

  // Persist via product-spark (Machino-α2). Module may not yet be shipped — the
  // extractor still returns the parsed sparks so callers can render / queue.
  let productSpark = null;
  try { productSpark = require('./product-spark'); } catch (_) { /* not yet shipped */ }

  const target = activeProductName || slug;
  const written = [];

  for (const row of goodSparks) {
    const payload = {
      source_type: 'lesson',
      source_ref: String(lessonIdx),
      target_product: target,
      core_transfer: row.core_transfer,
      affected_modules: row.affected_modules || [],
      possible_actions: row.possible_actions || [],
      risks: row.risks || '',
      state: 'Seed',
      lesson_idx: lessonIdx,
      source: 'auto-extract',
    };
    if (row.prediction) payload.prediction = row.prediction;
    if (!productSpark || typeof productSpark.appendSpark !== 'function') {
      // No writer yet — return the row anyway so the caller can show / log it.
      written.push(payload);
      continue;
    }
    try {
      const persisted = await productSpark.appendSpark(slug, payload);
      written.push(persisted || payload);
    } catch (err) {
      written.push({ ...payload, write_error: err && err.message });
    }
  }

  return { sparks: written };
}

module.exports = {
  extractDecisionsAndAssumptions,
  extractSparks,
  // Surface constants for callers / tests that need to mirror the contract.
  MIN_TRANSCRIPT_CHARS,
  MAX_DECISIONS,
  MAX_ASSUMPTIONS,
  MAX_SPARKS,
  TRANSCRIPT_TAIL_CHARS,
};
