'use strict';

// HYPHA · W8.2 Learning Commons Flywheel · Step 5 — Feedback Loop & Health
//
// Periodic orchestrator that runs the 4-step flywheel against a curriculum
// slug and reports a metric tuple + a 0-100 health score.
//
// This module is the FEEDBACK CHANNEL of the flywheel — it does not advance
// state on its own; it inspects + reports. Mutations belong to:
//   - W3.4 createSpark (via note-to-spark)
//   - W6.5 staging write (via pack-to-commons)
//   - User PR (out of band)
//
// Health formula (per spec):
//
//   health = 0.20 · norm(notes_eligible_count, 0..20)
//          + 0.20 · norm(sparks_proposed,      0..10)
//          + 0.20 · norm(packs_proposed,       0..5)
//          + 0.20 · norm(packs_published,      0..3)
//          + 0.20 · norm(commons_consumed,     0..5)
//
// where norm(x, cap) = min(1, x/cap) * 100. The five normalization caps
// are heuristic and reflect the cadence target (a healthy individual user
// produces ~5 packs/quarter, not 50).

let _noteToSpark = null;
try { _noteToSpark = require('./note-to-spark'); } catch (_) { _noteToSpark = null; }

let _sparkToPack = null;
try { _sparkToPack = require('./spark-to-pack'); } catch (_) { _sparkToPack = null; }

let _packToCommons = null;
try { _packToCommons = require('./pack-to-commons'); } catch (_) { _packToCommons = null; }

let _commonsToLesson = null;
try { _commonsToLesson = require('./commons-to-lesson'); } catch (_) { _commonsToLesson = null; }

// ---------------------------------------------------------------------------
// Health normalization caps
// ---------------------------------------------------------------------------

const HEALTH_CAPS = Object.freeze({
  notes_eligible: 20,
  sparks_proposed: 10,
  packs_proposed: 5,
  packs_published: 3,
  commons_consumed: 5,
});

function _norm(x, cap) {
  if (!cap || cap <= 0) return 0;
  return Math.max(0, Math.min(1, Number(x || 0) / cap)) * 100;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a full cycle of the 4-step flywheel and report metrics.
 * Does NOT mutate state — purely observational + dry-run proposals.
 *
 * @param {string} slug
 * @param {object} [opts] — { sampleLessonTopic?: string }
 * @returns {object} metric report
 */
function runFlywheelCycle(slug, opts = {}) {
  const report = {
    slug,
    timestamp: new Date().toISOString(),
    steps: {},
    metrics: {
      notes_eligible_count: 0,
      sparks_proposed: 0,
      packs_proposed: 0,
      packs_published: 0,
      commons_consumed_in_lesson: 0,
    },
    warnings: [],
  };

  // Step 1 — Note → Spark
  if (_noteToSpark && typeof _noteToSpark.batchNoteToSpark === 'function') {
    try {
      const batch = _noteToSpark.batchNoteToSpark(slug);
      report.steps.note_to_spark = {
        scanned: batch.scanned,
        eligible: batch.eligible.length,
        ineligible: batch.ineligible.length,
      };
      report.metrics.notes_eligible_count = batch.eligible.length;
      // sparks_proposed = eligible candidates we WOULD propose in a real run.
      report.metrics.sparks_proposed = batch.eligible.length;
    } catch (err) {
      report.warnings.push(`note_to_spark_failed:${err.message}`);
    }
  } else {
    report.warnings.push('note_to_spark_module_unavailable');
  }

  // Step 2 — Spark → Pack (we evaluate, do not commit)
  if (_sparkToPack && typeof _sparkToPack.evaluateSparkClusterForPack === 'function') {
    try {
      // Without a concrete sparkIds list (which would be a user choice), we
      // proxy a single evaluation pass and surface its eligibility. The full
      // batch-cluster algorithm belongs to W5.4 creation-system-v1.
      const evalRes = _sparkToPack.evaluateSparkClusterForPack(slug, []);
      report.steps.spark_to_pack = {
        eligible: evalRes.eligible,
        spark_count: evalRes.pack_skeleton && evalRes.pack_skeleton.spark_count || 0,
        reasons: evalRes.reasons,
      };
      report.metrics.packs_proposed = evalRes.eligible ? 1 : 0;
    } catch (err) {
      report.warnings.push(`spark_to_pack_failed:${err.message}`);
    }
  }

  // Step 3 — Pack → Commons (read-only count of staged packs)
  if (_packToCommons && typeof _packToCommons.listStagedPacks === 'function') {
    try {
      const staged = _packToCommons.listStagedPacks();
      report.steps.pack_to_commons = {
        staged_count: staged.length,
        blocked_count: staged.filter(s => s.blocked).length,
      };
      report.metrics.packs_published = staged.filter(s => !s.blocked).length;
    } catch (err) {
      report.warnings.push(`pack_to_commons_failed:${err.message}`);
    }
  }

  // Step 4 — Commons → Lesson (probe with a sample topic)
  if (_commonsToLesson && typeof _commonsToLesson.findRelevantCommonsForLesson === 'function') {
    try {
      const probe = _commonsToLesson.findRelevantCommonsForLesson(
        slug,
        opts.sampleLessonTopic || slug,
        { topK: 5 },
      );
      report.steps.commons_to_lesson = {
        relevant_count: (probe.packs || []).length,
        source: probe.source,
      };
      report.metrics.commons_consumed_in_lesson = (probe.packs || []).length;
    } catch (err) {
      report.warnings.push(`commons_to_lesson_failed:${err.message}`);
    }
  }

  return report;
}

/**
 * Compute a flywheel health score 0-100.
 *
 * @param {string} slug
 * @param {object} [opts]
 * @returns {{ ok: boolean, score: number, components: object, report: object }}
 */
function getFlywheelHealth(slug, opts = {}) {
  const report = runFlywheelCycle(slug, opts);
  const m = report.metrics;
  const components = {
    notes_eligible:    _norm(m.notes_eligible_count,        HEALTH_CAPS.notes_eligible),
    sparks_proposed:   _norm(m.sparks_proposed,             HEALTH_CAPS.sparks_proposed),
    packs_proposed:    _norm(m.packs_proposed,              HEALTH_CAPS.packs_proposed),
    packs_published:   _norm(m.packs_published,             HEALTH_CAPS.packs_published),
    commons_consumed:  _norm(m.commons_consumed_in_lesson,  HEALTH_CAPS.commons_consumed),
  };
  const score = Math.round(
    0.20 * components.notes_eligible +
    0.20 * components.sparks_proposed +
    0.20 * components.packs_proposed +
    0.20 * components.packs_published +
    0.20 * components.commons_consumed,
  );
  return { ok: true, score, components, report };
}

module.exports = {
  runFlywheelCycle,
  getFlywheelHealth,
  HEALTH_CAPS,
  _internals: { norm: _norm },
};
