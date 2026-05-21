'use strict';
// HYPHA · W3.5 Companion Layer — public entry.
//
// One-call API for main.js IPC handlers + renderer-side imports. Wires the
// generate → validate → boundary-enforce → log pipeline so callers see a
// single function: companionRespond(triggerType, context) → string | null.
//
// Event log: every emission decision writes one row to vault/events.jsonl
// with shape:
//   {
//     ts:        ISO8601,
//     op:        'companion:expressed',
//     trigger:   <triggerType>,
//     allowed:   bool,
//     reason?:   <boundary reason if denied>,
//     length?:   <emitted char count if allowed>,
//     censored?: bool        // true → boundary truncated/trimmed
//   }
// This honors the events.jsonl convention (see app/main.js _hyphaAppendEvent).
// Companion never writes lesson-shaped payloads — only its own ops.

const { generateValid, loadContract, validateExpression, SUPPORTED_TRIGGERS } = require('./tone-engine');
const { enforceBoundary, getKeywordMapping } = require('./boundary-guard');
const { KEYWORD_MAPPING } = require('./keyword-mapping');
const personaCoherence = require('./persona-coherence');
const coherenceLog = require('./coherence-log');
const { MOCK_TAG_KEY, MOCK_TAG_VALUE } = require('../v0-mock-marker');

/**
 * Run a single Companion response cycle.
 *
 * Envelope shape matches the W3.6 trigger dispatcher's expectations
 * (companion-triggers.js:230). `ok=true && text=<string>` → caller emits;
 * `ok=true && text=null` → boundary-silenced, never display; `ok=false`
 * → engine error.
 *
 * @param {string} triggerType
 * @param {object} [context]
 * @param {object} [opts]
 * @param {(row: object) => void} [opts.appendEvent] — vault.appendJSONL or stub
 * @returns {Promise<{ ok: boolean, text: string|null, trigger: string, tone?: string, reason?: string, error?: string, truncated?: boolean }>}
 */
async function companionRespond(triggerType, context = {}, opts = {}) {
  const append = typeof opts.appendEvent === 'function' ? opts.appendEvent : null;

  // v0 mock marker — the text path below today resolves to deterministic
  // MOCK_TEMPLATES picks via generateValid → generateExpression. Tag the
  // envelope so renderer surfaces (CompanionPresence toast) can render a
  // "v0 模板输出" banner until T2_LOCAL Gemma 3 4B local model wires in v0.8.
  let envelope = {
    ok: true,
    text: null,
    trigger: triggerType,
    tone: 'alien-quiet',
    [MOCK_TAG_KEY]: MOCK_TAG_VALUE,
    _mock_reason: 'companion tone-engine 当前用 deterministic templates, Gemma 3 4B 本地 LLM 待 v0.8',
  };
  let truncated = false;

  try {
    const expression = await generateValid(triggerType, context);
    if (!expression) {
      envelope.reason = 'regen_failed_validation';
    } else {
      const verdict = enforceBoundary(expression, context);
      if (!verdict.allowed) {
        envelope.reason = verdict.reason || 'denied';
      } else {
        envelope.text = verdict.censored;
        truncated = (verdict.censored && verdict.censored.length < expression.length) || false;
        if (truncated) envelope.truncated = true;
      }
    }
  } catch (err) {
    envelope = {
      ok: false,
      text: null,
      trigger: triggerType,
      error: (err && err.message) ? String(err.message) : 'engine_error',
      [MOCK_TAG_KEY]: MOCK_TAG_VALUE,
      _mock_reason: 'companion tone-engine 当前用 deterministic templates, Gemma 3 4B 本地 LLM 待 v0.8',
    };
  }

  if (append) {
    const row = {
      ts: new Date().toISOString(),
      op: 'companion:expressed',
      trigger: triggerType,
      allowed: !!envelope.text,
    };
    if (envelope.reason) row.reason = envelope.reason;
    if (envelope.error) row.error = envelope.error;
    if (envelope.text) {
      row.length = envelope.text.length;
      row.censored = truncated;
    }
    try { append(row); } catch (_) { /* event-log write is non-fatal */ }
  }

  return envelope;
}

/**
 * String-only convenience for callers (e.g. the renderer) that just want
 * the final displayable text. Wraps companionRespond and unwraps the
 * envelope. Use companionRespond directly when you need reason codes
 * (telemetry, debug panel).
 *
 * @returns {Promise<string|null>}
 */
async function companionRespondText(triggerType, context = {}, opts = {}) {
  const env = await companionRespond(triggerType, context, opts);
  return env && env.ok && env.text ? env.text : null;
}

/**
 * Whether the Companion layer is enabled for this user. Reads settings
 * object (already-loaded by caller, e.g. vault.readJSON('settings.json')).
 * Defaults to ENABLED (per ROADMAP.md v0.8 default behavior).
 */
function isEnabled(settings) {
  // W8.3 Adaptive UX — user preference (companion_enabled) overrides legacy
  // settings.companion.enabled when both are present.
  try {
    const prefs = require('../adaptive-ux/preferences');
    const { preferences } = prefs.loadUserPreferences();
    if (preferences && preferences.companion_enabled === false) return false;
  } catch (_) { /* adaptive-ux optional; fall through to legacy path */ }
  if (!settings || typeof settings !== 'object') return true;
  const c = settings.companion;
  if (c && typeof c === 'object' && 'enabled' in c) return !!c.enabled;
  return true;
}

// W8.3 — companion tone preference passthrough (alien-quiet | friendly).
// Returns null if no override; callers fall back to default 'alien-quiet'.
function preferredTone() {
  try {
    const prefs = require('../adaptive-ux/preferences');
    const { preferences } = prefs.loadUserPreferences();
    return preferences && preferences.companion_tone ? preferences.companion_tone : null;
  } catch (_) { return null; }
}

module.exports = {
  companionRespond,
  companionRespondText,
  loadContract,
  validateExpression,
  enforceBoundary,
  getKeywordMapping,
  isEnabled,
  preferredTone,
  KEYWORD_MAPPING,
  SUPPORTED_TRIGGERS,
  // AMD-MEOW-P8 persona coherence surface.
  scorePersonaCoherence: personaCoherence.scorePersonaCoherence,
  scoreStability: personaCoherence.scoreStability,
  scoreRobustness: personaCoherence.scoreRobustness,
  loadEnrichedContract: personaCoherence.loadEnrichedContract,
  findRepairPattern: personaCoherence.findRepairPattern,
  PERSONA_COHERENCE_GATE: personaCoherence.GATE_THRESHOLD,
  // B2.M1 (2026-05-21) — persistence + trend layer over persona-coherence.
  logCoherenceScore: coherenceLog.logCoherenceScore,
  readCoherenceLog: coherenceLog.readCoherenceLog,
  getCoherenceTrend: coherenceLog.getTrend,
};
