'use strict';

// HYPHA · Distill Runner — sequential 7-phase orchestrator + cache + resume.
//
// Cache layout (per-book, sibling to data/library):
//   vault/.distillation/<book-id>/
//     phase-1.json   phase-2.json   phase-3.json   phase-4.json
//     phase-5.json   phase-6.json   phase-7.json
//     status.json         { book_id, started_at, last_phase, complete, error? }
//
// Resume semantics: each phase reads cache before running. If options.resume
// is true (default) and phase-N.json exists, the phase output is loaded from
// disk and Phase N's LLM call is skipped. Setting resume:false forces a clean
// re-run (and clears the cache directory first).
//
// Events written to <vault>/events.jsonl on every phase completion + on full
// pipeline complete, matching the lib/judges + lib/repair convention
// (fs.appendFileSync line-delimited JSON, no central coordinator).

const fs = require('node:fs');
const path = require('node:path');
const phases = require('./phases');

const SUBDIR = '.distillation';
const TOTAL_PHASES = 7;

// ── Path helpers ───────────────────────────────────────────────────────────

function _bookCacheDir(vaultRoot, bookId) {
  return path.join(vaultRoot, SUBDIR, bookId);
}

function _phasePath(vaultRoot, bookId, n) {
  return path.join(_bookCacheDir(vaultRoot, bookId), `phase-${n}.json`);
}

function _statusPath(vaultRoot, bookId) {
  return path.join(_bookCacheDir(vaultRoot, bookId), 'status.json');
}

function _eventsPath(vaultRoot) {
  return path.join(vaultRoot, 'events.jsonl');
}

function _ensureDir(absDir) {
  try { fs.mkdirSync(absDir, { recursive: true }); } catch (_) {}
}

function _readJSON(absPath) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function _writeJSON(absPath, obj) {
  _ensureDir(path.dirname(absPath));
  fs.writeFileSync(absPath, JSON.stringify(obj, null, 2), 'utf8');
}

function _appendEvent(vaultRoot, row) {
  try {
    _ensureDir(vaultRoot);
    fs.appendFileSync(_eventsPath(vaultRoot), JSON.stringify(row) + '\n', 'utf8');
  } catch (_) { /* best-effort */ }
}

function _writeStatus(vaultRoot, bookId, patch) {
  const current = _readJSON(_statusPath(vaultRoot, bookId)) || { book_id: bookId };
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  _writeJSON(_statusPath(vaultRoot, bookId), next);
  return next;
}

function _clearCache(vaultRoot, bookId) {
  const dir = _bookCacheDir(vaultRoot, bookId);
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir)) {
    try { fs.unlinkSync(path.join(dir, ent)); } catch (_) {}
  }
}

// ── Phase dispatch ─────────────────────────────────────────────────────────

async function _runPhase(n, vaultRoot, book, prior, options) {
  switch (n) {
    case 1: return phases.phase1_buildMap(book, options);
    case 2: {
      // Inject onChapter callback so phase 2 sub-progress lands in status.json,
      // letting the UI render "82/130 · 第八十二章 …" instead of an idle spinner.
      const phase2Opts = {
        ...options,
        onChapter: (done, total, ch) => {
          _writeStatus(vaultRoot, book.id, {
            phase2_done: done,
            phase2_total: total,
            phase2_current_title: ch && ch.title ? ch.title : null,
          });
        },
      };
      return phases.phase2_chapterBreakdown(book, prior.phase1, phase2Opts);
    }
    case 3: return phases.phase3_crossChapterMerge(book, prior.phase2, options);
    case 4: return phases.phase4_frontierize(book, prior.phase3, options);
    case 5: return phases.phase5_critique(book, prior.phase3, options);
    case 6: return phases.phase6_personalize(book, prior, options);
    case 7: return phases.phase7_packageBookSparkPack(book, prior, options);
    default: throw new Error('unknown phase: ' + n);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Distill one book through all 7 phases. Idempotent under default resume=true:
 * already-cached phases are loaded from disk, missing phases run + write.
 *
 * @param {object} args
 * @param {string} args.vaultRoot
 * @param {object} args.book               (from library.getBook(); must include chunks[])
 * @param {object} args.options?
 * @param {boolean} args.options.resume?   default true
 * @param {object}  args.options.goal?     Goal Contract (drives phase 4 + 6)
 * @param {function} args.onPhase?         (phaseN, output) → void  — progress callback
 * @returns {Promise<{ok, phases:{phase1..phase7}, pack, status}>}
 */
async function distillBook({ vaultRoot, book, options, onPhase } = {}) {
  if (!vaultRoot) throw new Error('distillBook: vaultRoot required');
  if (!book || !book.id) throw new Error('distillBook: book.id required');
  if (!Array.isArray(book.chunks)) throw new Error('distillBook: book.chunks required');

  const opts = options || {};
  const resume = opts.resume !== false;
  const bookId = book.id;

  _ensureDir(_bookCacheDir(vaultRoot, bookId));
  if (!resume) _clearCache(vaultRoot, bookId);

  const started = !resume || !_readJSON(_statusPath(vaultRoot, bookId));
  if (started) {
    _writeStatus(vaultRoot, bookId, {
      started_at: new Date().toISOString(),
      complete: false,
      last_phase: 0,
      error: null,
    });
    _appendEvent(vaultRoot, {
      ts: new Date().toISOString(),
      type: 'distill:started',
      book_id: bookId,
      book_title: book.title,
      total_phases: TOTAL_PHASES,
    });
  }

  const prior = {};
  try {
    for (let n = 1; n <= TOTAL_PHASES; n++) {
      const p = _phasePath(vaultRoot, bookId, n);
      let out = null;
      if (resume && fs.existsSync(p)) {
        out = _readJSON(p);
        if (out) {
          prior['phase' + n] = out;
          if (typeof onPhase === 'function') {
            try { onPhase(n, out, { cached: true }); } catch (_) {}
          }
          continue;
        }
      }
      out = await _runPhase(n, vaultRoot, book, prior, opts);
      _writeJSON(p, out);
      prior['phase' + n] = out;
      _writeStatus(vaultRoot, bookId, { last_phase: n });
      _appendEvent(vaultRoot, {
        ts: new Date().toISOString(),
        type: 'distill:phase-completed',
        book_id: bookId,
        phase_n: n,
      });
      if (typeof onPhase === 'function') {
        try { onPhase(n, out, { cached: false }); } catch (_) {}
      }
    }

    const status = _writeStatus(vaultRoot, bookId, { complete: true, last_phase: TOTAL_PHASES });
    _appendEvent(vaultRoot, {
      ts: new Date().toISOString(),
      type: 'distill:complete',
      book_id: bookId,
      book_title: book.title,
    });
    return {
      ok: true,
      book_id: bookId,
      phases: prior,
      pack: prior.phase7 && prior.phase7.pack,
      status,
    };
  } catch (err) {
    const msg = (err && err.message) || String(err);
    const status = _writeStatus(vaultRoot, bookId, { complete: false, error: msg });
    _appendEvent(vaultRoot, {
      ts: new Date().toISOString(),
      type: 'distill:error',
      book_id: bookId,
      error: msg,
    });
    return { ok: false, error: msg, book_id: bookId, phases: prior, status };
  }
}

/**
 * Get cached Book Spark Pack if distillation finished, else null.
 */
function getBookSparkPack({ vaultRoot, bookId }) {
  if (!vaultRoot || !bookId) return null;
  const p7 = _readJSON(_phasePath(vaultRoot, bookId, 7));
  if (!p7 || !p7.pack) return null;
  return p7.pack;
}

function isBookDistilled({ vaultRoot, bookId }) {
  if (!vaultRoot || !bookId) return false;
  const status = _readJSON(_statusPath(vaultRoot, bookId));
  return !!(status && status.complete === true);
}

function getStatus({ vaultRoot, bookId }) {
  if (!vaultRoot || !bookId) return null;
  return _readJSON(_statusPath(vaultRoot, bookId));
}

/**
 * Run a single phase. Used by IPC `distill:phase` for manual step-through
 * (debugging / spec-revision iterations). Reads + writes the same cache.
 */
async function runPhase({ vaultRoot, book, phaseN, options } = {}) {
  if (!vaultRoot) throw new Error('runPhase: vaultRoot required');
  if (!book || !book.id) throw new Error('runPhase: book.id required');
  const n = Number(phaseN);
  if (!Number.isInteger(n) || n < 1 || n > TOTAL_PHASES) throw new Error('runPhase: phaseN out of range');

  const prior = {};
  // Phase N depends on earlier phases — load every prior cache OR fail clearly
  for (let i = 1; i < n; i++) {
    const cached = _readJSON(_phasePath(vaultRoot, book.id, i));
    if (!cached) throw new Error(`runPhase: phase ${n} requires phase ${i} cached first`);
    prior['phase' + i] = cached;
  }
  const out = await _runPhase(n, vaultRoot, book, prior, options || {});
  _writeJSON(_phasePath(vaultRoot, book.id, n), out);
  _writeStatus(vaultRoot, book.id, { last_phase: n, complete: n === TOTAL_PHASES });
  _appendEvent(vaultRoot, {
    ts: new Date().toISOString(),
    type: 'distill:phase-completed',
    book_id: book.id,
    phase_n: n,
    manual: true,
  });
  return { ok: true, phase_n: n, output: out };
}

/**
 * Wipe a book's distillation cache (all phase-*.json + status.json). The next
 * distillBook() call will start from phase 1 fresh. Returns { ok, cleared }
 * where cleared is the byte count freed (best-effort, may be 0 if dir absent).
 */
function clearDistillation({ vaultRoot, bookId } = {}) {
  if (!vaultRoot) throw new Error('clearDistillation: vaultRoot required');
  if (!bookId) throw new Error('clearDistillation: bookId required');
  const dir = _bookCacheDir(vaultRoot, bookId);
  if (!fs.existsSync(dir)) return { ok: true, cleared: 0 };
  let cleared = 0;
  for (const ent of fs.readdirSync(dir)) {
    const p = path.join(dir, ent);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) cleared += st.size;
      fs.unlinkSync(p);
    } catch (_) { /* best-effort */ }
  }
  _appendEvent(vaultRoot, {
    ts: new Date().toISOString(),
    type: 'distill:cleared',
    book_id: bookId,
    bytes_freed: cleared,
  });
  return { ok: true, cleared };
}

module.exports = {
  TOTAL_PHASES,
  distillBook,
  runPhase,
  getBookSparkPack,
  isBookDistilled,
  getStatus,
  clearDistillation,
  // exposed for book-router + tests
  _paths: { _bookCacheDir, _phasePath, _statusPath },
};
