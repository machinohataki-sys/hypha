'use strict';

// HYPHA · 阶 3 北极星 metric — Bandit Frontier next-lesson picker (2026-05-17).
//
// 用 explore-exploit 经典 (Thompson sampling proxy) 算每个 draft/review concept
// 的 frontier score, 推 user 下一节最该学哪个 concept。
//
//   score = mastery_score × (1 − mastery_score) × novelty_bonus × age_decay
//     - mastery × (1 - mastery) = 经典 bandit explore-exploit
//     - novelty_bonus = 1.2 if state=='draft', 1.0 if 'review'
//     - age_decay = 1 / (1 + days_since_last_signal / 7)
//
// 输入来源:
//   - vault/<slug>/.mastery-signals.jsonl  (mastery-tracker EWMA)
//   - vault/<slug>/.concept-lifecycle.jsonl (concept-lifecycle 状态)
//
// 输出:
//   { ok:true, concept:'<name>', score:0.84,
//     reason:'你 7 个 draft 里 transformer-attention ... bandit 判定...' }
//   或空状态:
//   { ok:true, concept:null, reason:'所有概念已 ratified, 该开新章了' }
//
// 纯算法, 不 LLM。reason 模板生成。

const masteryTracker = require('../lesson-system/mastery-tracker');
const conceptLifecycle = require('../lesson-system/concept-lifecycle');

const NOVELTY_BONUS = Object.freeze({
  draft: 1.2,
  review: 1.0,
});

const AGE_DECAY_HALFLIFE_DAYS = 7;

function _validateSlug(slug) {
  return typeof slug === 'string' && slug.trim().length > 0;
}

// days_since_last_signal → age_decay (∈ (0, 1])
//   ts === null  → assume "ages ago", decay = 1 (fresh探索 candidate)
//   recent ts    → decay closer to 1
//   stale ts     → decay → 0
function _ageDecay(lastSignalAt) {
  if (!lastSignalAt) return 1; // never seen → max-bandit探索
  const t = Date.parse(lastSignalAt);
  if (!Number.isFinite(t)) return 1;
  const days = Math.max(0, (Date.now() - t) / (1000 * 60 * 60 * 24));
  return 1 / (1 + days / AGE_DECAY_HALFLIFE_DAYS);
}

function _bandit(masteryScore, state, lastSignalAt) {
  const explore = masteryScore * (1 - masteryScore);
  const novelty = NOVELTY_BONUS[state] || 1.0;
  const decay = _ageDecay(lastSignalAt);
  return explore * novelty * decay;
}

function _renderReason({ candidates, top, draftCount, reviewCount }) {
  if (!top) {
    return draftCount + reviewCount === 0
      ? '所有概念已 ratified, 该开新章了'
      : '所有候选都已 ratified, 该开新章了';
  }
  const bucket = top.state === 'draft' ? 'draft' : 'review';
  const bucketSize = bucket === 'draft' ? draftCount : reviewCount;
  const masteryPct = (top.masteryScore * 100).toFixed(0);
  const scorePct = (top.score * 100).toFixed(0);
  // 模板, 不 LLM:
  if (top.state === 'draft' && top.masteryScore > 0.7) {
    return `你 ${bucketSize} 个 ${bucket} 里 ${top.name} 掌握度跳到 ${masteryPct}% 但没 ratify, bandit 判定再追一节就稳。`;
  }
  if (top.state === 'review' && top.masteryScore < 0.5) {
    return `${top.name} 已进 review 但掌握度 ${masteryPct}%, 这节是把它推过 ratify 线的最高 ROI 一击。`;
  }
  if (top.masteryScore < 0.4) {
    return `${top.name} 掌握度只 ${masteryPct}%, 距离 ratify 还远, bandit 算 frontier score ${scorePct}% 排第一。`;
  }
  return `${top.name} (${bucket}) 当前 frontier score ${scorePct}%, 在 ${candidates.length} 个候选里 ROI 最高。`;
}

/**
 * Pick the next lesson concept using bandit-frontier scoring.
 * @param {object} params
 * @param {string} params.slug
 * @param {number} [params.maxCandidates=5]
 * @returns {Promise<{ok:true, concept:string|null, score?:number, reason:string, candidates?:object[]}|{ok:false, error}>}
 */
async function pickNextLesson({ slug, maxCandidates = 5 } = {}) {
  try {
    if (!_validateSlug(slug)) {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const cap = (typeof maxCandidates === 'number' && maxCandidates > 0)
      ? Math.floor(maxCandidates)
      : 5;

    // load concept lifecycle — only draft + review are candidates
    const conceptsRes = await conceptLifecycle.listConcepts({ slug });
    if (!conceptsRes.ok) {
      return { ok: false, error: conceptsRes.error || 'EXCEPTION' };
    }
    const draftReview = conceptsRes.concepts.filter(
      c => c.state === 'draft' || c.state === 'review'
    );
    const draftCount = draftReview.filter(c => c.state === 'draft').length;
    const reviewCount = draftReview.filter(c => c.state === 'review').length;

    if (draftReview.length === 0) {
      // either no concepts at all OR every concept is ratified/superseded/deprecated
      return {
        ok: true,
        concept: null,
        reason: _renderReason({
          candidates: [],
          top: null,
          draftCount,
          reviewCount,
        }),
      };
    }

    // score each candidate
    const scored = [];
    for (const c of draftReview) {
      // mastery-tracker keys by concept NAME (not conceptId) — match its API
      const mres = await masteryTracker.getMasteryScore({
        slug,
        concept: c.name,
      });
      const masteryScore = (mres.ok && typeof mres.score === 'number')
        ? mres.score
        : masteryTracker.DEFAULT_SCORE;
      const lastSignalAt = (mres.ok ? mres.lastSignalAt : null);
      const score = _bandit(masteryScore, c.state, lastSignalAt);
      scored.push({
        conceptId: c.conceptId,
        name: c.name,
        state: c.state,
        masteryScore,
        lastSignalAt,
        score,
      });
    }
    // sort desc by score
    scored.sort((a, b) => b.score - a.score);
    const candidates = scored.slice(0, cap);
    const top = candidates[0];

    return {
      ok: true,
      concept: top.name,
      score: top.score,
      reason: _renderReason({ candidates, top, draftCount, reviewCount }),
      candidates,
    };
  } catch (err) {
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

module.exports = {
  pickNextLesson,
  _internals: {
    NOVELTY_BONUS,
    AGE_DECAY_HALFLIFE_DAYS,
    _bandit,
    _ageDecay,
  },
};
