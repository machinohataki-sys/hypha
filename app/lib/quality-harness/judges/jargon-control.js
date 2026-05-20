'use strict';
// HYPHA · Quality Harness · Judge 2 / 9: 黑话控制 (Jargon Control)
// 关注: jargon_list 是否克制 / 每个术语是否当场有 plain-language gloss /
//       学习者水平外的术语是否未经引入直接使用.
// 失败模式: jargon-soup (堆术语不解释), encyclopedia-opener (定义堆首段).
// 评分: 0-100, pass >= 50. 与 W1.2 jargon-firewall 是 dual-track:
//   W1.1 = 整 lesson 体感判分 (LLM judge);
//   W1.2 = 单 turn 实时拦截 (algorithmic + LLM 二审).
// scaffold — 后续 W1.2 复用 jargon-firewall.checkJargon 出阵评分.

const DIM_ID = 'jargonControl';
const PASS_THRESHOLD = 50;

async function gradeJudge(lessonBody, context) {
  // intentional-placeholder: W1.1 scope = scaffold only per task spec.
  // W1.2 will integrate app/lib/jargon-firewall.checkJargon for jargon density
  // signal + T4_JUDGE prompt ("count undefined jargon, score gloss quality,
  // list violators"). Dual-track design noted above; wiring deferred.
  return {
    dim: DIM_ID,
    score: 0,
    rationale: 'unimplemented (W1.1 scaffold)',
    evidence: [],
    pass: false,
  };
}

module.exports = { gradeJudge, DIM_ID, PASS_THRESHOLD };
