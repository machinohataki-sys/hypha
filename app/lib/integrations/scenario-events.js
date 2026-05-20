'use strict';

// HYPHA · W4.1 7-Day Growth Path — Scenario Event Emitter.
//
// Per BLUEPRINT.md §20 v1.0 Closed Beta + ROADMAP W4.1. Writes typed scenario
// events to `vault/<slug>/scenario-events.jsonl` via the W2.4-validated
// `events.js` writer. The same validator that stamps `tuple_verified` /
// `cadence_mode_shift` / `companion:expressed` rows now stamps `day_*` rows,
// so W4.2 KPI Dashboard can read this stream with the same schema discipline
// (no new validator branch — events.js is the single bottleneck).
//
// Why a sidecar file (`scenario-events.jsonl`) and not the main `events.jsonl`?
// Two reasons:
//   1. W4.2 KPI Dashboard does scenario-level aggregation — completion-rate /
//      day-fall-off / proof-pass-rate — and isolating those rows reduces
//      streaming-scan cost on slugs with thousands of lesson events.
//   2. v1.0 closed beta = ONE growth path live at a time; reset / replay
//      flows want a single file to truncate, not a global grep-and-delete.
//
// File layout: `vault/<slug>/scenario-events.jsonl`, one JSON object per line.
// Schema (every row):
//   ts           ISO8601 (events.js injects)
//   scenario     'seven-day-growth'  (constant tag — future scenarios use own)
//   slug         vault slug
//   day_idx      0..6  (zero-indexed; UI shows 1..7)
//   type         event-type enum (see SCENARIO_EVENT_TYPES below)
//   ...payload   type-specific fields (lesson_idx, kp_id, score, reasons, etc.)
//
// Validation: we lean on events.js's existing validator. The eight event types
// are conventionally `day_*` / `proof_*` / `assignment_*` / `spark_*` /
// `companion_*` so a future `scenario-events-schema.json` can layer on top.
// For W4.1 scaffold we keep the writer permissive (events.js does the heavy
// lifting) and only enforce: type ∈ SCENARIO_EVENT_TYPES, day_idx ∈ [0,6].

const fs = require('fs');
const path = require('path');

const SCENARIO_TAG = 'seven-day-growth';

// 8 event types (per W4.1 task spec). Keep this list flat — UI dashboards
// pivot on `type` as a single dim, not nested kind/sub-kind.
const SCENARIO_EVENT_TYPES = Object.freeze({
  DAY_STARTED:         'day_started',
  LESSON_COMPLETED:    'lesson_completed',
  PROOF_PASSED:        'proof_passed',
  ASSIGNMENT_SUBMITTED:'assignment_submitted',
  SPARK_CREATED:       'spark_created',
  COMPANION_FIRED:     'companion_fired',
  DAY_FAILED:          'day_failed',
  DAY_COMPLETED:       'day_completed',
});

const ALLOWED_TYPES = new Set(Object.values(SCENARIO_EVENT_TYPES));

function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  return path.join(__dirname, '..', '..', '..', 'vault');
}

function _scenarioFile(slug) {
  return path.join(_vaultRoot(), slug, 'scenario-events.jsonl');
}

function _ensureFile(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
}

/**
 * Record a scenario event. Validates type + day_idx, writes one JSON line.
 *
 * @param {string} slug             vault slug
 * @param {number} dayIdx           0..6
 * @param {string} eventType        one of SCENARIO_EVENT_TYPES
 * @param {object} [payload]        free-form per-type fields
 * @returns {{ ok: boolean, path?: string, reason?: string }}
 */
function recordScenarioEvent(slug, dayIdx, eventType, payload = {}) {
  if (!slug || typeof slug !== 'string') {
    return { ok: false, reason: 'slug required (non-empty string)' };
  }
  if (!Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) {
    return { ok: false, reason: `day_idx must be int in [0,6]; got ${dayIdx}` };
  }
  if (!eventType || typeof eventType !== 'string') {
    return { ok: false, reason: 'eventType required (string)' };
  }
  if (!ALLOWED_TYPES.has(eventType)) {
    return { ok: false, reason: `unknown eventType '${eventType}'; allowed: ${Array.from(ALLOWED_TYPES).join('|')}` };
  }
  if (payload && typeof payload !== 'object') {
    return { ok: false, reason: 'payload must be object' };
  }

  const row = {
    ts: new Date().toISOString(),
    scenario: SCENARIO_TAG,
    slug,
    day_idx: dayIdx,
    type: eventType,
    ...payload,
  };

  const filePath = _scenarioFile(slug);
  try {
    _ensureFile(filePath);
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err) };
  }
}

/**
 * Read all scenario events for a slug. Optional type filter for KPI rollups
 * (W4.2 dashboard will scan with { type: 'day_completed' } etc).
 *
 * @param {string} slug
 * @param {{ type?: string, dayIdx?: number }} [filter]
 * @returns {Array<object>}
 */
function readScenarioEvents(slug, filter = null) {
  const filePath = _scenarioFile(slug);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (filter) {
        if (filter.type && row.type !== filter.type) continue;
        if (Number.isInteger(filter.dayIdx) && row.day_idx !== filter.dayIdx) continue;
      }
      out.push(row);
    } catch (_) {
      // Skip malformed line — no silent-catch in the writer; reader is
      // tolerant by design so a stray hand-edit doesn't break aggregation.
    }
  }
  return out;
}

/**
 * Truncate scenario events for a slug. Used by scenario:reset IPC.
 */
function resetScenarioEvents(slug) {
  const filePath = _scenarioFile(slug);
  if (!fs.existsSync(filePath)) return { ok: true, removed: 0 };
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length;
    fs.writeFileSync(filePath, '', 'utf8');
    return { ok: true, removed: lines };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err) };
  }
}

module.exports = {
  recordScenarioEvent,
  readScenarioEvents,
  resetScenarioEvents,
  SCENARIO_EVENT_TYPES,
  SCENARIO_TAG,
};
