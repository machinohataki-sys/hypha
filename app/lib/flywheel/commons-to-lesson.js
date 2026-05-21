'use strict';

// HYPHA · W8.2 Learning Commons Flywheel · Step 4 — Commons → Lesson
//
// Closes the loop by surfacing high-trust Commons packs as hints for the
// next Lesson skeleton. FOURTH (and last) hop of the §20 v2.5 flywheel:
//
//   ~/.hypha/commons/staging/  (W8.2/3)
//     + app/lib/commons-packs/* (W6.x curated)
//        → [findRelevantCommonsForLesson]    // topic match + rankPacks
//        → [injectCommonsIntoLessonPrompt]   // COMMONS HINTS block
//        → consumed by agent.js designSkeletonOnly
//
// Boundary contract:
//   - Reads pack manifests from both the staging dir and
//     app/lib/commons-packs/ (curated baseline).
//   - Calls W6.5 pack-intelligence-card.rankPacks when loadable; falls
//     back to a topic-similarity rank otherwise.
//   - DOES NOT call the LLM. The block returned by
//     injectCommonsIntoLessonPrompt is *prepended* by agent.js before its
//     LIBRARY_EVIDENCE section. Same delivery contract as LIBRARY_EVIDENCE
//     so the prompt diff is local.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Best-effort imports
let _pic = null;
try { _pic = require('../commons/pack-intelligence-card'); } catch (_) { _pic = null; }

let _packToCommons = null;
try { _packToCommons = require('./pack-to-commons'); } catch (_) { _packToCommons = null; }

// ---------------------------------------------------------------------------
// Discovery — collect packs from staging dir + curated commons-packs/
// ---------------------------------------------------------------------------

function _stagingRoot() {
  if (process.env.HYPHA_COMMONS_STAGING_DIR) return process.env.HYPHA_COMMONS_STAGING_DIR;
  return path.join(os.homedir(), '.hypha', 'commons', 'staging');
}

function _curatedRoot() {
  if (process.env.HYPHA_CURATED_PACKS_DIR) return process.env.HYPHA_CURATED_PACKS_DIR;
  return path.join(__dirname, '..', 'commons-packs');
}

function _readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function _gatherStaged() {
  if (_packToCommons && typeof _packToCommons.listStagedPacks === 'function') {
    try {
      return _packToCommons.listStagedPacks().map(m => ({
        ...m,
        source: 'staging',
        pack_kind: m.pack_kind || 'unknown',
      }));
    } catch (_) { /* fall through */ }
  }
  return [];
}

function _gatherCurated() {
  const root = _curatedRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    let stat = null;
    try { stat = fs.statSync(dir); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    const jsonPath = path.join(dir, 'pack.json');
    const yamlPath = path.join(dir, 'pack.yaml');
    let pack = null;
    if (fs.existsSync(jsonPath)) pack = _readJsonSafe(jsonPath);
    else if (fs.existsSync(yamlPath)) {
      pack = { topic_slug: name, _yaml_only: true, title: name };
    }
    if (!pack) continue;
    out.push({
      pack_id: pack.pack_id || name,
      topic_slug: pack.topic_slug || name,
      title: pack.title || name,
      author: pack.author || 'community',
      license: pack.license || 'unspecified',
      pack_kind: pack.pack_kind || 'curated',
      source: 'curated',
      path: dir,
      _raw: pack,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Topic similarity — token-overlap fallback when rankPacks unavailable
// ---------------------------------------------------------------------------

function _tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .split(/[^a-z0-9一-龥]+/)
    .filter(Boolean);
}

function _similarity(a, b) {
  const ta = new Set(_tokenize(a));
  const tb = new Set(_tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / Math.sqrt(ta.size * tb.size);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find top-N Commons packs relevant to a lesson topic.
 *
 * @param {string} slug         — curriculum slug (for events.jsonl context)
 * @param {string} lessonTopic  — the lesson title or conceptId
 * @param {object} [opts]       — { topK?: number=3, userContext?: object }
 * @returns {{ ok: boolean, packs: Array, source: string }}
 */
function findRelevantCommonsForLesson(slug, lessonTopic, opts = {}) {
  const topK = Math.max(1, Number(opts.topK || 3));
  const userContext = opts.userContext || {};

  const all = [..._gatherStaged(), ..._gatherCurated()];
  if (all.length === 0) {
    return { ok: true, packs: [], source: 'empty', topic: lessonTopic };
  }

  // Filter out blocked staging packs
  const safe = all.filter(p => !p.blocked);

  // Prefer W6.5 rankPacks when available
  if (_pic && typeof _pic.rankPacks === 'function') {
    try {
      const ranked = _pic.rankPacks(safe, { ...userContext, topic: lessonTopic });
      return {
        ok: true,
        packs: (ranked || []).slice(0, topK),
        source: 'w65-rankPacks',
        topic: lessonTopic,
      };
    } catch (_) { /* fall back */ }
  }

  // Token-overlap fallback
  const scored = safe.map(p => ({
    ...p,
    _score: _similarity(`${p.title} ${p.topic_slug}`, lessonTopic),
  }));
  scored.sort((a, b) => b._score - a._score);
  return {
    ok: true,
    packs: scored.slice(0, topK),
    source: 'token-overlap-fallback',
    topic: lessonTopic,
  };
}

/**
 * Render the COMMONS HINTS block to be prepended to the designSkeletonOnly
 * system prompt. Returns '' when no packs — agent.js can safely interpolate.
 *
 * @param {object} _lessonContext — kept for future extension (signature parity with LIBRARY_EVIDENCE)
 * @param {Array}  relevantPacks  — output of findRelevantCommonsForLesson
 * @returns {string}
 */
function injectCommonsIntoLessonPrompt(_lessonContext, relevantPacks) {
  if (!Array.isArray(relevantPacks) || relevantPacks.length === 0) return '';
  const lines = ['COMMONS HINTS (high-trust public Packs relevant to this lesson — use as inspiration, NOT as authoritative content):'];
  for (const p of relevantPacks) {
    const kind = p.pack_kind || 'pack';
    const author = p.author || 'community';
    const title = p.title || p.topic_slug || p.pack_id;
    const lic = p.license || 'unspecified';
    lines.push(`  - [${kind}] "${title}" by ${author} (${lic})`);
  }
  lines.push('');
  lines.push('Treat each as a peer Lesson designed elsewhere. Cite if you draw on it. Never duplicate.');
  return lines.join('\n');
}

module.exports = {
  findRelevantCommonsForLesson,
  injectCommonsIntoLessonPrompt,
  _internals: {
    gatherStaged: _gatherStaged,
    gatherCurated: _gatherCurated,
    similarity: _similarity,
    tokenize: _tokenize,
  },
};
