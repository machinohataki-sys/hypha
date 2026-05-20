'use strict';
// HYPHA · Quality Harness · Judge 4 / 9: 误解防护 (Misconception Defense)
// 关注: common_misconceptions 数组是否真的覆盖该 topic + level 最高发的两个错误先验,
//       而不是 strawman / 通用占位 ("学生有时会以为 X" 但 X 实际无人会信).
// 信号: 两条 misconception 是否 falsifiable / 是否点对点对应 thesis / 纠正是否清晰.
// 失败模式: strawman-misconception, vacuous-misconception, no-correction.
// 评分: 0-100, pass >= 50.

const DIM_ID = 'misconceptionDefense';
const PASS_THRESHOLD = 50;

async function gradeJudge(lessonBody, context) {
  // intentional-placeholder: W1.1 scope = scaffold only per task spec.
  // W1.2 will pair T4_JUDGE with frontier source pull to validate misconception
  // authenticity (top-tier 入门 講義 typically refutes 2 prior errors in 5 min).
  // Deferred to W1.2 alongside other judge LLM wiring.
  return {
    dim: DIM_ID,
    score: 0,
    rationale: 'unimplemented (W1.1 scaffold)',
    evidence: [],
    pass: false,
  };
}

module.exports = { gradeJudge, DIM_ID, PASS_THRESHOLD };
