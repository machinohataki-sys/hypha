'use strict';

// HYPHA · W7.4 Thinking Tools Library — 12 hand-curated cognitive instruments.
//
// Per BLUEPRINT.md §14.3 + ROADMAP v2.3. Each tool is one of the time-tested
// "ways of looking" that bridge a domain (literature / science / engineering /
// AI) into a new spark when applied across the Cross-Spark flow (§14.2).
//
// Surface contract (frozen, never throw on read paths):
//   - THINKING_TOOLS_LIBRARY: Array<Tool>           — exactly 12 entries, ordered.
//   - getTool(toolId)                               — Tool | null
//   - listTools()                                   — same as the array (shallow copy)
//   - recommendTool(problem)                        — returns top-2 ids by keyword match
//
// Tool shape (see TOOL_FIELDS):
//   { id, name_cn, name_en, when_to_use, key_questions[], example_application, anti_pattern }
//
// Authoring notes:
//   - All copy is plain prose. No SaaS-y exclamation, no jargon escape hatches.
//   - 千金 register passthrough: the screen renders these fields directly, so
//     keep sentences calm and complete.
//   - recommendTool() is intentionally simple keyword scoring — the LLM tier
//     (T3_MID or T6_STRONG) can refine the pick in cross-spark/engine.js. We
//     do not call LLM here; recommendTool is sync and offline.
//
// Boundary partners:
//   - W7.4 cross-spark/engine.js    — invokes recommendTool / getTool during Step 3
//   - W3.6 Companion                — may surface a tool of the week (read-only)
//   - W4.x Goal System              — may filter tools by goal archetype

// =====================================================================
// Tool field schema — kept here so any extension of the library at runtime
// can re-use the same validator. The engine treats unknown fields as
// passthrough so adding metadata later does not break the contract.
// =====================================================================

const TOOL_FIELDS = Object.freeze([
  'id',
  'name_cn',
  'name_en',
  'when_to_use',
  'key_questions',
  'example_application',
  'anti_pattern',
]);

// =====================================================================
// 12 thinking tools — hand-curated. Order matches the §14.3 enumeration.
// =====================================================================

const _TOOLS = [
  {
    id: 'socratic-questioning',
    name_cn: '苏格拉底式追问',
    name_en: 'Socratic Questioning',
    when_to_use: '当一个说法被反复重复但从未被检验时；当 user 接受了一个二手结论；当任何核心断言出现“显然 / 大家都知道”这种节省思考的副词。',
    key_questions: [
      '这句话的具体含义是什么？换一种说法你还会同意吗？',
      '支持它的证据是什么？最薄的那条是哪一条？',
      '如果这句话是错的，世界会有什么不同？',
      '提出这句话的人，他从中获得了什么？',
      '反例是什么？最强的反对者会如何反驳？',
    ],
    example_application: '设计课程时遇到“用户都想要短视频学习” — 拆: 什么用户？哪种学习场景？“想要”是行为还是问卷反馈？短视频指 ≤60 秒还是 ≤10 分钟？三轮追问后通常发现真问题是“通勤场景下手机端单手交互”，与短视频形式无关。',
    anti_pattern: '把追问做成审讯（每条都问“为什么”），让对话失去节奏。Socratic 是合作，不是攻击。',
  },
  {
    id: 'first-principles',
    name_cn: '第一性原理',
    name_en: 'First Principles',
    when_to_use: '当行业惯例正在阻挡显然更好的方案；当 stack 已经累积了 5+ 层 abstraction 而没人记得 base case；当 cost / latency / quality 中任意指标卡在“行业平均”附近。',
    key_questions: [
      '剥掉所有惯例 / 类比 / 行业最佳实践之后，剩下的物理 / 数学 / 经济不可变量是什么？',
      '哪一条假设是“因为大家这样做”而不是“因为不这样做就违反 X”？',
      '如果今天才开始做这件事，最廉价的解是什么？',
      '价格 / 时间 / 能耗的下限是什么？现状离下限有多远？',
    ],
    example_application: 'Musk 拆火箭成本: 行业惯例 = "火箭很贵 (~$60M)"。第一性原理: 拆解原材料成本 (~$2M) → 制造 + 复用流程是 30 倍溢价 → SpaceX 自研。Hypha 类比: 拆 "课程生成很贵" → token + 时间 + 评审 = ¥0.X，行业溢价在哪？',
    anti_pattern: '把第一性原理当成“我可以无视既有方案”的许可证。先理解既有方案为何长成这样，再去 strip。多数 abstraction 是过去的尸体在保护现在。',
  },
  {
    id: 'occam-razor',
    name_cn: '奥卡姆剃刀',
    name_en: 'Occam\'s Razor',
    when_to_use: '出现 2+ 套同样能解释现象的理论时；debug 一个 bug 但 hypotheses 已经膨胀到 5+ 个时；feature design 出现 ifs 分支树。',
    key_questions: [
      '在能解释现象的所有方案里，哪个引入的新实体最少？',
      '有没有一个解释只用现有变量就够了？',
      '复杂方案多解释了什么？少解释了什么？',
      '简单方案的漏洞在哪？是漏洞还是 acceptable simplification？',
    ],
    example_application: '"为什么 lesson 0 经常生成不出来？" — 复杂假设: LLM router 路径 × env var 缺失 × prompt 注入失败 × cache miss。剃刀: 看 events.jsonl 最近 10 条 — 9 条都是同一个 5xx 报错，根因是 GLM rate limit。',
    anti_pattern: '剃刀剃掉了真正必要的复杂性 — 现实问题本来就需要 5 个变量，强行压成 2 个 = 错误简化。剃刀是“无必要不增”不是“必要也不增”。',
  },
  {
    id: 'pragmatism',
    name_cn: '实用主义',
    name_en: 'Pragmatism',
    when_to_use: '团队在“最佳方案”上争论 > 48 小时；学术正确但落地代价超出 budget；用户问的是“能用吗”而工程师在答“理论上”。',
    key_questions: [
      '这个区别在实际行为上能被观察到吗？',
      '如果两种方案最终产出的 user 体验一样，争论的是什么？',
      '把方案 ship 出去 6 个月后，哪些争论点还会被记得？',
      'cheapest possible test 是什么？',
    ],
    example_application: '"用 RAG 还是 fine-tune 做课程个性化" — 实用主义: 先用 50 行 prompt + 用户 profile 字符串拼接试 1 周，看用户留存有没有动；动了再选技术栈。技术栈选错的代价 < 1 个月没人用的代价。',
    anti_pattern: '把实用主义当成“反对深度思考”的挡箭牌。短期 working 不等于长期正确 — pragma 也要照顾 6 个月 horizon。',
  },
  {
    id: 'counterfactual-thinking',
    name_cn: '反事实推理',
    name_en: 'Counterfactual Thinking',
    when_to_use: '一个结果发生后被归因于某个 feature；做 post-mortem 时；评估“某个决策是否值得”。',
    key_questions: [
      '如果这一步没发生 / 决策反过来，最可能的结果是什么？',
      '“因为 X 所以 Y” 的反例是什么？X 不在但 Y 仍发生的场景？',
      '历史上有没有相似的反事实样本可以观察？',
      '我现在归因的 cause 是 cause 还是 correlate？',
    ],
    example_application: '"v0.4.3 ship 后 DAU +18%" — 反事实: 同期 spring break，可能 baseline 本身就 +12%。真正贡献可能只有 +6%，不是 +18%。规模感失真的归因会导致下一版资源错配。',
    anti_pattern: '反事实做到无限层 — 任何决策都可以被反事实推翻。守住 2-3 层 + 时间盒 30min，超出 = 决策瘫痪。',
  },
  {
    id: 'systems-thinking',
    name_cn: '系统思维',
    name_en: 'Systems Thinking',
    when_to_use: '一个修复在 A 处生效，但在 B 处冒出新问题；user behavior 在长尺度上违背单点设计意图；任何带反馈循环的子系统出现震荡。',
    key_questions: [
      '这个组件的输入来自哪里？输出去哪里？外部依赖是什么？',
      '哪些节点之间存在隐性反馈（A 影响 B，B 又影响 A）？',
      '当前问题是节点本身的 bug，还是节点之间的接口 / 时序 bug？',
      '系统的稳定点（attractor）在哪？现在被推向哪？',
    ],
    example_application: 'Hypha 课程"卡在 lesson 3" — 单点视角: lesson 3 prompt 写得差。系统视角: lesson 0-2 给用户埋下太低的预期, 用户带着浏览心态进 lesson 3, lesson 3 高密度内容打到一脸雾水, 用户翻车 → 反馈循环负向。修 lesson 3 不动 lesson 0-2 = 治标。',
    anti_pattern: '把所有问题都解释成"系统涌现" — 有些 bug 就是某行代码写错了。先排除单点, 再上系统视角。',
  },
  {
    id: 'narrative-analysis',
    name_cn: '叙事分析',
    name_en: 'Narrative Analysis',
    when_to_use: '一个数据集 / 决策 / 产品故事被反复讲述时；评估 marketing copy / pitch deck / 创始人 talk；任何 stakeholder 试图 frame 一个事件时。',
    key_questions: [
      '这个故事谁讲？谁在听？讲述者从这个 framing 中获得什么？',
      '故事里被隐去的角色是谁？谁的视角缺席？',
      '“开始 / 转折 / 高潮 / 收束” 在哪？这个三幕结构服务于什么？',
      '换一个叙述者重讲，关键事件会变吗？',
    ],
    example_application: '"OpenAI 是 AGI 的领跑者" — 这个叙事谁讲？讲给谁？省略了谁（Anthropic, DeepMind, 开源社区, 中国实验室）？叙事的功能是稳定融资 + 锁住人才, 不必然映射真实进度。',
    anti_pattern: '把叙事分析当成 "一切都是构造" — 滑向虚无主义。叙事可以分析, 但事实仍然是事实。区分 framing 和 ground truth。',
  },
  {
    id: 'structuralism',
    name_cn: '结构主义',
    name_en: 'Structuralism',
    when_to_use: '面对一个表面纷繁的领域（神话 / 时尚 / 课程 / UI patterns）但怀疑底层只有几条 axis；做 typology / taxonomy 设计时；compare 多个 instance 想抽 invariant。',
    key_questions: [
      '把所有 instance 摆出来，反复出现的 axis 是什么？',
      '哪些 surface 差异其实是同一个 deep structure 的不同表面？',
      '在这个 axis 上，对立项 (binary opposition) 是什么？',
      '结构图谱里有没有"理论上应存在但实际为空"的位置？那个空位提示了什么？',
    ],
    example_application: 'Lévi-Strauss 拆神话: 表面 1000 个故事, 底层只有 ~12 个 binary axis (生 / 熟, 文化 / 自然, 男 / 女...)。Hypha 应用: 把 200 个用户问题拆 axis → 发现只有 5 个真核诉求, surface 形态各异。',
    anti_pattern: '结构主义会让你只看 axis 不看 instance — 但每个 instance 都有自己的内在情感价值。Axis 是 lens, 不是 reality 本身。',
  },
  {
    id: 'second-order-consequence',
    name_cn: '二阶后果',
    name_en: 'Second-Order Consequence',
    when_to_use: '一个新 feature / 政策 / 工具马上要 ship；当 first-order impact 看起来很正面时（更危险）；任何引入新激励结构的设计。',
    key_questions: [
      '这个改动的直接后果是什么？6 个月 / 18 个月 / 5 年后呢？',
      '哪些行为会因此被激励出来？被压抑掉？',
      '用户 / 系统的 adapter 反应是什么？他们会怎么 game 这个 feature？',
      '正反馈 loop 在哪？负反馈 loop 在哪？',
    ],
    example_application: 'TikTok 算法首阶: 提升 engagement → 用户停留更久。二阶: 短刺激驯化注意力 → 长内容产能崩溃 → 创作者经济单一化 → 文化深度下降。如果 Hypha 引入"日 streak", 二阶后果是用户开始假打卡刷数字。',
    anti_pattern: '二阶分析容易滑向 "什么都不要做了" 的瘫痪。二阶不是 veto, 是 design constraint — 让你 ship 的时候带着护栏。',
  },
  {
    id: 'marginal-thinking',
    name_cn: '边际思维',
    name_en: 'Marginal Thinking',
    when_to_use: '资源分配决策；任何"再投入 X 是否值得"的问题；evaluate sunk cost；判断一个 feature 是否过度工程。',
    key_questions: [
      '再投入 1 单位资源，能带来多少新收益？',
      '当前 stack 的最弱环节是什么？把资源放那里 vs. 这里？',
      '边际收益开始下降的拐点在哪？我们过了吗？',
      '机会成本是什么？这 1 单位资源放别的地方会怎样？',
    ],
    example_application: '课程生成"再润色一轮 prompt 工程, 还是开始做用户访谈?" — 边际: prompt 工程已经迭代 12 轮, 每轮 +2% 质量；用户访谈 = 0 → 1 的信息增量。开访谈。',
    anti_pattern: '把边际思维做到极致 — 所有事都用边际 ROI 衡量, 会扼杀长期项目和探索性投资。边际适合 short feedback loop, 长 horizon 用 option value。',
  },
  {
    id: 'historical-cycle',
    name_cn: '历史周期',
    name_en: 'Historical Cycle',
    when_to_use: '一个 trend 看起来"前所未有"时；任何技术 hype cycle；evaluate "新经济范式"；评估 founder narrative。',
    key_questions: [
      '历史上有没有结构相似的事件？发生在什么时期？',
      '上一轮 cycle 的"赢家 / 输家"分别因什么获胜或失败？',
      '当前阶段在 cycle 里的位置：起步 / 上升 / 顶 / 回调 / 低谷？',
      '哪些 invariant 跨周期不变？哪些是周期特有的噪音？',
    ],
    example_application: '"AI agent 是新范式" — 周期视角: 1990s expert systems, 2000s service-oriented architecture, 2010s chatbots, 都说过同样的话。invariant: 模型可以 reason, 但 production reliability 仍是 unsolved problem。Hypha 设计要 design for the 70% reliability ceiling。',
    anti_pattern: '"太阳底下无新事" 用到底 = 看不到真正的范式跃迁 (e.g. transformer)。周期分析提供 prior, 但不能 override 一手观察。',
  },
  {
    id: 'feedback-loop',
    name_cn: '反馈循环',
    name_en: 'Feedback Loop',
    when_to_use: '任何 system design；user behavior 在长尺度上偏离预期；metric 出现震荡 / 单调 / 加速；evaluate growth / retention 机制。',
    key_questions: [
      '哪些信号回到了源头？是正反馈还是负反馈？',
      '反馈延迟有多长？延迟会放大震荡吗？',
      '系统在没有外部干预的情况下，自然收敛到哪个状态？',
      '哪条 loop 是核心 engine？哪条 loop 是 governor (限速器)？',
    ],
    example_application: 'Twitter engagement loop: 用户发 tweet → 点赞 → dopamine → 发更多 tweet → 平台数据更多。问题: 没有 governor loop, 系统收敛到 outrage maximization。Hypha 课程生成应该有"用户掌握度 → 慢下 cadence"的 governor, 否则 streak 驱动 → burnout → churn。',
    anti_pattern: '只看正反馈不看 governor → 设计出 short-term 爆发 + long-term 崩坏的系统。健康系统是 engine loop + brake loop 配对。',
  },
];

// =====================================================================
// Validation (build-time + smoke-test) — every published tool must have
// all required fields populated with non-empty values. Anything missing
// = library is wrong, fail loud at first read.
// =====================================================================

function _validateTool(t) {
  for (const f of TOOL_FIELDS) {
    if (!(f in t)) {
      throw new Error(`thinking-tool '${t && t.id}' missing field '${f}'`);
    }
  }
  if (!Array.isArray(t.key_questions) || t.key_questions.length < 3) {
    throw new Error(`thinking-tool '${t.id}' must have ≥ 3 key_questions`);
  }
  for (const k of ['name_cn', 'name_en', 'when_to_use', 'example_application', 'anti_pattern']) {
    if (typeof t[k] !== 'string' || t[k].trim().length === 0) {
      throw new Error(`thinking-tool '${t.id}' field '${k}' must be non-empty string`);
    }
  }
}

// Freeze each tool object + the outer array so consumers cannot mutate.
const THINKING_TOOLS_LIBRARY = Object.freeze(
  _TOOLS.map((t) => {
    _validateTool(t);
    return Object.freeze({
      ...t,
      key_questions: Object.freeze([...t.key_questions]),
    });
  }),
);

// Hard invariant — the spec calls for exactly 12. Surfacing a wrong count
// during module load is preferable to a silently truncated UI.
if (THINKING_TOOLS_LIBRARY.length !== 12) {
  throw new Error(`thinking-tools library must have exactly 12 tools, got ${THINKING_TOOLS_LIBRARY.length}`);
}

// Index by id once for O(1) getTool.
const _BY_ID = Object.freeze(
  THINKING_TOOLS_LIBRARY.reduce((acc, t) => { acc[t.id] = t; return acc; }, Object.create(null)),
);

// =====================================================================
// Public API
// =====================================================================

function getTool(toolId) {
  if (!toolId || typeof toolId !== 'string') return null;
  return _BY_ID[toolId] || null;
}

function listTools() {
  // Return a shallow copy so callers cannot reorder the canonical array.
  return [...THINKING_TOOLS_LIBRARY];
}

// =====================================================================
// recommendTool — cheap offline keyword score. Returns top-2 tool ids
// ordered by match strength. Ties broken by canonical library order.
//
// We intentionally avoid LLM here: this is a fast O(tools × keywords)
// pass that engine.js calls once per cross-spark. The LLM tier can
// override the pick by reading the user problem directly.
// =====================================================================

// Hand-curated keyword sets per tool. Choosing CN + EN seeds that map to
// the surface diagnostic vocabulary a user would actually type.
const _KEYWORDS = Object.freeze({
  'socratic-questioning':       ['假设', '为什么', '前提', '相信', '常识', 'assume', 'believe', 'why', 'commonsense', 'obvious'],
  'first-principles':           ['本质', '原理', '基础', '从零', '剥', 'fundamental', 'origin', 'from scratch', 'rebuild', 'strip'],
  'occam-razor':                ['复杂', '简单', '太多', '臃肿', '冗余', 'complex', 'simple', 'too many', 'bloated', 'redundant'],
  'pragmatism':                 ['有用', '能用', '落地', '实际', '管不管用', 'works', 'useful', 'practical', 'real-world', 'ship'],
  'counterfactual-thinking':    ['如果没有', '反事实', '归因', '假如', '另一种可能', 'if not', 'counterfactual', 'attribution', 'what if', 'alternative'],
  'systems-thinking':           ['系统', '反馈', '联动', '牵一发', '生态', 'system', 'interaction', 'side effect', 'ecosystem', 'cascading'],
  'narrative-analysis':         ['故事', '叙事', '宣传', '包装', '说法', 'story', 'narrative', 'framing', 'pitch', 'positioning'],
  'structuralism':              ['结构', '类型', '分类', '维度', '原型', 'structure', 'typology', 'pattern', 'taxonomy', 'archetype'],
  'second-order-consequence':   ['后果', '副作用', '长期', '激励', '滥用', 'consequence', 'side-effect', 'long-term', 'incentive', 'gaming', '失败', 'fail'],
  'marginal-thinking':          ['边际', '再投', '继续做', '值得吗', '机会成本', 'marginal', 'next dollar', 'worth it', 'opportunity cost', 'ROI'],
  'historical-cycle':           ['历史', '周期', '循环', '范式', '又一次', 'history', 'cycle', 'recurring', 'paradigm', 'cyclical'],
  'feedback-loop':              ['循环', '反馈', '正反馈', '负反馈', '失败', '增长', '震荡', 'loop', 'feedback', 'flywheel', 'growth', 'oscillation', 'fail'],
});

function _scoreTool(toolId, normalized) {
  const seeds = _KEYWORDS[toolId] || [];
  let score = 0;
  for (const seed of seeds) {
    const s = seed.toLowerCase();
    if (!s) continue;
    if (normalized.includes(s)) {
      // Whole-word EN matches score higher than substring CN matches; the
      // CN matches are still useful so we keep them in pool at weight 1.
      score += s.length >= 4 ? 2 : 1;
    }
  }
  return score;
}

function recommendTool(problem) {
  if (typeof problem !== 'string' || problem.trim().length === 0) {
    // Empty problem → return the two most "general purpose" defaults: first
    // principles + socratic. They are the broadest priors when nothing is
    // known about the question yet.
    return ['first-principles', 'socratic-questioning'];
  }
  const normalized = problem.toLowerCase();
  const scored = THINKING_TOOLS_LIBRARY.map((t, i) => ({
    id: t.id,
    score: _scoreTool(t.id, normalized),
    order: i,
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.order - b.order;
  });
  // If the top score is zero, every tool was a miss → fall back to the
  // broad-purpose defaults rather than picking the first two library
  // items by coincidence.
  if (scored[0].score === 0) {
    return ['first-principles', 'socratic-questioning'];
  }
  return [scored[0].id, scored[1].id];
}

// =====================================================================
// Exports
// =====================================================================

module.exports = {
  THINKING_TOOLS_LIBRARY,
  TOOL_FIELDS,
  getTool,
  listTools,
  recommendTool,
  // Test surface — expose private helpers under _internals so the unit
  // test can exercise scoring without going through the public path.
  _internals: {
    validateTool: _validateTool,
    scoreTool: _scoreTool,
    keywords: _KEYWORDS,
  },
};
