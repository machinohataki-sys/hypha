'use strict';
// HYPHA · v0.3 chain-folder — pure-JS post-processor on planChain output.
//
// Why: planChain (agent.js:2676+) tier-scaled + role-escalated lesson counts
// can produce chains exceeding 700 lessons (heroic tier × 8 links worst case
// ≈ 1040). Per BLUEPRINT §1.1 (路径熵减) + §1.5 (不做无限生成) + §6.3
// (Prerequisite Patch tiers), an over-broad chain is a curriculum design bug,
// not a feature. User direction 2026-05-08: cap chain size, fold per
// archetype phase + role.
//
// This module is the safety net: take planChain's `links` array, apply
// soft caps per learning_model, fold prerequisite redundancy, dampen
// heroic-tier excess, and surface NEEDS_REROUTE when even the cap can't
// be honored without breaking the hard ceiling. No LLM calls.
//
// Caps (per BLUEPRINT §1.5 cadence + SocraticAI 8-queries/day evidence):
//   Exam   = 20 lessons  (deadline-anchored, scope already tight)
//   Growth = 30          (default, balanced for daily-practice cadence)
//   Hybrid = 25          (split priorities, narrower)
//   Hard   = 60          (above this = curriculum redesign, not folding)
//
// Per-role caps (folding target, NOT planChain spec):
//   prerequisite = 25    (foundational, lean on purpose)
//   core         = 50    (substantive, mid-depth)
//   ultimate     = 100   (user's actual goal — preserve depth)

const SOFT_CAPS = Object.freeze({ Exam: 20, Growth: 30, Hybrid: 25 });
const HARD_CAP = 60;
const ROLE_CAPS = Object.freeze({
  prerequisite: 25,
  core: 50,
  ultimate: 100,
});

function totalLessons(links) {
  if (!Array.isArray(links)) return 0;
  return links.reduce((sum, l) => sum + (Number(l && l.lessons_count) || 0), 0);
}

/**
 * Apply soft-cap folding to a planChain output.
 *
 * @param {object} args
 * @param {Array}  args.links - planChain output `chain.links` (each: {topic, duration_weeks, lessons_count, role, rationale, exit_criterion})
 * @param {string} args.mode  - 'Exam' | 'Growth' | 'Hybrid' (from goalContract.learning_model)
 * @param {string} [args.tier]      - 'gentle' | 'moderate' | 'heroic' (planChain tier_mult basis)
 * @param {string} [args.archetype] - reserved for future phase-aware folding (TECH-CONCEPT etc.)
 * @returns {{folded: Array, foldDecisions: Array, status: 'OK'|'NEEDS_REROUTE'}}
 */
function foldChain({ links, mode, tier, archetype } = {}) {
  if (!Array.isArray(links) || links.length === 0) {
    return { folded: [], foldDecisions: [], status: 'OK' };
  }

  const softCap = SOFT_CAPS[mode] || SOFT_CAPS.Growth;
  const decisions = [];
  let folded = links.map(l => Object.assign({}, l));  // shallow clone

  // Step 1: total under soft cap → no folding
  let total = totalLessons(folded);
  if (total <= softCap) {
    return { folded, foldDecisions: decisions, status: 'OK' };
  }

  // Step 2: per-role caps — clamp each link to its role's ceiling
  folded.forEach((link, i) => {
    const role = String(link.role || 'core').toLowerCase();
    const cap = ROLE_CAPS[role] || ROLE_CAPS.core;
    const before = Number(link.lessons_count) || 0;
    if (before > cap) {
      link.lessons_count = cap;
      decisions.push({
        action: 'role_cap', idx: i, role, from: before, to: cap,
        reason: `${role} link exceeded role cap of ${cap}`,
      });
    }
  });
  total = totalLessons(folded);

  // Step 3: heroic-tier dampening (× 0.75) if still over
  if (total > softCap && tier === 'heroic') {
    folded.forEach((link, i) => {
      const before = Number(link.lessons_count) || 0;
      const after = Math.max(15, Math.round(before * 0.75));
      if (after !== before) {
        link.lessons_count = after;
        decisions.push({
          action: 'heroic_dampen', idx: i, factor: 0.75, from: before, to: after,
          reason: 'heroic-tier 0.75× scale to honor soft cap',
        });
      }
    });
    total = totalLessons(folded);
  }

  // Step 4: merge first pair of adjacent prerequisites if still over
  if (total > softCap) {
    for (let i = 0; i < folded.length - 1; i++) {
      const cur = folded[i];
      const nxt = folded[i + 1];
      const curRole = String(cur.role || '').toLowerCase();
      const nxtRole = String(nxt.role || '').toLowerCase();
      if (curRole === 'prerequisite' && nxtRole === 'prerequisite') {
        const merged = {
          topic: `${cur.topic} + ${nxt.topic}`,
          duration_weeks: (Number(cur.duration_weeks) || 0) + (Number(nxt.duration_weeks) || 0),
          lessons_count: Math.min(
            ROLE_CAPS.prerequisite,
            (Number(cur.lessons_count) || 0) + (Number(nxt.lessons_count) || 0)
          ),
          role: 'prerequisite',
          rationale: cur.rationale,
          exit_criterion: nxt.exit_criterion,
        };
        folded.splice(i, 2, merged);
        decisions.push({
          action: 'merged', from: [i, i + 1], result: i,
          reason: 'adjacent prerequisite merge to compress foundation phase',
        });
        break;  // one merge per pass — keep predictable
      }
    }
    total = totalLessons(folded);
  }

  // Step 5: hard cap check — if even after all folds we're above 60, the
  // chain is too broad for one curriculum. Surface NEEDS_REROUTE so the
  // chain:create handler can route to chain:refuse / chain:propose-prereqs.
  if (total > HARD_CAP) {
    return { folded, foldDecisions: decisions, status: 'NEEDS_REROUTE' };
  }

  return { folded, foldDecisions: decisions, status: 'OK' };
}

module.exports = {
  foldChain,
  totalLessons,
  SOFT_CAPS,
  HARD_CAP,
  ROLE_CAPS,
};
