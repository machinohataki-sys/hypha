'use strict';
// HYPHA · Quality Harness · Judge 1 / 9: 目标一致性 (Goal Coherence)
// 关注: lesson body 每个 KP / canonical_example / exit_proof 是否可追溯到 learn_goal.
// 失败模式: goal-drift (主题滑向相邻概念 / 资讯流堆叠 / 与 goal 无关的展示).
// 评分: 0-100, pass >= 50.
// W1.1 scaffold — T4_JUDGE prompt + parser deferred to W1.2.

const DIM_ID = 'goalCoherence';
const PASS_THRESHOLD = 50;

/**
 * @param {object} lessonBody — 11-field v0.2 body (lesson-body-generator.js).
 * @param {{topic: string, userProfile: string, goal: string}} context
 * @returns {Promise<{ dim: string, score: number, rationale: string, evidence: string[], pass: boolean }>}
 */
async function gradeJudge(lessonBody, context) {
  // intentional-placeholder: W1.1 scope = scaffold only per task spec.
  // T4_JUDGE prompt template ("Given LEARN_GOAL=${goal}, score 0-100 how well
  // thesis + canonical_example + exit_proof + jargon_list trace back to goal,
  // list off-goal KP as evidence") + JSON parser wiring deferred to W1.2.
  return {
    dim: DIM_ID,
    score: 0,
    rationale: 'unimplemented (W1.1 scaffold, T4_JUDGE wiring deferred to W1.2)',
    evidence: [],
    pass: false,
  };
}

module.exports = { gradeJudge, DIM_ID, PASS_THRESHOLD };
