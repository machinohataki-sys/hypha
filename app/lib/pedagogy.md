# Hypha Pedagogy — Lacquer Loop v0

Status: spec, pre-pilot. 2026-05-01.
Origin: council 2026-05-01 (Lung CURING-SUBSTRATE × Scout FRONTIER-DIGEST × Victor synthesis).
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
