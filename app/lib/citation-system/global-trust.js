'use strict';

// HYPHA · W7.3 Citation System · global-trust (BLUEPRINT §12.7)
//
// Cross-module trust scoring. W6.5 commons/source-trust ships Pack-level
// weighted trust (0-100). This module:
//   1. Delegates pack/book citations to W6.5 computeTrustScore.
//   2. Adds CITATION-TYPE specific adjustments:
//        - paper       → +10 if peer-reviewed (via attribution hint)
//        - web_url     → derive from URL classifier tier
//        - lesson/note/spark → 0 (internal, no external trust signal)
//   3. Provides rankCitations() — stable sort by trust DESC.
//
// All scores normalized to 0-100 integer. NEVER mutates inputs.

const sourceTrust = require('../commons/source-trust');
const linkScanner = require('./external-link-scanner');

const PEER_REVIEWED_HINTS = Object.freeze([
  /\bpeer[- ]?reviewed\b/i,
  /\bjournal\b/i,
  /\barxiv\b/i,
  /\bopenreview\b/i,
  /\bnature\b/i,
  /\bscience\b/i,
  /\bproceedings\b/i,
  /\bjstor\b/i,
  /\bpubmed\b/i,
  /\bdoi:\s*10\./i,
]);

// Map URL tier → 0-100 base score.
const TIER_BASE = Object.freeze({
  safe:     85,
  caution:  50,
  unsafe:   20,
  phishing: 0,
});

/**
 * Compute trust 0-100 for a citation. Type-aware.
 *
 * @param {object} citation         citation primitive (citation.js)
 * @param {object} [opts]
 * @param {object} [opts.pack]      pack metadata (required for type='pack')
 * @param {object} [opts.book]      book metadata (optional, type='book')
 * @returns {{ score:number, breakdown:object }}
 */
function computeGlobalTrust(citation, opts) {
  if (!citation || typeof citation !== 'object') {
    return { score: 0, breakdown: { reason: 'invalid citation' } };
  }
  const o = opts || {};
  const t = citation.type;

  // Internal sources — user-owned, no external trust to compute.
  if (t === 'lesson' || t === 'note' || t === 'spark') {
    return {
      score: 0,
      breakdown: { source: 'internal', reason: `internal ${t} — no external trust signal applies` },
    };
  }

  // Pack — delegate to W6.5.
  if (t === 'pack') {
    const pack = o.pack || null;
    if (!pack) {
      return { score: 30, breakdown: { source: 'pack', reason: 'no pack metadata provided — neutral fallback' } };
    }
    const breakdown = sourceTrust.trustBreakdown(pack);
    return { score: breakdown.score, breakdown: Object.assign({ source: 'pack-W6.5' }, breakdown) };
  }

  // Book — W6.5 trust expects pack-shape; map book metadata to a minimal
  // pack-like envelope so the W6.5 weights still apply.
  if (t === 'book') {
    const bookMeta = o.book || {};
    const synthesized = {
      curator: bookMeta.author || bookMeta.curator || 'unknown',
      ratified_by: bookMeta.endorsed_by || [],
      ratified_at: bookMeta.published_at || new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString(), // assume 1yr old
      recommended_sources: bookMeta.sources || [],
    };
    const breakdown = sourceTrust.trustBreakdown(synthesized);
    // Books additionally get +15 for "explicit attribution" since titled books
    // are higher trust than bare URLs (parallels W6.5 source_reputation 0.75).
    const score = Math.min(100, breakdown.score + 15);
    return { score, breakdown: Object.assign({ source: 'book-via-pack-shim', book_bonus: 15 }, breakdown) };
  }

  // Paper — URL reputation + peer-reviewed bonus.
  if (t === 'paper') {
    const url = citation.source_url;
    const classified = url ? linkScanner.classifyURL(url) : { tier: 'caution', reputation: 0.5 };
    let score = TIER_BASE[classified.tier] != null ? TIER_BASE[classified.tier] : 50;
    const hint = (citation.attribution || '') + ' ' + (url || '');
    let peerBonus = 0;
    for (const pat of PEER_REVIEWED_HINTS) {
      if (pat.test(hint)) { peerBonus = 10; break; }
    }
    score = Math.min(100, score + peerBonus);
    return {
      score,
      breakdown: { source: 'paper', tier: classified.tier, tier_base: TIER_BASE[classified.tier], peer_review_bonus: peerBonus, domain: classified.domain },
    };
  }

  // web_url — pure URL classifier driven.
  if (t === 'web_url') {
    const url = citation.source_url;
    if (!url) return { score: 20, breakdown: { source: 'web_url', reason: 'missing source_url' } };
    const classified = linkScanner.classifyURL(url);
    const score = TIER_BASE[classified.tier] != null ? TIER_BASE[classified.tier] : 30;
    return { score, breakdown: Object.assign({ source: 'web_url' }, classified) };
  }

  return { score: 30, breakdown: { source: 'unknown-type', reason: `unrecognised citation type "${t}"` } };
}

/**
 * Rank an array of citations by trust DESC. Stable; preserves original
 * order on ties. Returns a NEW array; does not mutate.
 *
 * @param {Array<object>} citations            citation primitives
 * @param {Array<object>} [optsPerCitation]   optional aligned-by-index opts (pack/book metadata)
 * @returns {Array<{ citation:object, trust:object }>}
 */
function rankCitations(citations, optsPerCitation) {
  if (!Array.isArray(citations) || citations.length === 0) return [];
  const opts = Array.isArray(optsPerCitation) ? optsPerCitation : [];
  const annotated = citations.map((c, i) => ({
    citation: c,
    trust: computeGlobalTrust(c, opts[i] || {}),
    _idx: i,
  }));
  annotated.sort((a, b) => {
    if (b.trust.score !== a.trust.score) return b.trust.score - a.trust.score;
    return a._idx - b._idx;
  });
  return annotated.map(({ citation, trust }) => ({ citation, trust }));
}

module.exports = {
  TIER_BASE,
  PEER_REVIEWED_HINTS,
  computeGlobalTrust,
  rankCitations,
};
