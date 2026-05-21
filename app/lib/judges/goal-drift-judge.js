'use strict';
// HYPHA · W1.2 Micro-Judge 1/3 · Goal Drift Detector
// ----------------------------------------------------------------------------
// 关注: lesson body 是否 visibly 服务 goalContract.core_competencies, 与
//       goalContract.forbidden_drifts 不冲突, 且与最近 3 节 prev lessons 不重复
//       绕同一相邻概念打转 (cross-lesson drift).
//
// 工作流:
//   Stage 1 (algorithmic, cheap, sync) — forbidden_drift substring scan
//       核心 fail-fast 信号: 若 lessonBody 出现 goalContract.forbidden_drifts
//       中任一短语, 直接 score 重罚.
//   Stage 2 (T4_JUDGE, async, TODO) — 主线 vs 目标对齐评分
//       把 thesis + canonical_example + mechanism_explanation 与
//       core_competencies + main_creation 比对, T4_JUDGE 出 drift_score.
//       本 wave 暂留 TODO + mock 固定值 50.
//   Stage 3 (algorithmic, cross-lesson) — vs prev_lessons[0..2] 的 Jaccard
//       近 3 节若 thesis token-set 与 lessonBody 重合 ≥ 0.7 → cross-lesson
//       drift signal. 表示 lesson chain 卡在同一概念循环.
//
// 输出 schema (binding — W1.1 wraps via goal-coherence.js dim):
//   {
//     score: 0-100,                   // high = drift-free, low = drifted
//     drift_direction: string|null,   // e.g. "trended toward adjacent concept X"
//     evidence: string[],             // 1-3 短句证据
//     drifted_passages: [{ offset, snippet }]  // 偏移命中位置, 用于 UI 高亮
//   }
//
// 阈值 (W1.2 ship — tunable via calibration in W1.4+):
//   DRIFT_FAIL: < 35  — body 几乎完全偏离 goal, 必须 regen
//   DRIFT_WARN: 35-60 — partial drift, 提示用户审 + 允许 lesson continue
//   PASS:       ≥ 60  — drift acceptable
//
// 与 W1.1 关系: 本 judge 输出被 quality-harness/judges/goal-coherence.js
// (dim 1/9) 包装, runHarness 取 score 直接作 goalCoherence dim score.

const DRIFT_FAIL = 35;
const DRIFT_WARN = 60;

// Mock score chosen midway between FAIL+WARN so dev UI never reads PASS/FAIL
// before real T4_JUDGE wiring lands — keeps yellow badge visible during scaffold.
const MOCK_SCORE = 50;

function _tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/([一-鿿㐀-䶿])/g, ' $1 ')
    .split(/[\s\p{P}\p{S}]+/u)
    .filter(Boolean);
}

function _bodyText(lessonBody) {
  if (!lessonBody || typeof lessonBody !== 'object') return '';
  const parts = [
    lessonBody.thesis,
    lessonBody.canonical_example && (lessonBody.canonical_example.text || lessonBody.canonical_example.example),
    lessonBody.mechanism_explanation,
    lessonBody.exit_proof && (lessonBody.exit_proof.prompt || lessonBody.exit_proof.text),
  ];
  return parts.filter((p) => typeof p === 'string').join('\n');
}

function _scanForbiddenDrifts(text, forbiddenList) {
  if (!Array.isArray(forbiddenList) || forbiddenList.length === 0) return [];
  const hits = [];
  const low = text.toLowerCase();
  for (const phrase of forbiddenList) {
    const needle = String(phrase || '').toLowerCase().trim();
    if (!needle) continue;
    let from = 0;
    while (true) {
      const idx = low.indexOf(needle, from);
      if (idx === -1) break;
      hits.push({
        offset: idx,
        snippet: text.slice(Math.max(0, idx - 24), Math.min(text.length, idx + needle.length + 24)),
        phrase: needle,
      });
      from = idx + needle.length;
    }
  }
  return hits;
}

function _crossLessonOverlap(currentTokens, prevLessons) {
  if (!Array.isArray(prevLessons) || prevLessons.length === 0) return null;
  const recent = prevLessons.slice(-3); // most-recent 3
  const cur = new Set(currentTokens);
  let worstOverlap = 0;
  let worstIdx = -1;
  for (let i = 0; i < recent.length; i++) {
    const prev = recent[i];
    const prevText = _bodyText(prev) || (prev && prev.thesis) || '';
    const prevSet = new Set(_tokens(prevText));
    if (prevSet.size === 0) continue;
    let inter = 0;
    for (const t of cur) if (prevSet.has(t)) inter++;
    const union = cur.size + prevSet.size - inter;
    const j = union === 0 ? 0 : inter / union;
    if (j > worstOverlap) { worstOverlap = j; worstIdx = i; }
  }
  return { worstOverlap, worstIdx };
}

/**
 * Grade goal-drift on a single lesson body against contract + history.
 * @param {object} args
 * @param {object} args.lessonBody — 11-field v0.2 body
 * @param {object} args.goalContract — { core_competencies[], forbidden_drifts[], main_creation, north_star_goal }
 * @param {Array<object>} [args.prevLessons] — most recent 3 lesson bodies (newest last)
 * @returns {Promise<{
 *   score: number,
 *   drift_direction: string|null,
 *   evidence: string[],
 *   drifted_passages: Array<{ offset: number, snippet: string }>
 * }>}
 */
async function gradeDrift({ lessonBody, goalContract, prevLessons } = {}) {
  const text = _bodyText(lessonBody);
  const goal = goalContract || {};
  const evidence = [];
  const drifted_passages = [];

  // Stage 1 — forbidden_drifts substring scan (cheap, deterministic).
  const forbiddenHits = _scanForbiddenDrifts(text, goal.forbidden_drifts || []);
  for (const h of forbiddenHits.slice(0, 8)) {
    drifted_passages.push({ offset: h.offset, snippet: h.snippet });
    evidence.push(`forbidden_drift "${h.phrase}" appears at offset ${h.offset}`);
  }

  // Stage 3 — cross-lesson Jaccard against prev 3 (cheap, deterministic).
  const currentTokens = _tokens(text);
  const overlapReport = _crossLessonOverlap(currentTokens, prevLessons);
  if (overlapReport && overlapReport.worstOverlap >= 0.7) {
    evidence.push(
      `near-duplicate of prev lesson at index ${overlapReport.worstIdx} ` +
      `(jaccard=${overlapReport.worstOverlap.toFixed(2)})`
    );
  }

  // Stage 2 — T4_JUDGE semantic alignment (LLM-judged drift_direction + score).
  // intentional-placeholder: W1.2 ship = scaffold + interface-contract per task
  // spec ("LLM 调用部分留 TODO mock"). Real T4_JUDGE wiring + prompt calibration
  // belongs to W1.4 calibration wave, where pass-rate against 8/10 golden +
  // failure samples decides the prompt template + parser shape.
  // TODO real T4_JUDGE prompt — should compose:
  //   system = HYPHA SHORT constitution + "你是 Hypha 课程目标对齐审计员"
  //   user   = `core_competencies: ${JSON.stringify(goal.core_competencies)}\n` +
  //            `main_creation: ${goal.main_creation}\n` +
  //            `lesson thesis: ${lessonBody.thesis}\n` +
  //            `canonical_example: ${...}\n` +
  //            `mechanism_explanation: ${...}\n` +
  //            `Return JSON: {score:0-100, drift_direction:string|null, ` +
  //            `              evidence:string[]}`
  // executeChat('T4_JUDGE', { messages: [...], json: true, temperature: 0 })
  // const llmResult = await executeChat('T4_JUDGE', { ... });
  // Scaffold: mock fixed value, no network.
  let semanticScore = MOCK_SCORE;
  const driftDirection = null;

  // Composite: stage 1 hits drop score linearly (each forbidden hit -15, floor 0).
  // Cross-lesson overlap ≥ 0.7 drops score by 20.
  let score = semanticScore;
  score -= forbiddenHits.length * 15;
  if (overlapReport && overlapReport.worstOverlap >= 0.7) score -= 20;
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    drift_direction: driftDirection,
    evidence: evidence.slice(0, 6),
    drifted_passages: drifted_passages.slice(0, 8),
  };
}

module.exports = {
  gradeDrift,
  DRIFT_FAIL,
  DRIFT_WARN,
};
