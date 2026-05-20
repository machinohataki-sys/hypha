# W4.2 — KPI Dashboard

> Read-only aggregator over existing event streams. Renders the BLUEPRINT §20 v1.0 Closed Beta KPI surface.
> Stream owner: W4.2 (sibling of W4.1 Scenario Engine, sequential to W1-W3 producers).
> Anti-illusion principle: no synthesized numbers; every KPI traces back to an on-disk row.

## 1. KPI Catalogue

Five KPI ship in v1.0, matching the BLUEPRINT §20 Closed Beta gate set:

| # | KPI | Gate | Source |
|---|-----|------|--------|
| 1 | Completion rate (7-day) | ≥ 0.60 | `vault/<slug>/scenario-events.jsonl` (W4.1), fallback proxy via `events.jsonl` |
| 2 | Artifact rate | ≥ 0.40 | `vault/<slug>/events.jsonl` rows `type=assignment:level-decided` with `assignment_level ≥ 3` |
| 3 | Product Pool conversion | qualitative; no fixed gate | `vault/events.jsonl` (root) `op=transfer:fired` + `vault/<slug>/events.jsonl` spark events |
| 4 | Companion satisfaction | qualitative; score ≥ 70 = "在场陪伴 · 不打扰" | `vault/<slug>/companion-fired.json` + slug events.jsonl `companion:*` rows |
| 5 | Payment willingness | ≥ 0.30 affirmative | `vault/<slug>/payment-survey.json` (written by this module) |

The aggregate overall_score is a weighted blend (completion 30% / artifacts 30% / pool 20% / companion 10% / payment 10%) and ranges 0..100.

## 2. KPI Definitions + Formulas

### 2.1 Completion rate

```
days_completed = | distinct day in {0..6} marked complete by W4.1 |
rate           = days_completed / 7
```

A "marked complete" row is any of:

- `{type: 'scenario_day_completed', scenario: 'seven-day-growth', day: N}` (canonical W4.1 shape)
- `{type: 'day_completed', day: N}` (legacy alias)
- `{type: 'scenario_progress', day_index: N}` (alternate W4.1 alias)

When `scenario-events.jsonl` is absent or empty (slug created before W4.1 shipped), the aggregator falls back to a proxy: distinct `lessonIdx` in slug `events.jsonl` whose `assignment:level-decided` row carries `assignment_level ≥ 3` and `lessonIdx < 7`. This matches "a real artifact landed on day N" with the same Level ≥ 3 threshold as the artifact KPI. The proxy is marked `source:'proxy:lesson-level≥3'` in the returned `evidence_chain` so downstream UI can disclose the fallback.

### 2.2 Artifact rate

```
artifacts     = rows where type='assignment:level-decided' AND assignment_level >= 3
total_attempts = ALL rows where type='assignment:level-decided'
rate           = artifacts / total_attempts          (0 when total_attempts == 0)
```

Level 1 `micro_proof` and Level 2 `small_practice` are explicitly excluded from the numerator — they are existence-pings, not artifacts. Level 3 `applied_task` is the floor, matching BLUEPRINT §11.4 "first qualifying transfer". Level 4 `product_spark` and Level 5 `public_output` count identically.

### 2.3 Product Pool conversion funnel

```
lesson_count             = distinct lessonIdx in slug events.jsonl with type='assignment:level-decided'
transfer_triggered_count = root events.jsonl rows where op='transfer:fired' AND topic=slug AND fired=true
spark_seed_count         = slug events.jsonl rows where type='product:spark:created'
spark_accepted_count     = slug events.jsonl rows where type='product:spark:transitioned' AND to='accepted'
spark_implemented_count  = slug events.jsonl rows where type='product:spark:transitioned' AND to='implemented'
rate                     = spark_accepted_count / lesson_count
```

The funnel reads:

1. The user studied N lessons.
2. Of those, M lessons surfaced a transfer prompt (P ≥ 0.6 per W3.3 product-transfer.js).
3. The user planted K seed sparks (W3.4 createSpark).
4. The user accepted J of those (W3.4 transitionState → 'accepted').
5. The user implemented I of those (W3.4 transitionState → 'implemented').

The rate field is `J / N` — the "knowledge → product" conversion. The funnel counts are surfaced unaltered so the UI can render the full ladder rather than a single ratio.

Why root vs slug events for transfer: `app/lib/product-transfer.js:447-459` writes its `transfer:fired` row via vault root `events.jsonl` (not `vault/<slug>/events.jsonl`), with `topic: slug`. We read root and filter — do not migrate the producer.

### 2.4 Companion satisfaction

```
expression_count  = | fires in companion-fired.json |
dismissed_count   = slug events.jsonl rows where type='companion:dismissed'
settings_disabled = companion-fired.json.disabled == true OR slug events.jsonl has type='companion:disabled'

base          = 50
bonus         = min(40, 5 * expression_count)
penalty       = 7.5 * dismissed_count + (settings_disabled ? 50 : 0)
score         = clamp(0, 100, round(base + bonus - penalty))
```

Rationale:

- Base 50 = "no signal yet" — we don't penalize fresh courses.
- Bonus 5 × expression caps at +40 (8 fires = saturation) so a chatty companion can't trade silent dismissal for noise.
- Dismissal weighs 7.5 (1.5×) per fire — explicit rejection is a stronger signal than silent acceptance.
- Disabled = full −50 (back to 0 if no other signal) — the user has spoken.

### 2.5 Payment willingness

Persisted at `vault/<slug>/payment-survey.json`:

```json
{
  "willing": "yes" | "no" | "maybe" | "skipped",
  "last_asked": "ISO 8601",
  "response":   "ISO 8601",
  "free_text":  "<= 500 chars"
}
```

`willing` (return-value) flattens to ternary:

- `'yes'`                       → `true`
- `'no'` / `'skipped'`          → `false`
- `'maybe'` / null / missing    → `null`

The survey is triggered ONCE per slug (UI-side guard: writer overwrites, but UI hides the radio when `raw_willing` is set). The eligibility gate = `completion.rate >= 0.60` (same as completion KPI gate), so the survey card stays inert until the user actually finishes the 7-day path. No nag — `alreadyAnswered = Boolean(initial)` short-circuits the radio render once a value is recorded.

## 3. Aggregate Overall Score

```
paymentSignal = willing == true  ? 1
              : willing == false ? 0
              : 0.5                              // unanswered / maybe → neutral

overall_score = round(
    completion.rate     * 30 +
    artifacts.rate      * 30 +
    min(1, pool.rate)   * 20 +
    (companion.score/100) * 10 +
    paymentSignal       * 10
)
```

Range [0, 100]. The blend weights mirror BLUEPRINT §20 verbatim. Cap `pool.rate` at 1 because it is `accepted / lesson` and can mathematically exceed 1 if the user creates >1 spark per lesson — we surface the raw count but not the inflated rate.

## 4. Data Source Map

| Producer stream | File | Rows consumed |
|---|---|---|
| W2.2 Assignment Cadence | `vault/<slug>/events.jsonl` | `type=assignment:level-decided` (lesson + level + name) |
| W3.3 Product Transfer | `vault/events.jsonl` (root) | `op=transfer:fired` + `topic` + `fired` |
| W3.4 Product Spark | `vault/<slug>/events.jsonl` | `type=product:spark:created` / `type=product:spark:transitioned` |
| W3.5 / W3.6 Companion | `vault/<slug>/companion-fired.json` | `fires[]` length + `disabled` flag |
| W3.5 / W3.6 Companion (extension) | `vault/<slug>/events.jsonl` | `type=companion:dismissed` / `type=companion:disabled` |
| W4.1 Scenario Engine | `vault/<slug>/scenario-events.jsonl` | `type=scenario_day_completed` (canonical) + aliases |
| W4.2 Payment Survey (this module) | `vault/<slug>/payment-survey.json` | full object |

## 5. Boundary With W4.1

W4.1 owns `scenario-events.jsonl`. W4.2 reads it tolerantly:

- Accepts three row shapes (canonical + two aliases) so this module ships before W4.1 locks its final schema.
- Falls back to lesson-level proxy when the file is missing or empty, so the dashboard renders for slugs created before W4.1 shipped.
- Never writes to `scenario-events.jsonl`. The only file W4.2 writes is `payment-survey.json`.

If W4.1 changes the row shape, the canonical-shape branch in `computeCompletionRate` is the single place to update — the aliases are documented as legacy/alternate and can be deprecated together.

## 6. Boundary With W3.1 / W3.4

`computeProductPoolConversion` reads ONLY events.jsonl rows — it does NOT call `creation-pool.getProduct(slug)` or `product-spark.listSparks(slug)`. Rationale:

- Events are the immutable audit trail. State files (`product/sparks/*.md` frontmatter) can be hand-edited; events cannot.
- W4.2 must compose deterministically over the same evidence Closed Beta researchers will audit.
- Future cross-slug aggregation (e.g. cohort-wide KPI) can union event streams without reading each slug's full product tree.

The funnel counts may diverge by ±1 from the live state if the user deleted a spark file outside the app, etc. — this is acceptable for KPI evidence purposes; the event trail wins.

## 7. IPC Surface

All seven verbs return the standard hypha envelope: `{ ok: true, ... }` on success or `{ ok: false, error }` on failure. Slug validation throws inside the lib; the IPC wrapper catches and returns the envelope.

```js
window.ptor.kpi.completion(slug, scenarioName?)
window.ptor.kpi.artifacts(slug)
window.ptor.kpi.productPool(slug)
window.ptor.kpi.companion(slug)
window.ptor.kpi.payment(slug)
window.ptor.kpi.aggregate(slug)
window.ptor.kpi.surveyPayment(slug, willing, freeText)
```

`aggregate` is the only verb the UI calls in v1.0. The other six are exposed for individual sparkline drills + future cohort tooling.

## 8. UI Register

The dashboard follows the 千金 manuscript register hardcoded across PTOR / Hypha:

- Garamond italic for KPI headlines and the overall score
- JetBrains Mono only for eyebrows + small ratio captions
- No gauges. No progress bars. No traffic-light colors.
- Gates are inline ("0.43 · gate 0.60") not visual fills.
- The 7-day completion card uses 7 monochrome chips, filled or unfilled — minimal signal, no celebration.
- The Companion card surfaces three flat counters, not a sentiment bar.
- The Payment survey hides until the 7-day path closes. After a single answer, the radio is locked.

Anti-pattern guard (per BLUEPRINT manuscript register):

- No emoji
- No exclamation marks
- No "Great job!" copy
- No percentage badges that read as gamification

## 9. Test Surface

`app/__tests__/kpi-dashboard.test.js` ships `test.todo()` placeholders for ≥ 12 cases (completion fallback, artifact threshold, transfer/spark funnel, companion score formula, payment survey shape, aggregate weights). Concrete bodies arrive with the jest harness wave; the surface contract is locked now.
