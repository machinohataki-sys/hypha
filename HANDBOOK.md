# Hypha 使用手册

> 自学者的笔记代理。第 4 类 agent（image / code / workflow 之外）。
> 本手册基于 v0.11.x（长卷布局），按代码实际行为写，不写未实现功能。
> 长期愿景与系统级设计 → [BLUEPRINT.md](./BLUEPRINT.md)；版本演化路径 → [ROADMAP.md](./ROADMAP.md)。

---

## 〇、产品宪法（北极星 + 八条铁律）

> 摘自 [BLUEPRINT.md](./BLUEPRINT.md) 第 0-1 节。本节先于功能讲清"Hypha 不是什么 / 为何这么做"；先看完再翻下一节"是什么"才能避免误读功能。

**北极星**：破除工业化学习与知识垄断，让普通人获得 AI 时代的私人大学。Hypha 从碎片信息、参考书、真实课堂、前沿研究、个人笔记、产品蓝图与公共知识资产中生成目标导向课程，并把知识转化为证据、判断、行动、作品与可复用资产。

**Hypha 不是**：AI 网课平台 / AI 聊天老师 / AI 笔记软件 / 题库平台 / 电子宠物应用 / 普通项目管理工具。

**Hypha 是**：目标锁定、证据驱动、节奏控制、笔记活化、知识熵减、创造回流、公共资产反哺、低打扰情感陪伴层的私人大学操作系统。

最小闭环：`Goal → Lesson → Evidence → Note → Feedback → Next Lesson`。

理想闭环：`Goal Contract → Mode Router → Bibliography Grounding → Curriculum / Library / Commons / Research Radar → Dynamic Lesson → Live Capture → Learning Evidence → Mastery Map → Living Note Reactivation → Web Note Engine → Creation Pool → Product Spark → Pack → Commons → Better Next Lesson → Companion Layer 持续陪伴`。

**八条铁律**：
1. **不提供更多资料，而是生成路径** — 资料越多越焦虑；路径越清楚越能行动。Hypha 价值不是"更多课程"，是"为目标生成可被执行、被反馈、被复盘、生成作品的私人学习路径"。
2. **不优化停留时长，而优化目标推进** — `does not optimize for engagement; optimizes for goal progress`。
3. **不让用户"感觉学了"，而要留下学习证据** — `No proof, no progress`。看完/收藏/打卡/复制总结/背定义都不算学完。能复述/解释/举例/迁移/判断/行动/产出/修正旧理解才算。
4. **不替用户学习** — `Human First, Agent Second`。AI 可以追问、纠偏、压缩、结构化、评分、连接、深化、提醒；不能替用户完成核心理解、核心判断、核心作品。
5. **不做无限生成** — 学习不是信息暴食。`新知识 → 练习 → 休息 → 回忆 → 复盘 → 迁移 → 再学习`。Lesson Cadence 控制节奏 + 控制 API 成本。
6. **不做普通社区** — Commons 不是评论区/私信/关注流/热榜/争吵场/学习表演平台/低质量资料市场，而是**可复用学习资产仓库**。
7. **陪伴层不做娱乐宠物** — 菌类星人不是电子宠物 / 陪聊机器人 / 主线功能替代品，是学习状态、正反馈、Note 复活、节奏提醒与中断恢复的情感表达层。
8. **学习必须回流到创造** — 用户在创造的产品 / 论文 / 小说 / 研究 / 开源项目 / 事业蓝图，应在 Lesson / Note / Deepen 时被自然追问"这条知识如何迁移到你正在创造的东西里"。这就是 Product Pool / Creation Pool 的意义。

完整 23 节 product constitution + 8-system architecture + v0.1→v3.0 roadmap 见 [BLUEPRINT.md](./BLUEPRINT.md)。

---

## 一、Hypha 是什么

Hypha 接收一个**学习意图**（一句话目标，例如「一年之内达到英语 C2 词汇水平」），自动从 Nobel-rich 大学课程、GitHub、HN 等高密度源头采集材料，编排成一条**有顺序的 pseudo-curriculum**，再以 Socratic 对话形式逐课带你过一遍。每节课结束自动 distill 成双层笔记：上半是课程基础，下半是你自己的 `## 用户灵感`。

**Hypha 不是什么**：

- 不是 Notion/Obsidian——它不让你「自由组织笔记」，相反它替你**决定**接下来读什么、按什么顺序读。
- 不是 ChatGPT——它不是无状态的对话框，每节课都被你过去的全部笔记注入语境。
- 不是网络课程——没有视频、没有讲师、没有作业平台，只有「一条 chain → 多个 link → 多个 lesson」的可被你逐段征服的文本流。

核心信仰是一句话：**越用越聪明**。tutor 看到的第一段话永远是「this user 这样想这样写」，不是从零起步。

---

## 二、核心概念

| 名词 | 中文 | 解释 |
|---|---|---|
| **vault** | 知识库 | 你所有学习内容的根目录。默认在 `%APPDATA%\Hypha\data\`（Windows）/ `~/Library/Application Support/Hypha/data/`（macOS） |
| **chain** | 课程链 | 一个完整的学习目标。例「用 YC 体系训练三种相互锁定的能力」。一个 vault 可有多 chain |
| **chain link** | 链节 | chain 的一个子目标。一个 chain 通常由 5–7 个 link 组成，按顺序排开。每个 link 对应一个文件夹 |
| **lesson** | 课时 | 一个 .md 文件 = 一个课时。一个 chain link 内通常 30–175 lessons |
| **tutor** | 导师 | 给你上课的 LLM 角色。可定制 persona（默认 socratic） |
| **用户灵感** | — | 每个 lesson .md 里的下半段，是**你写的**部分。tutor 会读这段反推你的思考方式 |
| **atlas** | 概念图谱 | `.beiking/atlas/*.json`，记录每节课出现/被引用/被消化的 concept |
| **user-profile** | 用户画像 | `.hypha/user-profile.md`，4 个 section 的 markdown 文件，注入每次 tutor turn |
| **ghost lesson** | 占位课时 | `00-pending.md` 等，frontmatter 有 `ghost: true`。是 chain 规划时的占位，未真正生成 |
| **chainPlaceholder** | 占位链节 | 整个 link 文件夹都是 ghost——这条 link 还没生成，你只看到了它的轮廓 |

---

## 三、快速上手

### 第一步：启动

双击 `Hypha.exe`。第一次开启会自动创建 `%APPDATA%\Hypha\data\` 目录和默认 `settings.json`。

### 第二步：选择 LLM provider

进入 colophon 视图（`Ctrl + ,`），选 provider 并填 key。推荐顺序：

1. **claude-cli** — 已经在用 Claude Code 的人首选。无需 API key，走你的 Claude Max 订阅。代价：每次调用前置 ~34k token 的 Claude Code system prompt（cache 命中后只算 cache_read，便宜，但偶尔会让 tutor 串味）
2. **claude** — 直连 Anthropic API。需要 `sk-ant-...` key（[console.anthropic.com](https://console.anthropic.com)）。最干净，没有 system prompt 污染
3. **gemini** / **glm** / **openai** — 各家直连 API
4. **hypha-managed** — 不想 BYOK 的兜底方案。每天 30 turns 免费，服务器自动选最便宜后端

详见第十节「Provider 配置」。

### 第三步：创建第一个 chain

回到 evolution 视图（`Ctrl + ,` 切回）。在 welcome 页填一句**学习意图**，例如：

> 一年之内达到英语 C2 词汇水平

提交后 Hypha 会调 LLM 把它分解成 5–7 个 chain links，每个 link 再展开 60–175 个 lesson 占位（ghost）。这一步不会真生成 lesson 内容，只生成结构骨架（chain.json + 每个 link 的 state.json + 每个 lesson 的 `00-pending.md`）。

### 第四步：让 Hypha 生成第一节真课

点底部长卷上的第一颗黄铜印（active lesson），如果是 ghost 会触发生成。tutor 会先 harvest 一批资料（`harvest_complete` 事件写到 `events.jsonl`），然后写出真正的 lesson body。

### 第五步：上课

lesson 加载后 tutor 自动开口。你打字回答，tutor 继续提问。结束时点 Finish，本节自动 distill 进笔记的 `## 课程基础` 和你的 `## 用户灵感` 段。

---

## 四、长卷界面（v0.11.3 起）

```
┌─┬──────────────────────────────────────────────────┬──┐
│▮│                                                  │  │
│▮│             Lesson body 占据 95% 屏宽            │  │
│▮│                                                  │  │
│▮│             ## 00-why-nerds-are-unpopular       │  │
│▮│             …                                    │  │
│▮│                                                  │  │
│▯│                                                  │  │
│▯│                                                  │  │
├─┴──────────────────────────────────────────────────┴──┤
│ chain · 用YC体系训练三种相互锁定的能力              1/72 │
│  · ·· · ●  ·· · ·· ·· ·· · ·· · ··  · ··                │
└──────────────────────────────────────────────────────┘
左：32px chain rail（每个 chain 一根黄铜笔触，发光的是当前 chain）
中：lesson 正文
底：72px 长卷（当前 chain 全部 lesson 的小圆点，发光大点 = 当前位置）
右：terminal/nav rail（NavRail）
```

**操作**：

- **切 chain**：点左侧任一笔触 → 跳到该 chain 的第一个非-ghost lesson
- **跳 lesson**：点底部任一圆点 → 切到那节课。ghost/locked 的点 cursor: not-allowed
- **看 chain 全名**：hover 左侧笔触
- **看 lesson 名**：hover 底部圆点
- **当前位置高亮**：底部黄铜印（带光晕），左侧对应笔触发光，且自动滚动到底部条正中

设计动机：旧版 sidebar 在 1000+ lesson 时 expand/collapse 动画掉帧、ResizeObserver 量错高度漏渲染、sort 顺序反——长卷彻底放弃树形展开/收回机制，所有问题作为副作用消失。代价：失去「一眼看见全部 chain 全部 link 全部 lesson」的总览视角，换来正文区显著放大 + 永远不卡。

---

## 五、键盘快捷键

| 键 | 行为 | 注册位置 |
|---|---|---|
| `Ctrl + ,` / `Cmd + ,` | 在 evolution 和 colophon 之间切换 | `VaultTree.jsx:286-293` → `App.jsx:1142` |
| `Esc` | 关闭右键菜单/恢复焦点/退出某些 modal | `App.jsx:836` |
| 双击左/右 ResizeHandle | 收起对应侧栏（仅右侧 NavRail；左侧 chain rail 永远 32px 不可收起） | `App.jsx:1218` |
| 全局 `hypha:open-evolution` event | 由 colophon「+ 学新课」按钮触发 → 跳回 evolution + 进入 Learn 流 | `App.jsx:868` |

注：lesson 内打字时所有快捷键临时让位（焦点在 input/textarea），点空白处归还。

---

## 六、Tutor 交互

### 起一节课

点底部长卷上的当前印或任一非-ghost 圆点 → 主体区切到该 lesson → tutor 自动打招呼并提问。

### 回答 / 推进

直接打字。tutor 用 streaming 输出，过程中右下角有小指示器。每对 turn（user → tutor）写到 `events.jsonl` 一行 `atlas_turn`，记录引入/引用/沉淀了多少 concept。

### 结束一节课

点 lesson 底部的 **Finish** 按钮。会触发：

1. 把对话 distill 成 `## 课程基础` 段（覆盖原 placeholder）
2. 提取你的 `## 用户灵感` 段（自动填入你 turn 里说出的关键观点）
3. 写 `date_distilled` 时间戳到 frontmatter
4. 触发 `atlas` 概念图谱更新

### Customize Tutor

每个 chain link 文件夹可有自己的 tutor profile。改法：

1. 在 lesson 顶部 header 点「· tutor: 苏格拉底」之类的小字（dispatch `hypha:open-tutor-customize`）
2. 弹出的 modal 里选 persona（socratic / didactic / interlocutor / 自定义）+ 写 customInstructions（这一 link 专属的额外规则）

注意：tutor profile 是 **per chain link** 的，不是 per chain。同一 chain 里不同 link 可以用不同 tutor。

---

## 七、derive from vault & 用户画像

### 它解决的问题

无论用 Claude / Gemini / GLM，每个 LLM 默认对你一无所知。如果 tutor 要因人而异讲课（你写得长就给你长回答；你反复回到 first-principles 就帮你深化），它得**先认识你**。

### 解决方案：4-section 用户画像

`.hypha/user-profile.md` 文件，存在你 vault 里，永不上传：

```markdown
# User Profile (vault名)
_last updated: 2026-05-02T..._

## STYLE
- user thinks in mixed CJK/English; respond in matching register
- user writes long, structured 见解 — they tolerate (and reward) depth

## GRAVITATION
- "first-principles" — appears in 4 lessons; reference back when relevant
- "default-alive" — appears in 3 lessons

## VOICE
- uses "打不过就逃" as a natural connector (×3) — mirror rhythm, do NOT copy literally

## PROJECT
- chain "用-yc-体系训练..." → ultimate goal: 用 YC 方法论独立判断...
```

每次 tutor 上课，这份文件被前置注入 system prompt，tutor 看到的第一段话就是「这个 user 是什么样的」。

### 怎么生成

第一次进入 tutor profile 页面（设置 → user profile section），看到「no profile yet. click derive from vault」——点了之后：

1. **不调 LLM**（零 token 成本，零等待）
2. 后端 `app/lib/userProfile.js:153` 跑纯启发式提取：
   - 读最近 N 个 lesson 的 `## 用户灵感` 段
   - 读 `.beiking/atlas/*.json` 的 concept 频次
   - 读所有 chain 的 `chain.json` ultimate goal
   - 算 CJK/拉丁字符比例 + 见解平均字数 + 重复短语
3. 写出 `.hypha/user-profile.md`
4. 下次 tutor turn 立即生效

### 手编

直接编辑 `.hypha/user-profile.md`：

- 加新 STYLE 规则：「请永远用 GRE 词汇水平回答」
- 改 PROJECT：手动锁定 tutor 关注哪个 chain
- 删 GRAVITATION 里你不再关心的 concept

格式约束：每个 section 用 `## NAME`（NAME 必须是 STYLE/GRAVITATION/VOICE/PROJECT 之一），内容用 `- ` markdown bullet。改完保存，无需重启。

---

## 八、数据存哪

```
%APPDATA%\Hypha\data\                          ← vault 根（HYPHA_DATA env 可覆盖）
├── settings.json                              ← provider/model/apiKey/themeAuto
├── events.jsonl                               ← 全部读写引用 verdict 事件，append-only
├── .hypha/
│   └── user-profile.md                        ← 第七节
├── .beiking/
│   ├── atlas/<slug>.json                      ← 每个 chain link 的 concept 图谱
│   ├── corpus-strength.json                   ← 强度 cache（AtlasView 用）
│   └── event-log.jsonl                        ← legacy event log
├── 用-yc-体系训练.../                         ← chain meta 文件夹（仅含 chain.json）
│   ├── chain.json                             ← chain 顶层规划
│   ├── covenant.json                          ← chain 与用户签订的「契约」
│   └── links-state.json                       ← link 进度汇总
├── yc-思想源流与硅谷创业方法论史/             ← chain link 1（chainLinkIdx=0）
│   ├── state.json                             ← chainSlug / chainLinkIdx / lessonRels[]
│   ├── 00-why-nerds-are-unpopular...md       ← lesson 1（real）
│   ├── 01-pending.md                          ← lesson 2（ghost）
│   └── ...
├── paul-graham-30-篇核心文集逐篇精读/         ← chain link 2（chainLinkIdx=1）
│   └── ...
└── （每个 chain link 一个文件夹，所有 chain 平铺在 vault 根）
```

**关键约定**：

- chain link 文件夹之间靠 **state.json 的 `chainSlug` 字段**判断是否属于同一 chain（不靠目录嵌套）
- lesson 顺序由 `state.json:lessonRels[]` 数组定义（不靠文件名 sort）
- `lastIdx` 字段是 lesson 进度指针
- `chainPlaceholder: true` 标记整个文件夹是 ghost link
- frontmatter `ghost: true` 标记单个 lesson 是 ghost

**备份**：复制整个 `%APPDATA%\Hypha\data\` 文件夹即可。所有内容都是纯文本/JSON，可 git 管理。

**迁移到新机**：把 data 文件夹放到新机的 `%APPDATA%\Hypha\` 下，启动即可。或设置 `HYPHA_DATA` 环境变量指向任意目录覆盖默认路径（`app/main.js:110-113`）。

---

## 九、三个 view 模式

| 模式 | 用途 | 进入方式 |
|---|---|---|
| **evolution** | 学习——上 tutor 课、看 lesson body、写 `## 用户灵感` | 启动默认 / `Ctrl + ,` 从 colophon 切回 |
| **recall** | 回顾——浏览已完成 lessons、SRS 复盘、查 verdict 历史 | recall mode toggle（NavRail 上） |
| **colophon** | 设置 + provider 切换 + tutor profile 编辑 + user-profile 管理 + 关于页 | `Ctrl + ,` |

**evolution ↔ colophon 是 toggle**：再按一次 `Ctrl + ,` 回到原 view。

**recall** 是独立 view，需要从其它入口进。它读 `events.jsonl` 的 verdict 记录决定哪些 lesson 该回顾、哪些已经稳固。

---

## 十、Provider 配置

定义在 `app/lib/providers.js`。修改后立即生效，无需重启。

| Provider | id | 实测状态（2026-05-02） | 适用场景 |
|---|---|---|---|
| **Claude (Direct API)** ★ Recommended | `claude` | ✅ 直连 Anthropic Messages API + Hypha 自定 system prompt → **输出与 claude.ai 同模型完全一致**，无 Victor / Machino persona 污染。Prompt caching 已开启（重复 system block 走 ephemeral cache，~10× 便宜） | 想要 cleanest Opus 4.7 输出。需 `sk-ant-…` key 从 [console.anthropic.com](https://console.anthropic.com)。$5 充值 ≈ 30 lessons (Opus 带 cache) / ~50 lessons (Sonnet) / 数百 lessons (Haiku)。**新用户首选** |
| Hypha Cloud | `hypha-managed` | 未实测 | 不想 BYOK，30 turns/天免费试。服务器选 model（默认 GLM-4.5）。零设置门槛 |
| Claude Max · CLI (Advanced) | `claude-cli` | ✅ Opus 4.7 / Sonnet 4.6 / Haiku 4.5 三档全可用。**已修复 persona 污染**（Hypha 现在通过 `--system-prompt` flag 走 Anthropic 系统字段 → tutor 不再开口 "Machino" 不再 "用户" 第 3 人称） | 已订阅 Claude Max ($20/月) 想要零额外成本的用户。注意：Claude Code 仍会前置 ~30k token 的环境上下文（CLAUDE.md walkup / agents 注册），主调用人设已被 Hypha 覆盖但偶尔可能渗漏。Hypha 在线监控（`events.jsonl` 的 `persona_leak` 事件） |
| OpenAI | `openai` | 未实测（需 sk- key） | GPT-5 / GPT-5 thinking |
| Gemini（API） | `gemini` | 未实测（需 AIza key） | 中文输出偏 verbose-abstract |
| Gemini（CLI） | `gemini-cli` | ✅ gemini-2.5-flash 可用；⚠️ gemini-3.1-pro-preview 当前 Google 端 429 "No capacity"。default 已设为 2.5-flash | 已 `gemini auth login` 的用户。agent.js 自动设 `GEMINI_CLI_TRUST_WORKSPACE=true` 绕过 trusted-folder 检查 |
| GLM | `glm` | 未实测 | 国内访问稳定，便宜，中文体验最好 |
| Codex（CLI） | `codex-cli` | ❌ ChatGPT 订阅 auth 全部失败：`"gpt-5/gpt-5-thinking/gpt-5-mini 都 not supported when using Codex with a ChatGPT account"` | **必须用 API key auth**：`codex login --api-key sk-…`。ChatGPT Plus/Pro 订阅不行。如果只有 ChatGPT 订阅，直接用 `openai` provider |

### 成本估算 (Claude Direct API + prompt caching, 2026-05-02 价格)

每节 lesson 平均 ~15.4k input + 1.25k output tokens。Prompt caching 后 system block (Hypha persona + lesson template) 在 1 小时内走 cache_read ($1.50/M) 而非 fresh ($15/M)：

| Model | 不带 cache | 带 cache (75% hit ratio) | $5 充值能撑 |
|---|---|---|---|
| Opus 4.7 | $0.33/lesson | **$0.17/lesson** | ~30 lessons |
| Sonnet 4.6 | $0.10/lesson | $0.05/lesson | ~100 lessons |
| Haiku 4.5 | $0.025/lesson | $0.014/lesson | ~350 lessons |

**典型用户月成本**（Opus 4.7 + cache）：
- 轻度（1 lesson/天）：~$5/月
- 中度（3 lessons/天）：~$15/月
- 重度（10 lessons/天）：~$50/月

Sonnet 4.6 是 Opus 的 ~3× 便宜；如果你的课程主要是 vocabulary / case-study 类，Sonnet 输出质量足够。Opus 留给真正需要 deep reasoning 的（论文精读、复杂概念辨析）。

**切换方法**：

1. `Ctrl + ,` 进 colophon
2. provider section 选一个 pill
3. 填 apiKey（CLI provider 不需要）
4. 选 model（每个 provider 有 default）
5. 关掉 colophon，下次 tutor turn 走新 provider

---

## 十一、常见问题

### Q：找不到 settings 入口？

按 `Ctrl + ,`（Windows）或 `Cmd + ,`（macOS）。长卷布局把旧 sidebar 底部的 tokonoma 入口去掉了，键盘是唯一进入路径。

### Q：双击 Hypha.exe 后没反应？

任务管理器看是否已经有进程在跑（cmd `tasklist | findstr Hypha`）。Hypha 不允许多实例的话不会再开窗口；如果允许了多实例，会有 N 个 Electron 窗口堆积。建议先：

```cmd
taskkill /F /IM Hypha.exe
```

把所有进程清掉再重启一个。

### Q：底部长卷只有一个发光点，其余空白？

意味着当前 chain 还没生成 lesson 内容（全是 ghost）。点左侧切到另一 chain；或在 colophon 里检查 chain.json 是不是写好了。

### Q：lesson body 区一直转圈？

lesson 正在 streaming 生成。看右下角指示器；如果 30 秒以上没动静，看 colophon 里是否 provider apiKey 错误（事件 `lesson_failed` 会写 `events.jsonl`）。

### Q：换了 vault 路径但 Hypha 还是读旧的？

`%APPDATA%\Hypha\data\` 是 default，如果设了 `HYPHA_DATA` 环境变量，它会优先读。检查方法：

```cmd
echo %HYPHA_DATA%
```

或在 colophon 看 「vault root」字段。

### Q：lesson 顺序不对？

应当按 chain link `chainLinkIdx` 排，每个 link 内按 `lessonRels[]` 数组顺序。如果颠倒检查那个 chain link 的 `state.json` 的 `chainLinkIdx` 字段。

### Q：所有 chain 都消失了？

vault 根目录下应该有多个 chain link 文件夹 + 一个 chain meta 文件夹。如果都不见了，最可能是 settings 里 `HYPHA_DATA` 被改到一个空目录。检查 colophon 「vault root」对不对，必要时改回 `%APPDATA%\Hypha\data\`。

### Q：tutor 输出风格抽象/像没读过我的笔记？

去 colophon 检查 user-profile 是否生成。没生成就点「derive from vault」。已生成但还是抽象，可能是用了 `claude-cli` provider——它前置的 Claude Code system prompt 会污染 tutor 风格。试切到 `claude`（直连 API）对比。

### Q：tutor 开口叫我 "Machino" / 用「用户」第三人称 / 写 4 段散文不提问？

这是 **persona 污染**：使用 `claude-cli` provider 时，Claude Code 的 ~30k token system prompt 会装入 Victor 开发者人设和 agent 列表（Machino / Lung / Leo 等）。Hypha 在 v0114 之后通过 `--system-prompt` flag 把自己的 tutor 人设走 Anthropic 系统字段，**应该**主导输出，但偶尔仍然渗漏（特别是 prompt 比较长或 lesson context 邀请文学语气时）。

**根治**：切到 `claude` (Direct API) provider。需要从 [console.anthropic.com](https://console.anthropic.com) 申请 sk-ant- key，~$5 充值就能用 30 节 Opus lessons。这条路完全绕开 Claude Code wrapper —— 输出与你直接在 claude.ai 里跟同模型对话**完全一致**。

**检测**：Hypha v0115 起每次 tutor reply 都会扫描污染关键词（Machino / Victor / Lung / Leo / Yogo / Muse / 用户 等），命中写 `events.jsonl` 的 `persona_leak` 事件。可在 colophon 看本周污染计数验证哪个 provider 干净。

### Q：换 Claude Direct API 后第一次调用很慢，正常吗？

正常。Anthropic 的 prompt cache 是 lazy 的——第一次调用会 seed cache（~30 秒上 Opus），之后 1 小时内同一 lesson 的 follow-up turn 走 cache_read，每个 turn ~$0.05 而非 $0.33。打开 lesson 的 first turn 慢一点，第 2/3/4 个回合就快了。

---

## 十二、进阶

### 手编 user-profile 的范式

**锁定语言**：在 STYLE 加 `- always respond in 中文 unless user types English first`。

**反转 tutor 倾向**：默认 socratic 会一直问问题，你想要更直接讲述，在 STYLE 加 `- prefer didactic short paragraphs over Socratic question chains`。

**强制引用**：在 STYLE 加 `- when explaining a concept, cite at least one specific [WIKI:slug] from this vault if available`。

### Tutor persona 自定义

`Customize Tutor` modal 里的 customInstructions 字段是 **per chain link** 的，不会污染其他 link。例：

> Teach like Paul Graham teaches startups: start from a counter-intuitive observation, derive its mechanism in 2-3 short paragraphs, end with a specific actionable test the reader can run this week.

每条 instruction 会作为 `<TUTOR_PROFILE>` 块注入该 chain link 所有 lesson 的 system prompt。

### 备份策略

整个 `%APPDATA%\Hypha\data\` 是普通文件夹。推荐：

1. **git**：在 data 根 init 一个 git repo，gitignore `events.jsonl`（高频 append）和 `.beiking/corpus-strength.json`（cache，可重建）
2. **OneDrive / iCloud**：直接把 `%APPDATA%\Hypha\data\` 软链到云盘目录
3. **手动**：每周 zip 一份扔 NAS

### 跨机同步

设 `HYPHA_DATA=<云盘里的 vault 路径>` 环境变量，所有机子指向同一目录。注意 events.jsonl 和 atlas json 的并发写入冲突——同时只在一台机用比较安全。

### chain 的删除

直接在 `%APPDATA%\Hypha\data\` 下删掉 chain meta 文件夹 + 所有同 chainSlug 的 link 文件夹。Hypha 不会缓存这部分，下次启动 vault.list() 自然不再显示。

### 切换 vault

设环境变量 `HYPHA_DATA` 指到新目录。重启 Hypha。或在 colophon 改 vault root（如果 UI 暴露了的话）。

---

## 附：file:line 索引（按代码读源）

| 想看 | 文件 |
|---|---|
| vault 路径解析 | `app/main.js:105-113` |
| chain/link/lesson 数据扫描 | `app/lib/vault.js:77-272` |
| user-profile 提取 | `app/lib/userProfile.js:153-244` |
| user-profile 注入 prompt | `app/lib/userProfile.js:121-143` |
| provider 注册表 | `app/lib/providers.js:14-148` |
| 长卷 + chain rail 渲染 | `app/ui_kits/ptor-app/HandscrollNav.jsx` |
| view mode toggle | `app/ui_kits/ptor-app/App.jsx:1140-1142` |
| Cmd+, 键绑定 | `app/ui_kits/ptor-app/VaultTree.jsx:286-293` |
| event log 写入 | `app/lib/event-log.js` |

---

最后修订：2026-05-02。基于 v0.11.x 长卷布局。如代码与本手册不符，以代码为准。
