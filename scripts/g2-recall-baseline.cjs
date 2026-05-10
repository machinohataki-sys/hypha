'use strict';

/**
 * HYPHA · v0.1 G2 acceptance gate runner — Recall Evidence false positive rate.
 *
 * Reads scripts/g2-recall-fixture.json (30 cases with human_label),
 * runs scoreMicroProof against each, computes false positive rate.
 *
 * PASS criterion: FP_rate < 10% (≤2 cases where human_label='fail' but
 * scoreMicroProof returned passed=true).
 *
 * Usage:
 *   $env:GLM_API_KEY = '...'
 *   node scripts/g2-recall-baseline.cjs
 *
 * Cost: 30 LLM calls @ T3_MID (default GLM-4.5-Air) ≈ ¥0.05.
 * Time: ~5 min wall clock at GLM 60 RPM.
 */

const path = require('path');
const fs = require('fs');
const { scoreMicroProof } = require(path.resolve(__dirname, '..', 'app', 'lib', 'scoring.js'));

const FIXTURE_PATH = path.resolve(__dirname, 'g2-recall-fixture.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

(async () => {
  console.log('G2 Recall Evidence FP Rate — runner');
  console.log(`Cases: ${fixture.cases.length}`);
  console.log('-'.repeat(72));

  const results = [];
  let fp = 0; // false positive: label=fail but llm_passed=true
  let fn = 0; // false negative: label=pass but llm_passed=false
  let agree = 0;

  for (let i = 0; i < fixture.cases.length; i++) {
    const c = fixture.cases[i];
    const plan = {
      objective: 'recall test',
      micro_proof: {
        stimulus: c.stimulus,
        expected_signal: c.expected_signal,
        fail_mode: c.fail_mode,
      },
    };
    const idx = String(i + 1).padStart(2, '0');
    try {
      const out = await scoreMicroProof({ plan, response: c.response });
      const llmPassed = out.passed === true;
      const expected = c.human_label === 'pass';
      const isFp = !expected && llmPassed;
      const isFn = expected && !llmPassed;
      if (isFp) fp++;
      else if (isFn) fn++;
      else agree++;
      results.push({ idx, topic: c.topic, intent: c._intent, human_label: c.human_label, llm_passed: llmPassed, fp: isFp, fn: isFn });
      const tag = isFp ? 'FP' : isFn ? 'FN' : 'OK';
      console.log(`${idx} [${tag}] ${c.topic.padEnd(14)} ${c._intent.padEnd(20)} label=${c.human_label.padEnd(4)} llm=${String(llmPassed).padEnd(5)}`);
    } catch (e) {
      console.error(`${idx} ERROR: ${e.message}`);
      results.push({ idx, topic: c.topic, intent: c._intent, error: e.message });
    }
  }

  console.log('-'.repeat(72));
  const total = fixture.cases.length;
  const fpRate = (fp / total) * 100;
  const fnRate = (fn / total) * 100;
  console.log(`agreement: ${agree}/${total} (${(agree / total * 100).toFixed(1)}%)`);
  console.log(`false positives: ${fp}/${total} (${fpRate.toFixed(1)}%)  ← gate metric`);
  console.log(`false negatives: ${fn}/${total} (${fnRate.toFixed(1)}%)  (informational)`);
  console.log(`gate: FP < 10% — ${fpRate < 10 ? 'PASS ✓' : 'FAIL ✗'}`);

  fs.writeFileSync(
    path.resolve(__dirname, 'g2-recall-output.json'),
    JSON.stringify({ summary: { total, agree, fp, fn, fp_rate: fpRate, fn_rate: fnRate, pass: fpRate < 10 }, results }, null, 2),
  );
  console.log(`output: scripts/g2-recall-output.json`);

  process.exit(fpRate < 10 ? 0 : 1);
})();
