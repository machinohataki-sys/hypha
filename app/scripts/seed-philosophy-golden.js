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
  // ---- D11 Group beta extension: items 013-025 (MIT OCW 24.00 + Yale OYC PHIL 181 syllabus order)
  // Anchor sourcing rule: canonical primary citations (Bekker / Stephanus / AT / Ak / KSA / §)
  // where I am confident; fall back to SEP article when a precise primary locator is not
  // independently verifiable. Per project memory project_hypha_v021_failure_galileo /
  // MEOW R2 HALT-4: no fabricated section numbers. Where a Bekker / Stephanus / Ak number
  // is given below, it appears in the standard concordances of the cited treatise.
  {
    id: 'philosophy-013',
    source_anchor: 'Aristotle Physics II.3 + II.7 (194b16-195a3 / 198a14-b9 Bekker); Nicomachean Ethics II.1 (1103a14-b25); SEP "Aristotle\'s Natural Philosophy" §6',
    instance: 'Aristotle organizes change under the four causes (material / formal / efficient / final) and grounds virtue in habituated activity (energeia) directed at a telos. Apply both frameworks to a single concrete artifact — a beginner runner training for a marathon — and identify the precise place where Aristotle\'s account of moral virtue diverges from a purely consequentialist redescription.',
    answer_features: [
      { id: 'f1', claim: 'four causes mapped concretely to the runner case (body / training pattern / coach or self / health or completion)', alt_phrasings: ['material is the body', 'formal is the training pattern', 'efficient is the coach or runner herself', 'final is finishing the marathon', 'four causes applied to runner', 'matter form efficient end mapped', 'all four causes assigned'] },
      { id: 'f2', claim: 'virtue formed by habituated activity (hexis) not by single acts or outcomes', alt_phrasings: ['virtue is a stable disposition', 'hexis through repeated practice', 'habituation builds character', 'state of character not single act', 'we are what we repeatedly do', 'character through habit', 'habit shapes hexis'] },
      { id: 'f3', claim: 'divergence from consequentialism: act done from the right state of character, not merely by outcome', alt_phrasings: ['act flows from character not just outcome', 'consequentialism collapses motive', 'Aristotle requires the right hexis', 'how-done matters not only what-done', 'virtue is in the agent not in the result', 'manner of action constitutes virtue', 'inner state required not just outcome'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Material is the runner\'s body, formal is the training program, efficient is the coach, final is completing the marathon. Virtue is a hexis built by repeated training acts, not by a one-off finish. Aristotle diverges from consequentialism because virtue lives in the stable character from which the act flows, not only in the outcome.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Aristotle just means practice makes perfect.', features_hit_truth: [] },
      { id: 'c3', text: 'Habit builds the hexis. The act must come from the right state of character — outcome alone is not enough for Aristotle.', features_hit_truth: ['f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-014',
    source_anchor: 'Plato Republic VI 507b-509c + VII 514a-517a (Stephanus); SEP "Plato\'s Middle Period Metaphysics and Epistemology" §3',
    instance: 'In the divided line and cave allegory, Plato distinguishes images, sensible things, mathematical objects, and Forms, with the Form of the Good as the source of intelligibility. State what changes between the cave-bound prisoner and the philosopher returning to the cave, and identify one cognitive operation modern epistemology still treats as analogous to "ascent" out of mere appearance.',
    answer_features: [
      { id: 'f1', claim: 'ascent reorders the subject\'s relation to evidence (from appearances to structural causes)', alt_phrasings: ['from shadow to source', 'from appearance to structure', 'reorientation toward causes', 'turn of the soul toward the real', 'periagoge', 'climb from appearance to principle', 'shift from image to ground'] },
      { id: 'f2', claim: 'returning philosopher loses fluency in shadow-talk yet sees its causes', alt_phrasings: ['returner is mocked in cave', 'sees shadows for what they are', 'fluent above blind below', 'cave-blindness on return', 'pays the cost of clearer sight', 'returning sees the shadows as shadows', 'momentary loss of cave-fluency'] },
      { id: 'f3', claim: 'modern analog: model-building or theoretical inference replacing pattern-matching on raw data', alt_phrasings: ['theory replaces pure data fitting', 'causal model behind correlations', 'mechanistic interpretability over surface accuracy', 'first-principles model', 'inference to underlying structure', 'building a model not just matching patterns', 'going beyond surface statistics'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'The prisoner is reoriented away from shadows toward their causes — periagoge. On return the philosopher sees shadows as shadows, but loses fluency in shadow-talk and is mocked. The modern analog is moving from surface pattern-matching to a causal model of underlying structure.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'The cave is an allegory for ignorance, the sun is the truth.', features_hit_truth: [] },
      { id: 'c3', text: 'It is a turn of the soul from appearance to structure. The returner momentarily loses the cave-fluency of those still bound.', features_hit_truth: ['f1', 'f2'] },
    ],
  },
  {
    id: 'philosophy-015',
    source_anchor: 'Augustine Confessions VII.3-7, VIII.5; On Free Choice of the Will (De libero arbitrio) II.20, III.17; SEP "Saint Augustine" §6',
    instance: 'Augustine\'s account of evil treats it as a privation of good (privatio boni) and grounds responsibility in voluntary turning of the will. Reconstruct the privation move in three steps, then state how it constrains what counts as a coherent question of the form "why is there X evil in the world."',
    answer_features: [
      { id: 'f1', claim: 'privation move: evil is not a positive substance but the absence or disorder of due good', alt_phrasings: ['evil is privation not substance', 'absence of due good', 'no positive ontology of evil', 'privatio boni', 'evil is a lack', 'disordered absence of good', 'evil has no substance only deficit'] },
      { id: 'f2', claim: 'grounding in will: voluntary turning away from higher to lower good', alt_phrasings: ['will turns toward lesser good', 'voluntary aversion from God', 'free will misuses created good', 'will is the locus of moral evil', 'willed disordering of loves', 'aversio a deo conversio ad creaturas', 'misuse of free choice'] },
      { id: 'f3', claim: 'constraint: the question "why does X (a thing-evil) exist" mistakes a deficit for a substance', alt_phrasings: ['question presupposes positive evil', 'reframes as why is good missing here', 'category mistake about evil', 'asks of nothing as if something', 'reformulates question to absence of good', 'why is X-good absent here', 'evil is not a thing to explain'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Step 1: evil is privatio boni — not a thing, only a lack of due good. Step 2: moral evil grounds in the will turning from a higher good to a lower one. Step 3: asking why a positive thing-evil exists is a category mistake; the only coherent form is why a particular good is missing or disordered here.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Augustine says everything is God\'s plan.', features_hit_truth: [] },
      { id: 'c3', text: 'Evil is privation, will turns wrongly. So the question must be reframed as why is the proper good absent, not why an evil-thing is present.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-016',
    source_anchor: 'Thomas Aquinas Summa Theologiae I q.2 a.3 (Five Ways); I-II q.94 a.2 (natural law); SEP "Aquinas\'s Moral, Political, and Legal Philosophy" §1-2',
    instance: 'Aquinas\'s Five Ways argue from observable features of the world to a first cause, and his natural law derives moral norms from rational apprehension of human goods. Pick ONE of the Five Ways, state it as a numbered argument with explicit premises and conclusion, and identify the most common modern objection to that specific way.',
    answer_features: [
      { id: 'f1', claim: 'the chosen way reconstructed with premises and conclusion (not paraphrased loosely)', alt_phrasings: ['premise 1', 'premise 2', 'conclusion', 'argument structure', 'numbered premises', 'reconstructed deductively', 'inferential structure'] },
      { id: 'f2', claim: 'identifies the move from observed regularity to a first or necessary being', alt_phrasings: ['from motion to first mover', 'from contingency to necessary being', 'from causes to first cause', 'from order to designer', 'from gradation to maximum', 'inference to first principle', 'climb to first cause'] },
      { id: 'f3', claim: 'standard modern objection (e.g., infinite regress is acceptable; quantifier shift; from each-cause to a-cause)', alt_phrasings: ['quantifier shift fallacy', 'from each contingent to all contingent', 'infinite regress is harmless', 'modern cosmology objection', 'why first not just earlier', 'no need for terminator', 'composition or quantifier objection'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Third Way (from contingency). Premise 1: some things are contingent (could not exist). Premise 2: if all things were contingent, at some past time nothing existed. Premise 3: from nothing, nothing comes. Conclusion: there must be a necessary being. Modern objection: this commits a quantifier shift — from "each thing is contingent" we cannot infer "there is a time at which all are non-existent simultaneously."', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Aquinas proves God exists in five ways.', features_hit_truth: [] },
      { id: 'c3', text: 'First Way climbs from motion to a first mover. The standard objection is that an infinite regress of movers is acceptable, so we never need a first.', features_hit_truth: ['f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-017',
    source_anchor: 'Spinoza Ethics Part I prop.14 + def.6; Part III preface; Part V prop.42; SEP "Spinoza" §3',
    instance: 'Spinoza\'s monism (substance monism) and parallelism (one substance under attributes of thought and extension) deny mind-body causal interaction in the Cartesian sense. State the structural reason why parallelism follows from monism, and identify one consequence for the question of free will.',
    answer_features: [
      { id: 'f1', claim: 'substance monism: only one substance (Deus sive Natura), modes are modifications of it', alt_phrasings: ['only one substance', 'God or Nature', 'Deus sive Natura', 'monistic substance', 'all is one substance', 'modes are modifications', 'substance is unique'] },
      { id: 'f2', claim: 'parallelism: thought and extension are attributes of the same substance, ordered identically', alt_phrasings: ['order of ideas equals order of things', 'thought and extension are two attributes', 'same order in both attributes', 'ordo et connexio idearum', 'parallel attributes', 'mind and body express same modification', 'attributes track each other'] },
      { id: 'f3', claim: 'consequence: free will as causal autonomy is illusory; freedom is adequate understanding', alt_phrasings: ['no contracausal freedom', 'free will reduces to ignorance of causes', 'freedom is understanding necessity', 'no exemption from determination', 'freedom is adequate ideas', 'every act is causally determined', 'libertarian free will rejected'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Monism: one substance, Deus sive Natura, with infinite attributes; modes are its modifications. Parallelism: thought and extension are two of those attributes, expressing the same order of modifications. Consequence: free will as Cartesian causal autonomy collapses; what Spinoza calls freedom is adequate understanding of one\'s own determination.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Spinoza is a pantheist.', features_hit_truth: [] },
      { id: 'c3', text: 'One substance, two attributes ordered identically; therefore mind cannot causally push body. Freedom in Spinoza is reframed as understanding necessity, not exemption from it.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-018',
    source_anchor: 'Hume Treatise of Human Nature III.1.1 (is-ought passage); Enquiry §IV-V (induction); SEP "David Hume" §4-5',
    instance: 'Hume isolates two distinct gaps: from "is" to "ought" (Treatise III.1.1) and from "past constant conjunction" to "future continuation" (Enquiry IV). Show why these are STRUCTURALLY different gaps, and give one machine-learning practice that respects each gap.',
    answer_features: [
      { id: 'f1', claim: 'is-ought is a normative gap: descriptive premises do not entail prescriptive conclusions', alt_phrasings: ['descriptive does not imply normative', 'no ought from is alone', 'normative gap', 'cannot derive value from fact alone', 'evaluative conclusion needs evaluative premise', 'fact-value gap', 'ought never lies in is alone'] },
      { id: 'f2', claim: 'induction is an epistemic gap: past regularity does not deductively entail future continuation', alt_phrasings: ['no deductive bridge from past to future', 'uniformity of nature is assumed', 'past regularity does not entail future', 'inductive justification is not deductive', 'epistemic gap', 'observed past does not prove unobserved future', 'gap between observed and projected'] },
      { id: 'f3', claim: 'ml practices: explicit value alignment / loss specification (is-ought); held-out test or distribution-shift monitoring (induction)', alt_phrasings: ['explicit reward function for ought', 'loss function makes ought-choice explicit', 'held-out evaluation respects induction gap', 'distribution shift detection', 'covariate shift monitoring', 'value specification for normative side', 'ood evaluation for inductive side'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Is-ought is normative: descriptive premises alone cannot entail a prescription. Induction is epistemic: past constant conjunction does not deductively entail future continuation. In ML, we respect the first by stating the loss / value alignment explicitly, and the second by held-out test sets and distribution-shift monitoring.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Hume was a skeptic about everything.', features_hit_truth: [] },
      { id: 'c3', text: 'Is-ought is a normative gap; induction is an epistemic gap. They are addressed differently.', features_hit_truth: ['f1', 'f2'] },
    ],
  },
  {
    id: 'philosophy-019',
    source_anchor: 'Kant Groundwork (Ak 4:421-429) + Critique of Pure Reason B19-B24 (synthetic a priori); SEP "Kant\'s Moral Philosophy" §6 + "Kant\'s Critique of Pure Reason" §3',
    instance: 'Kant offers two formulations of the categorical imperative: universal law (FUL) and humanity as an end in itself (FH). Apply BOTH to "I will use a colleague\'s draft work as my own to meet a deadline" and explain whether they reach the same verdict by the same reason or different reasons.',
    answer_features: [
      { id: 'f1', claim: 'FUL applied: universalize and find contradiction in conception or in will', alt_phrasings: ['universalize the maxim', 'imagine all do this', 'as universal law', 'contradiction in conception or will', 'institution of authorship dissolves', 'unable to be universally adopted', 'universalize then check contradiction'] },
      { id: 'f2', claim: 'FH applied: colleague treated merely as means to the agent\'s deadline', alt_phrasings: ['humanity treated merely as means', 'colleague reduced to instrument', 'fails the end-in-itself formulation', 'rational agent used merely as a tool', 'colleague\'s consent bypassed', 'instrumentalized rational agent', 'merely as means not also as end'] },
      { id: 'f3', claim: 'reaches same verdict, but reasons differ: FUL = systemic contradiction; FH = local violation of dignity', alt_phrasings: ['same verdict different ground', 'systemic vs interpersonal ground', 'one is universalizability the other is dignity', 'both forbid but for different reasons', 'two complementary not redundant tests', 'two formulations converge on verdict different on ground', 'agreement in verdict not in reason'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'FUL: universalize "I will pass off others\' work as mine to make deadlines" — authorship as institution dissolves under universal adoption, so contradiction in conception. FH: the colleague is treated merely as a means to my deadline, never also as an end. Both verdicts converge (impermissible) but the grounds differ: FUL is systemic, FH is interpersonal dignity.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Kant says do not cheat.', features_hit_truth: [] },
      { id: 'c3', text: 'Universalized, the practice of authorship breaks. The colleague is also reduced to a means. Same verdict, different reasons.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-020',
    source_anchor: 'Hegel Phenomenology of Spirit §178-§196 (Lordship and Bondage); SEP "Hegel\'s Dialectics" §3',
    instance: 'In the master-slave dialectic, recognition between two self-consciousnesses passes through asymmetric struggle and reverses through labor on the world. Reconstruct the reversal in three steps and identify the structural reason the master\'s position is unstable.',
    answer_features: [
      { id: 'f1', claim: 'asymmetric recognition: master demands recognition from a being he refuses to recognize as equal', alt_phrasings: ['unequal recognition demanded', 'recognized only by an unrecognized other', 'asymmetric mutual recognition', 'one-sided recognition', 'master needs recognition from a non-equal', 'demands what he refuses to grant', 'asymmetry of acknowledgment'] },
      { id: 'f2', claim: 'labor on the world: the bondsman shapes the object and finds himself in his work', alt_phrasings: ['bondsman shapes the world through labor', 'work objectifies the self', 'forms the object and is formed by it', 'finds himself in his product', 'labor as self-formation', 'bondsman recognized in his shaped world', 'productive labor as self-recognition'] },
      { id: 'f3', claim: 'master\'s instability: recognition he receives is from one whose recognition he has dismissed as worthless', alt_phrasings: ['master\'s recognition is hollow', 'recognition from a deemed-inferior is empty', 'self-undermining recognition demand', 'master\'s position cannot satisfy itself', 'cannot get the recognition he sought', 'recognition collapses into nothing', 'demands valuable recognition from a discounted source'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Step 1: master demands recognition from a self-consciousness he denies as equal — asymmetric. Step 2: the bondsman labors on the object, shapes it, and recognizes himself in his work. Step 3: the master\'s recognition is hollow because it comes from one whose recognition he has already dismissed as worthless. The position is structurally self-undermining.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'It is about class struggle and Marx took it from Hegel.', features_hit_truth: [] },
      { id: 'c3', text: 'The recognition asked for is asymmetric. The bondsman finds himself in his shaped world while the master cannot find himself in worthless recognition.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-021',
    source_anchor: 'J.S. Mill Utilitarianism ch. II + ch. IV; On Liberty ch. I (harm principle); SEP "John Stuart Mill" §3-4',
    instance: 'Mill\'s utilitarianism (greatest happiness principle) and harm principle (only self-regarding actions are immune from coercion) can pull in different directions. Construct one realistic case where they diverge in verdict, and identify which Mill ranks above the other in his own architecture.',
    answer_features: [
      { id: 'f1', claim: 'utility framing: maximization of aggregate happiness or pleasure', alt_phrasings: ['greatest happiness principle', 'aggregate utility', 'maximize pleasure minimize pain', 'sum of welfare', 'aggregate happiness criterion', 'utilitarian calculus', 'overall happiness goal'] },
      { id: 'f2', claim: 'harm-principle framing: coercion only justified to prevent harm to others', alt_phrasings: ['only prevent harm to others', 'self-regarding actions immune from coercion', 'liberty constraint', 'no paternalism over self-regarding choices', 'harm to others as sole ground of intervention', 'self-regarding sphere protected', 'liberty principle'] },
      { id: 'f3', claim: 'in Mill\'s architecture liberty is treated as a high-order utility, so harm principle is a precommitment that protects long-run utility', alt_phrasings: ['liberty as long-run utility', 'harm principle is precommitment', 'rule-utility shape', 'long-run aggregate served by liberty rule', 'rule-level safeguard for utility', 'liberty rule serves higher-order utility', 'precommitment to liberty for long-run welfare'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Diverging case: a society could increase aggregate happiness by paternalistically restricting a self-regarding choice (say, recreational risk-taking). Pure utility says permit the restriction; harm principle says forbid the restriction. Mill resolves this by treating liberty itself as a high-order utility — the harm principle is a rule-level precommitment that maximizes long-run aggregate happiness.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Mill is a hedonist.', features_hit_truth: [] },
      { id: 'c3', text: 'Aggregate utility could justify paternalism; the harm principle blocks it. Mill subordinates the apparent utility verdict to a liberty rule that itself serves long-run utility.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-022',
    source_anchor: 'Nietzsche On the Genealogy of Morals essay I §§7-10 + essay II §§16-18; Beyond Good and Evil §§259-260; SEP "Friedrich Nietzsche" §6-7',
    instance: 'Nietzsche\'s genealogical method explains "good" and "evil" as values that arose under specific historical conditions, with master-morality and slave-morality as opposing valuation patterns. State the structural inversion the slave-revolt performs, and identify one common misreading that conflates "genealogy of X" with "refutation of X."',
    answer_features: [
      { id: 'f1', claim: 'master-morality starts from self-affirmation: noble = good, low = bad (descriptive contrast)', alt_phrasings: ['noble first calls itself good', 'good starts as self-affirmation', 'noble vs base contrast', 'master starts from yes-saying', 'good originates in the noble', 'self-valuing nobility', 'good as self-affirmation of the strong'] },
      { id: 'f2', claim: 'slave-revolt inverts the order: starts from negation of the noble, calls it evil, then derives good as its negation', alt_phrasings: ['inverted valuation', 'starts with negation of master', 'evil is primary good is derivative', 'reactive valuation', 'ressentiment-driven inversion', 'slave morality is reactive', 'no first then yes'] },
      { id: 'f3', claim: 'genetic fallacy misreading: tracing the origin of X is not refutation of X', alt_phrasings: ['genetic fallacy', 'origin is not refutation', 'genealogy explains not refutes', 'where it came from is not whether it is true', 'historical origin distinct from validity', 'genealogy ≠ argument against', 'tracing origin of X is not refuting X'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Master-morality starts from self-affirmation: noble = good, low = bad. The slave-revolt inverts this — it starts by negating the noble (calling it evil) and only derivatively defines its own good as the negation of evil. A common misreading treats genealogy as refutation, but tracing how a value arose is not a proof against it (genetic fallacy).', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Nietzsche says God is dead and morality is for the weak.', features_hit_truth: [] },
      { id: 'c3', text: 'Master starts from yes; slave starts from no. To say a value has a genealogy is not to refute it.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-023',
    source_anchor: 'Wittgenstein Philosophical Investigations §§43, 65-71 (language-games, family resemblance), §§243-271 (private language); SEP "Ludwig Wittgenstein" §3.5',
    instance: 'Wittgenstein\'s private-language argument denies that a strictly private rule for naming a sensation can be coherent. Reconstruct the argument as a constraint on what counts as following a rule, and identify the precise step at which the would-be private linguist loses the right to call any later use a correct application.',
    answer_features: [
      { id: 'f1', claim: 'rule-following requires a normative criterion for correct vs incorrect application', alt_phrasings: ['need a criterion of correctness', 'normative standard for correctness', 'distinguishes seems-right from is-right', 'rule needs a check separate from impression', 'correctness condition', 'must have right vs wrong distinction', 'normativity of rule-following'] },
      { id: 'f2', claim: 'in pure privacy "seems right" and "is right" collapse, no independent check exists', alt_phrasings: ['seems right collapses into is right', 'no independent check available', 'memory as sole criterion is circular', 'private check is no check', 'cannot distinguish appearance from reality of correct use', 'criterion collapses to impression', 'no external corrective'] },
      { id: 'f3', claim: 'so the would-be private linguist loses the right to claim any later use is correct', alt_phrasings: ['cannot claim later application is correct', 'loses the right to call later use right', 'claim of correctness is empty', 'no fact of the matter about later applications', 'no warrant for later identification', 'subsequent use cannot be ratified', 'correctness claim becomes vacuous'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Rule-following needs a criterion of correctness independent of the user\'s current impression. In a strictly private setting, "seems right to me now" and "is right" collapse — there is no independent check. So at the first re-application of the supposed private name, the user has no warrant for calling that use correct rather than merely consistent-with-impression.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Wittgenstein says language is just a game.', features_hit_truth: [] },
      { id: 'c3', text: 'The criterion of correctness collapses without a public check. So later uses cannot be ratified as correct.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-024',
    source_anchor: 'Rawls A Theory of Justice §§3-4 (original position + veil of ignorance) + §§11-13 (two principles + difference principle); SEP "John Rawls" §3-4',
    instance: 'Rawls\'s original position uses a veil of ignorance to derive two principles of justice, with the difference principle (inequalities permitted only if they benefit the least well-off). State why the veil is supposed to do justificatory work, and identify one structural objection to the move from "what would be chosen behind the veil" to "what is just."',
    answer_features: [
      { id: 'f1', claim: 'veil strips information about one\'s particular position, forcing a fairness-symmetric choice', alt_phrasings: ['removes knowledge of one\'s position', 'forces symmetric reasoning', 'no one knows their own social position', 'impartial choice procedure', 'strips identifying features', 'symmetry-forcing device', 'erases position-specific bias'] },
      { id: 'f2', claim: 'difference principle: inequalities permitted only if they benefit the least advantaged', alt_phrasings: ['inequalities only if they help the worst off', 'benefit the least well-off', 'maximize the minimum', 'maximin shape', 'least-advantaged is the test', 'inequality justified only by benefit to bottom', 'tilted in favor of worst off'] },
      { id: 'f3', claim: 'objection: hypothetical-consent does not bind actual people; or veil-modeling smuggles in risk-aversion assumptions', alt_phrasings: ['hypothetical consent is not actual consent', 'veil smuggles risk-aversion', 'maximin assumes specific risk attitude', 'no binding force from hypothetical agreement', 'why must actual people be bound by behind-veil agreement', 'risk-aversion assumption baked in', 'gap between hypothetical choice and actual obligation'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'The veil strips knowledge of one\'s particular position so the choice cannot be tilted by self-interest; this forces symmetric reasoning. The difference principle says inequalities are permissible only if they benefit the least advantaged. A standard objection is that hypothetical consent behind the veil does not by itself bind actual people, and that the maximin shape smuggles in a specific risk-aversion assumption.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Rawls is the most important political philosopher of the 20th century.', features_hit_truth: [] },
      { id: 'c3', text: 'Veil forces symmetric reasoning, difference principle privileges the worst off. The standard worry is that hypothetical consent does not bind actual persons.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-025',
    source_anchor: 'Foucault Discipline and Punish part III ch. 3 (panopticism, 1975) + "The Subject and Power" (1982); SEP "Michel Foucault" §3-4',
    instance: 'Foucault\'s analysis of disciplinary power treats power as productive (not merely repressive) and dispersed through institutions of surveillance and normalization. Apply the panopticon model to a contemporary case (algorithmic content moderation OR workplace activity tracking — pick one) and identify the structural feature that makes the analogy hold and one that makes it diverge.',
    answer_features: [
      { id: 'f1', claim: 'power is productive: it shapes behavior and constitutes subjects, not only forbids', alt_phrasings: ['power produces conduct', 'shapes subjects not only restricts', 'productive not merely repressive', 'constitutes the self-monitoring subject', 'normalizing power produces behavior', 'not only negative power', 'power as productive of subjectivity'] },
      { id: 'f2', claim: 'panoptic structure: visibility for the watched, opacity for the watcher, internalized self-monitoring', alt_phrasings: ['watched are visible watcher is opaque', 'asymmetric visibility', 'internalized surveillance', 'visibility is a trap', 'self-monitoring induced', 'one-way visibility', 'opacity of watcher visibility of watched'] },
      { id: 'f3', claim: 'divergence in modern case (continuous data trail / algorithmic verdicts / no individual watcher)', alt_phrasings: ['no single watcher', 'continuous data record', 'algorithm replaces guard', 'machine pattern not human gaze', 'data trail is continuous and post-hoc', 'no architectural tower needed', 'distributed automated surveillance'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Power is productive — it shapes how people act, not only what is forbidden. The panopticon\'s asymmetric visibility (watched visible, watcher opaque) induces self-monitoring. Workplace activity tracking shares the asymmetry and the internalized self-monitoring, but diverges because there is no individual watcher in the tower; verdicts come from continuous data trails and algorithmic patterning.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Foucault is critical of prisons and modern society.', features_hit_truth: [] },
      { id: 'c3', text: 'Power produces conduct rather than only restricting it. The panoptic asymmetry holds; the divergence is the absence of a single watcher and the continuous machine record.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  // ---- D15-D18 Group delta extension: items 026-030 (Russell / Heidegger / Sartre / Putnam / Quine)
  // Slot logic: item 25 already = Foucault per Phase 1 spec; Putnam fills slot 029, Quine fills slot 030.
  // Anchors: canonical primary refs (Mind 14 / Sein und Zeit § / Being and Nothingness Part / Mind Language and Reality / Word and Object §).
  // Per project memory project_hypha_v021_failure_galileo / MEOW R2 HALT-4: no fabricated section numbers.
  {
    id: 'philosophy-026',
    source_anchor: 'Russell "On Denoting" Mind 14 (1905) pp.479-493; Whitehead+Russell Principia Mathematica vol. I *14 (1910); SEP "Bertrand Russell" §3.2',
    instance: 'Russell\'s theory of descriptions analyzes "the present King of France is bald" without commitment to a non-existent referent, by reading the definite description as a quantified claim. Reconstruct the analysis in three logical steps and identify the puzzle it solves about empty names.',
    answer_features: [
      { id: 'f1', claim: 'definite description rewritten as quantified claim (existence + uniqueness + predicate)', alt_phrasings: ['existential quantifier rewrite', 'there exists exactly one x', 'unique x with property', 'quantified paraphrase', 'rewrite as exists-and-unique', 'three-part quantified form', 'iota operator unpacked'] },
      { id: 'f2', claim: 'logical form: there is exactly one x such that x is K of F and x is bald', alt_phrasings: ['exactly one x is K of F', 'x is unique and predicate holds', 'three conjuncts in scope of exists', 'existence uniqueness predication', 'standard E! and Bx form', 'forall y if K-of-F(y) then y=x', 'one x, only that x, and bald'] },
      { id: 'f3', claim: 'puzzle solved: empty descriptions are false (not meaningless); no need for non-existent objects', alt_phrasings: ['avoids Meinongian objects', 'sentence is false not gibberish', 'eliminates apparent reference to non-existents', 'no need for subsistent entities', 'preserves bivalence without ontological cost', 'empty subject yields false sentence', 'rejects Meinong jungle'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Step 1: rewrite the definite description as a quantified claim. Step 2: assert there exists exactly one x such that x is King of France and x is bald — three conjuncts: existence, uniqueness, predication. Step 3: since no x satisfies the K-of-F predicate, the whole sentence is simply false. The puzzle solved is that we no longer need a non-existent King to make sense of the sentence.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Russell says we should not talk about things that do not exist.', features_hit_truth: [] },
      { id: 'c3', text: 'The description unpacks into exists-and-unique-and-bald. Because no King of France exists, the sentence is false, with no Meinongian commitment.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-027',
    source_anchor: 'Heidegger Sein und Zeit §§15-18 (Zeug, Zuhandenheit) + §§51-53 (Sein-zum-Tode, 1927); SEP "Martin Heidegger" §2.2',
    instance: 'Heidegger\'s analysis of Dasein contrasts the ready-to-hand (zuhanden) mode of dealing with equipment from the present-at-hand (vorhanden) mode of theoretical inspection, and culminates in being-toward-death as the structure that individuates Dasein. State the structural difference between the two modes and explain why being-toward-death cannot be replaced by averaged talk about mortality.',
    answer_features: [
      { id: 'f1', claim: 'ready-to-hand: equipment is transparent and absorbed in a pragmatic context until it breaks', alt_phrasings: ['transparent in use', 'absorbed coping', 'equipment recedes in skilled use', 'zuhanden as transparent absorption', 'visible only when breaks', 'in-order-to context', 'tool is invisible until it fails'] },
      { id: 'f2', claim: 'present-at-hand: object becomes a mere thing with properties when the pragmatic flow breaks', alt_phrasings: ['vorhanden mode after breakdown', 'object as standalone with properties', 'theoretical inspection mode', 'thing-with-properties stance', 'detached observer view', 'object-property mode', 'thing held at theoretical distance'] },
      { id: 'f3', claim: 'being-toward-death individuates because death is non-relational, ownmost, and cannot be delegated', alt_phrasings: ['cannot be deputized', 'non-relational possibility', 'ownmost possibility', 'cannot be substituted', 'das Man cannot die for me', 'individuates Dasein', 'eigenste Moeglichkeit'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Ready-to-hand: the hammer is transparent in skilled hammering, absorbed into an in-order-to context, only visible when it breaks. Present-at-hand: once it breaks, the hammer becomes a thing with properties (weight, length) for theoretical inspection. Being-toward-death cannot collapse into averaged "people die" talk because death is non-relational and ownmost — no one can die my death for me, which is exactly what individuates Dasein.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Heidegger thinks we should be authentic and confront death.', features_hit_truth: [] },
      { id: 'c3', text: 'In skilled use, equipment is transparent. When the flow breaks, it shows up as object-with-properties. Death individuates because it is ownmost and cannot be delegated.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-028',
    source_anchor: 'Sartre L\'existentialisme est un humanisme (1946); L\'Etre et le Neant Part I ch. II "La mauvaise foi" (1943); SEP "Jean-Paul Sartre" §2.3',
    instance: 'Sartre\'s claim that "existence precedes essence" combines with his analysis of bad faith (mauvaise foi) and radical freedom. State why bad faith is structurally different from a simple lie, and identify one concrete situation where someone uses it to evade the consequences of radical freedom.',
    answer_features: [
      { id: 'f1', claim: 'bad faith is self-deception: the same consciousness is both deceiver and deceived', alt_phrasings: ['lie to oneself', 'self-deception structure', 'deceiver and deceived are one', 'one consciousness on both sides', 'reflexive deception', 'duplicity within a single subject', 'agent lies to itself'] },
      { id: 'f2', claim: 'differs from a plain lie: a liar knows the truth and conceals from another; bad faith conceals from self', alt_phrasings: ['plain lie has two parties', 'bad faith collapses the parties', 'no second party to deceive', 'lie has audience bad faith does not', 'liar withholds from another bad faith withholds from self', 'audience-collapsed lie', 'distinct from interpersonal lying'] },
      { id: 'f3', claim: 'concrete evasion: treating oneself as mere facticity (role / nature / past) to deny freedom (transcendence) — e.g., the waiter playing waiter, or "I had no choice"', alt_phrasings: ['waiter playing waiter', 'I had no choice', 'collapses transcendence into facticity', 'plays a role to deny freedom', 'invokes nature or role to evade choice', 'denies the freedom to choose otherwise', 'flees transcendence into facticity'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Bad faith is self-deception: the same consciousness is both deceiver and deceived, so unlike an ordinary lie there is no second party to whom the truth is concealed. A concrete case: the waiter who plays at being a waiter so completely that he treats his role as a fixed nature, evading the radical freedom that he must each moment choose to perform that role.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Sartre says we are condemned to be free, which is depressing.', features_hit_truth: [] },
      { id: 'c3', text: 'It is a lie to oneself, where the deceiver and the deceived are the same. People often deploy it by saying "I had no choice", collapsing transcendence into facticity to evade freedom.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-029',
    source_anchor: 'Putnam "The Meaning of \'Meaning\'" in Mind, Language and Reality (1975) §III-IV; Reason, Truth and History ch. 1 (1981); SEP "Hilary Putnam" §4',
    instance: 'Putnam\'s twin-earth thought experiment argues that meanings "ain\'t in the head" — two psychologically identical speakers can mean different things by "water". Reconstruct the argument in three steps and state how it cuts against pure functionalism about mental content.',
    answer_features: [
      { id: 'f1', claim: 'twin-earth setup: physically identical speakers, different external substance (XYZ vs H2O) sharing surface properties', alt_phrasings: ['XYZ on twin earth', 'two physically identical speakers', 'different underlying substance same appearance', 'molecular twin scenario', 'macro identical micro distinct', 'qualitatively indistinguishable substances', 'same surface different chemistry'] },
      { id: 'f2', claim: 'extension differs: "water" picks out H2O on Earth and XYZ on twin earth despite identical internal states', alt_phrasings: ['extensions differ', 'reference is different', 'word picks out different stuff', 'same head different referent', 'extensions diverge across worlds', 'reference outruns internal state', 'meaning includes referent'] },
      { id: 'f3', claim: 'consequence: meanings are not fixed by internal functional states alone; pure functionalism about content is incomplete', alt_phrasings: ['content externalism', 'meaning depends on environment', 'narrow functional state insufficient', 'pure functionalism incomplete for content', 'externalism about meaning', 'environment partly constitutes content', 'wide content not exhausted by narrow'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Step 1: imagine twin earth where the watery liquid is XYZ, not H2O, but speakers there are atom-for-atom identical to us. Step 2: when each says "water", the extension differs (H2O here, XYZ there) despite identical internal states. Step 3: so meaning is not fixed by internal functional states alone — pure functionalism about content cannot capture this externalist component.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Putnam thinks language is about reference to real things.', features_hit_truth: [] },
      { id: 'c3', text: 'Two molecularly identical speakers can pick out different stuff by "water" because the environment differs. So content is not exhausted by internal state — bad news for pure functionalism about meaning.', features_hit_truth: ['f1', 'f2', 'f3'] },
    ],
  },
  {
    id: 'philosophy-030',
    source_anchor: 'Quine "Two Dogmas of Empiricism" in From a Logical Point of View ch. II (1951/1953); Word and Object §§1-2 (1960); SEP "Willard Van Orman Quine" §3',
    instance: 'Quine attacks the analytic-synthetic distinction and argues for a holistic web of belief facing experience as a whole. Reconstruct the holism claim in three steps and identify one practical methodological constraint it imposes on theory revision.',
    answer_features: [
      { id: 'f1', claim: 'rejection of strict analytic-synthetic split: every belief is in principle revisable', alt_phrasings: ['no firm analytic-synthetic line', 'every statement revisable', 'no statement immune from revision', 'continuum not dichotomy', 'denies sharp analytic synthetic boundary', 'all beliefs in principle defeasible', 'dogma of analyticity rejected'] },
      { id: 'f2', claim: 'web of belief: theory faces experience as a whole, not statement by statement (Duhem-Quine confirmation holism)', alt_phrasings: ['confirmation holism', 'Duhem-Quine thesis', 'theory faces tribunal as whole', 'no isolated statement test', 'web meets experience together', 'corporate body of statements', 'cannot test single sentence in isolation'] },
      { id: 'f3', claim: 'methodological constraint: under recalcitrant evidence we may revise anywhere, but conservatism + simplicity guide which beliefs to drop', alt_phrasings: ['conservatism in revision', 'minimum mutilation', 'maxim of minimum mutilation', 'choose where to revise by simplicity and conservatism', 'pragmatic revision policy', 'least disturbance principle', 'protect periphery before center'] },
    ],
    k_threshold: 2,
    candidate_responses: [
      { id: 'c1', text: 'Step 1: no statement is strictly analytic and so immune from revision; the analytic-synthetic line is at best a matter of degree. Step 2: theory meets experience as a corporate body — the Duhem-Quine point that no single statement can be confirmed or refuted in isolation. Step 3: when evidence pushes back, we are free to revise anywhere in the web, but conservatism (minimum mutilation) and simplicity guide which beliefs to drop first.', features_hit_truth: ['f1', 'f2', 'f3'] },
      { id: 'c2', text: 'Quine is an empiricist who denied analyticity.', features_hit_truth: [] },
      { id: 'c3', text: 'Every belief is revisable. The web faces experience as a whole, not statement by statement. The constraint is to revise with minimum mutilation, preferring the periphery to the core.', features_hit_truth: ['f1', 'f2', 'f3'] },
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

      // D11 fix (Group beta): existing-fingerprint must use the SAME fields as
      // _itemFingerprint (claim_hash + phrasing_hashes), otherwise every item
      // sealed under D4 reads as drifted on every run because the existing
      // branch joined only claim_hash. _itemFingerprint already accepts a fully
      // sealed item shape, so reuse it for both sides.
      const existingFingerprint = existing && Array.isArray(existing.answer_features)
        ? _itemFingerprint(existing)
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
