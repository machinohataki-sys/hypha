'use strict';
// HYPHA · Quality Harness · Judge 9 / 9: 是否有 HYPHA 灵魂 (Hypha Soul)
// 最终聚合判: 即使前 8 dim 各自及格, 整 lesson 是否真的体现 HYPHA WHY 的 3 件事:
//   1. 反工业化教育 (Feynman 测试, 不是 recall)
//   2. 破信息差 (引入 frontier / 跨语 / 顶尖人物原话)
//   3. 反 AI 伪知识 + 反讨好 + 推理可读 + 人格连贯
// 信号: lesson 是否引一手原文 / 是否承认 limit / 是否敢驳 user 直觉 / 是否
//       让 user 课后真的对世界做一件不同的事.
// 失败模式: technically-correct-but-soulless (前 8 项及格, 整体仍是网课感).
// 评分: 0-100, pass >= 50. 此 judge 权重在 overall_pass 公式里加倍.

const DIM_ID = 'hyphaSoul';
const PASS_THRESHOLD = 50;
const OVERALL_WEIGHT = 2; // overall_pass 中此 dim 双倍权重 (per ROADMAP v0.2 验收)

async function gradeJudge(lessonBody, context) {
  // intentional-placeholder: W1.1 scope = scaffold only per task spec.
  // W1.2 T4_JUDGE aggregates prior 8 dim outputs + full lesson text +
  // (optional) frontier citations matrix, returns a 1-paragraph "if HYPHA
  // founder read this lesson, would she ship it?" intuitive verdict.
  // Subjective by design; not purely algorithmic. Wiring deferred to W1.2.
  return {
    dim: DIM_ID,
    score: 0,
    rationale: 'unimplemented (W1.1 scaffold)',
    evidence: [],
    pass: false,
  };
}

module.exports = { gradeJudge, DIM_ID, PASS_THRESHOLD, OVERALL_WEIGHT };
