#!/usr/bin/env node
'use strict';

// SKIP_HEADLESS — read-only gate, runs OUTSIDE the sweep (it asserts the
// LOCKED state the sweep produces; including it inside would deadlock).
// HYPHA · v1.0-rc.1 release-readiness smoke (boot-12 2026-05-20).
//
// Hard gate. If anything here fails, the release tag must not move.
// Six structural invariants we cannot ship without:
//   RR1  package.json    version  === '1.0.0-rc.1'
//   RR2  CHANGELOG.md    contains '[1.0.0-rc.1]' release-header section
//   RR3  smoke-baseline  status   === 'LOCKED'
//   RR4  smoke-baseline  failing  === 0
//   RR5  build/icon.icns exists with valid 'icns' magic bytes
//   RR6  GitHub Actions  smoke.yml / build.yml / release.yml all present
//
// Read-only — no vault writes, no LLM calls. Safe in every CI matrix cell.

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const tests = [];

function record(id, label, pass, detail) {
  tests.push({ id, label, pass, detail });
  const tag = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`[${id}] ${tag}  ${label}${detail ? ' — ' + detail : ''}`);
}

// RR1 — package.json version
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  record('RR1', "package.json version === '1.0.0-rc.1'",
    pkg.version === '1.0.0-rc.1', `version=${pkg.version}`);
} catch (e) {
  record('RR1', 'package.json readable + parses', false, e.message);
}

// RR2 — CHANGELOG section
try {
  const cl = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const has = /^##\s+\[1\.0\.0-rc\.1\]/m.test(cl);
  record('RR2', "CHANGELOG.md has '## [1.0.0-rc.1]' section",
    has, has ? 'header found' : 'header missing');
} catch (e) {
  record('RR2', 'CHANGELOG.md readable', false, e.message);
}

// RR3+RR4 — smoke baseline
try {
  const bl = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'vault', '.hypha', 'smoke-baseline.json'), 'utf8'));
  record('RR3', "smoke-baseline status === 'LOCKED'",
    bl.status === 'LOCKED', `status=${bl.status}`);
  record('RR4', 'smoke-baseline failing === 0',
    bl.failing === 0, `failing=${bl.failing} passing=${bl.passing}/${bl.total_smokes}`);
} catch (e) {
  record('RR3', 'smoke-baseline.json readable', false, e.message);
  record('RR4', 'smoke-baseline.json readable', false, e.message);
}

// RR5 — icon.icns magic
try {
  const icn = fs.readFileSync(path.join(ROOT, 'build', 'icon.icns'));
  const magic = icn.slice(0, 4).toString('ascii');
  const ok = magic === 'icns' && icn.length > 1024;
  record('RR5', "build/icon.icns exists + magic === 'icns'",
    ok, `bytes=${icn.length} magic=${magic}`);
} catch (e) {
  record('RR5', 'build/icon.icns readable', false, e.message);
}

// RR6 — workflow files
const wfDir = path.join(ROOT, '.github', 'workflows');
const wfNeeded = ['smoke.yml', 'build.yml', 'release.yml'];
const wfMissing = wfNeeded.filter(f => !fs.existsSync(path.join(wfDir, f)));
record('RR6', 'GitHub Actions workflows all present',
  wfMissing.length === 0,
  wfMissing.length ? `missing=${wfMissing.join(',')}` : `present=${wfNeeded.join(',')}`);

// Summary
const passed = tests.filter(t => t.pass).length;
const failed = tests.length - passed;
console.log('\n\x1b[2m' + '─'.repeat(52) + '\x1b[0m');
console.log(`\x1b[${failed ? '31m' : '32m'}${failed ? 'FAIL' : 'PASS'}\x1b[0m ` +
  `${passed}/${tests.length}   ` +
  `\x1b[31mFAIL\x1b[0m ${failed}   \x1b[2massertions=${tests.length}\x1b[0m`);

process.exit(failed ? 1 : 0);
