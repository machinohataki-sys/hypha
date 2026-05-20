'use strict';

// vault-meta.js — v1.0 boot-7
//
// Vault-root schema-version tracking. Lives at vault/data/.vault-meta.json:
//   {
//     schema_version: 1,
//     last_app_version: "0.11.2",
//     created_at: "2026-05-20T...",
//     last_opened_at: "2026-05-20T..."
//   }
//
// On Electron startup the app calls openVault(currentAppVersion):
//   - If meta missing → bootstrap with current schema_version + write atomically.
//   - If meta.schema_version < CURRENT_SCHEMA_VERSION → migration required
//     flag returned; actual migration logic lands v1.1+ (out of scope here,
//     placeholder onMigrationRequired hook).
//   - Always update last_opened_at + last_app_version on every open.
//
// Atomic via tmp+rename. Never touches user-curriculum data.

const fs = require('node:fs');
const path = require('node:path');
const vault = require('./vault');

const CURRENT_SCHEMA_VERSION = 1;
const META_REL = '.vault-meta.json';

function _metaAbs() {
  const root = vault.resolveRoot();
  return path.join(root, META_REL);
}

function _writeAtomic(abs, body) {
  const tmpAbs = `${abs}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpAbs, body, 'utf-8');
    fs.renameSync(tmpAbs, abs);
  } catch (err) {
    try { fs.unlinkSync(tmpAbs); } catch (_) {}
    throw err;
  }
}

function readMeta() {
  const abs = _metaAbs();
  if (!fs.existsSync(abs)) return null;
  try {
    const raw = fs.readFileSync(abs, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// openVault(appVersion, opts) → { ok, meta, migration_needed, bootstrapped }
//
// Idempotent. Safe to call on every Electron `ready` event.
// opts.onMigrationRequired(meta) — optional hook fired ONLY when stale schema
// detected; current impl returns flag and lets caller decide.
//
// intentional-placeholder: actual migration runner is v1.1+ scope per the
// vault-safety task spec (boot-7). v1.0 ships meta tracking + detection only;
// no schemas have changed yet (CURRENT_SCHEMA_VERSION = 1 since first write),
// so a migration runner has nothing to do. When v1.1 introduces the first
// breaking schema change, add a `migrations/` directory + a runMigrations(meta,
// snapshotVault) function gated by snapshotVault({tag:'pre-migration'}) before
// touching user data. The hook signature stays stable.
function openVault(appVersion, opts) {
  const onMig = opts && typeof opts.onMigrationRequired === 'function'
    ? opts.onMigrationRequired
    : null;
  const abs = _metaAbs();
  const now = new Date().toISOString();
  const appVer = String(appVersion || '0.0.0');

  let meta = readMeta();
  let bootstrapped = false;
  if (!meta) {
    meta = {
      schema_version: CURRENT_SCHEMA_VERSION,
      last_app_version: appVer,
      created_at: now,
      last_opened_at: now,
    };
    try {
      // Make sure the vault root exists (vault.resolveRoot may return a path
      // that doesn't exist yet on a true first launch).
      const root = vault.resolveRoot();
      if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
      _writeAtomic(abs, JSON.stringify(meta, null, 2));
      bootstrapped = true;
    } catch (err) {
      return { ok: false, error: `meta bootstrap failed: ${err.message}` };
    }
    return { ok: true, meta, migration_needed: false, bootstrapped };
  }

  // Schema bump detection.
  const observed = Number.isFinite(meta.schema_version) ? meta.schema_version : 0;
  const migrationNeeded = observed < CURRENT_SCHEMA_VERSION;
  if (migrationNeeded && onMig) {
    // Fire the hook but don't actually migrate — that's a v1.1+ slice.
    try { onMig(meta); } catch (_) {}
  }

  // Bump last_opened_at + last_app_version regardless of schema state.
  const next = {
    ...meta,
    last_app_version: appVer,
    last_opened_at: now,
  };
  try {
    _writeAtomic(abs, JSON.stringify(next, null, 2));
  } catch (err) {
    return { ok: false, error: `meta update failed: ${err.message}`, meta };
  }

  return { ok: true, meta: next, migration_needed: migrationNeeded, bootstrapped: false };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  readMeta,
  openVault,
};
