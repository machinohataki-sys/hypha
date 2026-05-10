// V0.5 E0 — typed event writer
//
// Wraps vault.appendJSONL() with schema validation against events-schema.json.
// Replaces ad-hoc event writes scattered across agent.js (lines 86-146 area in legacy code).
//
// Usage:
//   const events = require('./events');
//   events.write('philosophy', { type: 'tuple_verified', tuple_id: 'p-001', verification_channel: 'code', exec_result: { pass: true, stdout_hash: 'ab12...', runtime_ms: 142 } });
//
// DAG-edge constraint: this file imports nothing from agent.js; agent.js imports this.
// Created 2026-05-10 on v0.5-substrate branch.

'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA = require('./events-schema.json');
const VALID_LIFECYCLE = new Set(['draft', 'ratified', 'superseded', 'deprecated']);
const VALID_VERIFICATION = new Set(['code', 'proof', 'sealed_rubric', 'none']);

function _vaultRoot() {
  return process.env.HYPHA_VAULT_DIR || path.join(__dirname, '..', '..', 'vault');
}

function _ensureFile(p) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
}

function _validate(event) {
  if (!event || typeof event !== 'object') {
    return { ok: false, reason: 'event must be an object' };
  }
  if (!event.type || typeof event.type !== 'string') {
    return { ok: false, reason: 'event.type required (string)' };
  }
  if (event.lifecycle != null && !VALID_LIFECYCLE.has(event.lifecycle)) {
    return { ok: false, reason: `lifecycle must be one of ${Array.from(VALID_LIFECYCLE).join('|')}` };
  }
  if (event.verification_channel != null && !VALID_VERIFICATION.has(event.verification_channel)) {
    return { ok: false, reason: `verification_channel must be one of ${Array.from(VALID_VERIFICATION).join('|')}` };
  }
  if (event.exec_result != null) {
    if (typeof event.exec_result !== 'object') {
      return { ok: false, reason: 'exec_result must be object' };
    }
    if (typeof event.exec_result.pass !== 'boolean') {
      return { ok: false, reason: 'exec_result.pass must be boolean' };
    }
  }
  if (event.answer_key_hash != null && typeof event.answer_key_hash !== 'string') {
    return { ok: false, reason: 'answer_key_hash must be string (sha256 hex)' };
  }
  if (event.irr_kappa != null && (typeof event.irr_kappa !== 'number' || event.irr_kappa < -1 || event.irr_kappa > 1)) {
    return { ok: false, reason: 'irr_kappa must be number in [-1, 1]' };
  }
  return { ok: true };
}

function write(slug, event) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('events.write: slug required');
  }
  const enriched = {
    ts: new Date().toISOString(),
    lifecycle: 'draft',
    verification_channel: 'none',
    ...event,
  };
  const v = _validate(enriched);
  if (!v.ok) {
    // No silent-catch: surface validation failure as warn + write a quarantine event.
    console.warn(`[events] validation failed for slug=${slug} type=${event && event.type}: ${v.reason}`);
    const quarantineDir = path.join(_vaultRoot(), '.events-quarantine');
    if (!fs.existsSync(quarantineDir)) fs.mkdirSync(quarantineDir, { recursive: true });
    const quarantinePath = path.join(quarantineDir, `${slug}-${Date.now()}.jsonl`);
    fs.appendFileSync(quarantinePath, JSON.stringify({ original: event, reason: v.reason, ts: new Date().toISOString() }) + '\n', 'utf8');
    return { ok: false, reason: v.reason, quarantined: quarantinePath };
  }
  const filePath = path.join(_vaultRoot(), slug, 'events.jsonl');
  _ensureFile(filePath);
  fs.appendFileSync(filePath, JSON.stringify(enriched) + '\n', 'utf8');
  return { ok: true, path: filePath };
}

function read(slug, filter) {
  const filePath = path.join(_vaultRoot(), slug, 'events.jsonl');
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (!filter) { events.push(e); continue; }
      if (filter.type && e.type !== filter.type) continue;
      if (filter.tuple_id && e.tuple_id !== filter.tuple_id) continue;
      if (filter.lifecycle && e.lifecycle !== filter.lifecycle) continue;
      if (filter.verification_channel && e.verification_channel !== filter.verification_channel) continue;
      if (filter.since && e.ts < filter.since) continue;
      events.push(e);
    } catch (err) {
      console.warn(`[events] skip malformed line in ${slug}: ${err.message}`);
    }
  }
  return events;
}

function ratify(slug, tupleId) {
  return write(slug, {
    type: 'lifecycle_transition',
    tuple_id: tupleId,
    lifecycle: 'ratified',
    notes: `ratified at ${new Date().toISOString()}`,
  });
}

function deprecate(slug, tupleId, reason) {
  return write(slug, {
    type: 'lifecycle_transition',
    tuple_id: tupleId,
    lifecycle: 'deprecated',
    notes: reason || 'deprecated without reason',
  });
}

module.exports = {
  write,
  read,
  ratify,
  deprecate,
  SCHEMA,
};
