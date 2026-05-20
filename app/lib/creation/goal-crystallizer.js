'use strict';
// HYPHA · Goal Crystallizer (Phase F.0, 2026-05-18)
//
// User feedback 2026-05-18: 草稿 GOAL ("我要成为诺贝尔文学作家") 是 fog —
// 内含至少 6 个 未定维度 (语言 / 流派师承 / 体裁 / 现位置 / 里程碑 / 可放弃工具).
// 当前 HYPHA 跳过这层 → LLM 默推 training-frequency 最高路径 (= 英语圈 + 长篇)
// → user 想学川端式静默被默推 "百年孤独". 这是 AMD-MEOW-P7 anti-slop 的另一面.
//
// 此模块 = 2-stage LLM 流, 把 fog 切清:
//   1. generateCrystallizerQuestions({draftGoal, archetype}) — 3-5 多选 (A/B/C/D)
//      每题 D 永远是 "其他 / 自己写" 兜底 (用户脑负担最低)
//      Archetype-aware 维度模板
//   2. crystallizeGoal({draftGoal, archetype, answers}) — 合成 specific+verifiable goal
//      输出 tags 给下游 recommendBooks (fit > popular) + chain plan 用
//
// 失败 fall through: 任一调用失败 → 返 null + reason, caller 退回用草稿直生.

// 2026-05-18 user lock: 2-stage wizard. Stage 1 = 3 broad (lineage / output_form /
// timeline). Stage 2 = 5 deep, generated AFTER user answers broad — each deep Q
// drills into the specific instance user picked. Total 8 questions across 2 calls.
const RECOMMEND_MAX_QUESTIONS = 3;
const RECOMMEND_MIN_QUESTIONS = 3;
const QUESTION_OPTIONS_REQUIRED = 4;
const BROAD_QUESTIONS_COUNT = 3;
const DEEP_QUESTIONS_COUNT = 5;

// Archetype-aware dimension templates. LLM picks 3-5 of these to ask, based
// on which are most disambiguating for the draft goal.
// 2026-05-18 user lock: 时长 ! HYPHA 决, 提 3 anchor (稳/赶/更稳) + D 自写.
// Each archetype carries a `__timeline_center` hint for the LLM to anchor 3
// options around (center / center×0.9 / center×1.1 / custom).
const ARCHETYPE_DIMENSIONS = Object.freeze({
  'HUMANITIES': [
    '语言/写作圈 (汉语 / 英语 / 日语 / 跨语言)',
    '流派师承 (川端式静默 / 加缪式存在 / 马尔克斯式魔幻 / 卡夫卡式异化 / 自定义)',
    '体裁 (短篇 / 长篇 / 散文 / 诗 / 戏剧)',
    '现位置 (零基础 / 写过未发 / 发过期刊 / 出过书)',
    '中间里程碑 (省级奖 / 期刊发表 / 出版社签约 / 译介海外)',
    '可放弃的工具 / 边界 (英语圈优先 / 汉语圈优先 / 双语)',
    '日产出节奏 (每日 30min / 1h / 2h+)',
    '总时长 anchor=5y (稳 5y / 赶 4.5y / 更稳 5.5y / 自写)',
  ],
  'TECH-CONCEPT': [
    '子领域 (transformer / RL / 因果推断 / 优化 / 几何深度学习)',
    '材料偏好 (原 paper / 教科书 / 代码库)',
    '深度目标 (面试通关 / 复现 SOTA / 出 paper / 产品落地)',
    '现位置 (零基础 / 跑过教程 / 改过模型 / 发过 paper)',
    '总时长 anchor=1y (稳 1y / 赶 9mo / 更稳 18mo / 自写)',
    '主语言 (Python / Rust / C++ / 数学优先)',
  ],
  'TECH-PROC': [
    '语言/栈 (Rust / Go / TypeScript / Python / 数据库)',
    '应用形态 (服务端 / 工具 CLI / Web app / Mobile / 嵌入式)',
    '深度目标 (面试 / 自己一个 side project / 转岗 / 开源贡献)',
    '现位置 (零基础 / 写过项目 / 工作几年)',
    '总时长 anchor=3mo (稳 3mo / 赶 2mo / 更稳 5mo / 自写)',
  ],
  'LANG-ACQ': [
    '目标语言 (英 / 日 / 法 / 德 / 俄 / 意 / 西 / 阿)',
    '目标级别 (CEFR A2 / B1 / B2 / C1 / C2 或 HSK / JLPT)',
    '主输出技能 (读 / 听 / 写 / 说)',
    '现位置 (零基础 / 入门 / 中级 / 高级)',
    '总时长 anchor=1y (稳 1y / 赶 9mo / 更稳 18mo / 自写)',
    '母语 / 已会语言 (中 / 英 / 双语)',
  ],
  'DECL-MASS': [
    '证书 / 考试名 (考研 / FRM / CFA / 律考 / 教资)',
    '总时长 anchor=6mo (稳 6mo / 赶 4mo / 更稳 9mo / 自写)',
    '现熟悉度 (完全没学 / 学过部分 / 整体复习)',
    '覆盖广度 (全面 / 重点章 / 真题为主)',
  ],
  'MINDSET': [
    '思想流派 (斯多葛 / 佛教 / 存在主义 / 禅 / 自定义)',
    '现理解 (听过名字 / 读过简介 / 读过原典)',
    '可验证的变化 (情绪反应 / 决策模式 / 日常仪式)',
    '总时长 anchor=6mo (稳 6mo / 赶 3mo / 更稳 1y / 自写)',
  ],
});

const QUESTIONS_SYSTEM_PROMPT = `You are a HYPHA Goal Crystallizer (questions stage). The user entered a vague DRAFT learning goal. Your job: generate 3-5 multi-choice questions whose answers will sharpen the draft into a SPECIFIC + VERIFIABLE goal.

INPUT:
  draft_goal: free-text from user (may be very vague, e.g. "我要成为作家")
  archetype: HUMANITIES | TECH-CONCEPT | TECH-PROC | LANG-ACQ | DECL-MASS | MINDSET
  candidate_dimensions: archetype-conditional list of dimensions WORTH asking about

OUTPUT — STRICT JSON, no prose, no markdown fences:

{
  "questions": [
    {
      "id": "q_<short_slug>",
      "prompt": "<≤30 字 CN OR ≤80 char EN>",
      "rationale": "<≤40 字 why this question disambiguates>",
      "dimension": "<one of candidate_dimensions, verbatim>",
      "options": [
        {"id": "a", "label": "<≤25 字 specific option>", "implies": "<≤25 字 tag this would add>"},
        {"id": "b", "label": "...", "implies": "..."},
        {"id": "c", "label": "...", "implies": "..."},
        {"id": "d", "label": "其他 / 自己写", "implies": "custom-input"}
      ]
    }
  ],
  "confidence": <0..1>
}

CONSTRAINTS:
- EXACTLY 3 BROAD questions targeting 3 DIFFERENT high-level dimensions (e.g. lineage / output_form / timeline). NO more, NO fewer.
  Stage 2 (after user answers these 3) generates 5 INSTANCE-LEVEL deep questions via a separate call. Do NOT try to drill deep here.
- EACH question MUST have 4 options. Option (d) is ALWAYS "其他 / 自己写" with implies="custom-input".
- Questions ordered MOST-DISAMBIGUATING first (so user bailout after Q1 still has signal).

GOAL VOCABULARY HARVEST RULE (hard — user 2026-05-18 lock):
- BEFORE picking archetype dimensions, scan draft_goal for LOADED TOKENS:
  (a) Unusual modifiers user invented ("震古烁今" / "完胜" / "颠覆" / "超越X" / "震撼Y" / "重塑Z")
  (b) Compound concepts that bundle multiple meanings ("完胜生物发展史" — does the user mean worldbuilding timeline? evolutionary biology? meta-cosmology?)
  (c) Comparison anchors with ambiguous direction ("超越冰与火之歌" — surpass in literary quality? sales? cultural reach? worldbuilding depth?)
  (d) Domain-specific jargon the LLM cannot resolve from context alone
- For EACH loaded token found, generate ONE broad question with options that DEFINE the token concretely. Stem MUST cite the user's original word verbatim.
  Bad:  "Q1 你的小说流派?" (ignores "震古烁今")
  Good: "Q1 '震古烁今' 你指哪个层面?" + options A) 文学奖项 (诺贝尔/茅盾) B) 销量历史 (全球过亿) C) 学界研究 D) 跨代文化影响
- Priority order for 3 broad Q slots (when goal has many loaded tokens):
  Slot 1: most loaded / most ambiguous token first
  Slot 2: second loaded token OR archetype-dim disambiguation
  Slot 3: ALWAYS the "总时长 anchor=X" timeline question (locked)
- If goal has 0 loaded tokens (e.g. "我想学日语 N2"), all 3 slots use archetype dims as normal.
- If goal has ≥ 3 loaded tokens, drop the timeline anchor from broad → push to deep stage; broad slots fill with loaded-token Qs.

TIMELINE ANCHOR RULE (hard — user 2026-05-18 lock "你只负责建议几年 ! 决定"):
- When candidate_dimensions contains "总时长 anchor=X" (e.g. "总时长 anchor=5y"), you MUST generate ONE question whose dimension="总时长" and whose 4 options follow this EXACT pattern:
  A) "稳 {X}"        implies "timeline={X}"
  B) "赶 {X×0.9}"   implies "timeline={X×0.9}"
  C) "更稳 {X×1.1}" implies "timeline={X×1.1}"
  D) "其他 / 自己写" implies "custom-input"
- Example for anchor=5y:
  prompt: "总时长?"
  options: A)"稳 5y" B)"赶 4.5y" C)"更稳 5.5y" D)"其他 / 自己写"
- Example for anchor=6mo:
  prompt: "总时长?"
  options: A)"稳 6mo" B)"赶 5mo" C)"更稳 7mo" D)"其他 / 自己写"
- ! HYPHA decides duration. The 3 anchors are SUGGESTIONS; user picks. DO NOT pre-select a default.
- This timeline question is ONE OF THE 3 broad questions — count toward the 3-Q limit.

CONCISE LABEL RULE (hard — user 2026-05-18 "表述更简洁"):
- Each option label ≤ 12 字 (sweet spot 6-10 字). Single-line at sidebar width.
  Bad: "5 年内省级奖 / 期刊发表" (15 字, two paths in one label)
  Good: "5y · 省级奖" (8 字)
- Do NOT cram 2 outcomes into 1 option label. Split into 2 options if needed.
- Question stems also ≤ 14 字 ("总时长?" / "你想学谁的笔法?" / "5 年里程碑?").
- Mono-time-prefix format encouraged: "5y · 内容" / "3mo · 内容" — anchor 时间放头.

CONCRETENESS RULE (hard — user 2026-05-18 caught generic batch):
- Question STEM must point at a NAMED target — a person / work / specific level / specific year / specific milestone — NOT an abstract category name.
  Bad stem: "你想学的流派师承?" / "你的目标产出?" / "深度目标是?"
  Good stem: "你想学谁的笔法?" / "你想写出哪种作品?" / "你想拿到什么具体的认可?"
- OPTION LABELS must be SINGLE NAMED INSTANCES, NOT category labels.
  Bad option: "现代主义" / "现实主义" / "魔幻现实" (abstract category)
  Good option: "川端康成式静默" / "加缪式荒诞存在" / "马尔克斯式魔幻现实" (named instance)
- When candidate_dimensions contain parenthetical examples (e.g. "流派师承 (川端式静默 / 加缪式存在 / 马尔克斯式魔幻 / 卡夫卡式异化)"), USE THOSE NAMED ITEMS verbatim or near-verbatim as options A/B/C. Do NOT collapse them to category labels.

POSITIVE FEW-SHOT:
  dimension: "流派师承 (川端式静默 / 加缪式存在 / 马尔克斯式魔幻 / 卡夫卡式异化)"
  →
  {
    "prompt": "你想学谁的笔法?",
    "options": [
      {"id":"a","label":"川端康成式静默","implies":"川端式静默笔法"},
      {"id":"b","label":"加缪式荒诞存在","implies":"加缪式存在主义笔法"},
      {"id":"c","label":"马尔克斯式魔幻现实","implies":"魔幻现实主义笔法"},
      {"id":"d","label":"其他 / 自己写","implies":"custom-input"}
    ]
  }

NEGATIVE FEW-SHOT (do not produce these):
- "你的语言/写作圈?" + "A) 汉语 B) 英语 C) 日语 D) 跨语言"  ← too abstract; user can pick but it doesn't disambiguate niche
- "你的目标产出?" + "A) 小说 B) 散文 C) 诗 D) 其他"  ← stem too abstract
- "深度目标是什么?" + "A) 浅 B) 中 C) 深 D) 其他"  ← classic "Pick a difficulty" anti-pattern

ANTI-PATTERNS:
- ! generic open-ended Q ("Why do you want to learn this?"). ! "Pick a topic". ! "Choose a difficulty".
- ! emoji. ! 感叹号. ! "great question!". ! "我们可以帮你".
- AVOID Q the LLM can guess from draft alone (e.g. if draft is "学日语 N2", don't ask "目标语言?").
- Cover dimensions where draft is SILENT or AMBIGUOUS. Per the archetype's candidate_dimensions.

Return STRICT JSON only.`;

const CRYSTALLIZE_SYSTEM_PROMPT = `You are a HYPHA Goal Synthesizer. The user entered a vague DRAFT goal + answered N multi-choice refinement questions. Synthesize a SPECIFIC + VERIFIABLE CRYSTALLIZED goal.

INPUT:
  draft_goal: original free-text
  archetype: same enum as above
  answers: [{question: "...", chosen_label: "...", implies: "...", dimension: "..."}, ...]

OUTPUT — STRICT JSON:

{
  "crystallized_goal": "<1-2 sentences, ≤80 字 CN / ≤200 char EN. SPECIFIC. VERIFIABLE. Has primary_focus + output_form + timeline. NO buzzwords.>",
  "tags": {
    "primary_focus": "<≤30 字 the SPECIFIC thing being learned, e.g. '川端式静默笔法 + 短篇汉语小说'>",
    "domain": "<≤25 字 domain label>",
    "scale": "career | project | learning | curiosity",
    "timeline": "<text, e.g. '5 年' / '3 个月'>",
    "output_form": "<≤30 字, e.g. '6-8 篇短篇汉语小说'>",
    "current_level": "zero | hobbyist | intermediate | advanced",
    "milestones": [
      "<5-year or end milestone, ≤30 字>",
      "<1-year or mid milestone, ≤30 字>",
      "<3-month or near milestone, ≤30 字>"
    ],
    "niche_factor": "low | med | high"
  },
  "confidence": <0..1>,
  "notes": "<≤60 char optional caveat>"
}

CONSTRAINTS:
- crystallized_goal MUST be more specific than draft. If draft was "我要成为作家", crystallized cannot remain "我要成为作家" — must include answered dimensions.
- crystallized_goal must include at least: primary_focus + output_form + timeline.

TIMELINE FROM USER ANSWER (hard — user 2026-05-18 lock "你只负责建议几年 ! 决定"):
- tags.timeline MUST equal the timeline the USER picked from the "总时长" dimension question, verbatim (e.g. "5y" / "4.5y" / "5.5y" / 用户自写). DO NOT invent / default / round.
- crystallized_goal MUST cite the user-picked timeline by name (e.g. "在 5.5y 内 ..." if user picked 更稳 5.5y).
- If user did NOT answer a 总时长 question (rare), set tags.timeline = "未定" and put caveat in notes. DO NOT silently default to "5 年".
- milestones similarly: ranges derived from user's total timeline (e.g. user picked 4.5y → milestones at ~1.5y / 3y / 4.5y, NOT 1y/3y/5y).

- tags.niche_factor = "high" when user's specific cut is uncommon (e.g. 川端式静默 + 短篇汉语 is high niche compared to "long English novels"). This drives book recommendation to prefer fit over popularity downstream.
- milestones: 3 entries, descending granularity. If user didn't answer milestone questions, infer reasonable defaults aligned to tags.
- ! pad with buzzwords. ! "成为顶级 X". ! "释放潜能". ! 营销话术.
- If answers contradict each other OR are too few (<2) → set confidence < 0.4 + put caveat in notes + crystallized_goal = best-effort closest to draft.

Return STRICT JSON only.`;

/**
 * Generate 3-5 multi-choice questions to crystallize a draft goal.
 *
 * @param {{draftGoal: string, archetype?: string, settings?: object, options?: object}} args
 * @returns {Promise<{ok: boolean, questions?: Array, confidence?: number, error?: string, _meta?: object}>}
 */
async function generateCrystallizerQuestions({ draftGoal, archetype, settings, options = {} } = {}) {
  if (!draftGoal || typeof draftGoal !== 'string' || !draftGoal.trim()) {
    return { ok: false, error: 'draftGoal required' };
  }

  const arch = (archetype && typeof archetype === 'string') ? archetype.trim() : 'HUMANITIES';
  const dimensions = ARCHETYPE_DIMENSIONS[arch] || ARCHETYPE_DIMENSIONS['HUMANITIES'];

  // ── L0 (2026-05-18) — Pre-LLM loaded-token harvest. JS-side regex scan
  // extracts "震古烁今" / "完胜生物发展史" / "超越X" type loaded tokens BEFORE
  // calling LLM, then injects them as REQUIRED targets in the user message.
  // Defends against LLM ignoring the GOAL VOCABULARY HARVEST RULE in the
  // system prompt. Each token MUST appear verbatim in ≥ 1 question stem.
  const loadedTokens = _extractLoadedTokens(draftGoal);

  const tokenBlock = loadedTokens.length > 0
    ? `\n\nLOADED TOKENS REQUIRING DEFINITION (user invented these — you MUST ask one question per token, citing it verbatim in the stem):
${loadedTokens.map((t, i) => `  ${i + 1}. "${t}"`).join('\n')}`
    : '';

  const userMsgBase = `DRAFT GOAL (user free-text):
${draftGoal.trim()}

ARCHETYPE: ${arch}

CANDIDATE DIMENSIONS (pick 3-5 to ask about):
${dimensions.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}${tokenBlock}

Generate the questions JSON per the SCHEMA. Pick the 3 most DISAMBIGUATING items — skip dimensions the draft already specifies. If LOADED TOKENS are present, prioritise them over archetype-dim slots (timeline anchor still locked as Q3 unless ≥3 loaded tokens).`;

  const capability = options.capability || 'T3_MID';
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 1500;
  const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.4;
  const { executeChat } = require('../llm');

  const _tryOnce = async (userMsg) => {
    const t0 = Date.now();
    const dispatch = await executeChat(capability, {
      messages: [
        { role: 'system', content: QUESTIONS_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      json: true,
      maxTokens,
      temperature,
      timeoutMs: 45_000,
    });
    return { dispatch, ms: Date.now() - t0 };
  };

  try {
    // L1: first try
    let { dispatch, ms } = await _tryOnce(userMsgBase);
    let result = dispatch && dispatch.result;
    let v = validateQuestions(result);
    if (!v.ok) {
      return { ok: false, error: v.error, _meta: { ms, provider: dispatch && dispatch.providerId, validation_error: v.error } };
    }

    let questions = result.questions
      .slice(0, RECOMMEND_MAX_QUESTIONS)
      .map(_sanitizeQuestion)
      .filter(Boolean);

    // L2: token-citation validation
    let missing = _findUncitedTokens(loadedTokens, questions);
    let retried = false;
    let stubbed = [];

    if (missing.length > 0) {
      // L3: retry once with explicit failure feedback
      retried = true;
      const retryMsg = userMsgBase + `\n\n[PREV ATTEMPT FAILED — questions did not cite these user tokens verbatim: ${missing.map(t => `"${t}"`).join(', ')}. You MUST include one question per missing token whose stem contains the exact token. Re-generate.]`;
      try {
        const r2 = await _tryOnce(retryMsg);
        const r2result = r2.dispatch && r2.dispatch.result;
        const v2 = validateQuestions(r2result);
        if (v2.ok) {
          const q2 = r2result.questions.slice(0, RECOMMEND_MAX_QUESTIONS).map(_sanitizeQuestion).filter(Boolean);
          const missing2 = _findUncitedTokens(loadedTokens, q2);
          if (missing2.length < missing.length) {
            questions = q2;
            missing = missing2;
            ms += r2.ms;
          }
        }
      } catch (_) { /* retry best-effort */ }

      // L4: synthetic stub fallback for tokens still uncited
      if (missing.length > 0) {
        stubbed = [...missing];
        const stubs = missing.map(_stubLoadedTokenQuestion);
        // Replace excess archetype-dim questions to make room for stubs.
        // Total questions capped at RECOMMEND_MAX_QUESTIONS (currently 3).
        // Strategy: keep timeline anchor (cited or not), replace others.
        const timelineIdx = questions.findIndex(q => q && /总时长|timeline/i.test((q.dimension || '') + (q.prompt || '')));
        const keep = timelineIdx >= 0 ? [questions[timelineIdx]] : [];
        const merged = [...stubs, ...keep, ...questions.filter((_, i) => i !== timelineIdx)];
        questions = merged.slice(0, RECOMMEND_MAX_QUESTIONS);
      }
    }

    const confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));

    return {
      ok: true,
      questions,
      confidence,
      _meta: {
        ms,
        provider: dispatch && dispatch.providerId,
        model: dispatch && dispatch.model,
        capability,
        archetype: arch,
        loaded_tokens: loadedTokens,
        retried,
        stubbed,
        defense_level: stubbed.length > 0 ? 'L4_stub' : (retried ? 'L3_retry' : 'L1_first_try'),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `LLM call failed: ${(err && err.message) || String(err)}`,
      _meta: { error: 'llm-failure' },
    };
  }
}

// ── L0 token harvest helper ────────────────────────────────────────────
// Heuristic extraction of LOADED TOKENS from a free-text goal. Catches:
//   (a) 4-char CJK 成语-like phrases (rare in everyday speech, often loaded)
//   (b) Comparison anchors (超越X / 碾压Y / 颠覆Z / 对标W)
//   (c) Hyperbolic claims (完胜X / 震撼Y / 空前 / 绝世)
//   (d) Compound nouns ending in semantic suffix (X发展史 / Y理论 / Z体系)
// Cap to 5 to bound LLM prompt size. Stopword-filtered.
function _extractLoadedTokens(draft) {
  if (!draft || typeof draft !== 'string') return [];

  // Strip leading verb-phrase like "我想成为" / "我要学" / "想写" so they
  // don't bleed into the first chunk.
  // 2026-05-18 fix: prior regex used greedy [一-龥]{1,3} which ate substantive
  // tokens like "成为震" → dropping the 震 of 震古烁今. Use closed enum instead.
  let cleaned = draft
    .replace(/^(我想要|我想|我要|想要|希望|打算|准备|计划|尝试|想)(成为|学|做|写|创作|建立|完成|拥有|追求|打造|塑造)?(一个|一部|一本)?/g, '')
    .trim();

  // Split on 的 / punctuation / whitespace. Keep 与/和/及 INSIDE chunks because
  // "超越冰与火之歌与魔戒" is one compound object — split would shred it.
  const chunks = cleaned
    .split(/[的、，,;；。\.\s]+/)
    .map(c => c.trim())
    .filter(c => c.length >= 2 && c.length <= 24);

  const stripChunkVerb = (c) => c.replace(/^(拥有|含有|具备|具有|带有|有着|怀着|抱着|做|写|创作|建立|完成)/, '');

  const HYPER_PREFIX_RE = /(超越|超过|胜过|碾压|匹敌|对标|完胜|全胜|颠覆|震撼|惊世|绝世|空前)[一-龥《》<>·A-Za-z]+/;
  const IDIOM_4_RE = /^[一-龥]{4}$/;
  const SEMANTIC_SUFFIX_RE = /^[一-龥]{2,8}(史|论|观|主义|体系|理论|脉络|图谱)$/;

  const tokens = new Set();
  for (const raw of chunks) {
    const c = stripChunkVerb(raw);
    if (c.length < 2) continue;
    // 4-char idiom-shape phrase (震古烁今 / 颠覆乾坤 ...)
    if (IDIOM_4_RE.test(c)) { tokens.add(c); continue; }
    // Hyperbolic anchored compound (超越冰与火之歌 / 完胜生物发展史 / 颠覆乾坤)
    const h = c.match(HYPER_PREFIX_RE);
    if (h) { tokens.add(h[0]); continue; }
    // Compound noun ending in semantic suffix (生物发展史 / 现代主义)
    if (SEMANTIC_SUFFIX_RE.test(c)) { tokens.add(c); continue; }
  }

  return Array.from(tokens).slice(0, 5);
}

function _findUncitedTokens(tokens, questions) {
  if (!Array.isArray(tokens) || tokens.length === 0) return [];
  if (!Array.isArray(questions) || questions.length === 0) return tokens.slice();
  const stems = questions.map(q => (q && (q.prompt || '') + (q.rationale || '') + (q.dimension || ''))).join(' \n ');
  return tokens.filter(t => !stems.includes(t));
}

function _stubLoadedTokenQuestion(token) {
  const safeId = token.replace(/[^\w一-龥]/g, '_').slice(0, 12);
  return {
    id: `q_stub_${safeId}`,
    prompt: `"${token}" 你具体指什么?`,
    rationale: '用户原词, 自动 disambiguate 未命中, 由你定义',
    dimension: `用户语义 · ${token}`,
    options: [
      { id: 'a', label: '可量化的 (奖项 / 销量 / 排名)', implies: `${token}=quantitative` },
      { id: 'b', label: '定性的 (文化影响 / 学界口碑)', implies: `${token}=qualitative` },
      { id: 'c', label: '混合, 两边都看重', implies: `${token}=mixed` },
      { id: 'd', label: '其他 / 自己写', implies: 'custom-input' },
    ],
  };
}

/**
 * Crystallize draft + answers into specific verifiable goal + tags.
 *
 * @param {{draftGoal: string, archetype?: string, answers: Array, settings?: object, options?: object}} args
 * @returns {Promise<{ok: boolean, crystallized_goal?: string, tags?: object, confidence?: number, notes?: string, error?: string, _meta?: object}>}
 */
async function crystallizeGoal({ draftGoal, archetype, answers, settings, options = {} } = {}) {
  if (!draftGoal || typeof draftGoal !== 'string' || !draftGoal.trim()) {
    return { ok: false, error: 'draftGoal required' };
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    return { ok: false, error: 'answers array required (≥1)' };
  }

  const arch = (archetype && typeof archetype === 'string') ? archetype.trim() : 'HUMANITIES';

  const userMsg = `DRAFT GOAL:
${draftGoal.trim()}

ARCHETYPE: ${arch}

USER ANSWERS (${answers.length}):
${answers.map((a, i) => `  ${i + 1}. Q: ${a.question || a.prompt || '?'}\n     dimension: ${a.dimension || '?'}\n     chosen: ${a.chosen_label || a.label || '?'}\n     implies: ${a.implies || '?'}`).join('\n')}

Synthesize the crystallized goal JSON per the SCHEMA. Output STRICT JSON only.`;

  const capability = options.capability || 'T3_MID';
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 1000;
  const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.35;

  try {
    const { executeChat } = require('../llm');
    const t0 = Date.now();
    const dispatch = await executeChat(capability, {
      messages: [
        { role: 'system', content: CRYSTALLIZE_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      json: true,
      maxTokens,
      temperature,
      timeoutMs: 45_000,
    });
    const ms = Date.now() - t0;

    const result = dispatch && dispatch.result;
    const v = validateCrystallized(result);
    if (!v.ok) {
      return {
        ok: false,
        error: v.error,
        _meta: { ms, provider: dispatch && dispatch.providerId, validation_error: v.error },
      };
    }

    const crystallized = _sanitizeCrystallized(result);

    return {
      ok: true,
      crystallized_goal: crystallized.crystallized_goal,
      tags: crystallized.tags,
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
      notes: typeof result.notes === 'string' ? result.notes.slice(0, 120) : '',
      _meta: {
        ms,
        provider: dispatch && dispatch.providerId,
        model: dispatch && dispatch.model,
        capability,
        archetype: arch,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `LLM call failed: ${(err && err.message) || String(err)}`,
      _meta: { error: 'llm-failure' },
    };
  }
}

function validateQuestions(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'not an object' };
  if (!Array.isArray(result.questions)) return { ok: false, error: 'questions not array' };
  if (result.questions.length < RECOMMEND_MIN_QUESTIONS) {
    return { ok: false, error: `questions array length ${result.questions.length} < ${RECOMMEND_MIN_QUESTIONS}` };
  }
  for (let i = 0; i < result.questions.length; i++) {
    const q = result.questions[i];
    if (!q || typeof q !== 'object') return { ok: false, error: `questions[${i}]: not object` };
    if (typeof q.id !== 'string' || !q.id.trim()) return { ok: false, error: `questions[${i}].id required` };
    if (typeof q.prompt !== 'string' || !q.prompt.trim()) return { ok: false, error: `questions[${i}].prompt required` };
    if (!Array.isArray(q.options) || q.options.length !== QUESTION_OPTIONS_REQUIRED) {
      return { ok: false, error: `questions[${i}].options: must have exactly ${QUESTION_OPTIONS_REQUIRED} entries` };
    }
    for (let j = 0; j < q.options.length; j++) {
      const o = q.options[j];
      if (!o || typeof o !== 'object') return { ok: false, error: `questions[${i}].options[${j}]: not object` };
      if (typeof o.id !== 'string' || !o.id.trim()) return { ok: false, error: `questions[${i}].options[${j}].id required` };
      if (typeof o.label !== 'string' || !o.label.trim()) return { ok: false, error: `questions[${i}].options[${j}].label required` };
    }
  }
  return { ok: true };
}

function validateCrystallized(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'not an object' };
  if (typeof result.crystallized_goal !== 'string' || !result.crystallized_goal.trim()) {
    return { ok: false, error: 'crystallized_goal required (non-empty string)' };
  }
  if (!result.tags || typeof result.tags !== 'object') return { ok: false, error: 'tags required (object)' };
  const t = result.tags;
  if (typeof t.primary_focus !== 'string' || !t.primary_focus.trim()) return { ok: false, error: 'tags.primary_focus required' };
  if (typeof t.output_form !== 'string') return { ok: false, error: 'tags.output_form required (string, may be empty)' };
  if (typeof t.timeline !== 'string') return { ok: false, error: 'tags.timeline required (string, may be empty)' };
  if (!['career', 'project', 'learning', 'curiosity'].includes(t.scale)) {
    return { ok: false, error: 'tags.scale must be one of career|project|learning|curiosity' };
  }
  if (!['zero', 'hobbyist', 'intermediate', 'advanced'].includes(t.current_level)) {
    return { ok: false, error: 'tags.current_level must be one of zero|hobbyist|intermediate|advanced' };
  }
  if (!['low', 'med', 'high'].includes(t.niche_factor)) {
    return { ok: false, error: 'tags.niche_factor must be one of low|med|high' };
  }
  return { ok: true };
}

function _sanitizeQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  return {
    id: String(q.id || '').trim().slice(0, 60),
    prompt: String(q.prompt || '').trim().slice(0, 200),
    rationale: typeof q.rationale === 'string' ? q.rationale.trim().slice(0, 200) : '',
    dimension: typeof q.dimension === 'string' ? q.dimension.trim().slice(0, 100) : '',
    options: (Array.isArray(q.options) ? q.options : []).slice(0, QUESTION_OPTIONS_REQUIRED).map(o => ({
      id: String(o.id || '').trim().slice(0, 8),
      label: String(o.label || '').trim().slice(0, 80),
      implies: String(o.implies || '').trim().slice(0, 80),
    })),
  };
}

function _sanitizeCrystallized(result) {
  const t = result.tags || {};
  const milestones = Array.isArray(t.milestones)
    ? t.milestones.filter(m => typeof m === 'string' && m.trim()).slice(0, 5).map(m => m.trim().slice(0, 120))
    : [];
  return {
    crystallized_goal: String(result.crystallized_goal || '').trim().slice(0, 400),
    tags: {
      primary_focus: String(t.primary_focus || '').trim().slice(0, 120),
      domain: String(t.domain || '').trim().slice(0, 80),
      scale: t.scale,
      timeline: String(t.timeline || '').trim().slice(0, 60),
      output_form: String(t.output_form || '').trim().slice(0, 120),
      current_level: t.current_level,
      milestones,
      niche_factor: t.niche_factor,
    },
  };
}

// ---- Phase F.1 Gap 1 fix (2026-05-18) -------------------------------------
// Wizard initially hard-coded archetype='HUMANITIES'. Wrong archetype = wrong
// dimensions asked (e.g. TECH user asked "流派师承?" = misfit). Fix: heuristic
// keyword inferrer. Returns best guess; falls back to HUMANITIES (richest
// dimension set for ambiguous goals). Pure regex, no LLM (snappy UX).
//
// Per archetype, ordered priority arrays. First archetype with ≥1 keyword
// hit wins. Ties broken by array order (HUMANITIES is last as fallback).

const ARCHETYPE_KEYWORDS = Object.freeze({
  'LANG-ACQ': [
    // Specific language acquisition signals — match BEFORE TECH (avoid e.g.
    // "学日语" mis-classifying as TECH because 学 contains 学习 stem).
    /\b(?:HSK|JLPT|CEFR|N[12345]|TOEFL|IELTS|GRE|GMAT)\b/i,
    /学(?:习)?(?:日|英|法|德|俄|意|西|韩|阿|葡|越|泰)语/,
    /(?:learn|study)\s+(?:Japanese|Chinese|Spanish|French|German|Russian|Italian|Korean|Arabic|Portuguese)\b/i,
    /(?:口语|听力|阅读|写作)(?:训练|提升|考)/,
    /language\s+(?:acquisition|learning)/i,
  ],
  'DECL-MASS': [
    /考研|考博|考公|律考|CPA|CFA|FRM|教资|医师|护士|司法|执业/,
    /(?:certification|certified|exam(?:ination)?)\s+(?:for|in|of)/i,
    /\b(?:USMLE|MCAT|LSAT|Bar exam|board exam)\b/i,
  ],
  'TECH-CONCEPT': [
    /\b(?:transformer|attention|LLM|GPT|BERT|RAG|embedding|neural\s+network|backprop)\b/i,
    /(?:深度学习|机器学习|神经网络|强化学习|因果推断|贝叶斯|统计学习)/,
    /\b(?:calculus|topology|algebra|measure\s+theory|probability\s+theory)\b/i,
    /(?:数学(?:基础|分析|证明)|拓扑|抽象代数|实分析|测度论)/,
    /\b(?:complexity|algorithm(?:s)?|graph\s+theory|optimization|optimization\s+theory)\b/i,
    /\b(?:quantum|relativity|thermodynamics|statistical\s+mechanics)\b/i,
    /(?:量子(?:力学|场论)|广义相对论|统计力学|热力学)/,
  ],
  'TECH-PROC': [
    /\b(?:Rust|Go(?:lang)?|Python|TypeScript|JavaScript|React|Vue|Svelte|Next\.js|FastAPI|Django|Rails)\b/,
    /\b(?:DevOps|Kubernetes|Docker|CI\/CD|microservices|backend|frontend|full[-\s]?stack|embedded)\b/i,
    /(?:编程|开发|前端|后端|全栈|架构|工程|部署)/,
    /(?:写(?:一个)?(?:游戏|App|应用|工具|脚本|插件|crawler|爬虫))/,
    /\b(?:build|ship|deploy)\s+(?:a|an)\s+(?:app|tool|website|game|service)/i,
  ],
  'MINDSET': [
    /(?:斯多葛|Stoic|stoicism|犬儒|Cynic|伊壁鸠鲁|Epicurean)/i,
    /(?:佛教|Buddhism|Buddhist|禅|Zen|般若|中观|唯识|内观|vipassana)/i,
    /(?:存在主义|existential(?:ism)?|现象学|phenomenology|虚无)/i,
    /(?:冥想|meditation|正念|mindfulness)/i,
    /(?:成为更好的自己|提升心智|训练情绪|哲思训练)/,
  ],
  'HUMANITIES': [
    // Literature / writing / philosophy / arts — broad humanities lane.
    /(?:写作家|当作家|成为(?:.{1,8})?作家|文学奖|诺贝尔文学|小说家|散文家|诗人|剧作家)/,
    /(?:写(?:小说|短篇|长篇|散文|诗|剧本|杂文))/,
    /(?:文学(?:研究|批评|理论|史)|literary\s+(?:criticism|theory|studies))/i,
    /\b(?:novelist|poet|essayist|writer|playwright|literature)\b/i,
    /(?:哲学(?:史|入门|研究)|philosophy)/i,
    /(?:历史(?:学|研究))/,
    /\b(?:musicology|art\s+history|aesthetics)\b/i,
  ],
});

/**
 * Infer archetype from raw draft goal text. Pure keyword regex, no LLM.
 * Returns one of the 6 archetypes; defaults to 'HUMANITIES' when no match
 * (humanities lane has the richest dimension set, so ambiguous goals still
 * yield meaningful wizard questions).
 *
 * @param {string} draftGoal
 * @returns {'LANG-ACQ' | 'DECL-MASS' | 'TECH-CONCEPT' | 'TECH-PROC' | 'MINDSET' | 'HUMANITIES'}
 */
function inferArchetypeFromGoal(draftGoal) {
  if (!draftGoal || typeof draftGoal !== 'string' || !draftGoal.trim()) return 'HUMANITIES';
  const text = draftGoal.trim();
  // Priority order: LANG-ACQ > DECL-MASS > TECH-CONCEPT > TECH-PROC > MINDSET > HUMANITIES.
  // LANG-ACQ first so "学日语" doesn't fall into TECH-PROC via "学" stem;
  // DECL-MASS second so "考研" doesn't fall into MINDSET via 学历 ambiguity.
  const ordered = ['LANG-ACQ', 'DECL-MASS', 'TECH-CONCEPT', 'TECH-PROC', 'MINDSET', 'HUMANITIES'];
  for (const arch of ordered) {
    const patterns = ARCHETYPE_KEYWORDS[arch];
    if (!patterns) continue;
    for (const re of patterns) {
      if (re.test(text)) return arch;
    }
  }
  return 'HUMANITIES';
}

// ---- Phase G.2 (2026-05-18) — 2-stage wizard: followup questions -----------
// After user answers the 3 broad questions, fire this to get 5 INSTANCE-LEVEL
// deep questions. Prompt is heavily anchored to the broad answers — each deep
// Q must be UNANSWERABLE from broad alone, and must cite a broad answer by name
// in either the stem or the options.

const FOLLOWUP_SYSTEM_PROMPT = `You are a HYPHA Goal Crystallizer (DEEP stage). The user already answered 3 BROAD questions disambiguating their draft goal at the lineage / form / timeline level. Your job: generate 5 INSTANCE-LEVEL deep questions that drill INTO the specific cut they picked.

INPUT:
  draft_goal: original free-text
  archetype: HUMANITIES | TECH-CONCEPT | TECH-PROC | LANG-ACQ | DECL-MASS | MINDSET
  broad_answers: [{question, chosen_label, implies, dimension}, ...] — 3 entries

OUTPUT — STRICT JSON, no prose, no markdown fences:

{
  "questions": [
    {
      "id": "q_deep_<short_slug>",
      "prompt": "<≤40 字 CN OR ≤100 char EN — MUST reference at least 1 broad answer by name, OR present options that ONLY make sense given a broad pick>",
      "rationale": "<≤40 字 why this drills deeper than the broad layer>",
      "dimension": "<sub-dimension within the broad pick, e.g. '川端式静默 · 时期'>",
      "options": [
        {"id": "a", "label": "<NAMED instance, ≤30 字, references a specific work / level / year / output>", "implies": "<≤25 字 tag>"},
        {"id": "b", "label": "...", "implies": "..."},
        {"id": "c", "label": "...", "implies": "..."},
        {"id": "d", "label": "其他 / 自己写", "implies": "custom-input"}
      ]
    }
  ],
  "confidence": <0..1>
}

CONSTRAINTS:
- EXACTLY 5 deep questions. NO more, NO fewer.
- EACH question MUST have 4 options. Option (d) is ALWAYS "其他 / 自己写" with implies="custom-input".
- Each deep question MUST be UNANSWERABLE from broad answers alone. If a Q could have been asked at the broad stage, REJECT it and write a deeper one.

GOAL VOCABULARY DEEP-DIVE RULE (hard — user 2026-05-18 lock):
- If broad_answers contains a loaded-token Q (e.g. "震古烁今" was Q1), deep questions MUST drill further into the user's chosen interpretation.
  Example: broad Q1 "震古烁今 你指哪个层面?" → user picked "A) 文学奖项 (诺贝尔/茅盾)".
  Deep Q4 must then be: "诺贝尔 vs 茅盾 你更想 prioritise 哪一边? 时间窗多长?" with NAMED options like "5y 内冲诺贝尔提名" / "10y 内茅盾文学奖" / "并行双轨".
- If broad pushed timeline anchor to deep (because goal had ≥3 loaded tokens), one deep Q MUST be the timeline anchor (稳/赶/更稳/自写).

TIMELINE SUB-ANCHOR RULE (hard — user 2026-05-18 lock):
- If a deep question asks about SUB-MILESTONES within the total timeline (e.g. broad answer was "稳 5y" → deep Q "3 年中段你想到哪步?"), the 4 options MUST still follow the稳/赶/更稳 anchor pattern when the unit is duration. Use derived sub-anchors relative to user's chosen total timeline.
- ! HYPHA invent the duration. Use user's total timeline (cited in broad_answers) to compute the sub-anchor.
- Example (user total=5y, deep mid-milestone Q):
  prompt: "3y 中段?"
  A) "稳 · 期刊 1 篇"   implies "mid-3y=publication"
  B) "赶 · 签约出版社"  implies "mid-3y=publisher"
  C) "更稳 · 全完整稿"  implies "mid-3y=full-draft"
  D) "其他 / 自己写"    implies "custom-input"

CONCISE LABEL RULE (hard — user 2026-05-18 "表述更简洁"):
- Each option label ≤ 12 字 (sweet 6-10). Single line. ! cram 2 outcomes.
- Stem ≤ 14 字.
- Time prefix encouraged: "5y · X" / "3mo · X" — time anchor on left.
- Cite NAMED instances in options — specific works / authors / levels / years / outputs. NOT abstract categories.
  Bad: A) 现代主义 B) 后现代 C) 现实主义
  Good: A) 川端早期 (山之音) B) 川端中期 (千只鹤) C) 川端后期 (古都)
- Stem MUST reference at least 1 broad answer by name OR present options that only make sense in light of a broad pick.
  Example: broad answer "川端式静默" → deep Q "你想学川端的哪一时期?" (good — references broad pick)
- 5 deep questions MUST target 5 DIFFERENT sub-dimensions. ! same sub-dimension asked twice with different phrasing.
- ! emoji. ! 感叹号. ! "great choice!". ! "we will help you".
- ! generic open-ended Q. ! "Anything else?". ! "What's your favorite?".

POSITIVE FEW-SHOT (broad: lineage=川端式静默, output_form=短篇, timeline=5年):
{
  "questions": [
    {
      "id": "q_deep_kawabata_period",
      "prompt": "你想学川端的哪一时期?",
      "dimension": "川端式静默 · 时期",
      "options": [
        {"id":"a","label":"早期 (山之音 / 雪国)","implies":"川端早期-自然主义"},
        {"id":"b","label":"中期 (千只鹤 / 名人)","implies":"川端中期-传统美"},
        {"id":"c","label":"后期 (古都 / 美的存在)","implies":"川端后期-空寂"},
        {"id":"d","label":"其他 / 自己写","implies":"custom-input"}
      ]
    },
    {
      "id": "q_deep_short_length",
      "prompt": "5 年内你的短篇产出量?",
      "dimension": "短篇 · 量级",
      "options": [
        {"id":"a","label":"6-8 篇 (每年 1-2 篇精雕)","implies":"短篇-精雕路径"},
        {"id":"b","label":"15-20 篇 (期刊投稿节奏)","implies":"短篇-期刊路径"},
        {"id":"c","label":"40+ 篇 (大量练手再筛)","implies":"短篇-训练量路径"},
        {"id":"d","label":"其他 / 自己写","implies":"custom-input"}
      ]
    }
  ]
}

Return STRICT JSON only.`;

/**
 * Generate 5 instance-level deep follow-up questions after broad answered.
 *
 * @param {{draftGoal: string, archetype?: string, broadAnswers: Array, settings?: object, options?: object}} args
 * @returns {Promise<{ok: boolean, questions?: Array, confidence?: number, error?: string, _meta?: object}>}
 */
async function generateFollowupQuestions({ draftGoal, archetype, broadAnswers, settings, options = {} } = {}) {
  if (!draftGoal || typeof draftGoal !== 'string' || !draftGoal.trim()) {
    return { ok: false, error: 'draftGoal required' };
  }
  if (!Array.isArray(broadAnswers) || broadAnswers.length < 1) {
    return { ok: false, error: 'broadAnswers array required (≥1)' };
  }

  const arch = (archetype && typeof archetype === 'string') ? archetype.trim() : 'HUMANITIES';

  const userMsg = `DRAFT GOAL:
${draftGoal.trim()}

ARCHETYPE: ${arch}

BROAD ANSWERS (${broadAnswers.length}):
${broadAnswers.map((a, i) => `  ${i + 1}. Q: ${a.question || a.prompt || '?'}\n     dimension: ${a.dimension || '?'}\n     chosen: ${a.chosen_label || a.label || '?'}\n     implies: ${a.implies || '?'}`).join('\n')}

Generate 5 INSTANCE-LEVEL deep follow-up questions per the SCHEMA. Each MUST reference a broad answer + drill into specifics not askable at the broad layer.`;

  const capability = options.capability || 'T3_MID';
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : 1800;
  const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.4;

  try {
    const { executeChat } = require('../llm');
    const t0 = Date.now();
    const dispatch = await executeChat(capability, {
      messages: [
        { role: 'system', content: FOLLOWUP_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      json: true,
      maxTokens,
      temperature,
      timeoutMs: 45_000,
    });
    const ms = Date.now() - t0;

    const result = dispatch && dispatch.result;
    const v = validateFollowup(result);
    if (!v.ok) {
      return {
        ok: false,
        error: v.error,
        _meta: { ms, provider: dispatch && dispatch.providerId, validation_error: v.error, stage: 'deep' },
      };
    }

    const questions = result.questions
      .slice(0, DEEP_QUESTIONS_COUNT)
      .map(_sanitizeQuestion)
      .filter(Boolean);
    const confidence = Math.max(0, Math.min(1, Number(result.confidence) || 0));

    return {
      ok: true,
      questions,
      confidence,
      _meta: {
        ms,
        provider: dispatch && dispatch.providerId,
        model: dispatch && dispatch.model,
        capability,
        archetype: arch,
        stage: 'deep',
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: `LLM call failed: ${(err && err.message) || String(err)}`,
      _meta: { error: 'llm-failure', stage: 'deep' },
    };
  }
}

function validateFollowup(result) {
  if (!result || typeof result !== 'object') return { ok: false, error: 'not an object' };
  if (!Array.isArray(result.questions)) return { ok: false, error: 'questions not array' };
  if (result.questions.length < DEEP_QUESTIONS_COUNT) {
    return { ok: false, error: `followup questions length ${result.questions.length} < ${DEEP_QUESTIONS_COUNT}` };
  }
  for (let i = 0; i < result.questions.length; i++) {
    const q = result.questions[i];
    if (!q || typeof q !== 'object') return { ok: false, error: `questions[${i}]: not object` };
    if (typeof q.id !== 'string' || !q.id.trim()) return { ok: false, error: `questions[${i}].id required` };
    if (typeof q.prompt !== 'string' || !q.prompt.trim()) return { ok: false, error: `questions[${i}].prompt required` };
    if (!Array.isArray(q.options) || q.options.length !== QUESTION_OPTIONS_REQUIRED) {
      return { ok: false, error: `questions[${i}].options: must have exactly ${QUESTION_OPTIONS_REQUIRED} entries` };
    }
    for (let j = 0; j < q.options.length; j++) {
      const o = q.options[j];
      if (!o || typeof o !== 'object') return { ok: false, error: `questions[${i}].options[${j}]: not object` };
      if (typeof o.id !== 'string' || !o.id.trim()) return { ok: false, error: `questions[${i}].options[${j}].id required` };
      if (typeof o.label !== 'string' || !o.label.trim()) return { ok: false, error: `questions[${i}].options[${j}].label required` };
    }
  }
  return { ok: true };
}

module.exports = {
  generateCrystallizerQuestions,
  generateFollowupQuestions,
  crystallizeGoal,
  validateQuestions,
  validateFollowup,
  validateCrystallized,
  inferArchetypeFromGoal,
  _internals: {
    ARCHETYPE_DIMENSIONS,
    ARCHETYPE_KEYWORDS,
    RECOMMEND_MAX_QUESTIONS,
    RECOMMEND_MIN_QUESTIONS,
    BROAD_QUESTIONS_COUNT,
    DEEP_QUESTIONS_COUNT,
    QUESTION_OPTIONS_REQUIRED,
    _sanitizeQuestion,
    _sanitizeCrystallized,
    _extractLoadedTokens,
    _findUncitedTokens,
    _stubLoadedTokenQuestion,
  },
};
