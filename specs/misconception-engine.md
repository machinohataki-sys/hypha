# Misconception Engine — W1.4 v0 spec

> Theory ship for the Misconception Engine. Surface the 11-field lesson body's
> existing `common_misconceptions[]` field as classified, detectable,
> repairable artifacts. Cross-lesson reuse is the compounding edge.

## Why this exists

Per BLUEPRINT.md §7.4: "Every knowledge point records common misconceptions,
wrong analogies, surface understandings, dangerous simplifications, pseudo-
understanding signals. The lesson must actively pre-empt errors."

Today the v0.2 lesson body generator (`app/lib/lesson-body-generator.js`)
produces `common_misconceptions: string[2]` per lesson — two LLM-authored
wrong-priors plus their sharp correction, 10-200 chars each. The strings are
surfaced into the LESSON BRIEF block (`agent.js:_buildLessonBriefBlock`) so
the tutor can mention them, but there is no:

1. Classification (what kind of wrong-prior — analogy / surface / etc.)
2. Detection (does the user's current reply walk into a known one)
3. Repair flow (what should the tutor do on the next turn)
4. Cross-lesson reuse (Lesson 5 of slug-A learned a misconception; slug-B
   covering the same subject should pre-load it)

W1.4 v0 fills (1)-(4) as a theory ship: real classification heuristic, real
detection pre-screen, real cross-lesson vault read, and T4_JUDGE
second-pass left as an intentional placeholder for W1.4-followup.

## Four categories (per blueprint)

| Category                  | Marker                                             | Repair hint                                |
|---------------------------|----------------------------------------------------|--------------------------------------------|
| `wrong_analogy`           | Maps concept to structurally incorrect domain      | Push analogy until it breaks               |
| `surface_understanding`   | Knows definition, not mechanism                    | Predict what removing a nuance does        |
| `dangerous_simplification`| Strips load-bearing nuance, works in toy case      | Present concrete breaking case             |
| `pseudo_understanding`    | Performs fluency, fails on transfer (Feynman test) | Fresh-case application                     |

Examples (from real lesson bodies in vault):
- **wrong_analogy**: "Attention is like a spotlight focusing on one word."
  Correction: it is a weighted sum over all positions; the "spotlight" image
  hides the parallel readout.
- **surface_understanding**: "Recursion is a function that calls itself."
  Correction: the base case + the inductive step are the load-bearing parts;
  self-reference alone is decoration.
- **dangerous_simplification**: "Just use UTF-8 for everything."
  Correction: UTF-8 is variable-width; substring/length operations need
  codepoint or grapheme awareness depending on use.
- **pseudo_understanding**: User says "I get it" after a clean explanation.
  Correction: ask them to apply X to fresh case Y; fluency does not transfer.

## Severity ladder

`low / medium / high / critical`. Critical = the wrong-prior is load-bearing
for the lesson thesis; the tutor must repair it before moving on. Low = a
side-channel error worth flagging in passing. Severity is heuristic today
(text length + correction-strength regex); the W1.3 Anti-Illusion path uses
severity to budget intervention frequency (critical hits interrupt the
current state; lows append a margin note).

## cue_phrases editing rules

Each misconception carries 1-4 `cue_phrases` — short n-gram fragments that,
if the user utters them, signal they are stepping into the trap. Today:
derived heuristically from the misconception text by splitting on
punctuation and taking the wrong-belief clause (first 1-2 clauses per
`lesson-body-generator.js:87` "ends with the sharp correction" contract).

Editing rules for a future hand-authored cue bank:
- 3-30 chars each; longer phrases over-fit
- Lowercase; the detector lowercases userResponse on its side
- Avoid generic verbs ("is", "means") — they pre-screen-match everything
- Prefer the *user's likely framing* over the textbook framing
- Multi-language OK; CN + EN cues in the same array are fine

## Repair strategy template (per category)

Each category has a fixed prompt template embedded in
`misconception-engine.js:_REPAIR_TEMPLATES`. The template is one paragraph
that the tutor reads on the next turn, telling it:
- which category fired
- the structural shape of the correction (not the answer itself)
- when to anchor on `canonical_example` vs `exit_proof`
- the expected_user_action (`text_explain` for analog/surface/simplification;
  `choose_among_3` for pseudo_understanding so the user has to commit)

The template is data, not magic — overrideable per-lesson by writing
`repair_strategy` directly on the misconception record before persistence.

## Cross-lesson vault read flow

```
crossLessonMisconceptionsForTopic(topic)
  ├─ scan every <slug>/ directory under vault root
  ├─ for each slug, check if the slug name OR state.json's
  │  {topic, title, lessonPlan[*].title} overlap with the requested topic
  │  via the _slugMatchesTopic token-overlap heuristic
  ├─ for matching slugs, walk <slug>/lesson-N/misconceptions/kp-*.json
  │  sidecars (skip non-conforming names)
  └─ return flat array, capped at MAX_CROSS_LESSON_RECORDS = 12
```

The cap is intentional — `agent.js:_buildLessonBriefBlock` injects this into
the tutor's prompt, and the token budget is shared with thesis +
canonical_example + KP list. Per CLAUDE.md surgical rule, 6 dedup'd entries
go to the prompt (after `dedupeMisconceptions` merges by lowercase text
prefix with severity priority).

## Relationship to W1.3 Anti-Illusion

W1.3 (Anti-Illusion / ai_mimicry) detects sycophantic AI output and triggers
interventions. One of its intervention types is `misconception_repair` —
when fired, it calls into the W1.4 stream:

```
W1.3 detects misconception_repair-class signal
  → bridge.misconception.detect(userMsg, kpMisconceptions)
  → if triggered, bridge.misconception.repair(triggered, ctx)
  → repair_prompt is appended to the next tutor turn's system prompt
```

W1.3 keeps the budget (max N interventions per session); W1.4 supplies the
detect + repair primitives.

## Relationship to lesson-body-generator

W1.4 does NOT mutate the 11-field schema. The flow is:
1. `lesson-body-generator.js` writes `body.common_misconceptions: string[2]`
   into `vault/<slug>/lesson-N.body.json` (existing pre-v0.2 behavior).
2. `misconception-engine.extractMisconceptions(body, kpId)` reads those
   strings and returns classified records (category / severity /
   cue_phrases / repair_strategy).
3. `misconception-vault.writeMisconception(slug, idx, kpId, records)` writes
   the classified records to a sidecar:
   `vault/<slug>/lesson-<idx>/misconceptions/kp-<id>.json`
4. `crossLessonMisconceptionsForTopic(topic)` reads those sidecars to
   pre-load wrong-priors learned in prior courses.

The sidecar pattern is deliberate — future schema migrations of the 11-field
body do not have to carry W1.4 data, and the cross-lesson reader does not
have to parse full body.json files (it reads tiny per-KP sidecars instead).

## Surfaces

- **Agent prompt** — `agent.js:_buildLessonBriefBlock` appends a
  `MISCONCEPTIONS TO PRE-EMPT (4 categories)` block to the LESSON BRIEF.
  Cross-lesson hits are tagged `[cross-lesson: <source-slug>]` so the tutor
  knows the wrong-prior came from a different course on the same subject.
- **UI callout** — `screen-lesson-chat.jsx` listens for `detect`-positive
  results after each user message and renders an editorial-register callout
  beneath the tutor's reply. The callout text is intentionally calm
  ("似乎踩在了一个常见的歧路上") — no alarm coloring, no urgency.
- **IPC** — `misconception:list / detect / repair` exposed via
  `window.ptor.hypha.misconception.{list, detect, repair}`.

## Deferred (intentional-placeholder)

- T4_JUDGE second-pass classifier. The heuristic returns a real,
  deterministic category today; W1.4-followup wraps the top hit with a
  model-grounded confirmation to discard false-positives (cue mentioned vs
  wrong-prior actually invoked). Routing target: `T4_JUDGE` capability
  class via `router.executeChat` per AMD-MEOW-P4.
- Automatic write of classified records into the sidecar when a lesson body
  is generated. Today the renderer constructs the bank on the fly when the
  detect hook fires; the auto-write path lives in W1.4-followup.
- Per-KP cue_phrase override UI. Hand-authored cues live in the sidecar
  schema, but no UI writes them today.

## File map

| Path                                              | Role                                |
|---------------------------------------------------|-------------------------------------|
| `app/lib/misconception-engine.js`                 | Classify / detect / repair         |
| `app/lib/misconception-vault.js`                  | Sidecar persistence + cross-read    |
| `app/agent.js:_buildLessonBriefBlock`             | Prompt injection                    |
| `app/main.js` (3 IPC handlers)                    | Renderer ↔ engine bridge            |
| `app/preload.js` (`window.ptor.hypha.misconception`) | UI bridge                        |
| `app/design/screen-lesson-chat.jsx`               | Callout + detect-on-submit hook     |
| `__tests__/misconception.test.js`                 | Test scaffolds (test.todo)          |
