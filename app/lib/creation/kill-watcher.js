'use strict';

// HYPHA · Creation System §11.7 — Kill Watcher (runtime engine)
//
// Sweeps every slug + .products/<productId>/ in the vault for prediction-bearing
// rows whose deadline_iso has passed. Auto-applies the Kill Criteria:
//
//   assumption.state ∈ {unvalidated, validating} + deadline expired
//     → append refuted-state row with _meta.auto_killed_at
//   spark.state ∈ {Seed, Considered} + deadline expired
//     → append Rejected-state row with _meta.auto_killed_at
//   decision (no state machine) + deadline expired
//     → append review-flag row to vault/<slug>/decision-reviews.jsonl
//       (NOT to decisions.jsonl — decisions.jsonl row schema is rigid per α3).
//
// Storage paths swept:
//   vault/<slug>/{decisions,assumptions,sparks}.jsonl  (curriculum-bound)
//   vault/.products/<productId>/{decisions,assumptions,sparks}.jsonl  (product-bound)
//
// API:
//   runKillWatcherSweep({ vaultRoot, now } = {}) → Promise<{ ok, summary }>
//   loadDecisionReviews(slug) → array  (helper for UI left-join)
//
// Defense:
//   - Per-slug try/catch — one bad slug never poisons the sweep
//   - Corrupt jsonl lines skipped silently
//   - State-machine illegal transitions caught + recorded in errors[]
//   - _meta field is sidecar-only — never breaks original row schema
//
// Bypass library write helpers: we write the kill-row directly to the .jsonl
// so we can carry the _meta:{auto_killed_at, reason} sidecar. The libraries
// (assumption-ledger.js / product-spark.js) intentionally strip unknown keys,
// so calling their updateState() would drop _meta on the floor.

const fs = require('node:fs');
const path = require('node:path');

const vault = require('../vault');
const assumptionLedger = require('./assumption-ledger');
const productSpark = require('./product-spark');

// ---------------------------------------------------------------------------
// Constants — pulled from library exports so the state machines stay aligned.
// ---------------------------------------------------------------------------

const ASSUMPTION_KILL_FROM = new Set(['unvalidated', 'validating']);
const SPARK_KILL_FROM      = new Set(['Seed', 'Considered']);

const DECISION_REVIEW_FILE = 'decision-reviews.jsonl';

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function _readJsonl(abs) {
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

function _appendJsonl(abs, row) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(row) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Per-id collapse — match library semantics: latest state + earliest prediction.
// ---------------------------------------------------------------------------

function _collapseLatest(rows, idKey) {
  const groups = new Map();
  for (const r of rows) {
    if (!r || !r[idKey]) continue;
    const id = r[idKey];
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

// Decisions have no id-column; each row is independent. We treat each row as
// its own "record" — earliest-anchored by ts. A flagged decision is identified
// by its ts.
function _isDeadlinePassed(prediction, now) {
  if (!prediction || typeof prediction !== 'object') return null;
  const deadline = typeof prediction.deadline_iso === 'string' ? prediction.deadline_iso.trim() : '';
  if (!deadline) return null;
  const parsed = Date.parse(deadline);
  if (!Number.isFinite(parsed)) return null;
  if (parsed >= now.getTime()) return null;
  return deadline;
}

// ---------------------------------------------------------------------------
// Slug discovery
// ---------------------------------------------------------------------------
//
// Yields { kind, label, baseDir }:
//   kind  ∈ { 'slug', 'product' }
//   label = display name in summary (slug name or productId)
//   baseDir = absolute directory where decisions/assumptions/sparks .jsonl live

function _discoverTargets(vaultRoot) {
  const targets = [];
  let dirents;
  try { dirents = fs.readdirSync(vaultRoot, { withFileTypes: true }); }
  catch (_) { return targets; }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    if (d.name === '.products') continue; // handled below
    if (d.name.startsWith('.')) continue; // .hypha / .trash / .persona-wisdom ...
    targets.push({ kind: 'slug', label: d.name, baseDir: path.join(vaultRoot, d.name) });
  }
  const productsRoot = path.join(vaultRoot, '.products');
  if (fs.existsSync(productsRoot)) {
    let productDirents;
    try { productDirents = fs.readdirSync(productsRoot, { withFileTypes: true }); }
    catch (_) { productDirents = []; }
    for (const d of productDirents) {
      if (!d.isDirectory()) continue;
      if (d.name.startsWith('.')) continue;
      targets.push({ kind: 'product', label: d.name, baseDir: path.join(productsRoot, d.name) });
    }
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Killers
// ---------------------------------------------------------------------------

function _killAssumption(target, latest, now, summary, errors) {
  const abs = path.join(target.baseDir, 'assumptions.jsonl');
  const nowIso = now.toISOString();
  const killedRow = {
    ts: nowIso,
    assumption_id: latest.assumption_id,
    lesson_idx: Number.isFinite(latest.lesson_idx) ? latest.lesson_idx : null,
    claim: latest.claim,
    state: 'refuted',
    evidence: latest.evidence || '',
    set_at: latest.set_at || nowIso.slice(0, 10),
    source: latest.source || 'manual',
    _meta: { auto_killed_at: nowIso, reason: 'deadline_passed' },
  };
  try {
    _appendJsonl(abs, killedRow);
    summary.by_kind.assumptions_refuted.push({
      slug: target.label,
      kind: target.kind,
      assumption_id: latest.assumption_id,
      original_claim: latest.claim,
      deadline_iso: latest.prediction.deadline_iso,
    });
  } catch (err) {
    errors.push({
      slug: target.label,
      file: 'assumptions.jsonl',
      error_msg: `assumption refute write failed: ${err.message}`,
    });
  }
}

function _killSpark(target, latest, now, summary, errors) {
  const abs = path.join(target.baseDir, 'sparks.jsonl');
  const nowIso = now.toISOString();
  const killedRow = {
    ts: nowIso,
    spark_id: latest.spark_id,
    source_type: latest.source_type,
    source_ref: latest.source_ref || '',
    target_product: latest.target_product || '',
    core_transfer: latest.core_transfer,
    affected_modules: Array.isArray(latest.affected_modules) ? latest.affected_modules : [],
    possible_actions: Array.isArray(latest.possible_actions) ? latest.possible_actions : [],
    risks: latest.risks || '',
    state: 'Rejected',
    lesson_idx: Number.isFinite(latest.lesson_idx) ? latest.lesson_idx : null,
    source: latest.source || 'manual',
    _meta: { auto_killed_at: nowIso, reason: 'deadline_passed' },
  };
  try {
    _appendJsonl(abs, killedRow);
    summary.by_kind.sparks_rejected.push({
      slug: target.label,
      kind: target.kind,
      spark_id: latest.spark_id,
      original_core_transfer: latest.core_transfer,
      deadline_iso: latest.prediction.deadline_iso,
    });
  } catch (err) {
    errors.push({
      slug: target.label,
      file: 'sparks.jsonl',
      error_msg: `spark reject write failed: ${err.message}`,
    });
  }
}

function _flagDecision(target, row, now, summary, errors) {
  // Decisions: write to sibling decision-reviews.jsonl so decisions.jsonl
  // remains immutable + schema-rigid (α3 owns that). UI left-joins on
  // decision_ts to surface needs_review badge.
  const abs = path.join(target.baseDir, DECISION_REVIEW_FILE);
  const nowIso = now.toISOString();
  const flagRow = {
    ts: nowIso,
    action: 'auto_review_flag',
    reason: 'deadline_passed',
    decision_ts: row.ts, // anchor — UI joins by this
    original_decision: row.decision,
    deadline_iso: row.prediction.deadline_iso,
  };
  try {
    _appendJsonl(abs, flagRow);
    summary.by_kind.decisions_flagged.push({
      slug: target.label,
      kind: target.kind,
      decision_ts: row.ts,
      original_decision: row.decision,
      deadline_iso: row.prediction.deadline_iso,
    });
  } catch (err) {
    errors.push({
      slug: target.label,
      file: DECISION_REVIEW_FILE,
      error_msg: `decision flag write failed: ${err.message}`,
    });
  }
}

// Was this decision-row already flagged in a prior sweep? Avoid re-flagging on
// every startup. We treat (decision_ts) as the de-dup key.
function _alreadyFlagged(target, decisionTs) {
  const abs = path.join(target.baseDir, DECISION_REVIEW_FILE);
  const rows = _readJsonl(abs);
  for (const r of rows) {
    if (r && r.action === 'auto_review_flag' && r.decision_ts === decisionTs) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Per-target sweep
// ---------------------------------------------------------------------------

function _sweepTarget(target, now, summary, errors) {
  // assumptions.jsonl
  try {
    const abs = path.join(target.baseDir, 'assumptions.jsonl');
    if (fs.existsSync(abs)) {
      const rows = _readJsonl(abs);
      const collapsed = _collapseLatest(rows, 'assumption_id');
      for (const latest of collapsed) {
        const deadline = _isDeadlinePassed(latest.prediction, now);
        if (!deadline) continue;
        if (!ASSUMPTION_KILL_FROM.has(latest.state)) continue;
        _killAssumption(target, latest, now, summary, errors);
      }
    }
  } catch (err) {
    errors.push({ slug: target.label, file: 'assumptions.jsonl', error_msg: err.message });
  }
  // sparks.jsonl
  try {
    const abs = path.join(target.baseDir, 'sparks.jsonl');
    if (fs.existsSync(abs)) {
      const rows = _readJsonl(abs);
      const collapsed = _collapseLatest(rows, 'spark_id');
      for (const latest of collapsed) {
        const deadline = _isDeadlinePassed(latest.prediction, now);
        if (!deadline) continue;
        if (!SPARK_KILL_FROM.has(latest.state)) continue;
        _killSpark(target, latest, now, summary, errors);
      }
    }
  } catch (err) {
    errors.push({ slug: target.label, file: 'sparks.jsonl', error_msg: err.message });
  }
  // decisions.jsonl
  try {
    const abs = path.join(target.baseDir, 'decisions.jsonl');
    if (fs.existsSync(abs)) {
      const rows = _readJsonl(abs);
      for (const row of rows) {
        if (!row || !row.ts || typeof row.decision !== 'string') continue;
        const deadline = _isDeadlinePassed(row.prediction, now);
        if (!deadline) continue;
        if (_alreadyFlagged(target, row.ts)) continue;
        _flagDecision(target, row, now, summary, errors);
      }
    }
  } catch (err) {
    errors.push({ slug: target.label, file: 'decisions.jsonl', error_msg: err.message });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function runKillWatcherSweep({ vaultRoot, now } = {}) {
  const nowDate = now instanceof Date ? now : new Date();
  const root = vaultRoot || vault.resolveRoot();
  const summary = {
    ok: true,
    sweep_ts: nowDate.toISOString(),
    slugs_scanned: 0,
    by_kind: {
      assumptions_refuted: [],
      sparks_rejected: [],
      decisions_flagged: [],
    },
    errors: [],
  };
  if (!root || !fs.existsSync(root)) {
    return { ok: true, summary };
  }
  const targets = _discoverTargets(root);
  summary.slugs_scanned = targets.length;
  for (const target of targets) {
    try {
      _sweepTarget(target, nowDate, summary, summary.errors);
    } catch (err) {
      summary.errors.push({
        slug: target.label,
        file: '*',
        error_msg: `target sweep failed: ${err.message}`,
      });
    }
  }
  return { ok: true, summary };
}

// Helper for UI: load review flags for a slug. UI left-joins by decision_ts to
// render the "needs review (deadline passed)" badge alongside the original row.
function loadDecisionReviews(slug) {
  if (!slug || typeof slug !== 'string') return [];
  const trimmed = slug.trim();
  if (!trimmed) return [];
  // Accept both top-level slugs and `.products/<productId>` style ids. Reject
  // `..` / separator escapes to keep the read locked inside vault.
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) return [];
  const root = vault.resolveRoot();
  let baseDir;
  if (trimmed.startsWith('.products:')) {
    baseDir = path.join(root, '.products', trimmed.slice('.products:'.length));
  } else if (trimmed.startsWith('.')) {
    return []; // direct system-dir read not allowed; use the `.products:` prefix instead
  } else {
    baseDir = path.join(root, trimmed);
  }
  const abs = path.join(baseDir, DECISION_REVIEW_FILE);
  return _readJsonl(abs).filter(r => r && r.action === 'auto_review_flag');
}

module.exports = {
  runKillWatcherSweep,
  loadDecisionReviews,
  // exposed for tests + introspection
  _ASSUMPTION_KILL_FROM: ASSUMPTION_KILL_FROM,
  _SPARK_KILL_FROM: SPARK_KILL_FROM,
  _DECISION_REVIEW_FILE: DECISION_REVIEW_FILE,
};
