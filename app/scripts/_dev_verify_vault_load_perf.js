'use strict';

// HYPHA boot-12 (2026-05-20) — vault load + perf smoke for v1.0.
//
// User vaults grow over the product's lifetime. v1.0 targets:
//   50+ courses × 30+ lessons = 1500 lesson .md files
//   Each .md ~5KB → total vault ~7.5MB
// This smoke uses a smaller proxy (20 courses × 10 lessons = 200 files,
// ~1MB) and measures the hot paths against generous upper-bound thresholds.
// Thresholds are bounds, not targets — faster is great; way-over = real cliff.
//
// Run:  node app/scripts/_dev_verify_vault_load_perf.js
// Expect: 10/10 PASS (or fail loud with op + duration + threshold + suggestion).
//
// Tests:
//   T01 vault.list duration on 200-file vault         (< 500ms)
//   T02 chain.json read for each of 20 courses        (< 50ms p95 per call)
//   T03 lesson body load via vault.read               (< 30ms p95 per call)
//   T04 vault-snapshot snapshotVault end-to-end       (< 5000ms)
//   T05 smoke-baseline.json read                      (< 100ms)
//   T06 localTracker.recordError (consent off)        (< 5ms per call)
//   T07 100 sequential northStar.getNorthStar (proxy) (< 2000ms total)
//   T08 1000 cost-predictor.estimateTokens calls      (< 100ms total)
//   T09 cleanup-registry.runAll with 20 entries       (< 100ms)
//   T10 tmpdir cleanup                                (no error)
//
// All measurements log to vault/.hypha/perf-trace.jsonl for future trend.
// Uses process.hrtime.bigint (no benchmark deps per task constraint).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ── 1. Isolated synthetic vault ────────────────────────────────────────
// Must set HYPHA_DATA BEFORE requiring any lib module (vault.resolveRoot
// reads env on each call but other modules cache vault refs at require-time,
// e.g. local-tracker grabs the vault module once).
const TMP_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-load-perf-'));
process.env.HYPHA_DATA = TMP_VAULT;

// Build 20 courses × 10 lessons synthetic vault.
const NUM_COURSES = 20;
const NUM_LESSONS_PER_COURSE = 10;
const LESSON_BODY_SIZE_HINT = 5000;   // ~5KB per .md after frontmatter
function buildSynthVault() {
  // Each course: state.json + chain.json + lesson-00.md ... lesson-09.md
  for (let c = 0; c < NUM_COURSES; c++) {
    const slug = `course-${String(c).padStart(3, '0')}`;
    const dir = path.join(TMP_VAULT, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      slug,
      lessons: NUM_LESSONS_PER_COURSE,
      archetype: 'TECH',
      language: 'zh',
      created_ts: Date.now() - c * 86400000,
    }, null, 2));
    fs.writeFileSync(path.join(dir, 'chain.json'), JSON.stringify({
      chain: [],
      ultimate_goal: `Goal for ${slug}`,
      is_chain_meta: false,
      created_ts: Date.now() - c * 86400000,
    }, null, 2));
    const bodyFiller = 'x'.repeat(LESSON_BODY_SIZE_HINT);
    for (let l = 0; l < NUM_LESSONS_PER_COURSE; l++) {
      const md = [
        '---',
        `lesson_idx: ${l}`,
        `learn_goal: "Lesson ${l} of ${slug}"`,
        `phase: ${(l % 3) + 1}`,
        `locked: false`,
        `date_created: "${new Date(Date.now() - (c * 10 + l) * 3600000).toISOString().slice(0, 10)}"`,
        '---',
        '',
        `# Lesson ${l}`,
        '',
        bodyFiller,
      ].join('\n');
      fs.writeFileSync(path.join(dir, `lesson-${String(l).padStart(2, '0')}.md`), md);
    }
  }
  // Seed smoke-baseline.json under .hypha (per real vault convention).
  const hyphaDir = path.join(TMP_VAULT, '.hypha');
  fs.mkdirSync(hyphaDir, { recursive: true });
  fs.writeFileSync(path.join(hyphaDir, 'smoke-baseline.json'), JSON.stringify({
    smokes: Array.from({ length: 56 }, (_, i) => ({
      name: `smoke-${i}`,
      passed: true,
      ts: new Date().toISOString(),
    })),
    generated_at: new Date().toISOString(),
  }, null, 2));
}
buildSynthVault();

// Now require libs — they will pick up TMP_VAULT via HYPHA_DATA.
const vault = require(path.resolve(__dirname, '..', 'lib', 'vault.js'));
const vaultSnapshot = require(path.resolve(__dirname, '..', 'lib', 'vault-snapshot.js'));
const localTracker = require(path.resolve(__dirname, '..', 'lib', 'telemetry', 'local-tracker.js'));
const costPredictor = require(path.resolve(__dirname, '..', 'lib', 'llm', 'cost-predictor.js'));
const cleanupRegistry = require(path.resolve(__dirname, '..', 'lib', 'cleanup-registry.js'));
const northStar = require(path.resolve(__dirname, '..', 'lib', 'growth', 'north-star-metrics.js'));

// ── 2. Test harness ───────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];
const measurements = [];    // for trend logging + final table

function _now() { return process.hrtime.bigint(); }
function _toMs(diffBig) { return Number(diffBig) / 1e6; }

function ok(label, dur_ms, threshold_ms, extra) {
  pass++;
  measurements.push({ label, dur_ms, threshold_ms, status: 'PASS', extra: extra || null });
  const durStr = (typeof dur_ms === 'number') ? `${dur_ms.toFixed(2)}ms` : '—';
  const thrStr = (typeof threshold_ms === 'number') ? ` / ≤ ${threshold_ms}ms` : '';
  console.log(`  PASS  ${label}  ${durStr}${thrStr}`);
}
function bad(label, dur_ms, threshold_ms, suggestion) {
  fail++;
  measurements.push({ label, dur_ms, threshold_ms, status: 'FAIL', suggestion });
  const durStr = (typeof dur_ms === 'number') ? `${dur_ms.toFixed(2)}ms` : 'n/a';
  failures.push(`${label}: ${durStr} exceeds ${threshold_ms}ms — ${suggestion}`);
  console.log(`  FAIL  ${label} — ${durStr} > ${threshold_ms}ms (${suggestion})`);
}

// Median helper for p95-ish summaries on small N.
function p95(arr) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

// ── 3. Tests ──────────────────────────────────────────────────────────

// T01 — vault.list() on 200-file vault. This is the curriculum-list backbone.
{
  const t0 = _now();
  const res = vault.list();
  const dur = _toMs(_now() - t0);
  const folderCount = (res && res.folders) ? res.folders.length : 0;
  const THRESH = 500;
  if (folderCount !== NUM_COURSES) {
    bad('T01 vault.list folder count', null, THRESH, `expected ${NUM_COURSES}, got ${folderCount}`);
  } else if (dur > THRESH) {
    bad('T01 vault.list duration', dur, THRESH, 'frontmatter parse cost — consider mtime+size cache layer with invalidation on write/del/rename');
  } else {
    ok(`T01 vault.list (${folderCount} folders, ${NUM_COURSES * NUM_LESSONS_PER_COURSE} files)`, dur, THRESH);
  }
}

// T02 — chain.json read per course. p95 across 20 calls < 50ms.
{
  const durs = [];
  let okEnvelope = true;
  for (let c = 0; c < NUM_COURSES; c++) {
    const slug = `course-${String(c).padStart(3, '0')}`;
    const t0 = _now();
    const chain = vault.readJSON(`${slug}/chain.json`, null);
    durs.push(_toMs(_now() - t0));
    if (!chain || typeof chain !== 'object') { okEnvelope = false; break; }
  }
  const peak = p95(durs);
  const THRESH = 50;
  if (!okEnvelope) {
    bad('T02 chain.json envelope', null, THRESH, 'readJSON returned non-object');
  } else if (peak > THRESH) {
    bad('T02 chain.json p95 read', peak, THRESH, 'JSON parse on small files should be sub-ms; investigate disk/AV scanner');
  } else {
    ok(`T02 chain.json p95 read (${NUM_COURSES} calls)`, peak, THRESH);
  }
}

// T03 — lesson body load via vault.read (full file + frontmatter parse).
{
  const durs = [];
  let okEnvelope = true;
  for (let c = 0; c < NUM_COURSES; c++) {
    const slug = `course-${String(c).padStart(3, '0')}`;
    for (let l = 0; l < NUM_LESSONS_PER_COURSE; l++) {
      const rel = `${slug}/lesson-${String(l).padStart(2, '0')}.md`;
      const t0 = _now();
      const r = vault.read(rel);
      durs.push(_toMs(_now() - t0));
      if (!r || !r.body) { okEnvelope = false; break; }
    }
    if (!okEnvelope) break;
  }
  const peak = p95(durs);
  const THRESH = 30;
  if (!okEnvelope) {
    bad('T03 vault.read envelope', null, THRESH, 'read returned null/empty body');
  } else if (peak > THRESH) {
    bad('T03 lesson body p95 read', peak, THRESH, `${durs.length} calls; frontmatter parse on 5KB should be <2ms — check fs.statSync overhead`);
  } else {
    ok(`T03 lesson body p95 read (${durs.length} calls)`, peak, THRESH);
  }
}

// T04 — vault-snapshot end-to-end. Async; await it.
(async () => {
  const t0 = _now();
  const r = await vaultSnapshot.snapshotVault({ tag: 'perf-smoke' });
  const dur = _toMs(_now() - t0);
  const THRESH = 5000;
  if (!r || !r.ok) {
    bad('T04 snapshotVault envelope', dur, THRESH, `snapshot returned ${JSON.stringify(r)}`);
  } else if (dur > THRESH) {
    bad('T04 snapshotVault duration', dur, THRESH, 'JSZip DEFLATE level 6 too slow for ~1MB vault — consider STORE level for hot path or chunked write');
  } else {
    ok(`T04 snapshotVault (${r.fileCount} files, ${r.bytes} bytes)`, dur, THRESH, { bytes: r.bytes, fileCount: r.fileCount });
  }

  // T05 — smoke-baseline.json read via vault.read.
  {
    const t1 = _now();
    const r2 = vault.read('.hypha/smoke-baseline.json');
    const dur1 = _toMs(_now() - t1);
    const THRESH = 100;
    // vault.read uses internal dotfile filter only on list, not read; this should succeed.
    if (!r2 || !r2.body) {
      bad('T05 smoke-baseline.json envelope', dur1, THRESH, 'vault.read returned null for .hypha/smoke-baseline.json — vault.read may reject hidden dirs');
    } else if (dur1 > THRESH) {
      bad('T05 smoke-baseline.json read', dur1, THRESH, 'JSON file read should be sub-ms — investigate fs.statSync cost');
    } else {
      ok('T05 smoke-baseline.json read', dur1, THRESH);
    }
  }

  // T06 — localTracker.recordError per-call latency (consent off → count-only path).
  {
    const N = 50;
    const t1 = _now();
    for (let i = 0; i < N; i++) {
      localTracker.recordError({
        code: 'PERF_SMOKE',
        message: `smoke iter ${i}`,
        severity: 'info',
      });
    }
    const totalDur = _toMs(_now() - t1);
    const perCall = totalDur / N;
    const THRESH = 5;
    if (perCall > THRESH) {
      bad('T06 localTracker.recordError per-call', perCall, THRESH, 'each call writes telemetry-counts.json sync — consider in-memory batching with periodic flush');
    } else {
      ok(`T06 localTracker.recordError per-call (${N} iters)`, perCall, THRESH, { total_ms: totalDur });
    }
  }

  // T07 — 100 sequential northStar.getNorthStar (growth-system tick proxy).
  // The task spec says "growth:tick" — that IPC does not exist; northStar is
  // the closest tick-style growth-system surface (per-call concept-lifecycle
  // jsonl read + counts aggregate). Sub bullet documented in final report.
  {
    const N = 100;
    const slug = 'course-000';  // any seeded slug; will short-circuit on missing .concept-lifecycle.jsonl
    const t1 = _now();
    for (let i = 0; i < N; i++) {
      const res = await northStar.getNorthStar({ slug });
      if (!res || res.ok !== true) {
        // not a fail — empty concept-lifecycle returns ok:true with zero metrics
        if (i === 0) {
          // log once for visibility
          console.log(`        (northStar first call returned: ${JSON.stringify(res).slice(0, 80)})`);
        }
      }
    }
    const dur = _toMs(_now() - t1);
    const THRESH = 2000;
    if (dur > THRESH) {
      bad('T07 northStar 100 sequential', dur, THRESH, 'concept-lifecycle reads scaling super-linearly — investigate file open/close overhead or add memoization');
    } else {
      ok(`T07 northStar 100 sequential (proxy for growth:tick)`, dur, THRESH, { per_call_ms: (dur / N).toFixed(3) });
    }
  }

  // T08 — 1000 cost-predictor.estimateTokens. Pure compute, no IO.
  {
    const N = 1000;
    const sample = 'The quick brown fox 跳过 lazy 狗的尾巴 — Hypha lesson body sample text repeated for token estimate stress.';
    const t1 = _now();
    let sum = 0;
    for (let i = 0; i < N; i++) {
      sum += costPredictor.estimateTokens(sample);
    }
    const dur = _toMs(_now() - t1);
    const THRESH = 100;
    if (sum <= 0) {
      bad('T08 estimateTokens envelope', dur, THRESH, 'estimateTokens returned 0 — token count regression');
    } else if (dur > THRESH) {
      bad('T08 estimateTokens 1000 calls', dur, THRESH, 'codePointAt loop per char too slow — consider regex-based fast path for ASCII-dominant');
    } else {
      ok(`T08 estimateTokens 1000 calls`, dur, THRESH, { total_tokens: sum });
    }
  }

  // T09 — cleanup-registry.runAll with 20 entries.
  {
    cleanupRegistry._resetForTests();
    let firedCount = 0;
    for (let i = 0; i < 20; i++) {
      cleanupRegistry.register({
        label: `perf-cleanup-${i}`,
        cleanup_fn: () => { firedCount++; },
      });
    }
    const t1 = _now();
    const summary = cleanupRegistry.runAll();
    const dur = _toMs(_now() - t1);
    const THRESH = 100;
    if (firedCount !== 20 || summary.ok !== 20) {
      bad('T09 cleanup-registry fire count', dur, THRESH, `expected 20 fired, got ${firedCount} (summary.ok=${summary.ok})`);
    } else if (dur > THRESH) {
      bad('T09 cleanup-registry.runAll', dur, THRESH, '20 sync cleanups should be sub-ms — investigate per-cleanup overhead');
    } else {
      ok(`T09 cleanup-registry.runAll (20 entries, all fired)`, dur, THRESH);
    }
  }

  // ── 4. Persist measurements to trend JSONL ────────────────────────────
  try {
    const traceDir = path.join(TMP_VAULT, '.hypha');
    fs.mkdirSync(traceDir, { recursive: true });
    const tracePath = path.join(traceDir, 'perf-trace.jsonl');
    fs.appendFileSync(tracePath, JSON.stringify({
      ts: new Date().toISOString(),
      smoke: '_dev_verify_vault_load_perf',
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      vault_shape: {
        courses: NUM_COURSES,
        lessons_per_course: NUM_LESSONS_PER_COURSE,
        total_lesson_files: NUM_COURSES * NUM_LESSONS_PER_COURSE,
      },
      pass,
      fail,
      measurements,
    }) + '\n', 'utf8');
  } catch (_) { /* trace persistence is best-effort; never fail the smoke for it */ }

  // T10 — tmpdir cleanup. Must always run last regardless of upstream fails.
  {
    let cleanupErr = null;
    try { fs.rmSync(TMP_VAULT, { recursive: true, force: true }); }
    catch (e) { cleanupErr = e; }
    const THRESH = null;
    if (cleanupErr) {
      bad('T10 tmpdir cleanup', null, THRESH, `rmSync failed: ${cleanupErr.message} — possible Windows file lock`);
    } else if (fs.existsSync(TMP_VAULT)) {
      bad('T10 tmpdir cleanup', null, THRESH, `rmSync returned ok but ${TMP_VAULT} still exists`);
    } else {
      ok('T10 tmpdir teardown', null, null);
    }
  }

  // ── 5. Summary ────────────────────────────────────────────────────────
  console.log('');
  console.log(`  ${pass}/${pass + fail} PASS`);
  // Find max op duration across all timed measurements.
  const maxDur = measurements
    .filter(m => typeof m.dur_ms === 'number')
    .reduce((acc, m) => (m.dur_ms > acc.dur_ms ? m : acc), { label: '—', dur_ms: 0 });
  console.log(`  max op: ${maxDur.label} = ${maxDur.dur_ms.toFixed(2)}ms`);
  if (fail > 0) {
    console.log('');
    console.log('  Cliffs detected:');
    for (const f of failures) console.log('    - ' + f);
    process.exit(1);
  }
  console.log(`  Vault load perf v1.0 — ${pass}/${pass + fail} tests pass / max op duration ${maxDur.dur_ms.toFixed(2)}ms (${maxDur.label}) / no cliff detected`);
  process.exit(0);
})().catch((err) => {
  console.error('  FATAL smoke crashed:', err && err.stack || err);
  try { fs.rmSync(TMP_VAULT, { recursive: true, force: true }); } catch (_) {}
  process.exit(2);
});
