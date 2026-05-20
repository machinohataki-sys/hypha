'use strict';

// HYPHA · W7.4 Auto Product Spark — bridge from cross-spark result to W3.4.
//
// When generateCrossSpark() produces an action_or_artifact of kind
// 'prototype' or 'experiment' (i.e. a buildable surface), this module
// drops a `seed` row into W3.4 product-spark CRUD so the same artifact
// shows up in the Spark Pool UI (screen-spark-pool.jsx) without the user
// having to re-enter anything.
//
// Single-direction wiring rule (per task brief):
//   - We call into W3.4 (createSpark) — we never reach back into the
//     engine, and never mutate W3.4 internals beyond the public surface.
//   - We never auto-promote past 'seed'; the user owns transitions.
//   - W3.6 Companion already listens for the seed event from W3.4 IPC,
//     so the spark_sprout trigger lights up downstream of this call.
//
// Boundary partners:
//   - W7.4 engine.js          — produces the cross_spark + action
//   - W3.4 product-spark.js   — destination state machine
//   - W3.6 Companion          — observes spark:created via events.jsonl

const productSpark = require('../product-spark');

// Which cross-spark actions deserve a sprouted Product Spark?
// prototype + experiment = buildable. note = self-contained; not auto-sprouted.
const _AUTO_SPROUT_KINDS = Object.freeze(new Set(['prototype', 'experiment']));

// Build the W3.4 createSpark payload from a cross-spark result.
function _toSparkData(crossSparkResult, slug) {
  const action = crossSparkResult.action_or_artifact || {};
  const lensSummary = (crossSparkResult.other_domain_lenses || [])
    .map((l) => `${l.domain}: ${l.lens}`)
    .join(' / ');
  const toolName = crossSparkResult.thinking_tool
    ? `${crossSparkResult.thinking_tool.name_cn} (${crossSparkResult.thinking_tool.name_en})`
    : (crossSparkResult.thinking_tool_id || 'unknown-tool');

  const coreTransfer =
    `[cross-spark] 源域 ${crossSparkResult.source_domain} → ` +
    `工具 ${toolName} → 新 Spark.\n\n` +
    `${crossSparkResult.new_spark}\n\n` +
    `镜头: ${lensSummary}`;

  const possibleActions = [
    `[${action.kind || 'action'}] ${action.summary || '(no summary)'}`,
    ...((crossSparkResult.constraints || []).map((c) => `[constraint:${c.kind}] ${c.note}`)),
  ];

  return {
    source: {
      type: 'note',                                    // W3.4 SOURCE_TYPES whitelist: lesson|note|book|pack
      ref:  crossSparkResult.id || 'cross-spark',
      label: 'cross-spark',
    },
    related_product: slug || '',
    core_transfer: coreTransfer,
    affected_modules: [],
    possible_actions: possibleActions,
    risk: '此 Spark 由 cross-spark 自动种下, state=seed。下一步由用户决定 considered / rejected。',
    state: 'seed',
  };
}

// Public entry — autoCreateProductSpark.
// Returns:
//   { ok: true, sprouted: true, spark_id, path } when a spark was created
//   { ok: true, sprouted: false, reason } when the action kind did not qualify
//   { ok: false, error, code }             when W3.4 refused (validation / collision)
async function autoCreateProductSpark({ crossSparkResult, slug } = {}) {
  if (!crossSparkResult || typeof crossSparkResult !== 'object') {
    return { ok: false, error: 'crossSparkResult required', code: 'XSPARK_AUTO_INPUT_INVALID' };
  }
  if (!slug || typeof slug !== 'string') {
    return { ok: false, error: 'slug required (string)', code: 'XSPARK_AUTO_INPUT_INVALID' };
  }
  const action = crossSparkResult.action_or_artifact || {};
  const kind = action.kind || '';
  if (!_AUTO_SPROUT_KINDS.has(kind)) {
    return {
      ok: true,
      sprouted: false,
      reason: `action.kind='${kind}' not in auto-sprout set (${[..._AUTO_SPROUT_KINDS].join('|')})`,
    };
  }
  const data = _toSparkData(crossSparkResult, slug);
  try {
    const result = productSpark.createSpark(slug, data);
    return {
      ok: true,
      sprouted: true,
      spark_id: result.spark_id,
      state: result.state,
      path: result.path,
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      code: err && err.code ? err.code : 'XSPARK_AUTO_FAIL',
    };
  }
}

module.exports = {
  autoCreateProductSpark,
  AUTO_SPROUT_KINDS: _AUTO_SPROUT_KINDS,
  _internals: { toSparkData: _toSparkData },
};
