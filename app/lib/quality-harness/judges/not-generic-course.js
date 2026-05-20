'use strict';
// HYPHA · Quality Harness · Judge 8 / 9: 是否像普通网课
// 关注: lesson 是否带 HYPHA 反工业化教育的体感 (manuscript register / 慢推 /
//       具体场景开场 / 反 "定义→记忆→测验" 流水线) — 而非 Coursera / B 站网课的
//       泛化录播姿态.
// 信号: thesis 反 encyclopedia framing / canonical_example 有名字-年份-地点 /
//       voice 反 "great question!" / 章节结构反 1.定义 2.例子 3.测验 三段.
// 失败模式: generic-textbook (像教材摘抄), MOOC-tone (松散讲义).
// 评分: 0-100 (高 = 不像普通网课), pass >= 50.

const DIM_ID = 'notGenericCourse';
const PASS_THRESHOLD = 50;

async function gradeJudge(lessonBody, context) {
  // intentional-placeholder: W1.1 scope = scaffold only per task spec.
  // W1.2 will reuse app/lib/anti-generic-detector.js algorithmic signal +
  // T4_JUDGE manuscript-register vibe scoring; generic-tells listed as
  // evidence. Wiring deferred to W1.2.
  return {
    dim: DIM_ID,
    score: 0,
    rationale: 'unimplemented (W1.1 scaffold)',
    evidence: [],
    pass: false,
  };
}

module.exports = { gradeJudge, DIM_ID, PASS_THRESHOLD };
