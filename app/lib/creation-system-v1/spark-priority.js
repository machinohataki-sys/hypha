'use strict';

// HYPHA · W5.4 Creation System v1 — Spark Priority Ranking
//
// Per BLUEPRINT §11.4 + ROADMAP v1.4. Sparks accumulate as the user learns
// — without ranking they form an undifferentiated backlog. This module
// scores each spark against four factors so the UI can surface "the one
// spark you should consider this week" instead of a chronological wall.
//
// Boundary:
//   W3.4 product-spark.js  — owns spark CRUD + state machine. We import
//                            listSparks() + use the spark shape verbatim.
//                            We never mutate sparks; ranking is read-only.
//   W3.3 product-transfer.js — optional P refresh when caller passes
//                              { recomputeP: true } — defaults off so the
//                              ranking is cheap (no LLM call).
//
// Factors (each normalized to [0, 1]; final score = weighted sum):
//   STATE          (weight 0.40) — seed > considered > accepted, deprioritize
//                                  terminal states (rejected = 0)
//   AGE            (weight 0.20) — newer sparks rank higher (decay over 30d)
//   AFFECTED_MOD   (weight 0.15) — more affected_modules => broader impact
//   RELEVANCE_P    (weight 0.25) — cached P from W3.3 if available, else 0.5

const STATE_WEIGHTS = Object.freeze({
  seed: 1.0,
  considered: 0.85,
  accepted: 0.70,
  implemented: 0.20, // terminal but valuable — keep visible
  rejected: 0.00,
});

const WEIGHTS = Object.freeze({
  state: 0.40,
  age: 0.20,
  affected_modules: 0.15,
  relevance: 0.25,
});

const MAX_AGE_DAYS = 30;

let _sparkMod = null;
function _getSpark() {
  if (_sparkMod !== null) return _sparkMod;
  try { _sparkMod = require('../product-spark'); }
  catch (_) { _sparkMod = false; }
  return _sparkMod;
}

// ---------------------------------------------------------------------------
// _ageScore — newer = 1.0, decays linearly to 0 at MAX_AGE_DAYS. Sparks
// older than MAX_AGE_DAYS clamp at 0.0.
// ---------------------------------------------------------------------------
function _ageScore(createdAtIso) {
  if (!createdAtIso) return 0.5; // unknown age — neutral
  const t = Date.parse(createdAtIso);
  if (!Number.isFinite(t)) return 0.5;
  const days = (Date.now() - t) / (24 * 60 * 60 * 1000);
  if (days <= 0) return 1.0;
  if (days >= MAX_AGE_DAYS) return 0.0;
  return 1.0 - (days / MAX_AGE_DAYS);
}

function _modulesScore(arr) {
  const n = Array.isArray(arr) ? arr.length : 0;
  // 0 mods => 0.3; 1 mod => 0.5; 2 => 0.75; 3+ => 1.0. Caps cross-cutting impact.
  if (n === 0) return 0.3;
  if (n === 1) return 0.5;
  if (n === 2) return 0.75;
  return 1.0;
}

function _stateScore(state) {
  const w = STATE_WEIGHTS[state];
  return Number.isFinite(w) ? w : 0.5;
}

function _relevanceScore(spark) {
  // intentional-placeholder: W3.3 product-transfer does not cache the P
  // relevance score onto the spark file today, so a hot recompute would
  // require an LLM call per spark (forbidden by W5.4 brief: "LLM 调用全
  // mock"). We read any pre-stamped numeric `P` or `relevance` field if a
  // future caller sets one, else fall back to neutral 0.5. Real wire-up:
  // when W3.3 starts persisting P onto spark frontmatter (or W5.4 caller
  // passes recomputeP=true and we batch through product-transfer), this
  // branch starts seeing real numbers without an API change here.
  if (typeof spark.P === 'number' && Number.isFinite(spark.P)) {
    return Math.max(0, Math.min(1, spark.P));
  }
  if (typeof spark.relevance === 'number' && Number.isFinite(spark.relevance)) {
    return Math.max(0, Math.min(1, spark.relevance));
  }
  return 0.5;
}

// ---------------------------------------------------------------------------
// _scoreOne — pure function so the test surface is trivial.
// ---------------------------------------------------------------------------
function _scoreOne(spark) {
  const s_state = _stateScore(spark.state);
  const s_age = _ageScore(spark.created_at);
  const s_mods = _modulesScore(spark.affected_modules);
  const s_rel = _relevanceScore(spark);
  const total = (
    WEIGHTS.state * s_state +
    WEIGHTS.age * s_age +
    WEIGHTS.affected_modules * s_mods +
    WEIGHTS.relevance * s_rel
  );
  return {
    score: Math.round(total * 1000) / 1000,
    components: {
      state: s_state,
      age: s_age,
      affected_modules: s_mods,
      relevance: s_rel,
    },
  };
}

// ---------------------------------------------------------------------------
// rankSparks — accept either an explicit sparks array OR a slug (in which
// case we listSparks from W3.4). Returns a ranked array, score desc.
// Terminal states (rejected) sink to bottom; accepted-but-non-terminal stays
// midrange to let seed > considered > accepted dominate as the brief says.
// ---------------------------------------------------------------------------
function rankSparks(slug, sparks) {
  let pool = Array.isArray(sparks) ? sparks : null;
  if (!pool) {
    const mod = _getSpark();
    if (!mod || typeof mod.listSparks !== 'function') {
      return { ok: false, ranked: [], reason: 'spark_lib_missing' };
    }
    try { pool = mod.listSparks(slug); }
    catch (err) { return { ok: false, ranked: [], reason: err && err.message }; }
  }
  if (!Array.isArray(pool)) return { ok: false, ranked: [], reason: 'no_sparks' };

  const ranked = pool.map((s) => {
    const sc = _scoreOne(s);
    return {
      spark_id: s.spark_id,
      state: s.state,
      created_at: s.created_at,
      affected_modules: s.affected_modules || [],
      core_transfer: s.core_transfer || '',
      score: sc.score,
      components: sc.components,
      terminal: (s.state === 'rejected' || s.state === 'implemented'),
    };
  });

  ranked.sort((a, b) => {
    // Sink rejected to the very bottom regardless of score.
    if (a.state === 'rejected' && b.state !== 'rejected') return 1;
    if (b.state === 'rejected' && a.state !== 'rejected') return -1;
    return b.score - a.score;
  });

  return { ok: true, ranked, slug, weights: WEIGHTS };
}

// ---------------------------------------------------------------------------
// getNextSparkToConsider — pick the single spark the user should look at
// next. Filters terminal states + sparks already in `considered` (we want
// to surface a NEW one to transition from seed → considered) unless the
// user has no seeds at all, in which case we fall back to top non-terminal.
// ---------------------------------------------------------------------------
function getNextSparkToConsider(slug, opts = {}) {
  const r = rankSparks(slug, opts.sparks);
  if (!r.ok) return { ok: false, reason: r.reason };
  const ranked = r.ranked;
  // First pass — only seeds (highest priority per state weight)
  const seeds = ranked.filter(s => s.state === 'seed');
  if (seeds.length > 0) return { ok: true, spark: seeds[0], reason: 'top_seed' };
  // Second pass — considered (user is mid-flight; nudge to accepted)
  const considered = ranked.filter(s => s.state === 'considered');
  if (considered.length > 0) return { ok: true, spark: considered[0], reason: 'top_considered' };
  // Third pass — accepted (user should ship; nudge to implemented)
  const accepted = ranked.filter(s => s.state === 'accepted');
  if (accepted.length > 0) return { ok: true, spark: accepted[0], reason: 'top_accepted' };
  return { ok: true, spark: null, reason: 'no_non_terminal_sparks' };
}

module.exports = {
  rankSparks,
  getNextSparkToConsider,
  STATE_WEIGHTS,
  WEIGHTS,
  MAX_AGE_DAYS,
  _internals: {
    scoreOne: _scoreOne,
    stateScore: _stateScore,
    ageScore: _ageScore,
    modulesScore: _modulesScore,
    relevanceScore: _relevanceScore,
  },
};
