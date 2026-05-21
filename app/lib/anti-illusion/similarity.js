'use strict';

/**
 * HYPHA · Anti-Illusion similarity primitives.
 *
 * Pure JS, zero deps. Tokenizes mixed CJK + Latin text and computes trigram
 * Jaccard similarity. Used by anti-illusion.js detector 1 (ai_mimicry).
 *
 * Tokenization rules (matches goal-drift-detector convention):
 *   - Each CJK char is its own token
 *   - Latin words (\w+) are kept whole, lower-cased
 *   - Punctuation + whitespace dropped
 *
 * Trigram = window of 3 consecutive tokens. For short inputs (< 3 tokens),
 * the trigram set is empty — caller must guard.
 */

const CJK_RE = /[㐀-鿿豈-﫿가-힯]/;
const LATIN_WORD_RE = /[a-zA-Z0-9]+/g;

/**
 * Tokenize a string into an ordered array of tokens.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  // Walk char by char so we can mix CJK-per-char + Latin-as-word.
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (CJK_RE.test(ch)) {
      out.push(ch);
      i++;
      continue;
    }
    // Possible Latin word — scan forward.
    if (/[a-zA-Z0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9]/.test(text[j])) j++;
      out.push(text.slice(i, j).toLowerCase());
      i = j;
      continue;
    }
    // Skip whitespace, punctuation, anything else.
    i++;
  }
  return out;
}

/**
 * Build a Set of trigrams from a token array. Order-preserved window of 3.
 *
 * @param {string[]} tokens
 * @returns {Set<string>}
 */
function trigrams(tokens) {
  const set = new Set();
  if (!Array.isArray(tokens) || tokens.length < 3) return set;
  for (let i = 0; i <= tokens.length - 3; i++) {
    set.add(tokens[i] + '' + tokens[i + 1] + '' + tokens[i + 2]);
  }
  return set;
}

/**
 * Jaccard similarity = |A ∩ B| / |A ∪ B|. Returns 0 if either set empty.
 *
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
function jaccard(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set)) return 0;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  // Iterate smaller set for speed.
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Convenience wrapper: similarity score for two raw strings.
 *
 * @param {string} x
 * @param {string} y
 * @returns {number}
 */
function similarity(x, y) {
  return jaccard(trigrams(tokenize(x)), trigrams(tokenize(y)));
}

module.exports = { tokenize, trigrams, jaccard, similarity };
