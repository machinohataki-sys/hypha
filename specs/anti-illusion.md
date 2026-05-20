# Anti-Illusion v0 — 反学习幻觉

> Per BLUEPRINT §7.3 + ROADMAP v0.4. Scope: detect 6 illusion types after the
> user answers `exit_proof`; when one fires above confidence threshold, block
> the next-lesson jump and surface a 30-second micro-task. Default posture =
> TRUST — false positives are more harmful than false negatives, so only
> `ai_mimicry` runs a real algorithmic check today; the other 5 detectors
> stay shimmed until T4_JUDGE wiring lands in W1.3.1.

## 1. Why this exists

学习幻觉 (learning illusion) = 用户感觉懂了, 但 (a) 答案只是复制 AI 的话, (b)
举不出具体例子, (c) 换一个场景就卡住, (d) 让 LLM 代写, (e) 学完不留行动证据,
(f) 知识没有回流到 Product Pool. 蓝图明确: 检测后 *不进入下一课*, 先做
微迁移任务 / 误解修复 / Product Transfer 练习. v0 实现这条门, 不动 cadence
本身 (W2.1 责任).

## 2. 6 Illusion Types

| Type | Cue / threshold | Implementation status | 误杀风险 |
|---|---|---|---|
| `ai_mimicry` | trigram Jaccard(user_response, lessonKP.mechanism_explanation ∪ canonical_example) ≥ 0.70 | REAL (`anti-illusion/similarity.js`) | 用户复述老师原话 ≠ 幻觉; 70% 阈值 + token-level 已经过滤掉 "短句意外重复"; 进一步降假阳由 micro-task 兜底 (用户做对就放行) |
| `no_example` | exit_proof 含 (apply / example / 应用 / 举例 ...) 且用户回答 0 具体标记 (年份 / 双大写专名 / 量化 / "比如") | 启发式 0.45 + `pending(T4_JUDGE)` 0.85 | 中文用户偏抽象表达; 0.45 不触发 gate, 必须 LLM 升级 |
| `no_transfer` | 用户回答与 `canonical_example` trigram Jaccard ≥ 0.55 (= 复述锚点) | 部分实现 (canonical-restate); 完整版 `pending(T4_JUDGE)` | 简单 topic 锚点过强易误判; LLM 升级前不靠 gate |
| `ai_ghostwrite` | response_time_ms < 2000 且 len ≥ 100; 多 bullet markdown 出现在聊天答案; em-dash 出现且没有 hyphen 替代 | 启发式 timing+shape; `pending(T4_JUDGE)` perplexity 升级 | 双语用户标点习惯不同, 阈值偏严是为了 0 假阳 |
| `no_action_proof` | `actionLog` 数组非 null 且长度 = 0, confidence = 0.6 (sub-fire) | REAL 但 sub-fire 0.6 < 0.7 阈值; 真正 gate 触发需要 W2.x cadence 提供 action_log 调用方 | 早期用户没有 action_log 接口就一直为空, 误杀风险高; 故 sub-fire |
| `no_creation_reflow` | Product Pool 无相关节点 | `pending(W3.x)`: Product Pool 未上线, 总是 0 confidence | 现在不可用; 防止依赖未上线模块导致 false fire |

阈值: `FIRE_CONFIDENCE = 0.70` — 任一 signal ≥ 0.70 才触发 gate; 多 signal 同时
命中取 confidence 最高的; 其余进 `all_signals[]` 仅作 telemetry, 不影响决策.

## 3. 4 Intervention Types

| Intervention | 触发条件 | 退出条件 |
|---|---|---|
| `micro_transfer_task` | `ai_mimicry` / `no_example` / `no_transfer` 命中 | 用户在 30 秒内提交一句包含 (时间/地点/对象/数字) 的新场景应用; 再跑 gate, 通过 = 退出 |
| `misconception_repair` | LLM (T4_JUDGE, W1.3.1+) 把 `no_example` 答案标为已知 misconception | 调用 W1.4 Misconception Engine; W1.4 退出条件由该模块定义 |
| `product_transfer_drill` | `no_creation_reflow` 命中 (W3.x dep) | 调用 W3.3 Product Transfer; W3.3 上线前返回 fallback 文案 |
| `request_action_log` | `ai_ghostwrite` / `no_action_proof` 命中 | 用户提交一行 "我把 X 用到了 Y"; 写入 `action_log`; 退出 |

`INTERVENTION_MAP` 在 `anti-illusion.js` 是 source of truth, 不在 spec 里维护
重复版本.

## 4. micro_task schema

```jsonc
{
  "id":              "mt_<base36-ts><rand6>",      // 唯一 id, gate 内生成
  "type":            "micro_transfer_task | misconception_repair | product_transfer_drill | request_action_log",
  "prompt":          "string, ≤ 200 字, 模板化 (W1.3 v0); LLM 升级 (W1.3.1)",
  "expected_format": "text | choice",              // v0 只用 text
  "timeout_sec":     30                            // 软超时, UI 提示用; 不真断
}
```

Prompt 模板 (v0, 由 `buildMicroTask()` 合成):

- `micro_transfer_task`: "把刚才学到的'<anchor>'用到一个全新场景 (不要重复课上的例子). 写 1-3 句, 必须有时间地点或具体对象."
- `misconception_repair`: "用一句话说出本节最容易被搞错的地方, 以及正确的判断是什么. 提示: 联系机制是 — <mechanism>"
- `product_transfer_drill`: "把本节学到的东西转译成你手头任何一个真实事物的一处改动 — '我会把 X 改成 Y, 因为 Z'. 一句话."
- `request_action_log`: "写一行实证: '我把 ___ 用到了 ___'. 没用过就承认没用过, 别编."

模板有意短 + 动词领头 — 千金 register 而非样板话. 升级版交 T4_JUDGE LLM
根据具体 lessonKP 上下文重写 (W1.3.1).

## 5. Gate Decision Flow

```
user answers exit_proof
        │
        ▼
   detectIllusion(userResponse, ctx)
        │
        ├── all 6 detectors run in parallel (pure JS, no LLM in v0)
        │       1. detectMimicry         — trigram jaccard, REAL
        │       2. detectNoExample       — marker scan, sub-fire only
        │       3. detectNoTransfer      — canonical-restate, partial
        │       4. detectGhostwrite      — timing + shape heuristic
        │       5. detectNoActionProof   — empty-array signal
        │       6. detectNoCreationReflow — placeholder, always 0
        ▼
   pick highest-confidence signal where confidence ≥ FIRE_CONFIDENCE (0.70)
        │
        ├── none fires → { allowed: true,  micro_task: null }
        │
        └── one fires  → buildMicroTask(suggested_intervention, lessonKP)
                      → { allowed: false, reason, required_action, micro_task }
        ▼
   UI renders inline micro-task block above postSessionResult
        │
        ├── user submits → re-run gate with new answer as exit_proof
        │       └── allowed=true  → clear gate, log "passed"
        │       └── allowed=false → keep gate, swap prompt
        │
        └── user clicks "暂时跳过" → clear gate, log "bypass" event
```

## 6. 与相邻模块的边界

- **W1.2 Anti-Generic-Course Detector** (`anti-generic-detector.js`) — 检测的
  是 *老师输出* 是否网课式样板话. Anti-Illusion 检测的是 *学生输出* 是否伪懂.
  两个不同维度, 互不调用.
- **W1.4 Misconception Engine** — Anti-Illusion 的 `misconception_repair`
  intervention 在 W1.4 上线后变成 W1.4 调用入口; v0 用 prose stub 占位.
- **W2.1 Lesson Cadence Engine** — Anti-Illusion 只决定 *能不能跳下一课*,
  不改节奏 (rest / review / 难度). 节奏由 W2.1 负责.
- **W3.3 Product Transfer** — `no_creation_reflow` detector + 
  `product_transfer_drill` intervention 是 W3.x 上线后的入口预留;
  v0 detector 永远返回 0 confidence, intervention 返回 fallback 文案.
- **streamTurn / scoreMicroProof** — 不动. scoreMicroProof 评估的是 lesson
  *内部* micro_proof (Recall + Production); Anti-Illusion 评估的是 lesson
  *出口* exit_proof + 跨 lesson trace. 互补不重叠.

## 7. Telemetry / events.jsonl

UI hook 在用户触发 gate 后写一行 (W1.3.1 接 main.js 的 events 写入):

```jsonc
{
  "ts": "<ISO>",
  "type": "illusion:gate:fired",
  "illusion_type": "ai_mimicry",
  "intervention": "micro_transfer_task",
  "micro_task_id": "mt_...",
  "confidence": 0.82,
  "lesson_rel": "vault/<slug>/lesson-NN.md"
}
```

完成 / 跳过事件:

```jsonc
{ "ts": "<ISO>", "type": "illusion:micro_task:passed", "micro_task_id": "mt_..." }
{ "ts": "<ISO>", "type": "illusion:micro_task:bypassed", "micro_task_id": "mt_...", "reason": "<gate.reason>" }
```

## 8. v0 → v0.1 升级路径

1. **W1.3.1** — 把 `detectNoExample` / `detectNoTransfer` / `detectGhostwrite`
   的 `pending(T4_JUDGE)` 标记换成 `llm.executeChat('T4_JUDGE', ...)`. 每个
   detector 自己跑, 不串行.
2. **W1.3.2** — `buildMicroTask` 的模板换成 LLM-authored. 模板仍保留为 fallback,
   LLM 失败 = 静默退回模板.
3. **W1.4 上线** — `misconception_repair` 改成调用 W1.4 surface, 不再返回
   prose stub.
4. **W2.1 上线** — `actionLog` 入参从 UI 占空数组改成真 cadence 输出.
5. **W3.x 上线** — `detectNoCreationReflow` 接 Product Pool 查询.

## 9. 不做什么

- 不做 hard-block "Next Lesson" button — v0 是 advisory inline panel; hard-block
  绑在 W2.1 cadence engine 上线后做 (那时候 "Next Lesson" 才是一个 1st-class
  state-machine transition).
- 不做 multi-round 累积评分 — gate 是 binary 决策, 累积评分进 Mastery Map.
- 不写 "请重新作答" 弹窗 — 用 inline + 编辑器 textarea, 不破坏阅读流.
