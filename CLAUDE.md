# Hypha — Claude Code 项目记忆

> 此文件 Claude Code 进 hypha/ 自动加载。给未来 session 30 秒入门。
> 详细历史 / 设计稿 → `C:\Users\32043\.claude\plans\hypha-cozy-iverson.md`

## WHY — Hypha 存在的理由

Hypha **不是** chat tutor，**不是** note-taking app，**不是** 课程市场。

Hypha = **认知加速器**。把 LLM 智识带到用户**真实社交场域**的桥。学的每一段最后必须用自己话讲给真人 (Track B) 或亲手做成可被人用的产品 (Track A)，等真人 push back 才算真懂。

破除 3 件事:
1. **工业化教育** — 反对"定义→记忆→测验"流水线 (Feynman 批判靶心)
2. **信息差 + 知识垄断** — 把 frontier 论文 / 顶尖人物思维 / 跨语言知识降到任意 user 都能消化
3. **AI 伪知识 + 不可读推理 + 人格碎片化** (AMD-MEOW-P7+P8, 2026-05-08) — 三层防御:
   - **Anti-Slop (输出层, P7)**: 反 Apparent-Success-Seeking (AI 把没完成包装成完成). 详见 `specs/anti-slop-layer.md` + 蓝图 §24.
   - **Readable Reasoning (推理层, P7)**: 反 Reasoning Opacity (CoT → Thinkish → Neuralese 漂移).
   - **Persona Coherence (人格层, P8)**: 反 Persona Fragmentation (前沿模型 = helpfulness + RLVR + safety + benchmark + sycophancy 训练压力碎片堆). HYPHA 不信任原始模型人格, 工程化构建 Character Contract + Anti-Ingratiation Filter + Persona Coherence Score. 详见 `specs/persona-coherence-layer.md` + 蓝图 §25.
   - Trust 公式: `Capability × Evidence × Reasoning Legibility × Persona Coherence × Failure Honesty`.
   - HYPHA 的护城河 = Course Generation + **Course Verification + Reasoning Monitorability + Evidence Provenance + Knowledge Contamination Control + Trustable Cognitive Character**.

## WHAT — 8-system 架构 (per BLUEPRINT.md, 2026-05-07 reshape)

> 4-module v0.4.3 vintage (Cognitive Graph / Socratic Engine / Frontier Reducer / External Social Sandbox) **subsumed** by the BLUEPRINT 8-system map. Old module names retained as `code-anchor` column where applicable.

> **Ship Progress** (most-recent first):
> - **boot-12 (2026-05-20)** FINAL · v1.0-rc.1 **code-ready** · avg **~83%** · **66 smokes locked** / ~900+ tests / 0 individual fail · **0 hard blockers** (icon.icns landed boot-11 · 224KB · `build/icon.icns`) · operator handoff at `docs/V1_OPERATOR_HANDOFF.md` · status dashboard at `docs/STATUS.md`.
> - boot-11 (2026-05-20): icon.icns shipped + boundary-guards + cleanup-registry + startup-perf + sweep-runner + cross-platform + icns-present + ci-config smokes (+8).
> - boot-10 (2026-05-20): consolidation · 56 smokes · sweep-race documented (4 LLM-bound smokes PASS standalone).
> - boot-9 (2026-05-20): PJR step12 + T2_LOCAL scaffold + Growth dedicated smoke + Evidence Ledger + Build dry-run smokes shipped.
> - boot-8 (2026-05-20): full re-audit · avg ~82% · 52 smokes / 875 tests / 51 PASS / 1 FAIL (now resolved).
> - boot-7 (2026-05-20): Lifetime Ledger + Tier-Budget link.
> - boot-6 (2026-05-20): Auto-Updater + Exam T4_JUDGE + Onboarding.
>
> **⚠ AUDIT NOTICE (2026-05-20 boot-12 FINAL)**: 6th fresh-grep audit. **v1.0-rc.1 code-ready · operator handoff in `docs/V1_OPERATOR_HANDOFF.md`**. boot-12 deltas vs boot-10: **launch-readiness +591 LOC** (308→899 across 3 files: anti-promise-check + checklist + integration-verifier); **cashflow-shield +104 LOC** (466→570); **pricing +47 LOC** (646→693); **anti-slop +1 file** (12→13: `bias-correction-detector.js`); **lesson-body-generator +83 LOC** (1218→1301); **perf/startup-profile.js +116 LOC** (new); **cleanup-registry.js +144 LOC** (new top-level); **+8 new smokes** (`boundary_guards` / `cleanup_registry` / `startup_perf` / `sweep_runner` / `cross_platform` / `icns_present` / `ci_config` / `ui_polish`). **Smoke count locked at 66** (grep `app/scripts/_dev_verify_*.js | wc -l` = 66; boot-12 +2 mid-batch: `lifetime_ledger_consolidation` + `vault_load_perf`). **icon.icns**: 224529 bytes at `build/icon.icns` — boot-10 hard blocker closed. **Sweep-runner caveat carries forward**: 4 LLM-bound + vault-writing smokes (`creation_system` / `full_chain` / `golden_path_e2e` / `route_goal`) collide under concurrency cap=4 + 45s timeout in `_dev_run_all_smokes.js`. All 4 PASS standalone; see `docs/V1_RELEASE_CHECKLIST.md` §2 for the `RUN_SEQUENTIAL` fix. Table ship-% tagged `[VERIFIED 2026-05-20 boot-12 FINAL]`. PURGE_ON_CONTRADICTION (Lens 6) — boot-8 1 FAIL claim refuted by isolated re-run, boot-10 sweep-race confirmed not a regression.

| System | Shipped (v0.11.x) | Aspirational | Code anchor / Spec |
|---|---|---|---|
| **1. Goal System** — Goal Contract / Mode Router / Deadline Cadence / Goal Guardian | **~88% [VERIFIED 2026-05-20 boot-12 FINAL]**: 672 LOC standalone (`feasibility.js` 236 + `goal-guardian.js` 299 + `goal-drift-detector.js` 137) + Crystallizer 在 `creation/goal-crystallizer.js` + `creation/route-goal.js` Pillar 1 dispatcher (single↔chain at difficulty 0.7 threshold) + `creation/goal-guardian.js` mirror; 4 `goal:*` IPC + `goal:crystallize:questions/synthesize/followup`; screen-goal-crystallizer 1 UI; smoke: `goal_crystallizer 62/62` + `route_goal 4/4` (LLM, sweep-timeout vulnerable) + `full_chain 1-2/15` Goal Guardian feasible/absurd PASS standalone | Mode Router (Exam vs Growth vs Hybrid) full coupling — Exam mode dispatch exists, full triple-coupling defer; Deadline Cadence quota (per Lifetime Ledger weekly slot) | `specs/goal-contract.md` (TODO); `app/lib/feasibility.js`; `app/lib/creation/route-goal.js`; `app/lib/creation/goal-crystallizer.js` |
| **2. Lesson System** — Dynamic Lesson + Quality Harness + Jargon Firewall + Prerequisite Patch + Misconception + Anti-Illusion + Evidence + Mastery + Positive Feedback + Assignment Cadence | **~93% [VERIFIED 2026-05-20 boot-12 FINAL]**: 2971 LOC lesson core (`lesson-body-generator` 1301 + `lesson-generator` 670 + `lesson-note` 532 + `lesson-schema-v2` 212 + `lesson-quality-harness` 165 + `lesson-count` 91) + `hypha-learn/` 428 (state-machine + STAKE + answer-leak-guard) + **`anti-slop/` 3923 LOC × 13 files** (boot-12 +1 file: PJR + PJR-streamturn + confidence-leak + concept-ledger + contamination-graph + confession + gap-detector + verify-confession + metaphor-detect + pedagogy-claim + evidence-ledger + **bias-correction-detector** + helpers) + `judges/` 651 (anti-generic + goal-drift + jargon + index) + `critique/` 566 + `quality-harness/` 919; 87+ IPC across lesson/chain/cadence/assignment/concept/mastery/illusion/anti-slop/concept-ledger/evidence families; 5 UI (screen-lesson, screen-lesson-chat, course-trust-panel, knowledge-point-cards, mastery-card); smoke: `lesson_quality_v2 68/68` + `critique` + `concept_ledger` + `chain_surface 10/10` + `chain_plan_shape` + `chain_reroute 8/8` + `tutor_identity 45/45` + `difficulty_scaling` + `literary_archetype 18/18` + `metaphor_detect 19/19` + `contamination_graph` + `prereq_concepts_emit` + `fidelity_scorer 22/22` + **`evidence_ledger` PASS** (boot-10 new) + `full_chain 15/15 PASS standalone` (sweep-timeout vulnerable, not a regression) | Evidence Ledger surface deepening (per-claim hover); Mastery + Positive Feedback engine UI polish; full Anti-Slop v0.5.5 (vector store) defer | `app/lib/hypha-learn/`, `app/lib/hypha-constitution.js`, `app/lib/anti-slop/`, `app/lib/judges/`, `app/lib/critique/`, `app/lib/quality-harness/`, `app/prompts/learn-*.txt`, `app/prompts/lesson-*.txt`, `app/lib/pedagogy.md`, `specs/anti-slop-layer.md` |
| **3. Note System** — 3 sources + Live Capture + Finish Ritual + Active Note + Web Note Engine + Living Note Reactivation + Entropy Reduction + Contamination Graph | **~88% [VERIFIED 2026-05-20 boot-12 FINAL]**: 4031 LOC subdir (`note-system/` 1271 + `web-note-engine/` 1697 + `living-note/` 1063) + `lesson-note.js` 532 + `userProfile.js` + entropy-reduction (in note-system) + `flywheel/note-to-spark.js`; 44 IPC across notes/entropy/atlas/wiki/webnote/livingnote/capture families; 7 UI (screen-notebook, screen-atlas-notebook, screen-dead-notes, screen-capture, note-edge-card, note-reactivation-card, entropy-reduction-card); smoke: `concept_ledger PASS` + `contamination_graph PASS` (lesson-0 quarantine + lesson-2 NOT-quarantined verified) + `graph_rag PASS` (boot-10 new) + dual-layer distill (课程基础 + 用户灵感) + atlas concept tracking + **Living Note Reactivation** (jaccard + LLM) + **Web Note Engine** (5 typed edges + LLM infer) + **Knowledge Contamination Graph** (源失效 → walk DAG → quarantine 下游 lesson) | Entropy Reduction Cycle full surface polish; Note state machine (Raw→Crystallized) full lifecycle UI; cross-vault Note sync (v0.6+) | `vault/<slug>/lesson-NN.md`, `app/lib/userProfile.js`, `app/lib/note-system/`, `app/lib/web-note-engine/`, `app/lib/living-note/`, `events.jsonl` atlas events, `specs/anti-slop-layer.md` M11 |
| **4. Creation System** — Product Pool / Blueprint / Transfer / Spark / Decision Log / Assumption Ledger / Kill Criteria / Roadmap Sync | **~95% [VERIFIED 2026-05-20 boot-12 FINAL]**: 5632 LOC (`creation/` 4402 × 11 files + `creation-system-v1/` 1230 × 5 files: Decision Log + Assumption Ledger + Product Spark state machines + `prediction:{claim, falsifier, deadline_iso}` + Kill Watcher auto-refute + Roadmap Sync LLM weekly + auto-transfer + cadence-hook + spark-priority + extract-from-lesson + expected-years-estimator + route-goal Pillar 1 dispatcher + goal-crystallizer + goal-guardian mirror); 35 IPC `creation:*` / `decision:*` / `assumption:*` / `spark:*` / `kill:*` / `roadmap:*` / `product:*` / `transfer:*` / `flywheel:*`; 7 UI (screen-product-list / screen-product-blueprint / screen-spark-pool / product-spark-card / project-spine-card / decision-ledger-card / roadmap-card + kill-toast); smoke: `creation_system 8/8 PASS standalone` + `expected_years 4/4` + `full_chain` steps 3-10 PASS standalone (Decision/Assumption/ProductSpark/Prediction/Extract/KillWatcher/RoadmapSync) + `golden_path_e2e GP1-GP2 PASS standalone` (sweep-timeout vulnerable — see Checklist §2) | Full Product Pool / Blueprint / Transfer UI surfaces post-v0 polish (~5%) | `specs/creation-system.md`; `app/lib/creation/`; `app/lib/creation-system-v1/`; handlers in `app/main.js:creation:*` |
| **5. Knowledge Source System** — Bibliography Grounding + Library + Longform Distillation + Book Spark Pack + Book Router + Grounding Synthesis + Citation System | **~82% [VERIFIED 2026-05-20 boot-12 FINAL]**: 7360 LOC across 6 subdirs — `source-extractor.js` 377 + `library/` 391 + `distillation/` 1614 + `grounding/` 794 + `citation-system/` 1023 (6 files: citation + copyright-boundary + global-trust + external-link-scanner + coverage + index — was 261 LOC in boot-5, +762 LOC boots-6/7/10) + `harvest/` 3161; 6 UI (screen-library 757 / library-gate 403 / library-workshop 58 / distillation-progress 147 / book-spark-pack 536 / book-reader 356 / grounding-review); 42 IPC across source/library/distill/grounding/book/book-router/citation/harvest; **archetype-aware source lanes** 6×5 priority sources + **文学 staging** (Tolkien + Nobel WAITING); smoke: `citation_full PASS` + `library_coverage 52/52` + `file_converter 18/18` + `url_pinger 6/6` + `hypha_scout PASS` | Phase 4+6 archetype specialization (~40% literary); Commons export gate for Book Spark Pack; Citation per-claim provenance ledger pending streamTurn integration | `app/lib/source-extractor.js` + `app/lib/library/` + `app/lib/distillation/` + `app/lib/grounding/` + `app/lib/citation-system/`; specs/bibliography-grounding.md + specs/library-distillation.md + specs/longform-distillation.md + specs/citation-system.md |
| **6. Commons System** — Knowledge Pack + Pack Intelligence Card + Pack Learning Mode + Pack Security Layer + Pack Distiller + Source Trust + License | **~80% [VERIFIED 2026-05-20 boot-12 FINAL]**: 2800 LOC `app/lib/commons/` × 9 files — pack-loader / pack-schema / pack-distiller / pack-import / pack-export / pack-intelligence-card / security-layer / source-trust / license-layer; 2 packs in `app/lib/commons-packs/` (plato-zh + spinoza-zh) + 1 seed pack `vault/.commons-packs/seed-feynman-method.json` (5 lessons MINDSET); 49 `commons:*` + `pack:*` + `persona:*` + `personas:*` + `corpus:*` IPC (including `commons:pickPackFile` + `commons:deletePack` + boot-7 hardening); 2 UI (`screen-commons.jsx` + `screen-pack-learning.jsx`); smoke: `pack_schema 6/6` + `commons_lifecycle 8/8` + `pack_distiller_hardening 11/11` — Hypha 唯一差异化点 substantially shipped | Pack Distiller LLM hardening (~15% remaining); cross-vault pack-sharing UX (~10%); Author cryptographic signature ed25519 (v2.0); Community ratify / challenge (v2.5); Commons marketplace v2.0+ | `specs/commons.md` (v0.5.0-bootstrap) + `specs/commons-alpha-full.md` + `specs/pack-learning.md`; `app/lib/commons/`; `app/lib/commons-packs/`; `app/design/screen-commons.jsx` + `app/design/screen-pack-learning.jsx` |
| **7. Exam System** — Exam Scope Engine + Exam Resource Layer + Error Diagnosis + Final Compression + T4_JUDGE | **~78% [VERIFIED 2026-05-20 boot-12 FINAL]**: 1859 LOC `app/lib/exam-system/` 6 files — scope-engine 4-tier Must/High-Yield/Recognition/OOS (100%) + exam-cadence 4-mode (calcExamMode) + user-bank CSV/JSON/MD import + error-diagnosis 8-cause taxonomy (70%, heuristic) + final-compression 7-day 5-task plan (85%) + judge.js T4_JUDGE (LLM micro-judge with empty-input reroute regression); α18 envelope variant `app/lib/exam/final-compression.js` co-exists; 22 IPC `exam:*` + `final-compression:*`; 1 UI `screen-exam-dashboard.jsx` 614 LOC; 1 test file `app/__tests__/exam-system.test.js`; smoke: `exam_judge PASS` | Resource Layer Licensed/Public/Synthetic (60% deferred v2.1+); error-diagnosis full LLM cause taxonomy (30% remaining); test.todo body backfill | `app/lib/exam-system/`; `specs/exam-system.md` + `specs/exam-model-alpha.md` |
| **8. Growth System** — Project Spine + Cross-Spark + Thinking Tools + Judgment Gym + Artifact Creation + North Star | **~84% [VERIFIED 2026-05-20 boot-12 FINAL]**: 3056 LOC — `app/lib/growth/` × 7 (1802 LOC: cross-spark / project-spine / judgment-gym / thinking-tools / artifact-creation / bandit-frontier / north-star-metrics) + `app/lib/cross-spark/` × 4 (1254 LOC: engine / thinking-tools / judgment-gym / auto-product-spark); 8 UI (screen-cross-spark / screen-judgment-gym / screen-spark-pool / cross-spark-card / judgment-gym-card / project-spine-card / north-star-panel / artifact-creation-card); 55 IPC spark:* / cross-spark:* / judgment-gym:* / judgmentgym:* / crossspark:* / bandit-frontier:* / project-spine:* / north-star:* / thinkingtools:* / thinking-tools:* / artifact:* / kpi:* / radar:*; smoke: **`growth_system PASS` (boot-10 new — closes boot-8 soft-blocker #3)** + `creation_system 8/8` + `expected_years 4/4` | Cross-Spark cross-curriculum auto-detect (partial); Full Project Spine planner UI polish (partial); Cross-domain literature⇄tech⇄engineering⇄AI graph (extension defer) | `app/lib/growth/`, `app/lib/cross-spark/`; v0.6+ extensions |
| **9. Companion System** — Myco Companion 菌类星人 + Tone Engine + State Expression + Boundary Guard + Emotion Layer | **~64% [VERIFIED 2026-05-20 boot-12 FINAL]**: 1307 LOC `app/lib/companion/` × 7 files (boot-12 unchanged from boot-10 — no real model swap yet, T2_LOCAL stub remains) (boot-9/10 +314: `local-model.js` 296 LOC T2_LOCAL stub + emotion-state/bridge already shipped boot-8); 13 `companion:*` + `companion:local-*` IPC; 1 UI `companion-presence.jsx`; smoke: `emotion_state 13/13` + `emotion_streamturn_wire PASS` + `emotion_tone_bridge 8/8` + **`companion_local_scaffold 11/11` (boot-9/10 new)** | Local Gemma 3 4B T2_LOCAL real model wiring (scaffold landed, model swap is v0.8); T1_EMBED BGE-M3 (v0.8+); multi-session memory continuity; visual State Expression UI polish; Companion auto-greet on first session | `app/lib/companion/`; `specs/companion-myco.md` + `specs/companion-emotion-state-layer.md` + `specs/companion-triggers.md` |
| **10. Infrastructure** — API Governance + Cheap Router + Context Packer + Privacy Memory + Trust + Feedback Channel + Cashflow Shield + Cost Budget + Lifetime Ledger + Auto-Updater + Onboarding + Pricing + Vault + Boundary Guards + Cleanup Registry + Startup Perf + CI | **~82% [VERIFIED 2026-05-20 boot-12 FINAL]**: 7700+ LOC across 16 modules — `app/lib/llm/` × 11 (2104 LOC) + `app/lib/cashflow-shield/` × 2 (570 LOC, boot-12 +104) + `app/lib/infrastructure/` × 3 (947 LOC) + `app/lib/donate/` (272 LOC) + `app/lib/feedback-channel/` (245 LOC) + `app/lib/telemetry/local-tracker.js` (426 LOC) + `app/lib/pricing/` × 2 (693 LOC, boot-12 +47) + `app/lib/auto-updater.js` 386 + `app/lib/onboarding-state.js` 207 + `app/lib/vault-snapshot.js` 245 + `app/lib/vault.js` 576 + `app/lib/vault-meta.js` 126 + `app/lib/vault-context.js` 205 + `app/lib/lifetime-ledger/` 4 files (386 LOC) + `app/lib/launch-readiness/` 3 files (**899 LOC, boot-12 +591**: anti-promise-check + checklist + integration-verifier) + **`app/lib/perf/startup-profile.js` 116 LOC (boot-11 new)** + **`app/lib/cleanup-registry.js` 144 LOC (boot-11 new)** + `app/scripts/_dev_run_all_smokes.js` smoke aggregator + **3 CI workflows in `.github/workflows/`** (smoke.yml / build.yml / release.yml) + **`build/icon.icns` 224529 bytes (boot-11 shipped)**; **573 IPC handlers in main.js** (grep verified); 8 UI (cost-budget-card / screen-cost-budget / screen-donate / privacy-memory-card / screen-onboarding / screen-feedback / screen-lifetime-ledger / screen-launch-readiness); smoke: 27 infra-touching smokes including **`boundary_guards` / `cleanup_registry` / `startup_perf` / `sweep_runner` / `cross_platform` / `icns_present` / `ci_config` / `ui_polish` (boot-11 new ×8)** + cost_ledger / cost_predictor / router_cost_gate / telemetry_local 11/11 / payment_rails / pricing_loyalty / pricing_ui_wire / tier_budget_link / onboarding_flow 15/15 / auto_updater / lifetime_ipc / lifetime_ledger / lifetime_schema / variance / silent_catch_sweep 6/6 / vault_safety / url_pinger 6/6 / validation_mass 5/5 / launch_readiness / build_config / citation_full / build_dry_run | T2_LOCAL Gemma + T1_EMBED BGE-M3 (v0.8 Companion); BYOK Western (post-launch); Payment rails Stripe/WeChat live integration (rails smoke is contract not live); macOS code-signing certs (icon.icns NOW landed); Context Packer per-Lesson budget tuning; sweep-runner concurrency fix (mark 4 LLM-bound smokes RUN_SEQUENTIAL) | `app/lib/llm/` + `app/lib/cashflow-shield/` + `app/lib/donate/` + `app/lib/feedback-channel/` + `app/lib/infrastructure/` + `app/lib/telemetry/` + `app/lib/pricing/` + `app/lib/auto-updater.js` + `app/lib/lifetime-ledger/` + `app/lib/launch-readiness/` + `app/lib/perf/` + `app/lib/cleanup-registry.js` + `.github/workflows/` + `build/icon.icns` + `app/scripts/_dev_run_all_smokes.js`; specs/feedback-donate-cashflow.md 319 LOC v0.1 |

**Cross-cutting mechanisms**:
- **Persona Corpus 蒸馏 ✓ shipped 2026-05-15**: `app/lib/personas/distill-corpus.js` + 5 persona wisdom distilled (karpathy / limu / munger / tao / tolkien, nobel-literature-critic WAITING). `agent.js` injects PERSONA WISDOM block when status ≠ WAITING_DISTILL. Wisdom files at `vault/.persona-wisdom/<id>.md`.
- **Bias Correction** — 关键 claim 必带反方 + 原文链接 + signal-class tag (v0.5.3 patch 待做)
- **Lacquer Loop pedagogy** — 5 retain (P1-P5) + 3 frontier (F1-F3) + P6 prior-install + 3-axis runtime substrate (A1 cure / A2 prediction-log / A3 controller-state); see `app/lib/pedagogy.md`
- **Anti-Slop & Readable Reasoning Layer** (AMD-MEOW-P7, 2026-05-08) — 12 mechanisms across 3 phases: P0 v0.2 (Evidence Ledger / Confession Layer / Gap Detector / Prosecutor-Judge-Rewriter loop / Auditable Reasoning Summary), P1 v0.4 (Reasoning Legibility Score / Limitation-to-Task Converter / Bullshit Density Detector / No-Uncashed-Abstractions / Reasoning-Action Gap), P2 v0.5+ (Knowledge Contamination Graph / Cross-Agent Baton Passing). Course Trust Panel UI 3 layers (default / 展开 / 专家). 详见 `specs/anti-slop-layer.md` + 蓝图 §24. **Source theory** at `C:\Users\32043\Desktop\HYPHA_AntiSlop_ReadableReasoning_Blueprint.md` (canonical, ! 复制原文).
  - **P0 v0.2 Surface tranche, shipped 2026-05-09** (regression pending user pass): Confession Layer ✓ surface (rendered in `/finish` digest as "本节最弱处 — ___" + post-session panel) / Auditable Reasoning Summary ✓ surface (`harnessResult.auditable.structured` consumed by Course Trust Panel default tier) / Gap Detector ✓ surface (`gap_pct` + `apparent_completion / verified_completion` rendered) / 11-field LESSON BRIEF ✓ pre-lesson body generation + designLesson injection (`app/lib/lesson-body-generator.js` + `vault/<slug>/lesson-N.body.json` + `lesson:body:get` IPC) / Goal Drift gate ✓ pre-LessonChat regen-once + `body.drift-warning.json` sibling-write / hook_concrete validator ✓ encyclopedia-opener flag in body validation. Still ◯ lib-only: Evidence Ledger (per-claim provenance, defer v0.4.1) / Prosecutor-Judge-Rewriter loop (defer v0.4 anti-slop expansion).
  - **P1 v0.4 deep-stack, shipped 2026-05-15**: Anti-Ingratiation real scrub (transcript persistence + downstream consumers, NOT stream chunks) / streamTurn 4-detector finally loop (citation-verifier + pedagogy-claim-detector + confidence-leak-detector + anti-illusion) / Prosecute-Judge-Rewrite MVP (math severity + LLM rewrite for mid/high) / archetype gate (HUMANITIES 永不强制 rewrite / LANG-ACQ + MINDSET 只 high 改 / TECH 类继续严) / Course Trust Panel AntiSlopExpert (3-row fire signals + archetype label + gate explanation, lite mode 不依赖 harnessResult).
- **Persona Coherence & Trustable Agent Layer** (AMD-MEOW-P8, 2026-05-08) — 8 mechanisms 3 phases: P0 v0.2 (Character Contract YAML for 3 核心 agent + Anti-Ingratiation Style Filter + 3-dim Persona Coherence Score minimal), P1 v0.4 (Role Drift Detector + Persona Coherence Ledger + Functional × Epistemic enforcement + 8-dim Score full), P2 v0.5+ (Training Shard Map + Drift Recovery Protocol + Agent Registry + Cross-Model Role Audit). 与 P7 Mycelium Immune Pets 同源 (8 菌升 8 Character Contract). Trust 公式: `Capability × Evidence × Reasoning Legibility × Persona Coherence × Failure Honesty`. 详见 `specs/persona-coherence-layer.md` + 蓝图 §25. **Source theory** at `C:\Users\32043\Desktop\HYPHA_Persona_Coherence_Trustable_Agent_Layer.md` (884 lines, canonical, ! 复制原文).
  - **P0 v0.2 Surface tranche, shipped 2026-05-09** (regression pending user pass): Character Contract ✓ surface (`mycelium-professor.json` loaded via `contract-loader` + injected as CHARACTER CONTRACT block in designLesson learn-mode + classic-mode appendix, ahead of LESSON BRIEF) / Anti-Ingratiation: detect ✓ surface (post-stream scan in `streamTurn` 5 callsites + `events.jsonl` row `ingratiation_flagged` + Trust Panel counter) / scrub partial ✓ surface (post-stream `scrubIngratiation` applied to transcript persistence + downstream consumers via `streamTurn` return `{cleaned, violations}`; tutor session jsonl carries `text: cleaned` + `ingratiation_scrubbed: N`, NOT stream chunks to renderer — v0.4 will move to real-time chunk-level scrub via SSE buffer-edit window) / 3-dim Persona Coherence Score ✓ surface (`coherence-score.js` dims rendered editorial register in Course Trust Panel: "本节连贯 · 失误诚实 强 · 反讨好 0次 · 契约 匹配", numerics in `title=` tooltip only). Drift attempts hydration ✓ via `vault/<slug>/lesson-N.body.drift-warning.json` read in panel useEffect.

## 2026-05-15 ship 状态 (5 hours after R5)

- Anti-Slop P0+P1 真接入 streamTurn (4 detector + PJR rewrite + archetype gate)
- Creation System v0.7 v0 + v1.4 v1 完整 (8 spec 8 ship)
- Persona Wisdom 蒸馏框架 + 5 persona distilled (karpathy / limu / munger / tao / tolkien; nobel WAITING)
- Note System Living + Web Engine 起步
- Goal Feasibility Guardian (math floor + LLM judge, absurd / strained / feasible 3 档)
- Course Trust Panel AntiSlopExpert lite mode (不依赖 harnessResult)
- 文学 archetype source lane 起步
- Cost-ledger 4-class UI 诚实标 (provider / tokenizer-fallback / placeholder / legacy)
- ~80 个新 IPC handler / preload bridge 累计
- 测试: `app/scripts/_dev_verify_full_chain.js` (β12 同步 ship)

## HOW — 关键文件路径地图

### Backend
- `app/main.js` — Electron main, IPC 总入口 (curriculum:create / chain:create / llm:lesson / source:* / url:fetchBatch / settings:* )
- `app/agent.js` — LLM 调用层 (designLesson / streamTurn / harvest / planChain / classifyAll / 12 personas 注入)
- `app/lib/anthropic-adapter.js` — Anthropic SDK 直连 (extended thinking 8000 budget 默认开)
- `app/lib/providers.js` — provider config (claude-cli / anthropic-sdk / glm / hypha-managed); claude-cli 用 `--effort xhigh`
- `app/lib/hypha-constitution.js` — `FULL` (~600 tokens) 注 system prompt (manuscript register + GOAL BINDING + FEYNMAN TEST + VISUAL AID + FORBIDDEN + voice clamps)
- `app/lib/source-extractor.js` — 多文件 PDF/MD/TXT/URL 抽取; 200MB per-file / 8 files / 800MB total cap
- `app/lib/feasibility.js` — chain 可行性数学 (Macnamara/Donner-Hardy/Newport 据)
- `app/lib/hypha-learn/` — Hypha Learn 模块 (state-machine / stake-block / answer-leak-guard)

### Frontend (Electron renderer)
- `app/ui_kits/ptor-app/TabContent.jsx` — `HyphaEvolutionWelcome` 创课表单 (topic / goal / source / URLs / mode radio / advanced feasibility 字段)
- `app/ui_kits/ptor-app/NoteView.jsx` — `LessonChat` 课程聊天界面 + ChatBubble + state-tag rendering + 内联 SVG 渲染
- `app/ui_kits/ptor-app/ChainPlannerView.jsx` — chain plan 模态 (4-stage 流程 + 接 v0.4.1 advanced 字段)
- `app/ui_kits/ptor-app/VaultTree.jsx` — 左侧课程树 + 语言面板

### Prompts
- `app/prompts/lesson-start.txt` + `lesson-turn.txt` — Classic mode tutor prompts (诚实武装迁移完成 2026-05-15: GROUNDING / NO INVENTED CITATIONS / VERBATIM BAN / BIAS CORRECTION / CONFESSION / SELF-SCAN / 第三人称禁 — 与 learn mode 对齐, state machine + Lacquer primitives 剥除)
- `app/prompts/learn-start.txt` + `learn-turn.txt` — Hypha Learn mode (含 STAKE block / state machine markers / A' positive injunctions / pulse cadence / Feynman test)
- `app/prompts/hypha-handbook-zh.md` — 8 岁可读用户手册 (从 user 视角)

### Data (vault, user-side)
- `vault/<topic-slug>/state.json` — curriculum state (lessons / archetype / language / concepts)
- `vault/<topic-slug>/sources.json` — chapter-shaped 知识源 (含 sourceType: user-upload / user-url / web)
- `vault/<topic-slug>/lesson-NN.md` — 每课双层笔记 (课程基础 + 用户灵感, frontmatter 含 learn_mode)
- `vault/<topic-slug>/sessions/L<idx>-<ts>.jsonl` — 每节课对话 transcript + meta row (含 claude_session_id for v0.3.0+ session 继承)
- `vault/<topic-slug>/agent.json` — `{persona, customInstructions, displayName}` per-curriculum
- `vault/data/profile.json` — `{name, about}` 全局 user profile (driving classifyPriorKnowledge)
- `vault/.persona-wisdom/<id>.md` — **(v0.5.1 待建)** 蒸馏 corpus 文件夹

## 关键 conventions

### 路径 & 平台
- Windows-first; PowerShell + Bash 双兼容; `npm run pack:win` / `:mac` / `:linux`
- `release/build-hypha-learn-vX.Y.Z/` — 历史版本 archive (不删, 留对比)
- `Hypha-personal.bat` 启 (HYPHA_ALLOW_CLI=1, 解锁 claude-cli provider)

### Provider 行为

**Two parallel layers — do not mix.**

#### Layer A · capability-class router (`app/lib/llm/`, v0.1+ default)
Used by lesson plan / lesson body / scoring (Phase D 2026-05-08+) and any new caller.

```js
const { executeChat } = require('./lib/llm');
const dispatch = await executeChat('T3_MID', { messages, json: true, ... });
// → { result, providerId, model, capability, attempts }
```

`executeChat(capability, chatArgs)` runs DispatchPolicy weighted random pick across GLM/DeepSeek/Kimi, retries up to 3 providers on 5xx/timeout/429, marks the failed providers in ProviderHealth (90s/3-error sliding window). Recovery ping fires every 5 min on degraded providers. See `app/lib/llm/router.js`.

Backward-compat helper `getCapabilityModel(capability)` is auth-time-only fallback (Phase B/C) — kept for callers that need to manage their own retry. Phase D callers should prefer `executeChat`.

#### Layer B · legacy `providers.js` + `anthropic-adapter.js` (`app/agent.js` only)
Shipped pre-v0.1 for the lesson chat / harvest / classifyAll path.

- **provider=claude-cli** = 纯 Terminal claude 体验:
  - sandbox env 隔离 (CLAUDE_CONFIG_DIR / HOME → cli-sandbox/), 剥离 Victor 宇宙
  - 不传 `--system-prompt` flag; constitution 不发
  - 必须自己在 user-msg 注入 persona / VISUAL AID / GOAL BINDING / Feynman test
  - session 继承: stream-json 抽 session_id, 后续 turn 走 `--resume <id>`
  - effort `xhigh` 思考预算
- **provider=anthropic SDK** = Hypha 完整模式 (constitution + persona + state machine 全注)

`agent.js` migration to capability-class router is deferred — works today, no urgency to break it.

### Brand register (constitution-enforced)
- Manuscript register: italic EB Garamond + Noto Serif SC on cream paper, brass hairlines
- FORBIDDEN words: AI / LLM / embedding / model / prompt / agent / RAG / vector / fine-tune (用 domain term 替代)
- 禁 zh AI 流量词: 这一刀 / 闭环 / 拉满 / 王炸 / 杀疯了 / 干货 / 直击灵魂 / 上分 / 上车 / 上岸 / 内卷 / 出圈 / 真香 / yyds / 绝绝子
- 禁: emoji / 感叹号 / "great question!" / 第三人称 ("用户...")
- voice: 你 (peer-level) / Garamond cadence / 慢且 dignified

### Pedagogical rules (binding)
- **GOAL BINDING**: 每概念必须可追溯服务 learn_goal, 不 → 砍
- **FEYNMAN TEST**: 定义 = START 不是 END; 测理解用 "apply X to instance" 不用 "what is X"
- **forbidden anti-pattern**: 3 定义连排 + 1 测验 = 考试不是课
- **VISUAL AID**: 数学/几何/向量/网络/状态机 topic 用 ```svg``` 围栏块输出, Hypha 内联渲染

## LLM 7-tier 路由 (v0.1, Phase D 2026-05-08)

Per BLUEPRINT §17.2.1 + AMD-MEOW-P4. Capability classes route to model picks via DispatchPolicy weighted random + ProviderHealth runtime fallback.

### Capability classes (shipped v0.1)

| Class | Use | DispatchPolicy 60/30/10 |
|---|---|---|
| **T6_STRONG** | Lesson Plan + Body + Cross-Spark | GLM-5.1 / DeepSeek-V4-Pro / Kimi-K2.6 |
| **T4_JUDGE** | Quality Harness micro judges | GLM-4.5-Air / DeepSeek-V4-Flash / Kimi-K2.6 |
| **T3_MID** | Pack 初筛 / Drift 二审 / scoreMicroProof | GLM-4.5-Air 70% / DeepSeek-V4-Flash 30% (Kimi reserved for T6 长上下文 niche) |

Deferred:
- T5_PACK — algorithmic, no LLM
- T2_LOCAL — Gemma 3 4B local Ollama (v0.8 Companion)
- T1_EMBED — BGE-M3 local (v0.8+)

### Provider Health (runtime fallback)

`router.js` keeps an in-process Map of per-provider health records. Triggers:
- DOWN: 90s sliding window ≥ 3 5xx/timeout errors, OR 429 retry-after > 60s → `state='degraded'`
- RECOVERY: 5min interval pings each `degraded` provider with a 200-token "pong" call; 1 success → `state='healthy'`

`pickWeighted()` excludes `degraded` providers from the random pool. If the entire pool is degraded, last-ditch falls through to the first non-excluded entry.

### Env vars

| Provider | Env var | Endpoint |
|---|---|---|
| GLM | `GLM_API_KEY` | https://open.bigmodel.cn/api/paas/v4 |
| DeepSeek | `DEEPSEEK_API_KEY` | https://api.deepseek.com/v1 |
| Kimi (Moonshot CN) | `KIMI_API_KEY` | https://api.moonshot.cn/v1 |

Provider constructors `.trim()` env values to defend against PowerShell `>>` continuation baking `\n` into User env (a `Bearer sk-...\n` is rejected by Node http as invalid header → opaque "Connection error").

Set permanently:
```powershell
[System.Environment]::SetEnvironmentVariable("GLM_API_KEY", "sk-...", "User")
[System.Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "sk-...", "User")
[System.Environment]::SetEnvironmentVariable("KIMI_API_KEY", "sk-...", "User")
```
Restart the calling process (Claude Code / Electron / PowerShell) after changing User env — it is read at process spawn.

### Verify (read-only)

```powershell
cd E:\victor\hypha
node -e "(async()=>{ const llm=require('./app/lib/llm'); console.log('Providers:',llm.listProviders()); for (const cap of ['T6_STRONG','T4_JUDGE','T3_MID']) { const got=await llm.executeChat(cap,{messages:[{role:'user',content:'pong'}],maxTokens:200,temperature:0}); console.log(cap,'=>',got.providerId,got.model,'attempts='+got.attempts); } console.log('health:',JSON.stringify(llm.getProviderHealth(),null,2)); })();"
```

Expected: each capability resolves to a provider, returns "pong" content, all health states = `healthy`.

## Pricing v3 (2026-05-08, Founders Path E)

5-tier with qualification + accelerating loyalty floor. Free / Basic ¥39 / Pro ¥99→¥69 floor / Founders ¥499 once / BYOK ¥0.

Source of truth = `Desktop\HYPHA_final_blueprint_and_evolution_roadmap.md` §19.1 AMD-MEOW-P5. **Do not duplicate the rate table in this file** — copy will rot. Read the blueprint when implementing pricing engine, Founders loyalty curve, or Cadence quota coupling (P6 §8.1).

Founders implementation hook (deferred): `vault/data/profile.json` adds `founder_purchased_at` (timestamp) + pricing engine reads `years_since` to pick Pro discount tier (¥99 / ¥80 / ¥69 floor for general Pro; ¥99→¥69→¥49→¥29 floor for Founders).

## 常用命令

```powershell
# Dev
cd E:\victor\hypha
npm install
npm start                      # Electron dev
npm run pack:win               # 打包 Windows portable

# 验证 syntax
node --check app/main.js
node --check app/agent.js

# 检查 vault 状态
ls vault/<slug>/sessions/
cat vault/<slug>/state.json
```

## 开发流程

1. 改前看 plan file 的 Appendix A-E (在 `C:\Users\32043\.claude\plans\hypha-cozy-iverson.md`) — 理解过往设计决策
2. 改时:
   - **Surgical** — 每行改动必须可追溯到当前任务
   - 不动 `vault/` 任何文件 (那是 user 数据)
   - `app/lib/hypha-constitution.js` 改要慎重 (影响所有 SDK 路径)
   - claude-cli 路径 (Pure CLI mode) 走 user-msg 层注入, 不走 system prompt
3. 改后:
   - `node --check` 全部碰过的 .js
   - JSX 用 esbuild 或 brace-balance 验
   - `npm run pack:win -- --out=release/build-hypha-learn-v<X.Y.Z>` 出新 build (留旧 build)
4. 不动现有 41 unstaged hypha files (user 进行中工作)

## v0.5+ 路线 (按优先级)

1. **v0.5.1** Persona Corpus 蒸馏 — ✓ shipped 2026-05-15 (蒸馏框架 + 5 persona wisdom distilled: karpathy / limu / munger / tao / tolkien; nobel-literature-critic WAITING)
2. **v0.5.3** Bias Correction — ✓ shipped 2026-05-19 v0.4.8 lite (single→multi source detection in Anti-Slop layer); full constitution 段 + per-claim 反方原文链接 + signal-class tag 仍 ! ship
3. **v0.4.x continuity** — ✓ shipped 2026-05-19: concept ledger (v0.4.12, `app/lib/anti-slop/concept-ledger.js` pure-JS cross-lesson) + chain multi-link surface (v0.4.9-11, `chain.parent_chain_slug` canonical + Home ULTIMATE + Trust Panel ULTIMATE row) + Trust Panel surface deepening (v0.4.6-v0.4.13, gated_by_archetype 角章 / cost-summary / editGoal history / exit-ramp / 概念一致 row)
4. **v0.5.0** External Social Sandbox (Track A 课程=产品 + Track B 笔记+发布) — Hypha 唯一差异化, P1
   - design 文档 ✓ shipped 2026-05-19 (`specs/track-a-b-social-sandbox.md` 607 lines)
   - MVP stub ✓ shipped v0.4.13 (`app/lib/util/track-ramps.js` validator/aggregator + track:set-exit-ramp / track:get-status IPC + screen-lesson-chat.jsx 离场仪式 3 buttons + Trust Panel surface)
   - URL validation harness ! ship (defer 5d 独立 slice)
5. **v0.5.2** Frontier Scheduler — cron 周期抓 + Tavily fallback, P3
6. **v0.6+** True Cognitive Graph (linear chain → node graph; **Note System Web Engine typed-edge 已起步 2026-05-15**), 母语降维显式指令, sub-agent 真化

详见 `C:\Users\32043\.claude\plans\hypha-cozy-iverson.md` Appendix E。

## 当前 ship 状态 (2026-05-20 boot-12 FINAL)

- **Code**: v0.11.2 in `package.json`; **v1.0.0-rc.1 code-ready**. Release tag + DMG/exe build = operator action. See `docs/V1_OPERATOR_HANDOFF.md` + `docs/STATUS.md`.
- **Smoke baseline**: 66 verify scripts under `app/scripts/_dev_verify_*.js` (grep verified) / ~900+ assertions / 66 PASS standalone / 4 sweep-race artifacts in aggregator (none real regressions, all 4 PASS alone).
- **CI**: smoke.yml + build.yml + release.yml in `.github/workflows/` (matrix linux/win/mac); CODEOWNERS + dependabot wired (verified by `_dev_verify_ci_config.js`).
- **Build assets**: `build/icon.icns` (224529 bytes, ready) + `build/icon.ico` + `build/icon.png` + `build/icon@512.png`. macOS code-signing certs + Apple Developer credentials still operator-side (not code blockers).
- **Old build artifact**: stale v0.4.3 at `release\build-hypha-learn-v0.4.3\Hypha-personal.bat` — superseded by electron-builder pipeline; new builds land in `dist/`.
- **Avg ship-% across 10 systems: ~83%** (Goal 88 / Lesson 93 / Note 88 / Creation 95 / Source 82 / Commons 80 / Exam 78 / Growth 84 / Companion 64 / Infra 82).
- **Hard blockers: 0** — code ready. Open items = operator handoff (signing certs / CI secrets / tag push). See `docs/V1_OPERATOR_HANDOFF.md`.

累积 Appendix A (planChain retry) + B (multi-file source) + C (claude-cli pure passthrough) + D (session 继承) + 一系列 patches (effort xhigh / Pure CLI radio / SVG 渲染 / opener 反转 / GOAL BINDING / FEYNMAN TEST)。

### v0.4.6 — v0.4.13 累计 ship (18+ GAP, 2026-05-19 多 session 并行 agent batch)

**v0.4.6** — Trust Panel + resilience tranche
- Trust Panel gated_by_archetype 角章 + lesson:finish 1-retry + NotebookScreen thin_warning UI

**v0.4.7** — 编辑目标 + 系列分组 + 前沿露底 + pacing dedup
- course:edit-goal IPC + state.series 字段 + frontier:status IPC + state-machine bridge dedup

**v0.4.8** — Bias v0.5.3 + 强制改写 cost + tooltip + dismiss + edge + frontier 多源
- Bias Correction v0.5.3 (single→multi source detection) + anti-slop:cost-summary IPC + gate row tooltip + thin_warning 永久 dismiss + progressLabel 三零态 + frontier.md → spark-hits.json fallback

**v0.4.9** — Chain Multi-Link Surface + hidden bug fix
- course:edit-goal 同步 chain.json (hidden bug fix) + chain:get + chain:edit-ultimate IPC + curriculum:list 扩 chain 字段 + Home ULTIMATE + feasibility badge + chain mini-bar role 染色 + Trust Panel ULTIMATE row + Chain Plan role 中文化

**v0.4.10** — Util shared + dedup
- `app/lib/util/relative-time.js` shared formatter + editGoal history (localStorage trace 10-entry cap, surface in Trust Panel) + italic register audit (per `italic_decoration_only` feedback, -22 lines action italic removed) + Tooltip 组件 (portal-style, replace title= in 3 sites) + toast unified (canonical move to `app/design/toast.jsx`)

**v0.4.11** — parent_chain_slug 跨课 chain
- `chain.parent_chain_slug` 字段 (canonical, 替 state.series 字符串 hack) + course:set-parent-chain IPC + course:set-series dual-write + `app/lib/util/chain-validators.js` + `_dev_migrate_series_to_chain.js` 一次性 migration + Home effectiveSeries 读取

**v0.4.12** — Anti-Slop v0.5.5 lite (concept ledger)
- `app/lib/anti-slop/concept-ledger.js` pure-JS cross-lesson concept extractor (! LLM, ! vector store) + concept-ledger:get IPC + Trust Panel 概念一致 editorial row

**v0.4.13** — Track A/B Exit Ramp MVP (stub)
- `specs/track-a-b-social-sandbox.md` design 文档 (607 lines) + `app/lib/util/track-ramps.js` validator/aggregator + track:set-exit-ramp + track:get-status IPC + screen-lesson-chat.jsx exit ramp UI (3 buttons 离场仪式, after /finish) + Trust Panel exit-ramp surface
- ! URL validation harness (defer v0.5.0+ full Track A/B impl)

### Smoke 全过 (273/273)
- lesson_quality_v2 68/68 (BC1-BC13)
- chain_surface 10/10 (CS1-CS10)
- concept_ledger 35/35 (CL1-CL5 sub-checks)
- track_exit_ramps 6/6 (TE1-TE6)
- fidelity_scorer 22/22 + goal_crystallizer 62/62 + library_coverage 52/52 + file_converter 18/18

### 已 defer (! 这批)
- LLM-judge per-turn 真假判定 (v0.6+, cost-heavy)
- Pacing realtime per-turn (v0.6+, streamTurn refactor)
- Track A/B URL validation harness (v0.5.0+, 5d 独立 slice)
- vault.delete trash + recovery (destructive, 需 user 设计 confirm)
- regen cascade on ultimate-goal 改 (¥0.5/课 cost gate)
- Anti-Slop v0.5.5 full (vector store, 5d 独立 slice)

### 历史 reference

**v0.2 Surface tranche — shipped 2026-05-09** (3-Machino parallel team mode; per `C:\Users\32043\.claude\plans\fluffy-hugging-swan.md`):
- Backend: `app/lib/lesson-body-generator.js` (NEW, 11-field body schema + drift gate + hook_concrete validator) + `app/agent.js` (Anti-Ingratiation post-stream scan + Character Contract injection + LESSON BRIEF injection) + `app/main.js` (`lesson:body:generate` + `lesson:body:get` IPC + drift-warning sibling-write + curriculum-create auto-fire on lesson 0)
- UI: `app/design/screen-lesson-chat.jsx` (ChainHeader thesis row + `/finish` confession line) + `app/design/course-trust-panel.jsx` (3-dim coherence editorial line + drift anchor editorial line + drift-warning attempts hydration)
- Out of scope (deferred to v0.4.1+): Evidence Ledger / Prosecutor-Judge-Rewriter loop / Reasoning Legibility Score / 8-dim full coherence / Persona Corpus distillation (v0.5.1)

## 不要做的事

- 不发明 v0.5+ 新功能未对齐 plan file Appendix E
- 不写 sycophantic / 营销话术 (e.g. "克隆 Einstein" — corpus 不够, 别承诺)
- 不加 SaaS-y gamification (% 进度条 / 徽章弹窗 / 等级系统) — 违 manuscript register
- 不动 vault/ (user 数据) 除非显式被要求
- 不删 sandbox env 隔离 (Pure CLI 路径必须保留 Victor 宇宙隔离)
- 不绕 plan workflow ship 大重构 — 必须先写 Appendix
