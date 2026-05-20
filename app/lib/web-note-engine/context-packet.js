'use strict';

// HYPHA · W5.2 Web Note Engine — Context Packet extractor (BLUEPRINT §10.1)
//
// Core principle: the LLM NEVER sees the full graph. Each call gets a
// budget-bounded Context Packet — a walk from one query node, filtered by
// the most relevant edge types, ranked by (strength × utility_score),
// truncated to token budget.
//
// Pairs with W5.1 Cheap Router's packContext() if shipped. We feature-detect
// and fall back to a deterministic local packer if W5.1 is not yet loadable.

const graph = require('./graph');

// W5.1 hand-off — optional, feature-detected. W5.1 ships as
// app/lib/llm/cheap-router.js; packContext is the integration surface
// (per BLUEPRINT §17.2). Until W5.1 exports packContext we fall back to
// local pack (still deterministic).
function _tryW51() {
  const tryPaths = ['../llm/cheap-router', '../cheap-router'];
  for (const p of tryPaths) {
    try {
      const mod = require(p);
      if (mod && typeof mod.packContext === 'function') return mod;
    } catch (_) { /* try next */ }
  }
  return null;
}

// =====================================================================
// Default relevance-prioritized edge types for context packing.
// (Order matters — earlier types dominate when walking with a depth budget.)
// =====================================================================

const DEFAULT_PACKET_EDGE_TYPES = Object.freeze([
  'explains',
  'prerequisite',
  'extends',
  'compresses',
  'operationalizes',
  'example_of',
]);

function _approxTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 3);
}

// =====================================================================
// Local packer (used when W5.1 unavailable)
// =====================================================================

function _localPack(visitedNodes, budgetTokens) {
  // visitedNodes: [{ id, depth, node, score }]. Already sorted by score desc.
  const used = [];
  const dropped = [];
  let acc = 0;
  const sections = [];
  for (const v of visitedNodes) {
    const layer = v.node.layer.toUpperCase();
    const headline = `[${layer} · ${v.id} · depth=${v.depth} · score=${v.score.toFixed(3)}]`;
    const body = v.node.content || '';
    const cost = _approxTokens(headline) + _approxTokens(body) + 2;
    if (acc + cost > budgetTokens) {
      dropped.push({ id: v.id, reason: 'budget', tokensNeeded: cost });
      continue;
    }
    acc += cost;
    sections.push(headline + '\n' + body);
    used.push({ id: v.id, layer: v.node.layer, tokens: cost });
  }
  return { packetText: sections.join('\n\n---\n\n'), usedNodes: used, dropped, tokensUsed: acc };
}

// =====================================================================
// Public — buildContextPacket
// =====================================================================

/**
 * Build a Context Packet rooted at queryNodeId.
 *
 * @param {string} slug
 * @param {string} queryNodeId  start node
 * @param {number} budgetTokens approximate token budget for packetText
 * @param {object} [opts] { maxDepth=2, edgeTypes=DEFAULT_PACKET_EDGE_TYPES }
 * @returns {Promise<{ ok, packetText, usedNodes, dropped, tokensUsed }>}
 */
async function buildContextPacket(slug, queryNodeId, budgetTokens = 2000, opts = {}) {
  const start = graph.getNode(slug, queryNodeId);
  if (!start) return { ok: false, error: 'query node not found: ' + queryNodeId };
  const maxDepth = opts.maxDepth || 2;
  const edgeTypes = Array.isArray(opts.edgeTypes) && opts.edgeTypes.length > 0
    ? opts.edgeTypes
    : DEFAULT_PACKET_EDGE_TYPES.slice();

  // Walk + score. Score = (avg edge strength along path) × node.utility_score.
  // Start node always max relevance.
  const walk = graph.walkGraph(slug, queryNodeId, {
    maxDepth,
    edgeTypes,
    direction: 'both',
  });

  // Build adjacency for shortest-distance edge-strength lookup.
  const edgeIndex = new Map(); // 'fromId→toId' → edge
  for (const e of walk.edges) {
    edgeIndex.set(e.from_id + '→' + e.to_id, e);
    edgeIndex.set(e.to_id + '→' + e.from_id, e);
  }

  // Score each visited node.
  const scored = walk.visited.map(v => {
    if (v.id === queryNodeId) {
      return { ...v, score: 1.0 };
    }
    // crude proxy: best incident edge strength × node utility
    const incident = walk.edges.filter(e => e.from_id === v.id || e.to_id === v.id);
    const bestStrength = incident.length
      ? Math.max(...incident.map(e => (e.strength || 0.5) * (e.utility_score || 0.5)))
      : 0.3;
    const depthDecay = Math.pow(0.7, v.depth);
    return { ...v, score: bestStrength * (v.node.utility_score || 0.5) * depthDecay };
  }).sort((a, b) => b.score - a.score);

  // Prefer W5.1 packContext; fall back to local.
  const w51 = _tryW51();
  let packed;
  if (w51) {
    try {
      const items = scored.map(s => ({
        text: `[${s.node.layer} · ${s.id}]\n${s.node.content || ''}`,
        score: s.score,
        meta: { id: s.id, layer: s.node.layer, depth: s.depth },
      }));
      const w51Out = await w51.packContext(items, { budgetTokens });
      if (w51Out && typeof w51Out.text === 'string') {
        packed = {
          packetText: w51Out.text,
          usedNodes: (w51Out.used || []).map(u => ({ id: u.meta && u.meta.id, layer: u.meta && u.meta.layer })),
          dropped: (w51Out.dropped || []).map(d => ({ id: d.meta && d.meta.id, reason: 'w51-budget' })),
          tokensUsed: w51Out.tokensUsed || 0,
        };
      }
    } catch (_) { packed = null; }
  }
  if (!packed) packed = _localPack(scored, budgetTokens);

  // Bump utility on used nodes — they "earned their keep".
  const now = Date.now();
  for (const u of packed.usedNodes) {
    if (!u.id) continue;
    const n = graph.getNode(slug, u.id);
    if (!n) continue;
    graph.updateNode(slug, u.id, {
      last_used: now,
      utility_score: Math.min(1, (n.utility_score || 0.5) + 0.02),
    });
  }

  return { ok: true, ...packed };
}

// =====================================================================
// Exports
// =====================================================================

module.exports = {
  buildContextPacket,
  DEFAULT_PACKET_EDGE_TYPES,
  _internals: {
    localPack: _localPack,
    approxTokens: _approxTokens,
  },
};
