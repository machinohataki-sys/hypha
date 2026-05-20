# Longform Spark Distillation — spec

> BLUEPRINT System 5 §5.1 (Longform Distillation 7-phase) + §5.2 (Book Spark
> Pack, 15-field artefact) + §5.3 (Book Router — cache-served slices).

## Purpose

Hypha's Library system stores books as raw extracted text + section-typed
chunks (`app/lib/library.js`). That is enough for keyword retrieval into a
single lesson's harvest pipeline. It is **not** enough to:

1. Surface a book's overall argument before the user has read it.
2. Compress N hundred pages into a 15-field publishable artefact the user can
   reference (or share via Commons) without re-reading.
3. Drive Goal-Contract-aware personalization (which sparks hit the user's
   specific learn goal, which are antagonistic to it).
4. Serve cheap follow-up queries from the same book without re-running heavy
   harvest. Book Router (§5.3) does this by holding a per-book Spark Index
   + chapter Kernel — distilled once, served many times.

Longform Spark Distillation is the **one-time heavy pass** that produces
those artefacts. It runs over the same chunk shape the Library system
already maintains, so no new ingestion is needed.

## 7-Phase Pipeline

Each phase is a pure function of its inputs (book + prior-phase outputs +
options). Outputs are cached as JSON under
`vault/.distillation/<book-id>/phase-<n>.json`. The runner loads cached
outputs on `resume:true` (default) and skips the LLM call for that phase,
making partial-progress safe.

### Phase 1 — Build Map

Input: book manifest (id, title, author, chunks[]).
Output:

```json
{
  "phase_n": 1,
  "book_id": "<id>",
  "toc": [{ "idx": 0, "title": "...", "type": "argument" }, ...],
  "author_core_question": "<single sentence>",
  "overall_structure": "<2-3 sentence arc summary>",
  "key_chapters": [{ "idx": N, "title": "...", "weight": "high|medium|low" }],
  "generated_at": "<ISO>"
}
```

The TOC mirrors `library.getBookTOC()` for downstream alignment.

### Phase 2 — Chapter Breakdown

Runs sequentially over `book.chunks`. Output is an array of per-chapter
records (no LLM batching — each chapter is its own T6 call). Per chapter:

```json
{
  "chapter_idx": 0,
  "chapter_title": "...",
  "chapter_type": "argument",
  "core_question": "<single sentence>",
  "core_judgments": ["<claim 1>", "<claim 2>"],
  "argument_chain": [{"step": "P1", "text": "..."}, {"step": "C", "text": "..."}],
  "hidden_premises": ["<unstated assumption>"],
  "spark_candidates": [{ "kind": "concept|mechanism|frame", "text": "...", "strength": 0.0-1.0 }]
}
```

### Phase 3 — Cross-Chapter Merge

Input: all phase-2 outputs.
Output:

```json
{
  "phase_n": 3,
  "core_questions": ["<dedup top-K>"],
  "core_mechanisms": [{ "name": "...", "description": "..." }],
  "compressed_views": [{ "view": "...", "evidence_chapters": [1,3,7] }],
  "high_value_sparks": [{ "id": "spark-1", "kind": "concept", "text": "...", "strength": 0.7 }]
}
```

Sparks are strength-sorted; the top 12 carry through to Book Spark Pack.

### Phase 4 — Frontierize

Project the book's mechanisms onto 6 axes Hypha cares about:

```json
{
  "ai_connection": "...",
  "agent_connection": "...",
  "education_connection": "...",
  "product_connection": "...",
  "entrepreneurship_connection": "...",
  "social_structure_connection": "..."
}
```

Goal Contract (when supplied via `options.goal`) tilts the projection toward
the user's stated objective.

### Phase 5 — Reverse Critique

Adversarial pass against phase 3:

```json
{
  "author_overestimated": ["..."],
  "author_underestimated": ["..."],
  "outdated_views": ["..."],
  "rewriteable_for_ai_era": ["..."]
}
```

These flow into Book Spark Pack `anti_sparks` and into Book Router as the
always-on contrarian tail-slot.

### Phase 6 — Personalize

Bind to Goal Contract. Surfaces:

```json
{
  "sparks_hitting_goal":    [{ "id": "spark-1", "why": "...", "confidence": 0.7 }],
  "user_disagrees":         [],
  "product_transferable":   [{ "spark_id": "spark-1", "target_surface": "lesson-opener", "mechanism": "disruption hook" }],
  "action_convertible":     [{ "action": "...", "est_minutes": 25 }]
}
```

### Phase 7 — Book Spark Pack (publishable artefact)

15-field structure (BLUEPRINT §5.2):

1. `book_title`
2. `version`                — semver string (default `0.1.0`)
3. `source_note`            — provenance disclaimer (interpretation, not substitute)
4. `fit_audience`           — 适合人群
5. `recommended_use`        — 推荐场景
6. `primary_value`          — primary value (sourced from phase-1 structure)
7. `chapter_idea_map`       — per-chapter `{chapter_idx, chapter_title, core_question, judgments_summary[]}`
8. `concept_sparks`         — from phase-3 high-value sparks (kind:concept)
9. `mechanism_sparks`       — from phase-3 core_mechanisms
10. `frontier_sparks`       — 6-axis phase-4 projection as `{axis, spark}` array
11. `anti_sparks`           — flattened phase-5 with `{kind, text}` discriminators
12. `transferable_methodology`     — phase-6 `product_transferable`
13. `productizable_inspirations`   — phase-6 derived `{surface, mechanism, source_spark}`
14. `user_personal_sparks`         — phase-6 `sparks_hitting_goal`
15. `risk_and_copyright_note`      — fair-use boundary statement; redaction guidance

## Book Router (§5.3) cache strategy

After phase 7 completes, Book Router serves
`getBookContextPacket(bookId, query, budgetTokens)` without re-reading raw
text or chunks. Cache files used:

| File | Role in packet |
|---|---|
| `phase-1.json` | Identity card header (title + structure + author question) |
| `phase-2.json` | Chapter Kernels (scored against query) |
| `phase-3.json` | High-value sparks (scored + strength-weighted) |
| `phase-5.json` | Anti-Spark tail-slot (always reserved) |
| `phase-7.json` | Book title resolution for header label |

Budget allocation:

- `IDENTITY_CARD_RESERVE = 200 chars`  (always-on header)
- `ANTI_SPARK_RESERVE   = 240 chars`   (tail slot — top anti-spark)
- remainder → chapter Kernels + sparks, packed greedy-by-score

`budgetTokens` default `1500` (≈ 6000 chars at the coarse 4 char/token
heuristic). Per-segment cap = `max(120, 50% of remaining budget)` so a
single very long chapter cannot starve the rest.

## Relationship to neighbouring waves

### vs R-LIB (`app/lib/library.js`)

Library owns raw extraction + chunk storage + keyword retrieval. Distillation
**reads** `getBook()` for chunks and `getBookTOC()` for the section map. It
**does not** rewrite the manifest — distillation outputs live in a sibling
directory (`vault/.distillation/`) keyed by `book.id`.

### vs W6.1 Grounding stream

After distillation completes, the per-book Spark Pack is appended to the
grounding Profile for that book (Profile is keyed by `book_id`). W6.1's
parallel stream consumer prefers `book.contextPacket(bookId, query)` over
raw `library.queryLibrary` when `distill:isDistilled` returns true.

### vs W6.5 Commons stream

Book Spark Pack is the export unit for Commons publication. The `version`,
`source_note`, and `risk_and_copyright_note` fields are pre-formatted for
that purpose. UI surfaces a "公开到 Commons" button on
`screen-book-spark-pack.jsx` that POSTs the pack JSON to the W6.5 publish
endpoint. Pack ownership stays with the user; Commons sees a derivative
record + Source Trust score that consumes our pack metadata.

### vs Goal Contract (System 1)

Phase 4 (Frontierize) and Phase 6 (Personalize) read `options.goal`. When no
Goal Contract is bound to the current vault, both phases still run but emit
generic projections (no `sparks_hitting_goal`, generic frontier mapping).
Re-running phase 6 after a goal change is cheap (`distill:phase`,
`phaseN: 6`) — Phase 1-5 stay cached.

## IPC surface

All handlers in `app/main.js` (search `// W6.2 Distillation`):

| Channel | Args | Returns |
|---|---|---|
| `distill:book` | `{ bookId, goal?, resume? }` | `{ ok, phases, pack, status }` |
| `distill:phase` | `{ bookId, phaseN, goal? }` | `{ ok, phase_n, output }` |
| `distill:status` | `{ bookId }` | `{ ok, status }` |
| `distill:getBookSparkPack` | `{ bookId }` | `{ ok, pack }` |
| `distill:isDistilled` | `{ bookId }` | `{ ok, distilled }` |
| `book:contextPacket` | `{ bookId, query, budgetTokens? }` | `{ ok, packet }` |

Preload bridges expose them at `window.ptor.hypha.distill.*` and
`window.ptor.hypha.book.contextPacket(...)`.

## Failure modes

- **Phase 1 missing chunks** → `phase1: book.chunks required` throw, runner
  writes `error` to `status.json`, emits `distill:error` event.
- **Phase N requires Phase N-1** (manual `distill:phase` call) → explicit
  throw `runPhase: phase N requires phase M cached first`. Forces clean
  re-execution order.
- **Cache corruption** → `_readJSON` returns null, runner treats as not-cached
  and re-runs the phase (idempotent overwrite).
- **Goal Contract changed** → user-driven re-run of phase 6 only via
  `distill:phase`; phases 1-5 unaffected.

## LLM cost shape

- Phase 1: 1 T6_STRONG call.
- Phase 2: N calls (one per chapter). Sequential — Phase 3 needs all of them.
- Phase 3: 1 T6_STRONG call (large prompt — feeds all chapter outputs).
- Phase 4 / 5 / 6: 1 T6_STRONG call each.
- Phase 7: pure assembly, no LLM.

Total: `4 + N` T6 calls per book. For a 12-chapter book ≈ 16 calls. Cached
forever once `status.complete = true`. Re-distill is opt-in via `resume:false`.

## Roll-out

`v0.2`: ship pipeline + cache + Book Spark Pack assembly with mock LLM;
verify end-to-end via smoke (`node -e require('./lib/distillation/...')`).

`v0.3`: replace mock `invokeLLM(phase, payload)` in `phases.js` with
`executeChat('T6_STRONG', {...})` calls and prompt files at
`app/prompts/distill-phase-<n>.txt`. Each phase prompt is hand-written
per the schema above — no auto-derivation.

`v0.4`: wire Book Router into W6.1 grounding stream; lesson harvest prefers
context packet when `isDistilled` is true.

`v0.5`: ship Commons publish path (export-pack-as-Commons-record).
