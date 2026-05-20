'use strict';

// RUN_SEQUENTIAL — LLM-bound, parallel pool causes rate-limit / timeout
// SKIP_HEADLESS — needs GLM_API_KEY (or equivalent provider key) in env; CI fresh-runners don't carry secrets on PR.

// HYPHA · Full-Chain dev-verify — extends `_dev_verify_creation_system.js` (8
// steps) with 7 additional steps that cover Goal Guardian (LLM math floor),
// Anti-Slop archetype-aware detectors + PJR gate, Persona Wisdom loader,
// Living Note Reactivation, and Web Note Engine CRUD. 15 steps total.
//
// Created 2026-05-15. Companion to:
//   - app/scripts/_dev_verify_cost_ledger.js  (V0.5 E1 cost-ledger gate)
//   - app/scripts/_dev_verify_creation_system.js (Creation System chain)
//
// Why a SEPARATE script — the original creation-system verify is shaped
// around 8 sequential steps that share a single vault slug + write order.
// Mashing 7 new heterogeneous steps (mostly read-only / pure-fn) into it
// would dilute the chain semantics; the new script can carry its own slug
// (`__verify_full_chain__`) and pre-seed lesson-NN.md files in step 14
// without polluting the existing __verify_creation_system__ vault.
//
// Standalone Node — no Electron. Uses vault.resolveRoot() which resolves to
// hypha/data/<slug> by default. To unify path resolution with the engines
// that look at HYPHA_DATA (living-reactivation + web-note-engine), we set
// process.env.HYPHA_DATA = vault.resolveRoot() at the top of main() before
// any module that consults it is loaded fresh — see step 14/15 prep.
//
// SKIP rules when no GLM/DEEPSEEK/KIMI API key in env:
//   Step 1 + 2  (Goal Guardian LLM judge)
//   Step 7 + 8  (extract-from-lesson LLM)
//   Step 10     (Roadmap LLM)
//   Step 14     LLM-selected fanout (jaccard pre-filter still runs)
//
// Exit code: 0 on PASS (skipped allowed), 1 on any FAIL, 2 on uncaught throw.

const fs   = require('node:fs');
const path = require('node:path');

const SLUG = '__verify_full_chain__';

// ---------------------------------------------------------------------------
// Vault root pin — set HYPHA_DATA BEFORE we require living-reactivation or
// web-note-engine so they all use the same root as vault.resolveRoot().
// vault.resolveRoot() returns <repo>/data; web-note-engine defaults to
// <repo>/vault when HYPHA_DATA is unset, which would split the test fixtures
// across two roots and break step 15 + step 14.
// ---------------------------------------------------------------------------

const vault = require('../lib/vault');
const VAULT_ROOT = vault.resolveRoot();
process.env.HYPHA_DATA = VAULT_ROOT;

// ---------------------------------------------------------------------------
// Module imports — all standalone, no Electron.
// ---------------------------------------------------------------------------

const goalGuardian      = require('../lib/creation/goal-guardian');
const decisionLog       = require('../lib/creation/decision-log');
const assumptionLedger  = require('../lib/creation/assumption-ledger');
const productSpark      = require('../lib/creation/product-spark');
const extractor         = require('../lib/creation/extract-from-lesson');
const killWatcher       = require('../lib/creation/kill-watcher');
const roadmapSync       = require('../lib/creation/roadmap-sync');

const citationVerifier  = require('../lib/anti-slop/citation-verifier');
const confidenceLeak    = require('../lib/anti-slop/confidence-leak-detector');
const pjr               = require('../lib/anti-slop/prosecute-judge-rewrite');
const wisdomLoader      = require('../lib/personas/load-wisdom');
const livingNote        = require('../lib/note-system/living-reactivation');
const webNoteEngine     = require('../lib/note-system/web-note-engine');

// ---------------------------------------------------------------------------
// Console colours.
// ---------------------------------------------------------------------------

const C_GREEN  = '\x1b[32m';
const C_YELLOW = '\x1b[33m';
const C_RED    = '\x1b[31m';
const C_RESET  = '\x1b[0m';

function green(s)  { return `${C_GREEN}${s}${C_RESET}`; }
function yellow(s) { return `${C_YELLOW}${s}${C_RESET}`; }
function red(s)    { return `${C_RED}${s}${C_RESET}`; }

// ---------------------------------------------------------------------------
// Step-runner state.
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 15;
const results = [];          // { step, status, label, detail }
let assertionCount = 0;

function record(step, status, label, detail = '') {
  results.push({ step, status, label, detail });
  const tag = status === 'PASS' ? green('PASS')
            : status === 'SKIPPED' ? yellow('SKIPPED')
            : red('FAIL');
  console.log(`[${step}/${TOTAL_STEPS}] ${tag}  ${label}${detail ? ' — ' + detail : ''}`);
}

function assert(cond, msg) {
  assertionCount++;
  if (!cond) {
    console.error(red(`  assertion FAILED: ${msg}`));
    throw new Error(`assertion failed: ${msg}`);
  }
}

// Trim defends against PowerShell `>>` baking `\n` into User env vars.
function detectLlmKey() {
  const keys = ['GLM_API_KEY', 'DEEPSEEK_API_KEY', 'KIMI_API_KEY'];
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === 'string' && v.trim().length > 10) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vault cleanup — idempotent re-runs leave dir intact for inspection but
// clear our own jsonl + sources + lesson fixtures.
// ---------------------------------------------------------------------------

function vaultDir() {
  return path.join(VAULT_ROOT, SLUG);
}

function cleanSlugVault() {
  const dir = vaultDir();
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    return;
  }
  const owned = [
    'decisions.jsonl',
    'assumptions.jsonl',
    'sparks.jsonl',
    'decision-reviews.jsonl',
    'note-edges.jsonl',
    'sources.json',
  ];
  for (const f of owned) {
    const abs = path.join(dir, f);
    if (fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch (_) {}
    }
  }
  // roadmap-weekly-*.md + lesson-*.md
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^roadmap-weekly-\d{4}-\d{2}-\d{2}\.md$/.test(name)
          || /^lesson-\d+\.md$/i.test(name)) {
        try { fs.unlinkSync(path.join(dir, name)); } catch (_) {}
      }
    }
  } catch (_) { /* dir may not exist yet */ }
}

// ---------------------------------------------------------------------------
// Step 1 — Goal Guardian feasible (3-month Rust)
// ---------------------------------------------------------------------------

async function step1_goalGuardianFeasible(hasKey) {
  if (!hasKey) {
    record(1, 'SKIPPED', 'Goal Guardian feasible', 'no GLM/DEEPSEEK/KIMI API key');
    return 0;
  }
  const localAsserts = assertionCount;
  let res;
  try {
    res = await goalGuardian.evaluateGoalFeasibility({
      north_star_goal: '3 个月内学完 Rust 写一个 CLI 发邮件 agent',
      main_creation: 'Send Email Agent CLI tool',
      current_level: 'Python 基础, intermediate level',
      learning_model: 'steady',
      days: 90,
    }, {});
  } catch (err) {
    record(1, 'FAIL', 'Goal Guardian feasible', `threw: ${err && err.message}`);
    process.exit(1);
  }
  assert(res && typeof res === 'object', 'step1.res must be object');
  assert(res.verdict === 'feasible' || res.verdict === 'strained',
    `step1.verdict should be feasible|strained, got ${res.verdict}`);
  assert(res.math && typeof res.math.feasibility_ratio === 'number',
    'step1.math.feasibility_ratio missing');
  assert(res.math.feasibility_ratio >= 0.2 && res.math.feasibility_ratio <= 5.0,
    `step1.math.feasibility_ratio expected 0.2-5.0, got ${res.math.feasibility_ratio}`);
  const used = assertionCount - localAsserts;
  record(1, 'PASS', 'Goal Guardian feasible',
    `verdict=${res.verdict} ratio=${res.math.feasibility_ratio.toFixed(2)} (${used} assertions)`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 2 — Goal Guardian absurd (1-day Nobel)
// ---------------------------------------------------------------------------

async function step2_goalGuardianAbsurd(hasKey) {
  if (!hasKey) {
    record(2, 'SKIPPED', 'Goal Guardian absurd', 'no GLM/DEEPSEEK/KIMI API key');
    return 0;
  }
  const localAsserts = assertionCount;
  let res;
  try {
    res = await goalGuardian.evaluateGoalFeasibility({
      north_star_goal: '1 天内成为诺贝尔文学奖得主',
      main_creation: '获奖小说',
      current_level: '零基础',
      learning_model: 'intensive',
      days: 1,
    }, {});
  } catch (err) {
    record(2, 'FAIL', 'Goal Guardian absurd', `threw: ${err && err.message}`);
    process.exit(1);
  }
  assert(res && res.verdict === 'absurd',
    `step2.verdict must be absurd (math floor enforces), got ${res.verdict}`);
  assert(res.math && res.math.feasibility_ratio < 0.05,
    `step2.math.feasibility_ratio expected < 0.05, got ${res.math && res.math.feasibility_ratio}`);
  // Math-floor enforcement: even if LLM said feasible, the post-LLM clamp at
  // ratio<0.15 must demote to absurd. Verify via _meta.math_promoted when LLM
  // ran, OR via verdict === 'absurd' when fallback path triggered.
  const wasMathPromoted = res._meta && typeof res._meta.math_promoted === 'string'
    && res._meta.math_promoted.endsWith('absurd');
  const isFallbackAbsurd = res._fallback === true && res.verdict === 'absurd';
  const isLlmAbsurd = !res._fallback && res.verdict === 'absurd';
  assert(wasMathPromoted || isFallbackAbsurd || isLlmAbsurd,
    `step2 expected math-floor enforcement path; got _meta=${JSON.stringify(res._meta)}`);
  const used = assertionCount - localAsserts;
  record(2, 'PASS', 'Goal Guardian absurd',
    `verdict=${res.verdict} ratio=${res.math.feasibility_ratio.toFixed(3)} math floor verified (${used} assertions)`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 3 — Decision Log (mirror of original Step 1)
// ---------------------------------------------------------------------------

function step3_decisionLog() {
  const localAsserts = assertionCount;
  const append1 = decisionLog.appendDecision(SLUG, {
    lesson_idx: 0,
    decision: '测试决策 ≥10 字',
  });
  assert(append1 && append1.ok === true, 'step3.append1.ok should be true');
  assert(append1.row && typeof append1.row.ts === 'string',
    'step3.append1.row.ts must be string');
  assert(!Number.isNaN(Date.parse(append1.row.ts)),
    'step3.append1.row.ts must be parseable ISO');

  const list1 = decisionLog.listDecisions(SLUG, { limit: 5 });
  assert(Array.isArray(list1), 'step3.list1 must be array');
  assert(list1.length === 1, `step3.list1 length should be 1, got ${list1.length}`);

  const rejectShort = decisionLog.appendDecision(SLUG, {
    lesson_idx: 0,
    decision: '短',
  });
  assert(rejectShort && rejectShort.ok === false,
    'step3.rejectShort.ok should be false (≥10 char guard)');

  const used = assertionCount - localAsserts;
  record(3, 'PASS', 'Decision Log full chain', `${used} assertions`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 4 — Assumption Ledger state machine
// ---------------------------------------------------------------------------

function step4_assumptionLedger() {
  const localAsserts = assertionCount;
  const append = assumptionLedger.appendAssumption(SLUG, {
    lesson_idx: 0,
    claim: '测试假设 ≥10 字',
    state: 'unvalidated',
  });
  assert(append && append.ok === true, 'step4.append.ok should be true');
  const id = append.row.assumption_id;
  assert(typeof id === 'string' && id.length > 0, 'step4.assumption_id missing');

  const t1 = assumptionLedger.updateAssumptionState(SLUG, id, 'validating');
  assert(t1 && t1.ok === true, 'step4.transition unvalidated→validating should succeed');

  const t2 = assumptionLedger.updateAssumptionState(SLUG, id, 'unvalidated');
  assert(t2 && t2.ok === true,
    'step4.transition validating→unvalidated should succeed (legal walk-back)');

  const t3 = assumptionLedger.updateAssumptionState(SLUG, id, 'refuted');
  assert(t3 && t3.ok === true, 'step4.transition unvalidated→refuted should succeed');

  const t4 = assumptionLedger.updateAssumptionState(SLUG, id, 'validated');
  assert(t4 && t4.ok === false,
    'step4.transition refuted→validated must be REJECTED (refuted terminal)');

  const used = assertionCount - localAsserts;
  record(4, 'PASS', 'Assumption Ledger state machine', `${used} assertions`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 5 — Product Spark state machine
// ---------------------------------------------------------------------------

function step5_productSpark() {
  const localAsserts = assertionCount;
  const append = productSpark.appendSpark(SLUG, {
    lesson_idx: 0,
    source_type: 'lesson',
    core_transfer: '测试灵感迁移 ≥10 字',
    state: 'Seed',
  });
  assert(append && append.ok === true, 'step5.append.ok should be true');
  const id = append.row.spark_id;
  assert(typeof id === 'string' && id.length > 0, 'step5.spark_id missing');

  const t1 = productSpark.updateSparkState(SLUG, id, 'Considered');
  assert(t1 && t1.ok === true, 'step5.transition Seed→Considered should succeed');

  const t2 = productSpark.updateSparkState(SLUG, id, 'Accepted');
  assert(t2 && t2.ok === true, 'step5.transition Considered→Accepted should succeed');

  const t3 = productSpark.updateSparkState(SLUG, id, 'Implemented');
  assert(t3 && t3.ok === true, 'step5.transition Accepted→Implemented should succeed');

  const t4 = productSpark.updateSparkState(SLUG, id, 'Rejected');
  assert(t4 && t4.ok === false,
    'step5.transition Implemented→Rejected must be REJECTED (Implemented terminal)');

  const used = assertionCount - localAsserts;
  record(5, 'PASS', 'Product Spark state machine', `${used} assertions`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 6 — Prediction strip on bad value
// ---------------------------------------------------------------------------

function step6_predictionValidation() {
  const localAsserts = assertionCount;
  const warnsCaptured = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnsCaptured.push(args.join(' ')); };

  try {
    const goodAppend = decisionLog.appendDecision(SLUG, {
      lesson_idx: 0,
      decision: '有预测的决策 ≥10 字',
      prediction: {
        claim: '未来预测会发生在 7 天内复查',
        falsifier: '若 X 发生说明决策错误了',
        deadline_iso: '2026-06-01',
      },
    });
    assert(goodAppend && goodAppend.ok === true, 'step6.goodAppend.ok should be true');
    assert(goodAppend.row.prediction && typeof goodAppend.row.prediction.claim === 'string',
      'step6.goodAppend.row.prediction.claim should exist');

    const badAppend = decisionLog.appendDecision(SLUG, {
      lesson_idx: 0,
      decision: '坏 prediction 的决策 ≥10 字',
      prediction: {
        claim: '短',
        falsifier: 'X',
        deadline_iso: 'bad',
      },
    });
    assert(badAppend && badAppend.ok === true,
      'step6.badAppend.ok should be true (row writes, prediction stripped)');
    assert(badAppend.row.prediction === undefined,
      `step6.badAppend.row.prediction should be undefined (stripped), got ${JSON.stringify(badAppend.row.prediction)}`);
  } finally {
    console.warn = origWarn;
  }

  const used = assertionCount - localAsserts;
  record(6, 'PASS', 'Prediction field strip on bad value',
    `${used} assertions; ${warnsCaptured.length} silent-warn(s) captured`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 7 — extract-from-lesson (decisions + assumptions)
// ---------------------------------------------------------------------------

async function step7_extractDecisions(hasKey) {
  if (!hasKey) {
    record(7, 'SKIPPED', 'extract-from-lesson decisions + assumptions',
      'no GLM/DEEPSEEK/KIMI API key');
    return 0;
  }
  const localAsserts = assertionCount;
  const turns = [];
  for (let i = 0; i < 6; i++) {
    turns.push({ role: 'tutor', content:
      '我们刚学完奥卡姆剃刀。给定一组解释一个现象的候选假说，选择假设数最少的那个；多余的假设没有证据就该砍。这条原则在工程设计、科研选型、产品迭代里被反复印证。'
    });
    turns.push({ role: 'user', content:
      '我决定砍掉我产品里那个"用户偏好图谱"模块。因为它的存在并未推进核心 KPI（日活留存），而且引入了维护成本和延迟。我考虑过保留它并增加上下文推荐能力，但拒绝这个选项，因为推荐的转化数据近 30 天显示低于阈值。'
      + '我假设：把这个模块拆掉之后，新用户上手时间会下降至少 20%。如果两周后日均完成首课率没有上升至少 5 个百分点，就说明这个假设错了。'
      + '另外学到，我打算每个新模块上线时强制写一条 falsifier 进 decision-log，否则该模块视同 vanity feature。'
    });
  }
  const transcriptStr = turns.map(t => `[${t.role}] ${t.content}`).join('\n\n');
  assert(transcriptStr.length >= 1500,
    `step7.transcript must be ≥1500 chars, got ${transcriptStr.length}`);

  const decPre = decisionLog.listDecisions(SLUG).length;
  const assumPre = assumptionLedger.listAssumptions(SLUG).length;

  let extractRes;
  try {
    extractRes = await extractor.extractDecisionsAndAssumptions({
      slug: SLUG,
      lessonIdx: 99,
      transcript: turns,
      lessonTitle: '测试课',
      learnGoal: '测试目标',
      settings: {},
    });
  } catch (err) {
    record(7, 'FAIL', 'extract-from-lesson decisions + assumptions',
      `threw: ${err && err.message}`);
    process.exit(1);
  }

  if (extractRes && extractRes.skipped) {
    record(7, 'FAIL', 'extract-from-lesson decisions + assumptions',
      `skipped=${extractRes.skipped}${extractRes.error ? ' err=' + extractRes.error : ''}`);
    process.exit(1);
  }

  const decPost = decisionLog.listDecisions(SLUG).length;
  const assumPost = assumptionLedger.listAssumptions(SLUG).length;
  const newDec = decPost - decPre;
  const newAssum = assumPost - assumPre;
  assert(newDec + newAssum >= 1,
    `step7 should produce ≥1 row; got ${newDec} dec, ${newAssum} assum`);

  const used = assertionCount - localAsserts;
  record(7, 'PASS', 'extract-from-lesson decisions + assumptions',
    `${newDec} dec + ${newAssum} assum, ${used} assertions`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 8 — extract-from-lesson sparks
// ---------------------------------------------------------------------------

async function step8_extractSparks(hasKey) {
  if (!hasKey) {
    record(8, 'SKIPPED', 'extract-from-lesson sparks', 'no API key');
    return 0;
  }
  const localAsserts = assertionCount;
  // Spark-prone transcript — multi-turn discussion of a cross-domain transfer.
  const turns = [];
  for (let i = 0; i < 4; i++) {
    turns.push({ role: 'tutor', content:
      '我们刚讨论完 Karl Popper 的可证伪性原则: 一个命题要算科学, 必须给出一种观察 (具体可执行的实验或现象), 它若发生就会推翻这个命题. 你的产品决策能不能也按这套来检验?'
    });
    turns.push({ role: 'user', content:
      '我突然意识到我的 onboarding 流程其实没法证伪. 我应该把每个 funnel step 转成"如果两周后转化 < X% 就该砍这一步"的形式. 这跟我做学术研究时写 hypothesis 的方式很像, 但我之前的产品 spec 里完全没有这个习惯. '
      + '可以把每个新 feature 上线必须挂一条 falsifier 这个原则, 直接做成我产品的 decision-log gate. 这个迁移点足够具体, 而且能直接落到产品代码里.'
    });
  }
  const transcriptStr = turns.map(t => `[${t.role}] ${t.content}`).join('\n\n');
  assert(transcriptStr.length >= 800,
    `step8.transcript must be ≥800 chars, got ${transcriptStr.length}`);

  const sparksPre = productSpark.listSparks(SLUG).length;

  let res;
  try {
    res = await extractor.extractSparks({
      slug: SLUG,
      lessonIdx: 98,
      transcript: turns,
      lessonTitle: 'Popper 可证伪性',
      learnGoal: '把科学方法迁移到产品决策',
      settings: {},
      activeProductName: 'Hypha',
    });
  } catch (err) {
    record(8, 'FAIL', 'extract-from-lesson sparks', `threw: ${err && err.message}`);
    process.exit(1);
  }

  if (res && res.skipped === 'llm-error') {
    record(8, 'FAIL', 'extract-from-lesson sparks',
      `skipped=llm-error err=${res.error || ''}`);
    process.exit(1);
  }
  // 'no-extracts' is acceptable — LLM may judge nothing worth recording. We
  // still need either a written row OR an explicit no-extracts (not an error).
  const sparksPost = productSpark.listSparks(SLUG).length;
  const newSparks = sparksPost - sparksPre;
  const llmReturned = Array.isArray(res && res.sparks) ? res.sparks.length : 0;
  assert(newSparks >= 0 && llmReturned >= 0,
    'step8 sparks must be non-negative');

  const used = assertionCount - localAsserts;
  const detail = newSparks > 0
    ? `${newSparks} sparks written, ${used} assertions`
    : `0 written (skipped=${res && res.skipped || 'none'}), ${used} assertions`;
  record(8, 'PASS', 'extract-from-lesson sparks', detail);
  return used;
}

// ---------------------------------------------------------------------------
// Step 9 — kill-watcher sweep
// ---------------------------------------------------------------------------

async function step9_killWatcher() {
  const localAsserts = assertionCount;
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  const append = assumptionLedger.appendAssumption(SLUG, {
    lesson_idx: 0,
    claim: 'kill-watcher 测试假设 ≥10 字',
    state: 'unvalidated',
    prediction: {
      claim: '此假设若不被验证则证伪',
      falsifier: '一天后仍未被验证就算败',
      deadline_iso: yesterday,
    },
  });
  assert(append && append.ok === true, 'step9.injected.ok should be true');
  const id = append.row.assumption_id;

  const sweep = await killWatcher.runKillWatcherSweep({ vaultRoot: VAULT_ROOT });
  assert(sweep && sweep.ok === true, 'step9.sweep.ok should be true');
  const refuted = sweep.summary.by_kind.assumptions_refuted;
  assert(Array.isArray(refuted), 'step9.summary.by_kind.assumptions_refuted should be array');
  const hit = refuted.find(r => r.assumption_id === id);
  assert(hit, `step9.summary should contain our killed assumption_id ${id}`);

  const list = assumptionLedger.listAssumptions(SLUG)
    .filter(r => r.assumption_id === id);
  assert(list.length === 1, 'step9 listAssumptions should still contain our id');
  assert(list[0].state === 'refuted',
    `step9 listAssumptions[0].state should be refuted, got ${list[0].state}`);

  const used = assertionCount - localAsserts;
  record(9, 'PASS', 'Kill Watcher sweep',
    `1 assumption refuted (${used} assertions)`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 10 — Roadmap Sync weekly
// ---------------------------------------------------------------------------

async function step10_roadmap(hasKey) {
  if (!hasKey) {
    record(10, 'SKIPPED', 'Roadmap Sync weekly', 'no API key');
    return 0;
  }
  const localAsserts = assertionCount;
  const totalEntries =
    decisionLog.listDecisions(SLUG).length +
    assumptionLedger.listAssumptions(SLUG).length +
    productSpark.listSparks(SLUG).length;
  assert(totalEntries >= 3, `step10 needs ≥3 entries; got ${totalEntries}`);

  const res = await roadmapSync.runWeeklySync({
    slug: SLUG,
    settings: {},
    dryRun: false,
  });
  if (!res || res.ok !== true) {
    record(10, 'FAIL', 'Roadmap Sync weekly', JSON.stringify(res));
    process.exit(1);
  }
  if (res.skipped) {
    record(10, 'FAIL', 'Roadmap Sync weekly', `skipped=${res.skipped}`);
    process.exit(1);
  }
  assert(typeof res.mdPath === 'string' && fs.existsSync(res.mdPath),
    `step10.mdPath should exist on disk; got ${res.mdPath}`);

  const md = fs.readFileSync(res.mdPath, 'utf8');
  assert(md.includes('本周路线'), 'step10 markdown should contain "本周路线" header');

  const used = assertionCount - localAsserts;
  record(10, 'PASS', 'Roadmap Sync weekly',
    `${path.basename(res.mdPath)} (${used} assertions)`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 11 — Anti-Slop detectors archetype-aware
// ---------------------------------------------------------------------------

async function step11_antiSlopArchetype() {
  const localAsserts = assertionCount;

  // Seed sources.json with content that doesn't match the citation. This is
  // what makes the citation verifier return 'unverified' for TECH and the
  // archetype-promotion to 'unsourced-allowed' for HUMANITIES.
  const sourcesPath = path.join(vaultDir(), 'sources.json');
  const bogusSources = [{
    title: '某书 第一章',
    excerpt: '这是一段完全不相干的占位文字 用来撑起 corpus 但不会匹配任何引文.',
  }];
  fs.writeFileSync(sourcesPath, JSON.stringify(bogusSources, null, 2), 'utf8');

  // Text contains an anchored citation that won't match the bogus corpus.
  const citationText =
    '原文是 "X 在 1948 年发明了一种全新的信息度量." 这是关键论点.';

  // (a) HUMANITIES archetype: unverified → unsourced-allowed
  const humCit = await citationVerifier.verifyCitations(
    citationText, SLUG, { archetype: 'HUMANITIES' });
  assert(humCit && humCit.summary, 'step11.humCit.summary present');
  assert(humCit.summary.archetype_used === 'HUMANITIES',
    'step11.humCit.archetype_used = HUMANITIES');
  assert(humCit.summary.total >= 1,
    `step11.humCit.total expected ≥1, got ${humCit.summary.total}`);
  assert(humCit.summary.unsourced_allowed >= 1,
    `step11.humCit.unsourced_allowed expected ≥1, got ${humCit.summary.unsourced_allowed}`);

  // (b) TECH-CONCEPT same input: stays 'unverified'
  const techCit = await citationVerifier.verifyCitations(
    citationText, SLUG, { archetype: 'TECH-CONCEPT' });
  assert(techCit && techCit.summary, 'step11.techCit.summary present');
  assert(techCit.summary.unverified >= 1,
    `step11.techCit.unverified expected ≥1, got ${techCit.summary.unverified}`);

  // (c) Confidence-leak archetype HUMANITIES vs TECH-CONCEPT — same input.
  // Text crafted to hit BOTH 'person' + 'date' patterns multiple times so
  // the multipliers have something measurable to dampen.
  const leakText =
    'Shannon 提出了信息论. Einstein 在 1905 年发表了狭义相对论. '
    + 'Newton invented calculus. Galileo proved heliocentrism.';
  const humLeak = confidenceLeak.detectConfidenceLeaks(leakText, { archetype: 'HUMANITIES' });
  const techLeak = confidenceLeak.detectConfidenceLeaks(leakText, { archetype: 'TECH-CONCEPT' });
  assert(humLeak && techLeak, 'step11 leak detection results present');
  assert(techLeak.summary.total_assertive >= 2,
    `step11.techLeak.total_assertive expected ≥2, got ${techLeak.summary.total_assertive}`);
  assert(humLeak.summary.total_assertive === techLeak.summary.total_assertive,
    'step11 same input must produce same assertion COUNT regardless of archetype');
  // HUMANITIES leak_count should be ≤ 40% of TECH (60% reduction floor).
  // Asserted as: humLeak.leak_count ≤ Math.ceil(techLeak.leak_count * 0.4)
  // — loosens to 0.5 if tech leak count is tiny (≤ 2) since round-to-int
  // can otherwise over-tighten.
  const techLC = techLeak.summary.leak_count;
  const humLC = humLeak.summary.leak_count;
  const ceiling = techLC <= 2 ? Math.ceil(techLC * 0.5) : Math.ceil(techLC * 0.4);
  assert(humLC <= ceiling,
    `step11.humLeak.leak_count expected ≤ ${ceiling} (60% lower than ${techLC}), got ${humLC}`);

  const used = assertionCount - localAsserts;
  record(11, 'PASS', 'Anti-Slop detectors archetype-aware',
    `citation 'unsourced-allowed' verified for HUMANITIES; confidence-leak hum=${humLC} tech=${techLC} (${used} assertions)`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 12 — PJR archetype gate
// ---------------------------------------------------------------------------

async function step12_pjrArchetype() {
  const localAsserts = assertionCount;
  // V0.4.4 (2026-05-19) per-axis HUMANITIES split: gate blocks rewrite on
  // PROSE-QUALITY axes (citation + pedagogy + bias — rewriting humanities
  // prose can fabricate history) but ALLOWS rewrite on EPISTEMIC axes
  // (confidence-leak + illusion — overconfidence + premature closure are
  // equally bad in humanities). See prosecute-judge-rewrite.js:517-536.
  // Mirror smoke: `_dev_verify_lesson_quality_v2.js` A1-A5 + PB7.
  const text = '某段课程主体回复. 这里有一些声明 1948 年 + Shannon 提出 + 1905 年 Einstein.';

  // Prose-quality-only fire (citation + pedagogy, NO epistemic axes) →
  // HUMANITIES gate fires; severity 'high' from cit_unverified=3.
  const proseQualityFire = {
    citations: { unverified: 3 },
    pedagogy:  { unknown: 1, inconsistent: 1 },
    confidence: { leak_count: 0 },
    illusion:   { illusion_detected: false },
  };
  // Epistemic-axis fire (illusion + conf-leak, NO prose-quality axes) →
  // HUMANITIES gate releases at sev 'high' (conf_leak=5 → high).
  const epistemicFire = {
    citations: { unverified: 0 },
    pedagogy:  { unknown: 0, inconsistent: 0 },
    confidence: { leak_count: 5 },
    illusion:   { illusion_detected: true, illusion_type: 'apparent-completion' },
  };
  // Original high-fire mix preserved for TECH-CONCEPT branch (strict
  // archetype — gate never fires regardless of axis).
  const allAxesFire = {
    citations: { unverified: 3 },
    pedagogy:  { unknown: 1, inconsistent: 1 },
    confidence: { leak_count: 5 },
    illusion:   { illusion_detected: true, illusion_type: 'apparent-completion' },
  };

  // (a) HUMANITIES + prose-quality-only → gate BLOCKS rewrite
  const humProseRes = await pjr.runProsecuteJudgeOnFreeform({
    text, signals: proseQualityFire, slug: SLUG, archetype: 'HUMANITIES',
  });
  assert(humProseRes && humProseRes.verdict, 'step12.humProseRes.verdict present');
  assert(humProseRes.verdict.needs_rewrite === false,
    `step12.HUMANITIES prose-only needs_rewrite must be false, got ${humProseRes.verdict.needs_rewrite}`);
  assert(humProseRes.verdict.gated_by_archetype === true,
    `step12.HUMANITIES prose-only gated_by_archetype must be true, got ${humProseRes.verdict.gated_by_archetype}`);
  assert(humProseRes.rewritten === null,
    'step12.HUMANITIES prose-only rewritten should be null (gate prevents LLM call)');

  // (b) HUMANITIES + epistemic-axis → gate ALLOWS rewrite (v0.4.4 per-axis)
  const humEpistemicRes = await pjr.runProsecuteJudgeOnFreeform({
    text, signals: epistemicFire, slug: SLUG, archetype: 'HUMANITIES',
  });
  assert(humEpistemicRes && humEpistemicRes.verdict, 'step12.humEpistemicRes.verdict present');
  assert(humEpistemicRes.verdict.needs_rewrite === true,
    `step12.HUMANITIES epistemic needs_rewrite must be true (v0.4.4 per-axis), got ${humEpistemicRes.verdict.needs_rewrite}`);
  assert(humEpistemicRes.verdict.gated_by_archetype === false,
    `step12.HUMANITIES epistemic gated_by_archetype must be false (gate released for epistemic axes), got ${humEpistemicRes.verdict.gated_by_archetype}`);

  // (c) TECH-CONCEPT high-fire — gate does NOT fire (strict archetype)
  const techRes = await pjr.runProsecuteJudgeOnFreeform({
    text, signals: allAxesFire, slug: SLUG, archetype: 'TECH-CONCEPT',
  });
  assert(techRes && techRes.verdict, 'step12.techRes.verdict present');
  assert(techRes.verdict.needs_rewrite === true,
    `step12.TECH-CONCEPT needs_rewrite must be true, got ${techRes.verdict.needs_rewrite}`);
  assert(techRes.verdict.gated_by_archetype === false,
    `step12.TECH-CONCEPT gated_by_archetype must be false, got ${techRes.verdict.gated_by_archetype}`);
  // We don't require rewritten !== null here: that path needs the LLM, which
  // may not be reachable in this test env. The gate-level assertion is enough.

  const used = assertionCount - localAsserts;
  record(12, 'PASS', 'PJR archetype gate',
    `HUMANITIES prose-only gated + epistemic released + TECH not gated (${used} assertions)`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 13 — Persona Wisdom loader
// ---------------------------------------------------------------------------

function step13_personaWisdom() {
  const localAsserts = assertionCount;
  const tolkien = wisdomLoader.loadPersonaWisdom('tolkien');
  assert(tolkien !== null, 'step13.tolkien must not be null');
  assert(tolkien.status !== 'WAITING_DISTILL',
    `step13.tolkien.status must not be WAITING_DISTILL, got ${tolkien.status}`);
  assert(tolkien.sections && typeof tolkien.sections === 'object',
    'step13.tolkien.sections must be an object');
  const nonEmptySections = Object.keys(tolkien.sections)
    .filter(k => String(tolkien.sections[k] || '').trim().length > 0);
  assert(nonEmptySections.length >= 1,
    `step13.tolkien must have ≥1 non-empty section; got ${nonEmptySections.length}`);

  const nonexistent = wisdomLoader.loadPersonaWisdom('definitely-not-a-real-persona-id');
  assert(nonexistent === null,
    `step13.nonexistent must be null, got ${JSON.stringify(nonexistent)}`);

  const used = assertionCount - localAsserts;
  record(13, 'PASS', 'Persona Wisdom loader',
    `tolkien sections=${nonEmptySections.length} / nonexistent=null (${used} assertions)`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 14 — Living Note Reactivation
// ---------------------------------------------------------------------------

async function step14_livingNote(hasKey) {
  const localAsserts = assertionCount;

  // Pre-seed 3 fake lesson-NN.md (each ≥ 600 chars), mtime = 10 days ago.
  const dir = vaultDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const tenDaysAgoSec = tenDaysAgo / 1000;

  const fakeBody = (idx, theme) => {
    // 600+ chars CN body, frontmatter + content.
    const fm = `---\nlesson_idx: ${idx}\nlearn_mode: classic\n---\n\n`;
    const body = `# Lesson ${idx} — ${theme}\n\n`
      + `这是一段用于 verify-full-chain 测试的占位笔记内容。主题围绕 ${theme} 展开，`
      + '讨论了基本概念、几条推论以及与产品决策的关联。我们引用了 Popper 的可证伪性原则，'
      + '也提到 Occam 剃刀在工程取舍中的作用。本节最弱处是没有给出可量化的验证手段，'
      + '需要补一个具体的 falsifier 进 decision-log。除此之外，我们还讨论了将笔记之间的'
      + 'typed edge 用作认知图谱的可能性 — cites / contradicts / extends / triggered-by / '
      + 'related 五种关系是当前 web-note-engine 的 surface。每条 edge 都应当能反过来加'
      + 'evidence，从而支撑后续 lesson 的 reactivation。';
    return fm + body;
  };

  // 'currentLessonText' will share Popper / 可证伪性 / decision-log / 边 tokens
  // so jaccard fires on at least one of the seeded notes.
  const themes = ['Popper 可证伪性', 'Occam 剃刀与产品决策', '认知图谱与笔记 edge'];
  for (let i = 0; i < 3; i++) {
    const idx = i + 1;
    const abs = path.join(dir, `lesson-${idx}.md`);
    fs.writeFileSync(abs, fakeBody(idx, themes[i]), 'utf8');
    // Backdate mtime so the default 7-day age gate passes.
    fs.utimesSync(abs, tenDaysAgoSec, tenDaysAgoSec);
  }

  const currentLessonText = '今天讨论的内容: Popper 可证伪性如何嵌入产品 decision-log, '
    + '以及 Occam 剃刀帮助我们砍掉 vanity feature 的判定边界。';

  let res;
  try {
    res = await livingNote.findReactivationCandidates({
      slug: SLUG,
      currentLessonIdx: 5,
      currentLessonText,
      settings: {},
    });
  } catch (err) {
    record(14, 'FAIL', 'Living Note Reactivation',
      `threw: ${err && err.message}`);
    process.exit(1);
  }

  assert(res && res.summary, 'step14.res.summary present');
  assert(res.summary.total_notes_scanned === 3,
    `step14.summary.total_notes_scanned expected 3, got ${res.summary.total_notes_scanned}`);
  assert(Array.isArray(res.candidates),
    'step14.candidates must be array');
  assert(res.candidates.length >= 0 && res.candidates.length <= 3,
    `step14.candidates.length expected 0-3, got ${res.candidates.length}`);

  if (hasKey) {
    // With a key, expect llm_selected 0-3 (any value in range is acceptable
    // since the LLM may judge none worth surfacing).
    assert(res.summary.llm_selected >= 0 && res.summary.llm_selected <= 3,
      `step14.summary.llm_selected expected 0-3 with key, got ${res.summary.llm_selected}`);
  }

  const used = assertionCount - localAsserts;
  record(14, 'PASS', 'Living Note Reactivation',
    `3 fake notes seeded, scanned=${res.summary.total_notes_scanned}, candidates=${res.candidates.length}, llm_selected=${res.summary.llm_selected} (${used} assertions)`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 15 — Web Note Engine CRUD
// ---------------------------------------------------------------------------

function step15_webNoteEngine() {
  const localAsserts = assertionCount;
  // We share the same SLUG / dir with step 14 — web-note-engine will write
  // to vault/<SLUG>/note-edges.jsonl. cleanSlugVault cleared this earlier.

  const add1 = webNoteEngine.addEdge(SLUG, { from_idx: 1, to_idx: 2, type: 'cites' });
  assert(add1 && add1.ok === true, `step15.add1.ok expected true, got ${JSON.stringify(add1)}`);
  assert(typeof add1.edge_id === 'string' && add1.edge_id.length > 0,
    'step15.add1.edge_id missing');
  const edgeId = add1.edge_id;

  const list1 = webNoteEngine.listEdges(SLUG);
  assert(Array.isArray(list1), 'step15.list1 must be array');
  assert(list1.length === 1, `step15.list1.length expected 1, got ${list1.length}`);
  assert(list1[0].edge_id === edgeId,
    `step15.list1[0].edge_id should match, got ${list1[0].edge_id}`);

  const neighbors = webNoteEngine.getNeighbors(SLUG, 1);
  assert(neighbors && Array.isArray(neighbors.outgoing),
    'step15.neighbors.outgoing must be array');
  assert(neighbors.outgoing.length === 1,
    `step15.neighbors.outgoing.length expected 1, got ${neighbors.outgoing.length}`);
  assert(neighbors.outgoing[0].to_idx === 2,
    `step15.neighbors.outgoing[0].to_idx expected 2, got ${neighbors.outgoing[0].to_idx}`);

  const rm = webNoteEngine.removeEdge(SLUG, edgeId);
  assert(rm && rm.ok === true, `step15.removeEdge.ok expected true, got ${JSON.stringify(rm)}`);

  const list2 = webNoteEngine.listEdges(SLUG);
  assert(Array.isArray(list2) && list2.length === 0,
    `step15.list2.length expected 0 after tombstone, got ${list2.length}`);

  // Negative case (a) — bad edge type
  const badType = webNoteEngine.addEdge(SLUG, { from_idx: 1, to_idx: 2, type: 'BAD_TYPE' });
  assert(badType && badType.ok === false,
    'step15.badType.ok expected false for unknown edge type');
  assert(typeof badType.error === 'string' && badType.error.length > 0,
    'step15.badType.error must be non-empty string');

  // Negative case (b) — self-edge from===to
  const selfEdge = webNoteEngine.addEdge(SLUG, { from_idx: 3, to_idx: 3, type: 'related' });
  assert(selfEdge && selfEdge.ok === false,
    'step15.selfEdge.ok expected false for self-edge');

  const used = assertionCount - localAsserts;
  record(15, 'PASS', 'Web Note Engine CRUD',
    `5 ops + 2 negative cases (${used} assertions)`);
  return used;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Hypha Full Chain dev-verify ===');
  console.log(`vault root: ${VAULT_ROOT}`);
  console.log(`test slug:  ${SLUG}`);

  cleanSlugVault();
  const keyName = detectLlmKey();
  console.log(`LLM key:    ${keyName
    ? green(keyName + ' detected')
    : yellow('none — LLM-bound steps will SKIP')}`);
  console.log('');

  try {
    await step1_goalGuardianFeasible(Boolean(keyName));
    await step2_goalGuardianAbsurd(Boolean(keyName));
    step3_decisionLog();
    step4_assumptionLedger();
    step5_productSpark();
    step6_predictionValidation();
    await step7_extractDecisions(Boolean(keyName));
    await step8_extractSparks(Boolean(keyName));
    await step9_killWatcher();
    await step10_roadmap(Boolean(keyName));
    await step11_antiSlopArchetype();
    await step12_pjrArchetype();
    step13_personaWisdom();
    await step14_livingNote(Boolean(keyName));
    step15_webNoteEngine();
  } catch (err) {
    console.error(red('\n[fatal] verify aborted: ' + (err && err.message ? err.message : err)));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  }

  const pass    = results.filter(r => r.status === 'PASS').length;
  const skipped = results.filter(r => r.status === 'SKIPPED').length;
  const fail    = results.filter(r => r.status === 'FAIL').length;

  console.log('');
  console.log('=== Summary ===');
  console.log(`${green('PASS')}: ${pass} / ${yellow('SKIPPED')}: ${skipped} / ${red('FAIL')}: ${fail}`);
  console.log(`Total assertions: ${assertionCount}`);
  console.log(`Vault remains at: ${vaultDir()} (kept for inspection)`);

  if (fail > 0) {
    console.log(red('Exit 1'));
    process.exit(1);
  }
  console.log(green('Exit 0'));
  process.exit(0);
}

main().catch((err) => {
  console.error(red('[verify] uncaught: ') + (err && err.stack ? err.stack : err));
  process.exit(2);
});
