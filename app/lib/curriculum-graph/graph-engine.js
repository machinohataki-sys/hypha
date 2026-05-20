'use strict';

// HYPHA · W6.4 Curriculum Graph engine — BLUEPRINT §20 v1.8.
//
// Single-domain (AI/CS) seed curriculum DAG. Knowledge points (KPs) form nodes;
// `prereq_ids` form edges. The engine answers the four interesting questions a
// learner has at any moment:
//
//   1. "If I want X, what must I learn first?"  → findPath
//   2. "What can I learn next given what I know?" → recommendNextKP
//   3. "I want to do Y; what's relevant?"        → kpForGoal
//   4. "Where does this connect to 2026 frontier?" → getFrontierBridge
//
// Plus a curriculum generator that strings these together:
//   5. "Compose a lesson sequence for a goal"    → buildCustomCurriculum
//
// Pure functions over an in-memory graph cache. No vault writes. Mocks the
// W5.1 embed call (kpForGoal) — wired to real cheap-router once available.

const fs = require('fs');
const path = require('path');

const GRAPH_FILE = path.join(__dirname, 'ai-cs-graph.json');
let _cache = null;

/**
 * Load (and cache) the AI/CS curriculum graph.
 * Returns the parsed JSON: { domain, layers[], nodes[], assignment_types[], difficulty_legend }.
 * Throws if the seed file is malformed — graph integrity is a hard precondition.
 */
function loadGraph() {
  if (_cache) return _cache;
  const raw = fs.readFileSync(GRAPH_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.nodes)) {
    throw new Error('curriculum-graph: ai-cs-graph.json missing nodes[]');
  }
  // Build an id → node index for O(1) lookups.
  const byId = new Map();
  for (const n of parsed.nodes) {
    if (!n || !n.id) throw new Error('curriculum-graph: node missing id');
    if (byId.has(n.id)) throw new Error(`curriculum-graph: duplicate id ${n.id}`);
    byId.set(n.id, n);
  }
  // Validate every prereq id resolves.
  for (const n of parsed.nodes) {
    for (const pid of n.prereq_ids || []) {
      if (!byId.has(pid)) {
        throw new Error(`curriculum-graph: node ${n.id} has unknown prereq ${pid}`);
      }
    }
  }
  parsed._byId = byId;
  _cache = parsed;
  return _cache;
}

/** Get a node by id, or null. */
function getNode(kpId) {
  const g = loadGraph();
  return g._byId.get(kpId) || null;
}

/**
 * BFS along reverse prereq edges from `toKpId` until `fromKpId` is reachable.
 * Returns an ordered KP id list from fromKpId → toKpId, including both endpoints.
 * If `fromKpId` is null/undefined, returns the full prereq closure of `toKpId`
 * in topological order (roots first).
 * Returns null if no path exists.
 */
function findPath(fromKpId, toKpId) {
  const g = loadGraph();
  if (!g._byId.has(toKpId)) return null;
  if (fromKpId && !g._byId.has(fromKpId)) return null;

  // First collect the prereq closure of toKpId (forward walk from prereqs).
  const closure = new Set();
  const stack = [toKpId];
  while (stack.length) {
    const cur = stack.pop();
    if (closure.has(cur)) continue;
    closure.add(cur);
    const node = g._byId.get(cur);
    for (const pid of node.prereq_ids || []) stack.push(pid);
  }

  if (fromKpId && !closure.has(fromKpId)) return null;

  // Topological order on the closure (Kahn's algorithm).
  const indeg = new Map();
  for (const id of closure) {
    indeg.set(id, 0);
  }
  for (const id of closure) {
    const node = g._byId.get(id);
    for (const pid of node.prereq_ids || []) {
      if (closure.has(pid)) indeg.set(id, (indeg.get(id) || 0) + 1);
    }
  }
  const queue = [];
  for (const [id, deg] of indeg.entries()) if (deg === 0) queue.push(id);
  // Stable ordering: sort by layer order, then id.
  const layerOrder = new Map(g.layers.map((l, i) => [l.id, i]));
  const sortKey = (id) => {
    const n = g._byId.get(id);
    return `${String(layerOrder.get(n.layer) || 99).padStart(3, '0')}-${id}`;
  };
  queue.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

  const ordered = [];
  while (queue.length) {
    const cur = queue.shift();
    ordered.push(cur);
    for (const id of closure) {
      const node = g._byId.get(id);
      if ((node.prereq_ids || []).includes(cur)) {
        const newDeg = (indeg.get(id) || 0) - 1;
        indeg.set(id, newDeg);
        if (newDeg === 0) {
          // Insert maintaining sort.
          queue.push(id);
          queue.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
        }
      }
    }
  }

  if (!fromKpId) return ordered;
  // Trim leading nodes before fromKpId (path semantics).
  const startIdx = ordered.indexOf(fromKpId);
  if (startIdx < 0) return null;
  return ordered.slice(startIdx);
}

/**
 * Recommend the next KPs a learner can start.
 * Pure rule: all prereq_ids must be in `masteredKpIds`, and the KP itself
 * must not be mastered yet. Sorted by (lowest difficulty asc, layer order asc).
 * Returns up to `limit` candidates (default 5).
 */
function recommendNextKP(masteredKpIds, limit = 5) {
  const g = loadGraph();
  const mastered = new Set(masteredKpIds || []);
  const layerOrder = new Map(g.layers.map((l, i) => [l.id, i]));
  const candidates = [];
  for (const n of g.nodes) {
    if (mastered.has(n.id)) continue;
    const prereqsOk = (n.prereq_ids || []).every((p) => mastered.has(p));
    if (!prereqsOk) continue;
    candidates.push(n);
  }
  candidates.sort((a, b) => {
    const dd = (a.difficulty || 3) - (b.difficulty || 3);
    if (dd !== 0) return dd;
    return (layerOrder.get(a.layer) || 99) - (layerOrder.get(b.layer) || 99);
  });
  return candidates.slice(0, limit);
}

// Tiny deterministic mock embed — counts shared tokens between query and a
// node-descriptor blob. Real W5.1 cheap-router (cheap:run task='kp-match')
// will replace this. Keeping the call shape compatible: returns [{id, score}].
function _mockMatch(query, nodes) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿 ]+/g, ' ').trim();
  const qTokens = norm(query).split(/\s+/).filter((t) => t.length >= 2);
  if (qTokens.length === 0) return [];
  const scored = [];
  for (const n of nodes) {
    const blob = norm(`${n.name} ${n.canonical_example} ${(n.frontier_bridges || []).join(' ')} ${n.layer}`);
    let hits = 0;
    for (const t of qTokens) {
      if (blob.includes(t)) hits += 1;
    }
    if (hits > 0) {
      const score = hits / qTokens.length;
      scored.push({ id: n.id, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Match a free-text goal to top-K relevant KPs.
 * MVP: uses a deterministic token-overlap mock (above). Replace with the
 * W5.1 cheap-router `cheap:run` task `'kp-match'` once that task type ships.
 *
 * Returns up to `k` results: [{ node, score }].
 */
async function kpForGoal(goalText, k = 3) {
  const g = loadGraph();
  const scored = _mockMatch(goalText, g.nodes);
  return scored.slice(0, k).map(({ id, score }) => ({
    node: g._byId.get(id),
    score,
  }));
}

/**
 * Return frontier-bridge content for a KP — the 2026-relevant connection that
 * W6.3 Research Radar can link to actual papers. Returns null if the KP has
 * no recorded bridge.
 */
function getFrontierBridge(kpId) {
  const node = getNode(kpId);
  if (!node) return null;
  const bridges = Array.isArray(node.frontier_bridges) ? node.frontier_bridges : [];
  const reading = Array.isArray(node.frontier_recommended_reading)
    ? node.frontier_recommended_reading
    : [];
  if (bridges.length === 0 && reading.length === 0) return null;
  return {
    kpId,
    kpName: node.name,
    layer: node.layer,
    bridges,
    recommended_reading: reading,
  };
}

/**
 * Build a custom curriculum (ordered lesson plan) given a goal contract and a
 * target lesson count. Algorithm:
 *
 *   1. Resolve the goal text to top-3 target KPs via `kpForGoal`.
 *   2. For each target, compute its prereq closure in topological order.
 *   3. Merge into a single ordered KP list (de-duped, prereqs first).
 *   4. If shorter than targetTotalLessons, extend with `recommendNextKP`
 *      after the existing tail (frontier exposure).
 *   5. If longer, trim from the tail (most-advanced lessons first to be cut).
 *
 * Returns { ok, plan: { goalText, targetKpIds, kpIds, lessons } } where
 * `lessons` is an ordered array of { idx, kpId, title, learnGoal, layer,
 * difficulty, canonical_example, assignment_types, frontier_bridges }.
 */
async function buildCustomCurriculum(goalContract, targetTotalLessons = 16) {
  const g = loadGraph();
  const goalText =
    (goalContract && (goalContract.north_star_goal || goalContract.goal || goalContract.topic)) ||
    String(goalContract || '');

  const targets = await kpForGoal(goalText, 3);
  if (targets.length === 0) {
    return {
      ok: false,
      error: 'NO_KP_MATCH',
      message: `No AI/CS knowledge point matched goal: ${goalText}`,
    };
  }

  // Merge prereq closures topologically. Use the LAST target as the deepest
  // anchor: build full path to it, then ensure earlier targets' closures are
  // also covered.
  const seen = new Set();
  const merged = [];
  for (const { node } of targets) {
    const path = findPath(null, node.id) || [];
    for (const id of path) {
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
  }

  // Adjust to target length.
  let kpIds = merged.slice();
  if (kpIds.length < targetTotalLessons) {
    // Extend via recommendNextKP using the current set as "mastered"; pull
    // candidates one at a time until we hit target or run out.
    while (kpIds.length < targetTotalLessons) {
      const recs = recommendNextKP(kpIds, 1);
      if (recs.length === 0) break;
      kpIds.push(recs[0].id);
    }
  } else if (kpIds.length > targetTotalLessons) {
    kpIds = kpIds.slice(0, targetTotalLessons);
  }

  const lessons = kpIds.map((id, i) => {
    const n = g._byId.get(id);
    return {
      idx: i,
      kpId: id,
      title: n.name,
      learnGoal: `Master ${n.name}: ${n.canonical_example}`,
      layer: n.layer,
      difficulty: n.difficulty,
      canonical_example: n.canonical_example,
      assignment_types: n.assignment_types || [],
      frontier_bridges: n.frontier_bridges || [],
    };
  });

  return {
    ok: true,
    plan: {
      goalText,
      targetKpIds: targets.map((t) => t.node.id),
      kpIds,
      lessons,
    },
  };
}

// Test-only helper to reset cache (used by __tests__ when seed JSON is hot-swapped).
function _resetCache() { _cache = null; }

module.exports = {
  loadGraph,
  getNode,
  findPath,
  recommendNextKP,
  kpForGoal,
  getFrontierBridge,
  buildCustomCurriculum,
  _resetCache,
};
