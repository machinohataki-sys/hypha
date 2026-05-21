'use strict';

// HYPHA · W7.3 Citation System · coverage (BLUEPRINT §12.7 / §22.2)
//
// System-level citation coverage. Spec calls for a "% claims grounded"
// signal so the Course Trust Panel can render:
//
//   CITATIONS · 87% claims grounded · 12 sources
//
// "Claim" in the lesson-body-v2 schema = a single evidence-bearing
// statement. The body shipped by `lesson-body-generator.js` does NOT
// expose a flat `claims[]` array — instead, claim-bearing text lives in
// these fields:
//
//   - thesis              (single sentence  → 1 claim)
//   - mechanism_explanation   (substantial prose → counted by sentence)
//   - common_misconceptions[] (each entry    → 1 claim)
//   - examples[].claim    (Phase-B v0.4.5+   → 1 claim each, optional)
//
// `evidence_cite[]` (post-_extractCitations) lists the citations that
// actually resolved against ranked sources. We treat coverage as:
//
//   coverage_pct = min(100, evidence_cite.length / total_claims * 100)
//
// Coverage GATE returns whether the body passes a configurable threshold
// (default 60%). Gating policy DOES NOT throw or mutate state — pure data
// + reason string so callers (e.g. Trust Panel) can render decisions.
//
// All functions are pure. No fs, no LLM, no mutation. Frozen outputs.

const DEFAULT_COVERAGE_THRESHOLD_PCT = 60;

// Lazy-load Evidence Ledger v1.0 (boot-9) for per-claim grounding %. Optional
// — pure-coverage path keeps working if module missing (defensive against
// load-order quirks). Returns null shape on any failure.
let _evidenceLedgerLib = null;
function _evLib() {
  if (_evidenceLedgerLib !== null) return _evidenceLedgerLib;
  try { _evidenceLedgerLib = require('../anti-slop/evidence-ledger'); }
  catch (_) { _evidenceLedgerLib = false; }
  return _evidenceLedgerLib;
}

// Claim-counting weights for known body fields. Conservative — we count
// integer claims, not weighted importance. Caller can override via opts.
function _countClaimsInBody(body) {
  if (!body || typeof body !== 'object') return 0;
  let claims = 0;
  if (typeof body.thesis === 'string' && body.thesis.trim().length > 0) claims += 1;
  if (typeof body.mechanism_explanation === 'string' && body.mechanism_explanation.trim().length > 0) {
    // Treat mechanism as 1 anchored claim — pedagogy.md says one mechanism
    // per lesson, even though it spans paragraphs. Multi-sentence
    // decomposition is out-of-scope; defer to v0.5+ semantic split.
    claims += 1;
  }
  if (Array.isArray(body.common_misconceptions)) {
    claims += body.common_misconceptions.filter((m) => typeof m === 'string' && m.trim().length > 0).length;
  }
  if (Array.isArray(body.examples)) {
    for (const ex of body.examples) {
      // examples[].claim is the optional Phase-B narrative-arc field; absence
      // does not count.
      if (ex && typeof ex === 'object' && typeof ex.claim === 'string' && ex.claim.trim().length > 0) {
        claims += 1;
      }
    }
  }
  return claims;
}

/**
 * Compute citation coverage for a single lesson body (post-v2 shape).
 *
 * @param {object} body  the .body field of a lesson body file
 * @param {object} [opts]
 * @param {number} [opts.threshold] coverage threshold percent (default 60)
 * @returns {Readonly<{ total_claims:number, cited_count:number, coverage_pct:number, sources:number, gate_passed:boolean, threshold:number, reason:string }>}
 */
function computeBodyCoverage(body, opts) {
  const o = opts || {};
  const threshold = Number.isFinite(o.threshold) ? o.threshold : DEFAULT_COVERAGE_THRESHOLD_PCT;
  const totalClaims = _countClaimsInBody(body);
  const cites = (body && Array.isArray(body.evidence_cite)) ? body.evidence_cite : [];
  // De-duplicate sources by source-id (book_id / pack_id / url).
  const sourceSet = new Set();
  for (const c of cites) {
    if (!c || typeof c !== 'object') continue;
    const sid = c.book_id || c.pack_id || c.url || c.source_id || c.marker;
    if (sid) sourceSet.add(String(sid));
  }
  const citedCount = cites.length;
  // Coverage is naturally capped at 100% — extra cites past total claims
  // do not penalise.
  const rawPct = totalClaims === 0 ? 0 : (citedCount / totalClaims) * 100;
  const coveragePct = Math.max(0, Math.min(100, Math.round(rawPct)));
  const gatePassed = totalClaims === 0
    ? true   // No claims = no grounding to do; trivially pass.
    : coveragePct >= threshold;
  const reason = totalClaims === 0
    ? 'no claim-bearing fields in body — coverage gate skipped'
    : (gatePassed
        ? `coverage ${coveragePct}% ≥ threshold ${threshold}%`
        : `coverage ${coveragePct}% < threshold ${threshold}% — fewer than ${threshold}% of claims are grounded`);
  // Evidence Ledger v1.0 boot-9 — per-claim grounding additive. Never throws;
  // returns null fields when ledger absent so legacy consumers keep working.
  let claim_grounding_pct = null;
  let orphan_claims = null;
  let ledger_present = false;
  const _el = _evLib();
  if (_el && typeof _el.summarize === 'function') {
    try {
      const sum = _el.summarize({ lessonBody: body });
      claim_grounding_pct = sum.grounding_pct;
      orphan_claims = sum.orphan_claims.length;
      ledger_present = sum.ledger_present;
    } catch (_) { /* preserve legacy return shape on any failure */ }
  }
  return Object.freeze({
    total_claims: totalClaims,
    cited_count: citedCount,
    coverage_pct: coveragePct,
    sources: sourceSet.size,
    gate_passed: gatePassed,
    threshold,
    reason,
    claim_grounding_pct,
    orphan_claims,
    ledger_present,
  });
}

/**
 * Aggregate coverage across N body objects (course-wide summary).
 *
 * @param {Array<object>} bodies  array of `body` objects (NOT body-files)
 * @param {object} [opts]
 * @returns {Readonly<object>}
 */
function aggregateCoverage(bodies, opts) {
  if (!Array.isArray(bodies) || bodies.length === 0) {
    return Object.freeze({
      lessons: 0,
      total_claims: 0,
      cited_count: 0,
      coverage_pct: 0,
      sources: 0,
      gate_pass_count: 0,
      gate_fail_count: 0,
      threshold: (opts && Number.isFinite(opts.threshold)) ? opts.threshold : DEFAULT_COVERAGE_THRESHOLD_PCT,
    });
  }
  const perBody = bodies.map((b) => computeBodyCoverage(b, opts));
  const totalClaims = perBody.reduce((s, r) => s + r.total_claims, 0);
  const citedCount = perBody.reduce((s, r) => s + r.cited_count, 0);
  const sourcesAcross = new Set();
  for (const b of bodies) {
    const cites = (b && Array.isArray(b.evidence_cite)) ? b.evidence_cite : [];
    for (const c of cites) {
      const sid = c && (c.book_id || c.pack_id || c.url || c.source_id || c.marker);
      if (sid) sourcesAcross.add(String(sid));
    }
  }
  const rawPct = totalClaims === 0 ? 0 : (citedCount / totalClaims) * 100;
  // Evidence Ledger v1.0 boot-9 — aggregate grounding stats.
  let totalOrphanClaims = 0;
  let bodiesWithLedger = 0;
  let groundingSumPct = 0;
  let groundingDenom = 0;
  for (const r of perBody) {
    if (r.ledger_present) bodiesWithLedger += 1;
    if (typeof r.orphan_claims === 'number') totalOrphanClaims += r.orphan_claims;
    if (typeof r.claim_grounding_pct === 'number') {
      groundingSumPct += r.claim_grounding_pct;
      groundingDenom += 1;
    }
  }
  const claim_grounding_pct = groundingDenom > 0 ? Math.round(groundingSumPct / groundingDenom) : null;
  return Object.freeze({
    lessons: bodies.length,
    total_claims: totalClaims,
    cited_count: citedCount,
    coverage_pct: Math.max(0, Math.min(100, Math.round(rawPct))),
    sources: sourcesAcross.size,
    gate_pass_count: perBody.filter((r) => r.gate_passed).length,
    gate_fail_count: perBody.filter((r) => !r.gate_passed).length,
    threshold: perBody[0].threshold,
    claim_grounding_pct,
    orphan_claims: totalOrphanClaims,
    bodies_with_ledger: bodiesWithLedger,
  });
}

module.exports = {
  DEFAULT_COVERAGE_THRESHOLD_PCT,
  computeBodyCoverage,
  aggregateCoverage,
};
