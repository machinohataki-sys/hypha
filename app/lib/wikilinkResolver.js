'use strict';

// wikilinkResolver.js — resolve [[target]] strings to vault entities.
//
// Per /tr council 2026-05-02 wiki+gbrain three-piece (B — concept-as-page).
// Atlas concepts are first-class link targets: [[inverted pear]] in any note
// resolves to the concept page (ConceptLogbookPanel) when "inverted pear" is
// tracked across atlas/<slug>__<idx>.json files. Daily notes (YYYY-MM-DD)
// also resolve. Preserves existing note-basename match for back-compat.
//
// Pure node module: sync fs only, no new dependencies, no LLM calls.
// Caches the atlas concept map for 30s to avoid full-walk per click.

const fs = require('fs');
const path = require('path');

const ATLAS_CACHE_TTL_MS = 30_000;
let _atlasCache = null;            // Map<termLower, { slug, idx, term, lastUpdated }>
let _atlasCacheBuiltAt = 0;

function _walkVault(root, onMd) {
  let dirents;
  try { dirents = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return; }
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    const sub = path.join(root, d.name);
    if (d.isDirectory()) _walkVault(sub, onMd);
    else if (d.isFile() && d.name.toLowerCase().endsWith('.md')) onMd(sub, d.name);
  }
}

function _buildAtlasCache(vaultRoot) {
  const map = new Map();
  const atlasDir = path.join(vaultRoot, 'data', 'atlas');
  let entries;
  try { entries = fs.readdirSync(atlasDir); } catch (_) { _atlasCache = map; _atlasCacheBuiltAt = Date.now(); return map; }
  for (const fname of entries) {
    if (!fname.endsWith('.json')) continue;
    const m = fname.match(/^(.+)__(\d+)\.json$/);
    if (!m) continue;
    const slug = m[1];
    const idx = parseInt(m[2], 10);
    let atlas;
    try { atlas = JSON.parse(fs.readFileSync(path.join(atlasDir, fname), 'utf8')); } catch (_) { continue; }
    const concepts = (atlas && atlas.concepts) || {};
    const lastUpdated = atlas && atlas.last_updated ? String(atlas.last_updated) : '';
    for (const term of Object.keys(concepts)) {
      const c = concepts[term];
      const keys = [term];
      if (Array.isArray(c.alt_forms)) {
        for (const alt of c.alt_forms) {
          if (typeof alt === 'string' && alt.trim()) keys.push(alt.trim());
        }
      }
      for (const k of keys) {
        const lower = k.toLowerCase();
        const prev = map.get(lower);
        // Most-recently-touched lesson wins on collision.
        if (!prev || (lastUpdated && lastUpdated > prev.lastUpdated)) {
          map.set(lower, { slug, idx, term, lastUpdated });
        }
      }
    }
  }
  _atlasCache = map;
  _atlasCacheBuiltAt = Date.now();
  return map;
}

function _getAtlasCache(vaultRoot) {
  const now = Date.now();
  if (_atlasCache && (now - _atlasCacheBuiltAt) < ATLAS_CACHE_TTL_MS) return _atlasCache;
  return _buildAtlasCache(vaultRoot);
}

// Public API ---------------------------------------------------------------

function resolve(target, opts) {
  const o = opts || {};
  const vaultRoot = o.vaultRoot;
  if (!target || typeof target !== 'string') return { kind: 'unknown', exists: false, label: '' };
  if (!vaultRoot) return { kind: 'unknown', exists: false, label: target };
  const targetTrimmed = target.trim();
  const lower = targetTrimmed.toLowerCase();

  // 1. Note basename match (case-insensitive, walks vault for <basename>.md)
  let foundRel = null;
  try {
    _walkVault(vaultRoot, (abs, name) => {
      if (foundRel) return;
      const base = name.replace(/\.md$/i, '').toLowerCase();
      if (base === lower) {
        const rel = path.relative(vaultRoot, abs).replace(/\\/g, '/');
        foundRel = rel;
      }
    });
  } catch (_) {}
  if (foundRel) return { kind: 'note', rel: foundRel, label: targetTrimmed, exists: true };

  // 2. Daily note YYYY-MM-DD match
  if (/^\d{4}-\d{2}-\d{2}$/.test(targetTrimmed)) {
    const dailyRel = `daily/${targetTrimmed}.md`;
    const exists = (() => { try { return fs.existsSync(path.join(vaultRoot, dailyRel)); } catch (_) { return false; } })();
    return { kind: 'daily', rel: dailyRel, label: targetTrimmed, exists };
  }

  // 3. Atlas concept match
  const cache = _getAtlasCache(vaultRoot);
  const hit = cache.get(lower);
  if (hit) {
    return {
      kind: 'concept',
      conceptKey: { slug: hit.slug, idx: hit.idx, term: hit.term },
      label: targetTrimmed,
      exists: true,
    };
  }

  return { kind: 'unknown', label: targetTrimmed, exists: false };
}

function clearCache() { _atlasCache = null; _atlasCacheBuiltAt = 0; }

module.exports = { resolve, clearCache };
