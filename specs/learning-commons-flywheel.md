# Learning Commons Flywheel — Spec (W8.2 · BLUEPRINT §20 v2.5)

> Status: lib-only (v0.2 surface tranche). Real PR publishing remains user-driven; W8.2 ships the local staging primitives + cycle/health metric layer.

## 1. Why the Flywheel Exists

Hypha's defensibility is not the LLM call — it is the compounding loop where every minute a user spends learning produces public-facing assets that improve the next user's lesson. Step zero of that loop is **the user's own Note**; step infinity is **a stranger's better Lesson**. Without all four hops wired, Hypha is just another tutor. With all four wired, it is the public-university-substrate the project's WHY describes.

The §20 v2.5 flywheel:

```
User Learning
  → Note
  → Product Spark
  → Pack / Book Spark Pack / Product Blueprint Template
  → Commons
  → Scoring / Index
  → Enters Lesson
  → Improves other users' learning
  → Produces better Note + Work
```

Each step is a one-way valve — when a Note crosses the bar to Spark, it does not pause; when a cluster crosses the bar to Pack, the artifact is generated even before the user clicks publish. This way the user always sees what the next hop would look like, not just what the current state contains.

## 2. Four Steps + Five Modules

| # | Step | Module | Responsibility |
|---|---|---|---|
| 1 | Note → Spark | `app/lib/flywheel/note-to-spark.js` | Score notes against W5.3 utility + W7.5 life-state + age + cited; propose qualified ones as W3.4 Spark seeds |
| 2 | Spark → Pack | `app/lib/flywheel/spark-to-pack.js` | Cluster Sparks by affected_module or accepted+ count; convert Blueprints into reusable templates; promote W6.2 Book Spark Packs to public candidates |
| 3 | Pack → Commons | `app/lib/flywheel/pack-to-commons.js` | Render YAML, scan via W6.5 security-layer, license-check via W6.5 license-layer, stage locally; emit a PR-ready commit message |
| 4 | Commons → Lesson | `app/lib/flywheel/commons-to-lesson.js` | Discover relevant Commons packs (staged + curated), rank, inject as `COMMONS HINTS` block ahead of `LIBRARY_EVIDENCE` in `designSkeletonOnly` |
| ∑ | Cycle + Health | `app/lib/flywheel/feedback-loop.js` | One-shot observer that runs steps 1-4 in dry-run mode and reports a metric tuple + 0-100 health score |

## 3. Step 1 — Note → Spark Eligibility

A note is **eligible** if and only if all four of the following pass:

| Rule | Threshold | Source |
|---|---|---|
| `utility_score >= 70` | W5.3 `computeUtilityScore` | `app/lib/living-note/utility-score.js` |
| `life_state ∈ {Useful, Crystallized}` | W7.5 lifecycle | `app/lib/living-note/states.js` |
| `age_days >= 7` | created_at frontmatter | `note.created_at` |
| `cited_count >= 2` | decision_followed events | `note.cited_count` frontmatter |

**Degrade-open posture.** If any upstream lib is unloadable in the current environment (test harness, dry-run, pre-v0.4.x boot), the missing signal is treated as **neutral pass** with a `[DEGRADED]` reason tag rather than blocking the whole flywheel. Each evaluation surfaces `reasons[]` so the UI renders a transparent funnel rather than an opaque verdict. This is intentional — see CLAUDE.md §METHOD-3 (EVIDENCE) regarding hedging without a tag.

`batchNoteToSpark(slug)` walks `vault/<slug>/lesson-*.md`, runs `evaluateNoteForSpark` on each, and returns `{ eligible: [...], ineligible: [...], scanned }`. The UI shows both lists so the user can audit borderline rejections.

`proposeNoteToSpark(slug, notePath)` constructs a Spark seed payload (`source.type='note'`, frontmatter-derived `core_transfer`, kebab `conceptId` ref) and calls W3.4 `createSpark`. When `productSpark` is unavailable, it returns a `dryRun: true` envelope so test harnesses inspect the payload without a vault write.

## 4. Step 2 — Spark → Pack Eligibility

A spark cluster is **eligible** if **either** rule passes:

| Rule | Threshold |
|---|---|
| A — same `affected_module` count | `>= 5` |
| B — `state ∈ {accepted, implemented}` count | `>= 3` |

The cluster's top module becomes the pack title anchor (`Spark cluster: <module>`). Sparks that disagree on module are kept in the payload but flagged in `_meta`.

Two adjacent transforms live in the same module because they share the Pack YAML renderer:

- `proposeProductBlueprintTemplate(slug)` — reads `vault/<slug>/product/blueprint.md`, parses via W3.2 `parseBlueprint`, strips slug-specific identifiers, ships the section skeleton as a reusable `pack_kind: 'blueprint-template'`. If no blueprint exists, an empty section skeleton (from `emptySections()`) ships — a user can fork the empty template and fill it in.
- `proposeBookSparkPackPublic(bookId, slug)` — searches three conventional W6.2 locations (`library/spark-packs/<bookId>.json`, `library/spark-packs/<bookId>/pack.json`, `book-spark-packs/<bookId>.json`) and wraps the found pack as `pack_kind: 'book-spark-pack'` with provenance preserved (`source_path`).

All three outputs share the same pack-skeleton schema (key/list YAML, `schema_version: 1`) so Step 3 can stage any of them without per-source translation.

## 5. Step 3 — Pack → Commons (Local Staging)

`publishPackToCommons(pack, options)` is asynchronous and writes to `<staging-root>/<topic>/<lang>/`. The root resolves in order:

1. `process.env.HYPHA_COMMONS_STAGING_DIR` (test harness override)
2. `os.homedir()/.hypha/commons/staging/` (default)

Three files land in the target dir:

- `pack.yaml` — the pack body, ready for a future PR
- `COMMIT_MESSAGE.txt` — multi-line conventional-commits message (`commons(<topic>/<lang>): add "<title>" by <author>`)
- `manifest.json` — `{ pack_id, topic_slug, lang, pack_kind, title, author, license, staged_at, blocked, scan_level }` — read by `listStagedPacks()` without re-parsing YAML

The W6.5 security scan (`scanPack`) and license parse (`parseLicense`) run on the staging dir contents. A scan that surfaces `banned_files` or a safety level of `block`/`unsafe` sets `blocked: true` and propagates to `{ ok: false, blocked }`. The YAML is still written so the user can inspect and decide whether to override — silently dropping a blocked draft would violate the IRON_LAW (no comfortable omissions).

**Real PR upload stays user-driven.** This module does not invoke `git`, does not push, does not generate signed commits. The staged dir is the contract; everything beyond is a human gate.

`listStagedPacks()` walks the staging root and returns manifests. `unstagePack(packId)` removes the matching dir (`fs.rmSync` recursive). No archive — once unstaged, the user can re-run publish.

## 6. Step 4 — Commons → Lesson

`findRelevantCommonsForLesson(slug, lessonTopic, opts)` is the discovery primitive. It gathers packs from two sources:

- **Staging** (via `pack-to-commons.listStagedPacks`) — user's own in-flight work, biased toward their topics
- **Curated** (`app/lib/commons-packs/`) — pre-existing high-trust packs the team curates (W6.x baseline)

Blocked staging packs are filtered out. The remaining set is ranked by:

1. W6.5 `pack-intelligence-card.rankPacks(packs, { ...userContext, topic })` when loadable — full Quality × Stability × Difficulty × Cognitive-Load score.
2. **Fallback** — token-overlap cosine on `(title + topic_slug)` vs `lessonTopic`. The fallback is intentional and surfaced in `source: 'token-overlap-fallback'` so the UI can warn the user that W6.5 isn't engaged.

`injectCommonsIntoLessonPrompt(lessonContext, packs)` renders a `COMMONS HINTS` block matching the structural register of the existing `LIBRARY_EVIDENCE` block in `agent.js:designSkeletonOnly`. Empty when there are no packs — the prompt diff is zero in that case. When non-empty, it is **prepended** ahead of grounding profile + library evidence so the LLM sees public peer Lessons before any private chunk evidence. Citation policy is stated in the block itself ("Treat each as a peer Lesson designed elsewhere. Cite if you draw on it. Never duplicate.").

## 7. Cycle + Health Score

`runFlywheelCycle(slug, opts)` runs all four steps in **observational mode** — no mutations — and returns a metric tuple:

```
{
  notes_eligible_count,
  sparks_proposed,
  packs_proposed,
  packs_published,    // unblocked staged packs
  commons_consumed_in_lesson  // top-K count for the sample topic
}
```

`getFlywheelHealth(slug, opts)` normalizes those five into a 0-100 score:

```
health = 0.20 · norm(notes_eligible,    0..20)
       + 0.20 · norm(sparks_proposed,   0..10)
       + 0.20 · norm(packs_proposed,    0..5)
       + 0.20 · norm(packs_published,   0..3)
       + 0.20 · norm(commons_consumed,  0..5)
```

`norm(x, cap) = min(1, x/cap) × 100`. Caps reflect quarterly cadence for a single user, not a fleet — a healthy individual ships ~3 packs per quarter, not 30. Caps live in `HEALTH_CAPS` and can be tuned per user-tier later without changing the score function.

The score is **diagnostic**, not gatekeeping. A user can route through Lesson generation even when health is 0 (the flywheel just hasn't started turning yet). The UI surfaces the score as a Gauge with the five component bars beneath so the user sees which hop is starved.

## 8. Boundaries — what this Wave does NOT touch

- **W1-W7 source files.** Every interaction is import-only; no W3.4 / W6.2 / W6.5 / W7.x file gets a single byte modified.
- **Other W8 streams.** W8.3 Adaptive UX Forks and W8.4 Cashflow Shield live in their own subtrees. No cross-Wave coupling beyond reading already-public exports.
- **LLM gateway.** The flywheel is deterministic. Pack ranking falls back to token overlap when the W6.5 LLM-backed ranker isn't loadable. No new T6_STRONG / T4_JUDGE calls.
- **vault writes** beyond what W3.4 createSpark already does. Step 3 writes to `~/.hypha/commons/staging/`, NOT into the user's vault.
- **git operations.** Staging produces commit-message text only. Push, signing, and PR submission remain user actions.

## 9. Relationship to Other Waves

| Wave | Role in flywheel |
|---|---|
| **W3.1 Creation Pool** | Owns `vault/<slug>/product/` layout we read for spark dir / blueprint path |
| **W3.2 Product Blueprint** | Source for `proposeProductBlueprintTemplate` (parse via `blueprint-template.js`) |
| **W3.4 Product Spark** | Target of `proposeNoteToSpark.createSpark`; source for `evaluateSparkClusterForPack.listSparks` |
| **W5.3 Living Note utility-score** | Input to Step 1 eligibility |
| **W5.4 Creation System v1** | Sibling — runs Spark-side prioritization; we read but never write its state |
| **W6.2 Book Spark Pack** | Source for `proposeBookSparkPackPublic` |
| **W6.5 Pack Intelligence Card** | `rankPacks` is preferred ranker in Step 4 |
| **W6.5 Pack Security/License Layer** | Step 3 soft gates |
| **W7.1 Pack Learning Mode** | Downstream consumer of staged packs (consume side; not in our scope) |
| **W7.5 Living Note states** | Input to Step 1 eligibility |

## 10. Failure Modes & Mitigations

| Failure | Detection | Mitigation |
|---|---|---|
| W5.3 utility lib missing | `_utilityScore == null` at module init | Degrade open with `utility_lib_missing:degrade-open` reason; treat as neutral pass |
| W3.4 product-spark unloadable | `_productSpark.createSpark` undefined | `proposeNoteToSpark` returns `dryRun: true` payload for user inspection |
| W6.5 security-layer unloadable | `_security.scanPack` undefined | Pack stages without security flag; `blocked: false`, `scan: null` surfaced for audit |
| Staging dir permission denied | `fs.mkdirSync` throw | Bubbles up the IPC envelope; surfaced as `FLYWHEEL_PUBLISH_PACK_FAIL` with the underlying message |
| `findRelevantCommonsForLesson` returns 0 packs | `packs.length === 0` | `injectCommonsIntoLessonPrompt` returns `''` so the prompt diff is zero — no harm |
| Health caps out of date with cohort scale | `getFlywheelHealth` returns plateau-100 | Tune `HEALTH_CAPS` per user tier in a future wave; no code change to the formula |

## 11. Test Plan (placeholder; full coverage lands with W8.2.1)

The `__tests__/flywheel.test.js` placeholder declares 14 `test.todo()` entries covering: eligibility threshold pass/fail per rule, degrade-open under missing libs, batchNoteToSpark scanning, cluster eligibility A/B rules, blueprint-template empty fallback, book-spark-pack location fallback, publishPackToCommons writes three files, `blocked` flag round-trip, listStaged → unstage round-trip, findCommons w/ rankPacks vs token-overlap fallback, injectCommons empty pass-through, runFlywheelCycle metric shape, health score normalization, integration with agent.js commonsHintsSection.
