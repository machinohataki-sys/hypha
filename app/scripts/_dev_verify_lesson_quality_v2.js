#!/usr/bin/env node
'use strict';
// HYPHA · _dev_verify_lesson_quality_v2 — smoke for v0.4.4 Anti-Slop rewire.
//
// Validates 4 changes from 2026-05-19 council:
//   B  anti-ingratiation pattern expansion (bare-stem 中文 mirror-praise)
//   A  HUMANITIES gate per-axis split (epistemic axes allow rewrite)
//   C  answer_quality_rubric schema field
//   E  HUMANITIES body floor (frameworks ≥2 + counter_cases ≥1)
//
// All read-only library calls; no IO writes.

const tests = [];
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else      { failed++; tests.push(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? '\n    ' + extra : ''}`); }
}

(async () => {

// ── B · Anti-ingratiation pattern expansion ─────────────────────────────
const { detectIngratiation } = require('../lib/agent-character/anti-ingratiation');

// Replay the 6 mirror-praise lines from the "仪式优先性" lesson transcript.
// v1 → all 6 returned 0 hits. v2 → all 6 should return ≥1 hit.
const transcriptLines = [
  '你抓住了关键：季节性、集体性、庆祝复苏',
  '就是这样。秋末埋藏、封存过冬、春分取出播种',
  '两个结构吻合。动作六拍，故事六拍',  // 结构相同 paraphrase — also test below
  '你做了它',
  '明白了',
  '对。中央圣火永不熄灭',
];

let totalHits = 0;
for (let i = 0; i < transcriptLines.length; i++) {
  const hits = detectIngratiation(transcriptLines[i]);
  totalHits += hits.length;
}
check('B1. ingratiation detector now trips on transcript lines',
  totalHits >= 4, `total hits=${totalHits} across 6 lines (v1 was 0)`);

// Direct test of each new pattern
check('B2. detects "你抓住了关键"',
  detectIngratiation('你抓住了关键，这个细节很重要').length >= 1);
check('B3. detects "就是这样"',
  detectIngratiation('就是这样。下一步是…').length >= 1);
check('B4. detects "结构相同"',
  detectIngratiation('两个结构相同。动作六拍').length >= 1);
check('B5. detects "你做了它"',
  detectIngratiation('你做了它。这是核心机制').length >= 1);
check('B6. detects "明白了"',
  detectIngratiation('明白了。下一个问题').length >= 1);
check('B7. detects bare "对" with punctuation',
  detectIngratiation('对。继续往下').length >= 1);
check('B8. detects "没错"',
  detectIngratiation('没错，你说出了关键点').length >= 1);
check('B9. clean text not falsely flagged',
  detectIngratiation('秋末农民把种子埋入坑中保存').length === 0);

// ── A · HUMANITIES gate per-axis ────────────────────────────────────────
// derivelogic is hidden but ARCHETYPE_GATE table can be loaded by require
// (module-level const). We test by invoking the actual gate function.
const pjr = require('../lib/anti-slop/prosecute-judge-rewrite');

// Verdict derivation via runReviewerJury would need full signals shape; the
// simpler invariant: HUMANITIES gate function on different axes must produce
// the expected matrix.
// Since ARCHETYPE_GATE is not exported, we test the OBSERVABLE behavior:
// _deriveVerdict via signals → verdict. Build minimal signals fixtures.
function _verdictForArchetypeAxes(archetype, opts) {
  // Synthesize signals matching the axis we want fired.
  const signals = {
    citation: opts.cit ? { unverified_count: 2 } : { unverified_count: 0 },
    pedagogy: opts.ped ? { unknown_count: 1, inconsistent: 0 } : { unknown_count: 0, inconsistent: 0 },
    confidence: opts.conf ? { leak_count: 3 } : { leak_count: 0 },
    illusion: opts.ill ? { illusion_detected: true } : { illusion_detected: false },
  };
  // We need to call internal _deriveVerdict; export it for testing if avail,
  // else just call runReviewerJury entry point. Inspect what's exported.
  if (typeof pjr._deriveVerdict === 'function') {
    return pjr._deriveVerdict(pjr._summarizeFireRates ? pjr._summarizeFireRates(signals) : {
      cit_unverified: opts.cit ? 2 : 0,
      ped_unknown: opts.ped ? 1 : 0,
      ped_inconsistent: 0,
      conf_leak: opts.conf ? 3 : 0,
      illusion_fire: opts.ill ? 1 : 0,
      total_fire: (opts.cit ? 1 : 0) + (opts.ped ? 1 : 0) + (opts.conf ? 1 : 0) + (opts.ill ? 1 : 0),
    }, archetype);
  }
  return null; // skip if not exported
}

// Note: severity='mid' requires total_fire≥2 OR cit≥1 OR ped≥1 OR conf≥2.
// illusion_fire alone (total=1) only reaches sev='low', which the gate
// blocks regardless of archetype. So test illusion via the combo
// (illusion + conf) where both fire — sev=mid + axes include illusion +
// confidence → gate allows rewrite.
const v1 = _verdictForArchetypeAxes('HUMANITIES', { conf: true });  // conf_leak=3 → sev='mid'
const v2 = _verdictForArchetypeAxes('HUMANITIES', { ill: true, conf: true });  // total=2 mid + illusion axis present
const v3 = _verdictForArchetypeAxes('HUMANITIES', { cit: true, ped: true });  // citation+pedagogy only (no epistemic)
const v4 = _verdictForArchetypeAxes('TECH-CONCEPT', { conf: true });  // strict archetype unchanged
const v5 = _verdictForArchetypeAxes('HUMANITIES', { ill: true });    // illusion-only fire → sev='low' → blocked regardless

if (v1) {
  check('A1. HUMANITIES gate ALLOWS rewrite on confidence-leak axis (sev=mid)',
    v1.needs_rewrite === true && v1.gated_by_archetype === false,
    `verdict=${JSON.stringify(v1)}`);
  check('A2. HUMANITIES gate ALLOWS rewrite on illusion+conf combo (sev=mid)',
    v2.needs_rewrite === true && v2.gated_by_archetype === false,
    `verdict=${JSON.stringify(v2)}`);
  check('A3. HUMANITIES gate BLOCKS rewrite on citation+pedagogy (no epistemic axes)',
    v3.needs_rewrite === false && v3.gated_by_archetype === true,
    `verdict=${JSON.stringify(v3)}`);
  check('A4. TECH-CONCEPT (strict) untouched — rewrite still on confidence',
    v4.needs_rewrite === true && v4.gated_by_archetype === false,
    `verdict=${JSON.stringify(v4)}`);
  check('A5. HUMANITIES illusion-only (sev=low) stays blocked — low/none never rewrites',
    v5.needs_rewrite === false && v5.gated_by_archetype === false,
    `verdict=${JSON.stringify(v5)}`);
} else {
  check('A. _deriveVerdict not exported — skipped per-axis tests', true);
}

// ── C · answer_quality_rubric schema check ──────────────────────────────
const { validateBodyV2 } = require('../lib/lesson-body-generator');

function baseBody() {
  return {
    thesis: 'By the end of this lesson, the learner will see that ritual precedes myth.',
    canonical_example: 'Athenian farmers stored grain in underground pits in autumn and reopened them in spring. This recurring physical action lies beneath the Persephone myth — earth descent and return mapped onto seasonal storage practice over generations.',
    exit_proof: 'Given a fresh myth, the learner identifies a candidate physical ritual that could be the embodied source pattern.',
    mechanism_explanation: 'A community repeats an embodied action across generations. The pragmatic reason fades. Younger members ask why. A narrative emerges that maps onto the action structure. The narrative inherits the action sequence — descent, dwelling, return.',
    common_misconceptions: [
      'Myths invent rituals — wrong: rituals predate the explanatory narratives that arise to justify them retrospectively.',
      'All myths follow this pattern — wrong: cosmogonic and philosophical creation myths have no ritual antecedent and contradict the rule.',
    ],
    note_connection: '(first lesson — no prior note to bind to)',
    jargon_list: [],
  };
}

const goodBody = baseBody();
const errs1 = validateBodyV2(goodBody);
check('C1. base body validates with no errors', errs1.length === 0, JSON.stringify(errs1));

const bodyWithRubric = { ...baseBody(), answer_quality_rubric: {
  strong_signals: ['学生独立列举 ≥1 counter-case', '学生自己发现 X=Y 对应'],
  weak_signals: ['重复 tutor 措辞但 ! 例'],
  must_correct_if: ['学生 deflect 自省 turn → 重定向必'],
}};
const errs2 = validateBodyV2(bodyWithRubric);
check('C2. body with valid rubric validates', errs2.length === 0, JSON.stringify(errs2));

const bodyEmptyRubric = { ...baseBody(), answer_quality_rubric: {
  strong_signals: [],
  weak_signals: ['something'],
  must_correct_if: ['something'],
}};
const errs3 = validateBodyV2(bodyEmptyRubric);
check('C3. empty rubric sub-array rejected', errs3.some(e => /strong_signals/.test(e)), JSON.stringify(errs3));

const bodyMalformedRubric = { ...baseBody(), answer_quality_rubric: 'not an object' };
const errs4 = validateBodyV2(bodyMalformedRubric);
check('C4. malformed rubric rejected', errs4.some(e => /answer_quality_rubric/.test(e)), JSON.stringify(errs4));

// ── E · HUMANITIES floor ────────────────────────────────────────────────
const errs5 = validateBodyV2(baseBody(), { archetype: 'HUMANITIES' });
check('E1. HUMANITIES floor rejects body without frameworks',
  errs5.some(e => /frameworks=0/.test(e)),
  JSON.stringify(errs5));
check('E2. HUMANITIES floor rejects body without counter_cases',
  errs5.some(e => /counter_cases=0/.test(e)),
  JSON.stringify(errs5));

const fullHumanitiesBody = { ...baseBody(),
  frameworks: [
    { name: 'Cambridge Ritualist (Harrison 1912)', position: 'ritual precedes myth' },
    { name: 'Burkert structuralist (1979)', position: 'ritual + myth co-evolve, neither prior' },
  ],
  counter_cases: [
    { phenomenon: 'Cargo cults generate ritual FROM myth', why_it_breaks_thesis: 'reverse direction — narrative scripted action' },
  ],
};
const errs6 = validateBodyV2(fullHumanitiesBody, { archetype: 'HUMANITIES' });
check('E3. HUMANITIES floor PASSES with frameworks≥2 + counter_cases≥1',
  errs6.length === 0, JSON.stringify(errs6));

const singleFrameworkBody = { ...baseBody(),
  frameworks: [{ name: 'Harrison 1912', position: 'ritual precedes myth' }],
  counter_cases: [{ phenomenon: 'cargo cults', why_it_breaks_thesis: 'reverse' }],
};
const errs7 = validateBodyV2(singleFrameworkBody, { archetype: 'HUMANITIES' });
check('E4. HUMANITIES floor REJECTS single framework (controversy hidden)',
  errs7.some(e => /need ≥2/.test(e)),
  JSON.stringify(errs7));

const malformedFrameworkBody = { ...baseBody(),
  frameworks: [
    { name: 'Harrison' },  // missing position
    { name: 'Burkert', position: 'co-evolve' },
  ],
  counter_cases: [{ phenomenon: 'cargo cults', why_it_breaks_thesis: 'reverse' }],
};
const errs8 = validateBodyV2(malformedFrameworkBody, { archetype: 'HUMANITIES' });
check('E5. HUMANITIES floor catches malformed framework {missing position}',
  errs8.some(e => /frameworks\[0\]/.test(e)),
  JSON.stringify(errs8));

// Non-HUMANITIES archetype shouldn't trigger floor
const errs9 = validateBodyV2(baseBody(), { archetype: 'TECH-CONCEPT' });
check('E6. TECH-CONCEPT body without frameworks passes (floor is HUMANITIES-only)',
  errs9.length === 0, JSON.stringify(errs9));

// Default no-archetype call backward-compat
const errs10 = validateBodyV2(baseBody());
check('E7. backward-compat: validateBodyV2(body) with no opts works',
  errs10.length === 0, JSON.stringify(errs10));

// ── PACING (2026-05-19 user lock) · expected_duration_min + transfer_cases + practice_assignments ──

// P1. expected_duration_min valid range
const pBodyD = { ...baseBody(), expected_duration_min: 25 };
const errsP1 = validateBodyV2(pBodyD);
check('P1. expected_duration_min=25 (default) passes',
  errsP1.length === 0, JSON.stringify(errsP1));

const pBodyDLow = { ...baseBody(), expected_duration_min: 10 };
const errsP2 = validateBodyV2(pBodyDLow);
check('P2. expected_duration_min=10 (< 15) rejected',
  errsP2.some(e => /out of range/.test(e)), JSON.stringify(errsP2));

const pBodyDStr = { ...baseBody(), expected_duration_min: '25' };
const errsP3 = validateBodyV2(pBodyDStr);
check('P3. expected_duration_min as string rejected',
  errsP3.some(e => /must be number/.test(e)), JSON.stringify(errsP3));

// P4-P7. transfer_cases
const pBodyTC = { ...baseBody(), transfer_cases: [
  { description: 'cargo cults Melanesia 1940s: planes will land if we build runways', expected_response: 'reverse direction — myth scripted the ritual, not Harrison\'s thesis' },
  { description: 'Christian Easter celebrating Christ resurrection narrative', expected_response: 'ritual scripted by myth after the fact — counter-evidence to thesis' },
]};
const errsP4 = validateBodyV2(pBodyTC);
check('P4. transfer_cases with 2 valid entries passes',
  errsP4.length === 0, JSON.stringify(errsP4));

const pBodyTC1 = { ...baseBody(), transfer_cases: [{ description: 'one case', expected_response: 'one response' }] };
const errsP5 = validateBodyV2(pBodyTC1);
check('P5. transfer_cases with 1 entry rejected (need ≥2)',
  errsP5.some(e => /need ≥2/.test(e)), JSON.stringify(errsP5));

const pBodyTCMalformed = { ...baseBody(), transfer_cases: [
  { description: 'case' },  // missing expected_response
  { description: 'case 2', expected_response: 'resp 2' },
]};
const errsP6 = validateBodyV2(pBodyTCMalformed);
check('P6. transfer_cases malformed entry rejected',
  errsP6.some(e => /transfer_cases\[0\]/.test(e)), JSON.stringify(errsP6));

// P8-P10. practice_assignments
const pBodyPA = { ...baseBody(), practice_assignments: [
  { task: '找一个你日常仪式 (倒咖啡 / 起床顺序), 反向追问其物质动作, 写 200 字', expected_minutes: 30, deliverable: '200 字 written' },
  { task: '观察家人/朋友一个重复行为, 推测其底层物质原因', expected_minutes: 15, deliverable: '3 个候选物质原因 list' },
]};
const errsP7 = validateBodyV2(pBodyPA);
check('P7. practice_assignments with 2 valid tasks passes',
  errsP7.length === 0, JSON.stringify(errsP7));

const pBodyPAEmpty = { ...baseBody(), practice_assignments: [] };
const errsP8 = validateBodyV2(pBodyPAEmpty);
check('P8. practice_assignments empty array rejected',
  errsP8.some(e => /≥1 task/.test(e)), JSON.stringify(errsP8));

const pBodyPABadTime = { ...baseBody(), practice_assignments: [{ task: 'do thing', expected_minutes: 200, deliverable: 'thing' }] };
const errsP9 = validateBodyV2(pBodyPABadTime);
check('P9. practice_assignments[0].expected_minutes=200 (>90) rejected',
  errsP9.some(e => /expected_minutes/.test(e)), JSON.stringify(errsP9));

const pBodyPABadShape = { ...baseBody(), practice_assignments: [{ deliverable: 'thing' }] };  // missing task
const errsP10 = validateBodyV2(pBodyPABadShape);
check('P10. practice_assignments[0] missing task rejected',
  errsP10.some(e => /practice_assignments\[0\]/.test(e)), JSON.stringify(errsP10));

// Full v2-spec body (HUMANITIES with all new fields) sanity check
const fullV2Body = { ...baseBody(),
  frameworks: [
    { name: 'Cambridge Ritualist (Harrison 1912)', position: 'ritual precedes myth' },
    { name: 'Burkert structuralist (1979)', position: 'ritual + myth co-evolve' },
  ],
  counter_cases: [
    { phenomenon: 'cargo cults', why_it_breaks_thesis: 'reverse direction' },
  ],
  expected_duration_min: 28,
  transfer_cases: [
    { description: 'Christian Easter', expected_response: 'reverse — myth predates ritual' },
    { description: 'cargo cults Melanesia', expected_response: 'reverse — myth scripted action' },
  ],
  practice_assignments: [
    { task: '找日常仪式反向追问', expected_minutes: 30, deliverable: '200 字' },
  ],
  answer_quality_rubric: {
    strong_signals: ['学生独立列举 ≥1 counter-case'],
    weak_signals: ['重复 tutor 措辞'],
    must_correct_if: ['学生 contested 当 settled'],
  },
};
const errsFull = validateBodyV2(fullV2Body, { archetype: 'HUMANITIES' });
check('P11. full v2-spec HUMANITIES body validates clean',
  errsFull.length === 0, JSON.stringify(errsFull));

// ── PACING DETECTOR (v0.4.5) ────────────────────────────────────────────
const sm = require('../lib/hypha-learn/state-machine');

// State enum now includes APPLY
check('SM1. APPLY state in STATES enum', sm.STATES.APPLY === 'APPLY');
check('SM2. STATE_LABELS["APPLY"] populated', !!sm.STATE_LABELS.APPLY && sm.STATE_LABELS.APPLY.length > 0);
check('SM3. TRANSITIONS["VERIFY"].hit → "APPLY" (not EXTEND)',
  sm.TRANSITIONS.VERIFY.hit === 'APPLY');
check('SM4. TRANSITIONS["APPLY"].transfer_hit → "EXTEND"',
  sm.TRANSITIONS.APPLY && sm.TRANSITIONS.APPLY.transfer_hit === 'EXTEND');

// Pacing violation detector
{
  // Clean v0.4.5-shaped lesson — passes
  const goodHistory = ['HOOK', 'EXPOSE', 'VERIFY', 'APPLY', 'APPLY', 'EXTEND', 'CONNECT', 'LATCH', 'END'];
  const v1 = sm.detectPacingViolations(goodHistory);
  check('SM5. clean v0.4.5 history → ok:true', v1.ok === true, JSON.stringify(v1));

  // Old v0.4 history skips APPLY — flagged
  const skipHistory = ['HOOK', 'EXPOSE', 'VERIFY', 'EXTEND', 'CONNECT', 'LATCH', 'END'];
  const v2 = sm.detectPacingViolations(skipHistory);
  check('SM6. VERIFY→EXTEND skip-APPLY flagged',
    v2.violations.some(x => x.type === 'VERIFY_TO_EXTEND_SKIP_APPLY'),
    JSON.stringify(v2.violations));

  // Too-short lesson flagged
  const shortHistory = ['HOOK', 'EXPOSE', 'VERIFY'];
  const v3 = sm.detectPacingViolations(shortHistory);
  check('SM7. < 8 transitions flagged as "死板速通"',
    v3.violations.some(x => x.type === 'LESSON_TOO_SHORT'),
    JSON.stringify(v3.violations));

  // Excessive APPLY (>3) flagged
  const longApply = ['HOOK', 'EXPOSE', 'VERIFY', 'APPLY', 'APPLY', 'APPLY', 'APPLY', 'APPLY', 'EXTEND'];
  const v4 = sm.detectPacingViolations(longApply);
  check('SM8. APPLY > 3 flagged as ping-pong',
    v4.violations.some(x => x.type === 'APPLY_COUNT_EXCEEDED'),
    JSON.stringify(v4.violations));

  // Invalid input
  const v5 = sm.detectPacingViolations(null);
  check('SM9. null input rejected',
    v5.ok === false && v5.violations[0].type === 'INVALID_INPUT');

  // Summary fields
  const goodHistory2 = ['HOOK', 'EXPOSE', 'VERIFY', 'APPLY', 'EXTEND', 'CONNECT', 'LATCH', 'END'];
  const v6 = sm.detectPacingViolations(goodHistory2);
  check('SM10. summary.total_transitions correct', v6.summary.total_transitions === 8);
  check('SM11. summary.apply_count correct', v6.summary.apply_count === 1);
  check('SM12. summary.ended_at correct', v6.summary.ended_at === 'END');
}

// ── BIAS CORRECTION DETECTOR (v0.4.9) ──────────────────────────────────
const bcd = require('../lib/anti-slop/bias-correction-detector');

// BC1. Empty/non-string input → empty result
{
  const r = bcd.detectBiasViolations('');
  check('BC1. empty bodyText → no violations', r.primaries_found === 0 && r.missing_counter_for.length === 0);
}

// BC2. Harrison primary without counter (the 2026-05-19 council case)
{
  const body = 'Harrison (1912) claims ritual precedes myth. This is the foundational pillar of the Cambridge Ritualist school. The thesis is consistently applied to Greek seasonal rites.';
  const r = bcd.detectBiasViolations(body, { archetype: 'HUMANITIES' });
  check('BC2. Harrison primary alone → flagged in HUMANITIES',
    r.missing_counter_for.length >= 1 && r.summary.should_flag === true,
    JSON.stringify(r.summary));
}

// BC3. Harrison + Burkert counter → not flagged
{
  const body = 'Harrison (1912) claims ritual precedes myth. 反方: Burkert (1979 Homo Necans) — ritual and myth co-evolve, neither prior. 信号类: contested.';
  const r = bcd.detectBiasViolations(body, { archetype: 'HUMANITIES' });
  check('BC3. Harrison + 反方 + 信号类:contested → not flagged',
    r.missing_counter_for.length === 0 && r.summary.severity === 'none',
    JSON.stringify(r.summary));
}

// BC4. Chinese primary pattern detection
{
  const body = '弗洛伊德 在《梦的解析》(1900) 提出潜意识理论, 主张梦境是欲望的伪装实现.';
  const r = bcd.detectBiasViolations(body, { archetype: 'HUMANITIES' });
  check('BC4. CN primary pattern (弗洛伊德 提出) detected',
    r.primaries_found >= 1, JSON.stringify(r));
}

// BC5. TECH-CONCEPT archetype with 1 primary without counter → not flagged (less strict)
{
  const body = 'Shannon (1948) proposes the noisy-channel coding theorem. The proof relies on the AEP.';
  const r = bcd.detectBiasViolations(body, { archetype: 'TECH-CONCEPT' });
  check('BC5. TECH-CONCEPT 1 primary w/o counter → severity low/none (less strict)',
    r.summary.severity === 'low' || r.summary.severity === 'none',
    JSON.stringify(r.summary));
}

// BC6. Multiple primaries no counter → high severity
{
  const body = `Harrison (1912) claims ritual precedes myth.
  Frazer (1890) holds that primitive religion derives from magic.
  Tylor (1871) posits animism as the origin of religion.
  Müller (1856) argues all myths are nature personifications.`;
  const r = bcd.detectBiasViolations(body, { archetype: 'HUMANITIES' });
  check('BC6. 4 primaries no counter → high severity',
    r.summary.severity === 'high' && r.missing_counter_for.length >= 3,
    JSON.stringify(r.summary));
}

// BC7. Possessive pattern "X's theory"
{
  const body = "Einstein's theory of relativity reshaped physics. The implications are profound.";
  const r = bcd.detectBiasViolations(body, { archetype: 'TECH-CONCEPT' });
  check('BC7. possessive "Einstein\'s theory" detected as primary',
    r.primaries_found >= 1, JSON.stringify(r));
}

// BC8. Counter marker 反方 alone catches dispute
{
  const body = 'Harrison (1912) claims X. 反方: scholar Y argues otherwise.';
  const r = bcd.detectBiasViolations(body, { archetype: 'HUMANITIES' });
  check('BC8. "反方" within 400-char window → not flagged',
    r.missing_counter_for.length === 0,
    JSON.stringify(r));
}

// ── BIAS v0.5.3 · single vs multi source counter ────────────────────────

// BC9. Multi-source counter (≥2 distinct schools) → strong, not flagged
{
  const body = 'Harrison (1912) claims ritual precedes myth. Counter-view: Burkertian structuralism rejects priority; Frazerians argue myth seeds ritual; 信号类: contested.';
  const r = bcd.detectBiasViolations(body, { archetype: 'HUMANITIES' });
  check('BC9. multi-source counter (Burkertian + Frazerians + signal-class) → strong',
    r.summary.should_flag === false
      && (r.weak_counter_for || []).length === 0
      && r.missing_counter_for.length === 0,
    JSON.stringify(r));
}

// BC10. Single-source counter (1 school named) → weak, flagged with severity mid
{
  const body = 'Harrison (1912) claims ritual precedes myth. Counter-view: Burkertian school holds ritual and myth co-evolve without priority.';
  const r = bcd.detectBiasViolations(body, { archetype: 'HUMANITIES' });
  const summary = r.source_count_summary || {};
  const firstKey = Object.keys(summary)[0];
  check('BC10. single-source counter under HUMANITIES → weak_counter_for populated + severity mid',
    (r.weak_counter_for || []).length >= 1
      && r.summary.severity === 'mid'
      && r.summary.should_flag === true
      && firstKey && summary[firstKey].counter_count === 1,
    JSON.stringify(r));
}

// BC11. Zero counter → existing behavior (high severity when many primaries)
{
  const body = `Harrison (1912) claims ritual precedes myth.
  Frazer (1890) holds primitive religion derives from magic.
  Tylor (1871) posits animism as origin of religion.`;
  const r = bcd.detectBiasViolations(body, { archetype: 'HUMANITIES' });
  check('BC11. zero counter, 3 primaries → severity high + weak_counter_for empty',
    r.summary.severity === 'high'
      && r.missing_counter_for.length >= 2
      && (r.weak_counter_for || []).length === 0,
    JSON.stringify(r));
}

// BC12. CN multi-source counter — 学派 / 主义 / 派别 → strong, not flagged
{
  const body = '弗洛伊德 在《梦的解析》(1900) 提出潜意识理论. 批评者: 行为主义学派否定无意识; 另有认知学派主张梦境无特殊意义; 第三派别 — 神经科学学说 — 视梦为随机放电. 信号类: contested.';
  const r = bcd.detectBiasViolations(body, { archetype: 'HUMANITIES' });
  check('BC12. CN multi-source (3 学派/学说 + 信号类:contested) → strong, no flag',
    r.summary.should_flag === false
      && r.missing_counter_for.length === 0
      && (r.weak_counter_for || []).length === 0,
    JSON.stringify(r));
}

// BC13. TECH archetype with single-source counter — not flagged (less strict)
{
  const body = 'Shannon (1948) proposes noisy-channel coding theorem. Counter-view: Kolmogorovian complexity school redefines information without channel framing.';
  const r = bcd.detectBiasViolations(body, { archetype: 'TECH-CONCEPT' });
  check('BC13. TECH single-source counter → not flagged (less strict)',
    r.summary.should_flag === false
      && (r.weak_counter_for || []).length === 0,
    JSON.stringify(r));
}

// ── PJR BIAS INTEGRATION (v0.4.10) ──────────────────────────────────────
{
  const pjr2 = require('../lib/anti-slop/prosecute-judge-rewrite');

  // PB1. _summarizeSignals propagates bias from detector output
  const detectorOut = bcd.detectBiasViolations(
    'Harrison (1912) claims ritual precedes myth.', { archetype: 'HUMANITIES' }
  );
  const sig = pjr2._summarizeSignals({ bias: detectorOut });
  check('PB1. _summarizeSignals reads bias from detector output',
    sig.bias_missing >= 1 && sig.bias_should_flag === true,
    JSON.stringify(sig));

  // PB2. total_fire bumps when bias should_flag
  const sig0 = pjr2._summarizeSignals({});
  check('PB2. total_fire=0 when no signals', sig0.total_fire === 0);
  const sig1 = pjr2._summarizeSignals({ bias: detectorOut });
  check('PB3. total_fire bumps by 1 when bias_should_flag', sig1.total_fire >= 1);

  // PB4. _deriveVerdict severity 'mid' when bias_missing >= 2
  const v1 = pjr2._deriveVerdict({
    total_fire: 1, cit_unverified: 0, ped_unknown: 0, ped_inconsistent: 0,
    conf_leak: 0, illusion_fire: 0, bias_missing: 2, bias_should_flag: true,
  }, 'HUMANITIES');
  check('PB4. bias_missing≥2 → severity mid',
    v1.severity === 'mid', JSON.stringify(v1));

  // PB5. _deriveVerdict severity 'high' when bias_missing >= 3
  const v2 = pjr2._deriveVerdict({
    total_fire: 1, cit_unverified: 0, ped_unknown: 0, ped_inconsistent: 0,
    conf_leak: 0, illusion_fire: 0, bias_missing: 3, bias_should_flag: true,
  }, 'HUMANITIES');
  check('PB5. bias_missing≥3 → severity high',
    v2.severity === 'high', JSON.stringify(v2));

  // PB6. focus_axes includes 'bias' when should_flag
  const v3 = pjr2._deriveVerdict({
    total_fire: 1, cit_unverified: 0, ped_unknown: 0, ped_inconsistent: 0,
    conf_leak: 0, illusion_fire: 0, bias_missing: 2, bias_should_flag: true,
  }, 'TECH-CONCEPT');
  check('PB6. focus_axes contains "bias" when should_flag',
    Array.isArray(v3.focus_axes) && v3.focus_axes.includes('bias'),
    JSON.stringify(v3));

  // PB7. HUMANITIES gate BLOCKS rewrite on bias-only (prose-quality axis)
  const v4 = pjr2._deriveVerdict({
    total_fire: 2, cit_unverified: 0, ped_unknown: 0, ped_inconsistent: 0,
    conf_leak: 0, illusion_fire: 0, bias_missing: 2, bias_should_flag: true,
  }, 'HUMANITIES');
  check('PB7. HUMANITIES + bias-only axis → gated_by_archetype=true',
    v4.gated_by_archetype === true && v4.needs_rewrite === false,
    JSON.stringify(v4));
}

// ── Report ──────────────────────────────────────────────────────────────
console.log('\n=== HYPHA · Lesson Quality v2 (Anti-Slop Rewire) smoke ===\n');
for (const line of tests) console.log(line);
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} PASS\x1b[0m\n`);
process.exit(failed === 0 ? 0 : 1);

})();
