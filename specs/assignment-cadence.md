# Assignment Cadence Function — Spec

> Wave 2.2 of v0.5 Hypha. Code: `app/lib/assignment-cadence.js`.
>
> Source-of-truth blueprint: `BLUEPRINT.md` §8.2 Assignment Cadence Function.

## Why this exists

The deprecated v0.1 `computeAssignmentLevel` always returned Level 1. Useful as
a freeze for the R11 PRODUCTION SCAFFOLD ship, but it conflated _every lesson
must produce a tiny proof_ (true) with _every lesson outputs the same kind of
artifact_ (false). Wave 2.2 introduces the real cadence: most lessons stay at
Level 1, occasional lessons escalate to small practice / applied task / product
spark / public output based on 8 observable signals.

## 8 inputs

| Param | Type | Meaning |
|---|---|---|
| `D` | int ≥ 0 | Current day index in the curriculum (0-indexed). |
| `S` | float 0-100 | Learning score, last-3-lessons average. |
| `C` | float 0-1 | Confusion level for the current lesson. |
| `M` | float 0-1 | Milestone progress in the active chain. |
| `R` | int ≥ 0 | Review nodes due now. |
| `G` | enum | `Exam` \| `Growth` \| `Hybrid` goal type. |
| `T` | int \| null | Days to deadline. `null` = no deadline. |
| `P` | float 0-1 | Product Pool relevance (W3 wires real; v0.5 mock 0.5). |

Plus two state-carry inputs:

- `currentLevel` (1-5, default 1) — last-emitted level; used for milestone level-up.
- `prevM` (0-1 or null) — previous-call milestone reading; used for crossing detection.
- `lessonIdx` (int) — current lesson index for product-relevance gate; falls back to `D`.

## 5 Levels

| Level | name | Time | Format | Prompt seed |
|---|---|---|---|---|
| 1 | `micro_proof` | 30 s | one-line text | "用一句话, 用你自己的话, 解释 \<topic\> 的核心." |
| 2 | `small_practice` | 10 min | 3 bullets | "举 3 个与课程例子不同的例子, 每个 1 句." |
| 3 | `applied_task` | 30 min | 200-char paragraph | "把 \<topic\> 应用到你认识的某个场景, 写 200 字." |
| 4 | `product_spark` | 1-2 h | 300-char spark | "结合本课与你的 Product Pool, 写 1 个 Product Spark 候选." |
| 5 | `public_output` | hours | ≥600-char longform | "draft 1 篇 ≥ 600 字博客 / Commons Pack 草稿, 准备发布." |

## Decision rules (priority order)

The first matching rule wins level assignment. Multiple `trigger_reasons` can
co-occur but only the first determines level.

1. **`low_score_recovery`** — `S < 40` OR `C > 0.7` → Level 1.
   Floor: never escalate when the user is confused or scoring poorly. Fix
   first, push later.
2. **`exam_final`** — `G='Exam'` AND `T ≤ 1` → Level 1.
   Last-day compression: tiny proofs that surface remaining gaps, no new
   creation load.
3. **`review_due`** — `R ≥ 3` → Level 2.
   Three or more review nodes is enough debt to redirect the assignment to
   small-practice review form.
4. **`exam_compress`** — `G='Exam'` AND `T ≤ 7` → Level 3.
   Within a week of an exam, applied-task practice (mock-test density) is the
   right register.
5. **`monthly_public`** — `D % 21 = 0` AND `D > 0` → Level 5.
   Every 3 weeks the system asks for a public-grade artifact, regardless of
   goal type. Hypha's social-sandbox engine depends on this rhythm.
6. **`weekly_integration`** — `D % 7 = 0` AND `D > 0` AND `G='Growth'` → Level 4.
   Growth-track weekly product spark cadence. `Exam` and `Hybrid` skip this
   to avoid splitting attention away from the deadline.
7. **`high_relevance`** — `P > 0.6` AND `lessonIdx ≥ 5` → Level 4.
   When the Product Pool has high relevance to this lesson AND we're past the
   foundational stretch, surface a Product Spark prompt.
8. **`milestone_crossed`** — `M` just crossed 0.25 / 0.5 / 0.75 → `currentLevel + 1` (cap 5).
   Stage-gate escalation. Driven by `prevM` if available; falls back to
   `M` matching a checkpoint within `±0.001` if `prevM` is null (bootstrap).
9. **`default_micro_proof`** — fallback → Level 1.
   Every lesson has a proof. Level 1 is the floor.

## events.jsonl row schema

Two row types written via `app/lib/events.js`:

```jsonc
// Decision recorded on every compute call (when slug supplied).
{
  "ts": "2026-05-13T09:31:42.110Z",
  "lifecycle": "draft",
  "verification_channel": "none",
  "type": "assignment:level-decided",
  "level": 4,
  "level_name": "product_spark",
  "trigger_reasons": ["weekly_integration"],
  "D": 7, "S": 75, "C": 0.2, "M": 0.25,
  "R": 0, "G": "Growth", "T": null, "P": 0.5,
  "currentLevel": 1
}

// Emitted when level differs from prevLevel.
{
  "ts": "2026-05-13T09:31:42.111Z",
  "type": "assignment:level-up",
  "from": 1,
  "to": 4,
  "reason": "weekly_integration"
}
```

## Relation to neighboring streams

- **W2.1 Lesson Cadence** — shares the same `cadence-state.json` (read-only).
  Lesson cadence governs `Generate → Learn → ExplainBack → ActionProof → ...`
  state machine; assignment cadence governs the artifact kind asked of the
  student at end-of-lesson. Different axes.
- **W1.3 Anti-Illusion** — when W1.3 fires a `micro_task` repair, the task is
  always Level 1 (W1.3 emits directly; it does not route through this engine).
- **R11 PRODUCTION SCAFFOLD** — Level 1 IS the PRODUCTION SCAFFOLD entrypoint
  (intent-aware slot template). Already shipped Phase B 改动 5. Levels 2-5 are
  supplementary tasks emitted alongside, not replacements.
- **W3.3 Product Transfer** — Level 4 trigger shares the `P > 0.6` threshold
  with Product Transfer detection. When W3.3 lands, both consult the same
  signal so the user does not see two parallel "spark now?" prompts.
- **Grader** — `gradeAssignment()` routes Level 4/5 with `intent`+`slotTemplate`
  to `production-scaffold.gradeDraft` (Phase C); Level 1-3 use a length-based
  mock heuristic in v0.5 (real LLM grading lands W3.x).

## Verification cases

```js
const ac = require('./app/lib/assignment-cadence');
ac.computeAssignmentLevel({D:7,S:75,C:0.2,M:0.25,R:0,G:'Growth',T:null,P:0.5,currentLevel:1});
// → Level 4 (weekly_integration fires before milestone — same outcome)
ac.computeAssignmentLevel({D:1,S:30,C:0.2,M:0,R:0,G:'Growth',T:null,P:0.5,currentLevel:1});
// → Level 1 (low_score_recovery)
ac.computeAssignmentLevel({D:21,S:75,C:0.2,M:0,R:0,G:'Growth',T:null,P:0.5,currentLevel:1});
// → Level 5 (monthly_public)
ac.computeAssignmentLevel({D:5,S:75,C:0.2,M:0,R:0,G:'Exam',T:1,P:0.5,currentLevel:1});
// → Level 1 (exam_final)
ac.computeAssignmentLevel({D:8,S:75,C:0.2,M:0.5,R:0,G:'Growth',T:null,P:0.4,currentLevel:2});
// → Level 3 (milestone_crossed: currentLevel+1)
```

## IPC surface

Main process registers three handlers in `app/main.js`:

- `assignment:compute` → `computeAssignmentLevel(args)` + side-effect events.jsonl write when `args.slug` is present.
- `assignment:template` → `selectLevelTemplate(level, opts)`.
- `assignment:grade` → `gradeAssignment({ level, draft, context })`, injects `production-scaffold.gradeDraft` for Level 4/5.

Renderer bridge in `app/preload.js` exposes them as `window.hypha.assignment.{compute, template, grade}`.

## Out of scope for v0.5

- Live `cadence-state.json` integration — handled by W2.1 stream; this module
  remains a pure function consuming caller-supplied inputs until W2.4.
- LLM-based 3-dim grading for Levels 1-3 — deferred to W3.x judges.
- UI panel for trigger-reason audit — placeholder `<AssignmentBadge>` only.
- Adaptive thresholds per user (e.g. tighter `LOW_SCORE_THRESHOLD` for
  high-confidence users) — deferred to v0.6 Mastery Map integration.
