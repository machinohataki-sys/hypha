'use strict';

// α17 · HYPHA Book Router Cache — Knowledge Source System 子 v0 backend.
//
// Per BLUEPRINT §29 (Knowledge Source System): Book Router uses a caching
// layer so the same source (PDF/MD/URL) extracted for one curriculum can be
// reused across other curricula without re-parsing and without re-paying the
// LLM extraction-time tokens.
//
// This file ships the pure-file-ops cache layer (no source-extractor.js
// integration this wave — the consumer wiring lands next wave).
//
// Cache layout under `vault/.book-router-cache/`:
//   <sha256>.meta.json   — { sha256, filename, sourceType, mimeType, byteSize,
//                            extractedAt, sourceMeta }
//   <sha256>.text.md     — the extracted markdown body (may be multi-MB)
//   index.jsonl          — append-only reverse-time index:
//                            { sha256, filename, extractedAt, byteSize,
//                              charsExtracted }
//                            or tombstone: { sha256, tombstone:true, ts }
//
// All errors are surfaced as { ok:false, error: ENUM } + console.warn — never
// throw across the IPC boundary.

const fs = require('node:fs');
const path = require('node:path');
const { resolveRoot } = require('../vault');

const CACHE_DIRNAME = '.book-router-cache';
const SHA256_RE = /^[a-f0-9]{8,128}$/i;

function cacheDir() {
  const dir = path.join(resolveRoot(), CACHE_DIRNAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn('[book-router-cache] mkdir failed:', err && err.message);
  }
  return dir;
}

function metaPath(sha256) {
  return path.join(cacheDir(), `${sha256}.meta.json`);
}

function textPath(sha256) {
  return path.join(cacheDir(), `${sha256}.text.md`);
}

function indexPath() {
  return path.join(cacheDir(), 'index.jsonl');
}

function isValidSha(sha) {
  return typeof sha === 'string' && SHA256_RE.test(sha);
}

async function lookupBySha256({ sha256 } = {}) {
  if (!isValidSha(sha256)) {
    return { ok: false, error: 'INVALID_SHA' };
  }
  try {
    const meta = metaPath(sha256);
    const text = textPath(sha256);
    if (!fs.existsSync(meta) || !fs.existsSync(text)) {
      return { ok: true, hit: false };
    }
    const metaRaw = fs.readFileSync(meta, 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(metaRaw);
    } catch (err) {
      console.warn('[book-router-cache] meta parse failed for', sha256, err.message);
      return { ok: false, error: 'META_PARSE_FAILED' };
    }
    const extractedText = fs.readFileSync(text, 'utf-8');
    return {
      ok: true,
      hit: true,
      extractedAt: parsed.extractedAt || null,
      sourceMeta: parsed.sourceMeta || {},
      extractedText,
    };
  } catch (err) {
    console.warn('[book-router-cache] lookup failed:', err && err.message);
    return { ok: false, error: 'LOOKUP_FAILED' };
  }
}

async function storeExtraction({
  sha256,
  filename,
  sourceType,
  mimeType,
  byteSize,
  extractedText,
  sourceMeta,
} = {}) {
  if (!isValidSha(sha256)) {
    return { ok: false, error: 'INVALID_SHA' };
  }
  if (typeof extractedText !== 'string') {
    return { ok: false, error: 'INVALID_TEXT' };
  }
  try {
    const extractedAt = new Date().toISOString();
    const metaObj = {
      sha256,
      filename: typeof filename === 'string' ? filename : '',
      sourceType: typeof sourceType === 'string' ? sourceType : '',
      mimeType: typeof mimeType === 'string' ? mimeType : '',
      byteSize: Number.isFinite(byteSize) ? byteSize : 0,
      extractedAt,
      sourceMeta: sourceMeta && typeof sourceMeta === 'object' ? sourceMeta : {},
    };
    fs.writeFileSync(metaPath(sha256), JSON.stringify(metaObj, null, 2), 'utf-8');
    fs.writeFileSync(textPath(sha256), extractedText, 'utf-8');
    const indexRow = {
      sha256,
      filename: metaObj.filename,
      extractedAt,
      byteSize: metaObj.byteSize,
      charsExtracted: extractedText.length,
    };
    fs.appendFileSync(indexPath(), JSON.stringify(indexRow) + '\n', 'utf-8');
    return { ok: true, cacheKey: sha256 };
  } catch (err) {
    console.warn('[book-router-cache] store failed:', err && err.message);
    return { ok: false, error: 'STORE_FAILED' };
  }
}

async function listCachedSources({ limit = 50 } = {}) {
  try {
    const idx = indexPath();
    if (!fs.existsSync(idx)) {
      return { ok: true, rows: [] };
    }
    const raw = fs.readFileSync(idx, 'utf-8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
    // Reverse-time: walk from tail; dedup by sha256, honoring tombstones.
    const seen = new Set();
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < cap; i -= 1) {
      let row;
      try {
        row = JSON.parse(lines[i]);
      } catch (_) {
        continue;
      }
      if (!row || !row.sha256 || seen.has(row.sha256)) continue;
      seen.add(row.sha256);
      if (row.tombstone) continue;
      out.push(row);
    }
    return { ok: true, rows: out };
  } catch (err) {
    console.warn('[book-router-cache] list failed:', err && err.message);
    return { ok: false, error: 'LIST_FAILED' };
  }
}

async function purgeCacheEntry({ sha256 } = {}) {
  if (!isValidSha(sha256)) {
    return { ok: false, error: 'INVALID_SHA' };
  }
  try {
    const meta = metaPath(sha256);
    const text = textPath(sha256);
    try { if (fs.existsSync(meta)) fs.unlinkSync(meta); } catch (e) {
      console.warn('[book-router-cache] unlink meta failed:', e && e.message);
    }
    try { if (fs.existsSync(text)) fs.unlinkSync(text); } catch (e) {
      console.warn('[book-router-cache] unlink text failed:', e && e.message);
    }
    const tombstone = { sha256, tombstone: true, ts: new Date().toISOString() };
    try {
      fs.appendFileSync(indexPath(), JSON.stringify(tombstone) + '\n', 'utf-8');
    } catch (e) {
      console.warn('[book-router-cache] tombstone append failed:', e && e.message);
    }
    return { ok: true };
  } catch (err) {
    console.warn('[book-router-cache] purge failed:', err && err.message);
    return { ok: false, error: 'PURGE_FAILED' };
  }
}

module.exports = {
  lookupBySha256,
  storeExtraction,
  listCachedSources,
  purgeCacheEntry,
};
