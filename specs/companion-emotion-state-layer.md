# Companion Emotion-State Layer (v0.1.1 additive seed)

> Status: ADDITIVE seed. Pure library + smoke + this spec. NOT wired into IPC,
> UI, or W3.5 tone-engine. Composability is documented but deferred to v0.5.1+.

## Why a separate layer

W3.5 Companion (shipped 2026-05-13~14 under `app/lib/companion/`) is
**event-driven**. The 6-trigger schema in `tone-engine.js`
(`lesson_complete` / `interrupt_resume` / `over_grind` / `finish_capture` /
`product_spark_sprout` / `note_revival`) answers a single question:

> "When event X fires, what tone should Myco use?"

This emotion-state layer is **rolling-state-driven**. It answers a different
question:

> "Right now, what does the user feel — and how should that bias any tone
> selection that happens to fire in this window?"

The two axes are orthogonal:

|                     | W3.5 trigger schema           | Emotion-state layer            |
|---------------------|--------------------------------|---------------------------------|
| Cadence             | Discrete event fires           | Continuous classification      |
| Input               | Lesson lifecycle event name    | User text + question history   |
| Output              | Tone expression string         | State enum + signal + confidence |
| State preserved?    | Per-event one-shot             | Rolling window across turns    |
| File                | `tone-engine.js`               | `emotion-state.js`             |

Adding emotion-state hooks into W3.5 would entangle the trigger registry with
session-rolling classifier state — premature coupling. This layer ships as a
pure classifier first; coupling is a separate slice.

## 5 emotion states

| State              | Detection signal                                                      | Confidence | Vocabulary tone hint                   |
|--------------------|------------------------------------------------------------------------|------------|-----------------------------------------|
| `idle`             | Default — no other signal matched                                     | 0.5        | (留白)                                  |
| `curious`          | New concept mentioned without definition (`听说过`, `first time`)      | 0.6        | "哦, 这个我没见过."                     |
| `encouraging`      | Stuck / frustrated signal (`卡住`, `不懂`, `stuck`, `confused`)        | 0.8        | "卡住是正常的, 退一步试试."             |
| `mirror`           | Hypothesis statement (`我认为`, `我觉得`, `i think`, `i believe`)      | 0.7        | "你刚说的是 [user_text]. 接近吗?"        |
| `boundary-protect` | (a) Delegate request OR (b) ≥5 same-type questions in recent window  | 0.9 / 0.75 | "继续问会变依赖. 找人讲一次回来."         |

## Detection priority

The classifier walks signals in fixed priority. First match wins:

1. `DELEGATE_REQUEST` — explicit "do this for me" pattern → `boundary-protect`
2. `REPEATED_QUESTION_TYPE` — ≥5 same-type questions in last 10 → `boundary-protect`
3. `HYPOTHESIS_STATEMENT` → `mirror`
4. `STUCK_SIGNAL` → `encouraging`
5. `NEW_CONCEPT` → `curious`
6. else → `idle`

Rationale: protective signals (delegate / over-reliance) outrank reflective
signals (hypothesis / stuck / curious). Confidence values are advisory — the
classifier is a heuristic, not a model.

## How this could compose with W3.5 later

A future tone-engine variant could accept an emotion-state hint:

```js
// Hypothetical v0.5.1+ coupling, NOT shipped:
const emotion = detectEmotionState({ currentText, recentQuestions });
const expression = generateExpression(trigger, { emotionBias: emotion.state });
```

The W3.5 contract continues to drive the event vocabulary. Emotion-state would
nudge tone register — e.g. when `lesson_complete` fires while emotion is
`boundary-protect`, the tone-engine could skip the celebratory line and
substitute a "talk to a person" prompt; when emotion is `encouraging`, it could
soften the close.

Concretely, the wiring belongs in `tone-engine.js`. It is **not** in this
slice because:

1. The two layers' lifecycles differ — emotion-state needs a per-session
   running buffer of recent user messages; W3.5 is fire-and-forget per event.
2. Coupling now would force a session-state owner decision before either
   layer has surfaced usage data. Better to land emotion-state as a pure
   library first.

## What this slice ships

- `app/lib/companion/emotion-state.js` — pure classifier + vocabulary lookup.
- `app/scripts/_dev_verify_emotion_state.js` — 8-test smoke.
- `specs/companion-emotion-state-layer.md` — this file.

## What this slice does NOT ship

- No IPC handler.
- No UI surface (Trust Panel row deferred).
- No change to `index.js` / `tone-engine.js` / `boundary-guard.js` / `contract.yaml` / `keyword-mapping.js`.
- No change to `specs/companion-myco.md`.
- No coupling to W3.5 trigger registry.

## Open questions (defer)

- **Session buffer owner.** When emotion-state is consumed by a live caller,
  who owns the rolling buffer of `recentQuestions` and `sessionTurnCount`?
  Candidates: main.js per-tab session map; `companion/index.js` extended;
  a new `companion/session-buffer.js`. Decide when the first consumer lands.
- **Cooldown / hysteresis.** Repeated `boundary-protect` classifications in
  a single session should likely de-escalate over time so Myco does not
  hammer the same suggestion. Out of scope for v0.1.1; address when wired.
- **Per-archetype tuning.** HUMANITIES vs TECH archetypes may want different
  thresholds (e.g. `REPEATED_QUESTION_THRESHOLD`). Add archetype param when
  the integration layer demands it.

## Trust boundary

This layer is heuristic. No claim it captures user emotion accurately — it
classifies *signals in text*. Confidence values are calibration hints, not
probabilities. Downstream consumers MUST treat the output as an advisory
register cue, not as a fact about the user.
