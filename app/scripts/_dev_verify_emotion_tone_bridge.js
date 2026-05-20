'use strict';
// Smoke verify for app/lib/companion/emotion-tone-bridge.js.
// 8 cases (BR1-BR8). Exit 0 on all-pass, 1 on any fail.
// No external deps. Mirrors existing _dev_verify_*.js style.

const path = require('node:path');

const bridge = require(path.join(__dirname, '..', 'lib', 'companion', 'emotion-tone-bridge'));
const emotionState = require(path.join(__dirname, '..', 'lib', 'companion', 'emotion-state'));

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  // eslint-disable-next-line no-console
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// Helper: build a recentQuestions array that will trip the 5-same-type
// boundary-protect classifier in emotion-state.js. Use 'definition' type.
function fiveDefinitionQuestions() {
  return [
    '什么是 X?',
    '定义一下 Y',
    '什么是 Z?',
    '什么意思 W?',
    '什么是 V?',
  ];
}

(async () => {
  // ── BR1: composeExpression with no trigger → error MISSING_TRIGGER ──────
  try {
    const r = await bridge.composeExpression({});
    assert(r.ok === false, 'ok should be false');
    assert(r.error === 'MISSING_TRIGGER', `error=${r.error}`);
    record('BR1: missing trigger → MISSING_TRIGGER', true);
  } catch (e) {
    record('BR1: missing trigger → MISSING_TRIGGER', false, e.message);
  }

  // ── BR2: lesson_complete + IDLE → not suppressed, register=neutral ──────
  try {
    const r = await bridge.composeExpression({
      trigger: 'lesson_complete',
      sessionContext: { currentText: '', recentQuestions: [], turnCount: 1 },
    });
    assert(r.ok === true, 'ok should be true');
    assert(r.suppressed === false, `suppressed=${r.suppressed}`);
    assert(r.effective_trigger === 'lesson_complete', `effective=${r.effective_trigger}`);
    assert(r.emotion === emotionState.STATES.IDLE, `emotion=${r.emotion}`);
    assert(r.bias && r.bias.register === 'neutral', `register=${r.bias && r.bias.register}`);
    record('BR2: lesson_complete + IDLE → neutral, not suppressed', true);
  } catch (e) {
    record('BR2: lesson_complete + IDLE → neutral, not suppressed', false, e.message);
  }

  // ── BR3: lesson_complete + BOUNDARY_PROTECT → suppressed ────────────────
  try {
    const r = await bridge.composeExpression({
      trigger: 'lesson_complete',
      sessionContext: {
        currentText: '',
        recentQuestions: fiveDefinitionQuestions(),
        turnCount: 10,
      },
    });
    assert(r.ok === true, 'ok should be true');
    assert(r.suppressed === true, `suppressed=${r.suppressed}`);
    assert(r.effective_trigger === null, `effective=${r.effective_trigger}`);
    assert(r.emotion === emotionState.STATES.BOUNDARY_PROTECT, `emotion=${r.emotion}`);
    assert(r.reason === 'TRIGGER_SUPPRESSED_BY_EMOTION', `reason=${r.reason}`);
    record('BR3: lesson_complete + BOUNDARY_PROTECT → suppressed', true);
  } catch (e) {
    record('BR3: lesson_complete + BOUNDARY_PROTECT → suppressed', false, e.message);
  }

  // ── BR4: interrupt_resume + BOUNDARY_PROTECT → escalates to over_grind ──
  try {
    const r = await bridge.composeExpression({
      trigger: 'interrupt_resume',
      sessionContext: {
        currentText: '',
        recentQuestions: fiveDefinitionQuestions(),
        turnCount: 10,
      },
    });
    assert(r.ok === true, 'ok should be true');
    assert(r.suppressed === false, `suppressed=${r.suppressed}`);
    assert(r.effective_trigger === 'over_grind', `effective=${r.effective_trigger}`);
    assert(r.emotion === emotionState.STATES.BOUNDARY_PROTECT, `emotion=${r.emotion}`);
    record('BR4: interrupt_resume + BOUNDARY_PROTECT → over_grind escalation', true);
  } catch (e) {
    record('BR4: interrupt_resume + BOUNDARY_PROTECT → over_grind escalation', false, e.message);
  }

  // ── BR5: product_spark_sprout + BOUNDARY_PROTECT → suppressed ───────────
  try {
    const r = await bridge.composeExpression({
      trigger: 'product_spark_sprout',
      sessionContext: {
        currentText: '',
        recentQuestions: fiveDefinitionQuestions(),
        turnCount: 10,
      },
    });
    assert(r.ok === true, 'ok should be true');
    assert(r.suppressed === true, `suppressed=${r.suppressed}`);
    assert(r.effective_trigger === null, `effective=${r.effective_trigger}`);
    record('BR5: product_spark_sprout + BOUNDARY_PROTECT → suppressed', true);
  } catch (e) {
    record('BR5: product_spark_sprout + BOUNDARY_PROTECT → suppressed', false, e.message);
  }

  // ── BR6: over_grind + BOUNDARY_PROTECT → NOT suppressed (boundary signal IS over_grind) ──
  try {
    const r = await bridge.composeExpression({
      trigger: 'over_grind',
      sessionContext: {
        currentText: '',
        recentQuestions: fiveDefinitionQuestions(),
        turnCount: 10,
      },
    });
    assert(r.ok === true, 'ok should be true');
    assert(r.suppressed === false, `suppressed=${r.suppressed}`);
    assert(r.effective_trigger === 'over_grind', `effective=${r.effective_trigger}`);
    assert(r.emotion === emotionState.STATES.BOUNDARY_PROTECT, `emotion=${r.emotion}`);
    record('BR6: over_grind + BOUNDARY_PROTECT → not suppressed (boundary signal)', true);
  } catch (e) {
    record('BR6: over_grind + BOUNDARY_PROTECT → not suppressed (boundary signal)', false, e.message);
  }

  // ── BR7: shouldSuppress null inputs → false (safe) ──────────────────────
  try {
    assert(bridge.shouldSuppress(null, null) === false, 'null/null');
    assert(bridge.shouldSuppress(undefined, undefined) === false, 'undef/undef');
    assert(bridge.shouldSuppress('lesson_complete', null) === false, 'trigger only');
    assert(bridge.shouldSuppress(null, emotionState.STATES.BOUNDARY_PROTECT) === false, 'emotion only');
    assert(bridge.shouldSuppress('', '') === false, 'empty strings');
    record('BR7: shouldSuppress null/undef/empty inputs → false', true);
  } catch (e) {
    record('BR7: shouldSuppress null/undef/empty inputs → false', false, e.message);
  }

  // ── BR8: biasForEmotion unknown state → IDLE bias fallback ──────────────
  try {
    const unknown = bridge.biasForEmotion('not-a-real-state');
    const idle = bridge.biasForEmotion(emotionState.STATES.IDLE);
    assert(unknown === idle || (unknown.register === idle.register && unknown.urgency === idle.urgency),
      `unknown bias mismatch: ${JSON.stringify(unknown)} vs ${JSON.stringify(idle)}`);
    assert(unknown.register === 'neutral', `register=${unknown.register}`);
    // Also defensively: undefined / null / empty.
    assert(bridge.biasForEmotion(undefined).register === 'neutral', 'undefined → neutral');
    assert(bridge.biasForEmotion(null).register === 'neutral', 'null → neutral');
    record('BR8: biasForEmotion unknown → IDLE fallback', true);
  } catch (e) {
    record('BR8: biasForEmotion unknown → IDLE fallback', false, e.message);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${total} PASS`);
  if (passed !== total) process.exit(1);
})().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('FATAL', e && e.stack || e);
  process.exit(1);
});
