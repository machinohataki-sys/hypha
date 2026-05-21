# Changelog

All notable user-visible changes are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Auto-backup commits and internal scaffolding work are intentionally
omitted — the goal is a manuscript-register changelog a reader can scan,
not a git-log dump.

## [Unreleased]

v2.0 development — system completeness push from rc.3 baseline. Multi-batch
multi-agent ship sequence; each batch tracked here as it lands on `main`.

### Added — v2 push batch 1 (2026-05-21)
- **Companion persona-coherence metric** (Scout S68, arXiv 2605.12850):
  Stability + Robustness scorer with harmonic-mean fusion, gate at ≥0.75.
  Boundary-guard severity ladder (soft / firm / hard). Character contract
  enriched: `identity`, `voice_patterns`, `no_go_zones`, `repair_patterns`.
  Companion System ~60% → ~84%.
- **Lesson critique-loop bundle** (Scout S66+S75+S80+S88): post-generation
  Sonnet critic against Plan's success/failure test, MSIFR mid-stage rule
  validators (syntax / namespace / silent-catch / scope-creep — cheap-first
  short-circuit), A/B trace `quality-trace.jsonl`. Default-off behind
  `experimental: true` config flag; A/B metadata emit unconditional.
- **Prediction-field schema** (Scout S63+S67+S73): optional
  `prediction:{claim, falsifier, deadline_iso}` on Decision Log + Assumption
  Ledger. Vague-falsifier regex guard rejects entries without numeric /
  comparator / ISO-date anchor. Kill Watcher emits `REVIEW` events to
  `vault/.hypha/kill-watcher.jsonl` for past-deadline entries with
  `suggested_transition` (active→ratified / active→invalidated /
  review_needed). Non-mutating audit channel; existing auto-refute path
  untouched.
- **Source 5-layer lane router** (Scout S64+S81, project memory
  `project_hypha_5layer_scrape_spec`): `routeLanes(archetype, query)` returns
  ordered plan across Canonical / Pedagogy / Frontier / Engineering / User
  layers with bb-browser / WebFetch / skip routing decisions. New
  conference-field extractor (Tutorial / Workshop / Best-Paper /
  OpenReview-review) + course-field extractor (Syllabus / Assignments /
  Reading / Labs). Knowledge Source System ~82% → ~95%.
- 5 new smokes (159 net new tests): `companion_persona_coherence` 14/14 +
  `critique_loop` 25/25 + `prediction_field` 52/52 + `source_lane_router`
  68/68 + (resolved) `full_chain` step12 10/10.

### Resolved — v2 push batch 1
- `_dev_verify_full_chain.js` step12 HUMANITIES archetype gate — was
  tracked as rc.1 known issue. Investigation confirmed the regression was
  already fixed by the per-axis HUMANITIES gate at
  `app/lib/anti-slop/prosecute-judge-rewrite.js:527-536` (shipped v0.4.4,
  2026-05-19). CHANGELOG entry was stale; smoke is 10/10 PASS.

### Added (prior)
- Founder cohort exit ramps for Track A (build-in-public artifact log)
  and Track B (public-channel narration).

### Changed (prior)
- Source extractor caps tightened: 200 MB per file, 8 files per call,
  800 MB total per ingest.

## [1.0.0-rc.3] - 2026-05-21

CI release-pipeline iteration on top of rc.2 — fixes macOS publish job
and build.yml dry-run on tag pushes. No product code changes.

### Fixed
- `release.yml` macOS publish no longer crashes on empty `CSC_LINK` /
  `APPLE_ID` envs. Workflow now uses bash on all 3 OSes and only exports
  signing variables when their secrets are non-empty. Without signing,
  `CSC_IDENTITY_AUTO_DISCOVERY=false` keeps electron-builder happy.
- `build.yml` dry-run no longer demands `GH_TOKEN`. Passes
  `--publish never` so electron-builder skips the auto-publish path
  that the `github` provider in `package.json` would otherwise trigger.

### Carried forward from rc.2 (verified shipped via Win + Linux installers)
- 10-system v1.0 codebase (all systems audited per CLAUDE.md boot-12).
- PDF native upgrade (`native-pdf-v2` with pdfjs-dist + OCR fallback).
- Local-first telemetry, vault snapshot, auto-updater scaffold, payment
  rails stub, electron-builder 3-OS config, icon.icns generator.

## [1.0.0-rc.2] - 2026-05-21

CI / release-pipeline iteration on top of rc.1. No product code changes.

### Fixed
- `package-lock.json` regenerated to match `package.json` after
  electron-builder + electron-updater landed in earlier boots.
- CI smoke now passes on fresh 3-OS runners: `SKIP_HEADLESS` markers
  added to LLM-key-dependent smokes (`cost_ledger` / `creation_system` /
  `full_chain` / `route_goal` / `golden_path_e2e`) and to the
  `sweep_runner` smoke (needs a prior local baseline file).
- `pack_schema` PS5 now soft-skips when the `vault/.commons-packs/`
  seed fixture is absent (vault is gitignored, missing on CI checkout).
- `release.yml` maps `GH_TOKEN` from the auto-provided
  `secrets.GITHUB_TOKEN` — no manual GitHub secret required for basic
  release publish; signing certs remain optional.

### Added
- `esbuild ^0.28.0` in `devDependencies` so `pricing_ui_wire` and
  `ui_polish` smokes can compile JSX in CI without a global install.
- PDF native upgrade (last user-driven slice of rc.1):
  - `native-pdf-v2.js` uses pdfjs-dist directly — heading 启发式
    (font-size top 5% = H1, top 15% = H2), multi-column reading order,
    image-heavy detection → OCR fallback, transparent v1 fallback.
  - `raw-stash.js` no longer recommends `pip install markitdown`;
    new message explains what HYPHA tried and suggests uploading the
    EPUB version or splitting the PDF.
  - `_dev_verify_native_pdf_v2.js` smoke: 17/17 PASS.

## [1.0.0-rc.1] - 2026-05-20

First release candidate spanning the ten production systems described in
`CLAUDE.md`. Highlights, grouped by system, with the shipped percentages
captured during the boot-8 audit:

### Goal System (~88%)
- Goal Crystallizer round-based questioning, 62/62 smoke green.
- Feasibility math floor (Macnamara / Donner-Hardy / Newport),
  three-tier verdict (absurd / strained / feasible).
- Single↔chain dispatcher at difficulty 0.7 threshold.
- Goal Drift Detector with regen-once gate before LessonChat.

### Lesson System (~92%)
- 11-field Lesson Brief pre-generation + body validator with
  encyclopedia-opener flag.
- Anti-Slop P0 + P1 wired into `streamTurn`: confession layer,
  gap detector, prosecutor-judge-rewriter (math + LLM rewrite),
  archetype-aware gating (HUMANITIES / LANG-ACQ / MINDSET / TECH).
- Concept Ledger pure-JS cross-lesson coherence (86/86 smoke).
- Knowledge Contamination Graph with quarantine walk (39/39 smoke).
- Critique loop (22/22 smoke) with quality harness rewrite path.

### Note System (~88%)
- Dual-layer distill (course base + user spark).
- Living Note reactivation (Jaccard + LLM) + Web Note Engine
  with five typed edges.
- Atlas concept tracking + entropy-reduction surface.

### Creation System (~95%)
- Decision Log + Assumption Ledger with
  `prediction:{claim, falsifier, deadline_iso}` schema field.
- Product Spark state machine + Kill Watcher auto-refute on
  expired falsifiers.
- Roadmap Sync weekly + cadence hook + spark-priority engine.
- Auto-transfer from finished lessons to product blueprints.

### Knowledge Source System (~82%)
- Citation System hardened to 978 LOC: copyright boundary,
  global trust, external-link scanner, coverage tracker
  (15/15 smoke).
- Library workshop + book reader + book spark pack + grounding
  synthesis surfaces.
- Archetype-aware source lanes (six archetypes × five priority
  source classes).

### Commons System (~80%)
- Knowledge Pack loader / schema / distiller / import / export
  with 49 IPC handlers.
- Two production packs (`plato-zh`, `spinoza-zh`) plus the seed
  `feynman-method` mindset pack.
- Pack security layer + source trust + license layer (11/11 hardening
  smoke).

### Exam System (~78%)
- Exam Scope Engine, four-tier classification.
- Final Compression seven-day five-task plan.
- T4_JUDGE LLM micro-judge with empty-input reroute (9/9 smoke).
- User bank import (CSV / JSON / Markdown).

### Growth System (~82%)
- Cross-Spark cross-curriculum surface.
- Judgment Gym + Thinking Tools surfaces.
- Project Spine card + Artifact Creation card + North Star metrics.

### Companion System (~60%)
- Myco Companion tone engine with six-trigger schema and
  boundary guard.
- Emotion State orthogonal classifier (13/13 smoke) wired into
  `streamTurn` (10/10 smoke).
- Character Contract injection for the mycelium-professor persona.

### Infrastructure (~78%)
- Capability-class router (T6_STRONG / T4_JUDGE / T3_MID) over
  GLM / DeepSeek / Kimi with 90 s sliding-window provider health.
- Cashflow Shield (Pro ¥5/d, Founders ¥10/d, BYOK ¥999/d) with
  cost-budget 90/100/110% gates.
- Lifetime Ledger (17/17 schema, 16/16 IPC smoke).
- Pricing v3 with loyalty engine + payment rails design contract.
- Auto-Updater (electron-updater) wired to
  `machinohataki-sys/hypha` (26/26 smoke).
- Onboarding flow (15/15 smoke), telemetry local tracker
  (11/11 smoke), build config audit (13/13 smoke).

### Build & Release (this boot)
- `smoke.yml`, `build.yml`, `release.yml` GitHub Actions
  workflows with linux/win/mac matrix.
- `npm run smoke:all` aggregator over the
  `app/scripts/_dev_verify_*.js` family (64 smoke locked
  baseline at `vault/.hypha/smoke-baseline.json`).
- Sweep concurrency tuned: 60 parallel @ 45 s timeout + 4
  LLM-bound `RUN_SEQUENTIAL` @ 300 s timeout (creation_system /
  full_chain / golden_path_e2e / route_goal).
- macOS app icon (`build/icon.icns`, 224 529 bytes) shipped —
  signed DMG output now uses the manuscript-register glyph.
- Cleanup Registry (`app/lib/cleanup-registry.js`, 144 LOC)
  consolidates app-quit teardown across IPC, vault writers, and
  Companion native handles.
- Boundary Guards (12/12 smoke) enforce destructive-IPC scope
  on vault writes, source extraction, and Commons pack import.
- Startup Perf profiler (`app/lib/perf/startup-profile.js`,
  116 LOC, 8/8 smoke) captures boot phases to
  `vault/.hypha/startup-trace.jsonl`.
- Cross-platform smoke (`_dev_verify_cross_platform.js`) guards
  path joins, line endings, and shell-quoting across Windows /
  macOS / Linux.
- CI config audit smoke (`_dev_verify_ci_config.js`, 9/9)
  pins workflow files + ensures secrets-handling discipline.
- UI polish smoke (`_dev_verify_ui_polish.js`) covers
  manuscript-register surface invariants.
- CODEOWNERS, dependabot, and this changelog.

### Known issues
- `_dev_verify_full_chain.js` step12 HUMANITIES archetype gate
  fails 11/15 of its sub-tests; ship is not blocked but the
  regression is tracked for v1.0.0.

[Unreleased]: https://github.com/machinohataki-sys/hypha/compare/v1.0.0-rc.1...HEAD
[1.0.0-rc.1]: https://github.com/machinohataki-sys/hypha/releases/tag/v1.0.0-rc.1
