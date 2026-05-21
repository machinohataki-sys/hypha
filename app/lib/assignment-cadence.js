'use strict';

/**
 * HYPHA · Wave 2.2 — Assignment Cadence Function.
 *
 * Implements BLUEPRINT §8.2 Assignment Cadence:
 *   Assignment Level = f(D, S, C, M, R, G, T, P)
 *
 * Inputs (8):
 *   D — current day idx (lesson day, 0-indexed)
 *   S — learning score, last 3 lessons avg, 0-100
 *   C — confusion level, 0-1
 *   M — milestone progress, 0-1
 *   R — review nodes due
 *   G — goal type (Exam | Growth | Hybrid)
 *   T — days to deadline (or null)
 *   P — current Product Pool relevance, 0-1 (W3 wires real; v0.5 mock 0.5)
 *   currentLevel — last-emitted level (for milestone escalation)
 *
 * Output:
 *   {
 *     assignment_level: 1-5,
 *     level_name: 'micro_proof'|'small_practice'|'applied_task'|'product_spark'|'public_output',
 *     prompt_seed: string,
 *     trigger_reasons: string[]
 *   }
 *
 * Pure function — no LLM, no fs. events.jsonl write is a separate side-effect
 * call (writeAssignmentLevelEvent) so the engine stays testable.
 *
 * Principle (蓝图):
 *   - 每课有证明 (Level 1), 不每课重输出
 *   - 低分先修复, 不加压
 *   - 高分也不随便重压, 只阶段节点升级
 *   - Product Transfer 只在 P > 阈值 时触发 Level 4 (不强迁移)
 */

const LEVEL_NAMES = Object.freeze({
  1: 'micro_proof',
  2: 'small_practice',
  3: 'applied_task',
  4: 'product_spark',
  5: 'public_output',
});

const LEVEL_TIMEOUTS_MIN = Object.freeze({
  1: 0.5,   // 30 seconds
  2: 10,
  3: 30,
  4: 90,    // 1-2 hours
  5: 240,   // multiple hours
});

const LEVEL_EXPECTED_FORMAT = Object.freeze({
  1: 'text-one-line',
  2: 'text-bullets-3',
  3: 'paragraph-200ch',
  4: 'product-spark-300ch',
  5: 'longform-600ch',
});

// Tunables — frozen for v0.5; tune via blueprint amendment.
const LOW_SCORE_THRESHOLD = 40;
const HIGH_CONFUSION_THRESHOLD = 0.7;
const REVIEW_DUE_THRESHOLD = 3;
const EXAM_FINAL_DAYS = 1;
const EXAM_COMPRESS_DAYS = 7;
const PRODUCT_RELEVANCE_THRESHOLD = 0.6;
const PRODUCT_MIN_LESSON_IDX = 5;
const WEEKLY_INTEGRATION_PERIOD = 7;   // days
const MONTHLY_PUBLIC_PERIOD = 21;       // days
const MILESTONE_CHECKPOINTS = Object.freeze([0.25, 0.5, 0.75]);

const VALID_GOAL_TYPES = new Set(['Exam', 'Growth', 'Hybrid']);

function _clampLevel(n) {
  if (!Number.isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > 5) return 5;
  return Math.round(n);
}

function _crossedCheckpoint(M, prevM) {
  if (!Number.isFinite(M)) return false;
  const prev = Number.isFinite(prevM) ? prevM : 0;
  for (const cp of MILESTONE_CHECKPOINTS) {
    if (prev < cp && M >= cp) return true;
  }
  return false;
}

/**
 * Decision engine — pure, no side effects.
 *
 * Priority order (first match wins for Level decision, but multiple
 * trigger_reasons can stack for visibility).
 */
function computeAssignmentLevel(args = {}) {
  const {
    D = 0,
    S = 100,
    C = 0,
    M = 0,
    R = 0,
    G = 'Growth',
    T = null,
    P = 0.5,
    currentLevel = 1,
    prevM = null,
    lessonIdx = null,
  } = args || {};

  const goal = VALID_GOAL_TYPES.has(G) ? G : 'Growth';
  const day = Number.isFinite(D) ? Math.max(0, Math.floor(D)) : 0;
  const lesson = Number.isFinite(lessonIdx) ? Math.max(0, Math.floor(lessonIdx)) : day;
  const score = Number.isFinite(S) ? S : 100;
  const confusion = Number.isFinite(C) ? Math.min(1, Math.max(0, C)) : 0;
  const milestone = Number.isFinite(M) ? Math.min(1, Math.max(0, M)) : 0;
  const reviews = Number.isFinite(R) ? Math.max(0, Math.floor(R)) : 0;
  const deadline = Number.isFinite(T) ? T : null;
  const productRel = Number.isFinite(P) ? Math.min(1, Math.max(0, P)) : 0.5;
  const cur = _clampLevel(currentLevel);

  const reasons = [];
  let level = null;

  // Rule 1: low score / high confusion → Level 1 recovery. Hard floor.
  if (score < LOW_SCORE_THRESHOLD || confusion > HIGH_CONFUSION_THRESHOLD) {
    level = 1;
    reasons.push('low_score_recovery');
  }

  // Rule 3: exam final-day compression → Level 1 (precedes Rule 2 R-stack).
  if (level === null && goal === 'Exam' && deadline !== null && deadline <= EXAM_FINAL_DAYS) {
    level = 1;
    reasons.push('exam_final');
  }

  // Rule 2: review backlog ≥ threshold → Level 2 (review-focused practice).
  if (level === null && reviews >= REVIEW_DUE_THRESHOLD) {
    level = 2;
    reasons.push('review_due');
  }

  // Rule 4: exam compression window → Level 3 mock test.
  if (level === null && goal === 'Exam' && deadline !== null && deadline <= EXAM_COMPRESS_DAYS) {
    level = 3;
    reasons.push('exam_compress');
  }

  // Rule 8: monthly public output (3-week cycle).
  if (level === null && day > 0 && day % MONTHLY_PUBLIC_PERIOD === 0) {
    level = 5;
    reasons.push('monthly_public');
  }

  // Rule 7: weekly integration for Growth goal.
  if (level === null && day > 0 && day % WEEKLY_INTEGRATION_PERIOD === 0 && goal === 'Growth') {
    level = 4;
    reasons.push('weekly_integration');
  }

  // Rule 6: high product-pool relevance → Level 4 product spark.
  if (level === null && productRel > PRODUCT_RELEVANCE_THRESHOLD && lesson >= PRODUCT_MIN_LESSON_IDX) {
    level = 4;
    reasons.push('high_relevance');
  }

  // Rule 5: milestone checkpoint crossed → escalate currentLevel + 1 (cap 5).
  // Evaluated AFTER higher-priority rules so it doesn't override exam/review
  // floors but DOES bubble up during normal flow.
  if (level === null && _crossedCheckpoint(milestone, prevM)) {
    level = _clampLevel(cur + 1);
    reasons.push('milestone_crossed');
  } else if (level === null && Number.isFinite(milestone) && prevM == null) {
    // Bootstrap path: prevM unknown (first call) — treat milestone alone as
    // checkpoint trigger when at exactly 0.25/0.5/0.75 ± epsilon. Lets the
    // caller drive level-ups without state plumbing in v0.5.
    for (const cp of MILESTONE_CHECKPOINTS) {
      if (Math.abs(milestone - cp) < 0.001) {
        level = _clampLevel(cur + 1);
        reasons.push('milestone_crossed');
        break;
      }
    }
  }

  // Default: Level 1 micro proof every lesson.
  if (level === null) {
    level = 1;
    reasons.push('default_micro_proof');
  }

  return {
    assignment_level: level,
    level_name: LEVEL_NAMES[level],
    trigger_reasons: reasons,
  };
}

// =====================================================================
// Level templates — prompt_seed + expected_format + timeout_min per level.
// =====================================================================

function _tpl(level, { topic = '', intent = '考研' } = {}) {
  const t = (topic && String(topic).trim()) || '本课主题';
  const intentLabel = intent || '考研';
  switch (level) {
    case 1:
      return {
        prompt_seed: `用一句话, 用你自己的话, 解释 ${t} 的核心. 不引用课文原句, 不抄定义.`,
        expected_format: LEVEL_EXPECTED_FORMAT[1],
        timeout_min: LEVEL_TIMEOUTS_MIN[1],
      };
    case 2:
      return {
        prompt_seed: `针对 ${t}, 举 3 个与课程例子不同的例子, 每个 1 句话, 不重复机制类型.`,
        expected_format: LEVEL_EXPECTED_FORMAT[2],
        timeout_min: LEVEL_TIMEOUTS_MIN[2],
      };
    case 3:
      return {
        prompt_seed: `把 ${t} 应用到你认识的某个具体场景 (工作/生活/项目), 写 200 字. 含: 场景描述 / 机制如何作用 / 你的预测.`,
        expected_format: LEVEL_EXPECTED_FORMAT[3],
        timeout_min: LEVEL_TIMEOUTS_MIN[3],
      };
    case 4:
      return {
        prompt_seed: `结合本课 ${t} 与你的 Product Pool, 写 1 个 Product Spark 候选 (~300 字): 机制 / 它解决谁的什么 / 最大风险 / 下一步可验证动作.`,
        expected_format: LEVEL_EXPECTED_FORMAT[4],
        timeout_min: LEVEL_TIMEOUTS_MIN[4],
      };
    case 5:
      return {
        prompt_seed: `把 ${t} 写成 ≥ 600 字博客或 Commons Pack 草稿: 钩子 / 主张 / 论证 / 反方 / 行动. 准备 Track B 发布. 写作 register = manuscript italic, ! 营销话术.`,
        expected_format: LEVEL_EXPECTED_FORMAT[5],
        timeout_min: LEVEL_TIMEOUTS_MIN[5],
      };
    default:
      return _tpl(1, { topic: t, intent: intentLabel });
  }
}

function selectLevelTemplate(level, opts = {}) {
  const lv = _clampLevel(level);
  const tpl = _tpl(lv, opts);
  return {
    assignment_level: lv,
    level_name: LEVEL_NAMES[lv],
    ...tpl,
  };
}

// =====================================================================
// Grading — Level 1 deferred to W3 grader (mock); Level 2-5 mock grader.
// Level >= 2 with intent + slot template + draft → defer to production-scaffold
// (Phase C ship) via dependency-inject so this module stays loadable in tests
// without the real LLM stack.
// =====================================================================

async function gradeAssignment({ level, draft, context = {}, gradeDraftFn = null } = {}) {
  const lv = _clampLevel(level);
  const cleanDraft = String(draft || '').trim();
  if (!cleanDraft) {
    return {
      ok: false,
      level: lv,
      reason: 'empty_draft',
      score: 0,
      feedback: '草稿为空, 至少写 1 句你自己的话.',
    };
  }

  // Level 1 micro proof — single-line eyeball check; mock grader for v0.5.
  if (lv === 1) {
    const length = cleanDraft.length;
    const score = length < 6 ? 30 : length < 20 ? 60 : 85;
    return {
      ok: true,
      level: lv,
      score,
      feedback: length < 20
        ? '太短. 再多 1 句, 写出"为什么是这个, 不是别的".'
        : '通过. 已记录到 events.jsonl.',
      structure: { length },
    };
  }

  // Level 4/5 product / public — defer to production-scaffold gradeDraft if
  // caller supplies. Wave 2.2 ships the routing skeleton; W3.x wires real LLM.
  if ((lv === 4 || lv === 5) && typeof gradeDraftFn === 'function') {
    try {
      const result = await gradeDraftFn({
        intent: context.intent || '考研',
        slotTemplate: context.slotTemplate || [],
        kpSlotMapping: context.kpSlotMapping || [],
        studentDraft: cleanDraft,
        lessonKPs: context.lessonKPs || [],
        lang: context.lang || 'zh',
        promptsDir: context.promptsDir,
      });
      return {
        ok: true,
        level: lv,
        score: result && result.scores
          ? Math.round(((result.scores.structure_adherence || 0)
                     + (result.scores.content_depth || 0)
                     + (result.scores.evidence_link || 0)) / 3)
          : 50,
        feedback: (result && result.feedback) || '已评分.',
        scores: (result && result.scores) || null,
      };
    } catch (err) {
      return {
        ok: false,
        level: lv,
        reason: 'grader_error',
        error: err && err.message ? err.message : String(err),
        score: 50,
        feedback: '评分失败. 草稿已存, 稍后重试.',
      };
    }
  }

  // Level 2/3 (and 4/5 without LLM injected) — mock heuristic grader.
  const charCount = cleanDraft.length;
  const targetMin = lv === 2 ? 60 : lv === 3 ? 180 : lv === 4 ? 250 : 500;
  const score = charCount >= targetMin ? 80 : Math.round(60 * charCount / targetMin);
  return {
    ok: true,
    level: lv,
    score,
    feedback: charCount < targetMin
      ? `字数 ${charCount}/${targetMin}. 再扩展.`
      : `已记录. 字数 ${charCount}. W3.x 将接入 3-dim LLM 评分.`,
    structure: { length: charCount, target: targetMin },
  };
}

// =====================================================================
// Event log — append to vault/<slug>/events.jsonl via app/lib/events.js.
// Side-effect helper kept OUT of pure computeAssignmentLevel for testability.
// =====================================================================

function writeAssignmentLevelEvent(slug, decision, inputs, prevLevel = null) {
  if (!slug) return { ok: false, reason: 'slug_required' };
  let events;
  try {
    events = require('./events');
  } catch (err) {
    return { ok: false, reason: 'events_module_unavailable', error: err.message };
  }
  const row = {
    type: 'assignment:level-decided',
    level: decision.assignment_level,
    level_name: decision.level_name,
    trigger_reasons: decision.trigger_reasons,
    D: inputs.D ?? null,
    S: inputs.S ?? null,
    C: inputs.C ?? null,
    M: inputs.M ?? null,
    R: inputs.R ?? null,
    G: inputs.G ?? null,
    T: inputs.T ?? null,
    P: inputs.P ?? null,
    currentLevel: inputs.currentLevel ?? null,
  };
  const result = events.write(slug, row);
  if (prevLevel !== null && Number.isFinite(prevLevel) && prevLevel !== decision.assignment_level) {
    events.write(slug, {
      type: 'assignment:level-up',
      from: prevLevel,
      to: decision.assignment_level,
      reason: (decision.trigger_reasons && decision.trigger_reasons[0]) || 'unknown',
    });
  }
  return result;
}

module.exports = {
  computeAssignmentLevel,
  selectLevelTemplate,
  gradeAssignment,
  writeAssignmentLevelEvent,
  LEVEL_NAMES,
  LEVEL_TIMEOUTS_MIN,
  LEVEL_EXPECTED_FORMAT,
  // tunables exposed for spec doc + tests
  LOW_SCORE_THRESHOLD,
  HIGH_CONFUSION_THRESHOLD,
  REVIEW_DUE_THRESHOLD,
  EXAM_FINAL_DAYS,
  EXAM_COMPRESS_DAYS,
  PRODUCT_RELEVANCE_THRESHOLD,
  WEEKLY_INTEGRATION_PERIOD,
  MONTHLY_PUBLIC_PERIOD,
  MILESTONE_CHECKPOINTS,
};
