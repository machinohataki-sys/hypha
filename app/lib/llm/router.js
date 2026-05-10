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
    { providerId: 'deepseek-direct', model: 'deepseek-v4-flash', weight: 30 },
    // T3 has only 2 providers — Kimi reserved for T6/T4 (long-context niche)
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

async function executeChat(capability, chatArgs) {
  const policy = DISPATCH_POLICY[capability];
  if (!policy) throw new LLMProviderError(`Unknown capability "${capability}"`);
  const tried = [];
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
      // Auth/registration error — can't retry same provider, exclude permanently for this call
      tried.push(pick.providerId);
      lastErr = e;
      continue;
    }
    try {
      const result = await provider.chat({ ...chatArgs, model: pick.model });
      markSuccess(pick.providerId);
      return {
        result,
        providerId: pick.providerId,
        model: pick.model,
        capability,
        attempts: attempt + 1,
      };
    } catch (e) {
      markError(pick.providerId, e);
      const status = e?.status || e?.cause?.status;
      if (status === 429) {
        markRateLimit(pick.providerId, _parseRetryAfter(e?.cause || e));
      }
      tried.push(pick.providerId);
      lastErr = e;
    }
  }
  throw new LLMProviderError(
    `All providers in ${capability} failed (${tried.join(', ')}). Last: ${lastErr?.message || 'unknown'}`,
    lastErr,
  );
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
};
