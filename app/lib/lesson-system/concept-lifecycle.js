'use strict';

// HYPHA · 阶 3 北极星 metric — Concept Lifecycle store (2026-05-17).
//
// 把 "lessons.length" 工业课时 metric 换成 mastery_concepts_ratified +
// spark_matured + artifacts_shipped 三柱 (per LEO axiom + SCOUT 2026 frontier)。
// 这个文件是 ratified 计数器的源 — 每个 concept 走 draft → review → ratified
// 的 lifecycle, 用户标 ratify 时计数 + 1, 标 deprecated 时计数 - 1。
//
// 设计原则 (与 β17 Judgment Gym + α19 Privacy Memory 一致):
//   - append-only jsonl, 不重写
//   - aggregate-on-read, latest row 决定 currentState
//   - 不 SQLite, 不数据库, 纯文件
//
// Storage: <vaultRoot>/<slug>/.concept-lifecycle.jsonl
//   row A — seed:        { id, ts, slug, conceptId, name, source_lesson_idx,
//                          evidence_lesson_idxs:[], state:'draft' }
//   row B — transition:  { txId, conceptId, ts, fromState, toState }
//
// Public surface:
//   addConcept({ slug, name, source_lesson_idx?, evidence_lesson_idxs? })
//     → { ok:true, concept } | { ok:false, error }
//   transitionConcept({ slug, conceptId, newState })
//     → { ok:true, concept } | { ok:false, error }
//   listConcepts({ slug, stateFilter? })
//     → { ok:true, concepts } | { ok:false, error }
//   countByState({ slug })
//     → { ok:true, counts:{draft,review,ratified,superseded,deprecated} }

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolveRoot } = require('../vault');

// ---------------------------------------------------------------------------
// Enums + transition matrix
// ---------------------------------------------------------------------------

const STATE_ENUM = Object.freeze([
  'draft',
  'review',
  'ratified',
  'superseded',
  'deprecated',
]);

// Per spec:
//   draft      → review | deprecated
//   review     → ratified | draft | deprecated
//   ratified   → superseded | deprecated
//   superseded → deprecated
//   deprecated → (terminal)
const VALID_TRANSITIONS = Object.freeze({
  draft:      Object.freeze(['review', 'deprecated']),
  review:     Object.freeze(['ratified', 'draft', 'deprecated']),
  ratified:   Object.freeze(['superseded', 'deprecated']),
  superseded: Object.freeze(['deprecated']),
  deprecated: Object.freeze([]),
});

const MAX_NAME_LEN = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _slugFile(slug) {
  const root = resolveRoot();
  const dir = path.join(root, String(slug));
  return path.join(dir, '.concept-lifecycle.jsonl');
}

function _ensureDir(abs) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
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

function _appendRow(abs, row) {
  _ensureDir(abs);
  fs.appendFileSync(abs, JSON.stringify(row) + '\n', 'utf-8');
}

function _validateSlug(slug) {
  return typeof slug === 'string' && slug.trim().length > 0;
}

// Aggregate: seed rows → concept map; transitions replay chronologically;
// state ends at latest transition's toState (or seed.state if none).
function _aggregate(rows) {
  const seeds = new Map();
  const transitions = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.txId === 'string' && typeof r.conceptId === 'string'
        && typeof r.toState === 'string') {
      transitions.push(r);
      continue;
    }
    if (typeof r.conceptId !== 'string' || !r.conceptId) continue;
    seeds.set(r.conceptId, {
      conceptId: r.conceptId,
      ts: r.ts,
      slug: r.slug,
      name: r.name,
      source_lesson_idx: (typeof r.source_lesson_idx === 'number')
        ? r.source_lesson_idx
        : null,
      evidence_lesson_idxs: Array.isArray(r.evidence_lesson_idxs)
        ? r.evidence_lesson_idxs.slice()
        : [],
      state: (typeof r.state === 'string' && STATE_ENUM.includes(r.state))
        ? r.state
        : 'draft',
      lastTransitionAt: null,
    });
  }
  transitions.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const tx of transitions) {
    const entry = seeds.get(tx.conceptId);
    if (!entry) continue;
    entry.state = tx.toState;
    entry.lastTransitionAt = tx.ts;
  }
  return Array.from(seeds.values());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a new concept seed row, state='draft'.
 * @param {object} params
 * @param {string} params.slug
 * @param {string} params.name
 * @param {string} [params.conceptId]   — optional explicit id (default uuid)
 * @param {number|null} [params.source_lesson_idx]
 * @param {number[]} [params.evidence_lesson_idxs]
 * @returns {Promise<{ok:true, concept}|{ok:false, error, message?}>}
 */
async function addConcept({
  slug,
  name,
  conceptId = null,
  source_lesson_idx = null,
  evidence_lesson_idxs = [],
} = {}) {
  try {
    if (!_validateSlug(slug)) {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const trimmed = (typeof name === 'string') ? name.trim() : '';
    if (!trimmed) {
      return { ok: false, error: 'INVALID_STATE', message: 'name empty' };
    }
    const finalName = trimmed.slice(0, MAX_NAME_LEN);
    const id = (typeof conceptId === 'string' && conceptId.trim())
      ? conceptId.trim()
      : crypto.randomUUID();

    const seed = {
      id: crypto.randomUUID(),  // row id (different from conceptId)
      conceptId: id,
      ts: new Date().toISOString(),
      slug: String(slug),
      name: finalName,
      state: 'draft',
      source_lesson_idx: (typeof source_lesson_idx === 'number'
        && Number.isFinite(source_lesson_idx))
        ? source_lesson_idx
        : null,
      evidence_lesson_idxs: Array.isArray(evidence_lesson_idxs)
        ? evidence_lesson_idxs.filter(n => typeof n === 'number' && Number.isFinite(n))
        : [],
    };

    const abs = _slugFile(slug);
    _appendRow(abs, seed);
    return {
      ok: true,
      concept: {
        conceptId: seed.conceptId,
        ts: seed.ts,
        slug: seed.slug,
        name: seed.name,
        state: 'draft',
        source_lesson_idx: seed.source_lesson_idx,
        evidence_lesson_idxs: seed.evidence_lesson_idxs.slice(),
        lastTransitionAt: null,
      },
    };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

/**
 * Append a transition row. Validates against VALID_TRANSITIONS.
 * @param {object} params
 * @param {string} params.slug
 * @param {string} params.conceptId
 * @param {string} params.newState
 * @returns {Promise<{ok:true, concept}|{ok:false, error, message?}>}
 */
async function transitionConcept({ slug, conceptId, newState } = {}) {
  try {
    if (!_validateSlug(slug)) {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    if (!conceptId || typeof conceptId !== 'string') {
      return { ok: false, error: 'CONCEPT_NOT_FOUND' };
    }
    if (!STATE_ENUM.includes(newState)) {
      return { ok: false, error: 'INVALID_STATE' };
    }
    const abs = _slugFile(slug);
    const rows = _readAllRows(abs);
    const aggregated = _aggregate(rows);
    const target = aggregated.find(e => e.conceptId === conceptId);
    if (!target) {
      return { ok: false, error: 'CONCEPT_NOT_FOUND' };
    }
    const allowed = VALID_TRANSITIONS[target.state] || [];
    if (!allowed.includes(newState)) {
      return {
        ok: false,
        error: 'INVALID_TRANSITION',
        message: `${target.state} → ${newState} not in VALID_TRANSITIONS`,
      };
    }
    const tx = {
      txId: crypto.randomUUID(),
      conceptId,
      ts: new Date().toISOString(),
      fromState: target.state,
      toState: newState,
    };
    _appendRow(abs, tx);
    return {
      ok: true,
      concept: {
        ...target,
        state: newState,
        lastTransitionAt: tx.ts,
      },
    };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

/**
 * Aggregate-on-read all concepts for a slug, latest state wins. Optionally
 * filter by state.
 * @param {object} params
 * @param {string} params.slug
 * @param {string} [params.stateFilter]
 * @returns {Promise<{ok:true, concepts:object[]}|{ok:false, error}>}
 */
async function listConcepts({ slug, stateFilter = null } = {}) {
  try {
    if (!_validateSlug(slug)) {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const rows = _readAllRows(_slugFile(slug));
    let entries = _aggregate(rows);
    if (typeof stateFilter === 'string') {
      if (!STATE_ENUM.includes(stateFilter)) {
        return { ok: false, error: 'INVALID_STATE' };
      }
      entries = entries.filter(e => e.state === stateFilter);
    }
    // newest seed first
    entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return { ok: true, concepts: entries };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

/**
 * Count concepts grouped by current state. Always returns all 5 keys even
 * when 0. Convenience wrapper for north-star aggregator.
 * @param {object} params
 * @param {string} params.slug
 * @returns {Promise<{ok:true, counts}|{ok:false, error}>}
 */
async function countByState({ slug } = {}) {
  try {
    if (!_validateSlug(slug)) {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const rows = _readAllRows(_slugFile(slug));
    const entries = _aggregate(rows);
    const counts = {
      draft: 0,
      review: 0,
      ratified: 0,
      superseded: 0,
      deprecated: 0,
    };
    for (const e of entries) {
      if (counts[e.state] === undefined) continue;
      counts[e.state] += 1;
    }
    return { ok: true, counts };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

module.exports = {
  addConcept,
  transitionConcept,
  listConcepts,
  countByState,
  _internals: {
    STATE_ENUM,
    VALID_TRANSITIONS,
    MAX_NAME_LEN,
  },
};
