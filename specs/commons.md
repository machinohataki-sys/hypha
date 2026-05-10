# Commons System — 公共知识资产系统

> **STATUS**: not yet implemented (2026-05-07).
> 对应 [BLUEPRINT.md §12](../BLUEPRINT.md) "Commons System"。
> Roadmap：v1.9 (Alpha) / v2.0 (Pack Learning Mode) / v2.5 (Flywheel) — 见 [ROADMAP.md](../ROADMAP.md)。
> 落点 hint：新建 `app/lib/commons/` 模块（Pack 服务客户端）+ Pack 安全 sandbox + Pack Intelligence Card 渲染。后端方案 TBD（自托管 vs 联合）。

---

## 12.1 定位

Commons **不是社区，而是可复用学习资产仓库**。

核心对象：
- Knowledge Pack
- Book Spark Pack（见 [specs/library-distillation.md](./library-distillation.md)）
- Pack Study Note
- Canonical Pack
- Product Blueprint Template

**禁止成为**：评论区 / 私信系统 / 关注流 / 热榜 / 争吵场 / 学习表演平台 / 低质量资料市场。

---

## 12.2 Knowledge Pack

字段：标题 / 摘要 / 适合人群 / 推荐场景 / 前置知识 / 学习路径 / 核心概念 / 例子 / 反例 / 练习 / 引用 / 版本历史 / 安全等级 / 质量评分。

> Pack 是可学习、可 Fork、可进入 Lesson 的知识资产。

---

## 12.3 Pack Intelligence Card

解决 GitHub 噪音问题，让用户 10 秒内判断 Pack 是否适合自己。

字段：
- 推荐科目
- 适合人群 / 人物群像
- 推荐场景
- 主要价值
- 不适合谁
- 前置知识
- 难度等级
- 认知负荷
- 稳定性标签
- 风险与缺陷
- 使用方式
- 质量评分
- 安全等级
- 为什么推荐给当前用户
- 可迁移到哪些 Product / Creation

排序不按热度，按：目标匹配度 + 当前 Lesson 相关度 + Mastery Map 匹配度 + 当前 Product 相关性 + 质量分 + 安全分 + 学习效果分 + 维护状态。

---

## 12.4 Pack Learning Mode

Fork Pack ≠ 学习 Pack。

Pack 操作：Preview / Learn / Apply / Fork / Transfer to Product。

学习模式：
- **Preview Pack**：快速判断
- **Quick Learn**：15-25 分钟掌握核心价值
- **Deep Learn**：拆成多节 Pack Lesson
- **Apply Pack**：应用到当前问题
- **Fork & Rewrite**：学习后改写成自己的版本
- **Transfer to Product**：迁移到当前 Product Pool

学习后生成 Pack Study Note。

状态机：`Imported → Previewed → Learning → Understood → Applied → Personalized → Integrated → Productized → Crystallized`。

---

## 12.5 Parking Queue — 学习停车区

当 Pack 对长期目标有价值，但当前不适合深学时，进入 Parking Queue。

约束：
- 不打断当前 Lesson
- 不丢失高价值 Pack
- 在最近合适节点重新激活
- 必要时先给短 Preview

不是无限延后。

---

## 12.6 Pack Security Layer — 安全防御层

> **Knowledge Pack is data, not executable software.**
> 知识包是数据，不是软件。

**禁止或隔离**：.exe / .msi / .bat / .cmd / .ps1 / 宏文件 / 未知压缩包 / 自动运行脚本 / 浏览器插件 / 远程下载器 / 可执行依赖。

**防御**：Prompt Injection / 钓鱼链接 / 恶意外链 / 隐私泄露 / 恶意依赖 / 伪装系统提示词。

**LLM 调用 Pack 时**只读取 Sanitized Context，不读取 Raw Pack。

---

## 12.7 Source Trust & License Layer

每个来源记录：
```yaml
source_url: ...
license: ...
allowed_usage: ...
citation: ...
retrieval_date: ISO-8601
content_type: kernel | excerpt | spark | full-text
trust_score: 0-100
```

**原则**：
- 索引结构可以
- 复制全文谨慎
- 公开 Sparks 可以
- 公开原书 / 付费内容替代品不可以

---

## 实现路径（建议）

1. **v1.9 Alpha**：Pack schema + Intelligence Card + Security Layer + Preview/Learn/Apply/Fork + Fork into Note + Pack Study Note。
2. **v2.0**：完整 Pack Learning Mode（Quick / Deep / Apply / Fork+Rewrite / Transfer to Product）+ Parking Queue。
3. **v2.5**：Canonical Pack 制度 + Commons 反哺 Curriculum Graph + 飞轮闭合。

后端方案：早期可纯本地仓库（git-based pack repos）；中期再考虑联合或自托管 hub。

完整 spec 见 [BLUEPRINT.md §12](../BLUEPRINT.md)。
