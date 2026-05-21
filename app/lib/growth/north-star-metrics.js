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

// Week-over-week degradation threshold. Drop > 10% on any pillar fires an
// alert card; user can dismiss but pillar names + magnitude are recorded.
const ALERT_DEGRADATION_THRESHOLD = 0.10;
const ALERT_FILE_RELATIVE = path.join('.hypha', 'growth-alerts.jsonl');
const PILLAR_KEYS = Object.freeze(['ratified', 'draft_on_deck', 'artifacts_shipped', 'spark_matured']);

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

function _pctDrop(prev, curr) {
  if (typeof prev !== 'number' || typeof curr !== 'number') return 0;
  if (prev <= 0) return 0;
  return (prev - curr) / prev;
}

/**
 * Compare a previous metrics snapshot to the current and surface alert if any
 * pillar dropped by more than ALERT_DEGRADATION_THRESHOLD. Writes alert row to
 * `.hypha/growth-alerts.jsonl` under the vault root (cross-slug, since North
 * Star is a vault-level concept). Caller supplies `previousMetrics` so the
 * comparison cadence (daily / weekly) lives in the scheduling layer, not here.
 *
 * @param {object} params
 * @param {string} params.slug — required for current snapshot
 * @param {{ratified, draft_on_deck, artifacts_shipped, spark_matured}} params.previousMetrics
 * @param {number} [params.threshold=ALERT_DEGRADATION_THRESHOLD]
 * @returns {Promise<{ok:true, alert:object|null, current:object}|{ok:false, error}>}
 */
async function checkNorthStarAlert({
  slug,
  previousMetrics,
  threshold = ALERT_DEGRADATION_THRESHOLD,
} = {}) {
  try {
    if (!_validateSlug(slug)) {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    if (!previousMetrics || typeof previousMetrics !== 'object') {
      return { ok: false, error: 'MISSING_PREVIOUS' };
    }
    const nsRes = await getNorthStar({ slug });
    if (!nsRes.ok) return { ok: false, error: nsRes.error || 'EXCEPTION' };
    const current = nsRes.metrics;
    const t = (typeof threshold === 'number' && threshold > 0 && threshold < 1)
      ? threshold
      : ALERT_DEGRADATION_THRESHOLD;

    const degraded = [];
    for (const key of PILLAR_KEYS) {
      const prev = previousMetrics[key];
      const curr = current[key];
      const drop = _pctDrop(prev, curr);
      if (drop > t) {
        degraded.push({
          pillar: key,
          previous: prev,
          current: curr,
          drop: Number(drop.toFixed(3)),
        });
      }
    }

    if (degraded.length === 0) {
      return { ok: true, alert: null, current };
    }

    const alert = {
      ts: new Date().toISOString(),
      slug,
      threshold: t,
      degraded,
      previous: previousMetrics,
      current,
    };

    try {
      const root = resolveRoot();
      const abs = path.join(root, ALERT_FILE_RELATIVE);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, JSON.stringify(alert) + '\n', 'utf-8');
    } catch (err) {
      // Persisting the alert is best-effort — surface the alert object even
      // if disk write fails so the UI can still render the card.
      console.warn('[north-star] append alert failed:', err && err.message);
    }

    return { ok: true, alert, current };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function listNorthStarAlerts({ limit = 50 } = {}) {
  try {
    const root = resolveRoot();
    const abs = path.join(root, ALERT_FILE_RELATIVE);
    if (!fs.existsSync(abs)) return { ok: true, alerts: [] };
    let text = '';
    try { text = fs.readFileSync(abs, 'utf-8'); }
    catch (_) { return { ok: true, alerts: [] }; }
    if (!text) return { ok: true, alerts: [] };
    const rows = [];
    for (const ln of text.split(/\r?\n/)) {
      if (!ln.trim()) continue;
      try { rows.push(JSON.parse(ln)); } catch (_) { /* skip */ }
    }
    rows.reverse();
    const cap = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : 50;
    return { ok: true, alerts: rows.slice(0, cap) };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

module.exports = {
  getNorthStar,
  checkNorthStarAlert,
  listNorthStarAlerts,
  _internals: {
    ARTIFACT_SHIPPED_STATES,
    SPARK_MATURED_STATES,
    RECENT_TRANSITION_WINDOW_DAYS,
    RECENT_TRANSITION_LIMIT,
    ALERT_DEGRADATION_THRESHOLD,
    ALERT_FILE_RELATIVE,
    PILLAR_KEYS,
    pctDrop: _pctDrop,
  },
};
