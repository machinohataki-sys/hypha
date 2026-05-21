'use strict';

// HYPHA · α16 Project Spine (Growth System §28 子组件 v0)
//
// 跨课程持续追踪的"项目骨架"事件流。用户学一个长期 topic 时, 会有:
//   decision      — 决定先读 X 而非 Y
//   hypothesis    — 假设 X 是整个体系的核心
//   open-question — X 与 Y 的区别还没想清
//   building-on   — L3 关于 X 的洞见接 L1 关于 Y
//   revisit-later — X 先放着, 之后回访
//
// 不是 LLM-derived。这是 user-driven 的记录工具。
//
// Public surface:
//   addSpineEntry({ slug, kind, content, sourceLessonIdx, sourceLessonTitle, tags })
//     → { ok:true, entry } | { ok:false, error: 'INVALID_KIND'|'TOO_LONG'|'MISSING_SLUG'|'EMPTY_CONTENT'|'EXCEPTION' }
//   listSpine({ slug, limit = 50, kindFilter = null })
//     → { ok:true, entries } | { ok:false, error: 'EXCEPTION' }
//   removeSpineEntry({ slug, entryId })
//     → { ok:true, removed:true } | { ok:false, error: 'EXCEPTION' }
//
// Storage: vault/<slug>/.project-spine.jsonl, 每行 1 JSON。
// soft-delete: 不真删, append `{id, ts, tombstone:true}` 行, list 时 filter。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolveRoot } = require('../vault');
// Reuse the vague-falsifier guard from Creation System Decision Log — single
// source of truth for "what counts as a concrete, measurable falsifier".
const { _falsifierGuard } = require('../creation/decision-log');

const KIND_ENUM = Object.freeze([
  'decision',
  'hypothesis',
  'open-question',
  'building-on',
  'revisit-later',
  'milestone',
]);

const MAX_CONTENT_LEN = 2000;
const MAX_FALSIFIER_LEN = 600;

function _spinePath(slug) {
  const vaultRoot = resolveRoot();
  return path.join(vaultRoot, String(slug), '.project-spine.jsonl');
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

// Validate optional milestone-falsifier sub-doc. Mirrors decision-log shape
// (claim/falsifier/deadline_iso) — same guard, same vagueness rejection. On
// invalid: return ERR string; on absent: return null silently.
function _validateMilestoneFalsifier(f) {
  if (f === undefined || f === null) return { ok: true, value: null };
  if (typeof f !== 'object' || Array.isArray(f)) {
    return { ok: false, reason: 'falsifier must be object' };
  }
  const min = _falsifierGuard.MIN_PREDICTION_CHARS;
  const claim = typeof f.claim === 'string' ? f.claim.trim() : '';
  const falsifier = typeof f.falsifier === 'string' ? f.falsifier.trim() : '';
  const deadline = typeof f.deadline_iso === 'string' ? f.deadline_iso.trim() : '';
  if (claim.length < min) return { ok: false, reason: `falsifier.claim < ${min} chars` };
  if (falsifier.length < min) return { ok: false, reason: `falsifier.falsifier < ${min} chars` };
  if (falsifier.length > MAX_FALSIFIER_LEN) return { ok: false, reason: 'falsifier.falsifier too long' };
  if (deadline.length < min) return { ok: false, reason: 'falsifier.deadline_iso missing' };
  if (!Number.isFinite(Date.parse(deadline))) {
    return { ok: false, reason: 'falsifier.deadline_iso not parseable ISO' };
  }
  if (_falsifierGuard.isVagueFalsifier(falsifier)) {
    return { ok: false, reason: 'falsifier vague — needs number/comparator/date anchor' };
  }
  return { ok: true, value: { claim, falsifier, deadline_iso: deadline } };
}

async function addSpineEntry({
  slug,
  kind,
  content,
  sourceLessonIdx = null,
  sourceLessonTitle = null,
  tags = [],
  falsifier = null,
} = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    if (!KIND_ENUM.includes(kind)) {
      return { ok: false, error: 'INVALID_KIND' };
    }
    const trimmed = (typeof content === 'string') ? content.trim() : '';
    if (!trimmed) {
      return { ok: false, error: 'EMPTY_CONTENT' };
    }
    if (trimmed.length > MAX_CONTENT_LEN) {
      return { ok: false, error: 'TOO_LONG' };
    }

    const falsifierCheck = _validateMilestoneFalsifier(falsifier);
    if (!falsifierCheck.ok) {
      return { ok: false, error: 'INVALID_FALSIFIER', message: falsifierCheck.reason };
    }

    const entry = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      kind,
      content: trimmed,
      sourceLessonIdx: (typeof sourceLessonIdx === 'number' && Number.isFinite(sourceLessonIdx))
        ? sourceLessonIdx
        : null,
      sourceLessonTitle: (typeof sourceLessonTitle === 'string' && sourceLessonTitle.trim())
        ? sourceLessonTitle.trim()
        : null,
      tags: Array.isArray(tags)
        ? tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()).slice(0, 16)
        : [],
      tombstone: false,
    };
    if (falsifierCheck.value) entry.falsifier = falsifierCheck.value;

    const abs = _spinePath(slug);
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      console.warn('[project-spine] append failed:', err && err.message);
      return { ok: false, error: 'EXCEPTION', message: err && err.message };
    }

    return { ok: true, entry };
  } catch (err) {
    console.warn('[project-spine] addSpineEntry EXCEPTION:', err && err.stack);
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function listSpine({ slug, limit = 50, kindFilter = null } = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: true, entries: [] };
    }
    const abs = _spinePath(slug);
    const rows = _readAllRows(abs);
    if (rows.length === 0) return { ok: true, entries: [] };

    // 收集 tombstone id 集合
    const tombstoned = new Set();
    for (const r of rows) {
      if (r && r.tombstone === true && r.id) tombstoned.add(r.id);
    }

    // 过滤 tombstone marker 行 + 被 tombstone 的 entry
    let kept = rows.filter(r => r && r.tombstone !== true && !tombstoned.has(r.id));

    if (kindFilter && KIND_ENUM.includes(kindFilter)) {
      kept = kept.filter(r => r.kind === kindFilter);
    }

    // 新→旧
    kept.reverse();

    const cap = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : 50;
    return { ok: true, entries: kept.slice(0, cap) };
  } catch (err) {
    console.warn('[project-spine] listSpine EXCEPTION:', err && err.stack);
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function removeSpineEntry({ slug, entryId } = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    if (!entryId || typeof entryId !== 'string') {
      return { ok: false, error: 'EXCEPTION', message: 'entryId required' };
    }
    const abs = _spinePath(slug);
    const tombstoneRow = {
      id: entryId,
      ts: new Date().toISOString(),
      tombstone: true,
    };
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, JSON.stringify(tombstoneRow) + '\n', 'utf-8');
    } catch (err) {
      console.warn('[project-spine] tombstone append failed:', err && err.message);
      return { ok: false, error: 'EXCEPTION', message: err && err.message };
    }
    return { ok: true, removed: true };
  } catch (err) {
    console.warn('[project-spine] removeSpineEntry EXCEPTION:', err && err.stack);
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

module.exports = {
  addSpineEntry,
  listSpine,
  removeSpineEntry,
  _internals: {
    KIND_ENUM,
    MAX_CONTENT_LEN,
    MAX_FALSIFIER_LEN,
    validateMilestoneFalsifier: _validateMilestoneFalsifier,
  },
};
