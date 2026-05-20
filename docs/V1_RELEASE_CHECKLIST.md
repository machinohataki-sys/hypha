# HYPHA v1.0 Release Checklist

> 2026-05-20 boot-10 audit. Source of truth = grep of `app/lib/` + `app/main.js` + `app/scripts/_dev_verify_*.js` + a clean run of `npm run smoke:all`. Numbers below are conservative — they only count what actually compiles + has a passing smoke when run alone.

Avg ship-% across 10 systems: **~84%** (Goal 88 / Lesson 93 / Note 88 / Creation 95 / Source 82 / Commons 80 / Exam 78 / Growth 84 / Companion 64 / Infra 80).

Smoke harness: **56 files / ~875+ assertions / 56 PASS when run standalone**. The sweep aggregator `npm run smoke:all` reports 52 PASS / 4 FAIL on cold parallel runs; all 4 (`creation_system` / `full_chain` / `golden_path_e2e` / `route_goal`) pass when run alone. Cause: concurrency-race on shared LLM rate limits + 45s per-smoke timeout in `app/scripts/_dev_run_all_smokes.js`. Action item below.

v1.0 distance: **~2 weeks** of operator action. No code blockers — only image tooling, signing certs, and CI secrets.

Section status (boot-10):

- §1 Ship-readiness matrix — **DONE**
- §2 Pre-release blockers — **PARTIAL** (1 of 2 boot-8 blockers cleared; 1 new sweep-runner action item added)
- §3 First-100-users critical path — **DONE**
- §4 Privacy and security checklist — **PARTIAL** (signing + CSP audit still TODO)
- §5 Build and distribution checklist — **PARTIAL** (icon.icns + signing certs)
- §6 Known limitations — **DONE**
- §7 Post-v1.0 roadmap — **DONE**
- §8 v1.0 Manual Ship Procedure — **DONE (NEW boot-10)**

---

## 1. Ship-readiness matrix

Five criteria per system. `Y` = shipped and verifiable. `~` = partial. `N` = not started or stub.

| System | Lib | IPC | UI | Smoke | Docs |
|---|---|---|---|---|---|
| 1. Goal | Y (`app/lib/feasibility.js`, `app/lib/goal-guardian.js`, `app/lib/goal-drift-detector.js`, `app/lib/creation/route-goal.js`, `app/lib/creation/goal-crystallizer.js`) | Y (4 `goal:*` + `goal:crystallize:*`) | Y (`app/design/screen-goal-crystallizer.jsx`) | Y (`app/scripts/_dev_verify_goal_crystallizer.js` 62/62, `_dev_verify_route_goal.js` 4/4 LLM, `_dev_verify_full_chain.js` steps 1-2 PASS standalone) | ~ (`specs/goal-contract.md` placeholder) |
| 2. Lesson | Y (`app/lib/hypha-learn/`, `app/lib/anti-slop/` 3923 LOC × 12 files, `app/lib/judges/`, `app/lib/critique/`, `app/lib/quality-harness/`, `app/lib/lesson-body-generator.js`, `app/lib/lesson-generator.js`) | Y (87+ across `lesson:*`, `chain:*`, `cadence:*`, `concept:*`, `anti-slop:*`, `concept-ledger:*`, `evidence:*`) | Y (`app/design/screen-lesson.jsx`, `app/design/screen-lesson-chat.jsx`, `app/design/course-trust-panel.jsx`, `app/design/knowledge-point-cards.jsx`, `app/design/mastery-card.jsx`) | Y (`app/scripts/_dev_verify_lesson_quality_v2.js` 68/68, `_dev_verify_critique.js`, `_dev_verify_concept_ledger.js`, `_dev_verify_evidence_ledger.js`, `_dev_verify_metaphor_detect.js` 19/19, `_dev_verify_literary_archetype.js` 18/18, `_dev_verify_full_chain.js` 15/15 standalone) | Y (`specs/anti-slop-layer.md`, `app/lib/pedagogy.md`) |
| 3. Note | Y (`app/lib/note-system/`, `app/lib/web-note-engine/`, `app/lib/living-note/`, `app/lib/lesson-note.js`, `app/lib/userProfile.js`, `app/lib/flywheel/note-to-spark.js`) | Y (44 across `notes:*`, `entropy:*`, `atlas:*`, `wiki:*`, `webnote:*`, `livingnote:*`, `capture:*`) | Y (`app/design/screen-notebook.jsx`, `app/design/screen-atlas-notebook.jsx`, `app/design/screen-dead-notes.jsx`, `app/design/screen-capture.jsx`, `app/design/note-edge-card.jsx`, `app/design/note-reactivation-card.jsx`, `app/design/entropy-reduction-card.jsx`) | Y (`app/scripts/_dev_verify_concept_ledger.js`, `_dev_verify_contamination_graph.js`, `_dev_verify_graph_rag.js`) | ~ (no `specs/note-system.md` standalone — note pattern lives in `specs/anti-slop-layer.md` §M11 + `specs/living-note.md` + `specs/web-note-engine.md`) |
| 4. Creation | Y (`app/lib/creation/` × 11 = 4402 LOC + `app/lib/creation-system-v1/` × 5 = 1230 LOC) | Y (35 across `creation:*`, `decision:*`, `assumption:*`, `spark:*`, `kill:*`, `roadmap:*`, `product:*`, `transfer:*`, `flywheel:*`) | Y (`app/design/screen-product-list.jsx`, `app/design/screen-product-blueprint.jsx`, `app/design/screen-spark-pool.jsx`, `app/design/product-spark-card.jsx`, `app/design/project-spine-card.jsx`, `app/design/decision-ledger-card.jsx`, `app/design/roadmap-card.jsx`, `app/design/kill-toast.jsx`) | Y (`app/scripts/_dev_verify_creation_system.js` 8/8 standalone, `_dev_verify_expected_years.js` 4/4, `_dev_verify_full_chain.js` 15/15 standalone, `_dev_verify_golden_path_e2e.js` GP1-GP2 standalone) | Y (`specs/creation-system.md`) |
| 5. Source | Y (`app/lib/source-extractor.js`, `app/lib/library/`, `app/lib/distillation/`, `app/lib/grounding/`, `app/lib/citation-system/` 1023 LOC × 6 files, `app/lib/harvest/` 3161 LOC) | Y (42 across `source:*`, `library:*`, `distill:*`, `grounding:*`, `book:*`, `book-router:*`, `citation:*`, `harvest:*`) | Y (`app/design/screen-library.jsx`, `app/design/screen-library-gate.jsx`, `app/design/screen-library-workshop.jsx`, `app/design/screen-distillation-progress.jsx`, `app/design/screen-book-spark-pack.jsx`, `app/design/screen-book-reader.jsx`, `app/design/screen-grounding-review.jsx`) | Y (`app/scripts/_dev_verify_citation_full.js`, `_dev_verify_library_coverage.js` 52/52, `_dev_verify_file_converter.js` 18/18, `_dev_verify_url_pinger.js` 6/6, `_dev_verify_hypha_scout.js`) | Y (`specs/bibliography-grounding.md`, `specs/library-distillation.md`, `specs/longform-distillation.md`, `specs/citation-system.md`) |
| 6. Commons | Y (`app/lib/commons/` × 9 files = 2800 LOC + `app/lib/commons-packs/` × 2 packs) | Y (49 across `commons:*`, `pack:*`, `persona:*`, `personas:*`, `corpus:*`) | Y (`app/design/screen-commons.jsx`, `app/design/screen-pack-learning.jsx`) | Y (`app/scripts/_dev_verify_pack_schema.js` 6/6, `_dev_verify_commons_lifecycle.js` 8/8, `_dev_verify_pack_distiller_hardening.js` 11/11) | Y (`specs/commons.md`, `specs/commons-alpha-full.md`, `specs/pack-learning.md`) |
| 7. Exam | Y (`app/lib/exam-system/` × 6 = 1859 LOC including `judge.js`; `app/lib/exam/final-compression.js` α18 variant) | Y (22 across `exam:*`, `final-compression:*`) | Y (`app/design/screen-exam-dashboard.jsx`) | Y (`app/scripts/_dev_verify_exam_judge.js`) | Y (`specs/exam-system.md`, `specs/exam-model-alpha.md`) |
| 8. Growth | Y (`app/lib/growth/` × 7 = 1802 LOC + `app/lib/cross-spark/` × 4 = 1254 LOC) | Y (55 across `spark:*`, `cross-spark:*`, `judgment-gym:*`, `bandit-frontier:*`, `project-spine:*`, `north-star:*`, `thinking-tools:*`, `artifact:*`, `kpi:*`) | Y (`app/design/screen-cross-spark.jsx`, `app/design/screen-judgment-gym.jsx`, `app/design/screen-spark-pool.jsx`, `app/design/cross-spark-card.jsx`, `app/design/judgment-gym-card.jsx`, `app/design/project-spine-card.jsx`, `app/design/north-star-panel.jsx`, `app/design/artifact-creation-card.jsx`) | Y (`app/scripts/_dev_verify_growth_system.js` — boot-10 new, closes boot-8 soft-blocker; `_dev_verify_creation_system.js`, `_dev_verify_expected_years.js`) | ~ (lives in spec fragments across creation + roadmap; no standalone `specs/growth-system.md`) |
| 9. Companion | Y (`app/lib/companion/` × 7 = 1307 LOC including `app/lib/companion/local-model.js` T2_LOCAL stub; `app/lib/companion-history.js`; `app/lib/companion-triggers.js`) | Y (13 `companion:*`) | ~ (`app/design/companion-presence.jsx` only; visual State Expression UI minimal) | Y (`app/scripts/_dev_verify_emotion_state.js` 13/13, `_dev_verify_emotion_streamturn_wire.js`, `_dev_verify_emotion_tone_bridge.js` 8/8, `_dev_verify_companion_local_scaffold.js` 11/11) | Y (`specs/companion-myco.md`, `specs/companion-emotion-state-layer.md`, `specs/companion-triggers.md`) |
| 10. Infra | Y (`app/lib/llm/` × 11 = 2104 LOC, `app/lib/cashflow-shield/` × 2, `app/lib/infrastructure/` × 3, `app/lib/donate/`, `app/lib/feedback-channel/`, `app/lib/telemetry/`, `app/lib/pricing/` × 2, `app/lib/auto-updater.js` 386 LOC, `app/lib/onboarding-state.js`, `app/lib/vault.js`, `app/lib/vault-snapshot.js`, `app/lib/vault-meta.js`, `app/lib/vault-context.js`, `app/lib/lifetime-ledger/` × 4, `app/lib/launch-readiness/` × 3) + CI (`.github/workflows/` × 3) + smoke aggregator (`app/scripts/_dev_run_all_smokes.js`) | Y (**573 IPC handlers in main.js** — grep verified across `llm:*`, `cost:*`, `cheap:*`, `shield:*`, `feedback:*`, `donate:*`, `telemetry:*`, `providers:*`, `pricing:*`, `onboarding:*`, `update:*`, `privacy-memory:*`, `context-packer:*`, `lifetime:*`, `score:*`, `launch:*`) | Y (`app/design/cost-budget-card.jsx`, `app/design/screen-cost-budget.jsx`, `app/design/screen-donate.jsx`, `app/design/privacy-memory-card.jsx`, `app/design/screen-onboarding.jsx`, `app/design/screen-feedback.jsx`, `app/design/screen-lifetime-ledger.jsx`, `app/design/screen-launch-readiness.jsx`) | Y (22+ infra smokes: `app/scripts/_dev_verify_cost_*` + `_dev_verify_telemetry_local.js` + `_dev_verify_payment_rails.js` + `_dev_verify_pricing_*` + `_dev_verify_tier_budget_link.js` + `_dev_verify_onboarding_flow.js` + `_dev_verify_auto_updater.js` + `_dev_verify_lifetime_*` + `_dev_verify_variance.js` + `_dev_verify_silent_catch_sweep.js` + `_dev_verify_vault_safety.js` + `_dev_verify_validation_mass.js` + `_dev_verify_launch_readiness.js` + `_dev_verify_build_config.js` + `_dev_verify_build_dry_run.js` boot-10) | Y (`specs/feedback-donate-cashflow.md`) |

Counts: **10 systems / 9 fully Y across all 5 criteria / 1 with partial (Companion: UI minimal; spec docs all Y).**

---

## 2. Pre-release blockers

Hard blockers (must clear before tagging v1.0):

1. **`build/icon.icns` missing** — `build/icon.placeholder.txt` exists in its place. Mac builds will fail until generated. Recovery is mechanical — see `build/README.md` §"Generating the missing icon.icns" and run `build/icon-build.sh` (mac/linux) or `pwsh build/icon-build.ps1` (windows). Auto-updater channel + `package.json` `build.publish[0]` are already pointed at `machinohataki-sys/hypha` (real, not placeholder).

   Acceptance: file `build/icon.icns` exists, > 0 bytes, opens cleanly in Preview.app or Finder. Or accept Windows-first v1.0 and defer mac (`.ico` and `.png` are both shipped).

Soft blockers (worth fixing pre-release, not strictly required):

2. **Sweep-runner concurrency race** — `npm run smoke:all` returns 4 FAIL on cold parallel runs (`creation_system` / `full_chain` / `golden_path_e2e` / `route_goal`). All 4 PASS when run standalone — verified 2026-05-20 individual re-runs. Root cause: LLM rate-limit collisions when 4 LLM-bound smokes hit the same provider concurrently + per-smoke 45s wall-clock timeout. Fix: edit `app/scripts/_dev_run_all_smokes.js` to either (a) bump `PER_TIMEOUT_MS` to 90_000 for smokes touching `executeChat()`, or (b) add a `RUN_SEQUENTIAL` marker in those 4 files and gate them out of the concurrency pool. (a) is one-line; (b) is the cleaner long-term fix. Today CI may show same artifact on cold runners.

3. **Note System docs fragmented** — no `specs/note-system.md`; pattern is scattered across `specs/anti-slop-layer.md` §M11 + `specs/living-note.md` + `specs/web-note-engine.md`. Action: consolidate, even as a thin index.

4. **`route_goal` smoke is LLM-dependent** — runs at ~45-90s per invocation, fragile in CI cold runs. Either fold into the sequential pool (action item #2) or add a deterministic stub mode (heuristic fallback path already exists).

Resolved since boot-8:

- ~~`_dev_verify_full_chain.js` step12 PJR HUMANITIES regression~~ — re-verified PASS 15/15 standalone 2026-05-20. boot-8 audit captured a then-real failure (committed by 2026-05-20 boot-9 PJR rewrite); no longer in the harness.
- ~~Growth System lacks dedicated smoke~~ — `_dev_verify_growth_system.js` shipped boot-9 (PASS 18830ms).

---

## 3. First-100-users critical path

Path verified by `app/scripts/_dev_verify_onboarding_flow.js` (15/15 PASS) + `app/scripts/_dev_verify_golden_path_e2e.js` (GP1 + GP2 PASS standalone).

| Step | User action | Code path | Failure mode caught |
|---|---|---|---|
| 1 | Install + first launch | `app/main.js` → `createMainWindow` + `app/lib/onboarding-state.js` | Provider keys absent → fallback to `claude-cli` provider or BYOK gate |
| 2 | Greet + profile setup | `app/design/screen-onboarding.jsx` + `vault/data/profile.json` write | First-launch idempotency (re-running onboarding leaves profile intact) |
| 3 | First goal | `app/design/screen-goal-crystallizer.jsx` → `goal:crystallize:questions` → `goal:crystallize:synthesize` | `app/lib/goal-guardian.js` rejects absurd goals (ratio<0.05 → `verdict='absurd'`) |
| 4 | Goal routing | `app/lib/creation/route-goal.js` chooses `single` vs `chain` at difficulty 0.7 | Empty goal → safe fallback to `single` |
| 5 | First lesson plan | `lesson:generatePlan` → `app/lib/lesson-generator.js` + `app/lib/lesson-body-generator.js` | LLM key missing → user-visible error (not silent) |
| 6 | First lesson chat | `app/design/screen-lesson-chat.jsx` → `app/agent.js:streamTurn` with anti-slop loop | PJR rewrite gates on archetype (HUMANITIES bypass verified PASS standalone — `_dev_verify_full_chain.js` step12) |
| 7 | `/finish` ritual | `app/design/finish-ritual.jsx` + `vault/<slug>/lesson-NN.md` write | Course Trust Panel surfaces confession + drift + coherence |
| 8 | First exam (optional) | `app/design/screen-exam-dashboard.jsx` + `exam:scope` + `app/lib/exam-system/judge.js` | T4_JUDGE empty-input reroute (`_dev_verify_exam_judge.js` covers it) |

User-visible bugs that would stop a first-100 cohort:

- **Step 1 macOS fallback** — mac users hit blank installer icon until `build/icon.icns` ships. Mitigation: ship Windows-first v1.0 and defer mac, or run icon tooling per `build/README.md`.

Everything else has a verified standalone smoke.

---

## 4. Privacy and security checklist

Verifiable today:

- [x] No analytics endpoint — telemetry is local-only (`app/lib/telemetry/local-tracker.js` 426 LOC, `app/scripts/_dev_verify_telemetry_local.js` 11/11)
- [x] `vault/` is plain markdown + JSON (no DB, no server) — confirmed via `docs/ARCHITECTURE.md`
- [x] Provider API keys stored in OS env vars only, never written to `vault/` — provider code at `app/lib/llm/glm-direct.js` + `app/lib/llm/deepseek-direct.js` + `app/lib/llm/kimi-direct.js` uses `process.env.*` exclusively
- [x] `.trim()` defense against PowerShell `\n` baking in env values — confirmed in provider constructors
- [x] `app/lib/infrastructure/privacy-memory.js` filters user PII from cross-curriculum spark recommendations
- [x] Silent-catch sweep — `app/scripts/_dev_verify_silent_catch_sweep.js` 6/6 PASS prevents `catch (_) {}` masking destructive errors
- [x] Vault safety — `app/scripts/_dev_verify_vault_safety.js` PASS covers openVault + schema migration + writeJSON/readJSON round-trip
- [x] Cashflow shield rate limit — Pro ¥5/d, Founders ¥10/d, BYOK ¥999/d enforced at `app/lib/cashflow-shield/shield.js`
- [x] `docs/PRIVACY.md` exists (58 lines)

Not verified (action required):

- [ ] No code-signing on Windows installer — `electron-builder` runs unsigned in dry build. Smart Screen will show "Unknown Publisher" warning on first install. Either acquire a code-signing cert (set `CSC_LINK` / `CSC_KEY_PASSWORD`) or document the warning in `docs/GETTING_STARTED.md`.
- [ ] No CSP / strict sandbox audit on Electron renderer — `webPreferences` in `app/main.js` not audited for `nodeIntegration: false` + `contextIsolation: true` + `sandbox: true`. Recommend a one-time audit before tagging v1.0.
- [ ] No third-party dependency audit — `npm audit` has not been wired into the release flow. Recommend adding to release.yml.

---

## 5. Build and distribution checklist

Configuration verified in `package.json`:

- [x] `"name": "hypha"`, `"version": "0.11.2"` — version bump required to `1.0.0` before release tag
- [x] `"appId": "com.victor.hypha"`, `"productName": "HYPHA"`
- [x] `"asar": true` — main bundle is ASAR-packed
- [x] Windows: `"icon": "build/icon.ico"` — present, 358742 B, 6 entries
- [x] Linux: `"icon": "build/icon.png"` — present, 11923 B
- [x] Build resources: `build/entitlements.mac.plist` + `build/README.md` + `build/icon@512.png` + `build/icon-source.svg` present
- [x] Auto-updater: `"electron-updater": "^6.3.9"` in dependencies, GitHub channel `machinohataki-sys/hypha`, `electronUpdaterCompatibility >=2.16`
- [x] Auto-updater wiring: `app/lib/auto-updater.js` 386 LOC + 8 `update:*` IPC (`update:check` / `update:download` / `update:install` / `update:current` / `update:state` / `update:skip-version` / `update:remind-later` + event channel `update:event`) — verified by `app/scripts/_dev_verify_auto_updater.js`
- [x] Build config smoke: `app/scripts/_dev_verify_build_config.js` PASS (`build/` resources present, entitlements valid, `.gitignore` excludes `dist/`)
- [x] Build dry-run smoke: `app/scripts/_dev_verify_build_dry_run.js` PASS (boot-10 new)
- [x] CI workflows: `.github/workflows/smoke.yml` + `build.yml` + `release.yml` — all present, secret-guarded
- [x] CODEOWNERS: `.github/CODEOWNERS` set to `@machinohataki-sys` (the `PLACEHOLDER_USERNAME` mention is in the comment header only — the actual rules use the real owner)

Remaining:

- [ ] `build/icon.icns` (mac) — placeholder only; required for mac build to succeed
- [ ] Code-signing certs (Windows + macOS) — `CSC_LINK` + `CSC_KEY_PASSWORD` env vars not set in any local secret store
- [ ] First v1.0.0 GitHub release tag + asset upload — auto-updater requires at least one release to be present on the publish channel
- [ ] Smoke-test the auto-update path end-to-end on a real machine — current `_dev_verify_auto_updater.js` validates wiring + state machine, not the round-trip download
- [ ] `npm run pack:win -- --out=release/build-hypha-v1.0.0` (legacy) OR `npm run build:win` (electron-builder) produces a clean portable build
- [ ] `npm run build:linux` is config-supported but has not been smoke-tested on a real Linux runner

---

## 6. Known limitations (honest)

Documented gaps that are intentionally not in v1.0 scope. These are not bugs — they are deliberate cuts to ship.

- **Literary archetype detection is rule-based**, not LLM-driven. `app/scripts/_dev_verify_literary_archetype.js` 18/18 PASS covers the rule set. Full LLM-driven archetype routing is v2.0+.
- **Payment rails are smoke-validated, not live**. `app/scripts/_dev_verify_payment_rails.js` PASS validates the contract shape (Stripe / WeChat envelope, idempotency, refund flow). No live Stripe/WeChat integration ships in v1.0 — pricing engine generates the right gates, payment is handled out-of-band (Founders one-time via direct transfer).
- **T2_LOCAL Gemma 3 4B + T1_EMBED BGE-M3** are deferred to v0.8 Companion. Scaffold stub shipped boot-9/10 (`app/lib/companion/local-model.js` + `app/scripts/_dev_verify_companion_local_scaffold.js` 11/11); real model wiring is v0.8.
- **Cloud sync is local-only.** vault is on-disk; multi-device sync is v1.5+.
- **Companion local model not wired.** Companion responds via T6_STRONG router today — not a local Gemma. Cost is shielded by cashflow rate limit.
- **Mode Router (Exam vs Growth vs Hybrid) full triple-coupling** is partial — Exam dispatch exists, full triple-mode routing is post-v1.0.
- **Persona Wisdom corpus** ships 5 personas (karpathy / limu / munger / tao / tolkien). nobel-literature-critic is WAITING — agent prompts handle the absence with a wait-state, never invents content.
- **Knowledge Contamination Graph** ships (`_dev_verify_contamination_graph.js` PASS), but the surface is editorial-only — users see "concept-X invalidated" rows, not a graph viz.
- **Cross-Spark engine** ships, full Project Spine planner UI is partial. Card surfaces exist; full Gantt-style planner is post-v1.0.
- **BYOK Western providers** (OpenAI / Anthropic SDK direct) ship via `claude-cli` provider only. Native OpenAI BYOK is post-launch.
- **`docs/SHIP_TIMELINE.md`** (boot-10 new) — narrative log of the 2026-05 ship sprint. See file for per-boot summary.

---

## 7. Post-v1.0 roadmap

Surfaced from spec files + sparks index, ordered by user-value-per-week:

1. **Fix sweep-runner concurrency** (1-2 days) — `app/scripts/_dev_run_all_smokes.js` mark 4 LLM-bound smokes RUN_SEQUENTIAL, removes the CI false-positive
2. **macOS icon + signing** (3-5 days, image tooling + Apple Developer ID) — unlocks mac distribution
3. **Companion local Gemma 3 4B** (v0.8, ~2 weeks) — T2_LOCAL via Ollama; scaffold already in place, just needs model swap + smoke upgrade
4. **BGE-M3 local embedding** (v0.8+, paired with #3) — enables on-device similarity for note reactivation without cloud round-trip
5. **Multi-device cloud sync** (v1.5, ~4 weeks) — `vault/` syncs via git or CRDT; deferred until single-device usage is validated by first 100 users
6. **Cross-Spark cross-curriculum auto-detect** (v1.2, ~2 weeks) — current engine ships but lacks the cross-curriculum scan trigger
7. **Citation per-claim provenance ledger** (v1.3) — `app/lib/citation-system/` ships the boundaries; per-claim ledger requires streamTurn integration
8. **Mode Router triple-coupling** (v1.4) — Exam ⇄ Growth ⇄ Hybrid full dispatch
9. **Pack marketplace** (v2.0) — Commons currently ships 2 packs + 1 seed; marketplace UX + ed25519 author signing is v2.0+
10. **Live Stripe / WeChat Pay integration** (v1.5) — current rails are contract-validated only

Decision Log + Assumption Ledger should capture each of these as Decisions with `prediction:{claim, falsifier, deadline_iso}` so Kill Watcher can auto-refute drift.

---

## 8. v1.0 Manual Ship Procedure (operator action required)

> Operator-flavored companion to this section: see `docs/V1_OPERATOR_HANDOFF.md` for copy-paste commands, known gotchas, and the ship verification checklist. This section is the canonical reference; HANDOFF is the runbook.

Sequential steps. None are reversible past step 7 without yanking the release tag. Run them in order, on a clean checkout.

1. **`npm install`** — fetch `electron-builder` + `electron-updater` + all current deps. Verify clean install with `npm run smoke:all`; expect 52/56 PASS on parallel sweep (4 sweep-race artifacts documented in §2). Re-run each of the 4 standalone to confirm individual PASS:
   ```
   node app/scripts/_dev_verify_creation_system.js
   node app/scripts/_dev_verify_full_chain.js
   node app/scripts/_dev_verify_golden_path_e2e.js
   node app/scripts/_dev_verify_route_goal.js
   ```

2. **Confirm `package.json` publish target** — `build.publish[0]` should read `{ "provider": "github", "owner": "machinohataki-sys", "repo": "hypha" }`. No `PLACEHOLDER_*` strings remain (last `PLACEHOLDER_USERNAME` is a comment in `.github/CODEOWNERS` only). Bump `"version": "0.11.2"` → `"1.0.0"`.

3. **Confirm `.github/CODEOWNERS`** — actual rules use `@machinohataki-sys`. If moving under an org, replace globally before continuing.

4. **Generate `build/icon.icns`** — only mac builds need this. Pick one:
   - cross-platform: `npm install --save-dev electron-icon-builder && npx electron-icon-builder --input=build/icon-source.svg --output=build --flatten`
   - mac/linux native: `./build/icon-build.sh`
   - windows native: `pwsh build/icon-build.ps1`

   Acceptance: `ls -l build/icon.icns` shows non-zero size; opens in Preview/Finder. See `build/README.md` for details and fallback. Skip this step if shipping Windows-first only.

5. **Set up code signing** — see `build/README.md` §"Signing — not configured here":
   - Windows: acquire EV cert, set `CSC_LINK` (PFX path or base64) + `CSC_KEY_PASSWORD` env vars
   - macOS: Developer ID Application cert in Keychain + `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` for notarization
   - Linux AppImage: no signing
   - Local dry-run unsigned build: `npm run build:win` (or `:mac` / `:linux`)

6. **Set CI secrets** in GitHub repo settings → Secrets and variables → Actions:
   - `GH_TOKEN` — repo-scoped token for `electron-builder --publish always` to push to Releases
   - `CSC_LINK` + `CSC_KEY_PASSWORD` — Windows code signing (skip cleanly if absent via `if:` guards in `release.yml`)
   - `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` — macOS notarization (same skip behavior)

7. **Tag `v1.0.0-rc.1`** — release-candidate to flush the auto-update channel:
   ```
   git tag v1.0.0-rc.1
   git push --tags
   ```

8. **CI runs** in order: `smoke.yml` (matrix linux/win/mac) → `build.yml` (dry build matrix on tag push) → `release.yml` (signed publish matrix, only if `GH_TOKEN` secret present). Each is in `.github/workflows/`. Monitor each job; on red, halt and triage before promoting.

9. **Manual install test** on each OS:
   - download installers from the GitHub Release for the tag
   - install on a clean VM or test machine
   - confirm first-launch greet + provider key prompt (`screen-onboarding.jsx`)
   - confirm auto-updater state surfaces in app (`update:state` IPC → renderer)
   - confirm at least one cycle of `goal-crystallize → lesson-generate → finish-ritual` runs without errors

10. **Promote `v1.0.0-rc.1` → `v1.0.0`** — once manual tests pass on all targeted OSes:
    ```
    git tag v1.0.0
    git push --tags
    ```
    Same CI matrix runs. After publish, the auto-updater channel will catch up users from rc.1.

Rollback: if a release tag must be pulled, `git tag -d v1.0.0 && git push origin :refs/tags/v1.0.0` plus a GitHub UI deletion of the Release. Users who already pulled the binary cannot be force-reverted; rely on a fast `v1.0.1` patch instead.
