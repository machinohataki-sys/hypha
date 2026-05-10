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
  EXTEND:       '— 延展 —',
  CONNECT:      '— 串联 —',
  LATCH:        '— 收纳 —',
  END:          '',
});

const TRANSITIONS = Object.freeze({
  HOOK:         { always: 'EXPOSE' },
  EXPOSE:       { always: 'VERIFY' },
  EXPOSE_PRIME: { always: 'VERIFY' },
  VERIFY:       { hit: 'EXTEND', miss: 'EXPOSE_PRIME', partial: 'VERIFY' },
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
};
