'use strict';
// HYPHA · Pricing tier → Cost-Budget runtime link smoke.
//
// Created 2026-05-20 (v1.0 boot-8). Verifies that:
//   - loyalty-engine.getTierDailyCap returns the locked per-tier cap
//   - shield.checkCashflowShield reads tier from vault/data/profile.json
//   - cache is process-life, invalidates on shield.clearTierCache
//   - tier change up (Free→Founders) raises cap mid-day, preserves remaining
//   - BYOK is unlimited (null cap, shield.unlimited === true)
//   - pre-call gate's WOULD_EXCEED_BUDGET threshold shifts with tier
//
// Hermetic: writes to a temp HYPHA_DATA directory, never touches the
// real vault. Restores env at the end so it composes with other smokes.
//
// Run:  node app/scripts/_dev_verify_tier_budget_link.js
// Exit: 0 = all PASS, 1 = any FAIL.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Hermetic vault setup — point HYPHA_DATA at a fresh tmpdir.
// vault.resolveRoot() reads this env at call time (no module-load cache).
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-tier-budget-'));
const prevVaultRoot = process.env.HYPHA_DATA;
const prevDev = process.env.HYPHA_DEV;
const prevAllow = process.env.HYPHA_ALLOW_CLI;
const prevNodeEnv = process.env.NODE_ENV;

process.env.HYPHA_DATA = tmpRoot;
// Force production-mode semantics: dev bypass would auto-promote to BYOK and
// hide the per-tier ceiling we are trying to verify. Save + restore at end.
delete process.env.HYPHA_DEV;
delete process.env.HYPHA_ALLOW_CLI;
process.env.NODE_ENV = 'production';

fs.mkdirSync(path.join(tmpRoot, 'data'), { recursive: true });

function writeProfile(profile) {
  const p = path.join(tmpRoot, 'data', 'profile.json');
  fs.writeFileSync(p, JSON.stringify(profile, null, 2), 'utf8');
}

function clearProfile() {
  const p = path.join(tmpRoot, 'data', 'profile.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// ---------------------------------------------------------------------------
// Load libs AFTER env is set so vault.resolveRoot picks up tmpRoot.
// ---------------------------------------------------------------------------

const engine = require('../lib/pricing/loyalty-engine');
const shield = require('../lib/cashflow-shield/shield');

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

function restoreEnv() {
  if (prevVaultRoot === undefined) delete process.env.HYPHA_DATA;
  else process.env.HYPHA_DATA = prevVaultRoot;
  if (prevDev === undefined) delete process.env.HYPHA_DEV;
  else process.env.HYPHA_DEV = prevDev;
  if (prevAllow === undefined) delete process.env.HYPHA_ALLOW_CLI;
  else process.env.HYPHA_ALLOW_CLI = prevAllow;
  if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = prevNodeEnv;
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// TB1 — getTierDailyCap returns locked cap per tier id
// ---------------------------------------------------------------------------
{
  const cases = [
    ['founders', 50],
    ['pro',      30],
    ['basic',    15],
    ['free',     5],
    ['byok',     null],
  ];
  let allOk = true;
  const got = [];
  for (const [tier, expected] of cases) {
    const cap = engine.getTierDailyCap(tier);
    got.push(`${tier}:${cap}`);
    if (cap !== expected) allOk = false;
  }
  check(
    'TB1 getTierDailyCap returns locked cap per tier id',
    allOk,
    got.join(' ')
  );
}

// ---------------------------------------------------------------------------
// TB2 — case-insensitive lookup + unknown tier fail-safe (Free ¥5)
// ---------------------------------------------------------------------------
{
  const ok =
    engine.getTierDailyCap('FOUNDERS') === 50 &&
    engine.getTierDailyCap('Pro') === 30 &&
    engine.getTierDailyCap('BYOK') === null &&
    engine.getTierDailyCap('') === 5 &&
    engine.getTierDailyCap(null) === 5 &&
    engine.getTierDailyCap(undefined) === 5 &&
    engine.getTierDailyCap('bogus-tier') === 5;
  check(
    'TB2 case-insensitive + unknown tier → Free ¥5 fail-safe',
    ok,
    `FOUNDERS=${engine.getTierDailyCap('FOUNDERS')} bogus=${engine.getTierDailyCap('bogus')}`
  );
}

// ---------------------------------------------------------------------------
// TB3 — FOUNDERS profile → ¥50 cap
// ---------------------------------------------------------------------------
{
  shield.clearTierCache();
  // Founders purchased ~1 year ago → still founders tier
  const oneYearAgo = new Date(Date.now() - 365.25 * 24 * 3600_000).toISOString();
  writeProfile({ founder_purchased_at: oneYearAgo });
  const r = shield.checkCashflowShield('smoke-u', 'free' /* caller hint ignored */);
  const ok = r.limit_cny === 50 && r.tier === 'founders' && r.unlimited !== true;
  check(
    'TB3 FOUNDERS profile → ¥50 cap (caller-supplied tier ignored)',
    ok,
    `limit=${r.limit_cny} tier=${r.tier} requested=${r.requested_tier}`
  );
}

// ---------------------------------------------------------------------------
// TB4 — FREE profile (no fields) → ¥5 cap
// ---------------------------------------------------------------------------
{
  shield.clearTierCache();
  writeProfile({ name: 'tester' });
  const r = shield.checkCashflowShield('smoke-u', 'pro' /* caller hint ignored */);
  const ok = r.limit_cny === 5 && r.tier === 'free';
  check(
    'TB4 FREE profile → ¥5 cap (caller "pro" hint ignored, profile wins)',
    ok,
    `limit=${r.limit_cny} tier=${r.tier}`
  );
}

// ---------------------------------------------------------------------------
// TB5 — BYOK profile → unlimited (null cap, shield.unlimited === true)
// ---------------------------------------------------------------------------
{
  shield.clearTierCache();
  writeProfile({ byok_enabled: true });
  const r = shield.checkCashflowShield('smoke-u', 'free');
  const ok = r.unlimited === true && r.limit_cny === null && r.tier === 'byok' && r.ok === true;
  check(
    'TB5 BYOK profile → unlimited (null cap, ok=true)',
    ok,
    `unlimited=${r.unlimited} limit=${r.limit_cny} tier=${r.tier} ok=${r.ok}`
  );
}

// ---------------------------------------------------------------------------
// TB6 — Cache hit: second call within TTL doesn't re-read profile
// ---------------------------------------------------------------------------
{
  shield.clearTierCache();
  writeProfile({ name: 'cached-test' }); // free
  const first = shield.checkCashflowShield('cache-u', 'pro');
  // Mutate the on-disk profile to founders — without cache invalidation the
  // shield SHOULD still see free.
  writeProfile({ founder_purchased_at: new Date().toISOString() });
  const second = shield.checkCashflowShield('cache-u', 'pro');
  const ok = first.limit_cny === 5 && second.limit_cny === 5 && second.tier === 'free';
  check(
    'TB6 cache hit: profile mutation without clearTierCache → cap unchanged',
    ok,
    `first=${first.limit_cny}(${first.tier}) second=${second.limit_cny}(${second.tier})`
  );
}

// ---------------------------------------------------------------------------
// TB7 — Cache invalidation: clearTierCache → next read sees fresh tier
// ---------------------------------------------------------------------------
{
  // Continues from TB6's state (founders on disk, free cached for 'cache-u').
  shield.clearTierCache('cache-u');
  const r = shield.checkCashflowShield('cache-u', 'pro');
  const ok = r.limit_cny === 50 && r.tier === 'founders';
  check(
    'TB7 cache invalidation: clearTierCache → next read picks fresh tier',
    ok,
    `limit=${r.limit_cny} tier=${r.tier}`
  );
}

// ---------------------------------------------------------------------------
// TB8 — Tier change up (Free → Founders) raises cap mid-day, today_cost
//        preserved (remaining recomputed against new cap)
// ---------------------------------------------------------------------------
{
  shield.clearTierCache();
  writeProfile({ name: 'mid-day-tester' }); // free
  // Simulate ¥3 already spent today on the Free ¥5 cap.
  shield.recordCharge('migrate-u', 3.0);
  const beforeUpgrade = shield.checkCashflowShield('migrate-u', 'free');
  // Upgrade — write founders profile + invalidate cache.
  writeProfile({ founder_purchased_at: new Date().toISOString() });
  shield.clearTierCache();
  const afterUpgrade = shield.checkCashflowShield('migrate-u', 'free');
  const ok =
    beforeUpgrade.limit_cny === 5
    && beforeUpgrade.today_cost_cny === 3
    && beforeUpgrade.remaining_cny === 2
    && afterUpgrade.limit_cny === 50
    && afterUpgrade.today_cost_cny === 3 // SAME — daily spend preserved
    && afterUpgrade.remaining_cny === 47 // 50 - 3
    && afterUpgrade.tier === 'founders';
  check(
    'TB8 tier change up: cap raises ¥5→¥50, today_cost preserved, remaining recomputed',
    ok,
    `before(${beforeUpgrade.limit_cny}/${beforeUpgrade.today_cost_cny}/${beforeUpgrade.remaining_cny}) after(${afterUpgrade.limit_cny}/${afterUpgrade.today_cost_cny}/${afterUpgrade.remaining_cny}) tier=${afterUpgrade.tier}`
  );
}

// ---------------------------------------------------------------------------
// TB9 — enforceShield: caller-supplied tier cannot escape profile cap
//        (security: renderer-supplied { tier: 'founders' } on a Free profile
//         must still hit BudgetExceededError at the Free ¥5 cap)
// ---------------------------------------------------------------------------
{
  shield.clearTierCache();
  writeProfile({ name: 'security-test' }); // free → ¥5
  // Simulate ¥4.50 spent already
  // (recordCharge keys by userId — use fresh id so it doesn't bleed from TB8)
  shield.recordCharge('sec-u', 4.50);
  let thrown = null;
  try {
    shield.enforceShield('sec-u', {
      tier: 'founders', // CALLER LIES — profile is free, must be rejected
      estimated_cost_cny: 1.0, // 4.50 + 1.00 = 5.50 > 5 → block
    });
  } catch (e) {
    thrown = e;
  }
  const ok =
    thrown
    && thrown.name === 'BudgetExceededError'
    && thrown.details
    && thrown.details.tier === 'free' // canonical tier from profile, not caller
    && thrown.details.shield
    && thrown.details.shield.limit_cny === 5;
  check(
    'TB9 enforceShield: caller-supplied tier cannot escape profile cap',
    ok,
    thrown
      ? `name=${thrown.name} reportedTier=${thrown.details && thrown.details.tier} limit=${thrown.details && thrown.details.shield && thrown.details.shield.limit_cny}`
      : 'no throw'
  );
}

// ---------------------------------------------------------------------------
// TB10 — Pre-call gate threshold shifts with tier: same predicted ¥
//         would BLOCK on Free (¥5 cap, ¥4 already spent → ¥1 remaining)
//         but PASS on Founders (¥50 cap, ¥4 spent → ¥46 remaining)
// ---------------------------------------------------------------------------
{
  // Use enforceShield directly (router-cost-gate is covered by its own smoke).
  // Step 1 — Free user with ¥4 spent, ¥3 predicted call → block.
  shield.clearTierCache();
  writeProfile({ name: 'threshold-test' }); // free
  // Fresh user for clean today_cost
  shield.recordCharge('threshold-u', 4.0);
  let freeThrown = null;
  try {
    shield.enforceShield('threshold-u', {
      tier: 'free',
      estimated_cost_cny: 3.0, // 4+3=7 > 5 → block
    });
  } catch (e) { freeThrown = e; }
  const freeBlocked = freeThrown && freeThrown.name === 'BudgetExceededError';

  // Step 2 — same daily spend, but upgrade to Founders → should PASS
  writeProfile({ founder_purchased_at: new Date().toISOString() });
  shield.clearTierCache();
  let foundersPassed = false;
  try {
    const r = shield.enforceShield('threshold-u', {
      tier: 'founders',
      estimated_cost_cny: 3.0, // 4+3=7 ≪ 50 → pass
    });
    foundersPassed = !!(r && r.ok);
  } catch (e) { foundersPassed = false; }

  const ok = freeBlocked && foundersPassed;
  check(
    'TB10 pre-call gate threshold shifts: Free blocks @ ¥3 predicted, Founders passes',
    ok,
    `freeBlocked=${freeBlocked} foundersPassed=${foundersPassed}`
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('');
console.log('───────────────────────────────────────');
console.log('tier-budget-link smoke: ' + pass + ' PASS / ' + fail + ' FAIL  (' + pass + '/' + (pass + fail) + ')');
if (fail > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) {
    console.log('  - ' + f.label + (f.detail ? '  — ' + f.detail : ''));
  }
  restoreEnv();
  process.exit(1);
}
restoreEnv();
process.exit(0);
