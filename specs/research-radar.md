# Research Radar — W6.3 (Alpha)

> Source: BLUEPRINT.md §15 · ROADMAP.md v1.7
> Status: theory-ship Alpha · 2026-05-13
> Module: `app/lib/research-radar/` (radar / frontier-report / auto-actions / index)

## 1. Anti-principle (binding)

> **HYPHA 不推送前沿. HYPHA 把前沿编译进下一堂课和用户正在创造的东西里.**

Research Radar is NOT a news feed. It does not:

- Emit notifications, toasts, badge counts, or "X new" indicators.
- Surface a top-of-app radar drawer that demands attention.
- Implement infinite scroll, recency-weighted re-ranking, or a "trending" tab.

It DOES:

- Run a quiet cron cycle to harvest frontier sources for user-declared topics.
- Compile findings into Frontier Reports that live as files inside the vault.
- Auto-mirror reports into the existing Web Note Engine raw layer.
- Inject up to three recent reports' citation blocks into `designLesson` system
  prompts (only when the lesson body would benefit; 7-day window only).
- Offer Product Spark candidates the user explicitly promotes via the dashboard.

Surfacing happens INSIDE existing surfaces (lesson body, Spark pool, Notebook).
The dashboard is a destination the user visits, never a stream pushed at them.

## 2. Subscription schema

Persisted at `vault/<slug>/research-radar/subscriptions.json` as an array of:

```json
{
  "topic": "diffusion models",
  "frequency": "weekly",
  "sources": ["arxiv", "huggingface"],
  "filter_keywords": ["sampler", "scaling"],
  "last_run": "2026-05-10T08:00:00.000Z",
  "created_at": "2026-04-29T17:12:33.811Z",
  "updated_at": "2026-05-13T03:01:11.402Z"
}
```

- `frequency` ∈ `daily` | `weekly`. Weekly subscriptions only fire on
  `runDailyRadar` after a 6-day floor since `last_run`, so a slightly
  drifting cron still catches them.
- `sources` ∈ subset of `[arxiv, huggingface, github, semantic-scholar]`.
- `filter_keywords` are passed into the cheap-router relevance query alongside
  the topic itself — they tighten what counts as "on-topic" without forcing
  the user to reword the topic.

## 3. Four source adapters

| Source | Status (Alpha) | Production target |
|---|---|---|
| `arxiv` | mock (deterministic) | export.arxiv.org/api/query or bb-browser scrape |
| `huggingface` | mock (deterministic) | huggingface.co/api/models?search + /api/datasets |
| `github` | mock (deterministic) | `gh search repos --json` + trending RSS |
| `semantic-scholar` | mock (deterministic) | api.semanticscholar.org/graph/v1/paper/search |

Mock items are seeded by `sha256(topic|source|date)` so the same topic on the
same day produces identical items — essential for test smoke and downstream
dedup. All four adapters are marked `intentional-placeholder` per Wave 6.3
Alpha brief (real wiring lands once Cheap Router quota allocation + bb-browser
adapter rotation are tuned).

## 4. Cycle pipeline

```text
runRadarCycle(slug, topicFilter?)
  └─ for each subscription (filtered by topicFilter):
       ├─ fetchAllSources(topic, sources, dateKey)        ← 4 adapters
       ├─ firstPassFilter(items, topic, filter_keywords)  ← W5.1 Cheap Router
       │     T0_RULE Jaccard, escalates to T1_EMBED on fuzzy band
       │     keep top 10 with score ≥ FIRST_PASS_RELEVANCE_FLOOR (0.05)
       ├─ loadGoalContract(slug)                          ← reads state.json
       ├─ generateReport(top, goalContract, ctx)          ← T6_STRONG (mock)
       ├─ write vault/<slug>/research-radar/reports/<topic-slug>/<date>.json
       └─ update subscription.last_run
```

Cycle is idempotent on same-day re-runs: the report file overwrites by date,
and `storeAsNote` returns `deduped: true` on the second pass.

## 5. Frontier Report schema (RFR)

```json
{
  "topic": "diffusion models",
  "date": "2026-05-13",
  "slug": "diffusion-mini",
  "generated_at": "2026-05-13T08:11:22.103Z",
  "items": [
    {
      "source": "arxiv",
      "title": "Item title (≤ 90 chars)",
      "url": "https://...",
      "summary_short": "≤ 280 chars, whitespace-normalized",
      "relevance_to_goal": "single editorial sentence tying item to north_star",
      "potential_implication": "single editorial sentence on what to do with it",
      "published_at": "2026-05-13"
    }
  ],
  "synthesis_paragraph": "≤ 600 chars, scholar register, what changed",
  "action_items": [
    { "verb": "cite", "detail": "...", "ties_to_lesson": true }
  ],
  "product_spark_candidates": [
    { "title": "...", "core_transfer": "...", "related_product": "...", "risk": "..." }
  ]
}
```

Action items max 3. Spark candidates default to GitHub items in Alpha (clear
build-able shape); production T6 will judge transfer potential per item.

## 6. Three auto-actions

Each is OPT-IN; nothing fires implicitly except `storeAsNote` from
`runDailyRadar` (mirror-to-graph is cheap + idempotent).

### 6.1 `storeAsNote(slug, report)` — W5.2 Web Note Engine mirror

- Builds node id `radar-<topic-slug>-<date>-<6hex>` deterministically.
- Layer `raw`, content = `formatReportMarkdown(report)`.
- Frontmatter records `{source: 'research-radar', topic, date, report_items,
  has_spark_candidates}` so Living Note utility scoring can age them.
- Returns `{ok:true, deduped:true}` on second run same day rather than fail.

### 6.2 `lessonCitationHook(slug, lessonIdx)` — designLesson injection

- Read-only. Filters `listAllReports(slug)` to last 7 days by `generated_at`
  (falls back to `date` if `generated_at` missing).
- Returns max 3 reports formatted as `===== FRONTIER CITATIONS =====` block.
- `agent.js:designLesson` calls this inside the learn-mode branch and appends
  the block to the system prompt appendix when non-empty. Empty string when no
  recent reports — appendix stays clean (anti-feed: never inject empty noise).

### 6.3 `triggerProductSparkCandidate(slug, candidate, reportContext)` — W3.4 seed

- Calls `product-spark.createSpark(slug, {state:'seed', source:{type:'note',
  ref:<reportRef>, label:'research-radar'}, ...})`.
- `source.type='note'` because W3.4's SOURCE_TYPES enum is `[lesson, note,
  book, pack]`. The `label` field preserves the originating system in the
  audit trail without expanding the W3.4 schema.
- Spark lifecycle then runs through standard W3.4 transitions
  (seed → considered → accepted → implemented | rejected).

## 7. Cron scheduling (`runDailyRadar`)

```js
const radar = require('./lib/research-radar');
const result = await radar.runDailyRadar();
// → { ok: true, runs: [{slug, topic, ok, reports?, error?, skipped?}] }
```

Scans `vault/*/research-radar/subscriptions.json`, runs every daily sub plus
every weekly sub whose `last_run` is older than 6 days. Per-run failures
collect into `result.runs` but never abort the rest of the cycle.

Production cron entry (W6.2 Cron Engine): `radar:runDaily` IPC fires daily at
04:00 local. Renderer can also fire `radar:run` on demand from the dashboard.

## 8. IPC surface (main.js / preload.js)

| IPC channel | Renderer bridge | Returns |
|---|---|---|
| `radar:subscribe` | `window.ptor.radar.subscribe(slug, topic, options)` | `{ok, subscription}` |
| `radar:unsubscribe` | `window.ptor.radar.unsubscribe(slug, topic)` | `{ok, removed}` |
| `radar:list` | `window.ptor.radar.list(slug)` | `{ok, subscriptions}` |
| `radar:run` | `window.ptor.radar.run(slug, topic?)` | `{ok, reports, errors}` |
| `radar:runDaily` | `window.ptor.radar.runDaily(opts)` | `{ok, runs}` |
| `radar:report` | `window.ptor.radar.getReport(slug, topic)` / `.listAll(slug)` | `{ok, latest, reports}` |
| `radar:formatReport` | `window.ptor.radar.formatReport(report)` | `{ok, markdown}` |
| `radar:lessonCitationHook` | `window.ptor.radar.lessonCite(slug, lessonIdx)` | `{ok, citation_block, reports_used}` |
| `radar:triggerSpark` | `window.ptor.radar.triggerSpark(slug, candidate, reportCtx)` | `{ok, spark_id, path}` |
| `radar:storeAsNote` | `window.ptor.radar.storeAsNote(slug, report)` | `{ok, node_id, deduped?}` |

All handlers return the standard hypha envelope `{ok, ...payload}` on success
or `{ok:false, error, message}` on failure.

## 9. Boundary partners

- **W5.1 Cheap Router** — first-pass filter uses `runCheapTask('relevance_score',
  …)` which routes T0_RULE → T1_EMBED on fuzzy band. Falls back to lexical
  Jaccard if the router fails to load (test friendliness).
- **W5.2 Web Note Engine** — `storeAsNote` calls `getEngine(slug).addNode(…)`
  with layer `raw`. Reports become discoverable via Notebook + Context Packet
  without polluting the canonical lesson notes.
- **W3.4 Product Spark** — `triggerProductSparkCandidate` calls
  `createSpark(slug, sparkData)` with `state:'seed'`. We do NOT touch the
  state-machine — promotion is the standard `transitionState` flow.
- **W6.2 Cron Engine** — `runDailyRadar()` is the registered job target.
- **W6.4 / W6.5** — independent; no coupling this tranche.

## 10. UI surface

`app/design/screen-radar-dashboard.jsx` exposes a 3-column dashboard:

1. **Subscriptions** — add (topic + frequency + sources + filter keywords),
   list (per-row Run now + Remove), no badge counts.
2. **Reports list** — most recent first across all topics for this slug.
3. **Report detail** — synthesis paragraph, signals, action items, spark
   candidates (each with Seed-as-spark button), Store-as-note shortcut.

Route key `radar-dashboard` in `app/design/app.jsx`. Slug resolution priority
mirrors spark-pool / kpi-dashboard (productBlueprintSlug → goal.slug →
goal.noteRel parse → first course).

Onboarding adds a `frontier_topics` TagInput field (Step 1 section) so users
can declare topics during the goal contract phase. Subscriptions actually
land via `radar:subscribe` post-onboarding — the onboarding payload only
carries the topic list forward.

## 11. Failure modes (Alpha)

- Cheap Router unavailable → fall back to lexical token-overlap filter.
- T6_STRONG synth unavailable → `_fallbackSynth` returns a mock-only report
  with `synthesis_paragraph` flagged; the cycle still completes.
- Source adapter throws → that source skipped, others continue.
- Web Note Engine missing → `storeAsNote` returns `{ok:false}` but the
  canonical JSON report file remains. The report is recoverable on next
  cycle with `autoStoreNotes:true`.
- Product Spark module missing → `triggerProductSparkCandidate` returns
  `{ok:false}`; no partial state written.

## 12. Test surface

`__tests__/research-radar.test.js` carries placeholder `test.todo()` entries
covering:

- subscribeTopic round-trip + dedup of repeated topic
- listSubscriptions empty / populated shapes
- unsubscribeTopic no-op when topic absent
- runRadarCycle smoke: mkdtemp + faked subscription + mock items → report file
- runRadarCycle topicFilter narrows to one topic
- 7-day window for lessonCitationHook (boundary: 6d50m kept, 7d10m dropped)
- storeAsNote idempotent on same-day re-run
- triggerProductSparkCandidate maps source.type='note' + label='research-radar'
- frontier-report validateReport rejects missing topic / non-array items
- formatReportMarkdown handles empty items / spark candidates
- Cheap Router fallback when require fails (lexical path)
- VALID_SOURCES + VALID_FREQUENCIES guard rejects unknown values

Real Jest harness lands with the cost-ledger integration pass (W5.4).
