#!/usr/bin/env node
'use strict';
// SKIP_HEADLESS — needs vault/.hypha/smoke-baseline.json from a prior local sweep; CI runs from fresh checkout.

// HYPHA · _dev_verify_sweep_runner — smoke-harness audit (boot-11).
//
// Verifies app/scripts/_dev_run_all_smokes.js parses RUN_SEQUENTIAL marker,
// splits parallel + sequential pools correctly, respects the per-pool timeout,
// writes the baseline lockfile with the full schema, and only emits LOCKED
// status / exit 0 when failing == 0.
//
// 9 tests:
//   T1 — sweep runner exports / source contains both markers
//   T2 — RUN_SEQUENTIAL marker parsed: exactly the 4 LLM smokes route to seq
//   T3 — parallel pool cap respected (CONCURRENCY constant present)
//   T4 — sequential queue runs AFTER parallel drains (source-order audit)
//   T5 — per-smoke timeout configurable + correct defaults (45s / 120s)
//   T6 — baseline file written with full schema fields
//   T7 — status = LOCKED only when 0 failures
//   T8 — exit code 0 only on LOCKED state
//   T9 — verifier itself does NOT re-trigger sweep on require (idempotent load)
//
// Standalone Node — no Electron. Reads sweep runner source + (when present)
// the latest baseline JSON. Does NOT shell out to run the sweep itself (would
// double-run the full sweep on each verify, ~5min). Instead, the sweep is run
// from CI / manual workflow; this script audits the static contract + the
// most-recent baseline artifact.
//
// Exit 0 = PASS N/N, exit 1 = any failure.

const fs   = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SWEEP_RUNNER = path.join(__dirname, '_dev_run_all_smokes.js');
const BASELINE     = path.join(ROOT, 'vault', '.hypha', 'smoke-baseline.json');
const SCRIPTS_DIR  = __dirname;

let pass = 0;
let fail = 0;
const failures = [];

function assert(label, cond, detail) {
  if (cond) {
    pass += 1;
    // eslint-disable-next-line no-console
    console.log(`[PASS] ${label}`);
  } else {
    fail += 1;
    failures.push(`${label} — ${detail || 'no detail'}`);
    // eslint-disable-next-line no-console
    console.log(`[FAIL] ${label}${detail ? '\n        ' + detail : ''}`);
  }
}

function readSource() {
  return fs.readFileSync(SWEEP_RUNNER, 'utf8');
}

// Strict marker — same regex as the sweep runner uses, so this verifier is
// the canonical source of marker-detection truth. Docstrings that merely
// MENTION RUN_SEQUENTIAL (e.g. this file's own header) won't match.
const SEQUENTIAL_MARKER_RE = /^\s*\/\/\s*RUN_SEQUENTIAL\b/m;

function discoverSequentialSmokes() {
  const files = fs.readdirSync(SCRIPTS_DIR).filter(f => /^_dev_verify_.*\.js$/.test(f));
  const out = [];
  for (const f of files) {
    try {
      const head = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8').split('\n').slice(0, 20).join('\n');
      if (SEQUENTIAL_MARKER_RE.test(head)) out.push(f);
    } catch (_) { /* ignore */ }
  }
  return out.sort();
}

// ─── T1 — source contains both markers + pool function ────────────────────
(function t1() {
  const src = readSource();
  const hasSeqMarker = /SEQUENTIAL_MARKER_RE\s*=\s*\/\^\\s\*\\\/\\\/\\s\*RUN_SEQUENTIAL/.test(src);
  const hasHeadMarker = src.includes('HEADLESS_MARKER')
                     && src.includes("'SKIP_HEADLESS'");
  const hasSeqFn = /function\s+runSequential\s*\(/.test(src);
  const hasShouldFn = /function\s+shouldRunSequential\s*\(/.test(src);
  assert(
    'T1 sweep runner declares RUN_SEQUENTIAL regex marker + SKIP_HEADLESS + sequential helpers',
    hasSeqMarker && hasHeadMarker && hasSeqFn && hasShouldFn,
    `seq-marker=${hasSeqMarker} head-marker=${hasHeadMarker} runSeq=${hasSeqFn} shouldSeq=${hasShouldFn}`,
  );
})();

// ─── T2 — exactly the 5 LLM-bound smokes are marked sequential ────────────
// growth_system added boot-12: LLM-bound + vault-writing, races the 45s
// parallel cap under sweep concurrency (timed out at 45s, standalone ~17s).
(function t2() {
  const expected = [
    '_dev_verify_creation_system.js',
    '_dev_verify_full_chain.js',
    '_dev_verify_golden_path_e2e.js',
    '_dev_verify_growth_system.js',
    '_dev_verify_route_goal.js',
  ].sort();
  const got = discoverSequentialSmokes();
  const same = got.length === expected.length && got.every((f, i) => f === expected[i]);
  assert(
    'T2 RUN_SEQUENTIAL marker present in exactly the 5 LLM-bound smokes',
    same,
    `expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}`,
  );
})();

// ─── T3 — parallel pool cap respected (CONCURRENCY = 4) ───────────────────
(function t3() {
  const src = readSource();
  const m = src.match(/const\s+CONCURRENCY\s*=\s*(\d+)\s*;/);
  const cap = m ? parseInt(m[1], 10) : 0;
  const runPoolUsesCap = /runPool\(parallelFiles,\s*CONCURRENCY,/.test(src);
  assert(
    'T3 parallel pool cap configured (CONCURRENCY=4) and used by runPool',
    cap === 4 && runPoolUsesCap,
    `cap=${cap} runPoolUsesCap=${runPoolUsesCap}`,
  );
})();

// ─── T4 — sequential queue runs AFTER parallel pool drains ────────────────
(function t4() {
  const src = readSource();
  const idxParallel = src.indexOf('await runPool(parallelFiles');
  const idxSequential = src.indexOf('await runSequential(sequentialFiles');
  const correctOrder = idxParallel > 0 && idxSequential > 0 && idxSequential > idxParallel;
  // Also confirm sequential runs ONE at a time (no Promise.all over files).
  const seqFn = src.match(/async\s+function\s+runSequential[\s\S]*?\n\}/);
  const noPromiseAllInSeq = seqFn && !/Promise\.all/.test(seqFn[0]);
  assert(
    'T4 sequential queue drains AFTER parallel pool (one-at-a-time, no Promise.all)',
    correctOrder && noPromiseAllInSeq,
    `parallelIdx=${idxParallel} seqIdx=${idxSequential} noPromiseAllInSeq=${noPromiseAllInSeq}`,
  );
})();

// ─── T5 — per-smoke timeout configurable + correct defaults ───────────────
(function t5() {
  const src = readSource();
  const mP = src.match(/PARALLEL_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/);
  const mS = src.match(/SEQUENTIAL_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/);
  const parallelMs = mP ? parseInt(mP[1].replace(/_/g, ''), 10) : 0;
  const sequentialMs = mS ? parseInt(mS[1].replace(/_/g, ''), 10) : 0;
  // runOne now takes timeoutMs argument (configurable).
  const runOneTakesArg = /function\s+runOne\s*\(\s*file\s*,\s*timeoutMs\s*\)/.test(src);
  // Parallel timeout: exactly 45s (kept for fast non-LLM smokes).
  // Sequential timeout: at least 120s, must be larger than parallel timeout
  // (LLM chains measured at 51s-253s standalone, so > 120s is required for
  // full_chain). We accept anything in [120s, 600s] to leave room for tuning.
  const seqOk = sequentialMs >= 120_000 && sequentialMs <= 600_000 && sequentialMs > parallelMs;
  assert(
    'T5 per-smoke timeout configurable: parallel=45s, sequential ∈ [120s, 600s] & > parallel',
    parallelMs === 45_000 && seqOk && runOneTakesArg,
    `parallel=${parallelMs} sequential=${sequentialMs} runOneTakesArg=${runOneTakesArg}`,
  );
})();

// ─── T6 — baseline file written with full schema ──────────────────────────
(function t6() {
  if (!fs.existsSync(BASELINE)) {
    assert('T6 baseline file exists at vault/.hypha/smoke-baseline.json', false, `missing ${BASELINE}`);
    return;
  }
  let baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  } catch (e) {
    assert('T6 baseline JSON parses cleanly', false, e.message);
    return;
  }
  const required = [
    'version', 'captured_at', 'status', 'total_smokes', 'total_tests',
    'passing', 'failing', 'skipped', 'concurrency',
    'parallel_timeout_ms', 'sequential_timeout_ms',
    'parallel_count', 'sequential_count', 'sequential_files',
    'smokes', 'skipped_files',
  ];
  const missing = required.filter(k => !(k in baseline));
  // smokes entries should carry pool field.
  const smokes = Array.isArray(baseline.smokes) ? baseline.smokes : [];
  const everySmokeHasPool = smokes.length > 0 && smokes.every(s => s.pool === 'P' || s.pool === 'S');
  assert(
    'T6 baseline lockfile carries full v0.11 schema (status / pool fields / dual timeouts)',
    missing.length === 0 && everySmokeHasPool,
    `missing=${JSON.stringify(missing)} smokesPoolField=${everySmokeHasPool} smokes=${smokes.length}`,
  );
})();

// ─── T7 — status = LOCKED only when 0 failures ────────────────────────────
(function t7() {
  if (!fs.existsSync(BASELINE)) {
    assert('T7 baseline status field obeys LOCKED ↔ 0-failures invariant', false, 'no baseline file');
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const consistent =
    (baseline.failing === 0 && baseline.status === 'LOCKED') ||
    (baseline.failing > 0  && baseline.status !== 'LOCKED');
  assert(
    'T7 status invariant — LOCKED ⇔ failing === 0',
    consistent,
    `status=${baseline.status} failing=${baseline.failing}`,
  );
})();

// ─── T8 — exit code 0 only on LOCKED state (source audit) ─────────────────
(function t8() {
  const src = readSource();
  // process.exit(failing.length ? 1 : 0) — single-source: exit 0 only when failing==0.
  const m = src.match(/process\.exit\(failing\.length\s*\?\s*1\s*:\s*0\)/);
  assert(
    'T8 exit code wired to failing-count (0 ⇔ all PASS ⇔ LOCKED)',
    !!m,
    'expected literal `process.exit(failing.length ? 1 : 0)` in sweep runner',
  );
})();

// ─── T9 — verifier doesn't re-trigger sweep on require ────────────────────
(function t9() {
  // Audit: requiring _dev_run_all_smokes.js as a module should NOT auto-spawn
  // the IIFE that runs the sweep. The current sweep file ships as a CLI
  // (top-level `(async () => { ... })().catch(...)`), so this verifier never
  // requires it — it only reads the source. Strip comments first, then check
  // for any executable require/import targeting the runner.
  const verifierSrc = fs.readFileSync(__filename, 'utf8');
  // Remove // line comments + /* */ block comments before scanning.
  const codeOnly = verifierSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[\t ]*\/\/.*$/gm, '');
  const requireRe = /\brequire\s*\(\s*['"][^'"]*_dev_run_all_smokes/;
  const importRe  = /\bimport\s+[^'";]*from\s*['"][^'"]*_dev_run_all_smokes/;
  const dynamicImportRe = /\bimport\s*\(\s*['"][^'"]*_dev_run_all_smokes/;
  const accidental = requireRe.test(codeOnly) || importRe.test(codeOnly) || dynamicImportRe.test(codeOnly);
  assert(
    'T9 verifier does not require/re-spawn sweep runner on load',
    !accidental,
    'verifier must read source statically, never require() the IIFE',
  );
})();

// ─── Summary ──────────────────────────────────────────────────────────────
const total = pass + fail;
// eslint-disable-next-line no-console
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} ${pass}/${total}`);
if (fail > 0) {
  // eslint-disable-next-line no-console
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
