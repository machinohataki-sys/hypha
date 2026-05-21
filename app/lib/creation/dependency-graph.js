'use strict';

// HYPHA · Creation System §11.5/§11.6 — Dependency Graph
//
// In-memory DAG over Decision Log + Assumption Ledger entries. Persisted as
// append-only edge log at vault/.hypha/dependency-graph.jsonl so reloads
// rebuild the graph deterministically.
//
// Per Scout S81 (Grounded Continuation, arXiv 2604.20283 — 89.7% on
// LongMemEval-KU via dependency-graph verifier): Decision/Assumption entries
// gain optional `depends_on: string[]` edges. On retraction (active→invalidated)
// the Kill Watcher walks dependents recursively + emits non-mutating
// CASCADE_REVIEW events. Downstream entries are NEVER auto-mutated — caller
// (UI/user) decides next state. Mirrors the existing REVIEW non-mutation
// contract from B1.
//
// Edge schema:
//   { ts, from_id, to_id, kind: 'supports'|'depends_on'|'derived_from', op: 'add'|'remove' }
//
// API:
//   addEdge({from_id, to_id, kind})       → {ok, edge} | {ok:false, error}
//   removeEdge({from_id, to_id, kind})    → {ok} | {ok:false, error}
//   getDependents(id)                     → string[]   (direct + transitive)
//   getAncestors(id)                      → string[]   (direct + transitive)
//   isCyclic()                            → boolean    (whole graph)
//   wouldCreateCycle(from_id, to_id)      → boolean    (probe before add)
//   listEdges()                           → array      (live edges)
//   rebuildFromDisk(vaultRoot?)           → number     (edge count loaded)
//
// Defense:
//   - Cycle detection on every addEdge — reject with clear error
//   - Self-edges (from_id === to_id) rejected
//   - Corrupt jsonl lines skipped silently (matches sibling modules)
//   - Edge kind validated against ALLOWED_KINDS
//   - Persistence failure surfaces as {ok:false} — in-memory state unchanged

const fs = require('node:fs');
const path = require('node:path');
const vault = require('../vault');

const EDGE_LOG_REL = path.join('.hypha', 'dependency-graph.jsonl');
const ALLOWED_KINDS = Object.freeze(['supports', 'depends_on', 'derived_from']);

// _edges: Map<edgeKey, {from_id,to_id,kind}>. Key uses ASCII US separator
// (\x1f, "unit separator") to remain safe when IDs contain '-' ':' etc.
// _forward: Map<from_id, Set<to_id>>   (kind-agnostic — cascade walks ignore kind)
// _reverse: Map<to_id,   Set<from_id>>
const _edges = new Map();
const _forward = new Map();
const _reverse = new Map();
let _booted = false;
let _bootedRoot = null;

const SEP = '\x1f';

function _edgeKey(from, to, kind) {
  return from + SEP + to + SEP + kind;
}

function _edgeLogPath(vaultRoot) {
  const root = vaultRoot || vault.resolveRoot();
  return path.join(root, EDGE_LOG_REL);
}

function _ensureLoaded(vaultRoot) {
  const root = vaultRoot || vault.resolveRoot();
  if (_booted && _bootedRoot === root) return;
  _edges.clear();
  _forward.clear();
  _reverse.clear();
  _loadFromDisk(root);
  _booted = true;
  _bootedRoot = root;
}

function _addInMemory(from, to, kind) {
  const k = _edgeKey(from, to, kind);
  if (_edges.has(k)) return false;
  _edges.set(k, { from_id: from, to_id: to, kind });
  if (!_forward.has(from)) _forward.set(from, new Set());
  _forward.get(from).add(to);
  if (!_reverse.has(to)) _reverse.set(to, new Set());
  _reverse.get(to).add(from);
  return true;
}

function _removeInMemory(from, to, kind) {
  const k = _edgeKey(from, to, kind);
  if (!_edges.has(k)) return false;
  _edges.delete(k);
  // Only drop the adjacency entry when no other-kind edge survives.
  let hasOtherKind = false;
  for (const altKind of ALLOWED_KINDS) {
    if (altKind === kind) continue;
    if (_edges.has(_edgeKey(from, to, altKind))) { hasOtherKind = true; break; }
  }
  if (!hasOtherKind) {
    const fset = _forward.get(from);
    if (fset) {
      fset.delete(to);
      if (!fset.size) _forward.delete(from);
    }
    const rset = _reverse.get(to);
    if (rset) {
      rset.delete(from);
      if (!rset.size) _reverse.delete(to);
    }
  }
  return true;
}

// Would adding from→to introduce a cycle? Walk from `to` forward, look for
// `from`. Self-edges already rejected upstream.
function wouldCreateCycle(from, to) {
  if (from === to) return true;
  const visited = new Set();
  const stack = [to];
  while (stack.length) {
    const n = stack.pop();
    if (n === from) return true;
    if (visited.has(n)) continue;
    visited.add(n);
    const outs = _forward.get(n);
    if (!outs) continue;
    for (const nxt of outs) stack.push(nxt);
  }
  return false;
}

function isCyclic() {
  // Iterative DFS with white/grey/black colouring over current forward set.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map();
  const nodes = new Set();
  for (const e of _edges.values()) { nodes.add(e.from_id); nodes.add(e.to_id); }
  for (const n of nodes) color.set(n, WHITE);
  for (const start of nodes) {
    if (color.get(start) !== WHITE) continue;
    const stack = [{ node: start, children: null, idx: 0 }];
    color.set(start, GREY);
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (!top.children) {
        const outs = _forward.get(top.node);
        top.children = outs ? Array.from(outs) : [];
        top.idx = 0;
      }
      if (top.idx >= top.children.length) {
        color.set(top.node, BLACK);
        stack.pop();
        continue;
      }
      const child = top.children[top.idx++];
      const c = color.get(child) || WHITE;
      if (c === GREY) return true;
      if (c === WHITE) {
        color.set(child, GREY);
        stack.push({ node: child, children: null, idx: 0 });
      }
    }
  }
  return false;
}

function _appendEdgeLog(vaultRoot, row) {
  const abs = _edgeLogPath(vaultRoot);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(row) + '\n', 'utf8');
}

function addEdge({ from_id, to_id, kind } = {}, vaultRoot) {
  if (typeof from_id !== 'string' || !from_id.trim()) {
    return { ok: false, error: 'dependency-graph: from_id required' };
  }
  if (typeof to_id !== 'string' || !to_id.trim()) {
    return { ok: false, error: 'dependency-graph: to_id required' };
  }
  if (from_id === to_id) {
    return { ok: false, error: 'dependency-graph: self-edge rejected' };
  }
  const safeKind = ALLOWED_KINDS.includes(kind) ? kind : null;
  if (!safeKind) {
    return { ok: false, error: 'dependency-graph: kind must be one of ' + ALLOWED_KINDS.join('|') };
  }
  _ensureLoaded(vaultRoot);
  if (wouldCreateCycle(from_id, to_id)) {
    return { ok: false, error: 'dependency-graph: cycle detected (' + from_id + ' -> ' + to_id + ' would close a loop)' };
  }
  const added = _addInMemory(from_id, to_id, safeKind);
  if (!added) {
    return { ok: true, edge: { from_id, to_id, kind: safeKind }, deduped: true };
  }
  const row = {
    ts: new Date().toISOString(),
    op: 'add',
    from_id,
    to_id,
    kind: safeKind,
  };
  try {
    _appendEdgeLog(vaultRoot, row);
  } catch (err) {
    _removeInMemory(from_id, to_id, safeKind);
    return { ok: false, error: 'dependency-graph: edge log write failed: ' + err.message };
  }
  return { ok: true, edge: { from_id, to_id, kind: safeKind } };
}

function removeEdge({ from_id, to_id, kind } = {}, vaultRoot) {
  if (typeof from_id !== 'string' || typeof to_id !== 'string' || typeof kind !== 'string') {
    return { ok: false, error: 'dependency-graph: from_id/to_id/kind required' };
  }
  _ensureLoaded(vaultRoot);
  const removed = _removeInMemory(from_id, to_id, kind);
  if (!removed) {
    return { ok: false, error: 'dependency-graph: edge not found' };
  }
  const row = {
    ts: new Date().toISOString(),
    op: 'remove',
    from_id,
    to_id,
    kind,
  };
  try {
    _appendEdgeLog(vaultRoot, row);
  } catch (err) {
    _addInMemory(from_id, to_id, kind);
    return { ok: false, error: 'dependency-graph: edge log write failed: ' + err.message };
  }
  return { ok: true };
}

// `from_id` depends on `to_id` (dependant points at dependency). So dependents
// of X are nodes Y such that Y -> X exists, i.e. reverse adjacency.
function getDependents(id, vaultRoot) {
  _ensureLoaded(vaultRoot);
  const out = [];
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const n = stack.pop();
    const incoming = _reverse.get(n);
    if (!incoming) continue;
    for (const upstream of incoming) {
      if (seen.has(upstream)) continue;
      seen.add(upstream);
      out.push(upstream);
      stack.push(upstream);
    }
  }
  return out;
}

// Walk forward — entries that `id` depends on (its prerequisites).
function getAncestors(id, vaultRoot) {
  _ensureLoaded(vaultRoot);
  const out = [];
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const n = stack.pop();
    const outgoing = _forward.get(n);
    if (!outgoing) continue;
    for (const target of outgoing) {
      if (seen.has(target)) continue;
      seen.add(target);
      out.push(target);
      stack.push(target);
    }
  }
  return out;
}

function listEdges(vaultRoot) {
  _ensureLoaded(vaultRoot);
  return Array.from(_edges.values()).map(e => ({ ...e }));
}

function _loadFromDisk(vaultRoot) {
  const abs = _edgeLogPath(vaultRoot);
  if (!fs.existsSync(abs)) return 0;
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); }
  catch (_) { return 0; }
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); }
    catch (_) { continue; }
    if (!row || typeof row !== 'object') continue;
    const { from_id, to_id, kind, op } = row;
    if (typeof from_id !== 'string' || typeof to_id !== 'string') continue;
    if (!ALLOWED_KINDS.includes(kind)) continue;
    if (op === 'remove') {
      _removeInMemory(from_id, to_id, kind);
    } else {
      _addInMemory(from_id, to_id, kind);
      count++;
    }
  }
  return count;
}

function rebuildFromDisk(vaultRoot) {
  _edges.clear();
  _forward.clear();
  _reverse.clear();
  const count = _loadFromDisk(vaultRoot);
  _booted = true;
  _bootedRoot = vaultRoot || vault.resolveRoot();
  return count;
}

function _resetForTests() {
  _edges.clear();
  _forward.clear();
  _reverse.clear();
  _booted = false;
  _bootedRoot = null;
}

module.exports = {
  addEdge,
  removeEdge,
  getDependents,
  getAncestors,
  isCyclic,
  wouldCreateCycle,
  listEdges,
  rebuildFromDisk,
  ALLOWED_KINDS,
  _EDGE_LOG_REL: EDGE_LOG_REL,
  _resetForTests,
};
