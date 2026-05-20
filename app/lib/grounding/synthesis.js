'use strict';

// HYPHA · Wave 6.1 Bibliography Grounding · Synthesis builder
// (BLUEPRINT §4.2 — "Grounding Synthesis: 多本书不能堆砌，要合成").
//
// Per blueprint: when the user picks multiple books, HYPHA must decide
//   - 每本书负责什么          (per-book role: primary / secondary / supplement)
//   - 哪些互补                (complementary pairs)
//   - 哪些冲突                (conflict pairs + which side the course adopts)
//   - 哪本主地基              (primary book, single)
//   - 哪本辅助                (secondary / supplement books)
//   - 哪些内容不进入当前课程  (excluded_content list)
//
// 6 synthesis fields (locked):
//   1. books_with_roles[]    — [{ book_id, role, responsibility }]
//   2. complementary_pairs[] — [{ book_a, book_b, complement_topic }]
//   3. conflicts[]           — [{ book_a, book_b, conflict_topic, resolution }]
//   4. excluded_content[]    — content from any book that should NOT enter course
//   5. synthesis_notes       — 1 paragraph rationale (≤500 chars)
//   6. (cached) goal + bookIds → cache invalidation surface
//
// Pipeline:
//   synthesizeGrounding → parallel buildBookProfile for each book →
//     T6_STRONG (mock-safe) synthesis judge → 6 fields → cache to
//     vault/<slug>/grounding/synthesis.json.
//
// Cache invalidation: goal hash or bookIds set changes → recompute.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { buildBookProfile, _goalHash } = require('./book-profile');

const SYNTHESIS_SCHEMA_VERSION = 1;
const SYNTHESIS_FILENAME = 'synthesis.json';
const VALID_ROLES = new Set(['primary', 'secondary', 'supplement']);

function _synthesisPath(vaultRoot, slug) {
  return path.join(vaultRoot, slug, 'grounding', SYNTHESIS_FILENAME);
}

function _ensureDir(absDir) {
  try { fs.mkdirSync(absDir, { recursive: true }); } catch (_) {}
}

function _safeReadJSON(absPath) {
  try {
    if (!fs.existsSync(absPath)) return null;
    return JSON.parse(fs.readFileSync(absPath, 'utf-8'));
  } catch (_) {
    return null;
  }
}

/**
 * Stable hash of (goal + bookIds set) so cache busts when EITHER changes.
 *
 * @param {object|null} goalContract
 * @param {string[]} bookIds
 * @returns {string}
 */
function _synthesisHash(goalContract, bookIds) {
  const gh = _goalHash(goalContract);
  const sorted = Array.isArray(bookIds) ? [...bookIds].sort() : [];
  const stable = JSON.stringify({ gh, books: sorted });
  return crypto.createHash('sha1').update(stable).digest('hex').slice(0, 12);
}

/**
 * Mock-safe T6_STRONG synthesis call. Falls back to a deterministic synthesis
 * when LLM bridge missing — first book gets `primary`, rest `secondary`.
 *
 * @param {string} prompt
 * @param {object} fallback
 * @returns {Promise<object>}
 */
async function _callSynthesisT6(prompt, fallback) {
  try {
    const llm = require('../llm');
    if (llm && typeof llm.executeChat === 'function') {
      const dispatch = await llm.executeChat('T6_STRONG', {
        messages: [{ role: 'user', content: prompt }],
        json: true,
        temperature: 0.5,
        maxTokens: 2200,
        timeoutMs: 90_000,
      });
      const r = dispatch && dispatch.result;
      let raw = '';
      if (typeof r === 'string') raw = r;
      else if (r && typeof r.content === 'string') raw = r.content;
      else if (r && r.message && typeof r.message.content === 'string') raw = r.message.content;
      else if (r && Array.isArray(r.choices) && r.choices[0] && r.choices[0].message
               && typeof r.choices[0].message.content === 'string') raw = r.choices[0].message.content;
      else raw = JSON.stringify(r || dispatch || {});
      try {
        return (typeof raw === 'string') ? JSON.parse(raw) : raw;
      } catch (_) {
        return fallback;
      }
    }
  } catch (_) {
    // Provider stack absent — fall through.
  }
  return fallback;
}

/**
 * Render a compact digest of N profiles for the synthesis prompt. Keeps the
 * 8 fields per book inline so the synthesis judge has full context without
 * a second retrieval round.
 *
 * @param {object[]} profiles
 * @returns {string}
 */
function _renderProfilesDigest(profiles) {
  return profiles.map((p, i) => {
    const sparks = (p.core_sparks || []).slice(0, 5).map(s => `    + ${s}`).join('\n');
    const unfit = (p.unfit_content || []).slice(0, 3).map(s => `    - ${s}`).join('\n');
    return `BOOK ${i + 1} · id=${p.book_id}
  Title: ${p.title}
  Fit-to-goal: ${p.fit_to_goal}
  Goal relevance: ${p.goal_relevance}
  Core sparks (in-scope):
${sparks || '    (none)'}
  Unfit content (out-of-scope):
${unfit || '    (none)'}`;
  }).join('\n\n');
}

/**
 * Build the 6-field Grounding Synthesis.
 *
 * @param {string} slug
 * @param {object|null} goalContract
 * @param {string[]} bookIds
 * @param {object} opts
 * @param {string} opts.vaultRoot
 * @param {boolean} [opts.force=false]
 * @returns {Promise<{slug, goal, books_with_roles, complementary_pairs, conflicts, excluded_content, synthesis_notes, generated_at, version, _hash, _cached?}>}
 */
async function synthesizeGrounding(slug, goalContract, bookIds, opts = {}) {
  const vaultRoot = opts.vaultRoot;
  const force = !!opts.force;
  if (!vaultRoot) throw new Error('synthesizeGrounding: opts.vaultRoot required');
  if (!slug) throw new Error('synthesizeGrounding: slug required');
  const ids = Array.isArray(bookIds) ? bookIds.filter(Boolean) : [];
  if (ids.length === 0) {
    // Empty selection — synthesis is a stub with no books. Persisted so the
    // course generator's GROUNDING_PROFILE block degrades gracefully.
    const empty = {
      slug,
      goal: (goalContract && goalContract.north_star_goal) || '',
      books_with_roles: [],
      complementary_pairs: [],
      conflicts: [],
      excluded_content: [],
      synthesis_notes: 'No reference books selected — course generation proceeds without bibliography grounding.',
      generated_at: new Date().toISOString(),
      version: SYNTHESIS_SCHEMA_VERSION,
      _hash: _synthesisHash(goalContract, ids),
    };
    _ensureDir(path.dirname(_synthesisPath(vaultRoot, slug)));
    try { fs.writeFileSync(_synthesisPath(vaultRoot, slug), JSON.stringify(empty, null, 2), 'utf-8'); }
    catch (_) {}
    return empty;
  }

  const hash = _synthesisHash(goalContract, ids);
  if (!force) {
    const cached = _safeReadJSON(_synthesisPath(vaultRoot, slug));
    if (cached && cached._hash === hash && cached.version === SYNTHESIS_SCHEMA_VERSION) {
      cached._cached = true;
      return cached;
    }
  }

  // Parallel build each Book Grounding Profile — sub-cache lookups inside.
  const profiles = await Promise.all(
    ids.map(id => buildBookProfile(id, goalContract, { vaultRoot, slug, force }))
  );

  const goalLine = goalContract && goalContract.north_star_goal
    ? `User Goal: ${goalContract.north_star_goal}\nIntent: ${goalContract.user_intent || '(none)'}\nMain creation: ${goalContract.main_creation || '(none)'}`
    : 'User Goal: (none)';

  const prompt = `You are HYPHA's Grounding Synthesis judge (T6_STRONG class). The user has selected ${ids.length} reference books. Decide how each book serves the curriculum and where they complement / conflict.

${goalLine}

${_renderProfilesDigest(profiles)}

Return STRICT JSON with these 6 fields exactly:
{
  "books_with_roles": [
    { "book_id": "<id>", "role": "primary" | "secondary" | "supplement", "responsibility": "what this book carries for the course (≤120 chars)" }
  ],
  "complementary_pairs": [
    { "book_a": "<id>", "book_b": "<id>", "complement_topic": "where they reinforce each other (≤120 chars)" }
  ],
  "conflicts": [
    { "book_a": "<id>", "book_b": "<id>", "conflict_topic": "where they disagree (≤120 chars)", "resolution": "which side the course adopts + 1-sentence why" }
  ],
  "excluded_content": [
    { "book_id": "<id>", "topic": "what we deliberately skip from this book (≤120 chars)" }
  ],
  "synthesis_notes": "1 paragraph (≤500 chars). The overall plan: which book grounds which phase, which book is mainly a reference, which book is risky and used sparingly."
}

Hard rules:
- Exactly ONE book has role="primary" (the main地基).
- Every book in the input appears in books_with_roles[].
- Conflicts: each conflict MUST have a resolution naming which book the course follows.
- Output JSON only.`;

  // Deterministic fallback synthesis — first book = primary, rest = secondary.
  // intentional-placeholder: fallback string "deterministic fallback" is the
  // signal the renderer uses to mark a synthesis as un-judged so the user
  // knows to refresh once the provider returns.
  const fallback = {
    books_with_roles: profiles.map((p, i) => ({
      book_id: p.book_id,
      role: i === 0 ? 'primary' : 'secondary',
      responsibility: i === 0
        ? `Main 地基 — drives phase ordering and core sparks for "${p.title}".`
        : `Supporting reference — supplements primary on its in-scope sparks.`,
    })),
    complementary_pairs: profiles.length >= 2
      ? [{ book_a: profiles[0].book_id, book_b: profiles[1].book_id, complement_topic: 'deterministic fallback synthesis — pending LLM judge.' }]
      : [],
    conflicts: [],
    excluded_content: [],
    synthesis_notes: 'Deterministic fallback synthesis (LLM bridge unavailable). First book set as primary, others secondary. Refresh via --force once provider is healthy.',
  };

  const judged = await _callSynthesisT6(prompt, fallback);

  // Validate + normalize. Reject malformed roles, enforce single primary,
  // ensure every input book has a row.
  const rolesRaw = Array.isArray(judged.books_with_roles) ? judged.books_with_roles : [];
  const seen = new Set();
  const normRoles = [];
  for (const r of rolesRaw) {
    if (!r || typeof r !== 'object') continue;
    const bid = String(r.book_id || '').trim();
    if (!bid || !ids.includes(bid) || seen.has(bid)) continue;
    const role = VALID_ROLES.has(r.role) ? r.role : 'secondary';
    normRoles.push({
      book_id: bid,
      role,
      responsibility: String(r.responsibility || '').slice(0, 200),
    });
    seen.add(bid);
  }
  // Append any missing books as 'secondary' so the synthesis is complete.
  for (const id of ids) {
    if (!seen.has(id)) {
      const profile = profiles.find(p => p.book_id === id);
      normRoles.push({
        book_id: id,
        role: 'secondary',
        responsibility: `Supplemental — auto-appended from "${(profile && profile.title) || id}".`,
      });
    }
  }
  // Enforce single-primary rule: if 0 primary present, promote the first
  // entry. If >1 primary, demote extras to secondary.
  const primaries = normRoles.filter(r => r.role === 'primary');
  if (primaries.length === 0 && normRoles.length > 0) normRoles[0].role = 'primary';
  if (primaries.length > 1) {
    let kept = false;
    for (const r of normRoles) {
      if (r.role !== 'primary') continue;
      if (kept) r.role = 'secondary';
      else kept = true;
    }
  }

  const synthesis = {
    slug,
    goal: (goalContract && goalContract.north_star_goal) || '',
    books_with_roles: normRoles,
    complementary_pairs: Array.isArray(judged.complementary_pairs)
      ? judged.complementary_pairs.slice(0, 12).map(p => ({
          book_a: String((p && p.book_a) || '').slice(0, 60),
          book_b: String((p && p.book_b) || '').slice(0, 60),
          complement_topic: String((p && p.complement_topic) || '').slice(0, 200),
        }))
      : [],
    conflicts: Array.isArray(judged.conflicts)
      ? judged.conflicts.slice(0, 12).map(c => ({
          book_a: String((c && c.book_a) || '').slice(0, 60),
          book_b: String((c && c.book_b) || '').slice(0, 60),
          conflict_topic: String((c && c.conflict_topic) || '').slice(0, 200),
          resolution: String((c && c.resolution) || '').slice(0, 240),
        }))
      : [],
    excluded_content: Array.isArray(judged.excluded_content)
      ? judged.excluded_content.slice(0, 16).map(e => ({
          book_id: String((e && e.book_id) || '').slice(0, 60),
          topic: String((e && e.topic) || '').slice(0, 200),
        }))
      : [],
    synthesis_notes: String(judged.synthesis_notes || fallback.synthesis_notes).slice(0, 700),
    generated_at: new Date().toISOString(),
    version: SYNTHESIS_SCHEMA_VERSION,
    _hash: hash,
  };

  _ensureDir(path.dirname(_synthesisPath(vaultRoot, slug)));
  try {
    fs.writeFileSync(_synthesisPath(vaultRoot, slug), JSON.stringify(synthesis, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[synthesis] cache write failed:', err && err.message);
  }
  return synthesis;
}

/**
 * Read a cached synthesis from disk. Returns null if missing.
 *
 * @param {string} slug
 * @param {object} opts — { vaultRoot }
 * @returns {object|null}
 */
function getSynthesis(slug, opts = {}) {
  const vaultRoot = opts.vaultRoot;
  if (!vaultRoot || !slug) return null;
  const s = _safeReadJSON(_synthesisPath(vaultRoot, slug));
  if (s) s._cached = true;
  return s;
}

module.exports = {
  SYNTHESIS_SCHEMA_VERSION,
  synthesizeGrounding,
  getSynthesis,
  // Internal helpers exposed for unit tests.
  _synthesisHash,
  _synthesisPath,
  _renderProfilesDigest,
};
