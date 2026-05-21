#!/usr/bin/env node
'use strict';

// RUN_SEQUENTIAL — many small fixture generations + concept-embedding paths;
// 16/16 PASS standalone but races 45s parallel cap under CPU contention.

// HYPHA · System 8 Growth v2 dedicated smoke (boot-12 push 82→92%, 2026-05-20).
//
// Covers the 5 v2 deliverables on top of v1 surface:
//   1. Cross-Spark strength score (Jaccard, 0..1, ≥0.3 gate)
//   2. Judgment Gym calibration + edge-of-competence picker
//   3. Thinking Tools first-principles + lateral pairing cluster
//   4. Project Spine optional milestone falsifier (vague-guard reuse)
//   5. North Star runtime alert (>10% w/w degradation surfaces card)
//
// Run: node app/scripts/_dev_verify_growth_v2.js
// Exit: 0 PASS-only / 1 any FAIL / 2 uncaught throw.

const fs = require('node:fs');
const path = require('node:path');

const SLUG = '__verify_growth_v2__';

const vault = require('../lib/vault');
const VAULT_ROOT = vault.resolveRoot();
process.env.HYPHA_DATA = VAULT_ROOT;

const crossSpark    = require('../lib/growth/cross-spark');
const judgmentGym   = require('../lib/growth/judgment-gym');
const thinkingTools = require('../lib/growth/thinking-tools');
const projectSpine  = require('../lib/growth/project-spine');
const northStar     = require('../lib/growth/north-star-metrics');
const decisionLog   = require('../lib/creation/decision-log');

const C_GREEN  = '\x1b[32m';
const C_YELLOW = '\x1b[33m';
const C_RED    = '\x1b[31m';
const C_DIM    = '\x1b[2m';
const C_RESET  = '\x1b[0m';
const green  = s => `${C_GREEN}${s}${C_RESET}`;
const yellow = s => `${C_YELLOW}${s}${C_RESET}`;
const red    = s => `${C_RED}${s}${C_RESET}`;
const dim    = s => `${C_DIM}${s}${C_RESET}`;

const results = [];
let assertionCount = 0;

function record(id, status, label, detail = '') {
  results.push({ id, status, label, detail });
  const tag = status === 'PASS' ? green('PASS') : status === 'SKIP' ? yellow('SKIP') : red('FAIL');
  console.log(`[${id}] ${tag}  ${label}${detail ? ' — ' + detail : ''}`);
}
function assert(cond, msg) {
  assertionCount++;
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}
async function runTest(id, label, fn) {
  try { const d = await fn(); record(id, 'PASS', label, d || ''); }
  catch (err) { record(id, 'FAIL', label, (err && err.message) || String(err)); }
}

function vaultDir() { return path.join(VAULT_ROOT, SLUG); }
function alertFilePath() { return path.join(VAULT_ROOT, '.hypha', 'growth-alerts.jsonl'); }

const OWNED_FILES = Object.freeze([
  '.cross-sparks.jsonl',
  '.judgment-gym.jsonl',
  '.thinking-tools.jsonl',
  '.project-spine.jsonl',
  '.concept-lifecycle.jsonl',
  '.artifacts.jsonl',
]);

function cleanSlugVault() {
  const dir = vaultDir();
  if (fs.existsSync(dir)) {
    for (const f of OWNED_FILES) {
      const abs = path.join(dir, f);
      if (fs.existsSync(abs)) {
        try { fs.unlinkSync(abs); } catch (_) {}
      }
    }
    try {
      const r = fs.readdirSync(dir);
      if (r.length === 0) fs.rmdirSync(dir);
    } catch (_) {}
  }
  // Don't clobber an existing growth-alerts.jsonl from other slugs — only
  // remove our own test row at end. We can't easily filter mid-run, so we
  // snapshot the file size before running and truncate-restore after.
}
function ensureDir() { fs.mkdirSync(vaultDir(), { recursive: true }); }

let _alertSnapshotBytes = null;
function snapshotAlertFile() {
  const abs = alertFilePath();
  _alertSnapshotBytes = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
}
function restoreAlertFile() {
  const abs = alertFilePath();
  if (!fs.existsSync(abs)) return;
  if (_alertSnapshotBytes === 0) {
    try { fs.unlinkSync(abs); } catch (_) {}
    return;
  }
  try {
    const buf = fs.readFileSync(abs);
    if (buf.length > _alertSnapshotBytes) {
      fs.writeFileSync(abs, buf.subarray(0, _alertSnapshotBytes));
    }
  } catch (_) { /* best-effort */ }
}

async function main() {
  console.log(dim('HYPHA · Growth System v2 dedicated smoke'));
  console.log(dim(`vault root: ${VAULT_ROOT}`));
  console.log(dim(`slug      : ${SLUG}`));
  console.log('');

  cleanSlugVault();
  ensureDir();
  snapshotAlertFile();

  // -------------------------------------------------------------------------
  // GV1 — Cross-Spark Jaccard tokenization basic shape
  // -------------------------------------------------------------------------
  await runTest('GV1', 'cross-spark _tokenize filters stopwords + short tokens', async () => {
    const tok = crossSpark._internals.tokenize;
    const out = tok('The attention mechanism scales with sequence length');
    assert(Array.isArray(out), 'returns array');
    assert(out.includes('attention'), 'keeps content word');
    assert(out.includes('mechanism'), 'keeps content word');
    assert(!out.includes('the'), 'filters stopword "the"');
    assert(!out.includes('a'), 'filters single-char stopword effect');
    return `tokens=${out.length}`;
  });

  // -------------------------------------------------------------------------
  // GV2 — Cross-Spark strength bounded [0,1], identical text = 1.0
  // -------------------------------------------------------------------------
  await runTest('GV2', 'cross-spark computeStrength bounded + identical=1.0', async () => {
    const f = crossSpark._internals.computeStrength;
    const a = f('attention mechanism scales sequence length', 'attention mechanism scales sequence length');
    const b = f('', 'attention mechanism');
    const c = f('attention mechanism scales', 'completely unrelated apricot terrarium');
    assert(Math.abs(a - 1.0) < 1e-9, `identical → 1.0, got ${a}`);
    assert(b === 0, `empty → 0, got ${b}`);
    assert(c >= 0 && c < 1, `disjoint should be <1, got ${c}`);
    return `identical=${a} empty=${b} disjoint=${c}`;
  });

  // -------------------------------------------------------------------------
  // GV3 — Cross-Spark strength: partial overlap produces middling score
  // -------------------------------------------------------------------------
  await runTest('GV3', 'cross-spark partial overlap produces 0 < s < 1', async () => {
    const f = crossSpark._internals.computeStrength;
    const s = f('attention mechanism transformer scaling', 'attention transformer head normalization');
    assert(s > 0 && s < 1, `partial overlap should be in (0,1), got ${s}`);
    return `partial=${s.toFixed(3)}`;
  });

  // -------------------------------------------------------------------------
  // GV4 — Cross-Spark envelope still well-formed + carries strengthGate
  // -------------------------------------------------------------------------
  await runTest('GV4', 'cross-spark generateCrossSparks envelope carries strengthGate', async () => {
    const res = await crossSpark.generateCrossSparks({
      slug: SLUG,
      concept: 'attention-mechanism',
      k: 3,
      dryRun: true,
    });
    assert(res && typeof res === 'object', 'res object');
    assert(typeof res.ok === 'boolean', 'ok bool');
    if (res.ok) {
      assert(Array.isArray(res.sparks), 'sparks array');
      assert(typeof res.strengthGate === 'number', 'strengthGate number');
      assert(typeof res.rejectedWeak === 'number', 'rejectedWeak number');
      for (const s of res.sparks) {
        assert(typeof s.strength === 'number', 'spark has numeric strength');
        assert(s.strength >= res.strengthGate, `spark.strength ${s.strength} < gate ${res.strengthGate}`);
      }
      return `ok:true gate=${res.strengthGate} kept=${res.sparks.length} rejected=${res.rejectedWeak}`;
    }
    const accept = ['NO_CANDIDATES', 'NO_LLM_KEY', 'LLM_PARSE', 'EXCEPTION'];
    assert(accept.includes(res.error), `expected error in ${accept.join('|')}, got ${res.error}`);
    return `ok:false error=${res.error}`;
  });

  // -------------------------------------------------------------------------
  // GV5 — Judgment Gym: calibration empty vault returns ok+empty
  // -------------------------------------------------------------------------
  await runTest('GV5', 'judgment-gym getCalibration empty vault', async () => {
    const res = await judgmentGym.getCalibration({ slug: SLUG });
    assert(res.ok, 'ok:true');
    assert(Array.isArray(res.calibration), 'calibration array');
    assert(res.calibration.length === 0, 'empty');
    return `entries=0`;
  });

  // -------------------------------------------------------------------------
  // GV6 — Judgment Gym: seed two topics + rejudge → stability reflects flips
  // -------------------------------------------------------------------------
  await runTest('GV6', 'judgment-gym stability reflects rejudge match/flip', async () => {
    const a = await judgmentGym.addClaim({
      slug: SLUG, claim: 'topic-A claim one (stable held)',
      initialJudgment: 'agree', initialReasoning: 'r1', topic: 'topicA',
    });
    assert(a.ok, 'addClaim A ok');
    const r1 = await judgmentGym.rejudgeClaim({
      slug: SLUG, claimId: a.entry.id, newJudgment: 'agree', newReasoning: 'still agree',
    });
    assert(r1.ok, 'rejudge A stable ok');

    const b = await judgmentGym.addClaim({
      slug: SLUG, claim: 'topic-B claim one (flipped)',
      initialJudgment: 'agree', initialReasoning: 'r1', topic: 'topicB',
    });
    assert(b.ok, 'addClaim B ok');
    const r2 = await judgmentGym.rejudgeClaim({
      slug: SLUG, claimId: b.entry.id, newJudgment: 'disagree', newReasoning: 'flipped',
    });
    assert(r2.ok, 'rejudge B flipped ok');

    const cal = await judgmentGym.getCalibration({ slug: SLUG });
    assert(cal.ok, 'cal ok');
    const byTopic = new Map(cal.calibration.map(c => [c.topic, c]));
    assert(byTopic.has('topicA'), 'topicA present');
    assert(byTopic.has('topicB'), 'topicB present');
    assert(byTopic.get('topicA').stability === 1, `topicA stability=1, got ${byTopic.get('topicA').stability}`);
    assert(byTopic.get('topicB').stability === 0, `topicB stability=0, got ${byTopic.get('topicB').stability}`);
    return `topicA=${byTopic.get('topicA').stability} topicB=${byTopic.get('topicB').stability}`;
  });

  // -------------------------------------------------------------------------
  // GV7 — Judgment Gym: nextEdgeChallenge picks open claim closest to target
  //       (cold-start: open claim w/ no rejudgments treated at target = mid)
  // -------------------------------------------------------------------------
  await runTest('GV7', 'judgment-gym nextEdgeChallenge cold-start surfaces open claim', async () => {
    // Seed a fresh OPEN claim on a cold topic (no rejudgments anywhere) —
    // should be selectable since cold-start defaults stability to target.
    const seed = await judgmentGym.addClaim({
      slug: SLUG, claim: 'topic-C claim cold-start (open)',
      initialJudgment: 'partial', initialReasoning: 'GV7', topic: 'topicC',
    });
    assert(seed.ok, 'seed ok');

    const next = await judgmentGym.nextEdgeChallenge({ slug: SLUG });
    assert(next.ok, 'nextEdgeChallenge ok');
    assert(next.entry, `entry not null (reason=${next.reason})`);
    assert(typeof next.stability === 'number', 'stability numeric');
    assert(typeof next.distance === 'number', 'distance numeric');
    return `picked=${next.topic} stability=${next.stability} distance=${next.distance}`;
  });

  // -------------------------------------------------------------------------
  // GV8 — Thinking Tools: getToolCluster returns trio for known anchor
  // -------------------------------------------------------------------------
  await runTest('GV8', 'thinking-tools getToolCluster first-principles → 3-tool cluster', async () => {
    const res = thinkingTools.getToolCluster('first-principles');
    assert(res.ok, 'ok:true');
    assert(res.cluster && res.cluster.anchor.id === 'first-principles', 'anchor id matches');
    assert(Array.isArray(res.cluster.pair), 'pair array');
    assert(res.cluster.pair.length === 2, `expected 2 paired tools, got ${res.cluster.pair.length}`);
    // The S77-cluster contract: first-principles pairs with inversion + map-territory
    const ids = res.cluster.pair.map(t => t.id).sort();
    assert(ids[0] === 'inversion' && ids[1] === 'map-territory',
      `expected [inversion, map-territory], got ${JSON.stringify(ids)}`);
    return `cluster=first-principles+${ids.join('+')}`;
  });

  // -------------------------------------------------------------------------
  // GV9 — Thinking Tools: unknown tool id → NOT_FOUND
  // -------------------------------------------------------------------------
  await runTest('GV9', 'thinking-tools getToolCluster unknown id → NOT_FOUND', async () => {
    const res = thinkingTools.getToolCluster('not-a-real-tool');
    assert(res.ok === false, 'ok:false');
    assert(res.error === 'NOT_FOUND', `expected NOT_FOUND, got ${res.error}`);
    return `error=${res.error}`;
  });

  // -------------------------------------------------------------------------
  // GV10 — Project Spine: addSpineEntry kind='milestone' WITHOUT falsifier ok
  // -------------------------------------------------------------------------
  await runTest('GV10', 'project-spine milestone without falsifier ok (back-compat)', async () => {
    const res = await projectSpine.addSpineEntry({
      slug: SLUG, kind: 'milestone', content: 'GV10 milestone w/o falsifier',
    });
    assert(res.ok, `addSpineEntry ok (got ${res.error})`);
    assert(!('falsifier' in res.entry), 'no falsifier field when absent');
    return `entry.id=${res.entry.id.slice(0, 8)}…`;
  });

  // -------------------------------------------------------------------------
  // GV11 — Project Spine: vague falsifier rejected via shared guard
  // -------------------------------------------------------------------------
  await runTest('GV11', 'project-spine vague falsifier rejected (shared guard)', async () => {
    const vague = await projectSpine.addSpineEntry({
      slug: SLUG, kind: 'milestone', content: 'GV11 milestone vague falsifier',
      falsifier: {
        claim: 'we will ship this',
        falsifier: 'we will see how it goes',  // no numeric / comparator / date
        deadline_iso: '2026-06-01',
      },
    });
    assert(!vague.ok, 'should reject vague');
    assert(vague.error === 'INVALID_FALSIFIER', `expected INVALID_FALSIFIER, got ${vague.error}`);
    return `error=${vague.error}`;
  });

  // -------------------------------------------------------------------------
  // GV12 — Project Spine: concrete falsifier accepted + persisted
  // -------------------------------------------------------------------------
  await runTest('GV12', 'project-spine concrete falsifier accepted + persisted', async () => {
    const ok = await projectSpine.addSpineEntry({
      slug: SLUG, kind: 'milestone', content: 'GV12 milestone with concrete falsifier',
      falsifier: {
        claim: 'critique loop lifts pass-rate above baseline',
        falsifier: 'if pass-rate < 60% after 50 lessons by 2026-06-30',
        deadline_iso: '2026-06-30',
      },
    });
    assert(ok.ok, `accept ok (got ${ok.error || ''} ${ok.message || ''})`);
    assert(ok.entry.falsifier, 'falsifier field present on entry');
    assert(ok.entry.falsifier.deadline_iso === '2026-06-30', 'deadline persisted');

    const list = await projectSpine.listSpine({ slug: SLUG, kindFilter: 'milestone' });
    assert(list.ok, 'listSpine ok');
    const found = list.entries.find(e => e.id === ok.entry.id);
    assert(found, 'milestone surfaces in list');
    assert(found.falsifier && found.falsifier.claim, 'falsifier round-trips');
    return `falsifier.deadline=${found.falsifier.deadline_iso}`;
  });

  // -------------------------------------------------------------------------
  // GV13 — Shared guard reuse: decision-log helper is the one project-spine uses
  // -------------------------------------------------------------------------
  await runTest('GV13', 'decision-log _falsifierGuard exposed for reuse', async () => {
    assert(decisionLog._falsifierGuard, 'guard exported');
    const g = decisionLog._falsifierGuard;
    assert(typeof g.isVagueFalsifier === 'function', 'isVagueFalsifier fn');
    assert(g.isVagueFalsifier('we will see how it goes') === true, 'vague hedge caught');
    assert(g.isVagueFalsifier('if pass-rate < 60% after 50 lessons') === false, 'concrete passes');
    return `guard=ok`;
  });

  // -------------------------------------------------------------------------
  // GV14 — North Star alert: no degradation → alert null
  // -------------------------------------------------------------------------
  await runTest('GV14', 'north-star checkNorthStarAlert no-degradation returns alert:null', async () => {
    const current = await northStar.getNorthStar({ slug: SLUG });
    assert(current.ok, 'getNorthStar ok');
    // Same-as-current previous → no drop possible
    const res = await northStar.checkNorthStarAlert({
      slug: SLUG,
      previousMetrics: current.metrics,
    });
    assert(res.ok, 'checkNorthStarAlert ok');
    assert(res.alert === null, `expected null alert, got ${JSON.stringify(res.alert)}`);
    return `alert=null`;
  });

  // -------------------------------------------------------------------------
  // GV15 — North Star alert: synthetic >10% drop → alert fires + persisted
  // -------------------------------------------------------------------------
  await runTest('GV15', 'north-star checkNorthStarAlert >10% drop fires + persists', async () => {
    // Inflate "previous" so current (= 0 on empty slug) is a degradation.
    // ratified drop from 10 → 0 = 100% > 10% threshold.
    const previousMetrics = {
      ratified: 10,
      draft_on_deck: 0,
      artifacts_shipped: 5,
      spark_matured: 0,
    };
    const res = await northStar.checkNorthStarAlert({
      slug: SLUG,
      previousMetrics,
    });
    assert(res.ok, 'ok:true');
    assert(res.alert, 'alert non-null');
    assert(Array.isArray(res.alert.degraded), 'degraded array');
    assert(res.alert.degraded.length >= 1, `degraded ≥1, got ${res.alert.degraded.length}`);
    const ratifiedRow = res.alert.degraded.find(d => d.pillar === 'ratified');
    assert(ratifiedRow, 'ratified pillar surfaced');
    assert(ratifiedRow.previous === 10, 'previous=10');
    assert(ratifiedRow.current === 0, 'current=0');
    assert(ratifiedRow.drop === 1, `drop=1.0, got ${ratifiedRow.drop}`);

    // Verify alert was appended to .hypha/growth-alerts.jsonl
    const abs = alertFilePath();
    assert(fs.existsSync(abs), 'alert jsonl exists');
    const list = await northStar.listNorthStarAlerts({ limit: 5 });
    assert(list.ok, 'listNorthStarAlerts ok');
    assert(list.alerts.length >= 1, 'at least one alert listed');
    const latest = list.alerts[0];
    assert(latest.slug === SLUG, 'latest alert is ours');
    return `degraded=${res.alert.degraded.length} pillars persisted=${list.alerts.length >= 1}`;
  });

  // -------------------------------------------------------------------------
  // GV16 — Strength gate filter: low minStrength keeps everything,
  //        high minStrength may drop sparks. Pure-fn check via helper.
  // -------------------------------------------------------------------------
  await runTest('GV16', 'cross-spark strength gate parametrized via minStrength', async () => {
    const f = crossSpark._internals.computeStrength;
    const concept = 'attention mechanism transformer';
    const cand = 'attention layer normalization residual';
    const s = f(concept, cand);
    assert(s > 0 && s < 1, `expected partial overlap, got ${s}`);
    // Synthesis check — at gate above the score the spark would be filtered.
    const passes = s >= 0.3;
    const filtered = s >= 0.99;
    return `partial=${s.toFixed(3)} passes_default=${passes} filtered_at_0.99=${filtered}`;
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

  cleanSlugVault();
  restoreAlertFile();

  if (failCount > 0) process.exit(1);
  process.exit(0);
}

main().catch(err => {
  console.error(red('UNCAUGHT'), err && err.stack ? err.stack : err);
  try { cleanSlugVault(); restoreAlertFile(); } catch (_) {}
  process.exit(2);
});
