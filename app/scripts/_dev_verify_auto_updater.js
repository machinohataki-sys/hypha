#!/usr/bin/env node
'use strict';

// HYPHA · _dev_verify_auto_updater — smoke for v1.0 boot-8 electron-updater
// integration (app/lib/auto-updater.js).
//
// 10 tests:
//   AU1  lib loads without electron context (graceful import, no throw)
//   AU2  currentVersion() returns package.json version when app stub missing
//   AU3  initAutoUpdater in dev mode (app.isPackaged=false) → state.dev=true, status='idle'
//   AU4  initAutoUpdater with mock autoUpdater → state.ready=true + listeners wired
//   AU5  checkForUpdates(silent) honors 24h remind cooldown (returns status='cooldown')
//   AU6  checkForUpdates(silent) honors skip-version (returns status='skipped')
//   AU7  skipVersion + remindLater persist into profile via setProfile callback
//   AU8  installUpdate refuses when status !== 'downloaded' (returns ok=false)
//   AU9  UI grep: <UpdatePanel /> mounted in screen-ux-settings.jsx
//   AU10 IPC grep: 'update:check' handler exists in main.js + preload bridge wires window.updater
//
// Run:
//   node app/scripts/_dev_verify_auto_updater.js
//
// Exit 0 = PASS, Exit 1 = any fail.

const fs = require('fs');
const path = require('path');

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

// Helper — drop module cache between tests so each init() starts fresh.
function freshLib() {
  const libPath = path.join(__dirname, '..', 'lib', 'auto-updater.js');
  delete require.cache[require.resolve(libPath)];
  return require(libPath);
}

// Mock autoUpdater — captures attached listeners + lets us synthesize events.
function makeMockAutoUpdater() {
  const listeners = {};
  return {
    autoDownload: true,             // init flips → false
    autoInstallOnAppQuit: true,     // init flips → false
    on(evt, cb) { listeners[evt] = cb; },
    fire(evt, payload) { if (listeners[evt]) listeners[evt](payload); },
    listeners,
    checkForUpdatesArgs: null,
    async checkForUpdates() {
      this.checkForUpdatesArgs = true;
      return { updateInfo: { version: '1.1.0' } };
    },
    async downloadUpdate() { return true; },
    quitAndInstall() { this._quitCalled = true; },
    _quitCalled: false,
  };
}

// Mock Electron app
function makeApp({ packaged = false, version = '1.0.0' } = {}) {
  return {
    isPackaged: packaged,
    getVersion: () => version,
  };
}

// In-memory profile store mimicking vault.readJSON / writeJSON
function makeProfileStore() {
  let store = {};
  return {
    get: () => store,
    set: (next) => { store = next; },
    getProfile: () => store,
    setProfile: (next) => { store = next; },
  };
}

console.log('\n[auto-updater smoke]');

// ---------------------------------------------------------------------------
// AU1 — lib loads without electron context (graceful import, no throw)
// ---------------------------------------------------------------------------
let lib;
try {
  lib = freshLib();
  check('AU1 lib loads without electron context', typeof lib.initAutoUpdater === 'function');
} catch (e) {
  check('AU1 lib loads without electron context', false, e.message);
}

// ---------------------------------------------------------------------------
// AU2 — currentVersion fallback from package.json
// ---------------------------------------------------------------------------
{
  const f = freshLib();
  const v = f.currentVersion();
  // App not initialised → fallback to package.json. Should match a 3-part semver.
  const pkg = require(path.resolve(__dirname, '..', '..', 'package.json'));
  check('AU2 currentVersion fallback reads package.json',
    v === pkg.version, `got=${v} pkg=${pkg.version}`);
}

// ---------------------------------------------------------------------------
// AU3 — Dev mode init → state.dev=true, ready=false (electron-updater untouched)
// ---------------------------------------------------------------------------
{
  const f = freshLib();
  const st = f.initAutoUpdater({ app: makeApp({ packaged: false }) });
  check('AU3 dev mode init → state.dev=true', st.dev === true);
  check('AU3 dev mode init → state.ready=false', st.ready === false);
  check('AU3 dev mode init → status=idle', st.status === 'idle');
}

// ---------------------------------------------------------------------------
// AU4 — Production init with injected mock autoUpdater
// ---------------------------------------------------------------------------
{
  const f = freshLib();
  const mock = makeMockAutoUpdater();
  const st = f.initAutoUpdater({
    app: makeApp({ packaged: true, version: '1.0.0' }),
    autoUpdater: mock,
    forceProd: true,
  });
  check('AU4 prod init → state.ready=true', st.ready === true);
  check('AU4 prod init → autoDownload flipped to false', mock.autoDownload === false);
  check('AU4 prod init → autoInstallOnAppQuit flipped to false', mock.autoInstallOnAppQuit === false);
  // 6 listeners wired (checking / update-available / update-not-available / progress / downloaded / error)
  const expected = ['checking-for-update', 'update-available', 'update-not-available', 'download-progress', 'update-downloaded', 'error'];
  const allWired = expected.every((evt) => typeof mock.listeners[evt] === 'function');
  check('AU4 prod init → 6 listener events wired', allWired);
  f._resetForTests();
}

// ---------------------------------------------------------------------------
// AU5 — Silent check honors 24h remind cooldown
// ---------------------------------------------------------------------------
{
  const f = freshLib();
  const profile = makeProfileStore();
  // Pre-seed: last_remind_at = now (within cooldown)
  profile.set({ auto_update: { last_remind_at: Date.now() } });
  const mock = makeMockAutoUpdater();
  f.initAutoUpdater({
    app: makeApp({ packaged: true }),
    autoUpdater: mock,
    getProfile: profile.get,
    setProfile: profile.set,
    forceProd: true,
  });
  // Silent check
  return (async () => {
    const r1 = await f.checkForUpdates({ silent: true });
    check('AU5 silent check honors cooldown',
      r1.ok && r1.status === 'cooldown' && mock.checkForUpdatesArgs === null,
      `r1=${JSON.stringify(r1)} mockCalled=${mock.checkForUpdatesArgs !== null}`);
    // Manual check bypasses cooldown
    const r2 = await f.checkForUpdates({ silent: false });
    check('AU5 manual check bypasses cooldown',
      r2.ok && mock.checkForUpdatesArgs === true,
      `r2=${JSON.stringify(r2)}`);
    f._resetForTests();

    // -----------------------------------------------------------------------
    // AU6 — Silent check honors skipped-version
    // -----------------------------------------------------------------------
    {
      const f2 = freshLib();
      const p2 = makeProfileStore();
      p2.set({ auto_update: { skipped_version: '1.1.0' } });
      const m2 = makeMockAutoUpdater();
      f2.initAutoUpdater({
        app: makeApp({ packaged: true }),
        autoUpdater: m2,
        getProfile: p2.get,
        setProfile: p2.set,
        forceProd: true,
      });
      const r = await f2.checkForUpdates({ silent: true });
      check('AU6 silent check honors skipped-version',
        r.ok && r.status === 'skipped' && r.version === '1.1.0',
        `got=${JSON.stringify(r)}`);
      f2._resetForTests();
    }

    // -----------------------------------------------------------------------
    // AU7 — skipVersion + remindLater persist via setProfile callback
    // -----------------------------------------------------------------------
    {
      const f3 = freshLib();
      const p3 = makeProfileStore();
      const m3 = makeMockAutoUpdater();
      f3.initAutoUpdater({
        app: makeApp({ packaged: true }),
        autoUpdater: m3,
        getProfile: p3.get,
        setProfile: p3.set,
        forceProd: true,
      });
      const s1 = f3.skipVersion('1.2.3');
      check('AU7 skipVersion writes profile.auto_update.skipped_version',
        s1.ok && p3.get().auto_update && p3.get().auto_update.skipped_version === '1.2.3',
        `store=${JSON.stringify(p3.get())}`);
      const s2 = f3.remindMeLater();
      check('AU7 remindMeLater writes profile.auto_update.last_remind_at',
        s2.ok && typeof p3.get().auto_update.last_remind_at === 'number',
        `store=${JSON.stringify(p3.get())}`);
      f3._resetForTests();
    }

    // -----------------------------------------------------------------------
    // AU8 — installUpdate refuses without downloaded state
    // -----------------------------------------------------------------------
    {
      const f4 = freshLib();
      const m4 = makeMockAutoUpdater();
      f4.initAutoUpdater({
        app: makeApp({ packaged: true }),
        autoUpdater: m4,
        forceProd: true,
      });
      // status starts at 'idle'
      const r1 = f4.installUpdate();
      check('AU8 installUpdate refuses when status !== downloaded',
        r1.ok === false && /no update downloaded/i.test(r1.error || ''),
        `got=${JSON.stringify(r1)}`);
      // Synthesize 'update-downloaded' event to flip state.status
      m4.fire('update-downloaded', { version: '1.0.1' });
      const r2 = f4.installUpdate();
      check('AU8 installUpdate accepts when status === downloaded',
        r2.ok === true,
        `got=${JSON.stringify(r2)}`);
      f4._resetForTests();
    }

    // -----------------------------------------------------------------------
    // AU9 — UI grep: <UpdatePanel /> mounted in screen-ux-settings.jsx
    // -----------------------------------------------------------------------
    {
      const settingsPath = path.join(__dirname, '..', 'design', 'screen-ux-settings.jsx');
      const src = fs.readFileSync(settingsPath, 'utf8');
      check('AU9 UpdatePanel component defined',
        /const\s+UpdatePanel\s*=/.test(src));
      check('AU9 UpdatePanel mounted in render tree',
        /<UpdatePanel\s*\/>/.test(src));
      check('AU9 UI calls window.updater bridge',
        /window\.updater\b/.test(src));
      check('AU9 UI offers manual check button',
        /检查更新/.test(src));
    }

    // -----------------------------------------------------------------------
    // AU10 — IPC grep: update:check handler + preload bridge
    // -----------------------------------------------------------------------
    {
      const mainPath = path.join(__dirname, '..', 'main.js');
      const mainSrc = fs.readFileSync(mainPath, 'utf8');
      check('AU10 main.js: ipcMain.handle(\'update:check\')',
        /ipcMain\.handle\(['"]update:check['"]/.test(mainSrc));
      check('AU10 main.js: ipcMain.handle(\'update:download\')',
        /ipcMain\.handle\(['"]update:download['"]/.test(mainSrc));
      check('AU10 main.js: ipcMain.handle(\'update:install\')',
        /ipcMain\.handle\(['"]update:install['"]/.test(mainSrc));
      check('AU10 main.js: initAutoUpdater wired in createWindow',
        /au\.initAutoUpdater\(/.test(mainSrc));
      const preloadPath = path.join(__dirname, '..', 'preload.js');
      const preloadSrc = fs.readFileSync(preloadPath, 'utf8');
      check('AU10 preload.js: exposeInMainWorld(\'updater\')',
        /exposeInMainWorld\(['"]updater['"]/.test(preloadSrc));
      check('AU10 preload.js: ipcRenderer.invoke(\'update:check\')',
        /ipcRenderer\.invoke\(['"]update:check['"]/.test(preloadSrc));
    }

    // Tally
    console.log('');
    console.log('  Summary: ' + pass + ' pass, ' + fail + ' fail');
    if (fail > 0) {
      console.log('  Failures:');
      for (const f of failures) {
        console.log('    - ' + f.name + (f.detail ? '  (' + f.detail + ')' : ''));
      }
      process.exit(1);
    }
    process.exit(0);
  })().catch((e) => {
    console.error('  FATAL', e && e.stack);
    process.exit(1);
  });
}
