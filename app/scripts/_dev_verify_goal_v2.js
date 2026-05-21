#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_goal_v2 — smoke for Goal System v0.12 (88% → 95% push).
//
// Validates:
//   1. Feasibility confidence_band + context_sparsity (additive to classifyFeasibility)
//   2. Single↔chain dispatcher soft threshold (0.65-0.75 ambiguous zone)
//   3. Drift Detector 3-axis composite (semantic + register + success-criteria)
//   4. Goal Crystallizer Q quality scorer (info_gain - redundancy)
//
// 15+ checks, no LLM (pure JS / stubbed). Exit 0 on PASS N/N, 1 on any FAIL.

const path = require('path');

let pass = 0;
let fail = 0;
const fails = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    fails.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Suite 1 — Feasibility confidence band + context sparsity
// ─────────────────────────────────────────────────────────────────────────

console.log('\n[1] Feasibility confidence band + context sparsity');

const feasibility = require(path.join(__dirname, '..', 'lib', 'feasibility.js'));

const denseSpec = {
  targetDifficulty: 0.6,
  priorKnowledge: 0.2,
  timeWeeks: 12,
  dailyHours: 2,
  intrinsicLoad: 'med',
  priorConsistency: 4,
  failedAttempts: 0,
  alpha: 1.7,
};
const sparseSpec = { targetDifficulty: 0.6 };

const dense = feasibility.classifyFeasibility(denseSpec);
const sparse = feasibility.classifyFeasibility(sparseSpec);

check('1.1 classifyFeasibility returns confidence_band array of length 2',
  Array.isArray(dense.confidence_band) && dense.confidence_band.length === 2,
  `got ${JSON.stringify(dense.confidence_band)}`);

check('1.2 confidence_band low <= pComplete <= high',
  dense.confidence_band[0] <= dense.pComplete && dense.pComplete <= dense.confidence_band[1],
  `band=${JSON.stringify(dense.confidence_band)} p=${dense.pComplete}`);

check('1.3 dense spec has low context_sparsity (< 0.25)',
  typeof dense.context_sparsity === 'number' && dense.context_sparsity < 0.25,
  `got ${dense.context_sparsity}`);

check('1.4 sparse spec has high context_sparsity (> 0.5)',
  typeof sparse.context_sparsity === 'number' && sparse.context_sparsity > 0.5,
  `got ${sparse.context_sparsity}`);

check('1.5 sparse band wider than dense band',
  (sparse.confidence_band[1] - sparse.confidence_band[0]) > (dense.confidence_band[1] - dense.confidence_band[0]),
  `sparse=${sparse.confidence_band[1] - sparse.confidence_band[0]} dense=${dense.confidence_band[1] - dense.confidence_band[0]}`);

check('1.6 dense spec verdict_strength === "committed"',
  dense.verdict_strength === 'committed',
  `got ${dense.verdict_strength}`);

check('1.7 sparse spec suggest_more_context === true',
  sparse.suggest_more_context === true,
  `got ${sparse.suggest_more_context}`);

check('1.8 backward-compat: old fields (tier / pComplete / ratio / confidence) still present',
  dense.tier && typeof dense.pComplete === 'number' && dense.ratio && dense.confidence,
  'one of the old fields missing');

check('1.9 SPARSITY_FIELDS exported as array of 8',
  Array.isArray(feasibility.SPARSITY_FIELDS) && feasibility.SPARSITY_FIELDS.length === 8,
  `got ${JSON.stringify(feasibility.SPARSITY_FIELDS)}`);

// ─────────────────────────────────────────────────────────────────────────
// Suite 2 — Soft-threshold dispatcher
// ─────────────────────────────────────────────────────────────────────────

console.log('\n[2] route-goal soft threshold');

const routeGoalMod = require(path.join(__dirname, '..', 'lib', 'creation', 'route-goal.js'));
const { routeGoal, DIFFICULTY_AMBIGUOUS_LOW, DIFFICULTY_AMBIGUOUS_HIGH } = routeGoalMod;

check('2.1 DIFFICULTY_AMBIGUOUS_LOW === 0.65',
  DIFFICULTY_AMBIGUOUS_LOW === 0.65,
  `got ${DIFFICULTY_AMBIGUOUS_LOW}`);

check('2.2 DIFFICULTY_AMBIGUOUS_HIGH === 0.75',
  DIFFICULTY_AMBIGUOUS_HIGH === 0.75,
  `got ${DIFFICULTY_AMBIGUOUS_HIGH}`);

// Stub goal-guardian via Module._resolveFilename so difficulty is deterministic
const Module = require('module');
const ggPath = path.join(__dirname, '..', 'lib', 'creation', 'goal-guardian.js');
const realResolve = Module._resolveFilename;
let stubDifficulty = 0.7;
Module._resolveFilename = function (req, parent, ...rest) {
  if (req === './goal-guardian' || req === ggPath) {
    return path.join(__dirname, '__stub_goal_guardian.js');
  }
  if (req === './expected-years-estimator') {
    return path.join(__dirname, '__stub_estimator.js');
  }
  return realResolve.call(this, req, parent, ...rest);
};
// Synthesize stubs in require cache
require.cache[path.join(__dirname, '__stub_goal_guardian.js')] = {
  id: '__stub_goal_guardian',
  filename: '__stub_goal_guardian',
  loaded: true,
  exports: { _estimateDifficulty: () => stubDifficulty },
};
require.cache[path.join(__dirname, '__stub_estimator.js')] = {
  id: '__stub_estimator',
  filename: '__stub_estimator',
  loaded: true,
  exports: { estimate: async () => ({ conservative_years: 5, evidence: [] }) },
};

(async () => {
  // 2.3 — softThreshold off (backward-compat): 0.7 difficulty + 5y → chain
  stubDifficulty = 0.7;
  const r1 = await routeGoal({ goalContract: { north_star_goal: 'x' } });
  check('2.3 default mode (no softThreshold) at d=0.7,y=5 → chain',
    r1.flow === 'chain' && r1.zone === undefined,
    `got flow=${r1.flow} zone=${r1.zone}`);

  // 2.4 — softThreshold ON, ambiguous zone: d=0.7 → ambiguous
  stubDifficulty = 0.7;
  const r2 = await routeGoal({ goalContract: { north_star_goal: 'x' }, softThreshold: true });
  check('2.4 softThreshold + d=0.7 (years=5) → flow=ambiguous',
    r2.flow === 'ambiguous' && r2.zone === 'ambiguous',
    `got flow=${r2.flow} zone=${r2.zone}`);

  check('2.5 ambiguous result lists alternatives [single, chain]',
    Array.isArray(r2.alternatives) && r2.alternatives.includes('single') && r2.alternatives.includes('chain'),
    `got ${JSON.stringify(r2.alternatives)}`);

  // 2.6 — softThreshold ON, definite chain at d=0.8
  stubDifficulty = 0.8;
  const r3 = await routeGoal({ goalContract: { north_star_goal: 'x' }, softThreshold: true });
  check('2.6 softThreshold + d=0.8 → flow=chain',
    r3.flow === 'chain',
    `got flow=${r3.flow}`);

  // 2.7 — softThreshold ON, definite single at d=0.5
  stubDifficulty = 0.5;
  const r4 = await routeGoal({ goalContract: { north_star_goal: 'x' }, softThreshold: true });
  check('2.7 softThreshold + d=0.5 → flow=single',
    r4.flow === 'single',
    `got flow=${r4.flow}`);

  // 2.8 — reason string mentions ambiguous band
  stubDifficulty = 0.72;
  const r5 = await routeGoal({ goalContract: { north_star_goal: 'x' }, softThreshold: true });
  check('2.8 ambiguous reason mentions threshold band',
    typeof r5.reason === 'string' && r5.reason.includes('0.65') && r5.reason.includes('0.75'),
    `got "${r5.reason}"`);

  // Restore resolver before next suite
  Module._resolveFilename = realResolve;

  // ─────────────────────────────────────────────────────────────────────────
  // Suite 3 — Drift Detector multi-axis composite
  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n[3] Goal drift detector multi-axis');

  const drift = require(path.join(__dirname, '..', 'lib', 'goal-drift-detector.js'));

  // 3.1 — detectDriftMultiAxis exported
  check('3.1 detectDriftMultiAxis exported',
    typeof drift.detectDriftMultiAxis === 'function',
    `typeof=${typeof drift.detectDriftMultiAxis}`);

  // 3.2 — backward compat: detectDrift still works
  const oldOut = drift.detectDrift({ north_star_goal: '写小说' }, { objective: '学习写作' });
  check('3.2 detectDrift backward-compat returns drift_score + axes',
    typeof oldOut.drift_score === 'number' && oldOut.axes && typeof oldOut.axes.vocab === 'number',
    JSON.stringify(oldOut).slice(0, 80));

  // 3.3 — multi-axis returns composite_score + axes_composite + composite_verdict
  const multi = drift.detectDriftMultiAxis(
    { north_star_goal: '写一部短篇小说集', archetype: 'HUMANITIES', success_test: '写出 6 篇短篇小说' },
    { objective: '学习短篇小说的结构与人物', body: '本节我们看看川端康成的笔法' }
  );
  check('3.3 multi-axis has composite_score + axes_composite + composite_verdict',
    typeof multi.composite_score === 'number' &&
      multi.axes_composite &&
      typeof multi.axes_composite.semantic === 'number' &&
      typeof multi.axes_composite.epistemic_register === 'number' &&
      typeof multi.axes_composite.success_criteria_alignment === 'number' &&
      ['low', 'moderate', 'high'].includes(multi.composite_verdict),
    JSON.stringify(multi).slice(0, 200));

  // 3.4 — register drift: HUMANITIES goal vs TECH lesson body → epistemic_register > 0.4
  const registerDrifty = drift.detectDriftMultiAxis(
    { north_star_goal: '写一部小说', archetype: 'HUMANITIES' },
    { objective: '学习 API deployment', body: '本节讲 function / algorithm / compile / deploy / api / sdk' }
  );
  check('3.4 HUMANITIES goal + TECH lesson → epistemic_register > 0.4',
    registerDrifty.axes_composite.epistemic_register > 0.4,
    `got ${registerDrifty.axes_composite.epistemic_register}`);

  // 3.5 — register drift: HUMANITIES goal + HUMANITIES lesson → epistemic_register ~ 0
  const registerAligned = drift.detectDriftMultiAxis(
    { north_star_goal: '写小说', archetype: 'HUMANITIES' },
    { objective: '学习叙事 / 隐喻 / 诗 的运用', body: '诗 散文 小说' }
  );
  check('3.5 HUMANITIES goal + HUMANITIES lesson → epistemic_register === 0',
    registerAligned.axes_composite.epistemic_register === 0,
    `got ${registerAligned.axes_composite.epistemic_register}`);

  // 3.6 — success criteria alignment: lesson references stated success_test → low drift
  const criteriaAligned = drift.detectDriftMultiAxis(
    { north_star_goal: '写小说', success_test: '完成 6 篇短篇小说', archetype: 'HUMANITIES' },
    { objective: '本节学习写短篇小说的开头', body: '我们将完成第一篇短篇' }
  );
  check('3.6 success_criteria_alignment when lesson cites criteria tokens → < 0.5',
    criteriaAligned.axes_composite.success_criteria_alignment < 0.5,
    `got ${criteriaAligned.axes_composite.success_criteria_alignment}`);

  // 3.7 — composite score in [0,1]
  check('3.7 composite_score in [0,1]',
    multi.composite_score >= 0 && multi.composite_score <= 1,
    `got ${multi.composite_score}`);

  // ─────────────────────────────────────────────────────────────────────────
  // Suite 4 — Goal Crystallizer Q quality scorer
  // ─────────────────────────────────────────────────────────────────────────

  console.log('\n[4] Goal crystallizer Q quality scorer');

  const xtal = require(path.join(__dirname, '..', 'lib', 'creation', 'goal-crystallizer.js'));

  check('4.1 scoreQuestions + filterByQuality + QUALITY_FLOOR exported',
    typeof xtal.scoreQuestions === 'function' &&
      typeof xtal.filterByQuality === 'function' &&
      typeof xtal.QUALITY_FLOOR === 'number',
    `floor=${xtal.QUALITY_FLOOR}`);

  // 4.2 — high-quality Q (named instances + rationale + dimension + 4 distinct options + short stem) scores high
  const highQ = {
    id: 'q_lineage',
    prompt: '你想学谁的笔法?',
    rationale: '流派师承决定 corpus 选择',
    dimension: '流派师承',
    options: [
      { id: 'a', label: '川端康成式静默', implies: 'kawabata' },
      { id: 'b', label: '加缪式荒诞存在', implies: 'camus' },
      { id: 'c', label: '马尔克斯式魔幻现实', implies: 'marquez' },
      { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
    ],
  };
  const scoresHigh = xtal.scoreQuestions([highQ]);
  check('4.2 high-quality Q scores >= 0.7',
    scoresHigh.length === 1 && scoresHigh[0].score >= 0.7,
    `got ${JSON.stringify(scoresHigh[0])}`);

  // 4.3 — low-quality Q (abstract options + no rationale + no dimension) scores low
  const lowQ = {
    id: 'q_bad',
    prompt: '深度目标?',
    options: [
      { id: 'a', label: '浅', implies: 'shallow' },
      { id: 'b', label: '中', implies: 'mid' },
      { id: 'c', label: '深', implies: 'deep' },
      { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
    ],
  };
  const scoresLow = xtal.scoreQuestions([lowQ]);
  check('4.3 abstract-category Q scores < QUALITY_FLOOR (0.4)',
    scoresLow[0].score < xtal.QUALITY_FLOOR,
    `got ${JSON.stringify(scoresLow[0])}`);

  // 4.4 — filterByQuality keeps high, drops low
  const filt = xtal.filterByQuality([highQ, lowQ]);
  check('4.4 filterByQuality keeps high-quality, drops low-quality',
    filt.kept.length === 1 && filt.dropped.length === 1 && filt.kept[0].id === 'q_lineage',
    `kept=${filt.kept.length} dropped=${filt.dropped.length}`);

  // 4.5 — redundancy penalty: 2 questions with overlapping stem+dimension reduce 2nd Q's score
  const redQ1 = { ...highQ, id: 'q_red1' };
  const redQ2 = {
    id: 'q_red2',
    prompt: '你想学谁的笔法?',  // same as Q1
    rationale: 'same',
    dimension: '流派师承',         // same
    options: highQ.options,
  };
  const redScores = xtal.scoreQuestions([redQ1, redQ2]);
  check('4.5 redundancy penalty applied to 2nd identical Q',
    redScores[1].redundancy_penalty > 0,
    `red_pen=${redScores[1].redundancy_penalty}`);

  // 4.6 — score = info_gain - redundancy_penalty (within rounding)
  check('4.6 score = max(0, info_gain - redundancy_penalty) within rounding',
    Math.abs(redScores[1].score - Math.max(0, Math.min(1, redScores[1].info_gain - redScores[1].redundancy_penalty))) < 0.02,
    `score=${redScores[1].score} ig=${redScores[1].info_gain} rp=${redScores[1].redundancy_penalty}`);

  // 4.7 — _meta has quality_scores + low_quality_count when called via stub
  // Stub-test the full path: install LLM stub returning lowQ Qs, check _meta carries quality_scores.
  const llmPath = path.join(__dirname, '..', 'lib', 'llm');
  const realLLM = require.cache[require.resolve(llmPath)];
  require.cache[require.resolve(llmPath)] = {
    id: llmPath,
    filename: llmPath,
    loaded: true,
    exports: {
      executeChat: async () => ({
        providerId: 'stub',
        model: 'stub',
        result: {
          questions: [highQ, { ...highQ, id: 'q2' }, { ...highQ, id: 'q3' }],
          confidence: 0.8,
        },
      }),
    },
  };
  // Force xtal module to re-pick up by clearing its cache then re-requiring.
  delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'creation', 'goal-crystallizer.js'))];
  const xtalReload = require(path.join(__dirname, '..', 'lib', 'creation', 'goal-crystallizer.js'));
  const result = await xtalReload.generateCrystallizerQuestions({ draftGoal: '写小说', archetype: 'HUMANITIES' });
  check('4.7 generateCrystallizerQuestions _meta.quality_scores present + length matches questions',
    result.ok && Array.isArray(result._meta.quality_scores) && result._meta.quality_scores.length === result.questions.length,
    `ok=${result.ok} meta=${JSON.stringify(result._meta && { qs: result._meta.quality_scores && result._meta.quality_scores.length, n: result.questions && result.questions.length })}`);

  check('4.8 generateCrystallizerQuestions _meta has low_quality_count + quality_floor + regenerated_for_quality',
    typeof result._meta.low_quality_count === 'number' &&
      typeof result._meta.quality_floor === 'number' &&
      typeof result._meta.regenerated_for_quality === 'boolean',
    `meta=${JSON.stringify({ lqc: result._meta.low_quality_count, qf: result._meta.quality_floor, rfq: result._meta.regenerated_for_quality })}`);

  // Restore real LLM cache
  if (realLLM) require.cache[require.resolve(llmPath)] = realLLM;
  else delete require.cache[require.resolve(llmPath)];

  console.log(`\n${pass}/${pass + fail} ${fail === 0 ? 'PASS' : 'FAIL'}`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of fails) console.log(`  - ${f.name}${f.detail ? ': ' + f.detail : ''}`);
    process.exit(1);
  }
  process.exit(0);
})().catch(err => {
  console.error('UNHANDLED', err);
  process.exit(2);
});
