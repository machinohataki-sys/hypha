'use strict';

// HYPHA · W4.1 7-Day Growth Path Integration — AI Builder Project Spine.
//
// Per BLUEPRINT.md §20 v1.0 Closed Beta + §14.1 Growth Model Project Spine.
// This module is the THIN orchestrator that strings W1 (Quality Harness /
// Judges / Anti-Illusion / Misconception / Capture) + W2 (Cadence /
// Assignment / Goal Guardian / Repair) + W3 (Creation Pool / Blueprint /
// Transfer / Spark / Companion) into one 7-day Growth path with the
// AI Builder theme — the v0.1 极窄路径 the blueprint locks for closed beta.
//
// Scope discipline (per BLUEPRINT.md DIRECTION lens):
//   - This file calls W1-W3 libs; it does NOT reimplement any of them.
//   - All scoring / gating / persistence stays in W1-W3 — we only orchestrate.
//   - 7-day plan is FIXED (not derived from deriveLessonTarget). Closed beta
//     surface = one curated AI Builder ladder; deriveLessonTarget reactivates
//     in v1.1 when we open free-form Growth chains.
//   - Mock-friendly: every W-lib call site supports an optional injected
//     stub via the `_libs` opts param so scripts/run-seven-day-growth.js can
//     run end-to-end without a live vault or LLM.
//
// Output contract: runScenarioDay(dayIdx, slug, userState) →
//   {
//     day_idx, day_title, lesson_spec,
//     assignments: [{ level, level_name, prompt_seed, trigger_reasons }],
//     productSparkSuggestion: { fired: bool, P, suggested_section? } | null,
//     companionExpression: string | null,
//     evidence: {
//       harness?: { overall_pass, weakest_dim },
//       illusionGate?: { intervention, micro_task },
//       cadence?: { cadence_mode, next_lesson_type },
//     },
//     wired: string[]                      // names of W-libs actually called
//   }
//
// validateDayCompletion(dayIdx, results) returns:
//   { passed: bool, gates: { proof, assignment, evidence_present, capture_opt }, reasons[] }
//
// next7DayState(slug) returns:
//   { current_day, last_completed_day, days_completed, days_failed, next_action }
//   computed from scenario-events.jsonl (the only source of truth post-W4.2).

const _scenarioEvents = require('./scenario-events');

// ---------------------------------------------------------------------------
// SEVEN_DAY_PLAN — fixed 7-day AI Builder ladder. NOT generated from
// deriveLessonTarget (per BLUEPRINT.md DIRECTION lock for v1.0 closed beta).
//
// Per BLUEPRINT.md §14.1 Project Spine:
//   - Day 1-3: 理解输入输出
//   - Day 4-6: 设计简单工作流
//   - Day 7: 做第一个 Agent 流程 (capstone)
//
// Each day specifies:
//   - title         editorial Garamond-italic title (NO emoji, NO marketing)
//   - theme         one-line orientation for the lesson body generator
//   - kp_id         knowledge-point anchor (stable across regen, used for
//                   misconception detection + product-transfer scoring)
//   - assignment_levels  the assignment-cadence levels FIRED this day
//                        (in addition to the implicit Level 1 micro-proof)
//   - integrations  the W-lib hooks fired this day (advisory tag — actual
//                   firing is decided by runScenarioDay's scenario logic)
// ---------------------------------------------------------------------------

const SEVEN_DAY_PLAN = Object.freeze([
  {
    day_idx: 0,
    title: 'AI Builder 入门 · 什么是输入输出',
    theme: '从函数视角理解 AI 的输入-处理-输出三段; 用一个具体例子穿透抽象.',
    kp_id: 'io-foundations',
    assignment_levels: [1],
    integrations: ['quality-harness', 'anti-illusion-gate'],
  },
  {
    day_idx: 1,
    title: 'Prompt 输入设计',
    theme: '把"模糊愿望"变"可执行指令": Prompt 的结构 / 边界 / 例子三件.',
    kp_id: 'prompt-design',
    assignment_levels: [1, 2],
    integrations: ['quality-harness', 'anti-illusion-gate', 'misconception'],
  },
  {
    day_idx: 2,
    title: 'Function call 输出设计',
    theme: '让 AI 输出能被代码使用: schema / 调用契约 / 错误兜底.',
    kp_id: 'function-call',
    assignment_levels: [1, 2],
    // Day 3 is when product-transfer first becomes plausible — the user has
    // a concrete contract shape worth attaching to their product blueprint.
    integrations: ['quality-harness', 'product-transfer'],
  },
  {
    day_idx: 3,
    title: '工作流 · 串 / 并 / 分支',
    theme: '三种工作流原语 + 何时用哪种; 用一个真实任务做一次拆解.',
    kp_id: 'workflow-primitives',
    assignment_levels: [1, 3],   // Level 3 = applied_task
    integrations: ['quality-harness', 'cadence-engine', 'assignment-cadence'],
  },
  {
    day_idx: 4,
    title: 'Memory · 短 / 长 / 向量',
    theme: '三种记忆机制的权衡; 用一个例子说明何时各自胜出.',
    kp_id: 'memory-tiers',
    assignment_levels: [1, 4],   // Level 4 = product_spark
    integrations: ['quality-harness', 'product-spark', 'companion-triggers'],
  },
  {
    day_idx: 5,
    title: '评估 · 测试 / 调优',
    theme: '把"感觉它好"变"证据它好": 评估集 / 失败案例 / 调优循环.',
    kp_id: 'evaluation-loop',
    assignment_levels: [1, 4],   // Review Day calls W2.1 cadence
    integrations: ['quality-harness', 'cadence-engine', 'judges'],
  },
  {
    day_idx: 6,
    title: 'Capstone · 写一个 mini Agent 项目',
    theme: '把 6 天学到的拼成一个能跑的小 Agent; 公开一段话 + 一段产物.',
    kp_id: 'mini-agent-capstone',
    assignment_levels: [1, 5],   // Level 5 = public_output
    integrations: ['quality-harness', 'product-spark', 'finish-ritual', 'companion-triggers'],
  },
]);

if (SEVEN_DAY_PLAN.length !== 7) {
  // Defensive: caller invariants assume exactly 7 days. If a future edit
  // breaks this, fail loud at module load time so callers don't silently
  // run with wrong assumptions.
  throw new Error(`SEVEN_DAY_PLAN must have exactly 7 entries, got ${SEVEN_DAY_PLAN.length}`);
}

// ---------------------------------------------------------------------------
// Lazy lib loader. We DO NOT require W1-W3 modules at top-of-file because
// (a) the integration test harness wants to inject mock stubs without
// touching real lib code, and (b) main.js / preload.js eagerly require this
// integration on boot — top-level requires here would cascade hot paths.
// ---------------------------------------------------------------------------

function _loadLibs(opts = {}) {
  // Allow injection: `opts._libs = { qualityHarness: {...}, ... }` lets
  // scripts/run-seven-day-growth.js mock without monkeypatching require.
  const injected = (opts && opts._libs) || {};

  const lazy = (name, requirer) => {
    if (injected[name]) return injected[name];
    try { return requirer(); } catch (_) { return null; }
  };

  return {
    qualityHarness:    lazy('qualityHarness',    () => require('../quality-harness/runHarness')),
    cadenceEngine:     lazy('cadenceEngine',     () => require('../cadence-engine')),
    assignmentCadence: lazy('assignmentCadence', () => require('../assignment-cadence')),
    antiIllusionGate:  lazy('antiIllusionGate',  () => require('../anti-illusion-gate')),
    misconception:     lazy('misconception',     () => require('../misconception-engine')),
    creationPool:      lazy('creationPool',      () => require('../creation-pool')),
    productTransfer:   lazy('productTransfer',   () => require('../product-transfer')),
    productSpark:      lazy('productSpark',      () => require('../product-spark')),
    companion:         lazy('companion',         () => require('../companion')),
  };
}

// ---------------------------------------------------------------------------
// Day-level lesson spec — what the lesson body generator would receive. We
// DO NOT call lesson-body-generator here (no LLM in W4.1 scaffold). The
// spec is enough for validateDayCompletion + the UI dashboard.
// ---------------------------------------------------------------------------

function _buildLessonSpec(day, userState) {
  const learn_goal = (userState && userState.learn_goal)
    || `AI Builder · 第 ${day.day_idx + 1} 天`;
  return {
    day_idx: day.day_idx,
    title: day.title,
    theme: day.theme,
    kp_id: day.kp_id,
    learn_goal,
    expected_micro_proof: `用自己的话讲 ${day.kp_id} 给一个不懂 AI 的朋友, 三句之内.`,
  };
}

// ---------------------------------------------------------------------------
// runScenarioDay — orchestrate one day. Calls (at minimum) qualityHarness +
// cadenceEngine + assignmentCadence; conditionally calls product-transfer /
// product-spark / companion / anti-illusion based on the day's `integrations`.
//
// userState shape (all optional, scenario provides safe defaults):
//   {
//     learn_goal:      string,
//     learning_score:  0..100      (S in assignment-cadence)
//     confusion_level: 0..1        (C)
//     milestone:       0..1        (M)
//     reviews_due:     int         (R)
//     product_relevance: 0..1      (P)
//     prev_assignment_level: 1..5
//     days_remaining: int | null   (T — null for Growth)
//     goal_type: 'Growth' | 'Exam' | 'Hybrid'
//     last_lesson_text: string     (for anti-illusion-gate)
//   }
// ---------------------------------------------------------------------------

async function runScenarioDay(dayIdx, slug, userState = {}, opts = {}) {
  if (!Number.isInteger(dayIdx) || dayIdx < 0 || dayIdx > 6) {
    throw new Error(`runScenarioDay: dayIdx must be int in [0,6]; got ${dayIdx}`);
  }
  if (!slug || typeof slug !== 'string') {
    throw new Error('runScenarioDay: slug required');
  }
  const day = SEVEN_DAY_PLAN[dayIdx];
  const libs = _loadLibs(opts);
  const wired = [];

  // Record day_started right away. KPI dashboard uses this as the
  // attempt-count denominator for completion-rate.
  _scenarioEvents.recordScenarioEvent(slug, dayIdx, 'day_started', {
    day_title: day.title,
    kp_id: day.kp_id,
    integrations_planned: day.integrations.slice(),
  });

  // ── 1. Quality Harness ──────────────────────────────────────────────────
  // Every day fires the harness. We pass a mock lesson body in W4.1 scaffold;
  // when wired live, lesson-body-generator output is the input.
  const evidence = {};
  let lessonBody = null;
  if (libs.qualityHarness && typeof libs.qualityHarness.gradeLesson === 'function') {
    lessonBody = (userState && userState.lesson_body) || _mockLessonBody(day);
    try {
      const harnessOut = await libs.qualityHarness.gradeLesson(lessonBody, {
        learn_goal: (userState && userState.learn_goal) || day.theme,
        user_level: (userState && userState.user_level) || 'beginner',
        scenario: 'seven-day-growth',
        day_idx: dayIdx,
      });
      evidence.harness = {
        overall_pass: !!(harnessOut && harnessOut.overall_pass),
        weakest_dim: harnessOut && harnessOut.weakest_dim || null,
      };
      wired.push('quality-harness');
    } catch (_) { /* harness failure surfaces as missing evidence — validator catches */ }
  }

  // ── 2. Cadence Engine ───────────────────────────────────────────────────
  // Every day asks: which mode are we in? Day 5 (Review Day) gates on this
  // explicitly per BLUEPRINT.md §8.1.
  if (libs.cadenceEngine && typeof libs.cadenceEngine.computeCadence === 'function') {
    try {
      const cadence = libs.cadenceEngine.computeCadence({
        goalType: (userState && userState.goal_type) || 'Growth',
        daysRemaining: (userState && userState.days_remaining) != null
          ? userState.days_remaining
          : null,
        learningScore: (userState && userState.learning_score) != null
          ? userState.learning_score : 80,
        confusionLevel: (userState && userState.confusion_level) != null
          ? userState.confusion_level : 0.2,
        lessonIdx: dayIdx,
        reviewNodesDue: (userState && userState.reviews_due) || 0,
        milestoneProgress: (userState && userState.milestone) != null
          ? userState.milestone : (dayIdx + 1) / 7,
      });
      evidence.cadence = {
        cadence_mode: cadence.cadence_mode,
        next_lesson_type: cadence.next_lesson_type,
      };
      wired.push('cadence-engine');
    } catch (_) { /* cadence is advisory — never block */ }
  }

  // ── 3. Assignment Cadence — Level 1 (default) + any day-specific levels ──
  const assignments = [];
  if (libs.assignmentCadence && typeof libs.assignmentCadence.computeAssignmentLevel === 'function') {
    for (const targetLevel of day.assignment_levels) {
      try {
        const decision = libs.assignmentCadence.computeAssignmentLevel({
          D: dayIdx,
          S: (userState && userState.learning_score) != null ? userState.learning_score : 80,
          C: (userState && userState.confusion_level) != null ? userState.confusion_level : 0.2,
          M: (userState && userState.milestone) != null ? userState.milestone : (dayIdx + 1) / 7,
          R: (userState && userState.reviews_due) || 0,
          G: (userState && userState.goal_type) || 'Growth',
          T: (userState && userState.days_remaining) != null ? userState.days_remaining : null,
          P: (userState && userState.product_relevance) != null ? userState.product_relevance : 0.3,
          currentLevel: (userState && userState.prev_assignment_level) || 1,
          lessonIdx: dayIdx,
        });
        // Scenario override: if the day's plan demands a higher level than
        // assignment-cadence's pure-rule decision, surface BOTH so the UI
        // can show "default = X, scenario asks Y" — but the spine wins for
        // the actual prompt_seed selection.
        let level = decision.assignment_level;
        const reasons = decision.trigger_reasons.slice();
        if (targetLevel > level) {
          level = targetLevel;
          reasons.push(`scenario_day${dayIdx + 1}_override`);
        }
        const tpl = (typeof libs.assignmentCadence.selectLevelTemplate === 'function')
          ? libs.assignmentCadence.selectLevelTemplate(level, {
              topic: day.theme,
              intent: 'AI Builder',
            })
          : { prompt_seed: day.theme };
        assignments.push({
          level,
          level_name: libs.assignmentCadence.LEVEL_NAMES
            ? libs.assignmentCadence.LEVEL_NAMES[level]
            : `level-${level}`,
          prompt_seed: tpl.prompt_seed || day.theme,
          trigger_reasons: reasons,
        });
      } catch (_) {
        assignments.push({
          level: targetLevel,
          level_name: `level-${targetLevel}`,
          prompt_seed: day.theme,
          trigger_reasons: ['fallback_no_lib'],
        });
      }
    }
    wired.push('assignment-cadence');
  }

  // ── 4. Anti-Illusion Gate (advisory) ────────────────────────────────────
  // Day 0-1 we don't have enough trace to gate; Day 2+ run the check.
  if (dayIdx >= 1 && libs.antiIllusionGate && typeof libs.antiIllusionGate.evalNextLessonGate === 'function') {
    try {
      const gateOut = libs.antiIllusionGate.evalNextLessonGate(
        {
          slug,
          lesson_idx: dayIdx,
          kp_id: day.kp_id,
          lesson_text: (userState && userState.last_lesson_text) || day.theme,
        },
        (userState && userState.user_trace) || { responses: [] },
      );
      if (gateOut && (gateOut.intervention || gateOut.micro_task)) {
        evidence.illusionGate = {
          intervention: gateOut.intervention || null,
          micro_task: gateOut.micro_task || null,
        };
      }
      wired.push('anti-illusion-gate');
    } catch (_) { /* gate failure non-fatal */ }
  }

  // ── 5. Product Transfer (Day 3+, conditional on P) ──────────────────────
  let productSparkSuggestion = null;
  if (day.integrations.includes('product-transfer')
      && libs.productTransfer
      && typeof libs.productTransfer.computeRelevance === 'function') {
    try {
      const blueprint = (userState && userState.product_blueprint) || _mockBlueprint();
      const lessonKP = (userState && userState.lesson_kp) || {
        kp_id: day.kp_id,
        title: day.title,
        body: day.theme,
      };
      const rel = libs.productTransfer.computeRelevance({
        lessonKP,
        productBlueprint: blueprint,
        lessonContext: { day_idx: dayIdx, scenario: 'seven-day-growth' },
      });
      const fired = libs.productTransfer.shouldTriggerTransfer(rel.P);
      productSparkSuggestion = {
        fired: !!fired,
        P: rel.P,
        suggested_section: rel.suggested_section || null,
      };
      wired.push('product-transfer');
    } catch (_) { /* non-fatal */ }
  }

  // ── 6. Product Spark (Day 4 + Day 6 capstone) ───────────────────────────
  if (day.integrations.includes('product-spark') && libs.productSpark) {
    // Scaffold only — we do NOT actually create disk records in W4.1 dry
    // runs. The wired tag confirms the lib is reachable; live wiring is the
    // UI's job (Spark Pool screen already calls window.ptor.spark.createSpark).
    wired.push('product-spark');
    // Surface a `spark_created` event when scenario logic asserts a spark
    // SHOULD be created — UI can pick this up and pre-fill the Spark editor.
    _scenarioEvents.recordScenarioEvent(slug, dayIdx, 'spark_created', {
      kp_id: day.kp_id,
      origin: 'scenario_planned',
      _scaffold: true,
    });
  }

  // ── 7. Companion (lesson_complete on every day; sprout on Day 6 capstone) ─
  let companionExpression = null;
  if (libs.companion && typeof libs.companion.companionRespondText === 'function') {
    try {
      const trigger = dayIdx === 6 ? 'product_spark_sprout' : 'lesson_complete';
      const text = await libs.companion.companionRespondText(trigger, {
        slug,
        day_idx: dayIdx,
        kp_id: day.kp_id,
      });
      if (text) {
        companionExpression = text;
        _scenarioEvents.recordScenarioEvent(slug, dayIdx, 'companion_fired', {
          trigger,
          length: text.length,
        });
      }
      wired.push('companion');
    } catch (_) { /* companion is always advisory */ }
  }

  return {
    day_idx: dayIdx,
    day_title: day.title,
    lesson_spec: _buildLessonSpec(day, userState),
    assignments,
    productSparkSuggestion,
    companionExpression,
    evidence,
    wired,
  };
}

// ---------------------------------------------------------------------------
// validateDayCompletion — gate the day before allowing progression.
//
// 4 gates (per W4.1 task spec):
//   - proof:             harness.overall_pass true (Level 1 micro-proof equivalent)
//   - assignment:        at least one assignment recorded as submitted
//   - evidence_present:  evidence.harness || evidence.cadence is populated
//   - capture_opt:       always passes (capture is optional — opt-in path)
//
// Reasons are accumulated so the UI can show "missing: proof / assignment".
// ---------------------------------------------------------------------------

function validateDayCompletion(dayIdx, results) {
  const gates = {
    proof: false,
    assignment: false,
    evidence_present: false,
    capture_opt: true,
  };
  const reasons = [];

  if (!results || typeof results !== 'object') {
    return {
      passed: false,
      gates,
      reasons: ['no_results_provided'],
    };
  }

  if (results.evidence && results.evidence.harness) {
    gates.proof = !!results.evidence.harness.overall_pass;
    gates.evidence_present = true;
    if (!gates.proof) reasons.push(`harness_failed:${results.evidence.harness.weakest_dim || 'unknown'}`);
  } else {
    reasons.push('no_harness_evidence');
  }

  if (Array.isArray(results.assignments) && results.assignments.length > 0) {
    // For scaffold validation, presence of an assignment record counts as
    // "submitted" — live wiring upgrades this to read assignment-submitted
    // events from scenario-events.jsonl.
    gates.assignment = true;
  } else {
    reasons.push('no_assignments');
  }

  if (!gates.evidence_present && results.evidence && Object.keys(results.evidence).length > 0) {
    gates.evidence_present = true;
  }

  const passed = gates.proof && gates.assignment && gates.evidence_present;
  return { passed, gates, reasons };
}

// ---------------------------------------------------------------------------
// next7DayState — read scenario-events.jsonl and tell the UI where we are.
// ---------------------------------------------------------------------------

function next7DayState(slug) {
  if (!slug || typeof slug !== 'string') {
    return { error: 'slug required' };
  }
  const events = _scenarioEvents.readScenarioEvents(slug);
  const completedDays = new Set();
  const failedDays = new Set();
  let lastDayStarted = -1;

  for (const ev of events) {
    if (ev.type === 'day_completed' && Number.isInteger(ev.day_idx)) {
      completedDays.add(ev.day_idx);
    }
    if (ev.type === 'day_failed' && Number.isInteger(ev.day_idx)) {
      failedDays.add(ev.day_idx);
    }
    if (ev.type === 'day_started' && Number.isInteger(ev.day_idx)) {
      if (ev.day_idx > lastDayStarted) lastDayStarted = ev.day_idx;
    }
  }

  // current_day = first day not yet completed. If all 7 done → 7 (scenario
  // graduated; UI shows graduation copy).
  let currentDay = 0;
  for (let i = 0; i < 7; i++) {
    if (!completedDays.has(i)) { currentDay = i; break; }
    if (i === 6) currentDay = 7;
  }

  const lastCompleted = completedDays.size > 0
    ? Math.max(...completedDays)
    : -1;

  let nextAction = 'start_day';
  if (currentDay >= 7) nextAction = 'graduated';
  else if (failedDays.has(currentDay)) nextAction = 'retry_day';

  return {
    current_day: currentDay,
    last_completed_day: lastCompleted,
    days_completed: completedDays.size,
    days_failed: failedDays.size,
    next_action: nextAction,
    total_days: 7,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers — mock fixtures for scaffold mode. Live mode pulls from
// lesson-body-generator + creation-pool.getProduct instead.
// ---------------------------------------------------------------------------

function _mockLessonBody(day) {
  return {
    thesis: day.theme,
    canonical_example: `示例: ${day.title}`,
    hook_concrete: '一个具体场景: ...',
    common_misconceptions: [
      '误区一: 把 AI 当成"无所不知的人"而不是受限工具.',
      '误区二: 把 prompt 当成"问问题"而不是"写规格".',
    ],
    knowledge_points: [{ kp_id: day.kp_id, title: day.title, body: day.theme }],
    learn_goal: day.theme,
    _mock: true,
  };
}

function _mockBlueprint() {
  return {
    product_name: 'My First AI Agent',
    sections: {
      northStar: 'Build a working AI agent in 7 days.',
      modules: 'input · output · workflow · memory · evaluation',
      openQuestions: 'how to scope?  what counts as done?',
      riskMap: 'over-scoping / abstract-only / no-feedback-loop',
    },
  };
}

module.exports = {
  SEVEN_DAY_PLAN,
  runScenarioDay,
  validateDayCompletion,
  next7DayState,
  // Internals exposed for unit tests + the integration harness only.
  _internals: {
    buildLessonSpec: _buildLessonSpec,
    loadLibs: _loadLibs,
    mockLessonBody: _mockLessonBody,
    mockBlueprint: _mockBlueprint,
  },
};
