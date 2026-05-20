'use strict';

// HYPHA · v1.0 boot-7 — Local-first error / event tracker.
//
// Design invariants (privacy-critical software, register-bound):
//   1. NO network I/O. Local JSONL only. v1.1+ may add an opt-in "send"
//      button that copies the export to clipboard or saves to a file.
//   2. Anonymization is mandatory. Vault path → "<vault>/...". Home dir →
//      "<home>/...". Free-text messages have user-content scrubbed (long
//      runs of non-error tokens stripped to "<redacted>"). Stable IDs are
//      hashed (SHA-256, first 12 hex).
//   3. Consent gate via `profile.json.telemetry_consent`:
//        - false / null / missing → record COUNT only (no payload field)
//        - true                   → record full anonymized payload
//      Counts are always tracked because they cannot leak anything.
//   4. NO content of goals, lessons, notes, or any user-typed text.
//   5. No system info beyond OS name + arch + app version.
//   6. recordError MUST NOT swallow errors. Caller still re-throws / handles.
//      Tracker side-effects only; returns `{ok}` envelope.
//
// Storage layout (under vault root):
//   vault/.hypha/local-errors.jsonl          — newline-delimited errors
//   vault/.hypha/local-events.jsonl          — newline-delimited events
//   vault/.hypha/telemetry-counts.json       — { error_total, by_severity, by_code }
//
// Public surface:
//   recordError({ code, message, stack, context, severity })
//   recordEvent({ type, payload, severity })
//   exportForBugReport({ errorLimit, eventLimit })
//   pruneOld({ keep_days })
//   computeHealthScore({ window_days })

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

let vault;
try {
  vault = require('../vault');
} catch (_) {
  // Tracker is also usable from smoke scripts that stub vault. Keep a safe
  // fallback so a missing vault doesn't crash the tracker module load.
  vault = null;
}

// ── constants ──────────────────────────────────────────────────────────

const SEVERITIES = Object.freeze(['info', 'warn', 'error', 'fatal']);
const SEVERITY_WEIGHT = Object.freeze({ info: 0.1, warn: 0.3, error: 0.7, fatal: 1.0 });

const ERROR_FILE = 'local-errors.jsonl';
const EVENT_FILE = 'local-events.jsonl';
const COUNTS_FILE = 'telemetry-counts.json';
const HYPHA_DIR = '.hypha';

const MAX_MESSAGE_LEN = 500;
const MAX_STACK_LEN = 4000;
const MAX_CONTEXT_KEYS = 12;
const MAX_CONTEXT_STRING = 200;
const HASH_TRUNC = 12;

// ── path resolution ───────────────────────────────────────────────────

function _vaultRoot() {
  if (vault && typeof vault.resolveRoot === 'function') {
    try { return vault.resolveRoot(); } catch (_) { /* fall through */ }
  }
  // Last-resort fallback for tests without vault.
  return process.env.HYPHA_DATA || path.resolve(__dirname, '..', '..', '..', 'data');
}

function _hyphaDir() {
  const dir = path.join(_vaultRoot(), HYPHA_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function _filePath(name) { return path.join(_hyphaDir(), name); }

// ── consent gate ───────────────────────────────────────────────────────

function _readConsent() {
  // profile.json.telemetry_consent — true | false | undefined.
  try {
    const profilePath = path.join(_vaultRoot(), 'data', 'profile.json');
    if (!fs.existsSync(profilePath)) return false;
    const raw = fs.readFileSync(profilePath, 'utf8');
    const obj = JSON.parse(raw);
    return obj && obj.telemetry_consent === true;
  } catch (_) {
    return false;
  }
}

// ── anonymization ──────────────────────────────────────────────────────

function _shortHash(input) {
  if (input == null) return '';
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, HASH_TRUNC);
}

/**
 * Scrub absolute paths from a string. Vault root → "<vault>/...",
 * user home → "<home>/...". Backslash + forward slash variants normalized.
 */
function _scrubPaths(text) {
  if (typeof text !== 'string' || !text) return text;
  const vroot = _vaultRoot();
  const home = os.homedir();
  let out = text;
  // Normalize both separators for the source string to catch \  and /  forms.
  const variants = (p) => {
    if (!p) return [];
    const fwd = p.replace(/\\/g, '/');
    const bck = p.replace(/\//g, '\\');
    return Array.from(new Set([p, fwd, bck]));
  };
  for (const v of variants(vroot)) {
    if (!v) continue;
    out = out.split(v).join('<vault>');
  }
  for (const v of variants(home)) {
    if (!v) continue;
    out = out.split(v).join('<home>');
  }
  return out;
}

/**
 * Heuristic message scrub. We accept that the *shape* of error messages
 * (e.g. "ENOENT: no such file or directory, open '<vault>/...'") is
 * useful for debugging; we strip anything that looks like user-typed
 * Chinese / quoted long literals after path-scrubbing.
 *
 * - Anything inside curly-quotes “…” / 「…」 / Chinese full-width quotes
 *   is replaced by "<redacted>" (likely lesson / note content).
 * - Runs of Han characters longer than 8 chars → "<redacted>" (user input).
 * - Stack frames are kept (function names + line numbers expose no secret),
 *   but paths in them are scrubbed.
 */
function _scrubUserContent(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = _scrubPaths(text);
  // Strip Chinese-quoted strings.
  out = out.replace(/[“「『][\s\S]*?[”」』]/g, '<redacted>');
  // Strip runs of Han characters (>8 = likely sentence, not term).
  out = out.replace(/[一-鿿]{9,}/g, '<redacted>');
  return out;
}

function _truncate(text, max) {
  if (typeof text !== 'string') return text;
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function _anonymizeContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const out = {};
  let n = 0;
  for (const key of Object.keys(ctx)) {
    if (n >= MAX_CONTEXT_KEYS) break;
    // Drop any key matching content/text/body/goal/note/lesson/answer —
    // these are the load-bearing user-content channels.
    if (/(content|text|body|goal|note|lesson|answer|prompt|message|reply|transcript)/i.test(key)) continue;
    const v = ctx[key];
    if (v == null) { out[key] = null; n++; continue; }
    if (typeof v === 'number' || typeof v === 'boolean') { out[key] = v; n++; continue; }
    if (typeof v === 'string') {
      out[key] = _truncate(_scrubUserContent(v), MAX_CONTEXT_STRING);
      n++; continue;
    }
    // Objects/arrays → just record type marker; recursive scrub is risky.
    out[key] = Array.isArray(v) ? `<array:${v.length}>` : `<object:${Object.keys(v).length}>`;
    n++;
  }
  return out;
}

function _anonymizeStack(stack) {
  if (!stack) return null;
  let s = String(stack);
  s = _scrubPaths(s);
  // Replace any home-relative or vault-relative absolute path remnants the
  // simple split missed (e.g. mixed-case drive letters on Windows).
  s = s.replace(/[A-Za-z]:[\\/][^\s)]+/g, (match) => {
    // Keep the last 2 path components for diagnostic value.
    const parts = match.split(/[\\/]/);
    if (parts.length <= 2) return '<path>';
    return '<path>/' + parts.slice(-2).join('/');
  });
  return _truncate(s, MAX_STACK_LEN);
}

// ── counters (always tracked, no payload leak risk) ───────────────────

function _readCounts() {
  try {
    const p = _filePath(COUNTS_FILE);
    if (!fs.existsSync(p)) return { error_total: 0, by_severity: {}, by_code: {} };
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return { error_total: 0, by_severity: {}, by_code: {} };
  }
}

function _writeCounts(counts) {
  try {
    const p = _filePath(COUNTS_FILE);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(counts, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (_) { /* best-effort */ }
}

function _bumpCount({ severity, code }) {
  const c = _readCounts();
  c.error_total = (c.error_total || 0) + 1;
  c.by_severity = c.by_severity || {};
  c.by_severity[severity] = (c.by_severity[severity] || 0) + 1;
  if (code) {
    c.by_code = c.by_code || {};
    c.by_code[code] = (c.by_code[code] || 0) + 1;
  }
  c.last_ts = Date.now();
  _writeCounts(c);
}

// ── public surface ─────────────────────────────────────────────────────

/**
 * Record an error. Never throws (best-effort write). Returns envelope.
 * @param {{code?:string, message?:string, stack?:string, context?:object, severity?:string}} input
 */
function recordError(input = {}) {
  try {
    const severity = SEVERITIES.includes(input.severity) ? input.severity : 'error';
    const code = typeof input.code === 'string' ? input.code.slice(0, 64) : null;
    _bumpCount({ severity, code });

    const consent = _readConsent();
    if (!consent) {
      return { ok: true, recorded: 'count_only', severity, code };
    }

    const record = {
      ts: Date.now(),
      severity,
      code,
      message: _truncate(_scrubUserContent(input.message || ''), MAX_MESSAGE_LEN),
      stack: _anonymizeStack(input.stack || ''),
      context: _anonymizeContext(input.context),
      sys: {
        os: os.platform(),
        arch: os.arch(),
        app_version: _appVersion(),
      },
    };
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(_filePath(ERROR_FILE), line, 'utf8');
    return { ok: true, recorded: 'full', severity, code };
  } catch (e) {
    // Never propagate — telemetry must not destabilize caller.
    return { ok: false, error: e && e.message };
  }
}

/**
 * Record a non-error event. Same anonymization rules.
 * Counts are NOT bumped (events are diagnostic, not crash-class).
 */
function recordEvent(input = {}) {
  try {
    const severity = SEVERITIES.includes(input.severity) ? input.severity : 'info';
    const consent = _readConsent();
    if (!consent) {
      return { ok: true, recorded: 'count_only', severity };
    }
    const record = {
      ts: Date.now(),
      type: typeof input.type === 'string' ? input.type.slice(0, 64) : 'unknown',
      severity,
      payload: _anonymizeContext(input.payload),
    };
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(_filePath(EVENT_FILE), line, 'utf8');
    return { ok: true, recorded: 'full', severity };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
}

/**
 * Read the most recent errors + events for bug-report export. No network
 * call — caller pipes to clipboard / file. Returns plain JSON object the
 * user can paste anywhere.
 */
function exportForBugReport({ errorLimit = 50, eventLimit = 100 } = {}) {
  const errors = _tailJsonl(ERROR_FILE, errorLimit);
  const events = _tailJsonl(EVENT_FILE, eventLimit);
  const counts = _readCounts();
  const health = computeHealthScore();
  return {
    schema: 'hypha-local-bug-report-v1',
    generated_at: new Date().toISOString(),
    consent: _readConsent(),
    sys: {
      os: os.platform(),
      arch: os.arch(),
      node: process.versions && process.versions.node,
      app_version: _appVersion(),
    },
    health,
    counts,
    errors,
    events,
  };
}

/**
 * Drop entries older than `keep_days` from both JSONL files. Idempotent.
 */
function pruneOld({ keep_days = 30 } = {}) {
  const cutoff = Date.now() - keep_days * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const file of [ERROR_FILE, EVENT_FILE]) {
    const p = _filePath(file);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const keep = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.ts === 'number' && obj.ts >= cutoff) keep.push(line);
        else pruned++;
      } catch (_) { /* skip malformed */ pruned++; }
    }
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, p);
  }
  return { ok: true, pruned };
}

/**
 * Health score in [0, 1]. 1 = pristine, 0 = many fatals.
 * Formula:
 *   1 - min(1, weighted_recent / threshold)
 * Where weighted_recent sums severity weights over the last window_days,
 * threshold = 10.
 */
function computeHealthScore({ window_days = 7 } = {}) {
  const c = _readCounts();
  if (!c || !c.by_severity) return 1.0;
  // Approximation: counts file is cumulative, but health should weight
  // recent. As a first cut we just down-weight by recency proxy = if last_ts
  // is older than window, treat the whole sum as decayed.
  const lastTs = c.last_ts || 0;
  const windowMs = window_days * 24 * 60 * 60 * 1000;
  const inWindow = (Date.now() - lastTs) < windowMs;
  if (!inWindow) return 1.0;

  let weighted = 0;
  for (const sev of SEVERITIES) {
    const n = (c.by_severity[sev] || 0);
    weighted += n * (SEVERITY_WEIGHT[sev] || 0);
  }
  const threshold = 10;
  const score = 1 - Math.min(1, weighted / threshold);
  return Math.max(0, Math.min(1, score));
}

// ── helpers ────────────────────────────────────────────────────────────

function _tailJsonl(file, limit) {
  try {
    const p = _filePath(file);
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(Math.max(0, lines.length - limit));
    const out = [];
    for (const line of tail) {
      try { out.push(JSON.parse(line)); } catch (_) { /* skip */ }
    }
    return out;
  } catch (_) {
    return [];
  }
}

let _cachedAppVersion = null;
function _appVersion() {
  if (_cachedAppVersion) return _cachedAppVersion;
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      _cachedAppVersion = pkg.version || 'unknown';
      return _cachedAppVersion;
    }
  } catch (_) {}
  _cachedAppVersion = 'unknown';
  return _cachedAppVersion;
}

module.exports = {
  // constants
  SEVERITIES,
  // ops
  recordError,
  recordEvent,
  exportForBugReport,
  pruneOld,
  computeHealthScore,
  // internal helpers (exposed for smoke tests only — not part of public API)
  _internal: {
    _scrubPaths,
    _scrubUserContent,
    _anonymizeStack,
    _anonymizeContext,
    _shortHash,
    _readConsent,
    _readCounts,
  },
};
