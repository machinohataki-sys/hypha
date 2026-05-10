'use strict';

// frontier-relevance.js — pure BM25 relevance filter for frontier-cron deltas.
// T5_PACK class (algorithmic, no LLM call). Inputs:
//   { papers: [{ title, abstract?, url, source }], activeTopics: [string] }
// Output:
//   { relevant: [...], filtered_out: [...] }
// Score = BM25 over (title + abstract) against all active topics, max-pool.
// Threshold ≥ 0.3 → relevant.

const RELEVANCE_THRESHOLD = 0.3;
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'he',
  'in', 'is', 'it', 'its', 'of', 'on', 'that', 'the', 'to', 'was', 'were',
  'will', 'with', 'or', 'this', 'these', 'those', 'we', 'our',
]);

function tokenize(text) {
  if (typeof text !== 'string' || !text) return [];
  return text.toLowerCase()
    .replace(/[^a-z0-9一-鿿\s]+/g, ' ')
    .split(/\s+/)
    .filter(t => t && t.length >= 2 && !STOPWORDS.has(t));
}

function bm25Score(docTokens, queryTokens, avgDocLen, docFreq, totalDocs) {
  if (!docTokens.length || !queryTokens.length) return 0;
  const tf = new Map();
  for (const t of docTokens) tf.set(t, (tf.get(t) || 0) + 1);
  const docLen = docTokens.length;
  let score = 0;
  for (const qt of queryTokens) {
    const f = tf.get(qt) || 0;
    if (f === 0) continue;
    const df = docFreq.get(qt) || 1;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const norm = f * (BM25_K1 + 1);
    const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen));
    score += idf * (norm / denom);
  }
  return score;
}

function filter({ papers, activeTopics } = {}) {
  if (!Array.isArray(papers) || papers.length === 0) {
    return { relevant: [], filtered_out: [] };
  }
  const topics = Array.isArray(activeTopics) ? activeTopics.filter(t => typeof t === 'string' && t.trim()) : [];
  if (topics.length === 0) {
    // No topics specified — pass everything through, marked relevant by default.
    return { relevant: papers.slice(), filtered_out: [] };
  }

  // Build doc token cache + global doc frequency table.
  const docs = papers.map(p => {
    const text = `${(p && p.title) || ''} ${(p && p.abstract) || ''}`;
    return tokenize(text);
  });
  const totalDocs = docs.length;
  const avgDocLen = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, totalDocs);
  const docFreq = new Map();
  for (const d of docs) {
    const seen = new Set(d);
    for (const t of seen) docFreq.set(t, (docFreq.get(t) || 0) + 1);
  }

  // Tokenize each topic; max-pool the per-topic BM25 score per paper.
  const topicTokens = topics.map(t => tokenize(t));

  const relevant = [];
  const filtered_out = [];
  for (let i = 0; i < papers.length; i++) {
    let best = 0;
    for (const qTokens of topicTokens) {
      const s = bm25Score(docs[i], qTokens, avgDocLen || 1, docFreq, totalDocs);
      if (s > best) best = s;
    }
    const tagged = Object.assign({}, papers[i], { _relevance_score: best });
    if (best >= RELEVANCE_THRESHOLD) relevant.push(tagged);
    else filtered_out.push(tagged);
  }
  return { relevant, filtered_out };
}

module.exports = { filter, RELEVANCE_THRESHOLD };
