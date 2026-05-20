# Pack Learning Mode — Specification

> Wave 7.1, surface BLUEPRINT.md §12.4 + §12.5. Theory-ship pass.

Pack Learning Mode is the runtime that turns a community Pack (curated YAML on disk) from an opaque artifact into a knowledge instrument the user actually walks through, applies, forks, and eventually crystallises into their own principle. It is the runtime peer of Wave 6.5's Pack Intelligence Card (PIC, the read surface) — where PIC answers "should I install this," W7.1 answers "now what."

The module is deliberately separated from the Living Note state machine (W5.3) and the Product Spark state machine (W3.4) because the three artefacts have different epistemic shapes and lifecycles. A Pack is an instrument authored by someone else; a Note is the user's raw capture; a Spark is the user's own idea. Conflating them flattens their lifecycles into a generic "thing-with-stages" pattern and forces fake transitions that the user does not actually make.

## 1. Six operations

Each operation is exposed in `app/lib/pack-learning/operations.js` and lifts to IPC at `pack:*`. Every LLM-touching path is mocked at the library level today; the contract is shape-locked so the eventual swap is a one-line change inside each verb.

### previewPack(pack, userContext) → { summary, fit_check, decision_10s, _intelligence_card }

A read-only 10-second triage. Renders the PIC's `primary_value` plus a four-pill fit check (goal match, lesson relevance, difficulty fit, safety). The deterministic verdict bucket is one of `accept-now`, `park-for-later`, or `not-for-you`. No state transition is fired — the caller decides whether to follow up with `Imported → Previewed`.

### quickLearn(pack, options) → { core_value, key_concepts, mechanism, action_items, time_estimate_min }

A 15–25 minute compressed pass over the pack. Key concepts are drawn from the top-of-syllabus KP candidates; the mechanism is a single sentence describing the pack's central move; action items are three concrete next-step micro-tasks. Real implementation routes through `executeChat('T6_STRONG', ...)` (see CLAUDE.md `app/lib/llm/` capability-class router). Today the mock is deterministic so downstream UI surfaces wire against the locked shape.

### deepLearn(pack, options) → { plan, lessons[], _meta }

Wraps a pack into a multi-lesson plan (N = clamp(syllabus.length, 3, 8) by default, or a caller-supplied lesson count). Real implementation will dispatch into `agent.js:designSequence` with the pack's syllabus as the curriculum seed. The mock emits a plan with one lesson per syllabus chapter plus a cadence hint (`sprint` or `multi-week`).

### applyPack(pack, currentProblem) → { applied_solution, evidence_links, _meta }

Binds the pack's lens to a specific user problem. Evidence links are drawn from `pack.recommended_sources` (top 5). The applied solution is a markdown blob with three sections: the user's problem statement, the pack lens applied to it, and a next-step prompt that pushes the user toward a study-note entry.

### forkAndRewrite(pack, options) → { draft_id, draft_path, draft_pack }

Branches a new pack draft owned by the user. The draft lives under `vault/.hypha/pack-forks/<draft_id>/draft.json`. The canonical commons pack remains untouched. License enforcement is W6.5 territory — this verb performs the structural fork only.

### transferToProduct(pack, slug, options) → { routed_to, transfer_result, _meta }

Dispatches into W3.3 `product-transfer.js`. The pack is adapted into the `lessonKP` shape that W3.3's `computeRelevance` expects (title = topic, canonical_example = first KP, thesis = first contested question, definition = first chapter). The returned `routed_to.section` is the W3.3 suggested blueprint section.

## 2. Nine-state machine

```
Imported → Previewed → Learning → Understood
                                ↘ Personalized → Integrated → Productized → Crystallized
                                ↘ Applied → Personalized
                                          ↘ Integrated → Crystallized
```

Eight directed transitions:

| From | To | Trigger |
|------|----|---------|
| Imported     | Previewed    | `previewPack` ran |
| Previewed    | Learning     | user started Quick or Deep Learn |
| Previewed    | Imported     | user declined (decline-and-park edge) |
| Learning     | Understood   | Quick or Deep Learn complete |
| Understood   | Applied      | `applyPack` ran on a current problem |
| Understood   | Personalized | `forkAndRewrite` ran |
| Applied      | Personalized | user re-forked after applying |
| Applied      | Integrated   | applied pack absorbed into a product/work |
| Personalized | Integrated   | the forked pack absorbed |
| Integrated   | Productized  | `transferToProduct` fired with P ≥ threshold |
| Integrated   | Crystallized | distilled into a principle via W5.3 crystallizer |
| Productized  | Crystallized | post-productisation distillation |

`Crystallized` is the only deep terminal. The decline edge `Previewed → Imported` preserves reachability into `Learning` — a parked pack is never trapped at `Previewed`.

State persistence is per-pack: `vault/.hypha/pack-learning/<pack_id>.json`. The directory is global, not slug-scoped, because a user installs the same pack once. Slug context (where the pack was applied) is recorded inside the journal.

## 3. Pack Learning Path

`buildPackLearningPath(pack, userMastery)` folds the syllabus into an N-lesson plan keyed to the user's mastery map. Two adjustments to the deepLearn skeleton:

1. Chapters where mastery < 0.5 bubble to the front of the lesson sequence (floor-first).
2. Chapters where mastery > 0.85 collapse into a single recap lesson rather than a depth lesson.

The Pack Study Note (`vault/<slug>/pack-study/<pack_id>.md`) is the markdown file the user accretes into as they walk through the path. It uses an append-only API (`appendPackStudyNote`); each block is stamped with an italic timestamp eyebrow so the file remains diffable and human-readable. There is no structured JSON sidecar.

## 4. Parking Queue

`vault/<slug>/parking-queue.json` holds a small array of parked pack entries. The queue is per-slug, since the relevance of a parked pack is always evaluated against this slug's running lesson context.

Parking is idempotent on `(slug, packId)`: re-parking refreshes the reason and timestamp but never duplicates the entry. Unparking removes the entry and returns the prior record (so the UI can offer "undo" trivially).

### Revival ranking

`suggestRevival(slug, currentLessonContext, options)` scores parked packs against the running lesson context. The primary signal is cosine similarity via W5.1 `embed-stub.topKSimilar`; when embed-stub is unavailable (lean test environments), the function falls back to a deterministic Jaccard token-overlap. The noise floor is 0.20 — scores below this are dropped to keep the sidebar widget calm. The default top-K is 3.

The lesson-chat sidebar widget (`screen-lesson-chat.jsx`) queries `suggestRevival` on each `lessonBody` change. It is rendered as a single-line dashed-left-border callout below the W5.3 Living Note Reactivation callout. The visual weight is intentionally below Living Note's — a parked pack is a "you put this aside" reminder, not a recommendation. There are no push notifications.

## 5. Boundaries with adjacent waves

- **W6.5 Pack Intelligence Card** — PIC renders at the top of the Pack Learning screen. The 6 operations sit below it. Pack Learning never recomputes PIC fields; it consumes the card as a read.
- **W3.3 Product Transfer Trigger** — `transferToProduct` is a thin adapter that maps a pack into the `lessonKP` shape W3.3 expects and dispatches into `computeRelevance` + `shouldTriggerTransfer`. No relevance logic is duplicated.
- **W3.4 Product Spark** — when a `Productized` pack matures into a recognised product opportunity, the transfer pipeline can spawn a Product Spark. Pack Spark → Product Spark conversion is W3.4's verb; W7.1 only sets up the state pre-condition.
- **W5.1 Cheap Router** — `suggestRevival` calls `embed-stub.topKSimilar` for cosine ranking. When `T1_EMBED` lands the real BGE-M3 wiring, no change is needed at this layer.
- **W5.2 Web Note Engine** — Pack Study Notes are markdown files, not Web Note Engine nodes (yet). A future v0.5 hook can promote selected study-note blocks into atomic nodes, but that is not in scope here.
- **W5.3 Living Note Reactivation** — both modules ship 9-state machines. They look superficially similar but they describe different objects (Pack vs Note), with different terminals (Crystallized for both, but reached via different lifecycles) and different operations (`forkAndRewrite` has no Living Note analogue).

## 6. IPC surface

All verbs are exposed at `window.ptor.pack.*` via the preload bridge. Each handler returns the standard envelope `{ ok: true, ... }` or `{ ok: false, error, message }`. See `app/preload.js` `pack:` block for the renderer-side contract.

## 7. Deferred to later waves

- T6_STRONG real LLM wiring for `quickLearn` / `deepLearn` / `applyPack`. Mocks ship today behind the same shape.
- `forkAndRewrite` does not yet enforce license layer policy — caller (UI) must surface license to the user before invoking. W6.5's license-layer is the authority.
- Pack Pack-Pack-Pack distillation (a Pack derived FROM ratified Crystallized principles, going UP-stream) is a v0.6+ vehicle. The state machine does not currently model that direction; it would be a separate forward-graph attached to `Crystallized`.
- The Library / Commons browser surface that calls `window.__hyphaOpenPack(pack)` to route into Pack Learning is wave-7.1-adjacent UI work, not yet shipped.
