'use strict';
//
// HYPHA · hypha-scout-llm — LLM-driven query plan + coverage assessment
// =====================================================================
//
// Split from hypha-scout.js to stay under the 450-LOC per-file cap. This file
// hosts ONLY the LLM-talking bits:
//   - _planQueries        (T6_STRONG, 6-dim balanced query generation)
//   - _assessCoverage     (T4_JUDGE, gap detection + refinement queries)
//
// All search execution + coverage bookkeeping stays in hypha-scout.js.
//
// API SURFACE
// -----------
// Internal — required only by hypha-scout.js. Do NOT import elsewhere.

const { executeChat } = require('../llm');

const DIMENSIONS = Object.freeze([
  'canonical',
  'frontier',
  'counterargument',
  'engineering',
  'cross-domain',
  'pedagogy',
]);

// 7th optional dimension. ONLY enabled when planQueries is called with
// mode === 'estimate'. Used by expected-years-estimator to harvest real
// human-trajectory data (career start year → achievement year) for
// frontier-grounded year estimates that don't fall back on the training-
// cutoff "Ericsson 10000 hours" default.
const CASE_TRAJECTORY_DIM = 'case-trajectory';
const ESTIMATE_DIMENSIONS = Object.freeze([...DIMENSIONS, CASE_TRAJECTORY_DIM]);

const TARGET_PER_DIM = 2;

// ──────────────────────────────────────────────────────────────────────────
// Query plan (T6_STRONG)
// ──────────────────────────────────────────────────────────────────────────

const QUERY_GEN_SYSTEM = `你是 HYPHA 信息架构师。给定学习目标 + archetype, 生成 8-12 个 diverse 搜索 query。
必须覆盖 6 维, 每维至少 1 个 query:
  1) canonical       — 经典 / 教材 / 综述
  2) frontier        — 前沿论文 / 2024-2026 paper / arxiv
  3) counterargument — 反方 / 失败案例 / 局限性 / critique
  4) engineering     — 实现 / 工程范例 / 开源仓库 / github
  5) cross-domain    — 类比 / 跨学科启发
  6) pedagogy        — 好的入门讲解 / 视频 / blog / Karpathy 级解释

每个 query:
  - 用英文 OR 中文 (随主题更可能命中的语言)
  - 长度 4-12 词, 不嵌过多 quote
  - 反映该维特征 (frontier 必带 "arxiv" / "2024" / "2025" / "2026" 之一; counterargument 必带 "critique" / "failure" / "limitation" / "反驳" 之一)

输出严格 JSON:
{
  "queries": [
    { "query": "...", "dimension": "canonical|frontier|counterargument|engineering|cross-domain|pedagogy", "why": "一句话解释这条 query 命中本维的理由" }
  ]
}`;

// Estimate-mode system prompt. Adds the 7th `case-trajectory` dimension
// targeted at REAL human-trajectory data (3-5 queries). Explicitly bans the
// training-cutoff Ericsson 1993 "10000 hours" / "deliberate practice"
// defaults so the LLM doesn't auto-fill that anchor — caller wants 2020+
// data sources (modern medians, laureate ages, longitudinal cohorts) so the
// downstream T4_JUDGE parser can extract concrete people + dates.
const QUERY_GEN_SYSTEM_ESTIMATE = `你是 HYPHA 信息架构师 (estimate 模式)。给定学习目标 + archetype, 生成 11-17 个 diverse 搜索 query。
必须覆盖 7 维, 前 6 维至少 1 query 各, 第 7 维 3-5 query:
  1) canonical       — 经典 / 教材 / 综述
  2) frontier        — 前沿论文 / 2024-2026 paper / arxiv
  3) counterargument — 反方 / 失败案例 / 局限性 / critique
  4) engineering     — 实现 / 工程范例 / 开源仓库 / github
  5) cross-domain    — 类比 / 跨学科启发
  6) pedagogy        — 好的入门讲解 / 视频 / blog / Karpathy 级解释
  7) case-trajectory — 实际达成此目标的人物 career 轨迹数据 (起步年 → 达成年 / 中位时长 / 同行队列长度)

第 7 维 case-trajectory 的 query 必须:
  - 锁定 REAL 个人 + 时间窗 (e.g. 中文/英文皆可)
  - 引用 2020+ 数据源, 现代 cohort 统计, 诺奖/同等成就的 laureate 起步年数据
  - 严禁引用 Ericsson 1993 "10000 hours" / "deliberate practice" / Anders Ericsson 框架 (该锚是 LLM training-cutoff 默认引用, 与现代实证差距大)
  - 模板示例 (替 {goal}):
      a) "List people who achieved {goal} in past 30 years with career start year and achievement year"
      b) "{goal} median time from start to recognition modern data 2024 2025"
      c) "{goal} career trajectory typical duration latest research"
      d) "{goal} 2024 2025 timeline data laureate career length"
      e) archetype-specific 名人 list query (e.g. 文学 -> "Mo Yan Murakami Ishiguro Nobel literature years before win")

每个 query:
  - 用英文 OR 中文 (随主题更可能命中的语言)
  - 长度 4-14 词
  - frontier 必带 "arxiv" / "2024" / "2025" / "2026" 之一; counterargument 必带 "critique" / "failure" / "limitation" / "反驳" 之一

输出严格 JSON:
{
  "queries": [
    { "query": "...", "dimension": "canonical|frontier|counterargument|engineering|cross-domain|pedagogy|case-trajectory", "why": "一句话解释这条 query 命中本维的理由" }
  ]
}`;

async function planQueries({ round, northStar, mainCreation, archetypeLabel, knownCoverage, knownGaps, emit, mode }) {
  const isEstimate = mode === 'estimate';
  const userMsg = composePlanUserMsg({ round, northStar, mainCreation, archetypeLabel, knownCoverage, knownGaps, isEstimate });

  const dispatch = await executeChat('T6_STRONG', {
    messages: [
      { role: 'system', content: isEstimate ? QUERY_GEN_SYSTEM_ESTIMATE : QUERY_GEN_SYSTEM },
      { role: 'user',   content: userMsg },
    ],
    json:        true,
    temperature: 0.4,
    maxTokens:   isEstimate ? 2200 : 1500,
    timeoutMs:   45_000,
  });

  const parsed  = safeParseQueryPlan(dispatch.result);
  const allowedDims = isEstimate ? ESTIMATE_DIMENSIONS : DIMENSIONS;
  const queries = enforceDimensionCoverage(parsed.queries || [], allowedDims);

  const byDimension = countByDimension(queries, allowedDims);
  if (typeof emit === 'function') emit('scout:queries-generated', { round, count: queries.length, byDimension, mode: isEstimate ? 'estimate' : 'standard' });
  return queries;
}

function composePlanUserMsg({ round, northStar, mainCreation, archetypeLabel, knownCoverage, knownGaps, isEstimate }) {
  const lines = [
    `Round: ${round}`,
    `学习目标 (North Star): ${northStar || '(unspecified)'}`,
  ];
  if (mainCreation) lines.push(`主要产出 (Main Creation): ${mainCreation}`);
  if (archetypeLabel) lines.push(`Archetype: ${archetypeLabel}`);
  if (knownGaps && knownGaps.length) {
    lines.push('');
    lines.push(`已知 coverage gap (需重点补): ${knownGaps.join(', ')}`);
  }
  if (knownCoverage) {
    lines.push('');
    lines.push(`已有 coverage: ${JSON.stringify(knownCoverage)}`);
  }
  lines.push('');
  if (isEstimate) {
    lines.push('请输出 11-17 个 diverse query (含 3-5 条 case-trajectory 维), JSON 格式如 system prompt 所示。');
    lines.push('再次强调: case-trajectory 维严禁引用 Ericsson 1993 / "10000 hours" / "deliberate practice"。');
  } else {
    lines.push('请输出 8-12 个 diverse query, JSON 格式如 system prompt 所示。');
  }
  return lines.join('\n');
}

function safeParseQueryPlan(result) {
  if (result && typeof result === 'object' && Array.isArray(result.queries)) return result;
  if (typeof result === 'string') {
    try { return JSON.parse(result); } catch (_) {}
    const m = result.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  }
  return { queries: [] };
}

function enforceDimensionCoverage(queries, allowedDims) {
  const allow = Array.isArray(allowedDims) && allowedDims.length ? allowedDims : DIMENSIONS;
  return queries
    .filter(q => q && typeof q.query === 'string' && q.query.trim())
    .map(q => ({
      query:     q.query.trim(),
      dimension: allow.includes(q.dimension) ? q.dimension : 'canonical',
      why:       typeof q.why === 'string' ? q.why : '',
    }));
}

function countByDimension(queries, allowedDims) {
  const out = emptyCoverage(allowedDims);
  for (const q of queries) {
    if (out[q.dimension] === undefined) continue;
    out[q.dimension] += 1;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Coverage assessment (T4_JUDGE)
// ──────────────────────────────────────────────────────────────────────────

const ASSESS_SYSTEM = `你是 HYPHA 信息覆盖度评审。看一批已抓到的 source (title + 短 snippet), 评估 6 维各有多少 source。
对低于 ${TARGET_PER_DIM} 个 source 的维度, 产出 3-5 条补充 query (新角度, 不重复已有 query)。

输出严格 JSON:
{
  "coverage": {
    "canonical": N, "frontier": N, "counterargument": N,
    "engineering": N, "cross-domain": N, "pedagogy": N
  },
  "gaps": ["frontier 不足", ...],
  "extra_queries": [
    { "query": "...", "dimension": "...", "why": "为何补这条" }
  ]
}

如果所有维度都 >= ${TARGET_PER_DIM}, 返回 extra_queries: [] 并且 gaps: []。`;

async function assessCoverage({ round, northStar, archetypeLabel, collected, emit }) {
  const summary = summarizeCollected(collected);
  const userMsg = [
    `Round: ${round}`,
    `学习目标: ${northStar || '(unspecified)'}`,
    archetypeLabel ? `Archetype: ${archetypeLabel}` : '',
    '',
    '已抓到的 source 摘要 (title + snippet truncated 200 char, dimension 标注):',
    summary || '(empty)',
    '',
    '请评估覆盖度, 对低于 2 source 的维度产 3-5 个补充 query。',
  ].filter(Boolean).join('\n');

  let parsed = { coverage: emptyCoverage(), gaps: [], extra_queries: [] };
  try {
    const dispatch = await executeChat('T4_JUDGE', {
      messages: [
        { role: 'system', content: ASSESS_SYSTEM },
        { role: 'user',   content: userMsg },
      ],
      json:        true,
      temperature: 0.3,
      maxTokens:   1200,
      timeoutMs:   30_000,
    });
    parsed = safeParseAssessment(dispatch.result);
  } catch (e) {
    if (typeof emit === 'function') emit('scout:assess-error', { round, message: e && e.message ? e.message : 'assess failed' });
  }

  return {
    parsedExtraQueries: enforceDimensionCoverage(parsed.extra_queries || []),
    parsedGaps:         Array.isArray(parsed.gaps) ? parsed.gaps : [],
  };
}

function safeParseAssessment(result) {
  if (result && typeof result === 'object') return result;
  if (typeof result === 'string') {
    try { return JSON.parse(result); } catch (_) {}
    const m = result.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  }
  return { coverage: emptyCoverage(), gaps: [], extra_queries: [] };
}

function summarizeCollected(collected) {
  return collected
    .slice(0, 40)
    .map(s => `- [${s.dimension}] ${String(s.title || '').slice(0, 120)} — ${(s.snippet || '').slice(0, 200)}`)
    .join('\n');
}

function emptyCoverage(allowedDims) {
  const out = {};
  const list = Array.isArray(allowedDims) && allowedDims.length ? allowedDims : DIMENSIONS;
  for (const d of list) out[d] = 0;
  return out;
}

module.exports = {
  DIMENSIONS,
  ESTIMATE_DIMENSIONS,
  CASE_TRAJECTORY_DIM,
  TARGET_PER_DIM,
  planQueries,
  assessCoverage,
  enforceDimensionCoverage,
  emptyCoverage,
};
