'use strict';
// HYPHA · Quality Harness · Judge 3 / 9: 水平匹配 (Level Match)
// 关注: lesson body 难度 vs userProfile (零基础 / 中级 / 进阶) 是否对齐.
// 信号: mechanism_explanation 的抽象度 / canonical_example 的依赖前置知识 /
//       jargon_list 是否假设了 userProfile 不该有的前提.
// 失败模式: prerequisite-skip (零基础课直跳 frontier paper), patronizing (进阶者读到小学解释).
// 评分: 0-100, pass >= 50.

const DIM_ID = 'levelMatch';
const PASS_THRESHOLD = 50;

async function gradeJudge(lessonBody, context) {
  // intentional-placeholder: W1.1 scope = scaffold only per task spec.
  // W1.2 T4_JUDGE prompt rubric ("estimate min prerequisite knowledge implied
  // by mechanism_explanation + canonical_example; compare against userProfile;
  // score 100 = exact match, 0 = catastrophic mismatch") deferred.
  return {
    dim: DIM_ID,
    score: 0,
    rationale: 'unimplemented (W1.1 scaffold)',
    evidence: [],
    pass: false,
  };
}

module.exports = { gradeJudge, DIM_ID, PASS_THRESHOLD };
