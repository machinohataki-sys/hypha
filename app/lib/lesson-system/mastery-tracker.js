'use strict';

// HYPHA · β21 Mastery Engine v0 — per-concept understanding EWMA tracker.
//
// 把散落的学习信号 (correct / wrong / spontaneous-recall / failed-feynman 等)
// 聚合成每个 concept 的 mastery score (0-1)。后续可:
//   - 自动推 review (score < 0.4 的 concept)
//   - 决定课程是否真理解 (全 concept score > 0.7 才 "通过")
//   - 与 Goal Guardian 联动: 课程完成度计算用 mastery 而非 lesson count
//
// v0 = signal record + EWMA + per-concept query。
// !LLM, !auto-extract from transcript (下一波), !UI 本波。
//
// Files written:
//   vault/<slug>/.mastery-signals.jsonl   (append-only signal log)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vault = require('../vault');

// -- EWMA constants (v0 hardcoded) -----------------------------------------

const ALPHA = 0.3;
const DEFAULT_SCORE = 0.5;

const DELTAS = Object.freeze({
  'correct':            +0.20,
  'spontaneous-recall': +0.25,  // 更强信号
  'partial':            +0.05,
  'wrong':              -0.15,
  'refused-to-engage':  -0.05,  // 拒绝接(回避)
  'failed-feynman':     -0.20,  // 解释失败
});

const VALID_SIGNALS = Object.freeze(Object.keys(DELTAS));

// -- io --------------------------------------------------------------------

function _slugDir(slug) {
  const root = vault.resolveRoot();
  const dir = path.join(root, slug);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _signalsFile(slug) {
  return path.join(_slugDir(slug), '.mastery-signals.jsonl');
}

function _readSignals(slug) {
  const f = _signalsFile(slug);
  if (!fs.existsSync(f)) return [];
  const raw = fs.readFileSync(f, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); }
    catch (_) { /* skip malformed lines */ }
  }
  return out;
}

function _appendSignal(slug, record) {
  const f = _signalsFile(slug);
  fs.appendFileSync(f, JSON.stringify(record) + '\n', 'utf8');
}

// -- helpers ---------------------------------------------------------------

function _clamp01(n) {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function _validateSlug(slug) {
  return typeof slug === 'string' && slug.trim().length > 0;
}

function _validateConcept(concept) {
  return typeof concept === 'string' && concept.trim().length > 0;
}

function _validateWeight(weight) {
  return typeof weight === 'number'
    && Number.isFinite(weight)
    && weight >= 0.1
    && weight <= 3;
}

// EWMA reducer: score_t = α * signalScore_t + (1-α) * score_{t-1}
// signalScore = clamp01(0.5 + DELTAS[signal] * weight)
function _computeEwma(signals) {
  let score = DEFAULT_SCORE;
  let lastSignalAt = null;
  for (const s of signals) {
    const delta = DELTAS[s.signal];
    if (delta === undefined) continue;  // defensive: skip unknown
    const weight = (typeof s.weight === 'number' && Number.isFinite(s.weight)) ? s.weight : 1;
    const signalScore = _clamp01(0.5 + delta * weight);
    score = ALPHA * signalScore + (1 - ALPHA) * score;
    lastSignalAt = s.ts || lastSignalAt;
  }
  return { score: _clamp01(score), lastSignalAt };
}

// -- public API ------------------------------------------------------------

/**
 * Record a learning signal for a concept.
 * @param {object} params
 * @param {string} params.slug
 * @param {string} params.concept
 * @param {string} params.signal — one of VALID_SIGNALS
 * @param {number} [params.weight=1] — 0.1..3
 * @param {string} [params.source='manual']
 * @param {number|null} [params.lessonIdx=null]
 */
async function recordSignal({ slug, concept, signal, weight = 1, source = 'manual', lessonIdx = null } = {}) {
  try {
    if (!_validateSlug(slug)) return { ok: false, error: 'MISSING_SLUG' };
    if (!_validateConcept(concept)) return { ok: false, error: 'MISSING_CONCEPT' };
    if (!VALID_SIGNALS.includes(signal)) return { ok: false, error: 'INVALID_SIGNAL' };
    if (!_validateWeight(weight)) return { ok: false, error: 'INVALID_WEIGHT' };

    const record = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      concept: concept.trim(),
      signal,
      weight,
      source: typeof source === 'string' ? source : 'manual',
      lessonIdx: (lessonIdx === null || lessonIdx === undefined) ? null : lessonIdx,
    };
    _appendSignal(slug, record);
    return { ok: true, signal: record };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

/**
 * Get the EWMA mastery score for a concept.
 * @returns {object} {ok, score:0-1, signalCount, lastSignalAt}
 */
async function getMasteryScore({ slug, concept } = {}) {
  try {
    if (!_validateSlug(slug)) return { ok: false, error: 'MISSING_SLUG' };
    if (!_validateConcept(concept)) return { ok: false, error: 'MISSING_CONCEPT' };

    const target = concept.trim();
    const all = _readSignals(slug);
    const matched = all.filter(s => s && s.concept === target);
    if (matched.length === 0) {
      return { ok: true, score: DEFAULT_SCORE, signalCount: 0, lastSignalAt: null };
    }
    const { score, lastSignalAt } = _computeEwma(matched);
    return { ok: true, score, signalCount: matched.length, lastSignalAt };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

/**
 * List all concepts with mastery scores, optionally filtered by band.
 * @param {object} params
 * @param {string} params.slug
 * @param {('low'|'mid'|'high'|null)} [params.threshold=null]
 * @returns {object} {ok, items:[{concept, score, signalCount, lastSignalAt}]} sorted score ASC
 */
async function listMastery({ slug, threshold = null } = {}) {
  try {
    if (!_validateSlug(slug)) return { ok: false, error: 'MISSING_SLUG' };
    const all = _readSignals(slug);
    // bucket by concept
    const byConcept = new Map();
    for (const s of all) {
      if (!s || typeof s.concept !== 'string') continue;
      if (!byConcept.has(s.concept)) byConcept.set(s.concept, []);
      byConcept.get(s.concept).push(s);
    }
    const items = [];
    for (const [concept, signals] of byConcept.entries()) {
      const { score, lastSignalAt } = _computeEwma(signals);
      items.push({ concept, score, signalCount: signals.length, lastSignalAt });
    }
    // threshold filter
    let filtered = items;
    if (threshold === 'low') filtered = items.filter(i => i.score < 0.4);
    else if (threshold === 'mid') filtered = items.filter(i => i.score >= 0.4 && i.score <= 0.7);
    else if (threshold === 'high') filtered = items.filter(i => i.score > 0.7);
    // sort score ASC
    filtered.sort((a, b) => a.score - b.score);
    return { ok: true, items: filtered };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

/**
 * Shortcut: list concepts with score < max (default 0.45).
 *
 * 2026-05-16 consolidation: floor raised from 0.4 to 0.45 so 2 wrong signals
 * from a 0.5 prior (EWMA α=0.3 → 0.5 × 0.7² + 0 × (1-0.7²) ≈ 0.245, but 1
 * wrong → 0.5 × 0.7 = 0.35; 2 wrong from 0.5 split actually settles ≈ 0.408)
 * land below the "low" threshold rather than passing through silently.
 * `listMastery({ threshold: 'low' })` retains the 0.4 boundary for the
 * mid/low/high split — only this shortcut's default cap moves.
 */
async function listLowMastery({ slug, max = 0.45 } = {}) {
  try {
    if (!_validateSlug(slug)) return { ok: false, error: 'MISSING_SLUG' };
    const ceil = (typeof max === 'number' && Number.isFinite(max)) ? max : 0.45;
    const full = await listMastery({ slug });
    if (!full.ok) return full;
    const items = full.items.filter(i => i.score < ceil);
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

/**
 * Read the recent signal history for a concept (reverse chronological).
 */
async function getSignalHistory({ slug, concept, limit = 30 } = {}) {
  try {
    if (!_validateSlug(slug)) return { ok: false, error: 'MISSING_SLUG' };
    if (!_validateConcept(concept)) return { ok: false, error: 'MISSING_CONCEPT' };
    const target = concept.trim();
    const cap = (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) ? Math.floor(limit) : 30;
    const all = _readSignals(slug);
    const matched = all.filter(s => s && s.concept === target);
    const reversed = matched.slice().reverse().slice(0, cap);
    return { ok: true, items: reversed };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

module.exports = {
  recordSignal,
  getMasteryScore,
  listMastery,
  listLowMastery,
  getSignalHistory,
  // exposed for tests / introspection
  DELTAS,
  VALID_SIGNALS,
  ALPHA,
  DEFAULT_SCORE,
};
