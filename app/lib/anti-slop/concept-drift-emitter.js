'use strict';

// HYPHA · Anti-Slop · Concept-Drift Emitter (rc.1 → 1.0)
//
// Non-mutating audit layer over concept-ledger.js. When a concept's definition
// changes across 2+ consecutive lessons (Jaccard < 0.4, per existing drift
// algo), append a CONCEPT_DRIFT row to vault/<slug>/.hypha/concept-drift.jsonl
// for downstream surface (course-trust-panel can show "课程内 N 处概念漂移").
//
// "Consecutive" rule: same concept appears in lessons L and L+k where the
// concept's definition records form an unbroken span of redefining lessons.
// We do NOT require strict L+1 adjacency — the spec says "2+ consecutive
// lessons re-define same concept differently", and in HYPHA a concept may
// not appear every single lesson. We treat "consecutive RE-DEFINITIONS" as
// the relevant signal: ≥2 lessons in the concept's record carry definitions,
// and at least one pair of them drifts (already what detectDriftCases
// guarantees with severity > 0.6).
//
// Idempotency: emitter is fire-and-forget. The jsonl is APPEND-ONLY, so the
// same drift case could be appended twice across two separate audit runs.
// Each row carries `audit_run_id` (the timestamp of the audit invocation) so
// readers can deduplicate by (slug, concept, audit_run_id) if they need to.

const fs = require('node:fs');
const path = require('node:path');

const { detectDriftCases } = require('./concept-ledger');

const DRIFT_JSONL_NAME = 'concept-drift.jsonl';
const SEVERITY_FLOOR = 0.6;  // floor for "report-worthy" drift (matches spec intent)
const MIN_LESSON_COUNT = 2;  // 2+ consecutive re-defs

function _driftPath(vaultRoot, slug) {
  if (typeof slug !== 'string' || !slug.trim()) {
    throw new Error('concept-drift-emitter: slug required');
  }
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    throw new Error('concept-drift-emitter: slug must not contain path separators');
  }
  if (typeof vaultRoot !== 'string' || !vaultRoot) {
    throw new Error('concept-drift-emitter: vaultRoot required');
  }
  return path.join(vaultRoot, slug, '.hypha', DRIFT_JSONL_NAME);
}

function _eligibleCase(driftCase) {
  if (!driftCase || typeof driftCase !== 'object') return false;
  if (!Array.isArray(driftCase.lessons) || driftCase.lessons.length < MIN_LESSON_COUNT) return false;
  if (!Number.isFinite(driftCase.drift_severity)) return false;
  if (driftCase.drift_severity < SEVERITY_FLOOR) return false;
  return true;
}

// emitDriftEvents({slug, vaultRoot, ts}) — scans concept-ledger.jsonl, finds
// drift cases meeting severity + consecutive-lesson floor, appends one row
// per case. Returns { ok, emitted: N, path, audit_run_id, eligible_cases }.
function emitDriftEvents({ slug, vaultRoot, ts } = {}) {
  const auditTs = ts || new Date().toISOString();
  let drifts;
  try {
    drifts = detectDriftCases({ slug, vaultRoot });
  } catch (err) {
    return { ok: false, error: 'DRIFT_SCAN_FAILED', message: err && err.message };
  }
  if (!Array.isArray(drifts) || drifts.length === 0) {
    return { ok: true, emitted: 0, eligible_cases: [], audit_run_id: auditTs };
  }
  const eligible = drifts.filter(_eligibleCase);
  if (eligible.length === 0) {
    return { ok: true, emitted: 0, eligible_cases: [], audit_run_id: auditTs };
  }
  let absPath;
  try { absPath = _driftPath(vaultRoot, slug); }
  catch (err) { return { ok: false, error: 'BAD_PATH', message: err.message }; }
  const events = [];
  for (const dc of eligible) {
    events.push({
      event_type: 'CONCEPT_DRIFT',
      slug,
      concept: dc.concept,
      drift_kind: dc.drift_kind,
      drift_severity: Number(dc.drift_severity.toFixed(3)),
      lesson_count: dc.lessons.length,
      lessons: dc.lessons.map(l => ({
        idx: l.idx,
        definition_excerpt: typeof l.definition === 'string' ? l.definition.slice(0, 240) : '',
      })),
      audit_run_id: auditTs,
      ts: auditTs,
    });
  }
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(absPath, lines, 'utf-8');
  } catch (err) {
    return { ok: false, error: 'WRITE_FAILED', message: err && err.message, eligible_cases: eligible };
  }
  return { ok: true, emitted: events.length, path: absPath, eligible_cases: eligible, audit_run_id: auditTs };
}

function readDriftEvents({ slug, vaultRoot } = {}) {
  let absPath;
  try { absPath = _driftPath(vaultRoot, slug); }
  catch (_) { return []; }
  if (!fs.existsSync(absPath)) return [];
  try {
    const raw = fs.readFileSync(absPath, 'utf-8');
    const out = [];
    for (const ln of raw.split(/\r?\n/)) {
      const trimmed = ln.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (obj && obj.event_type === 'CONCEPT_DRIFT') out.push(obj);
      } catch (_) { /* skip malformed */ }
    }
    return out;
  } catch (_) { return []; }
}

module.exports = {
  emitDriftEvents,
  readDriftEvents,
  SEVERITY_FLOOR,
  MIN_LESSON_COUNT,
  _driftPath,
};
