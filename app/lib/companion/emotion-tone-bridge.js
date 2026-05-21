'use strict';
// Companion emotion-tone bridge — compose W3.5 trigger schema with emotion-state.
// Pure ADDITIVE: does NOT modify tone-engine.js or emotion-state.js.
// Both source modules remain authoritative for their domains.
//
// W3.5 = event-driven trigger schema (6 triggers, deterministic templates).
// emotion-state = rolling classifier (5 states from session signals).
// Bridge = compose the two so tone register can be biased / suppressed /
//          escalated by current emotion-state when a trigger fires.
//
// Asymmetric coupling intentional: emotion-state never depends on the bridge;
// tone-engine never depends on the bridge; the bridge depends on both via
// require. If either source module changes signature, this bridge degrades
// gracefully (silent-tolerate around tone-engine call only — emotion-state
// is a hard dep because suppression / escalation rules key on its STATES).

const emotionState = require('./emotion-state');

// Lazy-require to tolerate test environments where contract.yaml might not
// be loadable. tone-engine's module top-level does not read the file (the
// YAML is read inside loadContract() at call time), but we still keep the
// dep lazy so a future module-top-level side-effect cannot break us.
let _toneEngine;
function getToneEngine() {
  if (_toneEngine !== undefined) return _toneEngine;
  try {
    _toneEngine = require('./tone-engine');
  } catch (_err) {
    _toneEngine = null;
  }
  return _toneEngine;
}

// Emotion-state → tone register bias.
// `register` is a coarse vocabulary hint the tone-engine (or future Gemma
// prompt) can use to shade template pick. `urgency` ∈ [0, 1] reflects how
// load-bearing the emotion signal is — 0 = ignore, 1 = override default.
const EMOTION_BIAS = Object.freeze({
  [emotionState.STATES.IDLE]:             { register: 'neutral',    urgency: 0 },
  [emotionState.STATES.CURIOUS]:          { register: 'open',       urgency: 0.3 },
  [emotionState.STATES.ENCOURAGING]:      { register: 'soft',       urgency: 0.4 },
  [emotionState.STATES.MIRROR]:           { register: 'paraphrase', urgency: 0.5 },
  [emotionState.STATES.BOUNDARY_PROTECT]: { register: 'restraint',  urgency: 0.8 },
});

// Trigger × emotion suppression matrix.
// If user is already over-engaged (BOUNDARY_PROTECT), a positive trigger
// like lesson_complete worsens the over-engagement — suppress it.
// over_grind is the boundary signal itself, so it is NEVER suppressed.
// interrupt_resume is low-stakes (user just resumed) — never suppressed.
const SUPPRESSION_RULES = Object.freeze({
  lesson_complete:      new Set([emotionState.STATES.BOUNDARY_PROTECT]),
  product_spark_sprout: new Set([emotionState.STATES.BOUNDARY_PROTECT]),
  // finish_capture / note_revival / over_grind / interrupt_resume → no suppression
});

// Trigger × emotion escalation matrix.
// Same input trigger fires under a different effective trigger when the
// emotion signal warrants escalation. e.g. interrupt_resume during
// BOUNDARY_PROTECT means the user came back already over-engaged → fire the
// over_grind register, not the welcoming-back register.
const ESCALATION_RULES = Object.freeze({
  interrupt_resume: Object.freeze({
    [emotionState.STATES.BOUNDARY_PROTECT]: 'over_grind',
  }),
});

/**
 * Pure check: should this trigger be suppressed given the current emotion?
 * @param {string} trigger
 * @param {string} currentEmotion
 * @returns {boolean}
 */
function shouldSuppress(trigger, currentEmotion) {
  if (!trigger || !currentEmotion) return false;
  const suppressSet = SUPPRESSION_RULES[trigger];
  return !!(suppressSet && suppressSet.has(currentEmotion));
}

/**
 * Pure resolution: which trigger should actually fire?
 * @param {string} trigger
 * @param {string} currentEmotion
 * @returns {string} original trigger if no escalation matches, else escalated trigger
 */
function resolveEffectiveTrigger(trigger, currentEmotion) {
  if (!trigger || !currentEmotion) return trigger;
  const escalation = ESCALATION_RULES[trigger];
  if (escalation && escalation[currentEmotion]) return escalation[currentEmotion];
  return trigger;
}

/**
 * Return the bias object for an emotion. Unknown emotion falls back to IDLE.
 * @param {string} emotion
 * @returns {{register: string, urgency: number}}
 */
function biasForEmotion(emotion) {
  return EMOTION_BIAS[emotion] || EMOTION_BIAS[emotionState.STATES.IDLE];
}

/**
 * Main composition API.
 *
 * Given a W3.5 trigger event + current session context, return a verdict:
 *   - `suppressed=true`  → caller emits nothing.
 *   - `suppressed=false` → caller may render `expression` (if non-null) or
 *                          invoke tone-engine directly with `effective_trigger`.
 *
 * Async because tone-engine.generateExpression is async (post-v0 Gemma 3 4B
 * Ollama call); making the bridge sync would force callers to drop the
 * `expression` field on the floor.
 *
 * @param {object} args
 * @param {string} args.trigger — one of W3.5 trigger names
 * @param {object} [args.sessionContext]
 * @param {string} [args.sessionContext.currentText]
 * @param {string[]} [args.sessionContext.recentQuestions]
 * @param {number} [args.sessionContext.turnCount]
 * @returns {Promise<{
 *   ok: boolean,
 *   suppressed?: boolean,
 *   effective_trigger?: string|null,
 *   emotion?: string,
 *   emotion_signal?: string|null,
 *   bias?: {register: string, urgency: number},
 *   expression?: string|null,
 *   reason?: string,
 *   error?: string,
 * }>}
 */
async function composeExpression({ trigger, sessionContext = {} } = {}) {
  if (!trigger || typeof trigger !== 'string') {
    return { ok: false, error: 'MISSING_TRIGGER' };
  }
  // Detect current emotion-state from session context.
  const detection = emotionState.detectEmotionState({
    currentText: sessionContext.currentText || '',
    recentQuestions: sessionContext.recentQuestions || [],
    sessionTurnCount: sessionContext.turnCount || 0,
  });
  // Apply suppression rule.
  if (shouldSuppress(trigger, detection.state)) {
    return {
      ok: true,
      suppressed: true,
      effective_trigger: null,
      emotion: detection.state,
      emotion_signal: detection.signal || null,
      reason: 'TRIGGER_SUPPRESSED_BY_EMOTION',
    };
  }
  // Apply escalation rule (no-op if no match).
  const effective = resolveEffectiveTrigger(trigger, detection.state);
  const bias = biasForEmotion(detection.state);
  // Try to invoke tone-engine for actual expression text. Silent-tolerate
  // any signature drift or unsupported escalated trigger — the bridge's
  // contract is the verdict object, not the expression text.
  const te = getToneEngine();
  let expression = null;
  if (te && typeof te.generateExpression === 'function') {
    try {
      expression = await te.generateExpression(effective, {
        emotion: detection.state,
        bias,
        ...sessionContext,
      });
    } catch (_err) {
      expression = null;
    }
  }
  return {
    ok: true,
    suppressed: false,
    effective_trigger: effective,
    emotion: detection.state,
    emotion_signal: detection.signal || null,
    bias,
    expression,
  };
}

module.exports = {
  EMOTION_BIAS,
  SUPPRESSION_RULES,
  ESCALATION_RULES,
  shouldSuppress,
  resolveEffectiveTrigger,
  biasForEmotion,
  composeExpression,
};
