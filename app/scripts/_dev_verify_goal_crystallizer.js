#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_goal_crystallizer — smoke for Phase F.0 goal crystallizer.
//
// Validates app/lib/creation/goal-crystallizer.js:
//   1. generateCrystallizerQuestions input validation
//   2. generateCrystallizerQuestions valid path (questions + options shape)
//   3. generateCrystallizerQuestions malformed → ok:false
//   4. validateQuestions direct (count enforcement)
//   5. crystallizeGoal input validation
//   6. crystallizeGoal valid path (crystallized_goal + tags)
//   7. validateCrystallized direct (enum enforcement)
//   8. _sanitizeQuestion + _sanitizeCrystallized cap behavior
//   9. Archetype dimensions injected into LLM prompt
//
// LLM stubbed via Module._resolveFilename hack.

const path = require('path');
const Module = require('module');

const llmPath = path.join(__dirname, '..', 'lib', 'llm', 'index.js');
const originalResolve = Module._resolveFilename;

let _stubMode = 'valid';
let _stubCalls = [];

function _stubExecuteChat(capability, args) {
  _stubCalls.push({
    capability,
    sys: args && args.messages && args.messages[0] && args.messages[0].content,
    user: args && args.messages && args.messages[1] && args.messages[1].content,
  });

  // Questions stage
  if (_stubMode === 'questions-valid') {
    return Promise.resolve({
      result: {
        questions: [
          {
            id: 'q1_lang',
            prompt: '你想用哪种语言写作?',
            dimension: '语言/写作圈',
            rationale: '语言决定整个 corpus 选择',
            options: [
              { id: 'a', label: '汉语 (大陆 / 港台)', implies: 'lang=zh' },
              { id: 'b', label: '英语 (英美)', implies: 'lang=en' },
              { id: 'c', label: '日语原文', implies: 'lang=ja' },
              { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
            ],
          },
          {
            id: 'q2_genre',
            prompt: '主体裁?',
            dimension: '体裁',
            rationale: '短篇/长篇训练路径完全不同',
            options: [
              { id: 'a', label: '短篇 (5000-15000 字)', implies: 'genre=short' },
              { id: 'b', label: '长篇 (≥50000 字)', implies: 'genre=novel' },
              { id: 'c', label: '散文 / 随笔', implies: 'genre=essay' },
              { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
            ],
          },
          {
            id: 'q3_lineage',
            prompt: '流派师承?',
            dimension: '流派师承',
            rationale: '川端式 vs 加缪式训练 corpus 不同',
            options: [
              { id: 'a', label: '川端式静默', implies: 'school=kawabata' },
              { id: 'b', label: '加缪式存在', implies: 'school=camus' },
              { id: 'c', label: '马尔克斯式魔幻', implies: 'school=marquez' },
              { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
            ],
          },
          {
            id: 'q4_level',
            prompt: '当前位置?',
            dimension: '现位置',
            rationale: '零基础与发过期刊路径差很大',
            options: [
              { id: 'a', label: '零基础', implies: 'level=zero' },
              { id: 'b', label: '写过未发', implies: 'level=hobbyist' },
              { id: 'c', label: '发过期刊', implies: 'level=intermediate' },
              { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
            ],
          },
        ],
        confidence: 0.85,
      },
      providerId: 'mock', model: 'mock', capability,
    });
  }
  if (_stubMode === 'questions-too-few') {
    return Promise.resolve({
      result: {
        questions: [
          { id: 'q1', prompt: '?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
          { id: 'q2', prompt: '?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
        ],
        confidence: 0.5,
      },
      providerId: 'mock', model: 'mock', capability,
    });
  }
  if (_stubMode === 'questions-wrong-options') {
    return Promise.resolve({
      result: {
        questions: [
          { id: 'q1', prompt: '?', options: [{ id: 'a', label: 'A' }] },  // only 1 option
          { id: 'q2', prompt: '?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
          { id: 'q3', prompt: '?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
        ],
        confidence: 0.6,
      },
      providerId: 'mock', model: 'mock', capability,
    });
  }

  // Crystallize stage
  if (_stubMode === 'crystallize-valid') {
    return Promise.resolve({
      result: {
        crystallized_goal: '5 年内写出 6-8 篇川端式静默短篇汉语小说, 至少 1 篇投省级文学期刊.',
        tags: {
          primary_focus: '川端式静默笔法 + 短篇汉语小说',
          domain: '文学 / 短篇 / 汉语',
          scale: 'career',
          timeline: '5 年',
          output_form: '6-8 篇短篇汉语小说',
          current_level: 'hobbyist',
          milestones: [
            '5 年: 6-8 篇短篇 + 投稿 1 篇省级期刊',
            '1 年: 完成 2-3 篇打磨稿',
            '3 月: 写完第 1 篇可读初稿',
          ],
          niche_factor: 'high',
        },
        confidence: 0.78,
        notes: '汉语圈 + 川端式 = 高 niche, 推荐应偏冷书',
      },
      providerId: 'mock', model: 'mock', capability,
    });
  }
  if (_stubMode === 'crystallize-invalid-scale') {
    return Promise.resolve({
      result: {
        crystallized_goal: 'x',
        tags: { primary_focus: 'x', domain: 'x', scale: 'INVALID', timeline: '1y', output_form: 'x', current_level: 'zero', niche_factor: 'low', milestones: [] },
        confidence: 0.5,
      },
      providerId: 'mock', model: 'mock', capability,
    });
  }
  if (_stubMode === 'crystallize-missing-focus') {
    return Promise.resolve({
      result: {
        crystallized_goal: 'something',
        tags: { /* no primary_focus */ scale: 'project', timeline: '1y', output_form: '', current_level: 'zero', niche_factor: 'med' },
        confidence: 0.6,
      },
      providerId: 'mock', model: 'mock', capability,
    });
  }

  // Phase G.2 (2026-05-18) — 2-stage wizard: deep followup questions stage.
  if (_stubMode === 'followup-valid') {
    return Promise.resolve({
      result: {
        questions: [
          {
            id: 'q_deep_kawabata_period',
            prompt: '你想学川端的哪一时期?',
            dimension: '川端式静默 · 时期',
            options: [
              { id: 'a', label: '早期 (山之音 / 雪国)', implies: '川端早期-自然主义' },
              { id: 'b', label: '中期 (千只鹤 / 名人)', implies: '川端中期-传统美' },
              { id: 'c', label: '后期 (古都 / 美的存在)', implies: '川端后期-空寂' },
              { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
            ],
          },
          {
            id: 'q_deep_short_count',
            prompt: '5 年内你的短篇产出量?',
            dimension: '短篇 · 量级',
            options: [
              { id: 'a', label: '6-8 篇 (每年 1-2 篇精雕)', implies: '短篇-精雕路径' },
              { id: 'b', label: '15-20 篇 (期刊投稿节奏)', implies: '短篇-期刊路径' },
              { id: 'c', label: '40+ 篇 (大量练手再筛)', implies: '短篇-训练量路径' },
              { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
            ],
          },
          {
            id: 'q_deep_publication',
            prompt: '中间里程碑 (3 年)?',
            dimension: '里程碑 · 3 年',
            options: [
              { id: 'a', label: '省级期刊单篇发表', implies: '出版-省级' },
              { id: 'b', label: '出版社签约长篇', implies: '出版-签约' },
              { id: 'c', label: '译介海外文学杂志', implies: '出版-译介' },
              { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
            ],
          },
          {
            id: 'q_deep_daily',
            prompt: '日产出节奏?',
            dimension: '节奏 · 日产',
            options: [
              { id: 'a', label: '每日 30 min 慢雕', implies: '节奏-慢雕' },
              { id: 'b', label: '每日 1-2 h 稳定', implies: '节奏-稳定' },
              { id: 'c', label: '集中爆发 (每周 1 天)', implies: '节奏-爆发' },
              { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
            ],
          },
          {
            id: 'q_deep_corpus',
            prompt: '可放弃工具?',
            dimension: '边界 · 工具',
            options: [
              { id: 'a', label: '只读汉译 (放弃日文原文)', implies: '工具-汉译' },
              { id: 'b', label: '汉日双语对照', implies: '工具-双语' },
              { id: 'c', label: '日文原文 (慢)', implies: '工具-原文' },
              { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
            ],
          },
        ],
        confidence: 0.82,
      },
      providerId: 'mock', model: 'mock', capability,
    });
  }
  if (_stubMode === 'followup-too-few') {
    return Promise.resolve({
      result: {
        questions: [
          { id: 'q1', prompt: '?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
          { id: 'q2', prompt: '?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }, { id: 'd', label: 'D' }] },
        ],
        confidence: 0.5,
      },
      providerId: 'mock', model: 'mock', capability,
    });
  }

  return Promise.reject(new Error('stub: unknown mode ' + _stubMode));
}

Module._resolveFilename = function (request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.includes('goal-crystallizer.js') && request === '../llm') {
    return llmPath;
  }
  return originalResolve.call(this, request, parent, ...rest);
};

require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true,
  exports: { executeChat: _stubExecuteChat },
};

const gc = require('../lib/creation/goal-crystallizer');

const tests = [];
let passed = 0, failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; tests.push(`  \x1b[32mPASS\x1b[0m ${name}`); }
  else      { failed++; tests.push(`  \x1b[31mFAIL\x1b[0m ${name}${extra ? '\n    ' + extra : ''}`); }
}

(async () => {

// ── Test 1: questions input validation ──────────────────────────────────
{
  const r1 = await gc.generateCrystallizerQuestions({ archetype: 'HUMANITIES' });
  check('1. no draftGoal — ok:false', r1.ok === false && r1.error === 'draftGoal required');
  const r2 = await gc.generateCrystallizerQuestions({ draftGoal: '   ', archetype: 'HUMANITIES' });
  check('1. whitespace draftGoal — ok:false', r2.ok === false);
}

// ── Test 2: questions valid path ────────────────────────────────────────
{
  _stubMode = 'questions-valid';
  _stubCalls = [];
  const r = await gc.generateCrystallizerQuestions({
    draftGoal: '我要成为诺贝尔文学作家',
    archetype: 'HUMANITIES',
  });
  check('2. valid — ok:true', r.ok === true);
  // Phase G.2 (2026-05-18) — MAX/MIN now 3/3 for broad stage (was 3/5).
  // Stub returns 4 questions; sanitizer slices to MAX_QUESTIONS=3.
  check('2. valid — broad stage caps to 3 questions', r.questions.length === 3);
  check('2. valid — confidence preserved', Math.abs(r.confidence - 0.85) < 0.001);
  check('2. valid — Q1 has 4 options', r.questions[0].options.length === 4);
  check('2. valid — Q1 option d is custom-input', r.questions[0].options[3].implies === 'custom-input');
  check('2. valid — Q1 dimension preserved', r.questions[0].dimension === '语言/写作圈');
  check('2. valid — capability T3_MID', _stubCalls.length > 0 && _stubCalls[0].capability === 'T3_MID');
}

// ── Test 3: questions too few → fail ───────────────────────────────────
{
  _stubMode = 'questions-too-few';
  const r = await gc.generateCrystallizerQuestions({ draftGoal: 'X', archetype: 'HUMANITIES' });
  check('3. too few — ok:false', r.ok === false);
  check('3. too few — error mentions length', r.error && r.error.includes('length'));
}

// ── Test 4: questions wrong option count → fail ────────────────────────
{
  _stubMode = 'questions-wrong-options';
  const r = await gc.generateCrystallizerQuestions({ draftGoal: 'X', archetype: 'HUMANITIES' });
  check('4. wrong options — ok:false', r.ok === false);
  check('4. wrong options — error mentions options', r.error && r.error.includes('options'));
}

// ── Test 5: validateQuestions direct ───────────────────────────────────
{
  const v1 = gc.validateQuestions({ questions: [] });
  check('5. validateQuestions — empty fails', v1.ok === false);
  const v2 = gc.validateQuestions(null);
  check('5. validateQuestions — null fails', v2.ok === false);
}

// ── Test 6: crystallize input validation ───────────────────────────────
{
  const r1 = await gc.crystallizeGoal({ archetype: 'HUMANITIES', answers: [{}] });
  check('6. no draftGoal — ok:false', r1.ok === false);
  const r2 = await gc.crystallizeGoal({ draftGoal: 'X', answers: [] });
  check('6. no answers — ok:false', r2.ok === false && r2.error.includes('answers'));
}

// ── Test 7: crystallize valid path ─────────────────────────────────────
{
  _stubMode = 'crystallize-valid';
  const r = await gc.crystallizeGoal({
    draftGoal: '我要成为诺贝尔文学作家',
    archetype: 'HUMANITIES',
    answers: [
      { question: '语言?', chosen_label: '汉语', implies: 'lang=zh', dimension: '语言' },
      { question: '体裁?', chosen_label: '短篇', implies: 'genre=short', dimension: '体裁' },
      { question: '流派?', chosen_label: '川端式静默', implies: 'school=kawabata', dimension: '流派' },
      { question: '位置?', chosen_label: '写过未发', implies: 'level=hobbyist', dimension: '现位置' },
    ],
  });
  check('7. valid — ok:true', r.ok === true);
  check('7. valid — crystallized_goal contains 川端', r.crystallized_goal.includes('川端'));
  check('7. valid — tags.primary_focus contains 川端', r.tags.primary_focus.includes('川端'));
  check('7. valid — tags.scale=career', r.tags.scale === 'career');
  check('7. valid — tags.current_level=hobbyist', r.tags.current_level === 'hobbyist');
  check('7. valid — tags.niche_factor=high', r.tags.niche_factor === 'high');
  check('7. valid — milestones length 3', r.tags.milestones.length === 3);
  check('7. valid — confidence ≈ 0.78', Math.abs(r.confidence - 0.78) < 0.001);
}

// ── Test 8: validateCrystallized rejects invalid enums ─────────────────
{
  _stubMode = 'crystallize-invalid-scale';
  const r = await gc.crystallizeGoal({ draftGoal: 'X', archetype: 'HUMANITIES', answers: [{ question: '?', chosen_label: 'x' }] });
  check('8. invalid scale — ok:false', r.ok === false);
  check('8. invalid scale — error mentions scale', r.error && r.error.includes('scale'));

  _stubMode = 'crystallize-missing-focus';
  const r2 = await gc.crystallizeGoal({ draftGoal: 'X', archetype: 'HUMANITIES', answers: [{ question: '?', chosen_label: 'x' }] });
  check('8. missing primary_focus — ok:false', r2.ok === false);
}

// ── Test 9: archetype dimensions injected into prompt ──────────────────
{
  _stubMode = 'questions-valid';
  _stubCalls = [];
  await gc.generateCrystallizerQuestions({ draftGoal: 'X', archetype: 'TECH-CONCEPT' });
  check('9. TECH-CONCEPT — prompt contains transformer hint', _stubCalls.length > 0 && _stubCalls[0].user && _stubCalls[0].user.includes('transformer'));

  _stubCalls = [];
  await gc.generateCrystallizerQuestions({ draftGoal: 'Y', archetype: 'LANG-ACQ' });
  check('9. LANG-ACQ — prompt contains CEFR', _stubCalls.length > 0 && _stubCalls[0].user && _stubCalls[0].user.includes('CEFR'));

  _stubCalls = [];
  await gc.generateCrystallizerQuestions({ draftGoal: 'Z', archetype: 'HUMANITIES' });
  check('9. HUMANITIES — prompt contains 川端式', _stubCalls.length > 0 && _stubCalls[0].user && _stubCalls[0].user.includes('川端式'));
}

// ── Test 10: _sanitizeQuestion + _sanitizeCrystallized caps ───────────
{
  const { _sanitizeQuestion, _sanitizeCrystallized } = gc._internals;
  const longPrompt = 'a'.repeat(500);
  const sane = _sanitizeQuestion({ id: 'x', prompt: longPrompt, options: [{ id: 'a', label: 'A', implies: 'B' }] });
  check('10. sanitize question — prompt capped', sane.prompt.length === 200);
  check('10. sanitize question — options not padded', sane.options.length === 1);

  const crystSane = _sanitizeCrystallized({
    crystallized_goal: 'a'.repeat(500),
    tags: {
      primary_focus: 'x', scale: 'career', timeline: '1y', output_form: 'x',
      current_level: 'zero', niche_factor: 'high',
      milestones: Array.from({ length: 10 }, (_, i) => `m${i}`),
    },
  });
  check('10. sanitize crystallized — goal capped', crystSane.crystallized_goal.length === 400);
  check('10. sanitize crystallized — milestones capped at 5', crystSane.tags.milestones.length === 5);
}

// ── Test 11: archetype inferrer ────────────────────────────────────────
{
  const infer = gc.inferArchetypeFromGoal;
  check('11. infer — null returns HUMANITIES', infer(null) === 'HUMANITIES');
  check('11. infer — empty returns HUMANITIES', infer('') === 'HUMANITIES');
  check('11. infer — whitespace returns HUMANITIES', infer('   ') === 'HUMANITIES');
  // HUMANITIES path (Nobel literature)
  check('11. infer — "我要成为诺贝尔文学作家" → HUMANITIES', infer('我要成为诺贝尔文学作家') === 'HUMANITIES');
  check('11. infer — "写一部长篇小说" → HUMANITIES', infer('写一部长篇小说') === 'HUMANITIES');
  // TECH-CONCEPT
  check('11. infer — "transformer attention 复现" → TECH-CONCEPT', infer('transformer attention 复现') === 'TECH-CONCEPT');
  check('11. infer — "深度学习入门" → TECH-CONCEPT', infer('深度学习入门') === 'TECH-CONCEPT');
  check('11. infer — "学量子力学" → TECH-CONCEPT', infer('学量子力学') === 'TECH-CONCEPT');
  // TECH-PROC
  check('11. infer — "用 Rust 写一个 web app" → TECH-PROC', infer('用 Rust 写一个 web app') === 'TECH-PROC');
  check('11. infer — "学 TypeScript 全栈开发" → TECH-PROC', infer('学 TypeScript 全栈开发') === 'TECH-PROC');
  // LANG-ACQ (MUST match BEFORE TECH-PROC due to priority order)
  check('11. infer — "学日语 N2" → LANG-ACQ', infer('学日语 N2') === 'LANG-ACQ');
  check('11. infer — "learn Japanese to JLPT N3" → LANG-ACQ', infer('learn Japanese to JLPT N3') === 'LANG-ACQ');
  check('11. infer — "CEFR B2 英语" → LANG-ACQ', infer('CEFR B2 英语') === 'LANG-ACQ');
  // DECL-MASS
  check('11. infer — "考研政治英语高数" → DECL-MASS', infer('考研政治英语高数') === 'DECL-MASS');
  check('11. infer — "CFA 一级" → DECL-MASS', infer('CFA 一级') === 'DECL-MASS');
  // MINDSET
  check('11. infer — "学斯多葛主义" → MINDSET', infer('学斯多葛主义') === 'MINDSET');
  check('11. infer — "禅修冥想" → MINDSET', infer('禅修冥想') === 'MINDSET');
  // Ambiguous → HUMANITIES default
  check('11. infer — "I want to learn something" → HUMANITIES (default)', infer('I want to learn something') === 'HUMANITIES');
}

// ── Test 12: 2-stage wizard followup (Phase G.2) ────────────────────────
{
  // Input validation
  const r0 = await gc.generateFollowupQuestions({ archetype: 'HUMANITIES', broadAnswers: [{ chosen_label: 'x' }] });
  check('12. followup — no draftGoal → ok:false', r0.ok === false && /draftGoal/.test(r0.error));

  const r1 = await gc.generateFollowupQuestions({ draftGoal: 'X', archetype: 'HUMANITIES' });
  check('12. followup — empty broadAnswers → ok:false', r1.ok === false && /broadAnswers/.test(r1.error));

  // Valid path
  _stubMode = 'followup-valid';
  _stubCalls = [];
  const broadAns = [
    { question: '语言/写作圈?', chosen_label: '汉语', implies: 'lang=zh', dimension: '语言' },
    { question: '体裁?', chosen_label: '短篇', implies: 'genre=short', dimension: '体裁' },
    { question: '流派师承?', chosen_label: '川端式静默', implies: 'school=kawabata', dimension: '师承' },
  ];
  const r2 = await gc.generateFollowupQuestions({
    draftGoal: '我要成为诺贝尔文学作家',
    archetype: 'HUMANITIES',
    broadAnswers: broadAns,
  });
  check('12. followup-valid — ok:true', r2.ok === true);
  check('12. followup-valid — exactly 5 deep questions', Array.isArray(r2.questions) && r2.questions.length === 5);
  check('12. followup-valid — _meta.stage === "deep"', r2._meta && r2._meta.stage === 'deep');
  check('12. followup-valid — user msg embeds broad answer "川端式静默"', _stubCalls[0] && /川端式静默/.test(_stubCalls[0].user || ''));
  check('12. followup-valid — system prompt mentions broad_answers', _stubCalls[0] && /broad_answers/.test(_stubCalls[0].sys || ''));

  // Too-few rejection
  _stubMode = 'followup-too-few';
  const r3 = await gc.generateFollowupQuestions({
    draftGoal: 'X', archetype: 'HUMANITIES', broadAnswers: broadAns,
  });
  check('12. followup-too-few → ok:false', r3.ok === false);
  check('12. followup-too-few — error mentions length', r3.error && /length|< 5/.test(r3.error));
}

// ── Report ─────────────────────────────────────────────────────────────
console.log('\n=== HYPHA · Goal Crystallizer smoke ===\n');
for (const line of tests) console.log(line);
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed}/${passed + failed} PASS\x1b[0m\n`);

process.exit(failed === 0 ? 0 : 1);

})();
