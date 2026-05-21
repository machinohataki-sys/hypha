#!/usr/bin/env node
// intentional-placeholder: the word "placeholder" appears in the icon-icns
// advisory (T3) test name + detail strings. icon.icns is intentionally not
// generated in this slice — boot-8 task explicitly scopes binary icon
// generation to a separate task with image tooling (per build/README.md +
// build/icon.placeholder.txt manifest). This verifier reports presence as
// an advisory, never failing the smoke when icon.icns is absent. Users
// generate the real .icns via build/icon-build.sh (mac/linux iconutil) or
// build/icon-build.ps1 (Windows via electron-icon-builder). The verifier's
// job is to confirm the build CHAIN is wireable, not to ship binary art.
/**
 * _dev_verify_build_dry_run.js
 *
 * Pack dry-run smoke for electron-builder config + build resources.
 * Companion to _dev_verify_build_config.js: where build_config validates
 * the JSON shape, this validates the runtime preconditions of an actual
 * `electron-builder --dir` invocation without launching one.
 *
 * Never runs electron-builder. Never downloads. Read-only.
 *
 * Usage: node app/scripts/_dev_verify_build_dry_run.js
 * Exit: 0 if all pass, 1 if any fail.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const BUILD_DIR = path.join(ROOT, 'build');
const APP_DIR = path.join(ROOT, 'app');
const NODE_MODULES = path.join(ROOT, 'node_modules');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  const line = detail ? ` — ${detail}` : '';
  console.log(`[${tag}] ${name}${line}`);
}

function tryRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch (_err) { return null; }
}

function isValidPngFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 64) return { ok: false, why: 'file too small' };
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8);
    fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    const sigOk = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E
      && buf[3] === 0x47 && buf[4] === 0x0D && buf[5] === 0x0A
      && buf[6] === 0x1A && buf[7] === 0x0A;
    return { ok: sigOk, why: sigOk ? `${stat.size} bytes` : 'bad PNG signature' };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

function isValidIcoFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 64) return { ok: false, why: 'file too small' };
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(6);
    fs.readSync(fd, buf, 0, 6, 0);
    fs.closeSync(fd);
    // ICO: reserved=0 (2B), type=1 (2B), count>0 (2B)
    const okSig = buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1;
    const count = buf.readUInt16LE(4);
    const ok = okSig && count > 0 && count < 256;
    return { ok, why: ok ? `${stat.size} bytes, ${count} entries` : 'bad ICO header' };
  } catch (err) {
    return { ok: false, why: err.message };
  }
}

// --- Load package.json
let pkg = null;
const pkgRaw = tryRead(PKG_PATH);
try { pkg = JSON.parse(pkgRaw); } catch (_err) { /* handled below */ }

if (!pkg) {
  record('Bootstrap package.json parseable', false, 'cannot parse package.json');
  process.exit(1);
}
record('Bootstrap package.json parseable', true, `version=${pkg.version}`);

// --- T1: build config completeness (separate from build_config — checks runtime preconditions)
{
  const b = pkg.build || {};
  const okShape = b.appId && b.productName && Array.isArray(b.files)
    && b.directories && b.directories.output === 'dist'
    && b.directories.buildResources === 'build'
    && typeof b.asar === 'boolean';
  record('T1 build config runtime preconditions', okShape,
    okShape
      ? `output=${b.directories.output}, buildResources=${b.directories.buildResources}`
      : 'directories/asar/required fields missing');
}

// --- T2: required build/ resources exist + are valid for their platform
{
  const entitlements = path.join(BUILD_DIR, 'entitlements.mac.plist');
  const iconPng = path.join(BUILD_DIR, 'icon.png');
  const iconIco = path.join(BUILD_DIR, 'icon.ico');
  const eOk = fs.existsSync(entitlements);
  const pngCheck = isValidPngFile(iconPng);
  const icoCheck = isValidIcoFile(iconIco);
  const ok = eOk && pngCheck.ok && icoCheck.ok;
  const detail = `entitlements=${eOk} png=${pngCheck.ok}(${pngCheck.why}) ico=${icoCheck.ok}(${icoCheck.why})`;
  record('T2 build/ resources present + valid', ok, detail);
}

// --- T3: icon.icns presence advisory (does NOT fail — macOS-only, opt-in)
{
  const icns = path.join(BUILD_DIR, 'icon.icns');
  const present = fs.existsSync(icns);
  // PASS either way — this is a status report, not a gate.
  record('T3 icon.icns status (advisory)', true,
    present ? 'present' : 'MISSING (macOS DMG will fall back; run build/icon-build.sh or .ps1)');
}

// --- T4: electron-builder declared in devDependencies (NOT required to be installed)
{
  const declared = !!(pkg.devDependencies && pkg.devDependencies['electron-builder']);
  const installed = fs.existsSync(path.join(NODE_MODULES, 'electron-builder'))
    || fs.existsSync(path.join(NODE_MODULES, 'app-builder-lib'));
  record('T4 electron-builder declared (install optional)', declared,
    declared
      ? `electron-builder@${pkg.devDependencies['electron-builder']} ${installed ? '(installed)' : '(declared, not installed)'}`
      : 'devDependencies.electron-builder missing');
}

// --- T5: files inclusion + exclusion rules
{
  const files = (pkg.build && pkg.build.files) || [];
  const hasAppGlob = files.some(p => p === 'app/**/*' || p.startsWith('app/'));
  const hasPkg = files.includes('package.json');
  const excludesDevVerify = files.some(p => p.startsWith('!') && p.includes('_dev_verify'));
  const excludesTests = files.some(p => p.startsWith('!') && p.includes('__tests__'));
  const excludesMaps = files.some(p => p.startsWith('!') && p.includes('.map'));
  const ok = hasAppGlob && hasPkg && excludesDevVerify && excludesTests && excludesMaps;
  record('T5 files inclusion/exclusion shape', ok,
    `app=${hasAppGlob} pkg=${hasPkg} -devVerify=${excludesDevVerify} -tests=${excludesTests} -maps=${excludesMaps}`);
}

// --- T6: asarUnpack paths reachable OR explicitly nil
{
  const unpack = (pkg.build && pkg.build.asarUnpack) || [];
  const checks = unpack.map(globExpr => {
    // Strip trailing /** or /**/* and check the directory above exists OR is allowed-empty.
    // We allow non-existent unpack targets — electron-builder treats them as no-op.
    const dirPart = globExpr.replace(/\/\*\*.*$/, '').replace(/\*+/g, '');
    const abs = path.join(ROOT, dirPart);
    const exists = fs.existsSync(abs);
    return { glob: globExpr, exists };
  });
  const allOk = checks.every(c => c.exists || c.glob.includes('native'));
  const detail = checks.map(c => `${c.glob}(${c.exists ? 'exists' : 'absent-ok'})`).join(', ');
  record('T6 asarUnpack paths reachable or no-op', allOk, detail || 'no asarUnpack rules');
}

// --- T7: dev-verify scripts NOT shipped — confirm at least one matching file would be excluded
{
  const files = (pkg.build && pkg.build.files) || [];
  const exclusionPatterns = files.filter(p => p.startsWith('!'));
  // Walk app/scripts/ and confirm _dev_verify_*.js exist (and would be excluded)
  let devVerifyCount = 0;
  try {
    const entries = fs.readdirSync(path.join(APP_DIR, 'scripts'));
    devVerifyCount = entries.filter(f => f.startsWith('_dev_verify_') && f.endsWith('.js')).length;
  } catch (_err) {
    devVerifyCount = 0;
  }
  const hasExcludeRule = exclusionPatterns.some(p => p.includes('_dev_verify'));
  const ok = hasExcludeRule && devVerifyCount > 0;
  record('T7 _dev_verify_*.js present in source + excluded from build', ok,
    `count=${devVerifyCount}, excludePattern=${hasExcludeRule}`);
}

// --- T8: entitlements.mac.plist references match build.mac.entitlements path
{
  const macCfg = (pkg.build && pkg.build.mac) || {};
  const declaredPath = macCfg.entitlements;
  const inheritPath = macCfg.entitlementsInherit;
  const abs = declaredPath ? path.join(ROOT, declaredPath) : null;
  const exists = abs && fs.existsSync(abs);
  const matchInherit = !inheritPath || inheritPath === declaredPath;
  const ok = !!declaredPath && exists && matchInherit;
  record('T8 mac.entitlements path resolves + matches inherit', ok,
    `path=${declaredPath || 'unset'}, exists=${exists}, inheritMatch=${matchInherit}`);
}

// --- T9: native deps — none expected (pure JS, native dirs are placeholders)
{
  // Check that asarUnpack only references companion/native (the spec'd native staging dir),
  // and that no unexpected .node binaries are committed in app/.
  const unpack = (pkg.build && pkg.build.asarUnpack) || [];
  const expectedOnly = unpack.every(p => p.startsWith('app/lib/companion/native/'));
  let nodeBinaries = 0;
  function walk(dir, depth = 0) {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_err) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const sub = path.join(dir, e.name);
      if (e.isDirectory()) walk(sub, depth + 1);
      else if (e.name.endsWith('.node')) nodeBinaries++;
    }
  }
  walk(APP_DIR);
  const ok = expectedOnly && nodeBinaries === 0;
  record('T9 no unexpected native binaries shipped in app/', ok,
    `unpack=${unpack.length} entry(ies), .node count=${nodeBinaries}`);
}

// --- T10: publish channel shape — provider/owner/repo all strings
{
  const publish = (pkg.build && pkg.build.publish) || [];
  const ok = Array.isArray(publish) && publish.length >= 1
    && publish[0].provider === 'github'
    && typeof publish[0].owner === 'string' && publish[0].owner.length > 0
    && typeof publish[0].repo === 'string' && publish[0].repo.length > 0;
  record('T10 publish channel shape', ok,
    ok ? `${publish[0].provider}:${publish[0].owner}/${publish[0].repo}` : 'publish[0] malformed or missing');
}

// --- T11: electron-builder config lazy-parseable when installed (skip when absent)
{
  const builderDir = path.join(NODE_MODULES, 'app-builder-lib');
  if (!fs.existsSync(builderDir)) {
    record('T11 electron-builder lazy parse (skip if uninstalled)', true,
      'app-builder-lib not installed — skip (run npm install to enable)');
  } else {
    // Don't actually call into it (avoids side effects). Just confirm the
    // package's package.json reads cleanly + main entry exists.
    let ok = false;
    let detail = '';
    try {
      const bPkg = JSON.parse(fs.readFileSync(path.join(builderDir, 'package.json'), 'utf8'));
      ok = !!bPkg.main && fs.existsSync(path.join(builderDir, bPkg.main));
      detail = `version=${bPkg.version}, main=${bPkg.main}`;
    } catch (err) {
      detail = err.message;
    }
    record('T11 electron-builder lazy parse', ok, detail);
  }
}

// --- T12: build/ helper scripts present (icon generator + cross-platform converters)
{
  const placeholder = path.join(BUILD_DIR, 'generate-icon-placeholder.js');
  const sh = path.join(BUILD_DIR, 'icon-build.sh');
  const ps1 = path.join(BUILD_DIR, 'icon-build.ps1');
  const phOk = fs.existsSync(placeholder);
  const shOk = fs.existsSync(sh);
  const ps1Ok = fs.existsSync(ps1);
  const ok = phOk && shOk && ps1Ok;
  record('T12 build/ helper scripts present', ok,
    `generate-icon-placeholder.js=${phOk} icon-build.sh=${shOk} icon-build.ps1=${ps1Ok}`);
}

// --- Summary
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} tests passed.`);
if (passed !== total) {
  console.log('\nFailed:');
  for (const r of results) if (!r.ok) console.log(`  - ${r.name}: ${r.detail}`);
  process.exit(1);
}
process.exit(0);
