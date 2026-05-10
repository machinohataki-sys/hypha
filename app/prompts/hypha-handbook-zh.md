---
title: "Hypha 用户手册"
ghost: false
hypha_handbook: true
date_created: 2026-05-04
---

# Hypha 用户手册

> 假装你是 8 岁。我会把每个东西从头讲一遍。已经懂的部分跳过就好。

---

## 1. Hypha 是什么

**Hypha 是一个本地小屋**。你在里面做三件事：

1. **写笔记** — 任何想记的东西
2. **建课程** — 选一个想长期学的话题，让 Hypha 帮你做一套循序渐进的课
3. **和老师对话** — 在每节课里问问题、被问问题，学完了笔记自动整理好

它**不是**：
- 不是聊天 app（聊完就忘）
- 不是云端 SaaS（你的笔记都在你电脑上）
- 不是搜索引擎（它读的是**你已经写过的东西**）

它的灵魂是：**你写的笔记越来越多，agent 读你的笔记就越来越懂你**。

---

## 2. 第一次怎么用 — 配 OAuth Token

Hypha 自己不会思考。它的"老师"是 Claude（Anthropic 的 AI）。所以你得告诉 Hypha 怎么连 Claude。

### 步骤 1：在系统命令行（cmd / terminal）跑

```
claude setup-token
```

这是 Anthropic 官方提供的一次性长期 token 生成命令。它会在浏览器打开 OAuth 页面，让你登录 Pro/Max 账号，然后在终端里打印一长串 token（大约 100 多个字符）。

### 步骤 2：复制那串 token

整行选中，复制（Ctrl+C / Cmd+C）。

### 步骤 3：在 Hypha 任何输入框里粘贴

打开 Spotlight（按 **Ctrl+;** 或 **Cmd+;**），输入：

```
/token <把刚才那串粘贴在这里>
```

按 Enter。看到 `〔terminal〕✓ token 已存 (len=...)` = 完事。

### 步骤 4：验证

输 `/status` → 应该看到 `✓ OAuth token 已存`。

随便问一句 `1+1` → 应该返回内容（不是错误）。

---

## 3. Hypha 主屏幕的几个区域

打开 Hypha 你会看到：

- **左边**：黄铜色细线 = Chain Stroke Rail（章节链）。每一道线代表一个课程主题。
- **中间**：当前打开的笔记（NoteView）。这是你最常看的地方。
- **底部**：Handscroll Footer = 当前章节的所有 lesson，圆点表示。亮的=当前位置。
- **右边**：导航卡片（NavRail）+ ConceptAtlas（概念图谱）。

你可以**忽略所有这些**，专注于中间的 NoteView 也完全够用。其他都是辅助。

---

## 4. 写笔记 / 读笔记 (NoteView)

### 模式切换

- **单击** = 阅读模式（渲染 markdown）
- **双击** = 编辑模式（textarea）

### 选段操作

- **选中一段文字 + 按 Ctrl+Shift+D** → 弹出"Deepen 浮卡"，agent 会对这段做 5 段深化分析
- 浮卡里你可以选 "Keep" 把分析追加到笔记末尾，或 "Discard" 丢掉

### 课程笔记的两层

每个课程 lesson 笔记里有两个 section：

- **`## 课程基础`** — agent 写的（这一节学到的内容）
- **`## 用户灵感`** — 你写的（被这节课触发的你自己的想法）

千万**不要混了**。课程基础是 agent 的，用户灵感是你的。

---

## 5. Spotlight (Ctrl+; / Cmd+;)

**最常用的入口**。任何时候按 Ctrl+; 弹出全局问答框。

### 怎么问

直接输你的问题，回车。如果当前打开了一个 note，agent 会自动看到那个 note 的前 2000 字作为上下文。

### 用 @prefix 切 agent

输 `@list` 看可用的 agent。
输 `@some-agent 你的问题` 用别的 agent。
默认是 `@default-tutor`。

### 完成后的 3 个动作（marginalia 行）

agent 答完了，输出下面会出现一行 italic 边批：

```
续问 · 摘入页边 · 自添一笔                notes/foo.md
```

- **续问**：再问一个，会带上之前几轮作上下文
- **摘入页边**：把这次的 agent 输出整段塞进当前 note 末尾（作为 `> [!spotlight]` 引用块）
- **自添一笔**：弹出 textarea，你写自己被触发的灵感，存到 `## 用户灵感` 段
- **右边斜体的 path**：当前打开的 note rel

### Fold ↘

agent 流式期间，modal 头部右上有 `fold ↘` 按钮。点了 → modal 缩成右下角小药丸。你可以去看别的笔记，等它流完会闪光（黄铜色脉冲）。点药丸恢复。

### Esc 关闭

streaming 中按 Esc = abort + 关闭。capture 模式中按 Esc = 退到 view 模式。

---

## 6. 建课程

### 步骤

1. 点 VaultTree 里的 `+`（compose）
2. 选 `New shelf`（新课程）
3. 填 **Topic**（话题）+ **Goal**（目标）
4. 等几十秒（Hypha 在 harvest 资料 + designSequence）

### 看到的结果

- 1 个真正的 lesson 0（标题、learn_goal 都是真的）
- N 个 ghost lessons（lesson 1 到 N-1）：标题暂时显示 italic learn_goal + 〔题目待落笔〕

**不用担心 ghost**。每上完一节课，下一节会自动落笔（JIT-recast）。

---

## 7. 上课 — Lesson Chat

打开任何课程 lesson → 底部出现 chat 框。

### 怎么开始

第一次打开会自动 `__begin__`，老师开口。或者你输入 `开始` 也行。

### P6 PRIOR-INSTALL — 第一节的开场

如果这个概念你**没接触过**，老师会先讲 4 段：

1. **DEFINE** — 用最朴素的话定义概念
2. **ANALOGIZE** — 一个具体比喻让概念有"身体"
3. **CHECK** — 让你用自己的话复述（费曼式回讲）或回答一个具体实例
4. **EXTEND** — 上面通过了才进下一层

老师**先讲再问**，不是"啥都没讲就一堆引导问题"。

### 如果你已经懂这个概念

笔记标题旁边会出现一个 italic 边批：

```
〔已知此概念，直问〕
```

点一下 → 下次（包括以后引用同一 concept_id 的课）都跳过 P6 铺垫，直接深问。

反过来如果状态显示你已经懂了但你想再听一遍：

```
〔讲一遍再问〕
```

点一下 → 这次强制 P6 铺垫一次。

### 完成一节

输 `/finish` 或点上方的 `Finish` 按钮 → agent 把对话蒸成笔记 → 写到这一节的 `## 课程基础` 段 + 你给的 insight 写到 `## 用户灵感` → 下一节 ghost 自动落笔（你会看到 `〔terminal〕下一节已落笔 · ...` 的小提示）

---

## 8. Slash 命令完整列表 (任何输入框可用)

| 命令 | 干什么 |
|---|---|
| `/help` | 列出所有命令 |
| `/login` | 看怎么拿 OAuth token（不直接登录，因为 Hypha 没 TTY） |
| `/token TOKEN` | 粘贴 setup-token 的输出 |
| `/logout` | 清掉存的 token |
| `/status` | 看 token 状态、模型、登录情况 |
| `/model X` | 切到模型 X（如 `claude-opus-4-7` / `claude-haiku-4-5`） |
| `/clear` | 清当前对话视图（**不影响**已存的笔记） |

未知 / 命令会回 `〔terminal〕未知命令 — 试试 /help`。

---

## 9. 笔记结构 — 双层（Eternal Law #7）

每个课程 lesson 笔记必须长这样：

```markdown
---
lesson_idx: 0
learn_goal: ...
locked: false
topic_slug: my-course
concept_id: some-concept
---

# 标题

## 课程基础
（agent 蒸出来的内容）

## 用户灵感
*2026-05-04*
（你被这节课触发的、独立切出来的想法）
```

`## 课程基础` 是 agent 写的、教学产物。  
`## 用户灵感` 是你切的、被触发的洞见。

为什么分层：因为只有"你独立切出来 + 用过 + 用对"的概念，才算真的 settled。Hypha 的 cure-clock（spaced revisit）只跟踪 settled 概念，不跟踪 agent 灌给你但你没消化的。

---

## 10. 设置 / Colophon (Cmd+,)

按 `Cmd+,` 打开 Colophon — 这里是设置面板。可以：

- 看 Installation 状态（哪个 LLM、什么版本）
- Test 一下连接是否通
- 重新 install / uninstall claude CLI
- 切 default view（evolution / recall）
- 切语言

---

## 11. 美学约定 — 为什么这样

Hypha 不是 SaaS，是**手稿阅读室**。

- **不要找按钮**：没有矩形、没有阴影、没有圆角填充。所有"可操作"靠 hover 时浮出的黄铜色细线（顶发线）。
- **italic Garamond**：装饰、标签、边批、状态。
- **roman**：操作词、标题。
- **黄铜色**：当前焦点 / 可点击 / 高亮。
- **米白纸**：背景。
- **没有 emoji**（除非系统级提示）：不要看到🔥🚀，看到就告诉我，是 bug。

为什么不像别的 app：因为 Hypha 优先**慢、专注、深读**。你不需要每秒被打断的红点提醒。

---

## 12. 卡住了怎么办

### 老师不回复 / 报错

1. 输 `/status` — token 还在么？
2. 没 token → 看第 2 节重做
3. 有 token 但还报错 → 打开 cmd 窗口跑 Hypha-personal.bat 看 console 日志
4. console 里看 `[agent:invoke]` 行，最后一条 cost=$ 是不是 0（0 = 没打到 API）
5. 看到 `[claude_code_meta_leak]` warning → agent 透出了 Claude Code 元话（去 issues 反馈具体 marker）

### 老师说话奇怪（"plan mode" / "TodoWrite" 等元词）

这是 persona pollution。沙盒应该挡住，挡不住 = bug。把那条具体词复制提交 issue。

### 笔记 ghost 一直 pending

每完成一节后等 5-10 秒，下一节会出 `〔terminal〕下一节已落笔` 提示。如果一直没出 → console 看 `[lesson:finish]` 后续日志。

### Spotlight 没反应

按 Ctrl+; 没弹出 → 可能你在 contentEditable 区（NoteView 编辑模式）。点空白处再按。

---

## 13. 第一周建议节奏

- **Day 1**：`/token` 配通 → Spotlight 测一遍 → 写一篇随手笔记
- **Day 2**：建一个 4 周的课程（比如 "现代密码学"、"人格心理学" 等你真正想学的），让 Hypha 出 sequence
- **Day 3-7**：每天上 1 节课，每节末尾**写一段** `## 用户灵感`（哪怕一句）
- **Day 7 反思**：用 Spotlight 问 `@default-tutor 我这周学了什么？` — 它应该能从你的笔记里拼出来

---

## 14. 词汇表

| 词 | 意思 |
|---|---|
| **vault** | 你的笔记库（一个文件夹） |
| **lesson** | 一节课 = 一个 .md 文件，frontmatter 有 lesson_idx |
| **chain** | 一系列 lesson（一个课程） |
| **archetype** | 课程类型：TECH-CONCEPTUAL（概念）/ TECH-PROCEDURAL（流程）/ HUMANITIES（人文）/ LANG-ACQ（语言）/ DECL-MASS（记忆）/ MINDSET（心法） |
| **P1-P6 / F1-F3** | 教学律（pedagogy primitives）— 见 `app/lib/pedagogy.md` |
| **ghost lesson** | 还没生成内容的 lesson（标题显示 〔题目待落笔〕） |
| **concept_id** | 概念的 kebab-case 标识（如 `attention-qkv`） |
| **cure-clock** | 概念再回访的间隔时钟（FSRS-like） |
| **settled_by_user** | 用户独立用对一个概念 = 真的学会了 |
| **agent** | 一个有自己 system-prompt + 记忆的 actor（住在 `.agents/<name>/`） |
| **spotlight** | 全局问答 overlay (Ctrl+;) |
| **OAuth token** | claude setup-token 输出的长期凭证 |
| **沙盒** | Hypha 给 claude 用的隔离 home 目录（避免你机器上其它 Claude Code 配置 / 全局 CLAUDE.md 的元认知漏过来） |

---

## 15. 还有什么不会问

打 `/help` 或者读这份手册再读一遍。

或者直接打开 Spotlight，问：

```
@default-tutor 我刚刚没看懂手册里第 X 段，给我讲讲
```

老师会基于这份手册（也是 vault 里的一个 note）回答你。

---

*这份手册本身也是一个笔记。它住在 vault 根目录的 `0-用户手册.md`。你可以编辑它（虽然我建议不要）、可以基于它问问题、可以把里面的段落选中 Ctrl+Shift+D 让 agent 帮你深化。*

*欢迎来到 Hypha。*
