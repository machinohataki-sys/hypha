'use strict';
// HYPHA · Evidence Ledger v1.0 — per-claim provenance (boot-9, 2026-05-20)
//
// AMD-MEOW-P7 / blueprint §24 Phase 1 deferred item. Ships Evidence Ledger
// at the LESSON-BODY level (v0.2.x body schema). Sibling to the existing
// LESSON-PLAN evidence_ledger in `app/lib/lesson-generator.js` — that one
// audits the plan/skeleton; this one audits the body the tutor actually
// reads from.
//
// WHY: Citation Coverage today is aggregate (count claim-bearing fields,
// divide by len(evidence_cite)). It cannot say "thesis IS / IS-NOT grounded,
// misconception[0] IS, misconception[1] IS-NOT" — only an average. Trust
// Panel surface conflates "high cite count" with "every claim cited", which
// gives apparent-success cover to bodies with 80% cites concentrated on
// mechanism and 0 on misconceptions.
//
// HOW: Each claim in the body gets a deterministic claim_id derived from its
// structural position. The body's NEW optional `evidence_ledger[]` carries
// per-claim refs: { claim_id, evidence_refs:[{source_id, weight, kind}] }.
// source_id namespaces by prefix:
//
//   book:<book_id>:<chunk_idx>   — library source (matches evidence_cite shape)
//   pack:<pack_id>               — community pack
//   url:<full-url>               — web source / community URL
//
// Backward-compat: a body WITHOUT evidence_ledger is legal (legacy bodies
// remain valid). The validator only runs shape checks WHEN the field is
// present. Trust Panel surface degrades gracefully: missing → "n/a", present
// → "CLAIMS · 87% grounded · 12 orphan".
//
// All functions pure. No fs, no LLM, no mutation. Frozen outputs.

const VALID_KINDS = Object.freeze(['direct', 'corroborating', 'tangential']);

const SOURCE_ID_PREFIXES = Object.freeze(['book:', 'pack:', 'url:']);

// Deterministic claim-id enumeration. Order MATTERS — same lesson body must
// always yield the same id sequence so ledger entries survive regen. Schema
// here mirrors `coverage._countClaimsInBody` claim-bearing fields, with the
// addition of `canonical_example` (which DOES carry a substantive claim per
// pedagogy.md, even though coverage.js excludes it as a single field).
//
// Enumeration policy:
//   - thesis: 1 claim "thesis"
//   - mechanism: 1 claim "mechanism"
//   - canonical_example: 1 claim "canonical_example"
//   - common_misconceptions[i] → "misconception_<i>"
//   - examples[i] → "example_<i>"  (whether examples[i] is string or {claim:...})
//
// Empty / whitespace-only entries are skipped so the enumeration stays tight.
function enumerateClaimIds(body) {
  if (!body || typeof body !== 'object') return [];
  const out = [];
  if (typeof body.thesis === 'string' && body.thesis.trim().length > 0) out.push('thesis');
  if (typeof body.mechanism_explanation === 'string' && body.mechanism_explanation.trim().length > 0) out.push('mechanism');
  if (typeof body.canonical_example === 'string' && body.canonical_example.trim().length > 0) out.push('canonical_example');
  if (Array.isArray(body.common_misconceptions)) {
    body.common_misconceptions.forEach((m, i) => {
      if (typeof m === 'string' && m.trim().length > 0) out.push(`misconception_${i}`);
    });
  }
  if (Array.isArray(body.examples)) {
    body.examples.forEach((ex, i) => {
      if (typeof ex === 'string' && ex.trim().length > 0) out.push(`example_${i}`);
      else if (ex && typeof ex === 'object' && typeof ex.claim === 'string' && ex.claim.trim().length > 0) out.push(`example_${i}`);
    });
  }
  return out;
}

// Normalise the body's evidence_ledger to a Map<claim_id, refs[]>.
// Tolerant: missing field → empty map; malformed entries skipped silently
// (validateEvidenceRefs returns the structured errors for those).
function buildLedger({ lessonBody }) {
  const map = new Map();
  if (!lessonBody || typeof lessonBody !== 'object') return map;
  const ledger = Array.isArray(lessonBody.evidence_ledger) ? lessonBody.evidence_ledger : [];
  for (const row of ledger) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.claim_id !== 'string' || !row.claim_id.trim()) continue;
    if (!Array.isArray(row.evidence_refs)) continue;
    // Keep only well-shaped refs in the public map (kind / weight / source_id valid).
    const refs = row.evidence_refs.filter(_isValidRef);
    if (refs.length === 0) continue;
    map.set(row.claim_id.trim(), refs.map(_freezeRef));
  }
  return map;
}

function _isValidRef(r) {
  if (!r || typeof r !== 'object') return false;
  if (typeof r.source_id !== 'string' || !r.source_id.trim()) return false;
  if (!SOURCE_ID_PREFIXES.some(p => r.source_id.startsWith(p))) return false;
  const k = r.kind;
  if (k !== undefined && !VALID_KINDS.includes(k)) return false;
  const w = r.weight;
  if (w !== undefined && (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 1)) return false;
  return true;
}

function _freezeRef(r) {
  return Object.freeze({
    source_id: r.source_id,
    weight: typeof r.weight === 'number' ? r.weight : 1,
    kind: r.kind || 'direct',
  });
}

// Compute claim-grounding ratio in [0, 1]. % of enumerated claims that have
// at least ONE valid evidence_ref. Returns 1 when no claims (vacuous).
function computeClaimGrounding({ lessonBody }) {
  const ids = enumerateClaimIds(lessonBody);
  if (ids.length === 0) return 1;
  const ledger = buildLedger({ lessonBody });
  let grounded = 0;
  for (const id of ids) {
    const refs = ledger.get(id);
    if (refs && refs.length > 0) grounded += 1;
  }
  return Number((grounded / ids.length).toFixed(4));
}

// Collect known source-ids available to the body. Pulls from:
//   1. body.evidence_cite[] (already-resolved library + pack markers)
//   2. body.sources[] if present (optional ext array, not in current schema
//      but tolerated for future-proofing)
//
// Returns a Set of normalised source_id strings.
function collectAvailableSourceIds(lessonBody) {
  const ids = new Set();
  if (!lessonBody || typeof lessonBody !== 'object') return ids;
  const cites = Array.isArray(lessonBody.evidence_cite) ? lessonBody.evidence_cite : [];
  for (const c of cites) {
    if (!c || typeof c !== 'object') continue;
    if (c.cite_type === 'library' && c.book_id != null && c.chunk_idx != null) {
      ids.add(`book:${c.book_id}:${c.chunk_idx}`);
    } else if (c.cite_type === 'community' && c.pack_id) {
      ids.add(`pack:${c.pack_id}`);
    }
    // Some cites carry a url alongside; accept both for compat.
    if (typeof c.url === 'string' && c.url) ids.add(`url:${c.url}`);
  }
  // body.sources[] (forward-compat with sources_id arrays — optional schema).
  const sourcesArr = Array.isArray(lessonBody.sources) ? lessonBody.sources : [];
  for (const s of sourcesArr) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.id === 'string' && s.id) ids.add(s.id);
    if (s.book_id != null && s.chunk_idx != null) ids.add(`book:${s.book_id}:${s.chunk_idx}`);
    if (typeof s.pack_id === 'string' && s.pack_id) ids.add(`pack:${s.pack_id}`);
    if (typeof s.url === 'string' && s.url) ids.add(`url:${s.url}`);
  }
  return ids;
}

// Validate each evidence_ref's source_id resolves against available sources.
// Returns array of { claim_id, ref_index, source_id, reason } for INVALID refs
// (source_id not found in body.evidence_cite + body.sources). Well-shaped but
// dangling refs are flagged; refs failing _isValidRef are flagged as 'malformed'.
function validateEvidenceRefs({ lessonBody }) {
  const errors = [];
  if (!lessonBody || typeof lessonBody !== 'object') return errors;
  const ledger = Array.isArray(lessonBody.evidence_ledger) ? lessonBody.evidence_ledger : [];
  const available = collectAvailableSourceIds(lessonBody);
  for (const row of ledger) {
    if (!row || typeof row !== 'object' || typeof row.claim_id !== 'string') continue;
    const refs = Array.isArray(row.evidence_refs) ? row.evidence_refs : [];
    refs.forEach((r, i) => {
      if (!_isValidRef(r)) {
        errors.push({
          claim_id: row.claim_id,
          ref_index: i,
          source_id: r && typeof r === 'object' ? (r.source_id || null) : null,
          reason: 'malformed (missing source_id / bad prefix / bad kind / bad weight)',
        });
        return;
      }
      if (!available.has(r.source_id)) {
        errors.push({
          claim_id: row.claim_id,
          ref_index: i,
          source_id: r.source_id,
          reason: 'source_id not found in body.evidence_cite[] or body.sources[]',
        });
      }
    });
  }
  return errors;
}

// Return enumerated claim_ids that have ZERO valid evidence_refs.
function detectOrphanClaims({ lessonBody }) {
  const ids = enumerateClaimIds(lessonBody);
  const ledger = buildLedger({ lessonBody });
  return ids.filter(id => !ledger.has(id) || ledger.get(id).length === 0);
}

// Aggregate ledger by source_id → array of claim_ids that cite it. Useful for
// Trust Panel "this source backs N claims" inversion + dead-source pruning.
function aggregateSourceUsage({ lessonBody }) {
  const inv = new Map();
  if (!lessonBody || typeof lessonBody !== 'object') return inv;
  const ledger = Array.isArray(lessonBody.evidence_ledger) ? lessonBody.evidence_ledger : [];
  for (const row of ledger) {
    if (!row || typeof row !== 'object' || typeof row.claim_id !== 'string') continue;
    const refs = Array.isArray(row.evidence_refs) ? row.evidence_refs : [];
    for (const r of refs) {
      if (!_isValidRef(r)) continue;
      if (!inv.has(r.source_id)) inv.set(r.source_id, []);
      const arr = inv.get(r.source_id);
      if (!arr.includes(row.claim_id)) arr.push(row.claim_id);
    }
  }
  return inv;
}

// One-shot summary suitable for Trust Panel chip:
//   { total_claims, grounded_claims, grounding_pct, orphan_claims:[],
//     invalid_refs:[], unique_sources_cited }
function summarize({ lessonBody }) {
  const ids = enumerateClaimIds(lessonBody);
  const ledger = buildLedger({ lessonBody });
  const orphan = detectOrphanClaims({ lessonBody });
  const invalid = validateEvidenceRefs({ lessonBody });
  const usage = aggregateSourceUsage({ lessonBody });
  const grounded = ids.length - orphan.length;
  const pct = ids.length === 0 ? 100 : Math.round((grounded / ids.length) * 100);
  return Object.freeze({
    total_claims: ids.length,
    grounded_claims: grounded,
    grounding_pct: pct,
    orphan_claims: Object.freeze(orphan.slice()),
    invalid_refs: Object.freeze(invalid.slice()),
    unique_sources_cited: usage.size,
    ledger_present: Array.isArray(lessonBody && lessonBody.evidence_ledger),
  });
}

module.exports = {
  VALID_KINDS,
  SOURCE_ID_PREFIXES,
  enumerateClaimIds,
  buildLedger,
  computeClaimGrounding,
  collectAvailableSourceIds,
  validateEvidenceRefs,
  detectOrphanClaims,
  aggregateSourceUsage,
  summarize,
  // internal — exposed only for unit tests
  _isValidRef,
};
