'use strict';

// HYPHA · Commons · Pack Import (β13 — reverse of α13 pack-export.js).
//
// Reads a .hypha-pack file produced by pack-export.js, validates the
// manifest + every per-file SHA256, lands the contents into a fresh
// vault/<new_slug>/ directory, rewrites any embedded source_slug
// references in .jsonl files (decisions / assumptions / sparks / events),
// and writes `_pack_provenance.json` as an audit record. Emits a
// `pack_imported` event to vault/events.jsonl on success.
//
// Honesty signal: per-file hash mismatches are recorded as a `tampered`
// count in provenance. We do not silently rehash and pretend integrity —
// if the pack was modified post-export, the audit trail surfaces it. In
// `opts.strict` mode any tamper aborts the import.
//
// Wire format (must mirror pack-export.js byte-for-byte):
//   [16 bytes]            "HYPHA-PACK\nv1\n\n"          PACK_MAGIC
//   [N bytes ]            <manifest.json — raw UTF-8>   (terminated by
//                          the leading "\n" of FILE_SEPARATOR)
//   [28 bytes]            "\n---HYPHA-FILE-SEPARATOR---\n"  (between every
//                          adjacent block — manifest|file, file|file)
//   [per-file block]      "filename: <rel>\nsize: <N>\n\n" + <N raw bytes>
//                          (no trailing newline after the body — the next
//                           separator/footer supplies its own leading "\n")
//   [22 bytes]            "\n---HYPHA-FILE-END---\n"        terminator
//
// File bodies are binary-safe (Buffer). We never decode unless the file
// is being rewritten (.jsonl slug-rewrite path) or needs hashing (always).
//
// API:
//   importPack(packPath, opts) → Promise<{ok, new_slug, manifest, summary, error?}>
//   inspectPack(packPath)      → {ok, manifest, error?}            (pure preview)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vault = require('../vault');
const _exp = require('./pack-export');

const PACK_MAGIC          = _exp.PACK_MAGIC;          // "HYPHA-PACK\nv1\n\n"
const FILE_SEPARATOR      = _exp.FILE_SEPARATOR;      // "\n---HYPHA-FILE-SEPARATOR---\n"
const FILE_END            = _exp.FILE_END;            // "\n---HYPHA-FILE-END---\n"
const SUPPORTED_SCHEMA    = _exp.PACK_SCHEMA_VERSION; // "1.0"

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const REWRITE_TARGET_EXT  = new Set(['.jsonl']);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function _sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function _isLegalSlug(s) {
  return typeof s === 'string' && SLUG_RE.test(s);
}

function _slugInVault(slug) {
  try {
    const root = vault.resolveRoot();
    return fs.existsSync(path.join(root, slug));
  } catch (_) { return false; }
}

function _bufIndexOf(haystack, needle, fromIndex = 0) {
  return haystack.indexOf(needle, fromIndex);
}

// ---------------------------------------------------------------------------
// raw read + framing parse — Buffer-based, binary safe
// ---------------------------------------------------------------------------

function _readPackBytes(packPath) {
  const abs = path.resolve(packPath);
  if (!fs.existsSync(abs)) return { ok: false, error: 'pack_not_found' };
  try {
    return { ok: true, buf: fs.readFileSync(abs) };
  } catch (err) {
    return { ok: false, error: `pack_read_failed: ${err.message}` };
  }
}

function _parseManifestSection(buf) {
  // Verify magic
  const magicBuf = Buffer.from(PACK_MAGIC, 'utf8');
  if (buf.length < magicBuf.length || buf.slice(0, magicBuf.length).compare(magicBuf) !== 0) {
    return { ok: false, error: 'invalid_pack_magic' };
  }
  // Manifest runs from after magic until the first FILE_SEPARATOR (whose
  // leading "\n" is the manifest's own trailing newline — but separator is
  // exact byte match including that "\n", so manifest is buf[magicEnd .. sepStart]).
  const sepBuf = Buffer.from(FILE_SEPARATOR, 'utf8');
  const sepStart = _bufIndexOf(buf, sepBuf, magicBuf.length);
  if (sepStart < 0) return { ok: false, error: 'missing_first_separator' };
  const manifestBytes = buf.slice(magicBuf.length, sepStart);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (err) {
    return { ok: false, error: `manifest_parse_failed: ${err.message}` };
  }
  return { ok: true, manifest, bodyStart: sepStart };
}

function _parseFileBlocks(buf, bodyStart) {
  // Iterates: SEPARATOR + ("filename: X\nsize: N\n\n" + N bytes) repeated,
  // until FILE_END terminator. Empty-pack (no files) is invalid per export.
  const sepBuf = Buffer.from(FILE_SEPARATOR, 'utf8');
  const endBuf = Buffer.from(FILE_END, 'utf8');
  const files = [];
  let cursor = bodyStart;

  while (true) {
    // Next chunk must be either a separator or the file-end terminator
    if (buf.length - cursor >= endBuf.length &&
        buf.slice(cursor, cursor + endBuf.length).compare(endBuf) === 0) {
      cursor += endBuf.length;
      break;
    }
    if (buf.length - cursor < sepBuf.length ||
        buf.slice(cursor, cursor + sepBuf.length).compare(sepBuf) !== 0) {
      return { ok: false, error: 'expected_separator_or_end' };
    }
    cursor += sepBuf.length;

    // Header line block: ends with "\n\n"
    const headerTerm = Buffer.from('\n\n', 'utf8');
    const headerEnd = _bufIndexOf(buf, headerTerm, cursor);
    if (headerEnd < 0) return { ok: false, error: 'truncated_entry_header' };
    const headerStr = buf.slice(cursor, headerEnd).toString('utf8');
    const fileMatch  = headerStr.match(/^filename:\s*([^\n]+)\nsize:\s*(\d+)$/);
    if (!fileMatch) return { ok: false, error: 'malformed_entry_header' };
    const relPath = fileMatch[1].trim();
    const declaredLen = parseInt(fileMatch[2], 10);
    if (!Number.isFinite(declaredLen) || declaredLen < 0) {
      return { ok: false, error: 'invalid_entry_size' };
    }
    cursor = headerEnd + headerTerm.length;
    if (cursor + declaredLen > buf.length) {
      return { ok: false, error: 'truncated_entry_body' };
    }
    const body = buf.slice(cursor, cursor + declaredLen);
    cursor += declaredLen;
    files.push({ relPath, declaredLen, body });
  }

  // Anything after FILE_END is trailing garbage — tolerate but warn (return
  // count). For now we accept silently; corrupt trailing bytes don't change
  // hash verification of the per-file bodies.
  return { ok: true, files };
}

// ---------------------------------------------------------------------------
// manifest validation
// ---------------------------------------------------------------------------

function _validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, error: 'invalid_manifest' };
  }
  if (manifest.schema_version !== SUPPORTED_SCHEMA) {
    return { ok: false, error: `unsupported_schema_version: ${manifest.schema_version}` };
  }
  if (!_isLegalSlug(manifest.source_slug)) {
    return { ok: false, error: 'invalid_source_slug' };
  }
  if (!manifest.contents || !Array.isArray(manifest.contents.files) || manifest.contents.files.length < 1) {
    return { ok: false, error: 'invalid_manifest_contents' };
  }
  for (const f of manifest.contents.files) {
    if (!f || typeof f.path !== 'string' || typeof f.sha256 !== 'string') {
      return { ok: false, error: 'invalid_file_entry' };
    }
  }
  if (typeof manifest.pack_hash !== 'string' || manifest.pack_hash.length < 16) {
    return { ok: false, error: 'invalid_pack_hash' };
  }
  // pack_hash = sha256(JSON.stringify(contents_block)) per pack-export.js.
  // The contents block is exactly { files: [...], excluded: [...] }.
  const canonical = JSON.stringify(manifest.contents);
  const recomputed = _sha256Buf(Buffer.from(canonical, 'utf8'));
  if (recomputed !== manifest.pack_hash) {
    return { ok: false, error: 'pack_hash_mismatch' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// slug rewrite + new-slug derivation
// ---------------------------------------------------------------------------

function _rewriteSlugInJSONL(bodyStr, fromSlug, toSlug) {
  if (fromSlug === toSlug) return { body: bodyStr, rewrittenCount: 0 };
  const lines = bodyStr.split('\n');
  let rewrittenCount = 0;
  const out = [];
  for (const line of lines) {
    if (!line) { out.push(line); continue; }
    let row;
    try { row = JSON.parse(line); } catch (_) { out.push(line); continue; }
    if (row && typeof row === 'object' && row.slug === fromSlug) {
      row.slug = toSlug;
      out.push(JSON.stringify(row));
      rewrittenCount++;
    } else {
      out.push(line);
    }
  }
  return { body: out.join('\n'), rewrittenCount };
}

function _decideNewSlug(manifest, opts) {
  if (opts && typeof opts.targetSlug === 'string') {
    if (!_isLegalSlug(opts.targetSlug)) return { ok: false, error: 'invalid_target_slug' };
    if (_slugInVault(opts.targetSlug)) return { ok: false, error: 'target_slug_conflict' };
    return { ok: true, newSlug: opts.targetSlug };
  }
  const suffix = Date.now().toString(36).slice(-4);
  let base = `${manifest.source_slug}-imported-${suffix}`;
  if (!_isLegalSlug(base)) {
    base = base.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80);
    if (!_isLegalSlug(base)) return { ok: false, error: 'cannot_derive_new_slug' };
  }
  if (_slugInVault(base)) return { ok: false, error: 'derived_slug_conflict' };
  return { ok: true, newSlug: base };
}

function _emitEvent(payload) {
  try {
    vault.appendJSONL('events.jsonl', {
      ts: new Date().toISOString(),
      op: 'pack_imported',
      ...payload,
    });
  } catch (_) { /* event log non-fatal */ }
}

function _rollback(newSlug) {
  try {
    const root = vault.resolveRoot();
    const dir = path.join(root, newSlug);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// public — inspectPack (preview only, no extraction)
// ---------------------------------------------------------------------------

function inspectPack(packPath) {
  if (!packPath || typeof packPath !== 'string') {
    return { ok: false, error: 'packPath required' };
  }
  const r = _readPackBytes(packPath);
  if (!r.ok) return r;
  const ms = _parseManifestSection(r.buf);
  if (!ms.ok) return ms;
  const v = _validateManifest(ms.manifest);
  if (!v.ok) return { ok: false, error: v.error, manifest: ms.manifest };
  return { ok: true, manifest: ms.manifest };
}

// ---------------------------------------------------------------------------
// public — importPack
// ---------------------------------------------------------------------------

/**
 * @param {string} packPath absolute or vault-relative path to a .hypha-pack
 * @param {object} [opts]
 * @param {string}  [opts.targetSlug]  override derived slug; must be legal + unused
 * @param {boolean} [opts.strict]      tampered file aborts import (default false)
 * @returns {Promise<{ok:boolean, new_slug?:string, manifest?:object, summary?:object, error?:string}>}
 */
async function importPack(packPath, opts = {}) {
  // 1. read raw bytes
  const r = _readPackBytes(packPath);
  if (!r.ok) return { ok: false, error: r.error };

  // 2. parse manifest section
  const ms = _parseManifestSection(r.buf);
  if (!ms.ok) return { ok: false, error: ms.error };
  const manifest = ms.manifest;

  // 3. validate manifest schema + pack_hash
  const v = _validateManifest(manifest);
  if (!v.ok) return { ok: false, error: v.error || 'invalid_manifest' };

  // 4. parse file blocks
  const fb = _parseFileBlocks(r.buf, ms.bodyStart);
  if (!fb.ok) return { ok: false, error: fb.error || 'pack_body_invalid' };

  // 5. cross-check declared file list ≡ body chunks
  const manifestByPath = new Map(manifest.contents.files.map(f => [f.path, f.sha256]));
  const bodyPathSet = new Set(fb.files.map(f => f.relPath));
  if (manifestByPath.size !== bodyPathSet.size) {
    return { ok: false, error: 'file_count_mismatch' };
  }
  for (const p of manifestByPath.keys()) {
    if (!bodyPathSet.has(p)) return { ok: false, error: `missing_body_for: ${p}` };
  }

  // 6. per-file sha256 verify (buffer-level)
  const tamperedFiles = [];
  for (const f of fb.files) {
    const expected = manifestByPath.get(f.relPath);
    const actual = _sha256Buf(f.body);
    f._actualSha = actual;
    f._tampered = actual !== expected;
    if (f._tampered) tamperedFiles.push(f.relPath);
  }
  if (opts.strict && tamperedFiles.length > 0) {
    return { ok: false, error: `strict_mode_tampered: ${tamperedFiles.length}` };
  }

  // 7. decide new_slug
  const slugDecision = _decideNewSlug(manifest, opts);
  if (!slugDecision.ok) return { ok: false, error: slugDecision.error };
  const newSlug = slugDecision.newSlug;

  // 8. create target dir
  const root = vault.resolveRoot();
  const targetDir = path.join(root, newSlug);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `mkdir_failed: ${err.message}` };
  }

  // 9. extract each file (rewrite slug in .jsonl)
  let writtenCount = 0;
  let rewrittenRows = 0;
  try {
    for (const f of fb.files) {
      const safeRel = path.normalize(f.relPath).replace(/^[\\/]+/, '');
      if (safeRel.includes('..')) {
        throw new Error(`path_traversal_blocked: ${f.relPath}`);
      }
      const writeAbs = path.resolve(targetDir, safeRel);
      const resolvedTarget = path.resolve(targetDir);
      if (!writeAbs.startsWith(resolvedTarget)) {
        throw new Error(`path_escapes_target: ${f.relPath}`);
      }
      const ext = path.extname(safeRel).toLowerCase();
      let outBytes = f.body;
      if (REWRITE_TARGET_EXT.has(ext)) {
        // Only decode JSONL — keep binary fidelity for all other files.
        const decoded = f.body.toString('utf8');
        const rewrite = _rewriteSlugInJSONL(decoded, manifest.source_slug, newSlug);
        rewrittenRows += rewrite.rewrittenCount;
        outBytes = Buffer.from(rewrite.body, 'utf8');
      }
      fs.mkdirSync(path.dirname(writeAbs), { recursive: true });
      fs.writeFileSync(writeAbs, outBytes);
      writtenCount++;
    }
  } catch (err) {
    _rollback(newSlug);
    return { ok: false, error: `extract_failed: ${err.message}` };
  }

  // 10. provenance audit record
  const hashVerification = tamperedFiles.length === 0
    ? 'all_passed'
    : `${tamperedFiles.length}_files_tampered`;
  const provenance = {
    imported_from_pack_id: manifest.pack_id || null,
    original_source_slug: manifest.source_slug,
    imported_at: new Date().toISOString(),
    imported_to_slug: newSlug,
    manifest_snapshot: manifest,
    hash_verification: hashVerification,
    tampered_files: tamperedFiles,
    slug_rewrite: {
      from: manifest.source_slug,
      to: newSlug,
      rewritten_rows: rewrittenRows,
    },
    file_count: writtenCount,
  };
  try {
    const provAbs = path.join(targetDir, '_pack_provenance.json');
    fs.writeFileSync(provAbs, JSON.stringify(provenance, null, 2), 'utf8');
  } catch (err) {
    _rollback(newSlug);
    return { ok: false, error: `provenance_write_failed: ${err.message}` };
  }

  // 11. emit event
  _emitEvent({
    new_slug: newSlug,
    source_pack_id: manifest.pack_id || null,
    file_count: writtenCount,
    tamper_count: tamperedFiles.length,
  });

  const summary = {
    new_slug: newSlug,
    file_count: writtenCount,
    rewritten_rows: rewrittenRows,
    tampered_files: tamperedFiles.length,
    hash_verification: hashVerification,
  };
  return { ok: true, new_slug: newSlug, manifest, summary };
}

module.exports = {
  importPack,
  inspectPack,
  PACK_MAGIC,
  FILE_SEPARATOR,
  FILE_END,
  SUPPORTED_SCHEMA,
};
