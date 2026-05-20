'use strict';
// HYPHA · spec-validator — validate MD against HYPHA-MD-SPEC v1.
//
// In:  mdText (string)
// Out: { valid: bool, violations: [{ rule, line, snippet }] }
//
// Caller: fidelity-scorer.js (computes composite score using violation count).
// SPEC source: app/lib/converters/SPEC.md.

const FORBIDDEN_HTML_TAGS_RE = /^<(div|span|p|table|tr|td|th|tbody|thead|a|img|ul|ol|li|font|center|h[1-6]|article|section|nav|aside|footer|header|main|figure)\b/i;
const INLINE_STYLE_RE = /\bstyle\s*=\s*["']/i;
const RAW_XML_RE = /^<\?xml/i;
const SETEXT_RULE_RE = /^(={3,}|-{3,})\s*$/;

/**
 * Validate MD body against HYPHA-MD-SPEC v1.
 * Frontmatter is OUT of scope (library.js writes that separately).
 *
 * @param {string} mdText
 * @returns {{valid: boolean, violations: Array<{rule:string,line:number,snippet:string}>}}
 */
function validateSpec(mdText) {
  if (typeof mdText !== 'string') {
    return { valid: false, violations: [{ rule: 'input-type', line: 0, snippet: 'mdText must be string' }] };
  }
  const lines = mdText.split('\n');
  const violations = [];
  let inFence = false;
  let prevLine = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code blocks — skip rule checks inside
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      prevLine = line;
      continue;
    }
    if (inFence) {
      prevLine = line;
      continue;
    }

    if (!trimmed) {
      prevLine = line;
      continue;
    }

    // Rule: no HTML passthrough
    if (FORBIDDEN_HTML_TAGS_RE.test(trimmed)) {
      violations.push({
        rule: 'no-html-passthrough',
        line: i + 1,
        snippet: trimmed.slice(0, 80),
      });
    }

    // Rule: no inline style
    if (INLINE_STYLE_RE.test(line)) {
      violations.push({
        rule: 'no-inline-style',
        line: i + 1,
        snippet: trimmed.slice(0, 80),
      });
    }

    // Rule: no raw XML preamble (only check first 5 lines)
    if (i < 5 && RAW_XML_RE.test(trimmed)) {
      violations.push({
        rule: 'no-raw-xml',
        line: i + 1,
        snippet: trimmed.slice(0, 80),
      });
    }

    // Rule: ATX headings only (no setext) — flag `====` / `----` directly under text
    if (SETEXT_RULE_RE.test(trimmed) && prevLine && prevLine.trim() && !/^[-=]/.test(prevLine.trim())) {
      // A line of === or --- following non-empty content = setext heading underline
      violations.push({
        rule: 'no-setext-heading',
        line: i + 1,
        snippet: trimmed.slice(0, 80),
      });
    }

    prevLine = line;
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Count ATX headings in mdText. Used by fidelity-scorer.
 * @param {string} mdText
 * @returns {{total:number, byLevel:{h1:number,h2:number,h3:number,h4:number,h5:number,h6:number}}}
 */
function countHeadings(mdText) {
  const byLevel = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 };
  if (typeof mdText !== 'string') return { total: 0, byLevel };
  const lines = mdText.split('\n');
  let total = 0;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+\S/);
    if (m) {
      total++;
      byLevel[`h${m[1].length}`]++;
    }
  }
  return { total, byLevel };
}

/**
 * Count structural blocks: lists, code blocks, tables, image refs, blockquotes, footnotes.
 * @param {string} mdText
 */
function countBlocks(mdText) {
  if (typeof mdText !== 'string') {
    return { codeBlocks: 0, lists: 0, tables: 0, imageRefs: 0, blockquotes: 0, footnotes: 0 };
  }
  const lines = mdText.split('\n');
  let codeBlocks = 0;
  let lists = 0;
  let tables = 0;
  let imageRefs = 0;
  let blockquotes = 0;
  let footnotes = 0;
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      if (!inFence) codeBlocks++;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (/^\s*[-+*]\s+\S/.test(line) || /^\s*\d+\.\s+\S/.test(line)) lists++;

    // Detect GFM table by separator row: |---|---|
    if (/^\s*\|?[\s:|-]+\|[\s:|-]+\|?\s*$/.test(line) && /-/.test(line) && /\|/.test(line)) {
      tables++;
    }

    const imgMatches = line.match(/!\[[^\]]*\]\([^)]+\)/g);
    if (imgMatches) imageRefs += imgMatches.length;

    if (/^\s*>/.test(line)) blockquotes++;

    const fnMatches = line.match(/\[\^[\w-]+\]/g);
    if (fnMatches) footnotes += fnMatches.length;
  }

  return { codeBlocks, lists, tables, imageRefs, blockquotes, footnotes };
}

module.exports = {
  validateSpec,
  countHeadings,
  countBlocks,
};
