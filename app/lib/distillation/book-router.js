'use strict';

// HYPHA · Book Router (BLUEPRINT §5.3) — serve a budget-bounded context
// packet for a query against a distilled book, WITHOUT re-reading the raw
// text or re-running any phase.
//
// Inputs available after distillation:
//   - Phase 1 / 3 / 5: book-level (overall structure, core mechanisms, anti-sparks)
//   - Phase 2:         per-chapter Kernel (core question + judgments + chain)
//   - Phase 7 pack:    user-facing Book Spark Pack (already compressed)
//
// Strategy for getBookContextPacket(query, budget):
//   1. Always include the book identity card (title + author + author core question)
//   2. Score every Phase-3 high_value_spark + Phase-2 chapter Kernel against
//      the query (keyword overlap; CJK char-grams + ASCII word tokens)
//   3. Pack top-K into the budget (rough tokens ≈ chars/4, English-style heuristic)
//   4. Always reserve a thin tail-slot for the most relevant Anti-Spark (phase 5)
//      so contrarian context surfaces by default
//
// Output: a flat array of "segments" {kind, source, text, weight} that the
// caller (W6.1 grounding stream, lesson-plan harvest) can stitch into a prompt.

const fs = require('node:fs');
const path = require('node:path');
const runner = require('./distill-runner');

const DEFAULT_BUDGET_TOKENS = 1500;
const CHARS_PER_TOKEN = 4; // coarse English-style heuristic; CJK ~2 — we err small
const IDENTITY_CARD_RESERVE = 200; // chars reserved for the book identity header
const ANTI_SPARK_RESERVE    = 240; // chars reserved for tail Anti-Spark

// ── Tokenize (mirrors library._tokenize so scores compose) ─────────────────

function _tokenize(s) {
  const lower = String(s || '').toLowerCase();
  const ascii = lower.match(/[a-z0-9]{2,}/g) || [];
  const cjk = (lower.match(/[一-鿿]/g) || []);
  return [...new Set([...ascii, ...cjk])];
}

function _scoreText(text, tokens) {
  if (!text || tokens.length === 0) return 0;
  const lower = String(text).toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (!t) continue;
    let count = 0;
    let pos = lower.indexOf(t);
    while (pos !== -1 && count < 50) {
      count++;
      pos = lower.indexOf(t, pos + 1);
    }
    score += count;
  }
  return score;
}

function _approxTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Get a context packet for `query` against a distilled book. Returns null
 * if book is not yet distilled (caller should fall back to library.queryLibrary
 * keyword retrieval over raw chunks).
 *
 * @param {object} args
 * @param {string} args.vaultRoot
 * @param {string} args.bookId
 * @param {string} args.query
 * @param {number} args.budgetTokens?  default 1500
 * @returns {null | { book_id, book_title, query, budget_tokens, used_tokens, segments: [{kind, source, text, weight}] }}
 */
function getBookContextPacket({ vaultRoot, bookId, query, budgetTokens } = {}) {
  if (!vaultRoot || !bookId) return null;
  if (!runner.isBookDistilled({ vaultRoot, bookId })) return null;

  const budget = Number.isFinite(budgetTokens) && budgetTokens > 0 ? budgetTokens : DEFAULT_BUDGET_TOKENS;
  const tokens = _tokenize(query || '');

  const dir = runner._paths._bookCacheDir(vaultRoot, bookId);
  const p1 = _readJSON(path.join(dir, 'phase-1.json'));
  const p2 = _readJSON(path.join(dir, 'phase-2.json'));
  const p3 = _readJSON(path.join(dir, 'phase-3.json'));
  const p5 = _readJSON(path.join(dir, 'phase-5.json'));
  const p7 = _readJSON(path.join(dir, 'phase-7.json'));

  if (!p1 || !p3) return null; // require at least map + cross-chapter merge

  const segments = [];
  let usedChars = 0;
  const budgetChars = budget * CHARS_PER_TOKEN;

  // 1) Identity card — always included, capped
  const identityCard =
    `BOOK: ${(p7 && p7.pack && p7.pack.book_title) || p1.book_id} · ` +
    `STRUCTURE: ${p1.overall_structure || ''} · ` +
    `AUTHOR_QUESTION: ${p1.author_core_question || ''}`;
  const identityCardCapped = identityCard.slice(0, IDENTITY_CARD_RESERVE);
  segments.push({ kind: 'identity', source: 'phase-1', text: identityCardCapped, weight: 1 });
  usedChars += identityCardCapped.length;

  // 2) Score-pack chapter Kernels (phase 2) + cross-chapter sparks (phase 3)
  const candidates = [];

  if (p2 && Array.isArray(p2.chapters)) {
    for (const ch of p2.chapters) {
      const blob = [
        ch.chapter_title,
        ch.core_question,
        ...(ch.core_judgments || []),
        ...(ch.argument_chain || []).map(s => s && s.text).filter(Boolean),
        ...(ch.hidden_premises || []),
      ].filter(Boolean).join(' · ');
      const score = _scoreText(blob, tokens);
      if (score > 0 || tokens.length === 0) {
        candidates.push({
          kind: 'chapter_kernel',
          source: `phase-2:ch-${ch.chapter_idx}`,
          text: `[Ch ${ch.chapter_idx} ${ch.chapter_title || ''}] Q: ${ch.core_question || ''} | ` +
                (ch.core_judgments || []).slice(0, 2).join(' / '),
          score,
        });
      }
    }
  }

  if (p3 && Array.isArray(p3.high_value_sparks)) {
    for (const s of p3.high_value_sparks) {
      const blob = [s.text, s.kind].filter(Boolean).join(' · ');
      const score = _scoreText(blob, tokens) + (s.strength || 0) * 2; // strength weighting
      candidates.push({
        kind: 'spark',
        source: `phase-3:${s.id || ''}`,
        text: `[Spark ${s.kind || 'concept'}] ${s.text || ''}`,
        score,
      });
    }
  }

  // 3) Reserve tail-slot for top anti-spark (always-on contrarian context)
  let antiSparkSeg = null;
  if (p5) {
    const antiPool = [
      ...(Array.isArray(p5.author_overestimated) ? p5.author_overestimated.map(t => ({ kind: 'overestimated', text: t })) : []),
      ...(Array.isArray(p5.author_underestimated) ? p5.author_underestimated.map(t => ({ kind: 'underestimated', text: t })) : []),
      ...(Array.isArray(p5.outdated_views) ? p5.outdated_views.map(t => ({ kind: 'outdated', text: t })) : []),
      ...(Array.isArray(p5.rewriteable_for_ai_era) ? p5.rewriteable_for_ai_era.map(t => ({ kind: 'ai_rewriteable', text: t })) : []),
    ];
    const scored = antiPool.map(a => ({ ...a, score: _scoreText(a.text, tokens) }));
    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0) {
      const top = scored[0];
      antiSparkSeg = {
        kind: 'anti_spark',
        source: 'phase-5',
        text: `[Anti-Spark ${top.kind}] ${(top.text || '').slice(0, ANTI_SPARK_RESERVE)}`,
        weight: 0.8,
      };
    }
  }
  const antiReserveChars = antiSparkSeg ? antiSparkSeg.text.length : 0;

  // 4) Pack candidates into remaining budget (high score first)
  candidates.sort((a, b) => b.score - a.score);
  const remainingChars = () => (budgetChars - usedChars - antiReserveChars);
  for (const c of candidates) {
    if (remainingChars() <= 0) break;
    // Cap each segment so a single huge chapter doesn't blow the budget
    const cap = Math.max(120, Math.min(c.text.length, Math.floor(remainingChars() * 0.5)));
    const text = c.text.slice(0, cap);
    segments.push({ kind: c.kind, source: c.source, text, weight: Math.min(1, c.score / 10) });
    usedChars += text.length;
  }

  // 5) Append the anti-spark last so prompt placement is "always-contrarian-tail"
  if (antiSparkSeg) {
    segments.push(antiSparkSeg);
    usedChars += antiSparkSeg.text.length;
  }

  return {
    book_id: bookId,
    book_title: (p7 && p7.pack && p7.pack.book_title) || null,
    query: query || '',
    budget_tokens: budget,
    used_tokens: Math.ceil(usedChars / CHARS_PER_TOKEN),
    segments,
  };
}

function _readJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

// ── Archetype detection (Phase 4+6 specialization, 2026-05-19) ─────────────
//
// Why this lives in book-router (not its own module): the router is the single
// surface that other layers (phases.js, grounding/*) already import to decide
// "what to show for this book". Adding `detectBookArchetype()` here keeps the
// dispatch decision colocated with packet-shaping.
//
// Taxonomy (additive, mirrors harvest/archetype-lanes.js where overlap exists):
//   - 'literary'        — novels, short stories, poetry, memoir, drama
//                         (themes / motifs / narrative arc, NOT factual claims)
//   - 'technical'       — algorithms, code, formal systems (claims + proofs)
//   - 'academic'        — papers, monographs, philosophy (claim/counter-claim)
//   - 'popular-science' — general-audience nonfiction (claim + narrative)
//   - 'how-to'          — instructional, procedural (recipe + drill)
//   - 'unknown'         — heuristic confidence too low; downstream falls back
//                         to the default (claim-extraction) prompts
//
// Detection is rule-based, character-class only. NOT an LLM call. Three signals
// drive the literary branch:
//   1. Dialogue ratio: chars inside quote-pairs / total chars. Fiction reads
//      ~25-60% dialogue (Dostoyevsky chapter), technical ~0-5%.
//   2. Past-tense narrative density: past-tense verb endings per 1000 chars in
//      English ('-ed ', '-ed.', 'was ', 'were ', 'had '); in CJK
//      ('了', '过', '曾'). Fiction concentrates these; algorithms do not.
//   3. Code-block / formula density: ``` fences + LaTeX delimiters per 1000
//      chars. High = technical (negative literary signal).
//
// Threshold: literary score ≥ 0.55 AND tech score ≤ 0.30 → 'literary'.
// Documented because rule-based heuristics drift; if the smoke fails, tune
// constants HERE first (not the test).
//
// Each scorer returns 0..1. Composite is weighted sum; ratios are intentionally
// conservative so a single signal cannot flip the verdict — e.g. a Knuth book
// quoting "MIX is a hypothetical computer" inside quotes still scores low
// because tech signals dominate.

const _LITERARY_DIALOGUE_THRESHOLD = 0.18; // share of chars inside quotes
const _LITERARY_PAST_TENSE_PER_KCHAR = 6;  // past-tense markers per 1000 chars
const _CODE_DENSITY_HARD_REJECT = 0.12;    // % of chars inside code/math fences

/**
 * Score the dialogue ratio (chars inside paired quotation marks, all three
 * common conventions: " " / ' ' / 「 」 / 『 』 / “ ”). Returns 0..1 (capped).
 *
 * @param {string} text
 * @returns {{ratio:number, score:number}}
 */
function _scoreDialogue(text) {
  if (!text) return { ratio: 0, score: 0 };
  const total = text.length;
  let inside = 0;
  // Pair detection: count chars between matched opener/closer.
  // ASCII straight quotes are ambiguous (open == close); use a state toggle.
  let asciiOpen = false;
  let smartOpen = false;
  let cjkOpen = false;
  for (let i = 0; i < total; i++) {
    const ch = text[i];
    if (ch === '"') {
      asciiOpen = !asciiOpen;
      continue;
    }
    if (ch === '“') { smartOpen = true; continue; }
    if (ch === '”') { smartOpen = false; continue; }
    if (ch === '「' || ch === '『') { cjkOpen = true; continue; }
    if (ch === '」' || ch === '』') { cjkOpen = false; continue; }
    if (asciiOpen || smartOpen || cjkOpen) inside++;
  }
  const ratio = inside / total;
  const score = Math.min(1, ratio / _LITERARY_DIALOGUE_THRESHOLD);
  return { ratio, score };
}

/**
 * Score past-tense narrative density.
 *
 * @param {string} text
 * @returns {{per1k:number, score:number}}
 */
function _scorePastTense(text) {
  if (!text) return { per1k: 0, score: 0 };
  const len = text.length;
  let hits = 0;
  // English past-tense markers (cheap surface patterns).
  hits += (text.match(/\b[a-z]{2,}ed[\s.,;:!?'"]/gi) || []).length;
  hits += (text.match(/\b(was|were|had|did|said|went|came|saw|knew|thought)\b/gi) || []).length;
  // CJK perfective / experiential markers.
  hits += (text.match(/[了过曾]/g) || []).length;
  const per1k = (hits / len) * 1000;
  const score = Math.min(1, per1k / _LITERARY_PAST_TENSE_PER_KCHAR);
  return { per1k, score };
}

/**
 * Score code / math density (negative literary signal).
 *
 * @param {string} text
 * @returns {{density:number, score:number}}
 */
function _scoreCodeDensity(text) {
  if (!text) return { density: 0, score: 0 };
  const len = text.length;
  let codeChars = 0;
  // Triple-fence blocks ```...```
  const fences = text.match(/```[\s\S]*?```/g) || [];
  for (const f of fences) codeChars += f.length;
  // Inline code `...`
  const inline = text.match(/`[^`\n]{2,80}`/g) || [];
  for (const f of inline) codeChars += f.length;
  // LaTeX-ish math $$..$$ and $...$
  const math = text.match(/\$\$[\s\S]*?\$\$|\$[^$\n]{2,120}\$/g) || [];
  for (const f of math) codeChars += f.length;
  const density = codeChars / len;
  const score = Math.min(1, density / _CODE_DENSITY_HARD_REJECT);
  return { density, score };
}

/**
 * Detect the archetype of a book from its chunks. Pure function (no I/O).
 * Samples up to 5 chunks (first / 25% / 50% / 75% / last) so a long technical
 * book with a literary preface (or vice versa) doesn't fool the detector.
 *
 * @param {object} book — { id, title?, author?, chunks: [{ text, ... }] }
 * @returns {{archetype:string, confidence:number, signals:object}}
 */
function detectBookArchetype(book) {
  if (!book || !Array.isArray(book.chunks) || book.chunks.length === 0) {
    return { archetype: 'unknown', confidence: 0, signals: { reason: 'no-chunks' } };
  }
  const n = book.chunks.length;
  const sampleIdxs = n <= 5
    ? book.chunks.map((_, i) => i)
    : [0, Math.floor(n * 0.25), Math.floor(n * 0.5), Math.floor(n * 0.75), n - 1];
  const sample = sampleIdxs
    .map(i => String((book.chunks[i] && book.chunks[i].text) || ''))
    .filter(s => s.length > 100)
    .join('\n\n');

  if (sample.length < 300) {
    return { archetype: 'unknown', confidence: 0, signals: { reason: 'sample-too-short', chars: sample.length } };
  }

  const dialogue = _scoreDialogue(sample);
  const pastTense = _scorePastTense(sample);
  const codeDensity = _scoreCodeDensity(sample);

  // Composite literary score: dialogue + past-tense both pulling, code pushing back.
  const litRaw = 0.55 * dialogue.score + 0.45 * pastTense.score;
  const techPenalty = codeDensity.score;
  const literaryScore = Math.max(0, litRaw - 0.6 * techPenalty);

  // Tech score: code density alone (algorithm books are rich in fences + math).
  const techScore = codeDensity.score;

  let archetype = 'unknown';
  let confidence = 0;
  if (literaryScore >= 0.55 && techPenalty <= 0.30) {
    archetype = 'literary';
    confidence = Math.min(1, literaryScore);
  } else if (techScore >= 0.55) {
    archetype = 'technical';
    confidence = Math.min(1, techScore);
  } else {
    // Default-claim path. Caller decides between academic / popular-science /
    // how-to based on its own metadata (we don't ML-classify those here).
    archetype = 'unknown';
    confidence = Math.max(literaryScore, techScore);
  }

  return {
    archetype,
    confidence: Math.round(confidence * 100) / 100,
    signals: {
      dialogue_ratio: Math.round(dialogue.ratio * 10000) / 10000,
      dialogue_score: Math.round(dialogue.score * 100) / 100,
      past_tense_per_kchar: Math.round(pastTense.per1k * 100) / 100,
      past_tense_score: Math.round(pastTense.score * 100) / 100,
      code_density: Math.round(codeDensity.density * 10000) / 10000,
      code_density_score: Math.round(codeDensity.score * 100) / 100,
      literary_score: Math.round(literaryScore * 100) / 100,
      tech_score: Math.round(techScore * 100) / 100,
      sample_chars: sample.length,
      chunks_sampled: sampleIdxs.length,
    },
  };
}

module.exports = {
  DEFAULT_BUDGET_TOKENS,
  getBookContextPacket,
  detectBookArchetype,
  // Exposed for unit-test introspection.
  _scoreDialogue,
  _scorePastTense,
  _scoreCodeDensity,
};
