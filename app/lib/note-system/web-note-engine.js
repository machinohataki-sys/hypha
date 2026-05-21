'use strict';

// HYPHA · Note System §3 (Web Note Engine) — typed-edge graph over lesson notes.
//
// Companion to:
//   - α11 `app/lib/living-note/`            — vertical (time) note reactivation
//   - β11 `app/lib/source-extractor.js`     — source-side ingestion
//
// This engine is HORIZONTAL: it lets notes (vault/<slug>/lesson-NN.md) connect
// to each other through typed edges. Storage is append-only JSONL so writes are
// crash-safe + O(1):
//
//   vault/<slug>/note-edges.jsonl
//     row A:  {ts, edge_id, from_idx, to_idx, type, label?, evidence?}
//     row B:  {edge_id, action:'remove'}        ← soft-delete tombstone
//
// listEdges replays the log keeping LAST writer per edge_id; tombstones erase.
//
// Surface — 5 typed edges, frozen:
//   cites        — A 引用 B 的内容
//   contradicts  — A 与 B 观点冲突
//   extends      — A 延伸 B 的论点
//   triggered-by — A 是因为读了 B 而写的
//   related      — A 与 B 主题相关 (默认弱关系)
//
// LLM auto-inference uses executeChat('T4_JUDGE') against the most recent 5
// peer notes. Wire-up to /finish ritual is deferred (see TODO below).
//
// Path resolution mirrors lesson-note.js + living-note: HYPHA_VAULT_DIR /
// HYPHA_DATA / HYPHA_VAULT_ROOT win in that order, otherwise fall back to
// hypha/vault. PTOR_VAULT kept for cross-product compat.
//
// Pure fs + LLM router. No Electron. Renderer is reached via IPC layer in
// app/main.js + app/preload.js (see § 'IPC contract' below).
//
// SECURITY: slug + idx are sanitized before being interpolated into a path —
// any `..` / non-`[A-Za-z0-9_-]` slug, or non-integer idx, is rejected.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// =====================================================================
// Constants — 5 typed edges, frozen so callers can === compare safely.
// =====================================================================

const EDGE_TYPES = Object.freeze([
  'cites',         // A 引用 B 的内容
  'contradicts',   // A 与 B 观点冲突
  'extends',       // A 延伸 B 的论点
  'triggered-by',  // A 是因为读了 B 而写的
  'related',       // A 与 B 主题相关 (默认弱关系)
]);
const EDGE_TYPE_SET = new Set(EDGE_TYPES);

const EDGES_FILENAME = 'note-edges.jsonl';
const INFER_RECENT_LIMIT = 5; // how many prior peer notes to compare against
const SUMMARY_CHAR_BUDGET = 100;

// =====================================================================
// Path helpers — single source of truth for vault root, mirrors lesson-note.
// =====================================================================

function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  if (process.env.HYPHA_VAULT_ROOT && fs.existsSync(process.env.HYPHA_VAULT_ROOT)) {
    return process.env.HYPHA_VAULT_ROOT;
  }
  if (process.env.PTOR_VAULT && fs.existsSync(process.env.PTOR_VAULT)) {
    return process.env.PTOR_VAULT;
  }
  return path.resolve(__dirname, '..', '..', '..', 'vault');
}

function _sanitizeSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) return null;
  // CJK + ASCII alnum + - _ . — matches slugify() output domain.
  if (!/^[\w\-.一-鿿]+$/.test(slug)) return null;
  return slug;
}

function _slugDir(slug) {
  const safe = _sanitizeSlug(slug);
  if (!safe) throw new Error('web-note-engine: invalid slug');
  return path.join(_vaultRoot(), safe);
}

function _edgesPath(slug) {
  return path.join(_slugDir(slug), EDGES_FILENAME);
}

function _ensureSlugDir(slug) {
  const dir = _slugDir(slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _isIdx(n) {
  return Number.isInteger(n) && n >= 0 && n < 10_000;
}

function _newEdgeId() {
  return 'ne-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

// =====================================================================
// Event emission — best-effort, never blocks CRUD.
// =====================================================================

function _emit(slug, event) {
  try {
    const events = require('../events');
    events.write(slug, event);
  } catch (_) {
    // events module optional in test context — silent fallthrough is OK
    // because edges.jsonl is the source-of-truth, not the event log.
  }
}

// =====================================================================
// CRUD — append-only with soft-delete tombstones.
// =====================================================================

function _validateEdge(edge) {
  if (!edge || typeof edge !== 'object') return 'edge must be an object';
  if (!_isIdx(edge.from_idx)) return 'from_idx must be an integer ≥ 0';
  if (!_isIdx(edge.to_idx)) return 'to_idx must be an integer ≥ 0';
  if (edge.from_idx === edge.to_idx) return 'self-edge disallowed (from_idx === to_idx)';
  if (!EDGE_TYPE_SET.has(edge.type)) {
    return `type must be one of ${EDGE_TYPES.join('|')}`;
  }
  if (edge.label != null && typeof edge.label !== 'string') return 'label must be string';
  if (edge.evidence != null && typeof edge.evidence !== 'string') return 'evidence must be string';
  return null;
}

/**
 * Append a typed edge to vault/<slug>/note-edges.jsonl.
 * @param {string} slug
 * @param {{from_idx:number, to_idx:number, type:string, label?:string, evidence?:string}} edge
 * @returns {{ok:true, edge_id:string} | {ok:false, error:string}}
 */
function addEdge(slug, edge) {
  const safe = _sanitizeSlug(slug);
  if (!safe) return { ok: false, error: 'invalid slug' };
  const err = _validateEdge(edge);
  if (err) return { ok: false, error: err };

  _ensureSlugDir(safe);
  const edge_id = _newEdgeId();
  const row = {
    ts: new Date().toISOString(),
    edge_id,
    from_idx: edge.from_idx,
    to_idx: edge.to_idx,
    type: edge.type,
  };
  if (edge.label) row.label = String(edge.label).slice(0, 80);
  if (edge.evidence) row.evidence = String(edge.evidence).slice(0, 240);

  fs.appendFileSync(_edgesPath(safe), JSON.stringify(row) + '\n', 'utf8');
  _emit(safe, {
    type: 'note_edge_added',
    edge_id,
    from_idx: row.from_idx,
    to_idx: row.to_idx,
    edge_type: row.type,
  });
  return { ok: true, edge_id };
}

function _readJsonlRows(slug) {
  const safe = _sanitizeSlug(slug);
  if (!safe) return [];
  const p = _edgesPath(safe);
  if (!fs.existsSync(p)) return [];
  let raw = '';
  try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { return []; }
  if (!raw.trim()) return [];
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); } catch (_) { /* skip malformed line */ }
  }
  return rows;
}

/**
 * Replay log → return live (non-tombstoned) edges, optionally filtered.
 * @param {string} slug
 * @param {{from_idx?:number, to_idx?:number, type?:string}} [filter]
 * @returns {Array<object>}
 */
function listEdges(slug, filter = {}) {
  const rows = _readJsonlRows(slug);
  const byId = new Map();
  for (const r of rows) {
    if (!r || !r.edge_id) continue;
    if (r.action === 'remove') {
      byId.delete(r.edge_id);
      continue;
    }
    // Only the first creation row counts; subsequent non-remove rows with the
    // same edge_id are ignored (we don't support edit — re-add a new edge).
    if (!byId.has(r.edge_id)) byId.set(r.edge_id, r);
  }
  const out = [];
  for (const e of byId.values()) {
    if (filter.from_idx != null && e.from_idx !== filter.from_idx) continue;
    if (filter.to_idx != null && e.to_idx !== filter.to_idx) continue;
    if (filter.type && e.type !== filter.type) continue;
    out.push(e);
  }
  return out;
}

/**
 * Soft-delete: append a `{edge_id, action:'remove'}` tombstone row.
 * listEdges will filter it out on next read.
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function removeEdge(slug, edge_id) {
  const safe = _sanitizeSlug(slug);
  if (!safe) return { ok: false, error: 'invalid slug' };
  if (!edge_id || typeof edge_id !== 'string') {
    return { ok: false, error: 'edge_id required (string)' };
  }
  _ensureSlugDir(safe);
  const tomb = { ts: new Date().toISOString(), edge_id, action: 'remove' };
  fs.appendFileSync(_edgesPath(safe), JSON.stringify(tomb) + '\n', 'utf8');
  _emit(safe, { type: 'note_edge_removed', edge_id });
  return { ok: true };
}

/**
 * For a given note index, return live edges split into incoming + outgoing.
 * `outgoing` = note is the `from_idx`; `incoming` = note is the `to_idx`.
 * @param {string} slug
 * @param {number} note_idx
 * @param {{type?:string}} [opts]
 * @returns {{incoming:Array, outgoing:Array}}
 */
function getNeighbors(slug, note_idx, opts = {}) {
  if (!_isIdx(note_idx)) return { incoming: [], outgoing: [] };
  const all = listEdges(slug, opts.type ? { type: opts.type } : {});
  const incoming = [];
  const outgoing = [];
  for (const e of all) {
    if (e.from_idx === note_idx) outgoing.push(e);
    if (e.to_idx === note_idx) incoming.push(e);
  }
  return { incoming, outgoing };
}

// =====================================================================
// LLM inference — propose typed edges by reading the new lesson body
// against the most recent peer notes.
// =====================================================================

function _stripFrontmatter(text) {
  if (typeof text !== 'string') return '';
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  return end >= 0 ? text.slice(end + 4) : text;
}

function _summarize(text, charBudget = SUMMARY_CHAR_BUDGET) {
  const body = _stripFrontmatter(String(text || '')).replace(/\s+/g, ' ').trim();
  if (body.length <= charBudget) return body;
  return body.slice(0, charBudget).trim() + '…';
}

function _listLessonFiles(slug) {
  const dir = _slugDir(slug);
  if (!fs.existsSync(dir)) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = /^lesson-(\d+)\.md$/i.exec(e.name);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (!_isIdx(idx)) continue;
    const abs = path.join(dir, e.name);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(abs).mtimeMs; } catch (_) { /* keep 0 */ }
    out.push({ idx, abs, mtimeMs });
  }
  return out;
}

function _safeReadFile(abs) {
  try { return fs.readFileSync(abs, 'utf8'); } catch (_) { return ''; }
}

function _gatherPeerSummaries(slug, lessonIdx, limit = INFER_RECENT_LIMIT) {
  const files = _listLessonFiles(slug).filter(f => f.idx !== lessonIdx);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, limit).map(f => ({
    idx: f.idx,
    summary: _summarize(_safeReadFile(f.abs)),
  }));
}

const INFER_SYSTEM_PROMPT = '你在帮一位学习者建认知图谱. 你按规则在两段笔记之间提议 typed edge, 不做评价, 不做扩写, 不浮夸. 只在真有连接时才标, 一对最多 1 个 edge. 输出 JSON, 严格遵循 schema.';

function _buildInferUserPrompt(currentSummary, peers) {
  const lines = [];
  lines.push('当前新写的 lesson note:');
  lines.push(currentSummary || '(空)');
  lines.push('');
  lines.push(`最近 ${peers.length} 个 notes:`);
  peers.forEach((p, i) => {
    lines.push(`${i + 1}. [lesson-${p.idx}] ${p.summary || '(空)'}`);
  });
  lines.push('');
  lines.push('为每对 (current, prev_i), 判断:');
  lines.push('- 有无 typed edge? 类型 ∈ {cites, contradicts, extends, triggered-by, related, NONE}');
  lines.push('  · cites        — current 引用 prev 的具体内容');
  lines.push('  · contradicts  — current 与 prev 观点冲突');
  lines.push('  · extends      — current 延伸 prev 的论点');
  lines.push('  · triggered-by — current 是因为读了 prev 而写的');
  lines.push('  · related      — 主题相关但无以上具体关系 (弱关系, 谨慎)');
  lines.push('- 若有, 一句 evidence 引述具体内容 (≤ 30 字, 不浮夸)');
  lines.push('');
  lines.push('规则:');
  lines.push('- 默认 NONE; 只有真有连接才标');
  lines.push('- 一对 notes 最多 1 个 edge type');
  lines.push('- evidence ≤ 30 字');
  lines.push('- 不要硬凑');
  lines.push('');
  lines.push('输出 JSON: {"edges": [{"to_idx": <int>, "type": "<edge_type>", "evidence": "<= 30 字"}, ...]}');
  lines.push('NONE 的对不要出现在 edges 数组里.');
  return lines.join('\n');
}

function _coerceInferResult(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const arr = Array.isArray(raw.edges) ? raw.edges : [];
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const to_idx = typeof e.to_idx === 'number' ? e.to_idx : parseInt(e.to_idx, 10);
    if (!_isIdx(to_idx)) continue;
    if (!EDGE_TYPE_SET.has(e.type)) continue;
    const evidence = typeof e.evidence === 'string'
      ? e.evidence.trim().slice(0, 60)
      : undefined;
    out.push({ to_idx, type: e.type, evidence });
  }
  return out;
}

/**
 * Use T4_JUDGE to propose typed edges between a freshly-written lesson note
 * and the most recent N peer notes. Auto-persists each proposed edge via
 * addEdge and returns a summary + the raw proposed list.
 *
 * Side-effects: appends rows to vault/<slug>/note-edges.jsonl and emits
 * `note_edge_added` events for each successful addEdge.
 *
 * v0.5.1 wiring TODO: call from /finish ritual end-of-lesson — see note below.
 *
 * @param {string} slug
 * @param {number} lessonIdx                 — idx of the new lesson note
 * @param {string} lessonText                — full lesson body (markdown OK; frontmatter is stripped)
 * @param {object} [settings]
 * @param {string} [settings.capability]     — default 'T4_JUDGE'
 * @param {number} [settings.maxTokens]      — default 800
 * @param {number} [settings.timeoutMs]      — default 45_000
 * @returns {Promise<{ok:boolean, proposed_edges:Array, summary:{considered:number, proposed:number, written:number}, error?:string}>}
 */
async function inferEdgesFromText(slug, lessonIdx, lessonText, settings = {}) {
  const safe = _sanitizeSlug(slug);
  if (!safe) return { ok: false, error: 'invalid slug', proposed_edges: [], summary: { considered: 0, proposed: 0, written: 0 } };
  if (!_isIdx(lessonIdx)) {
    return { ok: false, error: 'lessonIdx must be integer ≥ 0', proposed_edges: [], summary: { considered: 0, proposed: 0, written: 0 } };
  }
  if (typeof lessonText !== 'string' || !lessonText.trim()) {
    return { ok: false, error: 'lessonText required (non-empty string)', proposed_edges: [], summary: { considered: 0, proposed: 0, written: 0 } };
  }

  const peers = _gatherPeerSummaries(safe, lessonIdx, INFER_RECENT_LIMIT);
  if (peers.length === 0) {
    return {
      ok: true,
      proposed_edges: [],
      summary: { considered: 0, proposed: 0, written: 0, reason: 'no peer notes yet' },
    };
  }

  // Lazy-require so callers that don't use LLM (tests / pure-CRUD use) don't
  // pay for executeChat() import cost.
  let executeChat;
  try { ({ executeChat } = require('../llm')); }
  catch (err) {
    return {
      ok: false,
      error: 'llm router unavailable: ' + (err && err.message),
      proposed_edges: [],
      summary: { considered: peers.length, proposed: 0, written: 0 },
    };
  }

  const capability = settings.capability || 'T4_JUDGE';
  const currentSummary = _summarize(lessonText, SUMMARY_CHAR_BUDGET);
  const messages = [
    { role: 'system', content: INFER_SYSTEM_PROMPT },
    { role: 'user', content: _buildInferUserPrompt(currentSummary, peers) },
  ];

  let dispatch;
  try {
    dispatch = await executeChat(capability, {
      messages,
      json: true,
      temperature: 0.2,
      maxTokens: settings.maxTokens || 800,
      timeoutMs: settings.timeoutMs || 45_000,
    });
  } catch (err) {
    return {
      ok: false,
      error: 'executeChat failed: ' + (err && err.message),
      proposed_edges: [],
      summary: { considered: peers.length, proposed: 0, written: 0 },
    };
  }

  // Some providers return result as a JSON-encoded string when json:true is
  // honoured at the wire layer only. Tolerate both shapes.
  let parsed = dispatch && dispatch.result;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (_) { parsed = null; }
  }
  const proposed = _coerceInferResult(parsed);

  // Validate to_idx exists among peer set (defend against hallucination).
  const peerIdxSet = new Set(peers.map(p => p.idx));
  const filtered = proposed.filter(p => peerIdxSet.has(p.to_idx) && p.to_idx !== lessonIdx);

  let written = 0;
  for (const p of filtered) {
    const res = addEdge(safe, {
      from_idx: lessonIdx,
      to_idx: p.to_idx,
      type: p.type,
      evidence: p.evidence,
    });
    if (res.ok) written++;
  }

  return {
    ok: true,
    proposed_edges: filtered,
    summary: {
      considered: peers.length,
      proposed: filtered.length,
      written,
      capability,
      providerId: dispatch && dispatch.providerId,
      model: dispatch && dispatch.model,
    },
  };
}

// =====================================================================
// Integration handoffs (deferred per task spec — not wired in this ship)
// =====================================================================
//
// 1. **/finish ritual auto-wire** — intentional-placeholder: task spec
//    explicitly says "本任务只 ship 模块 + IPC, 不真接 finish". Wiring point
//    (after v0.5.1 ships the trigger) lives in `app/lib/finish-ritual.js`
//    final-body lane:
//
//      const wne = require('./note-system/web-note-engine');
//      await wne.inferEdgesFromText(slug, lessonIdx, lessonText);
//
//    Call is fire-and-forget; failure must not block the finish handoff.
//
// 2. **UI surfacing (NoteEdgeCard)** — intentional-placeholder: task spec
//    defers the UI tag-row + click-jump to v0.5.2. When the design lands,
//    the component reads:
//
//      const { incoming, outgoing } = wne.getNeighbors(slug, lessonIdx);
//
//    and renders "本 note 连接到 lesson-3 (cites) + lesson-7 (contradicts)"
//    above the lesson chat. Owning surface lives in app/design/ or
//    app/ui_kits/ptor-app/NoteView.jsx — final component path pending
//    v0.5.2 design pass.
// =====================================================================

module.exports = {
  // CRUD
  addEdge,
  listEdges,
  removeEdge,
  getNeighbors,
  // LLM inference
  inferEdgesFromText,
  // Constants
  EDGE_TYPES,
  // Internals exposed for tests / surgical IPC integration
  _internals: {
    vaultRoot: _vaultRoot,
    sanitizeSlug: _sanitizeSlug,
    edgesPath: _edgesPath,
    listLessonFiles: _listLessonFiles,
    gatherPeerSummaries: _gatherPeerSummaries,
    buildInferUserPrompt: _buildInferUserPrompt,
    coerceInferResult: _coerceInferResult,
  },
};
