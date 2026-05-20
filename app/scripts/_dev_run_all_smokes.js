#!/usr/bin/env node
'use strict';

// HYPHA · boot-11 · _dev_run_all_smokes
//
// Sweep every `_dev_verify_*.js` smoke under app/scripts/, capture per-smoke
// status + last 5 lines of stdout + runtime, write a lockfile JSON at
// vault/.hypha/smoke-baseline.json. This file is the v1.0 ship-state baseline
// future CI / hooks read to detect regressions.
//
// Rules:
//   - Two-pool execution model (boot-11):
//       Pool A · parallel  — concurrency cap = 4, per-smoke timeout = 45s
//       Pool B · sequential — drains AFTER pool A, one-at-a-time, timeout = 120s
//   - Smokes carrying the marker `RUN_SEQUENTIAL` in their first 20 lines are
//     routed to pool B. Used by LLM-bound smokes that hammer the same provider
//     token bucket and rate-limit / cold-call past 45s under concurrency.
//   - Skip smokes whose first 20 lines contain the marker `SKIP_HEADLESS`
//     (electron-bound smokes). Marker is comment-only — no false positives in
//     code today (grep confirmed 0 hits before this script landed).
//   - Aggregate `\d+/\d+ PASS` regex pattern across all stdouts to count total
//     tests claimed (assertion count).
//   - Lockfile schema documented in CLAUDE.md and reproduced below.
//   - PASS = exit 0. Anything else (non-zero, timeout, spawn error) = FAIL.
//   - Exit 0 only if ALL non-skipped smokes PASS, else exit 1.
//
// Usage:  node app/scripts/_dev_run_all_smokes.js
//         npm run smoke:all

const fs   = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT        = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.resolve(__dirname);
const BASELINE    = path.join(ROOT, 'vault', '.hypha', 'smoke-baseline.json');
const VERSION     = '1.0.0-rc.1';
const CONCURRENCY = 4;
const PARALLEL_TIMEOUT_MS   = 45_000;
// 300s for sequential pool: measured cold-LLM-call chains (full_chain 4m13s,
// creation_system 51s, golden_path_e2e 2m+) need headroom for multi-LLM smokes
// hitting GLM cold. Reduce only if all sequential smokes finish under target.
const SEQUENTIAL_TIMEOUT_MS = 300_000;
const HEADLESS_MARKER    = 'SKIP_HEADLESS';
// Marker pattern is strict so docstrings that merely *mention* RUN_SEQUENTIAL
// (e.g. the audit verifier) don't accidentally route themselves to pool B.
// The active marker is a comment line that begins exactly: `// RUN_SEQUENTIAL`.
const SEQUENTIAL_MARKER_RE = /^\s*\/\/\s*RUN_SEQUENTIAL\b/m;

// ─── Discover smokes ──────────────────────────────────────────────────────
function discover() {
  return fs.readdirSync(SCRIPTS_DIR)
    .filter(f => /^_dev_verify_.*\.js$/.test(f))
    .sort();
}

function readHead(file) {
  try {
    return fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8').split('\n').slice(0, 20).join('\n');
  } catch (_) {
    return '';
  }
}

function shouldSkip(file) {
  return readHead(file).includes(HEADLESS_MARKER);
}

function shouldRunSequential(file) {
  return SEQUENTIAL_MARKER_RE.test(readHead(file));
}

// ─── Run one smoke ────────────────────────────────────────────────────────
function runOne(file, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, file)], {
      cwd: ROOT,
      env: { ...process.env, HYPHA_SMOKE_SWEEP: '1' },
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      resolve({ file, status: 'FAIL', tests: '0/0', runtime_ms: ms, exit: -1, last5: ['SPAWN ERROR: ' + e.message], timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const combined = (out + (err ? '\n' + err : '')).trim();
      const lines = combined.split('\n');
      const last5 = lines.slice(-5);
      // Pull last `\d+/\d+ PASS` style summary if present.
      const passMatches = combined.match(/(\d+)\s*\/\s*(\d+)\s*PASS/gi) || [];
      let tests = '0/0';
      if (passMatches.length) {
        const tail = passMatches[passMatches.length - 1];
        const m = tail.match(/(\d+)\s*\/\s*(\d+)/);
        if (m) tests = `${m[1]}/${m[2]}`;
      }
      const status = timedOut ? 'FAIL' : (code === 0 ? 'PASS' : 'FAIL');
      resolve({ file, status, tests, runtime_ms: ms, exit: code, last5, timedOut });
    });
  });
}

// ─── Pool with concurrency cap ────────────────────────────────────────────
async function runPool(files, cap, timeoutMs, label) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const idx = cursor++;
      const f = files[idx];
      // eslint-disable-next-line no-console
      console.log(`[${label} ${String(idx + 1).padStart(2, '0')}/${files.length}] ${f}`);
      // eslint-disable-next-line no-await-in-loop
      const r = await runOne(f, timeoutMs);
      r.pool = label;
      results.push(r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(cap, files.length || 1) }, () => worker()));
  return results;
}

// ─── Sequential queue (drains one at a time, post-parallel) ───────────────
async function runSequential(files, timeoutMs, label) {
  const results = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // eslint-disable-next-line no-console
    console.log(`[${label} ${String(i + 1).padStart(2, '0')}/${files.length}] ${f}`);
    // eslint-disable-next-line no-await-in-loop
    const r = await runOne(f, timeoutMs);
    r.pool = label;
    results.push(r);
  }
  return results;
}

// ─── Render markdown table ────────────────────────────────────────────────
function renderTable(results, skipped) {
  const rows = [];
  rows.push('| # | smoke | status | tests | runtime |');
  rows.push('|---|---|---|---|---|');
  results.forEach((r, i) => {
    const mark = r.status === 'PASS' ? 'PASS' : (r.timedOut ? 'TIMEOUT' : 'FAIL');
    rows.push(`| ${i + 1} | ${r.file} | ${mark} | ${r.tests} | ${r.runtime_ms}ms |`);
  });
  skipped.forEach((f) => rows.push(`| - | ${f} | SKIP | - | - |`));
  return rows.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────
(async () => {
  const allFiles = discover();
  const skipped  = allFiles.filter(shouldSkip);
  const runnable = allFiles.filter(f => !skipped.includes(f));
  const sequentialFiles = runnable.filter(shouldRunSequential).sort();
  const parallelFiles   = runnable.filter(f => !sequentialFiles.includes(f)).sort();

  // eslint-disable-next-line no-console
  console.log(
    `HYPHA smoke sweep — ${runnable.length} runnable (${parallelFiles.length} parallel cap=${CONCURRENCY} @ ${PARALLEL_TIMEOUT_MS / 1000}s, ` +
    `${sequentialFiles.length} sequential @ ${SEQUENTIAL_TIMEOUT_MS / 1000}s), ${skipped.length} skipped`,
  );

  const parallelResults   = await runPool(parallelFiles, CONCURRENCY, PARALLEL_TIMEOUT_MS, 'P');
  const sequentialResults = await runSequential(sequentialFiles, SEQUENTIAL_TIMEOUT_MS, 'S');
  const results = [...parallelResults, ...sequentialResults].sort((a, b) => a.file.localeCompare(b.file));

  const passing = results.filter(r => r.status === 'PASS');
  const failing = results.filter(r => r.status !== 'PASS');

  // Sum tests across all PASS smokes from `m/n` strings.
  let totalTests = 0;
  for (const r of results) {
    const m = r.tests.match(/^(\d+)\s*\/\s*(\d+)$/);
    if (m) totalTests += parseInt(m[2], 10);
  }

  const status = failing.length ? 'CAPTURED' : 'LOCKED';
  const baseline = {
    version: VERSION,
    captured_at: new Date().toISOString(),
    status,
    total_smokes: runnable.length,
    total_tests: totalTests,
    passing: passing.length,
    failing: failing.length,
    skipped: skipped.length,
    concurrency: CONCURRENCY,
    parallel_timeout_ms:   PARALLEL_TIMEOUT_MS,
    sequential_timeout_ms: SEQUENTIAL_TIMEOUT_MS,
    parallel_count:   parallelFiles.length,
    sequential_count: sequentialFiles.length,
    sequential_files: sequentialFiles,
    smokes: results.map(r => ({
      file: r.file,
      pool: r.pool || 'P',
      status: r.status,
      tests: r.tests,
      runtime_ms: r.runtime_ms,
      exit: r.exit,
      ...(r.status !== 'PASS' ? { last5: r.last5 } : {}),
    })),
    skipped_files: skipped,
  };

  // Ensure vault/.hypha exists then write lockfile.
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + '\n', 'utf8');

  // eslint-disable-next-line no-console
  console.log('\n' + renderTable(results, skipped));
  // eslint-disable-next-line no-console
  console.log('');

  if (failing.length) {
    // eslint-disable-next-line no-console
    console.log(`FAILING (${failing.length}):`);
    for (const r of failing) {
      // eslint-disable-next-line no-console
      console.log(`  ${r.file} (exit=${r.exit}${r.timedOut ? ', TIMEOUT' : ''})`);
      for (const ln of r.last5) console.log(`    | ${ln}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\nSweep v1.0 — ${passing.length}/${runnable.length} smokes PASS · ${totalTests} total tests · ` +
    `baseline ${status === 'LOCKED' ? 'LOCKED' : 'CAPTURED (NOT locked, ' + failing.length + ' FAIL)'} ` +
    `at ${path.relative(ROOT, BASELINE).replace(/\\/g, '/')}`,
  );

  process.exit(failing.length ? 1 : 0);
})().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('FATAL', e);
  process.exit(2);
});
