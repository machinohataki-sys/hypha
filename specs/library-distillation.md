# Library & Longform Spark Distillation — 图书馆与长文蒸馏

> **STATUS**: partial (source-extractor shipped, 7-phase distillation NOT shipped).
> 对应 [BLUEPRINT.md §5](../BLUEPRINT.md) "Library & Longform Spark Distillation"。
> Roadmap：v1.6 — 见 [ROADMAP.md](../ROADMAP.md)。
> 落点 hint：扩展 `app/lib/source-extractor.js` + 新建 `app/lib/distiller/` (7 phase pipeline) + Book Router cache `vault/.book-cache/<book-id>/{kernel.md, sparks.json, index.json}`。

---

## 定位

Library 不是电子书架，而是**知识矿山**。可存放 EPUB / PDF / 论文 / 公开课讲义 / 长文 / 教材 / 用户上传资料。

用途：课程地基 / LLM 辅助阅读 / 长文蒸馏 / Sparks 提取 / 个人 Note / Book Spark Pack / Commons 复用 / Product Pool 灵感来源。

---

## Longform Spark Distillation Plan（§5.1, 7 phase）

全书蒸馏不是普通总结。

### Phase 1：建图，不总结
- 读取目录
- 识别作者核心问题
- 识别全书结构
- 识别关键章节

### Phase 2：章节拆解
- 本章核心问题
- 本章核心判断
- 论证链条
- 隐藏前提
- 潜在 Spark

### Phase 3：跨章节合并
- 核心问题
- 核心机制
- 重复观点压缩
- 高价值 Sparks

### Phase 4：前沿化
- 与 AI、Agent、教育、产品、创业、社会结构连接

### Phase 5：反向批判
- 作者高估什么
- 作者低估什么
- 哪些观点过时
- 哪些观点可被 AI 时代重写

### Phase 6：用户个人化
- 哪个 Spark 击中用户 Goal
- 哪个观点用户不同意
- 哪个机制可以迁移到项目
- 哪个想法可变成行动

### Phase 7：Book Spark Pack
- 用户选择是否公开

---

## Book Spark Pack（§5.2）

包含字段：
- 书名 / 版本 / 来源说明
- 适合人群 / 推荐场景
- 主要价值
- 章节思想地图
- Concept Sparks
- Mechanism Sparks
- Frontier Sparks
- Anti-Sparks（被批驳点）
- 可迁移方法论
- 可产品化启发
- 用户个人 Sparks
- 风险与版权说明

边界：
> **公开 Sparks，不公开原书。公开用户理解资产，不公开版权替代品。**

---

## Book Router（§5.3）

LLM 不读全书，而是调用 Book Context Packet：

```text
当前问题
→ 检索 Book Spark Index
→ 检索章节 Kernel
→ 必要时取短原文片段
→ 生成 Book Context Packet
```

> **一本书只完整蒸馏一次，后续调用走缓存、章节 Kernel 和 Spark Index。**

---

## 数据布局（建议）

```
vault/
└── .book-cache/
    └── <book-id>/
        ├── meta.json           # 书目元信息 + 蒸馏完成状态
        ├── kernel.md           # 全书 Kernel Summary（Phase 3 输出）
        ├── chapters/
        │   └── ch-NN.md        # 每章 Kernel
        ├── sparks.json         # Phase 4-6 输出（typed list）
        └── index.json          # Spark Index（embed/keyword 双索引）
```

---

## 实现路径（建议）

1. **v1.6 Phase 1**：source-extractor 输出原始目录 + 章节切片（不调 LLM）。
2. **v1.6 Phase 2**：每章 Kernel 蒸馏（小模型 + 章节级缓存）。
3. **v1.6 Phase 3-7**：跨章节合并 + 前沿化 + 反向批判 + 个人化 + Pack draft。
4. **v2.0**：Book Router 缓存命中率 > 80%；新 Lesson 不再读全书。
5. **v2.5**：Book Spark Pack 进入 Commons 飞轮。

成本治理：见 [specs/api-governance.md](./api-governance.md) Lesson Cost Budget。

完整 spec 见 [BLUEPRINT.md §5](../BLUEPRINT.md)。
