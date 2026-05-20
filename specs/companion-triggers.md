# Companion Triggers — W3.6 State-Expression Wiring

> **Stream**: W3.6 (2026-05-13). Wires the 5 BLUEPRINT §16 trigger types to live
> Hypha events so the W3.5 Companion expression engine fires at the right
> moments. **Status**: lib + IPC + preload shipped. UI hook + 5 in-line
> trigger sites wired into Quality Harness / llm:lesson / Finish Ritual /
> cadence-engine wrapper. Product-spark site is a forward-compat hook —
> trySparkSprout is exported and ready for W3.4 to call.

## 1. Boundary with W3.5

| Layer | Owner | Files |
|---|---|---|
| Expression (text + tone + boundary guard) | **W3.5** | `app/lib/companion/` (engine), `companionRespond(triggerType, ctx)` |
| Detection + dispatch + dedupe | **W3.6** | `app/lib/companion-triggers.js`, `app/lib/companion-history.js` |
| UI surface (presence + dismiss) | **W3.5** | `app/design/companion-presence.jsx` |

W3.6 never reaches into W3.5 internals. The only call we make is
`companionRespond(triggerType, context)` — and we wrap it in a soft import
so W3.6 runs even before W3.5 ships (silent no-op on the expression side;
detection + dedupe still record).

## 2. The 5 Triggers

| # | Trigger | Detection condition | Dedupe key | Tone (W3.5) |
|---|---|---|---|---|
| 1 | `lesson_complete` | `harnessResult.overall_pass === true` | `String(lessonIdx)` | "孢子已经落进土里" |
| 2 | `interrupt_resume` | first new session AND last session ≥ 3 days ago | `YYYY-MM-DD` of resume | "菌丝没有死，只是安静了三天" |
| 3 | `over_grind` | last-24h lessons ≥ 4 OR consecutive_no_rest ≥ 4 | `YYYY-MM-DD` of detect | "暗处的菌丝需要时间" |
| 4 | `finish_capture` | `ritualStage === 'completed'` (W1.5 Stage 4) | `sessionId` | "孢子收束，开始发酵" |
| 5 | `product_spark_sprout` | transition `seed` → `considered` (W3.4) | `sparkId` | "新菌芽冒头了" |

## 3. companion-fired.json schema

```jsonc
{
  "version": 1,
  "fires": [
    { "type": "lesson_complete", "key": "0", "ts": "2026-05-13T10:22:11.000Z",
      "meta": { "lessonIdx": 0 } },
    { "type": "interrupt_resume", "key": "2026-05-13",
      "ts": "2026-05-13T08:00:00.000Z",
      "meta": { "lastLessonAt": "2026-05-09T11:00:00.000Z" } }
  ]
}
```

- Bounded array (FIFO, max 200 entries) — oldest fires fall off so the file
  never grows unbounded in long-running curricula.
- Corrupt-file recovery: invalid JSON → treat as empty. We never crash the
  trigger pipeline on a missing or malformed sidecar.
- `recordFired` is **record-first** (before W3.5 dispatch) so a crash mid
  expression call cannot double-fire on retry.

## 4. Wire sites (5 trigger points)

| Trigger | File | Line | Edit |
|---|---|---|---|
| `lesson_complete` | `app/lib/quality-harness/runHarness.js` | inside `runHarness` per-sample loop, after `samples.push` | +8 lines (try/catch around `tryLessonComplete`) |
| `interrupt_resume` | `app/main.js` | `llm:lesson` handler, inside `isNewSession=true` branch | +5 lines (read `_lastSessionTimestamp(slug)` → `tryInterruptResume`) |
| `over_grind` | `app/lib/companion-triggers.js` | `computeCadenceWithCompanion()` wrapper | new wrapper (cadence-engine remains pure) |
| `finish_capture` | `app/lib/finish-ritual.js` | after Stage 4 sidecar write, before return | +5 lines (`tryFinishCapture` post-deposit) |
| `product_spark_sprout` | (deferred to W3.4) | `app/lib/product-spark.js:transitionState` | call `trySparkSprout({ slug, sparkId, transitionFrom, transitionTo })` once W3.4 lands; helper already exported |

Every wire site is a single `require('./companion-triggers')` + a single
async call wrapped in try/catch. No site exceeds +8 lines. The wrapping
discipline is: **companion never blocks the surface it observes.** A throw
inside the trigger module never propagates back to the lesson stream, the
harness loop, or the Finish Ritual deposit.

## 5. cadence-engine boundary

W2.1 `computeCadence` is pure. We do **not** mutate it. Instead
`computeCadenceWithCompanion(input, opts)` lives in companion-triggers.js,
calls cadence-engine, then layers an over-grind detection + dispatch on
top. Callers that want companion behavior opt in by switching from
`computeCadence` to `computeCadenceWithCompanion`. The decision shape is
identical, plus a `companion: { trigger_fired }` field.

This honors the W2.1 contract ("no I/O, no LLM call, no mutation") while
still letting the over-grind trigger fire from a cadence-driven surface.

## 6. IPC surface (main.js)

7 handlers under `companion:*` prefix:

- `companion:detect:lessonComplete` — pure read, returns `{ detected: bool }`
- `companion:detect:interruptResume`
- `companion:detect:overGrind`
- `companion:detect:finishCapture`
- `companion:detect:sparkSprout`
- `companion:trigger` — manual fire `{ triggerType, context }` for debug
- `companion:history` — list last N fires for a slug

Renderer surface (`window.ptor.companion`) mirrors these 1-to-1, plus
ergonomic argument shapes. The detect IPCs are useful for debug panels
and for any UI that wants to preview "would this fire?" before user action.

## 7. Dedupe & rate-limit

W3.6 ledger is **per-(slug, trigger_type, key)**. We do not enforce a
cross-trigger rate limit — that responsibility is W3.5 tone-engine
boundary-guard's (it caps total companion utterances per session). Layered:

```
W3.6 dedupe (record + skip if seen)
  ↓ (dispatched)
W3.5 boundary-guard (cap total per session, cap per minute)
  ↓ (allowed)
W3.5 tone-engine (render text)
```

A spark that toggles seed → considered → seed → considered will only fire
the sprout trigger **once** (first transition); subsequent identical
transitions are dedupe-skipped.

## 8. Surprise / open questions

1. **`interrupt_resume` last-activity source.** We currently derive it from
   `vault/<slug>/sessions/*.jsonl` mtime. If the OS rewrites mtime on copy
   (e.g. cloud sync), the resume detector will misfire. A persistent
   `state.json.lastLessonAt` field would be more robust but requires a
   schema bump — deferred to W3.6.1 if mtime drift surfaces in practice.
2. **`over_grind` 24h window source.** Today we trust caller-supplied
   `lessonsLast24h` (from cadence-state). If callers forget to populate
   that field, the trigger silently doesn't fire. Future hardening: have
   companion-triggers derive it itself by scanning sessions/.
3. **`product_spark_sprout` wire-up.** Helper `trySparkSprout` is exported
   and unit-testable, but W3.4 hasn't landed product-spark.js yet, so the
   actual invocation site is paper. We could write a stub module to keep
   the brief literal, but that risks colliding with W3.4's design — we
   chose to leave the call site as a documented hook (file path + line in
   §4 above) and ship the helper.

## 9. Test surface

`app/__tests__/companion-triggers.test.js` — 14 `test.todo()` placeholders
covering 5 detect functions (1 pure happy + 1 boundary each), dedupe
behavior (first fire records, second fire skipped), bad-input safety, and
the cadence wrapper integration. Bodies deferred to W3.6.1 calibration.
