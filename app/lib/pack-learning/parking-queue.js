'use strict';

// HYPHA · W7.1 Parking Queue (BLUEPRINT §12.5).
//
// "I'm in the middle of a lesson but this pack looks worth saving for the
// right moment." The parking queue holds high-value Packs against future
// lessons WITHOUT interrupting the current one, then surfaces a soft
// revival suggestion when the context becomes appropriate.
//
// Storage: `vault/<slug>/parking-queue.json` — small array of parked pack
// entries, one per pack. Per-slug, since the relevance of a parked pack is
// always evaluated against THIS slug's running lesson context.
//
// Revival ranking: cosine similarity (via W5.1 embed-stub fallback) between
// the running lesson's text snippet and each parked pack's topic + reason.
// We deliberately do NOT push notifications — the renderer queries
// `suggestRevival(slug, currentLessonContext)` from the sidebar widget on
// each lesson tick. Low visual weight is enforced UI-side.

const fs = require('node:fs');
const path = require('node:path');

// W5.1 cheap router's embed-stub. Optional — fall back to deterministic
// keyword overlap when embed-stub is not loadable (lean tests).
function _loadEmbed() {
  try { return require('../llm/embed-stub'); }
  catch (_) { return null; }
}

// ─── Path resolution ────────────────────────────────────────────────────────

function _vaultRoot() {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) return process.env.HYPHA_DATA;
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) return process.env.HYPHA_VAULT_DIR;
  return path.join(__dirname, '..', '..', '..', 'data');
}

function _ensureSlug(slug) {
  if (!slug || typeof slug !== 'string') throw new Error('parking-queue: slug required');
  if (slug.includes('..') || path.isAbsolute(slug)) {
    throw new Error('parking-queue: slug must be a vault-relative dir name');
  }
}

function _queuePath(slug) {
  _ensureSlug(slug);
  return path.join(_vaultRoot(), slug, 'parking-queue.json');
}

function _readQueue(slug) {
  const p = _queuePath(slug);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function _writeQueue(slug, arr) {
  const p = _queuePath(slug);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// ─── 1. Park a pack ─────────────────────────────────────────────────────────
//
// Idempotent on (slug, packId). Re-parking refreshes the reason + timestamp
// but does NOT duplicate the entry.

/**
 * @param {string} slug
 * @param {string} packId
 * @param {string} [reason]   user-supplied note on WHY they're parking
 * @param {object} [meta]     optional pack snapshot (topic, lang) for ranking
 * @returns {{slug, packId, reason, parked_at, total_parked}}
 */
function parkPack(slug, packId, reason = '', meta = {}) {
  _ensureSlug(slug);
  if (!packId || typeof packId !== 'string') throw new Error('parkPack: packId required');
  const queue = _readQueue(slug);
  const existing = queue.findIndex(e => e && e.packId === packId);
  const now = new Date().toISOString();
  const entry = {
    packId,
    reason: String(reason || '').slice(0, 480),
    parked_at: now,
    meta: meta && typeof meta === 'object' ? {
      topic: meta.topic || null,
      lang: meta.lang || null,
      primary_value: meta.primary_value || null,
    } : {},
  };
  let next;
  if (existing >= 0) {
    next = queue.slice();
    next[existing] = Object.assign({}, queue[existing], entry, { parked_at: now });
  } else {
    next = queue.concat([entry]);
  }
  _writeQueue(slug, next);
  return Object.assign({}, entry, { slug, total_parked: next.length });
}

/**
 * Return parked packs for a slug. Sort: most-recent first.
 * @param {string} slug
 * @returns {Array}
 */
function getParkedPacks(slug) {
  _ensureSlug(slug);
  const queue = _readQueue(slug);
  return queue.slice().sort((a, b) => String(b.parked_at || '').localeCompare(String(a.parked_at || '')));
}

/**
 * Remove a pack from the queue. Returns the removed entry + new total.
 * @param {string} slug
 * @param {string} packId
 * @param {string} [reason]   journal-only; not persisted (queue holds parked
 *                             entries only — unpark history lives in the
 *                             pack-learning state-machine journal instead)
 * @returns {{removed, total_parked}}
 */
function unparkPack(slug, packId, reason = '') {
  _ensureSlug(slug);
  if (!packId || typeof packId !== 'string') throw new Error('unparkPack: packId required');
  const queue = _readQueue(slug);
  const idx = queue.findIndex(e => e && e.packId === packId);
  if (idx < 0) return { removed: null, total_parked: queue.length };
  const removed = Object.assign({}, queue[idx], { unpark_reason: reason || null });
  const next = queue.slice(0, idx).concat(queue.slice(idx + 1));
  _writeQueue(slug, next);
  return { removed, total_parked: next.length };
}

// ─── 2. Suggest revival ────────────────────────────────────────────────────
//
// Rank parked packs by relevance to the running lesson context. Cosine
// similarity against W5.1 embed-stub when available, else Jaccard overlap.
//
// `currentLessonContext`:
//   - { text }                   plain string snippet (lesson title + brief)
//   - { topic, learnGoal, kps[] }  structured — concatenated internally
//
// Threshold: scores below 0.20 are dropped (noise floor). UI may render
// fewer than topK when relevance is uniformly low — the surface should
// remain calm rather than pushing low-value revivals.

const NOISE_FLOOR = 0.20;

function _contextText(ctx) {
  if (!ctx) return '';
  if (typeof ctx === 'string') return ctx;
  if (ctx.text) return String(ctx.text);
  const parts = [
    ctx.topic,
    ctx.learnGoal,
    Array.isArray(ctx.kps) ? ctx.kps.join(' ') : null,
    ctx.lessonTitle,
  ].filter(v => v != null && String(v).trim());
  return parts.join(' · ');
}

function _entryText(entry) {
  if (!entry) return '';
  const meta = entry.meta || {};
  return [meta.topic, meta.primary_value, entry.reason, entry.packId]
    .filter(v => v != null && String(v).trim())
    .join(' · ');
}

// Fallback Jaccard when embed-stub is absent. CJK + ASCII tokenizer kept
// minimal — this is a noise-floor fallback only.
function _tokenize(text) {
  if (!text) return [];
  return String(text).toLowerCase()
    .split(/[\s,.;:!?'"`()\[\]{}<>/\\|*+=#&%$@~^—–\-_…，。；：！？、《》「」『』（）【】]+/u)
    .filter(t => t && t.length >= 1);
}
function _jaccard(aText, bText) {
  const A = new Set(_tokenize(aText));
  const B = new Set(_tokenize(bText));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * @param {string} slug
 * @param {object|string} currentLessonContext
 * @param {object} [options]   { topK?: number = 3, floor?: number = 0.20 }
 * @returns {Promise<Array<{entry, score, basis}>>}
 */
async function suggestRevival(slug, currentLessonContext, options = {}) {
  _ensureSlug(slug);
  const topK = Math.max(1, Math.min(10, Number(options.topK) || 3));
  const floor = options.floor != null ? Number(options.floor) : NOISE_FLOOR;
  const parked = getParkedPacks(slug);
  if (parked.length === 0) return [];
  const ctxText = _contextText(currentLessonContext);
  if (!ctxText) return [];

  const embedMod = _loadEmbed();
  if (embedMod && typeof embedMod.topKSimilar === 'function') {
    const candidates = parked.map(e => ({ id: e.packId, text: _entryText(e), _entry: e }));
    try {
      const ranked = await embedMod.topKSimilar(ctxText, candidates, topK);
      return ranked
        .filter(r => r && r.score >= floor)
        .map(r => ({ entry: r.candidate._entry, score: Number(r.score) || 0, basis: 'embed' }));
    } catch (_) {
      // fall through to Jaccard
    }
  }
  // Jaccard fallback — pure sync.
  const scored = parked.map(e => ({
    entry: e,
    score: _jaccard(ctxText, _entryText(e)),
    basis: 'jaccard',
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter(r => r.score >= floor).slice(0, topK);
}

module.exports = {
  parkPack,
  getParkedPacks,
  unparkPack,
  suggestRevival,
  NOISE_FLOOR,
  _vaultRoot,
  _queuePath,
};
