'use strict';

/**
 * HYPHA · Positive Feedback Engine v0 — 微反馈 only (per BLUEPRINT §8.3 + AMD-10).
 * Pure rule-based, no LLM, no IO, no async.
 * v0.5+ Cadence System will add 日/周/阶段/创造 反馈层级.
 *
 * BLUEPRINT §8.3 铁律:
 *   正反馈不是鸡汤, 是能力证据回显.
 *   - 没有证据, 不空夸.
 *   - 有进步, 具体说.
 *   - 有问题, 转化成可修复路径.
 *
 * 3 paths:
 *   PASS    — cite specific tokens hit + point to next_lesson_seed.
 *   FP_RISK — shape passed but LLM disagreement; flag for self-check (! 客服腔, ! 鸡汤).
 *   FAIL    — cite which tokens missing + repairable path.
 *
 * @param {object} args
 * @param {object} args.scoreResult - shape from scoring.js scoreMicroProof.
 * @param {object} args.plan - 6-field lesson skeleton (HOOK seed) with next_lesson_seed + micro_proof.
 * @returns {{ type: 'pass'|'fp_risk'|'fail', message: string }}
 */
function composePositiveFeedback({ scoreResult, plan } = {}) {
  if (!scoreResult || typeof scoreResult !== 'object') {
    throw new Error('scoreResult required');
  }
  if (!plan || typeof plan !== 'object' || !plan.next_lesson_seed) {
    throw new Error('plan with next_lesson_seed required');
  }

  // PASS — cite up to 3 tokens hit, anchor next lesson seed.
  if (scoreResult.passed && scoreResult.false_positive_risk !== 'high') {
    const allHits = Array.isArray(scoreResult.baseline_check && scoreResult.baseline_check.regex_hits)
      ? scoreResult.baseline_check.regex_hits
      : [];
    const hits = allHits.slice(0, 3);
    const hitsStr = hits.length ? hits.join(' / ') : '所需 pattern';
    const evidenceType = scoreResult.evidence_type || 'recall';
    return {
      type: 'pass',
      message: `命中 ${hitsStr} 等关键 token, 通过 ${evidenceType} 证据. 下一节种子: ${plan.next_lesson_seed}`,
    };
  }

  // FP_RISK — shape passed but LLM disagrees. Surface reason, ask for self-check.
  if (scoreResult.passed && scoreResult.false_positive_risk === 'high') {
    const reason = (scoreResult.llm_signal && typeof scoreResult.llm_signal.reason === 'string')
      ? scoreResult.llm_signal.reason.slice(0, 60).trim()
      : '模式判定与 baseline 分歧';
    return {
      type: 'fp_risk',
      message: `形状通过, 但模式判定有疑问: ${reason}. 自查 response 是否真在回应 stimulus, 不是 paraphrase 偏远.`,
    };
  }

  // FAIL — cite hit count + give repairable path. Per §8.3: 转化为可修复路径.
  const hits = (scoreResult.baseline_check && Array.isArray(scoreResult.baseline_check.regex_hits))
    ? scoreResult.baseline_check.regex_hits
    : [];
  const mp = (plan.micro_proof && typeof plan.micro_proof === 'object') ? plan.micro_proof : {};
  const expected = (typeof mp.expected_signal === 'string') ? mp.expected_signal : '';
  const failMode = (typeof mp.fail_mode === 'string') ? mp.fail_mode : '';
  const expectedShort = expected.slice(0, 80);
  const failModeShort = failMode.slice(0, 60);
  return {
    type: 'fail',
    message: `命中 ${hits.length} 个关键 token, 未达 pass pattern. Pass pattern: "${expectedShort}". Fail mode 提示: "${failModeShort}". 试着补上缺失的 token 后重交.`,
  };
}

module.exports = { composePositiveFeedback };
