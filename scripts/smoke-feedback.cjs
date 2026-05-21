#!/usr/bin/env node
'use strict';

// HYPHA · sub-step J smoke test — Positive Feedback v0 (微反馈 only).
// Per BLUEPRINT §8.3: 能力证据回显, 不鸡汤, 转化可修复路径.
//
// 3 cases (PASS / FAIL / FP_RISK) + anti-cliche assertions.
// Exit 0 on full pass, 1 on any failure.

const path = require('path');
const { composePositiveFeedback } = require(path.join(__dirname, '..', 'app', 'lib', 'positive-feedback'));

// Banned: 鸡汤 / 客服腔 / 流量词 / emoji / 感叹号. Per Hypha CLAUDE.md +
// ban_ai_cliche_zh memory + BLUEPRINT §8.3 ! 鸡汤 directive.
const FORBIDDEN_TOKENS = [
  '加油', '你真棒', '继续努力', '做得好',
  '亲', '请您', '辛苦了',
  '这一刀', '闭环', '拉满', '干货', '绝绝子', 'yyds', '王炸',
  '!', '！',
];

const PLAN = {
  objective: 'List 3 facts about Tokyo weather.',
  next_lesson_seed: 'Compare Tokyo + Kyoto winter humidity baseline.',
  micro_proof: {
    stimulus: 'List 3 weather facts about Tokyo today.',
    expected_signal: 'city Tokyo 22°C humid drizzle wind',
    fail_mode: 'paraphrasing without verbatim city/temperature/condition tokens',
  },
};

let failures = 0;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}

function checkAntiCliche(name, msg) {
  for (const tok of FORBIDDEN_TOKENS) {
    if (msg.includes(tok)) {
      record(`${name} · anti-cliche [${tok}]`, false, `forbidden token "${tok}" present`);
      return;
    }
  }
  record(`${name} · anti-cliche`, true, 'no banned tokens');
}

// CASE 1 — PASS
{
  const sr = {
    passed: true,
    evidence_type: 'recall',
    baseline_check: { regex_hits: ['city', '22°C', 'Tokyo'], shape_match: true },
    llm_signal: { matches_pattern: true, reason: 'concrete recall with all 3 tokens verbatim' },
    false_positive_risk: 'low',
  };
  const r = composePositiveFeedback({ scoreResult: sr, plan: PLAN });
  record('PASS · type', r.type === 'pass', `got ${r.type}`);
  record('PASS · cites tokens', /city.*22°C.*Tokyo/.test(r.message), `msg=${r.message}`);
  record('PASS · cites next seed', r.message.includes(PLAN.next_lesson_seed), `msg=${r.message}`);
  checkAntiCliche('PASS', r.message);
  console.log('[PASS]   ', r.message);
}

// CASE 2 — FAIL
{
  const sr = {
    passed: false,
    evidence_type: 'recall',
    baseline_check: { regex_hits: [], shape_match: false },
    llm_signal: { matches_pattern: false, reason: 'no overlap with expected_signal tokens' },
    false_positive_risk: 'low',
  };
  const r = composePositiveFeedback({ scoreResult: sr, plan: PLAN });
  record('FAIL · type', r.type === 'fail', `got ${r.type}`);
  // Pass pattern is sliced to first 80 chars; check substring presence.
  const expectedSnippet = PLAN.micro_proof.expected_signal.slice(0, 40);
  record('FAIL · cites expected_signal', r.message.includes(expectedSnippet), `msg=${r.message}`);
  record('FAIL · gives repair path', r.message.includes('补上缺失'), `msg=${r.message}`);
  checkAntiCliche('FAIL', r.message);
  console.log('[FAIL]   ', r.message);
}

// CASE 3 — FP_RISK
{
  const sr = {
    passed: true,
    evidence_type: 'production',
    baseline_check: { regex_hits: ['x'], shape_match: true },
    llm_signal: { matches_pattern: false, reason: 'paraphrase 偏远, 未触及核心 stimulus' },
    false_positive_risk: 'high',
  };
  const r = composePositiveFeedback({ scoreResult: sr, plan: PLAN });
  record('FP_RISK · type', r.type === 'fp_risk', `got ${r.type}`);
  record('FP_RISK · cites reason', r.message.includes('paraphrase') || r.message.includes('偏远'),
    `msg=${r.message}`);
  record('FP_RISK · self-check prompt', r.message.includes('自查'), `msg=${r.message}`);
  checkAntiCliche('FP_RISK', r.message);
  console.log('[FP_RISK]', r.message);
}

// Print results
console.log('\n--- smoke-feedback results ---');
for (const { name, ok, detail } of results) {
  console.log(`  ${ok ? 'OK ' : 'FAIL'} · ${name}${ok ? '' : `  (${detail})`}`);
}

if (failures > 0) {
  console.log(`\n${failures} assertion(s) failed.`);
  process.exit(1);
}

console.log(`\nAll ${results.length} assertions passed. sub-step J ship-ready.`);
process.exit(0);
