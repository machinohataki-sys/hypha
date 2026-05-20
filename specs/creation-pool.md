# Creation Pool — Spec

> Stream: W3.1 Creation Pool framework (BLUEPRINT §11.1-11.8 + ROADMAP v0.7).
> Status: framework shipped 2026-05-13. Body editor + spark state machine + Companion suggestions are downstream streams (W3.2 / W3.4 / W3.5-W3.6).

## What this is

The Creation Pool (long-form name: Product Pool) is **the user's current creation, made cognitively explicit**. It is not Trello, not Notion, not GitHub Issues. It is the container where Hypha holds whatever a learner is **building right now** so every lesson and note has a target to pull toward. One Goal binds one Product. One Product per slug.

Hypha's "private university + creation studio" thesis depends on this layer: lessons that aren't converging toward a real product become abstract drills; products built without a learning spine become superstition. The pool is the seam.

## 10 product types

The same framework powers ten domains. Type is declared at bind time and stored in `product/blueprint.md` frontmatter as `product_type:`. New types are an additive change to the enum in `app/lib/creation-pool-schema.js`; existing pools are never auto-re-typed.

| Type | Domain |
|---|---|
| `product` | SaaS / consumer / hardware — the canonical case |
| `thesis` | academic thesis / dissertation |
| `novel` | fiction / serialized writing |
| `research` | research program, not a single paper |
| `website` | marketing / personal / portfolio site |
| `course` | a course the user is BUILDING (distinct from learning) |
| `personal_brand` | ongoing identity work — Twitter / Substack / talks |
| `opensource` | OSS library / framework / tool |
| `business` | business plan / company / venture |
| `exam_prep` | long-arc preparation for a specific exam |

## File layout

For `slug = hypha`, vault layout is:

```
vault/hypha/
├── state.json                       # curriculum (existing, untouched)
├── lesson-0.md ... lesson-N.md      # lessons (existing, untouched)
├── events.jsonl                     # typed event log (existing, W2.4)
└── product/
    ├── blueprint.md                 # 10-section frame (frontmatter + headers)
    ├── decision-log.jsonl           # append-only, §11.5
    ├── assumption-ledger.jsonl      # append-only, §11.6
    ├── kill-criteria.json           # mutable snapshot, §11.7
    ├── roadmap-sync.json            # mutable queue, §11.8
    ├── inspiration-pool.jsonl       # links: lesson/note/pack/book/research
    ├── evaluation-log.jsonl         # kill-criteria evaluation history
    └── sparks/                      # W3.4 owns body — directory only here
```

## blueprint.md

Markdown with YAML frontmatter + 10 section headers. The frame is locked here; section bodies are filled by W3.2 (UI editor) and by automated linkers (W3.3 Transfer / W3.4 Spark).

Frontmatter fields (read by `getProduct`):

- `product_name` — display name
- `product_type` — one of the 10 types above
- `north_star` — single sentence success metric
- `bound_at` — ISO ts at bind time
- `last_updated` — ISO ts, refreshed by every ops mutation
- `slug` — the curriculum slug this product is bound to
- `version` — frame schema version (currently 1)

Section order (also read by W3.2 auto-fill):

1. 产品蓝图 — one-liner + paragraph + key screenshot positions
2. 核心问题 — what real pain the product addresses
3. 用户痛点 — concrete scenarios + current substitutes
4. 北极星指标 — single measurable success criterion
5. 设计原则 — non-negotiable tradeoffs
6. 功能模块 — current + roadmap modules
7. 未验证假设 — pointer into `assumption-ledger.jsonl`
8. 灵感池 — pointer into `inspiration-pool.jsonl`
9. 风险清单 — known threats + mitigations
10. 路线图 — pointer into `roadmap-sync.json`

## Ledger schemas

### decision-log.jsonl (§11.5)

One row per product-level decision. Distinct from `events.jsonl`: this is the user's decision archaeology, not the system's behavior log. Append-only.

Required fields per row: `id` (`d-<unixMs>-<rand>`), `ts`, `decision_text`, `background`, `basis`, `opposing_views`, `final_choice`, `follow_up_needed`.

Optional: `linked_lesson_idx`, `linked_note_rels`, `linked_assumption_ids`, `verdict_confidence`.

### assumption-ledger.jsonl (§11.6)

Lean-Startup hypothesis tracker. Distinguishes "we believe X" from "we verified X". Append-only — `updateAssumptionStatus` writes a NEW row carrying the updated `status` plus `status_updated_at`. Readers resolve "current status for id" by scanning forward.

Required fields: `id` (`a-<unixMs>-<rand>`), `ts`, `assumption_text`, `status` (`unverified | verifying | verified | refuted`), `verification_method`, `deadline`.

Optional: `status_updated_at`, `evidence_links`, `linked_decision_ids`, `confidence_pre`, `confidence_post`.

### kill-criteria.json (§11.7)

Single JSON file (not jsonl) — criteria are live and `current_value` mutates. `evaluateKillCriteria` writes a snapshot to `evaluation-log.jsonl` for history.

Shape: `{ criteria: [criterion], last_evaluated, would_kill_now }`.

Each criterion: `{ id, description, threshold: { metric, op, value }, current_value, would_kill, created_at, last_checked_at, severity }`. `op` must be one of `< | <= | > | >= | == | !=`.

### roadmap-sync.json (§11.8)

Weekly suggestions from Companion agents + manual flows, plus a processed queue.

Shape: `{ weekly_suggestions: [suggestion], processed: [id], last_synced_at }`.

Each suggestion: `{ id, ts, items, priority (1|2|3), source_agent? }`. Items are `{ kind, text, source }` triples; shape is intentionally loose so W3.5/W3.6 can encode any suggestion type without schema churn.

### inspiration-pool.jsonl

Append-only links from learning artifacts to the product. One row per link event.

Required: `ts`, `source` (prefix-typed: `lesson:<idx>` / `note:<rel>` / `pack:<id>` / `book:<id>` / `research:<id>`), `relevance` (0..1), `source_summary`.

Optional: `tags`, `linked_module_id`, `linked_section_id`, `pinned`.

## API surface (`app/lib/creation-pool.js` + `creation-pool-ops.js`)

Framework (`creation-pool.js`):

- `bindProduct(slug, productConfig)` — initialize `product/` for a slug. Idempotent: rebind never clobbers existing files. Returns `{ ok, slug, product_dir, ..., created: {file: bool} }`.
- `getProduct(slug)` — read frontmatter + cheap ledger metadata. Returns `{ ok, product_name, type, north_star, bound_at, last_updated, decision_count, hypothesis_count, assumption_status_counts, inspiration_count, spark_count, version }`.
- `isProductBound(slug)` — boolean existence check on `product/blueprint.md`.
- `linkLessonToProduct(slug, lessonIdx, relevance, sourceSummary)` — append to `inspiration-pool.jsonl` as `lesson:<idx>`.
- `linkNoteToProduct(slug, notePath, relevance, sourceSummary)` — append as `note:<rel>`.
- `linkPackToProduct(slug, packId, relevance, sourceSummary)` — append as `pack:<id>`.

CRUD ops (`creation-pool-ops.js`):

- `addDecision(slug, decision)` — append to decision-log.
- `addAssumption(slug, assumption)` — append to assumption-ledger.
- `updateAssumptionStatus(slug, id, status, evidence)` — append a status-update row (append-only invariant preserved).
- `addKillCriterion(slug, criterion)` — push criterion into kill-criteria.json.
- `evaluateKillCriteria(slug, currentMetrics)` — walk criteria, set `current_value` + `would_kill`, snapshot to evaluation-log.
- `appendRoadmapSync(slug, weeklyItems, priority, sourceAgent)` — push a fresh weekly suggestion block.

All mutating operations require the product to be bound (`isProductBound`); otherwise return `{ ok: false, reason: 'not_bound' }`. Fail-fast, never silently create.

## IPC surface

Renderer access via `window.ptor.creation.*` (preload.js):

- `bind / get / isBound` — framework lifecycle
- `linkLesson / linkNote / linkPack` — three link variants
- `addDecision / addAssumption / updateAssumption` — ledger writes
- `addKillCriterion / evalKillCriteria` — kill-criteria lifecycle
- `syncRoadmap` — Companion entrypoint
- `onNotBound(cb)` — subscribes to `creation:not-bound` event emitted by `curriculum:create` after a fresh course lands without a product

Main handlers: `creation:bind`, `creation:get`, `creation:isBound`, `creation:linkLesson`, `creation:linkNote`, `creation:linkPack`, `creation:addDecision`, `creation:addAssumption`, `creation:updateAssumption`, `creation:addKillCriterion`, `creation:evalKillCriteria`, `creation:syncRoadmap`.

## Event emissions

Every mutation writes a typed event to `vault/<slug>/events.jsonl` via the W2.4 validator (`app/lib/events.js`):

- `product_bound`
- `product_inspiration_linked`
- `product_decision_added`
- `product_assumption_added`
- `product_assumption_status_changed`
- `product_kill_criterion_added`
- `product_kill_evaluation`
- `product_roadmap_synced`

Companion agents subscribe to these via `events.read(slug)` to power their suggestion + nudge logic.

## Integration with curriculum:create

When `curriculum:create` finishes successfully and the slug is not bound to a product, main emits `creation:not-bound { slug }` on the calling WebContents. The renderer's `LessonChat` registers a `creation.onNotBound` subscriber (handled in the W3.2 UI prompt). The integration point is +15 lines in `app/main.js` immediately after the existing handler returns its result; the auto-fire body generation flow is unaffected.

## Boundaries with W3.x parallel streams

- **W3.2 Product Blueprint** — owns the blueprint.md body editor. Reads via `creation:get`, writes blueprint sections via direct `vault.write` (this stream gives W3.2 the section IDs + frontmatter contract; W3.2 does not need a new IPC).
- **W3.3 Product Transfer** — calls `creation:linkLesson` on every lesson finish ritual when a product is bound. Mapping logic (relevance scoring + source_summary distillation) is W3.3's responsibility; this stream provides the persistence sink.
- **W3.4 Product Spark** — owns the spark state machine and `product/sparks/*.md` body. This stream creates the `sparks/` directory at bind time and exposes the spark lifecycle enum (`captured | incubating | tested | promoted | discarded`) via the schema module for cross-stream consistency.
- **W3.5 / W3.6 Companion** — monitor `events.jsonl` rows prefixed `product_*` and append weekly suggestions via `creation:syncRoadmap`. Companion agents never write directly to the ledgers; they go through the ops surface so every write is event-stamped.

## Verification

The framework was smoke-tested on a temp vault (`mkdtemp` + bind + every ops fn): 36 assertions passed including rebind-idempotency, append-only ledger preservation across status updates, kill-criteria threshold flip at both directions, and not-bound guards on every ops call. Unit test scaffolding is in `__tests__/creation-pool.test.js` (12+ test.todo placeholders for the test runner phase).

## Out of scope

- LLM calls (this stream is pure fs)
- Companion suggestion content (W3.5)
- Spark state transitions (W3.4)
- Blueprint section body editing (W3.2)
- Pricing / monetization hooks (deferred to v0.8+ Founders integration)

Future stream that wires `linkBookToProduct` / `linkResearchToProduct` will extend the `INSPIRATION_POOL_SCHEMA.source_prefixes` enum without breaking existing rows.
