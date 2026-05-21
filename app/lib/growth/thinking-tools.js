'use strict';

// HYPHA · γ18 Thinking Tools (Growth System §28 子组件 v0, 2026-05-16)
//
// 学习中卡住时, 用户能召唤一种思考工具 — 5 Whys / Fishbone / Inversion /
// First Principles / Pre-Mortem / Steelman / Map-Territory。
// v0 = static inventory + invoke 返回 scaffold-filled prompt + 落 jsonl 历史。
// v1+ 才接 "用工具 → LLM 生成 Socratic question"。
//
// Public surface:
//   listTools()                                  → { ok, tools }
//   getTool(toolId)                              → { ok, tool } | { ok:false, error:'NOT_FOUND' }
//   invokeTool({ slug, toolId, problem })        → { ok, invocation } | { ok:false, error }
//   listInvocations({ slug, limit })             → { ok, rows }
//
// Storage: vault/<slug>/.thinking-tools.jsonl, append-only.
//   row: { id, ts, toolId, problem, scaffold_filled }
//
// Error codes (enum): NOT_FOUND / MISSING_SLUG / MISSING_PROBLEM / EXCEPTION

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { resolveRoot } = require('../vault');

// ---------------------------------------------------------------------------
// 7 工具 inventory (v0 hardcoded — 不外部 JSON, 防漂移)
// ---------------------------------------------------------------------------

const TOOLS = Object.freeze([
  {
    id: '5-whys',
    label: '5 Whys · 五问根因',
    domain: 'diagnosis',
    short: '连问 5 次"为什么", 从症状下钻到根因',
    whenToUse: '卡在症状层面 / 表面解释似是而非 / 想找系统性原因',
    scaffold:
      '问题: {problem}\n\n' +
      'Why 1: ____\n' +
      'Why 2: ____\n' +
      'Why 3: ____\n' +
      'Why 4: ____\n' +
      'Why 5: ____\n\n' +
      '根因 = 最后一层不再有"why"可问的那一层',
  },
  {
    id: 'fishbone',
    label: 'Fishbone · 鱼骨图',
    domain: 'diagnosis',
    short: '6 类原因 (Method / Machine / Material / Manpower / Measurement / Milieu) 分支列因',
    whenToUse: '根因不单一 / 想全景扫一次因素',
    scaffold:
      '问题: {problem}\n\n' +
      'Method (方法): ____\n' +
      'Machine (工具): ____\n' +
      'Material (材料): ____\n' +
      'Manpower (人): ____\n' +
      'Measurement (度量): ____\n' +
      'Milieu (环境): ____',
  },
  {
    id: 'inversion',
    label: 'Inversion · 反向',
    domain: 'decision',
    short: '不问"怎么成功", 问"什么会让必败"',
    whenToUse: '追求一个目标但屡战屡败 / 想找隐藏陷阱',
    scaffold:
      '目标: {problem}\n\n' +
      '要让这个目标必败, 最高效的 5 种做法:\n' +
      '1. ____\n' +
      '2. ____\n' +
      '3. ____\n' +
      '4. ____\n' +
      '5. ____\n\n' +
      '→ 反过来就是避免做的事',
  },
  {
    id: 'first-principles',
    label: 'First Principles · 第一性原理',
    domain: 'derivation',
    short: '剥到不能再剥的原子, 从原子重新推',
    whenToUse: '被默认假设套住 / 想跳出"大家都这么做"',
    scaffold:
      '问题: {problem}\n\n' +
      'Q1: 这个问题的"原子"事实是什么 (不可再分的)?\n' +
      '→ ____\n' +
      'Q2: 这些原子事实之间真实关系是什么 (不靠 analogy)?\n' +
      '→ ____\n' +
      'Q3: 从这些原子重新推导, 解长什么样?\n' +
      '→ ____',
  },
  {
    id: 'pre-mortem',
    label: 'Pre-Mortem · 死后验尸',
    domain: 'decision',
    short: '假设 6 个月后失败了, 反推为什么',
    whenToUse: '决定前 / 想 stress-test 计划',
    scaffold:
      '计划: {problem}\n\n' +
      '假设 6 个月后这个计划完全失败. 写一段 200 字故事说明为什么失败 (具体, !抽象):\n' +
      '____\n\n' +
      '→ 故事里出现的几个 trigger 现在就改',
  },
  {
    id: 'steelman',
    label: 'Steelman · 钢人',
    domain: 'argument',
    short: '把对方观点构造到最强版本再批',
    whenToUse: '要反驳 / 想避免 strawman / 学一个 contestable 主张',
    scaffold:
      '你反对的主张: {problem}\n\n' +
      '最强版本 (steelman):\n' +
      '这个主张如果按最聪明的人辩护, 会用以下 3 个论据 + 反预期反驳:\n' +
      '1. ____\n' +
      '2. ____\n' +
      '3. ____\n\n' +
      '现在你的反驳是否仍站得住?',
  },
  {
    id: 'map-territory',
    label: 'Map-Territory · 地图与领土',
    domain: 'epistemic',
    short: '区分"我的模型"和"真实世界"',
    whenToUse: '怀疑自己卡在抽象 / 想检查 model 是否对应 territory',
    scaffold:
      '我的当前模型 (map): {problem}\n\n' +
      '这个 map 在以下 3 处可能与 territory 不符:\n' +
      '1. ____\n' +
      '2. ____\n' +
      '3. ____\n\n' +
      '→ 哪个可以最快测试? 用什么具体观察?',
  },
]);

const TOOL_INDEX = Object.freeze(
  TOOLS.reduce((acc, t) => { acc[t.id] = t; return acc; }, {})
);

// S77 27-pattern combinatorics gives 3-tool clusters: each anchor tool
// surfaces 2 "lateral pair" tools that productively re-frame the same problem
// from a different cognitive axis (analogical / inversive / decomposing).
// Pairs are bidirectional in concept but stored explicitly to keep ordering
// stable for surface UX (anchor first → recommended pair).
const TOOL_CLUSTERS = Object.freeze({
  'first-principles': Object.freeze(['inversion', 'map-territory']),
  '5-whys':           Object.freeze(['fishbone', 'first-principles']),
  'fishbone':         Object.freeze(['5-whys', 'pre-mortem']),
  'inversion':        Object.freeze(['pre-mortem', 'steelman']),
  'pre-mortem':       Object.freeze(['inversion', 'steelman']),
  'steelman':         Object.freeze(['inversion', 'map-territory']),
  'map-territory':    Object.freeze(['first-principles', 'steelman']),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _toolsPath(slug) {
  const vaultRoot = resolveRoot();
  return path.join(vaultRoot, String(slug), '.thinking-tools.jsonl');
}

function _newId() {
  return 'tt-' + crypto.randomBytes(6).toString('hex');
}

function _fillScaffold(scaffold, problem) {
  // String#replaceAll for {problem} — global, literal.
  return String(scaffold).split('{problem}').join(String(problem));
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

function listTools() {
  // Return a fresh array each call so callers can't mutate frozen objects.
  return { ok: true, tools: TOOLS.map(t => ({ ...t })) };
}

function getTool(toolId) {
  if (typeof toolId !== 'string' || !toolId) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  const t = TOOL_INDEX[toolId];
  if (!t) return { ok: false, error: 'NOT_FOUND' };
  return { ok: true, tool: { ...t } };
}

function invokeTool({ slug, toolId, problem } = {}) {
  try {
    if (typeof toolId !== 'string' || !toolId) {
      return { ok: false, error: 'NOT_FOUND' };
    }
    const tool = TOOL_INDEX[toolId];
    if (!tool) return { ok: false, error: 'NOT_FOUND' };
    if (typeof problem !== 'string' || !problem.trim()) {
      return { ok: false, error: 'MISSING_PROBLEM' };
    }
    const trimmedProblem = problem.trim();
    const scaffold_filled = _fillScaffold(tool.scaffold, trimmedProblem);

    const invocation = {
      tool: { ...tool },
      problem: trimmedProblem,
      scaffold_filled,
      instruction: '按 scaffold 填空, 不要 skip',
    };

    // Persist to vault/<slug>/.thinking-tools.jsonl (slug optional — invoke
    // can be used for dry-run without a vault). Append failure does not
    // invalidate the invocation result.
    if (slug && typeof slug === 'string') {
      try {
        const abs = _toolsPath(slug);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const row = {
          id: _newId(),
          ts: new Date().toISOString(),
          toolId: tool.id,
          problem: trimmedProblem,
          scaffold_filled,
        };
        fs.appendFileSync(abs, JSON.stringify(row) + '\n', 'utf-8');
      } catch (err) {
        console.warn('[thinking-tools] append jsonl failed:', err && err.message);
      }
    }

    return { ok: true, invocation };
  } catch (err) {
    console.warn('[thinking-tools] invokeTool EXCEPTION:', err && err.stack);
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

async function listInvocations({ slug, limit = 20 } = {}) {
  try {
    if (!slug || typeof slug !== 'string') {
      return { ok: false, error: 'MISSING_SLUG' };
    }
    const abs = _toolsPath(slug);
    if (!fs.existsSync(abs)) return { ok: true, rows: [] };
    let text = '';
    try { text = fs.readFileSync(abs, 'utf-8'); }
    catch (_) { return { ok: true, rows: [] }; }
    if (!text) return { ok: true, rows: [] };
    const rows = [];
    for (const ln of text.split(/\r?\n/)) {
      if (!ln.trim()) continue;
      try { rows.push(JSON.parse(ln)); } catch (_) { /* skip malformed */ }
    }
    rows.reverse();
    const cap = Math.max(1, Number(limit) || 20);
    return { ok: true, rows: rows.slice(0, cap) };
  } catch (err) {
    console.warn('[thinking-tools] listInvocations EXCEPTION:', err && err.stack);
    return { ok: false, error: 'EXCEPTION', message: err && err.message };
  }
}

function getToolCluster(toolId) {
  if (typeof toolId !== 'string' || !toolId) {
    return { ok: false, error: 'NOT_FOUND' };
  }
  const anchor = TOOL_INDEX[toolId];
  if (!anchor) return { ok: false, error: 'NOT_FOUND' };
  const pairIds = TOOL_CLUSTERS[toolId] || [];
  const pair = pairIds
    .map(id => TOOL_INDEX[id])
    .filter(Boolean)
    .map(t => ({ ...t }));
  return {
    ok: true,
    cluster: {
      anchor: { ...anchor },
      pair,
      rationale: '同问题, 另两条思考轴 (analogical / inversive / decomposing) 再过一次',
    },
  };
}

module.exports = {
  listTools,
  getTool,
  invokeTool,
  listInvocations,
  getToolCluster,
  // exported for introspection / tests; not stable API
  _internals: {
    TOOLS,
    TOOL_INDEX,
    TOOL_CLUSTERS,
    fillScaffold: _fillScaffold,
  },
};
