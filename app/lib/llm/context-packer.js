'use strict';
// HYPHA · W5.1 Context Packer (per BLUEPRINT §17.2 Cheap Intelligence Router).
//
// Compress a candidate set down to a token-budget-bounded "packed context"
// suitable for prepending to a T6_STRONG or T3_MID call. Cheaper than asking
// the strong model to read everything; preserves the most relevant slices
// by ranking via cheap-router relevance_score (T0 Jaccard → T1 embed on
// fuzzy band).
//
// Public surface:
//   packContext({ task, candidates, budgetTokens, query? }) → envelope
//   estimateTokens(text) → number
//
// Token estimator: rough rule-of-thumb (1 token ≈ 4 char EN, ≈ 2 char CN).
// We do NOT call a real tokenizer here — packed-context budgeting is a
// best-effort gate, not a hard guarantee, and the strong-model side will
// re-tokenize anyway. Within ±15% of tiktoken cl100k_base on mixed CN/EN
// in informal benchmarking; acceptable for budget arithmetic.

const cheapRouter = require('./cheap-router');

const DEFAULT_BUDGET_TOKENS = 2000;
const SAFETY_MARGIN = 0.95; // leave 5% headroom so we don't blow the budget

// ---- Token estimator -------------------------------------------------------

const CJK_RE = /[一-鿿぀-ヿ가-힯]/g; // Han + Hiragana/Katakana + Hangul

/**
 * Estimate token count for a string. Splits the work by script:
 *   - CJK code units cost ~ 0.5 token each (≈ 2 chars / token).
 *   - Latin runs cost ~ 0.25 token per char (≈ 4 chars / token).
 *
 * @param {string} text
 * @returns {number} integer token estimate, ≥ 0
 */
function estimateTokens(text) {
  const s = String(text || '');
  if (s.length === 0) return 0;
  const cjkMatches = s.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const latinCount = s.length - cjkCount;
  const est = Math.ceil(cjkCount * 0.5 + latinCount * 0.25);
  return Math.max(1, est); // any non-empty string costs at least 1 token
}

// ---- Candidate normalization ------------------------------------------------

function _normalizeCandidate(c, i) {
  if (typeof c === 'string') return { id: 'c' + i, text: c };
  if (c && typeof c === 'object') {
    return {
      id: c.id != null ? String(c.id) : 'c' + i,
      text: String(c.text || c.body || c.content || ''),
      meta: c.meta || null,
    };
  }
  return { id: 'c' + i, text: '' };
}

// ---- Ranking ---------------------------------------------------------------

async function _rankCandidates(query, candidates) {
  // Use cheap-router relevance_score for each candidate. This automatically
  // takes the T0 Jaccard fast path and only embeds the fuzzy-band ones, so
  // ranking 100 candidates costs at most ~ N×ε on T0 plus ~ K×embed on the
  // ambiguous tail.
  const scored = [];
  for (const c of candidates) {
    const { result } = await cheapRouter.runCheapTask(cheapRouter.TASK.RELEVANCE_SCORE, {
      query,
      doc: c.text,
    });
    const score = result && typeof result.score === 'number' ? result.score : 0;
    scored.push({ candidate: c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ---- Packing ---------------------------------------------------------------

/**
 * Pack candidates into a single string under a token budget. Greedy: take
 * highest-ranked candidate that still fits; skip those that overflow but
 * keep trying smaller ones (so we don't waste budget on one giant doc).
 *
 * @param {object} args
 * @param {string} [args.task='relevance_score'] — currently advisory; future
 *        routing may pick a different ranker per task.
 * @param {Array} args.candidates — strings or {id, text, meta} objects.
 * @param {number} [args.budgetTokens=2000]
 * @param {string} [args.query] — used to rank candidates. If omitted, we use
 *        the first candidate's text as a pseudo-query (degraded mode — caller
 *        should pass a real query).
 * @param {string} [args.separator='\n\n---\n\n']
 * @returns {Promise<{packedText, usedCandidates, droppedCount, tokenEstimate, budgetTokens, ranking}>}
 */
async function packContext(args = {}) {
  const task = args.task || cheapRouter.TASK.RELEVANCE_SCORE;
  const budgetTokens = Number(args.budgetTokens) > 0 ? Number(args.budgetTokens) : DEFAULT_BUDGET_TOKENS;
  const separator = typeof args.separator === 'string' ? args.separator : '\n\n---\n\n';

  const rawCandidates = Array.isArray(args.candidates) ? args.candidates : [];
  const candidates = rawCandidates.map(_normalizeCandidate).filter((c) => c.text.length > 0);
  if (candidates.length === 0) {
    return {
      packedText: '',
      usedCandidates: [],
      droppedCount: 0,
      tokenEstimate: 0,
      budgetTokens,
      ranking: [],
    };
  }

  const query = String(args.query || candidates[0].text).slice(0, 2000);
  const ranked = await _rankCandidates(query, candidates);

  const effectiveBudget = Math.floor(budgetTokens * SAFETY_MARGIN);
  const sepTokens = estimateTokens(separator);

  const used = [];
  let runningTokens = 0;
  let droppedCount = 0;

  for (const { candidate, score } of ranked) {
    const tokensThisDoc = estimateTokens(candidate.text);
    const sepCost = used.length > 0 ? sepTokens : 0;
    if (runningTokens + sepCost + tokensThisDoc > effectiveBudget) {
      droppedCount++;
      continue; // skip but keep trying smaller ones
    }
    used.push({ id: candidate.id, text: candidate.text, score, tokens: tokensThisDoc });
    runningTokens += sepCost + tokensThisDoc;
  }

  const packedText = used.map((u) => u.text).join(separator);
  return {
    packedText,
    usedCandidates: used,
    droppedCount,
    tokenEstimate: estimateTokens(packedText),
    budgetTokens,
    ranking: ranked.map(({ candidate, score }) => ({ id: candidate.id, score })),
    // Caller can inspect the ranking even for dropped candidates — useful
    // for "show me what was almost included" UI.
    task,
  };
}

module.exports = {
  packContext,
  estimateTokens,
  DEFAULT_BUDGET_TOKENS,
};
