// app/lib/exam-system/judge.js
// W7.2 Exam System — T4_JUDGE LLM micro-judge for open-ended answers.
// ──────────────────────────────────────────────────────────────────────
// 关联: spec/exam-system.md §T4_JUDGE — open-answer (essay/explain/derive)
// rubric grading. Closes v1.0 critical gap "Exam T4_JUDGE LLM micro-judge real
// wire" (System 7 75→85%). Until now exam grading was 100% heuristic
// (error-diagnosis._heuristicClassify); for open answers (no canonical
// correct_answer string) heuristic falls through to VOCAB fallback — useless
// for essay/applied-reasoning items.
//
// Wire: error-diagnosis.diagnoseError sync taxonomy classification (KEEP) +
// judge.judgeOpenAnswer async semantic verdict (NEW, for type=open_answer).
//
// Design contract:
//   - Capability T4_JUDGE (router DispatchPolicy 60/30/10 GLM-4.5-Air /
//     DeepSeek-V4-Flash / Kimi-K2.6). Pre-call cost gate via cost-predictor
//     (already invoked inside executeChat _w84PreCallGate). Caller can pass
//     userId for full Cashflow Shield enforcement.
//   - JSON contract: { verdict, confidence, reasoning, concept_gaps[],
//     suggested_next }
//   - Robust to malformed LLM output: code-fence wrappers, leading prose,
//     trailing chatter, escaped braces — _extractFirstJSON salvage with
//     graceful "reroute" verdict + parse-fail reasoning if irrecoverable.
//   - Audit log to vault/.hypha/exam-judge-trace.jsonl (per-call: question
//     hash, verdict, ¥ cost, attempts, ts) — supports future v0.5+ Trust
//     Panel inspection without leaking user-answer text into long-lived logs.
//   - Pure-ish: zero side effects when audit disabled. Vault writes only on
//     opts.audit !== false.
//
// 不重叠 error-diagnosis.js: diagnose = 错因分类 (8 类 taxonomy);
// judge = 答案正确性 (verdict 4 档). Caller decides which to invoke based
// on item.type. open_answer 走 judge; multi-choice / fill-blank 走 diagnose.
//
// Cost honest: per call ~600 input + ≤500 output T4_JUDGE tokens ≈ ¥0.02
// best case. Cost gate hard-blocks WOULD_EXCEED_BUDGET; never silently
// swallows budget violations.
// ──────────────────────────────────────────────────────────────────────

'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const VERDICTS = Object.freeze({
  CORRECT:   'correct',
  PARTIAL:   'partial',
  INCORRECT: 'incorrect',
  REROUTE:   'reroute',
});

const SUGGESTED_NEXT = Object.freeze({
  REVIEW_CONCEPT: 'review_concept',
  REDO_EXERCISE:  'redo_exercise',
  ADVANCE:        'advance',
});

const _AUDIT_REL = '.hypha/exam-judge-trace.jsonl';
const _MAX_INPUT_CHARS = 8000;    // hard ceiling per field to bound token cost
const _DEFAULT_MAX_TOKENS = 600;  // judge response is small JSON; 600 leaves margin

function _truncate(s, n) {
  const v = (typeof s === 'string') ? s : (s == null ? '' : String(s));
  return v.length > n ? (v.slice(0, n) + '\n…[truncated]') : v;
}

function _hashShort(s) {
  try {
    return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);
  } catch (_) {
    return 'noahash';
  }
}

// Salvage the first balanced JSON object out of arbitrary LLM text. Mirrors
// agent.js + critique-runner._extractFirstJSON — keep local to avoid coupling.
function _extractFirstJSON(rawIn) {
  if (rawIn == null) return null;
  if (typeof rawIn !== 'string') {
    // Already-parsed object → return as-is for the JSON.parse step.
    return JSON.stringify(rawIn);
  }
  let raw = rawIn.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try { JSON.parse(raw); return raw; } catch (_) { /* fall through */ }
  for (let start = 0; start < raw.length; start++) {
    if (raw[start] !== '{') continue;
    let depth = 0, inStr = false, escape = false;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1);
          try { JSON.parse(candidate); return candidate; } catch (_) {}
          break;
        }
      }
    }
  }
  return null;
}

function _coerceVerdict(v) {
  const s = String(v || '').toLowerCase().trim();
  if (s === 'correct') return VERDICTS.CORRECT;
  if (s === 'partial' || s === 'partially_correct') return VERDICTS.PARTIAL;
  if (s === 'incorrect' || s === 'wrong') return VERDICTS.INCORRECT;
  return VERDICTS.REROUTE;
}

function _coerceSuggested(s, verdict) {
  const v = String(s || '').toLowerCase().trim();
  if (v === 'review_concept' || v === 'redo_exercise' || v === 'advance') return v;
  // Default per verdict.
  if (verdict === VERDICTS.CORRECT) return SUGGESTED_NEXT.ADVANCE;
  if (verdict === VERDICTS.PARTIAL) return SUGGESTED_NEXT.REDO_EXERCISE;
  if (verdict === VERDICTS.INCORRECT) return SUGGESTED_NEXT.REVIEW_CONCEPT;
  return SUGGESTED_NEXT.REVIEW_CONCEPT;
}

function _coerceGaps(g) {
  if (!Array.isArray(g)) return [];
  return g.map((x) => (typeof x === 'string' ? x.slice(0, 200) : ''))
    .filter(Boolean).slice(0, 8);
}

function _clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.5;
  return Math.min(Math.max(v, 0), 1);
}

function _buildPrompt({ question, userAnswer, rubric, modelAnswer }) {
  const q = _truncate(question, _MAX_INPUT_CHARS);
  const ua = _truncate(userAnswer, _MAX_INPUT_CHARS);
  const r = _truncate(rubric, _MAX_INPUT_CHARS);
  const ma = _truncate(modelAnswer, _MAX_INPUT_CHARS);

  return [
    'You are a rigorous, fair examiner grading an open-ended answer against a rubric.',
    'Return ONLY a JSON object (no prose, no code fence).',
    '',
    'QUESTION:',
    q,
    '',
    'RUBRIC:',
    r || '(no rubric supplied — judge by canonical model answer + reasoning quality)',
    '',
    ma ? `MODEL ANSWER (reference, not gospel):\n${ma}\n` : '',
    'STUDENT ANSWER:',
    ua,
    '',
    'Grade by rubric strictly. Verdicts:',
    '  - "correct"   = covers all rubric points + reasoning sound',
    '  - "partial"   = covers some rubric points OR has reasoning gaps but core right',
    '  - "incorrect" = misses core rubric points OR reasoning broken',
    '',
    'List concept_gaps (≤6 short tags, e.g. ["因果方向", "范围限定"]) — empty when correct.',
    'Pick suggested_next:',
    '  - "advance"        — verdict=correct, move on',
    '  - "redo_exercise"  — verdict=partial, try variant',
    '  - "review_concept" — verdict=incorrect, revisit prereq',
    '',
    'Schema:',
    '{',
    '  "verdict": "correct" | "partial" | "incorrect",',
    '  "confidence": 0.0..1.0,',
    '  "reasoning": "1-3 sentence rationale citing rubric point names",',
    '  "concept_gaps": ["string", ...],',
    '  "suggested_next": "advance" | "redo_exercise" | "review_concept"',
    '}',
  ].filter(Boolean).join('\n');
}

function _extractRawText(dispatch) {
  if (!dispatch) return '';
  const r = dispatch.result;
  if (typeof r === 'string') return r;
  if (r && typeof r.content === 'string') return r.content;
  if (r && r.message && typeof r.message.content === 'string') return r.message.content;
  if (r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message
      && typeof r.choices[0].message.content === 'string') {
    return r.choices[0].message.content;
  }
  try { return JSON.stringify(r); } catch (_) { return ''; }
}

function _appendAudit(row, opts) {
  if (opts && opts.audit === false) return;
  let v = null;
  try { v = require('../vault'); } catch (_) { return; }
  if (!v || typeof v.appendJSONL !== 'function') return;
  try { v.appendJSONL(_AUDIT_REL, row); } catch (_) { /* swallow — audit must not break grading */ }
}

function _buildRerouteResult(reasoning, extra) {
  return {
    verdict: VERDICTS.REROUTE,
    confidence: 0,
    reasoning: String(reasoning || 'judge unavailable'),
    concept_gaps: [],
    suggested_next: SUGGESTED_NEXT.REVIEW_CONCEPT,
    ...(extra || {}),
  };
}

/**
 * Judge an open-ended answer against a rubric using T4_JUDGE capability LLM.
 *
 * @param {object} input
 * @param {string} input.question
 * @param {string} input.userAnswer
 * @param {string} [input.rubric]       — recommended; falls back to model-answer comparison
 * @param {string} [input.modelAnswer]  — canonical reference, optional
 * @param {object} [opts]
 * @param {string} [opts.userId]        — enables Cashflow Shield budget enforcement
 * @param {string} [opts.slug]          — for audit trace
 * @param {string} [opts.tier]          — Pricing tier passed to shield
 * @param {boolean} [opts.audit=true]   — write to exam-judge-trace.jsonl
 * @param {number} [opts.maxTokens]
 * @param {function} [opts.injectExecuteChat] — test seam; mock LLM
 * @returns {Promise<{verdict, confidence, reasoning, concept_gaps[], suggested_next, _meta?}>}
 */
async function judgeOpenAnswer(input, opts) {
  const options = opts || {};
  if (!input || typeof input !== 'object') {
    const r = _buildRerouteResult('invalid input — not an object');
    _appendAudit({
      ts: new Date().toISOString(),
      slug: options.slug || null,
      verdict: r.verdict,
      reason: 'invalid_input',
    }, options);
    return r;
  }
  const question   = String(input.question   || '').trim();
  const userAnswer = String(input.userAnswer || '').trim();
  if (!question || !userAnswer) {
    const r = _buildRerouteResult('question and userAnswer required');
    _appendAudit({
      ts: new Date().toISOString(),
      slug: options.slug || null,
      verdict: r.verdict,
      reason: 'missing_required_fields',
    }, options);
    return r;
  }

  const prompt = _buildPrompt({
    question,
    userAnswer,
    rubric:      input.rubric || '',
    modelAnswer: input.modelAnswer || '',
  });

  // Acquire LLM router. Test seam: opts.injectExecuteChat overrides.
  let executeChat = options.injectExecuteChat;
  if (typeof executeChat !== 'function') {
    try {
      const llm = require('../llm');
      executeChat = llm && llm.executeChat;
    } catch (_) { executeChat = null; }
  }
  if (typeof executeChat !== 'function') {
    const r = _buildRerouteResult('LLM router unavailable');
    _appendAudit({
      ts: new Date().toISOString(),
      slug: options.slug || null,
      verdict: r.verdict,
      reason: 'router_unavailable',
    }, options);
    return r;
  }

  const chatArgs = {
    messages: [{ role: 'user', content: prompt }],
    json: true,
    temperature: 0,
    maxTokens: Number(options.maxTokens) > 0 ? Number(options.maxTokens) : _DEFAULT_MAX_TOKENS,
    timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30_000,
    // Cashflow Shield + cost-predictor gate fires inside router._w84PreCallGate
    // when userId is present. Tier defaults to 'Pro' in shield when omitted.
    userId: options.userId || undefined,
    slug:   options.slug   || undefined,
    tier:   options.tier   || undefined,
  };

  let dispatch = null;
  let llmError = null;
  try {
    dispatch = await executeChat('T4_JUDGE', chatArgs);
  } catch (err) {
    llmError = err;
  }

  if (llmError) {
    // COST_BUDGET_EXCEEDED / BudgetExceededError → propagate as REROUTE with
    // structured reason so caller can show a budget-aware toast instead of
    // a generic error.
    const code = (llmError && llmError.code) || (llmError && llmError.name) || 'LLM_ERROR';
    const r = _buildRerouteResult(`judge unavailable: ${code} — ${(llmError.message || '').slice(0, 200)}`, {
      _meta: { error_code: code, error_message: (llmError.message || '').slice(0, 400) },
    });
    _appendAudit({
      ts: new Date().toISOString(),
      slug: options.slug || null,
      question_hash: _hashShort(question),
      verdict: r.verdict,
      reason: code,
      error_message: (llmError.message || '').slice(0, 400),
    }, options);
    // Hard-propagate budget exceptions so UI gets the structured code.
    if (code === 'COST_BUDGET_EXCEEDED' || code === 'BudgetExceededError') {
      const e = new Error(llmError.message || 'budget exceeded');
      e.code = code;
      e.judge_reroute = r;
      throw e;
    }
    return r;
  }

  const rawText = _extractRawText(dispatch);
  const jsonStr = _extractFirstJSON(rawText);
  let parsed = null;
  if (jsonStr) {
    try { parsed = JSON.parse(jsonStr); } catch (_) { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object') {
    const r = _buildRerouteResult('judge returned unparseable JSON', {
      _meta: {
        provider:   (dispatch && dispatch.providerId) || null,
        model:      (dispatch && dispatch.model) || null,
        attempts:   (dispatch && dispatch.attempts) || null,
        raw_excerpt: String(rawText || '').slice(0, 300),
      },
    });
    _appendAudit({
      ts: new Date().toISOString(),
      slug: options.slug || null,
      question_hash: _hashShort(question),
      verdict: r.verdict,
      reason: 'json_parse_fail',
      provider: r._meta && r._meta.provider,
      model: r._meta && r._meta.model,
    }, options);
    return r;
  }

  const verdict = _coerceVerdict(parsed.verdict);
  const confidence = _clamp01(parsed.confidence);
  const reasoning = String(parsed.reasoning || '').slice(0, 1200);
  const concept_gaps = _coerceGaps(parsed.concept_gaps);
  const suggested_next = _coerceSuggested(parsed.suggested_next, verdict);

  const result = {
    verdict,
    confidence,
    reasoning,
    concept_gaps,
    suggested_next,
    _meta: {
      provider: (dispatch && dispatch.providerId) || null,
      model:    (dispatch && dispatch.model) || null,
      attempts: (dispatch && dispatch.attempts) || null,
      predicted_cost_cny: (dispatch && dispatch.predicted_cost && dispatch.predicted_cost.cny_est) || null,
      cost_gate_state:    (dispatch && dispatch.cost_gate && dispatch.cost_gate.state) || null,
    },
  };

  _appendAudit({
    ts: new Date().toISOString(),
    slug: options.slug || null,
    question_hash: _hashShort(question),
    verdict,
    confidence,
    concept_gaps_n: concept_gaps.length,
    suggested_next,
    provider: result._meta.provider,
    model: result._meta.model,
    attempts: result._meta.attempts,
    predicted_cost_cny: result._meta.predicted_cost_cny,
    cost_gate_state: result._meta.cost_gate_state,
  }, options);

  return result;
}

module.exports = {
  VERDICTS,
  SUGGESTED_NEXT,
  judgeOpenAnswer,
  // exposed for tests / future re-use
  _extractFirstJSON,
  _buildPrompt,
  _coerceVerdict,
  _coerceSuggested,
};
