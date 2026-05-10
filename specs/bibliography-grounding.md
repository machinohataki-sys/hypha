# Bibliography Grounding — 参考书目地基系统

> **STATUS**: not yet implemented (2026-05-07).
> 对应 [BLUEPRINT.md §4](../BLUEPRINT.md) "Bibliography Grounding：参考书目地基系统"。
> Roadmap：v1.5 (Alpha) / v1.6 (with Library) — 见 [ROADMAP.md](../ROADMAP.md)。
> 落点 hint：扩展 `app/lib/source-extractor.js` + 新建 `app/lib/grounding/` 子模块；写入 `vault/<chain>/grounding.json` + `vault/.book-sparks/<book-id>.json`。

---

## 为什么需要

> **参考书不是课后阅读材料，而是课程生成前的地基。**

普通 LLM 生成课程的失败模式：把书名当作主题词调用普通知识，假装"读过"。Bibliography Grounding 强制让 Lesson Generator 在生成路径前**先把书消化成结构化地基**，再让地基约束课程结构。

---

## 流程（按 §4 原文）

```text
用户填写 Goal
→ 用户选择参考书目
→ HYPHA 检查 Commons / Library 是否已有公开 Sparks
→ 有：复用 Book Spark Pack（低 token 调用）
→ 无：启动 Longform Spark Distillation（见 specs/library-distillation.md）
→ 生成 Book Grounding Profile
→ 多本书生成 Grounding Synthesis
→ 基于 Goal + 地基生成课程
```

---

## Book Grounding Profile（§4.1）

每本书进入课程生成前，要转为结构化地基：

```yaml
book_id: <slug>
title: ...
edition: ...
serves_goal:
  why_it_helps: <这本书能为当前 Goal 提供什么>
  relation_to_goal: <与用户 Goal 的关系>
core_sparks:
  - <可进入课程的核心 Spark 1>
  - <Spark 2>
out_of_scope:
  - <不适合当前 Goal 的内容>
risks_dated:
  - <风险与过时点>
methodologies:
  - <可迁移方法论>
product_transfer_seeds:
  - <可产品化启发>
```

---

## Grounding Synthesis（§4.2）

多本书不能堆砌，要合成。HYPHA 判断：
- 每本书负责什么
- 哪些互补
- 哪些冲突
- 哪本主地基
- 哪本辅助
- 哪些内容不进入当前课程

输出 `vault/<chain>/grounding.json`：

```yaml
primary_book: <book_id>
supporting_books: [<book_id>, ...]
complementary_pairs: [[a, b], ...]
conflict_pairs: [[a, b]]  # 标明分歧点 + 课程默认采纳哪派
excluded: [<book_id> | <book_id>:<topic>]
```

---

## 有 Sparks 就复用，无 Sparks 就蒸馏（§4.3）

```text
有公开 Sparks → 低 token 调用
没有 Sparks → 先蒸馏书籍地基
```

> HYPHA 不能让 LLM 假装读过一本书。

---

## 与现有系统的衔接

- **当前 v0.11.x**：`source-extractor.js` 已支持 PDF / MD / URL ingest，可作为 Library 入口。但只标 `sourceType`，无 Grounding Profile / Synthesis 抽象。
- **v1.5 Alpha 任务**：在 `clarifyQuestions` 后增加"是否选择参考书地基"步骤；调 Library 检查 → 调 Distiller / 复用 → 写 grounding.json → designSequence 前置注入。
- **v1.6 衔接 Library + Longform Distillation**：见 [specs/library-distillation.md](./library-distillation.md)。

---

## 实现路径（建议）

1. **v1.5**：Goal 后选书 UI；Book Grounding Profile schema；已有 Sparks 检查；fast-path 复用；课程生成前置注入。
2. **v1.6**：Longform Distillation 接管"无 Sparks"分支；Book Spark Pack draft 输出。
3. **v2.5**：Book Spark Pack 反哺 Commons → 其他用户复用 → 飞轮启动。

完整 spec 见 [BLUEPRINT.md §4](../BLUEPRINT.md)。
