'use strict';

// HYPHA · GraphRAG over Library — top-level API (Phase B Gap 4, 2026-05-17).
//
// Replaces the BM25/keyword path in `_harvestLibrary` for course-goal-driven
// chunk retrieval. Cures the "诺贝尔文学 → 学/文/尔 单字" CJK tokenizer collapse
// caught by user 2026-05-17 — a philosophy-of-Plato book scoring above a
// Kawabata Nobel-laureate biography because "学" is a high-frequency CJK
// character in 哲学/学说/学派.
//
// Architecture (Microsoft GraphRAG / LazyGraphRAG-inspired):
//   1. EXTRACT — LLM walks book chunks 5 at a time, pulls entities (people /
//      concepts / schools / eras / terms) + relationships using the 13 typed
//      edges from app/lib/web-note-engine/types.js. Cheap T3_MID tier, batched.
//   2. COMMUNITY — Louvain (graphology-communities-louvain) clusters the
//      resulting graph into thematic communities. Each cluster carries the
//      "Nobel literature" or "rationalist metaphysics" sense the keyword
//      tokenizer alone cannot pick up.
//   3. SUMMARIZE — T3_MID one-line theme per community.
//   4. QUERY — LLM expands courseGoal → entity list, looks each up across all
//      book-level graphs, walks ≤ depth 3 along prerequisite/extends edges,
//      returns chunks with full provenance trail (hit_node, walked_via).
//
// Per book artifact: `<vault>/data/library/<book_id>.graph.json` — adjacent
// to the existing manifest .json + .txt. Schema in `extract.js`.
//
// Graceful fallback: if the graph file is missing OR queryGraph throws,
// `_harvestLibrary` in agent.js drops back to the BM25 legacy implementation
// (kept under `_harvestLibraryBM25Legacy`). GraphRAG is additive, not a
// hard cutover.

const fs = require('node:fs');
const path = require('node:path');

const LIBRARY_SUBDIR = 'data/library';
const GRAPH_VERSION = 1;

/**
 * Returns the absolute path to a book's graph.json sidecar.
 * @param {string} vaultRoot
 * @param {string} bookId
 * @returns {string}
 */
function getGraphPath(vaultRoot, bookId) {
  if (!vaultRoot || !bookId) throw new Error('vaultRoot + bookId required');
  return path.join(vaultRoot, LIBRARY_SUBDIR, `${bookId}.graph.json`);
}

function _manifestPath(vaultRoot, bookId) {
  return path.join(vaultRoot, LIBRARY_SUBDIR, `${bookId}.json`);
}

function _safeReadJSON(absPath) {
  try {
    if (!fs.existsSync(absPath)) return null;
    const raw = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

/**
 * Build a graph for a single book. End-to-end: load manifest → extract
 * entities/edges (batched LLM) → community detection → per-community summary
 * → write sidecar JSON.
 *
 * @param {string} bookId
 * @param {object} opts
 * @param {string} opts.vaultRoot
 * @param {object} [opts.settings]
 * @param {function} [opts.onProgress] (stage, payload) => void
 * @returns {Promise<{ok, graphPath?, stats?, error?}>}
 */
async function buildGraph(bookId, opts = {}) {
  const { vaultRoot, settings, onProgress } = opts;
  const emit = typeof onProgress === 'function' ? onProgress : () => {};
  if (!vaultRoot || !bookId) {
    return { ok: false, error: 'vaultRoot + bookId required' };
  }
  const manifest = _safeReadJSON(_manifestPath(vaultRoot, bookId));
  if (!manifest || !Array.isArray(manifest.chunks)) {
    return { ok: false, error: 'manifest missing or has no chunks' };
  }

  emit('graph-rag:extract:start', { bookId, chunkCount: manifest.chunks.length });
  const extractMod = require('./extract');
  let extracted;
  try {
    extracted = await extractMod.extractEntitiesAndEdges({
      manifest,
      settings,
      onProgress: (sub, p) => emit('graph-rag:extract:' + sub, { bookId, ...p }),
    });
  } catch (err) {
    return { ok: false, error: 'extract failed: ' + (err && err.message) };
  }
  emit('graph-rag:extract:done', {
    bookId,
    nodes: extracted.nodes.length,
    edges: extracted.edges.length,
    llmCalls: extracted.llm_calls,
  });

  emit('graph-rag:community:start', { bookId });
  let communities = [];
  try {
    const communityMod = require('./community');
    communities = communityMod.detectCommunities({
      nodes: extracted.nodes,
      edges: extracted.edges,
    });
  } catch (err) {
    // Graph too small or graphology missing → fallback: one community per node.
    // Don't fail the whole build over it.
    communities = extracted.nodes.map((n, i) => ({ community_id: i, node_ids: [n.id], level: 0 }));
    emit('graph-rag:community:fallback', { bookId, reason: err && err.message });
  }
  emit('graph-rag:community:done', { bookId, communityCount: communities.length });

  emit('graph-rag:summarize:start', { bookId });
  let summaries = [];
  try {
    const summarizeMod = require('./summarize');
    summaries = await summarizeMod.summarizeCommunities({
      communities,
      nodes: extracted.nodes,
      manifest,
      settings,
    });
  } catch (err) {
    summaries = communities.map(c => ({
      community_id: c.community_id,
      summary: '(summary unavailable)',
      top_nodes: c.node_ids.slice(0, 5),
    }));
    emit('graph-rag:summarize:fallback', { bookId, reason: err && err.message });
  }
  emit('graph-rag:summarize:done', { bookId, summaryCount: summaries.length });

  const graph = {
    book_id: bookId,
    book_title: manifest.title || '',
    book_author: manifest.author || '',
    version: GRAPH_VERSION,
    extracted_at: new Date().toISOString(),
    nodes: extracted.nodes,
    edges: extracted.edges,
    communities,
    community_summaries: summaries,
    stats: {
      node_count: extracted.nodes.length,
      edge_count: extracted.edges.length,
      community_count: communities.length,
      llm_calls: extracted.llm_calls,
      extraction_cost_usd_estimate: extracted.cost_usd_estimate || 0,
    },
  };

  const graphPath = getGraphPath(vaultRoot, bookId);
  try {
    fs.mkdirSync(path.dirname(graphPath), { recursive: true });
    fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2), 'utf8');
  } catch (err) {
    return { ok: false, error: 'write failed: ' + (err && err.message) };
  }
  emit('graph-rag:done', { bookId, graphPath, stats: graph.stats });
  return { ok: true, graphPath, stats: graph.stats };
}

/**
 * Query all book graphs for chunks matching a course goal. LLM expands goal
 * into entity list, walks each book's graph from any matching entity,
 * collects up to k chunks ranked by hit-directness + community-summary match.
 *
 * @param {object} args
 * @param {string} args.courseGoal     e.g. "诺贝尔文学" / "斯宾诺莎伦理学"
 * @param {string} [args.archetype]    optional archetype hint
 * @param {number} [args.k=10]
 * @param {string} args.vaultRoot
 * @param {object} [args.settings]
 * @returns {Promise<Array<{book_id, book_title, chunk_idx, snippet, hit_node, walked_via}>>}
 */
async function queryGraph(args = {}) {
  const queryMod = require('./query');
  return queryMod.runQuery(args);
}

/**
 * Rebuild graphs for every book in the library. Useful after schema bump
 * or after user uploads a batch with the build hook disabled.
 *
 * @param {object} opts
 * @param {string} opts.vaultRoot
 * @param {object} [opts.settings]
 * @param {function} [opts.onProgress] (stage, payload) => void
 * @returns {Promise<{ok, built, failed, errors}>}
 */
async function rebuildAll(opts = {}) {
  const { vaultRoot, settings, onProgress } = opts;
  if (!vaultRoot) return { ok: false, error: 'vaultRoot required', built: 0, failed: 0, errors: [] };
  const emit = typeof onProgress === 'function' ? onProgress : () => {};
  const dir = path.join(vaultRoot, LIBRARY_SUBDIR);
  if (!fs.existsSync(dir)) return { ok: true, built: 0, failed: 0, errors: [] };
  const bookIds = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
    if (ent.name.endsWith('.graph.json')) continue;
    const m = _safeReadJSON(path.join(dir, ent.name));
    if (m && m.id) bookIds.push(m.id);
  }
  let built = 0; let failed = 0;
  const errors = [];
  for (const id of bookIds) {
    emit('graph-rag:rebuild:book-start', { bookId: id, total: bookIds.length });
    try {
      const r = await buildGraph(id, { vaultRoot, settings, onProgress: emit });
      if (r && r.ok) built++; else { failed++; errors.push({ bookId: id, error: r && r.error }); }
    } catch (e) {
      failed++; errors.push({ bookId: id, error: (e && e.message) || String(e) });
    }
  }
  emit('graph-rag:rebuild:done', { built, failed });
  return { ok: failed === 0, built, failed, errors };
}

module.exports = {
  buildGraph,
  queryGraph,
  rebuildAll,
  getGraphPath,
  GRAPH_VERSION,
};
