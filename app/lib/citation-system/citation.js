'use strict';

// HYPHA · W7.3 Citation System · core (BLUEPRINT.md §12.7 / §22.2)
//
// Global, cross-module Citation primitives. W6.5 commons/* shipped Pack-only
// trust + license; this stream lifts the same concepts to LESSON BODY,
// NOTE, SPARK, RESEARCH RADAR — anywhere a claim needs a verifiable referent.
//
// Boundary discipline:
//   - Reuses W6.5 commons/source-trust + commons/security-layer (do NOT
//     reimplement domain reputation / URL scan). See global-trust.js +
//     external-link-scanner.js for the wiring.
//   - Compatible with R-LIB Day 5 `[CITE:b:c]` token (book / pack types).
//     Existing lesson-body-generator.js _extractCitations stays canonical
//     for the lesson body inline-marker path; this module provides the
//     surface layer that Notes / Sparks / Radar reports also call.
//
// Citation primitive — frozen pure data, no I/O. Higher layers persist.

const CITATION_TYPES = Object.freeze([
  'book',      // R-LIB: book_id + chunk_idx (resolved via library)
  'pack',      // Commons: pack_id + curator (resolved via community.js)
  'paper',     // arXiv / OpenReview / journal — has DOI or arXiv id
  'web_url',   // bare URL — trust derived from domain reputation
  'lesson',    // internal: vault/<slug>/lesson-N (no external trust)
  'note',      // internal: vault/<slug>/notes/<id> (no external trust)
  'spark',     // internal: vault/<slug>/product/sparks/<id>
]);

// Token shapes recognised by parseCitationToken. Matches R-LIB Day 5
// shape so the existing lesson-body marker stream stays interoperable:
//   [CITE:book_id:chunk_idx]
//   [CITE:pack:pack_id]
//   [CITE:paper:arxiv_id]
//   [CITE:url:opaque_url_id]
//   [CITE:lesson:slug/N]
//   [CITE:note:slug/note_id]
//   [CITE:spark:slug/spark_id]
const CITE_TOKEN_RE = /\[CITE:([^:\s\]]+):([^\]\s]+)\]/g;

const _RESERVED_PREFIXES = Object.freeze(new Set([
  'pack', 'paper', 'url', 'web_url', 'lesson', 'note', 'spark',
]));

/**
 * Build a frozen citation object. Throws on invalid type.
 *
 * @param {object} args
 * @param {string} args.type             one of CITATION_TYPES
 * @param {string} args.source_id        opaque id (book_id / pack_id / arxiv id / lesson slug+idx / etc.)
 * @param {string} [args.source_url]     optional URL — required for web_url, paper
 * @param {(number|string)} [args.page_or_idx] chunk_idx / page / paragraph idx
 * @param {string} [args.snippet]        ≤500 char excerpt for the footnote
 * @param {string} [args.attribution]    author / curator string ("Spinoza, Ethics Pt I")
 * @returns {Readonly<object>}
 */
function createCitation(args) {
  const a = args || {};
  if (!CITATION_TYPES.includes(a.type)) {
    throw new Error(`createCitation: invalid type "${a.type}". Expected one of: ${CITATION_TYPES.join(', ')}`);
  }
  if (!a.source_id || typeof a.source_id !== 'string') {
    throw new Error('createCitation: source_id required (non-empty string)');
  }
  if ((a.type === 'web_url' || a.type === 'paper') && !a.source_url) {
    throw new Error(`createCitation: source_url required for type "${a.type}"`);
  }
  const snippet = (a.snippet == null) ? '' : String(a.snippet).slice(0, 500);
  const out = {
    type: a.type,
    source_id: String(a.source_id),
    source_url: a.source_url ? String(a.source_url) : null,
    page_or_idx: (a.page_or_idx == null) ? null : a.page_or_idx,
    snippet,
    attribution: a.attribution ? String(a.attribution).slice(0, 240) : null,
    created_at: new Date().toISOString(),
  };
  return Object.freeze(out);
}

/**
 * Parse all `[CITE:type:id]` (and book-shorthand `[CITE:b:c]`) tokens out of
 * a freeform string. Tokens without a reserved-prefix `type` are treated as
 * book citations (id1 = book_id, id2 = chunk_idx) for R-LIB compatibility.
 *
 * @param {string} text
 * @returns {Array<{ raw, type, source_id, page_or_idx }>}
 */
function parseCitationToken(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  CITE_TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = CITE_TOKEN_RE.exec(text)) !== null) {
    const id1 = m[1];
    const id2 = m[2];
    let type, source_id, page_or_idx = null;
    if (_RESERVED_PREFIXES.has(id1)) {
      // Normalize "url" → "web_url" so callers always see CITATION_TYPES values.
      type = (id1 === 'url') ? 'web_url' : id1;
      source_id = id2;
    } else {
      // Default = book: id1 = book_id, id2 = chunk_idx (R-LIB Day 5 shape).
      type = 'book';
      source_id = id1;
      const parsed = parseInt(id2, 10);
      page_or_idx = Number.isFinite(parsed) ? parsed : id2;
    }
    out.push(Object.freeze({ raw: m[0], type, source_id, page_or_idx }));
  }
  return out;
}

/**
 * Render a citation as a Markdown footnote line. Idempotent + side-effect-free.
 *
 * @param {object} citation  result of createCitation OR raw shape
 * @param {string} [language='zh']  'zh' | 'en' — affects connective words
 * @returns {string}
 */
function renderCitationFootnote(citation, language) {
  if (!citation || typeof citation !== 'object') return '';
  const lang = (language === 'en') ? 'en' : 'zh';
  const tag = `[^${citation.source_id}]`;
  const attribution = formatAttribution(citation);
  const snippetLine = citation.snippet
    ? (lang === 'zh' ? `\n> ${citation.snippet}` : `\n> ${citation.snippet}`)
    : '';
  const urlLine = citation.source_url
    ? (lang === 'zh' ? `\n  原文: ${citation.source_url}` : `\n  source: ${citation.source_url}`)
    : '';
  return `${tag}: ${attribution}${snippetLine}${urlLine}`;
}

/**
 * Format a one-line attribution string for inline use. Type-aware: books
 * lead with author; packs with curator; papers with arXiv id; web_url
 * with hostname.
 */
function formatAttribution(citation) {
  if (!citation || typeof citation !== 'object') return 'Unknown source';
  const t = citation.type || 'web_url';
  const explicit = citation.attribution ? String(citation.attribution).trim() : '';
  if (explicit) {
    // Caller-provided attribution wins — use as-is + suffix idx if useful.
    return citation.page_or_idx != null
      ? `${explicit} (#${citation.page_or_idx})`
      : explicit;
  }
  switch (t) {
    case 'book':
      return citation.page_or_idx != null
        ? `Book ${citation.source_id}, chunk ${citation.page_or_idx}`
        : `Book ${citation.source_id}`;
    case 'pack':
      return `Commons pack "${citation.source_id}"`;
    case 'paper': {
      const host = _safeHost(citation.source_url);
      return citation.source_url
        ? `Paper ${citation.source_id} (${host})`
        : `Paper ${citation.source_id}`;
    }
    case 'web_url': {
      const host = _safeHost(citation.source_url) || citation.source_id;
      return host;
    }
    case 'lesson':  return `Lesson ${citation.source_id}`;
    case 'note':    return `Note ${citation.source_id}`;
    case 'spark':   return `Spark ${citation.source_id}`;
    default:        return citation.source_id;
  }
}

function _safeHost(url) {
  if (!url || typeof url !== 'string') return null;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch (_) { return null; }
}

module.exports = {
  CITATION_TYPES,
  CITE_TOKEN_RE,
  createCitation,
  parseCitationToken,
  renderCitationFootnote,
  formatAttribution,
};
