'use strict';

// HYPHA · α19 Privacy Memory (Infrastructure §16 子组件 v0, 2026-05-16)
//
// 决定不让出去的话 — user 在某些段落、姓名、地点上画一道线, scrub 会在
// 任何外发 text 之前把命中处用 `<redacted:label>` 替掉。append-only jsonl
// + soft tombstone delete + aggregate-on-read。
//
// Privacy 是全局 surface (! per-slug), 因此走 vault/data/ 全局目录:
//   vault/data/privacy-memory.jsonl      — redaction rows + tombstones
//   vault/data/privacy-memory-log.jsonl  — scrub 调用统计, ! 记 pattern, ! 记 scrubbed text
//
// Public surface:
//   addRedaction({ pattern, label, category='other', notes='' })
//     → { ok:true, redaction } | { ok:false, error }
//   removeRedaction({ id })
//     → { ok:true } | { ok:false, error }
//   listRedactions()
//     → { ok:true, rows:[...] } | { ok:false, error }
//   scrubText({ text, dryRun=false })
//     → { ok:true, scrubbed, redactionCount, hits:[{label, count}] }
//        | { ok:false, error }
//   getPrivacyLog({ limit=50 })
//     → { ok:true, log:[...] } | { ok:false, error }
//
// Error codes:
//   INVALID_CATEGORY / MISSING_PATTERN / MISSING_LABEL / NOT_FOUND / EXCEPTION

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolveRoot } = require('../vault');

// ---------------------------------------------------------------------------
// Enums + constants
// ---------------------------------------------------------------------------

const CATEGORY_ENUM = Object.freeze(['pii', 'topic', 'name', 'location', 'other']);

const REDACTION_FILE = 'privacy-memory.jsonl';
const LOG_FILE = 'privacy-memory-log.jsonl';

// ---------------------------------------------------------------------------
// Path helpers (vault/data/ global, ! per-slug)
// ---------------------------------------------------------------------------

function _redactionPath() {
  const root = resolveRoot();
  return path.join(root, 'data', REDACTION_FILE);
}

function _logPath() {
  const root = resolveRoot();
  return path.join(root, 'data', LOG_FILE);
}

function _ensureDir(abs) {
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch (_) { /* swallow */ }
}

function _readAllRows(abs) {
  if (!fs.existsSync(abs)) return [];
  let text = '';
  try { text = fs.readFileSync(abs, 'utf-8'); }
  catch (_) { return []; }
  if (!text) return [];
  const out = [];
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

function _appendRow(abs, obj) {
  _ensureDir(abs);
  fs.appendFileSync(abs, JSON.stringify(obj) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// addRedaction
// ---------------------------------------------------------------------------

async function addRedaction(payload = {}) {
  try {
    const pattern = typeof payload.pattern === 'string' ? payload.pattern.trim() : '';
    const label = typeof payload.label === 'string' ? payload.label.trim() : '';
    const category = typeof payload.category === 'string' ? payload.category.trim() : 'other';
    const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';

    if (!pattern) return { ok: false, error: 'MISSING_PATTERN' };
    if (!label)   return { ok: false, error: 'MISSING_LABEL' };
    if (!CATEGORY_ENUM.includes(category)) return { ok: false, error: 'INVALID_CATEGORY' };

    const row = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      pattern,
      label,
      category,
      notes,
      tombstone: false,
    };
    _appendRow(_redactionPath(), row);
    return { ok: true, redaction: row };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

// ---------------------------------------------------------------------------
// removeRedaction — soft delete via tombstone row
// ---------------------------------------------------------------------------

async function removeRedaction(payload = {}) {
  try {
    const id = typeof payload.id === 'string' ? payload.id.trim() : '';
    if (!id) return { ok: false, error: 'NOT_FOUND' };

    const rows = _readAllRows(_redactionPath());
    const seed = rows.find(r => r && r.id === id && r.tombstone === false);
    if (!seed) return { ok: false, error: 'NOT_FOUND' };

    _appendRow(_redactionPath(), {
      id,
      ts: new Date().toISOString(),
      tombstone: true,
    });
    return { ok: true };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

// ---------------------------------------------------------------------------
// listRedactions — active only, dedup by id, filter tombstoned
// ---------------------------------------------------------------------------

async function listRedactions() {
  try {
    const abs = _redactionPath();
    if (!fs.existsSync(abs)) return { ok: true, rows: [] };
    const rows = _readAllRows(abs);

    // Collect tombstoned ids.
    const tombstoned = new Set();
    for (const r of rows) {
      if (r && r.tombstone === true && typeof r.id === 'string') tombstoned.add(r.id);
    }

    // Reverse + dedup by id. Skip tombstone rows themselves + skip ids that
    // appear in tombstoned set.
    const seen = new Set();
    const out = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (!r || typeof r !== 'object') continue;
      if (r.tombstone === true) continue;
      if (!r.id || seen.has(r.id)) continue;
      if (tombstoned.has(r.id)) continue;
      seen.add(r.id);
      out.push(r);
    }
    return { ok: true, rows: out };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

// ---------------------------------------------------------------------------
// scrubText — case-insensitive substring replace of all active patterns
// ---------------------------------------------------------------------------

function _countOccurrencesCI(haystack, needle) {
  if (!needle) return 0;
  const hLower = haystack.toLowerCase();
  const nLower = needle.toLowerCase();
  let count = 0;
  let idx = 0;
  while (true) {
    const at = hLower.indexOf(nLower, idx);
    if (at === -1) break;
    count++;
    idx = at + nLower.length;
  }
  return count;
}

function _replaceAllCI(haystack, needle, replacement) {
  if (!needle) return haystack;
  const hLower = haystack.toLowerCase();
  const nLower = needle.toLowerCase();
  let out = '';
  let cursor = 0;
  while (true) {
    const at = hLower.indexOf(nLower, cursor);
    if (at === -1) {
      out += haystack.slice(cursor);
      break;
    }
    out += haystack.slice(cursor, at) + replacement;
    cursor = at + nLower.length;
  }
  return out;
}

async function scrubText(payload = {}) {
  try {
    const text = typeof payload.text === 'string' ? payload.text : '';
    const dryRun = payload.dryRun === true;

    const listed = await listRedactions();
    if (!listed.ok) return { ok: false, error: 'EXCEPTION' };

    let scrubbed = text;
    let total = 0;
    const hits = [];
    for (const r of listed.rows) {
      if (!r || typeof r.pattern !== 'string' || !r.pattern) continue;
      const label = typeof r.label === 'string' ? r.label : '';
      const count = _countOccurrencesCI(scrubbed, r.pattern);
      if (count > 0) {
        scrubbed = _replaceAllCI(scrubbed, r.pattern, `<redacted:${label}>`);
        total += count;
        hits.push({ label, count });
      }
    }

    if (!dryRun) {
      _logRedaction({
        ts: new Date().toISOString(),
        contextHint: 'unknown',
        redactionCount: total,
      });
    }

    return { ok: true, scrubbed, redactionCount: total, hits };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

// ---------------------------------------------------------------------------
// _logRedaction — internal, exported for tests. ! 记 pattern, ! 记 scrubbed text.
// ---------------------------------------------------------------------------

function _logRedaction(entry) {
  try {
    const row = {
      ts: typeof entry?.ts === 'string' ? entry.ts : new Date().toISOString(),
      contextHint: typeof entry?.contextHint === 'string' ? entry.contextHint : 'unknown',
      redactionCount: Number.isFinite(entry?.redactionCount) ? entry.redactionCount : 0,
    };
    _appendRow(_logPath(), row);
  } catch (_) { /* swallow — log is best-effort */ }
}

// ---------------------------------------------------------------------------
// getPrivacyLog — reverse + limit
// ---------------------------------------------------------------------------

async function getPrivacyLog(payload = {}) {
  try {
    const limit = Number.isFinite(payload?.limit) && payload.limit > 0
      ? Math.floor(payload.limit) : 50;

    const abs = _logPath();
    if (!fs.existsSync(abs)) return { ok: true, log: [] };
    const rows = _readAllRows(abs);
    const out = [];
    for (let i = rows.length - 1; i >= 0 && out.length < limit; i--) {
      const r = rows[i];
      if (r && typeof r === 'object') out.push(r);
    }
    return { ok: true, log: out };
  } catch (_) {
    return { ok: false, error: 'EXCEPTION' };
  }
}

module.exports = {
  addRedaction,
  removeRedaction,
  listRedactions,
  scrubText,
  getPrivacyLog,
  _logRedaction,
  CATEGORY_ENUM,
};
