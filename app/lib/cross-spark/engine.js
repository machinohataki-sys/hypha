'use strict';

// HYPHA · W7.4 Cross-Spark Engine — 6-step跨学科 spark generator.
//
// Per BLUEPRINT.md §14.2:
//   "文科给眼界, 理科给深度, 工程给落地, AI 给放大。
//    流程: 当前问题 → 理科机制 → 文科视角 → 思维工具 → 新 Spark →
//          现实约束 → 行动/作品"
//
// Public surface:
//   generateCrossSpark({ currentProblem, currentDomain, slug })
//     → Promise<CrossSpark>
//   loadHistory(slug)         → Promise<CrossSpark[]>
//
// CrossSpark schema:
//   {
//     id, ts, slug,
//     source_problem,
//     source_domain,
//     other_domain_lenses: [{ domain, lens }],
//     thinking_tool_id,
//     thinking_tool: { id, name_cn, name_en, key_question },
//     new_spark,
//     constraints: [{ kind, note }],
//     action_or_artifact: { kind, summary },
//   }
//
// T6_STRONG mock note: BLUEPRINT §17.2.1 places the cross-spark generator in
// the T6_STRONG capability class. We expose an internal `_callT6` hook that
// can be replaced with `require('../llm').executeChat('T6_STRONG', ...)` once
// the LLM wave activates this surface; for now `_callT6` returns a curated
// deterministic mock so the rest of the W7.4 stream (UI / IPC / tests) can
// be developed independently.
//
// Boundary partners:
//   - W7.4 thinking-tools.js   — Step 3 picks a tool via recommendTool/getTool
//   - W3.4 product-spark.js    — auto-product-spark.js bridges Step 6 → spark CRUD
//   - W5.1 cheap-router         — soft-imported for domain detection (Step 1)
//   - W3.6 Companion            — file-as-substrate via cross-sparks.jsonl

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ThinkingTools = require('./thinking-tools');

// Soft requires — modules that may not exist in lean dev/test installs.
let _cheapRouter = null;
try { _cheapRouter = require('../cheap-router'); } catch (_) { _cheapRouter = null; }
let _events = null;
try { _events = require('../events'); } catch (_) { _events = null; }

// ----------------------------------------------------------------------
// Domain ontology — 4 axes per BLUEPRINT §14.2.
// ----------------------------------------------------------------------

const DOMAINS = Object.freeze(['literature', 'science', 'engineering', 'ai']);

// CN aliases users may type. Map fully to canonical id.
const _DOMAIN_ALIAS = Object.freeze({
  literature:    'literature',
  literary:      'literature',
  arts:          'literature',
  humanities:    'literature',
  philosophy:    'literature',
  文学:           'literature',
  人文:           'literature',
  哲学:           'literature',
  science:       'science',
  scientific:    'science',
  physics:       'science',
  biology:       'science',
  mathematics:   'science',
  理科:           'science',
  科学:           'science',
  engineering:   'engineering',
  product:       'engineering',
  design:        'engineering',
  workflow:      'engineering',
  工程:           'engineering',
  产品:           'engineering',
  ai:            'ai',
  llm:           'ai',
  agent:         'ai',
  ml:            'ai',
});

function _normalizeDomain(d) {
  if (!d || typeof d !== 'string') return null;
  const key = d.trim().toLowerCase();
  return _DOMAIN_ALIAS[key] || null;
}

// ----------------------------------------------------------------------
// Domain lens templates — Step 2 maps current problem onto the other 3
// domains. Each lens is a single rhetorical question that pulls the
// problem into that domain's native vocabulary. Hand-curated.
// ----------------------------------------------------------------------

const _LENS_TEMPLATES = Object.freeze({
  literature: [
    '如果这是一个故事，主角是谁？他在追求什么，又在害怕什么？',
    '从神话/经典文本里有没有结构相似的情节？它的解法是什么？',
    '叙事视角换成被忽略的那个人，问题的核心会变成什么？',
  ],
  science: [
    '这背后是否在违反或试探某条物理/经济/认知的不变量？',
    '把它当作一个 measurable phenomenon — 自变量、因变量、控制变量分别是什么？',
    '如果同样的现象在另一个 scale（10× / 1/10×）出现，规律会变吗？',
  ],
  engineering: [
    '在 6 周内能落地的最小版本是什么？什么是 happy path 上的第一行代码？',
    '失败时谁会先发现？容错与回滚机制在哪？',
    'cheapest reversible bet 是什么？',
  ],
  ai: [
    '哪一段可以由模型承担，哪一段必须由人承担（judgement / 责任 / context 长度）？',
    '如果有一个 agent 在背后 24/7 监视这个问题，它会主动报告什么？',
    '能不能用 small-model + tight context 替代 big-model + sloppy context？',
  ],
});

function _generateLenses(sourceDomain) {
  const others = DOMAINS.filter((d) => d !== sourceDomain);
  const lenses = others.map((d) => {
    const pool = _LENS_TEMPLATES[d];
    // Deterministic pick — first lens of pool — until T6_STRONG wires in.
    // Once LLM lands, we can pick per-problem; deterministic keeps tests
    // stable for now.
    return { domain: d, lens: pool[0] };
  });
  return lenses;
}

// ----------------------------------------------------------------------
// Constraint generation — Step 5. Hand-curated buckets per BLUEPRINT
// §14.2 ("现实约束"): time / cost / capability / dependency / honesty.
// We surface 3 — enough to ground the spark, not so many it becomes a
// risk register.
// ----------------------------------------------------------------------

function _generateConstraints(problem, sourceDomain) {
  const out = [];
  const lower = (problem || '').toLowerCase();

  // Time/cost: nearly always relevant.
  out.push({
    kind: 'time_cost',
    note: '6 周内能不能 ship 第一个可被 1 个真实用户 push back 的版本？',
  });

  // Capability — engineering / ai surface concrete capability questions.
  if (sourceDomain === 'engineering' || sourceDomain === 'ai') {
    out.push({
      kind: 'capability',
      note: '当前 stack 是否已有这一步需要的 primitive？没有的话，是 buy / borrow / build？',
    });
  } else {
    out.push({
      kind: 'capability',
      note: '想清楚一件事不等于做出来 — 把它压缩成 2 句话讲给一个 8 岁孩子能跟上的版本。',
    });
  }

  // Honesty — always inject. Anti-slop principle (§24). A cross-spark
  // without a "what could be sycophantic about this" check tends to
  // surface inspirational nonsense.
  out.push({
    kind: 'honesty',
    note: '这个 spark 听起来"漂亮"的部分有多少是 sycophancy？最弱的那条假设写出来。',
  });

  // Domain-specific extra: AI surface adds contamination check.
  if (sourceDomain === 'ai' || lower.includes('llm') || lower.includes('model')) {
    out.push({
      kind: 'contamination',
      note: '这个想法是不是 training 数据里反复出现的 cliché？换一个反例查一下。',
    });
  }
  return out.slice(0, 3);
}

// ----------------------------------------------------------------------
// _callT6 — placeholder for T6_STRONG dispatch. Returns a synthesised
// spark + action with the same shape the production caller will expect.
// Deterministic: same inputs → same outputs (modulo timestamp), so the
// test surface is stable.
// ----------------------------------------------------------------------

function _seedHash(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

async function _callT6({ problem, sourceDomain, lenses, tool }) {
  // intentional-placeholder: T6_STRONG hookup deferred to W7.4 wave-2.
  // The block below assembles a coherent mock spark + action using the
  // already-derived lenses and tool. Substitute with a real prompt + LLM
  // call when the wave activates; the surface shape stays identical.

  const lensSummary = lenses.map((l) => `${l.domain}: ${l.lens}`).join(' | ');
  const new_spark =
    `从「${sourceDomain}」域出发的"${(problem || '').slice(0, 40)}"问题，` +
    `经由${tool.name_cn}（${tool.name_en}）的关键追问 — 「${tool.key_questions[0]}」 — ` +
    `串联其它三域视角（${lensSummary.slice(0, 120)}…）后, ` +
    `新 Spark = 把原本被视为"领域内 best practice"的那条假设拎出来, 用其它三域的语言重新表述, ` +
    `观察哪一种表述让问题变得 actionable。`;

  // Action kind heuristic — wires Step 6 into either a prototype, a note,
  // a paper, or a conversation. Engineering / AI default to prototype;
  // literature → note (作品); science → experiment outline.
  let actionKind = 'prototype';
  if (sourceDomain === 'literature') actionKind = 'note';
  else if (sourceDomain === 'science') actionKind = 'experiment';

  const action_or_artifact = {
    kind: actionKind,
    summary: actionKind === 'prototype'
      ? '本周内做一个最小可被人 push back 的原型 — 哪怕只是 30 行脚本 + 1 条用户反馈。'
      : actionKind === 'experiment'
      ? '设计一个能在 48 小时内做完的对照观察 — 写下 expected output + falsifier。'
      : '写一篇 800-1500 字的笔记, 发给一个会真实反驳你的朋友, 等他 push back。',
  };

  // Hash-derived id stub — keeps mock deterministic per problem string.
  const stub = _seedHash(`${problem}|${sourceDomain}|${tool.id}`).slice(0, 10);

  return { new_spark, action_or_artifact, mock_stub: stub };
}

// ----------------------------------------------------------------------
// Domain detection — Step 1. If currentDomain is supplied, normalize.
// Otherwise try cheap-router; otherwise infer from cheap keyword scan.
// ----------------------------------------------------------------------

const _DOMAIN_KEYWORDS = Object.freeze({
  literature:  ['小说', '故事', '叙事', '诗', '神话', '哲学', '伦理', 'story', 'narrative', 'novel', 'myth', 'ethics'],
  science:     ['公式', '推导', '物理', '数学', '生物', '化学', '机制', 'physics', 'math', 'biology', 'derive', 'equation', 'mechanism'],
  engineering: ['代码', 'feature', 'ship', '产品', '架构', '工程', '部署', 'product', 'code', 'deploy', 'pipeline', 'architecture'],
  ai:          ['llm', 'agent', '模型', 'prompt', '推理', 'rag', 'transformer', 'ai', 'embedding', 'reasoning', 'fine-tune'],
});

function _detectDomain(problem) {
  const lower = (problem || '').toLowerCase();
  let best = 'engineering';
  let bestScore = 0;
  for (const d of DOMAINS) {
    const seeds = _DOMAIN_KEYWORDS[d];
    let s = 0;
    for (const seed of seeds) {
      if (lower.includes(seed.toLowerCase())) s += 1;
    }
    if (s > bestScore) { best = d; bestScore = s; }
  }
  return best;
}

// ----------------------------------------------------------------------
// History persistence — cross-sparks.jsonl per slug.
// ----------------------------------------------------------------------

function _vaultRoot() {
  if (process.env.HYPHA_VAULT_DIR && fs.existsSync(process.env.HYPHA_VAULT_DIR)) {
    return process.env.HYPHA_VAULT_DIR;
  }
  if (process.env.HYPHA_DATA && fs.existsSync(process.env.HYPHA_DATA)) {
    return process.env.HYPHA_DATA;
  }
  return path.join(__dirname, '..', '..', '..', 'vault');
}

function _historyPath(slug) {
  return path.join(_vaultRoot(), String(slug || '_orphan'), 'growth', 'cross-sparks.jsonl');
}

function _ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function _appendHistory(slug, spark) {
  try {
    const p = _historyPath(slug);
    _ensureDir(path.dirname(p));
    fs.appendFileSync(p, JSON.stringify(spark) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

async function loadHistory(slug) {
  if (!slug) return [];
  const p = _historyPath(slug);
  if (!fs.existsSync(p)) return [];
  const out = [];
  const text = fs.readFileSync(p, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (_) { /* skip malformed */ }
  }
  // Newest first.
  out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return out;
}

// ----------------------------------------------------------------------
// Public — generateCrossSpark
// ----------------------------------------------------------------------

async function generateCrossSpark({ currentProblem, currentDomain, slug } = {}) {
  if (!currentProblem || typeof currentProblem !== 'string') {
    throw new Error('currentProblem required (non-empty string)');
  }

  // Step 1 — identify domain.
  let sourceDomain = _normalizeDomain(currentDomain);
  if (!sourceDomain && _cheapRouter && typeof _cheapRouter.detectDomain === 'function') {
    try { sourceDomain = _normalizeDomain(_cheapRouter.detectDomain(currentProblem)); } catch (_) { /* fallthrough */ }
  }
  if (!sourceDomain) sourceDomain = _detectDomain(currentProblem);

  // Step 2 — map to other 3 domain lenses.
  const lenses = _generateLenses(sourceDomain);

  // Step 3 — pick a thinking tool.
  const recommended = ThinkingTools.recommendTool(currentProblem);
  const toolId = recommended[0];
  const tool = ThinkingTools.getTool(toolId);
  if (!tool) {
    // This would mean the library is malformed — fail loud rather than ship
    // a spark missing its tool field.
    throw new Error(`thinking tool '${toolId}' not found in library`);
  }

  // Step 4 — apply tool, derive new spark via T6 (mocked).
  const t6 = await _callT6({ problem: currentProblem, sourceDomain, lenses, tool });

  // Step 5 — constraints.
  const constraints = _generateConstraints(currentProblem, sourceDomain);

  // Step 6 — action / artifact already produced inside _callT6.

  const ts = new Date().toISOString();
  const id = `xs-${ts.replace(/[-:.TZ]/g, '').slice(0, 14)}-${_seedHash(`${currentProblem}|${ts}`).slice(0, 6)}`;

  const spark = {
    id,
    ts,
    slug: slug || null,
    source_problem: currentProblem,
    source_domain: sourceDomain,
    other_domain_lenses: lenses,
    thinking_tool_id: tool.id,
    thinking_tool: {
      id: tool.id,
      name_cn: tool.name_cn,
      name_en: tool.name_en,
      key_question: tool.key_questions[0],
    },
    new_spark: t6.new_spark,
    constraints,
    action_or_artifact: t6.action_or_artifact,
    // recommended alternate (top-2) so the UI can offer "try another tool"
    alternate_tool_id: recommended[1] || null,
    mock: true,    // remove when T6_STRONG wires in
  };

  // Persist for history surface; best-effort.
  if (slug) _appendHistory(slug, spark);

  // Emit event so W3.6 Companion can listen for cross_spark:generated.
  if (slug && _events && typeof _events.write === 'function') {
    try {
      _events.write(slug, {
        type: 'growth:cross_spark:generated',
        spark_id: id,
        source_domain: sourceDomain,
        thinking_tool: tool.id,
        action_kind: spark.action_or_artifact && spark.action_or_artifact.kind,
      });
    } catch (_) { /* graceful */ }
  }

  return spark;
}

// ----------------------------------------------------------------------
// Exports
// ----------------------------------------------------------------------

module.exports = {
  generateCrossSpark,
  loadHistory,
  DOMAINS,
  _internals: {
    normalizeDomain: _normalizeDomain,
    detectDomain: _detectDomain,
    generateLenses: _generateLenses,
    generateConstraints: _generateConstraints,
    callT6: _callT6,
    historyPath: _historyPath,
  },
};
