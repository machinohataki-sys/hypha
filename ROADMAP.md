# Hypha 演化路线图（v0.1 → v3.0）

> 本表抽自 [BLUEPRINT.md](./BLUEPRINT.md) 第 20 节（演化路线图）+ 第 21 节（最大风险与防御），并为每个版本标注**当前实现状态**（基线 = release v0.11.x, 2026-05-07）。
>
> 用法：开发新功能前先看本表，确认目标版本对应的"必须实现 / 不做"边界；改前查 [BLUEPRINT.md](./BLUEPRINT.md) 完整 spec。

---

## 当前位置

**v0.11.x（长卷布局）** ≈ 介于 BLUEPRINT 路线图的 **v0.3-v0.4 之间**，部分能力已先于路线图完成（Provider Governance 已有 v0.9 雏形；Note dual-layer distill 接近 v0.3 的 Finish Ritual）；同时 v0.5+ 大量系统 (Creation Pool / Companion / Commons / Exam / Library 全文蒸馏) 尚未启动。

| Roadmap 阶段 | 阶段名称 | 当前实现状态 | 状态说明 |
|---|---|---|---|
| **v0.1** | Minimum Transformative Experience | ✅ shipped (历史 v0.4.x) | Onboarding / Goal Contract 雏形 / 第一节 Lesson / Jargon Firewall v0 / Micro Proof / 结构化评分 / Lesson Note v0 / Positive Feedback v0 |
| **v0.2** | Lesson Quality Core | ⚠️ partial | Goal Drift / Jargon Detector / Anti-Generic-Course Detector / Quality Harness 黄金样例库 **均缺**；Lesson Schema 强约束已有（hypha-constitution.js + learn-*.txt） |
| **v0.3** | Note Core | ⚠️ partial → close | Three Note Sources / Capture Mode / Finish Capture Button / Mark for Later / Deepen Now：dual-layer distill 已落，Capture Mode 与 Mark for Later **未实现** |
| **v0.4** | Evidence + Mastery | ⚠️ partial | Mastery Map v1 在 atlas + concept cure clock；Anti-Illusion v0 / Misconception v0 / 术语解锁 **均缺** |
| **v0.5** | Cadence System | ⚠️ partial | Lesson Cadence f(G,D,S,C,M,R,T) **未实现**；Review Day / Integration Day **未实现**；只有 ebbinghaus-style cure-clock |
| **v0.6** | Professor Agent (Goal Guardian) | ⚠️ partial | persona registry 12 角色已有；Affective Goal Router / Confusion Repair / Motivation Recovery / Self-doubt Repair **均缺** |
| **v0.7** | Creation Pool v0 | ❌ 0% | Product Blueprint / Product Transfer / Product Spark / Decision Log / Assumption Ledger 全无；见 [specs/creation-system.md](./specs/creation-system.md) |
| **v0.8** | Companion Layer v0（菌类星人） | ❌ 0% | 见 [specs/companion-myco.md](./specs/companion-myco.md) |
| **v0.9** | API + Model Governance | ✅ partial → close | provider.js 多 backend 已有；prompt caching 已开；成本统计 / 失败回退 **部分**；基础/标准/深度/前沿模式分级 **未实现** |
| **v1.0** | Closed Beta | 🚫 blocked | 等 Creation Pool v0 + Companion v0 + Cadence System 才能闭合 KPI |
| **v1.1** | Cheap Intelligence Router | ❌ 0% | 当前只有 single-model dispatch；无 rules / embedding / small-LLM 分级路由 |
| **v1.2** | Web Note Engine | ❌ 0% | 当前只有 dual-layer distill，无 Atomic Card / Concept Node / Typed Edges |
| **v1.3** | Living Note Reactivation | ❌ 0% | 无 Note 生命状态、Utility Score、场景触发复活 |
| **v1.4** | Creation System v1 | ❌ 0% | depend on v0.7 |
| **v1.5** | Bibliography Grounding Alpha | ❌ 0% | 见 [specs/bibliography-grounding.md](./specs/bibliography-grounding.md) |
| **v1.6** | Library + Longform Distillation | ⚠️ partial | source-extractor 已支持 PDF/MD/URL ingest；Book Spark Pack / Book Router / Focused Distillation **未实现**；见 [specs/library-distillation.md](./specs/library-distillation.md) |
| **v1.7** | Research Radar Alpha | ⚠️ partial | harvest channels 已有 (`CHANNEL_ROUTES` in agent.js)；Frontier Report / 自动 Note 存储 / Lesson 引用 **未实现** |
| **v1.8** | Curriculum Graph MVP | ⚠️ partial | 当前 chain → link → lesson 是 linear sequence；无 Graph 结构、无前置关系、无难度层级 |
| **v1.9** | Commons Alpha | ❌ 0% | 见 [specs/commons.md](./specs/commons.md) |
| **v2.0** | Pack Learning Mode | ❌ 0% | depend on v1.9 |
| **v2.1** | Exam Model Alpha | ❌ 0% | 见 [specs/exam-system.md](./specs/exam-system.md) |
| **v2.2** | Source Trust + License | ⚠️ partial | source-extractor 标 sourceType；License Metadata / Citation System / 外链检测 **未实现** |
| **v2.3** | Cross-Spark Engine | ❌ 0% | depend on Creation Pool + Web Note Engine |
| **v2.4** | Public Launch | 🚫 blocked | 必须 v2.3 + 全部 0% 系统补完 |
| **v2.5** | Learning Commons Flywheel | 🚫 blocked | depend on v2.4 |
| **v3.0** | Ideal Product | 🚫 blocked | 完全体；见 BLUEPRINT §20 v3.0 节 |

图例：✅ shipped / ⚠️ partial / ❌ 0% / 🚫 blocked-by-deps

---

## 路线图（按 BLUEPRINT.md §20 原文）

### v0.1 — Minimum Transformative Experience｜最小转化体验

**目标**：证明 HYPHA 能完成一次真实学习转化。
**只做一条极窄路线**：AI Builder 入门 / 从零理解 AI Agent。

**必须实现**：Onboarding Ritual / Goal Contract / Learning Mode Router 基础版 / 第一节 Lesson / Jargon Firewall v0 / Micro Proof / LLM 结构化评分 / Assignment Function v0 / Lesson Note v0 / Note Deposit v0 / Positive Feedback v0。

**不做**：Commons / Library / Research Radar / 完整 Curriculum Graph / 多学科 / Pack 学习 / 考试题库 / 复杂 UX 个性化 / 菌类星人 / Product Pool。

**验收**：用户完成一节课后能说"我确实比刚才更清楚；我知道下一步做什么；这不像普通 AI 回答。"

### v0.2 — Lesson Quality Core｜课程质量核心

实现 Lesson Quality Harness、黄金样例库、失败样例库、Goal Drift Detector、Jargon Detector、Anti-Generic-Course Detector、Lesson Schema 强约束。

**验收**：同一主题生成 10 次，至少 8 次达到 HYPHA 标准。

### v0.3 — Note Core｜Note 核心闭环

实现 Three Note Sources、用户自建 Note、Lesson Note、Pack Note 占位结构、Capture Mode、Finish Capture Button、Finish Ritual、Mark for Later、Deepen Now。

**验收**：用户真实记录一节课后，能点击完成记录，生成结构化 Lesson Note，并更新下一课上下文。

### v0.4 — Evidence + Mastery｜学习证据与能力地图

实现 Learning Evidence System、Mastery Map v1、Micro Check、Anti-Illusion v0、Misconception v0、术语解锁状态。

**验收**：系统能根据用户上一课表现调整下一课。

### v0.5 — Cadence System｜学习与作业节奏

实现 Lesson Cadence Engine、Assignment Cadence Function、课程天数 D、学习评分 S、困惑 C、阶段节点 M、复习节点 R、Deadline T 基础版、Review Day、Integration Day。

**验收**：用户不会被作业压垮，也不会只看课不行动。

### v0.6 — Professor Agent｜目标教授

实现 Goal Guardian、Affective Goal Router、Confusion Repair、Motivation Recovery、Self-doubt Repair、Distraction Redirect、High-energy Spark Capture。

**验收**：用户偏航时能被拉回；用户低落时能恢复学习链路；用户困惑时能降难度。

### v0.7 — Creation Pool v0｜产品池 / 创造物池 v0

**前提**：Lesson 和 Note 已有基本稳定闭环。

实现：一个 Goal 绑定一个主 Product / Product Blueprint 基础结构 / Product Transfer 手动按钮 / Product Spark 基础结构 / Decision Log v0 / Assumption Ledger v0。

不做：复杂项目管理 / 多产品协作 / 团队功能。

**验收**：用户能把一次 Lesson / Deepen 的知识迁移为 Product Spark，并进入产品蓝图。

### v0.8 — Companion Layer v0｜菌类星人陪伴层 v0

**前提**：Lesson 稳定 / Positive Feedback 有结构化结果 / Mastery Map 有基础状态 / Note 有基础状态。

实现默认菌类星人 / 本地小模型短回应 / 学习状态表达 / 完成 Lesson 后正反馈表达 / 中断后恢复表达 / 过度刷课时节奏提醒 / Finish Capture 仪式语 / Product Spark 发芽表达 / Companion Boundary Guard。

不做：多菌种复杂养成 / 无限聊天 / 皮肤商城 / 复杂动画 / 主线教学。

**验收**：用户感觉 HYPHA 更有陪伴感，但不会感觉主线被娱乐化。

### v0.9 — API + Model Governance｜API 化与模型治理

实现 API 调用层 / 模型选择 / 成本统计 / 缓存 / 失败回退 / 基础-标准-深度-前沿模式。

**验收**：可计算单节课平均成本；可切换模型；输出稳定可控。

### v1.0 — Closed Beta｜封闭测试

开放 1 条 Growth 路线 / Goal Contract / Lesson / Note / Micro Proof / Positive Feedback / 基础节奏 / API 模型 / Creation Pool v0 / Companion v0。

**验收**：60% 完成 7 天路径；40% 完成第一个小作品；30% 愿意付费继续；用户认为 Product Pool 增强知识转化；用户认为菌类星人增强陪伴而非干扰学习。

### v1.1 — Cheap Intelligence Router｜低成本智能分拣

实现规则系统 / Embedding / 本地中型模型 / Context Packer / Note Router v0 / Pack-Note 相关性评分 / Companion 状态生成 / Product Transfer 初筛。

**验收**：主模型 token 明显下降；Lesson 质量不下降。

### v1.2 — Web Note Engine｜蛛网式熵减笔记

实现 Raw Note / Atomic Card / Concept Node / Typed Edges / Kernel Summary / Context Packet / Entropy Reduction Cycle v0。不做漂亮全局 Graph。

**验收**：LLM 调用 Note 时只取少量高价值上下文。

### v1.3 — Living Note Reactivation｜活体笔记复活

实现 Note 生命状态 / Utility Score / 场景触发复活 / 低打扰侧边栏推荐 / Weekly Note Revival / Dead Note Detector / Principle-Checklist-Workflow-Template 结晶 / 菌类星人参与旧 Note 复活表达。

**验收**：旧 Note 能在 Lesson、写作、项目、决策中被重新调用，而不是死亡。

### v1.4 — Creation System v1｜创造系统 v1

实现 Product Pool 多模块 / Product Spark 状态机 / Roadmap Sync / Decision Log / Assumption Ledger / Kill Criteria / Product Transfer 自动触发。

**验收**：学习内容能持续回流到用户正在创造的产品/论文/作品中。

### v1.5 — Bibliography Grounding Alpha｜参考书目地基 Alpha

实现用户 Goal 后选择参考书 / Book Grounding Profile / 已有 Sparks 检查 / 无 Sparks 时 Fast Grounding / 课程引用地基。

**验收**：课程能明显继承参考书的思想结构。

### v1.6 — Library + Longform Distillation｜图书馆与长文蒸馏

实现 EPUB/PDF 私有导入 / 章节 Kernel / Book Router / Focused Distillation / User Sparks / Book Spark Pack Draft。

**验收**：一本书可被蒸馏成可调用 Sparks，后续 Lesson 不需重复读全书。

### v1.7 — Research Radar Alpha｜前沿雷达

实现 Research Schedule / 前沿搜索 / Frontier Report / Note 存储 / Lesson 引用 / Product Spark 触发。

**验收**：前沿报告能提升后续 Lesson 和 Product Pool 质量，而不是制造资讯焦虑。

### v1.8 — Curriculum Graph MVP｜课程图谱 MVP

只做 AI / Computer Science 一个领域，抽取知识点顺序 / 前置关系 / 难度层级 / 经典例子 / 作业类型 / 前沿桥。

**验收**：生成路径明显优于普通 ChatGPT。

### v1.9 — Commons Alpha｜Pack 仓库 Alpha

实现 Knowledge Pack / Pack Intelligence Card / Pack Security Layer / Preview-Learn-Apply-Fork / Fork into Note / Pack Study Note。禁止评论 / 私信 / 热榜 / 可执行 Pack。

**验收**：用户能快速判断 Pack 是否适合自己。

### v2.0 — Pack Learning Mode｜知识包学习模式

实现 Preview Pack / Quick Learn / Deep Learn / Apply Pack / Fork & Rewrite / Transfer to Product / Pack Learning Path / Pack Study Note / Parking Queue。

**验收**：Pack 不再只是资料，而能被编译成 Lesson，并迁移到用户产品/作品。

### v2.1 — Exam Model Alpha｜考试模型 Alpha

先选一个考试场景：考研英语 / 考公行测某一模块。

实现 Exam Scope Engine / Deadline-Aware Cadence / User-owned Bank / Public Index / 错题诊断 / Synthetic Practice / Final Compression / Exam Positive Feedback。

**验收**：HYPHA 能从考试范围出发生成备考路径，而不是知识大全式课程。

### v2.2 — Source Trust + License｜来源可信与许可层

实现 Source Trust Score / License Metadata / Citation System / Book-Pack 权限 / 外链检测 / 版权边界提示。

**验收**：公开内容可追踪，版权边界清楚。

### v2.3 — Cross-Spark Engine｜跨学科灵感生成

实现 Thinking Tools Library / Socratic Questioning / First Principles / Occam Razor / Pragmatism / Counterfactual Thinking / Judgment Gym / Cross-Spark Lesson / 菌类星人 Spark 发光表达 / Product Spark 自动生成。

**验收**：用户能把一个领域的思想迁移到另一个领域，并沉淀到 Product Pool。

### v2.4 — Public Launch｜正式公开版

必须具备：稳定 Lesson / Goal Contract / Learning Mode Router / Lesson Quality Harness / Jargon Firewall / Learning Evidence / Mastery Map / Positive Feedback / Note Core / Living Note Reactivation / Creation System v1 / Cadence System / Companion Layer v0 / API Governance / Cheap Router / 基础 Library Grounding / 基础 Commons / 隐私控制 / Feedback Channel / Donate 支持。

不承诺：全学科覆盖 / 完全替代大学 / 全自动成才 / 无限模型使用 / 全部真题内置 / 复杂宠物养成 / 团队项目管理。

发布定位："HYPHA：AI 时代的私人大学。它不是给你更多资料，而是为你的目标生成学习路径，并逼你把知识转化为能力证据和真实作品。菌类星人不是宠物，而是陪你让知识长成菌丝的异星陪读者。"

### v2.5 — Learning Commons Flywheel｜公共学习资产飞轮

完善高质量 Pack 反哺 Lesson / Book Spark Pack 复用 / Commons 质量分层 / Canonical Pack / Pack 贡献追踪 / Commons 反哺 Curriculum Graph / Product Blueprint Template 分享。

### v3.0 — Ideal Product｜理想产品形态

完全体能力清单与最终体验流程见 [BLUEPRINT.md §20](./BLUEPRINT.md#v30ideal-product理想产品形态)。

---

## 风险与防御（按 BLUEPRINT §21）

### 1. 课程质量风险
**风险**：像普通网课、黑话多、目标偏移、没有行动、没有学习证据。
**防御**：Lesson Quality Harness、Goal Drift Detector、Jargon Firewall、Learning Evidence、Anti-Illusion。

### 2. 成本风险
**风险**：强模型调用过多、上下文太大、重复蒸馏书籍、无限重生成、Research Radar 后台成本。
**防御**：Cheap Router、Book Spark Cache、Context Packer、Lesson Cadence、Model Credits、Token Budget。

### 3. Note 死亡风险
**风险**：笔记越记越多，后面不回顾，记了等于没记，Graph 越来越大，LLM 调用越来越贵。
**防御**：Living Note Reactivation、Utility Score、场景触发复活、Weekly Note Revival、Dead Note Detector、Principle-Checklist-Workflow 结晶。

### 4. Product Pool 垃圾桶风险
**风险**：产品池变成灵感堆积处，只收藏不决策，只发散不落地。
**防御**：Product Spark 状态机、Decision Log、Assumption Ledger、Kill Criteria、Roadmap Sync、每周只处理少量高价值迁移点。

### 5. Commons 噪音风险
**风险**：标题党 Pack、低质量 Pack、恶意代码、Prompt Injection、Star 误导。
**防御**：Pack Intelligence Card、Pack Security Layer、Source Trust、License Layer、质量分层、适配度排序。

### 6. 备考风险
**风险**：范围失控、学太多、题库版权、错题只记录不诊断、最后阶段仍扩张新知识。
**防御**：Exam Scope Engine、Exam Resource Layer、Deadline-Aware Cadence、Final Compression、错题诊断。

### 7. Companion 娱乐化风险
**风险**：菌类星人变成普通宠物、无限陪聊、低幼化、抢走 Lesson 主线、用户为了玩宠物而非学习。
**防御**：Companion Boundary Guard、只读取学习状态、只做短回应、不承担核心教学、不做复杂养成、不做娱乐化付费主线。

### 8. 信任风险
**风险**：用户上传私有笔记、产品蓝图、书籍、真题后担心泄露。
**防御**：Privacy-first Memory、Trust Layer、可查看-删除记忆、私有内容默认不进 Commons、模型调用前隐私过滤。

---

## 最终判断（BLUEPRINT §23）

HYPHA 路线**不是**：`快速做粗糙 MVP → 扔给市场 → 靠用户反馈修`。

而是：`先打磨最小转化体验 → 自己作为第一用户高强度使用 → 小范围封闭测试校准盲区 → 加入 Note / Creation / Living Reactivation / Companion / Library / Commons / Exam / Growth 模块 → 最终形成私人大学 + 创造工作室操作系统`。

关键原则：可以小但不能粗 / 可以窄但不能普通 / 可以慢公开但必须快进化 / 可以从一个人开始但这个人必须真的被它改变 / 陪伴可以有生命感但不能娱乐化吞掉学习主线 / 创造可以有灵感池但不能变成垃圾桶。
