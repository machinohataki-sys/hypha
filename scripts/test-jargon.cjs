'use strict';
// HYPHA · Jargon Firewall v0 — test harness
// Run: node scripts/test-jargon.cjs

const { checkJargon } = require('../app/lib/jargon-firewall');

let pass = 0;
let fail = 0;

function expect(label, actual, predicate, detail) {
  const ok = predicate(actual);
  if (ok) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
    console.log('        actual:', JSON.stringify(actual));
    if (detail) console.log('        detail:', detail);
  }
}

console.log('Test 1: "AI 帮你学习" → expect 1 violation (AI)');
const r1 = checkJargon('AI 帮你学习');
expect('passed === false', r1, r => r.passed === false);
expect('violations.length === 1', r1, r => r.violations.length === 1);
expect('violations[0].word === "AI"', r1, r => r.violations[0] && r.violations[0].word === 'AI');
expect('violations[0].position === 0', r1, r => r.violations[0] && r.violations[0].position === 0);
expect('violations[0].line === 1', r1, r => r.violations[0] && r.violations[0].line === 1);

console.log('Test 2: "今天这一刀直击灵魂" → expect 2 violations (这一刀, 直击灵魂)');
const r2 = checkJargon('今天这一刀直击灵魂');
expect('passed === false', r2, r => r.passed === false);
expect('violations.length === 2', r2, r => r.violations.length === 2);
expect('contains 这一刀', r2, r => r.violations.some(v => v.word === '这一刀'));
expect('contains 直击灵魂', r2, r => r.violations.some(v => v.word === '直击灵魂'));
expect('sorted by position', r2, r => r.violations[0].position <= r.violations[1].position);

console.log('Test 3: "学习是慢的" → expect 0 violations');
const r3 = checkJargon('学习是慢的');
expect('passed === true', r3, r => r.passed === true);
expect('violations.length === 0', r3, r => r.violations.length === 0);

console.log('');
console.log(`Result: ${pass} passed, ${fail} failed`);
console.log('');
console.log('Sample violation entries:');
console.log('  Test 1:', JSON.stringify(r1.violations));
console.log('  Test 2:', JSON.stringify(r2.violations));

if (fail > 0) process.exit(1);
