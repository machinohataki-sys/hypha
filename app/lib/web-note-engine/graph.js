'use strict';

// HYPHA · W5.2 Web Note Engine — graph CRUD on fs
//
// Storage layout (hidden — does not pollute the canonical lesson notes):
//
//   vault/<slug>/.web-graph/
//     nodes/<node-id>.json     ← one JSON per node (validated NODE_SCHEMA)
//     edges.jsonl              ← append-only line-delimited JSON, validated
//     kernels/<kernel-id>.json ← distilled kernel summaries
//
// edges.jsonl is append-only so writes are crash-safe + O(1) (cheaper than
// rewriting a big edges.json on every addEdge). Lookups stream and filter.
// Deletes write a tombstone row { tombstone: true, id }.
//
// All paths land under vault/<slug>/.web-graph/. _vaultRoot mirrors
// product-spark.js so the two streams share the same HYPHA_VAULT_DIR env.
//
// No LLM. No Electron. Pure fs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { validateEdge, validateNode, EDGE_TYPES } = require('./types');

// =====================================================================
// Path resolution (mirrors product-spark.js _vaultRoot)
// =====================================================================

function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  return path.join(__dirname, '..', '..', '..', 'data');
}

function _graphRoot(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('graph: slug required (non-empty string)');
  }
  return path.join(_vaultRoot(), slug, '.web-graph');
}

function _nodesDir(slug) { return path.join(_graphRoot(slug), 'nodes'); }
function _edgesPath(slug) { return path.join(_graphRoot(slug), 'edges.jsonl'); }
function _kernelsDir(slug) { return path.join(_graphRoot(slug), 'kernels'); }
function _nodePath(slug, nodeId) { return path.join(_nodesDir(slug), `${nodeId}.json`); }
function _kernelPath(slug, kernelId) { return path.join(_kernelsDir(slug), `${kernelId}.json`); }

function _ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function _ensureGraph(slug) {
  _ensureDir(_graphRoot(slug));
  _ensureDir(_nodesDir(slug));
  _ensureDir(_kernelsDir(slug));
  const edgesPath = _edgesPath(slug);
  if (!fs.existsSync(edgesPath)) fs.writeFileSync(edgesPath, '', 'utf8');
}

// Safe id sanitizer — only [A-Za-z0-9_-]. Used by addNode/addEdge to defend
// against path traversal if the caller smuggles `..` into a node id.
function _sanitizeId(id) {
  if (!id || typeof id !== 'string') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

function _generateEdgeId() {
  return 'e-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

// =====================================================================
// Node CRUD
// =====================================================================

/**
 * Persist a node to vault/<slug>/.web-graph/nodes/<id>.json.
 * @param {string} slug curriculum slug
 * @param {object} node node body (validated against NODE_SCHEMA)
 * @returns {{ ok:true, node:object } | { ok:false, error:string }}
 */
function addNode(slug, node) {
  if (!slug) return { ok: false, error: 'slug required' };
  const merged = Object.assign({}, node, { slug });

  // W7.3 Citation + Global Trust — if the node's content carries inline URLs
  // and the caller didn't already supply `frontmatter.citations`, auto-harvest
  // them so trust badges + risk warnings can render uniformly across notes,
  // sparks, radar nodes. Skipped silently if citation-system unavailable.
  try {
    const fm = merged.frontmatter || {};
    if (!Array.isArray(fm.citations) && typeof merged.content === 'string' && merged.content.length > 0) {
      const _cs = require('../citation-system');
      const harvest = _cs.harvestCitationsFromText(merged.content, { intent: 'private_learn' });
      if (harvest.length > 0) {
        merged.frontmatter = Object.assign({}, fm, {
          citations: harvest.map(h => ({
            url: h.citation.source_url,
            type: h.citation.type,
            trust_score: h.trust.score,
            tier: h.tier,
            risk_level: h.risk.risk_level,
          })),
        });
      }
    }
  } catch (_) { /* best-effort enrichment; never block node persistence */ }

  const v = validateNode(merged);
  if (!v.ok) return v;
  if (!_sanitizeId(v.value.id)) {
    return { ok: false, error: 'node.id must match [A-Za-z0-9_-]+' };
  }
  _ensureGraph(slug);
  const p = _nodePath(slug, v.value.id);
  if (fs.existsSync(p)) {
    return { ok: false, error: 'node already exists: ' + v.value.id };
  }
  fs.writeFileSync(p, JSON.stringify(v.value, null, 2), 'utf8');
  return { ok: true, node: v.value };
}

function _readNodeFile(p) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Read a node by id. Returns null if missing or malformed.
 */
function getNode(slug, nodeId) {
  if (!_sanitizeId(nodeId)) return null;
  const p = _nodePath(slug, nodeId);
  if (!fs.existsSync(p)) return null;
  return _readNodeFile(p);
}

/**
 * List nodes in a slug. Optional filter `{ layer?, minUtility? }`.
 */
function listNodes(slug, filter = {}) {
  const dir = _nodesDir(slug);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const node = _readNodeFile(path.join(dir, name));
    if (!node) continue;
    if (filter.layer && node.layer !== filter.layer) continue;
    if (filter.minUtility != null && node.utility_score < filter.minUtility) continue;
    out.push(node);
  }
  return out;
}

/**
 * Update node fields (merges; preserves id/slug/layer unless explicitly set).
 */
function updateNode(slug, nodeId, patch) {
  const existing = getNode(slug, nodeId);
  if (!existing) return { ok: false, error: 'node not found: ' + nodeId };
  const merged = Object.assign({}, existing, patch, {
    id: existing.id,
    slug: existing.slug,
  });
  const v = validateNode(merged);
  if (!v.ok) return v;
  fs.writeFileSync(_nodePath(slug, nodeId), JSON.stringify(v.value, null, 2), 'utf8');
  return { ok: true, node: v.value };
}

/**
 * Remove a node. cascade=true also tombstones all edges referencing it.
 */
function removeNode(slug, nodeId, cascade = true) {
  if (!_sanitizeId(nodeId)) return { ok: false, error: 'invalid node id' };
  const p = _nodePath(slug, nodeId);
  if (!fs.existsSync(p)) return { ok: false, error: 'node not found: ' + nodeId };
  fs.unlinkSync(p);
  let removedEdges = 0;
  if (cascade) {
    const edges = _readAllEdges(slug);
    const edgesPath = _edgesPath(slug);
    const remaining = [];
    for (const e of edges) {
      if (e.from_id === nodeId || e.to_id === nodeId) {
        remaining.push({ tombstone: true, id: e._id, reason: 'cascade:' + nodeId });
        removedEdges++;
      }
    }
    if (remaining.length > 0) {
      fs.appendFileSync(edgesPath, remaining.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    }
  }
  return { ok: true, removedEdges };
}

// =====================================================================
// Edge CRUD (append-only jsonl with tombstones)
// =====================================================================

/**
 * Append an edge. Returns { ok:true, edge } including assigned id.
 */
function addEdge(slug, edge) {
  const v = validateEdge(edge);
  if (!v.ok) return v;
  _ensureGraph(slug);
  // Cheap referential check — both nodes should exist. We warn but allow
  // (raw → atomic promotion may pre-stage an edge before the target node).
  const fromExists = !!getNode(slug, v.value.from_id);
  const toExists = !!getNode(slug, v.value.to_id);
  const id = _generateEdgeId();
  const row = Object.assign({ _id: id }, v.value, {
    _refs: { from_exists: fromExists, to_exists: toExists },
  });
  fs.appendFileSync(_edgesPath(slug), JSON.stringify(row) + '\n', 'utf8');
  // Update node.edges_from / edges_to indices (best-effort; ok if node missing).
  if (fromExists) {
    const n = getNode(slug, v.value.from_id);
    if (n && !n.edges_from.includes(id)) {
      updateNode(slug, v.value.from_id, { edges_from: n.edges_from.concat([id]) });
    }
  }
  if (toExists) {
    const n = getNode(slug, v.value.to_id);
    if (n && !n.edges_to.includes(id)) {
      updateNode(slug, v.value.to_id, { edges_to: n.edges_to.concat([id]) });
    }
  }
  return { ok: true, edge: row };
}

function _readAllEdges(slug) {
  const p = _edgesPath(slug);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return [];
  // Single pass: replay log keeping LAST row per _id. A tombstone for id X
  // overrides any prior row with that id (but a later non-tombstone re-creates
  // it — supports updateEdge: tombstone-then-write keeps the new row visible).
  const byId = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (r && r.tombstone === true && r.id) {
      byId.set(r.id, null);
      continue;
    }
    if (r && r._id) byId.set(r._id, r);
  }
  const out = [];
  for (const v of byId.values()) if (v) out.push(v);
  return out;
}

/**
 * Get edges incident on nodeId. direction = 'from' | 'to' | 'both'.
 * Filter `{ types?, status? }` optional.
 */
function getEdges(slug, nodeId, direction = 'both', filter = {}) {
  const all = _readAllEdges(slug);
  return all.filter(e => {
    if (direction === 'from' && e.from_id !== nodeId) return false;
    if (direction === 'to' && e.to_id !== nodeId) return false;
    if (direction === 'both' && e.from_id !== nodeId && e.to_id !== nodeId) return false;
    if (filter.types && Array.isArray(filter.types) && filter.types.length > 0) {
      if (!filter.types.includes(e.type)) return false;
    }
    if (filter.status && e.status !== filter.status) return false;
    return true;
  });
}

/**
 * List all edges in slug. Used by entropy-reduction sweeps.
 */
function listAllEdges(slug) {
  return _readAllEdges(slug);
}

/**
 * Update edge by id. Patch is merged; missing edge → { ok:false }.
 */
function updateEdge(slug, edgeId, patch) {
  const all = _readAllEdges(slug);
  const existing = all.find(e => e._id === edgeId);
  if (!existing) return { ok: false, error: 'edge not found: ' + edgeId };
  // Tombstone old, append new with same id.
  const merged = Object.assign({}, existing, patch, {
    from_id: existing.from_id,
    to_id: existing.to_id,
    type: existing.type,
  });
  const v = validateEdge(merged);
  if (!v.ok) return v;
  const newRow = Object.assign({ _id: edgeId }, v.value, { _refs: existing._refs || {} });
  const edgesPath = _edgesPath(slug);
  fs.appendFileSync(
    edgesPath,
    JSON.stringify({ tombstone: true, id: edgeId, reason: 'update' }) + '\n' +
      JSON.stringify(newRow) + '\n',
    'utf8'
  );
  return { ok: true, edge: newRow };
}

// =====================================================================
// Graph traversal — BFS with depth + edge-type filter
// =====================================================================

/**
 * Walk graph from startId. opts = { maxDepth=2, edgeTypes=[], direction='both' }.
 * Returns { visited: [{ id, depth, node }], edges: [edge] }.
 */
function walkGraph(slug, startId, opts = {}) {
  const maxDepth = opts.maxDepth == null ? 2 : opts.maxDepth;
  const edgeTypes = Array.isArray(opts.edgeTypes) ? opts.edgeTypes : [];
  const direction = opts.direction || 'both';
  const startNode = getNode(slug, startId);
  if (!startNode) return { visited: [], edges: [] };

  const visited = new Map(); // id → depth
  const visitedNodes = [];
  const usedEdges = new Map(); // _id → edge

  const queue = [{ id: startId, depth: 0 }];
  visited.set(startId, 0);
  visitedNodes.push({ id: startId, depth: 0, node: startNode });

  while (queue.length > 0) {
    const { id, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    const edges = getEdges(slug, id, direction, {
      types: edgeTypes.length > 0 ? edgeTypes : undefined,
      status: 'active',
    });
    for (const e of edges) {
      usedEdges.set(e._id, e);
      const neighborId = e.from_id === id ? e.to_id : e.from_id;
      if (visited.has(neighborId)) continue;
      const nn = getNode(slug, neighborId);
      if (!nn) continue;
      visited.set(neighborId, depth + 1);
      visitedNodes.push({ id: neighborId, depth: depth + 1, node: nn });
      queue.push({ id: neighborId, depth: depth + 1 });
    }
  }
  return { visited: visitedNodes, edges: Array.from(usedEdges.values()) };
}

// =====================================================================
// Merge — collapse N nodes into 1 for Entropy Reduction
// =====================================================================

/**
 * Merge multiple nodes into a new node. Union edges_from/edges_to. Caller
 * supplies the merged node body (id + layer + content). Source nodes are
 * removed (cascade=false — edges re-pointed to merged.id below).
 *
 * @param {string} slug
 * @param {string[]} nodeIds nodes to merge (length ≥ 2)
 * @param {object} mergedNode new node body
 * @returns {{ ok, mergedNode?, error? }}
 */
function mergeNodes(slug, nodeIds, mergedNode) {
  if (!Array.isArray(nodeIds) || nodeIds.length < 2) {
    return { ok: false, error: 'mergeNodes requires ≥2 node ids' };
  }
  const sources = nodeIds.map(id => getNode(slug, id)).filter(Boolean);
  if (sources.length !== nodeIds.length) {
    return { ok: false, error: 'one or more source nodes missing' };
  }
  // Aggregate union of edges_from / edges_to.
  const fromUnion = new Set();
  const toUnion = new Set();
  for (const s of sources) {
    for (const e of s.edges_from) fromUnion.add(e);
    for (const e of s.edges_to) toUnion.add(e);
  }
  const final = Object.assign({}, mergedNode, {
    slug,
    edges_from: Array.from(fromUnion),
    edges_to: Array.from(toUnion),
  });
  const v = validateNode(final);
  if (!v.ok) return v;

  // Write merged node first (so re-pointing edges has a valid target).
  if (!_sanitizeId(v.value.id)) return { ok: false, error: 'merged node id invalid' };
  _ensureGraph(slug);
  fs.writeFileSync(_nodePath(slug, v.value.id), JSON.stringify(v.value, null, 2), 'utf8');

  // Re-point existing edges (tombstone old, append re-targeted under a fresh
  // _id — reusing the old id would cause _readAllEdges to mask both rows).
  const sourceIds = new Set(nodeIds);
  const allEdges = _readAllEdges(slug);
  const edgesPath = _edgesPath(slug);
  const buf = [];
  for (const e of allEdges) {
    const touchesSource = sourceIds.has(e.from_id) || sourceIds.has(e.to_id);
    if (!touchesSource) continue;
    if (sourceIds.has(e.from_id) && sourceIds.has(e.to_id)) {
      // Both endpoints merged into one — degenerate self-edge, drop.
      buf.push(JSON.stringify({ tombstone: true, id: e._id, reason: 'merge-collapse' }));
      continue;
    }
    const newRow = Object.assign({}, e, {
      _id: _generateEdgeId(),
      from_id: sourceIds.has(e.from_id) ? v.value.id : e.from_id,
      to_id: sourceIds.has(e.to_id) ? v.value.id : e.to_id,
    });
    buf.push(JSON.stringify({ tombstone: true, id: e._id, reason: 'merge-repoint' }));
    buf.push(JSON.stringify(newRow));
  }
  if (buf.length > 0) {
    fs.appendFileSync(edgesPath, buf.join('\n') + '\n', 'utf8');
  }

  // Remove source node files (no further cascade — edges already re-pointed).
  for (const id of nodeIds) {
    if (id === v.value.id) continue; // safety: don't delete the merged target
    const p = _nodePath(slug, id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  return { ok: true, mergedNode: v.value };
}

// =====================================================================
// Kernel storage (used by layer-promotion.distillKernel)
// =====================================================================

function writeKernel(slug, kernel) {
  _ensureGraph(slug);
  if (!_sanitizeId(kernel.id)) return { ok: false, error: 'kernel.id invalid' };
  fs.writeFileSync(_kernelPath(slug, kernel.id), JSON.stringify(kernel, null, 2), 'utf8');
  return { ok: true, kernel };
}

function readKernel(slug, kernelId) {
  if (!_sanitizeId(kernelId)) return null;
  const p = _kernelPath(slug, kernelId);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function listKernels(slug) {
  const dir = _kernelsDir(slug);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

// =====================================================================
// Exports
// =====================================================================

module.exports = {
  // Nodes
  addNode,
  getNode,
  listNodes,
  updateNode,
  removeNode,
  // Edges
  addEdge,
  getEdges,
  listAllEdges,
  updateEdge,
  // Walk + merge
  walkGraph,
  mergeNodes,
  // Kernel
  writeKernel,
  readKernel,
  listKernels,
  // Internals for tests / orchestrator
  _internals: {
    vaultRoot: _vaultRoot,
    graphRoot: _graphRoot,
    edgesPath: _edgesPath,
    nodesDir: _nodesDir,
    ensureGraph: _ensureGraph,
    readAllEdges: _readAllEdges,
    sanitizeId: _sanitizeId,
  },
};
