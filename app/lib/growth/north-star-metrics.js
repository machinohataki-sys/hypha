'use strict';

// HYPHA · 阶 3 北极星 metric — 3-pillar aggregator (2026-05-17).
//
// 工业 lessons.length OUT. 北极星 = 三柱:
//   ratified          — concept-lifecycle.countByState.ratified
//   draft_on_deck     — draft + review 合计 (还能学的 frontier)
//   artifacts_shipped — artifact.list state ∈ {published, committed}
//   spark_matured     — product-spark.list state ∈ {implemented}
//                       (蓝图 §11.4 enum 用 'implemented' = 物理实现, 取代
//                       spec 里的 'matured'/'public' 占位; spark 路径已落地)
//
// 还附 recent_transitions — 最近 7 天 concept state changes, 倒序。
// 用于 Scene C 的 "刚 ratified" 卡片 + 北极星 trail。
//
// Public surface:
//   getNorthStar({ slug }) → { ok:true, metrics, recent_transitions }

const fs = require('node:fs');
const path = require('node:path');

const { resolveRoot } = require('../vault');
const conceptLifecycle = require('../lesson-system/concept-lifecycle');
const artifactCreation = require('./artifact-creation');

// product-spark is optional — older vaults may not have it. Lazy-load with
// graceful degrade so the metric block never crashes.
let _productSpark = null;
try {
  _productSpark = require('../product-spark');
} catch (_) {
  _productSpark = null;
}

const RECENT_TRANSITION_WINDOW_DAYS = 7;
const RECENT_TRANSITION_LIMIT = 30;

const ARTIFACT_SHIPPED_STATES = Object.freeze(['published', 'committed']);
// product-spark enum (per app/lib/product-spark.js):
//   seed / considered / accepted / rejected / implemented
// "implemented" = matured (physical realization). spec's 'matured'/'public'
// don't exist in code — 'implemented' is the actual terminal-success state.
const SPARK_MATURED_STATES = Object.freeze(['implemented']);

function _validateSlug(slug) {
  return typeof slug === 'string' && slug.trim().length > 0;
}

// Re-read concept-lifecycle jsonl to extract transition rows directly
// (countByState only gives latest state — for recent_transitions we want
// the actual changes within window).
function _readRecentTransitions(slug) {
  const root = resolveRoot();
  const abs = path.join(root, String(slug), '.concept-lifecycle.jsonl');
  if (!fs.existsSync(abs)) return [];
  let text = '';
  try { text = fs.readFileSync(abs, 'utf-8'); }
  catch (_) { return []; }
  if (!text) return [];

  // Need concept name lookup — rebuild conceptId → name from seed rows.
  const nameById = new Map();
  const txRows = [];
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let row;
    try { row = JSON.parse(ln); } catch (_) { continue; }
    if (!row || typeof row !== 'object') continue;
    if (typeof row.txId === 'string' && typeof row.conceptId === 'string'
        && typeof row.toState === 'string') {
      txRows.push(row);
      continue;
    }
    if (typeof row.conceptId === 'string' && typeof row.name === 'string') {
      nameById.set(row.conceptId, row.name);
    }
  }

  const cutoff = Date.now() - RECENT_TRANSITION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const recent = [];
  for (const tx of txRows) {
    const t = Date.parse(tx.ts);
    if (!Number.isFinite(t)) continue;
    if (t < cutoff) continue;
    recent.push({
      concept: nameById.get(tx.conceptId) || tx.conceptId,
      from: tx.fromState,
      to: tx.toState,
      ts: tx.ts,
    });
  }
  // newest first
  recent.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return recent.slice(0, RECENT_TRANSITION_LIMIT);
}

async function _countArtifactsShipped(slug) {
  try {
    const res = await artifactCreation.listArtifacts({ slug, limit: 1000 });
    if (!res.ok || !Array.isArray(res.artifacts)) return 0;
    let n = 0;
    for (const a of res.artifacts) {
      if (ARTIFACT_SHIPPED_STATES.includes(a.state)) n += 1;
    }
    return n;
  } catch (_) {
    return 0;
  }
}

function _countSparkMatured(slug) {
  if (!_productSpark || typeof _productSpark.listSparks !== 'function') return 0;
  try {
    const sparks = _productSpark.listSparks(slug, null);
    if (!Array.isArray(sparks)) return 0;
    let n = 0;
    for (const s of sparks) {
      if (s && SPARK_MATURED_STATES.includes(s.state)) n += 1;
    }
    return n;
  } catch (_) {
    return 0;
  }
}

/**
 * Compute the 3-pillar north-star metric block + 7-day transition trail.
 * @param {object} params
 * @param {string} params.slug
 * @returns {Promise<{ok:true, metrics, recent_transitions}|{ok:false, error}>}
 */
async function getNorthStar({ slug } = {}) {
  try {
    if (!_validateSlug(slug)) {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const countRes = await conceptLifecycle.countByState({ slug });
    const counts = (countRes.ok && countRes.counts)
      ? countRes.counts
      : { draft: 0, review: 0, ratified: 0, superseded: 0, deprecated: 0 };

    const ratified = counts.ratified || 0;
    const draft_on_deck = (counts.draft || 0) + (counts.review || 0);
    const artifacts_shipped = await _countArtifactsShipped(slug);
    const spark_matured = _countSparkMatured(slug);

    const recent_transitions = _readRecentTransitions(slug);

    return {
      ok: true,
      metrics: {
        ratified,
        draft_on_deck,
        artifacts_shipped,
        spark_matured,
      },
      recent_transitions,
    };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

module.exports = {
  getNorthStar,
  _internals: {
    ARTIFACT_SHIPPED_STATES,
    SPARK_MATURED_STATES,
    RECENT_TRANSITION_WINDOW_DAYS,
    RECENT_TRANSITION_LIMIT,
  },
};
