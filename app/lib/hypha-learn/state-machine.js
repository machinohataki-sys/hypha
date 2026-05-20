'use strict';

// Hypha Learn — pedagogy state machine.
//
// Replaces silent P1-P5 move-selection with EXPLICIT state declaration. The
// model emits `<!--state:NAME-->` (and optionally `<!--next:NAME-->`) markers
// in its turn output. Transitions are content-driven — a student response
// outcome (hit / miss / partial / landed / linked / done) advances the state,
// never wall-clock time.
//
// Marker regex mirrors agent.js METHOD_TAG_RE (line ~1483) — same `<!--K:V-->`
// shape, whitespace-tolerant + case-insensitive on the value.
//
// Pure functions only. No I/O. No async. CommonJS for Electron main.

const STATES = Object.freeze({
  HOOK: 'HOOK',
  EXPOSE: 'EXPOSE',
  EXPOSE_PRIME: 'EXPOSE_PRIME',
  VERIFY: 'VERIFY',
  // 2026-05-19 v0.4.5 — APPLY = Feynman transfer-test state. VERIFY hit
  // routes here FIRST (not directly to EXTEND) — student must apply concept
  // to a new case from lesson body's transfer_cases array before lesson
  // advances. Prevents "surface recognition counted as understanding".
  APPLY: 'APPLY',
  EXTEND: 'EXTEND',
  CONNECT: 'CONNECT',
  LATCH: 'LATCH',
  END: 'END',
});

const STATE_LABELS = Object.freeze({
  HOOK:         '— 引子 —',
  EXPOSE:       '— 探查 —',
  EXPOSE_PRIME: '— 再探 —',
  VERIFY:       '— 校核 —',
  APPLY:        '— 应用 —',
  EXTEND:       '— 延展 —',
  CONNECT:      '— 串联 —',
  LATCH:        '— 收纳 —',
  END:          '',
});

const TRANSITIONS = Object.freeze({
  HOOK:         { always: 'EXPOSE' },
  EXPOSE:       { always: 'VERIFY' },
  EXPOSE_PRIME: { always: 'VERIFY' },
  // v0.4.5 — VERIFY hit → APPLY (NOT EXTEND directly). APPLY-skipping is a
  // pacing violation per user 2026-05-19 lock. The pacing validator below
  // catches transcripts where VERIFY → EXTEND with no APPLY between.
  VERIFY:       { hit: 'APPLY', miss: 'EXPOSE_PRIME', partial: 'VERIFY' },
  APPLY:        { transfer_hit: 'EXTEND', transfer_miss: 'EXPOSE_PRIME', partial: 'APPLY' },
  EXTEND:       { landed: 'CONNECT' },
  CONNECT:      { linked: 'LATCH' },
  LATCH:        { done: 'END' },
  END:          {},
});

// Whitespace-tolerant, case-insensitive on the state name. Global flag so we
// can scan for the LAST occurrence (the model may quote prior-state references
// mid-text; only the trailing declaration is authoritative).
const STATE_TAG_RE  = /<!--\s*state\s*:\s*([A-Za-z_]+)\s*-->/gi;
const NEXT_TAG_RE   = /<!--\s*next\s*:\s*([A-Za-z_]+)\s*-->/gi;
const STRIP_TAG_RE  = /<!--\s*(?:state|next)\s*:\s*[A-Za-z_]+\s*-->/gi;

function _normalize(name) {
  if (!name || typeof name !== 'string') return null;
  const upper = name.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(STATES, upper) ? upper : null;
}

function _findLast(text, re) {
  if (!text || typeof text !== 'string') return null;
  re.lastIndex = 0;
  let last = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    last = m[1];
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return last;
}

function initialState() {
  return STATES.HOOK;
}

function parseStateMarker(text) {
  const rawState = _findLast(text, STATE_TAG_RE);
  const rawNext  = _findLast(text, NEXT_TAG_RE);
  return {
    state: _normalize(rawState),
    next:  _normalize(rawNext),
    raw: { state: rawState, next: rawNext },
  };
}

function stripStateMarkers(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(STRIP_TAG_RE, '');
}

function validateTransition(from, to, trigger) {
  if (!from || !to || !trigger) return false;
  const row = TRANSITIONS[from];
  if (!row) return false;
  return row[trigger] === to;
}

function nextState(from, trigger) {
  if (!from || !trigger) return null;
  const row = TRANSITIONS[from];
  if (!row) return null;
  return row[trigger] || null;
}

function formatStateTag(state) {
  if (!state) return '';
  return STATE_LABELS[state] || '';
}

/**
 * v0.4.5 (2026-05-19) — Pacing violation detector. Scans state history for
 * v0.4.5 rule infractions:
 *   1. VERIFY→EXTEND skip-APPLY (transfer-test bypassed = surface VERIFY counted as deep)
 *   2. APPLY count > 3 in single lesson (infinite ping-pong)
 *   3. Total state-transition count < 8 (lesson < 25-min target, "死板速通")
 *
 * @param {Array<string>} stateHistory  — chronological list of state names emitted
 * @param {object} [opts]
 * @param {number} [opts.minTransitions=8]  — floor for "real lesson" length
 * @returns {{ ok: boolean, violations: Array<{type, msg, turn}>, summary: object }}
 */
function detectPacingViolations(stateHistory, opts = {}) {
  const minTransitions = typeof opts.minTransitions === 'number' ? opts.minTransitions : 8;
  if (!Array.isArray(stateHistory)) {
    return { ok: false, violations: [{ type: 'INVALID_INPUT', msg: 'stateHistory must be array', turn: -1 }], summary: {} };
  }
  const violations = [];
  let applyCount = 0;
  for (let i = 1; i < stateHistory.length; i++) {
    const prev = _normalize(stateHistory[i - 1]);
    const curr = _normalize(stateHistory[i]);
    // Rule 1: VERIFY→EXTEND skip APPLY
    if (prev === 'VERIFY' && curr === 'EXTEND') {
      violations.push({
        type: 'VERIFY_TO_EXTEND_SKIP_APPLY',
        msg: 'v0.4.5 spec: VERIFY hit should route APPLY (transfer-test) before EXTEND. Surface VERIFY = recognition, not understanding.',
        turn: i,
      });
    }
    if (curr === 'APPLY') applyCount++;
  }
  // Rule 2: APPLY count > 3
  if (applyCount > 3) {
    violations.push({
      type: 'APPLY_COUNT_EXCEEDED',
      msg: `APPLY fired ${applyCount}× — v0.4.5 ceiling is 3. Accept partial transfer and advance to EXTEND.`,
      turn: -1,
    });
  }
  // Rule 3: total transitions < floor (lesson too short)
  if (stateHistory.length > 0 && stateHistory.length < minTransitions) {
    violations.push({
      type: 'LESSON_TOO_SHORT',
      msg: `lesson had ${stateHistory.length} state transitions (< ${minTransitions} floor). User 2026-05-19 lock: 25-30 min in-session = ~12-18 transitions. "死板速通" = failure mode.`,
      turn: -1,
    });
  }
  return {
    ok: violations.length === 0,
    violations,
    summary: {
      total_transitions: stateHistory.length,
      apply_count: applyCount,
      ended_at: stateHistory[stateHistory.length - 1] || null,
    },
  };
}

module.exports = {
  STATES,
  STATE_LABELS,
  TRANSITIONS,
  initialState,
  parseStateMarker,
  stripStateMarkers,
  validateTransition,
  nextState,
  formatStateTag,
  detectPacingViolations,
};
