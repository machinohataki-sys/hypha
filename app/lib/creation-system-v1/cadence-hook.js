'use strict';

// HYPHA · W5.4 Creation System v1 — W2.1 Cadence Engine Wrapper Hook
//
// Per W5.4 brief: "在 cadence-engine.shouldTriggerIntegrationDay 触发时, 也
// 调 W5.4 runCycle … 不直接改 W2.1, 用 wrapper". Same pattern as the W3.6
// Companion hook — we wrap the W2.1 surface instead of mutating it.
//
// Callers (main.js cadence:* IPC handlers, or any orchestrator that calls
// shouldTriggerIntegrationDay) replace:
//
//     const cad = require('./cadence-engine');
//     if (cad.shouldTriggerIntegrationDay(state)) { ... }
//
// with:
//
//     const cadHook = require('./creation-system-v1/cadence-hook');
//     const fired = await cadHook.checkIntegrationDayAndRunCycle(state, slug);
//     if (fired.integrationDay) { ... }
//
// The check is identical (cad.shouldTriggerIntegrationDay called underneath)
// — the wrapper only adds the side effect of firing W5.4 runCycle when the
// integration day fires. W2.1 stays untouched.

const cadence = require('../cadence-engine');
const v1 = require('./index');

let _eventsMod = null;
function _getEvents() {
  if (_eventsMod !== null) return _eventsMod;
  try { _eventsMod = require('../events'); }
  catch (_) { _eventsMod = false; }
  return _eventsMod;
}

// ---------------------------------------------------------------------------
// checkIntegrationDayAndRunCycle — pass-through wrapper. Returns
// { integrationDay: bool, cycleResult: ... } so the caller can branch on
// the cadence answer AND inspect the cycle's stages in one round-trip.
// ---------------------------------------------------------------------------
async function checkIntegrationDayAndRunCycle(cadenceState, slug, opts = {}) {
  const integrationDay = cadence.shouldTriggerIntegrationDay(cadenceState);
  if (!integrationDay) return { integrationDay: false, cycleResult: null };
  if (!slug) return { integrationDay: true, cycleResult: { ok: false, reason: 'no_slug' } };
  const events = _getEvents();
  if (events && typeof events.write === 'function') {
    try {
      events.write(slug, {
        type: 'creation_v1:cycle_fired_via_cadence',
        cadence_progress: cadenceState && cadenceState.milestoneProgress,
      });
    } catch (_) { /* best-effort */ }
  }
  const cycleResult = await v1.runCreationSystemV1Cycle(slug, {
    ...opts,
    trigger: 'cadence_integration_day',
  });
  return { integrationDay: true, cycleResult };
}

module.exports = {
  checkIntegrationDayAndRunCycle,
};
