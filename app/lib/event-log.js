// ptor/app/corpus/event-log.js
//
// DUAL-READER SUBSTRATE — append-only event log for the personal corpus.
// Per 2026-04-27 PTOR pivot dialectic (Leo W=exploration, [BET] confirmed):
// every .md in vault is BOTH human-rendered AND machine-readable. This file
// is the substrate's machine surface — every read/write/recall/cite/verdict
// event lands here as a JSONL row.
//
// Why an event log (not a counters table):
//   1. Append-only is atomic enough for solo user without locking
//   2. Replay from log → derive any aggregate (recall_count, cite_count,
//      last_read, agent affinity, decay state, ...) without a schema
//      migration when we add a new aggregate later
//   3. Corpus value compounds at READER FREQUENCY (atom A3): humans read
//      ~weekly, agents ~hourly. Agent events 100× human events. The log
//      captures both at the same fidelity, so reinforce.js (Build #2) can
//      weight them equally OR differently as we tune
//   4. Event taxonomy is the SCHLEP (Leo L11 SCHLEP_PREMIUM): hand-cast,
//      not auto-derived. Generic taxonomies = no moat. The 6 ops below
//      are deliberately Victor-specific — Federdruck verdict isn't in
//      a textbook event vocabulary
//
// Storage: <vault>/.beiking/event-log.jsonl (sibling to rag-index.json).
// Format: one JSON object per line, no trailing comma. Schema below.
//
// Event schema:
//   {
//     ts:       <ISO 8601 string>      // when the event happened
//     op:       <one of OPS>           // hand-cast taxonomy, see below
//     file:     <vault-relative path>  // which note the event applies to
//     agent_id: <string | null>        // 'human' | 'claude' | 'codex' |
//                                      // 'gemini' | 'lung' | ... | null
//     sim?:     <number 0-1>           // for 'recall' / 'cite' — semantic
//                                      // similarity that triggered the event
//     weight?:  <number>               // for 'verdict' — Federdruck weight
//                                      // (1=smooth / 2=shaky / 3=held)
//     meta?:    <object>               // op-specific bag (excerpt, query, ...)
//   }
//
// API:
//   record(vaultRoot, event)               → void                  (append 1)
//   recordBatch(vaultRoot, events)         → void                  (append N)
//   readAll(vaultRoot, filter?)            → AsyncIterable<event>  (replay)
//   aggregate(vaultRoot, fileRel?)         → Aggregate | Map<rel,Aggregate>
//   logPath(vaultRoot)                     → absolute path
//
// Aggregate shape (consumed by reinforce.js):
//   {
//     read_count, write_count, recall_count, cite_count, verdict_count,
//     deepen_count, agent_read_count, human_read_count,
//     last_event_ts, last_read_ts, last_cite_ts, last_verdict_weight,
//     verdicts: { held: N, shaky: N, smooth: N },   // per-class counters so
//                                                   // reinforce can weight
//                                                   // EACH cast independently
//                                                   // (not just last)
//     agents: { <agent_id>: <count>, ... }
//   }

'use strict';

const fs   = require('node:fs');
const fsp  = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const LOG_REL = path.join('.beiking', 'event-log.jsonl');
const SCHEMA_VERSION = 1;

// ─── HAND-CAST EVENT TAXONOMY (the schlep / the moat) ───────────────────
//
// These 6 ops cover Victor's actual workflow, not a generic note-app set.
// Adding/removing requires explicit thought — auto-derived ops are forbidden
// per Leo L11 SCHLEP_PREMIUM ruling.
const OPS = Object.freeze({
  // Note opened in human-surface renderer (NoteView.jsx mounts the file).
  // Triggers from human surface only — agents don't trigger 'read'.
  READ: 'read',

  // Note created or modified on disk. Ground truth from main-handlers' file
  // watch + explicit save. Distinguishes from 'read' (no content change).
  WRITE: 'write',

  // Note returned in a search result (vault-index cosine hit). HUMAN query.
  // sim field carries cosine score so reinforce.js can weight by quality.
  RECALL: 'recall',

  // Note pulled by an AGENT through MCP corpus_query tool (Build #3).
  // 100× more frequent than RECALL once agents are wired. The compounding
  // signal that drives the moat per atom A3 (cybernetic gain ∝ frequency).
  CITE: 'cite',

  // Federdruck SRS verdict cast by user (held=3 / shaky=2 / smooth=1).
  // weight field carries the cast. Highest-quality reinforcement signal —
  // explicit human judgment, not just exposure.
  VERDICT: 'verdict',

  // /deepen invoked on the note (LLM tail step). Per future atlas-reflect:
  // deepen events that produce blueprint connections also tag the atlas.
  DEEPEN: 'deepen',

  // V2 LLM Wiki: an article's _wiki frontmatter or body was updated by the
  // distiller or writeback. agent_id distinguishes 'synth-writeback' (post-
  // synth evidence append) from 'distill' (frontmatter re-distill on save or
  // /wiki-rebuild). meta.change_type ∈ {'created','distilled','evidence_appended'}.
  ARTICLE_UPDATED: 'article_updated',

  // V2 LLM Wiki: a new graph edge was discovered between two articles. Either
  // declared in source.frontmatter._wiki.links_to (distill) or inferred from
  // [WIKI:slug] cite chain (synth). meta = { src, dst, source: 'distill'|'synth-cite' }.
  GRAPH_EDGE_ADDED: 'graph_edge_added',
});

const OP_VALUES = new Set(Object.values(OPS));

function logPath(vaultRoot) {
  return path.join(vaultRoot, LOG_REL);
}

function ensureLogDir(vaultRoot) {
  const dir = path.dirname(logPath(vaultRoot));
  fs.mkdirSync(dir, { recursive: true });
}

function validateEvent(ev) {
  if (!ev || typeof ev !== 'object') throw new Error('event must be an object');
  if (!ev.op || !OP_VALUES.has(ev.op)) {
    throw new Error(`event.op must be one of ${[...OP_VALUES].join('|')}; got ${ev.op}`);
  }
  if (!ev.file || typeof ev.file !== 'string') {
    throw new Error('event.file (vault-relative path) is required');
  }
  // Reject absolute paths — log only relative-to-vault to stay portable
  if (path.isAbsolute(ev.file)) {
    throw new Error('event.file must be vault-relative, not absolute');
  }
}

function normalizeEvent(ev) {
  const out = {
    ts: ev.ts || new Date().toISOString(),
    op: ev.op,
    file: ev.file.replace(/\\/g, '/'),  // store forward-slash uniformly
    agent_id: ev.agent_id || (ev.op === OPS.CITE ? null : 'human'),
  };
  if (typeof ev.sim === 'number') out.sim = Math.round(ev.sim * 10000) / 10000;
  if (typeof ev.weight === 'number') out.weight = ev.weight;
  if (ev.meta && typeof ev.meta === 'object') out.meta = ev.meta;
  return out;
}

/**
 * Append one event. Synchronous fs.appendFileSync — atomic on a single line
 * for a solo user. Re-entry-safe across renderer and main process because
 * each call is one syscall with O_APPEND semantics.
 */
function record(vaultRoot, event) {
  validateEvent(event);
  const ev = normalizeEvent(event);
  ensureLogDir(vaultRoot);
  fs.appendFileSync(logPath(vaultRoot), JSON.stringify(ev) + '\n', 'utf8');
  _aggCacheInvalidate(vaultRoot, ev.file);
  _agentTraceCacheInvalidate(vaultRoot, ev.file);
}

/** Atomic batch append — single fs write, one line per event. */
function recordBatch(vaultRoot, events) {
  if (!Array.isArray(events) || events.length === 0) return;
  events.forEach(validateEvent);
  const normalized = events.map(e => normalizeEvent(e));
  const lines = normalized.map(e => JSON.stringify(e)).join('\n') + '\n';
  ensureLogDir(vaultRoot);
  fs.appendFileSync(logPath(vaultRoot), lines, 'utf8');
  // Invalidate cache for every distinct rel touched in batch
  const seen = new Set();
  for (const e of normalized) {
    if (e.file && !seen.has(e.file)) {
      _aggCacheInvalidate(vaultRoot, e.file);
      _agentTraceCacheInvalidate(vaultRoot, e.file);
      seen.add(e.file);
    }
  }
}

/**
 * Stream events as an async iterator. Filter is optional:
 *   { since: ISO string, op: string|string[], file: string, agent_id: string }
 * Streaming (not full readFile) so a multi-MB log scales.
 */
async function* readAll(vaultRoot, filter = {}) {
  const p = logPath(vaultRoot);
  try {
    await fsp.access(p);
  } catch { return; }

  const opSet = filter.op
    ? new Set(Array.isArray(filter.op) ? filter.op : [filter.op])
    : null;
  const sinceMs = filter.since ? Date.parse(filter.since) : 0;
  const fileMatch = filter.file || null;
  const agentMatch = filter.agent_id || null;

  const stream = fs.createReadStream(p, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); }
    catch { continue; }  // skip corrupt lines silently — log corruption is non-fatal
    if (opSet && !opSet.has(ev.op)) continue;
    if (sinceMs && Date.parse(ev.ts) < sinceMs) continue;
    if (fileMatch && ev.file !== fileMatch) continue;
    if (agentMatch && ev.agent_id !== agentMatch) continue;
    yield ev;
  }
}

function emptyAggregate() {
  return {
    read_count: 0,
    write_count: 0,
    recall_count: 0,
    cite_count: 0,
    verdict_count: 0,
    deepen_count: 0,
    agent_read_count: 0,
    human_read_count: 0,
    last_event_ts: null,
    last_read_ts: null,
    last_cite_ts: null,
    last_verdict_weight: null,
    verdicts: { held: 0, shaky: 0, smooth: 0 },
    agents: {},
  };
}

const VERDICT_NAME = { 3: 'held', 2: 'shaky', 1: 'smooth' };

function fold(agg, ev) {
  switch (ev.op) {
    case OPS.READ:    agg.read_count++; agg.last_read_ts = ev.ts; break;
    case OPS.WRITE:   agg.write_count++; break;
    case OPS.RECALL:  agg.recall_count++; break;
    case OPS.CITE:    agg.cite_count++; agg.last_cite_ts = ev.ts; break;
    case OPS.VERDICT: {
      agg.verdict_count++;
      agg.last_verdict_weight = ev.weight ?? null;
      const klass = VERDICT_NAME[ev.weight];
      if (klass) agg.verdicts[klass]++;
      break;
    }
    case OPS.DEEPEN:  agg.deepen_count++; break;
  }
  if (ev.agent_id === 'human') agg.human_read_count += (ev.op === OPS.READ ? 1 : 0);
  else if (ev.agent_id) agg.agent_read_count += (ev.op === OPS.CITE || ev.op === OPS.RECALL ? 1 : 0);
  if (ev.agent_id) agg.agents[ev.agent_id] = (agg.agents[ev.agent_id] || 0) + 1;
  agg.last_event_ts = ev.ts;
}

// per-rel aggregate cache — invalidated by record() when a new event lands
// for that rel. Bounded LRU (capacity 50, TTL 30s) so memory stays tame.
// Fix #3 per user 2026-04-29 切笔记卡顿留白: aggregate full-scan was 100-300ms
// on a multi-MB log; cache hit is ~0.1ms.
const _aggregateCache = new Map();
const AGGREGATE_TTL = 30_000;
const AGGREGATE_CAPACITY = 50;

function _aggCacheGet(vaultRoot, fileRel) {
  const key = vaultRoot + '::' + fileRel;
  const e = _aggregateCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > AGGREGATE_TTL) { _aggregateCache.delete(key); return null; }
  return e.agg;
}
function _aggCacheSet(vaultRoot, fileRel, agg) {
  const key = vaultRoot + '::' + fileRel;
  _aggregateCache.set(key, { agg, ts: Date.now() });
  if (_aggregateCache.size > AGGREGATE_CAPACITY) {
    const oldest = _aggregateCache.keys().next().value;
    _aggregateCache.delete(oldest);
  }
}
function _aggCacheInvalidate(vaultRoot, fileRel) {
  if (!fileRel) return;
  _aggregateCache.delete(vaultRoot + '::' + fileRel);
}

/**
 * Aggregate the log. If fileRel is given → return one Aggregate for that
 * file. Otherwise → return Map<fileRel, Aggregate> for the whole vault.
 * Per-rel path cached (TTL 30s, invalidated on record()); bulk path uncached.
 */
async function aggregate(vaultRoot, fileRel = null) {
  if (fileRel) {
    const cached = _aggCacheGet(vaultRoot, fileRel);
    if (cached) return cached;
    const agg = emptyAggregate();
    for await (const ev of readAll(vaultRoot, { file: fileRel })) fold(agg, ev);
    _aggCacheSet(vaultRoot, fileRel, agg);
    return agg;
  }
  const map = new Map();
  for await (const ev of readAll(vaultRoot)) {
    if (!map.has(ev.file)) map.set(ev.file, emptyAggregate());
    fold(map.get(ev.file), ev);
  }
  return map;
}

/**
 * agentTrace — last N agent events for a file, reverse-chronological. Powers
 * the AGENT-TRACE RIBBON in col-3 (per /tr 2026-04-29 全体议会 + Muse UNATTACKED
 * gift): col-3 displays "council's footprints in the margin" — which agent
 * cited / deepened / verdict-cast on this note, when, and what the action was.
 *
 * Filters out high-frequency 'human' read events (too noisy — happens on every
 * note open). Keeps human writes/verdicts (rare, intentional) + ALL agent ops.
 *
 * @param {string} vaultRoot - vault directory path
 * @param {string} fileRel - vault-relative file path
 * @param {number} limit - max events (default 10)
 * @returns {Promise<Array<{ts, op, agent_id, meta?, sim?, weight?}>>}
 */
// agentTrace cache — 30s TTL per (root, rel, limit) tuple. Invalidated by
// record() when a new event lands for that rel. Fix C 2026-04-29 卡顿修复.
const _agentTraceCache = new Map();
const TRACE_TTL = 30_000;
const TRACE_CAPACITY = 30;

async function agentTrace(vaultRoot, fileRel, limit = 10) {
  if (!fileRel) return [];
  const lim = Math.max(1, Math.min(50, limit | 0));
  const key = vaultRoot + '::' + fileRel + '::' + lim;
  const cached = _agentTraceCache.get(key);
  if (cached && (Date.now() - cached.ts) < TRACE_TTL) return cached.trace;
  const events = [];
  for await (const ev of readAll(vaultRoot, { file: fileRel })) {
    events.push({
      ts: ev.ts,
      op: ev.op,
      agent_id: ev.agent_id || 'human',
      meta: ev.meta || null,
      sim: typeof ev.sim === 'number' ? ev.sim : undefined,
      weight: typeof ev.weight === 'number' ? ev.weight : undefined,
    });
  }
  const trace = events
    .filter(e => e.agent_id !== 'human' || e.op === OPS.WRITE || e.op === OPS.VERDICT)
    .reverse()
    .slice(0, lim);
  _agentTraceCache.set(key, { trace, ts: Date.now() });
  if (_agentTraceCache.size > TRACE_CAPACITY) {
    _agentTraceCache.delete(_agentTraceCache.keys().next().value);
  }
  return trace;
}

function _agentTraceCacheInvalidate(vaultRoot, fileRel) {
  if (!fileRel) return;
  const prefix = vaultRoot + '::' + fileRel + '::';
  for (const k of [..._agentTraceCache.keys()]) {
    if (k.startsWith(prefix)) _agentTraceCache.delete(k);
  }
}

module.exports = {
  OPS,
  SCHEMA_VERSION,
  logPath,
  record,
  recordBatch,
  readAll,
  aggregate,
  agentTrace,
};
