'use strict';

// Pre-call cost predictor for HYPHA Cashflow Shield gating.
// Estimates input token count + max output budget + ¥ cost BEFORE LLM dispatch.
// Heuristic char-based tokenizer (no external tokenizer dep) — accuracy ±15%
// on mixed CJK/ASCII content, sufficient for budget gates.
//
// Per-capability rates reflect 2026-Q2 ballpark pricing
// (GLM-5.1 / DeepSeek-V4-Pro / BGE-M3). Update when provider tiers shift.

const COST_PER_1K_TOKENS = Object.freeze({
  T6_STRONG: { input_cny: 0.04, output_cny: 0.12 },
  T4_JUDGE: { input_cny: 0.01, output_cny: 0.03 },
  T3_MID: { input_cny: 0.005, output_cny: 0.015 },
  T2_LOCAL: { input_cny: 0, output_cny: 0 },
  T1_EMBED: { input_cny: 0.0003, output_cny: 0 },
});

const DEFAULT_OUTPUT_TOKENS = Object.freeze({
  T6_STRONG: 8000,
  T4_JUDGE: 1000,
  T3_MID: 2000,
  T2_LOCAL: 2000,
  T1_EMBED: 0,
});

// Char-based heuristic. CJK ~1.7 chars/token (GLM tokenizer), ASCII ~4 chars/token.
// Whitespace + control chars contribute 0. Punctuation outside ASCII printable
// range falls through (acceptable noise floor — typical prompts are word-dense).
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    // CJK Unified Ideographs + CJK Symbols and Punctuation block.
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x303F)) {
      cjk++;
    } else if (code > 32 && code < 127) {
      ascii++;
    }
  }
  return Math.ceil(cjk / 1.7) + Math.ceil(ascii / 4);
}

// Aggregate token estimate across a messages array. Supports both string content
// and structured-content arrays ({type, text} parts per Anthropic/OpenAI v2 schema).
// Adds 4-token overhead per message for role tag + delimiters (OpenAI convention).
function estimateMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    if (!m) continue;
    const content = m.content;
    if (typeof content === 'string') {
      total += estimateTokens(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part.text === 'string') {
          total += estimateTokens(part.text);
        }
      }
    }
    total += 4; // per-message overhead
  }
  return total;
}

// Main predictor. Returns { ok, estimate } envelope per project convention.
// estimate.estimation_source = 'tokenizer-fallback' marks heuristic origin
// (4-glyph honesty mark per CLAUDE.md evidence-tagging discipline).
function predictCost(messages, capability, opts = {}) {
  if (!capability || !(capability in COST_PER_1K_TOKENS)) {
    return { ok: false, error: 'UNKNOWN_CAPABILITY', estimate: null };
  }
  const rates = COST_PER_1K_TOKENS[capability];
  const defaultMaxOut = DEFAULT_OUTPUT_TOKENS[capability];
  const requestedMax = Number(opts.maxOutputTokens);
  const maxOutputTokens = requestedMax > 0 ? requestedMax : defaultMaxOut;
  const inputTokens = estimateMessages(messages);
  const inputCny = (inputTokens / 1000) * rates.input_cny;
  const outputCny = (maxOutputTokens / 1000) * rates.output_cny;
  const cnyEst = +(inputCny + outputCny).toFixed(4);
  return {
    ok: true,
    estimate: {
      input_tokens_est: inputTokens,
      output_tokens_max: maxOutputTokens,
      cny_est: cnyEst,
      capability,
      breakdown: {
        input_cny: +inputCny.toFixed(4),
        output_cny: +outputCny.toFixed(4),
      },
      estimation_source: 'tokenizer-fallback',
      status: 'predicted',
    },
  };
}

// Budget gate. Pure function over (predicted_cny, remaining_cny).
// Returns { allowed, reason, ... } — caller decides whether to dispatch.
// Near-limit (ratio > 0.9) still allowed but flagged for telemetry.
function gateAgainstBudget(predictedCny, remainingBudgetCny, opts = {}) {
  if (!Number.isFinite(predictedCny) || !Number.isFinite(remainingBudgetCny)) {
    return { allowed: false, reason: 'INVALID_INPUT' };
  }
  if (predictedCny <= 0) {
    return { allowed: true, reason: 'NO_COST' };
  }
  if (remainingBudgetCny <= 0) {
    return { allowed: false, reason: 'BUDGET_EXHAUSTED' };
  }
  if (predictedCny > remainingBudgetCny) {
    return {
      allowed: false,
      reason: 'WOULD_EXCEED_BUDGET',
      predicted: predictedCny,
      remaining: remainingBudgetCny,
    };
  }
  const ratio = predictedCny / remainingBudgetCny;
  if (ratio > 0.9) {
    return { allowed: true, reason: 'OK_BUT_NEAR_LIMIT', ratio };
  }
  return { allowed: true, reason: 'OK', ratio };
}

// Pre-flight quote — UI-confirmation surface for lesson-gen request shape.
// Heuristic = predictCost ¥ × generation_length_factor, where the factor lets
// callers model multi-turn / multi-section lesson gen without re-tokenizing.
// Confidence is bucketed off input-token volume + capability (heuristic
// tokenizer accuracy degrades on dense CJK and very short prompts).
function preflightQuote(opts = {}) {
  const messages = Array.isArray(opts.messages) ? opts.messages : [];
  const capability = opts.capability;
  const factor = Number(opts.generation_length_factor);
  const lengthFactor = (Number.isFinite(factor) && factor > 0) ? factor : 1.0;
  const base = predictCost(messages, capability, {
    maxOutputTokens: Number(opts.max_output_tokens) || undefined,
  });
  if (!base.ok) {
    return { ok: false, error: base.error };
  }
  const e = base.estimate;
  const predictedCny = +(e.cny_est * lengthFactor).toFixed(4);
  const predictedTokens = e.input_tokens_est + Math.ceil(e.output_tokens_max * lengthFactor);
  let confidence = 'low';
  if (e.input_tokens_est >= 200 && (capability === 'T6_STRONG' || capability === 'T4_JUDGE')) {
    confidence = 'medium';
  }
  if (e.input_tokens_est >= 1000 && lengthFactor <= 1.5) confidence = 'high';
  return {
    ok: true,
    predicted_cny: predictedCny,
    predicted_tokens: predictedTokens,
    confidence,
    breakdown: {
      input_tokens_est: e.input_tokens_est,
      output_tokens_max: Math.ceil(e.output_tokens_max * lengthFactor),
      base_cny_est: e.cny_est,
      generation_length_factor: lengthFactor,
      capability,
    },
    estimation_source: 'tokenizer-fallback',
  };
}

module.exports = {
  COST_PER_1K_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  estimateTokens,
  estimateMessages,
  predictCost,
  gateAgainstBudget,
  preflightQuote,
};
