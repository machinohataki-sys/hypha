'use strict';

// HYPHA · Creation System §11.4 — Product Spark (slug-bound JSONL flavor)
//
// Per BLUEPRINT §11.4: append-only ledger of product Sparks per curriculum
// slug. Mirrors the immutable-state-machine pattern of assumption-ledger.js
// — state changes never overwrite a prior row; instead append a new row
// carrying the new state, sharing the same spark_id. `listSparks` collapses
// to the latest state per spark_id by default.
//
// This module is INDEPENDENT of app/lib/product-spark.js (legacy W3.4 path
// that writes per-spark markdown files under vault/<slug>/product/sparks/).
// v0.7.1+ will migrate this slug-bound JSONL ledger to product-bound storage.
//
// Storage: vault/<slug>/sparks.jsonl (one JSON row per line).
//
// API:
//   appendSpark(slug, row)                    → { ok, row } | { ok:false, error }
//   listSparks(slug, { state, limit })        → array (latest-state per id, ts desc)
//   updateSparkState(slug, sparkId, newState) → { ok, row } | { ok:false, error, ... }
//
// Schema (required fields marked *):
//   ts*               ISO8601
//   spark_id*         short uuid: Date.now().toString(36) + 6 hex (3 random bytes)
//   source_type*      'lesson' | 'note' | 'book' | 'pack' | 'research-radar'
//   source_ref        string (e.g., lesson_idx as string)
//   target_product    string (slug placeholder; v0.7.1+ upgrades to product_id)
//   core_transfer*    string (≥ 10 chars) — the 1-sentence transfer
//   affected_modules  string[] (e.g., ['Lesson', 'Note', 'Library'])
//   possible_actions  string[] (e.g., ['新增功能', '改 UX'])
//   risks             string
//   state*            'Seed' | 'Considered' | 'Accepted' | 'Rejected' | 'Implemented'
//   lesson_idx        number
//   source            'manual' | 'auto-extract' (default 'manual')
//
// State machine (updateSparkState rejects illegal transitions):
//   Seed        → Considered, Rejected
//   Considered  → Accepted, Rejected
//   Accepted    → Implemented, Rejected
//   Implemented → (terminal)
//   Rejected    → (terminal)
//
// Defense:
//   - slug validated (no '..', '/', '\\', leading '.')
//   - core_transfer must be ≥ 10 chars
//   - source_type + state must be one of the allowed values
//   - corrupt JSONL lines skipped (not thrown)

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const vault = require('../vault');

const FILE_NAME = 'sparks.jsonl';
const MIN_TRANSFER_CHARS = 10;
const MIN_PREDICTION_CHARS = 10;

// Validate optional prediction sub-document. See decision-log.js for the same
// contract; duplicated here to keep modules independent (no shared util barrel).
function _validatePrediction(pred, ctx) {
  if (pred === undefined || pred === null) return null;
  if (typeof pred !== 'object' || Array.isArray(pred)) {
    try { console.warn(`${ctx}: prediction must be object, dropped`); } catch (_) {}
    return null;
  }
  const claim = typeof pred.claim === 'string' ? pred.claim.trim() : '';
  const falsifier = typeof pred.falsifier === 'string' ? pred.falsifier.trim() : '';
  const deadlineRaw = typeof pred.deadline_iso === 'string' ? pred.deadline_iso.trim() : '';
  if (claim.length < MIN_PREDICTION_CHARS) {
    try { console.warn(`${ctx}: prediction.claim < ${MIN_PREDICTION_CHARS} chars, dropped`); } catch (_) {}
    return null;
  }
  if (falsifier.length < MIN_PREDICTION_CHARS) {
    try { console.warn(`${ctx}: prediction.falsifier < ${MIN_PREDICTION_CHARS} chars, dropped`); } catch (_) {}
    return null;
  }
  if (deadlineRaw.length < MIN_PREDICTION_CHARS) {
    try { console.warn(`${ctx}: prediction.deadline_iso < ${MIN_PREDICTION_CHARS} chars, dropped`); } catch (_) {}
    return null;
  }
  const parsed = Date.parse(deadlineRaw);
  if (!Number.isFinite(parsed)) {
    try { console.warn(`${ctx}: prediction.deadline_iso not parseable ISO date, dropped`); } catch (_) {}
    return null;
  }
  return { claim, falsifier, deadline_iso: deadlineRaw };
}

const STATES = Object.freeze(['Seed', 'Considered', 'Accepted', 'Rejected', 'Implemented']);

const SOURCE_TYPES = Object.freeze(['lesson', 'note', 'book', 'pack', 'research-radar']);

const LEGAL_NEXT = Object.freeze({
  Seed:        ['Considered', 'Rejected'],
  Considered:  ['Accepted', 'Rejected'],
  Accepted:    ['Implemented', 'Rejected'],
  Implemented: [],
  Rejected:    [],
});

function _safeSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const trimmed = slug.trim();
  if (!trimmed) return null;
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (trimmed.startsWith('.')) return null;
  return trimmed;
}

function _filePath(safeSlug) {
  const root = vault.resolveRoot();
  return path.join(root, safeSlug, FILE_NAME);
}

function _newSparkId() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function _readAll(abs) {
  if (!fs.existsSync(abs)) return [];
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); }
  catch (_) { return []; }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); }
    catch (_) { /* skip corrupt line */ }
  }
  return rows;
}

// Collapse all rows down to latest-state per spark_id (by ts).
//
// Prediction handling: prediction is written ONLY on the original append; later
// state-transition rows (via updateSparkState) do not carry it. Merge the
// EARLIEST row's prediction with the LATEST row's state so callers see both
// "current lifecycle" + "original falsifier/deadline".
function _collapseLatest(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r || !r.spark_id) continue;
    const id = r.spark_id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  const out = [];
  for (const [, rs] of groups) {
    if (!rs.length) continue;
    rs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const earliest = rs[0];
    const latest = rs[rs.length - 1];
    const merged = { ...latest };
    if (earliest.prediction && !merged.prediction) {
      merged.prediction = earliest.prediction;
    }
    out.push(merged);
  }
  return out;
}

// Normalise string-array fields. Drops non-strings, trims, drops empties.
function _normArr(val) {
  if (!Array.isArray(val)) return [];
  const out = [];
  for (const v of val) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t) out.push(t);
  }
  return out;
}

function appendSpark(slug, row) {
  const safe = _safeSlug(slug);
  if (!safe) return { ok: false, error: 'product-spark: invalid slug' };
  if (!row || typeof row !== 'object') {
    return { ok: false, error: 'product-spark: row must be object' };
  }
  const coreTransfer = typeof row.core_transfer === 'string' ? row.core_transfer.trim() : '';
  if (coreTransfer.length < MIN_TRANSFER_CHARS) {
    return { ok: false, error: `product-spark: core_transfer must be ≥ ${MIN_TRANSFER_CHARS} chars` };
  }
  if (!SOURCE_TYPES.includes(row.source_type)) {
    return { ok: false, error: `product-spark: invalid source_type '${row.source_type}'` };
  }
  const state = STATES.includes(row.state) ? row.state : 'Seed';
  const source = row.source === 'auto-extract' ? 'auto-extract' : 'manual';
  const prediction = _validatePrediction(row.prediction, 'product-spark');
  const nowIso = new Date().toISOString();
  const stamped = {
    ts: typeof row.ts === 'string' && row.ts ? row.ts : nowIso,
    spark_id: typeof row.spark_id === 'string' && row.spark_id
      ? row.spark_id
      : _newSparkId(),
    source_type: row.source_type,
    source_ref: typeof row.source_ref === 'string' ? row.source_ref : '',
    target_product: typeof row.target_product === 'string' ? row.target_product : '',
    core_transfer: coreTransfer,
    affected_modules: _normArr(row.affected_modules),
    possible_actions: _normArr(row.possible_actions),
    risks: typeof row.risks === 'string' ? row.risks : '',
    state,
    lesson_idx: Number.isFinite(row.lesson_idx) ? row.lesson_idx : null,
    source,
  };
  if (prediction) stamped.prediction = prediction;
  const abs = _filePath(safe);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, JSON.stringify(stamped) + '\n', 'utf8');
  } catch (err) {
    return { ok: false, error: `product-spark: write failed: ${err.message}` };
  }
  return { ok: true, row: stamped };
}

function listSparks(slug, { state, limit } = {}) {
  const safe = _safeSlug(slug);
  if (!safe) return [];
  const abs = _filePath(safe);
  const rows = _readAll(abs);
  if (!rows.length) return [];
  let latest = _collapseLatest(rows);
  if (state && STATES.includes(state)) {
    latest = latest.filter(r => r.state === state);
  }
  latest.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  if (typeof limit === 'number' && limit > 0) {
    latest = latest.slice(0, limit);
  }
  return latest;
}

function updateSparkState(slug, sparkId, newState) {
  const safe = _safeSlug(slug);
  if (!safe) return { ok: false, error: 'product-spark: invalid slug' };
  if (!sparkId || typeof sparkId !== 'string') {
    return { ok: false, error: 'product-spark: sparkId required' };
  }
  if (!STATES.includes(newState)) {
    return { ok: false, error: `product-spark: invalid state '${newState}'` };
  }
  const abs = _filePath(safe);
  const rows = _readAll(abs);
  const matching = rows.filter(r => r && r.spark_id === sparkId);
  if (!matching.length) {
    return { ok: false, error: `product-spark: spark not found: ${sparkId}` };
  }
  matching.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const latest = matching[0];
  const allowed = LEGAL_NEXT[latest.state] || [];
  if (!allowed.includes(newState)) {
    return {
      ok: false,
      error: `product-spark: illegal transition ${latest.state} → ${newState}`,
      legalNext: allowed,
      terminal: allowed.length === 0,
    };
  }
  const stamped = {
    ts: new Date().toISOString(),
    spark_id: sparkId,
    source_type: latest.source_type,
    source_ref: latest.source_ref || '',
    target_product: latest.target_product || '',
    core_transfer: latest.core_transfer,
    affected_modules: _normArr(latest.affected_modules),
    possible_actions: _normArr(latest.possible_actions),
    risks: latest.risks || '',
    state: newState,
    lesson_idx: Number.isFinite(latest.lesson_idx) ? latest.lesson_idx : null,
    source: latest.source || 'manual',
  };
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, JSON.stringify(stamped) + '\n', 'utf8');
  } catch (err) {
    return { ok: false, error: `product-spark: write failed: ${err.message}` };
  }
  return { ok: true, row: stamped };
}

module.exports = {
  STATES,
  SOURCE_TYPES,
  LEGAL_NEXT,
  appendSpark,
  listSparks,
  updateSparkState,
};
