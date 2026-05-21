'use strict';
// HYPHA · W1.2 Micro-Judge 2/3 · Anti-Generic-Course Detector
// ----------------------------------------------------------------------------
// 关注: lesson body 是否落入 "普通 AI 课 / 普通网课" 范式 —
//   - Wikipedia 式定义堆叠 (定义连排 + 无操作)
//   - 平均叙事 (无主线锚 / 无 thesis / 无 stake)
//   - 套话开场 / 套话结尾 (网课主持人腔)
//   - 转折词排比 (首先...其次...最后) standalone, 不带具体内容
//   - 无 HYPHA 灵魂 (无 manuscript register 拉力 / 无 Feynman test 应用)
//
// 工作流:
//   Stage 1 (algorithmic, sync) — cheap regex pre-screen
//       网课 opener / closer / 学者腔 filler / 转折词排比密度.
//       若 hit-density 超阈值 (≥ 4 distinct hits OR ≥ 2 排比+1 opener) →
//       直接 score 重罚, T4_JUDGE 可跳过.
//   Stage 2 (T4_JUDGE, async) — 语义判定 "这段像普通 AI 课吗"
//       本 wave 暂留 mock + intentional-placeholder.
//
// 输出 schema:
//   {
//     score: 0-100,                          // high = 不像普通课, low = 像
//     generic_phrases_found: string[],       // pre-screen 命中的具体短语
//     evidence: string[],                    // 1-3 短句原因
//     how_to_fix: string,                    // 具体补救建议 (1 句)
//   }
//
// 阈值: GENERIC_FAIL = 30, GENERIC_WARN = 55, PASS ≥ 55.
//
// 与 W1.1 关系: 本 judge 输出被 quality-harness/judges/not-generic-course.js
// (dim 8/9) 包装. 既有 anti-generic-detector.js 是更细的 7-axis algorithmic
// scorer (无 LLM, 直接出 generic_score + axes); 本 W1.2 judge 在其上加
// T4_JUDGE 语义层. 不重叠, 互补.

const GENERIC_FAIL = 30;
const GENERIC_WARN = 55;
const MOCK_SCORE = 50;

// 网课开场套话 — 实际 lesson 几乎不应出现.
const GENERIC_OPENERS = [
  '今天我们来讲',
  '今天我们要讲',
  '今天我们学习',
  '今天我们一起',
  '今天我们要学',
  '在本节课中',
  '本节课主要内容',
  '本节课我们',
  '让我们开始学习',
  '让我们一起来',
  '本课程将',
  '本课程主要',
  '我们来看一下',
  '我们先来看',
  '什么是',  // "什么是 X" 定义堆叠开端 (但要慎用 — 学生提问也会触发)
];

// 网课结尾套话.
const GENERIC_CLOSERS = [
  '总结一下',
  '综上所述',
  '希望大家',
  '希望同学们',
  '接下来我们',
  '请大家记住',
  '相信大家',
  '通过本节课',
  '通过本课程',
];

// 转折词排比 — standalone 出现 (无 immediate 具体内容).
// "首先 X 其次 Y 最后 Z" 是最 generic 的网课结构标志.
const TRANSITION_TRIPLE_RE = /首先[^。\n]{0,40}[，,。\n][^。\n]{0,80}其次[^。\n]{0,40}[，,。\n][^。\n]{0,80}最后/;

// 学者腔 filler (无内容寒暄).
const SCHOLAR_FILLER = [
  '众所周知',
  '毋庸置疑',
  '不可否认',
  '在某种程度上',
  '总的来说',
  '事实上',
  '经分析',
  '综合来看',
  '值得注意的是',
  '可以从多个维度',
  '在...的语境下',
];

function _bodyText(lessonBody) {
  if (!lessonBody || typeof lessonBody !== 'object') return '';
  const parts = [
    lessonBody.thesis,
    lessonBody.intro_prose,
    lessonBody.canonical_example && (lessonBody.canonical_example.text || lessonBody.canonical_example.example),
    lessonBody.mechanism_explanation,
    lessonBody.closing_prose,
    lessonBody.exit_proof && (lessonBody.exit_proof.prompt || lessonBody.exit_proof.text),
  ];
  return parts.filter((p) => typeof p === 'string').join('\n');
}

function _scanPhrases(text, phrases) {
  const low = text;
  const hits = [];
  for (const phrase of phrases) {
    const idx = low.indexOf(phrase);
    if (idx !== -1) hits.push(phrase);
  }
  return hits;
}

/**
 * Grade "generic course" smell.
 * @param {object} args
 * @param {object} args.lessonBody
 * @param {string} [args.topic]
 * @returns {Promise<{
 *   score: number,
 *   generic_phrases_found: string[],
 *   evidence: string[],
 *   how_to_fix: string,
 * }>}
 */
async function gradeGeneric({ lessonBody, topic } = {}) {
  const text = _bodyText(lessonBody);
  const evidence = [];

  const openerHits = _scanPhrases(text, GENERIC_OPENERS);
  const closerHits = _scanPhrases(text, GENERIC_CLOSERS);
  const fillerHits = _scanPhrases(text, SCHOLAR_FILLER);
  const tripleMatch = TRANSITION_TRIPLE_RE.test(text);

  const generic_phrases_found = [
    ...openerHits.map((h) => `opener:${h}`),
    ...closerHits.map((h) => `closer:${h}`),
    ...fillerHits.map((h) => `filler:${h}`),
  ];
  if (tripleMatch) generic_phrases_found.push('triple:首先...其次...最后');

  if (openerHits.length) evidence.push(`generic opener × ${openerHits.length} (e.g. "${openerHits[0]}")`);
  if (closerHits.length) evidence.push(`generic closer × ${closerHits.length} (e.g. "${closerHits[0]}")`);
  if (fillerHits.length) evidence.push(`scholar filler × ${fillerHits.length} (e.g. "${fillerHits[0]}")`);
  if (tripleMatch) evidence.push('full 首先/其次/最后 triple — standalone transition排比');

  // Stage 2 — T4_JUDGE semantic "is this普通网课" judgment.
  // intentional-placeholder: W1.2 ship = scaffold per task spec. Real prompt
  // requires golden+failure samples (W1.4 calibration wave) to lock pass-rate.
  // TODO real T4_JUDGE prompt — compose:
  //   system = HYPHA SHORT constitution
  //   user   = `topic: ${topic}\nlesson body:\n${text}\n\n` +
  //            `Score 0-100 how *unlike* 普通 AI 课/普通网课 this reads. ` +
  //            `Look for: Wikipedia定义堆叠 / 无主线 / 平均叙事 / 套话. ` +
  //            `Return JSON {score, evidence[], how_to_fix}.`
  // executeChat('T4_JUDGE', { messages, json: true, temperature: 0 })
  let semanticScore = MOCK_SCORE;
  let how_to_fix = '在 thesis 加一个明确的"为什么此节服务 goal"锚句, 删掉 opener/closer 套话.';

  // Composite: cheap regex hits drop score.
  //   each opener: -8, each closer: -8, each filler: -5, triple match: -20.
  let score = semanticScore;
  score -= openerHits.length * 8;
  score -= closerHits.length * 8;
  score -= fillerHits.length * 5;
  if (tripleMatch) score -= 20;
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Density gate — if ≥ 4 distinct generic hits, force into FAIL band.
  const totalDistinct = openerHits.length + closerHits.length + fillerHits.length + (tripleMatch ? 1 : 0);
  if (totalDistinct >= 4 && score > GENERIC_FAIL) {
    score = Math.min(score, GENERIC_FAIL - 5);
  }

  return {
    score,
    generic_phrases_found,
    evidence: evidence.slice(0, 6),
    how_to_fix,
  };
}

module.exports = {
  gradeGeneric,
  GENERIC_FAIL,
  GENERIC_WARN,
  // Exported for unit-test reach-through.
  _internals: { GENERIC_OPENERS, GENERIC_CLOSERS, SCHOLAR_FILLER, TRANSITION_TRIPLE_RE },
};
