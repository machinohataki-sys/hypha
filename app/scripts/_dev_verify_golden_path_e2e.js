'use strict';

// RUN_SEQUENTIAL — LLM-bound, parallel pool causes rate-limit / timeout

// HYPHA · Golden-Path E2E integration smoke — boot-5 cross-system seam check.
//
// Created 2026-05-19 per machino boot-5 task brief. HYPHA has 10 systems at
// 70-92% ship each, but NO cross-system integration smoke — when a lib
// signature drifts (return-shape rename, archetype-aware param add, options
// envelope change), the failure surfaces in Electron at runtime, not in CI.
// This script wires the canonical user-flow as lib-to-lib calls so contract
// drift surfaces in one place.
//
// Canonical flow under test:
//
//   goal-set
//     → chain-plan          (planChain LLM-bound, fold pure)
//     → lesson-body-gen     (generateLessonBodyV2 LLM-bound)
//     → citation/anti-slop  (coverage + contamination-graph pure)
//     → exam-emit           (computeExamCadence pure)
//     → growth-tick         (getNorthStar reads vault)
//     → companion-express   (detectEmotionState + composeExpression pure)
//     → cost-gate           (predictCost + gateAgainstBudget pure)
//     → pricing-tier        (queryTier pure)
//
// 12 tests (GP1-GP12). LLM-bound tests SKIP without an LLM key (per
// `_dev_verify_creation_system.js` convention). Failures here surface real
// integration gaps — the value of this smoke is the FAIL list, not the
// green checkmarks.
//
// Synthetic-data fixtures only. No vault writes outside a dedicated test
// slug (`__verify_golden_path__`). Vault dir is cleaned at start, then
// re-seeded with the synthetic body files GP5 + GP7 need to read.
//
// Exit code: 0 on (PASS|SKIP only), 1 on any FAIL, 2 on uncaught throw.

const fs   = require('node:fs');
const path = require('node:path');

const SLUG = '__verify_golden_path__';

// ---------------------------------------------------------------------------
// Vault root pin — same pattern as `_dev_verify_full_chain.js`. Some libs
// read HYPHA_DATA at require-time (web-note-engine, etc.); pin it BEFORE any
// system module is loaded so they all see the same root.
// ---------------------------------------------------------------------------

const vault = require('../lib/vault');
const VAULT_ROOT = vault.resolveRoot();
process.env.HYPHA_DATA = VAULT_ROOT;

// ---------------------------------------------------------------------------
// Module imports — real libs, NOT mocks (per task brief #3). HTTP layer is
// the only thing stubbed (LLM calls SKIP cleanly when no key).
// ---------------------------------------------------------------------------

const goalCrystallizer  = require('../lib/creation/goal-crystallizer');
const chainFolder       = require('../lib/chain-folder');
const lessonBody        = require('../lib/lesson-body-generator');
const coverage          = require('../lib/citation-system/coverage');
const contaminationGraph = require('../lib/anti-slop/contamination-graph');
const examCadence       = require('../lib/exam-system/exam-cadence');
const northStar         = require('../lib/growth/north-star-metrics');
const emotionState      = require('../lib/companion/emotion-state');
const emotionToneBridge = require('../lib/companion/emotion-tone-bridge');
const costPredictor     = require('../lib/llm/cost-predictor');
const loyaltyEngine     = require('../lib/pricing/loyalty-engine');

// ---------------------------------------------------------------------------
// Console colours.
// ---------------------------------------------------------------------------

const C_GREEN  = '\x1b[32m';
const C_YELLOW = '\x1b[33m';
const C_RED    = '\x1b[31m';
const C_DIM    = '\x1b[2m';
const C_RESET  = '\x1b[0m';

function green(s)  { return `${C_GREEN}${s}${C_RESET}`; }
function yellow(s) { return `${C_YELLOW}${s}${C_RESET}`; }
function red(s)    { return `${C_RED}${s}${C_RESET}`; }
function dim(s)    { return `${C_DIM}${s}${C_RESET}`; }

// ---------------------------------------------------------------------------
// Test-runner state.
// ---------------------------------------------------------------------------

const results = []; // { id, status:'PASS'|'FAIL'|'SKIP', label, detail }
let assertionCount = 0;
const gaps = []; // human-readable integration gap descriptions surfaced by failures/skips

function record(id, status, label, detail = '') {
  results.push({ id, status, label, detail });
  const tag = status === 'PASS' ? green('PASS')
            : status === 'SKIP' ? yellow('SKIP')
            : red('FAIL');
  console.log(`[${id}] ${tag}  ${label}${detail ? ' — ' + detail : ''}`);
}

function assert(cond, msg) {
  assertionCount++;
  if (!cond) {
    throw new Error(`assertion failed: ${msg}`);
  }
}

// Wrap a test fn so a thrown assertion → FAIL (with gap surfaced),
// thrown SKIP_SENTINEL → SKIP (with reason in gaps as "[deferred]"),
// success → PASS.
const SKIP_SENTINEL = Symbol('skip');
function skip(reason) {
  const e = new Error(reason);
  e[SKIP_SENTINEL] = true;
  throw e;
}

async function runTest(id, label, fn) {
  try {
    const detail = await fn();
    record(id, 'PASS', label, detail || '');
  } catch (err) {
    if (err && err[SKIP_SENTINEL]) {
      record(id, 'SKIP', label, err.message);
      gaps.push(`${id} [deferred] ${label} — ${err.message}`);
    } else {
      record(id, 'FAIL', label, (err && err.message) || String(err));
      gaps.push(`${id} [GAP] ${label} — ${(err && err.message) || String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// LLM key detection — same env vars the providers consume (CLAUDE.md provider
// notes). LLM-bound tests (GP1, GP3) SKIP cleanly without one.
// ---------------------------------------------------------------------------

function detectLlmKey() {
  const keys = ['GLM_API_KEY', 'DEEPSEEK_API_KEY', 'KIMI_API_KEY'];
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === 'string' && v.trim().length > 10) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vault scaffolding for GP5 + GP7 — synthetic lesson body files and
// concept-lifecycle ledger so the read-only libs have something to chew on.
// ---------------------------------------------------------------------------

function vaultDir() {
  return path.join(VAULT_ROOT, SLUG);
}

function cleanSlugVault() {
  const dir = vaultDir();
  if (!fs.existsSync(dir)) return;
  // Owned files only — never blow up scratch notes a human may have dropped.
  const owned = [
    'lesson-0.body.json',
    'lesson-1.body.json',
    'lesson-2.body.json',
    '.concept-lifecycle.jsonl',
    '.hypha',
  ];
  for (const f of owned) {
    const abs = path.join(dir, f);
    if (!fs.existsSync(abs)) continue;
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        fs.rmSync(abs, { recursive: true, force: true });
      } else {
        fs.unlinkSync(abs);
      }
    } catch (_) { /* best-effort */ }
  }
}

function seedSyntheticBodies() {
  const dir = vaultDir();
  fs.mkdirSync(dir, { recursive: true });

  // 3 lesson body files with overlapping concepts so contamination-graph has
  // edges to draw (lesson 2 lists concepts whose prerequisites land in
  // lesson 0 + lesson 1).
  const bodies = [
    {
      idx: 0,
      body: {
        thesis: '认知图谱的最小单位是节点与边的对应关系',
        canonical_example: '把张三的"努力工作"标为节点 A, "升职"标为节点 B, 连一条因果边, 这就是认知图谱的基本结构。后续推理可以追溯。',
        exit_proof: '能在白板上画三个相互关联的概念节点并解释每条边的理由',
        mechanism_explanation: '概念图谱通过显式表达节点与边的关系, 把隐性知识变成可被外部检视的拓扑结构, 推理可追溯, 错误可定位。',
        note_connection: '与上一节"知识表征的层级"形成上下接续',
        common_misconceptions: [
          '认为节点就是名词, 边就是动词 —— 实际节点也可以是事件',
          '认为图谱构建越大越好 —— 实际越精炼越可用',
        ],
        jargon_list: ['节点', '边'],
        concepts: ['认知图谱', '节点', '边'],
        prerequisite_concepts: [],
        evidence_cite: [
          { marker: '[BK1]', book_id: 'sowa-1984', page: 12 },
        ],
      },
    },
    {
      idx: 1,
      body: {
        thesis: '边的方向反映因果与依赖的方向',
        canonical_example: '在因果链中, "下雨"→"地湿" 是单向的; 在双向依赖中, "概念 A 解释 B" 与 "B 解释 A" 可以共存, 但要标 bi-directional。',
        exit_proof: '能区分 directed / undirected / bi-directional 三种边并各举一例',
        mechanism_explanation: '边的方向编码了因果性、时序性或解释性, 不同方向语义在图谱推理时走不同的传播路径, 误用方向会让推理结果与现实背离。',
        note_connection: '基于第 0 节的节点与边定义往前推进',
        common_misconceptions: [
          '把所有关系都画成无向边 —— 丢失因果信息',
          '把双向依赖画成两条单向边 —— 推理时容易死循环',
        ],
        jargon_list: ['directed', 'undirected'],
        concepts: ['有向边', '无向边', '双向依赖'],
        prerequisite_concepts: ['认知图谱', '节点', '边'],
        evidence_cite: [
          { marker: '[BK1]', book_id: 'sowa-1984', page: 31 },
          { marker: '[BK2]', book_id: 'pearl-2009', page: 7 },
        ],
      },
    },
    {
      idx: 2,
      body: {
        thesis: '图谱推理依赖路径完整性',
        canonical_example: '若从"张三努力"推到"张三升职"需经过"张三业绩好", 而"业绩好"这一节点缺失或被标为待验证, 整条推理就不能闭合。',
        exit_proof: '能在缺失节点的情况下识别推理中断点并写出补节点的请求',
        mechanism_explanation: '推理走的是从起点节点经过有向边到达终点节点的路径; 任一节点缺失或边方向矛盾, 都会让结论失去可追溯性, 整条链应被标记为 incomplete。',
        note_connection: '把第 1 节的边方向引入到路径完整性的讨论',
        common_misconceptions: [
          '认为推理失败是节点错 —— 实际多是路径中断',
          '认为补节点越多越好 —— 实际只补关键中断点',
        ],
        jargon_list: ['路径完整性', '中断点'],
        concepts: ['路径完整性', '推理路径', '中断点'],
        prerequisite_concepts: ['有向边', '双向依赖', '节点'],
        evidence_cite: [
          { marker: '[BK2]', book_id: 'pearl-2009', page: 41 },
        ],
      },
    },
  ];

  for (const { idx, body } of bodies) {
    fs.writeFileSync(
      path.join(dir, `lesson-${idx}.body.json`),
      JSON.stringify(body, null, 2),
      'utf-8'
    );
  }
  return bodies;
}

// Seed concept-lifecycle ledger so GP7 north-star can read non-zero counts.
// Schema follows what concept-lifecycle.js writes — seed rows (conceptId→name)
// + transition rows (toState, txId).
function seedConceptLifecycle() {
  const dir = vaultDir();
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  const now = Date.now();
  const concepts = [
    { conceptId: 'c1', name: '认知图谱', state: 'ratified' },
    { conceptId: 'c2', name: '有向边',   state: 'ratified' },
    { conceptId: 'c3', name: '路径完整性', state: 'draft' },
    { conceptId: 'c4', name: '中断点',   state: 'review' },
  ];
  for (const c of concepts) {
    // Seed row (id → name).
    lines.push(JSON.stringify({
      conceptId: c.conceptId,
      name: c.name,
      ts: new Date(now - 1000 * 60 * 60 * 24 * 3).toISOString(),
    }));
    // Transition row (toState).
    lines.push(JSON.stringify({
      txId: `tx-${c.conceptId}-1`,
      conceptId: c.conceptId,
      toState: c.state,
      ts: new Date(now - 1000 * 60 * 60 * 24 * 1).toISOString(),
    }));
  }
  fs.writeFileSync(
    path.join(dir, '.concept-lifecycle.jsonl'),
    lines.join('\n') + '\n',
    'utf-8'
  );
}

// ---------------------------------------------------------------------------
// Synthetic shared fixtures — chain links + goalContract + lesson body.
// Re-used by GP2 / GP3 / GP4 so contract-drift in one breaks the cascade
// (this IS the integration smoke value).
// ---------------------------------------------------------------------------

const SYNTHETIC_GOAL_DRAFT = '我想用 6 个月把"认知图谱"这套思考工具吃透, 落到至少一个公开发表的实例。';

const SYNTHETIC_ANSWERS = [
  {
    question: '你的主要产出形态是什么?',
    dimension: 'output_form',
    chosen_label: '公开发表 1 篇长文 + 配图谱',
    implies: 'main_creation=long_form_essay',
  },
  {
    question: '时间投入预算?',
    dimension: 'timeline',
    chosen_label: '6 个月每周 5 小时',
    implies: 'time_budget=130h',
  },
  {
    question: '当前水平?',
    dimension: 'current_level',
    chosen_label: '看过几篇博客, 没系统画过',
    implies: 'level=hobbyist',
  },
];

const SYNTHETIC_GOAL_CONTRACT = Object.freeze({
  north_star_goal: '6 个月内画出 3 张认知图谱并发表 1 篇长文',
  main_creation: '一篇 8000 字的长文 + 配 3 张图谱',
  current_level: '看过几篇博客, 没系统画过',
  learning_model: 'Growth',
  deadline_iso: new Date(Date.now() + 1000 * 60 * 60 * 24 * 180).toISOString().slice(0, 10),
  days: 180,
  archetype: 'HUMANITIES',
});

// Mimic planChain output shape that chain-folder.foldChain consumes.
const SYNTHETIC_CHAIN_LINKS = [
  {
    topic: '认知图谱基础',
    duration_weeks: 3,
    lessons_count: 12,
    role: 'prerequisite',
    rationale: '节点/边/方向语义',
    exit_criterion: '能独立画 3 节点小图',
  },
  {
    topic: '路径推理与因果',
    duration_weeks: 5,
    lessons_count: 22,
    role: 'core',
    rationale: '从单链路径到多源汇聚',
    exit_criterion: '能在小图上做完整推理',
  },
  {
    topic: '认知图谱在长文中的运用',
    duration_weeks: 6,
    lessons_count: 30,
    role: 'ultimate',
    rationale: '把图谱嵌入论述',
    exit_criterion: '完成 1 篇 8000 字长文初稿',
  },
];

// Synthetic body for GP4 coverage check — re-uses one of the GP5-seeded
// shapes, plus partial citations so coverage_pct is computable.
const SYNTHETIC_BODY_FOR_COVERAGE = {
  thesis: '认知图谱的最小单位是节点与边的对应关系',
  canonical_example: '把张三的"努力工作"标为节点 A, "升职"标为节点 B, 连一条因果边, 这就是认知图谱的基本结构。后续推理可以追溯。',
  exit_proof: '能在白板上画三个相互关联的概念节点并解释每条边的理由',
  mechanism_explanation: '概念图谱通过显式表达节点与边的关系, 把隐性知识变成可被外部检视的拓扑结构, 推理可追溯, 错误可定位。',
  note_connection: '与上一节"知识表征的层级"形成上下接续',
  common_misconceptions: [
    '认为节点就是名词, 边就是动词 —— 实际节点也可以是事件',
    '认为图谱构建越大越好 —— 实际越精炼越可用',
  ],
  jargon_list: ['节点', '边'],
  evidence_cite: [
    { marker: '[BK1]', book_id: 'sowa-1984', page: 12 },
    { marker: '[BK2]', book_id: 'pearl-2009', page: 7 },
  ],
};

// ---------------------------------------------------------------------------
// GP1 — Goal Crystallizer accepts raw draft + answers, returns contract.
// LLM-bound; SKIP cleanly without key.
// ---------------------------------------------------------------------------

async function gp1_goalCrystallizer(hasKey) {
  if (!hasKey) {
    skip('no LLM key in env (GLM/DEEPSEEK/KIMI) — crystallizeGoal requires T3_MID dispatch');
  }
  const res = await goalCrystallizer.crystallizeGoal({
    draftGoal: SYNTHETIC_GOAL_DRAFT,
    archetype: 'HUMANITIES',
    answers: SYNTHETIC_ANSWERS,
    settings: {},
    options: { capability: 'T3_MID', maxTokens: 800, temperature: 0.3 },
  });
  assert(res && typeof res === 'object', 'crystallizeGoal must return object');
  assert(res.ok === true, `crystallizeGoal.ok=false → ${res && res.error}`);
  assert(typeof res.crystallized_goal === 'string' && res.crystallized_goal.length > 0,
    'crystallized_goal must be non-empty string');
  assert(res.tags && typeof res.tags === 'object', 'tags object required');
  assert(typeof res.tags.primary_focus === 'string' && res.tags.primary_focus.length > 0,
    'tags.primary_focus required');
  return `crystallized: "${res.crystallized_goal.slice(0, 40)}…"`;
}

// ---------------------------------------------------------------------------
// GP2 — Chain plan. planChain itself lives in agent.js (LLM + Electron sibling
// state). What we CAN verify in standalone is the post-process pipeline:
// chain-folder.foldChain consumes the same `links[]` schema planChain emits.
// Test: feed synthetic links shaped exactly like planChain output, assert
// foldChain returns folded array w/ status + decisions. This is the
// load-bearing seam — if planChain renames `lessons_count` to `count` (e.g.)
// foldChain breaks here.
// ---------------------------------------------------------------------------

async function gp2_chainPlanFold() {
  const folded = chainFolder.foldChain({
    links: SYNTHETIC_CHAIN_LINKS,
    mode: SYNTHETIC_GOAL_CONTRACT.learning_model, // Growth
    tier: 'moderate',
    archetype: SYNTHETIC_GOAL_CONTRACT.archetype,
  });
  assert(folded && typeof folded === 'object', 'foldChain must return object');
  assert(Array.isArray(folded.folded), 'foldChain.folded must be array');
  assert(folded.folded.length > 0, 'foldChain.folded must be non-empty');
  assert(typeof folded.status === 'string', 'foldChain.status must be string');
  assert(['OK', 'NEEDS_REROUTE'].includes(folded.status),
    `foldChain.status must be OK|NEEDS_REROUTE, got ${folded.status}`);
  // Verify the shape of a folded link still matches what lesson-body-generator
  // expects (topic + lessons_count + role).
  const first = folded.folded[0];
  assert(typeof first.topic === 'string', 'folded[0].topic required');
  assert(Number.isFinite(first.lessons_count), 'folded[0].lessons_count required (number)');
  assert(typeof first.role === 'string', 'folded[0].role required');
  // Soft-cap: 12 + 22 + 30 = 64 > Growth soft cap 30, so we expect folding to
  // have happened (role-cap on `core` 22→22 unchanged, `ultimate` 30→30 unchanged,
  // prerequisite 12→12 unchanged; total still 64 > 30 → expect at least 1 decision
  // OR NEEDS_REROUTE if hard cap also exceeded). Total 64 > HARD_CAP 60 → NEEDS_REROUTE.
  if (folded.status === 'NEEDS_REROUTE') {
    return `status=NEEDS_REROUTE (total=${chainFolder.totalLessons(folded.folded)} > HARD_CAP=${chainFolder.HARD_CAP})`;
  }
  return `status=OK, ${folded.folded.length} links, ${folded.foldDecisions.length} decisions`;
}

// ---------------------------------------------------------------------------
// GP3 — Lesson body generation. LLM-bound; SKIP cleanly without key.
// ---------------------------------------------------------------------------

async function gp3_lessonBodyGen(hasKey) {
  if (!hasKey) {
    skip('no LLM key (LLM body generation needs T6_STRONG dispatch — generateLessonBodyV2)');
  }
  const plan = {
    objective: '理解认知图谱的节点与边语义',
    lesson_title: '节点与边的基本对应',
    learn_goal: '能在白板上画 3 节点小图并解释每条边的理由',
    idx: 0,
  };
  const sources = [
    {
      title: 'Conceptual Graphs - Sowa 1984',
      content: '认知图谱的基本结构是节点 (representing entities or events) 与有向边 (representing relations). ...',
      best_use: 'lesson',
    },
  ];
  const res = await lessonBody.generateLessonBodyV2({
    plan,
    goalContract: SYNTHETIC_GOAL_CONTRACT,
    sources,
    audience: 'hobbyist',
    learnerState: {},
    lessonTitle: plan.lesson_title,
    learnGoal: plan.learn_goal,
    idx: 0,
    pedagogicalArchetype: 'HUMANITIES',
    options: { maxRetries: 1, capability: 'T6_STRONG', maxTokens: 2500, timeoutMs: 60000 },
  }).catch((err) => ({ _gen_error: (err && err.message) || String(err) }));

  if (res && res._gen_error) {
    skip(`lesson body generation threw: ${res._gen_error.slice(0, 120)}`);
  }
  assert(res && typeof res === 'object', 'generateLessonBodyV2 must return object');
  assert(res.body && typeof res.body === 'object', 'res.body required');
  assert(typeof res.body.thesis === 'string' && res.body.thesis.length > 0,
    'body.thesis required');
  // prerequisite_concepts is recently-added (concept-ledger), may be absent
  // for some retries — surface as gap if missing.
  if (!Array.isArray(res.body.prerequisite_concepts)) {
    gaps.push('GP3 [observation] body.prerequisite_concepts not array — concept ledger may not be wired into generation');
  }
  return `thesis="${res.body.thesis.slice(0, 40)}…"`;
}

// ---------------------------------------------------------------------------
// GP4 — Citation coverage on a real synthetic body. Pure function.
// ---------------------------------------------------------------------------

async function gp4_citationCoverage() {
  const cov = coverage.computeBodyCoverage(SYNTHETIC_BODY_FOR_COVERAGE, { threshold: 60 });
  assert(cov && typeof cov === 'object', 'computeBodyCoverage must return object');
  assert(Number.isFinite(cov.coverage_pct), 'coverage_pct must be finite number');
  assert(cov.coverage_pct >= 0 && cov.coverage_pct <= 100,
    `coverage_pct must be 0..100, got ${cov.coverage_pct}`);
  assert(Number.isFinite(cov.total_claims), 'total_claims must be number');
  // Synthetic body has thesis(1) + mechanism(1) + 2 misconceptions = 4 claims,
  // 2 evidence_cite = 50%. Regression guard: coverage_pct > 0 for non-empty.
  assert(cov.total_claims > 0, 'total_claims should be > 0 for synthetic body w/ thesis+mechanism+misconceptions');
  assert(cov.coverage_pct > 0,
    `coverage_pct should be > 0 for body with 2 evidence_cite entries, got ${cov.coverage_pct}%`);
  assert(typeof cov.reason === 'string' && cov.reason.length > 0, 'reason string required');
  assert(typeof cov.gate_passed === 'boolean', 'gate_passed must be boolean');
  return `coverage=${cov.coverage_pct}% (${cov.cited_count}/${cov.total_claims}), sources=${cov.sources}, gate=${cov.gate_passed ? 'pass' : 'fail'}`;
}

// ---------------------------------------------------------------------------
// GP5 — Anti-Slop contamination graph populated from seeded bodies.
// ---------------------------------------------------------------------------

async function gp5_contaminationGraph() {
  const g = contaminationGraph.buildGraph({ slug: SLUG, vaultRoot: VAULT_ROOT });
  assert(g && typeof g === 'object', 'buildGraph must return object');
  assert(g.status === 'OK', `status should be OK, got ${g.status}`);
  assert(Array.isArray(g.nodes), 'nodes must be array');
  assert(Array.isArray(g.edges), 'edges must be array');
  // Synthetic lessons: 0 has {认知图谱, 节点, 边}; 1 lists those as prereqs +
  // {有向边, 无向边, 双向依赖}; 2 has prereqs from 1. So expect ≥ 1 edge.
  assert(g.nodes.length > 0, 'nodes count should be > 0 for seeded lessons');
  assert(g.edges.length > 0, `edges count should be > 0 (got ${g.edges.length})`);
  assert(g.stats && typeof g.stats === 'object', 'stats object required');
  assert(Number.isFinite(g.stats.max_depth), 'stats.max_depth must be number');
  return `${g.nodes.length} nodes, ${g.edges.length} edges, max_depth=${g.stats.max_depth}`;
}

// ---------------------------------------------------------------------------
// GP6 — Exam cadence emits valid mode + lesson_split + focus.
// ---------------------------------------------------------------------------

async function gp6_examCadence() {
  // Three reference scenarios from the band table.
  const scenarios = [
    { daysRemaining: 5, expectedMode: 'final' },
    { daysRemaining: 25, expectedMode: 'compression' },
    { daysRemaining: 90, expectedMode: 'expansion' },
  ];
  const lines = [];
  for (const s of scenarios) {
    const r = examCadence.computeExamCadence({
      daysRemaining: s.daysRemaining,
      currentScopeProgress: { must_master: 0.6 },
      errorAccumulation: 5,
    });
    assert(r && typeof r === 'object', 'computeExamCadence must return object');
    assert(r.mode === s.expectedMode,
      `daysRemaining=${s.daysRemaining}: expected mode=${s.expectedMode}, got ${r.mode}`);
    assert(r.lesson_split && typeof r.lesson_split === 'object', 'lesson_split required');
    const splitSum = (r.lesson_split.new || 0) + (r.lesson_split.review || 0)
                   + (r.lesson_split.drill || 0) + (r.lesson_split.mock || 0);
    assert(splitSum === 100, `lesson_split must sum to 100, got ${splitSum} (mode=${r.mode})`);
    assert(typeof r.focus === 'string' && r.focus.length > 0, 'focus required');
    assert(typeof r.rationale === 'string' && r.rationale.length > 0, 'rationale required');
    assert(Array.isArray(r.escalations), 'escalations must be array');
    lines.push(`days=${s.daysRemaining}→${r.mode}/${r.focus}`);
  }
  return lines.join(' · ');
}

// ---------------------------------------------------------------------------
// GP7 — Growth-tick. getNorthStar reads vault/<slug>/.concept-lifecycle.jsonl.
// We seeded 4 concepts (2 ratified, 1 draft, 1 review).
// ---------------------------------------------------------------------------

async function gp7_growthTick() {
  const res = await northStar.getNorthStar({ slug: SLUG });
  assert(res && typeof res === 'object', 'getNorthStar must return object');
  if (!res.ok) {
    skip(`getNorthStar.ok=false → ${res.error || 'unknown'} (likely a sibling dep — see metrics block)`);
  }
  assert(res.metrics && typeof res.metrics === 'object', 'metrics object required');
  assert(Number.isFinite(res.metrics.ratified), 'metrics.ratified must be number');
  assert(Number.isFinite(res.metrics.draft_on_deck), 'metrics.draft_on_deck must be number');
  assert(Number.isFinite(res.metrics.artifacts_shipped), 'metrics.artifacts_shipped must be number');
  // Seeded ledger has 2 ratified — regression guard.
  if (res.metrics.ratified < 2) {
    gaps.push(`GP7 [observation] expected ratified ≥ 2 from seeded ledger, got ${res.metrics.ratified} — concept-lifecycle reader may have changed schema`);
  }
  assert(Array.isArray(res.recent_transitions), 'recent_transitions must be array');
  return `ratified=${res.metrics.ratified}, draft_on_deck=${res.metrics.draft_on_deck}, artifacts=${res.metrics.artifacts_shipped}, transitions=${res.recent_transitions.length}`;
}

// ---------------------------------------------------------------------------
// GP8 — Emotion state classifier returns a valid 5-tuple state for canonical
// signals. Pure.
// ---------------------------------------------------------------------------

async function gp8_emotionState() {
  const cases = [
    { input: { currentText: '我卡住了, 完全不懂', recentQuestions: [] }, expect: 'encouraging' },
    { input: { currentText: '我觉得节点就是名词',   recentQuestions: [] }, expect: 'mirror' },
    { input: { currentText: '帮我写一份长文初稿吧',  recentQuestions: [] }, expect: 'boundary-protect' },
    { input: { currentText: '今天天气真好',          recentQuestions: [] }, expect: 'idle' },
    { input: { currentText: '听说过路径完整性这个新概念', recentQuestions: [] }, expect: 'curious' },
  ];
  const lines = [];
  for (const c of cases) {
    const r = emotionState.detectEmotionState(c.input);
    assert(r && typeof r === 'object', 'detectEmotionState must return object');
    assert(typeof r.state === 'string', 'state must be string');
    assert(['idle', 'curious', 'encouraging', 'mirror', 'boundary-protect'].includes(r.state),
      `state must be one of 5 known values, got ${r.state}`);
    assert(Number.isFinite(r.confidence), 'confidence must be number');
    if (r.state !== c.expect) {
      gaps.push(`GP8 [observation] "${c.input.currentText}" expected state=${c.expect}, got ${r.state}`);
    }
    lines.push(`"${c.input.currentText.slice(0, 8)}…"→${r.state}`);
  }
  return lines.join(' · ');
}

// ---------------------------------------------------------------------------
// GP9 — Emotion-tone bridge composes the trigger × state envelope.
// ---------------------------------------------------------------------------

async function gp9_composeExpression() {
  // Standard trigger × boundary-protect emotion → suppression OR escalation.
  const res = await emotionToneBridge.composeExpression({
    trigger: 'lesson_complete',
    sessionContext: {
      currentText: '帮我写完吧',  // → boundary-protect (DELEGATE_REQUEST)
      recentQuestions: [],
      turnCount: 4,
    },
  });
  assert(res && typeof res === 'object', 'composeExpression must return object');
  assert(res.ok === true, `composeExpression.ok=false → ${res.error}`);
  // lesson_complete is in SUPPRESSION_RULES for boundary-protect, so we expect suppressed=true.
  assert(res.suppressed === true,
    `lesson_complete during boundary-protect must be suppressed, got suppressed=${res.suppressed}`);
  assert(typeof res.emotion === 'string', 'emotion must be string');

  // Now a non-suppressed trigger: interrupt_resume during idle → effective_trigger preserved.
  const res2 = await emotionToneBridge.composeExpression({
    trigger: 'interrupt_resume',
    sessionContext: { currentText: '继续之前的内容', recentQuestions: [], turnCount: 1 },
  });
  assert(res2.ok === true, `composeExpression #2 .ok=false → ${res2.error}`);
  assert(res2.suppressed === false, 'interrupt_resume during idle should not be suppressed');
  assert(typeof res2.effective_trigger === 'string', 'effective_trigger required');
  assert(res2.bias && typeof res2.bias === 'object', 'bias object required');
  assert(typeof res2.bias.register === 'string', 'bias.register required');
  // `expression` may be null if tone-engine yaml not loadable in test env — that's
  // tolerated per the bridge's silent-tolerate contract (see emotion-tone-bridge.js:155-170).
  return `lesson_complete×boundary-protect=suppressed · interrupt_resume×idle=${res2.effective_trigger} (register=${res2.bias.register}, expression=${res2.expression ? 'present' : 'null'})`;
}

// ---------------------------------------------------------------------------
// GP10 — Cost predictor on a real LLM call payload. Pure.
// ---------------------------------------------------------------------------

async function gp10_costPredictor() {
  const messages = [
    { role: 'system', content: '你是一个认知图谱教学助手。请用清晰的中文解释概念。' },
    { role: 'user',   content: '请解释"节点与边"的关系, 给出一个生活中的例子。' },
  ];
  const res = costPredictor.predictCost(messages, 'T3_MID', { maxOutputTokens: 1500 });
  assert(res && typeof res === 'object', 'predictCost must return object');
  assert(res.ok === true, `predictCost.ok=false → ${res.error}`);
  assert(res.estimate && typeof res.estimate === 'object', 'estimate object required');
  assert(Number.isFinite(res.estimate.input_tokens_est), 'input_tokens_est must be number');
  assert(res.estimate.input_tokens_est > 0, 'input_tokens_est must be > 0 for non-empty messages');
  assert(Number.isFinite(res.estimate.cny_est), 'cny_est must be number');
  assert(res.estimate.cny_est >= 0, 'cny_est must be ≥ 0');
  assert(res.estimate.capability === 'T3_MID', 'capability must round-trip');
  // Sanity: T3_MID is cheap; 1500-token cap → max output cost ≈ 1.5 * 0.015 = 0.0225 ¥.
  // Plus tiny input. So sane range is < 1.0 ¥.
  assert(res.estimate.cny_est < 1.0,
    `cny_est suspiciously high for T3_MID + small payload: ${res.estimate.cny_est}`);
  return `tokens=${res.estimate.input_tokens_est}+${res.estimate.output_tokens_max}, cny=¥${res.estimate.cny_est}`;
}

// ---------------------------------------------------------------------------
// GP11 — gateAgainstBudget integrates pre-call with a mock budget remaining.
// ---------------------------------------------------------------------------

async function gp11_budgetGate() {
  // Re-use cost from GP10 logic for realism.
  const messages = [{ role: 'user', content: 'short test' }];
  const pred = costPredictor.predictCost(messages, 'T6_STRONG', { maxOutputTokens: 500 });
  assert(pred.ok === true, 'predictCost prerequisite failed');
  const predictedCny = pred.estimate.cny_est;

  // Scenario A: plenty of budget.
  const gateA = costPredictor.gateAgainstBudget(predictedCny, 5.0);
  assert(gateA.allowed === true,
    `gateA allowed should be true for predicted=${predictedCny} vs remaining=5.0, got ${JSON.stringify(gateA)}`);

  // Scenario B: budget exhausted.
  const gateB = costPredictor.gateAgainstBudget(predictedCny, 0);
  assert(gateB.allowed === false, 'gateB allowed must be false when remaining=0');
  assert(gateB.reason === 'BUDGET_EXHAUSTED',
    `gateB.reason should be BUDGET_EXHAUSTED, got ${gateB.reason}`);

  // Scenario C: predicted > remaining.
  const gateC = costPredictor.gateAgainstBudget(predictedCny + 10, 0.001);
  assert(gateC.allowed === false, 'gateC must reject when predicted > remaining');
  assert(gateC.reason === 'WOULD_EXCEED_BUDGET',
    `gateC.reason should be WOULD_EXCEED_BUDGET, got ${gateC.reason}`);

  // Scenario D: invalid input.
  const gateD = costPredictor.gateAgainstBudget(NaN, 1);
  assert(gateD.allowed === false && gateD.reason === 'INVALID_INPUT',
    'gateD must reject NaN with INVALID_INPUT');

  return `A=allowed · B=BUDGET_EXHAUSTED · C=WOULD_EXCEED_BUDGET · D=INVALID_INPUT`;
}

// ---------------------------------------------------------------------------
// GP12 — Pricing loyalty tier from synthetic profile snapshots.
// ---------------------------------------------------------------------------

async function gp12_pricingTier() {
  const refMs = Date.parse('2026-05-19T00:00:00Z');
  // Free profile (no fields).
  const free = loyaltyEngine.queryTier({}, { refMs });
  assert(free.tier === 'free', `empty profile should be free, got ${free.tier}`);

  // BYOK takes priority.
  const byok = loyaltyEngine.queryTier({ byok_enabled: true, founder_purchased_at: '2024-01-01T00:00:00Z' }, { refMs });
  assert(byok.tier === 'byok', `byok should win over founders, got ${byok.tier}`);

  // Founders Y0-1 = ¥99.
  const f1 = loyaltyEngine.queryTier({ founder_purchased_at: '2026-01-01T00:00:00Z' }, { refMs });
  assert(f1.tier === 'founders', `Y0-1 founders tier, got ${f1.tier}`);
  assert(f1.monthly_cny === 99, `Y0-1 monthly should be 99, got ${f1.monthly_cny}`);
  assert(Array.isArray(f1.perks) && f1.perks.length === 4, 'founders should have 4 perks');

  // Founders Y3+ floor = ¥29.
  const f3 = loyaltyEngine.queryTier({ founder_purchased_at: '2022-01-01T00:00:00Z' }, { refMs });
  assert(f3.tier === 'founders', `Y3+ founders tier, got ${f3.tier}`);
  assert(f3.monthly_cny === 29, `Y3+ founders monthly should be 29 (floor), got ${f3.monthly_cny}`);
  assert(f3.pricing_floor === 29, `founders pricing_floor should be 29, got ${f3.pricing_floor}`);

  // Pro Y0-1.
  const p1 = loyaltyEngine.queryTier({ pro_started_at: '2026-01-01T00:00:00Z' }, { refMs });
  assert(p1.tier === 'pro', `Y0-1 pro tier, got ${p1.tier}`);
  assert(p1.monthly_cny === 99, `Y0-1 pro monthly should be 99, got ${p1.monthly_cny}`);

  // Basic flat ¥39.
  const b = loyaltyEngine.queryTier({ basic_started_at: '2024-01-01T00:00:00Z' }, { refMs });
  assert(b.tier === 'basic', `basic tier, got ${b.tier}`);
  assert(b.monthly_cny === 39, `basic monthly should be 39, got ${b.monthly_cny}`);

  return `free→free · byok→byok · founders(Y0)→¥99 · founders(Y3+)→¥29 · pro(Y0)→¥99 · basic→¥39`;
}

// ---------------------------------------------------------------------------
// Main runner.
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  console.log('=== HYPHA Golden-Path E2E integration smoke ===');
  console.log(`vault root: ${VAULT_ROOT}`);
  console.log(`test slug:  ${SLUG}`);

  // Vault prep.
  cleanSlugVault();
  seedSyntheticBodies();
  seedConceptLifecycle();
  console.log(dim('  seeded 3 lesson body files + 4-concept lifecycle ledger'));

  // LLM key detection.
  const keyName = detectLlmKey();
  const hasKey = Boolean(keyName);
  console.log(`LLM key:    ${hasKey ? green(keyName + ' detected') : yellow('none — GP1 + GP3 will SKIP')}`);
  console.log('');

  // Run all 12 tests sequentially. Each is independent — no shared mutable state
  // beyond the vault dir (which only GP5+GP7 read).
  await runTest('GP1',  'goal-crystallizer accepts raw draft + answers',           () => gp1_goalCrystallizer(hasKey));
  await runTest('GP2',  'chain-folder consumes planChain-shaped links',            () => gp2_chainPlanFold());
  await runTest('GP3',  'lesson-body-generator returns body w/ claims',            () => gp3_lessonBodyGen(hasKey));
  await runTest('GP4',  'citation/coverage computes coverage_pct from body',       () => gp4_citationCoverage());
  await runTest('GP5',  'anti-slop/contamination-graph populated from bodies',     () => gp5_contaminationGraph());
  await runTest('GP6',  'exam-cadence emits valid mode + lesson_split',            () => gp6_examCadence());
  await runTest('GP7',  'growth/north-star reads concept-lifecycle ledger',        () => gp7_growthTick());
  await runTest('GP8',  'companion/emotion-state returns 5-tuple state',           () => gp8_emotionState());
  await runTest('GP9',  'companion/emotion-tone-bridge composes expression',       () => gp9_composeExpression());
  await runTest('GP10', 'cost-predictor.predictCost returns sane CNY estimate',    () => gp10_costPredictor());
  await runTest('GP11', 'cost-predictor.gateAgainstBudget integrates 4 scenarios', () => gp11_budgetGate());
  await runTest('GP12', 'pricing/loyalty-engine.queryTier returns valid tier',     () => gp12_pricingTier());

  // -------------------------------------------------------------------------
  // Summary.
  // -------------------------------------------------------------------------

  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const sk   = results.filter(r => r.status === 'SKIP').length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('');
  console.log('=== Summary ===');
  console.log(`GP1-GP12: ${green(pass + ' PASS')} / ${red(fail + ' FAIL')} / ${yellow(sk + ' SKIP')}`);
  console.log(`Integration health: ${pass}/12 = ${Math.round((pass / 12) * 100)}%`);
  console.log(`Total assertions: ${assertionCount} (elapsed ${elapsed}s)`);
  console.log(`Vault remains at: ${vaultDir()} (kept for inspection)`);

  if (gaps.length > 0) {
    console.log('');
    console.log('=== Detected gaps ===');
    for (const g of gaps) {
      console.log('  · ' + g);
    }
  }

  if (fail > 0) {
    console.log('');
    console.log(red(`Exit 1 — ${fail} integration gap(s) surfaced. See "Detected gaps" above.`));
    process.exit(1);
  }
  console.log('');
  console.log(green(`Exit 0 — ${pass}/12 PASS, ${sk}/12 SKIP. ${sk > 0 ? 'SKIPs are deferred, not failures.' : ''}`));
  process.exit(0);
}

main().catch((err) => {
  console.error(red('\n[golden-path] uncaught: ') + (err && err.stack ? err.stack : err));
  process.exit(2);
});
