'use strict';
// HYPHA · W5.1 T1_EMBED · BGE-M3 stub (per BLUEPRINT §17.2 / ROADMAP v1.1).
//
// Theory ship: surface contract locked, downstream W5.2 Web Note Engine +
// W5.3 Living Note Reactivation can integrate against `embed()` + the
// `cosineSimilarity()` + `topKSimilar()` helpers RIGHT NOW. Real BGE-M3
// runtime swaps in via the TODO below without any caller changes.
//
// Real BGE-M3 paths (post v0.8, gated on Ollama infra):
//   1. HuggingFace transformers.js — `@xenova/transformers` ONNX. Pulls
//      ~600MB model on first run; first-token latency ~ 800ms cold,
//      ~ 50ms warm; runs in main process or worker_thread.
//   2. Ollama HTTP — POST http://localhost:11434/api/embeddings
//      { model: "bge-m3", prompt: text } → { embedding: float[1024] }.
//      Preferred if user already runs Ollama for T2_LOCAL Gemma.
//
// Mock fallback (current default): deterministic character-bigram hash
// → 1024-d float vector. Same input → identical vector (test invariant).
// Different inputs share enough hashed dims that `cosineSimilarity` of
// related strings stays > 0 and `topKSimilar` ranks plausibly for tests.

const EMBED_DIM = 1024;

// ---- Real BGE-M3 path (TODO, gated on Ollama/transformers.js) ---------------

let _realEmbedder = null;
let _realEmbedderProbed = false;

async function _tryRealEmbedder() {
  if (_realEmbedderProbed) return _realEmbedder;
  _realEmbedderProbed = true;
  // intentional-placeholder: BGE-M3 real-embedder wiring is gated on v0.8
  // Companion track (Ollama runtime ship). W5.1 (this wave) only ships the
  // surface contract + mock fallback so W5.2 / W5.3 can integrate now. The
  // two real paths below are the implementation playbook for v0.8, NOT a
  // half-finished branch — until Ollama lands, the only correct behavior
  // is "return null, fall through to mock".
  //   Path A (Ollama, preferred): probe http://localhost:11434/api/tags,
  //     check `bge-m3` model present; if yes, set `_realEmbedder` to
  //     `async (text) => POST /api/embeddings { model, prompt:text }.embedding`.
  //   Path B (transformers.js, fallback): try `require('@xenova/transformers')`,
  //     pipeline('feature-extraction', 'Xenova/bge-m3', {quantized:true}).
  //   Either path MUST return Float32Array | number[] of length === EMBED_DIM.
  //   Failure to load = stay on mock (no throw).
  return null;
}

// ---- Mock fallback: deterministic character-bigram hash ---------------------

/**
 * Deterministic mock embedding. Same input → bitwise-identical output.
 * Pure character-bigram hash mapped onto EMBED_DIM bins, then L2-normalized.
 *
 * @param {string} text
 * @returns {number[]} length EMBED_DIM
 */
function _mockEmbed(text) {
  const s = String(text || '');
  const vec = new Array(EMBED_DIM).fill(0);
  if (s.length === 0) return vec;

  // Character-bigram pass (covers Latin + CJK uniformly since we read
  // code units, not graphemes).
  for (let i = 0; i < s.length - 1; i++) {
    const a = s.charCodeAt(i);
    const b = s.charCodeAt(i + 1);
    // Two complementary hash mixes for spread.
    const h1 = ((a * 31) ^ (b * 17) ^ (i * 7)) >>> 0;
    const h2 = ((a * 131) ^ (b * 113) ^ (i * 19)) >>> 0;
    vec[h1 % EMBED_DIM] += 1;
    vec[h2 % EMBED_DIM] += 0.5;
  }

  // Unigram pass — guards against length-1 inputs and adds signal density.
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const h = ((c * 2654435761) ^ (i * 41)) >>> 0;
    vec[h % EMBED_DIM] += 0.25;
  }

  // L2-normalize so cosineSimilarity reduces to dot product.
  let sumSq = 0;
  for (let i = 0; i < EMBED_DIM; i++) sumSq += vec[i] * vec[i];
  if (sumSq === 0) return vec;
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < EMBED_DIM; i++) vec[i] *= inv;
  return vec;
}

// ---- Public surface ---------------------------------------------------------

/**
 * @param {string} text
 * @returns {Promise<number[]>} length 1024, L2-normalized
 */
async function embed(text) {
  const real = await _tryRealEmbedder();
  if (real) {
    try {
      const v = await real(text);
      if (Array.isArray(v) && v.length === EMBED_DIM) return v;
      if (v && v.length === EMBED_DIM) return Array.from(v);
    } catch (_) {
      // fall through to mock — never block callers on infra failure
    }
  }
  return _mockEmbed(text);
}

/**
 * Cosine similarity. Inputs must be same length. NOT normalized internally —
 * callers receive L2-normalized vectors from `embed()`, so this reduces to
 * dot product. If a caller passes raw vectors, the normalization division
 * still produces a correct cosine value.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} cosine in [-1, 1]
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * @param {string} query
 * @param {Array<{id?:string, text:string} | string>} candidates
 * @param {number} [k=5]
 * @returns {Promise<Array<{candidate, score, index}>>}
 */
async function topKSimilar(query, candidates, k = 5) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const qVec = await embed(query);
  const scored = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const text = typeof c === 'string' ? c : (c && c.text) || '';
    const cVec = await embed(text);
    scored.push({ candidate: c, score: cosineSimilarity(qVec, cVec), index: i });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, Math.max(0, k));
}

module.exports = {
  embed,
  cosineSimilarity,
  topKSimilar,
  EMBED_DIM,
};
