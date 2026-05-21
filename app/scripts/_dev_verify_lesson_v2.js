#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_lesson_v2 — Lesson System rc.1 → 1.0 push smoke.
//
// Validates 5 deliverables landed for the 92% → 97% push:
//   1. Anti-Slop P2 meta-coherence detector (LV1-LV4)
//   2. Lesson Brief 11-field per-field quality validator (LV5-LV9)
//   3. Archetype-aware completeness audit — re-verifies PJR archetype gate
//      coverage across HUMANITIES / LANG-ACQ / MINDSET / TECH variants (LV10-LV12)
//   4. Concept-Ledger drift event emitter to vault/.hypha/concept-drift.jsonl (LV13-LV15)
//   5. Encyclopedia-opener regex bank — DICTIONARY / ACADEMIC / META_TEXTBOOK (LV16-LV21)
//
// All read-only library calls + tmpdir scratch space; no production vault writes.

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const tests = [];
let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  PASS  ${name}`); }
  else      { failed++; tests.push(`  FAIL  ${name}${extra ? '\n        ' + extra : ''}`); }
}
function mkScratch(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hypha-lesson-v2-${label}-`));
}
function rmScratch(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

// ─── 1. Anti-Slop P2 Meta-Coherence ──────────────────────────────────────
const mc = require('../lib/anti-slop/meta-coherence-detector');

// LV1: aligned body — summary tokens covered by body → high score, not flagged.
{
  const body = {
    thesis: '由此可见 实体 通过 自因 推出 唯一性',
    exit_proof: '用 自因 与 唯一性 解释 笛卡尔 二元 不成立',
    mechanism_explanation: '自因 是 实体 的根本属性 因此 实体 通过 自因 推出 无限性 进而 推出 唯一性 不可分性',
    canonical_example: '斯宾诺莎 在 伦理学 第一部分 用 自因 论证 实体 唯一性',
    common_misconceptions: [
      { wrong: '二元', why_wrong: '笛卡尔 把 心灵 与 物质 当 两个实体', correct: '实际上 实体 只能唯一 二元 违 自因' },
    ],
  };
  const r = mc.detectMetaCoherence(body);
  check('LV1 aligned summary↔body → score ≥ 0.5 + not flagged',
    r.score >= 0.5 && r.flagged === false, JSON.stringify(r));
}

// LV2: drifted body — thesis talks about X, body talks about Y → low score, flagged.
{
  const body = {
    thesis: 'machine learning gradient descent backpropagation',
    exit_proof: 'derive backpropagation from chain rule',
    mechanism_explanation: '斯宾诺莎 自因 实体 伦理学 唯一性 不可分性',
    canonical_example: '十七世纪 荷兰 哲学家 斯宾诺莎 写 伦理学',
    common_misconceptions: [],
  };
  const r = mc.detectMetaCoherence(body);
  check('LV2 drifted summary↔body → score < 0.5 + flagged',
    r.score < 0.5 && r.flagged === true, JSON.stringify(r));
}

// LV3: edge case — empty summary returns 1.0 (vacuous), not flagged.
{
  const r = mc.detectMetaCoherence({
    thesis: '',
    mechanism_explanation: '一些 实质 内容 在这里',
  });
  check('LV3 empty summary → vacuously 1.0 + not flagged',
    r.score === 1 && r.flagged === false && r.reason === 'empty_summary');
}

// LV4: edge case — empty body returns 0, flagged.
{
  const r = mc.detectMetaCoherence({
    thesis: '实体 唯一性',
    mechanism_explanation: '',
    canonical_example: '',
  });
  check('LV4 empty body → 0 + flagged',
    r.score === 0 && r.flagged === true && r.reason === 'empty_body');
}

// ─── 2. Lesson Brief 11-Field per-Field Quality Validator ────────────────
const bq = require('../lib/lesson-brief-field-validator');

// LV5: thesis encyclopedia filler rejected.
{
  const body = {
    thesis: 'An introduction to the philosophical concept of substance.',
    exit_proof: 'apply the substance argument to a fresh case',
    mechanism_explanation: '通过 self-causation 推出 substance is unique because it 是自因',
    canonical_example: 'Spinoza in 1677 wrote Ethics on substance.',
    common_misconceptions: [
      { wrong: 'two substances', why_wrong: 'Cartesian dualism asserts mind+matter', correct: 'actually substance must be unique' },
    ],
  };
  const r = bq.validateBriefQuality(body, { strict: true });
  check('LV5 thesis "An introduction to ..." → strict error',
    r.ok === false && r.errors.some(e => e.field === 'thesis' && e.rule === 'encyclopedia_filler'),
    JSON.stringify(r));
}

// LV6: exit_proof without measurable verb rejected.
{
  const body = {
    thesis: 'learners 将能 derive substance uniqueness from self-causation',
    exit_proof: '让学生 知道 这个 概念 大概的样子',  // no measurable verb
    mechanism_explanation: '自因 因此 推出 唯一性',
    canonical_example: 'Spinoza 1677 in Ethics part 1 提出',
    common_misconceptions: [{ wrong: 'a', why_wrong: 'b', correct: '实际上 c' }],
  };
  const r = bq.validateBriefQuality(body, { strict: true });
  check('LV6 exit_proof with no measurable verb → strict error',
    r.ok === false && r.errors.some(e => e.field === 'exit_proof' && e.rule === 'no_measurable_verb'),
    JSON.stringify(r));
}

// LV7: mechanism without causal connector rejected.
{
  const body = {
    thesis: '学生 将能 apply 自因 论证',
    exit_proof: '用 自因 推导 唯一性',
    mechanism_explanation: '实体 自因 唯一性 不可分性 — 一些描述',  // no causal connector
    canonical_example: 'Spinoza Ethics 1677',
    common_misconceptions: [{ wrong: 'a', why_wrong: 'b', correct: 'actually c' }],
  };
  const r = bq.validateBriefQuality(body, { strict: true });
  check('LV7 mechanism without causal connector → strict error',
    r.ok === false && r.errors.some(e => e.field === 'mechanism_explanation' && e.rule === 'no_causal_connector'),
    JSON.stringify(r));
}

// LV8: canonical_example without specific anchor rejected.
{
  const body = {
    thesis: '学生 将能 apply 自因 论证',
    exit_proof: 'derive 唯一性 from 自因',
    mechanism_explanation: '自因 因此 推出 唯一性',
    canonical_example: 'imagine a system with substance and consider how it behaves under standard rules',  // generic, no named entity / number
    common_misconceptions: [{ wrong: 'a', why_wrong: 'b', correct: 'actually c' }],
  };
  const r = bq.validateBriefQuality(body, { strict: true });
  check('LV8 generic canonical_example → strict error',
    r.ok === false && r.errors.some(e => e.field === 'canonical_example' && e.rule === 'not_specific'),
    JSON.stringify(r));
}

// LV9: misconception.correct without corrective signal rejected.
{
  const body = {
    thesis: '学生 将能 apply 自因 论证',
    exit_proof: 'derive 唯一性 from 自因',
    mechanism_explanation: '自因 因此 推出 唯一性',
    canonical_example: 'Spinoza Ethics 1677',
    common_misconceptions: [
      { wrong: '二元', why_wrong: '笛卡尔', correct: '实体 是 唯一 的' },  // no corrective signal
    ],
  };
  const r = bq.validateBriefQuality(body, { strict: true });
  check('LV9 misconception.correct without signal → strict error',
    r.ok === false && r.errors.some(e => e.field.startsWith('common_misconceptions[') && e.rule === 'no_corrective_signal'),
    JSON.stringify(r));
}

// ─── 3. Archetype-aware completeness audit (PJR gate coverage) ───────────
const pjr = require('../lib/anti-slop/prosecute-judge-rewrite');

// LV10: All 4 archetypes (HUMANITIES / LANG-ACQ / MINDSET / TECH variants)
// have explicit handling in either STRICT_ARCHETYPES or ARCHETYPE_GATE.
{
  const strict = pjr._STRICT_ARCHETYPES;
  const gate   = pjr._ARCHETYPE_GATE;
  check('LV10a STRICT_ARCHETYPES covers TECH-CONCEPT',  strict && strict.has && strict.has('TECH-CONCEPT'));
  check('LV10b STRICT_ARCHETYPES covers TECH-PROC',     strict && strict.has && strict.has('TECH-PROC'));
  check('LV10c STRICT_ARCHETYPES covers DECL-MASS',     strict && strict.has && strict.has('DECL-MASS'));
  check('LV10d ARCHETYPE_GATE has HUMANITIES handler',  gate && typeof gate['HUMANITIES'] === 'function');
  check('LV10e ARCHETYPE_GATE has LANG-ACQ handler',    gate && typeof gate['LANG-ACQ']   === 'function');
  check('LV10f ARCHETYPE_GATE has MINDSET handler',     gate && typeof gate['MINDSET']    === 'function');
}

// LV11: HUMANITIES per-axis split — epistemic axes (confidence/illusion) allow
// rewrite at mid; prose-quality axes (citation/pedagogy) stay blocked.
{
  // Summary fixture: confidence fired (sev='mid').
  const summaryConf = {
    cit_unverified: 0, ped_unknown: 0, ped_inconsistent: 0,
    conf_leak: 3, illusion_fire: 0, total_fire: 1,
    bias_missing: 0, bias_should_flag: false,
  };
  const vConf = pjr._deriveVerdict(summaryConf, 'HUMANITIES');
  check('LV11a HUMANITIES + confidence-only → needs_rewrite=true (epistemic pass)',
    vConf.needs_rewrite === true && vConf.severity === 'mid', JSON.stringify(vConf));

  const summaryCit = {
    cit_unverified: 2, ped_unknown: 0, ped_inconsistent: 0,
    conf_leak: 0, illusion_fire: 0, total_fire: 1,
    bias_missing: 0, bias_should_flag: false,
  };
  const vCit = pjr._deriveVerdict(summaryCit, 'HUMANITIES');
  check('LV11b HUMANITIES + citation-only → needs_rewrite=false (prose-quality blocked) + gated_by_archetype',
    vCit.needs_rewrite === false && vCit.gated_by_archetype === true, JSON.stringify(vCit));
}

// LV12: LANG-ACQ / MINDSET only rewrite at 'high' severity.
{
  // total_fire=1 with conf_leak only → sev='low' (per derivation rule).
  // Build a sev='mid' fixture (total_fire>=2 OR conf_leak>=2).
  const sumMid = {
    cit_unverified: 0, ped_unknown: 0, ped_inconsistent: 0,
    conf_leak: 3, illusion_fire: 1, total_fire: 2,
    bias_missing: 0, bias_should_flag: false,
  };
  const vLangMid = pjr._deriveVerdict(sumMid, 'LANG-ACQ');
  check('LV12a LANG-ACQ + mid → needs_rewrite=false (only high)',
    vLangMid.needs_rewrite === false && vLangMid.severity === 'mid', JSON.stringify(vLangMid));

  const sumHigh = {
    cit_unverified: 3, ped_unknown: 1, ped_inconsistent: 0,
    conf_leak: 5, illusion_fire: 1, total_fire: 4,
    bias_missing: 0, bias_should_flag: false,
  };
  const vMindHigh = pjr._deriveVerdict(sumHigh, 'MINDSET');
  check('LV12b MINDSET + high → needs_rewrite=true',
    vMindHigh.needs_rewrite === true && vMindHigh.severity === 'high', JSON.stringify(vMindHigh));
}

// ─── 4. Concept-Drift Emitter ────────────────────────────────────────────
const cdEmit  = require('../lib/anti-slop/concept-drift-emitter');
const ledger  = require('../lib/anti-slop/concept-ledger');

// LV13: 2+ consecutive lessons re-defining same concept with drift → emits row.
{
  const vaultRoot = mkScratch('lv13');
  const slug = 'lv13-course';
  try {
    // Lesson 0: define "实体" via Cartesian framing.
    ledger.recordLessonConcepts({
      slug, vaultRoot, lessonIdx: 0,
      concepts: ['实体'],
      prerequisite_concepts: [],
      claims_definitions: {
        '实体': '实体 是 笛卡尔 提出 的 心灵 与 物质 两类 独立 存在 范畴 二元论 框架',
      },
    });
    // Lesson 1: redefine "实体" via Spinoza self-causation framing — DRIFTS.
    ledger.recordLessonConcepts({
      slug, vaultRoot, lessonIdx: 1,
      concepts: ['实体'],
      prerequisite_concepts: [],
      claims_definitions: {
        '实体': '斯宾诺莎 自因 唯一 不可分 神 即 自然 一元论',
      },
    });
    const result = cdEmit.emitDriftEvents({ slug, vaultRoot });
    check('LV13a emit ok=true', result.ok === true, JSON.stringify(result));
    check('LV13b emitted ≥ 1 event', result.emitted >= 1, `emitted=${result.emitted}`);
    const events = cdEmit.readDriftEvents({ slug, vaultRoot });
    check('LV13c jsonl readable with CONCEPT_DRIFT event_type',
      events.length >= 1 && events[0].event_type === 'CONCEPT_DRIFT', JSON.stringify(events));
    check('LV13d event carries concept name + lesson_count + drift_severity + drift_kind',
      events[0].concept === '实体' &&
      events[0].lesson_count >= 2 &&
      typeof events[0].drift_severity === 'number' &&
      typeof events[0].drift_kind === 'string',
      JSON.stringify(events[0]));
    check('LV13e event has audit_run_id timestamp',
      typeof events[0].audit_run_id === 'string' && /\d{4}-\d{2}-\d{2}T/.test(events[0].audit_run_id));
  } finally { rmScratch(vaultRoot); }
}

// LV14: 2 lessons with CONSISTENT definitions → no events emitted.
{
  const vaultRoot = mkScratch('lv14');
  const slug = 'lv14-course';
  try {
    ledger.recordLessonConcepts({
      slug, vaultRoot, lessonIdx: 0,
      concepts: ['图谱'],
      claims_definitions: { '图谱': '图谱 以 节点 和 边 表示 概念 间的 关系' },
    });
    ledger.recordLessonConcepts({
      slug, vaultRoot, lessonIdx: 1,
      concepts: ['图谱'],
      claims_definitions: { '图谱': '图谱 以 节点 和 边 来 表示 概念 关系' },
    });
    const result = cdEmit.emitDriftEvents({ slug, vaultRoot });
    check('LV14a consistent definitions → emitted=0', result.ok === true && result.emitted === 0);
    const driftPath = path.join(vaultRoot, slug, '.hypha', 'concept-drift.jsonl');
    check('LV14b no jsonl file written for zero events',
      !fs.existsSync(driftPath), `unexpected file at ${driftPath}`);
  } finally { rmScratch(vaultRoot); }
}

// LV15: single-lesson concept → no drift candidate, no events.
{
  const vaultRoot = mkScratch('lv15');
  const slug = 'lv15-course';
  try {
    ledger.recordLessonConcepts({
      slug, vaultRoot, lessonIdx: 0,
      concepts: ['唯一性'],
      claims_definitions: { '唯一性': '实体 在 全体 范围 内 只 有 一个' },
    });
    const result = cdEmit.emitDriftEvents({ slug, vaultRoot });
    check('LV15 single-lesson concept → emitted=0', result.ok === true && result.emitted === 0);
  } finally { rmScratch(vaultRoot); }
}

// ─── 5. Encyclopedia-Opener Guard ────────────────────────────────────────
const guard = require('../lib/anti-slop/encyclopedia-opener-guard');

// LV16: DICTIONARY family — "X 是一个 Y" trips.
{
  const r = guard.scanOpener('实体 是一个 抽象 的 哲学 概念,指 思维 的 独立 范畴');
  check('LV16 "X 是一个 Y" DICTIONARY hit',
    r.fired === true && r.hits.some(h => h.family === 'DICTIONARY'), JSON.stringify(r));
}

// LV17: DICTIONARY family — "X is a kind of Y" trips.
{
  const r = guard.scanOpener('Substance is a kind of metaphysical category that Descartes proposed.');
  check('LV17 "X is a kind of Y" DICTIONARY hit',
    r.fired === true && r.hits.some(h => h.family === 'DICTIONARY'), JSON.stringify(r));
}

// LV18: ACADEMIC family — "X has been studied for ..." trips.
{
  const r = guard.scanOpener('The concept of substance has been studied for centuries by philosophers.');
  check('LV18 "X has been studied for ..." ACADEMIC hit',
    r.fired === true && r.hits.some(h => h.family === 'ACADEMIC'), JSON.stringify(r));
}

// LV19: META_TEXTBOOK family — "本课介绍 ..." trips.
{
  const r = guard.scanOpener('本课介绍 斯宾诺莎 的 实体 论证');
  check('LV19 "本课介绍 ..." META_TEXTBOOK hit',
    r.fired === true && r.hits.some(h => h.family === 'META_TEXTBOOK'), JSON.stringify(r));
}

// LV20: META_TEXTBOOK family — "In this lesson we will learn ..." trips.
{
  const r = guard.scanOpener('In this lesson we will learn how Spinoza derives substance uniqueness.');
  check('LV20 "In this lesson we will learn ..." META_TEXTBOOK hit',
    r.fired === true && r.hits.some(h => h.family === 'META_TEXTBOOK'), JSON.stringify(r));
}

// LV21: Concrete scene opener — does NOT trip.
{
  const r = guard.scanOpener('1665 年 鼠疫 关闭 剑桥 牛顿 回到 林肯郡 农场 看着 苹果 从 树上 掉下 想 月亮 为何 不掉下');
  check('LV21 concrete scene opener → fired=false',
    r.fired === false, JSON.stringify(r));
}

// LV22: scanLessonBody picks intro_hook_scene preferentially.
{
  const body = {
    intro_hook_scene: '本课介绍 substance 这一 形而上学 范畴',
    canonical_example: 'In 1665, Newton retreated to Lincolnshire farm during the plague.',
  };
  const r = guard.scanLessonBody(body);
  check('LV22 scanLessonBody picks intro_hook_scene first',
    r.field_scanned === 'intro_hook_scene' && r.fired === true, JSON.stringify(r));
}

// LV23: scanLessonBody falls back to canonical_example.
{
  const body = {
    canonical_example: 'An introduction to the substance argument.',
  };
  const r = guard.scanLessonBody(body);
  check('LV23 scanLessonBody falls back to canonical_example',
    r.field_scanned === 'canonical_example' && r.fired === true, JSON.stringify(r));
}

// LV24: buildRegenFeedback emits a non-empty regen-feedback string with family labels.
{
  const scan = guard.scanLessonBody({ intro_hook_scene: 'In this lesson we will explore substance.' });
  const fb = guard.buildRegenFeedback(scan);
  check('LV24 buildRegenFeedback non-empty string referencing META_TEXTBOOK',
    typeof fb === 'string' && fb.includes('META_TEXTBOOK') && fb.length > 100, fb);
}

// ─── End-to-end: lesson-body-generator validateBodyV2 routes encyclopedia
//                hits through the broader guard via the wiring patch ─────
const lbg = require('../lib/lesson-body-generator');

// LV25: validateBodyV2 catches a META_TEXTBOOK opener via the wired guard.
{
  // Construct a body that passes the legacy regex but trips the new bank.
  // Legacy regex caught only "An overview of" / "Introduction to" / 本课介绍/讨论/本节介绍.
  // "Today we will explore X" is missed by the legacy regex but caught by the new bank.
  const body = {
    thesis: 'learners 将能 derive substance uniqueness from self-causation',
    canonical_example: 'Today we will explore the substance argument by tracing its history through the seventeenth century.',
    exit_proof: 'apply the substance argument to a fresh case to derive uniqueness',
    mechanism_explanation: '自因 因此 推出 唯一性 通过 实体 的 内在 必然 结构 from the inside out',
    note_connection: 'first lesson — no prior note',
    common_misconceptions: [
      { wrong: 'two substances', why_wrong: 'Cartesian dualism', correct: 'actually substance must be unique' },
      { wrong: 'extended substance', why_wrong: 'Aristotelian assumption', correct: 'in fact substance is one' },
    ],
    jargon_list: ['实体 — substance (≤15 words plain gloss)'],
  };
  const errs = lbg.validateBodyV2(body);
  // We expect a hook_abstract error from the new guard. Legacy regex would
  // NOT have caught "Today we will explore ..." (it doesn't match the narrow
  // HOOK_ABSTRACT_RE), but the new bank includes the "today we will explore"
  // META_TEXTBOOK pattern.
  check('LV25 validateBodyV2 routes "Today we will explore ..." through encyclopedia guard',
    errs.some(e => typeof e === 'string' && e.startsWith('hook_abstract:')),
    errs.join('\n        '));
}

// LV26: validateBodyV2 still passes a concrete-scene opener (regression).
{
  const body = {
    thesis: 'learners 将能 derive substance uniqueness from self-causation',
    canonical_example: '1665 年 鼠疫 关闭 剑桥 斯宾诺莎 在 海牙 磨制 透镜 同时 写 伦理学 第一部分 用 自因 论证 实体 唯一',
    exit_proof: 'apply 自因 论证 to derive 唯一性 in a fresh case',
    mechanism_explanation: '自因 因此 推出 唯一性 通过 实体 的 内在 必然 结构',
    note_connection: 'first lesson — no prior note',
    common_misconceptions: [
      { wrong: 'two substances', why_wrong: 'Cartesian dualism', correct: 'actually substance must be unique' },
      { wrong: 'extended substance', why_wrong: 'Aristotelian assumption', correct: 'in fact substance is one' },
    ],
    jargon_list: ['实体 — substance'],
  };
  const errs = lbg.validateBodyV2(body);
  check('LV26 concrete-scene opener → no hook_abstract error',
    !errs.some(e => typeof e === 'string' && e.startsWith('hook_abstract:')),
    errs.join('\n        '));
}

// ─── End ─────────────────────────────────────────────────────────────────

console.log(tests.join('\n'));
console.log(`\n${passed} PASS / ${failed} FAIL / ${passed + failed} TOTAL`);
process.exit(failed === 0 ? 0 : 1);
