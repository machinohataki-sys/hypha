# Living Note Reactivation — Spec

> BLUEPRINT §10.2 · ROADMAP v1.3 · Wave 5.3
>
> *"Do not review notes. Call them."* — A note is "alive" when the system
> surfaces it inside a real cognitive scene (lesson / writing / decision /
> conflict), not when the user opens a flashcard popup. The point of this
> stream is to make each note's *call-site* explicit, ranked, and revocable.

## 1. The 9 Life States

Every `.md` note carries a `life_state` frontmatter key. Default on creation:
`Dormant`. Transitions are whitelisted and audit-logged in
`state_history_entry:` rows.

| State | Meaning | Typical entry trigger |
|---|---|---|
| **Dormant** | Exists on disk, not in active thought | Initial creation / no recent touch |
| **Active** | Mentioned in the last lesson / chat / draft | Reactivator surface clicked, capture session, edit |
| **Useful** | Credited with at least one decision_followed event | `addDecision` references it |
| **Crystallized** | Re-used across ≥ 3 lessons → promoted to principle/etc. | `crystallizeNote` succeeds |
| **Operational** | Folded into a checklist / workflow the user runs | User adds to workflow surface |
| **Productized** | Cited in Product Blueprint / shipped artifact | W3.1 Creation Pool `linkNote` |
| **Outdated** | Stale clock, no new evidence | Cure clock timeout (Dormant > 180d) |
| **Contradicted** | New evidence (frontier / lesson / source) flatly disagrees | Source-trust drop / conflict_detected scene |
| **Archived** | User-archived. Reversible only via Active. | Dead-Note Detector + user confirm |

### Transitions (whitelist)

```
Dormant      → Active | Outdated | Archived
Active       → Useful | Dormant | Contradicted | Outdated
Useful       → Crystallized | Operational | Dormant | Contradicted | Outdated
Crystallized → Operational | Productized | Contradicted | Outdated
Operational  → Productized | Outdated | Contradicted
Productized  → Outdated | Contradicted          (no demotion to lower states)
Outdated     → Archived | Active                (re-validated)
Contradicted → Archived | Active                (re-resolved)
Archived     → (terminal; user gesture writes the new state directly)
```

Illegal moves throw — no silent no-ops. Each transition appends an audit row:

```
state_history_entry: {"ts":"2026-05-13T...","from":"Useful","to":"Crystallized","reason":"crystallization"}
```

## 2. Utility Score (8 factors)

Pure function, no fs. Caller aggregates factor values from `event-log.js`
and the note's frontmatter, then asks `computeUtilityScore(data)`.

| Factor | Weight | Type |
|---|---:|---|
| `helped_lesson_count` | +10 each | count |
| `helped_decision_count` | +15 each | count |
| `produced_action_count` | +12 each | count |
| `cited_count` | +5 each | count |
| `sparked_count` | +8 each | count |
| `reduced_understanding_cost` | +10 | boolean |
| `influenced_product` | +15 | boolean |
| `outdated_penalty` | -30 | boolean |

Result clamps to `[0, 100]`. Sums below zero → 0.

### Where the score is consumed

- **Crystallization gate** — `score ≥ 80 AND state = Useful AND cited ≥ 3`.
- **Dead-Note detector** — `score < 20` is one of four conjunctive conditions.
- **Reactivation ranker** — breaks semantic-similarity ties: a Crystallized
  note edges out a Dormant one at the same cosine.
  Combined rank = `relevance × 0.7 + (utility / 100) × 0.3`.

## 3. Scene-triggered Reactivation (8 scenes)

| Scene | Trigger | Anchor text (queryText) |
|---|---|---|
| `lesson_active` | LessonChat mounts with lesson body | thesis + canonical_example + mechanism |
| `writing` | Capture surface entry | draft body |
| `product_decision` | Product Pool `addDecision` form open | decision draft |
| `conflict_detected` | New evidence vs older claim | new evidence snippet |
| `action_planning` | Assignment / roadmap drafting | action description |
| `exam_prep` | Feynman test / Final Compression mode | scope item |
| `pack_generation` | Knowledge Pack export draft | pack title + abstract |
| `product_pool_planning` | Product blueprint / roadmap-sync update | section being edited |

### Algorithm

1. Embed `queryText` via W5.1 Cheap Router (BGE-M3 stub → bag-of-words
   fallback when stub unavailable).
2. Scan vault `<slug>/*.md`, parse frontmatter.
3. Filter by `life_state ∈ {Dormant, Useful, Crystallized, Operational}`.
   Skip `Archived` / `Outdated` / `Contradicted` — those re-enter only by
   explicit user gesture.
4. Compute cosine between query vector and each note's bag-of-words.
5. Keep notes with `relevance ≥ 0.6` (threshold tunable per scene later).
6. Sort by combined rank (utility breaks ties).
7. Return top-k (default 8) with a scene-shaped human reason.

### Side-effect contract

`findReactivationCandidates` is **side-effect-free**. It does *not* fire a
state transition. The caller (UI hook in `screen-lesson-chat.jsx`) only
transitions a note Dormant → Active when the user actually clicks the row.
Surfacing alone is not promotion — a note that the user ignores stays Dormant.

## 4. Dead-Note Detector

A note is **dead-suspect** when all four hold:

1. `life_state == Dormant`
2. age since last touch > 90 days
3. `utility_score < 20`
4. zero outgoing edges — no `[[wikilink]]` and no W5.2 typed-edge
   `→ note: <path>` line

Age source priority:
`fm.last_touched` → `fm.life_state_updated` → `fm.last_updated` → file mtime.

Output rows carry a `deadness_score 0..100`:

```
deadness = round((min(age/365,1) × 0.6 + (1 - utility/20) × 0.4) × 100)
```

Higher = deader. Sorted descending. Surfaced in `DeadNotesScreen` for
audit; archive = move to `vault/<slug>/.archive/`. **Archive ≠ delete.**
A user can manually move the file back, or call `transitionNoteState
(Archived → Active, reason: "user_unarchived")`.

`archiveDeadNotes(slug, dryRun=true)` defaults to dry-run; flip to false
to actually move. UI always confirms first.

## 5. Crystallization (6 target types)

When a note clears the gate (`score ≥ 80 AND state = Useful AND cited ≥ 3`)
the user can crystallize it into one of six denser forms:

| `targetType` | Shape | Read by |
|---|---|---|
| `principle` | Claim + example + counter-case | Hypha lessons / Anti-Slop layer |
| `checklist` | 5-9 imperative bullets | Operational workflows |
| `workflow` | Ordered phases with entry/exit criteria | Operational workflows |
| `template` | Slot schema + 1 example fill | Lesson body generator |
| `product_principle` | Claim + product implication | W3.1 Creation Pool blueprint |
| `roadmap_item` | Title + acceptance criteria + week | W3.1 roadmap-sync |

Crystallization writes **a new note** at `vault/<slug>/.crystal/`. Source
note transitions Useful → Crystallized. Both files remain — the crystal
is the *interface*; the source remains the *receipt*.

LLM call uses T6_STRONG. Tests inject `_t6Shim` to stay fs-only.

## 6. Cross-Wave Boundaries

### W5.2 Web Note Engine (parallel stream)

- Living Note **consumes** `dead_node_detected` events that W5.2 emits on
  topological graph walks (notes with no incoming or outgoing typed edges).
- Living Note **uses** `walkGraph(seed, depth=2)` to add topological
  candidates on top of semantic candidates — same note showing up via
  both channels strengthens its rank.
- Living Note **does not** rewrite W5.2 graph nodes. State changes live in
  frontmatter only.

### W5.1 Cheap Router

- Living Note **uses** `embed(text)` for semantic relatedness in the
  reactivator. Falls back to bag-of-words cosine when the BGE-M3 stub is
  unavailable. Same fallback used by W5.2.
- All reactivation queries are T1_EMBED tier — no T6_STRONG calls except
  the crystallizer.

### W3.1 / W3.4 Creation Pool

- `linkNote(slug, notePath, ...)` is the trigger for Useful → Productized.
- Sparks promoted past `implemented` (W3.4 terminal state) cause the
  linked note to enter Productized; Product Transfer reads `life_state ==
  Productized` to set its transfer probability `P = 1.0`.

### W2.1 Cadence Engine

- Cadence's `reviewNodesDue` is the trigger for Dormant → Active when the
  scheduler picks notes for the next lesson's prior-review paragraph.
- A note's state at lesson start is recorded in the cadence ledger so the
  rest-vs-review decision can prefer Useful/Crystallized over Dormant.

## 7. IPC Surface

All seven verbs return the standard hypha envelope. Bound at
`window.ptor.livingnote.*`:

```
livingnote:state                                   → { states, transitions }
livingnote:transition  (nodePath, fromState, toState, reason) → { from, to, ts }
livingnote:utility     (noteData | { notes, k })   → { score, factors } | { ranked }
livingnote:reactivate  (slug, scene, opts)         → { scene, candidates[] }
livingnote:detectDead  (slug)                      → { dead[] }
livingnote:archive     (slug, dryRun, paths)       → { dryRun, archived[], skipped[] }
livingnote:crystallize (slug, noteId, targetType, opts) → { newNotePath, type, structured_content }
```

## 8. UI Touchpoints

- `screen-lesson-chat.jsx` — `useEffect` on lesson body load fires
  `reactivate(slug, 'lesson_active', { queryText })`. Renders an inline
  brass callout under `<ChainHeader />` with up to 3 candidates. Clicking
  routes to NotebookScreen for the candidate. No modal. Low visual weight.
- `screen-notebook.jsx` — top bar adds "死亡笔记审查" button (between
  spacer and map toggle) that routes to DeadNotesScreen for the current slug.
- `screen-dead-notes.jsx` — list of dead-suspect notes with checkbox +
  per-row archive + batch archive + dry-run preview. Archive ≠ delete:
  the file moves to `.archive/`, restorable by the user any time.

## 9. Anti-patterns (do not do)

- **Do not** flash a modal when a note reactivates. The whole point is
  call-site surfacing, not flashcard interruption.
- **Do not** transition Dormant → Active silently on render. The user
  must click the candidate to confirm engagement.
- **Do not** delete dead notes. Move only. Even Archived is reversible.
- **Do not** crystallize without the gate. A note that fails the gate
  produces a low-value crystal that poisons the workflow surface.
- **Do not** rank reactivation candidates by recency. Use semantic +
  utility — recency is already encoded in state (Dormant > 30d demotes).
