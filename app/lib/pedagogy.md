# Hypha Pedagogy — Subtract-First × Lacquer Loop

Status: spec. Layer 0 (Subtract-First) added 2026-05-11, prepended to Lacquer Loop v0 (2026-05-01) without removing research-anchored primitives P3-P6 / F1-F3 / A1-A3.
Origin: 2026-05-01 design synthesis combining curing-substrate substrate work with frontier-digest research scan; 2026-05-11 user-supplied PhD-lecture model (清华哲学博士生 减法+加法) prepended as structural pre-layer.
Use: `app/agent.js:325` designSequence ingests Layer-0 gate (user_intent / archetype / lessonSplit) BEFORE Layer-1 directives; runtime engine reads Layer-2 schema; domain router (Layer-3) gates emphasis; Layer-4 narrative arc renders per knowledge-point; **Layer-5 four-mode notebook** (DEEPEN/EXPAND/CHALLENGE + PRODUCTION SCAFFOLD per intent) drives post-class addition; Layer-6 4-tier rendering (上期回顾 / 内容总览 / KP cards / map toggle).

## Layer 0 — Subtract-First Course Architecture (2026-05-11)

Origin: 清华哲学博士生 2021 哲学课模型 — 老师做骨架减法 + 学生做柯普勒斯顿加法 = 极短时间培养哲学思维. 课程生成端强制减法 + NOTE 端制度化加法 = "减法+加法合同" 落地.

Falsifier of Lacquer Loop alone: v0.2.1 哲学课跳过前苏格拉底直接 Galileo (memory `hypha_v021_failure_galileo`). 根因 = 没 skeleton 减法, LLM 默认 training-frequency. P1-P6 + F1-F3 都正确但治标不治本, 缺的是 pre-Layer-1 的结构骨架决策.

### S0 — USER INTENT ANCHOR (launch blocker, R1)

- Mechanism: 减法是 goal-relative, 不是 absolute. 同一斯宾诺莎讲给哲学博士新生 vs 考研学生 = 两套不同的 7 chunk. 没目标锚 → LLM ranking 退回 training-frequency → 平均化教科书 → v0.2.1 复发.
- Design-time directive: "Course creation MUST collect `user_intent ∈ {考研, 兴趣 gestalt, 写论文, 复盘}` BEFORE harvest fires. Empty intent = launch blocker, form 拒绝提交."
- Schema: `state.user_intent` (string, required) — 字段贯穿 designSequence + designLesson + assignment + 所有 prompt.
- Per-course signal: `user_intent` 在每 lesson body 出现 → 验证 KP ranking 与 intent 对齐 (考研 → high-yield 知识点偏上限, 兴趣 → core gestalt 偏下限).

### S1 — VISUAL ARCHETYPE ROUTER (R2, ! Layer-3 pedagogical archetype)

- Mechanism: knowledge structure ≠ knowledge presentation. Layer 3 已分 5 pedagogical archetype (LANG-ACQ / TECH-CONCEPT / TECH-PROC / HUMANITIES / DECL-MASS) — 那是 primitive 强度路由. S1 是**结构 archetype** = 知识点之间关系的拓扑形状.
- Enum: `{tree, DAG, timeline, matrix, flat}`. 默认 DAG.
  - **tree**: 严格 parent-child (数学定理链 / 词汇分类 / 解剖)
  - **DAG**: 节点间相互定义 + 多 parent (哲学 substance/attribute/mode / LLM 架构 Q-K-V)
  - **timeline**: 时间序优先 (哲学史 / 项目 stage)
  - **matrix**: 双轴交叉 (经济学 supply×demand / OS deadlock condition)
  - **flat**: 无结构集合 (词汇表 / 法条)
- Design-time directive: "Skeleton 生成第 1 步 LLM 决策 archetype. unrecognized → fallback flat + relation labels."
- Schema: `state.archetype` (enum) + 每 KP 的 `relation_edges[] = [{ target_kp_id, type: 'prereq'|'opposite'|'corollary'|'co-construct', label }]`.
- 决定 Layer 5 默认 UI rendering (linear cards w/ relation labels) vs `Show map` 切换出的图形 (tree/DAG/timeline/matrix).

### S2 — LESSON SPLIT FUNCTION (R3, YOGO-designed)

- Mechanism: 博士生对亚里士多德拆 3 节 (形而上 / 伦理 / 逻辑), 斯宾诺莎 1 节即可. 硬编码"每课时 7 KP" = 大主题塞不下 + 小主题灌水.
- YOGO function (`math-functions` 规范, 落地为纯函数 `lessonSplit(topic, kp_candidates, user_intent) → { n_lessons, lessons[] }`):
  - Working memory cap: 每课时 KP ∈ [5, 9] (Miller's magic number)
  - **disjoint thresholds** (MEOW 2026-05-11 audit fix — 边界不重叠):
    - 总 KP ≤ 8 → 1 课时 (斯宾诺莎 substance/attribute/mode)
    - 9 ≤ KP ≤ 17 → 2 课时 (康德 纯批 + 实批)
    - 18 ≤ KP ≤ 26 → 3 课时 (亚里士多德 形而上学 / 伦理学 / 逻辑学)
    - KP ≥ 27 → reject + 反诘 "主题太大, 缩小范围或拆子主题"
  - `user_intent=考研` → target_count 偏上限 (8-9, high-yield 优先)
  - `user_intent=兴趣` → target_count 偏下限 (5-6, gestalt 优先)
- Schema: `state.lessons[] = [{ idx, theme, kp_ids[], target_count }]` + 跨课时 prereq 边保留 (伦理学 "幸福论" prereq → 形而上学 "潜能-现实")
- Per-skeleton signal: `n_lessons` + 每课时 `target_count` 是否落在 [5,9].

### S3 — KNOWLEDGE-POINT ATOMICITY (R3 续 + R15 cross-syllabus, revised 2026-05-11)

- Mechanism: 课时单位 ≠ 知识点单位. 一节斯宾诺莎课讲 substance 一元论 的论证, 不是斯宾诺莎全部. NOTE granularity = single KP, 不是 lesson.
- File schema: 每 KP 独立 .md (`vault/<slug>/lesson-<idx>/kp-<id>.md`); lesson .md 改为 parent NOTE, body 含 `[[kp-1]] ... [[kp-N]]` wikilinks.
- **Per-KP frontmatter (revised to align with Layer 4 narrative arc R12)**:
  ```yaml
  id: <kp-id>
  title: <KP 标题>
  lesson_id: <parent lesson id>
  archetype: <S1 visual archetype>
  lineage_link:                              # R12 + R15 cross-syllabus
    - target: <kp ref, 可跨 syllabus>
      relation: 批判 | 类比 | 后续被反驳 | 前驱 | 共构
  definition: <formal definition 200-400 字>
  derivation_chain:                          # R12 ordered logic chain
    - step: 1
      claim: <statement>
      follows_from: <ref or 'axiom'>
      mechanism: <how>
  critique_of:                                # R12 替代 counter-example
    - target_thinker: <name>
      target_position: <position>
      attack_summary: <attack>
  analogy: null | <text>                     # R-archetype-explicit gated
  connects_to_next:                          # R12 lesson 内 narrative arc
    - target: <kp-id>
      relation: <type>
  intent_use_map:                            # R11 PRODUCTION SCAFFOLD slot
    考研: [{ exam_q_ref, slot_name }]
    兴趣: [{ slot: 钩子 | mechanism | 日常 | 跨思想家 }]
    论文: [{ slot: 上下文 | claim+论证 | 反驳 | 推进 }]
    复盘: [{ slot: 1句 | 3关系 | 1反例 | 比上次 }]
  paraphrase_prompt: <intent-aware open prompt>
  ```
- **Cross-syllabus wikilink (R15, schema-explicit 2026-05-11 MEOW HIGH 2 fix)**:
  ```yaml
  # Canonical ref schema for lineage_link[].target
  target:
    syllabus_slug: <slug from vault/<slug>/>     # required; '_self' for same syllabus
    lesson_idx: <int>                             # required
    kp_id: <string>                               # required for KP-level ref; null for lesson-level ref
    display_label: <string>                       # required, ≤60 char, human-readable
    fallback: <string>                            # required, what to render if resolve fails
  ```
  Wikilink string format: `[[<syllabus_slug>/lesson-<idx>/<kp_id>|<display_label>]]` (Obsidian-compatible alias syntax).

  **Resolver policy** (lesson-note.js writer + NoteView reader):
  1. Resolve `vault/<syllabus_slug>/lesson-<idx>/kp-<id>.md` first.
  2. On miss (file 不存在 / 已 rename / 已删): show `display_label (link broken: <fallback>)` inline, log `wikilink_broken` event to `events.jsonl`, do NOT crash render.
  3. On `syllabus_slug='_self'`: resolve in current syllabus.
  4. **Rename stability**: KP id 一旦 publish 后不可改. 重命名 KP title 不动 id. 老 link 通过 id 稳定 (类似 git 的 hash 永久性).
  5. **Rename-detection sidecar**: 若 future 加 KP rename UI, 必须 write redirect record to `vault/<syllabus_slug>/.hypha/redirects.json` 让 resolver fallback. v0.3+ feature, 当前 v0.2.x 禁 KP rename.

  legacy lesson .md 无 lineage_link 字段时 = 空 array, render 退化 (per Layer 6 Tier 1 "first lesson" branch).
- 减法机制: 没 `intent_use_map[*]` slot 的 KP = subtract (skeleton preview 阶段砍掉). 这是 R11 PhD 真神的落地 — 目的反向裁剪.
- DEEPEN / EXPAND / CHALLENGE / PRODUCTION (Layer 5 四 mode) 可瞄准 KP 或 lesson 任一粒度.

### S4 — SKELETON PREVIEW + APPROVE GATE (R10)

- Mechanism: 博士生减法是**可见劳作** (memory `course_gen_slow_visible`). LLM 单方决定 ranking 没人审 → 砍错了不知道. 用户审 = 信任建立 + 错砍纠偏.
- Stage 流:
  1. Harvest (5-15min visible, Layer 1 canonical + Layer 3 frontier + Layer 4 community)
  2. Skeleton (archetype + lessonSplit + KP tree, 含 prereq/relation_edges)
  3. **Preview**: 用户看到 7-21 KP (按 n_lessons × target_count), 树形或 DAG overview
  4. **User actions**: ✓ approve / ✎ edit (砍/加/改 KP) / ↻ regenerate (新 seed)
  5. Body expansion (Layer 4 Feynman widget per KP) fires ONLY after approve
- IPC: `curriculum:harvest_and_skeleton` (return preview payload) + `curriculum:approve_and_body` (consume edited skeleton)
- Schema: `state.skeleton_approved_at` (ts) + `state.skeleton_edits[]` (用户改动 audit trail)

### Layer-0 to Layer-1 handoff

After S0-S4 complete, designSequence reads `state.archetype` + `state.lessons` + `state.user_intent` and applies Layer 3 domain-router emphasis table to **each KP** (not each lesson). Layer 1 primitives (P3 retrieve / P4 inquiry / P5 imitate / P6 prior-install / F1 productive-failure) fire **per KP**, gated by archetype × user_intent.

P1 (explain-to-learn) and P2 (pre-read prediction) are **superseded** by Layer-4 Feynman Cycle Widget for KP-card rendering (see below). They remain as fallback primitives when a lesson runs without atomic KP split (legacy curricula pre-2026-05-11).

## Thesis

8 popular methods (Feynman / Cornell-5R / Imitation / SQ3R / Pomodoro / Inquiry / Ebbinghaus / FASTER) ≠ 8 peer mechanisms.
2024-2026 evidence shows them = 4-5 underlying primitives repackaged across decades.
Fusing as 8 equals → triple-implements Review/Recite/Teach + misses LEARNER-STATE-AWARE SCHEDULING (the actual 2025 frontier axis).
Lacquer Loop = cull (drop 2 unvalidated), retain 5 residues, add 3 frontier primitives, mount on 3-axis runtime substrate, route by 5 domain archetypes.

## Layer 1 — Design-Time Primitives

Each primitive = (1) named directive injectable into designSequence sys-prompt, (2) 2024-2026 anchor, (3) per-lesson outcome signal.

### P1 — EXPLAIN-TO-LEARN  (费曼 residue + AI-bot child)  [SUPERSEDED for KP cards by Layer-4 Feynman Cycle Widget — retained as fallback for legacy lessons without atomic KP split]

- Mechanism: forced collapse of hidden complexity via target-audience constraint. AI-as-skeptic-child supplies real audience pressure.
- Anchor: arXiv 2506.09055 — "Learn Like Feynman: AI-Driven Feynman Bot" (2025). Higher gain + lower variance vs passive study.
- Design-time directive: "Each lesson MUST end with a 1-paragraph explain-to-child block where the tutor invites the learner to re-state the lesson's claim in plain language; the agent then probes one ambiguity."
- Per-lesson signal: explanation_attempts[].clarity_score (0-1, judged by tutor LLM).
- Replaces: Feynman + FASTER-Teach (collapsed; same mechanism).

### P2 — PRE-READ PREDICTION  (SQ3R-Q residue, predictive-coding reframe)  [SUPERSEDED for KP cards by Layer-4 Feynman Cycle Widget paraphrase_prompt — retained as opt-in primitive when archetype demands]

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

**R-archetype-explicit (2026-05-11)**: 5-archetype router also binds Layer 4 KP `analogy?` field — HUMANITIES → SKIP (视频 15 min 哲学课零类比实证) / TECH-CONCEPT + TECH-PROC → REQUIRED / LANG-ACQ + DECL-MASS → LLM 自由决定. 不让 LLM 在 HUMANITIES 自由插类比 (违 Garamond register + 反实证).

## Layer 4 — Feynman Cycle Widget (per knowledge-point, 2026-05-11)

Origin: 博士生哲学课每知识点解释 = 定义 + 类比 + 反例 + 让学生 paraphrase 评分. 不是"先讲一段定义再讲一段通俗" 线性段落. Feynman 真实 method = explain → find gaps → simplify → analogy 多轮循环, 不是 one-shot.

Synthesizes P1 (explain-to-learn) + P2 (pre-read prediction) + P6 (4-stage DEFINE/ANALOGIZE/CHECK/EXTEND) into a single per-KP rendering primitive.

### KP structure: narrative arc, NOT 4-segment static card (revised 2026-05-11 post-video, table-form 2026-05-11 MEOW HIGH 1 fix)

Origin of revision: 4 PPT + 43-min 斯宾诺莎 video (3×5-min sample) 实证 PhD 实际授课. 4-segment 假设被推翻 — PhD 每 KP 讲 7 required + 1 conditional typed fields, 非 4 段 markdown.

### Schema contract (explicit table, MEOW HIGH 1 fix)

| # | field | cardinality | required? | empty-allowed? | notes |
|---|---|---|---|---|---|
| 1 | `lineage_link[]` | array | REQUIRED | yes (first KP in syllabus) | cross-syllabus refs allowed (R15) |
| 2 | `definition` | string | REQUIRED | no | 200-400 字 / 80-160 words |
| 3 | `derivation_chain[]` | array | REQUIRED | yes (定义-only KP, no derivation) | ordered logic chain |
| 4 | `critique_of[]` | array | REQUIRED | yes (无对前人批判时 = []) | replaces counter-example |
| 5 | `analogy` | string \| null | **CONDITIONAL** | n/a | archetype-gated (see precedence below) |
| 6 | `connects_to_next[]` | array | REQUIRED | yes (last KP in lesson) | within-lesson edge |
| 7 | `intent_use_map` | object (keyed by intent) | REQUIRED | no (≥1 intent must have ≥1 slot) | per R11 PRODUCTION SCAFFOLD |
| 8 | `paraphrase_prompt` | string | REQUIRED | no | intent-aware prompt |

### Archetype + P6 precedence rule (MEOW CRITICAL 1 fix)

R-archetype-explicit gates Layer 4 field 5 `analogy` based on Layer 3 archetype:
- HUMANITIES → `analogy = null` REQUIRED (default skip)
- TECH-CONCEPT / TECH-PROC → `analogy` REQUIRED non-empty
- LANG-ACQ / DECL-MASS → `analogy` OPTIONAL (LLM decides; null or string both valid)

**P6 PRIOR-INSTALL override**: P6 is a runtime tutor-turn primitive (fires when concept has no anchor in `state.concepts` AND no `priorNotes` mention), NOT a Layer 4 schema field. P6's 4-stage arc (DEFINE / ANALOGIZE / CHECK / EXTEND) operates at tutor-turn-time, independent of Layer 4 static schema. When P6 fires on a HUMANITIES cold-start KP:

- Layer 4 `analogy` field stays `null` (no static analogy stored in KP schema)
- P6 ANALOGIZE stage **still fires** at tutor-turn-time — but generates a verbal-only analogy adapted for HUMANITIES (e.g., a structural contrast like "实体一元 vs 实体二元", NOT a body metaphor like 章鱼触手)
- Conflict resolved: Layer 4 archetype-gate constrains the **stored schema**, not the runtime tutor turn. P6 substantive ANALOGIZE remains a tutor obligation; only its rendering form is archetype-aware.

This precedence is binding. P6 does NOT skip its ANALOGIZE stage on humanities — it adapts. R-archetype-explicit applies only to Layer 4 static schema's `analogy` field.

### Field descriptions (numbered 1-8 per schema contract above)

1. **`lineage_link[]`** — 承上链到前位哲学家概念 (跨课时 + **跨课程**, R15). e.g., Spinoza substance monism's lineage = `[{ target: descartes/substance_dualism, relation: 批判 }, { target: anselm/ontological_proof, relation: 类比 }, { target: leibniz/monad_pluralism, relation: 后续被反驳 }]`. 视频实证: PhD 讲 Spinoza 时主动调用 Descartes (前驱) + Anselm (本体论证明对比) + Leibniz (后续) — 跨课程是 first-class, 不是事后增补.

2. **`definition`** — formal definition, 中文 200-400 字 / English 80-160 words. Density per P6 binding (saying less ≠ pedagogy). 枚举 sub-types 若 sub-types 存在 (Spinoza substance vs Descartes 实体二元论 vs Leibniz 实体多元论 三对比).

3. **`derivation_chain[]`** — ordered list `[{ step_idx, claim, follows_from_ref, mechanism }]`. 哲学 / 数学 / 逻辑必备. 视频实证: PhD 讲 Spinoza 实体 = "实体自因 → (因此) 无限性 → (因此) 不可分性 → (因此) 唯一性 → (因此) 与神等同". 不是平铺 list, 是逻辑推论链. 每 step 显示 follows_from 与 mechanism.

4. **`critique_of[]`** — 对谁的批判 / 攻击具体位置. **替代旧 4-segment 设计的 counter-example**. 视频实证: Spinoza 对 Descartes "我思故在"的批判 = `{ target_thinker: descartes, target_position: "我思故在为清楚明白的直观第一原理", attack_summary: "我思非清楚直观, 是不断还以得到的含混观念, 又陷入又不穷后退" }`. Counter-example 是抽象, critique_of 是哲学/法学/经济学的真实形态.

5. **`analogy?`** — OPTIONAL, **archetype-gated (R-archetype-explicit)**:
   - HUMANITIES → SKIP (视频 15 min 哲学课零类比的硬实证, 强加 = 违 Garamond register)
   - TECH-CONCEPT / TECH-PROC → REQUIRED (Q/K/V 矩阵 / 杠杆 numerical instance / 章鱼触手对 substance 类比仅在 TECH-style 学生才可)
   - LANG-ACQ / DECL-MASS → LLM 自由决定

6. **`connects_to_next[]`** — 本课时下一 KP 链接 + 关系类型. 视频实证: lesson 是 narrative arc, KP 之间是论证链, 不是 list. e.g., substance → attribute → mode 一线推下来.

7. **`intent_use_map`** — 此 KP 填哪个 PRODUCTION SCAFFOLD slot (per Layer 5 R11):
   ```
   intent_use_map: {
     考研: [{ exam_question_ref, slot_name: 承上|内容|评价 }],
     兴趣: [{ slot: 钩子 | mechanism例 | 日常关系 | 跨思想家对比 }],
     论文: [{ slot: 上下文 | claim+论证 | 反驳+你的立场 | 推进方向 }],
     复盘: [{ slot: 1句核心 | 3关键关系 | 1反例 | 比上次新明白的 }]
   }
   ```
   每 KP 至少在某个 intent 下填 1 个 slot. **没 slot 的 KP = subtract (skeleton preview 阶段砍掉)**. 这是减法的根本机制 — 不是绝对 ranking, 是"目的反向裁剪".

8. **`paraphrase_prompt`** — 按 user_intent 改 prompt 内容:
   - 考研 → "draft 答 [本 KP 关联的 exam Q], 用 [slot_name] 模板"
   - 兴趣 → "用 100 字给一个不懂哲学的朋友讲"
   - 论文 → "如果要在论文里引用这个概念, 写 1 段铺垫"
   - 复盘 → "1 句话给自己讲, 1 反例自检"
   学生输入 → LLM 评 gap (结构 adherence / 内容深度 / 与原 KP evidence link).

### Design-time directive (revised)

"Each KP body 生成必须输出 7 typed fields + 1 conditional (`analogy`) schema, per Schema contract table above. UI 渲染为 narrative arc (lineage 顶 + definition + derivation_chain 折叠列表 + critique_of 块 + analogy 可选 + connects_to_next 底 + intent_use_map 侧栏 + paraphrase_prompt 入口). **禁** 4-segment 静态 card (旧设计已废)."

### Per-KP signal

`state.kp[id] = {
  paraphrase_log: [{ ts, intent, learner_response, gap_score, gap_dims }],
  scaffold_fill_log: [{ ts, intent, slot, fill, llm_grade }],
  cycle_completed_at: ts | null
}`

### Anti-pattern (forbidden)

- 4-segment 静态 card 输出 (definition / counter-example / analogy / paraphrase) = 旧设计回潮, 违 R12
- HUMANITIES archetype 强加 analogy (e.g., Spinoza substance 用章鱼比) = 视频反实证, 违 R-archetype-explicit
- derivation_chain 写成平铺 list 而非有序推论 = 失去哲学骨架
- KP 没 intent_use_map = 没目的反向裁剪, 退回平均化教科书
- critique_of 缺失 (哲学/法学/经济 KP) = 退化成圣徒传

### Replaces

- 旧 Layer 4 4-segment Feynman widget 设计 (R12 取代)
- P1 EXPLAIN-TO-LEARN (collapsed into paraphrase_prompt with intent gating)
- P2 PRE-READ PREDICTION (substituted: critique_of 提供 predictive contrast 角色)
- P6 DEFINE/ANALOGIZE/CHECK/EXTEND 前 3 阶段 (EXTEND 阶段保留, 留给 Layer 5 DEEPEN mode)

## Layer 5 — Four-Mode Notebook (post-class addition, revised 2026-05-11)

Origin: 博士生减法 + 学生柯普勒斯顿加法 = 合同. 老师减得再准, 学生不加法 = 只有骨架 pattern match 假理解. NOTE 端 4 mode 制度化"加法义务", 不依赖学生自觉.

**3 输入加法 mode** (从外部吸收 detail/广度/反方) + **1 输出加法 mode** (按 intent 产出自己的话). 输出 mode = PRODUCTION SCAFFOLD (R11, user-supplied meta-abstraction 2026-05-11) 取代原 EXAM_TEMPLATE 考研专属设计.

```
                  输入加法 (吸收)         输出加法 (产出)
纵向 (深化)      DEEPEN                  PRODUCTION SCAFFOLD (按 intent)
横向 (拓展)      EXPAND
对立 (反驳)      CHALLENGE
```

Four modes attach to **every NOTE** (lesson .md OR atomic kp-N.md). M1-M3 mirror `deepen-pipeline.js` 7-stage wave; M4 has own intent-aware slot pipeline.

### M1 — DEEPEN (纵向深化 + 前沿连接, existing)

- Mechanism: 学生柯普勒斯顿翻第 N 章给 substance monism 充血肉. 加 detail / 加 frontier connection.
- Already shipped: `app/lib/deepen-pipeline.js` Wave 1 Scout + Leo → Wave 2 Lung + Nancy → Wave 3 Occam + Muse → Wave 4 Synth.
- **Frontier section enforcement (R7)**: 输出"前沿"段必须有 Scout citation. 不见 Scout citation = bug, 视为 hallucination. 已 wired by `.claude/hooks/scout-required.js` (Hypha 调用层补强标注).
- Keyboard: Ctrl+D. Result: inline callout block in NOTE body.

### M2 — EXPAND (横向冷门点, NEW)

- Mechanism: 减法砍掉的 + 教科书没收的 = 知识面广度. 但"冷门"相对谁? 3 个轴:
  - **canon-cold**: 教科书没收 (e.g., Spinoza 的圣经诠释学 / Aristotle 的 πολιτεία 异本研究)
  - **personal-cold**: 用户 vault 已覆盖, 取补集 (与已有 NOTE 关系疏远的合法分支)
  - **model-cold**: LLM training-frequency 低的合法分支 (anti-Galileo-bias)
- Pipeline (`app/lib/expand-pipeline.js`, NEW):
  - Stage 1: axis 选择 — 用户选 OR 自动 (default canon-cold; vault NOTE ≥10 → personal-cold; explicit anti-bias intent → model-cold)
  - Stage 2+: angles (Scout / Lung) 在选定轴下并行
  - 输出: 3-axis grid 卡片, 每卡带 axis badge
- **Fallback**: vault NOTE ≤3 → personal-cold 不可用, 自动降级 canon-cold + 显示 "vault 覆盖不足" 标注
- Keyboard: Ctrl+E. Result: inline 3-axis grid card.

### M3 — CHALLENGE (反驳 + 对立观点, NEW)

- Mechanism: 斯宾诺莎不被莱布尼茨反驳 = 你只学了赞美诗. 哲学 / 法学 / 经济学 / 政治学 不被 challenge = 退化成圣徒传. CHALLENGE 是 Layer 5 第三义务.
- Pipeline (`app/lib/challenge-pipeline.js`, NEW), angles 换为对立视角:
  - **Muse** — 对手论证 (站在 Leibniz / Hume / Kant 视角攻击 doctrine)
  - **Leo** — first-principles 反推前提 (该 doctrine 隐含 axiom X, 若 X 错则整链塌)
  - **Scout** — 历史批判史 (该 doctrine 在文献中被谁反驳过, 何时何地)
  - **Synth** — 整合为 objection cards (按 objector 分组 + 时间序)
- Domain emphasis: HIGH for HUMANITIES + TECH-CONCEPTUAL; MED for TECH-PROC; LOW for LANG-ACQ + DECL-MASS.
- Keyboard: Ctrl+H. Result: inline objection cards grouped by objector.

### M4 — PRODUCTION SCAFFOLD (输出加法, intent-aware, NEW R11)

- Mechanism: 学习终点 = 学生在 intent 自然产出形态里填 scaffold + LLM 反馈. 考研答题模板是 EXAM_TEMPLATE 一个 instance, 不是 SCAFFOLD 本身. 普适机制 = "every intent has its natural production form, lesson teaches you to fill it".
- 4 intent 的 SCAFFOLD slot 表 (slot 数 intentionally variable, MEOW HIGH 2 fix — 反映 PhD 真实应试结构):

  | intent | 自然产出形态 | scaffold slots | slot 数 |
  |---|---|---|---|
  | 考研 | 答题 | 承上 / 主要内容 / 评价 / 提高技巧 | 4 |
  | 兴趣 | 给好奇朋友讲 | 钩子 / 1 mechanism 例 / 跟我日常关系 / 跨思想家对比 | 4 |
  | 论文 | 引用段落 | 上下文铺垫 / claim+论证 / 反驳+你的立场 / 推进方向 | 4 |
  | 复盘 | 压缩 | 1 句核心 / 3 关键关系 / 1 反例 / 比上次新明白的 | 4 |

  考研 第 4 slot "提高技巧" 来自 PhD 课件应试 slide 实证 (亚里士多德 PPT: "提高技巧：补充目的、详述内容、写清后续 / 详述内容"), 不是凑数. 4 slots 是当前最大公分母, 未来 intent 加入时 slot 数允许变化 — 按该 intent 的真实产出形态决定.

- Pipeline (`app/lib/production-scaffold.js`, NEW):
  - Stage 1: 读 state.user_intent → load slot template
  - Stage 2: 收集本 NOTE 范围内 KP 的 `intent_use_map[intent]` → 建立"哪个 KP 填哪个 slot" mapping
  - Stage 3: render scaffold UI (slot 列表 + 每 slot 旁列对应 KP 摘要)
  - Stage 4: 学生在每 slot 输入框 draft 答案
  - Stage 5: LLM 评 3 维: (a) 结构 adherence (slot 内容是否符合该 intent 的语用形态) (b) 内容深度 (是否真用了 KP 的 derivation_chain / critique_of, 不是 paraphrase) (c) evidence link (slot 答案是否能 trace 回具体 KP)
- Keyboard: Ctrl+P. Result: full-page scaffold view (! inline callout, 因为 production 是 full draft 过程).
- 与 Hypha CLAUDE.md WHO 北极星 (Track A/B) 关系: PRODUCTION SCAFFOLD = Track A/B doctrine 的 structured surface, 之前只是 doctrine 现在落到 NOTE 级.

### Cross-mode contract

4 modes 共享 IPC progress / abort 协议 (M1-M3 复用 deepen 模式, M4 自有):
- `llm:deepen-progress` / `llm:expand-progress` / `llm:challenge-progress` / `llm:production-progress`
- `llm:deepen-abort` / `llm:expand-abort` / `llm:challenge-abort` / `llm:production-abort`

NOTE 端结果: M1-M3 = inline callout block, M4 = full-page scaffold view (不同 register 因为产出过程长).

### Homework entrypoint (R5 修订, 取代 3-seed 设计)

Lesson NOTE frontmatter 改为 PRODUCTION SCAFFOLD entrypoint, **非 3 个 open prompt seed**:

```yaml
homework:
  production_scaffold:
    intent: <state.user_intent>
    slot_template: <按 intent 查 R11 slot 表>
    kp_slot_mapping: [{ slot, kp_refs: [...] }]
    prompt: "draft 你的产出, 我评结构 + 深度 + evidence link"
```

视频实证: 这本身就是 PhD 课的"应试"slide 做的事 — 给 slot 模板 + 哪个 KP 填哪个 slot. 推广到 4 intent 后, 每 intent 都有自己的"应试"等价物.

旧 3-seed 设计 (deepen_seed / expand_seed / challenge_seed) **deprecated** — 这是输入加法的种子, 不是输出加法义务. 输入加法由 M1-M3 mode 按钮直接触发, 不需 NOTE frontmatter 预填.

## Layer 6 — Linear-First Rendering (R9 + R13 + R14, revised 2026-05-11)

Origin: 博士生讲课没画一张大树形图 — 他口述层次, 学生脑里自己搭. 直接渲染漂亮 tree diagram → 学生看图觉得懂 = 假理解 (UI 提供拐杖, 阻止内部 scaffold).

Revised: 视频 + 4 PPT 实证显示 PhD 每讲固定有 2 个 first-class section 不该藏 (上期回顾 + 内容总览), 再线性 KP cards, 树形图最后 toggle.

### Default render — 4-tier 渲染

NOTE 默认 view 自顶向下 4 层:

#### Tier 1 — 上期回顾段 (R13 NEW)

视频实证: PhD 讲 Spinoza 时 PPT "上期回顾" slide 是空 placeholder, 但**口述 3-5 min 重述 Descartes** (普遍怀疑 + 我思故在 + 跟 Anselm 本体论证明对比). Lesson NOTE 顶部必须 auto-regen 实质回顾段, 不只是 `[[lesson-N-1]]` link.

实现: Phase B `app/lib/prior-review.js:regenPriorReview(prev_lesson, current_topic, lineage_links)` → 200-400 字回顾段. NOTE frontmatter 后第一段渲染, 默认 visible (! 折叠).

跨课程版本: 当前 lesson 调用其他 syllabus NOTE 时 (R15 cross-syllabus lineage_link), 上期回顾段含跨课程引用 (e.g., "回顾笛卡尔[[descartes/lesson-3]]的我思故在 + 安瑟伦[[anselm/lesson-2]]的本体论证明").

#### Tier 2 — 内容总览段 (R14 NEW)

视频 + 4 PPT 实证: 每讲必有"内容总览"slide 显示文字 relation 列表 — "理论之间的关系: 三本原中的缺乏、形式可统一为形式；四因说中的形式因、动力因、目的因可同一为形式因；潜能对应于质料，现实对应于形式". **不是图**.

实现: NOTE 顶部 Tier 2 段, 由 `knowledge_points[].relation_edges` 文字渲染. 默认 visible (! 折叠).

格式 (markdown):
```
## 内容总览
本课时 X 个知识点之间的关系:
- KP1 [substance] 是 KP2 [attribute] 的载体 (关系: 共构)
- KP2 [attribute] 推出 KP3 [mode] (关系: 推论)
- KP4 [necessitarianism] 对立 笛卡尔 contingency (关系: 跨课程批判)
```

不是 fluff. 是 PhD 教学的 first-class component, 视频显示老师每讲都做 1-2 min 这件事.

#### Tier 3 — KP 线性卡片流 (R9 原设计)

knowledge_points 按 connects_to_next 顺序线性排列, 每卡片显式标注 relation:
```
↑ 上接: [[kp-3]] (关系: 推论)
↔ 关联: [[kp-7]] (关系: 对立)
↔ 跨课程: [[descartes/lesson-3/kp-2]] (关系: 批判, R15)
↓ 衍生: [[kp-12]] (关系: 共构)
```

Relation 类型 enum: `{ prereq, opposite, corollary, co-construct, 批判, 跨课程类比 }`.

#### Tier 4 — Show map toggle (R9 原设计)

顶部 `Show map` toggle (默认折叠). 点开后 render `screen-atlas-notebook.jsx` (复用 Atlas concept-map), 接受 prop `mode={tree|DAG|timeline|matrix|flat}` driven by `state.archetype`.

不识别的 archetype → fallback flat list + relation labels.

### Anti-pattern

- **新**: Tier 1 上期回顾段只放 link 不 regen 实质回顾 = R13 违例, 退化为只读目录
- **新**: Tier 2 内容总览段缺失或藏在 toggle 后 = R14 违例, 学生失去 PhD-style relation ranking
- **新**: Tier 3 卡片只列 KP 不显示跨课程 lineage_link = R15 违例, 失去 cross-syllabus 知识网
- 原: 默认就显示 tree diagram = 视觉拐杖 → 学生看图不脑搭 → 假理解
- 原: 卡片不标 relation = list 而非 graph → 失去骨架价值
- 原: relation 类型用 "related to" 模糊词 → 失去 ranking 信息, 退回 disconnected fact dump

## Precedence + Migration Matrix (2026-05-11 MEOW CRITICAL 1+2 + HIGH 1 fix, depth proposal accepted)

Single load-bearing reference removing ambiguity between Layer 0-6 (new 2026-05-11) and shipped v0.2 runtime. Read THIS before implementing Phase B.

### A. Layer precedence (resolves CRITICAL 1 + MEOW v4 newly-introduced HIGH fix)

When two layers seem to contradict on the same field, the layer **HIGHER on this list wins** (= constitution is supreme authority; layer 6 rendering is the most overridable). Lower layers can be overridden by higher ones — never the reverse.

1. CLAUDE.md WHO / Hypha constitution (manuscript register, Garamond, voice clamps) — **supreme, never overridden**
2. Character Contract YAML (`mycelium-professor.json`, shipped 2026-05-09)
3. Layer 0 Subtract-First (S0 intent / S1 visual archetype / S2 lessonSplit / S3 atomic KP / S4 skeleton approve)
4. Layer 3 5-archetype pedagogical router (LANG-ACQ / TECH-CONCEPT / TECH-PROC / HUMANITIES / DECL-MASS)
5. Layer 1 primitives P3-P6 (CUE-RETRIEVAL / SCAFFOLDED INQUIRY / EXPERTISE-IMITATION / PRIOR-INSTALL) + F1-F3 (PRODUCTIVE FAILURE / HYBRID INTERLEAVING / CALIBRATION LOOP)
6. Layer 4 KP narrative arc schema (per-KP static fields)
7. Layer 5 NOTE 4-mode (post-class user-driven, runtime)
8. Layer 6 rendering (UI tier order, visual only)

**Concrete collision cases**:

- **P6 PRIOR-INSTALL (Layer 1) vs R-archetype-explicit (Layer 4) on HUMANITIES cold-start KP**: 
  Layer 4 archetype-gate constrains **stored schema** (`analogy = null` for HUMANITIES). P6 ANALOGIZE stage **fires at tutor-turn-time** with adapted form (structural contrast, not body metaphor). NO conflict — different scopes (schema-time vs turn-time).

- **lessonSplit (Layer 0 S2) vs Lacquer Loop Layer 3 pedagogical emphasis (LOW/MED/HIGH/SKIP)**:
  S2 决定**多少 KP 多少课时**. Layer 3 emphasis 决定**每 KP 用哪几个 primitive**. 正交不冲突.

- **PRODUCTION SCAFFOLD intent_use_map (R11) vs assignment_level (assignment.js)**:
  R11 取代 assignment.js stub's "always Level 1". intent_use_map IS the new assignment surface. assignment_level frontmatter 字段保留 (backward compat), 但 v0.5+ Cadence System 来时再细化.

### B. Shipped-vs-target schema mapping (resolves CRITICAL 2)

Shipped state (v0.2 surface tranche, 2026-05-09):

| layer | shipped | path |
|---|---|---|
| curriculum | flat `lessons[]` w/ {idx, title, learnGoal, prereqIds} | `agent.js:designSequence` |
| skeleton | 6-field `{ objective, prerequisite_check, hook_concrete, path, micro_proof, next_lesson_seed }` | `lesson-generator.js:generatePlan` |
| body | 11-field v0.2 `{ thesis, canonical_example, common_misconceptions[2], exit_proof, mechanism_explanation, jargon_list, note_connection, + 4 optional }` | `lesson-body-generator.js:generateLessonBodyV2` |
| NOTE | flat `vault/<slug>/lesson-N.md` w/ `## 课程基础` + `## 用户灵感` 2 sections | `lesson-note.js:depositLessonNote` |
| trust | Character Contract injection / Anti-Ingratiation Filter / 3-dim Coherence / Confession Layer / Auditable Reasoning | shipped 2026-05-09 |

Target state (after Phase B-D 2026-05-11+ revision):

| layer | target | path |
|---|---|---|
| curriculum | `{ archetype: visual_enum, lessons: [{ idx, theme, kp_ids: [], target_count, user_intent_echo }] }` | `agent.js:designSequence` (扩展) + new `lessonSplit()` function |
| skeleton | 6-field (unchanged) **+ knowledge_points[]** seed array (id, title, archetype, lineage_link seeds) | `lesson-generator.js:generatePlan` (扩展) |
| body | **11-field (preserved verbatim)** + sibling **KP narrative arc array** per knowledge point | `lesson-body-generator.js:generateLessonBodyV2` (preserved) + new `generateKPArc()` |
| NOTE | parent `vault/<slug>/lesson-N.md` (preserved schema + 上期回顾 + 内容总览 sections prepended) + atomic `vault/<slug>/lesson-N/kp-M.md` 子目录 | `lesson-note.js:depositLessonNote` (preserved + 段插入) + new `depositKnowledgePointNote()` |
| trust | unchanged surfaces; KP-level events optional, lesson-level events canonical | shipped surfaces preserved |

**Dual-write policy** (during 过渡期):
- 所有新 curriculum 都 write BOTH 11-field body JSON (trust layer 仍消费) AND KP arc array
- lesson-note.js write BOTH parent `lesson-N.md` (with 上期回顾 + 内容总览 prepended) AND atomic `lesson-N/kp-M.md` 子目录
- KP arc array 缺失时 (老 curriculum): NoteView 降级 render flat lesson body, 不 crash

**Dual-read policy** (NoteView):
- 先 try load `vault/<slug>/lesson-N/kp-*.md` 子目录
- 若 ≥1 KP file 存在 → render Layer 6 4-tier view (KP cards)
- 若 0 KP file → render legacy 2-section view (`## 课程基础` + `## 用户灵感`)
- 第 Tier 1 上期回顾段 + Tier 2 内容总览段 在两种 view 都尝试 prepend (从 lesson body 抽取或 regen); 失败则跳过, 不阻塞 render

**Cutover point**:
- Phase B 完成 + Phase C 完成后, ALL **new** lessons 默认 KP atomic split (state.json marker `schema_version: '2026-05-11'` 区分).
- 老 lessons (无 `schema_version` 字段 or 早于 cutover): permanently legacy, 不强制 migrate. 用户主动 click "Re-process to KP atomic" 才迁移 (v0.4+ feature, 当前不实现).

### C. Legacy NOTE compatibility (resolves CRITICAL 2 续)

Reading old `vault/<slug>/lesson-N.md` from pre-2026-05-11:
- frontmatter 缺 `user_intent` / `archetype` / `knowledge_points[]`: `lesson-note.js` reader null check, 不 crash
- body 缺 `path_prose` 旧 v0.1 字段: 已 fallback 在 lesson-note.js L86-128 (legacy v0.1 deposit)
- No KP 子目录: render legacy 2-section view (`## 课程基础` + `## 用户灵感`)
- No 上期回顾 / 内容总览 段: 顶部空, 不 regen retro (避免 hallucinate 旧 lesson 不存在的 context)

### D. Plan file 单一 truth (resolves HIGH 4)

Plan file (`C:\Users\32043\.claude\plans\c-users-32043-desktop-pptx-sorted-knuth.md`) 是 implementation plan. 当 Phase B 改动列表 与 R11-R15 refinements 冲突时:
- **R11-R15 refinements WIN** (是后写的 truth)
- Phase B 改动 5 (assignment.js): 应实现 PRODUCTION SCAFFOLD entrypoint, **不**实现 3-seed homework
- Verification 段: 应验证 PRODUCTION SCAFFOLD 4-mode 4-intent, **不**验证 3-seed frontmatter
- End-to-end gold path step 7-8: 应描述 PRODUCTION SCAFFOLD prefill, **不**描述 deepen_seed prefill

Plan.md 后续 Phase B 改动列表段的修订与本段同步 (see plan.md Phase A.2 revision pending).

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

Pedagogical interaction points (label fix 2026-05-11 MEOW audit — primitive references corrected):
- **A1+A2 retention substrate** (CURE-CLOCK + PREDICTION-LOG, the actual retention axes, not P5) ↔ **Confession Layer**: every lesson body's curing snapshot includes the generator's self-reported薄弱处, persisted alongside user prediction errors.
- **F1 + F3 frontier-driving primitives** (PRODUCTIVE FAILURE + CALIBRATION LOOP, where frontier-grade unknowns enter the loop — not F2 which is HYBRID INTERLEAVING) ↔ **Reasoning Legibility Score**: frontier-grade material is precisely where Thinkish-style compression risk is highest; F1/F3 material always passes through legibility scoring before retention.
- **No-Uncashed-Abstractions** ↔ existing `app/lib/hypha-constitution.js` voice clamps: extends "FORBIDDEN abstract terms" rule with a structural requirement (definition + mechanism + example + boundary + counter-example) for every retained abstract noun.

### Trust-Layer Compatibility under KP split (added 2026-05-11 MEOW audit HIGH 3 fix)

When Layer 0 S3 atomic KP NOTE 落地 (each KP gets own .md), shipped v0.2 trust-layer surfaces must continue working:

- **Character Contract injection** (`app/agent.js` `_buildCharacterContractBlock`, shipped 2026-05-09 v0.2): Contract still injects at lesson-level prompt assembly (NOT per-KP). KP-card rendering is a NOTE-side view, not a tutor-turn primitive — contract stays on the tutor's outermost frame.
- **Confession Layer** (lesson body's self-reported 薄弱处): persists at lesson-level body JSON. When Layer 4 narrative arc is generated per-KP, each KP's `critique_of[]` may surface as KP-local confessions, but the LESSON-level confession (`/finish` digest) stays the canonical aggregation surface.
- **Auditable Reasoning Summary** (`harnessResult.auditable.structured`): operates on lesson body's 11-field schema. Migration policy (see "Precedence + Migration" matrix below) keeps 11-field generated for trust panel even after KP split lands. KP narrative arcs are ADDITIONAL, not REPLACEMENT.
- **Anti-Ingratiation Style Filter** (`_detectAndLogIngratiation` in agent.js, shipped 2026-05-09): runs on streamed tutor turns regardless of KP/lesson granularity. No interaction change.
- **3-dim Persona Coherence Score** (Course Trust Panel default tier): aggregates from event log `events.jsonl`. KP-level events use same row schema (`type`, `op`, `slug`, `lesson_idx`, `kp_id?`) — `kp_id` is OPTIONAL, panel falls back to lesson-level aggregation when KP absent.

Full spec: `specs/anti-slop-layer.md`. Source theory: `C:\Users\32043\Desktop\HYPHA_AntiSlop_ReadableReasoning_Blueprint.md`. Blueprint §24.
