'use strict';

// HYPHA · W5.2 Web Note Engine — Entropy Reduction Cycle (BLUEPRINT §10.1)
//
// Periodic sweep that fights graph entropy:
//   - dedupeNodes        : exact-text duplicates merged
//   - mergeRedundant     : near-duplicates merged (cosine-ish, deterministic)
//   - degradeUnused      : last_used > thresholdDays → status='dormant'
//   - promoteHighUtility : utility_score > 0.85 & active edges → bump
//   - detectConflicts    : 'contradicts' edges → mark for user review
//   - markDeadNodes      : 0 active edges + utility < 0.2 → emit 'dead_node_detected'
//
// Emits events through a tiny synchronous event bus (no Node EventEmitter
// to keep this module zero-deps). W5.3 Living Note Reactivation subscribes
// to 'dead_node_detected' once shipped; until then events accumulate in
// the returned report.

const graph = require('./graph');

// =====================================================================
// Tiny event bus (decoupled subscriber pattern)
// =====================================================================

const _subscribers = new Map(); // eventName → Set<handler>

function on(eventName, handler) {
  if (!_subscribers.has(eventName)) _subscribers.set(eventName, new Set());
  _subscribers.get(eventName).add(handler);
  return () => _subscribers.get(eventName).delete(handler);
}

function _emit(eventName, payload) {
  const set = _subscribers.get(eventName);
  if (!set) return;
  for (const h of set) {
    try { h(payload); } catch (_) { /* subscriber error: do not propagate */ }
  }
}

// =====================================================================
// Helpers
// =====================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

function _normalizeText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Jaccard on token sets — cheap proxy for "near-duplicate". Real W5.1 would
// use BGE-M3 cosine; this stays deterministic + offline.
function _jaccard(a, b) {
  const A = new Set(_normalizeText(a).split(' ').filter(Boolean));
  const B = new Set(_normalizeText(b).split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// =====================================================================
// Sub-functions
// =====================================================================

function dedupeNodes(slug) {
  const nodes = graph.listNodes(slug);
  const byText = new Map();
  const dupes = [];
  for (const n of nodes) {
    const key = n.layer + '::' + _normalizeText(n.content);
    if (byText.has(key)) {
      dupes.push({ keep: byText.get(key), drop: n.id });
    } else {
      byText.set(key, n.id);
    }
  }
  let merged = 0;
  for (const { keep, drop } of dupes) {
    const keepNode = graph.getNode(slug, keep);
    if (!keepNode) continue;
    const r = graph.mergeNodes(slug, [keep, drop], {
      id: keep,
      layer: keepNode.layer,
      slug,
      content: keepNode.content,
      frontmatter: Object.assign({}, keepNode.frontmatter, { deduped_from: drop, deduped_at: Date.now() }),
      utility_score: Math.min(1, keepNode.utility_score + 0.05),
    });
    if (r.ok) merged++;
  }
  return { merged, candidates: dupes.length };
}

function mergeRedundant(slug, threshold = 0.85) {
  // Pairwise jaccard within same layer.
  const nodes = graph.listNodes(slug);
  const byLayer = new Map();
  for (const n of nodes) {
    if (!byLayer.has(n.layer)) byLayer.set(n.layer, []);
    byLayer.get(n.layer).push(n);
  }
  let merged = 0;
  let pairs = 0;
  for (const [, group] of byLayer) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        // Skip if either was already merged this cycle.
        if (!graph.getNode(slug, a.id) || !graph.getNode(slug, b.id)) continue;
        const sim = _jaccard(a.content, b.content);
        if (sim < threshold) continue;
        pairs++;
        const winner = (a.utility_score >= b.utility_score) ? a : b;
        const loser = winner.id === a.id ? b : a;
        const r = graph.mergeNodes(slug, [winner.id, loser.id], {
          id: winner.id,
          layer: winner.layer,
          slug,
          content: winner.content,
          frontmatter: Object.assign({}, winner.frontmatter, {
            merged_with: loser.id,
            merge_similarity: sim,
            merged_at: Date.now(),
          }),
          utility_score: Math.min(1, winner.utility_score + 0.05),
        });
        if (r.ok) merged++;
      }
    }
  }
  return { merged, pairsChecked: pairs };
}

function degradeUnused(slug, thresholdDays = 30) {
  const cutoff = Date.now() - thresholdDays * DAY_MS;
  const edges = graph.listAllEdges(slug);
  let degraded = 0;
  for (const e of edges) {
    if (e.status !== 'active') continue;
    if (e.last_used > cutoff) continue;
    const r = graph.updateEdge(slug, e._id, { status: 'dormant' });
    if (r.ok) degraded++;
  }
  return { degraded };
}

function promoteHighUtility(slug, utilityCutoff = 0.85) {
  const nodes = graph.listNodes(slug);
  let promoted = 0;
  for (const n of nodes) {
    if (n.utility_score < utilityCutoff) continue;
    // Bump every active outgoing edge's strength a notch.
    const edges = graph.getEdges(slug, n.id, 'from', { status: 'active' });
    for (const e of edges) {
      const newStrength = Math.min(1, (e.strength || 0.5) + 0.05);
      const r = graph.updateEdge(slug, e._id, { strength: newStrength, last_used: Date.now() });
      if (r.ok) promoted++;
    }
  }
  return { promoted };
}

function detectConflicts(slug) {
  const edges = graph.listAllEdges(slug);
  const conflicts = edges
    .filter(e => e.type === 'contradicts' && e.status === 'active')
    .map(e => ({
      edgeId: e._id,
      from: e.from_id,
      to: e.to_id,
      strength: e.strength,
    }));
  for (const c of conflicts) {
    _emit('conflict_detected', { slug, ...c });
  }
  return { conflicts };
}

function markDeadNodes(slug, utilityFloor = 0.2) {
  const nodes = graph.listNodes(slug);
  const dead = [];
  for (const n of nodes) {
    if (n.utility_score > utilityFloor) continue;
    const active = graph.getEdges(slug, n.id, 'both', { status: 'active' });
    if (active.length === 0) {
      dead.push({ id: n.id, layer: n.layer, utility_score: n.utility_score });
      // Mark via frontmatter — actual deletion deferred to W5.3 reactivation
      // (it may resurrect the node by linking new edges).
      graph.updateNode(slug, n.id, {
        frontmatter: Object.assign({}, n.frontmatter, {
          dead_marked_at: Date.now(),
        }),
      });
      _emit('dead_node_detected', { slug, nodeId: n.id, layer: n.layer });
    }
  }
  return { dead };
}

// =====================================================================
// Orchestrator
// =====================================================================

/**
 * Run one full Entropy Reduction Cycle.
 * @param {string} slug
 * @param {object} opts
 * @returns {Promise<{ ok, report }>}
 */
async function runEntropyReductionCycle(slug, opts = {}) {
  const startedAt = Date.now();
  const report = {
    startedAt,
    slug,
    dedupe: null,
    mergeRedundant: null,
    degrade: null,
    promote: null,
    conflicts: null,
    dead: null,
    finishedAt: null,
    durationMs: 0,
  };
  try {
    report.dedupe = dedupeNodes(slug);
    report.mergeRedundant = mergeRedundant(slug, opts.redundantThreshold || 0.85);
    report.degrade = degradeUnused(slug, opts.thresholdDays || 30);
    report.promote = promoteHighUtility(slug, opts.utilityCutoff || 0.85);
    report.conflicts = detectConflicts(slug);
    report.dead = markDeadNodes(slug, opts.utilityFloor || 0.2);
    report.finishedAt = Date.now();
    report.durationMs = report.finishedAt - startedAt;
    return { ok: true, report };
  } catch (err) {
    report.finishedAt = Date.now();
    report.error = err.message || String(err);
    return { ok: false, error: report.error, report };
  }
}

// =====================================================================
// Exports
// =====================================================================

module.exports = {
  runEntropyReductionCycle,
  // Sub-functions exported for granular callers (UI / tests).
  dedupeNodes,
  mergeRedundant,
  degradeUnused,
  promoteHighUtility,
  detectConflicts,
  markDeadNodes,
  // Event bus
  on,
  _internals: {
    jaccard: _jaccard,
    normalizeText: _normalizeText,
    emit: _emit,
  },
};
