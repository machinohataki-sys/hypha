'use strict';

// HYPHA · W5.4 Creation System v1 — Orchestrator
//
// Per BLUEPRINT §11 + ROADMAP v1.4. Single entry point that runs the full
// W5.4 weekly automation cycle:
//   1. auto-transfer    — back-fill any lessons where P passed but no
//                         transfer was triggered (last 7 days)
//   2. roadmap-sync     — aggregate inspirations + sparks into 6-8
//                         recommendations, surface top-2
//   3. kill-eval        — score current metrics against criteria, alert
//                         (never auto-kill) when thresholds cross
//   4. spark-priority   — produce the "next spark to consider" hint
//
// Used by:
//   - W2.1 cadence-engine wrapper (cadence-engine-v1-hook.js) — fires on
//     Integration Day so the user gets a fresh roadmap when they hit a
//     0.25 / 0.5 / 0.75 milestone
//   - main.js IPC creation_v1:runCycle — manual trigger from Blueprint UI
//   - tests / smoke harness
//
// Returns a structured envelope so the caller never has to introspect
// individual modules. Errors in one stage do NOT block the others
// (best-effort orchestration is the documented contract — one weekly
// pipeline failing because spark-priority threw is worse than three
// partial results).

const autoTransfer = require('./auto-transfer');
const autoRoadmapSync = require('./auto-roadmap-sync');
const autoKillEval = require('./auto-kill-eval');
const sparkPriority = require('./spark-priority');

let _eventsMod = null;
function _getEvents() {
  if (_eventsMod !== null) return _eventsMod;
  try { _eventsMod = require('../events'); }
  catch (_) { _eventsMod = false; }
  return _eventsMod;
}

// ---------------------------------------------------------------------------
// _safeRun — execute one stage, capture errors instead of throwing. Each
// stage's failure is reported in the result envelope so the user sees the
// full picture even when one piece breaks.
// ---------------------------------------------------------------------------
async function _safeRun(label, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    return { stage: label, ok: !!(out && (out.ok !== false)), result: out, elapsed_ms: Date.now() - t0 };
  } catch (err) {
    return {
      stage: label,
      ok: false,
      result: null,
      error: (err && err.message) || String(err),
      elapsed_ms: Date.now() - t0,
    };
  }
}

// ---------------------------------------------------------------------------
// runCreationSystemV1Cycle — main entry. Each stage runs sequentially
// because they share the events.jsonl substrate (transfer audit writes
// rows that roadmap-sync reads, kill-eval reads transfer counts as a
// derived metric). Parallel would race the events file.
// ---------------------------------------------------------------------------
async function runCreationSystemV1Cycle(slug, opts = {}) {
  if (!slug || typeof slug !== 'string') {
    return { ok: false, reason: 'bad_slug' };
  }
  const trigger = (opts && opts.trigger) || 'manual';
  const lookbackDays = Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : 7;
  const t0 = Date.now();

  const stages = [];

  // 1. Back-fill any missed transfers.
  stages.push(await _safeRun('auto_transfer_audit', () =>
    autoTransfer.runDailyTransferAudit(slug, { lookbackDays })));

  // 2. Weekly roadmap sync — top-2 surfaced to user, full 6-8 to roadmap-sync.json.
  stages.push(await _safeRun('roadmap_sync', () =>
    autoRoadmapSync.weeklyRoadmapSync(slug, { days: lookbackDays })));

  // 3. Kill criteria evaluation — alerts only, no auto-kill.
  stages.push(await _safeRun('kill_eval', async () =>
    autoKillEval.evaluateKillCriteriaSchedule(slug, {
      lookbackDays,
      currentMetrics: opts.currentMetrics,
    })));

  // 4. Spark ranking + next-to-consider hint. Pure sync but wrapped through
  // _safeRun so the envelope shape stays uniform.
  stages.push(await _safeRun('spark_priority', () => {
    const ranked = sparkPriority.rankSparks(slug);
    const next = sparkPriority.getNextSparkToConsider(slug);
    return { ok: true, ranked, next };
  }));

  const ok = stages.every(s => s.ok);
  const events = _getEvents();
  if (events && typeof events.write === 'function') {
    try {
      events.write(slug, {
        type: 'creation_v1:cycle_run',
        trigger,
        stages: stages.map(s => ({ stage: s.stage, ok: s.ok })),
        elapsed_ms: Date.now() - t0,
      });
    } catch (_) { /* best-effort */ }
  }

  return {
    ok,
    slug,
    trigger,
    lookback_days: lookbackDays,
    stages,
    elapsed_ms: Date.now() - t0,
  };
}

module.exports = {
  runCreationSystemV1Cycle,
  // Module re-exports so callers can target an individual surface without
  // a second require. main.js IPC scaffolds use these.
  autoTransfer,
  autoRoadmapSync,
  autoKillEval,
  sparkPriority,
};
