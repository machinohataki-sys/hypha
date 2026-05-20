# HYPHA · W2.4 Repair Pipelines

> Three micro-intervention streams triggered by W2.3 Goal Guardian's
> `decideIntervention()` output. Goal Guardian is the *assessor* (reads
> Mastery Map + recent turns + cadence + scoreHistory, classifies state);
> the Repair Pipelines are the *executors* (build the concrete next-turn
> prompt + UI choices the user sees).
>
> Touchstone: `BLUEPRINT.md §3.4 Goal Guardian` + `ROADMAP.md v0.6`.
> Manuscript register binding: `app/lib/hypha-constitution.js` FULL block.

## 1. Why three streams, not one

A single "repair" path conflates three failure modes that need different
moves. Confusion (concept stuck) wants *simpler frame + concrete*.
Motivation (fatigue) wants *evidence + rest offer + no push*. Self-doubt
(self-derogation) wants *progress playback + tooled diagnosis + no
praise*. Same call signature → 3 different downstream pipelines.

| Stream | Trigger (Goal Guardian state) | User signal | First move |
|---|---|---|---|
| Confusion Repair | `confused` | Same Q ≥ 2x across recent turns | Simpler analogy + concrete |
| Motivation Recovery | `frustrated` | "学不动了" / low score streak ≥ 3 / over cadence | Evidence recap + rest offer |
| Self-doubt Repair | `self_doubt` | "我太笨" / "别人都会" + verbatim derogation | Progress playback + W1.4 diagnosis |

## 2. Confusion Repair · `app/lib/repair/confusion-repair.js`

### Stage flow

1. **Identify stuck KP** — count user-turn mentions of each KP id in
   `lessonContext.kp_ids[]`; pick highest count, ties → most recent.
   Falls through to `lessonContext.current_kp_id`.
2. **Simpler analogy** — T4_JUDGE generates a lighter rephrase. *Mocked
   today* (returns `[mock] 换一个更简的角度...`). Followup: wire
   `router.executeChat('T4_JUDGE', ...)`.
3. **Concrete example** — prefers `lessonContext.canonical_example`
   (already in v0.2 lesson body); falls back to library retrieval mock.
4. **3-choice exit** — A) understood (exit) / B) still stuck (escalate)
   / C) need prerequisite (patch upstream). B re-entry → difficulty drop
   from -1 to -2.

### Exit conditions

- A → write `outcome:'understood'` event, callout dismisses.
- B → re-invoke with `escalated:true`; if user picks B again, surface
  prerequisite-patch suggestion automatically.
- C → hand off to prerequisite-patch handler (W1.5+, deferred).

## 3. Motivation Recovery · `app/lib/repair/motivation-recovery.js`

### Stage flow

1. **No push** — banned phrase list strips "加油", "你可以的", "great
   job", emoji, "!". The recovery body is built from *evidence* not
   rhetoric. Validator (`_violatesRegister`) runs post-render.
2. **Evidence recap** — reads `vault/<slug>/events.jsonl` for last
   `windowDays` (default 7) and collects PASS-class rows:
   - `type` starts with `micro_proof` + `result === 'PASS'`
   - `type === 'mastery:kp_passed'`
   - `type === 'lesson:complete'`
   De-duped by `kp_id` (latest wins). Returns concrete KP labels —
   no generic "you've been doing great".
3. **Micro-rest offer** — 3 options: `short_rest` (5min) / `end_session`
   (today) / `continue`. Package only; UI renders.
4. **User picks** — we do NOT pre-select. `next_choice: null` returned.

### Exit conditions

- `short_rest` → fires a cadence-engine cue (W2.1 reads via event row).
- `end_session` → next launch shows the recap as a soft re-entry.
- `continue` → callout dismisses, regular tutor stream resumes.

## 4. Self-doubt Repair · `app/lib/repair/self-doubt-repair.js`

### Stage flow

1. **Classify doubt** — generalization (`我太笨` / `i'm stupid`) vs
   specific (`我不懂量子叠加`). Generalization is more dangerous; harder
   to repair because there is no concrete target. Lexical cue tally
   over `doubtTrigger` + last 5 user turns.
2. **Progress playback** — reads `events.jsonl` for `windowDays`,
   pairs early-FAIL with later-PASS rows on the same `kp_id`. Renders
   as `early wrong → later correct → this is movement, not a state
   description`. No praise.
3. **Tooled diagnosis** — calls
   `misconception-engine.detectMisconceptionInResponse(lastWrong, bank)`
   to type the mistake-class (wrong_analogy / surface_understanding /
   dangerous_simplification / pseudo_understanding). Converts "我太笨"
   into "你刚才的错处属于 surface_understanding —— 是具体的修法目标".
4. **3 actions** — continue / misconception_check / micro_rest. Default
   suggestion: `misconception_check` when diagnosis returns a category;
   `micro_rest` when generalization confidence ≥ 0.55; else `continue`.

### Exit conditions

- continue → resume regular tutor stream.
- misconception_check → hand off to W1.4 Misconception repair pipeline.
- micro_rest → fires same cadence cue as Motivation Recovery `short_rest`.

## 5. Anti-patterns (binding — violation = trust -1)

- "great question!" / "you got this!" / "加油" / "你可以的"
- Third-person ("用户", "the user")
- SaaS gamification: streak badges, level up, percentage bars
- Emoji of any kind / exclamation marks
- Generic comfort ("everyone struggles", "it's normal to feel this way")
- Predicting the user's emotion ("I bet you're frustrated") — name only
  what is observable in the trace
- Fabricated stats ("70% of users get this wrong") — no telemetry yet,
  numbers MUST be evidence-backed

## 6. Success patterns

- Concrete evidence over rhetoric (specific KP labels, not "good job")
- Tooled diagnosis (call W1.4 — name the mistake-class)
- User sovereignty (3-choice, never pre-pick; let user own next step)
- Manuscript register voice (Garamond cadence, no jargon, peer-level)
- Stage 1 always names the stuck point — no generic openers

## 7. System relations

- **W2.3 Goal Guardian (assessor)** — runs `assessState()` → state
  + confidence; calls `decideIntervention()` → which stream to invoke.
  W2.4 pipelines never assess; they execute.
- **W1.3 Anti-Illusion** — its `misconception_repair` intervention path
  *can* route through Confusion Repair when the wrong-prior is a
  conceptual confusion (not a wrong analogy). Today the routing is
  manual; W2.4-followup wires the dispatcher.
- **W1.4 Misconception Engine** — Self-doubt Repair Stage 3 calls
  `detectMisconceptionInResponse` to type the mistake-class. The
  category surfaces in the repair prompt as a concrete name.
- **W2.1 Cadence Engine** — Motivation Recovery's `short_rest` and
  Self-doubt Repair's `micro_rest` actions emit event rows the cadence
  decision function reads to schedule the next lesson interval.
- **W2.2 Mastery Map** — provides `masteryMap` to Motivation Recovery
  (informs which KPs are "held" vs "shaky" in the evidence recap).

## 8. IPC surface

- `repair:confusion`   → `repair-confusion.runConfusionRepair(args)`
- `repair:motivation`  → `motivation-recovery.runMotivationRecovery(args)`
- `repair:self-doubt`  → `self-doubt-repair.runSelfDoubtRepair(args)`
- `repair:run`         → orchestrator dispatch + `repairResultToTutorPrompt`

All four return the standard hypha envelope:
`{ ok:true, ...result }` / `{ ok:false, error, message }`.
Renderer never sees raw exceptions across the bridge.

## 9. Telemetry (events.jsonl)

Each pipeline writes ONE event row on entry (outcome:`pending`) and the
UI writes a second row on user choice (outcome:`understood` /
`escalated` / `prerequisite` / `short_rest` / `end_session` / `continue`
/ `misconception_check` / `micro_rest`). Schema:

```
{ ts, type: 'repair:confusion'|'repair:motivation'|'repair:self_doubt',
  intervention_id, outcome, ...stream-specific fields }
```

W2.4-followup adds the second-row write in UI when the user picks; the
first row is sufficient for `theory ship` parity.

## 10. Open questions (W2.4-followup)

- T4_JUDGE wiring for Confusion Repair Stage 2 (mock → real)
- Library retrieval mock → `app/lib/library.js` query against slug + KP
- `similar_users_pct` in self-doubt diagnostic — needs aggregate
  mastery-map sampling (deferred until v0.7)
- Auto-dispatch from W2.3 Goal Guardian (today the UI surfaces the
  callout manually; followup makes it a direct stream)

## 11. Module map

```
app/lib/repair/
├── confusion-repair.js       — runConfusionRepair(args)
├── motivation-recovery.js    — runMotivationRecovery(args)
├── self-doubt-repair.js      — runSelfDoubtRepair(args)
└── index.js                  — runRepair(type, args) + repairResultToTutorPrompt
```

UI hook: `app/design/screen-lesson-chat.jsx` (state hooks
`repairCallout` / `repairResult` + inline callout block).

IPC: `app/main.js` (4 handlers under `// W2.4 Repair Pipelines`).
Bridge: `app/preload.js` (under `window.ptor.repair`).
