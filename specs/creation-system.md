# Creation System — 创造系统

> **STATUS**: not yet implemented (2026-05-07).
> 对应 [BLUEPRINT.md §11](../BLUEPRINT.md) "Creation System：创造系统"。
> Roadmap：v0.7 (v0) / v1.4 (v1) — 见 [ROADMAP.md](../ROADMAP.md)。
> 落点 hint：新建 `app/lib/creation/` 模块；写入 `vault/<chain>/creation/{blueprint.md, sparks/, decisions.jsonl, assumptions.jsonl, kill-criteria.md, roadmap.md}`。

---

## 解决的问题

> **用户学到的知识最终落在哪里？**

如果没有 Creation System，HYPHA 会停留在"学习系统"；有了 Creation System，HYPHA 才真正成为"私人大学 + 创造工作室"。

---

## 11.1 Product Pool / Creation Pool — 产品池 / 创造物池

不是 Trello / Notion Project / GitHub Issues，而是：
> **用户当前创造物的认知容器。**

存放：
- 产品蓝图
- 核心问题
- 用户痛点
- 北极星
- 设计原则
- 功能模块
- 未验证假设
- 灵感池
- 风险清单
- 路线图
- 相关 Note / Lesson / Pack / Book Sparks / Research Reports

可承载：产品 / 论文 / 小说 / 研究项目 / 网站 / 课程 / 个人品牌 / 开源项目 / 商业计划 / 考试备考系统。

---

## 11.2 Product Blueprint — 产品蓝图

每个产品 / 创造物结构化模板：

```markdown
# Product Blueprint

## 1. Product North Star
这个产品最终要改变什么？

## 2. Target Users
为谁存在？

## 3. Core Pain
解决什么痛点？

## 4. Current Hypothesis
当前最重要的产品假设是什么？

## 5. Modules
已有模块有哪些？

## 6. Open Questions
当前还没想清楚的问题。

## 7. Inspiration Pool
所有从 Lesson / Note / Book / Pack 迁移来的灵感。

## 8. Decision Log
关键决策记录。

## 9. Risk Map
技术、商业、产品、法律、成本风险。

## 10. Roadmap
从当前版本到理想版本的路径。
```

---

## 11.3 Product Transfer — 知识到产品迁移

每次 Deepen / Lesson / Note 处理时，如果与 Product Pool 相关，HYPHA 增加：

```text
## 迁移到你的产品 / 作品
这个理论如何影响你正在创造的东西？
```

**示例**（用户学习奥卡姆剃刀，当前 Product 是 HYPHA）：

> 奥卡姆剃刀对 HYPHA 的启发是：不要为了"前沿感"增加复杂模块。每个模块必须证明它能推进至少一个目标：(1) 提升 Lesson 质量 (2) 降低用户学习熵 (3) 增强 Note 活化 (4) 增加学习证据 (5) 提高长期留存。如果一个功能只是看起来高级，例如复杂 Graph、宠物养成、热榜社区，但不能服务这些目标，应默认砍掉。

---

## 11.4 Product Spark — 产品灵感节点

绑定某个 Product 的特殊 Spark。结构：

```yaml
spark_id: <slug>
source:
  type: lesson | note | book | pack | research-radar
  ref: <id>
target_product: <product_id>
core_transfer: <核心迁移 1 句>
affected_modules: [Lesson, Note, Commons, Library, Companion, Pricing, Security]
possible_actions:
  - 新增功能
  - 修改原则
  - 删除复杂度
  - 改 UX
  - 改商业模式
risks: <可能哪里错>
state: Seed | Considered | Accepted | Rejected | Implemented
```

---

## 11.5 Decision Log — 决策日志

防止反复摇摆。每条记录：决策内容 / 当时背景 / 依据 / 反对意见 / 最终选择 / 后续验证方式 / 是否需要复查。

示例题目：为什么不做评论区？/ 为什么不先做考试？/ 为什么不先做三档会员？/ 为什么菌类星人不做宠物？/ 为什么 Note 不做漂亮 Graph？

---

## 11.6 Assumption Ledger — 假设账本

每个假设状态：未验证 / 正在验证 / 已验证 / 被推翻。

示例：
- 用户愿意为私人大学付 ¥79-99/月
- 用户不反感菌类星人
- Lesson 质量是留存核心
- Product Pool 能提高学习转化

---

## 11.7 Kill Criteria — 砍掉标准

每个模块要有"什么时候砍掉"的标准。

示例：
- 如果菌类星人导致学习完成率下降，就降级。
- 如果 Commons 三个月内没有高质量 Pack，就延后。
- 如果 Library 蒸馏成本过高且留存贡献低，就暂缓。
- 如果 Product Pool 只变成灵感垃圾桶，就改成轻量 Decision Log。

---

## 11.8 Roadmap Sync — 路线图同步

Product Pool 定期把最近 Lesson / Note / Deepen / Sparks 中的高价值迁移点汇总成 Roadmap 建议。

示例：
> 最近 7 天有 6 条学习内容可能影响 HYPHA：1. 奥卡姆剃刀 → 功能复杂度裁剪 / 2. Positive Feedback → 用户留存机制 / 3. 菌类星人 → 情感陪伴层 / 4. Exam Scope → 考试模型边界 / 5. Living Note → Note 复活机制 / 6. Bibliography Grounding → 课程可信地基。建议本周只处理 2 条：奥卡姆剃刀 + Living Note。

> **Product Pool 不能成为灵感垃圾桶，必须持续熵减。**

---

## 实现路径（建议）

1. **v0.7 (v0)**：单 Goal 绑单 Product；Product Blueprint 基础结构；Product Transfer 手动按钮；Product Spark 基础 schema；Decision Log v0；Assumption Ledger v0。
2. **v1.4 (v1)**：Product Pool 多模块；Spark 状态机；Roadmap Sync；Product Transfer 自动触发；Kill Criteria 实施。
3. **v2.5**：Product Blueprint Template 进入 Commons。

完整 spec 见 [BLUEPRINT.md §11](../BLUEPRINT.md)。
