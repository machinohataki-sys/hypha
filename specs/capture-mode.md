# Capture Mode + Finish Ritual (W1.5)

> Authoritative spec for HYPHA's **真实课堂记录** surface and the four-stage
> **Finish Ritual** that turns live capture into a durable Lesson Note.
>
> Aligned with BLUEPRINT.md §9.2 + §9.3, ROADMAP v0.3, and
> `app/lib/pedagogy.md`'s Lacquer Loop. Source code anchors:
> `app/lib/capture-mode.js`, `app/lib/finish-ritual.js`,
> `app/design/screen-capture.jsx`, `app/design/finish-ritual.jsx`.

## 1. Why Capture Mode exists

HYPHA already supports two ingestion paths: PDF/URL/MD upload (Library) and
the in-app Socratic tutor. Neither covers the real-world setting where a
user is **physically present in a classroom**, watching a recorded lecture,
or reading longform offline. In those settings interrupting the user with
chat prompts, regenerate buttons, or Anti-Slop dialogs is hostile.

Capture Mode is HYPHA's **low-interruption** ingestion mode. Per
BLUEPRINT §9.2:

> 上课时只捕捉, 课后才加工。完成记录不是结束, 而是深化开始。

The promise is asymmetric: HYPHA agrees to stay out of the way during the
lecture, but in return the user agrees to honor the **Finish Ritual** after
— a deliberate four-stage transition from raw capture to durable note.

## 2. Trigger scenarios

Capture Mode is entered from Home via the **真实课堂记录** entry button,
or programmatically by any caller invoking `window.ptor.capture.start({
source, context })` with one of three source kinds:

| `source`  | Use case                                            |
| --------- | --------------------------------------------------- |
| `lecture` | Live in-person classroom (default)                  |
| `video`   | Recorded video course playing in another window     |
| `reading` | Longform reading (PDF, book, web article)           |

`context` is a free-form JSON object — typically `{ lecture_title,
course_slug, instructor }` — persisted into `manifest.json` for the Finish
Ritual to surface but never schema-enforced.

Anti-Illusion (W1.3): Capture Mode does NOT fire Anti-Illusion's
exit_proof gate. Anti-Illusion belongs inside a generated Lesson, where
HYPHA owns the curriculum. Capture is the user's own learning event;
HYPHA's role here is stenographer, not interrogator. The Finish Ritual is
where the user's understanding gets evaluated, and even there the gate is
"Human First, Agent Second" rather than apparent-completion detection.

## 3. The 8 mark types

Per BLUEPRINT §9.3 — single-codepoint Unicode glyphs are the source of
truth in both the renderer (`MARKS` constant in `screen-capture.jsx`) and
the backend (`ALLOWED_MARK_TYPES` Set in `capture-mode.js`):

| Glyph | Label   | Cue (when to press)                              |
| :---: | ------- | ------------------------------------------------ |
| `?`   | 不懂    | The current beat went over my head               |
| `!`   | 重要    | This is the line I'd quote afterward             |
| `↗`  | 深化    | I want to follow this thread post-lesson         |
| `⚡`  | Spark   | Cross-domain bridge just lit up                  |
| `×`  | 反驳    | I disagree, want to argue this later             |
| `→`  | 行动    | Action item — I should do something concrete     |
| `🔗`  | 连接    | This links back to something I already know      |
| `🧩`  | 迁移    | Candidate for a product / artifact (W3.3 hook)   |

Hotkeys `1`-`8` map to the eight marks. When the input field has focus the
hotkeys are gated behind Ctrl/Cmd to avoid clobbering numeric typing. The
8 marks are functional ideograms, not decorative emoji — they pass the
constitution's anti-emoji ban under the functional-symbol carve-out.

## 4. Mark for Later vs Deepen Now

`Mark for Later` is the default path — click a mark button (or hit hotkey
1-8) and the entry persists silently into `raw.jsonl` without surfacing a
modal. No interruption to the lecture flow.

`Deepen Now` (Shift+Enter from anywhere on the Capture screen) is the
escape hatch for "I'm stuck **right now** and won't catch the next beat
unless I resolve this." It opens a 30-second short-answer modal — capped
to one sentence. On timer expiry the answer auto-saves as a
`deepen_now` entry. It does NOT expand into a full Lesson; that would
violate the "上课时只捕捉" principle.

## 5. raw.jsonl schema

Each capture session writes to `vault/_captures/<sessionId>/raw.jsonl`,
one JSON object per line, append-only, `fs.appendFileSync` semantics:

```json
{ "seq": 1, "type": "quick_note", "mark_type": null,
  "text": "opening note", "timestamp_offset_ms": 0,
  "wrote_at": "2026-05-13T08:56:06.908Z" }
{ "seq": 2, "type": "mark", "mark_type": "?",
  "text": "what does 'finitude' even mean here", "timestamp_offset_ms": 3400,
  "wrote_at": "2026-05-13T08:56:10.301Z" }
{ "seq": 3, "type": "deepen_now",
  "text": "kant means 'bounded by my own death'",
  "timestamp_offset_ms": 5800, "wrote_at": "2026-05-13T08:56:12.712Z" }
```

Alongside `raw.jsonl` is `manifest.json` with `{ sessionId, source, context,
startedAt, closedAt, entryCount, schema_version }`. Closing the session is
idempotent — `closeCaptureSession(sessionId)` may be called repeatedly.

Individual entries are capped at 4000 chars (longform belongs in Finish
Ritual deepen). The session has no entry-count cap.

## 6. Finish Ritual — 4 stage flow

```
Capture closed
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage 1 — aggregateDrafts(sessionId)                        │
│   - Reads raw.jsonl in seq order                            │
│   - quick_note + deepen_now pass through 1:1                │
│   - Same-mark_type entries within 60s window merge into one │
│     draft (text concat, source_seqs[] extended)             │
│   - Output: drafts[] with earliest/latest_offset_ms + count │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage 2 — parallelDeepen(drafts, ctx)                       │
│   - Promise.all over drafts (no serial waiting)             │
│   - Each mark routed to a per-strategy deepen pass          │
│     (T4_JUDGE, prompt template per mark_type)               │
│   - 🧩 marks also emit a Product Transfer trigger payload   │
│   - Failure of one deepen never poisons sibling deepens     │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage 3 — userCoreUnderstandingFirst(sessionId, sentence)   │
│   - HARD BLOCK: user must type ≥ 8 chars                    │
│   - Anti-paste: rejects verbatim duplicates of any capture  │
│   - Caps at 500 chars (one sentence)                        │
│   - Principle: Human First, Agent Second                    │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Stage 4 — generateLessonNote (+ side products)              │
│   - Builds depositLessonNote() payload from drafts+userCore │
│   - REUSES lesson-note.js, never reimplements               │
│   - Returns: lessonNotePath, evidence, masteryUpdates,      │
│              productTransferTriggered, drafts, deepened     │
│   - Side-writes vault/_captures/<sessionId>/finish-ritual.  │
│     json sidecar (structured audit trail)                   │
│   - Hands off to W5.2 Web Note Engine downstream            │
└─────────────────────────────────────────────────────────────┘
```

### Stage merge window

Per-mark merge uses a 60_000 ms (`MERGE_WINDOW_MS`) window between
consecutive same-mark_type entries. The merge is **local** — we only look
at the most recent draft of the same type, never a global cluster pass.
Greedy global merge would lasso unrelated streaks together; locality
keeps the user's mental timeline intact.

### Stage 2 deepen strategies

| Mark | Strategy kind         | What the deepen returns                         |
| ---- | --------------------- | ----------------------------------------------- |
| `?`  | resolve_confusion     | One paragraph that resolves the confusion       |
| `!`  | compress_importance   | One sentence + why-it-matters                   |
| `↗` | followup_questions    | A pair of follow-up questions (no answers)      |
| `⚡` | cross_domain_bridge   | The Spark connection named explicitly           |
| `×` | sharpen_contradiction | Both sides of the disagreement, no ruling       |
| `→` | action_item           | verb + object + deadline                        |
| `🔗` | prior_anchor          | Named anchor + relation type                    |
| `🧩` | product_transfer      | Product Transfer trigger payload (W3.3)         |

The T4_JUDGE LLM call is currently a `[MOCK]` stub — it returns
deterministic, easy-to-spot mock text so that any leak into production
output is loud. The swap to `executeChat('T4_JUDGE', { … })` from
`app/lib/llm/router.js` is one-line: `deepenOne()` in `finish-ritual.js`
keeps the drafts-in / deepened-text-out contract.

## 7. Cross-stream boundaries

| Adjacent stream                | Interaction                                         |
| ------------------------------ | --------------------------------------------------- |
| **W1.3 Anti-Illusion**         | Capture does NOT trigger exit_proof. Anti-Illusion belongs in generated Lessons, not real-world capture. |
| **W3.3 Product Transfer**      | Stage 2 emits a Product Transfer trigger for every 🧩 mark. The Product Pool consumer (W3.3) reads `productTransferTriggered[]` from the ritual result. |
| **W4 Mastery Map**             | `result.masteryUpdates` is an `{ deferred_to: 'W4', concepts_touched: [] }` placeholder. The IPC contract is stable so the W4 wire-in is additive. |
| **W5.2 Web Note Engine**       | After Stage 4 commits, the renderer routes into NotebookScreen pointing at the new lesson note. W5.2 takes over typed-edge graph + Living Note Reactivation from there. |

## 8. UX contract

- Capture screen header: timer + source label + the brass-bright
  **完成记录** button (state-switch, not save).
- The 8 mark buttons are a 4×2 grid below the input. Each shows glyph +
  label + hotkey hint.
- The Recent list shows only the last 5 entries — no edit, no delete.
  Mistakes resolve in Finish Ritual.
- ESC during capture surfaces a confirm modal ("确认结束并保存吗?") so
  we never silently lose data.
- Finish Ritual shows a four-step indicator at the top. Stage 1 + 2 are
  short visible-labor animations (~700ms each) so the user perceives a
  ritual, not a black box. Stage 3 is a blocking text input. Stage 4 is
  a result panel that auto-routes to the new note after a beat.

## 9. Non-goals (deferred)

- **Per-stage LLM streaming** — the current Finish Ritual has a single
  IPC round-trip. Stage-by-stage progress events are a v0.4+ wire-in
  along with the real T4_JUDGE deepen.
- **Quality Harness / Anti-Slop on captured notes** — the captured note
  is by definition the user's own learning event; we do not gate it
  through the Lesson System's Confession / Prosecutor / Auditable
  Reasoning checks. Those layers live on top of HYPHA-generated content.
- **Semantic merge across mark types** — the 60-second local merge is
  intentionally narrow. Embedding-based cross-type merge belongs in W5.2
  Web Note Engine where the graph layer exists.
- **Multi-user / collaborative capture** — single-user only. Course-level
  collaboration is Pack Commons (System 6, v2.0+).
