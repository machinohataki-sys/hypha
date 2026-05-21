# Exam System — 考试系统

> **STATUS**: not yet implemented (2026-05-07).
> 对应 [BLUEPRINT.md §13](../BLUEPRINT.md) "Exam System"。
> Roadmap：v2.1 (Alpha — 考研英语 / 考公行测某模块为首发场景)。
> 落点 hint：新建 `app/lib/exam/` 模块；扩展 designSequence 接 Exam Mode 路由；vault 加 `<chain>/exam/{scope.json, error-log.jsonl, mock-trends.json}`。

---

## 13.1 Exam Scope Engine — 考试范围引擎

考试学习不是学更多，而是在考试范围内稳定调用。

范围分层：
- **Must Master**：必须掌握
- **High-Yield Extension**：高收益拓展
- **Recognition Only**：只需认识
- **Out of Scope**：暂不学习

**以考研英语为例**：
- 核心词汇
- 高频真题词
- 熟词僻义
- 高频词组
- 长难句结构
- 阅读题型
- 翻译能力
- 作文模板

> **Exam Model 追求考试范围内的稳定调用，Growth Model 追求能力边界扩张。**

---

## 13.2 Exam Resource Layer — 考试资源层

题源四层：
1. **Licensed Bank**：授权题库
2. **User-owned Bank**：用户自带题库
3. **Public Index**：公开索引
4. **Synthetic Practice**：AI 生成训练题

**早期不做盗版真题平台**，而做：
> **真题学习转化器。**

用户上传自己拥有的资料，HYPHA 负责：
- 结构化
- 题型分类
- 错题诊断
- 能力评估
- 相似练习
- 复习规划

---

## 13.3 Error Diagnosis — 错题诊断

错题不只是记录，而要诊断错因：
- 词汇不认识
- 长难句断错
- 定位错误
- 偷换概念
- 因果关系看反
- 态度判断错
- 过度推断
- 时间不够

输出 schema：

```yaml
error_id: ...
question_ref: <题目位置>
user_answer: ...
correct_answer: ...
error_class: vocab | parse | locate | swap | causal | tone | over-infer | timeout
remediation_path: <推荐课程 / 练习 / 复习节点>
ts: ISO-8601
```

---

## 13.4 Final Compression — 最终压缩

Deadline 最后阶段：
- 停止开新模块
- 复习高频点
- 回顾错题
- 压缩作文模板
- 限时训练
- 轻量模拟
- 保持状态

> 最后一天不是学习日，而是压缩日。

---

## 与 Goal Contract 的衔接

Goal Contract 的 `learning_model` 决定是否走 Exam System：
- `Exam` → 完全 Exam System
- `Hybrid` + `deadline != null` → Deadline-Aware Cadence 动态混合（见 [specs/goal-contract.md](./goal-contract.md) §3.2 ratios）
- `Growth` → 不启用 Exam System

---

## 实现路径（建议）

1. **v2.1 Alpha**：选 1 场景（考研英语 vocab+长难句+阅读 三模块）走通 ScopeEngine + UserBank + Synthetic + Error Diagnosis + Final Compression + Exam Positive Feedback。
2. **v2.2**：扩第二场景（考公行测）；验证 Scope Engine 跨场景泛化。
3. **v3.0**：Exam Resource Layer 完整四层（含 Licensed Bank 合作）。

完整 spec 见 [BLUEPRINT.md §13](../BLUEPRINT.md)。
