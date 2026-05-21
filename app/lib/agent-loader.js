'use strict';

// agent-loader.js — v0158 — load .agents/<name>/ files for spotlight invocation.
//
// Per the agent-sovereign architecture (plan 2026-05-04): Hypha owns NO prompts.
// Agents are sovereign actors with their own identity (system-prompt.md), memory
// (sessions/wisdom/wiki/), and reflection logic. This loader is pure I/O — it
// reads agent files from disk and assembles the context object that streamTurn
// expects. No interpretation, no prompt injection beyond the structural shim.
//
// Storage layout per agent (vault-relative):
//   .agents/<name>/
//     system-prompt.md      ← required, agent identity
//     config.json            ← optional { model, temperature, vault_subdir }
//     sessions/              ← .jsonl files, one per day
//     wisdom/                ← sparks.md + exp.md (agent's self-distilled memory)
//     wiki/                  ← _index.md + concepts/ + learner-state/

const fs = require('node:fs');
const path = require('node:path');
const _agentState = require('./agent-state');     // v0158b L6 — actor lifecycle

const RECENT_TURNS = 20;            // last N session entries to include as history
const MAX_WISDOM_CHARS = 8000;      // cap appended wisdom to avoid context bloat
const MAX_WIKI_INDEX_CHARS = 4000;  // wiki TOC cap

function agentDir(vaultRoot, name) {
  return path.join(vaultRoot, '.agents', name);
}

function _exists(p) {
  try { fs.statSync(p); return true; } catch (_) { return false; }
}

function _readSafe(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return fallback; }
}

// List all agents in vault. Each = a directory under .agents/ that has a
// system-prompt.md. Returns sorted array of names.
function listAgents(vaultRoot) {
  const root = path.join(vaultRoot, '.agents');
  if (!_exists(root)) return [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (_) { return []; }
  return entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .filter(n => _exists(path.join(root, n, 'system-prompt.md')))
    .sort();
}

// Read agent's full state for invocation. Returns null if agent doesn't exist
// or has no system-prompt.md.
function loadAgent(vaultRoot, name) {
  const dir = agentDir(vaultRoot, name);
  if (!_exists(dir)) return null;

  const systemPromptPath = path.join(dir, 'system-prompt.md');
  if (!_exists(systemPromptPath)) return null;
  const systemPrompt = _readSafe(systemPromptPath, '').trim();
  if (!systemPrompt) return null;

  // Config — optional. Defaults: use settings.model, temperature 0.7.
  let config = { model: null, temperature: 0.7 };
  const configPath = path.join(dir, 'config.json');
  if (_exists(configPath)) {
    try { config = { ...config, ...JSON.parse(_readSafe(configPath, '{}')) }; }
    catch (_) {}
  }

  // Recent session turns — load last RECENT_TURNS from latest .jsonl file.
  const sessionsDir = path.join(dir, 'sessions');
  let recentSessions = [];
  let latestSessionFile = null;
  if (_exists(sessionsDir)) {
    let files = [];
    try {
      files = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.jsonl'))
        .sort()
        .reverse();
    } catch (_) {}
    if (files.length > 0) {
      latestSessionFile = files[0];
      const raw = _readSafe(path.join(sessionsDir, latestSessionFile));
      const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      const allTurns = lines
        .slice(-(RECENT_TURNS * 2))   // load 2x then filter
        .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean);

      // v0158f — filter orphan user turns (user message with no following assistant
      // response) and error rows. Without this filter, agent re-answers prior
      // failed invocations on every new turn (because it sees them as "pending
      // unanswered questions"). 'error' role excluded entirely from history.
      recentSessions = [];
      for (let i = 0; i < allTurns.length; i++) {
        const t = allTurns[i];
        if (!t || !t.role) continue;
        if (t.role === 'error') continue;     // skip error rows from history
        if (t.role === 'user') {
          // Only include if followed by an assistant response (not orphan)
          const next = allTurns[i + 1];
          if (next && (next.role === 'assistant' || next.role === 'tutor')) {
            recentSessions.push(t);
            recentSessions.push(next);
            i++;   // consume both
          }
          // else: orphan user turn → skip silently
        } else if (t.role === 'assistant' || t.role === 'tutor') {
          // bare assistant turn (no preceding user) — include only if followed
          // by a user (rare, but possible from edge writes); else skip
          if (recentSessions.length === 0 || recentSessions[recentSessions.length - 1].role === 'user') {
            recentSessions.push(t);
          }
        }
      }
      // Cap at RECENT_TURNS pairs after filter
      recentSessions = recentSessions.slice(-RECENT_TURNS);
    }
  }

  // Wisdom — sparks + exp, both optional. Capped at MAX_WISDOM_CHARS.
  let wisdom = '';
  const sparksPath = path.join(dir, 'wisdom', 'sparks.md');
  const expPath = path.join(dir, 'wisdom', 'exp.md');
  if (_exists(sparksPath)) wisdom += '## sparks (your past reflections)\n\n' + _readSafe(sparksPath) + '\n\n';
  if (_exists(expPath)) wisdom += '## exp (lessons from past mistakes)\n\n' + _readSafe(expPath);
  if (wisdom.length > MAX_WISDOM_CHARS) wisdom = wisdom.slice(-MAX_WISDOM_CHARS);

  // Wiki index — optional. Just the _index.md content (TOC). Entity pages
  // are loaded on-demand by keyword match (deferred to v0158b).
  let wikiIndex = '';
  const wikiIndexPath = path.join(dir, 'wiki', '_index.md');
  if (_exists(wikiIndexPath)) {
    wikiIndex = _readSafe(wikiIndexPath);
    if (wikiIndex.length > MAX_WIKI_INDEX_CHARS) wikiIndex = wikiIndex.slice(0, MAX_WIKI_INDEX_CHARS);
  }

  // v0158b L6 — actor state (totalInvocations, lastSurface, freeform data)
  const actorState = _agentState.loadState(vaultRoot, name);

  return {
    name,
    dir,
    systemPrompt,
    config,
    recentSessions,
    latestSessionFile,
    wisdom,
    wikiIndex,
    actorState,
  };
}

// Build the context shape that agent.js streamTurn expects:
//   { systemPrompt, history: [{role,content}], userMsg }
// agent.systemPrompt is appended with structural shim (wisdom, wiki TOC).
// recentSessions become history, with role normalization.
function buildAgentContext(agent, userMsg) {
  const history = (agent.recentSessions || []).map(t => ({
    role: (t.role === 'tutor' || t.role === 'assistant') ? 'assistant' : 'user',
    content: t.text || t.content || '',
  })).filter(h => h.content);

  const sysParts = [agent.systemPrompt];
  // v0158b L6 — actor state context (so agent sees its own runtime stats)
  if (agent.actorState && agent.actorState.totalInvocations > 0) {
    const stateCtx = _agentState.buildStateContext(agent.actorState);
    if (stateCtx) sysParts.push('═══ ' + stateCtx + ' ═══');
  }
  if (agent.wisdom) {
    sysParts.push('═══ prior reflections (your own past distillations) ═══\n\n' + agent.wisdom);
  }
  if (agent.wikiIndex) {
    sysParts.push('═══ your wiki index (TOC of entity pages you maintain) ═══\n\n' + agent.wikiIndex);
  }

  return {
    systemPrompt: sysParts.join('\n\n'),
    history,
    userMsg,
  };
}

// Append a turn to the agent's session log. One file per day; appended to
// existing today-file if present, else creates new.
function appendSession(vaultRoot, name, turn) {
  const dir = agentDir(vaultRoot, name);
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  let files = [];
  try {
    files = fs.readdirSync(sessionsDir)
      .filter(f => f.startsWith(today + 'T') && f.endsWith('.jsonl'));
  } catch (_) {}

  let target;
  if (files.length > 0) {
    target = files.sort().reverse()[0];
  } else {
    const stamp = new Date().toISOString().slice(0, 16).replace(':', '-');
    target = stamp + '.jsonl';
  }

  const filePath = path.join(sessionsDir, target);
  const entry = { ts: new Date().toISOString(), ...turn };
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  return target;
}

// Create a new agent dir scaffold. Throws if name is invalid or agent exists.
function createAgent(vaultRoot, name, systemPrompt, config = {}) {
  if (!/^[a-z0-9_-]{1,40}$/i.test(name)) {
    throw new Error('agent name must match /^[a-z0-9_-]{1,40}$/i');
  }
  const dir = agentDir(vaultRoot, name);
  if (_exists(dir)) throw new Error('agent already exists: ' + name);
  if (!systemPrompt || !systemPrompt.trim()) throw new Error('systemPrompt required');

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'wisdom'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'wiki', 'concepts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'wiki', 'learner-state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'system-prompt.md'), systemPrompt, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ created: new Date().toISOString(), ...config }, null, 2),
    'utf8'
  );
  return dir;
}

// Seed the default tutor agent if vault has no agents yet. Used on first
// app launch so the spotlight has something to invoke immediately.
// Reads the bundled prompts/agent-default-tutor.md (Hypha's only built-in
// agent template; user can edit/delete after creation).
function seedDefaultIfEmpty(vaultRoot, defaultPromptPath) {
  if (listAgents(vaultRoot).length > 0) return null;
  if (!_exists(defaultPromptPath)) return null;
  const systemPrompt = _readSafe(defaultPromptPath);
  if (!systemPrompt.trim()) return null;
  try {
    return createAgent(vaultRoot, 'default-tutor', systemPrompt, {
      seed: 'hypha-default',
      seeded_at: new Date().toISOString(),
    });
  } catch (e) {
    console.log('[agent-loader] seedDefaultIfEmpty failed:', e.message);
    return null;
  }
}

// v0158g — ephemeral load: minimal agent with NO sessions / wisdom / wiki / state.
// Used by Spotlight (one-shot queries, no history continuity wanted). Skipping
// these file reads makes invocation 5-10× faster and prevents context pollution
// from stale test sessions.
function loadAgentMinimal(vaultRoot, name) {
  const dir = agentDir(vaultRoot, name);
  if (!_exists(dir)) return null;
  const systemPromptPath = path.join(dir, 'system-prompt.md');
  if (!_exists(systemPromptPath)) return null;
  const systemPrompt = _readSafe(systemPromptPath, '').trim();
  if (!systemPrompt) return null;
  let config = { model: null, temperature: 0.7 };
  const configPath = path.join(dir, 'config.json');
  if (_exists(configPath)) {
    try { config = { ...config, ...JSON.parse(_readSafe(configPath, '{}')) }; }
    catch (_) {}
  }
  return {
    name,
    dir,
    systemPrompt,
    config,
    recentSessions: [],   // ephemeral: no history
    latestSessionFile: null,
    wisdom: '',           // ephemeral: no past distillations
    wikiIndex: '',
    actorState: null,     // ephemeral: not tracked
  };
}

module.exports = {
  agentDir,
  listAgents,
  loadAgent,
  loadAgentMinimal,
  buildAgentContext,
  appendSession,
  createAgent,
  seedDefaultIfEmpty,
};
