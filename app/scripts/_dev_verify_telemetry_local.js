#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_telemetry_local — smoke for v1.0 boot-7 local-first
// telemetry tracker (app/lib/telemetry/local-tracker.js).
//
// 11 tests:
//   TL1  recordError appends to JSONL when consent=true
//   TL2  recordError without consent only bumps counts (no payload line)
//   TL3  Anonymization: vault root in stack → "<vault>/..."
//   TL4  Anonymization: home dir in stack → "<home>/..."
//   TL5  Anonymization: Chinese-quoted user content → "<redacted>"
//   TL6  exportForBugReport returns expected shape
//   TL7  pruneOld removes entries beyond keep_days
//   TL8  computeHealthScore monotonic with error count
//   TL9  Regression: recordError MUST NOT throw on missing dir / bad input
//   TL10 Regression: no fetch/http/XMLHttpRequest call attempted (static lib audit)
//   TL11 Counts file structure: error_total + by_severity + by_code
//
// Run:
//   node app/scripts/_dev_verify_telemetry_local.js
//
// Exit 0 = PASS, Exit 1 = any fail.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Isolate vault to a tmp dir so the smoke can't pollute the real vault and is
// fully deterministic.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-telem-'));
fs.mkdirSync(path.join(TMP_ROOT, 'data'), { recursive: true });
process.env.HYPHA_DATA = TMP_ROOT;

// Helper — drop tracker module cache between consent flips so consent gate is
// re-read fresh (real runtime reads consent per call, but we also test cache).
function freshTracker() {
  const trackerPath = path.join(__dirname, '..', 'lib', 'telemetry', 'local-tracker.js');
  delete require.cache[require.resolve(trackerPath)];
  return require(trackerPath);
}

function writeConsent(consent) {
  const p = path.join(TMP_ROOT, 'data', 'profile.json');
  fs.writeFileSync(p, JSON.stringify({ telemetry_consent: !!consent }), 'utf8');
}

function cleanFiles() {
  const dir = path.join(TMP_ROOT, '.hypha');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
  }
}

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`);
  }
}

function readJsonl(file) {
  const p = path.join(TMP_ROOT, '.hypha', file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_) { return null; }
  }).filter(Boolean);
}

console.log('\n[telemetry-local smoke]');
console.log('  TMP vault:', TMP_ROOT);

// ── TL1: recordError with consent appends a JSONL line ─────────────────
(function TL1() {
  cleanFiles();
  writeConsent(true);
  const tracker = freshTracker();
  const r = tracker.recordError({
    code: 'test_err',
    message: 'failed something',
    severity: 'error',
    stack: 'Error: x\n    at fn (file.js:1:1)',
  });
  const lines = readJsonl('local-errors.jsonl');
  check(
    'TL1 recordError appends to JSONL when consent=true',
    r.ok && r.recorded === 'full' && lines.length === 1 && lines[0].code === 'test_err',
    `r=${JSON.stringify(r)} lines=${lines.length}`
  );
})();

// ── TL2: recordError without consent → count_only ──────────────────────
(function TL2() {
  cleanFiles();
  writeConsent(false);
  const tracker = freshTracker();
  const r = tracker.recordError({ code: 'no_consent', message: 'x', severity: 'error' });
  const lines = readJsonl('local-errors.jsonl');
  const counts = tracker._internal._readCounts();
  check(
    'TL2 recordError without consent only bumps counts (no payload)',
    r.ok && r.recorded === 'count_only' &&
      lines.length === 0 &&
      counts.error_total === 1 &&
      counts.by_code && counts.by_code.no_consent === 1,
    `r=${JSON.stringify(r)} lines=${lines.length} counts=${JSON.stringify(counts)}`
  );
})();

// ── TL3: vault path in stack → "<vault>/..." ───────────────────────────
(function TL3() {
  cleanFiles();
  writeConsent(true);
  const tracker = freshTracker();
  const vroot = TMP_ROOT;
  const fakeStack = `Error: enoent\n    at fn (${vroot}${path.sep}lessons${path.sep}deep.md:5:2)`;
  tracker.recordError({ code: 'scrub_v', message: 'x', severity: 'error', stack: fakeStack });
  const lines = readJsonl('local-errors.jsonl');
  const stack = lines[0] && lines[0].stack;
  const hasVault = stack && stack.indexOf('<vault>') !== -1;
  const hasRaw = stack && stack.indexOf(vroot) !== -1;
  check(
    'TL3 vault path in stack is scrubbed to <vault>/...',
    hasVault && !hasRaw,
    `stack=${stack}`
  );
})();

// ── TL4: home dir in stack → "<home>/..." ──────────────────────────────
(function TL4() {
  cleanFiles();
  writeConsent(true);
  const tracker = freshTracker();
  const home = os.homedir();
  const fakeStack = `Error\n    at fn (${home}${path.sep}private${path.sep}thing.js:1:1)`;
  tracker.recordError({ code: 'scrub_h', message: 'x', severity: 'error', stack: fakeStack });
  const lines = readJsonl('local-errors.jsonl');
  const stack = lines[0] && lines[0].stack;
  // Either <home> appears, OR the path was absolute-path-collapsed to <path>/<last2>.
  // Both are acceptable scrub outcomes; raw home dir MUST NOT appear.
  const hasRawHome = stack && stack.indexOf(home) !== -1;
  check(
    'TL4 home dir in stack is anonymized (no raw home leak)',
    stack && !hasRawHome,
    `stack=${stack}`
  );
})();

// ── TL5: Chinese-quoted user content → "<redacted>" ────────────────────
(function TL5() {
  cleanFiles();
  writeConsent(true);
  const tracker = freshTracker();
  const msg = '解析失败 “这是用户写的一段很长的笔记内容不该被记下来” 在第 3 行';
  tracker.recordError({ code: 'scrub_msg', message: msg, severity: 'error' });
  const lines = readJsonl('local-errors.jsonl');
  const stored = lines[0] && lines[0].message;
  // Quoted block scrubbed AND/OR long Han run scrubbed. We accept either path.
  const noRawNote = stored && stored.indexOf('这是用户写的一段很长的笔记内容不该被记下来') === -1;
  const hasRedacted = stored && stored.indexOf('<redacted>') !== -1;
  check(
    'TL5 Chinese-quoted user content scrubbed to <redacted>',
    noRawNote && hasRedacted,
    `stored=${stored}`
  );
})();

// ── TL6: exportForBugReport returns expected shape ─────────────────────
(function TL6() {
  cleanFiles();
  writeConsent(true);
  const tracker = freshTracker();
  tracker.recordError({ code: 'shape', message: 'x', severity: 'warn' });
  tracker.recordEvent({ type: 'startup', payload: { ms: 120 } });
  const r = tracker.exportForBugReport({ errorLimit: 10, eventLimit: 10 });
  const hasFields =
    r &&
    r.schema === 'hypha-local-bug-report-v1' &&
    typeof r.generated_at === 'string' &&
    typeof r.consent === 'boolean' &&
    r.sys && typeof r.sys.os === 'string' &&
    typeof r.health === 'number' &&
    r.counts && typeof r.counts.error_total === 'number' &&
    Array.isArray(r.errors) && r.errors.length >= 1 &&
    Array.isArray(r.events) && r.events.length >= 1;
  check(
    'TL6 exportForBugReport returns expected shape',
    hasFields,
    `r=${JSON.stringify(r).slice(0, 200)}`
  );
})();

// ── TL7: pruneOld removes entries beyond keep_days ─────────────────────
(function TL7() {
  cleanFiles();
  writeConsent(true);
  const tracker = freshTracker();
  // Hand-craft 2 lines: one old, one fresh.
  const errPath = path.join(TMP_ROOT, '.hypha', 'local-errors.jsonl');
  fs.mkdirSync(path.dirname(errPath), { recursive: true });
  const oldTs = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const newTs = Date.now();
  fs.writeFileSync(errPath, [
    JSON.stringify({ ts: oldTs, code: 'old', severity: 'info' }),
    JSON.stringify({ ts: newTs, code: 'new', severity: 'info' }),
  ].join('\n') + '\n', 'utf8');
  const r = tracker.pruneOld({ keep_days: 30 });
  const lines = readJsonl('local-errors.jsonl');
  check(
    'TL7 pruneOld removes entries beyond keep_days',
    r.ok && r.pruned === 1 && lines.length === 1 && lines[0].code === 'new',
    `r=${JSON.stringify(r)} lines=${lines.length}`
  );
})();

// ── TL8: computeHealthScore monotonic with error count ─────────────────
(function TL8() {
  cleanFiles();
  writeConsent(true);
  // Reset counts file.
  const countsPath = path.join(TMP_ROOT, '.hypha', 'telemetry-counts.json');
  fs.writeFileSync(countsPath, JSON.stringify({ error_total: 0, by_severity: {}, by_code: {}, last_ts: Date.now() }), 'utf8');
  const tracker = freshTracker();
  const h0 = tracker.computeHealthScore();
  for (let i = 0; i < 5; i++) tracker.recordError({ code: 'h_test', message: 'x', severity: 'error' });
  const h1 = tracker.computeHealthScore();
  for (let i = 0; i < 5; i++) tracker.recordError({ code: 'h_test', message: 'x', severity: 'fatal' });
  const h2 = tracker.computeHealthScore();
  check(
    'TL8 computeHealthScore monotonic decreasing with error count',
    h0 >= h1 && h1 >= h2 && h0 <= 1.0 && h2 >= 0.0,
    `h0=${h0} h1=${h1} h2=${h2}`
  );
})();

// ── TL9: recordError MUST NOT throw on bad input ────────────────────────
(function TL9() {
  cleanFiles();
  writeConsent(true);
  const tracker = freshTracker();
  let threw = false;
  try {
    tracker.recordError(null);
    tracker.recordError(undefined);
    tracker.recordError({});
    tracker.recordError({ severity: 'bogus-severity-not-in-enum' });
  } catch (e) {
    threw = true;
  }
  check(
    'TL9 recordError does not throw on bad/missing input (must not destabilize caller)',
    !threw,
    threw ? 'threw' : 'did not throw'
  );
})();

// ── TL10: static audit — no network primitives in tracker source ───────
(function TL10() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'telemetry', 'local-tracker.js'),
    'utf8'
  );
  // Strip comments to avoid false-positives from docstrings.
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '');
  const bannedTokens = [
    'fetch(',
    'XMLHttpRequest',
    'http.request(',
    'https.request(',
    "require('node:http')",
    "require('node:https')",
    "require('http')",
    "require('https')",
    "require('axios')",
    "require('node-fetch')",
    "require('undici')",
  ];
  const hit = bannedTokens.filter((tok) => stripped.indexOf(tok) !== -1);
  check(
    'TL10 tracker source contains no network primitives (fetch/http/https/etc.)',
    hit.length === 0,
    hit.length ? `banned=${hit.join(', ')}` : ''
  );
})();

// ── TL11: counts file structure ────────────────────────────────────────
(function TL11() {
  cleanFiles();
  writeConsent(false);
  const tracker = freshTracker();
  tracker.recordError({ code: 'c_a', severity: 'warn' });
  tracker.recordError({ code: 'c_b', severity: 'error' });
  tracker.recordError({ code: 'c_a', severity: 'fatal' });
  const counts = tracker._internal._readCounts();
  const ok =
    counts.error_total === 3 &&
    counts.by_severity.warn === 1 &&
    counts.by_severity.error === 1 &&
    counts.by_severity.fatal === 1 &&
    counts.by_code.c_a === 2 &&
    counts.by_code.c_b === 1;
  check(
    'TL11 counts file: error_total + by_severity + by_code structured correctly',
    ok,
    `counts=${JSON.stringify(counts)}`
  );
})();

// ── Summary ────────────────────────────────────────────────────────────
const total = pass + fail;
console.log(`\n[telemetry-local smoke] ${pass}/${total} PASS`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}${f.detail ? '  -- ' + f.detail : ''}`);
  process.exit(1);
}

// Clean up tmp dir (best-effort; OS will handle leftovers).
try {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
} catch (_) {}

process.exit(0);
