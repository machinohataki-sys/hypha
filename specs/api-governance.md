# API Governance — 模型治理与成本

> **STATUS**: partial (provider.js dispatch + prompt caching shipped; Cheap Router NOT shipped; Lesson Cost Budget NOT shipped).
> 对应 [BLUEPRINT.md §17](../BLUEPRINT.md) "API Model Governance"。
> Roadmap：v0.9 (基础 + 缓存) / v1.1 (Cheap Intelligence Router) — 见 [ROADMAP.md](../ROADMAP.md)。
> 现有：`app/lib/providers.js` 多 provider dispatch + `app/lib/anthropic-adapter.js` prompt caching。

---

## 17.1 API 替代 CLI

CLI 是开发工具，不是稳定课程生成引擎。HYPHA 应使用 API 控制：
- 模型
- Prompt
- 上下文
- 结构化输出
- 成本
- 缓存
- 失败回退

**当前**：`provider=claude-cli` 仍可用（已订阅 Claude Max 的用户路径），但通过 `--system-prompt` flag 走 Anthropic 系统字段绕开 Claude Code wrapper 污染（HANDBOOK §10）。`provider=claude` Direct API 是 cleanest 推荐。

---

## 17.2 Cheap Intelligence Router

强 LLM 不读一切。分级路由：

```text
规则系统 (free)
↓ miss
Embedding (cheap)
↓ miss
本地模型 (cheap)
↓ escalate
中型模型 (mid-cost)
↓ escalate
Micro Judges (mid-cost)
↓ escalate
Context Packer (mid-cost)
↓ escalate
强 LLM (high-cost)
```

**便宜模型负责**：
- 相关性
- 质量评分
- 前沿度
- Pack 初筛
- Note 路由
- 低质量输入检测
- 作业强度计算
- Companion 状态表达
- Product Transfer 初筛

**强模型负责**：
- 最终 Lesson
- 深度解释
- 跨学科综合
- 复杂判断
- 复杂 Product Transfer

**触发升级条件**：
- 便宜模型置信度 < 阈值
- 用户当前是高 Mastery（不可糊弄）
- Goal 当前阶段是关键节点
- Lesson 主题命中 high-stakes 列表

---

## 17.3 Lesson Cost Budget

每节课预算项：
- 主模型成本
- Router 成本
- 检索成本
- 检测器成本
- 缓存收益（负成本）
- Companion 小模型成本
- Product Transfer 成本

> **HYPHA 不卖无限 AI，而卖目标导向学习进度。**

预算 schema 建议：

```yaml
lesson_id: ...
budget_cap_usd: 0.20
spent:
  main_model: 0.12
  router: 0.001
  retrieval: 0.005
  detectors: 0.003
  companion: 0.001
  product_transfer: 0.01
cache_hit_value: -0.08   # 节省金额
total_spent_usd: 0.06
status: under-budget
```

---

## 与 HANDBOOK §10 的衔接

HANDBOOK §10 Provider 配置已实测：
- `claude` Direct API + prompt caching → Opus 4.7 ~$0.17/lesson, Sonnet 4.6 ~$0.05/lesson, Haiku 4.5 ~$0.014/lesson。
- 75% cache hit ratio 实证可达。

Cheap Router 的目标：把"最终 Lesson"占比的 main model 成本降一半（用便宜模型处理 routing / 评分 / 初筛 / 状态表达），保持 Lesson 质量不下降。

---

## 实现路径（建议）

1. **v0.9**：API 调用层（已有）+ 模型选择（已有）+ 成本统计（增）+ 失败回退（增）+ 基础-标准-深度-前沿模式分级（增）。
2. **v1.1 Cheap Router**：rules / embedding / local / mid-LLM / Context Packer 五级路由 + Note Router v0 + Pack 相关性评分 + Companion 状态生成 + Product Transfer 初筛。
3. **v2.4 Public Launch**：Lesson Cost Budget 强制 cap + 用户可见的成本仪表板。

预期：主模型 token 下降 ≥ 50%，Lesson 质量不下降（Lesson Quality Harness 验证）。

完整 spec 见 [BLUEPRINT.md §17](../BLUEPRINT.md)。
