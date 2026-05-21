'use strict';

// HYPHA · Creation System §11.6 — Assumption Ledger
//
// Per BLUEPRINT §11.6: append-only ledger of product assumptions per curriculum
// slug. State changes are IMMUTABLE — never overwrite a prior row; instead
// append a new row carrying the new state, sharing the same assumption_id.
// `listAssumptions` collapses to the latest state per id by default.
//
// Storage: vault/<slug>/assumptions.jsonl
//
// API:
//   appendAssumption(slug, row)                       → { ok, row } | { ok:false, error }
//   listAssumptions(slug, { state, limit })           → array (latest-state per id)
//   updateAssumptionState(slug, assumptionId, state)  → { ok, row } | { ok:false, error }
//
// Schema (required fields marked *):
//   ts*            ISO8601
//   assumption_id* short uuid: Date.now().toString(36) + 6 hex (3 random bytes)
//   lesson_idx     number
//   claim*         string (≥ 10 chars)
//   state*         'unvalidated' | 'validating' | 'validated' | 'refuted'
//   evidence       string
//   set_at         ISO8601 date
//   source         'manual' | 'auto-extract' (default 'manual')
//
// State machine (updateAssumptionState rejects illegal transitions):
//   unvalidated → validating | validated | refuted
//   validating  → validated | refuted | unvalidated
//   validated   → refuted
//   refuted     → (terminal — refused)
//
// Defense:
//   - slug validated (no '..', '/', '\\')
//   - claim text must be ≥ 10 chars
//   - state must be one of the 4 allowed values
//   - corrupt JSONL lines skipped (not thrown)

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const vault = require('../vault');

const FILE_NAME = 'assumptions.jsonl';
const MIN_CLAIM_CHARS = 10;
const MIN_PREDICTION_CHARS = 10;

const VAGUE_FALSIFIER_RE = /\b(we['’]ll see|tbd|probably|likely|maybe|might)\b/i;
const CONCRETE_FALSIFIER_RE = /(\d+|%|<|>|≤|≥|\d{4}-\d{2}-\d{2})/;

function _isVagueFalsifier(falsifier) {
  if (VAGUE_FALSIFIER_RE.test(falsifier)) return true;
  if (!CONCRETE_FALSIFIER_RE.test(falsifier)) return true;
  return false;
}

// Validate optional prediction sub-document. See decision-log.js for the
// same contract; duplicated here to keep modules independent (no shared util
// barrel — per BLUEPRINT §11.5/§11.6 each ledger owns its schema).
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
  if (_isVagueFalsifier(falsifier)) {
    try { console.warn(`${ctx}: prediction.falsifier rejected — vague hedge or no numeric/comparator/date anchor, dropped (got: "${falsifier}")`); } catch (_) {}
    return null;
  }
  return { claim, falsifier, deadline_iso: deadlineRaw };
}

const STATES = Object.freeze(['unvalidated', 'validating', 'validated', 'refuted']);

const LEGAL_NEXT = Object.freeze({
  unvalidated: ['validating', 'validated', 'refuted'],
  validating:  ['validated', 'refuted', 'unvalidated'],
  validated:   ['refuted'],
  refuted:     [],
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

function _newAssumptionId() {
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

// Collapse all rows down to latest-state per assumption_id (by ts).
//
// Prediction handling: prediction is written ONLY on the original append; later
// state-transition rows (via updateAssumptionState) do not carry it. Reconstruct
// the merged view by taking the EARLIEST row's prediction together with the
// LATEST row's state and other fields. Without this merge, a refuted assumption
// would lose its original falsifier — which is exactly the audit trail Kill
// Criteria §11.7 needs to know "what disproved this and when".
function _collapseLatest(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!r || !r.assumption_id) continue;
    const id = r.assumption_id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(r);
  }
  const out = [];
  for (const [, rs] of groups) {
    if (!rs.length) continue;
    rs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const earliest = rs[0];
    const latest = rs[rs.length - 1];
    // Latest carries current state; earliest carries original prediction (if any).
    const merged = { ...latest };
    if (earliest.prediction && !merged.prediction) {
      merged.prediction = earliest.prediction;
    }
    out.push(merged);
  }
  return out;
}

function appendAssumption(slug, row) {
  const safe = _safeSlug(slug);
  if (!safe) return { ok: false, error: 'assumption-ledger: invalid slug' };
  if (!row || typeof row !== 'object') {
    return { ok: false, error: 'assumption-ledger: row must be object' };
  }
  const claim = typeof row.claim === 'string' ? row.claim.trim() : '';
  if (claim.length < MIN_CLAIM_CHARS) {
    return { ok: false, error: `assumption-ledger: claim must be ≥ ${MIN_CLAIM_CHARS} chars` };
  }
  const state = STATES.includes(row.state) ? row.state : 'unvalidated';
  const source = row.source === 'auto-extract' ? 'auto-extract' : 'manual';
  const prediction = _validatePrediction(row.prediction, 'assumption-ledger');
  const nowIso = new Date().toISOString();
  const stamped = {
    ts: typeof row.ts === 'string' && row.ts ? row.ts : nowIso,
    assumption_id: typeof row.assumption_id === 'string' && row.assumption_id
      ? row.assumption_id
      : _newAssumptionId(),
    lesson_idx: Number.isFinite(row.lesson_idx) ? row.lesson_idx : null,
    claim,
    state,
    evidence: typeof row.evidence === 'string' ? row.evidence : '',
    set_at: typeof row.set_at === 'string' && row.set_at ? row.set_at : nowIso.slice(0, 10),
    source,
  };
  if (prediction) stamped.prediction = prediction;
  const abs = _filePath(safe);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, JSON.stringify(stamped) + '\n', 'utf8');
  } catch (err) {
    return { ok: false, error: `assumption-ledger: write failed: ${err.message}` };
  }
  return { ok: true, row: stamped };
}

function listAssumptions(slug, { state, limit } = {}) {
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

function updateAssumptionState(slug, assumptionId, newState) {
  const safe = _safeSlug(slug);
  if (!safe) return { ok: false, error: 'assumption-ledger: invalid slug' };
  if (!assumptionId || typeof assumptionId !== 'string') {
    return { ok: false, error: 'assumption-ledger: assumptionId required' };
  }
  if (!STATES.includes(newState)) {
    return { ok: false, error: `assumption-ledger: invalid state '${newState}'` };
  }
  const abs = _filePath(safe);
  const rows = _readAll(abs);
  const matching = rows.filter(r => r && r.assumption_id === assumptionId);
  if (!matching.length) {
    return { ok: false, error: `assumption-ledger: assumption not found: ${assumptionId}` };
  }
  matching.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  const latest = matching[0];
  const allowed = LEGAL_NEXT[latest.state] || [];
  if (!allowed.includes(newState)) {
    return {
      ok: false,
      error: `assumption-ledger: illegal transition ${latest.state} → ${newState}`,
      legalNext: allowed,
      terminal: allowed.length === 0,
    };
  }
  const stamped = {
    ts: new Date().toISOString(),
    assumption_id: assumptionId,
    lesson_idx: Number.isFinite(latest.lesson_idx) ? latest.lesson_idx : null,
    claim: latest.claim,
    state: newState,
    evidence: latest.evidence || '',
    set_at: latest.set_at || new Date().toISOString().slice(0, 10),
    source: latest.source || 'manual',
  };
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, JSON.stringify(stamped) + '\n', 'utf8');
  } catch (err) {
    return { ok: false, error: `assumption-ledger: write failed: ${err.message}` };
  }
  return { ok: true, row: stamped };
}

module.exports = {
  STATES,
  LEGAL_NEXT,
  appendAssumption,
  listAssumptions,
  updateAssumptionState,
};
