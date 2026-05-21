# Spec — W1.2 Micro-Judges (drift / generic / jargon)

Status: scaffold shipped 2026-05-13. T4_JUDGE LLM call paths intentional-placeholder until W1.4 calibration wave locks prompt templates against golden + failure sample corpora.

## 1. Scope

3 micro-judges that grade a single `lessonBody` (v0.2 11-field schema from `app/lib/lesson-body-generator.js`) and feed the W1.1 9-dim quality-harness:

| W1.2 micro-judge | W1.1 dim it feeds | Capability class |
|---|---|---|
| `goal-drift-judge`   | `goal-coherence` (dim 1/9) | T4_JUDGE |
| `anti-generic-judge` | `not-generic-course` (dim 8/9) | T4_JUDGE |
| `jargon-judge`       | `jargon-control` (dim 2/9) | T4_JUDGE |

W1.1 wraps each W1.2 judge in the matching dim file under `app/lib/quality-harness/judges/*.js` and surfaces aggregated score + verdict. **No duplicate scoring logic**: W1.1 dim files contain only an adapter shim that calls into the W1.2 judge and forwards `{score, evidence, pass}`.

## 2. Input / Output Schema

### 2.1 `gradeDrift({ lessonBody, goalContract, prevLessons })`

```
input:
  lessonBody:    object  (v0.2 11-field body)
  goalContract:  { core_competencies: string[], forbidden_drifts: string[],
                   main_creation: string, north_star_goal: string }
  prevLessons:   object[]  (most-recent 3 lesson bodies, newest last)

output:
  score:             number     0-100 (high = on-goal, low = drifted)
  drift_direction:   string|null  (e.g. "trended to adjacent concept X")
  evidence:          string[]   1-6 短句证据
  drifted_passages:  Array<{ offset: number, snippet: string }>
```

### 2.2 `gradeGeneric({ lessonBody, topic })`

```
input:
  lessonBody:  object
  topic:       string

output:
  score:                  number     0-100 (high = unlike 普通网课)
  generic_phrases_found:  string[]   pre-screen 命中 (opener:X / closer:Y / filler:Z)
  evidence:               string[]   1-6 短句
  how_to_fix:             string     1 句补救建议
```

### 2.3 `gradeJargon({ lessonBody, audience_level })`

```
input:
  lessonBody:      object
  audience_level:  '零基础' | '中级' | '进阶'   (default '中级')

output:
  score:                  number       0-100 (high = audience-friendly)
  jargon_density:         number       forbidden hits / total words (0-1)
  forbidden_words_found:  string[]     hypha-constitution FORBIDDEN list 命中
  unexplained_terms:      string[]     T4_JUDGE 标的术语 (mock = [] until W1.4)
```

### 2.4 `gradeAllThree(lessonBody, context)`

Runs the trio in parallel (Promise.all), aggregates verdict:

```
output:
  drift:        <gradeDrift output>
  generic:      <gradeGeneric output>
  jargon:       <gradeJargon output>
  overall_pass: boolean   (no judge in FAIL band)
  weakest:      'drift' | 'generic' | 'jargon'  (lowest score)
```

Side-effect: appends one row to `<vault>/<slug>/events.jsonl` if `context.slug` is set.

## 3. Thresholds

| Judge | FAIL | WARN | PASS |
|---|---|---|---|
| drift   | < 35 | 35–60 | ≥ 60 |
| generic | < 30 | 30–55 | ≥ 55 |
| jargon  | < 25 | 25–50 | ≥ 50 |

Constants exported from each module: `DRIFT_FAIL` / `DRIFT_WARN` (`goal-drift-judge.js`), `GENERIC_FAIL` / `GENERIC_WARN` (`anti-generic-judge.js`), `JARGON_FAIL` / `JARGON_WARN` (`jargon-judge.js`).

Verdict bands are tunable; W1.4 calibration wave decides final thresholds once pass-rate on 8/10 golden samples is measured.

## 4. events.jsonl row schema

Appended by `gradeAllThree` to `vault/<slug>/events.jsonl`:

```
{
  ts:              ISO string,
  type:            'judges:graded',
  idx:             number | null,    // lesson index
  drift_score:     number,
  generic_score:   number,
  jargon_density:  number,
  jargon_score:    number,
  weakest:         'drift' | 'generic' | 'jargon',
  overall_pass:    boolean
}
```

Append failure is non-fatal — judges always return their result even if vault write throws (so unit tests without a vault still resolve).

## 5. T4_JUDGE prompt templates (W1.4 placeholder)

All three judges share the same dispatch:

```
const { executeChat } = require('../llm');
const dispatch = await executeChat('T4_JUDGE', {
  messages: [{ role: 'system', content: HYPHA_SHORT_CONSTITUTION },
             { role: 'user',   content: judgeSpecificPrompt }],
  json: true,
  temperature: 0,
  maxTokens: 600,
});
```

DispatchPolicy 60/30/10 across GLM-4.5-Air / DeepSeek-V4-Flash / Kimi-K2.6 (per `app/lib/llm/router.js` DISPATCH_POLICY.T4_JUDGE). ProviderHealth excludes degraded providers from the weighted pool.

Per-judge prompt sketch (real templates land in W1.4 calibration):

- **drift**: "Given `core_competencies` + `main_creation`, score 0-100 how well `thesis` + `canonical_example` + `mechanism_explanation` trace back to the goal. List off-goal evidence. Return JSON `{score, drift_direction, evidence[]}`."
- **generic**: "Score 0-100 how *unlike* 普通 AI 课 / 普通网课 this reads. Look for Wikipedia定义堆叠 / 无主线 / 平均叙事 / 套话. Return JSON `{score, evidence[], how_to_fix}`."
- **jargon**: "audience_level = X. Score 0-100 how audience-friendly. List `unexplained_terms` (jargon used without nearby USE / 应用 / 定义). Return JSON `{score, unexplained_terms[]}`."

## 6. Cheap pre-screen behavior (live in W1.2 ship)

The regex / substring layers below are **active right now** (not mocked):

- **drift**: forbidden_drifts substring scan (each hit −15 score) + Jaccard ≥ 0.7 cross-lesson overlap against prev 3 (−20 score).
- **generic**: scan `GENERIC_OPENERS` / `GENERIC_CLOSERS` / `SCHOLAR_FILLER` lists + `TRANSITION_TRIPLE_RE` (首先...其次...最后). Each hit subtracts from base; ≥ 4 distinct hits forces FAIL band.
- **jargon**: word-boundary scan of `hypha-constitution.js` FORBIDDEN list (read via `jargon-firewall.BANNED_EN`). Each hit −10 score; density-over-ceiling triggers linear overshoot penalty.

## 7. UI surface

`app/design/screen-lesson-chat.jsx` adds a `JudgeBadges` component (3 small chips: drift / generic / jargon) in PageFrame top band, beside HealthBadge.

- States: `—` grey before data, green ≥ PASS, amber ≥ WARN, red ≥ FAIL.
- Effect calls `window.ptor.judge.all(lessonBody, ctx)` once per `(slug, lessonIdx, lessonBody)` change.
- Non-blocking: lesson chat continues regardless of judge result.

## 8. IPC contract

| Channel | Args | Returns |
|---|---|---|
| `lesson:judge:drift`   | `{ lessonBody, goalContract, prevLessons }` | `{ ok, result }` or `{ ok:false, error }` |
| `lesson:judge:generic` | `{ lessonBody, topic }` | `{ ok, result }` |
| `lesson:judge:jargon`  | `{ lessonBody, audience_level }` | `{ ok, result }` |
| `lesson:judge:all`     | `{ lessonBody, context }` | `{ ok, result }` |

All handlers swallow exceptions into `{ ok:false, error }` envelope — never throw across IPC.

## 9. Relation to W1.1 Quality Harness

W1.1 (`app/lib/quality-harness/runHarness.js`) is the 9-dim aggregate grader running over N regenerations to compute pass-rate. W1.2 (this spec) is the per-dim micro-judge layer that W1.1 calls into.

Reuse map:

- `quality-harness/judges/goal-coherence.js` → wraps W1.2 `gradeDrift` (adapter forwards `{dim:'goalCoherence', score, evidence, pass: score >= PASS_THRESHOLD}`)
- `quality-harness/judges/not-generic-course.js` → wraps W1.2 `gradeGeneric`
- `quality-harness/judges/jargon-control.js` → wraps W1.2 `gradeJargon`

The other 6 dims (level-match / misconception-defense / evidence-of-learning / action-conversion / product-transfer-quality / hypha-soul) are W1.1's own concern and stay outside this spec.

## 10. Out of scope (deferred)

- Real T4_JUDGE prompt templates + JSON-parsing of LLM output (W1.4 calibration).
- `unexplained_terms` extraction in jargon judge (needs T4_JUDGE Stage 2).
- `drift_direction` synthesis in goal-drift judge (needs T4_JUDGE Stage 2).
- Anti-generic `score` semantic layer (current score is regex-derived only when LLM mock returns 50).
- Regression / pass-rate measurement against `app/lib/quality-harness/failure-samples/` corpus (W1.4).

## 11. Surprise

The codebase already had three "pre-judges" with overlapping intent: `goal-drift-detector.js` (algorithmic 4-axis), `anti-generic-detector.js` (algorithmic 7-axis), `jargon-firewall.js` (v0 monitoring scanner). Rather than collapse them, W1.2 adds a thin LLM-augmented layer above them — the algorithmic detectors stay as cheap fallback / cross-check inputs, while W1.2 surfaces a single composable `{score, evidence, how_to_fix}` shape that the W1.1 9-dim harness consumes uniformly. The duplication is intentional separation between v0.2 algorithmic floors (always-on, deterministic) and v0.3+ semantic judges (LLM-graded, expensive). When W1.4 calibration arrives, the deterministic detectors become input features to the T4_JUDGE prompt rather than competing scorers.
