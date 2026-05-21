'use strict';

// HYPHA · β19 Artifact Creation (Growth System §28 子组件 v0, 2026-05-16)
//
// 学习的真正信号 = 造出一个可被人用的 artifact (Track A 路径)。
// 每节课结束后 user 登记一个具体 artifact 想做或已做, 系统追踪
// commit / abandon / iterate 状态流。Anti-学完即忘 + Anti-虚学训练场。
//
// 蓝图 §28: "Artifact Creation = 把课程内容外化为可被他人审视/使用的
// 产品 (essay / repo / tweet-thread / xhs / video / slide-deck)。"
//
// Public surface:
//   createArtifact({ slug, kind, title, sourceLessonIdx?, sourceLessonTitle?,
//                    targetUrl?, notes? })
//     → { ok:true, artifact } | { ok:false, error }
//   transitionArtifact({ slug, artifactId, toState, notes? })
//     → { ok:true, artifact } | { ok:false, error }
//   listArtifacts({ slug, stateFilter?, limit? })
//     → { ok:true, artifacts } | { ok:false, error }
//   getArtifact({ slug, artifactId })
//     → { ok:true, artifact } | { ok:false, error }
//   deleteArtifact({ slug, artifactId })
//     → { ok:true } | { ok:false, error }   (soft via tombstone)
//
// Storage: vault/<slug>/.artifacts.jsonl, append-only.
//   row A — seed:          { id, ts, kind, title, state:'planned',
//                            sourceLessonIdx, sourceLessonTitle,
//                            targetUrl, notes, history:[] }
//   row B — transition:    { txId, artifactId, ts, fromState, toState, notes }
//   row C — tombstone:     { tombstoneOf, ts, tombstone:true }
// aggregate-on-read: 扫一次文件, artifactMap[id] = seed; append transitions
// into entry.history[]; tombstone rows mark `tombstone:true`.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolveRoot } = require('../vault');

// ---------------------------------------------------------------------------
// Enums + transition map
// ---------------------------------------------------------------------------

const KIND_ENUM = Object.freeze([
  'essay',
  'code-repo',
  'tweet-thread',
  'substack-post',
  'xhs-post',
  'video-script',
  'slide-deck',
  'other',
]);

const STATE_ENUM = Object.freeze([
  'planned',
  'in-progress',
  'drafted',
  'published',
  'committed',
  'iterate',
  'abandoned',
]);

// VALID_TRANSITIONS — every legal arrow in the state machine.
// Terminal states (abandoned / committed) have empty arrays.
const VALID_TRANSITIONS = Object.freeze({
  'planned':     Object.freeze(['in-progress', 'abandoned']),
  'in-progress': Object.freeze(['drafted', 'abandoned']),
  'drafted':     Object.freeze(['published', 'abandoned', 'in-progress']),
  'published':   Object.freeze(['committed', 'iterate']),
  'iterate':     Object.freeze(['drafted']),
  'abandoned':   Object.freeze([]),
  'committed':   Object.freeze([]),
});

const MAX_TITLE_LEN = 200;
const MAX_NOTES_LEN = 1000;
const MAX_URL_LEN = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _artifactsPath(slug) {
  const vaultRoot = resolveRoot();
  return path.join(vaultRoot, String(slug), '.artifacts.jsonl');
}

function _readAllRows(abs) {
  if (!fs.existsSync(abs)) return [];
  let text = '';
  try { text = fs.readFileSync(abs, 'utf-8'); }
  catch (_) { return []; }
  if (!text) return [];
  const out = [];
  for (const ln of text.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    try { out.push(JSON.parse(ln)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

// Aggregate seed rows + transition rows + tombstones → artifacts with
// history[] populated and `state` set to the latest transition's toState
// (or seed.state if no transitions). Sorted by seed ts descending (newest
// first) for typical UI listing. Tombstoned artifacts get `tombstone:true`.
function _aggregate(rows) {
  const artifactMap = new Map();
  const transitions = [];
  const tombstones = new Set();

  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (r.tombstone === true && typeof r.tombstoneOf === 'string') {
      tombstones.add(r.tombstoneOf);
      continue;
    }
    if (typeof r.artifactId === 'string' && typeof r.toState === 'string') {
      transitions.push(r);
      continue;
    }
    if (typeof r.id !== 'string' || !r.id) continue;
    artifactMap.set(r.id, {
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      title: r.title,
      state: (typeof r.state === 'string') ? r.state : 'planned',
      sourceLessonIdx: (typeof r.sourceLessonIdx === 'number') ? r.sourceLessonIdx : null,
      sourceLessonTitle: (typeof r.sourceLessonTitle === 'string') ? r.sourceLessonTitle : null,
      targetUrl: (typeof r.targetUrl === 'string') ? r.targetUrl : '',
      notes: (typeof r.notes === 'string') ? r.notes : '',
      history: [],
      tombstone: false,
    });
  }

  // Sort transitions by ts ascending — replay in chronological order so
  // `state` ends at the latest transition's toState.
  transitions.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const tx of transitions) {
    const entry = artifactMap.get(tx.artifactId);
    if (!entry) continue;
    entry.history.push({
      ts: tx.ts,
      fromState: tx.fromState,
      toState: tx.toState,
      notes: (typeof tx.notes === 'string') ? tx.notes : '',
    });
    entry.state = tx.toState;
  }

  for (const id of tombstones) {
    const entry = artifactMap.get(id);
    if (entry) entry.tombstone = true;
  }

  return Array.from(artifactMap.values());
}

function _appendRow(abs, row) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(row) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function createArtifact({
  slug,
  kind,
  title,
  sourceLessonIdx = null,
  sourceLessonTitle = null,
  targetUrl = '',
  notes = '',
} = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    if (!KIND_ENUM.includes(kind)) {
      return { ok: false, error: 'INVALID_KIND' };
    }
    const trimmedTitle = (typeof title === 'string') ? title.trim() : '';
    if (!trimmedTitle) {
      return { ok: false, error: 'TITLE_TOO_LONG', message: 'empty title' };
    }
    if (trimmedTitle.length > MAX_TITLE_LEN) {
      return { ok: false, error: 'TITLE_TOO_LONG' };
    }
    const trimmedNotes = (typeof notes === 'string')
      ? notes.trim().slice(0, MAX_NOTES_LEN)
      : '';
    const trimmedUrl = (typeof targetUrl === 'string')
      ? targetUrl.trim().slice(0, MAX_URL_LEN)
      : '';

    const seed = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      kind,
      title: trimmedTitle,
      state: 'planned',
      sourceLessonIdx: (typeof sourceLessonIdx === 'number' && Number.isFinite(sourceLessonIdx))
        ? sourceLessonIdx
        : null,
      sourceLessonTitle: (typeof sourceLessonTitle === 'string' && sourceLessonTitle.trim())
        ? sourceLessonTitle.trim()
        : null,
      targetUrl: trimmedUrl,
      notes: trimmedNotes,
    };

    const abs = _artifactsPath(slug);
    try {
      _appendRow(abs, seed);
    } catch (err) {
      return { ok: false, error: 'EXCEPTION', message: err && err.message };
    }

    return {
      ok: true,
      artifact: { ...seed, history: [], tombstone: false },
    };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function transitionArtifact({
  slug,
  artifactId,
  toState,
  notes = '',
} = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    if (!artifactId || typeof artifactId !== 'string') {
      return { ok: false, error: 'ARTIFACT_NOT_FOUND' };
    }
    if (!STATE_ENUM.includes(toState)) {
      return { ok: false, error: 'INVALID_TRANSITION' };
    }
    const abs = _artifactsPath(slug);
    const rows = _readAllRows(abs);
    const aggregated = _aggregate(rows);
    const target = aggregated.find(e => e.id === artifactId);
    if (!target || target.tombstone) {
      return { ok: false, error: 'ARTIFACT_NOT_FOUND' };
    }
    const allowed = VALID_TRANSITIONS[target.state] || [];
    if (!allowed.includes(toState)) {
      return {
        ok: false,
        error: 'INVALID_TRANSITION',
        message: `${target.state} → ${toState} not in VALID_TRANSITIONS`,
      };
    }
    const trimmedNotes = (typeof notes === 'string')
      ? notes.trim().slice(0, MAX_NOTES_LEN)
      : '';
    const txRow = {
      txId: crypto.randomUUID(),
      artifactId,
      ts: new Date().toISOString(),
      fromState: target.state,
      toState,
      notes: trimmedNotes,
    };
    try {
      _appendRow(abs, txRow);
    } catch (err) {
      return { ok: false, error: 'EXCEPTION', message: err && err.message };
    }
    const refreshed = {
      ...target,
      state: toState,
      history: [
        ...target.history,
        {
          ts: txRow.ts,
          fromState: txRow.fromState,
          toState: txRow.toState,
          notes: txRow.notes,
        },
      ],
    };
    return { ok: true, artifact: refreshed };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function listArtifacts({
  slug,
  stateFilter = null,
  limit = 50,
} = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const rows = _readAllRows(_artifactsPath(slug));
    let entries = _aggregate(rows).filter(e => !e.tombstone);
    if (typeof stateFilter === 'string' && STATE_ENUM.includes(stateFilter)) {
      entries = entries.filter(e => e.state === stateFilter);
    }
    // newest first by seed ts
    entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const cap = (typeof limit === 'number' && limit > 0) ? Math.floor(limit) : 50;
    return { ok: true, artifacts: entries.slice(0, cap) };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function getArtifact({ slug, artifactId } = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    if (!artifactId || typeof artifactId !== 'string') {
      return { ok: false, error: 'ARTIFACT_NOT_FOUND' };
    }
    const rows = _readAllRows(_artifactsPath(slug));
    const entries = _aggregate(rows);
    const target = entries.find(e => e.id === artifactId);
    if (!target || target.tombstone) {
      return { ok: false, error: 'ARTIFACT_NOT_FOUND' };
    }
    return { ok: true, artifact: target };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function deleteArtifact({ slug, artifactId } = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    if (!artifactId || typeof artifactId !== 'string') {
      return { ok: false, error: 'ARTIFACT_NOT_FOUND' };
    }
    const abs = _artifactsPath(slug);
    const rows = _readAllRows(abs);
    const entries = _aggregate(rows);
    const target = entries.find(e => e.id === artifactId);
    if (!target || target.tombstone) {
      return { ok: false, error: 'ARTIFACT_NOT_FOUND' };
    }
    const tombRow = {
      tombstoneOf: artifactId,
      ts: new Date().toISOString(),
      tombstone: true,
    };
    try {
      _appendRow(abs, tombRow);
    } catch (err) {
      return { ok: false, error: 'EXCEPTION', message: err && err.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

module.exports = {
  createArtifact,
  transitionArtifact,
  listArtifacts,
  getArtifact,
  deleteArtifact,
  _internals: {
    KIND_ENUM,
    STATE_ENUM,
    VALID_TRANSITIONS,
    MAX_TITLE_LEN,
    MAX_NOTES_LEN,
    MAX_URL_LEN,
  },
};
