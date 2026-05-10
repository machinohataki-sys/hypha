'use strict';
// HYPHA · Lesson Skeleton generator — sub-step D backend
//
// ⚠ Naming clarification (2026-05-08, v0.3 pivot): the legacy export name
// `generatePlan` is a misnomer. Per BLUEPRINT §1.1, "Plan" = the curriculum
// CHAIN (multi-lesson 0→frontier path produced by `agent.js:planChain`),
// NOT the per-lesson 6-field skeleton this module emits. Internally this
// module produces a "Lesson Skeleton" / "starter card" — a HOOK seed used
// by the v0.3 chat surface (LessonChat + 8-state state-machine).
//
// The export name `generatePlan` is retained for ABI compatibility with
// existing IPC callers (main.js → preload.js → screen-lesson.jsx). New
// callers should treat the return value as a SKELETON, not as the
// authoritative lesson content. The 12-field §6.1 schema is covered
// through chat turns, not through this skeleton's 6 fields.
//
// `generateLessonBody` (3-field intro/path/closing static prose) is
// DEPRECATED v0.3 — its output violates §6.1 (12-field interactive
// coverage) and is auto-flagged ornamentation by the v0.2 trust stack.
// Retained as v0.2 transition surface; do not extend. See bottom of file.
//
// Pipeline position: between Goal Contract (sub-step A) and Lesson body
// generation (later sub-step). This module owns ONLY Lesson Skeleton
// generation — the 6-field skeleton-before-prose stage.
//
// Schema validated 2026-05-08 via 5-plan smoke test (round 2): 5/5 strict
// 3/3, plan→goal mapping 5/5 obvious. Council synthesis: Lung Tetlock +
// Yogo bimodal + Scout LearnLM/EduPlanner converged on this 6-field shape.
//
// Returns skeleton object or throws LLMError. v0.1 = single-pass + 1 retry
// on schema violation. NO Critic loop (deferred to v0.2 — 3-of-3 council
// questioned LLM-judging-LLM at v0.1).

const { getProvider, LLMProviderError } = require('./llm');
const jargonFirewall = require('./jargon-firewall');
const assignment = require('./assignment');

const SYSTEM_PROMPT = `You are a HYPHA lesson architect. Output ONE JSON object matching the schema. No prose outside JSON.

SCHEMA (6 top-level fields, EXACTLY this shape):
{
  "objective": "one Bloom-action-verb sentence ≤25 words",
  "prerequisite_check": "≤25 word yes/no question OR null",
  "hook_concrete": "≤80 tokens — concrete artifact OR contradiction",
  "path": ["3-4 strings, each ≤30 words, learner action not model derivation"],
  "micro_proof": {
    "stimulus": "single question/prompt ≤30 words",
    "expected_signal": "structural pattern (≤30 words) — see RULES below",
    "fail_mode": "≤25 words — what wrong looks like"
  },
  "next_lesson_seed": "≤1 sentence ≤20 words"
}

STRUCTURE RULES (violation = output rejected):
- All 6 keys MUST be at root level of the JSON object.
- micro_proof and next_lesson_seed are TOP-LEVEL keys, NEVER nested inside path or any other field.
- path is an array of STRINGS only — no objects, no nested keys.
- path items end with period or no punctuation. NO exclamation marks.

expected_signal RULES:
- Describe a STRUCTURAL PATTERN, not a literal API output. Examples of good patterns: "output contains a city name and a temperature number", "answer includes ≥2 of: cost, recall, latency", "JSON has fields X, Y, Z populated".
- FORBIDDEN interpretive verbs: "explicitly ties", "clearly states", "properly demonstrates", "appropriately addresses", "correctly applies". These require human judgment, not eyeball check.
- Must be checkable in <10s by reading the learner's pasted output against the pattern. NO 2nd LLM call.

CONSTRAINTS:
- 30 minutes total work for the target audience.
- path = what LEARNER DOES, not what model derives.
- No filler. No preamble. Direct artifacts only.`;

const REQUIRED_TOP_KEYS = ['objective', 'prerequisite_check', 'hook_concrete', 'path', 'micro_proof', 'next_lesson_seed'];
const REQUIRED_PROOF_KEYS = ['stimulus', 'expected_signal', 'fail_mode'];

// Evidence Ledger schema (AMD-MEOW-P7 M1, v0.2 Tranche 1 — schema + validator only,
// not yet enforced on generatePlan output to preserve v0.1 backward compat).
//
// Each row records the provenance of one non-trivial claim in the lesson
// skeleton or body. Hard claims (definition, mechanism) MUST set evidence_pointer != null;
// soft claims (analogy, spark, frontier judgment) MAY have null pointer but
// must declare confidence:speculative.
const EVIDENCE_TYPES = ['primary_source', 'reasoning', 'analogy', 'frontier_judgment', 'original_view', 'spark'];
const HARD_EVIDENCE_TYPES = ['primary_source', 'reasoning'];
const CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'speculative'];
const VERIFIABILITY_LEVELS = ['high', 'partial', 'low', 'unverifiable'];
const RISK_LEVELS = ['low', 'medium', 'high'];

const EVIDENCE_LEDGER_SCHEMA_DESCRIPTION = `Evidence Ledger row schema:
{
  "claim_ref": "path[i] | objective | hook_concrete | body.path_prose[i] | body.intro_prose | ...",
  "claim_text": "<= 120 chars verbatim quote of the claim",
  "evidence_type": "${EVIDENCE_TYPES.join(' | ')}",
  "evidence_pointer": "<file path | URL | source ID | null>",
  "confidence": "${CONFIDENCE_LEVELS.join(' | ')}",
  "verifiability": "${VERIFIABILITY_LEVELS.join(' | ')}",
  "risk": "${RISK_LEVELS.join(' | ')}"
}

Hard claims (evidence_type=primary_source OR reasoning) require evidence_pointer != null.`;

function validateEvidenceLedger(ledger) {
  const errors = [];
  if (!Array.isArray(ledger)) {
    errors.push('evidence_ledger must be an array');
    return errors;
  }
  ledger.forEach((row, i) => {
    if (!row || typeof row !== 'object') {
      errors.push(`evidence_ledger[${i}] must be an object`);
      return;
    }
    if (typeof row.claim_ref !== 'string' || !row.claim_ref.trim()) {
      errors.push(`evidence_ledger[${i}].claim_ref must be a non-empty string`);
    }
    if (typeof row.claim_text !== 'string' || row.claim_text.length > 200) {
      errors.push(`evidence_ledger[${i}].claim_text must be a string of <=200 chars`);
    }
    if (!EVIDENCE_TYPES.includes(row.evidence_type)) {
      errors.push(`evidence_ledger[${i}].evidence_type must be one of ${EVIDENCE_TYPES.join('|')} (got ${row.evidence_type})`);
    }
    if (HARD_EVIDENCE_TYPES.includes(row.evidence_type) && (row.evidence_pointer === null || row.evidence_pointer === undefined || row.evidence_pointer === '')) {
      errors.push(`evidence_ledger[${i}] is hard-claim (${row.evidence_type}) but evidence_pointer is null/empty`);
    }
    if (!CONFIDENCE_LEVELS.includes(row.confidence)) {
      errors.push(`evidence_ledger[${i}].confidence must be one of ${CONFIDENCE_LEVELS.join('|')} (got ${row.confidence})`);
    }
    if (!VERIFIABILITY_LEVELS.includes(row.verifiability)) {
      errors.push(`evidence_ledger[${i}].verifiability must be one of ${VERIFIABILITY_LEVELS.join('|')} (got ${row.verifiability})`);
    }
    if (!RISK_LEVELS.includes(row.risk)) {
      errors.push(`evidence_ledger[${i}].risk must be one of ${RISK_LEVELS.join('|')} (got ${row.risk})`);
    }
  });
  return errors;
}

function buildUserMessage({ goalContract, audience, learnerState, timeBudgetMin = 30 }) {
  return `GOAL_CONTRACT: ${JSON.stringify(goalContract)}
TARGET_AUDIENCE: ${audience || 'self-directed adult learner'}
TIME_BUDGET: ${timeBudgetMin} minutes
LEARNER_STATE: ${JSON.stringify(learnerState || { known: [], unknown: [] })}

Generate the lesson skeleton JSON.`;
}

function validatePlan(plan) {
  const errors = [];

  for (const k of REQUIRED_TOP_KEYS) {
    if (!(k in plan)) errors.push(`missing top-level key: ${k}`);
  }

  if (plan.path) {
    if (!Array.isArray(plan.path)) {
      errors.push('path must be an array');
    } else {
      plan.path.forEach((item, i) => {
        if (typeof item !== 'string') {
          errors.push(`path[${i}] must be a string, got ${typeof item}`);
        }
      });
    }
  }

  if (plan.micro_proof) {
    if (typeof plan.micro_proof !== 'object' || Array.isArray(plan.micro_proof)) {
      errors.push('micro_proof must be an object');
    } else {
      for (const k of REQUIRED_PROOF_KEYS) {
        if (!(k in plan.micro_proof)) errors.push(`micro_proof missing key: ${k}`);
        else if (typeof plan.micro_proof[k] !== 'string') errors.push(`micro_proof.${k} must be a string`);
      }
    }
  }

  if (plan.objective !== undefined && typeof plan.objective !== 'string') {
    errors.push('objective must be a string');
  }
  if (plan.hook_concrete !== undefined && typeof plan.hook_concrete !== 'string') {
    errors.push('hook_concrete must be a string');
  }
  if (plan.next_lesson_seed !== undefined && typeof plan.next_lesson_seed !== 'string') {
    errors.push('next_lesson_seed must be a string');
  }
  if (plan.prerequisite_check !== undefined && plan.prerequisite_check !== null && typeof plan.prerequisite_check !== 'string') {
    errors.push('prerequisite_check must be string or null');
  }

  return errors;
}

async function generatePlan({ goalContract, audience, learnerState, model = 'glm-5.1', timeBudgetMin = 30, maxRetries = 1 } = {}) {
  if (!goalContract || typeof goalContract !== 'object') {
    throw new LLMProviderError('goalContract object is required');
  }

  const provider = getProvider();
  const userMessage = buildUserMessage({ goalContract, audience, learnerState, timeBudgetMin });

  let messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const plan = await provider.chat({
      messages,
      model,
      json: true,
      temperature: 0.7,
      maxTokens: 1500,
      timeoutMs: 90_000,
    });

    const errors = validatePlan(plan);
    if (errors.length === 0) {
      try {
        const j = jargonFirewall.checkJargon(JSON.stringify(plan));
        if (!j.passed) {
          console.warn('[jargon-firewall] %d violation(s) in plan:', j.violations.length, j.violations);
        }
      } catch (_) { /* monitor-only, never block */ }
      plan.assignment_level = assignment.computeAssignmentLevel(goalContract, learnerState, plan);
      return plan;
    }

    if (attempt < maxRetries) {
      const errorList = errors.map(e => '  - ' + e).join('\n');
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(plan) },
        { role: 'user', content: `The previous output failed schema validation:\n${errorList}\n\nRegenerate with all 6 top-level keys present at root level. Strict adherence to the SCHEMA in the system prompt.` },
      ];
      continue;
    }

    throw new LLMProviderError(`Lesson skeleton failed schema validation after ${maxRetries + 1} attempts: ${errors.join('; ')}`);
  }
}

// =====================================================================
// Sub-step F — Lesson body generation from Skeleton (v0.1).
//
// ⚠ DEPRECATED v0.3 (2026-05-08). The 3-field static prose model
// (intro_prose / path_prose / closing_prose) is structurally wrong per
// BLUEPRINT §6.1 — a real lesson covers 12 fields THROUGH chat turns,
// not through static prose rendering. The v0.2 trust stack (Auditable
// Reasoning Summary) self-flagged intro_prose + closing_prose as
// "ornamentation" on production runs, confirming the diagnosis.
//
// The v0.3 replacement = LessonChat (NoteView.jsx) driven by:
//   - 8-state state-machine in app/lib/hypha-learn/state-machine.js
//   - app/prompts/learn-start.txt + learn-turn.txt (already shipped)
//   - turn-by-turn intercept by trust stack components
//
// Retained here only as the v0.2 transition surface for screen-lesson.jsx.
// DO NOT extend; bug fixes only.
//
// Per BLUEPRINT AMD-3+6: v0.1 only fields 4 + 11 (人话 prose + micro_proof
// inherits from plan). Fields 5-9 of v0.2+ schema (机制/术语/常见误解/Note
// 连接/Product Transfer) deferred — and per v0.3 pivot, not deferred to
// "later body generation" but to interactive chat coverage.

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi'];

const BODY_SYSTEM_PROMPT = `You are a HYPHA lesson body writer. Given a 6-field Plan skeleton, expand to body prose for v0.1.

OUTPUT ONE JSON object (no prose outside JSON):
{
  "intro_prose": "1 paragraph introducing objective via hook_concrete",
  "path_prose": [
    { "step_id": "i", "prose": "..." },
    { "step_id": "ii", "prose": "..." }
  ],
  "closing_prose": "1 paragraph bridging next_lesson_seed back to objective"
}

STRUCTURE RULES (violation = output rejected):
- intro_prose: ≤120 words, 1 paragraph. MUST refer to a concrete artifact from hook_concrete. MUST relate to goalContract.main_creation if present.
- path_prose: array length MUST equal plan.path.length. step_id sequence MUST be exactly i, ii, iii, iv (lowercase Roman).
- Each path step prose: 1-2 sentences, ≤60 words. MUST give EITHER 1 concrete example OR 1 reflection question (not both).
- DO NOT introduce new concepts not in plan.
- DO NOT restate path[i] verbatim — paraphrase + concretize.
- closing_prose: ≤100 words, 1 paragraph. Bridge next_lesson_seed to current objective.

FORBIDDEN words (replace with domain term substitutes — use 助手 not agent, 模型不可用 — describe behavior instead):
EN: AI, LLM, embedding, model, prompt, agent, RAG, vector, fine-tune
ZH 流量词: 这一刀, 闭环, 拉满, 干货, 绝绝子, yyds, 王炸, 杀疯了, 直击灵魂

CONSTRAINTS:
- v0.1 frozen scope (per AMD-10): NO 机制解释 / 必要术语 / 常见误解 / Note 连接 / Product Transfer in body. Only 人话 prose.
- Tone: serif 学术 register, 不口语化, 不感叹号.
- 服务 north_star_goal first, main_creation second.`;

function buildBodyUserMessage({ plan, goalContract, audience, learnerState }) {
  return `PLAN: ${JSON.stringify(plan)}
GOAL_CONTRACT: ${JSON.stringify(goalContract || {})}
TARGET_AUDIENCE: ${audience || 'self-directed adult learner'}
LEARNER_STATE: ${JSON.stringify(learnerState || { known: [], unknown: [] })}

Generate the lesson body JSON.`;
}

function validateBody(body, expectedPathLength) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    errors.push('body must be an object');
    return errors;
  }

  if (typeof body.intro_prose !== 'string' || body.intro_prose.length < 50) {
    errors.push(`intro_prose must be string >=50 chars (got ${typeof body.intro_prose}, len=${(body.intro_prose || '').length})`);
  }
  if (typeof body.closing_prose !== 'string' || body.closing_prose.length < 50) {
    errors.push(`closing_prose must be string >=50 chars (got ${typeof body.closing_prose}, len=${(body.closing_prose || '').length})`);
  }

  if (!Array.isArray(body.path_prose)) {
    errors.push('path_prose must be an array');
  } else {
    if (body.path_prose.length !== expectedPathLength) {
      errors.push(`path_prose length ${body.path_prose.length} != plan.path.length ${expectedPathLength}`);
    }
    body.path_prose.forEach((item, i) => {
      if (!item || typeof item !== 'object') {
        errors.push(`path_prose[${i}] must be an object`);
        return;
      }
      const expectedRoman = ROMAN[i];
      if (item.step_id !== expectedRoman) {
        errors.push(`path_prose[${i}].step_id "${item.step_id}" != expected "${expectedRoman}"`);
      }
      if (typeof item.prose !== 'string' || item.prose.length < 20) {
        errors.push(`path_prose[${i}].prose must be string >=20 chars`);
      }
    });
  }

  return errors;
}

async function generateLessonBody({ plan, goalContract, audience, learnerState, model = 'glm-5.1', maxRetries = 1 } = {}) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.path)) {
    throw new LLMProviderError('valid plan with path array is required');
  }
  if (!goalContract || typeof goalContract !== 'object') {
    throw new LLMProviderError('goalContract object is required');
  }

  const provider = getProvider();
  const userMessage = buildBodyUserMessage({ plan, goalContract, audience, learnerState });

  let messages = [
    { role: 'system', content: BODY_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await provider.chat({
      messages,
      model,
      json: true,
      temperature: 0.7,
      maxTokens: 2000,
      timeoutMs: 90_000,
    });

    const errors = validateBody(result, plan.path.length);
    if (errors.length === 0) {
      try {
        const j = jargonFirewall.checkJargon(JSON.stringify(result));
        if (!j.passed) {
          console.warn('[jargon-firewall] %d violation(s) in body:', j.violations.length, j.violations);
        }
      } catch (_) { /* monitor-only */ }
      return { body: result };
    }

    if (attempt < maxRetries) {
      const errorList = errors.map(e => '  - ' + e).join('\n');
      messages = [
        ...messages,
        { role: 'assistant', content: JSON.stringify(result) },
        { role: 'user', content: `Body validation failed:\n${errorList}\n\nRegenerate strictly per the SCHEMA + STRUCTURE RULES.` },
      ];
      continue;
    }

    throw new LLMProviderError(`Lesson body failed schema validation after ${maxRetries + 1} attempts: ${errors.join('; ')}`);
  }
}

module.exports = {
  generatePlan,
  generateLessonBody,
  validatePlan,
  validateBody,
  validateEvidenceLedger,
  REQUIRED_TOP_KEYS,
  EVIDENCE_TYPES,
  HARD_EVIDENCE_TYPES,
  CONFIDENCE_LEVELS,
  VERIFIABILITY_LEVELS,
  RISK_LEVELS,
  EVIDENCE_LEDGER_SCHEMA_DESCRIPTION,
};
