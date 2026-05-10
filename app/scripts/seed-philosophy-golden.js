// V0.5 E0 D3.1 — feature-set seed for philosophy golden items
//
// REWRITTEN 2026-05-10 after MEOW HALT-1/2/3/4 audit.
//
// Schema change from D3:
//   D3 (broken):    { answer_plaintext: "<80-300 word essay>", verification_channel: 'sealed_rubric' }
//   D3.1 (working): { answer_features: [{id, claim, alt_phrasings}], k_threshold, candidate_responses: [{id, text, features_hit_truth}] }
//
// Why:
//   D3 sealed-rubric channel required exact sha256 match on full-prose answer; ~100% of
//   real learner responses fail. Per MEOW audit composite 0.625 < 0.70 ship gate.
//   D3.1 decomposes each rubric into 3 atomic features with normalized alt_phrasings.
//   Human rater (or deterministic substring check in 'code' channel) marks WHICH features
//   the candidate hit. Pass = ≥k_threshold features hit. κ over feature-set agreement.
//
// Anchors fixed (HALT-4): replaced fabricated Yale OYC PHIL 181 / MIT OCW 24.00 wk1
// references with canonical text refs (Diels-Kranz / Aristotle Bekker / Plato Stephanus
// / Descartes Meditation / Hume Treatise / Kant A-B pagination). Per memory
// project_hypha_v021_failure_galileo: no LLM-fabricated course attributions.
//
// Run:
//   node app/scripts/seed-philosophy-golden.js                  # create new items only
//   node app/scripts/seed-philosophy-golden.js --force-reseal   # regenerate all 12, even existing
//   node app/scripts/seed-philosophy-golden.js --check-drift    # warn if existing hash != current

'use strict';

const fs = require('fs');
const path = require('path');
const sealed = require('../lib/evaluator/verification-channels/sealed-rubric');

const TARGET_DIR = path.join(__dirname, '..', '..', 'vault', '.evaluator', 'golden', 'philosophy');

const ITEMS = [
  {
    id: 'philosophy-001',
    source_anchor: 'Diels-Kranz Fragment 11A12; SEP "Pre-Socratic Philosophy" §1',
    instance: 'Thales claimed water is the first principle of all things. State the structural feature of his claim that distinguishes it from a religious explanation, and one observable phenomenon that would falsify it as a literal claim about substance.',
    answer_features: [
      { id: 'f1', claim: 'reduction to a single natural substrate', alt_phrasings: ['monism', 'monistic', 'one substance', 'one substrate', 'single material first principle', 'unified material principle', 'first cause'] },
      { id: 'f2', claim: 'naturalistic explanation without divine appeal', alt_phrasings: ['no gods', 'secular', 'natural-not-divine', 'not religious', 'naturalism', 'non-theological', 'without divine appeal'] },
      { id: 'f3', claim: 'falsifiable by observation of substance enduring without water', alt_phrasings: ['can be disproved by water-free thing', 'observable refutation', 'empirical test', 'falsifiable', 'empirically testable', 'refutable by observation', 'water-free counterexample'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Thales said everything reduces to water — one substance, no gods needed. We could falsify by finding any matter that endures with zero water.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Water is the divine essence flowing through all things, holy and primordial.', features_hit_truth: [] },
      { id: 'c3', text: 'It is monistic, but Thales never said how to test it.', features_hit_truth: ['f1'] },
    ],
  },
  {
    id: 'philosophy-002',
    source_anchor: 'Diels-Kranz Fragment 22B12 + 22B49a; SEP "Heraclitus" §2',
    instance: 'Heraclitus says you cannot step into the same river twice. Restate this in modern terms by naming the conserved quantity (if any) and the variant quantity, and give one engineered system where this distinction is operationally tracked.',
    answer_features: [
      { id: 'f1', claim: 'identity or pattern is conserved as continuous trajectory', alt_phrasings: ['form persists', 'pattern conserved', 'identity is continuous', 'continuity of pattern', 'structural identity preserved', 'shape persists across change', 'invariant under flux'] },
      { id: 'f2', claim: 'matter or content is the variant quantity', alt_phrasings: ['content changes', 'matter is variant', 'substance flows', 'material is variable', 'content is replaced', 'tokens swap underneath', 'water molecules differ'] },
      { id: 'f3', claim: 'engineered analog tracks identity across content edits', alt_phrasings: ['hash-versioned', 'append-only log', 'event sourcing', 'git', 'database row identity', 'version control', 'commit history', 'primary-key persistence'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Identity persists, content flows. A git repository tracks the same file across edits.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Heraclitus is just being poetic; everything just changes.', features_hit_truth: [] },
      { id: 'c3', text: 'Pattern is conserved, water is variant — the same trick a database row uses with id columns.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-003',
    source_anchor: 'Parmenides "On Nature" Fragment 8; SEP "Parmenides" §3',
    instance: 'Parmenides argued change is impossible because what-is cannot become what-is-not. Construct one analogy from physics or computer science where his deductive structure holds, and one where it fails. Identify the breaking premise.',
    answer_features: [
      { id: 'f1', claim: 'analog where deduction holds (closed-system conservation)', alt_phrasings: ['conservation of mass-energy', 'closed system', 'static identity', 'thermodynamic conservation', 'energy is conserved', 'isolated system invariant', 'no flow across boundary'] },
      { id: 'f2', claim: 'analog where deduction fails (transient or rolled-back state)', alt_phrasings: ['branch prediction misspeculation', 'rolled-back transaction', 'speculative state', 'discarded computation', 'transient state', 'aborted transaction', 'speculative execution', 'mispredicted branch'] },
      { id: 'f3', claim: 'breaking premise: treating what-is as static binary not function over time', alt_phrasings: ['premise breaks because identity is time-dependent', 'temporal becoming is allowed', 'state can exist transiently', 'being is not binary', 'existence as time function', 'static-vs-dynamic confusion', 'binary being is the false premise'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Holds in mass-energy conservation. Fails in branch prediction where speculative state is computed then discarded — the breaking premise is treating existence as static.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Parmenides was just wrong because change happens.', features_hit_truth: [] },
      { id: 'c3', text: 'In thermodynamics it holds. The problem is Parmenides treats being as binary.', features_hit_truth: ['f1', 'f3'] },
    ],
  },
  {
    id: 'philosophy-004',
    source_anchor: 'Plato Euthyphro 9e-11b (Stephanus); SEP "Plato\'s Ethics" §3.2',
    instance: 'In Plato\'s Euthyphro, Socrates derives a contradiction from Euthyphro\'s definition of piety. Reconstruct the elenchus in three steps using a generic predicate P. State the form of the contradiction.',
    answer_features: [
      { id: 'f1', claim: 'step 1 establishes the original definition (gods love P-things because they are P or vice versa)', alt_phrasings: ['initial claim', 'gods love P-things', 'definition stated', 'starting definition', 'opening premise', 'initial proposition', 'define P as god-loved'] },
      { id: 'f2', claim: 'step 2 forces dilemma between two horns', alt_phrasings: ['horns of dilemma', 'either-or split', 'two readings', 'dilemma posed', 'two-fork question', 'binary choice forced', 'because-or-makes split'] },
      { id: 'f3', claim: 'each horn yields contradiction (one collapses definition, other makes P arbitrary)', alt_phrasings: ['both horns fail', 'horn-collapse', 'circularity or arbitrariness', 'first horn circular second arbitrary', 'each branch contradicts', 'circular-or-capricious', 'collapse of definition or arbitrariness'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Step 1: define P-things as those gods love. Step 2: ask whether gods love them because P or whether they are P because gods love them. Step 3: first horn means P is prior so the definition collapses; second horn makes P arbitrary. Form is dilemma horn-collapse.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Socrates was just being annoying and Euthyphro gives up.', features_hit_truth: [] },
      { id: 'c3', text: 'Two horns; one is circular, the other is arbitrary. Both fail.', features_hit_truth: ['f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-005',
    source_anchor: 'Plato Republic 507b-509b (Stephanus); SEP "Plato on Forms" §1',
    instance: 'Plato\'s theory of Forms claims particulars participate in universal Forms. Specify one observable consequence of this theory that would distinguish it from nominalism, and explain why two thousand years of debate has not settled the question.',
    answer_features: [
      { id: 'f1', claim: 'predicted consequence: discovery of intrinsic structure unifying disparate instances', alt_phrasings: ['mathematical universals hold across cases', 'non-physical pattern across instances', 'lawful structure', 'shared form across particulars', 'universals hold lawfully', 'cross-instance regularity', 'structure unifies cases'] },
      { id: 'f2', claim: 'nominalism vs realism make identical empirical predictions', alt_phrasings: ['empirically indistinguishable', 'no observable difference', 'same predictions', 'observationally equivalent', 'empirically tied', 'experimentally identical', 'same data both ways'] },
      { id: 'f3', claim: 'unsettled because the disagreement is metaphysical not falsifiable', alt_phrasings: ['metaphysical not empirical', 'cannot be tested by current methods', 'underdetermined by data', 'beyond empirical reach', 'not falsifiable', 'metaphysical question', 'evidence-blind dispute'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'A predicted consequence: laws of nature unify cases without exception, suggesting non-physical structure. Both views make identical empirical predictions, so the debate is metaphysical, not falsifiable.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Plato was right because we can imagine forms.', features_hit_truth: [] },
      { id: 'c3', text: 'Nominalism predicts the same observations, so the debate cannot be settled empirically.', features_hit_truth: ['f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-006',
    source_anchor: 'Aristotle Physics II.3 (194b-195a Bekker); Metaphysics V.2 (1013a-b)',
    instance: 'Apply Aristotle\'s four causes (material, formal, efficient, final) to a recursive Fibonacci function. Then identify which cause modern engineering treats as decorative and why.',
    answer_features: [
      { id: 'f1', claim: 'four causes mapped concretely to function (bytes / recursive structure / call-site / output goal)', alt_phrasings: ['material is bytes or stack', 'formal is recursion structure', 'efficient is caller', 'final is the output', 'four causes mapped to function', 'all four causes applied', 'concrete cause assignment', 'matter form efficient end'] },
      { id: 'f2', claim: 'final cause identified as decorative in modern engineering', alt_phrasings: ['final cause is decoration', 'teleology is dropped', 'final is decorative', 'goal not embedded', 'teleology demoted', 'purpose is ornamental', 'engineering ignores final cause'] },
      { id: 'f3', claim: 'reason is reuse: function purpose comes from caller not function itself', alt_phrasings: ['function reused for many purposes', 'caller supplies teleology', 'no embedded goal', 'reuse-driven', 'caller decides purpose', 'purpose external to function', 'goal lives in call-site'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Material is the bytes. Formal is F(n)=F(n-1)+F(n-2). Efficient is the caller. Final is the n-th Fibonacci. Modern engineering treats final cause as decoration because functions are reused for different purposes.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Aristotle is outdated, we just have functions.', features_hit_truth: [] },
      { id: 'c3', text: 'Final cause drops out because the function is called for many reasons, the caller decides.', features_hit_truth: ['f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-007',
    source_anchor: 'Aristotle Nicomachean Ethics II.6 (1106b Bekker); SEP "Aristotle\'s Ethics" §6',
    instance: 'Aristotle locates virtue as a mean between two vices. Pick one professional virtue specific to a software engineer (NOT a generic virtue), name the two flanking vices precisely, and give one decision boundary observable in code review where both vices manifest.',
    answer_features: [
      { id: 'f1', claim: 'virtue is software-specific (not generic courage / honesty)', alt_phrasings: ['specific professional virtue', 'engineering-specific', 'tied to software practice', 'craft-specific', 'developer-particular', 'profession-bound virtue', 'not generic ethics'] },
      { id: 'f2', claim: 'two flanking vices named precisely with deficiency / excess structure', alt_phrasings: ['vice of deficiency', 'vice of excess', 'both extremes', 'too-little and too-much', 'underdoing and overdoing', 'deficiency-excess pair', 'paired extremes'] },
      { id: 'f3', claim: 'concrete decision boundary in code review where each vice manifests', alt_phrasings: ['observable in review', 'concrete behavior', 'review pattern', 'visible in PR', 'review-stage signal', 'observable code-review tell', 'concrete review behavior'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Virtue: appropriate skepticism of generated code. Vice 1 (deficiency): credulity, accepting code without reading it. Vice 2 (excess): paranoia, refusing all generated code. Boundary: in review, vice 1 pastes without testing; vice 2 rewrites everything by hand.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Be brave in code review.', features_hit_truth: [] },
      { id: 'c3', text: 'Test discipline — vice 1 skips tests, vice 2 obsessively over-tests. In review you see this in test count.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-008',
    source_anchor: 'Epictetus Enchiridion §1; Discourses I.1; SEP "Epictetus" §3',
    instance: 'Epictetus distinguishes what is up to us (prohairesis) from what is not. State the distinction in one line, then apply to a software incident: a service goes down due to upstream provider regional outage. Identify the engineer\'s prohairetic responsibilities and what falls outside.',
    answer_features: [
      { id: 'f1', claim: 'distinction stated: judgments and intentions are up to us; outcomes that depend on externals are not', alt_phrasings: ['internal judgments vs external outcomes', 'opinions and choices versus events', 'what we control versus what we do not', 'prohairesis vs externals', 'will versus events', 'inner choice and outer event split', 'control distinction'] },
      { id: 'f2', claim: 'prohairetic responsibilities applied: communication, prior monitoring, response choice', alt_phrasings: ['how we communicate', 'monitoring set up beforehand', 'what we choose to do', 'pre-incident preparedness', 'communication discipline', 'response posture', 'observability up-front'] },
      { id: 'f3', claim: 'externals identified: upstream outage, customer reaction, timing', alt_phrasings: ['outage itself', 'customer feelings', 'timing of incident', 'upstream failure', 'when outage hits', 'customer reception', 'externalities of incident'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Up to us are our judgments and intentions; not up to us are outcomes from external causes. Engineer controls: communication, prior monitoring, response. Outside: the outage, customer reaction, timing.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Stoicism means accepting outages calmly.', features_hit_truth: [] },
      { id: 'c3', text: 'Engineer can choose communication and prior monitoring. The outage and customer feelings are outside their control.', features_hit_truth: ['f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-009',
    source_anchor: 'Descartes Meditation 1 (AT VII 17-23); SEP "Descartes\' Method" §2',
    instance: 'Descartes\' Meditations 1 produces the cogito after methodical doubt. Reconstruct the doubt as a formal procedure: input, transformation steps, output. State at which step a typical reader incorrectly halts and why.',
    answer_features: [
      { id: 'f1', claim: 'procedure formalized: input is any belief, steps test doubtability and suspend', alt_phrasings: ['input belief', 'iterate doubt test', 'suspend doubtable', 'test each belief for doubtability', 'methodical doubt loop', 'procedural doubt', 'doubt-and-suspend pipeline'] },
      { id: 'f2', claim: 'cogito emerges as residue of beliefs not doubtable', alt_phrasings: ['residue of certainty', 'output is undoubtable', 'cogito appears', 'undoubtable remainder', 'cogito as fixed point', 'residual certainty', 'survivor of doubt'] },
      { id: 'f3', claim: 'typical reader halts before exhausting harder doubts (e.g., dream argument or evil deceiver)', alt_phrasings: ['halts at dream argument', 'halts at sense deception', 'halts before deceiving God', 'gives up too early', 'stops before evil deceiver', 'truncates the doubt', 'incomplete doubt sequence'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Input: any belief. Steps: ask if doubtable, suspend if yes, repeat. Output: undoubtable residue. Typical reader halts at the dream argument and stops short of the deceiver hypothesis where the cogito actually emerges.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Descartes thinks therefore he is.', features_hit_truth: [] },
      { id: 'c3', text: 'Doubt every belief, the residue is the cogito. Reader stops at dream argument when they should push to the evil deceiver.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-010',
    source_anchor: 'Hume Treatise Book I Part III §6; Enquiry §IV',
    instance: 'Hume argues induction cannot be justified non-circularly. Construct the circular argument explicitly. State how a working scientist responds in practice and why that response is not a refutation of Hume.',
    answer_features: [
      { id: 'f1', claim: 'circular argument: induction has worked before, but THAT inference is itself inductive', alt_phrasings: ['justification uses induction itself', 'circularity stated', 'self-referential justification', 'begging the question', 'induction justified by induction', 'circular reasoning identified', 'petitio principii'] },
      { id: 'f2', claim: 'scientist response: methodological commitment, not proven theorem', alt_phrasings: ['pragmatic acceptance', 'methodological not proven', 'works in practice', 'practical posture', 'methodological assumption', 'working hypothesis', 'taken as policy not proof'] },
      { id: 'f3', claim: 'not a refutation: Hume conceded induction works, only denied deductive justification', alt_phrasings: ['Hume did not deny effectiveness', 'concedes one denies the other', 'addresses different question', 'Hume granted it works', 'effectiveness vs deductive justification', 'separate claims', 'distinct questions'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Circular: to justify induction we cite that it worked, but THAT itself is inductive. Scientists treat induction as methodological commitment, not proven theorem. This is not refutation because Hume only denied deductive justification, never effectiveness.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Hume was a skeptic and science still works.', features_hit_truth: [] },
      { id: 'c3', text: 'The justification is circular. Scientists pragmatically accept it. They are addressing a different question than Hume.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-011',
    source_anchor: 'Kant Critique of Pure Reason A6-10/B10-14; Prolegomena §2',
    instance: 'Kant distinguishes a priori from a posteriori knowledge and analytic from synthetic propositions, yielding four combinations. State why synthetic a priori is the philosophically important category and give one mathematical proposition Kant claims is synthetic a priori. Note one reason a 21st-century reader may disagree.',
    answer_features: [
      { id: 'f1', claim: 'synthetic a priori is a third source of knowledge beyond pure logic and pure observation', alt_phrasings: ['informative AND independent of experience', 'beyond logic and observation', 'third knowledge source', 'non-trivial yet a priori', 'informative non-empirical truth', 'substantive yet experience-independent', 'third epistemic category'] },
      { id: 'f2', claim: 'example: 7+5=12 (or similar arithmetic) treated as synthetic a priori', alt_phrasings: ['7 plus 5 equals 12', 'arithmetic example', 'mathematical proposition', 'sum example', 'basic arithmetic case', 'addition of small integers', 'a sum like 7+5=12'] },
      { id: 'f3', claim: 'Frege/Russell logicism would reduce arithmetic to logic, making it analytic', alt_phrasings: ['logicism reduces math to logic', 'Frege Russell objection', 'arithmetic might be analytic', 'logicist program', 'math as logic', 'Principia-style reduction', 'Frege program against Kant'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Synthetic a priori would be a third knowledge source beyond logic and observation. Kant says 7+5=12 is one. A modern reader may disagree because Frege and Russell reduce arithmetic to logic, making it analytic.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Kant is hard to read.', features_hit_truth: [] },
      { id: 'c3', text: 'It is the category that is informative AND independent of experience. 7+5=12. But logicism challenges that.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-012',
    source_anchor: 'Kant Groundwork of the Metaphysic of Morals §II (4:421-4:424); SEP "Kant\'s Moral Philosophy" §6',
    instance: 'Kant\'s categorical imperative tests a maxim by universalizing it. Apply this test to "I will deceive my evaluator about my work to gain credit." Walk through universalization, identify the contradiction (in conception or in will), explain why this maxim fails by Kant\'s standard.',
    answer_features: [
      { id: 'f1', claim: 'universalization step performed: imagine all learners deceiving all evaluators', alt_phrasings: ['imagine universal adoption', 'every learner does this', 'as universal law', 'lift maxim to universal', 'universalize the maxim', 'apply to everyone', 'as if all adopt'] },
      { id: 'f2', claim: 'contradiction in conception: institution of evaluation dissolves under universal deception', alt_phrasings: ['institution collapses', 'cannot even be conceived', 'self-undermining', 'evaluation cannot exist', 'institution becomes incoherent', 'practice destroys itself', 'evaluation dissolves'] },
      { id: 'f3', claim: 'failure mode: maxim depends parasitically on most being truthful', alt_phrasings: ['parasitic on truthfulness of others', 'free-rider', 'cannot be universally adopted', 'rides on others honesty', 'depends on majority not adopting', 'free-rider problem', 'requires others to be honest'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Universalize: every learner deceives every evaluator. Contradiction in conception: the institution of evaluation presupposes truthful reporting; if all deceive, the institution dissolves. The maxim is parasitic on most being truthful, so it cannot be universally adopted.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Kant says do not lie.', features_hit_truth: [] },
      { id: 'c3', text: 'If universalized, evaluation as institution becomes impossible. The maxim depends on others not adopting it.', features_hit_truth: ['f2', 'f3'] },
    ],
  },
];

function _sealItem(seed) {
  const features = seed.answer_features.map(f => {
    const phrases = [f.claim, ...(f.alt_phrasings || [])];
    return {
      id: f.id,
      claim: f.claim,
      alt_phrasings: f.alt_phrasings || [],
      phrasing_hashes: phrases.map(p => sealed.lockAnswerKey(p).sealed_hash),
      claim_hash: sealed.lockAnswerKey(f.claim).sealed_hash,
    };
  });
  return {
    id: seed.id,
    topic: 'philosophy',
    lifecycle: 'draft',
    source_anchor: seed.source_anchor,
    instance: seed.instance,
    verification_channel: 'sealed_rubric',
    schema_version: '0.5.D4',
    answer_features: features,
    k_threshold: seed.k_threshold,
    candidate_responses: seed.candidate_responses,
    sealed_at: new Date().toISOString(),
    sealed_algorithm: 'sha256',
    sealed_normalization: 'trim+collapse-whitespace+lowercase',
    notes: 'D4 schema (post-MEOW R2). Main JSON is immutable post-seal: features + candidates + truth. Rater work moves to sidecar files philosophy-NNN.rater-a.json + philosophy-NNN.rater-b.json (eliminates race condition R1 from MEOW R2 audit). golden-loader merges sidecars at read time; agreement computed dynamically.',
  };
}

// D4 (R2 fix per MEOW R2): include phrasing_hashes alongside claim_hash so that
// edits to alt_phrasings trigger drift detection. Prior implementation only
// hashed claim_hash, missing phrasing edits silently.
function _itemFingerprint(item) {
  const parts = [];
  for (const f of item.answer_features || []) {
    parts.push(f.claim_hash || '');
    parts.push((f.phrasing_hashes || []).join(','));
  }
  return parts.join('|');
}

function main(argv) {
  argv = argv || process.argv;
  const forceReseal = argv.includes('--force-reseal');
  const checkDrift = argv.includes('--check-drift');

  if (!fs.existsSync(TARGET_DIR)) {
    fs.mkdirSync(TARGET_DIR, { recursive: true });
  }

  let written = 0;
  let skipped = 0;
  let drifted = 0;

  for (const seed of ITEMS) {
    const filePath = path.join(TARGET_DIR, `${seed.id}.json`);
    const candidate = _sealItem(seed);
    const candidateFingerprint = _itemFingerprint(candidate);

    if (fs.existsSync(filePath)) {
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_e) { /* fall through to overwrite */ }

      const existingFingerprint = existing && existing.answer_features
        ? existing.answer_features.map(f => f.claim_hash).filter(Boolean).join('|')
        : null;

      const drift = existingFingerprint !== candidateFingerprint;

      if (checkDrift) {
        if (drift) {
          console.warn(`[seed-philosophy] DRIFT: ${seed.id} feature claims changed since seal. Existing fp: ${existingFingerprint && existingFingerprint.slice(0, 32)}... vs candidate: ${candidateFingerprint.slice(0, 32)}...`);
          drifted++;
        }
        continue;
      }

      if (!forceReseal) {
        if (drift) {
          console.warn(`[seed-philosophy] WARN: ${seed.id} drifted but --force-reseal not set; SKIPPING (would silently lose edits without this warning). Re-run with --force-reseal to update.`);
          drifted++;
        } else {
          skipped++;
        }
        continue;
      }

      // D4 R1: rater work lives in sidecars; do NOT carry rater_a / rater_b /
      // agreement onto the main JSON. Sidecars at <id>.rater-{a|b}.json survive
      // independently across reseals (they carry their own ts + ratings).
    }

    fs.writeFileSync(filePath, JSON.stringify(candidate, null, 2) + '\n', 'utf8');
    written++;
  }

  console.log(`[seed-philosophy] wrote ${written} item(s), skipped ${skipped} unchanged, ${drifted} drifted`);
  console.log(`[seed-philosophy] dir: ${TARGET_DIR}`);
  if (drifted > 0 && !forceReseal && !checkDrift) {
    console.warn(`[seed-philosophy] ${drifted} item(s) drifted. Re-run with --force-reseal to apply changes.`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { ITEMS, main, _sealItem, _itemFingerprint };
