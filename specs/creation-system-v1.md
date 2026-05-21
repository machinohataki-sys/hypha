# Creation System v1 — W5.4 Automation Layer

> Status: theoretical ship 2026-05-13. LLM stages mocked; surface contracts
> locked so downstream wiring (UI + tests + W2.1 cadence hook) bake against
> the real shape today.

## Why this exists

W3.1–W3.6 shipped the foundations of the Creation System: a product is bound
to a curriculum slug, a 10-section blueprint editor surfaces the framework,
single-shot product transfer fires when a lesson's knowledge point passes the
`P ≥ 0.6` threshold, and sparks accumulate as a state-machined backlog of
"things to consider becoming features."

Each of those primitives is _passive_. The user must remember to:

1. inspect each lesson for a transfer button (it might never appear if `P`
   was a hair under threshold for any reason — model variance, mock vs. real,
   sleep cycle, etc.);
2. open the blueprint editor and manually compose the Roadmap section from
   scattered inspiration-pool rows + sparks;
3. read kill-criteria.json + plug in numbers from elsewhere to check whether
   the product should fold;
4. wade through `sparks/*.md` in chronological order even though the highest
   leverage spark is rarely the most recent one.

W5.4 is the automation layer that makes those four chores happen on a weekly
cadence (or on demand) without the user opening every file. **It writes
through the W3.x lib — it never mutates W3.x state directly.** This is
deliberate: W3.x owns the data shape; W5.4 only orchestrates timing and
aggregation.

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │      W5.4 index.js (orchestrator)       │
                    │  runCreationSystemV1Cycle(slug, opts)   │
                    └────────┬───────┬───────┬───────┬────────┘
                             │       │       │       │
              ┌──────────────┘       │       │       └──────────────┐
              ▼                      ▼       ▼                      ▼
   ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
   │  auto-transfer   │ │ auto-roadmap-sync│ │  auto-kill-eval  │ │  spark-priority  │
   │                  │ │                  │ │                  │ │                  │
   │ schedule         │ │ weeklyRoadmapSync│ │ evaluateKill     │ │ rankSparks       │
   │ runDailyAudit    │ │                  │ │ Schedule         │ │ getNextToConsider│
   │ getTransferQueue │ │                  │ │                  │ │                  │
   └─────────┬────────┘ └─────────┬────────┘ └─────────┬────────┘ └─────────┬────────┘
             │                    │                    │                    │
             ▼                    ▼                    ▼                    ▼
   W3.3 product-transfer   W3.1 creation-pool-ops   W3.1 creation-pool-ops   W3.4 product-spark
                            (appendRoadmapSync)      (evaluateKillCriteria)   (listSparks)
```

Every arrow points _down_ — W5.4 reads + calls into W3.x, never the reverse.
W3.x stays oblivious to W5.4's existence, so the W5.4 layer can be deleted
or replaced without touching the foundations.

## The four modules

### 1. `auto-transfer.js`

- `scheduleAutoTransfer(slug, options)` — wrapped W3.3 `triggerTransfer` call
  emitted on lesson completion. Writes a `creation_v1:auto_transfer_scheduled`
  event row so the audit later knows this lesson was already considered.
- `runDailyTransferAudit(slug, opts)` — walks `events.jsonl` for the last 7
  days, pairs each `lesson_complete` with downstream transfer-fired rows,
  back-fires any lessons missing one. Output: `{ audited, back_filled[],
  skipped[], failed[] }`.
- `getTransferQueue(slug, opts)` — pure read-only computation of "what would
  fire" without writing. UI uses this for an inspectable preview.

### 2. `auto-roadmap-sync.js`

Per BLUEPRINT §11.8 example flow:

1. **Harvest** — read inspiration-pool.jsonl + sparks + events from last 7
   days.
2. **Cluster** — bucket by source-type × suggested-section / affected-module.
3. **Score** — `urgency × impact × feasibility` triplet:
   - urgency = min(1, evidence_count / 3)
   - impact = 1.0 when ≥ 2 distinct source-types contributed, else 0.6
   - feasibility = 1.0 if any spark in cluster is `accepted` / `implemented`,
     else 0.7
4. **Synthesize** — mock T6_STRONG body generation (real swap point clearly
   marked: `executeChat('T6_STRONG', …)`).
5. **Top-K** — 6 minimum, 8 maximum. Top-2 priority = 1 (surfaced); rest
   priority = 2 (archived). Persist through `creation-pool-ops.appendRoadmapSync`.

When the harvest is sparse, synthetic placeholders fill to the minimum count
so the UI surface always renders.

### 3. `auto-kill-eval.js`

- Derives a default `currentMetrics` from `events.jsonl` (lessons completed,
  transfers fired, spark accept/reject counts, days inactive) when the
  caller doesn't supply one.
- Delegates the actual `would_kill` comparison to W3.1's
  `evaluateKillCriteria` — we never reimplement that logic.
- Emits a typed `kill:triggered` event per triggered criterion with
  `criterion_id`, `current_value`, `threshold`, `severity`.
- **NEVER auto-kills.** The user decides. Cooldown gate (24h per criterion)
  prevents alert spam from a stuck-low metric.

### 4. `spark-priority.js`

Pure compute. Factors (weighted sum to 0..1):

- **state** (0.40) — `seed = 1.0 > considered = 0.85 > accepted = 0.70 >
  implemented = 0.20 > rejected = 0.00`. Rejected sinks unconditionally
  via a secondary sort guard.
- **age** (0.20) — linear decay over 30 days; newer wins.
- **affected_modules** (0.15) — 0/1/2/≥3 → 0.3/0.5/0.75/1.0. Rewards
  cross-cutting sparks.
- **relevance** (0.25) — pre-cached P if any, else neutral 0.5.

`getNextSparkToConsider` walks the ranked list and surfaces the top seed
first (so the user is nudged to transition seeds → considered), falling
through to top considered, then top accepted, then null.

## Trigger surfaces

Three ways `runCreationSystemV1Cycle` fires:

1. **Cadence wrapper** (`cadence-hook.js`) — when W2.1
   `shouldTriggerIntegrationDay` returns true at a 0.25 / 0.5 / 0.75 progress
   milestone. The wrapper preserves W2.1's pure return shape and simply
   side-effects W5.4 in the same call. **W2.1 is not modified.**
2. **Manual IPC** — `creation_v1:runCycle` invoked from the Blueprint UI or
   future CLI. Trigger label = `'manual'`.
3. **Tests / smoke** — direct module import + call.

## IPC + bridge

| IPC channel | Bridge | Purpose |
| --- | --- | --- |
| `creation_v1:autoTransferQueue` | `creationV1.autoTransferQueue` | preview queue |
| `creation_v1:runTransferAudit` | `creationV1.runTransferAudit` | back-fill 7d |
| `creation_v1:weeklyRoadmap` | `creationV1.weeklyRoadmap` | full roadmap sync |
| `creation_v1:evalKill` | `creationV1.evalKill` | kill criteria scheduled eval |
| `creation_v1:rankSparks` | `creationV1.rankSparks` | ranked sparks array |
| `creation_v1:nextSpark` | `creationV1.nextSpark` | "next spark to consider" |
| `creation_v1:runCycle` | `creationV1.runCycle` | orchestrator full pass |

Each returns the standard hypha envelope (`{ ok: true, ... }` or
`{ ok: false, error / reason }`).

## Relationship to peer waves

- **W3.1 / W3.2 / W3.3 / W3.4** — W5.4 reads + writes through their public
  surfaces. No direct file mutation in W5.4 modules.
- **W2.1 cadence-engine** — wrapped via `cadence-hook.js`. W2.1 stays pure
  (zero changes). The hook adds the side effect at Integration Day only.
- **W5.1 embed / W5.2 walkGraph** — best-effort optional. The cluster step
  in `auto-roadmap-sync` falls back to token-overlap when they're absent.
  When they ship, drop-in upgrade: replace `_clusterCandidates` body with
  the embed-driven path; output contract stays identical.
- **W4.2 KPI Dashboard** — currentMetrics shape compatible. KPI can call
  `evalKill` with its own metrics; we use the same key names where
  reasonable (lessons_completed_7d / transfers_fired_7d / sparks_accepted_7d).

## Spark Priority Ranking — formula recap

```
score = 0.40 × state_score
      + 0.20 × age_score
      + 0.15 × affected_modules_score
      + 0.25 × relevance_score
```

Each component is clamped to [0, 1]. Final score rounded to 3 decimals.
Rejected sparks are sunk regardless of score. The next-to-consider helper
returns the top entry from the first non-empty bucket of {seeds, considered,
accepted}, in that order — never `rejected` or `implemented`.

## Roadmap Sync — period + LLM stage

- **Period** — weekly by cadence wrapper trigger (0.25 / 0.5 / 0.75 milestone)
  OR manual user invocation. No fixed-clock cron in node; the user's pace
  drives Integration Day, which drives the cycle.
- **LLM stage** — `T6_STRONG` once the calibration wave lands. Today the
  mock produces deterministic synthesis output keyed off cluster composition
  so the UI + persisted roadmap-sync.json + events.jsonl all line up against
  the future real-LLM shape.

## Kill Criteria alert flow

```
runCycle ──▶ evaluateKillCriteriaSchedule ──▶ ops.evaluateKillCriteria (W3.1)
                                                       │
                                                       ▼
                                              kill-criteria.json
                                              would_kill flags set
                                                       │
                              ┌────────────────────────┴──────────────────────────┐
                              ▼                                                   ▼
                  for each c.would_kill === true                          ALSO writes
                              │                                       evaluation-log.jsonl
                              ▼
                   24h cooldown? Yes → suppress
                              │ No
                              ▼
                  events.write 'kill:triggered'
                  stamp c._last_alert_ts
```

The product is NEVER auto-killed. The user gets the alert; the decision
stays with them.

## Tests

`__tests__/creation-system-v1.test.js` ships with at least 12 `test.todo`
placeholders covering: state ranking ordering, age decay, modules score,
relevance score, kill alert cooldown, transfer audit back-fill, roadmap
sync minimum count, synthetic placeholder fallback, cadence wrapper
integration-day side effect, runCycle stage isolation, harvest event
filtering, IPC envelope shape.

## Out of scope for W5.4

- Real LLM calls (T6_STRONG / T4_JUDGE) — calibration wave owns these.
- W5.1 embed clustering — adapter point reserved.
- W5.2 walkGraph for cross-curriculum migration points — same.
- W3.x lib edits — entirely forbidden by this stream's scope.
- Mutations to W2.1 cadence-engine internals — wrapper-only.
- Persona Corpus dependency — independent.

## Total surface delta

Six new files under `app/lib/creation-system-v1/` (auto-transfer + auto-
roadmap-sync + auto-kill-eval + spark-priority + index + cadence-hook), one
W5.4 IPC scaffold block in `app/main.js`, one bridge object in
`app/preload.js`, one strip component in
`app/design/screen-product-blueprint.jsx`, one spec (this file), one test
scaffold. All within the 700-line budget.
