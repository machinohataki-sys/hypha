'use strict';
// HYPHA · LLM router — DispatchPolicy + ProviderHealth + executeChat
// Phase D 2026-05-08
//
// Builds on Phase B/C capability-class registry. Phase C did auth-time
// fallback (key missing → next entry). Phase D adds runtime fallback:
//   - Weighted random dispatch (60/30/10 across T6 across GLM/DeepSeek/Kimi)
//   - Provider health monitor (90s/3 errors → degraded; 5min ping → recovery)
//   - executeChat() main entry: tries up to 3 providers, retries on 5xx/timeout/429
//
// Backward compat: getCapabilityModel() in index.js stays unchanged.
// Callers opt into runtime fallback by switching to executeChat().
//
// Circular-require note: router.js late-requires './index' inside functions
// (never at top level) so that index.js can append router exports back at the
// end of its own initialization without bootstrapping issues.

const { LLMProviderError } = require('./provider');

// v1.0 Infra v2 (2026-05-20) — cross-capability degradation chain. On full
// exhaustion of a capability's provider pool we step DOWN one tier (T6→T4→T3)
// before declaring failure. The Anti-Slop layer reads `fallback_path` off the
// envelope so reviewers can see when a lesson body was produced at a weaker
// capability than requested. Per S69 5-layer observability (Scout 2026-05-14):
// every degradation emits one jsonl line to vault/.hypha/router-events.jsonl.
const DEGRADATION_CHAIN = Object.freeze({
  T6_STRONG: 'T4_JUDGE',
  T4_JUDGE:  'T3_MID',
  T3_MID:    null,
  T2_LOCAL:  null,
});

const ROUTER_EVENTS_REL = '.hypha/router-events.jsonl';

function _emitRouterEvent(event) {
  // Best-effort — telemetry must never crash a paying user's lesson. Vault
  // require is late so unit tests that inject mocks via require.cache for
  // shield/index still observe a writable surface.
  try {
    const vault = require('../vault');
    if (typeof vault.appendJSONL === 'function') {
      vault.appendJSONL(ROUTER_EVENTS_REL, event);
    }
  } catch (_) {}
}

const DISPATCH_POLICY = {
  T6_STRONG: [
    { providerId: 'glm-direct',      model: 'glm-5.1',           weight: 60 },
    { providerId: 'deepseek-direct', model: 'deepseek-v4-pro',   weight: 30 },
    { providerId: 'kimi-direct',     model: 'kimi-k2.6',         weight: 10 },
  ],
  T4_JUDGE: [
    { providerId: 'glm-direct',      model: 'glm-4.5-air',       weight: 60 },
    { providerId: 'deepseek-direct', model: 'deepseek-v4-flash', weight: 30 },
    { providerId: 'kimi-direct',     model: 'kimi-k2.6',         weight: 10 },
  ],
  T3_MID: [
    { providerId: 'glm-direct',      model: 'glm-4.5-air',       weight: 70 },
    { providerId: 'deepseek-direct', model: 'deepseek-v4-flash' , weight: 30 },
    // T3 has only 2 providers — Kimi reserved for T6/T4 (long-context niche)
  ],
  // v1.0 boot-9 (2026-05-20) — T2_LOCAL capability registered with cloud
  // fallback. The local-model bridge (`../companion/local-model`) returns
  // LOCAL_MODEL_NOT_READY in v1.0 (T2_LOCAL_AVAILABLE=false), so every
  // T2_LOCAL request transparently falls through to the T3_MID cloud chain.
  // v1.1+ flips the local capability and the cloud entries become the
  // fallback, not the default. Callers see the same API surface either way.
  T2_LOCAL: [
    { providerId: 'glm-direct',      model: 'glm-4.5-air',       weight: 70 },
    { providerId: 'deepseek-direct', model: 'deepseek-v4-flash', weight: 30 },
  ],
};

const HEALTH = new Map();
const ERROR_WINDOW_MS = 90_000;
const ERROR_THRESHOLD = 3;
const RATE_LIMIT_THRESHOLD_S = 60;
const RECOVERY_INTERVAL_MS = 5 * 60_000;
const RECOVERY_PING_TIMEOUT_MS = 10_000;
// DeepSeek V4 + GLM 5-series + Kimi K2.6 spend reasoning tokens before content
// tokens — a 5-token ping returns empty content. Kimi K2.6 reasoning observed
// to use 30-50 tokens per "pong" exchange, so 200 leaves margin without paying
// real cost (<¥0.0002/ping). Bump upward only if a future model burns more.
const RECOVERY_PING_MAX_TOKENS = 200;

function _record(id) {
  let r = HEALTH.get(id);
  if (!r) {
    r = {
      errorCount: 0,
      errorWindow: [],
      last429At: null,
      retryAfterUntil: null,
      lastSuccessAt: Date.now(),
      state: 'healthy',
      lastPingAt: null,
    };
    HEALTH.set(id, r);
  }
  return r;
}

function _pruneErrors(rec, now = Date.now()) {
  rec.errorWindow = rec.errorWindow.filter((t) => now - t < ERROR_WINDOW_MS);
}

function markSuccess(providerId) {
  const r = _record(providerId);
  r.errorWindow = [];
  r.errorCount = 0;
  r.retryAfterUntil = null;
  r.last429At = null;
  r.lastSuccessAt = Date.now();
  r.state = 'healthy';
}

function markError(providerId, _err) {
  const r = _record(providerId);
  const now = Date.now();
  r.errorWindow.push(now);
  _pruneErrors(r, now);
  r.errorCount = r.errorWindow.length;
  if (r.errorCount >= ERROR_THRESHOLD) {
    r.state = 'degraded';
  }
}

function markRateLimit(providerId, retryAfterSec) {
  const r = _record(providerId);
  if (retryAfterSec > RATE_LIMIT_THRESHOLD_S) {
    r.last429At = Date.now();
    r.retryAfterUntil = Date.now() + retryAfterSec * 1000;
    r.state = 'degraded';
  }
}

function getState(providerId) {
  return _record(providerId).state;
}

function getReport() {
  const out = {};
  const now = Date.now();
  // Include all DISPATCH_POLICY providers, even those never called yet
  const seenIds = new Set();
  for (const policy of Object.values(DISPATCH_POLICY)) {
    for (const entry of policy) seenIds.add(entry.providerId);
  }
  for (const id of seenIds) {
    const r = _record(id);
    out[id] = {
      state: r.state,
      errorCount: r.errorCount,
      lastSuccessAt: r.lastSuccessAt,
      lastSuccessAgoMs: now - r.lastSuccessAt,
      retryAfterUntil: r.retryAfterUntil,
      lastPingAt: r.lastPingAt,
    };
  }
  return out;
}

function _parseRetryAfter(err) {
  if (!err) return 0;
  const h = err.headers || (err.response && err.response.headers) || {};
  const v = h['retry-after'] || h['Retry-After'];
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function pickWeighted(capability, exclude = []) {
  const policy = DISPATCH_POLICY[capability];
  if (!policy) {
    throw new LLMProviderError(`Unknown capability "${capability}"`);
  }
  const eligible = policy.filter((p) => {
    if (exclude.includes(p.providerId)) return false;
    const state = getState(p.providerId);
    return state === 'healthy' || state === 'recovering';
  });
  if (eligible.length === 0) {
    // All degraded or excluded — try any non-excluded as last-ditch
    const lastDitch = policy.filter((p) => !exclude.includes(p.providerId));
    if (lastDitch.length === 0) return null;
    return lastDitch[0];
  }
  const total = eligible.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of eligible) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return eligible[eligible.length - 1];
}

// W5.1 Cheap Router opt-in hook. Default OFF — callers that pass
// `chatArgs.prefer_cheap = true` (and supply `chatArgs.cheap_task` + a small
// `cheap_input` payload) get a chance for the request to be served by the
// T0/T1/T2 cheap pipeline instead of a T3+ cloud LLM. If the cheap pass
// declares `needs_escalation:true`, we fall through to the normal executeChat
// flow below. Never throws — any error in the cheap path falls through.
async function _routeCheapFirst(capability, chatArgs) {
  if (!chatArgs || chatArgs.prefer_cheap !== true) return null;
  if (capability !== 'T3_MID' && capability !== 'T4_JUDGE') return null;
  const task = chatArgs.cheap_task;
  const input = chatArgs.cheap_input;
  if (!task || !input) return null;
  try {
    const cheap = require('./cheap-router');
    const out = await cheap.runCheapTask(task, input, chatArgs.cheap_options || {});
    if (out && out.needs_escalation) return null; // fall through to cloud
    return {
      result: out.result,
      usage: null,
      _requestMessages: chatArgs.messages || null,
      providerId: 'cheap-router',
      model: out.capability,
      capability,
      attempts: 0,
      cheap_rationale: out.rationale,
    };
  } catch (_e) {
    return null; // any failure → fall through to cloud LLM, never block
  }
}

// P8 cost-gate signal sink (telemetry stub). Tests can override via
// `setCostGateSink(fn)` to spy on NEAR_LIMIT warnings without coupling to
// console output. Default = console.warn passthrough.
let _costGateSink = function defaultCostGateSink(level, payload) {
  // Use stderr-friendly channel; never throw out of telemetry.
  try {
    if (level === 'warn') {
      console.warn('[cost-gate]', payload && payload.reason, JSON.stringify(payload || {}));
    }
  } catch (_) { /* swallow */ }
};

function setCostGateSink(fn) {
  _costGateSink = (typeof fn === 'function') ? fn : _costGateSink;
}

// W8.4 + P8 pre-call gate.
//
// Two layers stacked, both opt-in:
//   1. Cost predictor (P8, 2026-05-19) — auto-estimates ¥ before HTTP dispatch.
//      Hard-blocks WOULD_EXCEED_BUDGET against the shield's remaining budget.
//      Soft-warns NEAR_LIMIT via _costGateSink. Always returns predicted cost
//      so the caller can thread it into the return envelope.
//   2. W8.4 cashflow shield — daily ¥ ceiling + per-lesson call cap.
//      Already shipped; we just feed it the freshly-computed estimate so it
//      doesn't have to trust caller-supplied `estimated_cost_cny`.
//
// Post-hoc `recordLLMCall` / `recordCharge` (main.js:11369, shield.recordCharge)
// stay untouched — predictor is a *supplement*, not a replacement.
//
// Returns `{ predicted_cost, gate_state, gate_reason }` so executeChat can
// attach it to the call's audit trail. Never throws on internal predictor
// failure — falls back to caller-supplied estimate (or 0) on error.
function _w84PreCallGate(capability, chatArgs) {
  const out = { predicted_cost: null, gate_state: 'SKIPPED', gate_reason: null };
  if (!chatArgs) return out;

  // Step 1 — predict cost. Safe even without userId (telemetry value).
  let predictedCny = Number(chatArgs.estimated_cost_cny);
  if (!Number.isFinite(predictedCny) || predictedCny < 0) predictedCny = 0;
  try {
    if (Array.isArray(chatArgs.messages) && chatArgs.messages.length > 0) {
      const predictor = require('./cost-predictor');
      const p = predictor.predictCost(chatArgs.messages, capability, {
        maxOutputTokens: Number(chatArgs.maxTokens) || undefined,
      });
      if (p && p.ok && p.estimate && Number.isFinite(p.estimate.cny_est)) {
        // Predictor wins over caller-supplied estimate when both present
        // (caller can override by passing a higher estimated_cost_cny —
        // we take the larger of the two so neither side under-counts).
        predictedCny = Math.max(predictedCny, p.estimate.cny_est);
        out.predicted_cost = {
          cny_est: p.estimate.cny_est,
          input_tokens_est: p.estimate.input_tokens_est,
          output_tokens_max: p.estimate.output_tokens_max,
          capability: p.estimate.capability,
          estimation_source: p.estimate.estimation_source,
        };
      } else if (p && p.ok === false) {
        out.gate_state = 'INVALID';
        out.gate_reason = p.error || 'PREDICT_FAILED';
        // INVALID_CAPABILITY → predictor refused; fall through to shield
        // (which has its own tier validation) without raising here.
      }
    }
  } catch (_e) {
    // Predictor unavailable → graceful degrade. Shield still runs.
  }

  // Step 2 — W8.4 shield (daily ceiling + per-lesson cap). Only when userId
  // is present (router is also called by smoke tests / scratch paths that
  // don't have a user context).
  if (chatArgs.userId) {
    try {
      const shield = require('../cashflow-shield/shield');
      const gateResult = shield.enforceShield(chatArgs.userId, {
        tier: chatArgs.tier || 'Pro', slug: chatArgs.slug,
        lessonIdx: chatArgs.lessonIdx, capability,
        estimated_cost_cny: predictedCny,
      });

      // Step 3 — predictor gate against shield's remaining budget.
      // Hard-block if predicted > remaining; soft-warn if near limit.
      // v1.0 boot-8: BYOK / unlimited tier returns remaining_cny = null +
      // unlimited = true from shield. Short-circuit to OK without invoking
      // gateAgainstBudget (which would treat null → 0 → block every call).
      if (gateResult && gateResult.shield && gateResult.shield.unlimited === true) {
        out.gate_state = 'OK_UNLIMITED';
        out.gate_reason = 'UNLIMITED_TIER';
      } else if (predictedCny > 0 && gateResult && gateResult.shield) {
        const predictor = require('./cost-predictor');
        const remaining = Number(gateResult.shield.remaining_cny);
        const gate = predictor.gateAgainstBudget(predictedCny, remaining);
        out.gate_state = gate.reason || (gate.allowed ? 'OK' : 'BLOCKED');
        out.gate_reason = gate.reason;
        if (gate.reason === 'WOULD_EXCEED_BUDGET' || gate.reason === 'BUDGET_EXHAUSTED') {
          // Convert to LLMProviderError with a structured code so callers
          // can present a UI-friendly toast (per spec — surface as
          // COST_BUDGET_EXCEEDED, distinct from W8.4's BUDGET_EXCEEDED).
          const err = new LLMProviderError(
            `cost predictor blocked dispatch — predicted ¥${predictedCny.toFixed(4)} > remaining ¥${(Number.isFinite(remaining) ? remaining : 0).toFixed(4)}`,
          );
          err.code = 'COST_BUDGET_EXCEEDED';
          err.predicted = predictedCny;
          err.remaining = Number.isFinite(remaining) ? remaining : 0;
          err.suggestion = '降级 cheap_quick 或 提升每日预算';
          throw err;
        }
        if (gate.reason === 'OK_BUT_NEAR_LIMIT') {
          _costGateSink('warn', {
            reason: 'OK_BUT_NEAR_LIMIT',
            predicted_cny: predictedCny,
            remaining_cny: remaining,
            ratio: gate.ratio,
            capability,
            slug: chatArgs.slug || null,
            userId: chatArgs.userId || null,
          });
        }
      } else if (!out.gate_state || out.gate_state === 'SKIPPED') {
        out.gate_state = 'NO_COST';
        out.gate_reason = 'NO_COST';
      }
    } catch (e) {
      // LLMProviderError with code COST_BUDGET_EXCEEDED → propagate.
      if (e && e.code === 'COST_BUDGET_EXCEEDED') throw e;
      // BudgetExceededError from W8.4 → propagate (existing contract).
      if (e && e.name === 'BudgetExceededError') throw e;
      // Anything else (filesystem hiccup, predictor internal) → swallow,
      // we never want telemetry/budget code to crash a paying user's lesson.
    }
  } else {
    // No userId — predictor still ran for telemetry, but no gating possible.
    if (!out.gate_state || out.gate_state === 'SKIPPED') {
      out.gate_state = out.predicted_cost ? 'PREDICTED_NO_GATE' : 'SKIPPED';
    }
  }

  return out;
}

// v1.0 boot-9 — T2_LOCAL local-first dispatch.
// Tries the companion/local-model bridge once. If it throws
// LOCAL_MODEL_NOT_READY (which is the v1.0 contract for every call), we
// return null and the caller continues with the cloud chain. Any other
// throw is also swallowed → cloud fallback stays the safe path.
async function _routeLocalFirst(capability, chatArgs) {
  if (capability !== 'T2_LOCAL') return null;
  if (!chatArgs || !Array.isArray(chatArgs.messages) || chatArgs.messages.length === 0) return null;
  try {
    const local = require('../companion/local-model');
    if (local.T2_LOCAL_AVAILABLE !== true) return null; // v1.0: always cloud
    // Inline prompt assembly — keep it minimal; v1.1+ may add system/user roles.
    const prompt = chatArgs.messages
      .map((m) => (m && typeof m.content === 'string') ? m.content : '')
      .filter(Boolean)
      .join('\n');
    const result = await local.generateLocal({
      prompt,
      max_tokens:  Number.isFinite(chatArgs.maxTokens) ? chatArgs.maxTokens : 200,
      temperature: Number.isFinite(chatArgs.temperature) ? chatArgs.temperature : undefined,
    });
    return {
      result:    result.text,
      usage:     { input_tokens: 0, output_tokens: result.tokens_used || 0 },
      _requestMessages: chatArgs.messages || null,
      providerId: 'local-gemma',
      model:     result.model_name,
      capability,
      attempts:  1,
      latency_ms: result.latency_ms,
    };
  } catch (_e) {
    return null; // any failure → cloud fallback (transparent to user)
  }
}

async function _attemptCapability(capability, chatArgs) {
  // Returns { envelope, errorTrace, tried, lastErr } — envelope is null when
  // every provider in this capability's pool exhausted retries.
  const policy = DISPATCH_POLICY[capability];
  if (!policy) {
    throw new LLMProviderError(`Unknown capability "${capability}"`);
  }
  const tried = [];
  const errorTrace = [];
  let lastErr = null;
  const maxAttempts = Math.min(3, policy.length);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pick = pickWeighted(capability, tried);
    if (!pick) break;
    let provider;
    try {
      const llm = require('./index');
      provider = llm.getProvider(pick.providerId);
    } catch (e) {
      tried.push(pick.providerId);
      errorTrace.push(`${pick.providerId}(${pick.model}): ${e.message || 'unknown'}`);
      lastErr = e;
      continue;
    }
    const tAttempt = Date.now();
    try {
      const { content, usage } = await provider.chatWithUsage({ ...chatArgs, model: pick.model });
      markSuccess(pick.providerId);
      const envelope = {
        result: content,
        usage: usage || null,
        _requestMessages: chatArgs && chatArgs.messages ? chatArgs.messages : null,
        providerId: pick.providerId,
        model: pick.model,
        capability,
        attempts: attempt + 1,
        latency_ms: Date.now() - tAttempt,
      };
      return { envelope, errorTrace, tried, lastErr: null };
    } catch (e) {
      markError(pick.providerId, e);
      const status = e?.status || e?.cause?.status;
      if (status === 429) {
        markRateLimit(pick.providerId, _parseRetryAfter(e?.cause || e));
      }
      tried.push(pick.providerId);
      errorTrace.push(`${pick.providerId}(${pick.model}): ${e.message || 'unknown'}`);
      lastErr = e;
    }
  }
  return { envelope: null, errorTrace, tried, lastErr };
}

async function executeChat(capability, chatArgs) {
  const gate = _w84PreCallGate(capability, chatArgs);
  const tStart = Date.now();
  const requested = capability;
  // v1.0 boot-9 — local-first dispatch for T2_LOCAL. No-op in v1.0 since
  // T2_LOCAL_AVAILABLE=false; v1.1+ this returns a real envelope before the
  // cloud chain runs.
  const localEnvelope = await _routeLocalFirst(capability, chatArgs);
  if (localEnvelope) {
    if (gate && gate.predicted_cost) localEnvelope.predicted_cost = gate.predicted_cost;
    if (gate) localEnvelope.cost_gate = { state: gate.gate_state, reason: gate.gate_reason };
    _emitRouterEvent(_buildRouterEvent({
      tier_requested: requested, capability_served: capability,
      provider_chosen: localEnvelope.providerId, fallback_path: null,
      latency_ms: Date.now() - tStart, success: true,
      cost_cny: gate && gate.predicted_cost ? gate.predicted_cost.cny_est : 0,
      route_decision: 'local-first',
    }));
    return localEnvelope;
  }
  const cheapEnvelope = await _routeCheapFirst(capability, chatArgs);
  if (cheapEnvelope) {
    if (gate && gate.predicted_cost) cheapEnvelope.predicted_cost = gate.predicted_cost;
    if (gate) cheapEnvelope.cost_gate = { state: gate.gate_state, reason: gate.gate_reason };
    _emitRouterEvent(_buildRouterEvent({
      tier_requested: requested, capability_served: capability,
      provider_chosen: cheapEnvelope.providerId, fallback_path: null,
      latency_ms: Date.now() - tStart, success: true,
      cost_cny: gate && gate.predicted_cost ? gate.predicted_cost.cny_est : 0,
      route_decision: 'cheap-first',
    }));
    return cheapEnvelope;
  }

  // Cross-capability degradation chain. T6 fully exhausted → step to T4 → T3
  // before raising. Each step appends to fallback_path for the audit envelope.
  const fallbackPath = [];
  const aggregatedErrors = [];
  let current = capability;
  let attempt = await _attemptCapability(current, chatArgs);
  while (!attempt.envelope) {
    aggregatedErrors.push(`[${current}] ${attempt.errorTrace.join(' | ')}`);
    fallbackPath.push({ capability: current, tried: attempt.tried.slice(), error: attempt.lastErr && attempt.lastErr.message });
    const next = DEGRADATION_CHAIN[current];
    if (!next) break;
    current = next;
    attempt = await _attemptCapability(current, chatArgs);
  }
  if (attempt.envelope) {
    const env = attempt.envelope;
    if (fallbackPath.length > 0) env.fallback_path = fallbackPath;
    if (gate && gate.predicted_cost) env.predicted_cost = gate.predicted_cost;
    if (gate) env.cost_gate = { state: gate.gate_state, reason: gate.gate_reason };
    _emitRouterEvent(_buildRouterEvent({
      tier_requested: requested, capability_served: current,
      provider_chosen: env.providerId, fallback_path: fallbackPath.length ? fallbackPath : null,
      latency_ms: Date.now() - tStart, success: true,
      cost_cny: gate && gate.predicted_cost ? gate.predicted_cost.cny_est : 0,
      route_decision: fallbackPath.length ? 'cross-capability-fallback' : 'primary',
    }));
    return env;
  }
  try {
    const t = require('../telemetry/local-tracker');
    t.recordError({
      code: 'llm_all_providers_failed',
      severity: 'error',
      message: `capability=${requested} exhausted including fallback chain`,
      stack: attempt.lastErr && attempt.lastErr.stack,
      context: { capability: requested, fallback_path: fallbackPath, errors: aggregatedErrors },
    });
  } catch (_) {}
  _emitRouterEvent(_buildRouterEvent({
    tier_requested: requested, capability_served: current,
    provider_chosen: null, fallback_path: fallbackPath,
    latency_ms: Date.now() - tStart, success: false, cost_cny: 0,
    route_decision: 'exhausted',
  }));
  throw new LLMProviderError(
    `All providers in fallback chain failed.\n  ${aggregatedErrors.join('\n  ')}`,
    attempt.lastErr,
  );
}

function _buildRouterEvent(e) {
  return {
    ts: new Date().toISOString(),
    route_decision: e.route_decision || null,
    tier_requested: e.tier_requested,
    capability_served: e.capability_served,
    provider_chosen: e.provider_chosen,
    fallback_path: e.fallback_path,
    latency_ms: e.latency_ms,
    success: !!e.success,
    cost_cny: Number.isFinite(e.cost_cny) ? Number(Number(e.cost_cny).toFixed(6)) : 0,
  };
}

let _recoveryTimer = null;

async function _recoveryTick() {
  for (const [id, rec] of HEALTH) {
    if (rec.state !== 'degraded') continue;
    if (rec.retryAfterUntil && Date.now() < rec.retryAfterUntil) continue;
    rec.state = 'recovering';
    rec.lastPingAt = Date.now();
    try {
      const llm = require('./index');
      const provider = llm.getProvider(id);
      await provider.chat({
        messages: [{ role: 'user', content: 'pong' }],
        maxTokens: RECOVERY_PING_MAX_TOKENS,
        timeoutMs: RECOVERY_PING_TIMEOUT_MS,
      });
      markSuccess(id);
    } catch (_e) {
      rec.state = 'degraded';
    }
  }
}

function startRecoveryLoop() {
  if (_recoveryTimer) return;
  _recoveryTimer = setInterval(_recoveryTick, RECOVERY_INTERVAL_MS);
  if (_recoveryTimer.unref) _recoveryTimer.unref();
}

function stopRecoveryLoop() {
  if (_recoveryTimer) {
    clearInterval(_recoveryTimer);
    _recoveryTimer = null;
  }
}

// Auto-start in non-test environments. Tests can call stopRecoveryLoop().
if (process.env.NODE_ENV !== 'test' && !process.env.HYPHA_LLM_NO_RECOVERY) {
  startRecoveryLoop();
}

module.exports = {
  DISPATCH_POLICY,
  DEGRADATION_CHAIN,
  ROUTER_EVENTS_REL,
  executeChat,
  pickWeighted,
  markSuccess,
  markError,
  markRateLimit,
  getState,
  getReport,
  startRecoveryLoop,
  stopRecoveryLoop,
  _recoveryTick,
  _attemptCapability,
  _buildRouterEvent,
  // P8 cost-gate test seam (allow smoke to spy on NEAR_LIMIT warnings)
  setCostGateSink,
  _w84PreCallGate,
};
