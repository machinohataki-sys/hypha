# 7-Day Growth Path · AI Builder (W4.1)

> Spec for the v1.0 Closed Beta scenario orchestrator at
> `app/lib/integrations/seven-day-growth.js`. Per BLUEPRINT.md §20 (v1.0 Closed
> Beta) and §14.1 (Growth Model Project Spine). Closed-beta scope is **one**
> 7-day Growth path with the AI Builder theme — the v0.1 极窄路径 the blueprint
> locks. Free-form growth chains return in v1.1.

## Why this scenario exists

The W1-W3 waves shipped a constellation of independent libs: Quality Harness,
Anti-Illusion gate, Misconception Engine, Capture / Finish Ritual, Cadence,
Assignment, Goal Guardian, Repair pipelines, Creation Pool, Product Blueprint,
Transfer, Spark, Companion. Each ships its own contract, its own events. None
of them, individually, is a learner-facing product.

The 7-day spine is the first place where all three waves cooperate to produce
a single user-facing surface: "Day N of 7, AI Builder ladder." The orchestrator
calls W1-W3 libs; it does **not** reimplement any of them. The blueprint is
explicit (DIRECTION lens): the only correct shape is a thin choreographer.

## The seven days (fixed plan)

`SEVEN_DAY_PLAN` is a frozen const exported from
`app/lib/integrations/seven-day-growth.js`. Each entry locks the title, theme,
KP anchor, and the assignment levels and W-lib integrations the day fires.
This list is **not** computed from `deriveLessonTarget` — closed beta only.

| Day | Title                                       | KP anchor             | Levels  | Integrations                                                  |
|----:|---------------------------------------------|-----------------------|---------|---------------------------------------------------------------|
| 1   | AI Builder 入门 · 什么是输入输出            | `io-foundations`      | 1       | quality-harness · anti-illusion-gate                          |
| 2   | Prompt 输入设计                             | `prompt-design`       | 1, 2    | quality-harness · anti-illusion-gate · misconception          |
| 3   | Function call 输出设计                      | `function-call`       | 1, 2    | quality-harness · **product-transfer**                        |
| 4   | 工作流 · 串 / 并 / 分支                     | `workflow-primitives` | 1, 3    | quality-harness · cadence-engine · assignment-cadence         |
| 5   | Memory · 短 / 长 / 向量                     | `memory-tiers`        | 1, 4    | quality-harness · **product-spark** · companion-triggers      |
| 6   | 评估 · 测试 / 调优                          | `evaluation-loop`     | 1, 4    | quality-harness · cadence-engine (Review Day) · judges        |
| 7   | Capstone · 写一个 mini Agent 项目           | `mini-agent-capstone` | 1, 5    | quality-harness · product-spark · finish-ritual · companion   |

Day 3 is the **first** day Product Transfer fires (P ≥ 0.6) — by then the
learner has a concrete function-call contract worth attaching to a product
blueprint section. Day 4 is the **first** day Product Spark suggests a
candidate. Day 6 is a Review Day (cadence-engine drives next_lesson_type).
Day 7 is the integration capstone — Level 5 public_output + companion sprout.

## Integration dependency graph

```
                                  scenario:runDay
                                          │
        ┌───────────────┬─────────────────┼─────────────────┬──────────────┐
        ▼               ▼                 ▼                 ▼              ▼
   quality-harness  cadence-engine  assignment-cadence  product-transfer  companion
   (every day)     (every day)     (every day,         (day 3+)          (every day)
                                    1..3 levels)
                                                       └─→ product-spark (day 4+)
        │
        ▼
   anti-illusion-gate (day 2+)
        │
        ▼
   misconception-engine (day 2 only — surface for repair drill)
```

Every call site is guarded by lazy require + injectable stub
(`opts._libs`) so the integration test harness (`scripts/run-seven-day-growth.js`)
runs end-to-end without a live vault or LLM.

## `validateDayCompletion(dayIdx, results)` rules

Four gates. A day passes when **proof + assignment + evidence_present** are
all true. `capture_opt` always passes (capture is opt-in, not required).

| Gate              | Pass condition                                                 |
|-------------------|----------------------------------------------------------------|
| `proof`           | `evidence.harness.overall_pass === true`                       |
| `assignment`      | `results.assignments.length > 0`                               |
| `evidence_present`| at least one of `evidence.harness` / `evidence.cadence` present|
| `capture_opt`     | always true (capture is optional, opt-in)                      |

`reasons[]` accumulates per-gate failure tags so the UI can show
"missing: proof". `day_completed` / `day_failed` events are then appended to
`vault/<slug>/scenario-events.jsonl` via `recordScenarioEvent` (W2.4-validated
writer). Those rows are the **only** source of truth for `next7DayState`.

## KPI binding (v1.0 closed beta)

Per BLUEPRINT.md §20 the four closed-beta KPI are:

1. **60% finish the 7-day path** — `days_completed === 7` for ≥ 60% of slugs.
2. **40% finish first small artifact** — Day 7 Level-5 public_output produced.
3. **30% willing to pay** — out of band (W4.2 survey writer).
4. **Product Pool feels enhanced + Companion feels supportive** — qualitative.

KPI 1 + 2 are computed by **W4.2 KPI Dashboard** (sibling integration). W4.1
emits the substrate — `scenario-events.jsonl` rows of the 8 documented event
types. W4.2 reads (read-only) and aggregates. W4.1 never writes a KPI row.

## Boundary with W4.2 KPI Dashboard

- W4.1 **owns** `vault/<slug>/scenario-events.jsonl` (writer) and the
  `scenario:*` IPCs.
- W4.2 **reads** `scenario-events.jsonl` for completion-rate / day-fall-off
  / proof-pass-rate aggregations under the `kpi:completion` verb.
- W4.2 does **not** write to `scenario-events.jsonl`. If W4.2 needs a new
  event field, it lands in this spec first, then in `scenario-events.js`
  validator, then W4.2 consumes.

## Relationship to `deriveLessonTarget`

`deriveLessonTarget(agent.js:4764)` computes lesson count from
`{ days × intensity }`. The 7-day spine **bypasses** it — `SEVEN_DAY_PLAN` is
hand-curated and fixed at 7. This is per BLUEPRINT.md §20 v1.0 decision to
ship "one growth path live at a time." When v1.1 opens free-form Growth
chains, `deriveLessonTarget` returns; `seven-day-growth.js` becomes one of
several scenarios under `app/lib/integrations/`.

## Surface scaffolding

- `app/main.js` registers `scenario:dayPlan` / `runDay` / `validate` / `state`
  / `reset` IPC handlers.
- `app/preload.js` exposes `window.ptor.scenario.{dayPlan,runDay,validate,state,reset}`.
- `app/design/screen-scenario-dashboard.jsx` is the dashboard surface — 7
  cards in one column, status hue on the left band, click ACTIVE to enter
  the lesson. No modal. No progress bar percentage. No gamification (per
  manuscript register lock).
- `app/design/app.jsx` adds the `scenario-dashboard` route + a brass-bright
  floating entry button "7-Day · AI Builder" stacked above the existing
  Blueprint / Sparks / KPI column.

## Mock + live modes

- **Scaffold mode** (default in `scripts/run-seven-day-growth.js`): inject
  mock W1-W3 stubs via `opts._libs`. Deterministic; no LLM; no fs writes
  beyond `scenario-events.jsonl`.
- **Live mode**: real W1-W3 libs lazy-required at first call. Real harness
  judges (T4_JUDGE) fire only after the W1.4 calibration pass (see
  `app/lib/quality-harness/runHarness.js`).

## Test coverage

Unit tests live at `__tests__/seven-day-growth.test.js` (placeholder, ≥ 14
`test.todo` entries). Integration smoke runs through
`node scripts/run-seven-day-growth.js --slug=ai-builder --mock --all`. Both
exercise the same `runScenarioDay` codepath; the harness adds markdown
formatting and exit-code reporting for CI.
