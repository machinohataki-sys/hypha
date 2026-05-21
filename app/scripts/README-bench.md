# learnlm-bench — Hypha Learn vs Classic A-vs-A harness

The empirical falsifier for Hypha Learn. Pure Node script, no Electron deps.

## Run

```bash
node app/scripts/learnlm-bench.js --corpus ./bench-corpus --out ./bench-report.json
```

## Corpus directory layout

```
bench-corpus/
  classic/
    lesson-01/transcript.json    # Hypha Classic lesson on archetype A
    lesson-02/transcript.json    # archetype B
    lesson-03/transcript.json    # archetype C
    lesson-04/transcript.json    # archetype A (replicate)
    lesson-05/transcript.json    # archetype B (replicate)
  learn/
    lesson-01/transcript.json    # Hypha Learn lesson on the SAME topic as classic/lesson-01
    lesson-02/transcript.json    # paired by lesson-NN suffix
    ...
  ratings/                       # populated by human raters after they grade
    panel-1.csv
    panel-2.csv
```

`transcript.json` schema:

```json
{
  "topic": "Polish noun cases — instrumental",
  "archetype": "language-learner",
  "learn_goal": "Recognize narzędnik in 5 sentences",
  "turns": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ]
}
```

## Recording 5 Classic baseline lessons

The Classic baseline is captured from `<vault>/.hypha/chain-events.jsonl`. For each
representative lesson, copy the user/assistant content into a new
`bench-corpus/classic/lesson-NN/transcript.json`. Pick lessons across 3 archetypes
(language-learner / domain-novice / concept-deepening) so the panel covers the
intended user range.

## Rating CSV format

Each panel CSV has the header `lesson_id,rater_id,axis,score`:

```csv
lesson_id,rater_id,axis,score
classic/lesson-01,r1,curiosity,2
classic/lesson-01,r1,metacognition,2
classic/lesson-01,r1,active_learning,3
learn/lesson-01,r1,curiosity,4
learn/lesson-01,r1,metacognition,3
learn/lesson-01,r1,active_learning,4
```

- `lesson_id` = `<branch>/lesson-NN` (must match folder layout)
- `axis` = `curiosity` | `metacognition` | `active_learning`
- `score` = integer 1..5 (Likert)
- 3 raters × 2 panels = n=6 observations per (lesson,axis)

## Pass/fail interpretation

The harness emits `pass_criterion` with:

- `likert_rise_>=1pt` — every axis mean rises ≥1 Likert point Learn over Classic
- `density_rise_>=15pct` — corpus mean vivid-density rises ≥15% Learn over Classic
- `ge_8_of_10_lessons_passing` — at least 8/10 paired lessons satisfy both per-lesson density (≥15%) and Likert (mean axis delta ≥1pt) when ratings exist; density-only when ratings missing
- `OVERALL` — all three above

`PASS` ⇒ Hypha Learn design ships. `FAIL` ⇒ revise pedagogy spec, do not promote.

## Without ratings

If `ratings/` is missing the script still runs and emits density-only metrics
plus a stderr warning. Use this in development to track density-axis drift while
the human rating phase is still being scheduled.
