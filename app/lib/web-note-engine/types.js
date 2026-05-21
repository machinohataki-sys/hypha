'use strict';

// HYPHA · W5.2 Web Note Engine — schema (BLUEPRINT.md §10.1, ROADMAP v1.2)
//
// Pure-data module. No fs, no LLM, no Electron. Other engine files import
// these constants + validators so the schema lives in one place.
//
// 6-layer spider-web entropy-reduction stack (blueprint quote):
//
//   Raw Note
//     → Atomic Card (原子卡, 单一论点)
//       → Concept Node (跨卡共享概念)
//         → Spark Node (灵感节点)
//           → Product Spark (绑定 Product 的 spark)
//             → Kernel Summary (从一组 nodes 蒸馏的核心)
//
// 13 typed edges carry directed semantic relation. Strength + utility decay
// gives Entropy Reduction Cycle a gradient to walk (degrade unused, promote
// high-utility, dedupe near-clones).
//
// LLM never sees the full graph — only Context Packets (see context-packet.js).
// Graph render in UI is opt-in (NotebookScreen toggle), not the workflow.

// =====================================================================
// Layer + edge enums (immutable; consumers compare ===)
// =====================================================================

const NODE_LAYERS = Object.freeze([
  'raw',
  'atomic',
  'concept',
  'spark',
  'product_spark',
  'kernel',
]);

const EDGE_TYPES = Object.freeze([
  'prerequisite',     // A 必须先于 B
  'explains',         // A 解释 B
  'example_of',       // A 是 B 的例子
  'contradicts',      // A 反对 B
  'extends',          // A 延伸 B
  'applies_to',       // A 应用到 B 的情境
  'analogizes',       // A 类比 B
  'compresses',       // A 是 B 的压缩
  'operationalizes',  // A 把 B 变可操作
  'sparks',           // A 触发 B 灵感
  'productizes',      // A 产品化 B
  'risks',            // A 是 B 的风险
  'decides',          // A 决策影响 B
]);

const EDGE_STATUSES = Object.freeze(['active', 'dormant', 'broken']);

// =====================================================================
// Schemas (descriptive; runtime validation enforces required keys)
// =====================================================================

const EDGE_SCHEMA = Object.freeze({
  from_id: 'string (required)',
  to_id: 'string (required)',
  type: 'one of EDGE_TYPES (required)',
  strength: 'number 0..1 (default 0.5)',
  utility_score: 'number 0..1 (default 0.5)',
  last_used: 'unix ms timestamp (default now)',
  token_cost: 'number ≥0 estimate (default 0)',
  status: 'one of EDGE_STATUSES (default active)',
  created_at: 'unix ms timestamp (default now)',
});

const NODE_SCHEMA = Object.freeze({
  id: 'string (required, unique within slug)',
  layer: 'one of NODE_LAYERS (required)',
  slug: 'string (curriculum slug, required)',
  content: 'string (body, required)',
  frontmatter: 'object (free-form, default {})',
  edges_from: 'string[] (edge ids where this node is from_id, default [])',
  edges_to: 'string[] (edge ids where this node is to_id, default [])',
  utility_score: 'number 0..1 (default 0.5)',
  last_used: 'unix ms timestamp (default now)',
  created_at: 'unix ms timestamp (default now)',
});

const KERNEL_SCHEMA = Object.freeze({
  id: 'string (required)',
  summary: 'string (the distilled kernel text, required)',
  source_node_ids: 'string[] (≥1 required)',
  created_at: 'unix ms timestamp (default now)',
  token_count: 'number ≥0 (estimated, default 0)',
  version: 'integer ≥1 (default 1; bumps on re-distill)',
});

// =====================================================================
// Helpers
// =====================================================================

function _isNum01(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
}

function _isNonEmptyStr(s) {
  return typeof s === 'string' && s.length > 0;
}

// =====================================================================
// Validators — return { ok:true, value } or { ok:false, error }
// All validators normalize (fill defaults) on success.
// =====================================================================

/**
 * @param {object} edge
 * @returns {{ ok:true, value:object } | { ok:false, error:string }}
 */
function validateEdge(edge) {
  if (!edge || typeof edge !== 'object') {
    return { ok: false, error: 'edge must be object' };
  }
  if (!_isNonEmptyStr(edge.from_id)) {
    return { ok: false, error: 'edge.from_id required (non-empty string)' };
  }
  if (!_isNonEmptyStr(edge.to_id)) {
    return { ok: false, error: 'edge.to_id required (non-empty string)' };
  }
  if (edge.from_id === edge.to_id) {
    return { ok: false, error: 'edge.from_id and edge.to_id cannot be the same node' };
  }
  if (!EDGE_TYPES.includes(edge.type)) {
    return { ok: false, error: 'edge.type must be one of EDGE_TYPES, got ' + JSON.stringify(edge.type) };
  }
  const strength = edge.strength == null ? 0.5 : edge.strength;
  if (!_isNum01(strength)) {
    return { ok: false, error: 'edge.strength must be number in [0,1]' };
  }
  const utility = edge.utility_score == null ? 0.5 : edge.utility_score;
  if (!_isNum01(utility)) {
    return { ok: false, error: 'edge.utility_score must be number in [0,1]' };
  }
  const now = Date.now();
  const lastUsed = edge.last_used == null ? now : edge.last_used;
  if (typeof lastUsed !== 'number' || !Number.isFinite(lastUsed)) {
    return { ok: false, error: 'edge.last_used must be unix ms number' };
  }
  const tokenCost = edge.token_cost == null ? 0 : edge.token_cost;
  if (typeof tokenCost !== 'number' || !Number.isFinite(tokenCost) || tokenCost < 0) {
    return { ok: false, error: 'edge.token_cost must be non-negative number' };
  }
  const status = edge.status == null ? 'active' : edge.status;
  if (!EDGE_STATUSES.includes(status)) {
    return { ok: false, error: 'edge.status must be one of ' + EDGE_STATUSES.join('|') };
  }
  const createdAt = edge.created_at == null ? now : edge.created_at;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    return { ok: false, error: 'edge.created_at must be unix ms number' };
  }
  return {
    ok: true,
    value: {
      from_id: edge.from_id,
      to_id: edge.to_id,
      type: edge.type,
      strength,
      utility_score: utility,
      last_used: lastUsed,
      token_cost: tokenCost,
      status,
      created_at: createdAt,
    },
  };
}

/**
 * @param {object} node
 * @returns {{ ok:true, value:object } | { ok:false, error:string }}
 */
function validateNode(node) {
  if (!node || typeof node !== 'object') {
    return { ok: false, error: 'node must be object' };
  }
  if (!_isNonEmptyStr(node.id)) {
    return { ok: false, error: 'node.id required (non-empty string)' };
  }
  if (!NODE_LAYERS.includes(node.layer)) {
    return { ok: false, error: 'node.layer must be one of NODE_LAYERS, got ' + JSON.stringify(node.layer) };
  }
  if (!_isNonEmptyStr(node.slug)) {
    return { ok: false, error: 'node.slug required (non-empty string)' };
  }
  if (typeof node.content !== 'string') {
    return { ok: false, error: 'node.content must be string (may be empty for raw layer placeholders)' };
  }
  const frontmatter = node.frontmatter == null ? {} : node.frontmatter;
  if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return { ok: false, error: 'node.frontmatter must be plain object' };
  }
  const edgesFrom = node.edges_from == null ? [] : node.edges_from;
  const edgesTo = node.edges_to == null ? [] : node.edges_to;
  if (!Array.isArray(edgesFrom) || !Array.isArray(edgesTo)) {
    return { ok: false, error: 'node.edges_from and edges_to must be arrays' };
  }
  const utility = node.utility_score == null ? 0.5 : node.utility_score;
  if (!_isNum01(utility)) {
    return { ok: false, error: 'node.utility_score must be number in [0,1]' };
  }
  const now = Date.now();
  const lastUsed = node.last_used == null ? now : node.last_used;
  const createdAt = node.created_at == null ? now : node.created_at;
  if (typeof lastUsed !== 'number' || !Number.isFinite(lastUsed)) {
    return { ok: false, error: 'node.last_used must be unix ms number' };
  }
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    return { ok: false, error: 'node.created_at must be unix ms number' };
  }
  return {
    ok: true,
    value: {
      id: node.id,
      layer: node.layer,
      slug: node.slug,
      content: node.content,
      frontmatter,
      edges_from: edgesFrom.slice(),
      edges_to: edgesTo.slice(),
      utility_score: utility,
      last_used: lastUsed,
      created_at: createdAt,
    },
  };
}

/**
 * @param {object} kernel
 * @returns {{ ok:true, value:object } | { ok:false, error:string }}
 */
function validateKernel(kernel) {
  if (!kernel || typeof kernel !== 'object') {
    return { ok: false, error: 'kernel must be object' };
  }
  if (!_isNonEmptyStr(kernel.id)) {
    return { ok: false, error: 'kernel.id required (non-empty string)' };
  }
  if (!_isNonEmptyStr(kernel.summary)) {
    return { ok: false, error: 'kernel.summary required (non-empty string)' };
  }
  if (!Array.isArray(kernel.source_node_ids) || kernel.source_node_ids.length === 0) {
    return { ok: false, error: 'kernel.source_node_ids must be non-empty array' };
  }
  for (const id of kernel.source_node_ids) {
    if (!_isNonEmptyStr(id)) {
      return { ok: false, error: 'kernel.source_node_ids entries must be non-empty strings' };
    }
  }
  const tokenCount = kernel.token_count == null ? 0 : kernel.token_count;
  if (typeof tokenCount !== 'number' || !Number.isFinite(tokenCount) || tokenCount < 0) {
    return { ok: false, error: 'kernel.token_count must be non-negative number' };
  }
  const version = kernel.version == null ? 1 : kernel.version;
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'kernel.version must be integer ≥ 1' };
  }
  const createdAt = kernel.created_at == null ? Date.now() : kernel.created_at;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    return { ok: false, error: 'kernel.created_at must be unix ms number' };
  }
  return {
    ok: true,
    value: {
      id: kernel.id,
      summary: kernel.summary,
      source_node_ids: kernel.source_node_ids.slice(),
      created_at: createdAt,
      token_count: tokenCount,
      version,
    },
  };
}

// =====================================================================
// Exports
// =====================================================================

module.exports = {
  NODE_LAYERS,
  EDGE_TYPES,
  EDGE_STATUSES,
  EDGE_SCHEMA,
  NODE_SCHEMA,
  KERNEL_SCHEMA,
  validateEdge,
  validateNode,
  validateKernel,
};
