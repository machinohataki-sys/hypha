'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const vault = require('./lib/vault');
const importer = require('./lib/importer');
const scheduler = require('./lib/scheduler');
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

// Update checker — production only. Polls GitHub Releases for our repo every
// hour. If a newer tag is found, shows a native dialog that opens the Release
// page in the user's browser. This is a deliberate 70% auto-update solution:
// full Squirrel-based silent auto-update requires code signing ($99-300/yr
// for Apple + Windows certs); pre-revenue we can't justify it. Once Hypha
// Cloud has paying users, we add signing + true silent updater.
if (app.isPackaged) {
  setTimeout(() => checkForUpdate().catch(e => console.error('[update]', e.message)), 30_000);
  setInterval(() => checkForUpdate().catch(e => console.error('[update]', e.message)), 60 * 60 * 1000);
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
      sandbox: true,
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
  });

  // Bridge renderer console to main process stdout for debugging
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    const lvl = ['log','info','warn','error'][level] || 'log';
    console.log(`[renderer:${lvl}] ${message}` + (source ? ` (${source}:${line})` : ''));
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

  win.loadURL(`http://127.0.0.1:${port}/ui_kits/ptor-app/index.html`);

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

// vault:pick-folder — open native folder picker, return selected absolute path or null.
ipcMain.handle('vault:pick-folder', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(win, {
    title: '选择要导入的笔记文件夹 (Bear / Obsidian / Notion 导出)',
    properties: ['openDirectory', 'dontAddToRecent'],
  });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// source:pick — open file picker for curriculum source corpus (PDF/MD/TXT).
// Returns { ok, filePath, fileName } or { ok: false, cancelled: true }.
ipcMain.handle('source:pick', async (event) => {
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
ipcMain.handle('agent:invoke', async (event, { name, userMsg, requestId, surface, noteRel }) => {
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
  console.log(`[agent:invoke] name=${name} surface=${surf} ephemeral=${isEphemeral} userMsgLen=${userMsg.length} noteRel=${noteRel || '(none)'} requestId=${requestId} (priorInvocations=${priorInvs})`);

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

    try {
      await _hyphaAgent.streamTurn(
        { systemPrompt: ctx.systemPrompt, history: finalHistory, userMsg: ctx.userMsg, settings: effectiveSettings, signal: ac.signal },
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
      _agentLoader.appendSession(root, name, { role: 'assistant', text: outText, requestId, surface: surf });
    }

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

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  // 2026-05-02 — purge stale trash entries (>7d) from vault/.trash on startup.
  // Soft-deletes (vault.del) move targets to .trash/<basename>-<unixMs>/; this
  // hard-purges anything past the recovery window. Idempotent + silent on
  // missing dir.
  try {
    const result = vault.purgeStaleTrash();
    if (result && result.purged > 0) {
      console.log(`[startup] purged ${result.purged} stale trash entries (>7d)`);
    }
  } catch (_) {}
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

function _topicSlug(topic) {
  return String(topic || '').toLowerCase().trim()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'untitled';
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
  try { vault.del(slug); } catch (_) {}
  try { _hyphaAppendEvent('curriculum_cancelled', { topic: slug }); } catch (_) {}
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
async function _runCurriculumCreate(event, { topic, level, goal, timeCommit, customLessons, clarifications, uploadedSource, tier, prePrediction } = {}) {
  const slug = _topicSlug(topic);
  const settings = _hyphaSettings();
  const emit = (stage, extra = {}) => {
    try {
      if (event && event.sender && typeof event.sender.send === 'function') {
        event.sender.send('curriculum:progress', { topic: slug, stage, ...extra });
      }
    } catch (_) {}
  };
  _hyphaAppendEvent('curriculum_start', { topic: slug, level, goal, timeCommit, customLessons, clarifCount: (clarifications || []).length, sourceMode: uploadedSource ? 'upload' : 'web' });
  // v0.4.4 — clear any stale cancel flag from a previous attempt with the same slug.
  _curriculumCancelled.delete(slug);
  try {
    let sources;
    // v0.7.0 — preHarvestArchetype: when the web-harvest branch runs, we
    // classify archetype FIRST so harvest can route channels. Reused later
    // by Step A so we avoid a second classifyArchetype call.
    let preHarvestArchetype = null;
    if (uploadedSource && Array.isArray(uploadedSource.chapters) && uploadedSource.chapters.length > 0) {
      // v0.5.0 — user provided a source document. Skip web harvest; build the
      // sources.json from the file's chapters. Each chapter becomes one row
      // BM25 can rank against per-lesson via rankSourcesBM25.
      emit('reading-source', { fileName: uploadedSource.fileName });
      sources = uploadedSource.chapters.map((ch, i) => ({
        title: ch.title || `Section ${i + 1}`,
        url: `local://${uploadedSource.fileName}#chapter-${i}`,
        excerpt: String(ch.text || '').slice(0, 400),
        sourceType: 'user-upload',
        fileName: uploadedSource.fileName,
        chapterIdx: i,
        chapterStart: ch.startCharIdx || 0,
      }));
      // Persist the full text under the slug dir so proposeNextLesson can
      // re-read fresh per-lesson without keeping it all in memory.
      try { vault.write(`${slug}/source-document.txt`, uploadedSource.text || ''); } catch (_) {}
    } else {
      // v0.7.0 — classify archetype BEFORE harvest so harvest can route channels.
      // Adds ~2s upfront but archetype routing skips irrelevant channels (e.g.
      // SEP for "React Hooks") so total harvest latency is lower or equal.
      try { preHarvestArchetype = await _hyphaAgent.classifyArchetype(topic, goal, settings); }
      catch (_) { preHarvestArchetype = 'TECH-CONCEPT'; }
      _hyphaCancelCheck(slug);
      emit('harvesting');
      sources = await _hyphaAgent.harvest(topic, settings, null, preHarvestArchetype || 'TECH-CONCEPT');
    }
    _hyphaCancelCheck(slug);
    vault.writeJSON(`${slug}/sources.json`, sources);

    emit('designing', { sourceCount: sources.length });
    // v0.4.0 three-stage pipeline replaces the 14k-token monolith. Wall time
    // target ≤ 15s end-to-end. Heartbeat retained in case any sub-call drags.
    const designStart = Date.now();
    const heartbeatId = setInterval(() => {
      const elapsed = Math.round((Date.now() - designStart) / 1000);
      try { emit('designing-heartbeat', { elapsed }); } catch (_) {}
    }, 5000);

    let archetype, seedResult;
    try {
      // Step A: classify archetype (1 small LLM call, ~2s). v0.7.0 — if we
      // already classified pre-harvest (web path), reuse that result instead
      // of re-running. Saves the second classifyArchetype call.
      if (preHarvestArchetype) {
        archetype = preHarvestArchetype;
      } else {
        archetype = await _hyphaAgent.classifyArchetype(topic, goal, settings);
      }
      _hyphaCancelCheck(slug);
      // Step B: source digest (1 small LLM call, ~3s). Compresses 25 raw
      // sources to a ~500-token digest so designSeed isn't drowning in raw lines.
      let sourceDigest = '';
      try { sourceDigest = await _hyphaAgent.summarizeSources(topic, sources, settings, { archetype }); }
      catch (_) { sourceDigest = sources.slice(0, 10).map(s => `- ${s.title}`).join('\n'); }
      _hyphaCancelCheck(slug);
      // Step C: designSeed (1 small LLM call, ~5-8s). Returns phases (from
      // template, no LLM cost), firstLesson, trajectory, and a flat lessonPlan
      // with one slot per phase × phaseLessonCount. Slot 0 has firstLesson;
      // rest are ghost slots awaiting just-in-time materialization.
      seedResult = await _hyphaAgent.designSeed({
        topic, goal: goal || '', archetype,
        timeCommit: timeCommit || 'month',
        customLessons: customLessons,
        tier: tier || 'moderate',
        clarifications: clarifications || [],
        sourceDigest,
      }, settings);
      _hyphaCancelCheck(slug);
    } catch (err) {
      clearInterval(heartbeatId);
      try { vault.del(slug); } catch (_) {}
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
    clearInterval(heartbeatId);

    emit('writing-lessons', { lessonCount: seedResult.lessonPlan.length, archetype });
    // Write only lesson 0 as a real .md; remaining slots write as GHOST stubs
    // (tiny .md with frontmatter ghost: true and body '_pending_'). Ghost
    // lessons will materialize when the user finishes the prior lesson —
    // see the lessons:adapt-after-finish IPC, generalized below.
    const lessonRels = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const slot of seedResult.lessonPlan) {
      const isFirst = slot.idx === 0;
      const isGhost = !!slot.ghost;
      const title = slot.title || (isGhost ? `${slot.phaseLabel} step ${slot.phaseLessonIdx + 1}` : 'Lesson');
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
      // v0.10.0 — pre-read prediction from antechamber wait card. Only the
      // first non-ghost lesson gets it (that's the one the user was looking
      // at when they predicted). Empty/skipped predictions are not written.
      if (isFirst && !isGhost && typeof prePrediction === 'string' && prePrediction.trim()) {
        fmLines.push(`pre_read_prediction: ${JSON.stringify(prePrediction.trim())}`);
      }
      fmLines.push('---');
      const fm = fmLines.join('\n');
      const body = isGhost
        ? `${fm}\n\n# (pending — grows in as you advance)\n\n_pending_\n`
        : `${fm}\n\n# ${title}\n\n## 课程基础\n\n*This lesson hasn't been taught yet. Open the Tutor to begin.*\n\n## 用户灵感\n\n`;
      const rel = `${slug}/${String(slot.idx).padStart(2, '0')}-${isGhost ? 'pending' : _topicSlug(title).slice(0, 30)}.md`;
      vault.write(rel, body);
      lessonRels.push(rel);
    }

    vault.writeJSON(`${slug}/state.json`, {
      mastered: [], gaps: [],
      preferences: { level: level || 'intermediate' },
      goal: goal || '',
      timeCommit: timeCommit || 'month',
      customLessons: (typeof customLessons === 'number') ? customLessons : null,
      tier: tier || 'moderate',
      sourceMode: uploadedSource ? 'upload' : 'web',
      uploadedFileName: uploadedSource ? uploadedSource.fileName : null,
      clarifications: clarifications || [],
      archetype,
      phases: seedResult.phases,
      trajectory: seedResult.trajectory,
      concepts: {},
      lastIdx: -1,
      lessonRels,
    });

    // Auto-derive a tutor persona from topic + goal + clarifications. User can
    // override anytime via right-click → Customize Tutor. Only seeded if no
    // agent.json exists yet (don't clobber an existing customization).
    if (!vault.exists(`${slug}/agent.json`)) {
      const personas = require('./lib/personas');
      const derived = personas.derivePersona({ topic, goal, clarifications: clarifications || [] });
      vault.writeJSON(`${slug}/agent.json`, {
        persona: derived,
        customInstructions: '',
        derivedFromClarifications: true,
        updatedAt: new Date().toISOString(),
      });
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
  return _runCurriculumCreate(event, args);
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
ipcMain.handle('llm:lesson', async (event, { noteRel, userMsg, requestId, sessionFile } = {}) => {
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

  // Build system prompt from lesson-start template (first turn) or use rolling context (subsequent).
  const systemPrompt = await _hyphaAgent.designLesson({
    topic: slug, idx, sequence, sources, state, priorNotes,
    lessonTitle: fm.title || note.body.match(/^# (.+)$/m)?.[1] || '',
    learnGoal: fm.learn_goal || '',
    agentProfile,
    userProfile,
    archetype: state.archetype,
  }, settings);

  let acc = '';
  // Emit start so DeepenCallout shows the running stage indicator.
  try { event.sender.send('llm:deepen-progress', { requestId, status: 'start', stage: 'lesson', label: 'tutor' }); } catch (_) {}

  const onChunk = (text) => {
    acc += text;
    try { event.sender.send('llm:deepen-progress', { requestId, status: 'chunk', stage: 'lesson', text }); } catch (_) {}
  };

  try {
    await _hyphaAgent.streamTurn({ systemPrompt, history: transcript, userMsg, settings, signal: ac.signal }, onChunk);
    vault.appendJSONL(sessionRel, { ts: new Date().toISOString(), idx, role: 'tutor', text: acc });
    _hyphaLessonAbort.delete(requestId);
    if (ac.signal.aborted) {
      try { event.sender.send('llm:deepen-progress', { requestId, status: 'aborted', stage: 'lesson', text: acc }); } catch (_) {}
      return { ok: true, text: acc, sessionFile: sessionRel.split(/[\\/]/).pop(), isNewSession, aborted: true };
    }
    try { event.sender.send('llm:deepen-progress', { requestId, status: 'done', stage: 'lesson', text: acc }); } catch (_) {}
    // Return sessionFile basename so caller can persist + reuse for next turn.
    const usedFile = sessionRel.split(/[\\/]/).pop();
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
ipcMain.handle('lesson:sessions', (_e, { rel } = {}) => {
  if (!rel) return [];
  const note = vault.read(rel);
  if (!note) return [];
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
  const idx = parseInt(fm.lesson_idx, 10);
  if (isNaN(idx)) return [];
  return _listSessionsForLesson(slug, idx);
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
  if (!rel || !sessionFile) return { ok: false, error: 'rel + sessionFile required' };
  const note = vault.read(rel);
  if (!note) return { ok: false, error: 'note not found' };
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
  const idx = parseInt(fm.lesson_idx, 10);
  const turns = vault.readJSONL(`${slug}/sessions/${sessionFile}`)
    .filter(t => t.idx === idx);
  return { ok: true, turns };
});

// lesson:continueFrom — fork a new continuation session seeded with the prior
// session's turns as context. Marks new session mode='continuation' +
// sourceSession=<sourceFile>. Returns new sessionFile basename.
ipcMain.handle('lesson:continueFrom', (_e, { rel, sourceSessionFile } = {}) => {
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
  if (!rel) return null;
  const note = vault.read(rel);
  if (!note) return null;
  const fm = note.frontmatter || {};
  const slug = fm.topic_slug || rel.split(/[\\/]/)[0];
  const idx = parseInt(fm.lesson_idx, 10);
  if (!Number.isFinite(idx)) return null;
  const p = _atlasPath(slug, idx);
  const cur = vault.readJSON(p, null);
  return cur || _atlasEmpty(rel, slug, idx, {
    lesson_title: fm.title || (note.body.match(/^# (.+)$/m) || [])[1] || '',
    learn_goal: String(fm.learn_goal || '').replace(/^"|"$/g, ''),
  });
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
    const quotedLine = quote.text.replace(/\n/g, ' ').slice(0, 320);
    const versionLabel = versions.length > 1 ? ` (v${versions.length})` : '';
    const entry = `\n*${today}*${versionLabel}\n> ${quotedLine}\n— ${insightText}\n`;
    const fmMatch = note.body.match(/^---[\s\S]*?---\s*\n/);
    const fmText = fmMatch ? fmMatch[0] : '';
    const bodyAfterFm = note.body.replace(/^---[\s\S]*?---\s*\n/, '');
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
ipcMain.handle('variance:get', (_e, { rel } = {}) => {
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
    const lessonTitle = lesson
      ? (lesson.frontmatter && lesson.frontmatter.title) ||
        (lesson.body.match(/^# (.+)$/m) || [])[1] ||
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
});

// quote:delete — remove a 金句 from atlas.quotes. Phase 2.3 (council 2026-05-01).
// If the quote had an insight, the 用户灵感 section entry STAYS (it's history;
// we don't retroactively rewrite past notes). atlas.quotes loses the row only.
ipcMain.handle('quote:delete', (_e, { rel, quoteId } = {}) => {
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
    // Phase 3.1 — adapt-after-finish trigger lives renderer-side (NoteView.jsx
    // calls window.ptor.hypha.lessonsAdapt(rel) after this IPC resolves).
    // Renderer-driven keeps the call-site visible and avoids self-import.
    return { ok: true, rel, mode: effectiveMode, newState };
  } catch (err) {
    _hyphaAppendEvent('lesson_finish_error', { topic: slug, idx, error: err.message });
    return { ok: false, error: err.message };
  }
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
ipcMain.handle('settings:get', () => _hyphaSettings());
ipcMain.handle('settings:set', (_e, patch) => {
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
});

// providers:list — expose provider registry to renderer for the settings modal.
ipcMain.handle('providers:list', () => {
  const providers = require('./lib/providers');
  return providers.PROVIDERS;
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

// agent:get — read a curriculum's tutor profile from <topic>/agent.json.
// Returns { persona: 'socratic', customInstructions: '' } as default if missing.
ipcMain.handle('agent:get', (_e, { slug } = {}) => {
  if (!slug) return { persona: 'socratic', customInstructions: '' };
  const cur = vault.readJSON(`${slug}/agent.json`, null);
  if (cur && typeof cur === 'object') return cur;
  return { persona: 'socratic', customInstructions: '' };
});

// agent:set — write a curriculum's tutor profile. Also persists optional
// displayName + avatar (data-URL string, kept on the agent.json itself so the
// curriculum carries its tutor's face with it). Existing fields preserved.
ipcMain.handle('agent:set', (_e, { slug, profile } = {}) => {
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
      try { vault.writeJSON('data/profile.json', { ...restored, updatedAt: new Date().toISOString(), recoveredFromHistory: true }); } catch (_) {}
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
  const lang = /[一-龥]/.test(String(goal)) ? 'zh' : 'en';
  const emit = (stage, extra = {}) => {
    try { event.sender.send('hypha:chain-progress', { stage, ...extra }); } catch (_) {}
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

    const slug = String(goal).toLowerCase().trim().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'chain';
    const chainData = {
      slug, ultimate_goal: goal, lang, created_at: new Date().toISOString(),
      tier: userPacingTier,
      // v0.6.7 — persist customLessons + uploadedSource so chain:start/advance
      // can pass them into _runCurriculumCreate per link. Previously the chain
      // forgot the user's chosen lesson count + dropped the uploaded PDF.
      customLessons: (typeof customLessons === 'number' && customLessons >= 1) ? customLessons : null,
      uploadedSource: (uploadedSource && Array.isArray(uploadedSource.chapters)) ? uploadedSource : null,
      // v0.6.8 — persist archetype so chain:accept's per-link stubs + chain:advance
      // can pick the right phase template without re-running classifyArchetype.
      archetype: chainArchetype || 'TECH-CONCEPT',
      inputs: { timeWeeks: feasibilityInput.timeWeeks, dailyHours: feasibilityInput.dailyHours, priorConsistency: feasibilityInput.priorConsistency, failedAttempts: feasibilityInput.failedAttempts },
      classifications: { difficulty: diff, intrinsic, prior },
      questionnaire: safeAnswers,
      feasibility: verdict,
      plans, chain,
    };
    // v0.6.7 — flag the chain's vault folder as a meta directory so VaultTree
    // can hide it (or render specially). Empty 0-node folders confuse users.
    chainData.is_chain_meta = true;
    vault.writeJSON(`${slug}/chain.json`, chainData);

    emit('done', { slug });
    return { ok: true, slug, data: chainData };
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
// are substantive, not 6-lesson micro courses. Ceiling 200 (single-curric cap).
//
// Formula: round(duration_weeks × 7 × dailyHours / hours_per_lesson × tier_mult × role_mult)
function _perLinkLessonCount(durationWeeks, dailyHours, tier, role) {
  const w = Number(durationWeeks) || 1;
  const hd = Number(dailyHours) || 2;
  const hpl = 1.5;
  const mult = tier === 'gentle' ? 0.6 : tier === 'heroic' ? 1.6 : 1.0;
  const r = String(role || 'core').toLowerCase();
  const roleMult = r === 'prerequisite' ? 1.0
    : r === 'ultimate' ? 2.5
    : 1.5;  // core (or unknown)
  const raw = Math.round(w * 7 * hd / hpl * mult * roleMult);
  return Math.max(25, Math.min(200, raw));
}

// v0.6.9 — pick lessons_count for a chain link. Prefer LLM's explicit value
// (clamped to a sane band per role) over the duration-derived fallback. This
// lets planChain do the smart escalation work; we only fix it if it under-
// or over-shot. Role-aware bands match the planChain prompt rules.
function _resolveLessonsForLink(link, dailyHours, tier) {
  const role = String(link.role || 'core').toLowerCase();
  const tierMult = tier === 'gentle' ? 0.6 : tier === 'heroic' ? 1.6 : 1.0;
  const bands = {
    prerequisite: { min: Math.round(25 * tierMult), max: Math.round(50 * tierMult) },
    core:         { min: Math.round(50 * tierMult), max: Math.round(100 * tierMult) },
    ultimate:     { min: Math.round(80 * tierMult), max: Math.round(150 * tierMult) },
  };
  const band = bands[role] || bands.core;
  const fromLLM = Number(link.lessons_count);
  if (Number.isFinite(fromLLM) && fromLLM >= 20) {
    // Trust but clamp.
    return Math.max(band.min, Math.min(200, Math.round(fromLLM)));
  }
  // Fallback: derive from duration + role.
  return Math.max(band.min, Math.min(200, _perLinkLessonCount(link.duration_weeks, dailyHours, tier, role)));
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
        }, dailyHoursForStubs, chain.tier || 'moderate');
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
        }, dailyHoursForStubs, chain.tier || 'moderate');
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
      try { vault.del(slug); } catch (_) {}
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
    const customLessonsForLink = _resolveLessonsForLink(firstLink, dailyHours, chain.tier || 'moderate');
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
    const advCustomLessons = _resolveLessonsForLink(nextLink, advDailyHours, chain.tier || 'moderate');
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
            try { fs.unlinkSync(path.join(linkDir, f)); } catch (_) {}
          }
        }
      }
    } catch (_) { /* best-effort cleanup */ }
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
ipcMain.handle('curriculum:list', () => {
  const root = vault.resolveRoot();
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const state = vault.readJSON(`${e.name}/state.json`, null);
      if (!state) continue;
      out.push({
        topic: e.name,
        lastIdx: state.lastIdx ?? -1,
        totalLessons: (state.lessonRels || []).length,
        firstLessonRel: state.lessonRels?.[0] || null,
      });
    }
    return out;
  } catch (_) { return []; }
});

app.on('before-quit', () => {
  if (_server) { try { _server.close(); } catch (_) {} }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
