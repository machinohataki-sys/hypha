'use strict';

// HYPHA · auto-updater — electron-updater integration for v1.0 (boot-8, 2026-05-20).
//
// Why this exists:
//   v0.x shipped a manual update checker (main.js:96 checkForUpdate) that polls
//   GitHub releases hourly and opens the release page in the browser. That's a
//   70% solution — user must quit, replace folder, relaunch. v1.0 raises the bar:
//   electron-updater downloads + stages the new build in the background and
//   prompts on quit. We still NEVER force-restart; consent is mandatory.
//
// Why lazy require:
//   electron-updater isn't a guaranteed install (sandbox / dev / CI may skip).
//   require('electron-updater') is wrapped in try/catch so a missing dep falls
//   back to the legacy GitHub-poll path in main.js. No app load failure.
//
// Privacy:
//   electron-updater hits the publish feed URL on launch + manual check. No
//   telemetry, no user data, no analytics. Per CLAUDE.md "不发送 telemetry on
//   update events".
//
// Install (post-scaffold, when ready to ship signed builds):
//   npm install electron-updater --save
//   Configure publish in package.json build.publish (GitHub provider or generic).
//   Code-sign the build (Apple Developer + Windows EV cert) before public release.
//
// Surface contract (consumed by main.js + IPC + screen-ux-settings):
//   initAutoUpdater({ app, mainWindow, getProfile, setProfile }) → void
//   checkForUpdates({ silent }) → Promise<{ ok, status, version?, error? }>
//   installUpdate() → Promise<{ ok, error? }>
//   currentVersion() → string
//   getAutoUpdaterState() → { ready, status, latest, current, dev }

const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Module-level state — single autoUpdater per process. Listeners attached once.
// ---------------------------------------------------------------------------
let _state = {
  ready: false,         // true once electron-updater loaded + listeners attached
  status: 'idle',       // idle | checking | available | not-available | downloading | downloaded | error
  latestVersion: null,  // tag string of remote release if newer
  currentVersion: null, // app.getVersion()
  error: null,          // last error message if any
  progress: null,       // { percent, transferred, total, bytesPerSecond }
  dev: false,           // true when init skipped due to dev mode
};

let _autoUpdater = null;
let _mainWindow = null;
let _app = null;
let _getProfile = null;
let _setProfile = null;

// Cooldown defaults — overridable for tests via initAutoUpdater options.
const REMIND_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

// ---------------------------------------------------------------------------
// Profile persistence helpers (skip-version + remind-me-later)
// ---------------------------------------------------------------------------

function readUpdateProfile() {
  if (typeof _getProfile === 'function') {
    try {
      const p = _getProfile() || {};
      return (p && p.auto_update) || {};
    } catch (_) { return {}; }
  }
  return {};
}

function writeUpdateProfile(patch) {
  if (typeof _setProfile === 'function') {
    try {
      const current = (typeof _getProfile === 'function' ? _getProfile() : {}) || {};
      const next = Object.assign({}, current, {
        auto_update: Object.assign({}, current.auto_update || {}, patch),
      });
      _setProfile(next);
      return true;
    } catch (_) { return false; }
  }
  return false;
}

function isVersionSkipped(version) {
  if (!version) return false;
  const prof = readUpdateProfile();
  return prof.skipped_version === version;
}

function isWithinRemindCooldown() {
  const prof = readUpdateProfile();
  const last = prof.last_remind_at;
  if (!last) return false;
  const elapsed = Date.now() - Number(last);
  return elapsed < REMIND_COOLDOWN_MS;
}

function markSkipVersion(version) {
  return writeUpdateProfile({ skipped_version: version, last_remind_at: null });
}

function markRemindLater() {
  return writeUpdateProfile({ last_remind_at: Date.now() });
}

// ---------------------------------------------------------------------------
// Event → renderer bridge. Renderer subscribes via window.ptor.update.onEvent.
// ---------------------------------------------------------------------------

function emitToRenderer(channel, payload) {
  try {
    if (_mainWindow && _mainWindow.webContents && !_mainWindow.webContents.isDestroyed()) {
      _mainWindow.webContents.send(channel, payload);
    }
  } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Listener attachment — wires electron-updater events into state + renderer
// ---------------------------------------------------------------------------

function attachListeners(autoUpdater) {
  // Never auto-download — user consent gate lives in renderer (Settings card).
  autoUpdater.autoDownload = false;
  // Don't auto-install on quit either; we prompt explicitly via installUpdate().
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    _state.status = 'checking';
    _state.error = null;
    emitToRenderer('update:event', { type: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    const v = info && info.version;
    _state.status = 'available';
    _state.latestVersion = v || null;
    emitToRenderer('update:event', { type: 'available', version: v });
  });

  autoUpdater.on('update-not-available', (info) => {
    _state.status = 'not-available';
    _state.latestVersion = (info && info.version) || _state.currentVersion;
    emitToRenderer('update:event', { type: 'not-available', version: _state.latestVersion });
  });

  autoUpdater.on('download-progress', (p) => {
    _state.status = 'downloading';
    _state.progress = {
      percent: p && p.percent,
      transferred: p && p.transferred,
      total: p && p.total,
      bytesPerSecond: p && p.bytesPerSecond,
    };
    emitToRenderer('update:event', { type: 'progress', progress: _state.progress });
  });

  autoUpdater.on('update-downloaded', (info) => {
    const v = info && info.version;
    _state.status = 'downloaded';
    _state.latestVersion = v || _state.latestVersion;
    _state.progress = null;
    emitToRenderer('update:event', { type: 'downloaded', version: v });
  });

  autoUpdater.on('error', (err) => {
    _state.status = 'error';
    _state.error = (err && err.message) || String(err);
    emitToRenderer('update:event', { type: 'error', error: _state.error });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the auto-updater. Safe to call multiple times — second call is
 * idempotent. Skips entirely in dev mode (electron-is-dev OR
 * !app.isPackaged) so a `npm start` session never hits the publish feed.
 *
 * @param {Object} opts
 * @param {Object} opts.app             — Electron app module
 * @param {Object} [opts.mainWindow]    — BrowserWindow for event bridge
 * @param {Function} [opts.getProfile]  — () => profile JSON
 * @param {Function} [opts.setProfile]  — (next) => void
 * @param {Object} [opts.autoUpdater]   — Inject for tests (mock)
 * @param {boolean} [opts.forceProd]    — Force prod mode (tests only)
 */
function initAutoUpdater(opts) {
  opts = opts || {};
  _app = opts.app || _app;
  _mainWindow = opts.mainWindow || _mainWindow;
  _getProfile = opts.getProfile || _getProfile;
  _setProfile = opts.setProfile || _setProfile;

  if (_state.ready) {
    // Already initialised — just refresh window reference, return state
    return Object.assign({}, _state);
  }

  // Dev guard — never check for updates in unpackaged builds. Mirrors the
  // legacy main.js gate (app.isPackaged). forceProd lets tests bypass.
  const isPackaged = _app && typeof _app.isPackaged === 'boolean' ? _app.isPackaged : false;
  if (!opts.forceProd && !isPackaged) {
    _state.dev = true;
    _state.status = 'idle';
    _state.currentVersion = _app && typeof _app.getVersion === 'function'
      ? _app.getVersion() : '0.0.0';
    return Object.assign({}, _state);
  }

  // Lazy require — missing dep is tolerated (legacy GitHub-poll still works).
  let autoUpdater = opts.autoUpdater || null;
  if (!autoUpdater) {
    try {
      // eslint-disable-next-line global-require
      autoUpdater = require('electron-updater').autoUpdater;
    } catch (e) {
      _state.status = 'error';
      _state.error = 'electron-updater not installed: ' + (e && e.message);
      // Don't throw — caller (main.js) checks state and falls back to legacy.
      return Object.assign({}, _state);
    }
  }

  _autoUpdater = autoUpdater;
  attachListeners(autoUpdater);

  _state.ready = true;
  _state.currentVersion = _app && typeof _app.getVersion === 'function'
    ? _app.getVersion() : '0.0.0';

  // Fire a delayed initial check (5s after init) — non-blocking, never crashes
  // app boot on network failure.
  setTimeout(() => {
    checkForUpdates({ silent: true }).catch(() => { /* best-effort */ });
  }, 5000);

  return Object.assign({}, _state);
}

/**
 * Check for updates now. Respects skip-version + remind cooldown when silent.
 * Manual check (silent=false) always queries and reports.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.silent=false] — Honor cooldown + skip prefs
 * @returns {Promise<{ ok, status, version?, error? }>}
 */
async function checkForUpdates(opts) {
  opts = opts || {};
  const silent = opts.silent === true;

  if (_state.dev) {
    return { ok: true, status: 'dev-skipped', version: _state.currentVersion };
  }

  if (!_state.ready || !_autoUpdater) {
    return { ok: false, status: 'not-ready', error: _state.error || 'auto-updater not initialised' };
  }

  // Honor cooldown only for silent (automatic) checks. Manual button bypasses.
  if (silent && isWithinRemindCooldown()) {
    return { ok: true, status: 'cooldown' };
  }

  try {
    const result = await _autoUpdater.checkForUpdates();
    const info = result && result.updateInfo;
    const version = info && info.version;
    // Silent + version is skipped → don't surface
    if (silent && version && isVersionSkipped(version)) {
      return { ok: true, status: 'skipped', version };
    }
    return { ok: true, status: _state.status, version };
  } catch (e) {
    return { ok: false, status: 'error', error: (e && e.message) || String(e) };
  }
}

/**
 * Download the update (requires update-available state). User-consent step
 * fires from the renderer's "下载" button.
 */
async function downloadUpdate() {
  if (!_state.ready || !_autoUpdater) {
    return { ok: false, error: _state.error || 'auto-updater not initialised' };
  }
  try {
    await _autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

/**
 * Quit + install. Only valid when state.status === 'downloaded'. Renderer
 * must confirm with the user first ("现在重启并安装").
 */
function installUpdate() {
  if (!_state.ready || !_autoUpdater) {
    return { ok: false, error: 'auto-updater not initialised' };
  }
  if (_state.status !== 'downloaded') {
    return { ok: false, error: 'no update downloaded' };
  }
  try {
    // Defer to next tick so the IPC response returns before quit().
    setTimeout(() => {
      try { _autoUpdater.quitAndInstall(false, true); } catch (_) {}
    }, 100);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function currentVersion() {
  if (_state.currentVersion) return _state.currentVersion;
  if (_app && typeof _app.getVersion === 'function') {
    try { return _app.getVersion(); } catch (_) { return '0.0.0'; }
  }
  // Last-resort fallback — read package.json directly (sandbox-safe).
  try {
    const pkg = require(path.resolve(__dirname, '..', '..', 'package.json'));
    return pkg.version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

function getAutoUpdaterState() {
  return Object.assign({}, _state);
}

function skipVersion(version) {
  if (!version) return { ok: false, error: 'version required' };
  const ok = markSkipVersion(version);
  return { ok, version };
}

function remindMeLater() {
  const ok = markRemindLater();
  return { ok, until: Date.now() + REMIND_COOLDOWN_MS };
}

// Test-only helper — reset module state between smoke runs.
function _resetForTests() {
  _state = {
    ready: false,
    status: 'idle',
    latestVersion: null,
    currentVersion: null,
    error: null,
    progress: null,
    dev: false,
  };
  _autoUpdater = null;
  _mainWindow = null;
  _app = null;
  _getProfile = null;
  _setProfile = null;
}

module.exports = {
  initAutoUpdater,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  currentVersion,
  getAutoUpdaterState,
  skipVersion,
  remindMeLater,
  _resetForTests,
  // Internals exported for white-box tests
  _internals: {
    isVersionSkipped,
    isWithinRemindCooldown,
    REMIND_COOLDOWN_MS,
  },
};
