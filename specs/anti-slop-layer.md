# Anti-Slop & Readable Reasoning Layer · Implementation Spec

**Status**: NEW 2026-05-08 (AMD-MEOW-P7 amendment to main blueprint)
**Source module**: `C:\Users\32043\Desktop\HYPHA_AntiSlop_ReadableReasoning_Blueprint.md`
**Blueprint cross-ref**: §24 (new section) of `HYPHA_final_blueprint_and_evolution_roadmap.md`

---

## Why this layer exists

Two frontier failure modes of AI generation collide directly with HYPHA's mission:

1. **Output-level misalignment** — AI packages incomplete / unverified / shallow work as if it were complete (Apparent-Success-Seeking). HYPHA's hard-to-check tasks (course quality, paper distillation, spark originality, transfer-to-product) are precisely the surface where this is most dangerous.
2. **Reasoning-level opacity** — Chain-of-Thought is a historically contingent window into model reasoning; future models may drift to Thinkish (compressed pseudo-language) or Neuralese (latent-space-only computation), losing human readability.

Combined threat:
> AI 的输出会表演成功; AI 的推理会表演诚实; AI 的真实计算会越来越不可见。

Therefore HYPHA's moat is not Course Generation. It is:
> Course Generation + Course Verification + Reasoning Monitorability + Evidence Provenance + Knowledge Contamination Control.

Tagline: **不是让 AI 多生成,而是让 AI 不敢糊弄你**。

---

## 12 core mechanisms (full register from the source module)

| # | Mechanism | Purpose | Phase |
|---|---|---|---|
| 1 | **Evidence Ledger** | Every claim ⇒ {evidence, type, confidence, verifiability, risk} record | P0 (v0.2) |
| 2 | **Confession Layer** | Generator self-reports "where I likely cut corners / what I didn't verify / what is guess" | P0 (v0.2) |
| 3 | **Gap Detector** | Computes Apparent Progress vs Verified Progress; flags inflation | P0 (v0.2) |
| 4 | **Prosecutor / Judge / Rewriter loop** | 3-role adversarial review on every Lesson body before it ships | P0 (v0.2) |
| 5 | **Auditable Reasoning Summary** | Structured `{conclusion, evidence, key chain, uncertainty, objections, fix list}` per generation | P1 (v0.4) |
| 6 | **Reasoning Legibility Score** | Score reasoning on semantic readability / step continuity / term stability / jump rate / Thinkish ratio / evidence linkage / counter-example coverage | P1 (v0.4) |
| 7 | **Limitation-to-Task Converter** | "由于篇幅限制" / "未来工作" detection → core-relevance check → required follow-up task if core | P1 (v0.4) |
| 8 | **Bullshit Density Detector** | Detect abstract-noun stacking / no causal chain / no example / no boundary / no counter-example / "本质上 / 深层 / 涌现" cover words | P1 (v0.4) |
| 9 | **No Uncashed Abstractions** | Every abstract term must cash out to {definition, mechanism, example, boundary, counter-example} | P1 (v0.4) — partial; constitution rule already exists |
| 10 | **Reasoning-Action Gap Detector** | Compare claimed reasoning vs actual output (e.g. "promised mechanism, gave analogy") | P1 (v0.4) |
| 11 | **Knowledge Contamination Graph** | Trace error propagation across Note → Lesson → Memory; quarantine downstream when source is invalidated | P2 (v0.5+) |
| 12 | **Cross-Agent Baton Passing** | Different agents for Generator / Reviewer / Rewriter / Judge — break single-model self-validation circuit | P2 (v0.5+) |

Not numbered in the table but part of the layer:
- **Cognitive Provenance Layer** (§20 of source) — every knowledge atom carries `{source → distillation → reasoning trace → claims → evidence → review → revision → memory}` lineage; surfaced in Course Trust Panel.
- **Monitorability Mode** (§21) — high-risk task entry triggers structured `{goal, evidence, assumptions, steps, uncertainty, failure modes, shortcut check, conclusion}` output.
- **Mycelium Immune Pets** (§11 of source) — Auditor / Skeptic / Memory / Evidence / Compression / Mutation / Contamination / Mycelium-Judge — UI-layer personification of audit functions, ships with Companion v0.8.

---

## Phase 1 (P0) — minimum viable verification core

Target version: **v0.2 Lesson Quality Core** (currently roadmap §20 v0.2).

### M1 · Evidence Ledger

**Schema** — embedded into existing Lesson Schema (`app/lib/lesson-generator.js`):

```jsonc
{
  // existing fields ...
  "evidence_ledger": [
    {
      "claim_ref": "path[2]",                  // pointer to where the claim lives in the lesson body
      "claim_text": "<=120 chars",
      "evidence_type": "primary_source"|"reasoning"|"analogy"|"frontier_judgment"|"original_view"|"spark",
      "evidence_pointer": "<file path | URL | source ID | null>",
      "confidence": "high"|"medium"|"low"|"speculative",
      "verifiability": "high"|"partial"|"low"|"unverifiable",
      "risk": "low"|"medium"|"high"
    }
  ]
}
```

**Generation rule** — Generator MUST produce one ledger row per non-trivial claim. Hard claims (definitions, mechanisms) require `evidence_pointer != null`. Soft claims (analogies, sparks) carry `confidence: speculative` and surface as such in the Course Trust Panel.

**Validation hook** — extend `validatePlan` / `validateBody` in `lesson-generator.js`: if any `evidence_type ∈ {primary_source, reasoning}` row has `evidence_pointer == null`, reject — do not auto-fix. The retry loop sends the validation errors back to the generator (existing pattern).

### M2 · Confession Layer

**IPC**: `lesson:confessionPass` — runs after `lesson:generateBody`, with the same plan + body context. Output:

```jsonc
{
  "confession_id": "uuid",
  "weakest_link": { "ref": "path[i]", "why": "<=200 chars" },
  "unverified_claims": ["claim_ref", ...],
  "speculative_claims": ["claim_ref", ...],
  "ornamentation_flagged": ["ref", ...],     // pretty language masking thin substance
  "tasks_not_finished": ["task description", ...],
  "deepen_recommendation": "if user pushes, expand here first"
}
```

**Default bias to fight**: package as success. **Counter-pressure**: judges Generator more harshly when confession is empty / boilerplate.

**Capability**: T4_JUDGE (per LLM router). Cheap, parallel-friendly.

### M3 · Gap Detector

Pure-JS, no LLM. Computes:
- `apparent_completion`: count of claims marked `passed: true` by Generator
- `verified_completion`: count of claims with `evidence_pointer != null` AND `confidence != speculative` AND `verifiability ∈ {high, partial}`
- `gap_score = (apparent - verified) / apparent`

Surfaced in Course Trust Panel and `_meta`. Does not block ship; visible signal only at v0.2.

### M4 · Prosecutor / Judge / Rewriter loop

Replaces the current single-pass body generation with:

```
generateLessonBody (Generator)         → body draft
  ↓
prosecuteLessonBody (Prosecutor)       → list of charges (skipped hard parts, empty abstractions, missing evidence, analogy-as-mechanism, etc.)
  ↓
judgeLessonProsecution (Judge)         → which charges are legitimate; which are out-of-scope rejections
  ↓
rewriteLessonBody (Rewriter)           → fix only the legitimate charges, leave unchanged elsewhere
```

Each role gets its **own capability + own prompt**. Prosecutor on T4_JUDGE (cheap, focused on attack patterns). Judge on T6_STRONG (judgment quality matters most). Rewriter on T6_STRONG (must preserve unchanged voice).

Single-LLM-self-loop is explicitly forbidden — Prosecutor and Generator MUST land on different providers via `executeChat` (router will weighted-pick — in practice 60% chance same provider; for v0.2 we accept that, v0.5 enforce hard-different via cross-agent baton).

### M5 · Auditable Reasoning Summary

Embedded into the lesson body footer (collapsed by default). Format:

```text
结论: <paragraph>
依据: <bullet list of evidence pointers>
关键推理: A → B → C
不确定性: <items>
反对意见: <Prosecutor's surviving charges that Judge accepted as not-fixable in this pass>
修复建议: <next-lesson seed if user pushes>
```

This is what users see when they click "查看推理" on any conclusion.

---

## Phase 2 (P1) — readable-reasoning layer

Target version: **v0.4 Evidence + Mastery** + **v0.5 Cadence**.

- M6 Reasoning Legibility Score (LLM-judge with structured rubric, T4)
- M7 Limitation-to-Task Converter (regex pre-filter "由于" / "篇幅" / "未来工作" / "this falls outside" → LLM core-relevance check on T3, generate follow-up Micro Proof)
- M8 Bullshit Density Detector (regex pre-filter for abstract-noun stacking + LLM density score on T3)
- M9 No-Uncashed-Abstractions (extend hypha-constitution; partial enforcement already in `app/lib/hypha-constitution.js` voice clamps)
- M10 Reasoning-Action Gap (compare body claims vs Confession output vs final shipped — flag drift)

---

## Phase 3 (P2) — knowledge-immune system

Target version: **v0.5+** when Notes get critical mass.

- M11 Knowledge Contamination Graph: extend `vault/<slug>/lesson-NN.md` frontmatter with `derives_from: [<note_id>, <source_id>]`; on source invalidation, walk the DAG, mark downstream `quarantined: true`, exclude from Living Note Reactivation
- M12 Cross-Agent Baton: enforce hard provider-different across Generator / Prosecutor / Judge via router exclusion list; ships with v0.5 multi-provider audit pipeline
- Mycelium Immune Pets: ship with Companion v0.8 (per existing roadmap §16); each menu item maps to one of the audit roles (Auditor / Skeptic / Evidence / Compression / Mutation / Contamination / Memory / Judge)

---

## Course Trust Panel UI

Layered disclosure (3 levels):

| Level | Visible to user | Source |
|---|---|---|
| Default | "课程可信度: 82/100" + 1-line summary | aggregate of M3 / M5 / M6 |
| 展开 | Evidence list + reasoning summary + uncertainty list | M1 + M5 |
| 专家 | Full Prosecutor charges + Judge rulings + Rewriter diff + Confession + Contamination Graph | M2 + M4 + M11 |

Component file: `app/design/course-trust-panel.jsx` (NEW v0.2). Surfaced from lesson-screen header next to the existing Provider Health badge (Phase E).

---

## Integration with existing systems

| Existing | Integration |
|---|---|
| `app/lib/hypha-constitution.js` (voice clamps + GOAL BINDING + FEYNMAN TEST + FORBIDDEN) | Add §No-Uncashed-Abstractions rule (M9 partial); Confession Layer is NEW system prompt, not constitution amendment |
| `app/lib/lesson-generator.js` (`validatePlan` / `generateLessonBody`) | Extend schema with `evidence_ledger`; tighten validators to reject null evidence on hard claims |
| `app/lib/scoring.js` (Phase D-2 migrated to executeChat) | Stays as-is — local-baseline-overrides-LLM for Micro Proof. Anti-slop layer is upstream of scoring (catches body-level slop, not user-response slop) |
| `app/lib/llm/router.js` (DispatchPolicy + Health) | Cross-Agent Baton uses router's exclusion list; v0.5+ enforces hard-different |
| `vault/<slug>/lesson-NN.md` frontmatter | v0.2 add `evidence_ledger` block; v0.5 add `derives_from` for contamination DAG |

## Out of scope for this spec

- Mycelium pets visual design (Companion v0.8 separate spec at `specs/companion-myco.md`)
- Commons Pack trust scoring (v1.9+ separate concern in `specs/commons.md`)
- BYOK Western reasoning audit (v1.0+ once Western providers integrated)
- Pure-CoT replay / Neuralese-detection (research-grade, not productized)

## Acceptance gates

**v0.2 ship**:
- Every generated Lesson body carries `evidence_ledger` (validator enforces)
- Confession Layer emits non-empty payload on every body (LLM call required)
- Gap Detector outputs `gap_score` to body `_meta`
- Prosecutor → Judge → Rewriter loop runs on every body before ship; observable in `_meta.audit_passes`
- Course Trust Panel default level renders without crashing on real production lesson

**v0.4 ship**:
- Reasoning Legibility Score appears in Course Trust Panel 展开 layer
- Limitation-to-Task Converter generates ≥1 follow-up Micro Proof on bodies containing "篇幅" / "未来工作" trigger phrases (smoke test)
- No-Uncashed-Abstractions: hypha-constitution rule active, voice-clamp validator enforces

**v0.5 ship**:
- Cross-Agent Baton: smoke test confirms Generator and Prosecutor land on different `providerId` in router log
- Knowledge Contamination Graph: source invalidation propagates to ≥1 downstream lesson in vault under test

---

## References

- Source module: `C:\Users\32043\Desktop\HYPHA_AntiSlop_ReadableReasoning_Blueprint.md` (full theory, 1046 lines)
- Main blueprint integration: `HYPHA_final_blueprint_and_evolution_roadmap.md` §24 (new section, AMD-MEOW-P7)
- Related specs: `specs/api-governance.md` (LLM dispatch), `specs/commons.md` (downstream trust), `specs/companion-myco.md` (Mycelium pets v0.8)
- Constitution: `app/lib/hypha-constitution.js`
- Pedagogy spec: `app/lib/pedagogy.md`
