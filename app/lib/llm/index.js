'use strict';
// HYPHA · LLM provider selector + Cheap Intelligence Router (per BLUEPRINT §17.2 + AMD-MEOW-P4)
//
// Single entry point for the rest of the codebase. Lesson generator, scoring,
// feedback — import getProvider() (backward compat) OR getCapabilityModel(cap)
// (capability-class routing). Either way, callers don't care which provider
// backs which capability.
//
// Capability classes (per BLUEPRINT §17.2.1 7-tier):
//   T6_STRONG  — Lesson Plan + Body / Cross-Spark (heavy reasoner)
//   T5_PACK    — Context Packer (algorithmic, ! LLM v0.1-v0.5)
//   T4_JUDGE   — Quality Harness Micro Judges (3-4 axis 并行)
//   T3_MID     — Pack 初筛 / Drift 二审 / Misconception
//   T2_LOCAL   — Companion v0.8+ / 节奏提醒 (本地 Ollama, deferred)
//   T1_EMBED   — Note 路由 / 检索 / 去重 (本地 BGE-M3, deferred)
//
// Phase B (2026-05-08): capability registry shipped, GLM-only providers populated.
// Phase C (post user keys): DeepSeek + Kimi + MiMo cloud providers added.
// Phase D-E (post infra): T2_LOCAL Ollama + T1_EMBED local embedding server.
// Phase F (post-壮大): Western 3 BYOK path (Claude / Gemini / GPT).

const { GLMDirect } = require('./glm-direct');
const { DeepSeekDirect } = require('./deepseek-direct');
const { KimiDirect } = require('./kimi-direct');
const { LLMProvider, LLMTimeoutError, LLMAuthError, LLMProviderError } = require('./provider');

const PROVIDERS = {
  'glm-direct':      GLMDirect,
  'deepseek-direct': DeepSeekDirect,   // Phase C 2026-05-08 (needs DEEPSEEK_API_KEY env)
  'kimi-direct':     KimiDirect,       // Phase C 2026-05-08 (needs KIMI_API_KEY env)
  // 'gemma-local':   GemmaLocalOllama,  // Phase D-E (Ollama runtime needed)
  // 'bge-embed':     BGE_M3_Local,      // Phase D-E (embedding server needed)
  // 'hypha-relay':   HYPHARelay,        // v1.0+ relay-backed BYOK
};

// Capability registry — ordered (provider, model) tuples per capability.
// First entry = default; subsequent = fallback chain (per AMD-MEOW-P4 §17.2.2).
// getCapabilityModel() iterates and returns the first usable provider.
const CAPABILITY_REGISTRY = {
  T6_STRONG: [
    { provider: 'glm-direct',      model: 'glm-5.1'           },  // default (already wired)
    { provider: 'deepseek-direct', model: 'deepseek-v4-pro'   },  // Phase C
    { provider: 'kimi-direct',     model: 'kimi-k2.6'         },  // Phase C
  ],
  T4_JUDGE: [
    { provider: 'glm-direct',      model: 'glm-4.5-air'       },  // default
    { provider: 'deepseek-direct', model: 'deepseek-v4-flash' },  // Phase C
    { provider: 'kimi-direct',     model: 'kimi-k2.6'         },  // Phase C
  ],
  T3_MID: [
    { provider: 'glm-direct',      model: 'glm-4.5-air'       },  // default (per user 2026-05-08, Qwen API not used)
    { provider: 'deepseek-direct', model: 'deepseek-v4-flash' },  // Phase C
    { provider: 'kimi-direct',     model: 'kimi-k2.6'         },  // Phase C
  ],
  // T5_PACK / T2_LOCAL / T1_EMBED: deferred (algorithmic OR local Ollama not yet integrated)
};

let _cached = null;
let _cachedKey = null;

/**
 * Returns a singleton provider instance. Pass {fresh:true} to bypass cache.
 * @param {string} [name] — defaults to env HYPHA_LLM_PROVIDER or "glm-direct"
 * @param {object} [opts] — passed to the provider constructor
 */
function getProvider(name, opts = {}) {
  const id = name || process.env.HYPHA_LLM_PROVIDER || 'glm-direct';
  const Klass = PROVIDERS[id];
  if (!Klass) {
    const known = Object.keys(PROVIDERS).join(', ');
    throw new LLMProviderError(`Unknown LLM provider "${id}". Known: ${known}`);
  }
  const cacheKey = id + ':' + JSON.stringify(opts);
  if (!opts.fresh && _cached && _cachedKey === cacheKey) return _cached;
  _cached = new Klass(opts);
  _cachedKey = cacheKey;
  return _cached;
}

/**
 * Returns the first usable {provider, model} tuple for a capability class.
 * Iterates the fallback chain in CAPABILITY_REGISTRY[capability]; skips
 * entries whose provider is not registered (e.g. Phase C providers without keys).
 *
 * Phase D will replace simple iteration with weighted DispatchPolicy + health monitor.
 *
 * @param {string} capability — one of T6_STRONG / T4_JUDGE / T3_MID
 * @param {object} [opts] — forwarded to getProvider()
 * @returns {{provider: LLMProvider, model: string, providerId: string, capability: string}}
 */
function getCapabilityModel(capability, opts = {}) {
  const chain = CAPABILITY_REGISTRY[capability];
  if (!chain) {
    const known = Object.keys(CAPABILITY_REGISTRY).join(', ');
    throw new LLMProviderError(`Unknown capability "${capability}". Known: ${known}`);
  }
  let lastErr = null;
  for (const entry of chain) {
    if (!PROVIDERS[entry.provider]) continue; // provider not yet registered (Phase C+)
    try {
      const provider = getProvider(entry.provider, opts);
      return { provider, model: entry.model, providerId: entry.provider, capability };
    } catch (e) {
      lastErr = e;
      // auth/provider error — try next entry in fallback chain
      continue;
    }
  }
  throw new LLMProviderError(
    `No usable provider for capability ${capability} (chain exhausted). Last error: ${lastErr ? lastErr.message : 'no providers registered'}`,
    lastErr
  );
}

function listProviders() {
  return Object.keys(PROVIDERS);
}

function listCapabilities() {
  return Object.keys(CAPABILITY_REGISTRY);
}

module.exports = {
  getProvider,
  getCapabilityModel,
  listProviders,
  listCapabilities,
  CAPABILITY_REGISTRY,
  LLMProvider,
  LLMTimeoutError,
  LLMAuthError,
  LLMProviderError,
};

// Phase D 2026-05-08: re-export router API for runtime fallback (DispatchPolicy
// + ProviderHealth). Late-required AFTER module.exports is set to satisfy the
// circular reference router → index → router.
const _router = require('./router');
Object.assign(module.exports, {
  executeChat:       _router.executeChat,
  getProviderHealth: _router.getReport,
  startRecoveryLoop: _router.startRecoveryLoop,
  stopRecoveryLoop:  _router.stopRecoveryLoop,
  DISPATCH_POLICY:   _router.DISPATCH_POLICY,
});
