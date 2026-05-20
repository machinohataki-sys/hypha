'use strict';

/**
 * HYPHA · Anti-Illusion Gate v0 — next-lesson interceptor.
 *
 * Per BLUEPRINT v0.4 §7.3 + §8.1 Cadence: after a user finishes a lesson
 * (clicks "next lesson"), we evaluate whether their exit_proof answer +
 * trace betrays one of the 6 illusion types. If yes, we BLOCK the jump
 * to the next lesson and surface a 30-second micro-task instead.
 *
 * Boundary discipline (do NOT widen scope):
 *   - Gate ONLY controls next-lesson navigation. It does NOT
 *     - rewrite lesson body              → that's W1.2 Anti-Generic
 *     - change cadence / rest / review   → that's W2.1 Cadence Engine
 *     - inject misconception correction  → that's W1.4 Misconception
 *     - touch streamTurn / scoreMicroProof
 *   - Gate emits an event + returns a structured decision. Renderer owns
 *     the UI block.
 *
 * intentional-placeholder: T4_JUDGE LLM call for micro_task prompt
 * generation is stubbed with a deterministic template — wire to real
 * `llm.executeChat('T4_JUDGE', ...)` in W1.3.1 once the prompt spec lands.
 */

const { detectIllusion } = require('./anti-illusion');

/**
 * @typedef {object} CurrentLessonState
 * @property {object} [lessonKP] — body of the just-finished lesson
 * @property {string} [exitProof]
 * @property {string} [userExitProofAnswer] — what the user typed for exit_proof
 * @property {number} [responseTimeMs]
 *
 * @typedef {object} UserTrace
 * @property {Array<object>} [actionLog] — entries from prior lessons
 * @property {Array<{role:string,text:string}>} [priorResponses]
 *
 * @typedef {'micro_transfer_task'|'misconception_repair'|'product_transfer_drill'|'request_action_log'} InterventionType
 *
 * @typedef {object} MicroTask
 * @property {string} id
 * @property {InterventionType} type
 * @property {string} prompt
 * @property {'text'|'choice'} expected_format
 * @property {number} timeout_sec
 *
 * @typedef {object} GateResult
 * @property {boolean} allowed — true means "next lesson allowed"
 * @property {string|null} reason — short tag, e.g. 'ai_mimicry'
 * @property {InterventionType|null} required_action
 * @property {MicroTask|null} micro_task
 * @property {object} [detection] — raw detection result for telemetry
 */

const GATE_BLOCK_CONFIDENCE = 0.70;

// -----------------------------------------------------------------------------
// Micro-task template synthesis
// -----------------------------------------------------------------------------

const _uniq = () => {
  // Short collision-resistant id; avoids crypto.randomUUID dep on older Node.
  return 'mt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
};

/**
 * Build a 30-second micro-task from the detection. The prompt comes from a
 * deterministic template keyed on intervention type — good enough to block
 * the gate today; W1.3.1 swaps in T4_JUDGE LLM-authored prompts.
 *
 * @param {InterventionType} intervention
 * @param {object} lessonKP
 * @returns {MicroTask}
 */
function buildMicroTask(intervention, lessonKP) {
  const thesis = (lessonKP && typeof lessonKP.thesis === 'string') ? lessonKP.thesis.trim() : '';
  const canonical = (lessonKP && typeof lessonKP.canonical_example === 'string') ? lessonKP.canonical_example.trim() : '';
  const mechanism = (lessonKP && typeof lessonKP.mechanism_explanation === 'string') ? lessonKP.mechanism_explanation.trim() : '';
  const anchor = thesis || canonical.slice(0, 80) || '本节核心机制';

  // intentional-placeholder: each branch returns a static-template prompt
  // pending T4_JUDGE LLM authoring in W1.3.1. Templates are intentionally
  // short + verb-led so they read like 千金 register, not boilerplate.
  switch (intervention) {
    case 'micro_transfer_task':
      return {
        id: _uniq(),
        type: 'micro_transfer_task',
        prompt: `把刚才学到的"${anchor.slice(0, 40)}"用到一个全新场景 (不要重复课上的例子). 写 1-3 句, 必须有时间地点或具体对象.`,
        expected_format: 'text',
        timeout_sec: 30,
      };
    case 'misconception_repair':
      // Stub — when W1.4 ships, this branch should route to W1.4's UI surface.
      // For now we still return a micro_task shape so the gate UI doesn't break.
      return {
        id: _uniq(),
        type: 'misconception_repair',
        prompt: `用一句话说出本节最容易被搞错的地方, 以及正确的判断是什么. ${mechanism ? '提示: 联系机制是 — ' + mechanism.slice(0, 60) : ''}`.trim(),
        expected_format: 'text',
        timeout_sec: 30,
      };
    case 'product_transfer_drill':
      // Stub — W3.3 Product Transfer ships later; until then this branch
      // returns a prose-only ask so the gate degrades gracefully.
      return {
        id: _uniq(),
        type: 'product_transfer_drill',
        prompt: `把本节学到的东西转译成你手头任何一个真实事物的一处改动 — "我会把 X 改成 Y, 因为 Z". 一句话.`,
        expected_format: 'text',
        timeout_sec: 30,
      };
    case 'request_action_log':
      return {
        id: _uniq(),
        type: 'request_action_log',
        prompt: `写一行实证: "我把 ___ 用到了 ___" (前后填具体的事). 没用过就承认没用过, 别编.`,
        expected_format: 'text',
        timeout_sec: 30,
      };
    default:
      return {
        id: _uniq(),
        type: 'micro_transfer_task',
        prompt: `用一句具体的话证明你抓住了本节的核心.`,
        expected_format: 'text',
        timeout_sec: 30,
      };
  }
}

// -----------------------------------------------------------------------------
// Public API — evalNextLessonGate
// -----------------------------------------------------------------------------

/**
 * Decide whether the user is allowed to jump to the next lesson.
 *
 * @param {CurrentLessonState} currentLessonState
 * @param {UserTrace} [userTrace]
 * @returns {GateResult}
 */
function evalNextLessonGate(currentLessonState, userTrace) {
  const state = currentLessonState && typeof currentLessonState === 'object' ? currentLessonState : {};
  const trace = userTrace && typeof userTrace === 'object' ? userTrace : {};

  const lessonKP = state.lessonKP || {};
  const exitProof = state.exitProof || (lessonKP && lessonKP.exit_proof) || '';
  const userResponse = state.userExitProofAnswer || '';
  const responseTimeMs = (typeof state.responseTimeMs === 'number') ? state.responseTimeMs : null;

  const detection = detectIllusion(userResponse, {
    lessonKP,
    exitProof,
    priorResponses: trace.priorResponses || [],
    actionLog: trace.actionLog,
    responseTimeMs,
  });

  if (!detection.illusion_detected || detection.confidence < GATE_BLOCK_CONFIDENCE) {
    return {
      allowed: true,
      reason: null,
      required_action: null,
      micro_task: null,
      detection,
    };
  }

  const microTask = buildMicroTask(detection.suggested_intervention, lessonKP);
  return {
    allowed: false,
    reason: detection.illusion_type,
    required_action: detection.suggested_intervention,
    micro_task: microTask,
    detection,
  };
}

module.exports = {
  evalNextLessonGate,
  buildMicroTask,
  GATE_BLOCK_CONFIDENCE,
};
