// V0.5 E0 — seed 12 philosophy golden candidates
//
// Generates draft golden items for vault/.evaluator/golden/philosophy/.
// Each item ships with `lifecycle: 'draft'` + null raters. User + 2nd rater fill
// rater_a / rater_b verdicts via app/scripts/label-cli.js.
//
// Sequence anchored on MIT OCW 24.00 + Yale OYC PHIL 181 syllabus order — pre-Socratics
// FIRST, then Socrates / Plato / Aristotle / Stoics / Descartes / Hume / Kant. Per memory
// project_hypha_v021_failure_galileo (LLM training-frequency biased toward Galileo over
// Thales; Layer 1 syllabus extraction = E0 launch blocker).
//
// Run: node app/scripts/seed-philosophy-golden.js
// Idempotent: skips items whose JSON already exists.

'use strict';

const fs = require('fs');
const path = require('path');
const sealed = require('../lib/evaluator/verification-channels/sealed-rubric');

const TARGET_DIR = path.join(__dirname, '..', '..', 'vault', '.evaluator', 'golden', 'philosophy');

const ITEMS = [
  {
    id: 'philosophy-001',
    syllabus_anchor: 'MIT OCW 24.00 wk1 — Pre-Socratic substance question',
    instance: 'Thales claimed water is the first principle of all things. State the SINGLE structural feature of his claim that distinguishes it from a religious explanation, and give one observable phenomenon that would falsify it as a literal claim about substance.',
    answer_plaintext: 'Reduction to one natural substrate (single material first principle, no appeal to gods); falsified by observing a thing that retains its identity through dehydration to zero water content.',
  },
  {
    id: 'philosophy-002',
    syllabus_anchor: 'MIT OCW 24.00 wk1 — Heraclitus flux',
    instance: 'Heraclitus says you cannot step into the same river twice. Restate this in modern terms by naming the conserved quantity (if any) and the variant quantity, then give one engineered system where this distinction is operationally tracked.',
    answer_plaintext: 'Identity (form / pattern) is conserved as a continuous trajectory; matter (the water) is the variant. Engineered example: a hash-versioned database where row identity persists across edits while content mutates.',
  },
  {
    id: 'philosophy-003',
    syllabus_anchor: 'Yale OYC PHIL 181 — Parmenides on being',
    instance: 'Parmenides argued that change is impossible because what-is cannot become what-is-not. Construct one analogy from physics or computer science where his deductive structure holds, and one where it fails. Explain which premise breaks in the failing case.',
    answer_plaintext: 'Holds in conservation of mass-energy in a closed system. Fails in branch prediction misspeculation where state computed but discarded counts as having existed and not-existed; the breaking premise is treating what-is as a static binary rather than a function over time.',
  },
  {
    id: 'philosophy-004',
    syllabus_anchor: 'MIT OCW 24.00 wk2 — Socratic elenchus',
    instance: 'In Plato Euthyphro, Socrates derives a contradiction from Euthyphro definition of piety. Reconstruct the elenchus in three steps without using the word "pious" in your reconstruction; substitute a generic predicate P. State the form of the contradiction.',
    answer_plaintext: 'Step 1 Euthyphro asserts P-things are P because the gods love them. Step 2 Socrates asks whether the gods love them because they are P, or whether they are P because the gods love them. Step 3 both horns yield contradiction: the first horn makes P prior to god-love (collapsing the definition); the second horn makes P arbitrary (failing the demand for an essence). The form is dilemma horn-collapse.',
  },
  {
    id: 'philosophy-005',
    syllabus_anchor: 'MIT OCW 24.00 wk3 — Plato Forms',
    instance: 'Plato theory of Forms claims that particulars participate in universal Forms. Specify one observable consequence of this theory that would distinguish it from nominalism (the view that universals are names only), and explain why two thousand years of debate has not settled the question.',
    answer_plaintext: 'Predicted consequence: discovery of intrinsic structure unifying disparate instances (e.g., a mathematical law that holds across observed cases without exception, suggesting non-physical constraint). The debate persists because both theories make identical empirical predictions; the disagreement is metaphysical, not falsifiable by current methods.',
  },
  {
    id: 'philosophy-006',
    syllabus_anchor: 'Yale OYC PHIL 181 — Aristotle four causes',
    instance: 'Apply Aristotle four causes (material, formal, efficient, final) to a software function. For a recursive Fibonacci implementation, state each cause concretely. Then identify which cause modern engineering treats as decorative and why.',
    answer_plaintext: 'Material bytes / instructions on the stack. Formal recursive structure F(n)=F(n-1)+F(n-2). Efficient the call site that invokes the function. Final producing the n-th Fibonacci number. Modern engineering treats final cause as decorative because functions are reused for different purposes; teleology is supplied by the caller, not embedded in the function.',
  },
  {
    id: 'philosophy-007',
    syllabus_anchor: 'MIT OCW 24.00 wk5 — Aristotelian virtue ethics',
    instance: 'Aristotle locates virtue as a mean between two vices (e.g., courage between cowardice and rashness). Pick one professional virtue specific to a software engineer (NOT a generic virtue), name the two flanking vices precisely, and give one decision boundary observable in code review where both vices manifest.',
    answer_plaintext: 'Virtue appropriate skepticism of language-model output. Vice 1 (deficiency) credulity, accepting generated code without reading it. Vice 2 (excess) paranoia, refusing to use any generated code regardless of how it is verified. Decision boundary the code reviewer who pastes generated output into production without running tests displays vice 1; the reviewer who rewrites every generated line by hand to feel safe displays vice 2.',
  },
  {
    id: 'philosophy-008',
    syllabus_anchor: 'MIT OCW 24.00 wk7 — Stoic distinction',
    instance: 'Epictetus distinguishes what is up to us (prohairesis) from what is not. State this distinction in one line, then apply it to a software incident: a service goes down because an upstream provider had a regional outage. Identify, with a sentence each, the engineer prohairetic responsibilities and the categories that fall outside them.',
    answer_plaintext: 'Up to us judgments, intentions, the use we make of impressions; not up to us outcomes that depend on external causes. In the incident: the engineer prohairetic responsibilities are how they communicate, what monitoring they had set up beforehand, what they choose to do next; outside: the upstream outage itself, the customer reaction, the timing.',
  },
  {
    id: 'philosophy-009',
    syllabus_anchor: 'Yale OYC PHIL 181 wk7 — Descartes method',
    instance: 'Descartes Meditations 1 produces the cogito after applying methodical doubt. Reconstruct the doubt as a formal procedure: input, transformation steps, output. State at which step a typical reader incorrectly halts and why that halt fails Descartes own standard.',
    answer_plaintext: 'Input: any belief. Step 1 ask, can this belief be doubted? Step 2 if yes, suspend it. Step 3 repeat across all beliefs of the same kind. Output: the residue of beliefs not doubtable by any of the methods deployed. Typical reader halts at the dream argument (step 2 of senses), accepting that the external world might be illusion. This fails because Descartes standard requires pushing further (the deceiver hypothesis), and the cogito only emerges after exhausting harder doubts.',
  },
  {
    id: 'philosophy-010',
    syllabus_anchor: 'MIT OCW 24.00 wk9 — Hume induction',
    instance: 'Hume argues that induction (inferring from past observed regularities to future cases) cannot be justified non-circularly. Construct the circular argument explicitly. Then state how a working scientist responds in practice and why that response is not a refutation of Hume.',
    answer_plaintext: 'Circular argument to justify induction we cite that it has worked in the past, but THAT inference is itself inductive; we are using the principle to justify itself. Working scientist response they treat induction as a methodological commitment, not a proven theorem; they accept Hume point philosophically and proceed pragmatically. This is not a refutation because Hume never claimed induction does not work; he claimed it cannot be justified deductively; the scientist concedes the latter while continuing to use the former.',
  },
  {
    id: 'philosophy-011',
    syllabus_anchor: 'MIT OCW 24.00 wk10 — Kant a priori',
    instance: 'Kant distinguishes a priori from a posteriori knowledge, and analytic from synthetic propositions, yielding four combinations. State why the synthetic a priori is the philosophically important category, and give one mathematical proposition Kant claims is synthetic a priori. Note one reason a 21st century reader may disagree with the example.',
    answer_plaintext: 'Synthetic a priori is important because it is knowledge that is both informative (synthetic, the predicate adds something new) AND independent of experience (a priori), which would be a third source of knowledge beyond pure logic and pure observation. Kant example: 7+5=12 is synthetic because the concept of 12 is not contained in 7 or 5 or +; it is a priori because we know it without empirical verification. A 21st century reader may disagree because Frege/Russell logicism reduces arithmetic to logic, making it analytic, not synthetic.',
  },
  {
    id: 'philosophy-012',
    syllabus_anchor: 'MIT OCW 24.00 wk11 — Kant ethics',
    instance: 'Kant categorical imperative tests a maxim by universalizing it. Apply this test to the maxim I will deceive my evaluator about my work to gain credit. Walk through the universalization step concretely, identify the contradiction (in conception OR in will), and explain why this maxim fails by Kant standard.',
    answer_plaintext: 'Universalization step imagine a world where every learner deceives every evaluator about their work. Contradiction in conception the institution of evaluation presupposes truthful reporting of work; if all learners deceive, the institution dissolves; the maxim cannot even be conceived as a universal law without self-undermining. (This is a contradiction in conception, the stronger of Kant two failure modes.) The maxim fails because it depends parasitically on most learners being truthful; it cannot be universally adopted.',
  },
];

function main() {
  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }

  let written = 0;
  let skipped = 0;
  for (const seed of ITEMS) {
    const filePath = path.join(TARGET_DIR, `${seed.id}.json`);
    if (fs.existsSync(filePath)) {
      skipped++;
      continue;
    }
    const lock = sealed.lockAnswerKey(seed.answer_plaintext);
    const item = {
      id: seed.id,
      topic: 'philosophy',
      lifecycle: 'draft',
      syllabus_anchor: seed.syllabus_anchor,
      instance: seed.instance,
      verification_channel: 'sealed_rubric',
      answer_key_hash: lock.sealed_hash,
      sealed_at: lock.locked_at,
      sealed_algorithm: lock.algorithm,
      sealed_normalization: lock.normalization,
      rater_a: null,
      rater_b: null,
      agreement: null,
      notes: 'Draft. Plaintext intentionally NOT stored in this file (sealed); plaintext lives in seed-philosophy-golden.js. Two raters must independently judge whether a candidate response matches.',
    };
    fs.writeFileSync(filePath, JSON.stringify(item, null, 2) + '\n', 'utf8');
    written++;
  }
  console.log(`[seed-philosophy] wrote ${written} new item(s), skipped ${skipped} existing`);
  console.log(`[seed-philosophy] dir: ${TARGET_DIR}`);
}

if (require.main === module) main();

module.exports = { ITEMS, main };
