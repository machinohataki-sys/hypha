'use strict';

// token-budget.js — v0158b L3 — per-surface context budget enforcement.
//
// Per /tr 2026-05-04 council STRONGEST_FAILURE_MODE: auto-injecting vault
// context per surface invocation can balloon context to overflow OR cost spike.
// This util enforces a hard cap per surface; trims oldest history first when
// over; emits warning at 70% threshold.
//
// Token estimation: rough char-based proxy (1 token ≈ 3.5 chars for mixed
// CJK+ASCII content). Avoids dependency on actual tokenizer; off-by-30%
// in worst case but good enough for budget alerts.

const SURFACE_CAPS = {
  // surface name → max input context in tokens (system + history + userMsg combined)
  spotlight: 4000,
  lesson: 8000,
  deepen: 12000,
  recall: 6000,
  ask: 3000,
  default: 6000,
};

const WARN_THRESHOLD = 0.70;  // emit warning at 70% of cap

function _approxTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  // Rough: 1 token ≈ 3.5 chars for mixed CJK+ASCII (CJK is denser than English)
  return Math.ceil(text.length / 3.5);
}

function _historyTokens(history) {
  if (!Array.isArray(history)) return 0;
  let n = 0;
  for (const h of history) n += _approxTokens(h && h.content);
  return n;
}

// Trim oldest history entries until total fits in remainingBudget (tokens for history).
// Always preserves the LAST history entry (most recent context the agent expects).
function _trimHistory(history, remainingBudget) {
  if (!Array.isArray(history) || history.length === 0) return [];
  // Walk from newest backward, accumulating, drop oldest that don't fit.
  const reversed = [...history].reverse();
  const kept = [];
  let used = 0;
  for (const h of reversed) {
    const t = _approxTokens(h && h.content);
    if (used + t > remainingBudget && kept.length > 0) break;
    kept.push(h);
    used += t;
  }
  return kept.reverse();
}

// Main enforcement function. Returns the (potentially trimmed) context plus
// telemetry for logging / UI display.
function enforceContextBudget({ systemPrompt, history, userMsg, surface }) {
  const cap = SURFACE_CAPS[surface] || SURFACE_CAPS.default;
  const sysTokens = _approxTokens(systemPrompt);
  const userTokens = _approxTokens(userMsg);
  const historyTokensIn = _historyTokens(history);
  const totalIn = sysTokens + userTokens + historyTokensIn;

  const result = {
    surface,
    cap,
    originalTokens: totalIn,
    finalTokens: totalIn,
    trimmedHistoryEntries: 0,
    warning: null,
    history,  // default: passthrough
  };

  if (totalIn <= cap) {
    if (totalIn >= cap * WARN_THRESHOLD) {
      result.warning = `[token-budget] surface=${surface} at ${Math.round(totalIn / cap * 100)}% of cap (${totalIn}/${cap} tokens)`;
    }
    return result;
  }

  // Over budget: trim history first (preserve system + userMsg as essential)
  const remainingForHistory = cap - sysTokens - userTokens;
  if (remainingForHistory < 0) {
    // Even system + userMsg alone exceed cap — caller has to handle this.
    result.warning = `[token-budget] CRITICAL: system+userMsg alone (${sysTokens + userTokens}t) exceeds cap (${cap}t). History dropped entirely. Caller should distill systemPrompt or shorten userMsg.`;
    result.history = [];
    result.finalTokens = sysTokens + userTokens;
    result.trimmedHistoryEntries = (history || []).length;
    return result;
  }

  const trimmed = _trimHistory(history, remainingForHistory);
  result.history = trimmed;
  result.trimmedHistoryEntries = (history || []).length - trimmed.length;
  result.finalTokens = sysTokens + userTokens + _historyTokens(trimmed);
  result.warning = `[token-budget] surface=${surface} OVER cap (${totalIn}/${cap} tokens), trimmed ${result.trimmedHistoryEntries} oldest history entries → final ${result.finalTokens}t`;
  return result;
}

module.exports = { enforceContextBudget, SURFACE_CAPS, _approxTokens };
