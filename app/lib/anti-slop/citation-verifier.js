'use strict';

// HYPHA · Citation Verifier (AMD-MEOW-P7, v0.4 anti-slop tranche)
//
// Pure heuristic, no LLM. Given LLM-generated text + slug, extract every
// claimed quotation ("原文写道: '...'" / "as the chapter says: '...'" /
// markdown blockquote / long quoted spans) and verify each against the
// chapter-shaped corpus in `vault/<slug>/sources.json`.
//
// Verdict ladder per trigram-Jaccard against the best-matching sliding
// window of the concatenated corpus:
//
//   jaccard >= 0.80   → 'verified'              (likely a direct quote)
//   0.40 ≤ j < 0.80   → 'partial-match'         (paraphrase or partial)
//   jaccard <  0.40   → 'unverified'            (LLM probably fabricated)
//
// If sources.json is missing or empty, every candidate is tagged
// 'no-source-to-verify' — we can't blame the LLM when there's nothing
// to compare against. Caller decides downstream policy.
//
// Integration TODO (v0.4 anti-slop stack):
//   集成 v0.4 anti-slop stack 后, agent.js streamTurn finally 块会调:
//     const cit = await verifyCitations(_streamResult.accumulated, slug);
//     if (cit.summary.unverified > 0) _hyphaAppendEvent('citations_unverified', cit.summary);
//
//   当前本模块独立可调用,集成留 v0.4 TODO。
//   intentional-placeholder: streamTurn wiring deferred per task brief — this
//   module ships standalone (IPC + preload bridge) so anti-slop tranche can
//   land without touching the streamTurn hot path; v0.4 anti-slop expansion
//   owns the streamTurn integration per blueprint §24 P1.
//
// 公开 API:
//   verifyCitations(text, slug, options?) → { verifications, summary }
//     options.minCitationChars  (default 8)
//     options.windowSize        (default 500)
//     options.windowOverlap     (default 100)
//     options.verifiedThreshold (default 0.80)
//     options.partialThreshold  (default 0.40)
//     options.maxCandidates     (default 200) — defensive cap; long texts
//                                w/ heavy quoting otherwise re-scan the
//                                corpus O(N*M) times.

const vault = require('../vault');

// --- archetype-aware thresholds (Machino-α9, 2026-05-15) -------------------
//
// 6 archetypes per pedagogy.md (LANG-ACQ / TECH-CONCEPT / TECH-PROC / HUMANITIES
// / DECL-MASS) plus MINDSET. Each archetype gets its own `verified` jaccard
// floor — TECH-* / DECL-MASS stay strict (0.8), HUMANITIES / LANG-ACQ loosen
// to 0.65 (translations + paraphrase are first-class), MINDSET sits at 0.7.
//
// `partialThreshold` stays caller-controlled (default 0.40) — we only need to
// move the verified ceiling. HUMANITIES additionally substitutes verdict
// 'unsourced-allowed' for jaccard < partial AND no source match (humanities
// courses routinely discuss canonical passages without sources.json mirror).
const ARCHETYPE_THRESHOLDS = Object.freeze({
  'TECH-CONCEPT':  0.80,
  'TECH-PROC':     0.80,
  'DECL-MASS':     0.80,
  'HUMANITIES':    0.65,
  'LANG-ACQ':      0.65,
  'MINDSET':       0.70,
});

// --- regex menagerie -------------------------------------------------------
//
// Order matters in the candidate list only for reporting; dedup happens by
// normalized content. We collect from FOUR families:
//   (1) markdown blockquote lines:        `> something`
//   (2) anchored quotation (CN/EN):       原文写道:"..." / as X puts it:"..."
//   (3) curly-quoted spans (CN):           "..."  (≥ 8 chars)
//   (4) straight-quoted spans (EN):       "..." (≥ 8 chars)
//
// The anchored family is captured first so it can carry the anchor phrase as
// `anchor` metadata; the bare-quote family then runs and dedups by content.

const RE_BLOCKQUOTE = /^>[ \t]+(.+?)\s*$/gm;

// Anchor phrases that introduce a verbatim citation. Captures the anchor
// text + the following quoted span (either CN curly or EN straight).
const RE_ANCHORED = new RegExp(
  '(' +
    // CN anchors
    '原文写道|原文是|原话是|原文如下|书中写道|文中写道|书中说|文中说|作者写道|作者说' +
    '|' +
    // EN anchors (case-insensitive handled via /i flag)
    'as the chapter (?:says|puts it|writes)' +
    '|as (?:the )?(?:author|book|text) (?:says|puts it|writes)' +
    '|the original (?:text )?(?:says|reads)' +
    '|verbatim' +
    '|quote' +
  ')' +
  // Optional separator: colon (CN/EN), em-dash, or whitespace
  '[\\s\\u3000]*[:：—\\-]?[\\s\\u3000]*' +
  // The quoted span — either CN curly OR EN straight; ≥ 8 chars
  '(?:' +
    '\\u201C([^\\u201C\\u201D]{8,})\\u201D' +    // CN curly “…”
    '|' +
    '"([^"\\n]{8,})"' +                          // EN straight "…"
  ')',
  'gi'
);

// Standalone curly-quoted span (CN). ≥ 8 chars between “ and ”.
const RE_CURLY = /“([^“”]{8,})”/g;

// Standalone straight-quoted span (EN). ≥ 8 chars between " and ".
// Avoids spanning newlines so we don't merge two unrelated quotes.
const RE_STRAIGHT = /"([^"\n]{8,})"/g;

// --- trigram + jaccard -----------------------------------------------------

/**
 * Normalize text for trigram comparison.
 * Lowercase + strip punctuation, whitespace, and bracket families. Keeps CJK
 * + alphanumerics intact (trigram of CJK = 3-char sliding window, still works
 * because each CJK char is a single grapheme).
 */
function _normalizeForTrigrams(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s,.;:!?'"`()\[\]{}<>—\-_、，。；：！？「」『』《》（）【】〔〕]+/g, '');
}

function trigrams(text) {
  const norm = _normalizeForTrigrams(text);
  if (norm.length < 3) return new Set();
  const out = new Set();
  for (let i = 0; i <= norm.length - 3; i++) out.add(norm.slice(i, i + 3));
  return out;
}

function jaccard(setA, setB) {
  if (!setA || !setB) return 0;
  if (setA.size === 0 || setB.size === 0) return 0;
  // Iterate the smaller set for the intersection count.
  let inter = 0;
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  small.forEach(t => { if (big.has(t)) inter += 1; });
  const union = setA.size + setB.size - inter;
  return union <= 0 ? 0 : inter / union;
}

// --- candidate extraction --------------------------------------------------

/**
 * Pull every plausible citation candidate from `text`. Each candidate has:
 *   { citation, kind, anchor?, offset }
 * Dedups by normalized content so the same quote captured by both anchored
 * and bare patterns only shows up once (anchored variant wins, since it
 * carries richer metadata).
 */
function extractCandidates(text, minCitationChars) {
  const min = Number.isFinite(minCitationChars) && minCitationChars > 0
    ? minCitationChars : 8;
  const out = [];
  const seen = new Map(); // normalized → index in `out`

  const _push = (citation, kind, anchor, offset) => {
    const trimmed = String(citation || '').trim();
    if (trimmed.length < min) return;
    const key = _normalizeForTrigrams(trimmed);
    if (!key) return;
    if (seen.has(key)) {
      // Upgrade kind metadata if the new hit is anchored and existing isn't.
      const idx = seen.get(key);
      if (anchor && !out[idx].anchor) {
        out[idx].anchor = anchor;
        out[idx].kind = kind;
      }
      return;
    }
    seen.set(key, out.length);
    out.push({ citation: trimmed, kind, anchor: anchor || null, offset: offset || 0 });
  };

  // (1) anchored — run first so anchor metadata wins on dedup
  let m;
  RE_ANCHORED.lastIndex = 0;
  while ((m = RE_ANCHORED.exec(text)) !== null) {
    const anchor = m[1];
    const body = m[2] || m[3] || '';
    _push(body, 'anchored', anchor, m.index);
  }

  // (2) markdown blockquote
  RE_BLOCKQUOTE.lastIndex = 0;
  while ((m = RE_BLOCKQUOTE.exec(text)) !== null) {
    _push(m[1], 'blockquote', null, m.index);
  }

  // (3) curly CN quotes
  RE_CURLY.lastIndex = 0;
  while ((m = RE_CURLY.exec(text)) !== null) {
    _push(m[1], 'curly-quote', null, m.index);
  }

  // (4) straight EN quotes
  RE_STRAIGHT.lastIndex = 0;
  while ((m = RE_STRAIGHT.exec(text)) !== null) {
    _push(m[1], 'straight-quote', null, m.index);
  }

  return out;
}

// --- corpus sliding window -------------------------------------------------

/**
 * Build the searchable corpus string from a `sources.json` array. Each entry
 * contributes its `title` + `excerpt` (and `text` if present — some legacy
 * entries carried full body inline). Entries are joined with a sentinel space
 * so trigrams don't bleed across chapters.
 */
function _buildCorpusText(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return '';
  const parts = [];
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    const bits = [];
    if (s.title) bits.push(String(s.title));
    if (s.excerpt) bits.push(String(s.excerpt));
    // Some legacy / web-harvest entries carry .text or .content.
    if (s.text) bits.push(String(s.text));
    if (s.content) bits.push(String(s.content));
    if (bits.length) parts.push(bits.join(' '));
  }
  return parts.join('  '); // SOH sentinel — won't appear in real prose
}

/**
 * Best Jaccard between a candidate's trigram set and any sliding window over
 * the corpus. Window measured in NORMALIZED chars (so CJK density isn't
 * inflated).
 *
 * Critical: a fixed window size dilutes short citations against a long window
 * (candidate=30 trigrams, window=500 trigrams → max jaccard ~30/500 ≈ 0.06,
 * below the 'partial' threshold even for a true verbatim hit). To stay robust
 * across citation lengths, we evaluate window sizes ∈ { candidateLen*2,
 * windowSize } and keep the max. The smaller window catches short verbatim
 * quotes; the larger window catches long paraphrased ones.
 */
function bestWindowJaccard(candidateTrigrams, normalizedCorpus, windowSize, windowOverlap) {
  if (candidateTrigrams.size === 0) return { jaccard: 0, windowStart: -1 };
  if (!normalizedCorpus || normalizedCorpus.length < 3) {
    return { jaccard: 0, windowStart: -1 };
  }
  const wsBase = Math.max(64, Number.isFinite(windowSize) ? windowSize : 500);
  const ovRatio = Number.isFinite(windowOverlap) && windowSize ? windowOverlap / windowSize : 0.2;

  // Adaptive window — candidate trigram count ≈ candidate norm-length - 2.
  // Two passes: a TIGHT window (candidate*1.2) so a verbatim quote saturates
  // jaccard >= 0.8 (rejecting only ~20% padding chars from the corpus side),
  // and the BASE window for longer paraphrase-style matches.
  const candidateLen = candidateTrigrams.size + 2;
  const tightWs = Math.max(16, Math.min(wsBase, Math.ceil(candidateLen * 1.2) + 4));
  const windowSizes = tightWs < wsBase ? [tightWs, wsBase] : [wsBase];

  let best = 0;
  let bestStart = -1;
  for (const ws of windowSizes) {
    // Tight windows: 50% overlap so we don't miss a verbatim hit straddling
    // a window boundary. Base windows: caller-configured overlap.
    const ovRatioEff = ws <= 128 ? 0.5 : ovRatio;
    const ov = Math.max(0, Math.min(ws - 1, Math.floor(ws * ovRatioEff)));
    const step = Math.max(1, ws - ov);
    for (let i = 0; i < normalizedCorpus.length; i += step) {
      const end = Math.min(normalizedCorpus.length, i + ws);
      const slice = normalizedCorpus.slice(i, end);
      if (slice.length < 3) continue;
      const winTris = new Set();
      for (let j = 0; j <= slice.length - 3; j++) winTris.add(slice.slice(j, j + 3));
      const j2 = jaccard(candidateTrigrams, winTris);
      if (j2 > best) { best = j2; bestStart = i; }
      // Early exit — a strict verbatim quote saturates above 0.95.
      if (best >= 0.98) break;
      if (end >= normalizedCorpus.length) break;
    }
    if (best >= 0.98) break;
  }
  return { jaccard: best, windowStart: bestStart };
}

// --- verdict ---------------------------------------------------------------

function _verdictFor(j, verifiedThreshold, partialThreshold) {
  if (j >= verifiedThreshold) return 'verified';
  if (j >= partialThreshold)  return 'partial-match';
  return 'unverified';
}

// --- main entry ------------------------------------------------------------

/**
 * Verify every quotation-shaped span in `text` against the `sources.json`
 * for the given curriculum slug.
 *
 * @param {string} text — LLM output to audit.
 * @param {string} slug — vault sub-folder name (e.g. "西方哲学史").
 * @param {object} [options]
 * @returns {Promise<{verifications: Array, summary: object}>}
 */
async function verifyCitations(text, slug, options = {}) {
  // Machino-α9 — default to 'TECH-CONCEPT' (strict) when caller doesn't
  // supply archetype, so existing TECH callsites keep their behavior.
  const archetype = (options.archetype && ARCHETYPE_THRESHOLDS[options.archetype])
    ? options.archetype
    : 'TECH-CONCEPT';
  const archetypeVerifiedThreshold = ARCHETYPE_THRESHOLDS[archetype];

  const opts = {
    minCitationChars:  options.minCitationChars  ?? 8,
    windowSize:        options.windowSize        ?? 500,
    windowOverlap:     options.windowOverlap     ?? 100,
    // Explicit option still wins; otherwise archetype dictates the floor.
    verifiedThreshold: options.verifiedThreshold ?? archetypeVerifiedThreshold,
    partialThreshold:  options.partialThreshold  ?? 0.40,
    maxCandidates:     options.maxCandidates     ?? 200,
  };
  // HUMANITIES gets a new verdict bucket: unverified-but-no-source-found =
  // 'unsourced-allowed' (does NOT count as unverified for the summary).
  const isHumanities = archetype === 'HUMANITIES';

  const candidates = extractCandidates(text || '', opts.minCitationChars)
    .slice(0, opts.maxCandidates);

  const verifications = [];
  if (candidates.length === 0) {
    return {
      verifications,
      summary: {
        total: 0, verified: 0, partial: 0, unverified: 0, no_source: 0,
        unsourced_allowed: 0, archetype_used: archetype,
      },
    };
  }

  // Load sources.json. Missing/empty → every candidate gets 'no-source-to-verify'.
  let sources = null;
  if (slug) {
    try { sources = vault.readJSON(`${slug}/sources.json`, null); }
    catch (_) { sources = null; }
  }
  const haveSources = Array.isArray(sources) && sources.length > 0;

  if (!haveSources) {
    for (const c of candidates) {
      verifications.push({
        citation: c.citation,
        kind: c.kind,
        anchor: c.anchor,
        offset: c.offset,
        verdict: 'no-source-to-verify',
        jaccard: 0,
        windowStart: -1,
      });
    }
    return {
      verifications,
      summary: {
        total: candidates.length,
        verified: 0,
        partial: 0,
        unverified: 0,
        no_source: candidates.length,
        unsourced_allowed: 0,
        archetype_used: archetype,
      },
    };
  }

  // Pre-normalize corpus once; each candidate slides over the same string.
  const corpusRaw = _buildCorpusText(sources);
  const normalizedCorpus = _normalizeForTrigrams(corpusRaw);

  let verified = 0, partial = 0, unverified = 0, unsourcedAllowed = 0;
  for (const c of candidates) {
    const tris = trigrams(c.citation);
    const { jaccard: j, windowStart } = bestWindowJaccard(
      tris, normalizedCorpus, opts.windowSize, opts.windowOverlap
    );
    let verdict = _verdictFor(j, opts.verifiedThreshold, opts.partialThreshold);
    // Machino-α9 — HUMANITIES: an 'unverified' verdict that simply means
    // "no matching window found" is recharacterized as 'unsourced-allowed'
    // so literary discussions of canonical passages don't get punished by
    // the same threshold a TECH course would face.
    if (isHumanities && verdict === 'unverified') verdict = 'unsourced-allowed';

    if (verdict === 'verified')                 verified += 1;
    else if (verdict === 'partial-match')       partial += 1;
    else if (verdict === 'unsourced-allowed')   unsourcedAllowed += 1;
    else                                        unverified += 1;

    verifications.push({
      citation: c.citation,
      kind: c.kind,
      anchor: c.anchor,
      offset: c.offset,
      verdict,
      jaccard: Number(j.toFixed(4)),
      windowStart,
    });
  }

  return {
    verifications,
    summary: {
      total: candidates.length,
      verified,
      partial,
      unverified,
      no_source: 0,
      unsourced_allowed: unsourcedAllowed,
      archetype_used: archetype,
    },
  };
}

module.exports = {
  verifyCitations,
  // Exported for testability + reuse by future v0.4 anti-slop modules.
  extractCandidates,
  trigrams,
  jaccard,
  bestWindowJaccard,
  ARCHETYPE_THRESHOLDS,
};
