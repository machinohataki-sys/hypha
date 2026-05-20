'use strict';

// RUN_SEQUENTIAL — LLM-bound, parallel pool causes rate-limit / timeout

// HYPHA · Creation System — end-to-end dev-verify (MEOW R1 follow-up).
//
// Created 2026-05-14. Companion to _dev_verify_cost_ledger.js: the cost-ledger
// gate proves V0.5 E1 patch landed; this script proves the §11.4-§11.8
// Creation System modules (decision-log / assumption-ledger / product-spark /
// extract-from-lesson / kill-watcher / roadmap-sync) actually compose into a
// working chain. MEOW R1 flagged "no real E2E verification" — this fills it.
//
// What this script does (8 steps):
//   1. decision-log direct API (append + list + ≥10 chars guard)
//   2. assumption-ledger state machine (unvalidated → validating → ... → refuted)
//   3. product-spark state machine (Seed → Considered → Accepted → Implemented)
//   4. prediction validation (good prediction kept; bad prediction silently stripped)
//   5. extract-from-lesson LLM call against a 1500+ char fake transcript
//   6. kill-watcher: write expired assumption, sweep, verify auto-refuted
//   7. roadmap-sync: requires ≥3 entries + LLM, render weekly markdown
//   8. final vault layout summary
//
// Steps 5 + 7 require an LLM key (GLM/DEEPSEEK/KIMI). Without one they are
// SKIPPED (yellow) — NOT FAIL. Network errors during LLM call -> FAIL.
//
// Standalone Node — does NOT require Electron. Uses vault.resolveRoot() which
// resolves to <repo>/data by default (or HYPHA_DATA env override). Test slug
// is "__verify_creation_system__"; the script cleans jsonl + roadmap-md from
// prior runs, but leaves the dir afterwards for inspection.
//
// Exit code: 0 on PASS (skipped allowed), 1 on any FAIL, 2 on uncaught throw.

const fs = require('node:fs');
const path = require('node:path');

const SLUG = '__verify_creation_system__';

// ---------------------------------------------------------------------------
// Module imports — all standalone, no Electron.
// ---------------------------------------------------------------------------

const vault = require('../lib/vault');
const decisionLog = require('../lib/creation/decision-log');
const assumptionLedger = require('../lib/creation/assumption-ledger');
const productSpark = require('../lib/creation/product-spark');
const extractor = require('../lib/creation/extract-from-lesson');
const killWatcher = require('../lib/creation/kill-watcher');
const roadmapSync = require('../lib/creation/roadmap-sync');

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

const results = []; // { step, status: 'PASS'|'FAIL'|'SKIPPED', label, detail }
let assertionCount = 0;

function record(step, status, label, detail = '') {
  results.push({ step, status, label, detail });
  const tag = status === 'PASS' ? green('PASS')
            : status === 'SKIPPED' ? yellow('SKIPPED')
            : red('FAIL');
  console.log(`[${step}/8] ${tag}  ${label}${detail ? ' — ' + detail : ''}`);
}

function assert(cond, msg) {
  assertionCount++;
  if (!cond) {
    console.error(red(`  assertion FAILED: ${msg}`));
    throw new Error(`assertion failed: ${msg}`);
  }
}

// Detect LLM key — same env vars the providers consume. Trim defends against
// PowerShell `>>` baking '\n' into the User env (per CLAUDE.md provider notes).
function detectLlmKey() {
  const keys = ['GLM_API_KEY', 'DEEPSEEK_API_KEY', 'KIMI_API_KEY'];
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === 'string' && v.trim().length > 10) return k;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Vault cleanup — idempotent re-runs.
// ---------------------------------------------------------------------------

function vaultDir() {
  return path.join(vault.resolveRoot(), SLUG);
}

function cleanSlugVault() {
  const dir = vaultDir();
  if (!fs.existsSync(dir)) return;
  // Only kill the jsonl + roadmap-md we own. Spare anything else in case a
  // human dropped scratch notes in here.
  const owned = [
    'decisions.jsonl',
    'assumptions.jsonl',
    'sparks.jsonl',
    'decision-reviews.jsonl',
  ];
  for (const f of owned) {
    const abs = path.join(dir, f);
    if (fs.existsSync(abs)) {
      try { fs.unlinkSync(abs); } catch (_) {}
    }
  }
  // roadmap-weekly-*.md
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^roadmap-weekly-\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
        try { fs.unlinkSync(path.join(dir, name)); } catch (_) {}
      }
    }
  } catch (_) { /* dir may not exist yet */ }
}

// ---------------------------------------------------------------------------
// Step 1 — decision-log direct API
// ---------------------------------------------------------------------------

function step1_decisionLog() {
  const localAsserts = assertionCount;
  const append1 = decisionLog.appendDecision(SLUG, {
    lesson_idx: 0,
    decision: '测试决策 ≥10 字',
  });
  assert(append1 && append1.ok === true, 'step1.append1.ok should be true');
  assert(append1.row && typeof append1.row.ts === 'string', 'step1.append1.row.ts must be string');
  assert(!Number.isNaN(Date.parse(append1.row.ts)), 'step1.append1.row.ts must be parseable ISO');

  const list1 = decisionLog.listDecisions(SLUG, { limit: 5 });
  assert(Array.isArray(list1), 'step1.list1 must be array');
  assert(list1.length === 1, `step1.list1 length should be 1, got ${list1.length}`);
  assert(list1[0].decision === '测试决策 ≥10 字',
    `step1.list1[0].decision mismatch: ${list1[0].decision}`);

  const rejectShort = decisionLog.appendDecision(SLUG, {
    lesson_idx: 0,
    decision: '短',
  });
  assert(rejectShort && rejectShort.ok === false,
    'step1.rejectShort.ok should be false (≥10 char guard)');

  const used = assertionCount - localAsserts;
  record(1, 'PASS', 'decision-log direct API', `${used} assertions`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 2 — assumption-ledger state machine
// ---------------------------------------------------------------------------

function step2_assumptionLedger() {
  const localAsserts = assertionCount;
  const append = assumptionLedger.appendAssumption(SLUG, {
    lesson_idx: 0,
    claim: '测试假设 ≥10 字',
    state: 'unvalidated',
  });
  assert(append && append.ok === true, 'step2.append.ok should be true');
  const id = append.row.assumption_id;
  assert(typeof id === 'string' && id.length > 0, 'step2.assumption_id missing');

  const list1 = assumptionLedger.listAssumptions(SLUG);
  // Note: ledger may already hold prior-step assumptions from THIS run; filter to ours.
  const mine1 = list1.filter(r => r.assumption_id === id);
  assert(mine1.length === 1, `step2.list1 should contain our id once, got ${mine1.length}`);
  assert(mine1[0].state === 'unvalidated',
    `step2.list1 state should be unvalidated, got ${mine1[0].state}`);

  const t1 = assumptionLedger.updateAssumptionState(SLUG, id, 'validating');
  assert(t1 && t1.ok === true, 'step2.transition unvalidated→validating should succeed');

  const list2 = assumptionLedger.listAssumptions(SLUG).filter(r => r.assumption_id === id);
  assert(list2[0].state === 'validating',
    `step2.list2 state should be validating, got ${list2[0].state}`);

  // validating → unvalidated is a legal walk-back per LEGAL_NEXT
  const t2 = assumptionLedger.updateAssumptionState(SLUG, id, 'unvalidated');
  assert(t2 && t2.ok === true,
    'step2.transition validating→unvalidated should succeed (legal walk-back)');

  // Step it forward to refuted (legal from unvalidated)
  const t3 = assumptionLedger.updateAssumptionState(SLUG, id, 'refuted');
  assert(t3 && t3.ok === true, 'step2.transition unvalidated→refuted should succeed');

  // refuted is terminal — any transition out must be rejected
  const t4 = assumptionLedger.updateAssumptionState(SLUG, id, 'validated');
  assert(t4 && t4.ok === false,
    'step2.transition refuted→validated must be REJECTED (refuted is terminal)');

  const used = assertionCount - localAsserts;
  record(2, 'PASS', 'assumption-ledger state machine', `${used} assertions`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 3 — product-spark state machine
// ---------------------------------------------------------------------------

function step3_productSpark() {
  const localAsserts = assertionCount;
  const append = productSpark.appendSpark(SLUG, {
    lesson_idx: 0,
    source_type: 'lesson',
    core_transfer: '测试灵感迁移 ≥10 字',
    state: 'Seed',
  });
  assert(append && append.ok === true, 'step3.append.ok should be true');
  const id = append.row.spark_id;
  assert(typeof id === 'string' && id.length > 0, 'step3.spark_id missing');

  const list1 = productSpark.listSparks(SLUG).filter(r => r.spark_id === id);
  assert(list1.length === 1, `step3.list1 should contain our id once, got ${list1.length}`);
  assert(list1[0].state === 'Seed',
    `step3.list1 state should be Seed, got ${list1[0].state}`);

  const t1 = productSpark.updateSparkState(SLUG, id, 'Considered');
  assert(t1 && t1.ok === true, 'step3.transition Seed→Considered should succeed');

  const t2 = productSpark.updateSparkState(SLUG, id, 'Accepted');
  assert(t2 && t2.ok === true, 'step3.transition Considered→Accepted should succeed');

  const t3 = productSpark.updateSparkState(SLUG, id, 'Implemented');
  assert(t3 && t3.ok === true, 'step3.transition Accepted→Implemented should succeed');

  const t4 = productSpark.updateSparkState(SLUG, id, 'Rejected');
  assert(t4 && t4.ok === false,
    'step3.transition Implemented→Rejected must be REJECTED (Implemented terminal)');

  const used = assertionCount - localAsserts;
  record(3, 'PASS', 'product-spark state machine', `${used} assertions`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 4 — prediction validation
// ---------------------------------------------------------------------------

function step4_predictionValidation() {
  const localAsserts = assertionCount;
  // Capture stderr console.warn — when prediction is dropped the lib emits one.
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
    assert(goodAppend && goodAppend.ok === true, 'step4.goodAppend.ok should be true');
    assert(goodAppend.row.prediction && typeof goodAppend.row.prediction.claim === 'string',
      'step4.goodAppend.row.prediction.claim should exist');

    const list = decisionLog.listDecisions(SLUG);
    const goodHit = list.find(r => r.decision === '有预测的决策 ≥10 字');
    assert(goodHit && goodHit.prediction && goodHit.prediction.claim,
      'step4.list should round-trip the good prediction');

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
      'step4.badAppend.ok should be true (row writes, prediction stripped)');
    assert(badAppend.row.prediction === undefined,
      `step4.badAppend.row.prediction should be undefined (stripped), got ${JSON.stringify(badAppend.row.prediction)}`);

    const list2 = decisionLog.listDecisions(SLUG);
    const badHit = list2.find(r => r.decision === '坏 prediction 的决策 ≥10 字');
    assert(badHit && badHit.prediction === undefined,
      'step4.list should show stripped prediction on round-trip');
  } finally {
    console.warn = origWarn;
  }

  const used = assertionCount - localAsserts;
  record(4, 'PASS', 'prediction validation',
    `${used} assertions; ${warnsCaptured.length} silent-warn(s) captured`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 5 — extract-from-lesson (requires LLM key, else SKIPPED)
// ---------------------------------------------------------------------------

async function step5_extract(hasKey) {
  if (!hasKey) {
    record(5, 'SKIPPED', 'extract-from-lesson LLM', 'no GLM/DEEPSEEK/KIMI API key in env');
    return 0;
  }
  const localAsserts = assertionCount;

  // Fake transcript with explicit learner voice that should trip the extractor.
  // 1500+ chars; threshold is 800.
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
  // Make sure we're well over MIN_TRANSCRIPT_CHARS (800).
  const transcriptStr = turns.map(t => `[${t.role}] ${t.content}`).join('\n\n');
  assert(transcriptStr.length >= 1500,
    `step5.transcript must be ≥1500 chars, got ${transcriptStr.length}`);

  // Pre-count rows so we can detect new writes after the extract call.
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
    console.error(red('  step5 threw: ' + (err && err.message)));
    record(5, 'FAIL', 'extract-from-lesson LLM', `threw: ${err && err.message}`);
    process.exit(1);
  }

  if (extractRes && extractRes.skipped) {
    // Skipped due to no-extracts or llm-error — treat llm-error as FAIL, no-extracts as FAIL too
    // (the transcript is engineered to contain clear decisions+assumptions; an empty extract
    // means the extractor pipeline is broken).
    console.error(red(`  step5 extractor returned skipped='${extractRes.skipped}'${extractRes.error ? ' err=' + extractRes.error : ''}`));
    record(5, 'FAIL', 'extract-from-lesson LLM',
      `skipped=${extractRes.skipped}${extractRes.error ? ' err=' + extractRes.error : ''}`);
    process.exit(1);
  }

  const decPost = decisionLog.listDecisions(SLUG).length;
  const assumPost = assumptionLedger.listAssumptions(SLUG).length;
  const newDec = decPost - decPre;
  const newAssum = assumPost - assumPre;

  assert(newDec + newAssum >= 1,
    `step5 should produce ≥1 decision or assumption; got ${newDec} dec, ${newAssum} assum`);

  const used = assertionCount - localAsserts;
  record(5, 'PASS', 'extract-from-lesson LLM',
    `${newDec} decision(s) + ${newAssum} assumption(s) written, ${used} assertions`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 6 — kill-watcher sweep
// ---------------------------------------------------------------------------

async function step6_killWatcher() {
  const localAsserts = assertionCount;

  // Inject a 1-day-expired assumption with prediction.deadline_iso in the past.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
  assert(append && append.ok === true, 'step6.injected.ok should be true');
  const id = append.row.assumption_id;
  assert(append.row.prediction && append.row.prediction.deadline_iso === yesterday,
    'step6.injected.prediction.deadline_iso should be yesterday');

  // Sweep
  const sweep = await killWatcher.runKillWatcherSweep({ vaultRoot: vault.resolveRoot() });
  assert(sweep && sweep.ok === true, 'step6.sweep.ok should be true');
  const refuted = sweep.summary.by_kind.assumptions_refuted;
  assert(Array.isArray(refuted), 'step6.summary.by_kind.assumptions_refuted should be array');
  const hit = refuted.find(r => r.assumption_id === id);
  assert(hit, `step6.summary should contain our killed assumption_id ${id}`);

  // State should now be refuted
  const list = assumptionLedger.listAssumptions(SLUG).filter(r => r.assumption_id === id);
  assert(list.length === 1, `step6 listAssumptions should still contain our id, got ${list.length}`);
  assert(list[0].state === 'refuted',
    `step6 listAssumptions[0].state should be refuted, got ${list[0].state}`);

  // _meta.auto_killed_at should be recorded — verify by reading the raw jsonl
  // (collapsed view in listAssumptions may or may not preserve _meta).
  const rawPath = path.join(vault.resolveRoot(), SLUG, 'assumptions.jsonl');
  const raw = fs.readFileSync(rawPath, 'utf8');
  const matchedRows = raw.split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(r => r && r.assumption_id === id);
  const refutedRow = matchedRows.find(r => r.state === 'refuted'
    && r._meta && typeof r._meta.auto_killed_at === 'string');
  assert(refutedRow,
    'step6 raw jsonl should contain a refuted row with _meta.auto_killed_at');

  const used = assertionCount - localAsserts;
  record(6, 'PASS', 'kill-watcher sweep',
    `1 assumption refuted, _meta.auto_killed_at present (${used} assertions)`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 7 — roadmap-sync (requires LLM key + ≥3 entries)
// ---------------------------------------------------------------------------

async function step7_roadmap(hasKey) {
  if (!hasKey) {
    record(7, 'SKIPPED', 'roadmap-sync',
      'no LLM key (skipped together with step 5)');
    return 0;
  }
  const localAsserts = assertionCount;

  // We already have ≥3 entries by now (Step 1-6 wrote several). Sanity-check.
  const totalEntries =
    decisionLog.listDecisions(SLUG).length +
    assumptionLedger.listAssumptions(SLUG).length +
    productSpark.listSparks(SLUG).length;
  assert(totalEntries >= 3,
    `step7 needs ≥3 entries; got ${totalEntries}`);

  const res = await roadmapSync.runWeeklySync({
    slug: SLUG,
    settings: {},
    dryRun: false,
  });
  if (!res || res.ok !== true) {
    console.error(red('  step7 runWeeklySync FAIL: ' + JSON.stringify(res)));
    record(7, 'FAIL', 'roadmap-sync', JSON.stringify(res));
    process.exit(1);
  }
  assert(res.ok === true, 'step7.res.ok should be true');
  if (res.skipped) {
    // Should NOT skip — we engineered totalEntries ≥ 3
    console.error(red(`  step7 unexpectedly skipped: ${res.skipped}`));
    record(7, 'FAIL', 'roadmap-sync', `skipped=${res.skipped}`);
    process.exit(1);
  }
  assert(typeof res.mdPath === 'string' && fs.existsSync(res.mdPath),
    `step7.mdPath should exist on disk; got ${res.mdPath}`);

  const md = fs.readFileSync(res.mdPath, 'utf8');
  assert(md.includes('本周路线'), 'step7 markdown should contain "本周路线" header');
  assert(md.includes('本周优先'), 'step7 markdown should contain "本周优先" section');

  const used = assertionCount - localAsserts;
  const relPath = path.relative(process.cwd(), res.mdPath);
  record(7, 'PASS', 'roadmap-sync', `mdPath=${relPath}, ${used} assertions`);
  return used;
}

// ---------------------------------------------------------------------------
// Step 8 — vault layout final summary
// ---------------------------------------------------------------------------

function step8_layout() {
  const localAsserts = assertionCount;
  const dir = vaultDir();
  assert(fs.existsSync(dir), `step8 vault dir should exist: ${dir}`);
  const files = fs.readdirSync(dir);
  assert(files.length > 0, 'step8 vault dir should have at least one file');

  // Count rows in each jsonl we recognise.
  function countRows(name) {
    const abs = path.join(dir, name);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs, 'utf8').split('\n').filter(Boolean).length;
  }
  const counts = {
    'decisions.jsonl':         countRows('decisions.jsonl'),
    'assumptions.jsonl':       countRows('assumptions.jsonl'),
    'sparks.jsonl':            countRows('sparks.jsonl'),
    'decision-reviews.jsonl':  countRows('decision-reviews.jsonl'),
  };
  const detail = Object.entries(counts)
    .filter(([_, v]) => v !== null)
    .map(([k, v]) => `${k} ${v} row(s)`)
    .join(', ');

  const used = assertionCount - localAsserts;
  record(8, 'PASS', 'vault layout',
    `${files.length} files: ${detail || '(only md/scratch)'} (${used} assertions)`);
  return used;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Hypha Creation System dev-verify ===');
  console.log(`vault root: ${vault.resolveRoot()}`);
  console.log(`test slug:  ${SLUG}`);

  cleanSlugVault();
  const keyName = detectLlmKey();
  console.log(`LLM key:    ${keyName ? green(keyName + ' detected') : yellow('none — steps 5+7 will SKIP')}`);
  console.log('');

  try {
    step1_decisionLog();
    step2_assumptionLedger();
    step3_productSpark();
    step4_predictionValidation();
    await step5_extract(Boolean(keyName));
    await step6_killWatcher();
    await step7_roadmap(Boolean(keyName));
    step8_layout();
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
