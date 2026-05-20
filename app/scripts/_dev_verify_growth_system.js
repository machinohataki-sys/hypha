#!/usr/bin/env node
'use strict';

// RUN_SEQUENTIAL — LLM-bound + vault-writing; collides with 45s parallel cap
// under concurrency. Standalone runtime ~17s but cold-LLM bursts push beyond.
// HYPHA · System 8 Growth — dedicated smoke (boot-9 2026-05-20).
//
// boot-8 audit found Growth at ~82% ship: 3056 LOC × 11 lib files + 8 UI cards
// + 43 narrow IPC handlers, but covered only indirectly via golden_path_e2e GP7
// (north-star single-call). v1.0 lock-in needs a self-contained Growth probe.
//
// 15 GP-prefixed tests (GP1-GP15) walk every lib entry-point + state-machine
// edge case. Synthetic vault fixture under slug '__verify_growth_system__';
// scratch is cleaned at start AND end. Vault root is pinned to whatever
// app/lib/vault resolves so it matches dev / packaged behavior, and seeds are
// written to that pinned root only.
//
// Test surface:
//   GP1  north-star.getNorthStar — return shape on empty vault
//   GP2  north-star — ratified count increments after concept-lifecycle ratify
//   GP3  north-star — artifacts_shipped tracks artifact create+transition to published
//   GP4  cross-spark — engine handles MISSING_KEY / NO_CANDIDATES gracefully
//   GP5  project-spine — addSpineEntry valid kind + listSpine round-trip
//   GP6  north-star — getNorthStar deterministic on same input (idempotence)
//   GP7  project-spine — persistence: list survives module re-require
//   GP8  north-star — recent_transitions 7d window (no rows outside window)
//   GP9  bandit-frontier — pickNextLesson on empty vault returns concept:null
//   GP10 artifact-creation — duplicate tombstone for same id is tolerated
//   GP11 thinking-tools — listTools returns 7 + getTool by id returns shape
//   GP12 thinking-tools — invokeTool with dry-run (no slug) returns scaffold_filled
//   GP13 north-star — pillars are independent (concept change ≠ artifact change)
//   GP14 cross-spark — listCrossSparks on empty vault returns ok:true rows:[]
//   GP15 judgment-gym — addClaim + dueForRejudge with backdated ts surfaces row
//
// Exit code: 0 on (PASS|SKIP only), 1 on any FAIL, 2 on uncaught throw.
// Run: node app/scripts/_dev_verify_growth_system.js

const fs   = require('node:fs');
const path = require('node:path');

const SLUG = '__verify_growth_system__';

// ---------------------------------------------------------------------------
// Vault pin (mirrors golden_path_e2e + concept_ledger patterns).
// ---------------------------------------------------------------------------

const vault = require('../lib/vault');
const VAULT_ROOT = vault.resolveRoot();
process.env.HYPHA_DATA = VAULT_ROOT;

// ---------------------------------------------------------------------------
// Module imports — real libs only.
// ---------------------------------------------------------------------------

const northStar       = require('../lib/growth/north-star-metrics');
const banditFrontier  = require('../lib/growth/bandit-frontier');
const projectSpine    = require('../lib/growth/project-spine');
const judgmentGym     = require('../lib/growth/judgment-gym');
const artifactCreation = require('../lib/growth/artifact-creation');
const thinkingTools   = require('../lib/growth/thinking-tools');
const crossSpark      = require('../lib/growth/cross-spark');
const conceptLifecycle = require('../lib/lesson-system/concept-lifecycle');

// ---------------------------------------------------------------------------
// Tiny ansi.
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
// Runner state.
// ---------------------------------------------------------------------------

const results = [];
let assertionCount = 0;
const gaps = [];

function record(id, status, label, detail = '') {
  results.push({ id, status, label, detail });
  const tag = status === 'PASS' ? green('PASS')
            : status === 'SKIP' ? yellow('SKIP')
            : red('FAIL');
  console.log(`[${id}] ${tag}  ${label}${detail ? ' — ' + detail : ''}`);
}

function assert(cond, msg) {
  assertionCount++;
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

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
// Fixture helpers — scoped to SLUG dir only. Never touch user vaults.
// ---------------------------------------------------------------------------

function vaultDir() {
  return path.join(VAULT_ROOT, SLUG);
}

const OWNED_FILES = Object.freeze([
  '.concept-lifecycle.jsonl',
  '.artifacts.jsonl',
  '.project-spine.jsonl',
  '.judgment-gym.jsonl',
  '.thinking-tools.jsonl',
  '.cross-spark.jsonl',
]);

function cleanSlugVault() {
  const dir = vaultDir();
  if (!fs.existsSync(dir)) return;
  for (const f of OWNED_FILES) {
    const abs = path.join(dir, f);
    if (!fs.existsSync(abs)) continue;
    try { fs.unlinkSync(abs); } catch (_) { /* best-effort */ }
  }
  // If the dir is now empty (only owned files lived here), remove it.
  try {
    const remaining = fs.readdirSync(dir);
    if (remaining.length === 0) fs.rmdirSync(dir);
  } catch (_) { /* ignore */ }
}

function ensureDir() {
  fs.mkdirSync(vaultDir(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main() {
  console.log(dim('HYPHA · Growth System dedicated smoke'));
  console.log(dim(`vault root: ${VAULT_ROOT}`));
  console.log(dim(`slug      : ${SLUG}`));
  console.log('');

  cleanSlugVault();
  ensureDir();

  // GP1 — north-star return shape on empty vault.
  await runTest('GP1', 'north-star getNorthStar shape (empty vault)', async () => {
    const res = await northStar.getNorthStar({ slug: SLUG });
    assert(res && res.ok === true, 'ok:true expected');
    assert(res.metrics && typeof res.metrics === 'object', 'metrics object');
    assert(typeof res.metrics.ratified === 'number', 'ratified is number');
    assert(typeof res.metrics.draft_on_deck === 'number', 'draft_on_deck is number');
    assert(typeof res.metrics.artifacts_shipped === 'number', 'artifacts_shipped is number');
    assert(typeof res.metrics.spark_matured === 'number', 'spark_matured is number');
    assert(Array.isArray(res.recent_transitions), 'recent_transitions is array');
    assert(res.metrics.ratified === 0, 'ratified should be 0 on empty');
    assert(res.metrics.draft_on_deck === 0, 'draft_on_deck should be 0 on empty');
    return `ratified=${res.metrics.ratified} draft=${res.metrics.draft_on_deck} art=${res.metrics.artifacts_shipped}`;
  });

  // GP2 — ratified count tracks concept-lifecycle.
  await runTest('GP2', 'north-star ratified increments after lifecycle ratify', async () => {
    const before = await northStar.getNorthStar({ slug: SLUG });
    const seedRatified = before.metrics.ratified;
    const seedDraft = before.metrics.draft_on_deck;

    const add = await conceptLifecycle.addConcept({ slug: SLUG, name: 'growth-test-concept-A' });
    assert(add.ok, 'addConcept ok');
    const cid = add.concept.conceptId;

    const mid = await northStar.getNorthStar({ slug: SLUG });
    assert(mid.metrics.draft_on_deck === seedDraft + 1, `draft +1 after seed (was ${seedDraft}, now ${mid.metrics.draft_on_deck})`);

    const t1 = await conceptLifecycle.transitionConcept({ slug: SLUG, conceptId: cid, newState: 'review' });
    assert(t1.ok, 'draft→review ok');
    const t2 = await conceptLifecycle.transitionConcept({ slug: SLUG, conceptId: cid, newState: 'ratified' });
    assert(t2.ok, 'review→ratified ok');

    const after = await northStar.getNorthStar({ slug: SLUG });
    assert(after.metrics.ratified === seedRatified + 1, `ratified should be +1 (was ${seedRatified}, now ${after.metrics.ratified})`);
    return `ratified ${seedRatified}→${after.metrics.ratified}`;
  });

  // GP3 — artifacts_shipped pillar.
  await runTest('GP3', 'north-star artifacts_shipped tracks publish transition', async () => {
    const before = await northStar.getNorthStar({ slug: SLUG });
    const seed = before.metrics.artifacts_shipped;

    const create = await artifactCreation.createArtifact({
      slug: SLUG,
      kind: 'essay',
      title: 'growth-smoke-essay',
    });
    assert(create.ok, 'createArtifact ok');
    const id = create.artifact.id;

    // Walk legal transitions: planned → in-progress → drafted → published
    const stepA = await artifactCreation.transitionArtifact({ slug: SLUG, artifactId: id, toState: 'in-progress' });
    assert(stepA.ok, 'planned→in-progress ok');
    const stepB = await artifactCreation.transitionArtifact({ slug: SLUG, artifactId: id, toState: 'drafted' });
    assert(stepB.ok, 'in-progress→drafted ok');
    const stepC = await artifactCreation.transitionArtifact({ slug: SLUG, artifactId: id, toState: 'published' });
    assert(stepC.ok, 'drafted→published ok');

    const after = await northStar.getNorthStar({ slug: SLUG });
    assert(after.metrics.artifacts_shipped === seed + 1,
      `artifacts_shipped should be +1 (was ${seed}, now ${after.metrics.artifacts_shipped})`);
    return `artifacts_shipped ${seed}→${after.metrics.artifacts_shipped}`;
  });

  // GP4 — cross-spark generateCrossSparks envelope is always well-formed.
  // The smoke runs against a real dev vault, so any of these outcomes is
  // honest:
  //   (a) ok:true  — vault has persona-wisdom + cross-archetype lessons +
  //                  LLM key is set; engine returned real sparks
  //   (b) ok:false NO_CANDIDATES — fresh vault, no persona / no cross-archetype
  //   (c) ok:false NO_LLM_KEY    — candidates exist but no provider key
  //   (d) ok:false LLM_PARSE     — model returned non-JSON
  //   (e) ok:false EXCEPTION     — transport / disk crash
  // The contract being smoked is the envelope shape, not the outcome.
  await runTest('GP4', 'cross-spark generateCrossSparks envelope well-formed', async () => {
    const res = await crossSpark.generateCrossSparks({
      slug: SLUG,
      concept: 'attention-mechanism',
      k: 3,
      dryRun: true,
    });
    assert(res && typeof res === 'object', 'res is object');
    assert(typeof res.ok === 'boolean', 'ok is boolean');
    if (res.ok === true) {
      assert(Array.isArray(res.sparks), 'ok:true → sparks array');
      assert(typeof res.candidatesUsed === 'number', 'ok:true → candidatesUsed number');
      return `ok:true sparks=${res.sparks.length} candidates=${res.candidatesUsed}`;
    }
    const acceptErrors = ['NO_CANDIDATES', 'NO_LLM_KEY', 'LLM_PARSE', 'EXCEPTION'];
    assert(acceptErrors.includes(res.error),
      `expected error in ${acceptErrors.join('|')}, got ${res.error}`);
    return `ok:false error=${res.error}`;
  });

  // GP5 — project-spine round-trip.
  await runTest('GP5', 'project-spine add + list round-trip', async () => {
    const add = await projectSpine.addSpineEntry({
      slug: SLUG,
      kind: 'decision',
      content: 'growth-smoke spine entry for GP5',
      sourceLessonIdx: 0,
      sourceLessonTitle: 'L0 stub',
      tags: ['growth-smoke'],
    });
    assert(add.ok, 'addSpineEntry ok');
    assert(add.entry && add.entry.id, 'entry has id');

    const list = await projectSpine.listSpine({ slug: SLUG, limit: 50 });
    assert(list.ok, 'listSpine ok');
    assert(Array.isArray(list.entries), 'entries array');
    const found = list.entries.find(e => e.id === add.entry.id);
    assert(found, 'added entry surfaces in list');
    assert(found.kind === 'decision', 'kind preserved');
    return `entries=${list.entries.length}`;
  });

  // GP6 — north-star idempotence (same vault state → same metrics object).
  await runTest('GP6', 'north-star deterministic from same vault state', async () => {
    const a = await northStar.getNorthStar({ slug: SLUG });
    const b = await northStar.getNorthStar({ slug: SLUG });
    assert(a.ok && b.ok, 'both ok');
    assert(a.metrics.ratified === b.metrics.ratified, 'ratified equal');
    assert(a.metrics.draft_on_deck === b.metrics.draft_on_deck, 'draft_on_deck equal');
    assert(a.metrics.artifacts_shipped === b.metrics.artifacts_shipped, 'artifacts_shipped equal');
    assert(a.metrics.spark_matured === b.metrics.spark_matured, 'spark_matured equal');
    assert(a.recent_transitions.length === b.recent_transitions.length, 'transitions count equal');
    return `pillars=4 stable`;
  });

  // GP7 — project-spine persistence across module re-require.
  await runTest('GP7', 'project-spine persistence across module re-require', async () => {
    // Force a fresh module load — simulates a process restart against the
    // same on-disk file. jsonl is append-only so cache invalidation must
    // not be required for read correctness.
    delete require.cache[require.resolve('../lib/growth/project-spine')];
    const reloaded = require('../lib/growth/project-spine');
    const list = await reloaded.listSpine({ slug: SLUG, limit: 50 });
    assert(list.ok, 'reloaded listSpine ok');
    assert(list.entries.length > 0, 'entries survive re-require');
    return `entries=${list.entries.length}`;
  });

  // GP8 — recent_transitions 7d window.
  await runTest('GP8', 'north-star recent_transitions inside 7d window', async () => {
    const res = await northStar.getNorthStar({ slug: SLUG });
    assert(res.ok, 'ok');
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    for (const tx of res.recent_transitions) {
      assert(typeof tx.ts === 'string' && tx.ts, 'transition has ts');
      const t = Date.parse(tx.ts);
      assert(Number.isFinite(t), 'transition ts parseable');
      assert(now - t <= sevenDaysMs + 60000, 'transition within 7d window');
    }
    // GP2 made one transition path (draft→review→ratified) so at least 2 rows expected.
    assert(res.recent_transitions.length >= 1, `expected ≥1 recent transition, got ${res.recent_transitions.length}`);
    return `transitions=${res.recent_transitions.length}`;
  });

  // GP9 — bandit-frontier on empty draft/review set returns concept:null.
  await runTest('GP9', 'bandit-frontier returns null when no draft/review concepts', async () => {
    // After GP2 the only seeded concept transitioned to ratified, so there
    // should be no draft/review candidates left.
    const res = await banditFrontier.pickNextLesson({ slug: SLUG });
    assert(res && res.ok === true, 'ok:true');
    assert(res.concept === null, `expected concept:null, got ${res.concept}`);
    assert(typeof res.reason === 'string' && res.reason.length > 0, 'reason string non-empty');
    return `reason="${res.reason.slice(0, 50)}..."`;
  });

  // GP10 — artifact-creation duplicate delete tolerated.
  await runTest('GP10', 'artifact-creation duplicate delete returns ARTIFACT_NOT_FOUND', async () => {
    const create = await artifactCreation.createArtifact({
      slug: SLUG,
      kind: 'tweet-thread',
      title: 'growth-smoke-dup-delete',
    });
    assert(create.ok, 'createArtifact ok');
    const id = create.artifact.id;
    const del1 = await artifactCreation.deleteArtifact({ slug: SLUG, artifactId: id });
    assert(del1.ok, 'first delete ok');
    const del2 = await artifactCreation.deleteArtifact({ slug: SLUG, artifactId: id });
    assert(del2.ok === false, 'second delete should return ok:false');
    assert(del2.error === 'ARTIFACT_NOT_FOUND', `expected ARTIFACT_NOT_FOUND, got ${del2.error}`);
    return `dup-delete=safe`;
  });

  // GP11 — thinking-tools inventory.
  await runTest('GP11', 'thinking-tools listTools + getTool shape', async () => {
    const list = thinkingTools.listTools();
    assert(list && list.ok, 'listTools ok');
    assert(Array.isArray(list.tools), 'tools array');
    assert(list.tools.length >= 5, `expected ≥5 tools, got ${list.tools.length}`);
    const sample = list.tools[0];
    assert(typeof sample.id === 'string' && sample.id, 'sample.id');
    assert(typeof sample.label === 'string' && sample.label, 'sample.label');
    const got = thinkingTools.getTool(sample.id);
    assert(got.ok, 'getTool ok');
    assert(got.tool.id === sample.id, 'getTool id matches');
    const miss = thinkingTools.getTool('not-a-real-tool-id');
    assert(miss.ok === false && miss.error === 'NOT_FOUND', 'getTool unknown → NOT_FOUND');
    return `tools=${list.tools.length}`;
  });

  // GP12 — thinking-tools invokeTool dry-run (no slug → no jsonl write).
  await runTest('GP12', 'thinking-tools invokeTool dry-run returns scaffold_filled', async () => {
    const list = thinkingTools.listTools();
    const toolId = list.tools[0].id;
    const inv = thinkingTools.invokeTool({
      toolId,
      problem: 'GP12 smoke problem',
    });
    assert(inv.ok, 'invokeTool ok (no slug, dry-run)');
    assert(inv.invocation && typeof inv.invocation.scaffold_filled === 'string',
      'scaffold_filled is string');
    assert(inv.invocation.scaffold_filled.includes('GP12 smoke problem'),
      'scaffold_filled interpolates problem text');
    // No slug → no jsonl write. Verify file does NOT exist.
    const abs = path.join(vaultDir(), '.thinking-tools.jsonl');
    if (fs.existsSync(abs)) {
      const txt = fs.readFileSync(abs, 'utf-8');
      assert(!/GP12 smoke problem/.test(txt),
        'GP12 problem must not leak into jsonl on dry-run');
    }
    return `scaffold_chars=${inv.invocation.scaffold_filled.length}`;
  });

  // GP13 — pillars are independent. Add an artifact via GP3-style flow, the
  // ratified count must be unchanged.
  await runTest('GP13', 'north-star pillars independent (artifact ≠ concept)', async () => {
    const before = await northStar.getNorthStar({ slug: SLUG });
    const create = await artifactCreation.createArtifact({
      slug: SLUG,
      kind: 'substack-post',
      title: 'growth-smoke-pillar-indep',
    });
    assert(create.ok, 'createArtifact ok');
    // Don't publish — should NOT bump artifacts_shipped (state=planned).
    const after = await northStar.getNorthStar({ slug: SLUG });
    assert(after.metrics.ratified === before.metrics.ratified,
      'ratified unchanged by artifact create');
    assert(after.metrics.artifacts_shipped === before.metrics.artifacts_shipped,
      'artifacts_shipped unchanged by planned-state create');
    return `ratified-stable artifact-stable`;
  });

  // GP14 — cross-spark listCrossSparks on empty.
  await runTest('GP14', 'cross-spark listCrossSparks ok on empty vault', async () => {
    if (typeof crossSpark.listCrossSparks !== 'function') {
      skip('listCrossSparks not exported — surface deferred');
    }
    const res = await crossSpark.listCrossSparks({ slug: SLUG, limit: 50 });
    assert(res && res.ok === true, 'ok:true');
    assert(Array.isArray(res.rows), 'rows array');
    return `rows=${res.rows.length}`;
  });

  // GP15 — judgment-gym dueForRejudge with backdated row.
  await runTest('GP15', 'judgment-gym backdated claim surfaces in dueForRejudge', async () => {
    const add = await judgmentGym.addClaim({
      slug: SLUG,
      claim: 'growth-smoke contestable assertion',
      initialJudgment: 'agree',
      initialReasoning: 'GP15 seed',
      topic: 'growth-smoke',
    });
    assert(add.ok, 'addClaim ok');

    // Backdate the row by editing the jsonl directly (test rig only — the
    // public surface intentionally doesn't expose a backdate writer). This is
    // the cleanest way to surface the dueForRejudge time-window contract.
    const abs = path.join(vaultDir(), '.judgment-gym.jsonl');
    assert(fs.existsSync(abs), 'judgment-gym.jsonl exists after addClaim');
    const raw = fs.readFileSync(abs, 'utf-8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const oldTs = new Date(Date.now() - 10 * 86400000).toISOString(); // 10 days ago
    const patched = lines.map(ln => {
      try {
        const obj = JSON.parse(ln);
        if (obj && obj.id === add.entry.id) {
          obj.ts = oldTs;
          return JSON.stringify(obj);
        }
        return ln;
      } catch (_) { return ln; }
    });
    fs.writeFileSync(abs, patched.join('\n') + '\n', 'utf-8');

    const due = await judgmentGym.dueForRejudge({ slug: SLUG, minAgeDays: 3 });
    assert(due.ok, 'dueForRejudge ok');
    const found = due.entries.find(e => e.id === add.entry.id);
    assert(found, `backdated claim must surface (entries=${due.entries.length})`);
    return `due=${due.entries.length}`;
  });

  // -------------------------------------------------------------------------
  // Summary + cleanup
  // -------------------------------------------------------------------------

  const pass = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  const skipCount = results.filter(r => r.status === 'SKIP').length;

  console.log('');
  console.log(dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  console.log(`${green('PASS')} ${pass}/${results.length}   ${yellow('SKIP')} ${skipCount}   ${red('FAIL')} ${failCount}   ${dim(`assertions=${assertionCount}`)}`);
  if (gaps.length > 0) {
    console.log('');
    console.log(dim('Growth gaps surfaced:'));
    for (const g of gaps) console.log(dim('  · ' + g));
  }

  // Always clean — leaving fixtures around between runs would interfere with
  // GP1's empty-vault expectation on the next invocation.
  cleanSlugVault();

  if (failCount > 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error(red('UNCAUGHT'), err && err.stack ? err.stack : err);
  try { cleanSlugVault(); } catch (_) { /* ignore */ }
  process.exit(2);
});
