'use strict';

// HYPHA · Anti-Slop P2 — Meta-Coherence Detector (rc.1 → 1.0 push)
//
// P2 sits one layer above P0/P1 (prosecutor-judge-rewriter). Where P0 catches
// per-claim slop and P1 catches per-passage rewrite needs, P2 catches a
// distinct failure mode: the lesson's "what to remember" (thesis / exit_proof /
// closing_summary) DRIFTS from the lesson's actual body (mechanism_explanation
// + canonical_example + examples). A lesson can pass schema, pass prosecutor,
// and still leave the learner with a take-home that the body never proved.
//
// Algorithm — rule-based, no embeddings (consistent with concept-ledger.js):
//   1. Build a "summary set" from the takeaway-bearing fields:
//        thesis ∪ exit_proof ∪ closing_summary ∪ next_lesson_seed
//   2. Build a "body set" from the load-bearing prose fields:
//        mechanism_explanation ∪ canonical_example ∪ examples ∪
//        common_misconceptions.*.why_wrong/correct
//   3. Tokenize both into normalized character bigrams + ≥3-char unigrams
//      (Chinese-tolerant + Roman-tolerant — same recipe as concept-ledger).
//   4. Compute (a) Jaccard overlap and (b) one-way containment of summary
//      tokens inside body tokens. Use the MAX of {jaccard, containment} as
//      the meta-coherence score, because a tight summary tends to be a
//      strict subset of body, never a Jaccard-equal twin.
//   5. score < 0.5 → flag for revision (P2 verdict).
//
// This module is PURE function; no LLM, no IO. The rewriter chain in
// prosecute-judge-rewrite.js owns the actual rewrite — P2 only decides
// "this draft needs another P0/P1 pass before ship".

const STOPWORDS = new Set([
  // Common Chinese particles + function words that bias overlap up.
  '的', '了', '是', '在', '和', '与', '或', '及', '即', '为', '所',
  '这', '那', '一个', '一种', '一', '可以', '可', '由', '于', '从',
  '到', '中', '上', '下', '内', '外', '前', '后', '我们', '他们',
  '它', '它们', '其', '其中', '此', '这个', '这些', '那些', '某',
  '会', '将', '把', '被', '让', '使', '以', '让我们',
  // English stopwords
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'and', 'or', 'but',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them',
  'will', 'shall', 'can', 'may', 'should', 'we', 'you', 'your',
]);

const META_COHERENCE_THRESHOLD = 0.5;

function _tokenize(s) {
  if (typeof s !== 'string') return new Set();
  const cleaned = s.trim();
  if (!cleaned) return new Set();
  const normalized = cleaned
    .replace(/[　-〿＀-￯.,;:!?()\[\]{}<>'"`~/\\\-_*+=|]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  const tokens = new Set();
  for (let i = 0; i < normalized.length - 1; i++) {
    const bg = normalized.slice(i, i + 2);
    if (bg.trim().length === 2 && !STOPWORDS.has(bg)) tokens.add(bg);
  }
  for (const w of normalized.split(' ')) {
    if (w.length >= 3 && !STOPWORDS.has(w)) tokens.add(w);
  }
  return tokens;
}

function _collect(parts) {
  const buf = [];
  for (const p of parts) {
    if (typeof p === 'string' && p.trim()) buf.push(p.trim());
    else if (Array.isArray(p)) {
      for (const el of p) {
        if (typeof el === 'string' && el.trim()) buf.push(el.trim());
      }
    }
  }
  return buf.join('\n\n');
}

function _summaryCorpus(body) {
  if (!body || typeof body !== 'object') return '';
  return _collect([
    body.thesis,
    body.exit_proof,
    body.closing_summary,
    body.next_lesson_seed,
  ]);
}

function _bodyCorpus(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [
    body.mechanism_explanation,
    body.canonical_example,
    body.intro_hook_scene,
    Array.isArray(body.examples) ? body.examples : null,
  ];
  if (Array.isArray(body.common_misconceptions)) {
    for (const m of body.common_misconceptions) {
      if (!m || typeof m !== 'object') continue;
      if (typeof m.why_wrong === 'string') parts.push(m.why_wrong);
      if (typeof m.correct === 'string') parts.push(m.correct);
    }
  }
  if (Array.isArray(body.transfer_cases)) {
    for (const t of body.transfer_cases) {
      if (!t || typeof t !== 'object') continue;
      if (typeof t.description === 'string') parts.push(t.description);
      if (typeof t.expected_response === 'string') parts.push(t.expected_response);
    }
  }
  return _collect(parts);
}

function _scoreOverlap(summarySet, bodySet) {
  if (summarySet.size === 0) {
    return { jaccard: 1, containment: 1, score: 1, reason: 'empty_summary' };
  }
  if (bodySet.size === 0) {
    return { jaccard: 0, containment: 0, score: 0, reason: 'empty_body' };
  }
  let intersect = 0;
  for (const t of summarySet) if (bodySet.has(t)) intersect++;
  const union = summarySet.size + bodySet.size - intersect;
  const jaccard = union === 0 ? 0 : intersect / union;
  const containment = intersect / summarySet.size;
  const score = Math.max(jaccard, containment);
  return { jaccard, containment, score, reason: null };
}

function detectMetaCoherence(body, opts = {}) {
  const threshold = (opts && Number.isFinite(opts.threshold)) ? opts.threshold : META_COHERENCE_THRESHOLD;
  const summaryText = _summaryCorpus(body);
  const bodyText = _bodyCorpus(body);
  const sSet = _tokenize(summaryText);
  const bSet = _tokenize(bodyText);
  const overlap = _scoreOverlap(sSet, bSet);
  const flagged = overlap.score < threshold;
  return {
    score: Number(overlap.score.toFixed(3)),
    jaccard: Number(overlap.jaccard.toFixed(3)),
    containment: Number(overlap.containment.toFixed(3)),
    flagged,
    threshold,
    summary_token_count: sSet.size,
    body_token_count: bSet.size,
    reason: overlap.reason,
    advisory: flagged
      ? '本节"要记住"与正文证据不重合 — 收紧 thesis/exit_proof,使其只断言正文确实证明过的事;或扩展 mechanism_explanation / canonical_example 覆盖 thesis 的关键 token。'
      : null,
  };
}

module.exports = {
  detectMetaCoherence,
  META_COHERENCE_THRESHOLD,
  _tokenize,
  _summaryCorpus,
  _bodyCorpus,
};
