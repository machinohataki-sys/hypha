'use strict';
// HYPHA · Pricing v3 payment rails — STUB layer (v0.5.0-bootstrap-6).
//
// Created 2026-05-20. Wires WeChat Pay + Stripe placeholders behind a
// state-machine + audit-log so the FoundersPurchasePanel button is no
// longer a free flip. Real SDK adapters land v1.1+ — every spot where
// a real call would go is tagged `// TODO[v1.1]`.
//
// Contract (consumed by app/main.js pricing IPC handlers):
//
//   createPaymentIntent({sku, amount_cny, provider}) →
//     { ok, intent_id, provider, sku, amount_cny, payment_url, qr_code,
//       state: 'pending_payment', created_at, expires_at }
//
//   verifyPaymentCompletion(intent_id, {refMs}?) →
//     { ok, verified: bool, intent_id, state, paid_at?, transaction_id?,
//       provider?, error?: { code, message } }
//
//   listSupportedProviders() → ['wechat', 'stripe']
//
// State machine:
//   created → pending_payment → verified
//                             ↘ expired   (after STUB_EXPIRY_MS w/o pay)
//                             ↘ failed    (provider rejection — v1.1+)
//                             ↘ refunded  (post-verified refund — v1.1+)
//
// Stub semantics:
//   - createPaymentIntent persists row immediately at state=pending_payment
//   - verifyPaymentCompletion auto-flips to verified once
//     STUB_PROCESSING_MS has elapsed since created_at (default 2000ms).
//     Before that → returns verified=false, state='pending_payment'.
//     After STUB_EXPIRY_MS without verify call → state='expired'.
//
// Audit:
//   Every state transition appended to vault/.hypha/payment-intents.jsonl.
//   File missing → first call creates parent dir + appends. Append-only;
//   never rewrite. JSONL row = full intent snapshot at the transition,
//   not a delta — replay = trivial fold.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPORTED_PROVIDERS = Object.freeze(['wechat', 'stripe']);

const SUPPORTED_SKUS = Object.freeze({
  founders: { amount_cny: 499, label: 'Founders 永久席位' },
  pro_yearly: { amount_cny: 999, label: 'Pro 年付' },
});

const STATES = Object.freeze({
  PENDING: 'pending_payment',
  VERIFIED: 'verified',
  EXPIRED: 'expired',
  FAILED: 'failed',
  REFUNDED: 'refunded',
});

// Stub timings. Real adapter ignores these.
const STUB_PROCESSING_MS = 2000;        // simulated bank settle
const STUB_EXPIRY_MS = 15 * 60 * 1000;  // 15 min — mirrors real QR ttl

const AUDIT_REL = '.hypha/payment-intents.jsonl';

// ---------------------------------------------------------------------------
// Vault accessor — lazy, defensive. payment-rails must be safe to require
// from smoke scripts that boot without electron's vault module mounted.
// ---------------------------------------------------------------------------

function _loadVault() {
  try {
    // path mirrors loyalty-engine.js neighbor → ../vault
    return require('../vault');
  } catch (_) {
    return null;
  }
}

function _resolveAuditPath() {
  const v = _loadVault();
  if (v && typeof v.resolveRoot === 'function') {
    return path.join(v.resolveRoot(), AUDIT_REL);
  }
  // Fallback for smoke tests — write under app/.. /data
  return path.resolve(__dirname, '..', '..', '..', 'data', AUDIT_REL);
}

function _ensureParentDir(absFile) {
  try {
    fs.mkdirSync(path.dirname(absFile), { recursive: true });
  } catch (_) { /* parent may already exist */ }
}

// ---------------------------------------------------------------------------
// Audit log — JSONL append, never rewrite. Replay-friendly.
// ---------------------------------------------------------------------------

function _appendAudit(row) {
  const abs = _resolveAuditPath();
  _ensureParentDir(abs);
  const line = JSON.stringify(row) + '\n';
  // O_APPEND atomic on POSIX + Win32 NTFS for sub-PIPE_BUF writes (~512B);
  // intent rows are well under that. No rename dance needed.
  fs.appendFileSync(abs, line, 'utf-8');
}

function _readAudit() {
  const abs = _resolveAuditPath();
  if (!fs.existsSync(abs)) return [];
  const raw = fs.readFileSync(abs, 'utf-8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

/**
 * Fold the audit log into the latest known state per intent_id.
 * Pure — does not mutate disk.
 *
 * @returns {Map<string, object>} intent_id → latest row
 */
function _foldIntents() {
  const rows = _readAudit();
  const map = new Map();
  for (const row of rows) {
    if (row && typeof row.intent_id === 'string') {
      map.set(row.intent_id, row);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function _validateProvider(provider) {
  if (typeof provider !== 'string' || !SUPPORTED_PROVIDERS.includes(provider)) {
    const err = new Error(
      `unsupported provider: ${provider} (expected one of ${SUPPORTED_PROVIDERS.join(', ')})`
    );
    err.code = 'UNSUPPORTED_PROVIDER';
    throw err;
  }
}

function _validateSku(sku) {
  if (typeof sku !== 'string' || !(sku in SUPPORTED_SKUS)) {
    const err = new Error(
      `unsupported sku: ${sku} (expected one of ${Object.keys(SUPPORTED_SKUS).join(', ')})`
    );
    err.code = 'UNSUPPORTED_SKU';
    throw err;
  }
}

function _validateAmount(amount_cny, sku) {
  if (typeof amount_cny !== 'number' || !Number.isFinite(amount_cny) || amount_cny <= 0) {
    const err = new Error(`amount_cny must be positive finite number, got ${amount_cny}`);
    err.code = 'INVALID_AMOUNT';
    throw err;
  }
  const expected = SUPPORTED_SKUS[sku].amount_cny;
  if (amount_cny !== expected) {
    const err = new Error(`amount_cny mismatch for sku ${sku}: expected ¥${expected}, got ¥${amount_cny}`);
    err.code = 'AMOUNT_MISMATCH';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Stub provider adapters — return placeholders. Real SDK swaps these.
// ---------------------------------------------------------------------------

function _stubProviderCreate(provider, intent_id, sku, amount_cny) {
  // intentional-placeholder: real wechat/stripe SDK adapter belongs to
  // the regulated-payments work-stream (v1.1+ slice). Hypha v1.0 ships
  // payment RAILS not payment INTEGRATION — the state machine + audit
  // JSONL + Founders gate enforcement are the v1.0 contract. The real
  // SDK call swaps in here without touching createPaymentIntent shape:
  //   wechat:  POST /v3/pay/transactions/native → returns code_url
  //   stripe:  stripe.paymentIntents.create({ amount, currency: 'cny' })
  //            → returns client_secret + payment_intent.id
  // For now we synthesize plausible-shape placeholders so the UI can
  // exercise QR + URL render paths against a stable contract.
  if (provider === 'wechat') {
    return {
      qr_code: `weixin://wxpay/bizpayurl?pr=STUB-${intent_id}`,
      payment_url: null,
    };
  }
  if (provider === 'stripe') {
    return {
      qr_code: null,
      payment_url: `https://checkout.stripe.com/stub/${intent_id}?sku=${encodeURIComponent(sku)}&amount=${amount_cny}`,
    };
  }
  // Defensive — _validateProvider should have caught this.
  return { qr_code: null, payment_url: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new payment intent. Writes pending row to audit JSONL.
 *
 * @param {object} args
 * @param {string} args.sku — 'founders' | 'pro_yearly'
 * @param {number} args.amount_cny — must match SUPPORTED_SKUS[sku].amount_cny
 * @param {string} args.provider — 'wechat' | 'stripe'
 * @param {{refMs?: number, intent_id?: string}} [opts]
 * @returns {{ok, intent_id, provider, sku, amount_cny, payment_url, qr_code, state, created_at, expires_at}}
 */
function createPaymentIntent(args, opts = {}) {
  const { sku, amount_cny, provider } = args || {};
  _validateProvider(provider);
  _validateSku(sku);
  _validateAmount(amount_cny, sku);

  const nowMs = Number.isFinite(opts.refMs) ? opts.refMs : Date.now();
  const intent_id = typeof opts.intent_id === 'string' && opts.intent_id.length > 0
    ? opts.intent_id
    : `pi_${crypto.randomBytes(9).toString('hex')}`;
  const created_at = new Date(nowMs).toISOString();
  const expires_at = new Date(nowMs + STUB_EXPIRY_MS).toISOString();

  const stub = _stubProviderCreate(provider, intent_id, sku, amount_cny);

  const row = {
    intent_id,
    provider,
    sku,
    amount_cny,
    state: STATES.PENDING,
    payment_url: stub.payment_url,
    qr_code: stub.qr_code,
    created_at,
    expires_at,
    transition: 'created',
    stub: true,
  };
  _appendAudit(row);

  return {
    ok: true,
    intent_id,
    provider,
    sku,
    amount_cny,
    payment_url: stub.payment_url,
    qr_code: stub.qr_code,
    state: STATES.PENDING,
    created_at,
    expires_at,
  };
}

/**
 * Verify a payment intent. Pure-ish: reads audit log, applies stub
 * processing-delay rule, writes new transition row if state advanced.
 *
 * Stub rule:
 *   - Before STUB_PROCESSING_MS elapsed since created_at → verified=false
 *   - After STUB_PROCESSING_MS but before expires_at → verified=true (auto-pay)
 *   - After expires_at without verify → state='expired'
 *
 * Real adapter (v1.1+) replaces the time-based rule with a provider poll:
 *   wechat:  GET /v3/pay/transactions/id/{transaction_id}
 *   stripe:  stripe.paymentIntents.retrieve(intent_id)
 *
 * @param {string} intent_id
 * @param {{refMs?: number}} [opts]
 * @returns {{ok, verified, intent_id, state, paid_at?, transaction_id?, provider?, error?}}
 */
function verifyPaymentCompletion(intent_id, opts = {}) {
  if (typeof intent_id !== 'string' || intent_id.length === 0) {
    return {
      ok: false,
      verified: false,
      intent_id: null,
      state: null,
      error: { code: 'INVALID_INTENT_ID', message: 'intent_id must be non-empty string' },
    };
  }

  const folded = _foldIntents();
  const latest = folded.get(intent_id);
  if (!latest) {
    return {
      ok: false,
      verified: false,
      intent_id,
      state: null,
      error: { code: 'INTENT_NOT_FOUND', message: `no intent with id ${intent_id}` },
    };
  }

  const nowMs = Number.isFinite(opts.refMs) ? opts.refMs : Date.now();

  // Terminal states — return as-is.
  if (latest.state === STATES.VERIFIED) {
    return {
      ok: true,
      verified: true,
      intent_id,
      state: STATES.VERIFIED,
      paid_at: latest.paid_at,
      transaction_id: latest.transaction_id,
      provider: latest.provider,
    };
  }
  if (latest.state === STATES.EXPIRED || latest.state === STATES.FAILED || latest.state === STATES.REFUNDED) {
    return {
      ok: true,
      verified: false,
      intent_id,
      state: latest.state,
      provider: latest.provider,
    };
  }

  // Pending — check expiry first, then stub processing rule.
  const createdMs = Date.parse(latest.created_at);
  const expiresMs = Date.parse(latest.expires_at);

  if (Number.isFinite(expiresMs) && nowMs >= expiresMs) {
    const expiredRow = {
      ...latest,
      state: STATES.EXPIRED,
      transition: 'expired',
      expired_at: new Date(nowMs).toISOString(),
    };
    _appendAudit(expiredRow);
    return {
      ok: true,
      verified: false,
      intent_id,
      state: STATES.EXPIRED,
      provider: latest.provider,
    };
  }

  if (Number.isFinite(createdMs) && (nowMs - createdMs) >= STUB_PROCESSING_MS) {
    // intentional-placeholder: auto-verify after STUB_PROCESSING_MS is
    // the stub contract for v1.0 — it lets the UI + IPC + Founders gate
    // be exercised end-to-end without a real merchant account. Real
    // adapter (v1.1+ regulated-payments slice) swaps this branch for:
    //   wechat:  GET /v3/pay/transactions/id/{transaction_id}
    //   stripe:  stripe.paymentIntents.retrieve(intent_id)
    // The audit row shape + return shape stay identical; only the
    // verified=true trigger source moves from clock to provider poll.
    const paid_at = new Date(nowMs).toISOString();
    const transaction_id = `txn_stub_${crypto.randomBytes(8).toString('hex')}`;
    const verifiedRow = {
      ...latest,
      state: STATES.VERIFIED,
      transition: 'verified',
      paid_at,
      transaction_id,
    };
    _appendAudit(verifiedRow);
    return {
      ok: true,
      verified: true,
      intent_id,
      state: STATES.VERIFIED,
      paid_at,
      transaction_id,
      provider: latest.provider,
    };
  }

  // Still pending — no state change, no new audit row.
  return {
    ok: true,
    verified: false,
    intent_id,
    state: STATES.PENDING,
    provider: latest.provider,
  };
}

/**
 * List provider strings the env supports. Stub returns the full set;
 * v1.1+ filters by env-var presence (e.g. STRIPE_SECRET_KEY set?).
 *
 * @returns {string[]}
 */
function listSupportedProviders() {
  return SUPPORTED_PROVIDERS.slice();
}

/**
 * Read-only audit log accessor — for /admin surfaces + tests.
 *
 * @returns {object[]} all intent transition rows in append order
 */
function readAuditLog() {
  return _readAudit();
}

/**
 * Fold + return current state of a single intent (no disk writes).
 *
 * @param {string} intent_id
 * @returns {object|null}
 */
function getIntent(intent_id) {
  if (typeof intent_id !== 'string') return null;
  const folded = _foldIntents();
  return folded.get(intent_id) || null;
}

module.exports = {
  STATES,
  SUPPORTED_PROVIDERS,
  SUPPORTED_SKUS,
  STUB_PROCESSING_MS,
  STUB_EXPIRY_MS,
  createPaymentIntent,
  verifyPaymentCompletion,
  listSupportedProviders,
  readAuditLog,
  getIntent,
};
