'use strict';

// Hypha Lacquer Loop runtime — Layer 2 substrate (A1 cure-clock + A2 prediction-log).
// See app/lib/pedagogy.md. Operates over state.concepts (per-curriculum state.json).
// A3 controller-state fields are RESERVED but DORMANT until W4 pilot validates A1+A2.

const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_CURE_MS = DAY_MS;
const SUCCESS_FACTOR = 2.5;          // FSRS-lite: success extends cure window
const FAILURE_FACTOR = 0.5;          // failure cuts in half
const MIN_CURE_MS = DAY_MS / 6;      // 4h floor
const MAX_CURE_MS = 90 * DAY_MS;     // 90d ceiling
const REVISIT_GAP_MIN = 5;           // lesson must be ≥5 idx after concept to count as revisit
const PREDICTION_LOG_CAP = 50;       // keep last 50 entries per concept

function initConcepts(state) {
  if (!state || typeof state !== 'object') return state;
  if (!state.concepts) state.concepts = {};
  return state;
}

function _ensureConcept(state, conceptId) {
  initConcepts(state);
  const k = String(conceptId);
  if (!state.concepts[k]) {
    state.concepts[k] = {
      last_layer_at: 0,
      cure_window_ms: 0,
      layer_count: 0,
      half_life_estimate_ms: INITIAL_CURE_MS,
      prediction_log: [],
      controller: 'LEARNER',     // A3 reserved
      strike_count: 0,           // A3 reserved
      last_strike_at: 0,         // A3 reserved
    };
  }
  return state.concepts[k];
}

// A1 cure-clock: call after a re-exposure of a concept. success=true extends
// the cure window multiplicatively; success=false cuts it in half.
function touchConcept(state, conceptId, success, ts) {
  const c = _ensureConcept(state, conceptId);
  const now = typeof ts === 'number' ? ts : Date.now();
  c.last_layer_at = now;
  c.layer_count += 1;
  if (c.cure_window_ms === 0) {
    c.cure_window_ms = INITIAL_CURE_MS;
  } else {
    const factor = success ? SUCCESS_FACTOR : FAILURE_FACTOR;
    const next = Math.round(c.cure_window_ms * factor);
    c.cure_window_ms = Math.min(MAX_CURE_MS, Math.max(MIN_CURE_MS, next));
  }
  c.half_life_estimate_ms = c.cure_window_ms;
  return c;
}

// A2 prediction-log: append predict→actual mismatch with caller-judged delta_norm
// (0..1; 0 = perfect match, 1 = orthogonal / opposite).
function recordPrediction(state, conceptId, predicted, actual, delta_norm, lesson_id, ts) {
  const c = _ensureConcept(state, conceptId);
  c.prediction_log.push({
    ts: typeof ts === 'number' ? ts : Date.now(),
    predicted: String(predicted || '').slice(0, 500),
    actual: String(actual || '').slice(0, 500),
    delta_norm: Math.max(0, Math.min(1, Number(delta_norm) || 0)),
    lesson_id: typeof lesson_id === 'number' ? lesson_id : null,
  });
  if (c.prediction_log.length > PREDICTION_LOG_CAP) {
    c.prediction_log = c.prediction_log.slice(-PREDICTION_LOG_CAP);
  }
  return c;
}

function isReady(state, conceptId, now) {
  initConcepts(state);
  const c = state.concepts[String(conceptId)];
  if (!c || c.layer_count === 0) return true;
  const t = typeof now === 'number' ? now : Date.now();
  return t >= c.last_layer_at + c.cure_window_ms;
}

// scheduleNextLesson — picks next lesson idx.
// Default forward path: lastIdx + 1.
// If any previously-touched concept is OVERDUE AND a downstream revisit lesson
// exists (prereqIds includes the overdue concept AND lesson.idx > concept.id + REVISIT_GAP_MIN),
// prefer that revisit. Returns { idx, mode, revisitOf? }.
function scheduleNextLesson(state, sequence, now) {
  initConcepts(state);
  const t = typeof now === 'number' ? now : Date.now();
  const lastIdx = typeof state.lastIdx === 'number' ? state.lastIdx : -1;
  const seq = Array.isArray(sequence) ? sequence : [];
  const nextForward = lastIdx + 1;

  const overdue = Object.entries(state.concepts || {})
    .filter(([_, c]) => c.layer_count > 0 && t >= c.last_layer_at + c.cure_window_ms)
    .map(([id, c]) => ({ id: Number(id), overdue_by_ms: t - (c.last_layer_at + c.cure_window_ms) }))
    .sort((a, b) => b.overdue_by_ms - a.overdue_by_ms);

  for (const od of overdue) {
    const revisit = seq.find(l =>
      typeof l.idx === 'number' &&
      l.idx > lastIdx &&
      l.idx > od.id + REVISIT_GAP_MIN &&
      Array.isArray(l.prereqIds) &&
      l.prereqIds.includes(od.id)
    );
    if (revisit) return { idx: revisit.idx, mode: 'revisit', revisitOf: od.id };
  }

  if (nextForward < seq.length) return { idx: nextForward, mode: 'forward' };
  return { idx: -1, mode: 'forward' };
}

module.exports = {
  initConcepts,
  touchConcept,
  recordPrediction,
  isReady,
  scheduleNextLesson,
  _constants: { DAY_MS, INITIAL_CURE_MS, SUCCESS_FACTOR, FAILURE_FACTOR, MIN_CURE_MS, MAX_CURE_MS, REVISIT_GAP_MIN, PREDICTION_LOG_CAP },
};
