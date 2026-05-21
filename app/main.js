'use strict';

// 2026-05-17 二次防御 — process-level error handlers BEFORE anything else.
// Any silent throw during module require / IPC handler init / async chain
// would previously leave 0 stderr output. These give us a stack to grep.
// v1.0 boot-7 (2026-05-20) — also funnel to local-tracker for export-to-bug-report.
// Tracker is best-effort; never swallow the original error.
let _telemetry = null;
function _tel() {
  if (_telemetry !== null) return _telemetry;
  try { _telemetry = require('./lib/telemetry/local-tracker'); }
  catch (_) { _telemetry = false; }
  return _telemetry || null;
}
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', (reason && reason.stack) || reason);
  try {
    const t = _tel();
    if (t) t.recordError({
      code: 'unhandled_rejection',
      severity: 'fatal',
      message: String((reason && reason.message) || reason || ''),
      stack: reason && reason.stack,
    });
  } catch (_) {}
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', (err && err.stack) || err);
  try {
    const t = _tel();
    if (t) t.recordError({
      code: 'uncaught_exception',
      severity: 'fatal',
      message: String((err && err.message) || err || ''),
      stack: err && err.stack,
    });
  } catch (_) {}
});

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const vault = require('./lib/vault');
const importer = require('./lib/importer');
const scheduler = require('./lib/scheduler');
// v1.0 boot-11 (2026-05-20) — unified shutdown registry. Anywhere a long-lived
// timer / cache / watcher / abort pool is created in this file, register the
// corresponding teardown here so app.before-quit can drain cleanly. See
// `app/lib/cleanup-registry.js` for the contract.
const cleanupRegistry = require('./lib/cleanup-registry');
// Register the LLM router's recovery-poll teardown once. The router auto-starts
// its setInterval on require (unref'd, so it never blocks shutdown — but
// clearInterval'ing it ensures any scheduled tick is cancelled cleanly before
// the process exits, eliminating "I/O after exit" warnings on slow machines).
try {
  const _llmRouter = require('./lib/llm/router');
  if (_llmRouter && typeof _llmRouter.stopRecoveryLoop === 'function') {
    cleanupRegistry.register({
      label: 'llm-router-recovery-loop',
      cleanup_fn: () => _llmRouter.stopRecoveryLoop(),
    });
  }
} catch (_) { /* router optional at boot — registered lazily on first executeChat */ }
// HYPHA boot-10 (2026-05-20) — startup-time profiler. Sets first mark here
// so `boot:total` spans from earliest reachable point through to ready-to-show.
// Records persist to vault/.hypha/startup-trace.jsonl when window first shows.
// Lazy callers can `require('./lib/perf/startup-profile')` safely; module
// is pure JS, no side effects beyond its own in-process Maps.
const _perf = require('./lib/perf/startup-profile');
_perf.markStart('boot:total');
_perf.markStart('boot:requires');
// ptor2 corpus integration — every human read fires an event so reinforce.js
// can rerank recall queue by decay × event-frequency. Lazy-resilient: if
// ptor2/ moves or breaks, log-write fails silently rather than crashing
// vault IPC. Packaged Hypha (.exe / .app / .AppImage) does NOT include
// ptor2-legacy-corpus-bet (it's a sibling external module, not part of
// Hypha proper) — the require fails and we fall back to no-op stubs that
// match the consumer API surface, so downstream callers don't need null
// checks scattered throughout main.js.
const _eventLogStub = {
  readAll: async function* () {},      // empty async iterator
  record: () => {},
  agentTrace: async () => [],
  aggregate: async () => null,
};
const _reinforceStub = {
  bulkStrength: async () => ({}),
  strengthFor: async () => null,
};
let _eventLog = null, _reinforce = null;
function eventLog() {
  if (_eventLog) return _eventLog;
  try { _eventLog = require('../../ptor2-legacy-corpus-bet/corpus/event-log'); }
  catch (_) { _eventLog = _eventLogStub; }
  return _eventLog;
}
function reinforce() {
  if (_reinforce) return _reinforce;
  try { _reinforce = require('../../ptor2-legacy-corpus-bet/corpus/reinforce'); }
  catch (_) { _reinforce = _reinforceStub; }
  return _reinforce;
}

const isDev = process.argv.includes('--dev');
const ROOT = __dirname;

// Update checker — production only.
// v1.0 boot-8 (2026-05-20): electron-updater is now the primary path (see
// `app/lib/auto-updater.js`), initialised once mainWindow exists below. This
// legacy GitHub-poll path stays as graceful-degradation fallback for when
// electron-updater isn't installed (sandbox / CI / dev / install failures).
// It is still useful even after v1.0 ship because:
//   1. electron-updater requires code-signing on macOS + Windows for downloads
//      to verify; until we ship signed builds, the legacy "open release page in
//      browser" flow keeps users on the latest version.
//   2. Auto-updater state machine `getAutoUpdaterState().ready` reports false
//      when the dep isn't loaded → this loop fills the gap.
//
// Once we ship signed builds (post-revenue, Apple Developer + Windows EV cert),
// remove this legacy block entirely.
if (app.isPackaged) {
  setTimeout(() => {
    // Skip legacy poll if electron-updater is live — avoids double-notifying user.
    try {
      const au = require('./lib/auto-updater');
      const st = au.getAutoUpdaterState();
      if (st && st.ready) return;
    } catch (_) { /* fall through to legacy poll */ }
    checkForUpdate().catch(e => console.error('[update]', e.message));
  }, 30_000);
  // v1.0 boot-11 — hourly legacy update poll. Register clearInterval so the
  // timer doesn't keep the event loop alive past app.quit() on long-running
  // sessions. unref() makes the interval non-blocking for natural shutdown;
  // cleanup-registry guarantees it's cleared on explicit quit.
  const _legacyUpdateTimer = setInterval(() => {
    try {
      const au = require('./lib/auto-updater');
      const st = au.getAutoUpdaterState();
      if (st && st.ready) return;
    } catch (_) { /* fall through */ }
    checkForUpdate().catch(e => console.error('[update]', e.message));
  }, 60 * 60 * 1000);
  if (_legacyUpdateTimer.unref) _legacyUpdateTimer.unref();
  cleanupRegistry.register({
    label: 'legacy-update-poll-interval',
    cleanup_fn: () => clearInterval(_legacyUpdateTimer),
  });
}

let _updateNotifiedFor = null;

async function checkForUpdate() {
  const pkg = require('../package.json');
  const repoMatch = (pkg.repository && pkg.repository.url || '').match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!repoMatch) return;
  const [, owner, repo] = repoMatch;
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const fetchFn = (typeof fetch === 'function') ? fetch : require('node-fetch');
  const res = await fetchFn(url, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Hypha-update-checker',
    },
  });
  if (!res.ok) return;
  const data = await res.json();
  const latest = String(data.tag_name || '').replace(/^v/, '');
  const current = pkg.version;
  if (!latest || !semverGt(latest, current)) return;
  if (_updateNotifiedFor === latest) return;       // don't nag every hour
  _updateNotifiedFor = latest;
  const win = BrowserWindow.getAllWindows()[0];
  const choice = await dialog.showMessageBox(win || null, {
    type: 'info',
    title: 'Hypha update available',
    message: `Hypha ${latest} is available (you have ${current}).`,
    detail: 'Click "Download" to open the releases page in your browser. Quit Hypha, replace the folder, then re-launch — your notes and progress are kept (they live in %APPDATA%\\Hypha\\data).',
    buttons: ['Download', 'Later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice.response === 0) {
    shell.openExternal(data.html_url || `https://github.com/${owner}/${repo}/releases/latest`);
  }
}

function semverGt(a, b) {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// Production data root: when packaged (.exe / .dmg / .AppImage), the project's
// `data/` directory is read-only inside asar — vault writes would fail. Redirect
// HYPHA_DATA to <userData>/data so notes / curricula / settings survive
// reinstalls + auto-updates. Dev mode keeps using the project-local `data/`
// directory so Phase 6 verification + existing curricula stay accessible.
// vault.resolveRoot() reads HYPHA_DATA on every call, so setting it here
// (before any vault method runs) is sufficient.
if (app.isPackaged && !process.env.HYPHA_DATA) {
  const userDataRoot = path.join(app.getPath('userData'), 'data');
  try { fs.mkdirSync(userDataRoot, { recursive: true }); } catch (_) {}
  process.env.HYPHA_DATA = userDataRoot;
}

// Enable remote debugging so we can inspect via CDP
app.commandLine.appendSwitch('remote-debugging-port', '9222');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.jsx':  'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.md':   'text/markdown; charset=utf-8',
};

// Hypha lift: node_modules lives at hypha/ (parent of app/), not app/node_modules/.
// Fallback: /node_modules/* paths resolve against PARENT_ROOT.
const PARENT_ROOT = path.resolve(ROOT, '..');

function serve(req, res) {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
    const safe = path.normalize(urlPath).replace(/^[/\\]+/, '');
    let abs;
    if (safe === 'node_modules' || safe.startsWith('node_modules' + path.sep) || safe.startsWith('node_modules/')) {
      abs = path.resolve(PARENT_ROOT, safe);
      if (!abs.startsWith(PARENT_ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    } else {
      abs = path.resolve(ROOT, safe);
      if (!abs.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    }

    fs.stat(abs, (err, st) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const target = st.isDirectory() ? path.join(abs, 'index.html') : abs;
      const ext = path.extname(target).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
      fs.createReadStream(target).on('error', () => { try { res.end(); } catch(_) {} }).pipe(res);
    });
  } catch (e) {
    res.writeHead(500); res.end('server error');
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(serve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      console.log(`[ptor-design] serving ${ROOT} on http://127.0.0.1:${port}`);
      resolve({ server, port });
    });
  });
}

let _server = null;

async function createWindow() {
  const { server, port } = await startServer();
  _server = server;
  console.log(`[boot] preload at ${path.join(__dirname, 'preload.js')}`);

  // vc-core sidecar disabled v0.1.6 — terminal pane removed (right rail =
  // NavRail TOC + see-also). spawnVcCore() + IPC handlers below stay
  // intact for a future Labs/dev drawer; uncomment to revive.
  const vcChild = null;

  const win = new BrowserWindow({
    width: 1320,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#1a1410',
    title: 'PTOR',
    icon: path.join(__dirname, 'assets', 'ptor-icon.png'),
    frame: false,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      // 2026-05-17 critical fix — sandbox:true silently breaks preload's local
      // `require('./lib/*')` calls (preload.js:18 v0-mock-marker, plus most of
      // the post-line-150 namespaces). Symptom: window.ptor undefined,
      // renderer throws "curriculumCreate IPC bridge not available". Same
      // root cause as PTOR 2026-04-25 (memory: project_electron_preload_sandbox).
      // contextIsolation stays TRUE; IPC boundary preserved.
      sandbox: false,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.once('ready-to-show', () => {
    // Use workArea (above Windows taskbar) instead of maximize() — frameless
    // Electron windows can extend below the taskbar in some Windows setups,
    // clipping bottom content. Explicit setBounds(workArea) guarantees the
    // window respects taskbar reserved area.
    try {
      const wa = screen.getPrimaryDisplay().workArea;
      win.setBounds(wa);
    } catch (_) {
      win.maximize();   // fallback
    }
    win.show();
    // v1.0 boot-8 — initialise electron-updater post-show. Lazy-required; if
    // dep is missing (dev / CI / sandboxed install), init returns dev/error
    // state and the legacy GitHub-poll fallback above keeps users on the
    // latest version. Init seeds an internal 5s-delayed check (silent). Never
    // blocks the UI thread.
    try {
      const au = require('./lib/auto-updater');
      au.initAutoUpdater({
        app,
        mainWindow: win,
        getProfile: () => {
          try {
            return (vault.exists && vault.exists('data/profile.json'))
              ? (vault.readJSON('data/profile.json', null) || {})
              : {};
          } catch (_) { return {}; }
        },
        setProfile: (next) => {
          try { vault.writeJSON('data/profile.json', next); } catch (_) {}
        },
      });
    } catch (e) {
      console.warn('[update] electron-updater init skipped:', e && e.message);
    }
  });

  // Bridge renderer console to main process stdout for debugging
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    const lvl = ['log','info','warn','error'][level] || 'log';
    console.log(`[renderer:${lvl}] ${message}` + (source ? ` (${source}:${line})` : ''));
  });

  // 2026-05-17 二次防御 — silent preload crash 让 sandbox:true bug 拖延数天才发现。
  // 4 个监听器把无声故障变可见。 audit agent 推荐, root cause = 0 stderr 输出。
  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    console.error('[preload-error]', preloadPath, '\n', (err && err.stack) || err);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[did-fail-load] code=' + code + ' desc=' + desc + ' url=' + url);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render-process-gone]', JSON.stringify(details));
  });

  win.on('maximize', () => win.webContents.send('window:maximizeChanged', true));
  win.on('unmaximize', () => win.webContents.send('window:maximizeChanged', false));

  // External link safety net: if anything tries to navigate the main webview
  // away from PTOR's HTTP server (file:, http://localhost, http://127.0.0.1),
  // intercept and open in the user's default browser instead. Also blocks
  // new-window pop-ups by routing through shell.openExternal.
  // This catches links inside marked-rendered HTML (e.g. DeepenCallout synth
  // links) where target=_blank wasn't set.
  win.webContents.on('will-navigate', (event, url) => {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(url)) return;   // own server
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadURL(`http://127.0.0.1:${port}/design/HYPHA.html`);

  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  // Wire vc-core stdout → renderer once webContents finishes loading. Earlier
  // 'vc:message' sends are queued by Electron until the renderer is ready,
  // but we also push a redraw-friendly buffer of recent msgs so a Ctrl+R
  // reload re-attaches without losing terminal state.
  if (vcChild) attachVcChildToWindow(vcChild, win);

  win.on('closed', () => {
    if (vcChild && !vcChild.killed) {
      try { vcChild.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { if (vcChild.exitCode === null) vcChild.kill('SIGKILL'); } catch (_) {} }, 1000).unref();
    }
  });
}

// ── vc-core sidecar ─────────────────────────────────────────────────────────
// Spawn the Rust pty/terminal sidecar. Resilient to missing binary (returns
// null + warns; UI shows the fallback empty terminal). One child per window.
const _vcSpawn = require('node:child_process').spawn;
function spawnVcCore() {
  // Compiled artifact path — debug build also acceptable but release is canonical.
  const candidates = [
    path.join(__dirname, '..', '..', 'ptor', 'vc', 'target', 'release', 'vc-core.exe'),
    path.join(__dirname, '..', '..', 'ptor', 'vc', 'target', 'release', 'vc-core'),
    path.join(__dirname, '..', '..', 'ptor', 'vc', 'target', 'debug', 'vc-core.exe'),
    path.join(__dirname, '..', '..', 'ptor', 'vc', 'target', 'debug', 'vc-core'),
  ];
  const bin = candidates.find(p => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  if (!bin) {
    console.warn('[vc-core] binary not found in any of:', candidates);
    return null;
  }
  console.log('[vc-core] spawning', bin);
  let child;
  try {
    child = _vcSpawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    console.error('[vc-core] spawn failed:', e.message);
    return null;
  }
  child.on('error', (e) => console.error('[vc-core] error:', e.message));
  child.on('exit', (code, sig) => console.log('[vc-core] exited', { code, sig }));
  child.stderr.on('data', (chunk) => {
    // vc-core emits tracing logs to stderr — relay to console for debugging.
    const txt = chunk.toString('utf8').trim();
    if (txt) console.log('[vc-core:stderr]', txt);
  });
  return child;
}

function attachVcChildToWindow(child, win) {
  // Buffer line-fragments across stdout chunk boundaries (JSONL must be
  // line-delimited — partial lines must be stitched).
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch (e) {
        console.warn('[vc-core] bad json line:', line.slice(0, 200));
        if (!win.isDestroyed()) try { win.webContents.send('vc:fatal', `bad json: ${line.slice(0, 80)}`); } catch (_) {}
        continue;
      }
      if (win.isDestroyed()) return;
      try { win.webContents.send('vc:msg', msg); } catch (_) {}
    }
  });

  // Renderer → vc-core stdin. Each invoke writes one JSON line. Errors
  // (child died, stdin closed) are swallowed — UI surfaces a banner via the
  // separate 'vc:message' Warning op when relevant.
  // ipcMain.handle is registered globally below; we route via the singleton
  // child reference.
  _vcChildRef = child;
}

let _vcChildRef = null;
ipcMain.handle('vc:send', (_e, msg) => {
  if (!_vcChildRef || !_vcChildRef.stdin || _vcChildRef.stdin.destroyed) return false;
  try {
    _vcChildRef.stdin.write(JSON.stringify(msg) + '\n');
    return true;
  } catch (e) {
    console.warn('[vc:send] write failed:', e.message);
    return false;
  }
});

function winFor(e) { return BrowserWindow.fromWebContents(e.sender); }

// Machino-α5 (2026-05-14) — main → renderer event bus for Creation System
// async writes (decisions / sparks / kill-watch / roadmap-sync). The cards in
// app/design/*-card.jsx subscribe via the preload bridge (window.ptor.creation
// .onDecisionsExtracted / .onSparksExtracted / .onKillWatchDone /
// .onRoadmapSynced) and refetch on each emit, replacing the finishCount
// time-racing path that read JSONL before the writes had hit disk.
//
// Sends to ALL non-destroyed BrowserWindow webContents so background slug
// finishes still update the foreground window. Callers stay Electron-agnostic
// (lib modules just return a result; main.js decides whether/what to emit).
function _emitToRenderer(channel, payload) {
  try {
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (w && w.webContents && !w.webContents.isDestroyed()) {
        w.webContents.send(channel, payload);
      }
    }
  } catch (_) { /* silent — emit failures must never break a backend write */ }
}

ipcMain.handle('window:minimize',       (e) => { winFor(e)?.minimize(); });
ipcMain.handle('window:toggleMaximize', (e) => {
  const w = winFor(e); if (!w) return;
  if (w.isMaximized()) w.unmaximize(); else w.maximize();
});
ipcMain.handle('window:close',          (e) => { winFor(e)?.close(); });
ipcMain.handle('window:isMaximized',    (e) => winFor(e)?.isMaximized() ?? false);

ipcMain.handle('vault:list',  async () => {
  try {
    const r = vault.list();

    // Living-Substrate Stage 1 (council 2026-04-30): enrich each item with
    // `lastAttendedAt` = max(file mtime, latest 'read' event ts from event log).
    // VaultTree uses this to apply patina opacity decay (久未碰的笔记 visually
    // fades). Single-pass scan over event log builds Map<rel, latestTs>.
    const root = vault.resolveRoot();
    const lastReadByFile = new Map();
    try {
      for await (const ev of eventLog().readAll(root, { op: 'read' })) {
        if (ev && ev.file && ev.ts) lastReadByFile.set(ev.file, ev.ts);
      }
    } catch (_) {}
    for (const folder of r.folders) {
      for (const item of folder.items) {
        const lastReadTs = lastReadByFile.get(item.rel) || lastReadByFile.get(item.id) || null;
        const mtime = item.mtime || null;
        const candidates = [lastReadTs, mtime].filter(Boolean);
        item.lastAttendedAt = candidates.length
          ? candidates.reduce((a, b) => (a > b ? a : b))
          : null;
      }
    }

    // Phase 3.2 — cure-clock A1 → vault tree "next suggested lesson" mark.
    // For each curriculum folder (any item with lessonIdx != null), read its
    // state.json and call scheduler.scheduleNextLesson. Mark the matching item
    // with `isNextSuggested: true` and surface mode (forward / revisit) so
    // VaultTree can render the brass mark. Silent no-op if state.json missing
    // or sequence is empty.
    const now = Date.now();
    for (const folder of r.folders) {
      const isCurriculum = folder.items.some(it => it.lessonIdx !== null);
      if (!isCurriculum) continue;
      const state = vault.readJSON(`${folder.folder}/state.json`, null);
      if (!state || !Array.isArray(state.lessonRels)) continue;
      const sequence = state.lessonRels.map((rel, idx) => ({
        idx,
        prereqIds: Array.isArray(state.lessonPrereqs && state.lessonPrereqs[idx])
          ? state.lessonPrereqs[idx] : [],
      }));
      let pick;
      try { pick = scheduler.scheduleNextLesson(state, sequence, now); }
      catch (_) { pick = null; }
      if (!pick || pick.idx < 0) continue;
      const targetRel = state.lessonRels[pick.idx];
      if (!targetRel) continue;
      for (const item of folder.items) {
        if (item.rel === targetRel) {
          item.isNextSuggested = true;
          item.nextSuggestedMode = pick.mode || 'forward';
          if (typeof pick.revisitOf === 'number') item.nextSuggestedRevisitOf = pick.revisitOf;
          break;
        }
      }
      // 2026-05-02 W3 visibility — log when picker chose a revisit (vs default
      // forward). Forward picks are noisy (every vault:list emits one) so we
      // only log the interesting revisit picks. Use this to audit whether
      // cure-clock is generating actionable revisit signals.
      if (pick.mode === 'revisit') {
        try {
          _hyphaAppendEvent('next_lesson_suggested', {
            slug: folder.folder,
            lesson_id: pick.idx,
            mode: pick.mode,
            revisit_of: pick.revisitOf,
          });
        } catch (_) {}
      }
    }

    console.log(`[vault:list] root=${r.root} folders=${r.folders.length} items=${r.folders.reduce((s, f) => s + f.count, 0)}`);
    return r;
  } catch (err) {
    console.error('[vault:list] FAILED', err);
    try {
      const t = _tel();
      if (t) t.recordError({
        code: 'vault_list_failed',
        severity: 'error',
        message: String((err && err.message) || err),
        stack: err && err.stack,
      });
    } catch (_) {}
    throw err;
  }
});
ipcMain.handle('vault:read',  (_e, rel) => {
  const result = vault.read(rel);
  if (result) {
    // Fire 'read' event so corpus reinforce/recall ranks adapt to actual
    // human attention. Try/catch: corpus is optional, vault read must not fail.
    try { eventLog().record(vault.resolveRoot(), { op: 'read', file: rel, agent_id: 'human' }); }
    catch (e) { console.error('[event-log] read failed', e.message); }
  }
  return result;
});
ipcMain.handle('vault:write', (_e, rel, body) => vault.write(rel, body));
ipcMain.handle('vault:root',  () => vault.resolveRoot());

// Lesson Skeleton generator — sub-step D (v0.1). 6-field schema validated via
// 5-plan smoke test 2026-05-08, 5/5 strict 3/3. Single-pass + 1 retry on
// schema violation. NO Critic loop (deferred to v0.2 per council synthesis).
//
// ⚠ v0.3 pivot: this emits a per-lesson SKELETON (HOOK seed for state-machine
// chat). The "Plan" semantically per BLUEPRINT §1.1 = the curriculum chain
// from `agent.js:planChain`. IPC route name `lesson:generatePlan` retained
// for ABI compat.
const lessonGenerator = require('./lib/lesson-generator');
ipcMain.handle('lesson:generatePlan', async (_e, payload) => {
  try {
    const p = payload || {};
    // R-LIB Day 4 (2026-05-12): if caller supplied topic + harvest already ran,
    // pull library rollup + community hint from agent module cache and thread
    // them into skeleton-stage prompt as LIBRARY_EVIDENCE / COMMUNITY_HINT
    // blocks. If no topic OR no cached harvest, skip silently — buildUserMessage
    // degrades gracefully when harvestContext is null.
    if (!p.harvestContext && p.topic) {
      try {
        const agentMod = require('./agent');
        const libraryRollup = agentMod.getLibraryRollupForTopic(p.topic);
        const communityHint = agentMod.getCommunityHintForTopic(p.topic);
        if (libraryRollup || communityHint) {
          p.harvestContext = { libraryRollup, communityHint };
        }
      } catch (_) { /* agent unavailable — fall through with null context */ }
    }
    const plan = await lessonGenerator.generatePlan(p);
    return { ok: true, plan };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// Lesson body — sub-step F (v0.1). Expands a 6-field plan into intro_prose +
// path_prose[] + closing_prose. Fields 4 + 11 only per AMD-10 frozen scope.
ipcMain.handle('lesson:generateBody', async (_e, payload) => {
  try {
    const r = await lessonGenerator.generateLessonBody(payload || {});
    return { ok: true, body: r.body };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.2 Surface Finishing Track B B1 — pre-lesson body v2 (11-field).
// Generates the prep artifact (thesis / canonical_example / common_misconceptions /
// exit_proof / mechanism / jargon / note_connection) the tutor reads BEFORE
// LessonChat opens. Persists to vault/<slug>/lesson-N.body.json.
//
// Inputs: {slug, idx, plan?, goalContract?, audience?, learnerState?,
//          lessonTitle?, learnGoal?, force?}
// When plan/goalContract/sources are omitted, the handler reads them from
// vault state.json + sources.json. force=true bypasses the "exists" check.
const lessonBodyGen = require('./lib/lesson-body-generator');
ipcMain.handle('lesson:body:generate', async (_e, payload = {}) => {
  try {
    const slug = String(payload.slug || '').trim();
    const idx = Number.isFinite(payload.idx) ? Number(payload.idx) : -1;
    if (!slug) return { ok: false, error: 'BAD_INPUT', message: 'slug required' };
    if (idx < 0)  return { ok: false, error: 'BAD_INPUT', message: 'idx (>=0) required' };

    const bodyRel = `${slug}/lesson-${idx}.body.json`;
    const force = !!payload.force;
    if (!force && vault.exists(bodyRel)) {
      const cached = vault.readJSON(bodyRel, null);
      if (cached && cached.body) return { ok: true, body: cached.body, _meta: cached._meta || {}, cached: true };
    }

    // Read state + sources from vault when not provided in payload.
    const state = vault.readJSON(`${slug}/state.json`, null);
    const sources = vault.readJSON(`${slug}/sources.json`, []) || [];
    const lessonPlan = (state && Array.isArray(state.lessonPlan)) ? state.lessonPlan : [];
    const slot = lessonPlan[idx] || {};
    const plan = payload.plan || {
      objective: slot.learnGoal || slot.title || '',
      title: slot.title || '',
      path: Array.isArray(slot.path) ? slot.path : [],
      micro_proof: slot.micro_proof || {},
      // R3 — per-slot KP target stamped by resolveLessonShape (designSkeletonOnly).
      // Falls through undefined when slot has no stamp; lesson-body-generator
      // user prompt omits the KP-target directive in that case.
      target_count: (Number.isFinite(slot.target_count) && slot.target_count > 0) ? slot.target_count : undefined,
    };
    const goalContract = payload.goalContract || (state && state.goalContract) || {
      north_star_goal: (state && state.topic) || slug,
      current_level: 'self-directed adult learner',
    };
    const learnerState = payload.learnerState || (state && {
      known: state.mastered || [],
      unknown: state.gaps || [],
    }) || { known: [], unknown: [] };

    const r = await lessonBodyGen.generateLessonBodyV2({
      plan,
      goalContract,
      sources,
      audience: payload.audience,
      learnerState,
      lessonTitle: payload.lessonTitle || slot.title,
      learnGoal: payload.learnGoal || slot.learnGoal,
      idx,
      // V0.4.5 — pass archetype so validator applies HUMANITIES floor
      // (frameworks ≥2 + counter_cases ≥1). state.archetype is canonical
      // per Layer 3 archetype classification.
      pedagogicalArchetype: (state && state.archetype) || payload.pedagogicalArchetype || null,
    });

    // W3.3 Product Transfer — fire-and-judge BEFORE persist, so the body
    // file canonical-on-disk carries the optional product_transfer object
    // when the relevance score clears threshold. Silently no-ops when the
    // Product Pool (W3.1) has no blueprint for this slug yet.
    try {
      const _pt = require('./lib/product-transfer');
      const _kpId = (Array.isArray(r.body && r.body.knowledge_points) && r.body.knowledge_points[0] && (r.body.knowledge_points[0].id || r.body.knowledge_points[0].kp_id)) || null;
      const _ptResult = await _pt.triggerTransfer(slug, idx, _kpId, {
        lessonContext: { learnGoal: payload.learnGoal || slot.learnGoal, lessonTitle: payload.lessonTitle || slot.title },
      });
      if (_ptResult && _ptResult.fired && _ptResult.content) {
        r.body.product_transfer = {
          content: _ptResult.content,
          P: _ptResult.P,
          suggested_section: _ptResult.suggested_section,
          kp_id: _ptResult._meta && _ptResult._meta.kpId,
          generated_at: new Date().toISOString(),
          mocked: !!(_ptResult._meta && _ptResult._meta.mocked),
        };
      }
    } catch (err) { console.warn('[transfer:trigger] lesson-body post-hook err=', err && err.message); }

    const persisted = { body: r.body, _meta: r._meta, generated_at: new Date().toISOString() };
    vault.writeJSON(bodyRel, persisted);

    // v0.4.14 boot-8 — Concept Ledger post-write hook. Append one JSONL
    // record per lesson to vault/<slug>/concept-ledger.jsonl for cross-lesson
    // drift detection. Fire-and-forget; never blocks body persistence.
    try {
      const _cl = require('./lib/anti-slop/concept-ledger');
      const _concepts = _cl.extractConcepts(r.body || {});
      const _prereqs = _cl.extractPrerequisiteConcepts(r.body || {});
      const _defs = _cl.extractDefinitionPhrasesFromBody(r.body || {}, _concepts);
      _cl.recordLessonConcepts({
        slug, vaultRoot: vault.resolveRoot(), lessonIdx: idx,
        concepts: _concepts, prerequisite_concepts: _prereqs,
        claims_definitions: _defs,
      });
    } catch (_) { /* concept-ledger record failure must never block body gen */ }

    // v0.2 Track C C1 — when generator surfaces a drift_warning, persist a
    // sibling drift-warning.json + emit `lesson_body_drift_check` so the
    // trust-panel surface (Machino-C) can render "本节锚定 弱 · 主题漂移 N次".
    // Body itself is NOT blocked; the warning is observational.
    try {
      const dw = r._meta && r._meta.drift_warning;
      if (dw) {
        const warnRel = `${slug}/lesson-${idx}.body.drift-warning.json`;
        vault.writeJSON(warnRel, { warning: dw, generated_at: new Date().toISOString() });
        _hyphaAppendEvent('lesson_body_drift_check', {
          topic: slug,
          idx,
          passed: false,
          attempts: dw.attempts || 2,
          score: dw.score,
          flags: (dw.violations || []).slice(0, 6).map(v => ({ axis: v.axis, text: v.text })),
        });
      } else {
        _hyphaAppendEvent('lesson_body_drift_check', {
          topic: slug,
          idx,
          passed: true,
          attempts: 1,
          score: (r._meta && r._meta.drift_score) != null ? r._meta.drift_score : null,
        });
      }
    } catch (_) { /* drift surface must never break body gen */ }

    // Note System §3 — Living Note Reactivation. Non-blocking, post-body fire.
    // When idx > 0 (founder has prior lessons in this slug) we scan dormant
    // notes for ones worth resurfacing. Renderer NoteReactivationCard listens
    // on 'note:reactivation-found' (v0.5.1 surface) and shows a top-card
    // "上次学的 X 现在用得上 · 7 天前你写了 Y". Failures must not block.
    if (Number(idx) > 0) {
      setTimeout(() => {
        try {
          const living = require('./lib/note-system/living-reactivation');
          // Use the freshly-generated body text as the query anchor (thesis +
          // intro_prose + mechanism_explanation form the strongest signal).
          const b = r.body || {};
          const queryParts = [
            b.thesis,
            b.intro_prose,
            b.mechanism_explanation,
            b.closing_prose,
          ].filter((p) => typeof p === 'string' && p.trim().length > 0);
          const currentLessonText = queryParts.join('\n\n');
          living.findReactivationCandidates({
            slug,
            currentLessonIdx: Number(idx),
            currentLessonText,
            settings: _hyphaSettings(),
          }).then((res) => {
            if (res && Array.isArray(res.candidates) && res.candidates.length > 0) {
              _emitToRenderer('note:reactivation-found', {
                slug,
                lessonIdx: Number(idx),
                candidates: res.candidates,
                summary: res.summary,
              });
            }
            try {
              _hyphaAppendEvent('note_reactivation_scanned', {
                slug,
                lessonIdx: Number(idx),
                candidates_count: (res && res.candidates) ? res.candidates.length : 0,
                summary: (res && res.summary) || null,
              });
            } catch (_) {}
          }).catch((_err) => { /* non-fatal */ });
        } catch (_) { /* module load failure — non-fatal */ }
      }, 2000);
    }

    return { ok: true, body: r.body, _meta: r._meta, cached: false };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

// v0.2.1 — preview-and-approve regen. After PreviewCard's "需要修改" + free-text
// feedback submit, frontend calls this with { slug, lessonIdx, userFeedback }.
// We read the prior body off disk + invoke generateLessonBodyV2 with priorBody +
// userFeedback so the LLM sees both the rejected attempt + the feedback prose.
// Result is validated, drift-gated, hook_concrete-checked (existing flow), then
// written back atomically. Returns the new body so PreviewCard can re-render.
// On schema/drift/hook failure we keep the previous body intact + return error.
ipcMain.handle('curriculum:body:regenerate', async (_e, payload = {}) => {
  try {
    const slug = String(payload.slug || '').trim();
    const idx = Number.isFinite(payload.lessonIdx) ? Number(payload.lessonIdx) : -1;
    const userFeedback = String(payload.userFeedback || '').trim();
    if (!slug)               return { ok: false, error: 'BAD_INPUT', message: 'slug required' };
    if (idx < 0)             return { ok: false, error: 'BAD_INPUT', message: 'lessonIdx (>=0) required' };
    if (!userFeedback)       return { ok: false, error: 'BAD_INPUT', message: 'userFeedback required' };

    const bodyRel = `${slug}/lesson-${idx}.body.json`;
    if (!vault.exists(bodyRel)) return { ok: false, error: 'NO_PRIOR_BODY', message: 'no body.json to regenerate' };
    const cached = vault.readJSON(bodyRel, null);
    const priorBody = cached && cached.body;
    if (!priorBody) return { ok: false, error: 'NO_PRIOR_BODY', message: 'body.json present but unreadable' };

    const state = vault.readJSON(`${slug}/state.json`, null);
    const sources = vault.readJSON(`${slug}/sources.json`, []) || [];
    const lessonPlan = (state && Array.isArray(state.lessonPlan)) ? state.lessonPlan : [];
    const slot = lessonPlan[idx] || {};
    const plan = {
      objective: slot.learnGoal || slot.title || '',
      title: slot.title || '',
      path: Array.isArray(slot.path) ? slot.path : [],
      micro_proof: slot.micro_proof || {},
    };
    const goalContract = (state && state.goalContract) || {
      north_star_goal: (state && state.topic) || slug,
      current_level: 'self-directed adult learner',
    };
    const learnerState = (state && {
      known: state.mastered || [],
      unknown: state.gaps || [],
    }) || { known: [], unknown: [] };

    const r = await lessonBodyGen.generateLessonBodyV2({
      plan,
      goalContract,
      sources,
      learnerState,
      lessonTitle: slot.title,
      learnGoal: slot.learnGoal,
      idx,
      priorBody,
      userFeedback,
      pedagogicalArchetype: (state && state.archetype) || null,
    });

    // Persist the new body, mirroring lesson:body:generate.
    const persisted = { body: r.body, _meta: r._meta, generated_at: new Date().toISOString(), regen_feedback: userFeedback.slice(0, 500) };
    vault.writeJSON(bodyRel, persisted);

    // Drift sibling-write + event — mirrors lesson:body:generate (lines 541-563).
    try {
      const dw = r._meta && r._meta.drift_warning;
      const warnRel = `${slug}/lesson-${idx}.body.drift-warning.json`;
      if (dw) {
        vault.writeJSON(warnRel, { warning: dw, generated_at: new Date().toISOString() });
        _hyphaAppendEvent('lesson_body_drift_check', {
          topic: slug, idx, passed: false, attempts: dw.attempts || 2, score: dw.score,
          flags: (dw.violations || []).slice(0, 6).map(v => ({ axis: v.axis, text: v.text })),
          regen: true,
        });
      } else {
        // On clean regen, remove any stale drift-warning sibling from the prior body.
        try { if (vault.exists(warnRel)) vault.del(warnRel); }
        catch (delErr) {
          // boot-7: never silent-catch destructive vault ops. TypeError = API drift (vault.delete vs vault.del incident).
          if (delErr && delErr.name === 'TypeError') {
            console.error('[CRITICAL][lesson_body_regen] vault.del TypeError:', delErr.message, 'rel=', warnRel);
          } else if (delErr) {
            console.warn('[lesson_body_regen] vault.del drift-warning sibling failed:', delErr.message);
          }
        }
        _hyphaAppendEvent('lesson_body_drift_check', {
          topic: slug, idx, passed: true, attempts: 1,
          score: (r._meta && r._meta.drift_score) != null ? r._meta.drift_score : null,
          regen: true,
        });
      }
    } catch (_) {} // intentional: drift-check outer wrap is best-effort telemetry; never block lesson regen

    _hyphaAppendEvent('lesson_body_v2_regenerated', {
      topic: slug, idx,
      feedback_chars: userFeedback.length,
      ms: r._meta && r._meta.ms,
      provider: r._meta && r._meta.provider,
    });

    return { ok: true, body: r.body, _meta: r._meta };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

// v0.2 Surface Finishing Track B B1 — read existing body v2 if present.
// Returns {ok, body, _meta} when body.json exists, {ok:true, body:null} when
// not yet generated. UI uses this to render LESSON BRIEF header pre-stream.
ipcMain.handle('lesson:body:get', async (_e, { slug, idx } = {}) => {
  try {
    if (!slug || !Number.isFinite(idx)) return { ok: false, error: 'BAD_INPUT' };
    const bodyRel = `${slug}/lesson-${idx}.body.json`;
    if (!vault.exists(bodyRel)) return { ok: true, body: null, _meta: null };
    const cached = vault.readJSON(bodyRel, null);
    return { ok: true, body: cached && cached.body, _meta: cached && cached._meta };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

// Evidence Ledger v1.0 (boot-9, 2026-05-20) — per-claim provenance surface.
// Pure read against vault/<slug>/lesson-<idx>.body.json. Never throws on
// missing body — returns ok:true with grounding_pct:null so Trust Panel
// degrades gracefully. Legacy bodies (no evidence_ledger) yield ledger_present
// = false; orphan_claims enumerates ALL structural claims (nothing grounded
// via ledger). Pure-JS; no LLM; no mutation.
const _evidenceLedger = require('./lib/anti-slop/evidence-ledger');
ipcMain.handle('evidence:claim-grounding', async (_e, { slug, lesson_idx } = {}) => {
  try {
    if (!slug || !Number.isFinite(lesson_idx)) return { ok: false, error: 'BAD_INPUT', message: 'slug + lesson_idx required' };
    const bodyRel = `${String(slug).trim()}/lesson-${lesson_idx}.body.json`;
    if (!vault.exists(bodyRel)) {
      return { ok: true, grounding_pct: null, total_claims: 0, grounded_claims: 0, orphan_count: 0, ledger_present: false, reason: 'body file absent' };
    }
    const parsed = vault.readJSON(bodyRel, null);
    const body = parsed && (parsed.body || parsed);
    const sum = _evidenceLedger.summarize({ lessonBody: body });
    return {
      ok: true,
      grounding_pct: sum.grounding_pct,
      total_claims: sum.total_claims,
      grounded_claims: sum.grounded_claims,
      orphan_count: sum.orphan_claims.length,
      unique_sources_cited: sum.unique_sources_cited,
      ledger_present: sum.ledger_present,
      invalid_ref_count: sum.invalid_refs.length,
    };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

ipcMain.handle('evidence:orphan-claims', async (_e, { slug, lesson_idx } = {}) => {
  try {
    if (!slug || !Number.isFinite(lesson_idx)) return { ok: false, error: 'BAD_INPUT', message: 'slug + lesson_idx required' };
    const bodyRel = `${String(slug).trim()}/lesson-${lesson_idx}.body.json`;
    if (!vault.exists(bodyRel)) {
      return { ok: true, orphan_claims: [], invalid_refs: [], ledger_present: false };
    }
    const parsed = vault.readJSON(bodyRel, null);
    const body = parsed && (parsed.body || parsed);
    const orphans = _evidenceLedger.detectOrphanClaims({ lessonBody: body });
    const invalid = _evidenceLedger.validateEvidenceRefs({ lessonBody: body });
    return {
      ok: true,
      orphan_claims: orphans,
      invalid_refs: invalid,
      ledger_present: Array.isArray(body && body.evidence_ledger),
    };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

// Note System §3 — Web Note Engine (typed-edge graph over lesson notes).
// Mirrors `app/lib/note-system/web-note-engine.js`. Edges live in
// vault/<slug>/note-edges.jsonl (append-only). Renderer reaches them via
// preload's `window.ptor.notes.*` bridge. 5 typed edges, frozen at module
// level: cites / contradicts / extends / triggered-by / related.
//
// Namespace choice: `notes:` (plural) is the web/graph surface; `note:`
// (singular, see note:findReactivations + note:deposit below) is the
// per-note CRUD surface. Both live under Note System §3 of the blueprint.
const _notesWebEngine = require('./lib/note-system/web-note-engine');

ipcMain.handle('notes:addEdge', async (_e, { slug, edge } = {}) => {
  try {
    if (!slug) return { ok: false, error: 'BAD_INPUT', message: 'slug required' };
    return _notesWebEngine.addEdge(slug, edge || {});
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

ipcMain.handle('notes:listEdges', async (_e, { slug, filter } = {}) => {
  try {
    if (!slug) return { ok: false, error: 'BAD_INPUT', message: 'slug required' };
    const edges = _notesWebEngine.listEdges(slug, filter || {});
    return { ok: true, edges };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

ipcMain.handle('notes:removeEdge', async (_e, { slug, edge_id } = {}) => {
  try {
    if (!slug || !edge_id) return { ok: false, error: 'BAD_INPUT', message: 'slug + edge_id required' };
    return _notesWebEngine.removeEdge(slug, edge_id);
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

ipcMain.handle('notes:getNeighbors', async (_e, { slug, note_idx, type } = {}) => {
  try {
    if (!slug || !Number.isInteger(note_idx)) {
      return { ok: false, error: 'BAD_INPUT', message: 'slug + integer note_idx required' };
    }
    const { incoming, outgoing } = _notesWebEngine.getNeighbors(slug, note_idx, type ? { type } : {});
    return { ok: true, incoming, outgoing };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

ipcMain.handle('notes:inferEdges', async (_e, { slug, lessonIdx, lessonText, settings } = {}) => {
  try {
    if (!slug || !Number.isInteger(lessonIdx)) {
      return { ok: false, error: 'BAD_INPUT', message: 'slug + integer lessonIdx required' };
    }
    return await _notesWebEngine.inferEdgesFromText(slug, lessonIdx, lessonText || '', settings || {});
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

// Note System §3 v0.5+ — Living Note Reactivation. Surfaces 1-3 dormant
// notes (≥ 7 days unchanged) relevant to the lesson the user is about to
// start. Pure read; never writes vault. Renderer (NoteReactivationCard,
// shipping v0.5.1) listens on `note:reactivation-found` or invokes this
// directly via the preload bridge `notes.findReactivations(...)`.
ipcMain.handle('note:findReactivations', async (_e, payload = {}) => {
  try {
    const slug = String(payload.slug || '').trim();
    const currentLessonIdx = Number.isFinite(Number(payload.currentLessonIdx))
      ? Number(payload.currentLessonIdx) : -1;
    const currentLessonText = String(payload.currentLessonText || '');
    if (!slug) return { ok: false, error: 'BAD_INPUT', message: 'slug required' };
    const living = require('./lib/note-system/living-reactivation');
    const r = await living.findReactivationCandidates({
      slug,
      currentLessonIdx,
      currentLessonText,
      settings: _hyphaSettings(),
      opts: payload.opts || {},
    });
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

// β18 · Entropy Reduction Cycle v0 — Note System §3 subsystem (2026-05-16).
// 同主题灵感散落跨课 → 手动 merge 到 canonical 笔记。v0 无 LLM, surgical CRUD.
// 5 IPC verbs map 1:1 onto app/lib/note-system/entropy-reduction.js exports.
// All return the standard hypha envelope ({ ok, ... } | { ok:false, error }).
ipcMain.handle('entropy:collect-fragments', async (_e, payload = {}) => {
  return require('./lib/note-system/entropy-reduction').collectFragments(payload || {});
});
ipcMain.handle('entropy:list-canonical', async (_e, payload = {}) => {
  return require('./lib/note-system/entropy-reduction').listCanonicalNotes(payload || {});
});
ipcMain.handle('entropy:read-canonical', async (_e, payload = {}) => {
  return require('./lib/note-system/entropy-reduction').readCanonicalNote(payload || {});
});
ipcMain.handle('entropy:write-canonical', async (_e, payload = {}) => {
  return require('./lib/note-system/entropy-reduction').writeCanonicalNote(payload || {});
});
ipcMain.handle('entropy:delete-canonical', async (_e, payload = {}) => {
  return require('./lib/note-system/entropy-reduction').deleteCanonicalNote(payload || {});
});

// W3.3 Product Transfer — renderer bridges. `compute` is a read-only score
// pull (preview the relevance without firing the body update); `trigger`
// is the full pipeline (judge + generate + events.jsonl row + return
// content). Both delegate to app/lib/product-transfer.js. The post-body
// auto-fire above in lesson:body:generate is the production path; these
// IPCs exist so the UI can re-judge on demand (e.g. user just updated the
// Product Pool blueprint and wants to retroactively transfer past lessons).
ipcMain.handle('transfer:compute', async (_e, args = {}) => {
  try {
    const r = require('./lib/product-transfer').computeRelevance(args || {});
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});
ipcMain.handle('transfer:trigger', async (_e, args = {}) => {
  try {
    const r = await require('./lib/product-transfer').triggerTransfer(args.slug, args.lessonIdx, args.kpId, args.options || {});
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

// ── W3.2 Product Blueprint ────────────────────────────────────────────────
// 10-section structured product spec editor (BLUEPRINT.md §11.2). Three IPC
// verbs back the renderer-side editor at app/design/screen-product-blueprint.jsx.
// Storage: vault/<slug>/product/blueprint.md (one file per product slug).
// Render / parse / validate live in app/lib/blueprint-template.js so editor
// and any future server-side caller share the same schema.
const _blueprintTemplate = require('./lib/blueprint-template');

function _blueprintRel(slug) {
  if (!slug || typeof slug !== 'string') return null;
  // Defensive: refuse path-traversal. Slugs are flat folder names by convention.
  if (slug.includes('/') || slug.includes('\\') || slug.startsWith('.')) return null;
  return `${slug}/product/blueprint.md`;
}

function _readBlueprintMarkdown(rel) {
  // vault.read returns { ok, frontmatter, body } via `_meta`-style envelope in
  // some callsites, raw string in others. Normalize to a string here so the
  // template parser sees only the markdown payload.
  const raw = vault.read(rel);
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    if (typeof raw.body === 'string') return raw.body;
    if (typeof raw.markdown === 'string') return raw.markdown;
    if (typeof raw.text === 'string') return raw.text;
  }
  return String(raw);
}

ipcMain.handle('creation:getBlueprint', async (_e, { slug } = {}) => {
  try {
    const rel = _blueprintRel(slug);
    if (!rel) return { ok: false, error: 'BAD_INPUT', message: 'slug missing or unsafe' };
    if (!vault.exists(rel)) {
      return {
        ok: true,
        sections: _blueprintTemplate.emptySections(),
        frontmatter: { slug, name: '', product_type: '', schema_version: 1 },
        markdown: '',
        existed: false,
      };
    }
    const md = _readBlueprintMarkdown(rel);
    const parsed = _blueprintTemplate.parseBlueprint(md);
    return { ok: true, sections: parsed.sections, frontmatter: parsed.frontmatter, markdown: md, existed: true };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

ipcMain.handle('creation:updateBlueprint', async (_e, { slug, sections } = {}) => {
  try {
    const rel = _blueprintRel(slug);
    if (!rel) return { ok: false, error: 'BAD_INPUT', message: 'slug missing or unsafe' };
    if (!sections || typeof sections !== 'object') {
      return { ok: false, error: 'BAD_INPUT', message: 'sections must be object' };
    }
    // Preserve created_at across writes (only updated_at changes per save).
    // Spec §冲突: last-write-wins; we read prior frontmatter to keep timestamps
    // stable, then overwrite with the new sections.
    let priorFrontmatter = null;
    if (vault.exists(rel)) {
      try {
        priorFrontmatter = _blueprintTemplate.parseBlueprint(_readBlueprintMarkdown(rel)).frontmatter || null;
      } catch (_) { priorFrontmatter = null; }
    }
    const now = new Date().toISOString();
    const productData = {
      slug,
      name: (priorFrontmatter && priorFrontmatter.name) || '',
      productType: (priorFrontmatter && (priorFrontmatter.product_type || priorFrontmatter.productType)) || '',
      created_at: (priorFrontmatter && priorFrontmatter.created_at) || now,
      updated_at: now,
      ...sections,
    };
    const md = _blueprintTemplate.renderBlueprint(productData);
    // Ensure `<slug>/product/` dir exists for first-save. mkdir is idempotent
    // in vault.js — failure here is silent (vault.write below will surface).
    if (typeof vault.mkdir === 'function') {
      try { vault.mkdir(`${slug}/product`); } catch (_) { /* directory may already exist */ }
    }
    vault.write(rel, md);
    return { ok: true, bytesWritten: Buffer.byteLength(md, 'utf8'), updated_at: now };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

ipcMain.handle('creation:validateBlueprint', async (_e, { slug } = {}) => {
  try {
    const rel = _blueprintRel(slug);
    if (!rel) return { ok: false, error: 'BAD_INPUT', message: 'slug missing or unsafe' };
    if (!vault.exists(rel)) {
      const empty = _blueprintTemplate.emptySections();
      const result = _blueprintTemplate.validateBlueprint(empty);
      return { ok: true, ...result, existed: false };
    }
    const md = _readBlueprintMarkdown(rel);
    const parsed = _blueprintTemplate.parseBlueprint(md);
    const result = _blueprintTemplate.validateBlueprint(parsed.sections);
    return { ok: true, ...result, existed: true };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

// ── Library System (BLUEPRINT System 5) ────────────────────────────────────
// Per-vault book shelf — user uploads PDF/MD/TXT, stored under
// `<vault>/data/library/<id>.{json,txt}`. Course generation harvest path will
// (next batch) call library.queryLibrary to inject relevant chunks before
// falling out to web search.
const _library = require('./lib/library');

// R-LIB v0.1 (2026-05-12) — once per session, retrofit section-type tags onto
// books uploaded before the classifier shipped. Idempotent: writes manifest
// only when at least 1 chunk lacks .type. Quick (regex over cached text), no
// network. Fires on first library:list call so it's behind the UI mount, not
// blocking app boot.
let _libBackfillDone = false;
function _maybeBackfillLibrary() {
  if (_libBackfillDone) return;
  _libBackfillDone = true;
  try {
    const r = _library.backfillSectionTypes(vault.resolveRoot());
    if (r.updated > 0) {
      console.log(`[library] backfill: ${r.updated}/${r.scanned} manifests retrofitted with section-type tags`);
    }
  } catch (_) { /* never block list on backfill failure */ }
}

ipcMain.handle('library:list', async () => {
  try {
    _maybeBackfillLibrary();
    return { ok: true, books: _library.listBooks(vault.resolveRoot()) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// Phase E.0 (2026-05-18) — Library Coverage gate. Renderer calls before
// chain:create to check whether the user's Library has enough material for
// the goal. Returns { has_coverage, hit_count, book_count, recommended? } —
// if has_coverage=false, renderer shows recommended-books modal with upload
// option. Includes recommendBooks LLM call inline when has_coverage=false
// so 1 IPC roundtrip resolves both ("do I need to upload?" + "what to upload").
//
// Phase F.2 (2026-05-18) — `crystallizedTags` param. When passed (from
// goal-crystallizer output), recommendBooks switches to FIT-OVER-POPULAR mode:
// LLM prefers books that best fit THIS user's specific cut, not just famous
// canon. niche_factor=high forces ≥ 1 cold pick.
ipcMain.handle('library:coverage', async (_e, { goal, archetype, includeRecommendation, crystallizedTags } = {}) => {
  try {
    if (!goal || !String(goal).trim()) return { ok: false, error: 'goal required' };
    const coverage = require('./lib/library/coverage');
    const vaultRoot = vault.resolveRoot();
    const settings = _hyphaSettings();
    const cov = await coverage.assessCoverage({ goal, archetype, vaultRoot, settings });
    let recommended = null;
    // Skip LLM call if already covered OR caller explicitly opted out.
    if (cov && !cov.has_coverage && includeRecommendation !== false) {
      recommended = await coverage.recommendBooks({ goal, archetype, crystallizedTags, settings });
    }
    return { ok: true, coverage: cov, recommended };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// Phase F.0 (2026-05-18) — Goal Crystallizer IPC. Two stages:
//   goal:crystallize:questions — generate 3-5 multi-choice questions for the
//   draft goal. Renderer shows wizard, user picks A/B/C/D per question.
//   goal:crystallize:synthesize — synthesize answers into specific +
//   verifiable crystallized_goal + structured tags.
ipcMain.handle('goal:crystallize:questions', async (_e, { draftGoal, archetype } = {}) => {
  try {
    if (!draftGoal || !String(draftGoal).trim()) return { ok: false, error: 'draftGoal required' };
    const gc = require('./lib/creation/goal-crystallizer');
    const settings = _hyphaSettings();
    const r = await gc.generateCrystallizerQuestions({ draftGoal, archetype, settings });
    return r;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('goal:crystallize:synthesize', async (_e, { draftGoal, archetype, answers } = {}) => {
  try {
    if (!draftGoal || !String(draftGoal).trim()) return { ok: false, error: 'draftGoal required' };
    if (!Array.isArray(answers) || answers.length === 0) return { ok: false, error: 'answers array required' };
    const gc = require('./lib/creation/goal-crystallizer');
    const settings = _hyphaSettings();
    const r = await gc.crystallizeGoal({ draftGoal, archetype, answers, settings });
    return r;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// Phase G.2 (2026-05-18) — 2-stage wizard followup. Called after user answers
// the 3 broad questions. Returns 5 instance-level deep questions anchored to
// the broad answers (each deep Q references a broad pick by name).
ipcMain.handle('goal:crystallize:followup', async (_e, { draftGoal, archetype, broadAnswers } = {}) => {
  try {
    if (!draftGoal || !String(draftGoal).trim()) return { ok: false, error: 'draftGoal required' };
    if (!Array.isArray(broadAnswers) || broadAnswers.length === 0) return { ok: false, error: 'broadAnswers array required' };
    const gc = require('./lib/creation/goal-crystallizer');
    const settings = _hyphaSettings();
    const r = await gc.generateFollowupQuestions({ draftGoal, archetype, broadAnswers, settings });
    return r;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// Reader path — fetch a book's full manifest (incl. chunks[]) for the MD viewer.
ipcMain.handle('library:getBook', async (_e, { bookId } = {}) => {
  try {
    if (!bookId) return { ok: false, error: 'bookId required' };
    return _library.getBook({ vaultRoot: vault.resolveRoot(), id: bookId });
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// MarkItDown availability probe — UI calls this on Library mount to show
// install banner when the Python subprocess isn't available.
ipcMain.handle('tool:markitdownStatus', async (_e, { fresh } = {}) => {
  try {
    const md = require('./lib/markitdown-bridge');
    const status = await md.checkAvailability({ fresh: !!fresh });
    return {
      ok: true,
      available: status.available,
      version: status.version,
      error: status.error,
      acceptedExtensions: md.listAllAcceptedExtensions(),
      convertibleExtensions: md.listConvertibleExtensions(),
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// R-LIB Day 6 (2026-05-12) — surface book rollup + community hint to UI.
// Both read from agent.js module-level caches populated by the most-recent
// harvest() call for the given topic. Returns null when no cache present
// (caller renders empty-state).
ipcMain.handle('library:rollupForTopic', async (_e, topic) => {
  try {
    const agentMod = require('./agent');
    return { ok: true, rollup: agentMod.getLibraryRollupForTopic(topic) || null };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('community:hintForTopic', async (_e, topic) => {
  try {
    const agentMod = require('./agent');
    return { ok: true, hint: agentMod.getCommunityHintForTopic(topic) || null };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// Knowledge Source System §5 — archetype-lane priority config. Returns the
// lane config for an archetype (priority_sources / forbidden_sources /
// register_hint / label) so the renderer can preview which source kit will
// bias the harvest before the user commits a course-create. Config-only
// IPC; does NOT touch harvest() control flow today.
ipcMain.handle('harvest:getLaneConfig', async (_e, args) => {
  try {
    const { archetype } = args || {};
    const lanes = require('./lib/harvest/archetype-lanes');
    const lane = lanes.getLaneConfig(archetype);
    if (!lane) return { ok: true, archetype: archetype || null, lane: null };
    // Materialize to plain objects (frozen lane is read-only by design;
    // IPC structured-clone strips the freeze, which is fine for renderer
    // consumption — the renderer treats config as immutable by convention).
    const out = {
      label: lane.label,
      register_hint: lane.register_hint || '',
      priority_sources: lane.priority_sources.map((s) => ({
        id: s.id,
        url_template: s.url_template,
        notes: s.notes || '',
      })),
      forbidden_sources: Array.from(lane.forbidden_sources),
    };
    return { ok: true, archetype, lane: out };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// Commons (R-LIB Day 6) — list available packs + match by topic. Listing is
// cheap (file-scan). install + isPackStale exposed for completeness.
const _community = require('./lib/community');
ipcMain.handle('commons:listPacks', async () => {
  try {
    return { ok: true, packs: _community.listPacks() };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:queryPacks', async (_e, args) => {
  try {
    const { topic, lang } = args || {};
    return { ok: true, packs: _community.queryPacks(topic, { lang }) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:installPack', async (_e, packId) => {
  try {
    return _community.installPack(packId);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// W6.5 Commons full — Pack Intelligence Card (15 fields) + Security Layer
// (banned-ext / binary-magic / prompt-injection / URL phishing / dangerous-
// ref scans + LLM sanitizer) + Source Trust (5-signal weighted) + License
// Layer (10 LICENSE_TYPES + 4 usage intents). Layered on top of R-LIB
// community.js — does NOT alter the underlying pack scan; enriches results
// for the UI and downstream consumers (Lesson System / Product Pool).
const _commonsPIC = require('./lib/commons/pack-intelligence-card');
const _commonsSec = require('./lib/commons/security-layer');
const _commonsTrust = require('./lib/commons/source-trust');
const _commonsLic = require('./lib/commons/license-layer');

ipcMain.handle('commons:generateCard', async (_e, args) => {
  try {
    const { pack, userContext } = args || {};
    if (!pack) return { ok: false, error: 'pack required' };
    return { ok: true, card: _commonsPIC.generateCard(pack, userContext || {}) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:rankPacks', async (_e, args) => {
  try {
    const { packs, userContext } = args || {};
    return { ok: true, packs: _commonsPIC.rankPacks(packs || [], userContext || {}) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:recommendReason', async (_e, args) => {
  try {
    const { pack, userContext } = args || {};
    return { ok: true, reason: _commonsPIC.getRecommendationReason(pack, userContext || {}) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:scanPack', async (_e, args) => {
  try {
    const { packPath } = args || {};
    if (!packPath) return { ok: false, error: 'packPath required' };
    return { ok: true, scan: _commonsSec.scanPack(packPath) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:sanitize', async (_e, args) => {
  try {
    const { content } = args || {};
    return { ok: true, ...(_commonsSec.sanitizeForLLM(content || '')) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:safetyLevel', async (_e, args) => {
  try {
    const { scan } = args || {};
    return { ok: true, level: _commonsSec.assessSafetyLevel(scan) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:trustScore', async (_e, args) => {
  try {
    const { pack } = args || {};
    return { ok: true, ...(_commonsTrust.trustBreakdown(pack)) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:license', async (_e, args) => {
  try {
    const { pack } = args || {};
    return { ok: true, license: _commonsLic.parseLicense(pack) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:checkUsage', async (_e, args) => {
  try {
    const { pack, intent } = args || {};
    return { ok: true, ...(_commonsLic.checkUsage(pack, intent)) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// W6.6 Commons System §6 — Pack Export (Hypha's only differentiation point).
// Bundles vault/<slug>/ into a portable .hypha-pack with manifest. Events.jsonl
// + sessions/ excluded by default for privacy.
const _commonsPackExport = require('./lib/commons/pack-export');

ipcMain.handle('commons:exportPack', async (_e, args) => {
  try {
    const { slug, opts } = args || {};
    if (!slug) return { ok: false, error: 'slug required' };
    return await _commonsPackExport.exportPack(slug, opts || {});
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:listExportedPacks', async () => {
  try {
    return _commonsPackExport.listExportedPacks();
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// W6.6 Commons System §6 — Pack Import (β13, reverse of α13 exportPack).
// Reads .hypha-pack, validates schema + per-file SHA256, lands into a fresh
// vault/<new_slug>/, rewrites source_slug in .jsonl, writes provenance,
// emits pack_imported event. Failure rolls back the half-created slug dir.
const _commonsPackImport = require('./lib/commons/pack-import');

ipcMain.handle('commons:importPack', async (_e, args) => {
  try {
    const { packPath, opts } = args || {};
    if (!packPath) return { ok: false, error: 'packPath required' };
    return await _commonsPackImport.importPack(packPath, opts || {});
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:inspectPack', async (_e, args) => {
  try {
    const { packPath } = args || {};
    if (!packPath) return { ok: false, error: 'packPath required' };
    return _commonsPackImport.inspectPack(packPath);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// γ17 Commons System §6 子 — Pack Distiller (v0). Editorial preview card
// composed from manifest + selective in-memory sampling of pack contents.
// Does NOT extract to vault — read-only, returns shaped distill object.
ipcMain.handle('commons:distillPack', async (_e, p = {}) => {
  try {
    return await require('./lib/commons/pack-distiller').distillPack(p || {});
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// boot-5 P12 GAP-1 — Commons file picker for .hypha-pack import flow.
// Mirrors source:pick shape but filters to .hypha-pack extension so the
// renderer's import flow (screen-commons.jsx onClickImport) lands on the
// canonical IPC instead of falling back to source:pick which has wrong
// extension filter (PDF/MD/TXT). Closes the lifecycle gap where users
// could not invoke import via the default UI path.
ipcMain.handle('commons:pickPackFile', async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win || undefined, {
      title: 'pick a .hypha-pack file',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        { name: 'Hypha Pack', extensions: ['hypha-pack'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) {
      return { ok: false, cancelled: true };
    }
    const filePath = res.filePaths[0];
    return { ok: true, filePath, fileName: require('path').basename(filePath) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// boot-5 P12 GAP-2 — commons:deletePack. Removes both <pack_id>.hypha-pack
// and the sibling <pack_id>.manifest.json under vault/.commons/packs/.
// pack_id is validated against the same shape pack-export.js writes; we
// reject path traversal and refuse anything that does not start with the
// `hypha-pack-` prefix used by exportPack. listExportedPacks() reflects
// the change on next call.
ipcMain.handle('commons:deletePack', async (_e, args = {}) => {
  try {
    const packId = args && args.packId;
    if (!packId || typeof packId !== 'string') {
      return { ok: false, error: 'packId required' };
    }
    // Shape guard — pack_id always starts with `hypha-pack-` per pack-export.js
    // and contains only [a-z0-9-]; reject anything else outright.
    if (!/^hypha-pack-[a-z0-9-]+$/i.test(packId)) {
      return { ok: false, error: 'invalid packId shape' };
    }
    if (packId.includes('..') || packId.includes('/') || packId.includes('\\')) {
      return { ok: false, error: 'invalid packId shape' };
    }
    const root = vault.resolveRoot();
    const packsDir = path.join(root, '.commons', 'packs');
    const packPath = path.join(packsDir, `${packId}.hypha-pack`);
    const manifestPath = path.join(packsDir, `${packId}.manifest.json`);
    // Resolve + containment guard — prevent symlink/relative escape.
    const resolvedDir = path.resolve(packsDir);
    if (!path.resolve(packPath).startsWith(resolvedDir) ||
        !path.resolve(manifestPath).startsWith(resolvedDir)) {
      return { ok: false, error: 'path escapes pack dir' };
    }
    let removedPack = false;
    let removedManifest = false;
    try { if (fs.existsSync(packPath)) { fs.unlinkSync(packPath); removedPack = true; } } catch (err) {
      return { ok: false, error: `pack unlink failed: ${err.message}` };
    }
    try { if (fs.existsSync(manifestPath)) { fs.unlinkSync(manifestPath); removedManifest = true; } } catch (err) {
      return { ok: false, error: `manifest unlink failed: ${err.message}` };
    }
    if (!removedPack && !removedManifest) {
      return { ok: false, error: 'pack not found' };
    }
    return { ok: true, pack_id: packId, removed_pack: removedPack, removed_manifest: removedManifest };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// W7.3 Citation + Global Trust — global cross-module citation system that
// promotes W6.5 Commons-only trust/license/security primitives up to
// Lesson/Note/Spark/Radar surfaces. Single source of truth lives at
// app/lib/citation-system; renderers read via window.ptor.citation.*.
const _w73Cs = require('./lib/citation-system');

ipcMain.handle('citation:create', async (_e, args) => {
  try { return { ok: true, citation: _w73Cs.createCitation(args || {}) }; }
  catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('citation:parse', async (_e, args) => {
  try {
    const { text } = args || {};
    return { ok: true, tokens: _w73Cs.parseCitationToken(text || '') };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('citation:render', async (_e, args) => {
  try {
    const { citation, language } = args || {};
    return { ok: true, markdown: _w73Cs.renderCitationFootnote(citation, language) };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('citation:format', async (_e, args) => {
  try {
    const { citation } = args || {};
    return { ok: true, attribution: _w73Cs.formatAttribution(citation) };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('citation:extractURLs', async (_e, args) => {
  try {
    const { text } = args || {};
    return { ok: true, urls: _w73Cs.extractURLs(text || '') };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('citation:classifyURL', async (_e, args) => {
  try {
    const { url } = args || {};
    return { ok: true, ...(_w73Cs.classifyURL(url)) };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('citation:scanContent', async (_e, args) => {
  try {
    const { text } = args || {};
    return { ok: true, ...(_w73Cs.scanContentForExternalLinks(text || '')) };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('citation:copyrightRisk', async (_e, args) => {
  try {
    return { ok: true, ...(_w73Cs.assessCopyrightRisk(args || {})) };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('citation:getBoundary', async (_e, args) => {
  try {
    const { risk } = args || {};
    return { ok: true, warning: _w73Cs.getBoundaryWarning(risk) };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('citation:globalTrust', async (_e, args) => {
  try {
    const { citation, opts } = args || {};
    return { ok: true, ...(_w73Cs.computeGlobalTrust(citation, opts || {})) };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

ipcMain.handle('citation:rank', async (_e, args) => {
  try {
    const { citations, optsPerCitation } = args || {};
    return { ok: true, ranked: _w73Cs.rankCitations(citations || [], optsPerCitation || []) };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

// W7.3 Citation System — coverage gate. Returns % of claims with valid
// citations for a single lesson (when lessonIdx given) or aggregated
// across every lesson-N.body.json under the slug. Reads body files via
// vault.readJSON + vault.listDir — best-effort; missing files surface as 0.
ipcMain.handle('citation:verifyCoverage', async (_e, args) => {
  try {
    const a = args || {};
    const slug = String(a.slug || '').trim();
    if (!slug) return { ok: false, error: 'slug required' };
    const threshold = Number.isFinite(a.threshold) ? a.threshold : _w73Cs.DEFAULT_COVERAGE_THRESHOLD_PCT;
    const lessonIdx = (typeof a.lessonIdx === 'number') ? a.lessonIdx : null;

    if (lessonIdx != null) {
      const parsed = vault.readJSON(`${slug}/lesson-${lessonIdx}.body.json`, null);
      if (!parsed) {
        return { ok: true, coverage_pct: 0, total_claims: 0, cited_count: 0, sources: 0, lessons: 0, gate_passed: true, threshold, reason: 'body file absent' };
      }
      const body = parsed.body || parsed;
      const r = _w73Cs.computeBodyCoverage(body, { threshold });
      return { ok: true, lessons: 1, ...r };
    }

    // Aggregate across all lesson-N.body.json files under slug/.
    const entries = vault.listDir(slug) || [];
    const bodies = [];
    for (const e of entries) {
      const name = (e && (e.name || e.file || e)) || '';
      if (typeof name !== 'string') continue;
      if (!/^lesson-\d+\.body\.json$/.test(name)) continue;
      const parsed = vault.readJSON(`${slug}/${name}`, null);
      if (!parsed) continue;
      bodies.push(parsed.body || parsed);
    }
    const agg = _w73Cs.aggregateCoverage(bodies, { threshold });
    return { ok: true, ...agg };
  } catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

// library:pickAndAdd — open OS file picker (multi-select), extract each via
// source-extractor, persist manifest. Returns { ok, added: [{id, title}], errors }.
// Streams per-file progress on 'library:upload-progress' channel so the UI can
// show OCR page counts during scan-PDF processing (Tesseract pipeline).
ipcMain.handle('library:pickAndAdd', async (event) => {
  try {
    const { dialog, app } = require('electron');
    const win = require('electron').BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(win || undefined, {
      title: '选择书 (MD 直读, 其余经 MarkItDown 自动转换)',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All supported', extensions: ['md', 'markdown', 'txt', 'pdf', 'docx', 'pptx', 'xlsx', 'xls', 'epub', 'html', 'htm', 'csv', 'json', 'xml'] },
        { name: 'Markdown / Text', extensions: ['md', 'markdown', 'txt'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Office', extensions: ['docx', 'pptx', 'xlsx', 'xls'] },
        { name: 'Web / EPUB', extensions: ['epub', 'html', 'htm'] },
        { name: 'Data', extensions: ['csv', 'json', 'xml'] },
      ],
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { ok: false, cancelled: true };
    }
    // Tesseract.js lang loading:
    //   langPath (URL)  — where to download .traineddata.gz from
    //   cachePath (dir) — local folder where downloads cache after first fetch
    // Default: _fast variant (~3MB chi_sim, 2.5x faster than _best, 2-4% lower
    // accuracy — acceptable for keyword harvest retrieval). Power-user can flip
    // to _best via HYPHA_OCR_QUALITY=best env var (ocr.js reads it).
    const TESSDATA_CDN = (process.env.HYPHA_OCR_QUALITY || '').toLowerCase() === 'best'
      ? 'https://tessdata.projectnaptha.com/4.0.0_best'
      : 'https://tessdata.projectnaptha.com/4.0.0_fast';
    const tessdataPath = require('path').join(app.getPath('userData'), 'tessdata');
    try { require('fs').mkdirSync(tessdataPath, { recursive: true }); } catch (_) {}

    const added = [];
    const errors = [];
    const totalFiles = res.filePaths.length;
    for (let fi = 0; fi < res.filePaths.length; fi++) {
      const fp = res.filePaths[fi];
      const fileName = require('path').basename(fp);
      const emit = (p) => {
        try { event.sender.send('library:upload-progress', { file: fileName, fileIdx: fi, totalFiles, ...p }); } catch (_) {}
      };
      emit({ stage: 'start' });
      try {
        const r = await _library.addBook({
          vaultRoot: vault.resolveRoot(),
          filePath: fp,
          ocrLangPath: TESSDATA_CDN,
          ocrCachePath: tessdataPath,
          onProgress: emit,
        });
        if (r && r.ok) {
          added.push({
            id: r.book.id,
            title: r.book.title,
            author: r.book.author,
            source_file_name: r.book.source_file_name,
            parsed_level: r.book.parsed_level || 'unknown',
          });
          emit({ stage: 'done', bookId: r.book.id, title: r.book.title });

          // Phase B Gap 4 (2026-05-17) — fire-and-forget GraphRAG build on
          // every new book. Progress streams on 'library:graph-progress' so
          // the UI can render a per-book graph-build indicator (separate
          // channel from 'library:upload-progress' which is finished by now).
          // Failure here must NOT block upload success — BM25 fallback in
          // _harvestLibrary covers the no-graph case.
          (async () => {
            try {
              const graphRag = require('./lib/graph-rag');
              const bookId = r.book.id;
              await graphRag.buildGraph(bookId, {
                vaultRoot: vault.resolveRoot(),
                settings: {},
                onProgress: (stage, payload) => {
                  try {
                    event.sender.send('library:graph-progress', {
                      bookId,
                      stage,
                      ...(payload || {}),
                    });
                  } catch (_) {}
                },
              });
            } catch (e) {
              console.warn('[library:pickAndAdd graph-rag build] failed:', e && e.message);
              try {
                event.sender.send('library:graph-progress', {
                  bookId: r.book.id,
                  stage: 'graph-rag:failed',
                  error: (e && e.message) || String(e),
                });
              } catch (_) {}
            }
          })();
        } else {
          errors.push({ file: fp, error: (r && r.error) || 'unknown' });
          emit({ stage: 'error', error: (r && r.error) || 'unknown' });
        }
      } catch (e) {
        errors.push({ file: fp, error: (e && e.message) || String(e), stack: e && e.stack });
        emit({ stage: 'error', error: (e && e.message) || String(e) });
      }
    }
    // Surface concatenated errors as `error` string so the UI's generic
    // r.error fallback shows a real message instead of "upload failed".
    let errorString = null;
    if (errors.length > 0) {
      errorString = errors.map(x => `${require('path').basename(x.file)}: ${x.error}`).join(' · ');
      console.error('[library:pickAndAdd] errors:', errors);
    }
    // 2026-05-18 bug repro: UI handlePick reads r.books, but handler historically
    // returned r.added. Mismatch → UI's Array.isArray(r.books) guard fails →
    // setUploadedBooks never updates → user sees file picked then "disappear".
    // Surface BOTH keys for backward-compat with any other reader.
    return { ok: added.length > 0, added, books: added, errors, error: errorString };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('library:remove', async (_e, id) => {
  try {
    return _library.removeBook({ vaultRoot: vault.resolveRoot(), id });
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('library:query', async (_e, { topic, k } = {}) => {
  try {
    const results = _library.queryLibrary({ vaultRoot: vault.resolveRoot(), topic, k });
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// Phase B Gap 4 (2026-05-17) — manual graph rebuild for a single book.
// UI surface so user can re-run extraction after a model upgrade, schema
// bump, or to recover from a build that crashed mid-way.
ipcMain.handle('library:rebuildGraph', async (event, { bookId } = {}) => {
  try {
    if (!bookId) return { ok: false, error: 'bookId required' };
    const graphRag = require('./lib/graph-rag');
    const r = await graphRag.buildGraph(bookId, {
      vaultRoot: vault.resolveRoot(),
      settings: {},
      onProgress: (stage, payload) => {
        try {
          event.sender.send('library:graph-progress', { bookId, stage, ...(payload || {}) });
        } catch (_) {}
      },
    });
    return r;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('library:rebuildAllGraphs', async (event) => {
  try {
    const graphRag = require('./lib/graph-rag');
    const r = await graphRag.rebuildAll({
      vaultRoot: vault.resolveRoot(),
      settings: {},
      onProgress: (stage, payload) => {
        try {
          event.sender.send('library:graph-progress', { stage, ...(payload || {}) });
        } catch (_) {}
      },
    });
    return r;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// ── W6.1 Book Grounding (BLUEPRINT §4) ─────────────────────────────────────
// Per-book 8-field Grounding Profile + multi-book 6-field Synthesis.
// 课程生成前必须先建地基; 流程: User Goal → 选参考书 → Profile (per book) →
// Synthesis (multi-book) → 喂 designSkeletonOnly SYSTEM_PROMPT. Spec at
// `specs/bibliography-grounding.md`.
const _grounding = require('./lib/grounding');

ipcMain.handle('grounding:buildProfile', async (_e, { bookId, goalContract, slug, force } = {}) => {
  try {
    if (!bookId || !slug) return { ok: false, error: 'bookId + slug required' };
    const profile = await _grounding.buildBookProfile(bookId, goalContract || null, {
      vaultRoot: vault.resolveRoot(), slug, force: !!force,
    });
    return { ok: true, profile };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('grounding:getProfile', async (_e, { bookId, slug } = {}) => {
  try {
    if (!bookId || !slug) return { ok: false, error: 'bookId + slug required' };
    const profile = _grounding.getCachedProfile(bookId, slug, { vaultRoot: vault.resolveRoot() });
    return { ok: true, profile };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('grounding:refreshAll', async (_e, { slug, goalContract, bookIds, force } = {}) => {
  try {
    if (!slug) return { ok: false, error: 'slug required' };
    const profiles = await _grounding.refreshAllProfiles(slug, goalContract || null, bookIds || [], {
      vaultRoot: vault.resolveRoot(), force: !!force,
    });
    return { ok: true, profiles };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('grounding:synthesize', async (_e, { slug, goalContract, bookIds, force } = {}) => {
  try {
    if (!slug) return { ok: false, error: 'slug required' };
    const synthesis = await _grounding.synthesizeGrounding(slug, goalContract || null, bookIds || [], {
      vaultRoot: vault.resolveRoot(), force: !!force,
    });
    return { ok: true, synthesis };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('grounding:getSynthesis', async (_e, { slug } = {}) => {
  try {
    if (!slug) return { ok: false, error: 'slug required' };
    const synthesis = _grounding.getSynthesis(slug, { vaultRoot: vault.resolveRoot() });
    return { ok: true, synthesis };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('grounding:runForCourse', async (event, { slug, goalContract, bookIds, force } = {}) => {
  try {
    if (!slug) return { ok: false, error: 'slug required' };
    const result = await _grounding.runGroundingForCourse(slug, goalContract || null, bookIds || [], {
      vaultRoot: vault.resolveRoot(),
      force: !!force,
      onProgress: (stage, extra) => {
        try { event.sender.send('grounding:progress', { stage, ...(extra || {}) }); } catch (_) {}
      },
    });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// ── W6.2 Distillation (BLUEPRINT §5.1 + §5.2) ─────────────────────────────
// Longform Spark Distillation 7-phase pipeline + Book Spark Pack assembly.
// Sequential phases, idempotent cache at vault/.distillation/<book-id>/.
// IPC surface kept narrow on purpose — UI primarily uses `distill:book`
// (full run, resumable) + `distill:getBookSparkPack` (read result).
// boot-10 lazy-wrap — distillation modules combined ~1220 LOC (book-router
// 394 + distill-runner 302 transitively pulls phases.js 918). Only fires on
// distill:* IPC + book:contextPacket. Proxy keeps call-site `.method(args)`
// identical so the 8 call sites below need zero changes.
let __distillRunnerMod = null;
const _distillRunner = new Proxy({}, {
  get(_t, p) {
    if (!__distillRunnerMod) __distillRunnerMod = require('./lib/distillation/distill-runner');
    return __distillRunnerMod[p];
  },
});
let __bookRouterMod = null;
const _bookRouter = new Proxy({}, {
  get(_t, p) {
    if (!__bookRouterMod) __bookRouterMod = require('./lib/distillation/book-router');
    return __bookRouterMod[p];
  },
});

ipcMain.handle('distill:book', async (_e, { bookId, goal, resume } = {}) => {
  try {
    if (!bookId) return { ok: false, error: 'bookId required' };
    const bookRes = _library.getBook({ vaultRoot: vault.resolveRoot(), id: bookId });
    if (!bookRes || !bookRes.ok || !bookRes.book) {
      return { ok: false, error: (bookRes && bookRes.error) || 'book not found' };
    }
    const r = await _distillRunner.distillBook({
      vaultRoot: vault.resolveRoot(),
      book: bookRes.book,
      options: { goal: goal || null, resume: resume !== false },
    });
    return r;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('distill:phase', async (_e, { bookId, phaseN, goal } = {}) => {
  try {
    if (!bookId || !phaseN) return { ok: false, error: 'bookId + phaseN required' };
    const bookRes = _library.getBook({ vaultRoot: vault.resolveRoot(), id: bookId });
    if (!bookRes || !bookRes.ok) return { ok: false, error: (bookRes && bookRes.error) || 'book not found' };
    return await _distillRunner.runPhase({
      vaultRoot: vault.resolveRoot(),
      book: bookRes.book,
      phaseN,
      options: { goal: goal || null },
    });
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('distill:status', async (_e, { bookId } = {}) => {
  try {
    if (!bookId) return { ok: false, error: 'bookId required' };
    const status = _distillRunner.getStatus({ vaultRoot: vault.resolveRoot(), bookId });
    return { ok: true, status: status || null };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('distill:getBookSparkPack', async (_e, { bookId } = {}) => {
  try {
    if (!bookId) return { ok: false, error: 'bookId required' };
    const pack = _distillRunner.getBookSparkPack({ vaultRoot: vault.resolveRoot(), bookId });
    return { ok: true, pack: pack || null };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('distill:isDistilled', async (_e, { bookId } = {}) => {
  try {
    if (!bookId) return { ok: false, error: 'bookId required' };
    return { ok: true, distilled: _distillRunner.isBookDistilled({ vaultRoot: vault.resolveRoot(), bookId }) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('distill:clear', async (_e, { bookId } = {}) => {
  try {
    if (!bookId) return { ok: false, error: 'bookId required' };
    const r = _distillRunner.clearDistillation({ vaultRoot: vault.resolveRoot(), bookId });
    return r;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('book:contextPacket', async (_e, { bookId, query, budgetTokens } = {}) => {
  try {
    if (!bookId) return { ok: false, error: 'bookId required' };
    const packet = _bookRouter.getBookContextPacket({
      vaultRoot: vault.resolveRoot(),
      bookId,
      query: query || '',
      budgetTokens: budgetTokens || undefined,
    });
    return { ok: true, packet };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// lesson:kpArcs:get — read the kp-arc.json sidecar persisted by approve_and_body
// (main.js ~L3343). Returns { ok, arcs: [{kp_id, arc, _meta}], schema_version,
// user_intent, visual_archetype, pedagogical_archetype }. Used by Phase D UI
// (knowledge-point-cards.jsx + screen-atlas-notebook data-driven render).
ipcMain.handle('lesson:kpArcs:get', async (_e, { slug, idx } = {}) => {
  try {
    if (!slug || !Number.isFinite(idx)) return { ok: false, error: 'BAD_INPUT' };
    const arcRel = `${slug}/lesson-${idx}.kp-arc.json`;
    if (!vault.exists(arcRel)) return { ok: true, arcs: [], _meta: null };
    const cached = vault.readJSON(arcRel, null);
    return {
      ok: true,
      arcs: (cached && Array.isArray(cached.arcs)) ? cached.arcs : [],
      schema_version: cached && cached.schema_version,
      user_intent: cached && cached.user_intent,
      visual_archetype: cached && cached.visual_archetype,
      pedagogical_archetype: cached && cached.pedagogical_archetype,
    };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

// Micro Proof scoring — sub-step H (v0.1). Recall + Production evidence types
// only. `passed` verdict comes from a LOCAL regex/shape baseline; the LLM
// runs in parallel as a monitoring signal (logged to false_positive_risk),
// never as the terminal verdict. Per BLUEPRINT AMD-1.
const scoring = require('./lib/scoring');

// G3 (v0.1 acceptance gate): read the last N assistant messages from the active
// session file so scoreMicroProof can detect "user pasted the LLM's last reply".
// If payload doesn't include {rel, sessionFile} (older callers), fall back to
// the explicit `recentAssistantMessages` already in payload, or [] if neither.
function _harvestRecentAssistantMessages(payload, n = 3) {
  if (Array.isArray(payload && payload.recentAssistantMessages)) {
    return payload.recentAssistantMessages;
  }
  const rel = payload && payload.rel;
  const sessionFile = payload && payload.sessionFile;
  if (!rel || !sessionFile) return [];
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const fp = path.join(vault.resolveRoot(), rel, 'sessions', sessionFile);
    if (!fs.existsSync(fp)) return [];
    const raw = fs.readFileSync(fp, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const msgs = [];
    for (let i = lines.length - 1; i >= 0 && msgs.length < n; i--) {
      try {
        const row = JSON.parse(lines[i]);
        if (row && row.role === 'assistant' && typeof row.content === 'string') {
          msgs.unshift(row.content);
        }
      } catch (_) { /* skip malformed rows */ }
    }
    return msgs;
  } catch (_) {
    return [];
  }
}

ipcMain.handle('score:microProof', async (_e, payload) => {
  try {
    const enriched = {
      ...(payload || {}),
      recentAssistantMessages: _harvestRecentAssistantMessages(payload, 3),
    };
    const result = await scoring.scoreMicroProof(enriched);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.2 Tranche 1 (AMD-MEOW-P7 M2 Confession Layer): generate Generator's
// self-confession against its Character Contract. Payload: {plan, body?, agent_id}.
const confession = require('./lib/anti-slop/confession');
const { loadContract } = require('./lib/agent-character/contract-loader');
ipcMain.handle('lesson:generateConfession', async (_e, payload) => {
  try {
    // Phase C-5 (2026-05-08): forward `transcript` so the post-session chat
    // path can confess against turn-by-turn lesson transcript instead of body.
    const { plan, body, transcript, agent_id } = payload || {};
    if (!plan) throw new Error('plan required');
    const contract = loadContract(agent_id || 'mycelium-professor', { vaultRoot: vault.resolveRoot() });
    const out = await confession.generateConfession({ plan, body, transcript, characterContract: contract });
    out.honesty_score = confession.gradeConfessionHonesty(out.confession);
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.2 Tranche 2 (AMD-MEOW-P7 M3 Gap Detector): pure-JS, no LLM.
// Payload: {plan, body, evidenceLedger}.
const gapDetector = require('./lib/anti-slop/gap-detector');
ipcMain.handle('lesson:computeGap', async (_e, payload) => {
  try {
    const result = gapDetector.computeGap(payload || {});
    return { ok: true, gap: result, summary: gapDetector.renderGapSummary(result) };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.2 Tranche 2 (AMD-MEOW-P8 C3 minimal Persona Coherence Score): pure-JS.
// Payload: {confession, ingratiationViolations, outputText, agent_id}.
const coherenceScore = require('./lib/agent-character/coherence-score');
ipcMain.handle('persona:computeCoherence', async (_e, payload) => {
  try {
    // Phase C-5 (2026-05-08): forward `mode` so per-turn caller can request the
    // softer ingratiation penalty (×5 in turn mode vs ×10 session-aggregate).
    const { confession: conf, ingratiationViolations, outputText, agent_id, mode } = payload || {};
    const contract = loadContract(agent_id || 'mycelium-professor', { vaultRoot: vault.resolveRoot() });
    const result = coherenceScore.computePersonaCoherence({ confession: conf, ingratiationViolations, outputText, contract, mode });
    return { ok: true, persona: result, summary: coherenceScore.renderPersonaSummary(result, contract) };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.2 Tranche 2 (AMD-MEOW-P7 M4 Prosecutor/Judge/Rewriter loop): 3 sequential
// LLM stages. Payload: {plan, body, contracts?: {skeptic, judge, rewriter}}.
const pjr = require('./lib/anti-slop/prosecute-judge-rewrite');
ipcMain.handle('lesson:prosecuteJudgeRewrite', async (_e, payload) => {
  try {
    const { plan, body } = payload || {};
    if (!plan || !body) throw new Error('plan and body required');
    const contracts = {
      skeptic:  loadContract('skeptic-mushroom',   { vaultRoot: vault.resolveRoot() }),
      judge:    loadContract('mycelium-professor', { vaultRoot: vault.resolveRoot() }),
      rewriter: loadContract('mycelium-professor', { vaultRoot: vault.resolveRoot() }),
    };
    const result = await pjr.runProsecuteJudgeRewrite({ plan, body, contracts });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.2 Tranche 2 (AMD-MEOW-P7 M5 Auditable Reasoning Summary): pure-JS composer.
// Payload: {plan, body, evidenceLedger, confession, driftScore, personaCoherence, charges, rulings}.
const auditableSummary = require('./lib/anti-slop/auditable-summary');
ipcMain.handle('lesson:auditableSummary', async (_e, payload) => {
  try {
    const out = auditableSummary.composeAuditableSummary(payload || {});
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.4 anti-slop (Confidence Leak Detector): pure-JS regex pass. Catches the
// gap between "should say 我不知道" and "asserts with full confidence anyway".
// Payload: {text, context}. context.is_source_grounded relaxes the score for
// retrieval-backed output. Independent today; v0.4 integrates into
// agent.js streamTurn finally block — see module header.
//
// Integration TODO (v0.4 anti-slop stack):
//   const conf = detectConfidenceLeaks(_streamResult.accumulated,
//                                      { is_source_grounded: ... });
//   if (conf.summary.leak_count > 0) {
//     _hyphaAppendEvent('confidence_leak_flagged', conf.summary);
//     // optional: regenerate with sharper hedge hint
//   }
const confidenceLeakDetector = require('./lib/anti-slop/confidence-leak-detector');
ipcMain.handle('anti-slop:detect-confidence-leak', async (_e, payload) => {
  try {
    const { text, context } = payload || {};
    if (typeof text !== 'string') throw new Error('text (string) required');
    const result = confidenceLeakDetector.detectConfidenceLeaks(text, context || {});
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.4.9 (2026-05-19) — Force-rewrite IPC. PJR pipeline (prosecutor → judge
// → rewriter) is gate-agnostic at the runProsecuteJudgeRewrite entry point —
// the archetype gate (HUMANITIES blocks rewrite) sits upstream in
// `_deriveVerdict`. Calling PJR directly here BYPASSES the gate by virtue
// of skipping the verdict step. User-initiated via Trust Panel button
// (course-trust-panel.jsx) when verdict.gated_by_archetype=true and they
// want manual override despite register risk.
//
// Cost-shield NOT integrated (v0.5 work) — UI does a simple confirm() to
// gate the LLM cost (~¥0.5/call T6_STRONG).
//
// v0.4.10 (2026-05-19) — 60s cooldown per (slug, lessonIdx) key. Prevents
// user double-click + reopen-Panel spam from billing N LLM calls. Cooldown
// is process-local (resets on Electron restart, acceptable for v1).
const _FORCE_REWRITE_COOLDOWN_MS = 60 * 1000;
const _FORCE_REWRITE_FIRE_CAP = 200;          // boot-11 — bound long-running session growth
const _forceRewriteLastFire = new Map(); // key: `${slug}__${idx}` → ts
// FIFO eviction helper — Map preserves insertion order; oldest key is the
// first iterator yield. Bounds growth at _FORCE_REWRITE_FIRE_CAP entries.
function _forceRewriteRecord(key, ts) {
  if (_forceRewriteLastFire.has(key)) _forceRewriteLastFire.delete(key);
  _forceRewriteLastFire.set(key, ts);
  while (_forceRewriteLastFire.size > _FORCE_REWRITE_FIRE_CAP) {
    const oldest = _forceRewriteLastFire.keys().next().value;
    if (oldest === undefined) break;
    _forceRewriteLastFire.delete(oldest);
  }
}
ipcMain.handle('anti-slop:force-rewrite', async (_e, { slug, lessonIdx } = {}) => {
  try {
    if (!slug || !Number.isFinite(lessonIdx)) {
      return { ok: false, error: 'BAD_INPUT', message: 'slug + lessonIdx required' };
    }
    const cooldownKey = `${slug}__${lessonIdx}`;
    const lastFire = _forceRewriteLastFire.get(cooldownKey) || 0;
    const elapsedMs = Date.now() - lastFire;
    if (elapsedMs < _FORCE_REWRITE_COOLDOWN_MS) {
      const waitSec = Math.ceil((_FORCE_REWRITE_COOLDOWN_MS - elapsedMs) / 1000);
      return {
        ok: false,
        error: 'COOLDOWN',
        message: `force-rewrite is on cooldown — wait ${waitSec}s before retry (prevents accidental double-spend)`,
      };
    }
    _forceRewriteRecord(cooldownKey, Date.now());
    const bodyRel = `${slug}/lesson-${lessonIdx}.body.json`;
    const cached = vault.readJSON(bodyRel, null);
    if (!cached || !cached.body) {
      return { ok: false, error: 'NO_BODY', message: `body not found at ${bodyRel}` };
    }
    const state = vault.readJSON(`${slug}/state.json`, null) || {};
    const slot = (Array.isArray(state.lessonPlan) && state.lessonPlan[lessonIdx]) || {};
    const plan = {
      objective: slot.learnGoal || slot.title || '',
      title: slot.title || '',
      path: Array.isArray(slot.path) ? slot.path : [],
      micro_proof: slot.micro_proof || {},
    };
    const pjr = require('./lib/anti-slop/prosecute-judge-rewrite');
    const result = await pjr.runProsecuteJudgeRewrite({ plan, body: cached.body });

    // Write back only if rewriter ran + produced a body
    let wrote = false;
    if (result && result.ok && result.rewriter && result.rewriter.body) {
      vault.writeJSON(bodyRel, {
        ...cached,
        body: result.rewriter.body,
        _meta: {
          ...(cached._meta || {}),
          force_rewrite_at: new Date().toISOString(),
          force_rewrite_summary: result.summary || {},
          force_rewrite_skipped_gate: true,
        },
      });
      wrote = true;
    }
    try {
      const costLogDir = path.join(vault.resolveRoot(), '.hypha');
      fs.mkdirSync(costLogDir, { recursive: true });
      const costLogPath = path.join(costLogDir, 'anti-slop-cost.jsonl');
      fs.appendFileSync(costLogPath, JSON.stringify({
        ts: new Date().toISOString(),
        slug,
        lessonIdx,
        costCNY: 0.5,
        mode: 'force-rewrite',
      }) + '\n');
    } catch (logErr) {
      console.warn('[anti-slop:force-rewrite] cost-log append failed:', logErr.message);
    }
    return {
      ok: !!(result && result.ok),
      wrote,
      summary: (result && result.summary) || {},
      error: result && !result.ok ? (result.summary && result.summary.error) || 'PJR_FAILED' : undefined,
    };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.4 anti-slop (Citation Verifier): heuristic trigram-Jaccard match between
// every quoted span in `text` and `vault/<slug>/sources.json`. Catches LLM
// fabrications shaped like "as the chapter says: '...'". Pure-JS, no LLM call.
// Standalone today; v0.4 integration into agent.js streamTurn deferred — see
// module header.
const citationVerifier = require('./lib/anti-slop/citation-verifier');
ipcMain.handle('anti-slop:verify-citations', async (_e, payload) => {
  try {
    const { slug, text, options } = payload || {};
    if (typeof text !== 'string') throw new Error('text (string) required');
    if (slug != null && typeof slug !== 'string') throw new Error('slug must be string when provided');
    const result = await citationVerifier.verifyCitations(text, slug || '', options || {});
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.3 (AMD-MEOW-P7 M-pedagogy): Pedagogy-Claim Detector. Pure-JS, no LLM.
// Scans LLM output for `P[1-6]` / `F[1-3]` / primitive-name references,
// jaccard-matches surrounding context against pedagogy.md primitive defs,
// returns per-claim verdict {consistent | loose-match | inconsistent |
// unknown-primitive}. Payload: {text}. Independently callable today; the
// agent.js streamTurn integration is deferred to v0.4 (see module header).
const pedagogyClaimDetector = require('./lib/anti-slop/pedagogy-claim-detector');
ipcMain.handle('anti-slop:verify-pedagogy', async (_e, payload) => {
  try {
    const text = (payload && typeof payload.text === 'string') ? payload.text : '';
    const result = pedagogyClaimDetector.detectPedagogyClaims(text);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.2 Tranche 3 (Lesson Quality Harness, blueprint §6.4): orchestrator that
// runs the trust-stack pipeline. lite preset = ~15-20s (gap+confession+persona+summary);
// deep preset = ~80-90s (adds Prosecutor/Judge/Rewriter loop). Caller picks via options.
const lessonQualityHarness = require('./lib/lesson-quality-harness');
ipcMain.handle('lesson:runFullPipeline', async (_e, payload) => {
  try {
    const result = await lessonQualityHarness.runFullPipeline(payload || {});
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// v0.2 Tranche 3 (Quality Harness sample fixtures): expose golden + failure
// sample sets. Reader can self-test the harness against known-good and
// known-bad lesson bodies.
ipcMain.handle('lesson:loadQualitySamples', async (_e, { kind } = {}) => {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const filename = kind === 'failures' ? 'quality-samples-failures.json' : 'quality-samples-golden.json';
    const fp = path.join(__dirname, '..', 'scripts', filename);
    const raw = fs.readFileSync(fp, 'utf8');
    return { ok: true, samples: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// W2.2 Assignment Cadence — f(D,S,C,M,R,G,T,P) → Level 1-5 + level templates +
// grader routing. Pure-function decision engine in app/lib/assignment-cadence.js;
// main.js stays a thin IPC router. events.jsonl writes happen inline so the
// renderer doesn't need vault-write permission for assignment audit trail.
ipcMain.handle('assignment:compute', async (_e, args = {}) => {
  try {
    const ac = require('./lib/assignment-cadence');
    const decision = ac.computeAssignmentLevel(args);
    if (args && args.slug) {
      try { ac.writeAssignmentLevelEvent(args.slug, decision, args, args.prevLevel || null); }
      catch (logErr) { console.warn('[assignment:compute] event write failed:', logErr.message); }
    }
    return { ok: true, ...decision };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});
ipcMain.handle('assignment:template', async (_e, { level, opts } = {}) => {
  try {
    const ac = require('./lib/assignment-cadence');
    return { ok: true, ...ac.selectLevelTemplate(level, opts || {}) };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});
ipcMain.handle('assignment:grade', async (_e, args = {}) => {
  try {
    const ac = require('./lib/assignment-cadence');
    let gradeDraftFn = null;
    try { gradeDraftFn = require('./lib/production-scaffold').gradeDraft; } catch (_) { /* optional */ }
    const result = await ac.gradeAssignment({ ...args, gradeDraftFn });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// W1.1 Quality Harness — 9-dim grader IPC (scaffold, real T4_JUDGE wiring in W1.2).
// runHarness: regen N lesson body mocks (dry-run) or live, grade each, return pass_rate.
// gradeLesson: single body → 9 dim scores + overall_pass + weakest_dim.
// Both delegate to app/lib/quality-harness/runHarness.js; main.js stays a thin router.
ipcMain.handle('lesson:harness:run', async (_e, args = {}) => {
  try {
    const harness = require('./lib/quality-harness/runHarness');
    const result = await harness.runHarness(args);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

ipcMain.handle('lesson:harness:grade', async (_e, { lessonBody, context } = {}) => {
  try {
    const harness = require('./lib/quality-harness/runHarness');
    const result = await harness.gradeLesson(lessonBody, context);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// Phase E (Provider Health UI): expose router.getReport() for the lesson-screen
// status badge. Read-only snapshot — state machine lives entirely in router.js.
ipcMain.handle('llm:healthReport', async () => {
  try {
    const llm = require('./lib/llm');
    return { ok: true, report: llm.getProviderHealth() };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// Lesson Note deposit — sub-step I (v0.1). Idempotent vault write per
// BLUEPRINT §9.1: each call allocates the next free lesson-N.md inside
// vault/<slug>/, never overwrites. Returns { ok, path, lessonId, slug }.
const lessonNote = require('./lib/lesson-note');
ipcMain.handle('note:deposit', async (_e, payload) => {
  try {
    // Phase B 改动 M6c (MEOW v7 HIGH fix) — auto-augment deposit payload from
    // vault state files so the new lesson-note.js optional fields actually
    // reach buildFrontmatter / buildBody. Without this, the augmented signatures
    // remain dark code: depositLessonNote would call them with only the legacy
    // 5-field payload and no user_intent / visual_archetype / KP refs would
    // ever land in the lesson NOTE frontmatter.
    const _augmented = Object.assign({}, payload || {});
    try {
      const _gc = _augmented.goalContract || {};
      const _slugSource = _gc.main_creation || _gc.north_star_goal || '';
      const _augSlug = _slugSource ? lessonNote.slugify(_slugSource) : null;
      if (_augSlug) {
        const _state = vault.readJSON(`${_augSlug}/state.json`, null);
        if (_state) {
          if (_augmented.userIntent == null) {
            _augmented.userIntent = (_state.goalContract && _state.goalContract.user_intent) || _state.user_intent || null;
          }
          if (_augmented.visualArchetype == null) _augmented.visualArchetype = _state.visual_archetype || null;
          if (_augmented.pedagogicalArchetype == null) _augmented.pedagogicalArchetype = _state.archetype || null;
        }
        // Best-effort KP refs + scaffold + priorLesson hydration. Numbering
        // is heuristic: the next allocated lesson-N is nextN per resolveLessonPath
        // (1-based), while body sidecars use lesson-<idx> (0-based per lessonPlan
        // slot.idx). When mapping is uncertain we skip silently — buildBody just
        // omits the Tier 1/2 + scaffold sections, no harm done.
        try {
          const { nextN } = lessonNote.resolveLessonPath({ slug: _augSlug });
          const _bodyIdx = nextN - 1;  // best-effort 1↔0 bridge
          // KP refs — from kp-arc.json sidecar
          const _arc = vault.readJSON(`${_augSlug}/lesson-${_bodyIdx}.kp-arc.json`, null);
          if (_arc && Array.isArray(_arc.arcs) && _arc.arcs.length > 0) {
            if (_augmented.knowledgePointRefs == null) {
              _augmented.knowledgePointRefs = _arc.arcs.map(w => w.kp_id).filter(Boolean);
            }
            if (_augmented.knowledgePoints == null) {
              // Surface the kp seeds (id + title + archetype_hint + lineage_link_seeds)
              // for renderTOC. We derive from arc.arcs[].arc.title + the original
              // seed metadata when present.
              _augmented.knowledgePoints = _arc.arcs.map(w => ({
                id: w.kp_id,
                title: (w.arc && (w.arc.definition || '').slice(0, 40)) || w.kp_id,
                archetype_hint: (w.arc && (w.arc.derivation_chain && w.arc.derivation_chain.length > 0 ? 'derivation' : 'definition')) || 'definition',
                lineage_link_seeds: (w.arc && Array.isArray(w.arc.lineage_link))
                  ? w.arc.lineage_link.map(l => ({
                      label: (l.target && l.target.display_label) || '',
                      relation: l.relation || '',
                    }))
                  : [],
              }));
            }
          }
          // Production scaffold — from production-scaffold.json sidecar
          if (_augmented.productionScaffold == null) {
            const _sc = vault.readJSON(`${_augSlug}/lesson-${_bodyIdx}.production-scaffold.json`, null);
            if (_sc && _sc.entrypoint) _augmented.productionScaffold = _sc.entrypoint;
          }
          // Prior lesson — read previous .md if exists, supply title + preview
          if (_augmented.priorLesson == null && _bodyIdx >= 1) {
            try {
              // Resolve actual prior lesson NOTE by scanning <slug>/ for the
              // largest lesson-N.md with N < nextN. Skip if none.
              const _entries = vault.listDir(_augSlug) || [];
              let _maxPrior = 0;
              for (const _e of _entries) {
                if (_e && !_e.isDir) {
                  const _m = /^lesson-(\d+)\.md$/i.exec(_e.name || '');
                  if (_m) {
                    const _n = parseInt(_m[1], 10);
                    if (Number.isFinite(_n) && _n < nextN && _n > _maxPrior) _maxPrior = _n;
                  }
                }
              }
              if (_maxPrior > 0) {
                const _priorRel = `${_augSlug}/lesson-${String(_maxPrior).padStart(2, '0')}.md`;
                const _priorRead = vault.read(_priorRel);
                if (_priorRead && (_priorRead.body || _priorRead === '' || typeof _priorRead === 'string')) {
                  const _priorBody = typeof _priorRead === 'string' ? _priorRead : (_priorRead.body || '');
                  const _priorTitle = (_priorRead && _priorRead.frontmatter && (_priorRead.frontmatter.title || _priorRead.frontmatter.learn_goal)) || `Lesson ${_maxPrior}`;
                  _augmented.priorLesson = {
                    idx: nextN,
                    title: _priorTitle,
                    rel: `lesson-${String(_maxPrior).padStart(2, '0')}`,
                    preview: _priorBody.slice(0, 600),
                  };
                }
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (augErr) {
      console.warn('[note:deposit] augmentation failed (non-fatal):', augErr && augErr.message);
    }
    const r = await lessonNote.depositLessonNote(_augmented);
    return r;
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// Positive Feedback — sub-step J (v0.1). 微反馈 only per BLUEPRINT §8.3 +
// AMD-10. Pure rule-based, no LLM. Returns { ok, type, message }.
const positiveFeedback = require('./lib/positive-feedback');
ipcMain.handle('feedback:compose', async (_e, payload) => {
  try {
    const r = positiveFeedback.composePositiveFeedback(payload || {});
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// CRUD — destructive ops. UI must confirm delete before invoking.
ipcMain.handle('vault:delete', (_e, rel) => {
  try { return vault.del(rel); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vault:rename', (_e, oldRel, newRel) => {
  try { return vault.rename(oldRel, newRel); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vault:mkdir', (_e, rel) => {
  try { return vault.mkdir(rel); }
  catch (e) { return { ok: false, error: e.message }; }
});

// v1.0 boot-7 — Vault safety surface (snapshot + restore + meta).
// Wired here next to other vault:* CRUD so renderer + Settings can call them
// uniformly. Snapshot triggers also fire internally before destructive ops
// (pack import, schema migration v1.1+). All are best-effort and return
// { ok: false, error } on failure so callers can surface to the user.
const _vaultSnapshot = require('./lib/vault-snapshot');
const _vaultMeta = require('./lib/vault-meta');

ipcMain.handle('vault:snapshot', async (_e, args) => {
  const tag = (args && args.tag) ? String(args.tag) : 'manual';
  try { return await _vaultSnapshot.snapshotVault({ tag }); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vault:list-snapshots', () => {
  try { return { ok: true, snapshots: _vaultSnapshot.listSnapshots() }; }
  catch (e) { return { ok: false, error: e.message, snapshots: [] }; }
});
ipcMain.handle('vault:restore-snapshot', async (_e, args) => {
  const ts = args && args.ts;
  if (!Number.isFinite(Number(ts))) return { ok: false, error: 'ts (numeric ms) required' };
  try { return await _vaultSnapshot.restoreSnapshot(Number(ts)); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vault:prune-snapshots', (_e, args) => {
  try { return _vaultSnapshot.pruneSnapshots(args || {}); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('vault:meta', () => {
  try { return { ok: true, meta: _vaultMeta.readMeta() }; }
  catch (e) { return { ok: false, error: e.message, meta: null }; }
});

// vault:pick-folder — open native folder picker, return selected absolute path or null.
// boot-11 (2026-05-20) — wrap in try/catch so dialog failure (e.g. parent window
// destroyed mid-open, OS picker error) returns null rather than rejecting the
// renderer promise. Renderer treats null as "user cancelled or unavailable".
ipcMain.handle('vault:pick-folder', async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: '选择要导入的笔记文件夹 (Bear / Obsidian / Notion 导出)',
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
    return res.filePaths[0];
  } catch (err) {
    console.warn('[vault:pick-folder] dialog failed:', err && err.message);
    return null;
  }
});

// source:pick — open file picker for curriculum source corpus (PDF/MD/TXT).
// Returns { ok, filePath, fileName } or { ok: false, cancelled: true }.
// Legacy single-file path; kept for callers that want one file. Multi-file
// callers should use source:pickMultiple below.
ipcMain.handle('source:pick', async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'pick a source document — PDF, Markdown, or plain text',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'md', 'markdown', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) {
      return { ok: false, cancelled: true };
    }
    const filePath = res.filePaths[0];
    return { ok: true, filePath, fileName: require('path').basename(filePath) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// source:pickMultiple — multi-file picker (Appendix B 2026-05-05). Returns
// { ok, filePaths:[{ filePath, fileName }] } or { ok:false, cancelled:true }.
// Up to MAX_FILES (8) is enforced renderer-side; this dialog allows more but
// the picker UI rejects beyond cap before extract.
ipcMain.handle('source:pickMultiple', async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: 'pick source documents — PDF, Markdown, or plain text (multi)',
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'md', 'markdown', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths || !res.filePaths.length) {
      return { ok: false, cancelled: true };
    }
    const pathMod = require('path');
    return {
      ok: true,
      filePaths: res.filePaths.map(fp => ({ filePath: fp, fileName: pathMod.basename(fp) })),
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// url:fetchBatch — 2026-05-05. Fetch a list of URLs, extract main content
// of each via cheerio + turndown (or pdf-parse for PDF urls), return per-URL
// extraction results in upload-shape so renderer can merge them into the
// uploadedSource.files[] array (same shape as drag-dropped files). User
// curriculum form treats URLs as additional high-priority sources alongside
// any uploaded files.
ipcMain.handle('url:fetchBatch', async (_e, { urls } = {}) => {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { ok: false, error: 'urls[] required' };
  }
  const { extractFromUrl } = require('./lib/source-extractor');
  const results = [];
  // Sequential to avoid hammering hosts + share rate-limit budget.
  for (const url of urls) {
    if (!url || typeof url !== 'string' || !url.trim()) continue;
    try {
      const r = await extractFromUrl(url.trim());
      results.push({
        ok: true,
        url: url.trim(),
        fileName: r.fileName,
        ext: r.ext,
        pageCount: r.pageCount,
        chapterCount: (r.chapters || []).length,
        chapters: r.chapters,
        text: r.text,
      });
    } catch (err) {
      results.push({
        ok: false,
        url: url.trim(),
        error: (err && err.message) || String(err),
      });
    }
  }
  return { ok: true, results };
});

// source:extract — read + parse the picked file. Returns text + chapter
// breakdown for renderer preview, plus the extractor's full result so the
// caller can pass it straight into curriculum:create as `uploadedSource`.
ipcMain.handle('source:extract', async (_e, { filePath } = {}) => {
  if (!filePath) return { ok: false, error: 'filePath required' };
  try {
    const { extractFromPath } = require('./lib/source-extractor');
    const result = await extractFromPath(filePath);
    return {
      ok: true,
      filePath,
      fileName: result.fileName,
      ext: result.ext,
      pageCount: result.pageCount,
      chapterCount: result.chapters.length,
      text: result.text,
      chapters: result.chapters,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// vault:import-scan — quick scan to preview file count + format detection.
// Returns { files, detected, mdCount, htmlCount, total } or { error }.
ipcMain.handle('vault:import-scan', async (_e, sourcePath) => {
  if (!sourcePath || typeof sourcePath !== 'string') return { error: 'sourcePath required' };
  try {
    const r = importer.scanSource(sourcePath);
    if (r.error) return { error: r.error };
    // Don't ship full file list to renderer (could be huge) — just summary
    return { detected: r.detected, mdCount: r.mdCount, htmlCount: r.htmlCount, total: r.total };
  } catch (e) { return { error: e.message }; }
});

// vault:import-run — run the import. Streams 'vault:import-progress' events
// during work. Resolves with summary { imported: [...rel], errors: [...], total }.
const _importCancel = new Map();   // sessionId → bool
ipcMain.handle('vault:import-run', async (event, { sourcePath, subdir, sessionId }) => {
  if (!sourcePath) return { ok: false, error: 'sourcePath required' };
  const sid = sessionId || ('imp_' + Date.now());
  _importCancel.set(sid, false);
  try {
    const result = await importer.importAll(sourcePath, vault.resolveRoot(), {
      subdir,
      onProgress: (p) => {
        try { event.sender.send('vault:import-progress', { sessionId: sid, ...p }); } catch (_) {}
      },
      shouldCancel: () => _importCancel.get(sid) === true,
    });
    return { ...result, sessionId: sid };
  } catch (e) {
    return { ok: false, error: e.message, sessionId: sid };
  } finally {
    _importCancel.delete(sid);
  }
});
ipcMain.handle('vault:import-cancel', (_e, sessionId) => {
  if (!sessionId) return false;
  _importCancel.set(sessionId, true);
  return true;
});

// corpus:strengths — bulk strength map for RecallDashboard ranking.
// Returns { 'folder/file.md': 0.873, ... }. Cached 5min in .beiking/corpus-strength.json.
ipcMain.handle('corpus:strengths', async () => {
  try { return await reinforce().bulkStrength(vault.resolveRoot()); }
  catch (e) { console.error('[corpus:strengths] failed', e.message); return {}; }
});

// corpus:similar — co-citation top-k for the right-rail "see also" region.
// Algorithm: for each non-human agent that touched targetRel, sum
// min(targetCount, otherCount) for every other rel they also touched.
// Pure event-log replay — no embeddings, no persistence. Cached 60s per
// vaultRoot since the agentFiles map is the expensive part.
const _coCacheTTL = 60_000;
let _coCache = { root: null, ts: 0, agentFiles: null };
async function _buildAgentFiles(root) {
  const now = Date.now();
  if (_coCache.root === root && (now - _coCache.ts) < _coCacheTTL && _coCache.agentFiles) {
    return _coCache.agentFiles;
  }
  const map = new Map();   // agent → Map<rel, count>
  for await (const ev of eventLog().readAll(root)) {
    if (!ev.agent_id || ev.agent_id === 'human' || !ev.file) continue;
    if (!map.has(ev.agent_id)) map.set(ev.agent_id, new Map());
    const m = map.get(ev.agent_id);
    m.set(ev.file, (m.get(ev.file) || 0) + 1);
  }
  _coCache = { root, ts: now, agentFiles: map };
  return map;
}
ipcMain.handle('corpus:similar', async (_e, rel, k) => {
  if (!rel || typeof rel !== 'string') return [];
  const limit = Math.max(1, Math.min(10, k|0 || 3));
  try {
    const root = vault.resolveRoot();
    const agentFiles = await _buildAgentFiles(root);
    const scores = new Map();   // otherRel → score
    for (const [, fileMap] of agentFiles) {
      const targetCount = fileMap.get(rel);
      if (!targetCount) continue;
      for (const [otherRel, otherCount] of fileMap) {
        if (otherRel === rel) continue;
        const w = Math.min(targetCount, otherCount);
        scores.set(otherRel, (scores.get(otherRel) || 0) + w);
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([otherRel, score]) => ({ rel: otherRel, score }));
  } catch (e) {
    console.error('[corpus:similar] failed', e.message);
    return [];
  }
});

// v0.10.2 — Daily note. Per /tr council 2026-05-02 wiki+gbrain three-piece:
// daily note is the lesson-free capture surface. Compounds with existing
// wikilinks ([[concept]] already renders + tracks backlinks) without needing
// atlas-concept-as-page integration. File at daily/<YYYY-MM-DD>.md is
// created if absent with minimal frontmatter; existing daily note is
// returned as-is so re-opening preserves user content. Returns the rel so
// renderer can navigate via existing onSelect path.
ipcMain.handle('vault:open-daily', () => {
  try {
    const root = vault.resolveRoot();
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;
    const rel = `daily/${dateStr}.md`;
    const dailyDir = require('path').join(root, 'daily');
    const fs = require('fs');
    try { fs.mkdirSync(dailyDir, { recursive: true }); } catch (_) {}
    const abs = require('path').join(root, rel);
    if (!fs.existsSync(abs)) {
      const fm = [
        '---',
        `date_created: ${dateStr}`,
        'kind: daily',
        '---',
        '',
        `# ${dateStr}`,
        '',
        '_今日随想 — 任何想法可以写在这里. 用 [[concept]] 链接到课程或概念._',
        '',
        '',
      ].join('\n');
      vault.write(rel, fm);
    }
    return { ok: true, rel };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

// v0.11.0 — wiki:resolve. Resolves [[target]] to vault entity. Order: note
// basename → daily YYYY-MM-DD → atlas concept (across all <slug>__<idx>.json)
// → unknown. Returns { kind, rel?, conceptKey?, label, exists }. 30s cache
// on the atlas walk. Per /tr 2026-05-02 wiki+gbrain three-piece (B).
ipcMain.handle('wiki:resolve', (_e, target) => {
  if (!target || typeof target !== 'string') return { kind: 'unknown', exists: false, label: '' };
  try {
    const resolver = require('./lib/wikilinkResolver');
    return resolver.resolve(target.trim(), { vaultRoot: vault.resolveRoot() });
  } catch (e) {
    return { kind: 'unknown', exists: false, error: String(e && e.message || e) };
  }
});

// vault:backlinks — find all notes that contain [[wikilink]] pointing to this
// note. Per user 2026-04-29 "把 Obsidian 灵魂融入 PTOR". Returns
// [{ rel, label, excerpt }]. Linear scan; v0.1 no cache.
ipcMain.handle('vault:backlinks', (_e, rel) => {
  if (!rel || typeof rel !== 'string') return [];
  try {
    return vault.backlinks(rel);
  } catch (e) {
    console.error('[vault:backlinks] failed', e.message);
    return [];
  }
});

// corpus:agent-trace — last N agent events for THIS note, reverse-chronological.
// Powers the AGENT-TRACE RIBBON in col-3 (per /tr 2026-04-29 council). Reuses
// event-log readAll path; filters human-read noise; returns last 10 by default.
ipcMain.handle('corpus:agent-trace', async (_e, rel, limit) => {
  if (!rel || typeof rel !== 'string') return [];
  try {
    const root = vault.resolveRoot();
    return await eventLog().agentTrace(root, rel, limit || 10);
  } catch (e) {
    console.error('[corpus:agent-trace] failed', e.message);
    return [];
  }
});

// corpus:meta — per-note metadata for footer chip + THANGKA-LEDGER rim.
// Returns { strength, citeCount, recallCount, lastCiteTs, readCount, mtime } or
// null on failure. Single-file aggregate is cheap; called once per note open.
// readCount + mtime added 2026-04-29 for provenance-driven rim ornament:
// readCount → 5-tier brass tint, mtime → ink alpha decay over 30d.
ipcMain.handle('corpus:meta', async (_e, rel) => {
  if (!rel || typeof rel !== 'string') return null;
  try {
    const root = vault.resolveRoot();
    // mtime via fs.statSync — 1ms inode read vs 10-30ms full vault.read +
    // parseFrontmatter. 切笔记快感修复 2026-04-29 per user 卡顿留白 反馈.
    let mtime = null;
    try {
      const safe = path.normalize(rel).replace(/^[\\/]+/, '');
      const abs = path.resolve(root, safe);
      if (abs.startsWith(path.resolve(root))) {
        mtime = fs.statSync(abs).mtime.toISOString();
      }
    } catch (_) {}
    const [strength, agg] = await Promise.all([
      reinforce().strengthFor(root, rel).catch(() => null),
      eventLog().aggregate(root, rel).catch(() => null),
    ]);
    if (!agg) return { strength, citeCount: 0, recallCount: 0, lastCiteTs: null, readCount: 0, mtime };
    return {
      strength,
      citeCount: agg.cite_count || 0,
      recallCount: agg.recall_count || 0,
      lastCiteTs: agg.last_cite_ts || null,
      readCount: agg.human_read_count || agg.read_count || 0,
      mtime,
    };
  } catch (e) {
    console.error('[corpus:meta] failed', e.message);
    return null;
  }
});

// wiki:rebuild — full LLM-Wiki distill pass: walk vault, regenerate each note's
// _wiki: frontmatter block, rewrite wiki-index.json. Long-running on flash; the
// renderer subscribes to 'wiki:rebuild-progress' for per-note status updates.
// Per V2 plan Q3 default A: also runs on first launch if wiki-index.json absent.
// Packaged Hypha excludes ptor2-legacy-corpus-bet — these requires are wrapped
// so boot doesn't crash; the wiki:rebuild + wiki:status IPCs return a graceful
// "module not bundled" error in packaged mode.
let _wikiDistill = null;
let _wikiIndexLib = null;
try { _wikiDistill = require('../../ptor2-legacy-corpus-bet/wiki/distill'); } catch (_) {}
try { _wikiIndexLib = require('../../ptor2-legacy-corpus-bet/wiki/index'); } catch (_) {}
const _wikiRebuildAbort = new Map();   // sessionId → AbortController
ipcMain.handle('wiki:rebuild', async (event, { sessionId } = {}) => {
  if (!_wikiDistill) {
    return { ok: false, error: 'wiki module not bundled in this build (dev-only feature)' };
  }
  const sid = sessionId || ('rebuild-' + Date.now());
  const ac = new AbortController();
  _wikiRebuildAbort.set(sid, ac);
  try {
    const root = vault.resolveRoot();
    const result = await _wikiDistill.distillAll({
      vaultRoot: root,
      signal: ac.signal,
      onProgress: (p) => {
        try { event.sender.send('wiki:rebuild-progress', { sessionId: sid, ...p }); } catch (_) {}
      },
    });
    return { ok: true, sessionId: sid, ...result };
  } catch (e) {
    console.error('[wiki:rebuild] failed', e.message);
    return { ok: false, error: e.message };
  } finally {
    _wikiRebuildAbort.delete(sid);
  }
});
ipcMain.handle('wiki:rebuild-abort', (_e, sessionId) => {
  const ac = _wikiRebuildAbort.get(sessionId);
  if (ac) { ac.abort(); return true; }
  return false;
});

// wiki:status — index size + last_updated. Cheap; no LLM call. Used by the
// renderer to show "wiki has N articles, last refreshed X" in settings or
// debug surface.
ipcMain.handle('wiki:status', async () => {
  if (!_wikiIndexLib) {
    return { ok: false, error: 'wiki module not bundled in this build (dev-only feature)' };
  }
  try {
    const root = vault.resolveRoot();
    const idx = _wikiIndexLib.loadIndex(root);
    const articles = Object.keys(idx.articles || {});
    return {
      ok: true,
      vaultRoot: root,
      articleCount: articles.length,
      updatedAt: idx.updated_at || null,
      sampleSlugs: articles.slice(0, 5),
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// wiki:lookup — debug surface. Run a query against the wiki index and return
// top-k matches without invoking deepen. Useful for verifying that distill
// produced sensible concepts/abstracts before running a full deepen.
ipcMain.handle('wiki:lookup', async (_e, query, k) => {
  if (!_wikiIndexLib) {
    return { ok: false, error: 'wiki module not bundled in this build (dev-only feature)' };
  }
  try {
    const root = vault.resolveRoot();
    const idx = _wikiIndexLib.loadIndex(root);
    const limit = Math.max(1, Math.min(20, k | 0 || 8));
    const hits = _wikiIndexLib.lookupByQuery(idx, query || '', limit);
    return {
      ok: true,
      hits: hits.map(h => ({
        slug: h.slug,
        score: Number(h.score.toFixed(3)),
        title: h.article.title,
        abstract: h.article.abstract,
        concepts: h.article.concepts,
        links_to: h.article.links_to,
      })),
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// wiki:distill-one — distill a single note on demand. Used when the user
// wants to refresh just one article's frontmatter without running rebuild.
ipcMain.handle('wiki:distill-one', async (_e, rel) => {
  if (!_wikiDistill) {
    return { ok: false, error: 'wiki module not bundled in this build (dev-only feature)' };
  }
  try {
    const root = vault.resolveRoot();
    return await _wikiDistill.distillNote({ vaultRoot: root, rel });
  } catch (e) { return { ok: false, error: e.message }; }
});

// claude:setup-token — v0156 — auto-spawn `claude setup-token` to acquire an
// Anthropic OAuth token (sk-ant-oat01-...) from the user's Pro/Max subscription.
// Replaces the manual "open terminal, copy paste token" flow. User clicks one
// button in Colophon → claude binary opens user's default browser → user logs
// in to Anthropic + approves → callback → claude prints token to stdout →
// Hypha captures it + writes to settings.json (provider=claude, apiKey=token).
// Anthropic's Apr-2026 policy update: OAuth tokens from Pro/Max accounts are
// allowed in third-party tools, billed pay-as-you-go from "extra usage balance".
ipcMain.handle('claude:setup-token', async (event) => {
  return new Promise((resolve) => {
    const { spawn: _setupSpawn } = require('node:child_process');
    let child;
    try {
      child = _setupSpawn('claude', ['setup-token'], {
        shell: process.platform === 'win32',
        stdio: ['inherit', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ ok: false, error: 'claude CLI spawn threw: ' + e.message });
    }
    let stdout = '', stderr = '';
    const hardTimer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, 300_000); // 5min cap
    child.stdout.on('data', d => {
      const chunk = d.toString('utf8');
      stdout += chunk;
      try { event.sender.send('claude:setup-token-progress', { text: chunk }); } catch (_) {}
    });
    child.stderr.on('data', d => {
      const chunk = d.toString('utf8');
      stderr += chunk;
      try { event.sender.send('claude:setup-token-progress', { text: chunk }); } catch (_) {}
    });
    child.on('error', err => {
      clearTimeout(hardTimer);
      const msg = /ENOENT|not found|cannot find/i.test(err.message)
        ? 'claude CLI not installed. Run: npm install -g @anthropic-ai/claude-code'
        : err.message;
      resolve({ ok: false, error: msg });
    });
    child.on('close', code => {
      clearTimeout(hardTimer);
      const combined = stdout + '\n' + stderr;
      // Anthropic OAuth tokens carry sk-ant-oat01- prefix per 2026 docs.
      const m = combined.match(/sk-ant-oat01-[A-Za-z0-9_-]{20,}/);
      if (!m) {
        if (code !== 0) return resolve({ ok: false, error: `claude exit ${code}: ${stderr.slice(0, 300) || stdout.slice(-300)}` });
        return resolve({ ok: false, error: 'token pattern (sk-ant-oat01-...) not found in CLI output', raw: combined.slice(-500) });
      }
      const token = m[0];
      try {
        const cur = _hyphaSettings();
        cur.provider = 'claude';
        cur.apiKey = token;
        if (!cur.model || !cur.model.startsWith('claude-')) cur.model = 'claude-opus-4-7';
        cur.baseURL = 'https://api.anthropic.com';
        cur._authMethod = 'setup-token';
        cur._tokenSavedAt = new Date().toISOString();
        // Strip any prior CLI-migration markers so the chosen provider sticks
        delete cur._migratedFrom;
        delete cur._migratedAt;
        delete cur._migrationReason;
        vault.writeJSON('settings.json', cur);
      } catch (e) {
        return resolve({ ok: false, error: 'token captured but settings save failed: ' + e.message, token: token.slice(0, 16) + '…' + token.slice(-4) });
      }
      resolve({
        ok: true,
        tokenMasked: token.slice(0, 16) + '…' + token.slice(-4),
        provider: 'claude',
        model: 'claude-opus-4-7',
      });
    });
  });
});

// llm:run — execute a prompt template against gemini CLI, stream output back via
// 'llm:chunk' events on the originating webContents. Resolves with final status.
// Templates live in app/prompts/<name>.txt. {{VAR}} placeholders interpolated from `vars`.
// Per memory project_gemini_cli: gemini CLI v0.38+, stdin prompt, shell:true on Windows.
const { spawn: _llmSpawn } = require('node:child_process');
const _llmActive = new Map();   // requestId → killer fn
ipcMain.handle('llm:run', async (event, { templateName, vars, requestId }) => {
  if (!templateName || !requestId) return { error: 'templateName + requestId required' };
  const tplPath = path.join(__dirname, 'prompts', templateName + '.txt');
  let tpl;
  try { tpl = fs.readFileSync(tplPath, 'utf8'); }
  catch (e) { return { error: 'template not found: ' + templateName }; }
  let prompt = tpl;
  for (const [k, v] of Object.entries(vars || {})) {
    prompt = prompt.split('{{' + k + '}}').join(String(v));
  }
  return new Promise((resolve) => {
    let child;
    try {
      // No explicit -m — gemini-3.1-pro-preview hits 429 RESOURCE_EXHAUSTED
      // intermittently (verified 2026-04-28). Default model picks based on
      // user's gemini config + auto-fallback. Override via GEMINI_MODEL env if needed.
      const geminiArgs = process.env.GEMINI_MODEL ? ['-m', process.env.GEMINI_MODEL] : [];
      child = _llmSpawn('gemini', geminiArgs, {
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        // GEMINI_CLI_TRUST_WORKSPACE bypasses the trusted-folders prompt that
        // exits 55 in headless mode (we have no interactive TTY here).
        env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
      });
    } catch (e) { resolve({ error: 'spawn failed: ' + e.message }); return; }
    let stderr = '';
    let resolved = false;
    const finish = (payload) => { if (resolved) return; resolved = true; _llmActive.delete(requestId); resolve(payload); };
    _llmActive.set(requestId, () => { try { child.kill('SIGTERM'); } catch (_) {} setTimeout(() => { try { if (child.exitCode === null) child.kill('SIGKILL'); } catch(_){} }, 1000).unref(); });
    child.stdout.on('data', (chunk) => {
      try { event.sender.send('llm:chunk', { requestId, text: chunk.toString('utf8') }); } catch (_) {}
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => finish({ error: err.message }));
    child.on('close', (code) => finish({ ok: code === 0, exitCode: code, stderr: stderr.slice(0, 500) }));
    try { child.stdin.write(prompt); child.stdin.end(); }
    catch (e) { finish({ error: 'stdin write failed: ' + e.message }); }
  });
});
ipcMain.handle('llm:abort', (_e, requestId) => {
  const k = _llmActive.get(requestId);
  if (k) { k(); return true; }
  return false;
});

// v0155 — llm:deepen-popover IPC handler REMOVED per user "完全照搬过来 不要自己
// 改动". Deepen now goes through ptor-design's Ctrl+D inline pattern → existing
// llm:deepen 7-stage pipeline. AskCard popover (template='deepen') reverts to
// the original llm.run path (still gemini-CLI, kept for compat with non-deepen
// templates). Removed: ipcMain.handle('llm:deepen-popover', ...) entire block.
// llm:deepen — 7-stage Path B pipeline (per /tr 2026-04-28 council). Streams
// 'llm:deepen-progress' events { requestId, stage, status, text?, error?, label? }
// during the run; resolves with { ok, synth, ctx } or { ok:false, error }.
const _deepenPipeline = require('./lib/deepen-pipeline');
const _deepenAbort = new Map();           // requestId → AbortController
ipcMain.handle('llm:deepen', async (event, { selection, noteRel, style, lang, direction, requestId }) => {
  if (!selection || !requestId) return { ok: false, error: 'selection + requestId required' };
  const ac = new AbortController();
  _deepenAbort.set(requestId, ac);
  try {
    const result = await _deepenPipeline.runPipeline({
      selection, noteRel, style, lang, direction,
      vaultRoot: vault.resolveRoot(),
      promptsDir: path.join(__dirname, 'prompts'),
      signal: ac.signal,
      onProgress: (p) => {
        try { event.sender.send('llm:deepen-progress', { requestId, ...p }); } catch (_) {}
      },
    });
    return result;
  } finally {
    _deepenAbort.delete(requestId);
  }
});
ipcMain.handle('llm:deepen-abort', (_e, requestId) => {
  const ac = _deepenAbort.get(requestId);
  if (ac) { ac.abort(); return true; }
  return false;
});

// llm:quick — single-stage flash call (~10s) for Ctrl+Q quick query path.
// Same abort/progress mechanism as llm:deepen but uses runQuick (1 call,
// no waves, gemini-2.5-flash). Streams progress on 'llm:deepen-progress'
// (reuses the channel — Quick is just stage='quick' instead of 7 stages).
ipcMain.handle('llm:quick', async (event, { selection, noteRel, lang, direction, requestId }) => {
  if (!selection || !requestId) return { ok: false, error: 'selection + requestId required' };
  const ac = new AbortController();
  _deepenAbort.set(requestId, ac);
  try {
    const result = await _deepenPipeline.runQuick({
      selection, noteRel, lang, direction,
      vaultRoot: vault.resolveRoot(),
      promptsDir: path.join(__dirname, 'prompts'),
      signal: ac.signal,
      onProgress: (p) => {
        try { event.sender.send('llm:deepen-progress', { requestId, ...p }); } catch (_) {}
      },
    });
    return result;
  } finally {
    _deepenAbort.delete(requestId);
  }
});

// llm:expand — 3-axis lateral exploration (canon-cold / personal-cold / model-cold).
// Mirror deepen's progress/abort pattern. Streams 'llm:expand-progress' events
// { requestId, stage, status, text?, error?, label? }.
const _expandPipeline = require('./lib/expand-pipeline');
const _expandAbort = new Map();
ipcMain.handle('llm:expand', async (event, { selection, noteRel, lang, direction, requestId }) => {
  if (!selection || !requestId) return { ok: false, error: 'selection + requestId required' };
  const ac = new AbortController();
  _expandAbort.set(requestId, ac);
  try {
    const result = await _expandPipeline.runPipeline({
      selection, noteRel, lang, direction,
      vaultRoot: vault.resolveRoot(),
      promptsDir: path.join(__dirname, 'prompts'),
      signal: ac.signal,
      onProgress: (p) => {
        try { event.sender.send('llm:expand-progress', { requestId, ...p }); } catch (_) {}
      },
    });
    return result;
  } finally {
    _expandAbort.delete(requestId);
  }
});
ipcMain.handle('llm:expand-abort', (_e, requestId) => {
  const ac = _expandAbort.get(requestId);
  if (ac) { ac.abort(); return true; }
  return false;
});

// llm:challenge — 4-stage adversarial scrutiny (muse / leo / scout / synth).
// Streams 'llm:challenge-progress' events.
const _challengePipeline = require('./lib/challenge-pipeline');
const _challengeAbort = new Map();
ipcMain.handle('llm:challenge', async (event, { selection, noteRel, lang, direction, requestId }) => {
  if (!selection || !requestId) return { ok: false, error: 'selection + requestId required' };
  const ac = new AbortController();
  _challengeAbort.set(requestId, ac);
  try {
    const result = await _challengePipeline.runPipeline({
      selection, noteRel, lang, direction,
      vaultRoot: vault.resolveRoot(),
      promptsDir: path.join(__dirname, 'prompts'),
      signal: ac.signal,
      onProgress: (p) => {
        try { event.sender.send('llm:challenge-progress', { requestId, ...p }); } catch (_) {}
      },
    });
    return result;
  } finally {
    _challengeAbort.delete(requestId);
  }
});
ipcMain.handle('llm:challenge-abort', (_e, requestId) => {
  const ac = _challengeAbort.get(requestId);
  if (ac) { ac.abort(); return true; }
  return false;
});

// llm:production-grade — single-call student draft grading (3-dim: structure /
// content depth / evidence link). intent-aware via prompts/production-<intent>.txt.
// Streams 'llm:production-progress' events. Returns { ok, scores, feedback }.
const _productionScaffold = require('./lib/production-scaffold');
const _productionAbort = new Map();
ipcMain.handle('llm:production-grade', async (event, { intent, slotTemplate, kpSlotMapping, studentDraft, lessonKPs, lang, requestId }) => {
  if (!intent || !studentDraft || !requestId) return { ok: false, error: 'intent + studentDraft + requestId required' };
  // Defensive defaults — code-reviewer HIGH: if renderer omits slotTemplate,
  // .join in gradeDraft would throw on undefined.
  slotTemplate = Array.isArray(slotTemplate) ? slotTemplate : [];
  kpSlotMapping = Array.isArray(kpSlotMapping) ? kpSlotMapping : [];
  lessonKPs = Array.isArray(lessonKPs) ? lessonKPs : [];
  const ac = new AbortController();
  _productionAbort.set(requestId, ac);
  try {
    const result = await _productionScaffold.gradeDraft({
      intent, slotTemplate, kpSlotMapping, studentDraft, lessonKPs, lang,
      promptsDir: path.join(__dirname, 'prompts'),
      signal: ac.signal,
      onProgress: (p) => {
        try { event.sender.send('llm:production-progress', { requestId, ...p }); } catch (_) {}
      },
    });
    return result;
  } finally {
    _productionAbort.delete(requestId);
  }
});
ipcMain.handle('llm:production-grade-abort', (_e, requestId) => {
  const ac = _productionAbort.get(requestId);
  if (ac) { ac.abort(); return true; }
  return false;
});

// ── W1.3 Anti-Illusion ──────────────────────────────────────────────────
// Per BLUEPRINT §7.3: detect learning-illusion (copy-AI / no-example /
// no-transfer / ghostwrite / no-action-proof / no-creation-reflow) AFTER
// user answers exit_proof; if confirmed, block next-lesson nav + surface
// a 30-second micro-task. Default-trust posture — only ai_mimicry is a
// real algorithmic check (trigram jaccard); 5 others stay shimmed until
// T4_JUDGE wiring in W1.3.1.
//
// Surface:
//   illusion:detect → run detectors, return DetectionResult (read-only)
//   illusion:gate   → produce GateResult with optional micro_task block
ipcMain.handle('illusion:detect', async (_e, payload) => {
  try {
    const { userResponse, context } = payload || {};
    const result = require('./lib/anti-illusion').detectIllusion(userResponse, context || {});
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});
ipcMain.handle('illusion:gate', async (_e, payload) => {
  try {
    const { currentLessonState, userTrace } = payload || {};
    const result = require('./lib/anti-illusion-gate').evalNextLessonGate(
      currentLessonState || {},
      userTrace || {},
    );
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.code || 'UNKNOWN', message: err.message };
  }
});

// ── W2.1 Cadence Engine ─────────────────────────────────────────────────
// Pure-function decision layer (deep / balanced / compress / final) +
// Review-Day / Integration-Day / Rest triggers. No LLM call — bridge is
// safe to wire live. See app/lib/cadence-engine.js + app/lib/cadence-state.js
// + specs/lesson-cadence.md.
//   cadence:compute  → run pure decision (read-only)
//   cadence:state    → read vault/<slug>/cadence-state.json
//   cadence:advance  → emit events + persist state delta
ipcMain.handle('cadence:compute', async (_e, args = {}) => {
  try {
    const eng = require('./lib/cadence-engine');
    const result = eng.computeCadence(args || {});
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle('cadence:state', async (_e, args = {}) => {
  try {
    const cs = require('./lib/cadence-state');
    const result = cs.loadCadenceState(args.slug);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle('cadence:advance', async (_e, args = {}) => {
  try {
    const cs = require('./lib/cadence-state');
    const { slug, decision, ctx } = args || {};
    const result = cs.advanceCadence(slug, decision, ctx || {});
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ── W4.1 7-Day Growth Path ──────────────────────────────────────────────
// Scenario orchestrator that strings W1 (Quality Harness / Anti-Illusion /
// Misconception / Capture) + W2 (Cadence / Assignment) + W3 (Creation Pool /
// Transfer / Spark / Companion) into a single 7-day AI Builder ladder. See
// app/lib/integrations/seven-day-growth.js + specs/seven-day-growth.md.
//   scenario:dayPlan  → return SEVEN_DAY_PLAN const + per-day metadata
//   scenario:runDay   → orchestrate one day (calls all 3 wave libs)
//   scenario:validate → gate the day (proof + assignment + evidence)
//   scenario:state    → next7DayState rollup from scenario-events.jsonl
//   scenario:reset    → truncate scenario-events.jsonl for a slug
ipcMain.handle('scenario:dayPlan', async () => {
  try {
    const s = require('./lib/integrations/seven-day-growth');
    return { ok: true, plan: s.SEVEN_DAY_PLAN };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle('scenario:runDay', async (_e, args = {}) => {
  try {
    const s = require('./lib/integrations/seven-day-growth');
    const { dayIdx, slug, userState, opts } = args || {};
    const result = await s.runScenarioDay(dayIdx, slug, userState || {}, opts || {});
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle('scenario:validate', async (_e, args = {}) => {
  try {
    const s = require('./lib/integrations/seven-day-growth');
    const { dayIdx, results } = args || {};
    const verdict = s.validateDayCompletion(dayIdx, results);
    return { ok: true, verdict };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle('scenario:state', async (_e, args = {}) => {
  try {
    const s = require('./lib/integrations/seven-day-growth');
    const state = s.next7DayState(args && args.slug);
    return { ok: true, state };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
ipcMain.handle('scenario:reset', async (_e, args = {}) => {
  try {
    const ev = require('./lib/integrations/scenario-events');
    const result = ev.resetScenarioEvents(args && args.slug);
    return { ok: !!result.ok, ...result };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ── W1.2 Judges ─────────────────────────────────────────────────────────
// 3 micro-judges (Goal Drift / Anti-Generic / Jargon) feeding the W1.1 9-dim
// quality-harness. Scaffold-only: T4_JUDGE LLM call inside each judge is
// mocked; pre-screen regex paths are live. See app/lib/judges/index.js.
// intentional-placeholder: real T4_JUDGE wiring deferred to W1.4 calibration.
ipcMain.handle('lesson:judge:drift', async (_e, args = {}) => {
  try {
    const j = require('./lib/judges');
    const result = await j.gradeDrift(args || {});
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});
ipcMain.handle('lesson:judge:generic', async (_e, args = {}) => {
  try {
    const j = require('./lib/judges');
    const result = await j.gradeGeneric(args || {});
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});
ipcMain.handle('lesson:judge:jargon', async (_e, args = {}) => {
  try {
    const j = require('./lib/judges');
    const result = await j.gradeJargon(args || {});
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});
ipcMain.handle('lesson:judge:all', async (_e, args = {}) => {
  try {
    const j = require('./lib/judges');
    const lessonBody = args && args.lessonBody;
    const context = (args && args.context) || {};
    const result = await j.gradeAllThree(lessonBody, context);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

// ── v0158 Agent-Sovereign Architecture ──────────────────────────────────
// Per plan 2026-05-04: Hypha = pure infrastructure (file I/O + dispatch + UI).
// Agents are sovereign actors stored under <vault>/.agents/<name>/ with their
// own identity (system-prompt.md), memory (sessions/wisdom/wiki), and
// reflection logic. Hypha owns NO prompts beyond the bundled default-tutor
// template (which user can edit/delete after seeding).
const _agentLoader = require('./lib/agent-loader');
const _agentState = require('./lib/agent-state');           // v0158b L6
const _tokenBudget = require('./lib/token-budget');          // v0158b L3
const _agentAbort = new Map();   // requestId → AbortController for agent invocations

// agent:list — returns sorted array of agent names. Auto-seeds default-tutor
// from app/prompts/agent-default-tutor.md if vault has no agents yet.
ipcMain.handle('agent:list', async () => {
  try {
    const root = vault.resolveRoot();
    if (!root) return { ok: false, error: 'no vault open' };
    const defaultPromptPath = path.join(__dirname, 'prompts', 'agent-default-tutor.md');
    _agentLoader.seedDefaultIfEmpty(root, defaultPromptPath);
    return { ok: true, agents: _agentLoader.listAgents(root) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// agent:load — read full agent state (for UI inspection / edit).
ipcMain.handle('agent:load', async (_e, { name }) => {
  try {
    const root = vault.resolveRoot();
    if (!root) return { ok: false, error: 'no vault open' };
    const a = _agentLoader.loadAgent(root, name);
    if (!a) return { ok: false, error: 'agent not found: ' + name };
    return { ok: true, agent: { name: a.name, dir: a.dir, systemPrompt: a.systemPrompt, config: a.config, latestSessionFile: a.latestSessionFile, recentTurns: a.recentSessions.length, wisdomChars: a.wisdom.length, wikiIndexChars: a.wikiIndex.length } };
  } catch (e) { return { ok: false, error: e.message }; }
});

// agent:create — create new agent dir + system-prompt.md + config.json.
ipcMain.handle('agent:create', async (_e, { name, systemPrompt, config }) => {
  try {
    const root = vault.resolveRoot();
    if (!root) return { ok: false, error: 'no vault open' };
    const dir = _agentLoader.createAgent(root, name, systemPrompt, config || {});
    return { ok: true, dir };
  } catch (e) { return { ok: false, error: e.message }; }
});

// agent:invoke — v0158h ENHANCED:
// - v0158g: L3 token budget + L6 actor state, EPHEMERAL mode for spotlight, 50ms chunk batching
// - v0158h: noteRel param — when surface='spotlight' and noteRel set, prepend note content
//   as default context so user can ask about open note without manual paste.
ipcMain.handle('agent:invoke', async (event, { name, userMsg, requestId, surface, noteRel, slug, lessonIdx }) => {
  // 2026-05-15 (MEOW R5 fix) — accept optional slug + lessonIdx and forward to
  // streamTurn so citation-verifier can read vault/<slug>/sources.json and
  // events.jsonl appends route to vault/<slug>/events.jsonl. Vault-agnostic
  // callers omit both → slug=null → citation-verifier skips (preserved).
  const _slug = (typeof slug === 'string' && slug) ? slug : null;
  const _lessonIdx = (typeof lessonIdx === 'number' && Number.isFinite(lessonIdx)) ? lessonIdx : null;
  if (!name || !userMsg || !requestId) return { ok: false, error: 'name + userMsg + requestId required' };
  const root = vault.resolveRoot();
  if (!root) return { ok: false, error: 'no vault open' };

  const surf = surface || 'spotlight';
  // v0158g — ephemeral mode for spotlight: no session memory, no session write
  const isEphemeral = (surf === 'spotlight');

  // For ephemeral, load minimal agent (skip sessions/wisdom/wiki for speed)
  const agent = isEphemeral
    ? _agentLoader.loadAgentMinimal(root, name)
    : _agentLoader.loadAgent(root, name);
  if (!agent) return { ok: false, error: 'agent not found: ' + name };
  const ac = new AbortController();
  _agentAbort.set(requestId, ac);
  const t0 = Date.now();
  const priorInvs = (agent.actorState && agent.actorState.totalInvocations) || 0;
  console.log(`[agent:invoke] name=${name} surface=${surf} ephemeral=${isEphemeral} userMsgLen=${userMsg.length} noteRel=${noteRel || '(none)'} slug=${_slug || '(none)'} lessonIdx=${_lessonIdx ?? '(none)'} requestId=${requestId} (priorInvocations=${priorInvs})`);

  try {
    const settings = _hyphaSettings();
    const effectiveSettings = { ...settings };
    if (agent.config && agent.config.model) effectiveSettings.model = agent.config.model;

    // v0158h — prepend current note content (capped 2K chars) for spotlight surface
    // when noteRel is provided. The agent gets "## Current note" header so it knows
    // this is context, not the user's question. Uses vault.read() for safe path
    // handling + frontmatter-aware reading.
    let augmentedUserMsg = userMsg;
    let noteInjected = false;
    if (isEphemeral && noteRel) {
      try {
        const note = vault.read(noteRel);
        if (note && note.body) {
          const noteContent = note.body.slice(0, 2000);
          augmentedUserMsg = `## Current note (${noteRel})\n\n${noteContent}\n\n---\n\n${userMsg}`;
          noteInjected = true;
          console.log(`[agent:invoke] note injected: rel=${noteRel} len=${noteContent.length} (cap 2000)`);
        } else {
          console.log(`[agent:invoke] note read returned empty: rel=${noteRel}`);
        }
      } catch (e) { console.log(`[agent:invoke] note read failed for ${noteRel}: ${e.message}`); }
    } else if (isEphemeral) {
      console.log(`[agent:invoke] no noteRel passed (active note unknown to spotlight trigger)`);
    }

    const ctx = _agentLoader.buildAgentContext(agent, augmentedUserMsg);

    const budget = _tokenBudget.enforceContextBudget({
      systemPrompt: ctx.systemPrompt,
      history: ctx.history,
      userMsg: ctx.userMsg,
      surface: surf,
    });
    if (budget.warning) console.log(budget.warning);
    const finalHistory = budget.history;

    // v0158g — only write session for non-ephemeral (lesson surface). Spotlight =
    // no persistence = no orphans possible.
    let sessionFile = null;
    if (!isEphemeral) {
      sessionFile = _agentLoader.appendSession(root, name, { role: 'user', text: userMsg, requestId, surface: surf });
    }

    let outText = '';
    let chunkCount = 0;
    // v0158g — chunk batching. Buffer chunks for 50ms then flush as ONE IPC.
    // Reduces IPC overhead + React rerender frequency by ~10x.
    let _chunkBuffer = '';
    let _flushTimer = null;
    const _flushChunks = () => {
      if (!_chunkBuffer) return;
      const text = _chunkBuffer;
      _chunkBuffer = '';
      try { event.sender.send('agent:chunk', { requestId, text, stage: 'chunk' }); } catch (_) {}
    };
    const _scheduleFlush = () => {
      if (_flushTimer) return;
      _flushTimer = setTimeout(() => { _flushTimer = null; _flushChunks(); }, 50);
    };

    try { event.sender.send('agent:chunk', { requestId, text: '', stage: 'start', tokensIn: budget.finalTokens, budgetWarning: budget.warning, ephemeral: isEphemeral }); } catch (_) {}

    // 2026-05-14 (Audit-B fix) — capture streamTurn result for ingratiation
    // scrub. Persist cleaned text to agent session log (not raw outText).
    let _streamResult = null;
    try {
      _streamResult = await _hyphaAgent.streamTurn(
        { systemPrompt: ctx.systemPrompt, history: finalHistory, userMsg: ctx.userMsg, settings: effectiveSettings, signal: ac.signal, slug: _slug, lessonIdx: _lessonIdx },
        (chunk) => {
          outText += chunk;
          chunkCount += 1;
          _chunkBuffer += chunk;
          _scheduleFlush();
        }
      );
    } catch (err) {
      if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
      _flushChunks();
      if (!isEphemeral) {
        _agentLoader.appendSession(root, name, { role: 'error', text: err.message, requestId, surface: surf });
      }
      console.log(`[agent:invoke] streamTurn failed: ${err.message}`);
      try { event.sender.send('agent:chunk', { requestId, text: '', stage: 'error', error: err.message }); } catch (_) {}
      return { ok: false, error: err.message, partial: outText, sessionFile };
    }

    // Final flush of any remaining buffered chunks
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    _flushChunks();

    if (!isEphemeral && outText.trim()) {
      // 2026-05-14 (Audit-B fix) — persist CLEANED text to agent session log.
      // Streamed chunks already left for renderer (uncleaned). Future history
      // replay + downstream agent invocations see clean text.
      // Machino-α8 (2026-05-15) — if anti-slop PJR produced a `rewritten`
      // version, persist that instead (rewrite is built on `cleaned`, so it
      // already incorporates ingratiation scrub).
      const _antiSlop = _streamResult && _streamResult.antiSlop;
      const _persistedText = (_antiSlop && typeof _antiSlop.rewritten === 'string' && _antiSlop.rewritten.trim())
        ? _antiSlop.rewritten
        : ((_streamResult && typeof _streamResult.cleaned === 'string')
          ? _streamResult.cleaned
          : outText);
      _agentLoader.appendSession(root, name, { role: 'assistant', text: _persistedText, requestId, surface: surf });
    }

    // Machino-α8 (2026-05-15) — emit anti-slop scan-complete to renderer so
    // Course Trust Panel β8 (deferred) can light up signals + rewrite indicator.
    try {
      const _antiSlop = _streamResult && _streamResult.antiSlop;
      if (_antiSlop && _antiSlop.signals) {
        _emitToRenderer('anti-slop:scan-complete', {
          requestId,
          slug: null,
          surface: surf,
          signals: _antiSlop.signals,
          verdict: _antiSlop.verdict || null,
          has_rewrite: !!_antiSlop.rewritten,
        });
      }
    } catch (_) { /* emit failures must not break agent:invoke return */ }

    // v0158b L6 — record invocation in actor state (totalInvocations++, lastSurface, tokens)
    const tokensOut = _tokenBudget._approxTokens(outText);
    // Rough cost estimate using Claude Sonnet-like rates ($3/M in + $15/M out). User can override per-agent in config.
    const inputRate = (effectiveSettings.model && /opus/i.test(effectiveSettings.model)) ? 15 : 3;
    const outputRate = (effectiveSettings.model && /opus/i.test(effectiveSettings.model)) ? 75 : 15;
    const costEstimateUSD = (budget.finalTokens / 1e6) * inputRate + (tokensOut / 1e6) * outputRate;
    const newState = _agentState.recordInvocation(root, name, {
      surface: surf,
      tokensIn: budget.finalTokens,
      tokensOut,
      costEstimateUSD,
    });

    try { event.sender.send('agent:chunk', { requestId, text: '', stage: 'done', tokensOut, totalInvocations: newState.totalInvocations, costEstimateUSD: newState.totalCostEstimateUSD }); } catch (_) {}
    console.log(`[agent:invoke] DONE name=${name} surface=${surf} total=${Date.now() - t0}ms chunks=${chunkCount} tokensIn=${budget.finalTokens} tokensOut=${tokensOut} cost=$${costEstimateUSD.toFixed(4)} totalInvocations=${newState.totalInvocations}`);
    return { ok: true, text: outText, chunkCount, sessionFile, tokensIn: budget.finalTokens, tokensOut, costEstimateUSD, totalInvocations: newState.totalInvocations };
  } finally {
    _agentAbort.delete(requestId);
  }
});

// agent:migrate-curricula — v0158b auto-migration. Scans vault for existing
// curriculum courses (folders containing sources.json + state.json) and creates
// a corresponding @course-<slug> agent for each. Imports existing lesson session
// JSONL files into .agents/course-<slug>/sessions/ (does NOT delete originals —
// legacy paths remain for v0158c LessonChat code switch). Returns a summary
// report so user knows what was migrated.
ipcMain.handle('agent:migrate-curricula', async () => {
  try {
    const root = vault.resolveRoot();
    if (!root) return { ok: false, error: 'no vault open' };

    // Scan vault root for course directories (have sources.json marker)
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) {}
    const courseSlugs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .filter(e => {
        try { return fs.statSync(path.join(root, e.name, 'sources.json')).isFile(); }
        catch (_) { return false; }
      })
      .map(e => e.name);

    const templatePath = path.join(__dirname, 'prompts', 'agent-course-template.md');
    let template = '';
    try { template = fs.readFileSync(templatePath, 'utf8'); }
    catch (_) {
      return { ok: false, error: 'agent-course-template.md not found at ' + templatePath };
    }

    const report = { ok: true, scanned: courseSlugs.length, created: [], skipped: [], imported_sessions: 0 };

    for (const slug of courseSlugs) {
      const agentName = `course-${slug}`.replace(/[^a-z0-9_-]/gi, '-').slice(0, 40);
      // Skip if agent already exists
      if (_agentLoader.listAgents(root).indexOf(agentName) >= 0) {
        report.skipped.push({ slug, agent: agentName, reason: 'agent already exists' });
        continue;
      }

      // Read course frontmatter from sources.json + state.json + try to find first lesson note
      let topic = slug;
      let learnGoal = '';
      let archetype = 'TECH-CONCEPTUAL';
      let priorNotes = '';
      try {
        const state = JSON.parse(fs.readFileSync(path.join(root, slug, 'state.json'), 'utf8'));
        if (state.archetype) archetype = state.archetype;
      } catch (_) {}
      try {
        const sources = JSON.parse(fs.readFileSync(path.join(root, slug, 'sources.json'), 'utf8'));
        if (sources.topic) topic = sources.topic;
        if (sources.learnGoal) learnGoal = sources.learnGoal;
        if (sources.questions && sources.questions.length > 0) {
          priorNotes = sources.questions.slice(0, 5).map((q, i) => `${i+1}. ${q}`).join('\n');
        }
      } catch (_) {}

      // Fill template
      const systemPrompt = template
        .replace(/\{\{TOPIC\}\}/g, topic)
        .replace(/\{\{LEARN_GOAL\}\}/g, learnGoal || '(not specified — infer from sources)')
        .replace(/\{\{ARCHETYPE\}\}/g, archetype)
        .replace(/\{\{PRIOR_NOTES_SUMMARY\}\}/g, priorNotes || '(no prior questions captured)')
        .replace(/\{\{COURSE_SLUG\}\}/g, slug);

      try {
        _agentLoader.createAgent(root, agentName, systemPrompt, {
          migratedFrom: slug,
          migratedAt: new Date().toISOString(),
          topic,
          learnGoal,
          archetype,
          model: null, // use vault default
        });
        report.created.push({ slug, agent: agentName, topic });
      } catch (e) {
        report.skipped.push({ slug, agent: agentName, reason: 'create failed: ' + e.message });
        continue;
      }

      // Import existing lesson sessions
      const oldSessionsDir = path.join(root, slug, 'sessions');
      const newSessionsDir = path.join(root, '.agents', agentName, 'sessions');
      try {
        if (fs.statSync(oldSessionsDir).isDirectory()) {
          const files = fs.readdirSync(oldSessionsDir).filter(f => f.endsWith('.jsonl'));
          for (const f of files) {
            const src = path.join(oldSessionsDir, f);
            const dst = path.join(newSessionsDir, f);
            try { fs.copyFileSync(src, dst); report.imported_sessions += 1; }
            catch (e) { console.log(`[migrate] copy failed ${src} → ${dst}: ${e.message}`); }
          }
        }
      } catch (_) {}
    }

    console.log(`[agent:migrate-curricula] scanned=${report.scanned} created=${report.created.length} skipped=${report.skipped.length} imported_sessions=${report.imported_sessions}`);
    return report;
  } catch (e) {
    console.log('[agent:migrate-curricula] failed:', e.message);
    return { ok: false, error: e.message };
  }
});

// agent:purge-orphans — v0158h. Walk all .agents/<name>/sessions/*.jsonl, drop
// orphan user-turns (user msg with no following assistant/tutor) + drop error
// rows. Mirrors v0158f load-time filter in agent-loader.js, but writes to disk
// so the cleanup persists. Idempotent.
ipcMain.handle('agent:purge-orphans', async () => {
  const root = vault.resolveRoot();
  if (!root) return { ok: false, error: 'no vault open' };
  const report = { ok: true, agents: [], totalDropped: 0, totalKept: 0 };
  let names = [];
  try { names = _agentLoader.listAgents(root); } catch (_) {}
  for (const name of names) {
    const sessionsDir = path.join(root, '.agents', name, 'sessions');
    let files = [];
    try { files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of files) {
      const fp = path.join(sessionsDir, f);
      let lines = [];
      try { lines = fs.readFileSync(fp, 'utf8').split('\n').map(l => l.trim()).filter(Boolean); } catch (_) { continue; }
      const turns = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } });
      const kept = [];
      for (let i = 0; i < turns.length; i++) {
        const t = turns[i];
        if (!t || !t.role) continue;
        if (t.role === 'error') continue;
        if (t.role === 'user') {
          const next = turns[i + 1];
          if (next && (next.role === 'assistant' || next.role === 'tutor')) {
            kept.push(t); kept.push(next); i++;
          }
        } else if ((t.role === 'assistant' || t.role === 'tutor')
                    && (kept.length === 0 || kept[kept.length - 1].role === 'user')) {
          kept.push(t);
        }
      }
      const dropped = turns.length - kept.length;
      if (dropped > 0) {
        try {
          fs.writeFileSync(fp, kept.map(t => JSON.stringify(t)).join('\n') + (kept.length ? '\n' : ''));
          report.agents.push({ name, file: f, kept: kept.length, dropped });
          report.totalDropped += dropped;
          report.totalKept += kept.length;
        } catch (e) { console.log(`[purge-orphans] write failed ${fp}: ${e.message}`); }
      }
    }
  }
  console.log(`[agent:purge-orphans] agents=${names.length} files-touched=${report.agents.length} dropped=${report.totalDropped} kept=${report.totalKept}`);
  return report;
});

// agent:abort — stop an in-flight agent invocation.
ipcMain.handle('agent:abort', (_e, requestId) => {
  const ac = _agentAbort.get(requestId);
  if (ac) { ac.abort(); return true; }
  return false;
});

// ── v0158c "Hypha as Local LLM Runtime" UX support ─────────────────────────
// Per user reframe 2026-05-04: Hypha is not "an app that uses APIs", it's "a
// local environment where you install an LLM". These 3 IPCs back the Colophon
// "Install LLM" panel — they wrap the same settings.json read/write the
// existing UI already does, just with the install/test/uninstall vocabulary.

const _installState = require('./lib/install-state');

// ── v0158d CLI install lifecycle ─────────────────────────────────────────────
// Per user 2026-05-04 wizard reframe: "let user pick path (API vs CLI), then
// model, then complete install". For CLI path Hypha orchestrates `npm install
// -g @anthropic-ai/claude-code` + `claude login` so user never leaves Hypha.
const _cliInstall = require('./lib/cli-install');

// cli:detect — check if `claude` binary is on PATH.
ipcMain.handle('cli:detect', async () => {
  return await _cliInstall.detectClaude();
});

// cli:install — spawn npm install -g @anthropic-ai/claude-code. Streams output
// chunks via 'cli:install-progress' so wizard can show install log live.
ipcMain.handle('cli:install', async (event) => {
  return await _cliInstall.installClaude((chunk) => {
    try { event.sender.send('cli:install-progress', { stream: 'install', text: chunk }); } catch (_) {}
  });
});

// cli:login — spawn claude login (opens browser for OAuth). Streams output.
ipcMain.handle('cli:login', async (event) => {
  return await _cliInstall.loginClaude((chunk) => {
    try { event.sender.send('cli:install-progress', { stream: 'login', text: chunk }); } catch (_) {}
  });
});

// cli:uninstall — spawn npm uninstall -g.
ipcMain.handle('cli:uninstall', async (event) => {
  return await _cliInstall.uninstallClaude((chunk) => {
    try { event.sender.send('cli:install-progress', { stream: 'uninstall', text: chunk }); } catch (_) {}
  });
});

// v0158o — slash-command auth IPCs. Used by Spotlight + LessonChat slash
// dispatcher when user types `/login` / `/logout` / `/status`. All spawns
// go through cli-install.js which now uses agent._hyphaSandboxedSpawnOpts so
// token state stays inside Hypha's sandbox (matches lesson dispatch).
ipcMain.handle('cli:auth-login', async (event) => {
  console.log('[cli:auth-login] spawning claude login in sandbox');
  // Stream stdout to renderer so chat bubble can show OAuth URL + progress.
  return await _cliInstall.loginClaude((chunk) => {
    try { event.sender.send('cli:auth-progress', { stream: 'login', text: chunk }); } catch (_) {}
    // Detect OAuth URL pattern + auto-open in user's browser.
    const m = chunk.match(/https?:\/\/[^\s]+(?:console\.anthropic\.com|claude\.ai|oauth)[^\s]*/i);
    if (m) {
      try {
        shell.openExternal(m[0]);
        event.sender.send('cli:auth-progress', { stream: 'login', text: '\n[hypha] 已在浏览器打开登录页\n' });
      } catch (_) {}
    }
  });
});
ipcMain.handle('cli:auth-logout', async (event) => {
  console.log('[cli:auth-logout] spawning claude logout in sandbox');
  return await _cliInstall.logoutClaude((chunk) => {
    try { event.sender.send('cli:auth-progress', { stream: 'logout', text: chunk }); } catch (_) {}
  });
});
ipcMain.handle('cli:auth-status', async () => {
  // v0158p — extend with oauthToken presence check from settings.
  const settings = _hyphaSettings();
  const tokenSet = !!(settings && typeof settings.oauthToken === 'string' && settings.oauthToken.trim());
  const fileStatus = _cliInstall.authStatusClaude();
  return {
    ...fileStatus,
    oauthTokenConfigured: tokenSet,
    oauthTokenLastSet: settings && settings.oauthTokenSetAt || null,
  };
});

// v0158p — store OAuth token from user paste. Token comes from real-terminal
// run of `claude setup-token` (Anthropic-blessed headless auth path per Issue
// #22992). Stored in settings.oauthToken; injected as CLAUDE_CODE_OAUTH_TOKEN
// env when sandbox spawns claude. NEVER logged in full (only prefix in console).
ipcMain.handle('claude:set-oauth-token', async (_e, { token } = {}) => {
  if (!token || typeof token !== 'string') return { ok: false, error: 'token (string) required' };
  const t = token.trim();
  if (t.length < 10) return { ok: false, error: 'token looks too short' };
  try {
    const settings = _hyphaSettings();
    settings.oauthToken = t;
    settings.oauthTokenSetAt = new Date().toISOString();
    vault.writeJSON('settings.json', settings);
    console.log(`[claude:set-oauth-token] stored token (len=${t.length}, prefix=${t.slice(0, 8)}...)`);
    return { ok: true, length: t.length };
  } catch (e) { return { ok: false, error: e.message }; }
});

// v0158p — clear stored OAuth token (from /logout slash).
ipcMain.handle('claude:clear-oauth-token', async () => {
  try {
    const settings = _hyphaSettings();
    delete settings.oauthToken;
    delete settings.oauthTokenSetAt;
    vault.writeJSON('settings.json', settings);
    console.log('[claude:clear-oauth-token] cleared');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// install:status — return current installation state for Colophon panel display.
ipcMain.handle('install:status', async () => {
  try {
    const settings = _hyphaSettings();
    return { ok: true, state: _installState.getInstallState(settings) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// install:test — send a tiny ping prompt to the installed LLM, verify round-trip.
// Updates settings._lastVerifiedAt on success. Returns latency + sample response.
ipcMain.handle('install:test', async () => {
  const t0 = Date.now();
  try {
    const settings = _hyphaSettings();
    if (!settings.apiKey || !settings.apiKey.trim()) {
      return { ok: false, error: 'no LLM installed (apiKey empty)' };
    }
    let sample = '';
    try {
      await _hyphaAgent.streamTurn({
        systemPrompt: 'You are a connectivity test. Reply only with the single word: pong',
        history: [],
        userMsg: 'ping',
        settings,
      }, (chunk) => { sample += chunk; });
    } catch (err) {
      return { ok: false, error: 'install test failed: ' + err.message, latencyMs: Date.now() - t0 };
    }
    const latencyMs = Date.now() - t0;
    // Persist verified timestamp
    try {
      const cur = vault.readJSON('settings.json', {}) || {};
      cur._lastVerifiedAt = new Date().toISOString();
      vault.writeJSON('settings.json', cur);
    } catch (e) { console.log('[install:test] settings write failed:', e.message); }
    const state = _installState.getInstallState(_hyphaSettings());
    return { ok: true, latencyMs, sample: sample.trim().slice(0, 100), state };
  } catch (e) { return { ok: false, error: e.message, latencyMs: Date.now() - t0 }; }
});

// install:uninstall — clear apiKey + _lastVerifiedAt. Leaves provider+model
// fields so user keeps their choice for re-install. Returns updated state.
ipcMain.handle('install:uninstall', async () => {
  try {
    const cur = vault.readJSON('settings.json', {}) || {};
    cur.apiKey = '';
    cur._lastVerifiedAt = null;
    delete cur._authMethod;
    delete cur._tokenSavedAt;
    vault.writeJSON('settings.json', cur);
    const state = _installState.getInstallState(_hyphaSettings());
    return { ok: true, state };
  } catch (e) { return { ok: false, error: e.message }; }
});

// shell:open-external — open URL in user's default browser (NOT in Electron
// webview). Used by DeepenCallout's synth links so clicking a frontier source
// doesn't replace the whole PTOR app. Validates http(s) scheme only — no
// arbitrary protocol handlers (file:, javascript:, etc.).
ipcMain.handle('shell:open-external', async (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'only http(s) urls allowed' };
  }
  try { await shell.openExternal(url); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

if (process.platform === 'win32') {
  app.setAppUserModelId('com.victor.ptor-design');
}

_perf.markEnd('boot:requires');
_perf.markStart('boot:app-ready-wait');
app.whenReady().then(() => {
  _perf.markEnd('boot:app-ready-wait');
  _perf.markStart('boot:window-create');
  createWindow();
  _perf.markEnd('boot:window-create');
  _perf.markStart('boot:post-window-tasks');
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // 2026-05-18 — pre-warm markitdown availability check. Cold start on
  // Windows imports all converters in Python (PDF/EPUB/DOCX/MP3/...) which
  // can take 10-30s the first time. Fire-and-forget here so the first user
  // upload skips the wait — checkAvailability populates session-long
  // positive cache, subsequent calls return instantly.
  try {
    const _md = require('./lib/markitdown-bridge');
    _md.checkAvailability().then((r) => {
      console.log('[startup] markitdown pre-warm:', r.available ? `OK v${r.version}` : 'unavailable (' + r.error + ')');
    }).catch((e) => {
      console.warn('[startup] markitdown pre-warm threw:', e && e.message);
    });
  } catch (_) { /* tolerated — converter chain has 3 fallbacks below markitdown */ }
  // 2026-05-02 — purge stale trash entries (>7d) from vault/.trash on startup.
  try {
    const result = vault.purgeStaleTrash();
    if (result && result.purged > 0) {
      console.log(`[startup] purged ${result.purged} stale trash entries (>7d)`);
    }
  } catch (_) {}
  // v1.0 boot-7 — vault meta + first-launch snapshot.
  // openVault is idempotent: bootstraps meta on true first launch, otherwise
  // bumps last_opened_at. migration_needed=true on stale schema fires the hook
  // so a future v1.1+ migration runner can pick it up; v1.0 only detects.
  try {
    const _meta = require('./lib/vault-meta');
    const _snap = require('./lib/vault-snapshot');
    const appVer = (typeof app.getVersion === 'function') ? app.getVersion() : '0.0.0';
    const opened = _meta.openVault(appVer, {
      onMigrationRequired: (m) => {
        console.log('[startup] vault schema migration needed: observed=' + m.schema_version + ' current=' + _meta.CURRENT_SCHEMA_VERSION);
      },
    });
    if (opened.ok && opened.bootstrapped) {
      console.log('[startup] vault-meta bootstrapped (schema_version=' + opened.meta.schema_version + ')');
      // First-launch courtesy snapshot — gives the user a recoverable point
      // before any course gen / import touches data. Best-effort; never blocks
      // the UI thread on failure.
      _snap.snapshotVault({ tag: 'first-launch' }).then((s) => {
        if (s && s.ok) console.log('[startup] first-launch snapshot:', s.file, '(' + s.bytes + ' bytes)');
        else if (s) console.log('[startup] first-launch snapshot skipped:', s.error);
      }).catch((e) => console.warn('[startup] first-launch snapshot threw:', e && e.message));
    } else if (opened.ok) {
      console.log('[startup] vault-meta opened (last_opened_at bumped)');
      if (opened.migration_needed) {
        console.log('[startup] migration flag set; v1.1+ runner will pick up');
      }
    } else {
      console.warn('[startup] vault-meta open failed:', opened.error);
    }
  } catch (e) { console.warn('[startup] vault-meta init threw:', e && e.message); }
  // v0158q — MVP handbook seed. On every startup, ensure `0-用户手册.md`
  // exists at vault root. If missing (fresh install OR user deleted), copy
  // bundled app/prompts/hypha-handbook-zh.md → vault. Idempotent — does not
  // overwrite existing handbook so user's edits / annotations are preserved.
  try {
    const root = vault.resolveRoot();
    if (root) {
      const handbookRel = '0-用户手册.md';
      const handbookAbs = path.join(root, handbookRel);
      if (!fs.existsSync(handbookAbs)) {
        const bundledHandbook = path.join(__dirname, 'prompts', 'hypha-handbook-zh.md');
        if (fs.existsSync(bundledHandbook)) {
          const content = fs.readFileSync(bundledHandbook, 'utf8');
          fs.writeFileSync(handbookAbs, content, 'utf8');
          console.log(`[startup] seeded handbook → ${handbookRel}`);
          // Mark so renderer knows to auto-open this on first session.
          try {
            const settings = _hyphaSettings();
            if (!settings.handbookSeededAt) {
              settings.handbookSeededAt = new Date().toISOString();
              settings.firstLaunchPendingHandbook = true;
              vault.writeJSON('settings.json', settings);
            }
          } catch (_) {}
        } else {
          console.log('[startup] bundled handbook not found at', bundledHandbook);
        }
      }
    }
  } catch (e) { console.log('[startup] handbook seed failed:', e.message); }

  // v0.5.x sub-lane (Machino-K self-shipped 2026-05-09 evening) — Frontier
  // Cron boot auto-resume. If the user enabled the cron in a previous session
  // (settings.frontierCronEnabled === true), restore on launch. Honors
  // interval setting; defaults to 6h floor if interval missing or invalid.
  // Wraps in try/catch so a cron module fault NEVER crashes app boot.
  try {
    const settings = _hyphaSettings();
    if (settings && settings.frontierCronEnabled === true) {
      const cron = require('./scripts/frontier-cron');
      const intervalHours = Math.max(6, Number(settings.frontierCronInterval) || 6);
      const r = cron.start({ intervalHours });
      if (r && r.ok === true) {
        try {
          vault.appendJSONL('events.jsonl', {
            ts: new Date().toISOString(),
            op: 'frontier_cron_boot_resumed',
            intervalHours,
          });
        } catch (_) { /* events.jsonl write non-fatal */ }
        console.log(`[startup] frontier-cron resumed @ ${intervalHours}h`);
      } else {
        console.warn('[startup] frontier_cron_boot_resume_failed:', (r && r.error) || 'unknown');
      }
    }
  } catch (e) {
    console.warn('[startup] frontier_cron_boot_resume_threw:', e.message);
  }

  // §11.7 Kill Watcher — startup sweep. Deferred 60s so `_hyphaSettings` /
  // events.jsonl / vault are settled and we never block the first paint. A
  // sweep failure NEVER crashes app boot — wrapped in try/catch + .catch().
  setTimeout(() => {
    try {
      const kw = require('./lib/creation/kill-watcher');
      kw.runKillWatcherSweep().then(r => {
        const s = (r && r.summary) || {};
        const by = (s.by_kind) || {};
        const summary = {
          slugs: s.slugs_scanned || 0,
          refuted: Array.isArray(by.assumptions_refuted) ? by.assumptions_refuted.length : 0,
          rejected: Array.isArray(by.sparks_rejected) ? by.sparks_rejected.length : 0,
          flagged: Array.isArray(by.decisions_flagged) ? by.decisions_flagged.length : 0,
          errors: Array.isArray(s.errors) ? s.errors.length : 0,
        };
        _hyphaAppendEvent('kill_watcher_startup_sweep', summary);
        // Machino-α5 — broadcast so any open assumption / spark cards refresh
        // after auto-purge. Slug omitted because the sweep is vault-wide; cards
        // can refetch unconditionally.
        _emitToRenderer('creation:kill-watch-done', { summary, source: 'startup' });
      }).catch(err => console.warn('[kill-watcher] startup sweep failed:', err.message));
    } catch (err) { console.warn('[kill-watcher] require failed:', err.message); }
  }, 60000);

  // §11.8 Roadmap Sync — startup auto-sync. Deferred 120s (60s after the
  // kill-watcher sweep so any auto-purged predictions are already on disk
  // before we roll up the week). For each top-level slug in the vault, look
  // at the most recent roadmap-weekly-*.md; if absent or ≥ 7 days old, run
  // a fresh sync. Failures are logged + an event is appended; never thrown.
  setTimeout(() => {
    try {
      const rs = require('./lib/creation/roadmap-sync');
      const ROADMAP_RE = /^roadmap-weekly-(\d{4}-\d{2}-\d{2})\.md$/;
      const root = vault.resolveRoot();
      let dirents = [];
      try { dirents = fs.readdirSync(root, { withFileTypes: true }); }
      catch (_) { dirents = []; }
      const now = new Date();
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      for (const d of dirents) {
        if (!d.isDirectory()) continue;
        if (d.name.startsWith('.')) continue;
        const slug = d.name;
        const slugDir = path.join(root, slug);
        let files = [];
        try { files = fs.readdirSync(slugDir); } catch (_) { files = []; }
        let mostRecentTs = 0;
        for (const f of files) {
          const m = f.match(ROADMAP_RE);
          if (!m) continue;
          const t = Date.parse(m[1]);
          if (Number.isFinite(t) && t > mostRecentTs) mostRecentTs = t;
        }
        const stale = !mostRecentTs || (now.getTime() - mostRecentTs) >= SEVEN_DAYS_MS;
        if (!stale) {
          _hyphaAppendEvent('roadmap_startup_sync', { slug, ran: false, skipped: 'fresh' });
          continue;
        }
        rs.runWeeklySync({ slug, settings: _hyphaSettings() })
          .then(r => {
            if (r && r.ok && r.skipped) {
              _hyphaAppendEvent('roadmap_startup_sync', { slug, ran: false, skipped: r.skipped });
              // β6 honesty fix — emit skip reason so RoadmapCard shows
              // "本节未生成 (近 7 天累积 < 3 条)" instead of staying blank.
              _emitToRenderer('creation:roadmap-synced', {
                slug,
                skipped: r.skipped,
                weekAnchorDate: null,
                mdPath: null,
                source: 'startup',
              });
            } else if (r && r.ok && r.mdPath) {
              _hyphaAppendEvent('roadmap_startup_sync', { slug, ran: true });
              // Machino-α5 — broadcast so RoadmapCard refetches with the
              // fresh roadmap-weekly-*.md after disk write completes.
              _emitToRenderer('creation:roadmap-synced', {
                slug,
                weekAnchorDate: r.weekAnchorDate || null,
                mdPath: r.mdPath || null,
                source: 'startup',
              });
            } else {
              _hyphaAppendEvent('roadmap_startup_sync', {
                slug, ran: false,
                error: r && r.error ? r.error : 'unknown',
              });
            }
          })
          .catch(err => {
            console.warn('[roadmap-sync] startup failed:', slug, err && err.message);
            _hyphaAppendEvent('roadmap_startup_sync', {
              slug, ran: false,
              error: err && err.message ? err.message : String(err),
            });
          });
      }
    } catch (err) {
      console.warn('[roadmap-sync] startup orchestrator failed:', err && err.message);
    }
  }, 120000);
  // boot-10 perf — close out post-window phase + flush trace to JSONL.
  // Wrapped so a profile failure never crashes app boot.
  try {
    _perf.markEnd('boot:post-window-tasks');
    _perf.markEnd('boot:total');
    const flushed = _perf.flushTrace(vault.resolveRoot());
    if (flushed && flushed.ok) {
      console.log(`[boot-perf] startup trace flushed → ${flushed.file} (${flushed.records} marks)`);
    } else if (flushed && flushed.error) {
      console.warn('[boot-perf] flush failed:', flushed.error);
    }
  } catch (e) { console.warn('[boot-perf] mark/flush threw:', e && e.message); }
});

// ============================================================================
// Hypha extensions — curriculum creation, Socratic lesson streaming, distill.
// Plugs into the lifted PTOR2 UI without modifying its core flow:
//   - VaultTree's "+" menu adds "Learn" → curriculum:create
//   - NoteView header adds "Tutor" + "Finish lesson" buttons (when frontmatter
//     has lesson_idx) → llm:lesson + lesson:finish
//   - DeepenCallout reused with mode='lesson' → llm:lesson streams via
//     llm:deepen-progress channel (already wired in preload)
// ============================================================================
const _hyphaAgent = require('./agent');

// Hypha Learn mode (v0158q) — STAKE substrate + state machine + answer-leak guard.
// Loaded once; pure-function modules with no side effects on require.
const _hyphaLearnStake = require('./lib/hypha-learn/stake-block');
const _hyphaLearnSM    = require('./lib/hypha-learn/state-machine');
const _hyphaLearnGuard = require('./lib/hypha-learn/answer-leak-guard');

// Cached prompt-template loader. Reads app/prompts/<name>.txt once per process.
// Mirrors the on-the-fly readFileSync pattern in `llm:run` (line ~916) but
// memoizes so per-turn handlers don't re-hit disk every reply.
const _promptTplCache = new Map();
function _loadPromptTemplate(name) {
  const cached = _promptTplCache.get(name);
  if (typeof cached === 'string') return cached;
  const p = path.join(__dirname, 'prompts', `${name}.txt`);
  const tpl = fs.readFileSync(p, 'utf8');
  _promptTplCache.set(name, tpl);
  return tpl;
}

// 2026-05-17 fix — Windows FAT32 (E:\victor on this machine) fails `mkdir`
// for long Chinese directory names (≥ 22 CJK chars reproducible UNKNOWN
// errno -4094). NTFS (C:) handles it; FAT32 LFN + Chinese Windows codepage
// combo breaks at byte length ≈ 50+. Slug now caps Chinese prefix to 12
// chars + sha1[0:8] hash suffix when CJK present, keeping bytes < 50 and
// preserving uniqueness. Pure-ASCII slugs (English topics) keep the 60-char
// limit since they're 1 byte each.
function _topicSlug(topic) {
  const cleaned = String(topic || '').toLowerCase().trim()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!cleaned) return 'untitled';
  const hasCJK = /[一-鿿]/.test(cleaned);
  if (hasCJK && cleaned.length > 14) {
    const crypto = require('node:crypto');
    const hash = crypto.createHash('sha1').update(cleaned).digest('hex').slice(0, 8);
    return cleaned.slice(0, 12).replace(/-+$/g, '') + '-' + hash;
  }
  return cleaned.slice(0, 60);
}

// 2026-05-03 — providers deprecated for tutor use due to vendor-CLI persona
// pollution (Claude Code / gemini-cli load their own ~30k-token persona that
// cannot be fully overridden — leaks "Machino" / "[YOUR REPLY AS TUTOR]" /
// meta-confused replies into Hypha tutor turns). On startup, settings using
// these providers auto-migrate to a working alternative with prior preserved.
const TUTOR_INCOMPATIBLE_PROVIDERS = new Set(['claude-cli', 'gemini-cli', 'codex-cli']);

function _hyphaSettings() {
  // Settings live in the vault as settings.json so they survive close+reopen.
  // First-run default = GLM 5 + Victor's baked token (env), no key user-side.
  let cur;
  if (vault.exists && vault.exists('settings.json')) {
    cur = vault.readJSON('settings.json', null) || _hyphaDefaultSettings();
    // Backfill `app` block on settings.json files written before the general
    // tab existed. Missing keys take APP_DEFAULTS.
    cur.app = { ...APP_DEFAULTS, ...(cur.app || {}) };
    // Tutor-quality migration: if user is on a vendor-CLI provider that leaks
    // persona into tutor output, switch to the closest working clean alt.
    // Migration target priority:
    //   1. claude (sdk-anthropic) — if apiKey already starts with sk-ant
    //   2. hypha-managed — if hyphaToken is set (free 30 turns/day)
    //   3. claude (sdk-anthropic) with empty key — surfaces "configure key" prompt
    // v0151 — env opt-in: HYPHA_ALLOW_CLI=1 bypasses the auto-migration so
    // personal CLI access works (set by Hypha-personal.bat in packed builds;
    // NEVER set in clean distribution Hypha.exe launch). Lets the operator
    // pick claude-cli / gemini-cli / codex-cli in settings without it being
    // silently rewritten back to the SDK provider.
    if (cur.provider && TUTOR_INCOMPATIBLE_PROVIDERS.has(cur.provider) && !cur._migratedFrom && !process.env.HYPHA_ALLOW_CLI) {
      const previous = cur.provider;
      let target = 'claude';
      if (cur.apiKey && /^sk-ant-/.test(cur.apiKey)) target = 'claude';
      else if (cur.hyphaToken) target = 'hypha-managed';
      cur._migratedFrom = previous;
      cur._migratedAt = new Date().toISOString();
      cur._migrationReason = 'cli persona pollution affects tutor quality';
      cur.provider = target;
      // Reset baseURL/model to the new provider's defaults
      try {
        const providers = require('./lib/providers');
        const p = providers.getProvider(target);
        if (p) {
          cur.baseURL = p.baseURL || '';
          if (!cur.model || cur.model.includes('claude-')) {
            // keep existing claude model id if compatible, else use default
          } else {
            cur.model = p.defaultModel;
          }
        }
      } catch (_) {}
      vault.writeJSON('settings.json', cur);
      try { _hyphaAppendEvent('provider_migrated', { from: previous, to: target, reason: 'tutor_incompatible_cli' }); } catch (_) {}
    }
  } else {
    cur = _hyphaDefaultSettings();
    vault.writeJSON('settings.json', cur);
  }
  // v0.5.1 — pin user profile onto every settings read so agent.js LLM calls
  // (clarifyQuestions / classifyPriorKnowledge / planChain / designSeed) can
  // ground assessments against the student's real self-introduction. Profile
  // lives at vault/data/profile.json with history sidecar for resilience.
  let userProfile = null;
  try {
    if (vault.exists && vault.exists('data/profile.json')) {
      userProfile = vault.readJSON('data/profile.json', null);
    }
    if (!userProfile || (!userProfile.name && !userProfile.about && !userProfile.tutorName)) {
      const restored = _hyphaProfileRestoreFromHistory();
      if (restored) userProfile = restored;
    }
  } catch (_) {}
  if (userProfile) cur.userProfile = userProfile;
  return cur;
}
// App-level UI/UX defaults (separate from LLM provider config). All optional
// — first-run keeps current behavior. Tab "general" in the settings modal
// edits these; other modules (App.jsx default view, Theme.jsx auto-switch
// gate, LessonChat auto-begin gate) read them on mount + on
// `hypha:settings-updated` event.
const APP_DEFAULTS = {
  autoBeginLesson: true,            // false → user clicks "begin" instead of tutor speaking first
  defaultView: 'evolution',         // 'evolution' | 'recall' — landing surface on app boot
  fontFamily: 'editorial',          // 'editorial' (Garamond+SongCJK) | 'system' (system-ui fallback)
  fontSize: 'default',              // 'small' | 'default' | 'large' — affects chat bubble body
  themeAuto: true,                  // true → time-of-day clock switches; false → manual only
  // v0.5.2 — Frontier scheduler. cron sweeps active topics every Nh (≥6h
  // floor) and writes vault/.frontier-digest/<date>.md. Data-only this lane;
  // visible UI deferred per plan §Deferred Lanes.
  frontierCronEnabled: false,       // master switch — false leaves cron idle
  frontierCronInterval: 6,          // hours; ≥6 enforced by start() resolver
};

function _hyphaDefaultSettings() {
  // Two-track default per user 2026-04-30:
  //   - Alpha-binary build (electron-builder packaging): HYPHA_DEFAULT_GLM_KEY
  //     env baked → defaults to GLM track with Victor's GLM sub-key.
  //   - Dev / post-revoke / no env: defaults to Claude (user preferred).
  // Registry source: app/lib/providers.js
  const providers = require('./lib/providers');
  const glmKey = process.env.HYPHA_DEFAULT_GLM_KEY;
  const base = glmKey
    ? { ...providers.defaultSettingsFor('glm'), apiKey: glmKey }
    : { ...providers.defaultSettingsFor('claude'), apiKey: process.env.ANTHROPIC_API_KEY || '' };
  return { ...base, app: { ...APP_DEFAULTS } };
}

function _hyphaAppendEvent(op, payload) {
  try { vault.appendJSONL('events.jsonl', { ts: new Date().toISOString(), op, ...payload }); }
  catch (_) {}
}

// v0.4.4 — slugs the user has cancelled mid-creation. The curriculum:create
// handler checks this set after each await; if present, it bails, deletes the
// partial slug, and returns { ok: false, cancelled: true }.
const _curriculumCancelled = new Set();
function _hyphaCancelCheck(slug) {
  if (_curriculumCancelled.has(slug)) {
    _curriculumCancelled.delete(slug);
    const err = new Error('cancelled');
    err.code = 'CURRICULUM_CANCELLED';
    throw err;
  }
}

ipcMain.handle('curriculum:cancel', async (_e, { topic } = {}) => {
  const slug = _topicSlug(topic || '');
  if (!slug) return { ok: false, error: 'no topic' };
  _curriculumCancelled.add(slug);
  // Best-effort: delete any partial slug dir written before the cancel check fires.
  try { vault.del(slug); }
  catch (delErr) {
    // boot-7: TypeError here = vault API drift (per silent_catch_hides_typeerror memory).
    if (delErr && delErr.name === 'TypeError') {
      console.error('[CRITICAL][curriculum:cancel] vault.del TypeError:', delErr.message, 'slug=', slug);
    } else if (delErr) {
      console.warn('[curriculum:cancel] vault.del partial-slug cleanup failed:', delErr.message);
    }
  }
  try { _hyphaAppendEvent('curriculum_cancelled', { topic: slug }); } catch (_) {} // intentional: telemetry append never blocks user cancel
  return { ok: true };
});

// curriculum:create — full topic→curriculum flow.
//   1. agent.harvest(topic) → sources[]
//   2. agent.designSequence(topic, sources, level) → lessons[]
//   3. write <slug>/sources.json + <slug>/state.json + <slug>/lesson-NN.md (one per lesson)
//   4. emit progress events to renderer for status display
// _runCurriculumCreate — shared body of the curriculum:create pipeline so other
// IPC handlers (e.g. chain:accept) can drive a curriculum end-to-end without
// going through ipcRenderer round-trips. `event` may be null when invoked from
// a non-renderer context — emit() guards against that.
async function _runCurriculumCreate(event, { topic, level, goal, timeCommit, customLessons, clarifications, uploadedSource, tier, prePrediction, lesson_mode, goalContract } = {}) {
  const slug = _topicSlug(topic);
  const settings = _hyphaSettings();
  // v0158q — Hypha Learn opt-in. UI radio (TabContent) passes 'classic' | 'learn' | 'raw'.
  // 2026-05-05 — 'raw' added as 3rd option, only visible when provider=claude-cli;
  // signals explicit pure-CLI passthrough at curriculum level (frontmatter persisted).
  // Default to classic when undefined so existing flows are byte-identical.
  const learnMode = (lesson_mode === 'learn') ? 'learn'
                  : (lesson_mode === 'raw')   ? 'raw'
                  : 'classic';
  // 2026-05-05 (Appendix B) — multi-file uploadedSource. Lift legacy single-file
  // shape via _normalizeUploadedSource so old chains keep working without
  // migration. After this, uploadedSource is either null or {files:[...], totals}.
  const _norm = require('./lib/source-extractor')._normalizeUploadedSource;
  uploadedSource = _norm(uploadedSource);
  const emit = (stage, extra = {}) => {
    try {
      if (event && event.sender && typeof event.sender.send === 'function') {
        event.sender.send('curriculum:progress', { topic: slug, stage, ...extra });
      }
    } catch (_) {}
  };
  _hyphaAppendEvent('curriculum_start', { topic: slug, level, goal, timeCommit, customLessons, clarifCount: (clarifications || []).length, sourceMode: uploadedSource ? 'upload' : 'web', uploadFileCount: uploadedSource ? (uploadedSource.totalFiles || (uploadedSource.files || []).length) : 0 });
  // v0.4.4 — clear any stale cancel flag from a previous attempt with the same slug.
  _curriculumCancelled.delete(slug);
  try {
    let sources;
    // v0.7.0 — preHarvestArchetype: when the web-harvest branch runs, we
    // classify archetype FIRST so harvest can route channels. Reused later
    // by Step A so we avoid a second classifyArchetype call.
    let preHarvestArchetype = null;
    if (uploadedSource && Array.isArray(uploadedSource.files) && uploadedSource.files.length > 0) {
      // v0.5.0 + Appendix B 2026-05-05 — user provided source documents.
      // Skip web harvest; build sources.json from each file's chapters,
      // flattening across files. Each chapter becomes one row BM25 can rank
      // against per-lesson via rankSourcesBM25.
      const firstName = uploadedSource.files[0].fileName;
      emit('reading-source', {
        fileName: firstName,
        fileCount: uploadedSource.files.length,
      });
      sources = [];
      uploadedSource.files.forEach((file, fIdx) => {
        const fileName = file.fileName || `file-${fIdx + 1}`;
        const chapters = Array.isArray(file.chapters) ? file.chapters : [];
        // 2026-05-05 — sourceType propagates from the file (user-upload OR
        // user-url). user-url chapters get BM25 boost in rankSourcesBM25 since
        // user explicitly chose those URLs as authoritative sources.
        const _fileSourceType = (file.sourceType === 'user-url') ? 'user-url' : 'user-upload';
        chapters.forEach((ch, cIdx) => {
          sources.push({
            title: ch.title || `${fileName} · Section ${cIdx + 1}`,
            url: file.url || `local://${fileName}#chapter-${cIdx}`,
            excerpt: String(ch.text || '').slice(0, 400),
            sourceType: _fileSourceType,
            fileName: fileName,
            fileIdx: fIdx,
            chapterIdx: cIdx,
            chapterStart: ch.startCharIdx || 0,
          });
        });
        // Persist each file's full text under the slug dir. New names use
        // file index prefix; legacy single-file callers still see
        // source-document.txt for backward compat (first file only).
        try {
          const safeName = String(fileName).replace(/[^\w.\-]+/g, '_').slice(0, 80);
          vault.write(`${slug}/source-${fIdx}-${safeName}.txt`, file.text || '');
          if (fIdx === 0) {
            // Legacy alias — first file double-written for any reader still
            // expecting the old path. Cheap; remove in a future cleanup pass.
            vault.write(`${slug}/source-document.txt`, file.text || '');
          }
        } catch (_) {}
      });
    } else {
      // v0.7.0 — classify archetype BEFORE harvest so harvest can route channels.
      // Adds ~2s upfront but archetype routing skips irrelevant channels (e.g.
      // SEP for "React Hooks") so total harvest latency is lower or equal.
      try { preHarvestArchetype = await _hyphaAgent.classifyArchetype(topic, goal, settings); }
      catch (_) { preHarvestArchetype = 'TECH-CONCEPT'; }
      _hyphaCancelCheck(slug);
      emit('harvesting');
      // 2026-05-17 阶 2 — emit difficulty signal even in legacy harvest path so
      // BuildLog has a row for it. Legacy harvest doesn't accept budget knobs;
      // signal is informational only here. The 2-stage harvestV3 path (above
      // in _runHarvestAndSkeleton) is where the cap actually scales.
      let _legacyDifficulty = 0.6;
      try {
        const _gg = require('./lib/creation/goal-guardian');
        const _goalText = (goalContract && goalContract.north_star_goal) || goal || topic || '';
        _legacyDifficulty = _gg._estimateDifficulty(_goalText);
        const _mult = 0.7 + _legacyDifficulty * 1.5;
        emit('difficulty:set', {
          difficulty: _legacyDifficulty,
          mult: Number(_mult.toFixed(2)),
          source: 'goal-guardian._estimateDifficulty',
          stage: 'curriculum:create (legacy harvest)',
        });
      } catch (_) {}
      sources = await _hyphaAgent.harvest(topic, settings, null, preHarvestArchetype || 'TECH-CONCEPT', _legacyDifficulty);
    }
    _hyphaCancelCheck(slug);
    vault.writeJSON(`${slug}/sources.json`, sources);

    // 2026-05-17 build-log enrichment — emit top-5 sources so renderer can show
    // user actual harvest result, not just count. See `app/design/build-log.jsx`.
    const _top5Sources = (Array.isArray(sources) ? sources : []).slice(0, 5).map(s => ({
      title:  (s && typeof s.title  === 'string') ? s.title.slice(0, 120) : '',
      domain: (s && typeof s.domain === 'string') ? s.domain.slice(0, 80) : '',
      kind:   (s && typeof s.sourceType === 'string') ? s.sourceType : (s && s.kind) || 'web',
    }));
    emit('harvest:done', { sourceCount: sources.length, top5: _top5Sources });

    emit('designing', { sourceCount: sources.length });
    // v0.4.0 three-stage pipeline replaces the 14k-token monolith. v0.2 Surface
    // followup 2026-05-09 — replaced opaque 5s-heartbeat with per-substep
    // emits so the GenerationProgress card shows real progression
    // (archetype → digest → seed) instead of "still shaping..." spam.
    let archetype, seedResult;
    try {
      // Step A: classify archetype (1 small LLM call, ~2s). v0.7.0 — if we
      // already classified pre-harvest (web path), reuse that result instead
      // of re-running. Saves the second classifyArchetype call.
      if (preHarvestArchetype) {
        archetype = preHarvestArchetype;
        emit('designing-archetype', { reused: true, archetype });
      } else {
        emit('designing-archetype', { reused: false });
        archetype = await _hyphaAgent.classifyArchetype(topic, goal, settings);
        emit('designing-archetype-done', { archetype });
      }
      _hyphaCancelCheck(slug);
      // Step B: source digest (1 small LLM call, ~3s). Compresses 25 raw
      // sources to a ~500-token digest so designSeed isn't drowning in raw lines.
      emit('designing-digest', {});
      let sourceDigest = '';
      try { sourceDigest = await _hyphaAgent.summarizeSources(topic, sources, settings, { archetype }); }
      catch (_) { sourceDigest = sources.slice(0, 10).map(s => `- ${s.title}`).join('\n'); }
      emit('designing-digest-done', {
        digest_chars: sourceDigest.length,
        // 2026-05-17 build-log — first 500 chars of digest so user sees what
        // HYPHA distilled from the raw sources before seeding lessons.
        preview: (typeof sourceDigest === 'string' ? sourceDigest.slice(0, 500) : ''),
      });
      _hyphaCancelCheck(slug);
      // Step C: designSeed (1 small LLM call, ~5-8s). Returns phases (from
      // template, no LLM cost), firstLesson, trajectory, and a flat lessonPlan
      // with one slot per phase × phaseLessonCount. Slot 0 has firstLesson;
      // rest are ghost slots awaiting just-in-time materialization.
      // 2026-05-13 v2 — emit derived lesson count BEFORE LLM call. Time-floor
      // + intent-density (user: "100天给38节什么意思 至少一天一节").
      try {
        if (typeof _hyphaAgent.deriveLessonTarget === 'function') {
          const _derived = _hyphaAgent.deriveLessonTarget({
            timeCommit: timeCommit || null,
            customLessons,
            user_intent: (goalContract && goalContract.user_intent) || null,
            topic,
            deadline: (goalContract && goalContract.deadline) || null,
            days: (goalContract && goalContract.days) || null,
          });
          emit('lesson-count-derived', { target: _derived.target, reasoning: _derived.reasoning });
        }
      } catch (_) {}

      emit('designing-seed', {});
      seedResult = await _hyphaAgent.designSeed({
        topic, goal: goal || '', archetype,
        timeCommit: timeCommit || 'month',
        customLessons: customLessons,
        tier: tier || 'moderate',
        clarifications: clarifications || [],
        sourceDigest,
        goalContract: goalContract || null,
      }, settings);
      // 2026-05-17 build-log — emit first 5 lesson titles so user sees the
      // syllabus skeleton (catches "skipped pre-Socratics" failure mode early).
      const _syllabusPreview = (Array.isArray(seedResult.lessonPlan) ? seedResult.lessonPlan : [])
        .slice(0, 5)
        .map((slot, i) => ({
          idx: typeof slot.idx === 'number' ? slot.idx : i,
          title: (slot && typeof slot.title === 'string') ? slot.title.slice(0, 120) : '(untitled)',
          phase: (slot && typeof slot.phaseLabel === 'string') ? slot.phaseLabel : null,
        }));
      emit('designing-seed-done', {
        lesson_count: seedResult.lessonPlan.length,
        syllabus_preview: _syllabusPreview,
      });
      _hyphaCancelCheck(slug);

      // 2026-05-13 — critique loop on legacy path too. Onboarding flow goes
      // through curriculum:create (legacy single-shot), so without this the
      // critique never fires. Mirror the v0.3 wire at _runHarvestAndSkeleton.
      try {
        const harvestCtx = {
          libraryRollup: (typeof _hyphaAgent.getLibraryRollupForTopic === 'function') ? _hyphaAgent.getLibraryRollupForTopic(topic) : null,
          communityHint: (typeof _hyphaAgent.getCommunityHintForTopic === 'function') ? _hyphaAgent.getCommunityHintForTopic(topic) : null,
        };
        if (typeof _hyphaAgent.critiqueAndRefineSkeleton === 'function') {
          emit('critique:start', { skeleton_n: (seedResult.lessonPlan || []).length });
          const refined = await _hyphaAgent.critiqueAndRefineSkeleton({
            initialSkeleton: seedResult,
            topic,
            goal: goal || '',
            archetype,
            harvestContext: harvestCtx,
            sourceDigest,
            structureAnchor: null,
            onProgress: (stage, extra) => emit(stage, extra),
          }, settings);
          if (refined && Array.isArray(refined.lessonPlan) && refined.lessonPlan.length > 0) {
            // Preserve legacy fields the downstream writer expects (firstLesson,
            // phases, archetype). Refined output overrides lessonPlan + trajectory only.
            seedResult = Object.assign({}, seedResult, {
              lessonPlan: refined.lessonPlan,
              trajectory: refined.trajectory || seedResult.trajectory,
              _meta: Object.assign({}, seedResult._meta || {}, refined._meta || {}),
            });
          }
          // 2026-05-17 build-log — surface up to 3 finding text snippets per agent
          // so user sees what the council actually caught.
          const _critiqueMeta = (refined && refined._meta && refined._meta.critique) || {};
          const _pickFindings = (arr) => (Array.isArray(arr) ? arr : [])
            .slice(0, 3)
            .map(f => (typeof f === 'string' ? f : (f && f.text) || (f && f.finding) || JSON.stringify(f)).slice(0, 160));
          emit('critique:done', {
            refined: !!_critiqueMeta.refined,
            findings_total: (_critiqueMeta.lung_findings_n || 0)
              + (_critiqueMeta.muse_findings_n || 0)
              + (_critiqueMeta.scout_findings_n || 0),
            lung_preview:  _pickFindings(_critiqueMeta.lung_findings),
            muse_preview:  _pickFindings(_critiqueMeta.muse_findings),
            scout_preview: _pickFindings(_critiqueMeta.scout_findings),
          });
        }
      } catch (critiqueErr) {
        console.warn('[curriculum:create legacy] critique loop failed:', critiqueErr && critiqueErr.message);
        emit('critique:failed', { error: (critiqueErr && critiqueErr.message) || String(critiqueErr) });
      }
      _hyphaCancelCheck(slug);
    } catch (err) {
      try { vault.del(slug); }
      catch (delErr) {
        // boot-7: destructive vault op — TypeError = API drift, surface loudly.
        if (delErr && delErr.name === 'TypeError') {
          console.error('[CRITICAL][curriculum:create legacy] vault.del TypeError on rollback:', delErr.message, 'slug=', slug);
        } else if (delErr) {
          console.warn('[curriculum:create legacy] vault.del rollback failed:', delErr.message);
        }
      }
      if (err && err.code === 'CURRICULUM_CANCELLED') {
        try { _hyphaAppendEvent('curriculum_cancelled', { topic: slug, stage: 'seed' }); } catch (_) {}
        return { ok: false, cancelled: true };
      }
      try { _hyphaAppendEvent('curriculum_failed', { topic: slug, error: err.message, stage: 'seed' }); } catch (_) {}
      if (err && err.code === 'LLM_TIMEOUT') {
        emit('error', { error: 'curriculum seeding took too long; check your network and retry.' });
        return { ok: false, error: 'seed timeout' };
      }
      emit('error', { error: err.message || 'curriculum seeding failed' });
      return { ok: false, error: err.message };
    }
    emit('writing-lessons', { lessonCount: seedResult.lessonPlan.length, archetype });
    // v0158m — Write only lesson 0 as a real .md; remaining slots write as GHOST stubs
    // (frontmatter ghost: true + empty body — no `_pending_` literal). UI renders the
    // learn_goal text + 〔题目待落笔〕 marker for ghost lessons, NEVER the literal
    // string. Ghost lessons re-write themselves at lesson:finish via JIT-recast
    // (proposeNextLesson called proactively, not on-navigate).
    const lessonRels = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const slot of seedResult.lessonPlan) {
      const isFirst = slot.idx === 0;
      const isGhost = !!slot.ghost;
      // v0158m — for ghost lessons, no fabricated phase-stub title; leave title
      // null so chain views fall back to learn_goal display + 〔题目待落笔〕 hint.
      const title = slot.title || (isGhost ? '' : 'Lesson');
      const learnGoal = slot.learnGoal || '';
      const fmLines = [
        '---',
        `lesson_idx: ${slot.idx}`,
        `learn_goal: ${JSON.stringify(learnGoal)}`,
        `locked: ${!isFirst}`,
        `topic_slug: ${slug}`,
        `date_created: ${today}`,
        `date_distilled: null`,
        `phase_id: ${slot.phaseId}`,
        `phase_label: ${JSON.stringify(slot.phaseLabel)}`,
        `phase_lesson_idx: ${slot.phaseLessonIdx}`,
      ];
      if (isGhost) fmLines.push('ghost: true');
      // v0158q — persist Hypha Learn opt-in on the note so NoteView reads
      // meta.frontmatter.learn_mode to render state-tag chrome and the tutor
      // handler picks up mode without an extra IPC arg. Always written so a
      // ghost recast (proposeNextLesson) carries it forward unchanged.
      fmLines.push(`learn_mode: ${learnMode}`);
      // v0158m — emit concept_id when designSequence provided one (P6 trigger).
      if (typeof slot.conceptId === 'string' && slot.conceptId.trim()) {
        fmLines.push(`concept_id: ${JSON.stringify(slot.conceptId.trim())}`);
      }
      // v0.10.0 — pre-read prediction from antechamber wait card. Only the
      // first non-ghost lesson gets it (that's the one the user was looking
      // at when they predicted). Empty/skipped predictions are not written.
      if (isFirst && !isGhost && typeof prePrediction === 'string' && prePrediction.trim()) {
        fmLines.push(`pre_read_prediction: ${JSON.stringify(prePrediction.trim())}`);
      }
      fmLines.push('---');
      const fm = fmLines.join('\n');
      // v0158m — ghost body is empty (NoteView renders italic Garamond hint
      // "lesson 待落笔 — 先完成上一节"); real lesson body keeps existing template.
      const body = isGhost
        ? `${fm}\n`
        : `${fm}\n\n# ${title}\n\n## 课程基础\n\n*This lesson hasn't been taught yet. Open the Tutor to begin.*\n\n## 用户灵感\n\n`;
      // v0158m — ghost filename uses lesson-idx + slot.phaseLabel slug instead of
      // 'pending'. designSequence may emit slot.titleSlug; fall back to phase if absent.
      const ghostSlug = (slot.titleSlug || _topicSlug(slot.phaseLabel || 'lesson')).slice(0, 30);
      const rel = `${slug}/${String(slot.idx).padStart(2, '0')}-${isGhost ? ghostSlug : _topicSlug(title).slice(0, 30)}.md`;
      vault.write(rel, body);
      lessonRels.push(rel);
    }

    vault.writeJSON(`${slug}/state.json`, {
      mastered: [], gaps: [],
      preferences: { level: level || 'intermediate' },
      goal: goal || '',
      goalContract: goalContract || null,
      timeCommit: timeCommit || 'month',
      customLessons: (typeof customLessons === 'number') ? customLessons : null,
      tier: tier || 'moderate',
      sourceMode: uploadedSource ? 'upload' : 'web',
      uploadedFileName: uploadedSource ? (uploadedSource.files && uploadedSource.files[0] && uploadedSource.files[0].fileName) || uploadedSource.fileName || null : null,
      uploadedFileNames: uploadedSource ? (uploadedSource.files || []).map(f => f.fileName).filter(Boolean) : [],
      uploadedFileCount: uploadedSource ? (uploadedSource.totalFiles || (uploadedSource.files || []).length) : 0,
      clarifications: clarifications || [],
      archetype,
      phases: seedResult.phases,
      trajectory: seedResult.trajectory,
      concepts: {},
      lastIdx: -1,
      lessonRels,
      // v0158q — curriculum-wide Hypha Learn flag mirrors per-note frontmatter.
      learn_mode: learnMode,
    });

    // W2.1 Cadence Engine — seed initial cadence-state.json so UI CadenceCard
    // + decision pipeline has a baseline. Pure persistence, no LLM call.
    // Non-fatal: cadence is advisory display, doesn't block lesson flow.
    try {
      const cs = require('./lib/cadence-state');
      cs.updateCadenceState(slug, {
        cadenceMode: null,
        lastReviewIdx: null,
        milestoneCrossed: [],
        restCount: 0,
        lastRestIdx: null,
        lessonsSinceLastRest: 0,
      });
    } catch (cErr) {
      console.warn('[curriculum:create] cadence-state seed failed (non-fatal):', cErr && cErr.message);
    }

    // Auto-derive a tutor persona from topic + goal + clarifications. User can
    // override anytime via right-click → Customize Tutor. Only seeded if no
    // agent.json exists yet (don't clobber an existing customization).
    if (!vault.exists(`${slug}/agent.json`)) {
      const personas = require('./lib/personas');
      // Onboarding teacher selector (2026-05-12) — user explicit pick from
      // app/lib/personas.js wins over auto-derive. derivePersona only fires
      // when goalContract has no teacher_persona (legacy callers + flows that
      // bypass onboarding).
      const explicit = goalContract && goalContract.teacher_persona;
      const personaId = explicit || personas.derivePersona({ topic, goal, clarifications: clarifications || [] });
      vault.writeJSON(`${slug}/agent.json`, {
        persona: personaId,
        customInstructions: '',
        derivedFromClarifications: !explicit,
        updatedAt: new Date().toISOString(),
      });
    }

    // v0.2 Track B B1 auto-fire — generate lesson 0's prep body BEFORE the
    // user opens LessonChat, so the thesis card renders on first paint and
    // the tutor's first turn is anchored in real prep notes (! cold open).
    // Wrap in try-catch + emit progress stage; failure is non-fatal — the
    // designLesson learn path falls through to v0.4 grounding-only when
    // body.json is absent.
    try {
      emit('writing-body-0', {});
      const stateNow = vault.readJSON(`${slug}/state.json`, null) || {};
      const sourcesNow = vault.readJSON(`${slug}/sources.json`, []) || [];
      const slot0 = (Array.isArray(stateNow.lessonPlan) && stateNow.lessonPlan[0]) || {};
      const plan0 = {
        objective: slot0.learnGoal || slot0.title || '',
        title: slot0.title || '',
        path: Array.isArray(slot0.path) ? slot0.path : [],
        micro_proof: slot0.micro_proof || {},
      };
      const goalContract0 = (stateNow.goalContract) || {
        north_star_goal: stateNow.topic || slug,
        current_level: 'self-directed adult learner',
      };
      const learnerState0 = { known: stateNow.mastered || [], unknown: stateNow.gaps || [] };
      const r0 = await lessonBodyGen.generateLessonBodyV2({
        plan: plan0,
        goalContract: goalContract0,
        sources: sourcesNow,
        learnerState: learnerState0,
        lessonTitle: slot0.title,
        learnGoal: slot0.learnGoal,
        idx: 0,
        pedagogicalArchetype: stateNow.archetype || null,
      });
      vault.writeJSON(`${slug}/lesson-0.body.json`, {
        body: r0.body,
        _meta: r0._meta,
        generated_at: new Date().toISOString(),
      });
      _hyphaAppendEvent('lesson_body_v2_generated', { topic: slug, idx: 0, ms: r0._meta && r0._meta.ms });

      // 2026-05-17 build-log — emit body's hook + KP titles so user sees the
      // first lesson's actual shape before opening LessonChat. Hook is the
      // 1-line opener (~80 chars); kp_titles are the 3-5 knowledge points.
      try {
        const _body = r0 && r0.body ? r0.body : {};
        const _hookText = typeof _body.hook === 'string'
          ? _body.hook.slice(0, 140)
          : (_body.hook && _body.hook.text ? String(_body.hook.text).slice(0, 140) : '');
        const _kpList = (Array.isArray(_body.knowledge_points) ? _body.knowledge_points : [])
          .slice(0, 6)
          .map(kp => (kp && typeof kp.title === 'string') ? kp.title.slice(0, 100) : '');
        emit('body-0:done', { hook: _hookText, kp_titles: _kpList, kp_count: _kpList.length });
      } catch (_) { /* preview enrichment optional */ }

      // v0.2 Track C C1 — surface drift warning for lesson 0 (auto-fire path).
      // Mirrors the `lesson:body:generate` IPC handler so back-fill and auto-
      // fire emit the same drift events + sibling warning files.
      try {
        const dw0 = r0._meta && r0._meta.drift_warning;
        if (dw0) {
          vault.writeJSON(`${slug}/lesson-0.body.drift-warning.json`, {
            warning: dw0,
            generated_at: new Date().toISOString(),
          });
          _hyphaAppendEvent('lesson_body_drift_check', {
            topic: slug,
            idx: 0,
            passed: false,
            attempts: dw0.attempts || 2,
            score: dw0.score,
            flags: (dw0.violations || []).slice(0, 6).map(v => ({ axis: v.axis, text: v.text })),
          });
        } else {
          _hyphaAppendEvent('lesson_body_drift_check', {
            topic: slug,
            idx: 0,
            passed: true,
            attempts: 1,
            score: (r0._meta && r0._meta.drift_score) != null ? r0._meta.drift_score : null,
          });
        }
      } catch (_) { /* drift surface non-fatal */ }
    } catch (bodyErr) {
      _hyphaAppendEvent('lesson_body_v2_failed', { topic: slug, idx: 0, error: bodyErr && bodyErr.message });
      // non-fatal — curriculum-create succeeds even if body gen fails
    }

    _hyphaAppendEvent('curriculum_done', { topic: slug, lessons: lessonRels.length, archetype });
    emit('done', { lessonRels, firstLessonRel: lessonRels[0] });
    return { ok: true, topic: slug, lessonRels, archetype, phases: seedResult.phases };
  } catch (err) {
    _hyphaAppendEvent('curriculum_error', { topic: slug, error: err.message });
    emit('error', { error: err.message });
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('curriculum:create', async (event, args = {}) => {
  const result = await _runCurriculumCreate(event, args);
  // W3.1 Creation Pool — after curriculum is designed + state.json written,
  // check if a Product is bound for this slug. If not, emit `creation:not-bound`
  // on the same WebContents so the UI (W3.2) can prompt the user to bind a
  // Product Pool. Non-fatal — curriculum:create succeeds regardless.
  try {
    if (result && result.ok && result.topic) {
      const pool = require('./lib/creation-pool');
      if (!pool.isProductBound(result.topic)) {
        try {
          if (event && event.sender && !event.sender.isDestroyed()) {
            event.sender.send('creation:not-bound', { slug: result.topic });
          }
        } catch (_) { /* renderer may be gone — ignore */ }
      }
    }
  } catch (_) { /* W3.1 not-bound emit is best-effort */ }
  return result;
});

// ──────────────────────────────────────────────────────────────────────────
// Onboarding state (boot-7, 2026-05-20)
// ──────────────────────────────────────────────────────────────────────────
//
// First-launch detection + `onboarded_at` persistence + BYOK shape-only
// validation. Pure logic lives in `app/lib/onboarding-state.js` so the
// `app/scripts/_dev_verify_onboarding_flow.js` smoke can hermetically exercise
// every code path without spinning up Electron.
ipcMain.handle('onboarding:state', () => {
  try {
    const { isFirstLaunch, loadProfile } = require('./lib/onboarding-state');
    const first = isFirstLaunch(vault);
    const profile = loadProfile(vault);
    return {
      ok: true,
      isFirstLaunch: first,
      onboarded_at: (profile && profile.onboarded_at) || null,
      first_goal_seed: (profile && profile.first_goal_seed) || '',
      first_pedagogy: (profile && profile.first_pedagogy) || '',
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err), isFirstLaunch: true };
  }
});

ipcMain.handle('onboarding:mark-complete', (_e, payload = {}) => {
  try {
    const { markOnboarded } = require('./lib/onboarding-state');
    const result = markOnboarded(vault, payload || {});
    try { _hyphaAppendEvent('onboarded', { ts: result.profile.onboarded_at, seed: result.profile.first_goal_seed }); } catch (_) {}
    return result;
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('onboarding:validate-key', (_e, { provider, key } = {}) => {
  try {
    const { validateApiKey } = require('./lib/onboarding-state');
    return validateApiKey(provider, key);
  } catch (err) {
    return { ok: false, hint: (err && err.message) || String(err) };
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Goal Feasibility Guardian — onboarding gate (Machino-δ6, 2026-05-14)
// ──────────────────────────────────────────────────────────────────────────
//
// Wall between onboarding submit and curriculum:create. Refuses absurd
// goals ("1 day Nobel") + warns on strained ones. See
// app/lib/creation/goal-guardian.js for math + LLM judge logic.
ipcMain.handle('creation:goal:evaluate', async (_event, { goalContract } = {}) => {
  try {
    const { evaluateGoalFeasibility } = require('./lib/creation/goal-guardian');
    const settings = (typeof _hyphaSettings === 'function') ? (_hyphaSettings() || {}) : {};
    const verdict = await evaluateGoalFeasibility(goalContract || {}, settings);
    return { ok: true, verdict };
  } catch (err) {
    console.error('[creation:goal:evaluate] failed:', err && err.message);
    return { ok: false, error: (err && err.message) || 'goal evaluate failed' };
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Pillar 1 · hypha:route-goal — single-vs-chain dispatcher (2026-05-17)
// ──────────────────────────────────────────────────────────────────────────
//
// Onboarding has historically always called `curriculum:create`, so ambitious
// goals ("成为诺贝尔文学奖得主", difficulty ≈ 0.95, multi-year) collapsed into
// a single 30-lesson course — not actionable. This router returns a `flow`
// hint the renderer uses to fork between `curriculum:create` (single) and
// `chain:create` (chain plan). Threshold: difficulty ≥ 0.7 AND
// conservative_years ≥ 3 → chain. Pillar 2 estimator is optional — router
// falls back to a pure-difficulty heuristic when the module is absent.
// All logic lives in `app/lib/creation/route-goal.js` so it can be smoke
// tested without spinning up Electron.
// Phase F.1 Gap 1 (2026-05-18) — archetype keyword inferrer for the wizard.
// Pure regex, no LLM, returns one of 6 archetypes. Used by app.jsx onComplete
// to pick the right wizard dimensions before waitForWizardConfirm() resolves.
ipcMain.handle('hypha:infer-archetype', async (_event, { draftGoal } = {}) => {
  try {
    const gc = require('./lib/creation/goal-crystallizer');
    const arch = gc.inferArchetypeFromGoal(draftGoal);
    return { ok: true, archetype: arch };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err), archetype: 'HUMANITIES' };
  }
});

ipcMain.handle('hypha:route-goal', async (_event, { goalContract = {}, archetype = null } = {}) => {
  try {
    const { routeGoal } = require('./lib/creation/route-goal');
    return await routeGoal({ goalContract, archetype });
  } catch (err) {
    console.error('[hypha:route-goal] failed:', err && err.message);
    return {
      flow: 'single',
      reason: 'router-error fallback to single',
      difficulty: 0.6,
      conservative_years: 1,
      evidence: [],
      estimator_used: false,
      error: String((err && err.message) || err),
    };
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Socratic onboarding intake — 阶 2 表单极简化 (2026-05-17)
// ──────────────────────────────────────────────────────────────────────────
//
// Replaces 8 fields cut from the onboarding form (current_level /
// teacher_persona / forbidden_drifts) with 3 conversational chip turns fired
// right before lesson 0. Renderer drives the turn loop: calls socratic:start
// to get the 3-question plan, then socratic:answer per turn, then
// socratic:finalize to commit the patch back to state.json + agent.json.
//
// TODO wire: curriculum:create / chain:start success → fire-and-forget
// renderer side starts socratic:start instead of jumping straight to lesson 0.
// Today, this IPC trio is shipped as the primitive; renderer integration is a
// next-pass concern. Calling lesson 0 without running Socratic stays valid —
// the cut fields keep their sentinel defaults from screen-onboarding.jsx.
const _socraticSessions = new Map(); // slug → driver returned by runSocraticIntake

ipcMain.handle('socratic:start', async (_event, { slug, goalContract } = {}) => {
  try {
    const { runSocraticIntake } = require('./lib/socratic-onboarding');
    const settings = (typeof _hyphaSettings === 'function') ? (_hyphaSettings() || {}) : {};
    // Prefer the passed-in goalContract; fall back to what's on disk for the slug.
    let gc = goalContract || null;
    if (!gc && slug) {
      try {
        const state = vault.readJSON(`${slug}/state.json`, null);
        gc = (state && state.goalContract) || null;
      } catch (_) { gc = null; }
    }
    const driver = await runSocraticIntake({ slug: slug || null, goalContract: gc || {}, settings });
    if (slug) _socraticSessions.set(slug, driver);
    return {
      ok: true,
      questions: driver.questions.map(q => ({
        id: q.id,
        idx: q.idx,
        prompt: q.opener || q.prompt,
        chips: q.chips,
      })),
    };
  } catch (err) {
    console.error('[socratic:start] failed:', err && err.message);
    return { ok: false, error: (err && err.message) || 'socratic start failed' };
  }
});

ipcMain.handle('socratic:answer', async (_event, { slug, idx, chipLabel } = {}) => {
  try {
    const driver = slug ? _socraticSessions.get(slug) : null;
    if (!driver) return { ok: false, error: 'no socratic session for slug' };
    const patch = driver.applyAnswer(Number(idx) || 0, String(chipLabel || ''));
    return { ok: true, patchSoFar: patch };
  } catch (err) {
    console.error('[socratic:answer] failed:', err && err.message);
    return { ok: false, error: (err && err.message) || 'socratic answer failed' };
  }
});

ipcMain.handle('socratic:finalize', async (_event, { slug } = {}) => {
  try {
    const driver = slug ? _socraticSessions.get(slug) : null;
    if (!driver) return { ok: false, error: 'no socratic session for slug' };
    const result = driver.finalize();
    // Merge goalContractPatch back into state.json's goalContract.
    if (slug) {
      try {
        const state = vault.readJSON(`${slug}/state.json`, null);
        if (state) {
          state.goalContract = { ...(state.goalContract || {}), ...(result.goalContractPatch || {}) };
          vault.writeJSON(`${slug}/state.json`, state);
        }
      } catch (e) {
        console.warn('[socratic:finalize] state.json merge failed (non-fatal):', e && e.message);
      }
      // If user picked an explicit teacher persona, overwrite agent.json's
      // persona slot. derivedFromClarifications flips false to mark the
      // explicit pick (mirrors curriculum:create's `explicit` branch).
      if (result.personaId) {
        try {
          const cur = vault.readJSON(`${slug}/agent.json`, null) || {};
          vault.writeJSON(`${slug}/agent.json`, {
            ...cur,
            persona: result.personaId,
            derivedFromClarifications: false,
            updatedAt: new Date().toISOString(),
          });
        } catch (e) {
          console.warn('[socratic:finalize] agent.json write failed (non-fatal):', e && e.message);
        }
      }
      _socraticSessions.delete(slug);
    }
    return { ok: true, ...result };
  } catch (err) {
    console.error('[socratic:finalize] failed:', err && err.message);
    return { ok: false, error: (err && err.message) || 'socratic finalize failed' };
  }
});

// ──────────────────────────────────────────────────────────────────────────
// W3.1 Creation Pool — Product Pool IPC handlers (BLUEPRINT §11.1-11.8)
// ──────────────────────────────────────────────────────────────────────────
//
// One Goal → one Product. Surface boundary: this stream owns the framework
// (bind / get / link / 4 ledger ops). W3.2 Product Blueprint owns the body
// editor UI; W3.4 Spark owns sparks/*.md state machine; W3.5 / W3.6 Companion
// agents push suggestions via creation:syncRoadmap.

const _creationPool = require('./lib/creation-pool');
const _creationOps = require('./lib/creation-pool-ops');

// 2026-05-13 — Product Registry (vault-level Product Pool, BLUEPRINT §11.1).
// Standalone products live in `vault/.products/<productId>/`, decoupled from
// curriculum slug. Legacy `creation:*` IPC retained for W3.x callers; new
// `product:*` namespace targets standalone products.
const _productRegistry = require('./lib/product-registry');

ipcMain.handle('product:list', async () => {
  try { return { ok: true, products: _productRegistry.listProducts() }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('product:create', async (_event, payload = {}) => {
  try { return _productRegistry.createProduct(payload); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('product:get', async (_event, { productId } = {}) => {
  try {
    const p = _productRegistry.getProduct(productId);
    return p ? { ok: true, product: p } : { ok: false, error: 'product not found' };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('product:updateBlueprint', async (_event, { productId, blueprintMd } = {}) => {
  try { return _productRegistry.updateBlueprint(productId, blueprintMd); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('product:listInspirations', async (_event, { productId, limit } = {}) => {
  try { return { ok: true, rows: _productRegistry.listInspirations(productId, { limit }) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// 2026-05-13 — Cross-Product Transfer (BLUEPRINT §11.3, vault-level cross-scan).
// Renderer (deepen-pipeline UI / lesson-chat /finish flow) calls this with an
// insight chunk; backend ranks all vault products and (optionally) commits
// the top hit to that product's inspiration-pool.jsonl.
const _crossProductTransfer = require('./lib/cross-product-transfer');

ipcMain.handle('product:transferScan', async (_event, payload = {}) => {
  try {
    const result = _crossProductTransfer.scanInsight(payload);
    return { ok: true, ...result };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('product:transferCommit', async (_event, { scanResult } = {}) => {
  try {
    const r = _crossProductTransfer.appendBestToInspirationPool(scanResult);
    return r;
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:bind', async (_event, { slug, productConfig } = {}) => {
  try { return _creationPool.bindProduct(slug, productConfig); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:get', async (_event, { slug } = {}) => {
  try { return _creationPool.getProduct(slug); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:isBound', async (_event, { slug } = {}) => {
  try { return { ok: true, bound: _creationPool.isProductBound(slug) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:linkLesson', async (_event, { slug, lessonIdx, relevance, sourceSummary } = {}) => {
  try { return _creationPool.linkLessonToProduct(slug, lessonIdx, relevance, sourceSummary); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:linkNote', async (_event, { slug, notePath, relevance, sourceSummary } = {}) => {
  try { return _creationPool.linkNoteToProduct(slug, notePath, relevance, sourceSummary); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:linkPack', async (_event, { slug, packId, relevance, sourceSummary } = {}) => {
  try { return _creationPool.linkPackToProduct(slug, packId, relevance, sourceSummary); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:addDecision', async (_event, { slug, decision } = {}) => {
  try { return _creationOps.addDecision(slug, decision); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:addAssumption', async (_event, { slug, assumption } = {}) => {
  try { return _creationOps.addAssumption(slug, assumption); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:updateAssumption', async (_event, { slug, id, status, evidence } = {}) => {
  try { return _creationOps.updateAssumptionStatus(slug, id, status, evidence); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:addKillCriterion', async (_event, { slug, criterion } = {}) => {
  try { return _creationOps.addKillCriterion(slug, criterion); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:evalKillCriteria', async (_event, { slug, currentMetrics } = {}) => {
  try { return _creationOps.evaluateKillCriteria(slug, currentMetrics); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:syncRoadmap', async (_event, { slug, weeklyItems, priority, sourceAgent } = {}) => {
  try { return _creationOps.appendRoadmapSync(slug, weeklyItems, priority, sourceAgent); }
  catch (err) { return { ok: false, error: err.message }; }
});

// ──────────────────────────────────────────────────────────────────────────
// Creation System §11.5 Decision Log + §11.6 Assumption Ledger (2026-05-14).
// Independent slug-bound JSONL ledgers; do NOT replace creation-pool-ops above
// (which is the curriculum-bound product W3.x path). v0.7.1+ will migrate to
// product-bound storage. File-based, no DB.
// ──────────────────────────────────────────────────────────────────────────
const _decisionLog = require('./lib/creation/decision-log');
const _assumptionLedger = require('./lib/creation/assumption-ledger');

ipcMain.handle('decision:append', async (_event, { slug, row } = {}) => {
  try { return _decisionLog.appendDecision(slug, row || {}); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('decision:list', async (_event, { slug, opts } = {}) => {
  try { return { ok: true, rows: _decisionLog.listDecisions(slug, opts || {}) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('assumption:append', async (_event, { slug, row } = {}) => {
  try { return _assumptionLedger.appendAssumption(slug, row || {}); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('assumption:list', async (_event, { slug, opts } = {}) => {
  try { return { ok: true, rows: _assumptionLedger.listAssumptions(slug, opts || {}) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('assumption:updateState', async (_event, { slug, id, newState } = {}) => {
  try { return _assumptionLedger.updateAssumptionState(slug, id, newState); }
  catch (err) { return { ok: false, error: err.message }; }
});

// Creation System §11.4 — Product Spark (slug-bound JSONL flavor, 2026-05-14).
// Sibling to decision-log + assumption-ledger above. Independent from the W3.4
// _productSpark below (which writes per-spark markdown files). Channel prefix
// is `creation:spark:*` to avoid collision with W3.4's `spark:list` handler
// registered further down. v0.7.1+ will migrate this slug-bound JSONL to
// product-bound storage.
const _creationSpark = require('./lib/creation/product-spark');

ipcMain.handle('creation:spark:append', async (_event, { slug, row } = {}) => {
  try { return _creationSpark.appendSpark(slug, row || {}); }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:spark:list', async (_event, { slug, opts } = {}) => {
  try { return { ok: true, rows: _creationSpark.listSparks(slug, opts || {}) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('creation:spark:updateState', async (_event, { slug, id, newState } = {}) => {
  try { return _creationSpark.updateSparkState(slug, id, newState); }
  catch (err) { return { ok: false, error: err.message }; }
});

// ──────────────────────────────────────────────────────────────────────────
// §11.7 Kill Watcher — manual sweep IPC. Runs across all vault slugs +
// .products/<productId>/ subdirs, refutes/rejects/flags expired predictions.
// Startup auto-sweep is registered inside app.whenReady() above. Module:
// app/lib/creation/kill-watcher.js
// ──────────────────────────────────────────────────────────────────────────
// boot-10 lazy-wrap — kill-watcher 384 LOC. Fires only on manual
// creation:killWatch:sweep IPC (startup auto-sweep at L4267 already uses an
// inline require, so the top-level binding here was pure boot tax).
let __killWatcherMod = null;
const _killWatcher = new Proxy({}, {
  get(_t, p) {
    if (!__killWatcherMod) __killWatcherMod = require('./lib/creation/kill-watcher');
    return __killWatcherMod[p];
  },
});

ipcMain.handle('creation:killWatch:sweep', async () => {
  try {
    const r = await _killWatcher.runKillWatcherSweep();
    // Machino-α5 — broadcast so DecisionLedgerCard + ProductSparkCard refetch
    // after a manual sweep refutes / rejects rows. Same channel as startup.
    try {
      const s = (r && r.summary) || {};
      const by = (s.by_kind) || {};
      const summary = {
        slugs: s.slugs_scanned || 0,
        refuted: Array.isArray(by.assumptions_refuted) ? by.assumptions_refuted.length : 0,
        rejected: Array.isArray(by.sparks_rejected) ? by.sparks_rejected.length : 0,
        flagged: Array.isArray(by.decisions_flagged) ? by.decisions_flagged.length : 0,
        errors: Array.isArray(s.errors) ? s.errors.length : 0,
      };
      _emitToRenderer('creation:kill-watch-done', { summary, source: 'manual' });
    } catch (_) {}
    return r;
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// ──────────────────────────────────────────────────────────────────────────
// §11.8 Roadmap Sync — weekly roll-up of decisions / assumptions / sparks /
// auto-killed rows into a markdown roadmap (vault/<slug>/roadmap-weekly-*.md).
// Slug-bound (founder cohort hasn't bound `.products/<id>/` yet). Startup
// auto-sync runs 120s after app.whenReady() further up. Module:
// app/lib/creation/roadmap-sync.js
// ──────────────────────────────────────────────────────────────────────────
// boot-10 lazy-wrap — roadmap-sync 659 LOC. Fires on manual
// creation:roadmap:* IPC (startup auto-sync at L4295 uses its own inline
// require, so the top-level binding was pure boot tax).
let __roadmapSyncMod = null;
const _roadmapSync = new Proxy({}, {
  get(_t, p) {
    if (!__roadmapSyncMod) __roadmapSyncMod = require('./lib/creation/roadmap-sync');
    return __roadmapSyncMod[p];
  },
});

ipcMain.handle('creation:roadmap:syncWeekly', async (_event, { slug, dryRun } = {}) => {
  try {
    const r = await _roadmapSync.runWeeklySync({
      slug,
      settings: _hyphaSettings(),
      dryRun: dryRun === true,
    });
    // Machino-α5 — broadcast on successful, non-dryRun, non-skipped sync so
    // RoadmapCard refetches after the markdown lands on disk.
    try {
      if (r && r.ok && !r.skipped && r.mdPath && dryRun !== true) {
        _emitToRenderer('creation:roadmap-synced', {
          slug,
          weekAnchorDate: r.weekAnchorDate || null,
          mdPath: r.mdPath || null,
          source: 'manual',
        });
      } else if (r && r.ok && r.skipped && dryRun !== true) {
        // β6 honesty fix — emit skip reason so RoadmapCard shows the
        // SkippedHint with "本节未生成 (太少条 / 解析错 / 调用失败)" instead
        // of staying blank when manual sync is short-circuited.
        _emitToRenderer('creation:roadmap-synced', {
          slug,
          skipped: r.skipped,
          weekAnchorDate: null,
          mdPath: null,
          source: 'manual',
        });
      }
    } catch (_) {}
    return r;
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('creation:roadmap:getLatest', async (_event, { slug } = {}) => {
  try { return _roadmapSync.getLatestRoadmap(slug); }
  catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
});

ipcMain.handle('creation:roadmap:listWeeks', async (_event, { slug } = {}) => {
  try { return { ok: true, weeks: _roadmapSync.listRoadmapWeeks(slug) }; }
  catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
});

// ──────────────────────────────────────────────────────────────────────────
// W3.4 Product Spark — state machine + sparks/*.md CRUD (BLUEPRINT §11.4)
// 5 states (seed / considered / accepted / rejected / implemented) + 4
// transition arrows + 2 terminal states. Each handler wraps the library's
// throws into the standard hypha envelope so the renderer never crashes
// from an illegal-transition or validation error — UI surfaces err.message
// + err.code (SPARK_STATE_INVALID / SPARK_INPUT_INVALID / SPARK_NOT_FOUND).
// ──────────────────────────────────────────────────────────────────────────
const _productSpark = require('./lib/product-spark');

function _sparkErrEnvelope(err) {
  return {
    ok: false,
    error: err && err.message ? err.message : String(err),
    code: err && err.code ? err.code : 'SPARK_UNKNOWN',
    // Surface legalNext when a SparkStateError carries it so the UI can
    // re-render permitted transition buttons without a fresh round-trip.
    ...(err && Array.isArray(err.legalNext) ? { legalNext: err.legalNext } : {}),
    ...(err && err.terminal ? { terminal: true } : {}),
  };
}

ipcMain.handle('spark:create', async (_event, { slug, data } = {}) => {
  try { return _productSpark.createSpark(slug, data || {}); }
  catch (err) { return _sparkErrEnvelope(err); }
});

ipcMain.handle('spark:list', async (_event, { slug, filterState } = {}) => {
  try { return { ok: true, sparks: _productSpark.listSparks(slug, filterState || null) }; }
  catch (err) { return _sparkErrEnvelope(err); }
});

ipcMain.handle('spark:get', async (_event, { slug, sparkId } = {}) => {
  try { return { ok: true, spark: _productSpark.getSpark(slug, sparkId) }; }
  catch (err) { return _sparkErrEnvelope(err); }
});

ipcMain.handle('spark:update', async (_event, { slug, sparkId, patch } = {}) => {
  try { return _productSpark.updateSpark(slug, sparkId, patch || {}); }
  catch (err) { return _sparkErrEnvelope(err); }
});

ipcMain.handle('spark:transition', async (_event, { slug, sparkId, newState, opts } = {}) => {
  try { return _productSpark.transitionState(slug, sparkId, newState, opts || {}); }
  catch (err) { return _sparkErrEnvelope(err); }
});

ipcMain.handle('spark:archive', async (_event, { slug, sparkId } = {}) => {
  try { return _productSpark.archiveSpark(slug, sparkId); }
  catch (err) { return _sparkErrEnvelope(err); }
});

ipcMain.handle('spark:linkBlueprint', async (_event, { slug, sparkId, section } = {}) => {
  try { return _productSpark.linkSparkToBlueprint(slug, sparkId, section); }
  catch (err) { return _sparkErrEnvelope(err); }
});

// ──────────────────────────────────────────────────────────────────────────
// W5.4 Creation System v1 — automated layer on top of W3.x lib.
// Adds: auto-transfer audit / weekly roadmap sync / kill-criteria alerting /
// spark priority ranking + the unified runCycle orchestrator. Wraps (never
// mutates) W3.1 / W3.3 / W3.4 / W2.1 surfaces; LLM calls remain mocked here
// until W5.4 calibration lands. See specs/creation-system-v1.md.
// ──────────────────────────────────────────────────────────────────────────
const _creationV1 = require('./lib/creation-system-v1');

function _v1Envelope(err) {
  return { ok: false, error: (err && err.message) || String(err) };
}

ipcMain.handle('creation_v1:autoTransferQueue', async (_e, { slug, lookbackDays, threshold } = {}) => {
  try { return await _creationV1.autoTransfer.getTransferQueue(slug, { lookbackDays, threshold }); }
  catch (err) { return _v1Envelope(err); }
});

ipcMain.handle('creation_v1:runTransferAudit', async (_e, { slug, lookbackDays, threshold } = {}) => {
  try { return await _creationV1.autoTransfer.runDailyTransferAudit(slug, { lookbackDays, threshold }); }
  catch (err) { return _v1Envelope(err); }
});

ipcMain.handle('creation_v1:weeklyRoadmap', async (_e, { slug, days } = {}) => {
  try { return await _creationV1.autoRoadmapSync.weeklyRoadmapSync(slug, { days }); }
  catch (err) { return _v1Envelope(err); }
});

ipcMain.handle('creation_v1:evalKill', async (_e, { slug, currentMetrics, lookbackDays } = {}) => {
  try { return _creationV1.autoKillEval.evaluateKillCriteriaSchedule(slug, { currentMetrics, lookbackDays }); }
  catch (err) { return _v1Envelope(err); }
});

ipcMain.handle('creation_v1:rankSparks', async (_e, { slug, sparks } = {}) => {
  try { return _creationV1.sparkPriority.rankSparks(slug, sparks); }
  catch (err) { return _v1Envelope(err); }
});

ipcMain.handle('creation_v1:nextSpark', async (_e, { slug } = {}) => {
  try { return _creationV1.sparkPriority.getNextSparkToConsider(slug); }
  catch (err) { return _v1Envelope(err); }
});

ipcMain.handle('creation_v1:runCycle', async (_e, { slug, lookbackDays, currentMetrics, trigger } = {}) => {
  try { return await _creationV1.runCreationSystemV1Cycle(slug, { lookbackDays, currentMetrics, trigger }); }
  catch (err) { return _v1Envelope(err); }
});

// ──────────────────────────────────────────────────────────────────────────
// W4.2 KPI Dashboard — BLUEPRINT §20 v1.0 Closed Beta KPI surface.
// Read-only aggregator over events.jsonl + scenario-events.jsonl + companion-
// fired.json + creation-pool ledgers. Plus payment-survey.json writer (the
// only side-effect; one-shot per slug at 7-day path closure).
// ──────────────────────────────────────────────────────────────────────────
const _kpi = require('./lib/kpi-dashboard');

function _kpiEnvelope(fn) {
  try { return { ok: true, ...fn() }; }
  catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
}

ipcMain.handle('kpi:completion', async (_event, { slug, scenarioName } = {}) => {
  return _kpiEnvelope(() => _kpi.computeCompletionRate(slug, scenarioName));
});

ipcMain.handle('kpi:artifacts', async (_event, { slug } = {}) => {
  return _kpiEnvelope(() => _kpi.computeArtifactRate(slug));
});

ipcMain.handle('kpi:productPool', async (_event, { slug } = {}) => {
  return _kpiEnvelope(() => _kpi.computeProductPoolConversion(slug));
});

ipcMain.handle('kpi:companion', async (_event, { slug } = {}) => {
  return _kpiEnvelope(() => _kpi.computeCompanionSatisfaction(slug));
});

ipcMain.handle('kpi:payment', async (_event, { slug } = {}) => {
  return _kpiEnvelope(() => _kpi.surveyPaymentWillingness(slug));
});

ipcMain.handle('kpi:aggregate', async (_event, { slug } = {}) => {
  try {
    const result = _kpi.aggregateAllKPI(slug);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('kpi:surveyPayment', async (_event, { slug, willing, freeText } = {}) => {
  try { return _kpi.recordPaymentSurvey(slug, willing, freeText); }
  catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
});

// ──────────────────────────────────────────────────────────────────────────
// v0.3 Heavy Harvest + 2-stage flow (Machino-E Phase 2)
// ──────────────────────────────────────────────────────────────────────────
//
// The legacy `curriculum:create` IPC (above) does harvest → design → write
// state → auto-fire body in one shot. Per `project_hypha_v03_2stage_gen` user
// wants to surface the SKELETON for review BEFORE any body lands. v0.3 splits
// this into two IPCs the renderer drives sequentially:
//
//   1. curriculum:harvest_and_skeleton  → Stage 1 (5-15 min, visible work)
//   2. curriculum:approve_and_body      → Stage 2 (30-60s, after user approves)
//
// Plus a regen IPC for skeleton iteration (capped at 3 attempts):
//   3. curriculum:regenerate_skeleton
//
// All progress events use the existing `curriculum:progress` channel so the
// renderer's onCurriculumProgress subscription stays the same. Per-channel
// progress events from Layer 1/3/4 modules carry substantive counts (e.g.
// `{stage: 'layer3:arxiv', count: 12}`) — never opaque "正在思考...".
//
// Backward compat: legacy `curriculum:create` is unchanged. Old state.json
// without scope_in/scope_out/prerequisite still reads cleanly; renderer
// falls back to "(scope to-do)" fill-in for legacy curricula.

const SKELETON_REGEN_CAP = 3;

// _runHarvestAndSkeleton — Stage 1 of the 2-stage flow. Mirrors
// _runCurriculumCreate's setup (slug, settings, learnMode, _hyphaCancelCheck,
// emit) but routes harvest through agent.js:harvestV3 (5-layer + per-channel
// progress) instead of the legacy harvest, then calls designSkeletonOnly
// instead of designSeed. Writes state.json + sources.json + ghost stub .md
// per slot. Does NOT auto-fire body.json (that's Stage 2).
async function _runHarvestAndSkeleton(event, payload = {}) {
  const { topic, level, options = {} } = payload;
  const {
    goalContract,
    lesson_mode,
    customLessons,
    tier,
    clarifications,
    prePrediction,
    goal,
    timeCommit,
    uploadedSource: rawUploadedSource,
  } = options;

  const slug = _topicSlug(topic);
  const settings = _hyphaSettings();
  const learnMode = (lesson_mode === 'learn') ? 'learn'
                  : (lesson_mode === 'raw')   ? 'raw'
                  : 'classic';
  const _norm = require('./lib/source-extractor')._normalizeUploadedSource;
  const uploadedSource = _norm(rawUploadedSource);

  // R1 launch blocker — pedagogy.md 2026-05-11 Layer 0 S0 (MEOW v6 CRITICAL fix).
  // user_intent MUST be one of 考研|兴趣|论文|复盘. Reject curriculum:harvest_and_skeleton
  // when absent so the spec's launch blocker + intent-relative subtraction
  // are actually enforced runtime, not just spec prose.
  const ALLOWED_USER_INTENTS = ['考研', '兴趣', '论文', '复盘'];
  const _validatedUserIntent = (goalContract && typeof goalContract.user_intent === 'string' && goalContract.user_intent.trim()) || '';
  if (!ALLOWED_USER_INTENTS.includes(_validatedUserIntent)) {
    const msg = `user_intent required — pick one of ${ALLOWED_USER_INTENTS.join('|')} (got: ${_validatedUserIntent ? `"${_validatedUserIntent}"` : 'empty'}). Per pedagogy.md Layer 0 S0 launch blocker.`;
    try {
      if (event && event.sender && typeof event.sender.send === 'function') {
        event.sender.send('curriculum:progress', { topic: slug, stage: 'error', error: msg });
      }
    } catch (_) {}
    return { ok: false, error: msg, error_code: 'USER_INTENT_REQUIRED' };
  }

  // Per-channel progress emitter. Renderer subscribes via onCurriculumProgress
  // → 'curriculum:progress'. Payload shape extends with stage/count/layer/
  // fallback_used so Stage 1 progress card can render multi-line per-channel
  // status (per feedback_course_gen_slow_visible 2026-05-09).
  const emit = (stage, extra = {}) => {
    try {
      if (event && event.sender && typeof event.sender.send === 'function') {
        event.sender.send('curriculum:progress', { topic: slug, stage, ...extra });
      }
    } catch (_) {}
  };

  _hyphaAppendEvent('curriculum_v3_start', {
    topic: slug, level,
    goal: goal || (goalContract && goalContract.north_star_goal) || '',
    customLessons,
    clarifCount: (clarifications || []).length,
    sourceMode: uploadedSource ? 'upload' : 'web',
  });
  _curriculumCancelled.delete(slug);

  // AbortController for harvestV3 — wired into _hyphaCancelCheck so user
  // cancel mid-harvest aborts in-flight HTTP requests too.
  let aborter = null;
  try { aborter = new AbortController(); } catch (_) { aborter = null; }

  try {
    // STAGE 1A — heavy harvest. agent.js:harvestV3 dispatches Layer 1/3/4
    // modules in parallel + emits per-channel progress through opts.onProgress.
    let archetype = null;
    try { archetype = await _hyphaAgent.classifyArchetype(topic, goal || '', settings); }
    catch (_) { archetype = 'TECH-CONCEPT'; }
    _hyphaCancelCheck(slug);
    emit('archetype', { archetype });

    // Layer 0 S1 visual archetype (pedagogy.md 2026-05-11 Phase B 改动 1B).
    // ORTHOGONAL to pedagogical archetype above — picks STORAGE TOPOLOGY for
    // Layer 6 KP map rendering (tree/DAG/timeline/matrix/flat). Fallback 'DAG'.
    let visualArchetype = 'DAG';
    if (typeof _hyphaAgent.classifyVisualArchetype === 'function') {
      try {
        const _userIntent = (goalContract && goalContract.user_intent) || null;
        visualArchetype = await _hyphaAgent.classifyVisualArchetype(topic, _userIntent, settings);
      } catch (_) { /* keep 'DAG' fallback */ }
    }
    _hyphaCancelCheck(slug);
    emit('visual_archetype', { visual_archetype: visualArchetype });

    let harvestResult;
    if (uploadedSource && Array.isArray(uploadedSource.files) && uploadedSource.files.length > 0) {
      // Upload path — skip web harvest, build sources from chapters. Mirrors
      // legacy curriculum:create branch but in v3 shape.
      emit('reading-source', {
        fileName: uploadedSource.files[0].fileName,
        fileCount: uploadedSource.files.length,
      });
      const sources = [];
      uploadedSource.files.forEach((file, fIdx) => {
        const fileName = file.fileName || `file-${fIdx + 1}`;
        const chapters = Array.isArray(file.chapters) ? file.chapters : [];
        const _fileSourceType = (file.sourceType === 'user-url') ? 'user-url' : 'user-upload';
        chapters.forEach((ch, cIdx) => {
          sources.push({
            title: ch.title || `${fileName} · Section ${cIdx + 1}`,
            url: file.url || `local://${fileName}#chapter-${cIdx}`,
            excerpt: String(ch.text || '').slice(0, 400),
            sourceType: _fileSourceType,
            layer: 'L5',  // v0.3 schema — uploaded user material → Layer 5 (User Context)
            fileName,
            fileIdx: fIdx,
            chapterIdx: cIdx,
            chapterStart: ch.startCharIdx || 0,
          });
        });
        try {
          const safeName = String(fileName).replace(/[^\w.\-]+/g, '_').slice(0, 80);
          vault.write(`${slug}/source-${fIdx}-${safeName}.txt`, file.text || '');
          if (fIdx === 0) vault.write(`${slug}/source-document.txt`, file.text || '');
        } catch (_) {}
      });
      harvestResult = {
        sources,
        structureAnchor: null,
        layer1_courses_n: 0,
        layer3_papers_n: 0,
        layer4_posts_n: 0,
        daemon_available: false,
        sourceMode: 'upload',
      };
    } else {
      // Web path — call harvestV3. Machino-D exports this from agent.js. The
      // onProgress callback re-emits per-channel events with `layer:` prefix
      // already applied by harvestV3 dispatcher (verbatim stage names listed
      // in the Phase 2 spec).
      emit('harvest:start', {});
      const onProgress = (stage, count) => {
        try {
          // count may be number, object, or undefined — pass through verbatim
          // so Layer modules can attach extra fields (paper title etc).
          if (count != null && typeof count === 'object') {
            emit(stage, count);
          } else {
            emit(stage, { count: typeof count === 'number' ? count : null });
          }
        } catch (_) {}
      };
      // harvestV3(topic, settings, prePrediction, archetype, opts) — opts
      // carries onProgress + signal. Spec defines this contract; Machino-D
      // implements it. If harvestV3 isn't exported yet (Phase 2 race), we
      // catch + bail with a clear error so orchestrator can re-spawn.
      if (typeof _hyphaAgent.harvestV3 !== 'function') {
        throw new Error('agent.harvestV3 not exported (Machino-D Phase 2 dependency missing)');
      }
      // 2026-05-17 阶 2 — pass difficulty to harvestV3 so per-layer source
      // budgets scale ("越难实现, 搜集的资料就要越多"). Source = goal-guardian
      // heuristic over north_star_goal; LLM classifyAll runs later in the
      // chain path so the heuristic is the best signal available here.
      let _harvestDifficulty = 0.6;
      try {
        const _gg = require('./lib/creation/goal-guardian');
        const _goalText = (goalContract && goalContract.north_star_goal) || goal || topic || '';
        _harvestDifficulty = _gg._estimateDifficulty(_goalText);
      } catch (_) {}
      emit('difficulty:set', {
        difficulty: _harvestDifficulty,
        source: 'goal-guardian._estimateDifficulty',
        stage: 'harvest',
      });
      harvestResult = await _hyphaAgent.harvestV3(topic, settings, prePrediction, archetype, {
        onProgress,
        signal: aborter ? aborter.signal : null,
        slug,
        cancelCheck: () => _hyphaCancelCheck(slug),
        difficulty: _harvestDifficulty,
      });

      // 2026-05-17 — HYPHA-native scout. LLM-driven 8-12 query expansion across
      // 6 dimensions (canonical/frontier/counterargument/engineering/cross-domain/
      // pedagogy), Tavily exec, T4_JUDGE coverage gate, 2-3 rounds. Augments
      // harvestV3 channel sources with frontier breadth the channel queries miss
      // (the "topic + 'intro'" cold-start problem). Sequential after harvestV3 so
      // BuildLog reads cleanly. Non-fatal: any scout error logs + skips, harvest
      // sources still ship.
      try {
        const { scoutFrontier } = require('./lib/harvest/hypha-scout');
        const scoutResult = await scoutFrontier({
          northStar: (goalContract && goalContract.north_star_goal) || goal || topic || '',
          mainCreation: (goalContract && goalContract.main_creation) || '',
          archetype,
          settings,
          onProgress: (stage, payload) => emit(stage, payload || {}),
        });
        const scoutSources = Array.isArray(scoutResult && scoutResult.sources) ? scoutResult.sources : [];
        if (scoutSources.length > 0) {
          const existing = Array.isArray(harvestResult.sources) ? harvestResult.sources : [];
          const seenUrls = new Set(existing.map(s => s && s.url).filter(Boolean));
          const merged = existing.slice();
          let added = 0;
          for (const s of scoutSources) {
            if (!s || !s.url || seenUrls.has(s.url)) continue;
            seenUrls.add(s.url);
            merged.push({
              ...s,
              layer: s.layer || 'scout',
              sourceType: s.sourceType || 'scout',
            });
            added++;
          }
          harvestResult.sources = merged;
          emit('scout:merged', { added, total: merged.length });
        }
      } catch (scoutErr) {
        console.warn('[scout] failed, harvest sources unchanged:', scoutErr && scoutErr.message);
        emit('scout:failed', { error: (scoutErr && scoutErr.message) || String(scoutErr) });
      }
    }
    _hyphaCancelCheck(slug);

    const sources = Array.isArray(harvestResult.sources) ? harvestResult.sources : [];
    // Persist sources.json with extended schema (layer + sourceType per row).
    // Old readers ignore unknown fields; new readers (renderer Sources panel)
    // group rows by `layer`.
    vault.writeJSON(`${slug}/sources.json`, sources);
    emit('curate:done', { sourceCount: sources.length });

    // W6.1 Book Grounding (BLUEPRINT §4) — if the user picked reference books
    // in onboarding, build per-book profiles + multi-book synthesis BEFORE
    // designSkeletonOnly so the planner sees role assignments + conflicts in
    // its SYSTEM_PROMPT. Books are passed via `options.bookIds`. Non-fatal:
    // any failure falls through with an empty groundingPack so legacy paths
    // (no books selected) work identically to pre-W6.1 behavior.
    const _bookIds = Array.isArray(options.bookIds) ? options.bookIds.filter(Boolean) : [];
    let groundingPack = { profiles: [], synthesis: null };
    if (_bookIds.length > 0) {
      emit('grounding:start', { book_count: _bookIds.length });
      try {
        groundingPack = await _grounding.runGroundingForCourse(slug, goalContract || null, _bookIds, {
          vaultRoot: vault.resolveRoot(),
          force: false,
          onProgress: (stage, extra) => emit(stage, extra || {}),
        });
        emit('grounding:done', {
          book_count: _bookIds.length,
          role_distribution: groundingPack.role_distribution,
        });
      } catch (gErr) {
        console.warn('[harvest_and_skeleton] grounding failed, falling through:', gErr && gErr.message);
        emit('grounding:failed', { error: (gErr && gErr.message) || String(gErr) });
      }
    }

    // STAGE 1B — design skeleton ONLY. Machino-D exports designSkeletonOnly
    // from agent.js. Receives structureAnchor (from Layer 1) so designSeed
    // doesn't default to LLM training-frequency priors (per
    // project_hypha_v021_failure_galileo Galileo-over-Thales fix).
    emit('design:start', {});
    if (typeof _hyphaAgent.designSkeletonOnly !== 'function') {
      throw new Error('agent.designSkeletonOnly not exported (Machino-D Phase 2 dependency missing)');
    }
    let initialSkeleton;
    try {
      initialSkeleton = await _hyphaAgent.designSkeletonOnly({
        topic,
        goal: goal || (goalContract && goalContract.north_star_goal) || '',
        archetype,
        structureAnchor: harvestResult.structureAnchor || null,
        sources,
        timeCommit: timeCommit || 'month',
        customLessons,
        tier: tier || 'moderate',
        clarifications: clarifications || [],
        goalContract: goalContract || null,
        // W6.1 — synthesis + profiles injected into SYSTEM_PROMPT.
        groundingSynthesis: groundingPack.synthesis,
        groundingProfiles: groundingPack.profiles,
      }, settings);
    } catch (designErr) {
      // R3 2026-05-13 — lessonSplit reject (KP ≥ 27): topic too broad to fit
      // disjoint thresholds. Surface a typed event so UI can guide user to
      // narrow scope before re-running curriculum:harvest_and_skeleton.
      if (designErr && designErr.code === 'TOPIC_TOO_BROAD') {
        _hyphaAppendEvent('curriculum_v3_lesson_split_topic_too_broad', {
          topic: slug,
          kp_candidate_count: designErr.kpCandidateCount || null,
          user_intent: designErr.userIntent || null,
          message: designErr.message,
        });
        emit('topic_too_broad', {
          kp_candidate_count: designErr.kpCandidateCount || null,
          message: designErr.message,
        });
      }
      throw designErr;
    }
    _hyphaCancelCheck(slug);
    emit('design:done', { lesson_count: (initialSkeleton.lessonPlan || []).length });

    // 2026-05-17 Pillar 4 — Weaver / Whetstone / Witness critique 真接入。取代
    // 2026-05-13 Lung/Muse/Scout 占位 (旧 agent.js:critiqueAndRefineSkeleton 仍
    // 在, 但已下线; Pillar 4 用 app/lib/critique/critique-runner.js)。
    //   - Weaver    : 跨域 / 跨文化 / 跨时代视角缺漏
    //   - Whetstone : KP 弱点 + severity + 改写建议
    //   - Witness   : 源对节数比 + 难度暗示 + per-KP 支撑度
    // 3 agent 并行 T4_JUDGE, 然后 (条件性) 1 轮 T6_STRONG revise。失败任何一步
    // 都 fallback 到 initialSkeleton — 课程生成不能因 critique 失败阻断。
    let skeletonResult = initialSkeleton;
    try {
      const _critiqueRunner = require('./lib/critique/critique-runner');
      const _difficulty = (function () {
        try {
          const _gg = require('./lib/creation/goal-guardian');
          const _goalText = goal || (goalContract && goalContract.north_star_goal) || topic || '';
          if (typeof _gg._estimateDifficulty === 'function') return _gg._estimateDifficulty(_goalText);
        } catch (_) {}
        return 0.6;
      })();

      // 2026-05-17 Gap 3 — single-shot critique upgraded to bounded multi-round
      // loop (maxRounds=2). Round 1 critiques + (conditionally) revises; if the
      // revised skeleton still trips shouldRevise (high-sev KP / ≥2 missing
      // lenses / ratio low), round 2 re-judges + re-revises. Converges as soon
      // as a round's critique returns shouldRevise=false. Honest gap: worst
      // case = 2× prior LLM cost (6 T4_JUDGE + 2 T6_STRONG vs. 3+1 baseline).
      const loopResult = await _critiqueRunner.runCritiqueLoop({
        skeleton: initialSkeleton,
        archetype,
        goal: goal || (goalContract && goalContract.north_star_goal) || '',
        difficulty: _difficulty,
        sources,
        settings,
        onProgress: (stage, payload) => emit(stage, payload || {}),
        maxRounds: 2,
      });

      if (loopResult && loopResult.finalSkeleton) {
        skeletonResult = loopResult.finalSkeleton;
      }
      const _lastRound = (loopResult && Array.isArray(loopResult.history) && loopResult.history.length > 0)
        ? loopResult.history[loopResult.history.length - 1]
        : null;
      emit('critique:loop-done', {
        total_rounds: (loopResult && loopResult.totalRounds) || 0,
        converged: _lastRound ? (_lastRound.shouldRevise === false) : false,
      });
    } catch (cErr) {
      console.warn('[curriculum:harvest_and_skeleton] Pillar 4 critique failed:', cErr && cErr.message);
      emit('critique:failed', { error: String((cErr && cErr.message) || cErr) });
      skeletonResult = initialSkeleton;
    }
    _hyphaCancelCheck(slug);

    // STAGE 1B.5 — KP seeds per lesson (Phase B 改动 1B, pedagogy.md Layer 0 S3
    // + Layer 4 narrative arc seed-time). For each lesson, request N seed
    // stubs that downstream generateKPArc expands into 7+1 narrative arc.
    // Best-effort: any per-lesson failure leaves `knowledge_points` undefined
    // on that slot; NoteView falls back to flat lesson render (Layer 6 Tier 3).
    //
    // R3 2026-05-13 — lessonSplit upgraded from advisory to authoritative.
    // skeletonResult._meta.lesson_shape carries the resolved decision
    // (source ∈ kp-density | time-floor | custom-override | reject) and each
    // slot now has slot.target_count stamped at designSkeletonOnly time.
    // We emit a single `curriculum_v3_lesson_split_decision` event for telemetry
    // + UI ("KP density 建议 N 节, time-floor 提到 M 节 → 取 M").
    const _userIntent = (goalContract && goalContract.user_intent) || null;
    const _targetCountDefault = 6;
    const _lessonShape = (skeletonResult && skeletonResult._meta && skeletonResult._meta.lesson_shape) || null;
    if (_lessonShape) {
      _hyphaAppendEvent('curriculum_v3_lesson_split_decision', {
        topic: slug,
        designed_n: (skeletonResult.lessonPlan || []).length,
        source: _lessonShape.source,                                        // 'kp-density' | 'time-floor' | 'custom-override'
        total_lessons: _lessonShape.totalLessons,
        days_floor: _lessonShape.daysFloor,
        kp_candidate_count: _lessonShape.kpCandidateCount || null,
        lesson_split_n: (_lessonShape.lessonSplit && _lessonShape.lessonSplit.n_lessons) || null,
        lesson_split_target_counts: (_lessonShape.lessonSplit && _lessonShape.lessonSplit.target_counts) || null,
        user_intent: _userIntent,
      });
      // Surface the floor override explicitly so UI / wisdom can flag the case
      // where KP-density said "2 节 (kp=15)" but time-floor pushed to 100 节.
      if (_lessonShape.source === 'time-floor'
          && _lessonShape.lessonSplit
          && _lessonShape.lessonSplit.n_lessons
          && _lessonShape.lessonSplit.n_lessons < _lessonShape.totalLessons) {
        _hyphaAppendEvent('curriculum_v3_lesson_split_floor_override', {
          topic: slug,
          kp_density_n: _lessonShape.lessonSplit.n_lessons,
          time_floor_n: _lessonShape.totalLessons,
          kp_candidate_count: _lessonShape.kpCandidateCount,
          user_intent: _userIntent,
        });
      }
    }
    const _lessonGenerator = require('./lib/lesson-generator');
    if (typeof _lessonGenerator.generateKPSeeds === 'function') {
      const _plan = skeletonResult.lessonPlan || [];
      const _totalSlots = _plan.length;
      for (let _i = 0; _i < _plan.length; _i++) {
        const _slot = _plan[_i];
        if (!_slot) continue;
        _hyphaCancelCheck(slug);
        // MEOW v6 fix — surface i/N progress so renderer can show real
        // throughput, not opaque "正在思考...". Per memory course_gen_slow_visible.
        emit('kp_seeds:start', { lesson_idx: _slot.idx, lesson_i: _i + 1, lesson_total: _totalSlots });
        try {
          const _lessonPlanShape = {
            objective: _slot.learnGoal || _slot.title || '',
            hook_concrete: _slot.scope_in || '',
            path: Array.isArray(_slot.path) ? _slot.path : [],
          };
          // MEOW v6 fix — thread aborter.signal so user cancel mid-KP-seed
          // call aborts the in-flight LLM HTTP instead of blocking up to
          // maxRetries × timeoutMs (2 × 60s = 120s per lesson worst case).
          //
          // R3 2026-05-13 — per-slot target_count is now authoritative: use
          // the slot.target_count stamped by designSkeletonOnly (via
          // resolveLessonShape). Clamp to generateKPSeeds's 1-12 range; fall
          // back to legacy 6 only when no stamp present (no-anchor path).
          const _slotTargetRaw = (_slot && Number.isFinite(_slot.target_count) && _slot.target_count > 0)
            ? _slot.target_count
            : _targetCountDefault;
          const _slotTarget = Math.max(1, Math.min(12, _slotTargetRaw));
          const _seedResult = await _lessonGenerator.generateKPSeeds({
            lessonPlan: _lessonPlanShape,
            targetCount: _slotTarget,
            visualArchetype,
            pedagogicalArchetype: archetype,
            userIntent: _userIntent,
            signal: aborter ? aborter.signal : null,
          });
          if (_seedResult && Array.isArray(_seedResult.knowledge_points)) {
            _slot.knowledge_points = _seedResult.knowledge_points;
            emit('kp_seeds:done', { lesson_idx: _slot.idx, lesson_i: _i + 1, lesson_total: _totalSlots, count: _seedResult.knowledge_points.length });
          } else {
            emit('kp_seeds:error', { lesson_idx: _slot.idx, lesson_i: _i + 1, lesson_total: _totalSlots, error: 'empty result' });
          }
        } catch (err) {
          // MEOW v6 fix — distinguish abort from genuine error.
          const _aborted = /aborted/i.test((err && err.message) || '');
          console.warn('[harvest_and_skeleton] kp_seeds failed for lesson', _i, '—', err && err.message);
          emit('kp_seeds:error', { lesson_idx: _slot.idx, lesson_i: _i + 1, lesson_total: _totalSlots, error: err && err.message, aborted: _aborted });
          if (_aborted) throw err;  // propagate cancellation so outer catch hits CURRICULUM_CANCELLED branch
        }
      }
    }

    // STAGE 1C — write state.json + ghost stub .md per slot. NO body.json yet.
    const lessonPlan = Array.isArray(skeletonResult.lessonPlan) ? skeletonResult.lessonPlan : [];
    const lessonRels = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const slot of lessonPlan) {
      const isFirst = slot.idx === 0;
      const title = slot.title || '';
      const learnGoal = slot.learnGoal || '';
      const fmLines = [
        '---',
        `lesson_idx: ${slot.idx}`,
        `learn_goal: ${JSON.stringify(learnGoal)}`,
        `locked: ${!isFirst}`,
        `topic_slug: ${slug}`,
        `date_created: ${today}`,
        `date_distilled: null`,
        `phase_id: ${slot.phaseId || ''}`,
        `phase_label: ${JSON.stringify(slot.phaseLabel || '')}`,
        `phase_lesson_idx: ${slot.phaseLessonIdx || 0}`,
        // v0.3 schema extensions — surface lesson boundaries
        `scope_in: ${JSON.stringify(slot.scope_in || '')}`,
        `scope_out: ${JSON.stringify(slot.scope_out || '')}`,
        `prerequisite: ${JSON.stringify(slot.prerequisite || '')}`,
        // v0.3 — every slot is a ghost until Stage 2 fires its body
        'ghost: true',
        `learn_mode: ${learnMode}`,
      ];
      if (typeof slot.conceptId === 'string' && slot.conceptId.trim()) {
        fmLines.push(`concept_id: ${JSON.stringify(slot.conceptId.trim())}`);
      }
      if (isFirst && typeof prePrediction === 'string' && prePrediction.trim()) {
        fmLines.push(`pre_read_prediction: ${JSON.stringify(prePrediction.trim())}`);
      }
      fmLines.push('---');
      const fm = fmLines.join('\n');
      // Stage 1 writes ghost stubs for ALL slots. Stage 2 (approve_and_body)
      // re-writes lesson 0 with the real template + body anchor.
      const body = `${fm}\n`;
      const ghostSlug = (slot.titleSlug || _topicSlug(slot.phaseLabel || 'lesson')).slice(0, 30);
      const slugTitle = title ? _topicSlug(title).slice(0, 30) : ghostSlug;
      const rel = `${slug}/${String(slot.idx).padStart(2, '0')}-${slugTitle || ghostSlug}.md`;
      vault.write(rel, body);
      lessonRels.push(rel);
    }

    // Persist state.json with v0.3 schema additions:
    //   - lessonPlan stored at root (was missing in v0.2 — only seedResult
    //     held it; lesson:body:generate already reads state.lessonPlan so this
    //     fixes a latent bug too)
    //   - skeleton_regen_count tracks v0.3 regen attempts (cap = 3)
    //   - harvest_summary captures Layer counts + daemon flag for trust panel
    //   - schema_version flag so old readers know which fields to expect
    const harvestSummary = {
      layer1_courses_n: harvestResult.layer1_courses_n || 0,
      layer3_papers_n: harvestResult.layer3_papers_n || 0,
      layer4_posts_n: harvestResult.layer4_posts_n || 0,
      daemon_available: !!harvestResult.daemon_available,
      fallback_used: !!harvestResult.fallback_used,
      sourceMode: harvestResult.sourceMode || (uploadedSource ? 'upload' : 'web'),
      total_sources: sources.length,
    };
    vault.writeJSON(`${slug}/state.json`, {
      mastered: [], gaps: [],
      preferences: { level: level || 'intermediate' },
      goal: goal || '',
      goalContract: goalContract || null,
      timeCommit: timeCommit || 'month',
      customLessons: (typeof customLessons === 'number') ? customLessons : null,
      tier: tier || 'moderate',
      sourceMode: uploadedSource ? 'upload' : 'web',
      uploadedFileName: uploadedSource ? (uploadedSource.files && uploadedSource.files[0] && uploadedSource.files[0].fileName) || uploadedSource.fileName || null : null,
      uploadedFileNames: uploadedSource ? (uploadedSource.files || []).map(f => f.fileName).filter(Boolean) : [],
      uploadedFileCount: uploadedSource ? (uploadedSource.totalFiles || (uploadedSource.files || []).length) : 0,
      clarifications: clarifications || [],
      archetype,
      visual_archetype: visualArchetype,               // Layer 0 S1 (pedagogy.md 2026-05-11 Phase B 改动 1B)
      user_intent: _userIntent,                        // Layer 0 S0 launch blocker echo
      phases: skeletonResult.phases,
      trajectory: skeletonResult.trajectory,
      lessonPlan,                                      // v0.3 — persist for Stage 2 reads (now with knowledge_points[] per slot)
      concepts: {},
      lastIdx: -1,
      lessonRels,
      learn_mode: learnMode,
      // v0.3 schema flags
      schema_version: '0.3',
      skeleton_regen_count: 0,
      harvest_summary: harvestSummary,
      structureAnchor: harvestResult.structureAnchor || null,
    });

    // W2.1 Cadence Engine — seed initial cadence-state.json (mirror legacy
    // curriculum:create). Non-fatal: cadence is advisory display only.
    try {
      const cs = require('./lib/cadence-state');
      cs.updateCadenceState(slug, {
        cadenceMode: null,
        lastReviewIdx: null,
        milestoneCrossed: [],
        restCount: 0,
        lastRestIdx: null,
        lessonsSinceLastRest: 0,
      });
    } catch (cErr) {
      console.warn('[curriculum:create v3] cadence-state seed failed (non-fatal):', cErr && cErr.message);
    }

    // Auto-derive a tutor persona (mirror legacy curriculum:create). Only seed
    // if no agent.json exists yet — don't clobber an existing customization.
    if (!vault.exists(`${slug}/agent.json`)) {
      try {
        const personas = require('./lib/personas');
        // Onboarding teacher selector wins over auto-derive (2026-05-12).
        const explicit = goal && typeof goal === 'object' && goal.goalContract && goal.goalContract.teacher_persona;
        const derived = explicit || personas.derivePersona({
          topic, goal: goal || '', clarifications: clarifications || [],
        });
        vault.writeJSON(`${slug}/agent.json`, {
          persona: derived,
          customInstructions: '',
          derivedFromClarifications: true,
          updatedAt: new Date().toISOString(),
        });
      } catch (_) { /* persona derivation non-fatal */ }
    }

    _hyphaAppendEvent('curriculum_v3_skeleton_done', {
      topic: slug,
      lessons: lessonRels.length,
      archetype,
      ...harvestSummary,
    });
    emit('done', {
      lessonRels,
      firstLessonRel: lessonRels[0],
      slug,
      harvest_summary: harvestSummary,
      visual_archetype: visualArchetype,
      user_intent: _userIntent,
    });
    return {
      ok: true,
      slug,
      lessonRels,
      harvest_summary: harvestSummary,
      lessonPlan,                                       // Phase B 改动 1B — now contains knowledge_points[] per slot
      archetype,
      visual_archetype: visualArchetype,                // Layer 0 S1
      user_intent: _userIntent,                         // Layer 0 S0 echo
    };
  } catch (err) {
    if (err && err.code === 'CURRICULUM_CANCELLED') {
      try { vault.del(slug); }
      catch (delErr) {
        // boot-7: destructive vault op cleanup on cancel — TypeError surfaces drift.
        if (delErr && delErr.name === 'TypeError') {
          console.error('[CRITICAL][curriculum:v3 cancelled] vault.del TypeError:', delErr.message, 'slug=', slug);
        } else if (delErr) {
          console.warn('[curriculum:v3 cancelled] vault.del cleanup failed:', delErr.message);
        }
      }
      try { _hyphaAppendEvent('curriculum_v3_cancelled', { topic: slug }); } catch (_) {} // intentional: telemetry never blocks cancel path
      try { if (aborter) aborter.abort(); } catch (_) {} // intentional: aborter may already be settled
      return { ok: false, cancelled: true };
    }
    try { vault.del(slug); }
    catch (delErr) {
      // boot-7: destructive vault op cleanup on failure — TypeError surfaces drift.
      if (delErr && delErr.name === 'TypeError') {
        console.error('[CRITICAL][curriculum:v3 failed] vault.del TypeError:', delErr.message, 'slug=', slug);
      } else if (delErr) {
        console.warn('[curriculum:v3 failed] vault.del cleanup failed:', delErr.message);
      }
    }
    _hyphaAppendEvent('curriculum_v3_failed', { topic: slug, error: err && err.message });
    emit('error', { error: err && err.message });
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// curriculum:harvest_and_skeleton — Stage 1 of the v0.3 2-stage flow.
// Payload: { topic, level, options: { goalContract, lesson_mode, customLessons,
//           tier, clarifications, prePrediction, goal, timeCommit,
//           uploadedSource } }
// Returns: { ok, slug, lessonRels, harvest_summary, lessonPlan, archetype }
//          | { ok:false, cancelled:true } | { ok:false, error }
ipcMain.handle('curriculum:harvest_and_skeleton', async (event, payload = {}) => {
  return _runHarvestAndSkeleton(event, payload);
});

// curriculum:approve_and_body — Stage 2. After user approves the skeleton in
// the renderer's PreviewCard, this fires lesson body generation for the
// requested slot (default = lesson 0). Mirrors lesson:body:generate behavior
// (priorBody:null, userFeedback:null) but is gated on Stage 1 having written
// state.json + sources.json. Emits `curriculum:body_ready` on success.
ipcMain.handle('curriculum:approve_and_body', async (event, payload = {}) => {
  try {
    const slug = String(payload.slug || '').trim();
    const idx = Number.isFinite(payload.lessonIdx) ? Number(payload.lessonIdx) : 0;
    if (!slug) return { ok: false, error: 'BAD_INPUT', message: 'slug required' };
    if (idx < 0) return { ok: false, error: 'BAD_INPUT', message: 'lessonIdx (>=0) required' };

    const state = vault.readJSON(`${slug}/state.json`, null);
    if (!state) return { ok: false, error: 'NO_SKELETON', message: 'state.json missing — run harvest_and_skeleton first' };
    const sources = vault.readJSON(`${slug}/sources.json`, []) || [];
    const lessonPlan = (state && Array.isArray(state.lessonPlan)) ? state.lessonPlan : [];
    const slot = lessonPlan[idx] || {};

    const plan = {
      objective: slot.learnGoal || slot.title || '',
      title: slot.title || '',
      path: Array.isArray(slot.path) ? slot.path : [],
      micro_proof: slot.micro_proof || {},
      // v0.3 — pass scope fields into body generator so it respects boundary
      scope_in: slot.scope_in || '',
      scope_out: slot.scope_out || '',
      prerequisite: slot.prerequisite || '',
    };
    const goalContract = state.goalContract || {
      north_star_goal: state.topic || state.goal || slug,
      current_level: 'self-directed adult learner',
    };
    const learnerState = {
      known: state.mastered || [],
      unknown: state.gaps || [],
    };

    const r = await lessonBodyGen.generateLessonBodyV2({
      plan,
      goalContract,
      sources,
      learnerState,
      lessonTitle: slot.title,
      learnGoal: slot.learnGoal,
      idx,
      pedagogicalArchetype: state.archetype || null,
      // Stage 2 first body — no prior to refine against.
      priorBody: null,
      userFeedback: null,
    });

    const bodyRel = `${slug}/lesson-${idx}.body.json`;
    const persisted = { body: r.body, _meta: r._meta, generated_at: new Date().toISOString() };
    vault.writeJSON(bodyRel, persisted);
    _hyphaAppendEvent('lesson_body_v2_generated', {
      topic: slug, idx, ms: r._meta && r._meta.ms, stage: 'v0.3_approve',
    });

    // Phase B 改动 M4 (MEOW v6 HIGH fix) — Migration Matrix B dual-write.
    // 11-field body PRESERVED above (trust layer consumes verbatim). NOW
    // generate the per-KP narrative arc (Layer 4 schema) as SIBLING data,
    // not replacement. arc lives at `<slug>/lesson-<idx>.kp-arc.json`.
    // KP seeds come from Stage 1B.5 (Phase B 改动 1B). If absent (legacy
    // skeleton, regen without re-seed, or backward-compat), skip silently —
    // NoteView falls back to flat lesson render per pedagogy.md Layer 6.
    try {
      const _kpSeeds = Array.isArray(slot.knowledge_points) ? slot.knowledge_points : [];
      if (_kpSeeds.length > 0) {
        const _kpArcs = [];
        const _userIntent = (state.goalContract && state.goalContract.user_intent) || state.user_intent || null;
        const _visualArchetype = state.visual_archetype || 'DAG';
        const _pedagogicalArchetype = state.archetype || null;
        const _syllabusSlug = slug;
        try {
          if (event && event.sender && typeof event.sender.send === 'function') {
            event.sender.send('curriculum:progress', {
              topic: slug, stage: 'kp_arcs:start', idx, kp_total: _kpSeeds.length,
            });
          }
        } catch (_) {}
        for (let _i = 0; _i < _kpSeeds.length; _i++) {
          const _kpSeed = _kpSeeds[_i];
          if (!_kpSeed || !_kpSeed.id) continue;
          try {
            const _arcRes = await lessonBodyGen.generateKPArc({
              lessonPlan: plan,
              lessonBody: r.body,
              kpSeed: _kpSeed,
              userIntent: _userIntent,
              visualArchetype: _visualArchetype,
              pedagogicalArchetype: _pedagogicalArchetype,
              syllabusSlug: _syllabusSlug,
              lessonIdx: idx,
            });
            if (_arcRes && _arcRes.arc) {
              _kpArcs.push({ kp_id: _kpSeed.id, arc: _arcRes.arc, _meta: _arcRes._meta });
              try {
                if (event && event.sender && typeof event.sender.send === 'function') {
                  event.sender.send('curriculum:progress', {
                    topic: slug, stage: 'kp_arcs:done', idx, kp_i: _i + 1, kp_total: _kpSeeds.length, kp_id: _kpSeed.id,
                  });
                }
              } catch (_) {}
            }
          } catch (arcErr) {
            console.warn('[approve_and_body] generateKPArc failed for', _kpSeed.id, '—', arcErr && arcErr.message);
            try {
              if (event && event.sender && typeof event.sender.send === 'function') {
                event.sender.send('curriculum:progress', {
                  topic: slug, stage: 'kp_arcs:error', idx, kp_id: _kpSeed.id, error: arcErr && arcErr.message,
                });
              }
            } catch (_) {}
            // Per-KP error non-fatal — preserve partial array, continue with next KP.
          }
        }
        if (_kpArcs.length > 0) {
          const _arcRel = `${slug}/lesson-${idx}.kp-arc.json`;
          vault.writeJSON(_arcRel, {
            schema_version: 'kp-arc-v1',
            lesson_idx: idx,
            syllabus_slug: _syllabusSlug,
            user_intent: _userIntent,
            visual_archetype: _visualArchetype,
            pedagogical_archetype: _pedagogicalArchetype,
            arcs: _kpArcs,
            generated_at: new Date().toISOString(),
          });
          _hyphaAppendEvent('lesson_kp_arc_generated', {
            topic: slug, idx, kp_count: _kpArcs.length, kp_total: _kpSeeds.length,
          });

          // Phase B 改动 M6a (MEOW v7 HIGH fix) — wire depositKnowledgePointNote
          // runtime caller. Per pedagogy.md Layer 0 S3: each KP gets its own
          // atomic .md at vault/<slug>/lesson-<idx>/kp-<n>.md. Without this
          // call, depositKnowledgePointNote was dead code. Failure per-KP is
          // non-fatal — the kp-arc.json sidecar above remains the canonical
          // source for renderer; atomic .md files are convenience for direct
          // filesystem browsing + future cross-syllabus wikilink resolution.
          try {
            const _lessonNote = require('./lib/lesson-note');
            if (typeof _lessonNote.depositKnowledgePointNote === 'function') {
              for (const _wrapped of _kpArcs) {
                if (!_wrapped || !_wrapped.arc || !_wrapped.kp_id) continue;
                try {
                  await _lessonNote.depositKnowledgePointNote({
                    kpArc: _wrapped.arc,
                    kpId: _wrapped.kp_id,
                    lessonIdx: idx,
                    slug,
                    syllabusSlug: _syllabusSlug,
                    lessonTitle: (slot && (slot.title || slot.learnGoal)) || '',
                    archetype: _pedagogicalArchetype,
                    visualArchetype: _visualArchetype,
                    userIntent: _userIntent,
                  });
                } catch (depositErr) {
                  console.warn('[approve_and_body] depositKnowledgePointNote failed for', _wrapped.kp_id, '—', depositErr && depositErr.message);
                }
              }
            }
          } catch (depositOuter) {
            console.warn('[approve_and_body] depositKnowledgePointNote block failed:', depositOuter && depositOuter.message);
          }

          // Phase B 改动 M6b (MEOW v7 HIGH fix) — wire buildProductionScaffoldEntrypoint
          // runtime caller. Per pedagogy.md Layer 5 M4: every lesson NOTE ships
          // a production-scaffold entrypoint derived from its KP arcs'
          // intent_use_map. Persist as sibling JSON for renderer Ctrl+P mode.
          try {
            const _assignment = require('./lib/assignment');
            if (typeof _assignment.buildProductionScaffoldEntrypoint === 'function') {
              const _scaffoldEntry = _assignment.buildProductionScaffoldEntrypoint({
                userIntent: _userIntent,
                lessonKPs: _kpArcs,  // shape supports both bare-arc and { kp_id, arc } wrapper
              });
              const _scaffoldRel = `${slug}/lesson-${idx}.production-scaffold.json`;
              vault.writeJSON(_scaffoldRel, {
                schema_version: 'production-scaffold-v1',
                lesson_idx: idx,
                syllabus_slug: _syllabusSlug,
                entrypoint: _scaffoldEntry,
                generated_at: new Date().toISOString(),
              });
              _hyphaAppendEvent('lesson_production_scaffold_built', {
                topic: slug, idx, intent: _scaffoldEntry.intent,
                slot_count: (_scaffoldEntry.slot_template || []).length,
                kp_total_in_mapping: (_scaffoldEntry.kp_slot_mapping || []).reduce((acc, m) => acc + ((m.kp_refs || []).length), 0),
              });
            }
          } catch (scaffoldErr) {
            console.warn('[approve_and_body] production_scaffold block failed:', scaffoldErr && scaffoldErr.message);
          }
        }
      }
    } catch (kpArcErr) {
      // KP arc generation block is non-fatal — body already written, just log.
      console.warn('[approve_and_body] kp_arc block failed:', kpArcErr && kpArcErr.message);
    }

    // Drift sibling-write — mirrors lesson:body:generate.
    try {
      const dw = r._meta && r._meta.drift_warning;
      const warnRel = `${slug}/lesson-${idx}.body.drift-warning.json`;
      if (dw) {
        vault.writeJSON(warnRel, { warning: dw, generated_at: new Date().toISOString() });
        _hyphaAppendEvent('lesson_body_drift_check', {
          topic: slug, idx, passed: false, attempts: dw.attempts || 2, score: dw.score,
          flags: (dw.violations || []).slice(0, 6).map(v => ({ axis: v.axis, text: v.text })),
        });
      } else {
        _hyphaAppendEvent('lesson_body_drift_check', {
          topic: slug, idx, passed: true, attempts: 1,
          score: (r._meta && r._meta.drift_score) != null ? r._meta.drift_score : null,
        });
      }
    } catch (_) {}

    // Notify renderer that body is ready so it can transition from preview →
    // lesson chat surface. Channel is curriculum:progress so it lands on the
    // existing onCurriculumProgress subscription.
    try {
      if (event && event.sender && typeof event.sender.send === 'function') {
        event.sender.send('curriculum:progress', {
          topic: slug, stage: 'body_ready', idx,
        });
        event.sender.send('curriculum:body_ready', { slug, idx });
      }
    } catch (_) {}

    return { ok: true, body: r.body, _meta: r._meta };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

// curriculum:regenerate_skeleton — re-run designSkeletonOnly when user clicks
// "需要修改" + types feedback in PreviewCard. Caps at 3 regen attempts (per
// v0.3 spec). Mirrors lesson-body-generator's priorBody/userFeedback pattern.
// Sources stay frozen (don't re-harvest); only the skeleton design re-runs.
ipcMain.handle('curriculum:regenerate_skeleton', async (event, payload = {}) => {
  try {
    const slug = String(payload.slug || '').trim();
    const userFeedback = String(payload.userFeedback || '').trim();
    if (!slug) return { ok: false, error: 'BAD_INPUT', message: 'slug required' };
    if (!userFeedback) return { ok: false, error: 'BAD_INPUT', message: 'userFeedback required' };

    const state = vault.readJSON(`${slug}/state.json`, null);
    if (!state) return { ok: false, error: 'NO_SKELETON', message: 'state.json missing — run harvest_and_skeleton first' };
    const regenCount = Number.isFinite(state.skeleton_regen_count) ? state.skeleton_regen_count : 0;
    if (regenCount >= SKELETON_REGEN_CAP) {
      return {
        ok: false,
        error: 'REGEN_CAP_REACHED',
        message: `skeleton already regenerated ${SKELETON_REGEN_CAP} times — current skeleton stands`,
        regen_count: regenCount,
      };
    }

    const sources = vault.readJSON(`${slug}/sources.json`, []) || [];
    const priorSkeleton = {
      phases: state.phases || [],
      trajectory: state.trajectory || '',
      lessonPlan: Array.isArray(state.lessonPlan) ? state.lessonPlan : [],
    };
    const settings = _hyphaSettings();

    if (typeof _hyphaAgent.designSkeletonOnly !== 'function') {
      return {
        ok: false,
        error: 'AGENT_MISSING',
        message: 'agent.designSkeletonOnly not exported — backend not on v0.3 lane',
      };
    }
    const r = await _hyphaAgent.designSkeletonOnly({
      topic: state.topic || slug,
      goal: state.goal || (state.goalContract && state.goalContract.north_star_goal) || '',
      archetype: state.archetype || 'TECH-CONCEPT',
      structureAnchor: state.structureAnchor || null,
      sources,
      timeCommit: state.timeCommit || 'month',
      customLessons: state.customLessons,
      tier: state.tier || 'moderate',
      clarifications: state.clarifications || [],
      goalContract: state.goalContract || null,
      // v0.3 regen handle — designSkeletonOnly mirrors lesson-body-generator's
      // priorBody/userFeedback shape so the LLM sees rejected attempt + free-
      // text feedback together. Machino-D wires this through.
      priorSkeleton,
      userFeedback,
    }, settings);

    const newPlan = Array.isArray(r.lessonPlan) ? r.lessonPlan : [];

    // Phase B 改动 M5 (MEOW v6 HIGH fix; MEOW v7 M5.1 abort hardening) —
    // re-run generateKPSeeds for the regenerated lessonPlan. Without this,
    // regen silently drops the knowledge_points[] field on every slot,
    // breaking downstream KP arc generation in approve_and_body. Mirrors
    // Stage 1B.5 with proper AbortSignal threading + per-lesson cancelCheck.
    let _regenAborter = null;
    try { _regenAborter = new AbortController(); } catch (_) { _regenAborter = null; }
    try {
      const _lessonGenerator = require('./lib/lesson-generator');
      if (typeof _lessonGenerator.generateKPSeeds === 'function' && newPlan.length > 0) {
        const _userIntentRegen = (state.goalContract && state.goalContract.user_intent) || state.user_intent || null;
        const _visualArchetypeRegen = state.visual_archetype || 'DAG';
        const _pedagogicalArchetypeRegen = state.archetype || null;
        const _targetCountRegen = 6;
        for (let _i = 0; _i < newPlan.length; _i++) {
          const _slot = newPlan[_i];
          if (!_slot) continue;
          // MEOW v7 fix — per-lesson cancellation check (parity with Stage 1B.5).
          try { _hyphaCancelCheck(slug); }
          catch (cancelled) {
            if (_regenAborter) { try { _regenAborter.abort(); } catch (_) {} }
            throw cancelled;
          }
          try {
            if (event && event.sender && typeof event.sender.send === 'function') {
              event.sender.send('curriculum:progress', {
                topic: slug, stage: 'kp_seeds:regen_start', lesson_idx: _slot.idx, lesson_i: _i + 1, lesson_total: newPlan.length,
              });
            }
          } catch (_) {}
          try {
            const _lessonPlanShape = {
              objective: _slot.learnGoal || _slot.title || '',
              hook_concrete: _slot.scope_in || '',
              path: Array.isArray(_slot.path) ? _slot.path : [],
            };
            const _seedResult = await _lessonGenerator.generateKPSeeds({
              lessonPlan: _lessonPlanShape,
              targetCount: _targetCountRegen,
              visualArchetype: _visualArchetypeRegen,
              pedagogicalArchetype: _pedagogicalArchetypeRegen,
              userIntent: _userIntentRegen,
              signal: _regenAborter ? _regenAborter.signal : null,
            });
            if (_seedResult && Array.isArray(_seedResult.knowledge_points)) {
              _slot.knowledge_points = _seedResult.knowledge_points;
              try {
                if (event && event.sender && typeof event.sender.send === 'function') {
                  event.sender.send('curriculum:progress', {
                    topic: slug, stage: 'kp_seeds:regen_done', lesson_idx: _slot.idx, lesson_i: _i + 1, lesson_total: newPlan.length, count: _seedResult.knowledge_points.length,
                  });
                }
              } catch (_) {}
            }
          } catch (seedErr) {
            // MEOW v7 fix — propagate cancellation through, log+continue on genuine errors.
            if (seedErr && seedErr.code === 'CURRICULUM_CANCELLED') throw seedErr;
            console.warn('[regenerate_skeleton] kp_seeds regen failed for lesson', _i, '—', seedErr && seedErr.message);
          }
        }
      }
    } catch (kpRegenErr) {
      if (kpRegenErr && kpRegenErr.code === 'CURRICULUM_CANCELLED') throw kpRegenErr;
      console.warn('[regenerate_skeleton] kp_seeds regen block failed:', kpRegenErr && kpRegenErr.message);
    }

    // Persist updated state.json — keep harvest_summary + sources untouched.
    vault.writeJSON(`${slug}/state.json`, {
      ...state,
      phases: r.phases,
      trajectory: r.trajectory,
      lessonPlan: newPlan,
      skeleton_regen_count: regenCount + 1,
      last_regen_feedback: userFeedback.slice(0, 500),
      last_regen_at: new Date().toISOString(),
    });

    _hyphaAppendEvent('curriculum_v3_skeleton_regenerated', {
      topic: slug,
      regen_count: regenCount + 1,
      feedback_chars: userFeedback.length,
    });

    try {
      if (event && event.sender && typeof event.sender.send === 'function') {
        event.sender.send('curriculum:skeleton_regenerated', {
          slug, regen_count: regenCount + 1, lessonPlan: newPlan,
        });
      }
    } catch (_) {}

    return { ok: true, lessonPlan: newPlan, phases: r.phases, trajectory: r.trajectory, regen_count: regenCount + 1 };
  } catch (err) {
    return { ok: false, error: (err && err.code) || 'UNKNOWN', message: (err && err.message) || String(err) };
  }
});

// Per-lesson session storage helpers (Day 2.9 refactor).
// Sessions live at `<topic>/sessions/L<idx>-<startISO>.jsonl`. Each file = one
// session. Filename ISO uses dashes only (no colons — Windows-safe).
function _sessionPathFor(slug, idx, startIso) {
  const safeIso = startIso.replace(/[:.]/g, '-');
  return `${slug}/sessions/L${String(idx).padStart(2, '0')}-${safeIso}.jsonl`;
}
function _listSessionsForLesson(slug, idx) {
  // Returns [{file, startISO, turnCount, firstQuestion, mode, sourceSession}]
  const dirRel = `${slug}/sessions`;
  const entries = vault.listDir(dirRel);
  const out = [];
  const prefix = `L${String(idx).padStart(2, '0')}-`;
  for (const e of entries) {
    if (e.isDir) continue;
    if (!e.name.startsWith(prefix) || !e.name.endsWith('.jsonl')) continue;
    const turns = vault.readJSONL(`${dirRel}/${e.name}`).filter(t => t.idx === idx);
    const meta = turns.find(t => t.role === 'meta') || {};
    const firstTutor = turns.find(t => t.role === 'tutor');
    const userTurns = turns.filter(t => t.role === 'user').length;
    out.push({
      file: e.name,
      rel: `${dirRel}/${e.name}`,
      startISO: e.name.slice(prefix.length, -6).replace(/-(\d{2})-(\d{2})-(\d+)Z?$/, ':$1:$2.$3Z'),
      turnCount: userTurns,
      firstQuestion: firstTutor ? (firstTutor.text || '').slice(0, 140) : '',
      mode: meta.mode || 'fresh',
      sourceSession: meta.sourceSession || null,
    });
  }
  out.sort((a, b) => b.file.localeCompare(a.file));
  return out;
}

// llm:lesson — one tutor turn. Streams via llm:deepen-progress so the chat
// listener receives chunks. Per-session jsonl path; renderer passes
// sessionFile (or omits → first call generates new file + returns it).
const _hyphaLessonAbort = new Map();
ipcMain.handle('llm:lesson', async (event, { noteRel, userMsg, requestId, sessionFile, currentState } = {}) => {
  if (!noteRel || !requestId) return { ok: false, error: 'noteRel + requestId required' };
  const settings = _hyphaSettings();
  const ac = new AbortController();
  _hyphaLessonAbort.set(requestId, ac);

  // Resolve lesson context from the .md frontmatter.
  const note = vault.read(noteRel);
  if (!note) { _hyphaLessonAbort.delete(requestId); return { ok: false, error: 'lesson note not found' }; }
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || (noteRel.split(/[\\/]/)[0]);
  const idx = parseInt(fm.lesson_idx, 10);
  if (isNaN(idx)) { _hyphaLessonAbort.delete(requestId); return { ok: false, error: 'note missing lesson_idx' }; }
  // v0158q — Hypha Learn opt-in. Mode lives on the lesson note's frontmatter
  // (set by curriculum:create); fall back to 'classic' so legacy notes are
  // byte-identical. Renderer may also pass `currentState` to override the
  // self-derived state — frontend tracks across turns.
  // 2026-05-05 — added 'raw' (Pure CLI radio, claude-cli only); raw skips
  // Hypha tutor scaffolding entirely (same effect as provider=claude-cli auto-
  // pure path, but explicit and persisted in frontmatter for future logic).
  const learnMode = (fm.learn_mode === 'learn') ? 'learn'
                  : (fm.learn_mode === 'raw')   ? 'raw'
                  : 'classic';
  // 2026-05-05 (Appendix C) — claude-cli pure passthrough. Triggers when:
  //   (a) provider === 'claude-cli' (auto, regardless of mode), OR
  //   (b) frontmatter.learn_mode === 'raw' (explicit user choice via Pure CLI
  //       radio in TabContent — only shown for claude-cli provider)
  // Either way: Hypha bypasses tutor system + STAKE + state + leak guard;
  // claude-cli uses its default Claude Code system. Sandbox env still blocks
  // Victor universe + global agents.
  const _isPureCli = (settings && settings.provider === 'claude-cli') || (learnMode === 'raw');

  const sources = vault.readJSON(`${slug}/sources.json`, []);
  const state = vault.readJSON(`${slug}/state.json`, { mastered: [], gaps: [], lastIdx: -1, lessonRels: [] });
  const sequence = (state.lessonRels || []).map((_r, i) => ({ idx: i, title: '', learnGoal: '' }));

  // Reconstruct prior notes (the dual-layer notes from earlier lessons in this topic)
  const priorNotes = [];
  for (let i = 0; i < idx; i++) {
    const r = state.lessonRels?.[i];
    if (!r) continue;
    const n = vault.read(r);
    if (n && n.body) priorNotes.push({ idx: i, body: n.body });
  }

  // Determine session file path. Caller may supply `sessionFile` (a basename
  // like 'L00-2026-04-30T08-23-15-123Z.jsonl') to resume / continue. If absent,
  // create new fresh-mode session file with current timestamp.
  let sessionRel;
  let isNewSession = false;
  if (sessionFile && /^L\d+-/.test(sessionFile)) {
    sessionRel = `${slug}/sessions/${sessionFile}`;
  } else {
    const startIso = new Date().toISOString();
    sessionRel = _sessionPathFor(slug, idx, startIso);
    isNewSession = true;
    // Stamp a meta row at session start.
    vault.appendJSONL(sessionRel, { ts: startIso, idx, role: 'meta', mode: 'fresh' });
    // W3.6 Companion Triggers — interrupt_resume on first new session after gap.
    try {
      const lastAt = _lastSessionTimestamp(slug);
      if (lastAt) require('./lib/companion-triggers').tryInterruptResume({ slug, lastLessonAt: lastAt, currentTs: startIso });
    } catch (_) { /* companion is advisory */ }
  }

  const transcript = vault.readJSONL(sessionRel)
    .filter(t => t.idx === idx && (t.role === 'user' || t.role === 'tutor'))
    .map(t => ({ role: t.role === 'tutor' ? 'assistant' : t.role, content: t.text }));

  // Lacquer Loop P2 — detect prediction turn (first user response after the
  // tutor's prediction-prompt opener). If archetype emphasizes P2 (HIGH/MED)
  // AND transcript shows exactly 1 tutor turn (the opener) AND 0 prior user
  // turns AND userMsg is a real message, this user message IS the prediction.
  const p2Emph = _hyphaAgent.getEmphasis(state.archetype, 'P2');
  const p2Active = p2Emph !== null && p2Emph >= 1;
  const tutorTurnsBefore = transcript.filter(t => t.role === 'assistant').length;
  const userTurnsBefore = transcript.filter(t => t.role === 'user').length;
  const isPredictionTurn = p2Active && userMsg && userMsg !== '__begin__' && tutorTurnsBefore === 1 && userTurnsBefore === 0;

  // Append user message to session
  if (userMsg && userMsg !== '__begin__') {
    vault.appendJSONL(sessionRel, { ts: new Date().toISOString(), idx, role: 'user', text: userMsg });
  }

  // P2 capture — score the prediction inline (best-effort, ~2-5s LLM judge).
  // Append a `p2-prediction` row to the session jsonl. lesson:finish reads
  // these rows and feeds scheduler.recordPrediction. Failures swallowed —
  // never block tutor's response.
  if (isPredictionTurn) {
    try {
      const learnGoal = fm.learn_goal || '';
      if (learnGoal) {
        const judged = await _hyphaAgent.scoreQuizAnswer(
          'Predict what this lesson teaches',
          learnGoal,
          'mechanism alignment with the lesson learn goal',
          userMsg,
          settings
        );
        const delta_norm = Math.max(0, Math.min(1, 1 - judged.score));
        vault.appendJSONL(sessionRel, {
          ts: new Date().toISOString(), idx, role: 'p2-prediction',
          predicted: userMsg, actual: learnGoal,
          delta_norm, score: judged.score, reason: judged.reason || '',
        });
      }
    } catch (_) { /* best-effort; never block lesson */ }
  }

  // Load curriculum-specific tutor profile (persona + custom instructions).
  // Defaults to Socratic if no agent.json exists for this curriculum.
  const agentProfile = vault.readJSON(`${slug}/agent.json`, { persona: 'socratic', customInstructions: '' });

  // Load user profile so the tutor can (a) address the student by name and
  // (b) tailor register/depth/examples to the student's self-introduction.
  // Empty fields → tutor uses generic addressing + default register.
  const userProfile = (vault.exists && vault.exists('data/profile.json'))
    ? (vault.readJSON('data/profile.json', null) || { name: '', about: '' })
    : { name: '', about: '' };

  // v0158q — Hypha Learn substrate. Build the STAKE block once and derive
  // currentState (renderer override > last-turn marker parse > HOOK initial).
  // STAKE block is empty-string when learnMode='classic' so designLesson keeps
  // its existing path. Build is async but cheap; never blocks classic mode.
  let stakeBlock = '';
  let derivedCurrentState = _hyphaLearnSM.initialState();
  let priorStateHistory = [];
  // 2026-05-05 (Appendix C) — when claude-cli pure mode active, skip the
  // entire Hypha Learn substrate (STAKE / state machine / leak guard).
  // Pure mode = let CLI use its default system + run conversation cleanly.
  // Hypha tutor scaffolding becomes no-ops; rendering also short-circuits.
  if (learnMode === 'learn' && !_isPureCli) {
    const lastTutor = vault.readJSONL(sessionRel)
      .filter(t => t.idx === idx && t.role === 'tutor')
      .map(t => t.text);
    for (const txt of lastTutor) {
      const parsed = _hyphaLearnSM.parseStateMarker(txt || '');
      if (parsed && parsed.state) priorStateHistory.push(parsed.state);
    }
    if (typeof currentState === 'string' && currentState.trim()) {
      derivedCurrentState = currentState.trim().toUpperCase();
    } else if (priorStateHistory.length) {
      // Use last tutor's `next` if present, else `state`. Final element wins.
      const lastTxt = lastTutor[lastTutor.length - 1];
      const last = _hyphaLearnSM.parseStateMarker(lastTxt || '');
      derivedCurrentState = last.next || last.state || _hyphaLearnSM.initialState();
    }
    try {
      stakeBlock = await _hyphaLearnStake.buildStakeBlock({
        transcript,
        vaultRoot: vault.resolveRoot(),
        eventLogPath: path.join(vault.resolveRoot(), 'events.jsonl'),
        curriculum: { lessons: (state.lessonRels || []).map((_r, i) => ({
          id: String(i),
          title: '',
          state: i < idx ? 'settled' : (i === idx ? 'open' : 'pending'),
        })) },
      });
    } catch (_) { stakeBlock = ''; }
  }

  // Build system prompt from lesson-start template (first turn) or use rolling context (subsequent).
  const systemPrompt = await _hyphaAgent.designLesson({
    topic: slug, idx, sequence, sources, state, priorNotes,
    lessonTitle: fm.title || note.body.match(/^# (.+)$/m)?.[1] || '',
    learnGoal: fm.learn_goal || '',
    agentProfile,
    userProfile,
    archetype: state.archetype,
    // v0158q — learn-mode passthroughs; designLesson ignores them when mode='classic'.
    mode: learnMode,
    currentState: derivedCurrentState,
    stateHistory: priorStateHistory,
    stakeBlock,
    transcript,
    latestUserMsg: (userMsg && userMsg !== '__begin__') ? userMsg : '',
  }, settings);

  let acc = '';
  // Emit start so DeepenCallout shows the running stage indicator.
  try { event.sender.send('llm:deepen-progress', { requestId, status: 'start', stage: 'lesson', label: 'tutor' }); } catch (_) {}

  const onChunk = (text) => {
    acc += text;
    try { event.sender.send('llm:deepen-progress', { requestId, status: 'chunk', stage: 'lesson', text }); } catch (_) {}
  };

  // 2026-05-05 (Appendix C) — when pure CLI mode active and this is the
  // session opener (__begin__ or empty userMsg), enrich the placeholder with
  // topic + lesson goal so claude-cli has explicit context. Without this the
  // CLI sees only "[Lesson start. Begin with your first question.]" and has
  // no idea what to teach. Subsequent turns rely on transcript continuity.
  let _effectiveUserMsg = userMsg;
  // 2026-05-05 (Appendix D v0.3.0) — claude-cli session continuity. Read
  // claude_session_id from session jsonl meta row. If set, this is a
  // continuation turn and we'll pass --resume (model has own history). If
  // unset, this is the first turn → spawn fresh, capture session_id via
  // callback, write to meta.
  let _claudeSessionId = null;
  if (_isPureCli && !isNewSession) {
    try {
      const _existingRows = vault.readJSONL(sessionRel);
      // Find the meta row that actually carries claude_session_id (may not
      // be the first meta row — initial mode='fresh' meta is written before
      // session_id is captured, then a second meta row with claude_session_id
      // is appended once stream-json emits the system event).
      const _metaRow = _existingRows.find(r => r && r.role === 'meta' && r.idx === idx
        && typeof r.claude_session_id === 'string' && r.claude_session_id);
      if (_metaRow) {
        _claudeSessionId = _metaRow.claude_session_id;
      }
    } catch (_) { /* ignore — fresh path */ }
  }
  if (_isPureCli && (!userMsg || userMsg === '__begin__')) {
    // v0.3.0 opener (O-2 minimal) — let model decide form (plan / Socratic /
    // story). Removes v0.2.0's "design 1500-2000 word plan" framing that
    // over-constrained the model.
    // v0.4.2 — persona + SVG additions. Pure CLI bypasses designLesson's
    // system-prompt persona injection, so persona was being silently dropped
    // (Karpathy / Feynman / etc. all produced identical output). Re-route
    // persona name + 1-line style hint via user-message opener so the model
    // honors the curriculum's chosen tutor identity. SVG line authorizes
    // diagrams (constitution carries this for SDK paths; Pure CLI needs its
    // own copy since constitution is filtered out).
    const _topicLabel = fm.title || (note.body && note.body.match(/^# (.+)$/m)?.[1]) || slug;
    const _goalLabel = fm.learn_goal || '';
    const _curriculumLang = (state && typeof state.language === 'string' && state.language.trim())
      ? state.language.trim() : '';
    // 2026-05-05 v0.4.3 — Goal upgraded from informational ("Goal: X") to
    // binding directive. Default Hypha path (Pure CLI) was treating goal as
    // sidebar info and falling into industrial-pedagogy default (define → quiz
    // → next definition). Pre-attach the binding directive that the
    // constitution carries for SDK paths but Pure CLI strips.
    const _goalLine = _goalLabel ? `Working toward: ${_goalLabel}\n` : '';
    const _langLine = _curriculumLang ? `Respond in ${_curriculumLang}.\n` : '';
    let _personaLine = '';
    let _customLine = '';
    try {
      const personas = require('./lib/personas');
      const p = personas.getPersona && personas.getPersona((agentProfile && agentProfile.persona) || 'socratic');
      if (p && p.label) {
        const shortDesc = p.short || (p.prompt ? p.prompt.slice(0, 220) : '');
        _personaLine = `Tutor style: ${p.label}${shortDesc ? ' — ' + shortDesc : ''}\n`;
      }
    } catch (_) { /* personas module missing — degrade silently */ }
    const _customInstr = (agentProfile && typeof agentProfile.customInstructions === 'string')
      ? agentProfile.customInstructions.trim() : '';
    if (_customInstr) _customLine = `Tutor extras: ${_customInstr}\n`;
    const _svgLine =
      `\nVISUAL AID: when the topic genuinely earns a diagram (vectors, geometry, function shapes, network architectures, state transitions, etc.), output it as an inline \`\`\`svg fenced markdown block. Hypha renders SVG inline as an actual image. Use diagrams when they pull weight, not as decoration.\n`;
    // 2026-05-05 v0.4.3 — anti-industrial-pedagogy directive. Without this,
    // the model defaults to define-then-quiz textbook patterns. We need
    // explicit Feynman-test framing so it teaches APPLICATION, not recitation.
    const _goalBindingLine = _goalLabel
      ? `\nGOAL BINDING: I'm here for ONE reason — ${_goalLabel}. Every concept must trace back to enabling this. Don't drill definitions for memorization; drill APPLICATION on instances that connect to my goal. Feynman test: knowing the name of a bird is not knowing the bird.\n\nAnti-pattern (forbidden): definition → quick comprehension check → next definition. That's an exam, not a lesson. Each concept goes: introduce → apply to instance touching my goal → I operate it → only then move on.\n`
      : `\nGOAL BINDING: drill APPLICATION on instances, not recitation of definitions. Feynman test: knowing the name of a bird is not knowing the bird. Each concept: introduce → apply to instance → I operate it → only then move on.\n`;
    _effectiveUserMsg =
      `Topic: ${_topicLabel}\n` +
      _goalLine +
      _langLine +
      _personaLine +
      _customLine +
      _svgLine +
      _goalBindingLine +
      `\nHelp me learn this.`;
  }

  // 2026-05-05 (Appendix D) — onSessionId callback persists claude-cli session
  // ID into the session jsonl meta row, allowing subsequent turns to use
  // --resume <id> instead of replaying transcript. Skips when not pure-CLI
  // mode (no session continuity available). Idempotent — only writes on first
  // capture per session.
  let _capturedSessionId = null;
  const _onSessionIdCb = _isPureCli ? (sid) => {
    if (_capturedSessionId) return;
    _capturedSessionId = sid;
    try {
      vault.appendJSONL(sessionRel, {
        ts: new Date().toISOString(),
        idx,
        role: 'meta',
        claude_session_id: sid,
      });
    } catch (_) { /* meta-row failure is non-fatal */ }
  } : null;

  // 2026-05-14 (Audit-B fix) — capture streamTurn return to access scrubbed
  // cleaned text. Streamed chunks already went to renderer uncleaned, but
  // transcript persistence + downstream consumers (re-stream prompts, confession
  // extract) should use cleaned version. TODO v0.4: real-time chunk scrub via
  // SSE buffer-edit window so renderer also sees clean output.
  let _streamResult = null;
  try {
    _streamResult = await _hyphaAgent.streamTurn({
      systemPrompt,
      history: transcript,
      userMsg: _effectiveUserMsg,
      settings,
      signal: ac.signal,
      resumeSessionId: _claudeSessionId,
      onSessionId: _onSessionIdCb,
      // Machino-α8 (2026-05-15) — pass slug + lessonIdx so the post-stream
      // anti-slop scan can scope citation-verifier (reads vault/<slug>/sources.json)
      // + events.jsonl writes to the correct course bucket.
      slug,
      lessonIdx: idx,
      // Machino-β9 (2026-05-15) — PJR rewrite gate keys off archetype so
      // HUMANITIES/LANG-ACQ/MINDSET don't get tech-fidelity rewrites that
      // dilute their register.
      archetype: state.archetype || null,
    }, onChunk);
    // v0158q — Hypha Learn post-stream pipeline: parse state marker, run
    // answer-leak guard (single regen on LEAK), then record events. Classic
    // mode skips this entire block — behavior identical to pre-v0158q.
    // Appendix C 2026-05-05 — claude-cli pure mode also skips (no state
    // markers will be emitted, leak guard is meaningless without state).
    let regenAttempts = 0;
    let leakedFinal = false;
    let parsedNext = null;
    if (learnMode === 'learn' && !ac.signal.aborted && !_isPureCli) {
      try {
        const guardRes = await _hyphaLearnGuard.checkAnswerLeak({
          state: derivedCurrentState,
          response: acc,
          lessonGoal: fm.learn_goal || '',
          settings,
        });
        if (guardRes && guardRes.leaked) {
          regenAttempts = 1;
          // One-shot regen with hint as a system addendum. We discard the
          // first acc and re-stream; the renderer sees the second draft.
          const hintedSystem = `${systemPrompt}\n\n${guardRes.hint || _hyphaLearnGuard.buildRegenHint(derivedCurrentState)}`;
          acc = '';
          try { event.sender.send('llm:deepen-progress', { requestId, status: 'regen', stage: 'lesson' }); } catch (_) {}
          // 2026-05-14 (Audit-B fix) — overwrite _streamResult so cleaned text
          // from the regenerated reply (not the original leaked one) goes to
          // transcript persistence below.
          _streamResult = await _hyphaAgent.streamTurn({ systemPrompt: hintedSystem, history: transcript, userMsg, settings, signal: ac.signal, slug, lessonIdx: idx, archetype: state.archetype || null }, onChunk);
          // Best-effort second check; if still leaked we accept + log.
          try {
            const second = await _hyphaLearnGuard.checkAnswerLeak({
              state: derivedCurrentState, response: acc,
              lessonGoal: fm.learn_goal || '', settings,
            });
            leakedFinal = !!(second && second.leaked);
          } catch (_) { leakedFinal = false; }
          try { _hyphaAppendEvent('leak_regen', { slug, idx, lesson_id: noteRel, state: derivedCurrentState, leaked_after_regen: leakedFinal }); } catch (_) {}
        }
      } catch (_) { /* guard infra fail-safe — never block lesson */ }
      try {
        // MEOW Gate A Patch 1 (2026-05-08): wire validateTransition. Previously
        // accepted any LLM-emitted parsedNext as authoritative — 8-state machine
        // was purely cosmetic. Now: clamp invalid jumps against TRANSITIONS
        // reachability table + log state_transition_invalid for monitoring.
        const parsed = _hyphaLearnSM.parseStateMarker(acc || '');
        const requested = (parsed && (parsed.next || parsed.state)) || null;
        const fromState = derivedCurrentState;
        const allowedTargets = Object.values(_hyphaLearnSM.TRANSITIONS[fromState] || {});
        let toState;
        let transitionValid = true;
        if (requested) {
          if (allowedTargets.includes(requested)) {
            toState = requested;
            parsedNext = requested;
          } else {
            transitionValid = false;
            const alwaysFallback = (_hyphaLearnSM.TRANSITIONS[fromState] || {}).always;
            toState = alwaysFallback || fromState;
            parsedNext = (toState && toState !== fromState) ? toState : null;
            _hyphaAppendEvent('state_transition_invalid', {
              slug, idx, lesson_id: noteRel,
              from: fromState, requested, clamped_to: toState,
            });
          }
        } else {
          const alwaysNext = (_hyphaLearnSM.TRANSITIONS[fromState] || {}).always;
          toState = alwaysNext || fromState;
          parsedNext = (toState && toState !== fromState) ? toState : null;
        }
        _hyphaAppendEvent('state_transition', {
          slug, idx, lesson_id: noteRel,
          from: fromState, to: toState, valid: transitionValid,
        });
      } catch (_) {}
    }
    // 2026-05-14 (Audit-B fix) — write CLEANED text to transcript, not raw `acc`.
    // `acc` accumulates the streamed chunks (already shown to user uncleaned).
    // _streamResult.cleaned is the post-scrub version with ingratiation phrases
    // (great question / 你真正抓住了关键 / 说实话 / absolutely / exactly etc.)
    // stripped. Downstream (re-stream history replay, confession extract, lesson
    // synth) reads from this jsonl, so they see clean. Stream chunks to renderer
    // remain uncleaned — real-time scrub deferred to v0.4 (SSE protocol change).
    // Machino-α8 (2026-05-15) — if anti-slop PJR produced a rewritten version,
    // persist that instead. Rewrite is built on `cleaned`, so it already carries
    // ingratiation scrub. Stream UI saw original; transcript + downstream see
    // PJR-corrected version (consistent with α6 scrub strategy).
    const _antiSlop = _streamResult && _streamResult.antiSlop;
    const _persistedText = (_antiSlop && typeof _antiSlop.rewritten === 'string' && _antiSlop.rewritten.trim())
      ? _antiSlop.rewritten
      : ((_streamResult && typeof _streamResult.cleaned === 'string')
        ? _streamResult.cleaned
        : acc);
    const _violationCount = (_streamResult && Array.isArray(_streamResult.violations))
      ? _streamResult.violations.length
      : 0;
    const _antiSlopRewriteApplied = !!(_antiSlop && _antiSlop.rewritten);
    vault.appendJSONL(sessionRel, {
      ts: new Date().toISOString(),
      idx,
      role: 'tutor',
      text: _persistedText,
      ingratiation_scrubbed: _violationCount > 0 ? _violationCount : undefined,
      anti_slop_rewrite_applied: _antiSlopRewriteApplied || undefined,
      anti_slop_severity: (_antiSlop && _antiSlop.verdict && _antiSlop.verdict.severity) || undefined,
    });

    // Machino-α8 (2026-05-15) — emit anti-slop scan-complete to renderer so
    // Course Trust Panel β8 (deferred) can light up signals + rewrite indicator.
    try {
      if (_antiSlop && _antiSlop.signals) {
        _emitToRenderer('anti-slop:scan-complete', {
          requestId,
          slug,
          lessonIdx: idx,
          signals: _antiSlop.signals,
          verdict: _antiSlop.verdict || null,
          has_rewrite: !!_antiSlop.rewritten,
        });
      }
    } catch (_) { /* emit failures must not break lesson return */ }
    _hyphaLessonAbort.delete(requestId);
    if (ac.signal.aborted) {
      try { event.sender.send('llm:deepen-progress', { requestId, status: 'aborted', stage: 'lesson', text: acc }); } catch (_) {}
      return { ok: true, text: acc, sessionFile: sessionRel.split(/[\\/]/).pop(), isNewSession, aborted: true };
    }
    try { event.sender.send('llm:deepen-progress', { requestId, status: 'done', stage: 'lesson', text: acc }); } catch (_) {}
    // Return sessionFile basename so caller can persist + reuse for next turn.
    const usedFile = sessionRel.split(/[\\/]/).pop();
    if (learnMode === 'learn') {
      return {
        ok: true, text: acc, sessionFile: usedFile, isNewSession,
        currentState: derivedCurrentState,
        nextState: parsedNext,
        leaked: leakedFinal,
        regenAttempts,
      };
    }
    return { ok: true, text: acc, sessionFile: usedFile, isNewSession };
  } catch (err) {
    _hyphaLessonAbort.delete(requestId);
    if (ac.signal.aborted) {
      try { event.sender.send('llm:deepen-progress', { requestId, status: 'aborted', stage: 'lesson', text: acc }); } catch (_) {}
      return { ok: true, text: acc, aborted: true, partial: acc };
    }
    try { event.sender.send('llm:deepen-progress', { requestId, status: 'error', stage: 'lesson', error: err.message }); } catch (_) {}
    return { ok: false, error: err.message, partial: acc };
  }
});

// lesson:sessions — list all sessions for a given lesson .md
// boot-11 — wrap in try/catch so vault/_listSessionsForLesson failure (corrupt
// frontmatter, missing sessions dir under race) returns [] not a rejected promise.
ipcMain.handle('lesson:sessions', (_e, { rel } = {}) => {
  try {
    if (!rel) return [];
    const note = vault.read(rel);
    if (!note) return [];
    const fm = note.frontmatter || {};
    const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
    const idx = parseInt(fm.lesson_idx, 10);
    if (isNaN(idx)) return [];
    return _listSessionsForLesson(slug, idx);
  } catch (err) {
    console.warn('[lesson:sessions] failed:', err && err.message);
    return [];
  }
});

// lesson:session-delete — soft-delete one session jsonl file. 2026-05-03.
// Reuses vault.del → moves to data/.trash/<basename>-<unixMs>/ with 7d
// auto-purge. Renderer's "焚信" ceremony dissolves the row + 5s undo,
// then commits via this IPC. Session file format: <slug>/sessions/<file>.
ipcMain.handle('lesson:session-delete', (_e, { rel, sessionFile } = {}) => {
  if (!rel || !sessionFile) return { ok: false, error: 'rel + sessionFile required' };
  if (!/^L\d+-/.test(sessionFile)) return { ok: false, error: 'invalid session filename' };
  const note = vault.read(rel);
  if (!note) return { ok: false, error: 'note not found' };
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
  const sessionRel = `${slug}/sessions/${sessionFile}`;
  try {
    const r = vault.del(sessionRel);
    return r || { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// lesson:transcript — return parsed turns of one specific session.
ipcMain.handle('lesson:transcript', (_e, { rel, sessionFile } = {}) => {
  try {
    if (!rel || !sessionFile) return { ok: false, error: 'rel + sessionFile required' };
    const note = vault.read(rel);
    if (!note) return { ok: false, error: 'note not found' };
    const fm = note.frontmatter || {};
    const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
    const idx = parseInt(fm.lesson_idx, 10);
    const turns = vault.readJSONL(`${slug}/sessions/${sessionFile}`)
      .filter(t => t.idx === idx);
    return { ok: true, turns };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// lesson:continueFrom — fork a new continuation session seeded with the prior
// session's turns as context. Marks new session mode='continuation' +
// sourceSession=<sourceFile>. Returns new sessionFile basename.
ipcMain.handle('lesson:continueFrom', (_e, { rel, sourceSessionFile } = {}) => {
  try {
    if (!rel || !sourceSessionFile) return { ok: false, error: 'rel + sourceSessionFile required' };
    const note = vault.read(rel);
    if (!note) return { ok: false, error: 'note not found' };
    const fm = note.frontmatter || {};
    const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
    const idx = parseInt(fm.lesson_idx, 10);
    if (isNaN(idx)) return { ok: false, error: 'note missing lesson_idx' };
    const sourceTurns = vault.readJSONL(`${slug}/sessions/${sourceSessionFile}`)
      .filter(t => t.idx === idx && (t.role === 'user' || t.role === 'tutor'));
    const startIso = new Date().toISOString();
    const newRel = _sessionPathFor(slug, idx, startIso);
    // Meta row first, then copy prior turns in (so resume reads them as context).
    vault.appendJSONL(newRel, { ts: startIso, idx, role: 'meta', mode: 'continuation', sourceSession: sourceSessionFile });
    for (const t of sourceTurns) vault.appendJSONL(newRel, t);
    const newFile = newRel.split(/[\\/]/).pop();
    return { ok: true, sessionFile: newFile, sourceTurns };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
ipcMain.handle('llm:lesson-abort', (_e, requestId) => {
  const ac = _hyphaLessonAbort.get(requestId);
  if (ac) { ac.abort(); _hyphaLessonAbort.delete(requestId); return true; }
  return false;
});

// Concept Atlas Phase A.1 — substrate layer (council 2026-05-01).
// One file per lesson at vault/data/atlas/<slug>__<idx>.json. Per turn,
// renderer calls atlas:append-turn → main calls extractAtlasDelta → merges
// into stored atlas. Renderer renders chips. atlas:edit-state lets user
// manually override (escape hatch + telemetry signal per Yogo D5).
function _atlasPath(slug, idx) {
  const idxStr = String(idx).padStart(2, '0');
  return `data/atlas/${slug}__${idxStr}.json`;
}

function _atlasEmpty(rel, slug, idx, lessonContext) {
  return {
    rel,
    slug,
    lesson_idx: idx,
    lesson_title: (lessonContext && lessonContext.lesson_title) || '',
    learn_goal: (lessonContext && lessonContext.learn_goal) || '',
    concepts: {},      // term → { term, alt_forms, first_seen_turn, occurrences, state, settled_at_turn, snippet, category }
    expected: [],      // [{ term, reason, declared_at_turn }]
    turn_count: 0,
    last_updated: new Date().toISOString(),
  };
}

function _atlasMerge(prevAtlas, delta, role, currentTurn) {
  const next = { ...prevAtlas, concepts: { ...(prevAtlas.concepts || {}) }, expected: [...(prevAtlas.expected || [])] };
  // Introduced: add new concept nodes
  for (const c of (delta.introduced || [])) {
    if (!c.term) continue;
    if (next.concepts[c.term]) continue;     // already exists; treat as referenced instead
    next.concepts[c.term] = {
      term: c.term,
      alt_forms: Array.isArray(c.alt_forms) ? c.alt_forms.slice(0, 5) : [],
      first_seen_turn: currentTurn,
      occurrences: [{ turn: currentTurn, role }],
      state: 'introduced',
      settled_at_turn: null,
      snippet: c.snippet || '',
      category: c.category || 'unknown',
    };
    // If this term was in expected list, drop it (now covered)
    next.expected = next.expected.filter(e => e.term !== c.term);
  }
  // Referenced: bump existing nodes
  for (const r of (delta.referenced || [])) {
    if (!r.term || !next.concepts[r.term]) continue;
    const c = next.concepts[r.term];
    c.occurrences.push({ turn: currentTurn, role });
    if (c.state === 'introduced') c.state = 'referenced';
  }
  // Settled by user: mark mastery
  if (role === 'user') {
    for (const s of (delta.settled_by_user || [])) {
      if (!s.term || !next.concepts[s.term]) continue;
      const c = next.concepts[s.term];
      c.state = 'settled';
      c.settled_at_turn = currentTurn;
      // Ensure occurrence recorded
      if (!c.occurrences.some(o => o.turn === currentTurn && o.role === 'user')) {
        c.occurrences.push({ turn: currentTurn, role: 'user' });
      }
    }
  }
  // Expected uncovered: add only new ones (dedupe by term)
  for (const e of (delta.expected_uncovered || [])) {
    if (!e.term) continue;
    if (next.concepts[e.term]) continue;     // already covered
    if (next.expected.some(x => x.term === e.term)) continue;
    next.expected.push({
      term: e.term,
      reason: e.reason || '',
      declared_at_turn: currentTurn,
    });
  }
  next.turn_count = currentTurn + 1;
  next.last_updated = new Date().toISOString();
  return next;
}

// v0.9.0 HERMES-style user profile — file-based, derived from existing vault
// corpus (用户灵感 sections + atlas frequency + chain goal). Injected into
// every tutor system prompt as <USER_PROFILE> via designLesson. This handler
// runs the cold-start derivation; auto-reflection LLM call deferred to v0.9.1.
ipcMain.handle('userProfile:get', () => {
  try {
    const userProfile = require('./lib/userProfile');
    const root = vault.resolveRoot();
    const profile = userProfile.loadProfile(root);
    return { ok: true, profile, exists: !profile.meta?.empty };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('userProfile:rebuild', async () => {
  try {
    const userProfile = require('./lib/userProfile');
    const root = vault.resolveRoot();
    const folders = (vault.list() || {}).folders || [];
    // Gather lesson notes (per-folder, last 6 lessons each, capped total 20)
    const lessonNotes = [];
    for (const f of folders) {
      const items = (f.items || []).filter(it => !it.ghost && it.id && it.id.endsWith('.md'));
      for (const it of items.slice(-6)) {
        const note = vault.read(it.id);
        if (note && note.body) lessonNotes.push({ id: it.id, body: note.body });
        if (lessonNotes.length >= 20) break;
      }
      if (lessonNotes.length >= 20) break;
    }
    // Gather atlases (per-folder, all atlas files)
    const atlases = [];
    for (const f of folders) {
      const slug = f.folder;
      if (!slug) continue;
      for (let i = 0; i < 50; i++) {
        const p = _atlasPath(slug, i);
        const a = vault.readJSON(p, null);
        if (a) atlases.push(a); else break;
      }
    }
    // Gather chain metadata
    const chains = [];
    for (const f of folders) {
      if (f.chainSlug && f.chainUltimateGoal) {
        chains.push({ slug: f.chainSlug, ultimateGoal: f.chainUltimateGoal });
      }
    }
    const dedupChains = [];
    const seenSlugs = new Set();
    for (const c of chains) {
      if (seenSlugs.has(c.slug)) continue;
      seenSlugs.add(c.slug);
      dedupChains.push(c);
    }
    const profile = userProfile.coldStartFromVault(root, {
      lessonNotes, atlases, chains: dedupChains,
    });
    const vaultName = require('path').basename(root);
    const md = userProfile.writeProfile(root, profile, vaultName);
    return { ok: true, profile, md, sources: {
      lessonNotesUsed: lessonNotes.length,
      atlasesUsed: atlases.length,
      chainsUsed: dedupChains.length,
    } };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

// v0.11.2 — userProfile pending observations + ratify. Reflection LLM logs
// every diff entry to <vault>/.hypha/reflections.jsonl. Confidence ≥0.7
// auto-applies; below surfaces here for the user to keep/drop. Per /tr
// 2026-05-02 v0.9.1 plan: closes the HERMES feedback loop with user agency.
function _addToDismissed(root, id) {
  try {
    const p = require('path');
    const fs = require('fs');
    const dir = p.join(root, '.hypha');
    fs.mkdirSync(dir, { recursive: true });
    const f = p.join(dir, 'reflections-dismissed.json');
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(f, 'utf8')) || []; if (!Array.isArray(arr)) arr = []; } catch (_) {}
    if (!arr.includes(id)) arr.push(id);
    fs.writeFileSync(f, JSON.stringify(arr.slice(-500)));
  } catch (_) {}
}

ipcMain.handle('userProfile:pending', (_e, { limit } = {}) => {
  try {
    const root = vault.resolveRoot();
    const p = require('path');
    const fs = require('fs');
    const jsonlPath = p.join(root, '.hypha', 'reflections.jsonl');
    if (!fs.existsSync(jsonlPath)) return { ok: true, pending: [] };
    const dismissedPath = p.join(root, '.hypha', 'reflections-dismissed.json');
    let dismissed = new Set();
    try { const d = JSON.parse(fs.readFileSync(dismissedPath, 'utf8')); if (Array.isArray(d)) dismissed = new Set(d); } catch (_) {}
    const text = fs.readFileSync(jsonlPath, 'utf8');
    const lines = text.split('\n').filter(Boolean).slice(-(limit || 50));
    const collected = [];
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch (_) { continue; }
      if (!rec || rec.parse_error || !rec.diff) continue;
      const ts = rec.ts || '';
      const lessonRel = rec.lessonRel || '';
      for (const section of ['STYLE', 'GRAVITATION', 'VOICE', 'PROJECT']) {
        const arr = rec.diff[section];
        if (!Array.isArray(arr)) continue;
        for (const entry of arr) {
          if (!entry || typeof entry !== 'object') continue;
          const conf = (typeof entry.confidence === 'number') ? entry.confidence : 0;
          if (conf >= 0.7) continue;  // already auto-applied
          const t = entry.add || entry.replace || entry.remove || '';
          if (!t) continue;
          const id = `${ts}|${section}|${t}`;
          if (dismissed.has(id)) continue;
          collected.push({
            id, section, text: t, confidence: conf, lessonRel, ts,
            op: entry.add ? 'add' : entry.replace ? 'replace' : 'remove',
          });
        }
      }
    }
    // Newest first, dedupe by (section, text)
    const seen = new Set();
    const dedup = [];
    for (const x of collected.reverse()) {
      const key = `${x.section}|${x.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(x);
    }
    return { ok: true, pending: dedup };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('userProfile:ratify', (_e, { action, entry } = {}) => {
  try {
    if (!entry || !entry.id || !entry.section) return { ok: false, error: 'entry required' };
    const root = vault.resolveRoot();
    if (action === 'accept') {
      const userProfile = require('./lib/userProfile');
      const profile = userProfile.loadProfile(root);
      const op = entry.op || 'add';
      const diff = { [entry.section]: [{ [op]: entry.text, confidence: 1 }] };
      const result = userProfile.applyDiff(profile, diff, { minConfidence: 0 });
      const vaultName = require('path').basename(root);
      userProfile.writeProfile(root, { sections: result.sections }, vaultName);
      _addToDismissed(root, entry.id);
      return { ok: true, accepted: result.accepted };
    } else if (action === 'dismiss') {
      _addToDismissed(root, entry.id);
      return { ok: true };
    }
    return { ok: false, error: 'unknown action' };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('atlas:get', (_e, { rel } = {}) => {
  try {
    if (!rel) return null;
    const note = vault.read(rel);
    if (!note) return null;
    const fm = note.frontmatter || {};
    const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
    const idx = parseInt(fm.lesson_idx, 10);
    if (!Number.isFinite(idx)) return null;
    const p = _atlasPath(slug, idx);
    const cur = vault.readJSON(p, null);
    // boot-11 — guard note.body before .match (vault.read body is always string,
    // but defensive in case schema drifts).
    const bodyStr = typeof note.body === 'string' ? note.body : '';
    return cur || _atlasEmpty(rel, slug, idx, {
      lesson_title: fm.title || (bodyStr.match(/^# (.+)$/m) || [])[1] || '',
      learn_goal: String(fm.learn_goal || '').replace(/^"|"$/g, ''),
    });
  } catch (err) {
    console.warn('[atlas:get] failed:', err && err.message);
    return null;
  }
});

ipcMain.handle('atlas:append-turn', async (_e, { rel, role, text } = {}) => {
  if (!rel || !role || !text) return { ok: false, error: 'rel + role + text required' };
  const note = vault.read(rel);
  if (!note) return { ok: false, error: 'note not found' };
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
  const idx = parseInt(fm.lesson_idx, 10);
  if (!Number.isFinite(idx)) return { ok: false, error: 'note missing lesson_idx' };
  const lessonContext = {
    lesson_title: fm.title || (note.body.match(/^# (.+)$/m) || [])[1] || '',
    learn_goal: String(fm.learn_goal || '').replace(/^"|"$/g, ''),
  };
  const p = _atlasPath(slug, idx);
  const prev = vault.readJSON(p, null) || _atlasEmpty(rel, slug, idx, lessonContext);
  const settings = _hyphaSettings();
  let delta;
  try {
    delta = await _hyphaAgent.extractAtlasDelta({
      prevAtlas: prev,
      turnText: text,
      role,
      lessonContext,
    }, settings);
  } catch (err) {
    console.error('[atlas:append-turn] extract failed:', err && err.message);
    return { ok: false, error: 'extract failed: ' + (err && err.message || err) };
  }
  const next = _atlasMerge(prev, delta, role, prev.turn_count || 0);
  vault.writeJSON(p, next);
  _hyphaAppendEvent('atlas_turn', {
    rel, slug, idx, role,
    introduced: (delta.introduced || []).length,
    referenced: (delta.referenced || []).length,
    settled: (delta.settled_by_user || []).length,
    expected_added: (delta.expected_uncovered || []).length,
    ...(delta._debug ? { debug: delta._debug } : {}),
  });
  return { ok: true, atlas: next, delta };
});

// Hypha 金句 (Golden Quotes) — extension to ConceptAtlas. User drag-tears
// passages from tutor messages into the atlas right-rail; each quote can later
// receive a 见解 (insight) which writes back to the note's 用户灵感 section
// (Eternal Law #7 dual-layer note: 课程基础 + 用户灵感).
//
// Storage: extends atlas.json with a `quotes` array. Schema:
//   { id, text, msg_idx, role, ts, insight, insight_at }
// Click-to-edit-insight in renderer → quote:add-insight IPC → updates entry +
// appends to <slug>/<lesson>.md user-inspiration section.
ipcMain.handle('quote:add', (_e, { rel, payload } = {}) => {
  if (!rel || !payload || !String(payload.text || '').trim()) {
    return { ok: false, error: 'rel + payload.text required' };
  }
  const note = vault.read(rel);
  if (!note) return { ok: false, error: 'note not found' };
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
  const idx = parseInt(fm.lesson_idx, 10);
  if (!Number.isFinite(idx)) return { ok: false, error: 'note missing lesson_idx' };
  const lessonContext = {
    lesson_title: fm.title || (note.body.match(/^# (.+)$/m) || [])[1] || '',
    learn_goal: String(fm.learn_goal || '').replace(/^"|"$/g, ''),
  };
  const p = _atlasPath(slug, idx);
  const cur = vault.readJSON(p, null) || _atlasEmpty(rel, slug, idx, lessonContext);
  if (!Array.isArray(cur.quotes)) cur.quotes = [];
  const quoteId = 'q_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const quote = {
    id: quoteId,
    text: String(payload.text || '').trim().slice(0, 1500),
    msg_idx: Number.isFinite(payload.msg_idx) ? payload.msg_idx : null,
    role: payload.role === 'user' ? 'user' : 'tutor',
    ts: new Date().toISOString(),
    insight: '',
    insight_at: null,
  };
  // 2.5 — link this quote to atlas concepts whose terms appear inside its text.
  // Simple substring match (case-insensitive); skip terms < 2 chars to avoid
  // noise. linked_concepts persists in quote schema for chip rendering.
  try {
    const conceptTerms = (cur.concepts && typeof cur.concepts === 'object') ? Object.keys(cur.concepts) : [];
    const lower = quote.text.toLowerCase();
    quote.linked_concepts = conceptTerms.filter(t => {
      if (!t || t.length < 2) return false;
      return lower.includes(t.toLowerCase());
    }).slice(0, 6); // cap at 6 — keep chip row scannable
  } catch (_) { quote.linked_concepts = []; }
  cur.quotes.push(quote);
  cur.last_updated = new Date().toISOString();
  vault.writeJSON(p, cur);
  _hyphaAppendEvent('quote_add', { rel, slug, idx, quoteId, length: quote.text.length, role: quote.role, linked: (quote.linked_concepts || []).length });
  return { ok: true, atlas: cur, quote };
});

// 2.4 helper — normalize quote.insight (legacy string → versioned array).
// Migration is opportunistic: each call to this on a quote with string insight
// rewrites it to [{text, ts: insight_at || now}]. Returns the normalized array.
function _normalizeInsightVersions(quote) {
  if (Array.isArray(quote.insight_versions)) return quote.insight_versions;
  if (quote.insight && typeof quote.insight === 'string' && quote.insight.trim()) {
    quote.insight_versions = [{ text: quote.insight, ts: quote.insight_at || new Date().toISOString() }];
  } else {
    quote.insight_versions = [];
  }
  return quote.insight_versions;
}

ipcMain.handle('quote:add-insight', (_e, { rel, quoteId, insight } = {}) => {
  try {
    if (!rel || !quoteId) return { ok: false, error: 'rel + quoteId required' };
    const insightText = String(insight || '').trim().slice(0, 4000);
    if (!insightText) return { ok: false, error: 'empty insight' };
    const note = vault.read(rel);
    if (!note) return { ok: false, error: 'note not found' };
    const fm = note.frontmatter || {};
    const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
    const idx = parseInt(fm.lesson_idx, 10);
    if (!Number.isFinite(idx)) return { ok: false, error: 'note missing lesson_idx' };
    const p = _atlasPath(slug, idx);
    const cur = vault.readJSON(p, null);
    if (!cur || !Array.isArray(cur.quotes)) return { ok: false, error: 'no quotes' };
    const quote = cur.quotes.find(q => q.id === quoteId);
    if (!quote) return { ok: false, error: 'quote not found' };

    // 2.4 — multi-version log. Migrate legacy string insight first; then push
    // new version IF text differs meaningfully from latest. No silent overwrite.
    const versions = _normalizeInsightVersions(quote);
    const latest = versions.length ? versions[versions.length - 1].text : '';
    const isNewVersion = insightText !== latest.trim();
    const ts = new Date().toISOString();
    if (isNewVersion) {
      versions.push({ text: insightText, ts });
    }
    // Mirror latest into quote.insight + quote.insight_at for back-compat
    quote.insight = insightText;
    quote.insight_at = ts;
    cur.last_updated = ts;
    vault.writeJSON(p, cur);

    // Append to note body's 用户灵感 section ONLY when this is a new version
    // (each version logged chronologically — never overwrites prior entries).
    if (isNewVersion) {
      const today = ts.slice(0, 10);
      // boot-11 — guard quote.text + note.body (defensive against schema drift).
      const quoteText = typeof quote.text === 'string' ? quote.text : '';
      const bodyStr = typeof note.body === 'string' ? note.body : '';
      const quotedLine = quoteText.replace(/\n/g, ' ').slice(0, 320);
      const versionLabel = versions.length > 1 ? ` (v${versions.length})` : '';
      const entry = `\n*${today}*${versionLabel}\n> ${quotedLine}\n— ${insightText}\n`;
      const fmMatch = bodyStr.match(/^---[\s\S]*?---\s*\n/);
      const fmText = fmMatch ? fmMatch[0] : '';
      const bodyAfterFm = bodyStr.replace(/^---[\s\S]*?---\s*\n/, '');
      if (/(\#\#\s*用户灵感\s*\n?)/.test(bodyAfterFm)) {
        const updated = bodyAfterFm.replace(/(\#\#\s*用户灵感\s*\n?)/, (_m, h) => `${h}${entry}`);
        vault.write(rel, fmText + updated);
      } else {
        const updated = bodyAfterFm.replace(/\s*$/, '\n\n## 用户灵感\n' + entry);
        vault.write(rel, fmText + updated);
      }
    }
    _hyphaAppendEvent('quote_insight', { rel, quoteId, version: versions.length, isNewVersion });
    return { ok: true, atlas: cur };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// Phase 3.1 — Settled-Signal Goal Adaptation (Eternal Law #6 真兑现).
// After a lesson:finish writes new state.json, this IPC reads the just-finished
// lesson's atlas, computes settled_count, and (if BASIC or DEEP tier) rewrites
// the next 1-3 LOCKED lessons' learn_goal via agent.adaptLessonGoal.
//
// Architectural note (per plan): we DO NOT mutate lessonRels / lesson_idx
// (those are atlas-key dependencies). We only rewrite frontmatter learn_goal
// + title on still-locked future lessons. Same observable effect (next lesson
// teaches deeper or shallower) without breaking the DAG.
//
// v0.4.0 — ghost materialization helper. Called at EVERY exit path of the
// adapt-after-finish handler so the next ghost lesson always gets filled in
// once the user finishes the current one — regardless of whether adaptation
// itself was triggered (BASIC/DEEP) or skipped (STANDARD/no_atlas/disabled).
async function _materializeNextGhost(slug, state, justIdx, settled, settings, event = null) {
  try {
    const lessonRels = state.lessonRels || [];
    const nextIdx = justIdx + 1;
    const nextRel = lessonRels[nextIdx];
    if (!nextRel) return null;
    const nextNote = vault.read(nextRel);
    if (!nextNote) return null;
    const nextFm = nextNote.frontmatter || {};
    const isGhost = String(nextFm.ghost || '').toLowerCase() === 'true' ||
                    /\n_pending_\s*\n/.test(nextNote.body || '');
    if (!isGhost) return null;
    const slot = {
      idx: nextIdx,
      phaseId: nextFm.phase_id || (state.phases && state.phases[0] && state.phases[0].id) || 'foundations',
      phaseLabel: String(nextFm.phase_label || '').replace(/^"|"$/g, '') || 'Phase',
      phaseLessonIdx: parseInt(nextFm.phase_lesson_idx, 10) || 0,
      phaseTone: '',
    };
    if (state.phases) {
      const phaseDef = state.phases.find(p => p.id === slot.phaseId);
      if (phaseDef) slot.phaseTone = phaseDef.tone || '';
    }
    const priorLessons = [];
    for (let i = Math.max(0, nextIdx - 3); i < nextIdx; i++) {
      const r = lessonRels[i];
      if (!r) continue;
      const n = vault.read(r);
      if (!n) continue;
      const t = (n.frontmatter && n.frontmatter.title) || (n.body.match(/^# (.+)$/m) || [])[1] || `Lesson ${i + 1}`;
      const lg = String((n.frontmatter && n.frontmatter.learn_goal) || '').replace(/^"|"$/g, '');
      priorLessons.push({ idx: i, title: t, learnGoal: lg });
    }
    let sources = vault.readJSON(`${slug}/sources.json`, []) || [];
    const queryStr = `${slot.phaseLabel} ${slot.phaseTone} ${state.goal || ''}`;
    const retrievedSources = _hyphaAgent.rankSourcesBM25(sources, queryStr, 5);
    // v0.6.0/0.6.1 — propose FIRST so we know the lesson title + learnGoal.
    const next = await _hyphaAgent.proposeNextLesson({
      topic: slug,
      archetype: state.archetype || 'TECH-CONCEPT',
      slot,
      priorLessons,
      priorAtlas: settled.slice(0, 12),
      priorVariance: null,
      retrievedSources,
    }, settings);
    // v0.6.1 — per-lesson re-harvest with the LESSON-SPECIFIC query (title +
    // learnGoal), not the broad phase label. Fresh sources land in sources.json
    // for designLesson to read at chat-time. Additive; never breaks the path.
    let freshCount = 0;
    let freshChannels = { tavily: 0, citation: 0 };
    try {
      const lessonSpecificQuery = `${(next && next.title) || ''} ${(next && next.learnGoal) || ''}`.trim()
        || `${slot.phaseLabel} ${state.topic || slug}`;
      if (typeof _hyphaAgent._harvestPerLesson === 'function') {
        const newSources = await _hyphaAgent._harvestPerLesson(sources, lessonSpecificQuery, settings);
        if (Array.isArray(newSources) && newSources.length) {
          const seen = new Set((sources || []).map(s => s && s.url).filter(Boolean));
          const fresh = newSources.filter(s => s && s.url && !seen.has(s.url));
          if (fresh.length) {
            sources = [...sources, ...fresh];
            vault.writeJSON(`${slug}/sources.json`, sources);
            freshCount = fresh.length;
            freshChannels.tavily = fresh.filter(s => s.sourceType === 'web').length;
            freshChannels.citation = fresh.filter(s => s.sourceType === 'cited-ref' || s.sourceType === 'cited-by').length;
            try { _hyphaAppendEvent('per_lesson_reharvest', { slug, idx: nextIdx, added: freshCount, total: sources.length, channels: freshChannels }); } catch (_) {}
          }
        }
      }
    } catch (_) { /* re-harvest is additive; never break materialization */ }
    const today = new Date().toISOString().slice(0, 10);
    const newFmMap = { ...nextFm };
    delete newFmMap.ghost;
    newFmMap.learn_goal = JSON.stringify(next.learnGoal);
    newFmMap.date_created = today;
    newFmMap.title = JSON.stringify(next.title);
    // v0158m — propagate concept_id when proposeNextLesson emitted one.
    if (typeof next.conceptId === 'string' && next.conceptId.trim()) {
      newFmMap.concept_id = JSON.stringify(next.conceptId.trim());
    }
    const newFm = ['---', ...Object.entries(newFmMap).map(([k, v]) => `${k}: ${v}`), '---'].join('\n');
    const newBody = `${newFm}\n\n# ${next.title}\n\n## 课程基础\n\n*This lesson hasn't been taught yet. Open the Tutor to begin.*\n\n## 用户灵感\n\n`;
    vault.write(nextRel, newBody);
    _hyphaAppendEvent('lesson_materialized', { slug, idx: nextIdx, fromIdx: justIdx });
    // v0.6.1 — notify renderer of fresh sources so NoteView can flash the banner.
    if (event && freshCount > 0) {
      try {
        event.sender.send('lesson:reharvest-complete', {
          rel: nextRel,
          lessonTitle: next.title,
          freshCount,
          channels: freshChannels,
        });
      } catch (_) {}
    }
    return { idx: nextIdx, rel: nextRel, title: next.title, learnGoal: next.learnGoal };
  } catch (err) {
    console.error('[materializeNextGhost] failed:', err.message);
    return null;
  }
}

// Audit: every adaptation appended to <slug>/adaptations.jsonl with old → new.
ipcMain.handle('lessons:adapt-after-finish', async (_e, { rel } = {}) => {
  if (!rel) return { ok: false, error: 'rel required' };
  const note = vault.read(rel);
  if (!note) return { ok: false, error: 'note not found' };
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
  const justIdx = parseInt(fm.lesson_idx, 10);
  if (!Number.isFinite(justIdx)) return { ok: false, error: 'note missing lesson_idx' };

  // Honor user opt-out (state.adapt_enabled === false freezes curriculum).
  const state = vault.readJSON(`${slug}/state.json`, null);
  if (!state) return { ok: false, error: 'state.json missing' };
  const settings = _hyphaSettings();
  if (state.adapt_enabled === false) {
    // adapt is disabled; still try to materialize next ghost.
    const m = await _materializeNextGhost(slug, state, justIdx, [], settings, _e);
    return { ok: true, skipped: 'adapt_disabled', materialized: m };
  }

  // Read just-finished atlas — compute signal.
  const atlasP = _atlasPath(slug, justIdx);
  const atlas = vault.readJSON(atlasP, null);
  if (!atlas || !atlas.concepts) {
    const m = await _materializeNextGhost(slug, state, justIdx, [], settings, _e);
    return { ok: true, skipped: 'no_atlas', materialized: m };
  }

  const settled = [];
  const missing = [];
  for (const [term, c] of Object.entries(atlas.concepts)) {
    if (!c) continue;
    if (c.state === 'settled') settled.push(term);
    else if (c.state === 'introduced' || c.state === 'referenced') missing.push(term);
  }
  const settledCount = settled.length;

  // Tier classification per plan thresholds.
  let signalTier;
  let affectedCount;
  if (settledCount === 0) { signalTier = 'BASIC'; affectedCount = 2; }
  else if (settledCount >= 4) { signalTier = 'DEEP'; affectedCount = 3; }
  else {
    // STANDARD tier — no goal rewrite. Still materialize next ghost.
    const m = await _materializeNextGhost(slug, state, justIdx, settled, settings, _e);
    return { ok: true, skipped: 'standard_tier', settledCount, materialized: m };
  }

  // Identify next N still-LOCKED lessons.
  const lessonRels = state.lessonRels || [];
  const targets = [];
  for (let i = justIdx + 1; i < lessonRels.length && targets.length < affectedCount; i++) {
    const r = lessonRels[i];
    const ln = vault.read(r);
    if (!ln) continue;
    const lfm = ln.frontmatter || {};
    if (String(lfm.locked) !== 'true' && lfm.locked !== true) continue;
    // Cap adaptation_count at 2 per lesson (per plan falsifier guard).
    const adaptCount = Number(lfm.adaptation_count) || 0;
    if (adaptCount >= 2) continue;
    const titleMatch = ln.body.match(/^# (.+)$/m);
    targets.push({
      idx: i, rel: r, body: ln.body,
      title: lfm.title || (titleMatch && titleMatch[1]) || '',
      learnGoal: String(lfm.learn_goal || '').replace(/^"|"$/g, ''),
      adaptationCount: adaptCount,
    });
  }
  if (targets.length === 0) return { ok: true, skipped: 'no_locked_targets', settledCount };

  // Neighborhood for LLM context: prev = just-finished, next = target+1.
  const prev = {
    title: fm.title || (note.body.match(/^# (.+)$/m) || [])[1] || '',
    learnGoal: String(fm.learn_goal || '').replace(/^"|"$/g, ''),
  };
  // settings already declared above

  const today = new Date().toISOString().slice(0, 10);
  const adaptedTargets = [];
  for (const t of targets) {
    // next-next neighborhood for continuity preservation
    let nextOfTarget = null;
    const nextRel = lessonRels[t.idx + 1];
    if (nextRel) {
      const nn = vault.read(nextRel);
      if (nn) {
        const nfm = nn.frontmatter || {};
        nextOfTarget = {
          title: nfm.title || (nn.body.match(/^# (.+)$/m) || [])[1] || '',
          learnGoal: String(nfm.learn_goal || '').replace(/^"|"$/g, ''),
        };
      }
    }
    let result;
    try {
      result = await _hyphaAgent.adaptLessonGoal({
        currentTitle: t.title,
        currentGoal: t.learnGoal,
        signalTier,
        settledTerms: settled.slice(0, 5),
        missingTerms: missing.slice(0, 5),
        neighborhood: { prev, next: nextOfTarget },
        settings,
      });
    } catch (err) {
      result = { newGoal: t.learnGoal, newTitle: null, reason: 'adapt error: ' + err.message };
    }
    if (!result.newGoal || result.newGoal === t.learnGoal) continue;

    // Rewrite frontmatter: learn_goal + adapted flag + adaptation_count++.
    // Preserve all other fields. Use existing strip-fm-and-reprepend pattern.
    const fmText = (t.body.match(/^---[\s\S]*?---\s*\n/) || [''])[0];
    const stripped = t.body.replace(/^---[\s\S]*?---\s*\n/, '');
    // Build new frontmatter from scratch — preserve existing lines, replace learn_goal,
    // append adapted: true + adaptation_count.
    const fmLines = (fmText.match(/^[a-z_]+:.+$/gm) || []);
    const fmMap = {};
    for (const line of fmLines) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      fmMap[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    fmMap.learn_goal = JSON.stringify(result.newGoal);
    if (result.newTitle) fmMap.title = JSON.stringify(result.newTitle);
    fmMap.adapted = 'true';
    fmMap.adaptation_count = String((t.adaptationCount || 0) + 1);
    const newFm = ['---', ...Object.entries(fmMap).map(([k, v]) => `${k}: ${v}`), '---'].join('\n');
    vault.write(t.rel, newFm + '\n\n' + stripped);

    // Append to adaptations.jsonl audit log. Store oldTitle so a future
    // revert can restore both goal + title to the pre-adaptation state.
    vault.appendJSONL(`${slug}/adaptations.jsonl`, {
      ts: new Date().toISOString(),
      fromIdx: justIdx,
      affectedIdx: t.idx,
      oldGoal: t.learnGoal,
      oldTitle: t.title || null,
      newGoal: result.newGoal,
      newTitle: result.newTitle,
      signalTier,
      settledCount,
      settledTerms: settled.slice(0, 5),
      missingTerms: missing.slice(0, 5),
      reason: result.reason,
      adaptationCount: (t.adaptationCount || 0) + 1,
    });
    _hyphaAppendEvent('lesson_adapted', {
      slug, fromIdx: justIdx, affectedIdx: t.idx, signalTier, settledCount,
    });
    adaptedTargets.push({ idx: t.idx, oldGoal: t.learnGoal, newGoal: result.newGoal, reason: result.reason });
  }

  // v0.4.0 — also materialize next ghost (BASIC/DEEP path runs through here).
  const materialized = await _materializeNextGhost(slug, state, justIdx, settled, settings, _e);
  return { ok: true, signalTier, settledCount, adaptedCount: adaptedTargets.length, adapted: adaptedTargets, materialized };
});

// lesson-adaptations:list — Phase 3.3. Walks all curriculum folders, reads
// each adaptations.jsonl, returns a flat chronological feed of every
// adaptation (newest first) so ColophonView can render the audit list.
// Output: [{ slug, ts, fromIdx, affectedIdx, oldGoal, newGoal, oldTitle, newTitle,
//   reason, signalTier, settledCount, adaptationCount, reverted }].
// `reverted: true` is set if a later 'revert' entry references this affectedIdx.
ipcMain.handle('lesson-adaptations:list', () => {
  const root = vault.resolveRoot();
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const slug = e.name;
    const log = vault.readJSONL(`${slug}/adaptations.jsonl`);
    if (!Array.isArray(log) || log.length === 0) continue;
    // Track latest revert ts per affectedIdx so adapts before that revert
    // are flagged reverted = true.
    const latestRevertTs = new Map();
    for (const row of log) {
      if (row && row.type === 'revert' && Number.isFinite(row.affectedIdx) && row.ts) {
        const prev = latestRevertTs.get(row.affectedIdx);
        if (!prev || row.ts > prev) latestRevertTs.set(row.affectedIdx, row.ts);
      }
    }
    for (const row of log) {
      if (!row || row.type === 'revert') continue;
      const reverted = (() => {
        const r = latestRevertTs.get(row.affectedIdx);
        return !!(r && row.ts && r > row.ts);
      })();
      out.push({ slug, ...row, reverted });
    }
  }
  out.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return out;
});

// lesson-adaptations:revert — restore a lesson's frontmatter to its
// pre-adaptation state. Looks up EARLIEST oldGoal / oldTitle for the given
// (slug, affectedIdx), rewrites lesson .md frontmatter (learn_goal + title +
// adapted=false + adaptation_count=0), appends a 'revert' entry to the log.
ipcMain.handle('lesson-adaptations:revert', (_e, { slug, affectedIdx } = {}) => {
  if (!slug || !Number.isFinite(affectedIdx)) {
    return { ok: false, error: 'slug + affectedIdx required' };
  }
  const log = vault.readJSONL(`${slug}/adaptations.jsonl`);
  if (!Array.isArray(log) || log.length === 0) {
    return { ok: false, error: 'no adaptations log' };
  }
  const matches = log.filter(r => r && r.type !== 'revert' && r.affectedIdx === affectedIdx);
  if (matches.length === 0) return { ok: false, error: 'no adaptation found for that lesson' };
  matches.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
  const earliest = matches[0];
  const state = vault.readJSON(`${slug}/state.json`, null);
  const lessonRel = state && Array.isArray(state.lessonRels) ? state.lessonRels[affectedIdx] : null;
  if (!lessonRel) return { ok: false, error: 'lesson not found in curriculum' };
  const note = vault.read(lessonRel);
  if (!note) return { ok: false, error: 'lesson file unreadable' };
  const fmText = (note.body.match(/^---[\s\S]*?---\s*\n/) || [''])[0];
  const stripped = note.body.replace(/^---[\s\S]*?---\s*\n/, '');
  const fmLines = (fmText.match(/^[a-z_]+:.+$/gm) || []);
  const fmMap = {};
  for (const line of fmLines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    fmMap[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  if (earliest.oldGoal != null) fmMap.learn_goal = JSON.stringify(earliest.oldGoal);
  if (earliest.oldTitle) fmMap.title = JSON.stringify(earliest.oldTitle);
  fmMap.adapted = 'false';
  fmMap.adaptation_count = '0';
  const newFm = ['---', ...Object.entries(fmMap).map(([k, v]) => `${k}: ${v}`), '---'].join('\n');
  vault.write(lessonRel, newFm + '\n\n' + stripped);
  vault.appendJSONL(`${slug}/adaptations.jsonl`, {
    ts: new Date().toISOString(),
    type: 'revert',
    affectedIdx,
    restoredGoal: earliest.oldGoal,
    restoredTitle: earliest.oldTitle || null,
    revertedFromCount: matches.length,
  });
  _hyphaAppendEvent('lesson_adapt_reverted', { slug, affectedIdx, revertedFromCount: matches.length });
  return { ok: true, restoredGoal: earliest.oldGoal, restoredTitle: earliest.oldTitle || null };
});

// lesson-adaptations:weekly-summary — Phase 3.4. Returns the adaptation
// count + tier breakdown for the past 7 days, scoped to ONE curriculum
// (slug). Used by NoteView.jsx to surface "this week the curriculum was
// retuned N times" after a lesson:finish + adapt cycle. Excludes 'revert'
// log entries from the count.
ipcMain.handle('lesson-adaptations:weekly-summary', (_e, { slug } = {}) => {
  if (!slug) return { ok: false, error: 'slug required' };
  const log = vault.readJSONL(`${slug}/adaptations.jsonl`);
  if (!Array.isArray(log)) return { ok: true, count: 0, tiers: {}, recent: [] };
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = log.filter(r => {
    if (!r || r.type === 'revert') return false;
    const ts = r.ts ? Date.parse(r.ts) : 0;
    return ts >= sevenDaysAgo;
  });
  const tiers = {};
  for (const r of recent) {
    const t = r.signalTier || 'STANDARD';
    tiers[t] = (tiers[t] || 0) + 1;
  }
  recent.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return {
    ok: true,
    count: recent.length,
    tiers,
    recent: recent.slice(0, 3).map(r => ({
      ts: r.ts, affectedIdx: r.affectedIdx, signalTier: r.signalTier, reason: r.reason,
    })),
  };
});

// v0.2 — variance:get. Read the LATEST variance entry for a given lesson
// rel from `<slug>/variances.jsonl`. Returns null if no variance computed
// yet (curriculum predates v0.2 ship, or finish didn't fire compute).
// boot-11 — wrap so corrupted jsonl row returns null rather than crashing renderer.
ipcMain.handle('variance:get', (_e, { rel } = {}) => {
  try {
    if (!rel) return null;
    const note = vault.read(rel);
    if (!note) return null;
    const fm = note.frontmatter || {};
    const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
    const log = vault.readJSONL(`${slug}/variances.jsonl`);
    if (!Array.isArray(log) || log.length === 0) return null;
    const matches = log.filter(r => r && r.lessonRel === rel);
    if (matches.length === 0) return null;
    matches.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    return matches[0];
  } catch (err) {
    console.warn('[variance:get] failed:', err && err.message);
    return null;
  }
});

// v0.3 — atlas:curriculum-view. Merges all lesson atlases in a slug into
// one cross-lesson concept set + edges. Concept's "final state" = latest
// non-null state across all lessons (settled wins over referenced wins
// over introduced; drifted is preserved). Edges = pairs of concepts that
// co-occurred in the same lesson, weight = co-occurrence count.
// Powers the lacquerware mindmap (v0.3 of post-lesson studio) — the
// only visualization cuflow/OpenMAIC structurally cannot ship.
ipcMain.handle('atlas:curriculum-view', (_e, { slug } = {}) => {
  if (!slug) return { ok: false, error: 'slug required' };
  const state = vault.readJSON(`${slug}/state.json`, null);
  if (!state || !Array.isArray(state.lessonRels)) return { ok: false, error: 'curriculum not found' };
  const concepts = {};   // term → { term, state, lessonCount, lessonIdxs[], snippet, settledAt }
  const coOccur = {};    // 'a||b' (sorted) → count
  const STATE_RANK = { drifted: 0, introduced: 1, referenced: 2, settled: 3 };
  for (let idx = 0; idx < state.lessonRels.length; idx++) {
    const atlas = vault.readJSON(_atlasPath(slug, idx), null);
    if (!atlas || !atlas.concepts) continue;
    const lessonTerms = [];
    for (const [term, c] of Object.entries(atlas.concepts)) {
      if (!c) continue;
      const s = c.state || 'introduced';
      lessonTerms.push(term);
      if (!concepts[term]) {
        concepts[term] = {
          term,
          state: s,
          lessonCount: 1,
          lessonIdxs: [idx],
          snippet: (c.snippet || '').slice(0, 200),
          settledAt: s === 'settled' ? idx : null,
        };
      } else {
        const prev = concepts[term];
        prev.lessonCount += 1;
        prev.lessonIdxs.push(idx);
        if ((STATE_RANK[s] || 0) > (STATE_RANK[prev.state] || 0)) {
          prev.state = s;
          if (s === 'settled') prev.settledAt = idx;
        }
        if (!prev.snippet && c.snippet) prev.snippet = (c.snippet || '').slice(0, 200);
      }
    }
    // Pairwise co-occurrence in this lesson.
    for (let i = 0; i < lessonTerms.length; i++) {
      for (let j = i + 1; j < lessonTerms.length; j++) {
        const a = lessonTerms[i], b = lessonTerms[j];
        const key = a < b ? `${a}||${b}` : `${b}||${a}`;
        coOccur[key] = (coOccur[key] || 0) + 1;
      }
    }
  }
  const edges = Object.entries(coOccur)
    .map(([key, weight]) => {
      const [a, b] = key.split('||');
      return { a, b, weight };
    })
    .filter(e => e.weight >= 1);
  return {
    ok: true,
    slug,
    totalLessons: state.lessonRels.length,
    concepts: Object.values(concepts),
    edges,
  };
});

// v0.2 — concept-logbook:get. Per-concept biography assembled from every
// lesson's atlas in this curriculum. Returns timeline of when this concept
// was introduced, settled, and which lessons referenced it. The user clicks
// a concept in the right rail → this assembles the concept's "ship log"
// across the entire curriculum (Lung's CONCEPT_AS_VESSEL).
ipcMain.handle('concept-logbook:get', (_e, { slug, conceptId } = {}) => {
  try {
    if (!slug || !conceptId) return { ok: false, error: 'slug + conceptId required' };
    const state = vault.readJSON(`${slug}/state.json`, null);
    if (!state || !Array.isArray(state.lessonRels)) return { ok: false, error: 'curriculum not found' };
    const term = String(conceptId).toLowerCase().trim();
    const entries = [];
    for (let idx = 0; idx < state.lessonRels.length; idx++) {
      const atlasP = _atlasPath(slug, idx);
      const atlas = vault.readJSON(atlasP, null);
      if (!atlas || !atlas.concepts) continue;
      const c = atlas.concepts[term] || atlas.concepts[conceptId];
      if (!c) continue;
      const lessonRel = state.lessonRels[idx];
      const lesson = vault.read(lessonRel);
      // boot-11 — guard lesson.body access (vault.read body always string per
      // current schema, but defensive against schema drift).
      const lessonBody = lesson && typeof lesson.body === 'string' ? lesson.body : '';
      const lessonTitle = lesson
        ? (lesson.frontmatter && lesson.frontmatter.title) ||
          (lessonBody.match(/^# (.+)$/m) || [])[1] ||
          `Lesson ${idx + 1}`
        : `Lesson ${idx + 1}`;
      entries.push({
        idx,
        lessonRel,
        lessonTitle: String(lessonTitle).replace(/^"|"$/g, ''),
        state: c.state || 'introduced',
        firstSeenTurn: c.first_seen_turn || null,
        settledAtTurn: c.settled_at_turn || null,
        occurrences: c.occurrences || 0,
        snippet: (c.snippet || '').slice(0, 220),
        distilled: !!(lesson && lesson.frontmatter && lesson.frontmatter.date_distilled
                      && String(lesson.frontmatter.date_distilled).trim() !== 'null'),
      });
    }
    return { ok: true, conceptId: term, entries };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// quote:delete — remove a 金句 from atlas.quotes. Phase 2.3 (council 2026-05-01).
// If the quote had an insight, the 用户灵感 section entry STAYS (it's history;
// we don't retroactively rewrite past notes). atlas.quotes loses the row only.
ipcMain.handle('quote:delete', (_e, { rel, quoteId } = {}) => {
  try {
    if (!rel || !quoteId) return { ok: false, error: 'rel + quoteId required' };
    const note = vault.read(rel);
    if (!note) return { ok: false, error: 'note not found' };
    const fm = note.frontmatter || {};
    const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
    const idx = parseInt(fm.lesson_idx, 10);
    if (!Number.isFinite(idx)) return { ok: false, error: 'note missing lesson_idx' };
    const p = _atlasPath(slug, idx);
    const cur = vault.readJSON(p, null);
    if (!cur || !Array.isArray(cur.quotes)) return { ok: false, error: 'no quotes' };
    const before = cur.quotes.length;
    cur.quotes = cur.quotes.filter(q => q && q.id !== quoteId);
    if (cur.quotes.length === before) return { ok: false, error: 'quote not found' };
    cur.last_updated = new Date().toISOString();
    vault.writeJSON(p, cur);
    _hyphaAppendEvent('quote_delete', { rel, slug, idx, quoteId });
    return { ok: true, atlas: cur };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('atlas:edit-state', (_e, { rel, term, newState } = {}) => {
  if (!rel || !term || !newState) return { ok: false, error: 'rel + term + newState required' };
  const note = vault.read(rel);
  if (!note) return { ok: false, error: 'note not found' };
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
  const idx = parseInt(fm.lesson_idx, 10);
  if (!Number.isFinite(idx)) return { ok: false, error: 'note missing lesson_idx' };
  const p = _atlasPath(slug, idx);
  const cur = vault.readJSON(p, null);
  if (!cur || !cur.concepts || !cur.concepts[term]) return { ok: false, error: 'term not in atlas' };
  const allowed = ['introduced', 'referenced', 'settled', 'drifted'];
  if (!allowed.includes(newState)) return { ok: false, error: 'invalid state' };
  const oldState = cur.concepts[term].state;
  cur.concepts[term].state = newState;
  if (newState === 'settled' && !cur.concepts[term].settled_at_turn) {
    cur.concepts[term].settled_at_turn = cur.turn_count || 0;
  }
  cur.last_updated = new Date().toISOString();
  vault.writeJSON(p, cur);
  _hyphaAppendEvent('atlas_edit', { rel, slug, idx, term, oldState, newState });
  return { ok: true, atlas: cur };
});

// lesson:finish — graduate the current session. Two modes:
//   fresh (default)   = distill full dual-layer note (课程基础 + 用户灵感),
//                       sets frontmatter.date_distilled, marks lesson complete
//   continuation      = distill ONLY new 用户灵感 paragraph, append to existing
//                       .md preserving 课程基础, refresh date_distilled
ipcMain.handle('lesson:finish', async (_e, { rel, userInsight, sessionFile, mode } = {}) => {
  if (!rel) return { ok: false, error: 'rel required' };
  const settings = _hyphaSettings();
  const note = vault.read(rel);
  if (!note) return { ok: false, error: 'note not found' };
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
  const idx = parseInt(fm.lesson_idx, 10);
  if (isNaN(idx)) return { ok: false, error: 'note missing lesson_idx' };

  const sources = vault.readJSON(`${slug}/sources.json`, []);
  const state = vault.readJSON(`${slug}/state.json`, { mastered: [], gaps: [], lastIdx: -1, lessonRels: [] });

  // Resolve session file. If sessionFile provided, use it. Else find latest.
  let sessionRelPath;
  if (sessionFile && /^L\d+-/.test(sessionFile)) {
    sessionRelPath = `${slug}/sessions/${sessionFile}`;
  } else {
    const sessions = _listSessionsForLesson(slug, idx);
    if (sessions.length === 0) return { ok: false, error: 'no conversation yet — open Tutor first' };
    sessionRelPath = sessions[0].rel; // newest first
  }
  const sessionTurns = vault.readJSONL(sessionRelPath).filter(t => t.idx === idx);
  const metaRow = sessionTurns.find(t => t.role === 'meta') || { mode: 'fresh' };
  const effectiveMode = mode || metaRow.mode || 'fresh';

  // Transcript for distill — only user + tutor turns.
  const transcript = sessionTurns
    .filter(t => t.role === 'user' || t.role === 'tutor')
    .map(t => ({ role: t.role, content: t.text }));

  if (transcript.length === 0) return { ok: false, error: 'no conversation yet — open Tutor first' };

  const today = new Date().toISOString().slice(0, 10);
  try {
    // 2026-05-03 — recovery: if continuation mode but the existing body is
    // empty (prior fresh-finish wrote empty due to LLM/CLI failure +
    // date_distilled was still set), force fresh-mode distill so we get a
    // proper dual-layer note instead of just appending an insight to nothing.
    const existingBodyContent = note.body.replace(/^---[\s\S]*?---\s*\n?/, '').trim();
    const existingBodyEmpty = !existingBodyContent;
    let resolvedMode = effectiveMode;
    if (effectiveMode === 'continuation' && existingBodyEmpty) {
      console.warn('[lesson:finish] continuation requested but body empty — forcing fresh mode for recovery');
      resolvedMode = 'fresh';
    }
    const lessonTitle = fm.title || note.body.match(/^# (.+)$/m)?.[1] || `Lesson ${idx + 1}`;
    const distilled = await _hyphaAgent.synthesizeNote({
      topic: slug, idx, transcript, sources,
      sequence: (state.lessonRels || []).map((_r, i) => ({ idx: i, title: '', learnGoal: '' })),
      lessonTitle, learnGoal: fm.learn_goal || '',
      userInsight: userInsight || '',
      mode: resolvedMode,
      priorBody: note.body,
    }, settings);

    // 2026-05-03 — validate distilled before overwriting. Previously empty
    // returns silently wrote frontmatter-only files, leaving RECALL showing
    // "EMPTY NOTE". Refuse to overwrite on empty OR clearly truncated.
    // Loosened from "must contain dual-layer markers" because claude-cli
    // ignores structured templates (per probe-synthesizeNote test) and
    // returns its own preferred format. Content is still high-quality, just
    // not always tagged with our specific section headers.
    const distilledTrim = String(distilled || '').trim();
    if (!distilledTrim) {
      throw new Error('synthesize returned empty — refusing to overwrite note');
    }
    if (distilledTrim.length < 80) {
      throw new Error('synthesize returned suspiciously short content (' + distilledTrim.length + ' chars) — refusing to overwrite');
    }

    if (resolvedMode === 'continuation') {
      // Append-only: keep existing 课程基础, append a dated 用户灵感 paragraph.
      // distilled (in continuation mode) is just the new 灵感 paragraph(s).
      const updatedBody = note.body.replace(/(\#\#\s*用户灵感\s*\n)/, (_m, h) => {
        return `${h}\n*${today}* — ${distilled.trim()}\n\n`;
      });
      // Refresh frontmatter date_distilled so list view shows latest activity.
      const newFm = [
        '---',
        `lesson_idx: ${idx}`,
        `learn_goal: ${JSON.stringify(fm.learn_goal || '')}`,
        `locked: false`,
        `topic_slug: ${slug}`,
        `date_created: ${fm.date_created || today}`,
        `date_distilled: ${today}`,
        '---',
      ].join('\n');
      // Strip any existing frontmatter from updatedBody and re-prepend.
      const stripped = updatedBody.replace(/^---[\s\S]*?---\s*\n/, '');
      vault.write(rel, `${newFm}\n\n${stripped}`);
      // 2026-05-03 — even on continuation, ensure the next lesson is unlocked.
      // Previously continuation never touched downstream — but if the prior
      // fresh finish timed out mid-flow (CLI 90s cap), the unlock pass was
      // skipped. User retries in continuation mode; without this branch the
      // next lesson stays locked forever. Idempotent: replaces locked:true →
      // locked:false; no-op if already unlocked.
      const nextRelCont = state.lessonRels?.[idx + 1];
      if (nextRelCont) {
        const next = vault.read(nextRelCont);
        if (next) {
          const rewritten = next.body.replace(/^locked:\s*true/m, 'locked: false');
          if (rewritten !== next.body) vault.write(nextRelCont, rewritten);
        }
      }
    } else {
      // Fresh distill: full rebuild.
      const newFm = [
        '---',
        `lesson_idx: ${idx}`,
        `learn_goal: ${JSON.stringify(fm.learn_goal || '')}`,
        `locked: false`,
        `topic_slug: ${slug}`,
        `date_created: ${fm.date_created || today}`,
        `date_distilled: ${today}`,
        '---',
      ].join('\n');
      vault.write(rel, `${newFm}\n\n${distilled}\n`);

      // Unlock next lesson — only on fresh distill (continuation = revisit, no new unlock).
      const nextRel = state.lessonRels?.[idx + 1];
      if (nextRel) {
        const next = vault.read(nextRel);
        if (next) {
          const nextFmRewritten = next.body.replace(/^locked:\s*true/m, 'locked: false');
          vault.write(nextRel, nextFmRewritten);
        }
      }
    }

    // Update state.json (mastered/gaps via LLM-as-RNN). Resilient: if the
    // LLM call fails (timeout / network), fall back to previous state — we
    // STILL want to record lastIdx so the next-lesson unlock + scheduler
    // proceed. Previously a timeout here orphaned state.json at lastIdx=-1
    // even though the lesson .md was already distilled, leaving the rail
    // perpetually showing "no lesson finished".
    let newState;
    try {
      newState = await _hyphaAgent.updateState({
        state, transcript, note: distilled, idx,
        sequence: (state.lessonRels || []).map((_r, i) => ({ idx: i, title: '', learnGoal: '' })),
      }, settings);
    } catch (e) {
      console.error('[lesson:finish] updateState failed (using fallback):', e && e.message);
      newState = { ...state, mastered: state.mastered || [], gaps: state.gaps || [] };
    }
    // Always bump lastIdx (fresh OR continuation) — idempotent via Math.max.
    newState.lastIdx = Math.max(state.lastIdx ?? -1, idx);
    newState.lessonRels = state.lessonRels;

    // Lacquer Loop A1: touch concept = lesson_idx on every finish (fresh OR continuation).
    // Backfill concepts:{} for curricula created before W3.
    scheduler.initConcepts(newState);

    // Lacquer Loop A2: prediction capture. Native path = `p2-prediction` row
    // appended by llm:lesson handler when P2 was emphasized for the archetype
    // and the user submitted a real prediction (vs the tutor's prediction-prompt
    // opener). Fallback = heuristic on first user turn (covers archetypes where
    // P2 is LOW or sessions started before native ship). success boolean for A1
    // derives: score >= 0.5 → extend cure window; else halve.
    let predictionSuccess = true;
    try {
      const p2Row = sessionTurns.find(t => t.role === 'p2-prediction');
      if (p2Row) {
        scheduler.recordPrediction(newState, idx, p2Row.predicted, p2Row.actual, p2Row.delta_norm, idx);
        const score = typeof p2Row.score === 'number' ? p2Row.score : (1 - (p2Row.delta_norm || 0));
        predictionSuccess = score >= 0.5;
      } else {
        const firstUser = transcript.find(t => t.role === 'user');
        const expected = fm.learn_goal || '';
        if (firstUser && firstUser.content && expected) {
          const judged = await _hyphaAgent.scoreQuizAnswer(
            'What do you think this lesson teaches — predict before reading?',
            expected,
            'must align with the central claim or skill of the lesson',
            firstUser.content,
            settings
          );
          const delta_norm = Math.max(0, Math.min(1, 1 - judged.score));
          scheduler.recordPrediction(newState, idx, firstUser.content, expected, delta_norm, idx);
          predictionSuccess = judged.score >= 0.5;
        }
      }
    } catch (_) { /* best-effort; never block finish */ }

    // Capture cure-window state BEFORE touchConcept for diff logging
    const _conceptBefore = newState.concepts && newState.concepts[String(idx)]
      ? { layer_count: newState.concepts[String(idx)].layer_count, cure_window_ms: newState.concepts[String(idx)].cure_window_ms }
      : { layer_count: 0, cure_window_ms: 0 };
    scheduler.touchConcept(newState, idx, predictionSuccess);
    const _conceptAfter = newState.concepts[String(idx)] || {};
    // 2026-05-02 W3 visibility — emit per pedagogy.md Layer 2 substrate so
    // user can audit cure-clock evolution. Read events.jsonl to see this
    // chain's spaced-revisit signal building over time.
    _hyphaAppendEvent('concept_layered', {
      slug,
      lesson_id: idx,
      success: predictionSuccess,
      prev_layer_count: _conceptBefore.layer_count,
      new_layer_count: _conceptAfter.layer_count,
      prev_cure_window_ms: _conceptBefore.cure_window_ms,
      new_cure_window_ms: _conceptAfter.cure_window_ms,
      half_life_ms: _conceptAfter.half_life_estimate_ms,
    });

    // v0158m P6 — parse `<!-- p6: introduced concept_id=X -->` marker from
    // tutor turns BEFORE state.json write so the new concepts entry persists.
    // If found, state.concepts[X] = { introduced_at, prior_layer:'P6', ... }.
    try {
      const tutorTurnsText = sessionTurns
        .filter(t => t.role === 'tutor')
        .map(t => t.text || '')
        .join('\n');
      const p6Match = tutorTurnsText.match(/<!--\s*p6:\s*introduced\s+concept_id=([a-zA-Z0-9_\-]+)\s*-->/);
      if (p6Match && p6Match[1]) {
        const cid = p6Match[1].toLowerCase();
        const cur = newState.concepts || {};
        cur[cid] = {
          ...(cur[cid] || {}),
          introduced_at: new Date().toISOString(),
          prior_layer: 'P6',
          method: 'expose-first',
          introduced_in_lesson: idx,
          user_force_expose: false, // clear one-shot force flag
        };
        newState.concepts = cur;
        console.log(`[lesson:finish] P6 marker captured: concept_id=${cid} (lesson ${idx})`);
      }
    } catch (err) {
      console.log('[lesson:finish] P6 marker parse failed (non-fatal):', err.message);
    }

    vault.writeJSON(`${slug}/state.json`, newState);

    // v0.2 — Variance Card. Compute the just-finished lesson's drift from
    // the user's declared goal (state.goal collected at curriculum-create).
    // Diff = settled-by-user concepts vs original intent. Output appended to
    // `<slug>/variances.jsonl` (Lung's REGISTRAR_STREAM) — VarianceCard in
    // NoteView reads the latest entry for this lesson rel and renders above
    // the dual-layer note. Fresh mode only (continuation = revisit, no new
    // intent-vs-delivery vector). Fire-and-forget so finish doesn't block.
    try {
      if (effectiveMode === 'fresh' && newState.goal) {
        const atlasNow = vault.readJSON(_atlasPath(slug, idx), null);
        const settled = atlasNow && atlasNow.concepts
          ? Object.entries(atlasNow.concepts)
              .filter(([_, c]) => c && c.state === 'settled')
              .map(([term]) => term)
          : [];
        const lessonTitle = fm.title || (note.body.match(/^# (.+)$/m) || [])[1] || `Lesson ${idx + 1}`;
        const variance = await _hyphaAgent.computeVariance({
          goal: newState.goal,
          topicSlug: slug,
          delivered: settled,
          timeCommit: newState.timeCommit || 'open-ended',
          lessonTitle,
        }, settings);
        vault.appendJSONL(`${slug}/variances.jsonl`, {
          ts: new Date().toISOString(),
          idx,
          lessonRel: rel,
          ...variance,
          deliveredCount: settled.length,
          delivered: settled.slice(0, 10),
        });
      }
    } catch (err) {
      console.error('[variance] compute failed (non-fatal):', err.message);
    }

    _hyphaAppendEvent('lesson_finish', { topic: slug, idx, rel, mode: effectiveMode });

    // Creation System (P4) auto-extract — decisions + assumptions from the
    // just-finished transcript. Non-fatal: catches errors so finish never
    // stalls on extractor problems. Fires only on fresh distill (continuation
    // = same lesson re-deepen, no new decisions expected).
    try {
      if (resolvedMode === 'fresh') {
        const extractor = require('./lib/creation/extract-from-lesson');
        const r = await extractor.extractDecisionsAndAssumptions({
          slug,
          lessonIdx: idx,
          transcript,
          lessonTitle,
          learnGoal: fm.learn_goal || '',
          settings,
        });
        _hyphaAppendEvent('decisions_extracted', {
          topic: slug,
          idx,
          count: (r.decisions || []).length,
          assumptionCount: (r.assumptions || []).length,
          skipped: r.skipped || null,
        });
        // Machino-α5 — broadcast so DecisionLedgerCard refetches AFTER the
        // JSONL writes have hit disk. Replaces the finishCount race.
        _emitToRenderer('creation:decisions-extracted', {
          slug,
          lesson_idx: idx,
          count: (r.decisions || []).length,
          assumptionCount: (r.assumptions || []).length,
          skipped: r.skipped || null,
        });

        // Spark extraction (Machino-β2). Third extraction class — transferable
        // insights from this lesson onto the learner's current product. Inner
        // try keeps any spark-side failure from blocking the surrounding flow.
        try {
          const sparkResult = await extractor.extractSparks({
            slug,
            lessonIdx: idx,
            transcript,
            lessonTitle,
            learnGoal: fm.learn_goal || '',
            settings: _hyphaSettings(),
            // v0.7.1 will plumb the active product name from the curriculum's
            // creation blueprint. For now, product-spark falls back to slug.
            activeProductName: undefined,
          });
          _hyphaAppendEvent('sparks_extracted', {
            topic: slug,
            idx,
            count: (sparkResult.sparks || []).length,
            skipped: sparkResult.skipped || null,
          });
          // Machino-α5 — broadcast so ProductSparkCard refetches AFTER the
          // sparks JSONL write has hit disk.
          _emitToRenderer('creation:sparks-extracted', {
            slug,
            lesson_idx: idx,
            count: (sparkResult.sparks || []).length,
            skipped: sparkResult.skipped || null,
          });
        } catch (sparkErr) {
          console.warn('[finish-ritual] spark extraction failed (non-fatal):', sparkErr.message);
        }
      }
    } catch (err) {
      console.warn('[finish-ritual] decision extraction failed (non-fatal):', err.message);
    }

    // v0.11.0 — fire-and-forget HERMES reflection LLM call. Updates the
    // user-profile.md after each finished lesson. Per /tr 2026-05-02 v0.9.1
    // plan: closes the HERMES feedback loop. Runs in background; doesn't
    // block UI return path. All failures swallowed; reflectionLLM logs to
    // <vault>/.hypha/reflections.jsonl regardless of parse success.
    try {
      const reflectionLLM = require('./lib/reflectionLLM');
      const lessonNote = vault.read(rel);
      const fm = (lessonNote && lessonNote.frontmatter) || {};
      const body = (lessonNote && lessonNote.body) || '';
      const insightMatch = body.match(/##\s*用户灵感[\s\S]*?(?=\n##\s|$)/);
      const insightLayer = insightMatch ? insightMatch[0].replace(/^##\s*用户灵感/, '').trim() : '';
      let atlasDelta = { settled: [], drifted: [] };
      let quotes = [];
      const lessonTitle = fm.title || '';
      try {
        const atlasObj = vault.readJSON(_atlasPath(slug, idx), null);
        if (atlasObj) {
          const concepts = atlasObj.concepts || {};
          atlasDelta.settled = Object.values(concepts).filter(c => c && c.state === 'settled').map(c => c.term).filter(Boolean);
          atlasDelta.drifted = Object.values(concepts).filter(c => c && c.state === 'drifted').map(c => c.term).filter(Boolean);
          quotes = Array.isArray(atlasObj.quotes) ? atlasObj.quotes.slice(-5).map(q => q && q.text).filter(Boolean) : [];
        }
      } catch (_) {}
      const llmCall = async (sys, usr) => {
        const messages = [
          { role: 'system', content: sys },
          { role: 'user', content: usr },
        ];
        const r = await _hyphaAgent.llmJSON(messages, settings, { json: true, timeoutMs: 30000, temperature: 0.3, max_tokens: 800 });
        return (typeof r === 'string') ? r : JSON.stringify(r);
      };
      reflectionLLM.reflect({
        vaultRoot: vault.resolveRoot(),
        lessonRel: rel,
        lessonTitle,
        transcript: body.slice(-3000),
        insightLayer,
        quotes,
        atlasDelta,
        llmCall,
      }).catch(() => {});
    } catch (_) {}
    // v0158m — proactive JIT-recast of L_(n+1). Previously _materializeNextGhost
    // ran only via renderer-side `lessons:adapt-after-finish` chain (NoteView.jsx
    // → IPC → IPC), which left a window where user navigates to L_(n+1) and
    // sees ghost "pending" stub until the chain completes. Now main.js fires it
    // inline at lesson:finish (fire-and-forget); idempotent because
    // _materializeNextGhost checks isGhost first. settled[] is the atlas-settled
    // concepts, optional but improves recast quality. Failures swallowed so
    // they don't break finish.
    (async () => {
      try {
        const atlasNow = vault.readJSON(_atlasPath(slug, idx), null);
        const settledList = atlasNow && atlasNow.concepts
          ? Object.entries(atlasNow.concepts)
              .filter(([_, c]) => c && c.state === 'settled')
              .map(([term]) => term)
          : [];
        const m = await _materializeNextGhost(slug, newState, idx, settledList, settings, _e);
        if (m && m.title) {
          // toast renderer that L_(n+1) is now real — fire UI-side via a custom
          // event the chain views already listen to. Uses 'hypha:next-lesson-recast'
          // (new) so we can target a brief italic Garamond toast in NoteView.
          try {
            _e.sender.send('hypha:next-lesson-recast', {
              topic: slug,
              nextIdx: idx + 1,
              title: m.title,
              learnGoal: m.learnGoal || '',
            });
          } catch (_) {}
        }
      } catch (err) {
        console.log('[lesson:finish] JIT-recast failed (non-fatal):', err.message);
      }
    })();
    // Phase 3.1 — adapt-after-finish trigger lives renderer-side (NoteView.jsx
    // calls window.ptor.hypha.lessonsAdapt(rel) after this IPC resolves).
    // Renderer-driven keeps the call-site visible and avoids self-import.
    return { ok: true, rel, mode: effectiveMode, newState };
  } catch (err) {
    _hyphaAppendEvent('lesson_finish_error', { topic: slug, idx, error: err.message });
    return { ok: false, error: err.message };
  }
});

// v0158m — P6 user override IPCs. Two chips in lesson view (千金 marginalia
// register, no chrome) toggle these. Both write to state.concepts[concept_id]
// in the lesson's curriculum state.json.

// concept:get — read state.concepts[concept_id] entry for the curriculum that
// owns this lesson rel. Returns the entry or null. Used by NoteView to decide
// which override chip (skip vs force-expose) to render.
ipcMain.handle('concept:get', async (_e, { rel, conceptId } = {}) => {
  if (!rel || !conceptId) return null;
  try {
    const note = vault.read(rel);
    if (!note) return null;
    const fm = note.frontmatter || {};
    const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
    const state = vault.readJSON(`${slug}/state.json`, null);
    if (!state || !state.concepts) return null;
    return state.concepts[conceptId] || null;
  } catch (_) { return null; }
});

// concept:skip-prior-install — student says "I already know this concept, just probe me".
// Writes user_skipped=true → P6 will not fire on this lesson OR any future lesson
// that references the same concept_id.
ipcMain.handle('concept:skip-prior-install', async (_e, { rel, conceptId } = {}) => {
  if (!rel || !conceptId) return { ok: false, error: 'rel + conceptId required' };
  try {
    const note = vault.read(rel);
    if (!note) return { ok: false, error: 'note not found' };
    const fm = note.frontmatter || {};
    const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
    const state = vault.readJSON(`${slug}/state.json`, null);
    if (!state) return { ok: false, error: 'state.json missing' };
    const cur = state.concepts || {};
    cur[conceptId] = { ...(cur[conceptId] || {}), user_skipped: true, user_skipped_at: new Date().toISOString() };
    state.concepts = cur;
    vault.writeJSON(`${slug}/state.json`, state);
    console.log(`[concept:skip-prior-install] ${conceptId} → user_skipped=true (slug=${slug})`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// concept:force-expose — student says "lecture me on this even if state says I know".
// Writes user_force_expose=true (one-shot, cleared after current lesson finishes
// via the P6 marker capture path which sets it back to false).
ipcMain.handle('concept:force-expose', async (_e, { rel, conceptId } = {}) => {
  if (!rel || !conceptId) return { ok: false, error: 'rel + conceptId required' };
  try {
    const note = vault.read(rel);
    if (!note) return { ok: false, error: 'note not found' };
    const fm = note.frontmatter || {};
    const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
    const state = vault.readJSON(`${slug}/state.json`, null);
    if (!state) return { ok: false, error: 'state.json missing' };
    const cur = state.concepts || {};
    cur[conceptId] = { ...(cur[conceptId] || {}), user_force_expose: true, user_force_expose_at: new Date().toISOString() };
    state.concepts = cur;
    vault.writeJSON(`${slug}/state.json`, state);
    console.log(`[concept:force-expose] ${conceptId} → user_force_expose=true (slug=${slug})`);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// v0.11.0 — manual reflection trigger. Mirror of the auto-fired block in
// lesson:finish but invokable on demand (e.g. ColophonView "re-derive
// profile from this lesson" button — deferred to v0.11.1). Awaits the LLM
// call so caller can show progress.
ipcMain.handle('lesson:reflect', async (_e, { rel } = {}) => {
  if (!rel || typeof rel !== 'string') return { ok: false, error: 'rel required' };
  try {
    const reflectionLLM = require('./lib/reflectionLLM');
    const settings = _hyphaSettings();
    const lessonNote = vault.read(rel);
    if (!lessonNote) return { ok: false, error: 'lesson not found' };
    const fm = lessonNote.frontmatter || {};
    const body = lessonNote.body || '';
    const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
    const idx = parseInt(fm.lesson_idx, 10);
    const insightMatch = body.match(/##\s*用户灵感[\s\S]*?(?=\n##\s|$)/);
    const insightLayer = insightMatch ? insightMatch[0].replace(/^##\s*用户灵感/, '').trim() : '';
    let atlasDelta = { settled: [], drifted: [] };
    let quotes = [];
    if (Number.isFinite(idx)) {
      try {
        const atlasObj = vault.readJSON(_atlasPath(slug, idx), null);
        if (atlasObj) {
          const concepts = atlasObj.concepts || {};
          atlasDelta.settled = Object.values(concepts).filter(c => c && c.state === 'settled').map(c => c.term).filter(Boolean);
          atlasDelta.drifted = Object.values(concepts).filter(c => c && c.state === 'drifted').map(c => c.term).filter(Boolean);
          quotes = Array.isArray(atlasObj.quotes) ? atlasObj.quotes.slice(-5).map(q => q && q.text).filter(Boolean) : [];
        }
      } catch (_) {}
    }
    const llmCall = async (sys, usr) => {
      const messages = [
        { role: 'system', content: sys },
        { role: 'user', content: usr },
      ];
      const r = await _hyphaAgent.llmJSON(messages, settings, { json: true, timeoutMs: 30000, temperature: 0.3, max_tokens: 800 });
      return (typeof r === 'string') ? r : JSON.stringify(r);
    };
    return await reflectionLLM.reflect({
      vaultRoot: vault.resolveRoot(),
      lessonRel: rel,
      lessonTitle: fm.title || '',
      transcript: body.slice(-3000),
      insightLayer,
      quotes,
      atlasDelta,
      llmCall,
    });
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

// settings:get / settings:set — read/write data/settings.json. First-run logic
// inside _hyphaSettings() ensures defaults exist. The `app` sub-object is
// deep-merged so a partial { app: { fontSize: 'large' } } patch doesn't wipe
// the other app fields.
// boot-11 — wrap settings:get + settings:set so corrupt settings.json doesn't
// crash the renderer. Defaults from _hyphaSettings degrade gracefully internally;
// the explicit catch here guards against unexpected JSON / fs errors.
ipcMain.handle('settings:get', () => {
  try { return _hyphaSettings(); }
  catch (err) {
    console.warn('[settings:get] failed:', err && err.message);
    return {};
  }
});
ipcMain.handle('settings:set', (_e, patch) => {
  try {
    const cur = _hyphaSettings();
    // v0.6.1 — strip runtime-pinned userProfile before writing settings.json.
    // profile.json is the source of truth; pinning is a read-time convenience.
    // Without this, settings.json accumulates stale userProfile snapshots.
    const { userProfile: _pinnedProfile, ...curForWrite } = cur;
    const next = { ...curForWrite, ...(patch || {}) };
    if (patch && patch.app && typeof patch.app === 'object') {
      next.app = { ...(curForWrite.app || APP_DEFAULTS), ...patch.app };
    }
    vault.writeJSON('settings.json', next);
    return _pinnedProfile ? { ...next, userProfile: _pinnedProfile } : next;
  } catch (err) {
    console.warn('[settings:set] failed:', err && err.message);
    return _hyphaSettings();
  }
});

// providers:list — expose provider registry to renderer for the settings modal.
ipcMain.handle('providers:list', () => {
  try {
    const providers = require('./lib/providers');
    return providers.PROVIDERS;
  } catch (err) {
    console.warn('[providers:list] failed:', err && err.message);
    return [];
  }
});

// auth:open-login — open the Hypha Cloud sign-in URL in the user's default
// browser, then start a poll loop checking /v1/auth/desktop-token-pickup
// (renderer-driven). Simpler v1: just open browser; the user copies the
// generated desktop token from dashboard and pastes into colophon. No
// custom URL scheme needed; less brittle than deep-link.
ipcMain.handle('auth:open-login', async (_e, { url } = {}) => {
  const target = url || 'https://hypha.studio/login';
  try { await shell.openExternal(target); return { ok: true }; }
  catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// hypha-cloud:me — fetch current balance + free quota from server. Used by
// colophon to render live balance under the Sign-in button.
ipcMain.handle('hypha-cloud:me', async () => {
  const settings = _hyphaSettings();
  if (!settings.hyphaToken) return { ok: false, error: 'not signed in' };
  const baseURL = (settings.hyphaBaseURL || 'https://hypha.studio').replace(/\/$/, '');
  try {
    const fetchFn = (typeof fetch === 'function') ? fetch : require('node-fetch');
    const res = await fetchFn(`${baseURL}/v1/me`, {
      headers: { 'Authorization': `Bearer ${settings.hyphaToken}` },
    });
    if (res.status === 401) return { ok: false, error: 'token invalid', code: 'HYPHA_BAD_TOKEN' };
    if (!res.ok) return { ok: false, error: `server ${res.status}` };
    const data = await res.json();
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// personas:list — expose tutor persona registry for the Customize Tutor modal.
// v0.6.3 — merges built-in personas with user-authored custom personas saved
// at <vault>/data/custom-personas.json. Custom personas carry `custom: true`
// so the renderer can show a delete button on them; built-ins cannot be deleted.
ipcMain.handle('personas:list', () => {
  const personas = require('./lib/personas');
  const builtIn = (personas.PERSONAS || []).map(p => ({ ...p, custom: false }));
  let custom = [];
  try {
    if (vault.exists && vault.exists('data/custom-personas.json')) {
      const list = vault.readJSON('data/custom-personas.json', []);
      if (Array.isArray(list)) {
        custom = list.filter(p => p && p.id && p.label && p.prompt).map(p => ({
          id: String(p.id),
          label: String(p.label),
          short: String(p.short || ''),
          domain: String(p.domain || 'custom'),
          prompt: String(p.prompt),
          custom: true,
          createdAt: p.createdAt || null,
        }));
      }
    }
  } catch (_) {}
  return [...builtIn, ...custom];
});

// v0.6.3 — personas:save-custom. Append-or-update a user's own tutor persona.
// id is auto-derived from label (slugified) on create; updates by id.
// Built-in persona ids are reserved — saving with a built-in id is rejected.
ipcMain.handle('personas:save-custom', (_e, { id, label, short, prompt } = {}) => {
  const personas = require('./lib/personas');
  const trimmedLabel = String(label || '').trim();
  const trimmedPrompt = String(prompt || '').trim();
  if (!trimmedLabel) return { ok: false, error: 'label required' };
  if (!trimmedPrompt) return { ok: false, error: 'prompt required (the teaching directive)' };
  // Derive id from label if not provided. Slugify: lowercase, kebab-case.
  let personaId = String(id || '').trim() || trimmedLabel.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `custom-${Date.now()}`;
  // Reserve built-in ids — refuse to overwrite.
  const builtInIds = new Set((personas.PERSONAS || []).map(p => p.id));
  if (builtInIds.has(personaId)) {
    return { ok: false, error: `id "${personaId}" is reserved by a built-in persona — pick a different label` };
  }
  let list = [];
  try {
    if (vault.exists && vault.exists('data/custom-personas.json')) {
      list = vault.readJSON('data/custom-personas.json', []) || [];
      if (!Array.isArray(list)) list = [];
    }
  } catch (_) {}
  // Update if id exists, else append.
  const existing = list.findIndex(p => p && p.id === personaId);
  const nowIso = new Date().toISOString();
  const row = {
    id: personaId,
    label: trimmedLabel,
    short: String(short || '').trim(),
    domain: 'custom',
    prompt: trimmedPrompt,
    createdAt: existing >= 0 ? (list[existing].createdAt || nowIso) : nowIso,
    updatedAt: nowIso,
  };
  if (existing >= 0) list[existing] = row;
  else list.push(row);
  vault.writeJSON('data/custom-personas.json', list);
  _hyphaAppendEvent('persona_custom_saved', { id: personaId, label: trimmedLabel });
  return { ok: true, persona: { ...row, custom: true } };
});

// v0.6.3 — personas:delete-custom. Removes a custom persona by id. Built-ins
// rejected. If a curriculum's agent.json references the deleted id, that
// curriculum's tutor falls back to 'socratic' on next lesson (per existing
// fallback in agent.js:designLesson).
ipcMain.handle('personas:delete-custom', (_e, { id } = {}) => {
  const personas = require('./lib/personas');
  const personaId = String(id || '').trim();
  if (!personaId) return { ok: false, error: 'id required' };
  const builtInIds = new Set((personas.PERSONAS || []).map(p => p.id));
  if (builtInIds.has(personaId)) {
    return { ok: false, error: 'cannot delete built-in persona' };
  }
  let list = [];
  try {
    if (vault.exists && vault.exists('data/custom-personas.json')) {
      list = vault.readJSON('data/custom-personas.json', []) || [];
      if (!Array.isArray(list)) list = [];
    }
  } catch (_) {}
  const before = list.length;
  list = list.filter(p => p && p.id !== personaId);
  if (list.length === before) return { ok: false, error: `no custom persona with id "${personaId}"` };
  vault.writeJSON('data/custom-personas.json', list);
  _hyphaAppendEvent('persona_custom_deleted', { id: personaId });
  return { ok: true };
});

// v0.5.1 — Persona Corpus Distillation. Lifts a string-register persona
// into a structured wisdom artifact via T6_STRONG, persisted at
// vault/.persona-wisdom/<id>.md. See app/lib/personas/distill-corpus.js
// for schema + provenance rules.
ipcMain.handle('personas:distill', async (_e, payload = {}) => {
  try {
    const personaId = String(payload.personaId || payload.id || '').trim();
    const sourceTexts = Array.isArray(payload.sourceTexts) ? payload.sourceTexts : [];
    const dryRun = !!payload.dryRun;
    if (!personaId) return { ok: false, error: 'personaId required' };
    if (sourceTexts.length === 0) return { ok: false, error: 'sourceTexts required (non-empty)' };
    const distiller = require('./lib/personas/distill-corpus');
    const settings = _hyphaSettings();
    const out = await distiller.distillPersonaCorpus({ personaId, sourceTexts, settings, dryRun });
    return out;
  } catch (err) {
    _hyphaAppendEvent('persona_distill_handler_error', {
      persona_id: (payload && payload.personaId) || null,
      error: err && err.message,
    });
    return { ok: false, error: (err && err.message) || 'unknown error' };
  }
});

// personas:getWisdom — return raw markdown for a distilled persona, or
// {ok:false, error:'not_found'} when the file doesn't exist yet.
ipcMain.handle('personas:getWisdom', (_e, payload = {}) => {
  try {
    const personaId = String(payload.personaId || payload.id || '').trim();
    if (!personaId) return { ok: false, error: 'personaId required' };
    const distiller = require('./lib/personas/distill-corpus');
    const md = distiller.getPersonaWisdom(personaId);
    if (md == null) return { ok: false, error: 'not_found', personaId };
    return { ok: true, personaId, markdown: md };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'unknown error' };
  }
});

// personas:listWisdom — enumerate all distilled persona artifacts. UI
// uses this to render a "蒸馏过的 persona" pane next to the registry.
ipcMain.handle('personas:listWisdom', () => {
  try {
    const distiller = require('./lib/personas/distill-corpus');
    return { ok: true, items: distiller.listPersonaWisdom() };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'unknown error', items: [] };
  }
});

// β14 Cross-Spark Engine (Growth System §28) — find unexpected cross-archetype
// resonance for a lesson concept. Source pool = persona-wisdom + other-archetype
// lesson snippets. See `app/lib/growth/cross-spark.js`.
ipcMain.handle('cross-spark:generate', async (_e, payload = {}) => {
  const { generateCrossSparks } = require('./lib/growth/cross-spark');
  return generateCrossSparks(payload);
});
ipcMain.handle('cross-spark:list', async (_e, payload = {}) => {
  const { listCrossSparks } = require('./lib/growth/cross-spark');
  return listCrossSparks(payload);
});

// α16 Project Spine (Growth System §28 子组件 v0) — 跨课程持续追踪的"项目骨架"
// 事件流: decision / hypothesis / open-question / building-on / revisit-later。
// user-driven 记录, 非 LLM-derived。See `app/lib/growth/project-spine.js`.
ipcMain.handle('project-spine:add', async (_e, payload = {}) => {
  const { addSpineEntry } = require('./lib/growth/project-spine');
  return addSpineEntry(payload);
});
ipcMain.handle('project-spine:list', async (_e, payload = {}) => {
  const { listSpine } = require('./lib/growth/project-spine');
  return listSpine(payload);
});
ipcMain.handle('project-spine:remove', async (_e, payload = {}) => {
  const { removeSpineEntry } = require('./lib/growth/project-spine');
  return removeSpineEntry(payload);
});

// β17 Judgment Gym (Growth System §28 子组件 v0, 2026-05-16) — 判断练习场。
// 学习中遇到的 contestable claim 沉淀, 一段时间后系统拿出来让 user 重新判断
// 一次, 记录前后判断 + 理由变化。Anti-LLM-hypnosis 训练场。
// append-only jsonl + aggregate-on-read。See `app/lib/growth/judgment-gym.js`.
ipcMain.handle('judgment-gym:add', async (_e, payload = {}) => {
  const { addClaim } = require('./lib/growth/judgment-gym');
  return addClaim(payload);
});
ipcMain.handle('judgment-gym:list-open', async (_e, payload = {}) => {
  const { listOpenClaims } = require('./lib/growth/judgment-gym');
  return listOpenClaims(payload);
});
ipcMain.handle('judgment-gym:list-all', async (_e, payload = {}) => {
  const { listAllClaims } = require('./lib/growth/judgment-gym');
  return listAllClaims(payload);
});
ipcMain.handle('judgment-gym:rejudge', async (_e, payload = {}) => {
  const { rejudgeClaim } = require('./lib/growth/judgment-gym');
  return rejudgeClaim(payload);
});
ipcMain.handle('judgment-gym:get', async (_e, payload = {}) => {
  const { getClaim } = require('./lib/growth/judgment-gym');
  return getClaim(payload);
});
ipcMain.handle('judgment-gym:due', async (_e, payload = {}) => {
  const { dueForRejudge } = require('./lib/growth/judgment-gym');
  return dueForRejudge(payload);
});

// α19 Privacy Memory (Infrastructure §16 子组件 v0, 2026-05-16) — 决定不让
// 出去的话。user 在 pattern × label × category 上画一道线, scrub 会在任何
// 外发 text 之前把命中处用 `<redacted:label>` 替掉。
// vault/data/privacy-memory.jsonl 全局, ! per-slug。append-only + soft
// tombstone delete + case-insensitive substring 替换。
// log 文件 ! 记 pattern + ! 记 scrubbed text (P0 — 这是 privacy violation 边界)。
// See `app/lib/infrastructure/privacy-memory.js`.
ipcMain.handle('privacy-memory:add',    async (_e, p = {}) => require('./lib/infrastructure/privacy-memory').addRedaction(p || {}));
ipcMain.handle('privacy-memory:remove', async (_e, p = {}) => require('./lib/infrastructure/privacy-memory').removeRedaction(p || {}));
ipcMain.handle('privacy-memory:list',   async ()           => require('./lib/infrastructure/privacy-memory').listRedactions());
ipcMain.handle('privacy-memory:scrub',  async (_e, p = {}) => require('./lib/infrastructure/privacy-memory').scrubText(p || {}));
ipcMain.handle('privacy-memory:log',    async (_e, p = {}) => require('./lib/infrastructure/privacy-memory').getPrivacyLog(p || {}));

// β20 Context Packer (Infrastructure §16 子组件 v0, 2026-05-16) — per-lesson
// 显式 system-prompt token budget。priority-stack greedy pack: required 全注
// + 余额按 priority ASC 贪婪 + 装不下截尾。char/3.7 近似 token (!v0 tiktoken)。
// v0 ! 接 designLesson (集成下一波)。
// See `app/lib/infrastructure/context-packer.js`.
ipcMain.handle('context-packer:estimate', async (_e, p = {}) => ({ ok: true, tokens: require('./lib/infrastructure/context-packer').estimateTokens((p && p.text) || '') }));
ipcMain.handle('context-packer:pack',     async (_e, p = {}) => require('./lib/infrastructure/context-packer').packContext(p || {}));
ipcMain.handle('context-packer:log',      async (_e, p = {}) => require('./lib/infrastructure/context-packer').logPackDecision(p || {}));
ipcMain.handle('context-packer:history',  async (_e, p = {}) => require('./lib/infrastructure/context-packer').listPackHistory(p || {}));

// α21 Cost Budget v0 (Infrastructure §16 子组件 v0, 2026-05-16) — per-curriculum
// 月 budget 跟踪 + soft 警告 (90% warn, 110% over)。本波 backend + IPC only,
// ! UI, ! agent.js 拦截集成 (下一波)。
// See `app/lib/infrastructure/cost-budget.js`.
ipcMain.handle('cost-budget:set',     async (_e, p = {}) => require('./lib/infrastructure/cost-budget').setMonthlyBudget(p || {}));
ipcMain.handle('cost-budget:status',  async (_e, p = {}) => require('./lib/infrastructure/cost-budget').getBudgetStatus(p || {}));
ipcMain.handle('cost-budget:history', async (_e, p = {}) => require('./lib/infrastructure/cost-budget').listBudgetHistory(p || {}));
ipcMain.handle('cost-budget:record',  async (_e, p = {}) => require('./lib/infrastructure/cost-budget').recordSpend(p || {}));

// β19 Artifact Creation (Growth System §28 子组件 v0, 2026-05-16) — 学习的
// 真正信号 = 造出一个可被人用的 artifact (Track A 路径)。每节课结束后
// 用户登记一个具体 artifact 想做或已做, 系统追踪 commit/abandon/iterate 状态。
// 7 state state-machine + 7 kind enum + append-only jsonl + aggregate-on-read。
// See `app/lib/growth/artifact-creation.js`. VALID_TRANSITIONS hardcoded
// in lib (planned → in-progress|abandoned, in-progress → drafted|abandoned,
// drafted → published|abandoned|in-progress, published → committed|iterate,
// iterate → drafted; committed/abandoned terminal)。
ipcMain.handle('artifact:create',     async (_e, p = {}) => require('./lib/growth/artifact-creation').createArtifact(p || {}));
ipcMain.handle('artifact:transition', async (_e, p = {}) => require('./lib/growth/artifact-creation').transitionArtifact(p || {}));
ipcMain.handle('artifact:list',       async (_e, p = {}) => require('./lib/growth/artifact-creation').listArtifacts(p || {}));
ipcMain.handle('artifact:get',        async (_e, p = {}) => require('./lib/growth/artifact-creation').getArtifact(p || {}));
ipcMain.handle('artifact:delete',     async (_e, p = {}) => require('./lib/growth/artifact-creation').deleteArtifact(p || {}));

// 2026-05-17 Phase C — lifetime ledger IPC bundle. 5-axis weekly self-report
// per chain link + variance vs frontier_axis_p50 anchor written by planChain.
// See `app/lib/lifetime-ledger/{index,tracker,compute-variance,axes}.js`.
ipcMain.handle('lifetime:get-ledger', async (_e, { slug } = {}) => {
  try { return await require('./lib/lifetime-ledger').getLedger(slug); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('lifetime:report-week', async (_e, args = {}) => {
  try { return await require('./lib/lifetime-ledger').appendEntry(args.slug, args); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('lifetime:compute-variance', async (_e, args = {}) => {
  try { return await require('./lib/lifetime-ledger/compute-variance').varianceVsFrontier(args); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('lifetime:link-progress', async (_e, { slug, linkIdx } = {}) => {
  try { return await require('./lib/lifetime-ledger/tracker').computeProgress(slug, linkIdx); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

// 阶 3 北极星 metric (2026-05-17) — 工业 lessons.length OUT, 三柱替换:
//   mastery_concepts_ratified + spark_matured + artifacts_shipped
//
// v1.0 boot-7 (2026-05-20) — Local telemetry IPC.
//   telemetry:get-consent — { ok, consent }  reads profile.json.telemetry_consent
//   telemetry:set-consent — { ok }           writes profile.json.telemetry_consent
//   telemetry:export      — { ok, path }     prompts save dialog, writes JSON
//   telemetry:health      — { ok, score, counts }
// All operations are local. No outbound network. See `app/lib/telemetry/local-tracker.js`.
ipcMain.handle('telemetry:get-consent', () => {
  try {
    const cur = (vault.exists && vault.exists('data/profile.json'))
      ? (vault.readJSON('data/profile.json', null) || {})
      : {};
    return { ok: true, consent: cur.telemetry_consent === true };
  } catch (e) {
    return { ok: false, error: e.message, consent: false };
  }
});
ipcMain.handle('telemetry:set-consent', (_e, next) => {
  try {
    const cur = (vault.exists && vault.exists('data/profile.json'))
      ? (vault.readJSON('data/profile.json', null) || {})
      : {};
    const merged = { ...cur, telemetry_consent: !!next, updatedAt: new Date().toISOString() };
    vault.writeJSON('data/profile.json', merged);
    return { ok: true, consent: !!next };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('telemetry:export', async () => {
  try {
    const tracker = require('./lib/telemetry/local-tracker');
    const report = tracker.exportForBugReport({});
    const defaultName = `hypha-bug-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const r = await dialog.showSaveDialog({
      title: '导出错误报告 (本地)',
      defaultPath: defaultName,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, error: 'cancelled' };
    fs.writeFileSync(r.filePath, JSON.stringify(report, null, 2), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('telemetry:health', () => {
  try {
    const tracker = require('./lib/telemetry/local-tracker');
    const score = tracker.computeHealthScore();
    const counts = tracker._internal._readCounts();
    return { ok: true, score, counts };
  } catch (e) {
    return { ok: false, error: e.message, score: 1.0 };
  }
});

// v1.0 boot-8 (2026-05-20) — electron-updater integration. Replaces the
// pre-v1.0 manual GitHub poll (still kept in checkForUpdate() above as a
// graceful-degradation fallback when electron-updater isn't installed).
//   update:check          — { ok, status, version? }  silent OR manual; honors skip/cooldown only when silent
//   update:download       — { ok }                    user-consented background download
//   update:install        — { ok }                    quitAndInstall after download (consent required)
//   update:current        — { ok, version }           app.getVersion()
//   update:state          — { ok, state }             full state object for UI render
//   update:skip-version   — { ok, version }           persist skip pref to profile
//   update:remind-later   — { ok, until }             persist 24h cooldown
// All IPC return shape: { ok: boolean, ... }. Renderer subscribes to push events
// via window.ptor.update.onEvent (sent on channel 'update:event').
ipcMain.handle('update:check',        async (_e, opts = {}) => {
  try {
    const au = require('./lib/auto-updater');
    return await au.checkForUpdates(opts || {});
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:download',     async () => {
  try {
    const au = require('./lib/auto-updater');
    return await au.downloadUpdate();
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:install',      () => {
  try {
    const au = require('./lib/auto-updater');
    return au.installUpdate();
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:current',      () => {
  try {
    const au = require('./lib/auto-updater');
    return { ok: true, version: au.currentVersion() };
  } catch (e) { return { ok: false, error: e.message, version: '0.0.0' }; }
});
ipcMain.handle('update:state',        () => {
  try {
    const au = require('./lib/auto-updater');
    return { ok: true, state: au.getAutoUpdaterState() };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:skip-version', (_e, version) => {
  try {
    const au = require('./lib/auto-updater');
    return au.skipVersion(version);
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:remind-later', () => {
  try {
    const au = require('./lib/auto-updater');
    return au.remindMeLater();
  } catch (e) { return { ok: false, error: e.message }; }
});

// concept-lifecycle:* — 5-state state-machine (draft → review → ratified →
//   superseded → deprecated). append-only jsonl, aggregate-on-read。
// north-star:get      — 3-pillar 聚合 + 最近 7 天 transitions (Scene C 用).
// bandit-frontier:pick — explore-exploit 推下一节 (mastery × (1-mastery) ×
//   novelty × age_decay). 纯算法, ! LLM.
// See `app/lib/lesson-system/concept-lifecycle.js` + `app/lib/growth/north-star-metrics.js`
//   + `app/lib/growth/bandit-frontier.js`.
ipcMain.handle('concept-lifecycle:add',        async (_e, p = {}) => require('./lib/lesson-system/concept-lifecycle').addConcept(p || {}));
ipcMain.handle('concept-lifecycle:transition', async (_e, p = {}) => require('./lib/lesson-system/concept-lifecycle').transitionConcept(p || {}));
ipcMain.handle('concept-lifecycle:list',       async (_e, p = {}) => require('./lib/lesson-system/concept-lifecycle').listConcepts(p || {}));
ipcMain.handle('north-star:get',               async (_e, p = {}) => require('./lib/growth/north-star-metrics').getNorthStar(p || {}));
ipcMain.handle('bandit-frontier:pick',         async (_e, p = {}) => require('./lib/growth/bandit-frontier').pickNextLesson(p || {}));

// α17 · Book Router cache (Knowledge Source System §29 子组件 v0) — pure
// file-ops cache layer keyed by sha256(file content). Avoids re-extracting
// the same source across curricula. See `app/lib/sources/book-router-cache.js`.
// source-extractor.js integration is the next wave; this wave ships primitives
// only (lookup / store / list / purge).
ipcMain.handle('book-router:lookup', async (_e, p = {}) =>
  require('./lib/sources/book-router-cache').lookupBySha256(p)
);
ipcMain.handle('book-router:store', async (_e, p = {}) =>
  require('./lib/sources/book-router-cache').storeExtraction(p)
);
ipcMain.handle('book-router:list', async (_e, p = {}) =>
  require('./lib/sources/book-router-cache').listCachedSources(p)
);
ipcMain.handle('book-router:purge', async (_e, p = {}) =>
  require('./lib/sources/book-router-cache').purgeCacheEntry(p)
);

// agent:get — read a curriculum's tutor profile from <topic>/agent.json.
// Returns { persona: 'socratic', customInstructions: '' } as default if missing.
// boot-11 — wrap so vault read errors degrade to safe default not rejected promise.
ipcMain.handle('agent:get', (_e, { slug } = {}) => {
  try {
    if (!slug) return { persona: 'socratic', customInstructions: '' };
    const cur = vault.readJSON(`${slug}/agent.json`, null);
    if (cur && typeof cur === 'object') return cur;
    return { persona: 'socratic', customInstructions: '' };
  } catch (err) {
    console.warn('[agent:get] failed:', err && err.message);
    return { persona: 'socratic', customInstructions: '' };
  }
});

// agent:set — write a curriculum's tutor profile. Also persists optional
// displayName + avatar (data-URL string, kept on the agent.json itself so the
// curriculum carries its tutor's face with it). Existing fields preserved.
ipcMain.handle('agent:set', (_e, { slug, profile } = {}) => {
  try {
    if (!slug || !profile) return { ok: false, error: 'slug + profile required' };
    const cur = vault.readJSON(`${slug}/agent.json`, null) || {};
    const next = {
      ...cur,
      persona: profile.persona || cur.persona || 'socratic',
      customInstructions: (profile.customInstructions || '').trim(),
      updatedAt: new Date().toISOString(),
    };
    if (typeof profile.displayName === 'string') next.displayName = profile.displayName.trim();
    if (typeof profile.avatar === 'string' || profile.avatar === null) next.avatar = profile.avatar || null;
    vault.writeJSON(`${slug}/agent.json`, next);
    return { ok: true, profile: next };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// v0.6.2 — curriculum:get-language / curriculum:set-language. Per-curriculum
// LLM response language. Stored on `<slug>/state.json.language`. agent.js
// reads it via settings.curriculumLanguage (set by the IPC caller) or via
// a state.json read at prompt-build time. Empty / unset = LLM defaults to
// the topic's natural language.
ipcMain.handle('curriculum:get-language', (_e, { slug } = {}) => {
  if (!slug) return { ok: false, error: 'slug required' };
  try {
    const state = vault.readJSON(`${slug}/state.json`, null) || {};
    return { ok: true, language: state.language || '' };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});
ipcMain.handle('curriculum:set-language', (_e, { slug, language } = {}) => {
  if (!slug) return { ok: false, error: 'slug required' };
  try {
    const state = vault.readJSON(`${slug}/state.json`, null);
    if (!state) return { ok: false, error: 'state.json missing — not a curriculum slug?' };
    state.language = String(language || '').trim();  // empty string = clear override
    vault.writeJSON(`${slug}/state.json`, state);
    _hyphaAppendEvent('curriculum_language_set', { slug, language: state.language });
    return { ok: true, language: state.language };
  } catch (err) { return { ok: false, error: err.message || String(err) }; }
});

// profile:get / profile:set — user identity (name + self-introduction +
// tutor display name) for addressing the user by name, tailoring tutor
// output to their background, and letting the tutor self-introduce by a
// chosen name. Stored at <vault>/data/profile.json so it survives across
// curricula. tutorName here is the GLOBAL default; a per-curriculum
// agent.json.displayName overrides it inside that curriculum.
// v0.5.1 — profile history sidecar. Every profile:set appends a row to
// `data/profile.history.jsonl`. If profile.json ever goes missing or empty
// (user-reported symptom: "every update wipes the saved 个人介绍"), profile:get
// reconstructs the latest non-empty state from the history. Append-only ledger
// is resilient against schema migrations + folder-copy quirks + any future
// "update wipes settings" failure mode.
function _hyphaProfileRestoreFromHistory() {
  try {
    if (!vault.exists || !vault.exists('data/profile.history.jsonl')) return null;
    const raw = vault.read('data/profile.history.jsonl');
    if (!raw) return null;
    const lines = String(raw).split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row = JSON.parse(lines[i]);
        if (row && typeof row === 'object' && (row.name || row.about || row.tutorName)) {
          return { name: row.name || '', about: row.about || '', tutorName: row.tutorName || '' };
        }
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

ipcMain.handle('profile:get', () => {
  const def = { name: '', about: '', tutorName: '' };
  let cur = null;
  if (vault.exists && vault.exists('data/profile.json')) {
    cur = vault.readJSON('data/profile.json', null);
  }
  // If main file missing or all fields empty, try history sidecar.
  const isEmpty = !cur || (!cur.name && !cur.about && !cur.tutorName);
  if (isEmpty) {
    const restored = _hyphaProfileRestoreFromHistory();
    if (restored) {
      // Re-write the recovered state to the main file so subsequent reads are fast.
      try { vault.writeJSON('data/profile.json', { ...restored, updatedAt: new Date().toISOString(), recoveredFromHistory: true }); }
      catch (writeErr) {
        // boot-7: destructive vault write — TypeError surfaces drift; otherwise warn but still return restored.
        if (writeErr && writeErr.name === 'TypeError') {
          console.error('[CRITICAL][profile recover] vault.writeJSON TypeError:', writeErr.message);
        } else if (writeErr) {
          console.warn('[profile recover] vault.writeJSON failed (will retry next session):', writeErr.message);
        }
      }
      return restored;
    }
  }
  if (!cur) return def;
  return {
    name: cur.name || '',
    about: cur.about || '',
    tutorName: cur.tutorName || '',
    updatedAt: cur.updatedAt,
  };
});
ipcMain.handle('profile:set', (_e, patch = {}) => {
  // Read current — fall through to history-restore if main file lost.
  let cur = (vault.exists && vault.exists('data/profile.json'))
    ? (vault.readJSON('data/profile.json', null) || {})
    : {};
  if (!cur.name && !cur.about && !cur.tutorName) {
    const restored = _hyphaProfileRestoreFromHistory();
    if (restored) cur = { ...cur, ...restored };
  }
  const next = {
    ...cur,
    ...(typeof patch.name === 'string' ? { name: patch.name.trim() } : {}),
    ...(typeof patch.about === 'string' ? { about: patch.about } : {}),
    ...(typeof patch.tutorName === 'string' ? { tutorName: patch.tutorName.trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  vault.writeJSON('data/profile.json', next);
  // Append to history ledger — resilient against any future profile.json loss.
  try {
    if (vault.appendJSONL) {
      vault.appendJSONL('data/profile.history.jsonl', {
        ts: next.updatedAt,
        name: next.name || '',
        about: next.about || '',
        tutorName: next.tutorName || '',
      });
    }
  } catch (_) {}
  return { ok: true, profile: next };
});

// profile:probe — generate 5 calibrated MCQs for the given topic so the user
// can establish a structured baseline (overrides the prose self-introduction
// signal in classifyPriorKnowledge). v0.6.0; agent.generateProbeMCQ owned by
// TEAM D — returns array of { id, q, options:[{id,label,correct}], rationale }.
// Renderer is expected to strip `correct` flags before display, then resend
// them with the answer payload to profile:probe-submit for tally.
ipcMain.handle('profile:probe', async (_e, { topic, goal } = {}) => {
  if (!topic || !String(topic).trim()) return { ok: false, error: 'topic required' };
  const settings = _hyphaSettings();
  try {
    const questions = await _hyphaAgent.generateProbeMCQ(String(topic).trim(), String(goal || '').trim(), settings);
    if (!Array.isArray(questions) || questions.length === 0) {
      return { ok: false, error: 'probe gen returned no questions' };
    }
    return { ok: true, questions };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// profile:probe-submit — tally the user's MCQ answers (pure scoring; no LLM)
// and persist the structured baseline into data/profile.json under `probe`.
// _hyphaSettings() then automatically surfaces the probe to all classifiers via
// settings.userProfile.probe (v0.5.1 pinning). History sidecar pattern reused.
ipcMain.handle('profile:probe-submit', async (_e, { topic, goal, answers } = {}) => {
  if (!topic) return { ok: false, error: 'topic required' };
  if (!Array.isArray(answers) || answers.length === 0) {
    return { ok: false, error: 'answers required' };
  }
  const settings = _hyphaSettings();
  try {
    const result = await _hyphaAgent.scoreProbe(String(topic).trim(), String(goal || '').trim(), answers, settings);
    // Persist into profile.json. Preserve other fields (name/about/tutorName).
    let cur = (vault.exists && vault.exists('data/profile.json'))
      ? (vault.readJSON('data/profile.json', null) || {})
      : {};
    if (!cur.name && !cur.about && !cur.tutorName) {
      const restored = _hyphaProfileRestoreFromHistory();
      if (restored) cur = { ...cur, ...restored };
    }
    // v0.6.1 — store probes as a topic-keyed list (newest first, dedupe by
    // topic, keep last 5). classifyPriorKnowledge filters by topic relevance
    // (Jaccard ≥ 0.3) — applying a transformer probe to a philosophy curriculum
    // is dishonest signal. Legacy `cur.probe` kept as alias to newest for
    // back-compat with v0.6.0 callers.
    const cleanTopic = String(topic).trim();
    const newProbe = {
      topic: cleanTopic,
      goal: String(goal || '').trim(),
      ...result,
      raw_answers: answers,
      storedAt: new Date().toISOString(),
    };
    const existing = Array.isArray(cur.probes) ? cur.probes.filter(p => p && p.topic !== cleanTopic) : [];
    cur.probes = [newProbe, ...existing].slice(0, 5);
    cur.probe = newProbe;
    cur.updatedAt = newProbe.storedAt;
    vault.writeJSON('data/profile.json', cur);
    if (vault.appendJSONL) {
      try {
        vault.appendJSONL('data/profile.history.jsonl', {
          ts: cur.updatedAt,
          name: cur.name || '',
          about: cur.about || '',
          tutorName: cur.tutorName || '',
          probe: cur.probe,
        });
      } catch (_) {}
    }
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// settings:test — ping the configured LLM endpoint with a tiny prompt so the
// user can verify provider+baseURL+model+apiKey actually work before harvesting
// a full curriculum. Returns latency + sample text.
ipcMain.handle('settings:test', async () => {
  const settings = _hyphaSettings();
  const providers = require('./lib/providers');
  const cfg = providers.getProvider(settings.provider) || {};
  const t0 = Date.now();

  // CLI provider branch — spawn binary, no API key.
  if (cfg.via === 'cli' && cfg.binary) {
    return await new Promise((resolve) => {
      const { spawn } = require('node:child_process');
      const args = [];
      if (cfg.modelFlag) args.push(cfg.modelFlag, settings.model || cfg.defaultModel);
      if (cfg.promptFlag) args.push(cfg.promptFlag);
      let child;
      try {
        child = spawn(cfg.binary, args, {
          shell: process.platform === 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: 'true' },
        });
      } catch (err) {
        return resolve({ ok: false, error: 'spawn failed (binary not in PATH?): ' + err.message, latency: Date.now() - t0 });
      }
      let out = '', err = '';
      child.stdout.on('data', d => { out += d.toString('utf8'); });
      child.stderr.on('data', d => { err += d.toString('utf8'); });
      child.on('error', e => resolve({ ok: false, error: 'cli error: ' + e.message, latency: Date.now() - t0 }));
      child.on('close', code => {
        if (code !== 0) return resolve({ ok: false, error: `cli exit ${code}: ${err.slice(0, 200) || 'no stderr'}`, latency: Date.now() - t0 });
        const sample = out.trim().slice(0, 60) || '(empty)';
        resolve({ ok: true, latency: Date.now() - t0, sample, model: settings.model, viaCLI: true });
      });
      try { child.stdin.write('Reply with: ready'); child.stdin.end(); }
      catch (_) {}
    });
  }

  // API provider branch (existing).
  if (!settings.apiKey) return { ok: false, error: 'no api key set' };
  try {
    const OpenAI = require('openai');
    const c = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseURL || 'https://api.openai.com/v1',
    });
    const isGLM = (settings.provider === 'glm') || ((settings.baseURL || '').includes('bigmodel.cn'));
    const body = {
      model: settings.model || 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Reply with exactly the word: ready' }],
      max_tokens: 16,
      temperature: 0,
    };
    if (isGLM) body.thinking = { type: 'disabled' };
    let r;
    try {
      r = await c.chat.completions.create(body);
    } catch (err) {
      if (isGLM && body.thinking && err && /thinking|enable_thinking/i.test(err.message || '')) {
        delete body.thinking;
        r = await c.chat.completions.create(body);
      } else { throw err; }
    }
    const msg = r.choices && r.choices[0] && r.choices[0].message;
    let sample = ((msg && msg.content) || '').trim();
    let usedReasoning = false;
    if (!sample && msg && msg.reasoning_content) {
      sample = msg.reasoning_content.trim().slice(0, 80);
      usedReasoning = true;
    }
    return {
      ok: true,
      latency: Date.now() - t0,
      sample: sample || '(empty response)',
      model: settings.model,
      thinkingFallback: usedReasoning,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err), latency: Date.now() - t0 };
  }
});

// curriculum:clarify — generate 3-5 clarifying questions (with bubble options)
// from topic+goal+timeCommit, before harvest. UI shows the form, user answers,
// then curriculum:create runs with the clarifications baked in.
// chain:create — Hypha Lacquer Loop W7 Learning Chain Planner.
// Wraps the 5-LLM-call sequence (classifyDifficulty + classifyIntrinsicLoad
// in parallel → clarifyQuestions → classifyPriorKnowledge → planChain) plus
// the pure-function feasibility classifier. Persists chain.json to vault.
// Renderer-friendly: emits hypha:chain-progress events at each stage.
ipcMain.handle('chain:create', async (event, { goal, timeWeeks, dailyHours, priorConsistency, failedAttempts, answers, tier, customLessons, uploadedSource } = {}) => {
  if (!goal || !String(goal).trim()) return { ok: false, error: 'goal required' };
  const settings = _hyphaSettings();
  // 2026-05-05 (Appendix B) — lift legacy single-file uploadedSource if present.
  uploadedSource = require('./lib/source-extractor')._normalizeUploadedSource(uploadedSource);
  const lang = /[一-龥]/.test(String(goal)) ? 'zh' : 'en';
  const emit = (stage, extra = {}) => {
    try { event.sender.send('hypha:chain-progress', { stage, ...extra }); } catch (_) {}
    // 2026-05-17 — also fire curriculum:progress so the new design/ BuildLog
    // (which subscribes only to curriculum:progress) sees chain-phase events
    // like difficulty:set. Old onChainProgress listeners still work; this is
    // a dual-emit, not a redirect.
    try { event.sender.send('curriculum:progress', { topic: null, stage, ...extra }); } catch (_) {}
  };
  try {
    // 2026-05-03 — switched 3 parallel classifier calls → 1 unified
    // classifyAll call (saves 2 round-trips, ~10-20s on Opus). Plus
    // classifyArchetype now runs IN PARALLEL with classifyAll instead of
    // sequentially after (saves another ~10s). Net chain:create wall time
    // drops from ~70-100s to ~40-60s on a healthy provider.
    const safeAnswers = Array.isArray(answers) ? answers : [];
    emit('classifying');
    const [classified, _archetypeEarly] = await Promise.all([
      _hyphaAgent.classifyAll(goal, safeAnswers, settings),
      _hyphaAgent.classifyArchetype(goal, '', settings).catch(() => 'TECH-CONCEPT'),
    ]);
    const { difficulty: diff, intrinsic, prior } = classified;
    // 2026-05-17 阶 2 — emit difficulty:set so BuildLog surfaces the scale
    // factor that drives downstream lesson counts + harvest budgets. diff.score
    // is the LLM-classified 0-1 number from classifyAll; mult is the
    // lesson-count multiplier (0.7 + d × 1.5).
    try {
      const _d = (diff && Number.isFinite(Number(diff.score))) ? Number(diff.score) : 0.6;
      const _mult = 0.7 + _d * 1.5;
      emit('difficulty:set', {
        difficulty: _d,
        mult: Number(_mult.toFixed(2)),
        source: 'classifyAll.diff.score',
        stage: 'chain:create',
      });
    } catch (_) {}

    const feasibility = require('./lib/feasibility');
    const feasibilityInput = {
      targetDifficulty: diff.score,
      priorKnowledge: prior.score,
      timeWeeks: Number(timeWeeks) || 4,
      dailyHours: Number(dailyHours) || 2,
      intrinsicLoad: intrinsic.load,
      priorConsistency: Number(priorConsistency) || 0,
      failedAttempts: Number(failedAttempts) || 0,
    };
    const verdict = feasibility.classifyFeasibility(feasibilityInput);
    const plans = verdict.tier !== 'easy' ? feasibility.proposePlans(feasibilityInput) : null;

    emit('planning-chain');
    // v0.6.1 — pacingTier (gentle/moderate/heroic) is the user's depth choice;
    // it shapes link COUNT and pacing. Distinct from feasibility tier
    // (nearly-impossible/possible/easy) which shapes prompt tone + alternatives.
    const userPacingTier = (tier === 'gentle' || tier === 'heroic') ? tier : 'moderate';
    // v0.6.6 — archetype shapes planChain phase pattern. 2026-05-03: now
    // resolved earlier via parallel Promise.all alongside classifyAll, so we
    // reuse the result instead of re-calling. _archetypeEarly is the resolved
    // value (or 'TECH-CONCEPT' fallback if classifyArchetype rejected).
    const chainArchetype = (typeof _archetypeEarly === 'string' && _archetypeEarly) ? _archetypeEarly : 'TECH-CONCEPT';
    const chain = await _hyphaAgent.planChain(goal, {
      tier: verdict.tier,
      pacingTier: userPacingTier,
      archetype: chainArchetype,
      ratio: verdict.ratio.p50,
      gap: verdict.gap,
      missing_prerequisites: prior.missing_prerequisites,
      timeWeeks: feasibilityInput.timeWeeks,
      dailyHours: feasibilityInput.dailyHours,
      intrinsicLoad: intrinsic.load,
      pComplete: verdict.pComplete,
      lang,
    }, settings);

    // v0.3 chain-folder — diagnostic safety net per BLUEPRINT §1.1 路径熵减.
    // planChain at heroic tier × 6-10 links can produce 700+ lessons; this
    // computes role-capped + fold-merged metadata + NEEDS_REROUTE signal. UI
    // surfaces in chain header (C-4). Diagnostic-only in v0.3.0: chain.links
    // remains planChain's raw output for chain:accept compat. v0.3.1 may
    // promote `fold.folded_links` to authoritative.
    const chainFolder = require('./lib/chain-folder');
    const learningMode = ((safeAnswers || []).find(a => a && a.id === 'learning_model') || {}).value || 'Growth';
    const foldResult = chainFolder.foldChain({
      links: (chain && chain.links) || [],
      mode: learningMode,
      tier: userPacingTier,
      archetype: chainArchetype,
    });
    const foldMeta = {
      status: foldResult.status,
      mode: learningMode,
      soft_cap: chainFolder.SOFT_CAPS[learningMode] || chainFolder.SOFT_CAPS.Growth,
      hard_cap: chainFolder.HARD_CAP,
      total_before: chainFolder.totalLessons((chain && chain.links) || []),
      total_after: chainFolder.totalLessons(foldResult.folded),
      decisions: foldResult.foldDecisions,
      folded_links: foldResult.folded,
    };

    // 2026-05-17 — chain slug uses same FAT32-safe cap as _topicSlug.
    const slug = (() => {
      const cleaned = String(goal).toLowerCase().trim().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-|-$/g, '');
      if (!cleaned) return 'chain';
      const hasCJK = /[一-龥]/.test(cleaned);
      if (hasCJK && cleaned.length > 14) {
        const crypto = require('node:crypto');
        const hash = crypto.createHash('sha1').update(cleaned).digest('hex').slice(0, 8);
        return cleaned.slice(0, 12).replace(/-+$/g, '') + '-' + hash;
      }
      return cleaned.slice(0, 60);
    })();
    const chainData = {
      slug, ultimate_goal: goal, lang, created_at: new Date().toISOString(),
      tier: userPacingTier,
      // v0.6.7 — persist customLessons + uploadedSource so chain:start/advance
      // can pass them into _runCurriculumCreate per link. Previously the chain
      // forgot the user's chosen lesson count + dropped the uploaded PDF.
      customLessons: (typeof customLessons === 'number' && customLessons >= 1) ? customLessons : null,
      uploadedSource: (uploadedSource && Array.isArray(uploadedSource.files) && uploadedSource.files.length > 0) ? uploadedSource : null,
      // v0.6.8 — persist archetype so chain:accept's per-link stubs + chain:advance
      // can pick the right phase template without re-running classifyArchetype.
      archetype: chainArchetype || 'TECH-CONCEPT',
      // 2026-05-17 阶 2 — `difficulty` persisted so chain:start / chain:advance
      // can scale lesson counts per link without re-classifying. Source: LLM
      // classifyAll's diff.score (0-1) which converges with goal-guardian's
      // _estimateDifficulty heuristic on common inputs. Fallback to the
      // heuristic if LLM somehow returned an invalid score.
      inputs: {
        timeWeeks: feasibilityInput.timeWeeks,
        dailyHours: feasibilityInput.dailyHours,
        priorConsistency: feasibilityInput.priorConsistency,
        failedAttempts: feasibilityInput.failedAttempts,
        learningMode,
        difficulty: (() => {
          const d = Number(diff && diff.score);
          if (Number.isFinite(d) && d >= 0 && d <= 1) return d;
          try { return require('./lib/creation/goal-guardian')._estimateDifficulty(goal); }
          catch (_) { return 0.6; }
        })(),
      },
      classifications: { difficulty: diff, intrinsic, prior },
      questionnaire: safeAnswers,
      feasibility: verdict,
      plans, chain,
      fold: foldMeta,
    };
    // v0.6.7 — flag the chain's vault folder as a meta directory so VaultTree
    // can hide it (or render specially). Empty 0-node folders confuse users.
    chainData.is_chain_meta = true;
    vault.writeJSON(`${slug}/chain.json`, chainData);

    emit('done', { slug });

    // boot-6 (2026-05-20) — surface NEEDS_REROUTE at the envelope level.
    // Before: foldResult.status was buried in chainData.fold.status; the
    // renderer (screen-chain-plan.jsx) ignored it and showed the happy-path
    // Accept button even when total lessons > HARD_CAP. Now we lift the
    // signal into the IPC envelope w/ three actionable reroute_options so
    // the UI can branch without re-walking nested data. envelope.ok stays
    // true (the chain.json is still persisted + recoverable); the renderer
    // chooses between accept / refuse / propose-prereqs based on needs_reroute.
    const envelope = { ok: true, slug, data: chainData };
    if (foldResult && foldResult.status === 'NEEDS_REROUTE') {
      console.warn(`[chain:create] NEEDS_REROUTE — slug=${slug} total=${foldMeta.total_after} > HARD_CAP=${chainFolder.HARD_CAP}`);
      envelope.needs_reroute = true;
      envelope.reroute_options = [
        {
          id: 'split-prereq',
          label: '拆分前置链 — 先掌握基础, 再回到当前目标',
          ipc: 'chain:propose-prereqs',
          rationale: `当前 ${foldMeta.total_after} 节超过 HARD_CAP ${chainFolder.HARD_CAP}; 推荐先走前置链.`,
        },
        {
          id: 'lower-density',
          label: '降低课时密度 — 让 HYPHA 重排, 每阶段更少节',
          ipc: 'chain:refuse',
          rationale: '保留目标, 重新规划以收敛在 HARD_CAP 之内.',
        },
        {
          id: 'accept-partial',
          label: '仍然接受 — 我了解这超过推荐范围',
          ipc: 'chain:accept',
          rationale: '锁定当前计划, 进入第一阶段; HYPHA 不再阻拦.',
        },
      ];
      envelope.reroute_reason = {
        total_after: foldMeta.total_after,
        total_before: foldMeta.total_before,
        hard_cap: chainFolder.HARD_CAP,
        soft_cap: foldMeta.soft_cap,
        mode: foldMeta.mode,
      };
    }
    return envelope;
  } catch (err) {
    emit('error', { error: err.message });
    return { ok: false, error: err.message };
  }
});

// v0.5.2 — chain:accept. Renderer fires this after the user commits to a chain
// plan via the Accept button. Behavior:
//   1. Persist a covenant.json snapshot (audit trail of what the user accepted).
//   2. Build curriculum:create args from chain.links[0] (topic = link.topic,
//      goal = link.exit_criterion, timeCommit derived from duration_weeks).
//   3. Drive _runCurriculumCreate directly so the first link materializes
//      end-to-end — no double IPC round-trip.
//   4. Write links-state.json: idx 0 = active (just created); rest = pending
//      ghosts that future chain-link transitions will materialize.
function _mapWeeksToTimeCommit(weeks) {
  const w = Number(weeks) || 0;
  if (w <= 2) return 'week';
  if (w <= 6) return 'month';
  if (w <= 10) return 'two-month';
  if (w <= 16) return 'quarter';
  return 'open';
}

// v0.6.9 — role-aware proportional lesson count. Earlier prerequisite links
// stay lean; core links go deeper; ultimate (the user's actual goal) goes
// deepest. User 2026-05-02 reported uniform sizing as wrong: "越后面节数要
// 越多啊". Multipliers: prereq 1.0, core 1.5, ultimate 2.5 (over the
// duration-derived baseline). Floor lifted from 6 → 25 since chain links
// are substantive, not 6-lesson micro courses.
//
// 2026-05-17 阶 1 fix — Growth mode lifts the 200 ceiling. EXAM = closed-form
// 200 × 1.5h = 300h ≈ 150 days @ 2h/day = physical ceiling, retain 200 cap.
// GROWTH = no deadline, 6700 lesson at novice→0.95 mastery (per LEO axiom),
// 200 cap = 3% truncation. Use 999999 sentinel (effectively unbounded). Real
// "infinite" pattern in 阶 3 = bandit-frontier generates next lesson on demand
// rather than batching all upfront — this fix unblocks the chain-stub planning
// stage so 365-day chains don't silently flatten to 200.
//
// Formula: round(duration_weeks × 7 × dailyHours / hours_per_lesson × tier_mult × role_mult)
// 2026-05-17 阶 2 — _perLinkLessonCount / _resolveLessonsForLink moved to
// app/lib/lesson-count.js so the smoke test (app/scripts/_dev_verify_
// difficulty_scaling.js) can require them without booting Electron. Same
// formula + same Growth/Exam caps; difficulty (0-1) added as final arg with
// default 0.6. See lesson-count.js header for the difficultyMult derivation.
const _lessonCount = require('./lib/lesson-count');
function _capForLearningMode(learningMode) {
  return _lessonCount._capForLearningMode(learningMode);
}
function _perLinkLessonCount(durationWeeks, dailyHours, tier, role, learningMode, difficulty) {
  return _lessonCount.perLinkLessonCount(durationWeeks, dailyHours, tier, role, learningMode, difficulty);
}
function _resolveLessonsForLink(link, dailyHours, tier, learningMode, difficulty) {
  return _lessonCount.resolveLessonsForLink(link, dailyHours, tier, learningMode, difficulty);
}

// v0.6.5 — chain:accept now LAZY-COMMITS (no generation). User flow per
// 2026-05-02 feedback: "I want accept ≠ generate; the welcome form's
// continue is the canonical trigger that uses the blueprint."
//
// Old behavior generated the first link's curriculum immediately, racing
// against the welcome form's own continue button → contradictory output.
// Now: accept persists covenant + links-state (all pending, no active),
// returns the chain context. Welcome form listens for hypha:chain-committed,
// switches into chain-mode, and its continue button fires chain:start to
// activate the first link.
ipcMain.handle('chain:accept', async (event, { slug, covenantSnapshot } = {}) => {
  if (!slug || !String(slug).trim()) return { ok: false, error: 'slug required' };
  try {
    const chain = vault.readJSON(`${slug}/chain.json`, null);
    if (!chain || !Array.isArray(chain.chain && chain.chain.links)) {
      return { ok: false, error: 'no chain plan found at slug' };
    }
    const links = chain.chain.links;
    if (!links.length) return { ok: false, error: 'chain has zero links' };

    // 1. Persist covenant snapshot — audit trail of what the user accepted.
    vault.writeJSON(`${slug}/covenant.json`, {
      ...(covenantSnapshot || {}),
      acceptedAt: (covenantSnapshot && covenantSnapshot.acceptedAt) || new Date().toISOString(),
      chainSlug: slug,
      chainSnapshot: chain,
    });

    // 2. Persist links-state with ALL pending. Welcome form's continue
    //    button (or chain:start IPC) activates link 0 when user proceeds.
    //    v0.6.7 — pre-derive each link's slug here so VaultTree can show
    //    placeholder ghost folders for ALL links (not just link 0). User sees
    //    the chain shape immediately instead of "where are my N courses?".
    const linksState = links.map((link, idx) => ({
      idx,
      slug: _topicSlug(link.topic || `link-${idx + 1}`),
      status: 'pending',
      topic: link.topic || '',
      goal: link.exit_criterion || '',
      duration_weeks: link.duration_weeks || null,
      lessons_count: (Number.isFinite(Number(link.lessons_count)) && Number(link.lessons_count) >= 20) ? Number(link.lessons_count) : null,
      role: link.role || null,
    }));
    vault.writeJSON(`${slug}/links-state.json`, { links: linksState, updatedAt: new Date().toISOString() });
    // v0.6.7+v0.6.8 — pre-create stub folders for chain links 1..N so the user
    // sees the full chain shape in vault tree. Each stub gets the EXPECTED
    // lesson count (computed via same formula chain:advance will use) as
    // ghost-stub lessons. This way altman-startup-playbook shows "16 lessons"
    // not "1", reflecting the real shape — the user reads the real plan.
    // Link 0's real curriculum overwrites its stub when chain:start runs.
    // intentional-placeholder: these stub folders ARE the complete v0.6.8
    // chain-visibility feature. The "placeholder" naming matches v0.4.0's
    // ghost-stub primitive. chain:advance cleans + regenerates per-link.
    const dailyHoursForStubs = (chain.inputs && chain.inputs.dailyHours) || 2;
    const archetypeForStubs = chain.archetype || 'TECH-CONCEPT';
    // 2026-05-17 阶 1 — thread learningMode into stub generation so Growth-mode
    // chains don't silently flatten to the 200 cap.
    const learningModeForStubs = (chain.inputs && chain.inputs.learningMode) || 'Exam';
    // 2026-05-17 阶 2 — difficulty threaded into stub generation so high-
    // difficulty chains see proportionally larger ghost-stub lesson counts.
    const difficultyForStubs = (chain.inputs && Number.isFinite(Number(chain.inputs.difficulty)))
      ? Number(chain.inputs.difficulty)
      : 0.6;
    // v0.6.9 — pull each link's lessons_count from the LLM-planned chain.json
    // so stub counts match what chain:advance will actually generate. Falls
    // back to role-aware _perLinkLessonCount if LLM didn't provide.
    const planLinks = (chain.chain && Array.isArray(chain.chain.links)) ? chain.chain.links : [];
    for (let i = 1; i < linksState.length; i++) {
      const lk = linksState[i];
      try {
        if (!vault.exists || vault.exists(`${lk.slug}/state.json`)) continue;
        const planLink = planLinks[i] || {};
        const expectedLessons = _resolveLessonsForLink({
          role: lk.role || planLink.role,
          lessons_count: planLink.lessons_count,
          duration_weeks: lk.duration_weeks,
        }, dailyHoursForStubs, chain.tier || 'moderate', learningModeForStubs, difficultyForStubs);
        const today = new Date().toISOString().slice(0, 10);
        const lessonRels = [];
        // Pre-create N ghost-stub lesson files so the folder count matches
        // what chain:advance will generate. Filename pattern -pending.md so
        // chain:advance can clean these up before writing real lessons.
        for (let j = 0; j < expectedLessons; j++) {
          const idxStr = String(j).padStart(2, '0');
          const lessonRel = `${lk.slug}/${idxStr}-pending.md`;
          const fm = [
            '---',
            `lesson_idx: ${j}`,
            `learn_goal: ${JSON.stringify(`pending — chain link ${i + 1}/${linksState.length}: ${lk.topic}`)}`,
            `locked: true`,
            `topic_slug: ${lk.slug}`,
            `date_created: ${today}`,
            `date_distilled: null`,
            `phase_id: pending`,
            `phase_label: ${JSON.stringify('Pending chain link')}`,
            `phase_lesson_idx: ${j}`,
            `ghost: true`,
            `chain_placeholder: true`,
            '---',
          ].join('\n');
          const body = `${fm}\n\n# (pending — link ${i + 1}/${linksState.length}, lesson ${j + 1}/${expectedLessons})\n\n_pending_\n\nThis lesson activates when you finish link ${i}. Topic: ${lk.topic}\n`;
          vault.write(lessonRel, body);
          lessonRels.push(lessonRel);
        }
        // state.json so VaultTree can group + sort by chainLinkIdx + render
        // the parent "chain: <ultimate_goal>" header.
        vault.writeJSON(`${lk.slug}/state.json`, {
          chainSlug: slug,
          chainLinkIdx: i,
          chainPlaceholder: true,
          chainUltimateGoal: chain.ultimate_goal || '',
          chainTotalLinks: linksState.length,
          mastered: [], gaps: [],
          preferences: { level: 'intermediate' },
          goal: lk.goal,
          timeCommit: 'custom',
          customLessons: expectedLessons,
          tier: chain.tier || 'moderate',
          archetype: archetypeForStubs,
          phases: [],
          lessonRels,
        });
      } catch (e) {
        // v0.11.1 — log instead of swallowing. Per /tr 2026-05-02 chain
        // truncation diagnosis: silent failure here was the smoking gun for
        // user-reported "chain shows 1/5 but only 2 folders visible". Errors
        // now go to events.jsonl + console for investigation; repair IPC
        // (chain:repair-stubs) can re-run stub creation idempotently.
        _hyphaAppendEvent('chain_stub_error', { slug, linkSlug: lk.slug, linkIdx: i, error: String(e && e.message || e) });
        try { console.error('[chain:accept] stub creation failed for link', lk.slug, e && e.message); } catch (_) {}
      }
    }
    // Stamp link 0's chain context too — chain:start will refresh state.json
    // but the stub here lets VaultTree group link 0 from the moment of accept.
    try {
      if (linksState[0] && linksState[0].slug) {
        const link0Slug = linksState[0].slug;
        const existing0 = vault.exists(`${link0Slug}/state.json`)
          ? (vault.readJSON(`${link0Slug}/state.json`, {}) || {})
          : {};
        existing0.chainSlug = slug;
        existing0.chainLinkIdx = 0;
        existing0.chainUltimateGoal = chain.ultimate_goal || '';
        existing0.chainTotalLinks = linksState.length;
        vault.writeJSON(`${link0Slug}/state.json`, existing0);
      }
    } catch (_) {}
    _hyphaAppendEvent('chain_committed', { chainSlug: slug, linkCount: links.length });

    return {
      ok: true,
      mode: 'committed',
      chainSlug: slug,
      links: linksState,
      ultimate_goal: chain.ultimate_goal || '',
      tier: chain.tier || 'moderate',
      // v0.6.4-back-compat fields (renderer may still read these on success):
      firstSlug: null,
      lessonRel: null,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// v0.11.1 — chain:repair-stubs. Idempotent re-creation of missing chain link
// stub folders. Per /tr 2026-05-02 chain truncation diagnosis: chain:accept's
// stub-creation loop swallowed errors silently, leaving partial chains with
// "1/5" header but only N actual folders. This IPC walks the chain meta-
// folder's links-state.json + chain.json, verifies each link has a state.json
// with chainSlug stamped, and re-runs the stub-creation logic for any missing
// links. Auto-fired by VaultTree on mount when g.folders.length < g.totalLinks.
//
// Returns: { ok, repaired: [linkSlugs], errors: [...] }. Failures still
// non-fatal (best-effort repair); each error is logged to events.jsonl.
ipcMain.handle('chain:repair-stubs', async (_e, { chainSlug } = {}) => {
  if (!chainSlug || typeof chainSlug !== 'string') return { ok: false, error: 'chainSlug required' };
  try {
    const slug = chainSlug.trim();
    const linksState = vault.readJSON(`${slug}/links-state.json`, null);
    const chain = vault.readJSON(`${slug}/chain.json`, null);
    if (!linksState || !Array.isArray(linksState) || !chain) {
      return { ok: false, error: 'chain meta-folder not found or unreadable' };
    }
    const planLinks = (chain.chain && Array.isArray(chain.chain.links)) ? chain.chain.links : [];
    const dailyHoursForStubs = chain.dailyHours || 0.5;
    const archetypeForStubs = chain.archetype || 'TECH-CONCEPT';
    // 2026-05-17 阶 1 — thread learningMode for stub repair too.
    const learningModeForStubs = (chain.inputs && chain.inputs.learningMode) || 'Exam';
    // 2026-05-17 阶 2 — difficulty propagates to repair too.
    const difficultyForStubs = (chain.inputs && Number.isFinite(Number(chain.inputs.difficulty)))
      ? Number(chain.inputs.difficulty)
      : 0.6;
    const repaired = [];
    const errors = [];
    for (let i = 1; i < linksState.length; i++) {
      const lk = linksState[i];
      if (!lk || !lk.slug) continue;
      try {
        if (vault.exists(`${lk.slug}/state.json`)) continue;
        const planLink = planLinks[i] || {};
        const expectedLessons = _resolveLessonsForLink({
          role: lk.role || planLink.role,
          lessons_count: planLink.lessons_count,
          duration_weeks: lk.duration_weeks,
        }, dailyHoursForStubs, chain.tier || 'moderate', learningModeForStubs, difficultyForStubs);
        const today = new Date().toISOString().slice(0, 10);
        const lessonRels = [];
        for (let j = 0; j < expectedLessons; j++) {
          const idxStr = String(j).padStart(2, '0');
          const lessonRel = `${lk.slug}/${idxStr}-pending.md`;
          const fm = [
            '---',
            `lesson_idx: ${j}`,
            `learn_goal: ${JSON.stringify(`pending — chain link ${i + 1}/${linksState.length}: ${lk.topic}`)}`,
            `locked: true`,
            `topic_slug: ${lk.slug}`,
            `date_created: ${today}`,
            `date_distilled: null`,
            `phase_id: pending`,
            `phase_label: ${JSON.stringify('Pending chain link')}`,
            `phase_lesson_idx: ${j}`,
            `ghost: true`,
            `chain_placeholder: true`,
            '---',
          ].join('\n');
          const body = `${fm}\n\n# (pending — link ${i + 1}/${linksState.length}, lesson ${j + 1}/${expectedLessons})\n\n_pending_\n\nThis lesson activates when you finish link ${i}. Topic: ${lk.topic}\n`;
          vault.write(lessonRel, body);
          lessonRels.push(lessonRel);
        }
        vault.writeJSON(`${lk.slug}/state.json`, {
          chainSlug: slug,
          chainLinkIdx: i,
          chainPlaceholder: true,
          chainUltimateGoal: chain.ultimate_goal || '',
          chainTotalLinks: linksState.length,
          mastered: [], gaps: [],
          preferences: { level: 'intermediate' },
          goal: lk.goal,
          timeCommit: 'custom',
          customLessons: expectedLessons,
          tier: chain.tier || 'moderate',
          archetype: archetypeForStubs,
          phases: [],
          lessonRels,
        });
        repaired.push(lk.slug);
      } catch (e) {
        errors.push({ linkSlug: lk.slug, linkIdx: i, error: String(e && e.message || e) });
        _hyphaAppendEvent('chain_stub_error', { slug, linkSlug: lk.slug, linkIdx: i, error: String(e && e.message || e), source: 'repair' });
      }
    }
    if (repaired.length > 0) {
      _hyphaAppendEvent('chain_stubs_repaired', { slug, count: repaired.length, links: repaired });
    }
    return { ok: true, repaired, errors };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// v0.5.2 — chain:refuse. 2-strike refusal model:
//   - 1st refuse with reason/checklistFlags → re-run planChain with the
//     refusal context prepended to the goal so the LLM sees the user's
//     objection and reshapes the plan. chain.refused_once = true.
//   - 2nd refuse (chain.refused_once=true AND no reason AND no checklistFlags
//     → user clicked Refuse a second time without filling the form): delete
//     the slug entirely. The renderer then closes the modal.
ipcMain.handle('chain:refuse', async (_e, { slug, reason, checklistFlags } = {}) => {
  if (!slug || !String(slug).trim()) return { ok: false, error: 'slug required' };
  try {
    const chain = vault.readJSON(`${slug}/chain.json`, null);
    if (!chain) return { ok: false, error: 'no chain' };

    const flags = Array.isArray(checklistFlags) ? checklistFlags.filter(Boolean) : [];
    const reasonText = (typeof reason === 'string' && reason.trim()) ? reason.trim() : '';
    const submittedNothing = !reasonText && flags.length === 0;

    // 2nd-strike cancellation: refused_once flag set AND user submitted no
    // new context → cancel + delete the slug.
    if (chain.refused_once === true && submittedNothing) {
      try { vault.del(slug); }
      catch (delErr) {
        // boot-7: destructive vault op — TypeError surfaces drift, other errors logged.
        if (delErr && delErr.name === 'TypeError') {
          console.error('[CRITICAL][chain 2nd-strike] vault.del TypeError:', delErr.message, 'slug=', slug);
        } else if (delErr) {
          console.warn('[chain 2nd-strike] vault.del cleanup failed:', delErr.message);
        }
      }
      return { ok: true, mode: 'cancelled' };
    }

    // 1st-strike (or any subsequent submission with reason): re-run planChain.
    const settings = _hyphaSettings();
    const cls = chain.classifications || {};
    const verdict = chain.feasibility || {};
    const lang = chain.lang || (/[一-龥]/.test(String(chain.ultimate_goal || '')) ? 'zh' : 'en');

    // Compose a refusal-aware goal so planChain sees the user's objection
    // verbatim. Plain prepend (per plan §178): explicit, easy to tune later.
    const refusalParts = [];
    if (reasonText) refusalParts.push(`reason: ${reasonText}`);
    if (flags.length) refusalParts.push(`flagged: ${flags.join(', ')}`);
    const refusalAnnotation = refusalParts.length
      ? `[USER REFUSED PRIOR PLAN — ${refusalParts.join('; ')}] `
      : '';
    const newGoal = refusalAnnotation + String(chain.ultimate_goal || '');

    const newPlan = await _hyphaAgent.planChain(newGoal, {
      tier: verdict.tier,
      ratio: verdict.ratio && verdict.ratio.p50,
      gap: verdict.gap,
      missing_prerequisites: (cls.prior && cls.prior.missing_prerequisites) || [],
      timeWeeks: (chain.inputs && chain.inputs.timeWeeks) || 4,
      dailyHours: (chain.inputs && chain.inputs.dailyHours) || 2,
      intrinsicLoad: (cls.intrinsic && cls.intrinsic.load) || 'med',
      pComplete: verdict.pComplete,
      lang,
    }, settings);

    const updated = {
      ...chain,
      chain: newPlan,
      refused_once: true,
      refusal_history: [
        ...(Array.isArray(chain.refusal_history) ? chain.refusal_history : []),
        { ts: new Date().toISOString(), reason: reasonText || null, checklistFlags: flags },
      ],
      updated_at: new Date().toISOString(),
    };
    vault.writeJSON(`${slug}/chain.json`, updated);

    return { ok: true, mode: 'reason-recorded', newPlan: updated };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// v0.6.1 — chain:advance. Renderer fires this when user finishes the last
// lesson of the current chain link and clicks "advance →". Behavior:
//   1. Read links-state.json + chain.json. Find the active link.
//   2. Mark active → 'done'. If no next link → return { ok, completed: true }.
//   3. Build curriculum-create args from chain.links[activeIdx + 1].
//   4. Drive _runCurriculumCreate (forwards chain.tier). On failure, roll
//      back the link state so the user can retry.
//   5. Stamp the new curriculum's state.json with chainSlug + linkIdx so
//      NoteView's chain banner can render the new position.
//   6. Persist links-state.json with active → done, next → active.
// v0.6.5 — chain:start. After chain:accept (lazy commit), the welcome form's
// continue button fires this IPC to actually run the curriculum pipeline for
// link[0]. Stamps the resulting curriculum's state.json with chainSlug + linkIdx
// so NoteView's chain banner renders, and updates links-state.json so link 0
// flips pending → active.
ipcMain.handle('chain:start', async (event, { chainSlug } = {}) => {
  if (!chainSlug || !String(chainSlug).trim()) return { ok: false, error: 'chainSlug required' };
  try {
    const chain = vault.readJSON(`${chainSlug}/chain.json`, null);
    const linksState = vault.readJSON(`${chainSlug}/links-state.json`, null);
    if (!chain || !chain.chain || !Array.isArray(chain.chain.links)) {
      return { ok: false, error: 'chain.json missing or malformed' };
    }
    if (!linksState || !Array.isArray(linksState.links)) {
      return { ok: false, error: 'links-state.json missing — chain not committed?' };
    }
    // Idempotency: if link 0 is already active or done, return what's there.
    const link0State = linksState.links[0];
    if (link0State && link0State.status === 'active' && link0State.slug) {
      // MEOW REGRESSION fix 2026-05-17 — backfill startedAt for v0 chains
      // started before Phase C shipped (no startedAt was stamped then). One-
      // shot: stamps current time so wall-clock variance kicks in from now.
      // Better than never; existing entries before this point lose ~0 weeks
      // of elapsed signal but band is supportive not punitive.
      if (!link0State.startedAt) {
        link0State.startedAt = new Date().toISOString();
        linksState.updatedAt = new Date().toISOString();
        vault.writeJSON(`${chainSlug}/links-state.json`, linksState);
      }
      return {
        ok: true,
        firstSlug: link0State.slug,
        lessonRel: link0State.lessonRel || null,
        alreadyStarted: true,
      };
    }
    const firstLink = chain.chain.links[0];
    if (!firstLink) return { ok: false, error: 'chain has no first link' };
    const firstTopic = firstLink.topic || (chain.ultimate_goal || chainSlug);
    const firstGoal = firstLink.exit_criterion || '';
    // v0.6.7+v0.6.9 — proportional + role-aware lesson count + forward
    // uploadedSource so chain links honor user's tier + reuse uploaded PDF.
    const dailyHours = (chain.inputs && chain.inputs.dailyHours) || 2;
    // 2026-05-17 阶 2 — chain.inputs.difficulty (set by chain:create) cascades
    // into per-link lesson sizing. Falls back to 0.6 neutral on legacy chains.
    const difficultyForLink = (chain.inputs && Number.isFinite(Number(chain.inputs.difficulty)))
      ? Number(chain.inputs.difficulty)
      : 0.6;
    const customLessonsForLink = _resolveLessonsForLink(firstLink, dailyHours, chain.tier || 'moderate', (chain.inputs && chain.inputs.learningMode) || 'Exam', difficultyForLink);
    const r = await _runCurriculumCreate(event, {
      topic: firstTopic,
      level: 'intermediate',
      goal: firstGoal,
      timeCommit: 'custom',
      customLessons: customLessonsForLink,
      tier: chain.tier || 'moderate',
      uploadedSource: chain.uploadedSource || null,
      clarifications: [],
    });
    if (!r || !r.ok) {
      return { ok: false, error: (r && r.error) || 'first-link curriculum failed' };
    }
    const firstSlug = r.topic;
    const lessonRel = (r.lessonRels && r.lessonRels[0]) || null;
    // Stamp curriculum's state.json with chain context for NoteView banner +
    // VaultTree grouping. v0.6.8: include chainUltimateGoal + chainTotalLinks
    // so the chain parent header renders identically across all link folders.
    try {
      const curState = vault.readJSON(`${firstSlug}/state.json`, {}) || {};
      curState.chainSlug = chainSlug;
      curState.chainLinkIdx = 0;
      curState.chainUltimateGoal = chain.ultimate_goal || '';
      curState.chainTotalLinks = (chain.chain && chain.chain.links && chain.chain.links.length) || 1;
      vault.writeJSON(`${firstSlug}/state.json`, curState);
    } catch (_) {}
    // Update links-state: link 0 → active with slug + lessonRel.
    linksState.links[0].slug = firstSlug;
    linksState.links[0].status = 'active';
    linksState.links[0].lessonRel = lessonRel;
    // 2026-05-17 Phase C Gap 3 — stamp wall-clock startedAt so
    // compute-variance can use real elapsed weeks instead of entry-count
    // approximation (Agent A honest-gap fix).
    linksState.links[0].startedAt = new Date().toISOString();
    linksState.updatedAt = new Date().toISOString();
    vault.writeJSON(`${chainSlug}/links-state.json`, linksState);
    _hyphaAppendEvent('chain_started', { chainSlug, firstSlug });
    return { ok: true, firstSlug, lessonRel };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('chain:advance', async (event, { chainSlug } = {}) => {
  if (!chainSlug || !String(chainSlug).trim()) return { ok: false, error: 'chainSlug required' };
  try {
    const linksState = vault.readJSON(`${chainSlug}/links-state.json`, null);
    const chain = vault.readJSON(`${chainSlug}/chain.json`, null);
    if (!linksState || !Array.isArray(linksState.links)) return { ok: false, error: 'links-state.json missing or malformed' };
    if (!chain || !chain.chain || !Array.isArray(chain.chain.links)) return { ok: false, error: 'chain.json missing or malformed' };
    const links = linksState.links;
    const activeIdx = links.findIndex(l => l && l.status === 'active');
    if (activeIdx < 0) return { ok: false, error: 'no active link' };
    if (activeIdx >= links.length - 1) {
      // Last link finishing — mark done, no next.
      links[activeIdx].status = 'done';
      vault.writeJSON(`${chainSlug}/links-state.json`, { ...linksState, links, updatedAt: new Date().toISOString() });
      return { ok: true, completed: true };
    }
    const nextIdx = activeIdx + 1;
    const nextLink = chain.chain.links[nextIdx];
    if (!nextLink) return { ok: false, error: `chain.json missing link at idx ${nextIdx}` };
    // Mark current done provisionally; restore on _runCurriculumCreate failure.
    links[activeIdx].status = 'done';
    // v0.6.7+v0.6.9 — proportional + role-aware lesson count + forward
    // uploadedSource (matches chain:start). _resolveLessonsForLink uses the
    // LLM's lessons_count if present, falls back to role-aware multiplier.
    const advDailyHours = (chain.inputs && chain.inputs.dailyHours) || 2;
    // 2026-05-17 阶 2 — difficulty cascade for chain advance too.
    const advDifficulty = (chain.inputs && Number.isFinite(Number(chain.inputs.difficulty)))
      ? Number(chain.inputs.difficulty)
      : 0.6;
    const advCustomLessons = _resolveLessonsForLink(nextLink, advDailyHours, chain.tier || 'moderate', (chain.inputs && chain.inputs.learningMode) || 'Exam', advDifficulty);
    // v0.6.8 — clean up the v0.6.8 pre-created `-pending.md` ghost stubs in
    // this link's folder so _runCurriculumCreate can write fresh lesson files
    // without filename collisions. Also clear stale state.json so designSeed
    // generates fresh phases.
    try {
      const linkSlug = links[nextIdx].slug || _topicSlug(nextLink.topic);
      const linkDir = path.join(vault.resolveRoot(), linkSlug);
      if (fs.existsSync(linkDir)) {
        const files = fs.readdirSync(linkDir);
        for (const f of files) {
          if (f.endsWith('-pending.md') || f === 'state.json') {
            try { fs.unlinkSync(path.join(linkDir, f)); }
            catch (unlinkErr) {
              // boot-7: destructive unlinkSync — TypeError surfaces drift, ENOENT is benign race
              if (unlinkErr && unlinkErr.name === 'TypeError') {
                console.error('[CRITICAL][chain advance] unlinkSync TypeError:', unlinkErr.message, 'file=', f);
              } else if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                console.warn('[chain advance] unlinkSync pending cleanup failed:', unlinkErr.message, 'file=', f);
              }
              // intentional: ENOENT means file already gone (concurrent regen) — continue with siblings
            }
          }
        }
      }
    } catch (_) { /* intentional: best-effort cleanup wrapper — readdir/existsSync race acceptable */ }
    const r = await _runCurriculumCreate(event, {
      topic: nextLink.topic,
      level: 'intermediate',
      goal: nextLink.exit_criterion || '',
      timeCommit: 'custom',
      customLessons: advCustomLessons,
      tier: chain.tier || 'moderate',
      uploadedSource: chain.uploadedSource || null,
      clarifications: [],
    });
    if (!r || !r.ok) {
      // Roll back so the user isn't stranded with an orphaned chain state.
      links[activeIdx].status = 'active';
      vault.writeJSON(`${chainSlug}/links-state.json`, { ...linksState, links, updatedAt: new Date().toISOString() });
      return { ok: false, error: (r && r.error) || 'next-link curriculum failed' };
    }
    const nextSlug = r.topic;
    const nextLessonRel = (r.lessonRels && r.lessonRels[0]) || null;
    // Stamp the new curriculum's state.json with chainSlug + linkIdx so
    // NoteView's chain-link banner renders correctly.
    try {
      const curState = vault.readJSON(`${nextSlug}/state.json`, {}) || {};
      curState.chainSlug = chainSlug;
      curState.chainLinkIdx = nextIdx;
      curState.chainUltimateGoal = chain.ultimate_goal || '';
      curState.chainTotalLinks = (chain.chain && chain.chain.links && chain.chain.links.length) || 1;
      vault.writeJSON(`${nextSlug}/state.json`, curState);
    } catch (_) {}
    // Persist link transition.
    links[nextIdx].status = 'active';
    links[nextIdx].slug = nextSlug;
    links[nextIdx].lessonRel = nextLessonRel;
    // 2026-05-17 Phase C Gap 3 — wall-clock startedAt for variance compute.
    links[nextIdx].startedAt = new Date().toISOString();
    vault.writeJSON(`${chainSlug}/links-state.json`, { ...linksState, links, updatedAt: new Date().toISOString() });
    _hyphaAppendEvent('chain_advanced', { chainSlug, fromIdx: activeIdx, toIdx: nextIdx, nextSlug });
    return { ok: true, nextSlug, nextLessonRel, nextIdx };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// feasibility:gate — Smart Gate (per user 2026-05-01 council decision: option B).
// After Q&A in Learn flow but BEFORE designSequence, evaluate target feasibility.
// Returns difficulty + intrinsicLoad + priorKnowledge + feasibility tier so the
// renderer can decide whether to:
//   - tier 'easy'/'possible' → continue to curriculum:create as normal
//   - tier 'nearly-impossible' → offer the user 3 paths (proceed anyway / view
//     chain recommendation / change goal). Avoids the user committing 12 weeks
//     to a goal the function knows is structurally impossible.
// Reuses the same 3 LLM classifiers as chain:create but DOES NOT run planChain
// (~5-8s saved per gate; planChain runs only if user picks "看推荐").
ipcMain.handle('feasibility:gate', async (_e, { topic, goal, timeCommit, answers } = {}) => {
  if (!topic || !String(topic).trim()) return { ok: false, error: 'topic required' };
  const settings = _hyphaSettings();
  const TIME_TO_WEEKS = { week: 1, month: 4, quarter: 12, open: 26 };
  const timeWeeks = TIME_TO_WEEKS[timeCommit] || TIME_TO_WEEKS.month;
  try {
    // v0.5.2 — all 3 classifiers in one Promise.all (saves 3-5s wall time).
    const safeAnswers = Array.isArray(answers) ? answers : [];
    const goalText = topic + (goal ? ' — ' + goal : '');
    const [diff, intrinsic, prior] = await Promise.all([
      _hyphaAgent.classifyDifficulty(goalText, settings),
      _hyphaAgent.classifyIntrinsicLoad(topic, settings),
      _hyphaAgent.classifyPriorKnowledge(goalText, safeAnswers, settings),
    ]);
    const feasibility = require('./lib/feasibility');
    const verdict = feasibility.classifyFeasibility({
      targetDifficulty: diff.score,
      priorKnowledge: prior.score,
      timeWeeks,
      dailyHours: 2,           // conservative千金 default; gate is pessimistic on purpose
      intrinsicLoad: intrinsic.load,
      priorConsistency: 0,     // unknown — conservative (no prior consistency credit)
      failedAttempts: 0,
    });
    return {
      ok: true,
      difficulty: diff,
      intrinsic,
      prior,
      feasibility: verdict,
      timeWeeks,
    };
  } catch (err) { return { ok: false, error: err.message }; }
});

// chain:propose-prereqs — called by Smart Gate if user picks "看推荐". Wraps
// only the planChain LLM call (skips classifiers — already done in :gate).
ipcMain.handle('chain:propose-prereqs', async (_e, { topic, goal, gateResult } = {}) => {
  if (!topic || !gateResult || !gateResult.feasibility) {
    return { ok: false, error: 'topic + gateResult required' };
  }
  const settings = _hyphaSettings();
  const lang = /[一-龥]/.test(String(topic + ' ' + (goal || ''))) ? 'zh' : 'en';
  try {
    const v = gateResult.feasibility;
    const chain = await _hyphaAgent.planChain(topic + (goal ? ' — ' + goal : ''), {
      tier: v.tier,
      ratio: v.ratio.p50,
      gap: v.gap,
      missing_prerequisites: (gateResult.prior && gateResult.prior.missing_prerequisites) || [],
      timeWeeks: gateResult.timeWeeks,
      dailyHours: 2,
      intrinsicLoad: (gateResult.intrinsic && gateResult.intrinsic.load) || 'med',
      pComplete: v.pComplete,
      lang,
    }, settings);
    return { ok: true, chain };
  } catch (err) { return { ok: false, error: err.message }; }
});

// chain:clarify — fetch the prior-knowledge questions before chain:create.
// Renderer flow: chain:clarify → render Qs → user answers → chain:create with answers.
ipcMain.handle('chain:clarify', async (_e, { goal } = {}) => {
  if (!goal || !String(goal).trim()) return { ok: false, error: 'goal required' };
  const settings = _hyphaSettings();
  try {
    const questions = await _hyphaAgent.clarifyQuestions(goal, '', 'open', settings);
    return { ok: true, questions };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('curriculum:clarify', async (_e, { topic, goal, timeCommit } = {}) => {
  const settings = _hyphaSettings();
  if (!settings.apiKey) return { ok: false, error: 'no api key set' };
  try {
    const questions = await _hyphaAgent.clarifyQuestions(topic || '', goal || '', timeCommit || 'month', settings);
    return { ok: true, questions };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// curriculum:list — Hypha-specific dashboard. Walks data/ for folders that have state.json.
// v0.4.11 (2026-05-19) — also count sessions in <slug>/sessions/. User
// complaint: 上了一节课但进度仍 "0/N" 因为 /finish 没跑 → lastIdx 没 bump.
// Surface sessionsCount so home screen can show "进行中 · N 次访问" when
// user has activity without formal /finish ritual.
ipcMain.handle('curriculum:list', () => {
  const root = vault.resolveRoot();
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const state = vault.readJSON(`${e.name}/state.json`, null);
      if (!state) continue;
      // Count session jsonl files in <slug>/sessions/. Each file = 1 session
      // ("再开课" creates a new one). Best-effort, returns 0 on missing dir.
      let sessionsCount = 0;
      let lastSessionAt = null;
      try {
        const sessDir = path.join(root, e.name, 'sessions');
        if (fs.existsSync(sessDir)) {
          const sessFiles = fs.readdirSync(sessDir).filter(f => /^L\d+-.+\.jsonl$/.test(f));
          sessionsCount = sessFiles.length;
          if (sessFiles.length > 0) {
            // Filenames sort lexicographically by ISO timestamp; last = newest.
            const newest = sessFiles.sort().slice(-1)[0];
            try {
              const stat = fs.statSync(path.join(sessDir, newest));
              lastSessionAt = stat.mtime.toISOString();
            } catch (_) { /* stat best-effort */ }
          }
        }
      } catch (_) { /* sessions probe best-effort */ }
      // v0.4.9 — surface chain.json fields so home UI can render
      // ultimate_goal / feasibility / link-roles without a second IPC.
      // Malformed chain.json fails open (fields stay null).
      let ultimateGoal = null;
      let feasibility = null;
      let chainLinks = null;
      let parentChainSlug = null;
      const chainPath = path.join(root, e.name, 'chain.json');
      if (fs.existsSync(chainPath)) {
        try {
          const chain = JSON.parse(fs.readFileSync(chainPath, 'utf-8'));
          ultimateGoal = chain.ultimate_goal || null;
          if (chain.feasibility) {
            feasibility = {
              tier: chain.feasibility.tier,
              pComplete: chain.feasibility.pComplete,
              gap: chain.feasibility.gap,
              hoursNeeded: chain.feasibility.hoursNeeded,
              hoursAvailable: chain.feasibility.hoursAvailable,
            };
          }
          if (Array.isArray(chain.links)) {
            chainLinks = chain.links.map(l => ({
              role: l.role || null,
              lessons_count: l.lessons_count || 0,
              topic: l.topic || null,
            }));
          }
          if (typeof chain.parent_chain_slug === 'string' && chain.parent_chain_slug) {
            parentChainSlug = chain.parent_chain_slug;
          }
        } catch (_) { /* malformed chain.json — silent skip, fields stay null */ }
      }
      const rawSeries = (typeof state.series === 'string' && state.series) ? state.series : null;
      out.push({
        topic: e.name,
        lastIdx: state.lastIdx ?? -1,
        totalLessons: (state.lessonRels || []).length,
        firstLessonRel: state.lessonRels?.[0] || null,
        sessionsCount,
        lastSessionAt,
        series: rawSeries,
        parentChainSlug,
        // v0.4.11 — UI should prefer parent_chain_slug (canonical chain ref);
        // state.series is the v0.4.7 backward-compat fallback.
        effectiveSeries: parentChainSlug ?? rawSeries,
        ultimateGoal,
        feasibility,
        chainLinks,
      });
    }
    return out;
  } catch (_) { return []; }
});

// curriculum:archive — single-verb soft-delete a course. v0.5.x ship 2026-05-09
// per /tr council (Lung divergent + Muse aesthetic + Scout frontier) + MUSE
// 顶级审美大师 1100ms cubic-bezier fog spec. Surface = screen-home.jsx course-row
// long-press gesture (千金 visible + complementary to existing HandscrollNav.jsx
// 长按 0.5s on brass-stroke rail which stays as power-user shortcut).
//
// Behavior: (1) Stamps state.json with `lifecycle:'deprecated'` + `archived_ts`
// BEFORE moving the slug dir to vault/.trash/<slug>-<unixMs>/. (2) Reuses
// existing vault.del → 7d retention + restoreFromTrash recovery. (3) Returns
// {ok, error?, trashedAs?} envelope; renderer surfaces failure in italic toast
// — NO silent-catch (Muse #2 attack: 5 existing callsites already silent-catch
// vault.del; this NEW path explicitly does not).
//
// DEFERRED to v0.5.x+1:
//   - DAG inbound-edge scan (Muse #1) — chain-link / atlas / cross-spark refs
//     to this slug. Currently 7d trash window IS the safety net; restore brings
//     refs back. TODO: add `curriculum:dag-inbound` scanner before commit so
//     UI can hint "3 课与此相连".
//   - Active-stream lock (Muse #3) — _hyphaLessonAbort is keyed by requestId
//     not slug; mapping requestId→slug requires note-rel→slug derivation per
//     entry. TODO: track slug at request:start time. For now, if user archives
//     a slug mid-stream, the dir-rename will likely fail and {ok:false} fires;
//     graceful enough for first ship.
ipcMain.handle('curriculum:archive', (_e, { slug } = {}) => {
  if (!slug || typeof slug !== 'string') {
    return { ok: false, error: 'slug required' };
  }
  // Sanity: slug must not contain path traversal characters.
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || slug.startsWith('.')) {
    return { ok: false, error: 'invalid slug shape' };
  }
  const stateRel = `${slug}/state.json`;
  const state = vault.readJSON(stateRel, null);
  if (!state) {
    return { ok: false, error: 'state.json not found — slug may not exist' };
  }
  // Stamp lifecycle — Schema-Grounded Memory pattern (arXiv 2604.27906) per
  // Scout: deletion = state transition, not row removal. atlas / chain-readers
  // can read deprecated state for ghost rendering on restore.
  state.lifecycle = 'deprecated';
  state.archived_ts = new Date().toISOString();
  try {
    vault.writeJSON(stateRel, state);
  } catch (e) {
    return { ok: false, error: `lifecycle write failed: ${e.message}` };
  }
  // Now move the whole slug dir into vault/.trash/<slug>-<unixMs>/ via vault.del.
  // vault.del returns {ok, reason?, trashedAs?} — we forward the envelope.
  const r = vault.del(slug);
  if (!r || r.ok !== true) {
    // Best-effort rollback: state.json was rewritten with lifecycle but the
    // dir move failed. Restore prior fields (lifecycle/archived_ts removed).
    delete state.lifecycle;
    delete state.archived_ts;
    try { vault.writeJSON(stateRel, state); } catch (_) { /* if even rollback fails, surface the original error anyway */ }
    return { ok: false, error: (r && r.reason) || 'vault.del failed' };
  }
  return { ok: true, trashedAs: r.trashedAs || null, slug };
});

// curriculum:list-deprecated — Apple-Mail-style 已搁置 list. Walks vault/.trash/
// for entries shaped `<slug>-<unixMs>/state.json`, returns metadata sorted desc
// by archive timestamp. Used by SetAsideList in screen-home.jsx.
ipcMain.handle('curriculum:list-deprecated', () => {
  const root = vault.resolveRoot();
  const trashDir = path.join(root, '.trash');
  if (!fs.existsSync(trashDir)) return [];
  const out = [];
  try {
    const entries = fs.readdirSync(trashDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // Expected name pattern: <slug>-<unixMs>
      const m = e.name.match(/^(.+)-(\d{10,16})$/);
      if (!m) continue;
      const originalSlug = m[1];
      const archivedAt = parseInt(m[2], 10);
      if (!Number.isFinite(archivedAt)) continue;
      // Filter to course-shaped entries only (must contain a state.json with
      // a lessonRels array). Skips other trashed file types (notes, sessions).
      const stateRel = `.trash/${e.name}/state.json`;
      const state = vault.readJSON(stateRel, null);
      if (!state || !Array.isArray(state.lessonRels)) continue;
      out.push({
        trashName: e.name,
        originalSlug,
        archivedAt,
        topic: originalSlug,
        lastIdx: state.lastIdx ?? -1,
        totalLessons: state.lessonRels.length,
        archived_ts: state.archived_ts || null,
      });
    }
  } catch (_) { /* return what we have */ }
  out.sort((a, b) => b.archivedAt - a.archivedAt);
  return out;
});

// curriculum:restore — wraps vault.restoreFromTrash. Returns {ok, error?, rel?}.
// If the original slug now exists (user created a new course with same name
// since archive), refuses with explicit error so renderer can prompt user.
ipcMain.handle('curriculum:restore', (_e, { trashName } = {}) => {
  if (!trashName || typeof trashName !== 'string') {
    return { ok: false, error: 'trashName required' };
  }
  if (trashName.includes('/') || trashName.includes('\\') || trashName.includes('..')) {
    return { ok: false, error: 'invalid trashName shape' };
  }
  let r;
  try {
    r = vault.restoreFromTrash(trashName);
  } catch (e) {
    return { ok: false, error: `restoreFromTrash threw: ${e.message}` };
  }
  if (!r || r.ok !== true) {
    return { ok: false, error: (r && r.reason) || 'restore failed' };
  }
  // Strip lifecycle field on the restored state.json — back to active.
  const stateRel = `${r.rel}/state.json`;
  try {
    const state = vault.readJSON(stateRel, null);
    if (state && state.lifecycle === 'deprecated') {
      delete state.lifecycle;
      delete state.archived_ts;
      vault.writeJSON(stateRel, state);
    }
  } catch (_) { /* non-fatal: restore succeeded, lifecycle strip is cosmetic */ }
  return { ok: true, rel: r.rel };
});

// V0.5 E0 D11-D14 Phase 1 — evaluator IPC cluster.
//
// Single-verb IPCs that wrap the substrate libraries shipped in D1-D10:
//   - golden-loader.loadTopic(topic) — items + sidecar-merged ratings + kappa
//   - sealed-rubric.verifyFeatures(responseText, item) — feature-substring channel
//   - exec-cell.runCell(code, opts) — Node child-process channel
//   - f1-harness.runHarness(topic, opts) — F1 + IRR-gated rater mode
//   - events.write(slug, event) — typed event log writer (validates schema)
//   - sqlite.recordLessonOutcome(row) — per-response outcome row
//
// Surfaces consumed by app/design/screen-tuple-substrate.jsx (col-3 substrate
// view). Bridges live in app/preload.js under window.ptor.evaluator.{...}.
// IRR-before-F1 rule (constitution): kappa >= 0.7 must precede any F1 number.
const _evaluatorGoldenLoader = require('./lib/evaluator/golden-loader');
const _evaluatorSealedRubric = require('./lib/evaluator/verification-channels/sealed-rubric');
const _evaluatorExecCell     = require('./lib/evaluator/verification-channels/exec-cell');
const _evaluatorF1Harness    = require('./lib/evaluator/f1-harness');
const _evaluatorEvents       = require('./lib/events');
let _evaluatorSqlite = null;
function _evaluatorDb() {
  if (_evaluatorSqlite !== null) return _evaluatorSqlite;
  try { _evaluatorSqlite = require('./db/sqlite'); }
  catch (err) {
    console.warn('[evaluator] sqlite unavailable — outcome rows will be skipped:', err && err.message);
    _evaluatorSqlite = false;
  }
  return _evaluatorSqlite || null;
}

// Locate item by id by walking loadAllTopics. Returns {topic, item} or null.
// 50-item set; full walk is cheap. Cached per-process for the session lifetime
// of the IPC call only (no module-level cache; sidecars change at runtime).
function _evaluatorFindItem(itemId) {
  if (!itemId || typeof itemId !== 'string') return null;
  const all = _evaluatorGoldenLoader.loadAllTopics();
  if (!all || !Array.isArray(all.topics)) return null;
  for (const ledger of all.topics) {
    if (!ledger || !Array.isArray(ledger.items)) continue;
    const found = ledger.items.find(it => it && it.id === itemId);
    if (found) return { topic: ledger.topic, item: found };
  }
  return null;
}

// nextInstance — walk items × candidates for the given topic, return the first
// pair where rater_a (the founder) has not yet rated this candidate. Sidecar-
// driven: rater_a sidecar absent OR present but missing this candidate id =>
// instance is unrated.
ipcMain.handle('evaluator:nextInstance', (_e, topic) => {
  if (!topic || typeof topic !== 'string') {
    return { ok: false, error: 'topic required (string)' };
  }
  let ledger;
  try {
    ledger = _evaluatorGoldenLoader.loadTopic(topic);
  } catch (err) {
    console.warn('[evaluator:nextInstance] loadTopic threw:', err && err.message);
    return { ok: false, error: `loadTopic threw: ${err && err.message}` };
  }
  if (!ledger || !Array.isArray(ledger.items)) {
    return { ok: false, error: ledger && ledger.reason ? ledger.reason : 'no items' };
  }
  const items = ledger.items;
  for (const item of items) {
    const cands = Array.isArray(item.candidate_responses) ? item.candidate_responses : [];
    if (cands.length === 0) continue;
    const ratingsA = (item.rater_a && item.rater_a.ratings) || null;
    for (const cand of cands) {
      const rated = ratingsA && ratingsA[cand.id];
      if (!rated) {
        return { ok: true, item, candidate: cand, topic };
      }
    }
  }
  return { ok: true, item: null, candidate: null, exhausted: true, topic };
});

// submitResponse — per-response verification + outcome recording. Dispatches
// on item.verification_channel: 'sealed_rubric' => sealed-rubric.verifyFeatures
// (sync), 'code' => exec-cell.runCell(item.exec_cell.code) (async). Writes
// events.jsonl row + sqlite lesson_outcomes row. No silent-catch — every
// failure path either returns an error envelope or writes a quarantine event.
ipcMain.handle('evaluator:submitResponse', async (_e, itemId, candidateId, responseText) => {
  if (!itemId || typeof itemId !== 'string') {
    return { ok: false, error: 'itemId required (string)' };
  }
  if (!candidateId || typeof candidateId !== 'string') {
    return { ok: false, error: 'candidateId required (string)' };
  }
  if (typeof responseText !== 'string') {
    return { ok: false, error: 'responseText required (string)' };
  }
  const located = _evaluatorFindItem(itemId);
  if (!located) {
    return { ok: false, error: `item not found: ${itemId}` };
  }
  const { topic, item } = located;
  const channel = item.verification_channel || 'sealed_rubric';

  let verified = null;
  let exec_result = null;
  const t0 = Date.now();

  if (channel === 'code') {
    const cell = item.exec_cell || {};
    const code = typeof cell.code === 'string' ? cell.code : '';
    const timeoutMs = Number.isFinite(cell.timeout_ms) ? cell.timeout_ms : undefined;
    try {
      exec_result = await _evaluatorExecCell.runCell(code, { timeoutMs });
    } catch (err) {
      console.warn('[evaluator:submitResponse] exec-cell threw:', err && err.message);
      exec_result = { pass: false, reason: 'exec_threw', stderr_excerpt: err && err.message };
    }
    if (cell.expected_stdout_hash && exec_result && exec_result.stdout_hash) {
      exec_result.hash_match = exec_result.stdout_hash === cell.expected_stdout_hash;
      exec_result.pass = !!exec_result.pass && exec_result.hash_match === true;
    }
    verified = {
      channel: 'code',
      predicted_pass: !!(exec_result && exec_result.pass),
      features_hit: [],
      per_feature: [],
    };
  } else {
    // Default: sealed_rubric / feature_substring channel. verifyFeatures is sync.
    try {
      const v = _evaluatorSealedRubric.verifyFeatures(responseText, item);
      verified = {
        channel: v.channel || 'feature_substring',
        predicted_pass: !!v.predicted_pass,
        features_hit: Array.isArray(v.features_hit) ? v.features_hit : [],
        per_feature: Array.isArray(v.per_feature) ? v.per_feature : [],
        threshold: v.threshold,
        reason: v.reason || null,
      };
    } catch (err) {
      console.warn('[evaluator:submitResponse] verifyFeatures threw:', err && err.message);
      verified = {
        channel: 'feature_substring',
        predicted_pass: false,
        features_hit: [],
        per_feature: [],
        reason: `verifyFeatures threw: ${err && err.message}`,
      };
    }
  }

  const duration_ms = Date.now() - t0;
  const verdict = verified.predicted_pass ? 'pass' : 'fail';

  // Typed event row. events.write enriches with ts + lifecycle defaults and
  // validates against events-schema.json; failures land in .events-quarantine.
  let event_recorded = false;
  try {
    const eventPayload = {
      type: 'eval_response',
      tuple_id: itemId,
      candidate_id: candidateId,
      verification_channel: channel === 'code' ? 'code' : 'sealed_rubric',
      predicted_pass: verified.predicted_pass,
      features_hit: verified.features_hit,
      duration_ms,
    };
    if (exec_result) eventPayload.exec_result = {
      pass: !!exec_result.pass,
      stdout_hash: exec_result.stdout_hash || null,
      runtime_ms: Number.isFinite(exec_result.runtime_ms) ? exec_result.runtime_ms : null,
      stderr_excerpt: exec_result.stderr_excerpt || null,
      reason: exec_result.reason || null,
      hash_match: exec_result.hash_match == null ? null : !!exec_result.hash_match,
    };
    const r = _evaluatorEvents.write(topic, eventPayload);
    event_recorded = !!(r && r.ok);
  } catch (err) {
    console.warn('[evaluator:submitResponse] events.write threw:', err && err.message);
  }

  // Per-response sqlite outcome row. recordLessonOutcome upserts on tuple_id;
  // composite key (item, candidate) is encoded as `${itemId}::${candidateId}`
  // so multiple candidates per item don't collide.
  let outcome_recorded = false;
  const db = _evaluatorDb();
  if (db && typeof db.recordLessonOutcome === 'function') {
    try {
      db.recordLessonOutcome({
        tuple_id: `${itemId}::${candidateId}`,
        goal_topic: topic,
        verification_channel: channel === 'code' ? 'code' : 'sealed_rubric',
        verdict,
        exec_result_pass: exec_result ? !!exec_result.pass : null,
        duration_ms,
      });
      outcome_recorded = true;
    } catch (err) {
      console.warn('[evaluator:submitResponse] recordLessonOutcome threw:', err && err.message);
    }
  }

  return {
    ok: true,
    verified,
    exec_result,
    recorded: { events: event_recorded, sqlite: outcome_recorded },
    duration_ms,
    topic,
  };
});

// f1Run — wraps f1-harness.runHarness. opts pass-through ({ truth_source:
// 'rater' | 'ground' }). Default truth_source='rater' enforces kappa >= 0.7
// gate; 'ground' bypasses for development/calibration.
ipcMain.handle('evaluator:f1Run', async (_e, topic, opts) => {
  if (!topic || typeof topic !== 'string') {
    return { ok: false, error: 'topic required (string)' };
  }
  try {
    const result = await _evaluatorF1Harness.runHarness(topic, opts || {});
    return { ok: true, result };
  } catch (err) {
    console.warn('[evaluator:f1Run] runHarness threw:', err && err.message);
    return { ok: false, error: `runHarness threw: ${err && err.message}` };
  }
});

// irrCompute — thin wrapper over golden-loader.loadTopic that returns just the
// kappa fields (omits items array to keep IPC payload small).
ipcMain.handle('evaluator:irrCompute', (_e, topic) => {
  if (!topic || typeof topic !== 'string') {
    return { ok: false, error: 'topic required (string)' };
  }
  let ledger;
  try {
    ledger = _evaluatorGoldenLoader.loadTopic(topic);
  } catch (err) {
    console.warn('[evaluator:irrCompute] loadTopic threw:', err && err.message);
    return { ok: false, error: `loadTopic threw: ${err && err.message}` };
  }
  if (!ledger) return { ok: false, error: 'loadTopic returned nothing' };
  return {
    ok: true,
    topic,
    kappa: ledger.kappa,
    kappa_n: ledger.kappa_n || null,
    kappa_interpretation: ledger.kappa_interpretation || null,
    kappa_reason: ledger.kappa_reason || null,
    n_items: ledger.n_items || 0,
    n_double_coded: ledger.n_double_coded || 0,
  };
});

// v0.5.2 — Frontier Cron IPCs. Single-verb start/stop (NOT cron-toggle).
// Backend = app/scripts/frontier-cron.js. Persists `frontierCronEnabled` +
// `frontierCronInterval` into settings.app so the choice survives restart.
// Returns {ok, error?} envelope; no silent-catch.
ipcMain.handle('frontier:cron-start', (_e, args = {}) => {
  const { dryRun = false, intervalHours } = args || {};
  const cur = _hyphaSettings();
  const requested = Number.isFinite(intervalHours)
    ? intervalHours
    : (cur && cur.app && Number.isFinite(cur.app.frontierCronInterval) ? cur.app.frontierCronInterval : 6);
  if (!Number.isFinite(requested) || requested < 6) {
    return { ok: false, error: 'interval >= 6h required' };
  }
  let cron;
  try {
    cron = require('./scripts/frontier-cron');
  } catch (err) {
    return { ok: false, error: `frontier-cron require failed: ${err.message}` };
  }
  let r;
  try {
    r = cron.start({ intervalHours: requested, settings: cur, dryRun });
  } catch (err) {
    return { ok: false, error: `cron.start threw: ${err.message}` };
  }
  if (!r || r.ok !== true) {
    return { ok: false, error: (r && r.error) || 'cron start failed' };
  }
  // Persist user intent so a restart can auto-resume cron.
  try {
    const next = { ...cur, app: { ...(cur.app || APP_DEFAULTS), frontierCronEnabled: true, frontierCronInterval: requested } };
    delete next.userProfile;
    vault.writeJSON('settings.json', next);
  } catch (err) {
    // Settings write failed — surface but keep cron running (user-visible UX
    // is "cron is on", not "cron persisted"). Log to events.jsonl.
    _hyphaAppendEvent('frontier_cron_settings_write_failed', { reason: err.message });
  }
  return { ok: true, intervalMs: r.intervalMs, alreadyRunning: !!r.alreadyRunning };
});

ipcMain.handle('frontier:cron-stop', () => {
  let cron;
  try {
    cron = require('./scripts/frontier-cron');
  } catch (err) {
    return { ok: false, error: `frontier-cron require failed: ${err.message}` };
  }
  let r;
  try {
    r = cron.stop();
  } catch (err) {
    return { ok: false, error: `cron.stop threw: ${err.message}` };
  }
  // Persist enabled=false even if not running, so restart doesn't auto-resume.
  try {
    const cur = _hyphaSettings();
    const next = { ...cur, app: { ...(cur.app || APP_DEFAULTS), frontierCronEnabled: false } };
    delete next.userProfile;
    vault.writeJSON('settings.json', next);
  } catch (err) {
    _hyphaAppendEvent('frontier_cron_settings_write_failed', { reason: err.message });
  }
  return { ok: true, alreadyStopped: !!(r && r.alreadyStopped) };
});

// W1.4 Misconception Engine — IPC scaffold. Renderer + W1.3 Anti-Illusion
// path call these to surface classified wrong-priors, detect when the user's
// reply walks into one, and pull the repair prompt for the next tutor turn.
// Vault read/write is real (fs sidecar); T4_JUDGE category second-pass is the
// intentional placeholder for W1.4-followup.
ipcMain.handle('misconception:list', async (_e, { slug, lessonIdx, kpId } = {}) => {
  try {
    const mcVault = require('./lib/misconception-vault');
    const idx = Number.isFinite(lessonIdx) ? Number(lessonIdx) : Number(lessonIdx);
    const records = mcVault.readMisconceptions(String(slug || ''), idx, kpId || undefined);
    return { ok: true, misconceptions: records };
  } catch (err) {
    return { ok: false, error: 'MC_LIST_FAILED', message: err && err.message };
  }
});

ipcMain.handle('misconception:detect', async (_e, args = {}) => {
  try {
    const mcEngine = require('./lib/misconception-engine');
    const out = mcEngine.detectMisconceptionInResponse(
      args.userResponse,
      args.kpMisconceptions
    );
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: 'MC_DETECT_FAILED', message: err && err.message };
  }
});

ipcMain.handle('misconception:repair', async (_e, args = {}) => {
  try {
    const mcEngine = require('./lib/misconception-engine');
    const out = mcEngine.repairMisconception(args.triggered, args.lessonContext);
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, error: 'MC_REPAIR_FAILED', message: err && err.message };
  }
});

// W2.3 Goal Guardian + Affective Router — IPC scaffold.
//
// Surface (per specs/goal-guardian.md):
//   affect:extract        → cheap-regex affect scan, no LLM
//   guardian:assess       → state + guardian_action + evidence
//   guardian:intervene    → prompt_modifier + difficulty_adjust + message
//
// Pure functions; guardian:assess opportunistically writes a
// 'guardian_state_assessed' row to events.jsonl when state != on_track so the
// trust panel + debug tools can replay state shifts. T4_JUDGE upgrade
// deferred to W2.3.1; cheap regex caps confidence at 0.55.
ipcMain.handle('affect:extract', async (_e, { turnText } = {}) => {
  try {
    const router = require('./lib/affective-router');
    return { ok: true, result: router.extractAffect(turnText) };
  } catch (err) {
    return { ok: false, error: 'AFFECT_EXTRACT_FAILED', message: err && err.message };
  }
});

ipcMain.handle('guardian:assess', async (_e, args = {}) => {
  try {
    const guardian = require('./lib/goal-guardian');
    const result = guardian.assessGuardianState(args || {});
    if (result && result.state && result.state !== 'on_track') {
      try {
        _hyphaAppendEvent('guardian_state_assessed', {
          slug: args.slug || null,
          lesson_idx: Number.isFinite(args.lessonIdx) ? args.lessonIdx : null,
          state: result.state,
          confidence: result.confidence,
          signals: (result.affect && result.affect.signals) || [],
          guardian_action: result.guardian_action,
        });
      } catch (_) { /* events.jsonl write non-fatal */ }
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: 'GUARDIAN_ASSESS_FAILED', message: err && err.message };
  }
});

ipcMain.handle('guardian:intervene', async (_e, args = {}) => {
  try {
    const guardian = require('./lib/goal-guardian');
    const result = guardian.decideIntervention(args.state, args.currentLesson || null);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: 'GUARDIAN_INTERVENE_FAILED', message: err && err.message };
  }
});

// W1.5 Capture Mode + Finish Ritual — IPC scaffold.
//
// All four handlers are thin async wrappers around app/lib/capture-mode +
// app/lib/finish-ritual. Errors bubble back as { ok:false, error, message }
// envelopes (matching the rest of the hypha IPC surface) so the renderer
// never sees raw exceptions across the bridge.
ipcMain.handle('capture:start', async (_e, args = {}) => {
  try {
    return require('./lib/capture-mode').createCaptureSession(args);
  } catch (err) {
    return { ok: false, error: err.code || 'CAPTURE_START_FAILED', message: err.message };
  }
});
ipcMain.handle('capture:append', async (_e, args = {}) => {
  try {
    return require('./lib/capture-mode').appendCapture(args.sessionId, args.entry || {});
  } catch (err) {
    return { ok: false, error: err.code || 'CAPTURE_APPEND_FAILED', message: err.message };
  }
});
ipcMain.handle('capture:close', async (_e, args = {}) => {
  try {
    return require('./lib/capture-mode').closeCaptureSession(args.sessionId);
  } catch (err) {
    return { ok: false, error: err.code || 'CAPTURE_CLOSE_FAILED', message: err.message };
  }
});
ipcMain.handle('capture:finishRitual', async (_e, args = {}) => {
  try {
    return await require('./lib/finish-ritual').runFinishRitual(args.sessionId, args.opts || {});
  } catch (err) {
    return { ok: false, error: err.code || 'FINISH_RITUAL_FAILED', message: err.message };
  }
});

// W2.4 Repair Pipelines — three micro-intervention streams triggered by
// W2.3 Goal Guardian's decideIntervention() output. Goal Guardian assesses
// state ∈ {confused, frustrated, self_doubt} → caller invokes the matching
// pipeline OR routes through repair:run. All four return the standard
// { ok, ...result } envelope (lesson chat treats ok:false as a no-op so a
// failed repair never crashes the tutor stream). See specs/repair-
// pipelines.md + BLUEPRINT §3.4. T4_JUDGE LLM call inside confusion repair
// Stage 2 is mocked today; W2.4-followup wires the real router call.
ipcMain.handle('repair:confusion', async (_e, args = {}) => {
  try {
    const result = await require('./lib/repair/confusion-repair').runConfusionRepair(args);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.code || 'REPAIR_CONFUSION_FAILED', message: err.message };
  }
});
ipcMain.handle('repair:motivation', async (_e, args = {}) => {
  try {
    const result = await require('./lib/repair/motivation-recovery').runMotivationRecovery(args);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.code || 'REPAIR_MOTIVATION_FAILED', message: err.message };
  }
});
ipcMain.handle('repair:self-doubt', async (_e, args = {}) => {
  try {
    const result = await require('./lib/repair/self-doubt-repair').runSelfDoubtRepair(args);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.code || 'REPAIR_SELF_DOUBT_FAILED', message: err.message };
  }
});
ipcMain.handle('repair:run', async (_e, payload = {}) => {
  try {
    const { type, args } = payload || {};
    const orch = require('./lib/repair');
    const result = await orch.runRepair(type, args || {});
    const tutor_prompt = orch.repairResultToTutorPrompt(result);
    return { ok: true, type, result, tutor_prompt };
  } catch (err) {
    return { ok: false, error: err.code || 'REPAIR_RUN_FAILED', message: err.message };
  }
});

// W3.5 Companion Layer (菌类星人 Myco) — engine IPCs.
//
// Four handlers: contract loader, keyword map, enabled-flag read, and a
// single-shot expression generator. The detection + dispatch layer (W3.6)
// below routes `companion:trigger` through the same engine via
// require('./companion'). These four expose the engine directly so the
// renderer can render the contract in a settings panel, swap HYPHA terms
// to Myco vocabulary, and force-fire a response from the debug panel.
// See specs/companion-myco.md + BLUEPRINT §16.
ipcMain.handle('companion:respond', async (_e, payload = {}) => {
  try {
    const { triggerType, context } = payload || {};
    const settings = _hyphaSettings();
    const lib = require('./lib/companion');
    if (!lib.isEnabled(settings)) {
      return { ok: true, expression: { ok: true, text: null, trigger: triggerType, reason: 'settings_disabled' } };
    }
    const ctx = { settingsEnabled: true, ...(context || {}) };
    const expression = await lib.companionRespond(triggerType, ctx, {
      appendEvent: (row) => { try { vault.appendJSONL('events.jsonl', row); } catch (_) {} },
    });
    return { ok: true, expression };
  } catch (err) {
    return { ok: false, error: 'COMPANION_RESPOND_FAILED', message: err && err.message };
  }
});

ipcMain.handle('companion:contract', () => {
  try {
    const lib = require('./lib/companion');
    return { ok: true, contract: lib.loadContract() };
  } catch (err) {
    return { ok: false, error: 'COMPANION_CONTRACT_FAILED', message: err && err.message };
  }
});

ipcMain.handle('companion:keywordMap', () => {
  try {
    const { KEYWORD_MAPPING } = require('./lib/companion');
    return { ok: true, mapping: KEYWORD_MAPPING };
  } catch (err) {
    return { ok: false, error: 'COMPANION_MAP_FAILED', message: err && err.message };
  }
});

ipcMain.handle('companion:enabled', () => {
  try {
    const lib = require('./lib/companion');
    return { ok: true, enabled: lib.isEnabled(_hyphaSettings()) };
  } catch (err) {
    return { ok: false, error: 'COMPANION_ENABLED_FAILED', message: err && err.message };
  }
});

// v1.0 boot-9 (2026-05-20) — T2_LOCAL Companion local-model scaffold.
// Returns the current model status (ready / model_name / size_mb / RAM /
// expected_path / capability_available). v1.0 always reports
// capability_available:false + ready:false so the Settings UI surfaces
// "未下载 · v1.1+ 即将上线" without lying. v1.1+ will flip the flag and
// users can opt-in via downloadModel.
ipcMain.handle('companion:local-status', () => {
  try {
    const localModel = require('./lib/companion/local-model');
    const status = localModel.getModelStatus();
    return { ok: true, status };
  } catch (err) {
    return { ok: false, error: 'COMPANION_LOCAL_STATUS_FAILED', message: err && err.message };
  }
});

// v1.0 boot-9 — Companion local-model download stub. Returns
// not_implemented_v1.0 today; v1.1+ will stream chunked progress events.
// Wired now so the Settings UI button has a real callee instead of an
// inline placeholder.
ipcMain.handle('companion:local-download', async () => {
  try {
    const localModel = require('./lib/companion/local-model');
    const r = await localModel.downloadModel({});
    return { ok: r.ok !== false, ...r };
  } catch (err) {
    return { ok: false, error: 'COMPANION_LOCAL_DOWNLOAD_FAILED', message: err && err.message };
  }
});

// W3.6 Companion Triggers — IPC scaffold.
//
// 5 detect handlers (pure read; no dispatch) + manual fire + history reader.
// `companion:trigger` is a debug/manual-fire surface for the UI debug panel;
// it goes through dispatchTrigger so dedupe still applies. `companion:history`
// powers the "last 20 fires" debug ribbon on companion-presence.jsx.
//
// We keep this block standalone instead of folding into the existing
// guardian / repair clusters — the Companion System is its own lane (System 9
// per BLUEPRINT) and surface-area additions stay traceable.
ipcMain.handle('companion:detect:lessonComplete', async (_e, args = {}) => {
  try {
    const ct = require('./lib/companion-triggers');
    return { ok: true, detected: ct.detectLessonComplete(args) };
  } catch (err) { return { ok: false, error: 'COMPANION_DETECT_FAILED', message: err && err.message }; }
});
ipcMain.handle('companion:detect:interruptResume', async (_e, args = {}) => {
  try {
    const ct = require('./lib/companion-triggers');
    return { ok: true, detected: ct.detectInterruptResume(args) };
  } catch (err) { return { ok: false, error: 'COMPANION_DETECT_FAILED', message: err && err.message }; }
});
ipcMain.handle('companion:detect:overGrind', async (_e, args = {}) => {
  try {
    const ct = require('./lib/companion-triggers');
    return { ok: true, detected: ct.detectOverGrind(args) };
  } catch (err) { return { ok: false, error: 'COMPANION_DETECT_FAILED', message: err && err.message }; }
});
ipcMain.handle('companion:detect:finishCapture', async (_e, args = {}) => {
  try {
    const ct = require('./lib/companion-triggers');
    return { ok: true, detected: ct.detectFinishCapture(args) };
  } catch (err) { return { ok: false, error: 'COMPANION_DETECT_FAILED', message: err && err.message }; }
});
ipcMain.handle('companion:detect:sparkSprout', async (_e, args = {}) => {
  try {
    const ct = require('./lib/companion-triggers');
    return { ok: true, detected: ct.detectSparkSprout(args) };
  } catch (err) { return { ok: false, error: 'COMPANION_DETECT_FAILED', message: err && err.message }; }
});
ipcMain.handle('companion:trigger', async (_e, args = {}) => {
  try {
    const ct = require('./lib/companion-triggers');
    const { triggerType, context } = args || {};
    const result = await ct.dispatchTrigger(triggerType, context || {});
    return { ok: true, result };
  } catch (err) { return { ok: false, error: 'COMPANION_TRIGGER_FAILED', message: err && err.message }; }
});
ipcMain.handle('companion:history', async (_e, args = {}) => {
  try {
    const history = require('./lib/companion-history');
    const { slug, limit } = args || {};
    return { ok: true, fires: history.listHistory(slug, limit || 20) };
  } catch (err) { return { ok: false, error: 'COMPANION_HISTORY_FAILED', message: err && err.message }; }
});

// W3.6 — helper for interrupt_resume: walk slug/sessions/ for newest mtime.
// Returns ISO string or null. Best-effort; never throws (callers wrap in
// try/catch). Used at llm:lesson handler before stamping a new session.
function _lastSessionTimestamp(slug) {
  try {
    const dir = path.join(vault.root(), slug, 'sessions');
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) return null;
    let newest = 0;
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f));
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
    return newest > 0 ? new Date(newest).toISOString() : null;
  } catch (_) { return null; }
}

// W5.1 Cheap Router — IPC scaffolding (per BLUEPRINT §17.2 + ROADMAP v1.1).
// Theory-ship: surface contract locked, downstream W5.2 / W5.3 streams can
// call window.ptor.cheap.* now. Stubs (BGE-M3 / Gemma Ollama) fall back to
// mock-but-deterministic implementations until v0.8 Companion infrastructure.
ipcMain.handle('cheap:route', async (_e, args = {}) => {
  try {
    const cheap = require('./lib/llm/cheap-router');
    return { ok: true, decision: cheap.routeToCheapest(args.task, args.options || {}) };
  } catch (err) { return { ok: false, error: 'CHEAP_ROUTE_FAILED', message: err && err.message }; }
});
ipcMain.handle('cheap:run', async (_e, args = {}) => {
  try {
    const cheap = require('./lib/llm/cheap-router');
    const out = await cheap.runCheapTask(args.task, args.input || {}, args.options || {});
    return { ok: true, ...out };
  } catch (err) { return { ok: false, error: 'CHEAP_RUN_FAILED', message: err && err.message }; }
});
ipcMain.handle('embed:embed', async (_e, args = {}) => {
  try {
    const e = require('./lib/llm/embed-stub');
    return { ok: true, vector: await e.embed(args.text || '') };
  } catch (err) { return { ok: false, error: 'EMBED_FAILED', message: err && err.message }; }
});
ipcMain.handle('embed:similar', async (_e, args = {}) => {
  try {
    const e = require('./lib/llm/embed-stub');
    const top = await e.topKSimilar(args.query || '', args.candidates || [], args.k || 5);
    return { ok: true, top };
  } catch (err) { return { ok: false, error: 'EMBED_SIMILAR_FAILED', message: err && err.message }; }
});
ipcMain.handle('local:run', async (_e, args = {}) => {
  try {
    const l = require('./lib/llm/local-stub');
    const text = await l.runLocal(args.prompt || '', args.options || {});
    return { ok: true, text };
  } catch (err) { return { ok: false, error: 'LOCAL_RUN_FAILED', message: err && err.message }; }
});
ipcMain.handle('local:available', async () => {
  try {
    const l = require('./lib/llm/local-stub');
    return { ok: true, available: await l.isOllamaAvailable() };
  } catch (err) { return { ok: false, error: 'LOCAL_AVAIL_FAILED', message: err && err.message }; }
});
ipcMain.handle('pack:context', async (_e, args = {}) => {
  try {
    const p = require('./lib/llm/context-packer');
    return { ok: true, ...(await p.packContext(args)) };
  } catch (err) { return { ok: false, error: 'PACK_CONTEXT_FAILED', message: err && err.message }; }
});

// ─── W5.3 Living Note Reactivation (BLUEPRINT §10.2) ────────────────────
// 9 life states + Utility Score + 8-scene reactivator + Dead-Note Detector
// + 6-target Crystallizer. Theory-ship: surface contract locked, UI hook is
// inline callout in lesson-chat + audit panel under notebook screen.
// All verbs return the standard hypha envelope { ok, ... } | { ok:false, error, message }.
ipcMain.handle('livingnote:state', async (_e, args = {}) => {
  try {
    const m = require('./lib/living-note/states');
    return { ok: true, states: m.LIFE_STATES, transitions: m.STATE_TRANSITIONS };
  } catch (err) { return { ok: false, error: 'LIVING_NOTE_STATE_FAILED', message: err && err.message }; }
});
ipcMain.handle('livingnote:transition', async (_e, args = {}) => {
  try {
    const m = require('./lib/living-note/states');
    const { nodePath, fromState, toState, reason } = args;
    const out = m.transitionNoteState(nodePath, fromState, toState, reason);
    return { ok: true, ...out };
  } catch (err) { return { ok: false, error: 'LIVING_NOTE_TRANSITION_FAILED', message: err && err.message }; }
});
ipcMain.handle('livingnote:utility', async (_e, args = {}) => {
  try {
    const m = require('./lib/living-note/utility-score');
    const { noteData, notes, k } = args;
    if (Array.isArray(notes)) {
      return { ok: true, ranked: m.rankNotesByUtility(notes, k || 20) };
    }
    return { ok: true, ...m.computeUtilityScore(noteData || {}) };
  } catch (err) { return { ok: false, error: 'LIVING_NOTE_UTILITY_FAILED', message: err && err.message }; }
});
ipcMain.handle('livingnote:reactivate', async (_e, args = {}) => {
  try {
    const m = require('./lib/living-note/reactivator');
    const { slug, scene, queryText, threshold, limit } = args;
    const candidates = m.findReactivationCandidates(slug, scene, { queryText, threshold, limit });
    return { ok: true, scene, candidates };
  } catch (err) { return { ok: false, error: 'LIVING_NOTE_REACTIVATE_FAILED', message: err && err.message }; }
});
ipcMain.handle('livingnote:detectDead', async (_e, args = {}) => {
  try {
    const m = require('./lib/living-note/dead-note-detector');
    return { ok: true, dead: m.detectDeadNotes(args.slug) };
  } catch (err) { return { ok: false, error: 'LIVING_NOTE_DEAD_FAILED', message: err && err.message }; }
});
ipcMain.handle('livingnote:archive', async (_e, args = {}) => {
  try {
    const m = require('./lib/living-note/dead-note-detector');
    const { slug, dryRun, paths } = args;
    const out = m.archiveDeadNotes(slug, dryRun !== false, paths);
    return { ok: true, ...out };
  } catch (err) { return { ok: false, error: 'LIVING_NOTE_ARCHIVE_FAILED', message: err && err.message }; }
});
ipcMain.handle('livingnote:crystallize', async (_e, args = {}) => {
  try {
    const m = require('./lib/living-note/crystallizer');
    const { slug, noteId, targetType, hint, skipGate } = args;
    const out = m.crystallizeNote(slug, noteId, targetType, { hint, skipGate });
    return { ok: true, ...out };
  } catch (err) { return { ok: false, error: 'LIVING_NOTE_CRYSTALLIZE_FAILED', message: err && err.message }; }
});

// ──────────────────────────────────────────────────────────────────────────
// W5.2 Web Note Engine — 6-layer entropy-reduction graph (BLUEPRINT §10.1).
// Spider-web stack: Raw → Atomic → Concept → Spark → Product Spark → Kernel.
// 13 typed edges + Context Packet + Entropy Reduction Cycle. Renderer talks
// to this surface via window.ptor.webnote.*. LLM tier calls are mocked at
// the lib level — Context Packet pairs with W5.1 cheap-router.packContext if
// shipped; falls back to local deterministic packer otherwise. Per task brief.
// ──────────────────────────────────────────────────────────────────────────
function _webNoteEngine() { return require('./lib/web-note-engine'); }

ipcMain.handle('webnote:addNode', async (_e, { slug, node } = {}) => {
  try { return _webNoteEngine().graph.addNode(slug, node); }
  catch (err) { return { ok: false, error: 'WEBNOTE_ADD_NODE_FAILED', message: err && err.message }; }
});

ipcMain.handle('webnote:addEdge', async (_e, { slug, edge } = {}) => {
  try { return _webNoteEngine().graph.addEdge(slug, edge); }
  catch (err) { return { ok: false, error: 'WEBNOTE_ADD_EDGE_FAILED', message: err && err.message }; }
});

ipcMain.handle('webnote:getNode', async (_e, { slug, nodeId } = {}) => {
  try {
    const node = _webNoteEngine().graph.getNode(slug, nodeId);
    return { ok: true, node };
  } catch (err) { return { ok: false, error: 'WEBNOTE_GET_NODE_FAILED', message: err && err.message }; }
});

ipcMain.handle('webnote:listNodes', async (_e, { slug, filter } = {}) => {
  try { return { ok: true, nodes: _webNoteEngine().graph.listNodes(slug, filter || {}) }; }
  catch (err) { return { ok: false, error: 'WEBNOTE_LIST_NODES_FAILED', message: err && err.message }; }
});

ipcMain.handle('webnote:getEdges', async (_e, { slug, nodeId, direction, filter } = {}) => {
  try { return { ok: true, edges: _webNoteEngine().graph.getEdges(slug, nodeId, direction || 'both', filter || {}) }; }
  catch (err) { return { ok: false, error: 'WEBNOTE_GET_EDGES_FAILED', message: err && err.message }; }
});

ipcMain.handle('webnote:walk', async (_e, { slug, startId, opts } = {}) => {
  try { return { ok: true, walk: _webNoteEngine().graph.walkGraph(slug, startId, opts || {}) }; }
  catch (err) { return { ok: false, error: 'WEBNOTE_WALK_FAILED', message: err && err.message }; }
});

ipcMain.handle('webnote:merge', async (_e, { slug, nodeIds, mergedNode } = {}) => {
  try { return _webNoteEngine().graph.mergeNodes(slug, nodeIds, mergedNode); }
  catch (err) { return { ok: false, error: 'WEBNOTE_MERGE_FAILED', message: err && err.message }; }
});

// Layer promotion — single IPC dispatches via { direction } so the renderer
// surface stays compact. direction ∈ { raw_to_atomic, atomic_to_concept,
// to_spark, to_product_spark }.
ipcMain.handle('webnote:promote', async (_e, args = {}) => {
  try {
    const { slug, direction } = args;
    const lp = _webNoteEngine().layerPromotion;
    if (!slug) return { ok: false, error: 'WEBNOTE_PROMOTE_NO_SLUG' };
    switch (direction) {
      case 'raw_to_atomic':
        return await lp.promoteRawToAtomic(slug, args.sourceId, args.config || {});
      case 'atomic_to_concept':
        return await lp.promoteAtomicToConcept(slug, args.atomicIds || [], args.conceptName || '');
      case 'to_spark':
        return await lp.promoteToSpark(slug, args.sourceId, args.sparkData || {});
      case 'to_product_spark':
        return await lp.promoteToProductSpark(slug, args.sparkId, args.productSlug || slug);
      default:
        return { ok: false, error: 'WEBNOTE_PROMOTE_UNKNOWN_DIRECTION', message: 'direction: ' + direction };
    }
  } catch (err) { return { ok: false, error: 'WEBNOTE_PROMOTE_FAILED', message: err && err.message }; }
});

ipcMain.handle('webnote:distillKernel', async (_e, { slug, nodeIds, opts } = {}) => {
  try { return await _webNoteEngine().layerPromotion.distillKernel(slug, nodeIds || [], opts || {}); }
  catch (err) { return { ok: false, error: 'WEBNOTE_DISTILL_FAILED', message: err && err.message }; }
});

ipcMain.handle('webnote:contextPacket', async (_e, { slug, queryNodeId, budgetTokens, opts } = {}) => {
  try {
    return await _webNoteEngine().contextPacket.buildContextPacket(
      slug, queryNodeId, budgetTokens || 2000, opts || {}
    );
  } catch (err) { return { ok: false, error: 'WEBNOTE_PACKET_FAILED', message: err && err.message }; }
});

ipcMain.handle('webnote:entropyReduction', async (_e, { slug, opts } = {}) => {
  try { return await _webNoteEngine().entropyReduction.runEntropyReductionCycle(slug, opts || {}); }
  catch (err) { return { ok: false, error: 'WEBNOTE_ENTROPY_FAILED', message: err && err.message }; }
});

// ──────────────────────────────────────────────────────────────────────────
// W6.4 Curriculum Graph — BLUEPRINT §20 v1.8. Single-domain AI/CS DAG with
// 48 knowledge points + prereq edges + difficulty / canonical example /
// assignment types / frontier bridges. Engine is pure (no vault writes); IPC
// surface exposes load / findPath / recommendNext / kpForGoal / frontierBridge
// / buildCustom for renderer-side use. Domain expansion beyond AI/CS deferred
// per blueprint scope freeze.
// ──────────────────────────────────────────────────────────────────────────
let _curgraphMod;
function _curgraph() {
  if (!_curgraphMod) _curgraphMod = require('./lib/curriculum-graph/graph-engine');
  return _curgraphMod;
}
ipcMain.handle('curgraph:load', async () => {
  try {
    const data = _curgraph().loadGraph();
    // Strip internal _byId index before sending across IPC.
    const { _byId, ...safe } = data;
    return { ok: true, graph: safe };
  } catch (err) {
    return { ok: false, error: 'CURGRAPH_LOAD_FAILED', message: err && err.message };
  }
});
ipcMain.handle('curgraph:findPath', async (_e, { fromKpId, toKpId } = {}) => {
  try {
    const ids = _curgraph().findPath(fromKpId || null, toKpId);
    return { ok: true, path: ids };
  } catch (err) {
    return { ok: false, error: 'CURGRAPH_FINDPATH_FAILED', message: err && err.message };
  }
});
ipcMain.handle('curgraph:recommendNext', async (_e, { masteredKpIds, limit } = {}) => {
  try {
    const recs = _curgraph().recommendNextKP(masteredKpIds || [], limit || 5);
    return { ok: true, recommendations: recs };
  } catch (err) {
    return { ok: false, error: 'CURGRAPH_RECOMMEND_FAILED', message: err && err.message };
  }
});
ipcMain.handle('curgraph:kpForGoal', async (_e, { goalText, k } = {}) => {
  try {
    const matches = await _curgraph().kpForGoal(goalText || '', k || 3);
    return { ok: true, matches };
  } catch (err) {
    return { ok: false, error: 'CURGRAPH_KPFORGOAL_FAILED', message: err && err.message };
  }
});
ipcMain.handle('curgraph:frontierBridge', async (_e, { kpId } = {}) => {
  try {
    const bridge = _curgraph().getFrontierBridge(kpId);
    return { ok: true, bridge };
  } catch (err) {
    return { ok: false, error: 'CURGRAPH_FRONTIER_FAILED', message: err && err.message };
  }
});
ipcMain.handle('curgraph:buildCustom', async (_e, { goalContract, targetTotalLessons } = {}) => {
  try {
    return await _curgraph().buildCustomCurriculum(goalContract || {}, targetTotalLessons || 16);
  } catch (err) {
    return { ok: false, error: 'CURGRAPH_BUILDCUSTOM_FAILED', message: err && err.message };
  }
});

// =====================================================================
// W6.3 Research Radar — BLUEPRINT §15 + ROADMAP v1.7
// Subscriptions persist per slug at vault/<slug>/research-radar/
// subscriptions.json. runRadarCycle invokes W5.1 cheap-router for the
// T0+T1 first-pass filter and W3.4 product-spark / W5.2 web-note-engine
// for the downstream auto-actions. Cron entry: radar:runDaily.
// =====================================================================
function _radarLib() { return require('./lib/research-radar'); }

ipcMain.handle('radar:subscribe', async (_e, { slug, topic, options } = {}) => {
  try { return _radarLib().subscribeTopic(slug, topic, options || {}); }
  catch (err) { return { ok: false, error: 'RADAR_SUBSCRIBE_FAILED', message: err && err.message }; }
});
ipcMain.handle('radar:unsubscribe', async (_e, { slug, topic } = {}) => {
  try { return _radarLib().unsubscribeTopic(slug, topic); }
  catch (err) { return { ok: false, error: 'RADAR_UNSUBSCRIBE_FAILED', message: err && err.message }; }
});
ipcMain.handle('radar:list', async (_e, { slug } = {}) => {
  try { return { ok: true, subscriptions: _radarLib().listSubscriptions(slug) }; }
  catch (err) { return { ok: false, error: 'RADAR_LIST_FAILED', message: err && err.message }; }
});
ipcMain.handle('radar:run', async (_e, { slug, topic, opts } = {}) => {
  try { return await _radarLib().runRadarCycle(slug, topic || undefined, opts || {}); }
  catch (err) { return { ok: false, error: 'RADAR_RUN_FAILED', message: err && err.message }; }
});
ipcMain.handle('radar:runDaily', async (_e, opts = {}) => {
  try { return await _radarLib().runDailyRadar(opts || {}); }
  catch (err) { return { ok: false, error: 'RADAR_RUN_DAILY_FAILED', message: err && err.message }; }
});
ipcMain.handle('radar:report', async (_e, { slug, topic, all } = {}) => {
  try {
    const lib = _radarLib();
    if (all) return { ok: true, reports: lib.listAllReports(slug) };
    if (topic) return { ok: true, latest: lib.getLatestReport(slug, topic), reports: lib.listReports(slug, topic) };
    return { ok: false, error: 'RADAR_REPORT_NEED_TOPIC_OR_ALL' };
  } catch (err) { return { ok: false, error: 'RADAR_REPORT_FAILED', message: err && err.message }; }
});
ipcMain.handle('radar:formatReport', async (_e, { report } = {}) => {
  try { return { ok: true, markdown: _radarLib().formatReportMarkdown(report || {}) }; }
  catch (err) { return { ok: false, error: 'RADAR_FORMAT_FAILED', message: err && err.message }; }
});
ipcMain.handle('radar:lessonCitationHook', async (_e, { slug, lessonIdx } = {}) => {
  try { return _radarLib().lessonCitationHook(slug, lessonIdx); }
  catch (err) { return { ok: false, error: 'RADAR_CITE_HOOK_FAILED', message: err && err.message }; }
});
ipcMain.handle('radar:triggerSpark', async (_e, { slug, candidate, reportContext } = {}) => {
  try { return _radarLib().triggerProductSparkCandidate(slug, candidate || {}, reportContext || {}); }
  catch (err) { return { ok: false, error: 'RADAR_TRIGGER_SPARK_FAILED', message: err && err.message }; }
});
ipcMain.handle('radar:storeAsNote', async (_e, { slug, report } = {}) => {
  try { return _radarLib().storeAsNote(slug, report || {}); }
  catch (err) { return { ok: false, error: 'RADAR_STORE_NOTE_FAILED', message: err && err.message }; }
});

// ── W7.2 Exam System (Alpha — 考研英语) ──────────────────────────────────
// Per BLUEPRINT §13 + specs/exam-model-alpha.md.
//   exam:scope / exam:setScope / exam:classifyTopic / exam:tierProgress
//   exam:cadence
//   exam:importBank / exam:listBanks / exam:bankItem / exam:tagItem
//   exam:diagnose / exam:errorLog / exam:appendError / exam:errorCounts
//   exam:enterFinal / exam:finalTasks / exam:dailyFinal / exam:finalState
// All handlers return { ok, ... } | { ok:false, error } envelope.
let _examLibs = null;
function _exam() {
  if (_examLibs) return _examLibs;
  _examLibs = {
    scope:  require('./lib/exam-system/scope-engine'),
    cad:    require('./lib/exam-system/exam-cadence'),
    bank:   require('./lib/exam-system/user-bank'),
    err:    require('./lib/exam-system/error-diagnosis'),
    final:  require('./lib/exam-system/final-compression'),
    judge:  require('./lib/exam-system/judge'),
  };
  return _examLibs;
}
function _wrap(fn) {
  return async (_e, args = {}) => {
    try {
      const result = await fn(args || {});
      return { ok: true, ...(result && typeof result === 'object' && !Array.isArray(result)
        ? result
        : { result }) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  };
}
ipcMain.handle('exam:scope',         _wrap(({ slug, examType }) => ({ scope: _exam().scope.getScope(slug, examType) })));
ipcMain.handle('exam:setScope',      _wrap(({ slug, customScope }) => ({ scope: _exam().scope.setScope(slug, customScope) })));
ipcMain.handle('exam:classifyTopic', _wrap(({ topicText, scope }) => ({ tier: _exam().scope.classifyTopic(topicText, scope) })));
ipcMain.handle('exam:tierProgress',  _wrap(({ slug, completedTopics }) => ({ progress: _exam().scope.tierProgress(slug, completedTopics) })));
ipcMain.handle('exam:cadence',       _wrap(({ daysRemaining, currentScopeProgress, errorAccumulation }) =>
  ({ cadence: _exam().cad.computeExamCadence({ daysRemaining, currentScopeProgress, errorAccumulation }) })));
ipcMain.handle('exam:importBank',    _wrap(({ slug, bankFile }) => _exam().bank.importBank(slug, bankFile)));
ipcMain.handle('exam:listBanks',     _wrap(({ slug }) => ({ banks: _exam().bank.listBanks(slug) })));
ipcMain.handle('exam:bankItem',      _wrap(({ slug, bankId, itemIdx }) => ({ item: _exam().bank.getBankItem(slug, bankId, itemIdx) })));
ipcMain.handle('exam:tagItem',       _wrap(({ slug, bankId, itemIdx, patch }) => ({ item: _exam().bank.tagItem(slug, bankId, itemIdx, patch) })));
ipcMain.handle('exam:diagnose',      _wrap(({ question, userAnswer, correctAnswer, context }) =>
  ({ diagnosis: _exam().err.diagnoseError({ question, userAnswer, correctAnswer, context }) })));
ipcMain.handle('exam:errorLog',      _wrap(({ slug, limit }) => ({ log: _exam().err.getErrorLog(slug, limit) })));
ipcMain.handle('exam:appendError',   _wrap(({ slug, error }) => _exam().err.appendError(slug, error)));
ipcMain.handle('exam:errorCounts',   _wrap(({ slug }) => ({ counts: _exam().err.errorCountsByCause(slug) })));
ipcMain.handle('exam:enterFinal',    _wrap(({ slug }) => _exam().final.enterFinalCompression(slug)));
ipcMain.handle('exam:finalTasks',    _wrap(({ slug }) => ({ tasks: _exam().final.finalTasks(slug) })));
ipcMain.handle('exam:dailyFinal',    _wrap(({ slug, daysRemaining }) => _exam().final.dailyFinalPlan(slug, daysRemaining)));
ipcMain.handle('exam:finalState',    _wrap(({ slug }) => ({ state: _exam().final.getFinalState(slug) })));
// T4_JUDGE LLM micro-judge for open-ended exam answers (closes v1.0 gap).
// Returns { ok, judgement: { verdict, confidence, reasoning, concept_gaps, suggested_next, _meta } }.
// Pre-call cost gate fires inside executeChat when userId supplied.
ipcMain.handle('exam:judge-open',    _wrap(async ({ question, userAnswer, rubric, modelAnswer, slug, userId, tier }) => ({
  judgement: await _exam().judge.judgeOpenAnswer(
    { question, userAnswer, rubric, modelAnswer },
    { slug, userId, tier },
  ),
})));

// α18 · Final Compression Mode v0 (蓝图 §30, app/lib/exam/final-compression.js)
// 与上面 W7.2 exam:enterFinal 并存:本 4 个 IPC 用 {ok, ...} envelope + slug-scoped
// 状态文件,服务考前压缩简洁触发栏 UI(screen-exam-dashboard.jsx ScopeBlock 之前)。
ipcMain.handle('final-compression:enter',    async (_e, p = {}) => require('./lib/exam/final-compression').enterFinalMode(p));
ipcMain.handle('final-compression:exit',     async (_e, p = {}) => require('./lib/exam/final-compression').exitFinalMode(p));
ipcMain.handle('final-compression:state',    async (_e, p = {}) => require('./lib/exam/final-compression').getFinalState(p));
ipcMain.handle('final-compression:compress', async (_e, p = {}) => require('./lib/exam/final-compression').compressScope(p));

// γ18 Thinking Tools (Growth System §28 子组件 v0, 2026-05-16)
ipcMain.handle('thinking-tools:list',            async () => require('./lib/growth/thinking-tools').listTools());
ipcMain.handle('thinking-tools:get',             async (_e, p = {}) => require('./lib/growth/thinking-tools').getTool(p && p.toolId));
ipcMain.handle('thinking-tools:invoke',          async (_e, p = {}) => require('./lib/growth/thinking-tools').invokeTool(p));
ipcMain.handle('thinking-tools:listInvocations', async (_e, p = {}) => require('./lib/growth/thinking-tools').listInvocations(p));

// ── W7.1 Pack Learning Mode (BLUEPRINT §12.4 + §12.5) ─────────────────────
// 6 operations (preview / quickLearn / deepLearn / apply / fork / transfer)
// + 9-state machine (Imported → Crystallized, 8 transitions)
// + Pack Learning Path (multi-lesson plan keyed to user mastery)
// + Pack Study Note (per-(slug, packId) markdown accretion file)
// + Parking Queue (per-slug parked-pack list + suggestRevival ranking).
// All LLM-touching ops are MOCKED at the lib level — see operations.js.
// Lib deps: ../commons/pack-intelligence-card (W6.5),
// ../product-transfer (W3.3), ../llm/embed-stub (W5.1). All read-only.
let _packLearn = null;
function _packLearnLibs() {
  if (_packLearn) return _packLearn;
  _packLearn = {
    ops:     require('./lib/pack-learning/operations'),
    sm:      require('./lib/pack-learning/state-machine'),
    path:    require('./lib/pack-learning/learning-path'),
    parking: require('./lib/pack-learning/parking-queue'),
  };
  return _packLearn;
}
ipcMain.handle('pack:preview', _wrap(({ pack, userContext }) =>
  ({ preview: _packLearnLibs().ops.previewPack(pack, userContext || {}) })));
ipcMain.handle('pack:quickLearn', _wrap(({ pack, options }) =>
  ({ result: _packLearnLibs().ops.quickLearn(pack, options || {}) })));
ipcMain.handle('pack:deepLearn', _wrap(({ pack, options }) =>
  ({ plan: _packLearnLibs().ops.deepLearn(pack, options || {}) })));
ipcMain.handle('pack:apply', _wrap(({ pack, currentProblem }) =>
  ({ applied: _packLearnLibs().ops.applyPack(pack, currentProblem || {}) })));
ipcMain.handle('pack:fork', _wrap(({ pack, options }) =>
  ({ fork: _packLearnLibs().ops.forkAndRewrite(pack, options || {}) })));
ipcMain.handle('pack:transferToProduct', _wrap(({ pack, slug, options }) =>
  ({ transfer: _packLearnLibs().ops.transferToProduct(pack, slug, options || {}) })));
// State-machine surface
ipcMain.handle('pack:state', _wrap(({ packId }) =>
  ({ states: _packLearnLibs().sm.PACK_LEARNING_STATES, record: _packLearnLibs().sm.getPackState(packId) })));
ipcMain.handle('pack:transition', _wrap(({ packId, fromState, toState, reason }) =>
  ({ record: _packLearnLibs().sm.transitionPackState(packId, fromState, toState, reason || '') })));
ipcMain.handle('pack:getValidTransitions', _wrap(({ currentState }) =>
  ({ next: _packLearnLibs().sm.getValidTransitions(currentState) })));
// Learning path + study note
ipcMain.handle('pack:buildPath', _wrap(({ pack, userMastery }) =>
  ({ path: _packLearnLibs().path.buildPackLearningPath(pack, userMastery || {}) })));
ipcMain.handle('pack:getStudyNote', _wrap(({ packId, slug }) =>
  ({ note: _packLearnLibs().path.getPackStudyNote(packId, slug) })));
ipcMain.handle('pack:appendStudyNote', _wrap(({ packId, slug, content }) =>
  ({ append: _packLearnLibs().path.appendPackStudyNote(packId, slug, content || '') })));
// Parking queue
ipcMain.handle('pack:park', _wrap(({ slug, packId, reason, meta }) =>
  ({ parked: _packLearnLibs().parking.parkPack(slug, packId, reason || '', meta || {}) })));
ipcMain.handle('pack:listParked', _wrap(({ slug }) =>
  ({ parked: _packLearnLibs().parking.getParkedPacks(slug) })));
ipcMain.handle('pack:unpark', _wrap(({ slug, packId, reason }) =>
  _packLearnLibs().parking.unparkPack(slug, packId, reason || '')));
ipcMain.handle('pack:suggestRevival', async (_e, { slug, currentLessonContext, options } = {}) => {
  try {
    const candidates = await _packLearnLibs().parking.suggestRevival(slug, currentLessonContext, options || {});
    return { ok: true, candidates };
  } catch (err) {
    return { ok: false, error: 'PACK_REVIVAL_FAILED', message: err && err.message };
  }
});

// ──────────────────────────────────────────────────────────────────────────
// W7.4 Cross-Spark + Thinking Tools + Judgment Gym (BLUEPRINT §14.2-14.4).
//
// Surface boundary:
//   - thinkingtools:*               read-only library (12 cognitive tools)
//   - crossspark:generate / history 6-step跨域 spark flow (mock T6_STRONG)
//   - crossspark:autoCreateSpark    bridge into W3.4 product-spark.createSpark
//   - judgmentgym:create / submit / history  paired-comparison训练场 (5 types)
//
// All handlers swallow throws into the standard envelope so the renderer
// never crashes from a malformed problem string or a missing spark.
// ──────────────────────────────────────────────────────────────────────────
// boot-10 lazy-wrap — cross-spark cluster combined 1254 LOC (engine 403 +
// thinking-tools 365 + judgment-gym 377 + auto-product-spark 109). Fires
// only on thinkingtools:* / crossspark:* / judgmentgym:* IPC surfaces.
let __xsThinkingMod = null;
const _xsThinking = new Proxy({}, {
  get(_t, p) {
    if (!__xsThinkingMod) __xsThinkingMod = require('./lib/cross-spark/thinking-tools');
    return __xsThinkingMod[p];
  },
});
let __xsEngineMod = null;
const _xsEngine = new Proxy({}, {
  get(_t, p) {
    if (!__xsEngineMod) __xsEngineMod = require('./lib/cross-spark/engine');
    return __xsEngineMod[p];
  },
});
let __xsJudgmentMod = null;
const _xsJudgment = new Proxy({}, {
  get(_t, p) {
    if (!__xsJudgmentMod) __xsJudgmentMod = require('./lib/cross-spark/judgment-gym');
    return __xsJudgmentMod[p];
  },
});
let __xsAutoMod = null;
const _xsAuto = new Proxy({}, {
  get(_t, p) {
    if (!__xsAutoMod) __xsAutoMod = require('./lib/cross-spark/auto-product-spark');
    return __xsAutoMod[p];
  },
});

function _xsErr(err, code) {
  return {
    ok: false,
    error: err && err.message ? err.message : String(err),
    code: code || (err && err.code) || 'XSPARK_UNKNOWN',
  };
}

ipcMain.handle('thinkingtools:list', async () => {
  try { return { ok: true, tools: _xsThinking.listTools() }; }
  catch (err) { return _xsErr(err, 'XSPARK_TOOLS_LIST_FAIL'); }
});

ipcMain.handle('thinkingtools:get', async (_e, { toolId } = {}) => {
  try {
    const tool = _xsThinking.getTool(toolId);
    if (!tool) return { ok: false, error: `tool not found: ${toolId}`, code: 'XSPARK_TOOL_NOT_FOUND' };
    return { ok: true, tool };
  } catch (err) { return _xsErr(err, 'XSPARK_TOOL_GET_FAIL'); }
});

ipcMain.handle('thinkingtools:recommend', async (_e, { problem } = {}) => {
  try { return { ok: true, recommended: _xsThinking.recommendTool(problem || '') }; }
  catch (err) { return _xsErr(err, 'XSPARK_TOOL_RECOMMEND_FAIL'); }
});

ipcMain.handle('crossspark:generate', async (_e, { currentProblem, currentDomain, slug } = {}) => {
  try {
    const spark = await _xsEngine.generateCrossSpark({ currentProblem, currentDomain, slug });
    return { ok: true, spark };
  } catch (err) { return _xsErr(err, 'XSPARK_GENERATE_FAIL'); }
});

ipcMain.handle('crossspark:history', async (_e, { slug } = {}) => {
  try {
    const history = await _xsEngine.loadHistory(slug);
    return { ok: true, history };
  } catch (err) { return _xsErr(err, 'XSPARK_HISTORY_FAIL'); }
});

ipcMain.handle('crossspark:autoCreateSpark', async (_e, { crossSparkResult, slug } = {}) => {
  try { return await _xsAuto.autoCreateProductSpark({ crossSparkResult, slug }); }
  catch (err) { return _xsErr(err, 'XSPARK_AUTO_FAIL'); }
});

ipcMain.handle('judgmentgym:create', async (_e, { type, optionA, optionB, context, slug, dimensions } = {}) => {
  try {
    const exercise = _xsJudgment.createJudgmentExercise({ type, optionA, optionB, context, slug, dimensions });
    return { ok: true, exercise };
  } catch (err) { return _xsErr(err, 'XSPARK_JUDGMENT_CREATE_FAIL'); }
});

ipcMain.handle('judgmentgym:submit', async (_e, { exerciseId, userJudgment, slug, exerciseObject } = {}) => {
  try { return _xsJudgment.submitJudgment(exerciseId, userJudgment, { slug, exerciseObject }); }
  catch (err) { return _xsErr(err, 'XSPARK_JUDGMENT_SUBMIT_FAIL'); }
});

ipcMain.handle('judgmentgym:history', async (_e, { slug } = {}) => {
  try { return { ok: true, ..._xsJudgment.getJudgmentHistory(slug) }; }
  catch (err) { return _xsErr(err, 'XSPARK_JUDGMENT_HISTORY_FAIL'); }
});

// ── W8.3 Adaptive UX Personal Forks ──────────────────────────────────────
// Per BLUEPRINT §20 v3.0. User-side UX fork layer; manuscript register
// invariants enforced by register-guardrail before any write.
let _adaptiveUx = null;
function _ux() {
  if (_adaptiveUx) return _adaptiveUx;
  _adaptiveUx = {
    prefs:    require('./lib/adaptive-ux/preferences'),
    fork:     require('./lib/adaptive-ux/persona-fork'),
    guard:    require('./lib/adaptive-ux/register-guardrail'),
    render:   require('./lib/adaptive-ux/render-modifier'),
  };
  return _adaptiveUx;
}
ipcMain.handle('ux:loadPrefs',   _wrap(({ slug } = {}) => _ux().prefs.loadUserPreferences(slug)));
ipcMain.handle('ux:updatePref',  _wrap(({ slug, key, value } = {}) => _ux().prefs.updateUserPreference(slug || null, key, value)));
ipcMain.handle('ux:reset',       _wrap(({ slug } = {}) => _ux().prefs.resetToDefault(slug || null)));
ipcMain.handle('ux:forkPersona', _wrap(({ basePersonaId, overrides } = {}) => _ux().fork.forkPersona(basePersonaId, overrides || {})));
ipcMain.handle('ux:listForks',   _wrap(() => ({ forks: _ux().fork.listForkedPersonas() })));
ipcMain.handle('ux:deleteFork',  _wrap(({ forkId } = {}) => _ux().fork.deleteForkedPersona(forkId)));
ipcMain.handle('ux:validate',    _wrap(({ prefs } = {}) => _ux().guard.validatePreferences(prefs)));
ipcMain.handle('ux:applySafely', _wrap(({ prefs } = {}) => {
  try { return { sanitized: _ux().guard.applyPreferencesSafely(prefs), ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.message || err), reasons: err.reasons || [] }; }
}));
ipcMain.handle('ux:applyDensity',          _wrap(({ text, density } = {}) => ({ text: _ux().render.applyDensity(text, density) })));
ipcMain.handle('ux:applyLanguage',         _wrap(({ text, language } = {}) => ({ text: _ux().render.applyLanguage(text, language) })));
ipcMain.handle('ux:applyCadenceIntensity', _wrap(({ plan, intensity } = {}) => ({ plan: _ux().render.applyCadenceIntensity(plan, intensity) })));

// ── W8.4 Feedback + Donate + Cashflow Shield + Cost Budget ──────────────────
// Per BLUEPRINT §19 (commercial structure) + §17.3 (cashflow shield).
// Lazy-load so a missing module doesn't break unrelated IPC startup.
let _feedbackCh = null;
function _fb() { if (!_feedbackCh) _feedbackCh = require('./lib/feedback-channel/feedback'); return _feedbackCh; }
let _donate = null;
function _dn() { if (!_donate) _donate = require('./lib/donate/donate'); return _donate; }
let _costBudget = null;
function _cb() { if (!_costBudget) _costBudget = require('./lib/cashflow-shield/cost-budget'); return _costBudget; }
let _shield = null;
function _sh() { if (!_shield) _shield = require('./lib/cashflow-shield/shield'); return _shield; }
function _w84Err(err, code) {
  return { ok: false, error: String(err && err.message || err), code: code || 'W84_ERR' };
}

// Feedback Channel
ipcMain.handle('feedback:submit',  async (_e, { slug, type, content, attachments } = {}) => {
  try { return _fb().submitFeedback(slug, { type, content, attachments }); }
  catch (err) { return _w84Err(err, 'FB_SUBMIT_FAIL'); }
});
ipcMain.handle('feedback:list',    async (_e, { filter } = {}) => {
  try { return { ok: true, items: _fb().listFeedback(filter || {}) }; }
  catch (err) { return _w84Err(err, 'FB_LIST_FAIL'); }
});
ipcMain.handle('feedback:get',     async (_e, { id } = {}) => {
  try {
    const item = _fb().getFeedback(id);
    return item ? { ok: true, item } : { ok: false, error: 'not_found' };
  } catch (err) { return _w84Err(err, 'FB_GET_FAIL'); }
});
ipcMain.handle('feedback:accept',  async (_e, { id, rewardType, rewardAmount } = {}) => {
  try { return _fb().markFeedbackAccepted(id, rewardType, rewardAmount); }
  catch (err) { return _w84Err(err, 'FB_ACCEPT_FAIL'); }
});
ipcMain.handle('feedback:rewards', async (_e, { userId } = {}) => {
  try { return { ok: true, ..._fb().getRewardHistory(userId) }; }
  catch (err) { return _w84Err(err, 'FB_REWARDS_FAIL'); }
});
ipcMain.handle('feedback:types',   async () => {
  try { return { ok: true, types: _fb().FEEDBACK_TYPES, rewards: _fb().REWARD_TYPES, disclaimer: _fb().ANTI_PROMISE_DISCLAIMER }; }
  catch (err) { return _w84Err(err, 'FB_TYPES_FAIL'); }
});

// Donate
ipcMain.handle('donate:tiers',       async () => {
  try { return { ok: true, tiers: _dn().getDonateTiers() }; }
  catch (err) { return _w84Err(err, 'DN_TIERS_FAIL'); }
});
ipcMain.handle('donate:record',      async (_e, { userId, amount, tier } = {}) => {
  try { return _dn().recordDonation(userId, amount, tier); }
  catch (err) { return _w84Err(err, 'DN_RECORD_FAIL'); }
});
ipcMain.handle('donate:legal',       async () => {
  try { return { ok: true, text: _dn().getDonateLegalText() }; }
  catch (err) { return _w84Err(err, 'DN_LEGAL_FAIL'); }
});
ipcMain.handle('donate:list',        async (_e, { userId, tier } = {}) => {
  try { return { ok: true, items: _dn().listDonations({ userId, tier }) }; }
  catch (err) { return _w84Err(err, 'DN_LIST_FAIL'); }
});
ipcMain.handle('donate:antiPromise', async (_e, { content } = {}) => {
  try { return { ok: true, ..._dn().verifyAntiPromise(content) }; }
  catch (err) { return _w84Err(err, 'DN_ANTI_PROMISE_FAIL'); }
});

// Cost Budget
ipcMain.handle('cost:budget',       async (_e, { tier } = {}) => {
  try { return { ok: true, budget: _cb().LESSON_COST_BUDGET[tier || 'Pro'] || _cb().LESSON_COST_BUDGET.Pro, tier: tier || 'Pro' }; }
  catch (err) { return _w84Err(err, 'CB_BUDGET_FAIL'); }
});
ipcMain.handle('cost:record',       async (_e, { slug, lessonIdx, capability, tokens } = {}) => {
  try { return _cb().recordLLMCall(slug, lessonIdx, capability, tokens); }
  catch (err) { return _w84Err(err, 'CB_RECORD_FAIL'); }
});
ipcMain.handle('cost:remaining',    async (_e, { slug, lessonIdx, tier } = {}) => {
  try { return { ok: true, ..._cb().getRemainingBudget(slug, lessonIdx, tier || 'Pro') }; }
  catch (err) { return _w84Err(err, 'CB_REMAIN_FAIL'); }
});
ipcMain.handle('cost:wouldExceed',  async (_e, { slug, lessonIdx, capability, tier } = {}) => {
  try { return { ok: true, exceed: _cb().wouldExceedBudget(slug, lessonIdx, capability, tier || 'Pro') }; }
  catch (err) { return _w84Err(err, 'CB_EXCEED_FAIL'); }
});
ipcMain.handle('cost:report',       async (_e, { slug, period } = {}) => {
  try { return { ok: true, ..._cb().getCostReport(slug, period || 'month') }; }
  catch (err) { return _w84Err(err, 'CB_REPORT_FAIL'); }
});
// V0.5 E1 — cost-ledger transparency surface. Reads sqlite model_calls
// rows + estimation_source breakdown so renderer can flag每一行 honesty
// (real / tokenizer-fallback / placeholder / legacy). UI consumer: screen-cost-budget.jsx.
ipcMain.handle('cost:ledger',       async (_e, { period, limit } = {}) => {
  try {
    const db = _evaluatorDb();
    if (!db || typeof db.aggregateModelCallLedger !== 'function') {
      return { ok: false, error: 'CB_LEDGER_NO_SQLITE', rows: [], breakdown: {}, total: 0 };
    }
    const result = db.aggregateModelCallLedger({ period: period || 'month', limit: limit || 100 });
    return { ok: true, ...result };
  } catch (err) { return _w84Err(err, 'CB_LEDGER_FAIL'); }
});

// β21 Mastery Engine v0 — per-concept understanding EWMA.
// Signals aggregated into mastery score (0-1) per concept. !LLM, !auto-extract.
ipcMain.handle('mastery:record',         async (_e, p = {}) => require('./lib/lesson-system/mastery-tracker').recordSignal(p));
ipcMain.handle('mastery:score',          async (_e, p = {}) => require('./lib/lesson-system/mastery-tracker').getMasteryScore(p));
ipcMain.handle('mastery:list',           async (_e, p = {}) => require('./lib/lesson-system/mastery-tracker').listMastery(p));
ipcMain.handle('mastery:low',            async (_e, p = {}) => require('./lib/lesson-system/mastery-tracker').listLowMastery(p));
ipcMain.handle('mastery:signal-history', async (_e, p = {}) => require('./lib/lesson-system/mastery-tracker').getSignalHistory(p));

// Cashflow Shield
ipcMain.handle('shield:check',      async (_e, { userId, tier } = {}) => {
  try { return { ok: true, ..._sh().checkCashflowShield(userId, tier || 'Pro') }; }
  catch (err) { return _w84Err(err, 'SH_CHECK_FAIL'); }
});
ipcMain.handle('shield:enforce',    async (_e, { userId, plannedCall } = {}) => {
  try { return _sh().enforceShield(userId, plannedCall || {}); }
  catch (err) {
    // BudgetExceededError carries structured details.
    if (err && err.name === 'BudgetExceededError') {
      return { ok: false, error: err.message, code: err.code, details: err.details };
    }
    return _w84Err(err, 'SH_ENFORCE_FAIL');
  }
});
ipcMain.handle('shield:notifySoft', async (_e, { userId, tier } = {}) => {
  try { return { ok: true, ..._sh().notifyExceedSoft(userId, tier || 'Pro') }; }
  catch (err) { return _w84Err(err, 'SH_SOFT_FAIL'); }
});

// ──────────────────────────────────────────────────────────────────────────
// W8.2 Flywheel — Learning Commons Flywheel (BLUEPRINT §20 v2.5).
// Closes the loop Note → Spark → Pack → Commons → Lesson. Each library
// lives under app/lib/flywheel/. IPC envelope mirrors W3.x: ok/error.
// ──────────────────────────────────────────────────────────────────────────
// boot-10 lazy-wrap — flywheel cluster combined 1299 LOC (note-to-spark 317
// + spark-to-pack 341 + pack-to-commons 254 + commons-to-lesson 201 +
// feedback-loop 186). Fires only on flywheel:* IPC, which the renderer only
// hits when user enters the Flywheel surface.
let __fwNoteToSparkMod = null;
const _fwNoteToSpark = new Proxy({}, {
  get(_t, p) {
    if (!__fwNoteToSparkMod) __fwNoteToSparkMod = require('./lib/flywheel/note-to-spark');
    return __fwNoteToSparkMod[p];
  },
});
let __fwSparkToPackMod = null;
const _fwSparkToPack = new Proxy({}, {
  get(_t, p) {
    if (!__fwSparkToPackMod) __fwSparkToPackMod = require('./lib/flywheel/spark-to-pack');
    return __fwSparkToPackMod[p];
  },
});
let __fwPackToCommonsMod = null;
const _fwPackToCommons = new Proxy({}, {
  get(_t, p) {
    if (!__fwPackToCommonsMod) __fwPackToCommonsMod = require('./lib/flywheel/pack-to-commons');
    return __fwPackToCommonsMod[p];
  },
});
let __fwCommonsToLessonMod = null;
const _fwCommonsToLesson = new Proxy({}, {
  get(_t, p) {
    if (!__fwCommonsToLessonMod) __fwCommonsToLessonMod = require('./lib/flywheel/commons-to-lesson');
    return __fwCommonsToLessonMod[p];
  },
});
let __fwFeedbackMod = null;
const _fwFeedback = new Proxy({}, {
  get(_t, p) {
    if (!__fwFeedbackMod) __fwFeedbackMod = require('./lib/flywheel/feedback-loop');
    return __fwFeedbackMod[p];
  },
});

function _fwErr(err, code) {
  return {
    ok: false,
    error: err && err.message ? err.message : String(err),
    code: code || 'FLYWHEEL_FAIL',
  };
}

// Step 1 — Note → Spark
ipcMain.handle('flywheel:eval:note', async (_e, { slug, notePath } = {}) => {
  try { return { ok: true, ..._fwNoteToSpark.evaluateNoteForSpark(slug, notePath) }; }
  catch (err) { return _fwErr(err, 'FLYWHEEL_EVAL_NOTE_FAIL'); }
});
ipcMain.handle('flywheel:propose:noteToSpark', async (_e, { slug, notePath, opts } = {}) => {
  try { return _fwNoteToSpark.proposeNoteToSpark(slug, notePath, opts || {}); }
  catch (err) { return _fwErr(err, 'FLYWHEEL_PROPOSE_NOTE_FAIL'); }
});
ipcMain.handle('flywheel:batch:noteToSpark', async (_e, { slug } = {}) => {
  try { return _fwNoteToSpark.batchNoteToSpark(slug); }
  catch (err) { return _fwErr(err, 'FLYWHEEL_BATCH_NOTE_FAIL'); }
});

// Step 2 — Spark → Pack
ipcMain.handle('flywheel:eval:sparkCluster', async (_e, { slug, sparkIds } = {}) => {
  try { return { ok: true, ..._fwSparkToPack.evaluateSparkClusterForPack(slug, sparkIds || []) }; }
  catch (err) { return _fwErr(err, 'FLYWHEEL_EVAL_CLUSTER_FAIL'); }
});
ipcMain.handle('flywheel:propose:sparkToPack', async (_e, { slug, sparkIds } = {}) => {
  try { return _fwSparkToPack.proposeSparkClusterToPack(slug, sparkIds || []); }
  catch (err) { return _fwErr(err, 'FLYWHEEL_PROPOSE_PACK_FAIL'); }
});
ipcMain.handle('flywheel:propose:blueprintTemplate', async (_e, { slug } = {}) => {
  try { return _fwSparkToPack.proposeProductBlueprintTemplate(slug); }
  catch (err) { return _fwErr(err, 'FLYWHEEL_BLUEPRINT_TEMPLATE_FAIL'); }
});
ipcMain.handle('flywheel:propose:bookSparkPackPublic', async (_e, { bookId, slug } = {}) => {
  try { return _fwSparkToPack.proposeBookSparkPackPublic(bookId, slug); }
  catch (err) { return _fwErr(err, 'FLYWHEEL_BOOK_PACK_PUBLIC_FAIL'); }
});

// Step 3 — Pack → Commons (local staging)
ipcMain.handle('flywheel:publish:packToCommons', async (_e, { pack, options } = {}) => {
  try { return await _fwPackToCommons.publishPackToCommons(pack, options || {}); }
  catch (err) { return _fwErr(err, 'FLYWHEEL_PUBLISH_PACK_FAIL'); }
});
ipcMain.handle('flywheel:listStaged', async () => {
  try { return { ok: true, packs: _fwPackToCommons.listStagedPacks() }; }
  catch (err) { return _fwErr(err, 'FLYWHEEL_LIST_STAGED_FAIL'); }
});
ipcMain.handle('flywheel:unstage', async (_e, { packId } = {}) => {
  try { return _fwPackToCommons.unstagePack(packId); }
  catch (err) { return _fwErr(err, 'FLYWHEEL_UNSTAGE_FAIL'); }
});

// Step 4 — Commons → Lesson
ipcMain.handle('flywheel:findCommonsForLesson', async (_e, { slug, lessonTopic, opts } = {}) => {
  try { return _fwCommonsToLesson.findRelevantCommonsForLesson(slug, lessonTopic, opts || {}); }
  catch (err) { return _fwErr(err, 'FLYWHEEL_FIND_COMMONS_FAIL'); }
});
ipcMain.handle('flywheel:injectCommons', async (_e, { lessonContext, packs } = {}) => {
  try {
    const block = _fwCommonsToLesson.injectCommonsIntoLessonPrompt(lessonContext || {}, packs || []);
    return { ok: true, block };
  } catch (err) { return _fwErr(err, 'FLYWHEEL_INJECT_FAIL'); }
});

// Cycle + Health
ipcMain.handle('flywheel:cycle', async (_e, { slug, opts } = {}) => {
  try { return { ok: true, report: _fwFeedback.runFlywheelCycle(slug, opts || {}) }; }
  catch (err) { return _fwErr(err, 'FLYWHEEL_CYCLE_FAIL'); }
});
ipcMain.handle('flywheel:health', async (_e, { slug, opts } = {}) => {
  try { return _fwFeedback.getFlywheelHealth(slug, opts || {}); }
  catch (err) { return _fwErr(err, 'FLYWHEEL_HEALTH_FAIL'); }
});

// ── W8.1 Launch Readiness ───────────────────────────────────────────────
// Per BLUEPRINT §20 v2.4 / ROADMAP v2.4. Three pure read-only probes that
// integrate W1-W7 modules:
//   launch:checklist    → 20-item §20 v2.4 capability gate
//   launch:verify       → cross-W1→W7 dependency-chain check
//   launch:antiPromise  → scan free-text for §20 v2.4 banned promises
//   launch:fullReport   → composed envelope (the same shape the CLI emits)
// Lazy-loaded so the launch-readiness lib only requires when explicitly
// invoked; no LLM, no fs writes — safe to call from any renderer panel.
let _launchMods = null;
function _launch() {
  if (_launchMods) return _launchMods;
  _launchMods = {
    checklist:    require('./lib/launch-readiness/checklist'),
    verifier:     require('./lib/launch-readiness/integration-verifier'),
    antiPromise:  require('./lib/launch-readiness/anti-promise-check'),
  };
  return _launchMods;
}
function _launchErr(err, code) {
  return { ok: false, error: code || 'LAUNCH_FAIL', message: (err && err.message) || String(err) };
}

ipcMain.handle('launch:checklist', async () => {
  try { return { ok: true, report: _launch().checklist.runChecklist() }; }
  catch (err) { return _launchErr(err, 'LAUNCH_CHECKLIST_FAIL'); }
});

ipcMain.handle('launch:verify', async () => {
  try { return { ok: true, report: _launch().verifier.verifyW1ToW7Integration() }; }
  catch (err) { return _launchErr(err, 'LAUNCH_VERIFY_FAIL'); }
});

ipcMain.handle('launch:antiPromise', async (_e, { content } = {}) => {
  try { return { ok: true, scan: _launch().antiPromise.scanForOverpromises(content || '') }; }
  catch (err) { return _launchErr(err, 'LAUNCH_ANTI_PROMISE_FAIL'); }
});

ipcMain.handle('launch:fullReport', async () => {
  try {
    const L = _launch();
    // Surface positioning-module load status explicitly. A silent '' fallback
    // would make the anti-promise gate report "clean" with zero copy
    // authored — a false-positive ship signal. `source_loaded:false` forces
    // overall_ok=false until the canonical line lands.
    let positioning = '';
    let positioningSourceLoaded = false;
    let positioningLoadError = null;
    try {
      positioning = require('../scripts/_launch-positioning').LINE;
      positioningSourceLoaded = typeof positioning === 'string' && positioning.length > 0;
      if (!positioningSourceLoaded) {
        positioningLoadError = '_launch-positioning.js exports empty LINE';
      }
    } catch (err) {
      positioning = '';
      positioningLoadError = '_launch-positioning.js missing: ' + ((err && err.message) || String(err));
    }
    const checklistReport = L.checklist.runChecklist();
    const integrationReport = L.verifier.verifyW1ToW7Integration();
    const positioningScan = L.antiPromise.scanForOverpromises(positioning);
    return {
      ok: true,
      report: {
        checklist: checklistReport,
        integration: integrationReport,
        positioning: {
          line: positioning,
          scan: positioningScan,
          source_loaded: positioningSourceLoaded,
          load_error: positioningLoadError,
        },
        overall_ok:
          checklistReport.passed >= 19
          && integrationReport.integration_ok
          && positioningScan.clean
          && positioningSourceLoaded,
        generated_at: new Date().toISOString(),
      },
    };
  } catch (err) { return _launchErr(err, 'LAUNCH_FULL_FAIL'); }
});

// course:edit-goal — rewrite north_star_goal in vault/<slug>/state.json's
// goalContract. Atomic via tmp-then-rename so a crashed write can never
// leave a half-flushed state.json (downstream Goal Guardian re-reads after
// every edit). Slug validated for traversal (no '..' / '/' / '\\').
ipcMain.handle('course:edit-goal', (_e, args = {}) => {
  const { slug, newGoal } = args || {};
  if (!slug || typeof slug !== 'string') {
    return { ok: false, error: 'slug required' };
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || slug.startsWith('.')) {
    return { ok: false, error: 'invalid slug shape' };
  }
  if (typeof newGoal !== 'string' || newGoal.trim().length < 3) {
    return { ok: false, error: 'newGoal must be a string >= 3 chars' };
  }
  const root = vault.resolveRoot();
  const courseDir = path.join(root, slug);
  try {
    const dirStat = fs.statSync(courseDir);
    if (!dirStat.isDirectory()) {
      return { ok: false, error: 'slug is not a directory' };
    }
  } catch (_) {
    return { ok: false, error: 'slug directory not found' };
  }
  const stateRel = `${slug}/state.json`;
  const state = vault.readJSON(stateRel, null);
  if (!state) {
    return { ok: false, error: 'state.json not found' };
  }
  if (!state.goalContract || typeof state.goalContract !== 'object') {
    return { ok: false, error: 'goalContract missing on state.json' };
  }
  state.goalContract.north_star_goal = newGoal;
  state.goalContract.updated_at = new Date().toISOString();
  const stateAbs = path.join(courseDir, 'state.json');
  const tmpAbs = `${stateAbs}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpAbs, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpAbs, stateAbs);
  } catch (err) {
    try { fs.unlinkSync(tmpAbs); } catch (_) { /* tmp may not exist */ }
    return { ok: false, error: `atomic write failed: ${err.message}` };
  }
  // v0.4.9 — home UI reads chain.ultimate_goal, not state.goalContract.
  // Sync chain.json so 编辑目标 actually changes what the user sees.
  // Best-effort: state.json write already succeeded; chain sync failure
  // is reported as warning rather than rolling back the primary write.
  let chainWarning = null;
  const chainAbs = path.join(courseDir, 'chain.json');
  if (fs.existsSync(chainAbs)) {
    try {
      const chain = JSON.parse(fs.readFileSync(chainAbs, 'utf-8'));
      chain.ultimate_goal = newGoal;
      chain.ultimate_goal_updated_at = new Date().toISOString();
      const chainTmp = `${chainAbs}.tmp-${process.pid}-${Date.now()}`;
      try {
        fs.writeFileSync(chainTmp, JSON.stringify(chain, null, 2), 'utf-8');
        fs.renameSync(chainTmp, chainAbs);
      } catch (err) {
        try { fs.unlinkSync(chainTmp); } catch (_) { /* tmp may not exist */ }
        chainWarning = `chain.json sync failed: ${err.message}`;
      }
    } catch (err) {
      chainWarning = `chain.json sync failed: ${err.message}`;
    }
  }
  return chainWarning ? { ok: true, state, warning: chainWarning } : { ok: true, state };
});

// chain:get — read vault/<slug>/chain.json. Missing chain.json → {ok:true, chain:null}
// (older courses pre-chain feature). Slug validated for traversal.
ipcMain.handle('chain:get', (_e, args = {}) => {
  const { slug } = args || {};
  if (!slug || typeof slug !== 'string') {
    return { ok: false, error: 'slug required' };
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || slug.startsWith('.')) {
    return { ok: false, error: 'invalid slug shape' };
  }
  const root = vault.resolveRoot();
  const courseDir = path.join(root, slug);
  try {
    const dirStat = fs.statSync(courseDir);
    if (!dirStat.isDirectory()) {
      return { ok: false, error: 'slug is not a directory' };
    }
  } catch (_) {
    return { ok: false, error: 'slug directory not found' };
  }
  const chainAbs = path.join(courseDir, 'chain.json');
  if (!fs.existsSync(chainAbs)) {
    return { ok: true, chain: null };
  }
  try {
    const chain = JSON.parse(fs.readFileSync(chainAbs, 'utf-8'));
    return { ok: true, chain };
  } catch (err) {
    return { ok: false, error: `chain.json read failed: ${err.message}` };
  }
});

// chain:edit-ultimate — rewrite chain.ultimate_goal in vault/<slug>/chain.json.
// Intentionally distinct from course:edit-goal — that handler ALSO syncs chain
// for the legacy UI path; this handler is the new direct surface for renderers
// that only want the chain side rewritten (does NOT touch state.goalContract).
// Atomic via tmp-then-rename. Slug validated for traversal.
ipcMain.handle('chain:edit-ultimate', (_e, args = {}) => {
  const { slug, newGoal } = args || {};
  if (!slug || typeof slug !== 'string') {
    return { ok: false, error: 'slug required' };
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || slug.startsWith('.')) {
    return { ok: false, error: 'invalid slug shape' };
  }
  if (typeof newGoal !== 'string') {
    return { ok: false, error: 'newGoal must be a string' };
  }
  const trimmed = newGoal.trim();
  if (trimmed.length < 3 || trimmed.length > 500) {
    return { ok: false, error: 'newGoal must be 3-500 chars trimmed' };
  }
  const root = vault.resolveRoot();
  const courseDir = path.join(root, slug);
  try {
    const dirStat = fs.statSync(courseDir);
    if (!dirStat.isDirectory()) {
      return { ok: false, error: 'slug is not a directory' };
    }
  } catch (_) {
    return { ok: false, error: 'slug directory not found' };
  }
  const chainAbs = path.join(courseDir, 'chain.json');
  if (!fs.existsSync(chainAbs)) {
    return { ok: false, error: 'chain.json not found' };
  }
  let chain;
  try {
    chain = JSON.parse(fs.readFileSync(chainAbs, 'utf-8'));
  } catch (err) {
    return { ok: false, error: `chain.json read failed: ${err.message}` };
  }
  chain.ultimate_goal = newGoal;
  chain.ultimate_goal_updated_at = new Date().toISOString();
  const tmpAbs = `${chainAbs}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpAbs, JSON.stringify(chain, null, 2), 'utf-8');
    fs.renameSync(tmpAbs, chainAbs);
  } catch (err) {
    try { fs.unlinkSync(tmpAbs); } catch (_) { /* tmp may not exist */ }
    return { ok: false, error: `atomic write failed: ${err.message}` };
  }
  return { ok: true, chain };
});

// course:set-series — assign/clear the optional series tag on
// vault/<slug>/state.json. null clears; non-empty string (1-60 chars,
// trimmed) sets. Atomic via tmp-then-rename so a crashed write can never
// leave a half-flushed state.json. Slug validated for traversal.
ipcMain.handle('course:set-series', (_e, args = {}) => {
  const { slug, series } = args || {};
  if (!slug || typeof slug !== 'string') {
    return { ok: false, error: 'slug required' };
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || slug.startsWith('.')) {
    return { ok: false, error: 'invalid slug shape' };
  }
  let nextSeries;
  if (series === null) {
    nextSeries = null;
  } else if (typeof series === 'string') {
    const trimmed = series.trim();
    if (trimmed.length < 1 || trimmed.length > 60) {
      return { ok: false, error: 'series must be 1-60 chars when set' };
    }
    nextSeries = trimmed;
  } else {
    return { ok: false, error: 'series must be string or null' };
  }
  const root = vault.resolveRoot();
  const courseDir = path.join(root, slug);
  try {
    const dirStat = fs.statSync(courseDir);
    if (!dirStat.isDirectory()) {
      return { ok: false, error: 'slug is not a directory' };
    }
  } catch (_) {
    return { ok: false, error: 'slug directory not found' };
  }
  const stateRel = `${slug}/state.json`;
  const state = vault.readJSON(stateRel, null);
  if (!state) {
    return { ok: false, error: 'state.json not found' };
  }
  state.series = nextSeries;
  const stateAbs = path.join(courseDir, 'state.json');
  const tmpAbs = `${stateAbs}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpAbs, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmpAbs, stateAbs);
  } catch (err) {
    try { fs.unlinkSync(tmpAbs); } catch (_) { /* tmp may not exist */ }
    return { ok: false, error: `atomic write failed: ${err.message}` };
  }
  // v0.4.11 — mirror to chain.parent_chain_slug when chain.json exists. Chain
  // write failure does NOT abort the IPC: state.series already landed, surface
  // a warning so caller can retry chain side separately.
  let chainMirror = null;
  let chainWarning = null;
  const chainAbs = path.join(courseDir, 'chain.json');
  if (fs.existsSync(chainAbs)) {
    try {
      const chain = JSON.parse(fs.readFileSync(chainAbs, 'utf-8'));
      chain.parent_chain_slug = nextSeries;
      chain.parent_chain_updated_at = new Date().toISOString();
      const chainTmp = `${chainAbs}.tmp-${process.pid}-${Date.now()}`;
      try {
        fs.writeFileSync(chainTmp, JSON.stringify(chain, null, 2), 'utf-8');
        fs.renameSync(chainTmp, chainAbs);
        chainMirror = chain;
      } catch (err) {
        try { fs.unlinkSync(chainTmp); } catch (_) { /* tmp may not exist */ }
        chainWarning = `chain mirror write failed: ${err.message}`;
      }
    } catch (err) {
      chainWarning = `chain mirror read failed: ${err.message}`;
    }
  }
  return { ok: true, state, chain: chainMirror, warning: chainWarning };
});

// course:set-parent-chain — v0.4.11 canonical chain-grouping setter. Writes
// chain.parent_chain_slug (null or trimmed string) atomically. Distinct from
// course:set-series — that handler mirrors to chain for backward compat;
// this one is the new authoritative surface that does NOT touch state.series.
ipcMain.handle('course:set-parent-chain', (_e, args = {}) => {
  const { validateSlug, validateParentChainSlug } = require('./lib/util/chain-validators');
  const slugCheck = validateSlug(args && args.slug);
  if (!slugCheck.ok) return { ok: false, error: slugCheck.error };
  const slug = slugCheck.value;
  const parentCheck = validateParentChainSlug(args && args.parentChainSlug !== undefined ? args.parentChainSlug : null);
  if (!parentCheck.ok) return { ok: false, error: parentCheck.error };
  const nextParent = parentCheck.value;
  const root = vault.resolveRoot();
  const courseDir = path.join(root, slug);
  try {
    const dirStat = fs.statSync(courseDir);
    if (!dirStat.isDirectory()) {
      return { ok: false, error: 'slug is not a directory' };
    }
  } catch (_) {
    return { ok: false, error: 'slug directory not found' };
  }
  const chainAbs = path.join(courseDir, 'chain.json');
  if (!fs.existsSync(chainAbs)) {
    return { ok: false, error: 'chain.json not found' };
  }
  let chain;
  try {
    chain = JSON.parse(fs.readFileSync(chainAbs, 'utf-8'));
  } catch (err) {
    return { ok: false, error: `chain.json read failed: ${err.message}` };
  }
  chain.parent_chain_slug = nextParent;
  chain.parent_chain_updated_at = new Date().toISOString();
  const tmpAbs = `${chainAbs}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpAbs, JSON.stringify(chain, null, 2), 'utf-8');
    fs.renameSync(tmpAbs, chainAbs);
  } catch (err) {
    try { fs.unlinkSync(tmpAbs); } catch (_) { /* tmp may not exist */ }
    return { ok: false, error: `atomic write failed: ${err.message}` };
  }
  return { ok: true, chain };
});

// anti-slop:cost-summary — roll up vault/.hypha/anti-slop-cost.jsonl into
// {calls, totalCostCNY, last24h, perCourse}. Each line is a JSON record
// emitted by anti-slop:force-rewrite (see PJR append below). If args.slug
// is set, top-level totals filter to that slug; perCourse stays unfiltered
// so callers can still surface cross-course context.
ipcMain.handle('anti-slop:cost-summary', (_e, args = {}) => {
  try {
    const { slug } = args || {};
    if (slug != null && typeof slug !== 'string') {
      return { ok: false, error: 'slug must be string when provided' };
    }
    const root = vault.resolveRoot();
    const logPath = path.join(root, '.hypha', 'anti-slop-cost.jsonl');
    if (!fs.existsSync(logPath)) {
      return { ok: true, calls: 0, totalCostCNY: 0, last24h: 0, perCourse: {} };
    }
    const raw = fs.readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n');
    const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
    const perCourse = {};
    let calls = 0;
    let totalCostCNY = 0;
    let last24h = 0;
    for (const ln of lines) {
      if (!ln.trim()) continue;
      let rec;
      try { rec = JSON.parse(ln); } catch (_) { continue; }
      if (!rec || typeof rec !== 'object') continue;
      const recSlug = typeof rec.slug === 'string' ? rec.slug : '';
      const cost = Number.isFinite(rec.costCNY) ? rec.costCNY : 0;
      const tsMs = rec.ts ? Date.parse(rec.ts) : NaN;
      if (recSlug) {
        if (!perCourse[recSlug]) perCourse[recSlug] = { calls: 0, costCNY: 0 };
        perCourse[recSlug].calls += 1;
        perCourse[recSlug].costCNY += cost;
      }
      if (slug && recSlug !== slug) continue;
      calls += 1;
      totalCostCNY += cost;
      if (Number.isFinite(tsMs) && tsMs > cutoffMs) last24h += 1;
    }
    return { ok: true, calls, totalCostCNY, last24h, perCourse };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// anti-slop:concept-ledger — v0.4.12 Anti-Slop lite cross-lesson concept
// ledger. Pure-JS reader over vault/<slug>/lesson-N.body.json files; flags
// terms appearing in ≥2 lessons (potential redefinition risk). No LLM.
ipcMain.handle('anti-slop:concept-ledger', (_e, { slug } = {}) => {
  try {
    if (typeof slug !== 'string' || !slug.trim()) {
      return { ok: false, error: 'BAD_INPUT', message: 'slug required' };
    }
    if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
      return { ok: false, error: 'BAD_SLUG', message: 'slug must not contain path separators' };
    }
    const root = vault.resolveRoot();
    const courseDir = path.join(root, slug);
    if (!fs.existsSync(courseDir)) {
      return { ok: false, error: 'NOT_FOUND', message: `vault/${slug} does not exist` };
    }
    const { buildLedger } = require('./lib/anti-slop/concept-ledger');
    const ledger = buildLedger(courseDir);
    return { ok: true, ledger };
  } catch (err) {
    return { ok: false, error: 'INTERNAL', message: err && err.message };
  }
});

// v0.4.14 boot-8 — Concept Ledger drift detection + consistency score.
// Reads vault/<slug>/concept-ledger.jsonl (populated by lesson:body:generate
// post-write hook). detect-drift returns concepts whose definitions diverge
// across lessons; consistency-score returns 0..1.
ipcMain.handle('concept-ledger:detect-drift', (_e, { slug } = {}) => {
  try {
    if (typeof slug !== 'string' || !slug.trim()) {
      return { ok: false, error: 'BAD_INPUT', message: 'slug required' };
    }
    if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
      return { ok: false, error: 'BAD_SLUG', message: 'slug must not contain path separators' };
    }
    const vaultRoot = vault.resolveRoot();
    const { detectDriftCases } = require('./lib/anti-slop/concept-ledger');
    const drifts = detectDriftCases({ slug, vaultRoot });
    return { ok: true, drifts };
  } catch (err) {
    return { ok: false, error: 'INTERNAL', message: err && err.message };
  }
});

ipcMain.handle('concept-ledger:consistency-score', (_e, { slug } = {}) => {
  try {
    if (typeof slug !== 'string' || !slug.trim()) {
      return { ok: false, error: 'BAD_INPUT', message: 'slug required' };
    }
    if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
      return { ok: false, error: 'BAD_SLUG', message: 'slug must not contain path separators' };
    }
    const vaultRoot = vault.resolveRoot();
    const { computeConsistencyScore, detectDriftCases } = require('./lib/anti-slop/concept-ledger');
    const score = computeConsistencyScore({ slug, vaultRoot });
    const drifts = detectDriftCases({ slug, vaultRoot });
    return { ok: true, score, driftCount: drifts.length };
  } catch (err) {
    return { ok: false, error: 'INTERNAL', message: err && err.message };
  }
});

// v0.4.13 — Track A/B Exit Ramp MVP. User picks at /finish boundary which
// path to take after a lesson: Track A (ship product), Track B (publish
// note), or skip. Stored append-only at vault/<slug>/exit-ramps.jsonl.
// URL-validation harness (ping rampId, pushback digest) defers to v0.5+.
const _trackRamps = require('./lib/util/track-ramps');
ipcMain.handle('track:set-exit-ramp', (_e, args = {}) => {
  const check = _trackRamps.validateExitRampArgs(args || {});
  if (!check.ok) return { ok: false, error: check.error };
  const { normalized } = check;
  const root = vault.resolveRoot();
  const courseDir = path.join(root, normalized.slug);
  try {
    const dirStat = fs.statSync(courseDir);
    if (!dirStat.isDirectory()) {
      return { ok: false, error: 'slug is not a directory' };
    }
  } catch (_) {
    return { ok: false, error: 'slug directory not found' };
  }
  const entry = _trackRamps.buildExitRampEntry(normalized);
  const jsonlPath = path.join(courseDir, 'exit-ramps.jsonl');
  try {
    fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    return { ok: false, error: `exit-ramps.jsonl append failed: ${err.message}` };
  }
  return { ok: true, entry };
});

ipcMain.handle('track:get-status', (_e, args = {}) => {
  const { slug } = args || {};
  if (!slug || typeof slug !== 'string') {
    return { ok: false, error: 'slug required' };
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || slug.startsWith('.')) {
    return { ok: false, error: 'invalid slug shape' };
  }
  const root = vault.resolveRoot();
  const jsonlPath = path.join(root, slug, 'exit-ramps.jsonl');
  if (!fs.existsSync(jsonlPath)) {
    return {
      ok: true,
      status: {
        totalRamps: 0,
        trackACount: 0,
        trackBCount: 0,
        skipCount: 0,
        entries: [],
        lastRampAt: null,
        byLesson: {},
      },
    };
  }
  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf-8');
  } catch (err) {
    return { ok: false, error: `exit-ramps.jsonl read failed: ${err.message}` };
  }
  const status = _trackRamps.aggregateExitRamps(raw.split('\n'));
  return { ok: true, status };
});

// v0.5.0-bootstrap — 6 IPC scaffolds for Track A/B v0.5.0 / Commons MVP /
// Companion v0.1 / Anti-Slop P2. Each lib module is shipped in parallel by
// peer agents; require() is wrapped to return a graceful `lib-not-ready`
// stub when the module hasn't landed yet so the renderer surfaces can wire
// up against stable IPC contracts immediately.
function _isFilenameSafe(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 200
    && !name.includes('..')
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('.');
}
function _isSlugSafe(slug) {
  return typeof slug === 'string'
    && slug.length > 0
    && !slug.includes('..')
    && !slug.includes('/')
    && !slug.includes('\\')
    && !slug.startsWith('.');
}

ipcMain.handle('track:ping-url', async (_e, args = {}) => {
  try {
    const { url } = args || {};
    if (typeof url !== 'string' || url.length === 0 || url.length > 500) {
      return { ok: false, error: 'url must be non-empty string ≤ 500 chars' };
    }
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, error: 'url must start with http:// or https://' };
    }
    let lib;
    try { lib = require('./lib/track/url-pinger'); } catch (_) { lib = null; }
    if (!lib || typeof lib.pingUrl !== 'function') {
      return {
        ok: true,
        metadata: {
          url,
          fetched_at: new Date().toISOString(),
          status_code: null,
          title: null,
          status: 'lib-not-ready',
        },
      };
    }
    const metadata = await lib.pingUrl(url);
    return { ok: true, metadata };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('track:validation-mass', (_e, args = {}) => {
  try {
    const { slug } = args || {};
    if (!_isSlugSafe(slug)) {
      return { ok: false, error: 'invalid slug shape' };
    }
    const root = vault.resolveRoot();
    const jsonlPath = path.join(root, slug, 'exit-ramps.jsonl');
    let entries = [];
    if (fs.existsSync(jsonlPath)) {
      const raw = fs.readFileSync(jsonlPath, 'utf-8');
      for (const ln of raw.split('\n')) {
        if (!ln.trim()) continue;
        try { entries.push(JSON.parse(ln)); } catch (_) { /* skip malformed */ }
      }
    }
    let lib;
    try { lib = require('./lib/track/validation-mass'); } catch (_) { lib = null; }
    if (!lib || typeof lib.computeMass !== 'function') {
      return {
        ok: true,
        mass: {
          composite_score: 0,
          comments: 0,
          shares: 0,
          views: 0,
          reactions: 0,
          status: 'lib-not-ready',
        },
      };
    }
    const mass = lib.computeMass(entries);
    return { ok: true, mass };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:list-packs', () => {
  try {
    const root = vault.resolveRoot();
    const commonsDir = path.join(root, '.commons-packs');
    try { fs.mkdirSync(commonsDir, { recursive: true }); } catch (_) {}
    let lib;
    try { lib = require('./lib/commons/pack-loader'); } catch (_) { lib = null; }
    if (lib && typeof lib.listPacks === 'function') {
      const packs = lib.listPacks(commonsDir);
      return { ok: true, packs: Array.isArray(packs) ? packs : [] };
    }
    const out = [];
    let entries;
    try { entries = fs.readdirSync(commonsDir); } catch (_) { entries = []; }
    for (const fname of entries) {
      if (!fname.endsWith('.json')) continue;
      const id = fname.slice(0, -5);
      let meta = {};
      try {
        const raw = fs.readFileSync(path.join(commonsDir, fname), 'utf-8');
        meta = JSON.parse(raw) || {};
      } catch (_) { meta = {}; }
      out.push({
        id,
        name: typeof meta.name === 'string' ? meta.name : id,
        archetype: typeof meta.archetype === 'string' ? meta.archetype : null,
        version: typeof meta.version === 'string' ? meta.version : null,
      });
    }
    return { ok: true, packs: out };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('commons:load-pack', (_e, args = {}) => {
  try {
    const { packId } = args || {};
    if (!_isFilenameSafe(packId)) {
      return { ok: false, error: 'packId must be filename-safe (no .. / \\ or .)' };
    }
    const root = vault.resolveRoot();
    const commonsDir = path.join(root, '.commons-packs');
    let lib;
    try { lib = require('./lib/commons/pack-loader'); } catch (_) { lib = null; }
    if (lib && typeof lib.loadPack === 'function') {
      const pack = lib.loadPack(commonsDir, packId);
      return { ok: true, pack };
    }
    const packPath = path.join(commonsDir, `${packId}.json`);
    if (!fs.existsSync(packPath)) {
      return { ok: false, error: `pack not found: ${packId}` };
    }
    const raw = fs.readFileSync(packPath, 'utf-8');
    const pack = JSON.parse(raw);
    return { ok: true, pack };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('companion:myco-state', async (_e, args = {}) => {
  try {
    const { slug } = args || {};
    if (!_isSlugSafe(slug)) {
      return { ok: false, error: 'invalid slug shape' };
    }
    let lib;
    try { lib = require('./lib/companion/myco-state'); } catch (_) { lib = null; }
    if (!lib || typeof lib.getMycoState !== 'function') {
      return {
        ok: true,
        state: {
          tone: 'neutral',
          expression: 'idle',
          boundary_status: 'ok',
          last_check_in_at: null,
          status: 'lib-not-ready',
        },
      };
    }
    const state = await lib.getMycoState({ slug, vaultRoot: vault.resolveRoot() });
    return { ok: true, state };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

ipcMain.handle('anti-slop:contamination-graph', async (_e, args = {}) => {
  try {
    const { slug } = args || {};
    if (!_isSlugSafe(slug)) {
      return { ok: false, error: 'invalid slug shape' };
    }
    let lib;
    try { lib = require('./lib/anti-slop/contamination-graph'); } catch (_) { lib = null; }
    if (!lib || typeof lib.buildGraph !== 'function') {
      return {
        ok: true,
        graph: {
          nodes: [],
          edges: [],
          quarantined_lessons: [],
          status: 'lib-not-ready',
        },
      };
    }
    const graph = await lib.buildGraph({ slug, vaultRoot: vault.resolveRoot() });
    return { ok: true, graph };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// v0.5.0-bootstrap-3 — Pricing v3 loyalty engine. Reads vault/data/profile.json
// and routes through ./lib/pricing/loyalty-engine. profile.json is the same
// global profile already used by classifyPriorKnowledge / Founders timestamp.
// Missing file → handler creates an empty {} (parallels existing profile flow).
ipcMain.handle('pricing:query-tier', () => {
  try {
    const root = vault.resolveRoot();
    const profileAbs = path.join(root, 'data', 'profile.json');
    let profile = {};
    if (fs.existsSync(profileAbs)) {
      try {
        const raw = fs.readFileSync(profileAbs, 'utf-8');
        profile = JSON.parse(raw) || {};
      } catch (_) { profile = {}; }
    }
    let lib;
    try { lib = require('./lib/pricing/loyalty-engine'); } catch (_) { lib = null; }
    if (!lib || typeof lib.queryTier !== 'function') {
      return {
        ok: true,
        tier: 'free',
        monthly_cny: 0,
        pricing_floor: 0,
        perks: [],
        status: 'lib-not-ready',
      };
    }
    const result = lib.queryTier(profile) || {};
    return {
      ok: true,
      tier: result.tier || 'free',
      monthly_cny: typeof result.monthly_cny === 'number' ? result.monthly_cny : 0,
      pricing_floor: typeof result.pricing_floor === 'number' ? result.pricing_floor : 0,
      perks: Array.isArray(result.perks) ? result.perks : [],
      founder_purchased_at: result.founder_purchased_at || null,
      years_since: typeof result.years_since === 'number' ? result.years_since : null,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// v0.5.0-bootstrap-6 — payment rails gate. As of this slice the handler
// REQUIRES a verified intent_id from payment-rails. Calling without one
// (or with a still-pending / expired intent) yields PAYMENT_NOT_VERIFIED.
// The pre-rails passthrough (`{ts}` direct write) is removed — Founders
// can no longer flip for free. Stub processing-delay lets dev flows
// still exercise the panel via the new pricing:create-payment +
// pricing:verify-payment IPC pair.
//
// Atomic tmp+rename write — mirrors course:edit-goal pattern. Path
// validation: profile.json must resolve under vault root.
ipcMain.handle('pricing:set-founder-purchase', (_e, args = {}) => {
  try {
    const { intent_id, ts } = args || {};

    // Gate — require verified intent. NO bypass (real flow only).
    if (typeof intent_id !== 'string' || intent_id.length === 0) {
      return {
        ok: false,
        error: 'intent_id required — call pricing:create-payment then pricing:verify-payment first',
        code: 'PAYMENT_NOT_VERIFIED',
      };
    }
    let rails;
    try { rails = require('./lib/pricing/payment-rails'); } catch (_) { rails = null; }
    if (!rails || typeof rails.verifyPaymentCompletion !== 'function') {
      return { ok: false, error: 'payment-rails lib unavailable', code: 'PAYMENT_RAILS_MISSING' };
    }
    const verification = rails.verifyPaymentCompletion(intent_id);
    if (!verification || verification.verified !== true) {
      return {
        ok: false,
        error: `payment not verified — intent state=${verification && verification.state}`,
        code: 'PAYMENT_NOT_VERIFIED',
        intent_id,
        state: verification && verification.state,
      };
    }

    // Verified — pick timestamp. Prefer the payment paid_at over caller-
    // supplied ts (paid_at is the audit ground truth). ts param retained
    // for deterministic tests only — must be ≤ now if present.
    let purchaseTs = verification.paid_at || new Date().toISOString();
    if (ts !== undefined && ts !== null) {
      if (typeof ts !== 'string') {
        return { ok: false, error: 'ts must be an ISO string' };
      }
      const parsed = Date.parse(ts);
      if (!Number.isFinite(parsed)) {
        return { ok: false, error: 'ts not a parseable ISO string' };
      }
      if (parsed > Date.now()) {
        return { ok: false, error: 'ts must be ≤ now' };
      }
      purchaseTs = new Date(parsed).toISOString();
    }

    const root = vault.resolveRoot();
    const dataDir = path.join(root, 'data');
    const profileAbs = path.join(dataDir, 'profile.json');
    const rootResolved = path.resolve(root);
    if (!path.resolve(profileAbs).startsWith(rootResolved)) {
      return { ok: false, error: 'profile.json path escapes vault root' };
    }
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
    let profile = {};
    if (fs.existsSync(profileAbs)) {
      try {
        const raw = fs.readFileSync(profileAbs, 'utf-8');
        profile = JSON.parse(raw) || {};
      } catch (_) { profile = {}; }
    }
    let lib;
    try { lib = require('./lib/pricing/loyalty-engine'); } catch (_) { lib = null; }
    let nextProfile;
    if (lib && typeof lib.setFounderPurchase === 'function') {
      nextProfile = lib.setFounderPurchase(profile, purchaseTs) || profile;
    } else {
      nextProfile = { ...profile, founder_purchased_at: purchaseTs };
    }
    // Annotate the payment audit pointer on profile — lets future
    // refund / reconciliation walk back to the transition row.
    nextProfile = {
      ...nextProfile,
      founder_payment_intent_id: intent_id,
      founder_payment_transaction_id: verification.transaction_id || null,
      founder_payment_provider: verification.provider || null,
    };
    const tmpAbs = `${profileAbs}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmpAbs, JSON.stringify(nextProfile, null, 2), 'utf-8');
      fs.renameSync(tmpAbs, profileAbs);
    } catch (err) {
      try { fs.unlinkSync(tmpAbs); } catch (_) { /* intentional: tmp may not exist if writeFileSync threw before creating it */ }
      return { ok: false, error: `atomic write failed: ${err.message}` };
    }
    // v1.0 boot-8 — invalidate shield's per-userId tier cache so the next
    // LLM pre-call gate re-reads profile.json + picks up the new tier's
    // daily cap (FREE ¥5 → FOUNDERS ¥50, etc.). Best-effort: never let a
    // cache-clear failure rollback the founders purchase.
    try {
      const _sh2 = require('./lib/cashflow-shield/shield');
      if (_sh2 && typeof _sh2.clearTierCache === 'function') _sh2.clearTierCache();
    } catch (_) { /* shield lib unavailable — non-fatal */ }
    return { ok: true, profile: nextProfile, intent_id, transaction_id: verification.transaction_id || null };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// v0.5.0-bootstrap-6 — payment rails IPC pair. createPayment returns an
// intent payload (qr / url + state machine row); verifyPayment polls
// the audit log to advance the state. Both are thin wrappers over
// ./lib/pricing/payment-rails — keeps the SDK swap path narrow.
ipcMain.handle('pricing:create-payment', (_e, args = {}) => {
  try {
    const { sku, provider, amount_cny } = args || {};
    let rails;
    try { rails = require('./lib/pricing/payment-rails'); } catch (_) { rails = null; }
    if (!rails || typeof rails.createPaymentIntent !== 'function') {
      return { ok: false, error: 'payment-rails lib unavailable', code: 'PAYMENT_RAILS_MISSING' };
    }
    // Default amount = SKU canonical amount when caller did not supply
    // (UI does not need to know the price — single source of truth =
    // SUPPORTED_SKUS in payment-rails.js).
    const skuMeta = rails.SUPPORTED_SKUS && rails.SUPPORTED_SKUS[sku];
    const effectiveAmount = (typeof amount_cny === 'number' && Number.isFinite(amount_cny))
      ? amount_cny
      : (skuMeta ? skuMeta.amount_cny : NaN);
    return rails.createPaymentIntent({ sku, provider, amount_cny: effectiveAmount });
  } catch (err) {
    return {
      ok: false,
      error: (err && err.message) || String(err),
      code: (err && err.code) || 'CREATE_FAILED',
    };
  }
});

ipcMain.handle('pricing:verify-payment', (_e, args = {}) => {
  try {
    const { intent_id } = args || {};
    let rails;
    try { rails = require('./lib/pricing/payment-rails'); } catch (_) { rails = null; }
    if (!rails || typeof rails.verifyPaymentCompletion !== 'function') {
      return { ok: false, verified: false, error: 'payment-rails lib unavailable', code: 'PAYMENT_RAILS_MISSING' };
    }
    return rails.verifyPaymentCompletion(intent_id);
  } catch (err) {
    return {
      ok: false,
      verified: false,
      error: (err && err.message) || String(err),
      code: (err && err.code) || 'VERIFY_FAILED',
    };
  }
});

ipcMain.handle('pricing:list-providers', () => {
  try {
    let rails;
    try { rails = require('./lib/pricing/payment-rails'); } catch (_) { rails = null; }
    if (!rails || typeof rails.listSupportedProviders !== 'function') {
      return { ok: true, providers: [] };
    }
    return { ok: true, providers: rails.listSupportedProviders() };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// v0.5.0-bootstrap-3 — Cost predictor. Pre-flight ¥ estimate per turn so the
// UI can surface "this turn ≈ ¥X.XX" before fire. Capability ∈ T6/T4/T3 per
// the LLM router classes. Lib missing → zero estimate, status flag.
ipcMain.handle('cost:predict', async (_e, args = {}) => {
  try {
    const { messages, capability, opts } = args || {};
    if (!Array.isArray(messages)) {
      return { ok: false, error: 'messages must be an array' };
    }
    if (messages.length > 100) {
      return { ok: false, error: 'messages exceeds 100-item cap' };
    }
    if (typeof capability !== 'string' || capability.length === 0) {
      return { ok: false, error: 'capability must be a non-empty string' };
    }
    let lib;
    try { lib = require('./lib/llm/cost-predictor'); } catch (_) { lib = null; }
    if (!lib || typeof lib.predictCost !== 'function') {
      return {
        ok: true,
        estimate: {
          input_tokens_est: 0,
          output_tokens_max: 0,
          cny_est: 0,
          capability,
          status: 'lib-not-ready',
        },
      };
    }
    const estimate = await lib.predictCost(messages, capability, opts || {});
    return { ok: true, estimate };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// v0.5.0-bootstrap-3 — Companion emotion-tone bridge. Composes an outgoing
// expression from {trigger, sessionContext} via the boundary-aware emotion
// state + tone engine. Suppressed=true means the bridge declined to fire
// (cooldown / turn-budget / lesson-in-progress). Lib missing → idle fallback.
ipcMain.handle('companion:compose-expression', async (_e, args = {}) => {
  try {
    const { trigger, sessionContext } = args || {};
    if (typeof trigger !== 'string' || trigger.length === 0) {
      return { ok: false, error: 'trigger must be a non-empty string' };
    }
    let lib;
    try { lib = require('./lib/companion/emotion-tone-bridge'); } catch (_) { lib = null; }
    if (!lib || typeof lib.composeExpression !== 'function') {
      return {
        ok: true,
        suppressed: false,
        effective_trigger: trigger,
        emotion: 'idle',
        status: 'lib-not-ready',
      };
    }
    const composed = await lib.composeExpression({ trigger, sessionContext: sessionContext || {} }) || {};
    return {
      ok: true,
      suppressed: !!composed.suppressed,
      effective_trigger: composed.effective_trigger || trigger,
      emotion: composed.emotion || 'idle',
      emotion_signal: composed.emotion_signal,
      bias: composed.bias,
      expression: composed.expression,
      reason: composed.reason,
    };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

// frontier:status — report freshness of ~/.claude/wisdom/frontier.md.
// harvestCount uses a digest-line regex (lines starting with "- YYYY-MM-DD")
// as a rough proxy for digest entries — exact count not promised.
// Fallback: when frontier.md is missing or has 0 digests, read
// ~/.claude/wisdom/.spark-hits.json as a secondary signal so the UI can
// still show "last harvest" instead of a hard "no frontier" state.
ipcMain.handle('frontier:status', () => {
  try {
    const frontierPath = path.join(os.homedir(), '.claude', 'wisdom', 'frontier.md');
    let harvestCount = 0;
    let lastHarvestAt = null;
    if (fs.existsSync(frontierPath)) {
      const stat = fs.statSync(frontierPath);
      const body = fs.readFileSync(frontierPath, 'utf-8');
      const lines = body.split('\n');
      const digestRe = /^- \d{4}-\d{2}-\d{2}/;
      for (const ln of lines) { if (digestRe.test(ln)) harvestCount++; }
      if (harvestCount > 0) {
        return {
          ok: true,
          hasFrontier: true,
          lastHarvestAt: stat.mtime.toISOString(),
          harvestCount,
          source: 'frontier.md',
        };
      }
      lastHarvestAt = stat.mtime.toISOString();
    }
    const sparkPath = path.join(os.homedir(), '.claude', 'wisdom', '.spark-hits.json');
    if (fs.existsSync(sparkPath)) {
      try {
        const sparkRaw = fs.readFileSync(sparkPath, 'utf-8');
        const sparkData = JSON.parse(sparkRaw);
        const arr = Array.isArray(sparkData) ? sparkData : null;
        if (arr && arr.length > 0) {
          let maxTs = 0;
          for (const entry of arr) {
            if (!entry || typeof entry !== 'object') continue;
            const tsMs = entry.ts ? Date.parse(entry.ts) : NaN;
            if (Number.isFinite(tsMs) && tsMs > maxTs) maxTs = tsMs;
          }
          return {
            ok: true,
            hasFrontier: true,
            lastHarvestAt: maxTs > 0 ? new Date(maxTs).toISOString() : lastHarvestAt,
            harvestCount: arr.length,
            source: 'spark-hits.json',
          };
        }
      } catch (parseErr) {
        return { ok: false, error: `spark-hits parse failed: ${parseErr.message}`, source: 'none' };
      }
    }
    return { ok: true, hasFrontier: false, source: 'none' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.on('before-quit', () => {
  if (_server) { try { _server.close(); } catch (_) {} }
  // v1.0 boot-11 — drain every registered cleanup (timers, caches, abort
  // pools). Idempotent + per-callback try/catch internal, so a broken cleanup
  // can never block the rest of shutdown. Summary logged for triage but
  // shutdown proceeds regardless.
  try {
    const summary = cleanupRegistry.runAll();
    if (summary && summary.failed && summary.failed.length > 0) {
      console.warn('[cleanup-registry] shutdown drain had failures:',
        JSON.stringify(summary.failed));
    } else if (summary) {
      console.log(`[cleanup-registry] shutdown drain ok=${summary.ok}/${summary.total}`);
    }
  } catch (e) {
    console.warn('[cleanup-registry] runAll threw:', e && e.message);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
