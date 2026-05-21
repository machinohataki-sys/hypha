# Lesson Cadence Engine — Wave 2.1 spec

> 节奏决策层. 决定"当前该深学 / 平衡 / 压缩 / 终压" + 何时插 Review Day / Integration Day + 何时建议休息.
>
> 蓝图来源: `BLUEPRINT.md` §3.3 Deadline-Aware Cadence + §8.1 Lesson Cadence Engine + `ROADMAP.md` v0.5.
> 主实现: `app/lib/cadence-engine.js` (纯函数) + `app/lib/cadence-state.js` (持久化).
> IPC: `cadence:compute` / `cadence:state` / `cadence:advance` (`app/main.js`).
> UI: `app/design/screen-lesson-chat.jsx` `<CadenceCard>` 组件.

## 1. 输入 7 参数

| 字段 | 类型 | 取值 | 含义 |
|---|---|---|---|
| `goalType` | string | `Exam` / `Growth` / `Hybrid` | 目标类型. Exam 看时间紧迫度, Growth 看认知状态. |
| `dayIdx` | number | ≥ 0 | 当前天数 (since curriculum start). 当前 telemetry only. |
| `lessonIdx` | number | ≥ 0 | 当前课序号 (0-based). 用于距 last-review 计算. |
| `learningScore` | number | 0..100 | 最近 3 课均分. 来自 W1.1 quality harness. |
| `confusionLevel` | number | 0..1 | 困惑度. 来自 W1.3 illusion 信号 + 用户主诉聚合. |
| `milestoneProgress` | number | 0..1 | 里程碑进度. 跨阈值时触发 Integration Day. |
| `reviewNodesDue` | number | ≥ 0 | 待复习节点数 (来自 SRS scheduler). |
| `daysRemaining` | number? | ≥ 0 或 null | 距 deadline. Growth 无 deadline 可 null. |

输入越界 → `cadence_mode: 'invalid'` (不抛). Exam goalType 必须有 `daysRemaining`.

## 2. 输出 schema

```ts
{
  cadence_mode: 'deep' | 'balanced' | 'compress' | 'final' | 'invalid',
  next_lesson_type: 'new' | 'review' | 'integration' | 'final_compression',
  rest_required: boolean,
  rationale: string,                                  // 1-行中文解释
  ratios: { new: number, review: number, drill?: number },
  kp_coefficient: number,                             // 1.00 / 0.80 / 0.60
  milestone_progress: number,
  days_remaining: number | null,
}
```

## 3. cadence_mode 决策表

### Exam goalType

| `daysRemaining` | mode | 节奏意图 |
|---|---|---|
| ≤ 1 | `final` | 停止扩张, 只做 Final Compression (高频考点重练). |
| ≤ 7 | `compress` | 高频 + 错题 + 模拟. KP density × 0.80. |
| ≤ 30 | `balanced` | 理解 + 练习平衡. |
| > 30 | `deep` | 深学 + 打地基 + 允许探索. |

### Growth goalType (无 deadline)

| 条件 | mode |
|---|---|
| `learningScore < 50` | `deep` (降速深学) |
| `confusionLevel ≥ 0.6` | `deep` |
| `learningScore ≥ 80` AND `confusionLevel ≤ 0.2` | `balanced` |
| 其他中间区 | `balanced` (默认) |

### Hybrid

Hybrid = Exam-band 兜底 + Growth floor. 取较深的那个 (用户认知状态 trump 时间压力).
例: 时间 → balanced, 但 score 30 + confusion 0.8 → 强制 `deep`, rationale 显式注明 "认知状态覆盖时间".

## 4. Review Day / Integration Day / Rest 触发规则

### Review Day (`shouldTriggerReviewDay`)

任一条件触发, 下一课改 `next_lesson_type: 'review'`:

- `reviewNodesDue ≥ 3` — 复习积压
- `(lessonIdx - lastReviewIdx) > 7` — 距上次复习超 7 课
- 首次 review (lastReviewIdx 为 null) 且 `lessonIdx > 7` — 启动期 review

### Integration Day (`shouldTriggerIntegrationDay`)

`milestoneProgress` 跨过 `[0.25, 0.5, 0.75]` 任一阈值且未在 `cadence-state.milestoneCrossed[]` 中 → `next_lesson_type: 'integration'`.
跨过后, `advanceCadence` 把阈值加入 `milestoneCrossed[]` 防重复触发.

### Rest (`shouldRest`)

`lessonsSinceLastRest ≥ 4` 且 `learningScore < 50` → 建议休 (UI 显示灰色提示, 不阻断).

## 5. cadence-state.json schema

写在 `vault/<slug>/cadence-state.json`. SCHEMA_VERSION = 1.

```json
{
  "lastReviewIdx": null,
  "milestoneCrossed": [],
  "restCount": 0,
  "lastRestIdx": null,
  "lessonsSinceLastRest": 0,
  "cadenceMode": null,
  "updatedAt": "ISO timestamp",
  "version": 1
}
```

`appendCadenceEvent` 在 `events.jsonl` 加一行:

```json
{ "ts": "ISO", "slug": "...", "type": "cadence_review_triggered",
  "lessonIdx": 5, "reviewNodesDue": 3 }
```

Event types: `cadence_review_triggered` / `cadence_integration_triggered` / `cadence_rest_required` / `cadence_mode_shift`.

## 6. 与现有系统的关系 (重要)

| 系统 | 职责 | 与 Cadence 关系 |
|---|---|---|
| `deriveLessonTarget` (agent.js:4764) | 决定课程总数 | 不重叠. 总数 vs 节奏. Cadence 不动总数. |
| `lessonSplit` (agent.js:2788) | 决定每课 KP 数 (Miller 上限) | Cadence `kp_coefficient` 可乘其输出微调 (opt-in, 通过 `applyCadenceCoefficient`). lessonSplit 本身不变. |
| `computePhaseLessonCounts` | 按 phase 权重分总数 | 不重叠. |
| `anti-illusion-gate` (W1.3) | 触发 micro-task (advisory) | W1.3 advisory, W2.1 hard-block 时机. W1.3 信号 (confusion) 喂 cadence 输入. |
| W2.2 Assignment Cadence | 作业级别 (Level 1-5) | 并列. W2.2 read-only 读 cadence-state.json, 不写. cadence_mode 影响 assignment ratios 但 W2.2 独立计算. |
| W2.3 / W2.4 | 未启动 stream | 不交叉. |

## 7. UI 集成

`<CadenceCard>` mount 在 `PageFrame` 顶部 row (与 `JudgeBadges` 并列), 仅当 prop `cadenceCtx` 传入时显示:

- 色点 (deep 深绿 / balanced 橄榄 / compress 琥珀 / final 砖红) + 中文标签
- Exam 模式额外显示 "剩 N 天"
- "下一课 · 新课 / 复习日 / 整合日 / 终压" hint
- `rest_required=true` → 灰色 italic "建议休息一下"
- `title=` tooltip 显示 rationale

`useEffect` 调 `window.ptor.cadence.compute(...)` 拿 decision. 失败 → 静默不渲染 (不 block 任何用户动作).

## 8. 不变量 (invariants)

- `computeCadence` 纯函数. 同输入必同输出. 无 I/O / LLM / Date.now().
- 输入 invalid → 返 `{ cadence_mode: 'invalid', ... }`. 不抛.
- `cadence_mode` 只可能取 5 个枚举值之一.
- `kp_coefficient ∈ [0.6, 1.0]`. 仅当 `compress` (0.8) / `final` (0.6) 减 KP.
- `applyCadenceCoefficient` 每 slot 至少 1 KP (一节课必须有 ≥1 原子).
- `appendCadenceEvent` 失败 silent. cadence 事件丢失 < 课程流断裂.
- 老 state.json 缺 cadence-state.json → `loadCadenceState` 返默认 state (不创建文件), 不报错.

## 9. 单元测试 (placeholder)

`__tests__/cadence-engine.test.js` 含 ≥ 12 `test.todo()`: 覆盖 4 mode × 3 goalType + trigger 规则 + invalid 输入. 测试体留给 W2.1 校准 pass — engine 逻辑此时已完成且通过 smoke verify.
