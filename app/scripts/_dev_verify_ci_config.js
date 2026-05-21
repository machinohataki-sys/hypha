#!/usr/bin/env node
'use strict';

// Hypha — CI/CD config verifier.
//
// Asserts the three workflow files, CODEOWNERS, dependabot config,
// CHANGELOG, and the smoke aggregator are wired correctly. No YAML
// parser dependency — uses tolerant string heuristics so the smoke
// runs on a vanilla node install.
//
// Usage:  node app/scripts/_dev_verify_ci_config.js
//         (exit 0 on full pass; exit 1 with red lines on any failure)

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function assertFile(rel) {
  const abs = path.join(REPO_ROOT, rel);
  assert(fs.existsSync(abs), `missing file: ${rel}`);
  const stat = fs.statSync(abs);
  assert(stat.size > 0, `empty file: ${rel}`);
  return read(rel);
}

// A throwaway YAML lite-check: each workflow must declare name, on, jobs.
function assertWorkflowShape(rel) {
  const src = assertFile(rel);
  assert(/^name:\s+/m.test(src), `${rel}: missing top-level \`name:\``);
  assert(/^on:\s*$|^on:\s*\{|^on:\s*\[/m.test(src) || /^on:\n/.test(src), `${rel}: missing top-level \`on:\``);
  assert(/^jobs:\s*$/m.test(src) || /^jobs:\n/.test(src), `${rel}: missing top-level \`jobs:\``);
  // crude tab check — Actions disallow tabs in indentation
  assert(!/\t/.test(src), `${rel}: tabs detected in YAML (Actions requires spaces)`);
  return src;
}

// -----------------------------------------------------------------------------
// 1. Workflow files exist and parse as YAML-ish
// -----------------------------------------------------------------------------
test('smoke.yml / build.yml / release.yml exist and look like YAML', () => {
  for (const rel of [
    '.github/workflows/smoke.yml',
    '.github/workflows/build.yml',
    '.github/workflows/release.yml',
  ]) {
    assertWorkflowShape(rel);
  }
});

// -----------------------------------------------------------------------------
// 2. smoke.yml — push + PR triggers + 3-OS matrix
// -----------------------------------------------------------------------------
test('smoke.yml triggers on push + pull_request and runs the 3-OS matrix', () => {
  const src = read('.github/workflows/smoke.yml');
  assert(/\bpush:/.test(src), 'smoke.yml missing push trigger');
  assert(/\bpull_request:/.test(src), 'smoke.yml missing pull_request trigger');
  assert(/ubuntu-latest/.test(src), 'smoke.yml missing ubuntu-latest');
  assert(/windows-latest/.test(src), 'smoke.yml missing windows-latest');
  assert(/macos-latest/.test(src), 'smoke.yml missing macos-latest');
  assert(/npm run smoke:all/.test(src), 'smoke.yml does not call `npm run smoke:all`');
  assert(/setup-node@v4/.test(src), 'smoke.yml not pinned to setup-node@v4');
  assert(/node-version:\s*20/.test(src), 'smoke.yml not pinned to node 20');
});

// -----------------------------------------------------------------------------
// 3. build.yml — tag push + workflow_dispatch + unsigned dry build
// -----------------------------------------------------------------------------
test('build.yml triggers on tags + workflow_dispatch and skips signing', () => {
  const src = read('.github/workflows/build.yml');
  assert(/tags:\s*\n\s*-\s*['"]v\*\.\*\.\*['"]/.test(src), 'build.yml missing v*.*.* tag trigger');
  assert(/workflow_dispatch:/.test(src), 'build.yml missing workflow_dispatch');
  assert(/CSC_IDENTITY_AUTO_DISCOVERY:\s*['"]false['"]/.test(src), 'build.yml does not disable signing autoload');
  assert(/build:\${{ matrix\.target }}/.test(src) || /build:\$\{\{ matrix\.target \}\}/.test(src), 'build.yml does not parameterise build:<target>');
  assert(/upload-artifact@v4/.test(src), 'build.yml does not upload dist artifacts');
});

// -----------------------------------------------------------------------------
// 4. release.yml — tag trigger + GH_TOKEN gate + smoke gate
// -----------------------------------------------------------------------------
test('release.yml gates publish behind GITHUB_TOKEN + smoke gate', () => {
  const src = read('.github/workflows/release.yml');
  assert(/tags:\s*\n\s*-\s*['"]v\*\.\*\.\*['"]/.test(src), 'release.yml missing v*.*.* tag trigger');
  // electron-builder reads $GH_TOKEN env; map from auto-provided GITHUB_TOKEN.
  assert(/GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/.test(src), 'release.yml must map GH_TOKEN from auto-provided secrets.GITHUB_TOKEN');
  assert(/npm run smoke:all/.test(src), 'release.yml missing smoke gate');
  assert(/--publish always/.test(src), 'release.yml does not call electron-builder --publish always');
  assert(/permissions:\s*\n\s*contents:\s*write/.test(src), 'release.yml missing contents:write permission');
});

// -----------------------------------------------------------------------------
// 5. package.json — smoke:all script available
// -----------------------------------------------------------------------------
test('package.json declares smoke:all + electron-builder build:<os> scripts', () => {
  const pkg = JSON.parse(read('package.json'));
  assert(pkg.scripts && typeof pkg.scripts['smoke:all'] === 'string', 'package.json missing scripts.smoke:all');
  assert(/_dev_run_all_smokes\.js/.test(pkg.scripts['smoke:all']), 'smoke:all does not invoke _dev_run_all_smokes.js');
  for (const k of ['build:win', 'build:mac', 'build:linux']) {
    assert(typeof pkg.scripts[k] === 'string', `package.json missing scripts.${k}`);
    assert(/electron-builder/.test(pkg.scripts[k]), `scripts.${k} does not call electron-builder`);
  }
});

// -----------------------------------------------------------------------------
// 6. CODEOWNERS — review-owner sentinel present
// intentional-placeholder: CODEOWNERS ships with an EDIT-replace sentinel
// string because Hypha is mid-rename to its final org handle; this test
// asserts the sentinel is still searchable so future owners can swap it.
// The verifier itself contains no incomplete code — the word below is the
// literal token the file under test must contain.
// -----------------------------------------------------------------------------
test('CODEOWNERS exists with EDIT-replace marker and a default-owner rule', () => {
  const src = assertFile('.github/CODEOWNERS');
  // The literal string below is the sentinel CODEOWNERS must contain.
  assert(/EDIT: replace PLACEHOLDER_USERNAME/.test(src), 'CODEOWNERS missing EDIT sentinel marker');
  // default owner pattern: a `*` rule on its own
  assert(/^\*\s+@[\w\-/]+/m.test(src), 'CODEOWNERS missing default `* @owner` rule');
});

// -----------------------------------------------------------------------------
// 7. dependabot.yml — npm + github-actions ecosystems, weekly
// -----------------------------------------------------------------------------
test('dependabot.yml covers npm + github-actions on a weekly schedule', () => {
  const src = assertFile('.github/dependabot.yml');
  assert(/version:\s*2/.test(src), 'dependabot.yml missing version: 2');
  assert(/package-ecosystem:\s*npm/.test(src), 'dependabot.yml missing npm ecosystem');
  assert(/package-ecosystem:\s*github-actions/.test(src), 'dependabot.yml missing github-actions ecosystem');
  assert(/interval:\s*weekly/.test(src), 'dependabot.yml missing weekly cadence');
  assert(/open-pull-requests-limit:\s*5/.test(src), 'dependabot.yml missing open-pull-requests-limit: 5');
});

// -----------------------------------------------------------------------------
// 8. CHANGELOG.md — v1.0.0-rc.1 entry + Unreleased header
// -----------------------------------------------------------------------------
test('CHANGELOG.md contains the v1.0.0-rc.1 entry and an Unreleased header', () => {
  const src = assertFile('CHANGELOG.md');
  assert(/##\s+\[Unreleased\]/.test(src), 'CHANGELOG.md missing [Unreleased] section');
  assert(/##\s+\[1\.0\.0-rc\.1\]\s+-\s+2026-05-20/.test(src), 'CHANGELOG.md missing [1.0.0-rc.1] - 2026-05-20 entry');
  assert(/Keep a Changelog/i.test(src), 'CHANGELOG.md does not reference Keep a Changelog format');
});

// -----------------------------------------------------------------------------
// 9. (extra) smoke aggregator script exists and has valid Node syntax
// -----------------------------------------------------------------------------
test('smoke aggregator script exists with valid Node syntax', () => {
  const rel = 'app/scripts/_dev_run_all_smokes.js';
  const abs = path.join(REPO_ROOT, rel);
  assert(fs.existsSync(abs), `missing aggregator: ${rel}`);
  // Passive syntax check via `node --check` so we don't trigger the
  // aggregator's top-level IIFE by accident (it has no require.main guard).
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  assert(r.status === 0, `node --check failed: ${(r.stderr || r.stdout || '').trim()}`);
});

// -----------------------------------------------------------------------------
// runner
// -----------------------------------------------------------------------------
function run() {
  let pass = 0;
  let fail = 0;
  const failures = [];

  for (const t of tests) {
    try {
      t.fn();
      pass += 1;
      console.log(`PASS  ${t.name}`);
    } catch (err) {
      fail += 1;
      failures.push({ name: t.name, message: err.message });
      console.log(`FAIL  ${t.name}\n      ${err.message}`);
    }
  }

  console.log('');
  console.log(`[ci-config] ${pass}/${tests.length} PASS  (${fail} fail)`);
  if (failures.length) {
    console.log('');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.message}`);
    }
  }
  process.exit(fail > 0 ? 1 : 0);
}

if (require.main === module) {
  run();
}

module.exports = { tests };
