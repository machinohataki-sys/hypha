# Goal Guardian + Affective Router — W2.3

> Per BLUEPRINT §3.4 (Goal Guardian) + ROADMAP v0.6. Scope: monitor user
> learning-behavior drift (frustrated / self-doubt / distracted / spark /
> high-energy) and route to gentle interventions that adjust **delivery**
> (tone, difficulty, pacing) without changing the **goal direction** itself.
> Pairs with W1.2 Drift Detector (output-layer drift) and feeds W2.4 Repair
> pipelines (Confusion / Motivation / Self-doubt Repair).

## 1. Why this exists

User 在课程中段会偏航。偏航不一定是认知问题, 经常是情绪/状态问题: 一段难懂的
内容卡住 → 沮丧 → 自我怀疑 → 走神或拖延 → 整章放弃。工业化教育忽视这条状态
线 (Khan Academy 进度条更焦虑而非更安心)。Hypha 的差异化是 **manuscript-register
tutor** + **state-aware companion**: 不是用激将法或徽章弹窗拉人, 而是在感知到
低落时把当前 KP 难度降一档、改换更温和的语气, 在感知到高能时立即开 Capture
口子接住灵感。

Guardian 守护的是 **goal direction**。它绝对不改变学习目标方向, 只调节:

- **prompt_modifier** — 下一 turn tutor system prompt 的语气片段 (e.g.
  "用户当前 frustration, 用更温和的口吻, 减少术语, 给一个具体类比")
- **difficulty_adjust** — 下一 KP 的 -1 / 0 / +1 难度调整 (W1.4 Misconception
  Engine / W2.4 Confusion Repair 使用)
- **redirect_message** — 在 distraction / off-topic 时输出 1 句温和回主线提示,
  不阻断对话

边界 (binding):
1. Goal Guardian **不** 改 lesson plan 顺序、**不** 改 KP 列表、**不** 改
   north_star_goal。它只是 modulator (调制器), 不是 mutator (变更器)。
2. Goal Guardian **不** 替代 W2.4 Repair 自身的 prompt。它的责任是 *detect →
   decide → dispatch*。具体 repair 由对应模块负责。
3. Guardian 假设 user 处于已 ratified 的 Goal Contract 下 (W1.1 已 ship)。
   Contract 缺失 → guardian 降级为只发 affect 信号, 不发 intervention。

## 2. 6 Guardian States

| State          | 触发 cue                                              | guardian_action       |
| -------------- | ----------------------------------------------------- | --------------------- |
| `on_track`     | 默认。signals 为空 / score 趋稳 / 无偏题词。          | (none)                |
| `drifting`     | 用户提到其它无关主题但口吻平稳, 1 次跨主题问。        | `gentle_pullback`     |
| `frustrated`   | frustration_marker 命中 (我不懂 / 卡了 / 糟糕 / 算了) | `lower_difficulty` 或 `revive_motivation` |
| `self_doubt`   | doubt_marker 命中 (我是不是 / 可能 / 也许) + 自我贬低 | `repair_self_doubt`   |
| `distracted`   | distraction_marker 命中, 连续 2 次 off-topic 名词。   | `redirect_distraction` |
| `high_energy`  | spark_marker 或 high_energy_marker, sentiment ≥ 0.6   | `capture_spark`       |

### state 退出条件

- `on_track` → 状态默认, 任何 turn 后 fall-back。
- `drifting` → 用户下一条回到主线 (无 distraction_marker) → 回 `on_track`。
- `frustrated` → 用户连续 2 turn 无 frustration_marker 且 sentiment ≥ 0 → 回
  `on_track`; difficulty_adjust 在该课程剩余 KP 中 持续到 user 主动 +1。
- `self_doubt` → W2.4 Self-doubt Repair pipeline 给出 confirmation, user 主动
  确认 "我懂了" → 回 `on_track`。
- `distracted` → 连续 2 redirect 后 user 仍 off-topic → 升级 STUCK + 写
  events.jsonl `guardian_stuck`, 提示用户休息或换课。
- `high_energy` → spark 捕捉完成 (W1.5 capture:close 返回 ok) → 回 `on_track`。

## 3. 6 guardian_action

| Action               | 描述                                                              | 退出 / 调用 |
| -------------------- | ----------------------------------------------------------------- | ----------- |
| `gentle_pullback`    | 1 句温和提醒 "我们刚才在聊 X — 想继续吗?", 不阻断对话             | self-loop, 下一 turn 自动 fall-back |
| `lower_difficulty`   | difficulty_adjust = -1, prompt_modifier 注 "简化解释, 加一个生活化类比" | 触发 W2.4 Confusion Repair pipeline (W2.4 责任) |
| `revive_motivation`  | prompt_modifier 注 "用户低落, 先 acknowledge 难度再继续, 不要 cheerleading" | 触发 W2.4 Motivation Recovery pipeline |
| `repair_self_doubt`  | prompt_modifier 注 "用户在自我怀疑, 先确认他答对的部分, 不要先纠错" | 触发 W2.4 Self-doubt Repair pipeline |
| `capture_spark`      | UI 弹出 "捕捉这个灵感? [📓 capture]" 小提示                       | 调 W1.5 capture:start; user 拒绝 → 直接 fall-back |
| `redirect_distraction` | 1 句记下后回主线 "记下了 — 我们先把这节做完, 等下回头聊那个"      | self-loop, 下一 turn 自动 fall-back |

## 4. Affective Signals (cheap regex pre-screen, T4_JUDGE 二判 deferred)

### signals 列表

| Signal                 | 触发词 (regex pre-screen)                                                     | 升级条件 |
| ---------------------- | ----------------------------------------------------------------------------- | -------- |
| `frustration_marker`   | `(我不懂\|看不懂\|卡了\|卡住\|糟糕\|算了\|放弃\|太难了\|不会\|难死了\|烦)`     | confidence ≥ 0.55 → 触发 frustrated state |
| `doubt_marker`         | `(我是不是\|可能.*不行\|也许.*不\|怀疑自己\|笨\|没天分\|学不会\|不适合)`        | + 短句 (≤ 30 char) + 不含问号 → self_doubt |
| `distraction_marker`   | off-topic 名词 (与 lesson KP 无 token 重叠) + 问号                            | 连 2 turn → distracted |
| `spark_marker`         | `(我想到\|灵感\|想到了\|有个想法\|突然\|联想到\|类比到\|可不可以)`             | + 句尾感叹 or 问号 → high_energy state |
| `high_energy_marker`   | `(!\|！\|真的吗\|哇\|cool\|amazing\|爆炸\|绝了)` (! 排除 zh AI 流量词)         | + sentiment ≥ 0.6 → high_energy |
| `agreement_marker`     | `(明白了\|懂了\|对\|是的\|确实\|没错)` (telemetry only, 不触发 action)          | (none, on_track 印证) |

### sentiment / energy 基线打分 (cheap regex)

- `sentiment`: -1..1。每条 user turn 起始 0, 命中 frustration/doubt 减 0.3, 命中
  agreement 加 0.2, 命中 spark/high_energy 加 0.4。clip 到 [-1, 1]。
- `energy`: 0..1。turn 长度 (char) > 60 + 含 `!` / `？` / 多句号 → +0.3;
  极短 (≤ 6 char) 沉默式回答 → -0.3。clip [0, 1]。

### T4_JUDGE 二判 (deferred 到 W2.3.1)

cheap regex 走 0.45 confidence 上限。要把 confidence 推到 0.85 触发 strong
action (例如 self_doubt 调 Repair 而非仅修语气), 必须 T4_JUDGE 二判:

```js
// TODO W2.3.1
// const llmResult = await executeChat('T4_JUDGE', {
//   messages: [
//     { role:'system', content: '你是 Hypha 情绪审计员, 判断 user 当前学习状态' },
//     { role:'user', content: `近 3 turn: ${recentTurns}\n返回 JSON: {state, confidence, evidence[]}` }
//   ],
//   json: true,
//   temperature: 0,
// });
```

shim 当前给固定 mock confidence = 0.55, 让 frustrated / self_doubt 都进入
intervention 但不触发 strongest path。

## 5. 与其它 layer 的边界

### vs W1.2 Goal Drift Detector

| 维度 | W1.2 Drift Detector             | W2.3 Goal Guardian              |
| ---- | -------------------------------- | -------------------------------- |
| 监控对象 | lesson body (LLM 输出)        | user turn (人类输入)             |
| 触发层 | 输出层 (内容偏 goal)            | 行为层 (状态偏 goal)             |
| 输出 | drift_score 0-100 + axes        | state + guardian_action + intervention |
| 副作用 | 触发 lesson regen (1 次)        | 注 prompt_modifier + difficulty_adjust (持续) |
| 失败模式 | LLM 跑题, 写离 goal             | user 沮丧, 想放弃                |

两者正交, 同 turn 可同时触发。

### vs W1.3 Anti-Illusion

| 维度 | W1.3 Anti-Illusion               | W2.3 Goal Guardian              |
| ---- | -------------------------------- | -------------------------------- |
| 监控对象 | user 答 exit_proof              | user 在课程中任意 turn          |
| 触发条件 | 用户假装懂                       | 用户情绪状态偏                  |
| 输出 | illusion_type + micro_task       | guardian_state + intervention   |
| 关系 | Anti-Illusion = "你懂了吗" 检查 | Guardian = "你状态 OK 吗" 检查 |

Illusion + Guardian 可叠加: user 沮丧 (Guardian = frustrated) + 用 AI 复写
(Illusion = ai_mimicry) → 先 Guardian lower_difficulty + acknowledge, 再
Illusion micro_task。

### vs W2.4 Repair

Guardian 是 dispatcher, W2.4 是 executor。

```
streamTurn(user_msg) → affective-router.extractAffect → goal-guardian.assess
   → if state ∈ {frustrated, self_doubt} → decideIntervention →
     intervention.intervention_type → call W2.4 pipeline:
       'lower_difficulty'   → W2.4.ConfusionRepair.run({slug, lesson, kp})
       'revive_motivation'  → W2.4.MotivationRecovery.run({slug, lesson})
       'repair_self_doubt'  → W2.4.SelfDoubtRepair.run({slug, recentTurns})
```

W2.4 pipelines 在 W2.4 ship 之前不存在; Guardian 在那之前只生成
intervention object + 注 prompt_modifier, 不实际调 repair。fall-back 是
prompt 注入 + 等下一 turn 自然 recovery。

## 6. Implementation status

- `app/lib/affective-router.js` — cheap regex pre-screen REAL (sentiment /
  energy / 6 signal types); T4_JUDGE 二判 TODO (mock 固定 confidence 0.55)。
- `app/lib/goal-guardian.js` — state machine + decideIntervention REAL; W2.4
  Repair pipeline 调用 placeholder (W2.4 上线后切 import path)。
- `app/main.js` — 3 IPC (`guardian:assess` / `guardian:intervene` /
  `affect:extract`) wired。
- `app/preload.js` — `window.ptor.guardian` + `window.ptor.affect` bridges。
- `app/agent.js` `streamTurn` 集成: 每 user turn 后调 extractAffect, 若 signals
  非空 → 调 assessGuardianState → write events.jsonl, 注 prompt_modifier 到
  下一 turn。
- UI: `screen-lesson-chat.jsx` PageFrame 加 `GuardianBadge` (颜色编码 +
  italic Garamond 标签, 不强弹 modal); spark 状态用 inline 提示行 (italic,
  非弹窗) 不打断 manuscript register。

## 7. Events.jsonl rows

每次 assessGuardianState 调用都写 `guardian_state_assessed`:

```jsonc
{
  "ts": "2026-05-13T12:34:56Z",
  "op": "guardian_state_assessed",
  "slug": "spinoza-ethics",
  "lesson_idx": 4,
  "state": "frustrated",
  "confidence": 0.62,
  "signals": ["frustration_marker"],
  "guardian_action": "lower_difficulty",
  "difficulty_adjust": -1
}
```

`decideIntervention` 不写独立 row (intervention 是 assess 的派生)。

## 8. Privacy / safety

- 所有 affect signals 留在 `vault/<slug>/events.jsonl` 内。不外发。
- 不做 longitudinal sentiment tracking, 不画 mood graph。Guardian 是 transient
  调制器, 每 turn 重新评估。
- `repair_self_doubt` 路径严禁 cheerleading 话术 (违 manuscript register +
  AMD-MEOW-P8 Anti-Ingratiation Filter)。措辞统一走 W2.4 Self-Doubt Repair
  template (Garamond cadence)。

## 9. Test fixtures (placeholder for `__tests__/goal-guardian.test.js`)

≥ 12 test.todo() items:

1. extractAffect 命中 frustration_marker (我不懂)
2. extractAffect 命中 doubt_marker + 短句 → self_doubt cue
3. extractAffect 命中 spark_marker + ! → high_energy
4. extractAffect 计算 sentiment 区间 [-1, 1]
5. extractAffect energy 在长 turn 时 > 0.5
6. extractAffect 沉默 turn (≤ 6 char) energy < 0.3
7. assessGuardianState 默认 on_track 当 signals 空
8. assessGuardianState frustration_marker → state=frustrated
9. assessGuardianState 连续 2 distraction_marker → distracted
10. decideIntervention frustrated → lower_difficulty + difficulty_adjust=-1
11. decideIntervention high_energy → capture_spark + 不改 difficulty
12. decideIntervention 不在 W2.4 上线前调 repair pipeline (placeholder noop)
13. routeAffect 单 signal → 单 action; 多 signal → 选最高优先级
14. assessGuardianState 输出 evidence 携带触发词 (telemetry)
