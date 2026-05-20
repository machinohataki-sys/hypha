'use strict';
// HYPHA · Quality Harness · Judge 7 / 9: Product Transfer 质量
// 关注: lesson 知识 → Track A artifact (代码/笔记/可被他人用的产品) 的转化清晰度.
// 区别于 Judge 6 (action conversion 判 "是否有动作"); 此判 "动作产出的东西
// 是否对他人有非平凡价值 / 是否能被 push back".
// 失败模式: useless-toy (生成无人会用), restatement (动作只是复述课程).
// 评分: 0-100, pass >= 50.

const DIM_ID = 'productTransferQuality';
const PASS_THRESHOLD = 50;

async function gradeJudge(lessonBody, context) {
  // intentional-placeholder: W1.1 scope = scaffold only per task spec.
  // W1.2 T4_JUDGE evaluates Track A artifact:
  //   (a) named + output format (code / md / diagram / table),
  //   (b) audience non-self, (c) push-back survivable (spec / assumption /
  //   kill criteria present). Wiring deferred to W1.2.
  return {
    dim: DIM_ID,
    score: 0,
    rationale: 'unimplemented (W1.1 scaffold)',
    evidence: [],
    pass: false,
  };
}

module.exports = { gradeJudge, DIM_ID, PASS_THRESHOLD };
