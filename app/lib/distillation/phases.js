'use strict';

// HYPHA · Longform Spark Distillation — 7-phase pipeline (BLUEPRINT §5.1).
//
// Each book is distilled exactly once (idempotent cache at
// vault/.distillation/<book-id>/phase-<n>.json). After distillation, a
// downstream Book Router (book-router.js) serves chapter Kernel + Spark
// Index slices on demand — the raw text is never re-read in full for
// follow-on queries.
//
// Phase contract (every phase):
//   input  = { book, prior, options }      (book + prior-phase outputs)
//   output = { ok, phase_n, ...payload }   (cacheable JSON)
//
// All LLM calls are class T6_STRONG (lesson-plan grade reasoning) and
// gated behind invokeLLM() — currently a mock that synthesizes structured
// JSON from chunk headings. Real LLM wiring is one line per phase
// (TODO marker in invokeLLM).
//
// Phase 1 — Build map        (toc / author core question / overall structure)
// Phase 2 — Chapter breakdown (per-chapter judgments + spark candidates)
// Phase 3 — Cross-chapter merge (compress duplicates, lift high-value sparks)
// Phase 4 — Frontierize       (project sparks onto AI / agent / education /
//                              product / entrepreneurship / social-structure axes)
// Phase 5 — Reverse critique  (author over/underestimates, outdated views,
//                              what AI era can rewrite)
// Phase 6 — Personalize       (against user Goal Contract — what hits, what
//                              user disagrees with, what is actionable)
// Phase 7 — Book Spark Pack   (15-field publishable artefact; gates Commons
//                              export via W6.5)

const path = require('node:path');
const llm = require('../llm');

// ── LLM gate ───────────────────────────────────────────────────────────────
//
// Wired to T6_STRONG (lesson-plan grade) via executeChat router. Each phase
// builds its own [system, user] message pair (see _buildMessagesForPhase).
// JSON-mode is forced; provider's json:true path returns already-parsed object,
// so callers receive the same shape the previous mock returned.
//
// Test/CI escape hatch: env `HYPHA_DISTILL_MOCK=1` short-circuits to the
// deterministic mock (used by the pipeline / cache / resume / pack-assembly
// tests so they don't spend T6 tokens on every run).
//
// Failure policy: any LLM error PROPAGATES (no silent mock fallback). The
// distill-runner catches the throw, writes it to status.json + events.jsonl,
// and the UI's 7-phase progress screen renders the error. This is deliberate
// per anti-slop: silently degrading to placeholder strings is the bug we are
// fixing in this change.

const MAX_CHAPTER_CHARS = 12000;

// Retry on transient network/rate-limit failures. Router already rotates
// across 3 providers within one call; outer retry is needed because a
// short network blip + rate-limit window can degrade all 3 simultaneously
// (long phase 2 loops are most exposed).
const RETRIABLE_RE = /connection|timeout|All providers|429|5\d\d|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|aborted/i;

async function invokeLLM(phase, payload) {
  if (process.env.HYPHA_DISTILL_MOCK === '1') {
    return _mockPhaseOutput(phase, payload);
  }
  if (phase === 7) {
    // Phase 7 is pure assembly from prior outputs — no LLM call.
    return null;
  }
  const messages = _buildMessagesForPhase(phase, payload);
  if (!messages) {
    throw new Error('distill: no prompt builder for phase ' + phase);
  }
  // Per-phase output budgets. v0.2 schema has much heavier outputs:
  //   p3 (book_model + 10 themes + 25 sparks × 4 fields) ≈ 5K tokens
  //   p4 (25 × ai_era 200 字 ≈ 3K) / p6 (25 × transfer+experiment + 5 props ≈ 4K)
  // 2500 truncates JSON mid-stream → catastrophic. Bump to fit + headroom.
  const PHASE_MAX_TOKENS = { 1: 1500, 2: 3000, 3: 7000, 4: 4000, 5: 2500, 6: 5500 };
  const maxRetries = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const r = await llm.executeChat('T6_STRONG', {
        messages,
        json: true,
        temperature: 0.5,
        maxTokens: PHASE_MAX_TOKENS[phase] || 3000,
      });
      // executeChat with json:true returns r.result already parsed. Defensive
      // re-parse in case a provider regression sneaks raw string through.
      let obj = r && r.result;
      if (typeof obj === 'string') {
        try { obj = JSON.parse(obj); }
        catch (_) {
          const m = obj.match(/\{[\s\S]*\}/);
          if (!m) throw new Error(`distill phase ${phase}: LLM returned non-JSON content`);
          obj = JSON.parse(m[0]);
        }
      }
      if (!obj || typeof obj !== 'object') {
        throw new Error(`distill phase ${phase}: LLM returned empty/non-object payload`);
      }
      return obj;
    } catch (e) {
      lastErr = e;
      const msg = (e && e.message) || '';
      if (attempt === maxRetries || !RETRIABLE_RE.test(msg)) throw e;
      const backoffMs = 2000 * attempt;
      await new Promise((res) => setTimeout(res, backoffMs));
    }
  }
  throw lastErr;
}

// ── Per-phase prompt builders ──────────────────────────────────────────────

const REGISTER_GUARD = [
  '语言: 与原书一致 (中文书用中文, 英文书用英文).',
  '不用 AI / LLM / model / prompt / embedding / agent / vector / RAG / fine-tune 等词; 用领域术语 (例: 不说 "LLM 推理", 说 "概率语言模型推理"; 不说 "agent", 说 "智能代理" 或具体角色名).',
  '禁中文 AI 流量词 (这一刀 / 闭环 / 拉满 / 王炸 / 杀疯了 / 干货 / 真香 / yyds / 绝绝子 / 这一刻).',
  '禁 SaaS 营销腔 ("解锁" / "level up" / "supercharge" / "boost").',
  '具体, 引述章节文本的实例; 不要套话 ("作者提出非凡论点" / "论证由例及理" 这类模板字串绝对禁止).',
  '输出 = 纯 JSON, 无 prose 包裹, 无 markdown 围栏.',
].join('\n');

function _buildMessagesForPhase(phase, payload) {
  // Archetype dispatch (additive, 2026-05-19): if caller passes
  // `payload.archetype === 'literary'` AND there is a literary-specific
  // builder for this phase, use it. Otherwise default to the original
  // (claim-extraction) prompt. NEVER mutates behavior for non-literary books.
  const arch = payload && payload.archetype;
  if (arch === 'literary') {
    if (phase === 4) return _phase4MessagesLiterary(payload);
    if (phase === 6) return _phase6MessagesLiterary(payload);
  }
  switch (phase) {
    case 1: return _phase1Messages(payload);
    case 2: return _phase2Messages(payload);
    case 3: return _phase3Messages(payload);
    case 4: return _phase4Messages(payload);
    case 5: return _phase5Messages(payload);
    case 6: return _phase6Messages(payload);
    default: return null;
  }
}

function _phase1Messages(payload) {
  const book = (payload && payload.book) || {};
  const toc = (payload && payload.toc) || [];
  const tocLines = toc.map(c => `[${c.idx}] ${c.title || '(untitled)'}${c.type ? ' · ' + c.type : ''}`).join('\n');
  const sys = `你是 7 阶段长文蒸馏的 Phase 1 (建图). 任务: 从书的元数据和章节目录, 推断作者核心问题 + 全书结构 + 重点章节标注.\n\n${REGISTER_GUARD}\n\nJSON schema (严格按此):\n{\n  "author_core_question": "作者意图回答的那一个核心问题 (1 句).",\n  "overall_structure": "全书论证结构概述 (3-5 句, 不是目录复述, 是论证骨架).",\n  "key_chapters": [\n    { "idx": <章节 idx>, "title": "<章节标题>", "weight": "high|mid" }\n  ]\n}\n\nkey_chapters: 选 5-12 章; weight=high 表示承载核心论点, weight=mid 表示重要支撑.`;
  const usr = `书名: ${book.title || '(unknown)'}\n作者: ${book.author || 'Unknown'}\n语种: ${book.language || 'unknown'}\n章节数: ${toc.length}\n\n章节目录:\n${tocLines}`;
  return [
    { role: 'system', content: sys },
    { role: 'user',   content: usr },
  ];
}

function _phase2Messages(payload) {
  const book = (payload && payload.book) || {};
  const ch = (payload && payload.chapter) || { idx: 0, title: 'Section', text: '' };
  let chapterText = String(ch.text || '');
  let truncated = false;
  if (chapterText.length > MAX_CHAPTER_CHARS) {
    chapterText = chapterText.slice(0, MAX_CHAPTER_CHARS);
    truncated = true;
  }
  const sys = `你是 Phase 2 (单章拆解). 对一章原文, 提炼: 本章核心问题 / 核心判断 / 论证链 / 隐藏前提 / Spark 候选.\n\n${REGISTER_GUARD}\n\nJSON schema:\n{\n  "core_question": "本章试图回答的具体问题 (1 句, 不是章节标题改写).",\n  "core_judgments": ["作者在本章作出的非显然判断 (2-4 条, 每条 ≤ 40 字, 引用章节关键词)"],\n  "argument_chain": [\n    { "step": "P1", "text": "前提一 (引述原文)" },\n    { "step": "P2", "text": "前提二" },\n    { "step": "C",  "text": "结论 (作者从前提如何到达)" }\n  ],\n  "hidden_premises": ["作者未明说但论证依赖的前提 (1-3 条)"],\n  "spark_candidates": [\n    { "kind": "concept|mechanism|method", "text": "具体可迁移的判断/机制/方法 (1-2 句)", "strength": <0-1 浮点> }\n  ]\n}\n\nspark_candidates: 2-5 条; strength 反映"可被独立引用并出本章仍站得住"的强度.\n如果章节文本为空或太短无法判断, 仍输出合法 JSON, 各数组用 [] 或单条 "(本章文本不足以提炼)".`;
  const usr = `书名: ${book.title || '(unknown)'}\n作者: ${book.author || 'Unknown'}\n章节 idx: ${ch.idx}\n章节标题: ${ch.title || '(untitled)'}\n${truncated ? `(章节文本已截断至前 ${MAX_CHAPTER_CHARS} 字)\n` : ''}\n章节文本:\n${chapterText || '(空)'}`;
  return [
    { role: 'system', content: sys },
    { role: 'user',   content: usr },
  ];
}

function _phase3Messages(payload) {
  const chapters = (payload && payload.chapter_results) || [];
  // Compress phase 2 chapter outputs for input. Skip chapters that phase 2
  // skipped (text too short) and trim judgments + spark_candidates so the
  // prompt stays under ~30K chars for 130-chapter books.
  const compact = chapters
    .filter(c => !c.skipped && (c.core_judgments?.length > 0 || c.spark_candidates?.length > 0))
    .map(c => ({
      idx: c.chapter_idx,
      title: c.chapter_title,
      core_question: c.core_question,
      judgments: (c.core_judgments || []).slice(0, 3),
      sparks: (c.spark_candidates || []).slice(0, 3).map(s => ({ kind: s.kind, text: s.text })),
    }));
  const sys = `你是 7 阶段长文蒸馏的 Phase 3 (跨章合成 · 母题与深 Spark).
目标: 把 Phase 2 输出的章节级 raw 信号, 浓缩为"全书底层公式 + 母题地图 + 概念级深 Spark".

参考样例 (《黑客与画家》深度蒸馏): 母题如 "局部游戏不是世界本身" / "编程是创作 不是流水线工程" / "异端不是噪声 而是未来入口"; 每母题下 2-4 个 Spark; 每 Spark = 一个可独立引用的概念级判断, 跨多章浓缩, 不依附单一章节.

${REGISTER_GUARD}

任务:
1. book_model — 全书底层公式 (1 段, 4-8 句). 不是题材描述 ("本书讨论 X"), 而是一句"本书在用 X 的角度看世界". 必须有结构 (e.g. "X = A + B + C + ...") 或一个尖锐的判断 ("Y 不属于 A, 属于 B").
2. themes — 8-12 个母题. 每个母题 = 一个全书反复触及的观察角度. 母题名必须是判断式 ("环境错配不是失败"), 不是范畴式 ("关于环境的思考"). 母题之间 mutually exclusive, 不重叠.
3. 每个母题下 2-4 个 Spark, 每 Spark 4 字段:
   - name (2-8 字): 概念锚, 锋利, 念出来能击中. 例: "环境错配不是失败" / "规格在创作中生长" / "工具应允许重画". 禁: "X 的重要性" / "关于 Y 的思考" / "X 与 Y 的关系" 这种水名.
   - hook (1-2 句): 原文思想钩子. paraphrase 作者原话, 指出来源章节关键词. 不必有章节号, 但要能让读者"听见作者在说什么".
   - mechanism (4-7 步): 深层机制链. 每步 1 短句 (≤30 字), 步骤间因果可溯. 禁: "现象 A → 因此 A" 这种 0 增量步; 禁套话.
   - counterintuitive (1 句, ≤40 字): 反常识锋刃. 必须真反常识. 禁 truism ("我们要重视 X"). 锋利对仗最佳 ("X 看起来 A, 实际是 B" / "越追求 X, 越得不到 X").

JSON schema (严格):
{
  "book_model": "全书底层公式 (1 段 4-8 句)",
  "themes": [
    {
      "id": "theme-01",
      "name": "母题名 (判断式, 5-15 字)",
      "description": "母题在书中的角色 (1-2 句)",
      "sparks": [
        {
          "id": "spark-01",
          "name": "概念锚 (2-8 字)",
          "hook": "原文思想钩子 (1-2 句)",
          "mechanism": ["机制 step 1", "step 2", "step 3", "step 4-7"],
          "counterintuitive": "反常识锋刃 (1 句)"
        }
      ]
    }
  ]
}

数量目标: themes 8-12, sparks 总 20-30 (短书 ~20, 长书 ~30 上限). 每 theme 2-4 sparks (1 太少, 5+ 太散).

ID 约定: theme-01..theme-12 顺序编号; spark-01..spark-NN 跨 theme 连续编号 (theme-01 下 spark-01/02; theme-02 下 spark-03/04/05; 不允许重复或跳号).

锋利度自检 (输出前你自己审一遍):
- book_model 是否够"底层"? 不能"本书讲 X"; 必须"本书用 X 的角度看世界".
- 每个 Spark name 念出来能击中? 不能"X 的重要性" 这种水名.
- 每个 mechanism 真有因果递进? 不能 0 增量步.
- counterintuitive 真反常识? 不能 truism.

不达标的 Spark 宁可不出, 不要凑数. 输出 = 纯 JSON, 无 markdown 围栏.`;
  const usr = `章节 raw 信号 (Phase 2 输出):\n${JSON.stringify(compact, null, 2)}`;
  return [
    { role: 'system', content: sys },
    { role: 'user',   content: usr },
  ];
}

function _phase4Messages(payload) {
  const themes = (payload && payload.themes) || [];
  // Pass full sparks (need hook + mechanism + counterintuitive for context)
  const sparksFlat = themes.flatMap(t => (t.sparks || []).map(s => ({
    theme: t.name,
    id: s.id,
    name: s.name,
    hook: s.hook,
    mechanism: s.mechanism,
    counterintuitive: s.counterintuitive,
  })));
  const sys = `你是 Phase 4 (AI 时代反蒸馏).
对 Phase 3 输出的每个 Spark, 加 1 字段: ai_era — 这个 Spark 在 AI 时代的反蒸馏.

要求:
- 不是 "用 AI 实现 X" (太浅).
- 是 "X 在 AI 时代揭示了哪些以前看不见的东西 / 把这个判断重新校准到当代具体落地".
- 1-2 段 (合计 100-250 字, 不要太短).
- 必须给出具体的 AI 时代 referent. 例: "AI 让创造财富的边际成本下降, 但需求验证仍是瓶颈" (具体), 不是 "AI 改变一切" (空).
- 可以分层 (低/中/高 阶 AI 使用者; 或浅/深 维度).

${REGISTER_GUARD}
注意: 字段名就是 ai_era, 这里允许讨论 AI / 智能代理 主题本身, 但仍用领域术语而非俗称.

JSON schema:
{
  "spark_ai_era": [
    { "id": "spark-01", "ai_era": "AI 时代反蒸馏 (1-2 段)" }
  ]
}

必须覆盖所有 spark id (不能漏任何一个). 输出 = 纯 JSON.`;
  const usr = `Phase 3 sparks (含上下文):\n${JSON.stringify(sparksFlat, null, 2)}`;
  return [
    { role: 'system', content: sys },
    { role: 'user',   content: usr },
  ];
}

function _phase5Messages(payload) {
  const phase3 = (payload && payload.phase3) || {};
  const sys = `你是 Phase 5 (反向批判). 站在 当代 / 跨学科 / 后见之明 立场审视作者: 哪些观点高估, 哪些低估, 哪些过时, 哪些在 AI 时代可重写.\n\n${REGISTER_GUARD}\n\nJSON schema:\n{\n  "author_overestimated": ["作者高估的东西 (1-3 条, 每条 1 句, 给出具体来由)"],\n  "author_underestimated": ["作者低估的东西 (1-3 条)"],\n  "outdated_views": ["在当代视角下过时的观点 (1-3 条, 说清楚为什么过时)"],\n  "rewriteable_for_ai_era": ["可在当代用智能代理 / 工具 / 计算重写的判断 (1-3 条, 每条说清楚重写方式)"]\n}`;
  const slim3 = { core_questions: phase3.core_questions || [], core_mechanisms: phase3.core_mechanisms || [], compressed_views: phase3.compressed_views || [], high_value_sparks: phase3.high_value_sparks || [] };
  const usr = `Phase 3 (跨章合并) 输出:\n${JSON.stringify(slim3, null, 2)}`;
  return [
    { role: 'system', content: sys },
    { role: 'user',   content: usr },
  ];
}

function _phase6Messages(payload) {
  const themes = (payload && payload.themes) || [];
  const sparkAiEra = (payload && payload.spark_ai_era) || [];
  const aiEraById = {};
  for (const r of sparkAiEra) aiEraById[r.id] = r.ai_era || '';
  // Pass enriched sparks (name + hook + mechanism + counterintuitive + ai_era).
  const enriched = themes.flatMap(t => (t.sparks || []).map(s => ({
    theme: t.name,
    id: s.id,
    name: s.name,
    hook: s.hook,
    mechanism: s.mechanism,
    counterintuitive: s.counterintuitive,
    ai_era: aiEraById[s.id] || '',
  })));
  const goal = (payload && payload.goal) || null;
  const goalStmt = (goal && goal.statement)
    || '读者画像 (未显式提供 Goal Contract): AI 时代的个体创造者, 想用 AI 生产可出售资产, 同时构建认知系统. 关心: 现金流 / 工具杠杆 / 作品资产 / 跳出旧评分系统.';
  const sys = `你是 Phase 6 (个性化迁移 · 落地化).
对 Phase 3+4 的每个 Spark, 加 2 字段:
- transfer: 对 读者目标 / HYPHA 产品 / 用户当前项目 的具体迁移. 1-2 段 (合计 80-200 字).
  禁水: 不要 "可以用在 X 上". 要 "可以在 HYPHA 的 lesson-opener 上用 Y 机制把 Z 替换为 W" 这种具体.
  最佳形态 = "在 [具体表面] 上, [具体动作], 因为 [本 Spark 的机制揭示了什么]".
- experiment: 可执行实验. 1 段 (60-150 字, 命令式), 24-48 小时内能动手做的, 含输入 + 输出 + 判定标准 (3 要素都有).
  例形态: "做 [X]: 输入 Y, 步骤 Z1/Z2/Z3, 目标 = 拿到 N 个 [可观测信号]". 不要 "试试 X" 这种水.

另外 — 在 spark 级 transfer/experiment 之上, 给 3-5 条 strategic_propositions:
- 把全书 N 个 spark 浓缩成对读者的"最终战略命题".
- 必须锋利 + 命令式. 最佳对仗 = "停止 [X], 开始 [Y]".
- 不重复 spark 内容, 是更高一层的提取.

${REGISTER_GUARD}

JSON schema:
{
  "spark_personalize": [
    { "id": "spark-01", "transfer": "迁移 1-2 段", "experiment": "可执行实验 1 段" }
  ],
  "strategic_propositions": ["命题 1", "命题 2", "命题 3", "命题 4", "命题 5"]
}

必须覆盖所有 spark id. 输出 = 纯 JSON.`;
  const usr = `读者 Goal Contract:\n${goalStmt}\n\n所有 Sparks (Phase 3 + 4 合并):\n${JSON.stringify(enriched, null, 2)}`;
  return [
    { role: 'system', content: sys },
    { role: 'user',   content: usr },
  ];
}

// ── Literary archetype builders (Phase 4 + 6 specialization) ───────────────
//
// Why literary books need a different prompt: Phase 4 (default) demands
// "AI 时代反蒸馏 + 具体 referent + HYPHA lesson-opener" — for a Dostoyevsky
// chapter this produces category-error gibberish. Literature carries
// THEMES + MOTIFS + NARRATIVE_ARC + KEY_PASSAGES, NOT falsifiable claims with
// AI-era落地化. Phase 6 (default) demands a 24-48h "可执行实验 + 输入 + 输出 +
// 判定标准" — pointless for poetry.
//
// Literary Phase 4 surfaces MOTIFS (recurring figures the author returns to)
// and NARRATIVE_ARC (the shape of how the book travels emotionally / morally),
// per spark. Literary Phase 6 surfaces RESONANCE (where the spark lands in
// the reader's life, NOT a workshop drill) and KEY_PASSAGE (a quoted line or
// referenced scene worth carrying forward, NOT an experiment plan).
//
// Schema deltas (vs default):
//   Phase 4 default returns spark_ai_era[];     literary returns spark_literary[]
//   Phase 6 default returns spark_personalize[]; literary returns spark_literary_transfer[]
// phase7 packager already handles missing fields gracefully (defaults to '').

function _phase4MessagesLiterary(payload) {
  const themes = (payload && payload.themes) || [];
  const sparksFlat = themes.flatMap(t => (t.sparks || []).map(s => ({
    theme: t.name,
    id: s.id,
    name: s.name,
    hook: s.hook,
    mechanism: s.mechanism,
    counterintuitive: s.counterintuitive,
  })));
  const sys = `你是 Phase 4 (文学反蒸馏 · 文学作品专用).
对 Phase 3 输出的每个 Spark, 加 3 字段: motif / narrative_arc / key_passage.

要求:
- motif (1-2 段, 80-180 字): 这个 Spark 在书中以哪种"反复回归的意象 / 角色姿态 / 场景结构"出现?
  禁: "作者反复使用 X". 要: 命名意象 + 指出其在哪几章变形 + 它的累积效应.
  例 (《地下室手记》): "瘙痒 — 主人公反复以指甲掐自己, 是 self-loathing 的肉身手势. 第 2 章他想象用伤口换尊严; 第 6 章他真的让露莎走掉之后再补这一动作 — motif 从想象走入实操."
- narrative_arc (1 段, 60-150 字): 围绕这个 Spark, 全书走了一条什么形状的路?
  禁: "本书逐步展开 X". 要: 命名形状 (回环 / 下沉 / 螺旋上升 / 失重 / 镜像反转) + 关键转折 + 落点.
- key_passage (1-3 句, 直接引述或紧贴原文): 全书最能体现这个 Spark 的一段或一句.
  禁: 编造原文. 如果原始 hook / mechanism 没给出具体句子, 输出"(原文未在 hook 中明示, 留 placeholder 待编辑补)" 而不是发明.

${REGISTER_GUARD}
注: 文学 Spark 不必"对当代有用", 也允许 motif / arc 本身就是终点. 禁追问"如何应用".

JSON schema:
{
  "spark_literary": [
    {
      "id": "spark-01",
      "motif": "1-2 段, 80-180 字",
      "narrative_arc": "1 段, 60-150 字",
      "key_passage": "1-3 句, 直接引述或贴近原文"
    }
  ]
}

必须覆盖所有 spark id. 输出 = 纯 JSON.`;
  const usr = `Phase 3 sparks (含上下文):\n${JSON.stringify(sparksFlat, null, 2)}`;
  return [
    { role: 'system', content: sys },
    { role: 'user',   content: usr },
  ];
}

function _phase6MessagesLiterary(payload) {
  const themes = (payload && payload.themes) || [];
  const sparkLiterary = (payload && payload.spark_literary) || [];
  const literaryById = {};
  for (const r of sparkLiterary) literaryById[r.id] = r;
  const enriched = themes.flatMap(t => (t.sparks || []).map(s => ({
    theme: t.name,
    id: s.id,
    name: s.name,
    hook: s.hook,
    mechanism: s.mechanism,
    counterintuitive: s.counterintuitive,
    motif: (literaryById[s.id] && literaryById[s.id].motif) || '',
    narrative_arc: (literaryById[s.id] && literaryById[s.id].narrative_arc) || '',
    key_passage: (literaryById[s.id] && literaryById[s.id].key_passage) || '',
  })));
  const goal = (payload && payload.goal) || null;
  const goalStmt = (goal && goal.statement)
    || '读者画像 (未显式提供 Goal Contract): 用文学作品打磨自我感受力 / 写作语感 / 与人物共处的能力. 不寻求"知识吸收", 寻求"被作品长久陪伴".';
  const sys = `你是 Phase 6 (文学共振 · 文学作品专用).
对 Phase 3+4 的每个 Spark, 加 2 字段: resonance + reading_invitation.

- resonance (1-2 段, 80-180 字): 这个 Spark 落在 读者 身上的哪个角落?
  禁: "可以应用在 X 上". 文学不是工具.
  要: "在 [具体生活场景] 中, [读者] 会想起这个 motif / 这条 arc, 因为它说出了 [读者自己模糊已久但说不出的东西]".
  例形态: "在你某次为别人妥协又恨自己的夜里, 这条瘙痒 motif 会回来 — 它把 self-loathing 从抽象情绪变成肉身可指认的姿态."

- reading_invitation (1 段, 60-150 字, 命令式但温和): 一个"重读 / 慢读 / 旁注"的具体动作.
  禁: "做实验 / 输出 N 个 / 判定标准". 文学不是 KPI 测验.
  要: "再读 [具体章节 / 具体段落], 注意 [具体意象 / 节奏 / 角色姿态]". 或: "在你的笔记里, 让这段话和 [你自己人生的某个瞬间] 站在一起一周".
  最佳形态: 像编辑给作者的旁注, 不是教师给学生的作业.

另外 — 在 spark 级之上, 给 3-5 条 reading_commitments:
- "本书读完之后, 读者承诺什么样的阅读姿态" 的 3-5 条命题.
- 禁命令式 KPI. 要: 仪式 / 重读频率 / 与谁共读 / 写信给谁这种.
- 例: "把第 6 章夹一张便签, 一年后重读, 看自己是否还相信主人公."

${REGISTER_GUARD}
注: 文学 transfer ≠ 技术 transfer. 文学是"陪伴 + 重读 + 在生活拐点回来", 不是"24 小时内动手做".

JSON schema:
{
  "spark_literary_transfer": [
    { "id": "spark-01", "resonance": "1-2 段, 80-180 字", "reading_invitation": "1 段, 60-150 字" }
  ],
  "reading_commitments": ["命题 1", "命题 2", "命题 3", "命题 4", "命题 5"]
}

必须覆盖所有 spark id. 输出 = 纯 JSON.`;
  const usr = `读者画像 (literary register):\n${goalStmt}\n\n所有 Sparks (Phase 3 + 4 文学合并):\n${JSON.stringify(enriched, null, 2)}`;
  return [
    { role: 'system', content: sys },
    { role: 'user',   content: usr },
  ];
}

function _mockPhaseOutput(phase, payload) {
  const toc = (payload && payload.toc) || [];
  const titles = toc.map(c => c.title).filter(Boolean);
  const author = (payload && payload.book && payload.book.author) || 'Unknown';
  const bookTitle = (payload && payload.book && payload.book.title) || 'Untitled';

  switch (phase) {
    case 1:
      return {
        author_core_question: `What does ${author} argue about ${bookTitle}?`,
        overall_structure: titles.length > 0
          ? `Argument proceeds across ${titles.length} sections, opening with "${titles[0]}".`
          : 'Single-arc treatise.',
        key_chapters: toc.slice(0, Math.min(8, toc.length)).map(c => ({ idx: c.idx, title: c.title, weight: 'high' })),
      };
    case 2: {
      const ch = (payload && payload.chapter) || { idx: 0, title: 'Section 1' };
      return {
        chapter_idx: ch.idx,
        chapter_title: ch.title,
        core_question: `What is the central tension of "${ch.title}"?`,
        core_judgments: [
          `${author} asserts a non-trivial claim in "${ch.title}".`,
          'The argument advances by example then abstraction.',
        ],
        argument_chain: [
          { step: 'P1', text: 'Premise: the conventional view is inadequate.' },
          { step: 'P2', text: 'Premise: a counter-example demonstrates inadequacy.' },
          { step: 'C',  text: 'Conclusion: a structural reframing is required.' },
        ],
        hidden_premises: ['Assumes a non-instrumental concept of value.'],
        spark_candidates: [
          { kind: 'concept', text: `${ch.title} reframes a default by exposing its hidden cost.`, strength: 0.6 },
        ],
      };
    }
    case 3: {
      // Mock new schema: book_model + themes (each with sparks fields 1-4).
      return {
        book_model: '本书在用 "环境塑造观察, 创作产生规格, 工具决定可思考边界" 的角度看世界 (mock).',
        themes: [
          {
            id: 'theme-01', name: '环境错配不是失败', description: '局部游戏的失分不等于真实世界的失败 (mock).',
            sparks: [
              {
                id: 'spark-01', name: '环境错配不是失败',
                hook: 'mock 钩子: 系统失败不代表能力失败',
                mechanism: ['每环境有奖励函数', '奖励错配→失分', '失分≠失能', '真实世界重新计价'],
                counterintuitive: '你在一个系统失败可能正在训练对的能力 (mock)',
              },
            ],
          },
        ],
      };
    }
    case 4: {
      const themes = (payload && payload.themes) || [{ sparks: [{ id: 'spark-01' }] }];
      const ids = themes.flatMap(t => (t.sparks || []).map(s => s.id));
      // Archetype-specialized mock: literary returns themes/motifs/arc not AI-era reframing.
      if (payload && payload.archetype === 'literary') {
        return {
          spark_literary: ids.map(id => ({
            id,
            motif: `(mock) motif for ${id} — 反复回归的意象 / 角色姿态`,
            narrative_arc: `(mock) narrative_arc for ${id} — 形状: 螺旋下沉`,
            key_passage: `(mock) key_passage for ${id} — 原文未在 hook 中明示, 留 placeholder 待编辑补`,
          })),
        };
      }
      return { spark_ai_era: ids.map(id => ({ id, ai_era: `(mock) ai_era for ${id}` })) };
    }
    case 5:
      return {
        author_overestimated: ['Universality of a single domain example.'],
        author_underestimated: ['Compounding effect when defaults are software-mediated.'],
        outdated_views: ['Assumes information scarcity; today information is abundance, attention is scarce.'],
        rewriteable_for_ai_era: [
          'Reframing-by-counter-example can be automated as an agentic auditor: per-claim, surface the strongest counter and force human ack.',
        ],
      };
    case 6: {
      const themes = (payload && payload.themes) || [{ sparks: [{ id: 'spark-01' }] }];
      const ids = themes.flatMap(t => (t.sparks || []).map(s => s.id));
      // Archetype-specialized mock: literary returns resonance + reading_invitation.
      if (payload && payload.archetype === 'literary') {
        return {
          spark_literary_transfer: ids.map(id => ({
            id,
            resonance: `(mock) resonance for ${id} — 在生活拐点回来的位置`,
            reading_invitation: `(mock) reading_invitation for ${id} — 再读 / 慢读 / 旁注`,
          })),
          reading_commitments: ['(mock) 把第 6 章夹一张便签, 一年后重读.'],
        };
      }
      return {
        spark_personalize: ids.map(id => ({
          id,
          transfer: `(mock) transfer for ${id}`,
          experiment: `(mock) experiment for ${id}`,
        })),
        strategic_propositions: ['(mock) 停止 X, 开始 Y.'],
      };
    }
    case 7:
      return null; // packaged by phase7 below from prior outputs
    default:
      throw new Error('unknown phase: ' + phase);
  }
}

// ── Phase 1 — Build map ────────────────────────────────────────────────────

/**
 * @param {object} book  manifest from library.getBook
 * @param {object} options
 * @returns {Promise<{phase_n:1, toc, author_core_question, overall_structure, key_chapters}>}
 */
async function phase1_buildMap(book, options = {}) {
  if (!book || !Array.isArray(book.chunks)) {
    throw new Error('phase1: book + book.chunks required');
  }
  const toc = book.chunks.map(c => ({ idx: c.idx, title: c.title, type: c.type || null }));
  const llm = await invokeLLM(1, { book, toc, options });
  return {
    phase_n: 1,
    book_id: book.id,
    toc,
    author_core_question: llm.author_core_question,
    overall_structure: llm.overall_structure,
    key_chapters: Array.isArray(llm.key_chapters) ? llm.key_chapters : [],
    generated_at: new Date().toISOString(),
  };
}

// ── Phase 2 — Chapter breakdown ────────────────────────────────────────────

/**
 * Runs sequentially over book.chunks. For each chapter: surface
 * core question + judgments + argument chain + hidden premises + sparks.
 */
async function phase2_chapterBreakdown(book, phase1, options = {}) {
  if (!book || !Array.isArray(book.chunks)) throw new Error('phase2: book.chunks required');
  if (!phase1) throw new Error('phase2: phase1 output required');
  // Worker-pool parallelism. Each chapter is an independent LLM call so we can
  // run N in parallel; the router's weighted dispatch naturally spreads load
  // across GLM/DeepSeek/Kimi. Default 4 = comfortable under provider RPM caps
  // and a ~4x walltime improvement vs sequential. Tunable via options.phase2Concurrency.
  const total = book.chunks.length;
  const out = new Array(total);
  let nextIdx = 0;
  let done = 0;
  const concurrency = Math.max(1, Math.min(8, (options && options.phase2Concurrency) || 6));
  const onProgress = typeof (options && options.onChapter) === 'function' ? options.onChapter : null;

  // Existing books in the library may carry TOC-fragment chunks (~30-200 chars)
  // that were captured before source-extractor's MIN_CHAPTER_CHARS filter
  // landed. Skip the LLM call for any chunk that is plainly too short to
  // analyze — emit a clean stub so phase 3+ still see all chapter_idx values
  // and the user isn't billed T6 tokens to hear "本章文本不足以提炼".
  const MIN_TEXT_FOR_LLM = 300;

  const worker = async () => {
    while (true) {
      const myIdx = nextIdx++;
      if (myIdx >= total) return;
      const ch = book.chunks[myIdx];
      const chText = String((ch && ch.text) || '');
      let llm;
      if (chText.length < MIN_TEXT_FOR_LLM) {
        llm = {
          core_question: '(章节文本过短 · 未送 LLM 分析)',
          core_judgments: [],
          argument_chain: [],
          hidden_premises: [],
          spark_candidates: [],
        };
      } else {
        llm = await invokeLLM(2, { book, chapter: ch, phase1, options });
      }
      out[myIdx] = {
        chapter_idx: ch.idx,
        chapter_title: ch.title,
        chapter_type: ch.type || null,
        core_question: llm.core_question,
        core_judgments: Array.isArray(llm.core_judgments) ? llm.core_judgments : [],
        argument_chain: Array.isArray(llm.argument_chain) ? llm.argument_chain : [],
        hidden_premises: Array.isArray(llm.hidden_premises) ? llm.hidden_premises : [],
        spark_candidates: Array.isArray(llm.spark_candidates) ? llm.spark_candidates : [],
        skipped: chText.length < MIN_TEXT_FOR_LLM ? 'short_text' : undefined,
      };
      done++;
      if (onProgress) { try { onProgress(done, total, ch); } catch (_) {} }
    }
  };

  // If any worker throws, Promise.all rejects + remaining workers continue until
  // they hit the catch (no cancellation hook on in-flight LLM calls — acceptable
  // since they finish in seconds and the retry budget inside invokeLLM has
  // already been spent before throw).
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return {
    phase_n: 2,
    book_id: book.id,
    chapter_count: total,
    chapters: out,
    generated_at: new Date().toISOString(),
  };
}

// ── Phase 3 — Cross-chapter synthesis (themes + deep sparks fields 1-4) ────

async function phase3_crossChapterMerge(book, phase2, options = {}) {
  if (!phase2 || !Array.isArray(phase2.chapters)) throw new Error('phase3: phase2.chapters required');
  const llm = await invokeLLM(3, { book, chapter_results: phase2.chapters, options });
  // Normalize: ensure themes[].sparks[] always have all 4 fields as defined types.
  const themes = (Array.isArray(llm.themes) ? llm.themes : []).map((t, ti) => ({
    id: t.id || `theme-${String(ti + 1).padStart(2, '0')}`,
    name: t.name || '',
    description: t.description || '',
    sparks: (Array.isArray(t.sparks) ? t.sparks : []).map((s, si) => ({
      id: s.id || `spark-${String((ti * 10) + si + 1).padStart(2, '0')}`,
      name: s.name || '',
      hook: s.hook || '',
      mechanism: Array.isArray(s.mechanism) ? s.mechanism : (s.mechanism ? [String(s.mechanism)] : []),
      counterintuitive: s.counterintuitive || '',
    })),
  }));
  return {
    phase_n: 3,
    book_id: book.id,
    book_model: llm.book_model || '',
    themes,
    generated_at: new Date().toISOString(),
  };
}

// ── Phase 4 — AI-era reframing (adds ai_era field per spark) ───────────────

async function phase4_frontierize(book, phase3, options = {}) {
  if (!phase3) throw new Error('phase4: phase3 required');
  const goalContext = (options && options.goal) || null;
  // Archetype passes through to invokeLLM → _buildMessagesForPhase. Default
  // (claim-extraction) prompt is used unless options.archetype === 'literary'.
  const archetype = (options && options.archetype) || null;
  const llm = await invokeLLM(4, {
    book,
    themes: phase3.themes || [],
    goal: goalContext,
    archetype,
    options,
  });
  // Default schema: spark_ai_era[]. Literary schema: spark_literary[].
  // Both are normalized and persisted; phase 7 packager + downstream renderers
  // pick whichever is present. Either way returns one row per spark id.
  if (archetype === 'literary') {
    const rows = Array.isArray(llm.spark_literary) ? llm.spark_literary : [];
    const spark_literary = rows
      .filter(r => r && r.id)
      .map(r => ({
        id: r.id,
        motif: String(r.motif || ''),
        narrative_arc: String(r.narrative_arc || ''),
        key_passage: String(r.key_passage || ''),
      }));
    return {
      phase_n: 4,
      book_id: book.id,
      archetype: 'literary',
      spark_literary,
      generated_at: new Date().toISOString(),
    };
  }
  const rows = Array.isArray(llm.spark_ai_era) ? llm.spark_ai_era : [];
  const spark_ai_era = rows
    .filter(r => r && r.id)
    .map(r => ({ id: r.id, ai_era: r.ai_era || '' }));
  return {
    phase_n: 4,
    book_id: book.id,
    spark_ai_era,
    generated_at: new Date().toISOString(),
  };
}

// ── Phase 5 — Reverse critique ─────────────────────────────────────────────

async function phase5_critique(book, phase3, options = {}) {
  if (!phase3) throw new Error('phase5: phase3 required');
  const llm = await invokeLLM(5, { book, phase3, author_context: options && options.authorContext, options });
  return {
    phase_n: 5,
    book_id: book.id,
    author_overestimated: Array.isArray(llm.author_overestimated) ? llm.author_overestimated : [],
    author_underestimated: Array.isArray(llm.author_underestimated) ? llm.author_underestimated : [],
    outdated_views: Array.isArray(llm.outdated_views) ? llm.outdated_views : [],
    rewriteable_for_ai_era: Array.isArray(llm.rewriteable_for_ai_era) ? llm.rewriteable_for_ai_era : [],
    generated_at: new Date().toISOString(),
  };
}

// ── Phase 6 — Personalize (adds transfer + experiment per spark, + strategic_propositions) ─

async function phase6_personalize(book, priorPhases, options = {}) {
  const goal = (options && options.goal) || null;
  const phase3 = priorPhases && priorPhases.phase3;
  const phase4 = priorPhases && priorPhases.phase4;
  if (!phase3) throw new Error('phase6: prior phase3 required');
  // Archetype thread-through. If phase4 came back as 'literary', or caller
  // explicitly passes options.archetype='literary', take the literary branch.
  const archetype = (options && options.archetype)
    || (phase4 && phase4.archetype === 'literary' ? 'literary' : null);
  const llm = await invokeLLM(6, {
    book,
    themes: phase3.themes || [],
    spark_ai_era: (phase4 && phase4.spark_ai_era) || [],
    spark_literary: (phase4 && phase4.spark_literary) || [],
    goal,
    archetype,
    options,
  });
  if (archetype === 'literary') {
    const spark_literary_transfer = (Array.isArray(llm.spark_literary_transfer) ? llm.spark_literary_transfer : [])
      .filter(r => r && r.id)
      .map(r => ({
        id: r.id,
        resonance: String(r.resonance || ''),
        reading_invitation: String(r.reading_invitation || ''),
      }));
    const reading_commitments = Array.isArray(llm.reading_commitments) ? llm.reading_commitments : [];
    return {
      phase_n: 6,
      book_id: book.id,
      archetype: 'literary',
      goal_statement: (goal && goal.statement) || null,
      spark_literary_transfer,
      reading_commitments,
      generated_at: new Date().toISOString(),
    };
  }
  const spark_personalize = (Array.isArray(llm.spark_personalize) ? llm.spark_personalize : [])
    .filter(r => r && r.id)
    .map(r => ({ id: r.id, transfer: r.transfer || '', experiment: r.experiment || '' }));
  const strategic_propositions = Array.isArray(llm.strategic_propositions) ? llm.strategic_propositions : [];
  return {
    phase_n: 6,
    book_id: book.id,
    goal_statement: (goal && goal.statement) || null,
    spark_personalize,
    strategic_propositions,
    generated_at: new Date().toISOString(),
  };
}

// ── Phase 7 — Assemble Book Spark Pack (v0.2 schema, theme-grouped) ────────
//
// Pack schema (v0.2):
//   book_title, version, source_note, risk_and_copyright_note
//   author_core_question         (phase 1)
//   overall_structure            (phase 1)
//   book_model                   (phase 3 — 全书底层公式)
//   themes: [                    (phase 3 + 4 + 6 merged by spark id)
//     { id, name, description, sparks: [
//       { id, name, hook, mechanism[], counterintuitive,    // phase 3
//         ai_era,                                            // phase 4
//         transfer, experiment }                             // phase 6
//     ]}
//   ]
//   anti_sparks                  (phase 5 — book-level reverse critique)
//   strategic_propositions       (phase 6 — final命令式命题 3-5 条)

function phase7_packageBookSparkPack(book, allPhases, options = {}) {
  if (!book) throw new Error('phase7: book required');
  if (!allPhases || !allPhases.phase1 || !allPhases.phase3) throw new Error('phase7: phase1+phase3 required');

  const p1 = allPhases.phase1;
  const p3 = allPhases.phase3;
  const p4 = allPhases.phase4 || { spark_ai_era: [] };
  const p5 = allPhases.phase5 || {};
  const p6 = allPhases.phase6 || { spark_personalize: [], strategic_propositions: [] };

  // Index phase 4 ai_era + phase 6 personalize by spark id for merge into themes.
  const aiEraById = new Map();
  for (const r of (p4.spark_ai_era || [])) {
    if (r && r.id) aiEraById.set(r.id, r.ai_era || '');
  }
  const personalizeById = new Map();
  for (const r of (p6.spark_personalize || [])) {
    if (r && r.id) personalizeById.set(r.id, { transfer: r.transfer || '', experiment: r.experiment || '' });
  }

  const themes = (Array.isArray(p3.themes) ? p3.themes : []).map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    sparks: (t.sparks || []).map(s => {
      const personal = personalizeById.get(s.id) || {};
      return {
        id: s.id,
        name: s.name,
        hook: s.hook,
        mechanism: Array.isArray(s.mechanism) ? s.mechanism : [],
        counterintuitive: s.counterintuitive,
        ai_era: aiEraById.get(s.id) || '',
        transfer: personal.transfer || '',
        experiment: personal.experiment || '',
      };
    }),
  }));

  // Anti-Sparks — book-level reverse critique surfaced separately from themed sparks.
  const anti_sparks = [
    ...(Array.isArray(p5.author_overestimated) ? p5.author_overestimated : []).map(t => ({ kind: 'overestimated', text: t })),
    ...(Array.isArray(p5.author_underestimated) ? p5.author_underestimated : []).map(t => ({ kind: 'underestimated', text: t })),
    ...(Array.isArray(p5.outdated_views) ? p5.outdated_views : []).map(t => ({ kind: 'outdated', text: t })),
    ...(Array.isArray(p5.rewriteable_for_ai_era) ? p5.rewriteable_for_ai_era : []).map(t => ({ kind: 'ai_rewriteable', text: t })),
  ];

  return {
    phase_n: 7,
    book_id: book.id,
    pack: {
      schema_version: '0.2',
      book_title: book.title,
      version: (options && options.version) || '0.2.0',
      source_note: options && options.sourceNote
        ? options.sourceNote
        : `Distilled from user-uploaded copy of "${book.title}" by ${book.author || 'Unknown'} ` +
          `(${book.source_file_name || 'unknown source file'}, ${book.page_count || '?'} pages). ` +
          `Sparks are derivative interpretations — read the original.`,
      author_core_question: p1.author_core_question || '',
      overall_structure: p1.overall_structure || '',
      book_model: p3.book_model || '',
      themes,
      anti_sparks,
      strategic_propositions: Array.isArray(p6.strategic_propositions) ? p6.strategic_propositions : [],
      risk_and_copyright_note:
        `Original text remains property of its author and publisher. This Spark Pack is a derivative ` +
        `interpretation for personal study, not a substitute for the source. Publish to Commons only after ` +
        `confirming fair-use scope (see specs/commons.md). When exporting, redact direct quotations longer than ` +
        `the locale's fair-use threshold.`,
    },
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  invokeLLM, // exported for tests to mock
  phase1_buildMap,
  phase2_chapterBreakdown,
  phase3_crossChapterMerge,
  phase4_frontierize,
  phase5_critique,
  phase6_personalize,
  phase7_packageBookSparkPack,
};
