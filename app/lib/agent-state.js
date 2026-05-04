'use strict';

// agent-state.js — v0158b L6 — actor state + cross-surface continuity.
//
// Per /tr 2026-05-04 council STRONGEST_GAP (TATA): the v0158a implementation
// treated agents as stateless functions per invocation. This violates the
// "agent sovereignty + REPL persistence" goal — restart Hypha = agent cold-start.
//
// This layer adds an actor lifecycle: each agent has a persistent `_actor-state.json`
// at .agents/<name>/_actor-state.json that survives invocation boundaries.
// State includes: total invocations, last surface, totalTokens, freeform `data`
// field for agent-managed continuity (lesson checkpoint / reasoning cursor / etc.).

const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = '_actor-state.json';

function _statePath(vaultRoot, agentName) {
  return path.join(vaultRoot, '.agents', agentName, STATE_FILE);
}

function _exists(p) { try { fs.statSync(p); return true; } catch (_) { return false; } }

function _readSafe(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}

const DEFAULT_STATE = {
  createdAt: null,
  lastInvokedAt: null,
  totalInvocations: 0,
  totalTokensIn: 0,
  totalTokensOut: 0,
  totalCostEstimateUSD: 0,
  lastSurface: null,
  surfaceTransitions: [],   // [{ ts, from, to }] — last 50 only
  data: {},                 // freeform, agent-managed (e.g. lessonCheckpoint, reasoningCursor)
};

// Load state for an agent. Returns DEFAULT_STATE if no state file exists.
// Always returns an object (never null).
function loadState(vaultRoot, agentName) {
  const p = _statePath(vaultRoot, agentName);
  if (!_exists(p)) return { ...DEFAULT_STATE };
  const raw = _readSafe(p, null);
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STATE };
  return { ...DEFAULT_STATE, ...raw };
}

// Merge-write state. Partial updates allowed; missing fields preserved from disk.
function saveState(vaultRoot, agentName, partial) {
  const p = _statePath(vaultRoot, agentName);
  const cur = loadState(vaultRoot, agentName);
  const next = { ...cur, ...partial };
  // Ensure parent dir exists (caller may have race on first invocation)
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// Record an invocation: called by main.js agent:invoke handler at end-of-call.
// Increments counters, updates last-* fields, logs surface transition if changed.
function recordInvocation(vaultRoot, agentName, { surface, tokensIn, tokensOut, costEstimateUSD }) {
  const cur = loadState(vaultRoot, agentName);
  const now = new Date().toISOString();
  const next = {
    ...cur,
    createdAt: cur.createdAt || now,
    lastInvokedAt: now,
    totalInvocations: (cur.totalInvocations || 0) + 1,
    totalTokensIn: (cur.totalTokensIn || 0) + (tokensIn || 0),
    totalTokensOut: (cur.totalTokensOut || 0) + (tokensOut || 0),
    totalCostEstimateUSD: (cur.totalCostEstimateUSD || 0) + (costEstimateUSD || 0),
  };
  if (cur.lastSurface && cur.lastSurface !== surface) {
    const transitions = (cur.surfaceTransitions || []).slice(-49);
    transitions.push({ ts: now, from: cur.lastSurface, to: surface });
    next.surfaceTransitions = transitions;
  }
  next.lastSurface = surface || cur.lastSurface || null;
  return saveState(vaultRoot, agentName, next);
}

// Update freeform `data` field — for agent's own use (e.g., lesson checkpoint).
// Caller passes a full data object or a callback for in-place merge.
function updateData(vaultRoot, agentName, dataOrFn) {
  const cur = loadState(vaultRoot, agentName);
  const newData = typeof dataOrFn === 'function' ? dataOrFn(cur.data || {}) : dataOrFn;
  return saveState(vaultRoot, agentName, { data: { ...(cur.data || {}), ...newData } });
}

// Build a state-summary string for inclusion in agent's system prompt context.
// So the agent itself knows "you've been invoked N times across surfaces X,Y,Z".
function buildStateContext(state) {
  if (!state || !state.totalInvocations) return '';
  const parts = [];
  parts.push(`# Your runtime state`);
  parts.push(`Total invocations: ${state.totalInvocations}`);
  if (state.lastInvokedAt) parts.push(`Last invoked: ${state.lastInvokedAt}`);
  if (state.lastSurface) parts.push(`Last surface: ${state.lastSurface}`);
  if (state.totalTokensIn) {
    const cost = state.totalCostEstimateUSD ? ` (~$${state.totalCostEstimateUSD.toFixed(3)})` : '';
    parts.push(`Total tokens: ${state.totalTokensIn} in / ${state.totalTokensOut} out${cost}`);
  }
  if (state.surfaceTransitions && state.surfaceTransitions.length > 0) {
    const recent = state.surfaceTransitions.slice(-3);
    parts.push(`Recent surface switches: ${recent.map(t => `${t.from}→${t.to}`).join(', ')}`);
  }
  if (state.data && Object.keys(state.data).length > 0) {
    parts.push(`# Your own state data (you maintain this)`);
    parts.push('```json');
    parts.push(JSON.stringify(state.data, null, 2));
    parts.push('```');
  }
  return parts.join('\n');
}

module.exports = { loadState, saveState, recordInvocation, updateData, buildStateContext, STATE_FILE };
