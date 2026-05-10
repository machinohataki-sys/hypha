'use strict';
// HYPHA · LLMProvider abstract base — sub-step D0
//
// All LLM calls in v0.1+ go through a `LLMProvider.chat()` method. Concrete
// implementations (glm-direct.js, future hypha-relay.js) extend this. The
// lesson generator + jargon firewall + scoring + feedback never know which
// impl is active — the selector in index.js decides.
//
// Single method this version. Streaming / function calling / vision come
// when blueprint sub-steps need them.

class LLMProvider {
  /**
   * @param {object} opts
   * @param {Array<{role:string,content:string}>} opts.messages
   * @param {string} [opts.model]
   * @param {number} [opts.temperature]
   * @param {boolean} [opts.json] — if true, return parsed JSON object
   * @param {number} [opts.maxTokens]
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<string|object>}
   */
  async chat(opts) {
    throw new Error('LLMProvider.chat must be implemented by subclass');
  }

  /** Override in subclass if it has setup state to release. */
  async dispose() {}
}

class LLMTimeoutError extends Error {
  constructor(ms) { super(`LLM call timed out after ${Math.round(ms / 1000)}s`); this.code = 'LLM_TIMEOUT'; }
}
class LLMAuthError extends Error {
  constructor(msg) { super(msg || 'LLM auth failed'); this.code = 'LLM_AUTH'; }
}
class LLMProviderError extends Error {
  constructor(msg, cause) { super(msg); this.code = 'LLM_PROVIDER'; this.cause = cause; }
}

module.exports = { LLMProvider, LLMTimeoutError, LLMAuthError, LLMProviderError };
