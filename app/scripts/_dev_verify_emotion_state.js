#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_emotion_state — smoke test for Companion v0.1.1
// orthogonal emotion-state classifier (app/lib/companion/emotion-state.js).
//
// 8 tests:
//   ES1: empty input returns IDLE
//   ES2: delegate request returns BOUNDARY_PROTECT (DELEGATE_REQUEST)
//   ES3: 5 same-type definition questions return BOUNDARY_PROTECT (REPEATED_QUESTION_TYPE)
//   ES4: hypothesis "我认为 X" returns MIRROR
//   ES5: stuck "卡住了" returns ENCOURAGING
//   ES6: new concept "听说过 Y" returns CURIOUS
//   ES7: priority — delegate beats hypothesis
//   ES8: getEmotionVocabulary returns object with tone_hint + signal_color for all 5 states
//
// Run:
//   node app/scripts/_dev_verify_emotion_state.js
//
// Exit 0 = PASS N/N, Exit 1 = any failure.

const path = require('path');

const {
  STATES,
  detectEmotionState,
  getEmotionVocabulary,
} = require(path.join(__dirname, '..', 'lib', 'companion', 'emotion-state.js'));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`);
  }
}

console.log('\n[emotion-state smoke]');

// ── ES1: empty input → IDLE ────────────────────────────────────────────
(function ES1() {
  const empty = detectEmotionState({});
  const nullIn = detectEmotionState(null);
  const undefIn = detectEmotionState(undefined);
  const emptyText = detectEmotionState({ currentText: '' });
  check(
    'ES1 empty input returns IDLE',
    empty.state === STATES.IDLE &&
      nullIn.state === STATES.IDLE &&
      undefIn.state === STATES.IDLE &&
      emptyText.state === STATES.IDLE,
    `empty=${empty.state} null=${nullIn.state} undef=${undefIn.state} emptyText=${emptyText.state}`
  );
})();

// ── ES2: delegate request → BOUNDARY_PROTECT(DELEGATE_REQUEST) ────────
(function ES2() {
  const r = detectEmotionState({ currentText: '帮我做一份学习计划' });
  check(
    'ES2 delegate request returns BOUNDARY_PROTECT (DELEGATE_REQUEST)',
    r.state === STATES.BOUNDARY_PROTECT && r.signal === 'DELEGATE_REQUEST',
    `state=${r.state} signal=${r.signal}`
  );

  const r2 = detectEmotionState({ currentText: 'do this for me please' });
  check(
    'ES2b English delegate request also returns BOUNDARY_PROTECT',
    r2.state === STATES.BOUNDARY_PROTECT && r2.signal === 'DELEGATE_REQUEST',
    `state=${r2.state} signal=${r2.signal}`
  );
})();

// ── ES3: 5 same-type definition questions → BOUNDARY_PROTECT ──────────
(function ES3() {
  const recent = [
    '什么是 RAG?',
    '什么是 embedding?',
    '定义一下 vector 是什么?',
    'what is fine-tune?',
    '什么意思是 token?',
  ];
  const r = detectEmotionState({
    currentText: '今天天气不错',
    recentQuestions: recent,
  });
  check(
    'ES3 5 same-type definition questions return BOUNDARY_PROTECT (REPEATED_QUESTION_TYPE)',
    r.state === STATES.BOUNDARY_PROTECT &&
      r.signal === 'REPEATED_QUESTION_TYPE' &&
      r.signal_type === 'definition',
    `state=${r.state} signal=${r.signal} type=${r.signal_type}`
  );
})();

// ── ES4: hypothesis statement → MIRROR ────────────────────────────────
(function ES4() {
  const r1 = detectEmotionState({ currentText: '我认为这个跟梯度下降有关' });
  check(
    'ES4 hypothesis 我认为 returns MIRROR',
    r1.state === STATES.MIRROR && r1.signal === 'HYPOTHESIS_STATEMENT',
    `state=${r1.state} signal=${r1.signal}`
  );

  const r2 = detectEmotionState({ currentText: 'i think this links to backprop' });
  check(
    'ES4b English i think returns MIRROR',
    r2.state === STATES.MIRROR && r2.signal === 'HYPOTHESIS_STATEMENT',
    `state=${r2.state} signal=${r2.signal}`
  );
})();

// ── ES5: stuck signal → ENCOURAGING ───────────────────────────────────
(function ES5() {
  const r1 = detectEmotionState({ currentText: '我卡住了这里' });
  check(
    'ES5 stuck 卡住 returns ENCOURAGING',
    r1.state === STATES.ENCOURAGING && r1.signal === 'STUCK_SIGNAL',
    `state=${r1.state} signal=${r1.signal}`
  );

  const r2 = detectEmotionState({ currentText: "i'm stuck on this part" });
  check(
    'ES5b English stuck returns ENCOURAGING',
    r2.state === STATES.ENCOURAGING && r2.signal === 'STUCK_SIGNAL',
    `state=${r2.state} signal=${r2.signal}`
  );
})();

// ── ES6: new concept → CURIOUS ────────────────────────────────────────
(function ES6() {
  const r1 = detectEmotionState({ currentText: '我听说过一个东西叫 attention' });
  check(
    'ES6 new concept 听说过 returns CURIOUS',
    r1.state === STATES.CURIOUS && r1.signal === 'NEW_CONCEPT',
    `state=${r1.state} signal=${r1.signal}`
  );

  const r2 = detectEmotionState({ currentText: 'first time hearing this term' });
  check(
    'ES6b English first time returns CURIOUS',
    r2.state === STATES.CURIOUS && r2.signal === 'NEW_CONCEPT',
    `state=${r2.state} signal=${r2.signal}`
  );
})();

// ── ES7: priority — delegate beats hypothesis ─────────────────────────
(function ES7() {
  // Combined text has both delegate marker AND hypothesis marker.
  const r = detectEmotionState({
    currentText: '我认为这个不对, 帮我做一份正确版本',
  });
  check(
    'ES7 priority: delegate beats hypothesis (BOUNDARY_PROTECT, not MIRROR)',
    r.state === STATES.BOUNDARY_PROTECT && r.signal === 'DELEGATE_REQUEST',
    `state=${r.state} signal=${r.signal}`
  );

  // Boundary repeated-questions should beat hypothesis as well.
  const r2 = detectEmotionState({
    currentText: '我认为它是这样',
    recentQuestions: [
      '什么是 RAG?',
      '什么是 embedding?',
      '定义一下 vector?',
      'what is fine-tune?',
      '什么意思是 token?',
    ],
  });
  check(
    'ES7b priority: repeated-questions beats hypothesis',
    r2.state === STATES.BOUNDARY_PROTECT && r2.signal === 'REPEATED_QUESTION_TYPE',
    `state=${r2.state} signal=${r2.signal}`
  );
})();

// ── ES8: getEmotionVocabulary returns shape for all 5 states ──────────
(function ES8() {
  const stateList = [
    STATES.IDLE,
    STATES.CURIOUS,
    STATES.ENCOURAGING,
    STATES.MIRROR,
    STATES.BOUNDARY_PROTECT,
  ];
  let ok = true;
  const issues = [];
  for (const s of stateList) {
    const v = getEmotionVocabulary(s);
    if (!v || typeof v !== 'object') {
      ok = false;
      issues.push(`${s}: not object`);
      continue;
    }
    if (typeof v.tone_hint !== 'string' || v.tone_hint.length === 0) {
      ok = false;
      issues.push(`${s}: tone_hint invalid`);
    }
    if (typeof v.signal_color !== 'string' || v.signal_color.length === 0) {
      ok = false;
      issues.push(`${s}: signal_color invalid`);
    }
  }
  // Unknown state should fall back to IDLE vocabulary (defensive).
  const unknown = getEmotionVocabulary('not-a-state');
  if (!unknown || unknown.tone_hint !== '(留白)') {
    ok = false;
    issues.push(`unknown fallback: ${JSON.stringify(unknown)}`);
  }
  check(
    'ES8 getEmotionVocabulary returns tone_hint+signal_color for all 5 states (+unknown fallback)',
    ok,
    issues.join('; ')
  );
})();

// ── Summary ───────────────────────────────────────────────────────────
const total = pass + fail;
console.log(`\n[emotion-state smoke] ${pass}/${total} PASS`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}${f.detail ? '  -- ' + f.detail : ''}`);
  }
  process.exit(1);
}
process.exit(0);
