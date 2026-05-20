'use strict';

// HYPHA · W3.6 Companion State Expression Triggers — detection + dispatch.
//
// Per BLUEPRINT §16 (Myco Companion) + ROADMAP v0.8. This module is the
// *trigger* half of the Companion System; the *expression* half is W3.5
// (companion-respond IPC / tone-engine / boundary-guard). We never reach
// into W3.5 internals — we only call `companionRespond(triggerType, ctx)`
// once dedupe + detection clear.
//
// Five trigger types per spec:
//   1. lesson_complete       — quality-harness pass on exit_proof
//   2. interrupt_resume      — first lesson after ≥ INTERRUPT_DAYS_MIN gap
//   3. over_grind            — ≥ OVER_GRIND_COUNT lessons in 24h OR no rest
//   4. finish_capture        — Stage 4 of W1.5 Finish Ritual completed
//   5. product_spark_sprout  — W3.4 spark transition seed → considered
//
// Design rules:
//   - 5 `detect*` functions are PURE — input in, bool out, no I/O.
//   - All I/O (dedupe read, dispatch, events.jsonl write) lives in
//     `dispatchTrigger`. Detection can be unit-tested without filesystem.
//   - `dispatchTrigger` is record-first: we write the dedupe entry BEFORE
//     calling companion-respond so a crash mid-flight can't double-fire.
//   - W3.5 engine import is soft (lazy require + try/catch) so this module
//     compiles + loads even when W3.5 hasn't shipped yet. Companion
//     expression silently no-ops; detection + dedupe still record. This
//     mirrors how W2.4 repair pipelines are wired ahead of T4_JUDGE landing.

const fs = require('fs');
const path = require('path');
const history = require('./companion-history');

const VAULT_ROOT_DEFAULT = path.resolve(__dirname, '..', '..', 'vault');
function vaultRoot() {
  return process.env.HYPHA_VAULT_ROOT || VAULT_ROOT_DEFAULT;
}

// ============================================================
// CONFIG — detection thresholds.
// ============================================================

const INTERRUPT_DAYS_MIN = 3;           // ≥ 3 days idle → resume trigger
const OVER_GRIND_LESSONS_24H = 4;       // ≥ 4 lessons in 24h → over_grind
const OVER_GRIND_NO_REST_MIN = 4;       // OR ≥ 4 consecutive no-rest

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Allowed trigger names — mirrors companion-history.TRIGGER_TYPES.
const TRIGGER = Object.freeze({
  LESSON_COMPLETE:      'lesson_complete',
  INTERRUPT_RESUME:     'interrupt_resume',
  OVER_GRIND:           'over_grind',
  FINISH_CAPTURE:       'finish_capture',
  PRODUCT_SPARK_SPROUT: 'product_spark_sprout',
});

// ============================================================
// PURE DETECTION — 5 functions. No side effects.
// ============================================================

/**
 * Lesson exit_proof passed the Quality Harness. Caller passes the
 * harnessResult object returned by runHarness/gradeLesson; we check the
 * documented `overall_pass` boolean. No dedupe here — that's dispatch's job.
 *
 * @param {{ slug:string, lessonIdx:number|string, harnessResult:object }} args
 * @returns {boolean}
 */
function detectLessonComplete({ slug, lessonIdx, harnessResult } = {}) {
  if (!slug || lessonIdx == null || !harnessResult) return false;
  // runHarness returns either { overall_pass } per gradeLesson, OR a wider
  // shape with samples[] + pass_rate. Support both for forward-compat.
  if (typeof harnessResult.overall_pass === 'boolean') {
    return harnessResult.overall_pass === true;
  }
  if (typeof harnessResult.pass_rate === 'number') {
    return harnessResult.pass_rate >= 1;     // all samples passed
  }
  return false;
}

/**
 * The user's previous activity was ≥ INTERRUPT_DAYS_MIN days ago. We accept
 * `lastLessonAt` as ISO string or epoch ms; `currentTs` defaults to now.
 *
 * @param {{ slug:string, lastLessonAt:string|number|null, currentTs?:number|string }} args
 * @returns {boolean}
 */
function detectInterruptResume({ slug, lastLessonAt, currentTs } = {}) {
  if (!slug) return false;
  if (lastLessonAt == null) return false;     // no prior activity — not a resume
  const last = _toMs(lastLessonAt);
  const now = currentTs != null ? _toMs(currentTs) : Date.now();
  if (last == null || now == null) return false;
  const diffMs = now - last;
  return diffMs >= INTERRUPT_DAYS_MIN * MS_PER_DAY;
}

/**
 * Either (a) ≥ OVER_GRIND_LESSONS_24H lessons completed in the last 24h, OR
 * (b) consecutive_no_rest_count ≥ OVER_GRIND_NO_REST_MIN per cadence-state.
 *
 * @param {{ slug:string, currentSlugStats:object }} args
 *   currentSlugStats = {
 *     lessonsLast24h?: number,
 *     consecutiveNoRest?: number,
 *     lessonsSinceLastRest?: number,    // alias from cadence-state
 *   }
 * @returns {boolean}
 */
function detectOverGrind({ slug, currentSlugStats } = {}) {
  if (!slug || !currentSlugStats || typeof currentSlugStats !== 'object') return false;
  const last24h = _num(currentSlugStats.lessonsLast24h, 0);
  if (last24h >= OVER_GRIND_LESSONS_24H) return true;
  const consec = _num(
    currentSlugStats.consecutiveNoRest != null
      ? currentSlugStats.consecutiveNoRest
      : currentSlugStats.lessonsSinceLastRest,
    0
  );
  return consec >= OVER_GRIND_NO_REST_MIN;
}

/**
 * Finish Ritual reached Stage 4 'completed'. We accept either the literal
 * string 'completed' or the W1.5 runFinishRitual `{ stage: 'done', ok: true }`
 * envelope.
 *
 * @param {{ sessionId:string, ritualStage:string }} args
 * @returns {boolean}
 */
function detectFinishCapture({ sessionId, ritualStage } = {}) {
  if (!sessionId) return false;
  if (!ritualStage) return false;
  return ritualStage === 'completed' || ritualStage === 'done';
}

/**
 * Product Spark transitioned from 'seed' to 'considered'. W3.4 contract.
 *
 * @param {{ slug:string, sparkId:string, transitionFrom:string, transitionTo:string }} args
 * @returns {boolean}
 */
function detectSparkSprout({ slug, sparkId, transitionFrom, transitionTo } = {}) {
  if (!slug || !sparkId) return false;
  return transitionFrom === 'seed' && transitionTo === 'considered';
}

// ============================================================
// W2.1 cadence-engine companion wrapper.
// ============================================================
//
// cadence-engine's computeCadence + shouldRest are pure (no side effects).
// We don't touch that contract. Instead this wrapper composes their output
// with detectOverGrind + dispatchTrigger so callers can flip on companion
// expression without W2.1 absorbing a side-effecting dependency.
//
// Returns the original cadence decision unchanged so existing callers see
// no behavior change unless they read the new `companion` field.

function computeCadenceWithCompanion(input, opts = {}) {
  // Lazy require — W2.1 lives at a known path. We want this wrapper to fail
  // loudly if cadence-engine isn't present (vs a soft no-op).
  const cadence = require('./cadence-engine');
  const decision = cadence.computeCadence(input);

  const slug = opts.slug || (input && input.slug);
  const stats = opts.currentSlugStats || {
    lessonsLast24h: input && input.lessonsLast24h,
    lessonsSinceLastRest: input && input.lessonsSinceLastRest,
    consecutiveNoRest: input && input.consecutiveNoRest,
  };

  let fired = null;
  if (slug && detectOverGrind({ slug, currentSlugStats: stats })) {
    // Day-keyed dedupe so an over-grind state only fires once per day even
    // if computeCadence is called many times.
    const key = _today();
    if (!history.wasFired(slug, TRIGGER.OVER_GRIND, key)) {
      fired = dispatchTrigger(TRIGGER.OVER_GRIND, {
        slug,
        key,
        cadence_mode: decision.cadence_mode,
        rest_required: decision.rest_required,
        stats,
      });
    }
  }
  return { ...decision, companion: { trigger_fired: fired } };
}

// ============================================================
// DISPATCH — record + (soft) expression + events.jsonl side-band.
// ============================================================

/**
 * Fire a companion trigger. Record-first (history before W3.5 call) so we
 * never double-fire on retry. Returns:
 *   { triggerType, key, ts, fired: bool, expression?: object, error?: string }
 *
 * @param {string} triggerType  — one of TRIGGER.*
 * @param {object} context      — must include `slug` + `key`
 * @returns {Promise<object>}
 */
async function dispatchTrigger(triggerType, context = {}) {
  const slug = context && context.slug;
  const key = context && context.key;
  if (!slug || key == null) {
    return { triggerType, fired: false, error: 'slug + key required' };
  }
  // Dedupe — bail if this (type,key) already fired.
  if (history.wasFired(slug, triggerType, key)) {
    return { triggerType, key, fired: false, error: 'already fired' };
  }
  // Record FIRST. _writeSafe is non-throwing.
  const entry = history.recordFired(slug, triggerType, key, _trimMeta(context));

  // Try W3.5 expression engine. Soft import so this module loads even when
  // companion engine hasn't shipped. Intentional contract: companion-respond
  // returns { ok, text, tone, ... } per W3.5 spec.
  let expression = null;
  let exprError = null;
  try {
    // intentional-placeholder: W3.5 companion engine lives at
    // app/lib/companion/index.js per shipped scaffold. Path is wrapped in
    // try/catch so a missing W3.5 doesn't break trigger detection.
    let engine = null;
    try { engine = require('./companion'); } catch (_) { engine = null; }
    if (engine && typeof engine.companionRespond === 'function') {
      expression = await engine.companionRespond(triggerType, context);
    }
  } catch (err) {
    exprError = err && err.message;
  }

  // Side-band telemetry — write to vault/<slug>/events.jsonl when present.
  // Best-effort; never throws.
  _appendEvent(slug, {
    kind: 'companion_trigger_fired',
    trigger: triggerType,
    key: entry && entry.key,
    ts: entry && entry.ts,
    expression_ok: !!(expression && (expression.ok || expression.text)),
    expression_error: exprError || null,
  });

  return {
    triggerType,
    key: entry && entry.key,
    ts: entry && entry.ts,
    fired: true,
    expression,
    error: exprError,
  };
}

// ============================================================
// HELPERS
// ============================================================

function _toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
}

function _num(v, fb) {
  if (v === null || v === undefined || v === '') return fb;
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function _today(ts) {
  const d = ts ? new Date(ts) : new Date();
  // YYYY-MM-DD (UTC) — same day key regardless of caller TZ.
  return d.toISOString().slice(0, 10);
}

function _trimMeta(ctx) {
  // Keep meta small — the dedupe ledger is in vault; we don't want it
  // ballooning with stray lesson bodies.
  if (!ctx || typeof ctx !== 'object') return undefined;
  const out = {};
  for (const k of ['lessonIdx', 'sessionId', 'sparkId', 'transitionFrom',
                   'transitionTo', 'cadence_mode', 'rest_required']) {
    if (ctx[k] !== undefined) out[k] = ctx[k];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function _appendEvent(slug, row) {
  try {
    const p = path.join(vaultRoot(), slug, 'events.jsonl');
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n';
    fs.appendFileSync(p, line, 'utf8');
  } catch (_) { /* non-fatal */ }
}

// ============================================================
// Convenience: detect-then-dispatch one-liners.
// Call sites in main.js / runHarness / finish-ritual / product-spark
// use these so trigger wiring stays a single function call per site.
// ============================================================

async function tryLessonComplete({ slug, lessonIdx, harnessResult }) {
  if (!detectLessonComplete({ slug, lessonIdx, harnessResult })) return null;
  return dispatchTrigger(TRIGGER.LESSON_COMPLETE, {
    slug,
    key: String(lessonIdx),
    lessonIdx,
    harness_pass: true,
  });
}

async function tryInterruptResume({ slug, lastLessonAt, currentTs }) {
  if (!detectInterruptResume({ slug, lastLessonAt, currentTs })) return null;
  return dispatchTrigger(TRIGGER.INTERRUPT_RESUME, {
    slug,
    key: _today(currentTs),
    lastLessonAt,
  });
}

async function tryFinishCapture({ slug, sessionId, ritualStage }) {
  if (!detectFinishCapture({ sessionId, ritualStage })) return null;
  return dispatchTrigger(TRIGGER.FINISH_CAPTURE, {
    slug: slug || '_captures',     // capture path may not have a curriculum yet
    key: sessionId,
    sessionId,
  });
}

async function trySparkSprout({ slug, sparkId, transitionFrom, transitionTo }) {
  if (!detectSparkSprout({ slug, sparkId, transitionFrom, transitionTo })) return null;
  return dispatchTrigger(TRIGGER.PRODUCT_SPARK_SPROUT, {
    slug,
    key: sparkId,
    sparkId,
    transitionFrom,
    transitionTo,
  });
}

module.exports = {
  // Pure detection
  detectLessonComplete,
  detectInterruptResume,
  detectOverGrind,
  detectFinishCapture,
  detectSparkSprout,
  // Dispatch + side effects
  dispatchTrigger,
  // Cadence wrapper (W2.1 companion overlay)
  computeCadenceWithCompanion,
  // Convenience helpers
  tryLessonComplete,
  tryInterruptResume,
  tryFinishCapture,
  trySparkSprout,
  // Constants
  TRIGGER,
  INTERRUPT_DAYS_MIN,
  OVER_GRIND_LESSONS_24H,
  OVER_GRIND_NO_REST_MIN,
};
