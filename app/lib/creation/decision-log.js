'use strict';

// HYPHA · Creation System §11.5 — Decision Log
//
// Per BLUEPRINT §11.5: append-only ledger of product decisions per curriculum slug.
// Storage: vault/<slug>/decisions.jsonl (one JSON row per line).
//
// This module is INDEPENDENT of creation-pool-ops.js (legacy slug-bound product
// ledger). v0.7.1+ will migrate to product-bound storage; today it's slug-bound
// per task spec (Machino-α implementation 2026-05-14).
//
// API:
//   appendDecision(slug, row)              → { ok, row } | { ok:false, error }
//   listDecisions(slug, { limit, since })  → array (newest first)
//
// Schema (required fields marked *):
//   ts*          ISO8601
//   lesson_idx*  number
//   decision*    string (≥ 10 chars)
//   context      string
//   rationale    string
//   rejected     string
//   validation   string
//   needs_review bool (default false)
//   source       'manual' | 'auto-extract' (default 'manual')
//
// Defense:
//   - slug validated (no '..', '/', '\\')
//   - decision text must be ≥ 10 chars
//   - corrupt JSONL lines skipped (not thrown)

const fs = require('node:fs');
const path = require('node:path');
const vault = require('../vault');
const dependencyGraph = require('./dependency-graph');

const FILE_NAME = 'decisions.jsonl';
const MIN_DECISION_CHARS = 10;
const MIN_PREDICTION_CHARS = 10;

// Vague-falsifier guard (Scout S63 — falsifier must be concrete + measurable).
// Reject if any vague hedge phrase, OR if the falsifier lacks at least one
// concrete anchor (number / %, comparator <>≤≥, or full ISO date).
const VAGUE_FALSIFIER_RE = /\b(we['’]ll see|tbd|probably|likely|maybe|might)\b/i;
const CONCRETE_FALSIFIER_RE = /(\d+|%|<|>|≤|≥|\d{4}-\d{2}-\d{2})/;

function _isVagueFalsifier(falsifier) {
  if (VAGUE_FALSIFIER_RE.test(falsifier)) return true;
  if (!CONCRETE_FALSIFIER_RE.test(falsifier)) return true;
  return false;
}

// Validate optional prediction sub-document. Returns either a normalised
// `{claim, falsifier, deadline_iso}` triple or null (silently dropped).
// On invalid input emits a single console.warn so callers learn why their
// prediction did not stick — without poisoning the main append.
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
  // Validate ISO date — accept YYYY-MM-DD or full ISO8601. `Date.parse` returns
  // NaN on malformed; we additionally require the input to round-trip a
  // reasonable date string to defend against e.g. "deadline_iso_!!!".
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

// Normalise optional `depends_on: string[]`. Drops non-strings + empty + dups;
// caps length at 32 (sanity, not security). Returns null on empty/invalid.
function _normaliseDependsOn(raw, ctx) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    try { console.warn(`${ctx}: depends_on must be array, dropped`); } catch (_) {}
    return null;
  }
  const out = [];
  const seen = new Set();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 32) break;
  }
  return out.length ? out : null;
}

// Slug guard — mirrors product-registry._safeProductId rejection rules.
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

function appendDecision(slug, row) {
  const safe = _safeSlug(slug);
  if (!safe) return { ok: false, error: 'decision-log: invalid slug' };
  if (!row || typeof row !== 'object') {
    return { ok: false, error: 'decision-log: row must be object' };
  }
  const decisionText = typeof row.decision === 'string' ? row.decision.trim() : '';
  if (decisionText.length < MIN_DECISION_CHARS) {
    return { ok: false, error: `decision-log: decision must be ≥ ${MIN_DECISION_CHARS} chars` };
  }
  const lessonIdx = Number.isFinite(row.lesson_idx) ? row.lesson_idx : null;
  if (lessonIdx === null) {
    return { ok: false, error: 'decision-log: lesson_idx must be a finite number' };
  }
  const source = row.source === 'auto-extract' ? 'auto-extract' : 'manual';
  const prediction = _validatePrediction(row.prediction, 'decision-log');
  const dependsOn = _normaliseDependsOn(row.depends_on, 'decision-log');
  const stamped = {
    ts: typeof row.ts === 'string' && row.ts ? row.ts : new Date().toISOString(),
    lesson_idx: lessonIdx,
    decision: decisionText,
    context: typeof row.context === 'string' ? row.context : '',
    rationale: typeof row.rationale === 'string' ? row.rationale : '',
    rejected: typeof row.rejected === 'string' ? row.rejected : '',
    validation: typeof row.validation === 'string' ? row.validation : '',
    needs_review: row.needs_review === true,
    source,
  };
  if (prediction) stamped.prediction = prediction;
  if (dependsOn && dependsOn.length) stamped.depends_on = dependsOn;
  const abs = _filePath(safe);
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, JSON.stringify(stamped) + '\n', 'utf8');
  } catch (err) {
    return { ok: false, error: `decision-log: write failed: ${err.message}` };
  }
  // Decision entry_id = ts (per kill-watcher anchor convention). depends_on
  // becomes from=this.ts → to=targetId edges, kind='depends_on'. Warn-not-fail
  // when referenced ids do not (yet) exist — the target may be added later.
  if (dependsOn && dependsOn.length) {
    for (const toId of dependsOn) {
      const res = dependencyGraph.addEdge({ from_id: stamped.ts, to_id: toId, kind: 'depends_on' });
      if (!res.ok) {
        try { console.warn(`decision-log: depends_on edge skipped (${stamped.ts} -> ${toId}): ${res.error}`); } catch (_) {}
      }
    }
  }
  return { ok: true, row: stamped };
}

function listDecisions(slug, { limit, since } = {}) {
  const safe = _safeSlug(slug);
  if (!safe) return [];
  const abs = _filePath(safe);
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
  let filtered = rows;
  if (since) {
    const sinceStr = String(since);
    filtered = filtered.filter(r => typeof r.ts === 'string' && r.ts >= sinceStr);
  }
  filtered.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  if (typeof limit === 'number' && limit > 0) {
    filtered = filtered.slice(0, limit);
  }
  return filtered;
}

module.exports = {
  appendDecision,
  listDecisions,
  // Vague-falsifier guard shared with sister modules (e.g. growth/project-spine
  // milestone falsifier) — single regex source defends against drift.
  _falsifierGuard: {
    VAGUE_FALSIFIER_RE,
    CONCRETE_FALSIFIER_RE,
    MIN_PREDICTION_CHARS,
    isVagueFalsifier: _isVagueFalsifier,
  },
};
