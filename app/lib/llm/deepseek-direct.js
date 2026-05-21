'use strict';
// HYPHA · DeepSeekDirect — direct call to api.deepseek.com from main process.
//
// Mirrors GLMDirect pattern. DeepSeek V4 API is OpenAI ChatCompletions compatible
// per official docs (api-docs.deepseek.com 2026-Q2). Models = deepseek-v4-pro
// (heavy reasoner, T6_STRONG fallback) + deepseek-v4-flash (cheap, T4_JUDGE / T3_MID).
//
// Legacy SKUs deepseek-chat / deepseek-reasoner sunset 2026-07-24 — DO NOT USE.
//
// Capability mapping (per BLUEPRINT §17.2.1 + AMD-MEOW-P4):
//   T6_STRONG fallback: deepseek-v4-pro
//   T4_JUDGE  fallback: deepseek-v4-flash
//   T3_MID    fallback: deepseek-v4-flash

const OpenAI = require('openai');
const { LLMProvider, LLMTimeoutError, LLMAuthError, LLMProviderError } = require('./provider');

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_TIMEOUT_MS = 90_000;

class DeepSeekDirect extends LLMProvider {
  constructor({ apiKey, baseURL } = {}) {
    super();
    // Trim trailing whitespace/newline. PowerShell `>>` continuation inside a quoted
    // SetEnvironmentVariable bakes a literal \n into the User env var, producing `Bearer sk-...\n`
    // which OpenAI SDK rejects as "not a legal HTTP header value" → masked as "Connection error".
    this.apiKey = (apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
    if (!this.apiKey) {
      throw new LLMAuthError('DEEPSEEK_API_KEY not set in environment. Run `$env:DEEPSEEK_API_KEY = "sk-..."` then `npm start`.');
    }
    this.baseURL = baseURL || DEEPSEEK_BASE_URL;
    this.client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });
  }

  async chatWithUsage({ messages, model = 'deepseek-v4-flash', temperature = 0.7, json = false, maxTokens = 4000, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new LLMProviderError('messages array is required');
    }

    const body = {
      model,
      messages,
      temperature,
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
        throw new LLMAuthError(err.message || 'DeepSeek auth failed (check DEEPSEEK_API_KEY)');
      } else {
        clearTimeout(tid);
        throw new LLMProviderError(err.message || 'DeepSeek call failed', err);
      }
    } finally {
      clearTimeout(tid);
    }

    let content = response?.choices?.[0]?.message?.content;
    let reasoningContent = response?.choices?.[0]?.message?.reasoning_content;

    // 2026-05-19 — DeepSeek V4 模型 reasoning tokens 先于 content tokens. 当
    // caller 传小 maxTokens (micro-judge / harvest filter / drift 二审 typically
    // 200-800), reasoning 可能烧光预算 → content=''. Auto-retry once with bumped
    // budget if (a) content empty (b) reasoning_content 非空 (证实是 reasoning
    // overflow, ! API 错误) (c) maxTokens 还有抬升空间.
    // Per HYPHA CLAUDE.md: "DeepSeek V4 + GLM 5-series + Kimi K2.6 spend
    // reasoning tokens before content tokens — a 5-token ping returns empty"
    // (GLM 自己 thinking:disabled 解决了, DeepSeek 走 auto-retry 这条).
    if (!content && reasoningContent) {
      const bumpedTokens = Math.min(maxTokens * 4, 8000);
      // Only retry if bumping actually buys headroom (caller already at 8000+
      // → empty content is a different bug, retry won't help).
      if (bumpedTokens > maxTokens) {
        try {
          const retryBody = { ...body, max_tokens: bumpedTokens };
          const retryResp = await this.client.chat.completions.create(retryBody);
          content = retryResp?.choices?.[0]?.message?.content;
          if (content) {
            // Splice in usage from retry so cost ledger captures full burn
            response.usage = retryResp.usage || response.usage;
          }
        } catch (_e) { /* retry best-effort; fall through to throw below */ }
      }
    }

    if (!content) {
      const reasonHint = reasoningContent
        ? ` (reasoning_content=${reasoningContent.length} chars but no final content — increase maxTokens ≥ 2000)`
        : '';
      throw new LLMProviderError('DeepSeek returned empty content' + reasonHint);
    }

    // OpenAI-compat usage block. DeepSeek V4 returns {prompt_tokens,
    // completion_tokens, total_tokens, prompt_cache_hit_tokens,
    // prompt_cache_miss_tokens} per api-docs.deepseek.com 2026-Q2. Warn if
    // absent — V0.5 E1 trigger requires >=95% token-metadata coverage.
    const usage = (response && response.usage) ? response.usage : null;
    if (!usage) {
      console.warn('[deepseek-direct] response.usage missing for model=%s — provider response shape unexpected', model);
    }

    if (json) {
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        // Defensive: salvage first JSON block (DeepSeek occasionally wraps in prose despite json mode)
        const m = content.match(/\{[\s\S]*\}/);
        if (m) {
          try { parsed = JSON.parse(m[0]); } catch (_) { /* fall through */ }
        }
        if (parsed === undefined) {
          throw new LLMProviderError('DeepSeek returned non-JSON in JSON-mode: ' + content.slice(0, 200));
        }
      }
      return { content: parsed, usage };
    }

    return { content, usage };
  }
}

module.exports = { DeepSeekDirect, DEEPSEEK_BASE_URL };
