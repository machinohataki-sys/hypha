'use strict';
// HYPHA · fidelity-scorer — score converted MD on 0-1 axis.
//
// 综合 (a) HYPHA-MD-SPEC compliance (违规个数) + (b) 内容启发式 (heading
// density / paragraph break density / char density / structure presence /
// length per page) + (c) parsed_level penalty (raw-stash 0.1, ocr 0.7, ...).
//
// 输入: { mdText, ext, expected_pages, parsed_level }
// 输出: {
//   score: 0-1 (round 2dp),
//   tier: 'high' | 'mid' | 'low',
//   breakdown: { heading / paragraph / spec / char_density / structure / length / level_penalty }
// }
//
// 阈值 (per HYPHA-MD-SPEC fidelity tiers):
//   ≥ 0.80 → high (accept, ! confession)
//   0.50 ≤ s < 0.80 → mid (accept + flag confession)
//   < 0.50 → low (auto-rerun 下一级 fallback)
//
// 使用方:
//   file-converter.js — auto-rerun loop (gate < 0.5)
//   library.js — persist score to sources.json
//   lesson-body-generator.js — read score, inject confession field if < 0.7

const { validateSpec, countHeadings, countBlocks } = require('./spec-validator');

// Weights per Leo top-5 fidelity dimensions. Sum = 1.0.
const WEIGHTS = {
  heading_density: 0.20,
  paragraph_density: 0.20,
  spec_compliance: 0.15,
  char_density: 0.15,
  structure_present: 0.15,
  length_ratio: 0.15,
};

// Expected heading count per 1000 chars. 2026-05-19 v2 calibration:
// long-form prose books (HYPHA corpus dominant case per backfill survey of 12
// real manifests) have heading density 0.05-0.5/1k. Academic papers reach 3-5/1k
// but those are <5% of upload volume. v1 values (3-5) penalized legitimate
// prose at 0.013 ratio_score → re-calibrate to prose-anchored 0.5 baseline.
const EXPECTED_HEADING_PER_1K = {
  pdf: 0.5,
  epub: 0.3,
  docx: 0.8,
  html: 0.8,
  md: 1.0,
  txt: 0,
  rtf: 0.6,
};

// Expected paragraph breaks per 1000 chars. v1 values held — prose books
// score well on this dimension already (Tolkien 5.3/1k vs expected 6 → 0.88).
const EXPECTED_PARA_PER_1K = {
  pdf: 8,
  epub: 6,
  docx: 8,
  html: 6,
  md: 8,
  txt: 4,
  rtf: 6,
};

const LEVEL_PENALTY = {
  native: 1.0,
  markitdown: 0.95,
  ocr: 0.70,
  cached: 1.0,
  'raw-extract': 0.50,
  'raw-stash': 0.10,
  unknown: 0.80,
};

function _round(n, places = 2) {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}

/**
 * Score 0-1 based on ratio actual / expected, tolerance window.
 * If actual within ±tolerance% of expected → 1.0
 * Below: linear decay to 0
 * Above: penalize gently (excess structure ! catastrophic)
 */
function _ratioScore(actual, expected, tolerance = 0.5) {
  if (!expected || expected <= 0) return 1.0;
  const ratio = actual / expected;
  if (ratio < 1 - tolerance) return Math.max(0, ratio / (1 - tolerance));
  if (ratio > 2) return 0.6;
  return 1.0;
}

/**
 * Char density (OCR garbage detector). v2 2026-05-19 — uses RATIO unique/total
 * instead of absolute count. v1 had a CJK bug: Chinese 10k-char sample has
 * 2000-5000 unique chars (every Chinese book), v1 capped >500 as "unicode
 * garbage" → all Chinese books mis-scored 0.5.
 *
 * Healthy ratios:
 *   Latin prose:  unique/total ≈ 0.005-0.02 (high reuse of 26 letters)
 *   Chinese prose: unique/total ≈ 0.15-0.40 (large character set, less reuse)
 *   OCR garbage (repeating):     ≈ 0.001-0.005
 *   Random byte soup / encoding error: ≈ 0.6-1.0
 *
 * Healthy windows split by detected script.
 */
function _charDensityScore(mdText) {
  if (!mdText || mdText.length < 10) return 0;
  const sample = mdText.slice(0, 10000);
  const uniqueChars = new Set(sample.split('')).size;
  const total = sample.length;
  const ratio = uniqueChars / total;

  // Detect CJK presence — if substantial CJK content, expect higher unique ratio
  const cjkMatches = (sample.match(/[一-鿿㐀-䶿]/g) || []).length;
  const cjkRatio = cjkMatches / total;

  if (cjkRatio > 0.2) {
    // CJK-dominant: expect ratio 0.10-0.40 healthy
    if (ratio < 0.02) return 0.2;   // too few unique = repeating OCR garbage
    if (ratio < 0.05) return 0.5;   // sparse
    if (ratio > 0.55) return 0.4;   // unrealistic uniqueness (encoding garbage)
    return 1.0;                      // 0.05-0.55 → healthy CJK
  } else {
    // Latin-dominant: expect ratio 0.005-0.04 healthy
    if (ratio < 0.003) return 0.2;
    if (ratio < 0.008) return 0.6;
    if (ratio > 0.10) return 0.5;    // suspicious uniqueness
    return 1.0;                       // 0.008-0.10 → healthy Latin
  }
}

/**
 * @param {{ mdText: string, ext?: string, expected_pages?: number, parsed_level?: string }} input
 * @returns {{ score: number, tier: string, breakdown: object }}
 */
function scoreFidelity(input) {
  const inp = input || {};
  const { mdText, ext, expected_pages, parsed_level } = inp;

  if (typeof mdText !== 'string' || mdText.length === 0) {
    return {
      score: 0,
      tier: 'low',
      breakdown: { reason: 'empty mdText' },
    };
  }

  const len = mdText.length;
  const extKey = String(ext || '').toLowerCase().replace(/^\./, '');

  const headings = countHeadings(mdText);
  const blocks = countBlocks(mdText);
  const specCheck = validateSpec(mdText);

  // 1. heading_density: headings per 1000 chars
  const actualHD = (headings.total * 1000) / len;
  const expectedHD = EXPECTED_HEADING_PER_1K[extKey] != null ? EXPECTED_HEADING_PER_1K[extKey] : 4.0;
  const headingScore = expectedHD === 0 ? 1.0 : _ratioScore(actualHD, expectedHD);

  // 2. paragraph_density: \n\n per 1000 chars
  const paraBreaks = (mdText.match(/\n\n/g) || []).length;
  const actualPD = (paraBreaks * 1000) / len;
  const expectedPD = EXPECTED_PARA_PER_1K[extKey] != null ? EXPECTED_PARA_PER_1K[extKey] : 6;
  const paraScore = _ratioScore(actualPD, expectedPD);

  // 3. spec_compliance: 1 - violations / lines (capped at 0)
  const lineCount = Math.max(1, mdText.split('\n').length);
  const specScore = specCheck.violations.length === 0
    ? 1.0
    : Math.max(0, 1 - (specCheck.violations.length / lineCount) * 10); // scale: 10 violations / 100 lines = 0

  // 4. char_density (OCR garbage detector)
  const charScore = _charDensityScore(mdText);

  // 5. structure_present: v2 2026-05-19 — prose books (HYPHA dominant case)
  // have headings + paragraphs but typically no code/tables/images. Penalizing
  // for absence of those structures unfairly drops prose to 0.3. New floor 0.6
  // when ANY structure present (i.e. at least chapter headings detected).
  const structureCount = headings.total + blocks.lists + blocks.codeBlocks + blocks.tables;
  let structureScore;
  if (structureCount === 0) structureScore = 0.4;  // pure unstructured prose
  else if (structureCount >= 5) structureScore = 1.0;
  else structureScore = 0.6 + (structureCount / 5) * 0.4;

  // 6. length_ratio: chars per page (if expected_pages provided)
  let lengthScore = 1.0;
  let charsPerPage = null;
  if (expected_pages && expected_pages > 0) {
    charsPerPage = len / expected_pages;
    if (charsPerPage < 100) lengthScore = 0.1;       // ~empty page extraction
    else if (charsPerPage < 300) lengthScore = 0.4;  // sparse, likely OCR failure
    else if (charsPerPage < 600) lengthScore = 0.7;
    else if (charsPerPage <= 4000) lengthScore = 1.0; // healthy density
    else if (charsPerPage <= 8000) lengthScore = 0.85; // dense (academic 2-col)
    else lengthScore = 0.6; // anomalously dense — possibly merged columns
  }

  // Composite (weighted average)
  const rawScore =
    WEIGHTS.heading_density * headingScore +
    WEIGHTS.paragraph_density * paraScore +
    WEIGHTS.spec_compliance * specScore +
    WEIGHTS.char_density * charScore +
    WEIGHTS.structure_present * structureScore +
    WEIGHTS.length_ratio * lengthScore;

  // Apply level penalty
  const levelKey = String(parsed_level || 'unknown').toLowerCase();
  const penalty = LEVEL_PENALTY[levelKey] != null ? LEVEL_PENALTY[levelKey] : LEVEL_PENALTY.unknown;
  const finalScore = Math.max(0, Math.min(1, rawScore * penalty));

  return {
    score: _round(finalScore, 2),
    tier: tier(finalScore),
    breakdown: {
      heading: {
        score: _round(headingScore),
        count: headings.total,
        byLevel: headings.byLevel,
        per_1k: _round(actualHD, 2),
        expected_per_1k: expectedHD,
      },
      paragraph: {
        score: _round(paraScore),
        breaks: paraBreaks,
        per_1k: _round(actualPD, 2),
        expected_per_1k: expectedPD,
      },
      spec: {
        score: _round(specScore),
        violations: specCheck.violations.length,
        sample: specCheck.violations.slice(0, 3),
      },
      char_density: {
        score: _round(charScore),
      },
      structure: {
        score: _round(structureScore),
        lists: blocks.lists,
        code_blocks: blocks.codeBlocks,
        tables: blocks.tables,
        image_refs: blocks.imageRefs,
        footnotes: blocks.footnotes,
        blockquotes: blocks.blockquotes,
      },
      length: {
        score: _round(lengthScore),
        chars: len,
        pages: expected_pages || null,
        chars_per_page: charsPerPage != null ? Math.round(charsPerPage) : null,
      },
      level_penalty: penalty,
      ext: extKey,
      parsed_level: levelKey,
    },
  };
}

/**
 * Score → tier label.
 */
function tier(score) {
  if (score >= 0.80) return 'high';
  if (score >= 0.50) return 'mid';
  return 'low';
}

module.exports = {
  scoreFidelity,
  tier,
  WEIGHTS,
  LEVEL_PENALTY,
};
