# Hypha — Claude Code 项目记忆

> 此文件 Claude Code 进 hypha/ 自动加载。给未来 session 30 秒入门。
> 详细历史 / 设计稿 → `C:\Users\32043\.claude\plans\hypha-cozy-iverson.md`

## WHY — Hypha 存在的理由

Hypha **不是** chat tutor，**不是** note-taking app，**不是** 课程市场。

Hypha = **认知加速器**。把 LLM 智识带到用户**真实社交场域**的桥。学的每一段最后必须用自己话讲给真人 (Track B) 或亲手做成可被人用的产品 (Track A)，等真人 push back 才算真懂。

破除 3 件事:
1. **工业化教育** — 反对"定义→记忆→测验"流水线 (Feynman 批判靶心)
2. **信息差 + 知识垄断** — 把 frontier 论文 / 顶尖人物思维 / 跨语言知识降到任意 user 都能消化
3. **AI 伪知识 + 不可读推理 + 人格碎片化** (AMD-MEOW-P7+P8, 2026-05-08) — 三层防御:
   - **Anti-Slop (输出层, P7)**: 反 Apparent-Success-Seeking (AI 把没完成包装成完成). 详见 `specs/anti-slop-layer.md` + 蓝图 §24.
   - **Readable Reasoning (推理层, P7)**: 反 Reasoning Opacity (CoT → Thinkish → Neuralese 漂移).
   - **Persona Coherence (人格层, P8)**: 反 Persona Fragmentation (前沿模型 = helpfulness + RLVR + safety + benchmark + sycophancy 训练压力碎片堆). HYPHA 不信任原始模型人格, 工程化构建 Character Contract + Anti-Ingratiation Filter + Persona Coherence Score. 详见 `specs/persona-coherence-layer.md` + 蓝图 §25.
   - Trust 公式: `Capability × Evidence × Reasoning Legibility × Persona Coherence × Failure Honesty`.
   - HYPHA 的护城河 = Course Generation + **Course Verification + Reasoning Monitorability + Evidence Provenance + Knowledge Contamination Control + Trustable Cognitive Character**.

## WHAT — 8-system 架构 (per BLUEPRINT.md, 2026-05-07 reshape)

> 4-module v0.4.3 vintage (Cognitive Graph / Socratic Engine / Frontier Reducer / External Social Sandbox) **subsumed** by the BLUEPRINT 8-system map. Old module names retained as `code-anchor` column where applicable.

| System | Shipped (v0.11.x) | Aspirational | Code anchor / Spec |
|---|---|---|---|
| **1. Goal System** — Goal Contract / Mode Router / Deadline Cadence / Goal Guardian | partial: implicit in `designSequence` + `clarifyQuestions` | Goal Contract structured JSON; Exam vs Growth vs Hybrid model router | `specs/goal-contract.md` (TODO); `app/agent.js:designSequence` |
| **2. Lesson System** — Dynamic Lesson + Quality Harness + Jargon Firewall + Prerequisite Patch + Misconception + Anti-Illusion + Evidence + Mastery + Positive Feedback + Assignment Cadence | ~70%: state machine + STAKE + Feynman test + GOAL BINDING + voice clamps | Lesson Quality Harness + Anti-Illusion + Misconception Engine + **Anti-Slop P0** (Evidence Ledger / Confession Layer / Gap Detector / Prosecutor-Judge-Rewriter loop / Auditable Reasoning Summary, v0.2 per `specs/anti-slop-layer.md`) | `app/lib/hypha-learn/`, `app/lib/hypha-constitution.js`, `app/prompts/learn-*.txt`, `app/lib/pedagogy.md`, `specs/anti-slop-layer.md` |
| **3. Note System** — 3 sources + Live Capture + Finish Ritual + Active Note + Web Note Engine + Living Note Reactivation + Entropy Reduction | ~70%: dual-layer distill (`课程基础` + `用户灵感`) + atlas concept tracking | Web Note Engine (typed-edge graph), Living Note Reactivation, Entropy Reduction Cycle, Note state machine (Raw→Crystallized), **Knowledge Contamination Graph** (源失效 → walk DAG → quarantine 下游 lesson, P2 v0.5+, per `specs/anti-slop-layer.md` M11) | `vault/<slug>/lesson-NN.md`, `app/lib/userProfile.js`, `events.jsonl` atlas events |
| **4. Creation System** — Product Pool / Blueprint / Transfer / Spark / Decision Log / Assumption Ledger / Kill Criteria / Roadmap Sync | **0%** | Entire system | `specs/creation-system.md` (TODO) |
| **5. Knowledge Source System** — Bibliography Grounding + Library + Longform Distillation + Book Spark Pack + Book Router + Grounding Synthesis | ~30%: source-extractor (PDF/MD/URL) tags `sourceType`; harvest channels active | Book Grounding Profile, Longform Spark Distillation 7-phase, Book Router cache, Grounding Synthesis | `specs/bibliography-grounding.md` + `specs/library-distillation.md` (TODO); `app/lib/source-extractor.js`, `app/agent.js:harvest` |
| **6. Commons System** — Knowledge Pack + Pack Intelligence Card + Pack Learning Mode + Pack Security Layer + Pack Distiller + Source Trust + License | **0%** — Hypha 唯一差异化点 | Entire system | `specs/commons.md` (TODO); v2.0+ |
| **7. Exam System** — Exam Scope Engine + Exam Resource Layer + Error Diagnosis + Final Compression | implicit Feynman test only | Exam Scope (Must/High-Yield/Recognize/OOS), Final Compression mode | `specs/exam-system.md` (TODO); v2.1+ |
| **8. Growth System** — Project Spine + Cross-Spark + Thinking Tools + Judgment Gym + Artifact Creation | partial: `feasibility.js` Macnamara/Donner-Hardy/Newport math; persona registry (12) | Cross-Spark Engine (literature ⇄ tech ⇄ engineering ⇄ AI), Judgment Gym, Project Spine | `app/lib/feasibility.js`, `app/lib/personas.js`; v2.3+ |
| **9. Companion System** — Myco Companion 菌类星人 + Local Model + Tone Engine + State Expression + Boundary Guard | **0%** | Entire system | `specs/companion-myco.md` (TODO); v0.8+ |
| **10. Infrastructure** — API Governance + Cheap Router + Context Packer + Privacy Memory + Trust + Feedback Channel + Cashflow Shield + Cache + Cost Budget | **partial (v0.1, 2026-05-08)**: capability-class registry (T6/T4/T3) + DispatchPolicy 60/30/10 across GLM/DeepSeek/Kimi + ProviderHealth monitor (90s/3-error degrade, 5min recovery ping) + Provider Health badge in lesson screen; old `providers.js` path retained for `agent.js` (Anthropic SDK / claude-cli) | T2_LOCAL Gemma + T1_EMBED BGE-M3 (v0.8 Companion), BYOK Western (Claude/Gemini/GPT, post-壮大), Cashflow Shield, Context Packer per-Lesson budget | `app/lib/llm/` (router.js / index.js / glm-direct.js / deepseek-direct.js / kimi-direct.js); legacy: `app/lib/providers.js` + `app/lib/anthropic-adapter.js` |

**Cross-cutting mechanisms**:
- **Persona = 蒸馏当代专家 corpus** (v0.5.1 待做; 当前仅 string register, 12 personas in `app/lib/personas.js`)
- **Bias Correction** — 关键 claim 必带反方 + 原文链接 + signal-class tag (v0.5.3 patch 待做)
- **Lacquer Loop pedagogy** — 5 retain (P1-P5) + 3 frontier (F1-F3) + P6 prior-install + 3-axis runtime substrate (A1 cure / A2 prediction-log / A3 controller-state); see `app/lib/pedagogy.md`
- **Anti-Slop & Readable Reasoning Layer** (AMD-MEOW-P7, 2026-05-08) — 12 mechanisms across 3 phases: P0 v0.2 (Evidence Ledger / Confession Layer / Gap Detector / Prosecutor-Judge-Rewriter loop / Auditable Reasoning Summary), P1 v0.4 (Reasoning Legibility Score / Limitation-to-Task Converter / Bullshit Density Detector / No-Uncashed-Abstractions / Reasoning-Action Gap), P2 v0.5+ (Knowledge Contamination Graph / Cross-Agent Baton Passing). Course Trust Panel UI 3 layers (default / 展开 / 专家). 详见 `specs/anti-slop-layer.md` + 蓝图 §24. **Source theory** at `C:\Users\32043\Desktop\HYPHA_AntiSlop_ReadableReasoning_Blueprint.md` (canonical, ! 复制原文).
  - **P0 v0.2 Surface tranche, shipped 2026-05-09** (regression pending user pass): Confession Layer ✓ surface (rendered in `/finish` digest as "本节最弱处 — ___" + post-session panel) / Auditable Reasoning Summary ✓ surface (`harnessResult.auditable.structured` consumed by Course Trust Panel default tier) / Gap Detector ✓ surface (`gap_pct` + `apparent_completion / verified_completion` rendered) / 11-field LESSON BRIEF ✓ pre-lesson body generation + designLesson injection (`app/lib/lesson-body-generator.js` + `vault/<slug>/lesson-N.body.json` + `lesson:body:get` IPC) / Goal Drift gate ✓ pre-LessonChat regen-once + `body.drift-warning.json` sibling-write / hook_concrete validator ✓ encyclopedia-opener flag in body validation. Still ◯ lib-only: Evidence Ledger (per-claim provenance, defer v0.4.1) / Prosecutor-Judge-Rewriter loop (defer v0.4 anti-slop expansion).
- **Persona Coherence & Trustable Agent Layer** (AMD-MEOW-P8, 2026-05-08) — 8 mechanisms 3 phases: P0 v0.2 (Character Contract YAML for 3 核心 agent + Anti-Ingratiation Style Filter + 3-dim Persona Coherence Score minimal), P1 v0.4 (Role Drift Detector + Persona Coherence Ledger + Functional × Epistemic enforcement + 8-dim Score full), P2 v0.5+ (Training Shard Map + Drift Recovery Protocol + Agent Registry + Cross-Model Role Audit). 与 P7 Mycelium Immune Pets 同源 (8 菌升 8 Character Contract). Trust 公式: `Capability × Evidence × Reasoning Legibility × Persona Coherence × Failure Honesty`. 详见 `specs/persona-coherence-layer.md` + 蓝图 §25. **Source theory** at `C:\Users\32043\Desktop\HYPHA_Persona_Coherence_Trustable_Agent_Layer.md` (884 lines, canonical, ! 复制原文).
  - **P0 v0.2 Surface tranche, shipped 2026-05-09** (regression pending user pass): Character Contract ✓ surface (`mycelium-professor.json` loaded via `contract-loader` + injected as CHARACTER CONTRACT block in designLesson learn-mode + classic-mode appendix, ahead of LESSON BRIEF) / Anti-Ingratiation Style Filter ✓ surface (post-stream scan in `streamTurn` 5 callsites + `events.jsonl` row `ingratiation_flagged` + transcript turn tag) / 3-dim Persona Coherence Score ✓ surface (`coherence-score.js` dims rendered editorial register in Course Trust Panel: "本节连贯 · 失误诚实 强 · 反讨好 0次 · 契约 匹配", numerics in `title=` tooltip only). Drift attempts hydration ✓ via `vault/<slug>/lesson-N.body.drift-warning.json` read in panel useEffect.

## HOW — 关键文件路径地图

### Backend
- `app/main.js` — Electron main, IPC 总入口 (curriculum:create / chain:create / llm:lesson / source:* / url:fetchBatch / settings:* )
- `app/agent.js` — LLM 调用层 (designLesson / streamTurn / harvest / planChain / classifyAll / 12 personas 注入)
- `app/lib/anthropic-adapter.js` — Anthropic SDK 直连 (extended thinking 8000 budget 默认开)
- `app/lib/providers.js` — provider config (claude-cli / anthropic-sdk / glm / hypha-managed); claude-cli 用 `--effort xhigh`
- `app/lib/hypha-constitution.js` — `FULL` (~600 tokens) 注 system prompt (manuscript register + GOAL BINDING + FEYNMAN TEST + VISUAL AID + FORBIDDEN + voice clamps)
- `app/lib/source-extractor.js` — 多文件 PDF/MD/TXT/URL 抽取; 200MB per-file / 8 files / 800MB total cap
- `app/lib/feasibility.js` — chain 可行性数学 (Macnamara/Donner-Hardy/Newport 据)
- `app/lib/hypha-learn/` — Hypha Learn 模块 (state-machine / stake-block / answer-leak-guard)

### Frontend (Electron renderer)
- `app/ui_kits/ptor-app/TabContent.jsx` — `HyphaEvolutionWelcome` 创课表单 (topic / goal / source / URLs / mode radio / advanced feasibility 字段)
- `app/ui_kits/ptor-app/NoteView.jsx` — `LessonChat` 课程聊天界面 + ChatBubble + state-tag rendering + 内联 SVG 渲染
- `app/ui_kits/ptor-app/ChainPlannerView.jsx` — chain plan 模态 (4-stage 流程 + 接 v0.4.1 advanced 字段)
- `app/ui_kits/ptor-app/VaultTree.jsx` — 左侧课程树 + 语言面板

### Prompts
- `app/prompts/lesson-start.txt` + `lesson-turn.txt` — Classic mode tutor prompts
- `app/prompts/learn-start.txt` + `learn-turn.txt` — Hypha Learn mode (含 STAKE block / state machine markers / A' positive injunctions / pulse cadence / Feynman test)
- `app/prompts/hypha-handbook-zh.md` — 8 岁可读用户手册 (从 user 视角)

### Data (vault, user-side)
- `vault/<topic-slug>/state.json` — curriculum state (lessons / archetype / language / concepts)
- `vault/<topic-slug>/sources.json` — chapter-shaped 知识源 (含 sourceType: user-upload / user-url / web)
- `vault/<topic-slug>/lesson-NN.md` — 每课双层笔记 (课程基础 + 用户灵感, frontmatter 含 learn_mode)
- `vault/<topic-slug>/sessions/L<idx>-<ts>.jsonl` — 每节课对话 transcript + meta row (含 claude_session_id for v0.3.0+ session 继承)
- `vault/<topic-slug>/agent.json` — `{persona, customInstructions, displayName}` per-curriculum
- `vault/data/profile.json` — `{name, about}` 全局 user profile (driving classifyPriorKnowledge)
- `vault/.persona-wisdom/<id>.md` — **(v0.5.1 待建)** 蒸馏 corpus 文件夹

## 关键 conventions

### 路径 & 平台
- Windows-first; PowerShell + Bash 双兼容; `npm run pack:win` / `:mac` / `:linux`
- `release/build-hypha-learn-vX.Y.Z/` — 历史版本 archive (不删, 留对比)
- `Hypha-personal.bat` 启 (HYPHA_ALLOW_CLI=1, 解锁 claude-cli provider)

### Provider 行为

**Two parallel layers — do not mix.**

#### Layer A · capability-class router (`app/lib/llm/`, v0.1+ default)
Used by lesson plan / lesson body / scoring (Phase D 2026-05-08+) and any new caller.

```js
const { executeChat } = require('./lib/llm');
const dispatch = await executeChat('T3_MID', { messages, json: true, ... });
// → { result, providerId, model, capability, attempts }
```

`executeChat(capability, chatArgs)` runs DispatchPolicy weighted random pick across GLM/DeepSeek/Kimi, retries up to 3 providers on 5xx/timeout/429, marks the failed providers in ProviderHealth (90s/3-error sliding window). Recovery ping fires every 5 min on degraded providers. See `app/lib/llm/router.js`.

Backward-compat helper `getCapabilityModel(capability)` is auth-time-only fallback (Phase B/C) — kept for callers that need to manage their own retry. Phase D callers should prefer `executeChat`.

#### Layer B · legacy `providers.js` + `anthropic-adapter.js` (`app/agent.js` only)
Shipped pre-v0.1 for the lesson chat / harvest / classifyAll path.

- **provider=claude-cli** = 纯 Terminal claude 体验:
  - sandbox env 隔离 (CLAUDE_CONFIG_DIR / HOME → cli-sandbox/), 剥离 Victor 宇宙
  - 不传 `--system-prompt` flag; constitution 不发
  - 必须自己在 user-msg 注入 persona / VISUAL AID / GOAL BINDING / Feynman test
  - session 继承: stream-json 抽 session_id, 后续 turn 走 `--resume <id>`
  - effort `xhigh` 思考预算
- **provider=anthropic SDK** = Hypha 完整模式 (constitution + persona + state machine 全注)

`agent.js` migration to capability-class router is deferred — works today, no urgency to break it.

### Brand register (constitution-enforced)
- Manuscript register: italic EB Garamond + Noto Serif SC on cream paper, brass hairlines
- FORBIDDEN words: AI / LLM / embedding / model / prompt / agent / RAG / vector / fine-tune (用 domain term 替代)
- 禁 zh AI 流量词: 这一刀 / 闭环 / 拉满 / 王炸 / 杀疯了 / 干货 / 直击灵魂 / 上分 / 上车 / 上岸 / 内卷 / 出圈 / 真香 / yyds / 绝绝子
- 禁: emoji / 感叹号 / "great question!" / 第三人称 ("用户...")
- voice: 你 (peer-level) / Garamond cadence / 慢且 dignified

### Pedagogical rules (binding)
- **GOAL BINDING**: 每概念必须可追溯服务 learn_goal, 不 → 砍
- **FEYNMAN TEST**: 定义 = START 不是 END; 测理解用 "apply X to instance" 不用 "what is X"
- **forbidden anti-pattern**: 3 定义连排 + 1 测验 = 考试不是课
- **VISUAL AID**: 数学/几何/向量/网络/状态机 topic 用 ```svg``` 围栏块输出, Hypha 内联渲染

## LLM 7-tier 路由 (v0.1, Phase D 2026-05-08)

Per BLUEPRINT §17.2.1 + AMD-MEOW-P4. Capability classes route to model picks via DispatchPolicy weighted random + ProviderHealth runtime fallback.

### Capability classes (shipped v0.1)

| Class | Use | DispatchPolicy 60/30/10 |
|---|---|---|
| **T6_STRONG** | Lesson Plan + Body + Cross-Spark | GLM-5.1 / DeepSeek-V4-Pro / Kimi-K2.6 |
| **T4_JUDGE** | Quality Harness micro judges | GLM-4.5-Air / DeepSeek-V4-Flash / Kimi-K2.6 |
| **T3_MID** | Pack 初筛 / Drift 二审 / scoreMicroProof | GLM-4.5-Air 70% / DeepSeek-V4-Flash 30% (Kimi reserved for T6 长上下文 niche) |

Deferred:
- T5_PACK — algorithmic, no LLM
- T2_LOCAL — Gemma 3 4B local Ollama (v0.8 Companion)
- T1_EMBED — BGE-M3 local (v0.8+)

### Provider Health (runtime fallback)

`router.js` keeps an in-process Map of per-provider health records. Triggers:
- DOWN: 90s sliding window ≥ 3 5xx/timeout errors, OR 429 retry-after > 60s → `state='degraded'`
- RECOVERY: 5min interval pings each `degraded` provider with a 200-token "pong" call; 1 success → `state='healthy'`

`pickWeighted()` excludes `degraded` providers from the random pool. If the entire pool is degraded, last-ditch falls through to the first non-excluded entry.

### Env vars

| Provider | Env var | Endpoint |
|---|---|---|
| GLM | `GLM_API_KEY` | https://open.bigmodel.cn/api/paas/v4 |
| DeepSeek | `DEEPSEEK_API_KEY` | https://api.deepseek.com/v1 |
| Kimi (Moonshot CN) | `KIMI_API_KEY` | https://api.moonshot.cn/v1 |

Provider constructors `.trim()` env values to defend against PowerShell `>>` continuation baking `\n` into User env (a `Bearer sk-...\n` is rejected by Node http as invalid header → opaque "Connection error").

Set permanently:
```powershell
[System.Environment]::SetEnvironmentVariable("GLM_API_KEY", "sk-...", "User")
[System.Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "sk-...", "User")
[System.Environment]::SetEnvironmentVariable("KIMI_API_KEY", "sk-...", "User")
```
Restart the calling process (Claude Code / Electron / PowerShell) after changing User env — it is read at process spawn.

### Verify (read-only)

```powershell
cd E:\victor\hypha
node -e "(async()=>{ const llm=require('./app/lib/llm'); console.log('Providers:',llm.listProviders()); for (const cap of ['T6_STRONG','T4_JUDGE','T3_MID']) { const got=await llm.executeChat(cap,{messages:[{role:'user',content:'pong'}],maxTokens:200,temperature:0}); console.log(cap,'=>',got.providerId,got.model,'attempts='+got.attempts); } console.log('health:',JSON.stringify(llm.getProviderHealth(),null,2)); })();"
```

Expected: each capability resolves to a provider, returns "pong" content, all health states = `healthy`.

## Pricing v3 (2026-05-08, Founders Path E)

5-tier with qualification + accelerating loyalty floor. Free / Basic ¥39 / Pro ¥99→¥69 floor / Founders ¥499 once / BYOK ¥0.

Source of truth = `Desktop\HYPHA_final_blueprint_and_evolution_roadmap.md` §19.1 AMD-MEOW-P5. **Do not duplicate the rate table in this file** — copy will rot. Read the blueprint when implementing pricing engine, Founders loyalty curve, or Cadence quota coupling (P6 §8.1).

Founders implementation hook (deferred): `vault/data/profile.json` adds `founder_purchased_at` (timestamp) + pricing engine reads `years_since` to pick Pro discount tier (¥99 / ¥80 / ¥69 floor for general Pro; ¥99→¥69→¥49→¥29 floor for Founders).

## 常用命令

```powershell
# Dev
cd E:\victor\hypha
npm install
npm start                      # Electron dev
npm run pack:win               # 打包 Windows portable

# 验证 syntax
node --check app/main.js
node --check app/agent.js

# 检查 vault 状态
ls vault/<slug>/sessions/
cat vault/<slug>/state.json
```

## 开发流程

1. 改前看 plan file 的 Appendix A-E (在 `C:\Users\32043\.claude\plans\hypha-cozy-iverson.md`) — 理解过往设计决策
2. 改时:
   - **Surgical** — 每行改动必须可追溯到当前任务
   - 不动 `vault/` 任何文件 (那是 user 数据)
   - `app/lib/hypha-constitution.js` 改要慎重 (影响所有 SDK 路径)
   - claude-cli 路径 (Pure CLI mode) 走 user-msg 层注入, 不走 system prompt
3. 改后:
   - `node --check` 全部碰过的 .js
   - JSX 用 esbuild 或 brace-balance 验
   - `npm run pack:win -- --out=release/build-hypha-learn-v<X.Y.Z>` 出新 build (留旧 build)
4. 不动现有 41 unstaged hypha files (user 进行中工作)

## v0.5+ 路线 (按优先级)

1. **v0.5.0** External Social Sandbox (Track A 课程=产品 + Track B 笔记+发布) — Hypha 唯一差异化, P1
2. **v0.5.1** Persona Corpus 蒸馏 — Karpathy / 李沐 / Tao / Munger 5+ persona 起步, P2
3. **v0.5.2** Frontier Scheduler — cron 周期抓 + Tavily fallback, P3
4. **v0.5.3** Bias Correction — constitution 加 1 段, 0.5d patch
5. v0.6+ True Cognitive Graph (linear chain → node graph), 母语降维显式指令, sub-agent 真化

详见 `C:\Users\32043\.claude\plans\hypha-cozy-iverson.md` Appendix E。

## 当前 build = v0.4.3

`release\build-hypha-learn-v0.4.3\Hypha-personal.bat`

累积 Appendix A (planChain retry) + B (multi-file source) + C (claude-cli pure passthrough) + D (session 继承) + 一系列 patches (effort xhigh / Pure CLI radio / SVG 渲染 / opener 反转 / GOAL BINDING / FEYNMAN TEST)。

**v0.2 Surface tranche — shipped 2026-05-09** (3-Machino parallel team mode, regression pending user pass; per `C:\Users\32043\.claude\plans\fluffy-hugging-swan.md`):
- Backend: `app/lib/lesson-body-generator.js` (NEW, 11-field body schema + drift gate + hook_concrete validator) + `app/agent.js` (Anti-Ingratiation post-stream scan + Character Contract injection + LESSON BRIEF injection) + `app/main.js` (`lesson:body:generate` + `lesson:body:get` IPC + drift-warning sibling-write + curriculum-create auto-fire on lesson 0)
- UI: `app/design/screen-lesson-chat.jsx` (ChainHeader thesis row + `/finish` confession line) + `app/design/course-trust-panel.jsx` (3-dim coherence editorial line + drift anchor editorial line + drift-warning attempts hydration)
- Out of scope (deferred to v0.4.1+): Evidence Ledger / Prosecutor-Judge-Rewriter loop / Reasoning Legibility Score / 8-dim full coherence / Persona Corpus distillation (v0.5.1)

## 不要做的事

- 不发明 v0.5+ 新功能未对齐 plan file Appendix E
- 不写 sycophantic / 营销话术 (e.g. "克隆 Einstein" — corpus 不够, 别承诺)
- 不加 SaaS-y gamification (% 进度条 / 徽章弹窗 / 等级系统) — 违 manuscript register
- 不动 vault/ (user 数据) 除非显式被要求
- 不删 sandbox env 隔离 (Pure CLI 路径必须保留 Victor 宇宙隔离)
- 不绕 plan workflow ship 大重构 — 必须先写 Appendix
