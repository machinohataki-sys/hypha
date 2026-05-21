'use strict';
// HYPHA · W3.5 Companion Layer — Boundary Guard.
//
// Last-mile veto on every Myco expression. tone-engine.js produces text;
// boundary-guard decides whether the text reaches the user, and how.
//
// Hard rules (BLUEPRINT §16.4 + Companion Boundary Guard):
//   1. settings.companionEnabled === false → silent (null).
//   2. context.lessonInProgress === true → silent (don't steal Professor
//      Agent's main line).
//   3. session turn count >= contract.max_turns_per_session → silent.
//   4. now - lastExpressionAt < contract.min_silence_seconds → silent.
//   5. text length > contract.max_response_chars → truncate at last full
//      sentence boundary before the cap, falling back to hard slice.
//   6. forbidden pattern hit → reject (caller's regen attempt is upstream
//      in tone-engine.generateValid; once here we don't re-call the model).
//
// Returned envelope:
//   { allowed: true,  censored: <string>, severity?: 'soft' }     // safe to emit
//   { allowed: false, reason: <string>, censored: null, severity: 'soft'|'firm'|'hard' }
//
// Severity ladder (AMD-MEOW-P8, 2026-05-20):
//   soft = passive silence (cooldown / turn budget / empty input).
//          channel still healthy; next eligible trigger may fire normally.
//   firm = channel-conflict silence (lesson_in_progress / settings_disabled).
//          companion withholds because a higher-priority surface is active.
//   hard = contract breach (forbidden / exclamation / emoji).
//          regen exhausted; treat as content failure, not state.
// Callers (tone-engine.generateValid / index.companionRespond) may use
// severity to decide whether to retry, escalate cooldown, or log.
// Allowed responses carry severity only when they were truncated ('soft').
//
// Companion state is per-session. Caller owns the session record (typically
// W3.6 wires this into renderer state) and passes it via `state`. We do not
// reach into vault — keeps the guard a pure function.

const { loadContract } = require('./tone-engine');
const { KEYWORD_MAPPING } = require('./keyword-mapping');

/**
 * @typedef {object} CompanionState
 * @property {number} turns_used         — how many expressions already shown this session
 * @property {number} [last_expression_at] — epoch ms of last emission
 *
 * @typedef {object} CompanionContext
 * @property {boolean} [settingsEnabled]   — settings.companion?.enabled
 * @property {boolean} [lessonInProgress]  — lesson state machine is mid-turn
 * @property {CompanionState} [state]      — per-session counters
 * @property {number} [nowMs]              — clock injection for tests
 */

function _findForbiddenHit(text, contract) {
  for (const group of (contract.forbidden || [])) {
    const patterns = Array.isArray(group.patterns) ? group.patterns : [];
    for (const p of patterns) {
      if (typeof p === 'string' && p && text.includes(p)) {
        return { group: group.name || 'forbidden', pattern: p };
      }
    }
  }
  return null;
}

function _truncate(text, max) {
  if (text.length <= max) return text;
  // Prefer cutting at a sentence terminator (. 。 ! ! 不应出现, 但保险) before max.
  const window = text.slice(0, max);
  const lastTerm = Math.max(window.lastIndexOf('.'), window.lastIndexOf('。'));
  if (lastTerm > max * 0.4) {
    return window.slice(0, lastTerm + 1);
  }
  return window;
}

/**
 * Decide whether an expression is allowed.
 *
 * @param {string} expression
 * @param {CompanionContext} [context]
 * @returns {{ allowed: boolean, reason?: string, censored: string|null }}
 */
function enforceBoundary(expression, context = {}) {
  const contract = loadContract();

  if (typeof expression !== 'string' || !expression.trim()) {
    return { allowed: false, reason: 'empty', severity: 'soft', censored: null };
  }

  if (context.settingsEnabled === false) {
    return { allowed: false, reason: 'settings_disabled', severity: 'firm', censored: null };
  }

  if (context.lessonInProgress === true) {
    return { allowed: false, reason: 'lesson_in_progress', severity: 'firm', censored: null };
  }

  const state = context.state || { turns_used: 0 };
  const maxTurns = contract.max_turns_per_session || 5;
  if ((state.turns_used || 0) >= maxTurns) {
    return { allowed: false, reason: 'turn_budget_exhausted', severity: 'soft', censored: null };
  }

  const minSilenceMs = (contract.min_silence_seconds || 0) * 1000;
  if (state.last_expression_at && minSilenceMs > 0) {
    const now = context.nowMs || Date.now();
    if (now - state.last_expression_at < minSilenceMs) {
      return { allowed: false, reason: 'cooldown', severity: 'soft', censored: null };
    }
  }

  const hit = _findForbiddenHit(expression, contract);
  if (hit) {
    return {
      allowed: false,
      reason: `forbidden:${hit.group}:${hit.pattern}`,
      severity: 'hard',
      censored: null,
    };
  }

  // Voice clamp lexical checks (mirrors tone-engine.validateExpression but
  // we re-check here so a hand-injected expression — e.g. dev console —
  // can't bypass).
  if (expression.includes('!') || expression.includes('！')) {
    return { allowed: false, reason: 'forbidden:exclamation', severity: 'hard', censored: null };
  }

  const maxChars = contract.max_response_chars || 80;
  const censored = _truncate(expression, maxChars);
  const truncated = censored.length < expression.length;
  return truncated
    ? { allowed: true, censored, severity: 'soft' }
    : { allowed: true, censored };
}

/**
 * Look up the Myco-language term for a HYPHA concept.
 *
 * @param {string} hyphaTerm — case-insensitive English HYPHA name (e.g. "Note", "Lesson")
 * @returns {string|null}
 */
function getKeywordMapping(hyphaTerm) {
  if (typeof hyphaTerm !== 'string') return null;
  const key = hyphaTerm.trim().toLowerCase();
  for (const entry of KEYWORD_MAPPING) {
    if (entry.hypha.toLowerCase() === key) return entry.myco;
  }
  return null;
}

module.exports = {
  enforceBoundary,
  getKeywordMapping,
  // Exposed for tests.
  _truncate,
  _findForbiddenHit,
};
