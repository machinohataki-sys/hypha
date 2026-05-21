#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_exam_judge — smoke for T4_JUDGE LLM open-answer micro-judge.
//
// Mocks app/lib/llm.executeChat via opts.injectExecuteChat to exercise every
// branch of judgeOpenAnswer without HTTP. Validates:
//   1. Export shape (judgeOpenAnswer + VERDICTS + SUGGESTED_NEXT) valid
//   2. Mocked LLM "correct" verdict reaches output with confidence + reasoning
//   3. Mocked LLM "incorrect" verdict → suggested_next defaults to review_concept
//   4. Mocked LLM "partial" verdict carries concept_gaps[]
//   5. Malformed LLM response → graceful 'reroute' verdict + parse-fail reasoning
//   6. Cost-budget exception propagated as REROUTE w/ code COST_BUDGET_EXCEEDED
//   7. JSON parse robust to code-fence wrapping + leading prose + trailing chatter
//   8. Audit log appended (vault tmpdir sandbox) — exam-judge-trace.jsonl exists
//
// Bonus (regression-adjacent):
//   9. Empty input → reroute without invoking LLM
//
// Run: node app/scripts/_dev_verify_exam_judge.js
// Exit 0 = PASS N/N; non-zero = first failure halts.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshVaultRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hypha-judge-${label}-`));
  process.env.HYPHA_DATA = dir;
  for (const id of Object.keys(require.cache)) {
    if (/[\\/]app[\\/]lib[\\/](vault|exam-system)[\\/]?/.test(id)) {
      delete require.cache[id];
    }
  }
  return dir;
}

function cleanupVaultRoot(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* swallow */ }
}

let pass = 0;
let fail = 0;
const results = [];

async function t(name, fn) {
  try {
    await fn();
    pass++;
    results.push(`PASS · ${name}`);
  } catch (err) {
    fail++;
    results.push(`FAIL · ${name}\n       ${err.stack || err.message || err}`);
  }
}

function _mockExecChat(returnText) {
  return async (capability, args) => {
    assert.equal(capability, 'T4_JUDGE', 'capability must be T4_JUDGE');
    assert.ok(args && Array.isArray(args.messages), 'messages array required');
    assert.equal(args.json, true, 'json=true expected');
    return {
      result: returnText,
      providerId: 'mock-glm',
      model: 'glm-4.5-air',
      capability,
      attempts: 1,
      predicted_cost: { cny_est: 0.018, input_tokens_est: 320, output_tokens_max: 600, capability, estimation_source: 'tokenizer-fallback' },
      cost_gate: { state: 'OK', reason: 'OK' },
    };
  };
}

async function main() {
  const root = freshVaultRoot('main');
  try {
    const judge = require('../lib/exam-system/judge');

    await t('1. exports shape — judgeOpenAnswer fn + VERDICTS + SUGGESTED_NEXT', async () => {
      assert.equal(typeof judge.judgeOpenAnswer, 'function');
      assert.ok(judge.VERDICTS && judge.VERDICTS.CORRECT === 'correct');
      assert.ok(judge.VERDICTS.REROUTE === 'reroute');
      assert.ok(judge.SUGGESTED_NEXT && judge.SUGGESTED_NEXT.REVIEW_CONCEPT === 'review_concept');
      assert.equal(typeof judge._extractFirstJSON, 'function');
    });

    await t('2. correct verdict round-trip — confidence + reasoning preserved', async () => {
      const out = await judge.judgeOpenAnswer({
        question: 'Explain why Marxian alienation differs from Hegelian alienation.',
        userAnswer: 'Hegel locates alienation in Spirit returning to itself; Marx materializes it in wage labour, where workers are estranged from product, process, species-being, and each other.',
        rubric: '1) Hegel = spiritual self-recognition. 2) Marx = material 4-fold (product / process / species / fellow). 3) Distinction = substrate.',
        modelAnswer: '',
      }, {
        slug: 'philo-test',
        injectExecuteChat: _mockExecChat(JSON.stringify({
          verdict: 'correct',
          confidence: 0.91,
          reasoning: 'Covers Hegelian spiritual reading + Marx 4-fold + substrate distinction.',
          concept_gaps: [],
          suggested_next: 'advance',
        })),
      });
      assert.equal(out.verdict, 'correct');
      assert.equal(out.suggested_next, 'advance');
      assert.ok(out.confidence > 0.8);
      assert.ok(/Hegelian|Marx|4-fold/i.test(out.reasoning));
      assert.deepEqual(out.concept_gaps, []);
      assert.equal(out._meta.provider, 'mock-glm');
    });

    await t('3. incorrect verdict — defaults suggested_next to review_concept when missing', async () => {
      const out = await judge.judgeOpenAnswer({
        question: 'What is the chain rule in calculus?',
        userAnswer: 'It is when you add the derivatives together.',
        rubric: 'derivative of f(g(x)) = f\'(g(x)) * g\'(x)',
      }, {
        slug: 'calc-test',
        injectExecuteChat: _mockExecChat(JSON.stringify({
          verdict: 'incorrect',
          confidence: 0.95,
          reasoning: 'Student confused chain rule (multiplication) with sum rule (addition).',
          concept_gaps: ['复合函数', '链式法则结构'],
          // suggested_next omitted on purpose
        })),
      });
      assert.equal(out.verdict, 'incorrect');
      assert.equal(out.suggested_next, 'review_concept');
      assert.equal(out.concept_gaps.length, 2);
      assert.equal(out.concept_gaps[0], '复合函数');
    });

    await t('4. partial verdict carries concept_gaps[]', async () => {
      const out = await judge.judgeOpenAnswer({
        question: 'Derive E=mc² from special relativity postulates.',
        userAnswer: 'Mass and energy are equivalent. c is the speed of light.',
        rubric: '4-momentum invariance + low-velocity limit + relativistic energy expansion.',
      }, {
        injectExecuteChat: _mockExecChat(JSON.stringify({
          verdict: 'partial',
          confidence: 0.55,
          reasoning: 'States equivalence but no derivation path; missing 4-momentum step.',
          concept_gaps: ['4-动量不变量', '低速展开'],
          suggested_next: 'redo_exercise',
        })),
      });
      assert.equal(out.verdict, 'partial');
      assert.equal(out.suggested_next, 'redo_exercise');
      assert.equal(out.concept_gaps.length, 2);
      assert.ok(out.concept_gaps.includes('4-动量不变量'));
    });

    await t('5. malformed LLM response → graceful reroute verdict + parse-fail reasoning', async () => {
      const out = await judge.judgeOpenAnswer({
        question: 'foo',
        userAnswer: 'bar',
      }, {
        injectExecuteChat: _mockExecChat('Sure! Here is my analysis: I think the answer is partially correct but I cannot put it in JSON.'),
      });
      assert.equal(out.verdict, 'reroute');
      assert.equal(out.confidence, 0);
      assert.ok(/unparseable JSON|judge/i.test(out.reasoning), 'reroute reasoning should explain parse fail');
      assert.equal(out.suggested_next, 'review_concept');
    });

    await t('6. COST_BUDGET_EXCEEDED propagated as thrown error w/ code + judge_reroute payload', async () => {
      const budgetErr = new Error('cost predictor blocked dispatch — predicted ¥0.5 > remaining ¥0.1');
      budgetErr.code = 'COST_BUDGET_EXCEEDED';
      budgetErr.predicted = 0.5;
      budgetErr.remaining = 0.1;
      const throwingChat = async () => { throw budgetErr; };
      let caught = null;
      try {
        await judge.judgeOpenAnswer(
          { question: 'q', userAnswer: 'a' },
          { userId: 'u-cap', injectExecuteChat: throwingChat },
        );
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, 'expected throw');
      assert.equal(caught.code, 'COST_BUDGET_EXCEEDED');
      assert.ok(caught.judge_reroute, 'judge_reroute payload attached');
      assert.equal(caught.judge_reroute.verdict, 'reroute');
    });

    await t('7. JSON parse robust to code-fence wrapper + leading prose + trailing chatter', async () => {
      // Code fence wrap
      const wrapped = '```json\n{"verdict":"correct","confidence":0.8,"reasoning":"ok","concept_gaps":[],"suggested_next":"advance"}\n```';
      const out1 = await judge.judgeOpenAnswer({ question: 'q', userAnswer: 'a' }, {
        injectExecuteChat: _mockExecChat(wrapped),
      });
      assert.equal(out1.verdict, 'correct');

      // Leading prose + trailing chatter
      const messy = 'Here is my verdict for you:\n{"verdict":"partial","confidence":0.6,"reasoning":"missing step 2","concept_gaps":["step 2"],"suggested_next":"redo_exercise"}\nLet me know if you need more!';
      const out2 = await judge.judgeOpenAnswer({ question: 'q', userAnswer: 'a' }, {
        injectExecuteChat: _mockExecChat(messy),
      });
      assert.equal(out2.verdict, 'partial');
      assert.equal(out2.concept_gaps[0], 'step 2');

      // Pure JSON
      const pure = '{"verdict":"incorrect","confidence":0.99,"reasoning":"x","concept_gaps":[],"suggested_next":"review_concept"}';
      const out3 = await judge.judgeOpenAnswer({ question: 'q', userAnswer: 'a' }, {
        injectExecuteChat: _mockExecChat(pure),
      });
      assert.equal(out3.verdict, 'incorrect');
    });

    await t('8. audit log appended to vault/.hypha/exam-judge-trace.jsonl', async () => {
      // The prior cases above wrote audit rows (default audit=true). Verify file.
      const logPath = path.join(process.env.HYPHA_DATA, '.hypha', 'exam-judge-trace.jsonl');
      assert.ok(fs.existsSync(logPath), `expected ${logPath} to exist`);
      const raw = fs.readFileSync(logPath, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      assert.ok(lines.length >= 6, `expected ≥6 audit rows from prior tests, got ${lines.length}`);
      const last = JSON.parse(lines[lines.length - 1]);
      assert.ok(typeof last.verdict === 'string');
      assert.ok(typeof last.ts === 'string');
    });

    await t('9. empty input → reroute without invoking LLM (regression)', async () => {
      let called = 0;
      const tripWire = async () => { called++; throw new Error('LLM should not be called'); };
      const out = await judge.judgeOpenAnswer(
        { question: '', userAnswer: '' },
        { injectExecuteChat: tripWire },
      );
      assert.equal(called, 0, 'LLM must not fire on empty input');
      assert.equal(out.verdict, 'reroute');
      assert.ok(/required/i.test(out.reasoning));
    });
  } finally {
    cleanupVaultRoot(root);
  }

  console.log(results.join('\n'));
  console.log('\n---');
  console.log(`PASS ${pass} / ${pass + fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('SMOKE HARNESS FATAL:', err);
  process.exit(2);
});
