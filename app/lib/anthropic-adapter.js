'use strict';

// anthropic-adapter.js — direct Anthropic Messages API wrapper.
//
// Replaces the dead `claude` provider that pointed OpenAI SDK at the
// Anthropic Messages endpoint (404, since Messages API is not OpenAI-shaped).
//
// Why this exists (per /tr council 2026-05-02):
// - `claude-cli` (Claude Code in CLI mode) loads its own ~30k token Victor
//   persona before every call. The Hypha system prompt is flattened into a
//   user-message blob with a "[SYSTEM]" ASCII tag that the model treats as
//   ordinary user text. Result: tutor opens with "Machino" / "用户" 3rd
//   person / 4-paragraph literary commentary instead of peer-to-peer
//   Socratic teaching.
// - This adapter sends Hypha's system text via the wire-level `system`
//   parameter on Anthropic's Messages API. Anthropic's contract is system >>
//   user. No Claude Code persona is in scope. Output matches claude.ai
//   directly.
//
// Auth: `sk-ant-…` API key in settings.apiKey. Use console.anthropic.com to
// generate. NOT compatible with Claude Max subscription (which only
// authenticates the claude-cli binary, not API requests).
//
// Caching: system block is wrapped with `cache_control: ephemeral` so
// repeated lesson turns within ~1h reuse the cached system slab. Per
// Anthropic pricing, cache reads are ~10× cheaper than fresh tokens —
// brings Opus 4.7 lesson cost from ~$0.33 to ~$0.17 (Yogo's Phase 1 estimate).

const Anthropic = require('@anthropic-ai/sdk');

function _client(settings) {
  return new Anthropic({
    apiKey: settings.apiKey,
    baseURL: settings.baseURL || 'https://api.anthropic.com',
  });
}

// Split OpenAI-shaped messages → Anthropic shape.
// Anthropic API: { system: string|block[], messages: [{role:user|assistant, content}...] }
function _splitMessages(messages) {
  const systemParts = [];
  const others = [];
  for (const m of (messages || [])) {
    if (!m || typeof m.content !== 'string') continue;
    if (m.role === 'system') {
      if (m.content.trim()) systemParts.push(m.content);
    } else if (m.role === 'user' || m.role === 'assistant') {
      others.push({ role: m.role, content: m.content });
    }
  }
  return { system: systemParts.join('\n\n'), messages: others };
}

// Wrap system text in a content block with cache_control. Anthropic accepts
// either a plain string for `system` (no caching) OR an array of text blocks
// where each block can carry cache_control. We use the array form so the
// system prompt — which is identical across many turns of the same lesson —
// gets cached for cheap reuse.
function _systemWithCache(systemText) {
  if (!systemText || !systemText.trim()) return undefined;
  return [{
    type: 'text',
    text: systemText,
    cache_control: { type: 'ephemeral' },
  }];
}

// v0158x — Extended thinking. Anthropic Messages API: when `thinking` param
// is set, model produces internal reasoning tokens BEFORE visible output.
// Significantly improves output quality on conceptually-deep prompts (council
// 2026-05-04 diagnosis: lesson "不够深思熟虑" root cause). Constraints:
// - temperature MUST be 1.0 when thinking enabled (Anthropic hard rule)
// - budget_tokens deprecated on Opus 4.6 / Sonnet 4.6 future models, but works now
// - Stream emits thinking_delta events; runStream filters them out (kept silent)
// Cost impact: budget_tokens 8000 ≈ +$0.04/turn Sonnet, +$0.16/turn Opus 4.7.
function _applyThinking(params, opts) {
  const enableThinking = opts && opts.thinking !== false;
  if (!enableThinking) return params;
  return {
    ...params,
    temperature: 1.0,  // hard requirement
    thinking: {
      type: 'enabled',
      budget_tokens: opts.thinking_budget || 8000,
    },
  };
}

// Non-streaming call. Returns the assistant text reply as a string (matches
// the contract llmJSON expects from CLI / OpenAI-SDK paths).
async function runOnce(messages, settings, opts = {}) {
  const c = _client(settings);
  const { system, messages: msgs } = _splitMessages(messages);
  let params = {
    model: settings.model || 'claude-opus-4-7',
    max_tokens: opts.max_tokens || 6000,
    temperature: opts.temperature ?? 0.7,
    messages: msgs.length ? msgs : [{ role: 'user', content: '...' }],
  };
  // v0158x — apply extended thinking (default ON; opts.thinking=false to disable)
  params = _applyThinking(params, opts);
  const sysBlock = _systemWithCache(system);
  if (sysBlock) params.system = sysBlock;

  const timeoutMs = opts.timeoutMs || 90_000;
  const r = await c.messages.create(params, { timeout: timeoutMs });

  // Extract text from content blocks (Anthropic returns array of {type,text}).
  const text = ((r && r.content) || [])
    .filter(b => b && b.type === 'text')
    .map(b => b.text || '')
    .join('');
  return text;
}

// Streaming call. Calls onChunk(text) per text delta. Used by tutor turns.
// opts.signal: AbortSignal to allow renderer-triggered stop button to halt
// the stream mid-flight via main.js's llm:lesson-abort IPC.
async function runStream(messages, settings, onChunk, opts = {}) {
  const c = _client(settings);
  const { system, messages: msgs } = _splitMessages(messages);
  let params = {
    model: settings.model || 'claude-opus-4-7',
    max_tokens: opts.max_tokens || 6000,  // v0158x — was 1500, often truncated
    temperature: opts.temperature ?? 0.8,
    messages: msgs.length ? msgs : [{ role: 'user', content: '...' }],
    stream: true,
  };
  // v0158x — apply extended thinking (default ON for tutor depth)
  params = _applyThinking(params, opts);
  const sysBlock = _systemWithCache(system);
  if (sysBlock) params.system = sysBlock;

  const requestOpts = opts.signal ? { signal: opts.signal } : {};
  const stream = await c.messages.create(params, requestOpts);
  for await (const event of stream) {
    // Anthropic stream emits typed events; we want content_block_delta with
    // text_delta to surface visible text. v0158x — thinking_delta events
    // (the model's internal reasoning) are FILTERED out — they're meant to
    // be invisible to user; passing them to onChunk would dump reasoning
    // monologue into the chat bubble.
    if (event && event.type === 'content_block_delta'
        && event.delta && event.delta.type === 'text_delta'
        && typeof event.delta.text === 'string') {
      onChunk(event.delta.text);
    }
  }
}

module.exports = { runOnce, runStream };
