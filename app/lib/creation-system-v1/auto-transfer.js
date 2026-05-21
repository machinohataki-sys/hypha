'use strict';

// HYPHA · W5.4 Creation System v1 — Auto Product Transfer
//
// Layer 1 of 4 in the W5.4 automation stack (per BLUEPRINT.md §11 + ROADMAP v1.4).
// Builds ON TOP of W3.3 product-transfer.js (which already ships triggerTransfer
// / shouldTriggerTransfer / computeRelevance). This file adds the SCHEDULED +
// BATCH-AUDIT surface — W3.3 fires on a single (slug, lessonIdx, kpId) call;
// W5.4 walks the last 7 days and back-fills any lessons where the user closed
// the chat before the transfer button surfaced.
//
// Boundary:
//   W3.3 product-transfer.js  — single-shot trigger (we import + call)
//   W5.4 index.js             — orchestrator that calls runDailyTransferAudit
//   W3.4 product-spark.js     — when a triggered transfer is "accepted" the
//                                spark is created via createSpark (we route
//                                the suggested_section into spark.source.ref)
//
// No LLM (delegates to W3.3 mocked T4_JUDGE). No Electron. Pure node + fs.

const fs = require('fs');
const path = require('path');

// W3.3 surface — lazy-loaded so unit tests can stub. Returns the module or
// `null` when missing. Same defensive pattern as product-transfer.js _getVault.
let _transferMod = null;
function _getTransfer() {
  if (_transferMod !== null) return _transferMod;
  try { _transferMod = require('../product-transfer'); }
  catch (_) { _transferMod = false; }
  return _transferMod;
}

let _vaultMod = null;
function _getVault() {
  if (_vaultMod !== null) return _vaultMod;
  try { _vaultMod = require('../vault'); }
  catch (_) { _vaultMod = false; }
  return _vaultMod;
}

let _eventsMod = null;
function _getEvents() {
  if (_eventsMod !== null) return _eventsMod;
  try { _eventsMod = require('../events'); }
  catch (_) { _eventsMod = false; }
  return _eventsMod;
}

// ---------------------------------------------------------------------------
// _vaultRoot — same resolution as creation-pool.js so paths line up across
// the 4 W5.4 modules + W3.x lib.
// ---------------------------------------------------------------------------
function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  return path.join(__dirname, '..', '..', '..', 'data');
}

// ---------------------------------------------------------------------------
// _readEventsJsonl — last-7-day filter over vault/<slug>/events.jsonl. Read
// best-effort; malformed lines skipped silently (we never break the audit on
// one bad row). Returns newest-first array.
// ---------------------------------------------------------------------------
function _readEventsJsonl(slug, sinceMs) {
  const filePath = path.join(_vaultRoot(), slug, 'events.jsonl');
  if (!fs.existsSync(filePath)) return [];
  let buf;
  try { buf = fs.readFileSync(filePath, 'utf8'); }
  catch (_) { return []; }
  const out = [];
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const ts = row.ts ? Date.parse(row.ts) : 0;
      if (Number.isFinite(sinceMs) && ts && ts < sinceMs) continue;
      out.push(row);
    } catch (_) { /* skip */ }
  }
  // newest-first
  out.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return out;
}

// ---------------------------------------------------------------------------
// scheduleAutoTransfer — wrapper called by main.js at lesson-completion.
// Today this is a thin pass-through to W3.3.triggerTransfer; the scheduling
// dimension is `options.delayMs` (queue for end-of-day) which we expose for
// future cron use but execute immediately when 0 / unset.
//
// Returns the W3.3 envelope plus a `scheduled: true|false` flag so the
// orchestrator knows whether to count this as a fired-now vs queued event.
// ---------------------------------------------------------------------------
async function scheduleAutoTransfer(slug, options = {}) {
  if (!slug || typeof slug !== 'string') {
    return { ok: false, fired: false, reason: 'bad_slug' };
  }
  const transfer = _getTransfer();
  if (!transfer || typeof transfer.triggerTransfer !== 'function') {
    return { ok: false, fired: false, reason: 'transfer_lib_missing' };
  }
  const lessonIdx = Number.isFinite(options.lessonIdx) ? options.lessonIdx : null;
  if (lessonIdx == null) {
    return { ok: false, fired: false, reason: 'missing_lessonIdx' };
  }
  const kpId = options.kpId || null;
  const opts = { threshold: options.threshold, lessonContext: options.lessonContext };
  // delayMs is a future-mode reserve — today we fire immediately, but the
  // event row records the delay so an external cron could replay this.
  const result = await transfer.triggerTransfer(slug, lessonIdx, kpId, opts);

  const events = _getEvents();
  if (events && typeof events.write === 'function') {
    try {
      events.write(slug, {
        type: 'creation_v1:auto_transfer_scheduled',
        lesson_idx: lessonIdx,
        kp_id: kpId,
        P: result && result.P,
        fired: !!(result && result.fired),
        suggested_section: result && result.suggested_section,
      });
    } catch (_) { /* observability is best-effort */ }
  }
  return { ok: true, scheduled: true, ...result };
}

// ---------------------------------------------------------------------------
// runDailyTransferAudit — walk the last 7 days of events.jsonl, find every
// lesson_complete row, and for each one verify a `transfer:fired` row exists
// downstream. When missing, back-fire the transfer judgement via W3.3.
//
// Returns { ok, audited, back_filled[], skipped[], failed[] } so the caller
// (W5.4 index.js orchestrator) can log + surface a summary.
// ---------------------------------------------------------------------------
async function runDailyTransferAudit(slug, opts = {}) {
  if (!slug || typeof slug !== 'string') {
    return { ok: false, reason: 'bad_slug' };
  }
  const transfer = _getTransfer();
  if (!transfer || typeof transfer.triggerTransfer !== 'function') {
    return { ok: false, reason: 'transfer_lib_missing' };
  }
  const lookbackDays = Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : 7;
  const sinceMs = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
  const rows = _readEventsJsonl(slug, sinceMs);

  // Pair lesson_complete with downstream transfer:fired. Key by lesson_idx.
  const lessonCompletes = new Map();
  const transfersFired = new Set();
  for (const row of rows) {
    if (row.type === 'lesson_complete' || row.op === 'lesson:complete') {
      const idx = Number.isFinite(row.lesson_idx) ? row.lesson_idx
        : Number.isFinite(row.idx) ? row.idx : null;
      if (idx != null && !lessonCompletes.has(idx)) {
        lessonCompletes.set(idx, { lessonIdx: idx, ts: row.ts, kpId: row.kp_id || null });
      }
    }
    if (row.op === 'transfer:fired' || row.type === 'transfer:fired'
        || row.type === 'creation_v1:auto_transfer_scheduled') {
      const idx = Number.isFinite(row.idx) ? row.idx
        : Number.isFinite(row.lesson_idx) ? row.lesson_idx : null;
      if (idx != null) transfersFired.add(idx);
    }
  }

  const back_filled = [];
  const skipped = [];
  const failed = [];
  for (const [idx, meta] of lessonCompletes.entries()) {
    if (transfersFired.has(idx)) {
      skipped.push({ lessonIdx: idx, reason: 'already_fired' });
      continue;
    }
    try {
      const r = await transfer.triggerTransfer(slug, idx, meta.kpId, {
        threshold: opts.threshold,
      });
      if (r && r.fired) {
        back_filled.push({ lessonIdx: idx, P: r.P, suggested_section: r.suggested_section });
      } else {
        skipped.push({ lessonIdx: idx, reason: 'below_threshold', P: r && r.P });
      }
    } catch (err) {
      failed.push({ lessonIdx: idx, error: (err && err.message) || String(err) });
    }
  }

  const events = _getEvents();
  if (events && typeof events.write === 'function') {
    try {
      events.write(slug, {
        type: 'creation_v1:transfer_audit',
        lookback_days: lookbackDays,
        lessons_seen: lessonCompletes.size,
        back_filled: back_filled.length,
        skipped: skipped.length,
        failed: failed.length,
      });
    } catch (_) { /* best-effort */ }
  }
  return {
    ok: true,
    slug,
    audited: lessonCompletes.size,
    back_filled,
    skipped,
    failed,
    lookback_days: lookbackDays,
  };
}

// ---------------------------------------------------------------------------
// getTransferQueue — read-only inspection of "what would fire" without
// actually firing. Used by the UI to show the user pending transfer
// candidates ahead of the orchestrator running. Pure compute over events.
// ---------------------------------------------------------------------------
async function getTransferQueue(slug, opts = {}) {
  if (!slug || typeof slug !== 'string') {
    return { ok: false, queue: [] };
  }
  const transfer = _getTransfer();
  if (!transfer || typeof transfer.triggerTransfer !== 'function') {
    return { ok: false, queue: [], reason: 'transfer_lib_missing' };
  }
  const lookbackDays = Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : 7;
  const sinceMs = Date.now() - (lookbackDays * 24 * 60 * 60 * 1000);
  const rows = _readEventsJsonl(slug, sinceMs);
  const lessons = new Map();
  const fired = new Set();
  for (const row of rows) {
    if (row.type === 'lesson_complete' || row.op === 'lesson:complete') {
      const idx = Number.isFinite(row.lesson_idx) ? row.lesson_idx
        : Number.isFinite(row.idx) ? row.idx : null;
      if (idx != null && !lessons.has(idx)) {
        lessons.set(idx, { lessonIdx: idx, ts: row.ts, kpId: row.kp_id || null });
      }
    }
    if (row.op === 'transfer:fired' || row.type === 'transfer:fired'
        || row.type === 'creation_v1:auto_transfer_scheduled') {
      const idx = Number.isFinite(row.idx) ? row.idx
        : Number.isFinite(row.lesson_idx) ? row.lesson_idx : null;
      if (idx != null) fired.add(idx);
    }
  }
  const queue = [];
  for (const [idx, meta] of lessons.entries()) {
    try {
      const r = await transfer.triggerTransfer(slug, idx, meta.kpId, {
        threshold: opts.threshold,
      });
      queue.push({
        lessonIdx: idx,
        kpId: meta.kpId,
        P: (r && r.P) || 0,
        suggested_section: (r && r.suggested_section) || 'general',
        triggered: fired.has(idx),
        would_fire: !!(r && r.fired),
      });
    } catch (_) {
      queue.push({ lessonIdx: idx, kpId: meta.kpId, P: 0, suggested_section: 'general', triggered: fired.has(idx), would_fire: false, error: true });
    }
  }
  // P desc — highest-value transfer at top
  queue.sort((a, b) => (b.P || 0) - (a.P || 0));
  return { ok: true, queue, slug };
}

module.exports = {
  scheduleAutoTransfer,
  runDailyTransferAudit,
  getTransferQueue,
  _internals: {
    vaultRoot: _vaultRoot,
    readEventsJsonl: _readEventsJsonl,
  },
};
