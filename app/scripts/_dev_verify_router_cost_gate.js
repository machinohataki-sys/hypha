'use strict';

// HYPHA · P8 cost-gate router-integration smoke gate.
//
// Created 2026-05-19. Verifies that the cost predictor wired into
// app/lib/llm/router.js _w84PreCallGate enforces:
//   - WOULD_EXCEED_BUDGET → throws LLMProviderError (code=COST_BUDGET_EXCEEDED)
//     BEFORE any HTTP dispatch (provider must not be called)
//   - OK_BUT_NEAR_LIMIT → emits a single warn telemetry event, proceeds
//   - OK / NO_COST → silent proceed, no telemetry
//   - Predicted cost is attached to the return envelope
//   - Backward compat: shield.enforceShield still receives the estimated cost
//     (post-hoc recordCharge / recordLLMCall remain caller's responsibility)
//   - Predictor INVALID_CAPABILITY → graceful degrade, does NOT throw
//
// All providers and the W8.4 shield are mocked via require.cache injection
// so this verifier is pure-unit and runs offline (no API keys / no vault io).
//
// Run:  node app/scripts/_dev_verify_router_cost_gate.js
// Exit: 0 = all PASS, 1 = any FAIL.

const path = require('node:path');

// --------------------------------------------------------------------------
// Mock injection — must happen before router.js loads, so we resolve absolute
// paths and pre-populate require.cache with our stubs.
// --------------------------------------------------------------------------

const ROUTER_PATH = path.resolve(__dirname, '../lib/llm/router.js');
const SHIELD_PATH = path.resolve(__dirname, '../lib/cashflow-shield/shield.js');
const INDEX_PATH = path.resolve(__dirname, '../lib/llm/index.js');

// In-memory mock state — tests reset between cases.
const MOCK_STATE = {
  shield_remaining_cny: 5.0,
  shield_should_throw: false,
  provider_called_count: 0,
  provider_returns: { content: 'pong', usage: { input_tokens: 5, output_tokens: 5 } },
  recordCharge_called: false,
  recordCharge_amount: 0,
};

// Mock shield module. Mirrors the real surface (enforceShield + recordCharge +
// BudgetExceededError + checkCashflowShield) so router.js sees no difference.
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
  checkCashflowShield(_userId, tier = 'Pro') {
    return {
      ok: true,
      today_cost_cny: 0,
      remaining_cny: MOCK_STATE.shield_remaining_cny,
      limit_cny: 5,
      soft_warn: false,
      tier,
      requested_tier: tier,
      dev_mode: false,
    };
  },
  enforceShield(_userId, plannedCall = {}) {
    if (MOCK_STATE.shield_should_throw) {
      throw new MockBudgetExceededError('mock daily ceiling reached', {
        reason: 'daily_ceiling',
        planned: plannedCall,
      });
    }
    return {
      ok: true,
      shield: {
        ok: true,
        today_cost_cny: 0,
        remaining_cny: MOCK_STATE.shield_remaining_cny,
        limit_cny: 5,
        soft_warn: false,
        tier: plannedCall.tier || 'Pro',
      },
    };
  },
  recordCharge(_userId, costCny) {
    MOCK_STATE.recordCharge_called = true;
    MOCK_STATE.recordCharge_amount = costCny;
    return { total_cost_cny: costCny };
  },
  notifyExceedSoft() { return { emitted: false }; },
};

// Mock llm/index module. Provides getProvider() that hands back a fake
// provider with chatWithUsage that increments a call counter.
const providerMock = {
  async chatWithUsage(_args) {
    MOCK_STATE.provider_called_count += 1;
    return MOCK_STATE.provider_returns;
  },
  async chat(_args) {
    MOCK_STATE.provider_called_count += 1;
    return MOCK_STATE.provider_returns.content;
  },
};

const indexMock = {
  getProvider(_id) { return providerMock; },
  listProviders() { return ['glm-direct', 'deepseek-direct', 'kimi-direct']; },
};

// Inject mocks BEFORE requiring router.js.
function injectMock(absPath, exports) {
  require.cache[absPath] = {
    id: absPath,
    filename: absPath,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
}

injectMock(SHIELD_PATH, shieldMock);
injectMock(INDEX_PATH, indexMock);

// Sanity — ensure NODE_ENV=test so router doesn't start the recovery loop.
process.env.NODE_ENV = 'test';
process.env.HYPHA_LLM_NO_RECOVERY = '1';

// Now load router under test.
const router = require(ROUTER_PATH);

// Telemetry spy — collect cost-gate sink calls into an array per test.
let SINK_EVENTS = [];
router.setCostGateSink(function (level, payload) {
  SINK_EVENTS.push({ level, payload });
});

// --------------------------------------------------------------------------
// Test harness
// --------------------------------------------------------------------------

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

function resetState(overrides = {}) {
  MOCK_STATE.shield_remaining_cny = overrides.shield_remaining_cny ?? 5.0;
  MOCK_STATE.shield_should_throw = overrides.shield_should_throw ?? false;
  MOCK_STATE.provider_called_count = 0;
  MOCK_STATE.recordCharge_called = false;
  MOCK_STATE.recordCharge_amount = 0;
  SINK_EVENTS = [];
}

// --------------------------------------------------------------------------
// CG1 — happy path: small request → OK, dispatch proceeds, envelope carries
// predicted_cost + cost_gate.state === 'OK'
// --------------------------------------------------------------------------
async function cg1() {
  resetState({ shield_remaining_cny: 10.0 });
  const env = await router.executeChat('T3_MID', {
    userId: 'smoke-user',
    tier: 'Pro',
    slug: 'smoke-slug',
    lessonIdx: 0,
    messages: [{ role: 'user', content: 'pong' }],
    maxTokens: 200,
    temperature: 0,
  });
  const ok =
    env && env.result === 'pong'
    && MOCK_STATE.provider_called_count === 1
    && env.predicted_cost && Number.isFinite(env.predicted_cost.cny_est)
    && env.cost_gate && env.cost_gate.state === 'OK'
    && SINK_EVENTS.length === 0;
  check('CG1 happy path: small request → OK, envelope has predicted_cost',
    ok, JSON.stringify({ env_state: env && env.cost_gate, called: MOCK_STATE.provider_called_count, sink: SINK_EVENTS.length }));
}

// --------------------------------------------------------------------------
// CG2 — near-limit: large request close to remaining → OK_BUT_NEAR_LIMIT,
// dispatch proceeds, warn telemetry emitted exactly once
// --------------------------------------------------------------------------
async function cg2() {
  // T6_STRONG default output = 8000 tokens × 0.12 ¥/1k = ¥0.96
  // Set remaining = ¥1.00 → ratio = 0.96 → NEAR_LIMIT
  resetState({ shield_remaining_cny: 1.0 });
  const env = await router.executeChat('T6_STRONG', {
    userId: 'smoke-user',
    tier: 'Pro',
    messages: [{ role: 'user', content: 'pong' }],
    // Don't override maxTokens — let predictor use default 8000.
  });
  const ok =
    env && env.result === 'pong'
    && MOCK_STATE.provider_called_count === 1
    && env.cost_gate && env.cost_gate.state === 'OK_BUT_NEAR_LIMIT'
    && SINK_EVENTS.length === 1
    && SINK_EVENTS[0].level === 'warn'
    && SINK_EVENTS[0].payload.reason === 'OK_BUT_NEAR_LIMIT';
  check('CG2 near-limit: warn emitted, dispatch proceeds',
    ok, JSON.stringify({ env_state: env && env.cost_gate, sink: SINK_EVENTS, called: MOCK_STATE.provider_called_count }));
}

// --------------------------------------------------------------------------
// CG3 — hard block: predicted > remaining → COST_BUDGET_EXCEEDED thrown,
// provider NOT called
// --------------------------------------------------------------------------
async function cg3() {
  // T6_STRONG default output ≈ ¥0.96 — set remaining = ¥0.10 → block
  resetState({ shield_remaining_cny: 0.10 });
  let thrown = null;
  try {
    await router.executeChat('T6_STRONG', {
      userId: 'smoke-user',
      tier: 'Pro',
      messages: [{ role: 'user', content: 'pong' }],
    });
  } catch (e) {
    thrown = e;
  }
  const ok =
    thrown
    && thrown.code === 'COST_BUDGET_EXCEEDED'
    && Number.isFinite(thrown.predicted)
    && Number.isFinite(thrown.remaining)
    && typeof thrown.suggestion === 'string'
    && MOCK_STATE.provider_called_count === 0; // critical: NO HTTP dispatch
  check('CG3 hard block: COST_BUDGET_EXCEEDED thrown, provider not called',
    ok, JSON.stringify({
      code: thrown && thrown.code,
      predicted: thrown && thrown.predicted,
      remaining: thrown && thrown.remaining,
      called: MOCK_STATE.provider_called_count,
    }));
}

// --------------------------------------------------------------------------
// CG4 — backward compat: W8.4 BudgetExceededError still propagates from
// enforceShield. predictor does not swallow it. provider not called.
// --------------------------------------------------------------------------
async function cg4() {
  resetState({ shield_remaining_cny: 5.0, shield_should_throw: true });
  let thrown = null;
  try {
    await router.executeChat('T3_MID', {
      userId: 'smoke-user',
      tier: 'Pro',
      messages: [{ role: 'user', content: 'pong' }],
    });
  } catch (e) {
    thrown = e;
  }
  const ok =
    thrown
    && thrown.name === 'BudgetExceededError'
    && MOCK_STATE.provider_called_count === 0;
  check('CG4 backward compat: W8.4 BudgetExceededError still propagates',
    ok, JSON.stringify({ name: thrown && thrown.name, called: MOCK_STATE.provider_called_count }));
}

// --------------------------------------------------------------------------
// CG5 — graceful degrade: invalid capability passed → predictor returns
// INVALID, but router itself still rejects via DISPATCH_POLICY check.
// We verify the gate does NOT throw COST_BUDGET_EXCEEDED on predictor
// INVALID_CAPABILITY (it should fall through, letting executeChat raise
// the canonical "Unknown capability" error).
// --------------------------------------------------------------------------
async function cg5() {
  resetState({ shield_remaining_cny: 5.0 });
  let thrown = null;
  try {
    await router.executeChat('T99_BOGUS', {
      userId: 'smoke-user',
      tier: 'Pro',
      messages: [{ role: 'user', content: 'pong' }],
    });
  } catch (e) {
    thrown = e;
  }
  // Expect: LLMProviderError "Unknown capability T99_BOGUS" — NOT
  // COST_BUDGET_EXCEEDED.
  const ok =
    thrown
    && /Unknown capability/i.test(thrown.message)
    && thrown.code !== 'COST_BUDGET_EXCEEDED'
    && MOCK_STATE.provider_called_count === 0;
  check('CG5 invalid capability: graceful degrade (no COST_BUDGET_EXCEEDED)',
    ok, JSON.stringify({ msg: thrown && thrown.message, code: thrown && thrown.code }));
}

// --------------------------------------------------------------------------
// CG6 — no userId path: predictor still runs (envelope has predicted_cost),
// but gate is skipped + no throw (router used by smoke tests / scratch).
// --------------------------------------------------------------------------
async function cg6() {
  resetState({ shield_remaining_cny: 0.01 }); // would block if userId set
  const env = await router.executeChat('T3_MID', {
    // NO userId
    messages: [{ role: 'user', content: 'pong' }],
  });
  const ok =
    env && env.result === 'pong'
    && MOCK_STATE.provider_called_count === 1
    && env.predicted_cost && Number.isFinite(env.predicted_cost.cny_est)
    && env.cost_gate
    && (env.cost_gate.state === 'PREDICTED_NO_GATE' || env.cost_gate.state === 'SKIPPED');
  check('CG6 no userId: predictor runs for telemetry, gate skipped',
    ok, JSON.stringify({ env_state: env && env.cost_gate, called: MOCK_STATE.provider_called_count }));
}

// --------------------------------------------------------------------------
// Run all tests
// --------------------------------------------------------------------------
async function main() {
  console.log('[verify] P8 cost-gate router integration smoke');
  console.log('[verify] mocks: shield + llm/index injected via require.cache');
  console.log('---');

  await cg1();
  await cg2();
  await cg3();
  await cg4();
  await cg5();
  await cg6();

  console.log('---');
  console.log(`Total: ${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f.label}: ${f.detail}`);
    process.exit(1);
  }
  // Tear down recovery loop if any test path started it (defensive).
  if (router.stopRecoveryLoop) router.stopRecoveryLoop();
  process.exit(0);
}

main().catch((err) => {
  console.error('[verify] uncaught error:', err && err.stack || err);
  process.exit(1);
});
