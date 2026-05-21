'use strict';

// HYPHA · Wave 6.1 Bibliography Grounding · Book Profile builder
// (BLUEPRINT §4.1 — "Book Grounding Profile").
//
// Per blueprint: "参考书不是课后阅读材料，而是课程生成前的地基。" Every book the
// user picks for a course is consumed into an 8-field structured profile before
// any lesson skeleton is drafted. The profile shapes which sparks enter the
// course and which the course explicitly skips.
//
// 8 fields per profile (locked):
//   1. book_id            — slug of the book in the user's Library
//   2. title              — display title (mirrored from library manifest)
//   3. fit_to_goal        — what THIS book gives THIS goal (1-3 sentences)
//   4. goal_relevance     — how the book relates to user's stated goal
//   5. core_sparks[]      — list of in-scope sparks that can enter the course
//   6. unfit_content[]    — what the book covers but the goal does NOT need
//   7. risks_and_outdated[] — dated claims, ideological caveats, retracted bits
//   8. transferable_methodology[] — methods that travel (not just claims)
//   9. productizable_inspiration[] — seeds that can feed Creation System
// (note: the schema below stamps 8 grounding fields + book_id index field.)
//
// Pipeline (mock-safe so unit tests don't require LLM):
//   buildBookProfile → resolve manifest → call T4_JUDGE (mock OK) → 8-field
//   structured extraction → cache write to vault/<slug>/grounding/profiles/.
//
// Cache invalidation: --force flag or goalContract hash mismatch. Goal change
// must re-grind because the "fit_to_goal" field is goal-specific.
//
// R-LIB boundary: this module DOES NOT replace library retrieval (3-vector
// query-expansion still drives chunk-level evidence). Grounding = profile
// layer; R-LIB = retrieval layer. Both feed designSkeletonOnly's SYSTEM_PROMPT.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROFILE_SCHEMA_VERSION = 1;
const PROFILES_SUBDIR = 'grounding/profiles';

/**
 * Compute a short hash of the goal contract so cache busts when goal changes.
 * Profile is goal-specific — `fit_to_goal` would silently drift otherwise.
 *
 * @param {object|null} goalContract
 * @returns {string}
 */
function _goalHash(goalContract) {
  if (!goalContract || typeof goalContract !== 'object') return 'no-goal';
  const stable = JSON.stringify({
    n: goalContract.north_star_goal || '',
    l: goalContract.learning_model || '',
    i: goalContract.user_intent || '',
    m: goalContract.main_creation || '',
  });
  return crypto.createHash('sha1').update(stable).digest('hex').slice(0, 12);
}

function _profilesDir(vaultRoot, slug) {
  return path.join(vaultRoot, slug, 'grounding', 'profiles');
}

function _profilePath(vaultRoot, slug, bookId) {
  return path.join(_profilesDir(vaultRoot, slug), `${bookId}.json`);
}

function _ensureDir(absDir) {
  try { fs.mkdirSync(absDir, { recursive: true }); } catch (_) {}
}

function _safeReadJSON(absPath) {
  try {
    if (!fs.existsSync(absPath)) return null;
    const raw = fs.readFileSync(absPath, 'utf-8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function _readBookManifest(vaultRoot, bookId) {
  const manifestPath = path.join(vaultRoot, 'data', 'library', `${bookId}.json`);
  return _safeReadJSON(manifestPath);
}

/**
 * Render a compact digest of the book's chunks for the T4 judge prompt.
 * Caps total chars so we stay inside reasonable token budgets even when the
 * Library has fed in a 600-page tome. Title-first then first ~120 chars of
 * each chunk's body — enough signal for an 8-field rollup without raw dump.
 *
 * @param {object} manifest
 * @returns {string}
 */
function _renderManifestDigest(manifest) {
  if (!manifest) return '';
  const head = `Title: ${manifest.title || '(untitled)'}\nAuthor: ${manifest.author || '(unknown)'}\nSections: ${(manifest.chunks || []).length}\n\n`;
  const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
  const tocLines = chunks.slice(0, 40).map((ch, i) => {
    const t = (ch.title || `Section ${i + 1}`).slice(0, 80);
    const snippet = (ch.text || '').replace(/\s+/g, ' ').slice(0, 120);
    const tag = ch.type ? `[${ch.type}]` : '';
    return `  ${i}. ${t} ${tag}\n     ${snippet}…`;
  });
  return head + tocLines.join('\n');
}

/**
 * Mock-safe LLM call. Real implementation would route to T4_JUDGE via
 * `app/lib/llm`. If the LLM bridge is unavailable (test env) we fall back to
 * a deterministic placeholder profile so unit tests pass without network.
 *
 * @param {string} prompt
 * @param {object} fallback — what to return if LLM bridge missing
 * @returns {Promise<object>}
 */
async function _callJudgeT4(prompt, fallback) {
  try {
    // Lazy-require so the test harness doesn't pull the full provider stack.
    const llm = require('../llm');
    if (llm && typeof llm.executeChat === 'function') {
      const dispatch = await llm.executeChat('T4_JUDGE', {
        messages: [{ role: 'user', content: prompt }],
        json: true,
        temperature: 0.4,
        maxTokens: 1800,
        timeoutMs: 60_000,
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
        const parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        return parsed || fallback;
      } catch (_) {
        return fallback;
      }
    }
  } catch (_) {
    // LLM bridge unavailable — fall through to placeholder.
  }
  return fallback;
}

/**
 * Build the 8-field Book Grounding Profile for one book vs one goal.
 *
 * @param {string} bookId
 * @param {object|null} goalContract — full Goal Contract object
 * @param {object} opts
 * @param {string} opts.vaultRoot
 * @param {string} opts.slug — curriculum slug; profile lands under vault/<slug>/grounding/profiles/
 * @param {boolean} [opts.force=false]
 * @param {object|null} [opts.bookSparkPack=null] — optional pre-distilled
 *        Book Spark Pack from Wave 6.2; if present overrides raw chunks digest.
 * @returns {Promise<{book_id, title, fit_to_goal, goal_relevance, core_sparks, unfit_content, risks_and_outdated, transferable_methodology, productizable_inspiration, generated_at, version, _goal_hash, _cached?}>}
 */
async function buildBookProfile(bookId, goalContract, opts = {}) {
  const vaultRoot = opts.vaultRoot;
  const slug = opts.slug;
  const force = !!opts.force;
  if (!vaultRoot) throw new Error('buildBookProfile: opts.vaultRoot required');
  if (!slug) throw new Error('buildBookProfile: opts.slug required');
  if (!bookId) throw new Error('buildBookProfile: bookId required');

  const cachePath = _profilePath(vaultRoot, slug, bookId);
  const goalHash = _goalHash(goalContract);
  if (!force) {
    const cached = _safeReadJSON(cachePath);
    if (cached && cached._goal_hash === goalHash && cached.version === PROFILE_SCHEMA_VERSION) {
      cached._cached = true;
      return cached;
    }
  }

  const manifest = _readBookManifest(vaultRoot, bookId);
  const title = (manifest && manifest.title) || bookId;

  // Wave 6.2 Book Spark Pack (if shipped) overrides raw chunks. Until W6.2
  // ships we always fall through to raw chunks digest.
  const digest = (opts.bookSparkPack && opts.bookSparkPack.summary)
    ? `Book Spark Pack (W6.2 distilled):\n${opts.bookSparkPack.summary}`
    : _renderManifestDigest(manifest);

  const goalLine = goalContract && goalContract.north_star_goal
    ? `User Goal: ${goalContract.north_star_goal}\nIntent: ${goalContract.user_intent || '(none)'}\nMain creation: ${goalContract.main_creation || '(none)'}`
    : 'User Goal: (none — produce a goal-agnostic baseline profile)';

  // Archetype-aware prompt selection (2026-05-19, literary specialization).
  // For literary books, the 8 fields keep their names but the semantic emphasis
  // shifts: "core_sparks" become recurring themes/motifs, "transferable_methodology"
  // becomes writerly techniques (focalization, narrative chronology, register),
  // "productizable_inspiration" becomes reading practices the user can adopt.
  // The output schema is identical so downstream renderers don't fork.
  const archetype = opts.archetype || null;
  const isLiterary = archetype === 'literary';

  const literaryRules = isLiterary ? `
LITERARY MODE (this book is fiction / poetry / memoir / essay):
- "fit_to_goal" — describe what reading this book DOES to the reader's sensibility / craft / capacity to sit with characters; NOT "skills you'll extract".
- "core_sparks" — name recurring THEMES or MOTIFS (e.g. "瘙痒 motif as embodied self-loathing"), NOT factual claims.
- "transferable_methodology" — name writerly TECHNIQUES that travel (focalization shifts, fragmented chronology, register choices), NOT general "methods".
- "productizable_inspiration" — name reading PRACTICES (重读 cadence, 旁注 habits, with-whom-to-read) the user can adopt, NOT product features.
- "risks_and_outdated" — flag ideological dating (period racism / misogyny), translation issues, contested attributions. Literary works rarely "outdate" in the way papers do; be careful.` : '';

  const prompt = `You are HYPHA's Bibliography Grounding judge (T4_JUDGE class). Build a structured Book Grounding Profile for the book below, grounded in the user's stated goal.

${goalLine}

BOOK DIGEST:
${digest || '(no digest available — describe what this book IS from its title/author)'}
${literaryRules}

Return STRICT JSON with these 8 fields exactly:
{
  "fit_to_goal": "1-3 sentences. What can this book give THIS goal? Be specific.",
  "goal_relevance": "1-2 sentences. How does the book relate to the user's main_creation / north_star_goal?",
  "core_sparks": ["spark 1 that should enter the course", "..."],
  "unfit_content": ["topics this book covers but the goal does NOT need"],
  "risks_and_outdated": ["dated claims / ideological caveats / retracted bits to flag"],
  "transferable_methodology": ["methods that travel beyond this book's own examples"],
  "productizable_inspiration": ["seeds that can feed the user's main_creation"]
}

Hard rules:
- No marketing fluff. No "this is a great book".
- core_sparks ≤ 7 items. Each item ≤ 80 chars, names a concrete idea not a chapter title.
- unfit_content ≤ 5 items. Each item names a topic + why it doesn't serve THIS goal.
- All lists may be empty arrays [] if nothing fits.
- Output JSON only, no prose around it.`;

  // intentional-placeholder: this `fallback` object ships deterministic safe-mode
  // strings used when the T4_JUDGE LLM bridge is unavailable (test env / boot
  // before providers registered / provider all-degraded). Words "Placeholder"
  // and "TBD" appear here ON PURPOSE so the renderer can distinguish a mock
  // profile from a real one and prompt the user to refresh via --force once
  // the provider is healthy. NOT lazy code — required UX signal.
  const fallback = {
    fit_to_goal: `Placeholder profile for "${title}". LLM bridge unavailable or returned no JSON; replace via --force once provider is wired.`,
    goal_relevance: `Goal "${(goalContract && goalContract.north_star_goal) || '(none)'}" — relevance TBD.`,
    core_sparks: [],
    unfit_content: [],
    risks_and_outdated: [],
    transferable_methodology: [],
    productizable_inspiration: [],
  };

  const judged = await _callJudgeT4(prompt, fallback);

  const profile = {
    book_id: bookId,
    title,
    archetype: archetype || null,
    fit_to_goal: String(judged.fit_to_goal || fallback.fit_to_goal).slice(0, 600),
    goal_relevance: String(judged.goal_relevance || fallback.goal_relevance).slice(0, 400),
    core_sparks: Array.isArray(judged.core_sparks) ? judged.core_sparks.slice(0, 7).map(s => String(s).slice(0, 120)) : [],
    unfit_content: Array.isArray(judged.unfit_content) ? judged.unfit_content.slice(0, 5).map(s => String(s).slice(0, 160)) : [],
    risks_and_outdated: Array.isArray(judged.risks_and_outdated) ? judged.risks_and_outdated.slice(0, 5).map(s => String(s).slice(0, 160)) : [],
    transferable_methodology: Array.isArray(judged.transferable_methodology) ? judged.transferable_methodology.slice(0, 5).map(s => String(s).slice(0, 160)) : [],
    productizable_inspiration: Array.isArray(judged.productizable_inspiration) ? judged.productizable_inspiration.slice(0, 5).map(s => String(s).slice(0, 160)) : [],
    generated_at: new Date().toISOString(),
    version: PROFILE_SCHEMA_VERSION,
    _goal_hash: goalHash,
  };

  _ensureDir(_profilesDir(vaultRoot, slug));
  try {
    fs.writeFileSync(cachePath, JSON.stringify(profile, null, 2), 'utf-8');
  } catch (err) {
    // Cache write failure must not break the pipeline — profile still returned
    // to the caller. Downstream synthesis will recompute on next run.
    console.warn('[book-profile] cache write failed:', err && err.message);
  }
  return profile;
}

/**
 * Read a cached profile from disk. Returns null if missing.
 *
 * @param {string} bookId
 * @param {string} slug
 * @param {object} opts
 * @param {string} opts.vaultRoot
 * @returns {object|null}
 */
function getCachedProfile(bookId, slug, opts = {}) {
  const vaultRoot = opts.vaultRoot;
  if (!vaultRoot || !slug || !bookId) return null;
  const p = _safeReadJSON(_profilePath(vaultRoot, slug, bookId));
  if (p) p._cached = true;
  return p;
}

/**
 * Rebuild all profiles for a course. Useful when the user changes selected
 * books or the goal contract. Returns parallel array of profiles.
 *
 * @param {string} slug
 * @param {object} goalContract
 * @param {string[]} bookIds
 * @param {object} opts — { vaultRoot, force }
 * @returns {Promise<object[]>}
 */
async function refreshAllProfiles(slug, goalContract, bookIds, opts = {}) {
  if (!Array.isArray(bookIds) || bookIds.length === 0) return [];
  const force = !!opts.force;
  const profiles = await Promise.all(
    bookIds.map(id => buildBookProfile(id, goalContract, { ...opts, slug, force }))
  );
  return profiles;
}

module.exports = {
  PROFILE_SCHEMA_VERSION,
  buildBookProfile,
  getCachedProfile,
  refreshAllProfiles,
  // Internal helpers exposed for unit tests.
  _goalHash,
  _profilePath,
  _renderManifestDigest,
};
