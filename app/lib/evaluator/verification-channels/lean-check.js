// V0.5 E0 D15-D18 — Lean / Z3 type-check verification channel STUB.
//
// This is a STUB. The full implementation is deferred to E2 per V0.5 main plan
// "EPOCH 0 / Tech / Week 4: Lean / Z3 type-check stub (real impl deferred to E2)".
//
// This file exists at E0 to lock the INTERFACE so that:
//   1. The events.jsonl schema verification_channel enum can include 'proof'
//   2. f1-harness can dispatch to lockProof / verifyAgainstProof when an item
//      declares verification_channel='proof'
//   3. E2 swap-in is mechanical — replace function bodies, leave signatures alone
//
// Current behavior: ALL calls return {pass: false, reason: '<descriptive>'}
// with explicit "deferred to E2" or "lean toolchain unavailable" messaging.
// No silent failure — every reason is human-readable.
//
// Mirrors interface conventions from:
//   - exec-cell.js     — channel-tagged result envelope + runtime_ms field
//   - sealed-rubric.js — sha256 anchoring + lock/verify pattern + ISO timestamp
//
// Created 2026-05-10 on v0.5-substrate.

'use strict';

const crypto = require('crypto');
const { execSync } = require('child_process');

const TOOLCHAIN_DETECT_TIMEOUT_MS = 2000;
const STUB_VERSION = '0.5.D18-stub';
const STUB_REASON_NOTE = 'lean-check stub — full type-check deferred to E2 per V0.5 plan';

let _toolchainStatus = null;

function _sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function _detectLeanToolchain() {
  if (_toolchainStatus !== null) return _toolchainStatus;
  try {
    // Try lean (current canonical for Lean4 toolchain), fall back to lean4 binary.
    // Use shell:true so the `||` fallback works on both POSIX and Windows.
    const out = execSync('lean --version 2>&1 || lean4 --version 2>&1', {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TOOLCHAIN_DETECT_TIMEOUT_MS,
      shell: true,
    }).toString().trim();
    _toolchainStatus = { available: true, version: out };
  } catch (_e) {
    _toolchainStatus = { available: false, reason: 'lean / lean4 not found in PATH' };
  }
  return _toolchainStatus;
}

// lockProof(proofText) → {hash, locked_at, version, note}
//
// E0 stub: returns a sha256 anchor over the raw proof text.
// E2 will: type-check + Lean-elaborate the proof body BEFORE locking, and
// return a hash over the elaborated proof term (not raw source) so that
// minor whitespace / comment edits to the proof source do not invalidate
// the locked artifact.
function lockProof(proofText) {
  if (typeof proofText !== 'string') {
    throw new Error('lean-check.lockProof: proofText must be a string');
  }
  if (proofText.trim() === '') {
    throw new Error('lean-check.lockProof: proofText must be non-empty');
  }
  return {
    hash: _sha256(proofText),
    locked_at: new Date().toISOString(),
    version: STUB_VERSION,
    note: STUB_REASON_NOTE,
  };
}

// verifyAgainstProof(userResponse, sealedHash, opts) →
//   {pass, channel, reason, runtime_ms, toolchain_status}
//
// E0 stub: ALWAYS returns pass:false with explicit "deferred to E2" reason.
// E2 will: parse userResponse as a Lean term, elaborate via the lean executable,
// type-check against the goal extracted from sealedHash → {pass:true} only when
// elaboration succeeds AND the elaborated-term hash matches sealedHash.
function verifyAgainstProof(userResponse, sealedHash, opts) {
  opts = opts || {};
  const t0 = Date.now();

  // Input shape checks — return structured envelopes, do not throw.
  if (typeof userResponse !== 'string') {
    return {
      pass: false,
      channel: 'proof',
      reason: 'lean-check.verifyAgainstProof: userResponse must be a string',
      runtime_ms: Date.now() - t0,
      toolchain_status: null,
    };
  }
  if (typeof sealedHash !== 'string' || sealedHash.length !== 64) {
    return {
      pass: false,
      channel: 'proof',
      reason: 'lean-check.verifyAgainstProof: sealedHash must be 64-char hex sha256',
      runtime_ms: Date.now() - t0,
      toolchain_status: null,
    };
  }

  const toolchain = _detectLeanToolchain();
  if (!toolchain.available) {
    return {
      pass: false,
      channel: 'proof',
      reason: `lean toolchain not installed: ${toolchain.reason}; deferred to E2 per V0.5 plan`,
      runtime_ms: Date.now() - t0,
      toolchain_status: toolchain,
    };
  }

  // Toolchain present but stub — E0 deliberately does not attempt verification.
  return {
    pass: false,
    channel: 'proof',
    reason: STUB_REASON_NOTE,
    runtime_ms: Date.now() - t0,
    toolchain_status: toolchain,
  };
}

module.exports = {
  lockProof,
  verifyAgainstProof,
  _detectLeanToolchain, // exported for tests / debugging
  STUB_VERSION,
};
