'use strict';
// HYPHA · Quality Harness · Judge 6 / 9: 行动转化 (Action Conversion)
// 关注: lesson 是否驱动 user 在课后 30 分钟内做 / 写 / 试一个具体动作.
// HYPHA WHY 第一条: 学完必须 Track A 产品 or Track B 讲给真人. 单纯输入 = fail.
// 失败模式: narrative-only (读完啥也没做), abstract-takeaway (no concrete next step).
// 评分: 0-100, pass >= 50.

const DIM_ID = 'actionConversion';
const PASS_THRESHOLD = 50;

async function gradeJudge(lessonBody, context) {
  // intentional-placeholder: W1.1 scope = scaffold only per task spec.
  // W1.2 T4_JUDGE evaluates whether lesson body emits:
  //   - named product/note artifact (Track A), OR
  //   - named real-person conversation scene (Track B Feynman test),
  //   AND action completable in <= 30 min. Wiring deferred to W1.2.
  return {
    dim: DIM_ID,
    score: 0,
    rationale: 'unimplemented (W1.1 scaffold)',
    evidence: [],
    pass: false,
  };
}

module.exports = { gradeJudge, DIM_ID, PASS_THRESHOLD };
