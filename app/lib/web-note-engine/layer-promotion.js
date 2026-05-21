'use strict';

// HYPHA · W5.2 Web Note Engine — layer promotion (5 transitions + distill)
//
// Each transition lifts a node from layer L to L+1 by:
//   1. Creating new typed node(s) at higher layer
//   2. Wiring typed edge(s) from source(s) to the new node
//   3. Bumping utility_score on the source(s) (because it just spawned value)
//
//   raw            → atomic         via T4_JUDGE (split into atomic cards)
//   atomic         → concept        via concept-naming (cross-card shared)
//   concept/atomic → spark          via spark detection
//   spark          → product_spark  via W3.4 product-spark.createSpark
//   {atomic|concept|spark}+ → kernel via T6_STRONG distill
//
// LLM calls are mock-with-fallback: if a runtime injects an LLM, use it;
// otherwise we synthesize a deterministic stub so the engine remains
// testable + offline. All public functions return Promise<{ ok, ... }>.

const crypto = require('crypto');

const graph = require('./graph');
const { validateKernel, EDGE_TYPES } = require('./types');

// Optional W3.4 integration — required lazily to avoid load-order cycles.
let _productSpark = null;
function _getProductSpark() {
  if (_productSpark !== null) return _productSpark;
  try {
    _productSpark = require('../product-spark');
  } catch (_) {
    _productSpark = false; // sentinel: tried + failed
  }
  return _productSpark || null;
}

// Optional LLM hook — callers can inject by setting global.__hyphaWebNoteLLM
// to an async function. Default = deterministic mock.
async function _llmCall(tier, prompt, fallback) {
  const inj = (typeof global !== 'undefined') && global.__hyphaWebNoteLLM;
  if (typeof inj === 'function') {
    try {
      const out = await inj({ tier, prompt });
      if (out) return out;
    } catch (_) { /* fall through to deterministic mock */ }
  }
  return fallback;
}

// =====================================================================
// ID helpers
// =====================================================================

function _newId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function _approxTokens(text) {
  if (!text) return 0;
  // Rough: 4 chars per token (English) / 2 chars per token (CJK heavy).
  return Math.ceil(text.length / 3);
}

// =====================================================================
// raw → atomic
// =====================================================================

/**
 * Split a Raw note into ≥1 Atomic Card nodes. T4_JUDGE prompted (mock).
 * @param {string} slug
 * @param {string} rawNodeId
 * @param {object} atomicConfig { maxCards=5, minCardLen=20 }
 * @returns {Promise<{ ok, atomicIds[], edges[] }>}
 */
async function promoteRawToAtomic(slug, rawNodeId, atomicConfig = {}) {
  const raw = graph.getNode(slug, rawNodeId);
  if (!raw) return { ok: false, error: 'raw node not found: ' + rawNodeId };
  if (raw.layer !== 'raw') return { ok: false, error: 'source must be layer=raw, got ' + raw.layer };

  const maxCards = atomicConfig.maxCards || 5;
  const minLen = atomicConfig.minCardLen || 20;

  // Deterministic split: paragraphs separated by blank line, falling back to
  // sentence split. Real impl would call T4_JUDGE for thesis extraction.
  let candidates = String(raw.content || '')
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length >= minLen);
  if (candidates.length === 0) {
    candidates = String(raw.content || '')
      .split(/(?<=[.!?。！？])\s+/)
      .map(s => s.trim())
      .filter(s => s.length >= minLen);
  }
  if (candidates.length === 0 && raw.content) {
    // Single-card fallback: entire content as one atomic card.
    candidates = [raw.content.trim()];
  }
  candidates = candidates.slice(0, maxCards);

  // Optional LLM refinement (mocked).
  const refined = await _llmCall('T4_JUDGE',
    `split into atomic cards: ${raw.content.slice(0, 200)}...`,
    candidates
  );
  const finalCandidates = Array.isArray(refined) ? refined.slice(0, maxCards) : candidates;

  const atomicIds = [];
  const edges = [];
  for (const text of finalCandidates) {
    const id = _newId('atomic');
    const addRes = graph.addNode(slug, {
      id,
      layer: 'atomic',
      slug,
      content: text,
      frontmatter: { promoted_from: rawNodeId, llm_tier: 'T4_JUDGE_mock' },
      utility_score: 0.5,
    });
    if (!addRes.ok) continue;
    atomicIds.push(id);
    const eRes = graph.addEdge(slug, {
      from_id: rawNodeId,
      to_id: id,
      type: 'explains',
      strength: 0.6,
      utility_score: 0.5,
      token_cost: _approxTokens(text),
    });
    if (eRes.ok) edges.push(eRes.edge);
  }
  // Bump raw utility.
  graph.updateNode(slug, rawNodeId, {
    utility_score: Math.min(1, (raw.utility_score || 0.5) + 0.1),
    last_used: Date.now(),
  });
  return { ok: true, atomicIds, edges };
}

// =====================================================================
// atomic → concept
// =====================================================================

/**
 * Build a Concept Node from ≥2 Atomic Cards that share a concept name.
 * @param {string} slug
 * @param {string[]} atomicIds source atomic node ids
 * @param {string} conceptName the shared concept label
 * @returns {Promise<{ ok, conceptId?, edges?, error? }>}
 */
async function promoteAtomicToConcept(slug, atomicIds, conceptName) {
  if (!Array.isArray(atomicIds) || atomicIds.length < 2) {
    return { ok: false, error: 'need ≥2 atomic ids' };
  }
  if (!conceptName || typeof conceptName !== 'string') {
    return { ok: false, error: 'conceptName required' };
  }
  const atomics = atomicIds.map(id => graph.getNode(slug, id)).filter(Boolean);
  if (atomics.length !== atomicIds.length) {
    return { ok: false, error: 'some atomic nodes missing' };
  }
  for (const a of atomics) {
    if (a.layer !== 'atomic') return { ok: false, error: 'source not atomic: ' + a.id };
  }
  const id = _newId('concept');
  const content = await _llmCall('T3_MID',
    `synthesize concept "${conceptName}" from: ${atomics.map(a => a.content.slice(0, 100)).join(' | ')}`,
    `Concept · ${conceptName}\n\n` + atomics.map((a, i) => `  ${i + 1}. ${a.content.slice(0, 120)}`).join('\n')
  );
  const addRes = graph.addNode(slug, {
    id,
    layer: 'concept',
    slug,
    content: String(content),
    frontmatter: { concept_name: conceptName, source_atomics: atomicIds, llm_tier: 'T3_MID_mock' },
    utility_score: 0.55,
  });
  if (!addRes.ok) return addRes;
  const edges = [];
  for (const aId of atomicIds) {
    const eRes = graph.addEdge(slug, {
      from_id: aId,
      to_id: id,
      type: 'compresses',
      strength: 0.65,
      utility_score: 0.55,
    });
    if (eRes.ok) edges.push(eRes.edge);
  }
  return { ok: true, conceptId: id, edges };
}

// =====================================================================
// concept/atomic → spark
// =====================================================================

/**
 * Lift a Concept (or Atomic) node into a Spark — speculative novel claim.
 * @param {string} slug
 * @param {string} sourceNodeId
 * @param {object} sparkData { hypothesis: string, risk?, evidence_url? }
 * @returns {Promise<{ ok, sparkId?, edges? }>}
 */
async function promoteToSpark(slug, sourceNodeId, sparkData) {
  const src = graph.getNode(slug, sourceNodeId);
  if (!src) return { ok: false, error: 'source not found: ' + sourceNodeId };
  if (src.layer !== 'concept' && src.layer !== 'atomic') {
    return { ok: false, error: 'spark source must be atomic|concept, got ' + src.layer };
  }
  if (!sparkData || !sparkData.hypothesis) {
    return { ok: false, error: 'sparkData.hypothesis required' };
  }
  const id = _newId('spark');
  const text = String(sparkData.hypothesis);
  const addRes = graph.addNode(slug, {
    id,
    layer: 'spark',
    slug,
    content: text,
    frontmatter: {
      source_node: sourceNodeId,
      risk: sparkData.risk || null,
      evidence_url: sparkData.evidence_url || null,
    },
    utility_score: 0.5,
  });
  if (!addRes.ok) return addRes;
  const eRes = graph.addEdge(slug, {
    from_id: sourceNodeId,
    to_id: id,
    type: 'sparks',
    strength: 0.7,
    utility_score: 0.5,
  });
  return { ok: true, sparkId: id, edges: eRes.ok ? [eRes.edge] : [] };
}

// =====================================================================
// spark → product_spark (W3.4 bridge)
// =====================================================================

/**
 * Bind a Spark to a Product. Calls W3.4 createSpark if available, then
 * mirrors a product_spark node into this graph + 'productizes' edge.
 *
 * @param {string} slug
 * @param {string} sparkNodeId
 * @param {string} productSlug   the bound product slug (may === slug)
 * @returns {Promise<{ ok, productSparkId?, w34SparkId?, edges? }>}
 */
async function promoteToProductSpark(slug, sparkNodeId, productSlug) {
  const src = graph.getNode(slug, sparkNodeId);
  if (!src) return { ok: false, error: 'spark not found: ' + sparkNodeId };
  if (src.layer !== 'spark') return { ok: false, error: 'source must be layer=spark' };

  // W3.4 hand-off. Best-effort: if module missing or errors, we still
  // mirror locally — the graph node is the substrate; W3.4 file is index.
  let w34SparkId = null;
  const ps = _getProductSpark();
  if (ps && typeof ps.createSpark === 'function') {
    try {
      const res = ps.createSpark(productSlug || slug, {
        seed_text: src.content,
        source: 'web-note-engine:' + sparkNodeId,
      });
      if (res && (res.ok === true || res.spark)) {
        w34SparkId = (res.spark && res.spark.id) || res.id || null;
      }
    } catch (_) { /* fallthrough to local-only mirror */ }
  }

  const id = _newId('pspark');
  const addRes = graph.addNode(slug, {
    id,
    layer: 'product_spark',
    slug,
    content: src.content,
    frontmatter: {
      source_spark: sparkNodeId,
      product_slug: productSlug || slug,
      w34_spark_id: w34SparkId,
    },
    utility_score: 0.6,
  });
  if (!addRes.ok) return addRes;
  const eRes = graph.addEdge(slug, {
    from_id: sparkNodeId,
    to_id: id,
    type: 'productizes',
    strength: 0.75,
    utility_score: 0.6,
  });
  return { ok: true, productSparkId: id, w34SparkId, edges: eRes.ok ? [eRes.edge] : [] };
}

// =====================================================================
// distillKernel — N nodes → 1 Kernel Summary (T6_STRONG)
// =====================================================================

/**
 * Distill ≥2 nodes into a Kernel Summary. Stored as kernel JSON + a Kernel
 * node + 'compresses' edges from each source.
 *
 * @param {string} slug
 * @param {string[]} nodeIds
 * @param {object} opts { tokenBudget?, version? }
 * @returns {Promise<{ ok, kernelId?, kernelNodeId?, edges? }>}
 */
async function distillKernel(slug, nodeIds, opts = {}) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    return { ok: false, error: 'nodeIds required (≥1)' };
  }
  const nodes = nodeIds.map(id => graph.getNode(slug, id)).filter(Boolean);
  if (nodes.length === 0) return { ok: false, error: 'no source nodes resolved' };
  const budget = opts.tokenBudget || 400;
  const version = opts.version || 1;

  // Mock distillation: take first 1-2 sentences of each, concat, trim to budget.
  const fragments = nodes.map(n => {
    const txt = String(n.content || '').trim();
    return txt.split(/(?<=[.!?。！？])\s+/).slice(0, 1).join(' ').slice(0, 180);
  });
  const stitched = `Kernel(${nodes.length}): ` + fragments.join(' · ');
  const summary = await _llmCall('T6_STRONG',
    `distill kernel from ${nodes.length} nodes:\n` + nodes.map(n => '- ' + n.content.slice(0, 100)).join('\n'),
    stitched
  );
  const summaryStr = String(summary).slice(0, budget * 3); // ~3 chars/token cap

  const kernelId = _newId('kernel');
  const kernel = {
    id: kernelId,
    summary: summaryStr,
    source_node_ids: nodeIds,
    created_at: Date.now(),
    token_count: _approxTokens(summaryStr),
    version,
  };
  const kv = validateKernel(kernel);
  if (!kv.ok) return kv;
  graph.writeKernel(slug, kv.value);

  // Also write a 'kernel' layer node so it lives in the graph.
  const kernelNodeId = _newId('knode');
  const addRes = graph.addNode(slug, {
    id: kernelNodeId,
    layer: 'kernel',
    slug,
    content: summaryStr,
    frontmatter: { kernel_id: kernelId, source_count: nodeIds.length, version },
    utility_score: 0.7,
  });
  if (!addRes.ok) return addRes;

  const edges = [];
  for (const id of nodeIds) {
    const eRes = graph.addEdge(slug, {
      from_id: id,
      to_id: kernelNodeId,
      type: 'compresses',
      strength: 0.8,
      utility_score: 0.7,
      token_cost: kernel.token_count,
    });
    if (eRes.ok) edges.push(eRes.edge);
  }
  return { ok: true, kernelId, kernelNodeId, edges };
}

// =====================================================================
// Exports
// =====================================================================

module.exports = {
  promoteRawToAtomic,
  promoteAtomicToConcept,
  promoteToSpark,
  promoteToProductSpark,
  distillKernel,
  _internals: {
    approxTokens: _approxTokens,
    newId: _newId,
  },
};
