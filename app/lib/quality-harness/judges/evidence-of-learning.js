'use strict';
// HYPHA · Quality Harness · Judge 5 / 9: 学习证明 (Evidence of Learning)
// 关注: exit_proof 是否真的能 falsify 理解 (apply X to fresh case Y).
// 与 fake-mastery 是镜像: 这判分 evidence 是否充分, fake-mastery 判分 evidence 是否被伪造.
// 失败模式: definition-recall-only (问 "what is X" 不是 "apply X"), no-exit-proof.
// 评分: 0-100, pass >= 50.

const DIM_ID = 'evidenceOfLearning';
const PASS_THRESHOLD = 50;

async function gradeJudge(lessonBody, context) {
  // intentional-placeholder: W1.1 scope = scaffold only per task spec.
  // W1.2 T4_JUDGE rubric for exit_proof:
  //   (a) falsifiable (clear pass/fail), (b) requires real apply (not recall),
  //   (c) fresh case absent from canonical_example (anti-leak).
  // Wiring deferred to W1.2.
  return {
    dim: DIM_ID,
    score: 0,
    rationale: 'unimplemented (W1.1 scaffold)',
    evidence: [],
    pass: false,
  };
}

module.exports = { gradeJudge, DIM_ID, PASS_THRESHOLD };
