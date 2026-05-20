#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_critique — smoke test for Pillar 4 (Weaver/Whetstone/Witness).
//
// Mocks app/lib/llm.executeChat to return fixed JSON for each of the 3 critique
// agents + the revise pass, then exercises runCritique + reviseSkeleton.
//
// Validates:
//   1. runCritique returns { weaver, whetstone, witness } shaped objects
//   2. mergedFindings.summary reflects the parsed counts
//   3. shouldRevise=true when whetstone has high-severity weak_kps
//   4. shouldRevise=false when no findings
//   5. reviseSkeleton returns a skeleton with lessonPlan preserved + lessons_changed/kps_changed
//
// Run:
//   node app/scripts/_dev_verify_critique.js
//
// Exit 0 = PASS N/N, Exit 1 = any failure.

const path  = require('path');
const Module = require('module');

// ── Stub app/lib/llm BEFORE require()ing critique-runner ────────────────
const llmPath = path.join(__dirname, '..', 'lib', 'llm', 'index.js');
const originalResolve = Module._resolveFilename;

let _stubMode = 'shouldRevise';   // toggled per test case
let _executeChatCalls = [];
// 2026-05-17 Gap 3 — loop tests need per-round mode switching. When
// _stubModeSequence is non-empty, each new runCritique invocation pops the
// next mode off the front; falls back to _stubMode when exhausted.
let _stubModeSequence = [];
let _critiqueInvocations = 0;
let _seenWeaverThisInvocation = false;
function _currentMode() {
  if (_stubModeSequence.length === 0) return _stubMode;
  // Each runCritique fires Weaver + Whetstone + Witness in parallel. We
  // advance the sequence on the first Weaver call of a fresh invocation.
  const idx = Math.max(0, _critiqueInvocations - 1);
  return _stubModeSequence[Math.min(idx, _stubModeSequence.length - 1)];
}

function _stubExecuteChat(capability, args) {
  _executeChatCalls.push({ capability, prompt: args && args.messages && args.messages[0] && args.messages[0].content });
  const prompt = String(args && args.messages && args.messages[0] && args.messages[0].content || '');

  // Critique agents differ by capability + which prompt they get.
  // 2026-05-17 Gap 3 — track parallel critique invocations so per-round mode
  // sequences (used by runCritiqueLoop tests) advance correctly. The 3 judges
  // fire in parallel, so we bump the counter on Weaver (alphabetically first)
  // and reset _seenWeaverThisInvocation on T6_STRONG revise.
  if (capability === 'T4_JUDGE' && /Weaver/.test(prompt) && !_seenWeaverThisInvocation) {
    _critiqueInvocations++;
    _seenWeaverThisInvocation = true;
  }
  const mode = _currentMode();
  if (capability === 'T4_JUDGE') {
    if (/Weaver/.test(prompt)) {
      if (mode === 'empty') {
        return Promise.resolve({
          result: JSON.stringify({ missing_lenses: [], cross_domain_links: [], confidence: 0.9 }),
          providerId: 'mock', model: 'mock', capability,
        });
      }
      return Promise.resolve({
        result: JSON.stringify({
          missing_lenses: [
            { lens: '战后日本 mono-no-aware', why: '欧陆理性偏', suggest_lesson_insert_idx: 1 },
            { lens: '阿拉伯黄金时代', why: '欧洲中心偏', suggest_lesson_insert_idx: 2 },
          ],
          cross_domain_links: [
            { from_concept: '注意力', to_domain: '神经科学', leverage: 'V1 视觉皮层类比' },
          ],
          confidence: 0.82,
        }),
        providerId: 'mock', model: 'mock', capability,
      });
    }
    if (/Whetstone/.test(prompt)) {
      if (mode === 'empty') {
        return Promise.resolve({
          result: JSON.stringify({ weak_kps: [], suggested_rewrites: [], confidence: 0.9 }),
          providerId: 'mock', model: 'mock', capability,
        });
      }
      return Promise.resolve({
        result: JSON.stringify({
          weak_kps: [
            { lesson_idx: 0, kp_idx: 1, kp_text: '注意力是核心', why_fails: '停在标签层 ! 操作层', severity: 'high' },
            { lesson_idx: 1, kp_idx: 2, kp_text: '反向传播是 chain rule', why_fails: '没 worked example', severity: 'mid' },
          ],
          suggested_rewrites: [
            { lesson_idx: 0, kp_idx: 1, new_kp: '注意力是查询-键-值 加权求和 ...' },
          ],
          confidence: 0.85,
        }),
        providerId: 'mock', model: 'mock', capability,
      });
    }
    if (/Witness/.test(prompt)) {
      if (mode === 'empty') {
        return Promise.resolve({
          result: JSON.stringify({
            source_to_lesson_ratio: 2.5,
            difficulty_implied_min_ratio: 1.0,
            ratio_judgment: 'sufficient',
            kps_undersupported: [],
            missing_source_types: [],
            extra_sources_needed: 0,
            confidence: 0.9,
          }),
          providerId: 'mock', model: 'mock', capability,
        });
      }
      return Promise.resolve({
        result: JSON.stringify({
          source_to_lesson_ratio: 0.4,
          difficulty_implied_min_ratio: 1.5,
          ratio_judgment: 'severely_low',
          kps_undersupported: [
            { lesson_idx: 0, kp_idx: 1, supporting_sources: 0, min_recommend: 2 },
          ],
          missing_source_types: ['frontier 2024-2026 paper 缺'],
          extra_sources_needed: 3,
          confidence: 0.78,
        }),
        providerId: 'mock', model: 'mock', capability,
      });
    }
  }

  // T6_STRONG revise pass
  if (capability === 'T6_STRONG') {
    // Reset Weaver-seen flag so the next runCritique (round N+1) increments
    // _critiqueInvocations on its Weaver call.
    _seenWeaverThisInvocation = false;
    return Promise.resolve({
      result: JSON.stringify({
        lessonPlan: [
          {
            idx: 0,
            title: '注意力机制 · 查询-键-值 加权求和',
            learnGoal: '在给定 3-token 输入序列上手算 self-attention 输出',
            conceptId: 'self-attention-qkv',
            scope_in: '单头 self-attention 矩阵运算',
            scope_out: '多头 / 位置编码 (后续节)',
            prerequisite: '点积 + softmax',
          },
          {
            idx: 1,
            title: '反向传播 · chain rule worked example',
            learnGoal: '在 2 层 MLP 上手算梯度反传',
            conceptId: 'backprop-chain-rule',
            scope_in: '标量 chain rule 应用到 2 层网络',
            scope_out: '自动微分库实现',
            prerequisite: '偏导数',
          },
        ],
        trajectory: '从单头注意力到反传, 每节 1 个 worked example。',
        lessons_changed: 2,
        kps_changed: 3,
        _meta: { critique_applied: ['weaver_mono_no_aware', 'whetstone_kp_attention'] },
      }),
      providerId: 'mock', model: 'mock', capability,
    });
  }

  return Promise.resolve({ result: '{}', providerId: 'mock', model: 'mock', capability });
}

// Pre-populate require cache for app/lib/llm so critique-runner picks up the stub.
require.cache[llmPath] = {
  id: llmPath,
  filename: llmPath,
  loaded: true,
  exports: { executeChat: _stubExecuteChat },
};

// Now safe to load critique-runner
const runnerPath = path.join(__dirname, '..', 'lib', 'critique', 'critique-runner.js');
const { runCritique, reviseSkeleton, runCritiqueLoop, _decideShouldRevise } = require(runnerPath);

// ── Fixture skeleton (2 lessons, 5 KPs total) ────────────────────────────
function makeSkeleton() {
  return {
    archetype: 'TECH-CONCEPT',
    phases: [{ id: 'foundation', label: 'Foundation' }],
    lessonPlan: [
      {
        idx: 0,
        title: 'Intro to attention',
        learnGoal: 'Understand attention',
        conceptId: 'attention',
        scope_in: 'self-attention basics',
        scope_out: 'multi-head',
        prerequisite: '矩阵乘法',
        knowledge_points: ['Attention 是核心', '注意力是核心', 'softmax 归一化'],
      },
      {
        idx: 1,
        title: 'Backprop',
        learnGoal: 'Use backprop',
        conceptId: 'backprop',
        scope_in: 'chain rule on MLP',
        scope_out: 'auto-diff library',
        prerequisite: '偏导数',
        knowledge_points: ['梯度下降', 'chain rule', '反向传播是 chain rule'],
      },
    ],
  };
}

function makeSources() {
  return [
    { title: 'Attention Is All You Need', url: 'https://arxiv.org/abs/1706.03762', layer: 'canonical' },
    { title: 'Deep Learning Book Ch 6', url: 'https://www.deeplearningbook.org/', layer: 'pedagogy' },
  ];
}

// ── Cases ────────────────────────────────────────────────────────────────
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? '\n        ' + detail : ''}`);
}

(async () => {
  // Case 1 — runCritique with findings → shouldRevise=true
  _stubMode = 'shouldRevise';
  _executeChatCalls = [];
  const progress = [];
  const r1 = await runCritique({
    skeleton: makeSkeleton(),
    archetype: 'TECH-CONCEPT',
    goal: '理解 transformer 注意力',
    difficulty: 0.7,
    sources: makeSources(),
    settings: {},
    onProgress: (stage, payload) => progress.push({ stage, payload }),
  });

  record('runCritique returns 3 agent results (weaver/whetstone/witness)',
    !!(r1.weaver && r1.whetstone && r1.witness),
    `weaver=${!!r1.weaver}, whetstone=${!!r1.whetstone}, witness=${!!r1.witness}`);

  record('runCritique called executeChat 3 times w/ T4_JUDGE',
    _executeChatCalls.length === 3 && _executeChatCalls.every(c => c.capability === 'T4_JUDGE'),
    `calls=${_executeChatCalls.length}, caps=[${_executeChatCalls.map(c => c.capability).join(',')}]`);

  record('mergedFindings.summary reflects parsed counts',
    r1.mergedFindings.summary.lenses === 2
    && r1.mergedFindings.summary.weak_kps === 2
    && r1.mergedFindings.summary.high_severity_kps === 1
    && r1.mergedFindings.summary.judgment === 'severely_low',
    JSON.stringify(r1.mergedFindings.summary));

  record('shouldRevise=true when high-severity KP present',
    r1.shouldRevise === true,
    `shouldRevise=${r1.shouldRevise}`);

  const stages = progress.map(p => p.stage);
  record('emits critique:start / weaver:done / whetstone:done / witness:done / critique:done',
    stages.includes('critique:start')
    && stages.includes('weaver:done')
    && stages.includes('whetstone:done')
    && stages.includes('witness:done')
    && stages.includes('critique:done'),
    `stages=[${stages.join(', ')}]`);

  // Case 2 — runCritique with empty findings → shouldRevise=false
  _stubMode = 'empty';
  _executeChatCalls = [];
  const r2 = await runCritique({
    skeleton: makeSkeleton(),
    archetype: 'TECH-CONCEPT',
    goal: '简单兴趣入门',
    difficulty: 0.3,
    sources: makeSources(),
    settings: {},
  });
  record('shouldRevise=false when no findings + ratio sufficient',
    r2.shouldRevise === false,
    `shouldRevise=${r2.shouldRevise}, summary=${JSON.stringify(r2.mergedFindings.summary)}`);

  // Case 3 — _decideShouldRevise gating unit test
  record('_decideShouldRevise true when ≥2 missing lenses (even no high-sev KP)',
    _decideShouldRevise(
      { missing_lenses: [{ lens: 'a' }, { lens: 'b' }] },
      { weak_kps: [] },
      { ratio_judgment: 'sufficient' }
    ) === true);

  record('_decideShouldRevise true when witness ratio_judgment=low',
    _decideShouldRevise(
      { missing_lenses: [] },
      { weak_kps: [] },
      { ratio_judgment: 'low' }
    ) === true);

  record('_decideShouldRevise false on all-empty',
    _decideShouldRevise({}, {}, {}) === false);

  // Case 4 — reviseSkeleton returns new skeleton with merged shape
  _stubMode = 'shouldRevise';
  _executeChatCalls = [];
  const sk = makeSkeleton();
  const revised = await reviseSkeleton({
    skeleton: sk,
    mergedFindings: r1.mergedFindings,
    settings: {},
  });

  record('reviseSkeleton returns non-null object',
    !!revised,
    `revised type=${revised ? 'object' : 'null'}`);

  record('revised.lessonPlan length preserved (2 lessons)',
    revised && Array.isArray(revised.lessonPlan) && revised.lessonPlan.length === 2,
    `lessonPlan.length=${revised && revised.lessonPlan && revised.lessonPlan.length}`);

  record('revised lesson titles updated from mock revise output',
    revised && revised.lessonPlan[0].title === '注意力机制 · 查询-键-值 加权求和'
    && revised.lessonPlan[1].title === '反向传播 · chain rule worked example',
    `[0].title=${revised && revised.lessonPlan[0].title}, [1].title=${revised && revised.lessonPlan[1].title}`);

  record('revised carries lessons_changed + kps_changed',
    revised && revised.lessons_changed === 2 && revised.kps_changed === 3,
    `lessons_changed=${revised && revised.lessons_changed}, kps_changed=${revised && revised.kps_changed}`);

  record('revised._meta.critique_pillar4.refined=true',
    revised && revised._meta && revised._meta.critique_pillar4
    && revised._meta.critique_pillar4.refined === true,
    `_meta.critique_pillar4=${JSON.stringify(revised && revised._meta && revised._meta.critique_pillar4)}`);

  record('reviseSkeleton used T6_STRONG capability',
    _executeChatCalls.length === 1 && _executeChatCalls[0].capability === 'T6_STRONG',
    `calls=${_executeChatCalls.length}, caps=[${_executeChatCalls.map(c => c.capability).join(',')}]`);

  // Case 5 — runCritique handles empty skeleton gracefully
  const r3 = await runCritique({
    skeleton: { lessonPlan: [] },
    archetype: 'TECH-CONCEPT',
    goal: 'test',
    difficulty: 0.5,
    sources: [],
    settings: {},
  });
  record('runCritique returns shouldRevise=false on empty skeleton',
    r3.shouldRevise === false && r3.weaver === null,
    `shouldRevise=${r3.shouldRevise}, weaver=${r3.weaver}`);

  // ── Case 6 (Gap 3) — runCritiqueLoop converges at round 2 ──────────────
  // Round 1: shouldRevise=true (findings present) → revise → round 2: empty
  // findings → shouldRevise=false → converged. Expect totalRounds=2.
  _stubMode = 'shouldRevise';
  _stubModeSequence = ['shouldRevise', 'empty'];
  _critiqueInvocations = 0;
  _seenWeaverThisInvocation = false;
  _executeChatCalls = [];
  const loopProgress = [];
  const loop1 = await runCritiqueLoop({
    skeleton: makeSkeleton(),
    archetype: 'TECH-CONCEPT',
    goal: '理解 transformer 注意力',
    difficulty: 0.7,
    sources: makeSources(),
    settings: {},
    maxRounds: 2,
    onProgress: (stage, payload) => loopProgress.push({ stage, payload }),
  });

  record('runCritiqueLoop converges at round 2 when r2 returns empty findings',
    loop1.totalRounds === 2
    && loop1.history.length === 2
    && loop1.history[0].shouldRevise === true
    && loop1.history[1].shouldRevise === false,
    `totalRounds=${loop1.totalRounds}, history=${JSON.stringify(loop1.history.map(h => ({ r: h.round, sr: h.shouldRevise })))}`);

  record('runCritiqueLoop finalSkeleton ≠ input (round 1 revise applied)',
    loop1.finalSkeleton
    && loop1.finalSkeleton.lessonPlan
    && loop1.finalSkeleton.lessonPlan[0].title === '注意力机制 · 查询-键-值 加权求和',
    `finalSkeleton[0].title=${loop1.finalSkeleton && loop1.finalSkeleton.lessonPlan && loop1.finalSkeleton.lessonPlan[0].title}`);

  const loopStages = loopProgress.map(p => p.stage);
  record('runCritiqueLoop emits round-tagged stages + critique:converged',
    loopStages.includes('critique:round-start')
    && loopStages.includes('revise:start')
    && loopStages.includes('revise:done')
    && loopStages.includes('critique:converged'),
    `stages=[${[...new Set(loopStages)].join(', ')}]`);

  // Round-tag payload sanity: every nested stage should carry round number.
  const roundStartEvents = loopProgress.filter(p => p.stage === 'critique:round-start');
  record('runCritiqueLoop critique:round-start fires per round w/ round payload',
    roundStartEvents.length === 2
    && roundStartEvents[0].payload.round === 1
    && roundStartEvents[1].payload.round === 2,
    `rounds=${JSON.stringify(roundStartEvents.map(e => e.payload && e.payload.round))}`);

  // ── Case 7 (Gap 3) — runCritiqueLoop hits max rounds without converging ──
  // Both rounds shouldRevise=true → loop runs full 2 rounds, returns
  // totalRounds=2, history[last].shouldRevise=true (un-converged).
  _stubMode = 'shouldRevise';
  _stubModeSequence = ['shouldRevise', 'shouldRevise'];
  _critiqueInvocations = 0;
  _seenWeaverThisInvocation = false;
  _executeChatCalls = [];
  const loop2 = await runCritiqueLoop({
    skeleton: makeSkeleton(),
    archetype: 'TECH-CONCEPT',
    goal: '理解 transformer 注意力',
    difficulty: 0.7,
    sources: makeSources(),
    settings: {},
    maxRounds: 2,
  });

  record('runCritiqueLoop hits maxRounds=2 when never converges',
    loop2.totalRounds === 2
    && loop2.history.length === 2
    && loop2.history[loop2.history.length - 1].shouldRevise === true,
    `totalRounds=${loop2.totalRounds}, last.shouldRevise=${loop2.history[loop2.history.length - 1].shouldRevise}`);

  // ── Case 8 (Gap 3) — runCritiqueLoop fast-converges at round 1 ────────
  // Round 1 returns empty findings → converged immediately, no revise call.
  _stubMode = 'empty';
  _stubModeSequence = [];
  _critiqueInvocations = 0;
  _seenWeaverThisInvocation = false;
  _executeChatCalls = [];
  const loop3 = await runCritiqueLoop({
    skeleton: makeSkeleton(),
    archetype: 'TECH-CONCEPT',
    goal: '简单入门',
    difficulty: 0.3,
    sources: makeSources(),
    settings: {},
    maxRounds: 2,
  });

  record('runCritiqueLoop converges at round 1 when first critique empty',
    loop3.totalRounds === 1
    && loop3.history.length === 1
    && loop3.history[0].shouldRevise === false,
    `totalRounds=${loop3.totalRounds}, history=${JSON.stringify(loop3.history.map(h => ({ r: h.round, sr: h.shouldRevise })))}`);

  // Reset back to defaults so any later cases stay sane.
  _stubModeSequence = [];
  _critiqueInvocations = 0;
  _seenWeaverThisInvocation = false;

  // ── Summary ──────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  const total  = results.length;
  console.log(`\nPASS ${passed}/${total}`);
  if (passed !== total) {
    console.log('FAILED:');
    for (const r of results.filter(r => !r.ok)) console.log(`  - ${r.name}`);
    process.exit(1);
  }
  process.exit(0);
})().catch(err => {
  console.error('FATAL:', err && err.stack || err);
  process.exit(1);
});
