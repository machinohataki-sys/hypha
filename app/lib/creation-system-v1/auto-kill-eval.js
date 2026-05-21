'use strict';

// HYPHA · W5.4 Creation System v1 — Kill Criteria Auto-Eval
//
// Per BLUEPRINT §11.7 + ROADMAP v1.4. Periodically (weekly cron OR Review
// Day trigger from W2.1 cadence-engine) walk the product's kill-criteria.json
// against currentMetrics and surface ANY criterion that would fire. The user
// decides whether to kill — this layer NEVER auto-kills (per W5.4 brief:
// "不自动 kill, 只告警").
//
// Boundary:
//   W3.1 creation-pool-ops.evaluateKillCriteria — does the actual numeric
//     comparison + writes kill-criteria.json + evaluation-log.jsonl. This
//     module wraps that with: (a) metric autoderivation from events.jsonl
//     when caller doesn't supply currentMetrics, (b) typed `kill:triggered`
//     event emission per fired criterion, (c) cooldown so we don't alert
//     twice for the same criterion within 24h.
//   W4.2 KPI Dashboard — reads currentMetrics shape from kpi:productPool;
//     we accept the same shape so an external caller can chain them.

const fs = require('fs');
const path = require('path');

let _opsMod = null;
function _getOps() {
  if (_opsMod !== null) return _opsMod;
  try { _opsMod = require('../creation-pool-ops'); }
  catch (_) { _opsMod = false; }
  return _opsMod;
}

let _poolMod = null;
function _getPool() {
  if (_poolMod !== null) return _poolMod;
  try { _poolMod = require('../creation-pool'); }
  catch (_) { _poolMod = false; }
  return _poolMod;
}

let _eventsMod = null;
function _getEvents() {
  if (_eventsMod !== null) return _eventsMod;
  try { _eventsMod = require('../events'); }
  catch (_) { _eventsMod = false; }
  return _eventsMod;
}

function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  return path.join(__dirname, '..', '..', '..', 'data');
}

const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// _deriveMetrics — when caller doesn't supply currentMetrics, infer a basic
// set from events.jsonl (lesson_complete count, transfer-fire ratio, spark
// acceptance rate). Real ops shape stays flexible — caller can override any
// field by passing currentMetrics explicitly.
// ---------------------------------------------------------------------------
function _deriveMetrics(slug, lookbackDays) {
  const fp = path.join(_vaultRoot(), slug, 'events.jsonl');
  const out = {
    lessons_completed_7d: 0,
    transfers_fired_7d: 0,
    sparks_accepted_7d: 0,
    sparks_rejected_7d: 0,
    days_inactive: 999,
  };
  if (!fs.existsSync(fp)) return out;
  const sinceMs = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
  let buf;
  try { buf = fs.readFileSync(fp, 'utf8'); }
  catch (_) { return out; }
  let lastActivityTs = 0;
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const ts = row.ts ? Date.parse(row.ts) : 0;
      if (ts && ts > lastActivityTs) lastActivityTs = ts;
      if (ts && ts < sinceMs) continue;
      if (row.type === 'lesson_complete' || row.op === 'lesson:complete') out.lessons_completed_7d++;
      if (row.op === 'transfer:fired' && row.fired === true) out.transfers_fired_7d++;
      if (row.type === 'product:spark:transitioned') {
        if (row.to === 'accepted' || row.to === 'implemented') out.sparks_accepted_7d++;
        if (row.to === 'rejected') out.sparks_rejected_7d++;
      }
    } catch (_) { /* skip */ }
  }
  if (lastActivityTs) {
    out.days_inactive = Math.floor((Date.now() - lastActivityTs) / (24 * 60 * 60 * 1000));
  }
  return out;
}

// ---------------------------------------------------------------------------
// _readKillCriteria — load kill-criteria.json so we can find the per-criterion
// alert cooldown timestamps (stored on each criterion as _last_alert_ts when
// we've already alerted).
// ---------------------------------------------------------------------------
function _readKillCriteria(slug) {
  const fp = path.join(_vaultRoot(), slug, 'product/kill-criteria.json');
  if (!fs.existsSync(fp)) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch (_) { return null; }
}

function _writeKillCriteria(slug, data) {
  const fp = path.join(_vaultRoot(), slug, 'product/kill-criteria.json');
  try { fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8'); return true; }
  catch (_) { return false; }
}

// ---------------------------------------------------------------------------
// evaluateKillCriteriaSchedule — main entry. Returns:
//   { ok, would_kill_now, triggered: [{id, description, current_value,
//     threshold, severity, alerted: bool}], suppressed: [...], skipped, ts }
// alerted=true means we fired a `kill:triggered` event row this run; false
// means the alert was suppressed by the 24h cooldown.
// ---------------------------------------------------------------------------
function evaluateKillCriteriaSchedule(slug, opts = {}) {
  if (!slug || typeof slug !== 'string') {
    return { ok: false, reason: 'bad_slug' };
  }
  const ops = _getOps();
  const pool = _getPool();
  if (!ops || !pool) {
    return { ok: false, reason: 'creation_pool_missing' };
  }
  if (typeof pool.isProductBound === 'function' && !pool.isProductBound(slug)) {
    return { ok: false, reason: 'not_bound' };
  }

  const lookback = Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : 7;
  const provided = opts.currentMetrics && typeof opts.currentMetrics === 'object'
    ? opts.currentMetrics : null;
  const derived = _deriveMetrics(slug, lookback);
  const currentMetrics = { ...derived, ...(provided || {}) };

  // Delegate to W3.1 ops for the actual comparison + persisted log.
  let result;
  try {
    result = ops.evaluateKillCriteria(slug, currentMetrics);
  } catch (err) {
    return { ok: false, reason: 'eval_threw', error: (err && err.message) || String(err) };
  }
  if (!result || result.ok === false) return result || { ok: false };

  // Re-read kill-criteria.json post-eval to walk the triggered IDs + decide
  // which need a fresh alert row (cooldown gate).
  const kc = _readKillCriteria(slug);
  if (!kc) {
    return { ok: true, ...result, triggered: [], suppressed: [], alerted_count: 0 };
  }
  const now = Date.now();
  const triggered = [];
  const suppressed = [];
  const events = _getEvents();
  let mutated = false;
  for (const c of kc.criteria || []) {
    if (!c.would_kill) continue;
    const last = c._last_alert_ts ? Date.parse(c._last_alert_ts) : 0;
    const elapsed = now - (last || 0);
    if (last && elapsed < ALERT_COOLDOWN_MS) {
      suppressed.push({ id: c.id, description: c.description, reason: 'cooldown', last_alert_ts: c._last_alert_ts });
      continue;
    }
    triggered.push({
      id: c.id,
      description: c.description,
      current_value: c.current_value,
      threshold: c.threshold,
      severity: c.severity || 'soft',
      alerted: true,
    });
    c._last_alert_ts = new Date().toISOString();
    mutated = true;
    if (events && typeof events.write === 'function') {
      try {
        events.write(slug, {
          type: 'kill:triggered',
          criterion_id: c.id,
          description: c.description,
          current_value: c.current_value,
          threshold: c.threshold,
          severity: c.severity || 'soft',
        });
      } catch (_) { /* best-effort */ }
    }
  }
  if (mutated) _writeKillCriteria(slug, kc);

  return {
    ok: true,
    slug,
    would_kill_now: result.would_kill_now,
    triggered,
    suppressed,
    alerted_count: triggered.length,
    ts: result.last_evaluated || new Date().toISOString(),
    metrics_used: currentMetrics,
    metrics_derived: derived,
  };
}

module.exports = {
  evaluateKillCriteriaSchedule,
  ALERT_COOLDOWN_MS,
  _internals: {
    deriveMetrics: _deriveMetrics,
    readKillCriteria: _readKillCriteria,
    writeKillCriteria: _writeKillCriteria,
    vaultRoot: _vaultRoot,
  },
};
