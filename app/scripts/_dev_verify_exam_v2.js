#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_exam_v2 — v2-push-b2 smoke for Exam System extensions.
//
// Covers (12 tests):
//   1.  judge — 4-axis structure present with correct keys + clamped 0..1
//   2.  judge — aggregate_score weighted by AXIS_WEIGHTS (correctness dominant)
//   3.  judge — back-compat: missing axes → synthesized from confidence
//   4.  judge — out-of-range axis values clamped + non-numeric defaulted
//   5.  scope-engine — recordTierAttempt accumulates history (cap 16)
//   6.  scope-engine — shouldShrinkScope fires at 3 consecutive fails
//   7.  scope-engine — applyScopeShrink demotes failing tier to prerequisites
//   8.  scope-engine — resetTierAttempts clears history (no spurious shrink)
//   9.  final-compression — weightedDailyPlan reassigns slots by failure rate
//  10.  final-compression — uniform rates → ~uniform slot allocation
//  11.  user-bank — strict rejects missing answer field with row index
//  12.  user-bank — strict rejects answer not in options (ambiguous correct)
//  13.  user-bank — strict accepts well-formed bank w/ matching answer
//  14.  user-bank — strict rejects duplicate option (ambiguous correct option)
//
// Run: node app/scripts/_dev_verify_exam_v2.js
// Exit 0 = PASS N/N; non-zero = first failure halts.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function freshVaultRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hypha-exam-v2-${label}-`));
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

function mockChat(text) {
  return async (capability, args) => {
    assert.equal(capability, 'T4_JUDGE');
    assert.ok(args && Array.isArray(args.messages));
    return {
      result: text,
      providerId: 'mock-v2',
      model: 'glm-test',
      capability,
      attempts: 1,
      predicted_cost: { cny_est: 0.01 },
      cost_gate: { state: 'OK' },
    };
  };
}

async function main() {
  const root = freshVaultRoot('main');
  try {
    const judge = require('../lib/exam-system/judge');
    const scope = require('../lib/exam-system/scope-engine');
    const compress = require('../lib/exam-system/final-compression');
    const bank = require('../lib/exam-system/user-bank');

    // ─── JUDGE: 4-axis ─────────────────────────────────────────────────
    await t('1. judge — 4-axis structure with all required keys + clamped', async () => {
      const out = await judge.judgeOpenAnswer(
        { question: 'q', userAnswer: 'a', rubric: 'r' },
        {
          injectExecuteChat: mockChat(JSON.stringify({
            verdict: 'correct',
            confidence: 0.9,
            axes: { correctness: 0.95, clarity: 0.8, depth: 0.7, register_match: 0.85 },
            reasoning: 'covers all rubric pts',
            concept_gaps: [],
            suggested_next: 'advance',
          })),
        },
      );
      assert.ok(out.axes, 'axes must exist');
      for (const k of ['correctness', 'clarity', 'depth', 'register_match']) {
        assert.ok(typeof out.axes[k] === 'number', `axis ${k} numeric`);
        assert.ok(out.axes[k] >= 0 && out.axes[k] <= 1, `axis ${k} in [0,1]`);
      }
      assert.equal(out.axes.correctness, 0.95);
      assert.equal(out._meta.axes_synthesized, false);
    });

    await t('2. judge — aggregate_score weighted (correctness=0.5 dominant)', async () => {
      const out = await judge.judgeOpenAnswer(
        { question: 'q', userAnswer: 'a' },
        {
          injectExecuteChat: mockChat(JSON.stringify({
            verdict: 'correct',
            confidence: 0.8,
            axes: { correctness: 1.0, clarity: 0.0, depth: 0.0, register_match: 0.0 },
            reasoning: 'rubric exact',
            suggested_next: 'advance',
          })),
        },
      );
      // 1.0 * 0.5 + 0 + 0 + 0 = 0.5 exactly.
      assert.ok(Math.abs(out.aggregate_score - 0.5) < 1e-9,
        `expected aggregate ≈ 0.5, got ${out.aggregate_score}`);
      // Verify pure helpers
      const agg = judge._aggregateAxes({ correctness: 0, clarity: 1, depth: 1, register_match: 1 });
      // 0*0.5 + 1*0.15 + 1*0.2 + 1*0.15 = 0.5
      assert.ok(Math.abs(agg - 0.5) < 1e-9, `weights sum check: ${agg}`);
      const sum = Object.values(judge.AXIS_WEIGHTS).reduce((s, w) => s + w, 0);
      assert.ok(Math.abs(sum - 1.0) < 1e-9, `weights total ${sum} ≠ 1.0`);
    });

    await t('3. judge — back-compat: missing axes synthesized from confidence', async () => {
      const out = await judge.judgeOpenAnswer(
        { question: 'q', userAnswer: 'a' },
        {
          injectExecuteChat: mockChat(JSON.stringify({
            verdict: 'partial',
            confidence: 0.6,
            // axes intentionally absent
            reasoning: 'half-right',
            suggested_next: 'redo_exercise',
          })),
        },
      );
      assert.equal(out._meta.axes_synthesized, true);
      for (const k of ['correctness', 'clarity', 'depth', 'register_match']) {
        assert.equal(out.axes[k], 0.6, `${k} should mirror confidence`);
      }
      // aggregate == confidence when all axes equal.
      assert.ok(Math.abs(out.aggregate_score - 0.6) < 1e-9);
    });

    await t('4. judge — out-of-range axis clamped + non-numeric defaulted', async () => {
      const out = await judge.judgeOpenAnswer(
        { question: 'q', userAnswer: 'a' },
        {
          injectExecuteChat: mockChat(JSON.stringify({
            verdict: 'correct',
            confidence: 0.7,
            axes: { correctness: 1.5, clarity: -0.3, depth: 'high', register_match: null },
            reasoning: 'r',
            suggested_next: 'advance',
          })),
        },
      );
      assert.equal(out.axes.correctness, 1, 'over-1 clamped');
      assert.equal(out.axes.clarity, 0, 'sub-0 clamped');
      assert.equal(out.axes.depth, 0.5, 'non-numeric → fallback 0.5');
      // null falls back to confidence (0.7) via _coerceAxes
      assert.equal(out.axes.register_match, 0.7);
    });

    // ─── SCOPE ENGINE: adaptive shrink ─────────────────────────────────
    await t('5. scope — recordTierAttempt accumulates + caps history at 16', async () => {
      const slug = 'shrink-test-1';
      for (let i = 0; i < 20; i++) {
        scope.recordTierAttempt(slug, 'high_yield', i % 2 === 0);
      }
      const directive = scope.shouldShrinkScope(slug);
      // last attempt: i=19 → 19%2=1 → false. consecutive_fails should be 0.
      assert.equal(directive.shrink, false);
      // Verify history capped via direct file read.
      const fp = path.join(process.env.HYPHA_DATA, slug, 'exam', 'tier-attempts.json');
      const persisted = JSON.parse(fs.readFileSync(fp, 'utf8'));
      assert.ok(persisted.tiers.high_yield.recent.length <= 16);
    });

    await t('6. scope — shouldShrinkScope fires at 3 consecutive fails on high_yield', async () => {
      const slug = 'shrink-test-2';
      scope.recordTierAttempt(slug, 'high_yield', true);
      let d = scope.shouldShrinkScope(slug);
      assert.equal(d.shrink, false, '1 fail must not trip');
      scope.recordTierAttempt(slug, 'high_yield', true);
      d = scope.shouldShrinkScope(slug);
      assert.equal(d.shrink, false, '2 fails must not trip');
      const after3 = scope.recordTierAttempt(slug, 'high_yield', true);
      assert.equal(after3.consecutive_fails, 3);
      d = scope.shouldShrinkScope(slug);
      assert.equal(d.shrink, true, '3 fails must trip');
      assert.equal(d.tier, 'high_yield');
      assert.ok(Array.isArray(d.retreat_to));
      assert.ok(d.retreat_to.includes('must_master'));
    });

    await t('7. scope — applyScopeShrink demotes failing tier into prerequisite', async () => {
      const slug = 'shrink-test-3';
      // Custom scope: high_yield has 2 items.
      scope.setScope(slug, {
        exam: 'custom', display: 'test',
        must_master: ['必学A', '必学B'],
        high_yield: ['拓展X', '拓展Y'],
        recognition: ['冷门Z'],
        out_of_scope: [],
      });
      // Trigger shrink.
      for (let i = 0; i < 3; i++) scope.recordTierAttempt(slug, 'high_yield', true);
      const result = scope.applyScopeShrink(slug);
      assert.equal(result.shrunk, true);
      assert.equal(result.scope.high_yield.length, 0, 'high_yield drained');
      // Items demoted into must_master.
      assert.ok(result.scope.must_master.includes('拓展X'));
      assert.ok(result.scope.must_master.includes('拓展Y'));
      assert.equal(result.scope.shrunk_from, 'high_yield');
    });

    await t('8. scope — resetTierAttempts clears history (no spurious shrink)', async () => {
      const slug = 'shrink-test-4';
      for (let i = 0; i < 3; i++) scope.recordTierAttempt(slug, 'recognition', true);
      let d = scope.shouldShrinkScope(slug);
      assert.equal(d.shrink, true);
      scope.resetTierAttempts(slug, 'recognition');
      d = scope.shouldShrinkScope(slug);
      assert.equal(d.shrink, false, 'shrink cleared after reset');
    });

    // ─── FINAL COMPRESSION: adaptive plan ──────────────────────────────
    await t('9. compression — weighted plan reallocates slots by failure rate', async () => {
      const slug = 'plan-test-1';
      scope.setScope(slug, {
        exam: 'custom', display: 'test',
        must_master: ['核心', '阅读题型', '作文模板基础'],
        high_yield: [], recognition: [], out_of_scope: [],
      });
      // Heavy errors → review_errors should win majority of slots.
      const result = compress.weightedDailyPlan(slug, 7, {
        review_errors: 0.9,
        review_high_freq: 0.1,
        compress_essay_templates: 0.05,
        time_limited_practice: 0.05,
        light_mock: 0.0,
      });
      assert.equal(result.valid, true);
      assert.ok(result.slot_allocation.review_errors >
        result.slot_allocation.compress_essay_templates,
        'high-failure topic should earn more slots');
      // Total slots = days * 2 = 14.
      const total = Object.values(result.slot_allocation).reduce((s, n) => s + n, 0);
      assert.equal(total, 14);
      // Each task type floored at 1.
      for (const v of Object.values(result.slot_allocation)) {
        assert.ok(v >= 1, 'every task type gets ≥1 slot floor');
      }
      // Plan length = 7 days.
      assert.equal(result.plan.length, 7);
    });

    await t('10. compression — uniform rates → ~uniform slot allocation', async () => {
      const slug = 'plan-test-2';
      scope.setScope(slug, {
        exam: 'custom', display: 'test',
        must_master: [], high_yield: [], recognition: [], out_of_scope: [],
      });
      const r = compress.weightedDailyPlan(slug, 5, {});
      const slots = Object.values(r.slot_allocation);
      const total = slots.reduce((s, n) => s + n, 0);
      assert.equal(total, 10, '5 days × 2 = 10 slots');
      // Empty rates → uniform fallback distribution: 5 floor + 5 evenly spread.
      const min = Math.min(...slots);
      const max = Math.max(...slots);
      assert.ok(max - min <= 1, `uniform when no signal: spread ${min}..${max}`);
    });

    // ─── USER BANK: validation hardening ───────────────────────────────
    await t('11. bank — strict rejects missing answer field with row index', async () => {
      const csv = 'question,answer\n"What is 2+2?",4\n"What is 3+3?",\n"What is 4+4?",8\n';
      let caught = null;
      try {
        bank.parseBankContent({ format: 'csv', content: csv, strict: true });
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, 'expected ImportValidationError');
      assert.equal(caught.code, 'BANK_VALIDATION_FAILED');
      assert.ok(Array.isArray(caught.validation_errors));
      const msg = caught.validation_errors.join(' ');
      assert.ok(/row 2/i.test(msg) || /row 3/i.test(msg),
        `error should cite row index, got: ${msg}`);
      assert.ok(/missing answer/i.test(msg));
    });

    await t('12. bank — strict rejects answer not present in options', async () => {
      const items = {
        items: [{
          question: 'Capital of France?',
          answer: 'Berlin',
          options: ['Paris', 'London', 'Madrid'],
        }],
      };
      let caught = null;
      try {
        bank.parseBankContent({ format: 'json', content: JSON.stringify(items), strict: true });
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, 'expected validation throw');
      assert.equal(caught.code, 'BANK_VALIDATION_FAILED');
      const msg = caught.validation_errors.join(' ');
      assert.ok(/not found in options/i.test(msg), `got: ${msg}`);
    });

    await t('13. bank — strict accepts well-formed bank (positive case)', async () => {
      const items = {
        items: [
          { question: 'Q1', answer: 'A1' },
          { question: 'Q2', answer: 'Paris', options: ['Paris', 'London'] },
          { question: 'Q3', answer: 'B', options: ['Apple', 'Banana', 'Cherry'] },
        ],
      };
      const out = bank.parseBankContent({
        format: 'json',
        content: JSON.stringify(items),
        strict: true,
      });
      assert.equal(out.length, 3);
      assert.equal(out[0].question, 'Q1');
      assert.equal(out[2].answer, 'B');
    });

    await t('14. bank — strict rejects duplicate option (ambiguous correct)', async () => {
      const items = {
        items: [{
          question: 'Which letter?',
          answer: 'A',
          options: ['Apple', 'Apple', 'Cherry'],
        }],
      };
      let caught = null;
      try {
        bank.parseBankContent({ format: 'json', content: JSON.stringify(items), strict: true });
      } catch (e) {
        caught = e;
      }
      assert.ok(caught, 'expected duplicate-option rejection');
      const msg = caught.validation_errors.join(' ');
      assert.ok(/duplicate option/i.test(msg) || /ambiguous/i.test(msg), `got: ${msg}`);
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
