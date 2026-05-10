# Goal Contract — 目标契约规范

> **STATUS**: not yet implemented (2026-05-07).
> 对应 [BLUEPRINT.md §3](../BLUEPRINT.md) "Goal System：目标系统"。
> Roadmap：见 [ROADMAP.md](../ROADMAP.md) v0.1 / v0.6。
> 落点 hint：`app/lib/hypha-constitution.js` 上层 + 新建 `app/lib/goal-contract.js`；写入 `vault/<chain>/contract.json`。

---

## 为什么需要

用户不能只输入"我想学 AI"。HYPHA 要把目标结构化成课程最高约束。否则 Lesson Generator 会漂移成普通 ChatGPT 答疑流。

> **Goal is the curriculum.** 目标本身就是课程生成规则。

---

## Schema（按 BLUEPRINT §3.1 原文）

```json
{
  "north_star_goal": "成为 AI Builder",
  "current_level": "零基础",
  "learning_model": "Growth",
  "deadline": null,
  "main_creation": "HYPHA",
  "core_competencies": [
    "AI 基础理解",
    "Agent 思维",
    "产品判断",
    "系统设计",
    "LLM 成本意识",
    "项目产出"
  ],
  "forbidden_drifts": [
    "空泛聊天",
    "过多黑话",
    "无行动证明",
    "资讯流消费",
    "普通网课式总结"
  ],
  "discipline_mode": "guided"
}
```

字段语义：
- `north_star_goal` — 1 句话用户级目标。所有 Lesson 必须可追溯到此。
- `current_level` — 用户自评起点；驱动 Jargon Firewall 入口语言。
- `learning_model` — `Exam` / `Growth` / `Hybrid`，由 Learning Mode Router 接续路由。
- `deadline` — null 或 ISO 8601；驱动 Deadline-Aware Cadence。
- `main_creation` — 用户当前正在创造的产品 / 论文 / 项目；驱动 Product Transfer 触发。
- `core_competencies` — 6-8 个能力维度；驱动 Mastery Map 拓扑。
- `forbidden_drifts` — Goal Drift Detector 黑名单。
- `discipline_mode` — `guided` / `strict` / `loose`；影响 Goal Guardian 的纠偏强度。

---

## Learning Mode Router（§3.2）

| 模型 | 目标 | 关注 |
|---|---|---|
| **Exam Model** | 在有限时间内最大化考试表现 | 考纲、掌握范围、题型、高频点、错题、速度、Deadline、Final Compression |
| **Growth Model** | 长期改变理解、判断、行动和作品产出能力 | 第一性原理、机制理解、跨学科迁移、项目主线、创造力 |
| **Hybrid Model** | 同时备考与长期成长 | 随 deadline 动态调整 Exam / Growth 比例 |

示例比例：
- 距离考试 60 天：Growth 70%，Exam 30%
- 距离考试 30 天：Growth 50%，Exam 50%
- 距离考试 7 天：Growth 20%，Exam 80%
- 最后 1 天：Final Compression
- 考试后：回到 Growth

> **备考不是普通课程加速；自我提升不是考试课程放慢。二者是不同模型。**

---

## Deadline-Aware Cadence（§3.3）

```text
Lesson Cadence = f(G, D, S, C, M, R, T)
```
- `G` = Goal
- `D` = 当前第几节课 / 第几天
- `S` = 学习评分
- `C` = 困惑程度
- `M` = 阶段节点
- `R` = 复习节点
- `T` = 距离 deadline 的剩余时间

策略：
- 时间充足：深学、打地基、允许探索
- 时间中等：理解 + 练习平衡
- 时间紧迫：高频、错题、模拟、压缩
- 最后一天：停止扩张，只做 Final Compression

---

## Goal Guardian（§3.4）

HYPHA 不是陪聊机器人。当用户偏航时，系统温和拉回目标。

> 情绪影响教学方式，但不改变目标方向。

---

## 实现路径（建议）

1. **v0.1**：最小 Goal Contract（north_star + current_level + learning_model 三字段），写入 `vault/<chain>/contract.json`，前置注入每次 designLesson。
2. **v0.4**：补全 6 字段 Goal Contract；Goal Drift Detector 用 forbidden_drifts 黑名单。
3. **v0.5**：Cadence f(G,D,S,C,M,R,T) 落地（state.json 加 D/S/C/M/R/T 槽位）。
4. **v0.6**：Goal Guardian 上线；偏航检测 + 拉回。

完整 spec 见 [BLUEPRINT.md §3](../BLUEPRINT.md)。
