'use strict';

// HYPHA · W7.3 Citation System · main entry (BLUEPRINT §12.7 / §22.2)
//
// Single import for callers (lesson body / spark / note / radar / UI):
//
//   const cs = require('./lib/citation-system');
//   const cite = cs.createCitation({ type:'paper', source_id:'2604.05485', source_url:'https://arxiv.org/abs/2604.05485' });
//   const trust = cs.computeGlobalTrust(cite);
//   const risk  = cs.assessCopyrightRisk({ content:body, citation:cite, intent:'public_lesson' });
//   const md    = cs.renderCitationFootnote(cite);
//
// Orchestrator-level helpers (annotateCitations, scanAndAnnotate) compose
// the four submodules so a caller can in one call:
//   1. extract URLs from prose,
//   2. promote each unique URL into a web_url citation,
//   3. classify trust + risk,
//   4. return both the rendered footnotes and the structured payload.

const citation = require('./citation');
const linkScanner = require('./external-link-scanner');
const copyrightBoundary = require('./copyright-boundary');
const globalTrust = require('./global-trust');
const coverage = require('./coverage');

/**
 * Promote each unique URL in `text` into a web_url citation primitive.
 * Useful for Notes / Radar reports / Sparks that capture freeform URLs.
 *
 * @param {string} text
 * @param {{ intent?:string }} [opts]
 * @returns {Array<{ citation:object, trust:object, risk:object }>}
 */
function harvestCitationsFromText(text, opts) {
  const o = opts || {};
  const scan = linkScanner.scanContentForExternalLinks(text);
  return scan.urls.map((u) => {
    const cite = citation.createCitation({
      type: 'web_url',
      source_id: u.url,
      source_url: u.url,
      snippet: '',
      attribution: u.domain,
    });
    const trust = globalTrust.computeGlobalTrust(cite);
    const risk = copyrightBoundary.assessCopyrightRisk({
      content: text,
      citation: cite,
      intent: o.intent || 'private_learn',
    });
    return { citation: cite, trust, risk, tier: u.tier };
  });
}

/**
 * One-shot annotate: take an array of citation primitives + per-citation
 * meta (pack/book/content) and return them annotated with trust+risk.
 *
 * @param {Array<object>} citations
 * @param {Array<{ pack?:object, book?:object, content?:string, intent?:string }>} [metasPerCitation]
 * @returns {Array<{ citation, trust, risk, footnote }>}
 */
function annotateCitations(citations, metasPerCitation) {
  if (!Array.isArray(citations)) return [];
  const metas = Array.isArray(metasPerCitation) ? metasPerCitation : [];
  return citations.map((c, i) => {
    const meta = metas[i] || {};
    const trust = globalTrust.computeGlobalTrust(c, { pack: meta.pack, book: meta.book });
    const risk = copyrightBoundary.assessCopyrightRisk({
      content: meta.content || c.snippet || '',
      citation: c,
      intent: meta.intent || 'private_learn',
      pack: meta.pack,
    });
    return {
      citation: c,
      trust,
      risk,
      footnote: citation.renderCitationFootnote(c, meta.language),
    };
  });
}

module.exports = {
  // re-exports — flat surface to keep callers from reaching into submodules
  CITATION_TYPES: citation.CITATION_TYPES,
  createCitation: citation.createCitation,
  parseCitationToken: citation.parseCitationToken,
  renderCitationFootnote: citation.renderCitationFootnote,
  formatAttribution: citation.formatAttribution,

  TIERS: linkScanner.TIERS,
  extractURLs: linkScanner.extractURLs,
  classifyURL: linkScanner.classifyURL,
  scanContentForExternalLinks: linkScanner.scanContentForExternalLinks,

  RISK_LEVELS: copyrightBoundary.RISK_LEVELS,
  INTENTS: copyrightBoundary.INTENTS,
  assessCopyrightRisk: copyrightBoundary.assessCopyrightRisk,
  getBoundaryWarning: copyrightBoundary.getBoundaryWarning,

  computeGlobalTrust: globalTrust.computeGlobalTrust,
  rankCitations: globalTrust.rankCitations,

  // coverage — % claims grounded gate + Trust Panel surface
  DEFAULT_COVERAGE_THRESHOLD_PCT: coverage.DEFAULT_COVERAGE_THRESHOLD_PCT,
  computeBodyCoverage: coverage.computeBodyCoverage,
  aggregateCoverage: coverage.aggregateCoverage,

  // composed helpers
  harvestCitationsFromText,
  annotateCitations,
};
