'use strict';

/**
 * HYPHA · Assignment Function v0.3 — Phase B 改动 5 (pedagogy.md 2026-05-11 R11).
 *
 * v0.1 frozen scope (per BLUEPRINT AMD-10): computeAssignmentLevel always
 * returns Level 1 (Micro Proof). UNCHANGED — preserved verbatim.
 *
 * Phase B 改动 5 (2026-05-11, MEOW v6 PASS path): adds buildProductionScaffoldEntrypoint —
 * the homework surface that REPLACES the deprecated 3-seed design
 * (deepen_seed / expand_seed / challenge_seed). Per pedagogy.md Layer 5 M4
 * PRODUCTION SCAFFOLD: every lesson NOTE frontmatter ships an entrypoint with
 *   - intent          ∈ {考研 | 兴趣 | 论文 | 复盘}
 *   - slot_template   4 slots per intent (from SCAFFOLD_SLOTS table)
 *   - kp_slot_mapping derived from each KP's intent_use_map[intent]
 *   - prompt          intent-aware student-facing instruction
 *
 * Pure function — no LLM call. The actual LLM grading (structure adherence +
 * content depth + evidence link, 3-dim) happens later in production-scaffold.js
 * (Phase B 改动 8 new file, deferred to next batch).
 *
 * v0.5 Cadence System will compute Level 1-5 via formula
 *   Assignment Level = f(D, S, C, M, R, G, T, P)
 * per BLUEPRINT §8.2 where:
 *   D = lesson day index
 *   S = learning score
 *   C = confusion level
 *   M = phase milestone
 *   R = review node
 *   G = goal type (Exam/Growth/Hybrid)
 *   T = deadline pressure
 *   P = product/creation relevance
 *
 * Level meanings (frozen):
 *   1 = Micro Proof (60s eyeball check)
 *   2 = Small Practice (5-15 min)
 *   3 = Applied Task (30-60 min)
 *   4 = Product Spark / Integration Artifact
 *   5 = Public / Commons Output
 */

// Per pedagogy.md Layer 5 M4 (R11 user meta-abstraction 2026-05-11).
// 4 intents × 4 slots each. 考研 4th slot "提高技巧" derived from PhD applied
// exam-prep slide ("提高技巧: 补充目的 / 详述内容 / 写清后续") — MEOW v3 HIGH 2 fix.
// MUST stay in sync with E:/victor/hypha/app/lib/lesson-body-generator.js
// SCAFFOLD_SLOTS — pedagogy.md is single source of truth for the table.
const SCAFFOLD_SLOTS = {
  '考研': ['承上', '主要内容', '评价', '提高技巧'],
  '兴趣': ['钩子', 'mechanism例', '日常关系', '跨思想家对比'],
  '论文': ['上下文铺垫', 'claim+论证', '反驳+你的立场', '推进方向'],
  '复盘': ['1句核心', '3关键关系', '1反例', '比上次新明白的'],
};

const INTENTS = Object.keys(SCAFFOLD_SLOTS);
const DEFAULT_INTENT = '考研';

/**
 * Assignment level computer — v0.1 stub. Unchanged from v0.1.
 *
 * @param {object} goalContract  Goal Contract per §3.1 (8 fields). Unused in v0.1.
 * @param {object} masteryState  Mastery Map state. v0.1 = {}. v0.4+ has dimensions.
 * @param {object} currentPlan   6-field Plan from generatePlan(). Unused in v0.1.
 * @returns {number} Assignment level (always 1 in v0.1).
 */
function computeAssignmentLevel(goalContract, masteryState, currentPlan) {
  return 1;
}

/**
 * Build PRODUCTION SCAFFOLD entrypoint for one lesson, intent-aware.
 *
 * Per pedagogy.md Layer 5 M4: replaces the deprecated 3-seed homework design.
 * Output structure is stored in lesson NOTE frontmatter at deposit time
 * (lesson-note.js). UI consumes this to render Ctrl+P "PRODUCTION SCAFFOLD"
 * mode (Phase C 改动 6).
 *
 * KP-to-slot mapping reads each KP's `intent_use_map[intent]` array (set by
 * generateKPArc, lesson-body-generator.js). KPs missing the intent or slot
 * are simply omitted from kp_refs — by R11 atomicity rule a KP with NO slot
 * across ANY intent is a subtract candidate (already culled at skeleton time).
 *
 * @param {object} args
 * @param {string} args.userIntent  考研 | 兴趣 | 论文 | 复盘 (defaults to 考研)
 * @param {Array}  args.lessonKPs   knowledge_points[] from lesson body's KP arc
 *                                  array; each KP shape:
 *                                  { id, title?, intent_use_map?: { [intent]: [{slot_name, rationale}] } }
 * @returns {{ intent, slot_template, kp_slot_mapping, prompt }}
 */
function buildProductionScaffoldEntrypoint({ userIntent, lessonKPs } = {}) {
  const intent = INTENTS.includes(userIntent) ? userIntent : DEFAULT_INTENT;
  const slot_template = SCAFFOLD_SLOTS[intent].slice();

  const kps = Array.isArray(lessonKPs) ? lessonKPs : [];
  const kp_slot_mapping = slot_template.map((slot_name) => {
    const kp_refs = [];
    for (const kp of kps) {
      if (!kp || typeof kp !== 'object') continue;
      // Two possible shapes: bare arc (kp = { intent_use_map, ... }) or
      // wrapper ({ kp_id, arc: { intent_use_map, ... } }) from kp-arc.json.
      const arc = (kp.arc && typeof kp.arc === 'object') ? kp.arc : kp;
      const useMap = arc.intent_use_map || null;
      if (!useMap || !Array.isArray(useMap[intent])) continue;
      const hit = useMap[intent].find((entry) => entry && entry.slot_name === slot_name);
      if (hit) {
        kp_refs.push({
          kp_id: kp.kp_id || kp.id || arc.id || '',
          title: kp.title || arc.title || '',
          rationale: hit.rationale || '',
        });
      }
    }
    return { slot_name, kp_refs };
  });

  const prompt = _intentPrompt(intent, slot_template.length);

  return {
    intent,
    slot_template,
    kp_slot_mapping,
    prompt,
  };
}

function _intentPrompt(intent, n) {
  switch (intent) {
    case '考研':
      return `按 ${n} 个 slot 顺序 draft 你对本课时知识点的 答题. 每 slot 不超过 100 字. LLM 将评 (a) 结构 adherence (b) 内容深度 (c) evidence 是否链回具体 KP.`;
    case '兴趣':
      return `按 ${n} 个 slot 顺序写"给一个不懂这领域的朋友讲". 钩子 → 一个 mechanism 例 → 跟我日常什么有关 → 跨思想家对比. LLM 将评结构 + 深度 + KP link.`;
    case '论文':
      return `按 ${n} 个 slot 顺序写一段引用本课时概念的论文片段. 上下文铺垫 → claim+论证 → 反驳+你的立场 → 推进方向. LLM 将评结构 + 深度 + KP link.`;
    case '复盘':
      return `按 ${n} 个 slot 顺序压缩本课时. 1 句核心 → 3 关键关系 → 1 反例 → 比上次新明白的. LLM 将评结构 + 深度 + KP link.`;
    default:
      return `按 ${n} 个 slot 顺序 draft 你的产出. LLM 将评结构 adherence + 内容深度 + evidence link.`;
  }
}

/**
 * W2.2 Assignment Cadence integration — finish-ritual hook.
 *
 * When a lesson ends, compute the real Level 1-5 via cadence engine. Level 1
 * stays the PRODUCTION SCAFFOLD entrypoint (R11). Level 2-5 emit an
 * additional task spec alongside the scaffold so user gets BOTH the per-lesson
 * proof AND the upgraded output for milestones/integration/exam phases.
 *
 * Pure passthrough — no fs, no LLM. Callers (finish-ritual.js, main.js IPC)
 * write events.jsonl via writeAssignmentLevelEvent separately.
 *
 * @param {object} cadenceInputs  { D, S, C, M, R, G, T, P, currentLevel, lessonIdx, prevM }
 * @param {object} scaffoldArgs   { userIntent, lessonKPs } — passed to buildProductionScaffoldEntrypoint
 * @param {object} templateOpts   { topic, intent } — passed to selectLevelTemplate when level > 1
 * @returns {{ production_scaffold, additional_task: ?object, decision }}
 */
function buildLessonAssignment(cadenceInputs = {}, scaffoldArgs = {}, templateOpts = {}) {
  const ac = require('./assignment-cadence');
  const decision = ac.computeAssignmentLevel(cadenceInputs);
  const production_scaffold = buildProductionScaffoldEntrypoint(scaffoldArgs);
  const additional_task = decision.assignment_level > 1
    ? ac.selectLevelTemplate(decision.assignment_level, templateOpts)
    : null;
  return { production_scaffold, additional_task, decision };
}

module.exports = {
  computeAssignmentLevel,
  // Phase B 改动 5 / pedagogy.md Layer 5 M4 — PRODUCTION SCAFFOLD entrypoint
  buildProductionScaffoldEntrypoint,
  // W2.2 — combined cadence + scaffold for finish-ritual integration.
  buildLessonAssignment,
  SCAFFOLD_SLOTS,
  INTENTS,
  DEFAULT_INTENT,
};
