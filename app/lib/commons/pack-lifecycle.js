'use strict';

// HYPHA · Commons · Pack Lifecycle (Scout S52 NuggetIndex + Schema-Grounded Memory).
//
// Lifecycle = {'draft', 'ratified', 'superseded', 'deprecated'}.
// Default 'draft'; user-driven transition. Ratified packs are frozen
// (no further edits); when a newer version of the same pack id is
// ratified, prior ratified entries transition to 'superseded'.
//
// Allowed transitions:
//   draft       → ratified | deprecated
//   ratified    → superseded | deprecated
//   superseded  → deprecated
//   deprecated  → (terminal)
//
// Files written:
//   <vault>/.commons-packs/<id>.json            — pack with updated lifecycle
//   <vault>/.commons-packs/.lifecycle-audit.jsonl — append-only audit log
//
// API:
//   transitionPack(vaultRoot, packId, nextState, opts) → {ok, pack?, error?}
//   isFrozen(pack) → boolean
//   listAuditEntries(vaultRoot, packId?) → {ok, entries}

const fs = require('node:fs');
const path = require('node:path');
const { LIFECYCLE_STATES } = require('./pack-schema');

const ALLOWED = Object.freeze({
  draft:      new Set(['ratified', 'deprecated']),
  ratified:   new Set(['superseded', 'deprecated']),
  superseded: new Set(['deprecated']),
  deprecated: new Set(),
});

const PACK_DIR_NAME = '.commons-packs';
const AUDIT_FILE = '.lifecycle-audit.jsonl';

function _safePackId(id) {
  if (!id || typeof id !== 'string') return false;
  if (/[\/\\.]/.test(id) || id.startsWith('.')) return false;
  return true;
}

function _packPath(vaultRoot, packId) {
  return path.join(vaultRoot, PACK_DIR_NAME, `${packId}.json`);
}

function _auditPath(vaultRoot) {
  return path.join(vaultRoot, PACK_DIR_NAME, AUDIT_FILE);
}

function _readPack(vaultRoot, packId) {
  const p = _packPath(vaultRoot, packId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (_) {
    return null;
  }
}

function _writeAudit(vaultRoot, entry) {
  try {
    const dir = path.join(vaultRoot, PACK_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(_auditPath(vaultRoot), JSON.stringify(entry) + '\n', 'utf-8');
    return true;
  } catch (_) {
    return false;
  }
}

function isFrozen(pack) {
  if (!pack || typeof pack !== 'object') return false;
  const state = typeof pack.lifecycle === 'string' ? pack.lifecycle : 'draft';
  return state === 'ratified' || state === 'superseded' || state === 'deprecated';
}

function canTransition(fromState, toState) {
  if (!LIFECYCLE_STATES.has(toState)) return false;
  const from = LIFECYCLE_STATES.has(fromState) ? fromState : 'draft';
  return ALLOWED[from].has(toState);
}

function transitionPack(vaultRoot, packId, nextState, opts = {}) {
  if (!vaultRoot || typeof vaultRoot !== 'string') {
    return { ok: false, error: 'BAD_VAULT_ROOT' };
  }
  if (!_safePackId(packId)) return { ok: false, error: 'BAD_PACK_ID' };
  if (!LIFECYCLE_STATES.has(nextState)) return { ok: false, error: 'BAD_STATE' };

  const pack = _readPack(vaultRoot, packId);
  if (!pack) return { ok: false, error: 'PACK_NOT_FOUND' };

  const current = typeof pack.lifecycle === 'string' ? pack.lifecycle : 'draft';
  if (current === nextState) {
    return { ok: false, error: 'NO_OP', detail: `already ${nextState}` };
  }
  if (!canTransition(current, nextState)) {
    return { ok: false, error: 'INVALID_TRANSITION', detail: `${current}→${nextState}` };
  }

  const now = new Date().toISOString();
  const nextPack = { ...pack, lifecycle: nextState, updated_at: now };
  if (nextState === 'ratified') nextPack.ratified_at = now;

  try {
    fs.writeFileSync(_packPath(vaultRoot, packId), JSON.stringify(nextPack, null, 2), 'utf-8');
  } catch (e) {
    return { ok: false, error: 'WRITE_FAIL', detail: e && e.message ? e.message : String(e) };
  }

  // When ratifying a newer version of an existing ratified id, demote prior
  // ratified packs sharing the same id-stem to 'superseded'. id-stem =
  // pack.id with any trailing -vN suffix stripped. Caller decides via
  // opts.supersedePriorIds (array of pack file ids to demote).
  const supersededIds = [];
  if (nextState === 'ratified' && Array.isArray(opts.supersedePriorIds)) {
    for (const priorId of opts.supersedePriorIds) {
      if (!_safePackId(priorId) || priorId === packId) continue;
      const prior = _readPack(vaultRoot, priorId);
      if (!prior) continue;
      const priorState = typeof prior.lifecycle === 'string' ? prior.lifecycle : 'draft';
      if (priorState !== 'ratified') continue;
      try {
        const updated = { ...prior, lifecycle: 'superseded', updated_at: now, superseded_by: packId };
        fs.writeFileSync(_packPath(vaultRoot, priorId), JSON.stringify(updated, null, 2), 'utf-8');
        supersededIds.push(priorId);
        _writeAudit(vaultRoot, {
          ts: now, pack_id: priorId, from: 'ratified', to: 'superseded',
          actor: opts.actor || 'system', reason: `superseded by ${packId}`,
        });
      } catch (_) { /* per-prior write failure surfaces via supersededIds count */ }
    }
  }

  _writeAudit(vaultRoot, {
    ts: now, pack_id: packId, from: current, to: nextState,
    actor: opts.actor || 'user', reason: opts.reason || null,
    superseded_ids: supersededIds.length ? supersededIds : undefined,
  });

  return { ok: true, pack: nextPack, superseded: supersededIds };
}

function listAuditEntries(vaultRoot, packId) {
  const p = _auditPath(vaultRoot);
  if (!fs.existsSync(p)) return { ok: true, entries: [] };
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8'); } catch (_) { return { ok: true, entries: [] }; }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (packId && row.pack_id !== packId) continue;
      entries.push(row);
    } catch (_) { /* skip malformed */ }
  }
  return { ok: true, entries };
}

module.exports = {
  ALLOWED_TRANSITIONS: ALLOWED,
  canTransition,
  transitionPack,
  isFrozen,
  listAuditEntries,
};
