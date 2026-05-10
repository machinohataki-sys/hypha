'use strict';

// HYPHA · Micro Proof scoring — sub-step H (v0.1).
//
// Per BLUEPRINT AMD-1: v0.1 evidence types are Recall + Production. Both are
// scored by a LOCAL BASELINE (regex hit + structural shape check). The LLM is
// invoked as a MONITORING SIGNAL ONLY — its judgment never overrides the
// baseline's `passed` verdict. Disagreement between LLM + baseline is logged
// as `false_positive_risk` for later QA harvesting.
//
// Why monitor-only: a 2nd LLM call to score a 1st LLM's question is precisely
// the LLM-judging-LLM loop council rejected at v0.1 (proof would be circular,
// not falsifiable). The regex/shape baseline is deterministic + auditable; the
// LLM provides a parallel read for offline review of false-positive patterns.
//
// Explanation / Transfer / Judgment evidence types are NOT in v0.1 — they
// require human gate (per AMD-1) and ship in v0.2+.

const { executeChat, LLMProviderError } = require('./llm');

const SCORING_SYSTEM_PROMPT = `You are a HYPHA evidence classifier. Given a Micro Proof stimulus + expected_signal pattern + user response, output ONE JSON object:

{
  "evidence_type": "recall" | "production",
  "passed": boolean,
  "baseline_check": { "regex_hits": [...], "shape_match": boolean },
  "llm_signal": { "matches_pattern": boolean, "reason": "<=80 char structural reason" },
  "false_positive_risk": "low" | "medium" | "high"
}

CLASSIFICATION RULES (per AMD-1):
- evidence_type=recall: response is a paste of facts/keywords/answer to a "list / name / state" stimulus. Pattern matches expected_signal token list.
- evidence_type=production: response contains an artifact (code / structure / graph / list of fields). Pattern matches "contains X, Y, Z" structural shape.
- baseline_check.regex_hits: list of ALL tokens from expected_signal that appear verbatim or as substring in response (case-insensitive).
- baseline_check.shape_match: true iff regex_hits length >= ceil(0.6 * expected_signal token count) for recall, OR for production: response length >= 30 chars AND contains >=1 structural separator (newline / : / -).
- passed = baseline_check.shape_match (LLM is MONITORING ONLY, not terminal verdict per AMD-1).
- llm_signal.matches_pattern: LLM independent judgment (informational, not used for passed).
- false_positive_risk: HIGH if baseline.shape_match=true but llm_signal.matches_pattern=false (false positive likely); MEDIUM if both true but reason is weak; LOW if both true and reason is concrete.

CRITICAL: passed is from BASELINE only. LLM disagreement is logged as false_positive_risk for monitoring, never overrides baseline.`;

const VALID_EVIDENCE_TYPES = ['recall', 'production'];
const VALID_RISK_LEVELS = ['low', 'medium', 'high'];

// G3 (v0.1 acceptance gate, AMD-5): Production response must be ≥30% non-LLM-direct.
// Compare user response against recent assistant messages — if any is too similar,
// the response is a paste, not a real artifact. Threshold tuned on 5-case fixture.
const PASTE_SIMILARITY_THRESHOLD = 0.70;

// Iterative Levenshtein with row-rolling to keep memory at O(min(|a|,|b|)).
// For our purpose (response vs ≤3 recent assistant messages, each ≤ ~4000 chars)
// this is well under 10ms per comparison on modern Node.
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  // Make `a` the shorter — keeps the rolling row at min length.
  if (a.length > b.length) { const tmp = a; a = b; b = tmp; }
  const n = a.length, m = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let i = 0; i <= n; i++) prev[i] = i;
  for (let j = 1; j <= m; j++) {
    curr[0] = j;
    const bj = b.charCodeAt(j - 1);
    for (let i = 1; i <= n; i++) {
      const cost = (a.charCodeAt(i - 1) === bj) ? 0 : 1;
      curr[i] = Math.min(
        curr[i - 1] + 1,        // insertion
        prev[i] + 1,            // deletion
        prev[i - 1] + cost,     // substitution
      );
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

// Similarity in [0, 1]; 1 = identical, 0 = totally different.
function similarityRatio(a, b) {
  if (!a && !b) return 1;
  const longer = Math.max(a ? a.length : 0, b ? b.length : 0);
  if (longer === 0) return 1;
  return 1 - levenshteinDistance(a || '', b || '') / longer;
}

// Detect if `response` is a paste of any `recentAssistantMessages` entry.
// Returns { detected, max_similarity, source_idx } — source_idx points to the
// closest match in the recent-msg array (-1 if no entries).
function detectPaste(response, recentAssistantMessages) {
  if (!Array.isArray(recentAssistantMessages) || recentAssistantMessages.length === 0) {
    return { detected: false, max_similarity: 0, source_idx: -1 };
  }
  const r = (response || '').trim();
  if (!r) return { detected: false, max_similarity: 0, source_idx: -1 };
  let max = 0;
  let idx = -1;
  for (let i = 0; i < recentAssistantMessages.length; i++) {
    const sim = similarityRatio(r, (recentAssistantMessages[i] || '').trim());
    if (sim > max) { max = sim; idx = i; }
  }
  return { detected: max >= PASTE_SIMILARITY_THRESHOLD, max_similarity: max, source_idx: idx };
}

// Tokenize expected_signal into checkable atoms. Splits on whitespace + common
// punct, lowercases, drops 1-char filler tokens (so "X" stays but "a" / "的"
// are dropped). Conservative — a token is anything that could plausibly
// reappear verbatim in a learner's response.
function tokenizeExpectedSignal(expectedSignal) {
  if (typeof expectedSignal !== 'string') return [];
  return expectedSignal
    .toLowerCase()
    .split(/[\s,.;:、，。；：!?！？()\[\]{}（）【】「」"'`/\\]+/u)
    .map(t => t.trim())
    .filter(t => t.length >= 2);
}

// Local baseline computation — defense-in-depth. We always recompute this
// locally even after the LLM returns its own baseline_check, then OVERWRITE
// the LLM's result with ours. The LLM's baseline_check is treated as
// untrusted (it might miscount, hallucinate hits, etc).
function computeLocalBaseline(microProof, response, evidenceType, recentAssistantMessages = []) {
  const tokens = tokenizeExpectedSignal(microProof.expected_signal);
  const responseLower = (response || '').toLowerCase();
  const hits = tokens.filter(tok => responseLower.includes(tok));
  // Dedupe — repeated tokens in expected_signal shouldn't double-count.
  const regexHits = Array.from(new Set(hits));

  let shapeMatch;
  let pasteCheck = { detected: false, max_similarity: 0, source_idx: -1 };
  if (evidenceType === 'production') {
    // Production: artifact-shaped output. Length floor + structural separator.
    const hasSeparator = /[\n:\-]/.test(response || '');
    const lengthAndShapeOk = (response || '').trim().length >= 30 && hasSeparator;
    // G3: artifact must also be ≥30% non-LLM-direct. If it's mostly a paste of
    // a recent assistant message, force shape_match=false and surface the cause.
    pasteCheck = detectPaste(response, recentAssistantMessages);
    shapeMatch = lengthAndShapeOk && !pasteCheck.detected;
  } else {
    // Recall (default): require >= ceil(0.6 * tokenCount) verbatim hits.
    // If expected_signal had no usable tokens, fall back to a length floor —
    // empty token list shouldn't auto-pass an empty response.
    if (tokens.length === 0) {
      shapeMatch = (response || '').trim().length >= 10;
    } else {
      const threshold = Math.ceil(0.6 * tokens.length);
      shapeMatch = regexHits.length >= threshold;
    }
  }

  const out = { regex_hits: regexHits, shape_match: shapeMatch };
  if (evidenceType === 'production') {
    out.paste_detected = pasteCheck.detected;
    out.paste_max_similarity = Number(pasteCheck.max_similarity.toFixed(3));
    out.paste_source_idx = pasteCheck.source_idx;
  }
  return out;
}

// Risk classification. HIGH = baseline says pass but LLM says fail (likely
// false positive: tokens present but structure wrong). MEDIUM = both pass
// but LLM reason is weak/short (<= 20 chars suggests boilerplate). LOW =
// both pass with concrete reason. If baseline failed, risk is moot — we
// return LOW because there's no false-positive surface (the user already saw
// the FAIL outcome).
function computeFPRisk(baseline, llmSignal) {
  if (!baseline.shape_match) return 'low';
  const llmAgrees = llmSignal && llmSignal.matches_pattern === true;
  if (!llmAgrees) return 'high';
  const reason = (llmSignal && typeof llmSignal.reason === 'string') ? llmSignal.reason.trim() : '';
  if (reason.length < 20) return 'medium';
  return 'low';
}

function validateScoreResult(r) {
  const errors = [];
  if (!r || typeof r !== 'object') {
    errors.push('result must be an object');
    return errors;
  }
  if (!VALID_EVIDENCE_TYPES.includes(r.evidence_type)) {
    errors.push(`evidence_type must be one of ${VALID_EVIDENCE_TYPES.join('|')} (got ${r.evidence_type})`);
  }
  if (typeof r.passed !== 'boolean') {
    errors.push(`passed must be boolean (got ${typeof r.passed})`);
  }
  if (!r.baseline_check || typeof r.baseline_check !== 'object') {
    errors.push('baseline_check must be an object');
  } else {
    if (!Array.isArray(r.baseline_check.regex_hits)) {
      errors.push('baseline_check.regex_hits must be an array');
    }
    if (typeof r.baseline_check.shape_match !== 'boolean') {
      errors.push(`baseline_check.shape_match must be boolean (got ${typeof r.baseline_check.shape_match})`);
    }
  }
  if (!r.llm_signal || typeof r.llm_signal !== 'object') {
    errors.push('llm_signal must be an object');
  } else {
    if (typeof r.llm_signal.matches_pattern !== 'boolean') {
      errors.push(`llm_signal.matches_pattern must be boolean (got ${typeof r.llm_signal.matches_pattern})`);
    }
    if (typeof r.llm_signal.reason !== 'string') {
      errors.push(`llm_signal.reason must be a string (got ${typeof r.llm_signal.reason})`);
    }
  }
  if (!VALID_RISK_LEVELS.includes(r.false_positive_risk)) {
    errors.push(`false_positive_risk must be one of ${VALID_RISK_LEVELS.join('|')} (got ${r.false_positive_risk})`);
  }
  return errors;
}

async function scoreMicroProof({ plan, response, capability = 'T3_MID', maxRetries = 1, recentAssistantMessages = [] } = {}) {
  if (!plan || typeof plan !== 'object' || !plan.micro_proof) {
    throw new LLMProviderError('plan with micro_proof required');
  }
  const mp = plan.micro_proof;
  if (typeof mp.stimulus !== 'string' || typeof mp.expected_signal !== 'string' || typeof mp.fail_mode !== 'string') {
    throw new LLMProviderError('plan.micro_proof must have string stimulus / expected_signal / fail_mode');
  }
  if (typeof response !== 'string' || !response.trim()) {
    throw new LLMProviderError('response (non-empty string) required');
  }

  // Capability-class routing per AMD-MEOW-P4 §17.2.1: T3_MID default = GLM-4.5-Air.
  // 10x cheaper than T6 for binary classification; baseline is local anyway.
  // Phase D: use executeChat for runtime fallback (DispatchPolicy 60/30/10 +
  // ProviderHealth). Network retries handled inside the router; this outer loop
  // handles only JSON validation retries.
  const userMessage = `STIMULUS: ${mp.stimulus}
EXPECTED_SIGNAL: ${mp.expected_signal}
FAIL_MODE: ${mp.fail_mode}
USER_RESPONSE: ${response}

Classify evidence type, run baseline check, output JSON.`;

  let messages = [
    { role: 'system', content: SCORING_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const dispatch = await executeChat(capability, {
      messages,
      json: true,
      temperature: 0.3,
      maxTokens: 800,
      timeoutMs: 60_000,
    });
    const result = dispatch.result;

    const errors = validateScoreResult(result);
    if (errors.length === 0) {
      // Defense-in-depth: override LLM's baseline + passed with our own local
      // computation. LLM is monitor-only per AMD-1; the regex/shape baseline is
      // the verdict of record. We keep llm_signal verbatim (that's the monitor
      // payload) and recompute false_positive_risk from the trusted baseline.
      const localBaseline = computeLocalBaseline(mp, response, result.evidence_type, recentAssistantMessages);
      result.baseline_check = localBaseline;
      result.passed = localBaseline.shape_match;
      result.false_positive_risk = computeFPRisk(localBaseline, result.llm_signal);
      result._meta = {
        providerId: dispatch.providerId,
        model: dispatch.model,
        capability,
        attempts: attempt + 1,
        networkAttempts: dispatch.attempts,
      };
      return result;
    }

    if (attempt < maxRetries) {
      const errorList = errors.map(e => '  - ' + e).join('\n');
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result) },
        { role: 'user', content: `Score result failed schema validation:\n${errorList}\n\nRegenerate strictly per the SCHEMA + CLASSIFICATION RULES in the system prompt.` },
      ];
      continue;
    }

    throw new LLMProviderError(`scoreMicroProof returned malformed result after ${maxRetries + 1} attempts: ${errors.join('; ')}`);
  }
}

module.exports = {
  scoreMicroProof,
  validateScoreResult,
  computeLocalBaseline,
  computeFPRisk,
  tokenizeExpectedSignal,
  detectPaste,
  similarityRatio,
  levenshteinDistance,
  PASTE_SIMILARITY_THRESHOLD,
  SCORING_SYSTEM_PROMPT,
};
