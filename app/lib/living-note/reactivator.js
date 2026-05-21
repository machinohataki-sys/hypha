'use strict';

// HYPHA · W5.3 Living Note — Scene-driven reactivator (BLUEPRINT §10.2).
//
// Find candidates to RESURRECT older notes inside the active scene.
// Principle: "Do not review notes, call them." Surfacing inline is the
// reactivation; the user reading the callout = the note alive again.
//
// 8 scenes (per Wave 5.3 spec):
//   lesson_active          — running tutor turn references KP X
//   writing                — capture surface / drafting note
//   product_decision       — Product Pool decision being recorded
//   conflict_detected      — new evidence vs. older claim
//   action_planning        — assignment / roadmap drafting
//   exam_prep              — Feynman test / final compression
//   pack_generation        — Knowledge Pack export draft
//   product_pool_planning  — product blueprint update / roadmap-sync
//
// Inputs:
//   - W5.1 Cheap Router: embed(text)+cosine for semantic relatedness
//   - W5.2 Web Note Engine: walkGraph(seed) for topological relatedness
//   Both are required lazily — module loads without them. Smoke test path
//   accepts an explicit `_indexShim` to avoid touching real fs / LLM.
//
// Filter: only consider notes with state ∈ {Dormant, Useful, Crystallized,
// Operational}. Archived / Outdated / Contradicted skip (re-activate path
// goes through explicit user gesture, not silent surfacing).
//
// Threshold: relevance ≥ 0.6.
//
// Pure ranking. Side-effect-free. Caller decides whether to call
// transitionNoteState(... Dormant→Active ...) when the user actually engages.

const fs   = require('node:fs');
const path = require('node:path');

const states = require('./states');
const utility = require('./utility-score');

const REACTIVATION_THRESHOLD = 0.6;

const ELIGIBLE_STATES = new Set([
  states.LIFE_STATES.DORMANT,
  states.LIFE_STATES.USEFUL,
  states.LIFE_STATES.CRYSTALLIZED,
  states.LIFE_STATES.OPERATIONAL,
]);

const SCENES = Object.freeze({
  LESSON_ACTIVE:         'lesson_active',
  WRITING:               'writing',
  PRODUCT_DECISION:      'product_decision',
  CONFLICT_DETECTED:     'conflict_detected',
  ACTION_PLANNING:       'action_planning',
  EXAM_PREP:             'exam_prep',
  PACK_GENERATION:       'pack_generation',
  PRODUCT_POOL_PLANNING: 'product_pool_planning',
});

const SCENE_VALUES = new Set(Object.values(SCENES));

function _isEligibleScene(scene) {
  return typeof scene === 'string' && SCENE_VALUES.has(scene);
}

function _safeReadFm(abs) {
  let text = '';
  try { text = fs.readFileSync(abs, 'utf-8'); } catch (_) { return {}; }
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fm;
}

function _resolveVaultRoot(slug) {
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return path.join(process.env.HYPHA_DATA, slug);
  }
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return path.join(process.env.HYPHA_VAULT_DIR, slug);
  }
  return path.join(__dirname, '..', '..', '..', 'data', slug);
}

function _listMarkdownNotes(slugDir) {
  const out = [];
  if (!fs.existsSync(slugDir)) return out;
  let entries = [];
  try { entries = fs.readdirSync(slugDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const dirent of entries) {
    if (dirent.name.startsWith('.')) continue;          // skip .archive / .beiking
    if (dirent.isFile() && dirent.name.endsWith('.md')) {
      out.push(path.join(slugDir, dirent.name));
    }
  }
  return out;
}

// Tokenize lightly for the fallback cosine. Strips frontmatter,
// lowercases, splits on non-word boundaries. Handles CN by treating
// each CJK char as its own token (no tokenizer dependency).
function _tokenize(text) {
  const body = String(text || '').replace(/^---[\s\S]*?---\r?\n?/, '');
  const ascii = body.toLowerCase().match(/[a-z0-9_]+/g) || [];
  const cjk = (body.match(/[一-鿿]/g) || []);
  return ascii.concat(cjk);
}

function _bow(tokens) {
  const bag = new Map();
  for (const tok of tokens) {
    bag.set(tok, (bag.get(tok) || 0) + 1);
  }
  return bag;
}

function _cosine(a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [, v] of a) normA += v * v;
  for (const [, v] of b) normB += v * v;
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (bv) dot += v * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Default "embed" — bag-of-words cosine fallback. Real cheap-router from W5.1
// can be injected via _indexShim.embed(text) → Map | number[]. We accept both.
function _defaultEmbed(text) {
  return _bow(_tokenize(text));
}

function _sim(qVec, dVec) {
  if (qVec instanceof Map && dVec instanceof Map) return _cosine(qVec, dVec);
  if (Array.isArray(qVec) && Array.isArray(dVec) && qVec.length === dVec.length) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < qVec.length; i++) {
      dot += qVec[i] * dVec[i];
      na += qVec[i] * qVec[i];
      nb += dVec[i] * dVec[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  return 0;
}

function _reasonFor(scene, candidate, sim) {
  const title = candidate.title || candidate.basename || 'older note';
  const simPct = `${Math.round(sim * 100)}%`;
  switch (scene) {
    case SCENES.LESSON_ACTIVE:
      return `你之前学过 "${title}" — 与当前一节 ${simPct} 相关, 可能是前置.`;
    case SCENES.WRITING:
      return `写作正接近 "${title}" 的领域 (${simPct}) — 是否引用 / 续写?`;
    case SCENES.PRODUCT_DECISION:
      return `这条旧笔记 "${title}" 当时影响过类似决定 (${simPct}) — 看一眼?`;
    case SCENES.CONFLICT_DETECTED:
      return `"${title}" 的旧结论与新证据冲突 (${simPct}) — 处置?`;
    case SCENES.ACTION_PLANNING:
      return `"${title}" 包含可复用的行动模板 (${simPct}).`;
    case SCENES.EXAM_PREP:
      return `"${title}" 是这场考试的高频点 (${simPct}).`;
    case SCENES.PACK_GENERATION:
      return `"${title}" 适合纳入这个 Pack (${simPct}).`;
    case SCENES.PRODUCT_POOL_PLANNING:
      return `"${title}" 之前帮你定过产品方向 (${simPct}).`;
    default:
      return `语义相关 ${simPct}`;
  }
}

/**
 * Find reactivation candidates for the given scene.
 *
 * @param {string} slug                 vault subdir
 * @param {string} scene                one of SCENES values
 * @param {object} [opts]
 * @param {string} [opts.queryText]     scene-side anchor text (lesson body / draft / decision)
 * @param {object} [opts._indexShim]    test override: { embed(text), notes: [{path, fm, body}], walkGraph(seed) }
 * @param {number} [opts.threshold]     override REACTIVATION_THRESHOLD
 * @param {number} [opts.limit]         max candidates returned (default 8)
 * @returns {Array<{ path:string, title:string, relevance:number, reason:string, state:string, utilityScore:number }>}
 */
function findReactivationCandidates(slug, scene, opts) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('living-note/reactivator: slug required');
  }
  if (!_isEligibleScene(scene)) {
    throw new Error(`living-note/reactivator: unknown scene "${scene}"`);
  }
  const options = opts || {};
  const threshold = Number.isFinite(options.threshold) ? options.threshold : REACTIVATION_THRESHOLD;
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 8;
  const queryText = typeof options.queryText === 'string' ? options.queryText : '';

  // Use index shim when provided (smoke test path); else scan vault fs.
  const shim = options._indexShim || null;
  const embed = (shim && typeof shim.embed === 'function') ? shim.embed : _defaultEmbed;
  const qVec = embed(queryText);

  let notes;
  if (shim && Array.isArray(shim.notes)) {
    notes = shim.notes.map(n => ({
      path: n.path,
      fm: n.fm || {},
      body: n.body || '',
    }));
  } else {
    const root = _resolveVaultRoot(slug);
    notes = _listMarkdownNotes(root).map(p => {
      const fm = _safeReadFm(p);
      let body = '';
      try { body = fs.readFileSync(p, 'utf-8'); } catch (_) {}
      return { path: p, fm, body };
    });
  }

  const candidates = [];
  for (const n of notes) {
    const state = (n.fm && n.fm.life_state) || states.LIFE_STATES.DORMANT;
    if (!ELIGIBLE_STATES.has(state)) continue;
    const dVec = embed(n.body || '');
    const sim = _sim(qVec, dVec);
    if (!Number.isFinite(sim) || sim < threshold) continue;
    const title = n.fm.title || path.basename(n.path).replace(/\.md$/, '');
    const utilityData = {
      helped_lesson_count: Number(n.fm.helped_lesson_count) || 0,
      helped_decision_count: Number(n.fm.helped_decision_count) || 0,
      produced_action_count: Number(n.fm.produced_action_count) || 0,
      cited_count: Number(n.fm.cited_count) || 0,
      sparked_count: Number(n.fm.sparked_count) || 0,
      reduced_understanding_cost: n.fm.reduced_understanding_cost === 'true',
      influenced_product: n.fm.influenced_product === 'true',
      outdated_penalty: state === states.LIFE_STATES.OUTDATED,
    };
    const { score } = utility.computeUtilityScore(utilityData);
    candidates.push({
      path: n.path,
      title,
      relevance: Math.round(sim * 1000) / 1000,
      reason: _reasonFor(scene, { title, basename: title }, sim),
      state,
      utilityScore: score,
    });
  }

  // Sort by (relevance × 0.7 + utility/100 × 0.3) descending. Utility breaks
  // semantic ties — a Crystallized note edges out a Dormant note at same sim.
  candidates.sort((a, b) => {
    const aRank = a.relevance * 0.7 + (a.utilityScore / 100) * 0.3;
    const bRank = b.relevance * 0.7 + (b.utilityScore / 100) * 0.3;
    return bRank - aRank;
  });

  return candidates.slice(0, limit);
}

module.exports = {
  SCENES,
  REACTIVATION_THRESHOLD,
  ELIGIBLE_STATES,
  findReactivationCandidates,
  // exposed for tests / external linkage
  _defaultEmbed,
  _cosine,
};
