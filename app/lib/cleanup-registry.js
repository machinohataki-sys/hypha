'use strict';

// app/lib/cleanup-registry.js — v1.0 boot-11 (2026-05-20)
//
// Long-running v1.0 sessions (hours / days) accumulate timer + cache + watcher
// state. This module is the single unified shutdown registry: anywhere in
// main.js that creates a setInterval / cache eviction loop / fs.watch / abort
// pool, register the corresponding teardown here. On app.before-quit, runAll()
// fires every registered cleanup in registration order, swallowing per-callback
// failures so one bad cleanup never blocks the others.
//
// Design notes:
//   - register/unregister are O(1) via incrementing id + Map.
//   - runAll is single-shot via _drained guard; subsequent calls return the
//     prior summary (idempotent — safe to call from multiple quit hooks).
//   - cleanups run in registration order (insertion order on Map is preserved
//     per ECMAScript spec). Deterministic shutdown ordering matters for
//     observers that need the producer torn down BEFORE the consumer.
//   - status() returns a shallow array of { id, label } — never the fn itself,
//     so callers can render a debug UI without leaking closures.
//
// Usage:
//   const cleanup = require('./lib/cleanup-registry');
//   const handle = setInterval(tick, 60_000);
//   const id = cleanup.register({ label: 'update-poll', cleanup_fn: () => clearInterval(handle) });
//   // later, if the surface is torn down before quit:
//   cleanup.unregister(id);
//   // on app.before-quit:
//   cleanup.runAll();

let _nextId = 1;
const _entries = new Map();   // id → { label, cleanup_fn }
let _drained = false;
let _lastSummary = null;

/**
 * Register a cleanup. Returns an opaque id usable with unregister().
 *
 * @param {{label: string, cleanup_fn: () => void | Promise<void>}} entry
 * @returns {number} id
 */
function register(entry) {
  if (!entry || typeof entry.cleanup_fn !== 'function') {
    throw new TypeError('cleanup-registry: cleanup_fn must be a function');
  }
  if (typeof entry.label !== 'string' || entry.label.length === 0) {
    throw new TypeError('cleanup-registry: label must be a non-empty string');
  }
  if (_drained) {
    // App is shutting down — fire immediately + return a stub id. Caller's
    // late-registration likely came from an async-init race, but we must
    // not silently drop the cleanup.
    try { entry.cleanup_fn(); } catch (_) {}
    return -1;
  }
  const id = _nextId++;
  _entries.set(id, { label: entry.label, cleanup_fn: entry.cleanup_fn });
  return id;
}

/**
 * Remove a cleanup before runAll. Safe to call with unknown / already-removed
 * ids — returns false in those cases.
 *
 * @param {number} id
 * @returns {boolean} true if removed
 */
function unregister(id) {
  if (!Number.isFinite(id) || id < 1) return false;
  return _entries.delete(id);
}

/**
 * Run every registered cleanup in insertion order. Idempotent: subsequent
 * calls return the prior summary without re-firing the callbacks (preventing
 * double-invoke if both before-quit and will-quit are wired).
 *
 * Per-callback failures are caught + recorded but never propagate, so a single
 * broken cleanup cannot block the rest of shutdown.
 *
 * @returns {{total: number, ok: number, failed: Array<{id: number, label: string, error: string}>}}
 */
function runAll() {
  if (_drained) return _lastSummary;
  _drained = true;

  let ok = 0;
  const failed = [];
  // Snapshot the entries first — a cleanup that calls unregister() mid-loop
  // must not perturb the iteration.
  const snapshot = Array.from(_entries.entries());
  for (const [id, entry] of snapshot) {
    try {
      entry.cleanup_fn();
      ok++;
    } catch (e) {
      failed.push({
        id,
        label: entry.label,
        error: (e && e.message) || String(e),
      });
    }
  }

  _entries.clear();
  _lastSummary = { total: snapshot.length, ok, failed };
  return _lastSummary;
}

/**
 * Read-only view of registered cleanups. Callers can render a debug list
 * without leaking closures.
 *
 * @returns {Array<{id: number, label: string}>}
 */
function status() {
  const out = [];
  for (const [id, entry] of _entries.entries()) {
    out.push({ id, label: entry.label });
  }
  return out;
}

/**
 * Test-only reset. Must NEVER be called from production code — clears state
 * + un-drains the registry so smoke tests can exercise runAll twice in one
 * process.
 *
 * @private
 */
function _resetForTests() {
  _entries.clear();
  _nextId = 1;
  _drained = false;
  _lastSummary = null;
}

module.exports = {
  register,
  unregister,
  runAll,
  status,
  _resetForTests,
};
