'use strict';

/**
 * HYPHA · Anti-Illusion v0 — test scaffold.
 *
 * intentional-placeholder: per W1.3 task spec, this file ships as a
 * `test.todo()` list (one per illusion type / intervention / gate path).
 * Real assertions land in W1.3.1 alongside the T4_JUDGE LLM wiring so the
 * LLM-dependent detectors get a deterministic test surface (recorded
 * fixtures, not live model calls). Filing them as todos NOW locks the
 * shape contract for the upgrade and surfaces missing coverage when the
 * runner is wired.
 *
 * Test runner: not yet adopted at hypha app/ root — these `test.todo` entries
 * are written against the `node:test` API (built-in since Node 18) so they
 * don't pull a dep. To run once a runner is wired:
 *   node --test app/__tests__/anti-illusion.test.js
 */

let test, _describe;
try {
  ({ test, describe: _describe } = require('node:test'));
} catch (_) {
  // Older Node — fall back to a no-op shim so the file at least node-checks.
  test = (_n, _fn) => {};
  test.todo = (_n) => {};
  _describe = (_n, fn) => (typeof fn === 'function' ? fn() : null);
}

const describe = _describe || ((_n, fn) => (typeof fn === 'function' ? fn() : null));

describe('anti-illusion v0 — detector contract', () => {
  test.todo('ai_mimicry — flags > 0.70 trigram-jaccard against lessonKP.mechanism_explanation');
  test.todo('ai_mimicry — does NOT flag genuine paraphrase (< 0.50 similarity)');
  test.todo('no_example — flags abstract reply when exit_proof asked for instance');
  test.todo('no_example — does NOT flag reply with year / proper-noun / quantified marker');
  test.todo('no_transfer — flags canonical_example restate (sim ≥ 0.55)');
  test.todo('no_transfer — does NOT flag fresh-domain answer below restate threshold');
  test.todo('ai_ghostwrite — flags responseTimeMs < 2000 + len ≥ 100 + markdown bullets');
  test.todo('ai_ghostwrite — does NOT flag short typed answers regardless of timing');
  test.todo('no_action_proof — sub-fires (< 0.7) when actionLog is empty array');
  test.todo('no_action_proof — returns 0 when actionLog is null (caller did not wire)');
  test.todo('no_creation_reflow — always returns 0 confidence (W3.x deferred)');
});

describe('anti-illusion v0 — selector contract', () => {
  test.todo('detectIllusion picks highest-confidence signal above FIRE_CONFIDENCE');
  test.todo('detectIllusion returns illusion_detected=false when no signal fires');
  test.todo('detectIllusion preserves all_signals[] for telemetry even when no fire');
});

describe('anti-illusion v0 — gate contract', () => {
  test.todo('evalNextLessonGate allows when no illusion detected');
  test.todo('evalNextLessonGate blocks + emits micro_task when ai_mimicry fires');
  test.todo('evalNextLessonGate routes ai_ghostwrite to request_action_log intervention');
  test.todo('evalNextLessonGate routes no_creation_reflow to product_transfer_drill (W3.x stub)');
  test.todo('buildMicroTask always returns id + prompt + expected_format + timeout_sec');
  test.todo('buildMicroTask micro_transfer_task prompt mentions the lesson anchor');
});
