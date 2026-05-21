'use strict';
// Pricing v3 payment rails — smoke gate (v0.5.0-bootstrap-6).
//
// Created 2026-05-20. Verifies app/lib/pricing/payment-rails.js ships
// the locked state machine + audit JSONL + provider validation, AND
// that loyalty-engine 10/10 regression still holds.
//
// 10 cases:
//   PR1  createPaymentIntent returns valid intent shape
//   PR2  verifyPaymentCompletion before-processing-delay → verified=false
//   PR3  verifyPaymentCompletion after-processing-delay → verified=true
//   PR4  state machine transitions valid (PENDING → VERIFIED, not back)
//   PR5  JSONL audit trail written correctly (append-only, replay-foldable)
//   PR6  unknown provider → throws UNSUPPORTED_PROVIDER
//   PR7  unknown sku → throws UNSUPPORTED_SKU
//   PR8  expired intent → cannot verify (state='expired', verified=false)
//   PR9  listSupportedProviders returns ['wechat', 'stripe']
//   PR10 regression — loyalty-engine 10/10 must still pass
//
// Run:  node app/scripts/_dev_verify_payment_rails.js
// Exit: 0 = all PASS, 1 = any FAIL.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// Sandbox the audit log to a temp dir so we don't pollute real vault.
const TMP_VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-pay-rails-'));
process.env.HYPHA_DATA = TMP_VAULT;

const rails = require('../lib/pricing/payment-rails');
const {
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
} = rails;

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log('PASS  ' + label);
  } else {
    fail += 1;
    failures.push({ label, detail });
    console.log('FAIL  ' + label + (detail ? '  — ' + detail : ''));
  }
}

// Deterministic clock anchor — all stub timings relative to NOW.
const NOW = Date.parse('2026-05-20T12:00:00Z');

// ---------------------------------------------------------------------------
// PR1 — createPaymentIntent returns valid intent shape
// ---------------------------------------------------------------------------
{
  const r = createPaymentIntent(
    { sku: 'founders', amount_cny: 499, provider: 'wechat' },
    { refMs: NOW }
  );
  const okShape = r && r.ok === true
    && typeof r.intent_id === 'string' && r.intent_id.startsWith('pi_')
    && r.provider === 'wechat'
    && r.sku === 'founders'
    && r.amount_cny === 499
    && r.state === STATES.PENDING
    && typeof r.created_at === 'string'
    && typeof r.expires_at === 'string'
    && (typeof r.qr_code === 'string' && r.qr_code.length > 0);
  check(
    'PR1 createPaymentIntent returns valid intent shape (wechat → qr_code)',
    okShape,
    'got=' + JSON.stringify(r)
  );
}

// ---------------------------------------------------------------------------
// PR2 — verifyPaymentCompletion before STUB_PROCESSING_MS → verified=false
// ---------------------------------------------------------------------------
let preDelayIntent = null;
{
  const r = createPaymentIntent(
    { sku: 'founders', amount_cny: 499, provider: 'stripe' },
    { refMs: NOW }
  );
  preDelayIntent = r;
  const v = verifyPaymentCompletion(r.intent_id, { refMs: NOW + 100 });
  check(
    'PR2 verifyPaymentCompletion before stub delay → verified=false',
    v && v.ok === true && v.verified === false && v.state === STATES.PENDING,
    'got=' + JSON.stringify(v)
  );
}

// ---------------------------------------------------------------------------
// PR3 — verifyPaymentCompletion after STUB_PROCESSING_MS → verified=true
// ---------------------------------------------------------------------------
{
  const after = NOW + STUB_PROCESSING_MS + 100;
  const v = verifyPaymentCompletion(preDelayIntent.intent_id, { refMs: after });
  check(
    'PR3 verifyPaymentCompletion after stub delay → verified=true + transaction_id',
    v && v.verified === true
      && v.state === STATES.VERIFIED
      && typeof v.paid_at === 'string'
      && typeof v.transaction_id === 'string'
      && v.transaction_id.startsWith('txn_stub_')
      && v.provider === 'stripe',
    'got=' + JSON.stringify(v)
  );
}

// ---------------------------------------------------------------------------
// PR4 — state machine transitions valid: VERIFIED is terminal, re-verify
//       returns same VERIFIED state w/o regression to PENDING
// ---------------------------------------------------------------------------
{
  const after = NOW + STUB_PROCESSING_MS + 5000;
  const v1 = verifyPaymentCompletion(preDelayIntent.intent_id, { refMs: after });
  const v2 = verifyPaymentCompletion(preDelayIntent.intent_id, { refMs: after + 10000 });
  check(
    'PR4 state machine — VERIFIED is terminal (no regression to PENDING)',
    v1.state === STATES.VERIFIED && v2.state === STATES.VERIFIED
      && v1.transaction_id === v2.transaction_id,
    'v1.state=' + v1.state + ' v2.state=' + v2.state
      + ' txn1=' + v1.transaction_id + ' txn2=' + v2.transaction_id
  );
}

// ---------------------------------------------------------------------------
// PR5 — JSONL audit trail written correctly (append-only, replay-foldable)
// ---------------------------------------------------------------------------
{
  const auditAbs = path.join(TMP_VAULT, '.hypha', 'payment-intents.jsonl');
  const exists = fs.existsSync(auditAbs);
  const rows = readAuditLog();
  // We've created 2 intents + verified the 2nd → expect at least 3 rows
  // (PR1 created, PR2 created, PR3 verified). Older rows from prior PR2
  // verify-before-delay don't produce new rows (no state change).
  const hasCreated = rows.filter(r => r.transition === 'created').length >= 2;
  const hasVerified = rows.filter(r => r.transition === 'verified').length >= 1;
  // Fold-foldable: latest row per intent_id should reflect terminal state.
  const folded = getIntent(preDelayIntent.intent_id);
  check(
    'PR5 audit JSONL append-only + replay-foldable to terminal state',
    exists && hasCreated && hasVerified
      && folded && folded.state === STATES.VERIFIED,
    'exists=' + exists + ' rows=' + rows.length
      + ' created=' + rows.filter(r => r.transition === 'created').length
      + ' verified=' + rows.filter(r => r.transition === 'verified').length
      + ' folded.state=' + (folded && folded.state)
  );
}

// ---------------------------------------------------------------------------
// PR6 — unknown provider → throws UNSUPPORTED_PROVIDER
// ---------------------------------------------------------------------------
{
  let caught = null;
  try {
    createPaymentIntent({ sku: 'founders', amount_cny: 499, provider: 'paypal' });
  } catch (err) {
    caught = err;
  }
  check(
    'PR6 unknown provider throws UNSUPPORTED_PROVIDER',
    caught && caught.code === 'UNSUPPORTED_PROVIDER'
      && /paypal/.test(caught.message),
    'caught=' + (caught && caught.code) + ' msg=' + (caught && caught.message)
  );
}

// ---------------------------------------------------------------------------
// PR7 — unknown sku → throws UNSUPPORTED_SKU
// ---------------------------------------------------------------------------
{
  let caught = null;
  try {
    createPaymentIntent({ sku: 'enterprise', amount_cny: 5000, provider: 'wechat' });
  } catch (err) {
    caught = err;
  }
  check(
    'PR7 unknown sku throws UNSUPPORTED_SKU',
    caught && caught.code === 'UNSUPPORTED_SKU',
    'caught=' + (caught && caught.code)
  );
}

// ---------------------------------------------------------------------------
// PR8 — expired intent → cannot verify (state='expired', verified=false)
// ---------------------------------------------------------------------------
{
  const r = createPaymentIntent(
    { sku: 'pro_yearly', amount_cny: 999, provider: 'stripe' },
    { refMs: NOW }
  );
  // Jump past expiry (15min stub) — verify should mark expired.
  const v = verifyPaymentCompletion(r.intent_id, { refMs: NOW + STUB_EXPIRY_MS + 1000 });
  check(
    'PR8 expired intent → state=expired, verified=false (cannot verify)',
    v && v.ok === true && v.verified === false && v.state === STATES.EXPIRED,
    'got=' + JSON.stringify(v)
  );
  // Followup: trying to verify the expired intent again should stay expired
  // (terminal state, no resurrection).
  const v2 = verifyPaymentCompletion(r.intent_id, { refMs: NOW + STUB_EXPIRY_MS + 5000 });
  if (!(v2 && v2.state === STATES.EXPIRED)) {
    failures.push({ label: 'PR8 followup', detail: 'expired intent resurrected: ' + JSON.stringify(v2) });
  }
}

// ---------------------------------------------------------------------------
// PR9 — listSupportedProviders returns the locked array
// ---------------------------------------------------------------------------
{
  const list = listSupportedProviders();
  const okList = Array.isArray(list)
    && list.length === 2
    && list.indexOf('wechat') !== -1
    && list.indexOf('stripe') !== -1;
  check(
    'PR9 listSupportedProviders returns [wechat, stripe]',
    okList,
    'got=' + JSON.stringify(list)
  );
}

// ---------------------------------------------------------------------------
// PR10 — regression: loyalty-engine 10/10 must still pass
// ---------------------------------------------------------------------------
{
  let loyaltyOk = false;
  let loyaltyDetail = null;
  try {
    // Run as child process — isolates from our env mutation (HYPHA_DATA).
    const out = execSync(
      'node ' + JSON.stringify(path.resolve(__dirname, '_dev_verify_pricing_loyalty.js')),
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }
    );
    loyaltyOk = /10 PASS \/ 0 FAIL/.test(out);
    loyaltyDetail = out.trim().split('\n').slice(-3).join(' | ');
  } catch (err) {
    loyaltyDetail = 'child process failed: ' + (err.stdout || err.message);
  }
  check(
    'PR10 regression — loyalty-engine 10/10 still pass',
    loyaltyOk,
    loyaltyDetail
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log('───────────────────────────────────────');
console.log('payment-rails smoke: ' + pass + ' PASS / ' + fail + ' FAIL  (' + pass + '/' + (pass + fail) + ')');
if (fail > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) {
    console.log('  • ' + f.label);
    if (f.detail) console.log('    ' + f.detail);
  }
  process.exit(1);
}

// Cleanup sandbox vault — best-effort; if it sticks around in tmp, OS reaps it.
try {
  fs.rmSync(TMP_VAULT, { recursive: true, force: true });
} catch (_) { /* tmp dir cleanup is opportunistic */ }

process.exit(0);
