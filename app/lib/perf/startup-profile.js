'use strict';

// HYPHA boot-10 (2026-05-20) — startup performance profiler.
//
// Lightweight wall-clock instrumentation for app boot. Records named
// `markStart` / `markEnd` pairs into an in-memory trace buffer. On app
// ready (or explicit flush), the buffer is persisted to
// `vault/.hypha/startup-trace.jsonl` as one JSON object per startup.
//
// Design constraints:
//   - tiny overhead: uses `process.hrtime.bigint()` (~50ns per call)
//   - never throws into caller: every failure is swallowed + logged
//   - file write is best-effort; smoke tests still verify in-memory shape
//   - safe if `vault` is not yet resolved (skips flush)
//
// Surface:
//   markStart(label)              → records start time, returns label
//   markEnd(label[, extra])       → computes duration_ms, pushes record
//   captureTrace()                → returns shallow copy of current trace
//   flushTrace(vaultRoot)         → writes trace to startup-trace.jsonl
//   resetTrace()                  → for tests
//
// Trace record schema:
//   {
//     label: string,
//     duration_ms: number,    // float, milliseconds
//     ts: string,             // ISO timestamp of markEnd
//     extra?: object          // optional caller-supplied metadata
//   }

const path = require('node:path');
const fs = require('node:fs');

const _starts = new Map();        // label -> bigint hrtime
const _trace = [];                 // array of completed records
let _flushed = false;

function _now() {
  try { return process.hrtime.bigint(); }
  catch (_) { return BigInt(Date.now()) * 1000000n; }
}

function _toMs(diffBig) {
  // bigint nanoseconds -> float milliseconds
  // Math.Number on a bigint loses precision above ~9e15ns (~104 days),
  // far outside any realistic boot window.
  return Number(diffBig) / 1e6;
}

function markStart(label) {
  if (typeof label !== 'string' || !label) return null;
  _starts.set(label, _now());
  return label;
}

function markEnd(label, extra) {
  if (typeof label !== 'string' || !label) return null;
  const t0 = _starts.get(label);
  if (t0 == null) return null;
  _starts.delete(label);
  const dur = _toMs(_now() - t0);
  const rec = {
    label,
    duration_ms: dur,
    ts: new Date().toISOString(),
  };
  if (extra && typeof extra === 'object') rec.extra = extra;
  _trace.push(rec);
  return rec;
}

function captureTrace() {
  // shallow clone so callers can iterate safely while new marks are added
  return _trace.slice();
}

function resetTrace() {
  _starts.clear();
  _trace.length = 0;
  _flushed = false;
}

function flushTrace(vaultRoot) {
  if (_flushed) return { ok: true, skipped: 'already_flushed', records: _trace.length };
  if (!vaultRoot || typeof vaultRoot !== 'string') {
    return { ok: false, error: 'vaultRoot required' };
  }
  try {
    const outDir = path.join(vaultRoot, '.hypha');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'startup-trace.jsonl');
    const envelope = {
      startup_ts: new Date().toISOString(),
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      total_marks: _trace.length,
      total_ms: _trace.reduce((s, r) => s + (r.duration_ms || 0), 0),
      marks: _trace.slice(),
    };
    // append one JSON object per line — JSONL gives history across reboots
    fs.appendFileSync(outFile, JSON.stringify(envelope) + '\n', 'utf8');
    _flushed = true;
    return { ok: true, file: outFile, records: _trace.length };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  markStart,
  markEnd,
  captureTrace,
  resetTrace,
  flushTrace,
};
