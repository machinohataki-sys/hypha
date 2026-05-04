#!/usr/bin/env node
'use strict';

// Hypha — desktop packager. Wraps @electron/packager to produce a portable
// app folder under release/. Output: release/Hypha-<platform>-<arch>/Hypha.exe
// (or .app on mac, or executable on linux). Double-click to run; no installer.
//
// Why packager (not builder): electron-builder needs winCodeSign which fails
// to extract on Windows without Developer Mode (macOS dylib symlinks). Packager
// has no such dep — it just copies node + electron + app files into a folder.
//
// Usage:
//   npm run pack              -> default platform (current host)
//   npm run pack:win          -> Windows x64
//   npm run pack:mac          -> macOS x64
//   npm run pack:linux        -> Linux x64

const path = require('node:path');
const fs = require('node:fs');

const args = process.argv.slice(2);
const argMap = {};
for (const a of args) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) argMap[m[1]] = m[2];
}
const platform = argMap.platform || process.platform;
const arch = argMap.arch || 'x64';

async function main() {
  let packager;
  try {
    const mod = require('@electron/packager');
    // @electron/packager v20+ exports a named `packager` function (not default).
    packager = (typeof mod === 'function') ? mod : mod.packager;
  } catch (_) {
    console.error('  @electron/packager not installed. Run:');
    console.error('    npm install --save-dev @electron/packager');
    process.exit(1);
  }
  if (typeof packager !== 'function') {
    console.error('  @electron/packager export shape unexpected — reinstall.');
    process.exit(1);
  }
  const ROOT = path.resolve(__dirname, '..');
  const out = argMap.out
    ? (path.isAbsolute(argMap.out) ? argMap.out : path.join(ROOT, argMap.out))
    : path.join(ROOT, 'release');
  fs.mkdirSync(out, { recursive: true });
  // Defensive cleanup: try to remove prior build folder. If a process holds
  // a handle (File Explorer window open, AV scanning), packager will fail
  // with EBUSY — fall through and tell the user. Don't crash silently.
  const targetName = `Hypha-${platform}-${arch}`;
  const targetPath = path.join(out, targetName);
  if (fs.existsSync(targetPath)) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch (err) {
      console.error(`[pack] Cannot remove old ${targetPath}:`);
      console.error(`       ${err.code} — close any File Explorer / Hypha.exe instance and retry.`);
      console.error(`       Or pass --out=release/build-${Date.now()} to write to a fresh dir.`);
      process.exit(1);
    }
  }

  console.log(`[pack] platform=${platform} arch=${arch} → ${out}/`);
  const opts = {
    dir: ROOT,
    name: 'Hypha',
    out,
    platform,
    arch,
    overwrite: true,
    // Node modules to bundle. Default packager bundles all `dependencies`
    // (not devDependencies) — matches our intent; electron is in devDeps so
    // it's correctly excluded from the bundled app (Electron itself is the
    // host runtime, copied separately by packager).
    prune: true,
    // Skip directories that aren't part of the runnable app:
    //   .git, release/ itself, node_modules cache, IDE files, dev artifacts.
    ignore: [
      /^\/release($|\/)/,
      /^\/\.git($|\/)/,
      /^\/cloude-coke($|\/)/,
      /^\/ptor-design($|\/)/,
      /^\/ptor2-legacy-corpus-bet($|\/)/,
      /^\/old-src($|\/)/,                 // legacy snapshot — not loaded by app, was dead bloat in v0112 asar
      /^\/.claude($|\/)/,
      /^\/.vscode($|\/)/,
      /^\/.idea($|\/)/,
      /^\/data($|\/)/,                    // user data lives in userData (not bundled)
      /\.DS_Store$/,
      /\.bak$/,
      /^\/scripts($|\/)/,
    ],
    asar: true,
    appBundleId: 'studio.victor.hypha',
    appCategoryType: 'public.app-category.education',
    win32metadata: {
      CompanyName: 'Victor',
      FileDescription: 'Hypha — the NOTE AGENT',
      ProductName: 'Hypha',
    },
  };

  // Optional icon — packager picks .ico for win, .icns for mac, .png for linux
  // from build/icon.<ext>. Silently skipped if not present.
  const iconBase = path.join(ROOT, 'build', 'icon');
  const iconCandidate = platform === 'win32' ? `${iconBase}.ico`
                       : platform === 'darwin' ? `${iconBase}.icns`
                       : `${iconBase}.png`;
  if (fs.existsSync(iconCandidate)) opts.icon = iconCandidate;
  else console.log('[pack] no icon at build/icon.<ext> — using Electron default');

  const appPaths = await packager(opts);
  console.log('');
  console.log('[pack] DONE — output:');
  for (const p of appPaths) console.log('  ' + p);
  console.log('');
  if (platform === 'win32') {
    // v0151 — Personal launcher. Writes Hypha-personal.bat NEXT TO (not inside)
    // the Hypha-win32-x64/ folder so distribution = ship the inner folder
    // alone. Operator double-clicks the .bat to launch with HYPHA_ALLOW_CLI=1
    // baked in (skips main.js tutor-quality migration, allows claude-cli /
    // gemini-cli / codex-cli providers in settings). Distributed users still
    // launch Hypha.exe directly = no env = SDK-only path.
    try {
      const batPath = path.join(out, 'Hypha-personal.bat');
      const batBody = [
        '@echo off',
        'rem Personal launcher — enables CLI provider access via HYPHA_ALLOW_CLI=1.',
        'rem Distribution: ship Hypha-win32-x64\\ folder only, drop this .bat.',
        'set HYPHA_ALLOW_CLI=1',
        'start "" "%~dp0Hypha-win32-x64\\Hypha.exe"',
        '',
      ].join('\r\n');
      fs.writeFileSync(batPath, batBody, 'utf8');
      console.log(`  + Hypha-personal.bat (CLI-enabled launcher) at ${batPath}`);
    } catch (e) { console.log(`  ! could not write Hypha-personal.bat: ${e.message}`); }
    console.log('  → double-click Hypha.exe inside the folder above (clean / SDK-only)');
    console.log('  → or: double-click Hypha-personal.bat in the parent (CLI-enabled)');
    console.log('  → for distribution: ship Hypha-win32-x64\\ only, omit the .bat');
  } else if (platform === 'darwin') {
    console.log('  → drag Hypha.app to Applications');
  } else {
    console.log('  → ./Hypha (executable inside the folder)');
  }
}

main().catch(err => { console.error('[pack] FAILED', err); process.exit(1); });
