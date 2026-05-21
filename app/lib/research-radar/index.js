'use strict';

// HYPHA · W6.3 Research Radar — orchestrator entry (BLUEPRINT §15, ROADMAP v1.7)
//
// Cron-friendly facade. W6.2 Cron Engine calls `runDailyRadar()`; the
// renderer + IPC layer calls the granular surface (subscribe / run /
// listReports / lessonCitationHook). All three downstream auto-actions
// (storeAsNote / lessonCitationHook / triggerProductSparkCandidate)
// re-export at the top level for IPC convenience.

const fs = require('fs');
const path = require('path');

const radar = require('./radar');
const frontierReport = require('./frontier-report');
const autoActions = require('./auto-actions');

// =====================================================================
// Vault scan — find every slug with a subscriptions.json file
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

function _enumerateSlugsWithSubscriptions() {
  const root = _vaultRoot();
  if (!fs.existsSync(root)) return [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (_) { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    const subs = path.join(root, ent.name, 'research-radar', 'subscriptions.json');
    if (fs.existsSync(subs)) out.push(ent.name);
  }
  return out;
}

// =====================================================================
// runDailyRadar — cron entry point
// =====================================================================

/**
 * Run a radar cycle for every slug with an active subscription. Filters
 * by frequency: daily subs always run, weekly subs run only if last_run
 * is older than 6 days (so a slightly drifting cron still catches them).
 *
 * Side effects per slug (after each report is generated):
 *   - storeAsNote: report → webnote raw node (idempotent on same-day)
 *   - product_spark_candidates: NOT auto-triggered — user explicitly
 *     promotes from the radar dashboard (per blueprint: HYPHA does not
 *     push, it compiles into existing surfaces).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.autoStoreNotes=true] - mirror reports to webnote raw layer
 * @returns {Promise<{ ok:true, runs: Array<{slug, topic, ok, error?}> }>}
 */
async function runDailyRadar(opts = {}) {
  const autoStoreNotes = opts.autoStoreNotes !== false;
  const slugs = _enumerateSlugsWithSubscriptions();
  const runs = [];
  const now = Date.now();
  const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

  for (const slug of slugs) {
    const subs = radar.listSubscriptions(slug);
    for (const sub of subs) {
      // Weekly filter — skip if last_run < 6 days ago.
      if (sub.frequency === 'weekly' && sub.last_run) {
        const lastTs = Date.parse(sub.last_run);
        if (Number.isFinite(lastTs) && (now - lastTs) < SIX_DAYS_MS) {
          runs.push({ slug, topic: sub.topic, ok: true, skipped: 'weekly_not_due' });
          continue;
        }
      }
      try {
        const result = await radar.runRadarCycle(slug, sub.topic);
        if (!result.ok) {
          runs.push({ slug, topic: sub.topic, ok: false, error: result.error });
          continue;
        }
        // Store each newly-generated report into webnote raw layer.
        if (autoStoreNotes && Array.isArray(result.reports)) {
          for (const r of result.reports) {
            try { autoActions.storeAsNote(slug, r.report); }
            catch (_) { /* graceful: report file is canonical, webnote mirror is convenience */ }
          }
        }
        runs.push({ slug, topic: sub.topic, ok: true, reports: result.reports.length });
      } catch (err) {
        runs.push({ slug, topic: sub.topic, ok: false, error: err && err.message });
      }
    }
  }
  return { ok: true, runs };
}

// =====================================================================
// Re-exports — the full W6.3 surface area in one require
// =====================================================================

module.exports = {
  // Subscriptions
  subscribeTopic:    radar.subscribeTopic,
  unsubscribeTopic:  radar.unsubscribeTopic,
  listSubscriptions: radar.listSubscriptions,
  // Cycle
  runRadarCycle:     radar.runRadarCycle,
  runDailyRadar,
  // Reports
  getLatestReport:   radar.getLatestReport,
  listReports:       radar.listReports,
  listAllReports:    radar.listAllReports,
  // Synthesis + render
  generateReport:    frontierReport.generateReport,
  formatReportMarkdown: frontierReport.formatReportMarkdown,
  validateReport:    frontierReport.validateReport,
  // Auto-actions
  storeAsNote:                    autoActions.storeAsNote,
  lessonCitationHook:             autoActions.lessonCitationHook,
  triggerProductSparkCandidate:   autoActions.triggerProductSparkCandidate,
  // Constants
  VALID_SOURCES:     radar.VALID_SOURCES,
  VALID_FREQUENCIES: radar.VALID_FREQUENCIES,
  RFR_SCHEMA:        frontierReport.RFR_SCHEMA,
  // Raw modules (for tests / advanced callers)
  radar,
  frontierReport,
  autoActions,
};
