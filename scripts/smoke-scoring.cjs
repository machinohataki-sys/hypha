'use strict';

/**
 * HYPHA · Micro Proof scoring smoke — v0.1 sub-step H.
 *
 * Runs scoreMicroProof() against 1 hardcoded plan + 3 response cases:
 *   (a) clearly-passing recall  — contains all expected_signal tokens.
 *   (b) clearly-failing         — contains 0 tokens.
 *   (c) tricky-shapeless        — contains tokens but is short / has no
 *       structural separators. Pass/fail depends on baseline rules; we
 *       only assert the result shape + log the verdict for inspection.
 *
 * Per AMD-1: passed verdict comes from LOCAL baseline (regex+shape), LLM is
 * monitor-only. Asserts: baseline_check trustworthy, false_positive_risk
 * computed from local baseline + llm_signal.
 *
 * Requires GLM_API_KEY env var. 3 LLM calls, ~10-30s total.
 *
 * Usage: $env:GLM_API_KEY = '...' ; node scripts/smoke-scoring.cjs
 */

const path = require('path');
const sc = require(path.resolve(__dirname, '..', 'app', 'lib', 'scoring.js'));

const PLAN = {
  objective: 'Identify the inputs and outputs of a single workflow step.',
  prerequisite_check: '你能描述一个工作流当前的输入和输出吗?',
  hook_concrete: '一个工作流接收一份订单数据, 决定是否扣库存. 这一步的输入和输出可以画在一张白纸上.',
  path: [
    '画一张白纸, 标记本工作流当前一步的所有输入字段.',
    '在同一张纸上, 列出这一步对外发出的输出字段.',
    '为每个输出字段, 写一句话说明它依赖哪些输入字段.',
    '把这张图给一个不熟悉这块业务的同事看, 让他用自己话复述一遍.',
  ],
  micro_proof: {
    stimulus: '列出这个工作流步骤的输入字段和输出字段.',
    expected_signal: 'Response contains: order_id, sku, quantity, stock_remaining, decision.',
    fail_mode: '只画输入不画输出 / 复述只用术语不用具体字段名.',
  },
  next_lesson_seed: '下一节: 把这张图改成可执行的 1 步代码.',
};

const CASES = [
  {
    label: 'clearly-passing recall',
    response: `Inputs: order_id, sku, quantity.
Outputs: stock_remaining, decision.
Each output depends on the inputs listed above.`,
    expectPassed: true,
    expectRisk: ['low', 'medium'],
  },
  {
    label: 'clearly-failing (no tokens)',
    response: '我不太确定这个步骤里有什么字段，可能要再想想。',
    expectPassed: false,
    expectRisk: null,
  },
  {
    label: 'tricky shapeless (tokens present but short / no separator)',
    response: 'order_id sku quantity stock_remaining decision',
    expectPassed: null, // log-only — depends on baseline classifier path
    expectRisk: null,
  },
];

function summarize(r) {
  const hits = (r.baseline_check && r.baseline_check.regex_hits) || [];
  const reason = (r.llm_signal && r.llm_signal.reason) || '';
  return [
    `passed=${r.passed}`,
    `evidence_type=${r.evidence_type}`,
    `shape_match=${r.baseline_check && r.baseline_check.shape_match}`,
    `regex_hits=[${hits.join(', ')}]`,
    `llm.matches_pattern=${r.llm_signal && r.llm_signal.matches_pattern}`,
    `llm.reason="${reason}"`,
    `false_positive_risk=${r.false_positive_risk}`,
  ].join('\n    ');
}

(async () => {
  console.log('=== HYPHA Micro Proof scoring smoke (sub-step H) ===\n');
  if (!process.env.GLM_API_KEY) {
    console.error('[ENV-MISSING] GLM_API_KEY not set. Set it and re-run.');
    process.exit(2);
  }

  let pass = 0, fail = 0;
  function assert(cond, label, detail) {
    if (cond) { console.log(`  [PASS] ${label}`); pass++; }
    else      { console.log(`  [FAIL] ${label} -- ${detail}`); fail++; }
  }

  for (const c of CASES) {
    console.log(`\n--- Case: ${c.label} ---`);
    console.log(`response: ${JSON.stringify(c.response)}`);
    const t0 = Date.now();
    let r;
    try {
      r = await sc.scoreMicroProof({ plan: PLAN, response: c.response });
    } catch (e) {
      console.error(`[FAIL] threw: ${e.message}`);
      fail++;
      continue;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`  result (${elapsed}s):\n    ${summarize(r)}`);

    // Shape assertions (always run)
    assert(['recall', 'production'].includes(r.evidence_type), 'evidence_type valid', `got ${r.evidence_type}`);
    assert(typeof r.passed === 'boolean', 'passed is boolean', `got ${typeof r.passed}`);
    assert(r.baseline_check && Array.isArray(r.baseline_check.regex_hits), 'baseline_check.regex_hits array', 'missing or wrong type');
    assert(r.baseline_check && typeof r.baseline_check.shape_match === 'boolean', 'baseline_check.shape_match boolean', 'missing or wrong type');
    assert(['low', 'medium', 'high'].includes(r.false_positive_risk), 'false_positive_risk valid', `got ${r.false_positive_risk}`);

    // Behavior assertions (only when expected is non-null)
    if (c.expectPassed !== null) {
      assert(r.passed === c.expectPassed, `passed === ${c.expectPassed}`, `got ${r.passed}`);
    }
    if (c.expectRisk) {
      assert(c.expectRisk.includes(r.false_positive_risk), `false_positive_risk in [${c.expectRisk.join('|')}]`, `got ${r.false_positive_risk}`);
    }
  }

  console.log(`\nSummary: ${pass} passed / ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
