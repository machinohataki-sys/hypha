'use strict';

// HYPHA · W3.6 Companion History — dedupe + fire ledger.
//
// Per-curriculum sidecar at `vault/<slug>/companion-fired.json`. Schema:
//
//   version: 1
//   fires: array of { type, key, ts (ISO), meta? }
//
// Example: type='lesson_complete' key='0' ts='2026-05-13T10:22:11.000Z'
// records one fire of the lesson_complete trigger against lessonIdx=0.
// type='interrupt_resume' key='2026-05-13' records a day-keyed fire so
// repeated interrupt detections inside the same calendar day collapse.
//
// Why a flat array (not nested map): cheaper to append, easier to read.
// We bound the array (HISTORY_MAX) so a long-running curriculum doesn't
// explode the file. Older entries fall off FIFO. Dedupe lookup is O(n)
// over the bounded array; n stays small (≤ HISTORY_MAX).
//
// The dedupe key shape is per-trigger:
//   - lesson_complete       → String(lessonIdx)        — one fire per lesson
//   - interrupt_resume      → "YYYY-MM-DD" of resume   — one fire per day
//   - over_grind            → "YYYY-MM-DD" of detect   — one fire per day
//   - finish_capture        → sessionId                — one fire per session
//   - product_spark_sprout  → sparkId                  — one fire per spark
//
// Surgical: this module owns only the on-disk record + the wasFired/recordFired
// pair. Detection is in companion-triggers.js. Expression is W3.5 engine.

const fs = require('fs');
const path = require('path');

const VAULT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..', 'vault');
function vaultRoot() {
  return process.env.HYPHA_VAULT_ROOT || VAULT_ROOT_DEFAULT;
}

const HISTORY_MAX = 200;     // cap fires per curriculum
const HISTORY_VERSION = 1;

const TRIGGER_TYPES = Object.freeze([
  'lesson_complete',
  'interrupt_resume',
  'over_grind',
  'finish_capture',
  'product_spark_sprout',
]);

function _historyPath(slug) {
  if (!slug || typeof slug !== 'string') {
    throw Object.assign(new Error('slug required'), { code: 'BAD_SLUG' });
  }
  return path.join(vaultRoot(), slug, 'companion-fired.json');
}

function _readSafe(slug) {
  const p = _historyPath(slug);
  if (!fs.existsSync(p)) return { version: HISTORY_VERSION, fires: [] };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.fires)) {
      return { version: HISTORY_VERSION, fires: [] };
    }
    return { version: parsed.version || HISTORY_VERSION, fires: parsed.fires };
  } catch (_) {
    // Corrupt file — never crash the trigger pipeline. Start fresh.
    return { version: HISTORY_VERSION, fires: [] };
  }
}

function _writeSafe(slug, state) {
  const p = _historyPath(slug);
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Immutable update — never mutate caller's state.
    const next = {
      version: state.version || HISTORY_VERSION,
      fires: state.fires.slice(-HISTORY_MAX),
    };
    fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch (_) {
    // Sidecar write failure is non-fatal. Companion expression already
    // happened; the worst case is a re-fire on the next event, which the
    // tone-engine boundary guard rate-limits anyway.
    return false;
  }
}

/**
 * Returns true iff a fire matching (triggerType, key) already exists in the
 * curriculum's history. Pure read; no side effects.
 * @param {string} slug
 * @param {string} triggerType
 * @param {string} key
 * @returns {boolean}
 */
function wasFired(slug, triggerType, key) {
  if (!slug || !triggerType || key == null) return false;
  if (!TRIGGER_TYPES.includes(triggerType)) return false;
  const state = _readSafe(slug);
  const k = String(key);
  for (const f of state.fires) {
    if (f.type === triggerType && f.key === k) return true;
  }
  return false;
}

/**
 * Persist a fire record. Returns the new entry. Caller decides whether to
 * record-then-dispatch or dispatch-then-record. We record FIRST so a crash
 * mid-dispatch can't double-fire on retry.
 * @param {string} slug
 * @param {string} triggerType
 * @param {string} key
 * @param {object} [meta]
 * @returns {{ type: string, key: string, ts: string, meta?: object } | null}
 */
function recordFired(slug, triggerType, key, meta) {
  if (!slug || !triggerType || key == null) return null;
  if (!TRIGGER_TYPES.includes(triggerType)) return null;
  const state = _readSafe(slug);
  const entry = {
    type: triggerType,
    key: String(key),
    ts: new Date().toISOString(),
  };
  if (meta && typeof meta === 'object') entry.meta = meta;
  const next = { ...state, fires: [...state.fires, entry] };
  _writeSafe(slug, next);
  return entry;
}

/**
 * Read the most recent N fires for a curriculum. Reverse-chronological.
 * @param {string} slug
 * @param {number} [limit=20]
 * @returns {Array<{type,key,ts,meta?}>}
 */
function listHistory(slug, limit = 20) {
  if (!slug) return [];
  const state = _readSafe(slug);
  const n = Math.max(1, Math.min(HISTORY_MAX, Number(limit) || 20));
  return state.fires.slice(-n).reverse();
}

/**
 * Clear all fires (debug only — not exposed via UI by default).
 */
function clearHistory(slug) {
  if (!slug) return false;
  return _writeSafe(slug, { version: HISTORY_VERSION, fires: [] });
}

module.exports = {
  wasFired,
  recordFired,
  listHistory,
  clearHistory,
  HISTORY_MAX,
  HISTORY_VERSION,
  TRIGGER_TYPES,
};
