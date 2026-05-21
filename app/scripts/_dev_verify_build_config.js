#!/usr/bin/env node
/**
 * _dev_verify_build_config.js
 *
 * Verifies electron-builder configuration in package.json + build/ resources.
 * Read-only — never executes electron-builder, never mutates files.
 *
 * Usage: node app/scripts/_dev_verify_build_config.js
 * Exit: 0 if all pass, 1 if any fail.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const BUILD_DIR = path.join(ROOT, 'build');
const GITIGNORE_PATH = path.join(ROOT, '.gitignore');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  const line = detail ? ` — ${detail}` : '';
  console.log(`[${tag}] ${name}${line}`);
}

function tryRead(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); }
  catch (err) { return null; }
}

// --- T1: package.json parses as valid JSON
let pkg = null;
let pkgRaw = tryRead(PKG_PATH);
try {
  pkg = JSON.parse(pkgRaw);
  record('T1 package.json valid JSON', true, `version=${pkg.version}`);
} catch (err) {
  record('T1 package.json valid JSON', false, err.message);
}

if (!pkg) {
  console.error('\nFATAL: cannot read/parse package.json, remaining tests skipped.');
  process.exit(1);
}

// --- T2: build section present + required fields
const build = pkg.build;
{
  const required = ['appId', 'productName', 'files', 'directories'];
  const missing = required.filter(k => !build || !(k in build));
  const ok = !!build && missing.length === 0
    && build.appId === 'com.victor.hypha'
    && build.productName === 'HYPHA'
    && Array.isArray(build.files);
  record('T2 build section + required fields', ok,
    ok ? `appId=${build.appId}` : `missing: ${missing.join(',') || 'shape mismatch'}`);
}

// --- T3: required scripts present
{
  const want = ['build:win', 'build:mac', 'build:linux', 'build:all', 'dist', 'pack:eb'];
  const present = want.filter(s => pkg.scripts && pkg.scripts[s]);
  const ok = present.length === want.length;
  record('T3 electron-builder scripts present', ok,
    ok ? `${present.length}/${want.length}` : `missing: ${want.filter(s => !present.includes(s)).join(',')}`);
}

// --- T4: electron-builder in devDependencies, electron-updater in dependencies
{
  const ebInDev = !!(pkg.devDependencies && pkg.devDependencies['electron-builder']);
  const updaterInDeps = !!(pkg.dependencies && pkg.dependencies['electron-updater']);
  const ok = ebInDev && updaterInDeps;
  record('T4 electron-builder + electron-updater installed-or-declared', ok,
    `electron-builder(dev)=${ebInDev}, electron-updater(deps)=${updaterInDeps}`);
}

// --- T5: asar config valid
{
  const ok = build && build.asar === true
    && Array.isArray(build.asarUnpack)
    && build.asarUnpack.length >= 1;
  record('T5 asar config', ok,
    ok ? `asar=true, unpack=${build.asarUnpack.length} entries` : 'asar or asarUnpack malformed');
}

// --- T6: Windows nsis target + icon
{
  const win = build && build.win;
  const nsis = build && build.nsis;
  const okWin = !!win && Array.isArray(win.target) && win.target.length >= 1
    && win.icon === 'build/icon.ico';
  const okNsis = !!nsis && nsis.oneClick === false
    && nsis.allowToChangeInstallationDirectory === true;
  const ok = okWin && okNsis;
  record('T6 Windows nsis installer config', ok,
    ok ? 'nsis target + per-user installer' : `win=${okWin} nsis=${okNsis}`);
}

// --- T7: macOS config — category + hardenedRuntime + entitlements
{
  const mac = build && build.mac;
  const ok = !!mac
    && mac.category === 'public.app-category.education'
    && mac.hardenedRuntime === true
    && mac.entitlements === 'build/entitlements.mac.plist'
    && Array.isArray(mac.target) && mac.target.length >= 1;
  record('T7 macOS config (category + hardenedRuntime + entitlements)', ok,
    ok ? `category=${mac.category}` : 'mac config incomplete');
}

// --- T8: Linux AppImage target
{
  const linux = build && build.linux;
  const ok = !!linux && Array.isArray(linux.target)
    && linux.target.some(t => (typeof t === 'string' ? t === 'AppImage' : t.target === 'AppImage'))
    && linux.category === 'Education';
  record('T8 Linux AppImage target', ok,
    ok ? 'AppImage + Education category' : 'linux config missing AppImage or category');
}

// --- T9: publish provider configured (placeholder OR real)
// intentional-placeholder: publish.owner / publish.repo currently
// PLACEHOLDER_OWNER / PLACEHOLDER_REPO in package.json. Validator only
// checks shape (provider/owner/repo are strings); real GitHub coordinates
// are env-substituted at CI publish time, not committed to source. Test
// passes on placeholder strings by design — see build/README.md "Publishing".
{
  const publish = build && build.publish;
  const ok = Array.isArray(publish) && publish.length >= 1
    && publish[0].provider === 'github'
    && typeof publish[0].owner === 'string'
    && typeof publish[0].repo === 'string';
  record('T9 publish provider declared', ok,
    ok ? `provider=${publish[0].provider}, owner=${publish[0].owner}` : 'publish[0] malformed');
}

// --- T10: files include/exclude — no dev-verify scripts shipped
{
  const files = build && build.files;
  const ok = Array.isArray(files)
    && files.some(p => p.startsWith('!') && p.includes('_dev_verify'));
  record('T10 dev-verify scripts excluded from build', ok,
    ok ? 'files[] excludes _dev_verify_*' : 'files[] lacks dev-verify exclude');
}

// --- T11: build/ resources present
{
  const entitlements = fs.existsSync(path.join(BUILD_DIR, 'entitlements.mac.plist'));
  const iconPng = fs.existsSync(path.join(BUILD_DIR, 'icon.png'));
  const iconIco = fs.existsSync(path.join(BUILD_DIR, 'icon.ico'));
  const readme = fs.existsSync(path.join(BUILD_DIR, 'README.md'));
  const ok = entitlements && iconPng && iconIco && readme;
  record('T11 build/ resources present', ok,
    `entitlements=${entitlements} icon.png=${iconPng} icon.ico=${iconIco} README=${readme}`);
}

// --- T12: entitlements.mac.plist parses as XML (basic shape check)
{
  const ePath = path.join(BUILD_DIR, 'entitlements.mac.plist');
  const raw = tryRead(ePath);
  const ok = !!raw
    && raw.includes('<?xml version="1.0"')
    && raw.includes('<!DOCTYPE plist')
    && raw.includes('<plist version="1.0">')
    && raw.includes('com.apple.security.network.client')
    && raw.includes('</plist>');
  record('T12 entitlements.mac.plist shape valid', ok,
    ok ? `${raw.split('\n').length} lines` : 'plist DOCTYPE/root/network entitlement missing');
}

// --- T13: .gitignore excludes dist/ (build output)
{
  const raw = tryRead(GITIGNORE_PATH);
  const ok = !!raw && /^dist\/?\s*$/m.test(raw);
  record('T13 .gitignore excludes dist/', ok,
    ok ? 'dist/ pattern present' : '.gitignore missing dist/ entry');
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
