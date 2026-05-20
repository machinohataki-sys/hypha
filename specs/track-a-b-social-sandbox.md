# Track A/B External Social Sandbox · Implementation Spec

**Status**: NEW 2026-05-19 (v0.5.0 P1 design lock)
**Blueprint cross-ref**: §26 of `HYPHA_final_blueprint_and_evolution_roadmap.md` (External Social Sandbox)
**Sister layers**: `specs/anti-slop-layer.md` (P7 output trust) + `specs/persona-coherence-layer.md` (P8 agent trust) — Track A/B is the **external trust layer** of the same stack.
**Project ref**: `E:\victor\hypha\CLAUDE.md` System 4 (Creation) + System 3 (Note) + WHY block.

---

## 1. WHY · 这层为什么存在

HYPHA 的 WHY 第一句 (per `CLAUDE.md` line 13):

> 学的每一段最后必须用自己话讲给真人 (Track B) 或亲手做成可被人用的产品 (Track A)，等真人 push back 才算真懂。

Track A/B 不是发布功能, 不是社交模块, 不是 "shareable cards"。它是 HYPHA 区别于 Coursera / Notion / ChatGPT-tutor 的**唯一外部信号通道** — 真人反应作为认知 ground-truth, 抵消三件事:

### 1.1 反工业化教育

"定义 → 记忆 → 测验" 是流水线产物。学完一节 lesson, 内部 Feynman Test 通过 → user 仍未离开 HYPHA 这个**自验证容器**。容器内的所有判定 (Mastery Score / Confession Layer / Persona Coherence) 都是 HYPHA 自己生成 + HYPHA 自己评分。**自评本质上是封闭环**。

Track A/B 强制打开这个环。一段课程的真正终点 = 某个 HYPHA 之外的真人, 看到 user 产出的 artifact 或 writeup, 然后 push back (评论 / 提问 / 修正 / 引用 / fork / 嘲讽 / 沉默)。沉默也是信号。

### 1.2 反 AI 伪知识

`specs/anti-slop-layer.md` 处理 AI 生成层的 Apparent-Success-Seeking。但 user 自身也可能 Apparent-Success-Seek: 跟 HYPHA 聊完感觉懂了 → 实际上没懂。

唯一能切断 user 自欺的信号 = user 必须用自己的话, 面对**没有上下文的真人**, 重述这个概念。真人不会客气, 真人会问 "那为什么不是 X?", 真人不读 HYPHA, 真人不知道 lesson context — 真人是天然的 zero-shot adversary。

### 1.3 反 Persona Fragmentation

`specs/persona-coherence-layer.md` 处理 AI 的人格碎片。user 也有人格碎片 — 同一概念在 HYPHA 里和在 Twitter 上和在公司 standup 上, user 会用三种 register 描述, 三种深度。**外部发布强制 register 收束** — user 必须选一个 register 面对真人, 这个选择本身揭示 user 真实的概念稳定度。

---

## 2. Track A · 课程 = 产品

### 2.1 定义

Track A: 每节课的产出 → **一个 HYPHA 之外的真人可以使用的 artifact**。

不是 "shareable summary card"。不是 PDF export。是 user 用 lesson 学到的东西**亲手做出来的**可被独立使用的物件 — code / doc / template / framework / dialog / chapter / SOP。

### 2.2 按 archetype 的产出形态

| Archetype | Track A artifact 示例 | 验收形态 |
|---|---|---|
| **TECH-CONCEPT** | npm package / GitHub repo / 可运行 demo / 文档站 | repo URL + README 引用 lesson 上下文 |
| **HUMANITIES** | Substack 长文 / book chapter / 文学评论 / 翻译批注 | post URL + 引文链接到原 source |
| **MINDSET** | SOP / playbook / 决策框架 PDF / Notion template | 公开 doc URL + 第 1 个使用者反馈 |
| **LANG-ACQ** | dialog scripts / mini-lesson 给他人 / 翻译对照集 | 公开 scripts URL + 学习者使用记录 |
| **LITERATURE** | 短篇 / 章节 / 评论 / 改编 / 续写 | 公开发布 URL + 阅读者评论 |
| **DOMAIN-PRACTITIONER** | 行业 case study / 模板 / checklist / 工具 | 公开发布 URL + 同行引用或反馈 |

### 2.3 验收 criteria

artifact 须满足全部 3 项:

1. **Public URL** — GitHub repo / Substack post / Notion public / Google Doc public / 任何无需 user 邀请就能访问的 URL
2. **Provenance link** — artifact 内部 (footer / About / README) 明示引用回 HYPHA lesson 的概念锚 (lesson slug + concept name)。这是 HYPHA 单向引用回 artifact, artifact 单向 reference 回 lesson — 双向 provenance
3. **≥ 1 external person engaged** — star / 评论 / fork / 引用 / 阅读 (above noise threshold) / 真人转发

"≥ 1" 是 MVP 阈值。真实质量门 (≥ N 高质评论 / ≥ N 引用) 在 v0.6+ 引入 External Validation Mass 多档评级。

### 2.4 Track A 的反模式

- artifact 是 HYPHA 自动生成的 summary card → 不算 (user 没做)
- artifact 只 user 自己能访问 → 不算 (没公开)
- artifact 公开但没有任何真人 engagement 7 天 → flag 为 "Exposed 但未 Validated", state 不进 Validated

---

## 3. Track B · 笔记 + 发布

### 3.1 定义

Track B: 用 user 自己的话, 把 lesson 学到的东西**讲给真人**。文本 / 视频 / 演讲。

Track A 是产物, Track B 是叙述。两条都是合法的 exit ramp, 二选一或都做。

### 3.2 发布渠道示例

| 渠道 | 形态 | 验收信号 |
|---|---|---|
| **Twitter / X thread** | 5-15 tweet thread | reply / quote-tweet / bookmark above threshold |
| **小红书 post** | 笔记 + 图 | 评论 / 收藏 / 转发 |
| **微博** | 长微博 | 评论 / 转发 |
| **Substack newsletter** | 长文 + 订阅链 | 订阅 / 评论 / 转发 |
| **YouTube / Bilibili 视频** | explainer / 教学视频 | 评论 / 点赞 / dislike (dislike 也是信号) |
| **Conference talk / meetup** | 现场分享 | 提问数 / 录像 URL + 评论 |
| **Discord / Slack 社区** | 长 thread | reply / reaction / cross-post |
| **个人博客** | post + RSS | 评论 / pingback / 引用 |

### 3.3 验收 criteria

publication 须满足全部 3 项:

1. **Public URL** — 任何可被搜索引擎或社交平台外链命中的 URL (RSS / 公开 thread / public post)
2. **Mentions HYPHA lesson** — 文中或 footer 提及 lesson 概念 (不要求 HYPHA 品牌曝光; 但需 user 自我标记可追溯)
3. **≥ N real reactions** — N 按渠道差异化:
   - Twitter thread: ≥ 3 reply (不含 user 自己)
   - 小红书: ≥ 5 评论 OR ≥ 20 收藏
   - Substack: ≥ 3 评论
   - YouTube: ≥ 5 评论 OR ≥ 100 view
   - 现场分享: ≥ 3 现场提问 (user 自报)

阈值是 v0.5.0 MVP, 后续按 cohort 反馈调整。

### 3.4 Track B 的反模式

- 转发 HYPHA 生成的卡片不算 (user 没用自己的话)
- 只发"今天学了 X"不算 (没讲清概念)
- 朋友圈 (非公开渠道) 不算 (无 push back 通路)
- 自己买点赞 / 互赞群 / 雇佣评论 → Anti-fake-engagement gate 拦截

---

## 4. Mechanism · Mode Router + Lesson Exit Ramp

### 4.1 触发点

每节 lesson 结束 (`/finish` ritual 完成后), 在 Course Trust Panel 下方注入 **Exit Ramp** 块:

```
本节学完 — 你打算把它带出 HYPHA 吗?

[ A · 做成 artifact ]      把这节课变成可被他人使用的物件
[ B · 讲给真人 ]            用你自己的话写出来, 发布到真人在的地方
[ — · 私自学习 ]           暂时不外推; 记入私下学习日志
```

### 4.2 用户选择后流程

#### 选 A · Track A
```
HYPHA 接着问 2 个问题:
1. artifact 形态? (code / 文章 / SOP / dialog / 其他)
2. 计划发布 URL? (如未做完: future-stamped commitment, 例如 "7 天内 push to github.com/<user>/<repo>")

→ 写入 vault/<slug>/exit-ramps.jsonl
→ 状态: Exposed (待 artifact URL 提交) 或 Committed (future-stamped)
```

#### 选 B · Track B
```
HYPHA 接着问 2 个问题:
1. 发布渠道? (Twitter / 小红书 / Substack / 视频 / 现场 / 其他)
2. 计划发布 URL or 时间窗? (如未发: future-stamped)

→ 写入 vault/<slug>/exit-ramps.jsonl
→ 状态: Exposed (待 URL 提交) 或 Committed
```

#### 选 Skip
```
→ 写入 vault/<slug>/exit-ramps.jsonl, track="skip", reason: 可选
→ 状态: Crystallized (per Note state machine), 不晋级 Exposed
→ Mode Router 在该 lesson 的 Mastery Score 上贴 "private-only" 标签 — 不扣分, 但 Trust Formula 的 External Validation 维度为 0
```

### 4.3 Exit Ramp record schema

```jsonc
// vault/<slug>/exit-ramps.jsonl 一行一条
{
  "ramp_id": "uuid-v4",
  "lesson_idx": 3,
  "lesson_slug": "graph-neural-network-basics",
  "ts_created": "2026-05-19T10:32:00+08:00",
  "track": "A" | "B" | "skip",
  "artifact_kind": "code" | "doc" | "post" | "video" | "talk" | "sop" | "dialog" | "other" | null,
  "channel": "github" | "substack" | "twitter" | "xhs" | "weibo" | "youtube" | "bilibili" | "blog" | "talk" | "other" | null,
  "url": "https://...",                    // null if Committed (future-stamped)
  "committed_deadline": "2026-05-26T23:59:59+08:00" | null,
  "state": "Committed" | "Exposed" | "Validated",
  "ts_last_pinged": "ISO-8601 | null",
  "validation_mass": 0,                    // updated by track-validator
  "reactions": [                            // updated by track-validator
    { "kind": "star" | "comment" | "reply" | "fork" | "cite" | "view", "count": 12, "ts": "ISO-8601" }
  ],
  "fake_engagement_flag": false,
  "user_self_report": "可选 user 在 future-stamped 到期后手动汇报的 narrative"
}
```

### 4.4 Mode Router 耦合

Mode Router (System 1 Goal System) 在 lesson 完成后写 mastery 信号。Track A/B 选择不改变 mastery 分数, 但加一个**外部信号期望**字段:

```jsonc
// state.json lesson[idx]
{
  "mastery": 0.78,
  "exit_ramp_track": "B",
  "exit_ramp_state": "Committed",
  "external_validation_mass": 0,
  "external_validation_expected_by": "2026-05-26"
}
```

到期未 Validated → Mode Router 在下一节 lesson 起手注入 prompt: "上节你 commit 了发布给真人, 还没拿到回应。我们要不要回头重写, 或换 Track?"

---

## 5. Verification Harness

### 5.1 Track A artifact pinger

`app/lib/track-validator.js` 提供:

```js
async function pingArtifact(rampRecord) {
  // 1. fetch URL (5s timeout, rate-limit 1/hr per URL)
  // 2. parse channel-specific metadata
  //    - github: stars / forks / open issues / latest commit ts
  //    - substack: subscriber count (if public) / reactions / comments
  //    - notion: last-edited / view count (if API allows)
  // 3. compute validation_mass (see §6)
  // 4. update rampRecord.reactions + rampRecord.ts_last_pinged
  // 5. write back to exit-ramps.jsonl
}
```

调度: `lesson:dev:tick` 类的轻 cron, 每小时跑一次, 但每条 ramp 最多 1 ping/hr。

### 5.2 Track B 评论 / 回复扫描

二阶段:

**v0.5.0 (MVP)**: user 手动提交 reaction count + 粘贴关键评论文本。HYPHA 把粘贴的评论存入 `vault/<slug>/exit-ramps-replies.jsonl`, LLM 提取 question / critique / correction 标记, 注入下一节 lesson 的 prep。

**v0.6+ (自动)**: 用 `bb-browser` skill scrape 公开 thread (Twitter API 限制后改 headless browser); 或 user 提供 RSS / public JSON endpoint, HYPHA 自动拉取。

### 5.3 Push-back ingestion → next lesson prep

```
exit-ramps-replies.jsonl
  → LLM 提取 {question | critique | correction | praise | confusion}
  → 写入 vault/<slug>/pushback-digest-L{idx}.json
  → 下一节 lesson designLesson 时, prompt 注入:
    "上节发布后真人提了这些问题 / 反驳 / 修正: ..."
    "本节如果还想推进, 必须先处理这些 push back。"
```

这把 Track A/B 从 "记录功能" 变成**真正的认知反馈回路** — 真人的怀疑直接驱动下一节课的方向。

---

## 6. Provenance Signal · External Validation Mass

### 6.1 公式

per `CLAUDE.md` WHY block:

```
Trust = Capability × Evidence × Reasoning Legibility × Persona Coherence × Failure Honesty
```

v0.5.0 引入第 6 维:

```
Trust = Capability × Evidence × Reasoning Legibility × Persona Coherence × Failure Honesty × External Validation Mass
```

`External Validation Mass` ∈ [0, 1]; 由 reactions 加权计算:

```
mass_raw =
    citations × 10
  + comments × 4
  + replies × 3
  + forks × 5
  + stars × 1
  + shares × 2
  + views_above_threshold × 0.1

mass = min(1.0, log10(1 + mass_raw) / 2)
```

log 压缩防止 10k star 单条 artifact 把 trust 拉到 ∞; 阈值 1.0 在 mass_raw ≈ 100 附近达到。

### 6.2 多重 artifact 聚合

一节 lesson 可能产出多个 artifact (Track A + Track B 双发)。lesson 级 mass:

```
lesson_mass = 1 - product(1 - mass_i for each artifact_i)
```

(独立信号合并的概率式, 避免单纯加和爆表)

### 6.3 课程级 mass

```
chain_mass = mean(lesson_mass for each lesson with exit_ramp != "skip")
```

skip 的 lesson 不进分母, 不惩罚用户合理的私自学习选择。

### 6.4 UI 暴露

Course Trust Panel 新增一行 (default tier, 不只是 expert):

```
本课外推 · 真人反应 N · Validation Mass 0.42
```

editorial register, 数字本身不构成游戏化得分。

---

## 7. State Machine Extension (Note System)

per `CLAUDE.md` System 3: "Note state machine (Raw → Crystallized)" — 扩展为 4 态:

```
Raw → Crystallized → Exposed → Validated
```

| 态 | 定义 | 触发 |
|---|---|---|
| **Raw** | 课中产生的笔记 / 灵感, 未蒸馏 | lesson 进行中 |
| **Crystallized** | dual-layer distill 完成 (`课程基础` + `用户灵感`) | `/finish` ritual 完成 |
| **Exposed** | 经 Track A 或 Track B exit ramp 发布 | user 在 ramp 提交 artifact URL |
| **Validated** | 至少 1 个 external real human 反应 | track-validator ping 返回 ≥ 1 reaction |

### 7.1 退化态

- Validated → Exposed: artifact 撤下 / URL 404 / 真人删评 (mass 归零) → 状态退回 Exposed
- Exposed → Crystallized: user 手动撤回发布意愿 (rare)
- Crystallized → Raw: lesson 重写 / dual-distill 重新生成 (rare, manual)

### 7.2 状态对 Mode Router 的影响

```
状态           Mode Router 建议
Raw            继续学
Crystallized   可以考虑 exit ramp
Exposed        等待真人 push back, 不急于下一节
Validated      可以 advance + push back 已 ingestion
```

Mode Router 不强迫推进; 但若用户连续 3 节 lesson 都 skip Track A/B, Mode Router 在第 4 节起手提醒: "你已经 3 节没把学到的带出 HYPHA 了 — 是否回看其中一节做 exit ramp?"

---

## 8. Anti-pattern Protection

### 8.1 Anti-fake-engagement

刷量 / 互赞群 / sockpuppet / 雇佣评论 — 这些信号若计入 Validation Mass, 整个 Trust Formula 崩。

**检测 (v0.5.0 MVP, 启发式)**:

1. **地理 IP 多样性** — Track A 的评论 / Track B 的 reply 若全部来自 ≤ 2 个 IP region → flag `fake_engagement_flag: true`
2. **账号年龄** — 评论者账号 ≥ 80% 都 < 30 天 → flag
3. **同步性** — 评论时间集中在 < 5 分钟窗口 → flag
4. **互推图** — user 自己关注的 ≤ 50 人池里产生 ≥ 80% 的 reaction → flag (互赞群特征)

flagged ramp 的 mass = 0.1 × computed_mass (不归零, 但严重打折); UI 红色标 "外部信号疑似刷量, 已降权"。

**v0.6+ 升级**: 用 graph community detection / 时序熵 / NLP 评论质量评分。

### 8.2 Anti-vanity-metric

View / impression / like 都是低质信号。权重已在 §6.1 公式中体现:

```
citations(10) > forks(5) > comments(4) > replies(3) > shares(2) > stars(1) > views(0.1)
```

stars 比 views 高, 但远低于 comment。原则: **写下来的字 > 点过去的指头 > 看过的眼睛**。

### 8.3 Anti-self-deception (HYPHA 内部信号不计)

任何 HYPHA-issued 的 "ratify badge" / "internal review pass" / "self-Feynman pass" 都**不算** External Validation。Validation Mass 公式只接受 HYPHA 之外的真人信号。

这是硬规: 若 v0.5.0 实现中发现某代码路径把 HYPHA-internal 信号灌进 mass, 立刻 patch。

### 8.4 Anti-vanity-track-B (我发了但没人看)

Track B 发布 7 天后, reactions = 0 → 状态保持 Exposed, **不**自动升级 Validated。HYPHA 反馈给 user: "你讲给真人了, 真人没回应 — 这本身是信号。要回头看为什么没人 engage, 还是把这节挪到 Track A?"

这是 anti-Apparent-Success 的外推版: 发布 ≠ 真懂, 沉默是诚实的 push back。

### 8.5 Anti-coercion (HYPHA 不能 push user 必须公开)

某些 lesson topic (个人健康 / 隐私话题 / 高敏行业) user 合法选择永远 skip。Mode Router 的提醒 §7.2 在 user 显式设置 `private_only: true` 后停止。设置入口在 lesson-level 和 chain-level。

---

## 9. v0.5.0 Implementation Scope (5-day estimate)

### 9.1 Day 1 · 数据层

**新文件**:
- `app/lib/track-validator.js` (~250 LOC) — pingArtifact / parseGithub / parseSubstack / parseTwitter (manual mode) / computeMass / detectFakeEngagement
- `app/lib/exit-ramp-store.js` (~120 LOC) — JSONL append + read filtered by lesson + state transitions

**Schema**:
- `vault/<slug>/exit-ramps.jsonl`
- `vault/<slug>/exit-ramps-replies.jsonl`
- `vault/<slug>/pushback-digest-L{idx}.json`
- `state.json` lesson[idx] 加 4 字段 (exit_ramp_track / exit_ramp_state / external_validation_mass / external_validation_expected_by)

### 9.2 Day 2 · IPC + Backend

**新 IPC handler (`app/main.js`)**:

```js
ipcMain.handle('track:set-exit-ramp', async (_, { slug, lessonIdx, track, artifactKind, channel, url, committedDeadline, reason }) => { ... });
ipcMain.handle('track:get-status', async (_, { slug }) => { ... });  // returns ramps + counts + mass
ipcMain.handle('track:submit-url', async (_, { slug, rampId, url }) => { ... });  // upgrade Committed → Exposed
ipcMain.handle('track:ping', async (_, { slug, rampId }) => { ... });  // manual ping trigger
ipcMain.handle('track:submit-reply', async (_, { slug, rampId, replyText, replyAuthor, replyTs }) => { ... });  // Track B 手动粘贴评论
ipcMain.handle('track:get-pushback-digest', async (_, { slug, lessonIdx }) => { ... });
```

**Cron hook**:
- 在 main process 启动后挂一个 60-min interval, 遍历 active vault 的 exit-ramps, 调 `pingArtifact` 按 rate-limit 处理

### 9.3 Day 3 · UI · Exit Ramp 块

`app/ui_kits/ptor-app/NoteView.jsx` 的 `LessonChat` 末尾, `/finish` 后注入 `ExitRampPanel`:

```jsx
<ExitRampPanel
  slug={slug}
  lessonIdx={lessonIdx}
  archetype={archetype}
  onSelect={(track, payload) => trackSetExitRamp(slug, lessonIdx, track, payload)}
/>
```

3 个按钮 + 选 A/B 后弹 2-question follow-up (artifact_kind / channel + url-or-deadline)。

Manuscript register: italic Garamond 标题 "本节学完 — 你打算把它带出 HYPHA 吗", roman 按钮; 不用 emoji, 不用 ! .

### 9.4 Day 4 · UI · Trust Panel + Track Ledger

**Course Trust Panel** (`app/design/course-trust-panel.jsx`):
- 新增一段 "外推 · 真人反应"; 显示 lesson-level mass + reaction counts

**Track Ledger View** (NEW `app/design/track-ledger.jsx`):
- chain-level 视图, list 所有 ramps with state + URL + last-pinged + mass
- 可点击单条 → 跳到 lesson + 看 reactions 详情 + 手动 ping 按钮

入口: 左侧 VaultTree 单条 chain 右键菜单 "查看外推" 或 chain header 加按钮。

### 9.5 Day 5 · Smoke + 文档

**Smoke test**:
- `app/scripts/_dev_verify_track_exit_ramps.js`
  - create dummy slug + lesson
  - set ramp A with GitHub URL → ping → assert state Exposed → simulate reactions → assert Validated
  - set ramp B with Substack URL → submit reply text → assert pushback-digest 生成
  - set ramp skip → assert exit_ramp_state = "skipped" + 不进 mass

**文档**:
- `CLAUDE.md` 加一段 v0.5.0 Track A/B 说明
- `app/prompts/hypha-handbook-zh.md` 加一段 8 岁可读 "为什么 HYPHA 让你公开发布"

### 9.6 Out of Scope (defer to v0.6+)

- 自动 scrape Twitter / 小红书 / 微博 (v0.6 用 bb-browser)
- 真正的评论质量 NLP 评分 (sentiment / question detection 进 pushback digest)
- 多平台 OAuth 集成 (v0.6+)
- Cohort-mode (cohort 内 vs 全网 push back, 强 cohort 弱 cohort)
- Anti-fake-engagement 的 graph 算法 (v0.6 图谱分析)
- Track A artifact 自动技术验证 (code 是否编译 / doc 是否渲染) — v0.5.0 全 manual user-confirm

---

## 10. Risks + Open Questions

### 10.1 隐私

artifact URL 可能曝光 user 真实身份 / 雇主信息 / 行业账号。**默认 opt-in**: 全局 setting `track_enabled: false` 出厂; 用户主动 opt-in 后 lesson 末尾才出 Exit Ramp 块。设置入口在 `vault/data/profile.json` + UI Settings 页。

opt-in 后, 每节 lesson 仍可单独选 skip; skip 不计 Validation Mass, 但不扣 Trust。

### 10.2 网络成本

URL pinging 加网络 round-trip 成本。控制:
- 每 ramp 1 ping/hr 上限
- 总并发 ≤ 5
- ping 失败重试 backoff (1m, 5m, 30m, abandon)
- 用户离线时 cron 跳过, 在线时继续

### 10.3 跨平台 scraping

Twitter API 重度限制 (2026 仍未恢复 free tier 数量)。备选:
- v0.5.0: Track B 完全 manual — user 粘贴评论 / 自报数字
- v0.6: `bb-browser` skill 启 headless 抓公开 thread (per `scraping_via_bb_browser` feedback)
- v0.6+: 用户提供 RSS / 自建 endpoint (Substack 内置 RSS 是首选)

小红书 / 微博类似 — Twitter 同策略。

### 10.4 "Real human push back" 定义边界

什么算 push back? v0.5.0 MVP 边界 (粗):
- 计入: 公开账号 ≥ 30 天 / IP 非用户自家 / 评论 ≥ 20 字 (非 "好棒")
- 不计入: 自家小号 / "good post 👍" / 同一互推群历史出现 ≥ 5 次

边缘情况 (付费评论 / 朋友帮忙 / 互推承诺) defer v0.6 — v0.5.0 用启发式拦截 + UI 提示用户人工标记。

### 10.5 课程领域差异

不是每个 archetype 都自然有外部社交场。MINDSET / 私域 SOP 可能合法 private-only。Mode Router 应识别 archetype 自动放宽提醒频率, 别 push HUMANITIES 用户发 GitHub repo。

---

## 11. Honest Gaps (! v0.5.0)

`specs/anti-slop-layer.md` Confession Layer 的 spec 自身也要 confess:

### 11.1 v0.5.0 不做的事

- **真正的对话分析** — sentiment / question detection / sarcasm — defer v0.6
- **多平台聚合** — v0.5.0 只稳 GitHub + Substack + 通用 HTML (open graph); Twitter/XHS/Weibo 全 manual
- **自动 artifact 验证** — Track A 的 code 能否 build / doc 能否渲染, v0.5.0 全 user-confirm; v0.6+ 加可选验证器
- **Cohort 模式** — 分 "对 cohort 公开" / "对全网公开" 两档信号权重 — v0.6
- **回路深化** — push back → 下一节 lesson 自动重新规划 (不只是注入 prompt), v0.6+ 真重规划
- **External Validation Mass 的高阶玩法** — Mass 高的 lesson 反哺 Bibliography Grounding 推荐, defer v0.6
- **匿名 / 化名发布** — Track A/B 允许 user 用化名, 但 HYPHA 不主动建议; 化名信号是否要打折由 v0.6 决策

### 11.2 已知未解决的认知问题

- **沉默是诚实信号 vs 算法没推**: 一条 Substack 0 阅读, 可能是写得差, 也可能是没人订阅。v0.5.0 暂不区分; v0.6 引入 channel reach baseline (per-channel 平均 reach 校正)
- **Track A vs Track B 的转换**: user 先选 A 做了 repo, 后想发 Substack 介绍 repo — 算 A + B 合并, 还是只算 A? v0.5.0: 合并, mass 用 §6.2 公式; v0.6 视使用细化
- **HYPHA 自身的发布提示是否构成 coercion**: §7.2 的 "你 3 节没外推" 提醒, 如果用户反复 dismiss → 必须能彻底关掉; v0.5.0 设置 `mode_router.exit_ramp_nag_enabled: true|false`

### 11.3 v0.5.0 不承诺的事

- 不承诺 Track A/B 完成 = HYPHA 课程 "真懂" — push back 也可能假阳性 (评论者也可能错), validation mass 是**辅助信号**, 不是替代 Mastery
- 不承诺 Validation Mass 跨 archetype 横向可比 — HUMANITIES 的 1 高质评论 ≠ TECH 的 1 star, archetype-aware 权重在 v0.6 引入
- 不承诺 Track A/B 是唯一外推路径 — user 在 HYPHA 之外建群 / 当 mentor 教别人也合法, 只是 v0.5.0 不追踪

---

## 12. Cross-system 接口

### 12.1 与 System 1 (Goal System) 的接口

- Goal Contract 8 字段不变
- Goal Feasibility Guardian 在 chain 创建时**可选**增加 prompt: "是否打算 Track A/B 外推?"; 若用户答 "是" → feasibility 多算一档 (因为外推往往延长时间预算 30-50%)
- Mode Router 状态机增加 "等待外部 push back" 一个 sub-state, 但不强制阻塞下一节

### 12.2 与 System 3 (Note) 的接口

- Note state machine 扩展 (§7)
- Living Note Reactivation (2026-05-15 shipped) 在判断 note 重要性时, **可参考** External Validation Mass — 但权重 ≤ 30%, 避免 vanity-metric 反噬

### 12.3 与 System 4 (Creation) 的接口

- Product Spark 写入时, 若来自 Track A artifact (artifact_kind = code/doc/sop) → auto-link 到对应 Product Spark
- Decision Log 的 `prediction.falsifier` 可引用 ramp URL 作为外部 evidence: "若 30 天内 GitHub stars ≥ 50, 该 Spark 验证为 viable"

### 12.4 与 Anti-Slop Layer (P7) 的接口

- Confession Layer 的 `weakest_link` 字段在 Exit Ramp UI 显式提示给 user: "本节最弱处是 ___, 发布到真人面前时建议主动暴露这一点"
- Gap Detector 的 verified_completion 不变, 但**Apparent ≠ Verified** 在 Track B 发布时尤其放大: 发布出去 → 真人发现 gap → push back 是最便宜的验证

### 12.5 与 Persona Coherence Layer (P8) 的接口

- Character Contract 的 `failure_protocol` 在 Track B 发布建议中体现: "发布时要诚实标 confession, 不要包装"
- Anti-Ingratiation Style Filter 应该**也扫 Track B 发布文本草稿** (user 自愿粘贴给 HYPHA 检查) — v0.6 引入 "publish draft scrub" 入口; v0.5.0 不强制

---

## 13. 验收清单 (v0.5.0 ship gate)

- [ ] `app/lib/track-validator.js` + `app/lib/exit-ramp-store.js` 实现且 `node --check` 通过
- [ ] 6 个 IPC handler 全实现 + 在 preload bridge 暴露
- [ ] `vault/<slug>/exit-ramps.jsonl` schema 写入 / 读取正常
- [ ] state.json lesson[] 4 个新字段 写入 / 读取正常
- [ ] `ExitRampPanel` 在 `/finish` 后渲染, 3 按钮可点
- [ ] 选 A/B 后 follow-up 2-question 弹窗工作
- [ ] Course Trust Panel "外推 · 真人反应 N" 行渲染
- [ ] Track Ledger view 可打开, list 显示, 单条点击展开
- [ ] `pingArtifact` 对 GitHub repo URL 能拿 star + fork count
- [ ] `pingArtifact` 对 Substack URL 能拿 reaction count (open graph fallback)
- [ ] manual reply submit 工作; pushback-digest 文件生成
- [ ] cron 60-min 跑无报错; rate-limit 1/hr 生效
- [ ] Anti-fake-engagement 启发式 4 项至少 1 项命中 dummy 数据时 flag
- [ ] `_dev_verify_track_exit_ramps.js` smoke 全绿
- [ ] `CLAUDE.md` 更新 + `hypha-handbook-zh.md` user-facing 段落
- [ ] 设置页 `track_enabled` 默认 false, opt-in 后才显示 Exit Ramp 块
- [ ] Mode Router 在 user 设 `private_only: true` 时停 nag

---

## 14. 命名 + register check

- "Track A · 课程 = 产品" / "Track B · 笔记 + 发布" — 不用 "Sandbox" 作为面向 user 文案 (Sandbox 是工程语境), user 看到的是 "外推" / "公开" / "讲给真人"
- 不用 emoji / ! / 营销话术
- 不用 zh AI 流量词 (per `ban_ai_cliche_zh` feedback)
- italic Garamond 仅用于章节标题 / 题词 (per `italic_decoration_only` feedback), 按钮 + 状态行 roman
- 数字暴露 (mass / count) 用 editorial 编辑式语调, 不做 SaaS 大数字 dashboard

---

## Genesis

2026-05-19 lock. HYPHA's WHY 第一句被 HYPHA 内部封闭循环架空 4 个月; 此 spec 是把外部真人重新装回环的工程化路径。v0.5.0 是 5 天 ship 的 MVP; v0.6+ 是把 manual 粘贴 → 自动 scrape, 启发式 → 图谱 / NLP, 单向 push back → 双向重规划。

Tagline: **HYPHA 不替你懂; 真人才能让你懂。**
