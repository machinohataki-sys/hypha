'use strict';

// HYPHA · W8.2 Learning Commons Flywheel · Step 3 — Pack → Commons
//
// Stages a pack draft for Commons publication. THIRD hop:
//
//   Pack draft (W8.2/2) → [publishPackToCommons]
//                          - W6.5 security-layer.scanPack (auto)
//                          - W6.5 license-layer.parseLicense (auto)
//                          → write ~/.hypha/commons/staging/<topic>/<lang>/pack.yaml
//                          → emit PR-ready commit message
//   (real PR step retained for user — we never push)
//
// Boundary contract:
//   - We write ONLY to the local staging dir (default
//     `<homedir>/.hypha/commons/staging/`). Override via
//     HYPHA_COMMONS_STAGING_DIR env. No git operations, no network.
//   - Security scan + license check are SOFT GATES — a failed scan is
//     surfaced as `blocked` with details, but the YAML still drafts so the
//     user can inspect and (if appropriate) override. We do NOT
//     auto-publish on a security failure.
//   - listStagedPacks / unstagePack are pure fs operations against the
//     staging dir.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Best-effort lib loading
let _security = null;
try { _security = require('../commons/security-layer'); } catch (_) { _security = null; }

let _license = null;
try { _license = require('../commons/license-layer'); } catch (_) { _license = null; }

let _spark2pack = null;
try { _spark2pack = require('./spark-to-pack'); } catch (_) { _spark2pack = null; }

// ---------------------------------------------------------------------------
// Staging dir layout
// ---------------------------------------------------------------------------

function _stagingRoot() {
  if (process.env.HYPHA_COMMONS_STAGING_DIR) return process.env.HYPHA_COMMONS_STAGING_DIR;
  return path.join(os.homedir(), '.hypha', 'commons', 'staging');
}

function _ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function _stagingPathFor(topicSlug, lang) {
  const safeTopic = String(topicSlug || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-');
  const safeLang = String(lang || 'zh').replace(/[^a-zA-Z0-9_-]/g, '-');
  return path.join(_stagingRoot(), safeTopic, safeLang);
}

// ---------------------------------------------------------------------------
// YAML renderer (mirror spark-to-pack.js, kept local to drop the dep)
// ---------------------------------------------------------------------------

function _yamlEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[:#\n\[\]{}&*?|>!%@`,'"]/.test(s) || /^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function _renderYaml(obj, indent = 0) {
  if (_spark2pack && _spark2pack._internals && typeof _spark2pack._internals.renderYaml === 'function') {
    return _spark2pack._internals.renderYaml(obj, indent);
  }
  const pad = '  '.repeat(indent);
  const lines = [];
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v == null) { lines.push(`${pad}${key}: ~`); continue; }
    if (Array.isArray(v)) {
      if (v.length === 0) { lines.push(`${pad}${key}: []`); continue; }
      lines.push(`${pad}${key}:`);
      for (const item of v) {
        if (item && typeof item === 'object') {
          lines.push(`${pad}  -`);
          lines.push(_renderYaml(item, indent + 2));
        } else {
          lines.push(`${pad}  - ${_yamlEscape(item)}`);
        }
      }
      continue;
    }
    if (typeof v === 'object') {
      lines.push(`${pad}${key}:`);
      lines.push(_renderYaml(v, indent + 1));
      continue;
    }
    lines.push(`${pad}${key}: ${_yamlEscape(v)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Publish a pack draft to the local Commons staging directory.
 * Performs W6.5 security scan + license check before write. A failed scan
 * is surfaced as `blocked` — caller decides whether to retry/override.
 *
 * @param {object} pack    — pack skeleton (from spark-to-pack.js)
 * @param {object} options — { lang?: 'zh'|'en', commitMessage?: string }
 * @returns {Promise<{ ok: boolean, packId, stagingPath, commitMessage, scan, license, blocked? }>}
 */
async function publishPackToCommons(pack, options = {}) {
  if (!pack || typeof pack !== 'object') {
    return { ok: false, error: 'pack required' };
  }
  const lang = options.lang || 'zh';
  const topicSlug = pack.topic_slug || pack.topic || 'unknown';
  const packId = pack.pack_id || `${topicSlug}-${Date.now()}`;

  // Staging dir
  const targetDir = _stagingPathFor(topicSlug, lang);
  _ensureDir(targetDir);
  const targetPath = path.join(targetDir, 'pack.yaml');
  const yamlBody = _renderYaml({ ...pack, pack_id: packId });

  // Write the YAML eagerly so the user can inspect even if a gate flags it.
  fs.writeFileSync(targetPath, yamlBody, 'utf8');

  // W6.5 security scan — scan the just-written file's parent dir
  let scan = null;
  let scanLevel = null;
  let blocked = false;
  if (_security && typeof _security.scanPack === 'function') {
    try {
      scan = _security.scanPack(targetDir);
      if (typeof _security.assessSafetyLevel === 'function') {
        scanLevel = _security.assessSafetyLevel(scan);
      }
      if (scan && (scan.banned_files || []).length > 0) blocked = true;
      if (scanLevel === 'block' || scanLevel === 'unsafe') blocked = true;
    } catch (err) {
      scan = { error: err.message };
    }
  }

  // License — soft check
  let license = null;
  if (_license && typeof _license.parseLicense === 'function') {
    try { license = _license.parseLicense(pack); }
    catch (err) { license = { error: err.message }; }
  }

  // Commit message — PR-ready
  const author = pack.author || 'hypha-user';
  const title = pack.title || topicSlug;
  const commitMessage = options.commitMessage ||
    `commons(${topicSlug}/${lang}): add "${title}" by ${author}\n\nPack kind: ${pack.pack_kind || 'unspecified'}\nLicense: ${pack.license || 'unspecified'}\nGenerated by HYPHA Learning Commons Flywheel (W8.2).`;

  // Write commit message sibling file for user convenience
  fs.writeFileSync(path.join(targetDir, 'COMMIT_MESSAGE.txt'), commitMessage, 'utf8');

  // Write manifest for listStagedPacks
  const manifest = {
    pack_id: packId,
    topic_slug: topicSlug,
    lang,
    pack_kind: pack.pack_kind || null,
    title,
    author,
    license: pack.license || null,
    staged_at: new Date().toISOString(),
    blocked,
    scan_level: scanLevel,
  };
  fs.writeFileSync(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return {
    ok: !blocked,
    packId,
    stagingPath: targetPath,
    commitMessage,
    scan,
    scanLevel,
    license,
    blocked,
    manifest,
  };
}

/**
 * List all staged packs.
 * @returns {Array<{packId, topicSlug, lang, title, author, staged_at, blocked}>}
 */
function listStagedPacks() {
  const root = _stagingRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const topic of fs.readdirSync(root)) {
    const tdir = path.join(root, topic);
    if (!fs.statSync(tdir).isDirectory()) continue;
    for (const lang of fs.readdirSync(tdir)) {
      const ldir = path.join(tdir, lang);
      if (!fs.statSync(ldir).isDirectory()) continue;
      const manifestPath = path.join(ldir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        out.push({ ...m, path: ldir });
      } catch (_) { /* skip malformed */ }
    }
  }
  return out;
}

/**
 * Remove a staged pack (by packId). Returns { ok, removed }.
 */
function unstagePack(packId) {
  if (!packId) return { ok: false, error: 'packId required' };
  const root = _stagingRoot();
  if (!fs.existsSync(root)) return { ok: false, error: 'staging_root_missing' };
  for (const topic of fs.readdirSync(root)) {
    const tdir = path.join(root, topic);
    if (!fs.statSync(tdir).isDirectory()) continue;
    for (const lang of fs.readdirSync(tdir)) {
      const ldir = path.join(tdir, lang);
      if (!fs.statSync(ldir).isDirectory()) continue;
      const manifestPath = path.join(ldir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (m.pack_id === packId) {
          fs.rmSync(ldir, { recursive: true, force: true });
          return { ok: true, removed: ldir };
        }
      } catch (_) { /* skip */ }
    }
  }
  return { ok: false, error: 'pack_not_found' };
}

module.exports = {
  publishPackToCommons,
  listStagedPacks,
  unstagePack,
  _internals: {
    stagingRoot: _stagingRoot,
    stagingPathFor: _stagingPathFor,
    renderYaml: _renderYaml,
  },
};
