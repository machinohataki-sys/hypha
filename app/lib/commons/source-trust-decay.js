'use strict';

// HYPHA · Commons · Source Trust Decay (extends source-trust.js).
//
// Models freshness decay: per-source trust multiplier degrades 0.9× per
// 90-day window since `last_verified_at`, floor 0.3. Sources with
// `trust_override` are exempted (manual curator pin). Every score change
// emits a row to `<vault>/.commons-packs/.trust-audit.jsonl`.
//
// Decay curve is multiplicative and bounded so frequent re-verification
// pulls scores back up while stale sources fade without disappearing.
//
// API:
//   applyDecay(rawTrust, lastVerifiedAt, opts?)
//     → {trust, decayFactor, windowsPassed, override}
//   decayedSourceList(pack, opts?)
//     → [{source, raw_trust, decayed_trust, windowsPassed, override, audit?}]
//   emitAudit(vaultRoot, entry) → boolean

const fs = require('node:fs');
const path = require('node:path');

const PACK_DIR_NAME = '.commons-packs';
const AUDIT_FILE = '.trust-audit.jsonl';
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DECAY_PER_WINDOW = 0.9;
const FLOOR = 0.3;

function applyDecay(rawTrust, lastVerifiedAt, opts = {}) {
  const t = Number(rawTrust);
  if (!Number.isFinite(t)) {
    return { trust: 0, decayFactor: 0, windowsPassed: 0, override: false };
  }
  if (opts.override === true) {
    return { trust: t, decayFactor: 1, windowsPassed: 0, override: true };
  }
  const verifiedMs = Date.parse(lastVerifiedAt || '');
  if (!Number.isFinite(verifiedMs)) {
    // No last_verified_at on record — treat as one full window stale so
    // unverified sources visibly trail freshly-verified peers.
    const decayed = Math.max(t * DECAY_PER_WINDOW, t * FLOOR);
    return {
      trust: Math.max(decayed, t * FLOOR),
      decayFactor: DECAY_PER_WINDOW,
      windowsPassed: 1,
      override: false,
    };
  }
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const elapsed = Math.max(0, now - verifiedMs);
  const windowsPassed = Math.floor(elapsed / WINDOW_MS);
  if (windowsPassed === 0) {
    return { trust: t, decayFactor: 1, windowsPassed: 0, override: false };
  }
  const decay = Math.pow(DECAY_PER_WINDOW, windowsPassed);
  const decayed = Math.max(t * decay, t * FLOOR);
  return {
    trust: decayed,
    decayFactor: decay,
    windowsPassed,
    override: false,
  };
}

function decayedSourceList(pack, opts = {}) {
  if (!pack || typeof pack !== 'object') return [];
  const sources = Array.isArray(pack.recommended_sources) ? pack.recommended_sources : [];
  const out = [];
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const raw = typeof src.trust === 'number' ? src.trust
              : typeof src.reputation === 'number' ? src.reputation
              : 0.5;
    const decayed = applyDecay(raw, src.last_verified_at, {
      override: src.trust_override === true,
      now: opts.now,
    });
    out.push({
      source: src.url || src.title || '(unknown)',
      raw_trust: raw,
      decayed_trust: decayed.trust,
      windowsPassed: decayed.windowsPassed,
      override: decayed.override,
    });
  }
  return out;
}

function emitAudit(vaultRoot, entry) {
  if (!vaultRoot || typeof vaultRoot !== 'string') return false;
  if (!entry || typeof entry !== 'object') return false;
  try {
    const dir = path.join(vaultRoot, PACK_DIR_NAME);
    fs.mkdirSync(dir, { recursive: true });
    const row = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(path.join(dir, AUDIT_FILE), JSON.stringify(row) + '\n', 'utf-8');
    return true;
  } catch (_) {
    return false;
  }
}

function readAudit(vaultRoot, packId) {
  const p = path.join(vaultRoot, PACK_DIR_NAME, AUDIT_FILE);
  if (!fs.existsSync(p)) return [];
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (packId && row.pack_id !== packId) continue;
      out.push(row);
    } catch (_) { /* skip malformed */ }
  }
  return out;
}

module.exports = {
  WINDOW_MS,
  DECAY_PER_WINDOW,
  FLOOR,
  applyDecay,
  decayedSourceList,
  emitAudit,
  readAudit,
};
