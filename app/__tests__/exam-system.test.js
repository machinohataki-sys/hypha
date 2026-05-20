// app/__tests__/exam-system.test.js
// W7.2 Exam System Alpha — unit tests.
//
// Coverage:
//   - scope-engine     · 4-tier scope + classifyTopic + setScope/getScope + tierProgress
//   - exam-cadence     · 4-mode time-band selector + focus/escalation + assignmentLevelRangeForMode
//   - user-bank        · CSV/JSON/MD parsers + importBank + tagItem immutability
//   - error-diagnosis  · 8-cause heuristic taxonomy + appendError/getErrorLog
//   - final-compression· enterFinalCompression + finalTasks + dailyFinalPlan validity
//
// Vault-dependent tests redirect HYPHA_DATA to an os.tmpdir() sandbox per
// suite, then clean up. Pure-function tests skip the redirect.
//
// Run: node --test app/__tests__/exam-system.test.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let test, _describe;
try {
  ({ test, describe: _describe } = require('node:test'));
} catch (_) {
  test = (_n, _fn) => {};
  test.todo = (_n) => {};
  test.skip = (_n, _fn) => {};
  _describe = (_n, fn) => (typeof fn === 'function' ? fn() : null);
}
const describe = _describe || ((_n, fn) => (typeof fn === 'function' ? fn() : null));

// ─── Vault sandbox helpers ─────────────────────────────────────────────
// Each suite that touches persistence makes a unique tmp dir + points
// HYPHA_DATA at it BEFORE requiring the SUT module so vault picks it up.

function freshVaultRoot(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hypha-exam-${label}-`));
  process.env.HYPHA_DATA = dir;
  // Clear the vault module from require cache so resolveRoot() re-reads
  // HYPHA_DATA. Also drop any cached _vault in exam-system libs.
  for (const id of Object.keys(require.cache)) {
    if (/[\\/]app[\\/]lib[\\/](vault|exam-system)[\\/]?/.test(id)) {
      delete require.cache[id];
    }
  }
  return dir;
}

function cleanupVaultRoot(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* swallow on Windows file-lock */ }
}

// ─── scope-engine ─────────────────────────────────────────────────────
describe('W7.2 · scope-engine', () => {
  const scopeEngine = require('../lib/exam-system/scope-engine');

  test('KAOYAN_ENGLISH_SCOPE has 4 tiers populated', () => {
    const s = scopeEngine.KAOYAN_ENGLISH_SCOPE;
    assert.equal(s.exam, 'kaoyan_english');
    for (const tier of ['must_master', 'high_yield', 'recognition', 'out_of_scope']) {
      assert.ok(Array.isArray(s[tier]), `tier ${tier} should be array`);
      assert.ok(s[tier].length > 0, `tier ${tier} should be non-empty`);
    }
    assert.ok(s.must_master.includes('核心词汇 5500'));
  });

  test('classifyTopic("核心词汇 5500") → must_master', () => {
    assert.equal(scopeEngine.classifyTopic('核心词汇 5500'), 'must_master');
  });

  test('classifyTopic("口语") → out_of_scope', () => {
    assert.equal(scopeEngine.classifyTopic('口语'), 'out_of_scope');
  });

  test('classifyTopic("unknown random string") → out_of_scope', () => {
    assert.equal(scopeEngine.classifyTopic('zzz qqq xxx 此字符串绝对未在 seed 中'), 'out_of_scope');
    // Edge: empty / non-string → out_of_scope (defensive default).
    assert.equal(scopeEngine.classifyTopic(''), 'out_of_scope');
    assert.equal(scopeEngine.classifyTopic(null), 'out_of_scope');
  });

  test('setScope + getScope round-trip preserves arrays', () => {
    const root = freshVaultRoot('scope-rt');
    try {
      const eng = require('../lib/exam-system/scope-engine');
      const custom = {
        exam: 'custom_test',
        display: '自定测试',
        must_master: ['A', 'B', 'C'],
        high_yield: ['D'],
        recognition: [],
        out_of_scope: ['X', 'Y'],
      };
      const written = eng.setScope('exam-rt-slug', custom);
      assert.deepEqual(written.must_master, ['A', 'B', 'C']);
      assert.equal(written.high_yield.length, 1);
      const got = eng.getScope('exam-rt-slug');
      assert.deepEqual(got.must_master, ['A', 'B', 'C']);
      assert.deepEqual(got.out_of_scope, ['X', 'Y']);
      assert.equal(got.display, '自定测试');
    } finally {
      cleanupVaultRoot(root);
    }
  });

  test('tierProgress(slug, []) → 0 for all tiers', () => {
    const root = freshVaultRoot('scope-tp');
    try {
      const eng = require('../lib/exam-system/scope-engine');
      const prog = eng.tierProgress('tp-slug', []);
      for (const tier of ['must_master', 'high_yield', 'recognition', 'out_of_scope']) {
        assert.equal(prog[tier], 0, `${tier} should be 0`);
      }
      assert.equal(prog.total.completed_count, 0);
      assert.ok(prog.total.total_scope_items > 0, 'default seed has items');
      // Edge: partial completion lifts the fraction.
      const partial = eng.tierProgress('tp-slug', ['核心词汇 5500']);
      assert.ok(partial.must_master > 0, 'one hit raises must_master fraction');
      assert.ok(partial.must_master < 1, 'one hit < full');
    } finally {
      cleanupVaultRoot(root);
    }
  });
});

// ─── exam-cadence ─────────────────────────────────────────────────────
describe('W7.2 · exam-cadence', () => {
  const cadence = require('../lib/exam-system/exam-cadence');

  test('daysRemaining=5 → mode=final', () => {
    const r = cadence.computeExamCadence({ daysRemaining: 5 });
    assert.equal(r.mode, 'final');
    assert.equal(r.lesson_split.new, 0, 'final stops new lessons');
    assert.ok(r.lesson_split.review > 0);
  });

  test('daysRemaining=14 → mode=compression', () => {
    const r = cadence.computeExamCadence({ daysRemaining: 14 });
    assert.equal(r.mode, 'compression');
    assert.ok(r.lesson_split.drill >= 30, 'compression drills heavily');
  });

  test('daysRemaining=45 → mode=consolidation', () => {
    const r = cadence.computeExamCadence({ daysRemaining: 45 });
    assert.equal(r.mode, 'consolidation');
  });

  test('daysRemaining=120 → mode=expansion', () => {
    const r = cadence.computeExamCadence({ daysRemaining: 120 });
    assert.equal(r.mode, 'expansion');
    assert.ok(r.lesson_split.new >= 50, 'expansion is new-heavy');
  });

  test('expansion + must_master<0.5 → focus=NEW_MUST_MASTER', () => {
    const r = cadence.computeExamCadence({
      daysRemaining: 120,
      currentScopeProgress: { must_master: 0.2 },
    });
    assert.equal(r.mode, 'expansion');
    assert.equal(r.focus, 'new_must_master');
    assert.ok(
      r.escalations.some((m) => /must_master/.test(m)),
      'escalation mentions must_master',
    );
    // Edge: must_master ≥ 0.7 → flip to NEW_HIGH_YIELD.
    const r2 = cadence.computeExamCadence({
      daysRemaining: 120,
      currentScopeProgress: { must_master: 0.85 },
    });
    assert.equal(r2.focus, 'new_high_yield');
  });

  test('consolidation + errorAcc>=20 → focus=ERROR_DRILL', () => {
    const r = cadence.computeExamCadence({
      daysRemaining: 45,
      errorAccumulation: 25,
    });
    assert.equal(r.mode, 'consolidation');
    assert.equal(r.focus, 'error_drill');
    // Edge: errorAcc < 20 stays on default focus.
    const r2 = cadence.computeExamCadence({
      daysRemaining: 45,
      errorAccumulation: 5,
    });
    assert.notEqual(r2.focus, 'error_drill');
  });

  test('assignmentLevelRangeForMode(final) = {min:1,max:1}', () => {
    const r = cadence.assignmentLevelRangeForMode('final');
    assert.equal(r.min, 1);
    assert.equal(r.max, 1);
    // Edge: each mode returns a sensible range.
    assert.deepEqual(
      [
        cadence.assignmentLevelRangeForMode('compression').min,
        cadence.assignmentLevelRangeForMode('consolidation').min,
        cadence.assignmentLevelRangeForMode('expansion').min,
      ],
      [2, 2, 3],
    );
  });
});

// ─── user-bank ────────────────────────────────────────────────────────
describe('W7.2 · user-bank', () => {
  const userBank = require('../lib/exam-system/user-bank');

  test('parseBankContent CSV roundtrip with quoted commas', () => {
    const csv = [
      'question,answer,topic,tier',
      '"What, exactly, is X?","It, is Y","核心词汇","must_master"',
      'Plain Q,Plain A,topic2,high_yield',
    ].join('\n');
    const items = userBank.parseBankContent({ format: 'csv', content: csv });
    assert.equal(items.length, 2);
    assert.equal(items[0].question, 'What, exactly, is X?');
    assert.equal(items[0].answer, 'It, is Y');
    assert.equal(items[0].topic, '核心词汇');
    assert.equal(items[0].tier, 'must_master');
    assert.equal(items[1].question, 'Plain Q');
  });

  test('parseBankContent JSON top-array works', () => {
    const arr = [
      { question: 'Q1', answer: 'A1', topic: 't1' },
      { q: 'Q2', a: 'A2' }, // alias fields
    ];
    const items = userBank.parseBankContent({ format: 'json', content: JSON.stringify(arr) });
    assert.equal(items.length, 2);
    assert.equal(items[0].question, 'Q1');
    assert.equal(items[1].question, 'Q2');
    assert.equal(items[1].answer, 'A2');
    // Edge: { items: [...] } wrapper also works.
    const wrapped = userBank.parseBankContent({
      format: 'json',
      content: JSON.stringify({ items: [{ question: 'wrapped' }] }),
    });
    assert.equal(wrapped.length, 1);
    assert.equal(wrapped[0].question, 'wrapped');
  });

  test('parseBankContent MD block format extracts Q + A', () => {
    const md = [
      '### Q: 第一题是什么',
      'A: 答案一',
      'Topic: 阅读',
      'Tier: must_master',
      '',
      '### Q: 第二题',
      'A: 答案二',
      'Options: a | b | c',
    ].join('\n');
    const items = userBank.parseBankContent({ format: 'md', content: md });
    assert.equal(items.length, 2);
    assert.equal(items[0].question, '第一题是什么');
    assert.equal(items[0].answer, '答案一');
    assert.equal(items[0].tier, 'must_master');
    assert.equal(items[1].question, '第二题');
    assert.deepEqual(items[1].options, ['a', 'b', 'c']);
  });

  test('importBank persists items array', () => {
    const root = freshVaultRoot('bank-import');
    try {
      const ub = require('../lib/exam-system/user-bank');
      const result = ub.importBank('bank-slug', {
        name: 'fixture-bank',
        format: 'json',
        content: JSON.stringify([
          { question: 'Q1', answer: 'A1' },
          { question: 'Q2', answer: 'A2' },
        ]),
      });
      assert.equal(result.ok, true);
      assert.equal(result.item_count, 2);
      assert.ok(result.bank_id);
      // Verify the file landed on disk.
      const persistedPath = path.join(root, 'bank-slug', 'exam', 'bank', `${result.bank_id}.json`);
      assert.ok(fs.existsSync(persistedPath), 'bank file persisted');
      const persisted = JSON.parse(fs.readFileSync(persistedPath, 'utf-8'));
      assert.equal(persisted.items.length, 2);
      assert.equal(persisted.items[0].question, 'Q1');
      // listBanks finds it back.
      const list = ub.listBanks('bank-slug');
      assert.equal(list.length, 1);
      assert.equal(list[0].item_count, 2);
    } finally {
      cleanupVaultRoot(root);
    }
  });

  test('tagItem patches tier immutably', () => {
    const root = freshVaultRoot('bank-tag');
    try {
      const ub = require('../lib/exam-system/user-bank');
      const imp = ub.importBank('tag-slug', {
        name: 'tag-bank',
        format: 'json',
        content: JSON.stringify([{ question: 'Q', answer: 'A', tier: 'must_master' }]),
      });
      const before = ub.getBankItem('tag-slug', imp.bank_id, 0);
      const patched = ub.tagItem('tag-slug', imp.bank_id, 0, {
        tier: 'high_yield',
        topic: 'new-topic',
      });
      assert.equal(patched.tier, 'high_yield');
      assert.equal(patched.topic, 'new-topic');
      // Original returned reference is unchanged (immutability check).
      assert.equal(before.tier, 'must_master');
      // Re-read confirms persistence.
      const reread = ub.getBankItem('tag-slug', imp.bank_id, 0);
      assert.equal(reread.tier, 'high_yield');
      assert.equal(reread.topic, 'new-topic');
      // Answer + question untouched.
      assert.equal(reread.question, 'Q');
      assert.equal(reread.answer, 'A');
    } finally {
      cleanupVaultRoot(root);
    }
  });
});

// ─── error-diagnosis ──────────────────────────────────────────────────
describe('W7.2 · error-diagnosis', () => {
  const ed = require('../lib/exam-system/error-diagnosis');

  test('ERROR_CAUSES has 8 entries (per BLUEPRINT §13.3)', () => {
    const causes = Object.values(ed.ERROR_CAUSES);
    assert.equal(causes.length, 8, '8 causes per BLUEPRINT §13.3');
    // Each cause has a repair strategy.
    for (const c of causes) {
      assert.ok(ed.REPAIR_STRATEGY[c], `repair strategy missing for ${c}`);
    }
  });

  test('diagnoseError context="超时" → cause=timeout', () => {
    const d = ed.diagnoseError({
      question: '随便一道题',
      userAnswer: 'a',
      correctAnswer: 'b',
      context: '超时未做完',
    });
    assert.equal(d.cause, 'timeout');
    assert.equal(d.severity, 'high');
    assert.ok(d.repair_strategy.length > 0);
    assert.equal(d.mock, true, 'marked mock until T4_JUDGE wired');
  });

  test('diagnoseError question="作者态度" → cause=tone', () => {
    const d = ed.diagnoseError({
      question: '作者态度如何',
      userAnswer: 'positive',
      correctAnswer: 'critical',
    });
    assert.equal(d.cause, 'tone');
    // Edge: invalid input returns vocab fallback.
    const bad = ed.diagnoseError(null);
    assert.equal(bad.cause, 'vocab');
    assert.equal(bad.mock, true);
  });

  test('appendError + getErrorLog reverse-chrono', () => {
    const root = freshVaultRoot('err-log');
    try {
      const edFresh = require('../lib/exam-system/error-diagnosis');
      const slug = 'err-slug';
      const r1 = edFresh.appendError(slug, {
        question_ref: 'lesson-1#q3',
        user_answer: 'a',
        correct_answer: 'b',
        error_class: 'vocab',
        severity: 'low',
        ts: '2026-05-15T10:00:00.000Z',
      });
      const r2 = edFresh.appendError(slug, {
        question_ref: 'lesson-2#q5',
        user_answer: 'x',
        correct_answer: 'y',
        error_class: 'tone',
        severity: 'medium',
        ts: '2026-05-16T10:00:00.000Z',
      });
      assert.ok(r1.ok && r2.ok);
      const log = edFresh.getErrorLog(slug);
      assert.equal(log.length, 2);
      // Most recent (r2) should be first.
      assert.equal(log[0].question_ref, 'lesson-2#q5');
      assert.equal(log[1].question_ref, 'lesson-1#q3');
      // Edge: limit caps the result.
      const limited = edFresh.getErrorLog(slug, 1);
      assert.equal(limited.length, 1);
      assert.equal(limited[0].question_ref, 'lesson-2#q5');
    } finally {
      cleanupVaultRoot(root);
    }
  });
});

// ─── final-compression ────────────────────────────────────────────────
describe('W7.2 · final-compression', () => {
  test('enterFinalCompression writes final-state.json', () => {
    const root = freshVaultRoot('fc-enter');
    try {
      const fc = require('../lib/exam-system/final-compression');
      const slug = 'fc-slug';
      const r = fc.enterFinalCompression(slug);
      assert.equal(r.ok, true);
      assert.equal(r.mode, 'final');
      assert.ok(r.entered_at);
      // File landed.
      const statePath = path.join(root, slug, 'exam', 'final-state.json');
      assert.ok(fs.existsSync(statePath));
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      assert.equal(state.mode, 'final');
      assert.equal(state.stop_new_topics, true);
      // getFinalState reads it back.
      const read = fc.getFinalState(slug);
      assert.equal(read.mode, 'final');
    } finally {
      cleanupVaultRoot(root);
    }
  });

  test('finalTasks returns 5 buckets', () => {
    const root = freshVaultRoot('fc-tasks');
    try {
      const fc = require('../lib/exam-system/final-compression');
      const buckets = fc.finalTasks('ft-slug');
      assert.equal(buckets.length, 5);
      const types = buckets.map((b) => b.type).sort();
      assert.deepEqual(types, [
        'compress_essay_templates',
        'light_mock',
        'review_errors',
        'review_high_freq',
        'time_limited_practice',
      ]);
      // Each bucket has type/display/items.
      for (const b of buckets) {
        assert.ok(typeof b.type === 'string');
        assert.ok(typeof b.display === 'string');
        assert.ok(Array.isArray(b.items));
      }
      // review_high_freq pulls from default 考研英语 must_master seed.
      const highFreq = buckets.find((b) => b.type === 'review_high_freq');
      assert.ok(highFreq.items.length > 0, 'must_master seed populates high_freq');
    } finally {
      cleanupVaultRoot(root);
    }
  });

  test('dailyFinalPlan(slug, 5) → 5 rows', () => {
    const root = freshVaultRoot('fc-plan-5');
    try {
      const fc = require('../lib/exam-system/final-compression');
      const r = fc.dailyFinalPlan('plan-slug', 5);
      assert.equal(r.valid, true);
      assert.equal(r.plan.length, 5, 'd=5 → 5 rows (D-5..D-1)');
      // day_offsets are -5..-1 ascending.
      const offsets = r.plan.map((p) => p.day_offset).sort((a, b) => a - b);
      assert.deepEqual(offsets, [-5, -4, -3, -2, -1]);
      // primary task type populated.
      for (const row of r.plan) {
        assert.ok(row.primary && row.primary.type);
        assert.ok(typeof row.days_until_exam === 'number');
      }
    } finally {
      cleanupVaultRoot(root);
    }
  });

  test('dailyFinalPlan(slug, 8) → valid=false (not yet final)', () => {
    const root = freshVaultRoot('fc-plan-8');
    try {
      const fc = require('../lib/exam-system/final-compression');
      const r = fc.dailyFinalPlan('plan-slug-2', 8);
      assert.equal(r.valid, false);
      assert.ok(/final compression/.test(r.message || ''), 'message mentions final compression');
      // Edge: negative days → also invalid.
      const bad = fc.dailyFinalPlan('plan-slug-2', -1);
      assert.equal(bad.valid, false);
    } finally {
      cleanupVaultRoot(root);
    }
  });
});
