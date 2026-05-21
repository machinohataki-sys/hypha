#!/usr/bin/env node
'use strict';

// HYPHA · v1.0 Infrastructure v2 smoke (2026-05-20).
//
// Locks the contracts shipped in the Infra v2 push:
//   1. Router cross-capability fallback chain (T6 → T4 → T3) on full
//      provider exhaustion
//   2. Router event jsonl emission with the canonical schema
//   3. Cashflow Shield 90/100/110 three-tier gate transitions
//   4. Daily reset metadata (timezone-aware midnight)
//   5. Lifetime Ledger monthly rollup (sum / avg / p95)
//   6. Cost predictor preflightQuote accuracy + length-factor scaling
//
// All providers, vault, and shield modules are mocked via require.cache so
// this verifier is pure-unit and runs offline.
//
// Run:  node app/scripts/_dev_verify_infra_v2.js
// Exit: 0 = all PASS, 1 = any FAIL.

const path = require('node:path');

// Force production mode in this smoke. The Cashflow Shield has a dev-mode
// bypass that promotes any tier to 'byok' (unlimited cap) when NODE_ENV=development
// or HYPHA_DEV/HYPHA_ALLOW_CLI is set. Under that bypass enforceShield never
// throws — which would mask the 110% hard-block contract this smoke asserts.
// Both local + CI must run with dev-mode OFF for these tests to be meaningful.
process.env.NODE_ENV = 'production';
delete process.env.HYPHA_DEV;
delete process.env.HYPHA_ALLOW_CLI;

const ROUTER_PATH = path.resolve(__dirname, '../lib/llm/router.js');
const SHIELD_PATH = path.resolve(__dirname, '../lib/cashflow-shield/shield.js');
const INDEX_PATH  = path.resolve(__dirname, '../lib/llm/index.js');
const VAULT_PATH  = path.resolve(__dirname, '../lib/vault.js');

// ---------------------------------------------------------------------------
// In-memory vault shim (covers appendJSONL / readJSONL / readJSON / read /
// write / resolveRoot). Captures router event lines for assertion.
// ---------------------------------------------------------------------------
const fakeJSONL = new Map();
const fakeJSON  = new Map();

const vaultShim = {
  resolveRoot() { return '__fake__'; },
  appendJSONL(rel, entry) {
    const arr = fakeJSONL.get(rel) || [];
    arr.push(entry);
    fakeJSONL.set(rel, arr);
  },
  readJSONL(rel) { return (fakeJSONL.get(rel) || []).slice(); },
  readJSON(rel) { return fakeJSON.has(rel) ? fakeJSON.get(rel) : null; },
  read(rel) {
    if (fakeJSONL.has(rel)) {
      return { body: fakeJSONL.get(rel).map(JSON.stringify).join('\n') + '\n' };
    }
    if (fakeJSON.has(rel)) return { body: JSON.stringify(fakeJSON.get(rel)) };
    return null;
  },
  write(rel, body) {
    try { fakeJSON.set(rel, JSON.parse(body)); return; }
    catch (_) {}
    const arr = String(body).split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
    fakeJSONL.set(rel, arr);
  },
};

function injectMock(absPath, exports) {
  require.cache[absPath] = {
    id: absPath, filename: absPath, loaded: true,
    exports, children: [], paths: [],
  };
}

// Shield mock — three configurable states used by router fallback tests.
const SHIELD_MOCK_STATE = {
  remaining_cny: 5.0,
  should_throw: false,
};

class MockBudgetExceededError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.details = details;
  }
}

const shieldMock = {
  BudgetExceededError: MockBudgetExceededError,
  MAX_DAILY_COST_CNY: { Pro: 5, Founders: 10, BYOK: 999 },
  SOFT_WARN_FRACTION: 0.8,
  WARN_FRACTION: 0.9,
  SOFT_BLOCK_FRACTION: 1.0,
  HARD_BLOCK_FRACTION: 1.1,
  checkCashflowShield(_userId, tier = 'Pro') {
    return {
      ok: true, today_cost_cny: 0, remaining_cny: SHIELD_MOCK_STATE.remaining_cny,
      limit_cny: 5, soft_warn: false, gate_state: 'OK', tier,
      requested_tier: tier, dev_mode: false,
    };
  },
  enforceShield(_userId, plannedCall = {}) {
    if (SHIELD_MOCK_STATE.should_throw) {
      throw new MockBudgetExceededError('mock daily ceiling', { reason: 'daily_ceiling', planned: plannedCall });
    }
    return {
      ok: true,
      shield: { ok: true, today_cost_cny: 0, remaining_cny: SHIELD_MOCK_STATE.remaining_cny,
        limit_cny: 5, soft_warn: false, gate_state: 'OK', tier: plannedCall.tier || 'Pro' },
    };
  },
  recordCharge() { return { total_cost_cny: 0 }; },
  notifyExceedSoft() { return { emitted: false }; },
};

// Provider mock — selectable failure profile per provider id.
const PROVIDER_MOCK = {
  failProviders: new Set(),
  callLog: [],
};

const providerMockFactory = {
  getProvider(id) {
    return {
      async chatWithUsage(args) {
        PROVIDER_MOCK.callLog.push({ id, model: args.model });
        if (PROVIDER_MOCK.failProviders.has(id)) {
          const err = new Error(`mock ${id} 500`);
          err.status = 500;
          throw err;
        }
        return { content: 'pong', usage: { input_tokens: 5, output_tokens: 5 } };
      },
      async chat(args) {
        PROVIDER_MOCK.callLog.push({ id, model: args.model, ping: true });
        if (PROVIDER_MOCK.failProviders.has(id)) {
          const err = new Error(`mock ${id} 500`);
          err.status = 500;
          throw err;
        }
        return 'pong';
      },
    };
  },
  listProviders() { return ['glm-direct', 'deepseek-direct', 'kimi-direct']; },
};

// Inject mocks BEFORE loading the router.
injectMock(VAULT_PATH, vaultShim);
injectMock(SHIELD_PATH, shieldMock);
injectMock(INDEX_PATH, providerMockFactory);

process.env.NODE_ENV = 'test';
process.env.HYPHA_LLM_NO_RECOVERY = '1';

// Now load modules under test.
const router    = require(ROUTER_PATH);
const predictor = require('../lib/llm/cost-predictor');
const ledger    = require('../lib/lifetime-ledger');
const shield    = require(SHIELD_PATH); // SAME mock so we re-test the real shield?
// We need the REAL shield for tests #7-#10. Bypass the cache by clearing it
// and loading freshly with vault mock still active.
delete require.cache[SHIELD_PATH];
const realShield = require(SHIELD_PATH);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) { pass++; console.log('PASS  ' + label); }
  else { fail++; failures.push({ label, detail }); console.log('FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

function reset() {
  PROVIDER_MOCK.failProviders.clear();
  PROVIDER_MOCK.callLog.length = 0;
  fakeJSONL.clear();
  fakeJSON.clear();
  SHIELD_MOCK_STATE.remaining_cny = 5.0;
  SHIELD_MOCK_STATE.should_throw = false;
  // Reset provider health from prior failing tests so weighted picks see all
  // providers as healthy at the start of each case.
  for (const id of ['glm-direct', 'deepseek-direct', 'kimi-direct']) {
    router.markSuccess(id);
  }
}

// ---------------------------------------------------------------------------
// 1. Router happy path emits one router event
// ---------------------------------------------------------------------------
async function t1_happy_path_emits_event() {
  reset();
  const env = await router.executeChat('T3_MID', {
    userId: 'u', tier: 'Pro', messages: [{ role: 'user', content: 'hi' }],
  });
  const events = fakeJSONL.get(router.ROUTER_EVENTS_REL) || [];
  check('1 happy path returns envelope', env && env.result === 'pong');
  check('2 happy path emits exactly one router event',
    events.length === 1,
    `expected 1, got ${events.length}`);
  const evt = events[0];
  const schemaOk = evt
    && typeof evt.ts === 'string'
    && evt.tier_requested === 'T3_MID'
    && typeof evt.provider_chosen === 'string'
    && evt.success === true
    && Number.isFinite(evt.latency_ms)
    && Number.isFinite(evt.cost_cny);
  check('3 router event schema {ts, tier_requested, provider_chosen, latency_ms, success, cost_cny}',
    schemaOk, JSON.stringify(evt));
}

// ---------------------------------------------------------------------------
// 2. Within-capability provider failover (existing behavior, must not regress)
// ---------------------------------------------------------------------------
async function t2_within_cap_failover() {
  reset();
  PROVIDER_MOCK.failProviders.add('glm-direct'); // primary fails
  const env = await router.executeChat('T3_MID', {
    userId: 'u', tier: 'Pro', messages: [{ role: 'user', content: 'hi' }],
  });
  check('4 within-cap failover succeeds when 1 provider down',
    env && env.result === 'pong' && env.providerId !== 'glm-direct');
}

// ---------------------------------------------------------------------------
// 3. Cross-capability degradation: all T6 fail → T4 succeeds, envelope carries
//    fallback_path
// ---------------------------------------------------------------------------
async function t3_cross_cap_fallback() {
  reset();
  // T6_STRONG uses all 3 providers — fail all. T4 inherits same provider ids
  // but with different models. We selectively fail only on T6 by failing the
  // models that show up in T6's policy. Simpler: fail all providers entirely,
  // then unfail at T4 level by checking call.model. Use a model-based filter:
  const T6_MODELS = new Set(['glm-5.1', 'deepseek-v4-pro', 'kimi-k2.6']);
  // Re-wire providers temporarily to fail on T6 models only.
  const originalGet = providerMockFactory.getProvider;
  providerMockFactory.getProvider = function (id) {
    return {
      async chatWithUsage(args) {
        PROVIDER_MOCK.callLog.push({ id, model: args.model });
        if (T6_MODELS.has(args.model)) {
          const err = new Error(`mock ${id} 500 on T6 model ${args.model}`);
          err.status = 500;
          throw err;
        }
        return { content: 'pong-from-fallback', usage: { input_tokens: 5, output_tokens: 5 } };
      },
      async chat() { return 'pong'; },
    };
  };
  let env;
  try {
    env = await router.executeChat('T6_STRONG', {
      userId: 'u', tier: 'Pro', messages: [{ role: 'user', content: 'design lesson' }],
    });
  } finally {
    providerMockFactory.getProvider = originalGet;
  }
  check('5 cross-cap fallback returns envelope from weaker tier',
    env && env.result === 'pong-from-fallback');
  check('6 envelope.capability reflects served capability (T4 or T3, not T6)',
    env && env.capability !== 'T6_STRONG',
    `served=${env && env.capability}`);
  check('7 envelope.fallback_path is non-empty array',
    env && Array.isArray(env.fallback_path) && env.fallback_path.length >= 1,
    JSON.stringify(env && env.fallback_path));
  const events = fakeJSONL.get(router.ROUTER_EVENTS_REL) || [];
  const fallbackEvt = events.find(e => e.route_decision === 'cross-capability-fallback');
  check('8 router event with route_decision=cross-capability-fallback emitted',
    !!fallbackEvt, JSON.stringify(events.map(e => e.route_decision)));
}

// ---------------------------------------------------------------------------
// 4. Total exhaustion → event with success:false + LLMProviderError thrown
// ---------------------------------------------------------------------------
async function t4_exhausted_chain() {
  reset();
  // Fail every model across every capability.
  const originalGet = providerMockFactory.getProvider;
  providerMockFactory.getProvider = function (id) {
    return {
      async chatWithUsage() {
        const err = new Error('mock total failure');
        err.status = 500;
        throw err;
      },
      async chat() { throw new Error('mock'); },
    };
  };
  let thrown = null;
  try {
    await router.executeChat('T6_STRONG', {
      userId: 'u', tier: 'Pro', messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (e) { thrown = e; }
  finally {
    providerMockFactory.getProvider = originalGet;
  }
  check('9 exhausted chain throws LLMProviderError', thrown && /fallback chain failed/i.test(thrown.message));
  const events = fakeJSONL.get(router.ROUTER_EVENTS_REL) || [];
  const exhaustedEvt = events.find(e => e.success === false && e.route_decision === 'exhausted');
  check('10 router event with route_decision=exhausted + success:false emitted', !!exhaustedEvt);
}

// ---------------------------------------------------------------------------
// 5. Cashflow Shield three-tier gate transitions (90/100/110)
// ---------------------------------------------------------------------------
function t5_shield_gate_states() {
  // Mock vault.resolveRoot to point at our shim, and inject a fake profile so
  // resolveCachedTier returns 'pro'. Then write synthetic shield state to
  // verify gate_state classification.
  //
  // Simpler approach: call _stateFile path indirectly by writing JSON via the
  // shim. Even simpler: use the real shield with a real temp vault root.
  const fs = require('node:fs');
  const os = require('node:os');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hypha-infra-v2-'));
  // vault.js reads HYPHA_DATA, not HYPHA_VAULT_ROOT. Set both for compat with
  // any code that reads either. The tmp dir is empty → no profile.json → shield
  // falls through to caller-supplied tier. Without this, CI runners with no
  // vault/data/profile.json default to caller 'pro' = loyalty-engine ¥30/day,
  // while local devs with a profile.json may resolve to 'free' = ¥5/day. Test
  // values below are scaled to caller tier 'free' (¥5/day) deterministically.
  process.env.HYPHA_DATA = tmpRoot;
  process.env.HYPHA_VAULT_ROOT = tmpRoot;
  delete require.cache[VAULT_PATH];
  delete require.cache[SHIELD_PATH];
  const realVault = require(VAULT_PATH);
  const liveShield = require(SHIELD_PATH);

  function writeDailyState(userId, totalCostCny) {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const key = `${y}-${m}-${d}`;
    const dir = path.join(realVault.resolveRoot(), 'data', 'shield', 'daily');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${userId}-${key}.json`);
    fs.writeFileSync(f, JSON.stringify({
      user_id: userId, day: key, total_cost_cny: totalCostCny,
      soft_warn_emitted: false, last_call_ts: Date.now(),
    }, null, 2));
  }

  // Free tier daily cap = ¥5 (loyalty-engine TIER_DAILY_CAPS_CNY.free=5). Using
  // 'free' explicitly so cap is deterministic regardless of profile.json state.
  // Test values: 0.5 (OK), 4.6 (WARN_90 at 92%), 5.05 (SOFT_BLOCK_100 at 101%),
  // 5.6 (HARD_BLOCK_110 at 112%).
  writeDailyState('u1', 0.5);
  const s1 = liveShield.checkCashflowShield('u1', 'free');
  check('11 shield <90% → gate_state=OK', s1.gate_state === 'OK', `got ${s1.gate_state}`);

  writeDailyState('u2', 4.6);
  const s2 = liveShield.checkCashflowShield('u2', 'free');
  check('12 shield 92% → gate_state=WARN_90', s2.gate_state === 'WARN_90', `got ${s2.gate_state} today=${s2.today_cost_cny}`);

  writeDailyState('u3', 5.05);
  const s3 = liveShield.checkCashflowShield('u3', 'free');
  check('13 shield 101% → gate_state=SOFT_BLOCK_100', s3.gate_state === 'SOFT_BLOCK_100', `got ${s3.gate_state}`);

  writeDailyState('u4', 5.6);
  const s4 = liveShield.checkCashflowShield('u4', 'free');
  check('14 shield 112% → gate_state=HARD_BLOCK_110 (ok:false)',
    s4.gate_state === 'HARD_BLOCK_110' && s4.ok === false,
    `gate=${s4.gate_state} ok=${s4.ok}`);

  // 15: enforceShield at HARD_BLOCK_110 must throw even with BYOK fallback flag
  let hardErr = null;
  try {
    liveShield.enforceShield('u4', { tier: 'free', estimated_cost_cny: 0.1, byok_fallback: true });
  } catch (e) { hardErr = e; }
  check('15 enforceShield at 110% throws BudgetExceededError even with byok_fallback=true',
    hardErr && hardErr.name === 'BudgetExceededError'
      && (hardErr.details && (hardErr.details.reason === 'hard_ceiling' || /hard/.test(String(hardErr.message)))),
    hardErr ? `${hardErr.name} reason=${hardErr.details && hardErr.details.reason}` : 'no throw');

  // 16: enforceShield at SOFT_BLOCK_100 with byok_fallback=true → passes
  writeDailyState('u5', 5.03);
  let softOk = null;
  let softErr = null;
  try {
    softOk = liveShield.enforceShield('u5', { tier: 'free', estimated_cost_cny: 0.02, byok_fallback: true });
  } catch (e) { softErr = e; }
  check('16 enforceShield at 100% with byok_fallback=true passes',
    softOk && softOk.ok === true && !softErr,
    softErr ? String(softErr.message) : 'passed');

  // 17: same SOFT_BLOCK state WITHOUT byok_fallback → throws with byok_fallback_available
  let softNoFb = null;
  try {
    liveShield.enforceShield('u5', { tier: 'free', estimated_cost_cny: 0.02 });
  } catch (e) { softNoFb = e; }
  check('17 enforceShield at 100% without byok_fallback surfaces SOFT_BLOCK with byok_fallback_available',
    softNoFb && softNoFb.name === 'BudgetExceededError'
      && softNoFb.details && softNoFb.details.byok_fallback_available === true,
    softNoFb ? JSON.stringify(softNoFb.details) : 'no throw');

  // 18: getResetInfo returns valid midnight metadata
  const reset = liveShield.getResetInfo();
  const resetOk = reset && typeof reset.today_key === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(reset.today_key)
    && Number.isFinite(reset.next_reset_ms)
    && reset.next_reset_ms > Date.now()
    && Number.isFinite(reset.timezone_offset_min);
  check('18 getResetInfo returns {today_key, next_reset_ms, timezone_offset_min}', resetOk, JSON.stringify(reset));

  // Cleanup.
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  delete process.env.HYPHA_VAULT_ROOT;
  // Restore shim for downstream tests.
  delete require.cache[VAULT_PATH];
  injectMock(VAULT_PATH, vaultShim);
  delete require.cache[SHIELD_PATH];
}

// ---------------------------------------------------------------------------
// 6. Lifetime Ledger monthly rollup
// ---------------------------------------------------------------------------
async function t6_monthly_rollup() {
  fakeJSONL.clear();
  const slug = '__rollup__';
  // Seed 6 weekly entries: 4 in W18-W21 (April-May 2026), 2 in W22-W23 (May-June 2026).
  // 2026 Jan 4 is a Sunday → W01 Monday = Dec 29, 2025. Compute month accordingly.
  const entries = [
    { weekIso: '2026-W18', axis_counts: { learn: 10, practice: 50 } }, // ~late April
    { weekIso: '2026-W19', axis_counts: { learn: 12, practice: 60 } },
    { weekIso: '2026-W20', axis_counts: { learn: 15, practice: 80 } }, // May
    { weekIso: '2026-W21', axis_counts: { learn: 8,  practice: 70 } },
    { weekIso: '2026-W22', axis_counts: { learn: 20, practice: 100 } },
    { weekIso: '2026-W23', axis_counts: { learn: 25, practice: 90 } },
  ];
  for (const e of entries) {
    await ledger.appendEntry(slug, { ...e, linkIdx: 0 });
  }
  const rollup = await ledger.monthlyRollup(slug);
  const months = Object.keys(rollup.months);
  check('19 monthlyRollup returns months keyed YYYY-MM',
    months.length >= 1 && months.every(k => /^\d{4}-\d{2}$/.test(k)),
    JSON.stringify(months));
  // Sum check — total learn across all entries = 90, practice = 450
  const totalLearn = Object.values(rollup.months).reduce((s, m) => s + (m.axes.learn ? m.axes.learn.sum : 0), 0);
  const totalPractice = Object.values(rollup.months).reduce((s, m) => s + (m.axes.practice ? m.axes.practice.sum : 0), 0);
  check('20 monthlyRollup sum(learn) across months = 90', totalLearn === 90, `got ${totalLearn}`);
  check('21 monthlyRollup sum(practice) across months = 450', totalPractice === 450, `got ${totalPractice}`);
  // p95 sanity — must be >= avg, <= max
  const allOk = Object.values(rollup.months).every(m => {
    for (const axis of Object.keys(m.axes)) {
      const a = m.axes[axis];
      if (a.p95_per_week < a.avg_per_week) return false;
    }
    return true;
  });
  check('22 monthlyRollup p95 ≥ avg per axis per month', allOk);
}

// ---------------------------------------------------------------------------
// 7. Cost predictor preflightQuote
// ---------------------------------------------------------------------------
function t7_preflight_quote() {
  // Synthetic fixture: ~200 CJK char prompt → ~118 input tokens.
  // T3_MID rate: 0.005 input / 0.015 output. Output default 2000 = ¥0.03.
  // Input ¥0.0006. Total ~¥0.0306.
  const messages = [{ role: 'user', content: '帮我学习哲学基础'.repeat(20) }]; // ~140 CJK
  const q1 = predictor.preflightQuote({ messages, capability: 'T3_MID' });
  check('23 preflightQuote default factor returns predicted_cny + tokens + confidence',
    q1.ok && Number.isFinite(q1.predicted_cny) && Number.isFinite(q1.predicted_tokens) && typeof q1.confidence === 'string',
    JSON.stringify(q1));

  const q2 = predictor.preflightQuote({ messages, capability: 'T3_MID', generation_length_factor: 3.0 });
  check('24 preflightQuote factor=3.0 scales predicted_cny ~3x',
    q2.ok && q2.predicted_cny > q1.predicted_cny * 2.5 && q2.predicted_cny < q1.predicted_cny * 3.5,
    `q1=${q1.predicted_cny} q2=${q2.predicted_cny}`);

  const q3 = predictor.preflightQuote({ messages: [], capability: 'T6_STRONG' });
  check('25 preflightQuote handles empty messages',
    q3.ok && Number.isFinite(q3.predicted_cny));

  const q4 = predictor.preflightQuote({ messages, capability: 'T99_BOGUS' });
  check('26 preflightQuote rejects unknown capability', q4.ok === false);
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------
(async () => {
  console.log('[verify] HYPHA Infrastructure v2 smoke');
  console.log('---');
  await t1_happy_path_emits_event();
  await t2_within_cap_failover();
  await t3_cross_cap_fallback();
  await t4_exhausted_chain();
  t5_shield_gate_states();
  await t6_monthly_rollup();
  t7_preflight_quote();
  console.log('---');
  console.log(`Total: ${pass} pass, ${fail} fail`);
  if (router.stopRecoveryLoop) router.stopRecoveryLoop();
  if (fail > 0) {
    for (const f of failures) console.log(`  - ${f.label}: ${f.detail}`);
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => {
  console.error('[verify] uncaught:', e && e.stack || e);
  process.exit(1);
});
