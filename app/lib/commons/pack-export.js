'use strict';

// HYPHA · Commons · Pack Export (Wave 6.6 — Commons System §6 first cut).
//
// One slug's complete learning artifacts → portable .hypha-pack file.
// Share, import, continue learning. This is Hypha's only differentiation point.
//
// Format note (v1.0):
//   `adm-zip` / `jszip` are not in the dependency tree (Wave 6.6 ship-fast).
//   Real ZIP central-directory encoding hand-rolled in ~250 LOC = risk of
//   corrupt archives. We adopt a documented custom container instead:
//
//     [16 bytes ]  "HYPHA-PACK\nv1\n\n"           (magic + version banner)
//     [N bytes  ]  <manifest.json UTF-8>
//     [27 bytes ]  "\n---HYPHA-FILE-SEPARATOR---\n"
//     [block    ]  "filename: <rel>\nsize: <N>\n\n" + <file bytes>
//     [27 bytes ]  "\n---HYPHA-FILE-SEPARATOR---\n"   (between subsequent files)
//     [27 bytes ]  "\n---HYPHA-FILE-END---\n"         (terminator)
//
//   pack-import.js (future) reads magic, parses manifest, iterates separators.
//   intentional-placeholder: adm-zip / jszip not yet in dependency tree;
//   custom container ships now, can be replaced by true ZIP later without
//   bumping schema_version (the manifest schema is encapsulated; only the
//   wire-format byte layout changes).
//
// Privacy defaults (per task brief):
//   - events.jsonl       — excluded (user reading/agent trace footprint)
//   - sessions/*.jsonl   — excluded (full conversations)
//   - sources.json       — included by default; opts.excludeSources = true to drop
//   - everything else under vault/<slug>/ — included
//
// vault/ is read-only here. We only write to vault/.commons/packs/.
//
// API:
//   exportPack(slug, opts = {}) → Promise<{ok, pack_path, manifest, summary, error?}>
//   listExportedPacks()         → {ok, packs} | {ok:false, error}

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vault = require('../vault');

const PACK_SCHEMA_VERSION = '1.0';
const PACK_MAGIC = 'HYPHA-PACK\nv1\n\n';
const FILE_SEPARATOR = '\n---HYPHA-FILE-SEPARATOR---\n';
const FILE_END = '\n---HYPHA-FILE-END---\n';
const HYPHA_VERSION_TAG = 'hypha-v0.4.3'; // bumped per task brief

// Default-excluded paths (privacy). Match prefix relative to slug root.
const DEFAULT_EXCLUDE_PREFIXES = Object.freeze([
  'events.jsonl',
  'sessions/',
  'sessions\\',
]);

// Hard limits — defensive. A vault folder can balloon if user uploaded many
// PDFs; we still emit but warn in summary.
const MAX_PACK_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_FILES = 5000;

// ---------------------------------------------------------------------------
// slug safety — mirrors main.js:9066 curriculum:archive guard
// ---------------------------------------------------------------------------

function _isSafeSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  if (!slug.trim()) return false;
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) return false;
  if (slug.startsWith('.')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// File walking — recursive, depth-limited, ordered for stable hashes
// ---------------------------------------------------------------------------

function _walkSlugDir(root, maxDepth = 8) {
  const out = [];
  function walk(dir, relBase, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    // Sort for deterministic ordering — hash stability across exports.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(abs, rel, depth + 1);
      } else if (ent.isFile()) {
        out.push({ abs, rel });
      }
      // symlinks / other entries skipped — defense against vault tampering
    }
  }
  walk(root, '', 0);
  return out;
}

function _isExcluded(rel, opts) {
  const norm = rel.replace(/\\/g, '/');
  for (const prefix of DEFAULT_EXCLUDE_PREFIXES) {
    const p = prefix.replace(/\\/g, '/');
    if (norm === p || norm.startsWith(p)) return { excluded: true, reason: 'privacy_default' };
  }
  if (opts.excludeSources && (norm === 'sources.json' || norm === 'sources/')) {
    return { excluded: true, reason: 'opts.excludeSources' };
  }
  if (Array.isArray(opts.extraExclude)) {
    for (const ex of opts.extraExclude) {
      if (typeof ex === 'string' && (norm === ex || norm.startsWith(ex))) {
        return { excluded: true, reason: 'opts.extraExclude' };
      }
    }
  }
  return { excluded: false };
}

function _sha256File(absPath) {
  const buf = fs.readFileSync(absPath);
  return {
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
    buf,
  };
}

function _readStateMeta(slugRoot) {
  const statePath = path.join(slugRoot, 'state.json');
  if (!fs.existsSync(statePath)) return { archetype: null, goal: null };
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return {
      archetype: state.archetype || null,
      goal: (state.goal && (state.goal.text || state.goal.statement)) || state.learn_goal || state.goal || null,
    };
  } catch (_) {
    return { archetype: null, goal: null };
  }
}

// ---------------------------------------------------------------------------
// Custom container serializer (see top-of-file note)
// ---------------------------------------------------------------------------

function _writeContainer(packPath, manifestBuf, files) {
  const ws = fs.createWriteStream(packPath);
  return new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('finish', () => resolve());

    ws.write(PACK_MAGIC);
    ws.write(manifestBuf);
    for (const f of files) {
      ws.write(FILE_SEPARATOR);
      ws.write(`filename: ${f.rel}\nsize: ${f.size}\n\n`);
      ws.write(f.buf);
    }
    ws.write(FILE_END);
    ws.end();
  });
}

// ---------------------------------------------------------------------------
// Public — exportPack
// ---------------------------------------------------------------------------

async function exportPack(slug, opts = {}) {
  if (!_isSafeSlug(slug)) {
    return { ok: false, error: 'invalid slug shape' };
  }

  const root = vault.resolveRoot();
  const slugRoot = path.join(root, slug);
  if (!fs.existsSync(slugRoot) || !fs.statSync(slugRoot).isDirectory()) {
    return { ok: false, error: `slug not found: ${slug}` };
  }

  const walked = _walkSlugDir(slugRoot);
  if (walked.length === 0) {
    return { ok: false, error: 'slug directory is empty' };
  }
  if (walked.length > MAX_FILES) {
    return { ok: false, error: `too many files (${walked.length} > ${MAX_FILES})` };
  }

  const included = [];
  const excluded = [];
  let totalBytes = 0;

  for (const entry of walked) {
    const verdict = _isExcluded(entry.rel, opts);
    if (verdict.excluded) {
      excluded.push({ path: entry.rel, reason: verdict.reason });
      continue;
    }
    let hashed;
    try {
      hashed = _sha256File(entry.abs);
    } catch (err) {
      return { ok: false, error: `read failed for ${entry.rel}: ${err.message}` };
    }
    totalBytes += hashed.size;
    if (totalBytes > MAX_PACK_BYTES) {
      return { ok: false, error: `pack would exceed ${MAX_PACK_BYTES} bytes — exclude sources or large media` };
    }
    included.push({ rel: entry.rel, size: hashed.size, sha256: hashed.hash, buf: hashed.buf });
  }

  if (included.length === 0) {
    return { ok: false, error: 'no files would be included after exclusion filters' };
  }

  const stateMeta = _readStateMeta(slugRoot);
  const ts = Date.now();
  const packId = `hypha-pack-${slug}-${ts.toString(36)}`;

  // Manifest contents block — what consumers verify per file.
  const contentsFiles = included.map(f => ({ path: f.rel, size: f.size, sha256: f.sha256 }));
  const contentsBlock = {
    files: contentsFiles,
    excluded: excluded.map(e => e.path),
  };

  // pack_hash = sha256 over canonical JSON of contents block. This binds the
  // file list + per-file hashes into one signature; tampering with any single
  // file flips its sha256 → flips the contents block → flips pack_hash.
  const pack_hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(contentsBlock))
    .digest('hex');

  const manifest = {
    schema_version: PACK_SCHEMA_VERSION,
    pack_id: packId,
    source_slug: slug,
    exported_at: new Date(ts).toISOString(),
    exported_from: HYPHA_VERSION_TAG,
    contents: contentsBlock,
    pack_hash,
    total_size_bytes: totalBytes,
    description: typeof opts.description === 'string' ? opts.description : '',
    archetype: stateMeta.archetype,
    goal: stateMeta.goal,
    license: typeof opts.license === 'string' ? opts.license : 'CC BY-NC 4.0',
  };

  // Write to vault/.commons/packs/<pack_id>.hypha-pack + .manifest.json
  const packsDir = path.join(root, '.commons', 'packs');
  try {
    fs.mkdirSync(packsDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `mkdir failed: ${err.message}` };
  }
  const packPath = path.join(packsDir, `${packId}.hypha-pack`);
  const manifestPath = path.join(packsDir, `${packId}.manifest.json`);

  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');

  try {
    await _writeContainer(packPath, manifestBuf, included);
  } catch (err) {
    return { ok: false, error: `pack write failed: ${err.message}` };
  }

  try {
    fs.writeFileSync(manifestPath, manifestBuf);
  } catch (err) {
    return { ok: false, error: `manifest write failed: ${err.message}` };
  }

  // Event log — privacy-safe summary, no per-file paths
  try {
    const events = require('../events');
    events.write(slug, {
      type: 'pack_exported',
      pack_id: packId,
      file_count: included.length,
      total_size_bytes: totalBytes,
      excluded_count: excluded.length,
    });
  } catch (_) {
    // events.js may not be available in some test contexts — don't fail export
  }

  return {
    ok: true,
    pack_path: packPath,
    manifest,
    summary: {
      pack_id: packId,
      file_count: included.length,
      excluded_count: excluded.length,
      total_size_bytes: totalBytes,
      manifest_path: manifestPath,
    },
  };
}

// ---------------------------------------------------------------------------
// Public — listExportedPacks (UI sidebar; reads .manifest.json siblings only,
// never opens the actual pack file)
// ---------------------------------------------------------------------------

function listExportedPacks() {
  const root = vault.resolveRoot();
  const packsDir = path.join(root, '.commons', 'packs');
  if (!fs.existsSync(packsDir)) return { ok: true, packs: [] };

  let entries;
  try {
    entries = fs.readdirSync(packsDir);
  } catch (err) {
    return { ok: false, error: `readdir failed: ${err.message}` };
  }

  const packs = [];
  for (const name of entries) {
    if (!name.endsWith('.manifest.json')) continue;
    const abs = path.join(packsDir, name);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (_) {
      continue; // skip corrupt manifest
    }
    const packPath = path.join(packsDir, `${manifest.pack_id}.hypha-pack`);
    const exists = fs.existsSync(packPath);
    packs.push({
      pack_id: manifest.pack_id,
      source_slug: manifest.source_slug,
      exported_at: manifest.exported_at,
      exported_from: manifest.exported_from,
      description: manifest.description,
      archetype: manifest.archetype,
      goal: manifest.goal,
      license: manifest.license,
      total_size_bytes: manifest.total_size_bytes,
      file_count: Array.isArray(manifest.contents && manifest.contents.files)
        ? manifest.contents.files.length
        : 0,
      pack_path: packPath,
      pack_exists: exists,
    });
  }
  // newest first
  packs.sort((a, b) => (b.exported_at || '').localeCompare(a.exported_at || ''));
  return { ok: true, packs };
}

module.exports = {
  exportPack,
  listExportedPacks,
  // Exposed for tests / pack-import.js (future):
  PACK_SCHEMA_VERSION,
  PACK_MAGIC,
  FILE_SEPARATOR,
  FILE_END,
  DEFAULT_EXCLUDE_PREFIXES,
};
