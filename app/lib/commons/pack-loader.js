'use strict';
// Commons Pack loader — fs-backed listing + load by id.
// See specs/commons.md §9 (MVP scope) for surface boundary.

const fs = require('node:fs');
const path = require('node:path');
const { validatePack } = require('./pack-schema');

const PACK_DIR_NAME = '.commons-packs';

function ensureCommonsDir(vaultRoot) {
  const dir = path.join(vaultRoot, PACK_DIR_NAME);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* mkdir noop */ }
  return dir;
}

function listPacks(vaultRoot) {
  const dir = ensureCommonsDir(vaultRoot);
  if (!fs.existsSync(dir)) return [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.endsWith('.json')) continue;
    const p = path.join(dir, e);
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const pack = JSON.parse(raw);
      out.push({
        id: pack.id || e.replace(/\.json$/, ''),
        name: pack.name || '(unnamed)',
        archetype: pack.archetype || 'UNKNOWN',
        version: pack.version || '0.0',
        lesson_count: Array.isArray(pack.lessons) ? pack.lessons.length : 0,
      });
    } catch (_) { /* malformed pack — skip silently in listing */ }
  }
  return out;
}

function loadPack(vaultRoot, packId) {
  // pack-id traversal guard — refuse separators, dots, leading-dot ids
  if (!packId || typeof packId !== 'string' || /[\/\\.]/.test(packId) || packId.startsWith('.')) {
    return { ok: false, error: 'BAD_PACK_ID' };
  }
  const dir = ensureCommonsDir(vaultRoot);
  const p = path.join(dir, `${packId}.json`);
  if (!fs.existsSync(p)) return { ok: false, error: 'PACK_NOT_FOUND' };
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const pack = JSON.parse(raw);
    const validation = validatePack(pack);
    if (!validation.ok) return { ok: false, error: 'INVALID_PACK', validation };
    return { ok: true, pack };
  } catch (e) {
    return { ok: false, error: 'PARSE_FAIL', message: e && e.message ? e.message : String(e) };
  }
}

module.exports = { listPacks, loadPack, ensureCommonsDir, PACK_DIR_NAME };
