# Commons System · MVP Scaffold Spec (v0.5.0-bootstrap)

**Status**: scaffold seed shipped 2026-05-19 (Pack Schema + Pack Loader + 1 seed Pack).
**Supersedes**: prior `specs/commons.md` (134 LOC, 2026-05-07 placeholder).
**Blueprint cross-ref**: §12 Commons System (8-system map, `CLAUDE.md`).
**Roadmap**: v0.5.0 scaffold → v1.9 Alpha → v2.0 Pack Learning Mode → v2.5 Flywheel.
**Code anchors**: `app/lib/commons/pack-schema.js` + `app/lib/commons/pack-loader.js` + `vault/.commons-packs/seed-feynman-method.json`.

---

## 1. WHY — Commons 为什么存在

HYPHA 8-system 中, Commons 是唯一**差异化护城河**。其他 7 系统 (Goal / Lesson / Note / Creation / Source / Exam / Growth / Companion) 在中性 AI 课程产品里都能找到对应; Commons 没有。

三条存在理由:

1. **反知识碎片化 (anti-fragmentation)** — 当前每 user vault 各自 distill / refine / forge, 高质量学习路径困在私域。Commons 把 "已被人验证过的学习路径" 抬到可分享的 first-class object: **Knowledge Pack**.
2. **专家曲线复用 (curated expert curves)** — 让懂某窄域的人 (Feynman Method 专家 / Tolkien 世界观研究者 / 量子计算物理博士) 输出 curated Pack, 把 5 年沉淀压成 5 课时. user 不必从 0 重新踩坑.
3. **反 AI 生成 slop (anti-slop community moat)** — 当 AI 课程产品泛滥, "谁的 Pack 可信" 就是核心问题. Commons 用 community-curated provenance + source_trust + intelligence_card + 外部 validation 信号, 让真实的高质量 Pack 浮出. AI 单方面生成的 slop 拿不到这些信号.

**反例 (Commons 禁止变成的事)**: 评论区 / 私信流 / 关注体系 / 热榜 / 争吵场 / 低质量 AI 自动生成 Pack 市场.

---

## 2. Pack Schema — 包结构 JSON Spec

Pack 是 self-contained JSON 文件, 存于 `vault/.commons-packs/<pack-id>.json`. 字段如下:

```jsonc
{
  "id": "feynman-method-self-explanation",       // kebab-case slug, 3-80 chars, [a-z0-9][a-z0-9-]+
  "name": "Feynman 学习方法 · 自我解释练习包",     // string 3-200 chars
  "version": "1.0.0",                             // semver-ish: M.m or M.m.p
  "archetype": "MINDSET",                         // enum (see below)
  "author": "HYPHA Team",                         // string ≤100 chars
  "license": "CC-BY-NC-4.0",                      // enum (see below)
  "created_at": "2026-05-19T22:00:00.000Z",
  "updated_at": "2026-05-19T22:00:00.000Z",
  "lessons": [                                    // non-empty array
    {
      "topic": "选一个你以为懂的概念",            // required string
      "role": "prerequisite",                     // enum: prerequisite | core | ultimate
      "lessons_count": 1,                         // optional int
      "summary": "..."                            // optional string
    }
  ],
  "distill_log": [                                // optional, audit trail
    { "step": "harvest", "ts": "...", "input_count": 5 }
  ],
  "source_trust": {                               // optional, see §6
    "creator_reputation": "...",
    "external_signals": [{ "type": "book", "ref": "..." }]
  },
  "intelligence_card": {                          // optional, see §3
    "outcomes": ["..."],
    "prereqs": ["..."],
    "time_to_complete": "...",
    "external_validation_required": true
  }
}
```

**ARCHETYPE enum** (8 已注册):
- `TECH-CONCEPT` — 软件 / 工程 / CS 概念
- `HUMANITIES` — 人文 / 文学 / 哲学
- `MINDSET` — 思维方式 / 学习方法
- `LANG-ACQ` — 语言习得
- `EXAM-MASTERY` — 应试型
- `MATH-MASTERY` — 数学方向
- `SCIENCE-WORLD` — 自然科学 世界观
- `CREATIVE-PROJECT` — 创作 / 写作 / 设计

**LICENSE enum**:
- `CC-BY-4.0` — 开放, 仅署名
- `CC-BY-NC-4.0` — 开放, 署名 + 非商业
- `CC-BY-SA-4.0` — 开放, 署名 + 相同方式分享
- `MIT` — 极宽
- `proprietary` — 闭源 (Author 自定条款, Commons 不分发)

**LESSON role enum**:
- `prerequisite` — 前置准备, 必须先过的入口
- `core` — 核心节, 真正的学习负载
- `ultimate` — 终极挑战, 教给真人 / 做成作品

---

## 3. Intelligence Card — 包元数据卡

Pack Intelligence Card 是 user 在 install Pack 前 **10 秒内决定值不值** 的卡片. 目的: 抵御 GitHub-style 海量噪音.

字段:

| 字段 | 类型 | 用途 |
|---|---|---|
| `outcomes` | string[] | 学完能做什么 (具体动作, 非 "理解 X") |
| `prereqs` | string[] | 前置知识 (可为空数组) |
| `time_to_complete` | string | 估计耗时, 给 user 时间预算锚点 |
| `external_validation_required` | bool | 是否必须找真人 push back (Hypha Track B) |
| `not_for_who` | string[] | 不适合的人群 (反向定位, 比正面定位更诚实) |
| `risk_notes` | string[] | 已知风险与缺陷 (诚实声明) |

排序逻辑 (Commons 中 Pack 推荐):
```
score = goal_match × current_lesson_relevance × mastery_map_match
      × current_product_relevance × quality_score × safety_score
      × learning_effect_score × maintenance_freshness
```
**不按热度排**. 热度 = 流量 = AI-slop 滋生条件.

---

## 4. Pack Security Layer — 安全防御

> **Knowledge Pack is data, not executable software.**

**禁止字段或文件类型**: .exe / .msi / .bat / .cmd / .ps1 / 宏文件 / 未知压缩包 / 自动运行脚本 / 浏览器插件 / 远程下载器 / 任何 executable dependency.

**防御 surface**:
- Prompt Injection — Pack 内容拼接进 LLM context 前, 经 sanitizer 剥除 `system:` / `assistant:` 仿造头.
- 钓鱼链接 — 外链需匹配白名单域 (arxiv / pubmed / wikipedia / 出版社 / 学术机构); 否则降级为 plain text.
- 隐私泄露 — Pack 字段不允许写入 user 路径 / 邮箱 / API key.
- 恶意依赖 — Pack 不引入 npm / pip / cargo 依赖. 纯 JSON 数据.
- 伪装系统提示词 — Pack 文本中的 "You are an assistant..." 类 spec-leak 被检测并标记.

**LLM 调用 Pack** 时只读取 **Sanitized Context**, 不读 Raw Pack:
```
raw_pack → sanitizer → sanitized_pack → LLM
```
v0.5.0 MVP: Pack Schema validator 是第一道 (拒绝结构非法 Pack); 完整 sanitizer 留 v1.9.

---

## 5. Pack Distiller — 蒸馏管线 (defer v2.0)

Distiller 把 (corpus → Pack) 自动化. v2.0+ 工作流:

```
corpus (论文 / 书 / 课程 / spark)
  ↓ Layer 1: harvest (filter by source-trust)
  ↓ Layer 2: extract concepts + 关联
  ↓ Layer 3: pedagogy mapper (5 retain + 3 frontier + 3-axis substrate)
  ↓ Layer 4: archetype classifier
  ↓ Layer 5: pack-shape (lessons[] + intelligence_card)
  ↓ Layer 6: self-review (LLM critique, 拒绝 generic-course slop)
  ↓ Layer 7: license + author signature
  → vault/.commons-packs/<pack-id>.json
```

v0.5.0 MVP: 无 Distiller. 1 个 seed Pack 由 HYPHA Team 手写, 验证 Schema + Loader 可工作.

---

## 6. Source Trust — 源信任层

Pack 携带 `source_trust` 子结构, 让 user 看穿 Pack 背后是真有依据还是 LLM 凭空生成.

```jsonc
{
  "creator_reputation": "HYPHA Team / 王 P (PhD Cognitive Science)",
  "external_signals": [
    { "type": "book", "ref": "The Feynman Lectures on Physics" },
    { "type": "paper", "ref": "arXiv:2604.18071" },
    { "type": "talk", "ref": "Feynman: The Method (YouTube)" }
  ],
  "community_signals": {                          // v2.5+
    "ratify_count": 0,
    "challenge_count": 0,
    "supersede_link": null
  }
}
```

**原则**:
- 结构化索引 OK (引用书名 / arXiv ID / 论文标题).
- 全文复制 谨慎 (license + 公平使用).
- 公开 spark / kernel OK (Hypha 自有 distillation).
- 公开原书 / 付费内容替代品 不可以.

---

## 7. License — 许可协议

Pack 创建者从 LICENSE enum 选一项. Commons 在 install 时:
- `CC-BY-*` — 自动允许 install + 学完 fork + Pack Study Note 自由衍生.
- `proprietary` — Commons 不参与分发; 仅在 author 自有渠道流通.

Commons 本身: **HYPHA 不抽税**. Author 可选自付费模式 (donation / 付费访问), 但 Pack 文件本体仍是结构化 JSON 数据, 不锁死在闭源容器.

---

## 8. Discovery + Installation — 发现与安装 (defer v2.0)

v0.5.0 MVP: 单机. Pack 文件手动放进 `vault/.commons-packs/`, Pack Loader 扫描读取.

v2.0+:
- 中央 registry (git-based mirror, 类似 npm-without-NPM-Inc).
- Trust Panel 显示 install 时的 source_trust + intelligence_card.
- 按 score 公式排序, **不按热度**.
- Fork 后衍生 Pack 自动写回 license chain.

---

## 9. MVP scope — v0.5.0 ship 边界

**Ship 项**:
1. `app/lib/commons/pack-schema.js` — pure JS validator, 无外部依赖.
2. `app/lib/commons/pack-loader.js` — `listPacks(vaultRoot)` + `loadPack(vaultRoot, packId)`, 基于 fs.
3. `vault/.commons-packs/seed-feynman-method.json` — 1 个 seed Pack 验证 schema + loader.
4. `app/scripts/_dev_verify_pack_schema.js` — 6 smoke tests.
5. 本 spec 文档.

**Surface (defer)**:
- Pack Loader IPC `commons:list-packs` / `commons:load-pack` (留 v0.5.1).
- Trust Panel "Commons Pack 计数" 角章 (留 v0.5.1).

**Defer 项**:
- Pack Distiller (v2.0).
- 中央 registry (v2.0).
- license 强制执行 (v2.0).
- community ratify / challenge (v2.5).
- Pack Learning Mode 完整状态机 (v2.0).
- Parking Queue (v2.0).
- Course Trust Panel "Pack-derived" trust signals (v0.5.1+).
- 完整 sanitizer + 钓鱼链接白名单 (v1.9).

---

## 10. Honest gaps — 诚实声明

v0.5.0 scaffold **不解决**:

1. **Trust Panel 集成** — 用户在课程内看不到 "本 Lesson 是否 derived from Commons Pack". 留 v0.5.1.
2. **Pack install / fork UI** — 当前必须手工把 JSON 放进 `vault/.commons-packs/`. UI 是 v1.9.
3. **作者签名验证** — `author` 字段是字符串, 无 cryptographic signature. Pack 伪造容易. v2.0 加 ed25519.
4. **License 执行** — schema 校验 license 字段存在, 但 fork / 衍生时不强制写 license chain. v2.0.
5. **Community ratify** — 没有 community 信号采集. v2.5 与 Hypha Track B (社交沙盒) 联动.
6. **跨 vault 共享** — Pack 当前与 user vault 绑定; 跨设备同步留 v0.5.2 + cloud sync 决策.
7. **AI 生成 Pack 检测** — 当前 schema 不检测 Pack 内容是否纯 AI 生成 slop. 防御依赖 `source_trust.external_signals` 自报 + community 后置审计 (v2.5).

---

## References

- 蓝图主线: `CLAUDE.md` §6 Commons System
- 相关 spec:
  - `specs/library-distillation.md` — Book Spark Pack (Pack 子类)
  - `specs/anti-slop-layer.md` — Pack 内容质量门
  - `specs/learning-commons-flywheel.md` — 飞轮闭合 (v2.5)
  - `specs/pack-learning.md` — Pack Learning Mode 完整态机 (v2.0)
- Code anchors (本次 ship):
  - `app/lib/commons/pack-schema.js`
  - `app/lib/commons/pack-loader.js`
  - `vault/.commons-packs/seed-feynman-method.json`
  - `app/scripts/_dev_verify_pack_schema.js`
