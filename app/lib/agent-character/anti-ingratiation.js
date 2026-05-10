'use strict';
// HYPHA · Anti-Ingratiation Style Filter (AMD-MEOW-P8 C2)
//
// Detects + strips slick / 隐性奉承 / 炫技比喻 / 高级感堆叠 / 过度亲密 / 伪坦诚
// phrases from agent output. The phrases below are not always wrong, but they
// manufacture intimacy / superiority / authority that lowers the user's epistemic
// vigilance. HYPHA's default teaching tone refuses them.
//
// Per blueprint §25.5 — style principles encoded:
//   清晰 > 炫技, 诚实 > 亲密, 可验证 > 有魅力,
//   解释力 > 语言快感, 结构 > 氛围, 机制 > 金句.

// Each entry is either a literal substring (case-insensitive matched after
// normalization) OR a RegExp. We start with the source-defined list and let
// it grow as observed in production.
const INGRATIATION_PATTERNS = [
  // 中文 隐性奉承 / 优越感
  '你真正抓住了关键',
  '大多数人会误解这里',
  '这里有一个更深的结构',
  '我们可以更进一步',
  '真正重要的是',
  '你已经接近核心了',
  '这其实是高手才会问的问题',
  '一个常被忽视的细节',
  '你的直觉是对的',

  // 中文 伪坦诚 / 注意力操控
  '说实话',
  '坦白说',
  '老实讲',
  '真正的问题是',
  '更深一层来看',
  '这背后的本质',

  // EN slick / showoff / faux-intimacy
  /\byou'?re\s+absolutely\s+right\b/i,
  /\bgreat\s+question\b/i,
  /\bexcellent\s+observation\b/i,
  /\bmost\s+people\s+miss\s+this\b/i,
  /\bat\s+the\s+heart\s+of\s+it\b/i,
  /\bwhat'?s\s+really\s+going\s+on\s+here\b/i,
  /\bthe\s+key\s+insight\s+is\b/i,
  /\bbeneath\s+the\s+surface\b/i,
];

/**
 * Scan text for ingratiation patterns. Returns the list of violations
 * (each = {pattern, match, start}) without mutating the text.
 *
 * @param {string} text
 * @returns {Array<{pattern: string, match: string, start: number}>}
 */
function detectIngratiation(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const p of INGRATIATION_PATTERNS) {
    if (typeof p === 'string') {
      const idx = text.toLowerCase().indexOf(p.toLowerCase());
      if (idx >= 0) {
        out.push({ pattern: p, match: text.slice(idx, idx + p.length), start: idx });
      }
    } else if (p instanceof RegExp) {
      const flags = p.flags.includes('g') ? p.flags : p.flags + 'g';
      const re = new RegExp(p.source, flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        out.push({ pattern: p.source, match: m[0], start: m.index });
        if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width
      }
    }
  }
  return out;
}

/**
 * Strip ingratiation phrases from text by deleting the matched span and
 * collapsing surrounding whitespace. Returns {clean_text, violations}.
 *
 * Conservative — only deletes the matched span, not the entire sentence.
 * Some matches will leave dangling commas etc; downstream rewrite layer
 * (Tranche 2 Rewriter) is expected to clean this up. v0.2 minimum: surface
 * the violation, don't pretend perfect prose surgery.
 *
 * @param {string} text
 * @returns {{clean_text: string, violations: Array}}
 */
function scrubIngratiation(text) {
  const violations = detectIngratiation(text);
  if (violations.length === 0) return { clean_text: text, violations: [] };
  // Sort by start descending so deletions don't shift later indices.
  const sorted = violations.slice().sort((a, b) => b.start - a.start);
  let out = text;
  for (const v of sorted) {
    out = out.slice(0, v.start) + out.slice(v.start + v.match.length);
  }
  // Collapse repeated whitespace produced by deletions.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1');
  return { clean_text: out, violations };
}

module.exports = {
  INGRATIATION_PATTERNS,
  detectIngratiation,
  scrubIngratiation,
};
