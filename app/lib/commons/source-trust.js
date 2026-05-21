'use strict';

// HYPHA · Commons · Source Trust (Wave 6.5 Commons full)
//
// Implements BLUEPRINT.md §12.5 Source Trust — 5-signal weighted trust
// score (0-100) for community packs. Distinct from `quality_score` in
// pack-intelligence-card.js: trust = WHO + HOW LONG + WHO ENDORSED + WHAT
// IT CITES. Quality = pack's intrinsic completeness.
//
// Both surface to the user as separate badges. Together they form the
// "可信度" pair shown next to every Commons Pack card.
//
// Source signals (all 0..1, weighted sum × 100):
//   - author_pubkey:    signed by known curator key?         (weight 0.20)
//   - ratified_by_count: how many ratifiers endorse?         (weight 0.25)
//   - age_months:        too fresh = untested, too old = stale  (weight 0.10)
//   - citations_count:   how many recommended_sources cited?  (weight 0.20)
//   - source_reputation: avg reputation of cited sources     (weight 0.25)
//
// Source reputation list (`SOURCE_REPUTATION_DOMAINS`) is local + static —
// no network call. Expanded as Wave 7+ adds Frontier source registry.

const community = require('../community');

const TRUST_WEIGHTS = Object.freeze({
  author_pubkey:       0.20,
  ratified_by_count:   0.25,
  age_months:          0.10,
  citations_count:     0.20,
  source_reputation:   0.25,
});

const SOURCE_TRUST_SIGNALS = Object.freeze({
  author_pubkey:       0, // 0..1 — set to 1 if pack.curator_pubkey verified
  ratified_by_count:   0,
  age_months:          0,
  citations_count:     0,
  source_reputation:   0,
});

// Reputation lookup for known canonical domains. Score = 0..1.
// Curated; reviewed quarterly per Source Trust §12.5.
const SOURCE_REPUTATION_DOMAINS = Object.freeze({
  // Academic / canonical
  'plato.stanford.edu':       1.00,
  'arxiv.org':                0.95,
  'openreview.net':           0.95,
  'nature.com':               0.95,
  'science.org':              0.95,
  'pubmed.ncbi.nlm.nih.gov':  0.95,
  'jstor.org':                0.90,
  'mit.edu':                  0.90,
  'cam.ac.uk':                0.90,
  'ox.ac.uk':                 0.90,
  'harvard.edu':              0.90,
  // Reference / encyclopedia
  'iep.utm.edu':              0.85, // Internet Encyclopedia of Philosophy
  'britannica.com':           0.80,
  'wikipedia.org':            0.65, // good index, weaker primary
  // Engineering / docs
  'github.com':               0.70,
  'developer.mozilla.org':    0.85,
  // Curated long-form
  'lesswrong.com':            0.65,
  'substack.com':             0.50, // domain too broad
  'medium.com':               0.40,
  // Defaults: domains not listed score 0.50 (unknown but not suspicious).
});

// Known-curator pubkey allowlist. v0.1 = single org curator.
const KNOWN_CURATORS = Object.freeze(new Set([
  'hypha-org', 'hypha-team',
]));

/**
 * 5 trust signals computed from pack metadata.
 *
 * @param {object} pack
 * @returns {object} signals — keys match SOURCE_TRUST_SIGNALS, values 0..1
 */
function computeSignals(pack) {
  // 1. Author pubkey — proxy: curator in allowlist
  const curator = String(pack.curator || '').toLowerCase().trim();
  const author_pubkey = KNOWN_CURATORS.has(curator) ? 1 : 0;

  // 2. Ratified by count — log scale, saturates at 5
  const ratifiedN = Array.isArray(pack.ratified_by) ? pack.ratified_by.length : 0;
  const ratified_by_count = Math.min(1, ratifiedN / 5);

  // 3. Age months — sweet spot 3-18 months; <1 = too fresh, >24 = decayed
  let age_months = 0;
  const ratifiedMs = Date.parse(pack.ratified_at || '');
  if (Number.isFinite(ratifiedMs)) {
    const ageMo = (Date.now() - ratifiedMs) / (1000 * 60 * 60 * 24 * 30);
    if (ageMo < 1) age_months = 0.5;           // brand-new, untested
    else if (ageMo <= 18) age_months = 1.0;    // mature + maintained
    else if (ageMo <= 24) age_months = 0.7;
    else if (ageMo <= 36) age_months = 0.4;
    else age_months = 0.1;
  }

  // 4. Citation count — saturates at 8 sources
  const sourcesN = Array.isArray(pack.recommended_sources) ? pack.recommended_sources.length : 0;
  const citations_count = Math.min(1, sourcesN / 8);

  // 5. Source reputation — avg over reputable domain lookups
  let source_reputation = 0;
  if (sourcesN > 0) {
    let sum = 0;
    let counted = 0;
    for (const src of pack.recommended_sources) {
      let rep = 0.50; // unknown default
      if (src && src.url) {
        try {
          const domain = new URL(src.url).hostname.toLowerCase().replace(/^www\./, '');
          // Walk subdomains: edu.stanford.edu → stanford.edu lookup
          const parts = domain.split('.');
          for (let i = 0; i < parts.length - 1; i++) {
            const candidate = parts.slice(i).join('.');
            if (SOURCE_REPUTATION_DOMAINS[candidate] != null) {
              rep = SOURCE_REPUTATION_DOMAINS[candidate];
              break;
            }
          }
        } catch (_) { /* malformed URL → unknown */ }
      } else if (src && src.title) {
        // Title-only citations (books) — score 0.75; cannot verify, but
        // explicit book references are higher trust than bare URLs.
        rep = 0.75;
      }
      sum += rep;
      counted++;
    }
    source_reputation = counted > 0 ? sum / counted : 0;
  }

  return Object.freeze({
    author_pubkey,
    ratified_by_count,
    age_months,
    citations_count,
    source_reputation,
  });
}

/**
 * Weighted sum × 100 → integer 0..100.
 *
 * @param {object} pack
 * @returns {number} trust score 0..100
 */
function computeTrustScore(pack) {
  if (!pack) return 0;
  const signals = computeSignals(pack);
  let score = 0;
  for (const k of Object.keys(TRUST_WEIGHTS)) {
    score += (signals[k] || 0) * TRUST_WEIGHTS[k];
  }
  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

/**
 * Annotate a pack with full trust breakdown for UI display.
 *
 * @returns {{ score, signals, weights }}
 */
function trustBreakdown(pack) {
  return {
    score: computeTrustScore(pack),
    signals: computeSignals(pack),
    weights: TRUST_WEIGHTS,
  };
}

/**
 * Stale = older than 12 months (delegates to community.js to keep the
 * single source of truth for staleness threshold).
 */
function getStaleness(pack) {
  return community.isPackStale(pack);
}

module.exports = {
  SOURCE_TRUST_SIGNALS,
  TRUST_WEIGHTS,
  SOURCE_REPUTATION_DOMAINS,
  KNOWN_CURATORS,
  computeSignals,
  computeTrustScore,
  trustBreakdown,
  getStaleness,
};
