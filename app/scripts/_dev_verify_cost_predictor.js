'use strict';

// Smoke verifier for app/lib/llm/cost-predictor.js
// 10 cases. Exits 0 on all-pass, 1 on any failure.

const {
  COST_PER_1K_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  estimateTokens,
  estimateMessages,
  predictCost,
  gateAgainstBudget,
} = require('../lib/llm/cost-predictor');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`FAIL  ${name}  ${detail || ''}`);
  }
}

function approx(actual, expected, tol) {
  return Math.abs(actual - expected) <= tol;
}

// CP1: estimateTokens empty input → 0
{
  const r1 = estimateTokens('');
  const r2 = estimateTokens(null);
  const r3 = estimateTokens(undefined);
  const r4 = estimateTokens(123);
  check('CP1 estimateTokens empty/non-string → 0',
    r1 === 0 && r2 === 0 && r3 === 0 && r4 === 0,
    `got [${r1},${r2},${r3},${r4}]`);
}

// CP2: estimateTokens ASCII text → ~L/4 tokens
{
  const text = 'the quick brown fox jumps over the lazy dog'; // 43 chars, ~35 printable ASCII
  const tokens = estimateTokens(text);
  // ASCII printable chars (code > 32 && < 127) only. Spaces (code 32) excluded.
  // 35 non-space ASCII chars → ceil(35/4) = 9 tokens.
  check('CP2 ASCII text → ~L/4 tokens',
    approx(tokens, 9, 2),
    `expected ~9, got ${tokens}`);
}

// CP3: estimateTokens CJK text → ~L/1.7 tokens
{
  const text = '人工智能改变世界'; // 8 CJK chars → ceil(8/1.7) = 5 tokens
  const tokens = estimateTokens(text);
  check('CP3 CJK text → ~L/1.7 tokens',
    approx(tokens, 5, 1),
    `expected ~5, got ${tokens}`);
}

// CP4: estimateMessages multi-turn aggregates
{
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' }, // ~24 ascii chars → ceil(24/4)=6 + 4 overhead = 10
    { role: 'user', content: 'Hello world' },                    // 10 ascii → ceil(10/4)=3 + 4 = 7
    { role: 'assistant', content: '你好世界' },                   // 4 CJK → ceil(4/1.7)=3 + 4 = 7
  ];
  const total = estimateMessages(messages);
  // Sum of per-message contributions. Allow tolerance for char-counting edge cases.
  check('CP4 estimateMessages aggregates multi-turn',
    total > 15 && total < 40,
    `expected 15-40, got ${total}`);
}

// CP4b: estimateMessages handles structured-content (Anthropic v2 schema)
{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] },
  ];
  const total = estimateMessages(messages);
  check('CP4b structured-content array aggregates',
    total >= 6 && total <= 10,
    `expected 6-10, got ${total}`);
}

// CP5: predictCost rejects unknown capability
{
  const r = predictCost([{ role: 'user', content: 'hi' }], 'T99_BOGUS');
  check('CP5 predictCost rejects unknown capability',
    r.ok === false && r.error === 'UNKNOWN_CAPABILITY' && r.estimate === null,
    JSON.stringify(r));
}

// CP6: predictCost T6_STRONG empty messages, default output → cost > 0 from output, breakdown sums correctly
{
  const r = predictCost([], 'T6_STRONG');
  const e = r.estimate;
  // Empty messages → input_tokens_est = 0 → input_cny = 0
  // default output = 8000 → output_cny = (8000/1000) * 0.12 = 0.96
  const expectedOutputCny = (DEFAULT_OUTPUT_TOKENS.T6_STRONG / 1000) * COST_PER_1K_TOKENS.T6_STRONG.output_cny;
  const sumOk = approx(e.breakdown.input_cny + e.breakdown.output_cny, e.cny_est, 0.001);
  check('CP6 T6_STRONG empty msgs → cost from output, breakdown sums',
    r.ok === true
      && e.input_tokens_est === 0
      && e.output_tokens_max === DEFAULT_OUTPUT_TOKENS.T6_STRONG
      && approx(e.cny_est, expectedOutputCny, 0.001)
      && sumOk
      && e.estimation_source === 'tokenizer-fallback'
      && e.status === 'predicted',
    JSON.stringify(e));
}

// CP7: predictCost T1_EMBED → output_cny = 0
{
  const r = predictCost([{ role: 'user', content: 'embed this text' }], 'T1_EMBED');
  const e = r.estimate;
  check('CP7 T1_EMBED → output_cny = 0',
    r.ok === true
      && e.breakdown.output_cny === 0
      && e.cny_est >= 0,
    JSON.stringify(e));
}

// CP8: gateAgainstBudget BUDGET_EXHAUSTED when remaining ≤ 0
{
  const g1 = gateAgainstBudget(0.5, 0);
  const g2 = gateAgainstBudget(0.5, -1);
  check('CP8 gate BUDGET_EXHAUSTED on remaining ≤ 0',
    g1.allowed === false && g1.reason === 'BUDGET_EXHAUSTED'
      && g2.allowed === false && g2.reason === 'BUDGET_EXHAUSTED',
    JSON.stringify({ g1, g2 }));
}

// CP9: gateAgainstBudget WOULD_EXCEED_BUDGET when predicted > remaining
{
  const g = gateAgainstBudget(5.0, 2.0);
  check('CP9 gate WOULD_EXCEED_BUDGET when predicted > remaining',
    g.allowed === false
      && g.reason === 'WOULD_EXCEED_BUDGET'
      && g.predicted === 5.0
      && g.remaining === 2.0,
    JSON.stringify(g));
}

// CP10: gateAgainstBudget OK_BUT_NEAR_LIMIT when ratio > 0.9
{
  const g = gateAgainstBudget(0.95, 1.0);
  check('CP10 gate OK_BUT_NEAR_LIMIT when ratio > 0.9',
    g.allowed === true
      && g.reason === 'OK_BUT_NEAR_LIMIT'
      && g.ratio > 0.9,
    JSON.stringify(g));
}

// CP10b: gateAgainstBudget OK when ratio low + NO_COST when predicted = 0 + INVALID_INPUT on NaN
{
  const ok = gateAgainstBudget(0.1, 10.0);
  const noCost = gateAgainstBudget(0, 5.0);
  const invalid = gateAgainstBudget(NaN, 5.0);
  check('CP10b gate OK/NO_COST/INVALID branches',
    ok.allowed === true && ok.reason === 'OK'
      && noCost.allowed === true && noCost.reason === 'NO_COST'
      && invalid.allowed === false && invalid.reason === 'INVALID_INPUT',
    JSON.stringify({ ok, noCost, invalid }));
}

console.log('---');
console.log(`Total: ${passed} pass, ${failed} fail`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
process.exit(0);
