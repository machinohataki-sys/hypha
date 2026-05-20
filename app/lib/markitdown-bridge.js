'use strict';

// HYPHA · MarkItDown bridge — convert PDF / DOCX / PPTX / XLSX / EPUB / HTML
// to Markdown by shelling out to Microsoft's MarkItDown Python CLI.
//
// Why subprocess: MarkItDown is a mature Python tool (microsoft/markitdown);
// re-implementing the conversion stack in JS would be a yak-shaving move.
// HYPHA requires the user has Python 3.10+ and `pip install markitdown` once.
//
// Availability is detected lazily (first call to checkAvailability) and the
// result cached for CACHE_MS. Callers that need a fresh check pass {fresh:true}.
//
// All file I/O happens in the OS tmp dir; the converted .md is read back and
// returned as a string, then the tmp file is removed. Caller's responsibility
// to write the MD wherever it wants (library.addBook stages to vault/...).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Lower-case ext (no dot). Anything outside this list throws on convert.
const CONVERTIBLE_EXTS = new Set([
  'pdf',
  'docx',
  'pptx',
  'xlsx', 'xls',
  'epub',
  'html', 'htm',
  'csv', 'json', 'xml',
]);

// Direct-read in source-extractor (no conversion needed).
const NATIVE_MD_EXTS = new Set(['md', 'markdown', 'txt']);

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — large PDFs are slow
// 2026-05-18 user lock 加速: positive cache 永不过期 (session-long); negative
// cache 30s (so retry quickly catches "user just installed markitdown").
const POSITIVE_CACHE_MS = Infinity;
const NEGATIVE_CACHE_MS = 30 * 1000;

let _availabilityCache = null; // { available, version, error, at }

function listConvertibleExtensions() {
  return Array.from(CONVERTIBLE_EXTS);
}

function listAllAcceptedExtensions() {
  return [...NATIVE_MD_EXTS, ...CONVERTIBLE_EXTS];
}

function isConvertible(ext) {
  return CONVERTIBLE_EXTS.has(String(ext || '').toLowerCase().replace(/^\./, ''));
}

function isNativeMd(ext) {
  return NATIVE_MD_EXTS.has(String(ext || '').toLowerCase().replace(/^\./, ''));
}

/**
 * Probe `markitdown --version`. Returns { available, version, error } with
 * 5-minute in-memory cache. Pass { fresh: true } to bypass cache.
 */
async function checkAvailability({ fresh = false } = {}) {
  if (!fresh && _availabilityCache) {
    const age = Date.now() - _availabilityCache.at;
    const ttl = _availabilityCache.available ? POSITIVE_CACHE_MS : NEGATIVE_CACHE_MS;
    if (age < ttl) return _availabilityCache;
  }
  // 2026-05-18 bump 8s → 30s: markitdown[all] cold-start on Windows imports all
  // converters (PDF/EPUB/DOCX/MP3/...) at boot, can easily take 10-20s the first
  // time. Subsequent calls hit the 5-min in-memory cache so 30s is paid only
  // once per process. User repro: Tolkien LOTR EPUB upload → "timeout after 8000ms".
  const result = await _runMarkItDown(['--version'], { timeoutMs: 30_000 })
    .then((r) => {
      if (r.code === 0) {
        const v = (r.stdout || r.stderr || '').trim().split('\n').pop() || '';
        return { available: true, version: v, error: null };
      }
      return { available: false, version: null, error: `exit ${r.code}: ${r.stderr || r.stdout || 'unknown'}` };
    })
    .catch((e) => {
      const msg = (e && e.message) || String(e);
      const notFound = /ENOENT|not found|not recognized|spawn .* ENOENT/i.test(msg);
      return {
        available: false,
        version: null,
        error: notFound
          ? '未检测到 markitdown 命令. 请安装 Python 3.10+ 后运行: pip install "markitdown[all]"'
          : msg,
      };
    });
  _availabilityCache = { ...result, at: Date.now() };
  return _availabilityCache;
}

/**
 * Convert one file → markdown text. Throws on conversion error.
 *
 * @param {string} filePath  absolute path to PDF/DOCX/etc.
 * @param {object} opts
 * @param {number} opts.timeoutMs   default 5 min
 * @param {function} opts.onProgress optional — invoked with { stage, message }
 * @returns {Promise<{mdText: string, sourcePath: string, ext: string}>}
 */
async function convertToMarkdown(filePath, opts = {}) {
  if (!filePath) throw new Error('markitdown: filePath required');
  if (!fs.existsSync(filePath)) throw new Error('markitdown: file not found at ' + filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!isConvertible(ext)) {
    throw new Error(`markitdown: extension .${ext} not in convertible set (${listConvertibleExtensions().join(', ')})`);
  }
  // Probe once before we burn time on the actual call. Cheaper than spawning
  // markitdown on a big PDF and finding out the binary is missing.
  const avail = await checkAvailability();
  if (!avail.available) {
    const err = new Error(`markitdown 不可用: ${avail.error}`);
    err.code = 'MARKITDOWN_UNAVAILABLE';
    throw err;
  }

  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  if (onProgress) onProgress({ stage: 'markitdown-start', message: `转换 .${ext} → MD` });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-md-'));
  const outPath = path.join(tmpDir, 'out.md');

  try {
    const res = await _runMarkItDown(
      [filePath, '-o', outPath],
      { timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS },
    );
    if (res.code !== 0) {
      const stderr = (res.stderr || '').trim();
      const stdout = (res.stdout || '').trim();
      const tail = (stderr || stdout || 'unknown error').split('\n').slice(-6).join('\n');
      throw new Error(`markitdown exit ${res.code}: ${tail}`);
    }
    if (!fs.existsSync(outPath)) {
      throw new Error('markitdown ran but produced no output file');
    }
    const mdText = fs.readFileSync(outPath, 'utf8');
    if (!mdText || mdText.trim().length === 0) {
      throw new Error('markitdown produced empty output (file may be image-only PDF — pre-OCR needed)');
    }
    if (onProgress) onProgress({ stage: 'markitdown-done', message: `转换完成 · ${mdText.length} 字` });
    return { mdText, sourcePath: filePath, ext };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ── Subprocess helpers ─────────────────────────────────────────────────────

function _runMarkItDown(args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    // Windows resolves `markitdown.exe` from PATH; Linux/Mac resolve `markitdown`.
    // shell:true on Windows ensures .exe / .bat / .cmd extension search works
    // without us hard-coding the platform-specific suffix.
    //
    // 2026-05-18 bug repro: 黑客与画家 EPUB filename had spaces + brackets +
    // dots — shell:true on Windows hands args to cmd.exe which tokenizes the
    // joined command line by whitespace, so the filename split into multiple
    // args ("unrecognized arguments: 硅谷创业之父Paul..."). Node's array-arg
    // contract does NOT apply under shell:true — caller must quote. Wrap
    // every arg in double quotes on Windows; escape inner quotes by doubling
    // (cmd.exe convention).
    const onWin = process.platform === 'win32';
    const safeArgs = onWin
      ? args.map((a) => `"${String(a).replace(/"/g, '""')}"`)
      : args;
    const child = spawn('markitdown', safeArgs, {
      shell: onWin,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    const timer = timeoutMs ? setTimeout(() => {
      killedByTimeout = true;
      try { child.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs) : null;
    child.stdout && child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr && child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killedByTimeout) {
        return reject(new Error(`markitdown timeout after ${timeoutMs}ms`));
      }
      resolve({ code: code || 0, stdout, stderr });
    });
  });
}

module.exports = {
  CONVERTIBLE_EXTS,
  NATIVE_MD_EXTS,
  listConvertibleExtensions,
  listAllAcceptedExtensions,
  isConvertible,
  isNativeMd,
  checkAvailability,
  convertToMarkdown,
};
