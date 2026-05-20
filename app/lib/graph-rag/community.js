'use strict';

// HYPHA · GraphRAG · Community Detection (Phase B Gap 4).
//
// Uses graphology + graphology-communities-louvain to cluster the
// entity graph into thematic communities. Louvain is greedy-modularity-
// optimal — close cousin of Leiden, well-supported in JS-land, no native
// dependency.
//
// Caveat (honest gap): Louvain is NOT Leiden. Leiden's refinement step
// guarantees connected communities; Louvain can produce disconnected ones.
// For book-level graphs (typically <500 nodes), the difference is usually
// negligible. If quality matters more than runtime, swap in a Leiden impl
// later (none of the WASM/JS Leiden libs were stable enough in May 2026).

let Graph, louvain;
try {
  Graph = require('graphology');
  louvain = require('graphology-communities-louvain');
} catch (err) {
  // Module not installed — caller falls back to one-node-per-community.
  Graph = null;
  louvain = null;
}

/**
 * Run community detection over the entity+edge graph.
 *
 * @param {object} args
 * @param {Array} args.nodes  [{id, ...}]
 * @param {Array} args.edges  [{from, to, type, ...}]
 * @returns {Array<{community_id, node_ids, level}>}
 */
function detectCommunities({ nodes, edges }) {
  if (!Array.isArray(nodes) || nodes.length === 0) return [];
  // Degenerate: 1 node → 1 community
  if (nodes.length === 1) {
    return [{ community_id: 0, node_ids: [nodes[0].id], level: 0 }];
  }
  if (!Graph || !louvain) {
    // Library not installed — degrade to one community per node so downstream
    // doesn't crash. Caller's onProgress already emitted a fallback notice.
    return nodes.map((n, i) => ({ community_id: i, node_ids: [n.id], level: 0 }));
  }

  // Build undirected graph for Louvain (modularity-optimal partitioning works
  // on undirected representation; edge type is preserved on the side).
  // Use multi=false (single edge per pair); collapse parallel typed edges.
  const g = new Graph({ multi: false, type: 'undirected' });
  for (const n of nodes) {
    if (!g.hasNode(n.id)) g.addNode(n.id);
  }
  const seen = new Set();
  for (const e of (edges || [])) {
    if (!e || !e.from || !e.to) continue;
    if (!g.hasNode(e.from) || !g.hasNode(e.to)) continue;
    if (e.from === e.to) continue;
    const key = e.from < e.to ? `${e.from}::${e.to}` : `${e.to}::${e.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try { g.addEdge(e.from, e.to); } catch (_) {}
  }

  // graphology-communities-louvain returns { node_id: community_index }
  let assignment;
  try {
    assignment = louvain(g);
  } catch (err) {
    // E.g. graph with no edges (isolated nodes): each node = its own community
    return nodes.map((n, i) => ({ community_id: i, node_ids: [n.id], level: 0 }));
  }

  const byCommunity = new Map();
  for (const nodeId of Object.keys(assignment || {})) {
    const cid = assignment[nodeId];
    if (!byCommunity.has(cid)) byCommunity.set(cid, []);
    byCommunity.get(cid).push(nodeId);
  }
  // Also include any nodes Louvain missed (defensive — shouldn't happen)
  for (const n of nodes) {
    let found = false;
    for (const arr of byCommunity.values()) {
      if (arr.includes(n.id)) { found = true; break; }
    }
    if (!found) {
      const newId = byCommunity.size;
      byCommunity.set(newId, [n.id]);
    }
  }

  const out = [];
  let cid = 0;
  for (const node_ids of byCommunity.values()) {
    out.push({ community_id: cid++, node_ids, level: 0 });
  }
  return out;
}

module.exports = {
  detectCommunities,
};
