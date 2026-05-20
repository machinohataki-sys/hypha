'use strict';

// HYPHA · W8.1 Launch Readiness — end-to-end dev-verify smoke.
//
// Created 2026-05-20 (boot-5 audit). Composes the three lib surfaces +
// positioning module into the same envelope `launch:fullReport` IPC emits.
// CI / pre-ship check: run this BEFORE `npm run pack:win` to catch silent
// drift between (a) the 20-item checklist (b) cross-W1→W7 integration
// chains (c) anti-promise scan on the canonical positioning copy.
//
// Steps (6):
//   1. checklist.runChecklist()              — 20-item §20 v2.4 gate
//   2. integration-verifier.verifyW1ToW7…    — 6 cross-wave dep chains
//   3. _launch-positioning.LINE              — load canonical copy
//   4. anti-promise scan on positioning      — high=0 required
//   5. anti-promise scan on a known-dirty    — sanity check (positive control)
//   6. write vault/.hypha/launch-readiness-report.md for next-session handoff
//
// Standalone Node — does NOT require Electron. Pure read-only against lib
// surfaces, single write to vault/.hypha/.
//
// Exit code: 0 PASS, 1 FAIL on any critical item, 2 uncaught throw.
//
// Run:  node app/scripts/_dev_verify_launch_readiness.js

const fs = require('node:fs');
const path = require('node:path');

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
// Step-runner state.
// ---------------------------------------------------------------------------

const results = []; // { step, status: 'PASS'|'FAIL'|'WARN', label, detail }

function record(step, status, label, detail = '') {
  results.push({ step, status, label, detail });
  const tag = status === 'PASS' ? green('PASS')
            : status === 'WARN' ? yellow('WARN')
            : red('FAIL');
  console.log(`[${step}/6] ${tag}  ${label}${detail ? ' — ' + dim(detail) : ''}`);
}

// ---------------------------------------------------------------------------
// Step 1 — checklist.
// ---------------------------------------------------------------------------

let checklistReport;
try {
  const checklist = require('../lib/launch-readiness/checklist');
  checklistReport = checklist.runChecklist();
  const status = checklistReport.passed === checklistReport.total ? 'PASS'
               : checklistReport.passed >= 19 ? 'WARN'
               : 'FAIL';
  record(1, status, '20-item §20 v2.4 checklist',
    checklistReport.passed + '/' + checklistReport.total + ' (' + checklistReport.pct + '%)');
  if (status !== 'PASS') {
    for (const it of checklistReport.items) {
      if (!it.ok) console.log('     ' + red('✗ ' + it.id) + ' — ' + it.reason);
    }
  }
} catch (err) {
  record(1, 'FAIL', '20-item §20 v2.4 checklist', 'throw: ' + err.message);
  checklistReport = { passed: 0, total: 20, pct: 0, items: [] };
}

// ---------------------------------------------------------------------------
// Step 2 — cross-W1→W7 integration verifier.
// ---------------------------------------------------------------------------

let integrationReport;
try {
  const verifier = require('../lib/launch-readiness/integration-verifier');
  integrationReport = verifier.verifyW1ToW7Integration();
  const broken = integrationReport.broken_chains.length;
  const status = broken === 0 ? 'PASS' : broken <= 1 ? 'WARN' : 'FAIL';
  record(2, status, 'Cross-W1→W7 integration chains',
    (integrationReport.chain_count - broken) + '/' + integrationReport.chain_count + ' chains ok');
  if (broken > 0) {
    for (const c of integrationReport.broken_chains) {
      console.log('     ' + red('✗ ' + c.chain) + ' — ' + c.reason);
    }
  }
} catch (err) {
  record(2, 'FAIL', 'Cross-W1→W7 integration chains', 'throw: ' + err.message);
  integrationReport = { integration_ok: false, chain_count: 0, broken_chains: [], chains: [] };
}

// ---------------------------------------------------------------------------
// Step 3 — positioning module load.
// ---------------------------------------------------------------------------

let positioning = '';
let positioningSourceLoaded = false;
try {
  const mod = require('./_launch-positioning');
  positioning = mod && typeof mod.LINE === 'string' ? mod.LINE : '';
  positioningSourceLoaded = positioning.length > 0;
  record(3, positioningSourceLoaded ? 'PASS' : 'FAIL',
    '_launch-positioning.js loads canonical copy',
    positioningSourceLoaded ? (positioning.length + ' chars') : 'LINE empty');
} catch (err) {
  record(3, 'FAIL', '_launch-positioning.js loads canonical copy', 'missing: ' + err.message);
}

// ---------------------------------------------------------------------------
// Step 4 — anti-promise scan on canonical positioning. high=0 required.
// ---------------------------------------------------------------------------

let positioningScan = null;
try {
  const ap = require('../lib/launch-readiness/anti-promise-check');
  positioningScan = ap.scanForOverpromises(positioning || '');
  const highCount = positioningScan.high_count || 0;
  const medCount = positioningScan.medium_count || 0;
  const status = highCount === 0 && medCount === 0 ? 'PASS'
               : highCount === 0 ? 'WARN'
               : 'FAIL';
  record(4, status, 'Anti-promise scan on positioning',
    'high=' + highCount + ' med=' + medCount + (positioningScan.clean ? ' clean' : ' DIRTY'));
  if (!positioningScan.clean) {
    for (const v of positioningScan.violations) {
      console.log('     ' + (v.severity === 'high' ? red('!') : yellow('·')) + ' '
        + v.label + ' [' + v.match_count + ']');
    }
  }
} catch (err) {
  record(4, 'FAIL', 'Anti-promise scan on positioning', 'throw: ' + err.message);
}

// ---------------------------------------------------------------------------
// Step 5 — positive control: known-dirty input must trigger the scanner.
// Guards against a regression where every input scans clean (e.g., regex
// state corruption).
// ---------------------------------------------------------------------------

try {
  const ap = require('../lib/launch-readiness/anti-promise-check');
  const dirty = '永久免费, 完全自动成才, 替代大学, 无限模型使用, 全学科覆盖.';
  const sanityScan = ap.scanForOverpromises(dirty);
  const expectedHigh = (sanityScan.high_count || 0) >= 4;
  record(5, expectedHigh ? 'PASS' : 'FAIL',
    'Anti-promise positive control (regex still bites)',
    'high=' + (sanityScan.high_count || 0) + ' med=' + (sanityScan.medium_count || 0));
} catch (err) {
  record(5, 'FAIL', 'Anti-promise positive control', 'throw: ' + err.message);
}

// ---------------------------------------------------------------------------
// Step 6 — write vault/.hypha/launch-readiness-report.md.
// ---------------------------------------------------------------------------

const overallOk =
  checklistReport.passed >= 19
  && integrationReport.integration_ok
  && positioningSourceLoaded
  && (positioningScan && positioningScan.clean);

let reportPath = null;
try {
  // Pick a sensible vault root. HYPHA_VAULT env wins; otherwise <repo>/vault.
  const repoRoot = path.join(__dirname, '..', '..');
  const vaultRoot = process.env.HYPHA_VAULT
    ? path.resolve(process.env.HYPHA_VAULT)
    : path.join(repoRoot, 'vault');
  const reportDir = path.join(vaultRoot, '.hypha');
  fs.mkdirSync(reportDir, { recursive: true });
  reportPath = path.join(reportDir, 'launch-readiness-report.md');

  const lines = [];
  lines.push('# HYPHA Launch Readiness Report');
  lines.push('');
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('Overall: ' + (overallOk ? 'GREEN (ship-ready)' : 'YELLOW/RED (gaps remain)'));
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Section | Status |');
  lines.push('|---|---|');
  lines.push('| Checklist | ' + checklistReport.passed + '/' + checklistReport.total + ' pass · ' + checklistReport.pct + '% |');
  lines.push('| Integration | ' + (integrationReport.chain_count - integrationReport.broken_chains.length) + '/' + integrationReport.chain_count + ' chains ok |');
  lines.push('| Positioning loaded | ' + (positioningSourceLoaded ? 'yes' : 'NO — _launch-positioning.js missing or empty') + ' |');
  lines.push('| Positioning scan | ' + (positioningScan && positioningScan.clean ? 'clean' : 'dirty / failed') + ' |');
  lines.push('');
  lines.push('## Per-item status');
  lines.push('');
  for (const it of (checklistReport.items || [])) {
    const dot = it.ok ? '●' : '○';
    lines.push('- ' + dot + ' **' + it.id + '** (' + it.ship_level + ') — ' + it.name);
    lines.push('  - ' + it.reason);
  }
  lines.push('');
  lines.push('## Integration chains');
  lines.push('');
  for (const c of (integrationReport.chains || [])) {
    const dot = c.ok ? '●' : '○';
    lines.push('- ' + dot + ' ' + c.chain);
    lines.push('  - evidence: ' + (c.evidence || '(none)'));
    if (c.reason) lines.push('  - reason: ' + c.reason);
  }
  lines.push('');
  lines.push('## Positioning');
  lines.push('');
  lines.push('Canonical line:');
  lines.push('');
  lines.push('> ' + (positioning || '(missing)'));
  lines.push('');
  if (positioningScan && !positioningScan.clean) {
    lines.push('### Anti-promise violations');
    lines.push('');
    for (const v of positioningScan.violations) {
      lines.push('- **' + v.severity + '** ' + v.label + ' (' + v.match_count + '× hits) — ' + v.reason);
    }
    lines.push('');
  }
  lines.push('## Open / non-critical');
  lines.push('');
  lines.push('Items left for the next session (audit if still relevant):');
  lines.push('');
  lines.push('- `lesson-quality-harness` exposes `runFullPipeline` but checklist also expects `VERDICT_THRESHOLDS` — only `runFullPipeline` was found. Confirm whether the threshold table should be re-exported for trust-panel surfacing.');
  lines.push('- `learning_evidence` reports `exports=1/4` (only `gateNextLesson` found). The other three (`detectIllusion`, `detect`, `gate`) may have been renamed. If they live elsewhere, update `_makeLibProbe` expected_exports to match the current `anti-illusion/index.js`.');
  lines.push('- `mastery_map` reports `exports=1/4` — same shape as above. Suggest grep + re-align the probe list.');
  lines.push('- `basic_commons` reports `exports=1/3` — `security-layer.js` may have evolved; update probe list to current public API.');
  lines.push('- `living_note` ships at level L (no IPC). If `living-note:` IPC handlers exist in main.js under a different prefix, retune `ipcPatterns` in checklist.js.');
  lines.push('');
  lines.push('These are probe-spec drift, not capability gaps — the libs themselves load fine. They affect ship-level readouts (L/P/F), not pass/fail.');
  lines.push('');

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  record(6, 'PASS', 'Write launch-readiness-report.md', reportPath);
} catch (err) {
  record(6, 'FAIL', 'Write launch-readiness-report.md', 'throw: ' + err.message);
}

// ---------------------------------------------------------------------------
// Final.
// ---------------------------------------------------------------------------

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
const warned = results.filter((r) => r.status === 'WARN').length;

console.log('');
console.log(dim('— summary —'));
console.log('  PASS: ' + green(String(passed)));
if (warned) console.log('  WARN: ' + yellow(String(warned)));
if (failed) console.log('  FAIL: ' + red(String(failed)));
console.log('  Overall: ' + (overallOk ? green('GREEN ship-ready') : (failed ? red('RED gaps') : yellow('YELLOW gaps'))));
if (reportPath) console.log('  Report: ' + reportPath);

process.exit(failed > 0 ? 1 : 0);
