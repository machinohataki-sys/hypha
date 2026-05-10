'use strict';
// HYPHA · GLMDirect — direct call to open.bigmodel.cn from main process.
//
// Pattern lifted from old agent.js:1340-1400 (the GLM-specific branch),
// stripped of CLI / anthropic / agent-state coupling. v0.1 spec says key
// lives in process.env.GLM_API_KEY only — never bundled, never in renderer.
//
// GLM quirks handled:
//  - thinking: { type: 'disabled' } body param required for GLM 5-series
//    content-mode (otherwise message.content is empty, reasoning is in
//    reasoning_content). If the param itself is rejected (older models /
//    GLM 4 Air), retry without it.
//  - 90s default AbortController timeout; callers can override.
//  - response_format json_object for JSON-mode calls.

const OpenAI = require('openai');
const { LLMProvider, LLMTimeoutError, LLMAuthError, LLMProviderError } = require('./provider');

const GLM_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_TIMEOUT_MS = 90_000;

class GLMDirect extends LLMProvider {
  constructor({ apiKey, baseURL } = {}) {
    super();
    // See deepseek-direct.js for the rationale — env-var trim defense against
    // PowerShell `>>` continuation baking \n into the key.
    this.apiKey = (apiKey || process.env.GLM_API_KEY || '').trim();
    if (!this.apiKey) {
      throw new LLMAuthError('GLM_API_KEY not set in environment. Run `$env:GLM_API_KEY = "sk-..."` then `npm start`.');
    }
    this.baseURL = baseURL || GLM_BASE_URL;
    this.client = new OpenAI({ apiKey: this.apiKey, baseURL: this.baseURL });
  }

  async chat({ messages, model = 'glm-5.1', temperature = 0.7, json = false, maxTokens = 4000, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new LLMProviderError('messages array is required');
    }

    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
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
      }
      // Retry without `thinking` param if GLM rejects it (older models).
      if (body.thinking && err && /thinking|enable_thinking/i.test(err.message || '')) {
        delete body.thinking;
        try {
          response = await this.client.chat.completions.create(body, { signal: ac.signal });
        } catch (err2) {
          clearTimeout(tid);
          throw new LLMProviderError(err2.message || 'GLM call failed (retry)', err2);
        }
      } else if (err && (err.status === 401 || err.status === 403)) {
        clearTimeout(tid);
        throw new LLMAuthError(err.message || 'GLM auth failed (check GLM_API_KEY)');
      } else {
        clearTimeout(tid);
        throw new LLMProviderError(err.message || 'GLM call failed', err);
      }
    } finally {
      clearTimeout(tid);
    }

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      throw new LLMProviderError('GLM returned empty content (check thinking-disabled handling)');
    }

    if (json) {
      try {
        return JSON.parse(content);
      } catch (e) {
        // Try to salvage first JSON block (defensive, GLM sometimes wraps in prose)
        const m = content.match(/\{[\s\S]*\}/);
        if (m) {
          try { return JSON.parse(m[0]); } catch (_) { /* fall through */ }
        }
        throw new LLMProviderError('GLM returned non-JSON in JSON-mode: ' + content.slice(0, 200));
      }
    }

    return content;
  }
}

module.exports = { GLMDirect, GLM_BASE_URL };
