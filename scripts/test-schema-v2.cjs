'use strict';

// Test harness for app/lib/lesson-schema-v2.js (4 cases).
// Run: node scripts/test-schema-v2.cjs

const path = require('path');
const { validateLessonV2 } = require(path.join(__dirname, '..', 'app', 'lib', 'lesson-schema-v2.js'));

// Build a minimal-valid lesson body that passes all 11 field rules.
function buildMinimalValid() {
  return {
    objective: 'Learner can explain Goal Contract in 1 sentence.',
    prerequisite_check: null,
    hook_concrete: 'You said "I want to learn ML in a month." That sentence is the seed of a Goal Contract.',
    human_explanation:
      'A Goal Contract is the structured statement of what you actually want, why it matters, and how you will know you got there. It is not a vague wish; it is a checkable target with a deadline and a binding signal.',
    mechanism:
      'Without a contract, every lesson drifts toward whatever the model finds easy to talk about. The contract anchors selection of every concept to one declared end-state.',
    required_terms: [
      { term: 'Goal Contract', plain_definition: '一份你跟自己签的字据，写清楚目标、期限、判分标准。' },
    ],
    examples: [
      'A learner says: "30 days, ship a Kaggle notebook with AUC>=0.7 on Titanic." That string IS a Goal Contract candidate.',
    ],
    common_misconceptions: [
      {
        wrong: 'Goal Contract = a long syllabus.',
        why_wrong: 'Syllabus lists topics; contract states a checkable end-state.',
        correct: 'Contract is one end-state + deadline + signal; topics are derived from it.',
      },
    ],
    note_pack_connections: [
      { ref_type: 'note', ref_id: 'lesson-01', why_relevant: 'Establishes the same target sentence pattern.' },
    ],
    product_transfer: { triggered: false, suggestion: null },
    micro_proof: {
      stimulus: 'Write your own one-sentence Goal Contract for the next 30 days.',
      expected_signal: 'Sentence contains a deadline AND a checkable signal (number, artifact, or audience).',
      fail_mode: 'Sentence has only a topic ("learn ML") with no deadline and no signal.',
    },
    next_lesson_seed: 'Why most goals collapse without a binding signal.',
  };
}

function run(label, lesson, predicate) {
  const errors = validateLessonV2(lesson);
  const ok = predicate(errors);
  const sample = errors.slice(0, 3).map((e) => '    - ' + e).join('\n');
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`);
  console.log(`    error count: ${errors.length}`);
  if (errors.length > 0) console.log(sample);
  return ok;
}

const results = [];

// Case 1: minimal-valid -> 0 errors.
results.push(run('case1 minimal-valid', buildMinimalValid(), (errs) => errs.length === 0));

// Case 2: missing-mechanism (mechanism = "") -> >=1 error mentioning mechanism.
{
  const lesson = buildMinimalValid();
  lesson.mechanism = '';
  results.push(
    run('case2 empty-mechanism', lesson, (errs) =>
      errs.length >= 1 && errs.some((e) => e.toLowerCase().includes('mechanism'))
    )
  );
}

// Case 3: bad-misconceptions (drop 'correct' from 1 entry) -> >=1 error.
{
  const lesson = buildMinimalValid();
  const bad = { wrong: 'X', why_wrong: 'Y' };
  lesson.common_misconceptions = [bad];
  results.push(
    run('case3 misconception-missing-correct', lesson, (errs) =>
      errs.length >= 1 && errs.some((e) => e.includes('common_misconceptions') && e.includes('correct'))
    )
  );
}

// Case 4: triggered-without-suggestion -> exactly 1 error on product_transfer.suggestion.
{
  const lesson = buildMinimalValid();
  lesson.product_transfer = { triggered: true, suggestion: null };
  results.push(
    run('case4 triggered-without-suggestion', lesson, (errs) => {
      const productTransferErrs = errs.filter((e) => e.startsWith('product_transfer'));
      return productTransferErrs.length === 1 && productTransferErrs[0].includes('triggered=true');
    })
  );
}

const passed = results.filter(Boolean).length;
const total = results.length;
console.log(`\n=== ${passed}/${total} passed ===`);
process.exit(passed === total ? 0 : 1);
