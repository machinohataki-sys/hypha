# Cross-Spark Engine + Thinking Tools + Judgment Gym (W7.4)

> Per BLUEPRINT.md §14.2-14.4 + ROADMAP v2.3.
>
> Hypha 的护城河之一是把单一领域的思考拉到四个域 (literature / science /
> engineering / AI) 之间走一圈, 让一个 stuck-in-place 的问题在异域语言下
> 重新长出来。Judgment Gym 是另一半 — 比起"答对", 训练"为什么选 A 不选 B,
> 放弃了什么"的能力。

## 1. Mental Model

> 文科给眼界 / 理科给深度 / 工程给落地 / AI 给放大。

每个 Cross-Spark 走 6 步:

1. **identify domain**  — 当前问题落在 4 个域里的哪一个
2. **map to 3 lenses** — 用其它 3 域的母语提一个 lens 问题
3. **pick thinking tool** — 12 工具里挑 1 个 (keyword 推荐 + LLM 精化)
4. **apply tool → new spark** — 工具的关键追问驱动跨域综合
5. **realistic constraint** — 时间 / 成本 / capability / honesty 检
6. **action or artifact** — 6 周内可被人 push back 的最小产物

## 2. 12 Thinking Tools

| ID | 名称 | 关键追问 (sample) | 典型应用 |
|---|---|---|---|
| socratic-questioning | 苏格拉底式追问 | 这句话的具体含义是什么? | 拆"用户都想要短视频" |
| first-principles | 第一性原理 | 剥掉惯例后剩下的不可变量是什么? | Musk 拆火箭成本 |
| occam-razor | 奥卡姆剃刀 | 哪个解释引入的新实体最少? | debug lesson-0 卡住 |
| pragmatism | 实用主义 | 6 个月后这场争论还有人记得吗? | RAG vs fine-tune 之争 |
| counterfactual-thinking | 反事实推理 | 如果决策反过来, 结果会怎样? | v0.4.3 +18% 归因 |
| systems-thinking | 系统思维 | A 修复后 B 冒泡 — 接口在哪? | "卡在 lesson 3" 的真因 |
| narrative-analysis | 叙事分析 | 这个故事谁讲, 谁在听? | "OpenAI 领跑" framing |
| structuralism | 结构主义 | 表面 1000 instance, axis 有几条? | Lévi-Strauss 神话拆解 |
| second-order-consequence | 二阶后果 | 用户会怎么 game 这个 feature? | TikTok 算法二阶 |
| marginal-thinking | 边际思维 | 再投 1 单位资源边际收益? | prompt 工程 vs 用户访谈 |
| historical-cycle | 历史周期 | 上一轮 cycle 的输赢因何? | "AI agent 新范式"质疑 |
| feedback-loop | 反馈循环 | engine loop + governor loop 配对? | Twitter outrage 失衡 |

每个工具的完整字段 (when_to_use / key_questions[] / example_application /
anti_pattern) 见 `app/lib/cross-spark/thinking-tools.js` — 库被
Object.freeze + module-load 时校验 `length === 12`。

### recommendTool 算法

- 输入: problem 字符串
- 算法: per-tool keyword 集合 substring 匹配, 长 seed 权 2 短 seed 权 1
- 输出: top-2 tool ids, 同分按 library order
- 全空时 fallback: `['first-principles', 'socratic-questioning']`

工程 / AI 域问题 (含"fail"/"失败"/"feedback") 自然命中 `feedback-loop` +
`second-order-consequence` — 验证: `recommendTool('why does my product
fail') → 含 'first-principles' 或 'second-order-consequence' 或 'feedback-loop'`.

## 3. Cross-Spark 6-step Flow (engine.js)

```
generateCrossSpark({ currentProblem, currentDomain?, slug? })
  → CrossSpark
```

Step 1 — `_normalizeDomain` (alias 表) → cheap-router `detectDomain` (soft)
→ `_detectDomain` (keyword fallback). 4 域: literature / science /
engineering / ai.

Step 2 — `_generateLenses(sourceDomain)` 选其它 3 域, 每域取 lens 模板第一条
(deterministic; T6_STRONG 替换后可 per-problem 挑).

Step 3 — `ThinkingTools.recommendTool(problem)` → top-2, 取第 1。
`alternate_tool_id` 写入 spark 供 UI "换一个工具" 用。

Step 4 — `_callT6` (intentional-placeholder: T6_STRONG hookup deferred to
wave-2 — 当前 deterministic mock, 由 cross-spark/engine.js inline 说明)
组装 new_spark string + action_or_artifact (kind = prototype / experiment /
note depending on source_domain).

Step 5 — `_generateConstraints(problem, sourceDomain)` 输出 3 条 (time_cost
+ capability + honesty, AI/LLM 域额外加 contamination).

Step 6 — action_or_artifact 已经在 Step 4 由 _callT6 一并产出。

### CrossSpark Schema (frozen)

```ts
{
  id: string,                              // xs-YYYYMMDDhhmmss-<6hex>
  ts: string,                              // ISO
  slug: string | null,
  source_problem: string,
  source_domain: 'literature' | 'science' | 'engineering' | 'ai',
  other_domain_lenses: Array<{ domain, lens: string }>,
  thinking_tool_id: string,
  thinking_tool: { id, name_cn, name_en, key_question },
  new_spark: string,
  constraints: Array<{ kind: 'time_cost'|'capability'|'honesty'|'contamination', note }>,
  action_or_artifact: { kind: 'prototype'|'experiment'|'note', summary },
  alternate_tool_id: string | null,
  mock: boolean,                           // true 时由 _callT6 mock 产出
}
```

持久化: `vault/<slug>/growth/cross-sparks.jsonl` (append-only)。

## 4. Auto-Product-Spark Bridge (auto-product-spark.js)

`autoCreateProductSpark({ crossSparkResult, slug })`:

- 触发条件: `crossSparkResult.action_or_artifact.kind ∈ {prototype, experiment}`
- 不触发 (note kind): 返 `{ ok:true, sprouted:false, reason }`
- 触发后: 调 W3.4 `productSpark.createSpark(slug, {...})` 写入
  `vault/<slug>/product/sparks/spark-<id>.md`, state = `seed`
- 永不绕过 W3.4 state machine, 永不直接 transition 到 `considered`
- 错误降级: 返 `{ ok:false, error, code }`, UI 显示原因

下游: W3.4 `transitionState` 触发 `product:spark:transitioned` 事件,
seed → considered 时 `companion_hook='sprout'`, W3.6 Companion 听 events.jsonl
即获 `spark_sprout` trigger — 无需 cross-spark 自己 emit。

## 5. Judgment Gym (judgment-gym.js)

5 个 exercise type:

| Type | 比较对象 | 默认维度 |
|---|---|---|
| product_proposals   | 2 个产品方案     | 用户价值 / 可落地 / 差异化 / 6 周可 ship / kill criteria |
| agent_architectures | 2 套 agent 架构  | 可解释 / 成本 / 失败模式 / 可扩展 / 可观测 |
| lessons             | 2 个 lesson 版本 | GOAL BINDING / FEYNMAN TEST / 叙事节奏 / 诚实度 / 后续可深入 |
| packs               | 2 个 pack        | source 可信 / 知识密度 / 判别度 / 可被引用 / license 干净 |
| explanations        | 2 种解释         | cause→effect 链 / 反例呈现 / 8 岁可读 / 不省略难点 / 可被反驳 |

### Scoring (4 指标, 0..1)

- `standard` — 维度命中数 / max(3, 总维度数)
- `taste`    — pick A/B → 0.8; both/neither 且 reasoning ≥ 80 字 → 0.6; 否则 0.2
- `tradeoff` — reasoning 包含 (but|代价|放弃|trade|cost|less|缺|牺牲) → 0.9; 否则 0.3
- `judgment` — 0.4·standard + 0.25·taste + 0.25·tradeoff + 0.1·reasoning_length/200

无"标准答案" — 训练的是 process, 不是 answer。Narrative 按 judgment 分档
返三种风格:  ≥ 0.75 (鼓励继续) / ≥ 0.45 (补 missed dimensions) /
< 0.45 (重答)。

### 持久化

`vault/<slug>/growth/judgment-gym.jsonl` (append-only):

- `{kind: 'exercise', id, ts, type, optionA, optionB, context, dimensions, state}`
- `{kind: 'submission', id, exercise_id, ts, user_judgment, score, analysis}`

`getJudgmentHistory(slug)` 返 `{exercises, submissions, stats}`,
stats 含 `rolling_judgment_avg` (近 10 次).

## 6. IPC Surface (main.js)

| Channel | Args | Returns |
|---|---|---|
| `thinkingtools:list`            | —                                          | `{ ok, tools: Tool[] }` |
| `thinkingtools:get`             | `{ toolId }`                               | `{ ok, tool }` |
| `thinkingtools:recommend`       | `{ problem }`                              | `{ ok, recommended: string[] }` |
| `crossspark:generate`           | `{ currentProblem, currentDomain?, slug? }`| `{ ok, spark }` |
| `crossspark:history`            | `{ slug }`                                 | `{ ok, history: CrossSpark[] }` |
| `crossspark:autoCreateSpark`    | `{ crossSparkResult, slug }`               | `{ ok, sprouted, spark_id? }` |
| `judgmentgym:create`            | `{ type, optionA, optionB, context?, slug?, dimensions? }` | `{ ok, exercise }` |
| `judgmentgym:submit`            | `{ exerciseId, userJudgment, slug?, exerciseObject? }` | `{ ok, score, analysis, submission_id }` |
| `judgmentgym:history`           | `{ slug }`                                 | `{ ok, exercises, submissions, stats }` |

### Preload bridges

- `window.ptor.crossSpark.{listTools, getTool, recommendTool, generate, history, autoCreate}`
- `window.ptor.judgment.{createExercise, submit, history}`

## 7. UI Screens

- `app/design/screen-cross-spark.jsx` — 6-step ribbon + auto-sprout button +
  rolling history. Register: warm parchment, EB Garamond italic headings,
  brass accent on action/artifact row.
- `app/design/screen-judgment-gym.jsx` — paired-card layout + dimension
  chips + reasoning textarea + score row + missed-dim hint. Same register.

两个 screen 末尾注 `window.HYPHA_ROUTES['cross-spark'] = CrossSparkScreen`
+ `[judgment-gym] = JudgmentGymScreen`。

## 8. Boundary partners

- **W3.4 product-spark** — auto-product-spark bridges Step 6 → spark CRUD.
  W7.4 *only calls* `createSpark`; state machine 转换由 user 在 Spark Pool
  driver 推。
- **W3.6 Companion** — `spark_sprout` trigger 通过 W3.4 events.jsonl
  接续, W7.4 自己也 emit `growth:cross_spark:generated` +
  `growth:judgment_exercise:created` + `growth:judgment_exercise:submitted`,
  Companion 可未来增加 cross-spark cadence trigger。
- **W5.1 cheap-router** — soft import for domain detection (Step 1).
  失败 fallback to keyword scan, 不阻 spark 生成.
- **W6.4 curriculum-graph** — 后续 wave 可 lookup 当前 lesson 的 KP 上下文,
  把 cross-spark "源问题" prefilled 给用户; 本 wave 不耦合。
- **W7.4 thinking-tools.js** — engine.js + UI 都直接 read-only 引用; library
  Object.freeze, 任何运行时变形 fail-loud。

## 9. T6_STRONG / Mock Plan

- `_callT6` 当前是 deterministic mock — same inputs → same outputs (mod ts).
  这保证 unit test + UI integration 可稳。
- wave-2 接 LLM: 替换 `_callT6` body 为 `require('../llm').executeChat('T6_STRONG', ...)`
  with structured-output schema = `{ new_spark, action_or_artifact }`.
  surface contract 不变。
- Judgment `_analyseJudgment` 当前是规则评分 — 已经能驱动训练; T6_STRONG
  接入后可补 narrative 段的 LLM 改写, score 维持规则计算 (避免 LLM
  评分漂移).

## 10. Acceptance Criteria (W7.4 ship-ready)

- [ ] `THINKING_TOOLS_LIBRARY.length === 12` 且每条 12 字段非空
- [ ] `recommendTool('why does my product fail')` 命中 first-principles / second-order-consequence / feedback-loop 至少 1 个
- [ ] `generateCrossSpark` 返 6 步全字段 + `mock: true`
- [ ] `createJudgmentExercise` + `submitJudgment` 端到端跑通 5 个 type
- [ ] `autoCreateProductSpark` 对 prototype/experiment kind sprout, 对 note kind 不 sprout
- [ ] IPC 9 通道 + preload bridge 全注册, 不与既有 channel 重名
- [ ] 千金 register: 无 emoji, 无感叹号, 无"great question", 无 SaaS 进度条
