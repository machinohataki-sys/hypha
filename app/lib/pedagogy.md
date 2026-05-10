# Hypha Pedagogy — Lacquer Loop v0

Status: spec, pre-pilot. 2026-05-01.
Origin: 2026-05-01 design synthesis combining curing-substrate substrate work with frontier-digest research scan.
Use: `app/agent.js:325` designSequence ingests Layer-1 directives; runtime engine reads Layer-2 schema; domain router (Layer-3) gates emphasis.

## Thesis

8 popular methods (Feynman / Cornell-5R / Imitation / SQ3R / Pomodoro / Inquiry / Ebbinghaus / FASTER) ≠ 8 peer mechanisms.
2024-2026 evidence shows them = 4-5 underlying primitives repackaged across decades.
Fusing as 8 equals → triple-implements Review/Recite/Teach + misses LEARNER-STATE-AWARE SCHEDULING (the actual 2025 frontier axis).
Lacquer Loop = cull (drop 2 unvalidated), retain 5 residues, add 3 frontier primitives, mount on 3-axis runtime substrate, route by 5 domain archetypes.

## Layer 1 — Design-Time Primitives

Each primitive = (1) named directive injectable into designSequence sys-prompt, (2) 2024-2026 anchor, (3) per-lesson outcome signal.

### P1 — EXPLAIN-TO-LEARN  (费曼 residue + AI-bot child)

- Mechanism: forced collapse of hidden complexity via target-audience constraint. AI-as-skeptic-child supplies real audience pressure.
- Anchor: arXiv 2506.09055 — "Learn Like Feynman: AI-Driven Feynman Bot" (2025). Higher gain + lower variance vs passive study.
- Design-time directive: "Each lesson MUST end with a 1-paragraph explain-to-child block where the tutor invites the learner to re-state the lesson's claim in plain language; the agent then probes one ambiguity."
- Per-lesson signal: explanation_attempts[].clarity_score (0-1, judged by tutor LLM).
- Replaces: Feynman + FASTER-Teach (collapsed; same mechanism).

### P2 — PRE-READ PREDICTION  (SQ3R-Q residue, predictive-coding reframe)

- Mechanism: ask learner to PREDICT the answer/mechanism BEFORE exposition; prediction-error magnitude is the high-value learning signal (predictive coding: surprise drives plasticity).
- Anchor: Karpicke 2025 retrieval review (Purdue) + cross-domain neuroscience.
- Design-time directive: "Lesson opens with one prediction prompt: a concrete claim/mechanism/answer the learner forecasts BEFORE the canonical reveal. Tutor records prediction verbatim."
- Per-lesson signal: prediction_log[] entry {predicted, actual, delta_norm}.
- Replaces: SQ3R-Survey + SQ3R-Question (collapsed; same priming function).

### P3 — CUE-RETRIEVAL  (Cornell + SQ3R-Recite residue, 2-into-1 collapse)

- Mechanism: cue-prompt forces retrieval against blank; learner produces, then compares vs canonical. The cue-column abstraction lifts beyond paper.
- Anchor: Springer 10.1186/s40862-025-00347-8 (2025) — Cornell only delivers gains when scaffolded; raw template = null effect.
- Design-time directive: "After main exposition, tutor presents 2-3 cue prompts (concept-name, scenario, mechanism question) WITHOUT the answer; learner responds; tutor reveals canonical + flags discrepancies."
- Per-lesson signal: retrieval_attempts[] {cue, learner_response, canonical, match_score}.
- Replaces: Cornell-Recite + SQ3R-Recite + FASTER-Review (3→1).

### P4 — SCAFFOLDED INQUIRY  (Inquiry residue, hybrid 2025 recipe)

- Mechanism: inquiry-then-retrieval-then-instruction. Pure inquiry under-delivers; hybrid (learner question → retrieval test → tutor instruction) is the 2025 winning configuration.
- Anchor: EJMSTE 2025 meta (k=36, ES=1.27 critical thinking) + Springer ETRD 10.1007/s11423-025-10507-9.
- Design-time directive: "When introducing a non-trivial concept, tutor first asks 'what would you ask first about X' and rubric-grades the question (depth/specificity). Tutor then runs P3 retrieval on the implicit pre-knowledge before delivering instruction."
- Per-lesson signal: inquiry_log[] {learner_question, rubric_score, tutor_response_type}.
- Replaces: Inquiry-based + Cornell-cue-column-as-question.

### P5 — EXPERTISE-AWARE IMITATION  (Imitation residue, faded worked-examples)

- Mechanism: novices learn from worked examples; experts get HURT by them (expertise reversal). Assistance must fade as learner mastery rises.
- Anchor: ScienceDirect S0959475225000660 (2025 meta, 176 effect sizes, n=5924).
- Design-time directive: "When demonstrating a procedure, gate the presentation by learner.mastery_for_topic: < 0.3 = full worked example, 0.3-0.7 = partial example with 1-2 steps blanked, > 0.7 = problem only, no example."
- Per-lesson signal: imitation_mode (full / partial / pure-problem) + learner.mastery_at_lesson.
- Replaces: Imitation + Worked-Examples literature.

### F1 — PRODUCTIVE FAILURE  (Kapur 2024, frontier add)

- Mechanism: hard-problem-FIRST, instruction-AFTER. The unsuccessful attempt activates prior knowledge + creates failure-driven encoding that beats direct instruction on transfer tasks.
- Anchor: Kapur 2024 Productive Failure book + 160 experimental comparisons; SXSW EDU 2025.
- Design-time directive: "For every conceptually-deep lesson (mark in syllabus), generate a hard variant problem the learner attempts BEFORE seeing the canonical method. Failure trace persists as state."
- Per-lesson signal: pf_attempts[] {problem, learner_attempt, canonical, transfer_lift_estimate}.
- Domain-restricted: HIGH for TECH-CONCEPT, TECH-PROC; SKIP for DECL-MASS.

### F2 — HYBRID INTERLEAVING  (block-then-interleave, 2025 refinement)

- Mechanism: pure interleaving hurts low-achievers early; pure blocking misses category-boundary learning. Hybrid = block early lessons of new topic → interleave once basics settle.
- Anchor: Wiley Lang Learn 10.1111/lang.12659 (2025); ScienceDirect S1041608025001803 (adaptive interleaving).
- Design-time directive: "Within each ~10-lesson phase: lessons 1-5 = blocked on single sub-topic (mastery floor); lessons 6-10 = interleaved across the phase's sub-topics for category discrimination."
- Per-lesson signal: lesson.interleave_mode (blocked / interleaved) + lesson.subtopic_mix.

### F3 — CALIBRATION LOOP  (CHI 2025 frontier add)

- Mechanism: predict-confidence then verify; gap between predicted and actual mastery drives next-lesson selection. Overconfident learners benefit MORE (+4.1pp on top of +8.9pp baseline).
- Anchor: CHI 2025 10.1145/3706598.3713960 (AI calibration loop) + Springer IJAIED 10.1007/s40593-025-00514-5.
- Design-time directive: "End every lesson with a calibration prompt: 'How confident are you that you can [learnGoal] right now?' (0-100). Tutor logs against P3 retrieval score; gap > 30 → flag for next-lesson re-derivation."
- Per-lesson signal: calibration_log[] {predicted_confidence, actual_score, gap}.

### P6 — PRIOR-INSTALL  (Karpathy lecture pattern + LEO information-theoretic floor + Kapur PF boundary, council 2026-05-04)

- Mechanism: pre-prior probes carry `I(answer; question) ≈ 0` because the learner's prior over concept-space is uniform — the question reduces uncertainty that doesn't exist. P6 installs a non-uniform prior so subsequent P2/P3/P4 primitives carry information. **Teacher-says-MORE principle**: the teacher's job is NOT to extract a concept the learner doesn't have; it IS to deliver the concept (richly, with analogy and concrete instance), THEN deepen via probing. Saying less ≠ pedagogy; saying more on a foundation triggers more effective thinking.
- Anchor: Karpathy public-lecture pattern (motivate → define → derive → worked-example → checkpoint) + Kapur 2024 PF boundary (PF requires scaffolded contrast, not raw cold-start) + arXiv 2509.09840 CHI 2026 ownership-priming + npj Sci of Learning PMC6435728 (PF fails for low-prior novices).
- Design-time directive: "When the lesson's central concept has no anchor in `state.concepts[concept_id]` AND no mention in `priorNotes`, the tutor's first turns MUST install a usable prior via this 4-stage arc BEFORE any probe / prediction / inquiry primitive fires.
  **DENSITY PER STAGE (binding)** — each stage must be substantive, Claude-Code-terminal-depth (per HYPHA constitution DEPTH LATCHING). A thin stage = noise, not signal. Total opening = 600-1200 字 (中文) or 250-500 words (English). Saying less ≠ pedagogy. The student should leave each stage feeling 'ok, that's a real concept, not a tease'.
  1. **DEFINE** — 2-4 paragraphs. Name + plain definition + **enumerate the concept's main forms / sub-types / variants when they exist** (e.g., for 'leverage': name labor / capital / code / media as 4 forms with 1-line each; for 'Q/K/V': name each matrix's role + their relationship). Hand the student a structured map, not a tease line.
  2. **ANALOGIZE** — 2-4 paragraphs. Concrete analogy that gives the concept a body, **plus at least ONE numerical instance OR A-vs-B structural contrast** that lets the student feel the mechanism operate. Example for leverage: '你 1 万自有，借 9 万，凑 10 万买股票。涨 10% 卖出还本金 9 万 → 你手里剩 2 万 (100% 回报)。不借，1 万买同股票，涨 10% 你赚 1000 (10% 回报)。同样市场动一格，你的钱包动十格。' Include the contrast.
  3. **CHECK** — pose ONE concrete instance test that REQUIRES the learner to compute, specify, or predict — NOT 'what do you think?' or 'does that make sense?'. Examples: '如果上面那笔 10 万跌 10%, 你手里剩多少？算给我看。' / '给定 Q 完全不匹配任何 K, attention 输出应该是什么？' / '哪种 form 适用于条件 C？为什么？'. **WAIT for the learner's reply BEFORE proceeding to EXTEND** — do not pre-emptively answer your own CHECK in the same turn.
  4. **EXTEND** — fires ONLY after the learner replies to CHECK. Then introduce the next deeper layer with its own mini-arc (mini-define → mini-instance → connect to prior). For leverage this is asymmetric companion concepts (Permissioned vs Permissionless / Power Law / Barbell strategy) presented as 'now that 杠杆 lands, here's the twin you also need: 不对称回报...'. Density: 2-4 paragraphs. Optionally close with a Feynman-back invitation ('用你自己的话把整套机制讲一遍, 我看你哪里不准').
  When P6 fires, emit a single inline marker `<!-- p6: introduced concept_id=X -->` in the FIRST turn so lesson:finish can persist `state.concepts[X]`."
- Per-lesson signal: `prior_install_log[] = { concept_id, define_text, analogize_text, check_method, check_passed, extend_kind, ts }`.
- Supersedes: P2 (pre-read prediction) and P4 (scaffolded inquiry) at first-turn invocation when prior is empty. Once P6 completes (state.concepts[concept_id] populated), normal P2/P4 resume on subsequent turns.
- Replaces: nothing (additive primitive; pedagogy.md previously lacked any tutor-side prior-installation directive — discovered as missing primitive by Leo first-principles council 2026-05-04).

## Layer 2 — Runtime Substrate

Three persistent axes. State lives in `<vault>/data/state.json` (extend existing schema, do not replace).

### A1 — CURE-CLOCK  (FSRS / LECTOR-style adaptive spacing)

- Replaces: Ebbinghaus 1885 fixed forgetting curve.
- Anchor: arXiv 2508.03275 LECTOR (2025) — concept-level (not card-level) scheduling, 90.2% vs SSP-MMC 88.4%.
- Schema:
  ```
  state.concepts[concept_id] = {
    last_layer_at: ts,
    cure_window_ms: int,    // dynamic, FSRS-like, per-concept
    layer_count: int,        // # times this concept has been re-touched
    half_life_estimate_ms: int
  }
  ```
- Trigger: scheduler skips a concept if `now < last_layer_at + cure_window_ms`. Re-touch resets layer_count++ and adjusts cure_window via FSRS update rule on retrieval success/fail.
- Lacquerware analogy: each concept = lacquer layer; cure window must elapse before next layer adheres; rushing = bubbles (interference).

### A2 — PREDICTION-LOG  (operationalizes F3 + drives A1)

- Schema:
  ```
  state.concepts[concept_id].prediction_log[] = {
    ts, predicted, actual, delta_norm, lesson_id
  }
  ```
- Trigger: every P2 + P3 + F3 event writes to log. delta_norm magnitude feeds A1 (large delta → shorter cure_window) and lesson selection (large delta on prerequisite → block downstream lesson).

### A3 — CONTROLLER-STATE  (Two-Challenge Rule, deferred to W4+)

- Mechanism: cockpit aviation 2-challenge protocol. After 2 consecutive high-error retrievals on same concept, AGENT seizes control: drops 1 abstraction layer + restarts cure-clock.
- Anchor: Lung cross-domain (aviation safety) + 2026 asymmetric mastery gradients (non-mastery > mastery, per arXiv 2507.18882 ITS review).
- Schema:
  ```
  state.concepts[concept_id] = {
    ...,
    controller: 'LEARNER' | 'AGENT',
    strike_count: int,
    last_strike_at: ts
  }
  ```
- Trigger: 2× P3 retrieval below threshold within 3 lessons → controller := 'AGENT', next lesson re-teaches at lower abstraction. controller flips back to 'LEARNER' on next successful retrieval.
- DEFERRED: ship A1+A2 first (W3); A3 only after W4 pilot validates.

## Layer 3 — Domain Router

5 archetypes (set on curriculum creation by 1 LLM classification call before clarifyQuestions).

| Primitive | LANG-ACQ (英语/日语) | TECH-CONCEPTUAL (LLM/物理/认知) | TECH-PROCEDURAL (码/lab) | HUMANITIES (哲/文/史) | DECL-MASS (词汇/解剖/法条) |
|---|---|---|---|---|---|
| P1 explain  | HIGH | HIGH | MED | HIGH | LOW |
| P2 predict  | MED  | HIGH | HIGH | MED | LOW |
| P3 retrieve | HIGH | LOW  | MED  | MED | HIGH |
| P4 inquiry  | LOW  | MED  | LOW  | HIGH | LOW |
| P5 imitate  | SKIP | MED  | HIGH | LOW | SKIP |
| F1 fail-first | LOW | HIGH | HIGH | MED | SKIP |
| F2 interleave | HIGH | HIGH | MED | MED | LOW |
| F3 calibrate  | MED | HIGH | HIGH | LOW | MED |
| A1 cure       | HIGH | LOW  | LOW  | MED | HIGH |
| A2 predict-log | MED | HIGH | HIGH | LOW | LOW |

Cell-level rule: HIGH = MUST appear ≥1× per ~3 lessons; MED = MAY appear; LOW = present only on explicit gap signal; SKIP = forbidden as primary lesson type.

Archetype classification happens once at curriculum-create. User can override via clarifyQuestions answer.

## Dropped (with reason)

- **番茄钟 / Pomodoro** — Validated for FOCUS/FATIGUE only (PMC12532815, 2025); ORTHOGONAL to content design. Offered as user-config sidecar (focus timer in UI), NOT a curriculum-axis. Eternal-Law cap respected.
- **FASTER (Jim Kwik)** — Zero peer-reviewed RCT (2024-2026 search). Components individually validated and already covered (Forget = metacog→F3 calibration, Teach = P1, Review = A1/P3). Treat as repackaging.
- **Cornell raw template** — Null effect without metacognitive scaffolding (Springer 2025). Retain ONLY Cornell-Recite as P3.
- **SQ3R as recipe** — 1941 packaging of separately-validated mechanisms (Karpicke 2025). Decompose into P2 (Survey+Question) + P3 (Recite+Review).
- **Ebbinghaus fixed curve** — Superseded by FSRS / SSP-MMC / LECTOR (arXiv 2508.03275). Use A1 algorithmic spacing.
- **Single master-method "fusion"** — Information collapse + frame substitution (council 2026-05-01 Muse strike). Cull-then-extend instead.

## Pilot Path (4-week, gated)

| Week | Deliverable | Gate to next |
|---|---|---|
| W1 | This doc + user review/correct | User signs off on 5+3+3 spec |
| W2 | designSequence prompt fold-in (P1-P5 + F1-F3 named directives, archetype-gated) | LLM lesson output emits methodTags + archetype + dominantPrimitive on syntactic check |
| W3 | state.json schema upgrade (A1 cure-clock + A2 prediction-log) + thin scheduler | A3 controller-state DEFERRED. A1+A2 read/write tested on 1 dummy curriculum |
| W4 | LANG-ACQ pilot (English, 10 lessons, N=5 friendly users), frozen quiz bank pre-deploy | Day-7 recall on lessons 1-7 ≥ 15pp above current baseline → unlock A3 + TECH-CONCEPT archetype |

## Falsifier

Pilot W4 fails to beat current designSequence baseline by ≥15pp on Day-7 recall (frozen quiz bank, n≥5) → Lacquer Loop hypothesis collapses; revert to prior 5-design + 3-runtime split or pure-prompt baseline.
Strict (Lung Part F): substrate must derive functional equivalents of all 8 historical methods at runtime WITHOUT per-method hardcode branches across all 5 archetypes; any method requiring explicit branch → leaky-abstraction warning, partial revert.

## Sources

- Feynman AI bot: arXiv 2506.09055 (2025)
- LECTOR adaptive spacing: arXiv 2508.03275 (2025)
- Expertise reversal meta: ScienceDirect S0959475225000660 (2025)
- Cornell scaffolding: Springer 10.1186/s40862-025-00347-8 (2025)
- Inquiry critical-thinking meta: EJMSTE 2025 (k=36, ES=1.27)
- Karpicke retrieval review: Purdue 2025
- Productive failure: Kapur 2024
- Hybrid interleaving: Wiley Lang Learn 10.1111/lang.12659 (2025)
- AI calibration loop: CHI 2025 10.1145/3706598.3713960
- Generative-AI SRL coach: Springer EPR 10.1007/s10648-026-10133-8 (2026)
- ITS review (asymmetric mastery): arXiv 2507.18882 (2025)
- AI pedagogical model: Springer 10.1007/s13384-025-00913-6 (2025)

## Cross-reference to BLUEPRINT.md

The Lacquer Loop primitives above implement a subset of the full pedagogical surface area defined in the 2026-05-07 product blueprint. Below maps each blueprint section to the primitive(s) that operationalize it, and flags what is still unimplemented.

| BLUEPRINT § | Concept | Implemented by | Status |
|---|---|---|---|
| §6.1 Lesson Schema (12 fields) | Goal / problem / why-important / 人话 / mechanism / terms / examples / misconceptions / connections / Product Transfer / Evidence / next-step | P6 (DEFINE+ANALOGIZE+CHECK+EXTEND) covers fields 4-7; P3 covers 11; F3 covers 12 | partial — `connections` (field 9 → vault concept graph) and `Product Transfer` (field 10) **NOT YET WIRED** |
| §6.2 Jargon Firewall | "Show problem before naming" | hypha-constitution.js voice clamps + P6.1 DEFINE-then-name discipline | partial — no automated jargon detector yet |
| §6.3 Prerequisite Patch | Inline Hint / Micro Patch / Side Quest / Path Reroute | P6 prior-install fires when `state.concepts[id]` empty; replaces "Inline Hint" tier | only Inline Hint tier implemented |
| §6.4 Lesson Quality Harness | Golden samples + failure samples + auto-scorer + 9 dimensions | none | **NOT YET IMPLEMENTED** — see BLUEPRINT §6.4 for spec |
| §7.1 Learning Evidence | Recall / Explanation / Transfer / Production / Judgment / Behavioral / Creation | P3 (Recall+Explanation), P5 (Production), F1 (Transfer) | partial — Behavioral & Creation evidence routes through Track A/B social sandbox (§4 of CLAUDE.md), still 0% |
| §7.2 Mastery Map | 10 dimensions affecting next-lesson difficulty | A1 cure-clock + A2 prediction-log fragments | partial — only concept-cure half-life tracked, no per-dimension mastery |
| §7.3 Anti-Illusion | Detect AI-language copying / no examples / no transfer / no action / no creation feedback | none | **NOT YET IMPLEMENTED** — see BLUEPRINT §7.3 |
| §7.4 Misconception Engine | Per-concept registry of common errors + warnings | none | **NOT YET IMPLEMENTED** — see BLUEPRINT §7.4 |
| §8.1 Lesson Cadence Engine | Generate→Learn→Explain Back→Action Proof→Product Transfer→Feedback→Note Deposit→Rest→Review→Next | partial — current sequence has Generate→Learn→Distill but lacks Action Proof / Product Transfer / Rest / Review tiers | partial |
| §8.2 Assignment Cadence Function | `Level = f(D, S, C, M, R, G, T, P)`; 5 levels (Micro→Public/Commons) | F1 productive-failure for Level-3+ | partial — formal assignment levels not tracked |
| §8.3 Positive Feedback Engine | Micro / Daily / Weekly / Stage / Creation feedback tiers; Exam vs Growth vs Creation models | none structured | **NOT YET IMPLEMENTED** |
| §9 Note System (3 sources × Active Note × Web Note Engine × Living Note Reactivation × Entropy Reduction) | dual-layer distill is implemented; rest pending | partial — `## 课程基础` + `## 用户灵感` shipped in `vault/<slug>/lesson-NN.md` | rest **NOT YET IMPLEMENTED** |
| §10.1 Web Note Engine | Raw → Atomic → Concept → Spark → Product → Kernel + 13 typed edges + utility scoring | atlas concept extraction in `events.jsonl` is the closest surface | **NOT YET IMPLEMENTED** at this depth — see BLUEPRINT §10 |
| §10.2 Living Note Reactivation | Note state machine (Dormant → Crystallized) + scene-triggered revival + utility score | none | **NOT YET IMPLEMENTED** |
| §10.3 Entropy Reduction Cycle | Periodic dedup / merge / compress / weighting / spark candidates / dead-note detection | none | **NOT YET IMPLEMENTED** |

For sections beyond pedagogy proper (Bibliography Grounding §4, Library §5, Creation System §11, Commons §12, Exam §13, Growth §14, Companion §16, API Governance §17), see corresponding `hypha/specs/*.md` placeholder spec files and `BLUEPRINT.md` directly.

---

## Anti-Slop layer (cross-cutting, AMD-MEOW-P7 2026-05-08)

The Lacquer Loop pedagogy ships **alongside** an Anti-Slop & Readable Reasoning Layer that scaffolds verification, not pedagogy itself. The layer adds 12 mechanisms (Evidence Ledger / Confession Layer / Gap Detector / Prosecutor-Judge-Rewriter loop / Auditable Reasoning Summary / Reasoning Legibility Score / Limitation-to-Task Converter / Bullshit Density Detector / No-Uncashed-Abstractions / Reasoning-Action Gap / Knowledge Contamination Graph / Cross-Agent Baton Passing) across 3 phases starting v0.2.

Pedagogical interaction points:
- **P5 retention substrate** (frontier curing / prediction-log / controller-state) ↔ **Confession Layer**: every lesson body's curing snapshot includes the generator's self-reported薄弱处, persisted alongside user prediction errors.
- **F2 frontier substrate** ↔ **Reasoning Legibility Score**: frontier-grade material is precisely where Thinkish-style compression risk is highest; F2 material always passes through legibility scoring before retention.
- **No-Uncashed-Abstractions** ↔ existing `app/lib/hypha-constitution.js` voice clamps: extends "FORBIDDEN abstract terms" rule with a structural requirement (definition + mechanism + example + boundary + counter-example) for every retained abstract noun.

Full spec: `specs/anti-slop-layer.md`. Source theory: `C:\Users\32043\Desktop\HYPHA_AntiSlop_ReadableReasoning_Blueprint.md`. Blueprint §24.
