# Exam Model Alpha — W7.2 (考研英语)

> STATUS: theoretical ship 2026-05-13. Single scenario alpha per ROADMAP v2.1.
> Pairs with [exam-system.md](./exam-system.md) (vision) + [BLUEPRINT.md §13](../BLUEPRINT.md).
> Scope: 考研英语 (Chinese postgraduate entrance English exam). v2.2 will add a
> second scenario (考公行测) to verify Scope-Engine cross-scenario generalization.

---

## 1. Module map

| File | Purpose |
|---|---|
| `app/lib/exam-system/scope-engine.js`     | 4-tier scope classifier + per-tier progress |
| `app/lib/exam-system/exam-cadence.js`     | Deadline-aware exam-stream cadence (4 phases) |
| `app/lib/exam-system/user-bank.js`        | CSV / JSON / MD bank import + tagging |
| `app/lib/exam-system/error-diagnosis.js`  | 8-cause heuristic classifier + JSONL log |
| `app/lib/exam-system/final-compression.js`| 5 final-task buckets + 7-day daily plan |
| `app/design/screen-exam-dashboard.jsx`    | Single dashboard surface (scope / cadence / errors / final) |
| `app/main.js` (W7.2 block)                | 17 IPC handlers, `exam:*` |
| `app/preload.js` (W7.2 block)             | `window.ptor.exam.*` bridge |

Vault layout (data, never overwritten by Hypha unless user opts in):

```
vault/<slug>/exam/
├── scope.json                        # 4-tier override (per slug)
├── bank/
│   └── <bank_id>.json               # imported question bank
├── error-log.jsonl                  # all errors with diagnosis
└── final-state.json                 # entered-final-compression timestamp
```

---

## 2. 4 tiers — Exam Scope Engine

Per BLUEPRINT §13.1. Goal: stable recall within scope, not infinite expansion.

| Tier | Meaning | 考研英语 seed (蓝图原文) |
|---|---|---|
| **must_master**  | 必须掌握 — exam-mandatory | 核心词汇 5500 · 高频真题词 1800 · 熟词僻义 300 · 高频词组 600 · 阅读题型 7 类 · 长难句 5 种 · 作文模板 12 类 |
| **high_yield**   | 高收益拓展 — high return per hour | 熟词僻义高级 500 · 阅读细节定位 · 翻译技巧 8 法 · 写作主题词汇 300 |
| **recognition**  | 只需认识 — see it, don't panic   | 冷门词汇 (4000+ 之外) · GRE 阅读 |
| **out_of_scope** | 暂不学习 — explicitly excluded   | 口语 · 听力 (考研无) · 雅思类阅读 |

`classifyTopic(topicText, scope?)` walks tiers in priority order
(must_master → high_yield → recognition → out_of_scope). Exact substring match
of scope arrays wins first, then a keyword fallback index, then OUT_OF_SCOPE.
The keyword fallback is deterministic and pure JS — T4_JUDGE-backed semantic
classification is deferred (see Future work).

---

## 3. 4 cadence modes — Deadline-Aware Cadence

Per BLUEPRINT §13.4 and ROADMAP v2.1. Triggers on `daysRemaining` (band scan
from narrowest to widest):

| Mode | Days remaining | Primary focus | new / review / drill / mock |
|---|---|---|---|
| **expansion**     | > 60          | new_must_master → new_high_yield | 70 / 20 / 10 / 0 |
| **consolidation** | 30 < d ≤ 60   | consolidate_gaps                 | 40 / 40 / 20 / 0 |
| **compression**   | 7  < d ≤ 30   | error_drill                      | 10 / 30 / 40 / 20 |
| **final**         | d ≤ 7         | review_high_freq                 | 0 / 50 / 30 / 20 |

Escalations:
- expansion + must_master < 50%  → focus = NEW_MUST_MASTER (delay high_yield)
- expansion + must_master ≥ 70%  → focus = NEW_HIGH_YIELD
- consolidation + errorAcc ≥ 20  → focus = ERROR_DRILL
- compression + must_master < 0.85 → progress warning

### Relation to W2.1 cadence-engine

W2.1 decides **per-lesson rhythm** (deep / balanced / compress / final) for
*any* learner. W7.2 decides **exam-period phase** (expansion / consolidation /
compression / final) specifically for Exam-goal-type learners. They are
orthogonal pure functions; the caller composes them. Final mode in both →
final compression takes precedence.

### Relation to W2.2 assignment-cadence

Exam mode adjusts assignment level range:

| Exam mode      | Recommended assignment Level |
|---|---|
| expansion      | L3 — L4 (applied + product spark) |
| consolidation  | L2 — L3 (drilling + applied)      |
| compression    | L2 — L3                           |
| final          | L1 only (micro proof review)      |

`assignmentLevelRangeForMode(mode)` exports this table for the W2.2 caller.

---

## 4. User-owned Bank — 4 题源 layer, v2.1 covers 1

Per BLUEPRINT §13.2.

| Layer | Source | v2.1 status |
|---|---|---|
| 1 — Licensed Bank      | Authorized commercial banks | not in v2.1 (legal partnership v3.0) |
| 2 — **User-owned Bank**| User imports own materials  | **shipped (this wave)** |
| 3 — Public Index       | Open exam archives          | v2.2 |
| 4 — Synthetic Practice | AI-generated drills         | v2.2 (T6_STRONG router) |

### Supported import formats

CSV — RFC 4180-ish header row + quoted fields. Required columns: `question, answer`. Optional: `options, topic, tier, difficulty, source`.

```
question,answer,options,topic,tier,difficulty
"What does ""ambivalent"" mean?","Having mixed feelings","mixed | strong | rare","核心词汇 5500",must_master,medium
```

JSON — top-level array OR `{ items: [...] }`.

```json
{ "items": [{ "question": "...", "answer": "...", "topic": "长难句 5 种", "tier": "must_master" }] }
```

Markdown — block format:

```
### Q: What does "ambivalent" mean?
A: Having mixed feelings
Options: mixed | strong | rare
Topic: 核心词汇 5500
Tier: must_master
Difficulty: medium
```

Item schema (post-normalization):

```js
{
  question:   string,        // required
  answer:     string,        // required
  options?:   string[],      // 4-option MCQ etc.
  topic:      string,        // optional, default ''
  tier:       string,        // must_master|high_yield|recognition|out_of_scope (default must_master)
  difficulty: 'easy'|'medium'|'hard',   // default medium
  source:     string,        // attribution
}
```

`tagItem(slug, bankId, itemIdx, patch)` updates tier / topic / difficulty
immutably (writes a fresh items array).

---

## 5. 8 error causes — Error Diagnosis

Per BLUEPRINT §13.3 exact wording. Each cause has a default repair_strategy
the UI surfaces alongside the user's wrong answer.

| Cause       | Chinese label | Default repair_strategy |
|---|---|---|
| `vocab`       | 词汇       | 加 vocab 复习节点 + 高频真题词 spaced repetition |
| `parse`       | 长难句     | 插长难句模块 (5 种结构) + 切分练习 |
| `locate`      | 定位       | 阅读细节定位训练 + 关键词回扫练习 |
| `swap`        | 偷换       | 同义替换对照表 + 干扰项识别 drill |
| `causal`      | 因果       | 因果连接词清单 + 逻辑链画图练习 |
| `tone`        | 态度       | 作者态度词标记 + 立场判断 drill |
| `over-infer`  | 推断       | 严格"原文 / 推断"两栏对照 drill |
| `timeout`     | 时间       | 限时训练 + 阅读优先级排序 + 跳题策略 |

`diagnoseError({ question, userAnswer, correctAnswer, context })` runs
heuristic keyword classification synchronously. The output object has
`mock: true` — UI must mark this clearly. Real T4_JUDGE wiring lands with v2.2
(shares router with `app/lib/judges/`).

Error log stored at `vault/<slug>/exam/error-log.jsonl`, one row per error,
schema per BLUEPRINT §13.3:

```yaml
error_id:         err-<base36>-<rand>
question_ref:     <题目位置 e.g. "bank-XYZ#42">
user_answer:      ...
correct_answer:   ...
error_class:      vocab | parse | locate | swap | causal | tone | over-infer | timeout
severity:         low | medium | high
remediation_path: <推荐课程 / 练习 / 复习节点>
ts:               ISO-8601
```

---

## 6. Final Compression — 5 task types

Per BLUEPRINT §13.4 mapped to 5 task buckets (蓝图 7 项的"停学新"由 cadence
mode='final' 表达, "保持状态"是 side-effect; 剩余 5 项 → 5 task type):

| Task type                    | Chinese label | Item source |
|---|---|---|
| `review_high_freq`           | 复习高频点  | scope.must_master |
| `review_errors`              | 回顾错题    | error-log.jsonl top 20 by recency × severity |
| `compress_essay_templates`   | 压缩作文模板| scope.must_master filtered for 作文/模板 |
| `time_limited_practice`      | 限时训练    | scope.must_master 阅读/长难句 top 3 + 20-min cap |
| `light_mock`                 | 轻量模拟    | scaffolding row (real mock papers via Licensed Bank, v2.2) |

`enterFinalCompression(slug)` writes `vault/<slug>/exam/final-state.json` +
appends an `exam_final_entered` event. `dailyFinalPlan(slug, daysRemaining)`
returns the 7-day plan, sliced to whatever days remain. Default 7-day plan
(D-7 → D-1):

| Day | Primary | Secondary |
|---|---|---|
| D-7 | review_high_freq | review_errors |
| D-6 | light_mock | review_errors |
| D-5 | review_high_freq | compress_essay_templates |
| D-4 | time_limited_practice | review_errors |
| D-3 | light_mock | compress_essay_templates |
| D-2 | review_errors | compress_essay_templates |
| D-1 | review_high_freq | (none) |

---

## 7. IPC surface

All handlers return `{ ok, ... }` | `{ ok:false, error }`.

| IPC | Purpose |
|---|---|
| `exam:scope`         | read 4-tier scope for a slug |
| `exam:setScope`      | persist custom scope |
| `exam:classifyTopic` | classify a topic string into a tier |
| `exam:tierProgress`  | per-tier completion % |
| `exam:cadence`       | compute exam-stream cadence |
| `exam:importBank`    | parse + persist a user-uploaded bank file |
| `exam:listBanks`     | list bank meta for a slug |
| `exam:bankItem`      | read one item |
| `exam:tagItem`       | mutate topic/tier/difficulty on one item |
| `exam:diagnose`      | run heuristic error classifier |
| `exam:errorLog`      | reverse-chrono error log |
| `exam:appendError`   | append a row |
| `exam:errorCounts`   | counts by cause |
| `exam:enterFinal`    | transition into final compression |
| `exam:finalTasks`    | 5-bucket task list |
| `exam:dailyFinal`    | 7-day daily plan |
| `exam:finalState`    | read final-state.json |

Renderer side: `window.ptor.exam.*` (see `app/preload.js`).

---

## 8. Future work — v2.2+

- **T4_JUDGE-backed error diagnosis** — replaces heuristic classifier; shares router with `app/lib/judges/`.
- **Layer 3 Public Index** — open exam archives + provenance.
- **Layer 4 Synthetic Practice** — T6_STRONG-generated drills constrained to per-tier scope.
- **Second scenario** — 考公行测某模块 (e.g. 数量关系 / 言语理解); validates Scope Engine cross-scenario generalization.
- **Mock paper integration** — `light_mock` task pulls actual mock papers from Layer 1 once shipped.
- **UI** — bank import wizard, tier-mark gestures on lesson notes, finalTasks gated lesson view.
