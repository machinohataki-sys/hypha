'use strict';

// HYPHA · Note System §3 v0.5+ · Atlas Concept Temporal Decay + Entropy Quantification
// ----------------------------------------------------------------------------
// Two deliverables in one module because they share substrate (concept weight
// timeline) and ship together:
//
//   (4) Half-life decay — concepts visited long ago fade unless re-touched.
//       90 days = ×0.5 weight (configurable). Concepts below ARCHIVE_FLOOR
//       move to `vault/<slug>/atlas-archive.jsonl` (append-only, never deleted).
//
//   (5) Entropy quantification — Shannon entropy over the visit-frequency
//       distribution of a concept cluster. Week-over-week comparison emits a
//       `convergence | divergence | stable` badge for the renderer.
//
// Substrate: caller supplies a "concept timeline" — for each concept, an
// array of visit timestamps (ms since epoch). This module is pure logic +
// fs append-only IO; it does NOT scrape vault state. Wiring to the renderer's
// existing atlas pipeline is the caller's responsibility (single integration
// point — see _resolveSlugDir below + the export `archiveBelowThreshold`).
//
// Storage layout:
//   vault/<slug>/atlas-archive.jsonl
//     { ts, concept, last_touched, weight_at_archive, reason }
//
// Append-only by design (Lens 9 SURGICAL — never delete user data).

const fs   = require('node:fs');
const path = require('node:path');

const HALF_LIFE_DAYS_DEFAULT = 90;
const ARCHIVE_FLOOR_DEFAULT  = 0.1;
const ARCHIVE_FILE           = 'atlas-archive.jsonl';
const MS_PER_DAY             = 1000 * 60 * 60 * 24;

function _resolveSlugDir(slug) {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return path.join(process.env.HYPHA_DATA, slug);
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return path.join(process.env.HYPHA_VAULT_DIR, slug);
  }
  if (process.env.HYPHA_VAULT_ROOT && fs.existsSync(process.env.HYPHA_VAULT_ROOT)) {
    return path.join(process.env.HYPHA_VAULT_ROOT, slug);
  }
  return path.join(__dirname, '..', '..', '..', 'data', slug);
}

function _archivePath(slug) {
  return path.join(_resolveSlugDir(slug), ARCHIVE_FILE);
}

function _safeAppendJsonl(absPath, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(absPath, text, 'utf8');
    return rows.length;
  } catch (_) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// (4) Half-life decay
// ---------------------------------------------------------------------------

// Compute decayed weight for a single concept.
//   weight(t) = sum over visits[i] of (1/2) ^ ((nowMs - visits[i]) / halfLifeMs)
// Visits in the future or before epoch=0 are ignored. Empty timeline → 0.
function decayedWeight(visitTimestamps, { nowMs, halfLifeDays } = {}) {
  if (!Array.isArray(visitTimestamps) || visitTimestamps.length === 0) return 0;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const half = Number.isFinite(halfLifeDays) && halfLifeDays > 0
    ? halfLifeDays : HALF_LIFE_DAYS_DEFAULT;
  const halfMs = half * MS_PER_DAY;
  let sum = 0;
  for (const t of visitTimestamps) {
    if (!Number.isFinite(t) || t <= 0 || t > now) continue;
    const ageMs = now - t;
    const halflives = ageMs / halfMs;
    sum += Math.pow(0.5, halflives);
  }
  return sum;
}

// Apply half-life decay across a {conceptName: visits[]} map. Returns:
//   { weights: {conceptName: weight}, lastTouched: {conceptName: ts} }
// Order of conceptNames is preserved by Object.keys() iteration order.
function applyHalfLifeDecay(conceptTimeline, opts = {}) {
  if (!conceptTimeline || typeof conceptTimeline !== 'object') {
    return { weights: {}, lastTouched: {} };
  }
  const weights = {};
  const lastTouched = {};
  for (const name of Object.keys(conceptTimeline)) {
    const visits = Array.isArray(conceptTimeline[name]) ? conceptTimeline[name] : [];
    weights[name] = decayedWeight(visits, opts);
    if (visits.length > 0) {
      lastTouched[name] = Math.max.apply(null, visits.filter(t => Number.isFinite(t) && t > 0));
    } else {
      lastTouched[name] = 0;
    }
  }
  return { weights, lastTouched };
}

// Identify concepts whose decayed weight ≤ floor; emit archive rows to
// vault/<slug>/atlas-archive.jsonl. NEVER deletes the input — archiving is
// append-only signaling. The renderer + atlas-builder consult the archive
// to omit faded concepts from the surface, but evidence trail stays intact.
function archiveBelowThreshold({ slug, conceptTimeline, nowMs, halfLifeDays, archiveFloor, reason } = {}) {
  if (!slug || typeof slug !== 'string') {
    return { ok: false, error: 'slug required', archived: [] };
  }
  const floor = Number.isFinite(archiveFloor) ? archiveFloor : ARCHIVE_FLOOR_DEFAULT;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const { weights, lastTouched } = applyHalfLifeDecay(conceptTimeline || {}, { nowMs: now, halfLifeDays });

  const archivedRows = [];
  const archivedNames = [];
  for (const name of Object.keys(weights)) {
    const w = weights[name];
    if (w <= floor) {
      archivedRows.push({
        ts: new Date(now).toISOString(),
        concept: name,
        last_touched: lastTouched[name] ? new Date(lastTouched[name]).toISOString() : null,
        weight_at_archive: Math.round(w * 1000) / 1000,
        reason: reason || `decayed below ${floor}`,
      });
      archivedNames.push(name);
    }
  }

  const written = _safeAppendJsonl(_archivePath(slug), archivedRows);
  return {
    ok: true,
    archived: archivedNames,
    archived_rows: archivedRows,
    written,
    archive_path: _archivePath(slug),
    weights,
    last_touched: lastTouched,
  };
}

// Read back the archive (replay-friendly). Used by the renderer to filter
// concepts out of the surface, and by tests to assert idempotency.
function readArchive(slug) {
  if (!slug || typeof slug !== 'string') return [];
  const p = _archivePath(slug);
  if (!fs.existsSync(p)) return [];
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { return []; }
  if (!raw.trim()) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (5) Entropy quantification
// ---------------------------------------------------------------------------

// Shannon entropy (base-2, bits) over a visit-frequency distribution.
// Input shape:
//   counts = { conceptA: n_a, conceptB: n_b, ... }   integer ≥ 0
// Returns entropy in bits. Edge cases:
//   total = 0 → entropy = 0 (no distribution)
//   single concept with all visits → entropy = 0 (zero uncertainty)
//   uniform across k concepts → entropy = log2(k) (max for k bins)
function shannonEntropy(counts) {
  if (!counts || typeof counts !== 'object') return 0;
  let total = 0;
  const values = [];
  for (const k of Object.keys(counts)) {
    const v = Number(counts[k]);
    if (!Number.isFinite(v) || v < 0) continue;
    if (v > 0) {
      values.push(v);
      total += v;
    }
  }
  if (total === 0 || values.length <= 1) return 0;
  let h = 0;
  for (const v of values) {
    const p = v / total;
    h -= p * Math.log2(p);
  }
  return h;
}

// Compute counts from concept timeline (number of visits per concept).
function _countsFromTimeline(conceptTimeline) {
  const counts = {};
  if (!conceptTimeline || typeof conceptTimeline !== 'object') return counts;
  for (const name of Object.keys(conceptTimeline)) {
    const visits = Array.isArray(conceptTimeline[name]) ? conceptTimeline[name] : [];
    counts[name] = visits.length;
  }
  return counts;
}

// Compute counts restricted to a time window [windowStart, windowEnd] (ms).
function _countsInWindow(conceptTimeline, windowStartMs, windowEndMs) {
  const counts = {};
  if (!conceptTimeline || typeof conceptTimeline !== 'object') return counts;
  for (const name of Object.keys(conceptTimeline)) {
    const visits = Array.isArray(conceptTimeline[name]) ? conceptTimeline[name] : [];
    let n = 0;
    for (const t of visits) {
      if (!Number.isFinite(t)) continue;
      if (t >= windowStartMs && t <= windowEndMs) n += 1;
    }
    if (n > 0) counts[name] = n;
  }
  return counts;
}

// Week-over-week entropy badge.
//   Inputs: conceptTimeline + nowMs.
//   Compares entropy of [now - 7d, now] vs [now - 14d, now - 7d].
//   Returns:
//     { current_entropy, prior_entropy, delta, badge, reason, concept_count_current, concept_count_prior }
//     badge ∈ {'convergence', 'divergence', 'stable', 'insufficient_data'}
//
// Heuristic for badge:
//   - delta ≤ -0.10 bits  → 'convergence'   (entropy dropped; user focusing)
//   - delta ≥ +0.10 bits  → 'divergence'    (entropy rose; user broadening)
//   - |delta| < 0.10      → 'stable'
//   - either window empty → 'insufficient_data'
function entropyBadge({ conceptTimeline, nowMs, threshold = 0.10 } = {}) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const oneWeek = 7 * MS_PER_DAY;
  const currentCounts = _countsInWindow(conceptTimeline, now - oneWeek, now);
  const priorCounts = _countsInWindow(conceptTimeline, now - 2 * oneWeek, now - oneWeek);
  const currentEntropy = shannonEntropy(currentCounts);
  const priorEntropy = shannonEntropy(priorCounts);
  const currentTotal = Object.keys(currentCounts).length;
  const priorTotal = Object.keys(priorCounts).length;
  if (currentTotal === 0 || priorTotal === 0) {
    return {
      current_entropy: Math.round(currentEntropy * 1000) / 1000,
      prior_entropy: Math.round(priorEntropy * 1000) / 1000,
      delta: 0,
      badge: 'insufficient_data',
      reason: `current=${currentTotal} concepts, prior=${priorTotal} concepts`,
      concept_count_current: currentTotal,
      concept_count_prior: priorTotal,
    };
  }
  const delta = currentEntropy - priorEntropy;
  let badge = 'stable';
  let reason = `Δ ${delta.toFixed(3)} bits within ±${threshold}`;
  if (delta <= -threshold) {
    badge = 'convergence';
    reason = `entropy dropped ${Math.abs(delta).toFixed(3)} bits — user focusing on fewer concepts`;
  } else if (delta >= threshold) {
    badge = 'divergence';
    reason = `entropy rose ${delta.toFixed(3)} bits — user broadening across concepts`;
  }
  return {
    current_entropy: Math.round(currentEntropy * 1000) / 1000,
    prior_entropy: Math.round(priorEntropy * 1000) / 1000,
    delta: Math.round(delta * 1000) / 1000,
    badge,
    reason,
    concept_count_current: currentTotal,
    concept_count_prior: priorTotal,
  };
}

module.exports = {
  // (4) Half-life decay + archive
  applyHalfLifeDecay,
  archiveBelowThreshold,
  readArchive,
  decayedWeight,
  // (5) Entropy quantification
  shannonEntropy,
  entropyBadge,
  // Constants (for callers + smoke)
  HALF_LIFE_DAYS_DEFAULT,
  ARCHIVE_FLOOR_DEFAULT,
  ARCHIVE_FILE,
  MS_PER_DAY,
  // Internals (smoke only)
  _resolveSlugDir,
  _archivePath,
  _countsFromTimeline,
  _countsInWindow,
};
