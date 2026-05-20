'use strict';
//
// HYPHA · v0 Mock Marker — honest stamp for shipped-but-mocked module outputs.
//
// intentional-placeholder: this file is the marker layer ITSELF — it exists
//   specifically because three upstream modules (product-transfer T4_JUDGE,
//   tone-engine T2_LOCAL Gemma, creation-system-v1 auto-roadmap-sync T6_STRONG)
//   ship today with template / jaccard / synthetic-placeholder fallbacks that
//   will be swapped for real LLM calls in v0.4.1 / v0.8 / W5.4 respectively.
//   The marker is the audit trail those swaps will remove. Nothing here is
//   stub work — the marker module is the COMPLETE implementation of the
//   audit honesty layer. See module docstring above for full rationale.
//
// Purpose: 3 modules ship "live" surfaces today whose payloads are template /
// jaccard / placeholder fallbacks (not real LLM). Users see LLM-flavored text
// and have no way to know it is not LLM-derived. This module gives every such
// output a single, queryable tag the UI can render as "v0 模板输出" so the
// audit surface is honest without rewriting the mocked behavior.
//
// Tag schema (stable):
//   { ..., [MOCK_TAG_KEY]: MOCK_TAG_VALUE, _mock_reason: '<human-readable>' }
//
// Why a string sentinel + reason: cheap to JSON-roundtrip, cheap to test for
// in renderer, no class identity issues across IPC. The reason lives next to
// the tag so when T4_JUDGE / Gemma / T6_STRONG ship and the wrapper goes
// away, removing the marker also removes the trail in one diff.
//
// Boundaries:
//   - Read-only contract — callers must not mutate the returned object.
//     `tagMockOutput` always returns a fresh shallow-copy.
//   - Non-object payloads (strings / numbers) are still tagged: the helper
//     wraps them in `{ value: <payload>, [MOCK_TAG_KEY]: ..., _mock_reason }`.
//     This matters for tone-engine where the natural payload is a single
//     string; downstream UI consumers must check `_isMockOutput` first then
//     read `.value` (string) or named fields (object).
//   - Removal path: when the real LLM call swaps in, delete the
//     `require('./v0-mock-marker')` line + the `tagMockOutput(...)` wrap; the
//     surface contract stays — UI's `<V0MockBanner payload={x}/>` simply
//     returns null when `_isMockOutput(x)` is false.

const MOCK_TAG_KEY = '_hypha_mock';
const MOCK_TAG_VALUE = 'v0-template-output';

/**
 * Tag a payload as v0 mock output. Non-mutating; returns a fresh object with
 * the tag + reason attached. Strings / primitives get wrapped under .value.
 *
 * @param {*} payload
 * @param {string} reason — human-readable, e.g. 'tone-engine 模板兜底, Gemma 待 v0.8'
 * @returns {object}
 */
function tagMockOutput(payload, reason) {
  const r = (typeof reason === 'string' && reason.trim()) ? reason.trim() : 'unspecified';
  if (!payload || typeof payload !== 'object') {
    return {
      value: payload,
      [MOCK_TAG_KEY]: MOCK_TAG_VALUE,
      _mock_reason: r,
    };
  }
  return {
    ...payload,
    [MOCK_TAG_KEY]: MOCK_TAG_VALUE,
    _mock_reason: r,
  };
}

/**
 * Cheap predicate — true iff `payload` was tagged via tagMockOutput.
 * Used by the UI banner + downstream sinks (events.jsonl audit).
 *
 * @param {*} payload
 * @returns {boolean}
 */
function isMockOutput(payload) {
  return !!(payload
    && typeof payload === 'object'
    && payload[MOCK_TAG_KEY] === MOCK_TAG_VALUE);
}

/**
 * Pull the `_mock_reason` field out, or null when payload is not tagged.
 *
 * @param {*} payload
 * @returns {string|null}
 */
function getMockReason(payload) {
  if (!isMockOutput(payload)) return null;
  return payload._mock_reason || 'unspecified';
}

module.exports = {
  MOCK_TAG_KEY,
  MOCK_TAG_VALUE,
  tagMockOutput,
  isMockOutput,
  getMockReason,
};
