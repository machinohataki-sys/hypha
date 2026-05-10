'use strict';
// HYPHA · KimiDirect — direct call to api.moonshot.ai from main process.
//
// Mirrors GLMDirect pattern. Kimi K2.6 API is OpenAI ChatCompletions compatible
// per platform.kimi.ai docs (2026-Q2). Model = kimi-k2.6 (1T MoE, 32B active,
// 256K ctx, multimodal). Older SKU `kimi-k2` line sunsets 2026-05-25 — DO NOT USE.
//
// Capability mapping (per BLUEPRINT §17.2.1 + AMD-MEOW-P4):
//   T6_STRONG fallback-2 (warm baseline 10% per DispatchPolicy 60/30/10)
//   T4_JUDGE  fallback-2
//   T3_MID    fallback-2
//
// 256K context is shorter than DeepSeek 1M / GLM-4-Long, so Kimi NOT
// recommended for v1.6 Library Distillation long-context use.

const OpenAI = require('openai');
const { LLMProvider, LLMTimeoutError, LLMAuthError, LLMProviderError } = require('./provider');

// platform.moonshot.cn issues keys scoped to api.moonshot.cn (CN). The .ai domain
// is the international platform with separate auth — keys do NOT cross-validate.
// Override via the constructor `baseURL` arg if a user has a .ai key (uncommon).
const KIMI_BASE_URL = 'https://api.moonshot.cn/v1';
const DEFAULT_TIMEOUT_MS = 90_000;

class KimiDirect extends LLMProvider {
  constructor({ apiKey, baseURL } = {}) {
    super();
    // See deepseek-direct.js for the rationale — env-var trim defense against
    // PowerShell `>>` continuation baking \n into the key.
    this.apiKey = (apiKey || process.env.KIMI_API_KEY || '').trim();
    if (!this.apiKey) {
      throw new LLMAuthError('KIMI_API_KEY not set in environment. Run `$env:KIMI_API_KEY = "sk-..."` then `npm start`.');
    }
    this.baseURL = baseURL || KIMI_BASE_URL;
    this.client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });
  }

  async chat({ messages, model = 'kimi-k2.6', temperature = 0.7, json = false, maxTokens = 4000, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new LLMProviderError('messages array is required');
    }

    // Kimi K2.6 (reasoning SKU) only accepts temperature=1; other temps return 400.
    // Override silently — callers asking for deterministic temp on a reasoning model
    // are receiving the model's intended behavior, not a config bug.
    const effectiveTemp = /^kimi-k2/.test(model) ? 1 : temperature;

    const body = {
      model,
      messages,
      temperature: effectiveTemp,
      max_tokens: maxTokens,
    };
    if (json) body.response_format = { type: 'json_object' };

    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), timeoutMs);

    let response;
    try {
      response = await this.client.chat.completions.create(body, { signal: ac.signal });
    } catch (err) {
      if (err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''))) {
        clearTimeout(tid);
        throw new LLMTimeoutError(timeoutMs);
      } else if (err && (err.status === 401 || err.status === 403)) {
        clearTimeout(tid);
        throw new LLMAuthError(err.message || 'Kimi auth failed (check KIMI_API_KEY)');
      } else {
        clearTimeout(tid);
        throw new LLMProviderError(err.message || 'Kimi call failed', err);
      }
    } finally {
      clearTimeout(tid);
    }

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      throw new LLMProviderError('Kimi returned empty content');
    }

    if (json) {
      try {
        return JSON.parse(content);
      } catch (e) {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) {
          try { return JSON.parse(m[0]); } catch (_) { /* fall through */ }
        }
        throw new LLMProviderError('Kimi returned non-JSON in JSON-mode: ' + content.slice(0, 200));
      }
    }

    return content;
  }
}

module.exports = { KimiDirect, KIMI_BASE_URL };
