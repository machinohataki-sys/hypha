'use strict';
// HYPHA · Wave 1.1 Lesson Quality Harness · Main Runner
// (蓝图 BLUEPRINT.md §6.4 + ROADMAP.md v0.2 验收 — 同主题生 10 次, 8/10 pass)
//
// 与 app/lib/lesson-quality-harness.js (v0.2 anti-slop pipeline) 互补 不重叠:
//   - 老 harness     = Gap / Confession / Persona / PJR / Auditable Summary
//                      (输出层 anti-slop 反 apparent-success).
//   - 本 harness W1.1 = 9-dimension lesson-body grader (输入端教学质量 + HYPHA 灵魂),
//                      跑在 N 次 regen 上做 pass-rate 统计.
//
// 9 维度:
//   1. goalCoherence          目标一致性
//   2. jargonControl          黑话控制
//   3. levelMatch             水平匹配
//   4. misconceptionDefense   误解防护
//   5. evidenceOfLearning     学习证明
//   6. actionConversion       行动转化
//   7. productTransferQuality Product Transfer 质量
//   8. notGenericCourse       是否像普通网课 (反信号)
//   9. hyphaSoul              是否有 HYPHA 灵魂 (聚合, 双倍权)
//
// pass threshold (per judge): 50 / 100.
// overall_pass: 加权 dim 平均 >= 60 AND hyphaSoul.score >= 50.
//
// W1.1 scope = scaffold + fixture mode. 真 T4_JUDGE 跑分留 W1.2.

const path = require('node:path');
const fs = require('node:fs');

// 9 judges. 顺序决定 dim 报告顺序.
// intentional-placeholder: 各 judge 内部 LLM 调用本 wave 故意不接, 见 judges/*.js 注释.
const JUDGES = [
  require('./judges/goal-coherence'),
  require('./judges/jargon-control'),
  require('./judges/level-match'),
  require('./judges/misconception-defense'),
  require('./judges/evidence-of-learning'),
  require('./judges/action-conversion'),
  require('./judges/product-transfer-quality'),
  require('./judges/not-generic-course'),
  require('./judges/hypha-soul'),
];

const OVERALL_PASS_THRESHOLD = 60;       // 加权 dim 平均
const SOUL_HARD_FLOOR = 50;              // hyphaSoul 单维硬下限

/**
 * Single-lesson grader. 跑 9 judges, 聚合 overall_pass + weakest_dim.
 *
 * @param {object} lessonBody — v0.2 11-field body (lesson-body-generator output).
 * @param {{topic:string, userProfile:string, goal:string}} context
 * @returns {Promise<{dims: object, overall_pass: boolean, overall_score: number,
 *                    weakest_dim: string, judge_results: object[]}>}
 */
async function gradeLesson(lessonBody, context) {
  if (!lessonBody || typeof lessonBody !== 'object') {
    throw new Error('gradeLesson: lessonBody (object) required');
  }
  if (!context || !context.topic || !context.goal) {
    throw new Error('gradeLesson: context.topic + context.goal required');
  }
  const ctx = Object.assign({ userProfile: '中级' }, context);

  // 并行 9 judge — 每个 judge 当前 scaffold 即时返, future T4_JUDGE 真调时
  // 这一并行天然把 9 次 LLM call 压扁到约 1 次调用 wall-clock.
  const judgeResults = await Promise.all(
    JUDGES.map(async (j) => {
      try {
        const r = await j.gradeJudge(lessonBody, ctx);
        return Object.assign({ dim: j.DIM_ID, threshold: j.PASS_THRESHOLD }, r);
      } catch (err) {
        return {
          dim: j.DIM_ID,
          threshold: j.PASS_THRESHOLD,
          score: 0,
          rationale: `judge crashed: ${err.message}`,
          evidence: [],
          pass: false,
          error: true,
        };
      }
    }),
  );

  const dims = {};
  judgeResults.forEach((r) => { dims[r.dim] = { score: r.score, pass: r.pass }; });

  // 聚合: hyphaSoul 双倍权, 其余 dim 等权.
  const soulRes = judgeResults.find((r) => r.dim === 'hyphaSoul');
  const soulW = (soulRes && soulRes.score) || 0;
  const sumOthers = judgeResults
    .filter((r) => r.dim !== 'hyphaSoul')
    .reduce((s, r) => s + (r.score || 0), 0);
  // hyphaSoul weight=2, others weight=1, count = 8 + 2 = 10.
  const weightedAvg = (sumOthers + 2 * soulW) / 10;
  const overallScore = Math.round(weightedAvg);

  const overallPass = overallScore >= OVERALL_PASS_THRESHOLD && soulW >= SOUL_HARD_FLOOR;

  // weakest_dim: 最低 score 的维 (若并列, 取出现最早的 — 与 JUDGES 顺序一致).
  let weakest = judgeResults[0];
  for (const r of judgeResults) {
    if (r.score < weakest.score) weakest = r;
  }

  return {
    dims,
    overall_score: overallScore,
    overall_pass: overallPass,
    weakest_dim: weakest.dim,
    judge_results: judgeResults,
  };
}

/**
 * Harness runner. 调 lesson generation N 次, 各 grade, 出 pass-rate 报告.
 *
 * dryRun 模式 (W1.1 default): 不真跑 generator, 拼 mock lesson body 喂 grader,
 * 用于 wire 验证 + CLI smoke. 真 generator 路径在 W1.5 stream 接.
 *
 * @param {object} args
 * @param {string} args.topic
 * @param {string} args.userProfile
 * @param {string} args.goal
 * @param {number} [args.regenCount=10]
 * @param {boolean} [args.dryRun=true] — W1.1 scaffold 默认 dry-run.
 * @param {function} [args.generator] — optional async (context, idx) => lessonBody.
 *                                       未传则 dry-run mock.
 * @returns {Promise<{pass_rate: number, samples: object[], dim_summary: object,
 *                    failing_samples: object[]}>}
 */
async function runHarness({
  topic,
  userProfile,
  goal,
  regenCount = 10,
  dryRun = true,
  generator,
} = {}) {
  if (!topic || !goal) throw new Error('runHarness: topic + goal required');
  const ctx = { topic, userProfile: userProfile || '中级', goal };
  const samples = [];

  for (let i = 0; i < regenCount; i++) {
    const lessonBody = dryRun || !generator
      ? _mockLessonBody(ctx, i)
      : await generator(ctx, i);
    // intentional-placeholder: live generator path defers to W1.5 stream.
    // Current dry-run path emits stub bodies; grader scaffolds return score=0.

    const grade = await gradeLesson(lessonBody, ctx);
    samples.push({
      idx: i,
      lesson_body_thesis: (lessonBody && lessonBody.thesis) || '(no thesis)',
      grade,
    });
    // W3.6 Companion Triggers — fire lesson_complete on pass. Best-effort,
    // never blocks harness. ctx.slug + ctx.lessonIdx are caller-supplied.
    if (grade && grade.overall_pass && ctx.slug != null && ctx.lessonIdx != null) {
      try {
        const ct = require('../companion-triggers');
        await ct.tryLessonComplete({ slug: ctx.slug, lessonIdx: ctx.lessonIdx, harnessResult: grade });
      } catch (_) { /* companion is advisory, never breaks harness */ }
    }
  }

  const passCount = samples.filter((s) => s.grade.overall_pass).length;
  const passRate = samples.length > 0 ? passCount / samples.length : 0;

  // dim_summary: 各 dim 平均分 + 通过率.
  const dimSummary = {};
  JUDGES.forEach((j) => {
    const dimScores = samples.map((s) => s.grade.dims[j.DIM_ID].score);
    const dimPasses = samples.filter((s) => s.grade.dims[j.DIM_ID].pass).length;
    dimSummary[j.DIM_ID] = {
      avg_score: _avg(dimScores),
      pass_count: dimPasses,
      pass_rate: samples.length > 0 ? dimPasses / samples.length : 0,
    };
  });

  const failingSamples = samples.filter((s) => !s.grade.overall_pass).map((s) => ({
    idx: s.idx,
    thesis: s.lesson_body_thesis,
    overall_score: s.grade.overall_score,
    weakest_dim: s.grade.weakest_dim,
  }));

  return {
    pass_rate: passRate,
    pass_count: passCount,
    total: samples.length,
    samples,
    dim_summary: dimSummary,
    failing_samples: failingSamples,
    _meta: {
      topic,
      user_profile: ctx.userProfile,
      goal,
      regen_count: regenCount,
      dry_run: dryRun,
      overall_pass_threshold: OVERALL_PASS_THRESHOLD,
      soul_hard_floor: SOUL_HARD_FLOOR,
    },
  };
}

function _avg(arr) {
  if (!arr || arr.length === 0) return 0;
  return Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);
}

// Dry-run lesson body stub — 真 lesson-body-generator output 形状的最小集.
// 字段全有, 内容空, 让 judge scaffold 可以 walk 不抛错.
function _mockLessonBody(ctx, idx) {
  return {
    thesis: `[mock #${idx}] ${ctx.topic} 的本节核心断言 — 待 W1.5 真接入 generator`,
    canonical_example: '(mock) 一个具名锚定示例',
    common_misconceptions: ['(mock) 错误先验 A', '(mock) 错误先验 B'],
    exit_proof: '(mock) Feynman 测试: apply 到一个 fresh case Y',
    mechanism_explanation: '(mock) 机制描述',
    jargon_list: [],
    note_connection: '(first lesson — no prior note to bind to)',
    examples: [],
    learn_goal: ctx.goal,
    user_profile: ctx.userProfile,
    intro_hook_scene: '(mock) 一个具体开场情景',
  };
}

// Golden / failure sample 库读取 — CI runner 用.
function loadGoldenSamples() {
  return _loadSampleDir('golden-samples');
}
function loadFailureSamples() {
  return _loadSampleDir('failure-samples');
}
function _loadSampleDir(sub) {
  const dir = path.join(__dirname, sub);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (e) {
        return { _error: e.message, _file: f };
      }
    });
}

module.exports = {
  runHarness,
  gradeLesson,
  loadGoldenSamples,
  loadFailureSamples,
  JUDGES,
  OVERALL_PASS_THRESHOLD,
  SOUL_HARD_FLOOR,
};
