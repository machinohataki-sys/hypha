# Lesson Quality Harness (W1.1)

> 蓝图锚: `BLUEPRINT.md §6.4` + `ROADMAP.md` v0.2 验收.
>
> 此 spec 描述 **课程质量 9-维度评分系统** — 与现有 `app/lib/lesson-quality-harness.js`
> (v0.2 anti-slop 输出层 pipeline: Gap / Confession / Persona / PJR / Auditable
> Summary) **互补不重叠**. 两者在 v0.4+ 会合并进同一 Trust Panel surface;
> 在 W1 wave 中分开维护, 各自跑各自的回归.

## 1. Why this exists

现状: hypha 已 ship lesson 生成 (`app/agent.js:designLesson` + 11-field body
via `app/lib/lesson-body-generator.js`). 但**无方法证伪**同一 topic 生 10 次
是否稳定到达 HYPHA 标准. 这是 v0.2 验收门 (per ROADMAP): "同主题生 10 次,
8/10 pass HYPHA 标准".

W1.1 是这扇门的 evaluator. 输入 = lesson body. 输出 = pass / fail + 9 dim 分数
+ weakest dim. **此 evaluator 不修复, 只判分**; 修复落点是 W1.2-W1.5 各自的
generator-side fix.

## 2. 9 Dimensions

| # | Dim ID | 名称 | 关注点 | Pass Threshold |
|---|---|---|---|---|
| 1 | `goalCoherence` | 目标一致性 | 每个 KP / canonical_example / exit_proof 是否可追溯 learn_goal | 50 |
| 2 | `jargonControl` | 黑话控制 | jargon_list 克制 + plain gloss + 不假设 user 不知道的术语 | 50 |
| 3 | `levelMatch` | 水平匹配 | 难度 vs `userProfile` (零基础 / 中级 / 进阶) 是否对齐 | 50 |
| 4 | `misconceptionDefense` | 误解防护 | 2 条 misconception 是否真高发先验 + 是否带 falsifiable 纠正 | 50 |
| 5 | `evidenceOfLearning` | 学习证明 | exit_proof 是否 falsifiable + apply (不 recall) + fresh case | 50 |
| 6 | `actionConversion` | 行动转化 | lesson 是否驱动 user 课后 30 min 内做具体动作 (Track A artifact / Track B 真人对话) | 50 |
| 7 | `productTransferQuality` | Product Transfer 质量 | Track A artifact 命名 + 受众非自 + 可承受 push back | 50 |
| 8 | `notGenericCourse` | 反普通网课 | 反 encyclopedia framing / "great question!" / 1.定义 2.例子 3.测验 三段结构 | 50 |
| 9 | `hyphaSoul` | HYPHA 灵魂 | 聚合判: 是否真的体现 HYPHA WHY 三件事 (反工业教育 + 破信息差 + 反 AI 伪知识) | 50 |

每 dim 评分范围: **0-100 整数**. pass 阈值统一 50 (单维), 但单维 pass 不等于
overall pass.

## 3. Overall Pass 公式

```
weighted_avg = (Σ_{dim ≠ hyphaSoul} score + 2 × hyphaSoul.score) / 10
overall_pass = (weighted_avg ≥ 60) AND (hyphaSoul.score ≥ 50)
```

- `hyphaSoul` 双倍权重: HYPHA 北极星, 不可被前 8 项替补.
- `60` (而非简单算术平均的 50): overall 比单 dim 更严格, 防 "8 项 51 分 1 项 0 分" 蒙混.
- `hyphaSoul ≥ 50` 硬下限: 即使前 8 项满分, 没灵魂也 FAIL.

## 4. T4_JUDGE Prompt Templates (后续 W1.2 ship)

每 judge 在 `app/lib/quality-harness/judges/*.js` 内有 `gradeJudge` 函数,
W1.1 scaffold 返 `{score: 0, rationale: 'unimplemented', evidence: []}`.

W1.2 接 T4_JUDGE 时, 每 judge 用如下模板填:

```
SYSTEM: You are a HYPHA Lesson Quality Judge for dimension "<DIM_NAME>".
Score 0-100 where 100 = exemplary, 50 = threshold pass, 0 = catastrophic fail.

CONTEXT:
- Topic: <topic>
- User profile: <userProfile>
- Learn goal: <goal>

LESSON BODY (11-field v0.2 schema):
<lessonBody JSON>

RUBRIC for this dim (<DIM_NAME>):
<dim-specific rubric — 见各 judge 源文件注释>

OUTPUT JSON:
{
  "score": <0-100>,
  "rationale": "<≤80 字解释判分依据>",
  "evidence": [<具体引用 lesson body 片段或缺失项, max 5 条>]
}
```

每 judge 文件内部已注释具体 rubric 要点, W1.2 实现时直接转化为 prompt 内
"RUBRIC for this dim" 段.

调用路径: `executeChat('T4_JUDGE', ...)` 经 DispatchPolicy 60/30/10 跑 GLM-4.5-Air /
DeepSeek-V4-Flash / Kimi-K2.6 (per `app/lib/llm/router.js`).

## 5. Golden + Failure 样本规则

### 5.1 Golden Samples (10 主题各 1, `app/lib/quality-harness/golden-samples/*.json`)

每 sample 含:
- `id`, `topic`, `user_profile`, `goal`
- `ideal_lesson_body`: 11-field v0.2 body, **手工编纂** — 反映 HYPHA 灵魂的样板
- `nine_dim_target_scores`: 每 dim 期望分 (用于 W1.2 校准)
- `notes`: 为何这是 golden (1 段, 必须指明反什么 anti-pattern)

**编纂规则**:
1. thesis ≤25 字, 反 encyclopedia framing
2. canonical_example 必含至少 1 个 (人名 OR 年份 OR 论文 OR 实验装置)
3. misconception 两条均高发, 带纠正 + 反 strawman
4. exit_proof 是 apply 不是 recall
5. intro_hook_scene 具体场景, 反 "本课介绍..."

### 5.2 Failure Samples (6 模式, `app/lib/quality-harness/failure-samples/*.json`)

6 failure modes:

| Mode | 主要击中 dim |
|---|---|
| `generic-textbook` | notGenericCourse / hyphaSoul |
| `jargon-soup` | jargonControl / levelMatch |
| `goal-drift` | goalCoherence |
| `fake-mastery` | evidenceOfLearning / hyphaSoul (Anti-Illusion 风险) |
| `narrative-only` | actionConversion / productTransferQuality |
| `no-evidence` | evidenceOfLearning / notGenericCourse |

每 sample 含:
- `failure_mode`: 上表之一
- `lesson_body_snippet`: 故意 fail 的 lesson body
- `why_fails`: 1 段诊断 (≤200 字)
- `nine_dim_actual_scores`: 期望 actual 分 (低)
- `regression_assertion`: harness 必须满足的判定 (e.g. "overall_score < 40 且 hyphaSoul < 15")

**用途**: regression test. W1.2 接通 T4_JUDGE 后, 跑 harness 喂这 6 个
sample, 必须每个都判 FAIL 且 weakest_dim 命中预期. 任一 sample 被判 PASS
= judge 校准不够严, 阻 ship.

## 6. CI Integration Plan

```bash
# 本地手测
node scripts/lesson-harness.js --topic="AI Agent 入门" \
  --user-profile="零基础" \
  --goal="理解 agent 与 chatbot 的本质区别" \
  --regen-count=10

# CI gate (W1.2 接 T4_JUDGE 后启用)
node scripts/lesson-harness.js --topic="..." --goal="..." --ci
# pass_rate < 80% → exit 1
```

CI workflow (deferred, W1.2 P1):
1. PR 打开 → GH Action 跑 6 failure samples regression
2. 任一 sample 误判 PASS → block merge
3. 任一 golden sample 跌出 PASS → block merge
4. v0.2 主门: nightly 对 5 个 canonical topic 各 regen 10, pass_rate ≥ 80% 才放 ship

## 7. 与 W1.2 / W1.3 / W1.4 / W1.5 边界

| Stream | 范围 | 与 W1.1 关系 |
|---|---|---|
| **W1.1 (本文)** | 9-dim grader scaffold + golden/failure 库 + CLI | 自己 ship 全部 9 judge **接口**, 但 LLM wiring 故意空 |
| **W1.2** | T4_JUDGE prompt + drift + jargon judges 真接通 | 复用 W1.1 judge 文件 (`goal-coherence.js` / `jargon-control.js`), 把 mock 换真调 |
| **W1.3** | Misconception engine generator-side | W1.1 `misconception-defense.js` 是评分; W1.3 是生成. 评分对生成 ground truth. |
| **W1.4** | Anti-Illusion / fake-mastery generator-side gate | W1.1 `evidence-of-learning.js` + failure-04 是评分; W1.4 是预防. |
| **W1.5** | Lesson generator 升级 (含 generator 路径接通 harness `--live`) | W1.1 dryRun 模式现在跑 mock; W1.5 提供真 lesson generator 入口给 `runHarness({generator})`. |

边界铁律: **W1.1 只判分, 不修复**. 修复都在 W1.2-W1.5 各自 stream 里做.
W1.1 是判官, 不是工匠.

## 8. 风险 + Known Limitations

- W1.1 scaffold 阶段 dry-run 报告里 `pass_count` 永远是 0 (judges 全返 0).
  这是预期 — 用于验证 pipe 不抛错, 不验证语义. Real signal 起于 W1.2.
- 9 judge LLM 并行调用预计每 lesson ~3-5s (T4_JUDGE 各 ~3s 但 Promise.all 压扁).
  10 lesson regen ≈ 30-50s 总 wall time. CI 单 topic 5-10 min 量级.
- T4_JUDGE 用 GLM-4.5-Air 主路 — 中文 lesson body 判分 OK; 英文 lesson 体感
  judges 可能要切 DeepSeek-V4-Flash 主路 (W1.2 校准时验).
- `hyphaSoul` judge 故意保留主观成分, 不强求纯算法 — 后续可能加 "founder
  vote panel" (用户当评委) 校准, 不在 W1 wave.
